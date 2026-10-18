#!/usr/bin/env python3
"""
Elysium Testnet Faucet Claimer v11
Strategy: nodriver + intercept the anti-bot wrapper to force Turnstile loading.

The wrapper code flow:
  let d = await i.getChallenge();
  // d = {b: 0/1, v: score, d: 0/1, e: "JWE..."}
  // If b==0 AND d==1 -> loads Turnstile, then retries fetch
  // If b==0 AND d==0 -> sends as-is (gets "captcha" error)

We hook the wrapper's internal class to force d=1, making it load Turnstile.
With Turnstile loaded, it renders the challenge and waits for solve.
If Turnstile solves (even in VPS with nodriver), the retry should work.

Alternatively: we intercept fetch to add our own Turnstile token.
"""
import asyncio
import json
import os
import sys
import time

FAUCET_URL = 'https://elysium.kinetiq.xyz/testnet-faucet'
TURNSTILE_SITEKEY = '0x4AAAAAAFItMMT0n2NGsM3v'

WALLETS = [
    ('validator',       '0x9C98Cc106b01C0B9dAEA980aa36a5d731587bDa8'),
    ('mallardordinals', '0xdaDfc6D1774C8AcE5B2f48C8Cba17c9660ad148D'),
    ('bossventure168',  '0x50fAbeA8992A740b4b271b7FF7ED0B6074f970a1'),
    ('gryfindor_bot',   '0xE1C436e928131B6D6E3E3DdF6BF34dc2A223BD6b'),
    ('hendrawanipiro',  '0xAE0284d37038A9F5D4279DFF591D9B9368dE0815'),
]

def load_bot_wallets(n=4):
    try:
        with open('/home/boss/.pixelpals_wallets.json') as f:
            data = json.load(f)
        return [(f'bot_{i}', w.get('address') or w.get('wallet') or w.get('addr'))
                for i, w in enumerate(data[:n])
                if w.get('address') or w.get('wallet') or w.get('addr')]
    except Exception as e:
        print(f'  [!] Bot wallets: {e}')
        return []

