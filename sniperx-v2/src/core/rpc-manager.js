import { ethers } from 'ethers';
import { Connection } from '@solana/web3.js';

export class RPCManager {
  constructor(config = {}) {
    this.alchemyKey = config.alchemyKey || '';
    this.providers = {};
    this.solanaConnections = [];
    this.roundRobin = {};
  }

  initEVM(chainKey, chainConfig, extraRpcs = []) {
    const rpcs = [];

    if (this.alchemyKey && chainConfig.alchemy) {
      rpcs.push({
        url: chainConfig.alchemy + this.alchemyKey,
        name: 'alchemy',
        priority: 1
      });
    }

    if (chainConfig.rpc) {
      rpcs.push({ url: chainConfig.rpc, name: new URL(chainConfig.rpc).hostname, priority: 1 });
    }

    for (const url of extraRpcs) {
      if (url.trim()) {
        rpcs.push({ url: url.trim(), name: new URL(url.trim()).hostname, priority: 2 });
      }
    }

    this.providers[chainKey] = rpcs.map(r => ({
      ...r,
      provider: new ethers.JsonRpcProvider(r.url, chainConfig.chainId, { staticNetwork: true }),
      failures: 0,
      lastUsed: 0
    }));
    this.roundRobin[chainKey] = 0;

    console.log(`[RPCManager] ${chainKey}: ${rpcs.length} RPC endpoints loaded`);
    return this;
  }

  initSolana(extraRpcs = []) {
    const rpcs = [];

    if (this.alchemyKey) {
      rpcs.push(`https://solana-mainnet.g.alchemy.com/v2/${this.alchemyKey}`);
    }

    rpcs.push(...extraRpcs.filter(u => u.trim()));
    if (rpcs.length === 0) rpcs.push('https://api.mainnet-beta.solana.com');

    this.solanaConnections = rpcs.map((url, i) => ({
      url,
      name: new URL(url).hostname,
      connection: new Connection(url, 'confirmed'),
      failures: 0,
      lastUsed: 0,
      index: i
    }));
    this.roundRobin.solana = 0;

    console.log(`[RPCManager] Solana: ${rpcs.length} RPC endpoints loaded`);
    return this;
  }

  getEVMProvider(chainKey) {
    const rpcs = this.providers[chainKey];
    if (!rpcs || rpcs.length === 0) throw new Error(`No RPC for chain: ${chainKey}`);

    const available = rpcs.filter(r => r.failures < 5);
    if (available.length === 0) {
      rpcs.forEach(r => r.failures = 0);
      return rpcs[0].provider;
    }

    const idx = this.roundRobin[chainKey] % available.length;
    this.roundRobin[chainKey]++;
    available[idx].lastUsed = Date.now();
    return available[idx].provider;
  }

  getEVMProviderByName(chainKey, name) {
    const rpc = this.providers[chainKey]?.find(r => r.name === name);
    return rpc ? rpc.provider : this.getEVMProvider(chainKey);
  }

  getAllEVMProviders(chainKey) {
    return (this.providers[chainKey] || []).map(r => r.provider);
  }

  getSolanaConnection() {
    if (this.solanaConnections.length === 0) throw new Error('No Solana RPC');

    const available = this.solanaConnections.filter(r => r.failures < 5);
    if (available.length === 0) {
      this.solanaConnections.forEach(r => r.failures = 0);
      return this.solanaConnections[0].connection;
    }

    const idx = this.roundRobin.solana % available.length;
    this.roundRobin.solana++;
    available[idx].lastUsed = Date.now();
    return available[idx].connection;
  }

  reportFailure(chainKey, providerOrUrl) {
    const rpcs = chainKey === 'solana' ? this.solanaConnections : this.providers[chainKey];
    if (!rpcs) return;
    const entry = rpcs.find(r =>
      r.provider === providerOrUrl || r.connection === providerOrUrl || r.url === providerOrUrl
    );
    if (entry) entry.failures++;
  }

  getStatus() {
    const status = {};
    for (const [chain, rpcs] of Object.entries(this.providers)) {
      status[chain] = rpcs.map(r => ({
        name: r.name,
        failures: r.failures,
        lastUsed: r.lastUsed ? new Date(r.lastUsed).toISOString() : 'never'
      }));
    }
    if (this.solanaConnections.length > 0) {
      status.solana = this.solanaConnections.map(r => ({
        name: r.name,
        failures: r.failures,
        lastUsed: r.lastUsed ? new Date(r.lastUsed).toISOString() : 'never'
      }));
    }
    return status;
  }
}
