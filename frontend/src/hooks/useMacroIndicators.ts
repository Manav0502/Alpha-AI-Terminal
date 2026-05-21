// hooks/useMacroIndicators.ts — Live Indian market macro indicators via Kite Quote API
//
// Follows the exact same architecture as WatchlistPanel.tsx:
//   1. Define index symbols to track
//   2. Poll /kite/quote every 30s
//   3. Return structured data for the MacroSentimentPanel
//
// No new backend endpoints needed — reuses the existing Kite REST proxy on :8084.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTradeStore } from '../store/useTradeStore';

// ── Index Definitions ────────────────────────────────────────────────────────
// These are NSE indices available via Kite Connect's quote API.

export interface MacroIndex {
  /** Kite-format instrument key, e.g. "NSE:NIFTY 50" */
  kiteKey: string;
  /** Display label in the panel */
  label: string;
  /** Short category tag */
  category: 'Benchmark' | 'Sectoral' | 'Volatility';
}

export const MACRO_INDICES: MacroIndex[] = [
  { kiteKey: 'NSE:NIFTY 50',           label: 'NIFTY 50',       category: 'Benchmark' },
  { kiteKey: 'NSE:NIFTY BANK',         label: 'BANK NIFTY',     category: 'Benchmark' },
  { kiteKey: 'NSE:INDIA VIX',          label: 'INDIA VIX',      category: 'Volatility' },
  { kiteKey: 'NSE:NIFTY IT',           label: 'NIFTY IT',       category: 'Sectoral' },
  { kiteKey: 'NSE:NIFTY FIN SERVICE',  label: 'NIFTY FIN SVC',  category: 'Sectoral' },
];

// ── Quote Data (mirrors WatchlistPanel's QuoteData) ──────────────────────────

export interface MacroQuote {
  symbol: string;
  last_price: number;
  open: number;
  high: number;
  low: number;
  close: number; // previous close
  volume: number;
  change: number; // % change
  net_change: number;
}

// ── Enriched indicator for rendering ─────────────────────────────────────────

export interface MacroIndicator {
  label: string;
  category: MacroIndex['category'];
  value: string;
  change: string;
  direction: 'up' | 'down' | 'flat';
  raw: MacroQuote | null;
}

// ── Portfolio Risk Metrics ───────────────────────────────────────────────────

export interface PortfolioMetric {
  label: string;
  value: string;
  tooltip?: string;
}

// ── Hook Return Type ─────────────────────────────────────────────────────────

interface UseMacroIndicatorsReturn {
  indicators: MacroIndicator[];
  portfolioMetrics: PortfolioMetric[];
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
}

// ── Helper: format index price ───────────────────────────────────────────────

