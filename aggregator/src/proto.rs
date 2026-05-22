// proto.rs — Protobuf module bridge for the aggregator.
//
// Uses the `include!` macro to pull in all three generated struct files that
// prost-build writes into $OUT_DIR during the build phase.
//
// Usage:
//   use crate::proto::technical_data::TechSignal;         // consumed from Kafka
//   use crate::proto::sentiment_data::NewsSentiment;      // consumed from Kafka
//   use crate::proto::decision::AggregatedDecision;       // produced to Kafka
//   use crate::proto::decision::ActionType;               // BUY, SELL, HOLD enum

/// Generated Rust structs from `shared_protos/technical_data.proto`.
/// Primary type: `TechSignal` — the computed indicator signal from the technical agent.
pub mod technical_data {
    include!(concat!(env!("OUT_DIR"), "/ai_trade.technical_data.rs"));
}

/// Generated Rust structs from `shared_protos/sentiment_data.proto`.
/// Primary type: `NewsSentiment` — the NLP conviction signal from the sentiment agent.
pub mod sentiment_data {
    include!(concat!(env!("OUT_DIR"), "/ai_trade.sentiment_data.rs"));
}

/// Generated Rust structs from `shared_protos/decision.proto`.
/// Primary types: `AggregatedDecision` (final fused decision), `ActionType` (BUY/SELL/HOLD).
pub mod decision {
    include!(concat!(env!("OUT_DIR"), "/ai_trade.decision.rs"));
}

/// Generated Rust structs from `shared_protos/market_data.proto`.
/// Primary types: `Tick` (raw market tick), `OhlcCandle` (aggregated candle).
/// `#[allow(dead_code)]`: generated code — structs are consumed by ohlc_server,
/// not directly by the aggregator binary.
#[allow(dead_code)]
pub mod market_data {
    include!(concat!(env!("OUT_DIR"), "/ai_trade.market_data.rs"));
}
