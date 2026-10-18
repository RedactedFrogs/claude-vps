#!/usr/bin/env node
/**
 * Elysium Testnet Faucet Claimer v5
 * Strategy: Headed Chrome + Xvfb + full stealth anti-detection.
 * The page's fetch wrapper adds x-is-human header from browser fingerprint.
 * If fingerprint passes (b!=0), no Turnstile needed.
 * If b==0, wrapper loads Turnstile — we wait for it to solve.
 */
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'fs';

const FAUCET_URL = 'https://elysium.kinetiq.xyz/testnet-faucet';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const TIMEOUT = 90_000;

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

async function main() {
  console.log('='.repeat(60));
  console.log('ELYSIUM FAUCET v5 — headed + stealth + x-is-human');
  console.log(new Date().toISOString());
  console.log('='.repeat(60));

  const allWallets = [...WALLETS, ...loadBotWallets(4)];
  console.log(`Wallets: ${allWallets.length}`);

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
      '--disable-gpu',
      '--lang=en-US,en',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--no-first-run',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  // Full stealth patches
  await page.evaluateOnNewDocument(() => {
    // Remove webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete navigator.__proto__.webdriver;

    // Chrome runtime
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
        arr.item = i => arr[i];
        arr.namedItem = n => arr.find(p => p.name === n);
        arr.refresh = () => {};
        return arr;
      },
    });

    // Languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'language', { get: () => 'en-US' });

    // Platform
    Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });

    // Hardware concurrency
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });

    // Device memory
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

    // Max touch points (not touch device)
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

    // Permissions
    const origQuery = window.Notification
      ? Notification.permission
      : 'default';
    const handler = {
      apply: function(target, self, args) {
        const perm = args[0]?.name;
        if (perm === 'notifications') {
          return Promise.resolve({ state: origQuery, onchange: null });
        }
        return Reflect.apply(target, self, args);
      },
    };
    if (navigator.permissions?.query) {
      navigator.permissions.query = new Proxy(navigator.permissions.query, handler);
    }

    // WebGL Vendor/Renderer
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, param);
    };
    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter2.call(this, param);
    };

    // Connection
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g', rtt: 50, downlink: 10, saveData: false,
        onchange: null, addEventListener: () => {}, removeEventListener: () => {},
      }),
    });

    // Iframe contentWindow check
    const elementDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get: function() {
        const w = elementDescriptor.get.call(this);
        if (!this.src || this.src === 'about:blank') return w;
        return w;
      },
    });
  });

  // Monitor network for debug
  page.on('response', async resp => {
    if (resp.url().includes('/api/faucet')) {
      try {
        const body = await resp.text();
        console.log(`  [API] ${resp.status()} ${body.slice(0, 200)}`);
      } catch {}
    }
  });

  console.log('Loading faucet page...');
  await page.goto(FAUCET_URL, { waitUntil: 'networkidle2', timeout: TIMEOUT });
  console.log('Page loaded. Waiting for wrapper init...');
  await sleep(5000);

  // Check challenge state
  const challengeInfo = await page.evaluate(async () => {
    // The wrapper should be active. Let's see what x-is-human looks like
    // by inspecting the fetch headers on a test request
    let capturedHeaders = null;
    const origFetch = window.fetch;
    // We can't easily inspect inside the wrapper, so let's just make the call
    // and check the response
    return { ready: true };
  });
  console.log('Challenge info:', JSON.stringify(challengeInfo));

  const results = [];

  for (let i = 0; i < allWallets.length; i++) {
    const w = allWallets[i];
    console.log(`\n--- [${i+1}/${allWallets.length}] ${w.name}: ${w.addr.slice(0,10)}... ---`);

    // Make the claim through the page's wrapped fetch
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
    } else if (resp.status === 403 && parsed.error === 'captcha') {
      console.log('  CAPTCHA BLOCKED — fingerprint failed, waiting for Turnstile...');

      // The wrapper might trigger Turnstile loading. Wait for it.
      let solved = false;
      for (let t = 0; t < 30; t++) {
        const tsState = await page.evaluate(() => {
          const iframe = document.querySelector('iframe[src*="challenges.cloudflare"]');
          const input = document.querySelector('input[name="cf-turnstile-response"]');
          return {
            hasIframe: !!iframe,
            hasInput: !!input,
            inputValue: input?.value?.length || 0,
          };
        });
        if (tsState.inputValue > 10) {
          console.log(`  Turnstile solved at ${t}s!`);
          solved = true;
          // Retry the claim
          const retry = await page.evaluate(async (addr) => {
            try {
              const r = await fetch('/api/faucet/testnet', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: addr, captchaToken: '' }),
              });
              return { status: r.status, body: await r.text() };
            } catch (e) { return { error: e.message }; }
          }, w.addr);
          console.log(`  Retry: ${retry.status || 'ERR'} | ${(retry.body || retry.error || '').slice(0, 200)}`);
          let rp = {};
          try { rp = JSON.parse(retry.body); } catch {}
          if (rp.status === 'ok') {
            results.push({ ...w, ok: true, detail: rp });
          } else {
            results.push({ ...w, ok: false, detail: retry.body || retry.error });
          }
          break;
        }
        if (tsState.hasIframe && t % 5 === 0) {
          console.log(`  Turnstile iframe found, waiting for solve... (${t}s)`);
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!solved) {
        console.log('  Turnstile not solved after 30s');
        results.push({ ...w, ok: false, detail: 'captcha_unsolved' });
      }
    } else {
      results.push({ ...w, ok: false, detail: resp.body || resp.error });
    }

    if (i < allWallets.length - 1) await sleep(4000);
  }

  await browser.close();

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
