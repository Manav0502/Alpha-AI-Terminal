// src/commands/charts.rs — Binary Historical Data Resolver
//
// Tauri IPC command that queries QuestDB for OHLCV data across all
// timeframes and serializes the result as a raw binary buffer using bincode.
//
// ── Intraday + Daily Fusion ─────────────────────────────────────────────────
//   For intraday timeframes (1m–1H), the backend proactively fetches
//   historical candles from the Kite REST API and merges them with
//   today's live tick aggregates. For daily/weekly, the pre-aggregated
//   `historical_candles` archive is used directly.
//
// ── Zero-Latency Transfer ───────────────────────────────────────────────────
//   bincode produces a compact binary representation that the frontend
//   deserializes directly into a TypedArray — eliminating JSON parse time.
//
// ── Error Handling ──────────────────────────────────────────────────────────
//   On database failure, emits a `system-error` event to the frontend
//   console (matching the Phase 1 Error Visibility pattern).

use log::{info, warn, error};
use serde::Serialize;
use sqlx::PgPool;
use tauri::{AppHandle, Emitter, Manager};

use crate::services::history_loader;

/// A single OHLCV candle for binary serialization.
///
/// Field order matches the QuestDB query column order.
/// bincode serializes this as a fixed-size struct — no field names,
/// no delimiters, just raw bytes in order.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct BinaryCandle {
    /// Microseconds since Unix epoch (matches QuestDB TIMESTAMP)
    pub ts: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
}

