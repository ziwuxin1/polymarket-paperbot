import { estimateTakerFee, quoteBuy } from '../paper-ledger.js';

// The bet is not "the model says yes". It is that the model's probability
// exceeds the price you can actually pay, by more than the cost of being wrong.
export function decideForecastTrade({ modelProbability, books, config, cashUsd }) {
  const shares = config.maxShares;

  const candidates = [
    { side: 'YES', book: books.yes, payoutProbability: modelProbability },
    { side: 'NO', book: books.no, payoutProbability: 1 - modelProbability },
  ];

  let best = null;
  let depthFailures = 0;

  for (const candidate of candidates) {
    const quote = quoteBuy(candidate.book?.asks ?? [], shares);
    if (quote.filled !== shares) {
      depthFailures += 1;
      continue;
    }

    // Cost per share: the executable price, plus fee, plus a buffer for being
    // the one who wanted this trade.
    const fee = estimateTakerFee(shares, quote.averagePrice, config.feeRate ?? 0);
    const adverse = quote.notional * (config.adverseSelectionBps ?? 0) / 10_000;
    const costPerShare = (quote.notional + fee + adverse) / shares;
    const netEdge = candidate.payoutProbability - costPerShare;

    const priced = {
      side: candidate.side,
      entryPrice: quote.averagePrice,
      shares,
      notional: quote.notional,
      fee,
      adverseSelectionCost: adverse,
      costPerShare,
      modelProbability,
      payoutProbability: candidate.payoutProbability,
      netEdge,
      bookHash: candidate.book?.hash ?? null,
    };
    if (!best || netEdge > best.netEdge) best = priced;
  }

  if (!best) return { status: 'rejected', reason: 'insufficient_ask_depth', modelProbability };
  if (best.netEdge < config.minNetEdge) return { status: 'rejected', reason: 'edge_below_threshold', ...best };
  if (best.notional > cashUsd) return { status: 'rejected', reason: 'insufficient_paper_cash', ...best };

  return { status: 'trade', depthFailures, ...best };
}
