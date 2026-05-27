#!/usr/bin/env python3
"""AWP Dashboard — system status + custom miner stats + reward balances + logs.
Regenerated every minute by cron; browser auto-refreshes every 30s.
"""
import json, time, subprocess, html
from pathlib import Path
from urllib.request import urlopen, Request

WALLETS_INFO  = Path("/root/.awp-mining/wallets-info")
ALL_STATUS    = Path("/root/.awp-mining/all-wallets-status.txt")
OUTPUT_HTML   = Path("/root/.awp-mining/dashboard.html")
CREDS         = Path("/root/.claude/.credentials.json")
BALANCES      = Path("/var/cache/awp/balances.json")
POOL_FILE     = Path("/root/.awp-mining/article_pool.jsonl")
RESULTS       = Path("/var/log/awp/miner-results.jsonl")
RUNNER_LOG    = Path("/var/log/awp/runner.log")
OAUTH_LOG     = Path("/var/log/awp/oauth-refresh.log")
WALLET_001    = ("wallet-001", "0x1455351A742Aeb7729C3Aa28c78897CF9e4811a2", "[registered, default]")
API_URL       = "https://api.minework.net/healthz"


def run(cmd, timeout=6):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except Exception:
        return None


# ---- status checks ----
def check_api():
    """Real API status — 3-state: green (stable), yellow (unstable), red (down).
    Returns (status, detail, green_since, red_since, api_ms)."""
    try:
        p = json.loads(Path("/var/cache/awp/miner-progress.json").read_text())
    except Exception:
        return "red", "status belum diketahui", 0, 0, 0
    pow_ok = p.get("pow_ok")
    api_ms = int(p.get("api_ms", 0) or 0)
    green_since = int(p.get("api_green_since", 0) or 0)
    red_since = int(p.get("api_red_since", 0) or 0)
    uptime = int(time.time()) - green_since if green_since > 0 else 0
    if pow_ok is False:
        return "red", "DOWN — PoW endpoint hang (platform-side, bukan kita)", 0, red_since, api_ms
    if pow_ok is True:
        # Yellow if slow (>2s) OR just-recovered (<60s uptime)
        if api_ms >= 2000 or uptime < 60:
            return "yellow", f"UNSTABLE — {api_ms}ms response (slow/recovering)", green_since, 0, api_ms
        return "green", "STABLE — miner can submit reliably", green_since, 0, api_ms
    return "red", "belum dicek miner", 0, 0, 0


def check_miner():
    r = run(["systemctl", "is-active", "awp-miner.service"])
    active = (r and r.stdout.strip() == "active")
    active_now = done = 0
    try:
        p = json.loads(Path("/var/cache/awp/miner-progress.json").read_text())
        active_now = p.get("active_now", 0)
        done = p.get("wallets_done", 0)
    except Exception:
        pass
    detail = (f"service={'on' if active else 'OFF'} — "
              f"{active_now} mining now, {done} done this round")
    return active, detail


def check_pool():
    try:
        n = sum(1 for _ in open(POOL_FILE))
    except Exception:
        n = 0
    return n > 0, f"{n} Wikipedia articles ready"


def check_oauth():
    try:
        c = json.loads(CREDS.read_text())
        rem = (c["claudeAiOauth"]["expiresAt"] / 1000 - time.time()) / 3600
        if rem > 1:
            return True, f"valid {rem:.1f}h"
        if rem > 0:
            return True, f"expiring {rem*60:.0f}m"
        return False, f"EXPIRED {-rem:.1f}h ago"
    except Exception as e:
        return False, f"ERR: {type(e).__name__}"


def check_load():
    try:
        with open("/proc/loadavg") as f:
            p = f.read().split()
        l1, l5 = float(p[0]), float(p[1])
    except Exception:
        return False, "ERR"
    if l1 > 6:
        return False, f"HIGH {l1:.1f} (CPU saturated)"
    return True, f"{'warm' if l1 > 4 else 'OK'} {l1:.1f} (5m: {l5:.1f})"


# ---- custom miner stats (v4 live progress) ----
PROGRESS_JSON = Path("/var/cache/awp/miner-progress.json")

def miner_stats():
    """Read v4 live progress JSON."""
    try:
        return json.loads(PROGRESS_JSON.read_text())
    except Exception:
        return {}


def read_tail(path, n):
    if not path.exists():
        return "(no file yet)"
    try:
        out = run(["tail", f"-{n}", str(path)])
        return out.stdout if out and out.stdout else "(empty)"
    except Exception:
        return "(error)"


