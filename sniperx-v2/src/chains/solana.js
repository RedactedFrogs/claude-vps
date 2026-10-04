import { Connection, PublicKey, Transaction, SystemProgram, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

const RAYDIUM_AMM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const PUMP_FUN = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export class SolanaChain {
  constructor(rpcManager) {
    this.rpcManager = rpcManager;
    this.monitoring = false;
    this.logSubscription = null;
  }

  getConnection() {
    return this.rpcManager.getSolanaConnection();
  }

  async getBalance(address) {
    const conn = this.getConnection();
    const pubkey = new PublicKey(address);
    const balance = await conn.getBalance(pubkey);
    return balance / LAMPORTS_PER_SOL;
  }

  async getTokenAccounts(walletAddress) {
    const conn = this.getConnection();
    const pubkey = new PublicKey(walletAddress);
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(pubkey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    });
    return tokenAccounts.value.map(acc => ({
      mint: acc.account.data.parsed.info.mint,
      amount: acc.account.data.parsed.info.tokenAmount.uiAmount,
      decimals: acc.account.data.parsed.info.tokenAmount.decimals
    }));
  }

  async monitorRaydiumPools(callback) {
    this.monitoring = true;
    const conn = this.getConnection();

    console.log('[Solana] Monitoring Raydium new pools...');

    this.logSubscription = conn.onLogs(RAYDIUM_AMM, (logInfo) => {
      if (!this.monitoring) return;
      if (logInfo.err) return;

      const hasInit = logInfo.logs?.some(l =>
        l.includes('initialize2') || l.includes('InitializeInstruction2')
      );

      if (hasInit) {
        callback({
          type: 'raydium_pool',
          signature: logInfo.signature,
          chain: 'solana',
          timestamp: Date.now()
        });
      }
    }, 'confirmed');
  }

  async monitorPumpFun(callback) {
    const conn = this.getConnection();

    console.log('[Solana] Monitoring Pump.fun launches...');

    conn.onLogs(PUMP_FUN, (logInfo) => {
      if (!this.monitoring) return;
      if (logInfo.err) return;

      const hasCreate = logInfo.logs?.some(l =>
        l.includes('Create') || l.includes('create')
      );

      if (hasCreate) {
        callback({
          type: 'pumpfun_launch',
          signature: logInfo.signature,
          chain: 'solana',
          timestamp: Date.now()
        });
      }
    }, 'confirmed');
  }

  buildSwapTx(poolInfo, amountSOL) {
    return async (keypair, _index) => {
      const tx = new Transaction();
      tx.add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new PublicKey(poolInfo.poolAddress),
          lamports: Math.floor(amountSOL * LAMPORTS_PER_SOL)
        })
      );
      tx.feePayer = keypair.publicKey;
      const conn = this.getConnection();
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      return tx;
    };
  }

  stopMonitoring() {
    this.monitoring = false;
    if (this.logSubscription !== null) {
      const conn = this.getConnection();
      conn.removeOnLogsListener(this.logSubscription);
      this.logSubscription = null;
    }
  }
}
