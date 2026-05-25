#!/usr/bin/env python3
"""Submit a single proof for one registered wallet.

Reads /root/depinz/wallets/<wallet_id>.json (needs node_id, secret), pulls
current (height, hash) from local zcashd, signs proof message, POSTs
/api/proofs/submit. Used for first-flight verification after registration
reopens — proves end-to-end (register -> proof accepted) works before
running the full daemon.
"""
import json, os, sys, secrets, subprocess, argparse
from datetime import datetime, timezone
from pathlib import Path
import urllib.request, urllib.error
import nacl.signing
import base58

API = os.environ.get('DEPINZ_API', 'https://api.zcashdepin.com')
WALLET_DIR = Path('/root/depinz/wallets')
ZCASH_CLI = ['zcash-cli', '-conf=/zcash/zcash.conf', '-datadir=/zcash/data']

def get_tip():
    h = int(subprocess.check_output(ZCASH_CLI + ['getblockcount']).decode().strip())
    bh = subprocess.check_output(ZCASH_CLI + ['getblockhash', str(h)]).decode().strip()
    return h, bh

def proof_message(wallet, node_id, height, block_hash, ts, nonce):
    return (
        f'depinzcash:proof:v1\n{wallet}\n{node_id}\n{height}\n{block_hash}\n{ts}\n{nonce}\n'
    ).encode()

def proxy_to_url(line):
    ip, port, user, pw = line.strip().split(':')
    return f'http://{user}:{pw}@{ip}:{port}'

def submit(rec, height=None, block_hash=None, use_proxy=True):
    if not rec.get('node_id'):
        return (-1, {'err': 'wallet not registered (no node_id)'})
    sk = nacl.signing.SigningKey(bytes.fromhex(rec['secret_key_hex']))
    pubkey = rec['pubkey_b58']
    node_id = rec['node_id']

    if height is None or block_hash is None:
        height, block_hash = get_tip()

    nonce = secrets.token_hex(20)
    ts = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    msg = proof_message(pubkey, node_id, height, block_hash, ts, nonce)
    sig = base58.b58encode(sk.sign(msg).signature).decode()
    body = {
        'wallet': pubkey, 'node_id': node_id, 'signature': sig, 'nonce': nonce,
        'claimed_height': height, 'claimed_block_hash': block_hash,
        'proof_timestamp': ts,
    }

    req = urllib.request.Request(
        f'{API}/api/proofs/submit',
        data=json.dumps(body).encode(), method='POST',
        headers={'Content-Type': 'application/json'},
    )
    if use_proxy and rec.get('proxy_line'):
        h = urllib.request.ProxyHandler({
            'http': proxy_to_url(rec['proxy_line']),
            'https': proxy_to_url(rec['proxy_line']),
        })
        opener = urllib.request.build_opener(h)
    else:
        opener = urllib.request.build_opener()
    try:
        r = opener.open(req, timeout=40)
        return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {'raw': 'http_error'}
    except Exception as e:
        return -1, {'err': str(e)}

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('wallet_id', help='e.g. wallet-001')
    ap.add_argument('--no-proxy', action='store_true')
    args = ap.parse_args()
    rec = json.loads((WALLET_DIR / f'{args.wallet_id}.json').read_text())
    code, resp = submit(rec, use_proxy=not args.no_proxy)
    print(json.dumps({'wallet_id': args.wallet_id, 'status': code, 'response': resp}, indent=2))
