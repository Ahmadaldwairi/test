// src/analytics.js
import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_BASE = process.env.HELIUS_RPC_URL;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

if (!HELIUS_API_KEY || !HELIUS_BASE || !BIRDEYE_API_KEY) {
  throw new Error('Missing HELIUS_API_KEY, HELIUS_RPC_URL, or BIRDEYE_API_KEY in .env');
}

let heliusRequestCount = 0;
const CACHE_FILE = 'analytics_cache.json';
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dk3FywbjC4tSpPxa1G2EvDRo1ZHt91';

// Load cache
let cache = {};
if (fs.existsSync(CACHE_FILE)) {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    cache = {};
  }
}

// Save cache with TTL
function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// Fetch transactions with retry and header-based auth
async function fetchTransactions(wallet, retries = 3) {
  const url = `${HELIUS_BASE.replace(/\?.*$/, '')}/v0/addresses/${wallet}/transactions?limit=50&source=${PUMP_FUN_PROGRAM}`;
  for (let attempt = 0; attempt < retries; attempt++) {
    heliusRequestCount++;
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${HELIUS_API_KEY}` },
      });
      if (!res.ok) {
        const errorText = await res.text();
        console.error(`[fetch] Helius API error ${res.status} for ${wallet}: ${errorText}`);
        if (res.status === 429) await new Promise(r => setTimeout(r, 1000 * (2 ** attempt))); // Exponential backoff for rate limits
        else throw new Error(`Helius API error ${res.status}`);
      }
      return res.json();
    } catch (e) {
      if (attempt === retries - 1) throw e;
      console.warn(`[fetch] Retry ${attempt + 1}/${retries} for ${wallet} due to: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000 * (2 ** attempt))); // Backoff
    }
  }
}

// Check if wallet created a Pump.fun token
async function isCreatorWallet(wallet, txs) {
  for (const tx of txs) {
    if (tx.type === 'CREATE' && tx.source === PUMP_FUN_PROGRAM && tx.accounts?.includes(wallet)) {
      return true;
    }
  }
  return false;
}

// Check rug risk via Solscan
async function checkRugRisk(tokenMint) {
  try {
    const res = await fetch(`https://api.solscan.io/token/holders?token=${tokenMint}`);
    const data = await res.json();
    return data.result?.[0]?.amount / data.totalSupply < 0.2; // Safe if top holder <20%
  } catch {
    return false; // Assume risky if API fails
  }
}

// Get token price via Birdeye
async function getTokenPrice(tokenMint) {
  try {
    const res = await fetch(`https://api.birdeye.so/v1/token/price?address=${tokenMint}&api-key=${BIRDEYE_API_KEY}`);
    const data = await res.json();
    return data?.data?.price || 0.001; // Fallback for sim
  } catch (e) {
    console.error(`[birdeye] Error fetching price for ${tokenMint}: ${e.message}`);
    return 0.001;
  }
}

// Estimate Solana priority fees
async function estimateFees() {
  try {
    const res = await fetch(`${HELIUS_BASE.replace(/\?.*$/, '')}/priority-fee`, {
      headers: { 'Authorization': `Bearer ${HELIUS_API_KEY}` },
    });
    const data = await res.json();
    return data?.priorityFeeLevels?.medium || 0.015; // Default 0.015 SOL
  } catch {
    return 0.015;
  }
}

// Analyze trades
async function analyzeTrades(wallet, txs) {
  let buys = 0, sells = 0, totalProfit = 0;
  let totalBuyTokens = 0, totalSellTokens = 0;
  const holdTimes = [];
  const isCreator = await isCreatorWallet(wallet, txs);
  const fees = await estimateFees();

  for (const tx of txs) {
    if (!tx?.tokenTransfers) continue;

    for (const t of tx.tokenTransfers) {
      const price = await getTokenPrice(t.mint);
      if (t.toUserAccount === wallet) {
        buys++;
        totalBuyTokens += Number(t.tokenAmount || 0);
        totalProfit -= Number(t.tokenAmount) * price; // Cost
      } else if (t.fromUserAccount === wallet) {
        sells++;
        totalSellTokens += Number(t.tokenAmount || 0);
        totalProfit += Number(t.tokenAmount) * price; // Revenue
      }
    }

    if (tx.timestamp) holdTimes.push(tx.timestamp);
  }

  let avgHoldSeconds = 0;
  if (holdTimes.length > 1) {
    const sorted = holdTimes.sort((a, b) => a - b);
    const diffs = [];
    for (let i = 1; i < sorted.length; i++) {
      diffs.push(sorted[i] - sorted[i - 1]);
    }
    avgHoldSeconds = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  }

  // Calculate buy size for $5 profit at 2x return
  const solUsd = 140; // Replace with priceFeed.js
  const targetProfit = 5;
  const expectedReturn = totalProfit > 0 ? totalProfit / totalBuyTokens : 2;
  const buySizeUsd = (targetProfit + fees * solUsd * 2) / (expectedReturn - 0.05); // 5% slippage

  return {
    wallet,
    isCreator,
    buys,
    sells,
    avg_buy_tokens: buys > 0 ? totalBuyTokens / buys : 0,
    avg_sell_tokens: sells > 0 ? totalSellTokens / sells : 0,
    avg_hold_seconds: avgHoldSeconds,
    avg_profit_usd: buys > 0 ? totalProfit / buys : 0,
    success_rate: sells > 0 ? (sells / (buys + sells)) * 100 : 0,
    est_fees_sol: fees,
    est_buy_size_usd: buySizeUsd,
  };
}

export async function main() {
  const lines = fs.readFileSync('tracked_wallets.txt', 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  const wallets = lines.map(line => line.split('|')[0].trim());
  const results = [];

  // Individual fetches with fallback logic
  for (const line of lines) {
    const [wallet, nameRaw] = line.split('|').map(s => s.trim());
    const name = nameRaw || 'unnamed';
    console.log(`[analytics] Processing wallet: ${wallet} (${name})`);

    try {
      let txs;
      if (cache[wallet]?.timestamp > Date.now() - 24 * 60 * 60 * 1000) {
        console.log(`[analytics] Using cached data for ${wallet}`);
        txs = cache[wallet].data;
      } else {
        txs = await fetchTransactions(wallet);
        cache[wallet] = { data: txs, timestamp: Date.now() };
        saveCache();
      }

      const stats = await analyzeTrades(wallet, txs);
      stats.name = name;
      if (stats.isCreator) {
        const tokenMint = txs.find(tx => tx.type === 'CREATE')?.accounts?.[1];
        if (tokenMint) stats.isRugSafe = await checkRugRisk(tokenMint);
      }
      results.push(stats);
    } catch (e) {
      console.error(`[analytics] Error processing wallet ${wallet}:`, e.message);
    }
  }

  // Save results
  fs.writeFileSync('analytics_output.json', JSON.stringify(results, null, 2));
  console.log('[analytics] Results saved to analytics_output.json');
  console.log(`[analytics] Helius requests made: ${heliusRequestCount}`);
}

if (process.argv[1].includes('analytics.js')) {
  main();
}
