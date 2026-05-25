#!/usr/bin/env python3
"""Register a single Solana-keyed lightwalletd node to DePINZcash backend.

Generates a fresh ed25519 keypair, signs the canonical registration message
(see /root/dz-audit/server/src/auth.rs), POSTs to /api/nodes/register, and
persists secrets + response under /root/depinz/wallets/.

Usage:
  python3 register_one.py <wallet_id_int>      # e.g. 1 -> wallet-001
  python3 register_one.py <id> --proxy LINE    # proxy of form ip:port:user:pass
"""
import sys, os, json, time, secrets, argparse
from datetime import datetime, timezone
from pathlib import Path
import urllib.request, urllib.error
import nacl.signing
import base58

API_BASE = os.environ.get('DEPINZ_API', 'https://api.zcashdepin.com')
WALLET_DIR = Path('/root/depinz/wallets')
LOG_DIR = Path('/root/depinz/logs')

def make_keypair():
    sk = nacl.signing.SigningKey.generate()
    pk_bytes = sk.verify_key.encode()
    pubkey_b58 = base58.b58encode(pk_bytes).decode()
    return sk, pubkey_b58

def registration_message(wallet, nonce, ts, kind, network, label):
    # Mirror /root/dz-audit/server/src/auth.rs registration_message()
    return (
        f'depinzcash:register:v1\n{wallet}\n{nonce}\n{ts}\n{kind}\n{network}\n{label}\n'
    ).encode()

def proxy_to_url(proxy_line):
    # proxy_line: ip:port:user:pass
    ip, port, user, pw = proxy_line.strip().split(':')
    return f'http://{user}:{pw}@{ip}:{port}'

def http_post_json(url, body, proxy_url=None, timeout=30):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method='POST',
                                  headers={'Content-Type': 'application/json'})
    if proxy_url:
        handler = urllib.request.ProxyHandler({'http': proxy_url, 'https': proxy_url})
        opener = urllib.request.build_opener(handler)
    else:
        opener = urllib.request.build_opener()
    try:
        resp = opener.open(req, timeout=timeout)
        return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode())
        except Exception:
            body = e.read().decode(errors='replace')
        return e.code, body

def register(wallet_id, proxy_line=None, kind='lightwalletd', label_override=None, dry_run=False):
    sk, pubkey = make_keypair()
    nonce = secrets.token_hex(20)
    ts = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    label = label_override if label_override is not None else f'lwd-{wallet_id:03d}'
    msg = registration_message(pubkey, nonce, ts, kind, 'mainnet', label)
    sig_bytes = sk.sign(msg).signature
    sig_b58 = base58.b58encode(sig_bytes).decode()
    body = {
        'wallet': pubkey,
        'signature': sig_b58,
        'nonce': nonce,
        'timestamp': ts,
        'kind': kind,
        'label': label,
    }
    if dry_run:
        return {'dry_run': True, 'body': body, 'wallet_id': wallet_id}

    proxy_url = proxy_to_url(proxy_line) if proxy_line else None
    status, resp = http_post_json(f'{API_BASE}/api/nodes/register', body, proxy_url=proxy_url)

    record = {
        'wallet_id': f'wallet-{wallet_id:03d}',
        'pubkey_b58': pubkey,
        'secret_key_hex': sk.encode().hex(),
        'kind': kind,
        'label': label,
        'proxy_line': proxy_line,
        'register_status': status,
        'register_response': resp,
        'registered_at': ts,
    }
    if status == 200 and isinstance(resp, dict) and 'node' in resp:
        record['node_id'] = resp['node']['id']
        record['auth_token'] = resp['auth_token']
    return record

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('wallet_id', type=int)
    p.add_argument('--proxy', default=None)
    p.add_argument('--kind', default='lightwalletd')
    p.add_argument('--label', default=None)
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--save', action='store_true', help='save secrets to /root/depinz/wallets/')
    args = p.parse_args()
    rec = register(args.wallet_id, proxy_line=args.proxy, kind=args.kind,
                   label_override=args.label, dry_run=args.dry_run)
    print(json.dumps(rec, indent=2))
    if args.save and not args.dry_run:
        WALLET_DIR.mkdir(parents=True, exist_ok=True)
        out = WALLET_DIR / f"{rec['wallet_id']}.json"
        out.write_text(json.dumps(rec, indent=2))
        os.chmod(out, 0o600)
