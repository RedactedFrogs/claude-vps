#!/usr/bin/env python3
"""Probe DePINZcash /api/nodes/register every hour.

Detects when REGISTRATION_ENABLED flips back on. Writes:
  - /root/depinz/state/watcher_state.json     (last probe result)
  - /root/depinz/state/REGISTRATION_REOPENED  (sentinel, only created on flip)
  - /root/depinz/logs/watcher.log             (append log)

The probe body is intentionally malformed (no valid signature) so we never
accidentally create a node even if registration is open. We only care about
the HTTP status code: 403 = locked, 400/422/200 = open (or at least past the
kill-switch).
"""
import json, os, sys, time
from datetime import datetime, timezone
from pathlib import Path
import urllib.request, urllib.error

API = os.environ.get('DEPINZ_API', 'https://api.zcashdepin.com')
STATE_DIR = Path('/root/depinz/state')
LOG_DIR = Path('/root/depinz/logs')
STATE_FILE = STATE_DIR / 'watcher_state.json'
SENTINEL = STATE_DIR / 'REGISTRATION_REOPENED'
LOG_FILE = LOG_DIR / 'watcher.log'

PROBE_BODY = json.dumps({
    'wallet': 'probe-not-a-real-key',
    'signature': 'probe',
    'nonce': 'watcher_probe_0123456789abcdef',
    'timestamp': '2026-05-25T00:00:00Z',
    'kind': 'lightwalletd',
}).encode()

def probe():
    req = urllib.request.Request(
        f'{API}/api/nodes/register',
        data=PROBE_BODY, method='POST',
        headers={'Content-Type': 'application/json'},
    )
    try:
        resp = urllib.request.urlopen(req, timeout=20)
        return resp.status, resp.read()[:200].decode(errors='replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:200].decode(errors='replace')
    except Exception as e:
        return -1, f'NETERR: {e}'

def log_line(msg):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open('a') as f:
        f.write(f'[{datetime.now(timezone.utc).isoformat()}] {msg}\n')

def main():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    code, body = probe()
    now = datetime.now(timezone.utc).isoformat()

    prev = {}
    if STATE_FILE.exists():
        try:
            prev = json.loads(STATE_FILE.read_text())
        except Exception:
            pass

    new_state = {
        'last_probe_at': now,
        'last_status': code,
        'last_body_excerpt': body,
        'consecutive_403s': prev.get('consecutive_403s', 0) + 1 if code == 403 else 0,
        'first_seen_403_at': prev.get('first_seen_403_at') or (now if code == 403 else None),
    }
    STATE_FILE.write_text(json.dumps(new_state, indent=2))

    prev_code = prev.get('last_status')
    flipped = (prev_code == 403 and code != 403) or (
        prev_code != 403 and code != 403 and not SENTINEL.exists()
    )
    if flipped:
        SENTINEL.write_text(json.dumps({
            'flipped_at': now,
            'from_status': prev_code,
            'to_status': code,
            'body_excerpt': body,
        }, indent=2))
        log_line(f'REGISTRATION_REOPENED: {prev_code} -> {code} :: {body[:120]}')
    else:
        log_line(f'probe code={code} streak403={new_state["consecutive_403s"]}')

if __name__ == '__main__':
    main()
