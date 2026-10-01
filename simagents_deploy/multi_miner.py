#!/usr/bin/env python3
"""
simagents.si multi-wallet miner.
Cycles through multiple Solana wallets, registering and mining in rotation.
Uses existing solvers.py for problem solving.
"""
import json, logging, os, sys, time, traceback
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from multiprocessing import Process, Queue

import requests
import solvers

BASE = "https://www.simagents.si"
DIR = os.path.expanduser("~/simagents")
WALLETS_FILE = os.path.join(DIR, "mining_wallets.json")
MINERS_FILE = os.path.join(DIR, "miners_state.json")
FAILED_DIR = os.path.join(DIR, "failed")
TIER = int(os.environ.get("SIM_TIER", "3"))
CHAT = "1643382168"
WIB = timezone(timedelta(hours=7))
MAX_WALLETS = int(os.environ.get("SIM_MAX_WALLETS", "100"))

os.makedirs(FAILED_DIR, exist_ok=True)

log = logging.getLogger("multi_miner")
log.setLevel(logging.INFO)
h = RotatingFileHandler(os.path.join(DIR, "multi_miner.log"), maxBytes=2_000_000, backupCount=2)
h.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
log.addHandler(h)
log.addHandler(logging.StreamHandler(sys.stdout))

S = requests.Session()
S.timeout = 30


def api(method, path, headers=None, **kw):
    for i in range(5):
        try:
            r = S.request(method, BASE + path, headers=headers, timeout=30, **kw)
            try:
                return r.status_code, r.json()
            except ValueError:
                return r.status_code, {"error": "bad_json", "message": r.text[:200]}
        except requests.RequestException as e:
            log.info(f"net error {path}: {e}")
            time.sleep(10 * (i + 1))
    return 0, {"error": "network"}


import re
def bot_token():
    try:
        src = open("/usr/local/bin/awp_api_monitor.sh").read()
        return re.search(r'^TOKEN="([^"]+)"', src, re.M).group(1)
    except (OSError, AttributeError):
        return None


def notify(text):
    tok = bot_token()
    if not tok:
        return
    try:
        requests.post(f"https://api.telegram.org/bot{tok}/sendMessage",
                      data={"chat_id": CHAT, "text": text}, timeout=20)
    except requests.RequestException:
        pass


def load_json(path, default=None):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return default if default is not None else {}


def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def save_failed(job, note):
    files = sorted(os.listdir(FAILED_DIR))
    for f in files[:-80]:
        try:
            os.remove(os.path.join(FAILED_DIR, f))
        except OSError:
            pass
    p = job.get("problem", {})
    name = f"{int(time.time())}_{p.get('type', 'x')}.json"
    with open(os.path.join(FAILED_DIR, name), "w") as f:
        json.dump({"note": note, "job": job}, f)


def _run(q, problem, attempt, previous):
    try:
        q.put(("ok", solvers.solve(problem, attempt=attempt, previous=previous)))
    except Exception:
        q.put(("err", traceback.format_exc()[-1500:]))


def solve_with_timeout(problem, seconds, attempt=0, previous=None):
    q = Queue()
    pr = Process(target=_run, args=(q, problem, attempt, previous))
    pr.start()
    pr.join(max(5, seconds))
    if pr.is_alive():
        pr.terminate()
        pr.join()
        return "timeout", None
    if q.empty():
        return "err", "no result"
    return q.get()


def secs_until_utc_midnight():
    now = datetime.now(timezone.utc)
    nxt = (now + timedelta(days=1)).replace(hour=0, minute=0, second=20, microsecond=0)
    return (nxt - now).total_seconds()


def register_miner(wallet_pub, name):
    """Try to register a miner. Returns (api_key, info_dict) or (None, error_dict)."""
    code, j = api("POST", "/api/agents/register", json={"name": name, "wallet": wallet_pub})
    if code == 200 and "api_key" in j:
        return j["api_key"], j
    return None, j


def auth_header(api_key):
    return {"Authorization": f"Bearer {api_key}"}


class WalletMiner:
    def __init__(self, idx, pubkey, name=None, api_key=None):
        self.idx = idx
        self.pubkey = pubkey
        self.name = name or f"hk-{idx:03d}"
        self.api_key = api_key
        self.registered = api_key is not None
        self.daily_capped = False
        self.cap_date = None
        self.last_vein_time = 0
        self.solved_today = 0
        self.total_solved = 0
        self.fail_streak = 0

    def headers(self):
        return auth_header(self.api_key) if self.api_key else {}

    def to_dict(self):
        return {
            "idx": self.idx, "pubkey": self.pubkey, "name": self.name,
            "api_key": self.api_key, "registered": self.registered,
            "total_solved": self.total_solved,
        }

    @classmethod
    def from_dict(cls, d):
        m = cls(d["idx"], d["pubkey"], d.get("name"), d.get("api_key"))
        m.registered = d.get("registered", m.api_key is not None)
        m.total_solved = d.get("total_solved", 0)
        return m