/// Query QuestDB for historical OHLCV data, dynamically aggregated by timeframe,
/// and return as a bincode buffer.
///
/// # Arguments (from frontend `invoke("get_historical_view", { symbol, timeframe })`)
/// * `symbol`    — Instrument symbol (e.g., "RELIANCE")
/// * `timeframe` — Optional bar size: "1m", "5m", "15m", "30m", "1H", "4H", "1D",
///                 "1W". Defaults to "1D" (daily) when omitted, preserving the
///                 legacy single-arg call shape used by older UI code paths.
///
/// # Routing
/// * Intraday timeframes ("1m" .. "1H") proactively fetch historical candles
///   from the Kite REST API, store them in `historical_intraday`, and merge
///   with the current day's live tick aggregates from `live_ticks`.
/// * "4H" falls back to `live_ticks` only (Kite doesn't offer a 4H interval).
/// * Daily and weekly timeframes ("1D", "1W") read pre-aggregated rows from
///   `historical_candles` (5-year archive backfilled on demand by
///   `load_historical`). Weekly bars are produced by sampling the daily
///   archive with `SAMPLE BY 7d`.
///
/// # Returns
/// `Vec<u8>` — bincode-serialized `Vec<BinaryCandle>`. Tauri automatically
/// converts this to a `Uint8Array` on the JavaScript side.
///
/// # Errors
/// Returns a string error AND emits a `system-error` event for the frontend
/// console to display.
#[tauri::command]
pub async fn get_historical_view(
    app: AppHandle,
    pool: tauri::State<'_, PgPool>,
    symbol: String,
    timeframe: Option<String>,
) -> Result<Vec<u8>, String> {
    // Normalise timeframe input (accept upper/lower-case from the UI).
    let tf_raw = timeframe.unwrap_or_else(|| "1D".to_string());
    let tf = tf_raw.trim().to_string();

    // Map the UI timeframe → query source, SAMPLE BY interval, and base interval.
    //
    // `base_tf`:         The base Kite interval tag used for QuestDB cache key.
    //                    Derived timeframes share a base (e.g., 2m/4m → "1m").
    //                    The frontend's aggregateCandles() re-buckets to the exact TF.
    // `sample_interval`: SAMPLE BY interval for live_ticks (= base_tf for intraday).
    // `source`:          Which query strategy to use.
    //
    // ── Cache sharing ──────────────────────────────────────────────────────
    //   1m, 2m, 4m  → all fetch/cache "minute" data    (Kite: "minute")
    //   3m          → "3minute"                         (Kite native)
    //   5m          → "5minute"
    //   10m         → "10minute"
    //   15m, 75m, 125m → all fetch/cache "15minute"     (Kite: "15minute")
    //   30m         → "30minute"
    //   1h, 2h, 3h, 4h → all fetch/cache "60minute"    (Kite: "60minute")
    //   1D, 1W, 1M  → daily archive
    //
    // ── Case-sensitivity note ──────────────────────────────────────────────
    //   The frontend sends '1m' (lowercase) for 1 minute and '1M' (uppercase)
    //   for 1 month. We must match CASE-SENSITIVELY first for these ambiguous
    //   cases, then fall through to uppercase matching for the rest.
    let (sample_interval, base_tf, source) = match tf.as_str() {
        // ── Case-sensitive: disambiguate minute vs month ────────────
        "1m" | "1min"  => ("1m",  "1m",  HistorySource::Intraday),
        "1M"           => ("30d", "1d",  HistorySource::Daily),    // 1 Month
        _ => {
            // All other timeframes are unambiguous — safe to uppercase
            match tf.to_uppercase().as_str() {
                // ── Minute-based (base: 1m) ─────────────────────────
                "1MIN"          => ("1m",  "1m",  HistorySource::Intraday),
                "2M"  | "2MIN"  => ("1m",  "1m",  HistorySource::Intraday),
                "4M"  | "4MIN"  => ("1m",  "1m",  HistorySource::Intraday),
                // ── 3-minute (Kite native) ──────────────────────────
                "3M"  | "3MIN"  => ("3m",  "3m",  HistorySource::Intraday),
                // ── 5-minute ────────────────────────────────────────
                "5M"  | "5MIN"  => ("5m",  "5m",  HistorySource::Intraday),
                // ── 10-minute ───────────────────────────────────────
                "10M" | "10MIN" => ("10m", "10m", HistorySource::Intraday),
                // ── 15-minute based (base: 15m) ─────────────────────
                "15M" | "15MIN" => ("15m", "15m", HistorySource::Intraday),
                "75M" | "75MIN" => ("15m", "15m", HistorySource::Intraday),
                "125M"| "125MIN"=> ("15m", "15m", HistorySource::Intraday),
                // ── 30-minute ───────────────────────────────────────
                "30M" | "30MIN" => ("30m", "30m", HistorySource::Intraday),
                // ── Hourly-based (base: 1h) ─────────────────────────
                "1H"  | "60M"   => ("1h",  "1h",  HistorySource::Intraday),
                "2H"  | "120M"  => ("1h",  "1h",  HistorySource::Intraday),
                "3H"  | "180M"  => ("1h",  "1h",  HistorySource::Intraday),
                "4H"  | "240M"  => ("1h",  "1h",  HistorySource::Intraday),
                // ── Daily / Weekly / Monthly (daily archive) ────────
                "1D"  | "DAY"   => ("1d",  "1d",  HistorySource::Daily),
                "1W"  | "WEEK"  => ("7d",  "1d",  HistorySource::Daily),
                "MONTH"         => ("30d", "1d",  HistorySource::Daily),
                _               => ("1d",  "1d",  HistorySource::Daily),
            }
        }
    };

    // ── DIAGNOSTIC TRACER — Tauri command boundary (UI → Rust) ──
    println!(
        "🛑 [RUST RECEIVE] Historical Request — Symbol: {}, Timeframe: {} → base={}, SAMPLE BY {} (source: {:?})",
        symbol, tf, base_tf, sample_interval, source
    );

    info!(
        "get_historical_view: querying {} from QuestDB (tf={}, base_tf={}, sample_by={}, source={:?})",
        symbol, tf, base_tf, sample_interval, source
    );

    // ── Proactive Intraday Fetch ─────────────────────────────────────────────
    //
    // For intraday timeframes, trigger a fetch of historical candles from the
    // Kite REST API at the BASE interval. This ensures the chart has context
    // beyond today's live ticks. The loader is idempotent — if data already
    // exists in QuestDB for this symbol + base_tf, it skips redundant calls.
    //
    // Using base_tf (not the raw UI tf) is key for cache efficiency:
    //   - User selects 2m → base_tf="1m" → fetches "minute" data from Kite
    //   - User switches to 4m → base_tf="1m" → data already cached, skip fetch!
    //   - User switches to 1m → base_tf="1m" → data already cached, skip fetch!
    if matches!(source, HistorySource::Intraday) {
        let api_key = std::env::var("KITE_API_KEY").ok();
        let access_token = std::env::var("KITE_ACCESS_TOKEN").ok();

        if let (Some(api_key), Some(access_token)) = (api_key, access_token) {
            // Resolve instrument token from the local SQLite cache
            let local_token: Option<u32> = {
                use tauri::Manager;
                app.try_state::<crate::db::DbState>()
                    .and_then(|db_state| {
                        crate::commands::instruments::resolve_instrument_token(
                            &db_state, &symbol
                        )
                    })
            };

            match local_token {
                Some(token) => {
                    info!(
                        "Intraday fetch trigger: {} [tf={}, base={}] — token {}",
                        symbol, tf, base_tf, token
                    );
                    // Fetch at the BASE interval — derived TFs reuse this cached data
                    match history_loader::load_intraday_data(
                        pool.inner(),
                        token,
                        &symbol,
                        base_tf,
                        &api_key,
                        &access_token,
                    ).await {
                        Ok(count) => info!(
                            "Intraday fetch complete: {} [base={}] — {} candles.",
                            symbol, base_tf, count
                        ),
                        Err(e) => warn!(
                            "Intraday fetch failed for {} [base={}]: {} — falling back to live ticks.",
                            symbol, base_tf, e
                        ),
                    }
                }
                None => {
                    warn!(
                        "Could not resolve instrument token for {} — skipping intraday fetch.",
                        symbol
                    );
                }
            }
        } else {
            warn!(
                "KITE_API_KEY / KITE_ACCESS_TOKEN not set — skipping intraday fetch for {}.",
                symbol
            );
        }
    }

    // ── Build the query and fetch rows ───────────────────────────────────────
    //
    // Both branches return the same column set: ts, open, high, low, close, volume
    // so the row-decoder below stays uniform.
    //
    // ── Why string-format the interval but bind the symbol? ─────────────────
    // QuestDB's parser accepts an *identifier* in SAMPLE BY, not a parameter
    // placeholder, so the interval must be inlined. We control the value
    // (it's hard-coded above), so there is no SQL-injection vector. The
    // user-supplied `symbol` remains a parameterised bind ($1).

    // For Intraday source, we run TWO queries and merge in-memory:
    //   1. historical_intraday — pre-fetched from Kite API (past N days)
    //   2. live_ticks — current session only (today), aggregated via SAMPLE BY
    //
    // We merge in-memory because QuestDB's UNION ALL has restrictions with
    // SAMPLE BY in subqueries. The in-memory merge is fast since both result
    // sets are already sorted by timestamp and we deduplicate by ts.
    let rows = match source {
        HistorySource::Intraday => {
            // Query 1: Historical intraday candles from Kite API
            let hist_query = "SELECT ts, open, high, low, close, volume \
                              FROM historical_intraday \
                              WHERE symbol = $1 AND timeframe = $2 \
                              ORDER BY ts ASC";

            let hist_rows = sqlx::query(hist_query)
                .bind(&symbol)
                .bind(base_tf)
                .fetch_all(pool.inner())
                .await;

            // Query 2: Today's live ticks aggregated to the requested interval
            //
            // IMPORTANT: The volume column in live_ticks is CUMULATIVE day volume
            // (total traded since market open), NOT per-tick volume. We must use
            // last(volume) - first(volume) to get the actual volume traded within
            // each SAMPLE BY interval. Using sum(volume) would sum cumulative
            // values, producing wildly inflated numbers.
            let live_query = format!(
                "SELECT timestamp AS ts, \
                        first(last_traded_price) AS open, \
                        max(last_traded_price)   AS high, \
                        min(last_traded_price)   AS low, \
                        last(last_traded_price)  AS close, \
                        (last(volume) - first(volume)) AS volume \
                 FROM live_ticks \
                 WHERE symbol = $1 \
                   AND timestamp > dateadd('d', -1, now()) \
                 SAMPLE BY {} ALIGN TO CALENDAR",
                sample_interval
            );

            let live_rows = sqlx::query(&live_query)
                .bind(&symbol)
                .fetch_all(pool.inner())
                .await;

            // Merge both result sets: historical rows first, then live rows
            match (hist_rows, live_rows) {
                (Ok(mut hist), Ok(live)) => {
                    hist.extend(live);
                    Ok(hist)
                }
                (Ok(hist), Err(e)) => {
                    warn!("Live ticks query failed, using historical only: {}", e);
                    Ok(hist)
                }
                (Err(e), Ok(live)) => {
                    warn!("Historical intraday query failed, using live only: {}", e);
                    Ok(live)
                }
                (Err(e1), Err(_e2)) => {
                    Err(e1) // Report the first error
                }
            }
        }
        HistorySource::Ticks => {
            let query = format!(
                "SELECT timestamp AS ts, \
                        first(last_traded_price) AS open, \
                        max(last_traded_price)   AS high, \
                        min(last_traded_price)   AS low, \
                        last(last_traded_price)  AS close, \
                        (last(volume) - first(volume)) AS volume \
                 FROM live_ticks \
                 WHERE symbol = $1 \
                 SAMPLE BY {} ALIGN TO CALENDAR",
                sample_interval
            );
            sqlx::query(&query)
                .bind(&symbol)
                .fetch_all(pool.inner())
                .await
        }
        HistorySource::Daily if sample_interval == "1d" => {
            // Pre-aggregated daily archive — no resampling needed.
            let query = "SELECT ts, open, high, low, close, volume \
                         FROM historical_candles \
                         WHERE symbol = $1 \
                         ORDER BY ts ASC";
            sqlx::query(query)
                .bind(&symbol)
                .fetch_all(pool.inner())
                .await
        }
        HistorySource::Daily => {
            let query = format!(
                // Weekly view: resample daily candles into 7-day buckets.
                "SELECT ts, \
                        first(open)  AS open, \
                        max(high)    AS high, \
                        min(low)     AS low, \
                        last(close)  AS close, \
                        sum(volume)  AS volume \
                 FROM historical_candles \
                 WHERE symbol = $1 \
                 SAMPLE BY {} ALIGN TO CALENDAR",
                sample_interval
            );
            sqlx::query(&query)
                .bind(&symbol)
                .fetch_all(pool.inner())
                .await
        }
    };

    match rows {
        Ok(data) => {
            use sqlx::Row;
            use std::collections::BTreeMap;

            let raw_candles: Vec<BinaryCandle> = data
                .iter()
                .filter_map(|row| {
                    // QuestDB returns ts as TIMESTAMP which sqlx decodes as
                    // chrono::NaiveDateTime, NOT i64. We must extract as
                    // NaiveDateTime and convert to microseconds for bincode.
                    let ts: i64 = row
                        .try_get::<chrono::NaiveDateTime, _>("ts")
                        .ok()
                        .map(|dt| dt.and_utc().timestamp_micros())
                        .or_else(|| {
                            // Fallback: try as raw i64 in case QuestDB returns raw µs
                            row.try_get::<i64, _>("ts").ok()
                        })?;
                    let open: f64 = row.try_get("open").ok()?;
                    let high: f64 = row.try_get("high").ok()?;
                    let low: f64 = row.try_get("low").ok()?;
                    let close: f64 = row.try_get("close").ok()?;
                    let volume: i64 = row
                        .try_get::<i64, _>("volume")
                        .or_else(|_| row.try_get::<i32, _>("volume").map(|v| v as i64))
                        .unwrap_or(0);
                    Some(BinaryCandle { ts, open, high, low, close, volume })
                })
                .collect();

            // ── Deduplication by timestamp ───────────────────────────────────
            // When merging historical_intraday + live_ticks, there may be
            // overlapping timestamps at the boundary. We use a BTreeMap
            // keyed by timestamp to deduplicate — later entries (live ticks)
            // override historical ones for the same timestamp, giving
            // real-time accuracy for the current candle.
            let mut dedup_map: BTreeMap<i64, BinaryCandle> = BTreeMap::new();
            for candle in raw_candles {
                dedup_map.insert(candle.ts, candle);
            }
            let candles: Vec<BinaryCandle> = dedup_map.into_values().collect();

            info!(
                "get_historical_view: {} ({}) — {} candles fetched, serializing with bincode.",
                symbol,
                tf,
                candles.len()
            );

            // ── DIAGNOSTIC TRACER — Final Mile (Rust → bincode boundary) ──
            // Verifies the exact struct values the backend is about to ship
            // to the UI. If `Total Candles fetched: 0`, the SQL query produced
            // no rows; if first/last look corrupt (NaN/0/garbage timestamps),
            // the QuestDB row decoding above is at fault.
            println!(
                "🛑 [RUST EXIT] Symbol: {} | Timeframe: {:?} | Source: {:?} | SAMPLE BY: {} | Total Candles fetched: {}",
                symbol, tf, source, sample_interval, candles.len()
            );
            if let (Some(first), Some(last)) = (candles.first(), candles.last()) {
                println!("🛑 [RUST EXIT] First Candle: {:?}", first);
                println!("🛑 [RUST EXIT] Last  Candle: {:?}", last);
            } else {
                println!(
                    "🛑 [RUST EXIT] ⚠️  EMPTY result set — no candles to serialize for {} ({}).",
                    symbol, tf
                );
            }

            // Serialize to bincode binary buffer
            let binary = bincode::serialize(&candles).map_err(|e| {
                let msg = format!("bincode serialization failed: {}", e);
                error!("{}", msg);
                broadcast_error(&app, &msg);
                msg
            })?;

            info!(
                "get_historical_view: {} ({}) — {} bytes serialized.",
                symbol,
                tf,
                binary.len()
            );

            // ── DIAGNOSTIC TRACER — Bincode payload size out of Rust ──
            // Use this number to confirm React sees the same byte count on the
            // other side of the IPC boundary. A mismatch here ≠ React side
            // means the Tauri channel itself is the suspect.
            println!(
                "🛑 [RUST EXIT] Bincode payload size: {} bytes (going to UI)",
                binary.len()
            );

            Ok(binary)
        }
        Err(e) => {
            let msg = format!("QuestDB query failed for {} ({}): {}", symbol, tf, e);
            error!("{}", msg);
            broadcast_error(&app, &msg);
            Err(msg)
        }
    }
}

