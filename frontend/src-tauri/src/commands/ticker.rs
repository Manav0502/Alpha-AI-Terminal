// commands/ticker.rs — Dynamic symbol subscription command
//
// Manages the currently active chart symbol in a thread-safe Tauri state.
// Called by the frontend on every symbol switch to keep the Rust backend
// in sync with the chart's active instrument.
//
// On symbol switch (PRODUCTION):
//   1. Updates ActiveSymbolState so the mock emitter and UI reads the correct symbol.
//   2. Resolves the Kite instrument token via the aggregator's /api/kite/instruments.
//   3. Sends "subscribe:TOKEN:SYMBOL\n" to the ingestion control TCP server (:8085)
//      so the Kite WebSocket immediately starts streaming the new symbol's ticks.

use tokio::sync::Mutex;
use log::info;

/// Thread-safe container for the currently active chart symbol.
pub struct ActiveSymbolState {
    pub symbol: Mutex<String>,
}

impl ActiveSymbolState {
    pub fn new(initial: &str) -> Self {
        Self {
            symbol: Mutex::new(initial.to_string()),
        }
    }
}

/// Tauri IPC command: switch the active chart symbol.
///
/// Returns immediately — all network side-effects run in a background task.
///
/// # Frontend usage
/// ```ts
/// await invoke('subscribe_ticker', { symbol: 'INFY' });
/// ```
#[tauri::command]
pub async fn subscribe_ticker(
    app: tauri::AppHandle,
    state: tauri::State<'_, ActiveSymbolState>,
    symbol: String,
) -> Result<(), String> {
    let upper = symbol.trim().to_uppercase();
    if upper.is_empty() {
        return Err("subscribe_ticker: symbol must not be empty".to_string());
    }

    // ── Lazy bring-up of the internal WS → IPC bridges ──────────────────
    crate::services::live_bridges::ensure_bootstrapped(&app);

    {
        let mut lock = state.symbol.lock().await;
        let prev = lock.clone();
        *lock = upper.clone();
        info!("[subscribe_ticker] Active symbol: {} → {}", prev, upper);
    }

    // ── Resolve instrument token from local SQLite cache first ───────────
    let local_token: Option<u32> = {
        use tauri::Manager;
        let db_state: tauri::State<'_, crate::db::DbState> = app.state();
        crate::commands::instruments::resolve_instrument_token(&db_state, &upper)
    };

    // Fire-and-forget: notify ingestion service
    let sym = upper.clone();
    tokio::spawn(async move {
        if let Some(token) = local_token {
            // Fast path: token resolved locally — skip HTTP lookup
            info!("[subscribe_ticker] Token {} resolved locally for {}", token, sym);
            send_subscribe_to_ingestion(&sym, token).await;
        } else {
            // Fallback: resolve via aggregator HTTP API
            notify_ingestion_subscribe(&sym).await;
        }
    });

    Ok(())
}

/// Direct path: send subscribe command to ingestion when token is already known.
/// Skips the HTTP lookup entirely — used when the local SQLite cache has the token.
async fn send_subscribe_to_ingestion(symbol: &str, token: u32) {
    let control_port = std::env::var("INGESTION_CONTROL_PORT")
        .unwrap_or_else(|_| "8085".to_string());

    use tokio::io::AsyncWriteExt;
    let addr = format!("127.0.0.1:{}", control_port);
    match tokio::net::TcpStream::connect(&addr).await {
        Ok(mut stream) => {
            let cmd = format!("subscribe:{}:{}\n", token, symbol);
            match stream.write_all(cmd.as_bytes()).await {
                Ok(_) => info!(
                    "[subscribe_ticker] ✓ {} (token {}) → ingestion subscribed (local resolve)",
                    symbol, token
                ),
                Err(e) => log::warn!("[subscribe_ticker] Control write error: {}", e),
            }
        }
        Err(e) => {
            log::warn!(
                "[subscribe_ticker] Cannot reach ingestion control :{} — {}\
                 \n  (ingestion may not be running or INGESTION_CONTROL_PORT is wrong)",
                control_port, e
            );
        }
    }
}

/// Resolves the Kite instrument token for `symbol` from the aggregator's
/// instrument cache, then sends a `subscribe:TOKEN:SYMBOL\n` command to
/// the ingestion service's TCP control port.
async fn notify_ingestion_subscribe(symbol: &str) {
    let kite_port    = std::env::var("KITE_API_PORT")
        .unwrap_or_else(|_| "8084".to_string());
    let control_port = std::env::var("INGESTION_CONTROL_PORT")
        .unwrap_or_else(|_| "8085".to_string());

    // ── Step 1: Token lookup ─────────────────────────────────────────────────
    let url = format!(
        "http://127.0.0.1:{}/api/kite/instruments?q={}&exchange=NSE",
        kite_port,
        urlencoding::encode(symbol)
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();

    let token: Option<u32> = match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            resp.json::<serde_json::Value>().await.ok()
                .and_then(|json| {
                    json.as_array()?.iter().find(|inst| {
                        inst.get("tradingsymbol")
                            .and_then(|s| s.as_str())
                            .map(|s| s.eq_ignore_ascii_case(symbol))
                            .unwrap_or(false)
                    }).cloned()
                })
                .and_then(|inst| inst.get("instrument_token")?.as_u64())
                .map(|t| t as u32)
        }
        Ok(resp) => {
            log::warn!("[subscribe_ticker] Instrument lookup HTTP {} for {}", resp.status(), symbol);
            None
        }
        Err(e) => {
            log::warn!("[subscribe_ticker] Instrument lookup failed for {}: {}", symbol, e);
            None
        }
    };

    let token = match token {
        Some(t) => t,
        None => {
            log::warn!(
                "[subscribe_ticker] No token found for {} — live ticks unavailable until resolved.",
                symbol
            );
            return;
        }
    };

    // ── Step 2: Notify ingestion control server ───────────────────────────────
    use tokio::io::AsyncWriteExt;
    let addr = format!("127.0.0.1:{}", control_port);
    match tokio::net::TcpStream::connect(&addr).await {
        Ok(mut stream) => {
            let cmd = format!("subscribe:{}:{}\n", token, symbol);
            match stream.write_all(cmd.as_bytes()).await {
                Ok(_) => info!(
                    "[subscribe_ticker] ✓ {} (token {}) → ingestion subscribed (HTTP resolve)",
                    symbol, token
                ),
                Err(e) => log::warn!("[subscribe_ticker] Control write error: {}", e),
            }
        }
        Err(e) => {
            log::warn!(
                "[subscribe_ticker] Cannot reach ingestion control :{} — {}\
                 \n  (ingestion may not be running or INGESTION_CONTROL_PORT is wrong)",
                control_port, e
            );
        }
    }
}
