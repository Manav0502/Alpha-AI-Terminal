// protoLoader.js — Protobuf schema loader for the Sentiment Agent.
//
// Uses protobufjs (^8) to dynamically load `sentiment_data.proto` from the
// shared_protos directory at the monorepo root.
//
// Exports:
//   loadNewsSentimentType() → Promise<protobuf.Type>
//     Resolves the `ai_trade.sentiment_data.NewsSentiment` message type.
//     Call once at startup; cache the result for the lifetime of the process.
//
// Usage:
//   import { loadNewsSentimentType } from './protoLoader.js';
//   const NewsSentiment = await loadNewsSentimentType();
//   const payload = NewsSentiment.encode({ ... }).finish();  // Uint8Array

import { fileURLToPath } from 'url';
import path from 'path';
import protobuf from 'protobufjs';

// Resolve the path to the shared_protos directory relative to this file.
// __dirname equivalent for ES modules:
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ../../shared_protos/sentiment_data.proto (from agents/sentiment/src/)
const PROTO_PATH = path.resolve(
  __dirname,
  '../../../shared_protos/sentiment_data.proto'
);

/**
 * Loads the `sentiment_data.proto` schema and returns the `NewsSentiment`
 * Protobuf message type, ready for encoding/decoding.
 *
 * @returns {Promise<protobuf.Type>} The NewsSentiment message type.
 * @throws {Error} If the proto file cannot be found or parsed.
 */
export async function loadNewsSentimentType() {
  const root = await protobuf.load(PROTO_PATH);
  const NewsSentiment = root.lookupType('ai_trade.sentiment_data.NewsSentiment');
  return NewsSentiment;
}

/**
 * Validates and encodes a NewsSentiment payload object into a Uint8Array
 * (binary Protobuf wire format) ready to be sent as a Kafka message payload.
 *
 * @param {protobuf.Type} NewsSentiment - The loaded message type (from loadNewsSentimentType).
 * @param {Object} data - The plain object to encode.
 * @param {string}  data.symbol                - NSE ticker symbol.
 * @param {number}  data.timestamp_ms          - Unix epoch milliseconds.
 * @param {string}  data.headline              - Original news headline.
 * @param {number}  data.claude_conviction_score - Claude's conviction score (1-100).
 * @param {string}  data.reasoning_snippet     - Short Claude reasoning excerpt.
 * @returns {Uint8Array} Binary protobuf payload.
 * @throws {Error} If required fields are missing or types are incorrect.
 */
export function encodeNewsSentiment(NewsSentiment, data) {
  // Validate against the schema (throws descriptively on missing fields).
  const errMsg = NewsSentiment.verify(data);
  if (errMsg) {
    throw new Error(`NewsSentiment schema validation failed: ${errMsg}`);
  }

  const message = NewsSentiment.create(data);
  return NewsSentiment.encode(message).finish(); // returns Uint8Array
}
