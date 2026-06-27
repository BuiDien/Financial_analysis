// LWChart — React wrapper around TradingView Lightweight Charts (Apache-2.0).
// Loaded global: window.LightweightCharts (see CDN script in the HTML head).
//
// Props:
//   data     : [{ open, high, low, close, volume }]  (ascending, oldest→newest)
//   type     : 'candle' | 'area'
//   height   : px (default 360)
//   volume   : bool — show a volume histogram pane (default true)
//   range    : current range key, only used to vary synthetic timestamps
//
// Reads our CSS custom properties so the canvas matches the active theme, and
// re-themes automatically when the html[data-theme] attribute flips.

const LW_CDN_READY = () => typeof window.LightweightCharts !== 'undefined';

// Resolve a CSS variable to a concrete color string (canvas can't use var()).
const cssVar = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

// Build ascending UTC timestamps (seconds) for N bars, spaced by range.
const synthTimes = (n, range) => {
  const stepSec = {
    '1D': 5 * 60,        // 5-minute bars
    '1W': 60 * 60,       // hourly
    '1M': 24 * 60 * 60,  // daily
    '3M': 24 * 60 * 60,
    '1Y': 7 * 24 * 60 * 60,   // weekly
    '5Y': 30 * 24 * 60 * 60,  // monthly
  }[range] || 24 * 60 * 60;
  const now = Math.floor(Date.now() / 1000);
  const start = now - stepSec * (n - 1);
  return Array.from({ length: n }, (_, i) => start + i * stepSec);
};

