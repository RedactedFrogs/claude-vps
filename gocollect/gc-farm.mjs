#!/usr/bin/env node
// GoCollect Farm — implementasi lengkap dari Troubleshooting Guide 28 Sep 2026
// Semua fix: HMAC key rotation, cData bake, 2captcha passthrough, pre-mint, dsb.
//
// Usage:
//   node gc-farm.mjs --diagnose        # cek saldo 2captcha, bundle, koneksi
//   node gc-farm.mjs --update-keys     # download bundle baru, extract HMAC keys
//   node gc-farm.mjs                   # jalankan farm
//   node gc-farm.mjs --wallet 0        # farm hanya wallet index 0
//
// Config: buat file .env di folder ini (lihat .env.example)

import { createHmac, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import http from "node:http";
import { Wallet } from "ethers";
import { SocksProxyAgent } from "socks-proxy-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ======================== CONFIG ========================

function loadEnv() {
  const envPath = resolve(__dirname, ".env");
  if (!existsSync(envPath)) {
    console.error("ERROR: .env tidak ditemukan. Copy .env.example -> .env dan isi config.");
    process.exit(1);
  }
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
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
  captchaProxy: process.env.CAPTCHA_PROXY || "",
  captchaProxyLogin: process.env.CAPTCHA_PROXY_LOGIN || "",
  captchaProxyPass: process.env.CAPTCHA_PROXY_PASS || "",
  captchaProxyType: process.env.CAPTCHA_PROXY_TYPE || "socks5",
  walletsFile: process.env.WALLETS_FILE || "",
  defaultLat: parseFloat(process.env.DEFAULT_LAT || "-6.2088"),
  defaultLng: parseFloat(process.env.DEFAULT_LNG || "106.8456"),
  userAgent: process.env.USER_AGENT || "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  maxLogSize: parseInt(process.env.MAX_LOG_SIZE || "10485760"),
  walletDelay: parseInt(process.env.WALLET_DELAY || "5000"),
};

const GC_BASE = "https://gocollect.fun";
const GC_API = "https://gocollect.fun";
const KEYS_FILE = resolve(__dirname, "gc-keys.json");
const LOG_FILE = resolve(__dirname, "gc-farm.log");

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

function logErr(msg) {
  log("ERROR: " + msg);
}

// ======================== HTTP HELPER ========================

function makeAgent() {
  if (!CFG.proxyUrl) return undefined;
  if (CFG.proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(CFG.proxyUrl);
  }
  return undefined;
}

const proxyAgent = makeAgent();

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
        "Accept": "application/json",
        ...(opts.headers || {}),
      },
      agent: proxyAgent,
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

// ======================== HMAC & CRYPTO (§1 dari guide) ========================

function xorBuffers(a, b) {
  const len = Math.max(a.length, b.length);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    out[i] = (a[i] || 0) ^ (b[i] || 0);
  }
  return out;
}

function deriveHmacKey(j3, k3) {
  const a = Buffer.from(j3, "base64");
  const b = Buffer.from(k3, "base64");
  return xorBuffers(a, b);
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
  return createHash("sha256")
    .update("gc-cdata|" + bearerToken)
    .digest("hex")
    .slice(0, 32);
}

// ======================== BUNDLE KEY EXTRACTION (§1) ========================

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
  const keyMatch = code.match(/const\s+j3="([^"]+)",\s*k3="([^"]+)"/);
  if (!keyMatch) throw new Error('Pattern j3/k3 tidak ditemukan di bundle');

  const j3 = keyMatch[1];
  const k3 = keyMatch[2];

  const buildMatch = code.match(/x2\s*=\s*"(\d+)"/);
  const buildId = buildMatch ? buildMatch[1] : null;

  const skMatch = code.match(/sitekey:\s*"(0x[A-Fa-f0-9]+)"/);
  const sitekey = skMatch ? skMatch[1] : null;

  return { j3, k3, buildId, sitekey };
}

async function updateKeys() {
  const { bundleName, code } = await downloadBundle();
  const { j3, k3, buildId, sitekey } = extractKeysFromBundle(code);
  const hmacKey = deriveHmacKey(j3, k3);

  const keys = {
    bundleName,
    j3,
    k3,
    hmacKeyHex: hmacKey.toString("hex"),
    buildId: buildId || "1790571883747",
    sitekey: sitekey || CFG.sitekey,
    updatedAt: new Date().toISOString(),
  };

  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
  log(`Keys updated: bundle=${bundleName}, build=${keys.buildId}`);
  log(`j3=${j3}`);
  log(`k3=${k3}`);
  log(`HMAC key (hex)=${keys.hmacKeyHex}`);
  if (keys.sitekey) log(`Sitekey=${keys.sitekey}`);

  return keys;
}

