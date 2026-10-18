#!/usr/bin/env python3
"""
Elysium Testnet Faucet Claimer v8
Strategy: nodriver + manual Turnstile widget rendering + token extraction.
Sitekey: 0x4AAAAAAFItMMT0n2NGsM3v (extracted from page HTML).
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
        result = []
        for i, w in enumerate(data[:n]):
            addr = w.get('address') or w.get('wallet') or w.get('addr')
            if addr:
                result.append((f'bot_{i}', addr))
        return result
    except Exception as e:
        print(f'  [!] Bot wallets: {e}')
        return []

async def main():
    import nodriver as uc

    print('=' * 60)
    print('ELYSIUM FAUCET v8 — nodriver + Turnstile token extraction')
    print(time.strftime('%Y-%m-%d %H:%M:%S WIB', time.gmtime(time.time() + 7*3600)))
    print(f'DISPLAY={os.environ.get("DISPLAY", "NOT SET")}')
    print(f'Turnstile sitekey: {TURNSTILE_SITEKEY}')
    print('=' * 60)

    all_wallets = WALLETS + load_bot_wallets(4)
    print(f'Wallets: {len(all_wallets)}')

    browser = await uc.start(
        headless=False,
        browser_args=[
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1366,768',
            '--lang=en-US',
            '--use-gl=angle',
            '--use-angle=swiftshader',
        ],
    )

    page = await browser.get(FAUCET_URL)
    print('Page loaded. Waiting for init...')
    await asyncio.sleep(6)

    # Debug: check browser state
    debug = await page.evaluate('JSON.stringify({webdriver: navigator.webdriver, platform: navigator.platform, hw: navigator.hardwareConcurrency, chrome: !!window.chrome})')
    print(f'Browser: {debug}')

    # Check if Turnstile API is loaded
    ts_loaded = await page.evaluate('typeof window.turnstile !== "undefined"')
    print(f'Turnstile API loaded: {ts_loaded}')

    if not ts_loaded:
        print('Loading Turnstile API manually...')
        await page.evaluate('''
            new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__tsReady';
                window.__tsReady = () => resolve(true);
                s.onerror = () => reject('script load failed');
                document.head.appendChild(s);
            })
        ''')
        await asyncio.sleep(3)
        ts_loaded = await page.evaluate('typeof window.turnstile !== "undefined"')
        print(f'Turnstile API loaded after manual inject: {ts_loaded}')

    results = []

    for i, (name, addr) in enumerate(all_wallets):
        print(f'\n--- [{i+1}/{len(all_wallets)}] {name}: {addr[:10]}... ---')

        # Step 1: Render a Turnstile widget and get token
        print('  Rendering Turnstile widget...')
        await page.evaluate('''
            (() => {
                // Remove any existing widget
                const existing = document.getElementById('ts-manual');
                if (existing) existing.remove();

                // Create container
                const div = document.createElement('div');
                div.id = 'ts-manual';
                div.style.position = 'fixed';
                div.style.bottom = '10px';
                div.style.right = '10px';
                div.style.zIndex = '99999';
                document.body.appendChild(div);

                // Reset result
                window.__tsToken = null;
                window.__tsError = null;

                // Render Turnstile
                try {
                    window.__tsWidgetId = window.turnstile.render('#ts-manual', {
                        sitekey: '''' + TURNSTILE_SITEKEY + '''',
                        callback: (token) => { window.__tsToken = token; },
                        'error-callback': (err) => { window.__tsError = String(err); },
                        'expired-callback': () => { window.__tsToken = null; },
                        theme: 'light',
                        size: 'normal',
                    });
                } catch (e) {
                    window.__tsError = e.message;
                }
            })()
        ''')

        # Wait for Turnstile to solve (up to 45 seconds)
        token = None
        for t in range(45):
            await asyncio.sleep(1)
            result_raw = await page.evaluate('JSON.stringify({token: window.__tsToken, error: window.__tsError, widgetId: window.__tsWidgetId})')
            try:
                result_data = json.loads(result_raw) if result_raw else {}
            except:
                result_data = {}

            if result_data.get('error'):
                print(f'  Turnstile ERROR: {result_data["error"]}')
                break
            if result_data.get('token'):
                token = result_data['token']
                print(f'  Turnstile SOLVED in {t+1}s! Token: {token[:40]}...')
                break
            if t % 10 == 9:
                print(f'  Waiting for Turnstile... ({t+1}s)')

        if not token:
            print(f'  Turnstile failed to solve. Trying without token...')

        # Step 2: Call the API with the token
        captcha_token = token or ''
        js_code = '''
        (async () => {
            try {
                const r = await fetch('/api/faucet/testnet', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ address: '''' + addr + '''', captchaToken: '''' + (captcha_token or '') + '''' }),
                });
                const body = await r.text();
                window.__faucet_result = JSON.stringify({ status: r.status, body: body });
            } catch (e) {
                window.__faucet_result = JSON.stringify({ error: e.message });
            }
        })()
        '''
        await page.evaluate(js_code)
        await asyncio.sleep(3)
        resp_raw = await page.evaluate('window.__faucet_result')

        try:
            resp = json.loads(resp_raw) if resp_raw else {'error': 'no result'}
        except:
            resp = {'error': f'parse error: {resp_raw}'}

        status = resp.get('status', 'ERR')
        body_str = resp.get('body', resp.get('error', ''))
        print(f'  Response: {status} | {body_str[:200]}')

        try:
            parsed = json.loads(body_str)
        except:
            parsed = {}

        if parsed.get('status') == 'ok':
            print(f'  SUCCESS! tx: {parsed.get("txHash", "n/a")}')
            results.append((name, addr, True, parsed))
        elif parsed.get('status') == 'cooldown':
            print(f'  COOLDOWN — retryAt: {parsed.get("retryAt", "unknown")}')
            results.append((name, addr, False, f'cooldown {parsed.get("retryAt", "")}'))
        else:
            results.append((name, addr, False, body_str[:100]))

        # Early stop if first 2 both fail with captcha/bot
        if i == 1 and all(not r[2] and ('captcha' in str(r[3]) or 'bot' in str(r[3])) for r in results):
            print('\n[!] First 2 wallets both failed — trying different approach...')

            # Try approach B: use page's native wrapped fetch (which adds x-is-human)
            # AND include the Turnstile token in captchaToken body field
            print('[!] Approach B: use page-wrapped fetch + Turnstile token')

            # Reset and get fresh Turnstile token
            await page.evaluate('window.turnstile.reset(window.__tsWidgetId)')
            await asyncio.sleep(2)

            for t in range(45):
                await asyncio.sleep(1)
                tr = await page.evaluate('window.__tsToken')
                if tr:
                    token = tr
                    print(f'  Fresh Turnstile token obtained in {t+1}s')
                    break

            if token:
                # Now try again with BOTH x-is-human (from wrapper) AND captchaToken
                js_b = '''
                (async () => {
                    try {
                        const r = await fetch('/api/faucet/testnet', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ address: '''' + all_wallets[0][1] + '''', captchaToken: '''' + token + '''' }),
                        });
                        const body = await r.text();
                        window.__faucet_b = JSON.stringify({ status: r.status, body: body });
                    } catch (e) {
                        window.__faucet_b = JSON.stringify({ error: e.message });
                    }
                })()
                '''
                await page.evaluate(js_b)
                await asyncio.sleep(3)
                resp_b_raw = await page.evaluate('window.__faucet_b')
                try:
                    resp_b = json.loads(resp_b_raw)
                except:
                    resp_b = {'error': resp_b_raw}
                print(f'  Approach B result: {json.dumps(resp_b)[:200]}')

                # If approach B works, redo all wallets
                try:
                    parsed_b = json.loads(resp_b.get('body', ''))
                except:
                    parsed_b = {}

                if parsed_b.get('status') == 'ok':
                    print(f'  APPROACH B SUCCESS! Retrying all wallets...')
                    results.clear()
                    results.append((all_wallets[0][0], all_wallets[0][1], True, parsed_b))

                    for j in range(1, len(all_wallets)):
                        wn, wa = all_wallets[j]
                        print(f'\n--- [{j+1}/{len(all_wallets)}] {wn}: {wa[:10]}... ---')

                        # Get fresh token
                        await page.evaluate('window.__tsToken = null; window.turnstile.reset(window.__tsWidgetId)')
                        for t in range(45):
                            await asyncio.sleep(1)
                            tk = await page.evaluate('window.__tsToken')
                            if tk:
                                print(f'  Token in {t+1}s')
                                break
                        else:
                            tk = ''

                        js_w = f'''
                        (async () => {{
                            try {{
                                const r = await fetch('/api/faucet/testnet', {{
                                    method: 'POST',
                                    headers: {{ 'Content-Type': 'application/json' }},
                                    body: JSON.stringify({{ address: '{wa}', captchaToken: '{tk or ""}' }}),
                                }});
                                const body = await r.text();
                                window.__faucet_w = JSON.stringify({{ status: r.status, body: body }});
                            }} catch (e) {{
                                window.__faucet_w = JSON.stringify({{ error: e.message }});
                            }}
                        }})()
                        '''
                        await page.evaluate(js_w)
                        await asyncio.sleep(3)
                        rw_raw = await page.evaluate('window.__faucet_w')
                        try:
                            rw = json.loads(rw_raw)
                        except:
                            rw = {'error': rw_raw}
                        print(f'  Response: {json.dumps(rw)[:200]}')
                        try:
                            pw = json.loads(rw.get('body', ''))
                        except:
                            pw = {}
                        if pw.get('status') == 'ok':
                            print(f'  SUCCESS! tx: {pw.get("txHash","n/a")}')
                            results.append((wn, wa, True, pw))
                        elif pw.get('status') == 'cooldown':
                            print(f'  COOLDOWN')
                            results.append((wn, wa, False, f'cooldown {pw.get("retryAt","")}'))
                        else:
                            results.append((wn, wa, False, rw.get('body', rw.get('error', ''))[:100]))
                        await asyncio.sleep(2)
                    break  # Exit outer loop since we redid everything
                elif parsed_b.get('status') == 'cooldown':
                    print(f'  Approach B: cooldown (means it WAS accepted before!)')
                    # Still break but note it worked previously
            break  # Break from outer loop

        # Reset Turnstile for next wallet
        if i < len(all_wallets) - 1:
            await page.evaluate('window.__tsToken = null; try { window.turnstile.reset(window.__tsWidgetId); } catch(e) {}')
            await asyncio.sleep(3)

    browser.stop()

    print('\n' + '=' * 60)
    print('SUMMARY')
    print('=' * 60)
    ok_count = 0
    for name, addr, ok, detail in results:
        st = 'OK' if ok else str(detail)[:60]
        if ok:
            ok_count += 1
        print(f'  {name:<18} | {addr[:10]}... | {st}')
    print(f'\nTotal: {ok_count} success, {len(results) - ok_count} failed out of {len(results)}')

if __name__ == '__main__':
    asyncio.run(main())
