export class BTCChain {
  constructor(config = {}) {
    this.network = config.network || 'mainnet';
    this.explorer = config.explorer || 'https://mempool.space';
    this.apiBase = 'https://mempool.space/api';
  }

  async getBalance(address) {
    const resp = await fetch(`${this.apiBase}/address/${address}`);
    const data = await resp.json();
    const confirmed = data.chain_stats?.funded_txo_sum - data.chain_stats?.spent_txo_sum || 0;
    const unconfirmed = data.mempool_stats?.funded_txo_sum - data.mempool_stats?.spent_txo_sum || 0;
    return {
      confirmed: confirmed / 1e8,
      unconfirmed: unconfirmed / 1e8,
      total: (confirmed + unconfirmed) / 1e8
    };
  }

  async getFeeEstimate() {
    const resp = await fetch(`${this.apiBase}/v1/fees/recommended`);
    return resp.json();
  }

  async getUTXOs(address) {
    const resp = await fetch(`${this.apiBase}/address/${address}/utxo`);
    return resp.json();
  }

  // Runes & Ordinals minting requires ord/runes-specific tooling
  // This is a placeholder for the BTC mint integration
  async buildRunesMintTx(runeId, walletInfo) {
    console.log(`[BTC] Runes mint for ${runeId} — requires ord wallet integration`);
    return {
      status: 'not_implemented',
      message: 'BTC Runes/Ordinals minting requires ord CLI integration. Configure ord wallet path in settings.'
    };
  }

  async buildOrdinalsMintTx(inscriptionData, walletInfo) {
    console.log('[BTC] Ordinals inscription — requires ord wallet integration');
    return {
      status: 'not_implemented',
      message: 'Ordinals inscription requires ord CLI. Configure ord wallet path in settings.'
    };
  }

  getExplorerUrl(txid) {
    return `${this.explorer}/tx/${txid}`;
  }
}
