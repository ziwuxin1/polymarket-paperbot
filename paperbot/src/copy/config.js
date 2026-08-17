const numberFromEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const DAY = 86_400;

export const copyConfig = Object.freeze({
  dataDirectory: (process.env.PAPER_DATA_DIR || 'data').trim(),

  // Discovery: how wide a net to cast for candidate wallets.
  harvestMarkets: numberFromEnv('COPY_HARVEST_MARKETS', 40),
  harvestMinLiquidityUsd: numberFromEnv('COPY_HARVEST_MIN_LIQUIDITY_USD', 20_000),
  maxCandidateWallets: numberFromEnv('COPY_MAX_CANDIDATE_WALLETS', 200),

  // Selection: everything at or after the cutoff is out of sample.
  // Default cutoff is 30 days ago, so the last 30 days are the evaluation window.
  selectionCutoff: numberFromEnv(
    'COPY_SELECTION_CUTOFF',
    Math.floor(Date.now() / 1_000) - 30 * DAY,
  ),
  minResolvedPositions: numberFromEnv('COPY_MIN_RESOLVED_POSITIONS', 20),
  minMedianPositionUsd: numberFromEnv('COPY_MIN_MEDIAN_POSITION_USD', 100),
  minDistinctMarkets: numberFromEnv('COPY_MIN_DISTINCT_MARKETS', 10),

  // Copying.
  startingCashUsd: numberFromEnv('COPY_STARTING_CASH_USD', 1_000),
  assumedLatencySeconds: numberFromEnv('COPY_ASSUMED_LATENCY_SECONDS', 15),
  latencyMultiplier: numberFromEnv('COPY_LATENCY_MULTIPLIER', 1),
  sizeScale: numberFromEnv('COPY_SIZE_SCALE', 0.05),
  maxShares: numberFromEnv('COPY_MAX_SHARES', 25),
  maxPriceDriftFromSource: numberFromEnv('COPY_MAX_PRICE_DRIFT', 0.02),
  minSourceSizeUsd: numberFromEnv('COPY_MIN_SOURCE_SIZE_USD', 100),

  exitRule: process.env.COPY_EXIT_RULE || 'follow_source',
  takeProfit: numberFromEnv('COPY_TAKE_PROFIT', 0.15),
  stopLoss: numberFromEnv('COPY_STOP_LOSS', 0.15),
  maxHoldingSeconds: numberFromEnv('COPY_MAX_HOLDING_SECONDS', 7 * DAY),

  // Live-forward collection.
  pollSeconds: numberFromEnv('COPY_POLL_SECONDS', 30),
  targetObservations: numberFromEnv('COPY_TARGET_OBSERVATIONS', 0),
});
