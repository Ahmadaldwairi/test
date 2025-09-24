// src/priceFeed.js
import fetch from 'node-fetch';
import fs from 'fs';

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PRICE_FILE = 'sol_price.json';

export async function getSolUsd() {
  try {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=1000000000&slippageBps=50`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();

    if (json && json.outAmount) {
      const usdc = Number(json.outAmount) / 1e6;
      return usdc;
    }

    throw new Error("No outAmount in Jupiter response");
  } catch (e) {
    console.warn("[priceFeed] Failed to fetch price from Jupiter:", e.message);
    return 25; // fallback
  }
}

// Write price to JSON file
async function updatePriceFile() {
  const price = await getSolUsd();
  const data = { price, timestamp: new Date().toISOString() };
  fs.writeFileSync(PRICE_FILE, JSON.stringify(data, null, 2));
  console.log(`[priceFeed] Updated ${PRICE_FILE} with SOL/USD: $${price} at ${data.timestamp}`);
}

// Periodic update (e.g., every 5 minutes)
if (process.argv[1].includes("priceFeed.js")) {
  updatePriceFile(); // Initial update
  setInterval(updatePriceFile, 60 * 1000); // Update every 5 minutes
}


