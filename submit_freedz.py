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

print("=== FREEDZNFT.COM WL ===")
print()

print("--- Checking availability ---")
for handle, wallet, word in accounts:
    w, _ = api_call({"action": "check_wallet", "wallet": wallet})
    time.sleep(0.5)
    x, _ = api_call({"action": "check_x", "x_handle": handle})
    time.sleep(0.5)
    wd, _ = api_call({"action": "check_word", "word": word})
    time.sleep(0.5)
    w_ok = w.get("available", False) or w.get("code") == "AVAILABLE"
    x_ok = x.get("available", False) or x.get("code") == "AVAILABLE"
    wd_ok = wd.get("available", False) or wd.get("code") == "AVAILABLE"
    w_code = w.get("code", str(w)[:60])
    x_code = x.get("code", str(x)[:60])
    wd_code = wd.get("code", str(wd)[:60])
    status_w = "AVAIL" if w_ok else ("TAKEN" if "DUPLICATE" in str(w_code) else w_code)
    status_x = "AVAIL" if x_ok else ("TAKEN" if "DUPLICATE" in str(x_code) else x_code)
    status_wd = "AVAIL" if wd_ok else ("TAKEN" if "DUPLICATE" in str(wd_code) else wd_code)
    print(f"  @{handle}: wallet={status_w} | handle={status_x} | word={word}={status_wd}")
    time.sleep(1)

print()
print("--- Attempting submit (raw response) ---")
for handle, wallet, word in accounts:
    r, raw = api_call({
        "action": "submit",
        "wallet": wallet,
        "x_handle": handle,
        "word": word,
        "turnstile_token": "test",
        "recaptcha_token": "test",
    })
    submitted = r.get("submitted", False)
    code = r.get("code", "NO_CODE")
    if submitted:
        print(f"  @{handle} -> SUBMITTED! word={word}")
    elif code in ("DUPLICATE_WALLET", "DUPLICATE_X"):
        print(f"  @{handle} -> ALREADY REGISTERED ({code})")
    else:
        print(f"  @{handle} -> {code}: {raw[:200]}")
    time.sleep(1)

print()
print("Done!")
