#!/usr/bin/env python3
"""Throttled batch registration of pre-generated wallets to DePINZcash.

Reads wallet files from /root/depinz/wallets/. Skips any wallet that already
has register_status==200 (idempotent). Walks in wallet_id order.

Throttle: random delay 6-12 min between wallets (≈5-10/hour). Daily cap
100/day (sleeps until next UTC day at cap).

DRY-RUN by default. Pass --execute to actually POST.

Aborts if:
  - /root/depinz/state/REGISTRATION_REOPENED missing (kill-switch still on)
  - /root/depinz/state/ABORT_BATCH file present (user emergency stop)
"""
import json, os, sys, time, secrets, random, argparse
from datetime import datetime, timezone, date
from pathlib import Path
import urllib.request, urllib.error
import nacl.signing
import base58

API = os.environ.get('DEPINZ_API', 'https://api.zcashdepin.com')
WALLET_DIR = Path('/root/depinz/wallets')
STATE_DIR = Path('/root/depinz/state')
LOG_DIR = Path('/root/depinz/logs')
LOG_FILE = LOG_DIR / 'register_batch.log'
SENTINEL = STATE_DIR / 'REGISTRATION_REOPENED'
ABORT = STATE_DIR / 'ABORT_BATCH'
DAILY_STATE = STATE_DIR / 'batch_daily_count.json'

DAILY_CAP = 100
DELAY_MIN_S = 6 * 60
DELAY_MAX_S = 12 * 60

def log(msg):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    line = f'[{datetime.now(timezone.utc).isoformat()}] {msg}'
    print(line, flush=True)
    with LOG_FILE.open('a') as f:
        f.write(line + '\n')

def registration_message(wallet, nonce, ts, kind, network, label):
    return (
        f'depinzcash:register:v1\n{wallet}\n{nonce}\n{ts}\n{kind}\n{network}\n{label}\n'
    ).encode()

def proxy_to_url(line):
    ip, port, user, pw = line.strip().split(':')
    return f'http://{user}:{pw}@{ip}:{port}'

def register(rec, kind='lightwalletd', use_proxy=True, timeout=40):
    sk = nacl.signing.SigningKey(bytes.fromhex(rec['secret_key_hex']))
    pubkey = rec['pubkey_b58']
    nonce = secrets.token_hex(20)
    ts = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    label = f'lwd-{rec["wallet_id"].split("-")[1]}'
    msg = registration_message(pubkey, nonce, ts, kind, 'mainnet', label)
    sig = base58.b58encode(sk.sign(msg).signature).decode()
    body = {
        'wallet': pubkey, 'signature': sig, 'nonce': nonce, 'timestamp': ts,
        'kind': kind, 'label': label,
    }
    req = urllib.request.Request(
        f'{API}/api/nodes/register',
        data=json.dumps(body).encode(),
        method='POST',
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
        r = opener.open(req, timeout=timeout)
        return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {'raw': 'http_error'}
    except Exception as e:
        return -1, {'err': str(e)}

def get_daily_count():
    today = date.today().isoformat()
    if DAILY_STATE.exists():
        try:
            d = json.loads(DAILY_STATE.read_text())
            if d.get('date') == today:
                return d.get('count', 0)
        except Exception: pass
    return 0

def bump_daily_count(n):
    today = date.today().isoformat()
    DAILY_STATE.write_text(json.dumps({'date': today, 'count': get_daily_count() + n}))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--execute', action='store_true', help='actually POST (default dry-run)')
    ap.add_argument('--no-proxy', action='store_true')
    ap.add_argument('--no-sentinel-check', action='store_true', help='allow run even if SENTINEL absent')
    ap.add_argument('--cap', type=int, default=DAILY_CAP)
    args = ap.parse_args()

    if not args.no_sentinel_check and not SENTINEL.exists():
        log('ABORT: REGISTRATION_REOPENED sentinel missing — kill-switch still on. '
            'Run watcher.py first or pass --no-sentinel-check.')
        sys.exit(2)
    if ABORT.exists():
        log('ABORT: /root/depinz/state/ABORT_BATCH present.')
        sys.exit(2)

    wallets = sorted(WALLET_DIR.glob('wallet-*.json'))
    pending = []
    for f in wallets:
        rec = json.loads(f.read_text())
        if rec.get('register_status') == 200:
            continue
        pending.append((f, rec))

    log(f'mode={"EXECUTE" if args.execute else "DRY-RUN"} pending={len(pending)} daily_so_far={get_daily_count()} cap={args.cap}')

    sent_today = 0
    for f, rec in pending:
        if ABORT.exists():
            log('ABORT mid-loop'); break
        if get_daily_count() >= args.cap:
            log(f'daily cap {args.cap} reached, stopping')
            break

        if args.execute:
            code, resp = register(rec, use_proxy=not args.no_proxy)
            rec['register_status'] = code
            rec['register_response'] = resp
            rec['registered_at'] = datetime.now(timezone.utc).isoformat()
            if code == 200 and isinstance(resp, dict) and 'node' in resp:
                rec['node_id'] = resp['node']['id']
                rec['auth_token'] = resp['auth_token']
            f.write_text(json.dumps(rec, indent=2))
            os.chmod(f, 0o600)
            bump_daily_count(1)
            sent_today += 1
            log(f'{rec["wallet_id"]} -> code={code} node_id={rec.get("node_id")}')
            if code == 403:
                log('got 403 from server — kill-switch likely re-engaged. Aborting batch.')
                break
        else:
            log(f'{rec["wallet_id"]} (dry-run) proxy={rec.get("proxy_line","none")[:24]}...')

        delay = random.randint(DELAY_MIN_S, DELAY_MAX_S)
        if args.execute:
            time.sleep(delay)
        else:
            # in dry-run, don't actually wait
            pass

    log(f'done sent_today={sent_today} daily_total={get_daily_count()}')

if __name__ == '__main__':
    main()
