# Scripts

## zcash_awp_failover.py

Auto-revert tuning zcashd ke baseline begitu AWP PoW endpoint stabil. Deployed di VPS sebagai systemd timer (5-menit interval).

**Lokasi di VPS:**
- Script: `/usr/local/bin/zcash_awp_failover.py`
- Service: `/etc/systemd/system/zcash-awp-failover.service`
- Timer: `/etc/systemd/system/zcash-awp-failover.timer`
- Log: `/var/log/awp/zcash-failover.log`
- Marker (sekali ke-revert): `/var/lib/zcash-awp-failover/reverted.flag`

**Decision rule:** 30 menit terakhir di log AWP miner: ≥8 baris event AND nol baris `PoW endpoint DOWN` → revert.

**Baseline (yang dipulihkan):**
- `CPUQuota=100%`
- `Nice=15`
- `IOWeight=20`
- `dbcache=800`
- `par=2` dihapus
- restart zcashd

**Operasi:**

```bash
# Cek log
vps "tail -20 /var/log/awp/zcash-failover.log"

# Cek timer
vps "systemctl status zcash-awp-failover.timer"

# Test dry-run
vps "/usr/local/bin/zcash_awp_failover.py --dry-run"

# Matikan permanen
vps "systemctl disable --now zcash-awp-failover.timer"

# Re-arm setelah manual re-tune
vps "rm /var/lib/zcash-awp-failover/reverted.flag"
```
