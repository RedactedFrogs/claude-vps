import os, sys, json
sys.path.insert(0,'/root/.claude/skills/mine'); sys.path.insert(0,'/root/.claude/skills/mine/scripts')
w = sys.argv[1]
os.environ['AWP_AGENT_ID']=w
os.environ['WORKER_STATE_ROOT']=f'/root/.awp-mining/state/{w}'
os.environ['NO_PROXY']='api.minework.net,localhost,127.0.0.1'
os.environ['MINER_DISABLE_WS']='1'
import agent_runtime
client = agent_runtime.build_worker_from_env().client
try:
    r = client.send_miner_heartbeat(client_name='awp-miner')
    d = r.get('data',{}).get('miner',{})
    print(json.dumps({'wallet': w, 'ok': True, 'miner_id': d.get('miner_id',''), 'credit': d.get('credit',0)}))
except Exception as e:
    resp = getattr(e,'response',None)
    print(json.dumps({'wallet': w, 'ok': False, 'err': (resp.status_code if resp else type(e).__name__), 'msg': (resp.text[:120] if resp else str(e)[:120])}))