def load_balances():
    try:
        return json.loads(BALANCES.read_text())
    except Exception:
        return None


def load_wallets():
    wallets = [WALLET_001]
    smap = {}
    if ALL_STATUS.exists():
        for line in ALL_STATUS.read_text().split("\n"):
            parts = line.split(maxsplit=2)
            if len(parts) >= 3:
                smap[parts[0]] = parts[2]
    if WALLETS_INFO.exists():
        for f in sorted(WALLETS_INFO.glob("wallet-*.json")):
            try:
                data = json.loads(f.read_text())
            except Exception:
                data = {}
            wallets.append((f.stem, data.get("address", "?"),
                            smap.get(f.stem, "[unknown]")))
    return wallets


def badge(s):
    if "STUCK" in s: return '<span class="b stuck">STUCK</span>'
    if "pending" in s: return '<span class="b pending">PENDING</span>'
    if "registered" in s: return '<span class="b ok">REGISTERED</span>'
    return '<span class="b unknown">UNKNOWN</span>'


def dot(ok, label, detail):
    return (f'<div class="si"><span class="dot {"green" if ok else "red"}"></span>'
            f'<span class="sl">{label}</span>'
            f'<span class="sd">{html.escape(detail)}</span></div>')


def fmt_uptime(secs):
    """Scale the unit: detik < 60s, menit < 60min, jam beyond."""
    secs = int(secs)
    if secs < 0:
        secs = 0
    if secs < 60:
        return f"{secs} detik"
    if secs < 3600:
        return f"{secs // 60} menit"
    h, m = secs // 3600, (secs % 3600) // 60
    return f"{h} jam {m} menit"


def generate():
    api_status, api_d, api_green_since, api_red_since, api_ms = check_api()
    api_ok = api_status == "green"
    miner_ok, miner_d = check_miner()
    pool_ok, pool_d = check_pool()
    oauth_ok, oauth_d = check_oauth()
    load_ok, load_d = check_load()
    ms = miner_stats()
    bal = load_balances()
    wallets = load_wallets()

    total = len(wallets)
    reg = sum(1 for _, _, s in wallets if "registered" in s and "STUCK" not in s and "pending" not in s)

    api_dur_html = ""
    if api_status == "green" and api_green_since > 0:
        api_dur_html = (f'<span class="sd api-up" data-since="{api_green_since}" '
                        f'style="color:#4f4;font-weight:bold">'
                        f'hijau {fmt_uptime(time.time() - api_green_since)}</span>')
    elif api_status == "yellow" and api_green_since > 0:
        api_dur_html = (f'<span class="sd api-mid" data-since="{api_green_since}" '
                        f'style="color:#fc0;font-weight:bold">'
                        f'kuning {fmt_uptime(time.time() - api_green_since)}</span>')
    elif api_status == "red" and api_red_since > 0:
        api_dur_html = (f'<span class="sd api-down" data-since="{api_red_since}" '
                        f'style="color:#f88;font-weight:bold">'
                        f'merah {fmt_uptime(time.time() - api_red_since)}</span>')
    api_item = (f'<div class="si"><span class="dot {api_status}"></span>'
                f'<span class="sl">API</span>'
                f'<span class="sd">{html.escape(api_d)}</span>{api_dur_html}</div>')
    status = (api_item + dot(miner_ok, "Miner", miner_d) +
              dot(pool_ok, "Pool", pool_d) +
              dot(load_ok, "Load", load_d))

    bal_amine = bal["totals"].get("amine", 0) if bal else 0
    bal_awp = bal["totals"].get("awp", 0) if bal else 0
    bal_upd = bal["updated_iso"] if bal else "(belum)"

    rows = []
    for i, (name, addr, st) in enumerate(wallets, 1):
        rows.append(f'<tr><td>{i}</td><td>{name}</td>'
                    f'<td><a href="https://minework.net/rewards?address={addr}" '
                    f'target="_blank" class="addr">{addr}</a></td>'
                    f'<td>{badge(st)}</td></tr>')
    rows_html = "\n".join(rows)

    runner_log = html.escape(read_tail(Path("/var/log/awp/miner-v4.log"), 45))
    oauth_log = html.escape(read_tail(OAUTH_LOG, 15))
    now = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())

    # v4 live miner fields
    m_state   = ms.get("state", "?")
    m_round   = ms.get("round", 0)
    m_api     = ms.get("api", "?")
    m_apims   = ms.get("api_ms", 0)
    m_done    = ms.get("wallets_done", 0)
    m_wtotal  = ms.get("wallets_total", 0)
    m_active  = ms.get("active_now", 0)
    m_racc    = ms.get("round_accepted", 0)
    m_rerr    = ms.get("round_errors", 0)
    m_rrl     = ms.get("round_rate_limited", 0)
    m_life    = ms.get("lifetime_accepted", 0)
    m_upd     = ms.get("updated_iso", "(belum)")

    return f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="30"><title>AWP Dashboard</title><style>
