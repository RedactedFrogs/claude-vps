#!/usr/bin/env python3
"""Generate N Solana keypairs in DePINZcash CLI format."""
import json, os, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

OUT_DIR = "/root/.depinzcash-multi/wallets"
N = int(sys.argv[1]) if len(sys.argv) > 1 else 250

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

os.makedirs(OUT_DIR, exist_ok=True)
generated = []
for i in range(1, N+1):
    fn = f"{OUT_DIR}/wallet-{i:03d}.json"
    if os.path.exists(fn):
        continue
    sk = Ed25519PrivateKey.generate()
    seed = sk.private_bytes(encoding=serialization.Encoding.Raw, format=serialization.PrivateFormat.Raw, encryption_algorithm=serialization.NoEncryption())
    pk = sk.public_key().public_bytes(encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw)
    full64 = seed + pk
    wallet = b58encode(pk)
    # DePINZcash CLI format
    cli_format = {"keypair_b58": b58encode(full64)}
    with open(fn, "w") as f:
        json.dump(cli_format, f)
    os.chmod(fn, 0o600)
    # Also keep raw format for our scripts
    raw_fn = f"{OUT_DIR}/wallet-{i:03d}-raw.json"
    raw = {"wallet": wallet, "secret_seed": list(seed), "solana_keypair_v1": list(full64),
           "index": i, "created_iso": __import__("datetime").datetime.utcnow().isoformat()+"Z"}
    with open(raw_fn, "w") as f:
        json.dump(raw, f)
    os.chmod(raw_fn, 0o600)
    generated.append((i, wallet))

print(f"generated {len(generated)} new wallets (total in dir: {len([f for f in os.listdir(OUT_DIR) if f.endswith('.json') and not f.endswith('-raw.json')])})")
if generated:
    print(f"first: {generated[0]}")
    print(f"last:  {generated[-1]}")
