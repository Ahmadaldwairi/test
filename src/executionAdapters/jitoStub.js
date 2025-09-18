// Skeleton to swap in real transaction building & Jito bundles later.
// Keep the same interface as SimulatedAdapter so bot.js doesn’t change.

export class JitoAdapter {
  constructor({connection, jitoRpcUrl, feeBps, maxSlippageBps, signer}) {
    this.connection = connection;
    this.jitoRpcUrl = jitoRpcUrl;
    this.feeBps = feeBps;
    this.maxSlippageBps = maxSlippageBps;
    this.signer = signer;
  }

  async buy({solAmount, markUsd}) {
    // TODO: Build swap tx (e.g., via Jupiter or direct Raydium), sign, bundle, send to Jito.
    // Return actual fill price and size from confirmation.
    throw new Error('JitoAdapter.buy not implemented yet');
  }

  async sell({sizeTokens, targetExitUsd}) {
    // TODO: Build and submit sell tx via Jito.
    throw new Error('JitoAdapter.sell not implemented yet');
  }
}
