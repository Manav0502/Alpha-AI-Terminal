// kite_api.rs — Kite Connect REST API proxy for the frontend.
//
// Provides two HTTP endpoints served via axum:
//
//   GET /api/kite/instruments?q=RELI&exchange=NSE
//     Downloads and caches the full Kite instrument CSV for the exchange (24h TTL),
//     then returns up to 15 matching instruments as JSON.
//
//   GET /api/kite/quote?i=NSE:RELIANCE&i=NSE:TCS
//     Proxies to Kite Quote API and returns LTP + OHLC + change data.
//
// All Kite credentials stay server-side — never exposed to the browser.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::Json;
use axum::Router;
use axum::routing::get;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instrument {
    pub instrument_token: u64,
    pub exchange_token: u64,
    pub tradingsymbol: String,
    pub name: String,
    pub last_price: f64,
    pub tick_size: f64,
    pub lot_size: u32,
    pub instrument_type: String,
    pub segment: String,
    pub exchange: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
pub struct QuoteData {
    pub symbol: String,
    pub instrument_token: u64,
    pub last_price: f64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: u64,
    pub change: f64,
    pub net_change: f64,
}

#[derive(Debug, Deserialize)]
pub struct InstrumentSearchParams {
    q: Option<String>,
    exchange: Option<String>,
}

// PENDING: GET /api/kite/quote?i=NSE:RELIANCE&i=NSE:TCS
// QuoteParams and QuoteData are the skeleton for the Kite Quote API proxy.
// Once the quote_handler function is added to the router, remove these allows.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct QuoteParams {
    /// Kite instrument identifiers, e.g. "NSE:RELIANCE"
    #[serde(rename = "i")]
    instruments: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HistoricalParams {
    /// Instrument token (numeric ID from Kite)
    pub instrument_token: Option<u64>,
    /// Symbol name — used to resolve token from cached instruments if token not provided
    pub symbol: Option<String>,
    /// Interval: "day", "minute", "3minute", "5minute", "10minute", "15minute", "60minute"
    pub interval: Option<String>,
    /// Start date (yyyy-mm-dd). Defaults to 1 year ago.
    pub from: Option<String>,
    /// End date (yyyy-mm-dd). Defaults to today.
    pub to: Option<String>,
}

// ── Shared State ─────────────────────────────────────────────────────────────

struct InstrumentCache {
    instruments: Vec<Instrument>,
    fetched_at: Option<Instant>,
    /// Timestamp of the last FAILED fetch attempt (0 instruments or HTTP error).
    /// Used to enforce a 60-second cooldown so a bad token doesn't cause
    /// per-request hammering of the Kite instruments endpoint.
    last_failed_at: Option<Instant>,
    exchange: String,
}

pub struct KiteApiState {
    api_key: String,
    access_token: String,
    http_client: reqwest::Client,
    cache: RwLock<InstrumentCache>,
    /// Prevents thundering herd: only one task can fetch instruments at a time.
    /// Others wait for the first to finish and then read from cache.
    fetch_lock: tokio::sync::Mutex<()>,
}

const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60); // 24 hours
/// Disk path for persisted instrument cache — survives aggregator restarts.
const DISK_CACHE_PATH: &str = "instruments_cache.json";

// Per-symbol token cache: symbol → instrument_token.
// Avoids re-scanning the full instrument CSV on every historical request.
use std::collections::HashMap;
use std::sync::OnceLock;
static TOKEN_CACHE: OnceLock<tokio::sync::RwLock<HashMap<String, u64>>> = OnceLock::new();
fn token_cache() -> &'static tokio::sync::RwLock<HashMap<String, u64>> {
    TOKEN_CACHE.get_or_init(|| tokio::sync::RwLock::new(HashMap::new()))
}

