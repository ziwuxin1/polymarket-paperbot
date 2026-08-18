# S1 — forecast versus market, paper only

Design for a probability-model strategy. Read `paperbot/docs/STRATEGY_ROADMAP.md`
first. S0 is retired; this reuses its harness.

## What this is

A harness that records a probability forecast for a market **before** that market
resolves, scores it after resolution, and only then asks whether betting the
disagreement would have made money.

The forecaster is pluggable. An LLM ensemble is one implementation; it is not
privileged, and it must earn its place against a baseline.

## The two failure modes this design exists to prevent

### 1. Contamination

A model asked about an event that already happened may simply know the answer.
Backtesting a language model on resolved markets produces spectacular results
that mean nothing, because the outcome was in the training data or reachable by
search.

There is no reliable way to prove a given event was outside a model's knowledge.
Therefore: **forward-only**. A prediction is valid only if it is recorded while
the market is still open, with a timestamp, and scored later. Any prediction
made against an already-resolved market is rejected by the harness, not merely
discouraged.

This makes S1 slow. That is the cost of the result meaning anything.

### 2. Benchmarking against the wrong thing

The benchmark for a prediction market forecaster is **the market price**, not a
coin flip. A model with a Brier score of 0.18 sounds good until the market's own
implied probability scores 0.15 on the same questions, at which point the model
is worse than free.

The harness therefore always scores three series on identical questions:

| Series | What it is |
|---|---|
| `market` | the executable mid at prediction time — the benchmark |
| `model` | the forecaster under test |
| `constant` | always 0.5 — a floor, to catch a scoring bug |

**Skill** is `brier(market) - brier(model)`. Positive means the model knows
something the price does not. Everything downstream is conditional on this being
positive; a model that cannot beat the price has no business sizing a bet.

## Architecture

Reuses `paper-ledger` (fee curve, `quoteBuy`), `copy/quote-sell`, and
`copy/position-ledger` unchanged. New units:

```
contamination   → rejects any prediction that is not strictly forward-looking
prediction-log  → append-only record of forecasts, one file per run
scoring         → Brier, log loss, calibration bins, skill against the market
edge-decision   → model probability vs executable ask → trade or reject
predictors/     → pluggable; market-baseline and llm-ensemble
```

### contamination

Rejects a prediction when the market is closed, already resolved, or its end
date has passed at prediction time. Also rejects a prediction whose recorded
timestamp is after the market's end date — that catches a backfilled log
masquerading as forward-looking.

### prediction-log

Each record carries: market id, condition id, token id, the forecaster's
identity and version, the model probability, the market's implied probability at
that moment, the executable ask and bid, the timestamp, and the market end date.
Resolution is written later as a separate record keyed by prediction id, so a
prediction can never be silently edited after the outcome is known.

### scoring

Brier score, log loss, and calibration in ten bins, computed for all three
series over the same resolved questions. Reports sample size beside every
number: a Brier score over eleven questions is not a measurement.

### edge-decision

The bet is not "the model says yes". It is
`model probability − executable ask price > all-in threshold`, where the ask
comes from walking the book, and the threshold covers fee, adverse selection,
and the resolution-time cost of being wrong. Reuses `quoteBuy`; a book that
cannot fill the size rejects rather than partially filling.

### predictors

A predictor is `async (market, context) => { probability, rationale, version }`.

- `market-baseline` returns the market's own implied probability. It is the
  control: any real forecaster must beat it, and if the harness ever reports it
  as having skill, the harness is broken.
- `llm-ensemble` queries several models and combines them. Disagreement widens
  the threshold rather than being averaged away — when models disagree, the
  honest response is to bet less, not to split the difference.

## Promotion gates

1. At least 200 resolved forward-only predictions across at least 50 markets.
2. Positive skill against the market benchmark, with the sample size reported.
   This gate is prior to any PnL claim.
3. Calibration reported, not just discrimination. A model that is right about
   ordering but wrong about magnitude cannot be sized.
4. No prediction scored against a market that had resolved when it was made.
   Enforced in code and asserted in tests.
5. PnL reported after fees at the executable price, never at the midpoint.
6. The baseline and constant series reported alongside the model, always.

## Out of scope

Order submission, keys, credentials. Unchanged and non-negotiable.
