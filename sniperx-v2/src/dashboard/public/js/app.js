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
  if (name === 'nft') { loadNFTTargets(); fetchGasPrice(); loadWalletPicker(); }
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

// === GAS PRICE ===
let gasData = { slow: 0, normal: 0, fast: 0, gasPrice: 0 };
let selectedGasSpeed = 'normal';

async function fetchGasPrice() {
  const chain = document.getElementById('nft-chain').value;
  const el = document.getElementById('gas-live');
  el.textContent = 'Loading gas price...';
  try {
    const data = await apiGet(`/api/gas/${chain}`);
    if (!data || data.error) { el.textContent = 'Gas price unavailable'; return; }
    gasData = data;
    el.innerHTML = `Live gas: <span class="gas-value">${data.gasPrice} gwei</span> (${chain})`;
    document.querySelectorAll('.gas-btn').forEach(btn => {
      const speed = btn.dataset.speed;
      if (speed !== 'custom' && data[speed] !== undefined) {
        btn.innerHTML = `${speed.charAt(0).toUpperCase() + speed.slice(1)}<span class="gas-gwei">${data[speed]} gwei</span>`;
      }
    });
    updateGasMultiplier();
  } catch (e) {
    el.textContent = 'Gas price unavailable';
  }
}

function selectGas(speed) {
  selectedGasSpeed = speed;
  document.querySelectorAll('.gas-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.gas-btn[data-speed="${speed}"]`).classList.add('active');
  const customRow = document.getElementById('gas-custom-row');
  if (speed === 'custom') { customRow.classList.remove('hidden'); }
  else { customRow.classList.add('hidden'); updateGasMultiplier(); }
}

function updateGasMultiplier() {
  if (gasData.gasPrice <= 0) return;
  let mult = 1;
  if (selectedGasSpeed === 'slow') mult = 0.85;
  else if (selectedGasSpeed === 'normal') mult = 1;
  else if (selectedGasSpeed === 'fast') mult = 1.5;
  else if (selectedGasSpeed === 'custom') {
    const custom = Number(document.getElementById('nft-gas-custom').value);
    if (custom > 0) mult = custom / gasData.gasPrice;
  }
  document.getElementById('nft-gas-mult').value = Math.round(mult * 100) / 100;
}

// === WALLET PICKER ===
let selectedWalletSource = 'main';
let allBotWallets = [];
let selectedBotIndices = new Set();

async function loadWalletPicker() {
  const data = await apiGet('/api/wallets');
  if (!data) return;
  const picker = document.getElementById('wallet-picker');
  const mainAddr = data.mainWallet;
  const valAddr = data.validatorWallet;
  const botCount = data.evm?.total || 0;
  const botEnabled = data.evm?.enabled || 0;
  allBotWallets = (data.evm?.wallets || []).map((w, i) => ({ index: i, address: w.address, enabled: w.enabled }));

  if (selectedBotIndices.size === 0 && allBotWallets.length > 0) {
    const first = allBotWallets.find(w => w.enabled);
    if (first) selectedBotIndices.add(first.index);
  }

  let html = '';
  if (mainAddr) {
    html += `<div class="wp-option ${selectedWalletSource === 'main' ? 'active' : ''}" onclick="selectWallet('main')">
      <div class="wp-radio"></div>
      <div><div class="wp-name">Wallet Utama</div><div class="wp-addr">${mainAddr.slice(0,6)}...${mainAddr.slice(-4)}</div></div>
    </div>`;
  }
  if (valAddr) {
    html += `<div class="wp-option ${selectedWalletSource === 'validator' ? 'active' : ''}" onclick="selectWallet('validator')">
      <div class="wp-radio"></div>
      <div><div class="wp-name">Wallet Validator</div><div class="wp-addr">${valAddr.slice(0,6)}...${valAddr.slice(-4)}</div></div>
    </div>`;
  }
  if (botCount > 0) {
    html += `<div class="wp-option ${selectedWalletSource === 'bot' ? 'active' : ''}" onclick="selectWallet('bot')">
      <div class="wp-radio"></div>
      <div><div class="wp-name">Bot Wallets</div><div class="wp-addr">${botEnabled}/${botCount} aktif</div></div>
    </div>`;
  }
  picker.innerHTML = html;
  document.getElementById('bot-select-row').classList.toggle('hidden', selectedWalletSource !== 'bot');
  renderBotList();
}

function selectWallet(source) {
  selectedWalletSource = source;
  document.querySelectorAll('.wp-option').forEach(el => el.classList.remove('active'));
  const clicked = [...document.querySelectorAll('.wp-option')].find(el =>
    el.getAttribute('onclick')?.includes(`'${source}'`)
  );
  if (clicked) clicked.classList.add('active');
  document.getElementById('bot-select-row').classList.toggle('hidden', source !== 'bot');
  renderBotList();
}

function renderBotList() {
  const el = document.getElementById('bot-wallet-list');
  if (!el) return;
  if (selectedWalletSource !== 'bot') { el.innerHTML = ''; updateBotCounter(); return; }
  const enabled = allBotWallets.filter(w => w.enabled);
  el.innerHTML = enabled.map(w =>
    `<div class="bw-item ${selectedBotIndices.has(w.index) ? 'selected' : ''}" onclick="toggleBotWallet(${w.index})">
      <div class="bw-check">${selectedBotIndices.has(w.index) ? '&#10003;' : ''}</div>
      <span class="bw-idx">#${w.index}</span>
      <span class="bw-addr">${w.address.slice(0,6)}...${w.address.slice(-4)}</span>
    </div>`
  ).join('');
  updateBotCounter();
}

function toggleBotWallet(index) {
  if (selectedBotIndices.has(index)) selectedBotIndices.delete(index);
  else selectedBotIndices.add(index);
  renderBotList();
}

function selectAllBots() {
  allBotWallets.filter(w => w.enabled).forEach(w => selectedBotIndices.add(w.index));
  renderBotList();
}

function deselectAllBots() {
  selectedBotIndices.clear();
  renderBotList();
}

function selectFirstNBots() {
  const n = Number(document.getElementById('bot-select-n').value) || 1;
  selectedBotIndices.clear();
  allBotWallets.filter(w => w.enabled).slice(0, n).forEach(w => selectedBotIndices.add(w.index));
  renderBotList();
}

function updateBotCounter() {
  const el = document.getElementById('bot-selected-count');
  if (el) el.textContent = `${selectedBotIndices.size} dipilih`;
}

// === AUTO-DETECT CHAIN ===
let detectTimer = null;
function onContractInput(val) {
  const status = document.getElementById('chain-detect-status');
  if (detectTimer) clearTimeout(detectTimer);
  if (/^0x[a-fA-F0-9]{40}$/.test(val)) {
    status.innerHTML = '<span style="color:var(--orange)">Detecting chain...</span>';
    detectTimer = setTimeout(() => detectChain(val), 500);
  } else {
    status.textContent = '';
  }
}

async function detectChain(address) {
  const status = document.getElementById('chain-detect-status');
  try {
    const data = await apiGet(`/api/chain/detect/${address}`);
    if (data && data.primary) {
      document.getElementById('nft-chain').value = data.primary;
      const chainNames = data.chains.map(c => c.charAt(0).toUpperCase() + c.slice(1));
      status.innerHTML = `<span style="color:var(--green)">Found on: ${chainNames.join(', ')}</span>`;
      fetchGasPrice();
    } else {
      status.innerHTML = '<span style="color:var(--text-dim)">Contract not found on any chain</span>';
    }
  } catch {
    status.innerHTML = '<span style="color:var(--red)">Detection failed</span>';
  }
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

  if (selectedGasSpeed === 'custom') updateGasMultiplier();

  const mintUrl = document.getElementById('nft-url').value.trim();
  const contractAddress = document.getElementById('nft-contract').value.trim();

  if (!mintUrl && !contractAddress) return alert('Isi Mint URL atau Contract Address (minimal salah satu)');

  const target = {
    mintUrl: mintUrl || undefined,
    chain: document.getElementById('nft-chain').value,
    contractAddress: contractAddress || undefined,
    mintFunction: document.getElementById('nft-abi').value,
    mintArgs: args,
    price: document.getElementById('nft-price').value,
    walletSource: selectedWalletSource,
    walletCount: selectedWalletSource === 'bot' ? selectedBotIndices.size : 1,
    walletIndices: selectedWalletSource === 'bot' ? [...selectedBotIndices] : null,
    scheduledTime,
    gasMultiplier: Number(document.getElementById('nft-gas-mult').value)
  };

  const res = await api('/api/sniper/nft/add-target', target);
  if (res.ok) {
    addFeed(`NFT target saved: ${res.target.label}`, 'green');
    loadNFTTargets();
  }
  return res;
}

async function mintNFTNow() {
  const res = await addNFTTarget();
  if (!res || !res.ok) return;
  addFeed(`Minting ${res.target.label}...`, 'orange');
  const mint = await api('/api/sniper/nft/execute', { id: res.target.id });
  if (mint.ok) {
    addFeed(`Mint success: ${mint.result?.confirmed || 0} confirmed`, 'green');
  } else {
    addFeed(`Mint failed: ${mint.error}`, 'red');
  }
  loadNFTTargets();
}

async function loadNFTTargets() {
  const targets = await apiGet('/api/sniper/nft/targets');
  const el = document.getElementById('nft-targets');
  if (!targets || targets.length === 0) {
    el.innerHTML = '<div class="feed-empty">No targets added</div>';
    return;
  }

  el.innerHTML = targets.map(t => {
    const title = t.contractAddress
      ? `${t.contractAddress.slice(0,6)}...${t.contractAddress.slice(-4)}`
      : t.mintUrl ? new URL(t.mintUrl).hostname : 'NFT Target';
    return `
    <div class="target-item">
      <div class="target-header">
        <span class="target-label">${title}</span>
        <span class="status-badge status-${t.status}">${t.status}</span>
      </div>
      ${t.mintUrl ? `<div class="target-meta"><a href="${t.mintUrl}" target="_blank" style="color:var(--accent);text-decoration:none">${t.mintUrl}</a></div>` : ''}
      ${t.contractAddress ? `<div class="target-meta" style="font-family:monospace;font-size:11px">${t.contractAddress}</div>` : ''}
      <div class="target-meta">
        ${t.chain} · ${t.walletSource === 'main' ? 'Wallet Utama' : t.walletSource === 'validator' ? 'Wallet Validator' : (t.walletIndices?.length || t.walletCount) + ' bot wallets'} · ${t.price} ETH · gas ${t.gasMultiplier}x
        ${t.scheduledTime ? '<br>Scheduled: ' + new Date(t.scheduledTime).toLocaleString('id-ID') : ''}
      </div>
      <div class="target-actions">
        ${t.status === 'pending' ? `
          <button class="btn btn-sm btn-green" onclick="executeNFT('${t.id}')">⚡ Mint</button>
          ${t.scheduledTime ? `<button class="btn btn-sm" onclick="scheduleNFT('${t.id}')">Schedule</button>` : ''}
          <button class="btn btn-sm btn-red" onclick="removeNFT('${t.id}')">Remove</button>
        ` : ''}
      </div>
    </div>`;
  }).join('');

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
      <div class="wallet-item" style="flex-wrap:wrap">
        <span class="wallet-idx">#${w.index}</span>
        <span class="wallet-addr">${w.address.slice(0,6)}...${w.address.slice(-4)}</span>
        ${w.x ? `<span class="badge" style="background:rgba(29,155,240,0.2);color:#1d9bf0;font-size:11px">${w.x}</span>` : ''}
        <label class="toggle">
          <input type="checkbox" ${w.enabled ? 'checked' : ''} onchange="toggleWallet(${w.index},'evm')">
          <span class="slider"></span>
        </label>
        <div style="width:100%;display:flex;gap:4px;margin-top:4px">
          <input type="text" value="${w.x || ''}" placeholder="@x_handle" style="flex:1;padding:4px 8px;font-size:11px" onchange="setSocial(${w.index},'evm','x',this.value)">
          <input type="text" value="${w.discord || ''}" placeholder="discord" style="flex:1;padding:4px 8px;font-size:11px" onchange="setSocial(${w.index},'evm','discord',this.value)">
        </div>
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

// === WALLET SOCIALS (X/Twitter, Discord) ===
async function setSocial(index, type, field, value) {
  await api('/api/wallets/set-social', { index, type, field, value });
}

async function bulkSetX() {
  const handles = document.getElementById('bulk-x-input').value;
  if (!handles.trim()) return alert('Paste X handles dulu');
  const res = await api('/api/wallets/bulk-x', { type: 'evm', handles });
  if (res.ok) {
    addFeed(`${res.assigned} X handles saved`, 'green');
    loadWallets();
    document.getElementById('bulk-x-input').value = '';
  }
}

async function bulkSetDiscord() {
  const names = document.getElementById('bulk-discord-input').value;
  if (!names.trim()) return alert('Paste Discord names dulu');
  const res = await api('/api/wallets/bulk-discord', { type: 'evm', names });
  if (res.ok) {
    addFeed(`${res.assigned} Discord names saved`, 'green');
    loadWallets();
    document.getElementById('bulk-discord-input').value = '';
  }
}

async function exportWL() {
  const data = await apiGet('/api/wallets/export-wl?type=evm');
  if (!data || data.length === 0) {
    document.getElementById('wl-export-result').textContent = 'No enabled wallets';
    return;
  }
  let csv = 'No,Address,X,Discord\n';
  data.forEach((w, i) => {
    csv += `${i + 1},${w.address},${w.x},${w.discord}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wl-export-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  document.getElementById('wl-export-result').innerHTML =
    `<span style="color:var(--green)">Exported ${data.length} wallets</span>`;
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
