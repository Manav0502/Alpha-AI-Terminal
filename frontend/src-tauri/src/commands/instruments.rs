// commands/instruments.rs — Instrument Search API
//
// Provides a fast local search over the cached Kite NSE instruments table.
// Called by the React search bar as the user types to provide autocomplete
// results without hitting the Kite API on every keystroke.

use log::info;
use rusqlite::params;
use serde::Serialize;

use crate::db::DbState;

/// A single instrument record returned by the search command.
#[derive(Debug, Clone, Serialize)]
pub struct InstrumentRecord {
    pub instrument_token: i64,
    pub tradingsymbol: String,
    pub name: String,
    pub instrument_type: String,
    pub exchange: String,
}

/// Search the local instruments SQLite table for symbols matching the query.
///
/// Performs a fast `LIKE '%QUERY%'` search on both `tradingsymbol` and `name`
/// columns, returning the top 10 matches ordered by relevance (exact prefix
/// matches first, then partial matches).
///
/// # Frontend usage
/// ```ts
/// const results = await invoke('search_instruments', { query: 'RELI' });
/// // → [{ instrument_token: 738561, tradingsymbol: "RELIANCE", name: "Reliance Industries", ... }]
/// ```
#[tauri::command]
pub async fn search_instruments(
    query: String,
    state: tauri::State<'_, DbState>,
) -> Result<Vec<InstrumentRecord>, String> {
    let q = query.trim().to_uppercase();

    if q.is_empty() {
        return Ok(vec![]);
    }

    let conn = state.conn.lock().map_err(|e| format!("DB lock error: {}", e))?;

    // Check if the instruments table exists
    let table_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='instruments';",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false);

    if !table_exists {
        return Err("Instruments table not yet populated. Please wait for initial sync.".into());
    }

    let like_prefix = format!("{}%", q);
    let like_contains = format!("%{}%", q);

    // Query: prioritise prefix matches on tradingsymbol, then name contains
    let mut stmt = conn
        .prepare(
            "SELECT instrument_token, tradingsymbol, name, instrument_type, exchange
             FROM instruments
             WHERE tradingsymbol LIKE ?1 OR name LIKE ?2
             ORDER BY
                 CASE WHEN tradingsymbol LIKE ?1 THEN 0 ELSE 1 END,
                 LENGTH(tradingsymbol) ASC
             LIMIT 10;",
        )
        .map_err(|e| format!("SQL prepare error: {}", e))?;

    let results: Vec<InstrumentRecord> = stmt
        .query_map(params![like_prefix, like_contains], |row| {
            Ok(InstrumentRecord {
                instrument_token: row.get(0)?,
                tradingsymbol: row.get(1)?,
                name: row.get(2)?,
                instrument_type: row.get(3)?,
                exchange: row.get(4)?,
            })
        })
        .map_err(|e| format!("SQL query error: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    info!(
        "[search_instruments] query='{}' → {} results",
        q,
        results.len()
    );

    Ok(results)
}

/// Resolve a tradingsymbol to its instrument_token from the local cache.
/// Used internally by subscribe_ticker to avoid hitting the aggregator API.
///
/// Returns None if the symbol is not found in the local instruments table.
pub fn resolve_instrument_token(
    db_state: &DbState,
    symbol: &str,
) -> Option<u32> {
    let conn = db_state.conn.lock().ok()?;
    let upper = symbol.trim().to_uppercase();

    conn.query_row(
        "SELECT instrument_token FROM instruments WHERE tradingsymbol = ?1 LIMIT 1;",
        params![upper],
        |row| row.get::<_, i64>(0),
    )
    .ok()
    .map(|t| t as u32)
}
