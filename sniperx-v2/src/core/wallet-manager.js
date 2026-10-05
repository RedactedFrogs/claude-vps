import fs from 'fs';
import { ethers } from 'ethers';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export class WalletManager {
  constructor() {
    this.evmWallets = [];
    this.solanaWallets = [];
    this.mainWallet = null;
    this.validatorWallet = null;
    this.phantomWallet = null;
    this.socialsPath = null;
    this.socials = {};
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
              enabled: true,
              x: entry.x || entry.twitter || '',
              discord: entry.discord || ''
            });
          } catch {
            // might be solana
            try {
              const kp = Keypair.fromSecretKey(bs58.decode(pk));
              this.solanaWallets.push({
                address: kp.publicKey.toBase58(),
                secretKey: pk,
                label: entry.label || entry.name || kp.publicKey.toBase58().slice(0, 8),
                enabled: true,
                x: entry.x || entry.twitter || '',
                discord: entry.discord || ''
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

  loadValidatorWallet(keyPath) {
    try {
      const raw = fs.readFileSync(keyPath, 'utf8').trim();
      const lines = raw.split(/\s+/);
      if (lines.length >= 12) {
        console.log(`[WalletManager] Validator seed loaded (mnemonic ${lines.length} words)`);
        this.validatorWallet = { type: 'mnemonic', mnemonic: raw, address: null };
        try {
          const hdWallet = ethers.Wallet.fromPhrase(raw);
          this.validatorWallet.address = hdWallet.address;
          this.validatorWallet.privateKey = hdWallet.privateKey;
          console.log(`[WalletManager] Validator wallet: ${hdWallet.address}`);
        } catch { /* mnemonic format not standard BIP39 */ }
      } else {
        const wallet = new ethers.Wallet(raw);
        this.validatorWallet = { address: wallet.address, privateKey: raw };
        console.log(`[WalletManager] Validator wallet: ${wallet.address}`);
      }
    } catch (err) {
      console.log(`[WalletManager] Failed to load validator wallet: ${err.message}`);
    }
    return this;
  }

  loadPhantomWallet(seedPath) {
    try {
      const raw = fs.readFileSync(seedPath, 'utf8').trim();
      const lines = raw.split(/\s+/);
      if (lines.length >= 12) {
        this.phantomWallet = { type: 'mnemonic', mnemonic: raw, address: '(seed loaded)' };
        console.log(`[WalletManager] Phantom seed loaded (mnemonic ${lines.length} words)`);
      } else {
        try {
          const kp = Keypair.fromSecretKey(bs58.decode(raw));
          this.phantomWallet = { type: 'keypair', address: kp.publicKey.toBase58(), secretKey: raw };
          console.log(`[WalletManager] Phantom wallet: ${kp.publicKey.toBase58()}`);
        } catch {
          try {
            const arr = JSON.parse(raw);
            const kp = Keypair.fromSecretKey(new Uint8Array(arr));
            this.phantomWallet = { type: 'keypair', address: kp.publicKey.toBase58(), secretKey: bs58.encode(kp.secretKey) };
            console.log(`[WalletManager] Phantom wallet: ${kp.publicKey.toBase58()}`);
          } catch {
            this.phantomWallet = { type: 'raw', address: '(loaded)' };
            console.log('[WalletManager] Phantom seed loaded (unknown format)');
          }
        }
      }
    } catch (err) {
      console.log(`[WalletManager] Failed to load phantom wallet: ${err.message}`);
    }
    return this;
  }

  getNamedSigner(provider, name) {
    if (name === 'main' && this.mainWallet?.privateKey) {
      return new ethers.Wallet(this.mainWallet.privateKey, provider);
    }
    if (name === 'validator' && this.validatorWallet?.privateKey) {
      return new ethers.Wallet(this.validatorWallet.privateKey, provider);
    }
    return null;
  }

  getSignersForMint(provider, walletSource, botCount = 1) {
    if (walletSource === 'main') {
      const s = this.getNamedSigner(provider, 'main');
      return s ? [s] : [];
    }
    if (walletSource === 'validator') {
      const s = this.getNamedSigner(provider, 'validator');
      return s ? [s] : [];
    }
    if (walletSource === 'bot') {
      return this.getEVMSigners(provider).slice(0, botCount);
    }
    if (walletSource === 'all') {
      const signers = [];
      const main = this.getNamedSigner(provider, 'main');
      if (main) signers.push(main);
      const val = this.getNamedSigner(provider, 'validator');
      if (val) signers.push(val);
      signers.push(...this.getEVMSigners(provider));
      return signers;
    }
    return this.getEVMSigners(provider).slice(0, botCount);
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

  // === Social Accounts (X/Twitter, Discord) ===

  loadSocials(filePath) {
    this.socialsPath = filePath;
    if (fs.existsSync(filePath)) {
      this.socials = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      // Apply saved socials to loaded wallets
      for (const w of [...this.evmWallets, ...this.solanaWallets]) {
        const saved = this.socials[w.address.toLowerCase()];
        if (saved) {
          w.x = saved.x || w.x || '';
          w.discord = saved.discord || w.discord || '';
        }
      }
      const count = Object.keys(this.socials).length;
      console.log(`[WalletManager] Loaded socials for ${count} wallets`);
    }
    return this;
  }

  saveSocials() {
    if (!this.socialsPath) return;
    for (const w of [...this.evmWallets, ...this.solanaWallets]) {
      if (w.x || w.discord) {
        this.socials[w.address.toLowerCase()] = { x: w.x, discord: w.discord };
      }
    }
    fs.writeFileSync(this.socialsPath, JSON.stringify(this.socials, null, 2));
  }

  setSocial(index, type, field, value) {
    const list = type === 'evm' ? this.evmWallets : this.solanaWallets;
    if (!list[index]) return null;
    list[index][field] = value;
    this.saveSocials();
    return list[index];
  }

  bulkSetX(type, xHandles) {
    const list = type === 'evm' ? this.evmWallets : this.solanaWallets;
    const handles = Array.isArray(xHandles) ? xHandles : xHandles.split('\n').map(h => h.trim()).filter(Boolean);
    let assigned = 0;
    for (let i = 0; i < Math.min(handles.length, list.length); i++) {
      let handle = handles[i].trim();
      if (handle && !handle.startsWith('@')) handle = '@' + handle;
      list[i].x = handle;
      assigned++;
    }
    this.saveSocials();
    console.log(`[WalletManager] Bulk assigned ${assigned} X handles`);
    return assigned;
  }

  bulkSetDiscord(type, discordNames) {
    const list = type === 'evm' ? this.evmWallets : this.solanaWallets;
    const names = Array.isArray(discordNames) ? discordNames : discordNames.split('\n').map(h => h.trim()).filter(Boolean);
    let assigned = 0;
    for (let i = 0; i < Math.min(names.length, list.length); i++) {
      list[i].discord = names[i].trim();
      assigned++;
    }
    this.saveSocials();
    return assigned;
  }

  getWalletWithSocials(index, type = 'evm') {
    const list = type === 'evm' ? this.evmWallets : this.solanaWallets;
    if (!list[index]) return null;
    const w = list[index];
    return { index, address: w.address, label: w.label, x: w.x, discord: w.discord, enabled: w.enabled };
  }

  exportForWL(type = 'evm') {
    const list = type === 'evm' ? this.evmWallets : this.solanaWallets;
    return list.filter(w => w.enabled).map((w, i) => ({
      index: i,
      address: w.address,
      x: w.x || '',
      discord: w.discord || ''
    }));
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
          enabled: w.enabled,
          x: w.x || '',
          discord: w.discord || ''
        }))
      },
      solana: {
        total: this.solanaWallets.length,
        enabled: this.solanaWallets.filter(w => w.enabled).length,
        wallets: this.solanaWallets.map((w, i) => ({
          index: i,
          address: w.address,
          label: w.label,
          enabled: w.enabled,
          x: w.x || '',
          discord: w.discord || ''
        }))
      },
      mainWallet: this.mainWallet ? this.mainWallet.address : null,
      validatorWallet: this.validatorWallet ? this.validatorWallet.address : null,
      phantomWallet: this.phantomWallet ? this.phantomWallet.address : null
    };
  }
}
