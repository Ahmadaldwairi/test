import { realizedProfitUsd } from '../math.js';

// A super-simple market model just to exercise logic.
// You can later feed real prices from raydium/pump or Jupiter quotes.
export class SimulatedAdapter {
  constructor({feeBps, maxSlippageBps}) {
    this.feeBps = feeBps;
    this.maxSlippageBps = maxSlippageBps;
    this.markUsd = 0.001; // fake starting price; replace with feed per token
  }

  // Simulate a buy: return fill price & size
  async buy({solAmount, markUsd, tokenDecimals=6}) {
    this.markUsd = markUsd ?? this.markUsd;
    const slip = this.maxSlippageBps / 10_000;
    const fill = this.markUsd * (1 + slip * 0.5); // assume we cross half the slippage
    // Assume SOLUSD ~ $150 for paper math (or pass in a SOLUSD feed)
    const solUsd = 150;
    const costUsd = solAmount * solUsd;
    const sizeTokens = costUsd / fill;
    return { fillUsd: fill, sizeTokens, costUsd };
  }

  async sell({sizeTokens, targetExitUsd}) {
    // move the mark a bit and fill slightly below target
    const slip = this.maxSlippageBps / 10_000;
    const fillUsd = targetExitUsd * (1 - slip * 0.5);
    const proceedsUsd = sizeTokens * fillUsd * (1 - this.feeBps/10_000);
    return { fillUsd, proceedsUsd };
  }

  // For console/UX
  pl({entryUsd, exitUsd, sizeTokens}) {
    return realizedProfitUsd({
      entryUsd, exitUsd, sizeTokens,
      feeBpsEntry: this.feeBps, feeBpsExit: this.feeBps
    });
  }
}
