// analyzer.js — HuggingFace LLM wrapper for the Sentiment Agent.
//
// Accepts a symbol and an array of headline strings, submits them to
// the HuggingFace Inference Router (OpenAI-compatible chat completions),
// and returns a quantitative conviction score plus a one-sentence reasoning.
//
// Prompt engineering decisions:
//   • Model: DeepSeek-V3-0324 via HuggingFace router — fast, cost-effective.
//   • Temperature: 0 — deterministic output, critical for backtesting
//     reproducibility; the same headlines always produce the same score.
//   • System message frames the model as a high-frequency trading sentiment
//     analyzer and mandates strict raw JSON output (no markdown, no prose).
//   • Output schema is enforced textually and validated programmatically:
//       { "conviction_score": <int 1-100>, "reasoning_snippet": "<string>" }
//   • If parsing or validation fails the function throws — callers should
//     handle the error and treat the result as non-fatal.
//
// Required env vars:
//   LLM_API_KEY  — your LLM provider API token
//
// Optional env vars:
//   LLM_MODEL    — model ID (default: deepseek-ai/DeepSeek-V3-0324)
//   LLM_API_URL  — endpoint URL (default: https://router.huggingface.co/v1/chat/completions)

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_URL = 'https://router.huggingface.co/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3-0324';
const MAX_TOKENS = 256;
const TEMPERATURE = 0;

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a high-frequency trading sentiment analyzer specializing in Indian equities (NSE/BSE).

Your job is to analyze a batch of news headlines for a given stock symbol and output a single aggregate bullish conviction score.

Rules:
1. Score range: 1 (extremely bearish) to 100 (extremely bullish). 50 = fully neutral.
2. Weight your score based on recency, magnitude, and market-moving potential of the headlines.
3. Respond ONLY with a raw JSON object — no markdown, no code fences, no explanation outside the JSON.

Required output schema (exact field names, no extras):
{"conviction_score": <integer 1-100>, "reasoning_snippet": "<one sentence, max 150 chars>"}`;

// ── analyzeSentiment ──────────────────────────────────────────────────────────

/**
 * Sends a batch of headlines for the given symbol to the HuggingFace LLM and
 * returns a structured conviction score with a reasoning snippet.
 *
 * @param {string}   symbol         - NSE ticker symbol (e.g. "TATA", "INFY").
 * @param {string[]} headlinesArray - Array of headline strings to analyze.
 * @returns {Promise<{conviction_score: number, reasoning_snippet: string}>}
 *   Resolves to the parsed JSON object from the LLM.
 *   Rejects if the API call fails or the response cannot be parsed/validated.
 *
 * @example
 * const result = await analyzeSentiment('TATA', [
 *   'Tata Motors Q4 profit surges 35% on EV demand',
 *   'Tata Steel raises capex guidance amid commodity rally',
 * ]);
 * // { conviction_score: 82, reasoning_snippet: "Strong earnings and capex signal robust bullish momentum." }
 */
export async function analyzeSentiment(symbol, headlinesArray) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('[analyzer] LLM_API_KEY is not set.');
  }

  if (!headlinesArray || headlinesArray.length === 0) {
    throw new Error('[analyzer] headlinesArray must contain at least one headline.');
  }

  const endpoint = process.env.LLM_API_URL || DEFAULT_URL;
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;

  // Build the numbered headlines list for the user message.
  const numberedHeadlines = headlinesArray
    .map((h, i) => `${i + 1}. ${h}`)
    .join('\n');

  const userMessage =
    `Symbol: ${symbol}\n` +
    `Headlines (${headlinesArray.length}):\n` +
    numberedHeadlines;

  console.log(
    `[analyzer] Calling HF LLM (${model}) for symbol=${symbol} ` +
    `with ${headlinesArray.length} headline(s)...`
  );

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(
      `[analyzer] HF API returned HTTP ${response.status}: ${errText.slice(0, 200)}`
    );
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content ?? '';

  // Strip markdown code fences if the model wraps output
  const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  // Parse the JSON response.
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    throw new Error(
      `[analyzer] Failed to parse LLM response as JSON. ` +
      `Raw output: "${rawText.slice(0, 200)}"`
    );
  }

  // Validate conviction_score.
  const score = parseInt(parsed.conviction_score, 10);
  if (isNaN(score) || score < 1 || score > 100) {
    throw new Error(
      `[analyzer] conviction_score out of valid range [1-100]: ${parsed.conviction_score}`
    );
  }

  // Validate reasoning_snippet.
  if (typeof parsed.reasoning_snippet !== 'string') {
    throw new Error('[analyzer] reasoning_snippet must be a string.');
  }

  const result = {
    conviction_score:   score,
    reasoning_snippet: parsed.reasoning_snippet.slice(0, 150),
  };

  console.log(
    `[analyzer] symbol=${symbol}  conviction_score=${result.conviction_score}  ` +
    `reasoning="${result.reasoning_snippet}"`
  );

  return result;
}
