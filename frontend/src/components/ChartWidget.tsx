import React, { useEffect, useRef } from 'react';
import { createChart, CrosshairMode, LineStyle, CandlestickSeries } from 'lightweight-charts';
import { API_BASE } from '../lib/api';

interface ChartWidgetProps {
  symbol: string;
  entry?: number;
  sl?: number;
  tp?: number;
  signal?: string;
}

const ChartWidget: React.FC<ChartWidgetProps> = ({ symbol, entry, sl, tp, signal }) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Create chart
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: 'solid' as any, color: '#131722' },
        textColor: '#d1d4dc',
      },
      grid: {
        vertLines: { color: 'rgba(42, 46, 57, 0.5)' },
        horzLines: { color: 'rgba(42, 46, 57, 0.5)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: 'rgba(197, 203, 206, 0.8)',
      },
      timeScale: {
        borderColor: 'rgba(197, 203, 206, 0.8)',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    chartRef.current = chart;

    // Create Candlestick Series (v5 API)
    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    seriesRef.current = candlestickSeries;

    // Fetch Historical Data
    fetch(`${API_BASE}/api/mt5/history/${symbol}?timeframe=H1&count=500`)
      .then(res => res.json())
      .then(data => {
        if (data.data && data.data.length > 0) {
          candlestickSeries.setData(data.data);
          
          // Add Order Lines if available
          if (entry && sl && tp && signal && signal.startsWith('ENTRY')) {
            // Entry Line
            candlestickSeries.createPriceLine({
              price: entry,
              color: '#2962FF',
              lineWidth: 2,
              lineStyle: LineStyle.Solid,
              axisLabelVisible: true,
              title: 'ENTRY',
            });

            // Stop Loss Line
            candlestickSeries.createPriceLine({
              price: sl,
              color: '#ef5350',
              lineWidth: 2,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: 'SL',
            });

            // Take Profit Line
            candlestickSeries.createPriceLine({
              price: tp,
              color: '#26a69a',
              lineWidth: 2,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: 'TP',
            });
          }
        }
      })
      .catch(err => console.error("Error fetching chart data:", err));

    // Handle Resize
    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, [symbol, entry, sl, tp, signal]);

  return (
    <div className="w-full h-[400px]" ref={chartContainerRef} />
  );
};

export default ChartWidget;
