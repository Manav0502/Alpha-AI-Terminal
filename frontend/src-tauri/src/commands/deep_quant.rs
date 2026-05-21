// commands/deep_quant.rs — Tauri IPC Command: Deep Quant Analysis.
//
// V3 Phase 3: The frontend calls `invoke("run_deep_quant_analysis", { symbol })`
// which triggers the full pipeline:
//   1. Fetch recent candles from QuestDB
//   2. Compute indicators → ConsensusReport via the quant engine
//   3. Fetch recent news headlines (with graceful fallback)
//   4. Call DeepSeek API with the Master Prompt
//   5. Return AiExecutionPlan to React UI

use log::{info, warn, error};
use sqlx::PgPool;
use tauri::{AppHandle, Emitter, Manager};

use crate::quant::{
    patterns::Candle, AiExecutionPlan, ConsensusEngine, IndicatorState,
};
use crate::services::llm;

// ── News Fetcher ────────────────────────────────────────────────────────────

/// Fetch recent news headlines for a symbol from the aggregator's REST API.
/// Falls back to a "No recent news available" string on any failure.
///
/// Wrapped with the Alpha Crucible audit logger so every News API request
/// and response is recorded verbatim when `ALPHA_TEST_MODE=1`.
async fn fetch_news_context(symbol: &str) -> String {
    use crate::services::audit_logger;

    let news_api_url = std::env::var("NEWS_API_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8084".to_string());

    let url = format!("{}/api/news?symbol={}", news_api_url, symbol);
    let req_json = serde_json::json!({ "method": "GET", "url": url, "symbol": symbol });

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            warn!("News HTTP client failed: {} — using fallback", e);
            audit_logger::log_api_error(
                &format!("GET {}", url),
                &req_json,
                &format!("client build failed: {}", e),
            );
            return format!("No recent news available for {}.", symbol);
        }
    };

    match client.get(&url).send().await {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let res_json: serde_json::Value = serde_json::from_str(&body)
                .unwrap_or_else(|_| serde_json::Value::String(body.clone()));
            audit_logger::log_api_transaction(
                &format!("GET {}", url),
                &req_json,
                &res_json,
                status.as_u16(),
            );
            if status.is_success() && !body.trim().is_empty() {
                body
            } else {
                if !status.is_success() {
                    warn!("News API returned HTTP {} for {}", status, symbol);
                }
                format!("No recent news available for {}.", symbol)
            }
        }
        Err(e) => {
            warn!("News fetch failed for {}: {} — using fallback", symbol, e);
            audit_logger::log_api_error(
                &format!("GET {}", url),
                &req_json,
                &format!("transport error: {}", e),
            );
            format!("No recent news available for {}.", symbol)
        }
    }
}

// ── Candle Loader ───────────────────────────────────────────────────────────

/// Load the most recent N candles from QuestDB for quant analysis.
///
/// Uses a multi-source waterfall strategy matching the chart's data pipeline:
///   1. `historical_candles` — daily archive (5-year backfill via Kite)
///   2. `historical_intraday` — intraday candles cached by chart views
///   3. `live_ticks` — current session aggregated into 10m bars
///
/// Returns candles in chronological order (oldest first).
async fn load_candles_from_db(pool: &PgPool, symbol: &str, limit: i64) -> Result<Vec<Candle>, String> {
    use sqlx::Row;

    // Helper: parse rows into Candle vec (reverse to chronological order)
    let parse_rows = |rows: &[sqlx::postgres::PgRow]| -> Vec<Candle> {
        let mut candles: Vec<Candle> = rows
            .iter()
            .filter_map(|row| {
                let open: f64 = row.try_get("open").ok()?;
                let high: f64 = row.try_get("high").ok()?;
                let low: f64 = row.try_get("low").ok()?;
                let close: f64 = row.try_get("close").ok()?;
                let volume: i64 = row.try_get::<i64, _>("volume")
                    .or_else(|_| row.try_get::<i32, _>("volume").map(|v| v as i64))
                    .unwrap_or(0);
                Some(Candle {
                    open,
                    high,
                    low,
                    close,
                    volume: volume as f64,
                })
            })
            .collect();
        candles.reverse();
        candles
    };

    // ── Source 1: historical_candles (daily archive) ─────────────────────
    let daily_rows = sqlx::query(
        "SELECT open, high, low, close, volume \
         FROM historical_candles \
         WHERE symbol = $1 \
         ORDER BY ts DESC \
         LIMIT $2",
    )
    .bind(symbol)
    .bind(limit)
    .fetch_all(pool)
    .await;

    if let Ok(rows) = &daily_rows {
        if !rows.is_empty() {
            let candles = parse_rows(rows);
            info!(
                "[deep_quant] candle_source=historical_candles symbol={} count={}",
                symbol, candles.len()
            );
            return Ok(candles);
        }
    }

    // ── Source 2: historical_intraday (Kite intraday cached by chart) ────
    let intraday_rows = sqlx::query(
        "SELECT open, high, low, close, volume \
         FROM historical_intraday \
         WHERE symbol = $1 \
         ORDER BY ts DESC \
         LIMIT $2",
    )
    .bind(symbol)
    .bind(limit)
    .fetch_all(pool)
    .await;

    if let Ok(rows) = &intraday_rows {
        if !rows.is_empty() {
            let candles = parse_rows(rows);
            info!(
                "[deep_quant] candle_source=historical_intraday symbol={} count={}",
                symbol, candles.len()
            );
            return Ok(candles);
        }
    }

    // ── Source 3: live_ticks (current session, aggregated to 10m bars) ───
    let live_rows = sqlx::query(
        "SELECT first(last_traded_price) AS open, \
                max(last_traded_price)   AS high, \
                min(last_traded_price)   AS low, \
                last(last_traded_price)  AS close, \
                (last(volume) - first(volume)) AS volume \
         FROM live_ticks \
         WHERE symbol = $1 \
         SAMPLE BY 10m ALIGN TO CALENDAR \
         ORDER BY timestamp DESC \
         LIMIT $2",
    )
    .bind(symbol)
    .bind(limit)
    .fetch_all(pool)
    .await;

    if let Ok(rows) = &live_rows {
        if !rows.is_empty() {
            let candles = parse_rows(rows);
            info!(
                "[deep_quant] candle_source=live_ticks symbol={} count={}",
                symbol, candles.len()
            );
            return Ok(candles);
        }
    }

    // All sources empty — log the failures for diagnostics
    if let Err(e) = &daily_rows {
        warn!("[deep_quant] historical_candles query failed: {}", e);
    }
    if let Err(e) = &intraday_rows {
        warn!("[deep_quant] historical_intraday query failed: {}", e);
    }
    if let Err(e) = &live_rows {
        warn!("[deep_quant] live_ticks query failed: {}", e);
    }

    Ok(vec![])
}


