#!/usr/bin/env node
// GoCollect Dashboard — simple status page (baca gc-state.json + gc-stats.json)
// Usage: node gc-dashboard.mjs [port]
// Default port: 18792

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2] || process.env.DASHBOARD_PORT || "18792");
const STATE_FILE = resolve(__dirname, "gc-state.json");
const STATS_FILE = resolve(__dirname, "gc-stats.json");

function readJson(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null; } catch { return null; }
}

function formatWIB(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}

function renderPage() {
  const state = readJson(STATE_FILE);
  const statsData = readJson(STATS_FILE);

  const daily = state?.daily || {};
  const wallets = state?.wallets || [];
  const updatedAt = formatWIB(state?.updatedAt);

  let winsHtml = "";
  if (daily.wins && daily.wins.length > 0) {
    winsHtml = daily.wins.map((w) =>
      `<tr><td>${w.wallet || "?"}</td><td>${w.crateId || "-"}</td><td>${w.reward || "-"}</td><td>${w.time || "-"}</td></tr>`
    ).join("");
  } else {
    winsHtml = `<tr><td colspan="4" style="text-align:center;color:#6b7280">Belum ada win hari ini</td></tr>`;
  }

  let walletsHtml = wallets.map((w) => {
    const statusColor = w.status === "done" ? "#10b981" : w.status === "error" ? "#ef4444" : "#f59e0b";
    return `<tr>
      <td>#${w.index}</td>
      <td>${w.addr || "?"}</td>
      <td><span style="color:${statusColor}">${w.status || "?"}</span></td>
      <td>${w.opened ?? "-"}</td>
      <td>${w.wins ?? "-"}</td>
      <td style="font-size:12px;color:#9ca3af">${w.error || ""}</td>
    </tr>`;
  }).join("");

  if (!walletsHtml) {
    walletsHtml = `<tr><td colspan="6" style="text-align:center;color:#6b7280">Bot belum jalan</td></tr>`;
  }

  let historyHtml = "";
  if (statsData?.days) {
    const sortedDays = Object.entries(statsData.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 7);
    historyHtml = sortedDays.map(([date, d]) => {
      const winRate = d.opened > 0 ? ((d.wins?.length || 0) / d.opened * 100).toFixed(1) : "0";
      return `<tr><td>${date}</td><td>${d.opened || 0}</td><td>${d.wins?.length || 0}</td><td>${winRate}%</td><td>${d.errors || 0}</td></tr>`;
    }).join("");
  }
  if (!historyHtml) historyHtml = `<tr><td colspan="5" style="text-align:center;color:#6b7280">Belum ada data</td></tr>`;

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>GoCollect Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;padding:16px}
h1{font-size:20px;color:#34d399;margin-bottom:4px}
.sub{font-size:12px;color:#64748b;margin-bottom:20px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:24px}
.card{background:#1e293b;border-radius:8px;padding:16px;text-align:center}
.card .val{font-size:28px;font-weight:700;color:#34d399}
.card .lbl{font-size:12px;color:#94a3b8;margin-top:4px}
h2{font-size:16px;color:#94a3b8;margin:16px 0 8px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px}
th{text-align:left;padding:8px;border-bottom:1px solid #334155;color:#94a3b8;font-weight:500}
td{padding:8px;border-bottom:1px solid #1e293b}
tr:hover{background:#1e293b}
</style>
</head><body>
<h1>GoCollect Dashboard</h1>
<p class="sub">Update: ${updatedAt} WIB | Auto-refresh 30 detik</p>

<div class="cards">
  <div class="card"><div class="val">${daily.opened || 0}</div><div class="lbl">Opened</div></div>
  <div class="card"><div class="val">${daily.winCount || daily.wins?.length || 0}</div><div class="lbl">Wins</div></div>
  <div class="card"><div class="val">${daily.winRate || "0"}%</div><div class="lbl">Win Rate</div></div>
  <div class="card"><div class="val">${daily.errors || 0}</div><div class="lbl">Errors</div></div>
</div>

<h2>Wallets (cycle terakhir)</h2>
<table>
<tr><th>#</th><th>Address</th><th>Status</th><th>Opened</th><th>Wins</th><th>Error</th></tr>
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

</body></html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ state: readJson(STATE_FILE), stats: readJson(STATS_FILE) }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage());
});

server.listen(PORT, () => {
  console.log(`Dashboard aktif di http://localhost:${PORT}`);
  console.log("Buka di browser atau via cloudflared tunnel.");
});
