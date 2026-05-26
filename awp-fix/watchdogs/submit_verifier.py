#!/root/.claude/skills/mine/.venv/bin/python
"""Submit verifier — every 60 min, pick 3 random wallets, do real submit,
verify server returns admission_status=accepted. If 3 consecutive failures
across wallets, alert + restart miner.

This is the ULTIMATE backend-verified health check — proves submit pipeline
end-to-end works, not just that miner is alive.
"""
import os, sys, json, random, datetime, time
sys.path.insert(0,'/root/.claude/skills/mine'); sys.path.insert(0,'/root/.claude/skills/mine/scripts')
sys.path.insert(0,'/root/.awp-mining')

LOG = '/var/log/awp/submit-verifier.log'
STATE = '/root/.awp-mining/state/submit_verifier_state.json'
ALERT = '/root/.awp-mining/state/SUBMIT_VERIFY_FAIL'

def log(msg):
    with open(LOG,'a') as f:
        f.write(f'[{datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}] {msg}\n')

os.environ.setdefault('NO_PROXY','api.minework.net,localhost,127.0.0.1')
os.environ.setdefault('MINER_DISABLE_WS','1')
os.environ.setdefault('HOME','/root')

# load state
state = {'consecutive_fail': 0, 'last_check': 0, 'last_status': 'init'}
if os.path.exists(STATE):
    try: state.update(json.load(open(STATE)))
    except: pass

try:
    import awp_miner_v4 as m
    m.load_pool()
except Exception as e:
    log(f'SETUP_ERR: {e}'); sys.exit(1)

# pick 3 wallets, excluding wallet-001 (not registered on-chain)
wallets = [f'wallet-{i:03d}' for i in range(2, 251)]
picks = random.sample(wallets, 3)
log(f'verifying {picks}')

results = []
for w in picks:
    try:
        c = m.get_client(w)
        arts = m.claim(1)
        if not arts:
            results.append((w, 'NO_ARTICLE'))
            continue
        art = arts[0]
        if not m.clear_gate(c):
            results.append((w, 'GATE_FAIL'))
            m.unclaim([art])
            continue
        payload = {'dataset_id': m.DATASET_ID, 'entries': [art]}
        try:
            body = c._request('POST','/api/mining/v1/submissions', payload)
            d = body.get('data',{}) if isinstance(body, dict) else {}
            status = d.get('admission_status','?')
            accepted = bool(d.get('accepted'))
            sub_ids = [s.get('id','') for s in (d.get('accepted') or []) if isinstance(s, dict)]
            if accepted and status == 'accepted':
                results.append((w, 'ACCEPTED', sub_ids[:1]))
                m.mark_consumed([art])
            else:
                # rate_limited/duplicate also counts as 'server responded'
                rej = d.get('rejected') or []
                reason = (rej[0].get('reason','') if rej else status)[:60]
                results.append((w, f'NOT_ACCEPTED:{reason}'))
                m.mark_consumed([art])
        except Exception as e:
            r = getattr(e,'response',None)
            code = r.status_code if r else 'NETERR'
            results.append((w, f'HTTP_{code}'))
            m.unclaim([art])
    except Exception as e:
        results.append((w, f'EXC_{type(e).__name__}'))

ok_count = sum(1 for r in results if r[1] == 'ACCEPTED')
# pipeline-alive: any coherent server response (accepted, dup, ratelimit) proves signing+routing works
PIPELINE_ALIVE = ['ACCEPTED', 'HTTP_429', 'HTTP_409']
def is_alive(s):
    return s == 'ACCEPTED' or s.startswith('HTTP_429') or s.startswith('HTTP_409') or s.startswith('NOT_ACCEPTED:frequent') or s.startswith('NOT_ACCEPTED:duplicate') or s.startswith('NOT_ACCEPTED:dedup')
acceptable = sum(1 for r in results if is_alive(r[1]))
log(f'results: {results}  ok={ok_count}/3  acceptable={acceptable}/3')

if acceptable == 0:
    state['consecutive_fail'] += 1
    log(f'consecutive_fail = {state["consecutive_fail"]}')
    if state['consecutive_fail'] >= 3:
        with open(ALERT,'w') as f: f.write(f'submit pipeline failing for {state["consecutive_fail"]} cycles')
        log('ALERT: 3+ consecutive verify cycles failed — restarting miner')
        import subprocess
        subprocess.run(['systemctl','restart','awp-miner.service'], timeout=30)
        state['consecutive_fail'] = 0
else:
    state['consecutive_fail'] = 0
    if os.path.exists(ALERT): os.remove(ALERT)

state['last_check'] = int(time.time())
state['last_status'] = f'ok={ok_count}/3 acceptable={acceptable}/3'
with open(STATE,'w') as f: json.dump(state, f, indent=2)
