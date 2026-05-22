// kafka_producer.rs — Kafka producer for broadcasting AggregatedDecision.
//
// Master Phase 1 → Power Phase 1.5 → Subphase 43.
//
// Serialises the final `AggregatedDecision` protobuf to bytes via `prost`
// and publishes it to the `trade_decisions` Kafka topic. This allows
// downstream services (execution engine, audit logger, replay system) to
// consume decisions as first-class events.
//
// The producer is feature-gated behind `kafka` — same pattern as the consumer.

#[cfg(feature = "kafka")]
pub mod producer {
    use prost::Message;
    use rdkafka::config::ClientConfig;
    use rdkafka::producer::{FutureProducer, FutureRecord};
    use std::time::Duration;

    use crate::proto::decision::AggregatedDecision;

    /// Creates and configures a Kafka [`FutureProducer`] for publishing decisions.
    ///
    /// Configuration:
    /// - `message.timeout.ms = 5000` — non-blocking; consumer loop continues on timeout.
    /// - `queue.buffering.max.ms = 5` — near-zero batching delay for real-time decisions.
    /// - `retries = 3` — transient broker error recovery.
    ///
    /// # Panics
    /// Panics if the broker is unreachable at startup (unrecoverable).
    pub fn init_producer(brokers: &str) -> FutureProducer {
        ClientConfig::new()
            .set("bootstrap.servers", brokers)
            .set("message.timeout.ms", "5000")
            .set("queue.buffering.max.ms", "5")
            .set("retries", "3")
            .create()
            .expect("Failed to create Kafka FutureProducer — check broker address and CMake build")
    }

    /// Serialises an [`AggregatedDecision`] to Protobuf bytes and publishes
    /// it to the specified Kafka topic.
    ///
    /// - Message key = `decision.symbol` → ensures per-symbol partition ordering.
    /// - Uses `prost::Message::encode_to_vec` for serialisation.
    /// - Delivery is awaited with a 5-second timeout.
    /// - Errors are logged but non-fatal — the consumer loop continues.
    pub async fn publish_decision(
        producer: &FutureProducer,
        topic: &str,
        decision: &AggregatedDecision,
    ) {
        let payload = decision.encode_to_vec();

        let record = FutureRecord::to(topic)
            .payload(&payload)
            .key(&decision.symbol);

        match producer.send(record, Duration::from_secs(5)).await {
            Ok((partition, offset)) => {
                log::debug!(
                    "[KAFKA-PUB] Decision published: symbol={} partition={} offset={}",
                    decision.symbol,
                    partition,
                    offset,
                );
            }
            Err((kafka_err, _)) => {
                log::error!(
                    "[KAFKA-PUB] Failed to publish decision for symbol={}: {}",
                    decision.symbol,
                    kafka_err,
                );
            }
        }
    }
}
