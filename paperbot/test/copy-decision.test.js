import test from 'node:test';
import assert from 'node:assert/strict';
import { decideCopy } from '../src/copy/copy-decision.js';

const sourceTrade = {
  wallet: '0xabc', tokenId: 't1', conditionId: 'c1', side: 'BUY',
  size: 100, price: 0.40, timestampSeconds: 1_700_000_000,
  latencyMode: 'assumed', detectionLatencySeconds: null,
};

const config = {
  assumedLatencySeconds: 5,
  sizeScale: 0.1,
  maxShares: 25,
  maxPriceDriftFromSource: 0.05,
  minSourceSizeUsd: 10,
};

const book = (asks) => ({ asks, bids: [], hash: 'h' });

test('the copy is priced from the follower book, never from the source fill price', () => {
  // The source got 0.40. By the time the follower sees it the book is at 0.43.
  // Recording 0.40 as the copy price is the single most common way a
  // copy-trading backtest lies about itself.
  const decision = decideCopy({
    sourceTrade, book: book([{ price: 0.43, size: 500 }]), config, cashUsd: 1_000,
  });

  assert.equal(decision.status, 'copy');
  assert.equal(decision.copyPrice, 0.43);
  assert.equal(decision.sourcePrice, 0.40);
  assert.ok(Math.abs(decision.slippageVsSource - 0.03) < 1e-9);
});

test('a copy is sized from the follower budget, not the source position size', () => {
  const decision = decideCopy({
    sourceTrade: { ...sourceTrade, size: 50_000 },
    book: book([{ price: 0.4, size: 100_000 }]), config, cashUsd: 1_000,
  });
  assert.equal(decision.shares, config.maxShares);
});

test('size scales with the source trade until the cap binds', () => {
  const decision = decideCopy({
    sourceTrade: { ...sourceTrade, size: 100 },
    book: book([{ price: 0.4, size: 500 }]), config, cashUsd: 1_000,
  });
  assert.equal(decision.shares, 10); // 100 * 0.1
});

test('a copy is rejected when the price has already run past the tolerance', () => {
  const decision = decideCopy({
    sourceTrade, book: book([{ price: 0.50, size: 500 }]), config, cashUsd: 1_000,
  });
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.reason, 'price_drift_exceeded');
  assert.ok(Math.abs(decision.slippageVsSource - 0.10) < 1e-9);
});

test('a copy the book cannot fill at the intended size is rejected, never partially filled', () => {
  const decision = decideCopy({
    sourceTrade, book: book([{ price: 0.41, size: 2 }]), config, cashUsd: 1_000,
  });
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.reason, 'insufficient_ask_depth');
});

test('a source trade too small to be meaningful is rejected', () => {
  const decision = decideCopy({
    sourceTrade: { ...sourceTrade, size: 5, price: 0.4 }, // $2 notional
    book: book([{ price: 0.4, size: 500 }]), config, cashUsd: 1_000,
  });
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.reason, 'source_trade_too_small');
});

test('a sell by the source is not an entry signal', () => {
  const decision = decideCopy({
    sourceTrade: { ...sourceTrade, side: 'SELL' },
    book: book([{ price: 0.4, size: 500 }]), config, cashUsd: 1_000,
  });
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.reason, 'not_an_entry');
});

test('a copy beyond the cash balance is rejected', () => {
  const decision = decideCopy({
    sourceTrade, book: book([{ price: 0.4, size: 500 }]), config, cashUsd: 1,
  });
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.reason, 'insufficient_paper_cash');
});

test('the decision records which latency it was judged under, and whether it was measured', () => {
  const assumed = decideCopy({
    sourceTrade, book: book([{ price: 0.41, size: 500 }]), config, cashUsd: 1_000,
  });
  assert.equal(assumed.latencyMode, 'assumed');
  assert.equal(assumed.latencySeconds, 5);

  const measured = decideCopy({
    sourceTrade: { ...sourceTrade, latencyMode: 'measured', detectionLatencySeconds: 12 },
    book: book([{ price: 0.41, size: 500 }]), config, cashUsd: 1_000,
  });
  assert.equal(measured.latencyMode, 'measured');
  assert.equal(measured.latencySeconds, 12);
});

test('a latency multiplier scales the assumed latency for robustness runs', () => {
  const decision = decideCopy({
    sourceTrade, book: book([{ price: 0.41, size: 500 }]),
    config: { ...config, latencyMultiplier: 5 }, cashUsd: 1_000,
  });
  assert.equal(decision.latencySeconds, 25);
});
