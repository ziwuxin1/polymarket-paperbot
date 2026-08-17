# S2 — event-time copy trading, paper only

Design for the successor to S0. Read `paperbot/docs/STRATEGY_ROADMAP.md` first:
S0 is retired, and this document assumes that result rather than repeating it.

## What this is

A position-holding paper-trading harness that copies trades from wallets it has
decided are better informed, and measures whether copying them would have made
money after latency, slippage, fees, and exit costs.

It stays read-only. No private key, no CLOB credentials, no order submission.
Every "trade" is a record in a ledger.

## The claim being tested

> Some wallets on Polymarket are consistently better informed, and a follower who
> sees their trade only after it has printed can still enter at a price that
> leaves an edge after all costs.

This has three independent failure modes, and the harness must be able to
distinguish them. A negative result that cannot say *which* of these failed is
not a useful result.

1. **No alpha** — the wallets were never good, only lucky.
2. **Alpha exists but is not copyable** — the price has already moved by the time
   the trade is visible.
3. **Alpha is copyable but the exit destroys it** — entries are fine, exits are
   not.

## Why S0's failure does not predict this one

S0 died because the venue prices complete sets efficiently at the tick level.
That is a statement about a *mechanical* relationship between two tokens in the
same market, enforced by anyone running an arbitrage bot. It says nothing about
whether the market's *probability estimates* are well informed. S2 is a bet on
the second thing.

The relevant carry-over is methodological, not empirical: S0 proved the harness
can produce an auditable verdict, and proved that breadth beats duration when
sampling. Both apply here.

---

## Architecture

Five units, each independently testable. The existing `paperbot/src` modules are
reused unchanged except where noted.

```
wallet-selection  → picks candidate wallets from history, out of sample
trade-feed        → records source trades as events, with observation time
copy-decision     → decides whether a source trade is copyable, and at what price
position-ledger   → holds inventory, marks to market, applies exit rules
replay            → existing harness, extended for position-holding
```

### 1. `wallet-selection`

**Input:** a time cutoff `T_select`.
**Output:** a set of wallet addresses, chosen using only data before `T_select`.

The roadmap forbids picking wallets off a current leaderboard and calling the
result a backtest. That is survivor bias in its purest form: the leaderboard is
the list of wallets that already won.

Selection rules:

- Use only trades that closed before `T_select`. Everything after is out of
  sample and must never influence selection.
- Require a minimum number of *resolved* positions. A wallet with four wins is
  not evidence.
- Exclude wallets whose realised PnL is dominated by one position. Concretely:
  drop the wallet if removing its single best position turns cumulative PnL
  negative. One lottery ticket is not a strategy.
- Exclude wallets that traded predominantly in books too thin for a follower to
  enter. Their edge, if real, is not transferable.

Data: `GET /closed-positions?user=<addr>&sortBy=TIMESTAMP` for the resolved
record, `GET /trades?user=<addr>` for entry behaviour.

**Open problem, must be solved before implementation:** there is no public
endpoint that enumerates all wallets. Candidates have to come from somewhere,
and every source has a bias. The least-bad option is to harvest wallet addresses
from `GET /trades?market=<conditionId>` across a broad market sample — this
gives whoever was trading, not whoever won — then apply the selection rules
above to that pool. Record the harvest date; the pool is itself a sample with a
survivorship story.

### 2. `trade-feed`

**Input:** a wallet set and a time window.
**Output:** an append-only log of source-trade events.

Each event records both the source trade's own timestamp and the time the
harness observed it. The gap between them is the detection latency, and it must
be measured rather than assumed. The existing docs report Activity WebSocket
latency under 100ms; that is a live-streaming number and does not apply to a
polled backfill.

Two modes:

- **Backfill** (`GET /activity?user=<addr>&type=TRADE&start=&end=`) for building
  a historical corpus. Observation time is unknown, so it is recorded as null
  and the copy decision must use an explicit assumed latency.
- **Live** (polling the same endpoint on an interval) for measuring real
  detection latency. This is the only mode that produces a trustworthy latency
  number.

The distinction must be a field on every record. A corpus that mixes assumed and
measured latency without labelling which is which cannot be replayed honestly.

### 3. `copy-decision`

**Input:** a source trade, an assumed or measured latency, and the orderbook.
**Output:** a decision record — copied at a price, or rejected with a reason.

This is where the strategy either works or does not, and it is the part most
easily fudged. Rules:

