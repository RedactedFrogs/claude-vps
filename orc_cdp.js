#!/usr/bin/env node
// Zero-dependency Orc Miner - uses Chrome CDP directly via Node.js 22 built-in WebSocket
// No npm install needed!

const { spawn } = require('child_process');
const http = require('http');

const ACCOUNTS = [
  { handle: 'boss_venture89',   wallet: '0xA10C742597B3639331903ed1c26208AF87fAcD95' },
  { handle: 'redacted_frogs',   wallet: '0x9C98Cc106b01C0B9dAEA980aa36a5d731587bDa8' },
  { handle: 'mallardordinals',  wallet: '0xdaDfc6D1774C8AcE5B2f48C8Cba17c9660ad148D' },
  { handle: 'bossventure168',   wallet: '0x50fAbeA8992A740b4b271b7FF7ED0B6074f970a1' },
  { handle: 'gryfindor_bot',    wallet: '0xE1C436e928131B6D6E3E3DdF6BF34dc2A223BD6b' },
  { handle: 'hendrawanipiro',   wallet: '0xAE0284d37038A9F5D4279DFF591D9B9368dE0815' },
];

const acctIndex = parseInt(process.argv[2] || '0');
const acct = ACCOUNTS[acctIndex];
if (!acct) { console.error('Invalid index 0-5'); process.exit(1); }

const PORT = 9222 + acctIndex;
const CHROME = '/usr/bin/google-chrome';
const USER_DIR = `/tmp/orc-chrome-${acctIndex}`;

console.log(`\n=== ORC MINER CDP: @${acct.handle} [${acctIndex}] ===`);
console.log(`Wallet: ${acct.wallet}`);

let msgId = 1;
let ws = null;
let chromeProc = null;
const pending = new Map();

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const msg = JSON.stringify({ id, method, params });
    pending.set(id, { resolve, reject, method });
    ws.send(msg);
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.text || JSON.stringify(r.result.exceptionDetails));
  }
  return r.result?.result?.value;
}

async function screenshot(path) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) {
    require('fs').writeFileSync(path, Buffer.from(r.result.data, 'base64'));
    console.log(`  Screenshot: ${path}`);
  }
}

async function dispatchKey(type, key, code, keyCode) {
  await send('Input.dispatchKeyEvent', {
    type, key, code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
}

async function pressKey(key, code, keyCode, holdMs = 0) {
  await dispatchKey('keyDown', key, code, keyCode);
  if (holdMs > 0) await sleep(holdMs);
  await dispatchKey('keyUp', key, code, keyCode);
}

async function mouseClick(x, y, button = 'left') {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
}

async function mouseDown(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
}

async function mouseUp(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function mouseMove(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

async function startChrome() {
  console.log('Launching Chrome...');
  chromeProc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DIR}`,
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--use-gl=swiftshader',
    '--enable-webgl',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,720',
    '--no-first-run',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-background-networking',
    `--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`,
    'about:blank',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
  });

  chromeProc.stderr.on('data', d => {
    const s = d.toString();
    if (s.includes('DevTools listening')) console.log('  ' + s.trim());
  });

  await sleep(3000);

  for (let i = 0; i < 15; i++) {
    try {
      const data = await httpGet(`http://127.0.0.1:${PORT}/json`);
      const targets = JSON.parse(data);
      const page = targets.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(1000);
  }
  throw new Error('Chrome did not start');
}

async function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      console.log('  CDP connected.');
      resolve();
    });
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        p.resolve(msg);
      }
    });
    ws.on('error', reject);
    ws.on('close', () => console.log('  CDP disconnected.'));
  });
}

async function navigate(url) {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  const nav = send('Page.navigate', { url });
  await new Promise(resolve => {
    const handler = data => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Page.loadEventFired') {
        ws.removeListener('message', handler);
        resolve();
      }
    };
    ws.on('message', handler);
    setTimeout(resolve, 30000);
  });
  await nav;
  await sleep(2000);
}

