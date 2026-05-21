// main.rs — Chaos Engine: High-Frequency Kafka Load Tester
//
// Phase 9.3 — The Ultimate Crucible
//
// This tool stress-tests the entire Ai-trader pipeline by bombarding
// Kafka with synthetic market data at configurable rates (default: 100/sec).
//
// Every Nth tick (default: 500th), a massive price anomaly (-5% to +5%)
// is injected to intentionally trigger the Quant-RAG DeepSeek engine while
// the system is under extreme load.
//
// DUAL-PUBLISH STRATEGY:
//   The load tester publishes to TWO Kafka topics simultaneously:
//
//   1. `market.ticks` — Tick protos. This feeds:
//      - Aggregator OHLC Server (aggregates ticks → candles → WS port 8081 → chart)
//      - Alpha Terminal (aggregates ticks → OHLC candles → Kafka market.ohlc.10m)
//      - Technical Agent (computes indicators → technical_signals)
//
//   2. `market.ohlc.10m` — OHLCCandle protos. This feeds:
//      - Predictive Agent (LinReg → signals.predictive → WS 8082 → ghost line)
//      - Quant-RAG Agent (anomaly detection → DeepSeek LLM → WS 8083 → insight HUD)
//
// Pipeline under test:
//   load_tester → Kafka (market.ticks + market.ohlc.10m)
//     → Aggregator OHLC Server (ticks → WS 8081 → chart candles)
//     → Predictive Agent (LinReg → signals.predictive → WS 8082 → ghost line)
//     → Quant-RAG Agent  (anomaly → Gemini → signals.insights → WS 8083 → insight HUD)
//     → Tauri IPC → Frontend Canvas (target: 60 FPS under load)
//
// Usage:
//   cargo run -- --rate 100 --anomaly-every 500 --symbol BTC/USD
//   cargo run -- --rate 200 --anomaly-every 250 --symbol NIFTY50 --anomaly-pct 8.0

mod proto {
    pub mod market_data {
        include!(concat!(env!("OUT_DIR"), "/ai_trade.market_data.rs"));
    }
}

use clap::Parser;
use log::{error, info};
use prost::Message;
use rand::Rng;
use rdkafka::config::ClientConfig;
use rdkafka::producer::{FutureProducer, FutureRecord};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use proto::market_data::{OhlcCandle, Tick};

// ── CLI Arguments ─────────────────────────────────────────────────────────

/// Ai-trader Chaos Engine — High-Frequency Kafka Load Tester
#[derive(Parser, Debug)]
#[command(name = "load-tester", about = "Stress-test the Ai-trader pipeline")]
struct Args {
    /// Ticks published per second
    #[arg(long, default_value_t = 100)]
    rate: u64,

    /// Inject a flash-crash anomaly every N ticks
    #[arg(long, default_value_t = 500)]
    anomaly_every: u64,

    /// Trading symbol for synthetic data
    #[arg(long, default_value = "RELIANCE")]
    symbol: String,

    /// Anomaly magnitude (absolute % swing injected)
    #[arg(long, default_value_t = 5.0)]
    anomaly_pct: f64,

    /// Maximum number of ticks to publish (0 = infinite)
    #[arg(long, default_value_t = 0)]
    max_ticks: u64,

    /// OHLC candle flush interval in milliseconds for market.ohlc.10m.
    /// Lower = faster candle production for downstream agents.
    /// Default 2000ms (2s) means 1 candle per 200 ticks at 100 ticks/sec.
    /// The predictive agent needs 14 candles, so predictions start in ~28 seconds.
    #[arg(long, default_value_t = 2_000)]
    candle_interval_ms: u64,
}

// ── Kafka Producer ────────────────────────────────────────────────────────

fn init_producer(brokers: &str) -> FutureProducer {
    ClientConfig::new()
        .set("bootstrap.servers", brokers)
        .set("message.timeout.ms", "5000")
        .set("linger.ms", "5")
        .set("batch.num.messages", "1000")
        .set("compression.type", "lz4")
        .set("queue.buffering.max.messages", "100000")
        .set("retries", "3")
        .create()
        .expect("Failed to create Kafka FutureProducer — check KAFKA_BROKER_URL")
}

// ── Helpers ───────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Synthetic Price Walk ──────────────────────────────────────────────────

struct PriceEngine {
    price: f64,
    volatility: f64,
}