- The copy price comes from **walking the book that existed at
  `source_timestamp + latency`**, not from the source trade's price. Copying at
  the source's own fill price is the single most common way a copy-trading
  backtest lies.
- Reuse `quoteBuy` for the entry. Size is capped independently of the source's
  size; a follower with $1,000 cannot copy a $50,000 position.
- Reject, and record the reason, when the book cannot fill the intended size,
  when the price has already moved past a configured tolerance, or when the
  source trade is below a minimum size worth copying.
- A rejection is data. The ratio of copyable to rejected signals is a headline
  result, not a footnote.

**Data gap to resolve during implementation:** the harness needs the orderbook as
it stood at a past moment. There is no historical orderbook endpoint. Two
options, and the choice must be made explicitly and recorded:

- *Live-forward collection* — run the feed live, snapshot books on each observed
  source trade. Honest, but produces data slowly.
- *Resolution-anchored approximation* — for resolved markets, reconstruct an
  entry price from the trade tape (`GET /trades?market=`) around the timestamp.
  Faster, but a tape is not a book: it shows what traded, not what was offered.
  Any result from this path must be labelled as an approximation.

Start with live-forward. S0's lesson was that a fast wrong sample is worse than
a slow right one.

### 4. `position-ledger`

The existing `PaperLedger` cannot be extended into this; it models an atomic
round trip with no inventory. This is a new module that reuses the fee curve and
the level-walking helpers.

State per position: token, market, size, average cost, entry time, source wallet,
and the source trade that triggered it.

Required operations:

- **Open** — from a copy decision. Cash decreases by notional plus fee.
- **Mark to market** — value the position at the price it could actually be
  *sold* at, which means walking the **bid** side. `quoteSell` does not exist yet
  and must be written as the mirror of `quoteBuy`. Marking at the midpoint or at
  the last trade would systematically overstate the book.
- **Close** — sell into the book, or redeem at resolution for 0 or 1.
- **Fees on both sides.** The current model charges the buy only.

Realised and unrealised PnL are reported separately at all times. A harness that
folds unrealised gains into a headline number is how paper trading flatters
itself.

### 5. Exit rules

S0 needed no exit. This does, and the exit rule is a strategy choice with real
consequences, so it is configurable and every run records which rule produced
its numbers.

- **Follow the source out** — close when the source wallet sells. Most faithful
  to the copy thesis, and subject to the same latency treatment as the entry.
- **Hold to resolution** — simplest, no exit-timing skill assumed, but ties up
  capital and takes the full variance.
- **Threshold** — take profit or stop loss at a configured move.
- **Time** — close after a fixed holding period.

Default: follow the source out, with hold-to-resolution as the fallback when the
source never sells. The thesis is "these wallets are better informed", and that
claim covers their exits as much as their entries.

---

## Promotion gates

S0's gates assumed a market-neutral instantaneous trade. These replace them for
S2, and they are deliberately harder to satisfy.

1. At least 500 copied decisions across at least 50 distinct source wallets and
   200 distinct markets. Breadth in both dimensions — S0 showed that a large
   decision count over a narrow universe is a false sample size.
2. Positive after fees at the measured latency, and still positive at 2× and 5×
   that latency. If it only works at the latency you happen to have, it does not
   work.
3. Wallet selection uses only pre-cutoff data, and the reported result covers
   only post-cutoff trades. Selection and evaluation windows must not overlap.
4. Results reported per exit rule, not only for the best one.
5. Rejected copies counted and reported. A strategy that only works on the 5% of
   signals that were fillable must say so.
6. The result must attribute failure to one of the three failure modes above.

---

## What is deliberately excluded

- Order submission, private keys, credentials, or any live path. Unchanged from
  S0 and non-negotiable.
- Following order placements rather than fills. The existing analysis established
  this is not observable for other wallets.
- Latency optimisation. Measure it first; there is no point optimising a number
  before knowing whether the strategy tolerates it.
- The dashboard at the repository root. It belongs to the original bot.

## Testing

Every unit gets tests before implementation, matching the existing harness. The
cases that matter most are the ones where a copy-trading backtest usually cheats:

- A copy priced from the source's fill price instead of the follower's book is a
  test failure, not a rounding difference.
- Mark-to-market on the ask side, or at the midpoint, is a test failure.
- A wallet selected using post-cutoff data is a test failure.
- A source trade too large for the follower's book must reject, never partially
  fill silently.
- Fees must be charged on both entry and exit.
