#!/usr/bin/env python3
"""Derive Solana addresses from a BIP39 mnemonic for simagents mining.
Usage: python derive_wallets.py <seed_file> [count] [output_file]
"""
import json, os, sys

if len(sys.argv) < 2:
    print(f"Usage: {sys.argv[0]} <seed_file> [count] [output_file]")
    sys.exit(1)

seed_file = sys.argv[1]
count = int(sys.argv[2]) if len(sys.argv) > 2 else 100
out_file = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "mining_wallets.json")

if os.path.exists(out_file):
    data = json.load(open(out_file))
    print(f"Already have {len(data)} wallets in {out_file}")
    sys.exit(0)

phrase = open(seed_file).read().strip()
print(f"Loaded {len(phrase.split())} word mnemonic")

from bip_utils import Bip39SeedGenerator, Bip44, Bip44Coins, Bip44Changes

seed = Bip39SeedGenerator(phrase).Generate()
wallets = []
for i in range(count):
    ctx = Bip44.FromSeed(seed, Bip44Coins.SOLANA)
    acc = ctx.Purpose().Coin().Account(i).Change(Bip44Changes.CHAIN_EXT)
    pub = acc.PublicKey().ToAddress()
    wallets.append({"idx": i, "pubkey": pub})

with open(out_file, "w") as f:
    json.dump(wallets, f, indent=1)
os.chmod(out_file, 0o600)

print(f"Derived {count} Solana wallets -> {out_file}")
for w in wallets[:3]:
    print(f"  [{w['idx']}] {w['pubkey']}")
print("  ...")
print(f"  [{wallets[-1]['idx']}] {wallets[-1]['pubkey']}")
