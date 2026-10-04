import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WalletManager } from './core/wallet-manager.js';
import { RPCManager } from './core/rpc-manager.js';
import { ProxyManager } from './core/proxy-manager.js';
import { TxEngine } from './core/tx-engine.js';
import { EVMChain } from './chains/evm.js';
import { SolanaChain } from './chains/solana.js';
import { BTCChain } from './chains/btc.js';
import { TokenSniper } from './sniper/token-sniper.js';
import { NFTSniper } from './sniper/nft-sniper.js';
import { Scheduler } from './sniper/scheduler.js';
import { Dashboard } from './dashboard/server.js';
import { TelegramNotifier } from './telegram/notifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const chainsConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'chains.json'), 'utf8')
);

class SniperXApp {
  constructor() {
    this.walletManager = new WalletManager();
    this.rpcManager = new RPCManager({ alchemyKey: process.env.ALCHEMY_API_KEY });
    this.proxyManager = new ProxyManager({ enabled: process.env.PROXY_ENABLED === 'true' });
    this.txEngine = new TxEngine({
      staggerMin: Number(process.env.STAGGER_MIN_MS) || 50,
      staggerMax: Number(process.env.STAGGER_MAX_MS) || 200,
      gasMultiplier: Number(process.env.DEFAULT_GAS_MULTIPLIER) || 1.3
    });
    this.scheduler = new Scheduler();
    this.telegram = new TelegramNotifier({
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID
    });

    this.evmChains = {};
    this.solanaChain = null;
    this.btcChain = null;
    this.tokenSniper = null;
    this.nftSniper = null;
    this.dashboard = null;
  }

  init() {
    console.log('========================================');
    console.log('  ⚡ SniperX v2 — Multi-Chain Sniper');
    console.log('========================================');

    // Load wallets
    const walletsPath = process.env.WALLETS_PATH;
    if (walletsPath && fs.existsSync(walletsPath)) {
      this.walletManager.loadFromFile(walletsPath);
    } else {
      console.log('[Init] No wallets file found. Configure WALLETS_PATH in .env');
    }

    // Load wallet socials (X/Twitter, Discord mapping)
    const socialsPath = process.env.SOCIALS_PATH || path.join(__dirname, '..', 'config', 'wallet-socials.json');
    this.walletManager.loadSocials(socialsPath);

    const mainKeyPath = process.env.MAIN_WALLET_KEY_PATH;
    if (mainKeyPath && fs.existsSync(mainKeyPath)) {
      this.walletManager.loadMainWallet(mainKeyPath);
    }

    // Load proxies
    const proxyPath = process.env.PROXY_LIST_PATH || './config/proxies.txt';
    this.proxyManager.loadFromFile(proxyPath);

    // Init EVM chains
    for (const [key, config] of Object.entries(chainsConfig.evm)) {
      const envKey = key.toUpperCase() + '_RPC_EXTRA';
      const extraRpcs = (process.env[envKey] || '').split(',').filter(Boolean);
      this.rpcManager.initEVM(key, config, extraRpcs);
      this.evmChains[key] = new EVMChain(this.rpcManager, key, config);
    }

    // Init Solana
    const solRpcs = (process.env.SOLANA_RPC_EXTRA || '').split(',').filter(Boolean);
    this.rpcManager.initSolana(solRpcs);
    this.solanaChain = new SolanaChain(this.rpcManager);

    // Init BTC
    this.btcChain = new BTCChain(chainsConfig.btc.mainnet);

    // Init Snipers
    this.tokenSniper = new TokenSniper(this.evmChains, this.solanaChain, this.txEngine, this.walletManager);
    this.nftSniper = new NFTSniper(this.evmChains, this.txEngine, this.walletManager);

    // Wire up Telegram notifications
    this.tokenSniper.on('auto-buy-complete', (e) => this.telegram.notifySnipe(e));
    this.tokenSniper.on('new-token', (e) => this.telegram.notifyNewToken(e));
    this.nftSniper.on('target-complete', (e) => this.telegram.notifyMint(e));

    // Wire scheduler to snipers
    this.scheduler.on('job-fire', async (job) => {
      try {
        if (job.type === 'token_buy') {
          await this.tokenSniper.manualBuy(job.chain, job.target, job.params.amount, job.params);
        } else if (job.type === 'nft_mint') {
          const target = this.nftSniper.getTargets().find(t => t.id === job.target);
          if (target) await this.nftSniper.executeTarget(target.id);
        }
        job.status = 'completed';
      } catch (err) {
        job.status = 'failed';
        job.error = err.message;
        this.telegram.notifyError(`Scheduled job failed: ${job.label}`, err.message);
      }
    });

    console.log('[Init] All modules loaded');
    return this;
  }

  async startDashboard() {
    this.dashboard = new Dashboard(this, {
      port: Number(process.env.DASHBOARD_PORT) || 3847,
      password: process.env.DASHBOARD_PASSWORD || 'sniperx'
    });
    await this.dashboard.start();
    return this;
  }
}

// Start
const app = new SniperXApp();
app.init();
app.startDashboard().then(() => {
  console.log('[SniperX] Ready! Open dashboard in browser.');
}).catch(err => {
  console.error('[SniperX] Failed to start:', err.message);
  process.exit(1);
});