function loadKeys() {
  if (!existsSync(KEYS_FILE)) return null;
  return JSON.parse(readFileSync(KEYS_FILE, "utf-8"));
}

// ======================== 2CAPTCHA (§2, §7) ========================

async function captchaBalance() {
  const res = await gcFetch(
    `https://2captcha.com/res.php?key=${CFG.captchaKey}&action=getbalance&json=1`,
    { timeout: 15000 }
  );
  return res.json();
}

async function solveTurnstile(action, cData) {
  if (!CFG.captchaKey) throw new Error("CAPTCHA_API_KEY belum diset");

  const keys = loadKeys();
  const sitekey = keys?.sitekey || CFG.sitekey;
  if (!sitekey) throw new Error("Sitekey belum diset (jalankan --update-keys dulu)");

  const params = new URLSearchParams({
    key: CFG.captchaKey,
    method: "turnstile",
    sitekey,
    pageurl: "https://gocollect.fun",
    action,
    json: "1",
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

  const submitRes = await gcFetch(
    `https://2captcha.com/in.php?${params.toString()}`,
    { timeout: 30000 }
  );
  const submitData = submitRes.json();
  if (submitData?.status !== 1) {
    throw new Error(`2captcha submit gagal: ${JSON.stringify(submitData)}`);
  }

  const taskId = submitData.request;
  log(`Task submitted: ${taskId}`);

  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const pollRes = await gcFetch(
      `https://2captcha.com/res.php?key=${CFG.captchaKey}&action=get&id=${taskId}&json=1`,
      { timeout: 15000 }
    );
    const pollData = pollRes.json();

    if (pollData?.status === 1) {
      log(`Token solved (${pollData.request.length} chars)`);
      return pollData.request;
    }
    if (pollData?.request !== "CAPCHA_NOT_READY") {
      throw new Error(`2captcha error: ${JSON.stringify(pollData)}`);
    }
  }

  throw new Error("2captcha timeout (120s)");
}

// ======================== GOCOLLECT API CLIENT ========================

class GCClient {
  constructor(walletKey, opts = {}) {
    this.wallet = new Wallet(walletKey);
    this.address = this.wallet.address;
    this.lat = opts.lat || CFG.defaultLat;
    this.lng = opts.lng || CFG.defaultLng;

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

    const url = `${GC_API}${path}`;
    const fetchOpts = { method, headers, timeout: 20000 };
    if (body) fetchOpts.body = JSON.stringify(body);

    const res = await gcFetch(url, fetchOpts);

    const newDevId = res.headers["x-gc-device"];
    if (newDevId && !this.deviceId) {
      this.deviceId = newDevId;
      log(`Device ID: ${this.deviceId}`);
    }

    const minBuild = res.headers["x-gc-min-build"];
    if (minBuild && Number(minBuild) > Number(this.buildId)) {
      log(`Build updated: ${this.buildId} -> ${minBuild}`);
      this.buildId = minBuild;
    }

    return res;
  }

  async login() {
    log(`Login wallet ${this.address.slice(0, 10)}...`);

    const challengeRes = await this.apiRequest("POST", "/v1/auth/challenge", {
      address: this.address,
    });
    const challenge = challengeRes.json();

    if (challengeRes.status !== 200 || !challenge?.nonce) {
      throw new Error(`Challenge gagal: ${challengeRes.status} ${challengeRes.body}`);
    }

    const nonce = challenge.nonce;
    log(`Nonce: ${nonce}`);

    const signature = await this.wallet.signMessage(nonce);
    const token = await solveTurnstile("signin", nonce);

    const loginRes = await this.apiRequest("POST", "/v1/auth/wallet", {
      address: this.address,
      signature,
      nonce,
    }, { turnstileToken: token });

    const loginData = loginRes.json();

    if (loginRes.status !== 200 || !loginData?.token) {
      throw new Error(`Login gagal: ${loginRes.status} ${loginRes.body}`);
    }

    this.bearer = loginData.token;
    log(`Login OK, bearer ${this.bearer.slice(0, 20)}...`);

    return loginData;
  }

  async getCrates() {
    log(`Get crates di (${this.lat}, ${this.lng})...`);

    const res = await this.apiRequest("POST", "/v1/crates", {
      lat: this.lat,
      lng: this.lng,
    });

    const data = res.json();

    if (res.status !== 200) {
      throw new Error(`Crates gagal: ${res.status} ${res.body}`);
    }

    const crates = data?.crates || data || [];
    log(`${Array.isArray(crates) ? crates.length : "?"} crates ditemukan`);
    return crates;
  }

  async freshFix() {
    const res = await this.apiRequest("POST", "/v1/location/fix", {
      lat: this.lat,
      lng: this.lng,
      accuracy: 10 + Math.random() * 5,
      timestamp: Date.now(),
    });

    if (res.status !== 200) {
      log(`Fix response: ${res.status} ${res.body.slice(0, 200)}`);
    }

    return res;
  }

  async openCrate(crateId) {
    log(`Open crate ${crateId}...`);

    const cData = computeOpenCdata(this.bearer);

    log("Pre-mint turnstile token untuk open...");
    const token = await solveTurnstile("open", cData);

    log("Kirim fresh fix...");
    await this.freshFix();

    const res = await this.apiRequest("POST", `/v1/crates/${crateId}/open`, {
      lat: this.lat,
      lng: this.lng,
    }, { turnstileToken: token });

    const data = res.json();

    if (res.status === 200) {
      log(`CRATE OPENED! ${JSON.stringify(data)}`);
      return { success: true, data };
    }

    if (res.status === 410) {
      log(`Crate expired (diambil orang lain)`);
      return { success: false, reason: "expired" };
    }

    if (data?.error === "try_later") {
      log(`try_later — crate sedang rotate (15 menit)`);
      return { success: false, reason: "try_later" };
    }

    if (data?.error === "stale") {
      logErr(`FIX BASI — token solve terlalu lama? Cek urutan pre-mint`);
      return { success: false, reason: "stale" };
    }

    if (res.status === 403) {
      logErr(`403: ${res.body.slice(0, 300)}`);
      logErr("Cek: HMAC key, cData, build ID, device ID (lihat guide §1-§4)");
      return { success: false, reason: "forbidden" };
    }

    logErr(`Open gagal: ${res.status} ${res.body.slice(0, 300)}`);
    return { success: false, reason: "unknown" };
  }

  async farmCycle() {
    await this.login();
    const crates = await this.getCrates();

    if (!Array.isArray(crates) || crates.length === 0) {
      log("Tidak ada crate tersedia");
      return { opened: 0, skipped: 0 };
    }

    let opened = 0;
    let skipped = 0;

    for (const crate of crates) {
      const id = crate.id || crate._id || crate.crateId;
      if (!id) {
        skipped++;
        continue;
      }

      const result = await this.openCrate(id);

      if (result.success) {
        opened++;
      } else if (result.reason === "try_later") {
        skipped++;
        continue;
      } else if (result.reason === "expired") {
        skipped++;
        continue;
      } else if (result.reason === "forbidden") {
        logErr("403 — kemungkinan kunci HMAC basi, stop cycle");
        break;
      }

      await sleep(2000 + Math.random() * 3000);
    }

    log(`Cycle selesai: ${opened} opened, ${skipped} skipped`);
    return { opened, skipped };
  }
}

// ======================== DIAGNOSE (§7, §8) ========================

async function diagnose() {
  console.log("=== GoCollect Farm Diagnostic ===\n");

  console.log("1. Saldo 2captcha:");
  try {
    const bal = await captchaBalance();
    if (bal?.request === "ERROR_ZERO_BALANCE" || parseFloat(bal?.request) <= 0) {
      console.log(`   GAGAL: Saldo habis (${bal?.request}). Topup dulu!`);
    } else {
      console.log(`   OK: $${bal?.request}`);
    }
  } catch (e) {
    console.log(`   ERROR: ${e.message}`);
  }

  console.log("\n2. Bundle GoCollect:");
  try {
    const { bundleName, code } = await downloadBundle();
    const { j3, k3, buildId, sitekey } = extractKeysFromBundle(code);
    console.log(`   Bundle: ${bundleName}`);
    console.log(`   Build ID (x2): ${buildId}`);
    console.log(`   j3: ${j3.slice(0, 20)}...`);
    console.log(`   k3: ${k3.slice(0, 20)}...`);
    if (sitekey) console.log(`   Sitekey: ${sitekey}`);

    const saved = loadKeys();
    if (saved) {
      if (saved.j3 === j3 && saved.k3 === k3) {
        console.log("   Keys: SAMA dengan yang tersimpan (OK)");
      } else {
        console.log("   Keys: BERBEDA! Jalankan --update-keys untuk update");
      }
    } else {
      console.log("   Keys: Belum tersimpan. Jalankan --update-keys");
    }
  } catch (e) {
    console.log(`   ERROR: ${e.message}`);
  }

  console.log("\n3. Proxy:");
  if (CFG.proxyUrl) {
    console.log(`   Configured: ${CFG.proxyUrl}`);
    try {
      const res = await gcFetch("https://httpbin.org/ip", { timeout: 10000 });
      const data = res.json();
      console.log(`   IP terdeteksi: ${data?.origin || "unknown"}`);
    } catch (e) {
      console.log(`   ERROR: ${e.message}`);
    }
  } else {
    console.log("   TIDAK DISET — disarankan pakai proxy");
  }

  console.log("\n4. Wallets:");
  if (CFG.walletsFile && existsSync(CFG.walletsFile)) {
    try {
      const wallets = JSON.parse(readFileSync(CFG.walletsFile, "utf-8"));
      console.log(`   File: ${CFG.walletsFile}`);
      console.log(`   Jumlah: ${wallets.length} wallet`);
    } catch (e) {
      console.log(`   ERROR parse: ${e.message}`);
    }
  } else {
    console.log(`   File tidak ditemukan: ${CFG.walletsFile || "(belum diset)"}`);
  }

  console.log("\n5. Config:");
  console.log(`   User-Agent: ${CFG.userAgent.slice(0, 60)}...`);
  console.log(`   GPS: ${CFG.defaultLat}, ${CFG.defaultLng}`);
  console.log(`   Captcha proxy: ${CFG.captchaProxy || "TIDAK DISET"}`);
  console.log(`   Max log size: ${(CFG.maxLogSize / 1024 / 1024).toFixed(1)} MB`);

  console.log("\n=== Diagnostic selesai ===");
}

// ======================== MAIN ========================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--diagnose")) {
    await diagnose();
    return;
  }

  if (args.includes("--update-keys")) {
    await updateKeys();
    return;
  }

  log("=== GoCollect Farm Start ===");

  let keys = loadKeys();
  if (!keys) {
    log("Keys belum ada, download dari bundle...");
    keys = await updateKeys();
  }

  if (!CFG.walletsFile || !existsSync(CFG.walletsFile)) {
    logErr(`Wallet file tidak ditemukan: ${CFG.walletsFile}`);
    process.exit(1);
  }

  const allWallets = JSON.parse(readFileSync(CFG.walletsFile, "utf-8"));

  const walletIdx = args.indexOf("--wallet");
  let wallets = allWallets;
  if (walletIdx >= 0 && args[walletIdx + 1] !== undefined) {
    const idx = parseInt(args[walletIdx + 1]);
    if (idx >= 0 && idx < allWallets.length) {
      wallets = [allWallets[idx]];
      log(`Mode single wallet: index ${idx}`);
    }
  }

  log(`Farm ${wallets.length} wallet(s)...`);

  let totalOpened = 0;

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const pk = w.privateKey || w.private_key || w.key;
    if (!pk) {
      logErr(`Wallet ${i}: tidak ada private key, skip`);
      continue;
    }

    log(`--- Wallet ${i + 1}/${wallets.length} ---`);

    try {
      const client = new GCClient(pk, {
        lat: w.lat || CFG.defaultLat,
        lng: w.lng || CFG.defaultLng,
      });

      const result = await client.farmCycle();
      totalOpened += result.opened;
    } catch (e) {
      logErr(`Wallet ${i}: ${e.message}`);

      if (e.message.includes("403") || e.message.includes("verification_required")) {
        log("Kemungkinan kunci basi, coba update...");
        try {
          await updateKeys();
          log("Keys updated, lanjut wallet berikut");
        } catch (ue) {
          logErr(`Update keys gagal: ${ue.message}`);
        }
      }
    }

    if (i < wallets.length - 1) {
      log(`Delay ${CFG.walletDelay / 1000}s sebelum wallet berikut...`);
      await sleep(CFG.walletDelay);
    }
  }

  log(`=== Farm selesai: ${totalOpened} total crate opened ===`);
}

main().catch((e) => {
  logErr(`Fatal: ${e.message}`);
  process.exit(1);
});
