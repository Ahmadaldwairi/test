// src/priceFeed.js
import fetch from 'node-fetch';

// SOL mint & USDC mint
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export async function getSolUsd() {
  try {
    // 1e9 lamports = 1 SOL → here we ask for 1 SOL worth of USDC
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=1000000000&slippageBps=50`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();

    if (json && json.outAmount) {
      // outAmount is in USDC's smallest unit (6 decimals)
      const usdc = Number(json.outAmount) / 1e6;
      return usdc;
    }

    throw new Error("No outAmount in Jupiter response");
  } catch (e) {
    console.warn("[priceFeed] Failed to fetch price from Jupiter:", e.message);
    return 25; // fallback
  }
}

// Inline test (only runs when you do `node src/priceFeed.js`)
if (process.argv[1].includes("priceFeed.js")) {
  (async () => {
    const price = await getSolUsd();
    console.log(`[priceFeed] Current SOL/USD: $${price}`);
  })();
}


