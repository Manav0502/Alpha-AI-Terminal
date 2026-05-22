// consumer.rs — Multi-topic Kafka consumer for the aggregator decision engine.
//
// Subscribes to BOTH `technical_signals` and `sentiment_signals` topics
// simultaneously using a single StreamConsumer instance. Incoming messages
// are routed based on `msg.topic()` to the appropriate Protobuf decoder:
//
//   - "technical_signals" → prost::Message::decode → TechSignal
//     → fetch latest sentiment from AggregatorState
//     → engine::calculate_decision → AggregatedDecision
//     → (1) Kafka publish to trade_decisions (protobuf)
//     → (2) Broadcast JSON to WebSocket clients
//
//   - "sentiment_signals" → prost::Message::decode → NewsSentiment
//     → update AggregatorState with latest sentiment for that symbol
//
// Updated in Subphase 42 for AggregatorState + dynamic weighting.
// Updated in Subphase 43-45 for Kafka publish + WebSocket broadcast.

#[cfg(feature = "kafka")]
pub mod consumer {
    use crate::engine;
    use crate::kafka_producer::producer as kprod;
    use crate::proto::decision::ActionType;
    use crate::proto::sentiment_data::NewsSentiment;
    use crate::proto::technical_data::TechSignal;
    use crate::state::AggregatorState;
    use futures_util::StreamExt;
    use prost::Message;
    use rdkafka::config::ClientConfig;
    use rdkafka::consumer::{Consumer, StreamConsumer};
    use rdkafka::message::Message as KafkaMessage;
    use rdkafka::producer::FutureProducer;

    /// Topic name for technical signals published by the technical agent.
    const TOPIC_TECHNICAL: &str = "technical_signals";

    /// Topic name for sentiment signals published by the sentiment agent.
    const TOPIC_SENTIMENT: &str = "sentiment_signals";

    /// Topic name for publishing aggregated decisions.
    const TOPIC_DECISIONS: &str = "trade_decisions";

    /// Creates and configures a Kafka [`StreamConsumer`] subscribed to both
    /// the `technical_signals` and `sentiment_signals` topics.
    ///
    /// Configuration:
    /// - `auto.offset.reset = "latest"` — only process real-time signals,
    ///   not historical replay from previous sessions.
    /// - `enable.auto.commit = "true"` — offsets committed automatically.
    /// - `session.timeout.ms = "6000"` — standard consumer group timeout.
    ///
    /// # Panics
    /// Panics if the broker is unreachable at startup or subscription fails.
    pub async fn init_consumer(brokers: &str, group_id: &str) -> StreamConsumer {
        let consumer: StreamConsumer = ClientConfig::new()
            .set("bootstrap.servers", brokers)
            .set("group.id", group_id)
            .set("auto.offset.reset", "latest")
            .set("enable.auto.commit", "true")
            .set("session.timeout.ms", "6000")
            // Allow subscription to topics that don't exist yet — the broker
            // will create them when the first producer publishes, and the
            // consumer will start receiving messages at that point.
            .set("allow.auto.create.topics", "true")
            .create()
            .expect("Failed to create Kafka StreamConsumer — check broker address and CMake build");

        // Subscribe to BOTH signal topics simultaneously.
        // The single consumer will receive messages from either topic; we route
        // based on msg.topic() in the processing loop.
        consumer
            .subscribe(&[TOPIC_TECHNICAL, TOPIC_SENTIMENT])
            .unwrap_or_else(|e| {
                panic!(
                    "Failed to subscribe to topics [{}, {}]: {}",
                    TOPIC_TECHNICAL, TOPIC_SENTIMENT, e
                )
            });

        log::info!(
            "Kafka StreamConsumer ready. group_id='{}' topics=[{}, {}]",
            group_id,
            TOPIC_TECHNICAL,
            TOPIC_SENTIMENT,
        );

        consumer
    }

