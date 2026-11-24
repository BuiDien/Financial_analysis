// Company overview data: live quote, 1Y daily bars, ratios, chart bars for the chosen
// candle range (with scroll-back loading) and my trades on this ticker as chart markers.
// Quote and chart bars go through the shared query cache (lib/query.js).

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { useQuery } from '../../lib/query.js';
import {
  CHART_POLL_MS, DETAIL_RANGES, OLDER_CHUNK, QUOTE_POLL_MS, VN_OFFSET_MIN,
  computeTechnicals, resolveMarket, scaleQuote, toBar, toQuarters,
} from './market-utils.js';

const useCompanyMarket = ({ activeAsset, holding, range, showTrades }) => {
  const live = !!HelixAPI?.live;
  const { market, vn, scale } = resolveMarket(activeAsset, holding);

  // Live quote — shared query cache, refreshed every 60s while the tab is visible.
  const quoteQ = useQuery(['quote', market], () => HelixAPI.quote(market), { refreshMs: QUOTE_POLL_MS, enabled: live, staleMs: QUOTE_POLL_MS / 2 });
  const quote = React.useMemo(() => (live && quoteQ.data ? scaleQuote(quoteQ.data, scale) : null), [live, quoteQ.data, scale]);
  const quoteErr = !!quoteQ.error;

  // Ratios + 1Y daily bars (technicals, 52W fallback) — once per asset.
  const [ratios, setRatios] = React.useState(null);
  const [daily, setDaily] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    setRatios(null); setDaily(null);
    if (!live) return undefined;
    if (!vn) HelixAPI.ratios(market).then(r => { if (!cancelled) setRatios(r); }).catch(() => {});
    HelixAPI.history(market, '1y', '1d')
      .then(rows => { if (!cancelled && Array.isArray(rows)) setDaily(rows.map(r => toBar(r, scale))); })
      .catch(() => { if (!cancelled) setDaily([]); });
    return () => { cancelled = true; };
  }, [market, scale, vn, live]);

  // Chart bars for the selected range — shared query cache; short ranges refresh on a timer
  // (a failed refresh keeps the last good bars). Older bars loaded by scrolling left are
  // kept apart so the refresh of the recent window keeps them.
  const [period, interval] = DETAIL_RANGES[range] || DETAIL_RANGES['1D'];
  const barsQ = useQuery(['history', market, period, interval], () => HelixAPI.history(market, period, interval),
    { refreshMs: CHART_POLL_MS[range] || 0, enabled: live });
  const bars = React.useMemo(() => (live && Array.isArray(barsQ.data) && barsQ.data.length > 1
    ? barsQ.data.map(r => toBar(r, scale)) : null), [live, barsQ.data, scale]);
  const chartState = !live ? 'empty' : bars ? 'ready'
    : (barsQ.data === undefined && !barsQ.error ? 'loading' : 'empty'); // loading | ready | empty
  const [older, setOlder] = React.useState([]);
  const [olderState, setOlderState] = React.useState('idle'); // idle | loading | done
  const olderBusy = React.useRef(false);
  React.useEffect(() => { setOlder([]); setOlderState('idle'); olderBusy.current = false; }, [market, range, live]);

  // Exchange UTC offset (minutes), from the latest bar's date string.
  const marketOff = (bars && bars.length ? bars[bars.length - 1].off : null) ?? (vn ? VN_OFFSET_MIN : 0);

  // My trades on this ticker (from the portfolio ledger) — drawn as chart markers.
  const [myTicker, setMyTicker] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    setMyTicker(null);
    if (!live || !HelixAPI.portfolioTickers) return undefined;
    const sym = market.startsWith('VN:') ? market.slice(3) : market;
    HelixAPI.portfolioTickers()
      .then(d => { if (!cancelled) setMyTicker((d.tickers || []).find(t => t.ticker === sym || t.ticker === String(activeAsset).toUpperCase()) || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [market, activeAsset, live]);
  const tradeMarkers = React.useMemo(() => {
    if (!showTrades || !myTicker) return null;
    // Ledger times are UTC → exchange clock.
    return myTicker.events.map(e => ({ time: Math.floor(Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(e.date) ? e.date : e.date + 'Z') / 1000) + marketOff * 60, kind: e.kind, quantity: e.quantity }));
  }, [myTicker, showTrades, marketOff]);

  const loadOlder = React.useCallback(() => {
    if (!live || olderBusy.current || olderState === 'done') return;
    const first = (older[0] || (bars && bars[0]));
    if (!first || !Number.isFinite(first.time)) return;
    const [, interval] = DETAIL_RANGES[range] || DETAIL_RANGES['1D'];
    const end = new Date(first.time * 1000).toISOString().slice(0, 10);  // exchange-local date
    olderBusy.current = true; setOlderState('loading');
    const key = `${market}|${range}`;
    HelixAPI.history(market, OLDER_CHUNK[interval] || '1y', interval, end)
      .then(rows => {
        if (`${market}|${range}` !== key) return;
        const add = (Array.isArray(rows) ? rows : []).map(r => toBar(r, scale)).filter(b => Number.isFinite(b.time) && b.time < first.time);
        if (!add.length) { setOlderState('done'); return; }
        setOlder(o => [...add, ...o]);
        setOlderState('idle');
      })
      .catch(() => setOlderState('done'))
      .finally(() => { olderBusy.current = false; });
  }, [live, olderState, older, bars, range, market, scale]);

  // Fold the live quote into the latest candle so the chart moves between history refreshes.
  const ohlc = React.useMemo(() => {
    if (!bars || !bars.length) return bars;
    let out = older.length ? [...older.filter(b => b.time < bars[0].time), ...bars] : bars;
    const px = quote?.price;
    if (px != null && Number.isFinite(px)) {
      const lb = out[out.length - 1];
      out = [...out.slice(0, -1), { ...lb, close: px, high: Math.max(lb.high, px), low: Math.min(lb.low, px) }];
    }
    return range === '3M' ? toQuarters(out) : out;
  }, [bars, older, quote?.price, range]);

  const tech = React.useMemo(() => (daily && daily.length ? computeTechnicals(daily) : {}), [daily]);

  return {
    live, market, vn, quote, quoteErr, ratios, daily, tech, chartState, olderState, ohlc,
    loadOlder, marketOff, myTicker, tradeMarkers,
  };
};

export { useCompanyMarket };
