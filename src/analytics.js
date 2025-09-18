// src/analytics.js
import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_BASE = process.env.HELIUS_RPC_URL;

if (!HELIUS_API_KEY || !HELIUS_BASE) {
  throw new Error('Missing HELIUS_API_KEY or HELIUS_RPC_URL in .env');
}

let heliusRequestCount = 0;
const CACHE_FILE = 'analytics_cache.json';

// Load cache
let cache = {};
if (fs.existsSync(CACHE_FILE)) {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    cache = {};
  }
}

// Save cache
function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// Fetch transactions using Helius indexed endpoint
async function fetchTransactions(wallet) {
  const url = `${HELIUS_BASE}/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
  heliusRequestCount++;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Helius API error ${res.status}`);
  return res.json();
}

// Analyze trades (simplified for now)
function analyzeTrades(wallet, txs) {
  let buys = 0, sells = 0;
  let totalBuyTokens = 0, totalSellTokens = 0;
  const holdTimes = [];

  for (const tx of txs) {
    if (!tx?.tokenTransfers) continue;

    for (const t of tx.tokenTransfers) {
      if (t.toUserAccount === wallet) {
        buys++;
        totalBuyTokens += Number(t.tokenAmount || 0);
      } else if (t.fromUserAccount === wallet) {
        sells++;
        totalSellTokens += Number(t.tokenAmount || 0);
      }
    }

    if (tx.timestamp) {
      holdTimes.push(tx.timestamp);
    }
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

  return {
    wallet,
    buys,
    sells,
    avg_buy_tokens: buys > 0 ? totalBuyTokens / buys : 0,
    avg_sell_tokens: sells > 0 ? totalSellTokens / sells : 0,
    avg_hold_seconds: avgHoldSeconds
  };
}

export async function main() {
  const lines = fs.readFileSync('tracked_wallets.txt', 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  const results = [];

  for (const line of lines) {
    const [wallet, nameRaw] = line.split('|').map(s => s.trim());
    const name = nameRaw || 'unnamed';
    console.log(`[analytics] Processing wallet: ${wallet} (${name})`);

    try {
      let txs;
      if (cache[wallet]) {
        console.log(`[analytics] Using cached data for ${wallet}`);
        txs = cache[wallet];
      } else {
        txs = await fetchTransactions(wallet);
        cache[wallet] = txs;
        saveCache();
      }

      const stats = analyzeTrades(wallet, txs);
      stats.name = name;
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

