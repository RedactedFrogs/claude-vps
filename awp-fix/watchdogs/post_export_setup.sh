#!/bin/bash
# Auto-run after export_keys.sh completes.
# Applies native signer patch to miner v4, sets CONC=20, restarts service.
LOG=/var/log/awp/post-export-setup.log
KEYS=/root/.awp-mining/wallet_keys.json
MINER=/root/.awp-mining/awp_miner_v4.py

log() { echo "[$(date -u +%FT%TZ)] $*" >> $LOG; }

if [ ! -f $KEYS ]; then
    log "keys file missing"; exit 1
fi

COUNT=$(python3 -c "import json; print(len(json.load(open('$KEYS'))))")
log "loaded $COUNT keys"
if [ $COUNT -lt 200 ]; then
    log "too few keys ($COUNT < 200), abort"; exit 1
fi

# Patch miner: add native signer block at module-level (after imports)
if grep -q '__NATIVE_SIGNER_APPLIED__' $MINER; then
    log "already patched"
else
    cp $MINER $MINER.bak-pre-native-$(date +%H%M)
    python3 <<PYEOF >> $LOG 2>&1
src = open('$MINER').read()
needle = 'import httpx\n'
patch = '''import httpx
# === NATIVE EIP-712 SIGNING (10x speedup vs awp-wallet) ===
# __NATIVE_SIGNER_APPLIED__
import json as _njson
from eth_account import Account as _Account
from eth_account.messages import encode_typed_data as _enc_typed
try:
    _NATIVE_KEYS = _njson.load(open("$KEYS"))
    _ACCT_CACHE = {}
    def _native_get_acct(wallet):
        if wallet not in _ACCT_CACHE:
            ent = _NATIVE_KEYS.get(wallet)
            if ent: _ACCT_CACHE[wallet] = _Account.from_key(ent["pk"])
        return _ACCT_CACHE.get(wallet)
    import signer as _sg
    def _native_sign(self, typed_data):
        wallet = os.environ.get("AWP_AGENT_ID", "")
        acct = _native_get_acct(wallet)
        if acct is None:
            # fallback to original awp-wallet path
            return _sg.WalletSigner._original_sign_typed_data(self, typed_data)
        msg = _enc_typed(full_message=typed_data)
        return acct.sign_message(msg).signature.hex()
    def _native_addr(self):
        wallet = os.environ.get("AWP_AGENT_ID", "")
        acct = _native_get_acct(wallet)
        if acct: return acct.address
        return _sg.WalletSigner._original_get_address(self)
    if not hasattr(_sg.WalletSigner, "_original_sign_typed_data"):
        _sg.WalletSigner._original_sign_typed_data = _sg.WalletSigner.sign_typed_data
        _sg.WalletSigner._original_get_address = _sg.WalletSigner.get_address
    _sg.WalletSigner.sign_typed_data = _native_sign
    _sg.WalletSigner.get_address = _native_addr
except Exception as _ne:
    pass  # fallback to default signer
# === END NATIVE SIGNING ===
'''
open('$MINER','w').write(src.replace(needle, patch, 1))
print('patched native signer')
PYEOF
    log "miner patched"
fi

# Bump CONC to 20 (10x faster signing = more parallel ok)
sed -i 's/Environment=MINER_CONC=[0-9]*/Environment=MINER_CONC=20/' /etc/systemd/system/awp-miner.service.d/override.conf
log "CONC=20 applied"

systemctl daemon-reload
systemctl start awp-miner.service
sleep 5
if systemctl is-active --quiet awp-miner.service; then
    log "miner restarted successfully"
else
    log "MINER START FAILED — check journalctl"
fi
