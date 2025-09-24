// src/analytics.js
import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_BASE = process.env.HELIUS_API_BASE || 'https://api.helius.xyz';
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

if (!HELIUS_API_KEY) {
  throw new Error('Missing HELIUS_API_KEY in .env');
}
if (!BIRDEYE_API_KEY) {
  console.warn('[analytics] Missing BIRDEYE_API_KEY in .env (price lookups may fail)');
}

let heliusRequestCount = 0;
const CACHE_FILE = 'analytics_cache.json';
const OUTPUT_FILE = 'analytics_output.json';

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// Fetch recent transactions for a wallet
async function fetchTransactions(wallet, limit = 50, beforeSig = null) {
  let url = `${HELIUS_BASE}/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=${limit}`;
  if (beforeSig) url += `&before=${beforeSig}`;

  heliusRequestCount++;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Helius API error ${res.status}`);

  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.transactions)) return data.transactions;
  return [];
}

// Fetch token price from Birdeye
async function getTokenPrice(tokenMint) {
  if (!BIRDEYE_API_KEY) return null;

  try {
    const res = await fetch(`https://api.birdeye.so/v1/token/price?address=${tokenMint}`, {
      headers: { 'x-api-key': BIRDEYE_API_KEY }
    });
    if (!res.ok) throw new Error(`Birdeye API error ${res.status}`);
    const json = await res.json();
    return json?.data?.value || null;
  } catch (e) {
    console.error(`[price] Error fetching ${tokenMint}:`, e.message);
    return null;
  }
}

// Analyze trades for a wallet
function analyzeTrades(wallet, txs) {
  if (!Array.isArray(txs)) return { wallet, buys: 0, sells: 0, avg_buy_tokens: 0, avg_sell_tokens: 0, avg_hold_seconds: 0 };

  let buys = 0, sells = 0;
  let totalBuyTokens = 0, totalSellTokens = 0;
  const holdTimes = [];

  for (const tx of txs) {
    if (!tx?.tokenTransfers) continue;

    for (const tr of tx.tokenTransfers) {
      const pre = tr.fromUserAccount;
      const post = tr.toUserAccount;
      const amt = Number(tr.tokenAmount || 0);

      if (post === wallet && amt > 0) {
        buys++;
        totalBuyTokens += amt;
      }
      if (pre === wallet && amt > 0) {
        sells++;
        totalSellTokens += amt;
      }
    }

    if (tx.timestamp) {
      holdTimes.push(tx.timestamp);
    }
  }

  const avgBuyTokens = buys ? totalBuyTokens / buys : 0;
  const avgSellTokens = sells ? totalSellTokens / sells : 0;
  let avgHoldSeconds = 0;
  if (holdTimes.length > 1) {
    const sorted = holdTimes.sort((a, b) => a - b);
    const diffs = [];
    for (let i = 1; i < sorted.length; i++) {
      diffs.push(sorted[i] - sorted[i - 1]);
    }
    avgHoldSeconds = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  }

  return {
    wallet,
    buys,
    sells,
    avg_buy_tokens: avgBuyTokens,
    avg_sell_tokens: avgSellTokens,
    avg_hold_seconds: avgHoldSeconds
  };
}

export async function main() {
  const cache = loadCache();

  const lines = fs.readFileSync('tracked_wallets.txt', 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  const results = [];

  for (const raw of lines) {
    const [wallet, nameRaw] = raw.split('|').map(s => s.trim());
    const name = nameRaw || 'unnamed';
    console.log(`[analytics] Processing wallet: ${wallet} (${name})`);

    try {
      let txs = cache[wallet];
      if (!Array.isArray(txs)) {
        txs = await fetchTransactions(wallet, 50);
        cache[wallet] = txs;
        saveCache(cache);
      } else {
        console.log(`[analytics] Using cached data for ${wallet}`);
      }

      const stats = analyzeTrades(wallet, txs);
      stats.name = name;
      results.push(stats);
    } catch (e) {
      console.error(`[analytics] Error processing wallet ${wallet}:`, e.message);
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
  console.log(`[analytics] Results saved to ${OUTPUT_FILE}`);
  console.log(`[analytics] Helius requests made: ${heliusRequestCount}`);
}

if (process.argv[1].includes('analytics.js')) {
  main();
}