impl KiteApiState {
    fn new() -> Self {
        let api_key = std::env::var("KITE_API_KEY")
            .unwrap_or_else(|_| String::new());
        let access_token = std::env::var("KITE_ACCESS_TOKEN")
            .unwrap_or_else(|_| String::new());

        if api_key.is_empty() || access_token.is_empty() {
            log::warn!("KITE_API_KEY or KITE_ACCESS_TOKEN not set — Kite REST API will return errors");
        }

        // Pre-load from disk cache on startup so the first request is instant.
        let disk_instruments = Self::load_disk_cache();

        Self {
            api_key,
            access_token,
            http_client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("Failed to create HTTP client"),
            cache: RwLock::new(InstrumentCache {
                instruments: disk_instruments,
                fetched_at: None,
                last_failed_at: None,
                exchange: "NSE".to_string(),
            }),
            fetch_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn auth_header(&self) -> String {
        format!("token {}:{}", self.api_key, self.access_token)
    }

    /// Load instrument cache from disk. Returns empty vec on any error.
    fn load_disk_cache() -> Vec<Instrument> {
        match std::fs::read_to_string(DISK_CACHE_PATH) {
            Ok(json) => {
                match serde_json::from_str::<Vec<Instrument>>(&json) {
                    Ok(instruments) if !instruments.is_empty() => {
                        log::info!("[Kite API] Loaded {} instruments from disk cache", instruments.len());
                        instruments
                    }
                    _ => Vec::new(),
                }
            }
            Err(_) => Vec::new(),
        }
    }

    /// Save instrument list to disk as JSON for persistence across restarts.
    fn save_disk_cache(instruments: &[Instrument]) {
        if let Ok(json) = serde_json::to_string(instruments) {
            if let Err(e) = std::fs::write(DISK_CACHE_PATH, &json) {
                log::warn!("[Kite API] Failed to write disk cache: {}", e);
            } else {
                log::info!("[Kite API] Persisted {} instruments to disk cache", instruments.len());
            }
        }
    }

    /// Resolve an NSE symbol to its instrument_token.
    /// Uses a fast in-process cache before falling back to get_instruments.
    pub async fn resolve_token(&self, symbol: &str) -> Option<u64> {
        let sym = symbol.trim().to_uppercase();

        // Fast path: per-symbol memory cache
        {
            let cache = token_cache().read().await;
            if let Some(&token) = cache.get(&sym) {
                return Some(token);
            }
        }

        // Slow path: scan instrument list
        let instruments = self.get_instruments("NSE").await.ok()?;
        let found = instruments.iter().find(|i| i.tradingsymbol.to_uppercase() == sym);
        if let Some(inst) = found {
            let token = inst.instrument_token;
            token_cache().write().await.insert(sym, token);
            Some(token)
        } else {
            None
        }
    }

    /// Fetch instruments from Kite and cache them. Returns cached data if fresh.
    /// Priority: memory cache → disk cache → Kite API (with 429 back-off).
    async fn get_instruments(&self, exchange: &str) -> Result<Vec<Instrument>, String> {
        // ── Level 1: Memory cache (fast path) ────────────────────────────
        {
            let cache = self.cache.read().await;
            if cache.exchange == exchange {
                if let Some(fetched_at) = cache.fetched_at {
                    if fetched_at.elapsed() < CACHE_TTL && !cache.instruments.is_empty() {
                        return Ok(cache.instruments.clone());
                    }
                }
                // Disk cache loaded on startup has fetched_at=None.
                // Serve it immediately but allow a background refresh.
                if cache.fetched_at.is_none() && !cache.instruments.is_empty() {
                    log::info!("[Kite API] Serving {} instruments from disk cache (will refresh)", cache.instruments.len());
                    return Ok(cache.instruments.clone());
                }
            }
        }
        // ── Level 1b: Cooldown check ─────────────────────────────────
        // If the last API attempt failed (0 instruments / HTTP error) less than
        // 60 seconds ago, return immediately with whatever cache we have.
        // This prevents per-second hammering when the Kite token is invalid.
        {
            let cache = self.cache.read().await;
            if let Some(failed_at) = cache.last_failed_at {
                const COOLDOWN: Duration = Duration::from_secs(60);
                if failed_at.elapsed() < COOLDOWN {
                    if !cache.instruments.is_empty() {
                        log::debug!("[Kite API] Cooldown active — serving stale cache");
                        return Ok(cache.instruments.clone());
                    } else {
                        return Err(format!(
                            "Kite instruments unavailable (cooldown {}s remaining)",
                            COOLDOWN.saturating_sub(failed_at.elapsed()).as_secs()
                        ));
                    }
                }
            }
        }

        let _guard = self.fetch_lock.lock().await;

        // Double-check after acquiring lock
        {
            let cache = self.cache.read().await;
            if cache.exchange == exchange {
                if let Some(fetched_at) = cache.fetched_at {
                    if fetched_at.elapsed() < CACHE_TTL && !cache.instruments.is_empty() {
                        return Ok(cache.instruments.clone());
                    }
                }
            }
        }

        // ── Level 2: Kite API fetch with 429-aware backoff ────────────────
        log::info!("[Kite API] Fetching instruments for exchange: {}", exchange);

        let url = format!("https://api.kite.trade/instruments/{}", exchange);
        let mut last_err = String::new();

        for attempt in 0..3u32 {
            if attempt > 0 {
                // Exponential backoff: 4s, 8s — longer than before to respect Kite limits
                let backoff = Duration::from_secs(4 * (1u64 << (attempt - 1)));
                log::warn!("[Kite API] Retry #{} after {}s backoff", attempt, backoff.as_secs());
                tokio::time::sleep(backoff).await;
            }

            let response = match self.http_client
                .get(&url)
                .header("X-Kite-Version", "3")
                .header("Authorization", self.auth_header())
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    last_err = format!("Kite HTTP request failed: {}", e);
                    continue;
                }
            };

            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                last_err = "Kite API rate limited (429)".to_string();
                log::warn!("[Kite API] 429 Too Many Requests — will retry");
                continue;
            }

            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                last_err = format!("Kite API returned {}: {}", status, body);
                continue;
            }

