// src/bot.js
import { Connection, Keypair } from '@solana/web3.js';
import WebSocket from 'ws';
import fetch from 'node-fetch';
import { cfg } from './config.js';
import { createWalletLoader } from './walletLoader.js';
import { SessionLog } from './logger.js';
import { exitPriceForTargetUsd } from './math.js';
import { SimulatedAdapter } from './executionAdapters/simulated.js';
import { getSolUsd } from './priceFeed.js';

const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dk3FywbjC4tSpPxa1G2EvDRo1ZHt91';
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

// Stubbed Jito adapter (implement buildPumpFunBuyTx/buildPumpFunSellTx for live mode)
class JitoAdapter {
  constructor({ jitoEndpoint, feeBps, maxSlippageBps }) {
    this.jitoEndpoint = jitoEndpoint;
    this.feeBps = feeBps;
    this.maxSlippageBps = maxSlippageBps;
  }

  async buy({ solAmount, markUsd }) {
    const tx = await buildPumpFunBuyTx(solAmount, markUsd); // Stub: implement Pump.fun swap
    const bundle = new Bundle([tx], this.signer);
    const res = await fetch(`${this.jitoEndpoint}/sendBundle`, {
      method: 'POST',
      body: JSON.stringify(bundle),
    });
    const result = await res.json();
    return {
      fillUsd: solAmount * (await getSolUsd()),
      sizeTokens: solAmount / markUsd,
      costUsd: solAmount * (await getSolUsd()) * (1 + this.feeBps / 10000),
    };
  }

