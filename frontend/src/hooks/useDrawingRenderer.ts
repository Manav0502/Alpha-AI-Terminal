import { useEffect } from 'react';
import type { Time } from 'lightweight-charts';
import { LineSeries } from 'lightweight-charts';
import type { ChartRefs, ChartCandle } from '../utils/chartTypes';
import { useChartUIStore } from '../store/useChartUIStore';

export function useDrawingRenderer(
  refs: ChartRefs,
  chartData: ChartCandle[]
) {
  const { chartRef, candleSeriesRef, drawingSeriesRef } = refs;
  const drawings = useChartUIStore((s) => s.drawings);
  const drawingsVisible = useChartUIStore((s) => s.drawingsVisible);

  useEffect(() => {
    const chart = chartRef.current;
    const mainSeries = candleSeriesRef.current;
    if (!chart) return;

    // Remove previous drawing series from chart
    for (const series of drawingSeriesRef.current) {
      try {
        chart.removeSeries(series);
      } catch {
        // series may already be removed if chart was re-created
      }
    }
    drawingSeriesRef.current = [];

    if (!drawingsVisible) return;

    const TOOL_COLORS: Record<string, string> = {
      'trendline': '#2962FF',
      'ray': '#2962FF',
      'info-line': '#00BCD4',
      'extended-line': '#2962FF',
      'trend-angle': '#FF9800',
      'horizontal-line': '#FF6D00',
      'horizontal-ray': '#FF6D00',
      'vertical-line': '#AB47BC',
      'cross-line': '#AB47BC',
      'parallel-channel': '#26A69A',
      'regression-trend': '#EC407A',
      'flat-top-bottom': '#26A69A',
      'disjoint-channel': '#78909C',
      'fib-retracement': '#FFD600',
      'trend-fib': '#FFD600',
      'long-position': '#22c55e',
      'short-position': '#ef4444',
      'price-range': '#00BCD4',
      // Patterns
      'xabcd-pattern': '#2196F3',
      'cypher-pattern': '#00BCD4',
      'head-shoulders': '#9C27B0',
      'abcd-pattern': '#3F51B5',
      'triangle-pattern': '#009688',
      'three-drives': '#FF5722',
      // Elliott Waves
      'elliott-impulse': '#4CAF50',
      'elliott-correction': '#FF9800',
      'elliott-triangle': '#E91E63',
      'elliott-double-combo': '#673AB7',
      'elliott-triple-combo': '#795548',
      // Cycles
      'cyclic-lines': '#00BCD4',
      'time-cycles': '#3F51B5',
      'sine-line': '#E91E63',
      // Arrows
      'arrow-marker': '#FF5722', 'arrow': '#FF5722',
      'arrow-mark-up': '#4CAF50', 'arrow-mark-down': '#ef4444',
      'arrow-mark-left': '#FF9800', 'arrow-mark-right': '#2196F3',
      // Shapes
      'rectangle': '#2962FF', 'rotated-rectangle': '#2962FF',
      'path': '#9C27B0', 'circle': '#00BCD4', 'ellipse': '#00BCD4',
      'polyline': '#FF9800', 'triangle-shape': '#009688',
      'arc': '#E91E63', 'curve': '#673AB7', 'double-curve': '#795548',
      // Projection & Volume & Measurer
      'forecast': '#26A69A', 'bars-pattern': '#FF9800',
      'ghost-feed': '#AB47BC', 'projection': '#2196F3',
      'anchored-vwap': '#FF6D00', 'fixed-range-volume': '#00BCD4',
      'date-range': '#78909C', 'date-price-range': '#607D8B',
      // Brushes
      'brush': '#FF5722', 'highlighter': '#FFEB3B',
      // Text & Notes
      'text': '#E0E0E0', 'anchored-text': '#BDBDBD', 'note': '#FFC107',
      'anchored-note': '#FFB300', 'callout': '#4CAF50', 'comment': '#8BC34A',
      'price-label': '#03A9F4', 'price-note': '#00BCD4',
      'signpost': '#795548', 'flag-mark': '#F44336',
    };

    const TOOL_LINE_STYLES: Record<string, number> = {
      'trendline': 0,
      'ray': 0,
      'info-line': 0,
      'extended-line': 0,
      'trend-angle': 0,
      'horizontal-line': 2,
      'horizontal-ray': 2,
      'vertical-line': 2,
      'cross-line': 2,
      'parallel-channel': 0,
      'regression-trend': 2,
      'flat-top-bottom': 2,
      'disjoint-channel': 0,
    };

    const intervalSec = chartData.length >= 2
      ? chartData[1].time - chartData[0].time
      : 600;

    const createLine = (
      data: { time: Time; value: number }[],
      color: string,
      lineWidth: 1 | 2 | 3 | 4 = 2,
      lineStyle: number = 0,
      title?: string,
    ) => {
      if (data.length < 2) return;

      // LWC requires strictly ascending time — sort then deduplicate
      const sorted = [...data].sort((a, b) => (a.time as number) - (b.time as number));
      for (let i = 1; i < sorted.length; i++) {
        if ((sorted[i].time as number) <= (sorted[i - 1].time as number)) {
          sorted[i] = { ...sorted[i], time: ((sorted[i - 1].time as number) + 1) as Time };
        }
      }

      const line = chart.addSeries(LineSeries, {
        color,
        lineWidth,
        lineStyle,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 6,
        crosshairMarkerBackgroundColor: '#FFFFFF',
        crosshairMarkerBorderColor: color,
        priceLineVisible: false,
        lastValueVisible: false,
        ...(title ? { title } : {}),
      });
      line.setData(sorted);
      drawingSeriesRef.current.push(line);
      return line;
    };

    for (const drawing of drawings) {
      if (drawing.points.length < 2) continue;
      const color = drawing.color || TOOL_COLORS[drawing.tool] || '#2962FF';
      const lineStyle = TOOL_LINE_STYLES[drawing.tool] ?? 0;
      const p1 = drawing.points[0];
      const p2 = drawing.points[1];
      const sorted = [p1, p2].sort((a, b) => a.time - b.time);

      switch (drawing.tool) {
        case 'trendline':
        default: {
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 2, lineStyle,
          );
          break;
        }

        case 'ray': {
          const slope = (p2.price - p1.price) / ((p2.time - p1.time) || 1);
          const farTime = sorted[1].time + intervalSec * 200;
          const farPrice = p2.price + slope * (farTime - p2.time);
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
              { time: farTime as Time, value: +farPrice.toFixed(2) },
            ],
            color, 2, 0,
          );
          break;
        }

        case 'info-line': {
          const priceDiff = p2.price - p1.price;
          const pctChange = ((priceDiff / p1.price) * 100).toFixed(2);
          const timeDiffSec = Math.abs(p2.time - p1.time);
          const bars = Math.round(timeDiffSec / intervalSec);
          const hours = Math.floor(timeDiffSec / 3600);
          const mins = Math.floor((timeDiffSec % 3600) / 60);
          const duration = hours > 24
            ? `${Math.floor(hours / 24)}d ${hours % 24}h ${mins}m`
            : `${hours}h ${mins}m`;
          const angle = Math.atan2(priceDiff, bars || 1) * (180 / Math.PI);
          const title = `${priceDiff >= 0 ? '+' : ''}${priceDiff.toFixed(2)} (${pctChange}%) · ${bars} bars (${duration}) · ${angle.toFixed(1)}°`;

          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 2, 0, title,
          );
          break;
        }

        case 'extended-line': {
          const exSlope = (p2.price - p1.price) / ((p2.time - p1.time) || 1);
          const leftTime = sorted[0].time - intervalSec * 200;
          const rightTime = sorted[1].time + intervalSec * 200;
          const leftPrice = sorted[0].price + exSlope * (leftTime - sorted[0].time);
          const rightPrice = sorted[1].price + exSlope * (rightTime - sorted[1].time);
          createLine(
            [
              { time: leftTime as Time, value: +leftPrice.toFixed(2) },
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
              { time: rightTime as Time, value: +rightPrice.toFixed(2) },
            ],
            color, 2, 0,
          );
          break;
        }

        case 'trend-angle': {
          const taBars = Math.round(Math.abs(p2.time - p1.time) / intervalSec);
          const taDiff = p2.price - p1.price;
          const taAngle = Math.atan2(taDiff, taBars || 1) * (180 / Math.PI);
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 2, 0, `∠ ${taAngle.toFixed(1)}°`,
          );
          break;
        }

        case 'horizontal-line': {
          if (mainSeries) {
            mainSeries.createPriceLine({
              price: p1.price,
              color,
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
            });
          }
          break;
        }

        case 'horizontal-ray': {
          const hrFarTime = sorted[0].time + intervalSec * 500;
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: hrFarTime as Time, value: sorted[0].price },
            ],
            color, 1, 2,
          );
          break;
        }

        case 'vertical-line': {
          const vHigh = p1.price * 1.15;
          const vLow = p1.price * 0.85;
          createLine(
            [
              { time: sorted[0].time as Time, value: +vLow.toFixed(2) },
              { time: sorted[0].time as Time, value: +vHigh.toFixed(2) },
            ],
            color, 1, 2,
          );
          break;
        }

        case 'cross-line': {
          const clLeftTime = sorted[0].time - intervalSec * 100;
          const clRightTime = sorted[0].time + intervalSec * 100;
          createLine(
            [
              { time: clLeftTime as Time, value: p1.price },
              { time: clRightTime as Time, value: p1.price },
            ],
            color, 1, 2,
          );
          const clHigh = p1.price * 1.10;
          const clLow = p1.price * 0.90;
          createLine(
            [
              { time: sorted[0].time as Time, value: +clLow.toFixed(2) },
              { time: sorted[0].time as Time, value: +clHigh.toFixed(2) },
            ],
            color, 1, 2,
          );
          break;
        }

        case 'parallel-channel':
        case 'flat-top-bottom': {
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 2, 0,
          );
          const offset = Math.abs(sorted[1].price - sorted[0].price) * 0.5;
          const direction = sorted[1].price > sorted[0].price ? -1 : 1;
          createLine(
            [
              { time: sorted[0].time as Time, value: +(sorted[0].price + offset * direction).toFixed(2) },
              { time: sorted[1].time as Time, value: +(sorted[1].price + offset * direction).toFixed(2) },
            ],
            color, 1, 2,
          );
          break;
        }

        case 'regression-trend': {
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 2, 0,
          );
          const rtRange = Math.abs(sorted[1].price - sorted[0].price) * 0.3;
          createLine(
            [
              { time: sorted[0].time as Time, value: +(sorted[0].price + rtRange).toFixed(2) },
              { time: sorted[1].time as Time, value: +(sorted[1].price + rtRange).toFixed(2) },
            ],
            color, 1, 2,
          );
          createLine(
            [
              { time: sorted[0].time as Time, value: +(sorted[0].price - rtRange).toFixed(2) },
              { time: sorted[1].time as Time, value: +(sorted[1].price - rtRange).toFixed(2) },
            ],
            color, 1, 2,
          );
          break;
        }

        case 'disjoint-channel': {
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 2, 0,
          );
          const dcOffset = Math.abs(sorted[1].price - sorted[0].price) * 0.4;
          createLine(
            [
              { time: sorted[0].time as Time, value: +(sorted[0].price - dcOffset * 0.5).toFixed(2) },
              { time: sorted[1].time as Time, value: +(sorted[1].price - dcOffset * 1.5).toFixed(2) },
            ],
            color, 1, 2,
          );
          break;
        }

        case 'fib-retracement':
        case 'trend-fib': {
          const fibLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
          const fibRange = sorted[1].price - sorted[0].price;
          const fibAlpha = ['FF', 'CC', 'AA', '99', 'AA', 'CC', 'FF'];
          for (let i = 0; i < fibLevels.length; i++) {
            const level = fibLevels[i];
            const price = sorted[0].price + fibRange * level;
            createLine(
              [
                { time: sorted[0].time as Time, value: +price.toFixed(2) },
                { time: sorted[1].time as Time, value: +price.toFixed(2) },
              ],
              color, 1, 2,
              `${(level * 100).toFixed(1)}% — ${price.toFixed(2)}`,
            );
          }
          break;
        }

        case 'fib-extension': {
          const extLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2, 2.618];
          const extRange = sorted[1].price - sorted[0].price;
          for (const level of extLevels) {
            const price = sorted[0].price + extRange * level;
            createLine(
              [
                { time: sorted[0].time as Time, value: +price.toFixed(2) },
                { time: (sorted[1].time + intervalSec * 50) as Time, value: +price.toFixed(2) },
              ],
              color, level > 1 ? 1 : 1, level > 1 ? 0 : 2,
              `${(level * 100).toFixed(1)}%`,
            );
          }
          break;
        }

        case 'fib-channel': {
          const chFibLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
          const chRange = Math.abs(sorted[1].price - sorted[0].price) * 0.5;
          for (const level of chFibLevels) {
            const offset = chRange * level;
            createLine(
              [
                { time: sorted[0].time as Time, value: +(sorted[0].price + offset).toFixed(2) },
                { time: sorted[1].time as Time, value: +(sorted[1].price + offset).toFixed(2) },
              ],
              color, level === 0 || level === 1 ? 2 : 1, level === 0 || level === 1 ? 0 : 2,
              level === 0 ? '' : `${(level * 100).toFixed(1)}%`,
            );
          }
          break;
        }

        case 'fib-time-zone':
        case 'fib-time-trend': {
          const fibSequence = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55];
          let cumBars = 0;
          const vHigh = Math.max(sorted[0].price, sorted[1].price) * 1.05;
          const vLow = Math.min(sorted[0].price, sorted[1].price) * 0.95;
          for (const n of fibSequence) {
            cumBars += n;
            const t = sorted[0].time + intervalSec * cumBars;
            if (t > sorted[1].time + intervalSec * 300) break;
            createLine(
              [
                { time: t as Time, value: +vLow.toFixed(2) },
                { time: t as Time, value: +vHigh.toFixed(2) },
              ],
              color, 1, 2,
              `${cumBars}`,
            );
          }
          break;
        }

        case 'fib-speed-fan': {
          const fanLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
          const fanRange = sorted[1].price - sorted[0].price;
          for (const level of fanLevels) {
            const targetPrice = sorted[0].price + fanRange * level;
            const farTime = sorted[1].time + intervalSec * 100;
            const farSlope = (targetPrice - sorted[0].price) / ((sorted[1].time - sorted[0].time) || 1);
            const farPrice = targetPrice + farSlope * (farTime - sorted[1].time);
            createLine(
              [
                { time: sorted[0].time as Time, value: sorted[0].price },
                { time: sorted[1].time as Time, value: +targetPrice.toFixed(2) },
                { time: farTime as Time, value: +farPrice.toFixed(2) },
              ],
              color, level === 0.5 ? 2 : 1, level === 0.5 ? 0 : 2,
              `${(level * 100).toFixed(1)}%`,
            );
          }
          break;
        }

        case 'fib-circles': {
          const circLevels = [0.236, 0.382, 0.5, 0.618, 0.786, 1];
          const circRange = Math.abs(sorted[1].price - sorted[0].price);
          const midPrice = (sorted[0].price + sorted[1].price) / 2;
          const midTime = Math.round((sorted[0].time + sorted[1].time) / 2);
          for (const level of circLevels) {
            const radius = circRange * level;
            const tSpread = Math.round((sorted[1].time - sorted[0].time) * level / 2);
            createLine(
              [
                { time: (midTime - tSpread) as Time, value: +midPrice.toFixed(2) },
                { time: midTime as Time, value: +(midPrice + radius / 2).toFixed(2) },
                { time: (midTime + tSpread) as Time, value: +midPrice.toFixed(2) },
              ],
              color, 1, 2,
              `${(level * 100).toFixed(1)}%`,
            );
            createLine(
              [
                { time: (midTime - tSpread) as Time, value: +midPrice.toFixed(2) },
                { time: midTime as Time, value: +(midPrice - radius / 2).toFixed(2) },
                { time: (midTime + tSpread) as Time, value: +midPrice.toFixed(2) },
              ],
              color, 1, 2,
            );
          }
          break;
        }

        case 'fib-spiral': {
          const spiralLevels = [1, 1.618, 2.618, 4.236, 6.854];
          const spRange = Math.abs(sorted[1].price - sorted[0].price);
          const spDir = sorted[1].price > sorted[0].price ? 1 : -1;
          for (const mult of spiralLevels) {
            const targetPrice = sorted[0].price + spRange * mult * spDir;
            const targetTime = sorted[0].time + (sorted[1].time - sorted[0].time) * mult;
            createLine(
              [
                { time: sorted[0].time as Time, value: sorted[0].price },
                { time: targetTime as Time, value: +targetPrice.toFixed(2) },
              ],
              color, 1, 2,
              `${mult.toFixed(3)}`,
            );
          }
          break;
        }

        case 'fib-arcs': {
          const arcLevels = [0.236, 0.382, 0.5, 0.618, 0.786];
          const arcRange = Math.abs(sorted[1].price - sorted[0].price);
          const arcTimeDiff = sorted[1].time - sorted[0].time;
          for (const level of arcLevels) {
            const radius = arcRange * level;
            const tR = Math.round(arcTimeDiff * level);
            const pts = [];
            for (let i = 0; i <= 8; i++) {
              const frac = i / 8;
              const t = sorted[1].time - tR + Math.round(tR * 2 * frac);
              const pOffset = radius * Math.sqrt(1 - Math.pow(frac * 2 - 1, 2));
              pts.push({ time: t as Time, value: +(sorted[1].price + pOffset).toFixed(2) });
            }
            createLine(pts, color, 1, 2, `${(level * 100).toFixed(1)}%`);
          }
          break;
        }

        case 'fib-wedge': {
          const wLevels = [0.236, 0.382, 0.5, 0.618, 0.786];
          const wRange = sorted[1].price - sorted[0].price;
          const convergenceTime = sorted[1].time + (sorted[1].time - sorted[0].time);
          const convergencePrice = (sorted[0].price + sorted[1].price) / 2;
          for (const level of wLevels) {
            const startPrice = sorted[0].price + wRange * level;
            createLine(
              [
                { time: sorted[0].time as Time, value: +startPrice.toFixed(2) },
                { time: convergenceTime as Time, value: +convergencePrice.toFixed(2) },
              ],
              color, 1, 2,
              `${(level * 100).toFixed(1)}%`,
            );
          }
          break;
        }

        case 'pitchfan': {
          const pfLevels = [0.25, 0.382, 0.5, 0.618, 0.75, 1];
          const pfRange = sorted[1].price - sorted[0].price;
          const pfTimeDiff = sorted[1].time - sorted[0].time;
          for (const level of pfLevels) {
            const targetPrice = sorted[0].price + pfRange * level;
            const farTime = sorted[1].time + pfTimeDiff;
            const slope = (targetPrice - sorted[0].price) / (pfTimeDiff || 1);
            const farPrice = targetPrice + slope * pfTimeDiff;
            createLine(
              [
                { time: sorted[0].time as Time, value: sorted[0].price },
                { time: sorted[1].time as Time, value: +targetPrice.toFixed(2) },
                { time: farTime as Time, value: +farPrice.toFixed(2) },
              ],
              color, level === 0.5 ? 2 : 1, level === 0.5 ? 0 : 2,
            );
          }
          break;
        }

        case 'gann-box':
        case 'gann-square-fixed':
        case 'gann-square': {
          const gLevels = [0, 0.25, 0.5, 0.75, 1];
          const gPriceRange = sorted[1].price - sorted[0].price;
          const gTimeDiff = sorted[1].time - sorted[0].time;
          for (const level of gLevels) {
            const price = sorted[0].price + gPriceRange * level;
            createLine(
              [
                { time: sorted[0].time as Time, value: +price.toFixed(2) },
                { time: sorted[1].time as Time, value: +price.toFixed(2) },
              ],
              color, level === 0 || level === 1 ? 2 : 1,
              level === 0 || level === 1 ? 0 : 2,
              `${(level * 100).toFixed(0)}%`,
            );
          }
          const vPriceHigh = Math.max(sorted[0].price, sorted[1].price);
          const vPriceLow = Math.min(sorted[0].price, sorted[1].price);
          for (const level of gLevels) {
            if (level === 0 || level === 1) continue;
            const t = sorted[0].time + Math.round(gTimeDiff * level);
            createLine(
              [
                { time: t as Time, value: +vPriceLow.toFixed(2) },
                { time: t as Time, value: +vPriceHigh.toFixed(2) },
              ],
              color, 1, 2,
            );
          }
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 1, 2,
          );
          break;
        }

        case 'gann-fan': {
          const gannMultipliers = [0.125, 0.25, 0.333, 0.5, 1, 2, 3, 4, 8];
          const gannLabels = ['1×8', '1×4', '1×3', '1×2', '1×1', '2×1', '3×1', '4×1', '8×1'];
          const gfTimeDiff = sorted[1].time - sorted[0].time;
          const gfPricePerBar = (sorted[1].price - sorted[0].price) / (gfTimeDiff / intervalSec || 1);
          for (let i = 0; i < gannMultipliers.length; i++) {
            const mult = gannMultipliers[i];
            const farTime = sorted[0].time + gfTimeDiff * 2;
            const barsToFar = (farTime - sorted[0].time) / intervalSec;
            const farPrice = sorted[0].price + gfPricePerBar * mult * barsToFar;
            createLine(
              [
                { time: sorted[0].time as Time, value: sorted[0].price },
                { time: farTime as Time, value: +farPrice.toFixed(2) },
              ],
              color, mult === 1 ? 2 : 1, mult === 1 ? 0 : 2,
              gannLabels[i],
            );
          }
          break;
        }

        // ═══════════════════════════════════════════════════════
        // ── HARMONIC PATTERNS ─────────────────────────────────
        // ═══════════════════════════════════════════════════════

        // ── XABCD Pattern — 5-point harmonic zigzag ───────────
        case 'xabcd-pattern': {
          const range = Math.abs(sorted[1].price - sorted[0].price);
          const dir = sorted[1].price > sorted[0].price ? 1 : -1;
          const timeDiff = sorted[1].time - sorted[0].time;
          const tStep = Math.round(timeDiff / 4);
          // X → A → B → C → D (classic Gartley proportions)
          const X = { t: sorted[0].time, p: sorted[0].price };
          const A = { t: sorted[0].time + tStep, p: sorted[0].price + range * dir };
          const B = { t: sorted[0].time + tStep * 2, p: A.p - range * 0.618 * dir };
          const C = { t: sorted[0].time + tStep * 3, p: B.p + range * 0.786 * dir };
          const D = { t: sorted[1].time, p: C.p - range * 0.786 * dir };
          const pts = [X, A, B, C, D];
          const labels = ['X', 'A', 'B', 'C', 'D'];
          for (let i = 0; i < pts.length - 1; i++) {
            createLine(
              [
                { time: pts[i].t as Time, value: +pts[i].p.toFixed(2) },
                { time: pts[i + 1].t as Time, value: +pts[i + 1].p.toFixed(2) },
              ],
              color, 2, 0, labels[i],
            );
          }
          break;
        }

        // ── Cypher Pattern — similar to XABCD with different ratios ─
        case 'cypher-pattern': {
          const cypRange = Math.abs(sorted[1].price - sorted[0].price);
          const cypDir = sorted[1].price > sorted[0].price ? 1 : -1;
          const cypStep = Math.round((sorted[1].time - sorted[0].time) / 4);
          const cX = { t: sorted[0].time, p: sorted[0].price };
          const cA = { t: sorted[0].time + cypStep, p: sorted[0].price + cypRange * 0.786 * cypDir };
          const cB = { t: sorted[0].time + cypStep * 2, p: cA.p - cypRange * 0.382 * cypDir };
          const cC = { t: sorted[0].time + cypStep * 3, p: cB.p + cypRange * 1.272 * cypDir };
          const cD = { t: sorted[1].time, p: cC.p - cypRange * 0.786 * cypDir };
          const cypPts = [cX, cA, cB, cC, cD];
          const cypLabels = ['X', 'A', 'B', 'C', 'D'];
          for (let i = 0; i < cypPts.length - 1; i++) {
            createLine(
              [
                { time: cypPts[i].t as Time, value: +cypPts[i].p.toFixed(2) },
                { time: cypPts[i + 1].t as Time, value: +cypPts[i + 1].p.toFixed(2) },
              ],
              color, 2, 0, cypLabels[i],
            );
          }
          break;
        }

        // ── Head and Shoulders — 5-point reversal pattern ──────
        case 'head-shoulders': {
          const hsRange = Math.abs(sorted[1].price - sorted[0].price);
          const hsDir = sorted[1].price > sorted[0].price ? 1 : -1;
          const hsStep = Math.round((sorted[1].time - sorted[0].time) / 6);
          const neckline = sorted[0].price;
          const lShoulder = { t: sorted[0].time + hsStep, p: neckline + hsRange * 0.6 * hsDir };
          const neck1 = { t: sorted[0].time + hsStep * 2, p: neckline };
          const head = { t: sorted[0].time + hsStep * 3, p: neckline + hsRange * hsDir };
          const neck2 = { t: sorted[0].time + hsStep * 4, p: neckline };
          const rShoulder = { t: sorted[0].time + hsStep * 5, p: neckline + hsRange * 0.6 * hsDir };
          const end = { t: sorted[1].time, p: neckline };
          // Left shoulder
          createLine(
            [
              { time: sorted[0].time as Time, value: +neckline.toFixed(2) },
              { time: lShoulder.t as Time, value: +lShoulder.p.toFixed(2) },
              { time: neck1.t as Time, value: +neck1.p.toFixed(2) },
            ],
            color, 2, 0, 'LS',
          );
          // Head
          createLine(
            [
              { time: neck1.t as Time, value: +neck1.p.toFixed(2) },
              { time: head.t as Time, value: +head.p.toFixed(2) },
              { time: neck2.t as Time, value: +neck2.p.toFixed(2) },
            ],
            color, 2, 0, 'H',
          );
          // Right shoulder
          createLine(
            [
              { time: neck2.t as Time, value: +neck2.p.toFixed(2) },
              { time: rShoulder.t as Time, value: +rShoulder.p.toFixed(2) },
              { time: end.t as Time, value: +end.p.toFixed(2) },
            ],
            color, 2, 0, 'RS',
          );
          // Neckline (dashed)
          createLine(
            [
              { time: sorted[0].time as Time, value: +neckline.toFixed(2) },
              { time: (sorted[1].time + intervalSec * 30) as Time, value: +neckline.toFixed(2) },
            ],
            color, 1, 2, 'Neckline',
          );
          break;
        }

        // ── ABCD Pattern — 4-point harmonic ────────────────────
        case 'abcd-pattern': {
          const abRange = Math.abs(sorted[1].price - sorted[0].price);
          const abDir = sorted[1].price > sorted[0].price ? 1 : -1;
          const abStep = Math.round((sorted[1].time - sorted[0].time) / 3);
          const pA = { t: sorted[0].time, p: sorted[0].price };
          const pB = { t: sorted[0].time + abStep, p: sorted[0].price + abRange * 0.618 * abDir };
          const pC = { t: sorted[0].time + abStep * 2, p: pB.p - abRange * 0.382 * abDir };
          const pD = { t: sorted[1].time, p: pC.p + abRange * 0.618 * abDir };
          const abPts = [pA, pB, pC, pD];
          const abLabels = ['A', 'B', 'C', 'D'];
          for (let i = 0; i < abPts.length - 1; i++) {
            createLine(
              [
                { time: abPts[i].t as Time, value: +abPts[i].p.toFixed(2) },
                { time: abPts[i + 1].t as Time, value: +abPts[i + 1].p.toFixed(2) },
              ],
              color, 2, 0, abLabels[i],
            );
          }
          break;
        }

        // ── Triangle Pattern — converging trendlines ───────────
        case 'triangle-pattern': {
          const triRange = Math.abs(sorted[1].price - sorted[0].price);
          const triMid = (sorted[0].price + sorted[1].price) / 2;
          const apex = sorted[1].time + (sorted[1].time - sorted[0].time) * 0.5;
          // Upper trendline
          createLine(
            [
              { time: sorted[0].time as Time, value: +(triMid + triRange / 2).toFixed(2) },
              { time: apex as Time, value: +triMid.toFixed(2) },
            ],
            color, 2, 0, '▽ Upper',
          );
          // Lower trendline
          createLine(
            [
              { time: sorted[0].time as Time, value: +(triMid - triRange / 2).toFixed(2) },
              { time: apex as Time, value: +triMid.toFixed(2) },
            ],
            color, 2, 0, '△ Lower',
          );
          // Inner zigzag approximation
          const zStep = Math.round((sorted[1].time - sorted[0].time) / 5);
          const zPts = [];
          for (let i = 0; i <= 5; i++) {
            const shrink = 1 - i * 0.16;
            const dir = i % 2 === 0 ? 1 : -1;
            zPts.push({
              time: (sorted[0].time + zStep * i) as Time,
              value: +(triMid + (triRange / 2) * shrink * dir).toFixed(2),
            });
          }
          createLine(zPts, color, 1, 2);
          break;
        }

        // ── Three Drives Pattern — 3 progressive pushes ───────
        case 'three-drives': {
          const tdRange = Math.abs(sorted[1].price - sorted[0].price);
          const tdDir = sorted[1].price > sorted[0].price ? 1 : -1;
          const tdStep = Math.round((sorted[1].time - sorted[0].time) / 6);
          const drive1 = { t: sorted[0].time + tdStep, p: sorted[0].price + tdRange * 0.5 * tdDir };
          const ret1 = { t: sorted[0].time + tdStep * 2, p: sorted[0].price + tdRange * 0.2 * tdDir };
          const drive2 = { t: sorted[0].time + tdStep * 3, p: sorted[0].price + tdRange * 0.75 * tdDir };
          const ret2 = { t: sorted[0].time + tdStep * 4, p: sorted[0].price + tdRange * 0.4 * tdDir };
          const drive3 = { t: sorted[0].time + tdStep * 5, p: sorted[0].price + tdRange * tdDir };
          const tdEnd = { t: sorted[1].time, p: sorted[0].price + tdRange * 0.5 * tdDir };
          const tdPts = [
            { t: sorted[0].time, p: sorted[0].price },
            drive1, ret1, drive2, ret2, drive3, tdEnd,
          ];
          for (let i = 0; i < tdPts.length - 1; i++) {
            createLine(
              [
                { time: tdPts[i].t as Time, value: +tdPts[i].p.toFixed(2) },
                { time: tdPts[i + 1].t as Time, value: +tdPts[i + 1].p.toFixed(2) },
              ],
              color, 2, 0, i === 0 ? 'D1' : i === 2 ? 'D2' : i === 4 ? 'D3' : '',
            );
          }
          break;
        }

        // ═══════════════════════════════════════════════════════
        // ── ELLIOTT WAVES ─────────────────────────────────────
        // ═══════════════════════════════════════════════════════

        // ── Elliott Impulse (12345) ────────────────────────────
        case 'elliott-impulse': {
          const eiRange = Math.abs(sorted[1].price - sorted[0].price);
          const eiDir = sorted[1].price > sorted[0].price ? 1 : -1;
          const eiStep = Math.round((sorted[1].time - sorted[0].time) / 5);
          const wavePts = [
            { t: sorted[0].time, p: sorted[0].price },                                    // 0
            { t: sorted[0].time + eiStep, p: sorted[0].price + eiRange * 0.38 * eiDir },   // 1
            { t: sorted[0].time + eiStep * 2, p: sorted[0].price + eiRange * 0.15 * eiDir },// 2
            { t: sorted[0].time + eiStep * 3, p: sorted[0].price + eiRange * 0.75 * eiDir },// 3
            { t: sorted[0].time + eiStep * 4, p: sorted[0].price + eiRange * 0.50 * eiDir },// 4
            { t: sorted[1].time, p: sorted[1].price },                                     // 5
          ];
          const waveLabels = ['0', '1', '2', '3', '4', '5'];
          for (let i = 0; i < wavePts.length - 1; i++) {
            createLine(
              [
                { time: wavePts[i].t as Time, value: +wavePts[i].p.toFixed(2) },
                { time: wavePts[i + 1].t as Time, value: +wavePts[i + 1].p.toFixed(2) },
              ],
              color, 2, 0, waveLabels[i + 1],
            );
          }
          break;
        }

        // ── Elliott Correction (ABC) ──────────────────────────
        case 'elliott-correction': {
          const ecRange = Math.abs(sorted[1].price - sorted[0].price);
          const ecDir = sorted[1].price > sorted[0].price ? 1 : -1;
          const ecStep = Math.round((sorted[1].time - sorted[0].time) / 3);
          const corrPts = [
            { t: sorted[0].time, p: sorted[0].price },
            { t: sorted[0].time + ecStep, p: sorted[0].price + ecRange * 0.618 * ecDir },      // A
            { t: sorted[0].time + ecStep * 2, p: sorted[0].price + ecRange * 0.236 * ecDir },   // B
            { t: sorted[1].time, p: sorted[1].price },                                          // C
          ];
          const corrLabels = ['', 'A', 'B', 'C'];
          for (let i = 0; i < corrPts.length - 1; i++) {
            createLine(
              [
                { time: corrPts[i].t as Time, value: +corrPts[i].p.toFixed(2) },
                { time: corrPts[i + 1].t as Time, value: +corrPts[i + 1].p.toFixed(2) },
              ],
              color, 2, 0, corrLabels[i + 1],
            );
          }
          break;
        }

        // ── Elliott Triangle (ABCDE) ──────────────────────────
        case 'elliott-triangle': {
          const etRange = Math.abs(sorted[1].price - sorted[0].price);
          const etDir = sorted[1].price > sorted[0].price ? 1 : -1;
          const etStep = Math.round((sorted[1].time - sorted[0].time) / 5);
          const triPts = [
            { t: sorted[0].time, p: sorted[0].price },
            { t: sorted[0].time + etStep, p: sorted[0].price + etRange * 0.8 * etDir },       // A
            { t: sorted[0].time + etStep * 2, p: sorted[0].price + etRange * 0.2 * etDir },    // B
            { t: sorted[0].time + etStep * 3, p: sorted[0].price + etRange * 0.6 * etDir },    // C
            { t: sorted[0].time + etStep * 4, p: sorted[0].price + etRange * 0.35 * etDir },   // D
            { t: sorted[1].time, p: sorted[0].price + etRange * 0.5 * etDir },                 // E
          ];
          const triLabels = ['', 'A', 'B', 'C', 'D', 'E'];
          for (let i = 0; i < triPts.length - 1; i++) {
            createLine(
              [
                { time: triPts[i].t as Time, value: +triPts[i].p.toFixed(2) },
                { time: triPts[i + 1].t as Time, value: +triPts[i + 1].p.toFixed(2) },
              ],
              color, 2, 0, triLabels[i + 1],
            );
          }
          break;
        }

        // ── Elliott Double Combo (WXY) ────────────────────────
        case 'elliott-double-combo': {
          const dcRange = Math.abs(sorted[1].price - sorted[0].price);
          const dcDir = sorted[1].price > sorted[0].price ? 1 : -1;
          const dcStep = Math.round((sorted[1].time - sorted[0].time) / 5);
          const dcPts = [
            { t: sorted[0].time, p: sorted[0].price },
            { t: sorted[0].time + dcStep, p: sorted[0].price + dcRange * 0.4 * dcDir },       // W
            { t: sorted[0].time + dcStep * 2, p: sorted[0].price + dcRange * 0.15 * dcDir },   // X
            { t: sorted[0].time + dcStep * 3, p: sorted[0].price + dcRange * 0.6 * dcDir },    // W2
            { t: sorted[0].time + dcStep * 4, p: sorted[0].price + dcRange * 0.3 * dcDir },    // X2
            { t: sorted[1].time, p: sorted[1].price },                                         // Y
          ];
          const dcLabels = ['', 'W', 'X', 'W', 'X', 'Y'];
          for (let i = 0; i < dcPts.length - 1; i++) {
            createLine(
              [
                { time: dcPts[i].t as Time, value: +dcPts[i].p.toFixed(2) },
                { time: dcPts[i + 1].t as Time, value: +dcPts[i + 1].p.toFixed(2) },
              ],
              color, 2, 0, dcLabels[i + 1],
            );
          }
          break;
        }

        // ── Elliott Triple Combo (WXYXZ) ──────────────────────
        case 'elliott-triple-combo': {
          const tcRange = Math.abs(sorted[1].price - sorted[0].price);
          const tcDir = sorted[1].price > sorted[0].price ? 1 : -1;
          const tcStep = Math.round((sorted[1].time - sorted[0].time) / 7);
          const tcPts = [
            { t: sorted[0].time, p: sorted[0].price },
            { t: sorted[0].time + tcStep, p: sorted[0].price + tcRange * 0.3 * tcDir },       // W
            { t: sorted[0].time + tcStep * 2, p: sorted[0].price + tcRange * 0.1 * tcDir },    // X
            { t: sorted[0].time + tcStep * 3, p: sorted[0].price + tcRange * 0.5 * tcDir },    // Y
            { t: sorted[0].time + tcStep * 4, p: sorted[0].price + tcRange * 0.25 * tcDir },   // X
            { t: sorted[0].time + tcStep * 5, p: sorted[0].price + tcRange * 0.7 * tcDir },    // Y
            { t: sorted[0].time + tcStep * 6, p: sorted[0].price + tcRange * 0.45 * tcDir },   // X
            { t: sorted[1].time, p: sorted[1].price },                                         // Z
          ];
          const tcLabels = ['', 'W', 'X', 'Y', 'X', 'Y', 'X', 'Z'];
          for (let i = 0; i < tcPts.length - 1; i++) {
            createLine(
              [
                { time: tcPts[i].t as Time, value: +tcPts[i].p.toFixed(2) },
                { time: tcPts[i + 1].t as Time, value: +tcPts[i + 1].p.toFixed(2) },
              ],
              color, 2, 0, tcLabels[i + 1],
            );
          }
          break;
        }

        // ═══════════════════════════════════════════════════════
        // ── CYCLES ────────────────────────────────────────────
        // ═══════════════════════════════════════════════════════

        // ── Cyclic Lines — evenly spaced vertical lines ───────
        case 'cyclic-lines': {
          const cyclePeriod = sorted[1].time - sorted[0].time;
          if (cyclePeriod < intervalSec) break;
          const cycleHigh = Math.max(sorted[0].price, sorted[1].price) * 1.05;
          const cycleLow = Math.min(sorted[0].price, sorted[1].price) * 0.95;
          for (let i = 0; i < 20; i++) {
            const t = sorted[0].time + cyclePeriod * i;
            if (t > sorted[1].time + cyclePeriod * 20) break;
            createLine(
              [
                { time: t as Time, value: +cycleLow.toFixed(2) },
                { time: t as Time, value: +cycleHigh.toFixed(2) },
              ],
              color, 1, 2, i === 0 ? 'Cycle' : '',
            );
          }
          break;
        }

        // ── Time Cycles — concentric vertical line bands ──────
        case 'time-cycles': {
          const tcPeriod = sorted[1].time - sorted[0].time;
          if (tcPeriod < intervalSec) break;
          const tcHigh = Math.max(sorted[0].price, sorted[1].price) * 1.05;
          const tcLow = Math.min(sorted[0].price, sorted[1].price) * 0.95;
          const multiples = [1, 2, 3, 5, 8, 13];
          for (const m of multiples) {
            const t = sorted[0].time + tcPeriod * m;
            createLine(
              [
                { time: t as Time, value: +tcLow.toFixed(2) },
                { time: t as Time, value: +tcHigh.toFixed(2) },
              ],
              color, m <= 3 ? 2 : 1, 2, `×${m}`,
            );
          }
          break;
        }

        // ── Sine Line — sinusoidal wave approximation ─────────
        case 'sine-line': {
          const sinePeriod = sorted[1].time - sorted[0].time;
          const sineAmp = Math.abs(sorted[1].price - sorted[0].price) / 2;
          const sineMid = (sorted[0].price + sorted[1].price) / 2;
          const numCycles = 3;
          const totalLen = sinePeriod * numCycles;
          const steps = numCycles * 16;
          const sinePts = [];
          for (let i = 0; i <= steps; i++) {
            const frac = i / steps;
            const t = sorted[0].time + Math.round(totalLen * frac);
            const val = sineMid + sineAmp * Math.sin(frac * numCycles * 2 * Math.PI);
            sinePts.push({ time: t as Time, value: +val.toFixed(2) });
          }
          createLine(sinePts, color, 2, 0, 'Sine');
          break;
        }

        // ═══════════════════════════════════════════════════════
        // ── ARROWS ────────────────────────────────────────────
        // ═══════════════════════════════════════════════════════

        // ── Arrow Marker — point indicator at p1 ──────────────
        case 'arrow-marker': {
          const amSize = Math.abs(sorted[1].price - sorted[0].price) * 0.15 || sorted[0].price * 0.002;
          createLine(
            [
              { time: sorted[0].time as Time, value: +(sorted[0].price - amSize).toFixed(2) },
              { time: sorted[0].time as Time, value: +(sorted[0].price + amSize).toFixed(2) },
            ],
            color, 3, 0, '▲',
          );
          break;
        }

        // ── Arrow — directional line with arrowhead feel ───────
        case 'arrow': {
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 3, 0, '→',
          );
          break;
        }

        // ── Arrow Mark Up — vertical up marker ────────────────
        case 'arrow-mark-up': {
          const amuSize = Math.abs(sorted[1].price - sorted[0].price) || sorted[0].price * 0.01;
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[0].time as Time, value: +(sorted[0].price + amuSize).toFixed(2) },
            ],
            color, 3, 0, '▲ Up',
          );
          break;
        }

        // ── Arrow Mark Down — vertical down marker ────────────
        case 'arrow-mark-down': {
          const amdSize = Math.abs(sorted[1].price - sorted[0].price) || sorted[0].price * 0.01;
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[0].time as Time, value: +(sorted[0].price - amdSize).toFixed(2) },
            ],
            color, 3, 0, '▼ Down',
          );
          break;
        }

        // ── Arrow Mark Left — horizontal left marker ──────────
        case 'arrow-mark-left': {
          const amlSpan = Math.abs(sorted[1].time - sorted[0].time) || intervalSec * 10;
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: (sorted[0].time - amlSpan) as Time, value: sorted[0].price },
            ],
            color, 3, 0, '← Left',
          );
          break;
        }

        // ── Arrow Mark Right — horizontal right marker ────────
        case 'arrow-mark-right': {
          const amrSpan = Math.abs(sorted[1].time - sorted[0].time) || intervalSec * 10;
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: (sorted[0].time + amrSpan) as Time, value: sorted[0].price },
            ],
            color, 3, 0, '→ Right',
          );
          break;
        }

        // ═══════════════════════════════════════════════════════
        // ── SHAPES ────────────────────────────────────────────
        // ═══════════════════════════════════════════════════════

        // ── Rectangle — 4-sided box between two points ────────
        case 'rectangle': {
          const rTop = Math.max(sorted[0].price, sorted[1].price);
          const rBot = Math.min(sorted[0].price, sorted[1].price);
          // Top edge
          createLine(
            [
              { time: sorted[0].time as Time, value: +rTop.toFixed(2) },
              { time: sorted[1].time as Time, value: +rTop.toFixed(2) },
            ],
            color, 2, 0,
          );
          // Bottom edge
          createLine(
            [
              { time: sorted[0].time as Time, value: +rBot.toFixed(2) },
              { time: sorted[1].time as Time, value: +rBot.toFixed(2) },
            ],
            color, 2, 0,
          );
          // Left edge
          createLine(
            [
              { time: sorted[0].time as Time, value: +rBot.toFixed(2) },
              { time: sorted[0].time as Time, value: +rTop.toFixed(2) },
            ],
            color, 2, 0,
          );
          // Right edge
          createLine(
            [
              { time: sorted[1].time as Time, value: +rBot.toFixed(2) },
              { time: sorted[1].time as Time, value: +rTop.toFixed(2) },
            ],
            color, 2, 0,
          );
          break;
        }

        // ── Rotated Rectangle — tilted box ─────────────────────
        case 'rotated-rectangle': {
          const rrRange = Math.abs(sorted[1].price - sorted[0].price) * 0.3;
          createLine(
            [
              { time: sorted[0].time as Time, value: +(sorted[0].price + rrRange).toFixed(2) },
              { time: sorted[1].time as Time, value: +(sorted[1].price + rrRange).toFixed(2) },
            ],
            color, 2, 0,
          );
          createLine(
            [
              { time: sorted[0].time as Time, value: +(sorted[0].price - rrRange).toFixed(2) },
              { time: sorted[1].time as Time, value: +(sorted[1].price - rrRange).toFixed(2) },
            ],
            color, 2, 0,
          );
          // End caps
          createLine(
            [
              { time: sorted[0].time as Time, value: +(sorted[0].price - rrRange).toFixed(2) },
              { time: sorted[0].time as Time, value: +(sorted[0].price + rrRange).toFixed(2) },
            ],
            color, 2, 0,
          );
          createLine(
            [
              { time: sorted[1].time as Time, value: +(sorted[1].price - rrRange).toFixed(2) },
              { time: sorted[1].time as Time, value: +(sorted[1].price + rrRange).toFixed(2) },
            ],
            color, 2, 0,
          );
          break;
        }

        // ── Path — multi-segment line (simplified to 2-point) ─
        case 'path': {
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 2, 0, 'Path',
          );
          break;
        }

        // ── Circle — approximated with arc points ─────────────
        case 'circle': {
          const cRadius = Math.abs(sorted[1].price - sorted[0].price) / 2;
          const cMidP = (sorted[0].price + sorted[1].price) / 2;
          const cMidT = Math.round((sorted[0].time + sorted[1].time) / 2);
          const cTimeR = Math.round((sorted[1].time - sorted[0].time) / 2);
          const cSteps = 16;
          const cPtsTop = [];
          const cPtsBot = [];
          for (let i = 0; i <= cSteps; i++) {
            const angle = (i / cSteps) * Math.PI;
            const t = cMidT - cTimeR + Math.round((cTimeR * 2 * i) / cSteps);
            const pOff = cRadius * Math.sin(angle);
            cPtsTop.push({ time: t as Time, value: +(cMidP + pOff).toFixed(2) });
            cPtsBot.push({ time: t as Time, value: +(cMidP - pOff).toFixed(2) });
          }
          createLine(cPtsTop, color, 2, 0);
          createLine(cPtsBot, color, 2, 0);
          break;
        }

        // ── Ellipse — stretched circle ─────────────────────────
        case 'ellipse': {
          const eRadiusP = Math.abs(sorted[1].price - sorted[0].price) / 2;
          const eMidP = (sorted[0].price + sorted[1].price) / 2;
          const eMidT = Math.round((sorted[0].time + sorted[1].time) / 2);
          const eTimeR = Math.round((sorted[1].time - sorted[0].time) / 2);
          const eSteps = 20;
          const ePtsTop = [];
          const ePtsBot = [];
          for (let i = 0; i <= eSteps; i++) {
            const angle = (i / eSteps) * Math.PI;
            const t = eMidT - eTimeR + Math.round((eTimeR * 2 * i) / eSteps);
            const pOff = eRadiusP * Math.sin(angle);
            ePtsTop.push({ time: t as Time, value: +(eMidP + pOff).toFixed(2) });
            ePtsBot.push({ time: t as Time, value: +(eMidP - pOff).toFixed(2) });
          }
          createLine(ePtsTop, color, 2, 0);
          createLine(ePtsBot, color, 2, 0);
          break;
        }

        // ── Polyline — zigzag multi-segment ────────────────────
        case 'polyline': {
          const plRange = Math.abs(sorted[1].price - sorted[0].price);
          const plSteps = 5;
          const plStep = Math.round((sorted[1].time - sorted[0].time) / plSteps);
          const plPts = [{ time: sorted[0].time as Time, value: sorted[0].price }];
          for (let i = 1; i < plSteps; i++) {
            const dir = i % 2 === 0 ? 1 : -1;
            const t = sorted[0].time + plStep * i;
            const p = ((sorted[0].price + sorted[1].price) / 2) + plRange * 0.3 * dir;
            plPts.push({ time: t as Time, value: +p.toFixed(2) });
          }
          plPts.push({ time: sorted[1].time as Time, value: sorted[1].price });
          createLine(plPts, color, 2, 0, 'Polyline');
          break;
        }

        // ── Triangle Shape — equilateral triangle ─────────────
        case 'triangle-shape': {
          const tsTop = Math.max(sorted[0].price, sorted[1].price);
          const tsBot = Math.min(sorted[0].price, sorted[1].price);
          const tsMidT = Math.round((sorted[0].time + sorted[1].time) / 2);
          // Left edge → apex → right edge
          createLine(
            [
              { time: sorted[0].time as Time, value: +tsBot.toFixed(2) },
              { time: tsMidT as Time, value: +tsTop.toFixed(2) },
              { time: sorted[1].time as Time, value: +tsBot.toFixed(2) },
            ],
            color, 2, 0,
          );
          // Base
          createLine(
            [
              { time: sorted[0].time as Time, value: +tsBot.toFixed(2) },
              { time: sorted[1].time as Time, value: +tsBot.toFixed(2) },
            ],
            color, 2, 0,
          );
          break;
        }

        // ── Arc — half-circle curve ────────────────────────────
        case 'arc': {
          const arcMidP = (sorted[0].price + sorted[1].price) / 2;
          const arcAmp = Math.abs(sorted[1].price - sorted[0].price) / 2;
          const arcMidT = Math.round((sorted[0].time + sorted[1].time) / 2);
          const arcTimeR = Math.round((sorted[1].time - sorted[0].time) / 2);
          const arcSteps = 16;
          const arcPts = [];
          for (let i = 0; i <= arcSteps; i++) {
            const angle = (i / arcSteps) * Math.PI;
            const t = arcMidT - arcTimeR + Math.round((arcTimeR * 2 * i) / arcSteps);
            const pOff = arcAmp * Math.sin(angle);
            arcPts.push({ time: t as Time, value: +(arcMidP + pOff).toFixed(2) });
          }
          createLine(arcPts, color, 2, 0, 'Arc');
          break;
        }

        // ── Curve — smooth S-curve between two points ─────────
        case 'curve': {
          const cvRange = sorted[1].price - sorted[0].price;
          const cvTimeDiff = sorted[1].time - sorted[0].time;
          const cvSteps = 20;
          const cvPts = [];
          for (let i = 0; i <= cvSteps; i++) {
            const frac = i / cvSteps;
            const t = sorted[0].time + Math.round(cvTimeDiff * frac);
            // Smooth ease-in-out (sigmoid)
            const ease = frac * frac * (3 - 2 * frac);
            const val = sorted[0].price + cvRange * ease;
            cvPts.push({ time: t as Time, value: +val.toFixed(2) });
          }
          createLine(cvPts, color, 2, 0, 'Curve');
          break;
        }

        // ── Double Curve — S-curve with reverse ───────────────
        case 'double-curve': {
          const dcvRange = sorted[1].price - sorted[0].price;
          const dcvTimeDiff = sorted[1].time - sorted[0].time;
          const dcvSteps = 24;
          const dcvPts = [];
          for (let i = 0; i <= dcvSteps; i++) {
            const frac = i / dcvSteps;
            const t = sorted[0].time + Math.round(dcvTimeDiff * frac);
            // Double S-curve: sin wave mapped to price
            const val = sorted[0].price + dcvRange * (0.5 + 0.5 * Math.sin((frac * 2 - 1) * Math.PI / 2));
            dcvPts.push({ time: t as Time, value: +val.toFixed(2) });
          }
          createLine(dcvPts, color, 2, 0, 'Double Curve');
          break;
        }

        // ═══════════════════════════════════════════════════════
        // ── PROJECTION ────────────────────────────────────────
        // ═══════════════════════════════════════════════════════

        // ── Forecast — projected trend continuation ───────────
        case 'forecast': {
          // Main trend line
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 2, 0,
          );
          // Projected continuation (dashed)
          const fcSlope = (sorted[1].price - sorted[0].price) / ((sorted[1].time - sorted[0].time) || 1);
          const fcExtent = sorted[1].time - sorted[0].time;
          const fcFarTime = sorted[1].time + fcExtent;
          const fcFarPrice = sorted[1].price + fcSlope * fcExtent;
          createLine(
            [
              { time: sorted[1].time as Time, value: sorted[1].price },
              { time: fcFarTime as Time, value: +fcFarPrice.toFixed(2) },
            ],
            color, 2, 2, 'Forecast',
          );
          // Confidence bands (±)
          const fcBand = Math.abs(sorted[1].price - sorted[0].price) * 0.15;
          createLine(
            [
              { time: sorted[1].time as Time, value: +(sorted[1].price + fcBand).toFixed(2) },
              { time: fcFarTime as Time, value: +(fcFarPrice + fcBand * 2).toFixed(2) },
            ],
            color, 1, 2,
          );
          createLine(
            [
              { time: sorted[1].time as Time, value: +(sorted[1].price - fcBand).toFixed(2) },
              { time: fcFarTime as Time, value: +(fcFarPrice - fcBand * 2).toFixed(2) },
            ],
            color, 1, 2,
          );
          break;
        }

        // ── Bars Pattern — repeating price pattern ─────────────
        case 'bars-pattern': {
          const bpTimeDiff = sorted[1].time - sorted[0].time;
          const bpPriceDiff = sorted[1].price - sorted[0].price;
          // Original segment
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 2, 0, 'Pattern',
          );
          // Repeat the pattern twice
          for (let rep = 1; rep <= 2; rep++) {
            const baseTime = sorted[1].time + bpTimeDiff * (rep - 1);
            createLine(
              [
                { time: baseTime as Time, value: +(sorted[1].price + bpPriceDiff * (rep - 1)).toFixed(2) },
                { time: (baseTime + bpTimeDiff) as Time, value: +(sorted[1].price + bpPriceDiff * rep).toFixed(2) },
              ],
              color, 1, 2, `Rep ${rep}`,
            );
          }
          break;
        }

        // ── Ghost Feed — mirrored/reflected price action ───────
        case 'ghost-feed': {
          // Original line
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 2, 0, 'Ghost',
          );
          // Ghost: mirror forward from p2
          const gfTimeDiff = sorted[1].time - sorted[0].time;
          const gfPriceDiff = sorted[1].price - sorted[0].price;
          const gfSteps = 8;
          const gfPts = [];
          for (let i = 0; i <= gfSteps; i++) {
            const frac = i / gfSteps;
            const t = sorted[1].time + Math.round(gfTimeDiff * frac);
            // Dampened oscillation around endpoint
            const damp = Math.exp(-frac * 2);
            const val = sorted[1].price + gfPriceDiff * 0.3 * Math.sin(frac * Math.PI * 3) * damp;
            gfPts.push({ time: t as Time, value: +val.toFixed(2) });
          }
          createLine(gfPts, color, 1, 2, 'Feed');
          break;
        }

        // ── Projection — angle-based price projection ──────────
        case 'projection': {
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 2, 0,
          );
          const prjTimeDiff = sorted[1].time - sorted[0].time;
          const prjPriceDiff = sorted[1].price - sorted[0].price;
          // Project 100%, 161.8%, 200%
          const prjLevels = [1, 1.618, 2];
          for (const mult of prjLevels) {
            const t = sorted[1].time + Math.round(prjTimeDiff * (mult - 1));
            const p = sorted[1].price + prjPriceDiff * (mult - 1);
            createLine(
              [
                { time: sorted[1].time as Time, value: sorted[1].price },
                { time: t as Time, value: +p.toFixed(2) },
              ],
              color, 1, 2, `${(mult * 100).toFixed(0)}%`,
            );
          }
          break;
        }

        // ═══════════════════════════════════════════════════════
        // ── VOLUME-BASED ──────────────────────────────────────
        // ═══════════════════════════════════════════════════════

        // ── Anchored VWAP — volume-weighted average from anchor
        case 'anchored-vwap': {
          // Simulated VWAP line from p1 to p2
          const vwMid = (sorted[0].price + sorted[1].price) / 2;
          const vwRange = Math.abs(sorted[1].price - sorted[0].price);
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: +vwMid.toFixed(2) },
            ],
            '#FF6D00', 2, 0, 'VWAP',
          );
          // Upper band
          createLine(
            [
              { time: sorted[0].time as Time, value: +(sorted[0].price + vwRange * 0.2).toFixed(2) },
              { time: sorted[1].time as Time, value: +(vwMid + vwRange * 0.15).toFixed(2) },
            ],
            '#FF6D00', 1, 2, '+1σ',
          );
          // Lower band
          createLine(
            [
              { time: sorted[0].time as Time, value: +(sorted[0].price - vwRange * 0.2).toFixed(2) },
              { time: sorted[1].time as Time, value: +(vwMid - vwRange * 0.15).toFixed(2) },
            ],
            '#FF6D00', 1, 2, '-1σ',
          );
          break;
        }

        // ── Fixed Range Volume Profile — horizontal bars ───────
        case 'fixed-range-volume': {
          const frvTop = Math.max(sorted[0].price, sorted[1].price);
          const frvBot = Math.min(sorted[0].price, sorted[1].price);
          const frvRange = frvTop - frvBot;
          const frvBins = 8;
          // Boundary lines
          createLine(
            [
              { time: sorted[0].time as Time, value: +frvTop.toFixed(2) },
              { time: sorted[1].time as Time, value: +frvTop.toFixed(2) },
            ],
            color, 1, 2,
          );
          createLine(
            [
              { time: sorted[0].time as Time, value: +frvBot.toFixed(2) },
              { time: sorted[1].time as Time, value: +frvBot.toFixed(2) },
            ],
            color, 1, 2,
          );
          // Horizontal level markers (simulating volume bars)
          for (let i = 1; i < frvBins; i++) {
            const price = frvBot + (frvRange / frvBins) * i;
            createLine(
              [
                { time: sorted[0].time as Time, value: +price.toFixed(2) },
                { time: sorted[1].time as Time, value: +price.toFixed(2) },
              ],
              color, 1, 2,
            );
          }
          // POC (point of control) — emphasized middle line
          const poc = frvBot + frvRange * 0.5;
          createLine(
            [
              { time: sorted[0].time as Time, value: +poc.toFixed(2) },
              { time: sorted[1].time as Time, value: +poc.toFixed(2) },
            ],
            '#FF6D00', 2, 0, 'POC',
          );
          break;
        }

        // ═══════════════════════════════════════════════════════
        // ── MEASURER ──────────────────────────────────────────
        // ═══════════════════════════════════════════════════════

        // ── Date Range — time span measurement ────────────────
        case 'date-range': {
          const drTimeDiff = Math.abs(sorted[1].time - sorted[0].time);
          const drBars = Math.round(drTimeDiff / intervalSec);
          const drHours = Math.floor(drTimeDiff / 3600);
          const drMins = Math.floor((drTimeDiff % 3600) / 60);
          const drDuration = drHours > 24
            ? `${Math.floor(drHours / 24)}d ${drHours % 24}h`
            : `${drHours}h ${drMins}m`;
          const drMid = (sorted[0].price + sorted[1].price) / 2;
          // Vertical markers
          createLine(
            [
              { time: sorted[0].time as Time, value: +(drMid * 0.98).toFixed(2) },
              { time: sorted[0].time as Time, value: +(drMid * 1.02).toFixed(2) },
            ],
            color, 2, 0,
          );
          createLine(
            [
              { time: sorted[1].time as Time, value: +(drMid * 0.98).toFixed(2) },
              { time: sorted[1].time as Time, value: +(drMid * 1.02).toFixed(2) },
            ],
            color, 2, 0,
          );
          // Connecting line with label
          createLine(
            [
              { time: sorted[0].time as Time, value: +drMid.toFixed(2) },
              { time: sorted[1].time as Time, value: +drMid.toFixed(2) },
            ],
            color, 1, 2, `${drBars} bars (${drDuration})`,
          );
          break;
        }

        // ── Date and Price Range — combined measurement ────────
        case 'date-price-range': {
          const dpTimeDiff = Math.abs(sorted[1].time - sorted[0].time);
          const dpBars = Math.round(dpTimeDiff / intervalSec);
          const dpPriceDiff = sorted[1].price - sorted[0].price;
          const dpPct = ((dpPriceDiff / sorted[0].price) * 100).toFixed(2);
          const dpHours = Math.floor(dpTimeDiff / 3600);
          const dpMins = Math.floor((dpTimeDiff % 3600) / 60);
          const dpDuration = dpHours > 24
            ? `${Math.floor(dpHours / 24)}d ${dpHours % 24}h`
            : `${dpHours}h ${dpMins}m`;
          // Main diagonal
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 2, 0,
            `${dpPriceDiff >= 0 ? '+' : ''}${dpPriceDiff.toFixed(2)} (${dpPct}%) · ${dpBars} bars (${dpDuration})`,
          );
          // Horizontal component
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[0].price },
            ],
            color, 1, 2,
          );
          // Vertical component
          createLine(
            [
              { time: sorted[1].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 1, 2,
          );
          break;
        }

        // ═══════════════════════════════════════════════════════
        // ── BRUSHES ───────────────────────────────────────────
        // ═══════════════════════════════════════════════════════

        // ── Brush — thick freehand-style line ─────────────────
        case 'brush': {
          const brushPts = drawing.points.map(p => ({
            time: p.time as Time,
            value: p.price,
          }));
          createLine(brushPts, color, 4, 0, 'Brush');
          break;
        }

        // ── Highlighter — wide semi-transparent band ──────────
        case 'highlighter': {
          // Add opacity to the selected color or use yellow
          const baseColor = drawing.color || '#FFEB3B';
          const isHex = baseColor.startsWith('#');
          // simple opacity approach if hex
          const fillColor = isHex ? `${baseColor}99` : 'rgba(255, 235, 59, 0.6)';
          const edgeColor = isHex ? `${baseColor}4D` : 'rgba(255, 235, 59, 0.3)';
          
          const hlRange = Math.abs(sorted[1].price - sorted[0].price) * 0.08 || sorted[0].price * 0.003;
          
          const mainPts = drawing.points.map(p => ({ time: p.time as Time, value: p.price }));
          const topPts = drawing.points.map(p => ({ time: p.time as Time, value: +(p.price + hlRange).toFixed(2) }));
          const botPts = drawing.points.map(p => ({ time: p.time as Time, value: +(p.price - hlRange).toFixed(2) }));

          // Main center line
          createLine(mainPts, fillColor, 4, 0);
          // Top edge
          createLine(topPts, edgeColor, 3, 0);
          // Bottom edge
          createLine(botPts, edgeColor, 3, 0);
          break;
        }

        // ═══════════════════════════════════════════════════════
        // ── TEXT & NOTES ──────────────────────────────────────
        // ═══════════════════════════════════════════════════════

        case 'text':
        case 'anchored-text': {
          // Rendered as an underline with a title label attached
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[0].price },
            ],
            color, 2, 0,
          );
          break;
        }

        case 'note':
        case 'anchored-note': {
          // Rendered as a tiny square/pin marker
          const notePriceOffset = Math.abs(sorted[1].price - sorted[0].price) * 0.1 || sorted[0].price * 0.001;
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[0].time as Time, value: +(sorted[0].price + notePriceOffset).toFixed(2) },
            ],
            color, 4, 0,
          );
          break;
        }

        case 'callout':
        case 'comment': {
          // Rendered as a pointer line ending in an underline
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[1].price },
            ],
            color, 1, 2,
          );
          const extTime = sorted[1].time + (sorted[1].time - sorted[0].time) * 0.2;
          createLine(
            [
              { time: sorted[1].time as Time, value: sorted[1].price },
              { time: extTime as Time, value: sorted[1].price },
            ],
            color, 2, 0,
          );
          break;
        }

        case 'price-label':
        case 'price-note': {
          // Rendered as a horizontal ray emphasizing the specific price
          createLine(
            [
              { time: sorted[0].time as Time, value: sorted[0].price },
              { time: sorted[1].time as Time, value: sorted[0].price },
            ],
            color, 2, 0,
          );
          break;
        }

        case 'signpost': {
          // Rendered as a vertical pole with a rectangle sign at the top
          const topPrice = Math.max(sorted[0].price, sorted[1].price);
          const botPrice = Math.min(sorted[0].price, sorted[1].price);
          const signH = (topPrice - botPrice) * 0.2;
          // Pole
          createLine(
            [
              { time: sorted[0].time as Time, value: botPrice },
              { time: sorted[0].time as Time, value: topPrice },
            ],
            color, 2, 0,
          );
          // Sign
          createLine(
            [
              { time: sorted[0].time as Time, value: topPrice },
              { time: sorted[1].time as Time, value: topPrice },
              { time: sorted[1].time as Time, value: +(topPrice - signH).toFixed(2) },
              { time: sorted[0].time as Time, value: +(topPrice - signH).toFixed(2) },
            ],
            color, 2, 0,
          );
          break;
        }

        case 'flag-mark': {
          // Rendered as a vertical pole with a triangular flag
          const topPrice = Math.max(sorted[0].price, sorted[1].price);
          const botPrice = Math.min(sorted[0].price, sorted[1].price);
          const flagH = (topPrice - botPrice) * 0.3;
          // Pole
          createLine(
            [
              { time: sorted[0].time as Time, value: botPrice },
              { time: sorted[0].time as Time, value: topPrice },
            ],
            color, 2, 0,
          );
          // Flag triangle
          createLine(
            [
              { time: sorted[0].time as Time, value: topPrice },
              { time: sorted[1].time as Time, value: +(topPrice - flagH / 2).toFixed(2) },
              { time: sorted[0].time as Time, value: +(topPrice - flagH).toFixed(2) },
            ],
            color, 2, 0,
          );
          break;
        }
      }
    }
  }, [drawings, drawingsVisible, chartData, chartRef, candleSeriesRef, drawingSeriesRef]);
}
