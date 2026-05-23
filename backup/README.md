# Backup encrypted

## depinzcash-solana-keypair.json.enc

Backup terenkripsi dari Solana wallet $ZePIN (DePINZcash).

- **Wallet address:** `2GuNXuUaFppEjmyRVxQANBWtrfeTXuZgotgSawhqFJox`
- **Sumber:** `/root/.depinzcash/solana-keypair.json` di VPS
- **Cipher:** AES-256-CBC, PBKDF2 100,000 iterasi, salted
- **Passphrase:** disimpan offline oleh user — TIDAK ada di repo ini

## Decrypt (jika VPS hilang)

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  -in depinzcash-solana-keypair.json.enc \
  -out solana-keypair.json \
  -pass pass:'<PASSPHRASE>'
```

Hasil decrypt = JSON dengan field `wallet`, `secret_seed`, `solana_keypair_v1` (64-byte Solana format).