            let csv_text = match response.text().await {
                Ok(t) => t,
                Err(e) => {
                    last_err = format!("Failed to read response body: {}", e);
                    continue;
                }
            };

            let instruments = parse_instruments_csv(&csv_text);

            // Validate: NSE should have thousands of instruments.
            // 0 (or very few) means the response was an error JSON, HTML, or
            // empty body — NOT the real instruments CSV.
            if instruments.len() < 100 {
                last_err = format!(
                    "Kite API returned only {} instruments (expected >100). Response snippet: {:?}",
                    instruments.len(),
                    &csv_text[..csv_text.len().min(200)]
                );
                log::warn!("[Kite API] {}", last_err);
                // Mark failed — 60s cooldown kicks in below
                continue;
            }

            log::info!("[Kite API] Fetched {} instruments for {}", instruments.len(), exchange);

            // Persist to disk so next restart is instant
            Self::save_disk_cache(&instruments);

            // Update memory cache — clear any previous failure mark
            {
                let mut cache = self.cache.write().await;
                cache.instruments = instruments.clone();
                cache.fetched_at = Some(Instant::now());
                cache.last_failed_at = None; // clear cooldown on success
                cache.exchange = exchange.to_string();
            }

            return Ok(instruments);
        }

        // All attempts failed — set cooldown so we don't hammer Kite.
        {
            let mut cache = self.cache.write().await;
            cache.last_failed_at = Some(Instant::now());
        }
        log::warn!("[Kite API] Instruments fetch failed after 3 attempts: {}", last_err);
        {
            let cache = self.cache.read().await;
            if !cache.instruments.is_empty() && cache.exchange == exchange {
                log::warn!(
                    "[Kite API] All retries failed — serving stale cache ({} instruments). Error: {}",
                    cache.instruments.len(), last_err
                );
                return Ok(cache.instruments.clone());
            }
        }

        Err(last_err)
    }
}

