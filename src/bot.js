// src/bot.js
import { Connection, Keypair } from '@solana/web3.js';
import WebSocket from 'ws';
import { cfg } from './config.js';
import { createWalletLoader } from './walletLoader.js';
import { SessionLog } from './logger.js';
import { exitPriceForTargetUsd } from './math.js';
import { SimulatedAdapter } from './executionAdapters/simulated.js';
import { getSolUsd } from './priceFeed.js';

export class Bot {
  constructor({ mode, rpcUrl, wsUrl, execution = 'simulated' }) {
    this.mode = mode; // 'prod' or 'dev'
    this.rpcUrl = rpcUrl;
    this.wsUrl = wsUrl;
    this.conn = new Connection(rpcUrl, cfg.commitment);
    this.log = new SessionLog();
    this.inFlight = 0;
    this.queue = [];
    this.seen = new Set(); // dedupe tx signatures
    this.seenMax = 5000; 

    // tracked wallets: Map<addr, { name, rules }>
    this.tracked = new Map();
    this.stopWalletWatcher = createWalletLoader(cfg.walletsFile, cfg.reloadMs, (map) => {
      this.tracked = map;
      console.log(`[wallets] now tracking ${this.tracked.size} address(es)`);
      // if WS is up, (re)subscribe for any new wallets
      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        this.subscribeAll();
      }
    });

    // signer (not used in simulated mode)
    this.signer = this.loadSigner(cfg.secretKey);

