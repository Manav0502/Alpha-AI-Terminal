// index.js — Sentiment Agent — Full Production Polling Loop (Subphases 34-36).
//
// SP35-36: Replaces the single-pass integration test with a continuous
// `setInterval` background process that polls NewsData.io, deduplicates via
// Redis, scores with LLM, and broadcasts to Kafka as Protobuf messages.
//
// Pipeline (per tick per symbol):
//   fetchLatestNews(symbol)
//     ↓  raw NewsData.io article array
//   filter via isArticleProcessed()      → Redis EXISTS (24 h dedup window)
//     ↓  new articles only
//   analyzeSentiment(symbol, headlines)  → LLM conviction score + snippet
//     ↓  { conviction_score, reasoning_snippet }
//   publishSentiment(symbol, llmJson, NewsSentiment)
//     ↓  NewsSentiment Protobuf → Kafka topic: sentiment_signals
//   markArticleProcessed(articleUrl)     → Redis SET EX 86400
//
// Configuration (env vars):
//   NEWSDATA_API_KEY           — NewsData.io API key         (required)
//   LLM_API_KEY                — LLM provider API key        (required for scoring)
//   KAFKA_BROKER_URL           — Kafka broker                (default: localhost:9092)
//   REDIS_URL                  — Redis connection string     (default: redis://localhost:6379)
//   SENTIMENT_SYMBOLS          — comma-separated ticker list (default: RELIANCE)
//   SENTIMENT_POLL_INTERVAL_MS — poll cadence in ms         (default: 600000)
//
// Graceful shutdown:
//   SIGINT → disconnectProducer() + redis.quit() + process.exit(0)

import 'dotenv/config';
import { loadNewsSentimentType }                   from './protoLoader.js';
import { fetchLatestNews }                         from './fetcher.js';
import { isArticleProcessed, markArticleProcessed } from './cache.js';
import { analyzeSentiment }                        from './analyzer.js';
import { connectProducer, publishSentiment, disconnectProducer } from './kafkaProducer.js';
import { createClient }                            from 'redis';

// ── Configuration ─────────────────────────────────────────────────────────────

const SYMBOLS = (process.env.SENTIMENT_SYMBOLS ?? 'RELIANCE')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const POLL_INTERVAL_MS = parseInt(process.env.SENTIMENT_POLL_INTERVAL_MS ?? '600000', 10);

// ── Redis client (for graceful shutdown reference) ────────────────────────────
// cache.js manages its own singleton internally; we create a second reference
// here only to expose .quit() in the SIGINT handler without breaking the cache
// module's internal state.  We import the same env var so both point to the
// same Redis instance.

const REDIS_URL  = process.env.REDIS_URL ?? 'redis://localhost:6379';
let   redisClient = null; // initialised inside run()

// ── processTicker ─────────────────────────────────────────────────────────────

/**
 * Runs a single poll cycle for one ticker symbol:
 *   1. Fetch latest news from Marketaux.
 *   2. Filter out articles already in the Redis dedup cache.
 *   3. Collect headlines from new articles.
 *   4. Call LLM via analyzeSentiment() to get a conviction score.
 *   5. Publish the result to Kafka as an encoded NewsSentiment Protobuf.
 *   6. Mark the new articles as processed in Redis.
 *
 * All errors are caught and logged — a single bad symbol never kills the loop.
 *
 * @param {string}                   symbol       - NSE ticker (e.g. "TATA").
 * @param {import('protobufjs').Type} NewsSentiment - Loaded proto type (injected once).
 * @returns {Promise<void>}
 */
async function processTicker(symbol, NewsSentiment) {
  console.log(`\n[index] ── Processing symbol: ${symbol} ──`);

  // ── Step 1: Fetch latest news ──────────────────────────────────────────────
  let articles;
  try {
    articles = await fetchLatestNews(symbol);
  } catch (err) {
    console.error(`[index] fetchLatestNews failed for ${symbol}: ${err.message}`);
    return;
  }

  if (!articles || articles.length === 0) {
    console.log(`[index] No articles returned for ${symbol}. Skipping.`);
    return;
  }

  console.log(`[index] Fetched ${articles.length} article(s) for ${symbol}.`);

  // ── Step 2: Filter new articles via Redis dedup cache ──────────────────────
  const newArticles = [];

  for (const article of articles) {
    const cacheKey = article.url ?? article.uuid ?? article.title;

    if (!cacheKey) {
      console.warn(`[index] Article for ${symbol} has no URL/UUID/title — skipping.`);
      continue;
    }

    const alreadyProcessed = await isArticleProcessed(cacheKey);

    if (alreadyProcessed) {
      console.log(`[index] SKIP (cached): "${(article.title ?? '').slice(0, 60)}"`);
    } else {
      newArticles.push({ article, cacheKey });
    }
  }

  if (newArticles.length === 0) {
    console.log(`[index] All articles for ${symbol} already processed. Nothing to publish.`);
    return;
  }

  console.log(`[index] ${newArticles.length} new article(s) queued for ${symbol}.`);

  // ── Step 3: Build headlines array ─────────────────────────────────────────
  const headlinesArray = newArticles
    .map(({ article }) => article.title)
    .filter(Boolean);

  if (headlinesArray.length === 0) {
    console.warn(`[index] No usable headlines for ${symbol}. Skipping analyzer call.`);
    return;
  }

  // ── Step 4: Analyze with LLM ───────────────────────────────────────────
  let llmJson;
  try {
    llmJson = await analyzeSentiment(symbol, headlinesArray);
  } catch (err) {
    console.error(`[index] analyzeSentiment failed for ${symbol}: ${err.message}`);
    return;
  }

  // Attach the most recent headline to the payload for Protobuf field `headline`.
  llmJson.headline = headlinesArray[0];

  // ── Step 5: Publish to Kafka ──────────────────────────────────────────────
  try {
    await publishSentiment(symbol, llmJson, NewsSentiment);
  } catch (err) {
    // publishSentiment already handles errors internally, but catch here too.
    console.error(`[index] publishSentiment failed for ${symbol}: ${err.message}`);
  }

  // ── Step 6: Mark new articles as processed in Redis ───────────────────────
  for (const { cacheKey } of newArticles) {
    await markArticleProcessed(cacheKey);
  }

  console.log(`[index] ✅ Cycle complete for ${symbol}.`);
}

