export class SessionLog {
  constructor() {
    this.trades = []; // {id, side, base, quote, costUsd, proceedsUsd, realizedUsd}
    this.nextId = 1;
  }
  newTrade(meta) {
    const t = { id: this.nextId++, ...meta };
    this.trades.push(t);
    return t;
  }
  summary() {
    const count = this.trades.length;
    const invested = this.trades.reduce((s,t)=> s + (t.costUsd ?? 0), 0);
    const realized = this.trades.reduce((s,t)=> s + (t.realizedUsd ?? 0), 0);
    return { count, invested, realized };
  }
}
