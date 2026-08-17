import { quoteBuy } from '../paper-ledger.js';

// The follower's entry price comes from walking the follower's own book at the
// moment the follower could have acted — never from the source's fill price.
// Copying the source's price is the defining mistake of copy-trading backtests:
// it silently assumes zero latency and infinite depth.
export function decideCopy({ sourceTrade, book, config, cashUsd }) {
  const latencySeconds = effectiveLatency(sourceTrade, config);
  const base = {
    wallet: sourceTrade.wallet,
    tokenId: sourceTrade.tokenId,
    conditionId: sourceTrade.conditionId,
    sourcePrice: sourceTrade.price,
    sourceSize: sourceTrade.size,
    sourceTimestampSeconds: sourceTrade.timestampSeconds,
    latencyMode: sourceTrade.latencyMode,
    latencySeconds,
  };

  if (sourceTrade.side !== 'BUY') return reject(base, 'not_an_entry');

  if (sourceTrade.size * sourceTrade.price < config.minSourceSizeUsd) {
    return reject(base, 'source_trade_too_small');
  }

  const shares = Math.min(sourceTrade.size * config.sizeScale, config.maxShares);
  const quote = quoteBuy(book.asks, shares);
  if (quote.filled !== shares) return reject({ ...base, shares }, 'insufficient_ask_depth');

  const slippageVsSource = quote.averagePrice - sourceTrade.price;
  const priced = {
    ...base,
    shares,
    copyPrice: quote.averagePrice,
    notional: quote.notional,
    slippageVsSource,
    bookHash: book.hash ?? null,
  };

  if (slippageVsSource > config.maxPriceDriftFromSource) {
    return reject(priced, 'price_drift_exceeded');
  }
  if (quote.notional > cashUsd) return reject(priced, 'insufficient_paper_cash');

  return { status: 'copy', ...priced };
}

// Robustness runs multiply the latency to ask whether the edge survives a
// follower who is slower than this one.
function effectiveLatency(sourceTrade, config) {
  const multiplier = config.latencyMultiplier ?? 1;
  const base = sourceTrade.latencyMode === 'measured'
    ? sourceTrade.detectionLatencySeconds
    : config.assumedLatencySeconds;
  return base * multiplier;
}

const reject = (payload, reason) => ({ status: 'rejected', reason, ...payload });
