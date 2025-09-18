import { cfg } from './src/config.js';
import { Bot } from './src/bot.js';

const bot = new Bot({
  mode: 'dev',
  rpcUrl: cfg.devnet.rpcUrl,
  wsUrl: cfg.devnet.wsUrl,
  execution: 'simulated'
});
bot.start();

// TIP: Fund your devnet wallet with fake SOL:
// 1) Install Solana CLI, run: solana config set --url https://api.devnet.solana.com
// 2) solana-keygen new --outfile ~/.config/solana/devnet.json
// 3) solana airdrop 2 <YOUR_DEVNET_PUBKEY>
