import fs from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export class ProxyManager {
  constructor(config = {}) {
    this.enabled = config.enabled || false;
    this.proxies = [];
    this.roundRobin = 0;
  }

  loadFromFile(filePath) {
    if (!fs.existsSync(filePath)) {
      console.log('[ProxyManager] No proxy file found, running without proxies');
      return this;
    }

    const lines = fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));

    for (const line of lines) {
      try {
        const proxy = this._parseProxy(line);
        this.proxies.push(proxy);
      } catch {
        console.warn(`[ProxyManager] Invalid proxy line: ${line}`);
      }
    }

    console.log(`[ProxyManager] Loaded ${this.proxies.length} proxies (${this.enabled ? 'ENABLED' : 'DISABLED'})`);
    return this;
  }

  _parseProxy(line) {
    const url = new URL(line);
    const type = url.protocol.replace(':', '');

    let agent;
    if (type === 'socks5' || type === 'socks4') {
      agent = new SocksProxyAgent(line);
    } else {
      agent = new HttpsProxyAgent(line);
    }

    return {
      url: line,
      type,
      host: url.hostname,
      port: url.port,
      agent,
      failures: 0,
      lastUsed: 0
    };
  }

  addProxy(proxyUrl) {
    const proxy = this._parseProxy(proxyUrl);
    this.proxies.push(proxy);
    return proxy;
  }

  removeProxy(index) {
    if (this.proxies[index]) {
      this.proxies.splice(index, 1);
      return true;
    }
    return false;
  }

  getAgent() {
    if (!this.enabled || this.proxies.length === 0) return null;

    const available = this.proxies.filter(p => p.failures < 5);
    if (available.length === 0) {
      this.proxies.forEach(p => p.failures = 0);
      return this.proxies[0].agent;
    }

    const idx = this.roundRobin % available.length;
    this.roundRobin++;
    available[idx].lastUsed = Date.now();
    return available[idx].agent;
  }

  getAgentForWallet(walletIndex) {
    if (!this.enabled || this.proxies.length === 0) return null;
    const idx = walletIndex % this.proxies.length;
    this.proxies[idx].lastUsed = Date.now();
    return this.proxies[idx].agent;
  }

  toggle(state) {
    this.enabled = state !== undefined ? state : !this.enabled;
    return this.enabled;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      total: this.proxies.length,
      proxies: this.proxies.map((p, i) => ({
        index: i,
        host: p.host,
        port: p.port,
        type: p.type,
        failures: p.failures,
        lastUsed: p.lastUsed ? new Date(p.lastUsed).toISOString() : 'never'
      }))
    };
  }
}
