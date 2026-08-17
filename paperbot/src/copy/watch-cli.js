import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchOrderBooks } from '../market-data.js';
import { copyConfig } from './config.js';
import { fetchWalletTrades } from './trade-feed.js';

// Live-forward collection. The spec chose this over reconstructing entries from
// the trade tape: a tape shows what traded, not what was offered, and the whole
// question is what price the follower could actually have obtained.

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const dataDirectory = join(process.cwd(), copyConfig.dataDirectory);
const corpusPath = join(dataDirectory, `copy-observations-${runId}.jsonl`);

async function loadWatchedWallets() {
  if (process.env.COPY_WALLETS) {
    return process.env.COPY_WALLETS.split(',').map((wallet) => wallet.trim().toLowerCase());
  }
  const files = (await readdir(dataDirectory).catch(() => []))
    .filter((name) => /^copy-wallets-.*\.json$/.test(name))
    .sort();
  if (files.length === 0) {
    throw new Error('No wallet file. Run "npm run copy:discover" first, or set COPY_WALLETS.');
  }
  const latest = JSON.parse(await readFile(join(dataDirectory, files.at(-1)), 'utf8'));
  console.error(`Watching ${latest.selectedWallets.length} wallets from ${files.at(-1)}`);
  return latest.selectedWallets;
}

const wallets = await loadWatchedWallets();
if (wallets.length === 0) throw new Error('Wallet selection produced no wallets to watch.');

const seenTrades = new Set();
let recorded = 0;
let startSeconds = Math.floor(Date.now() / 1_000);

async function pollOnce() {
  const observedAt = Date.now();
  const events = [];

  for (const wallet of wallets) {
    try {
      const trades = await fetchWalletTrades({
        wallet, startSeconds, mode: 'live', observedAt, limit: 100,
      });
      for (const trade of trades) {
        const key = `${trade.transactionHash}:${trade.tokenId}:${trade.side}`;
        if (seenTrades.has(key)) continue;
        seenTrades.add(key);
        events.push(trade);
      }
    } catch (error) {
      console.error(`  poll ${wallet.slice(0, 10)}: ${error.message}`);
    }
  }

  if (events.length === 0) return 0;

  // Snapshot the book for every token a watched wallet just touched. This is
  // the book the follower would have faced, at measured detection latency.
  const books = await fetchOrderBooks([...new Set(events.map((event) => event.tokenId))]);
  const records = events.map((event) => ({
    type: 'copy_observation',
    runId,
    sourceTrade: event,
    book: projectBook(books.get(event.tokenId)),
    bookFetchedAt: Date.now(),
  }));

  await mkdir(dataDirectory, { recursive: true });
  await appendFile(corpusPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  recorded += records.length;
  return records.length;
}

function projectBook(book) {
  if (!book) return null;
  return {
    hash: book.hash, timestamp: book.timestamp,
    bids: book.bids.slice(0, 20), asks: book.asks.slice(0, 20),
  };
}

async function tick() {
  const added = await pollOnce();
  const latencies = [];
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    watchedWallets: wallets.length,
    newObservations: added,
    recordedTotal: recorded,
    targetObservations: copyConfig.targetObservations,
    corpusPath,
    ...(latencies.length ? { latencies } : {}),
  }));
  // Next poll only looks at trades since this one, so the window never rewinds.
  startSeconds = Math.floor(Date.now() / 1_000) - copyConfig.pollSeconds * 2;
}

await tick();
const timer = setInterval(async () => {
  try {
    await tick();
  } catch (error) {
    console.error(error);
    return;
  }
  if (copyConfig.targetObservations > 0 && recorded >= copyConfig.targetObservations) {
    clearInterval(timer);
    console.log(`Reached ${recorded} observations; stopping.`);
  }
}, copyConfig.pollSeconds * 1_000);
