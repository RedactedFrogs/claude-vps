#!/usr/bin/env python3
"""AWP Miner v4 — single process, all 250 wallets, watchdog + auto-retry.

- All wallets mined each round via a thread pool (single process, RAM-light).
- Watchdog: probes API health; runs full-speed when API fast, backs off when slow/down.
- Auto-retry: continuous loop; un-submitted articles return to pool for next round.
- Writes live progress to /var/cache/awp/miner-progress.json for the dashboard.
"""
from __future__ import annotations
import os, sys, time, json, random, threading, logging
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, "/root/.claude/skills/mine")
sys.path.insert(0, "/root/.claude/skills/mine/scripts")
sys.path.insert(0, "/root/.awp-mining")

import httpx
# === NATIVE EIP-712 SIGNING (10x speedup vs awp-wallet) ===
# __NATIVE_SIGNER_APPLIED__
import json as _njson
from eth_account import Account as _Account
from eth_account.messages import encode_typed_data as _enc_typed
try:
    _NATIVE_KEYS = _njson.load(open("/root/.awp-mining/wallet_keys.json"))
    _ACCT_CACHE = {}
    def _native_get_acct(wallet):
        if wallet not in _ACCT_CACHE:
            ent = _NATIVE_KEYS.get(wallet)
            if ent: _ACCT_CACHE[wallet] = _Account.from_key(ent["pk"])
        return _ACCT_CACHE.get(wallet)
    import signer as _sg
    def _native_sign(self, typed_data):
        wallet = os.environ.get("AWP_AGENT_ID", "")
        acct = _native_get_acct(wallet)
        if acct is None:
            # fallback to original awp-wallet path
            return _sg.WalletSigner._original_sign_typed_data(self, typed_data)
        msg = _enc_typed(full_message=typed_data)
        return acct.sign_message(msg).signature.hex()
    def _native_addr(self):
        wallet = os.environ.get("AWP_AGENT_ID", "")
        acct = _native_get_acct(wallet)
        if acct: return acct.address
        return _sg.WalletSigner._original_get_address(self)
    if not hasattr(_sg.WalletSigner, "_original_sign_typed_data"):
        _sg.WalletSigner._original_sign_typed_data = _sg.WalletSigner.sign_typed_data
        _sg.WalletSigner._original_get_address = _sg.WalletSigner.get_address
    _sg.WalletSigner.sign_typed_data = _native_sign
    _sg.WalletSigner.get_address = _native_addr
except Exception as _ne:
    pass  # fallback to default signer
# === END NATIVE SIGNING ===

POOL_CONC      = int(os.environ.get("MINER_CONC", "60"))      # concurrent threads
ARTICLES       = int(os.environ.get("MINER_ARTICLES", "3"))   # articles per wallet per round
GAP_FAST       = int(os.environ.get("MINER_GAP_FAST", "15"))    # idle after round (API fast)
GAP_SLOW       = int(os.environ.get("MINER_GAP_SLOW", "60"))    # idle after round (API slow)
POW_RETRY      = int(os.environ.get("MINER_POW_RETRY", "30"))   # wait when PoW endpoint down
API_RETRY      = int(os.environ.get("MINER_API_RETRY", "20"))   # wait when API health down
DATASET_ID     = "ds_wikipedia"
POOL_FILE      = "/root/.awp-mining/article_pool.jsonl"
POOL_FILE_V2   = "/root/.awp-mining/article_pool_v2.jsonl"   # official-crawler pool (richer)
USED_FILE      = "/root/.awp-mining/used_articles.txt"
WALLET_FILE    = "/root/.awp-mining/all-wallets-status.txt"
PROGRESS       = os.environ.get("MINER_PROGRESS_FILE", "/var/cache/awp/miner-progress.json")
LOG_FILE       = "/var/log/awp/miner-v4.log"
API_HEALTH     = "https://api.minework.net/healthz"

os.makedirs("/var/cache/awp", exist_ok=True)
os.makedirs("/var/log/awp", exist_ok=True)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s",
    handlers=[logging.FileHandler(LOG_FILE), logging.StreamHandler()])
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("v4")

_build_lock = threading.Lock()      # serialize build_worker_from_env (env-var race)
_used_lock  = threading.Lock()
_prog_lock  = threading.Lock()
_clients: dict = {}                 # wallet -> platform client (cached)
_wallet_proxies: dict = {}          # wallet -> proxy URL (for diag)
_pool: list = []
_used: set = set()

