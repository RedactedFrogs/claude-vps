# Scripts

## zcash_awp_failover.py

Bidirectional flipper untuk balance resource zcashd ↔ AWP berdasarkan kondisi AWP API. Systemd timer trigger tiap 5 menit.

**Decision rule (timestamp-based):**
- Scan AWP log, ambil signal terbaru:
  - Down: `PoW endpoint DOWN`
  - Healthy: `PoW endpoint OK` | `round X START` | `round X DONE — accepted=N (N>0)`
- Latest signal menang, asal masih dalam 30 menit terakhir
- `AWP=healthy & zcashd=accelerated` → revert
- `AWP=down & zcashd=baseline` → re-accelerate
- Stale (>30 min) atau no signal → no change

**Live properties yang di-flip (no restart):**
| State | CPUQuota | IOWeight | Nice |
|---|---|---|---|
| Accelerated | 200% | 200 | 0 |
| Baseline | 100% | 20 | 15 |

`dbcache=2000` dan `par=2` permanent di `zcash.conf` (tidak di-flip).

**Lokasi di VPS:**
- Script: `/usr/local/bin/zcash_awp_failover.py`
- Service: `/etc/systemd/system/zcash-awp-failover.service`
- Timer: `/etc/systemd/system/zcash-awp-failover.timer`
- Log: `/var/log/awp/zcash-failover.log`

**Operasi:**

```bash
# Cek log
vps "tail -20 /var/log/awp/zcash-failover.log"

# Cek timer
vps "systemctl list-timers zcash-awp-failover.timer"

# Test dry-run (no side-effect)
vps "/usr/local/bin/zcash_awp_failover.py --dry-run"

# Matikan permanen
vps "systemctl disable --now zcash-awp-failover.timer"
```
