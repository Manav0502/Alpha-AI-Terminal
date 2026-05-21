// hooks/useMultiTimeframeTrend.ts — Compute real-time multi-timeframe trend bias
//
// Reads live OHLC candles from the Zustand store (streamed via Alpha WebSocket :8081),
// aggregates them into 1H / 4H / 1D / 1W buckets, and computes trend bias using:
//   - EMA 9/21 crossover direction
//   - RSI (14-period) overbought/oversold zones
//   - Price momentum (close vs open of the aggregated window)
//
// Follows the same architecture pattern as useMacroIndicators.ts and WatchlistPanel.

import { useMemo } from 'react';
import { useTradeStore, OhlcCandle } from '../store/useTradeStore';

// ── Types ────────────────────────────────────────────────────────────────────

export type TrendBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface TimeframeTrend {
  timeframe: string;
  bias: TrendBias;
  /** 0–100 strength score */
  strength: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const TIMEFRAME_CONFIGS = [
  { label: '1H',  ms: 60 * 60_000 },
  { label: '4H',  ms: 4 * 60 * 60_000 },
  { label: '1D',  ms: 24 * 60 * 60_000 },
  { label: '1W',  ms: 7 * 24 * 60 * 60_000 },
] as const;

// ── EMA Calculation (identical to AlphaPredictiveChart's engine) ─────────────

function calculateEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const result: number[] = [];
  const k = 2 / (period + 1);

  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period) {
      sum += values[i];
      result.push(sum / (i + 1)); // progressive SMA seed
    } else {
      const ema = values[i] * k + result[result.length - 1] * (1 - k);
      result.push(ema);
    }
  }
  return result;
}

// ── RSI Calculation (standard Wilder's smoothing, 14-period) ─────────────────

function calculateRSI(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average gain/loss from first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // Smooth with Wilder's method for remaining data
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ── Candle Aggregation (same bucket logic as AlphaPredictiveChart) ────────────

function aggregateToTimeframe(
  candles: OhlcCandle[],
  intervalMs: number,
  symbol: string,
): { opens: number[]; closes: number[]; highs: number[]; lows: number[] } {
  const filtered = symbol
    ? candles.filter((c) => c.symbol.toUpperCase() === symbol.toUpperCase())
    : candles;

  if (filtered.length === 0) {
    return { opens: [], closes: [], highs: [], lows: [] };
  }

  const sorted = [...filtered].sort((a, b) => a.start_timestamp_ms - b.start_timestamp_ms);

  const buckets = new Map<number, { open: number; high: number; low: number; close: number }>();

  for (const candle of sorted) {
    const key = Math.floor(candle.start_timestamp_ms / intervalMs) * intervalMs;
    const existing = buckets.get(key);
    if (existing) {
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
    } else {
      buckets.set(key, {
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });
    }
  }

  const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
  const opens: number[] = [];
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];

  for (const key of keys) {
    const b = buckets.get(key)!;
    opens.push(b.open);
    closes.push(b.close);
    highs.push(b.high);
    lows.push(b.low);
  }

  return { opens, closes, highs, lows };
}

// ── Trend Computation ────────────────────────────────────────────────────────

function computeTrend(closes: number[]): { bias: TrendBias; strength: number } {
  if (closes.length < 3) {
    return { bias: 'NEUTRAL', strength: 50 };
  }

  // ── Signal components (each contributes to a -100 to +100 score) ────

  let score = 0;
  let signals = 0;

  // 1. EMA 9/21 crossover (strongest signal)
  const ema9 = calculateEMA(closes, Math.min(9, closes.length));
  const ema21 = calculateEMA(closes, Math.min(21, closes.length));

  if (ema9.length > 0 && ema21.length > 0) {
    const latestEma9 = ema9[ema9.length - 1];
    const latestEma21 = ema21[ema21.length - 1];
    const emaDiff = ((latestEma9 - latestEma21) / latestEma21) * 100;

    // Clamp to ±3% for scoring
    const emaSignal = Math.max(-100, Math.min(100, emaDiff * 33));
    score += emaSignal * 2; // double weight
    signals += 2;
  }

  // 2. RSI (14-period)
  const rsi = calculateRSI(closes);
  if (rsi !== null) {
    // RSI > 50 = bullish, < 50 = bearish; scale to -100..+100
    const rsiSignal = (rsi - 50) * 2;
    score += rsiSignal;
    signals += 1;
  }

  // 3. Price momentum: latest close vs first close in window
  const first = closes[0];
  const last = closes[closes.length - 1];
  if (first > 0) {
    const momentumPct = ((last - first) / first) * 100;
    const momSignal = Math.max(-100, Math.min(100, momentumPct * 20));
    score += momSignal;
    signals += 1;
  }

  if (signals === 0) return { bias: 'NEUTRAL', strength: 50 };

  // Average score: -100 to +100
  const avgScore = score / signals;

  // Map to bias
  const bias: TrendBias =
    avgScore > 15 ? 'BULLISH' : avgScore < -15 ? 'BEARISH' : 'NEUTRAL';

  // Map to 0-100 strength (50 = neutral center)
  const strength = Math.round(Math.max(0, Math.min(100, 50 + avgScore / 2)));

  return { bias, strength };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useMultiTimeframeTrend(): TimeframeTrend[] {
  const ohlcCandles = useTradeStore((s) => s.ohlcCandles);
  const activeDecision = useTradeStore((s) => s.activeDecision);
  const liveDecisions = useTradeStore((s) => s.liveDecisions);

  const activeSymbol = useMemo(() => {
    const d = activeDecision ?? liveDecisions[liveDecisions.length - 1];
    return d?.symbol ?? '';
  }, [activeDecision, liveDecisions]);

  const trends = useMemo((): TimeframeTrend[] => {
    if (ohlcCandles.length === 0 || !activeSymbol) {
      // Return neutral defaults when no data
      return TIMEFRAME_CONFIGS.map((tf) => ({
        timeframe: tf.label,
        bias: 'NEUTRAL' as TrendBias,
        strength: 50,
      }));
    }

    return TIMEFRAME_CONFIGS.map((tf) => {
      const { closes } = aggregateToTimeframe(ohlcCandles, tf.ms, activeSymbol);
      const { bias, strength } = computeTrend(closes);
      return { timeframe: tf.label, bias, strength };
    });
  }, [ohlcCandles, activeSymbol]);

  return trends;
}
