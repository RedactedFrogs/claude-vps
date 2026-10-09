#!/usr/bin/env python3
"""Derive Solana public address from a BIP39 mnemonic file.
Uses only stdlib + cryptography (no solana/nacl packages needed).
Output: just the base58 public address, nothing else.
"""
import sys, hashlib, hmac, struct
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

def mnemonic_to_seed(mnemonic, passphrase=""):
    return hashlib.pbkdf2_hmac(
        "sha512", mnemonic.encode(), ("mnemonic" + passphrase).encode(), 2048
    )

def slip10_master(seed):
    I = hmac.new(b"ed25519 seed", seed, hashlib.sha512).digest()
    return I[:32], I[32:]

def slip10_child(key, chain_code, index):
    data = b'\x00' + key + struct.pack('>I', index | 0x80000000)
    I = hmac.new(chain_code, data, hashlib.sha512).digest()
    return I[:32], I[32:]

def base58_encode(data):
    alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    n = int.from_bytes(data, 'big')
    result = ''
    while n > 0:
        n, remainder = divmod(n, 58)
        result = alphabet[remainder] + result
    for byte in data:
        if byte == 0:
            result = '1' + result
        else:
            break
    return result

def derive(mnemonic):
    seed = mnemonic_to_seed(mnemonic.strip())
    key, cc = slip10_master(seed)
    for idx in [44, 501, 0, 0]:
        key, cc = slip10_child(key, cc, idx)
    priv = Ed25519PrivateKey.from_private_bytes(key)
    pub_bytes = priv.public_key().public_bytes_raw()
    return base58_encode(pub_bytes)

if __name__ == "__main__":
    seed_file = sys.argv[1] if len(sys.argv) > 1 else "/home/boss/.phantom_seed"
    with open(seed_file) as f:
        mnemonic = f.read().strip()
    addr = derive(mnemonic)
    print(addr)
    with open("/home/boss/.sol_address", "w") as f:
        f.write(addr + "\n")
