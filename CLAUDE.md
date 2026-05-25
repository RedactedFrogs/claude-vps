# Konteks untuk Claude (HP / Cloud session)

File ini dibaca otomatis setiap sesi baru. Owner: **Hermawan** (pemula, Bahasa Indonesia). Jawab singkat. Kerjakan sendiri via bridge VPS, jangan suruh user.

## BOOTSTRAP — WAJIB JALANKAN PERTAMA KALI
Sebelum apapun, jalankan ini di bash agar fungsi `vps` aktif. URL bridge dibaca dari `bridge_url.txt` di repo (VPS auto-publish saat URL rotate, jadi selalu fresh — `git pull` dulu agar dapat versi terbaru):

```bash
git pull --quiet 2>/dev/null || true
export VPS_BRIDGE_URL=$(cat bridge_url.txt | tr -d '[:space:]')
echo "Bridge URL = $VPS_BRIDGE_URL"
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

# DePINZcash registration watcher — flip dari 403 = kill-switch backend buka
vps "test -f /root/depinz/state/REGISTRATION_REOPENED && cat /root/depinz/state/REGISTRATION_REOPENED || echo 'depinz_registration_status=still_locked'"
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
- `zcashd` 6.12.3 PRUNED, service: `zcashd.service` — sync 99.9999% ✓ (IBD complete)
- Datadir: `/zcash/data`, conf: `/zcash/zcash.conf`
- Isolasi dari AWP: disk di loopback `/zcash-disk.img` (mount `/zcash`), CPUQuota=100% + Nice=15
- Watchdog disk: `/usr/local/bin/zcash_disk_watchdog.sh` (cron 10 menit) auto-grow sampai 50GB
- Dashboard: `http://187.127.110.187:8080/zcash_dashboard.html`
- **BLOCKER REGISTRATION (2026-05-25)**: `https://api.zcashdepin.com/api/nodes/register` → 403 forbidden konsisten. Bukti commit dz-audit upstream (`875bab2 remove wallet button + register nav`, `9fb9a9b add PROOF_SUBMISSION_ENABLED kill-switch incident mode`, `1957a39 replace browser registration form with CLI instructions`) — server di-set `REGISTRATION_ENABLED=false`. Tidak bisa register sampai mereka buka. Bukan masalah Sybil/proxy/throttle.
- **PIPELINE SIAP (idle, auto-trigger via watcher):**
  - `/root/depinz/wallets/` — 250 Solana ed25519 keypair (mapped 1:1 ke `/root/.awp-mining/proxies.txt`), siap register
  - `/root/depinz/watcher.py` — cron `17 * * * *`, probe /api/nodes/register, deteksi flip 403 → tulis sentinel `/root/depinz/state/REGISTRATION_REOPENED`
  - `/root/depinz/register_batch.py` — throttled register (5-10/jam, cap 100/hari = 3 hari rollout). Auto-abort kalau sentinel absent atau lihat 403 mid-loop. Default DRY-RUN, butuh `--execute` flag.
  - `/root/depinz/submit_proof_one.py` — single-shot proof submit (untuk smoke test 1 wallet sebelum scale up daemon)
  - Cadangan repo: `/home/user/claude-vps/depinz/` (mirror script)
- **WORKFLOW kalau sentinel muncul:**
  1. Smoke test 1 wallet: `vps "python3 /root/depinz/register_one.py 999 --label lwd-test"` — pastikan 200 OK
  2. Submit 1 proof: `vps "python3 /root/depinz/submit_proof_one.py wallet-999"` — pastikan verdict accepted
  3. Kalau 1+2 sukses → kick batch: `vps "nohup python3 /root/depinz/register_batch.py --execute >/root/depinz/logs/batch.out 2>&1 &"`
- **PENTING:** jangan bikin script node-PALSU (lapor tanpa node asal). Pruned node ini sumber data sah; 250 wallet adalah label-spam di backend mereka yg memang allow 5-node-per-wallet w/ label berbeda. Per-wallet hanya 1 node (label `lwd-NNN`).

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

## ATURAN KERJA — ZERO ASUMSI (WAJIB)

User sudah berkali-kali rugi waktu karena asumsi saya keliru. **Pelanggaran aturan ini = pekerjaan tidak diterima.**

### Larangan absolut
- **Jangan pernah bilang "kemungkinan", "mungkin karena", "pre-launch", "incident mode"** sebelum baca source code / git log / dokumen langsung yang membuktikan.
- **Jangan generalisasi dari 1 sample** (mis: lihat 1 stats field aneh → jangan langsung simpulkan "project belum live").
- **Jangan stop di "first explanation that fits"** — selalu cek 2-3 sumber independent dulu sebelum simpulkan.
- **Jangan kerjakan infrastruktur sampingan** (backup, watchdog, optimasi) selama goal utama belum tervalidasi bisa tercapai. Goal utama dulu, sampai terbukti benar atau terbukti buntu.

### Wajib sebelum simpulkan apapun
1. **Baca source code** kalau ada (repo lokal `/root/dz-audit/`, atau git clone fresh).
2. **Baca git log** `--since="7 days ago"` untuk lihat perubahan terbaru.
3. **Baca website target langsung** (frontend source di repo, bukan WebFetch karena SPA kosong).
4. **Test empirik dari MULTIPLE angle** — fresh wallet, IP berbeda, host alternatif, semua varian field.
5. **Cek deploy config** (fly.toml, Dockerfile, .env.example) untuk env vars yang aktif.

### Validasi hasil — wajib backend-verified
Hasil pekerjaan **harus terlihat di backend pihak ketiga**, bukan cuma di file lokal:
- "Register wallet" = wallet harus muncul di dashboard publik mereka, bukan cuma `state.json` di VPS.
- "Submit proof" = harus ada `accepted_proofs++` di stats API mereka, bukan cuma log lokal.
- "Sync node" = harus `verificationprogress=1.0` di getblockchaininfo, bukan cuma `is-active`.
- "Watchdog jalan" = harus ada bukti action di log, bukan cuma `is-active`.

Setiap claim "DONE/SUCCESS" tanpa bukti backend = false positive. Stop, balik, verifikasi dulu.

### Kalau buntu / blocker external
- Bilang **terang-terangan**: "blocker = X di server pihak Y, saya tidak bisa bypass, butuh A/B/C dari user".
- **Jangan bikin alasan** ("project belum launch", "incident mode") tanpa bukti commit / tweet langsung.
- **Jangan kerjakan side-task** sebagai pengganti — itu buang waktu user.

## KALAU BRIDGE ERROR
1. Re-run bootstrap untuk fetch URL terbaru (VPS watchdog cron 2-min mungkin belum sempat publish).
2. Kalau masih error, cek `vps_url.txt` di repo `claude-vps` raw. Kalau URL nya outdated >5 menit, tunnel service mungkin down — minta user SSH ke laptop & jalankan `systemctl restart vps-tunnel`.
3. Watchdog log: `/var/log/awp/bridge-watchdog.log` (lewat `vps "tail /var/log/awp/bridge-watchdog.log"`).
