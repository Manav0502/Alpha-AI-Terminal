// claude.js — HuggingFace LLM conviction scorer for the Sentiment Agent.
//
// Takes a raw news article, sends its headline + description to the
// HuggingFace Inference Router (OpenAI-compatible), and extracts a numeric
// conviction score (1-100) plus a short reasoning snippet that will be
// published in the NewsSentiment Protobuf.
//
// Design decisions:
//   • Uses HuggingFace Inference Router with DeepSeek model for speed + cost.
//   • Temperature = 0 — deterministic scoring for backtesting reproducibility.
//   • Asks the model to respond ONLY with a JSON object — easy machine parsing.
//   • If parsing fails the article is skipped (non-fatal).
//
// Required env vars:
//   LLM_API_KEY  — your LLM provider API token
//
// Optional env vars:
//   LLM_MODEL    — model ID (default: deepseek-ai/DeepSeek-V3-0324)
//   LLM_API_URL  — endpoint URL (default: https://router.huggingface.co/v1/chat/completions)

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_URL = 'https://router.huggingface.co/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3-0324';
const MAX_TOKENS = 256;
const TEMPERATURE = 0;

// ── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a quantitative financial analyst specializing in Indian equities (NSE/BSE).
Your task is to evaluate a news headline and assign a bullish conviction score.

Rules:
1. Score range: 1 (strongly bearish) to 100 (strongly bullish). 50 = neutral.
2. Consider: earnings beats, regulatory approvals, M&A, macro conditions, sector trends.
3. Respond ONLY with a valid JSON object. No markdown, no explanation outside JSON.

Response format (strict):
{"score": <integer 1-100>, "reasoning": "<one sentence max 120 chars>"}`;

// ── scoreArticle ─────────────────────────────────────────────────────────────

/**
 * Sends a single news article to the HuggingFace LLM and returns a structured conviction score.
 *
 * @param {string} symbol   - NSE ticker symbol this article is about.
 * @param {Object} article  - Article object with at minimum `title`.
 * @param {string} article.title        - News headline.
 * @param {string} [article.description] - Article description / lede (optional).
 * @returns {Promise<{score: number, reasoning: string} | null>}
 *   Returns null if the API call fails or the response cannot be parsed.
 */
export async function scoreArticle(symbol, article) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    console.warn('[scorer] LLM_API_KEY not set — skipping scoring.');
    return null;
  }

  const endpoint = process.env.LLM_API_URL || DEFAULT_URL;
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;

  const headline    = article.title ?? '(no title)';
  const description = article.description ?? '';

  const userMessage =
    `Symbol: ${symbol}\n` +
    `Headline: ${headline}\n` +
    (description ? `Description: ${description.slice(0, 400)}\n` : '');

  console.log(`[scorer] Scoring: "${headline.slice(0, 80)}..."`);

  try {
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
      console.error(`[scorer] HTTP ${response.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json();
    const rawText = data.choices?.[0]?.message?.content ?? '';

    // Strip markdown code fences if present
    const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    // Parse the JSON response.
    const parsed = JSON.parse(cleaned);

    const score = parseInt(parsed.score, 10);

    // Validate score is in the expected range.
    if (isNaN(score) || score < 1 || score > 100) {
      console.warn(`[scorer] Score out of range (${parsed.score}) — skipping.`);
      return null;
    }

    const reasoning = String(parsed.reasoning ?? '').slice(0, 120);

    console.log(
      `[scorer] symbol=${symbol}  score=${score}  reasoning="${reasoning}"`
    );

    return { score, reasoning };

  } catch (err) {
    // JSON parse errors, network errors, API errors — all non-fatal.
    console.error(
      `[scorer] Failed to score article for symbol='${symbol}': ${err.message}`
    );
    return null;
  }
}
