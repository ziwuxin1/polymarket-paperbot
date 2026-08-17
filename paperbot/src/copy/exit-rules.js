// The exit rule is a strategy choice with real consequences, so it is explicit
// and every run records which rule produced its numbers. Reporting only the
// best-performing rule would be curve fitting by menu.
export const EXIT_RULES = new Set(['follow_source', 'hold_to_resolution', 'threshold', 'time']);

const HOLD = { exit: false, reason: null };
const RESOLVE = { exit: true, reason: 'resolution' };

export function shouldExit({ rule, position, context, config }) {
  if (!EXIT_RULES.has(rule)) throw new Error(`Unknown exit rule: ${rule}`);

  // Resolution ends every position regardless of rule; the token stops existing.
  if (context.marketResolved) return RESOLVE;

  switch (rule) {
    case 'hold_to_resolution':
      return HOLD;

    case 'follow_source':
      // The claim is that these wallets are better informed. That covers their
      // exits as much as their entries.
      return context.sourceHasExited ? { exit: true, reason: 'source_exited' } : HOLD;

    case 'threshold':
      return thresholdExit(position, context, config);

    case 'time':
      return context.nowSeconds - position.openedAt >= config.maxHoldingSeconds
        ? { exit: true, reason: 'max_holding_period' }
        : HOLD;

    default:
      throw new Error(`Unhandled exit rule: ${rule}`);
  }
}

function thresholdExit(position, context, config) {
  // A null mark means the bid side could not price the position at all.
  // Treating that as a stop-loss would invent an exit the book never offered.
  if (context.markPrice === null || context.markPrice === undefined) {
    return { exit: false, reason: 'unmarkable' };
  }

  const move = context.markPrice - position.averageCost;
  if (config.takeProfit !== undefined && move >= config.takeProfit) {
    return { exit: true, reason: 'take_profit' };
  }
  if (config.stopLoss !== undefined && move <= -config.stopLoss) {
    return { exit: true, reason: 'stop_loss' };
  }
  return HOLD;
}
