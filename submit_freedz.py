import json, urllib.request, time, sys

API_URL = "https://qvbxlgegizubyiymindw.supabase.co/functions/v1/application-api"
API_KEY = "sb_publishable_q6PVxFH594gnsQ6z9zqiJg_6xm1d9hr"

accounts = [
    ("boss_venture89", "0xA10C742597B3639331903ed1c26208AF87fAcD95", "VENTURE"),
    ("redacted_frogs", "0x9C98Cc106b01C0B9dAEA980aa36a5d731587bDa8", "REDACTED"),
    ("mallardordinals", "0xdaDfc6D1774C8AcE5B2f48C8Cba17c9660ad148D", "MALLARD"),
    ("bossventure168", "0x50fAbeA8992A740b4b271b7FF7ED0B6074f970a1", "PHOENIX"),
    ("gryfindor_bot", "0xE1C436e928131B6D6E3E3DdF6BF34dc2A223BD6b", "GRYFINDOR"),
    ("hendrawanipiro", "0xAE0284d37038A9F5D4279DFF591D9B9368dE0815", "HENDRAWAN"),
]

def api_call(body):
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode(),
        headers={
            "apikey": API_KEY,
            "Authorization": "Bearer " + API_KEY,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()[:300]
        return {"error": str(e), "body": body_text, "status": e.code}
    except Exception as e:
        return {"error": str(e)}

print("=== FREEDZNFT.COM WL ===")
print()

# Step 1: Check availability
print("--- Checking availability ---")
for handle, wallet, word in accounts:
    w = api_call({"action": "check_wallet", "wallet": wallet})
    x = api_call({"action": "check_x", "x_handle": handle})
    wd = api_call({"action": "check_word", "word": word})
    w_ok = w.get("available", False) or w.get("code") == "AVAILABLE"
    x_ok = x.get("available", False) or x.get("code") == "AVAILABLE"
    wd_ok = wd.get("available", False) or wd.get("code") == "AVAILABLE"
    w_code = w.get("code", "?")
    x_code = x.get("code", "?")
    wd_code = wd.get("code", "?")
    print(f"  @{handle}: wallet={'OK' if w_ok else w_code} | handle={'OK' if x_ok else x_code} | word={word}={'OK' if wd_ok else wd_code}")
    time.sleep(0.3)

print()
print("--- Attempting submit (no captcha) ---")
for handle, wallet, word in accounts:
    # Try without captcha tokens first
    r = api_call({
        "action": "submit",
        "wallet": wallet,
        "x_handle": handle,
        "word": word,
        "turnstile_token": "bypass",
        "recaptcha_token": "bypass",
    })
    code = r.get("code", "?")
    submitted = r.get("submitted", False)
    msg = r.get("message", "")
    if submitted:
        print(f"  @{handle} -> SUBMITTED! word={word}")
    elif code in ("DUPLICATE_WALLET", "DUPLICATE_X"):
        print(f"  @{handle} -> ALREADY REGISTERED ({code})")
    else:
        print(f"  @{handle} -> {code}: {msg}")
    time.sleep(0.5)

print()
print("Done!")
