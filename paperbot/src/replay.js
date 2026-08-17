import { PaperLedger } from './paper-ledger.js';
import { scanPairedArbitrage } from './strategies/paired-arbitrage.js';

// Observations record only the top ten levels per side. Replay is therefore
// slightly more conservative than the live scan, which walks the whole book:
// it can under-fill a large size, never over-fill one.
export function observationToBooks(observation) {
  const [yesTokenId, noTokenId] = observation.market.tokenIds;
  return new Map([
    [yesTokenId, { tokenId: yesTokenId, ...observation.yes }],
    [noTokenId, { tokenId: noTokenId, ...observation.no }],
  ]);
}

function isReplayable(record) {
  return Boolean(
    record
    && record.type === 'orderbook_observation'
    && record.market
    && Array.isArray(record.market.tokenIds)
    && record.market.tokenIds.length === 2
    && record.yes?.asks?.length
    && record.no?.asks?.length,
  );
}

export function loadObservations(text) {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(isReplayable)
    .sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
}

function bestPairSum(observation) {
  return observation.yes.asks[0].price + observation.no.asks[0].price;
}

const OBSERVATION_LOG = /^orderbook-observations.*\.jsonl$/;

// Observations captured before the liquidity-sort fix describe a universe with
// a median liquidity of ~$100. They are kept for the record and must never be
// replayed as if they were real.
const QUARANTINED = /pre-liquidity-fix/;

export function selectCorpusFiles(fileNames) {
  return fileNames
    .filter((name) => OBSERVATION_LOG.test(name) && !QUARANTINED.test(name))
    .sort();
}

// Relaxed smoke-test settings survive in a shell session and silently turn the
// next replay into nonsense. Say so in the output rather than reporting a gate.
export function replayWarnings(config) {
  const warnings = [];
  if (config.minNetEdgePerShare <= 0) {
    warnings.push(`minNetEdgePerShare is ${config.minNetEdgePerShare}: every signal is accepted, so this is not a validation run.`);
  }
  if (/smoke/i.test(config.dataDirectory ?? '')) {
    warnings.push(`corpus is being read from "${config.dataDirectory}": smoke-test data, not a real corpus.`);
  }
  return warnings;
}

export function replayVariant({ observations, config }) {
  const ledger = new PaperLedger(config.startingCashUsd);
  const decisions = [];
  let skippedTooThin = 0;
  let grossPairBelowPar = 0;

  for (const observation of observations) {
    if (bestPairSum(observation) < 1) grossPairBelowPar += 1;

    const results = scanPairedArbitrage({
      markets: [observation.market],
      books: observationToBooks(observation),
      ledger,
      config,
    });

    // scanPairedArbitrage returns nothing when the book cannot support
    // minPairShares. That is a skip, not a silent fill.
    if (results.length === 0) {
      skippedTooThin += 1;
      continue;
    }
    decisions.push(...results.map((decision) => ({ ...decision, observedAt: observation.timestamp })));
  }

  return {
    adverseSelectionBps: config.adverseSelectionBps,
    assumedMergeCostUsd: config.assumedMergeCostUsd,
    minNetEdgePerShare: config.minNetEdgePerShare,
    evaluated: observations.length,
    grossPairBelowPar,
    skippedTooThin,
    summary: ledger.summary(),
    decisions,
  };
}

export function replaySweep({ observations, config, adverseSelectionBpsVariants }) {
  return adverseSelectionBpsVariants.map((adverseSelectionBps) =>
    replayVariant({ observations, config: { ...config, adverseSelectionBps } }));
}
