// fetcher.js — Financial news fetcher for the Sentiment Agent.
//
// Fetches the latest news articles for a given NSE symbol from the
// NewsData.io API. Articles are returned as a raw JSON array so the caller
// (claude.js / index.js) can iterate and score each headline with Claude.
//
// Migrated from MarketAux (free tier exhausted — HTTP 402) to NewsData.io
// which has better Indian equity coverage and a more generous free tier
// (200 credits/day on the free plan).
//
// API reference: https://newsdata.io/documentation
//
// Required env vars:
//   NEWSDATA_API_KEY  — your NewsData.io API key
//
// Optional env vars (with defaults):
//   NEWSDATA_LANGUAGE   — comma-separated language codes (default: "en")
//   NEWSDATA_PAGE_SIZE  — max articles per request (default: 3)

import axios from 'axios';

// ── Constants ────────────────────────────────────────────────────────────────

const NEWSDATA_BASE_URL = 'https://newsdata.io/api/1/latest';

// Maximum articles to fetch per symbol per poll cycle.
const DEFAULT_PAGE_SIZE = parseInt(process.env.NEWSDATA_PAGE_SIZE ?? '3', 10);

// Language filter — financial news in English by default.
const DEFAULT_LANGUAGE = process.env.NEWSDATA_LANGUAGE ?? 'en';

// ── fetchLatestNews ──────────────────────────────────────────────────────────

/**
 * Fetches the latest news articles for the given `symbol` from the NewsData.io API.
 *
 * Uses the `q` (query) parameter to search for the symbol as a keyword, and
 * filters to the `business` category with `country=in` for Indian market relevance.
 *
 * @param {string} symbol - NSE ticker symbol (e.g. "RELIANCE", "NIFTY").
 * @returns {Promise<Array>} Array of NewsData article objects. Each object
 *   contains at minimum: `{ article_id, title, description, link, pubDate }`.
 *   Returns an empty array if the API call fails (non-fatal; logged to stderr).
 *
 * @throws Never — errors are caught internally and logged; callers receive [].
 */
export async function fetchLatestNews(symbol) {
  const apiKey = process.env.NEWSDATA_API_KEY;

  if (!apiKey) {
    console.warn('[fetcher] NEWSDATA_API_KEY is not set — skipping news fetch.');
    return [];
  }

  // Build query parameters following the NewsData.io v1 API spec.
  const params = {
    apikey:   apiKey,
    q:        symbol,
    language: DEFAULT_LANGUAGE,
    category: 'business',
    country:  'in',
    size:     DEFAULT_PAGE_SIZE,
  };

  // Construct the URL for logging (without the API key for safety).
  const safeUrl =
    `${NEWSDATA_BASE_URL}?q=${symbol}&language=${DEFAULT_LANGUAGE}&category=business&country=in&size=${DEFAULT_PAGE_SIZE}`;

  console.log(`[fetcher] GET ${safeUrl}`);

  try {
    const response = await axios.get(NEWSDATA_BASE_URL, {
      params,
      timeout: 10_000, // 10 s — don't let a slow API stall the agent loop
    });

    // NewsData.io returns { status, totalResults, results: [...] }
    const articles = response.data?.results ?? [];

    // Normalize to the shape the downstream pipeline expects.
    // The cache uses `url` or `article_id` as dedup key.
    // The analyzer uses `title` for Claude scoring.
    const normalized = articles.map((article) => ({
      uuid:        article.article_id ?? '',
      title:       article.title ?? '',
      description: article.description ?? '',
      url:         article.link ?? '',
      published_at: article.pubDate ?? '',
    }));

    console.log(
      `[fetcher] symbol=${symbol}  articles_received=${normalized.length}`
    );

    return normalized;
  } catch (err) {
    // Log the error but return [] — a failed fetch should not crash the agent.
    const status = err.response?.status ?? 'network error';
    const errorMsg = err.response?.data?.results?.message ?? err.message;
    console.error(
      `[fetcher] Failed to fetch news for symbol='${symbol}': HTTP ${status} — ${errorMsg}`
    );
    return [];
  }
}
