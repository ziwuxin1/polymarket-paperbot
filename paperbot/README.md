# PaperBot: fee-aware Polymarket strategy harness

This is a new, **read-only** module in the fork. It has no wallet configuration, does not load a private key, and contains no order-submission code.

## Why this was built from `MrFadiAi/Polymarket-bot`

That project is a useful TypeScript reference for Gamma/CLOB discovery, orderbook arbitrage, and risk controls. Its dashboard `DRY_RUN` path is not a reliable paper simulator: it records some signals at zero PnL and can credit an estimated arbitrage profit before an executable paired fill has been modelled. This module keeps the useful market-data idea but replaces that accounting model.

## Phase 1 strategy: paired complete-set arbitrage

For a two-outcome market, buy the two complementary outcomes only when the depth-weighted cost of both is below $1 **after**:

- consuming live ask levels from the CLOB snapshot;
- applying the market's `feeSchedule.rate` using `shares × feeRate × price × (1 - price)`;
- adding an explicit adverse-selection buffer; and
- adding a configurable merge/settlement cost.

The module reports and logs rejected signals too. That is intentional: a strategy is only validated if its rejected/filled decision boundary is auditable.

The simulator treats the paired purchase and complete-set merge as atomic. This is deliberately optimistic about real execution. A later live-readiness phase must instead model two independent FOK submissions, leg imbalance, merge mechanics, latency, and cancellation/recovery.

## Run

Requires Node 22+; there are no dependencies to install.

```powershell
cd paperbot
npm test
npm run scan
```

The scan reads public Gamma and CLOB APIs once. It appends every evaluated signal to `paperbot/data/paper-ledger.jsonl` and the top ten bid/ask levels for every scanned market to `paperbot/data/orderbook-observations.jsonl`. Both logs are ignored by Git so a future replay test uses the exact captured snapshot rather than a rewritten history.

Useful configuration:

```powershell
$env:PAPER_STARTING_CASH_USD = '1000'
$env:PAPER_MIN_LIQUIDITY_USD = '5000'
$env:PAPER_MAX_PAIR_SHARES = '25'
$env:PAPER_MIN_NET_EDGE_PER_SHARE = '0.01'
$env:PAPER_ASSUMED_MERGE_COST_USD = '0.15'
$env:PAPER_ADVERSE_SELECTION_BPS = '5'
npm run scan
```

`PAPER_LOOP_SECONDS=0` is the default. A loop is for data collection only; it does not make this executable trading software.

## Deliberately out of scope for phase 1

- smart-money copying (latency and survivor-bias need a separate event-time study);
- directional crypto signals (requires an independently verified reference price and resolution-time model);
- market making / LP (requires queue position and fill-probability modelling);
- private keys, CLOB API credentials, order submission, or any live trading mode.
