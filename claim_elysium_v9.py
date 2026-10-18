#!/usr/bin/env python3
"""
Elysium Testnet Faucet Claimer v9
Strategy: nodriver + Turnstile with simulated click + challenge interception.
Also tries: capture x-is-human from wrapper, then try with Turnstile token.
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

async def get_turnstile_token(page, timeout_sec=60):
    """Render Turnstile, click it, wait for token."""
    await page.evaluate('''
        (() => {
            let existing = document.getElementById('ts-box');
            if (existing) existing.remove();
            let div = document.createElement('div');
            div.id = 'ts-box';
            div.style.cssText = 'position:fixed;bottom:50px;right:50px;z-index:99999;width:310px;height:80px;';
            document.body.appendChild(div);
            window.__tsToken = null;
            window.__tsError = null;
            try {
                window.__tsWid = window.turnstile.render('#ts-box', {
                    sitekey: "''' + TURNSTILE_SITEKEY + '''",
                    callback: t => { window.__tsToken = t; },
                    'error-callback': e => { window.__tsError = String(e); },
                    'expired-callback': () => { window.__tsToken = null; },
                    theme: 'light',
                    size: 'normal',
                    appearance: 'always',
                });
            } catch(e) { window.__tsError = e.message; }
        })()
    ''')
    await asyncio.sleep(2)

    # Try clicking the Turnstile iframe checkbox
    try:
        await page.evaluate('''
            (() => {
                let iframes = document.querySelectorAll('iframe[src*="challenges.cloudflare"]');
                iframes.forEach(f => {
                    f.style.width = '310px';
                    f.style.height = '65px';
                    f.style.display = 'block';
                    f.style.visibility = 'visible';
                });
            })()
        ''')
        await asyncio.sleep(1)

        # Use nodriver's click on the iframe area
        box = await page.evaluate('''
            (() => {
                let cont = document.getElementById('ts-box');
                if (!cont) return null;
                let rect = cont.getBoundingClientRect();
                return {x: rect.x + 30, y: rect.y + 30, w: rect.width, h: rect.height};
            })()
        ''')
        if box:
            box_data = json.loads(box) if isinstance(box, str) else box
            if box_data:
                import nodriver
                # Click in the center of the turnstile container
                x = box_data.get('x', 80) + 15
                y = box_data.get('y', 600) + 15
                print(f'    Clicking Turnstile at ({x}, {y})')
                await page.send(nodriver.cdp.input_.dispatch_mouse_event(
                    type_='mousePressed', x=x, y=y, button='left', click_count=1
                ))
                await asyncio.sleep(0.1)
                await page.send(nodriver.cdp.input_.dispatch_mouse_event(
                    type_='mouseReleased', x=x, y=y, button='left', click_count=1
                ))
    except Exception as e:
        print(f'    Click error: {e}')

    for t in range(timeout_sec):
        await asyncio.sleep(1)
        raw = await page.evaluate('JSON.stringify({t: window.__tsToken, e: window.__tsError})')
        try:
            data = json.loads(raw) if raw else {}
        except:
            data = {}
        if data.get('e'):
            print(f'    Turnstile error: {data["e"]}')
            return None
        if data.get('t'):
            print(f'    Turnstile solved in {t+1}s! Token: {data["t"][:30]}...')
            return data['t']
        if t % 15 == 14:
            print(f'    Waiting for Turnstile... ({t+1}s)')
            # Try clicking again
            try:
                if box_data:
                    import nodriver
                    await page.send(nodriver.cdp.input_.dispatch_mouse_event(
                        type_='mousePressed', x=x, y=y, button='left', click_count=1
                    ))
                    await asyncio.sleep(0.1)
                    await page.send(nodriver.cdp.input_.dispatch_mouse_event(
                        type_='mouseReleased', x=x, y=y, button='left', click_count=1
                    ))
            except:
                pass
    print(f'    Turnstile timeout ({timeout_sec}s)')
    return None

async def claim_wallet(page, addr, token=''):
    """Call faucet API from page context."""
    safe_token = (token or '').replace("'", "\\'")
    safe_addr = addr.replace("'", "\\'")
    js = f"""
    (async () => {{
        try {{
            const r = await fetch('/api/faucet/testnet', {{
                method: 'POST',
                headers: {{ 'Content-Type': 'application/json' }},
                body: JSON.stringify({{ address: '{safe_addr}', captchaToken: '{safe_token}' }}),
            }});
            const body = await r.text();
            window.__claim_result = JSON.stringify({{ status: r.status, body: body }});
        }} catch (e) {{
            window.__claim_result = JSON.stringify({{ error: e.message }});
        }}
    }})()
    """
    await page.evaluate(js)
    await asyncio.sleep(3)
    raw = await page.evaluate('window.__claim_result')
    try:
        return json.loads(raw) if raw else {'error': 'no result'}
    except:
        return {'error': f'parse: {raw}'}

async def main():
    import nodriver as uc

    print('=' * 60)
    print('ELYSIUM FAUCET v9 — nodriver + Turnstile click + intercept')
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

    page = await browser.get(FAUCET_URL)
    print('Page loaded. Waiting 8s for init...')
    await asyncio.sleep(8)

    # Debug info
    debug = await page.evaluate('JSON.stringify({wd: navigator.webdriver, plat: navigator.platform, hw: navigator.hardwareConcurrency, chr: !!window.chrome, ts: !!window.turnstile})')
    print(f'State: {debug}')

    # Intercept: capture what x-is-human header the wrapper generates
    await page.evaluate('''
        (() => {
            window.__capturedHeaders = [];
            const origFetch = window.fetch;
            window.fetch = function(url, opts) {
                if (typeof url === 'string' && url.includes('/api/faucet')) {
                    const headers = opts?.headers || {};
                    const h = {};
                    if (headers instanceof Headers) {
                        headers.forEach((v, k) => h[k] = v.slice(0, 200));
                    } else if (typeof headers === 'object') {
                        for (const [k,v] of Object.entries(headers)) h[k] = String(v).slice(0, 200);
                    }
                    window.__capturedHeaders.push(h);
                }
                return origFetch.apply(this, arguments);
            };
        })()
    ''')

    # Phase 1: Try direct API call to see what x-is-human we get
    print('\n=== Phase 1: Test API call (capture x-is-human) ===')
    resp = await claim_wallet(page, all_wallets[0][1], '')
    status = resp.get('status', 'ERR')
    body = resp.get('body', resp.get('error', ''))
    print(f'Response: {status} | {body[:200]}')

    headers_raw = await page.evaluate('JSON.stringify(window.__capturedHeaders)')
    try:
        headers = json.loads(headers_raw) if headers_raw else []
    except:
        headers = []
    print(f'Captured headers: {json.dumps(headers)[:500]}')

    # Check if we got x-is-human
    xih = None
    for h in headers:
        if 'x-is-human' in h:
            xih = h['x-is-human']
            try:
                xih_data = json.loads(xih)
                print(f'x-is-human: b={xih_data.get("b")} v={xih_data.get("v")} d={xih_data.get("d")}')
            except:
                print(f'x-is-human (raw): {xih[:200]}')

    # Parse response
    try:
        parsed = json.loads(body)
    except:
        parsed = {}

    if parsed.get('status') == 'ok':
        print('DIRECT CALL WORKED! Proceeding with all wallets...')
    elif parsed.get('error') in ('captcha', 'bot'):
        print(f'Got "{parsed.get("error")}" — need Turnstile token')

        # Phase 2: Get Turnstile token
        print('\n=== Phase 2: Solve Turnstile ===')
        ts_loaded = await page.evaluate('typeof window.turnstile !== "undefined"')
        if not ts_loaded:
            print('Loading Turnstile API...')
            try:
                await page.evaluate('''
                    new Promise((resolve, reject) => {
                        const s = document.createElement('script');
                        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__tsReady';
                        window.__tsReady = () => resolve(true);
                        s.onerror = () => reject('load failed');
                        document.head.appendChild(s);
                        setTimeout(() => reject('timeout'), 15000);
                    })
                ''')
            except:
                pass
            await asyncio.sleep(3)

        token = await get_turnstile_token(page, timeout_sec=60)

        if token:
            print(f'\n=== Phase 3: Claim with Turnstile token ===')
            # Retry first wallet with token
            resp2 = await claim_wallet(page, all_wallets[0][1], token)
            body2 = resp2.get('body', resp2.get('error', ''))
            print(f'Retry result: {resp2.get("status", "ERR")} | {body2[:200]}')
            try:
                p2 = json.loads(body2)
            except:
                p2 = {}

            if p2.get('status') == 'ok' or p2.get('status') == 'cooldown':
                print('TOKEN APPROACH WORKS!')
        else:
            print('Turnstile did not solve.')

            # Phase 2b: Try to use the existing page's Turnstile
            # The FaucetForm component already has its own Turnstile
            print('\n=== Phase 2b: Try UI-based claim ===')

            # Check if the page has a faucet form we can interact with
            form_info = await page.evaluate('''
                (() => {
                    const inputs = document.querySelectorAll('input[type="text"], input[placeholder]');
                    const buttons = document.querySelectorAll('button');
                    const r = {inputs: [], buttons: []};
                    inputs.forEach(inp => r.inputs.push({
                        placeholder: inp.placeholder, name: inp.name, id: inp.id,
                        value: inp.value, type: inp.type
                    }));
                    buttons.forEach(btn => r.buttons.push({
                        text: btn.textContent.trim().slice(0, 40),
                        disabled: btn.disabled,
                        type: btn.type
                    }));
                    // Check for Turnstile in the form
                    const tsIframes = document.querySelectorAll('iframe[src*="challenges.cloudflare"]');
                    r.turnstileIframes = tsIframes.length;
                    const tsInputs = document.querySelectorAll('input[name="cf-turnstile-response"]');
                    r.turnstileInputs = tsInputs.length;
                    if (tsInputs.length > 0) r.tsValue = (tsInputs[0].value || '').slice(0, 40);
                    return r;
                })()
            ''')
            print(f'Form state: {json.dumps(form_info)[:500]}')

    # Continue with all wallets
    results = []

    # Determine approach based on what worked
    approach = 'direct'  # default: just call API (if fingerprint is good enough)

    for i, (name, addr) in enumerate(all_wallets):
        print(f'\n--- [{i+1}/{len(all_wallets)}] {name}: {addr[:10]}... ---')

        # Get fresh Turnstile token if approach requires it
        token = ''
        if approach == 'turnstile':
            await page.evaluate('window.__tsToken = null; try { window.turnstile.reset(window.__tsWid); } catch(e) {}')
            await asyncio.sleep(2)
            token = await get_turnstile_token(page, timeout_sec=60) or ''

        resp = await claim_wallet(page, addr, token)
        status = resp.get('status', 'ERR')
        body = resp.get('body', resp.get('error', ''))
        print(f'  {status} | {body[:200]}')

        try:
            parsed = json.loads(body)
        except:
            parsed = {}

        if parsed.get('status') == 'ok':
            print(f'  SUCCESS! tx: {parsed.get("txHash", "n/a")}')
            results.append((name, addr, True, parsed))
        elif parsed.get('status') == 'cooldown':
            print(f'  COOLDOWN')
            results.append((name, addr, False, f'cooldown {parsed.get("retryAt", "")}'))
        else:
            results.append((name, addr, False, body[:100]))

        if i == 1 and all(not r[2] and ('captcha' in str(r[3]) or 'bot' in str(r[3])) for r in results):
            print('\n[!] First 2 failed — stopping.')
            break

        if i < len(all_wallets) - 1:
            await asyncio.sleep(3)

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
