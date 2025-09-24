// src/bot.js
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import WebSocket from 'ws';
import fetch from 'node-fetch';
import fs from 'fs';
import { cfg } from './config.js';
import { createWalletLoader } from './walletLoader.js';
import { SessionLog } from './logger.js';
import { exitPriceForTargetUsd } from './math.js';
import { SimulatedAdapter } from './executionAdapters/simulated.js';

const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dk3FywbjC4tSpPxa1G2EvDRo1ZHt91';
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;
const PRICE_FILE = 'sol_price.json';

// Stubbed Jito adapter
class JitoAdapter {
  constructor({ jitoEndpoint, feeBps, maxSlippageBps }) {
    this.jitoEndpoint = jitoEndpoint;
    this.feeBps = feeBps;
    this.maxSlippageBps = maxSlippageBps;
  }

  async buy({ solAmount, markUsd }) {
    const tx = await buildPumpFunBuyTx(solAmount, markUsd);
    const res = await fetch(`${this.jitoEndpoint}/sendBundle`, {
      method: 'POST',
      body: JSON.stringify(tx),
    });
    const result = await res.json();
    return {
      fillUsd: solAmount * (await getSolUsdFromFile()),
      sizeTokens: solAmount / markUsd,
      costUsd: solAmount * (await getSolUsdFromFile()) * (1 + this.feeBps / 10000),
    };
  }

  async sell({ sizeTokens, targetExitUsd }) {
    const tx = await buildPumpFunSellTx(sizeTokens, targetExitUsd);
    const res = await fetch(`${this.jitoEndpoint}/sendBundle`, {
      method: 'POST',
      body: JSON.stringify(tx),
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
    this.mode = mode;
    this.rpcUrl = rpcUrl;
    this.wsUrl = wsUrl;
    this.conn = new Connection(rpcUrl, cfg.commitment);
    this.log = new SessionLog();
    this.inFlight = 0;
    this.queue = [];
    this.seen = new Set();
    this.seenMax = 5000;
    this.executedMints = new Set();
    this.priceCache = {};

    this.tracked = new Map();
    this.stopWalletWatcher = createWalletLoader(cfg.walletsFile, cfg.reloadMs, (map) => {
      this.tracked = map;
      console.log(`[wallets] now tracking ${this.tracked.size} address(es)`);
      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        this.subscribeAll();
      }
    });

    this.signer = this.loadSigner(cfg.secretKey);
    this.exec = execution === 'jito' ? new JitoAdapter({
      jitoEndpoint: process.env.JITO_ENDPOINT,
      feeBps: cfg.feeBps,
      maxSlippageBps: cfg.maxSlippageBps,
    }) : new SimulatedAdapter({
      feeBps: cfg.feeBps,
      maxSlippageBps: cfg.maxSlippageBps,
    });

    cfg.maxInFlight = 10;
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

    this.startWebSocketPrice();
    process.on('SIGINT', () => this.shutdown());
  }

  async checkRugRisk(tokenMint) {
    try {
      const res = await fetch(`https://api.solscan.io/token/holders?token=${tokenMint}`);
      const data = await res.json();
      return data.result?.[0]?.amount / data.totalSupply < 0.2;
    } catch {
      return false;
    }
  }

  async getTokenPrice(tokenMint) {
    try {
      const res = await fetch(`https://api.birdeye.so/v1/token/price?address=${tokenMint}&api-key=${BIRDEYE_API_KEY}`);
      const data = await res.json();
      return data?.data?.price || 0.001;
    } catch {
      return 0.001;
    }
  }

  async getMarketCap(tokenMint) {
    try {
      const res = await fetch(`https://api.birdeye.so/v2/token/mcap?address=${tokenMint}&api-key=${BIRDEYE_API_KEY}`);
      const data = await res.json();
      return data?.data?.marketCap || 0;
    } catch {
      return 0;
    }
  }

  async getWalletBalance() {
    try {
      const balance = await this.conn.getBalance(new PublicKey(this.signer.publicKey));
      const fee = 0.015 * cfg.maxInFlight;
      return balance / 1e9 - fee;
    } catch (e) {
      console.error('[balance] Error fetching balance:', e.message);
      return 0;
    }
  }

  async getSolUsdFromFile() {
    try {
      if (fs.existsSync(PRICE_FILE)) {
        const data = JSON.parse(fs.readFileSync(PRICE_FILE, 'utf8'));
        return data.price || 25;
      }
      console.warn(`[priceFeed] ${PRICE_FILE} not found, using fallback 25`);
      return 25;
    } catch (e) {
      console.error(`[priceFeed] Error reading ${PRICE_FILE}:`, e.message);
      return 25;
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
          if (!logs?.includes(PUMP_FUN_PROGRAM)) return;
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

  startWebSocketPrice() {
    const ws = new WebSocket(`wss://public-api.birdeye.so/stream?api-key=${BIRDEYE_API_KEY}`);
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.channel === 'price') this.priceCache[msg.data.mint] = msg.data.price;
    });
    ws.on('error', (e) => console.error('[price_ws] error:', e.message));
  }

