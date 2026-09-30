#!/usr/bin/env node
// GoCollect Farm v2 — full auto-play with movement simulation, multi-proxy, anti-ban
//
// Usage:
//   node gc-farm.mjs --update-keys          # download bundle, extract HMAC keys + sitekey
//   node gc-farm.mjs --diagnose             # cek config, bundle, koneksi
//   node gc-farm.mjs --dry-run              # login + getCrates + walk sim, TANPA open crate
//   node gc-farm.mjs --dry-run --wallet 0   # dry run 1 wallet saja
//   node gc-farm.mjs --live --wallet 0      # live 1 wallet (test dulu sebelum scale)
//   node gc-farm.mjs --live                 # live semua wallet
//   node gc-farm.mjs --live --loop          # live + ulangi terus (daily loop)
//   node gc-farm.mjs --manual-captcha --live --wallet 0  # live + manual captcha
//
// Config: buat file .env di folder ini (lihat .env.example)

import { createHmac, createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import http from "node:http";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";
import { SocksProxyAgent } from "socks-proxy-agent";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ======================== CONFIG ========================

function loadEnv() {
  const envPath = resolve(__dirname, ".env");
  if (!existsSync(envPath)) {
    console.error("ERROR: .env tidak ditemukan. Copy .env.example -> .env dan isi config.");
    process.exit(1);
  }
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv();

const CFG = {
  captchaKey: process.env.CAPTCHA_API_KEY || "",
  sitekey: process.env.GC_SITEKEY || "",
  proxyUrl: process.env.PROXY_URL || "",
  proxyListFile: process.env.PROXY_LIST_FILE || "",
  captchaProxy: process.env.CAPTCHA_PROXY || "",
  captchaProxyLogin: process.env.CAPTCHA_PROXY_LOGIN || "",
  captchaProxyPass: process.env.CAPTCHA_PROXY_PASS || "",
  captchaProxyType: process.env.CAPTCHA_PROXY_TYPE || "socks5",
  walletsFile: process.env.WALLETS_FILE || "",
  defaultLat: parseFloat(process.env.DEFAULT_LAT || "-6.2088"),
  defaultLng: parseFloat(process.env.DEFAULT_LNG || "106.8456"),
  userAgent: process.env.USER_AGENT || "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  maxLogSize: parseInt(process.env.MAX_LOG_SIZE || "10485760"),
  walletDelay: parseInt(process.env.WALLET_DELAY || "15000"),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  captchaPort: parseInt(process.env.CAPTCHA_PORT || "18791"),
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || "18792"),
  cratesPerSession: parseInt(process.env.CRATES_PER_SESSION || "8"),
  breakMinMinutes: parseFloat(process.env.BREAK_MIN_MINUTES || "3"),
  breakMaxMinutes: parseFloat(process.env.BREAK_MAX_MINUTES || "7"),
  loopHours: parseFloat(process.env.LOOP_HOURS || "6"),
};

const GC_BASE = "https://gocollect.fun";
const GC_API = "https://gocollect.fun";
const KEYS_FILE = resolve(__dirname, "gc-keys.json");
const LOG_FILE = resolve(__dirname, "gc-farm.log");
const STATS_FILE = resolve(__dirname, "gc-stats.json");
const STATE_FILE = resolve(__dirname, "gc-state.json");

// ======================== LOGGING ========================

function log(msg) {
  const ts = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const line = `[${ts}] ${msg}\n`;
  process.stdout.write(line);
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > CFG.maxLogSize) {
      const old = readFileSync(LOG_FILE, "utf-8");
      writeFileSync(LOG_FILE, old.slice(-Math.floor(CFG.maxLogSize / 2)));
    }
    appendFileSync(LOG_FILE, line);
  } catch {}
}

function logErr(msg) { log("ERROR: " + msg); }

// ======================== TELEGRAM ========================

