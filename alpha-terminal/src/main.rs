mod proto;
mod engine;
mod consumer;
mod kafka_producer;
mod ws_server;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    env_logger::init();
    
    log::info!("Alpha Terminal: V2 Predictive Engine Initialized.");

    let brokers = std::env::var("KAFKA_BROKERS")
        .or_else(|_| std::env::var("KAFKA_BROKER_URL"))
        .unwrap_or_else(|_| "localhost:19092".to_string());
    let topic = std::env::var("KAFKA_TOPIC_TICKS").unwrap_or_else(|_| "market.ticks".to_string());
    let ohlc_topic = std::env::var("KAFKA_TOPIC_OHLC").unwrap_or_else(|_| "market.ohlc.10m".to_string());

    let (tx, _) = tokio::sync::broadcast::channel::<String>(100);

    let tx_ws = tx.clone();
    tokio::spawn(async move {
        ws_server::start_server(8081, tx_ws.subscribe()).await;
    });

    let producer = kafka_producer::init_producer(&brokers);

    consumer::run_consumer(&brokers, &topic, producer, &ohlc_topic, tx).await;
}
