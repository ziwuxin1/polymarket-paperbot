import test from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_RULES, shouldExit } from '../src/copy/exit-rules.js';

const position = {
  id: 'p1', tokenId: 't1', shares: 10, averageCost: 0.40,
  openedAt: 1_700_000_000, source: { wallet: '0xabc' },
};

const context = {
  nowSeconds: 1_700_000_100,
  markPrice: 0.40,
  sourceHasExited: false,
  marketResolved: false,
};

test('every rule name is a known rule', () => {
  assert.deepEqual(
    [...EXIT_RULES].sort(),
    ['follow_source', 'hold_to_resolution', 'threshold', 'time'],
  );
});

test('follow_source holds while the source holds and exits when the source sells', () => {
  const holding = shouldExit({ rule: 'follow_source', position, context, config: {} });
  assert.equal(holding.exit, false);

  const exited = shouldExit({
    rule: 'follow_source', position,
    context: { ...context, sourceHasExited: true }, config: {},
  });
  assert.equal(exited.exit, true);
  assert.equal(exited.reason, 'source_exited');
});

test('follow_source falls back to resolution when the source never sells', () => {
  // The thesis is that these wallets are better informed, which covers their
  // exits too. But a source that simply holds to resolution must not leave the
  // follower holding forever with no exit path.
  const resolved = shouldExit({
    rule: 'follow_source', position,
    context: { ...context, marketResolved: true }, config: {},
  });
  assert.equal(resolved.exit, true);
  assert.equal(resolved.reason, 'resolution');
});

test('hold_to_resolution ignores price moves entirely', () => {
  const crashed = shouldExit({
    rule: 'hold_to_resolution', position,
    context: { ...context, markPrice: 0.01, sourceHasExited: true },
    config: { stopLoss: 0.05 },
  });
  assert.equal(crashed.exit, false);

  const resolved = shouldExit({
    rule: 'hold_to_resolution', position,
    context: { ...context, marketResolved: true }, config: {},
  });
  assert.equal(resolved.exit, true);
});

test('threshold exits on a take profit and on a stop loss', () => {
  const config = { takeProfit: 0.10, stopLoss: 0.10 };

  const won = shouldExit({
    rule: 'threshold', position, context: { ...context, markPrice: 0.51 }, config,
  });
  assert.equal(won.exit, true);
  assert.equal(won.reason, 'take_profit');

  const lost = shouldExit({
    rule: 'threshold', position, context: { ...context, markPrice: 0.29 }, config,
  });
  assert.equal(lost.exit, true);
  assert.equal(lost.reason, 'stop_loss');

  const flat = shouldExit({
    rule: 'threshold', position, context: { ...context, markPrice: 0.42 }, config,
  });
  assert.equal(flat.exit, false);
});

test('time exits once the holding period is exceeded', () => {
  const config = { maxHoldingSeconds: 60 };

  const early = shouldExit({
    rule: 'time', position, context: { ...context, nowSeconds: 1_700_000_030 }, config,
  });
  assert.equal(early.exit, false);

  const late = shouldExit({
    rule: 'time', position, context: { ...context, nowSeconds: 1_700_000_100 }, config,
  });
  assert.equal(late.exit, true);
  assert.equal(late.reason, 'max_holding_period');
});

test('an unmarked position cannot trigger a price-based exit', () => {
  // A null mark means the bids could not price the position. Treating that as
  // a stop-loss would invent an exit the book never offered.
  const decision = shouldExit({
    rule: 'threshold', position,
    context: { ...context, markPrice: null }, config: { stopLoss: 0.10 },
  });
  assert.equal(decision.exit, false);
  assert.equal(decision.reason, 'unmarkable');
});

test('an unknown rule raises rather than silently holding forever', () => {
  assert.throws(
    () => shouldExit({ rule: 'vibes', position, context, config: {} }),
    /vibes/,
  );
});
