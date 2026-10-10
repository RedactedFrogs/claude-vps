import { ethers } from 'ethers';

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
];

const UNISWAP_V2_ROUTER_ABI = [
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory)',
  'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)',
  'function WETH() view returns (address)'
];

const UNISWAP_V2_FACTORY_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
  'function getPair(address tokenA, address tokenB) view returns (address)',
  'function allPairsLength() view returns (uint)'
];

const PAIR_ABI = [
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];

const SEADROP_ABI = [
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
  'function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, tuple(uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients) mintParams, bytes32[] proof) payable',
  'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  'function getAllowListMerkleRoot(address nftContract) view returns (bytes32)',
  'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
  'function getSigners(address nftContract) view returns (address[])'
];

const SEADROP_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';

export class EVMChain {
  constructor(rpcManager, chainKey, chainConfig) {
    this.rpcManager = rpcManager;
    this.chainKey = chainKey;
    this.config = chainConfig;
    this.monitoring = false;
  }

  getProvider() {
    return this.rpcManager.getEVMProvider(this.chainKey);
  }

  getRouter(provider) {
    const routerAddr = this.config.dex.uniswapV2Router || this.config.dex.pancakeRouter;
    return new ethers.Contract(routerAddr, UNISWAP_V2_ROUTER_ABI, provider);
  }

  getFactory(provider) {
    const factoryAddr = this.config.dex.uniswapV2Factory || this.config.dex.pancakeFactory;
    return new ethers.Contract(factoryAddr, UNISWAP_V2_FACTORY_ABI, provider);
  }

  getWETH() {
    return this.config.dex.weth || this.config.dex.wbnb;
  }