  subscribeAll() {
    for (const [addr] of this.tracked.entries()) {
      const sub = {
        jsonrpc: '2.0',
        id: addr,
        method: 'logsSubscribe',
        params: [{ mentions: [addr] }, { commitment: cfg.commitment || 'processed' }],
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
      if (this.inFlight >= cfg.maxInFlight) return;
      const jobs = [...this.queue].sort((a, b) => {
        const aRules = this.tracked.get(a.wallet)?.rules || {};
        const bRules = this.tracked.get(b.wallet)?.rules || {};
        return (bRules.success_rate || 0) - (aRules.success_rate || 0);
      });
      this.queue = [];

      for (const job of jobs) {
        if (this.inFlight >= cfg.maxInFlight) break;
        if (this.executedMints.has(job.sig)) continue;
        this.inFlight++;

        try {
          await this.handleSignal(job);
          this.executedMints.add(job.sig);
        } catch (e) {
          console.error('job error:', e.message);
        } finally {
          this.inFlight--;
        }
      }
    }, 50);
  }

  async handleSignal(job) {
    const tStart = Date.now();
    const walletInfo = this.tracked.get(job.wallet);
    const walletName = walletInfo?.name || job.wallet;
    const rules = walletInfo?.rules || {};
    const isCreator = rules.isCreator || false;
    const hasCreated = rules.hasCreated || false;
    const dumpTrigger = rules.dumpTrigger || false;

    const tx = await this.conn.getTransaction(job.sig, { commitment: 'confirmed' });
    const isCreateTx = tx?.meta?.logMessages?.some(log => log.includes(PUMP_FUN_PROGRAM) && log.includes('create'));
    const tokenMint = tx?.meta?.innerInstructions?.[0]?.accounts?.[0];

    const balance = await this.getWalletBalance();
    const solUsd = await this.getSolUsdFromFile();
    const requiredSol = 0.5 * cfg.maxInFlight + (0.015 * cfg.maxInFlight);
    if (balance < requiredSol) {
      console.log(`[skip] Insufficient balance: ${balance} SOL < ${requiredSol} SOL needed`);
      return;
    }

    if (isCreator && isCreateTx && tokenMint) {
      const mark = await this.getTokenPrice(tokenMint);
      const buySol = Math.min(0.3, cfg.buySol);
      const buy = await this.exec.buy({ solAmount: buySol, markUsd: mark });
      this.log.newTrade({
        side: 'creator',
        base: 'TOKEN',
        quote: 'USD',
        costUsd: buy.costUsd,
        proceedsUsd: 0,
        realizedUsd: 0,
      });
      console.log(`[creator #${this.log.count}] ${walletName} | Bought $${buy.costUsd.toFixed(2)} | Holding for manual exit`);
      return;
    }

    const estBuySizeUsd = Math.min(rules.est_buy_size_usd || 50, 0.5 * solUsd);
    const buySol = Math.min(estBuySizeUsd / solUsd, 0.5);
    const minBuyUsd = rules.min_buy_usd || 10;

    if (buySol * solUsd < minBuyUsd || rules.trade_frequency < 0.5) {
      console.log(`[skip] ${walletName}: insufficient size (${(buySol * solUsd).toFixed(2)} < $${minBuyUsd}) or low frequency (${rules.trade_frequency})`);
      return;
    }

    const mark = await this.getTokenPrice(tokenMint);
    const marketCap = await this.getMarketCap(tokenMint);
    if (marketCap > 1000000) {
      console.log(`[skip] ${walletName}: Market cap $${marketCap.toFixed(2)} > $1M`);
      return;
    }

    const buy = await this.exec.buy({ solAmount: buySol, markUsd: mark });
    let sell;

    if (hasCreated && !isCreator && tx?.tokenTransfers?.some(t => t.fromUserAccount === job.wallet)) {
      // Auto-sell if non-creator with creation history sells
      const exitPrice = mark * 0.95; // 5% below current to ensure sell
      sell = await this.exec.sell({ sizeTokens: buy.sizeTokens, targetExitUsd: exitPrice * buy.sizeTokens });
      console.log(`[auto-sell] ${walletName} | Dump detected, sold at $${sell.fillUsd.toFixed(6)}`);
    } else {
      const walletTpMultiple = rules.tp_multiple || 1.5;
      const yourBuyUsd = buySol * solUsd;
      const targetProfitUsd = 7.5;
      const scaledTpMultiple = 1 + (targetProfitUsd / yourBuyUsd) * (walletTpMultiple - 1);
      const targetTotalUsd = buy.fillUsd * Math.min(scaledTpMultiple, 2.0) * buy.sizeTokens;
      const exitUsd = exitPriceForTargetUsd({
        entryUsd: buy.fillUsd,
        sizeTokens: buy.sizeTokens,
        feeBps: cfg.feeBps,
        exitSlipBps: cfg.maxSlippageBps,
        targetUsd: targetTotalUsd,
      });

      if (tokenMint && this.priceCache[tokenMint]) {
        const momentum = (this.priceCache[tokenMint] - mark) / mark;
        if (momentum < 0.05 && momentum > -0.05) await new Promise(r => setTimeout(r, 1000));
        else if (momentum > 0.2) await new Promise(r => setTimeout(r, 5000));
      }

      sell = await this.exec.sell({ sizeTokens: buy.sizeTokens, targetExitUsd: exitUsd });
    }

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