def main():
    wallets_data = load_json(WALLETS_FILE, [])
    if not wallets_data:
        log.error(f"No wallets found in {WALLETS_FILE}. Run derive_wallets.py first.")
        sys.exit(1)

    wallets_data = wallets_data[:MAX_WALLETS]
    log.info(f"Loaded {len(wallets_data)} wallets from {WALLETS_FILE}")

    miners_state = load_json(MINERS_FILE, {"miners": []})
    existing = {m["pubkey"]: m for m in miners_state.get("miners", [])}

    miners = []
    for w in wallets_data:
        pub = w["pubkey"]
        if pub in existing:
            miners.append(WalletMiner.from_dict(existing[pub]))
        else:
            miners.append(WalletMiner(w["idx"], pub))

    registered = [m for m in miners if m.registered]
    unregistered = [m for m in miners if not m.registered]
    log.info(f"Registered: {len(registered)}, Unregistered: {len(unregistered)}")

    ip_blocked = False
    notify(f"⛏️ Multi-miner mulai: {len(miners)} wallet, {len(registered)} sudah terdaftar, tier {TIER}.")

    # Registration phase: try to register unregistered wallets
    if unregistered and not ip_blocked:
        reg_count = 0
        for m in unregistered[:]:
            key, info = register_miner(m.pubkey, m.name)
            if key:
                m.api_key = key
                m.registered = True
                registered.append(m)
                unregistered.remove(m)
                reg_count += 1
                log.info(f"Registered [{m.idx}] {m.name} -> {m.pubkey[:12]}...")
                save_json(MINERS_FILE, {"miners": [m.to_dict() for m in miners]})
            elif info.get("error") == "one_miner_per_address":
                log.info(f"IP limit: hanya 1 miner per IP. Stop registrasi.")
                ip_blocked = True
                break
            elif info.get("error") == "lift_full":
                log.info(f"Lift full, lanjut registrasi nanti.")
                break
            else:
                log.info(f"Register [{m.idx}] failed: {info}")
                if info.get("error") == "name_taken":
                    m.name = f"hk{m.idx:03d}x"
                    key2, info2 = register_miner(m.pubkey, m.name)
                    if key2:
                        m.api_key = key2
                        m.registered = True
                        registered.append(m)
                        unregistered.remove(m)
                        reg_count += 1
                        log.info(f"Registered (alt name) [{m.idx}] {m.name}")
                        save_json(MINERS_FILE, {"miners": [m.to_dict() for m in miners]})

        if reg_count:
            notify(f"✅ {reg_count} miner baru terdaftar (total {len(registered)})")

    if not registered:
        log.info("No registered miners. Waiting for lift to open...")
        last_lift_log = 0
        while not registered:
            import datetime as _dt
            minute = _dt.datetime.now(_dt.timezone.utc).minute
            wait = 10 if (minute >= 55 or minute <= 2) else 30
            time.sleep(wait)
            for m in unregistered[:5]:
                key, info = register_miner(m.pubkey, m.name)
                if key:
                    m.api_key = key
                    m.registered = True
                    registered.append(m)
                    unregistered.remove(m)
                    log.info(f"Registered [{m.idx}] {m.name}")
                    save_json(MINERS_FILE, {"miners": [m.to_dict() for m in miners]})
                    notify(f"✅ Miner [{m.idx}] {m.name} terdaftar! Mulai mining.")
                elif info.get("error") == "one_miner_per_address":
                    ip_blocked = True
                    break
                elif info.get("error") == "lift_full":
                    if time.time() - last_lift_log > 300:
                        log.info(f"Lift still full, retrying every {wait}s...")
                        last_lift_log = time.time()
                    break
                else:
                    log.info(f"Register error: {info}")
                    break
            if ip_blocked:
                break

    if not registered:
        log.error("Cannot register any miner (IP blocked). Exiting.")
        notify("❌ Multi-miner: tidak bisa register (1 miner per IP). Butuh solusi proxy.")
        sys.exit(1)

    save_json(MINERS_FILE, {"miners": [m.to_dict() for m in miners]})

    # Mining loop: cycle through registered miners
    cycle_idx = 0
    last_reg_attempt = 0
    daily_stats = {"date": "", "total_solved": 0, "total_reward": 0}

    while True:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if daily_stats["date"] != today:
            if daily_stats["date"]:
                notify(f"📊 simagents hari {daily_stats['date']}: {daily_stats['total_solved']} soal, "
                       f"~{daily_stats['total_reward']:.6f} SOL")
            daily_stats = {"date": today, "total_solved": 0, "total_reward": 0}
            for m in miners:
                m.daily_capped = False
                m.cap_date = None
                m.solved_today = 0

        # Try to register more wallets periodically (every 5 min)
        if unregistered and not ip_blocked and time.time() - last_reg_attempt > 300:
            last_reg_attempt = time.time()
            for m in unregistered[:3]:
                key, info = register_miner(m.pubkey, m.name)
                if key:
                    m.api_key = key
                    m.registered = True
                    registered.append(m)
                    unregistered.remove(m)
                    log.info(f"Late-registered [{m.idx}] {m.name}")
                    save_json(MINERS_FILE, {"miners": [m.to_dict() for m in miners]})
                elif info.get("error") == "one_miner_per_address":
                    ip_blocked = True
                    break
                elif info.get("error") == "lift_full":
                    break

        # Pick next active miner (skip daily-capped ones)
        active = [m for m in registered if not m.daily_capped]
        if not active:
            wait = secs_until_utc_midnight()
            log.info(f"All {len(registered)} wallets capped for today. Sleeping {wait:.0f}s.")
            notify(f"🧱 Semua {len(registered)} wallet capped hari ini. Lanjut 07:00 WIB besok.")
            time.sleep(wait)
            continue

        miner = active[cycle_idx % len(active)]
        cycle_idx = (cycle_idx + 1) % max(1, len(active))

        # Start vein
        code, j = api("POST", "/api/mine/start", headers=miner.headers(), json={"tier": TIER})

        if code == 403 and j.get("error") == "one_miner_per_address":
            log.info(f"[{miner.idx}] one_miner_per_address on mine/start — waiting 30s")
            time.sleep(30)
            continue

        if code == 429:
            retry_ms = j.get("retry_after_ms", 60000)
            log.info(f"[{miner.idx}] resting {retry_ms/1000:.0f}s")
            time.sleep(retry_ms / 1000 + 1)
            continue

        if code != 200 or "problem" not in j:
            log.info(f"[{miner.idx}] start {code} {j}")
            time.sleep(30)
            continue

        problem = j["problem"]
        ptype = problem.get("type", "?")
        reward = j.get("reward_sol", 0)

        if not reward:
            api("POST", "/api/mine/abandon", headers=miner.headers())
            miner.daily_capped = True
            miner.cap_date = today
            log.info(f"[{miner.idx}] {miner.name} daily cap reached")
            continue

        expires = j.get("expires_at", time.time() * 1000 + 600000) / 1000
        earliest = j.get("earliest_submit_at", 0) / 1000

        api("POST", "/api/mine/note", headers=miner.headers(),
            json={"note": f"[{miner.idx}] digging {ptype}"})

        previous, solved = [], False
        for attempt in range(3):
            budget = expires - time.time() - 20
            if budget < 5:
                log.info(f"[{miner.idx}] {ptype}: no time left")
                break

            status, ans = solve_with_timeout(problem, budget, attempt, previous)
            if status != "ok" or ans is None:
                log.info(f"[{miner.idx}] {ptype}: solver {status} {str(ans)[:200]}")
                save_failed(j, f"solver {status}: {str(ans)[:500]}")
                break

            while time.time() < earliest:
                time.sleep(min(5, earliest - time.time() + 0.2))

            while True:
                code, r = api("POST", "/api/mine/submit", headers=miner.headers(),
                              json={"answer": ans})
                if code == 425:
                    time.sleep(r.get("retry_after_ms", 2000) / 1000 + 0.3)
                    continue
                break

            if r.get("correct"):
                solved = True
                miner.total_solved += 1
                miner.solved_today += 1
                miner.fail_streak = 0
                daily_stats["total_solved"] += 1
                daily_stats["total_reward"] += reward
                log.info(f"[{miner.idx}] {ptype}: CORRECT +{reward} SOL "
                         f"(today: {miner.solved_today}, total: {miner.total_solved})")
                break

            log.info(f"[{miner.idx}] {ptype}: wrong ({r.get('reason')}) left={r.get('attempts_left')}")
            previous.append({"answer": ans, "reason": r.get("reason")})
            save_failed(j, f"wrong: {r.get('reason')}")
            if not r.get("attempts_left"):
                break

        if not solved:
            api("POST", "/api/mine/abandon", headers=miner.headers())
            miner.fail_streak += 1
            if miner.fail_streak in (5, 20):
                notify(f"⚠️ [{miner.idx}] {miner.name}: {miner.fail_streak}x gagal berturut "
                       f"(terakhir: {ptype})")

        # Save state periodically
        if daily_stats["total_solved"] % 5 == 0:
            save_json(MINERS_FILE, {"miners": [m.to_dict() for m in miners]})

        # Check payout on any miner periodically
        if daily_stats["total_solved"] % 10 == 0 and miner.api_key:
            c, me = api("GET", "/api/agents/me", headers=miner.headers())
            if me.get("paid"):
                log.info(f"[{miner.idx}] paid={me.get('paid')} owed={me.get('owed')} "
                         f"solved={me.get('solved')}")


if __name__ == "__main__":
    main()
