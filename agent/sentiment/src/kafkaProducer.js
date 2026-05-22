// kafkaProducer.js — Kafka producer for the Sentiment Agent.
//
// SP34: Rebuilt to accept an injected `protoMessage` object (the loaded
// protobufjs Type returned by loadNewsSentimentType()) rather than importing
// protoLoader internally.  This makes serialisation explicit and testable:
//
//   connectProducer()                        → creates + connects KafkaJS producer (call once)
//   publishSentiment(symbol, claudeJson,      → maps claudeJson → NewsSentiment payload,
//                    protoMessage)              encodes via protoMessage.encode().finish(),
//                                              publishes Buffer to `sentiment_signals` topic
//   disconnectProducer()                     → graceful flush + disconnect
//
// Serialisation contract (SP34):
//   payload = {
//     symbol,
//     timestamp_ms : Date.now(),                          // int64
//     headline     : claudeJson.headline ?? '',           // most-recent headline
//     claude_conviction_score: claudeJson.conviction_score,
//     reasoning_snippet      : claudeJson.reasoning_snippet,
//   }
//   encoded = Buffer.from(protoMessage.encode(payload).finish())
//
// Required env vars:
//   KAFKA_BROKER_URL           — broker address  (default: localhost:9092)
//   KAFKA_TOPIC_SENTIMENT      — topic name       (default: sentiment_signals)
//   KAFKA_CLIENT_ID_SENTIMENT  — Kafka client ID  (default: sentiment-agent)

import { Kafka, CompressionTypes } from 'kafkajs';

// ── Module-level producer instance (initialised once) ────────────────────────

let _producer = null;

// ── connectProducer ──────────────────────────────────────────────────────────

/**
 * Creates and connects a KafkaJS producer.
 * Must be called once at startup before any `publishSentiment` calls.
 *
 * @returns {Promise<void>}
 */
export async function connectProducer() {
  const brokers  = (process.env.KAFKA_BROKER_URL ?? 'localhost:9092').split(',');
  const clientId = process.env.KAFKA_CLIENT_ID_SENTIMENT ?? 'sentiment-agent';

  const kafka = new Kafka({
    clientId,
    brokers,
    // Retry aggressively for transient broker unavailability.
    retry: {
      initialRetryTime: 300,
      retries: 5,
    },
  });

  _producer = kafka.producer({
    // Wait up to 5 ms to batch multiple signals — minimal latency impact.
    linger: 5,
    // Compress with GZIP — news text payloads compress well.
    compression: CompressionTypes.GZIP,
  });

  await _producer.connect();
  console.log(
    `[kafkaProducer] Connected. brokers=${brokers.join(',')} clientId=${clientId}`
  );
}

// ── publishSentiment ─────────────────────────────────────────────────────────

/**
 * Maps the Claude JSON output into a NewsSentiment Protobuf payload, encodes
 * it using the injected `protoMessage` type, and publishes the resulting Buffer
 * to the `sentiment_signals` Kafka topic.
 *
 * @param {string} symbol - NSE ticker symbol (e.g. "TATA", "RELIANCE").
 * @param {Object} claudeJson - Raw object returned by analyzeSentiment():
 *   @param {number} claudeJson.conviction_score    - Score 1-100.
 *   @param {string} claudeJson.reasoning_snippet   - One-sentence reasoning.
 *   @param {string} [claudeJson.headline]          - Headline string (optional).
 * @param {import('protobufjs').Type} protoMessage - The loaded NewsSentiment
 *   protobufjs Type (returned by loadNewsSentimentType()).  Injected so that
 *   the proto schema is loaded once at startup and shared across calls.
 * @returns {Promise<void>}
 */
export async function publishSentiment(symbol, claudeJson, protoMessage) {
  if (!_producer) {
    console.error('[kafkaProducer] Producer not initialised — call connectProducer() first.');
    return;
  }

  const topic = process.env.KAFKA_TOPIC_SENTIMENT ?? 'sentiment_signals';

  // ── Map claudeJson → NewsSentiment payload ────────────────────────────────
  const payload = {
    symbol,
    timestamp_ms:            Date.now(),
    headline:                claudeJson.headline ?? '',
    claude_conviction_score: claudeJson.conviction_score,
    reasoning_snippet:       claudeJson.reasoning_snippet ?? '',
  };

  // ── Validate + encode via injected protoMessage ───────────────────────────
  let encoded;
  try {
    // Verify the payload against the schema (throws descriptively on mismatch).
    const errMsg = protoMessage.verify(payload);
    if (errMsg) {
      throw new Error(`Schema validation failed: ${errMsg}`);
    }

    // Encode → Uint8Array → Buffer (KafkaJS requires Buffer or string values).
    encoded = Buffer.from(protoMessage.encode(payload).finish());
  } catch (err) {
    console.error(
      `[kafkaProducer] Protobuf encode failed for symbol='${symbol}': ${err.message}`
    );
    return;
  }

  // ── Publish to Kafka ──────────────────────────────────────────────────────
  try {
    const result = await _producer.send({
      topic,
      messages: [
        {
          // Partition key = symbol — preserves per-symbol ordering.
          key:   symbol,
          value: encoded,
        },
      ],
    });

    const meta = result[0];
    console.log(
      `[kafkaProducer] Published: symbol=${symbol}  ` +
      `score=${payload.claude_conviction_score}  ` +
      `topic=${topic}  partition=${meta.partition}  offset=${meta.baseOffset}`
    );
  } catch (err) {
    // Non-fatal — log and continue; individual publish failures don't stop the loop.
    console.error(
      `[kafkaProducer] Failed to publish for symbol='${symbol}': ${err.message}`
    );
  }
}

// ── disconnectProducer ───────────────────────────────────────────────────────

/**
 * Gracefully disconnects the Kafka producer.
 * Call this in SIGTERM / SIGINT handlers to flush pending messages.
 *
 * @returns {Promise<void>}
 */
export async function disconnectProducer() {
  if (_producer) {
    await _producer.disconnect();
    console.log('[kafkaProducer] Disconnected cleanly.');
    _producer = null;
  }
}
