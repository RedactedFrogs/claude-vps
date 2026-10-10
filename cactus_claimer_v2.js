#!/usr/bin/env node
'use strict';

const { spawn, execSync } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');

const WALLETS = process.argv.slice(2);
if (!WALLETS.length) {
  console.error('Usage: node cactus_claimer.js <solana_wallet1> [wallet2] ...');
  process.exit(1);
}

const CDP_PORT = 9334;
const POLL_MS  = 25_000;
const GAME_MS  = 38_000;
const MAX_LOG  = 2 * 1024 * 1024;
const LOG_FILE = '/home/boss/cactus_claimer.log';
const STATUS_FILE = '/home/boss/cactus_claimer_status.json';
const TURNSTILE_SITEKEY = '0x4AAAAAAFNblsMOxNKk_AyH';

function log(msg) {
  const ts = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG) {
      const old = fs.readFileSync(LOG_FILE, 'utf8');
      fs.writeFileSync(LOG_FILE, old.slice(-MAX_LOG / 2));
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

function saveStatus(obj) {
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2)); } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}

async function checkSpots() {
  return httpGet('https://cactusexe.cc/api/spots');
}

let _cdpId = 0;

function cdpSend(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++_cdpId;
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`CDP timeout: ${method}`));
    }, 30_000);
    function handler(ev) {
      const msg = JSON.parse(typeof ev === 'string' ? ev : ev.data);
      if (msg.id === id) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    }
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function cdpEval(ws, expr, awaitPromise = false) {
  const res = await cdpSend(ws, 'Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise,
    timeout: 60_000,
  });
  if (res.exceptionDetails) throw new Error('Eval: ' + JSON.stringify(res.exceptionDetails.text || res.exceptionDetails));
  return res.result?.value ?? null;
}

async function connectCDP(port, retries = 8) {
  for (let i = 0; i < retries; i++) {
    try {
      const targets = await httpGet(`http://127.0.0.1:${port}/json/list`);
      const page = Array.isArray(targets) && targets.find(t => t.type === 'page');
      const wsUrl = page?.webSocketDebuggerUrl;
      if (!wsUrl) throw new Error('No page target found');
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.addEventListener('open', () => resolve(ws));
        ws.addEventListener('error', e => reject(new Error('WS error')));
        setTimeout(() => reject(new Error('WS connect timeout')), 8000);
      });
    } catch {
      await sleep(1500);
    }
  }
  throw new Error('Cannot connect CDP after retries');
}

const TURNSTILE_HOOK = `
(function() {
  window.__cactusToken = null;
  window.__cactusTokenTime = 0;
  window.__tsDebug = [];

  var _check = setInterval(function() {
    if (window.turnstile && typeof window.turnstile.render === 'function' && !window.turnstile.__cPatched) {
      window.turnstile.__cPatched = true;
      window.__tsDebug.push('patched_at_' + Date.now());
      var origRender = window.turnstile.render;
      window.turnstile.render = function(el, opts) {
        window.__tsDebug.push('render_called_' + Date.now());
        var newOpts = Object.assign({}, opts || {});
        var origCb = newOpts.callback;
        newOpts.callback = function(token) {
          window.__cactusToken = token;
          window.__cactusTokenTime = Date.now();
          window.__tsDebug.push('token_received_' + Date.now());
          if (origCb) origCb(token);
        };
        return origRender.call(window.turnstile, el, newOpts);
      };
      clearInterval(_check);
    }
  }, 10);
})();
`;

