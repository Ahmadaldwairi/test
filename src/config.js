import 'dotenv/config';

export const cfg = {
  buySol: Number(process.env.BUY_SOL ?? 0.2),
  tpUsd: Number(process.env.TP_USD ?? 7),
  maxSlippageBps: Number(process.env.MAX_SLIPPAGE_BPS ?? 200),
  feeBps: Number(process.env.FEE_BPS ?? 60),
  priceSource: process.env.PRICE_SOURCE ?? 'mark',

  // signer
  secretKey: process.env.SIGNER_SECRET_KEY ?? '',

  // prod
  helius: {
    apiKey: process.env.HELIUS_API_KEY ?? '',
    rpcUrl: process.env.HELIUS_RPC_URL ?? '',
    wsUrl: process.env.HELIUS_WS_URL ?? ''
  },
  jito: {
    rpcUrl: process.env.JITO_RPC_URL ?? ''
  },

  // dev
  devnet: {
    rpcUrl: process.env.DEV_RPC_URL ?? 'https://api.devnet.solana.com',
    wsUrl: process.env.DEV_WS_URL ?? 'wss://api.devnet.solana.com'
  },

  // engine
  walletsFile: 'tracked_wallets.txt',
  reloadMs: 5000,
  commitment: process.env.COMMITMENT ?? 'processed',
  maxInFlight: 1,

  // === NEW for SimulatedAdapterV2 ===
  simLiquidityTokens: Number(process.env.SIM_LIQ_TOKENS ?? 1_000_000),
  initTokenPriceUsd: Number(process.env.INIT_TOKEN_PRICE_USD ?? 0.001),
  priceVolatility: Number(process.env.PRICE_VOLATILITY ?? 0.002),
  priceTickMs: Number(process.env.PRICE_TICK_MS ?? 1000)
};
