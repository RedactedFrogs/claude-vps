#!/usr/bin/env node
/**
 * Elysium Testnet Faucet Claimer v3
 * - Uses headed Chrome + Xvfb (Turnstile solves better in headed mode)
 * - Intercepts /api/faucet POST to capture token, then replays for other wallets
 * - Falls back to direct API call if token capture works
 */
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'fs';

const FAUCET_URL = 'https://elysium.kinetiq.xyz/testnet-faucet';
const API_BASE = 'https://elysium.kinetiq.xyz/api/faucet/testnet';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const TIMEOUT = 60_000;
const DELAY_BETWEEN = 8000;

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function claimWithBrowser(walletAddr, walletName, idx) {
  console.log(`\n--- [${idx}] ${walletName}: ${walletAddr.slice(0,10)}... ---`);

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,720',
      '--disable-gpu',
    ],
  });

  let result = { status: 'unknown' };

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    // Anti-detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      delete navigator.__proto__.webdriver;
      window.chrome = { runtime: {}, loadTimes: () => {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    // Inject wallet mock - EIP-1193 compliant
    await page.evaluateOnNewDocument((addr) => {
      const provider = {
        isMetaMask: true,
        _metamask: { isUnlocked: () => Promise.resolve(true) },
        selectedAddress: addr,
        chainId: '0x185d9',
        networkVersion: '99801',
        isConnected: () => true,
        request: async ({ method, params }) => {
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [addr];
            case 'eth_chainId':
              return '0x185d9';
            case 'net_version':
              return '99801';
            case 'wallet_switchEthereumChain':
            case 'wallet_addEthereumChain':
              return null;
            case 'personal_sign':
              return '0x' + 'ab'.repeat(65);
            case 'eth_getBalance':
              return '0x0';
            case 'eth_blockNumber':
              return '0x1';
            default:
              return null;
          }
        },
        on: (event, cb) => {
          if (event === 'connect') setTimeout(() => cb({ chainId: '0x185d9' }), 100);
        },
        removeListener: () => {},
        removeAllListeners: () => {},
        emit: () => {},
      };
      // Set up EIP-6963
      window.ethereum = provider;
      // Also announce via EIP-6963
      window.addEventListener('eip6963:requestProvider', () => {
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
          detail: Object.freeze({
            info: { uuid: 'mock-mm', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' },
            provider,
          }),
        }));
      });
    }, walletAddr);

    // Intercept API calls to capture faucet response
    let faucetResponse = null;
    await page.setRequestInterception(true);
    page.on('request', req => {
      req.continue();
    });
    page.on('response', async resp => {
      if (resp.url().includes('/api/faucet/')) {
        try {
          const body = await resp.text();
          faucetResponse = { status: resp.status(), body };
          console.log(`  [API] ${resp.status()} ${body.slice(0, 200)}`);
        } catch {}
      }
    });

    console.log(`  Loading faucet page...`);
    await page.goto(FAUCET_URL, { waitUntil: 'networkidle2', timeout: TIMEOUT });

    // Click Connect button
    const connectClicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const cb = btns.find(b => {
        const t = b.textContent.trim().toLowerCase();
        return t === 'connect' || t === 'connect wallet';
      });
      if (cb) { cb.click(); return true; }
      return false;
    });
    console.log(`  Connect clicked: ${connectClicked}`);
    await sleep(2000);

    // Look for MetaMask / Browser Wallet option in the connector modal
    const walletSelected = await page.evaluate(() => {
      // Try various selectors for wallet connector modals (RainbowKit, Web3Modal, etc.)
      const selectors = [
        'button', 'div[role="button"]', 'li', '[data-testid*="wallet"]',
        '[class*="wallet"]', '[class*="connector"]',
      ];
      for (const sel of selectors) {
        const els = [...document.querySelectorAll(sel)];
        const mm = els.find(el => {
          const t = (el.textContent || '').toLowerCase();
          return t.includes('metamask') || t.includes('injected') || t.includes('browser wallet');
        });
        if (mm) {
          mm.click();
          return mm.textContent.trim().slice(0, 40);
        }
      }
      return null;
    });
    if (walletSelected) {
      console.log(`  Wallet option selected: ${walletSelected}`);
    } else {
      console.log(`  No MetaMask option found in modal`);
    }
    await sleep(3000);

    // Check if wallet connected (page should change)
    const pageState = await page.evaluate(() => {
      const text = document.body.innerText;
      const hasGetBtn = [...document.querySelectorAll('button')].some(b => {
        const t = b.textContent.toLowerCase().trim();
        return t === 'get' || t.includes('claim') || t.includes('request') || t === 'get tokens';
      });
      const hasTurnstile = !!document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare"]');
      const connected = text.includes('0x') || hasGetBtn;
      return { hasGetBtn, hasTurnstile, connected, text: text.slice(0, 400) };
    });
    console.log(`  Connected: ${pageState.connected} | Get btn: ${pageState.hasGetBtn} | Turnstile: ${pageState.hasTurnstile}`);

    if (pageState.hasTurnstile) {
      console.log(`  Waiting for Turnstile to solve (max 45s)...`);
      for (let t = 0; t < 45; t++) {
        const token = await page.evaluate(() => {
          const inp = document.querySelector('input[name="cf-turnstile-response"]');
          return inp?.value || '';
        });
        if (token.length > 10) {
          console.log(`  Turnstile solved at ${t}s`);
          break;
        }
        if (t === 44) console.log(`  Turnstile NOT solved after 45s`);
        await sleep(1000);
      }
    }

    // Try clicking the Get/Claim button
    if (pageState.hasGetBtn) {
      const clicked = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const cb = btns.find(b => {
          const t = b.textContent.toLowerCase().trim();
          return t === 'get' || t.includes('claim') || t.includes('request') || t === 'get tokens';
        });
        if (cb && !cb.disabled) { cb.click(); return `Clicked: "${cb.textContent.trim()}"`; }
        if (cb && cb.disabled) return `Disabled: "${cb.textContent.trim()}"`;
        return 'Not found';
      });
      console.log(`  ${clicked}`);
      await sleep(10000);
    }

    // If wallet didn't connect, try direct API approach with page's cookies/session
    if (!pageState.connected && !pageState.hasGetBtn) {
      console.log(`  Wallet not connected. Trying direct API within browser context...`);

      // Get Turnstile token from the page if available
      const turnstileToken = await page.evaluate(() => {
        const inp = document.querySelector('input[name="cf-turnstile-response"]');
        return inp?.value || '';
      });

      if (turnstileToken) {
        console.log(`  Found Turnstile token, calling API directly...`);
        const apiResult = await page.evaluate(async (addr, token) => {
          try {
            const r = await fetch('/api/faucet/testnet', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ address: addr, captchaToken: token }),
            });
            return { status: r.status, body: await r.text() };
          } catch (e) {
            return { error: e.message };
          }
        }, walletAddr, turnstileToken);
        console.log(`  API result: ${JSON.stringify(apiResult)}`);
        faucetResponse = apiResult;
      }
    }

    // Check final result
    if (faucetResponse) {
      const body = typeof faucetResponse.body === 'string' ? faucetResponse.body : JSON.stringify(faucetResponse);
      if (body.includes('"ok"') || body.includes('success')) {
        result = { status: 'ok', detail: body.slice(0, 200) };
      } else {
        result = { status: 'failed', detail: body.slice(0, 200) };
      }
    } else {
      const finalText = await page.evaluate(() => document.body.innerText.slice(0, 500));
      if (finalText.includes('success') || finalText.includes('sent') || finalText.includes('claimed')) {
        result = { status: 'ok', detail: finalText.slice(0, 200) };
      } else {
        result = { status: 'no_response', detail: finalText.slice(0, 200) };
      }
    }

    console.log(`  Result: ${result.status}`);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    result = { status: 'error', detail: e.message };
  } finally {
    await browser.close().catch(() => {});
  }

  return result;
}

