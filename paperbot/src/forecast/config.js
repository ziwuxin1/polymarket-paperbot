const numberFromEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

export const forecastConfig = Object.freeze({
  dataDirectory: (process.env.PAPER_DATA_DIR || 'data').trim(),
  markets: numberFromEnv('FORECAST_MARKETS', 20),
  minLiquidityUsd: numberFromEnv('FORECAST_MIN_LIQUIDITY_USD', 20_000),
  maxDaysToResolution: numberFromEnv('FORECAST_MAX_DAYS_TO_RESOLUTION', 30),
  minNetEdge: numberFromEnv('FORECAST_MIN_NET_EDGE', 0.05),
  maxShares: numberFromEnv('FORECAST_MAX_SHARES', 25),
  adverseSelectionBps: numberFromEnv('FORECAST_ADVERSE_SELECTION_BPS', 50),
  disagreementPenalty: numberFromEnv('FORECAST_DISAGREEMENT_PENALTY', 1),
  forecaster: process.env.FORECAST_PREDICTOR || 'market-baseline',
  llmModels: (process.env.FORECAST_LLM_MODELS || 'claude-opus-5').split(',').map((m) => m.trim()),
});
