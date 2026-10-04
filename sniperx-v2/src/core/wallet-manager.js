import fs from 'fs';
import { ethers } from 'ethers';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export class WalletManager {
  constructor() {
    this.evmWallets = [];
    this.solanaWallets = [];
    this.mainWallet = null;
  }

  loadFromFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);

    if (Array.isArray(data)) {
      for (const entry of data) {
        if (entry.privateKey || entry.private_key) {
          const pk = entry.privateKey || entry.private_key;
          try {
            const wallet = new ethers.Wallet(pk);
            this.evmWallets.push({
              address: wallet.address,
              privateKey: pk,
              label: entry.label || entry.name || wallet.address.slice(0, 8),
              enabled: true
            });
          } catch {
            // might be solana
            try {
              const kp = Keypair.fromSecretKey(bs58.decode(pk));
              this.solanaWallets.push({
                address: kp.publicKey.toBase58(),
                secretKey: pk,
                label: entry.label || entry.name || kp.publicKey.toBase58().slice(0, 8),
                enabled: true
              });
            } catch { /* skip invalid */ }
          }
        }
      }
    }

    console.log(`[WalletManager] Loaded ${this.evmWallets.length} EVM + ${this.solanaWallets.length} Solana wallets`);
    return this;
  }

  loadMainWallet(keyPath) {
    const pk = fs.readFileSync(keyPath, 'utf8').trim();
    const wallet = new ethers.Wallet(pk);
    this.mainWallet = { address: wallet.address, privateKey: pk };
    console.log(`[WalletManager] Main wallet: ${wallet.address}`);
    return this;
  }

  getEVMSigners(provider, indices) {
    const selected = indices
      ? this.evmWallets.filter((_, i) => indices.includes(i))
      : this.evmWallets.filter(w => w.enabled);
    return selected.map(w => new ethers.Wallet(w.privateKey, provider));
  }

  getEnabledEVM() {
    return this.evmWallets.filter(w => w.enabled);
  }

  getEnabledSolana() {
    return this.solanaWallets.filter(w => w.enabled);
  }

  toggleWallet(index, type = 'evm') {
    const list = type === 'evm' ? this.evmWallets : this.solanaWallets;
    if (list[index]) {
      list[index].enabled = !list[index].enabled;
      return list[index];
    }
    return null;
  }

  enableAll(type = 'evm') {
    const list = type === 'evm' ? this.evmWallets : this.solanaWallets;
    list.forEach(w => w.enabled = true);
  }

  disableAll(type = 'evm') {
    const list = type === 'evm' ? this.evmWallets : this.solanaWallets;
    list.forEach(w => w.enabled = false);
  }

  enableRange(start, end, type = 'evm') {
    const list = type === 'evm' ? this.evmWallets : this.solanaWallets;
    for (let i = start; i <= Math.min(end, list.length - 1); i++) {
      list[i].enabled = true;
    }
  }

  getSummary() {
    return {
      evm: {
        total: this.evmWallets.length,
        enabled: this.evmWallets.filter(w => w.enabled).length,
        wallets: this.evmWallets.map((w, i) => ({
          index: i,
          address: w.address,
          label: w.label,
          enabled: w.enabled
        }))
      },
      solana: {
        total: this.solanaWallets.length,
        enabled: this.solanaWallets.filter(w => w.enabled).length,
        wallets: this.solanaWallets.map((w, i) => ({
          index: i,
          address: w.address,
          label: w.label,
          enabled: w.enabled
        }))
      },
      mainWallet: this.mainWallet ? this.mainWallet.address : null
    };
  }
}