async function main() {
  console.log('='.repeat(60));
  console.log('ELYSIUM TESTNET FAUCET CLAIMER v3 (Xvfb headed)');
  console.log('='.repeat(60));

  const allWallets = [...WALLETS, ...loadBotWallets(4)];
  console.log(`Total wallets: ${allWallets.length}`);
  console.log(`Chrome: ${CHROME}`);
  console.log(`Display: ${process.env.DISPLAY || 'none'}\n`);

  const results = [];
  for (let i = 0; i < allWallets.length; i++) {
    const w = allWallets[i];
    const r = await claimWithBrowser(w.addr, w.name, i + 1);
    results.push({ ...w, result: r });
    if (i < allWallets.length - 1) {
      console.log(`  Waiting ${DELAY_BETWEEN / 1000}s...`);
      await sleep(DELAY_BETWEEN);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  let ok = 0, fail = 0;
  for (const r of results) {
    const status = r.result.status === 'ok' ? 'OK' : r.result.detail?.slice(0, 60) || r.result.status;
    if (r.result.status === 'ok') ok++; else fail++;
    console.log(`  ${r.name.padEnd(18)} | ${r.addr.slice(0,10)}... | ${status}`);
  }
  console.log(`\nTotal: ${ok} success, ${fail} failed out of ${results.length}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
