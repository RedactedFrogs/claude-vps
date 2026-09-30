#!/usr/bin/env node
// Test GoCollect API auth paths — find which ones work without Turnstile
// Usage: node gc-test-auth.mjs

import { createHmac, createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GC = "https://gocollect.fun";
const KEYS_FILE = resolve(__dirname, "gc-keys.json");

function loadKeys() {
  if (!existsSync(KEYS_FILE)) { console.log("ERROR: gc-keys.json not found. Run gc-farm.mjs --update-keys first"); process.exit(1); }
  return JSON.parse(readFileSync(KEYS_FILE, "utf-8"));
}

function base64urlNoPad(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeProof(method, path, deviceId, hmacKey, ts = Date.now()) {
  const msg = `${method.toUpperCase()} ${path.split("?")[0]} ${ts} ${deviceId}`;
  const sig = createHmac("sha256", hmacKey).update(msg).digest();
  return `${ts}.${base64urlNoPad(sig)}`;
}

function loadWallet() {
  const seedFile = process.env.SOLANA_SEED_FILE || resolve(__dirname, "../.phantom_seed");
  if (!existsSync(seedFile)) { console.log("ERROR: Seed file not found at", seedFile); process.exit(1); }
  const mnemonic = readFileSync(seedFile, "utf-8").trim().split("\n")[0].trim();
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const derived = derivePath("m/44'/501'/0'/0'", seed.toString("hex"));
  return Keypair.fromSeed(derived.key);
}

function httpReq(method, path, body, extraHeaders = {}) {
  return new Promise((res, rej) => {
    const url = new URL(GC + path);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.127 Safari/537.36",
        "accept": "application/json",
        ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
        ...extraHeaders,
      },
    };
    const req = https.request(opts, (resp) => {
      let chunks = [];
      resp.on("data", c => chunks.push(c));
      resp.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(raw); } catch { json = { _raw: raw.slice(0, 500) }; }
        res({ status: resp.statusCode, headers: Object.fromEntries(Object.entries(resp.headers)), json });
      });
    });
    req.on("error", rej);
    req.setTimeout(15000, () => { req.destroy(); rej(new Error("timeout")); });
    if (data) req.write(data);
    req.end();
  });
}

async function apiCall(method, path, body, extra = {}) {
  const keys = loadKeys();
  const hmacKey = Buffer.from(keys.hmacKeyHex, "hex");
  const deviceId = "test-device-" + randomBytes(4).toString("hex");
  const proof = makeProof(method, path, deviceId, hmacKey);

  return httpReq(method, path, body, {
    "x-gc-proof": proof,
    "x-gc-build": keys.buildId || "1790793908321",
    "x-gc-device": deviceId,
    ...extra,
  });
}

async function main() {
  const wallet = loadWallet();
  const address = wallet.publicKey.toBase58();
  console.log(`Wallet: ${address.slice(0, 8)}...${address.slice(-4)}`);

  console.log("\n=== TEST 1: /v1/auth/dev (dev login) ===");
  try {
    const r = await apiCall("POST", "/v1/auth/dev", { address });
    console.log(`Status: ${r.status}`);
    console.log("Response:", JSON.stringify(r.json).slice(0, 300));
  } catch (e) { console.log("Error:", e.message); }

  console.log("\n=== TEST 2: /v1/auth/challenge (get nonce) ===");
  let nonce;
  try {
    const r = await apiCall("POST", "/v1/auth/challenge", { address });
    console.log(`Status: ${r.status}`);
    console.log("Response:", JSON.stringify(r.json).slice(0, 300));
    nonce = r.json?.nonce;
    if (nonce) console.log("Nonce:", nonce);
  } catch (e) { console.log("Error:", e.message); }

  if (!nonce) { console.log("\nCan't continue without nonce"); return; }

  const domain = "gocollect.fun";
  const origin = "https://gocollect.fun";
  const statement = "Sign in to GoCollect";
  const issuedAt = new Date().toISOString();
  const siwsMsg = `${domain} wants you to sign a message:\n${address}\n\n${statement}\n\nURI: ${origin}\nVersion: 1\nChain ID: mainnet\nNonce: ${nonce}\nIssued At: ${issuedAt}`;

  const msgBytes = new TextEncoder().encode(siwsMsg);
  const signature = nacl.sign.detached(msgBytes, wallet.secretKey);
  const sigB58 = bs58.encode(signature);

  const loginBody = {
    message: siwsMsg,
    signature: sigB58,
    address,
    nonce,
  };

  console.log("\n=== TEST 3: /v1/auth/wallet WITHOUT Turnstile ===");
  try {
    const r = await apiCall("POST", "/v1/auth/wallet", loginBody);
    console.log(`Status: ${r.status}`);
    console.log("Response:", JSON.stringify(r.json).slice(0, 300));
  } catch (e) { console.log("Error:", e.message); }

  console.log("\n=== TEST 4: /v1/auth/wallet with turnstile-error: unsupported ===");
  try {
    const cr = await apiCall("POST", "/v1/auth/challenge", { address });
    const nonce2 = cr.json?.nonce;
    if (!nonce2) { console.log("No nonce"); return; }

    const issuedAt2 = new Date().toISOString();
    const siwsMsg2 = `${domain} wants you to sign a message:\n${address}\n\n${statement}\n\nURI: ${origin}\nVersion: 1\nChain ID: mainnet\nNonce: ${nonce2}\nIssued At: ${issuedAt2}`;
    const msgBytes2 = new TextEncoder().encode(siwsMsg2);
    const sig2 = nacl.sign.detached(msgBytes2, wallet.secretKey);

    const r = await apiCall("POST", "/v1/auth/wallet", {
      message: siwsMsg2,
      signature: bs58.encode(sig2),
      address,
      nonce: nonce2,
    }, { "x-gc-turnstile-error": "unsupported" });
    console.log(`Status: ${r.status}`);
    console.log("Response:", JSON.stringify(r.json).slice(0, 300));
  } catch (e) { console.log("Error:", e.message); }

  console.log("\n=== TEST 5: /v1/auth/wallet with turnstile-error: off ===");
  try {
    const cr = await apiCall("POST", "/v1/auth/challenge", { address });
    const nonce3 = cr.json?.nonce;
    if (!nonce3) { console.log("No nonce"); return; }

    const issuedAt3 = new Date().toISOString();
    const siwsMsg3 = `${domain} wants you to sign a message:\n${address}\n\n${statement}\n\nURI: ${origin}\nVersion: 1\nChain ID: mainnet\nNonce: ${nonce3}\nIssued At: ${issuedAt3}`;
    const msgBytes3 = new TextEncoder().encode(siwsMsg3);
    const sig3 = nacl.sign.detached(msgBytes3, wallet.secretKey);

    const r = await apiCall("POST", "/v1/auth/wallet", {
      message: siwsMsg3,
      signature: bs58.encode(sig3),
      address,
      nonce: nonce3,
    }, { "x-gc-turnstile-error": "off" });
    console.log(`Status: ${r.status}`);
    console.log("Response:", JSON.stringify(r.json).slice(0, 300));
  } catch (e) { console.log("Error:", e.message); }

  console.log("\n=== DONE ===");
  console.log("If any test returned a token/session, Turnstile bypass is possible!");
  console.log("If all returned verification_required, we need another approach.");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
