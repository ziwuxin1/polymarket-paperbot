import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOB_BOOKS_BATCH_LIMIT,
  GAMMA_PAGE_LIMIT,
  chunk,
  fetchActiveBinaryMarkets,
  fetchOrderBooks,
} from '../src/market-data.js';

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

function gammaMarket(id, liquidityNum = 1_000_000) {
  return {
    id, question: `Market ${id}`, slug: `m-${id}`,
    outcomes: '["Yes","No"]', clobTokenIds: `["${id}-yes","${id}-no"]`,
    liquidityNum, feesEnabled: false,
  };
}

test('chunk splits a list into batches and keeps the remainder', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
});

test('fetchOrderBooks batches token ids and merges every returned book', async () => {
  const tokenIds = Array.from({ length: CLOB_BOOKS_BATCH_LIMIT + 5 }, (_, i) => `t${i}`);
  const requestedSizes = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    requestedSizes.push(body.length);
    return jsonResponse(body.map(({ token_id: id }) => ({ asset_id: id, bids: [], asks: [] })));
  };

  const books = await fetchOrderBooks(tokenIds, {}, fetchImpl);

  assert.deepEqual(requestedSizes, [CLOB_BOOKS_BATCH_LIMIT, 5]);
  assert.equal(books.size, tokenIds.length);
  assert.ok(books.has('t0'));
  assert.ok(books.has(`t${tokenIds.length - 1}`));
});

test('fetchOrderBooks issues a single request when the batch limit is not exceeded', async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    return jsonResponse(JSON.parse(options.body).map(({ token_id: id }) => ({ asset_id: id, bids: [], asks: [] })));
  };
  await fetchOrderBooks(['a', 'b'], {}, fetchImpl);
  assert.equal(calls, 1);
});

test('discovery pages past the Gamma limit until maxMarkets is satisfied', async () => {
  // Gamma silently caps `limit` at 100, so breadth requires offset paging.
  const offsets = [];
  const fetchImpl = async (url) => {
    const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
    offsets.push(offset);
    return jsonResponse(Array.from({ length: GAMMA_PAGE_LIMIT }, (_, i) => gammaMarket(offset + i)));
  };

  const markets = await fetchActiveBinaryMarkets(
    { limit: GAMMA_PAGE_LIMIT, minLiquidityUsd: 0, maxMarkets: 250 },
    fetchImpl,
  );

  assert.equal(markets.length, 250);
  assert.deepEqual(offsets, [0, 100, 200]);
});

test('discovery stops at a short page instead of paging forever', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse([gammaMarket(1), gammaMarket(2)]);
  };

  const markets = await fetchActiveBinaryMarkets(
    { limit: GAMMA_PAGE_LIMIT, minLiquidityUsd: 0, maxMarkets: 500 },
    fetchImpl,
  );

  assert.equal(markets.length, 2);
  assert.equal(calls, 1, 'a page shorter than the limit means there is no next page');
});

test('discovery gives up rather than paging without bound when pages yield nothing usable', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    // Full pages, but every market is unusable (three outcomes).
    return jsonResponse(Array.from({ length: GAMMA_PAGE_LIMIT }, (_, i) => ({
      ...gammaMarket(i), outcomes: '["A","B","C"]',
    })));
  };

  const markets = await fetchActiveBinaryMarkets(
    { limit: GAMMA_PAGE_LIMIT, minLiquidityUsd: 0, maxMarkets: 500, maxPages: 3 },
    fetchImpl,
  );

  assert.equal(markets.length, 0);
  assert.equal(calls, 3);
});
