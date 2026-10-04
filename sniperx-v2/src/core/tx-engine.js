import { ethers } from 'ethers';
import { EventEmitter } from 'events';

export class TxEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this.staggerMin = config.staggerMin || 50;
    this.staggerMax = config.staggerMax || 200;
    this.gasMultiplier = config.gasMultiplier || 1.3;
    this.maxRetries = config.maxRetries || 2;
    this.running = false;
    this.results = [];
  }

  _randomDelay() {
    return Math.floor(Math.random() * (this.staggerMax - this.staggerMin)) + this.staggerMin;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async executeEVMBatch(signers, txBuilder, options = {}) {
    this.running = true;
    this.results = [];
    const total = signers.length;
    const slippage = options.slippage || 15;

    this.emit('batch-start', { total, chain: options.chain || 'evm' });

    for (let i = 0; i < signers.length; i++) {
      if (!this.running) {
        this.emit('batch-abort', { completed: i, total });
        break;
      }

      const signer = signers[i];
      const walletAddr = await signer.getAddress();
      const result = { index: i, wallet: walletAddr, status: 'pending', hash: null, error: null };

      try {
        const tx = await txBuilder(signer, i, { slippage });
        this.emit('tx-sending', { index: i, wallet: walletAddr });

        const gasEstimate = await signer.provider.estimateGas(tx);
        tx.gasLimit = gasEstimate * BigInt(Math.round(this.gasMultiplier * 100)) / 100n;

        const response = await signer.sendTransaction(tx);
        result.hash = response.hash;
        result.status = 'sent';
        this.emit('tx-sent', { index: i, wallet: walletAddr, hash: response.hash });

        if (options.waitConfirm) {
          const receipt = await response.wait(1);
          result.status = receipt.status === 1 ? 'confirmed' : 'failed';
          result.gasUsed = receipt.gasUsed.toString();
          this.emit('tx-confirmed', { index: i, wallet: walletAddr, hash: response.hash, status: result.status });
        }
      } catch (err) {
        result.status = 'error';
        result.error = err.message?.slice(0, 200);
        this.emit('tx-error', { index: i, wallet: walletAddr, error: result.error });

        if (options.stopOnError) {
          this.running = false;
          break;
        }
      }

      this.results.push(result);

      if (i < signers.length - 1) {
        const delay = this._randomDelay();
        await this._sleep(delay);
      }
    }

    this.running = false;
    const summary = this._buildSummary();
    this.emit('batch-complete', summary);
    return summary;
  }

  async executeSolanaBatch(keypairs, txBuilder, connection, options = {}) {
    this.running = true;
    this.results = [];
    const total = keypairs.length;

    this.emit('batch-start', { total, chain: 'solana' });

    for (let i = 0; i < keypairs.length; i++) {
      if (!this.running) {
        this.emit('batch-abort', { completed: i, total });
        break;
      }

      const kp = keypairs[i];
      const walletAddr = kp.publicKey.toBase58();
      const result = { index: i, wallet: walletAddr, status: 'pending', hash: null, error: null };

      try {
        const tx = await txBuilder(kp, i);
        this.emit('tx-sending', { index: i, wallet: walletAddr });

        const sig = await connection.sendTransaction(tx, [kp], { skipPreflight: true });
        result.hash = sig;
        result.status = 'sent';
        this.emit('tx-sent', { index: i, wallet: walletAddr, hash: sig });

        if (options.waitConfirm) {
          const conf = await connection.confirmTransaction(sig, 'confirmed');
          result.status = conf.value?.err ? 'failed' : 'confirmed';
          this.emit('tx-confirmed', { index: i, wallet: walletAddr, hash: sig, status: result.status });
        }
      } catch (err) {
        result.status = 'error';
        result.error = err.message?.slice(0, 200);
        this.emit('tx-error', { index: i, wallet: walletAddr, error: result.error });

        if (options.stopOnError) {
          this.running = false;
          break;
        }
      }

      this.results.push(result);

      if (i < keypairs.length - 1) {
        await this._sleep(this._randomDelay());
      }
    }

    this.running = false;
    const summary = this._buildSummary();
    this.emit('batch-complete', summary);
    return summary;
  }

  stop() {
    this.running = false;
    this.emit('batch-stopping', {});
  }

  _buildSummary() {
    return {
      total: this.results.length,
      sent: this.results.filter(r => r.status === 'sent').length,
      confirmed: this.results.filter(r => r.status === 'confirmed').length,
      failed: this.results.filter(r => r.status === 'failed').length,
      errors: this.results.filter(r => r.status === 'error').length,
      results: this.results
    };
  }

  getResults() {
    return this._buildSummary();
  }

  updateConfig(config) {
    if (config.staggerMin !== undefined) this.staggerMin = config.staggerMin;
    if (config.staggerMax !== undefined) this.staggerMax = config.staggerMax;
    if (config.gasMultiplier !== undefined) this.gasMultiplier = config.gasMultiplier;
  }
}
