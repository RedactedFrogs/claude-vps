#!/usr/bin/env python3
"""
Elysium Testnet Faucet Claimer v15
Strategy: Simulate real user interaction with the page.
1. Inject minimal EIP-1193 wallet provider
2. Connect wallet via UI
3. Use page's own form + Turnstile flow
4. Click Claim button
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

async def js(page, code):
    try:
        r = await page.evaluate(code)
        return r if isinstance(r, str) else (str(r) if r is not None else None)
    except Exception as e:
        return f'PY_ERR: {e}'

async def human_click(page, x, y):
    import nodriver.cdp.input_ as inp
    jx, jy = x + random.uniform(-20, 20), y + random.uniform(-15, 15)
    await page.send(inp.dispatch_mouse_event(type_='mouseMoved', x=jx, y=jy))
    await asyncio.sleep(random.uniform(0.08, 0.2))
    await page.send(inp.dispatch_mouse_event(type_='mouseMoved', x=x, y=y))
    await asyncio.sleep(random.uniform(0.05, 0.15))
    await page.send(inp.dispatch_mouse_event(
        type_='mousePressed', x=x, y=y, button=inp.MouseButton.LEFT, click_count=1))
    await asyncio.sleep(random.uniform(0.06, 0.12))
    await page.send(inp.dispatch_mouse_event(
        type_='mouseReleased', x=x, y=y, button=inp.MouseButton.LEFT, click_count=1))

def make_provider_js(address):
    """Create minimal EIP-1193 provider that returns the given address."""
    return '''(() => {
        const addr = "''' + address + '''";
        const listeners = {};
        window.ethereum = {
            isMetaMask: true,
            selectedAddress: addr,
            chainId: "0x3938",
            networkVersion: "14648",
            _events: {},
            request: async function({method, params}) {
                console.log("[wallet] request:", method);
                switch(method) {
                    case "eth_requestAccounts":
                    case "eth_accounts":
                        return [addr];
                    case "eth_chainId":
                        return this.chainId;
                    case "net_version":
                        return this.networkVersion;
                    case "wallet_switchEthereumChain":
                        return null;
                    case "wallet_addEthereumChain":
                        if (params && params[0] && params[0].chainId) {
                            this.chainId = params[0].chainId;
                        }
                        return null;
                    case "eth_getBalance":
                        return "0x0";
                    case "personal_sign":
                    case "eth_signTypedData_v4":
                        return "0x" + "00".repeat(65);
                    default:
                        console.log("[wallet] unhandled:", method);
                        throw {code: 4200, message: "Unsupported method: " + method};
                }
            },
            on: function(event, handler) {
                if (!listeners[event]) listeners[event] = [];
                listeners[event].push(handler);
                return this;
            },
            removeListener: function(event, handler) {
                if (listeners[event]) {
                    listeners[event] = listeners[event].filter(h => h !== handler);
                }
                return this;
            },
            emit: function(event, ...args) {
                if (listeners[event]) {
                    listeners[event].forEach(h => { try { h(...args); } catch(e) {} });
                }
            },
            isConnected: () => true,
            enable: async function() { return [addr]; },
        };
        window.ethereum.providers = [window.ethereum];
        console.log("[wallet] Provider injected for", addr);
    })()''';

async def main():
    import nodriver as uc

    print('=' * 60)
    print('ELYSIUM FAUCET v15 — UI interaction + wallet provider')
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

    results = []

    for wi, (name, addr) in enumerate(all_wallets):
        print(f'\n{"="*60}')
        print(f'[{wi+1}/{len(all_wallets)}] {name}: {addr[:16]}...')
        print('=' * 60)

        page = await browser.get('about:blank')

        import nodriver.cdp.page as cdp_page
        await page.send(cdp_page.add_script_to_evaluate_on_new_document(
            source=make_provider_js(addr)
        ))
        print('  Wallet provider injected.')

        print('  Loading faucet...')
        await page.get(FAUCET_URL)
        await asyncio.sleep(10)
        print('  Page loaded.')

        dom_raw = await js(page, '''JSON.stringify((() => {
            const r = {};
            r.title = document.title;
            r.hasEth = typeof window.ethereum !== 'undefined';
            r.inputs = [...document.querySelectorAll('input:not([type=hidden])')].map(i => ({
                type:i.type, name:i.name||'', id:i.id||'', ph:i.placeholder?.substring(0,40)||'',
                vis: i.offsetParent !== null
            }));
            r.hiddenInputs = [...document.querySelectorAll('input[type=hidden]')].map(i => ({
                name:i.name||'', val:i.value?.substring(0,40)||''
            }));
            r.buttons = [...document.querySelectorAll('button')].map(b => ({
                txt: b.textContent?.trim().substring(0,50), dis: b.disabled,
                rect: (() => { const r = b.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; })()
            }));
            r.hasTS = typeof window.turnstile !== 'undefined';
            r.allText = document.body?.innerText?.substring(0, 500) || '';
            return r;
        })())''')
        print(f'  DOM: {dom_raw[:800]}')
        await take_ss(page, f'w{wi}_01_loaded')

        dom = {}
        try:
            dom = json.loads(dom_raw) if dom_raw else {}
        except:
            pass

        connect_btn = None
        claim_btn = None
        for b in dom.get('buttons', []):
            txt = b.get('txt', '').lower()
            if 'connect' in txt and b['rect']['w'] > 30:
                connect_btn = b
            if 'claim' in txt or 'request' in txt or 'drip' in txt or 'get' in txt:
                claim_btn = b

        if connect_btn and not claim_btn:
            cx = connect_btn['rect']['x'] + connect_btn['rect']['w'] // 2
            cy = connect_btn['rect']['y'] + connect_btn['rect']['h'] // 2
            print(f'  Clicking Connect at ({cx},{cy}): "{connect_btn["txt"]}"')
            await human_click(page, cx, cy)
            await asyncio.sleep(3)

            modal_raw = await js(page, '''JSON.stringify((() => {
                const r = {};
                r.buttons = [...document.querySelectorAll('button, [role=button], [class*=wallet], [class*=connect]')]
                    .filter(el => el.offsetParent !== null)
                    .map(b => ({
                        txt: b.textContent?.trim().substring(0,50),
                        rect: (() => { const r = b.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; })(),
                        cls: b.className?.substring(0,60) || ''
                    }));
                r.modals = [...document.querySelectorAll('[class*=modal], [class*=dialog], [role=dialog]')]
                    .filter(el => el.offsetParent !== null)
                    .map(m => ({cls: m.className?.substring(0,80), text: m.textContent?.trim().substring(0,200)}));
                r.text = document.body?.innerText?.substring(0, 600) || '';
                return r;
            })())''')
            print(f'  After Connect click: {modal_raw[:600]}')
            await take_ss(page, f'w{wi}_02_connect')

            try:
                modal = json.loads(modal_raw)
                for b in modal.get('buttons', []):
                    txt = b.get('txt', '').lower()
                    if any(k in txt for k in ['metamask', 'injected', 'browser', 'detected']):
                        bx = b['rect']['x'] + b['rect']['w'] // 2
                        by = b['rect']['y'] + b['rect']['h'] // 2
                        print(f'  Clicking wallet option at ({bx},{by}): "{b["txt"]}"')
                        await human_click(page, bx, by)
                        await asyncio.sleep(5)
                        break
                else:
                    for b in modal.get('buttons', []):
                        if b['rect']['w'] > 50 and b['rect']['h'] > 20:
                            bx = b['rect']['x'] + b['rect']['w'] // 2
                            by = b['rect']['y'] + b['rect']['h'] // 2
                            print(f'  Clicking first option at ({bx},{by}): "{b["txt"]}"')
                            await human_click(page, bx, by)
                            await asyncio.sleep(5)
                            break
            except:
                pass

            await asyncio.sleep(3)

        state2 = await js(page, '''JSON.stringify((() => {
            const r = {};
            r.inputs = [...document.querySelectorAll('input:not([type=hidden])')].map(i => ({
                type:i.type, ph:i.placeholder?.substring(0,50)||'', vis:i.offsetParent!==null,
                rect: (() => { const rr = i.getBoundingClientRect(); return {x:Math.round(rr.x),y:Math.round(rr.y),w:Math.round(rr.width)}; })()
            }));
            r.buttons = [...document.querySelectorAll('button')].map(b => ({
                txt: b.textContent?.trim().substring(0,50), dis: b.disabled,
                rect: (() => { const rr = b.getBoundingClientRect(); return {x:Math.round(rr.x),y:Math.round(rr.y),w:Math.round(rr.width),h:Math.round(rr.height)}; })()
            }));
            r.text = document.body?.innerText?.substring(0, 800) || '';
            return r;
        })())''')
        print(f'  Post-connect: {state2[:600]}')
        await take_ss(page, f'w{wi}_03_connected')

        try:
            s2 = json.loads(state2)
            addr_input = None
            for inp in s2.get('inputs', []):
                if inp.get('vis') and inp.get('rect', {}).get('w', 0) > 100:
                    addr_input = inp
                    break
            if addr_input:
                print(f'  Found input: placeholder="{addr_input["ph"]}"')

            for b in s2.get('buttons', []):
                txt = b.get('txt', '').lower()
                if any(k in txt for k in ['claim', 'request', 'drip', 'get test', 'faucet']):
                    claim_btn = b
                    break

            if addr_input:
                ix = addr_input['rect']['x'] + 20
                iy = addr_input['rect']['y'] + 10
                await human_click(page, ix, iy)
                await asyncio.sleep(0.3)
                import nodriver.cdp.input_ as cdp_input
                for ch in addr:
                    await page.send(cdp_input.dispatch_key_event(
                        type_='keyDown', text=ch))
                    await asyncio.sleep(random.uniform(0.02, 0.06))
                print(f'  Typed address')
                await asyncio.sleep(1)

        except Exception as e:
            print(f'  Parse error: {e}')

        print('  Attempting API claim...')
        sa = addr.replace('\\', '\\\\').replace('"', '\\"')
        await page.evaluate(f'''(async()=>{{
            try {{
                const r = await fetch('/api/faucet/testnet', {{
                    method:'POST',
                    headers:{{'Content-Type':'application/json'}},
                    body: JSON.stringify({{address:"{sa}", captchaToken:""}})
                }});
                window.__claimR = JSON.stringify({{s:r.status, b:await r.text()}});
            }} catch(e) {{
                window.__claimR = JSON.stringify({{s:0, b:e.message}});
            }}
        }})()''')
        await asyncio.sleep(4)
        raw = await js(page, 'window.__claimR || "null"')
        try:
            resp = json.loads(raw) if raw and raw != 'null' else {}
        except:
            resp = {'b': str(raw)[:200]}

        status = resp.get('s', 0)
        body = resp.get('b', '')
        print(f'  Result: {status} | {body[:200]}')

        try:
            parsed = json.loads(body)
        except:
            parsed = {}

        if parsed.get('status') == 'ok':
            tx = parsed.get('txHash', 'n/a')
            print(f'  SUCCESS! tx: {tx}')
            results.append((name, addr, True, tx))
        elif parsed.get('status') == 'cooldown':
            rt = parsed.get('retryAt', '')
            print(f'  COOLDOWN — retryAt: {rt}')
            results.append((name, addr, False, f'cooldown {rt}'))
        else:
            results.append((name, addr, False, body[:100]))

        if wi == 1 and all(not r[2] and 'captcha' in str(r[3]).lower() for r in results):
            print('\n[!] First 2 failed with captcha — stopping.')
            break

        await asyncio.sleep(2)

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
