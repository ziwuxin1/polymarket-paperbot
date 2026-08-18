// The control. Any real forecaster must beat this; if the harness ever reports
// the baseline as having skill against the market, the harness is broken.
export async function marketBaseline(context) {
  return {
    forecaster: 'market-baseline',
    version: '1',
    probability: context.impliedProbability,
    rationale: 'Returns the market price unchanged.',
  };
}
