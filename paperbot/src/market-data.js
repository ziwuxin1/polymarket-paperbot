const GAMMA_URL = 'https://gamma-api.polymarket.com';
const CLOB_URL = 'https://clob.polymarket.com';

// Gamma silently caps `limit` at 100: asking for 1000 still returns 100, with
// no error. Breadth beyond the first page has to come from `offset`.
export const GAMMA_PAGE_LIMIT = 100;

// Measured against the live endpoint: 400 token ids succeed, 600 returns
// HTTP 400. 200 keeps a margin under an undocumented boundary.
export const CLOB_BOOKS_BATCH_LIMIT = 200;

const DEFAULT_MAX_PAGES = 20;

export function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLevels(levels, direction) {
  return (Array.isArray(levels) ? levels : [])
    .map((level) => ({ price: asFiniteNumber(level.price), size: asFiniteNumber(level.size) }))
    .filter((level) => level.price !== null && level.size !== null && level.price > 0 && level.size > 0)
    .sort((left, right) => direction === 'ask' ? left.price - right.price : right.price - left.price);
}

export function normalizeMarket(raw) {
  const outcomes = parseList(raw.outcomes);
  const tokenIds = parseList(raw.clobTokenIds);
  // Gamma exposes liquidity twice; only `liquidityNum` is a real number.
  const liquidity = asFiniteNumber(raw.liquidityNum) ?? asFiniteNumber(raw.liquidity) ?? 0;
  const feeRate = raw.feesEnabled === true
    ? asFiniteNumber(raw.feeSchedule?.rate)
    : 0;

  if (outcomes.length !== 2 || tokenIds.length !== 2 || feeRate === null) return null;
  if (raw.enableOrderBook === false || raw.active === false || raw.closed === true) return null;

  return {
    id: String(raw.id),
    conditionId: raw.conditionId ?? raw.condition_id ?? null,
    question: raw.question ?? raw.slug ?? String(raw.id),
    slug: raw.slug ?? String(raw.id),
    outcomes,
    tokenIds,
    liquidity,
    feesEnabled: raw.feesEnabled === true,
    feeRate,
    endDate: raw.endDate ?? null,
  };
}

// `order=liquidity` sorts Gamma's *string* liquidity column, so a market with
// "9998" outranks one with "500000" and the page is dominated by dead books.
// `liquidityNum` is the numeric column and is the only correct deepest-first sort.
export function buildMarketDiscoveryParams({ limit, minLiquidityUsd, offset = 0 }) {
  const params = new URLSearchParams({
    active: 'true',
    closed: 'false',
    enable_order_book: 'true',
    order: 'liquidityNum',
    ascending: 'false',
    limit: String(Math.min(limit, GAMMA_PAGE_LIMIT)),
  });
  if (minLiquidityUsd > 0) params.set('liquidity_num_min', String(minLiquidityUsd));
  if (offset > 0) params.set('offset', String(offset));
  return params;
}

export async function fetchActiveBinaryMarkets(
  { limit, minLiquidityUsd, maxMarkets, maxPages = DEFAULT_MAX_PAGES },
  fetchImpl = fetch,
) {
  const pageLimit = Math.min(limit, GAMMA_PAGE_LIMIT);
  const collected = [];

  for (let page = 0; page < maxPages && collected.length < maxMarkets; page += 1) {
    const params = buildMarketDiscoveryParams({
      limit: pageLimit, minLiquidityUsd, offset: page * pageLimit,
    });
    const response = await fetchImpl(`${GAMMA_URL}/markets?${params}`);
    if (!response.ok) throw new Error(`Gamma market discovery failed: HTTP ${response.status}`);

    const raw = await response.json();
    collected.push(...raw
      .map(normalizeMarket)
      .filter((market) => market && market.liquidity >= minLiquidityUsd));

    // A short page is the end of the result set; a full page may have more.
    if (raw.length < pageLimit) break;
  }

  return collected.slice(0, maxMarkets);
}

export async function fetchOrderBooks(tokenIds, { batchSize = CLOB_BOOKS_BATCH_LIMIT } = {}, fetchImpl = fetch) {
  const books = new Map();

  for (const batch of chunk(tokenIds, batchSize)) {
    const response = await fetchImpl(`${CLOB_URL}/books`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch.map((tokenId) => ({ token_id: tokenId }))),
    });
    if (!response.ok) throw new Error(`CLOB book request failed: HTTP ${response.status}`);

    for (const book of await response.json()) {
      books.set(String(book.asset_id), {
        tokenId: String(book.asset_id),
        timestamp: book.timestamp ?? null,
        hash: book.hash ?? null,
        bids: normalizeLevels(book.bids, 'bid'),
        asks: normalizeLevels(book.asks, 'ask'),
        minOrderSize: asFiniteNumber(book.min_order_size),
        tickSize: asFiniteNumber(book.tick_size),
      });
    }
  }

  return books;
}