function formatIndexPrice(price: number, label: string): string {
  // VIX is a small number, show 2 decimals
  if (label.includes('VIX')) {
    return price.toFixed(2);
  }
  // Indices: show with comma separator, no decimals for large values
  if (price >= 1000) {
    return price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return price.toFixed(2);
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useMacroIndicators(): UseMacroIndicatorsReturn {
  const [quotes, setQuotes] = useState<Record<string, MacroQuote>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Read trade data from Zustand store for portfolio metrics
  const executedTrades = useTradeStore((s) => s.executedTrades);
  const portfolioBalance = useTradeStore((s) => s.portfolioBalance);

  // ── Fetch macro quotes ─────────────────────────────────────────────────
  const fetchMacroQuotes = useCallback(async () => {
    try {
      // Build query params identical to WatchlistPanel pattern
      const params = MACRO_INDICES.map((idx) => `i=${encodeURIComponent(idx.kiteKey)}`).join('&');
      const res = await fetch(`/kite/quote?${params}`);

      if (!res.ok) {
        throw new Error(`Kite quote API returned ${res.status}`);
      }

      const data = await res.json();

      if (data.quotes && Array.isArray(data.quotes)) {
        const map: Record<string, MacroQuote> = {};
        for (const q of data.quotes) {
          map[q.symbol] = q;
        }
        setQuotes(map);
        setLastUpdated(Date.now());
        setError(null);
      }
    } catch (err: any) {
      console.error('[MacroIndicators] Quote fetch failed:', err);
      setError(err?.message || 'Failed to fetch macro data');
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll on mount + every 30s (same cadence as WatchlistPanel)
  useEffect(() => {
    fetchMacroQuotes();
    intervalRef.current = setInterval(fetchMacroQuotes, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchMacroQuotes]);

  // ── Build enriched indicators ──────────────────────────────────────────
  const indicators: MacroIndicator[] = MACRO_INDICES.map((idx) => {
    // Extract the symbol portion from kiteKey (e.g. "NSE:NIFTY 50" → "NIFTY 50")
    const symbol = idx.kiteKey.split(':')[1] || idx.kiteKey;
    const quote = quotes[symbol] ?? null;

    if (!quote) {
      return {
        label: idx.label,
        category: idx.category,
        value: '—',
        change: '',
        direction: 'flat' as const,
        raw: null,
      };
    }

    const direction: 'up' | 'down' | 'flat' =
      quote.change > 0.01 ? 'up' : quote.change < -0.01 ? 'down' : 'flat';

    return {
      label: idx.label,
      category: idx.category,
      value: formatIndexPrice(quote.last_price, idx.label),
      change: `${quote.change >= 0 ? '+' : ''}${quote.change.toFixed(2)}%`,
      direction,
      raw: quote,
    };
  });

  // ── Compute Portfolio Risk Metrics from live store data ────────────────
  const portfolioMetrics: PortfolioMetric[] = computePortfolioMetrics(
    executedTrades,
    portfolioBalance,
  );

  return { indicators, portfolioMetrics, loading, error, lastUpdated };
}

// ── Portfolio metrics computation ────────────────────────────────────────────

function computePortfolioMetrics(
  trades: ReturnType<typeof useTradeStore.getState>['executedTrades'],
  currentBalance: number,
): PortfolioMetric[] {
  const initialBalance = 100_000; // Matches useTradeStore default

  // Total P&L
  const totalPnL = currentBalance - initialBalance;
  const totalReturn = initialBalance > 0 ? (totalPnL / initialBalance) * 100 : 0;

  // Win rate
  const completedTrades = trades.filter((t) => t.decision.price != null);
  const winningTrades = completedTrades.filter((t) => {
    if (t.decision.action_type === 'BUY') return (t.decision.price ?? 0) > 0;
    if (t.decision.action_type === 'SELL') return (t.decision.price ?? 0) > 0;
    return false;
  });
  const winRate = completedTrades.length > 0
    ? (winningTrades.length / completedTrades.length) * 100
    : 0;

  // Max drawdown from balance trajectory
  let peak = initialBalance;
  let maxDrawdown = 0;
  let runningBalance = initialBalance;
  for (const trade of trades) {
    const price = trade.decision.price ?? 0;
    if (trade.decision.action_type === 'BUY') {
      runningBalance -= price * trade.quantity;
    } else if (trade.decision.action_type === 'SELL') {
      runningBalance += price * trade.quantity;
    }
    if (runningBalance > peak) peak = runningBalance;
    const dd = peak > 0 ? ((peak - runningBalance) / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Avg conviction from decisions
  const avgConviction = completedTrades.length > 0
    ? completedTrades.reduce((sum, t) => sum + t.decision.final_conviction_score, 0) / completedTrades.length
    : 0;

  return [
    {
      label: 'Total Return',
      value: `${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(1)}%`,
      tooltip: `₹${totalPnL.toLocaleString('en-IN', { maximumFractionDigits: 0 })} P&L`,
    },
    {
      label: 'Win Rate',
      value: completedTrades.length > 0 ? `${winRate.toFixed(0)}%` : '—',
      tooltip: `${winningTrades.length}/${completedTrades.length} trades`,
    },
    {
      label: 'Max Drawdown',
      value: maxDrawdown > 0 ? `-${maxDrawdown.toFixed(1)}%` : '0.0%',
    },
    {
      label: 'Avg Conviction',
      value: avgConviction > 0 ? `${avgConviction.toFixed(0)}/100` : '—',
      tooltip: 'Average AI conviction score across executed trades',
    },
  ];
}
