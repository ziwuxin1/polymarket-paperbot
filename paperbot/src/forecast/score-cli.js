import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { forecastConfig } from './config.js';
import { scoreSeries } from './scoring.js';

const GAMMA_URL = 'https://gamma-api.polymarket.com';
const dataDirectory = join(process.cwd(), forecastConfig.dataDirectory);

const files = (await readdir(dataDirectory).catch(() => []))
  .filter((name) => /^forecast-predictions-.*\.jsonl$/.test(name)).sort();
if (files.length === 0) throw new Error(`No prediction log in ${dataDirectory}. Run "npm run forecast:predict" first.`);

const predictions = (await Promise.all(files.map((n) => readFile(join(dataDirectory, n), 'utf8'))))
  .join('\n').split('\n').filter((line) => line.trim())
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);

// Resolve outcomes from Gamma. A prediction is scored only once its market has
// actually closed; an unresolved prediction is pending, never a zero.
const resolved = [];
let pending = 0;
let unresolvable = 0;

for (const prediction of predictions) {
  const response = await fetch(`${GAMMA_URL}/markets/${prediction.marketId}`).catch(() => null);
  if (!response?.ok) { unresolvable += 1; continue; }
  const market = await response.json();

  if (market.closed !== true) { pending += 1; continue; }

  let prices = market.outcomePrices;
  if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { prices = null; } }
  const yesPrice = Array.isArray(prices) ? Number(prices[0]) : NaN;
  if (!Number.isFinite(yesPrice) || (yesPrice !== 0 && yesPrice !== 1)) { unresolvable += 1; continue; }

  resolved.push({
    marketId: prediction.marketId,
    conditionId: prediction.conditionId,
    modelProbability: prediction.modelProbability,
    marketProbability: prediction.impliedProbability,
    outcome: yesPrice,
    decision: prediction.decision,
  });
}

const report = {
  corpusFiles: files,
  predictions: predictions.length,
  resolved: resolved.length,
  pending,
  unresolvable,
};

if (resolved.length === 0) {
  console.log(JSON.stringify({ ...report, note: 'Nothing has resolved yet. This is expected; forward-only evaluation is slow by design.' }, null, 2));
} else {
  const scores = scoreSeries(resolved);
  console.log(JSON.stringify({
    ...report,
    scores: {
      sampleSize: scores.sampleSize,
      distinctMarkets: scores.distinctMarkets,
      brier: { model: scores.model.brier, market: scores.market.brier, constant: scores.constant.brier },
      logLoss: { model: scores.model.logLoss, market: scores.market.logLoss },
      skillVsMarket: scores.skillVsMarket,
    },
    gates: {
      gate1: { requirement: '200 resolved predictions across 50 markets', met: scores.sampleSize >= 200 && scores.distinctMarkets >= 50 },
      gate2: { requirement: 'positive skill against the market benchmark', skillVsMarket: scores.skillVsMarket, met: scores.skillVsMarket > 0 },
    },
    calibration: scores.model.calibration.filter((bin) => bin.count > 0),
  }, null, 2));
}
