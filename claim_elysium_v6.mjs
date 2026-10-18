#!/usr/bin/env node
/**
 * Elysium Testnet Faucet Claimer v6
 * Strategy: Launch Chrome manually (ensuring headed mode with Xvfb),
 * then connect via CDP. This avoids Puppeteer forcing headless flags.
 */
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync, spawn } from 'child_process';

const FAUCET_URL = 'https://elysium.kinetiq.xyz/testnet-faucet';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const CDP_PORT = 9222;
const TIMEOUT = 90_000;
const LOG_MAX = 5 * 1024 * 1024; // 5MB log limit

const WALLETS = [
  { name: 'validator',       addr: '0x9C98Cc106b01C0B9dAEA980aa36a5d731587bDa8' },
  { name: 'mallardordinals', addr: '0xdaDfc6D1774C8AcE5B2f48C8Cba17c9660ad148D' },
  { name: 'bossventure168',  addr: '0x50fAbeA8992A740b4b271b7FF7ED0B6074f970a1' },
  { name: 'gryfindor_bot',   addr: '0xE1C436e928131B6D6E3E3DdF6BF34dc2A223BD6b' },
  { name: 'hendrawanipiro',  addr: '0xAE0284d37038A9F5D4279DFF591D9B9368dE0815' },
];

function loadBotWallets(n = 4) {
  try {
    const raw = readFileSync('/home/boss/.pixelpals_wallets.json', 'utf8');
    return JSON.parse(raw).slice(0, n).map((w, i) => ({
      name: `bot_${i}`, addr: w.address || w.wallet || w.addr,
    })).filter(w => w.addr);
  } catch (e) { console.log(`  [!] Bot wallets: ${e.message}`); return []; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function launchChrome() {
  // Kill any existing CDP Chrome
  try { execSync(`pkill -f 'remote-debugging-port=${CDP_PORT}' 2>/dev/null`); } catch {}
  sleep(1000);

  const userDataDir = '/tmp/chrome_faucet_profile';
  execSync(`rm -rf ${userDataDir} && mkdir -p ${userDataDir}`);

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1366,768',
    '--no-first-run',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--lang=en-US',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ];

  console.log(`Launching Chrome (DISPLAY=${process.env.DISPLAY})...`);
  console.log(`Args: ${args.join(' ').slice(0, 200)}...`);

  const chrome = spawn(CHROME, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env },
  });

  chrome.stderr.on('data', d => {
    const s = d.toString();
    if (s.includes('DevTools listening')) console.log(`  Chrome: ${s.trim()}`);
  });

  return chrome;
}

async function waitForCDP(maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      const data = await resp.json();
      console.log(`CDP connected: ${data.Browser}`);
      return data.webSocketDebuggerUrl;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('CDP connection timeout');
}

