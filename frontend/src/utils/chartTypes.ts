import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { TradeProfile } from '../store/useTradeStore';

// ── Exported Types ────────────────────────────────────────────────────────

/**
 * All supported chart timeframes.
 *
 * Kite Historical API natively supports: minute, 3minute, 5minute, 10minute,
 * 15minute, 60minute, day.  Timeframes not directly available (2m, 4m, 30m,
 * 75m, 125m, 2h, 3h, 4h, 1W, 1M) are aggregated client-side from the nearest
 * lower-resolution base interval.
 */
export type Timeframe =
  | '1m' | '2m' | '3m' | '4m' | '5m'
  | '10m' | '15m' | '30m' | '75m' | '125m'
  | '1h' | '1H' | '2h' | '3h' | '4h'
  | '1D' | '1W' | '1M';

/** Data range — how far back to fetch historical data. */
export type DataRange = '60D' | '1Y' | '2Y' | '3Y' | '5Y';

export interface AlphaPredictiveChartProps {
  activeProfile?: TradeProfile;
  timeframe?: Timeframe;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

/** Lightweight-charts compatible candle with numeric time. */
export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Volume histogram bar. */
export interface VolumeBar {
  time: number;
  value: number;
  color: string;
}

/** EMA data point. */
export interface EmaPoint {
  time: number;
  value: number;
}

/** Bundled chart refs passed between hooks. */
export interface ChartRefs {
  chartRef: React.RefObject<IChartApi | null>;
  candleSeriesRef: React.RefObject<ISeriesApi<'Candlestick'> | null>;
  volumeSeriesRef: React.RefObject<ISeriesApi<'Histogram'> | null>;
  ghostLineRef: React.RefObject<ISeriesApi<'Line'> | null>;
  ema9SeriesRef: React.RefObject<ISeriesApi<'Line'> | null>;
  ema21SeriesRef: React.RefObject<ISeriesApi<'Line'> | null>;
  chartContainerRef: React.RefObject<HTMLDivElement | null>;
  drawingSeriesRef: React.MutableRefObject<ISeriesApi<'Line'>[]>;
  fibOverlayRef: React.RefObject<HTMLDivElement | null>;
}

// ── Constants ─────────────────────────────────────────────────────────────

/** Milliseconds per timeframe bucket — used by the aggregation engine. */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m':   60_000,
  '2m':   2 * 60_000,
  '3m':   3 * 60_000,
  '4m':   4 * 60_000,
  '5m':   5 * 60_000,
  '10m':  10 * 60_000,
  '15m':  15 * 60_000,
  '30m':  30 * 60_000,
  '75m':  75 * 60_000,
  '125m': 125 * 60_000,
  '1h':   60 * 60_000,
  '1H':   60 * 60_000,
  '2h':   2 * 60 * 60_000,
  '3h':   3 * 60 * 60_000,
  '4h':   4 * 60 * 60_000,
  '1D':   24 * 60 * 60_000,
  '1W':   7 * 24 * 60 * 60_000,
  '1M':   30 * 24 * 60 * 60_000, // approximate
};

/**
 * Maps each Timeframe to the Kite Historical API interval string used to
 * fetch the base data.  Timeframes without a direct Kite equivalent use the
 * closest lower-resolution interval and aggregate client-side.
 */
export const KITE_INTERVAL_MAP: Record<Timeframe, string> = {
  '1m':   'minute',
  '2m':   'minute',      // aggregate from 1-minute
  '3m':   '3minute',
  '4m':   'minute',      // aggregate from 1-minute
  '5m':   '5minute',
  '10m':  '10minute',
  '15m':  '15minute',
  '30m':  '30minute',
  '75m':  '15minute',    // aggregate from 15-minute
  '125m': '15minute',    // aggregate from 15-minute
  '1h':   '60minute',
  '1H':   '60minute',
  '2h':   '60minute',    // aggregate from 1-hour
  '3h':   '60minute',    // aggregate from 1-hour
  '4h':   '60minute',    // aggregate from 1-hour
  '1D':   'day',
  '1W':   'day',         // aggregate from daily
  '1M':   'day',         // aggregate from daily
};

/** Days of historical data per range label. */
export const RANGE_DAYS: Record<DataRange, number> = {
  '60D': 60,
  '1Y':  365,
  '2Y':  730,
  '3Y':  1095,
  '5Y':  1825,
};

/** The ordered list of all timeframes grouped for the dropdown UI. */
export const TIMEFRAME_GROUPS: { label: string; items: { tf: Timeframe; display: string }[] }[] = [
  {
    label: 'Minutes',
    items: [
      { tf: '1m', display: '1 minute' },
      { tf: '2m', display: '2 minutes' },
      { tf: '3m', display: '3 minutes' },
      { tf: '4m', display: '4 minutes' },
      { tf: '5m', display: '5 minutes' },
      { tf: '10m', display: '10 minutes' },
      { tf: '15m', display: '15 minutes' },
      { tf: '30m', display: '30 minutes' },
      { tf: '75m', display: '75 minutes' },
      { tf: '125m', display: '125 minutes' },
    ],
  },
  {
    label: 'Hours',
    items: [
      { tf: '1h', display: '1 hour' },
      { tf: '2h', display: '2 hours' },
      { tf: '3h', display: '3 hours' },
      { tf: '4h', display: '4 hours' },
    ],
  },
  {
    label: 'Days',
    items: [
      { tf: '1D', display: '1 day' },
      { tf: '1W', display: '1 week' },
      { tf: '1M', display: '1 month' },
    ],
  },
];

// ── Institutional Dark-Mode Palette ──────────────────────────────────────
export const COLORS = {
  canvasBg: '#0F172A',
  text: '#CBD5E1',
  up: '#22c55e',
  down: '#ef4444',
  volumeUp: 'rgba(34, 197, 94, 0.35)',
  volumeDown: 'rgba(239, 68, 68, 0.30)',
  grid: 'rgba(51, 65, 85, 0.4)',
  crosshair: 'rgba(148, 163, 184, 0.5)',
  crosshairLabel: '#1E293B',
  border: '#334155',
  ghostLine: '#f59e0b',
  ema9: '#38bdf8',
  ema21: '#f472b6',
};