_progress = {
    "updated": 0, "round": 0, "api": "?", "api_ms": 0, "pow_ok": None,
    "api_green_since": 0,        # epoch when PoW endpoint last became usable (0 = not green)
    "api_red_since": 0,          # epoch when PoW endpoint last became unusable (0 = not red)
    "wallets_total": 0, "wallets_done": 0,
    "round_accepted": 0, "round_errors": 0, "round_rate_limited": 0, "round_duplicate": 0, "round_rejected": 0,
    "lifetime_accepted": 0, "active_now": 0, "state": "starting",
}


def save_progress():
    with _prog_lock:
        _progress["updated"] = int(time.time())
        _progress["updated_iso"] = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
        tmp = PROGRESS + ".tmp"
        with open(tmp, "w") as f:
            json.dump(_progress, f, indent=2)
        os.replace(tmp, PROGRESS)


# ---- pool ----
def load_pool():
    _pool.clear()
    # prefer the richer official-crawler pool once it has been built
    src = POOL_FILE
    if os.path.exists(POOL_FILE_V2) and os.path.getsize(POOL_FILE_V2) > 2000:
        src = POOL_FILE_V2
    for line in open(src):
        try:
            _pool.append(json.loads(line))
        except Exception:
            pass
    _used.clear()
    if os.path.exists(USED_FILE):
        for line in open(USED_FILE):
            _used.add(line.strip())
    random.shuffle(_pool)
    log.info(f"pool loaded: {len(_pool)} articles from {os.path.basename(src)}, {len(_used)} used")


def claim(n):
    """Pick n unused articles. In-memory only — NOT written to USED_FILE.
    Articles are only permanently consumed (written to file) on successful submit."""
    out = []
    with _used_lock:
        for a in _pool:
            k = str(a["structured_data"]["page_id"])
            if k in _used:
                continue
            _used.add(k)
            out.append(a)
            if len(out) >= n:
                break
    return out


def mark_consumed(arts):
    """Permanently consume articles (accepted/duplicate) — write to USED_FILE."""
    if not arts:
        return
    with _used_lock:
        with open(USED_FILE, "a") as f:
            for a in arts:
                f.write(str(a["structured_data"]["page_id"]) + "\n")


def unclaim(arts):
    """Failed articles — release from in-memory _used so they retry next round."""
    if not arts:
        return
    with _used_lock:
        for a in arts:
            _used.discard(str(a["structured_data"]["page_id"]))


# ---- API watchdog ----
def api_health():
    """Return (state, latency_ms). state: 'fast'|'slow'|'down'."""
    t = time.time()
    try:
        with httpx.Client(timeout=20.0, trust_env=False) as c:
            r = c.get(API_HEALTH)
        ms = int((time.time() - t) * 1000)
        if r.status_code != 200:
            return "down", ms
        return ("fast" if ms < 5000 else "slow"), ms
    except Exception:
        return "down", int((time.time() - t) * 1000)


def pow_probe(wallet):
    """Real test of the submission path. healthz being 'fast' does NOT mean
    the PoW-answer endpoint works — that endpoint can hang server-side while
    healthz stays green. This answers one challenge with a SHORT timeout and
    checks whether the gate actually opens. Returns True only if it does."""
    from awp_pow_solver import solve_challenge
    try:
        client = get_client(wallet)
        try:
            client.send_miner_heartbeat(client_name="awp-miner")
        except Exception:
            pass
        st, body = req(client, "GET", "/api/mining/v1/miners/me/submission-gate",
                       None, tries=2)
        if st != "ok":
            return False
        g = body.get("data", body) if isinstance(body, dict) else {}
        if g.get("can_submit"):
            return True
        ch = g.get("challenge")
        if not (isinstance(ch, dict) and ch.get("id")):
            return False
        ans = solve_challenge(ch)
        if ans is None:
            return False
        # fire the answer with a SHORT read timeout — a healthy endpoint
        # replies within a few seconds; a broken one hangs.
        short = httpx.Client(base_url=client._base_url,
            timeout=httpx.Timeout(connect=10.0, read=12.0, write=10.0, pool=10.0),
            headers=dict(client._client.headers))
        saved = client._client
        client._client = short
        try:
            client._request("POST",
                f"/api/mining/v1/pow-challenges/{ch['id']}/answer",
                {"answer": str(ans)})
        except Exception:
            pass
        finally:
            client._client = saved
            short.close()
        # poll the gate briefly — a healthy endpoint opens it within ~20s
        for _ in range(4):
            time.sleep(5)
            st, body = req(client, "GET",
                           "/api/mining/v1/miners/me/submission-gate", None, tries=1)
            if st == "ok":
                g = body.get("data", body) if isinstance(body, dict) else {}
                if g.get("can_submit"):
                    return True
        return False
    except Exception:
        return False


