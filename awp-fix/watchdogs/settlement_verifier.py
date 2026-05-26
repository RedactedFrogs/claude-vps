#!/root/.claude/skills/mine/.venv/bin/python
"""Daily settlement verifier — runs 02:00 UTC, checks yesterday epoch
settlement-results. Sums confirmed_submission_count + reward_amount across
our 250 wallets. Writes daily report to /var/cache/awp/daily-rewards.json.

Alert if yesterday's confirmed total < threshold (e.g. 100) — that means
our day's work was effectively wasted.
"""
import os, sys, json, datetime
sys.path.insert(0,'/root/.claude/skills/mine'); sys.path.insert(0,'/root/.claude/skills/mine/scripts')

LOG = '/var/log/awp/settlement-verifier.log'
REPORT = '/var/cache/awp/daily-rewards.json'
ALERT_LOW = '/root/.awp-mining/state/SETTLEMENT_LOW'

def log(msg):
    with open(LOG,'a') as f:
        f.write(f'[{datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}] {msg}\n')

os.environ.setdefault('AWP_AGENT_ID','wallet-002')
os.environ.setdefault('WORKER_STATE_ROOT','/root/.awp-mining/state/wallet-002')
os.environ.setdefault('NO_PROXY','api.minework.net,localhost,127.0.0.1')
os.environ.setdefault('MINER_DISABLE_WS','1')
os.environ.setdefault('HOME','/root')

import agent_runtime
client = agent_runtime.build_worker_from_env().client

ours = {}
for line in open('/root/.awp-mining/all-wallets-status.txt'):
    p = line.strip().split(maxsplit=2)
    if len(p) >= 2 and p[1].startswith('0x'): ours[p[1].lower()] = p[0]

yest = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
try:
    body = client._request('GET', f'/api/mining/v1/epochs/{yest}/settlement-results', None)
    miners = body.get('data',{}).get('miners',[])
except Exception as e:
    log(f'PROBE_ERR for {yest}: {e}')
    sys.exit(1)

ours_set = set(ours)
ours_settled = []
for m in miners:
    mid = (m.get('miner_id') or '').lower()
    if mid in ours_set:
        ours_settled.append({
            'wallet': ours[mid],
            'subs': m.get('confirmed_submission_count', 0),
            'rejected': m.get('rejected_submission_count', 0),
            'avg_score': m.get('avg_score', 0),
            'qualified': m.get('qualified', False),
            'reward': m.get('reward_amount', 0),
        })

total_subs = sum(x['subs'] for x in ours_settled)
total_rew = sum(x['reward'] for x in ours_settled)
qualified = sum(1 for x in ours_settled if x['qualified'])

report = {
    'epoch': yest,
    'wallets_in_settlement': len(ours_settled),
    'qualified': qualified,
    'total_confirmed_subs': total_subs,
    'total_reward': round(total_rew, 6),
    'top10': sorted(ours_settled, key=lambda x:-x['reward'])[:10],
    'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
os.makedirs(os.path.dirname(REPORT), exist_ok=True)
with open(REPORT,'w') as f: json.dump(report, f, indent=2)

log(f'epoch={yest}: settled={len(ours_settled)}/250 qualified={qualified} subs={total_subs} reward={total_rew:.4f}')

# alert if disastrously low (e.g. < 100 confirmed submissions across all wallets)
if total_subs < 100:
    with open(ALERT_LOW,'w') as f: f.write(f'epoch={yest} subs={total_subs} reward={total_rew}')
    log(f'ALERT: settlement low — subs={total_subs} < 100')
else:
    if os.path.exists(ALERT_LOW): os.remove(ALERT_LOW)