async def main():
    import nodriver as uc

    print('=' * 60)
    print('ELYSIUM FAUCET v11 — nodriver + force Turnstile via wrapper hook')
    print(time.strftime('%Y-%m-%d %H:%M:%S WIB', time.gmtime(time.time() + 7*3600)))
    print(f'DISPLAY={os.environ.get("DISPLAY", "NOT SET")}')
    print('=' * 60)

    all_wallets = WALLETS + load_bot_wallets(4)
    print(f'Wallets: {len(all_wallets)}')

    browser = await uc.start(
        headless=False,
        browser_args=[
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1920,1080',
            '--lang=en-US',
        ],
    )

    page = await browser.get('about:blank')

    # CRITICAL: Before loading the faucet page, inject a hook that modifies
    # the wrapper's behavior. We intercept the protection script to force d=1.
    #
    # The wrapper script (3vp4x4pssh5b0.js) does:
    #   let d = await i.getChallenge();
    #   p.set("x-is-human", JSON.stringify(d));
    #   if (u.loaded || d.b !== 0) { return t(n,h); }  // pass through
    #   if (d.d === 1) { await u.load(); return window.fetch(n,h); }  // load turnstile
    #   return t(n,h);  // pass through anyway
    #
    # We need to intercept AFTER the challenge is generated but BEFORE the
    # fetch call, to add a valid Turnstile token to the request body.
    #
    # Strategy: Override window.fetch at the RIGHT level to:
    # 1. Let the wrapper add x-is-human header (we need it)
    # 2. Before the actual fetch, add our Turnstile token to the body
    #
    # But first: let's try the simpler approach of loading Turnstile ourselves
    # and getting a token, then intercepting fetch to add it.

    await page.evaluate('''
        // Pre-load: Hook to intercept and log x-is-human when fetch is called
        window.__xIsHumanLog = [];
        window.__tsTokenForApi = null;

        // We'll set up a MutationObserver to detect when the wrapper script
        // replaces window.fetch, then wrap IT
        const origFetch = window.fetch.bind(window);
        let wrapperFetchSet = false;

        const patchFetch = () => {
            if (wrapperFetchSet) return;
            const currentFetch = window.fetch;
            if (currentFetch === origFetch) return; // not yet wrapped
            wrapperFetchSet = true;

            // The wrapper has replaced fetch. Now wrap the wrapper.
            window.fetch = async function(url, opts) {
                // If this is a faucet API call, inject Turnstile token into body
                if (typeof url === 'string' && url.includes('/api/faucet') && window.__tsTokenForApi) {
                    try {
                        const body = JSON.parse(opts.body);
                        body.captchaToken = window.__tsTokenForApi;
                        opts = { ...opts, body: JSON.stringify(body) };
                        console.log('[HOOK] Injected Turnstile token into faucet request');
                    } catch (e) {
                        console.log('[HOOK] Failed to inject token:', e.message);
                    }
                }
                // Log x-is-human header
                if (typeof url === 'string' && url.includes('/api/faucet')) {
                    const headers = {};
                    if (opts?.headers) {
                        if (opts.headers instanceof Headers) {
                            opts.headers.forEach((v, k) => headers[k] = v.slice(0, 200));
                        } else {
                            Object.entries(opts.headers).forEach(([k,v]) => headers[k] = String(v).slice(0, 200));
                        }
                    }
                    window.__xIsHumanLog.push(headers);
                }
                return currentFetch.apply(this, arguments);
            };
        };

        // Check periodically if fetch was replaced
        const checkInterval = setInterval(() => {
            patchFetch();
            if (wrapperFetchSet) clearInterval(checkInterval);
        }, 100);

        // Also clear after 30s
        setTimeout(() => clearInterval(checkInterval), 30000);
    ''')

    # Now load the actual faucet page
    print('Loading faucet page...')
    await page.get(FAUCET_URL)
    await asyncio.sleep(10)
    print('Page loaded.')

    # Debug
    debug = await page.evaluate('JSON.stringify({wd: navigator.webdriver, ts: !!window.turnstile, xihCount: window.__xIsHumanLog.length})')
    print(f'State: {debug}')

    # Phase 1: Test call to see fingerprint
    print('\n=== Phase 1: Test fingerprint ===')
    await page.evaluate('''
        (async () => {
            try {
                const r = await fetch('/api/faucet/testnet', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({address: '0x0000000000000000000000000000000000000001', captchaToken: ''}),
                });
                window.__testResult = JSON.stringify({status: r.status, body: await r.text()});
            } catch(e) {
                window.__testResult = JSON.stringify({error: e.message});
            }
        })()
    ''')
    await asyncio.sleep(4)
    test_raw = await page.evaluate('window.__testResult')
    print(f'Test result: {test_raw}')

    # Check captured x-is-human
    xih_log = await page.evaluate('JSON.stringify(window.__xIsHumanLog)')
    print(f'Captured headers: {xih_log[:500]}')

    # Parse x-is-human to see b value
    xih_data = None
    try:
        headers_list = json.loads(xih_log)
        for h in headers_list:
            if 'x-is-human' in h:
                xih_data = json.loads(h['x-is-human'])
                print(f'x-is-human: b={xih_data.get("b")} v={xih_data.get("v")} d={xih_data.get("d")}')
    except:
        pass

    # Phase 2: Load Turnstile and get token
    print('\n=== Phase 2: Get Turnstile token ===')

    ts_loaded = await page.evaluate('typeof window.turnstile !== "undefined"')
    print(f'Turnstile API present: {ts_loaded}')

    if not ts_loaded:
        print('Loading Turnstile API...')
        await page.evaluate('''
            new Promise((resolve) => {
                const s = document.createElement('script');
                s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__tsReady';
                window.__tsReady = () => resolve();
                s.onerror = () => resolve();
                document.head.appendChild(s);
                setTimeout(resolve, 15000);
            })
        ''')
        await asyncio.sleep(3)

    # Render Turnstile widget
    await page.evaluate('''
        (() => {
            let e = document.getElementById('ts-box');
            if (e) e.remove();
            let div = document.createElement('div');
            div.id = 'ts-box';
            div.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:99999;width:310px;height:80px;background:white;border:2px solid blue;';
            document.body.appendChild(div);
            window.__tsToken = null;
            window.__tsError = null;
            try {
                window.__tsWid = window.turnstile.render('#ts-box', {
                    sitekey: "''' + TURNSTILE_SITEKEY + '''",
                    callback: t => { window.__tsToken = t; console.log('[TS] Token received!'); },
                    'error-callback': e => { window.__tsError = String(e); console.log('[TS] Error:', e); },
                    theme: 'light',
                    appearance: 'always',
                    retry: 'auto',
                    'retry-interval': 2000,
                });
                console.log('[TS] Widget rendered, id:', window.__tsWid);
            } catch(e) {
                window.__tsError = e.message;
                console.log('[TS] Render error:', e.message);
            }
        })()
    ''')

    # Click the Turnstile widget area using CDP
    await asyncio.sleep(3)

    # Try clicking the Turnstile checkbox via CDP mouse events
    import nodriver.cdp.input_ as cdp_input

    # Get the position of the turnstile container
    box_raw = await page.evaluate('''
        (() => {
            let cont = document.getElementById('ts-box');
            if (!cont) return null;
            let rect = cont.getBoundingClientRect();
            // Also check for iframe inside
            let iframe = cont.querySelector('iframe');
            let iframeRect = iframe ? iframe.getBoundingClientRect() : null;
            return JSON.stringify({
                box: {x: rect.x, y: rect.y, w: rect.width, h: rect.height},
                iframe: iframeRect ? {x: iframeRect.x, y: iframeRect.y, w: iframeRect.width, h: iframeRect.height} : null
            });
        })()
    ''')
    print(f'Turnstile box: {box_raw}')

    if box_raw:
        try:
            box_data = json.loads(box_raw)
            # Click the checkbox area (usually left side of the Turnstile widget)
            if box_data.get('iframe'):
                cx = box_data['iframe']['x'] + 25
                cy = box_data['iframe']['y'] + 25
            else:
                cx = box_data['box']['x'] + 25
                cy = box_data['box']['y'] + 25

            print(f'  Clicking at ({cx}, {cy})')
            await page.send(cdp_input.dispatch_mouse_event(
                type_='mousePressed', x=cx, y=cy, button=cdp_input.MouseButton.LEFT, click_count=1
            ))
            await asyncio.sleep(0.1)
            await page.send(cdp_input.dispatch_mouse_event(
                type_='mouseReleased', x=cx, y=cy, button=cdp_input.MouseButton.LEFT, click_count=1
            ))
        except Exception as e:
            print(f'  Click error: {e}')

    # Wait for Turnstile to solve
    token = None
    for t in range(90):
        await asyncio.sleep(1)
        state_raw = await page.evaluate('JSON.stringify({t: window.__tsToken, e: window.__tsError})')
        try:
            state = json.loads(state_raw) if state_raw else {}
        except:
            state = {}
        if state.get('e'):
            print(f'  Turnstile error at {t+1}s: {state["e"]}')
            # Try resetting
            if t < 60:
                await page.evaluate('try { window.turnstile.reset(window.__tsWid); window.__tsError = null; } catch(e) {}')
            else:
                break
        if state.get('t'):
            token = state['t']
            print(f'  TURNSTILE SOLVED in {t+1}s! Token length: {len(token)}')
            break
        if t % 15 == 14:
            print(f'  Waiting... ({t+1}s)')
            # Try clicking again
            try:
                if box_data and box_data.get('iframe'):
                    await page.send(cdp_input.dispatch_mouse_event(
                        type_='mousePressed', x=cx, y=cy, button=cdp_input.MouseButton.LEFT, click_count=1
                    ))
                    await asyncio.sleep(0.1)
                    await page.send(cdp_input.dispatch_mouse_event(
                        type_='mouseReleased', x=cx, y=cy, button=cdp_input.MouseButton.LEFT, click_count=1
                    ))
            except:
                pass

    if not token:
        print('  Turnstile did NOT solve after 90s.')
        print('  Trying without Turnstile token...')

    # Phase 3: Claim wallets
    print('\n=== Phase 3: Claim wallets ===')

    # Set the token for the fetch interceptor
    if token:
        safe_token = token.replace("'", "\\'").replace("\\", "\\\\")
        await page.evaluate(f"window.__tsTokenForApi = '{safe_token}'")
        print(f'Token set for API interceptor')

    results = []
    for i, (name, addr) in enumerate(all_wallets):
        print(f'\n--- [{i+1}/{len(all_wallets)}] {name}: {addr[:10]}... ---')

        safe_addr = addr.replace("'", "\\'")
        ct = (token or '').replace("'", "\\'")
        js = f"""
        (async () => {{
            try {{
                const r = await fetch('/api/faucet/testnet', {{
                    method: 'POST',
                    headers: {{ 'Content-Type': 'application/json' }},
                    body: JSON.stringify({{ address: '{safe_addr}', captchaToken: '{ct}' }}),
                }});
                window.__claim = JSON.stringify({{ status: r.status, body: await r.text() }});
            }} catch (e) {{
                window.__claim = JSON.stringify({{ error: e.message }});
            }}
        }})()
        """
        await page.evaluate(js)
        await asyncio.sleep(3)
        raw = await page.evaluate('window.__claim')
        try:
            resp = json.loads(raw) if raw else {'error': 'no result'}
        except:
            resp = {'error': str(raw)}

        body_str = resp.get('body', resp.get('error', ''))
        print(f'  {resp.get("status", "ERR")} | {body_str[:200]}')

        try:
            parsed = json.loads(body_str)
        except:
            parsed = {}

        if parsed.get('status') == 'ok':
            print(f'  SUCCESS! tx: {parsed.get("txHash", "n/a")}')
            results.append((name, addr, True, parsed))
        elif parsed.get('status') == 'cooldown':
            print(f'  COOLDOWN — retryAt: {parsed.get("retryAt", "")}')
            results.append((name, addr, False, f'cooldown {parsed.get("retryAt", "")}'))
        else:
            results.append((name, addr, False, body_str[:100]))

        if i == 1 and all(not r[2] and ('captcha' in str(r[3]) or 'bot' in str(r[3])) for r in results):
            print('\n[!] First 2 failed — stopping.')
            break

        if i < len(all_wallets) - 1:
            # Get fresh Turnstile token for next wallet
            if token:
                await page.evaluate('window.__tsToken = null; try { window.turnstile.reset(window.__tsWid); } catch(e) {}')
                for t in range(30):
                    await asyncio.sleep(1)
                    tk = await page.evaluate('window.__tsToken')
                    if tk:
                        token = tk
                        safe_token = token.replace("'", "\\'")
                        await page.evaluate(f"window.__tsTokenForApi = '{safe_token}'")
                        print(f'  Fresh token in {t+1}s')
                        break
                else:
                    print(f'  No fresh token, using old one')
            await asyncio.sleep(2)

    browser.stop()

    print('\n' + '=' * 60)
    print('SUMMARY')
    print('=' * 60)
    ok = 0
    for name, addr, success, detail in results:
        st = 'OK' if success else str(detail)[:60]
        if success: ok += 1
        print(f'  {name:<18} | {addr[:10]}... | {st}')
    print(f'\nTotal: {ok}/{len(results)} success')

if __name__ == '__main__':
    asyncio.run(main())
