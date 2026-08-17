import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchActiveBinaryMarkets } from '../market-data.js';
import { copyConfig } from './config.js';
import { fetchMarketTraders, fetchWalletClosedPositions } from './trade-feed.js';
import { selectWallets } from './wallet-selection.js';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const dataDirectory = join(process.cwd(), copyConfig.dataDirectory);
const outputPath = join(dataDirectory, `copy-wallets-${runId}.json`);

console.error(`Harvesting traders from ${copyConfig.harvestMarkets} markets...`);
const markets = await fetchActiveBinaryMarkets({
  limit: 100,
  minLiquidityUsd: copyConfig.harvestMinLiquidityUsd,
  maxMarkets: copyConfig.harvestMarkets,
});

// The pool is "who traded", never "who won". A leaderboard would already be
// filtered to the wallets that succeeded, which is the bias we are avoiding.
const pool = new Set();
for (const market of markets) {
  if (!market.conditionId) continue;
  try {
    for (const wallet of await fetchMarketTraders({ conditionId: market.conditionId })) {
      pool.add(wallet);
    }
  } catch (error) {
    console.error(`  skip ${market.slug}: ${error.message}`);
  }
}
console.error(`Pool: ${pool.size} distinct wallets. Fetching resolved history...`);

const candidateAddresses = [...pool].slice(0, copyConfig.maxCandidateWallets);
const candidates = [];
for (const [index, wallet] of candidateAddresses.entries()) {
  try {
    candidates.push({ wallet, closedPositions: await fetchWalletClosedPositions({ wallet }) });
  } catch (error) {
    console.error(`  skip ${wallet}: ${error.message}`);
  }
  if ((index + 1) % 25 === 0) console.error(`  ${index + 1}/${candidateAddresses.length}`);
}

const { selected, rejected } = selectWallets({
  candidates,
  selectionCutoff: copyConfig.selectionCutoff,
  minResolvedPositions: copyConfig.minResolvedPositions,
  minMedianPositionUsd: copyConfig.minMedianPositionUsd,
  minDistinctMarkets: copyConfig.minDistinctMarkets,
});

const reasons = {};
for (const record of rejected) reasons[record.reason] = (reasons[record.reason] ?? 0) + 1;

const result = {
  runId,
  selectionCutoff: copyConfig.selectionCutoff,
  selectionCutoffIso: new Date(copyConfig.selectionCutoff * 1_000).toISOString(),
  harvestedMarkets: markets.length,
  poolSize: pool.size,
  evaluated: candidates.length,
  selectedWallets: selected.map((record) => record.wallet),
  selected,
  rejectionReasons: reasons,
};

await mkdir(dataDirectory, { recursive: true });
await writeFile(outputPath, JSON.stringify(result, null, 2));

console.log(JSON.stringify({
  outputPath,
  selectionCutoffIso: result.selectionCutoffIso,
  harvestedMarkets: result.harvestedMarkets,
  poolSize: result.poolSize,
  evaluated: result.evaluated,
  selected: selected.length,
  rejectionReasons: reasons,
  // Everything at or after the cutoff is untouched by selection and is the
  // only window the evaluation may use.
  evaluationWindowStartsIso: result.selectionCutoffIso,
}, null, 2));