/// Parse a single CSV line respecting RFC-4180 quoting (fields may contain commas).
/// Kite's instruments CSV wraps `name` fields like "DR. REDDY'S LABS, LTD" in quotes.
/// A naive split(',') would shatter those into extra columns, shifting every index right.
fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            if in_quotes && i + 1 < chars.len() && chars[i + 1] == '"' {
                // Escaped quote inside quoted field
                current.push('"');
                i += 1;
            } else {
                in_quotes = !in_quotes;
            }
        } else if c == ',' && !in_quotes {
            fields.push(current.trim().to_string());
            current = String::new();
        } else {
            current.push(c);
        }
        i += 1;
    }
    fields.push(current.trim().to_string());
    fields
}

/// Parse the Kite instruments CSV into a Vec<Instrument>.
/// Only includes EQ (equity) and INDEX types for cleaner search results.
///
/// Kite CSV columns (0-indexed):
///   0  instrument_token
///   1  exchange_token
///   2  tradingsymbol
///   3  name           ← may contain commas inside quotes
///   4  last_price
///   5  expiry
///   6  strike
///   7  tick_size
///   8  lot_size
///   9  instrument_type  ← "EQ", "INDEX", "FUT", "CE", "PE" etc.
///   10 segment
///   11 exchange
fn parse_instruments_csv(csv: &str) -> Vec<Instrument> {
    let mut instruments = Vec::new();
    let mut lines = csv.lines();

    // Skip header row
    lines.next();

    for line in lines {
        if line.trim().is_empty() {
            continue;
        }

        let cols = parse_csv_line(line);

        // Need at least 12 columns (0..=11)
        if cols.len() < 12 {
            continue;
        }

        // col 9 = instrument_type
        let instrument_type = cols[9].as_str();
        if instrument_type != "EQ" && instrument_type != "INDEX" {
            continue;
        }

        let instrument = Instrument {
            instrument_token: cols[0].parse().unwrap_or(0),
            exchange_token:   cols[1].parse().unwrap_or(0),
            tradingsymbol:    cols[2].clone(),
            name:             cols[3].clone(),
            last_price:       cols[4].parse().unwrap_or(0.0),
            tick_size:        cols[7].parse().unwrap_or(0.0), // col 7, NOT 5
            lot_size:         cols[8].parse().unwrap_or(0),   // col 8, NOT 6
            instrument_type:  instrument_type.to_string(),
            segment:          cols[10].clone(),
            exchange:         cols[11].clone(),
        };

        // Skip instruments with no tradingsymbol (malformed rows)
        if instrument.tradingsymbol.is_empty() || instrument.instrument_token == 0 {
            continue;
        }

        instruments.push(instrument);
    }

    instruments
}


// ── Handlers ─────────────────────────────────────────────────────────────────

/// GET /api/kite/instruments?q=RELI&exchange=NSE
async fn instruments_search(
    Query(params): Query<InstrumentSearchParams>,
    state: axum::extract::State<Arc<KiteApiState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let query = params.q.unwrap_or_default().trim().to_uppercase();
    let exchange = params.exchange.unwrap_or_else(|| "NSE".to_string()).to_uppercase();

    if query.is_empty() {
        return Ok(Json(serde_json::json!({ "results": [] })));
    }

    let instruments = state.get_instruments(&exchange).await.map_err(|e| {
        log::error!("[Kite instruments] {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e, "results": [] })),
        )
    })?;

    // Filter: prefix matches first, then contains matches
    let mut prefix_matches = Vec::new();
    let mut contains_matches = Vec::new();

    for inst in &instruments {
        let sym = inst.tradingsymbol.to_uppercase();
        let name = inst.name.to_uppercase();

        if sym.starts_with(&query) {
            prefix_matches.push(inst.clone());
        } else if sym.contains(&query) || name.contains(&query) {
            contains_matches.push(inst.clone());
        }

        if prefix_matches.len() + contains_matches.len() >= 30 {
            break;
        }
    }

    let mut results: Vec<Instrument> = prefix_matches;
    results.extend(contains_matches);
    results.truncate(15);

    Ok(Json(serde_json::json!({ "results": results })))
}

