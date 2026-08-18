// Disagreement between forecasters is information, and averaging destroys it.
// A split panel should bet less, not bet the midpoint with the same confidence.
export function combineForecasts(forecasts, { disagreementPenalty = 1 } = {}) {
  const usable = forecasts.filter(
    (forecast) => typeof forecast?.probability === 'number' && Number.isFinite(forecast.probability),
  );
  if (usable.length === 0) {
    return { probability: null, disagreement: null, thresholdPenalty: null, contributors: 0 };
  }

  const totalWeight = usable.reduce((sum, forecast) => sum + (forecast.weight ?? 1), 0);
  const probability = usable.reduce(
    (sum, forecast) => sum + forecast.probability * (forecast.weight ?? 1), 0,
  ) / totalWeight;

  // Weighted mean absolute deviation: 0 when the panel agrees.
  const disagreement = usable.reduce(
    (sum, forecast) => sum + Math.abs(forecast.probability - probability) * (forecast.weight ?? 1), 0,
  ) / totalWeight;

  return {
    probability,
    disagreement,
    thresholdPenalty: disagreement * disagreementPenalty,
    contributors: usable.length,
  };
}