/// Source table the historical view should read from for a given timeframe.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
enum HistorySource {
    /// Fetch intraday historical candles from Kite API + merge with live ticks.
    /// Used for 1m, 5m, 10m, 15m, 30m, 1H.
    Intraday,
    /// Aggregate raw ticks via SAMPLE BY (fallback for 4H or when Kite fetch fails).
    Ticks,
    /// Read pre-aggregated daily archive (resampled for weekly).
    Daily,
}

/// Check whether the QuestDB PG pool has been registered as Tauri state.
///
/// The pool is registered asynchronously in lib.rs — the frontend should
/// call this first and wait until it returns `true` before invoking
/// `get_historical_view`. This prevents the "State not found" race condition.
///
/// Uses `AppHandle::try_state()` instead of `Option<State<PgPool>>` because
/// `State<T>` does not implement `Deserialize` in Tauri v2.
#[tauri::command]
pub async fn get_pool_status(app: AppHandle) -> bool {
    app.try_state::<PgPool>().is_some()
}

/// Proxy a QuestDB REST API request through Rust, returning the raw JSON body.
///
/// This bypasses browser/WebView CORS restrictions entirely — the HTTP request
/// is made from the Rust process (no origin header), so QuestDB responds freely.
///
/// # Arguments (from `invoke("fetch_questdb", { query })`)
/// * `query` — SQL string to send to QuestDB REST API (/exec endpoint)
///
/// # Returns
/// Raw JSON string from QuestDB (the `{ dataset: [...] }` response).
#[tauri::command]
pub async fn fetch_questdb(query: String) -> Result<String, String> {
    let questdb_url = std::env::var("QUESTDB_HTTP_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:9000".to_string());

    let url = format!("{}/exec", questdb_url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let response = client
        .get(&url)
        .query(&[("query", &query), ("fmt", &"json".to_string())])
        .send()
        .await
        .map_err(|e| format!("QuestDB HTTP request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("QuestDB returned HTTP {}", response.status()));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read QuestDB response body: {}", e))?;

    Ok(body)
}

/// Trigger historical data ingestion from Kite API for a given symbol.
///
/// # Arguments (from frontend `invoke("load_historical", { symbol, instrumentToken })`)
/// * `symbol`           — Instrument symbol (e.g., "RELIANCE")
/// * `instrument_token` — Kite instrument token (e.g., 738561)
///
/// # Returns
/// Number of candles ingested.
#[tauri::command]
pub async fn load_historical(
    app: AppHandle,
    pool: tauri::State<'_, PgPool>,
    symbol: String,
    instrument_token: u32,
) -> Result<u64, String> {
    // ── DIAGNOSTIC TRACER — Tauri command boundary ──
    println!(
        "🛑 [RUST RECEIVE] Load-Historical Request - Symbol: {}, Token: {}",
        symbol, instrument_token
    );

    info!("load_historical: starting ingestion for {} (token {})", symbol, instrument_token);

    let api_key = std::env::var("KITE_API_KEY")
        .map_err(|_| "KITE_API_KEY not set in .env".to_string())?;
    let access_token = std::env::var("KITE_ACCESS_TOKEN")
        .map_err(|_| "KITE_ACCESS_TOKEN not set in .env".to_string())?;

    match history_loader::load_historical_data(
        pool.inner(),
        instrument_token,
        &symbol,
        &api_key,
        &access_token,
    )
    .await
    {
        Ok(count) => {
            info!("load_historical: {} — {} candles ingested successfully.", symbol, count);

            // Notify frontend of success
            let _ = app.emit("historical-loaded", serde_json::json!({
                "symbol": symbol,
                "count": count,
            }));

            Ok(count)
        }
        Err(e) => {
            let msg = format!("Historical ingestion failed for {}: {}", symbol, e);
            error!("{}", msg);
            broadcast_error(&app, &msg);
            Err(msg)
        }
    }
}

/// Broadcast a system-level error to the frontend console.
///
/// Matches the Phase 1 Error Visibility pattern — the frontend's
/// SystemConsole component listens for `system-error` events and
/// displays them in the diagnostic log viewer.
fn broadcast_error(app: &AppHandle, message: &str) {
    let payload = serde_json::json!({
        "level": "ERROR",
        "source": "HistoricalEngine",
        "message": message,
    });

    if let Err(e) = app.emit("system-error", payload) {
        error!("Failed to emit system-error event: {}", e);
    }
}
