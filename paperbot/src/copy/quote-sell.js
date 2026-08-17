// Mirror of quoteBuy. Selling consumes the bid side from the highest price
// downward; a position is only ever worth what the bids will actually pay.
export function quoteSell(bids, requestedShares) {
  let remaining = requestedShares;
  let filled = 0;
  let notional = 0;

  for (const level of bids) {
    if (remaining <= 0) break;
    const shares = Math.min(remaining, level.size);
    filled += shares;
    notional += shares * level.price;
    remaining -= shares;
  }

  return { filled, notional, averagePrice: filled ? notional / filled : null, remaining };
}
