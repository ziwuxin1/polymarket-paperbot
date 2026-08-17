const DATA_API_URL = 'https://data-api.polymarket.com';
const CLOSED_POSITIONS_PAGE = 50; // /closed-positions caps limit at 50.

// Number(null) is 0 and Number('') is 0, both finite. Reject the empty cases
// explicitly or a missing timestamp silently becomes 1970.
const asFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Data API request failed: HTTP ${response.status} for ${url}`);
  return response.json();
}

// A backfilled trade and a live-observed one are not the same evidence. Backfill
// cannot know when a follower would have seen the trade, so its latency is an
// assumption the caller supplies; only live observation measures it. Mixing the
// two without labelling which is which makes a corpus unreplayable.
export function normalizeSourceTrade(raw, { mode, observedAt = null }) {
  const wallet = raw?.proxyWallet ?? raw?.trader?.address;
  const timestampSeconds = asFiniteNumber(raw?.timestamp);
  const price = asFiniteNumber(raw?.price);
  const size = asFiniteNumber(raw?.size);

  if (!wallet || !raw.asset || timestampSeconds === null || price === null || size === null) return null;

  const measured = mode === 'live' && observedAt !== null;
  return {
    wallet: String(wallet).toLowerCase(),
    tokenId: String(raw.asset),
    conditionId: raw.conditionId ?? null,
    side: raw.side ?? null,
    outcome: raw.outcome ?? null,
    size,
    price,
    timestampSeconds,
    transactionHash: raw.transactionHash ?? null,
    title: raw.title ?? null,
    slug: raw.slug ?? null,
    latencyMode: measured ? 'measured' : 'assumed',
    observedAt: measured ? observedAt : null,
    detectionLatencySeconds: measured ? observedAt / 1_000 - timestampSeconds : null,
  };
}

export async function fetchWalletTrades(
  { wallet, startSeconds, endSeconds, limit = 500, mode = 'backfill', observedAt = null },
  fetchImpl = fetch,
) {
  const params = new URLSearchParams({ user: wallet, type: 'TRADE', limit: String(limit) });
  if (startSeconds !== undefined) params.set('start', String(startSeconds));
  if (endSeconds !== undefined) params.set('end', String(endSeconds));

  const raw = await getJson(`${DATA_API_URL}/activity?${params}`, fetchImpl);
  return raw
    .map((trade) => normalizeSourceTrade(trade, { mode, observedAt }))
    .filter(Boolean);
}

// The candidate pool must be "who traded", never "who won". Harvesting from a
// market's trade tape gives everyone who was there, winners and losers alike.
export async function fetchMarketTraders({ conditionId, limit = 500 }, fetchImpl = fetch) {
  const params = new URLSearchParams({ market: conditionId, limit: String(limit) });
  const raw = await getJson(`${DATA_API_URL}/trades?${params}`, fetchImpl);

  const wallets = new Set();
  for (const trade of raw) {
    const wallet = trade?.proxyWallet ?? trade?.trader?.address;
    if (wallet) wallets.add(String(wallet).toLowerCase());
  }
  return wallets;
}

export async function fetchWalletClosedPositions({ wallet, maxPages = 20 }, fetchImpl = fetch) {
  const positions = [];

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      user: wallet,
      limit: String(CLOSED_POSITIONS_PAGE),
      offset: String(page * CLOSED_POSITIONS_PAGE),
      sortBy: 'TIMESTAMP',
      sortDirection: 'DESC',
    });
    const raw = await getJson(`${DATA_API_URL}/closed-positions?${params}`, fetchImpl);
    positions.push(...raw);
    if (raw.length < CLOSED_POSITIONS_PAGE) break;
  }

  return positions;
}