async function sendTelegram(text) {
  if (!CFG.telegramToken || !CFG.telegramChatId) return;
  try {
    await gcFetch(`https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CFG.telegramChatId, text, parse_mode: "HTML" }),
    });
  } catch (e) { logErr(`Telegram gagal: ${e.message}`); }
}

// ======================== HTTP HELPER ========================

function makeProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (proxyUrl.startsWith("socks")) return new SocksProxyAgent(proxyUrl);
  return undefined;
}

function loadProxyList() {
  if (!CFG.proxyListFile) return [];
  const file = resolve(__dirname, CFG.proxyListFile);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

const defaultAgent = makeProxyAgent(CFG.proxyUrl);
const proxyList = loadProxyList();

function gcFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const mod = isHttps ? https : http;

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method || "GET",
      headers: {
        "User-Agent": CFG.userAgent,
        Accept: "application/json",
        ...(opts.headers || {}),
      },
      agent: opts.agent !== undefined ? opts.agent : defaultAgent,
      timeout: opts.timeout || 30000,
    };

    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          json() {
            try { return JSON.parse(body); } catch { return null; }
          },
        });
      });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (opts.body) req.write(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

// ======================== HMAC & CRYPTO ========================

function xorBuffers(a, b) {
  const len = Math.max(a.length, b.length);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = (a[i] || 0) ^ (b[i] || 0);
  return out;
}

function deriveHmacKey(j3, k3) {
  return xorBuffers(Buffer.from(j3, "base64"), Buffer.from(k3, "base64"));
}

function base64urlNoPad(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function generateProof(method, path, timestamp, deviceId, hmacKey) {
  const pathOnly = path.split("?")[0];
  const message = `${method.toUpperCase()} ${pathOnly} ${timestamp} ${deviceId}`;
  const sig = createHmac("sha256", hmacKey).update(message).digest();
  return `${timestamp}.${base64urlNoPad(sig)}`;
}

function computeOpenCdata(bearerToken) {
  return createHash("sha256").update("gc-cdata|" + bearerToken).digest("hex").slice(0, 32);
}

// ======================== BUNDLE KEY EXTRACTION ========================

async function downloadBundle() {
  log("Download bundle dari GoCollect...");
  const htmlRes = await gcFetch(GC_BASE + "/");
  if (htmlRes.status !== 200) throw new Error(`HTML fetch gagal: ${htmlRes.status}`);

  const jsMatch = htmlRes.body.match(/index-[A-Za-z0-9_-]+\.js/);
  if (!jsMatch) throw new Error("Bundle JS tidak ditemukan di HTML");

  const bundleName = jsMatch[0];
  log(`Bundle: ${bundleName}`);

  const jsRes = await gcFetch(`${GC_BASE}/assets/${bundleName}`);
  if (jsRes.status !== 200) throw new Error(`Bundle fetch gagal: ${jsRes.status}`);

  return { bundleName, code: jsRes.body };
}

function extractKeysFromBundle(code) {
  const keyMatch = code.match(
    /const\s+\w{1,3}="([A-Za-z0-9+/=]{30,60})",\s*\w{1,3}="([A-Za-z0-9+/=]{30,60})"/
  );
  if (!keyMatch) throw new Error("Pattern HMAC keys tidak ditemukan di bundle");

  const j3 = keyMatch[1];
  const k3 = keyMatch[2];

  const buildMatch = code.match(/"(1[789]\d{11,12})"/);
  const buildId = buildMatch ? buildMatch[1] : null;

  const skMatch =
    code.match(/sitekey:\s*"(0x[A-Fa-f0-9]{16,})"/) ||
    code.match(/siteKey:\s*"(0x[A-Fa-f0-9]{16,})"/) ||
    code.match(/"(0x4AAAAAAA[A-Fa-f0-9]{14,})"/);
  const sitekey = skMatch ? skMatch[1] : null;

  return { j3, k3, buildId, sitekey };
}

async function updateKeys() {
  const { bundleName, code } = await downloadBundle();
  const { j3, k3, buildId, sitekey } = extractKeysFromBundle(code);
  const hmacKey = deriveHmacKey(j3, k3);

  const keys = {
    bundleName,
    j3, k3,
    hmacKeyHex: hmacKey.toString("hex"),
    buildId: buildId || "1790571883747",
    sitekey: sitekey || CFG.sitekey,
    updatedAt: new Date().toISOString(),
  };

  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
  log(`Keys updated: bundle=${bundleName}, build=${keys.buildId}`);
  if (keys.sitekey && keys.sitekey !== CFG.sitekey) log(`Sitekey=${keys.sitekey}`);

  return keys;
}

function loadKeys() {
  if (!existsSync(KEYS_FILE)) return null;
  return JSON.parse(readFileSync(KEYS_FILE, "utf-8"));
}

// ======================== 2CAPTCHA ========================

async function captchaBalance() {
  const res = await gcFetch(
    `https://2captcha.com/res.php?key=${CFG.captchaKey}&action=getbalance&json=1`,
    { timeout: 15000 }
  );
  return res.json();
}

let noCaptchaMode = false;
let browserCaptchaMode = false;

async function solveTurnstileBrowser(action, cData) {
  log(`[browser] Solve turnstile action=${action}...`);

  const { execFileSync } = await import("node:child_process");
  const solverPath = resolve(__dirname, "gc-captcha-solver.mjs");
  const args = [solverPath, action];
  if (cData) args.push(cData);

  const result = execFileSync("node", args, { timeout: 120000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  const token = result.trim();
  if (!token) throw new Error("Browser solver returned empty token");
  log(`[browser] Token solved (${token.length} chars)`);
  return token;
}

async function solveTurnstile(action, cData) {
  if (noCaptchaMode) { log(`[no-captcha] Skip turnstile action=${action}`); return ""; }
  if (browserCaptchaMode) return solveTurnstileBrowser(action, cData);
  if (manualSolver) return manualSolver.solve(action, cData);
  if (!CFG.captchaKey)
    throw new Error("CAPTCHA_API_KEY belum diset (pakai --browser-captcha atau --manual-captcha)");

  const keys = loadKeys();
  const sitekey = keys?.sitekey || CFG.sitekey;
  if (!sitekey) throw new Error("Sitekey belum diset (jalankan --update-keys dulu)");

  const params = new URLSearchParams({
    key: CFG.captchaKey, method: "turnstile", sitekey,
    pageurl: "https://gocollect.fun", action, json: "1",
    useragent: CFG.userAgent,
  });

  if (CFG.captchaProxy) {
    params.set("proxytype", CFG.captchaProxyType);
    params.set("proxy", CFG.captchaProxy);
    if (CFG.captchaProxyLogin) params.set("proxylogin", CFG.captchaProxyLogin);
    if (CFG.captchaProxyPass) params.set("proxypassword", CFG.captchaProxyPass);
  }
  if (cData) params.set("data", cData);

  log(`Solve turnstile action=${action} cData=${cData ? "yes" : "no"}...`);

  const submitRes = await gcFetch(`https://2captcha.com/in.php?${params.toString()}`, { timeout: 30000 });
  const submitData = submitRes.json();
  if (submitData?.status !== 1) throw new Error(`2captcha submit gagal: ${JSON.stringify(submitData)}`);

  const taskId = submitData.request;
  log(`Task submitted: ${taskId}`);

  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const pollRes = await gcFetch(
      `https://2captcha.com/res.php?key=${CFG.captchaKey}&action=get&id=${taskId}&json=1`,
      { timeout: 15000 }
    );
    const pollData = pollRes.json();
    if (pollData?.status === 1) { log(`Token solved (${pollData.request.length} chars)`); return pollData.request; }
    if (pollData?.request !== "CAPCHA_NOT_READY") throw new Error(`2captcha error: ${JSON.stringify(pollData)}`);
  }
  throw new Error("2captcha timeout (120s)");
}

// ======================== MANUAL CAPTCHA SOLVER ========================

let manualSolver = null;

class ManualCaptchaSolver {
  constructor() { this.port = CFG.captchaPort; this.server = null; this.tunnelUrl = null; this.pending = null; }

  async start() {
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.listen(this.port);
    log(`Captcha server di port ${this.port}`);
    await this._startTunnel();
    if (this.tunnelUrl) {
      log(`Captcha URL publik: ${this.tunnelUrl}`);
      await sendTelegram(`Bot GoCollect dimulai (manual captcha).\nNanti kamu akan dapat link captcha di sini.`);
    }
  }

  async _startTunnel() {
    return new Promise((res) => {
      try {
        const cf = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${this.port}`], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const onData = (d) => {
          const m = d.toString().match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
          if (m && !this.tunnelUrl) { this.tunnelUrl = m[1]; res(); }
        };
        cf.stdout.on("data", onData);
        cf.stderr.on("data", onData);
        cf.on("error", () => { this.tunnelUrl = null; res(); });
        setTimeout(() => { if (!this.tunnelUrl) res(); }, 20000);
      } catch { res(); }
    });
  }

  _handle(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);
    if (req.method === "GET" && url.pathname === "/solve") {
      const action = url.searchParams.get("action") || "";
      const cdata = url.searchParams.get("cdata") || "";
      const keys = loadKeys();
      const sk = keys?.sitekey || CFG.sitekey;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(this._html(sk, action, cdata));
    } else if (req.method === "POST" && url.pathname === "/submit") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { token } = JSON.parse(body);
          if (this.pending && token) { this.pending(token); this.pending = null; res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); }
          else { res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"ok":false}'); }
        } catch { res.writeHead(400); res.end("err"); }
      });
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h3>GoCollect Captcha Server aktif. Tunggu link dari Telegram.</h3>");
    }
  }

  async solve(action, cData) {
    const base = this.tunnelUrl || `http://localhost:${this.port}`;
    const solveUrl = `${base}/solve?action=${encodeURIComponent(action)}&cdata=${encodeURIComponent(cData || "")}`;
    log(`CAPTCHA DIBUTUHKAN — buka link ini:`);
    log(solveUrl);
    await sendTelegram(`Captcha dibutuhkan!\n\nAction: ${action}\nBuka link:\n${solveUrl}\n\nTimeout 5 menit.`);
    return new Promise((resolve, reject) => {
      this.pending = resolve;
      setTimeout(() => { if (this.pending) { this.pending = null; reject(new Error("Captcha timeout 5 menit")); } }, 300000);
    });
  }

  _html(sitekey, action, cdata) {
    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GoCollect Captcha</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>
body{font-family:sans-serif;text-align:center;padding:40px 16px;background:#111827;color:#e5e7eb}
h2{color:#34d399;margin-bottom:8px}
.info{color:#9ca3af;font-size:14px;margin-bottom:24px}
#w{display:flex;justify-content:center;margin:24px 0}
#st{padding:16px;border-radius:8px;margin-top:20px;font-size:15px}
.wait{background:#1f2937}.ok{background:#064e3b;color:#6ee7b7}.err{background:#7f1d1d;color:#fca5a5}
</style></head><body>
<h2>Solve Captcha</h2>
<p class="info">Action: ${action}</p>
<div id="w">
<div class="cf-turnstile" data-sitekey="${sitekey}" data-action="${action}"${cdata ? ` data-cdata="${cdata}"` : ""} data-callback="ok" data-theme="dark"></div>
</div>
<div id="st" class="wait">Selesaikan captcha di atas...</div>
<script>
function ok(t){
document.getElementById("st").className="wait";
document.getElementById("st").textContent="Mengirim...";
fetch("/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:t})})
.then(r=>r.json()).then(d=>{
var s=document.getElementById("st");
if(d.ok){s.className="ok";s.textContent="Token terkirim! Tutup halaman ini."}
else{s.className="err";s.textContent="Error, refresh halaman."}
}).catch(()=>{document.getElementById("st").className="err";document.getElementById("st").textContent="Network error"});
}
</script></body></html>`;
  }
}

// ======================== MOVEMENT SIMULATION ========================

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const EARTH_R = 6371000;

function haversine(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLng = (lng2 - lng1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLng / 2) ** 2;
  return EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1, lng1, lat2, lng2) {
  const dLng = (lng2 - lng1) * DEG_TO_RAD;
  const la1 = lat1 * DEG_TO_RAD;
  const la2 = lat2 * DEG_TO_RAD;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return Math.atan2(y, x);
}

function movePoint(lat, lng, bearingRad, distMeters) {
  const d = distMeters / EARTH_R;
  const la1 = lat * DEG_TO_RAD;
  const lo1 = lng * DEG_TO_RAD;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(bearingRad));
  const lo2 = lo1 + Math.atan2(
    Math.sin(bearingRad) * Math.sin(d) * Math.cos(la1),
    Math.cos(d) - Math.sin(la1) * Math.sin(la2)
  );
  return { lat: la2 * RAD_TO_DEG, lng: lo2 * RAD_TO_DEG };
}

function generateWalkPath(fromLat, fromLng, toLat, toLng) {
  const dist = haversine(fromLat, fromLng, toLat, toLng);
  if (dist < 5) return [{ lat: toLat, lng: toLng }];

  const walkSpeed = 1.0 + Math.random() * 0.5;
  const stepTime = 2.5 + Math.random() * 1.5;
  const stepDist = walkSpeed * stepTime;
  const numSteps = Math.max(2, Math.ceil(dist / stepDist));
  const bear = bearing(fromLat, fromLng, toLat, toLng);

  const path = [];
  for (let i = 1; i <= numSteps; i++) {
    const frac = i / numSteps;
    const intermLat = fromLat + (toLat - fromLat) * frac;
    const intermLng = fromLng + (toLng - fromLng) * frac;

    const jitterM = 1 + Math.random() * 3;
    const jitterAngle = Math.random() * 2 * Math.PI;
    const jittered = movePoint(intermLat, intermLng, jitterAngle, jitterM);

    path.push({
      lat: jittered.lat,
      lng: jittered.lng,
      accuracy: 8 + Math.random() * 7,
      delayMs: Math.round((stepTime + (Math.random() - 0.5) * 1.0) * 1000),
    });
  }

  path[path.length - 1].lat = toLat + (Math.random() - 0.5) * 0.00002;
  path[path.length - 1].lng = toLng + (Math.random() - 0.5) * 0.00002;

  return path;
}

// ======================== STATS TRACKER ========================

class StatsTracker {
  constructor() {
    this.data = { days: {}, wallets: {} };
    this._load();
  }

  _today() {
    return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
  }

  _load() {
    try {
      if (existsSync(STATS_FILE)) this.data = JSON.parse(readFileSync(STATS_FILE, "utf-8"));
    } catch {}
  }

  _save() {
    try { writeFileSync(STATS_FILE, JSON.stringify(this.data, null, 2)); } catch {}
  }

  _dayBucket() {
    const d = this._today();
    if (!this.data.days[d]) this.data.days[d] = { opened: 0, wins: [], errors: 0, bans: 0, skipped: 0, started: new Date().toISOString() };
    return this.data.days[d];
  }

  _walletBucket(addr) {
    if (!this.data.wallets[addr]) this.data.wallets[addr] = { totalOpened: 0, totalWins: 0, lastActive: null, status: "idle" };
    return this.data.wallets[addr];
  }

  recordOpen(addr, crateId, reward) {
    const day = this._dayBucket();
    const wal = this._walletBucket(addr);
    day.opened++;
    wal.totalOpened++;
    wal.lastActive = new Date().toISOString();
    if (reward) {
      const win = { wallet: addr.slice(0, 10), crateId, reward, time: new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) };
      day.wins.push(win);
      wal.totalWins++;
    }
    this._save();
  }

  recordSkip(addr) {
    this._dayBucket().skipped++;
    this._save();
  }

  recordError(addr, error) {
    this._dayBucket().errors++;
    const wal = this._walletBucket(addr);
    wal.lastError = error;
    wal.lastActive = new Date().toISOString();
    this._save();
  }

  recordBan(addr) {
    this._dayBucket().bans++;
    const wal = this._walletBucket(addr);
    wal.status = "banned";
    this._save();
  }

  setWalletStatus(addr, status) {
    this._walletBucket(addr).status = status;
    this._save();
  }

  getDailyReport() {
    const d = this._today();
    const day = this.data.days[d] || { opened: 0, wins: [], errors: 0, bans: 0, skipped: 0 };
    const winRate = day.opened > 0 ? ((day.wins.length / day.opened) * 100).toFixed(1) : "0";
    return { date: d, ...day, winCount: day.wins.length, winRate };
  }

  getWalletSummaries() {
    return Object.entries(this.data.wallets).map(([addr, w]) => ({ addr: addr.slice(0, 10) + "...", ...w }));
  }
}

const stats = new StatsTracker();

// ======================== STATE (for dashboard) ========================

function saveState(walletStates) {
  try {
    const report = stats.getDailyReport();
    const state = {
      updatedAt: new Date().toISOString(),
      daily: report,
      wallets: walletStates,
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

// ======================== SOLANA WALLET ========================

function solanaKeypairFromPrivate(pk) {
  if (typeof pk === "string") {
    if (pk.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(pk)));
    return Keypair.fromSecretKey(bs58.decode(pk));
  }
  if (Array.isArray(pk)) return Keypair.fromSecretKey(Uint8Array.from(pk));
  return Keypair.fromSecretKey(pk);
}

function solanaKeypairFromSeed(mnemonic, index = 0) {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const path = `m/44'/501'/${index}'/0'`;
  const { key } = derivePath(path, seed.toString("hex"));
  return Keypair.fromSeed(key);
}

function solanaSign(message, keypair) {
  const msgBytes = typeof message === "string" ? Buffer.from(message) : message;
  const sig = nacl.sign.detached(msgBytes, keypair.secretKey);
  return bs58.encode(sig);
}

// ======================== GOCOLLECT API CLIENT ========================

class GCClient {
  constructor(keypair, opts = {}) {
    this.keypair = keypair;
    this.address = keypair.publicKey.toBase58();
    this.lat = opts.lat || CFG.defaultLat;
    this.lng = opts.lng || CFG.defaultLng;
    this.proxyAgent = opts.proxyAgent || defaultAgent;
    this.walletIndex = opts.walletIndex || 0;
    this.dryRun = opts.dryRun || false;

    this.bearer = null;
    this.deviceId = null;
    this.hmacKey = null;
    this.buildId = null;

    const keys = loadKeys();
    if (keys) {
      this.hmacKey = Buffer.from(keys.hmacKeyHex, "hex");
      this.buildId = keys.buildId;
    }
  }

  async apiRequest(method, path, body, opts = {}) {
    if (!this.hmacKey) throw new Error("HMAC key belum ada — jalankan --update-keys");

    const ts = Date.now().toString();
    const devId = this.deviceId || "init";
    const proof = generateProof(method, path, ts, devId, this.hmacKey);

    const headers = {
      "x-gc-proof": proof,
      "x-gc-build": this.buildId,
      "Content-Type": "application/json",
    };
    if (this.deviceId) headers["x-gc-device"] = this.deviceId;
    if (this.bearer) headers["Authorization"] = `Bearer ${this.bearer}`;
    if (opts.turnstileToken) headers["x-gc-turnstile"] = opts.turnstileToken;

    const fetchOpts = { method, headers, timeout: 20000, agent: this.proxyAgent };
    if (body) fetchOpts.body = JSON.stringify(body);

    const res = await gcFetch(`${GC_API}${path}`, fetchOpts);

    const newDevId = res.headers["x-gc-device"];
    if (newDevId && !this.deviceId) { this.deviceId = newDevId; log(`Device ID: ${this.deviceId}`); }

    const minBuild = res.headers["x-gc-min-build"];
    if (minBuild && Number(minBuild) > Number(this.buildId)) {
      log(`Build updated: ${this.buildId} -> ${minBuild}`);
      this.buildId = minBuild;
    }

    return res;
  }

  async login() {
    log(`[W${this.walletIndex}] Login ${this.address.slice(0, 10)}...`);
    stats.setWalletStatus(this.address, "logging_in");

    const challengeRes = await this.apiRequest("POST", "/v1/auth/challenge", { address: this.address });
    const challenge = challengeRes.json();

    if (challengeRes.status !== 200 || !challenge?.nonce) {
      throw new Error(`Challenge gagal: ${challengeRes.status} ${challengeRes.body}`);
    }

    const nonce = challenge.nonce;
    const signature = solanaSign(nonce, this.keypair);
    const token = await solveTurnstile("signin", nonce);

    const loginRes = await this.apiRequest("POST", "/v1/auth/wallet", {
      address: this.address, signature, nonce,
    }, { turnstileToken: token });

    const loginData = loginRes.json();

    if (loginRes.status !== 200 || !loginData?.token) {
      throw new Error(`Login gagal: ${loginRes.status} ${loginRes.body}`);
    }

    this.bearer = loginData.token;
    log(`[W${this.walletIndex}] Login OK`);
    stats.setWalletStatus(this.address, "logged_in");

    return loginData;
  }

  async getCrates() {
    log(`[W${this.walletIndex}] Get crates (${this.lat.toFixed(4)}, ${this.lng.toFixed(4)})...`);

    const res = await this.apiRequest("POST", "/v1/crates", { lat: this.lat, lng: this.lng });
    const data = res.json();

    if (res.status !== 200) throw new Error(`Crates gagal: ${res.status} ${res.body}`);

    const crates = data?.crates || data || [];
    log(`[W${this.walletIndex}] ${Array.isArray(crates) ? crates.length : "?"} crates ditemukan`);
    return crates;
  }

  async sendLocationFix(lat, lng, accuracy) {
    return this.apiRequest("POST", "/v1/location/fix", {
      lat, lng,
      accuracy: accuracy || 10 + Math.random() * 5,
      timestamp: Date.now(),
    });
  }

  async walkTo(targetLat, targetLng) {
    const path = generateWalkPath(this.lat, this.lng, targetLat, targetLng);
    const dist = haversine(this.lat, this.lng, targetLat, targetLng);
    log(`[W${this.walletIndex}] Jalan ke crate (${dist.toFixed(0)}m, ${path.length} steps)...`);

    for (const step of path) {
      await this.sendLocationFix(step.lat, step.lng, step.accuracy);
      this.lat = step.lat;
      this.lng = step.lng;
      await sleep(step.delayMs || 2500);
    }

    log(`[W${this.walletIndex}] Sampai di (${this.lat.toFixed(6)}, ${this.lng.toFixed(6)})`);
  }

  async openCrate(crateId) {
    log(`[W${this.walletIndex}] Open crate ${crateId}...`);

    if (this.dryRun) {
      log(`[W${this.walletIndex}] DRY RUN — skip open`);
      return { success: true, data: { dryRun: true }, dryRun: true };
    }

    const cData = computeOpenCdata(this.bearer);
    const token = await solveTurnstile("open", cData);

    await this.sendLocationFix(this.lat, this.lng);

    const res = await this.apiRequest("POST", `/v1/crates/${crateId}/open`, {
      lat: this.lat, lng: this.lng,
    }, { turnstileToken: token });

    const data = res.json();

    if (res.status === 200) {
      log(`[W${this.walletIndex}] CRATE OPENED! ${JSON.stringify(data)}`);
      return { success: true, data };
    }
    if (res.status === 410) { log(`[W${this.walletIndex}] Crate expired`); return { success: false, reason: "expired" }; }
    if (data?.error === "try_later") { log(`[W${this.walletIndex}] try_later`); return { success: false, reason: "try_later" }; }
    if (data?.error === "stale") { logErr(`[W${this.walletIndex}] FIX BASI`); return { success: false, reason: "stale" }; }
    if (res.status === 403) { logErr(`[W${this.walletIndex}] 403: ${res.body.slice(0, 200)}`); return { success: false, reason: "forbidden" }; }
    if (res.status === 429) { log(`[W${this.walletIndex}] Rate limited`); return { success: false, reason: "rate_limit" }; }

    logErr(`[W${this.walletIndex}] Open gagal: ${res.status} ${res.body.slice(0, 200)}`);
    return { success: false, reason: "unknown" };
  }

  async farmCycle() {
    await this.login();

    await this.sendLocationFix(this.lat, this.lng);
    await sleep(1000 + Math.random() * 2000);

    const crates = await this.getCrates();

    if (!Array.isArray(crates) || crates.length === 0) {
      log(`[W${this.walletIndex}] Tidak ada crate`);
      stats.setWalletStatus(this.address, "no_crates");
      return { opened: 0, skipped: 0, wins: 0 };
    }

    let opened = 0, skipped = 0, wins = 0;
    let cratesThisSession = 0;

    for (const crate of crates) {
      const id = crate.id || crate._id || crate.crateId;
      if (!id) { skipped++; continue; }

      const crateLat = crate.lat || crate.latitude || this.lat;
      const crateLng = crate.lng || crate.longitude || this.lng;

      stats.setWalletStatus(this.address, `walking_to_crate`);
      await this.walkTo(crateLat, crateLng);

      await sleep(500 + Math.random() * 1500);

      stats.setWalletStatus(this.address, `opening_crate`);
      const result = await this.openCrate(id);

      if (result.success) {
        opened++;
        const reward = result.data?.reward || result.data?.item || result.data?.prize || null;
        const rewardStr = reward ? JSON.stringify(reward) : null;
        stats.recordOpen(this.address, id, rewardStr);

        if (rewardStr && !result.dryRun) {
          wins++;
          await sendTelegram(
            `<b>WIN!</b> Wallet ${this.address.slice(0, 10)}...\nCrate: ${id}\nReward: ${rewardStr}`
          );
        }
      } else if (result.reason === "forbidden") {
        stats.recordError(this.address, "403 forbidden");
        logErr(`[W${this.walletIndex}] 403 — stop cycle`);
        break;
      } else if (result.reason === "rate_limit") {
        log(`[W${this.walletIndex}] Rate limited — tunggu 60s`);
        await sleep(60000);
      } else {
        skipped++;
        stats.recordSkip(this.address);
      }

      cratesThisSession++;
      if (cratesThisSession >= CFG.cratesPerSession && crates.indexOf(crate) < crates.length - 1) {
        const breakMs = (CFG.breakMinMinutes + Math.random() * (CFG.breakMaxMinutes - CFG.breakMinMinutes)) * 60000;
        log(`[W${this.walletIndex}] Break ${(breakMs / 60000).toFixed(1)} menit (anti-ban pattern)...`);
        stats.setWalletStatus(this.address, "break");
        await sleep(breakMs);
        cratesThisSession = 0;
      } else {
        const delay = 3000 + Math.random() * 5000;
        await sleep(delay);
      }
    }

    stats.setWalletStatus(this.address, "idle");
    log(`[W${this.walletIndex}] Cycle done: ${opened} opened, ${skipped} skip, ${wins} wins`);
    return { opened, skipped, wins };
  }
}

// ======================== DIAGNOSE ========================

async function diagnose() {
  console.log("=== GoCollect Farm Diagnostic ===\n");

  console.log("1. Bundle GoCollect:");
  try {
    const { bundleName, code } = await downloadBundle();
    const { j3, k3, buildId, sitekey } = extractKeysFromBundle(code);
    console.log(`   Bundle: ${bundleName}`);
    console.log(`   Build ID: ${buildId}`);
    console.log(`   j3: ${j3.slice(0, 20)}...`);
    console.log(`   k3: ${k3.slice(0, 20)}...`);
    if (sitekey) console.log(`   Sitekey: ${sitekey}`);
    else console.log(`   Sitekey: TIDAK DITEMUKAN di bundle`);

    const saved = loadKeys();
    if (saved) {
      console.log(saved.j3 === j3 && saved.k3 === k3 ? "   Keys: OK (sama)" : "   Keys: BERBEDA! Jalankan --update-keys");
    } else {
      console.log("   Keys: Belum tersimpan. Jalankan --update-keys");
    }
  } catch (e) { console.log(`   ERROR: ${e.message}`); }

  console.log("\n2. Captcha:");
  if (CFG.captchaKey) {
    try {
      const bal = await captchaBalance();
      console.log(`   2captcha: $${bal?.request || "?"}`);
    } catch (e) { console.log(`   ERROR: ${e.message}`); }
  } else {
    console.log("   2captcha: TIDAK DISET (pakai --manual-captcha)");
  }

  console.log("\n3. Proxy:");
  if (proxyList.length > 0) {
    console.log(`   Proxy list: ${proxyList.length} proxy dari ${CFG.proxyListFile}`);
  } else if (CFG.proxyUrl) {
    console.log(`   Single proxy: ${CFG.proxyUrl.replace(/:[^:@]+@/, ":***@")}`);
  } else {
    console.log("   TIDAK DISET — WAJIB untuk multi-wallet");
  }

  console.log("\n4. Wallets:");
  const seedFile = process.env.SOLANA_SEED_FILE || "";
  if (seedFile && existsSync(seedFile)) {
    const count = parseInt(process.env.WALLET_COUNT || "1");
    console.log(`   Seed file: ada, ${count} wallet akan di-derive`);
  } else if (CFG.walletsFile && existsSync(CFG.walletsFile)) {
    const raw = JSON.parse(readFileSync(CFG.walletsFile, "utf-8"));
    console.log(`   Wallets file: ${raw.length} wallet`);
  } else {
    console.log("   TIDAK DITEMUKAN");
  }

  console.log("\n5. Telegram:");
  if (CFG.telegramToken && CFG.telegramChatId) {
    console.log("   Configured OK");
    try {
      await sendTelegram("Diagnostic test — bot terhubung.");
      console.log("   Test message sent");
    } catch (e) { console.log(`   Send gagal: ${e.message}`); }
  } else {
    console.log("   TIDAK DISET");
  }

  console.log("\n6. Stats:");
  const report = stats.getDailyReport();
  console.log(`   Hari ini (${report.date}): ${report.opened} opened, ${report.winCount} wins (${report.winRate}%), ${report.errors} errors`);

  console.log("\n=== Diagnostic selesai ===");
}

// ======================== MAIN ========================

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function randomDelay(minMs, maxMs) { return sleep(minMs + Math.random() * (maxMs - minMs)); }

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--diagnose")) { await diagnose(); return; }
  if (args.includes("--update-keys")) { await updateKeys(); return; }

  const isDryRun = args.includes("--dry-run");
  const isLive = args.includes("--live");
  const isLoop = args.includes("--loop");

  if (!isDryRun && !isLive) {
    console.log("Pilih mode:");
    console.log("  --dry-run   Login + getCrates + simulasi jalan, TANPA buka crate");
    console.log("  --live      Beneran buka crate");
    console.log("  --loop      Ulangi terus (gabungkan dengan --live)");
    console.log("\nContoh:");
    console.log("  node gc-farm.mjs --dry-run --wallet 0           # test 1 wallet");
    console.log("  node gc-farm.mjs --live --wallet 0              # live 1 wallet");
    console.log("  node gc-farm.mjs --live --manual-captcha        # live semua + manual captcha");
    console.log("  node gc-farm.mjs --live --loop --manual-captcha # live loop");
    return;
  }

  if (args.includes("--no-captcha")) {
    noCaptchaMode = true;
    log("Mode: NO CAPTCHA (test tanpa Turnstile)");
  } else if (args.includes("--browser-captcha")) {
    browserCaptchaMode = true;
    log("Mode: BROWSER CAPTCHA (headless Chrome)");
  } else if (args.includes("--manual-captcha")) {
    manualSolver = new ManualCaptchaSolver();
    await manualSolver.start();
    log("Mode: MANUAL CAPTCHA");
  }

  log(`=== GoCollect Farm ${isDryRun ? "DRY RUN" : "LIVE"} ===`);

  let keys = loadKeys();
  if (!keys) {
    log("Keys belum ada, download bundle...");
    keys = await updateKeys();
  }

  const seedFile = process.env.SOLANA_SEED_FILE || "";
  let keypairs = [];

  if (seedFile && existsSync(seedFile)) {
    const mnemonic = readFileSync(seedFile, "utf-8").trim();
    const walletIdx = args.indexOf("--wallet");
    if (walletIdx >= 0 && args[walletIdx + 1] !== undefined) {
      const idx = parseInt(args[walletIdx + 1]);
      keypairs = [{ kp: solanaKeypairFromSeed(mnemonic, idx), index: idx }];
      log(`Single wallet dari seed: index ${idx}`);
    } else {
      const count = parseInt(process.env.WALLET_COUNT || "1");
      const scaleIdx = args.indexOf("--scale");
      const limit = scaleIdx >= 0 ? parseInt(args[scaleIdx + 1]) : count;
      for (let i = 0; i < Math.min(limit, count); i++) {
        keypairs.push({ kp: solanaKeypairFromSeed(mnemonic, i), index: i });
      }
    }
    log(`${keypairs.length} Solana wallet(s) dari seed`);
  } else if (CFG.walletsFile && existsSync(CFG.walletsFile)) {
    const raw = JSON.parse(readFileSync(CFG.walletsFile, "utf-8"));
    const walletIdx = args.indexOf("--wallet");
    let list = raw.map((w, i) => ({ w, i }));
    if (walletIdx >= 0 && args[walletIdx + 1] !== undefined) {
      const idx = parseInt(args[walletIdx + 1]);
      if (idx >= 0 && idx < raw.length) list = [{ w: raw[idx], i: idx }];
    }
    const scaleIdx = args.indexOf("--scale");
    if (scaleIdx >= 0) list = list.slice(0, parseInt(args[scaleIdx + 1]));

    for (const { w, i } of list) {
      const pk = w.privateKey || w.private_key || w.key || w.secretKey;
      if (!pk) continue;
      try { keypairs.push({ kp: solanaKeypairFromPrivate(pk), index: i }); } catch (e) { logErr(`Skip wallet ${i}: ${e.message}`); }
    }
  } else {
    logErr("Wallet file tidak ditemukan. Set SOLANA_SEED_FILE atau WALLETS_FILE di .env");
    process.exit(1);
  }

  if (keypairs.length === 0) { logErr("Tidak ada Solana wallet"); process.exit(1); }

  log(`Farm ${keypairs.length} wallet(s)${isDryRun ? " (DRY RUN)" : ""}...`);

  if (proxyList.length > 0) {
    log(`${proxyList.length} proxy loaded — 1 per wallet`);
  } else if (keypairs.length > 1 && !CFG.proxyUrl) {
    log("PERINGATAN: Multi-wallet tanpa proxy! Sangat disarankan pakai PROXY_LIST_FILE");
  }

  do {
    let totalOpened = 0, totalWins = 0;
    const walletStates = [];

    for (let wi = 0; wi < keypairs.length; wi++) {
      const { kp, index } = keypairs[wi];
      const proxyUrl = proxyList.length > 0 ? proxyList[wi % proxyList.length] : CFG.proxyUrl;
      const agent = makeProxyAgent(proxyUrl);

      log(`--- Wallet ${wi + 1}/${keypairs.length} (index ${index}, ${kp.publicKey.toBase58().slice(0, 10)}...) ---`);
      if (proxyUrl) log(`Proxy: ${proxyUrl.replace(/:[^:@]+@/, ":***@")}`);

      try {
        const client = new GCClient(kp, {
          lat: CFG.defaultLat, lng: CFG.defaultLng,
          proxyAgent: agent,
          walletIndex: index,
          dryRun: isDryRun,
        });

        const result = await client.farmCycle();
        totalOpened += result.opened;
        totalWins += result.wins;

        walletStates.push({
          index, addr: kp.publicKey.toBase58().slice(0, 10),
          status: "done", opened: result.opened, wins: result.wins,
        });
      } catch (e) {
        logErr(`Wallet ${index}: ${e.message}`);
        stats.recordError(kp.publicKey.toBase58(), e.message);

        walletStates.push({
          index, addr: kp.publicKey.toBase58().slice(0, 10),
          status: "error", error: e.message.slice(0, 100),
        });

        if (e.message.includes("403") || e.message.includes("verification_required")) {
          try { await updateKeys(); log("Keys updated"); } catch (ue) { logErr(`Update keys gagal: ${ue.message}`); }
        }
      }

      saveState(walletStates);

      if (wi < keypairs.length - 1) {
        const delay = CFG.walletDelay + Math.random() * 10000;
        log(`Delay ${(delay / 1000).toFixed(0)}s sebelum wallet berikutnya...`);
        await sleep(delay);
      }
    }

    log(`=== Cycle done: ${totalOpened} opened, ${totalWins} wins ===`);

    const report = stats.getDailyReport();
    await sendTelegram(
      `<b>GoCollect Daily</b> (${report.date})\n` +
      `Opened: ${report.opened}\n` +
      `Wins: ${report.winCount} (${report.winRate}%)\n` +
      `Errors: ${report.errors}\n` +
      `${isDryRun ? "(DRY RUN)" : ""}`
    );

    if (isLoop) {
      const waitHrs = CFG.loopHours + (Math.random() - 0.5);
      log(`Loop mode: tunggu ${waitHrs.toFixed(1)} jam...`);
      await sleep(waitHrs * 3600000);

      try { await updateKeys(); } catch (e) { logErr(`Auto update-keys gagal: ${e.message}`); }
    }
  } while (isLoop);

  log("=== Farm selesai ===");
}

main().catch((e) => { logErr(`Fatal: ${e.message}`); process.exit(1); });