// ── Tauri IPC Command ───────────────────────────────────────────────────────

/// Run the full V3 Deep Quant Analysis pipeline for a given symbol.
///
/// # Frontend Usage
/// ```typescript
/// const plan = await invoke<AiExecutionPlan>("run_deep_quant_analysis", {
///   symbol: "RELIANCE"
/// });
/// ```
///
/// # Pipeline
/// 1. Load 200 most recent candles from QuestDB
/// 2. Compute IndicatorState + ConsensusReport
/// 3. Fetch recent news (with fallback)
/// 4. Call LLM (Hugging Face router → DeepSeek) with the Master Prompt
/// 5. Return structured AiExecutionPlan
#[tauri::command]
pub async fn run_deep_quant_analysis(
    app: AppHandle,
    symbol: String,
) -> Result<AiExecutionPlan, String> {
    use std::time::Instant;
    let t_total = Instant::now();

    info!("╔══════════════════════════════════════════════════╗");
    info!("║  Deep Quant Analysis — V3 Pipeline Starting     ║");
    info!("║  Symbol: {:<40} ║", symbol);
    info!("╚══════════════════════════════════════════════════╝");

    // ── Step 1: Fetch candles from QuestDB (multi-source waterfall) ────
    let t_step = Instant::now();
    info!("[deep_quant] step=1/5 candle_load_start symbol={}", symbol);

    let pool = app.try_state::<PgPool>().ok_or_else(|| {
        let msg = "QuestDB pool not yet available — try again shortly.";
        warn!("[deep_quant] step=1/5 FAIL {}", msg);
        msg.to_string()
    })?;

    let mut candles = load_candles_from_db(pool.inner(), &symbol, 200)
        .await
        .map_err(|e| {
            warn!("[deep_quant] step=1/5 FAIL elapsed_ms={} err={}", t_step.elapsed().as_millis(), e);
            e
        })?;

    // ── Proactive Kite Fetch (self-healing when DB is empty) ────────────
    // If all QuestDB sources returned empty, try fetching daily candles
    // from the Kite Historical API directly (like charts.rs does).
    if candles.is_empty() {
        info!(
            "[deep_quant] step=1/5 all_sources_empty — triggering proactive Kite fetch for {}",
            symbol
        );

        let api_key = std::env::var("KITE_API_KEY").ok();
        let access_token = std::env::var("KITE_ACCESS_TOKEN").ok();

        if let (Some(api_key), Some(access_token)) = (api_key, access_token) {
            // Resolve instrument token from the local SQLite cache
            let local_token: Option<u32> = {
                app.try_state::<crate::db::DbState>()
                    .and_then(|db_state| {
                        crate::commands::instruments::resolve_instrument_token(
                            &db_state, &symbol
                        )
                    })
            };

            if let Some(token) = local_token {
                info!(
                    "[deep_quant] proactive_fetch: {} token={} — calling Kite Historical API",
                    symbol, token
                );
                match crate::services::history_loader::load_historical_data(
                    pool.inner(),
                    token,
                    &symbol,
                    &api_key,
                    &access_token,
                ).await {
                    Ok(count) => {
                        info!(
                            "[deep_quant] proactive_fetch: {} — {} candles ingested. Retrying DB load.",
                            symbol, count
                        );
                        // Retry the DB load now that data exists
                        candles = load_candles_from_db(pool.inner(), &symbol, 200)
                            .await
                            .unwrap_or_default();
                    }
                    Err(e) => {
                        warn!(
                            "[deep_quant] proactive_fetch: Kite API failed for {}: {}",
                            symbol, e
                        );
                    }
                }
            } else {
                warn!(
                    "[deep_quant] proactive_fetch: could not resolve instrument token for {} — cannot fetch from Kite",
                    symbol
                );
            }
        } else {
            warn!(
                "[deep_quant] proactive_fetch: KITE_API_KEY/KITE_ACCESS_TOKEN not set — cannot fetch for {}",
                symbol
            );
        }
    }

    // ── AI RECEIVER TRACER ──────────────────────────────────────────────
    // Diagnostic: verify exactly what Rust has before calling DeepSeek.
    println!("🧠 [RUST AI RECEIVER] Symbol: {} | Candles received: {} (after waterfall + proactive fetch)", symbol, candles.len());

    if candles.is_empty() {
        let msg = format!(
            "Cannot run AI analysis for {}: No candle data found in any source (historical_candles, historical_intraday, live_ticks) and Kite API fetch failed or unavailable.",
            symbol
        );
        warn!("[deep_quant] step=1/5 FAIL {}", msg);
        return Err(msg);
    }

    if candles.len() < 50 {
        let msg = format!(
            "Insufficient data for {}: only {} candles available (DeepSeek requires ≥50 for meaningful analysis).",
            symbol,
            candles.len()
        );
        warn!("[deep_quant] step=1/5 FAIL {}", msg);
        return Err(msg);
    }


    info!(
        "[deep_quant] step=1/5 candle_load_done elapsed_ms={} candles={} symbol={}",
        t_step.elapsed().as_millis(),
        candles.len(),
        symbol,
    );

    // ── Step 2: Compute indicators and consensus ────────────────────────
    let t_step = Instant::now();
    info!("[deep_quant] step=2/5 consensus_compute_start");

    let indicators = IndicatorState::from_candles_basic(&candles);
    let consensus = ConsensusEngine::compile_consensus(&symbol, &candles, &indicators);

    info!(
        "[deep_quant] step=2/5 consensus_compute_done elapsed_ms={} trend={} momentum={} volatility={} volume={} patterns={:?} strategies={:?}",
        t_step.elapsed().as_millis(),
        consensus.trend_score,
        consensus.momentum_state,
        consensus.volatility_state,
        consensus.volume_flow_state,
        consensus.active_patterns,
        consensus.active_strategies
    );

    // Emit consensus to frontend for real-time dashboard display
    let _ = app.emit("quant-consensus", serde_json::json!(&consensus));
    info!("[deep_quant] step=2/5 emit=quant-consensus");

    // ── Step 3: Fetch news context ──────────────────────────────────────
    let t_step = Instant::now();
    info!("[deep_quant] step=3/5 news_fetch_start symbol={}", symbol);

    let news = fetch_news_context(&symbol).await;
    info!(
        "[deep_quant] step=3/5 news_fetch_done elapsed_ms={} chars={}",
        t_step.elapsed().as_millis(),
        news.len()
    );

    // ── Step 4: Call LLM via bridge (or mock in test mode) ──────────────
    let t_step = Instant::now();
    let plan = if crate::is_test_mode() {
        info!("[deep_quant] step=4/5 llm_call_start mode=TEST_MODE_MOCK");
        let mocked = crate::mock_ai_execution_plan();
        info!(
            "[deep_quant] step=4/5 llm_call_done elapsed_ms={} mode=mocked conviction={}",
            t_step.elapsed().as_millis(),
            mocked.conviction_score
        );
        mocked
    } else {
        info!("[deep_quant] step=4/5 llm_call_start mode=LIVE");
        match llm::generate_deep_quant_plan(&symbol, &consensus, &news, Some(&app)).await {
            Ok(p) => {
                info!(
                    "[deep_quant] step=4/5 llm_call_done elapsed_ms={} conviction={}",
                    t_step.elapsed().as_millis(),
                    p.conviction_score
                );
                p
            }
            Err(e) => {
                error!(
                    "[deep_quant] step=4/5 llm_call_FAIL elapsed_ms={} err={}",
                    t_step.elapsed().as_millis(),
                    e
                );
                return Err(e);
            }
        }
    };

    // ── Step 5: Emit result event and return ────────────────────────────
    let _ = app.emit("deep-quant-result", serde_json::json!(&plan));
    info!("[deep_quant] step=5/5 emit=deep-quant-result");

    info!(
        "[deep_quant] PIPELINE_DONE symbol={} total_elapsed_ms={} conviction={}",
        symbol,
        t_total.elapsed().as_millis(),
        plan.conviction_score
    );

    Ok(plan)
}
