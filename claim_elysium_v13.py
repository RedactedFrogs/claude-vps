#!/usr/bin/env python3
"""
Elysium Testnet Faucet Claimer v13
Fixes from v12:
- Inject hooks AFTER navigation (not before — addScriptToEvaluateOnNewDocument broken in nodriver)
- Check page's own Turnstile widget first
- Explicit widget sizing
- Robust claim code without depending on pre-nav hooks
"""
import asyncio, json, os, sys, time, base64, random

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

async def take_ss(page, name):
    try:
        import nodriver.cdp.page as cp
        data = await page.send(cp.capture_screenshot(format_='png'))
        path = f'/tmp/faucet_{name}.png'
        with open(path, 'wb') as f:
            f.write(base64.b64decode(data))
        print(f'  [ss] {path} ({os.path.getsize(path)//1024}KB)')
    except Exception as e:
        print(f'  [ss] fail: {e}')

async def human_click(page, x, y):
    import nodriver.cdp.input_ as inp
    jx, jy = x + random.uniform(-30, 30), y + random.uniform(-20, 20)
    await page.send(inp.dispatch_mouse_event(type_='mouseMoved', x=jx, y=jy))
    await asyncio.sleep(random.uniform(0.08, 0.2))
    await page.send(inp.dispatch_mouse_event(type_='mouseMoved', x=x, y=y))
    await asyncio.sleep(random.uniform(0.05, 0.15))
    await page.send(inp.dispatch_mouse_event(
        type_='mousePressed', x=x, y=y, button=inp.MouseButton.LEFT, click_count=1))
    await asyncio.sleep(random.uniform(0.06, 0.12))
    await page.send(inp.dispatch_mouse_event(
        type_='mouseReleased', x=x, y=y, button=inp.MouseButton.LEFT, click_count=1))

async def js(page, code):
    """Evaluate JS and return result as string, handling exceptions."""
    try:
        r = await page.evaluate(code)
        if r is None:
            return None
        if isinstance(r, str):
            return r
        return str(r)
    except Exception as e:
        return f'PY_ERR: {e}'

async def claim_wallet(page, addr, captcha_token):
    """Claim for one wallet. Returns (status_code, body_text)."""
    sa = addr.replace('\\', '\\\\').replace("'", "\\'").replace('"', '\\"')
    ct = (captcha_token or '').replace('\\', '\\\\').replace("'", "\\'").replace('"', '\\"')

    await page.evaluate(f'''(async()=>{{
        try {{
            const r = await fetch('/api/faucet/testnet', {{
                method:'POST',
                headers:{{'Content-Type':'application/json'}},
                body: JSON.stringify({{address:"{sa}", captchaToken:"{ct}"}})
            }});
            window.__claimR = JSON.stringify({{s:r.status, b:await r.text()}});
        }} catch(e) {{
            window.__claimR = JSON.stringify({{s:0, b:e.message}});
        }}
    }})()''')
    await asyncio.sleep(4)
    raw = await js(page, 'window.__claimR || "null"')
    if not raw or raw == 'null':
        return (0, 'no result')
    try:
        d = json.loads(raw)
        return (d.get('s', 0), d.get('b', ''))
    except:
        return (0, raw[:200])

