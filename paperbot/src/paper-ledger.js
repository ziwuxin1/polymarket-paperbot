export function estimateTakerFee(shares, price, feeRate) {
  // Polymarket rounds protocol fees to five decimal places.
  return Math.round(shares * feeRate * price * (1 - price) * 100_000) / 100_000;
}

export function quoteBuy(asks, requestedShares) {
  let remaining = requestedShares;
  let filled = 0;
  let notional = 0;
  let fee = 0;

  for (const level of asks) {
    if (remaining <= 0) break;
    const shares = Math.min(remaining, level.size);
    filled += shares;
    notional += shares * level.price;
    remaining -= shares;
  }

  return { filled, notional, averagePrice: filled ? notional / filled : null, remaining };
}

export class PaperLedger {
  constructor(startingCashUsd) {
    this.startingCashUsd = startingCashUsd;
    this.cashUsd = startingCashUsd;
    this.realizedPnlUsd = 0;
    this.trades = [];
  }

  tryMergeCompleteSet({ market, yesBook, noBook, shares, assumedMergeCostUsd, adverseSelectionBps, minNetEdgePerShare }) {
    const yes = quoteBuy(yesBook.asks, shares);
    const no = quoteBuy(noBook.asks, shares);
    const stamp = new Date().toISOString();

    if (yes.filled !== shares || no.filled !== shares) {
      return this.#recordRejected({ market, shares, stamp, reason: 'insufficient_top_of_book_depth', yes, no });
    }

    const yesFee = estimateTakerFee(shares, yes.averagePrice, market.feeRate);
    const noFee = estimateTakerFee(shares, no.averagePrice, market.feeRate);
    const adverseSelectionCost = (yes.notional + no.notional) * adverseSelectionBps / 10_000;
    const totalCost = yes.notional + no.notional + yesFee + noFee + assumedMergeCostUsd + adverseSelectionCost;
    const payout = shares;
    const netPnl = payout - totalCost;
    const netEdgePerShare = netPnl / shares;

    if (netEdgePerShare < minNetEdgePerShare) {
      return this.#recordRejected({
        market, shares, stamp, reason: 'net_edge_below_threshold', yes, no,
        netEdgePerShare, totalCost,
      });
    }
    if (totalCost > this.cashUsd) {
      return this.#recordRejected({ market, shares, stamp, reason: 'insufficient_paper_cash', yes, no, totalCost });
    }

    this.cashUsd += netPnl;
    this.realizedPnlUsd += netPnl;
    const trade = {
      type: 'paired_complete_set_arbitrage', status: 'filled', timestamp: stamp,
      marketId: market.id, market: market.question, slug: market.slug, shares,
      yesAveragePrice: yes.averagePrice, noAveragePrice: no.averagePrice,
      feeRate: market.feeRate, yesFee, noFee, assumedMergeCostUsd, adverseSelectionCost,
      totalCost, payout, netPnl, netEdgePerShare, cashAfter: this.cashUsd,
      orderbookHashes: { yes: yesBook.hash, no: noBook.hash },
    };
    this.trades.push(trade);
    return trade;
  }

  summary() {
    const filled = this.trades.filter((trade) => trade.status === 'filled');
    return {
      startingCashUsd: this.startingCashUsd,
      cashUsd: this.cashUsd,
      realizedPnlUsd: this.realizedPnlUsd,
      filledTrades: filled.length,
      rejectedSignals: this.trades.length - filled.length,
    };
  }

  #recordRejected(payload) {
    const trade = { type: 'paired_complete_set_arbitrage', status: 'rejected', ...payload };
    this.trades.push(trade);
    return trade;
  }
}
