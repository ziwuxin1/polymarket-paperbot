import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchMarketTraders, fetchWalletClosedPositions, fetchWalletTrades, normalizeSourceTrade,
} from '../src/copy/trade-feed.js';

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

const rawTrade = {
  proxyWallet: '0xABC', side: 'BUY', size: 25, price: 0.42,
  timestamp: 1_700_000_000, transactionHash: '0xhash',
  asset: 'token-1', conditionId: 'cond-1', outcome: 'Yes', title: 'T', slug: 's',
};

test('a backfilled trade is labelled as assumed latency, with no observation time', () => {
  // Backfill cannot know when a live follower would have seen the trade.
  // Recording a fake observation time here would launder an assumption into data.
  const event = normalizeSourceTrade(rawTrade, { mode: 'backfill' });
  assert.equal(event.latencyMode, 'assumed');
  assert.equal(event.observedAt, null);
  assert.equal(event.detectionLatencySeconds, null);
});

test('a live-observed trade carries a measured detection latency', () => {
  const event = normalizeSourceTrade(rawTrade, {
    mode: 'live', observedAt: (1_700_000_000 + 8) * 1_000,
  });
  assert.equal(event.latencyMode, 'measured');
  assert.equal(event.detectionLatencySeconds, 8);
});

test('trade normalization lowercases the wallet so address comparisons hold', () => {
  const event = normalizeSourceTrade(rawTrade, { mode: 'backfill' });
  assert.equal(event.wallet, '0xabc');
  assert.equal(event.tokenId, 'token-1');
  assert.equal(event.side, 'BUY');
  assert.equal(event.price, 0.42);
});

test('a trade missing the fields a copy needs is dropped rather than half-recorded', () => {
  assert.equal(normalizeSourceTrade({ ...rawTrade, asset: null }, { mode: 'backfill' }), null);
  assert.equal(normalizeSourceTrade({ ...rawTrade, price: 'x' }, { mode: 'backfill' }), null);
  assert.equal(normalizeSourceTrade({ ...rawTrade, timestamp: null }, { mode: 'backfill' }), null);
});

test('wallet trades are requested from the data API with the time window applied', async () => {
  let requested = null;
  const fetchImpl = async (url) => {
    requested = new URL(url);
    return jsonResponse([rawTrade]);
  };

  const events = await fetchWalletTrades(
    { wallet: '0xABC', startSeconds: 1_000, endSeconds: 2_000 }, fetchImpl,
  );

  assert.equal(requested.origin + requested.pathname, 'https://data-api.polymarket.com/activity');
  assert.equal(requested.searchParams.get('user'), '0xABC');
  assert.equal(requested.searchParams.get('type'), 'TRADE');
  assert.equal(requested.searchParams.get('start'), '1000');
  assert.equal(requested.searchParams.get('end'), '2000');
  assert.equal(events.length, 1);
  assert.equal(events[0].latencyMode, 'assumed');
});

test('harvesting traders from a market returns addresses, not a leaderboard', async () => {
  // The pool must be "who traded", never "who won" — a leaderboard is the list
  // of wallets that already succeeded, and selecting from it is survivor bias.
  const fetchImpl = async (url) => {
    const requested = new URL(url);
    assert.equal(requested.pathname, '/trades');
    assert.equal(requested.searchParams.get('market'), 'cond-1');
    return jsonResponse([
      rawTrade,
      { ...rawTrade, proxyWallet: '0xDEF' },
      { ...rawTrade, proxyWallet: '0xabc' },
    ]);
  };

  const wallets = await fetchMarketTraders({ conditionId: 'cond-1' }, fetchImpl);
  assert.deepEqual([...wallets].sort(), ['0xabc', '0xdef']);
});

test('closed positions are fetched paged and stop at a short page', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
    return jsonResponse(offset === 0
      ? Array.from({ length: 50 }, () => ({ realizedPnl: 1, timestamp: 1, totalBought: 10, conditionId: 'c' }))
      : [{ realizedPnl: 1, timestamp: 1, totalBought: 10, conditionId: 'c' }]);
  };

  const positions = await fetchWalletClosedPositions({ wallet: '0xabc' }, fetchImpl);
  assert.equal(positions.length, 51);
  assert.equal(calls, 2);
});

test('a failed data API call raises rather than returning an empty result', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(
    () => fetchWalletTrades({ wallet: '0xabc' }, fetchImpl),
    /503/,
  );
});
