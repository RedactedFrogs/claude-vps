# Backup encrypted

## Files

### `depinzcash-solana-keypair.json.enc` (1.0 KB)
Wallet utama $ZePIN (DePINZcash):
- **Wallet address:** `2GuNXuUaFppEjmyRVxQANBWtrfeTXuZgotgSawhqFJox`
- **Sumber:** `/root/.depinzcash/solana-keypair.json` di VPS

### `depinzcash-250-wallets.tar.gz.enc` (72 KB)
Bulk 250 Solana keypairs untuk farming relay mode:
- **Wallet 1:** `4TH9TmhBRMhrp4JXoeoVE9Bx3shc7wdDdPdg9tCApg9J`
- **Wallet 250:** `CBdsL4wHwePsew96Vh5TJFWbapKJCwWt79c61GHMs1fP`
- **Sumber:** `/root/.depinzcash-multi/wallets/wallet-001-raw.json` ... `wallet-250-raw.json`

## Cipher (semua file)

- AES-256-CBC, PBKDF2 100,000 iterasi, salted
- **Passphrase:** disimpan offline oleh user — TIDAK ada di repo ini

## Decrypt

### Single keypair
```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  -in depinzcash-solana-keypair.json.enc \
  -out solana-keypair.json \
  -pass pass:'<PASSPHRASE>'
```

### 250 wallets bulk
```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  -in depinzcash-250-wallets.tar.gz.enc \
  -pass pass:'<PASSPHRASE>' | tar -xz
# Output: wallets/wallet-001.json ... wallet-250-raw.json
```
