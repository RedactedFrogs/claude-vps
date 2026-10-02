#!/usr/bin/env node
// GoCollect Dashboard v2 — mobile-friendly status page
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2] || process.env.DASHBOARD_PORT || "18792");
const STATE_FILE = resolve(__dirname, "gc-state.json");
const STATS_FILE = resolve(__dirname, "gc-stats.json");
const LOG_FILE = resolve(__dirname, "gc-farm.log");

function readJson(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null; } catch { return null; }
}

function formatWIB(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", hour12: false });
}

function tailLog(n = 20) {
  try {
    if (!existsSync(LOG_FILE)) return [];
    const buf = readFileSync(LOG_FILE, "utf-8");
    return buf.split("\n").filter(l => l.trim()).slice(-n);
  } catch { return []; }
}

function getBotStatus() {
  try {
    const out = execSync("pgrep -f 'node.*gc-farm' 2>/dev/null", { encoding: "utf-8", timeout: 3000 }).trim();
    if (out) return "running";
    return "stopped";
  } catch { return "stopped"; }
}

function esc(s) { return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function renderPage() {
  const state = readJson(STATE_FILE);
  const statsData = readJson(STATS_FILE);

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
  const daily = statsData?.days?.[today] || {};
  const wallets = state?.wallets || [];
  const updatedAt = formatWIB(statsData?.wallets ? Object.values(statsData.wallets).reduce((a, w) => w.lastActive > a ? w.lastActive : a, "") : state?.updatedAt);
  const botStatus = getBotStatus();
  const logLines = tailLog(25);

  const opened = daily.opened || 0;
  const dailyLimit = 25;
  const pct = Math.min(100, Math.round(opened / dailyLimit * 100));

  const statusDot = botStatus === "running" ? "🟢" : botStatus === "selesai" ? "🔵" : "🔴";
  const statusText = botStatus === "running" ? "Bot Jalan" : botStatus === "selesai" ? "Cycle Selesai" : "Bot Mati";

  const winCount = daily.wins?.length || 0;
  const winRate = opened > 0 ? ((winCount / opened) * 100).toFixed(1) : "0";

  let winsHtml = "";
  if (daily.wins && daily.wins.length > 0) {
    winsHtml = daily.wins.map(w =>
      `<tr><td>${esc(w.wallet)}</td><td>${esc((w.crateId||"").slice(0,8))}</td><td>${esc(w.reward)}</td><td>${esc(w.time)}</td></tr>`
    ).join("");
  } else {
    winsHtml = `<tr><td colspan="4" class="empty">Belum ada win hari ini</td></tr>`;
  }

  let walletsHtml = "";
  if (statsData?.wallets) {
    walletsHtml = Object.entries(statsData.wallets).map(([addr, w], i) => {
      const st = w.status || "idle";
      const sc = st === "done" || st === "idle" ? "#10b981" : st === "error" || st === "banned" ? "#ef4444" :
        ["walking_to_crate","opening_crate","refetching_crates"].includes(st) ? "#34d399" : "#f59e0b";
      const label = {walking_to_crate:"jalan...",opening_crate:"buka...",refetching_crates:"fetch...",break:"istirahat",idle:"idle",done:"selesai",error:"error",logged_in:"login OK",logging_in:"login..."}[st] || st;
      return `<tr><td>#${i}</td><td>${esc(addr.slice(0,10))}</td><td><span style="color:${sc}">${label}</span></td><td>${w.totalOpened||0}</td><td>${w.totalWins||0}</td></tr>`;
    }).join("");
  }
  if (!walletsHtml) walletsHtml = `<tr><td colspan="5" class="empty">Bot belum jalan</td></tr>`;

  let historyHtml = "";
  if (statsData?.days) {
    const sortedDays = Object.entries(statsData.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 7);
    historyHtml = sortedDays.map(([date, d]) => {
      const wr = d.opened > 0 ? ((d.wins?.length || 0) / d.opened * 100).toFixed(0) : "0";
      return `<tr><td>${date}</td><td>${d.opened||0}/25</td><td>${d.wins?.length||0}</td><td>${wr}%</td><td>${d.errors||0}</td></tr>`;
    }).join("");
  }
  if (!historyHtml) historyHtml = `<tr><td colspan="5" class="empty">-</td></tr>`;

  const logHtml = logLines.map(l => `<div>${esc(l)}</div>`).join("");

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>GoCollect Bot</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;padding:12px;max-width:600px;margin:0 auto}
h1{font-size:18px;color:#34d399;display:flex;align-items:center;gap:8px}
.sub{font-size:11px;color:#64748b;margin:2px 0 12px}
.status{display:inline-flex;align-items:center;gap:6px;background:#1e293b;padding:6px 12px;border-radius:20px;font-size:13px;margin-bottom:12px}
.progress{background:#1e293b;border-radius:8px;height:32px;position:relative;overflow:hidden;margin-bottom:16px}
.progress-bar{height:100%;background:linear-gradient(90deg,#059669,#34d399);border-radius:8px;transition:width 0.5s}
.progress-text{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:13px;font-weight:600}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}
.card{background:#1e293b;border-radius:8px;padding:10px;text-align:center}
.card .val{font-size:22px;font-weight:700;color:#34d399}
.card .lbl{font-size:10px;color:#94a3b8;margin-top:2px}
h2{font-size:14px;color:#94a3b8;margin:12px 0 6px}
table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px}
th{text-align:left;padding:6px;border-bottom:1px solid #334155;color:#94a3b8;font-weight:500;font-size:11px}
td{padding:6px;border-bottom:1px solid #1e293b}
.empty{text-align:center;color:#6b7280;padding:12px}
.log{background:#1e293b;border-radius:8px;padding:10px;font-family:'Courier New',monospace;font-size:10px;color:#94a3b8;max-height:300px;overflow-y:auto;line-height:1.5;word-break:break-all}
.log div:last-child{color:#e2e8f0}
</style>
</head><body>
<h1>GoCollect Bot</h1>
<p class="sub">Update: ${updatedAt} WIB | Refresh 15s</p>

<div class="status">${statusDot} ${statusText}</div>

<h2>Hari Ini — ${opened}/${dailyLimit} crate</h2>
<div class="progress">
  <div class="progress-bar" style="width:${pct}%"></div>
  <div class="progress-text">${opened} / ${dailyLimit} (${pct}%)</div>
</div>

<div class="cards">
  <div class="card"><div class="val">${opened}</div><div class="lbl">Opened</div></div>
  <div class="card"><div class="val">${winCount}</div><div class="lbl">Wins</div></div>
  <div class="card"><div class="val">${winRate}%</div><div class="lbl">Win Rate</div></div>
  <div class="card"><div class="val">${daily.errors || 0}</div><div class="lbl">Errors</div></div>
</div>

<h2>Wallet</h2>
<table>
<tr><th>#</th><th>Address</th><th>Status</th><th>Total Open</th><th>Total Win</th></tr>
${walletsHtml}
</table>

<h2>Wins Hari Ini</h2>
<table>
<tr><th>Wallet</th><th>Crate</th><th>Reward</th><th>Waktu</th></tr>
${winsHtml}
</table>

<h2>History (7 hari)</h2>
<table>
<tr><th>Tanggal</th><th>Opened</th><th>Wins</th><th>Rate</th><th>Errors</th></tr>
${historyHtml}
</table>

<h2>Log Terakhir</h2>
<div class="log">${logHtml || '<div>Belum ada log</div>'}</div>

</body></html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ state: readJson(STATE_FILE), stats: readJson(STATS_FILE), bot: getBotStatus() }));
    return;
  }
  if (req.url === "/api/log") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ lines: tailLog(50) }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage());
});

server.listen(PORT, () => {
  console.log(`Dashboard v2 aktif di http://localhost:${PORT}`);
});
