// A collection run should end by reaching its target, not by being killed.
export function hasReachedTarget({ recordedDecisions, targetDecisions }) {
  if (!targetDecisions || targetDecisions <= 0) return false;
  return recordedDecisions >= targetDecisions;
}