async function getGameState() {
  return evaluate(`(function(){
    var oreEl = document.querySelector('#ore b') || document.querySelector('#ore');
    var oreText = oreEl ? oreEl.textContent : '';
    var m = oreText.match(/(\\d+)\\/(\\d+)/);
    return JSON.stringify({
      ore: m ? parseInt(m[1]) : -1,
      total: m ? parseInt(m[2]) : 10,
      status: (document.getElementById('status') || {}).textContent || '',
      bank: (document.getElementById('bank') || {}).textContent || '',
      hint: (document.getElementById('mr') || {}).textContent || '',
      overlayVisible: document.getElementById('overlay') ? document.getElementById('overlay').style.display : 'none',
      overlayHTML: document.getElementById('overlay') ? document.getElementById('overlay').innerHTML.substring(0,200) : '',
      done: !!(document.getElementById('overlay') && document.getElementById('overlay').innerHTML.indexOf('VEIN BREACHED') > -1),
      claimVisible: document.getElementById('claim') ? document.getElementById('claim').style.display !== 'none' : false,
      hasXBtn: !!document.getElementById('xBtn'),
      hasWalletForm: !!document.getElementById('walletForm'),
    });
  })()`).then(s => JSON.parse(s));
}

async function waitForSession(maxWait = 120000) {
  console.log('Waiting for Turnstile + session...');
  const t0 = Date.now();
  while (Date.now() - t0 < maxWait) {
    const st = await getGameState();
    if (st.status.includes('on shift') || st.status.includes('seats today')) {
      console.log(`  Session OK: "${st.status}"`);
      return true;
    }
    if (st.status.includes('unreachable') || st.status.includes('not available') || st.status.includes('no seats')) {
      console.log(`  ERROR: "${st.status}"`);
      return false;
    }
    if (st.status.includes('bot check')) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      if (elapsed % 10 === 0) console.log(`  [${elapsed}s] Turnstile: "${st.status}"`);
    }
    await sleep(2000);
  }
  console.log('  Turnstile timeout!');
  return false;
}

