#!/usr/bin/env node
/**
 * Elysium Testnet Faucet Claimer
 *
 * Phase 1: Discovery - fetch page, find API endpoint + Turnstile
 * Phase 2: Claim via headless Chrome (Turnstile auto-solves in real browser)
 *
 * Usage: node claim_elysium.mjs [--discover-only]
 *
 * Requires: puppeteer (npm i puppeteer-core)
 */
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'fs';
import https from 'https';

const FAUCET_URL = 'https://elysium.kinetiq.xyz/testnet-faucet';
const CHROME = '/usr/bin/google-chrome';
const TIMEOUT = 60_000;

// 9 wallets (main already claimed)
const WALLETS = [
  { name: 'validator',       addr: '0x9C98Cc106b01C0B9dAEA980aa36a5d731587bDa8' },
  { name: 'mallardordinals', addr: '0xdaDfc6D1774C8AcE5B2f48C8Cba17c9660ad148D' },
  { name: 'bossventure168',  addr: '0x50fAbeA8992A740b4b271b7FF7ED0B6074f970a1' },
  { name: 'gryfindor_bot',   addr: '0xE1C436e928131B6D6E3E3DdF6BF34dc2A223BD6b' },
  { name: 'hendrawanipiro',  addr: '0xAE0284d37038A9F5D4279DFF591D9B9368dE0815' },
];

// Load bot wallets
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

