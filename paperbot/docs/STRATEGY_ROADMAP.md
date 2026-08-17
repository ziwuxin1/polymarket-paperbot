# Strategy roadmap and promotion gates

The fork starts with an execution strategy, not a price-prediction claim. A strategy does not graduate because its dashboard PnL is green; it graduates only after every assumption has been tested against recorded market data.

## S0 — paired complete-set arbitrage (active)

Buy both complementary outcomes only if their depth-weighted ask cost plus fee, adverse-selection buffer, and merge cost is below $1. It is a baseline for data correctness, fee accounting, book-depth handling, and hard risk limits.

The paper model is still optimistic about two-legged execution because it merges a complete set atomically. It must not be converted to live execution without first replacing that assumption with individual FOK legs, an imbalance state machine, and an explicit recovery cost.

### First measurement against the real deep-book universe (2026-08-17)

An earlier version of market discovery sorted on Gamma's `liquidity` column, which Gamma
sorts as a **string**: `"9998"` outranked `"500000"`. Every observation recorded before this
date therefore describes a universe with a median liquidity of about $100, not the deepest
books. Those logs are kept as `data/*.pre-liquidity-fix.jsonl` and must be excluded from any
replay corpus.

The first scan after the fix covered 50 markets with a median liquidity of $2.2M:

| Measure | Value |
|---|---|
| Markets with best-level YES+NO ask sum below $1.00 | **0 of 49** |
| Best-level pair sum, every market | $1.0010 — exactly one tick above par |
| Net edge per share | −0.0077 (best −0.0076, worst −0.0082) |

S0 is **gross-negative before any friction is applied**. The whole spread available is 0.1¢,
while the assumed merge cost alone is 0.6¢ per share at 25 shares. Because the deficit is
gross, no sizing change rescues it: increasing size amortises the fixed merge cost but cannot
lift a pair sum that already starts above $1.00. Searching for an optimal size, which the
scanner does not currently do, would not have found a signal in this sample.

This does not yet retire S0 — one snapshot is not a distribution, and the gate-1 target of
5,000 decisions still stands. It does set the bar: S0 is only worth carrying forward if
repeated sampling finds pair sums that cross par at all. Record how often that happens before
spending any more effort on the execution model.

### Gate 1 result: S0 retired (2026-08-17)

| | |
|---|---|
| Decisions | **6,652** (gate-1 target 5,000) |
| Distinct markets | **1,081** |
| Span | 11h 09m, 06:53Z → 18:02Z |
| Gross pair sum below $1.00 | **0** |
| Fills at any adverse-selection assumption | **0** |
| `gate1.met` / `gate2.met` | `true` / `false` |

Gate 1 is met and **gate 2 fails, but not for the reason the gate was written to catch.** It
was designed to kill a strategy whose edge evaporates under a wider adverse-selection buffer.
S0 never produced a single fill to stress, so the buffer sweep was never exercised on real
signals. The result is stronger than the gate anticipated: there is nothing to stress.

Two axes were tested and only one of them mattered:

- **Time** — 1,524 observations over 3.9h, but only 50 distinct markets. Resampling the same
  books every five minutes inflates the denominator without adding information. Do not read a
  decision count as a sample size again without checking `distinctMarkets` beside it.
- **Breadth** — 1,081 independent markets. This is the axis that answers the question.

With 0 events in 1,081 independent markets, the rule of three puts the 95% upper bound on the
instantaneous below-par rate at **0.28%**. Complete-set arbitrage is priced out of this venue:
observed pair sums sat at exactly one tick above par, which is where a maker who is paying
attention would put them.

**S0 is retired.** Do not spend further effort on its execution model — the two-legged FOK
state machine, imbalance handling, and merge-recovery cost described above are all work in
service of an edge that does not exist. The harness itself carries forward unchanged: the
ledger, the fee model, the replay, and the gates are strategy-agnostic and S1 should reuse
them rather than start over.

What this does **not** establish: nothing here rules out below-par pairs in markets below the
$1,000 liquidity floor, during resolution or news events rather than a quiet sample, or on
venues other than Polymarket. Those are separate questions and none of them are S0.

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