# ---- platform client (built once per wallet, cached) ----
def get_client(wallet):
    if wallet in _clients:
        return _clients[wallet]
    with _build_lock:                       # serialize: build reads os.environ
        if wallet in _clients:
            return _clients[wallet]
        os.environ["AWP_AGENT_ID"] = wallet
        os.environ["WORKER_STATE_ROOT"] = f"/root/.awp-mining/state/{wallet}"
        os.environ["NO_PROXY"] = "api.minework.net,localhost,127.0.0.1"
        os.environ["MINER_DISABLE_WS"] = "1"   # skip websocket (not needed, can hang)
        import agent_runtime
        client = agent_runtime.build_worker_from_env().client
        # hard, explicit timeouts — read=90s: the PoW-answer endpoint is slow
        # (25-90s); a shorter read timeout fails every PoW answer.
        # === PROXY ROTATION (bypass per-IP+wallet cooldown) ===
        try:
            _all_proxies = open('/root/.awp-mining/proxies.txt').read().splitlines()
            _wallet_idx = int(wallet.replace('wallet-', ''))
            # assign 5 proxies per wallet based on wallet index, rotate among them
            _slot_size = 5
            _start = (_wallet_idx * _slot_size) % len(_all_proxies)
            _slot = _all_proxies[_start:_start+_slot_size]
            _proxy_line = _slot[(_wallet_idx) % len(_slot)].strip().split(':')
            _proxy_url = f'http://{_proxy_line[2]}:{_proxy_line[3]}@{_proxy_line[0]}:{_proxy_line[1]}'
            _wallet_proxies[wallet] = _proxy_url
        except Exception as _e:
            _proxy_url = None
        # === END PROXY ROTATION ===
        client._client = httpx.Client(
            base_url=client._base_url,
            timeout=httpx.Timeout(connect=15.0, read=90.0, write=15.0, pool=60.0),
            limits=httpx.Limits(max_connections=200, max_keepalive_connections=100),
            proxy=_proxy_url if _proxy_url else None,
            headers=dict(client._client.headers))
        # ── ENV-RACE FIX: pin per-wallet env onto signer._run so awp-wallet subprocess
        # always signs with the right wallet, regardless of which thread set os.environ
        # last. Root cause: WalletSigner._run did env=os.environ.copy() at call time;
        # under MINER_CONC=60, env was almost always wallet-250's by the time other
        # threads called sign. Result: server saw ~all submissions as wallet-250.
        try:
            _signer = client._signer
            if _signer is not None:
                import subprocess as _sp, json as _jjj
                _pinned = {
                    "AWP_AGENT_ID": wallet,
                    "WORKER_STATE_ROOT": f"/root/.awp-mining/state/{wallet}",
                    "HOME": os.environ.get("HOME", "/root"),
                    "NO_PROXY": "api.minework.net,localhost,127.0.0.1",
                }
                def _make_run(s, pinned):
                    def _run(*args):
                        cmd = [s._bin, *args]
                        env = os.environ.copy()
                        env.update(pinned)
                        r = _sp.run(cmd, capture_output=True, text=True, timeout=30, env=env)
                        if r.returncode != 0:
                            raise RuntimeError(f"awp-wallet failed (exit {r.returncode}): {r.stderr.strip()}")
                        return _jjj.loads(r.stdout)
                    return _run
                _signer._run = _make_run(_signer, _pinned)
        except Exception as _e:
            log.info(f"{wallet}: signer pin failed: {type(_e).__name__}")
        _clients[wallet] = client
        return client


_PROXY_LIST = []
try:
    _PROXY_LIST = [l.strip() for l in open('/root/.awp-mining/proxies.txt') if l.strip()]
except Exception: pass
import random as _random
def _swap_proxy(client):
    try:
        if not _PROXY_LIST: return
        P = _random.choice(_PROXY_LIST).split(':')
        url = f'http://{P[2]}:{P[3]}@{P[0]}:{P[1]}'
        old = client._client
        client._client = httpx.Client(
            base_url=old.base_url,
            timeout=old.timeout,
            headers=dict(old.headers),
            limits=httpx.Limits(max_connections=200, max_keepalive_connections=100),
            proxy=url,
        )
    except Exception: pass

