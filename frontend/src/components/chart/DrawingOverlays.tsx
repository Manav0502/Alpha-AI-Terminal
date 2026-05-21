import React, { useEffect, useState } from 'react';
import { IChartApi, ISeriesApi } from 'lightweight-charts';
import { useChartUIStore, Drawing } from '../../store/useChartUIStore';

interface DrawingOverlaysProps {
  chartRef: React.RefObject<IChartApi | null>;
  candleSeriesRef: React.RefObject<ISeriesApi<'Candlestick'> | null>;
}

export function DrawingOverlays({ chartRef, candleSeriesRef }: DrawingOverlaysProps) {
  const drawings = useChartUIStore((s) => s.drawings);
  const drawingsVisible = useChartUIStore((s) => s.drawingsVisible);
  const updateDrawing = useChartUIStore((s) => s.updateDrawing);

  // Force re-renders when the chart is panned or zoomed
  const [, setTick] = useState(0);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    
    const forceUpdate = () => setTick((t) => t + 1);

    // Subscribe to chart movement to sync DOM overlays at 60fps
    chart.timeScale().subscribeVisibleTimeRangeChange(forceUpdate);
    chart.timeScale().subscribeVisibleLogicalRangeChange(forceUpdate);
    chart.timeScale().subscribeSizeChange(forceUpdate);

    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(forceUpdate);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(forceUpdate);
      chart.timeScale().unsubscribeSizeChange(forceUpdate);
    };
  }, [chartRef]);

  if (!drawingsVisible) return null;

  const textTools = new Set([
    'text', 'anchored-text', 'note', 'anchored-note', 
    'callout', 'comment', 'price-label', 'price-note', 
    'signpost', 'flag-mark'
  ]);

  const getPos = (drawing: Drawing) => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series || drawing.points.length === 0) return null;

    // We anchor the text box to the LAST point of the drawing (e.g. end of the callout line)
    const pt = drawing.points[drawing.points.length - 1];

    try {
      const x = chart.timeScale().timeToCoordinate(pt.time as any);
      const y = series.priceToCoordinate(pt.price);
      if (x === null || y === null) return null;
      return { x, y };
    } catch {
      return null;
    }
  };

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
      {drawings.filter((d) => textTools.has(d.tool) || d.tool === 'measure').map((drawing) => {
        
        // ── MEASURE TOOL ──────────────────────────────────────────
        if (drawing.tool === 'measure') {
          if (drawing.points.length < 2) return null;
          const chart = chartRef.current;
          const series = candleSeriesRef.current;
          if (!chart || !series) return null;

          const p1 = drawing.points[0];
          const p2 = drawing.points[1];

          let x1: number | null = null;
          let x2: number | null = null;
          try {
            x1 = chart.timeScale().timeToCoordinate(p1.time as any);
            x2 = chart.timeScale().timeToCoordinate(p2.time as any);
          } catch { }
          const y1 = series.priceToCoordinate(p1.price);
          const y2 = series.priceToCoordinate(p2.price);

          if (x1 === null || x2 === null || y1 === null || y2 === null) return null;

          const left = Math.min(x1, x2);
          const top = Math.min(y1, y2);
          const width = Math.abs(x1 - x2);
          const height = Math.abs(y1 - y2);
          const color = drawing.color || '#2962FF';
          
          // Metrics
          const priceDiff = p2.price - p1.price;
          const pct = (priceDiff / p1.price) * 100;
          const timeDiffSeconds = Math.abs(p2.time - p1.time);
          
          const d = Math.floor(timeDiffSeconds / 86400);
          const h = Math.floor((timeDiffSeconds % 86400) / 3600);
          const m = Math.floor((timeDiffSeconds % 3600) / 60);
          let timeStr = '';
          if (d > 0) timeStr += `${d}d `;
          if (h > 0) timeStr += `${h}h `;
          if (m > 0 || timeStr === '') timeStr += `${m}m`;

          return (
            <div key={drawing.id} className="absolute pointer-events-auto" style={{ left, top, width, height }}>
              {/* Shaded Box */}
              <div 
                className="absolute inset-0 border"
                style={{ 
                  backgroundColor: `${color}33`, 
                  borderColor: `${color}80` 
                }}
              >
                {/* Crosshairs */}
                <div className="absolute top-1/2 left-0 right-0 h-px" style={{ backgroundColor: `${color}80` }} />
                <div className="absolute left-1/2 top-0 bottom-0 w-px" style={{ backgroundColor: `${color}80` }} />
              </div>
              
              {/* Floating Metrics Label */}
              <div 
                className="absolute text-xs text-white rounded px-2 py-1 flex flex-col items-center justify-center whitespace-nowrap shadow"
                style={{
                  backgroundColor: color,
                  left: '50%',
                  top: 0,
                  transform: 'translate(-50%, -110%)'
                }}
              >
                <div>{priceDiff > 0 ? '+' : ''}{priceDiff.toFixed(2)} ({priceDiff > 0 ? '+' : ''}{pct.toFixed(2)}%)</div>
                <div>{timeStr}</div>
              </div>
            </div>
          );
        }

        // ── TEXT TOOLS ────────────────────────────────────────────
        const pos = getPos(drawing);
        if (!pos) return null;

        const isEditing = drawing.text === undefined;
        const color = drawing.color || '#03A9F4';

        // Different tools get slightly different CSS presentation
        const isCallout = drawing.tool === 'callout' || drawing.tool === 'comment';
        const isFlag = drawing.tool === 'flag-mark' || drawing.tool === 'signpost';
        
        let offsetX = 0;
        let offsetY = 0;
        if (isCallout) {
          offsetX = 5;
          offsetY = -15;
        } else if (isFlag) {
          offsetX = 10;
          offsetY = -20;
        } else {
          offsetX = 5;
          offsetY = -12;
        }

        return (
          <div
            key={drawing.id}
            className="absolute pointer-events-auto flex flex-col justify-center"
            style={{
              transform: `translate(${pos.x + offsetX}px, ${pos.y + offsetY}px)`,
              // For a callout bubble effect
            }}
          >
            {isEditing ? (
              <input
                autoFocus
                className="bg-elevated border rounded px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-1 shadow-lg min-w-[120px]"
                style={{ borderColor: color, outlineColor: color }}
                placeholder="Enter text..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    updateDrawing(drawing.id, { text: e.currentTarget.value || 'Text' });
                  }
                }}
                onBlur={(e) => {
                  updateDrawing(drawing.id, { text: e.target.value || 'Text' });
                }}
              />
            ) : (
              <div
                className={`
                  px-2.5 py-1 text-sm font-medium rounded shadow-lg whitespace-nowrap cursor-pointer transition-colors
                  ${isCallout ? 'border-2' : ''}
                `}
                style={{
                  color: isCallout || isFlag ? '#FFFFFF' : color,
                  borderColor: color,
                  backgroundColor: isCallout || isFlag ? color : 'transparent',
                }}
                onDoubleClick={() => {
                  // Allow double click to edit again
                  updateDrawing(drawing.id, { text: undefined });
                }}
              >
                {drawing.text}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
