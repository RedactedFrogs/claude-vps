#!/usr/bin/env python3
"""
Elysium Testnet Faucet Claimer v12
Fix: Use addScriptToEvaluateOnNewDocument so hooks persist across navigation.
Strategy: nodriver + intercept wrapper + render Turnstile + CDP click.
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
        sz = os.path.getsize(path)
        print(f'  [ss] {path} ({sz//1024}KB)')
    except Exception as e:
        print(f'  [ss] fail: {e}')

async def human_click(page, x, y):
    import nodriver.cdp.input_ as inp
    jx, jy = x + random.uniform(-40, 40), y + random.uniform(-30, 30)
    await page.send(inp.dispatch_mouse_event(type_='mouseMoved', x=jx, y=jy))
    await asyncio.sleep(random.uniform(0.08, 0.2))
    await page.send(inp.dispatch_mouse_event(type_='mouseMoved', x=x, y=y))
    await asyncio.sleep(random.uniform(0.05, 0.15))
    await page.send(inp.dispatch_mouse_event(
        type_='mousePressed', x=x, y=y, button=inp.MouseButton.LEFT, click_count=1))
    await asyncio.sleep(random.uniform(0.06, 0.12))
    await page.send(inp.dispatch_mouse_event(
        type_='mouseReleased', x=x, y=y, button=inp.MouseButton.LEFT, click_count=1))

async def main():
    import nodriver as uc

    print('=' * 60)
    print('ELYSIUM FAUCET v12 — nodriver + persistent hooks + Turnstile')
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

    page = await browser.get('about:blank')

    # === Persistent hook: survives page navigation ===
    import nodriver.cdp.page as cdp_page
    await page.send(cdp_page.add_script_to_evaluate_on_new_document(source='''
        window.__fd = { xih: [], tsToken: null, tsErr: null, claimResult: null };

        // Trap wrapper's fetch replacement so we can wrap IT
        const _real = window.fetch.bind(window);
        let _hooked = false;
        const _desc = Object.getOwnPropertyDescriptor(window, 'fetch') || {};
        Object.defineProperty(window, 'fetch', {
            get() { return window.__hookedFetch || _real; },
            set(fn) {
                if (fn === _real || _hooked) { window.__hookedFetch = fn; return; }
                _hooked = true;
                const wrapper = fn;
                window.__hookedFetch = async function(url, opts) {
                    if (typeof url === 'string' && url.includes('/api/faucet')) {
                        // Capture headers
                        const h = {};
                        if (opts && opts.headers) {
                            if (opts.headers instanceof Headers)
                                opts.headers.forEach((v,k) => h[k] = v.substring(0,300));
                            else
                                for (const [k,v] of Object.entries(opts.headers)) h[k] = String(v).substring(0,300);
                        }
                        window.__fd.xih.push(h);
                        // Inject Turnstile token
                        if (window.__fd.tsToken && opts && opts.body) {
                            try {
                                const b = JSON.parse(opts.body);
                                b.captchaToken = window.__fd.tsToken;
                                opts = Object.assign({}, opts, {body: JSON.stringify(b)});
                                console.log('[v12] injected TS token');
                            } catch(e) {}
                        }
                    }
                    return wrapper.call(this, url, opts);
                };
            },
            configurable: true,
        });
    '''))

    print('\nLoading faucet page...')
    await page.get(FAUCET_URL)
    await asyncio.sleep(10)
    print('Page loaded.')

    # === Explore DOM ===
    print('\n=== DOM Exploration ===')
    dom_raw = await page.evaluate('''JSON.stringify((() => {
        const r = {};
        r.title = document.title;
        r.forms = document.querySelectorAll('form').length;
        r.inputs = [...document.querySelectorAll('input')].map(i => ({
            type:i.type, name:i.name||'', id:i.id||'', ph:i.placeholder?.substring(0,40)||''
        }));
        r.buttons = [...document.querySelectorAll('button')].map(b => ({
            txt: b.textContent?.trim().substring(0,40), disabled: b.disabled
        }));
        r.tsIframes = document.querySelectorAll('iframe[src*="turnstile"],iframe[src*="challenges.cloudflare"]').length;
        r.cfWidgets = document.querySelectorAll('.cf-turnstile,[class*=turnstile]').length;
        r.hasTS = typeof window.turnstile !== 'undefined';
        r.hookOK = typeof window.__fd !== 'undefined';
        r.xihCount = window.__fd ? window.__fd.xih.length : -1;
        r.wd = navigator.webdriver;
        return r;
    })())''')
    print(f'DOM: {dom_raw}')
    await take_ss(page, '01_loaded')

    # === Check if the page already has a Turnstile widget ===
    has_page_ts = False
    try:
        dom = json.loads(dom_raw) if dom_raw else {}
        has_page_ts = dom.get('tsIframes', 0) > 0 or dom.get('cfWidgets', 0) > 0 or dom.get('hasTS', False)
    except:
        pass

    # === Phase 1: Quick test to see fingerprint ===
    print('\n=== Phase 1: Fingerprint test ===')
    await page.evaluate('''(async()=>{
        try {
            const r = await fetch('/api/faucet/testnet', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({address:'0x0000000000000000000000000000000000000001', captchaToken:''})
            });
            window.__fd.testResult = JSON.stringify({s:r.status, b:await r.text()});
        } catch(e) { window.__fd.testResult = JSON.stringify({err:e.message}); }
    })()''')
    await asyncio.sleep(5)
    test_raw = await page.evaluate('window.__fd ? window.__fd.testResult : "hook_missing"')
    print(f'Test: {test_raw}')

    # Show captured x-is-human
    xih_raw = await page.evaluate('window.__fd ? JSON.stringify(window.__fd.xih) : "[]"') or '[]'
    print(f'x-is-human headers: {xih_raw[:600]}')
    try:
        xih_list = json.loads(xih_raw)
        for h in xih_list:
            if 'x-is-human' in h:
                xd = json.loads(h['x-is-human'])
                print(f'  >> b={xd.get("b")}  v={xd.get("v")}  d={xd.get("d")}')
    except:
        pass

    # === Phase 2: Load & render Turnstile ===
    print('\n=== Phase 2: Turnstile ===')

    ts_present = await page.evaluate('typeof window.turnstile !== "undefined"')
    print(f'Turnstile API present: {ts_present}')

    if not ts_present:
        print('Loading Turnstile API...')
        await page.evaluate('''new Promise(r => {
            const s = document.createElement('script');
            s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__tsLoaded';
            window.__tsLoaded = () => { console.log('[v12] TS API loaded'); r(); };
            s.onerror = () => r();
            document.head.appendChild(s);
            setTimeout(r, 15000);
        })''')
        await asyncio.sleep(3)
        ts_present = await page.evaluate('typeof window.turnstile !== "undefined"')
        print(f'Turnstile API after load: {ts_present}')

    if not ts_present:
        print('[!] FAILED to load Turnstile API — cannot proceed')
        browser.stop()
        return

    # Render widget
    print('Rendering Turnstile widget...')
    await page.evaluate('''(() => {
        let el = document.getElementById('v12-ts');
        if (el) el.remove();
        const div = document.createElement('div');
        div.id = 'v12-ts';
        div.style.cssText = 'position:fixed;top:40%;left:50%;transform:translate(-50%,-50%);z-index:99999;background:#fff;padding:20px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
        document.body.appendChild(div);
        window.__fd.tsToken = null;
        window.__fd.tsErr = null;
        try {
            window.__fd.tsWid = turnstile.render('#v12-ts', {
                sitekey: "''' + TURNSTILE_SITEKEY + '''",
                callback: t => { window.__fd.tsToken = t; console.log('[v12] TS solved!'); },
                'error-callback': e => { window.__fd.tsErr = String(e); console.log('[v12] TS error:', e); },
                theme: 'light',
                appearance: 'always',
                retry: 'auto',
                'retry-interval': 3000,
            });
            console.log('[v12] TS widget rendered, id=' + window.__fd.tsWid);
        } catch(e) {
            window.__fd.tsErr = e.message;
            console.log('[v12] TS render error:', e);
        }
    })()''')
    await asyncio.sleep(4)

    # Find Turnstile iframe position for clicking
    box_raw = await page.evaluate('''JSON.stringify((() => {
        const c = document.getElementById('v12-ts');
        if (!c) return {err:'no container'};
        const cr = c.getBoundingClientRect();
        const iframe = c.querySelector('iframe');
        const ir = iframe ? iframe.getBoundingClientRect() : null;
        return {
            container: {x:cr.x, y:cr.y, w:cr.width, h:cr.height},
            iframe: ir ? {x:ir.x, y:ir.y, w:ir.width, h:ir.height} : null,
            iframeSrc: iframe ? iframe.src?.substring(0,100) : null,
        };
    })())''')
    print(f'Turnstile box: {box_raw}')

    await take_ss(page, '02_turnstile')

    # Click the Turnstile checkbox
    cx, cy = None, None
    try:
        bd = json.loads(box_raw)
        if bd.get('iframe'):
            cx = bd['iframe']['x'] + 28
            cy = bd['iframe']['y'] + 28
        elif bd.get('container'):
            cx = bd['container']['x'] + 28
            cy = bd['container']['y'] + 28
    except:
        pass

    if cx is not None:
        print(f'  Clicking Turnstile at ({cx:.0f}, {cy:.0f})...')
        await human_click(page, cx, cy)
    else:
        print('  [!] Cannot find Turnstile position')

    # Wait for solve
    token = None
    for t in range(120):
        await asyncio.sleep(1)
        state_raw = await page.evaluate(
            'window.__fd ? JSON.stringify({t:window.__fd.tsToken,e:window.__fd.tsErr}) : "{}"'
        ) or '{}'
        try:
            state = json.loads(state_raw)
        except:
            state = {}

        if state.get('t'):
            token = state['t']
            print(f'  TURNSTILE SOLVED in {t+1}s! Token: {token[:40]}...')
            break

        if state.get('e'):
            print(f'  TS error at {t+1}s: {state["e"]}')
            if t < 90:
                await page.evaluate('try{turnstile.reset(window.__fd.tsWid);window.__fd.tsErr=null}catch(e){}')

        if t % 20 == 19:
            print(f'  Waiting... {t+1}s')
            await take_ss(page, f'03_wait_{t+1}')
            # Re-click
            if cx is not None:
                await human_click(page, cx, cy)

    if not token:
        print('  Turnstile did NOT solve after 120s.')
        await take_ss(page, '04_timeout')

    # === Phase 3: Try claiming via page form ===
    # Check if there's a form we can use
    print('\n=== Phase 3: Claim ===')

    # Set token for fetch interceptor
    if token:
        safe = token.replace('\\', '\\\\').replace("'", "\\'")
        await page.evaluate(f"window.__fd.tsToken = '{safe}'")
        print('Token set for interceptor.')

    results = []
    for i, (name, addr) in enumerate(all_wallets):
        print(f'\n--- [{i+1}/{len(all_wallets)}] {name}: {addr[:10]}... ---')

        sa = addr.replace("'", "\\'")
        ct = (token or '').replace('\\', '\\\\').replace("'", "\\'")

        # Call API through page fetch (wrapper adds x-is-human, our hook adds tsToken)
        await page.evaluate(f"""(async()=>{{
            try {{
                const r = await fetch('/api/faucet/testnet', {{
                    method:'POST',
                    headers:{{'Content-Type':'application/json'}},
                    body: JSON.stringify({{address:'{sa}', captchaToken:'{ct}'}})
                }});
                window.__fd.claimResult = JSON.stringify({{status:r.status, body:await r.text()}});
            }} catch(e) {{
                window.__fd.claimResult = JSON.stringify({{error:e.message}});
            }}
        }})()""")
        await asyncio.sleep(4)
        raw = await page.evaluate('window.__fd.claimResult') or '{"error":"no result"}'
        try:
            resp = json.loads(raw)
        except:
            resp = {'error': str(raw)[:200]}

        body_str = resp.get('body', resp.get('error', ''))
        status = resp.get('status', 'ERR')
        print(f'  {status} | {body_str[:200]}')

        try:
            parsed = json.loads(body_str)
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
            results.append((name, addr, False, body_str[:100]))

        # Early stop if first 2 both fail with captcha/bot
        if i == 1 and all(not r[2] and ('captcha' in str(r[3]) or 'bot' in str(r[3]).lower()) for r in results):
            print('\n[!] First 2 failed with captcha/bot — stopping early.')
            break

        # Refresh Turnstile token for next wallet
        if i < len(all_wallets) - 1 and token:
            await page.evaluate('window.__fd.tsToken=null;try{turnstile.reset(window.__fd.tsWid)}catch(e){}')
            fresh = None
            for t2 in range(40):
                await asyncio.sleep(1)
                fresh = await page.evaluate('window.__fd.tsToken')
                if fresh:
                    token = fresh
                    safe = token.replace('\\', '\\\\').replace("'", "\\'")
                    await page.evaluate(f"window.__fd.tsToken = '{safe}'")
                    print(f'  Fresh token in {t2+1}s')
                    break
            if not fresh:
                print('  No fresh token, reusing old')
            await asyncio.sleep(1)

    browser.stop()

    print('\n' + '=' * 60)
    print('SUMMARY')
    print('=' * 60)
    ok = 0
    for name, addr, success, detail in results:
        tag = 'OK' if success else str(detail)[:60]
        if success:
            ok += 1
        print(f'  {name:<18} {addr[:10]}... | {tag}')
    print(f'\nTotal: {ok}/{len(results)} claimed')

if __name__ == '__main__':
    asyncio.run(main())
