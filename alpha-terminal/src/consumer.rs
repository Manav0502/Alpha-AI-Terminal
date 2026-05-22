use crate::engine::OhlcEngine;
use crate::proto::market_data::Tick;
use futures_util::stream::StreamExt;
use prost::Message as ProstMessage;
use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::Message as KafkaMessage;
use rdkafka::ClientConfig;
use rdkafka::producer::FutureProducer;
use serde_json::json;

pub async fn run_consumer(brokers: &str, topic: &str, producer: FutureProducer, ohlc_topic: &str, tx: tokio::sync::broadcast::Sender<String>) {
    let consumer: StreamConsumer = ClientConfig::new()
        .set("group.id", "alpha-terminal-group")
        .set("bootstrap.servers", brokers)
        .set("enable.partition.eof", "false")
        .set("session.timeout.ms", "6000")
        .set("enable.auto.commit", "true")
        .set("auto.offset.reset", "latest")
        .create()
        .expect("Consumer creation failed");

    consumer
        .subscribe(&[topic])
        .expect("Can't subscribe to specified topic");

    let mut engine = OhlcEngine::new();

    log::info!("Starting to consume from topic: {}", topic);

    let mut message_stream = consumer.stream();

    while let Some(message) = message_stream.next().await {
        match message {
            Ok(m) => {
                let payload = match m.payload() {
                    None => continue,
                    Some(p) => p,
                };

                if let Ok(tick) = Tick::decode(payload) {
                    let closed = engine.process_tick(&tick);

                    // If a candle closed, publish the completed candle to Kafka
                    if let Some(ref closed_candle) = closed {
                        log::info!(
                            "[CANDLE CLOSED] {} | O: {} H: {} L: {} C: {} | Vol: {}",
                            closed_candle.symbol,
                            closed_candle.open,
                            closed_candle.high,
                            closed_candle.low,
                            closed_candle.close,
                            closed_candle.volume
                        );
                        
                        let producer_clone = producer.clone();
                        let ohlc_topic_clone = ohlc_topic.to_string();
                        let candle_for_kafka = closed_candle.clone();
                        
                        tokio::spawn(async move {
                            crate::kafka_producer::publish_candle(&producer_clone, &ohlc_topic_clone, &candle_for_kafka).await;
                        });

                        // Broadcast the closed candle to WebSocket clients
                        let json_value = json!({
                            "symbol": closed_candle.symbol,
                            "start_timestamp_ms": closed_candle.start_timestamp_ms,
                            "open": closed_candle.open,
                            "high": closed_candle.high,
                            "low": closed_candle.low,
                            "close": closed_candle.close,
                            "volume": closed_candle.volume
                        });
                        let _ = tx.send(json_value.to_string());
                    }

                    // ALWAYS broadcast the current in-progress candle so the
                    // frontend chart updates in real-time on every tick,
                    // not just when a 10-minute window closes.
                    if let Some(active) = engine.get_active_candle(&tick.symbol) {
                        let live_json = json!({
                            "symbol": active.symbol,
                            "start_timestamp_ms": active.start_timestamp_ms,
                            "open": active.open,
                            "high": active.high,
                            "low": active.low,
                            "close": active.close,
                            "volume": active.volume
                        });
                        let _ = tx.send(live_json.to_string());
                    }
                } else {
                    log::warn!("Error parsing Protobuf tick");
                }
            }
            Err(e) => {
                log::warn!("Kafka error: {}", e);
            }
        }
    }
}
