import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { fetchActiveBinaryMarkets, fetchOrderBooks } from './market-data.js';
import { PaperLedger } from './paper-ledger.js';
import { scanPairedArbitrage } from './strategies/paired-arbitrage.js';

const ledger = new PaperLedger(config.startingCashUsd);
const dataDirectory = join(process.cwd(), 'data');
const decisionLogPath = join(dataDirectory, 'paper-ledger.jsonl');
const observationLogPath = join(dataDirectory, 'orderbook-observations.jsonl');

async function persist(path, records) {
  if (records.length === 0) return;
  await mkdir(dataDirectory, { recursive: true });
  await appendFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function orderbookObservations(markets, books) {
  const timestamp = new Date().toISOString();
  return markets.map((market) => {
    const [yesTokenId, noTokenId] = market.tokenIds;
    const projectBook = (book) => book && ({
      hash: book.hash,
      timestamp: book.timestamp,
      tickSize: book.tickSize,
      minOrderSize: book.minOrderSize,
      bids: book.bids.slice(0, 10),
      asks: book.asks.slice(0, 10),
    });
    return {
      type: 'orderbook_observation', timestamp, market,
      yes: projectBook(books.get(yesTokenId)),
      no: projectBook(books.get(noTokenId)),
    };
  });
}

async function scanOnce() {
  const markets = await fetchActiveBinaryMarkets({
    limit: config.marketFetchLimit,
    minLiquidityUsd: config.minLiquidityUsd,
    maxMarkets: config.maxMarketsPerScan,
  });
  const tokenIds = markets.flatMap((market) => market.tokenIds);
  const books = await fetchOrderBooks(tokenIds);
  const results = scanPairedArbitrage({ markets, books, ledger, config });
  await Promise.all([
    persist(decisionLogPath, results),
    persist(observationLogPath, orderbookObservations(markets, books)),
  ]);

  const filled = results.filter((result) => result.status === 'filled');
  console.log(JSON.stringify({
    time: new Date().toISOString(), scannedMarkets: markets.length,
    accepted: filled.length, rejected: results.length - filled.length,
    acceptedTrades: filled.map((trade) => ({ market: trade.market, netPnl: trade.netPnl })),
    summary: ledger.summary(), decisionLogPath, observationLogPath,
  }, null, 2));
}

await scanOnce();
if (config.loopSeconds > 0) {
  setInterval(() => scanOnce().catch((error) => console.error(error)), config.loopSeconds * 1_000);
}
