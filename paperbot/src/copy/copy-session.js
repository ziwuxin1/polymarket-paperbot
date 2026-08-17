import { decideCopy } from './copy-decision.js';
import { shouldExit } from './exit-rules.js';
import { PositionLedger } from './position-ledger.js';

const GATE1 = { decisions: 500, wallets: 50, markets: 200 };
const LATENCY_VARIANTS = [1, 2, 5];

// Replays source trades in time order against the follower's own book. Entries
// come from BUYs; exits come from the configured rule, which for follow_source
// means a SELL by the same wallet in the same token.
export function runCopySession({ sourceTrades, marketsByCondition, bookProvider, config }) {
  const ledger = new PositionLedger(config.startingCashUsd);
  const ordered = [...sourceTrades].sort((left, right) => left.timestampSeconds - right.timestampSeconds);
  const copied = [];
  const rejected = [];
  const exits = [];
  // Only a copy opened from wallet W in token T may be closed by W selling T.
  const openByWalletToken = new Map();

  for (const trade of ordered) {
    const key = `${trade.wallet}:${trade.tokenId}`;
    const book = bookProvider(trade.tokenId, trade.timestampSeconds + (config.assumedLatencySeconds ?? 0));
    if (!book) continue;

    if (trade.side === 'BUY') {
      const decision = decideCopy({ sourceTrade: trade, book, config, cashUsd: ledger.cashUsd });
      if (decision.status !== 'copy') {
        rejected.push(decision);
        continue;
      }

      const market = marketsByCondition[trade.conditionId];
      const position = ledger.open({
        market, tokenId: trade.tokenId, shares: decision.shares, book,
        source: { wallet: trade.wallet, timestampSeconds: trade.timestampSeconds },
        timestamp: trade.timestampSeconds,
      });
      if (position.status !== 'open') {
        rejected.push({ ...decision, status: 'rejected', reason: position.reason });
        continue;
      }
      copied.push({ ...decision, positionId: position.id });
      openByWalletToken.set(key, position.id);
      continue;
    }

    // A SELL is only an exit signal for a position this wallet's buy opened.
    const positionId = openByWalletToken.get(key);
    if (!positionId) continue;

    const position = ledger.positions.get(positionId);
    const mark = ledger.markToMarket(positionId, book);
    const verdict = shouldExit({
      rule: config.exitRule,
      position,
      context: {
        nowSeconds: trade.timestampSeconds,
        markPrice: mark.markPrice,
        sourceHasExited: true,
        marketResolved: false,
      },
      config,
    });
    if (!verdict.exit) continue;

    const closed = ledger.close({
      positionId, book, reason: verdict.reason, timestamp: trade.timestampSeconds,
    });
    if (closed.status === 'unclosable') {
      exits.push({ positionId, status: 'unclosable', reason: closed.reason });
      continue;
    }
    openByWalletToken.delete(key);
    exits.push({ positionId, reason: verdict.reason, realizedPnl: closed.realizedPnl });
  }

  const booksByToken = {};
  for (const position of ledger.openPositions()) {
    const book = bookProvider(position.tokenId, null);
    if (book) booksByToken[position.tokenId] = book;
  }

  return { summary: ledger.summary(booksByToken), copied, rejected, exits, ledger };
}

export function copyGateReport({
  copied, rejected, summary, config,
  latencyVariants = null, windows = null, perExitRule = null, attribution = null,
}) {
  const distinctWallets = new Set(copied.map((decision) => decision.wallet)).size;
  const distinctMarkets = new Set(copied.map((decision) => decision.conditionId)).size;
  const total = copied.length + rejected.length;

  const gate1 = {
    requirement: `${GATE1.decisions} copies across ${GATE1.wallets} wallets and ${GATE1.markets} markets`,
    decisions: copied.length, distinctWallets, distinctMarkets,
    met: copied.length >= GATE1.decisions
      && distinctWallets >= GATE1.wallets
      && distinctMarkets >= GATE1.markets,
  };

  const gate2 = {
    requirement: `profitable at ${LATENCY_VARIANTS.join('x, ')}x latency`,
    variants: latencyVariants,
    met: Array.isArray(latencyVariants)
      && latencyVariants.length > 0
      && latencyVariants.every((variant) => variant.realizedPnlUsd > 0),
  };

  const gate3 = {
    requirement: 'selection and evaluation windows must not overlap',
    windows,
    met: Boolean(windows) && windows.evaluationStart >= windows.selectionCutoff,
  };

  const gate4 = {
    requirement: 'results reported for every exit rule, not only the best',
    perExitRule,
    met: Boolean(perExitRule) && Object.keys(perExitRule).length > 1,
  };

  const gate5 = {
    requirement: 'rejected copies counted and reported',
    copied: copied.length, rejected: rejected.length,
    rejectRate: total > 0 ? rejected.length / total : null,
    reasons: countReasons(rejected),
    met: true,
  };

  const gate6 = {
    requirement: 'failure attributed to one of the three modes',
    attribution,
    met: summary.realizedPnlUsd > 0 || attribution !== null,
  };

  return { gate1, gate2, gate3, gate4, gate5, gate6, exitRule: config.exitRule };
}

// A negative result that cannot say WHICH assumption failed is not a useful
// result. These three modes are independent and need different follow-ups.
export function attributeFailure({ sourceWalletPnlUsd, copyRejectRate, entryEdgeUsd, realizedPnlUsd }) {
  if (realizedPnlUsd > 0) return null;
  if (sourceWalletPnlUsd <= 0) return 'no_alpha';
  if (copyRejectRate >= 0.5) return 'not_copyable';
  if (entryEdgeUsd > 0) return 'exit_destroys_edge';
  return 'not_copyable';
}

function countReasons(rejected) {
  const counts = {};
  for (const decision of rejected) {
    counts[decision.reason] = (counts[decision.reason] ?? 0) + 1;
  }
  return counts;
}
