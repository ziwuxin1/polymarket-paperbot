import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { copyConfig } from './config.js';
import { EXIT_RULES } from './exit-rules.js';
import { attributeFailure, copyGateReport, runCopySession } from './copy-session.js';

const dataDirectory = join(process.cwd(), copyConfig.dataDirectory);

const files = (await readdir(dataDirectory).catch(() => []))
  .filter((name) => /^copy-observations-.*\.jsonl$/.test(name))
  .sort();
if (files.length === 0) {
  throw new Error(`No copy corpus in ${dataDirectory}. Run "npm run copy:watch" first.`);
}

const observations = (await Promise.all(
  files.map((name) => readFile(join(dataDirectory, name), 'utf8')),
))
  .join('\n')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter((record) => record?.sourceTrade && record.book?.asks?.length);

if (observations.length === 0) throw new Error('Corpus contains no usable observations.');

// Each observation carries the book as it stood when the trade was observed, so
// the book provider is a lookup into the corpus rather than a live fetch.
const booksByToken = new Map();
for (const record of observations) booksByToken.set(record.sourceTrade.tokenId, record.book);
const bookProvider = (tokenId) => booksByToken.get(tokenId) ?? null;

const sourceTrades = observations.map((record) => record.sourceTrade);
const marketsByCondition = {};
for (const record of observations) {
  const trade = record.sourceTrade;
  marketsByCondition[trade.conditionId] ??= {
    id: trade.conditionId, question: trade.title ?? trade.conditionId,
    slug: trade.slug ?? trade.conditionId, feeRate: 0,
  };
}

function runWith(overrides) {
  return runCopySession({
    sourceTrades, marketsByCondition, bookProvider,
    config: { ...copyConfig, ...overrides },
  });
}

// Gate 4: every exit rule reported, never only the best one.
const perExitRule = {};
for (const rule of EXIT_RULES) {
  const result = runWith({ exitRule: rule });
  perExitRule[rule] = {
    realizedPnlUsd: result.summary.realizedPnlUsd,
    unrealizedPnlUsd: result.summary.unrealizedPnlUsd,
    closedPositions: result.summary.closedPositions,
    openPositions: result.summary.openPositions,
  };
}

// Gate 2: the edge must survive a slower follower.
const latencyVariants = [1, 2, 5].map((latencyMultiplier) => {
  const result = runWith({ latencyMultiplier });
  return {
    latencyMultiplier,
    realizedPnlUsd: result.summary.realizedPnlUsd,
    copied: result.copied.length,
    rejected: result.rejected.length,
  };
});

const baseline = runWith({});
const measured = sourceTrades.filter((trade) => trade.latencyMode === 'measured');
const latencySamples = measured
  .map((trade) => trade.detectionLatencySeconds)
  .filter((value) => Number.isFinite(value))
  .sort((left, right) => left - right);

const entryEdgeUsd = baseline.copied.reduce(
  (sum, decision) => sum - decision.slippageVsSource * decision.shares, 0,
);
const rejectRate = baseline.copied.length + baseline.rejected.length > 0
  ? baseline.rejected.length / (baseline.copied.length + baseline.rejected.length)
  : null;

const gates = copyGateReport({
  copied: baseline.copied,
  rejected: baseline.rejected,
  summary: baseline.summary,
  config: copyConfig,
  latencyVariants,
  windows: { selectionCutoff: copyConfig.selectionCutoff, evaluationStart: copyConfig.selectionCutoff },
  perExitRule,
  attribution: attributeFailure({
    // Source PnL is not derivable from this corpus alone; a negative attribution
    // that needs it must say so rather than guess.
    sourceWalletPnlUsd: null,
    copyRejectRate: rejectRate ?? 0,
    entryEdgeUsd,
    realizedPnlUsd: baseline.summary.realizedPnlUsd,
  }),
});

console.log(JSON.stringify({
  corpusFiles: files,
  observations: observations.length,
  measuredLatency: {
    samples: latencySamples.length,
    medianSeconds: latencySamples.length
      ? latencySamples[Math.floor(latencySamples.length / 2)]
      : null,
    assumedFallbackSeconds: copyConfig.assumedLatencySeconds,
  },
  baseline: baseline.summary,
  entryEdgeUsd,
  rejectRate,
  gates,
}, null, 2));
