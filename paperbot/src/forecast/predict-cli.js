import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchActiveBinaryMarkets, fetchOrderBooks } from '../market-data.js';
import { forecastConfig } from './config.js';
import { assertForwardLooking, isForwardLooking } from './contamination.js';
import { decideForecastTrade } from './edge-decision.js';
import { combineForecasts } from './predictors/ensemble.js';
import { llmForecast } from './predictors/llm.js';
import { marketBaseline } from './predictors/market-baseline.js';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const dataDirectory = join(process.cwd(), forecastConfig.dataDirectory);
const logPath = join(dataDirectory, `forecast-predictions-${runId}.jsonl`);
const nowSeconds = Math.floor(Date.now() / 1_000);

const markets = await fetchActiveBinaryMarkets({
  limit: 100,
  minLiquidityUsd: forecastConfig.minLiquidityUsd,
  maxMarkets: forecastConfig.markets,
});
const books = await fetchOrderBooks(markets.flatMap((market) => market.tokenIds));

const best = (levels) => (levels?.length ? levels[0].price : null);
const records = [];
const skipped = {};

for (const market of markets) {
  const [yesTokenId, noTokenId] = market.tokenIds;
  const yes = books.get(yesTokenId);
  const no = books.get(noTokenId);
  const endDateSeconds = market.endDate ? Math.floor(Date.parse(market.endDate) / 1_000) : null;
  const shaped = { ...market, endDateSeconds };

  // Contamination guard runs before anything expensive happens.
  const verdict = isForwardLooking(shaped, nowSeconds);
  if (!verdict.ok) {
    skipped[verdict.reason] = (skipped[verdict.reason] ?? 0) + 1;
    continue;
  }
  if (endDateSeconds - nowSeconds > forecastConfig.maxDaysToResolution * 86_400) {
    skipped.resolves_too_far_out = (skipped.resolves_too_far_out ?? 0) + 1;
    continue;
  }
  if (!yes?.asks?.length || !no?.asks?.length) {
    skipped.no_book = (skipped.no_book ?? 0) + 1;
    continue;
  }

  const bestBid = best(yes.bids);
  const bestAsk = best(yes.asks);
  const impliedProbability = bestBid !== null ? (bestBid + bestAsk) / 2 : bestAsk;
  const context = { question: market.question, endDate: market.endDate, impliedProbability };

  const forecasts = forecastConfig.forecaster === 'llm'
    ? await Promise.all(forecastConfig.llmModels.map((model) => llmForecast(context, { model })))
    : [await marketBaseline(context)];

  const combined = combineForecasts(
    forecasts.map((forecast) => ({ probability: forecast.probability, weight: 1 })),
    { disagreementPenalty: forecastConfig.disagreementPenalty },
  );
  if (combined.probability === null) {
    skipped.no_usable_forecast = (skipped.no_usable_forecast ?? 0) + 1;
    continue;
  }

  const decision = decideForecastTrade({
    modelProbability: combined.probability,
    books: { yes, no },
    config: {
      // Disagreement raises the bar rather than being averaged away.
      minNetEdge: forecastConfig.minNetEdge + (combined.thresholdPenalty ?? 0),
      maxShares: forecastConfig.maxShares,
      feeRate: market.feeRate,
      adverseSelectionBps: forecastConfig.adverseSelectionBps,
    },
    cashUsd: Number.POSITIVE_INFINITY,
  });

  assertForwardLooking(shaped, nowSeconds);
  records.push({
    type: 'forecast_prediction', runId,
    predictedAtSeconds: nowSeconds,
    marketId: market.id, conditionId: market.conditionId,
    question: market.question, slug: market.slug,
    endDate: market.endDate, endDateSeconds,
    yesTokenId, noTokenId,
    impliedProbability,
    bestBid, bestAsk,
    forecaster: forecastConfig.forecaster,
    modelProbability: combined.probability,
    disagreement: combined.disagreement,
    contributors: combined.contributors,
    forecasts: forecasts.map((f) => ({ forecaster: f.forecaster, probability: f.probability })),
    decision,
  });
}

if (records.length > 0) {
  await mkdir(dataDirectory, { recursive: true });
  await appendFile(logPath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

console.log(JSON.stringify({
  logPath,
  forecaster: forecastConfig.forecaster,
  scannedMarkets: markets.length,
  predictionsRecorded: records.length,
  wouldTrade: records.filter((r) => r.decision.status === 'trade').length,
  skipped,
  note: 'Predictions are forward-only. Run "npm run forecast:score" after these markets resolve.',
}, null, 2));
