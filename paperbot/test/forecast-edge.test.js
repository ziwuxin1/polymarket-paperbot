import test from 'node:test';
import assert from 'node:assert/strict';
import { decideForecastTrade } from '../src/forecast/edge-decision.js';
import { combineForecasts } from '../src/forecast/predictors/ensemble.js';
import { marketBaseline } from '../src/forecast/predictors/market-baseline.js';

const config = { minNetEdge: 0.05, maxShares: 25, feeRate: 0, adverseSelectionBps: 0 };
const books = (yesAsk, noAsk) => ({
  yes: { asks: [{ price: yesAsk, size: 500 }], bids: [], hash: 'y' },
  no: { asks: [{ price: noAsk, size: 500 }], bids: [], hash: 'n' },
});

test('a bet is priced against the executable ask, not the midpoint', () => {
  // Model says 0.80. The ask is 0.70, so the edge is 0.10, not whatever the
  // midpoint would have flattered it to.
  const decision = decideForecastTrade({
    modelProbability: 0.80, books: books(0.70, 0.32), config, cashUsd: 1_000,
  });
  assert.equal(decision.status, 'trade');
  assert.equal(decision.side, 'YES');
  assert.equal(decision.entryPrice, 0.70);
  assert.ok(Math.abs(decision.netEdge - 0.10) < 1e-9);
});

test('a model below the market takes the NO side when that side has the edge', () => {
  const decision = decideForecastTrade({
    modelProbability: 0.20, books: books(0.70, 0.32), config, cashUsd: 1_000,
  });
  assert.equal(decision.side, 'NO');
  // NO pays 1 if the event fails: 0.80 model probability against a 0.32 ask.
  assert.ok(Math.abs(decision.netEdge - 0.48) < 1e-9);
});

test('agreement with the market is not a trade', () => {
  const decision = decideForecastTrade({
    modelProbability: 0.71, books: books(0.70, 0.32), config, cashUsd: 1_000,
  });
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.reason, 'edge_below_threshold');
});

test('fees and an adverse-selection buffer are subtracted before the threshold test', () => {
  const bare = decideForecastTrade({
    modelProbability: 0.80, books: books(0.74, 0.32), config, cashUsd: 1_000,
  });
  assert.equal(bare.status, 'trade', 'a 0.06 gross edge clears a 0.05 threshold with no costs');

  const costly = decideForecastTrade({
    modelProbability: 0.80, books: books(0.74, 0.32),
    config: { ...config, feeRate: 0.07, adverseSelectionBps: 100 }, cashUsd: 1_000,
  });
  assert.equal(costly.status, 'rejected', 'the same edge does not survive real costs');
});

test('a book too thin for the size is rejected, never partially filled', () => {
  const decision = decideForecastTrade({
    modelProbability: 0.9,
    books: { yes: { asks: [{ price: 0.5, size: 1 }], bids: [] }, no: { asks: [], bids: [] } },
    config, cashUsd: 1_000,
  });
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.reason, 'insufficient_ask_depth');
});

test('the market baseline predictor returns the market price itself', async () => {
  const forecast = await marketBaseline({ impliedProbability: 0.63 });
  assert.equal(forecast.probability, 0.63);
  assert.equal(forecast.forecaster, 'market-baseline');
});

test('the baseline can never show skill, which is how a broken harness is caught', () => {
  const decision = decideForecastTrade({
    modelProbability: 0.70, books: books(0.70, 0.32), config, cashUsd: 1_000,
  });
  assert.equal(decision.status, 'rejected');
});

test('ensemble disagreement widens the threshold instead of being averaged away', () => {
  // When models disagree the honest response is to bet less, not to split the
  // difference and pretend to the same confidence.
  const agreed = combineForecasts([
    { probability: 0.80, weight: 1 }, { probability: 0.82, weight: 1 },
  ], { disagreementPenalty: 1 });
  const split = combineForecasts([
    { probability: 0.20, weight: 1 }, { probability: 0.90, weight: 1 },
  ], { disagreementPenalty: 1 });

  assert.ok(Math.abs(agreed.probability - 0.81) < 1e-9);
  assert.ok(Math.abs(split.probability - 0.55) < 1e-9);
  assert.ok(split.thresholdPenalty > agreed.thresholdPenalty);
  assert.ok(split.disagreement > agreed.disagreement);
});

test('a weighted ensemble respects its weights', () => {
  const combined = combineForecasts([
    { probability: 1.0, weight: 3 }, { probability: 0.0, weight: 1 },
  ], { disagreementPenalty: 0 });
  assert.ok(Math.abs(combined.probability - 0.75) < 1e-9);
});

test('an ensemble with no usable forecasts returns null rather than a made-up number', () => {
  assert.equal(combineForecasts([], {}).probability, null);
  assert.equal(combineForecasts([{ probability: null, weight: 1 }], {}).probability, null);
});
