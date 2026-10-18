#!/usr/bin/env python3
"""
Elysium Testnet Faucet Claimer v7
Uses nodriver (undetected-chromedriver successor) — patches Chrome binary
to remove all automation indicators at the native level.
"""
import asyncio
import json
import os
import sys
import time

FAUCET_URL = 'https://elysium.kinetiq.xyz/testnet-faucet'

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
    print('ELYSIUM FAUCET v7 — nodriver (undetected Chrome)')
    print(time.strftime('%Y-%m-%d %H:%M:%S %Z'))
    print(f'DISPLAY={os.environ.get("DISPLAY", "NOT SET")}')
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
        ],
    )

    page = await browser.get(FAUCET_URL)
    print('Page loaded. Waiting for init...')
    await asyncio.sleep(5)

    # Debug: check fingerprint state
    debug = await page.evaluate('''() => {
        return {
            webdriver: navigator.webdriver,
            platform: navigator.platform,
            hardwareConcurrency: navigator.hardwareConcurrency,
            hasChrome: !!window.chrome,
        }
    }''')
    print(f'Browser state: {json.dumps(debug)}')

    results = []

    for i, (name, addr) in enumerate(all_wallets):
        print(f'\n--- [{i+1}/{len(all_wallets)}] {name}: {addr[:10]}... ---')

        # Call fetch through the page wrapper
        resp_raw = await page.evaluate(f'''async () => {{
            try {{
                const r = await fetch('/api/faucet/testnet', {{
                    method: 'POST',
                    headers: {{ 'Content-Type': 'application/json' }},
                    body: JSON.stringify({{ address: '{addr}', captchaToken: '' }}),
                }});
                const body = await r.text();
                return JSON.stringify({{ status: r.status, body }});
            }} catch (e) {{
                return JSON.stringify({{ error: e.message }});
            }}
        }}''')

        try:
            resp = json.loads(resp_raw)
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

        # Early stop if first 2 both fail with captcha
        if i == 1 and all(not r[2] and 'captcha' in str(r[3]) for r in results):
            print('\n[!] First 2 wallets both got captcha error — stopping early.')
            break

        if i < len(all_wallets) - 1:
            await asyncio.sleep(4)

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
