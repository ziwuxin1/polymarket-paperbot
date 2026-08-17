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

The scan reads public Gamma and CLOB APIs once. It appends every evaluated signal to `paperbot/data/paper-ledger.jsonl` and the top ten bid/ask levels for every scanned market to `paperbot/data/orderbook-observations.jsonl`. Both logs are ignored by Git so a future replay test uses the exact captured snapshot rather than a rewritten history. Filled and rejected records carry the same flat identity fields (`marketId`, `market`, `slug`, `feeRate`, `orderbookHashes`), so a replay never has to branch on status to read a decision.

Market discovery sorts on Gamma's `liquidityNum` column. Do not switch it back to `liquidity`:
that column is sorted as a string, so `"9998"` outranks `"500000"` and the scan silently ends up
reading dead books instead of deep ones. See `docs/STRATEGY_ROADMAP.md` for what that bug cost.

## Replay

```powershell
npm run replay
```

Replays the captured `orderbook-observations.jsonl` through the same ledger and strategy code,
oldest observation first, at the baseline adverse-selection buffer plus the +5 bps and +20 bps
variants that promotion gate 2 requires. It reports gate 1 (decision count) and gate 2
(profitable in every variant) as explicit pass/fail rather than a single PnL number.

Replay is deliberately more conservative than the live scan: observations store only the top
ten levels per side, so a large size can under-fill on replay but can never over-fill.

`PAPER_REPLAY_CORPUS` points at a different corpus file. `PAPER_DATA_DIR` redirects both scan
logs, which is how a threshold-relaxed smoke test avoids contaminating the real corpus:

```powershell
$env:PAPER_DATA_DIR = 'data/smoke'
$env:PAPER_MIN_NET_EDGE_PER_SHARE = '-1'
npm run scan
```

That forces fills so the accounting path is exercised end to end. It proves the ledger is
self-consistent; it proves nothing about the strategy.

If a relaxed threshold or a smoke directory is still set when `npm run replay` runs, the
report sets `trustworthy: false` and lists why. Do not read a gate result off a run that is
not trustworthy.

### In `cmd.exe` rather than PowerShell

Use `cd /d` to change drive, and **quote the whole assignment** — `set VAR=x && ...` captures
the space before `&&` into the value:

```
cd /d "G:\path\to\paperbot"
set "PAPER_DATA_DIR=data/smoke" && set "PAPER_MIN_NET_EDGE_PER_SHARE=-1" && npm run scan
```

`set` persists for the life of the window, so clear the smoke settings (`set "PAPER_DATA_DIR="`)
or open a new window before the next real scan.

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

## S2 — copy trading (position-holding)

S0 is retired; see `docs/STRATEGY_ROADMAP.md`. S2 copies trades from wallets
selected out of sample and measures whether following them survives latency,
slippage, fees, and the exit. Design: `../docs/superpowers/specs/2026-08-17-s2-copy-trading-design.md`.

Still read-only. No key, no credentials, no order path.

```powershell
npm run copy:discover   # harvest candidate wallets and select out of sample
npm run copy:watch      # live-forward collection: source trades + the book at that moment
npm run copy:report     # run the session across exit rules and latency variants, print gates
```

`copy:discover` harvests from market trade tape, never a leaderboard — the pool
must be "who traded", not "who won". Selection uses only data before
`COPY_SELECTION_CUTOFF` (default 30 days ago); everything after it is the
evaluation window and must never influence selection.

`copy:watch` snapshots the orderbook at the moment a watched wallet's trade is
observed. That snapshot is the only honest basis for a copy price: Polymarket
has no historical orderbook endpoint, so entries cannot be reconstructed after
the fact. Set `COPY_TARGET_OBSERVATIONS` so a collection run ends by reaching
its target rather than running until something kills it.

Two rules the tests enforce, because they are how copy-trading backtests
usually flatter themselves:

- the copy price comes from walking the **follower's** book at
  `source timestamp + latency`, never from the source's own fill price;
- an open position is marked against the **bid** side, never the ask or the
  midpoint.

## Deliberately out of scope for phase 1

- smart-money copying (latency and survivor-bias need a separate event-time study);
- directional crypto signals (requires an independently verified reference price and resolution-time model);
- market making / LP (requires queue position and fill-probability modelling);
- private keys, CLOB API credentials, order submission, or any live trading mode.
