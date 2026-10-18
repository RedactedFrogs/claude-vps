#!/usr/bin/env python3
"""
Elysium Testnet Faucet Claimer v10
Strategy: Playwright + Firefox (totally different fingerprint from Chrome).
Firefox lacks WebGL debug extension, has different canvas/font rendering.
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
    from playwright.async_api import async_playwright

    print('=' * 60)
    print('ELYSIUM FAUCET v10 — Playwright + Firefox')
    print(time.strftime('%Y-%m-%d %H:%M:%S WIB', time.gmtime(time.time() + 7*3600)))
    print(f'DISPLAY={os.environ.get("DISPLAY", "NOT SET")}')
    print('=' * 60)

    all_wallets = WALLETS + load_bot_wallets(4)
    print(f'Wallets: {len(all_wallets)}')

    async with async_playwright() as pw:
        browser = await pw.firefox.launch(
            headless=False,
            args=['--width=1366', '--height=768'],
        )
        context = await browser.new_context(
            viewport={'width': 1366, 'height': 768},
            locale='en-US',
            timezone_id='Asia/Jakarta',
            user_agent='Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0',
        )
        page = await context.new_page()

        # Capture API responses and headers
        captured = {'xih': None, 'responses': []}

        async def on_request(request):
            if '/api/faucet' in request.url:
                headers = request.headers
                xih = headers.get('x-is-human', '')
                if xih:
                    captured['xih'] = xih
                    try:
                        data = json.loads(xih)
                        print(f'  [HDR] x-is-human: b={data.get("b")} v={data.get("v")} d={data.get("d")}')
                    except:
                        print(f'  [HDR] x-is-human: {xih[:100]}')

        async def on_response(response):
            if '/api/faucet' in response.url:
                try:
                    body = await response.text()
                    captured['responses'].append({'status': response.status, 'body': body})
                    print(f'  [API] {response.status} {body[:200]}')
                except:
                    pass

        page.on('request', on_request)
        page.on('response', on_response)

        print('Loading faucet page...')
        await page.goto(FAUCET_URL, wait_until='load', timeout=60000)
        print('Page loaded. Waiting 10s for JS init...')
        await asyncio.sleep(10)

        # Debug browser state
        debug = await page.evaluate('''() => JSON.stringify({
            webdriver: navigator.webdriver,
            platform: navigator.platform,
            hw: navigator.hardwareConcurrency,
            ts: !!window.turnstile,
            ua: navigator.userAgent.slice(0, 60),
        })''')
        print(f'Firefox state: {debug}')

        # Phase 1: Test API call to see fingerprint result
        print('\n=== Phase 1: Test API call ===')
        result = await page.evaluate('''async (addr) => {
            try {
                const r = await fetch('/api/faucet/testnet', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({address: addr, captchaToken: ''}),
                });
                return {status: r.status, body: await r.text()};
            } catch(e) { return {error: e.message}; }
        }''', all_wallets[0][1])
        print(f'Result: {json.dumps(result)[:300]}')

        try:
            parsed = json.loads(result.get('body', ''))
        except:
            parsed = {}

        if parsed.get('status') == 'ok':
            print('DIRECT CALL WORKS WITH FIREFOX!')
            approach = 'direct'
        elif parsed.get('status') == 'cooldown':
            print('COOLDOWN — means it was claimed before. But Firefox fingerprint likely works!')
            approach = 'direct'
        elif parsed.get('error') == 'captcha':
            print('Captcha needed — Firefox fingerprint b=0 too. Trying Turnstile...')
            approach = 'turnstile'
        elif parsed.get('error') == 'bot':
            print('Bot detected — header missing or invalid')
            approach = 'turnstile'
        else:
            print(f'Unexpected: {parsed}')
            approach = 'turnstile'

        results = []

        if approach == 'direct':
            # Firefox fingerprint works! Claim all wallets directly
            for i, (name, addr) in enumerate(all_wallets):
                print(f'\n--- [{i+1}/{len(all_wallets)}] {name}: {addr[:10]}... ---')
                r = await page.evaluate('''async (addr) => {
                    try {
                        const r = await fetch('/api/faucet/testnet', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({address: addr, captchaToken: ''}),
                        });
                        return {status: r.status, body: await r.text()};
                    } catch(e) { return {error: e.message}; }
                }''', addr)
                body = r.get('body', r.get('error', ''))
                print(f'  {r.get("status", "ERR")} | {body[:200]}')
                try:
                    p = json.loads(body)
                except:
                    p = {}
                if p.get('status') == 'ok':
                    print(f'  SUCCESS! tx: {p.get("txHash", "n/a")}')
                    results.append((name, addr, True, p))
                elif p.get('status') == 'cooldown':
                    print(f'  COOLDOWN')
                    results.append((name, addr, False, f'cooldown {p.get("retryAt", "")}'))
                else:
                    results.append((name, addr, False, body[:100]))
                if i < len(all_wallets) - 1:
                    await asyncio.sleep(3)

        elif approach == 'turnstile':
            # Need Turnstile token. Try rendering widget and solving.
            print('\n=== Phase 2: Turnstile token ===')

            ts_loaded = await page.evaluate('typeof window.turnstile !== "undefined"')
            if not ts_loaded:
                print('Loading Turnstile API...')
                await page.evaluate('''() => new Promise((resolve, reject) => {
                    const s = document.createElement('script');
                    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__tsReady';
                    window.__tsReady = () => resolve();
                    s.onerror = () => reject('load failed');
                    document.head.appendChild(s);
                    setTimeout(resolve, 15000);
                })''')
                await asyncio.sleep(3)

            for i, (name, addr) in enumerate(all_wallets):
                print(f'\n--- [{i+1}/{len(all_wallets)}] {name}: {addr[:10]}... ---')

                # Render Turnstile
                await page.evaluate('''(sitekey) => {
                    let e = document.getElementById('ts-box');
                    if (e) e.remove();
                    let div = document.createElement('div');
                    div.id = 'ts-box';
                    div.style.cssText = 'position:fixed;bottom:50px;right:50px;z-index:99999;width:310px;height:80px;';
                    document.body.appendChild(div);
                    window.__tsToken = null;
                    window.__tsError = null;
                    try {
                        window.__tsWid = window.turnstile.render('#ts-box', {
                            sitekey: sitekey,
                            callback: t => { window.__tsToken = t; },
                            'error-callback': e => { window.__tsError = String(e); },
                            theme: 'light',
                            appearance: 'always',
                        });
                    } catch(e) { window.__tsError = e.message; }
                }''', TURNSTILE_SITEKEY)
                await asyncio.sleep(2)

                # Click Turnstile iframe area
                ts_box = await page.query_selector('#ts-box')
                if ts_box:
                    try:
                        iframe = await ts_box.query_selector('iframe')
                        if iframe:
                            print('  Clicking Turnstile iframe...')
                            await iframe.click(timeout=5000)
                    except Exception as e:
                        print(f'  Click: {e}')

                # Wait for solve
                token = None
                for t in range(60):
                    await asyncio.sleep(1)
                    state = await page.evaluate('JSON.stringify({t: window.__tsToken, e: window.__tsError})')
                    try:
                        d = json.loads(state)
                    except:
                        d = {}
                    if d.get('e'):
                        print(f'  Turnstile error: {d["e"]}')
                        break
                    if d.get('t'):
                        token = d['t']
                        print(f'  Turnstile SOLVED in {t+1}s!')
                        break
                    if t % 15 == 14:
                        print(f'  Waiting... ({t+1}s)')
                        if ts_box:
                            try:
                                iframe = await ts_box.query_selector('iframe')
                                if iframe:
                                    await iframe.click(timeout=3000)
                            except:
                                pass

                if not token:
                    print('  Turnstile timeout. Trying without token...')

                # Call API
                r = await page.evaluate('''async ([addr, token]) => {
                    try {
                        const r = await fetch('/api/faucet/testnet', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({address: addr, captchaToken: token || ''}),
                        });
                        return {status: r.status, body: await r.text()};
                    } catch(e) { return {error: e.message}; }
                }''', [addr, token or ''])
                body = r.get('body', r.get('error', ''))
                print(f'  {r.get("status", "ERR")} | {body[:200]}')
                try:
                    p = json.loads(body)
                except:
                    p = {}
                if p.get('status') == 'ok':
                    print(f'  SUCCESS! tx: {p.get("txHash", "n/a")}')
                    results.append((name, addr, True, p))
                elif p.get('status') == 'cooldown':
                    results.append((name, addr, False, f'cooldown {p.get("retryAt", "")}'))
                else:
                    results.append((name, addr, False, body[:100]))

                # Early stop
                if i == 1 and all(not r[2] and ('captcha' in str(r[3]) or 'bot' in str(r[3])) for r in results):
                    print('\n[!] First 2 failed, stopping.')
                    break

                if i < len(all_wallets) - 1:
                    await asyncio.sleep(3)

        await browser.close()

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