// Phase 1: Discover API endpoint
async function discover(page) {
  console.log('\n[PHASE 1] Discovering API endpoint...');

  const apiCalls = [];

  // Intercept network requests
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

  // Check for Turnstile
  const hasTurnstile = await page.evaluate(() => {
    return !!document.querySelector('[class*="turnstile"], iframe[src*="challenges.cloudflare"], .cf-turnstile');
  });
  console.log(`  Turnstile on page: ${hasTurnstile}`);

  // Check for wallet input field
  const hasInput = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[type="text"], input[placeholder*="0x"], input[placeholder*="wallet"], input[placeholder*="address"]');
    return inputs.length;
  });
  console.log(`  Address input fields: ${hasInput}`);

  // Check for "Get" button
  const hasGetBtn = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    return btns.map(b => b.textContent.trim()).filter(t => t.toLowerCase().includes('get') || t.toLowerCase().includes('claim'));
  });
  console.log(`  Claim buttons: ${JSON.stringify(hasGetBtn)}`);

  // Check page text
  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
  console.log(`  Page text (first 500): ${pageText.slice(0, 500)}`);

  // Check for connect wallet button
  const connectBtn = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    return btns.map(b => b.textContent.trim()).filter(t =>
      t.toLowerCase().includes('connect') || t.toLowerCase().includes('wallet'));
  });
  console.log(`  Connect buttons: ${JSON.stringify(connectBtn)}`);

  // Print all intercepted API calls
  if (apiCalls.length) {
    console.log(`\n  Intercepted API calls:`);
    apiCalls.forEach(c => console.log(`    ${c.method || 'RESP'} ${c.url} ${c.status || ''}`));
  }

  // Dump page source for analysis
  const html = await page.content();

  // Find API endpoints in HTML
  const apis = html.match(/["']\/api\/[^"']+["']/g) || [];
  const fetches = html.match(/fetch\(["'][^"']+["']/g) || [];
  const turnstileRefs = html.match(/turnstile|cf-turnstile|challenges\.cloudflare/gi) || [];

  console.log(`\n  API refs in HTML: ${JSON.stringify([...new Set(apis)].slice(0, 10))}`);
  console.log(`  Fetch calls in HTML: ${JSON.stringify([...new Set(fetches)].slice(0, 10))}`);
  console.log(`  Turnstile refs: ${turnstileRefs.length}`);

  // Search JS bundles
  const jsUrls = [...new Set(html.match(/src="(\/_next\/static\/[^"]+\.js)"/g) || [])];
  console.log(`  JS bundles: ${jsUrls.length}`);

  for (const match of jsUrls.slice(0, 20)) {
    const src = match.replace('src="', '').replace('"', '');
    try {
      const jsResp = await page.evaluate(async (url) => {
        const r = await fetch(url);
        return r.text();
      }, src);

      const jsApis = jsResp.match(/["']\/api\/[^"']{2,60}["']/g) || [];
      const jsFetches = jsResp.match(/fetch\(["'][^"']+["']/g) || [];
      const jsTurnstile = jsResp.match(/turnstile|cf-turnstile/gi) || [];
      const jsPosts = jsResp.match(/method:\s*["']POST["']/g) || [];

      const found = [...jsApis, ...jsFetches.filter(f => f.includes('/api/')),
                     ...(jsTurnstile.length ? ['(turnstile)'] : []),
                     ...(jsPosts.length ? ['(POST)'] : [])];
      if (found.length) {
        console.log(`    ${src.slice(-40)}: ${JSON.stringify([...new Set(found)].slice(0, 5))}`);
      }
    } catch {}
  }

  await page.setRequestInterception(false);
  return { apiCalls, hasTurnstile, html };
}

// Phase 2: Claim for one wallet
async function claimWallet(browser, walletAddr, walletName, proxyIdx) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  try {
    console.log(`\n  [${walletName}] Loading faucet...`);
    await page.goto(FAUCET_URL, { waitUntil: 'networkidle2', timeout: TIMEOUT });

    // Inject wallet address via window.ethereum mock
    await page.evaluate((addr) => {
      window.ethereum = {
        isMetaMask: true,
        selectedAddress: addr,
        chainId: '0x185d9',
        networkVersion: '99801',
        request: async ({ method, params }) => {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
          if (method === 'eth_chainId') return '0x185d9';
          if (method === 'net_version') return '99801';
          if (method === 'wallet_switchEthereumChain') return null;
          if (method === 'wallet_addEthereumChain') return null;
          if (method === 'personal_sign') return '0x' + '00'.repeat(65);
          console.log('ethereum.request:', method, params);
          return null;
        },
        on: () => {},
        removeListener: () => {},
        isConnected: () => true,
      };
    }, walletAddr);

    // Look for Connect button and click it
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const connectBtn = btns.find(b => {
        const t = b.textContent.toLowerCase().trim();
        return t.includes('connect') || t === 'connect wallet' || t === 'connect';
      });
      if (connectBtn) { connectBtn.click(); return true; }
      return false;
    });
    if (clicked) {
      console.log(`  [${walletName}] Clicked Connect`);
      await new Promise(r => setTimeout(r, 3000));
    }

    // Try to find and fill address input
    const filled = await page.evaluate((addr) => {
      const inputs = document.querySelectorAll('input');
      for (const inp of inputs) {
        const ph = (inp.placeholder || '').toLowerCase();
        const nm = (inp.name || '').toLowerCase();
        if (ph.includes('0x') || ph.includes('address') || ph.includes('wallet') || nm.includes('address') || nm.includes('wallet')) {
          inp.focus();
          inp.value = addr;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      // Try any visible text input
      for (const inp of inputs) {
        if (inp.type === 'text' && inp.offsetParent !== null) {
          inp.focus();
          inp.value = addr;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, walletAddr);
    console.log(`  [${walletName}] Address filled: ${filled}`);

    // Wait for Turnstile to solve (if present)
    console.log(`  [${walletName}] Waiting for Turnstile...`);
    await new Promise(r => setTimeout(r, 5000));

    // Check Turnstile status
    const tsStatus = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[src*="challenges.cloudflare"]');
      const input = document.querySelector('input[name="cf-turnstile-response"]');
      return {
        hasIframe: !!iframe,
        hasInput: !!input,
        token: input?.value?.slice(0, 20) || '',
      };
    });
    console.log(`  [${walletName}] Turnstile: iframe=${tsStatus.hasIframe} token=${tsStatus.token ? 'YES' : 'NO'}`);

    // Click Get/Claim button
    const claimResult = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const claimBtn = btns.find(b => {
        const t = b.textContent.toLowerCase().trim();
        return t === 'get' || t.includes('claim') || t.includes('request') || t.includes('drip');
      });
      if (claimBtn) {
        claimBtn.click();
        return `Clicked: "${claimBtn.textContent.trim()}"`;
      }
      return `No claim button found. Buttons: ${btns.map(b=>b.textContent.trim()).join(', ')}`;
    });
    console.log(`  [${walletName}] ${claimResult}`);

    // Wait for response
    await new Promise(r => setTimeout(r, 5000));

    // Check for success/error messages
    const result = await page.evaluate(() => {
      const text = document.body.innerText;
      const success = text.includes('success') || text.includes('sent') || text.includes('claimed');
      const error = text.match(/(error|failed|automated|rate.?limit|cooldown|already.?claimed)[^\n]{0,100}/i);
      return { success, error: error?.[0] || null, snippet: text.slice(0, 500) };
    });

    if (result.success) {
      console.log(`  [${walletName}] SUCCESS!`);
    } else if (result.error) {
      console.log(`  [${walletName}] ERROR: ${result.error}`);
    } else {
      console.log(`  [${walletName}] Status unclear. Page: ${result.snippet.slice(0, 200)}`);
    }

    return result;
  } catch (e) {
    console.log(`  [${walletName}] EXCEPTION: ${e.message}`);
    return { error: e.message };
  } finally {
    await page.close();
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('ELYSIUM TESTNET FAUCET CLAIMER');
  console.log('='.repeat(50));

  const allWallets = [...WALLETS, ...loadBotWallets(4)];
  console.log(`Total wallets: ${allWallets.length}`);

  const discoverOnly = process.argv.includes('--discover-only');

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,720',
    ],
  });

  try {
    // Phase 1: Discovery
    const discPage = await browser.newPage();
    await discPage.setViewport({ width: 1280, height: 720 });
    await discPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await discPage.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const discovery = await discover(discPage);
    await discPage.close();

    if (discoverOnly) {
      console.log('\n[*] Discovery complete (--discover-only). Exiting.');
      return;
    }

    // Phase 2: Claim each wallet
    console.log('\n[PHASE 2] Claiming faucet for each wallet...');
    console.log('-'.repeat(50));

    const results = [];
    for (let i = 0; i < allWallets.length; i++) {
      const w = allWallets[i];
      console.log(`\n--- [${i + 1}/${allWallets.length}] ${w.name} ---`);
      const r = await claimWallet(browser, w.addr, w.name, i);
      results.push({ ...w, result: r });
      await new Promise(r => setTimeout(r, 2000));
    }

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('SUMMARY');
    console.log('='.repeat(50));
    for (const r of results) {
      const status = r.result?.success ? 'OK' : (r.result?.error || '???');
      console.log(`  ${r.name.padEnd(20)} | ${r.addr} | ${status}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
