import json, urllib.request, time

accounts = [
    ("boss_venture89", "0xA10C742597B3639331903ed1c26208AF87fAcD95"),
    ("redacted_frogs", "0x9C98Cc106b01C0B9dAEA980aa36a5d731587bDa8"),
    ("mallardordinals", "0xdaDfc6D1774C8AcE5B2f48C8Cba17c9660ad148D"),
    ("bossventure168", "0x50fAbeA8992A740b4b271b7FF7ED0B6074f970a1"),
    ("gryfindor_bot", "0xE1C436e928131B6D6E3E3DdF6BF34dc2A223BD6b"),
    ("hendrawanipiro", "0xAE0284d37038A9F5D4279DFF591D9B9368dE0815"),
]

print("=== UNRULY.INK WL ===")
for handle, wallet in accounts:
    body = json.dumps({
        "handle": handle,
        "wallet": wallet,
        "tasks": {"follow": True, "like": True, "repost": True, "reply": True}
    }).encode()
    req = urllib.request.Request(
        "https://unruly.ink/api/apply",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read().decode())
        app = data.get("application", {})
        existing = data.get("existing", False)
        status = "ALREADY EXISTS" if existing else "OK (#%s)" % app.get("id", "?")
        print("  @%s -> %s" % (handle, status))
    except Exception as e:
        err = ""
        if hasattr(e, "read"):
            err = e.read().decode()[:200]
        print("  @%s -> ERROR: %s %s" % (handle, e, err))
    time.sleep(0.5)

print("\n=== STRKWORLD.COM (ArgentX) ===")
strk_body = json.dumps({
    "address": "0x04aB3F3c24557fF8b0169dC9E830E0f4178c9569a010DdC0dc7a0d30A79a7407",
    "walletName": "ArgentX",
    "tweetUrl": "https://x.com/boss_venture89/status/1234567890123456789",
    "followed": True
}).encode()
req = urllib.request.Request(
    "https://strkworld.com/api/join",
    data=strk_body,
    headers={"Content-Type": "application/json"},
    method="POST"
)
try:
    resp = urllib.request.urlopen(req, timeout=15)
    print("  ArgentX -> OK: %s" % resp.read().decode()[:200])
except Exception as e:
    err = ""
    if hasattr(e, "read"):
        err = e.read().decode()[:200]
    print("  ArgentX -> ERROR: %s %s" % (e, err))

print("\nDone!")
