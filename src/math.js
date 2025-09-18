// Very simple models for v1. We treat price and slippage parametrically.
// You can replace with real pool math later.

export function applyBps(x, bps) {
  return x * (1 + bps / 10_000);
}
export function feeOut(x, bps) {
  return x * (1 - bps / 10_000);
}

// Given entry price (USD per token), feeBps, slippageBps, and target +$profit,
// compute the exit price needed to realize target dollars on size.
export function exitPriceForTargetUsd({entryUsd, sizeTokens, feeBps, exitSlipBps, targetUsd}) {
  // Proceeds after fees ≈ (price * size) * (1 - fee) * (1 - slip)
  // We solve for price such that proceeds - cost = targetUsd
  const netFactor = (1 - feeBps/10_000) * (1 - exitSlipBps/10_000);
  const cost = entryUsd * sizeTokens; // ignore entry fees for v1 simplicity (or add if you prefer)
  const needed = cost + targetUsd;
  const price = needed / (sizeTokens * netFactor);
  return price;
}

// Quick P/L calc
export function realizedProfitUsd({entryUsd, exitUsd, sizeTokens, feeBpsEntry=0, feeBpsExit=0}) {
  const cost = (entryUsd * sizeTokens) * (1 + feeBpsEntry/10_000);
  const proceeds = (exitUsd * sizeTokens) * (1 - feeBpsExit/10_000);
  return proceeds - cost;
}
