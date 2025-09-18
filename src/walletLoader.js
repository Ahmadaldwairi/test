import fs from 'fs';

/**
 * Loads tracked wallets from file and watches for changes.
 * Format per line:
 *   walletAddress[,WalletName][,JSON rules]
 *
 * Example:
 *   9xz123abc...,TraderAlpha,{"tp_multiple":1.4,"avg_hold_seconds":22,"min_buy_usd":150}
 *   5YZ89pqr...,CreatorBravo,{"tp_multiple":2.0,"avg_hold_seconds":15,"min_buy_usd":300}
 *
 * Returns a Map:
 *   address -> { name: string, rules: object }
 */
export function createWalletLoader(filePath, reloadMs, onUpdate) {
  let last = '';

  function load() {
    try {
      const txt = fs.readFileSync(filePath, 'utf8');
      if (txt === last) return; // no change
      last = txt;

      const lines = txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const map = new Map();

      for (const line of lines) {
        const [addr, nameRaw, rulesRaw] = line.split(',').map(s => s.trim());
        if (!addr) continue;

        let rules = {};
        if (rulesRaw) {
          try {
            rules = JSON.parse(rulesRaw);
          } catch (e) {
            console.warn(`[walletLoader] bad JSON rules for ${addr}: ${rulesRaw}`);
          }
        }

        map.set(addr, {
          name: nameRaw || addr,
          rules
        });
      }

      onUpdate(map);
    } catch (e) {
      console.error('[walletLoader] failed to read file:', e.message);
    }
  }

  load(); // initial load
  const timer = setInterval(load, reloadMs);

  return () => clearInterval(timer); // stop watching
}

