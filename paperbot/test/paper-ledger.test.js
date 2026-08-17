import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperLedger, estimateTakerFee, quoteBuy } from '../src/paper-ledger.js';

test('quoteBuy consumes asks from the best price outward', () => {
  const quote = quoteBuy([{ price: 0.4, size: 2 }, { price: 0.5, size: 5 }], 4);
  assert.equal(quote.filled, 4);
  assert.equal(quote.notional, 1.8);
  assert.equal(quote.averagePrice, 0.45);
});

test('taker fee follows the Polymarket fee curve', () => {
  assert.equal(estimateTakerFee(100, 0.5, 0.07), 1.75);
});

test('complete-set trade accepts only a positive fee-aware edge', () => {
  const ledger = new PaperLedger(100);
  const market = { id: 'test', question: 'Test market', slug: 'test', feeRate: 0 };
  const yesBook = { asks: [{ price: 0.46, size: 10 }], hash: 'yes' };
  const noBook = { asks: [{ price: 0.47, size: 10 }], hash: 'no' };
  const trade = ledger.tryMergeCompleteSet({
    market, yesBook, noBook, shares: 10, assumedMergeCostUsd: 0,
    adverseSelectionBps: 0, minNetEdgePerShare: 0.01,
  });
  assert.equal(trade.status, 'filled');
  assert.ok(Math.abs(trade.netPnl - 0.7) < 1e-9);
  assert.ok(Math.abs(ledger.cashUsd - 100.7) < 1e-9);
});

test('complete-set trade rejects a gross edge erased by fees', () => {
  const ledger = new PaperLedger(100);
  const market = { id: 'test', question: 'Test market', slug: 'test', feeRate: 0.05 };
  const book = { asks: [{ price: 0.49, size: 10 }], hash: 'book' };
  const trade = ledger.tryMergeCompleteSet({
    market, yesBook: book, noBook: book, shares: 10, assumedMergeCostUsd: 0,
    adverseSelectionBps: 0, minNetEdgePerShare: 0.01,
  });
  assert.equal(trade.status, 'rejected');
  assert.equal(trade.reason, 'net_edge_below_threshold');
});
