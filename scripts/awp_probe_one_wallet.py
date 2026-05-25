#!/usr/bin/env python3
"""Probe one wallet for repeat-crawl tasks over a fixed duration.

Usage: probe_one_wallet.py <wid> <duration_sec> <proxy_url> [poll_sec]

Logs to /var/log/awp/repeat-crawl-probe.log
Writes metrics to /root/.awp-mining/repeat-crawl-probe-{wid}.json
"""
import os, sys, time, json
from datetime import datetime, timezone

wid = sys.argv[1]
duration = int(sys.argv[2])
proxy = sys.argv[3]
poll_sec = int(sys.argv[4]) if len(sys.argv) > 4 else 60

os.environ["AWP_AGENT_ID"] = wid
os.environ["WORKER_STATE_ROOT"] = f"/root/.awp-mining/state/{('wallet-001' if wid=='default' else wid)}"
os.environ["HOME"] = "/root"
os.environ["AWP_WALLET_TOKEN"] = "dummy"
os.environ["HTTPS_PROXY"] = proxy
os.environ["HTTP_PROXY"] = proxy
os.environ["MINER_DISABLE_WS"] = "1"
sys.path.insert(0, "/root/.claude/skills/mine")
sys.path.insert(0, "/root/.claude/skills/mine/scripts")
sys.path.insert(0, "/root/.claude/skills/mine/lib")

LOG_FILE = "/var/log/awp/repeat-crawl-probe.log"

def log(msg):
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    line = f"{ts} [{wid}] {msg}\n"
    with open(LOG_FILE, "a") as f: f.write(line)
    sys.stdout.write(line); sys.stdout.flush()

import agent_runtime
client = agent_runtime.build_worker_from_env().client
addr = client.get_signer_address()
log(f"START addr={addr[:14]} duration={duration}s poll={poll_sec}s")

start = time.time()
stats = {
    "attempts": 0, "no_task": 0, "pow_required": 0, "cooldown": 0,
    "got_task": 0, "rejected": 0, "reject_errors": 0, "claim_errors": 0,
    "datasets": {},
    "first_task_at": None, "last_task_at": None,
}

while time.time() - start < duration:
    stats["attempts"] += 1
    try:
        try: client.send_miner_heartbeat(client_name="probe")
        except Exception: pass
        t = client.claim_repeat_crawl_task()
        if t is None:
            stats["no_task"] += 1
        elif t.get("_pow_required"):
            stats["pow_required"] += 1
        elif t.get("_cooldown"):
            stats["cooldown"] += 1
            wait = min(t.get("retry_after_seconds", 30), 120)
            time.sleep(wait)
        else:
            ds = t.get("dataset_id", "?")
            stats["got_task"] += 1
            stats["datasets"][ds] = stats["datasets"].get(ds, 0) + 1
            elapsed = int(time.time() - start)
            if stats["first_task_at"] is None:
                stats["first_task_at"] = elapsed
            stats["last_task_at"] = elapsed
            log(f"TASK ds={ds} url={(t.get('url','') or '')[:60]}")
            try:
                client.reject_repeat_crawl_task(t["id"])
                stats["rejected"] += 1
            except Exception as e:
                stats["reject_errors"] += 1
                log(f"  reject ERR: {str(e)[:80]}")
    except Exception as e:
        stats["claim_errors"] += 1
        emsg = str(e)[:120]
        log(f"claim ERR {type(e).__name__}: {emsg}")
    
    if stats["attempts"] % 20 == 0:
        log(f"snapshot: attempts={stats['attempts']} got_task={stats['got_task']} no_task={stats['no_task']} pow={stats['pow_required']}")
    
    time.sleep(poll_sec)

log(f"FINAL: {json.dumps(stats)}")
metrics_file = f"/root/.awp-mining/repeat-crawl-probe-{wid}.json"
with open(metrics_file, "w") as f:
    json.dump({"wallet": wid, "addr": addr, "duration": duration, "poll_sec": poll_sec,
               "started_iso": datetime.now(timezone.utc).isoformat(), "stats": stats}, f, indent=2)
