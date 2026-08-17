const GAMMA_URL = 'https://gamma-api.polymarket.com';
const CLOB_URL = 'https://clob.polymarket.com';

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
export function buildMarketDiscoveryParams({ limit, minLiquidityUsd }) {
  const params = new URLSearchParams({
    active: 'true',
    closed: 'false',
    enable_order_book: 'true',
    order: 'liquidityNum',
    ascending: 'false',
    limit: String(limit),
  });
  if (minLiquidityUsd > 0) params.set('liquidity_num_min', String(minLiquidityUsd));
  return params;
}

export async function fetchActiveBinaryMarkets({ limit, minLiquidityUsd, maxMarkets }) {
  const params = buildMarketDiscoveryParams({ limit, minLiquidityUsd });
  const response = await fetch(`${GAMMA_URL}/markets?${params}`);
  if (!response.ok) throw new Error(`Gamma market discovery failed: HTTP ${response.status}`);

  const markets = await response.json();
  return markets
    .map(normalizeMarket)
    .filter((market) => market && market.liquidity >= minLiquidityUsd)
    .slice(0, maxMarkets);
}

export async function fetchOrderBooks(tokenIds) {
  const response = await fetch(`${CLOB_URL}/books`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tokenIds.map((tokenId) => ({ token_id: tokenId }))),
  });
  if (!response.ok) throw new Error(`CLOB book request failed: HTTP ${response.status}`);

  const books = await response.json();
  return new Map(books.map((book) => [String(book.asset_id), {
    tokenId: String(book.asset_id),
    timestamp: book.timestamp ?? null,
    hash: book.hash ?? null,
    bids: normalizeLevels(book.bids, 'bid'),
    asks: normalizeLevels(book.asks, 'ask'),
    minOrderSize: asFiniteNumber(book.min_order_size),
    tickSize: asFiniteNumber(book.tick_size),
  }]));
}
