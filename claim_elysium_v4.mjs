#!/usr/bin/env node
/**
 * Elysium Testnet Faucet Claimer v4
 * Strategy: Load faucet page, let Turnstile wrapper init,
 * then call the API directly from page context.
 * The page's fetch wrapper should handle Turnstile automatically.
 */
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'fs';

const FAUCET_URL = 'https://elysium.kinetiq.xyz/testnet-faucet';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const TIMEOUT = 60_000;

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
  console.log('ELYSIUM FAUCET v4 — direct API via page context');
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
      '--window-size=1280,720', '--disable-gpu',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete navigator.__proto__.webdriver;
  });

  console.log('Loading faucet page...');
  await page.goto(FAUCET_URL, { waitUntil: 'networkidle2', timeout: TIMEOUT });
  console.log('Page loaded. Waiting 5s for Turnstile wrapper to init...');
  await sleep(5000);

  // Check if Turnstile wrapper is present by checking if fetch was wrapped
  const fetchWrapped = await page.evaluate(() => {
    return typeof window.fetch.toString() !== 'function' ||
           window.fetch.toString().includes('native') === false;
  });
  console.log(`Fetch wrapped: ${fetchWrapped}`);

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
    } else {
      results.push({ ...w, ok: false, detail: resp.body || resp.error });
    }

    if (i < allWallets.length - 1) await sleep(3000);
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
