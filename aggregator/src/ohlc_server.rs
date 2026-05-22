// ohlc_server.rs — Real-time OHLC candle aggregator + WebSocket broadcast server.
//
// Consumes raw market ticks from the `market.ticks` Kafka topic, aggregates them
// into OHLC candles (configurable interval), and broadcasts the candles as JSON
// over a dedicated WebSocket server on port 8081.
//
// The Tauri frontend shell (`lib.rs`) connects to ws://127.0.0.1:8081 and emits
// each received candle as a Tauri IPC `ohlc-tick` event, which the
// AlphaPredictiveChart component renders as live candlesticks.
//
// Architecture:
//   [Kafka: market.ticks] → Protobuf Tick decode
//     → per-symbol OHLC accumulator (HashMap<symbol, CandleAccumulator>)
//       → every CANDLE_INTERVAL_MS: flush candle → JSON → broadcast channel
//         → WebSocket server on :8081 → all connected clients

#[cfg(feature = "kafka")]
pub mod ohlc_server {
    use futures_util::{SinkExt, StreamExt};
    use prost::Message;
    use rdkafka::config::ClientConfig;
    use rdkafka::consumer::{Consumer, StreamConsumer};
    use rdkafka::message::Message as KafkaMessage;
    use std::collections::HashMap;
    use tokio::net::TcpListener;
    use tokio::sync::broadcast;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    /// OHLC candle window in milliseconds (1 minute — standard base timeframe).
    /// Higher timeframes (5m, 15m, 1h, 1D) are aggregated client-side from these
    /// base 1-minute candles.
    const CANDLE_INTERVAL_MS: u64 = 60_000;

    /// How often the timer-based flush fires to push in-progress candles to the
    /// frontend even if no new tick has arrived (handles sparse markets / pauses).
    /// 5 seconds keeps the chart feeling live without excessive broadcast noise.
    const FLUSH_INTERVAL_MS: u64 = 5_000;

    /// Kafka topic for raw market ticks.
    const TOPIC_TICKS: &str = "market.ticks";

    /// In-progress candle accumulator for a single symbol.
    struct CandleAccumulator {
        symbol: String,
        bucket_start_ms: u64,
        open: f64,
        high: f64,
        low: f64,
        close: f64,
        volume: u64,
        tick_count: u32,
    }

    impl CandleAccumulator {
        fn new(symbol: String, timestamp_ms: u64, price: f64, volume: u64) -> Self {
            let bucket_start = (timestamp_ms / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;
            Self {
                symbol,
                bucket_start_ms: bucket_start,
                open: price,
                high: price,
                low: price,
                close: price,
                volume,
                tick_count: 1,
            }
        }

        /// Update the accumulator with a new tick. Returns true if the tick belongs
        /// to the current candle bucket, false if a new bucket should be started.
        fn update(&mut self, price: f64, volume: u64) {
            if price > self.high {
                self.high = price;
            }
            if price < self.low {
                self.low = price;
            }
            self.close = price;
            self.volume += volume;
            self.tick_count += 1;
        }

        /// Serialize the completed candle to a JSON string matching the OhlcCandle
        /// interface expected by the frontend store.
        fn to_json(&self) -> String {
            serde_json::json!({
                "symbol": self.symbol,
                "start_timestamp_ms": self.bucket_start_ms,
                "open": self.open,
                "high": self.high,
                "low": self.low,
                "close": self.close,
                "volume": self.volume,
            })
            .to_string()
        }
    }

    /// Creates a Kafka consumer for the `market.ticks` topic in a separate
    /// consumer group so it doesn't interfere with the technical agent's consumer.
    async fn init_tick_consumer(brokers: &str) -> StreamConsumer {
        let consumer: StreamConsumer = ClientConfig::new()
            .set("bootstrap.servers", brokers)
            .set("group.id", "ohlc-aggregator-group")
            .set("auto.offset.reset", "latest")
            .set("enable.auto.commit", "true")
            .set("session.timeout.ms", "6000")
            .set("allow.auto.create.topics", "true")
            .create()
            .expect("Failed to create OHLC tick consumer");

        consumer
            .subscribe(&[TOPIC_TICKS])
            .expect("Failed to subscribe to market.ticks for OHLC");

        log::info!(
            "[OHLC] Kafka consumer ready. group='ohlc-aggregator-group' topic='{}'",
            TOPIC_TICKS
        );

        consumer
    }

