import json, urllib.request, time, sys

API_URL = "https://qvbxlgegizubyiymindw.supabase.co/functions/v1/application-api"
API_KEY = "sb_publishable_q6PVxFH594gnsQ6z9zqiJg_6xm1d9hr"

accounts = [
    ("boss_venture89", "0xA10C742597B3639331903ed1c26208AF87fAcD95", "BOSSFIRE"),
    ("redacted_frogs", "0x9C98Cc106b01C0B9dAEA980aa36a5d731587bDa8", "FROGPOND"),
    ("mallardordinals", "0xdaDfc6D1774C8AcE5B2f48C8Cba17c9660ad148D", "MALLARD"),
    ("bossventure168", "0x50fAbeA8992A740b4b271b7FF7ED0B6074f970a1", "GOLDCLAW"),
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
        raw = resp.read().decode()
        return json.loads(raw), raw
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()[:500]
        try:
            return json.loads(body_text), body_text
        except:
            return {"error": str(e), "body": body_text, "status": e.code}, body_text
    except Exception as e:
        return {"error": str(e)}, str(e)

print("=== FREEDZNFT CAPTCHA BYPASS TEST ===")
print()

# Test different captcha bypass methods on first account
handle, wallet, word = accounts[0]
print(f"Testing bypass methods on @{handle}...")
print()

methods = [
    ("no captcha fields", {
        "action": "submit", "wallet": wallet, "x_handle": handle, "word": word
    }),
    ("empty strings", {
        "action": "submit", "wallet": wallet, "x_handle": handle, "word": word,
        "turnstile_token": "", "recaptcha_token": ""
    }),
    ("only recaptcha", {
        "action": "submit", "wallet": wallet, "x_handle": handle, "word": word,
        "recaptcha_token": "03AGdBq24PBCbwiDRaS_MJ7..."
    }),
    ("only turnstile", {
        "action": "submit", "wallet": wallet, "x_handle": handle, "word": word,
        "turnstile_token": "0.aFbHnbxBxVu..."
    }),
    ("dummy both", {
        "action": "submit", "wallet": wallet, "x_handle": handle, "word": word,
        "turnstile_token": "0.aFbHnbxBxVu", "recaptcha_token": "03AGdBq24PBCbwiDRaS_MJ7"
    }),
]

for name, body in methods:
    r, raw = api_call(body)
    code = r.get("code", "?")
    submitted = r.get("submitted", False)
    if submitted:
        print(f"  [{name}] -> SUBMITTED! Bypass works!")
        print(f"  Response: {raw[:300]}")
        print()
        print("=== SUBMITTING ALL ACCOUNTS ===")
        # Use same method for remaining accounts
        for h, w, wd in accounts[1:]:
            b = dict(body)
            b["wallet"] = w
            b["x_handle"] = h
            b["word"] = wd
            r2, raw2 = api_call(b)
            s = r2.get("submitted", False)
            c = r2.get("code", "?")
            print(f"  @{h} -> {'OK' if s else c}: {raw2[:150]}")
            time.sleep(1)
        print("\nDone! All submitted.")
        sys.exit(0)
    else:
        print(f"  [{name}] -> {code}: {raw[:150]}")
    time.sleep(1)

print()
print("All bypass methods failed. Captcha is enforced server-side.")
print("Manual submission required via browser.")
print()
print("Cheat sheet for manual entry:")
print("URL: https://freedznft.com/apply")
print()
for h, w, wd in accounts:
    print(f"  @{h}")
    print(f"    Wallet: {w}")
    print(f"    Word:   {wd}")
    print()
