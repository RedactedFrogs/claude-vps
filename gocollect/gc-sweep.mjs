#!/usr/bin/env node
// GoCollect Sweep — kumpulkan NFT/token ke 1 wallet utama, kirim sisa SOL balik
//
// Usage:
//   node gc-sweep.mjs --check                # cek saldo semua wallet (DRY)
//   node gc-sweep.mjs --sweep-nft            # transfer semua NFT ke wallet utama
//   node gc-sweep.mjs --sweep-sol            # kirim sisa SOL ke wallet utama
//   node gc-sweep.mjs --wallet 0 --check     # cek 1 wallet saja
//
// Config: baca .env (SOLANA_SEED_FILE, WALLET_COUNT, MAIN_WALLET)

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram } from "@solana/web3.js";
import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = resolve(__dirname, ".env");
  if (!existsSync(envPath)) { console.error(".env tidak ditemukan"); process.exit(1); }
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

const RPC_URL = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const MAIN_WALLET = process.env.MAIN_WALLET || "";
const MIN_SOL_KEEP = parseFloat(process.env.MIN_SOL_KEEP || "0.002");

function solanaKeypairFromSeed(mnemonic, index = 0) {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const path = `m/44'/501'/${index}'/0'`;
  const { key } = derivePath(path, seed.toString("hex"));
  return Keypair.fromSeed(key);
}

function loadKeypairs(args) {
  const seedFile = process.env.SOLANA_SEED_FILE || "";
  if (!seedFile || !existsSync(seedFile)) { console.error("SOLANA_SEED_FILE tidak ditemukan"); process.exit(1); }

  const mnemonic = readFileSync(seedFile, "utf-8").trim();
  const count = parseInt(process.env.WALLET_COUNT || "1");
  const walletIdx = args.indexOf("--wallet");

  if (walletIdx >= 0 && args[walletIdx + 1] !== undefined) {
    const idx = parseInt(args[walletIdx + 1]);
    return [{ kp: solanaKeypairFromSeed(mnemonic, idx), index: idx }];
  }

  const pairs = [];
  for (let i = 0; i < count; i++) pairs.push({ kp: solanaKeypairFromSeed(mnemonic, i), index: i });
  return pairs;
}

async function checkBalances(conn, keypairs) {
  console.log("=== Cek Saldo ===\n");

  for (const { kp, index } of keypairs) {
    const addr = kp.publicKey.toBase58();
    try {
      const sol = await conn.getBalance(kp.publicKey);
      const tokens = await conn.getParsedTokenAccountsByOwner(kp.publicKey, {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });

      const nfts = tokens.value.filter((t) => {
        const info = t.account.data.parsed?.info;
        return info && info.tokenAmount?.uiAmount === 1 && info.tokenAmount?.decimals === 0;
      });

      const fungible = tokens.value.filter((t) => {
        const info = t.account.data.parsed?.info;
        return info && (info.tokenAmount?.decimals > 0 || info.tokenAmount?.uiAmount > 1);
      });

      console.log(`Wallet #${index}: ${addr.slice(0, 12)}...`);
      console.log(`  SOL: ${(sol / LAMPORTS_PER_SOL).toFixed(6)}`);
      console.log(`  NFTs: ${nfts.length}`);
      if (nfts.length > 0) {
        for (const n of nfts) {
          const mint = n.account.data.parsed?.info?.mint || "?";
          console.log(`    - ${mint}`);
        }
      }
      if (fungible.length > 0) {
        for (const f of fungible) {
          const info = f.account.data.parsed?.info;
          console.log(`  Token: ${info?.mint?.slice(0, 12)} = ${info?.tokenAmount?.uiAmountString || "?"}`);
        }
      }
      console.log();
    } catch (e) {
      console.log(`Wallet #${index}: ERROR ${e.message}\n`);
    }
  }
}

