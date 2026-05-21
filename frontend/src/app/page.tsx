'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { PanelRightClose, PanelRightOpen, ArrowUpRight, ArrowDownRight, ChevronDown } from 'lucide-react';
import TradingChart from '../components/TradingChart';
import TerminalLayout from '../components/layout/TerminalLayout';
import LeftPanel from '../components/panels/LeftPanel';
import OrderExecutionPanel from '../components/panels/OrderExecutionPanel';
import AlphaPredictiveChart from '../components/AlphaPredictiveChart';
import IntradayLayout from '../components/layouts/IntradayLayout';
import SwingLayout, { SwingConfluencePanel } from '../components/layouts/SwingLayout';
import InvestorLayout, { MacroSentimentPanel } from '../components/layouts/InvestorLayout';
import OrderBook from '../components/OrderBook';
import SystemConsole from '../components/SystemConsole';

import DeepQuantPanel from '../components/quant/DeepQuantPanel';
import ActivePositions from '../components/quant/ActivePositions';
import { useTradeStore, TradeProfile, ChartTimeframe } from '../store/useTradeStore';
import { useQuantStore } from '../store/useQuantStore';
import type { ConsensusReport } from '../store/useQuantStore';
import type { DataRange } from '../utils/chartTypes';
import { TIMEFRAME_GROUPS } from '../utils/chartTypes';

// ── Sidebar labels per profile ──────────────────────────────────────────
type SidebarTab = 'profile' | 'deepquant';

const SIDEBAR_CONFIG: Record<TradeProfile, { label: string; badge: string; badgeColor: string }> = {
  INTRADAY: { label: 'Order Book', badge: 'INTRADAY', badgeColor: 'bg-emerald-500/10 text-emerald-400' },
  SWING: { label: 'Confluence', badge: 'SWING', badgeColor: 'bg-amber-500/10 text-amber-400' },
  INVESTOR: { label: 'Macro Intelligence', badge: 'INVESTOR', badgeColor: 'bg-cyan-500/10 text-cyan-400' },
};