    /// Runs the multi-topic message processing loop with dynamic weighting,
    /// Kafka decision publishing, and WebSocket broadcast.
    ///
    /// For each incoming message:
    /// - Inspects `msg.topic()` to determine the source topic.
    /// - If `sentiment_signals`: decodes payload as `NewsSentiment` via prost,
    ///   then updates the shared `AggregatorState` with the latest sentiment
    ///   for that symbol.
    /// - If `technical_signals`: decodes payload as `TechSignal` via prost,
    ///   acquires a read lock on `AggregatorState` to fetch the latest
    ///   sentiment for that symbol, calls `engine::calculate_decision()`,
    ///   then:
    ///     1. Spawns a task to publish the Protobuf decision to Kafka.
    ///     2. Serialises the decision to JSON and broadcasts it to WebSocket
    ///        clients via the `tx` broadcast channel.
    ///
    /// This function runs indefinitely until the consumer is shut down or
    /// the stream is closed.
    pub async fn run_consumer_loop(
        consumer: StreamConsumer,
        state: &AggregatorState,
        producer: FutureProducer,
        tx: tokio::sync::broadcast::Sender<String>,
    ) {
        let mut stream = consumer.stream();

        log::info!("Aggregator consumer loop started — waiting for signals...");

        while let Some(message_result) = stream.next().await {
            match message_result {
                Ok(msg) => {
                    let topic = msg.topic();
                    let payload = match msg.payload() {
                        Some(p) => p,
                        None => {
                            log::warn!("Received message with empty payload on topic '{}'", topic);
                            continue;
                        }
                    };

                    match topic {
                        TOPIC_TECHNICAL => {
                            match TechSignal::decode(payload) {
                                Ok(signal) => {
                                    log::debug!(
                                        "[TECH] symbol={:<20} rsi={:>6.2}  vwap_dist={:>8.4}%  \
                                         score={:>3}  ts={}",
                                        signal.symbol,
                                        signal.rsi_value,
                                        signal.vwap_distance,
                                        signal.technical_conviction_score,
                                        signal.timestamp_ms,
                                    );

                                    // ── Dynamic Weighting (SP42) ────────────────
                                    // Acquire read lock: fetch latest sentiment for
                                    // this symbol (non-blocking to other readers).
                                    let latest_sentiment =
                                        state.get_sentiment(&signal.symbol).await;

                                    let decision = engine::calculate_decision(
                                        &signal,
                                        latest_sentiment.as_ref(),
                                    );

                                    // Map i32 action_type back to ActionType enum name.
                                    let action_label =
                                        match ActionType::try_from(decision.action_type) {
                                            Ok(ActionType::Buy) => "BUY",
                                            Ok(ActionType::Sell) => "SELL",
                                            Ok(ActionType::Hold) => "HOLD",
                                            Err(_) => "UNKNOWN",
                                        };

                                    println!(
                                        "[DECISION] symbol={:<20} action={:<4}  \
                                         final_score={:>3}  tech_w={:.2}  sent_w={:.2}  \
                                         sentiment={}  ts={}",
                                        decision.symbol,
                                        action_label,
                                        decision.final_conviction_score,
                                        decision.technical_weight_used,
                                        decision.sentiment_weight_used,
                                        if latest_sentiment.is_some() {
                                            "CACHED"
                                        } else {
                                            "NONE"
                                        },
                                        decision.timestamp_ms,
                                    );

                                    // ── SP43: Kafka Publish (fire-and-forget) ────
                                    // Spawn so slow Kafka delivery doesn't block
                                    // the consumer loop. FutureProducer is Arc-backed.
                                    let prod_clone = producer.clone();
                                    let decision_clone = decision.clone();
                                    tokio::spawn(async move {
                                        kprod::publish_decision(
                                            &prod_clone,
                                            TOPIC_DECISIONS,
                                            &decision_clone,
                                        )
                                        .await;
                                    });

                                    // ── SP45: WebSocket Broadcast (JSON) ─────────
                                    // Manually map AggregatedDecision fields to JSON
                                    // so the Next.js frontend receives readable data
                                    // rather than raw Protobuf bytes.
                                    let json_string = serde_json::json!({
                                        "symbol": decision.symbol,
                                        "timestamp_ms": decision.timestamp_ms,
                                        "final_conviction_score": decision.final_conviction_score,
                                        "technical_weight_used": decision.technical_weight_used,
                                        "sentiment_weight_used": decision.sentiment_weight_used,
                                        "action": action_label,
                                    })
                                    .to_string();

                                    // broadcast::send returns Err only when there
                                    // are zero receivers — harmless (no WS clients).
                                    let _ = tx.send(json_string);
                                }
                                Err(e) => {
                                    log::warn!(
                                        "TechSignal decode error on topic '{}': {}",
                                        topic, e
                                    );
                                }
                            }
                        }
                        TOPIC_SENTIMENT => {
                            match NewsSentiment::decode(payload) {
                                Ok(sentiment) => {
                                    println!(
                                        "[SENT] symbol={:<20} score={:>3}  headline=\"{}\"  \
                                         reason=\"{}\"  ts={}",
                                        sentiment.symbol,
                                        sentiment.claude_conviction_score,
                                        sentiment.headline,
                                        sentiment.reasoning_snippet,
                                        sentiment.timestamp_ms,
                                    );

                                    // ── State Update (SP42) ─────────────────────
                                    // Cache the latest sentiment so future TechSignal
                                    // processing can use it for dynamic weighting.
                                    let symbol = sentiment.symbol.clone();
                                    state.update_sentiment(symbol, sentiment).await;
                                }
                                Err(e) => {
                                    log::warn!(
                                        "NewsSentiment decode error on topic '{}': {}",
                                        topic, e
                                    );
                                }
                            }
                        }
                        unknown => {
                            log::warn!(
                                "Received message from unexpected topic '{}' — ignoring",
                                unknown
                            );
                        }
                    }
                }
                Err(e) => {
                    log::error!("Kafka consumer error: {}", e);
                }
            }
        }

        log::warn!("Consumer stream ended — aggregator loop exiting.");
    }
}

