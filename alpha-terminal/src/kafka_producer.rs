use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::ClientConfig;
use prost::Message as ProstMessage;
use crate::proto::market_data::OhlcCandle;

pub fn init_producer(brokers: &str) -> FutureProducer {
    ClientConfig::new()
        .set("bootstrap.servers", brokers)
        .set("message.timeout.ms", "5000")
        .set("queue.buffering.max.ms", "5")
        .create()
        .expect("Producer creation error")
}

pub async fn publish_candle(producer: &FutureProducer, topic: &str, candle: &OhlcCandle) {
    let mut encoded = Vec::new();
    candle.encode(&mut encoded).expect("Failed to encode OhlcCandle");

    let record: FutureRecord<'_, str, [u8]> = FutureRecord::to(topic)
        .payload(&encoded)
        .key(&candle.symbol);

    match producer.send(record, rdkafka::util::Timeout::Never).await {
        Ok((partition, offset)) => {
            log::debug!(
                "Successfully published OhlcCandle for {} to partition {} at offset {}",
                candle.symbol,
                partition,
                offset
            );
        }
        Err((e, _)) => {
            log::error!("Failed to publish OhlcCandle for {}: {:?}", candle.symbol, e);
        }
    }
}
