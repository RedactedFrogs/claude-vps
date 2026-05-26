#!/usr/bin/env python3
"""Pre-generate N Solana ed25519 keypairs for DePINZcash registration.

Writes /root/depinz/wallets/wallet-NNN.json (mode 0600) with secret + pubkey.
No network calls. Safe to run idle while waiting for backend to open.

Reuses /root/.awp-mining/proxies.txt one-to-one (line N ↔ wallet-N).
"""
import json, os, sys, argparse
from pathlib import Path
import nacl.signing
import base58

WALLET_DIR = Path('/root/depinz/wallets')
PROXIES_FILE = Path('/root/.awp-mining/proxies.txt')

def load_proxies():
    if not PROXIES_FILE.exists():
        return []
    return [l.strip() for l in PROXIES_FILE.read_text().splitlines() if l.strip()]

def gen_one(i, proxy_line):
    sk = nacl.signing.SigningKey.generate()
    pk_bytes = sk.verify_key.encode()
    return {
        'wallet_id': f'wallet-{i:03d}',
        'pubkey_b58': base58.b58encode(pk_bytes).decode(),
        'secret_key_hex': sk.encode().hex(),
        'proxy_line': proxy_line,
        'register_status': None,
        'node_id': None,
        'auth_token': None,
        'registered_at': None,
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--count', type=int, default=250)
    ap.add_argument('--force', action='store_true', help='overwrite existing wallet files')
    args = ap.parse_args()

    WALLET_DIR.mkdir(parents=True, exist_ok=True)
    proxies = load_proxies()
    if len(proxies) < args.count:
        print(f'WARN: only {len(proxies)} proxies, requested {args.count}', file=sys.stderr)

    created = 0
    skipped = 0
    for i in range(1, args.count + 1):
        out = WALLET_DIR / f'wallet-{i:03d}.json'
        if out.exists() and not args.force:
            skipped += 1
            continue
        proxy = proxies[i - 1] if i - 1 < len(proxies) else None
        rec = gen_one(i, proxy)
        out.write_text(json.dumps(rec, indent=2))
        os.chmod(out, 0o600)
        created += 1
    print(json.dumps({'created': created, 'skipped': skipped, 'total_target': args.count}, indent=2))

if __name__ == '__main__':
    main()