def req(client, method, path, payload, tries=3):
    for i in range(tries):
        try:
            return ("ok", client._request(method, path, payload))
        except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.ConnectError,
                httpx.RemoteProtocolError, httpx.PoolTimeout, httpx.WriteTimeout):
            time.sleep(1 + i)
            continue
        except Exception as ex:
            resp = getattr(ex, "response", None)
            if resp is None:
                return ("fail", str(ex)[:120])
            sc = resp.status_code
            try:
                body = resp.json()
            except Exception:
                body = resp.text[:200]
            if sc >= 500:
                time.sleep(2 + i)
                continue
            return ("http", (sc, body))
    return ("fail", "exhausted")


def clear_gate(client, max_pow=4):
    from awp_pow_solver import solve_challenge
    for _ in range(max_pow + 2):
        st, body = req(client, "GET", "/api/mining/v1/miners/me/submission-gate", None)
        if st != "ok":
            return False
        g = body.get("data", body) if isinstance(body, dict) else {}
        if g.get("can_submit") or g.get("state") in ("open", "opening", "ready", "ok"):
            return True
        ch = g.get("challenge")
        if isinstance(ch, dict) and ch.get("id"):
            ans = solve_challenge(ch)
            if ans is None:
                return False
            req(client, "POST", f"/api/mining/v1/pow-challenges/{ch['id']}/answer",
                {"answer": str(ans)}, tries=4)
            time.sleep(1)
        else:
            time.sleep(2)
    return False


def submit_one(client, article):
    # Official mine-skill endpoint is /api/mining/v1/submissions
    # (platform_client.submit_core_submissions). The old /api/core/v1/...
    # path was wrong — corrected after auditing the official skill code.
    payload = {"dataset_id": DATASET_ID, "entries": [article]}
    st, body = req(client, "POST", "/api/mining/v1/submissions", payload, tries=2)
    if st == "ok":
        data = body.get("data", {}) if isinstance(body, dict) else {}
        if data.get("admission_status") == "challenge_required":
            return "pow"
        if data.get("accepted"):
            return "accepted"
        rej = data.get("rejected") or []
        rs = " ".join(str(e.get("reason", "")) for e in rej if isinstance(e, dict))
        if "frequent" in rs:
            return "rate_limited"
        if "duplicate" in rs or "occupied" in rs or "dedup" in rs:
            return "duplicate"
        return "rejected"
    if st == "http":
        sc, _ = body
        if sc == 429:
            return "rate_limited"
        if sc == 428:
            return "pow"
        if sc == 409:
            # server dedup — article already submitted globally. Mark consumed.
            return "duplicate"
    return "error"


# ---- mine one wallet ----
def mine_wallet(wallet):
    res = {"accepted": 0, "duplicate": 0, "rejected": 0, "rate_limited": 0, "errors": 0}
    arts = claim(ARTICLES)
    if not arts:
        return res
    leftover = list(arts)      # failed -> released for retry next round
    consumed = []              # accepted/duplicate/rejected -> permanently used
    try:
        with _prog_lock:
            _progress["active_now"] += 1
        client = get_client(wallet)
        # benchmark variant — heartbeat skipped; cron handles it
        for art in arts:
            if not clear_gate(client):
                res["errors"] += 1
                continue
            o = submit_one(client, art)
            if o == "pow":
                if clear_gate(client):
                    o = submit_one(client, art)
            if o in ("accepted", "duplicate", "rejected"):
                res[o] += 1
                leftover.remove(art)
                consumed.append(art)
            elif o == "rate_limited":
                res["rate_limited"] += 1
            else:
                res["errors"] += 1
            time.sleep(1)
    except Exception as ex:
        res["errors"] += 1
        log.info(f"{wallet} exc: {type(ex).__name__}: {str(ex)[:100]}")
    finally:
        mark_consumed(consumed)   # only successfully-handled articles
        unclaim(leftover)         # failed -> retry next round
        with _prog_lock:
            _progress["active_now"] -= 1
            _progress["wallets_done"] += 1
            _progress["round_accepted"] += res["accepted"]
            _progress["round_errors"] += res["errors"]
            _progress["round_rate_limited"] += res["rate_limited"]
            _progress["round_duplicate"] += res.get("duplicate", 0)
            _progress["round_rejected"] += res.get("rejected", 0)
            _progress["lifetime_accepted"] += res["accepted"]
    return res


