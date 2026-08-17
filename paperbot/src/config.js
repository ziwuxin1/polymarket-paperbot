const numberFromEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

export const config = Object.freeze({
  // Smoke tests must be able to write somewhere other than the replay corpus.
  // cmd's `set VAR=x && ...` captures the space before `&&`, so trim it off.
  dataDirectory: (process.env.PAPER_DATA_DIR || 'data').trim(),
  startingCashUsd: numberFromEnv('PAPER_STARTING_CASH_USD', 1_000),
  marketFetchLimit: numberFromEnv('PAPER_MARKET_FETCH_LIMIT', 100),
  maxMarketsPerScan: numberFromEnv('PAPER_MAX_MARKETS_PER_SCAN', 20),
  minLiquidityUsd: numberFromEnv('PAPER_MIN_LIQUIDITY_USD', 2_000),
  minPairShares: numberFromEnv('PAPER_MIN_PAIR_SHARES', 5),
  maxPairShares: numberFromEnv('PAPER_MAX_PAIR_SHARES', 25),
  minNetEdgePerShare: numberFromEnv('PAPER_MIN_NET_EDGE_PER_SHARE', 0.01),
  assumedMergeCostUsd: numberFromEnv('PAPER_ASSUMED_MERGE_COST_USD', 0.15),
  adverseSelectionBps: numberFromEnv('PAPER_ADVERSE_SELECTION_BPS', 5),
  loopSeconds: numberFromEnv('PAPER_LOOP_SECONDS', 0),
});
