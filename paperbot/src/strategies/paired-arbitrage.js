export function scanPairedArbitrage({ markets, books, ledger, config }) {
  const results = [];
  for (const market of markets) {
    const [yesTokenId, noTokenId] = market.tokenIds;
    const yesBook = books.get(yesTokenId);
    const noBook = books.get(noTokenId);
    if (!yesBook || !noBook || yesBook.asks.length === 0 || noBook.asks.length === 0) continue;

    const available = Math.min(
      yesBook.asks.reduce((sum, level) => sum + level.size, 0),
      noBook.asks.reduce((sum, level) => sum + level.size, 0),
      config.maxPairShares,
    );
    if (available < config.minPairShares) continue;

    results.push(ledger.tryMergeCompleteSet({
      market, yesBook, noBook, shares: available,
      assumedMergeCostUsd: config.assumedMergeCostUsd,
      adverseSelectionBps: config.adverseSelectionBps,
      minNetEdgePerShare: config.minNetEdgePerShare,
    }));
  }
  return results;
}