/// GET /api/kite/quote?i=NSE:RELIANCE&i=NSE:TCS
///
/// Note: axum doesn't natively support repeated query params with the same key,
/// so we accept a comma-separated list: ?i=NSE:RELIANCE,NSE:TCS
async fn quote_handler(
    axum::extract::RawQuery(raw_query): axum::extract::RawQuery,
    state: axum::extract::State<Arc<KiteApiState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    // Parse repeated `i=` params from raw query string
    let raw = raw_query.unwrap_or_default();
    let instruments: Vec<String> = raw
        .split('&')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let val = parts.next()?;
            if key == "i" {
                Some(urlencoding::decode(val).unwrap_or_default().to_string())
            } else {
                None
            }
        })
        .collect();

    if instruments.is_empty() {
        return Ok(Json(serde_json::json!({ "quotes": [] })));
    }

    // Build Kite query string
    let query_string: String = instruments
        .iter()
        .map(|i| format!("i={}", urlencoding::encode(i)))
        .collect::<Vec<_>>()
        .join("&");

    let url = format!("https://api.kite.trade/quote?{}", query_string);

    let response = state
        .http_client
        .get(&url)
        .header("X-Kite-Version", "3")
        .header("Authorization", state.auth_header())
        .send()
        .await
        .map_err(|e| {
            log::error!("[Kite quote] HTTP error: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": e.to_string(), "quotes": [] })),
            )
        })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        log::error!("[Kite quote] API returned {}: {}", status, body);
        return Err((
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(serde_json::json!({ "error": format!("Kite API error: {}", status), "quotes": [] })),
        ));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| {
        log::error!("[Kite quote] JSON parse error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to parse Kite response", "quotes": [] })),
        )
    })?;

    let data = json.get("data").cloned().unwrap_or(serde_json::json!({}));
    let data_map = data.as_object().cloned().unwrap_or_default();

    let quotes: Vec<QuoteData> = data_map
        .iter()
        .map(|(key, value)| {
            let symbol = key.split(':').nth(1).unwrap_or(key).to_string();
            let ohlc = value.get("ohlc").cloned().unwrap_or(serde_json::json!({}));
            let prev_close = ohlc.get("close").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let last_price = value.get("last_price").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let net_change = if prev_close > 0.0 { last_price - prev_close } else { 0.0 };
            let pct_change = if prev_close > 0.0 {
                (net_change / prev_close) * 100.0
            } else {
                0.0
            };

            QuoteData {
                symbol,
                instrument_token: value.get("instrument_token").and_then(|v| v.as_u64()).unwrap_or(0),
                last_price,
                open: ohlc.get("open").and_then(|v| v.as_f64()).unwrap_or(0.0),
                high: ohlc.get("high").and_then(|v| v.as_f64()).unwrap_or(0.0),
                low: ohlc.get("low").and_then(|v| v.as_f64()).unwrap_or(0.0),
                close: prev_close,
                volume: value.get("volume").and_then(|v| v.as_u64()).unwrap_or(0),
                change: (pct_change * 100.0).round() / 100.0,
                net_change: (net_change * 100.0).round() / 100.0,
            }
        })
        .collect();

    Ok(Json(serde_json::json!({ "quotes": quotes })))
}

