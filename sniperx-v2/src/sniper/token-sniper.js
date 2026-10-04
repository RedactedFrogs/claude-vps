import { EventEmitter } from 'events';

export class TokenSniper extends EventEmitter {
  constructor(evmChains, solanaChain, txEngine, walletManager) {
    super();
    this.evmChains = evmChains;       // { ethereum: EVMChain, base: EVMChain, ... }
    this.solana = solanaChain;
    this.txEngine = txEngine;
    this.walletManager = walletManager;
    this.active = false;
    this.filters = {
      minLiquidity: 0,
      maxLiquidity: Infinity,
      blacklistedTokens: new Set(),
      onlyVerified: false
    };
    this.autoBuy = {
      enabled: false,
      amountPerWallet: '0.001',
      slippage: 15,
      chains: [],
      useAllWallets: false,
      walletCount: 1
    };
    this.detectedTokens = [];
  }

  configure(settings) {
    if (settings.filters) Object.assign(this.filters, settings.filters);
    if (settings.autoBuy) Object.assign(this.autoBuy, settings.autoBuy);
    return this;
  }

  async start() {
    this.active = true;
    console.log('[TokenSniper] Starting monitoring...');

    for (const [chainKey, chain] of Object.entries(this.evmChains)) {
      if (this.autoBuy.chains.length > 0 && !this.autoBuy.chains.includes(chainKey)) continue;

      chain.monitorNewPairs(async (event) => {
        if (!this.active) return;

        console.log(`[TokenSniper] New pair detected on ${chainKey}: ${event.token.symbol || event.token.address}`);
        this.detectedTokens.unshift({
          ...event,
          detectedAt: new Date().toISOString(),
          sniped: false
        });
        if (this.detectedTokens.length > 500) this.detectedTokens.pop();

        this.emit('new-token', event);

        if (this._passesFilters(event) && this.autoBuy.enabled) {
          await this._executeBuy(chainKey, chain, event.token.address);
        }
      });
    }

    if (this.solana && (!this.autoBuy.chains.length || this.autoBuy.chains.includes('solana'))) {
      this.solana.monitorRaydiumPools((event) => {
        if (!this.active) return;
        console.log(`[TokenSniper] Raydium pool detected: ${event.signature}`);
        this.detectedTokens.unshift({
          ...event,
          detectedAt: new Date().toISOString(),
          sniped: false
        });
        this.emit('new-token', event);
      });

      this.solana.monitorPumpFun((event) => {
        if (!this.active) return;
        console.log(`[TokenSniper] Pump.fun launch detected: ${event.signature}`);
        this.detectedTokens.unshift({
          ...event,
          detectedAt: new Date().toISOString(),
          sniped: false
        });
        this.emit('new-token', event);
      });
    }

    this.emit('started', { chains: Object.keys(this.evmChains) });
  }

  stop() {
    this.active = false;
    for (const chain of Object.values(this.evmChains)) {
      chain.stopMonitoring();
    }
    if (this.solana) this.solana.stopMonitoring();
    this.emit('stopped', {});
    console.log('[TokenSniper] Stopped');
  }

  async manualBuy(chainKey, tokenAddress, amountPerWallet, options = {}) {
    const chain = this.evmChains[chainKey];
    if (!chain) throw new Error(`Chain not found: ${chainKey}`);

    const provider = chain.getProvider();
    const wallets = options.walletIndices
      ? this.walletManager.getEVMSigners(provider, options.walletIndices)
      : this.walletManager.getEVMSigners(provider).slice(0, options.walletCount || this.autoBuy.walletCount);

    console.log(`[TokenSniper] Manual buy: ${tokenAddress} on ${chainKey} with ${wallets.length} wallets @ ${amountPerWallet} ${chain.config.symbol} each`);

    const txBuilder = chain.buildBuyTx(tokenAddress, amountPerWallet, options.slippage || this.autoBuy.slippage);
    return this.txEngine.executeEVMBatch(wallets, txBuilder, {
      chain: chainKey,
      slippage: options.slippage || this.autoBuy.slippage,
      waitConfirm: options.waitConfirm !== false
    });
  }

  async manualSell(chainKey, tokenAddress, percentage = 100, options = {}) {
    const chain = this.evmChains[chainKey];
    if (!chain) throw new Error(`Chain not found: ${chainKey}`);

    const provider = chain.getProvider();
    const wallets = options.walletIndices
      ? this.walletManager.getEVMSigners(provider, options.walletIndices)
      : this.walletManager.getEVMSigners(provider);

    console.log(`[TokenSniper] Sell ${percentage}% of ${tokenAddress} on ${chainKey} with ${wallets.length} wallets`);

    const txBuilder = chain.buildSellTx(tokenAddress, percentage, options.slippage || this.autoBuy.slippage);
    return this.txEngine.executeEVMBatch(wallets, txBuilder, {
      chain: chainKey,
      waitConfirm: true
    });
  }

  _passesFilters(event) {
    if (this.filters.blacklistedTokens.has(event.token?.address?.toLowerCase())) return false;
    return true;
  }

  async _executeBuy(chainKey, chain, tokenAddress) {
    try {
      const provider = chain.getProvider();
      const count = this.autoBuy.useAllWallets
        ? this.walletManager.getEnabledEVM().length
        : this.autoBuy.walletCount;
      const wallets = this.walletManager.getEVMSigners(provider).slice(0, count);

      this.emit('auto-buy-start', { chain: chainKey, token: tokenAddress, wallets: wallets.length });

      const txBuilder = chain.buildBuyTx(tokenAddress, this.autoBuy.amountPerWallet, this.autoBuy.slippage);
      const result = await this.txEngine.executeEVMBatch(wallets, txBuilder, {
        chain: chainKey,
        slippage: this.autoBuy.slippage,
        waitConfirm: true
      });

      this.emit('auto-buy-complete', { chain: chainKey, token: tokenAddress, result });
      return result;
    } catch (err) {
      this.emit('auto-buy-error', { chain: chainKey, token: tokenAddress, error: err.message });
    }
  }

  getDetectedTokens(limit = 50) {
    return this.detectedTokens.slice(0, limit);
  }

  getConfig() {
    return { filters: this.filters, autoBuy: { ...this.autoBuy }, active: this.active };
  }
}
