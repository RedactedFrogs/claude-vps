# Konteks untuk Claude (HP / Cloud session)

File ini dibaca otomatis setiap sesi baru. Owner: **Hermawan** (pemula, Bahasa Indonesia). Jawab singkat. Kerjakan sendiri via SSH, jangan suruh user.

## VPS
- Host: `root@187.127.110.187` (Hostinger KVM 2)
- Login: **SSH key only** (password auth dimatikan). Key di laptop user.
- Sumber-of-truth lengkap di VPS: `/root/PROJECT_STATE.md` — baca dulu lewat SSH kalau perlu detail.

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
- Cek: `systemctl is-active awp-miner zcashd awp-dashboard`

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

## KALAU PERLU INFO LIVE
SSH ke VPS dan baca `/root/PROJECT_STATE.md` — itu sumber-of-truth terbaru.
