# Konteks untuk Claude (HP / Cloud session)

File ini dibaca otomatis setiap sesi baru. Owner: **Hermawan** (pemula, Bahasa Indonesia). Jawab singkat. Kerjakan sendiri via bridge VPS, jangan suruh user.

## BOOTSTRAP — WAJIB JALANKAN PERTAMA KALI
Sebelum apapun, jalankan ini di bash agar fungsi `vps` aktif:

```bash
export VPS_BRIDGE_URL="https://extraordinary-dishes-symptoms-lighter.trycloudflare.com"
# Token disuplai dari Cloud env var VPS_BRIDGE_TOKEN

vps() {
  python3 -c '
import sys, os, json, urllib.request
cmd = sys.argv[1]
req = urllib.request.Request(
    os.environ["VPS_BRIDGE_URL"] + "/exec",
    data=json.dumps({"cmd": cmd, "timeout": 180}).encode(),
    headers={"X-Token": os.environ["VPS_BRIDGE_TOKEN"], "Content-Type": "application/json"},
    method="POST",
)
try:
    resp = json.load(urllib.request.urlopen(req, timeout=200))
except Exception as e:
    print(f"BRIDGE ERROR: {e}", file=sys.stderr); sys.exit(1)
sys.stdout.write(resp.get("stdout",""))
if resp.get("stderr"): sys.stderr.write(resp["stderr"])
sys.exit(resp.get("exit", 0))
' "$*"
}
export -f vps

# verify bridge alive
vps "echo BRIDGE_OK && hostname"
```

Setelah bootstrap, **semua command VPS = `vps "<command bash>"`**. Contoh:
- `vps "systemctl is-active awp-miner zcashd"`
- `vps "tail -50 /var/log/awp/miner-v4.log"`
- `vps "zcash-cli -conf=/zcash/zcash.conf -datadir=/zcash/data getblockchaininfo"`

## VPS — INFO
- Host: `187.127.110.187` (Hostinger KVM 2). SSH port: bukan dari Cloud (firewall). Akses Cloud = via bridge HTTPS di atas.
- Sumber-of-truth lengkap: `/root/PROJECT_STATE.md` di VPS — `vps "cat /root/PROJECT_STATE.md"` untuk detail terbaru.

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

## SERVICES TAMBAHAN
- Bridge: `vps-bridge.service` (Python di :18790) + `vps-tunnel.service` (cloudflared quick tunnel)
- System AWP/Zcash: `awp-miner`, `awp-dashboard`, `awp-tunnel`, `awp-lt`, `zcashd`
- User: `openclaw-gateway` (port 18789) — `systemctl --user ...`
- Cek: `vps "systemctl is-active awp-miner zcashd awp-dashboard vps-bridge vps-tunnel"`

## LOGS
- AWP miner: `/var/log/awp/miner-v4.log`
- Zcash: `journalctl -u zcashd.service`
- Bridge: `/var/log/awp/vps-bridge.log`
- Tunnel: `/var/log/awp/vps-tunnel.log`
- Disk watchdog: `/var/log/awp/zcash-disk.log`
- Dashboard cron: `/var/log/awp/dashboard.log`

## ATURAN PENTING
- **Jangan ganggu AWP.** Zcash sudah terisolasi (disk + CPU).
- **OpenClaw enrichment LLM = berbayar (tembok billing)** — jangan aktifkan tanpa izin user.
- **Jangan sebut wallet count ke Discord/external** (Sybil discretion).
- Solusi harus **gratis** (user di Claude Max, tapi no extra cost untuk runtime/AI lain).
- **Jawaban singkat** — user pemula, hindari paragraf panjang & opsi teknis tanpa terjemahan.
- Untuk edit file di VPS: jangan minta user copy-paste; pakai `vps "cat > /path/file <<'EOF' ... EOF"` atau base64 transfer.

## KALAU BRIDGE ERROR (URL berubah)
Quick tunnel URL bisa berubah jika service restart. Kalau `vps "..."` error "Connection refused" atau 404, mungkin URL berubah. Solusi: minta user generate URL baru dari laptop, atau cek `vps_url.txt` di repo `claude-vps` (akan auto-update di v2).
