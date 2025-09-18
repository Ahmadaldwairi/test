// src/executionAdapters/simulated_v2.js
import fetch from "node-fetch";
import fs from "fs";

export default class SimulatedAdapterV2 {
  /**
   * opts:
   *   feeBps - protocol fee in bps (e.g. 60 = 0.6%)
   *   liquidityTokens - modelled token liquidity depth (bigger -> less price impact)
   *   initTokenPriceUsd - starting token price in USD (optional)
   *   priceVolatility - % per tick (0.002 = 0.2%)
   *   priceTickMs - how often price walker updates
   */
  constructor(opts = {}) {
    this.feeBps = opts.feeBps ?? 60;
    this.liquidityTokens = opts.liquidityTokens ?? 1000000; // virtual liquidity (tokens)
    this.tokenPriceUsd = opts.initTokenPriceUsd ?? 0.001; // starting price (USD)
    this.priceVolatility = opts.priceVolatility ?? 0.002;
    this.priceTickMs = opts.priceTickMs ?? 1000;
    this.solUsd = 0;
    this._startPriceWalker();
    this._ensureCsv();
  }

  async _ensureCsv() {
    if (!fs.existsSync("trades.csv")) {
      fs.writeFileSync("trades.csv", "ts,wallet,side,tokenPriceUsd,solAmount,sizeTokens,costUsd,proceedsUsd,realizedUsd\n");
    }
  }

  // keep SOL/USD live via CoinGecko (refresh every 15s)
  async _updateSolUsd() {
    try {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
      const json = await res.json();
      if (json && json.solana && json.solana.usd) {
        this.solUsd = json.solana.usd;
      }
    } catch (e) {
      // ignore network errors; keep last price
    }
    setTimeout(()=>this._updateSolUsd(), 15000);
  }

  // small random walk for token price (so chart moves)
  _startPriceWalker() {
    // start SOL price fetch
    this._updateSolUsd().catch(()=>{});
    setInterval(() => {
      // gaussian-ish step
      const rand = (Math.random() - 0.5) * 2;
      const pct = rand * this.priceVolatility;
      // occasional jump
      if (Math.random() < 0.01) {
        const jump = (Math.random() - 0.5) * 0.2; // +/-20%
        this.tokenPriceUsd *= (1 + jump);
      } else {
        this.tokenPriceUsd *= (1 + pct);
      }
      // keep price sensible
      if (this.tokenPriceUsd <= 1e-12) this.tokenPriceUsd = 1e-6;
    }, this.priceTickMs);
  }

  // compute price impact & tokens received for a buy amount in USD
  // we use a simple CPMM-like approximation:
  // newPrice = price * (1 + sizeTokens / liquidityTokens)
  // solve sizeTokens from USD amount: sizeTokens ≈ (usd / price) adjusted by impact iteratively
  _computeBuy(sizeUsd) {
    // naive initial estimate of tokens without impact
    let tokens = sizeUsd / this.tokenPriceUsd;
    // iterative adjust: price increases as tokens are bought
    // effective price for tokens ≈ tokenPrice * (1 + tokens / (2*liquidity)) (approx average)
    const avgImpactFactor = 1 + tokens / (2 * this.liquidityTokens);
    const effectivePrice = this.tokenPriceUsd * avgImpactFactor;
    const costUsd = tokens * effectivePrice;
    // adjust tokens so costUsd ~= requested sizeUsd
    const adjustment = sizeUsd / costUsd;
    tokens *= adjustment;
    const newAvgImpactFactor = 1 + tokens / (2 * this.liquidityTokens);
    const fillPriceUsd = this.tokenPriceUsd * newAvgImpactFactor; // average fill price
    return { tokens, fillPriceUsd };
  }

  // buy: solAmount (SOL) is input; markUsd is reference market price per token for logging
  async buy({ solAmount = 0.01, markUsd = null }) {
    // ensure solUsd available
    const solUsd = this.solUsd || 20; // fallback
    const sizeUsd = solAmount * solUsd;

    // compute tokens and price impact
    const { tokens, fillPriceUsd } = this._computeBuy(sizeUsd);

    // apply protocol fees on USD (just take fee from USD spent)
    const feeUsd = (sizeUsd * this.feeBps) / 10000;
    const costUsd = sizeUsd + feeUsd; // user pays fees on top
    // tokens actually received after fee - assume fee paid in USD not tokens for simplicity
    const sizeTokens = tokens;

    // record the *trade timestamped at current tokenPriceUsd*, and produce a "fillUsd"
    const fillUsd = fillPriceUsd; // USD per token average for fill
    const result = {
      sizeTokens,
      fillUsd,
      costUsd,
      // convenience fields
      costSol: solAmount,
      costUsdNoFee: sizeUsd,
    };

    // append to trades.csv as a buy placeholder (the bot will also log sells)
    return result;
  }

  // sell: targetExitUsd is price per token the bot wants; we'll compute proceeds based on current tokenPriceUsd
  async sell({ sizeTokens = 0, targetExitUsd = null }) {
    // selling reduces price slightly (opposite impact)
    // approximate proceeds = sizeTokens * (tokenPriceUsd * (1 - tokens/(2*liquidity)))
    const avgImpactFactor = 1 - sizeTokens / (2 * this.liquidityTokens);
    const fillPriceUsd = this.tokenPriceUsd * Math.max(avgImpactFactor, 0.000001);
    const proceedsUsdNoFee = sizeTokens * fillPriceUsd;
    const feeUsd = (proceedsUsdNoFee * this.feeBps) / 10000;
    const proceedsUsd = proceedsUsdNoFee - feeUsd;

    return {
      sizeTokens,
      fillUsd: fillPriceUsd,
      proceedsUsd,
    };
  }
}
