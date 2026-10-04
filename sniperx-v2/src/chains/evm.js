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
