const EPSILON = 1e-6;

function requireOutcome(record) {
  const outcome = record.outcome;
  if (outcome !== 0 && outcome !== 1) {
    throw new Error(`Scoring requires a resolved outcome of 0 or 1, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

export function brierScore(records) {
  if (records.length === 0) return null;
  const total = records.reduce((sum, record) => {
    const error = record.probability - requireOutcome(record);
    return sum + error * error;
  }, 0);
  return total / records.length;
}

// An unclamped log loss is Infinity for a confident miss, which poisons the
// average and hides everything else. Clamp instead.
export function logLoss(records) {
  if (records.length === 0) return null;
  const total = records.reduce((sum, record) => {
    const outcome = requireOutcome(record);
    const p = Math.min(Math.max(record.probability, EPSILON), 1 - EPSILON);
    return sum - (outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p));
  }, 0);
  return total / records.length;
}

export function calibrationBins(records, binCount = 10) {
  const bins = Array.from({ length: binCount }, (_, index) => ({
    from: index / binCount,
    to: (index + 1) / binCount,
    count: 0,
    predictedMean: 0,
    observedFrequency: 0,
  }));

  for (const record of records) {
    const outcome = requireOutcome(record);
    const index = Math.min(Math.floor(record.probability * binCount), binCount - 1);
    const bin = bins[index];
    bin.predictedMean = (bin.predictedMean * bin.count + record.probability) / (bin.count + 1);
    bin.observedFrequency = (bin.observedFrequency * bin.count + outcome) / (bin.count + 1);
    bin.count += 1;
  }

  return bins;
}

// The benchmark for a prediction-market forecaster is the price, not a coin
// flip. Skill is what the model knows that the price did not.
export function scoreSeries(resolved, { binCount = 10 } = {}) {
  const series = (pick) => resolved.map((record) => ({
    probability: pick(record), outcome: record.outcome,
  }));

  const model = series((record) => record.modelProbability);
  const market = series((record) => record.marketProbability);
  const constant = series(() => 0.5);

  const summarize = (records) => ({
    brier: brierScore(records),
    logLoss: logLoss(records),
    calibration: calibrationBins(records, binCount),
  });

  const modelScore = summarize(model);
  const marketScore = summarize(market);

  return {
    sampleSize: resolved.length,
    distinctMarkets: new Set(resolved.map((record) => record.conditionId ?? record.marketId)).size,
    model: modelScore,
    market: marketScore,
    constant: summarize(constant),
    // Positive means the model knows something the price does not.
    skillVsMarket: marketScore.brier === null ? null : marketScore.brier - modelScore.brier,
  };
}
