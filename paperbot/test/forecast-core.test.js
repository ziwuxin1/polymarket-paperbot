import test from 'node:test';
import assert from 'node:assert/strict';
import { assertForwardLooking, isForwardLooking } from '../src/forecast/contamination.js';
import { brierScore, calibrationBins, logLoss, scoreSeries } from '../src/forecast/scoring.js';

const NOW = 1_700_000_000;
const openMarket = {
  id: 'm1', conditionId: 'c1', active: true, closed: false,
  endDateSeconds: NOW + 86_400,
};

test('a prediction on an open market that ends in the future is forward-looking', () => {
  assert.equal(isForwardLooking(openMarket, NOW).ok, true);
});

test('a prediction on an already-resolved market is rejected outright', () => {
  // A model asked about an event that already happened may simply know the
  // answer. No backtest can prove otherwise, so the harness refuses the input.
  const closed = isForwardLooking({ ...openMarket, closed: true }, NOW);
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, 'market_already_closed');

  const inactive = isForwardLooking({ ...openMarket, active: false }, NOW);
  assert.equal(inactive.reason, 'market_not_active');
});

test('a prediction timestamped after the market end date is rejected as backfill', () => {
  // This is what a backfilled log masquerading as forward-looking looks like.
  const late = isForwardLooking(openMarket, NOW + 200_000);
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'market_end_date_passed');
});

test('a market with no end date cannot be certified forward-looking', () => {
  const undated = isForwardLooking({ ...openMarket, endDateSeconds: null }, NOW);
  assert.equal(undated.ok, false);
  assert.equal(undated.reason, 'no_end_date');
});

test('assertForwardLooking throws so a contaminated prediction cannot be recorded', () => {
  assert.throws(() => assertForwardLooking({ ...openMarket, closed: true }, NOW), /market_already_closed/);
  assert.doesNotThrow(() => assertForwardLooking(openMarket, NOW));
});

test('brier score rewards confident correctness and punishes confident error', () => {
  assert.equal(brierScore([{ probability: 1, outcome: 1 }]), 0);
  assert.equal(brierScore([{ probability: 0, outcome: 1 }]), 1);
  assert.equal(brierScore([{ probability: 0.5, outcome: 1 }]), 0.25);
});

test('log loss is finite even for a prediction of exactly zero', () => {
  const loss = logLoss([{ probability: 0, outcome: 1 }]);
  assert.ok(Number.isFinite(loss), 'an unclamped log loss would be Infinity and poison the average');
});

test('calibration bins report predicted versus observed frequency', () => {
  const bins = calibrationBins([
    { probability: 0.05, outcome: 0 }, { probability: 0.05, outcome: 0 },
    { probability: 0.95, outcome: 1 }, { probability: 0.95, outcome: 1 },
  ], 10);
  const populated = bins.filter((bin) => bin.count > 0);
  assert.equal(populated.length, 2);
  assert.equal(populated[0].observedFrequency, 0);
  assert.equal(populated[1].observedFrequency, 1);
});

test('skill is measured against the market price, never against a coin flip', () => {
  // The model is worse than the price here. A harness that benchmarked against
  // 0.5 would call this a success.
  const resolved = [
    { modelProbability: 0.60, marketProbability: 0.90, outcome: 1 },
    { modelProbability: 0.40, marketProbability: 0.10, outcome: 0 },
  ];
  const result = scoreSeries(resolved);

  assert.ok(result.model.brier > result.market.brier);
  assert.ok(result.skillVsMarket < 0, 'negative skill means the price already knew');
  assert.equal(result.sampleSize, 2);
});

test('a model that beats the price reports positive skill', () => {
  const resolved = [
    { modelProbability: 0.90, marketProbability: 0.60, outcome: 1 },
    { modelProbability: 0.10, marketProbability: 0.40, outcome: 0 },
  ];
  assert.ok(scoreSeries(resolved).skillVsMarket > 0);
});

test('the constant series is always reported as a floor', () => {
  const result = scoreSeries([{ modelProbability: 0.9, marketProbability: 0.8, outcome: 1 }]);
  assert.equal(result.constant.brier, 0.25);
  assert.ok(result.market.brier !== undefined);
});

test('scoring refuses records whose outcome is not 0 or 1', () => {
  assert.throws(
    () => scoreSeries([{ modelProbability: 0.5, marketProbability: 0.5, outcome: null }]),
    /outcome/,
  );
});