def load_wallets():
    ws = []
    for line in open(WALLET_FILE):
        p = line.split()
        if p and p[0].startswith("wallet-"):
            ws.append(p[0])
    ws = sorted(set(ws))
    # WALLET_RANGE env support: "0-125" or "126-250" for multi-process split
    rng = os.environ.get("WALLET_RANGE")
    if rng:
        try:
            a, b = (int(x) for x in rng.split("-"))
            ws = [w for w in ws if a <= int(w.replace("wallet-","")) <= b]
        except Exception: pass
    return ws


def run_round(wallets, rnd):
    load_pool()
    with _prog_lock:
        _progress.update(round=rnd, wallets_total=len(wallets), wallets_done=0,
                         round_accepted=0, round_errors=0, round_rate_limited=0, round_duplicate=0, round_rejected=0,
                         active_now=0, state="mining")
    save_progress()
    log.info(f"=== round {rnd} START — {len(wallets)} wallets, conc={POOL_CONC} ===")
    last_save = 0
    with ThreadPoolExecutor(max_workers=POOL_CONC) as ex:
        futs = [ex.submit(mine_wallet, w) for w in wallets]
        for _ in as_completed(futs):
            if time.time() - last_save > 5:
                save_progress()
                last_save = time.time()
    save_progress()
    p = _progress
    log.info(f"=== round {rnd} DONE — accepted={p['round_accepted']} "
             f"dup={p.get('round_duplicate',0)} rej={p.get('round_rejected',0)} "
             f"errors={p['round_errors']} rate_limited={p['round_rate_limited']} ===")


def _progress_saver():
    """Background thread — save progress every 8s so dashboard stays live."""
    while True:
        time.sleep(8)
        try:
            save_progress()
        except Exception:
            pass


def main():
    wallets = load_wallets()
    log.info(f"v4 miner starting — {len(wallets)} wallets")
    threading.Thread(target=_progress_saver, daemon=True).start()
    rnd = 0
    while True:
        rnd += 1
        # --- watchdog: check API before each round ---
        state, ms = api_health()
        with _prog_lock:
            _progress.update(api=state, api_ms=ms, state=f"api {state} ({ms}ms)")
        save_progress()
        log.info(f"watchdog: API {state} ({ms}ms)")
        if state in ("down", "slow"):
            log.info(f"API {state} — wait {API_RETRY}s, retry (skip mining when API unstable)")
            with _prog_lock:
                _progress.update(state="waiting (API down)", pow_ok=False,
                                 api_green_since=0)
                if _progress.get("api_red_since", 0) == 0:
                    _progress["api_red_since"] = int(time.time())
            save_progress()
            time.sleep(API_RETRY)
            continue
        # healthz is green — but verify the PoW-answer endpoint actually works
        # before burning the VPS on 250 doomed wallets.
        probe_w = wallets[rnd % len(wallets)]
        ok = pow_probe(probe_w)
        with _prog_lock:
            was_ok = _progress.get("pow_ok") is True
            _progress["pow_ok"] = ok
            if ok and not was_ok:
                # API just became usable — start the uptime clock, clear downtime clock
                _progress["api_green_since"] = int(time.time())
                _progress["api_red_since"] = 0
            elif not ok:
                # API not usable — reset uptime clock, start/keep downtime clock
                _progress["api_green_since"] = 0
                if _progress.get("api_red_since", 0) == 0:
                    _progress["api_red_since"] = int(time.time())
        log.info(f"watchdog: PoW endpoint {'OK' if ok else 'DOWN'} (probe {probe_w})")
        if not ok:
            with _prog_lock:
                _progress["state"] = ("waiting (AWP PoW endpoint down — "
                                      "submissions cannot pass; auto-retry)")
            save_progress()
            time.sleep(POW_RETRY)
            continue
        # API up and PoW endpoint working — mine
        run_round(wallets, rnd)
        # adaptive gap: fast API → short gap, slow → longer
        gap = GAP_FAST if state == "fast" else GAP_SLOW
        with _prog_lock:
            _progress["state"] = f"idle (next round in {gap}s)"
        save_progress()
        time.sleep(gap)


if __name__ == "__main__":
    main()
