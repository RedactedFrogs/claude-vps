#!/bin/bash
# Cool-down miner 60s setiap restart cycle.
# Mengikuti rekomendasi Hostinger: hindari CPU sustained >180 menit untuk avoid throttle.
LOG=/var/log/awp/miner-cooldown.log
echo "[$(date -u +%FT%TZ)] cool-down: stop miner 60s" >> $LOG
systemctl stop awp-miner
sleep 60
systemctl start awp-miner
echo "[$(date -u +%FT%TZ)] cool-down done, miner resumed" >> $LOG