*{{box-sizing:border-box}}
body{{font-family:'Courier New',monospace;background:#0a0a0a;color:#ddd;padding:20px;max-width:1300px;margin:auto}}
h1{{color:#4af;margin:0 0 4px}} .sub{{color:#888;font-size:13px;margin-bottom:18px}}
.bar{{display:flex;gap:22px;align-items:center;padding:14px 20px;background:#1a1a1a;border-radius:8px;margin-bottom:14px;flex-wrap:wrap;border:1px solid #2a2a2a}}
.si{{display:flex;align-items:center;gap:7px}} .sl{{font-weight:bold;font-size:14px}}
.sd{{color:#888;font-size:11px}} .dot{{width:10px;height:10px;border-radius:50%;display:inline-block}}
.dot.green{{background:#1f1;box-shadow:0 0 8px #1f1}} .dot.yellow{{background:#fc0;box-shadow:0 0 8px #fc0}} .dot.red{{background:#f33;box-shadow:0 0 8px #f33}}
.stats{{display:flex;gap:12px;margin:14px 0;flex-wrap:wrap}}
.stat{{padding:14px 20px;background:#1a1a1a;border-radius:8px;min-width:135px}}
.stat .l{{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px}}
.stat .v{{font-size:30px;font-weight:bold;color:#4af;margin-top:3px}}
.stat.acc .v{{color:#4f4}} .stat.err .v{{color:#f77}} .stat.warn .v{{color:#fc0}} .stat.gold .v{{color:#ffd700}} .stat.awp .v{{color:#5cf}} .stat.live .v{{color:#ff4}}
.sect{{color:#4af;font-size:15px;margin:22px 0 6px;font-weight:bold;text-transform:uppercase;letter-spacing:1px}}
.note{{color:#666;font-size:11px;font-weight:normal;text-transform:none}}
.tabs{{display:flex;gap:4px;margin-top:8px}}
.tab{{padding:9px 16px;cursor:pointer;background:#161616;border:1px solid #2a2a2a;border-bottom:none;border-radius:6px 6px 0 0;color:#888;font-size:12px}}
.tab.active{{background:#1f1f1f;color:#4af;border-color:#4af}}
.panel{{display:none;background:#0d0d0d;padding:14px;border:1px solid #2a2a2a;border-radius:0 8px 8px 8px;font-size:12px;line-height:1.4;max-height:380px;overflow-y:auto;white-space:pre-wrap;color:#bbb}}
.panel.active{{display:block}}
#s{{width:100%;padding:11px;background:#1a1a1a;border:1px solid #333;color:#ddd;font-family:inherit;font-size:14px;margin:18px 0 10px;border-radius:6px}}
table{{border-collapse:collapse;width:100%;background:#111;border-radius:6px;overflow:hidden}}
th{{background:#1f1f1f;color:#4af;padding:11px;text-align:left;font-size:13px}}
td{{padding:8px 11px;border-bottom:1px solid #1c1c1c;font-size:13px}}
tr:hover td{{background:#1a1a1a}} a.addr{{color:#6cf;text-decoration:none}}
.b{{padding:3px 9px;border-radius:4px;font-size:11px;font-weight:bold}}
.b.ok{{background:#0d4;color:#fff}} .b.pending{{background:#fa3;color:#000}}
.b.stuck{{background:#c33;color:#fff}} .b.unknown{{background:#555;color:#fff}}
</style></head><body>
<h1>AWP Dashboard</h1>
<div class="sub">Updated: {now} — auto-refresh 30s. Custom miner: heartbeat → PoW → submit. &nbsp;·&nbsp; <a href="/zcash_dashboard.html" style="color:#f4b733;font-weight:bold">⛏ Zcash Node Dashboard →</a></div>
<div class="bar">{status}</div>

<div class="sect">Custom Miner v4 — LIVE <span class="note">(state: {html.escape(str(m_state))} · ronde {m_round} · update {m_upd})</span></div>
<div class="stats">
  <div class="stat acc"><div class="l">Accepted (ronde ini)</div><div class="v">{m_racc}</div></div>
  <div class="stat acc"><div class="l">Accepted (total)</div><div class="v">{m_life}</div></div>
  <div class="stat live"><div class="l">Mining sekarang</div><div class="v">{m_active}</div></div>
  <div class="stat"><div class="l">Wallet selesai</div><div class="v">{m_done}/{m_wtotal}</div></div>
  <div class="stat err"><div class="l">Rate-limited</div><div class="v">{m_rrl}</div></div>
  <div class="stat err"><div class="l">Errors</div><div class="v">{m_rerr}</div></div>
  <div class="stat {("acc" if api_status=="green" else "warn" if api_status=="yellow" else "err")}"><div class="l">API platform</div><div class="v" style="font-size:24px">{("STABIL" if api_status=="green" else "UNSTABLE" if api_status=="yellow" else "DOWN")}<br><span class="{("api-up" if api_status=="green" else "api-mid" if api_status=="yellow" else "api-down")}" data-since="{api_green_since if (api_status in ("green","yellow") and api_green_since>0) else (api_red_since if api_red_since>0 else 0)}" style="font-size:12px;color:#888">{((("hijau " if api_status=="green" else "kuning ") + fmt_uptime(time.time() - api_green_since)) if (api_status in ("green","yellow") and api_green_since>0) else (("merah " + fmt_uptime(time.time() - api_red_since)) if (api_status=="red" and api_red_since>0) else "belum tracked"))}</span></div></div>
</div>

<div class="sect">Reward Balances <span class="note">(on-chain, updated {bal_upd})</span></div>
<div class="stats">
  <div class="stat gold"><div class="l">Total $aMine</div><div class="v">{bal_amine:.4f}</div></div>
  <div class="stat awp"><div class="l">Total $AWP</div><div class="v">{bal_awp:.4f}</div></div>
  <div class="stat"><div class="l">Wallet terdaftar</div><div class="v">{reg}/{total}</div></div>
</div>

<div class="sect">Logs <span class="note">(live)</span></div>
<div class="tabs">
  <div class="tab active" data-t="runner">miner-v4.log</div>
</div>
<div class="panel active" id="p-runner">{runner_log}</div>

<input id="s" placeholder="Filter wallet / address..." onkeyup="f()">
<table id="t"><thead><tr><th>#</th><th>Wallet</th><th>Address</th><th>Status</th></tr></thead>
<tbody>{rows_html}</tbody></table>
<script>
function f(){{var q=document.getElementById('s').value.toLowerCase();
document.querySelectorAll('#t tbody tr').forEach(r=>{{
r.style.display=r.textContent.toLowerCase().includes(q)?'':'none';}});}}
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{{
document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));
t.classList.add('active');
document.getElementById('p-'+t.dataset.t).classList.add('active');}}));
document.querySelectorAll('.panel').forEach(p=>{{p.scrollTop=p.scrollHeight}});
function fmtUp(s){{s=Math.floor(s);if(s<0)s=0;
if(s<60)return s+' detik';
if(s<3600)return Math.floor(s/60)+' menit';
return Math.floor(s/3600)+' jam '+Math.floor((s%3600)/60)+' menit';}}
function tickUp(){{var now=Math.floor(Date.now()/1000);
document.querySelectorAll('.api-up').forEach(function(el){{
var since=parseInt(el.dataset.since||'0');
if(since>0)el.textContent='nyala '+fmtUp(now-since);}});
document.querySelectorAll('.api-mid').forEach(function(el){{
var since=parseInt(el.dataset.since||'0');
if(since>0)el.textContent='kuning '+fmtUp(now-since);}});
document.querySelectorAll('.api-up').forEach(function(el){{
var since=parseInt(el.dataset.since||'0');
if(since>0)el.textContent='hijau '+fmtUp(now-since);}});
document.querySelectorAll('.api-down').forEach(function(el){{
var since=parseInt(el.dataset.since||'0');
if(since>0)el.textContent='mati '+fmtUp(now-since);}});}}
setInterval(tickUp,1000);tickUp();
</script></body></html>"""


def main():
    OUTPUT_HTML.write_text(generate())
    print(f"dashboard generated: {OUTPUT_HTML}")


if __name__ == "__main__":
    main()