export default function Home() {
  const { connectWebSocket, connectAlphaWebSocket, connectPredictiveWebSocket, connectInsightWebSocket, activeDecision, liveDecisions, activeProfile, activeTimeframe, setActiveTimeframe, activeRange, setActiveRange, selectedSymbol } = useTradeStore();
  const [indicatorsEnabled, setIndicatorsEnabled] = useState(true);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('profile');
  const [tfDropdownOpen, setTfDropdownOpen] = useState(false);
  const tfDropdownRef = useRef<HTMLDivElement>(null);
  const consensusData = useQuantStore((s) => s.consensusData);
  const setConsensusData = useQuantStore((s) => s.setConsensusData);
  const clearConsensusData = useQuantStore((s) => s.clearConsensusData);
  const loadConsensusForSymbol = useQuantStore((s) => s.loadConsensusForSymbol);
  const clearAiPlan = useQuantStore((s) => s.clearAiPlan);

  // Listen for Tauri consensus events
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        // Bail if the component unmounted while we were importing
        if (cancelled) return;
        const u = await listen<ConsensusReport>('quant-consensus', (event) => {
          if (!cancelled) {
            setConsensusData(event.payload);
          }
        });
        if (cancelled) {
          // Already unmounted — clean up immediately
          u();
        } else {
          unlisten = u;
        }
      } catch {
        // Not in Tauri context — ignore
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setConsensusData]);

  // ── Real-time Kite quote for the active symbol ────────────────────
  interface SymbolQuote {
    symbol: string;
    last_price: number;
    open: number;
    high: number;
    low: number;
    close: number; // prev close
    change: number; // % change
    net_change: number;
    volume: number;
  }
  const [symbolQuote, setSymbolQuote] = useState<SymbolQuote | null>(null);

  useEffect(() => {
    connectWebSocket();
  }, [connectWebSocket]);

  useEffect(() => {
    connectAlphaWebSocket('ws://127.0.0.1:8081');
    connectPredictiveWebSocket('ws://127.0.0.1:8082');
    connectInsightWebSocket('ws://127.0.0.1:8083');
  }, [connectAlphaWebSocket, connectPredictiveWebSocket, connectInsightWebSocket]);

  // Derive symbol early so hooks below can reference it unconditionally.
  // selectedSymbol (watchlist click) takes priority over the AI decision symbol.
  const latestDecision = activeDecision ?? liveDecisions[liveDecisions.length - 1] ?? null;
  const symbol = selectedSymbol || latestDecision?.symbol || 'RELIANCE';

  // ── Clear stale quant data on symbol switch ───────────────────────────
  // When the user clicks a new symbol, immediately load cached consensus
  // (if we ran Deep Quant on it before) or clear to prevent stale cross-
  // symbol data. Also clear any AI plan from the previous symbol.
  useEffect(() => {
    loadConsensusForSymbol(symbol);
    clearAiPlan();
  }, [symbol, loadConsensusForSymbol, clearAiPlan]);

  // Fetch real-time quote for the active symbol
  const fetchSymbolQuote = useCallback(async (signal?: AbortSignal) => {
    if (!symbol || symbol === '---') return;
    try {
      const res = await fetch(`/kite/quote?i=NSE:${symbol}`, { signal });
      if (!res.ok) return;
      const data = await res.json();
      if (data.quotes && data.quotes.length > 0) {
        setSymbolQuote(data.quotes[0]);
      }
    } catch (err) {
      // Silence AbortError — expected on unmount
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[Header] Quote fetch failed:', err);
    }
  }, [symbol]);

  useEffect(() => {
    const controller = new AbortController();
    fetchSymbolQuote(controller.signal);
    const interval = setInterval(() => fetchSymbolQuote(controller.signal), 30_000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [fetchSymbolQuote]);

  // Close timeframe dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (tfDropdownRef.current && !tfDropdownRef.current.contains(e.target as Node)) {
        setTfDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const quickTimeframes: ChartTimeframe[] = ['1m', '5m', '10m', '15m', '1h', '1D'];
  const rangeOptions: DataRange[] = ['60D', '1Y', '2Y', '3Y', '5Y'];
  const rangeLabels: Record<DataRange, string> = { '60D': '60D', '1Y': '1Y', '2Y': '2Y', '3Y': '3Y', '5Y': '5Y' };

  const profileBadgeConfig: Record<TradeProfile, { label: string; color: string }> = {
    INTRADAY: { label: 'INTRADAY MODE', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
    SWING: { label: 'SWING MODE', color: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
    INVESTOR: { label: 'INVESTOR MODE', color: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30' },
  };
  const badge = profileBadgeConfig[activeProfile];
  const sidebarCfg = SIDEBAR_CONFIG[activeProfile];

  // ── Profile-Driven Content Renderer ────────────────────────────────
  const renderProfileContent = () => {
    switch (activeProfile) {
      case 'INTRADAY':
        return <IntradayLayout activeProfile={activeProfile} timeframe={activeTimeframe} isExpanded={!sidebarOpen} onToggleExpand={() => setSidebarOpen(!sidebarOpen)} />;

      case 'SWING':
        return <SwingLayout activeProfile={activeProfile} timeframe={activeTimeframe} isExpanded={!sidebarOpen} onToggleExpand={() => setSidebarOpen(!sidebarOpen)} />;

      case 'INVESTOR':
        return <InvestorLayout activeProfile={activeProfile} timeframe={activeTimeframe} isExpanded={!sidebarOpen} onToggleExpand={() => setSidebarOpen(!sidebarOpen)} />;

      default:
        return null;
    }
  };

  // ── Profile-Driven Sidebar Content ────────────────────────────────
  const renderSidebarContent = () => {
    if (sidebarTab === 'deepquant') {
      return <DeepQuantPanel />;
    }
    // Default: profile-driven
    switch (activeProfile) {
      case 'INTRADAY':
        return <OrderBook />;
      case 'SWING':
        return <SwingConfluencePanel />;
      case 'INVESTOR':
        return <MacroSentimentPanel />;
      default:
        return null;
    }
  };

  const sidebarTitle = sidebarTab === 'deepquant' ? 'Deep Quant' : sidebarCfg.label;

  return (
    <div className="flex h-full flex-col bg-background">
      {/* ── Profile-Driven Terminal ────────────────────────── */}
      <div className="min-h-0 flex-1">
        <TerminalLayout leftPanel={<LeftPanel />}>
          <div className="flex h-full min-h-0 w-full gap-0">
            {/* ── Left: Chart + Order Execution ──────────────── */}
            <div className={`flex min-h-0 min-w-0 flex-col rounded-lg border border-border-default bg-surface panel-shadow-lg transition-all duration-300 ease-out ${sidebarOpen ? 'flex-1' : 'w-full'}`}>
              <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border-default px-3 bg-surface rounded-t-lg">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="truncate text-sm font-semibold text-text-primary">{symbol}</div>
                  {symbolQuote ? (
                    <>
                      <div className="text-sm font-semibold text-text-primary tabular-nums">
                        ₹{symbolQuote.last_price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                      <div className={`flex items-center gap-0.5 text-xs font-medium tabular-nums ${symbolQuote.change >= 0 ? 'text-bull' : 'text-bear'}`}>
                        {symbolQuote.change >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                        {symbolQuote.change >= 0 ? '+' : ''}{symbolQuote.change.toFixed(2)}%
                      </div>
                      <div className="hidden sm:flex items-center gap-2 text-[10px] text-text-muted tabular-nums">
                        <span>O <span className="text-text-secondary">{symbolQuote.open.toFixed(2)}</span></span>
                        <span>H <span className="text-text-secondary">{symbolQuote.high.toFixed(2)}</span></span>
                        <span>L <span className="text-text-secondary">{symbolQuote.low.toFixed(2)}</span></span>
                        <span>C <span className="text-text-secondary">{symbolQuote.close.toFixed(2)}</span></span>
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-text-muted">Loading...</div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {/* Timeframe dropdown */}
                  <div className="relative" ref={tfDropdownRef}>
                    <button
                      type="button"
                      onClick={() => setTfDropdownOpen(!tfDropdownOpen)}
                      className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors border ${
                        tfDropdownOpen
                          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                          : 'bg-surface text-text-secondary hover:bg-elevated border-border-default'
                      }`}
                    >
                      {activeTimeframe}
                      <ChevronDown size={12} className={`transition-transform duration-200 ${tfDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {tfDropdownOpen && (
                      <div className="absolute right-0 top-full z-50 mt-1 w-44 max-h-80 overflow-y-auto rounded-lg border border-border-default bg-surface shadow-lg panel-shadow py-1">
                        {TIMEFRAME_GROUPS.map((group) => (
                          <div key={group.label}>
                            <div className="px-3 pt-2 pb-1 text-[9px] font-bold uppercase tracking-widest text-text-muted/60">
                              {group.label}
                            </div>
                            {group.items.map((item) => (
                              <button
                                key={item.tf}
                                type="button"
                                onClick={() => {
                                  setActiveTimeframe(item.tf as ChartTimeframe);
                                  setTfDropdownOpen(false);
                                }}
                                className={`flex w-full items-center px-3 py-1.5 text-xs transition-colors ${
                                  activeTimeframe === item.tf
                                    ? 'bg-emerald-500/10 text-emerald-400 font-semibold'
                                    : 'text-text-secondary hover:bg-elevated hover:text-text-primary'
                                }`}
                              >
                                {item.display}
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Sidebar toggle button */}
                  <button
                    type="button"
                    onClick={() => setSidebarOpen(!sidebarOpen)}
                    className={`rounded-md p-1.5 text-xs font-semibold transition-colors ${sidebarOpen
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'bg-surface text-text-secondary hover:bg-elevated'
                      }`}
                    title={sidebarOpen ? `Hide ${sidebarCfg.label}` : `Show ${sidebarCfg.label}`}
                  >
                    {sidebarOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
                  </button>
                </div>
              </div>

              {/* Chart area - takes full width */}
              <div className="min-h-0 flex-1 bg-surface relative flex flex-col p-1.5 overflow-visible">
                {renderProfileContent()}
              </div>

              {/* Live PNL Positions Drawer */}
              <ActivePositions />

              {/* Buy/Sell Panel */}
              <div className="shrink-0 border-t border-border-default bg-surface rounded-b-lg">
                <OrderExecutionPanel />
              </div>
            </div>

            {/* ── Right: Collapsible Profile Sidebar ─────────── */}
            <div
              className={`
                flex flex-col min-h-0 overflow-hidden transition-all duration-300 ease-out
                ${sidebarOpen
                  ? 'w-[300px] min-w-[260px] max-w-[340px] opacity-100 ml-2'
                  : 'w-0 min-w-0 max-w-0 opacity-0 ml-0 pointer-events-none'
                }
              `}
            >
              {/* Sidebar Header with Tab Switcher */}
              <div className="flex shrink-0 flex-col rounded-t-lg border border-b-0 border-border-default bg-surface">
                <div className="flex items-center justify-between px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-text-primary tracking-wide">{sidebarTitle}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSidebarOpen(false)}
                    className="rounded p-1 text-text-muted transition-colors hover:bg-elevated hover:text-text-primary"
                    title="Collapse sidebar"
                  >
                    <PanelRightClose size={14} />
                  </button>
                </div>

                {/* Tab row */}
                <div className="flex gap-0.5 px-2 pb-1">
                  {[
                    { key: 'profile' as SidebarTab, label: sidebarCfg.badge },
                    { key: 'deepquant' as SidebarTab, label: 'AI QUANT' },
                  ].map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSidebarTab(key)}
                      className={`flex-1 rounded-md px-1.5 py-1 text-[9px] font-bold uppercase tracking-wider transition-all duration-200 ${
                        sidebarTab === key
                          ? key === 'deepquant'
                            ? 'bg-gradient-to-r from-blue-500/15 to-violet-500/15 text-blue-400 border border-blue-500/30'
                            : 'bg-elevated text-text-primary border border-border-default'
                          : 'text-text-muted hover:text-text-secondary hover:bg-elevated/50 border border-transparent'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Sidebar Content */}
              <div className="flex-1 min-h-0 overflow-y-auto rounded-b-lg border border-t-0 border-border-default bg-surface">
                {renderSidebarContent()}
              </div>
            </div>
          </div>
        </TerminalLayout>
      </div>

      {/* ── System Status Console (Bottom Drawer) ─────── */}
      {/* <SystemConsole /> */}
    </div>
  );
}
