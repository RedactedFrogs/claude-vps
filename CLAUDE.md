# Konteks untuk Claude (HP / Cloud session)

File ini dibaca otomatis setiap sesi baru. Owner: **Hermawan** (pemula, Bahasa Indonesia). Jawab singkat. Kerjakan sendiri via SSH, jangan suruh user.

## BOOTSTRAP SSH (jalankan paling awal sebelum apapun)
```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "$VPS_SSH_KEY_B64" | base64 -d > ~/.ssh/id_ed25519
chmod 600 ~/.ssh/id_ed25519
ssh-keyscan -H 187.127.110.187 >> ~/.ssh/known_hosts 2>/dev/null
ssh -o BatchMode=yes root@187.127.110.187 "echo SSH_OK"
```
Setelah itu semua command VPS dijalankan via: `ssh root@187.127.110.187 "<command>"`

## VPS
- Host: `root@187.127.110.187` (Hostinger KVM 2)
- Login: **SSH key only**. Cloud session pakai env var `VPS_SSH_KEY_B64` (lihat bootstrap di atas).
- Sumber-of-truth lengkap: `/root/PROJECT_STATE.md` di VPS — baca via SSH untuk detail terbaru.

## DUA PROYEK (terisolasi)

### 1. AWP Mining (Agent Work Protocol)
- 250 wallet, miner custom: `/root/.awp-mining/awp_miner_v4.py` (service: `awp-miner.service`)
- Pool data: `/root/.awp-mining/article_pool_v2.jsonl` (4000 artikel, ~30 field/artikel)
- Alur: heartbeat → PoW gate → POST `/api/mining/v1/submissions`
- **BLOCKER:** endpoint PoW platform AWP (`api.minework.net`) sering down — miner auto-retry, nunggu platform pulih.
- Dashboard: `http://187.127.110.187:8080` (login `awp` / `Clover168`)

### 2. DePINZcash — Node Zcash
- `zcashd` 6.12.3 PRUNED, service: `zcashd.service`
- Datadir: `/zcash/data`, conf: `/zcash/zcash.conf`
- Isolasi dari AWP: disk di loopback `/zcash-disk.img` (mount `/zcash`), CPUQuota=100% + Nice=15
- Watchdog disk: `/usr/local/bin/zcash_disk_watchdog.sh` (cron 10 menit) auto-grow sampai 50GB
- Dashboard: `http://187.127.110.187:8080/zcash_dashboard.html`
- **STATUS:** sedang initial sync (~1-2 hari)
- **SISA KERJAAN** setelah sync 100%:
  1. Generate wallet Solana khusus $ZePIN (terpisah dari wallet AWP)
  2. Expose RPC + TLS (mode exposed-RPC; lihat `/root/dz-audit/docs/EXPOSED_RPC.md`)
  3. Register node ke DePINZcash, verifikasi proof "accepted"
- **PENTING:** jangan bikin script node-PALSU. Pruned node ini sudah solusi sah.

## SERVICES
- System: `awp-miner`, `awp-dashboard`, `awp-tunnel`, `awp-lt`, `zcashd`
- User: `openclaw-gateway` (port 18789) — `systemctl --user ...`
- Cek: `ssh root@187.127.110.187 "systemctl is-active awp-miner zcashd awp-dashboard"`

## LOGS
- AWP miner: `/var/log/awp/miner-v4.log`
- Zcash: `journalctl -u zcashd.service`
- Disk watchdog: `/var/log/awp/zcash-disk.log`
- Dashboard cron: `/var/log/awp/dashboard.log`

## ATURAN PENTING
- **Jangan ganggu AWP.** Zcash sudah terisolasi (disk + CPU).
- **OpenClaw enrichment LLM = berbayar (tembok billing)** — jangan aktifkan tanpa izin user.
- **Jangan sebut wallet count ke Discord/external** (Sybil discretion).
- Solusi harus **gratis** (user di Claude Max, tapi no extra cost untuk runtime/AI lain).
- **Jawaban singkat** — user pemula, hindari paragraf panjang & opsi teknis tanpa terjemahan.
- Untuk edit file di VPS: jangan minta user copy-paste; SSH dan edit langsung (`ssh root@... "cat > /path"` atau pakai `scp`).
