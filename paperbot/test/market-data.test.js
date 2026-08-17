import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketDiscoveryParams, normalizeMarket } from '../src/market-data.js';

test('discovery orders by the numeric liquidity field, not the string field', () => {
  // Gamma sorts `order=liquidity` lexicographically, so "9998" outranks "500000".
  // Only `liquidityNum` yields a genuine deepest-book-first page.
  const params = buildMarketDiscoveryParams({ limit: 100, minLiquidityUsd: 2_000 });
  assert.equal(params.get('order'), 'liquidityNum');
  assert.equal(params.get('ascending'), 'false');
});

test('discovery pushes the liquidity floor to the server so the page is not wasted', () => {
  const params = buildMarketDiscoveryParams({ limit: 100, minLiquidityUsd: 2_000 });
  assert.equal(params.get('liquidity_num_min'), '2000');
  assert.equal(params.get('limit'), '100');
  assert.equal(params.get('active'), 'true');
  assert.equal(params.get('closed'), 'false');
  assert.equal(params.get('enable_order_book'), 'true');
});

test('discovery omits the liquidity floor when none is configured', () => {
  const params = buildMarketDiscoveryParams({ limit: 50, minLiquidityUsd: 0 });
  assert.equal(params.has('liquidity_num_min'), false);
});

test('normalizeMarket prefers liquidityNum over the string liquidity field', () => {
  const market = normalizeMarket({
    id: 7,
    question: 'Test market',
    slug: 'test-market',
    outcomes: '["Yes","No"]',
    clobTokenIds: '["1","2"]',
    liquidity: '9998',
    liquidityNum: 512345.67,
    feesEnabled: false,
  });
  assert.equal(market.liquidity, 512345.67);
});

test('normalizeMarket drops a market whose fee schedule is enabled but missing', () => {
  const market = normalizeMarket({
    id: 8,
    outcomes: '["Yes","No"]',
    clobTokenIds: '["1","2"]',
    liquidity: '1000',
    feesEnabled: true,
  });
  assert.equal(market, null);
});
