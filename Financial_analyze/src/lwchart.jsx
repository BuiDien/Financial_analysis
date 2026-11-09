// LWChart — React wrapper around TradingView Lightweight Charts (Apache-2.0).
// Loaded global: window.LightweightCharts (see CDN script in the HTML head).
//
// Props:
//   data     : [{ time?, open, high, low, close, volume }]  (ascending; time = unix seconds)
//   type     : 'candle' | 'area'
//   height   : px (default 360)
//   volume   : bool — show a volume histogram pane (default true)
//   range    : candle timeframe key (5m 15m 1H 1D 1W 1M 3M) — intraday shows clock time
//   markers  : [{ time (unix s), kind: 'BUY'|'SELL'|'BONUS'|'RIGHTS'|'DIVIDEND', quantity }]
//              snapped to the bar that contains them; same-bar events are merged
//   onReachStart : called when the user scrolls near the oldest bar (load older data)
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
    '5m': 5 * 60, '15m': 15 * 60, '1H': 60 * 60,
    '1D': 24 * 60 * 60, '1W': 7 * 24 * 60 * 60,
    '1M': 30 * 24 * 60 * 60, '3M': 91 * 24 * 60 * 60,
  }[range] || 24 * 60 * 60;
  const now = Math.floor(Date.now() / 1000);
  const start = now - stepSec * (n - 1);
  return Array.from({ length: n }, (_, i) => start + i * stepSec);
};

const LWChart = ({ data, type = 'candle', height = 360, volume = true, range = '1M', markers = null, onReachStart = null }) => {
  const containerRef = React.useRef(null);
  const chartRef = React.useRef(null);
  const mainSeriesRef = React.useRef(null);
  const volSeriesRef = React.useRef(null);
  const lastBarRef = React.useRef(null);
  const prevTimesRef = React.useRef(null);   // times last pushed — detects prepends
  const reachStartRef = React.useRef(onReachStart);
  reachStartRef.current = onReachStart;
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
      timeScale: { borderColor: grid, timeVisible: ['5m', '15m', '30m', '1H'].includes(range), secondsVisible: false },
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

    // Scrolled to the left edge → ask for older bars.
    chart.timeScale().subscribeVisibleLogicalRangeChange(r => {
      if (r && r.from < 10 && reachStartRef.current) reachStartRef.current();
    });
    prevTimesRef.current = null;

    // Responsive width
    const ro = new ResizeObserver(entries => {
      for (const e of entries) chart.applyOptions({ width: e.contentRect.width });
    });
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [ready, type, height, volume, themeTick, range]);

  // Push data whenever it (or the chart) changes.
  React.useEffect(() => {
    const main = mainSeriesRef.current;
    if (!main || !data || !data.length) return;
    // Real bars carry `time` (unix seconds); use them when strictly ascending,
    // otherwise fall back to synthetic spacing.
    const real = data.map(d => d.time);
    const realOk = real.every((t, i) => Number.isFinite(t) && (i === 0 || t > real[i - 1]));
    const times = realOk ? real : synthTimes(data.length, range);
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
    if (main.setMarkers) main.setMarkers(buildMarkers(markers, times));
    // Keep the user's view: fit only on first load; when older bars were
    // prepended, shift the visible range by the number of bars added.
    const ts = chartRef.current?.timeScale();
    const prev = prevTimesRef.current;
    if (ts) {
      if (!prev || !prev.length) ts.fitContent();
      else if (times[0] < prev[0]) {
        const added = times.findIndex(t => t >= prev[0]);
        const vr = ts.getVisibleLogicalRange();
        if (vr && added > 0) ts.setVisibleLogicalRange({ from: vr.from + added, to: vr.to + added });
      }
    }
    prevTimesRef.current = times;
    // Seed the legend with the most recent bar.
    const last = data[data.length - 1];
    lastBarRef.current = type === 'area'
      ? { value: last.close }
      : { open: last.open, high: last.high, low: last.low, close: last.close };
    if (type === 'area') setLegend({ value: last.close });
    else setLegend({ o: last.open, h: last.high, l: last.low, c: last.close, chg: last.open ? ((last.close - last.open) / last.open) * 100 : 0 });
  }, [data, type, range, ready, themeTick, markers]);

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

// Snap trade events onto bar times and merge same-bar events into one marker per side.
const buildMarkers = (events, times) => {
  if (!events?.length || !times.length) return [];
  const step = times.length > 1 ? times[times.length - 1] - times[times.length - 2] : 86400;
  const buckets = new Map();
  for (const e of events) {
    if (!Number.isFinite(e.time) || e.time < times[0] || e.time > times[times.length - 1] + step) continue;
    let lo = 0, hi = times.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= e.time) lo = mid; else hi = mid - 1; }
    const side = e.kind === 'SELL' ? 'S' : e.kind === 'DIVIDEND' ? 'D' : e.kind === 'BUY' ? 'B' : 'R';
    const key = times[lo] + side;
    const b = buckets.get(key) || { time: times[lo], side, qty: 0, n: 0 };
    b.qty += Number(e.quantity || 0); b.n += 1;
    buckets.set(key, b);
  }
  const pos = cssVar('--pos', '#15803D'), neg = cssVar('--neg', '#B91C1C'), accent = cssVar('--accent', '#C2410C');
  const style = {
    B: { position: 'belowBar', shape: 'arrowUp', color: pos, label: 'B' },
    S: { position: 'aboveBar', shape: 'arrowDown', color: neg, label: 'S' },
    R: { position: 'belowBar', shape: 'circle', color: accent, label: '+' },
    D: { position: 'aboveBar', shape: 'circle', color: accent, label: 'Div' },
  };
  return [...buckets.values()].sort((a, b) => a.time - b.time).map(b => {
    const st = style[b.side];
    const text = b.side === 'D' ? st.label : `${st.label} ${b.qty.toLocaleString()}${b.n > 1 ? ` (${b.n})` : ''}`;
    return { time: b.time, position: st.position, shape: st.shape, color: st.color, text };
  });
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