const LWChart = ({ data, type = 'candle', height = 360, volume = true, range = '1M' }) => {
  const containerRef = React.useRef(null);
  const chartRef = React.useRef(null);
  const mainSeriesRef = React.useRef(null);
  const volSeriesRef = React.useRef(null);
  const lastBarRef = React.useRef(null);
  const [ready, setReady] = React.useState(LW_CDN_READY());
  const [themeTick, setThemeTick] = React.useState(0);
  const [legend, setLegend] = React.useState(null);  // { o,h,l,c,chg } for the hovered/last bar

  // Poll until the CDN library is available (it loads async alongside React).
  React.useEffect(() => {
    if (ready) return;
    const iv = setInterval(() => { if (LW_CDN_READY()) { setReady(true); clearInterval(iv); } }, 120);
    return () => clearInterval(iv);
  }, [ready]);

  // Re-theme when the app theme attribute changes.
  React.useEffect(() => {
    const obs = new MutationObserver(() => setThemeTick(t => t + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  // Build (or rebuild) the chart when ready / type / theme changes.
  React.useEffect(() => {
    if (!ready || !containerRef.current) return;
    const LWC = window.LightweightCharts;

    const text = cssVar('--text-muted', '#6B6862');
    const grid = cssVar('--border', '#E5E3DA');
    const pos = cssVar('--pos', '#15803D');
    const neg = cssVar('--neg', '#B91C1C');
    const accent = cssVar('--accent', '#C2410C');

    const chart = LWC.createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: text, fontFamily: "'JetBrains Mono', monospace", fontSize: 11 },
      grid: { vertLines: { color: grid, style: 1 }, horzLines: { color: grid, style: 1 } },
      rightPriceScale: { borderColor: grid, scaleMargins: { top: 0.08, bottom: volume ? 0.28 : 0.08 } },
      timeScale: { borderColor: grid, timeVisible: range === '1D' || range === '1W', secondsVisible: false },
      crosshair: {
        mode: LWC.CrosshairMode ? LWC.CrosshairMode.Normal : 0,
        vertLine: { color: accent, width: 1, style: 2, labelBackgroundColor: accent },
        horzLine: { color: accent, width: 1, style: 2, labelBackgroundColor: accent },
      },
      handleScroll: true,
      handleScale: true,
    });
    chartRef.current = chart;

    // Main series (v4 API). Fall back to v5 addSeries if needed.
    let main;
    if (type === 'area') {
      const opts = { lineColor: accent, topColor: accent + '55', bottomColor: accent + '05', lineWidth: 2, priceLineVisible: false };
      main = chart.addAreaSeries ? chart.addAreaSeries(opts) : chart.addSeries(LWC.AreaSeries, opts);
    } else {
      const opts = { upColor: pos, downColor: neg, borderUpColor: pos, borderDownColor: neg, wickUpColor: pos, wickDownColor: neg };
      main = chart.addCandlestickSeries ? chart.addCandlestickSeries(opts) : chart.addSeries(LWC.CandlestickSeries, opts);
    }
    mainSeriesRef.current = main;

    if (volume) {
      const vOpts = { priceFormat: { type: 'volume' }, priceScaleId: 'vol' };
      const vol = chart.addHistogramSeries ? chart.addHistogramSeries(vOpts) : chart.addSeries(LWC.HistogramSeries, vOpts);
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
      volSeriesRef.current = vol;
    } else {
      volSeriesRef.current = null;
    }

    // Live OHLC legend — follows the crosshair, falls back to the last bar.
    const updateLegend = (bar) => {
      if (!bar) { setLegend(null); return; }
      if (type === 'area') {
        setLegend({ value: bar.value });
      } else {
        const chg = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : 0;
        setLegend({ o: bar.open, h: bar.high, l: bar.low, c: bar.close, chg });
      }
    };
    chart.subscribeCrosshairMove((param) => {
      if (!param.point || !param.seriesData || !mainSeriesRef.current) { updateLegend(lastBarRef.current); return; }
      const d = param.seriesData.get(mainSeriesRef.current);
      updateLegend(d || lastBarRef.current);
    });

    // Responsive width
    const ro = new ResizeObserver(entries => {
      for (const e of entries) chart.applyOptions({ width: e.contentRect.width });
    });
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [ready, type, height, volume, themeTick]);

  // Push data whenever it (or the chart) changes.
  React.useEffect(() => {
    const main = mainSeriesRef.current;
    if (!main || !data || !data.length) return;
    const times = synthTimes(data.length, range);
    const pos = cssVar('--pos', '#15803D');
    const neg = cssVar('--neg', '#B91C1C');

    if (type === 'area') {
      main.setData(data.map((d, i) => ({ time: times[i], value: d.close })));
    } else {
      main.setData(data.map((d, i) => ({ time: times[i], open: d.open, high: d.high, low: d.low, close: d.close })));
    }
    if (volSeriesRef.current) {
      volSeriesRef.current.setData(data.map((d, i) => ({
        time: times[i],
        value: d.volume || 0,
        color: (d.close >= d.open ? pos : neg) + '55',
      })));
    }
    chartRef.current?.timeScale().fitContent();
    // Seed the legend with the most recent bar.
    const last = data[data.length - 1];
    lastBarRef.current = type === 'area'
      ? { value: last.close }
      : { open: last.open, high: last.high, low: last.low, close: last.close };
    if (type === 'area') setLegend({ value: last.close });
    else setLegend({ o: last.open, h: last.high, l: last.low, c: last.close, chg: last.open ? ((last.close - last.open) / last.open) * 100 : 0 });
  }, [data, type, range, ready, themeTick]);

  return (
    <div style={{ position: 'relative', width: '100%', height }}>
      {legend && (
        <div style={{
          position: 'absolute', top: 10, left: 12, zIndex: 3,
          display: 'flex', gap: 14, alignItems: 'baseline',
          fontFamily: 'var(--font-mono)', fontSize: 12,
          background: 'var(--bg-elev)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '6px 12px', pointerEvents: 'none',
          boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
        }}>
          {legend.value !== undefined ? (
            <LegendItem label="PRICE" value={legend.value} />
          ) : (
            <>
              <LegendItem label="O" value={legend.o} />
              <LegendItem label="H" value={legend.h} />
              <LegendItem label="L" value={legend.l} />
              <LegendItem label="C" value={legend.c} accent />
              <span style={{ fontWeight: 600, color: legend.chg >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
                {legend.chg >= 0 ? '+' : ''}{legend.chg.toFixed(2)}%
              </span>
            </>
          )}
        </div>
      )}
      <div ref={containerRef} style={{ width: '100%', height }} />
      {!ready && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--text-subtle)', fontSize: 12 }}>
          Loading chart…
        </div>
      )}
    </div>
  );
};

const LegendItem = ({ label, value, accent }) => (
  <span style={{ display: 'inline-flex', gap: 4, alignItems: 'baseline' }}>
    <span style={{ color: 'var(--text-subtle)', fontSize: 10, fontWeight: 600 }}>{label}</span>
    <span style={{ color: accent ? 'var(--accent)' : 'var(--text)', fontWeight: 600 }}>
      {value != null ? value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
    </span>
  </span>
);

window.LWChart = LWChart;
