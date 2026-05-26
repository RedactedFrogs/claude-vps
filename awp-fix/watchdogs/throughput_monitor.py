#!/root/.claude/skills/mine/.venv/bin/python
"""Throughput monitor — probe backend snapshot, record task_count delta.
Alert if delta < threshold or backwards (epoch rollover handled).

Backend probe: GET /api/mining/v1/epochs/{today}/snapshot — sum task_count
across our 250 wallets. Save to history; compute delta vs last sample.

Threshold:
  - delta_per_min < 0.5: alert HIGH (likely full stall)
  - delta_per_min < 5:   alert LOW (degraded but ongoing)
  - delta_per_min >= 5:  healthy
"""
import os, sys, json, time, datetime
sys.path.insert(0,'/root/.claude/skills/mine'); sys.path.insert(0,'/root/.claude/skills/mine/scripts')

HIST = '/root/.awp-mining/state/throughput_history.json'
LOG = '/var/log/awp/throughput-monitor.log'
ALERT_HIGH = '/root/.awp-mining/state/THROUGHPUT_STALL'
ALERT_LOW = '/root/.awp-mining/state/THROUGHPUT_LOW'

def log(msg):
    with open(LOG,'a') as f:
        f.write(f'[{datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}] {msg}\n')

os.environ.setdefault('AWP_AGENT_ID','wallet-002')
os.environ.setdefault('WORKER_STATE_ROOT','/root/.awp-mining/state/wallet-002')
os.environ.setdefault('NO_PROXY','api.minework.net,localhost,127.0.0.1')
os.environ.setdefault('MINER_DISABLE_WS','1')

try:
    import agent_runtime
    client = agent_runtime.build_worker_from_env().client
except Exception as e:
    log(f'SETUP_ERR: {e}'); sys.exit(1)

today = datetime.date.today().isoformat()
try:
    snap = client._request('GET', f'/api/mining/v1/epochs/{today}/snapshot', None)
    miners = snap.get('data',{}).get('miners',{})
except Exception as e:
    log(f'PROBE_ERR: {e}'); sys.exit(1)

ours = set()
for line in open('/root/.awp-mining/all-wallets-status.txt'):
    p = line.strip().split(maxsplit=2)
    if len(p) >= 2 and p[1].startswith('0x'): ours.add(p[1].lower())

total = sum(m.get('task_count',0) for mid,m in miners.items() if mid.lower() in ours)
wallets_active = sum(1 for mid in miners if mid.lower() in ours)
now = int(time.time())

hist = {}
if os.path.exists(HIST):
    try: hist = json.load(open(HIST))
    except: hist = {}

prev_ts = hist.get('ts', 0)
prev_total = hist.get('total', 0)
prev_epoch = hist.get('epoch', '')

if prev_epoch != today:
    # epoch rollover — reset
    log(f'EPOCH_ROLLOVER from {prev_epoch} to {today}, prev_total={prev_total}')
    delta = 0
    delta_min = 0
else:
    delta = total - prev_total
    delta_min = delta / max(1, (now - prev_ts) / 60)

hist = {'ts': now, 'total': total, 'epoch': today, 'wallets_active': wallets_active}
with open(HIST,'w') as f: json.dump(hist, f, indent=2)

log(f'epoch={today} total={total} delta={delta} delta/min={delta_min:.2f} wallets_active={wallets_active}/250')

# threshold checks (skip first run when prev_ts=0)
if prev_ts > 0 and (now - prev_ts) > 600:  # only check if at least 10 min elapsed
    if delta_min < 0.5:
        with open(ALERT_HIGH,'w') as f: f.write(f'stall at {now}, delta_per_min={delta_min:.2f}')
        log(f'ALERT_HIGH: throughput stall {delta_min:.2f}/min')
    else:
        if os.path.exists(ALERT_HIGH): os.remove(ALERT_HIGH)

    if delta_min < 5:
        with open(ALERT_LOW,'w') as f: f.write(f'low at {now}, delta_per_min={delta_min:.2f}')
        log(f'ALERT_LOW: throughput {delta_min:.2f}/min')
    else:
        if os.path.exists(ALERT_LOW): os.remove(ALERT_LOW)