async function main() {
  console.log('='.repeat(60));
  console.log('ELYSIUM FAUCET v6 — manual Chrome + CDP connect');
  console.log(new Date().toISOString());
  console.log(`DISPLAY=${process.env.DISPLAY || 'NOT SET'}`);
  console.log('='.repeat(60));

  if (!process.env.DISPLAY) {
    console.error('ERROR: DISPLAY not set. Run with Xvfb.');
    process.exit(1);
  }

  const allWallets = [...WALLETS, ...loadBotWallets(4)];
  console.log(`Wallets: ${allWallets.length}`);

  // Launch Chrome manually
  const chromeProc = launchChrome();
  await sleep(3000);

  // Connect via CDP
  const wsUrl = await waitForCDP();
  const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });

  // Stealth patches — no need to hide webdriver since we didn't use --enable-automation
  await page.evaluateOnNewDocument(() => {
    // Extra safety: remove webdriver traces
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete navigator.__proto__.webdriver;

    // Realistic chrome object
    window.chrome = {
      runtime: { onConnect: { addListener: () => {} }, onMessage: { addListener: () => {} } },
      loadTimes: () => ({
        requestTime: Date.now() / 1000 - 0.5,
        startLoadTime: Date.now() / 1000 - 0.3,
        commitLoadTime: Date.now() / 1000 - 0.1,
        finishDocumentLoadTime: Date.now() / 1000,
        finishLoadTime: Date.now() / 1000,
        firstPaintTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'h2',
      }),
      csi: () => ({ pageT: Date.now(), onloadT: Date.now() + 100, startE: Date.now() - 500, tran: 15 }),
    };

    // Plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        arr.item = i => arr[i]; arr.namedItem = n => arr.find(p => p.name === n); arr.refresh = () => {};
        return arr;
      },
    });

    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g', rtt: 50, downlink: 10, saveData: false,
        onchange: null, addEventListener: () => {}, removeEventListener: () => {},
      }),
    });
  });

  // Monitor API calls
  page.on('response', async resp => {
    if (resp.url().includes('/api/faucet')) {
      try {
        const body = await resp.text();
        console.log(`  [API] ${resp.status()} ${body.slice(0, 200)}`);
      } catch {}
    }
  });

  console.log('\nLoading faucet page...');
  await page.goto(FAUCET_URL, { waitUntil: 'networkidle2', timeout: TIMEOUT });
  console.log('Page loaded. Waiting for init...');
  await sleep(5000);

  // Debug: check what the challenge looks like
  const debugInfo = await page.evaluate(async () => {
    // Check navigator.webdriver
    const wd = navigator.webdriver;
    // Check if Chrome object exists
    const hasChrome = !!window.chrome?.runtime;
    // Check automation flags
    const auto = document.documentElement.getAttribute('webdriver');
    return { webdriver: wd, hasChrome, automation: auto };
  });
  console.log('Browser state:', JSON.stringify(debugInfo));

  // Intercept requests to see x-is-human header
  await page.setRequestInterception(true);
  let lastXIsHuman = null;
  page.on('request', req => {
    if (req.url().includes('/api/faucet')) {
      lastXIsHuman = req.headers()['x-is-human'];
      console.log(`  [HDR] x-is-human: ${(lastXIsHuman || 'MISSING').slice(0, 150)}...`);
    }
    req.continue();
  });

  const results = [];

  for (let i = 0; i < allWallets.length; i++) {
    const w = allWallets[i];
    console.log(`\n--- [${i+1}/${allWallets.length}] ${w.name}: ${w.addr.slice(0,10)}... ---`);

    const resp = await page.evaluate(async (addr) => {
      try {
        const r = await fetch('/api/faucet/testnet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: addr, captchaToken: '' }),
        });
        const body = await r.text();
        return { status: r.status, body };
      } catch (e) {
        return { error: e.message };
      }
    }, w.addr);

    console.log(`  Response: ${resp.status || 'ERR'} | ${(resp.body || resp.error || '').slice(0, 200)}`);

    let parsed = {};
    try { parsed = JSON.parse(resp.body); } catch {}

    if (parsed.status === 'ok') {
      console.log(`  SUCCESS! tx: ${parsed.txHash || 'n/a'}`);
      results.push({ ...w, ok: true, detail: parsed });
    } else if (parsed.status === 'cooldown') {
      console.log(`  COOLDOWN — retryAt: ${parsed.retryAt || 'unknown'}`);
      results.push({ ...w, ok: false, detail: `cooldown ${parsed.retryAt || ''}` });
    } else if (resp.status === 403) {
      // Parse x-is-human to see the b value
      if (lastXIsHuman) {
        try {
          const xih = JSON.parse(lastXIsHuman);
          console.log(`  x-is-human b=${xih.b} v=${xih.v} d=${xih.d}`);
        } catch {}
      }
      results.push({ ...w, ok: false, detail: resp.body || resp.error });
    } else {
      results.push({ ...w, ok: false, detail: resp.body || resp.error });
    }

    // Only try first 2 wallets if fingerprint keeps failing
    if (i === 1 && results.every(r => !r.ok && String(r.detail).includes('captcha'))) {
      console.log('\n[!] First 2 wallets both got captcha error — fingerprint failing.');
      console.log('[!] Stopping early to avoid wasting time.');
      break;
    }

    if (i < allWallets.length - 1) await sleep(4000);
  }

  await browser.disconnect();
  chromeProc.kill('SIGTERM');

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  let ok = 0;
  for (const r of results) {
    const st = r.ok ? 'OK' : String(r.detail).slice(0, 60);
    if (r.ok) ok++;
    console.log(`  ${r.name.padEnd(18)} | ${r.addr.slice(0,10)}... | ${st}`);
  }
  console.log(`\nTotal: ${ok} success, ${results.length - ok} failed out of ${results.length}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
