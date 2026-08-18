// One LLM forecaster. Returns null rather than a guess when it cannot produce a
// calibrated number — a fabricated probability is worse than a missing one.
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const PROMPT = `You are forecasting a prediction market. Answer with a probability only.

Question: {QUESTION}
Resolves: {END_DATE}

Reply with strict JSON and nothing else:
{"probability": <number between 0 and 1>, "reasoning": "<one sentence>"}

Do not consider the market price. Give your own estimate.`;

export async function llmForecast(context, { model, apiKey, fetchImpl = fetch } = {}) {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) return { forecaster: `llm:${model}`, probability: null, rationale: 'no ANTHROPIC_API_KEY' };

  const prompt = PROMPT
    .replace('{QUESTION}', context.question)
    .replace('{END_DATE}', context.endDate ?? 'unknown');

  try {
    const response = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model, max_tokens: 300, messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      return { forecaster: `llm:${model}`, probability: null, rationale: `HTTP ${response.status}` };
    }

    const body = await response.json();
    const text = body?.content?.map((block) => block.text ?? '').join('') ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { forecaster: `llm:${model}`, probability: null, rationale: 'unparseable reply' };

    const parsed = JSON.parse(match[0]);
    const probability = Number(parsed.probability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      return { forecaster: `llm:${model}`, probability: null, rationale: 'probability out of range' };
    }
    return { forecaster: `llm:${model}`, version: model, probability, rationale: parsed.reasoning ?? null };
  } catch (error) {
    return { forecaster: `llm:${model}`, probability: null, rationale: error.message };
  }
}