  async getTokenInfo(tokenAddress) {
    const provider = this.getProvider();
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      token.name().catch(() => 'Unknown'),
      token.symbol().catch(() => '???'),
      token.decimals().catch(() => 18),
      token.totalSupply().catch(() => 0n)
    ]);
    return { address: tokenAddress, name, symbol, decimals: Number(decimals), totalSupply: totalSupply.toString() };
  }

  async getBalance(address) {
    const provider = this.getProvider();
    const balance = await provider.getBalance(address);
    return ethers.formatEther(balance);
  }

  async getTokenBalance(tokenAddress, walletAddress) {
    const provider = this.getProvider();
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [balance, decimals] = await Promise.all([
      token.balanceOf(walletAddress),
      token.decimals()
    ]);
    return ethers.formatUnits(balance, decimals);
  }

  async checkPairExists(tokenAddress) {
    const provider = this.getProvider();
    const factory = this.getFactory(provider);
    const pair = await factory.getPair(tokenAddress, this.getWETH());
    return pair !== ethers.ZeroAddress ? pair : null;
  }

  async getAmountOut(amountIn, tokenAddress) {
    const provider = this.getProvider();
    const router = this.getRouter(provider);
    const path = [this.getWETH(), tokenAddress];
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[1];
  }

  buildBuyTx(tokenAddress, amountETH, slippage = 15) {
    return async (signer, _index, opts) => {
      const router = this.getRouter(signer);
      const weth = this.getWETH();
      const path = [weth, tokenAddress];
      const value = ethers.parseEther(amountETH.toString());
      const deadline = Math.floor(Date.now() / 1000) + 300;

      let amountOutMin = 0n;
      try {
        const amounts = await router.getAmountsOut(value, path);
        const slip = opts?.slippage || slippage;
        amountOutMin = amounts[1] * BigInt(100 - slip) / 100n;
      } catch { /* new pair, no quote yet — use 0 */ }

      const tx = await router.swapExactETHForTokens.populateTransaction(
        amountOutMin, path, await signer.getAddress(), deadline,
        { value }
      );
      return tx;
    };
  }

  buildSellTx(tokenAddress, percentage = 100, slippage = 15) {
    return async (signer) => {
      const walletAddr = await signer.getAddress();
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
      const router = this.getRouter(signer);
      const weth = this.getWETH();

      const balance = await token.balanceOf(walletAddr);
      const sellAmount = balance * BigInt(percentage) / 100n;

      const routerAddr = this.config.dex.uniswapV2Router || this.config.dex.pancakeRouter;
      const allowance = await token.allowance?.(walletAddr, routerAddr) ?? 0n;
      if (allowance < sellAmount) {
        const approveTx = await token.approve(routerAddr, ethers.MaxUint256);
        await approveTx.wait(1);
      }

      const path = [tokenAddress, weth];
      const deadline = Math.floor(Date.now() / 1000) + 300;
      let amountOutMin = 0n;
      try {
        const amounts = await router.getAmountsOut(sellAmount, path);
        amountOutMin = amounts[1] * BigInt(100 - slippage) / 100n;
      } catch { /* fallback 0 */ }

      return router.swapExactTokensForETH.populateTransaction(
        sellAmount, amountOutMin, path, walletAddr, deadline
      );
    };
  }

  buildMintTx(contractAddress, mintFunctionABI, mintArgs, value) {
    return async (signer) => {
      const contract = new ethers.Contract(contractAddress, [mintFunctionABI], signer);
      const fnName = mintFunctionABI.match(/function (\w+)/)?.[1];
      if (!fnName) throw new Error('Invalid mint ABI');
      const tx = await contract[fnName].populateTransaction(...mintArgs, {
        value: value ? ethers.parseEther(value.toString()) : 0n
      });
      return tx;
    };
  }

  async getOpenSeaMintTx(collectionSlug, minterAddress, quantity, apiKey) {
    const url = `https://api.opensea.io/api/v2/drops/${collectionSlug}/mint`;
    const body = JSON.stringify({ minter: minterAddress, quantity });
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenSea API ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  buildSeaDropSignedMintTx(collectionSlug, apiKey, quantity = 1) {
    return async (signer) => {
      const minter = await signer.getAddress();
      console.log(`[SeaDrop] Requesting signed mint from OpenSea for ${minter}...`);
      const mintData = await this.getOpenSeaMintTx(collectionSlug, minter, quantity, apiKey);
      const target = mintData.target || mintData.to;
      const calldata = mintData.calldata || mintData.data;
      const value = mintData.value || '0';
      if (!target || !calldata) throw new Error('OpenSea API returned invalid response: ' + JSON.stringify(mintData).slice(0, 200));
      console.log(`[SeaDrop] Got signed TX: target=${target} value=${value} calldata=${calldata.slice(0, 20)}...`);
      return { to: target, data: calldata, value };
    };
  }

  async querySeaDropInfo(nftContract, seadropAddr) {
    const provider = this.getProvider();
    const sd = new ethers.Contract(seadropAddr || SEADROP_ADDRESS, SEADROP_ABI, provider);
    const [publicDrop, merkleRoot, feeRecipients, signers] = await Promise.all([
      sd.getPublicDrop(nftContract).catch(() => null),
      sd.getAllowListMerkleRoot(nftContract).catch(() => ethers.ZeroHash),
      sd.getAllowedFeeRecipients(nftContract).catch(() => []),
      sd.getSigners(nftContract).catch(() => [])
    ]);

    const now = Math.floor(Date.now() / 1000);
    const pub = publicDrop ? {
      mintPrice: publicDrop.mintPrice.toString(),
      startTime: Number(publicDrop.startTime),
      endTime: Number(publicDrop.endTime),
      maxPerWallet: Number(publicDrop.maxTotalMintableByWallet),
      feeBps: Number(publicDrop.feeBps),
      restrictFeeRecipients: publicDrop.restrictFeeRecipients,
      isActive: Number(publicDrop.startTime) <= now && Number(publicDrop.endTime) > now && Number(publicDrop.maxTotalMintableByWallet) > 0
    } : null;

    const hasAllowList = merkleRoot !== ethers.ZeroHash;

    return {
      publicDrop: pub,
      hasAllowList,
      merkleRoot,
      feeRecipients,
      signers,
      recommended: pub?.isActive ? 'mintPublic' : hasAllowList ? 'mintAllowList' : 'mintPublic'
    };
  }

  buildSeaDropMintTx(nftContract, mintMode, options = {}) {
    const seadropAddr = options.seadropAddress || SEADROP_ADDRESS;
    const quantity = options.quantity || 1;
    const feeRecipient = options.feeRecipient || ethers.ZeroAddress;
    const mintPrice = options.mintPrice || '0';

    return async (signer) => {
      const sd = new ethers.Contract(seadropAddr, SEADROP_ABI, signer);
      const minter = await signer.getAddress();
      const value = BigInt(mintPrice) * BigInt(quantity);

      if (mintMode === 'mintPublic' || mintMode === 'public') {
        const tx = await sd.mintPublic.populateTransaction(
          nftContract, feeRecipient, ethers.ZeroAddress, quantity,
          { value }
        );
        return tx;
      }

      if (mintMode === 'mintAllowList' || mintMode === 'allowlist') {
        if (!options.mintParams) throw new Error('mintAllowList requires mintParams (startTime, endTime, etc)');
        if (!options.proof || options.proof.length === 0) throw new Error('mintAllowList requires Merkle proof');
        const mp = options.mintParams;
        const mintParams = [
          BigInt(mp.mintPrice || '0'),
          BigInt(mp.maxTotalMintableByWallet || 1),
          BigInt(mp.startTime || 0),
          BigInt(mp.endTime || 0),
          BigInt(mp.dropStageIndex || 0),
          BigInt(mp.maxTokenSupplyForStage || 0),
          BigInt(mp.feeBps || 0),
          mp.restrictFeeRecipients ?? false
        ];
        const tx = await sd.mintAllowList.populateTransaction(
          nftContract, feeRecipient, ethers.ZeroAddress, quantity,
          mintParams, options.proof,
          { value }
        );
        return tx;
      }

      throw new Error(`Unknown SeaDrop mint mode: ${mintMode}`);
    };
  }

  async monitorNewPairs(callback) {
    this.monitoring = true;
    const provider = this.getProvider();
    const factory = this.getFactory(provider);

    console.log(`[${this.chainKey}] Monitoring new pairs on factory...`);

    factory.on('PairCreated', async (token0, token1, pair, _id) => {
      if (!this.monitoring) return;
      const weth = this.getWETH().toLowerCase();
      const isWETHPair = token0.toLowerCase() === weth || token1.toLowerCase() === weth;
      if (!isWETHPair) return;

      const tokenAddr = token0.toLowerCase() === weth ? token1 : token0;
      try {
        const info = await this.getTokenInfo(tokenAddr);
        callback({ token: info, pair, chain: this.chainKey, timestamp: Date.now() });
      } catch (err) {
        callback({ token: { address: tokenAddr }, pair, chain: this.chainKey, error: err.message, timestamp: Date.now() });
      }
    });
  }

  stopMonitoring() {
    this.monitoring = false;
  }
}
