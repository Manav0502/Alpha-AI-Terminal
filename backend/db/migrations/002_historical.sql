-- ============================================================================
-- Migration 002: Historical Candles — 5-Year Cold Storage
-- ============================================================================
-- Table: historical_candles
--
-- Purpose:
--   Stores daily OHLCV candle data fetched from the Zerodha Kite Historical
--   API. Designed for 5-year lookback with yearly partitioning for efficient
--   range scans and disk management.
--
-- Partitioning:
--   PARTITION BY YEAR — each calendar year gets its own partition directory
--   in QuestDB's storage engine. This allows:
--     - Fast date-range queries (only relevant partitions are scanned)
--     - Efficient data lifecycle management (drop old partitions to reclaim space)
--     - Optimal compression ratios (yearly files are large enough to compress well)
--
-- Designated Timestamp:
--   `ts` is the designated timestamp column — QuestDB uses this for time-series
--   ordering, WAL ingestion, and partition routing.
--
-- Usage:
--   Executed once at application startup via the Rust migration runner.
--   QuestDB's `IF NOT EXISTS` makes this idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS historical_candles (
    symbol    SYMBOL,
    ts        TIMESTAMP,
    open      DOUBLE,
    high      DOUBLE,
    low       DOUBLE,
    close     DOUBLE,
    volume    LONG
) timestamp(ts) PARTITION BY YEAR;