    // execution adapter (paper-trade now; later swap to live)
    this.exec = new SimulatedAdapter({
      feeBps: cfg.feeBps,
      maxSlippageBps: cfg.maxSlippageBps,
    });
  }

  loadSigner(secret) {
    if (!secret) {
      console.warn('No SIGNER_SECRET_KEY set. (OK for simulated mode.)');
      return null;
    }
    try {
      if (secret.trim().startsWith('[')) {
        const arr = Uint8Array.from(JSON.parse(secret));
        return Keypair.fromSecretKey(arr);
      } else {
        console.warn('Base58 key support not implemented in this snippet.');
      }
    } catch (e) {
      console.error('Failed to load secret key:', e.message);
    }
    return null;
  }

  async start() {
    console.log(`[bot] mode=${this.mode} rpc=${this.rpcUrl}`);
    this.runWorker();

    if (this.wsUrl) {
      console.log(`[ws] connecting to ${this.wsUrl}`);
      this.startWebSocket();
    } else {
      console.log('[warn] No wsUrl set — please set HELIUS_WS_URL in .env for real-time detection.');
    }

    process.on('SIGINT', () => this.shutdown());
  }

  startWebSocket() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[ws] connected');
      this.subscribeAll();
    });

    ws.on('message', (data) => {
      const tDetect = Date.now();
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'logsNotification') {
          const { signature, err } = msg.params.result;
          if (err) return; // ignore failed tx logs
          if (this.seen.has(signature)) return;
          this.seen.add(signature);
          if (this.seen.size > this.seenMax) {
  // quick prune: recreate with last N (no need to be perfect)
  this.seen = new Set(Array.from(this.seen).slice(-this.seenMax));
}


          // We used wallet address as subscription ID when we subscribed
          const walletAddr = String(msg.params.subscription || '');
          if (!this.tracked.has(walletAddr)) return;

          this.queue.push({
            type: 'signal',
            wallet: walletAddr,
            sig: signature,
            tDetect,
          });
        }
      } catch (e) {
        console.error('[ws] parse error:', e.message);
      }
    });

    ws.on('close', () => {
      console.log('[ws] closed, retrying in 3s...');
      setTimeout(() => this.startWebSocket(), 3000);
    });

    ws.on('error', (err) => {
      console.error('[ws] error:', err.message);
    });
  }

  subscribeAll() {
    // Subscribe to logs mentioning each wallet (standard Solana WS)
    for (const [addr] of this.tracked.entries()) {
      const sub = {
        jsonrpc: '2.0',
        id: addr, // keep ID = wallet so we can map notifications
        method: 'logsSubscribe',
        params: [
          { mentions: [addr] },
          { commitment: cfg.commitment || 'processed' },
        ],
      };
      try {
        this.ws.send(JSON.stringify(sub));
      } catch (e) {
        console.error('[ws] subscribe error:', e.message);
      }
    }
    console.log(`[ws] subscribed to ${this.tracked.size} wallet log streams`);
  }

  runWorker() {
    this.worker = setInterval(async () => {
      if (this.inFlight >= (cfg.maxInFlight || 1)) return;
      const job = this.queue.shift();
      if (!job) return;
      this.inFlight++;

      try {
        await this.handleSignal(job);
      } catch (e) {
        console.error('job error:', e.message);
      } finally {
        this.inFlight--;
      }
    }, 50); // tight loop for low latency
  }

  async handleSignal(job) {
    const tStart = Date.now();
    const walletInfo = this.tracked.get(job.wallet);
    const walletName = walletInfo?.name || job.wallet;
    const rules = walletInfo?.rules || {};

    // --- live SOL/USD ---
    const solUsd = await getSolUsd(); // cached a few seconds
    const myBuyUsd = cfg.buySol * solUsd;

    // rules with fallbacks
    const tpMultiple = rules.tp_multiple ?? 1.5;
    const holdSeconds = rules.avg_hold_seconds ?? 20;
    const minBuyUsd = rules.min_buy_usd ?? 50;

    if (myBuyUsd < minBuyUsd) {
      console.log(`[skip] ${walletName}: not enough size (have ~$${myBuyUsd.toFixed(2)}, need ≥ $${minBuyUsd})`);
      return;
    }

    // ----- BUY (simulated adapter uses markUsd; keep placeholder mark) -----
    const mark = 0.001; // fake token mark price (paper trading)
    const buy = await this.exec.buy({ solAmount: cfg.buySol, markUsd: mark });

    // Exit target by multiple (translate to USD total proceeds)
    // We’ll ask math helper for a target *price*, using target total USD = entryUSD * tpMultiple
    const targetTotalUsd = buy.fillUsd * tpMultiple * buy.sizeTokens;
    const exitUsd = exitPriceForTargetUsd({
      entryUsd: buy.fillUsd,
      sizeTokens: buy.sizeTokens,
      feeBps: cfg.feeBps,
      exitSlipBps: cfg.maxSlippageBps,
      targetUsd: targetTotalUsd,
    });

    // Optional: “time hold” in sim mode to mimic behavior pattern
    if (holdSeconds > 0) {
      await new Promise((r) => setTimeout(r, holdSeconds * 1000));
    }

    const sell = await this.exec.sell({ sizeTokens: buy.sizeTokens, targetExitUsd: exitUsd });
    const realizedUsd = sell.proceedsUsd - buy.costUsd;

    // latency metrics
    const tDone = Date.now();
    const latencyDetectToHandle = tStart - (job.tDetect || tStart);
    const latencyTotal = tDone - (job.tDetect || tStart);

    // log + session stats
    const t = this.log.newTrade({
      side: 'scalp',
      base: 'TOKEN',
      quote: 'USD',
      costUsd: buy.costUsd,
      proceedsUsd: sell.proceedsUsd,
      realizedUsd,
    });

    console.log(
      `[trade #${t.id}] ${walletName} | SOL ~$${solUsd.toFixed(2)} | buy $${buy.fillUsd.toFixed(6)} → sell ~$${(sell.fillUsd || exitUsd).toFixed(6)} | P/L $${realizedUsd.toFixed(
        2
      )} | detect→start ${latencyDetectToHandle}ms | total ${latencyTotal}ms`
    );
  }

  async shutdown() {
    if (this.worker) clearInterval(this.worker);
    if (this.stopWalletWatcher) this.stopWalletWatcher();
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }

    const s = this.log.summary();
    console.log('\n=== SESSION SUMMARY ===');
    console.log(`Trades: ${s.count}`);
    console.log(`Invested (USD est): $${s.invested.toFixed(2)}`);
    console.log(`Realized P/L: $${s.realized.toFixed(2)}\n`);
    process.exit(0);
  }
}



