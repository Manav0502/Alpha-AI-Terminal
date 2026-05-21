// backend/db/migration.rs — QuestDB Schema Migration Runner
//
// Executes SQL migration files against QuestDB's Postgres wire protocol
// (port 8812). Called once during Tauri application startup to ensure
// the `historical_candles` table exists with yearly partitioning.
//
// This module is referenced by the Tauri lib.rs but the actual migration
// logic is inlined in the Tauri crate's services module for compilation
// simplicity. This file serves as the canonical migration runner reference.
//
// Connection: Uses QUESTDB_POSTGRES_URL from .env
//   Default: postgresql://admin:quest@localhost:8812/qdb

use sqlx::PgPool;
use log::{info, error};

/// Run all pending migrations against QuestDB.
///
/// Currently executes the `002_historical.sql` DDL inline.
/// This is idempotent — `CREATE TABLE IF NOT EXISTS` ensures
/// re-runs are safe.
pub async fn run_migrations(pool: &PgPool) {
    let ddl = "
        CREATE TABLE IF NOT EXISTS historical_candles (
            symbol    SYMBOL,
            ts        TIMESTAMP,
            open      DOUBLE,
            high      DOUBLE,
            low       DOUBLE,
            close     DOUBLE,
            volume    LONG
        ) timestamp(ts) PARTITION BY YEAR;
    ";

    match sqlx::query(ddl).execute(pool).await {
        Ok(_) => info!("QuestDB migration: historical_candles table ready (PARTITION BY YEAR)."),
        Err(e) => error!("QuestDB migration failed: {}", e),
    }
}
