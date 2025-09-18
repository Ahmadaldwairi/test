import { cfg } from './src/config.js';
import { Bot } from './src/bot.js';

// For now, uses the same worker/poller as dev.
// Next step: swap to Helius WS subscription filtered to Pump.fun/Raydium program IDs,
// and swap SimulatedAdapter for a real JitoAdapter in src/executionAdapters/jitoStub.js

if (!cfg.helius.rpcUrl || !cfg.helius.wsUrl) {
  console.warn('Fill HELIUS_RPC_URL and HELIUS_WS_URL in .env for prod mode.');
}

const bot = new Bot({
  mode: 'prod',
  rpcUrl: cfg.helius.rpcUrl,
  wsUrl: cfg.helius.wsUrl,
  execution: 'simulated' // change to 'jito' when you implement JitoAdapter
});
bot.start();
