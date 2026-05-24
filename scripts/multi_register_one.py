#!/usr/bin/env python3
"""Register one wallet via a specific HTTP proxy. Relay mode (no rpc_endpoint).

Usage: register_one.py <wallet-index>
Reads:
  /root/.depinzcash-multi/wallets/wallet-NNN-raw.json
  /root/.awp-mining/proxies.txt (line NNN-1)
Writes on success:
  /root/.depinzcash-multi/state/wallet-NNN.state.json
"""
import sys, os, json, secrets, urllib.request
from datetime import datetime, timezone
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

API = "https://api.zcashdepin.com"
KIND = "lightwalletd"
LABEL = "primary"

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

def main():
    idx = int(sys.argv[1])
    wallet_file = f"/root/.depinzcash-multi/wallets/wallet-{idx:03d}-raw.json"
    proxies_file = "/root/.awp-mining/proxies.txt"
    state_dir = "/root/.depinzcash-multi/state"
    state_file = f"{state_dir}/wallet-{idx:03d}.state.json"
    log_file = "/var/log/awp/depinzcash-multi.log"

    os.makedirs(state_dir, exist_ok=True)

    # Already registered?
    if os.path.exists(state_file):
        with open(state_file) as f:
            st = json.load(f)
        if st.get("registered"):
            print(f"wallet-{idx:03d}: already registered")
            return 0

    # Load wallet
    with open(wallet_file) as f:
        wd = json.load(f)
    wallet = wd["wallet"]
    sk = Ed25519PrivateKey.from_private_bytes(bytes(wd["secret_seed"]))

    # Load proxy line idx (1-indexed, 0-th line maps to wallet-001)
    with open(proxies_file) as f:
        proxies = [l.strip() for l in f if l.strip()]
    if idx-1 >= len(proxies):
        print(f"no proxy for index {idx}", file=sys.stderr)
        return 2
    pline = proxies[idx-1]
    parts = pline.split(":")
    if len(parts) != 4:
        print(f"bad proxy line: {pline}", file=sys.stderr); return 3
    pip, pport, puser, ppass = parts
    proxy_url = f"http://{puser}:{ppass}@{pip}:{pport}"

    # Build registration request (relay mode: no rpc_endpoint)
    nonce = secrets.token_hex(16)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    msg = f"depinzcash:register:v1\n{wallet}\n{nonce}\n{ts}\n{KIND}\nmainnet\n{LABEL}\n".encode()
    sig = sk.sign(msg)
    body = json.dumps({
        "wallet": wallet, "signature": b58encode(sig),
        "nonce": nonce, "timestamp": ts,
        "kind": KIND, "label": LABEL,
    }).encode()

    # Build proxy handler
    proxy_handler = urllib.request.ProxyHandler({"https": proxy_url, "http": proxy_url})
    opener = urllib.request.build_opener(proxy_handler)
    req = urllib.request.Request(f"{API}/api/nodes/register", data=body,
                                  headers={"Content-Type": "application/json"}, method="POST")

    try:
        with opener.open(req, timeout=30) as r:
            resp = json.load(r)
            node_id = resp["node"]["id"]
            auth = resp["auth_token"]
            state = {
                "registered": True, "wallet": wallet, "index": idx,
                "node_id": node_id, "auth_token": auth,
                "kind": KIND, "label": LABEL,
                "registered_iso": datetime.now(timezone.utc).isoformat(),
                "proxy_used": f"{pip}:{pport}",
            }
            with open(state_file, "w") as f:
                json.dump(state, f, indent=2)
            os.chmod(state_file, 0o600)
            with open(log_file, "a") as f:
                f.write(f"{ts} wallet-{idx:03d} REGISTERED node_id={node_id}\n")
            print(f"wallet-{idx:03d} REGISTERED node_id={node_id}")
            return 0
    except urllib.error.HTTPError as e:
        body_err = e.read().decode(errors="replace")[:120]
        with open(log_file, "a") as f:
            f.write(f"{ts} wallet-{idx:03d} HTTP {e.code}: {body_err}\n")
        print(f"wallet-{idx:03d} HTTP {e.code}: {body_err}", file=sys.stderr)
        return 4
    except Exception as e:
        with open(log_file, "a") as f:
            f.write(f"{ts} wallet-{idx:03d} ERR: {e}\n")
        print(f"wallet-{idx:03d} ERR: {e}", file=sys.stderr)
        return 5

if __name__ == "__main__":
    sys.exit(main())