async function sweepSol(conn, keypairs, mainPubkey) {
  console.log(`=== Sweep SOL ke ${mainPubkey.toBase58().slice(0, 12)}... ===\n`);

  for (const { kp, index } of keypairs) {
    if (kp.publicKey.equals(mainPubkey)) { console.log(`Wallet #${index}: skip (ini wallet utama)`); continue; }

    try {
      const balance = await conn.getBalance(kp.publicKey);
      const keepLamports = Math.ceil(MIN_SOL_KEEP * LAMPORTS_PER_SOL);
      const fee = 5000;
      const sendAmount = balance - keepLamports - fee;

      if (sendAmount <= 0) {
        console.log(`Wallet #${index}: ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL (terlalu kecil, skip)`);
        continue;
      }

      console.log(`Wallet #${index}: kirim ${(sendAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL...`);

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: mainPubkey,
          lamports: sendAmount,
        })
      );

      const sig = await conn.sendTransaction(tx, [kp], { skipPreflight: false });
      console.log(`  TX: ${sig}`);

      await conn.confirmTransaction(sig, "confirmed");
      console.log(`  OK`);
    } catch (e) {
      console.log(`Wallet #${index}: ERROR ${e.message}`);
    }
  }
}

async function sweepNft(conn, keypairs, mainPubkey) {
  console.log(`=== Sweep NFT ke ${mainPubkey.toBase58().slice(0, 12)}... ===\n`);
  console.log("NOTE: Untuk transfer NFT (SPL token), install @solana/spl-token:");
  console.log("  npm install @solana/spl-token\n");

  let splToken;
  try {
    splToken = await import("@solana/spl-token");
  } catch {
    console.error("@solana/spl-token belum terinstall. Jalankan: npm install @solana/spl-token");
    process.exit(1);
  }

  for (const { kp, index } of keypairs) {
    if (kp.publicKey.equals(mainPubkey)) continue;

    try {
      const tokens = await conn.getParsedTokenAccountsByOwner(kp.publicKey, {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });

      const nfts = tokens.value.filter((t) => {
        const info = t.account.data.parsed?.info;
        return info && info.tokenAmount?.uiAmount === 1 && info.tokenAmount?.decimals === 0;
      });

      if (nfts.length === 0) { console.log(`Wallet #${index}: 0 NFT`); continue; }

      console.log(`Wallet #${index}: ${nfts.length} NFT`);

      for (const nft of nfts) {
        const mint = new PublicKey(nft.account.data.parsed.info.mint);
        console.log(`  Transfer ${mint.toBase58().slice(0, 12)}...`);

        try {
          const destAta = await splToken.getOrCreateAssociatedTokenAccount(conn, kp, mint, mainPubkey);
          const srcAta = new PublicKey(nft.pubkey);

          const sig = await splToken.transfer(conn, kp, srcAta, destAta.address, kp, 1);
          console.log(`    TX: ${sig}`);
        } catch (e) {
          console.log(`    ERROR: ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`Wallet #${index}: ERROR ${e.message}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (!args.includes("--check") && !args.includes("--sweep-nft") && !args.includes("--sweep-sol")) {
    console.log("GoCollect Sweep Tool\n");
    console.log("  --check         Cek saldo semua wallet");
    console.log("  --sweep-nft     Transfer NFT ke wallet utama (MAIN_WALLET)");
    console.log("  --sweep-sol     Transfer sisa SOL ke wallet utama");
    console.log("  --wallet N      Hanya wallet index N");
    console.log("\nSet MAIN_WALLET di .env sebelum sweep.");
    return;
  }

  const conn = new Connection(RPC_URL, "confirmed");
  const keypairs = loadKeypairs(args);

  console.log(`RPC: ${RPC_URL}`);
  console.log(`Wallets: ${keypairs.length}\n`);

  if (args.includes("--check")) {
    await checkBalances(conn, keypairs);
    return;
  }

  if (!MAIN_WALLET) { console.error("MAIN_WALLET belum diset di .env"); process.exit(1); }
  const mainPubkey = new PublicKey(MAIN_WALLET);

  if (args.includes("--sweep-nft")) await sweepNft(conn, keypairs, mainPubkey);
  if (args.includes("--sweep-sol")) await sweepSol(conn, keypairs, mainPubkey);

  console.log("\n=== Sweep selesai ===");
}

main().catch((e) => { console.error(`Fatal: ${e.message}`); process.exit(1); });
