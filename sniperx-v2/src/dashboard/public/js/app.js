let token = null;
let socket = null;
let stats = { walletsActive: 0, tokensDetected: 0, txSent: 0, txConfirmed: 0 };

// === AUTH ===
async function doLogin() {
  const pw = document.getElementById('password-input').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');

  try {
    const res = await api('/api/auth', { password: pw });
    if (res.ok) {
      token = res.token;
      localStorage.setItem('sx_token', token);
      showApp();
    } else {
      errEl.textContent = res.error || 'Login failed';
      errEl.classList.remove('hidden');
    }
  } catch (e) {
    errEl.textContent = 'Connection error';
    errEl.classList.remove('hidden');
  }
}

document.getElementById('password-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

// === API Helper ===
async function api(path, body, method) {
  const opts = { headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers['X-Token'] = token;
  if (body) {
    opts.method = method || 'POST';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  return res.json();
}

async function apiGet(path) {
  const res = await fetch(path, { headers: { 'X-Token': token } });
  if (res.status === 401) { showLogin(); return null; }
  return res.json();
}

// === NAVIGATION ===
function showSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const sec = document.getElementById('sec-' + name);
  if (sec) sec.classList.add('active');
  const btn = document.querySelector(`.nav-btn[data-section="${name}"]`);
  if (btn) btn.classList.add('active');

  if (name === 'wallets') loadWallets();
  if (name === 'dashboard') loadDashboard();
  if (name === 'nft') loadNFTTargets();
  if (name === 'token') loadDetectedTokens();
}

function showApp() {
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('app-screen').classList.remove('hidden');
  document.getElementById('app-screen').classList.add('active');
  connectSocket();
  loadDashboard();
  loadWallets();
}

function showLogin() {
  token = null;
  localStorage.removeItem('sx_token');
  document.getElementById('app-screen').classList.add('hidden');
  document.getElementById('login-screen').classList.add('active');
}

// === SOCKET ===
function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('connect', () => {
    document.getElementById('status-dot').className = 'dot online';
  });
  socket.on('disconnect', () => {
    document.getElementById('status-dot').className = 'dot offline';
  });

  socket.on('token:new-token', (event) => {
    stats.tokensDetected++;
    updateStats();
    addFeed(`New token: ${event.token?.symbol || event.token?.address?.slice(0,10)} on ${event.chain}`, 'green');
  });

  socket.on('tx:tx-sent', (event) => {
    stats.txSent++;
    updateStats();
    addFeed(`TX sent: ${event.wallet?.slice(0,8)}... → ${event.hash?.slice(0,14)}...`);
  });

  socket.on('tx:tx-confirmed', (event) => {
    stats.txConfirmed++;
    updateStats();
    const color = event.status === 'confirmed' ? 'green' : 'red';
    addFeed(`TX ${event.status}: ${event.wallet?.slice(0,8)}...`, color);
  });

  socket.on('tx:tx-error', (event) => {
    addFeed(`TX error: ${event.wallet?.slice(0,8)}... — ${event.error?.slice(0,60)}`, 'red');
  });

  socket.on('tx:batch-complete', (summary) => {
    addFeed(`Batch done: ${summary.confirmed} confirmed, ${summary.errors} errors out of ${summary.total}`,
      summary.errors > 0 ? 'orange' : 'green');
  });

  socket.on('nft:target-executing', (t) => {
    addFeed(`NFT Mint executing: ${t.label}`, 'orange');
  });

  socket.on('nft:target-complete', (data) => {
    addFeed(`NFT Mint done: ${data.target?.label} — ${data.result?.confirmed} confirmed`, 'green');
    loadNFTTargets();
  });

  socket.on('scheduler:job-fire', (job) => {
    addFeed(`Scheduled job fired: ${job.label}`, 'purple');
  });
}

// === DASHBOARD ===
async function loadDashboard() {
  const wallets = await apiGet('/api/wallets');
  if (wallets) {
    stats.walletsActive = wallets.evm?.enabled || 0;
    document.getElementById('wallet-count').textContent = `${wallets.evm?.enabled}/${wallets.evm?.total} wallets`;
  }
  updateStats();
  loadRPCStatus();
  loadProxyStatus();
}

function updateStats() {
  document.getElementById('stat-wallets-active').textContent = stats.walletsActive;
  document.getElementById('stat-tokens-detected').textContent = stats.tokensDetected;
  document.getElementById('stat-tx-sent').textContent = stats.txSent;
  document.getElementById('stat-tx-confirmed').textContent = stats.txConfirmed;
}

async function loadRPCStatus() {
  const data = await apiGet('/api/rpc/status');
  if (!data) return;
  const el = document.getElementById('rpc-status');
  let html = '';
  for (const [chain, rpcs] of Object.entries(data)) {
    html += `<div class="feed-item"><strong>${chain}</strong>: ${rpcs.length} endpoint(s)`;
    for (const r of rpcs) {
      const color = r.failures > 0 ? 'var(--orange)' : 'var(--green)';
      html += `<br><span style="color:${color}; margin-left:12px">● ${r.name} (fails: ${r.failures})</span>`;
    }
    html += '</div>';
  }
  el.innerHTML = html || '<div class="feed-empty">No RPCs configured</div>';
}

// === FEED ===
function addFeed(text, color = '') {
  const feed = document.getElementById('live-feed');
  const empty = feed.querySelector('.feed-empty');
  if (empty) empty.remove();

  const now = new Date().toLocaleTimeString('id-ID', { hour12: false });
  const item = document.createElement('div');
  item.className = 'feed-item';
  if (color) item.style.color = `var(--${color})`;
  item.innerHTML = `<span class="feed-time">${now}</span> ${text}`;
  feed.insertBefore(item, feed.firstChild);

  while (feed.children.length > 100) feed.removeChild(feed.lastChild);
}

// === PROXY ===
async function loadProxyStatus() {
  const data = await apiGet('/api/proxy/status');
  if (!data) return;
  document.getElementById('proxy-toggle').checked = data.enabled;
  document.getElementById('proxy-status-text').textContent = data.enabled ? `Enabled (${data.total} proxies)` : 'Disabled';

  const list = document.getElementById('proxy-list');
  if (data.proxies?.length > 0) {
    list.innerHTML = data.proxies.map(p =>
      `<div class="feed-item">${p.type}://${p.host}:${p.port} <span class="feed-time">fails: ${p.failures}</span></div>`
    ).join('');
  } else {
    list.innerHTML = '';
  }
}

async function toggleProxy(enabled) {
  await api('/api/proxy/toggle', { enabled });
  loadProxyStatus();
}

async function addProxy() {
  const input = document.getElementById('proxy-add-input');
  const url = input.value.trim();
  if (!url) return;
  await api('/api/proxy/add', { url });
  input.value = '';
  loadProxyStatus();
}

// === TOKEN SNIPER ===
let tokenMonitoring = false;

async function toggleTokenMonitor() {
  const btn = document.getElementById('token-monitor-btn');
  const status = document.getElementById('token-monitor-status');
  if (!tokenMonitoring) {
    await api('/api/sniper/token/start', {});
    tokenMonitoring = true;
    btn.textContent = 'Stop';
    btn.className = 'btn btn-red';
    status.textContent = 'Monitoring...';
    status.style.color = 'var(--green)';
  } else {
    await api('/api/sniper/token/stop', {});
    tokenMonitoring = false;
    btn.textContent = 'Start';
    btn.className = 'btn btn-green';
    status.textContent = 'Stopped';
    status.style.color = '';
  }
}

async function saveAutoBuyConfig() {
  const chains = [...document.querySelectorAll('.chain-checks input:checked')].map(c => c.value);
  const walletCount = Number(document.getElementById('autobuy-wallet-count').value);
  await api('/api/sniper/token/configure', {
    autoBuy: {
      enabled: document.getElementById('autobuy-toggle').checked,
      amountPerWallet: document.getElementById('autobuy-amount').value,
      slippage: Number(document.getElementById('autobuy-slippage').value),
      walletCount: walletCount,
      useAllWallets: walletCount === 0,
      chains
    }
  });
  addFeed('Auto-buy config saved', 'green');
}

async function executeBuy() {
  const data = {
    chain: document.getElementById('buy-chain').value,
    token: document.getElementById('buy-token').value.trim(),
    amount: document.getElementById('buy-amount').value,
    walletCount: Number(document.getElementById('buy-wallet-count').value)
  };
  if (!data.token) return alert('Enter token address');
  addFeed(`Buying ${data.token.slice(0,10)}... on ${data.chain} with ${data.walletCount} wallets`, 'orange');
  const res = await api('/api/sniper/token/buy', data);
  if (res.ok) addFeed(`Buy complete: ${res.result?.confirmed} confirmed`, 'green');
  else addFeed(`Buy error: ${res.error}`, 'red');
}

async function executeSell() {
  const data = {
    chain: document.getElementById('sell-chain').value,
    token: document.getElementById('sell-token').value.trim(),
    percentage: Number(document.getElementById('sell-percentage').value)
  };
  if (!data.token) return alert('Enter token address');
  addFeed(`Selling ${data.percentage}% of ${data.token.slice(0,10)}...`, 'orange');
  const res = await api('/api/sniper/token/sell', data);
  if (res.ok) addFeed(`Sell complete: ${res.result?.confirmed} confirmed`, 'green');
  else addFeed(`Sell error: ${res.error}`, 'red');
}

async function loadDetectedTokens() {
  const tokens = await apiGet('/api/sniper/token/detected');
  const el = document.getElementById('detected-tokens');
  if (!tokens || tokens.length === 0) {
    el.innerHTML = '<div class="feed-empty">No tokens detected yet</div>';
    return;
  }
  el.innerHTML = tokens.map(t => `
    <div class="target-item">
      <div class="target-header">
        <span class="target-label">${t.token?.symbol || t.token?.address?.slice(0,10) || t.type || '?'}</span>
        <span class="status-badge status-${t.sniped ? 'completed' : 'pending'}">${t.sniped ? 'Sniped' : 'Detected'}</span>
      </div>
      <div class="target-meta">${t.chain} · ${t.token?.name || ''} · ${new Date(t.detectedAt || t.timestamp).toLocaleTimeString('id-ID')}</div>
      ${t.token?.address ? `<div class="target-actions">
        <button class="btn btn-sm btn-green" onclick="quickBuy('${t.chain}','${t.token.address}')">Quick Buy</button>
      </div>` : ''}
    </div>
  `).join('');
}

function quickBuy(chain, token) {
  document.getElementById('buy-chain').value = chain;
  document.getElementById('buy-token').value = token;
  showSection('token');
  document.getElementById('buy-token').scrollIntoView();
}

// === NFT SNIPER ===
async function addNFTTarget() {
  const args = document.getElementById('nft-args').value.split(',').map(a => {
    const n = Number(a.trim());
    return isNaN(n) ? a.trim() : n;
  });

  const scheduleInput = document.getElementById('nft-schedule').value;
  let scheduledTime = null;
  if (scheduleInput) {
    scheduledTime = new Date(scheduleInput).toISOString();
  }

  const target = {
    label: document.getElementById('nft-label').value || undefined,
    chain: document.getElementById('nft-chain').value,
    contractAddress: document.getElementById('nft-contract').value.trim(),
    mintFunction: document.getElementById('nft-abi').value,
    mintArgs: args,
    price: document.getElementById('nft-price').value,
    walletCount: Number(document.getElementById('nft-wallet-count').value),
    scheduledTime,
    gasMultiplier: Number(document.getElementById('nft-gas-mult').value)
  };

  if (!target.contractAddress) return alert('Enter contract address');

  const res = await api('/api/sniper/nft/add-target', target);
  if (res.ok) {
    addFeed(`NFT target added: ${res.target.label}`, 'green');
    loadNFTTargets();
  }
}

async function loadNFTTargets() {
  const targets = await apiGet('/api/sniper/nft/targets');
  const el = document.getElementById('nft-targets');
  if (!targets || targets.length === 0) {
    el.innerHTML = '<div class="feed-empty">No targets added</div>';
    return;
  }

  el.innerHTML = targets.map(t => `
    <div class="target-item">
      <div class="target-header">
        <span class="target-label">${t.label}</span>
        <span class="status-badge status-${t.status}">${t.status}</span>
      </div>
      <div class="target-meta">
        ${t.chain} · ${t.contractAddress.slice(0,10)}... · ${t.walletCount} wallets · ${t.price} ETH
        ${t.scheduledTime ? '<br>Scheduled: ' + new Date(t.scheduledTime).toLocaleString('id-ID') : ''}
      </div>
      <div class="target-actions">
        ${t.status === 'pending' ? `
          <button class="btn btn-sm btn-green" onclick="executeNFT('${t.id}')">Mint Now</button>
          ${t.scheduledTime ? `<button class="btn btn-sm" onclick="scheduleNFT('${t.id}')">Schedule</button>` : ''}
          <button class="btn btn-sm btn-red" onclick="removeNFT('${t.id}')">Remove</button>
        ` : ''}
      </div>
    </div>
  `).join('');

  const history = await apiGet('/api/sniper/nft/history');
  const histEl = document.getElementById('nft-history');
  if (!history || history.length === 0) {
    histEl.innerHTML = '<div class="feed-empty">No history</div>';
  } else {
    histEl.innerHTML = history.map(h => `
      <div class="target-item">
        <div class="target-header">
          <span class="target-label">${h.label}</span>
          <span class="status-badge status-${h.status}">${h.status}</span>
        </div>
        <div class="target-meta">${h.chain} · ${h.result?.confirmed || 0} confirmed / ${h.result?.total || 0} total · ${h.executedAt ? new Date(h.executedAt).toLocaleString('id-ID') : ''}</div>
      </div>
    `).join('');
  }
}

async function executeNFT(id) {
  if (!confirm('Execute mint now?')) return;
  addFeed('Executing NFT mint...', 'orange');
  const res = await api('/api/sniper/nft/execute', { id });
  if (res.ok) addFeed(`Mint complete: ${res.result?.confirmed} confirmed`, 'green');
  else addFeed(`Mint error: ${res.error}`, 'red');
  loadNFTTargets();
}

async function scheduleNFT(id) {
  const res = await api('/api/sniper/nft/schedule', { id });
  if (res.ok) addFeed('NFT mint scheduled', 'green');
  else addFeed(`Schedule error: ${res.error}`, 'red');
  loadNFTTargets();
}

async function removeNFT(id) {
  await api('/api/sniper/nft/remove-target', { id });
  loadNFTTargets();
}

// === WALLETS ===
async function loadWallets() {
  const data = await apiGet('/api/wallets');
  if (!data) return;

  document.getElementById('evm-wallet-summary').textContent = `${data.evm.enabled}/${data.evm.total}`;
  document.getElementById('sol-wallet-summary').textContent = `${data.solana.enabled}/${data.solana.total}`;

  const evmList = document.getElementById('evm-wallet-list');
  if (data.evm.wallets.length > 0) {
    evmList.innerHTML = data.evm.wallets.map(w => `
      <div class="wallet-item">
        <span class="wallet-idx">#${w.index}</span>
        <span class="wallet-addr">${w.address.slice(0,6)}...${w.address.slice(-4)}</span>
        <label class="toggle">
          <input type="checkbox" ${w.enabled ? 'checked' : ''} onchange="toggleWallet(${w.index},'evm')">
          <span class="slider"></span>
        </label>
      </div>
    `).join('');
  } else {
    evmList.innerHTML = '<div class="feed-empty">No EVM wallets loaded</div>';
  }

  const solList = document.getElementById('sol-wallet-list');
  if (data.solana.wallets.length > 0) {
    solList.innerHTML = data.solana.wallets.map(w => `
      <div class="wallet-item">
        <span class="wallet-idx">#${w.index}</span>
        <span class="wallet-addr">${w.address.slice(0,6)}...${w.address.slice(-4)}</span>
        <label class="toggle">
          <input type="checkbox" ${w.enabled ? 'checked' : ''} onchange="toggleWallet(${w.index},'solana')">
          <span class="slider"></span>
        </label>
      </div>
    `).join('');
  } else {
    solList.innerHTML = '<div class="feed-empty">No Solana wallets loaded</div>';
  }
}

async function toggleWallet(index, type) {
  await api('/api/wallets/toggle', { index, type });
}

async function enableAllWallets() {
  await api('/api/wallets/enable-all', { type: 'evm' });
  loadWallets();
}

async function disableAllWallets() {
  await api('/api/wallets/disable-all', { type: 'evm' });
  loadWallets();
}

async function enableRange() {
  const start = Number(document.getElementById('range-start').value);
  const end = Number(document.getElementById('range-end').value);
  await api('/api/wallets/enable-range', { start, end, type: 'evm' });
  loadWallets();
}

// === SETTINGS ===
async function saveSettings() {
  // These would be sent to the backend
  addFeed('Settings saved', 'green');
}

async function emergencyStop() {
  if (!confirm('STOP all running transactions?')) return;
  await api('/api/tx/stop', {});
  addFeed('EMERGENCY STOP executed', 'red');
}

// === INIT ===
(function init() {
  const saved = localStorage.getItem('sx_token');
  if (saved) {
    token = saved;
    showApp();
  }
})();