const KEYS = {
  w: { key: 'w', code: 'KeyW', keyCode: 87 },
  a: { key: 'a', code: 'KeyA', keyCode: 65 },
  s: { key: 's', code: 'KeyS', keyCode: 83 },
  d: { key: 'd', code: 'KeyD', keyCode: 68 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
};

async function holdKey(k, ms) {
  await dispatchKey('keyDown', k.key, k.code, k.keyCode);
  await sleep(ms);
  await dispatchKey('keyUp', k.key, k.code, k.keyCode);
}

async function sprintDir(dir, ms) {
  await dispatchKey('keyDown', KEYS.shift.key, KEYS.shift.code, KEYS.shift.keyCode);
  await dispatchKey('keyDown', dir.key, dir.code, dir.keyCode);
  await sleep(ms);
  await dispatchKey('keyUp', dir.key, dir.code, dir.keyCode);
  await dispatchKey('keyUp', KEYS.shift.key, KEYS.shift.code, KEYS.shift.keyCode);
}

async function swing(holdMs = 300) {
  const cx = 640, cy = 400;
  await mouseDown(cx, cy);
  await sleep(holdMs);
  await mouseUp(cx, cy);
}

async function mine() {
  console.log('\n--- MINING PHASE ---');

  // Click canvas to grab pointer lock
  await mouseClick(640, 360);
  await sleep(500);
  // Force pointer lock via JS
  await evaluate(`document.querySelector('canvas#c')?.requestPointerLock()`).catch(()=>{});
  await sleep(500);

  // Walk into cave (straight ahead)
  console.log('Walking to cave...');
  for (let i = 0; i < 20; i++) {
    await sprintDir(KEYS.w, 300);
    await sleep(50);
  }
  await sleep(500);

  let prevOre = 0;
  let round = 0;
  let noProgress = 0;
  const t0 = Date.now();
  const MAX_TIME = 600000; // 10 minutes

  while (round < 2000 && (Date.now() - t0) < MAX_TIME) {
    let st;
    try { st = await getGameState(); } catch { await sleep(500); round++; continue; }

    if (st.done) {
      console.log('*** VEIN BREACHED! All ore collected! ***');
      break;
    }

    if (st.ore > prevOre) {
      console.log(`  Ore: ${st.ore}/${st.total} | bank: "${st.bank}" | hint: "${st.hint}"`);
      prevOre = st.ore;
      noProgress = 0;
    }

    // Need to go to cart?
    const needCart = st.hint?.includes('cart') || st.hint?.includes('drop') ||
                     st.status?.includes('wants more') || st.status?.includes('full');
    if (needCart) {
      console.log('  -> Full! Going to cart...');
      // Turn around and run to cart
      for (let i = 0; i < 8; i++) {
        await mouseMove(300, 360);
        await sleep(30);
      }
      for (let j = 0; j < 30; j++) {
        await sprintDir(KEYS.w, 200);
        await sleep(50);
        try {
          const s2 = await getGameState();
          if (!s2.hint?.includes('cart') && !s2.hint?.includes('drop') &&
              !s2.status?.includes('wants more') && !s2.status?.includes('full')) {
            console.log(`  -> Dropped! bank="${s2.bank}"`);
            break;
          }
        } catch {}
      }
      // Turn back to cave
      for (let i = 0; i < 8; i++) {
        await mouseMove(300, 360);
        await sleep(30);
      }
      for (let j = 0; j < 15; j++) {
        await sprintDir(KEYS.w, 300);
        await sleep(50);
      }
      noProgress = 0;
      continue;
    }

    // Mining pattern: varied direction + swing
    const dirs = [KEYS.w, KEYS.a, KEYS.s, KEYS.d];
    const dir = dirs[round % 4];

    // Move
    await holdKey(dir, 150 + (round % 3) * 50);

    // Jump sometimes
    if (round % 7 === 0) {
      await holdKey(KEYS.space, 100);
      await sleep(100);
    }

    // Look around
    const lx = 400 + (round % 9) * 60;
    const ly = 300 + (round % 5) * 50;
    await mouseMove(lx, ly);
    await sleep(30);

    // Swing (power swing every 3rd)
    const power = round % 3 === 0;
    await swing(power ? 700 : 250);

    round++;
    noProgress++;

    // Every 50 rounds log
    if (round % 50 === 0) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`  R${round} [${elapsed}s]: ore=${st.ore}/${st.total} bank="${st.bank}"`);
      await screenshot(`/tmp/orc-mine-r${round}-${acctIndex}.png`);
    }

    // No progress for 80 rounds: move to different area
    if (noProgress > 80) {
      console.log('  No progress — moving randomly...');
      for (let j = 0; j < 8; j++) {
        const rd = dirs[Math.floor(Math.random() * 4)];
        await sprintDir(rd, 400);
        await sleep(50);
      }
      noProgress = 0;
    }
  }

  const final = await getGameState();
  console.log(`\nFINAL: ore=${final.ore}/${final.total} bank="${final.bank}" done=${final.done}`);
  await screenshot(`/tmp/orc-final-${acctIndex}.png`);
  return final;
}

