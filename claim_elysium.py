#!/usr/bin/env python3
"""
Elysium Testnet Faucet Claimer
Phase 1: Discover API endpoint from page source
Phase 2: Claim for each wallet
"""
import json, re, sys, time, subprocess, urllib.request, urllib.parse, ssl

FAUCET_URL = "https://elysium.kinetiq.xyz/testnet-faucet"
BASE_URL = "https://elysium.kinetiq.xyz"

# Wallets to claim (main wallet already claimed - skip)
WALLETS = [
    ("validator",      "0x9C98Cc106b01C0B9dAEA980aa36a5d731587bDa8"),
    ("mallardordinals","0xdaDfc6D1774C8AcE5B2f48C8Cba17c9660ad148D"),
    ("bossventure168", "0x50fAbeA8992A740b4b271b7FF7ED0B6074f970a1"),
    ("gryfindor_bot",  "0xE1C436e928131B6D6E3E3DdF6BF34dc2A223BD6b"),
    ("hendrawanipiro", "0xAE0284d37038A9F5D4279DFF591D9B9368dE0815"),
]

# Add first 5 bot wallets from pixelpals
BOT_WALLET_FILE = "/home/boss/.pixelpals_wallets.json"

def load_bot_wallets(n=5):
    try:
        with open(BOT_WALLET_FILE) as f:
            data = json.load(f)
        wallets = []
        for i, w in enumerate(data[:n]):
            addr = w.get("address") or w.get("wallet") or w.get("addr", "")
            if addr:
                wallets.append((f"bot_{i}", addr))
        return wallets
    except Exception as e:
        print(f"  [!] Can't load bot wallets: {e}")
        return []

def fetch(url, headers=None, data=None, method="GET"):
    hdrs = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs, data=data, method=method)
    ctx = ssl.create_default_context()
    resp = urllib.request.urlopen(req, timeout=20, context=ctx)
    return resp.read().decode("utf-8", errors="replace")

def discover_api():
    """Fetch faucet page, find JS bundles, search for API endpoint"""
    print("[1] Fetching faucet page...")
    html = fetch(FAUCET_URL)

    # Check for Turnstile
    has_turnstile = "challenges.cloudflare.com" in html or "turnstile" in html.lower()
    print(f"  Turnstile detected: {has_turnstile}")

    # Find all JS bundle URLs
    js_urls = re.findall(r'src="(/_next/static/[^"]+\.js)"', html)
    print(f"  Found {len(js_urls)} JS bundles")

    # Also check __NEXT_DATA__
    nd = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if nd:
        print("  Found __NEXT_DATA__")
        try:
            ndata = json.loads(nd.group(1))
            print(f"  Build ID: {ndata.get('buildId','?')}")
        except:
            pass

    # Search page HTML for common faucet API patterns
    api_patterns = re.findall(r'["\'](/api/[^"\']*)["\']]', html)
    api_patterns += re.findall(r'["\'](https?://[^"\'])*(?:faucet|drip|claim)[^"\']*)["\']]', html)
    if api_patterns:
        print(f"  API patterns in HTML: {api_patterns}")

    # Fetch and search JS bundles for API endpoints
    found_endpoints = []
    for js_url in js_urls:
        full_url = BASE_URL + js_url
        try:
            js = fetch(full_url)
            apis = re.findall(r'["\'](/api/[^"\']){2,60})["\']]', js)
            apis += re.findall(r'fetch\(["\'](([^"\']*)["\']]', js)
            apis += re.findall(r'["\'](https?://[^"\'])*(?:faucet|drip|claim|send)[^"\']*)["\']]', js)
            posts = re.findall(r'method:\s*["\']]POST["\']]', js)
            ts = re.findall(r'turnstile|cf-turnstile|challenges\.cloudflare', js, re.I)

            relevant = apis + ([f"(has POST in {js_url})"] if posts else []) + ([f"(turnstile ref in {js_url})"] if ts else [])
            if relevant:
                found_endpoints.extend(relevant)
                print(f"  [{js_url[-30:]}] Found: {relevant[:5]}")
        except Exception as e:
            pass

    inline_apis = re.findall(r'fetch\(["\'](([^"\']*)["\']]', html)
    if inline_apis:
        found_endpoints.extend(inline_apis)
        print(f"  Inline fetch calls: {inline_apis}")

    found_endpoints = list(set(found_endpoints))
    return found_endpoints, has_turnstile, html

def try_claim(endpoint, wallet_addr, turnstile_token=""):
    body = json.dumps({"address": wallet_addr})
    if turnstile_token:
        body = json.dumps({"address": wallet_addr, "turnstileToken": turnstile_token})

    url = endpoint if endpoint.startswith("http") else BASE_URL + endpoint
    try:
        resp = fetch(url,
                     headers={"Content-Type": "application/json"},
                     data=body.encode(),
                     method="POST")
        return resp
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")[:500]
        return f"HTTP {e.code}: {err_body}"
    except Exception as e:
        return f"ERROR: {e}"

def main():
    print("=" * 50)
    print("ELYSIUM TESTNET FAUCET CLAIMER")
    print("=" * 50)

    endpoints, has_turnstile, html = discover_api()
    print(f"\n[*] Discovered endpoints: {endpoints}")
    print(f"[*] Turnstile: {has_turnstile}")

    if not endpoints:
        print("\n[!] No endpoints found in JS. Trying common patterns...")
        common = [
            "/api/faucet", "/api/drip", "/api/claim",
            "/api/testnet-faucet", "/api/faucet/claim",
            "/api/faucet/drip", "/api/send",
        ]
        for ep in common:
            print(f"  Testing {ep}...")
            result = try_claim(ep, "0x0000000000000000000000000000000000000001")
            if "404" not in str(result) and "Not Found" not in str(result):
                print(f"  -> Response: {str(result)[:200]}")
                endpoints.append(ep)
            time.sleep(0.3)

    if not endpoints:
        print("\n[!] Could not discover API endpoint.")
        print("    Try: node claim_elysium.mjs --discover-only")
        print("    (Puppeteer version can intercept network requests)")
        sys.exit(1)

    all_wallets = WALLETS.copy()
    bot_wallets = load_bot_wallets(5)
    all_wallets.extend(bot_wallets)
    print(f"\n[2] Total wallets to claim: {len(all_wallets)}")

    faucet_ep = endpoints[0]
    print(f"\n[3] Claiming via: {faucet_ep}")
    print("-" * 50)

    for name, addr in all_wallets:
        print(f"  {name:20s} | {addr} | ", end="", flush=True)
        result = try_claim(faucet_ep, addr)
        print(str(result)[:150])
        time.sleep(1)

    print("\nDone!")

if __name__ == "__main__":
    main()
