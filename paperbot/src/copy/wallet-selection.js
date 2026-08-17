// Selecting wallets from a current leaderboard and calling the result a backtest
// is survivor bias: the leaderboard IS the list of wallets that already won.
// Every rule here runs on data strictly before the cutoff, and the evaluation
// window is everything after it.

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function walletStats({ closedPositions, selectionCutoff }) {
  const inWindow = closedPositions.filter((position) => Number(position.timestamp) < selectionCutoff);
  const pnls = inWindow.map((position) => Number(position.realizedPnl) || 0);
  const totalPnl = pnls.reduce((sum, pnl) => sum + pnl, 0);
  const bestPnl = pnls.length ? Math.max(...pnls) : 0;

  return {
    resolvedPositions: inWindow.length,
    totalPnl,
    bestPnl,
    // The test that kills lottery tickets: strip the single best result and see
    // whether anything is left.
    pnlWithoutBest: totalPnl - bestPnl,
    medianPositionUsd: median(inWindow.map((position) => Number(position.totalBought) || 0)),
    distinctMarkets: new Set(inWindow.map((position) => position.conditionId)).size,
  };
}

export function selectWallets({
  candidates,
  selectionCutoff,
  minResolvedPositions,
  minMedianPositionUsd,
  minDistinctMarkets,
}) {
  const selected = [];
  const rejected = [];

  for (const candidate of candidates) {
    const stats = walletStats({
      closedPositions: candidate.closedPositions ?? [],
      selectionCutoff,
    });
    const record = { wallet: candidate.wallet, ...stats };

    const reason = rejectionReason(stats, {
      minResolvedPositions, minMedianPositionUsd, minDistinctMarkets,
    });
    if (reason) rejected.push({ ...record, reason });
    else selected.push(record);
  }

  return { selected, rejected, selectionCutoff };
}

function rejectionReason(stats, { minResolvedPositions, minMedianPositionUsd, minDistinctMarkets }) {
  if (stats.resolvedPositions < minResolvedPositions) return 'too_few_resolved_positions';
  if (stats.totalPnl <= 0) return 'not_profitable';
  if (stats.pnlWithoutBest <= 0) return 'single_position_dependent';
  if (stats.medianPositionUsd < minMedianPositionUsd) return 'positions_too_small_to_copy';
  if (stats.distinctMarkets < minDistinctMarkets) return 'too_few_distinct_markets';
  return null;
}
