import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { loadObservations, replaySweep, replayWarnings, selectCorpusFiles } from './replay.js';

// Promotion gate 2: the same corpus must stay profitable at the baseline
// buffer, +5 bps, and +20 bps. Any variant that fails blocks promotion.
const ADVERSE_SELECTION_VARIANTS = [config.adverseSelectionBps, 5, 20];

const corpusDirectory = join(process.cwd(), config.dataDirectory);
const singleFile = process.env.PAPER_REPLAY_CORPUS;

const corpusFiles = singleFile
  ? [singleFile]
  : selectCorpusFiles(await readdir(corpusDirectory).catch(() => []))
    .map((name) => join(corpusDirectory, name));

if (corpusFiles.length === 0) {
  throw new Error(`No observation corpus in ${corpusDirectory}. Run "npm run scan" first.`);
}

const texts = await Promise.all(corpusFiles.map((file) => readFile(file, 'utf8').catch(() => {
  throw new Error(`Cannot read corpus file ${file}.`);
})));

const observations = loadObservations(texts.join('\n'));
if (observations.length === 0) throw new Error(`No replayable observations in ${corpusPath}.`);

const variants = [...new Set(ADVERSE_SELECTION_VARIANTS)].sort((a, b) => a - b);
const sweep = replaySweep({ observations, config, adverseSelectionBpsVariants: variants });
const [baseline] = sweep;

const span = {
  from: observations[0].timestamp,
  to: observations.at(-1).timestamp,
  distinctMarkets: new Set(observations.map((o) => o.market.id)).size,
};

const warnings = replayWarnings(config);
for (const warning of warnings) console.warn(`WARNING: ${warning}`);

console.log(JSON.stringify({
  corpusFiles,
  warnings,
  trustworthy: warnings.length === 0,
  observations: observations.length,
  span,
  decisionsPerVariant: baseline.decisions.length,
  skippedTooThin: baseline.skippedTooThin,
  grossPairBelowPar: baseline.grossPairBelowPar,
  grossPairBelowParRate: baseline.grossPairBelowPar / observations.length,
  gate1: {
    target: 5_000,
    decisions: baseline.decisions.length,
    met: baseline.decisions.length >= 5_000,
  },
  gate2: {
    requirement: 'profitable at every adverse-selection assumption',
    variants: sweep.map((variant) => ({
      adverseSelectionBps: variant.adverseSelectionBps,
      filledTrades: variant.summary.filledTrades,
      rejectedSignals: variant.summary.rejectedSignals,
      realizedPnlUsd: variant.summary.realizedPnlUsd,
    })),
    met: sweep.every((variant) => variant.summary.realizedPnlUsd > 0),
  },
}, null, 2));
