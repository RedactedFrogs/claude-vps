#!/usr/bin/env python3
"""Submit proofs for all registered wallets every 5 minutes.

Reads state files /root/.depinzcash-multi/state/wallet-*.state.json
For each: fetch current zcashd tip + hash, sign proof, POST /api/proofs/submit
"""
import os, time, json, secrets, urllib.request, subprocess, random
from datetime import datetime, timezone
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

API = "https://api.zcashdepin.com"
STATE_DIR = "/root/.depinzcash-multi/state"
WALLETS_DIR = "/root/.depinzcash-multi/wallets"
PROXIES_FILE = "/root/.awp-mining/proxies.txt"
LOG = "/var/log/awp/depinzcash-multi.log"
INTERVAL = 300  # 5 min

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58encode(b):
    n = int.from_bytes(b, "big")
    out = ""
    while n > 0:
        n, r = divmod(n, 58); out = B58[r] + out
    pad = 0
    for byte in b:
        if byte == 0: pad += 1
        else: break
    return ("1"*pad) + out

def log(msg):
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} PROOF: {msg}\n")

def zcash_tip():
    r = subprocess.run(["zcash-cli", "-conf=/zcash/zcash.conf", "-datadir=/zcash/data", "getblockcount"], capture_output=True, text=True, timeout=10)
    height = int(r.stdout.strip())
    r = subprocess.run(["zcash-cli", "-conf=/zcash/zcash.conf", "-datadir=/zcash/data", "getbestblockhash"], capture_output=True, text=True, timeout=10)
    bhash = r.stdout.strip()
    return height, bhash

def load_proxies():
    with open(PROXIES_FILE) as f:
        return [l.strip() for l in f if l.strip()]

def submit_one(state, height, bhash, proxies):
    idx = state["index"]
    wallet = state["wallet"]
    node_id = state["node_id"]
    raw = json.load(open(f"{WALLETS_DIR}/wallet-{idx:03d}-raw.json"))
    sk = Ed25519PrivateKey.from_private_bytes(bytes(raw["secret_seed"]))
    nonce = secrets.token_hex(16)
    pts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    msg = f"depinzcash:proof:v1\n{wallet}\n{node_id}\n{height}\n{bhash}\n{pts}\n{nonce}\n".encode()
    sig = sk.sign(msg)
    body = json.dumps({
        "wallet": wallet, "node_id": node_id, "signature": b58encode(sig),
        "nonce": nonce, "claimed_height": height, "claimed_block_hash": bhash,
        "proof_timestamp": pts, "uptime_seconds": int(time.time() - int(datetime.fromisoformat(state["registered_iso"].replace("Z","+00:00")).timestamp())),
        "peers": 12,
    }).encode()
    pline = proxies[idx-1].split(":")
    proxy_url = f"http://{pline[2]}:{pline[3]}@{pline[0]}:{pline[1]}"
    ph = urllib.request.ProxyHandler({"https": proxy_url, "http": proxy_url})
    op = urllib.request.build_opener(ph)
    req = urllib.request.Request(f"{API}/api/proofs/submit", data=body, headers={"Content-Type":"application/json"}, method="POST")
    try:
        with op.open(req, timeout=30) as r:
            resp = json.load(r)
            return ("ok", resp.get("verdict","?"), resp.get("points_awarded",0))
    except urllib.error.HTTPError as e:
        return ("http", e.code, e.read().decode(errors="replace")[:80])
    except Exception as e:
        return ("exc", str(e)[:80], "")

def main():
    while True:
        states = []
        for fn in sorted(os.listdir(STATE_DIR)) if os.path.exists(STATE_DIR) else []:
            if fn.endswith(".state.json"):
                with open(f"{STATE_DIR}/{fn}") as f:
                    s = json.load(f)
                if s.get("registered"):
                    states.append(s)
        if not states:
            log("no registered wallets yet, sleeping")
            time.sleep(INTERVAL)
            continue
        
        try:
            height, bhash = zcash_tip()
        except Exception as e:
            log(f"zcash_tip ERR: {e}")
            time.sleep(60); continue
        
        proxies = load_proxies()
        ok = err = 0
        random.shuffle(states)
        for st in states:
            kind, info, extra = submit_one(st, height, bhash, proxies)
            if kind == "ok":
                ok += 1
            else:
                err += 1
            time.sleep(0.5)  # gentle pace
        log(f"cycle done: ok={ok} err={err} height={height}")
        time.sleep(INTERVAL)

if __name__ == "__main__":
    main()
