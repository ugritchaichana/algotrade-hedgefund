import React, { useEffect, useRef } from 'react';
import { createChart, CrosshairMode, LineStyle, CandlestickSeries } from 'lightweight-charts';
import { API_BASE } from '../lib/api';

interface ChartWidgetProps {
  symbol: string;
  timeframe?: string;     // M5, M15, H1, H4, D1, W1, MN1 — default H1
  entry?: number;
  sl?: number;
  tp?: number;
  signal?: string;
  height?: number | string;  // CSS height — default fills container
  count?: number;         // candles to fetch — default 500
}

const ChartWidget: React.FC<ChartWidgetProps> = ({
  symbol,
  timeframe = 'H1',
  entry,
  sl,
  tp,
  signal,
  height,
  count = 500,
}) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: 'solid' as any, color: '#131722' },
        textColor: '#d1d4dc',
      },
      grid: {
        vertLines: { color: 'rgba(42, 46, 57, 0.5)' },
        horzLines: { color: 'rgba(42, 46, 57, 0.5)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(197, 203, 206, 0.8)' },
      timeScale: {
        borderColor: 'rgba(197, 203, 206, 0.8)',
        timeVisible: timeframe !== 'D1' && timeframe !== 'W1' && timeframe !== 'MN1',
        secondsVisible: false,
      },
      autoSize: !height,  // when no explicit height, fill container responsively
    });

    chartRef.current = chart;

    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    seriesRef.current = candlestickSeries;

    let cancelled = false;
    fetch(`${API_BASE}/api/mt5/history/${symbol}?timeframe=${timeframe}&count=${count}`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        if (data.data && data.data.length > 0) {
          candlestickSeries.setData(data.data);

          if (entry && sl && tp && signal && signal.startsWith('ENTRY')) {
            candlestickSeries.createPriceLine({
              price: entry, color: '#2962FF', lineWidth: 2,
              lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'ENTRY',
            });
            candlestickSeries.createPriceLine({
              price: sl, color: '#ef5350', lineWidth: 2,
              lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'SL',
            });
            candlestickSeries.createPriceLine({
              price: tp, color: '#26a69a', lineWidth: 2,
              lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'TP',
            });
          }
          chart.timeScale().fitContent();
        }
      })
      .catch(err => console.error('Chart fetch failed:', err));

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelled = true;
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, [symbol, timeframe, entry, sl, tp, signal, count]);

  const style: React.CSSProperties = height
    ? { height: typeof height === 'number' ? `${height}px` : height, width: '100%' }
    : { height: '100%', width: '100%' };

  return <div className="w-full" style={style} ref={chartContainerRef} />;
};

export default ChartWidget;
