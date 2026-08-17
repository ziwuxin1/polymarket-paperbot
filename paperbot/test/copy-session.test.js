import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeFailure, copyGateReport, runCopySession } from '../src/copy/copy-session.js';

const config = {
  startingCashUsd: 1_000,
  assumedLatencySeconds: 5,
  sizeScale: 0.1,
  maxShares: 25,
  maxPriceDriftFromSource: 0.05,
  minSourceSizeUsd: 10,
  exitRule: 'follow_source',
};

const market = { id: 'c1', question: 'M', slug: 'm', feeRate: 0 };

const buy = (wallet, tokenId, price, timestampSeconds, size = 100) => ({
  wallet, tokenId, conditionId: 'c1', side: 'BUY', size, price, timestampSeconds,
  latencyMode: 'assumed', detectionLatencySeconds: null,
});
const sell = (wallet, tokenId, price, timestampSeconds, size = 100) => ({
  ...buy(wallet, tokenId, price, timestampSeconds, size), side: 'SELL',
});

// Book provider keyed by token, returning a flat book at a given price.
const flatBooks = (askPrice, bidPrice) => () => ({
  asks: [{ price: askPrice, size: 10_000 }],
  bids: [{ price: bidPrice, size: 10_000 }],
  hash: 'h',
});

test('a copied entry followed by a source exit produces a closed position', () => {
  const result = runCopySession({
    sourceTrades: [buy('0xa', 't1', 0.40, 1_000), sell('0xa', 't1', 0.60, 2_000)],
    marketsByCondition: { c1: market },
    bookProvider: flatBooks(0.41, 0.59),
    config,
  });

  assert.equal(result.summary.closedPositions, 1);
  assert.equal(result.summary.openPositions, 0);
  assert.ok(result.summary.realizedPnlUsd > 0);
  assert.equal(result.exits[0].reason, 'source_exited');
});

test('a source sell in a token we never copied does not invent an exit', () => {
  const result = runCopySession({
    sourceTrades: [sell('0xa', 't1', 0.60, 2_000)],
    marketsByCondition: { c1: market },
    bookProvider: flatBooks(0.41, 0.59),
    config,
  });
  assert.equal(result.summary.closedPositions, 0);
  assert.equal(result.exits.length, 0);
});

test("a source's exit does not close another wallet's copied position", () => {
  const result = runCopySession({
    sourceTrades: [buy('0xa', 't1', 0.40, 1_000), sell('0xb', 't1', 0.60, 2_000)],
    marketsByCondition: { c1: market },
    bookProvider: flatBooks(0.41, 0.59),
    config,
  });
  assert.equal(result.summary.openPositions, 1);
});

test('positions still open at the end of the corpus are reported, not quietly dropped', () => {
  const result = runCopySession({
    sourceTrades: [buy('0xa', 't1', 0.40, 1_000)],
    marketsByCondition: { c1: market },
    bookProvider: flatBooks(0.41, 0.39),
    config,
  });
  assert.equal(result.summary.openPositions, 1);
  assert.ok(result.summary.unrealizedPnlUsd < 0, 'marked on the bid side');
});

test('rejected copies are counted alongside accepted ones', () => {
  const result = runCopySession({
    // Second trade drifts 0.10 past the source price, beyond the 0.05 tolerance.
    sourceTrades: [buy('0xa', 't1', 0.40, 1_000), buy('0xa', 't2', 0.30, 2_000)],
    marketsByCondition: { c1: market },
    bookProvider: flatBooks(0.41, 0.39),
    config,
  });
  assert.equal(result.copied.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'price_drift_exceeded');
});

test('gate 1 requires breadth in wallets and markets, not just a decision count', () => {
  // 600 decisions, but all from one wallet in one market. S0 proved a large
  // decision count over a narrow universe is a false sample size.
  const narrow = copyGateReport({
    copied: Array.from({ length: 600 }, () => ({ wallet: '0xa', conditionId: 'c1' })),
    rejected: [], summary: { realizedPnlUsd: 50 }, config,
  });
  assert.equal(narrow.gate1.met, false);
  assert.equal(narrow.gate1.distinctWallets, 1);
});

test('gate 1 passes only when all three breadth thresholds are met', () => {
  const broad = copyGateReport({
    copied: Array.from({ length: 600 }, (_, i) => ({
      wallet: `0x${i % 60}`, conditionId: `c${i % 250}`,
    })),
    rejected: [], summary: { realizedPnlUsd: 50 }, config,
  });
  assert.equal(broad.gate1.met, true);
});

test('gate 2 fails unless every latency variant is profitable', () => {
  const report = copyGateReport({
    copied: [], rejected: [], summary: { realizedPnlUsd: 10 }, config,
    latencyVariants: [
      { latencyMultiplier: 1, realizedPnlUsd: 10 },
      { latencyMultiplier: 2, realizedPnlUsd: 4 },
      { latencyMultiplier: 5, realizedPnlUsd: -3 },
    ],
  });
  assert.equal(report.gate2.met, false);

  const robust = copyGateReport({
    copied: [], rejected: [], summary: { realizedPnlUsd: 10 }, config,
    latencyVariants: [
      { latencyMultiplier: 1, realizedPnlUsd: 10 },
      { latencyMultiplier: 2, realizedPnlUsd: 8 },
      { latencyMultiplier: 5, realizedPnlUsd: 2 },
    ],
  });
  assert.equal(robust.gate2.met, true);
});

test('gate 3 fails when the selection and evaluation windows overlap', () => {
  const overlapping = copyGateReport({
    copied: [], rejected: [], summary: { realizedPnlUsd: 1 }, config,
    windows: { selectionCutoff: 2_000, evaluationStart: 1_000 },
  });
  assert.equal(overlapping.gate3.met, false);

  const clean = copyGateReport({
    copied: [], rejected: [], summary: { realizedPnlUsd: 1 }, config,
    windows: { selectionCutoff: 1_000, evaluationStart: 1_000 },
  });
  assert.equal(clean.gate3.met, true);
});

test('failure attribution separates no-alpha from not-copyable from bad-exits', () => {
  assert.equal(attributeFailure({
    sourceWalletPnlUsd: -100, copyRejectRate: 0.1, entryEdgeUsd: -5, realizedPnlUsd: -20,
  }), 'no_alpha');

  assert.equal(attributeFailure({
    sourceWalletPnlUsd: 500, copyRejectRate: 0.9, entryEdgeUsd: -5, realizedPnlUsd: -20,
  }), 'not_copyable');

  assert.equal(attributeFailure({
    sourceWalletPnlUsd: 500, copyRejectRate: 0.1, entryEdgeUsd: 40, realizedPnlUsd: -20,
  }), 'exit_destroys_edge');

  assert.equal(attributeFailure({
    sourceWalletPnlUsd: 500, copyRejectRate: 0.1, entryEdgeUsd: 40, realizedPnlUsd: 30,
  }), null);
});