impl PriceEngine {
    fn new(initial_price: f64, volatility: f64) -> Self {
        Self {
            price: initial_price,
            volatility,
        }
    }

    /// Generate the next tick price using a random walk.
    /// Returns (price, volume).
    fn next_tick(&mut self, rng: &mut impl Rng) -> (f64, u64) {
        let pct_change = rng.gen_range(-self.volatility..self.volatility);
        self.price *= 1.0 + pct_change / 100.0;
        let volume = rng.gen_range(100..5000);
        ((self.price * 100.0).round() / 100.0, volume)
    }

    /// Inject a massive anomaly: snap price by anomaly_pct in a random direction.
    fn inject_anomaly(&mut self, rng: &mut impl Rng, anomaly_pct: f64) -> (f64, f64, u64) {
        let price_before = self.price;

        // Random direction: crash or spike
        let direction: f64 = if rng.gen_bool(0.5) { 1.0 } else { -1.0 };
        self.price *= 1.0 + direction * anomaly_pct / 100.0;

        // Anomalies have extreme volume
        let volume = rng.gen_range(100_000..500_000);

        (
            (price_before * 100.0).round() / 100.0,
            (self.price * 100.0).round() / 100.0,
            volume,
        )
    }
}

// ── Main Event Loop ───────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    // ── Environment ──────────────────────────────────────────────────
    dotenvy::from_path("../../.env").ok();
    dotenvy::dotenv().ok();
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let args = Args::parse();

    info!("╔══════════════════════════════════════════════════════╗");
    info!("║  🔥 CHAOS ENGINE — High-Frequency Load Tester        ║");
    info!("║  Phase 9.3 — The Ultimate Crucible                   ║");
    info!("╚══════════════════════════════════════════════════════╝");
    info!("");
    info!("  Symbol          : {}", args.symbol);
    info!("  Rate            : {} ticks/sec", args.rate);
    info!("  Anomaly every   : {} ticks ({:.1}% swing)", args.anomaly_every, args.anomaly_pct);
    info!("  Max ticks       : {}", if args.max_ticks == 0 { "∞ (Ctrl+C to stop)".to_string() } else { args.max_ticks.to_string() });
    info!("");

    // ── Kafka ────────────────────────────────────────────────────────
    let brokers = std::env::var("KAFKA_BROKER_URL")
        .or_else(|_| std::env::var("KAFKA_BROKERS"))
        .unwrap_or_else(|_| "localhost:19092".to_string());

    info!("Kafka broker: {}", brokers);
    info!("Publishing to: market.ticks + market.ohlc.10m (dual-publish)");

    let producer = init_producer(&brokers);

    // ── Price Engine ─────────────────────────────────────────────────
    let initial_price = match args.symbol.as_str() {
        "NIFTY50" | "NIFTY 50" => 22_500.0,
        "BANKNIFTY" => 48_000.0,
        "RELIANCE" => 2_950.0,
        "HDFCBANK" => 1_650.0,
        "INFY" => 1_450.0,
        "TCS" => 3_800.0,
        "ICICIBANK" => 1_100.0,
        "SBIN" => 780.0,
        _ => 1_000.0,
    };

    let mut engine = PriceEngine::new(initial_price, 0.15);
    let mut rng = rand::thread_rng();

    // ── Timing ───────────────────────────────────────────────────────
    let interval = Duration::from_micros(1_000_000 / args.rate);
    let mut tick_count: u64 = 0;
    let mut anomaly_count: u64 = 0;
    let mut error_count: u64 = 0;
    let start_time = std::time::Instant::now();

    // Track OHLC candle accumulation for market.ohlc.10m
    // We accumulate ticks into candles based on --candle-interval-ms and publish when the bucket changes.
    // Default 2s → predictive agent gets 14 candles in ~28 seconds.
    let candle_interval_ms: u64 = args.candle_interval_ms;
    let mut current_candle_start_ms: u64 = 0;
    let mut candle_open: f64 = 0.0;
    let mut candle_high: f64 = 0.0;
    let mut candle_low: f64 = f64::MAX;
    let mut candle_close: f64 = 0.0;
    let mut candle_volume: u64 = 0;
    let mut candle_initialized = false;

    info!("─────────────────────────────────────────────────────────");
    info!("🚀 Firehose active — publishing to Kafka...");
    info!("");

    loop {
        // ── Check exit condition ─────────────────────────────────
        if args.max_ticks > 0 && tick_count >= args.max_ticks {
            // Flush final candle
            if candle_initialized && candle_volume > 0 {
                let final_candle = OhlcCandle {
                    symbol: args.symbol.clone(),
                    start_timestamp_ms: current_candle_start_ms,
                    end_timestamp_ms: current_candle_start_ms + candle_interval_ms,
                    open: candle_open,
                    high: candle_high,
                    low: candle_low,
                    close: candle_close,
                    volume: candle_volume,
                };
                let payload = final_candle.encode_to_vec();
                let record = FutureRecord::to("market.ohlc.10m")
                    .payload(payload.as_slice())
                    .key(args.symbol.as_str());
                let _ = producer.send(record, Duration::from_secs(5)).await;
            }

            info!("");
            info!("✅ Reached max tick limit: {}", args.max_ticks);
            break;
        }

        tick_count += 1;
        let is_anomaly = tick_count % args.anomaly_every == 0;
        let timestamp_ms = now_ms();

        // ── Generate price ───────────────────────────────────────
        let (price, volume) = if is_anomaly {
            anomaly_count += 1;
            let (_, after_price, vol) = engine.inject_anomaly(&mut rng, args.anomaly_pct);
            (after_price, vol)
        } else {
            engine.next_tick(&mut rng)
        };

        // ── Publish Tick to market.ticks ──────────────────────────
        // This feeds the Aggregator OHLC Server (WS 8081) and the
        // Alpha Terminal, which both aggregate ticks into candles.
        let tick = Tick {
            symbol: args.symbol.clone(),
            timestamp_ms: timestamp_ms as i64,
            last_traded_price: price,
            volume: volume as i32,
            best_bid: price * 0.9999,
            best_ask: price * 1.0001,
            instrument_token: 0,
            open: price,
            high: price,
            low: price,
            close: price,
        };

        let tick_payload = tick.encode_to_vec();
        let tick_record = FutureRecord::to("market.ticks")
            .payload(tick_payload.as_slice())
            .key(args.symbol.as_str());

        match producer.send(tick_record, Duration::from_secs(5)).await {
            Ok(_) => {}
            Err((kafka_err, _)) => {
                error_count += 1;
                if error_count <= 3 {
                    error!("❌ Tick publish failed: {}", kafka_err);
                }
            }
        }

        // ── Accumulate into OHLC candle for market.ohlc.10m ──────
        // The predictive agent and quant-rag read pre-built candles
        // from this topic, not raw ticks.
        let bucket_start = (timestamp_ms / candle_interval_ms) * candle_interval_ms;

        // ANOMALY FORCE-FLUSH: When an anomaly tick is injected, immediately
        // flush the current candle (pre-anomaly) and start a fresh candle
        // from the anomaly price. This guarantees the quant-rag agent sees
        // a candle with a massive open-to-close gap (>= 2% threshold).
        if is_anomaly && candle_initialized && candle_volume > 0 {
            // Flush the pre-anomaly candle
            let pre_anomaly = OhlcCandle {
                symbol: args.symbol.clone(),
                start_timestamp_ms: current_candle_start_ms,
                end_timestamp_ms: timestamp_ms,
                open: candle_open,
                high: candle_high,
                low: candle_low,
                close: candle_close,
                volume: candle_volume,
            };

            let pre_payload = pre_anomaly.encode_to_vec();
            let pre_record = FutureRecord::to("market.ohlc.10m")
                .payload(pre_payload.as_slice())
                .key(args.symbol.as_str());
            let _ = producer.send(pre_record, Duration::from_secs(5)).await;

            // Now publish a dedicated anomaly candle with the massive price gap
            let anomaly_candle = OhlcCandle {
                symbol: args.symbol.clone(),
                start_timestamp_ms: timestamp_ms,
                end_timestamp_ms: timestamp_ms + candle_interval_ms,
                open: candle_close,   // open = pre-anomaly close
                high: candle_close.max(price),
                low: candle_close.min(price),
                close: price,         // close = post-anomaly price
                volume,
            };

            let anom_payload = anomaly_candle.encode_to_vec();
            let anom_record = FutureRecord::to("market.ohlc.10m")
                .payload(anom_payload.as_slice())
                .key(args.symbol.as_str());

            match producer.send(anom_record, Duration::from_secs(5)).await {
                Ok((partition, offset)) => {
                    let gap_pct = ((price - candle_close) / candle_close).abs() * 100.0;
                    info!(
                        "🚨 ANOMALY CANDLE FLUSHED: O={:.2} → C={:.2} gap={:+.2}% [p={} o={}] — should trigger Quant-RAG!",
                        candle_close, price,
                        if price >= candle_close { gap_pct } else { -gap_pct },
                        partition, offset,
                    );
                }
                Err((kafka_err, _)) => {
                    error!("❌ Anomaly OHLC publish failed: {}", kafka_err);
                }
            }

            // Reset candle state — start fresh from the anomaly price
            current_candle_start_ms = bucket_start;
            candle_open = price;
            candle_high = price;
            candle_low = price;
            candle_close = price;
            candle_volume = 0;
        } else if !candle_initialized {
            // First tick ever — initialize the candle
            current_candle_start_ms = bucket_start;
            candle_open = price;
            candle_high = price;
            candle_low = price;
            candle_close = price;
            candle_volume = volume;
            candle_initialized = true;
        } else if bucket_start != current_candle_start_ms {
            // New bucket — flush the completed candle to Kafka
            let completed = OhlcCandle {
                symbol: args.symbol.clone(),
                start_timestamp_ms: current_candle_start_ms,
                end_timestamp_ms: current_candle_start_ms + candle_interval_ms,
                open: candle_open,
                high: candle_high,
                low: candle_low,
                close: candle_close,
                volume: candle_volume,
            };

            let ohlc_payload = completed.encode_to_vec();
            let ohlc_record = FutureRecord::to("market.ohlc.10m")
                .payload(ohlc_payload.as_slice())
                .key(args.symbol.as_str());

            match producer.send(ohlc_record, Duration::from_secs(5)).await {
                Ok((partition, offset)) => {
                    let change_pct = ((completed.close - completed.open) / completed.open).abs() * 100.0;
                    info!(
                        "📈 OHLC CANDLE FLUSHED: O={:.2} H={:.2} L={:.2} C={:.2} change={:+.2}% vol={} [p={} o={}]",
                        completed.open, completed.high, completed.low, completed.close,
                        if completed.close >= completed.open { change_pct } else { -change_pct },
                        completed.volume, partition, offset,
                    );
                }
                Err((kafka_err, _)) => {
                    error!("❌ OHLC publish failed: {}", kafka_err);
                }
            }

            // Start new bucket
            current_candle_start_ms = bucket_start;
            candle_open = price;
            candle_high = price;
            candle_low = price;
            candle_close = price;
            candle_volume = volume;
        } else {
            // Same bucket — update in place
            candle_high = candle_high.max(price);
            candle_low = candle_low.min(price);
            candle_close = price;
            candle_volume += volume;
        }

        // ── Logging ──────────────────────────────────────────────
        if is_anomaly {
            info!(
                "🚨 #{:>6} ANOMALY INJECTED: price={:.2} ({:+.1}%) — total anomalies: {}",
                tick_count, price, if rng.gen_bool(0.5) { args.anomaly_pct } else { -args.anomaly_pct },
                anomaly_count,
            );
        } else if tick_count % 1000 == 0 {
            let elapsed = start_time.elapsed().as_secs_f64();
            let actual_rate = tick_count as f64 / elapsed;
            info!(
                "📊 #{:>6} | price={:.2} | rate={:.0}/s | anomalies={} | errors={}",
                tick_count, price, actual_rate, anomaly_count, error_count,
            );
        }

        // ── Rate limit ───────────────────────────────────────────
        tokio::time::sleep(interval).await;
    }

    // ── Summary ──────────────────────────────────────────────────────
    let elapsed = start_time.elapsed();
    info!("");
    info!("═══════════════════════════════════════════════════════════");
    info!("  🏁 CHAOS ENGINE — Run Complete");
    info!("  Total ticks    : {}", tick_count);
    info!("  Total anomalies: {} ({:.1}%)", anomaly_count, if tick_count > 0 { anomaly_count as f64 / tick_count as f64 * 100.0 } else { 0.0 });
    info!("  Total errors   : {}", error_count);
    info!("  Elapsed time   : {:.2}s", elapsed.as_secs_f64());
    info!("  Actual rate    : {:.1} ticks/sec", if elapsed.as_secs_f64() > 0.0 { tick_count as f64 / elapsed.as_secs_f64() } else { 0.0 });
    info!("═══════════════════════════════════════════════════════════");
}
