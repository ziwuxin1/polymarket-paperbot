import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWallets, walletStats } from '../src/copy/wallet-selection.js';

const CUTOFF = 1_700_000_000;

// timestamp is unix seconds, matching /closed-positions.
const closed = (realizedPnl, timestamp, totalBought = 500, conditionId = 'c1') =>
  ({ realizedPnl, timestamp, totalBought, conditionId });

const rules = {
  selectionCutoff: CUTOFF,
  minResolvedPositions: 3,
  minMedianPositionUsd: 100,
  minDistinctMarkets: 2,
};

test('selection ignores everything at or after the cutoff', () => {
  // Three losses before the cutoff, one huge win after. A wallet that looks good
  // only because of post-cutoff data must not be selected on it.
  const stats = walletStats({
    closedPositions: [
      closed(-10, CUTOFF - 300, 500, 'a'),
      closed(-10, CUTOFF - 200, 500, 'b'),
      closed(-10, CUTOFF - 100, 500, 'c'),
      closed(9_999, CUTOFF + 100, 500, 'd'),
    ],
    selectionCutoff: CUTOFF,
  });

  assert.equal(stats.resolvedPositions, 3);
  assert.equal(stats.totalPnl, -30);
});

test('a wallet with too few resolved positions is rejected as unproven', () => {
  const { selected, rejected } = selectWallets({
    candidates: [{ wallet: '0xa', closedPositions: [closed(50, CUTOFF - 10, 500, 'a'), closed(50, CUTOFF - 20, 500, 'b')] }],
    ...rules,
  });
  assert.equal(selected.length, 0);
  assert.equal(rejected[0].reason, 'too_few_resolved_positions');
});

test('a wallet carried by one exceptional position is rejected', () => {
  // +1000 on one trade, -50 on each of four others. Cumulative PnL is positive,
  // but removing the single best position turns it negative: a lottery ticket.
  const { selected, rejected } = selectWallets({
    candidates: [{
      wallet: '0xa',
      closedPositions: [
        closed(1_000, CUTOFF - 10, 500, 'a'),
        closed(-50, CUTOFF - 20, 500, 'b'),
        closed(-50, CUTOFF - 30, 500, 'c'),
        closed(-50, CUTOFF - 40, 500, 'd'),
        closed(-50, CUTOFF - 50, 500, 'e'),
      ],
    }],
    ...rules,
  });
  assert.equal(selected.length, 0);
  assert.equal(rejected[0].reason, 'single_position_dependent');
});

test('a broadly profitable wallet survives removal of its best position', () => {
  const { selected } = selectWallets({
    candidates: [{
      wallet: '0xa',
      closedPositions: [
        closed(100, CUTOFF - 10, 500, 'a'),
        closed(80, CUTOFF - 20, 500, 'b'),
        closed(60, CUTOFF - 30, 500, 'c'),
        closed(-20, CUTOFF - 40, 500, 'd'),
      ],
    }],
    ...rules,
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].wallet, '0xa');
  assert.ok(selected[0].pnlWithoutBest > 0);
});

test('a losing wallet is rejected before any other test runs', () => {
  const { rejected } = selectWallets({
    candidates: [{
      wallet: '0xa',
      closedPositions: [
        closed(-100, CUTOFF - 10, 500, 'a'),
        closed(-80, CUTOFF - 20, 500, 'b'),
        closed(-60, CUTOFF - 30, 500, 'c'),
      ],
    }],
    ...rules,
  });
  assert.equal(rejected[0].reason, 'not_profitable');
});

test('a wallet whose typical position is too small to copy is rejected', () => {
  const { rejected } = selectWallets({
    candidates: [{
      wallet: '0xa',
      closedPositions: [
        closed(100, CUTOFF - 10, 5, 'a'),
        closed(80, CUTOFF - 20, 5, 'b'),
        closed(60, CUTOFF - 30, 5, 'c'),
      ],
    }],
    ...rules,
  });
  assert.equal(rejected[0].reason, 'positions_too_small_to_copy');
});

test('a wallet that only ever traded one market is rejected as undiversified', () => {
  const { rejected } = selectWallets({
    candidates: [{
      wallet: '0xa',
      closedPositions: [
        closed(100, CUTOFF - 10, 500, 'same'),
        closed(80, CUTOFF - 20, 500, 'same'),
        closed(60, CUTOFF - 30, 500, 'same'),
      ],
    }],
    ...rules,
  });
  assert.equal(rejected[0].reason, 'too_few_distinct_markets');
});

test('every candidate is accounted for as either selected or rejected', () => {
  const candidates = [
    { wallet: '0xgood', closedPositions: [closed(100, CUTOFF - 10, 500, 'a'), closed(80, CUTOFF - 20, 500, 'b'), closed(60, CUTOFF - 30, 500, 'c')] },
    { wallet: '0xbad', closedPositions: [closed(-100, CUTOFF - 10, 500, 'a')] },
    { wallet: '0xempty', closedPositions: [] },
  ];
  const { selected, rejected } = selectWallets({ candidates, ...rules });
  assert.equal(selected.length + rejected.length, candidates.length);
});
