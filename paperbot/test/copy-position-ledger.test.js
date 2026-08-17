import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteSell } from '../src/copy/quote-sell.js';
import { PositionLedger } from '../src/copy/position-ledger.js';

const market = { id: 'm1', question: 'Test market', slug: 'm1', feeRate: 0 };
const book = (levels) => ({ bids: levels.bids ?? [], asks: levels.asks ?? [], hash: 'h' });

test('quoteSell consumes bids from the highest price downward', () => {
  const quote = quoteSell([{ price: 0.6, size: 2 }, { price: 0.5, size: 5 }], 4);
  assert.equal(quote.filled, 4);
  assert.equal(quote.notional, 2 * 0.6 + 2 * 0.5);
  assert.equal(quote.averagePrice, 0.55);
  assert.equal(quote.remaining, 0);
});

test('quoteSell reports the shortfall when the bid side is too thin', () => {
  const quote = quoteSell([{ price: 0.6, size: 1 }], 5);
  assert.equal(quote.filled, 1);
  assert.equal(quote.remaining, 4);
});

test('opening a position moves cash by notional plus fee', () => {
  const ledger = new PositionLedger(100);
  const position = ledger.open({
    market, tokenId: 't1', shares: 10,
    book: book({ asks: [{ price: 0.4, size: 50 }] }),
    source: { wallet: '0xabc', tradeId: 'tr1' },
  });

  assert.equal(position.status, 'open');
  assert.equal(position.shares, 10);
  assert.equal(position.averageCost, 0.4);
  assert.ok(Math.abs(ledger.cashUsd - 96) < 1e-9);
  assert.equal(position.source.wallet, '0xabc');
});

test('a position is marked against the bid side, never the ask or the midpoint', () => {
  // Asks at 0.90 with bids at 0.30 is a wide book. Marking anywhere but the bid
  // claims a value the position could not actually be sold for.
  const ledger = new PositionLedger(100);
  const position = ledger.open({
    market, tokenId: 't1', shares: 10,
    book: book({ asks: [{ price: 0.5, size: 50 }] }),
  });

  const mark = ledger.markToMarket(position.id, book({
    bids: [{ price: 0.3, size: 50 }], asks: [{ price: 0.9, size: 50 }],
  }));

  assert.equal(mark.markPrice, 0.3);
  assert.ok(Math.abs(mark.marketValue - 3) < 1e-9);
  assert.ok(Math.abs(mark.unrealizedPnl - -2) < 1e-9);
});

test('marking a position the book cannot absorb prices only what it can absorb', () => {
  const ledger = new PositionLedger(100);
  const position = ledger.open({
    market, tokenId: 't1', shares: 10,
    book: book({ asks: [{ price: 0.5, size: 50 }] }),
  });

  const mark = ledger.markToMarket(position.id, book({ bids: [{ price: 0.4, size: 3 }] }));

  assert.equal(mark.fillableShares, 3);
  assert.equal(mark.unfillableShares, 7);
});

test('closing charges a fee on the exit as well as the entry', () => {
  const ledger = new PositionLedger(100);
  const feeMarket = { ...market, feeRate: 0.05 };
  const position = ledger.open({
    market: feeMarket, tokenId: 't1', shares: 100,
    book: book({ asks: [{ price: 0.5, size: 500 }] }),
  });
  const entryFee = position.entryFee;
  assert.ok(entryFee > 0, 'entry must be charged');

  const closed = ledger.close({
    positionId: position.id,
    book: book({ bids: [{ price: 0.5, size: 500 }] }),
    reason: 'test',
  });

  assert.ok(closed.exitFee > 0, 'exit must be charged');
  assert.ok(Math.abs(closed.exitFee - entryFee) < 1e-9, 'same price and size means the same fee');
  // Round trip at an unchanged price loses exactly both fees.
  assert.ok(Math.abs(closed.realizedPnl - -(entryFee + exitFeeOf(closed))) < 1e-9);
});

const exitFeeOf = (closed) => closed.exitFee;

test('realized and unrealized pnl are never folded into one number', () => {
  const ledger = new PositionLedger(100);
  const held = ledger.open({
    market, tokenId: 'held', shares: 10, book: book({ asks: [{ price: 0.4, size: 50 }] }),
  });
  const flipped = ledger.open({
    market, tokenId: 'flipped', shares: 10, book: book({ asks: [{ price: 0.4, size: 50 }] }),
  });
  ledger.close({
    positionId: flipped.id, book: book({ bids: [{ price: 0.5, size: 50 }] }), reason: 'test',
  });

  const summary = ledger.summary({ [held.tokenId]: book({ bids: [{ price: 0.9, size: 50 }] }) });

  assert.ok(Math.abs(summary.realizedPnlUsd - 1) < 1e-9);
  assert.ok(Math.abs(summary.unrealizedPnlUsd - 5) < 1e-9);
  assert.equal(summary.openPositions, 1);
  assert.equal(summary.closedPositions, 1);
});

test('redeeming at resolution pays 1 for a winner and 0 for a loser, with no exit fee', () => {
  const ledger = new PositionLedger(100);
  const winner = ledger.open({
    market, tokenId: 'w', shares: 10, book: book({ asks: [{ price: 0.4, size: 50 }] }),
  });
  const loser = ledger.open({
    market, tokenId: 'l', shares: 10, book: book({ asks: [{ price: 0.4, size: 50 }] }),
  });

  const won = ledger.redeem({ positionId: winner.id, outcomeValue: 1 });
  const lost = ledger.redeem({ positionId: loser.id, outcomeValue: 0 });

  assert.ok(Math.abs(won.realizedPnl - 6) < 1e-9);
  assert.ok(Math.abs(lost.realizedPnl - -4) < 1e-9);
  assert.equal(won.exitFee, 0, 'redemption is not a taker trade');
});

test('a position the cash balance cannot fund is rejected, not silently opened', () => {
  const ledger = new PositionLedger(1);
  const rejected = ledger.open({
    market, tokenId: 't1', shares: 10, book: book({ asks: [{ price: 0.4, size: 50 }] }),
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'insufficient_paper_cash');
  assert.equal(ledger.cashUsd, 1);
});

test('a book too thin for the requested size is rejected, never partially filled', () => {
  const ledger = new PositionLedger(100);
  const rejected = ledger.open({
    market, tokenId: 't1', shares: 10, book: book({ asks: [{ price: 0.4, size: 3 }] }),
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'insufficient_ask_depth');
});
