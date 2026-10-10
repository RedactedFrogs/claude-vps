import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Dashboard {
  constructor(app, config = {}) {
    this.app = app;
    this.port = config.port || 3847;
    this.password = config.password || 'sniperx';
    this.express = express();
    this.server = createServer(this.express);
    this.io = new SocketIO(this.server);
    this.authenticated = new Set();

    this._setupMiddleware();
    this._setupRoutes();
    this._setupSocket();
  }

  _setupMiddleware() {
    this.express.use(express.json());
    this.express.use(express.static(path.join(__dirname, 'public')));
  }

  _setupRoutes() {
    this.express.post('/api/auth', (req, res) => {
      if (req.body.password === this.password) {
        const token = Date.now().toString(36) + Math.random().toString(36).slice(2);
        this.authenticated.add(token);
        res.json({ ok: true, token });
      } else {
        res.status(401).json({ ok: false, error: 'Wrong password' });
      }
    });

    const auth = (req, res, next) => {
      const token = req.headers['x-token'] || req.query.token;
      if (!this.authenticated.has(token)) return res.status(401).json({ error: 'Unauthorized' });
      next();
    };

    // Wallet endpoints
    this.express.get('/api/wallets', auth, (req, res) => {
      res.json(this.app.walletManager.getSummary());
    });

    this.express.post('/api/wallets/toggle', auth, (req, res) => {
      const { index, type } = req.body;
      const result = this.app.walletManager.toggleWallet(index, type);
      res.json({ ok: !!result, wallet: result });
    });

    this.express.post('/api/wallets/enable-all', auth, (req, res) => {
      this.app.walletManager.enableAll(req.body.type);
      res.json({ ok: true });
    });

    this.express.post('/api/wallets/disable-all', auth, (req, res) => {
      this.app.walletManager.disableAll(req.body.type);
      res.json({ ok: true });
    });

    this.express.post('/api/wallets/enable-range', auth, (req, res) => {
      const { start, end, type } = req.body;
      this.app.walletManager.enableRange(start, end, type);
      res.json({ ok: true });
    });

    // Wallet socials (X/Twitter, Discord)
    this.express.post('/api/wallets/set-social', auth, (req, res) => {
      const { index, type, field, value } = req.body;
      const result = this.app.walletManager.setSocial(index, type || 'evm', field, value);
      res.json({ ok: !!result, wallet: result });
    });

    this.express.post('/api/wallets/bulk-x', auth, (req, res) => {
      const { type, handles } = req.body;
      const count = this.app.walletManager.bulkSetX(type || 'evm', handles);
      res.json({ ok: true, assigned: count });
    });

    this.express.post('/api/wallets/bulk-discord', auth, (req, res) => {
      const { type, names } = req.body;
      const count = this.app.walletManager.bulkSetDiscord(type || 'evm', names);
      res.json({ ok: true, assigned: count });
    });

    this.express.get('/api/wallets/export-wl', auth, (req, res) => {
      const data = this.app.walletManager.exportForWL(req.query.type || 'evm');
      res.json(data);
    });

    // RPC endpoints
    this.express.get('/api/rpc/status', auth, (req, res) => {
      res.json(this.app.rpcManager.getStatus());
    });

    // Proxy endpoints
    this.express.get('/api/proxy/status', auth, (req, res) => {
      res.json(this.app.proxyManager.getStatus());
    });

    this.express.post('/api/proxy/toggle', auth, (req, res) => {
      const state = this.app.proxyManager.toggle(req.body.enabled);
      res.json({ ok: true, enabled: state });
    });

    this.express.post('/api/proxy/add', auth, (req, res) => {
      try {
        const proxy = this.app.proxyManager.addProxy(req.body.url);
        res.json({ ok: true, proxy });
      } catch (err) {
        res.status(400).json({ ok: false, error: err.message });
      }
    });

    // Auto-detect chain from contract address
    this.express.get('/api/chain/detect/:address', auth, async (req, res) => {
      const address = req.params.address;
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return res.status(400).json({ error: 'Invalid address' });
      }
      try {
        const checks = Object.keys(this.app.evmChains).map(async (chain) => {
          try {
            const provider = this.app.rpcManager.getEVMProvider(chain);
            const code = await Promise.race([
              provider.getCode(address),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
            ]);
            return { chain, hasCode: code && code !== '0x' && code !== '0x0' };
          } catch { return { chain, hasCode: false }; }
        });
        const results = await Promise.all(checks);
        const found = results.filter(r => r.hasCode).map(r => r.chain);
        res.json({ chains: found, primary: found[0] || null });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Gas price endpoint
    this.express.get('/api/gas/:chain', auth, async (req, res) => {
      try {
        const chain = req.params.chain;
        const provider = this.app.rpcManager.getEVMProvider(chain);
        if (!provider) return res.status(400).json({ error: 'Unknown chain' });
        const feeData = await provider.getFeeData();
        const gasPrice = Number(feeData.gasPrice || 0n) / 1e9;
        res.json({
          chain,
          gasPrice: Math.round(gasPrice * 100) / 100,
          slow: Math.round(gasPrice * 0.85 * 100) / 100,
          normal: Math.round(gasPrice * 100) / 100,
          fast: Math.round(gasPrice * 1.5 * 100) / 100,
          unit: 'gwei'
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Token Sniper endpoints
    this.express.get('/api/sniper/token/config', auth, (req, res) => {
      res.json(this.app.tokenSniper.getConfig());
    });

    this.express.post('/api/sniper/token/configure', auth, (req, res) => {
      this.app.tokenSniper.configure(req.body);
      res.json({ ok: true, config: this.app.tokenSniper.getConfig() });
    });

    this.express.post('/api/sniper/token/start', auth, (req, res) => {
      this.app.tokenSniper.start();
      res.json({ ok: true, status: 'monitoring' });
    });

    this.express.post('/api/sniper/token/stop', auth, (req, res) => {
      this.app.tokenSniper.stop();
      res.json({ ok: true, status: 'stopped' });
    });

    this.express.get('/api/sniper/token/detected', auth, (req, res) => {
      res.json(this.app.tokenSniper.getDetectedTokens(Number(req.query.limit) || 50));
    });

    this.express.post('/api/sniper/token/buy', auth, (req, res) => {
      const { chain, token, amount, slippage, walletCount, walletIndices } = req.body;
      this.app.tokenSniper.manualBuy(chain, token, amount, { slippage, walletCount, walletIndices })
        .then(result => res.json({ ok: true, result }))
        .catch(err => res.status(500).json({ ok: false, error: err.message }));
    });

    this.express.post('/api/sniper/token/sell', auth, (req, res) => {
      const { chain, token, percentage, slippage, walletIndices } = req.body;
      this.app.tokenSniper.manualSell(chain, token, percentage, { slippage, walletIndices })
        .then(result => res.json({ ok: true, result }))
        .catch(err => res.status(500).json({ ok: false, error: err.message }));
    });

    // SeaDrop query endpoint
    this.express.get('/api/seadrop/info/:chain/:nftContract', auth, async (req, res) => {
      try {
        const chain = this.app.evmChains[req.params.chain];
        if (!chain) return res.status(400).json({ error: 'Unknown chain' });
        if (!chain.querySeaDropInfo) return res.status(400).json({ error: 'Chain does not support SeaDrop' });
        const info = await chain.querySeaDropInfo(req.params.nftContract, req.query.seadrop);
        res.json(info);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // NFT Sniper endpoints
    this.express.get('/api/sniper/nft/targets', auth, (req, res) => {
      res.json(this.app.nftSniper.getTargets());
    });

    this.express.post('/api/sniper/nft/add-target', auth, (req, res) => {
      const target = this.app.nftSniper.addTarget(req.body);
      res.json({ ok: true, target });
    });

    this.express.post('/api/sniper/nft/remove-target', auth, (req, res) => {
      const ok = this.app.nftSniper.removeTarget(req.body.id);
      res.json({ ok });
    });

    this.express.post('/api/sniper/nft/execute', auth, (req, res) => {
      this.app.nftSniper.executeTarget(req.body.id)
        .then(result => res.json({ ok: true, result }))
        .catch(err => res.status(500).json({ ok: false, error: err.message }));
    });

    this.express.post('/api/sniper/nft/schedule', auth, (req, res) => {
      this.app.nftSniper.scheduleTarget(req.body.id)
        .then(() => res.json({ ok: true }))
        .catch(err => res.status(500).json({ ok: false, error: err.message }));
    });

    this.express.get('/api/sniper/nft/history', auth, (req, res) => {
      res.json(this.app.nftSniper.getHistory());
    });

    // Scheduler
    this.express.get('/api/scheduler/jobs', auth, (req, res) => {
      res.json(this.app.scheduler.getJobs(req.query.status));
    });

    this.express.get('/api/scheduler/upcoming', auth, (req, res) => {
      res.json(this.app.scheduler.getUpcoming());
    });

    // TX results
    this.express.get('/api/tx/results', auth, (req, res) => {
      res.json(this.app.txEngine.getResults());
    });

    this.express.post('/api/tx/stop', auth, (req, res) => {
      this.app.txEngine.stop();
      res.json({ ok: true });
    });
  }

  _setupSocket() {
    this.io.use((socket, next) => {
      const token = socket.handshake.auth?.token;
      if (this.authenticated.has(token)) return next();
      next(new Error('Unauthorized'));
    });

    this.io.on('connection', (socket) => {
      console.log(`[Dashboard] Client connected: ${socket.id}`);

      socket.on('disconnect', () => {
        console.log(`[Dashboard] Client disconnected: ${socket.id}`);
      });
    });

    // Forward events to connected clients
    const forwardEvents = (source, prefix) => {
      const origEmit = source.emit.bind(source);
      source.emit = (event, ...args) => {
        origEmit(event, ...args);
        this.io.emit(`${prefix}:${event}`, ...args);
      };
    };

    if (this.app.tokenSniper) forwardEvents(this.app.tokenSniper, 'token');
    if (this.app.nftSniper) forwardEvents(this.app.nftSniper, 'nft');
    if (this.app.txEngine) forwardEvents(this.app.txEngine, 'tx');
    if (this.app.scheduler) forwardEvents(this.app.scheduler, 'scheduler');
  }

  start() {
    return new Promise((resolve) => {
      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[Dashboard] Running on http://0.0.0.0:${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    this.server.close();
    this.io.close();
  }
}