async function claimSeat(state) {
  if (!state.done) {
    console.log('Mining not complete, cannot claim.');
    return false;
  }

  console.log('\n--- CLAIM PHASE ---');
  await sleep(3000);

  // Check for X OAuth button
  const claimState = await getGameState();
  console.log('Claim state:', JSON.stringify(claimState, null, 2));
  await screenshot(`/tmp/orc-claim-${acctIndex}.png`);

  if (claimState.hasXBtn) {
    console.log('X OAuth needed. Clicking X button...');
    await evaluate(`document.getElementById('xBtn')?.click()`);
    await sleep(3000);

    // Get the OAuth URL
    const oauthUrl = await evaluate(`(function(){
      var links = document.querySelectorAll('a[href*="twitter"], a[href*="x.com"]');
      if (links.length) return links[0].href;
      return null;
    })()`);

    if (oauthUrl) {
      console.log(`\n!!! X OAuth URL (open di HP) !!!\n${oauthUrl}\n`);
      console.log('Waiting 120 seconds for X auth...');
      for (let i = 0; i < 60; i++) {
        await sleep(2000);
        const s = await getGameState();
        if (s.hasWalletForm || !s.hasXBtn) {
          console.log('X auth completed!');
          break;
        }
        if (i % 10 === 0) console.log(`  Waiting X auth... ${i * 2}s`);
      }
    } else {
      // Try API begin
      const beginResult = await evaluate(`
        fetch('/api/x/begin', {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({session: window._orcSession || ''})
        }).then(r => r.json()).then(d => JSON.stringify(d)).catch(e => JSON.stringify({error: e.message}))
      `);
      console.log('X begin API:', beginResult);
    }
  }

  // Check if wallet form available
  await sleep(2000);
  const walletState = await getGameState();

  if (walletState.hasWalletForm) {
    console.log(`Entering wallet: ${acct.wallet}`);
    // Type wallet address
    await evaluate(`
      var input = document.getElementById('wallet') || document.querySelector('input[name="wallet"]') || document.querySelector('#walletForm input');
      if (input) { input.value = '${acct.wallet}'; input.dispatchEvent(new Event('input', {bubbles:true})); }
    `);
    await sleep(500);

    // Submit
    await evaluate(`
      var btn = document.querySelector('#walletForm button[type="submit"]') || document.querySelector('#walletForm button');
      if (btn) btn.click();
      else { var form = document.getElementById('walletForm'); if(form) form.submit(); }
    `);
    await sleep(3000);

    const result = await evaluate(`document.getElementById('status')?.textContent || document.getElementById('claim')?.textContent || ''`);
    console.log(`\nCLAIM RESULT: ${result}`);
    await screenshot(`/tmp/orc-result-${acctIndex}.png`);

    if (result.includes('claimed') || result.includes('confirmed') || result.includes('seat')) {
      console.log(`SUCCESS! @${acct.handle} claimed seat!`);
      return true;
    }
  } else {
    console.log('No wallet form found yet. Manual intervention needed.');
    await screenshot(`/tmp/orc-nowallet-${acctIndex}.png`);
  }

  return false;
}

async function main() {
  try {
    const wsUrl = await startChrome();
    console.log(`CDP WebSocket: ${wsUrl}`);

    await connectWs(wsUrl);

    // Navigate to game
    console.log('Loading orcs.ink/mine/...');
    await navigate('https://orcs.ink/mine/');
    await screenshot(`/tmp/orc-start-${acctIndex}.png`);

    // Wait for start button
    console.log('Waiting for start button...');
    for (let i = 0; i < 20; i++) {
      const ready = await evaluate(`!document.getElementById('start')?.disabled`);
      if (ready) break;
      await sleep(1000);
    }

    // Check seats
    const seats = await evaluate(`fetch('/api/seats').then(r=>r.json()).then(d=>JSON.stringify(d))`);
    console.log('Seats:', seats);
    const seatsObj = JSON.parse(seats || '{}');
    if (seatsObj.left === 0) {
      console.log('No seats left today! Come back after 23:00 WIB.');
      await cleanup();
      return;
    }

    // Click START
    console.log('Clicking START...');
    await evaluate(`document.getElementById('start').click()`);
    await sleep(1000);

    // Wait for session
    const sessionOk = await waitForSession();
    await screenshot(`/tmp/orc-session-${acctIndex}.png`);

    if (!sessionOk) {
      console.log('Failed to start session. See screenshot.');
      await cleanup();
      return;
    }

    // Mine!
    const finalState = await mine();

    // Claim
    if (finalState.done) {
      await claimSeat(finalState);
    } else {
      console.log(`Mining incomplete: ${finalState.ore}/${finalState.total}`);
    }

    await cleanup();
  } catch (err) {
    console.error('FATAL:', err.message);
    await cleanup();
    process.exit(1);
  }
}

async function cleanup() {
  if (ws) try { ws.close(); } catch {}
  if (chromeProc) try { chromeProc.kill('SIGTERM'); } catch {}
  await sleep(1000);
  console.log('Done.');
}

main();
