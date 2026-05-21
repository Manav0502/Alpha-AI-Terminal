import { useEffect } from 'react';
import type { Time } from 'lightweight-charts';
import { useChartUIStore } from '../store/useChartUIStore';
import type { ChartRefs, ChartCandle } from '../utils/chartTypes';

export function useFibZoneOverlay(
  refs: ChartRefs,
  chartData: ChartCandle[]
) {
  const { chartRef, candleSeriesRef, fibOverlayRef } = refs;

  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const overlay = fibOverlayRef.current;
    if (!chart || !series || !overlay) return;

    const FIB_TOOLS = new Set(['fib-retracement', 'trend-fib', 'fib-extension']);
    const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    const ZONE_COLORS = [
      'rgba(233, 30, 99, 0.10)',
      'rgba(234, 57, 67, 0.12)',
      'rgba(255, 152, 0, 0.12)',
      'rgba(76, 175, 80, 0.14)',
      'rgba(0, 150, 136, 0.12)',
      'rgba(33, 150, 243, 0.10)',
    ];

    const paintZones = () => {
      const { drawings: currentDrawings, drawingsVisible: visible } = useChartUIStore.getState();
      overlay.innerHTML = '';

      if (!visible) return;

      for (const drawing of currentDrawings) {
        if (!FIB_TOOLS.has(drawing.tool) || drawing.points.length < 2) continue;

        const sorted = [...drawing.points].sort((a, b) => a.time - b.time);
        const priceRange = sorted[1].price - sorted[0].price;

        const x1 = chart.timeScale().timeToCoordinate(sorted[0].time as Time);
        const x2 = chart.timeScale().timeToCoordinate(sorted[1].time as Time);
        if (x1 === null || x2 === null) continue;

        const left = Math.min(x1, x2);
        const width = Math.abs(x2 - x1);
        if (width < 2) continue;

        for (let i = 0; i < FIB_LEVELS.length - 1; i++) {
          const priceTop = sorted[0].price + priceRange * FIB_LEVELS[i + 1];
          const priceBot = sorted[0].price + priceRange * FIB_LEVELS[i];

          const yTop = series.priceToCoordinate(priceTop);
          const yBot = series.priceToCoordinate(priceBot);
          if (yTop === null || yBot === null) continue;

          const top = Math.min(yTop, yBot);
          const height = Math.abs(yBot - yTop);
          if (height < 1) continue;

          const band = document.createElement('div');
          band.style.cssText = `position:absolute;top:${top}px;left:${left}px;width:${width}px;height:${height}px;background:${ZONE_COLORS[i]};border-top:1px solid rgba(255,255,255,0.08);pointer-events:none;`;

          const label = document.createElement('span');
          label.style.cssText = 'position:absolute;right:4px;top:1px;font-size:9px;color:rgba(255,255,255,0.45);font-family:monospace;white-space:nowrap;';
          label.textContent = `${(FIB_LEVELS[i] * 100).toFixed(1)}% — ${(FIB_LEVELS[i + 1] * 100).toFixed(1)}%`;
          band.appendChild(label);
          overlay.appendChild(band);
        }
      }
    };

    paintZones();

    chart.timeScale().subscribeVisibleTimeRangeChange(paintZones);
    const unsubStore = useChartUIStore.subscribe(paintZones);

    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(paintZones);
      unsubStore();
      if (overlay) overlay.innerHTML = '';
    };
  }, [chartData, chartRef, candleSeriesRef, fibOverlayRef]);
}