async def main():
    import nodriver as uc

    print('=' * 60)
    print('ELYSIUM FAUCET v13 — post-nav hooks + page Turnstile check')
    print(time.strftime('%Y-%m-%d %H:%M:%S WIB', time.gmtime(time.time() + 7*3600)))
    print(f'DISPLAY={os.environ.get("DISPLAY", "NOT SET")}')
    print('=' * 60)

    all_wallets = WALLETS + load_bot_wallets(4)
    print(f'Wallets: {len(all_wallets)}')

    browser = await uc.start(
        headless=False,
        browser_args=[
            '--no-sandbox', '--disable-dev-shm-usage',
            '--window-size=1920,1080', '--lang=en-US',
            '--disable-blink-features=AutomationControlled',
        ],
    )

    page = await browser.get(FAUCET_URL)
    await asyncio.sleep(12)
    print('Page loaded.')

    # === Post-navigation: inject hooks now that we're on the real page ===
    await page.evaluate('''(() => {
        window.__v13 = { xih: [], token: null, err: null, wid: null };
    })()''')

    # === Explore DOM ===
    print('\n=== DOM ===')
    dom_raw = await js(page, '''JSON.stringify((() => {
        const r = {};
        r.title = document.title;
        r.inputs = [...document.querySelectorAll('input')].map(i => ({
            type:i.type, name:i.name||'', id:i.id||'', val:i.value?.substring(0,60)||''
        }));
        r.buttons = [...document.querySelectorAll('button')].map(b => ({
            txt: b.textContent?.trim().substring(0,40), dis: b.disabled
        }));
        r.allIframes = [...document.querySelectorAll('iframe')].map(f => ({
            src: f.src?.substring(0,80)||'', w:f.offsetWidth, h:f.offsetHeight
        }));
        r.hasTS = typeof window.turnstile !== 'undefined';
        r.wd = navigator.webdriver;
        // Check existing Turnstile widget response
        r.tsGetResp = null;
        try { r.tsGetResp = window.turnstile?.getResponse?.()?.substring(0,40); } catch(e) { r.tsGetResp = 'err:'+e.message; }
        // Check hidden input value
        const hi = document.querySelector('input[name="cf-turnstile-response"]');
        r.cfInput = hi ? hi.value?.substring(0,40) : null;
        return r;
    })())''')
    print(f'DOM: {dom_raw}')
    await take_ss(page, '01_loaded')

    # Parse DOM info
    dom = {}
    try:
        dom = json.loads(dom_raw) if dom_raw else {}
    except:
        pass

    # === Check if page already has a Turnstile token ===
    existing_token = None
    cf_val = dom.get('cfInput', '')
    ts_resp = dom.get('tsGetResp', '')
    if cf_val and len(cf_val) > 20:
        existing_token = cf_val
        print(f'  Page has existing Turnstile token! ({len(existing_token)} chars)')
    elif ts_resp and len(ts_resp) > 20 and not ts_resp.startswith('err:'):
        existing_token = ts_resp
        print(f'  turnstile.getResponse() has token! ({len(existing_token)} chars)')
    else:
        print(f'  No existing Turnstile token (cfInput={cf_val}, getResp={ts_resp})')

    # Get full token if truncated
    if existing_token and len(existing_token) == 40:
        full = await js(page, '''
            document.querySelector('input[name="cf-turnstile-response"]')?.value ||
            (typeof turnstile !== "undefined" ? turnstile.getResponse() : null) || ""
        ''')
        if full and len(full) > 40:
            existing_token = full
            print(f'  Full token length: {len(existing_token)}')

    # === Phase 1: Quick fingerprint test ===
    print('\n=== Phase 1: Fingerprint ===')
    await page.evaluate('''(async()=>{
        try {
            const r = await fetch('/api/faucet/testnet', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({address:'0x0000000000000000000000000000000000000001', captchaToken:''})
            });
            window.__testR = JSON.stringify({s:r.status, b:await r.text()});
        } catch(e) { window.__testR = JSON.stringify({s:0,b:e.message}); }
    })()''')
    await asyncio.sleep(5)
    test_raw = await js(page, 'window.__testR || "pending"')
    print(f'Test: {test_raw}')

    # Check if wrapper added x-is-human (look at network via performance observer)
    # We can't easily intercept headers after the fact, but we can check
    # the wrapper's internal state
    wrapper_info = await js(page, '''JSON.stringify((() => {
        // Try to find the wrapper's challenge data
        const r = {};
        // Check for x-is-human in the last request
        r.perfEntries = performance.getEntriesByType("resource")
            .filter(e => e.name.includes("/api/faucet"))
            .map(e => ({name:e.name.substring(0,60), dur:e.duration}));
        return r;
    })())''')
    print(f'Wrapper: {wrapper_info}')

    # === Phase 2: Turnstile ===
    print('\n=== Phase 2: Turnstile ===')

    token = existing_token

    if not token:
        ts_ok = await js(page, 'typeof window.turnstile !== "undefined"')
        print(f'Turnstile API: {ts_ok}')

        if ts_ok != 'true' and ts_ok != 'True':
            print('Loading Turnstile...')
            await page.evaluate('''new Promise(r=>{
                const s=document.createElement('script');
                s.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__tsRdy';
                window.__tsRdy=()=>r();
                s.onerror=()=>r();
                document.head.appendChild(s);
                setTimeout(r,15000);
            })''')
            await asyncio.sleep(3)

        # Render with explicit dimensions
        print('Rendering Turnstile widget (300x65)...')
        render_result = await js(page, '''(() => {
            let el = document.getElementById('v13ts');
            if (el) el.remove();
            const div = document.createElement('div');
            div.id = 'v13ts';
            div.style.cssText = 'position:fixed;top:40%;left:50%;transform:translate(-50%,-50%);z-index:99999;width:310px;height:90px;background:white;padding:10px;border:2px solid #0079ff;border-radius:8px;';
            document.body.appendChild(div);
            try {
                const wid = turnstile.render('#v13ts', {
                    sitekey: "''' + TURNSTILE_SITEKEY + '''",
                    callback: t => { window.__v13.token = t; },
                    'error-callback': e => { window.__v13.err = String(e); },
                    theme: 'light',
                    size: 'normal',
                    appearance: 'always',
                    retry: 'auto',
                    'retry-interval': 3000,
                });
                window.__v13.wid = wid;
                return JSON.stringify({ok:true, wid:wid});
            } catch(e) {
                return JSON.stringify({ok:false, err:e.message});
            }
        })()''')
        print(f'Render: {render_result}')
        await asyncio.sleep(4)

        # Check widget state
        box_raw = await js(page, '''JSON.stringify((() => {
            const c = document.getElementById('v13ts');
            if (!c) return {err:'no container'};
            const cr = c.getBoundingClientRect();
            const iframes = [...c.querySelectorAll('iframe')];
            const allIframes = [...document.querySelectorAll('iframe')];
            return {
                container: {x:Math.round(cr.x),y:Math.round(cr.y),w:Math.round(cr.width),h:Math.round(cr.height)},
                widgetIframes: iframes.length,
                allIframes: allIframes.map(f => ({
                    src:f.src?.substring(0,80),
                    w:f.offsetWidth, h:f.offsetHeight,
                    x:Math.round(f.getBoundingClientRect().x),
                    y:Math.round(f.getBoundingClientRect().y)
                })),
                innerHTML: c.innerHTML.substring(0,200),
            };
        })())''')
        print(f'Widget: {box_raw}')
        await take_ss(page, '02_ts_rendered')

        # Find the Turnstile iframe to click
        cx, cy = None, None
        try:
            bd = json.loads(box_raw)
            # Look for a Turnstile iframe (usually ~300x65)
            for iframe in bd.get('allIframes', []):
                if iframe.get('w', 0) > 200 and iframe.get('h', 0) > 30:
                    cx = iframe['x'] + 30
                    cy = iframe['y'] + 30
                    print(f'  Found TS iframe at ({iframe["x"]},{iframe["y"]}) {iframe["w"]}x{iframe["h"]}')
                    break
            if cx is None and bd.get('container'):
                cx = bd['container']['x'] + 30
                cy = bd['container']['y'] + 30
        except:
            pass

        if cx is not None:
            print(f'  Clicking at ({cx:.0f},{cy:.0f})...')
            await human_click(page, cx, cy)

        # Wait for solve
        for t in range(120):
            await asyncio.sleep(1)
            tok = await js(page, 'window.__v13.token || ""')
            err = await js(page, 'window.__v13.err || ""')

            if tok and len(tok) > 20:
                token = tok
                print(f'  SOLVED in {t+1}s! Token: {tok[:40]}...')
                break
            if err:
                print(f'  TS error at {t+1}s: {err}')
                if t < 90:
                    await page.evaluate('try{turnstile.reset(window.__v13.wid);window.__v13.err=""}catch(e){}')
            if t % 20 == 19:
                print(f'  Waiting... {t+1}s')
                await take_ss(page, f'03_wait_{t+1}')
                if cx is not None:
                    await human_click(page, cx, cy)

        # Also check page's own Turnstile (might have auto-solved)
        if not token:
            page_tok = await js(page, '''
                document.querySelector('input[name="cf-turnstile-response"]')?.value ||
                (typeof turnstile !== "undefined" ? turnstile.getResponse() : null) || ""
            ''')
            if page_tok and len(page_tok) > 20:
                token = page_tok
                print(f'  Page Turnstile auto-solved! Token: {token[:40]}...')

        if not token:
            print('  Turnstile did NOT solve after 120s.')
            await take_ss(page, '04_timeout')
            print('  Will try claiming without token anyway...')

    else:
        print(f'  Using existing token: {token[:40]}...')

    # === Phase 3: Claim ===
    print('\n=== Phase 3: Claim ===')
    results = []

    for i, (name, addr) in enumerate(all_wallets):
        print(f'\n--- [{i+1}/{len(all_wallets)}] {name}: {addr[:10]}... ---')

        status, body = await claim_wallet(page, addr, token)
        print(f'  {status} | {body[:200]}')

        try:
            parsed = json.loads(body)
        except:
            parsed = {}

        if parsed.get('status') == 'ok':
            tx = parsed.get('txHash', 'n/a')
            print(f'  SUCCESS! tx: {tx}')
            results.append((name, addr, True, tx))
        elif parsed.get('status') == 'cooldown':
            retry = parsed.get('retryAt', '')
            print(f'  COOLDOWN — retryAt: {retry}')
            results.append((name, addr, False, f'cooldown {retry}'))
        else:
            results.append((name, addr, False, body[:100]))

        # Early stop after 2 failures with captcha/bot
        if i == 1 and all(not r[2] and ('captcha' in str(r[3]).lower() or 'bot' in str(r[3]).lower()) for r in results):
            print('\n[!] First 2 failed with captcha — stopping.')
            break

        # Refresh token
        if i < len(all_wallets) - 1 and token:
            await page.evaluate('''(() => {
                window.__v13.token = null;
                try { turnstile.reset(window.__v13.wid); } catch(e) {}
            })()''')
            fresh = None
            for t2 in range(40):
                await asyncio.sleep(1)
                fresh = await js(page, 'window.__v13.token || ""')
                if fresh and len(fresh) > 20:
                    token = fresh
                    print(f'  Fresh token in {t2+1}s')
                    break
            if not fresh or len(fresh) <= 20:
                # Check page's Turnstile too
                page_tok = await js(page, '''
                    document.querySelector('input[name="cf-turnstile-response"]')?.value ||
                    (typeof turnstile !== "undefined" ? turnstile.getResponse() : null) || ""
                ''')
                if page_tok and len(page_tok) > 20:
                    token = page_tok
                    print(f'  Page token refreshed')
                else:
                    print(f'  No fresh token, reusing old')
            await asyncio.sleep(1)

    browser.stop()

    print('\n' + '=' * 60)
    print('SUMMARY')
    ok = 0
    for name, addr, success, detail in results:
        tag = 'OK' if success else str(detail)[:60]
        if success: ok += 1
        print(f'  {name:<18} {addr[:10]}... | {tag}')
    print(f'\nTotal: {ok}/{len(results)} claimed')

if __name__ == '__main__':
    asyncio.run(main())