// ── run ───────────────────────────────────────────────────────────────────────

/**
 * Main entry point:
 *   1. Load the Protobuf schema (once, shared across all publish calls).
 *   2. Connect to Kafka.
 *   3. Connect to Redis (for graceful-shutdown reference).
 *   4. Start the setInterval polling loop immediately + every POLL_INTERVAL_MS.
 *   5. Register SIGINT handler for graceful shutdown.
 *
 * @returns {Promise<void>}
 */
async function run() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  Sentiment Agent — NLP Polling Loop (Subphases 34-36)    ║');
  console.log('║  LLM · Redis · Kafka Protobuf Pipeline                     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // ── 1. Load Protobuf schema ───────────────────────────────────────────────
  console.log('[index] Loading NewsSentiment Protobuf schema...');
  let NewsSentiment;
  try {
    NewsSentiment = await loadNewsSentimentType();
    console.log('[index] ✅ Protobuf schema loaded.');
  } catch (err) {
    console.error(`[index] FATAL: Failed to load Protobuf schema: ${err.message}`);
    process.exit(1);
  }

  // ── 2. Connect Kafka producer ─────────────────────────────────────────────
  console.log('[index] Connecting Kafka producer...');
  try {
    await connectProducer();
    console.log('[index] ✅ Kafka producer connected.');
  } catch (err) {
    console.error(`[index] FATAL: Kafka producer connection failed: ${err.message}`);
    process.exit(1);
  }

  // ── 3. Connect Redis (shutdown reference) ─────────────────────────────────
  console.log('[index] Connecting Redis client...');
  try {
    redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => {
      console.error(`[index] Redis client error: ${err.message}`);
    });
    await redisClient.connect();
    console.log('[index] ✅ Redis client connected.');
  } catch (err) {
    // Redis failure is non-fatal for startup; cache.js handles its own connection.
    console.warn(`[index] Redis connection warning: ${err.message}`);
  }

  // ── 4. Poll loop ──────────────────────────────────────────────────────────
  console.log(
    `\n[index] Starting polling loop. Symbols=[${SYMBOLS.join(', ')}]  ` +
    `Interval=${POLL_INTERVAL_MS}ms\n`
  );

  /**
   * Single poll cycle — iterates over all configured symbols sequentially.
   * Errors per symbol are caught inside processTicker; the overall loop
   * continues regardless.
   */
  const pollCycle = async () => {
    console.log(`\n[index] ══ Poll cycle started at ${new Date().toISOString()} ══`);
    for (const symbol of SYMBOLS) {
      await processTicker(symbol, NewsSentiment);
    }
    console.log(`[index] ══ Poll cycle complete. Next run in ${POLL_INTERVAL_MS / 1000}s ══\n`);
  };

  // Run immediately on startup, then on every interval.
  await pollCycle();
  setInterval(pollCycle, POLL_INTERVAL_MS);

  // ── 5. Graceful shutdown ──────────────────────────────────────────────────
  process.on('SIGINT', async () => {
    console.log('\n[index] 🛑 SIGINT received — shutting down gracefully...');

    try {
      await disconnectProducer();
    } catch (err) {
      console.error(`[index] Error disconnecting Kafka producer: ${err.message}`);
    }

    if (redisClient) {
      try {
        await redisClient.quit();
        console.log('[index] Redis client disconnected cleanly.');
      } catch (err) {
        console.error(`[index] Error disconnecting Redis client: ${err.message}`);
      }
    }

    console.log('[index] Goodbye. ✅');
    process.exit(0);
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

run().catch((err) => {
  console.error('[index] Fatal unhandled error:', err);
  process.exit(1);
});