async function claimForWallet(wallet) {
  const tmpDir = `/tmp/cactus-chrome-${Date.now()}`;
  let chrome, xvfb;

  try {
    try { execSync('pkill -f "remote-debugging-port=9334" 2>/dev/null'); } catch {}
    try { execSync('pkill -f "Xvfb :99" 2>/dev/null'); } catch {}
    await sleep(1000);

    const display = ':99';
    xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], {
      stdio: 'ignore',
    });
    await sleep(1000);

    chrome = spawn('google-chrome', [
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${tmpDir}`,
      '--window-size=1280,720', '--no-first-run', '--disable-extensions',
      '--disable-background-networking', '--disable-default-apps',
      'about:blank',
    ], {
      stdio: 'ignore',
      env: { ...process.env, DISPLAY: display },
    });
    await sleep(3000);

    const ws = await connectCDP(CDP_PORT);
    await cdpSend(ws, 'Page.enable');
    await cdpSend(ws, 'Runtime.enable');

    await cdpSend(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: TURNSTILE_HOOK });

    await cdpSend(ws, 'Network.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.8037.57 Safari/537.36',
    });

    log('  Opening game page...');
    await cdpSend(ws, 'Page.navigate', { url: 'https://cactusexe.cc/play' });
    await sleep(6000);

    log('  Waiting for Turnstile solve...');
    let token = null;
    let manualRenderDone = false;

    for (let i = 0; i < 45; i++) {
      token = await cdpEval(ws, 'window.__cactusToken');
      if (token) break;

      token = await cdpEval(ws, `
        (function(){
          var inp = document.querySelector('input[name="cf-turnstile-response"]');
          return inp && inp.value ? inp.value : null;
        })()
      `);
      if (token) break;

      if (i === 5) {
        const tState = await cdpEval(ws, `JSON.stringify({
          ts: typeof window.turnstile, patched: !!window.turnstile?.__cPatched,
          iframes: document.querySelectorAll('iframe').length,
          debug: window.__tsDebug?.join(',') || 'none'
        })`);
        log('  State@10s: ' + tState);
      }

      if (i === 8 && !manualRenderDone) {
        log('  No auto-render detected, triggering manual Turnstile render...');
        manualRenderDone = true;
        const renderResult = await cdpEval(ws, `
          (function() {
            if (typeof window.turnstile !== 'object' || typeof window.turnstile.render !== 'function') {
              return 'turnstile_not_ready';
            }
            var container = document.querySelector('[id*="turnstile"]');
            if (!container) {
              container = document.createElement('div');
              container.id = 'manual-turnstile';
              container.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:99999';
              document.body.appendChild(container);
            }
            try {
              var widgetId = window.turnstile.render(container, {
                sitekey: '${TURNSTILE_SITEKEY}',
                callback: function(token) {
                  window.__cactusToken = token;
                  window.__cactusTokenTime = Date.now();
                  window.__tsDebug.push('manual_token_' + Date.now());
                },
                'error-callback': function(e) {
                  window.__tsDebug.push('manual_error_' + JSON.stringify(e));
                }
              });
              return 'rendered_widget_' + widgetId;
            } catch(e) {
              return 'render_error: ' + e.message;
            }
          })()
        `);
        log('  Manual render: ' + renderResult);
      }

      if (i === 20) {
        const debug = await cdpEval(ws, `JSON.stringify({
          ts: typeof window.turnstile, patched: !!window.turnstile?.__cPatched,
          iframes: document.querySelectorAll('iframe').length,
          inp: (document.querySelector('input[name="cf-turnstile-response"]')||{}).value?.slice(0,30) || 'none',
          debug: window.__tsDebug?.join(',') || 'none'
        })`);
        log('  State@40s: ' + debug);
      }

      await sleep(2000);
    }

    if (!token) {
      log('  ERROR: Turnstile not solved after 90s');
      const debug = await cdpEval(ws, `JSON.stringify({
        ts: typeof window.turnstile, patched: !!window.turnstile?.__cPatched,
        token: window.__cactusToken,
        iframes: document.querySelectorAll('iframe').length,
        idDivs: document.querySelectorAll('[id*="turnstile"]').length,
        inp: (document.querySelector('input[name="cf-turnstile-response"]')||{}).value?.slice(0,30) || 'none',
        debug: window.__tsDebug?.join(',') || 'none'
      })`);
      log('  Debug: ' + debug);
      return { ok: false, error: 'turnstile_timeout' };
    }
    log('  Turnstile solved!');

    log('  Starting game run...');
    const startResult = await cdpEval(ws, `
      (async function() {
        var B = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        var a = crypto.getRandomValues(new Uint8Array(44));
        var pk = ''; for (var i=0;i<44;i++) pk += B[a[i]%58];
        window.__pk = pk;

        var r = await fetch('/api/runs/start', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            playSessionPubkey: pk,
            turnstileToken: window.__cactusToken,
            clientMeta: { ui: 'survival_runner_v1' }
          })
        });
        var d = await r.json();
        window.__runId = d.runId || null;
        return d;
      })()
    `, true);

    log('  Start: ' + JSON.stringify(startResult));
    if (!startResult?.ok || !startResult?.runId) {
      return { ok: false, error: 'start_failed', detail: startResult };
    }

    log(`  Waiting ${GAME_MS / 1000}s game duration...`);
    await sleep(GAME_MS);

    log('  Completing with win...');
    const completeResult = await cdpEval(ws, `
      (async function() {
        var r = await fetch('/api/runs/complete', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            runId: window.__runId,
            playSessionPubkey: window.__pk,
            outcome: 'win',
            walletPubkey: '${wallet}',
            clientMeta: { ui: 'survival_runner_v1', arena: '960x540', difficulty: 'normal' }
          })
        });
        return await r.json();
      })()
    `, true);

    log('  Complete: ' + JSON.stringify(completeResult));
    try { ws.close(); } catch {}
    return completeResult || { ok: false, error: 'no_response' };

  } catch (e) {
    log('  Exception: ' + e.message);
    return { ok: false, error: e.message };
  } finally {
    try { chrome?.kill('SIGKILL'); } catch {}
    try { xvfb?.kill('SIGKILL'); } catch {}
    await sleep(500);
    try { execSync(`rm -rf "${tmpDir}" 2>/dev/null`); } catch {}
  }
}

async function main() {
  log(`=== CactusEXE Claimer v3 started === ${WALLETS.length} wallet(s)`);
  saveStatus({ started: new Date().toISOString(), wallets: WALLETS.length, state: 'monitoring' });

  const claimed = new Set();
  let consecutive_closed = 0;

  while (claimed.size < WALLETS.length) {
    try {
      const spots = await checkSpots();
      const rem = spots.remaining ?? 0;
      const status = spots.status ?? 'unknown';

      if (rem > 0 && status === 'open') {
        consecutive_closed = 0;
        log(`SLOTS OPEN! ${rem}/${spots.cap} remaining`);
        saveStatus({ state: 'claiming', remaining: rem });

        for (const wallet of WALLETS) {
          if (claimed.has(wallet)) continue;

          const fresh = await checkSpots();
          if ((fresh.remaining ?? 0) <= 0 || fresh.status !== 'open') {
            log('Slots closed mid-claim, will retry next opening.');
            break;
          }

          log(`--- Claiming for ${wallet.slice(0, 8)}...${wallet.slice(-4)} ---`);
          const result = await claimForWallet(wallet);

          if (result?.ok) {
            log(`SUCCESS: WL claimed for ${wallet.slice(0, 8)}...${wallet.slice(-4)}`);
            claimed.add(wallet);
          } else {
            log(`FAILED: ${JSON.stringify(result)}`);
            if (result?.error?.code === 'cooldown') {
              log('  Cooldown active, skipping this wallet for now');
            }
          }

          await sleep(5000);
        }
      } else {
        consecutive_closed++;
        if (consecutive_closed % 12 === 1) {
          log(`Monitoring... ${rem}/${spots.cap || '?'} spots, status=${status}`);
        }
      }
    } catch (e) {
      log(`Poll error: ${e.message}`);
    }

    await sleep(POLL_MS);
  }

  log(`=== All ${WALLETS.length} wallets claimed! ===`);
  saveStatus({ state: 'done', claimed: WALLETS.length, finished: new Date().toISOString() });
}

main().catch(e => {
  log(`Fatal: ${e.message}`);
  saveStatus({ state: 'error', error: e.message });
  process.exit(1);
});
