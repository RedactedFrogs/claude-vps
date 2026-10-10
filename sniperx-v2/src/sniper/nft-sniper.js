import { ethers } from 'ethers';
import { EventEmitter } from 'events';

export class NFTSniper extends EventEmitter {
  constructor(evmChains, txEngine, walletManager) {
    super();
    this.evmChains = evmChains;
    this.txEngine = txEngine;
    this.walletManager = walletManager;
    this.targets = [];
    this.history = [];
  }

  addTarget(target) {
    const label = target.contractAddress
      ? target.contractAddress.slice(0, 10)
      : target.mintUrl
        ? new URL(target.mintUrl).hostname
        : 'NFT Target';
    const entry = {
      id: Date.now().toString(36),
      chain: target.chain || 'ethereum',
      contractAddress: target.contractAddress || '',
      mintUrl: target.mintUrl || '',
      mintFunction: target.mintFunction || 'function mint(uint256 quantity) payable',
      mintArgs: target.mintArgs || [1],
      price: target.price || '0',
      maxPerWallet: target.maxPerWallet || 1,
      walletSource: target.walletSource || 'bot',
      walletCount: target.walletCount || 1,
      useAllWallets: target.useAllWallets || false,
      walletIndices: target.walletIndices || null,
      scheduledTime: target.scheduledTime || null,
      slippage: target.slippage || 15,
      gasMultiplier: target.gasMultiplier || 1.5,
      status: 'pending',
      label,
      createdAt: new Date().toISOString()
    };
    this.targets.push(entry);
    this.emit('target-added', entry);
    console.log(`[NFTSniper] Target added: ${entry.label} on ${entry.chain}`);
    return entry;
  }

  removeTarget(id) {
    const idx = this.targets.findIndex(t => t.id === id);
    if (idx === -1) return false;
    const removed = this.targets.splice(idx, 1)[0];
    this.emit('target-removed', removed);
    return true;
  }

  async executeTarget(id) {
    const target = this.targets.find(t => t.id === id);
    if (!target) throw new Error(`Target not found: ${id}`);

    const chain = this.evmChains[target.chain];
    if (!chain) throw new Error(`Chain not found: ${target.chain}`);

    target.status = 'executing';
    this.emit('target-executing', target);

    try {
      const provider = chain.getProvider();
      let wallets;
      if (target.walletSource === 'bot' && target.walletIndices?.length > 0) {
        wallets = this.walletManager.getEVMSigners(provider, target.walletIndices);
      } else {
        wallets = this.walletManager.getSignersForMint(
          provider,
          target.walletSource || 'bot',
          target.walletCount || 1
        );
      }

      if (wallets.length === 0) throw new Error('No wallet available for mint');

      console.log(`[NFTSniper] Executing mint: ${target.label} with ${wallets.length} wallet(s) [${target.walletSource}]`);
      console.log(`[NFTSniper] Contract: ${target.contractAddress} | Chain: ${target.chain} | Price: ${target.price} ETH`);
      console.log(`[NFTSniper] ABI: ${target.mintFunction} | Args: ${JSON.stringify(target.mintArgs)}`);

      this.txEngine.updateConfig({ gasMultiplier: target.gasMultiplier });

      const txBuilder = chain.buildMintTx(
        target.contractAddress,
        target.mintFunction,
        target.mintArgs,
        target.price
      );

      const result = await this.txEngine.executeEVMBatch(wallets, txBuilder, {
        chain: target.chain,
        waitConfirm: true
      });

      target.status = result.errors > 0 ? 'partial' : 'completed';
      target.result = result;

      if (result.errors > 0) {
        const errMsgs = result.results.filter(r => r.error).map(r => r.error);
        console.log(`[NFTSniper] Mint errors (${result.errors}/${result.total}):`);
        errMsgs.forEach(e => console.log(`  - ${e}`));
        target.errorDetail = errMsgs[0] || 'Unknown error';
      } else {
        console.log(`[NFTSniper] Mint success: ${result.confirmed} confirmed`);
      }

      this.history.push({ ...target, executedAt: new Date().toISOString() });
      this.emit('target-complete', { target, result });
      return result;
    } catch (err) {
      target.status = 'failed';
      target.error = err.message;
      this.emit('target-error', { target, error: err.message });
      throw err;
    }
  }

  async scheduleTarget(id) {
    const target = this.targets.find(t => t.id === id);
    if (!target || !target.scheduledTime) throw new Error('No schedule time set');

    const now = Date.now();
    const launchTime = new Date(target.scheduledTime).getTime();
    const delay = launchTime - now;

    if (delay <= 0) {
      return this.executeTarget(id);
    }

    target.status = 'scheduled';
    this.emit('target-scheduled', { target, launchIn: delay });
    console.log(`[NFTSniper] ${target.label} scheduled in ${Math.round(delay / 1000)}s`);

    // Pre-warm 5 seconds before
    const warmDelay = Math.max(0, delay - 5000);
    setTimeout(() => {
      if (target.status !== 'scheduled') return;
      console.log(`[NFTSniper] Pre-warming for ${target.label}...`);
      this.emit('target-warming', target);
    }, warmDelay);

    setTimeout(() => {
      if (target.status !== 'scheduled') return;
      this.executeTarget(id).catch(err => {
        console.error(`[NFTSniper] Scheduled execution failed: ${err.message}`);
      });
    }, delay);
  }

  getTargets() {
    return this.targets;
  }

  getHistory(limit = 50) {
    return this.history.slice(-limit);
  }

  getTarget(id) {
    return this.targets.find(t => t.id === id);
  }
}
