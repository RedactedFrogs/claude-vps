#!/usr/bin/env python3
"""SealedPunk WL auto-claimer. Monitors spots, signs in with ETH wallet, plays game, claims."""
import sys, os, json, time, random, urllib.request, urllib.parse, http.cookiejar
from datetime import datetime

from eth_account import Account
from eth_account.messages import encode_defunct

BASE = "https://sealedpunk.com"
POLL_S = 25
LOG_FILE = "/home/boss/sealed_claimer.log"
STATUS_FILE = "/home/boss/sealed_claimer_status.json"
MAX_LOG = 2 * 1024 * 1024

WALLETS = [
    {"name": "main",      "key_file": "/home/boss/.sniper_key"},
    {"name": "validator",  "key_file": "/home/boss/.lobster_seed"},
]

def log(msg):
    ts = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > MAX_LOG:
            with open(LOG_FILE, "r") as f:
                old = f.read()
            with open(LOG_FILE, "w") as f:
                f.write(old[-MAX_LOG // 2:])
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass

def save_status(obj):
    try:
        with open(STATUS_FILE, "w") as f:
            json.dump(obj, f, indent=2)
    except Exception:
        pass

def api(path, data=None, cookies=None, method=None):
    url = BASE + path
    headers = {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}
    if cookies:
        headers["Cookie"] = cookies
    body = json.dumps(data).encode() if data is not None else None
    if method is None:
        method = "POST" if body is not None else "GET"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        set_cookie = resp.headers.get("Set-Cookie", "")
        result = json.loads(resp.read().decode())
        return result, set_cookie
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        try:
            return json.loads(body_text), ""
        except Exception:
            return {"error": body_text, "status": e.code}, ""

def extract_cookies(set_cookie_header, existing=""):
    cookies = {}
    if existing:
        for part in existing.split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                cookies[k] = v
    if set_cookie_header:
        for item in set_cookie_header.split(","):
            for part in item.split(";"):
                part = part.strip()
                if "=" in part:
                    k, v = part.split("=", 1)
                    k = k.strip()
                    if k.lower() not in ("path", "expires", "domain", "max-age", "samesite", "secure", "httponly"):
                        cookies[k] = v
                break
    return "; ".join(f"{k}={v}" for k, v in cookies.items())

def check_campaign():
    result, _ = api("/api/campaign")
    return result

def login(wallet_addr, private_key):
    log(f"  Getting nonce for {wallet_addr[:10]}...")
    nonce_resp, _ = api("/api/wallet/nonce", {"walletAddress": wallet_addr})
    if "error" in nonce_resp:
        return None, f"nonce error: {nonce_resp}"

    message = nonce_resp.get("message", "")
    if not message:
        return None, "no message in nonce response"

    log("  Signing message...")
    msg_obj = encode_defunct(text=message)
    signed = Account.sign_message(msg_obj, private_key=private_key)
    signature = signed.signature.hex()
    if not signature.startswith("0x"):
        signature = "0x" + signature

    log("  Verifying signature...")
    verify_resp, set_cookie = api("/api/wallet/verify", {
        "walletAddress": wallet_addr,
        "message": message,
        "signature": signature,
    })

    if verify_resp.get("error"):
        return None, f"verify error: {verify_resp}"

    cookies = extract_cookies(set_cookie)
    log(f"  Login OK. Cookie: {cookies[:40]}...")
    return cookies, verify_resp

def get_participant(cookies):
    result, sc = api("/api/participant/me", cookies=cookies, method="GET")
    return result

def confirm_mission(cookies):
    log("  Confirming social mission...")
    result, _ = api("/api/mission/confirm", data={}, cookies=cookies)
    return result

def start_game(cookies):
    log("  Starting game session...")
    result, _ = api("/api/game/session", data={}, cookies=cookies)
    return result

def tap_game(session_id, data, cookies):
    result, _ = api(f"/api/game/session/{session_id}/tap", data=data, cookies=cookies)
    return result

def complete_game(session_id, cookies):
    log("  Completing game...")
    result, _ = api(f"/api/game/session/{session_id}/complete", cookies=cookies)
    return result

def claim_wl(cookies):
    log("  Claiming WL spot...")
    result, _ = api("/api/claim", data={}, cookies=cookies)
    return result

def play_game(cookies):
    game = start_game(cookies)
    log(f"  Game session: {json.dumps(game)[:200]}")
    if game.get("error"):
        return game

    session_id = game.get("id") or game.get("sessionId") or game.get("session", {}).get("id")
    if not session_id:
        log(f"  Could not find session ID in: {json.dumps(game)[:200]}")
        return {"error": "no_session_id", "raw": game}

    grid_size = game.get("gridSize") or game.get("grid", {}).get("size", 16)
    fragments_needed = game.get("fragmentsNeeded") or game.get("fragments", {}).get("needed", 3)
    log(f"  Grid: {grid_size}, fragments needed: {fragments_needed}")

    found = 0
    cells_tried = set()
    max_taps = grid_size * 2 if isinstance(grid_size, int) else 50

    for attempt in range(max_taps):
        if found >= fragments_needed:
            break

        if isinstance(grid_size, int):
            cell = random.randint(0, grid_size - 1)
            while cell in cells_tried and len(cells_tried) < grid_size:
                cell = random.randint(0, grid_size - 1)
            cells_tried.add(cell)
            tap_data = {"cellIndex": cell}
        else:
            tap_data = {"cellIndex": attempt}

        result = tap_game(session_id, tap_data, cookies)
        hit = result.get("found") or result.get("hit") or result.get("fragment")
        if hit:
            found += 1
            log(f"  Fragment {found}/{fragments_needed} found at cell {tap_data}")
        time.sleep(0.3 + random.random() * 0.5)

    if found < fragments_needed:
        log(f"  Only found {found}/{fragments_needed} fragments")

    complete = complete_game(session_id, cookies)
    log(f"  Complete result: {json.dumps(complete)[:200]}")
    return complete

def claim_for_wallet(w):
    key_file = w["key_file"]
    name = w["name"]
    log(f"--- Processing wallet: {name} ---")

    try:
        with open(key_file, "r") as f:
            raw = f.read().strip()
    except Exception as e:
        log(f"  Cannot read key file: {e}")
        return {"ok": False, "error": "key_read_fail"}

    if raw.startswith("0x"):
        private_key = raw
    elif len(raw) == 64:
        private_key = "0x" + raw
    else:
        private_key = raw

    try:
        acct = Account.from_key(private_key)
        wallet_addr = acct.address
    except Exception as e:
        log(f"  Invalid key: {e}")
        return {"ok": False, "error": "invalid_key"}

    log(f"  Wallet: {wallet_addr}")

    cookies, login_result = login(wallet_addr, private_key)
    if not cookies:
        log(f"  Login failed: {login_result}")
        return {"ok": False, "error": "login_fail", "detail": str(login_result)}

    participant = get_participant(cookies)
    log(f"  Participant: {json.dumps(participant)[:200]}")

    mission_done = participant.get("missionConfirmed") or participant.get("mission", {}).get("confirmed", False)
    if not mission_done:
        mr = confirm_mission(cookies)
        log(f"  Mission confirm: {json.dumps(mr)[:200]}")

    game_done = participant.get("gameCompleted") or participant.get("game", {}).get("completed", False)
    if not game_done:
        gr = play_game(cookies)
        if gr.get("error"):
            log(f"  Game error: {json.dumps(gr)[:200]}")

    claim_result = claim_wl(cookies)
    log(f"  Claim result: {json.dumps(claim_result)[:200]}")

    if claim_result.get("error"):
        return {"ok": False, "error": claim_result.get("error")}
    return {"ok": True, "result": claim_result}

def main():
    log("=== SealedPunk Claimer started ===")
    save_status({"started": datetime.utcnow().isoformat(), "wallets": len(WALLETS), "state": "monitoring"})

    claimed = set()
    poll_count = 0

    while len(claimed) < len(WALLETS):
        try:
            campaign = check_campaign()
            wave = campaign.get("activeWave", {})
            available = wave.get("available", 0)
            status = campaign.get("status", "unknown")
            total = wave.get("spotLimit", "?")
            allocated = wave.get("allocated", "?")

            if available > 0 and status == "open":
                poll_count = 0
                log(f"SPOTS AVAILABLE! {available}/{total}")
                save_status({"state": "claiming", "available": available})

                for w in WALLETS:
                    if w["name"] in claimed:
                        continue

                    fresh = check_campaign()
                    if fresh.get("activeWave", {}).get("available", 0) <= 0:
                        log("Spots filled mid-claim, will retry next opening.")
                        break

                    result = claim_for_wallet(w)
                    if result.get("ok"):
                        log(f"SUCCESS: WL claimed for {w['name']}")
                        claimed.add(w["name"])
                    else:
                        log(f"FAILED: {w['name']} - {json.dumps(result)[:200]}")

                    time.sleep(3)
            else:
                poll_count += 1
                if poll_count % 12 == 1:
                    log(f"Monitoring... {allocated}/{total} allocated, available={available}, status={status}")
        except Exception as e:
            log(f"Poll error: {e}")

        time.sleep(POLL_S)

    log(f"=== All {len(WALLETS)} wallets claimed! ===")
    save_status({"state": "done", "claimed": len(WALLETS), "finished": datetime.utcnow().isoformat()})

if __name__ == "__main__":
    main()