/// GET /api/kite/historical?symbol=TCS&interval=day&from=2024-01-01&to=2025-05-13
///
/// Fetches historical OHLCV candles from the Kite Historical API.
/// Resolves the instrument_token from the cached instruments list using the symbol.
/// Falls back to `instrument_token` query param if provided directly.
///
/// Returns: `{ "candles": [ { "time": <unix_sec>, "open": ..., "high": ..., "low": ..., "close": ..., "volume": ... } ] }`
async fn historical_handler(
    Query(params): Query<HistoricalParams>,
    state: axum::extract::State<Arc<KiteApiState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let symbol = params.symbol.unwrap_or_default().trim().to_uppercase();
    let interval = params.interval.unwrap_or_else(|| "day".to_string());

    // Resolve instrument_token: either provided directly or looked up from symbol
    let token: u64 = if let Some(t) = params.instrument_token {
        t
    } else if !symbol.is_empty() {
        // Use the cached resolve_token helper — avoids re-scanning the full
        // instruments list on every request after the first lookup.
        match state.resolve_token(&symbol).await {
            Some(t) => t,
            None => {
                log::error!("[Kite historical] Could not resolve token for symbol '{}'", symbol);
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({
                        "error": format!("Symbol '{}' not found in NSE instruments", symbol),
                        "candles": []
                    })),
                ));
            }
        }
    } else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Either 'symbol' or 'instrument_token' is required", "candles": [] })),
        ));
    };

    // Date range: default to 1 year of data
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let one_year_ago = (chrono::Utc::now() - chrono::Duration::days(365))
        .format("%Y-%m-%d")
        .to_string();

    let from_date = params.from.unwrap_or(one_year_ago);
    let to_date = params.to.unwrap_or(today);

    log::info!(
        "[Kite historical] Fetching {} (token {}) interval={} from={} to={}",
        symbol, token, interval, from_date, to_date
    );

    let url = format!(
        "https://api.kite.trade/instruments/historical/{}/{}",
        token, interval
    );

    let response = state
        .http_client
        .get(&url)
        .query(&[("from", &from_date), ("to", &to_date)])
        .header("X-Kite-Version", "3")
        .header("Authorization", state.auth_header())
        .send()
        .await
        .map_err(|e| {
            log::error!("[Kite historical] HTTP error: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": e.to_string(), "candles": [] })),
            )
        })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        log::error!("[Kite historical] API returned {}: {}", status, body);
        return Err((
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(serde_json::json!({ "error": format!("Kite API error {}: {}", status, body), "candles": [] })),
        ));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| {
        log::error!("[Kite historical] JSON parse error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "Failed to parse Kite response", "candles": [] })),
        )
    })?;

    // Kite response: { "status": "success", "data": { "candles": [[ts, o, h, l, c, vol], ...] } }
    let candles_raw = json
        .get("data")
        .and_then(|d| d.get("candles"))
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();

    let candles: Vec<serde_json::Value> = candles_raw
        .iter()
        .filter_map(|row| {
            let arr = row.as_array()?;
            if arr.len() < 6 {
                return None;
            }
            // Parse timestamp: Kite returns ISO 8601 string like "2024-01-15T00:00:00+0530"
            let ts_str = arr[0].as_str().unwrap_or_default();
            let time_sec = chrono::DateTime::parse_from_str(ts_str, "%Y-%m-%dT%H:%M:%S%z")
                .or_else(|_| chrono::DateTime::parse_from_rfc3339(ts_str))
                .map(|dt| dt.timestamp())
                .unwrap_or(0);

            if time_sec == 0 {
                return None;
            }

            Some(serde_json::json!({
                "time": time_sec,
                "open": arr[1].as_f64().unwrap_or(0.0),
                "high": arr[2].as_f64().unwrap_or(0.0),
                "low": arr[3].as_f64().unwrap_or(0.0),
                "close": arr[4].as_f64().unwrap_or(0.0),
                "volume": arr[5].as_u64().unwrap_or(0),
            }))
        })
        .collect();

    log::info!(
        "[Kite historical] {} — {} candles returned (interval={})",
        symbol, candles.len(), interval
    );

    Ok(Json(serde_json::json!({ "candles": candles })))
}

// ── Server ───────────────────────────────────────────────────────────────────

/// Build and start the Kite REST API server on the given port.
/// Call this from main.rs via `tokio::spawn`.
pub async fn run_kite_api_server(port: &str) {
    let state = Arc::new(KiteApiState::new());

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/kite/instruments", get(instruments_search))
        .route("/api/kite/quote", get(quote_handler))
        .route("/api/kite/historical", get(historical_handler))
        .layer(cors)
        .with_state(state);

    let addr = format!("0.0.0.0:{}", port);
    log::info!("Kite REST API server listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind Kite API server port");

    axum::serve(listener, app)
        .await
        .expect("Kite API server crashed");
}
