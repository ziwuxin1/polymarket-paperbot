import { estimateTakerFee, quoteBuy } from '../paper-ledger.js';
import { quoteSell } from './quote-sell.js';

// S0's ledger modelled an atomic round trip and never held inventory. This one
// holds positions, so it has to answer a question S0 never faced: what is an
// open position actually worth right now?
export class PositionLedger {
  constructor(startingCashUsd) {
    this.startingCashUsd = startingCashUsd;
    this.cashUsd = startingCashUsd;
    this.realizedPnlUsd = 0;
    this.positions = new Map();
    this.rejections = [];
    this.nextId = 1;
  }

  open({ market, tokenId, shares, book, source = null, timestamp = null }) {
    const quote = quoteBuy(book.asks, shares);

    if (quote.filled !== shares) {
      return this.#reject({ market, tokenId, shares, reason: 'insufficient_ask_depth', timestamp });
    }

    const entryFee = estimateTakerFee(shares, quote.averagePrice, market.feeRate);
    const cost = quote.notional + entryFee;
    if (cost > this.cashUsd) {
      return this.#reject({ market, tokenId, shares, reason: 'insufficient_paper_cash', timestamp });
    }

    this.cashUsd -= cost;
    const position = {
      id: `p${this.nextId++}`,
      status: 'open',
      marketId: market.id, market: market.question, slug: market.slug, feeRate: market.feeRate,
      tokenId, shares,
      averageCost: quote.averagePrice,
      entryNotional: quote.notional,
      entryFee,
      openedAt: timestamp,
      entryBookHash: book.hash ?? null,
      source,
    };
    this.positions.set(position.id, position);
    return position;
  }

  // The value of a position is what the bids will pay for it, less the fee that
  // selling would incur. Marking at the ask or the midpoint reports a price the
  // holder could not obtain.
  markToMarket(positionId, book) {
    const position = this.#requireOpen(positionId);
    const quote = quoteSell(book.bids, position.shares);
    const markPrice = quote.averagePrice;
    const marketValue = quote.notional;
    const costOfFilledPortion = position.averageCost * quote.filled;

    return {
      positionId,
      markPrice,
      fillableShares: quote.filled,
      unfillableShares: quote.remaining,
      marketValue,
      unrealizedPnl: marketValue - costOfFilledPortion,
    };
  }

  close({ positionId, book, reason, timestamp = null }) {
    const position = this.#requireOpen(positionId);
    const quote = quoteSell(book.bids, position.shares);

    if (quote.filled !== position.shares) {
      // Recorded, not silently converted into a full exit at a better price.
      return { status: 'unclosable', positionId, reason: 'insufficient_bid_depth', fillableShares: quote.filled };
    }

    const exitFee = estimateTakerFee(position.shares, quote.averagePrice, position.feeRate);
    const proceeds = quote.notional - exitFee;
    this.cashUsd += proceeds;

    const realizedPnl = proceeds - (position.entryNotional + position.entryFee);
    this.realizedPnlUsd += realizedPnl;

    return this.#settle(position, {
      exitPrice: quote.averagePrice, exitNotional: quote.notional, exitFee,
      realizedPnl, closeReason: reason, closedAt: timestamp,
    });
  }

  // Resolution pays the token's face value directly. It is a redemption, not a
  // taker trade, so no taker fee applies.
  redeem({ positionId, outcomeValue, timestamp = null }) {
    const position = this.#requireOpen(positionId);
    const proceeds = position.shares * outcomeValue;
    this.cashUsd += proceeds;

    const realizedPnl = proceeds - (position.entryNotional + position.entryFee);
    this.realizedPnlUsd += realizedPnl;

    return this.#settle(position, {
      exitPrice: outcomeValue, exitNotional: proceeds, exitFee: 0,
      realizedPnl, closeReason: 'resolution', closedAt: timestamp,
    });
  }

  openPositions() {
    return [...this.positions.values()].filter((position) => position.status === 'open');
  }

  // booksByToken lets the caller price open inventory. Positions with no book
  // supplied are reported as unmarked rather than assumed to be worth cost.
  summary(booksByToken = {}) {
    const open = this.openPositions();
    let unrealizedPnlUsd = 0;
    let unmarkedPositions = 0;

    for (const position of open) {
      const book = booksByToken[position.tokenId];
      if (!book) {
        unmarkedPositions += 1;
        continue;
      }
      unrealizedPnlUsd += this.markToMarket(position.id, book).unrealizedPnl;
    }

    const closed = [...this.positions.values()].filter((position) => position.status === 'closed');
    return {
      startingCashUsd: this.startingCashUsd,
      cashUsd: this.cashUsd,
      realizedPnlUsd: this.realizedPnlUsd,
      unrealizedPnlUsd,
      unmarkedPositions,
      openPositions: open.length,
      closedPositions: closed.length,
      rejections: this.rejections.length,
    };
  }

  #settle(position, outcome) {
    const closed = { ...position, status: 'closed', ...outcome };
    this.positions.set(position.id, closed);
    return closed;
  }

  #requireOpen(positionId) {
    const position = this.positions.get(positionId);
    if (!position) throw new Error(`Unknown position ${positionId}`);
    if (position.status !== 'open') throw new Error(`Position ${positionId} is already ${position.status}`);
    return position;
  }

  #reject({ market, tokenId, shares, reason, timestamp }) {
    const rejection = {
      status: 'rejected', reason,
      marketId: market.id, market: market.question, slug: market.slug,
      tokenId, shares, timestamp,
    };
    this.rejections.push(rejection);
    return rejection;
  }
}