    /// Starts the OHLC WebSocket broadcast server on the given port.
    /// Runs forever, accepting connections and forwarding candle JSON.
    async fn start_ohlc_ws_server(port: &str, rx: broadcast::Receiver<String>) {
        let addr = format!("0.0.0.0:{}", port);

        let listener = TcpListener::bind(&addr)
            .await
            .unwrap_or_else(|e| panic!("[OHLC WS] Failed to bind to {}: {}", addr, e));

        log::info!("[OHLC WS] Server listening on ws://{}", addr);

        loop {
            match listener.accept().await {
                Ok((stream, peer_addr)) => {
                    log::info!("[OHLC WS] New connection from: {}", peer_addr);
                    let mut client_rx = rx.resubscribe();

                    tokio::spawn(async move {
                        let ws_stream = match tokio_tungstenite::accept_async(stream).await {
                            Ok(ws) => ws,
                            Err(e) => {
                                log::warn!(
                                    "[OHLC WS] Handshake failed for {}: {}",
                                    peer_addr, e
                                );
                                return;
                            }
                        };

                        log::info!("[OHLC WS] Handshake complete for {}", peer_addr);
                        let (mut write, _read) = ws_stream.split();

                        loop {
                            match client_rx.recv().await {
                                Ok(json_string) => {
                                    if let Err(e) =
                                        write.send(WsMessage::Text(json_string)).await
                                    {
                                        log::warn!(
                                            "[OHLC WS] Send failed for {} — disconnecting: {}",
                                            peer_addr, e
                                        );
                                        break;
                                    }
                                }
                                Err(broadcast::error::RecvError::Lagged(n)) => {
                                    log::warn!(
                                        "[OHLC WS] Client {} lagged — skipped {} candles",
                                        peer_addr, n
                                    );
                                }
                                Err(broadcast::error::RecvError::Closed) => {
                                    log::info!(
                                        "[OHLC WS] Channel closed — disconnecting {}",
                                        peer_addr
                                    );
                                    break;
                                }
                            }
                        }

                        log::info!("[OHLC WS] Connection closed for {}", peer_addr);
                    });
                }
                Err(e) => {
                    log::error!("[OHLC WS] Failed to accept connection: {}", e);
                }
            }
        }
    }

    /// Main entry point: spawns the OHLC WebSocket server and starts the
    /// tick-to-candle aggregation loop.
    ///
    /// Call this from `main.rs` to wire up the OHLC pipeline.
    pub async fn run_ohlc_pipeline(brokers: &str) {
        let ohlc_port = std::env::var("OHLC_WEBSOCKET_PORT")
            .unwrap_or_else(|_| "8081".to_string());

        // Broadcast channel for OHLC candle JSON strings.
        let (ohlc_tx, _) = broadcast::channel::<String>(200);

        // Spawn the WebSocket server.
        let ws_rx = ohlc_tx.subscribe();
        let ohlc_port_clone = ohlc_port.clone();
        tokio::spawn(async move {
            start_ohlc_ws_server(&ohlc_port_clone, ws_rx).await;
        });
        log::info!("[OHLC] WebSocket server spawned on port {}", ohlc_port);

        // Consume market.ticks and aggregate into candles.
        let consumer = init_tick_consumer(brokers).await;
        let mut stream = consumer.stream();

        // Per-symbol candle accumulators.
        let mut accumulators: HashMap<String, CandleAccumulator> = HashMap::new();

        // Timer for flushing in-progress candles periodically (sparse market safety net).
        // We also broadcast on every individual tick below, so this is just a heartbeat.
        let mut flush_interval =
            tokio::time::interval(std::time::Duration::from_millis(FLUSH_INTERVAL_MS));

        log::info!(
            "[OHLC] Tick aggregation loop started. Candle interval: {}ms",
            CANDLE_INTERVAL_MS
        );

        loop {
            tokio::select! {
                Some(message_result) = stream.next() => {
                    if let Ok(msg) = message_result {
                        if let Some(payload) = msg.payload() {
                            // Import the generated Tick type from the market_data proto.
                            use crate::proto::market_data::Tick;

                            if let Ok(tick) = Tick::decode(payload) {
                                let timestamp_ms = tick.timestamp_ms as u64;
                                let price = tick.last_traded_price;
                                let volume = tick.volume as u64;
                                let symbol = tick.symbol.clone();
                                let bucket_start =
                                    (timestamp_ms / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;

                                if let Some(acc) = accumulators.get_mut(&symbol) {
                                    if acc.bucket_start_ms == bucket_start {
                                        // Same candle bucket — update in place.
                                        acc.update(price, volume);
                                        // ── CRITICAL FIX ────────────────────────────────────────
                                        // Broadcast the LIVE in-progress candle on every single
                                        // tick so the frontend chart updates in real-time.
                                        // Previously this only happened at bucket boundaries
                                        // (once per minute), making the chart appear frozen with
                                        // real Kite data (which ticks every few seconds).
                                        let json = acc.to_json();
                                        let _ = ohlc_tx.send(json);
                                    } else {
                                        // New bucket — flush the completed candle first.
                                        let json = acc.to_json();
                                        let _ = ohlc_tx.send(json);
                                        // Start the fresh candle for the new window.
                                        *acc = CandleAccumulator::new(
                                            symbol.clone(), timestamp_ms, price, volume,
                                        );
                                        // Immediately broadcast the opening tick of the new candle.
                                        let new_json = acc.to_json();
                                        let _ = ohlc_tx.send(new_json);
                                    }
                                } else {
                                    // First tick for this symbol — create accumulator.
                                    let acc = CandleAccumulator::new(
                                        symbol.clone(), timestamp_ms, price, volume,
                                    );
                                    // Broadcast immediately so the chart shows the first tick.
                                    let json = acc.to_json();
                                    let _ = ohlc_tx.send(json);
                                    accumulators.insert(symbol, acc);
                                }
                            }
                        }
                    }
                }
                _ = flush_interval.tick() => {
                    // Periodically flush all in-progress candles so the chart
                    // updates even when ticks are sparse.
                    for acc in accumulators.values() {
                        if acc.tick_count > 0 {
                            let json = acc.to_json();
                            let _ = ohlc_tx.send(json);
                        }
                    }
                }
            }
        }
    }
}
