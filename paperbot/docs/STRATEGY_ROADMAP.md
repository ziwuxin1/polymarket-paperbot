# Strategy roadmap and promotion gates

The fork starts with an execution strategy, not a price-prediction claim. A strategy does not graduate because its dashboard PnL is green; it graduates only after every assumption has been tested against recorded market data.

## S0 — paired complete-set arbitrage (active)

Buy both complementary outcomes only if their depth-weighted ask cost plus fee, adverse-selection buffer, and merge cost is below $1. It is a baseline for data correctness, fee accounting, book-depth handling, and hard risk limits.

The paper model is still optimistic about two-legged execution because it merges a complete set atomically. It must not be converted to live execution without first replacing that assumption with individual FOK legs, an imbalance state machine, and an explicit recovery cost.

## S1 — crypto resolution-price divergence (research only)

For short-dated crypto markets, build a fair-probability model from the independently recorded reference price, strike, time remaining, and realised volatility. The entry condition is not “BTC is rising”; it is `model probability - executable ask probability > all-in threshold`.

Required data before evaluation:

- the Polymarket orderbook snapshot and exact market resolution rule;
- a timestamped external reference-price feed; and
- outcome resolution and post-entry mark data.

## S2 — event-time smart-money following (research only)

Do not select wallets from a current leaderboard and call that a backtest. Record each observed source trade first, then evaluate copied entry price, latency, fillability, exit rule, and performance out of sample. Exclude wallets whose edge is primarily one exceptional trade or who routinely trade in books too thin to copy.

## S3 — market making / LP (deferred)

The LP repository is useful for quote-maintenance mechanics, not for directional alpha. This strategy needs queue position, fill probability, inventory skew, stale-quote detection, and actual maker-rebate records. It cannot be judged by midpoint PnL alone.

## Promotion gates

1. Collect enough timestamped orderbook observations to replay at least 5,000 candidate decisions.
2. Run the same replay with baseline, +5 bps, and +20 bps adverse-selection assumptions. It must remain profitable in every version.
3. Count partial-fill and stale-book cases as losses or rejects; never silently convert them to a full fill.
4. Split parameters by time: tune only on the first segment and report the final segment without retuning.
5. Before any execution integration, run a shadow period that emits an order intent but has no signing, no credentials, and no network write path.
