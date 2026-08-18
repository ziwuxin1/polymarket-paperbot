// A model asked about an event that already happened may simply know the answer,
// and no backtest can prove it did not. Forward-only evaluation is the only
// defence, so a contaminated prediction is refused rather than flagged.

export function isForwardLooking(market, atSeconds) {
  if (market.closed === true) return { ok: false, reason: 'market_already_closed' };
  if (market.active === false) return { ok: false, reason: 'market_not_active' };

  const endDate = market.endDateSeconds;
  if (endDate === null || endDate === undefined) return { ok: false, reason: 'no_end_date' };

  // A prediction stamped after the market's end date is a backfilled log
  // wearing a forward-looking costume.
  if (atSeconds >= endDate) return { ok: false, reason: 'market_end_date_passed' };

  return { ok: true, reason: null };
}

export function assertForwardLooking(market, atSeconds) {
  const verdict = isForwardLooking(market, atSeconds);
  if (!verdict.ok) {
    throw new Error(`Refusing to record a contaminated prediction: ${verdict.reason} (market ${market.id})`);
  }
  return verdict;
}