  async sell({ sizeTokens, targetExitUsd }) {
    const tx = await buildPumpFunSellTx(sizeTokens, targetExitUsd); // Stub: implement swap
    const bundle = new Bundle([tx], this.signer);
    const res = await fetch(`${this.jitoEndpoint}/sendBundle`, {
      method: 'POST',
      body: JSON.stringify(bundle),
    });
    const result = await res.json();
    return {
      fillUsd: targetExitUsd,
      proceedsUsd: targetExitUsd * sizeTokens * (1 - this.feeBps / 10000),
    };
  }
}

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
      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        this.subscribeAll();
      }
    });

    // signer (not used in simulated mode)
    this.signer = this.loadSigner(cfg.secretKey);

    // execution adapter
    this.exec = execution === 'jito' ? new JitoAdapter({
      jitoEndpoint: process.env.JITO_ENDPOINT,
      feeBps: cfg.feeBps,
      maxSlippageBps: cfg.maxSlippageBps,
    }) : new SimulatedAdapter({
      feeBps: cfg.feeBps,
      maxSlippageBps: cfg.maxSlippageBps,
    });

    // Latency test
    this.latencyTest = setInterval(async () => {
      const start = Date.now();
      await this.conn.getSlot();
      console.log(`[latency] RPC ping: ${Date.now() - start}ms`);
    }, 10000);
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

  async checkRugRisk(tokenMint) {
    try {
      const res = await fetch(`https://api.solscan.io/token/holders?token=${tokenMint}`);
      const data = await res.json();
      return data.result?.[0]?.amount / data.totalSupply < 0.2; // Safe if top holder <20%
    } catch {
      return false; // Assume risky if API fails
    }
  }

  async getTokenPrice(tokenMint) {
    try {
      const res = await fetch(`https://api.birdeye.so/v1/token/price?address=${tokenMint}&api-key=${BIRDEYE_API_KEY}`);
      const data = await res.json();
      return data?.data?.price || 0.001; // Fallback for sim
    } catch {
      return 0.001;
    }
  }

  startWebSocket() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[ws] connected');
      this.subscribeAll();
    });

    ws.on('message', async (data) => {
      const tDetect = Date.now();
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'logsNotification') {
          const { signature, logs } = msg.params.result;
          if (!logs?.includes(PUMP_FUN_PROGRAM)) return; // Skip non-Pump.fun txs
          if (this.seen.has(signature)) return;
          this.seen.add(signature);
          if (this.seen.size > this.seenMax) {
            this.seen = new Set(Array.from(this.seen).slice(-this.seenMax));
          }
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
    for (const [addr] of this.tracked.entries()) {
      const sub = {
        jsonrpc: '2.0',
        id: addr,
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
    }, 50);
  }

  async handleSignal(job) {
    const tStart = Date.now();
    const walletInfo = this.tracked.get(job.wallet);
    const walletName = walletInfo?.name || job.wallet;
    const rules = walletInfo?.rules || {};
    const isCreator = rules.isCreator || false;

    // Check tx for Pump.fun CREATE
    const tx = await this.conn.getTransaction(job.sig, { commitment: 'confirmed' });
    const isCreateTx = tx?.meta?.logMessages?.some(log => log.includes(PUMP_FUN_PROGRAM) && log.includes('create'));

    // Creator launch: buy and hold manually
    if (isCreator && isCreateTx) {
      const tokenMint = tx?.meta?.innerInstructions?.[0]?.accounts?.[0];
      if (tokenMint && !await this.checkRugRisk(tokenMint)) {
        console.log(`[skip] ${walletName}: High rug risk (top holder >20%)`);
        return;
      }
      const mark = await this.getTokenPrice(tokenMint);
      const buy = await this.exec.buy({ solAmount: cfg.buySol, markUsd: mark });
      this.log.newTrade({
        side: 'creator',
        base: 'TOKEN',
        quote: 'USD',
        costUsd: buy.costUsd,
        proceedsUsd: 0, // Manual exit
        realizedUsd: 0, // TBD
      });
      console.log(`[creator #${this.log.count}] ${walletName} | Bought $${buy.costUsd.toFixed(2)} | Holding for manual exit`);
      return;
    }

    // Non-creator trade
    const solUsd = await getSolUsd();
    const estBuySizeUsd = rules.est_buy_size_usd || 10;
    const buySol = Math.min(estBuySizeUsd / solUsd, cfg.buySol);
    const minBuyUsd = rules.min_buy_usd || 50;

    if (buySol * solUsd < minBuyUsd) {
      console.log(`[skip] ${walletName}: not enough size (have ~$${(buySol * solUsd).toFixed(2)}, need ≥ $${minBuyUsd})`);
      return;
    }

    const tokenMint = tx?.meta?.innerInstructions?.[0]?.accounts?.[0];
    if (tokenMint && !await this.checkRugRisk(tokenMint)) {
      console.log(`[skip] ${walletName}: High rug risk (top holder >20%)`);
      return;
    }

    const mark = await this.getTokenPrice(tokenMint);
    const buy = await this.exec.buy({ solAmount: buySol, markUsd: mark });
    const tpMultiple = rules.tp_multiple || 1.5;
    const targetTotalUsd = buy.fillUsd * tpMultiple * buy.sizeTokens;
    const exitUsd = exitPriceForTargetUsd({
      entryUsd: buy.fillUsd,
      sizeTokens: buy.sizeTokens,
      feeBps: cfg.feeBps,
      exitSlipBps: cfg.maxSlippageBps,
      targetUsd: targetTotalUsd,
    });

    const holdSeconds = rules.avg_hold_seconds || 20;
    if (holdSeconds > 0) {
      await new Promise(r => setTimeout(r, holdSeconds * 1000));
    }

    const sell = await this.exec.sell({ sizeTokens: buy.sizeTokens, targetExitUsd: exitUsd });
    const realizedUsd = sell.proceedsUsd - buy.costUsd;

    const tDone = Date.now();
    const latencyDetectToHandle = tStart - (job.tDetect || tStart);
    const latencyTotal = tDone - (job.tDetect || tStart);

    const t = this.log.newTrade({
      side: 'scalp',
      base: 'TOKEN',
      quote: 'USD',
      costUsd: buy.costUsd,
      proceedsUsd: sell.proceedsUsd,
      realizedUsd,
    });

    console.log(
      `[trade #${t.id}] ${walletName} | SOL ~$${solUsd.toFixed(2)} | buy $${buy.fillUsd.toFixed(6)} → sell ~$${sell.fillUsd.toFixed(6)} | P/L $${realizedUsd.toFixed(2)} | detect→start ${latencyDetectToHandle}ms | total ${latencyTotal}ms`
    );
  }

  async shutdown() {
    if (this.worker) clearInterval(this.worker);
    if (this.latencyTest) clearInterval(this.latencyTest);
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



