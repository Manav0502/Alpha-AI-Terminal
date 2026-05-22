// cache.js — Redis caching layer for the Sentiment Agent.
//
// Prevents re-scoring of news articles already processed in the last 24 hours,
// avoiding duplicate Claude API calls and reducing operating costs.
//
// Design decisions:
//   • Each article URL is stored as a Redis key with a 24 h TTL (86400 s).
//   • TTL prevents unbounded cache growth — old keys expire automatically.
//   • Uses the standard `redis` npm package (v4+) with createClient().
//   • Connection errors are caught and logged; the client emits 'error' events
//     on the internal event emitter — not thrown — so an explicit handler is
//     registered to avoid unhandled rejection crashes.
//
// Required env vars:
//   REDIS_URL  — Redis connection string (default: redis://localhost:6379)

import { createClient } from 'redis';

// ── Constants ─────────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Time-To-Live in seconds. 24 h prevents infinite cache growth while ensuring
// an article is never re-scored within the same trading day.
const ARTICLE_TTL_SECONDS = 86_400; // 24 hours

// ── Client singleton ──────────────────────────────────────────────────────────

let _client = null;

/**
 * Returns the shared Redis client, creating and connecting it on first call.
 * Subsequent calls return the already-connected singleton.
 *
 * @returns {Promise<import('redis').RedisClientType>}
 */
async function getClient() {
  if (_client) return _client;

  _client = createClient({ url: REDIS_URL });

  // Surface Redis errors to stderr without crashing the process.
  _client.on('error', (err) => {
    console.error(`[cache] Redis client error: ${err.message}`);
  });

  try {
    await _client.connect();
    console.log(`[cache] Connected to Redis at ${REDIS_URL}`);
  } catch (err) {
    console.error(`[cache] Failed to connect to Redis: ${err.message}`);
    // Re-throw — callers should handle startup failure gracefully.
    throw err;
  }

  return _client;
}

// ── isArticleProcessed ────────────────────────────────────────────────────────

/**
 * Checks whether the given article URL has already been processed.
 *
 * Performs a Redis EXISTS check on the URL key. Returns true if the key exists,
 * meaning the article was scored within the last 24 hours and should be skipped.
 *
 * @param {string} articleUrl - The canonical URL of the news article.
 * @returns {Promise<boolean>} true if already processed, false if new.
 */
export async function isArticleProcessed(articleUrl) {
  try {
    const client = await getClient();
    const exists = await client.exists(articleUrl);
    return exists === 1;
  } catch (err) {
    // On Redis failure fall through and treat the article as unprocessed
    // so we don't silently drop news due to an infra issue.
    console.error(`[cache] isArticleProcessed error: ${err.message}`);
    return false;
  }
}

// ── markArticleProcessed ──────────────────────────────────────────────────────

/**
 * Marks the given article URL as processed by writing it to Redis with a 24 h TTL.
 *
 * The TTL ensures old keys are automatically evicted, preventing the Redis
 * keyspace from growing indefinitely over multiple days.
 *
 * @param {string} articleUrl - The canonical URL of the news article.
 * @returns {Promise<void>}
 */
export async function markArticleProcessed(articleUrl) {
  try {
    const client = await getClient();
    // SET key value EX ttl — standard TTL-bearing set.
    await client.set(articleUrl, '1', { EX: ARTICLE_TTL_SECONDS });
    console.log(`[cache] Marked as processed (TTL=${ARTICLE_TTL_SECONDS}s): ${articleUrl}`);
  } catch (err) {
    // Non-fatal — log and continue. Worst case: the article is re-scored next cycle.
    console.error(`[cache] markArticleProcessed error: ${err.message}`);
  }
}
