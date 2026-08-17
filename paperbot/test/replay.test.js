import test from 'node:test';
import assert from 'node:assert/strict';
import { loadObservations, observationToBooks, replaySweep, replayVariant, replayWarnings } from '../src/replay.js';

const baseConfig = {
  startingCashUsd: 1_000,
  minPairShares: 5,
  maxPairShares: 25,
  minNetEdgePerShare: 0.01,
  assumedMergeCostUsd: 0,
  adverseSelectionBps: 0,
};

function observation({ timestamp, yesPrice, noPrice, size = 100, id = 'm1' }) {
  return {
    type: 'orderbook_observation',
    timestamp,
    market: {
      id, question: `Market ${id}`, slug: id, feeRate: 0,
      tokenIds: [`${id}-yes`, `${id}-no`], liquidity: 1_000_000,
    },
    yes: { hash: `${id}-yes-hash`, asks: [{ price: yesPrice, size }], bids: [] },
    no: { hash: `${id}-no-hash`, asks: [{ price: noPrice, size }], bids: [] },
  };
}

test('observationToBooks keys each recorded book by its own token id', () => {
  const books = observationToBooks(observation({ timestamp: 't', yesPrice: 0.4, noPrice: 0.5 }));
  assert.deepEqual([...books.keys()], ['m1-yes', 'm1-no']);
  assert.equal(books.get('m1-yes').asks[0].price, 0.4);
  assert.equal(books.get('m1-no').hash, 'm1-no-hash');
});

test('loadObservations drops records missing either side of the pair', () => {
  const lines = [
    JSON.stringify(observation({ timestamp: '2026-01-01T00:00:00Z', yesPrice: 0.4, noPrice: 0.5 })),
    JSON.stringify({ ...observation({ timestamp: '2026-01-01T00:00:01Z', yesPrice: 0.4, noPrice: 0.5 }), no: null }),
    '',
  ].join('\n');
  assert.equal(loadObservations(lines).length, 1);
});

test('loadObservations replays oldest first so the cash constraint applies in order', () => {
  const lines = [
    observation({ timestamp: '2026-01-02T00:00:00Z', yesPrice: 0.4, noPrice: 0.5, id: 'later' }),
    observation({ timestamp: '2026-01-01T00:00:00Z', yesPrice: 0.4, noPrice: 0.5, id: 'earlier' }),
  ].map((record) => JSON.stringify(record)).join('\n');
  assert.deepEqual(loadObservations(lines).map((o) => o.market.id), ['earlier', 'later']);
});

test('replayVariant reproduces the same decisions on the same corpus', () => {
  const observations = [observation({ timestamp: 't1', yesPrice: 0.45, noPrice: 0.5 })];
  const first = replayVariant({ observations, config: baseConfig });
  const second = replayVariant({ observations, config: baseConfig });
  assert.deepEqual(first.summary, second.summary);
  assert.equal(first.summary.filledTrades, 1);
});

test('replayVariant counts how often the gross pair actually crosses par', () => {
  const observations = [
    observation({ timestamp: 't1', yesPrice: 0.45, noPrice: 0.5, id: 'under' }),
    observation({ timestamp: 't2', yesPrice: 0.6, noPrice: 0.5, id: 'over' }),
  ];
  const result = replayVariant({ observations, config: baseConfig });
  assert.equal(result.grossPairBelowPar, 1);
  assert.equal(result.evaluated, 2);
});

test('a harsher adverse-selection assumption can only reduce fills', () => {
  const observations = [observation({ timestamp: 't1', yesPrice: 0.48, noPrice: 0.5 })];
  const sweep = replaySweep({ observations, config: baseConfig, adverseSelectionBpsVariants: [0, 5, 20] });

  assert.deepEqual(sweep.map((v) => v.adverseSelectionBps), [0, 5, 20]);
  for (let i = 1; i < sweep.length; i += 1) {
    assert.ok(
      sweep[i].summary.filledTrades <= sweep[i - 1].summary.filledTrades,
      'fills must be monotonically non-increasing as the buffer widens',
    );
    assert.ok(sweep[i].summary.realizedPnlUsd <= sweep[i - 1].summary.realizedPnlUsd + 1e-12);
  }
});

test('replay refuses to look like a validation run when the edge threshold is relaxed', () => {
  // A leftover PAPER_MIN_NET_EDGE_PER_SHARE=-1 from a smoke test accepts every
  // signal. The output must say so instead of reporting a clean gate result.
  const warnings = replayWarnings({ ...baseConfig, minNetEdgePerShare: -1 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /minNetEdgePerShare/);
});

test('replay flags a corpus read out of a smoke-test directory', () => {
  const warnings = replayWarnings({ ...baseConfig, dataDirectory: 'data/smoke' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /smoke/);
});

test('a normally configured replay raises no warnings', () => {
  assert.deepEqual(replayWarnings({ ...baseConfig, dataDirectory: 'data' }), []);
});

test('replay never converts a book too thin for the minimum size into a fill', () => {
  const thin = observation({ timestamp: 't1', yesPrice: 0.4, noPrice: 0.5, size: 1 });
  const result = replayVariant({ observations: [thin], config: baseConfig });
  assert.equal(result.summary.filledTrades, 0);
  assert.equal(result.skippedTooThin, 1);
});
