#!/usr/bin/env node
/**
 * Elysium Testnet Faucet Claimer v2
 * - Proxy rotation (1 proxy per wallet)
 * - Separate browser per wallet (fresh Turnstile each time)
 * - Auto-discovery of API endpoint
 *
 * Usage:
 *   node claim_elysium_v2.mjs                    # claim all wallets
 *   node claim_elysium_v2.mjs --discover-only     # just discover API
 *   node claim_elysium_v2.mjs --proxy-file /path  # custom proxy file
 *
 * Proxy file: one per line, format host:port or host:port:user:pass
 * Default: /home/boss/proxies.txt
 */
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync } from 'fs';

const FAUCET_URL = 'https://elysium.kinetiq.xyz/testnet-faucet';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const TIMEOUT = 90_000;
const DELAY_BETWEEN = 5000;

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
    const data = JSON.parse(raw);
    return data.slice(0, n).map((w, i) => ({
      name: `bot_${i}`,
      addr: w.address || w.wallet || w.addr,
    })).filter(w => w.addr);
  } catch (e) {
    console.log(`  [!] Bot wallets: ${e.message}`);
    return [];
  }
}

function loadProxies(filePath) {
  try {
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    return lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch (e) {
    console.log(`  [!] Proxy file ${filePath}: ${e.message}`);
    return [];
  }
}

function parseProxy(proxy) {
  // Formats: host:port | host:port:user:pass | http://user:pass@host:port
  if (proxy.startsWith('http')) {
    return { server: proxy };
  }
  const parts = proxy.split(':');
  if (parts.length === 4) {
    return {
      server: `http://${parts[0]}:${parts[1]}`,
      user: parts[2],
      pass: parts[3],
    };
  }
  if (parts.length === 2) {
    return { server: `http://${parts[0]}:${parts[1]}` };
  }
  return { server: proxy };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function discover(page) {
  console.log('\n[PHASE 1] Discovering faucet page...');
  const apiCalls = [];

  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    const method = req.method();
    if (method === 'POST' || url.includes('faucet') || url.includes('drip') || url.includes('claim')) {
      apiCalls.push({ url, method, postData: req.postData() });
    }
    req.continue();
  });

  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('faucet') || url.includes('drip') || url.includes('claim') || url.includes('/api/')) {
      try {
        const body = await resp.text();
        apiCalls.push({ url, status: resp.status(), body: body.slice(0, 500) });
      } catch {}
    }
  });

  console.log('  Loading faucet page...');
  await page.goto(FAUCET_URL, { waitUntil: 'networkidle2', timeout: TIMEOUT });

  const info = await page.evaluate(() => {
    const hasTurnstile = !!document.querySelector('[class*="turnstile"], iframe[src*="challenges.cloudflare"], .cf-turnstile');
    const inputs = document.querySelectorAll('input[type="text"], input[placeholder*="0x"], input[placeholder*="wallet"], input[placeholder*="address"]');
    const btns = [...document.querySelectorAll('button')];
    const claimBtns = btns.map(b => b.textContent.trim()).filter(t => t.toLowerCase().includes('get') || t.toLowerCase().includes('claim'));
    const connectBtns = btns.map(b => b.textContent.trim()).filter(t => t.toLowerCase().includes('connect') || t.toLowerCase().includes('wallet'));
    return {
      hasTurnstile,
      inputCount: inputs.length,
      claimBtns,
      connectBtns,
      pageText: document.body.innerText.slice(0, 1000),
    };
  });

  console.log(`  Turnstile: ${info.hasTurnstile}`);
  console.log(`  Input fields: ${info.inputCount}`);
  console.log(`  Claim buttons: ${JSON.stringify(info.claimBtns)}`);
  console.log(`  Connect buttons: ${JSON.stringify(info.connectBtns)}`);
  console.log(`  Page text: ${info.pageText.slice(0, 300)}`);

  if (apiCalls.length) {
    console.log(`\n  Intercepted API calls:`);
    apiCalls.forEach(c => console.log(`    ${c.method || 'RESP'} ${c.url} ${c.status || ''}`));
  }

  // Search HTML and JS bundles for endpoints
  const html = await page.content();
  const apis = [...new Set(html.match(/["']\/api\/[^"']+["']/g) || [])];
  const jsUrls = [...new Set(html.match(/src="(\/_next\/static\/[^"]+\.js)"/g) || [])];
  console.log(`  API refs in HTML: ${JSON.stringify(apis.slice(0, 10))}`);
  console.log(`  JS bundles: ${jsUrls.length}`);

  for (const match of jsUrls.slice(0, 15)) {
    const src = match.replace('src="', '').replace('"', '');
    try {
      const jsText = await page.evaluate(async (url) => {
        const r = await fetch(url);
        return r.text();
      }, src);
      const found = [
        ...new Set([
          ...(jsText.match(/["']\/api\/[^"']{2,60}["']/g) || []),
          ...(jsText.match(/fetch\(["'][^"']+["']/g) || []).filter(f => f.includes('/api/')),
          ...(jsText.match(/turnstile|cf-turnstile/gi) ? ['(turnstile)'] : []),
          ...(jsText.match(/method:\s*["']POST["']/g) ? ['(POST)'] : []),
        ])
      ];
      if (found.length) {
        console.log(`    ${src.slice(-40)}: ${JSON.stringify(found.slice(0, 5))}`);
      }
    } catch {}
  }

  await page.setRequestInterception(false);
  return { apiCalls, info };
}

async function claimWallet(walletAddr, walletName, proxy, idx) {
  const proxyInfo = proxy ? parseProxy(proxy) : null;
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,720',
  ];
  if (proxyInfo) {
    args.push(`--proxy-server=${proxyInfo.server}`);
  }

  console.log(`\n--- [${idx}] ${walletName} | proxy: ${proxy || 'NONE'} ---`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME,
    args,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Proxy auth if needed
    if (proxyInfo?.user) {
      await page.authenticate({ username: proxyInfo.user, password: proxyInfo.pass });
    }

    // Inject wallet mock before page load
    await page.evaluateOnNewDocument((addr) => {
      window.ethereum = {
        isMetaMask: true,
        selectedAddress: addr,
        chainId: '0x185d9',
        networkVersion: '99801',
        request: async ({ method }) => {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
          if (method === 'eth_chainId') return '0x185d9';
          if (method === 'net_version') return '99801';
          if (method === 'wallet_switchEthereumChain') return null;
          if (method === 'wallet_addEthereumChain') return null;
          if (method === 'personal_sign') return '0x' + '00'.repeat(65);
          return null;
        },
        on: () => {},
        removeListener: () => {},
        isConnected: () => true,
      };
    }, walletAddr);

    console.log(`  Loading faucet...`);
    await page.goto(FAUCET_URL, { waitUntil: 'networkidle2', timeout: TIMEOUT });

    // Click Connect Wallet if available
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const cb = btns.find(b => {
        const t = b.textContent.toLowerCase().trim();
        return t.includes('connect') || t === 'connect wallet';
      });
      if (cb) { cb.click(); return true; }
      return false;
    });
    if (clicked) {
      console.log(`  Clicked Connect Wallet`);
      await sleep(3000);

      // Look for MetaMask / injected option in modal
      const walletClicked = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button, div[role="button"], li')];
        const mm = btns.find(b => {
          const t = (b.textContent || '').toLowerCase();
          return t.includes('metamask') || t.includes('injected') || t.includes('browser');
        });
        if (mm) { mm.click(); return mm.textContent.trim(); }
        return null;
      });
      if (walletClicked) {
        console.log(`  Selected wallet: ${walletClicked}`);
        await sleep(3000);
      }
    }

    // Try to fill address input if there's one
    const filled = await page.evaluate((addr) => {
      const inputs = document.querySelectorAll('input');
      for (const inp of inputs) {
        const ph = (inp.placeholder || '').toLowerCase();
        const nm = (inp.name || '').toLowerCase();
        if (ph.includes('0x') || ph.includes('address') || ph.includes('wallet') || nm.includes('address')) {
          inp.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(inp, addr);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      for (const inp of inputs) {
        if (inp.type === 'text' && inp.offsetParent !== null) {
          inp.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(inp, addr);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, walletAddr);
    console.log(`  Address filled: ${filled}`);

    // Wait for Turnstile to auto-solve
    console.log(`  Waiting for Turnstile (max 30s)...`);
    let turnstileOk = false;
    for (let t = 0; t < 30; t++) {
      const token = await page.evaluate(() => {
        const inp = document.querySelector('input[name="cf-turnstile-response"]');
        return inp?.value || '';
      });
      if (token.length > 10) {
        turnstileOk = true;
        console.log(`  Turnstile solved (${t}s)`);
        break;
      }
      await sleep(1000);
    }
    if (!turnstileOk) {
      console.log(`  Turnstile NOT solved after 30s`);
    }

    // Click claim/get button
    const claimResult = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const cb = btns.find(b => {
        const t = b.textContent.toLowerCase().trim();
        return t === 'get' || t.includes('claim') || t.includes('request') || t.includes('drip') || t === 'get tokens';
      });
      if (cb && !cb.disabled) {
        cb.click();
        return `Clicked: "${cb.textContent.trim()}"`;
      }
      if (cb && cb.disabled) {
        return `Button disabled: "${cb.textContent.trim()}"`;
      }
      return `No claim button. All buttons: ${btns.map(b=>b.textContent.trim().slice(0,30)).join(' | ')}`;
    });
    console.log(`  ${claimResult}`);

    // Wait for response
    await sleep(8000);

    // Check result
    const result = await page.evaluate(() => {
      const text = document.body.innerText;
      const success = /success|sent|claimed|received|transaction/i.test(text);
      const error = text.match(/(error|failed|automated|rate.?limit|cooldown|already.?claimed|try.?again|too.?many)[^\n]{0,150}/i);
      const txHash = text.match(/0x[a-fA-F0-9]{64}/);
      return {
        success,
        error: error?.[0] || null,
        txHash: txHash?.[0] || null,
        snippet: text.slice(0, 600),
      };
    });

    if (result.success) {
      console.log(`  SUCCESS! ${result.txHash ? 'tx: ' + result.txHash : ''}`);
    } else if (result.error) {
      console.log(`  ERROR: ${result.error}`);
    } else {
      console.log(`  Status unclear. Page text: ${result.snippet.slice(0, 300)}`);
    }

    return result;
  } catch (e) {
    console.log(`  EXCEPTION: ${e.message}`);
    return { error: e.message };
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('ELYSIUM TESTNET FAUCET CLAIMER v2 (with proxy)');
  console.log('='.repeat(60));

  // Parse args
  const discoverOnly = process.argv.includes('--discover-only');
  let proxyFile = '/home/boss/proxies.txt';
  const pfIdx = process.argv.indexOf('--proxy-file');
  if (pfIdx !== -1 && process.argv[pfIdx + 1]) {
    proxyFile = process.argv[pfIdx + 1];
  }

  // Load proxies
  const proxies = loadProxies(proxyFile);
  console.log(`Proxies loaded: ${proxies.length} from ${proxyFile}`);
  if (proxies.length === 0) {
    console.log('[!] No proxies found! Create /home/boss/proxies.txt with one proxy per line');
    console.log('    Format: host:port or host:port:user:pass');
    if (!discoverOnly) {
      console.log('[!] Continuing without proxies (not recommended)...');
    }
  }

  // Load wallets
  const allWallets = [...WALLETS, ...loadBotWallets(4)];
  console.log(`Total wallets: ${allWallets.length}`);

  if (discoverOnly) {
    // Discovery mode - use first proxy or no proxy
    const proxy = proxies[0] ? parseProxy(proxies[0]) : null;
    const args = [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ];
    if (proxy) args.push(`--proxy-server=${proxy.server}`);

    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: CHROME,
      args,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    if (proxy?.user) await page.authenticate({ username: proxy.user, password: proxy.pass });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    await discover(page);
    await browser.close();
    console.log('\n[*] Discovery complete.');
    return;
  }

  // Phase 2: Claim
  console.log('\n[PHASE 2] Claiming faucet for each wallet...');
  console.log('-'.repeat(60));

  const results = [];
  for (let i = 0; i < allWallets.length; i++) {
    const w = allWallets[i];
    const proxy = proxies[i % proxies.length] || null;
    const r = await claimWallet(w.addr, w.name, proxy, i + 1);
    results.push({ ...w, proxy, result: r });
    if (i < allWallets.length - 1) {
      console.log(`  Waiting ${DELAY_BETWEEN / 1000}s before next...`);
      await sleep(DELAY_BETWEEN);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  let ok = 0, fail = 0;
  for (const r of results) {
    const status = r.result?.success ? 'OK' : (r.result?.error?.slice(0, 60) || '???');
    if (r.result?.success) ok++; else fail++;
    console.log(`  ${r.name.padEnd(18)} | ${r.addr.slice(0,10)}... | ${status}`);
  }
  console.log(`\nTotal: ${ok} success, ${fail} failed out of ${results.length}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
