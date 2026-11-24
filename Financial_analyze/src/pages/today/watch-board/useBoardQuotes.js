// Per-tile quote state for the watch board. Each quote carries a `gen`, bumped
// only when a poll delivers data for a market that is trading; that is the ONLY
// thing that re-triggers the tile's line draw-in. Closed markets keep their
// series and gen frozen: no fake movement, no redraws.

import React from 'react';
import { HelixAPI } from '../../../api-client.jsx';
import { useQuery } from '../../../lib/query.js';
import { marketOf } from './instruments.js';

const POLL_MS = 5 * 60 * 1000;   // 2s polling tripped Yahoo's rate limit
const emptyQuote = () => ({ price: null, chg: null, series: null, state: null, gen: 0 });

const fetchBoardQuotes = (watch) => Promise.all(watch.map(sym =>
  HelixAPI.quote(marketOf(sym)).then(q => ({ sym, q })).catch(() => null)));

const useBoardQuotes = (watch, live) => {
  const [quotes, setQuotes] = React.useState(() => Object.fromEntries(watch.map(s => [s, emptyQuote()])));

  // Backend went away: drop every value (no stale numbers shown as live).
  React.useEffect(() => { if (!live) setQuotes(Object.fromEntries(watch.map(s => [s, emptyQuote()]))); }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  // New symbols start empty until their first quote.
  React.useEffect(() => {
    setQuotes(prev => {
      const next = { ...prev };
      watch.forEach(sym => { if (!next[sym]) next[sym] = emptyQuote(); });
      return next;
    });
  }, [watch]);

  // Seed each chart with the last hour of real 5-minute bars (12 points) so the
  // board is not empty while the poll builds a series. A series from a quote
  // poll wins; history only fills the gap.
  React.useEffect(() => {
    if (!live) return undefined;
    let cancelled = false;
    const need = watch.filter(sym => !quotes[sym]?.series);
    if (!need.length) return undefined;
    Promise.all(need.map(sym => HelixAPI.history(marketOf(sym), '1d', '5m')
      .then(rows => ({ sym, rows })).catch(() => null)))
      .then(results => {
        if (cancelled) return;
        setQuotes(prev => {
          const next = { ...prev };
          for (const r of results) {
            if (!r || !r.rows?.length) continue;
            const cur = next[r.sym];
            if (cur?.series) continue;
            const closes = r.rows.slice(-12).map(b => b.close);
            next[r.sym] = {
              price: cur?.price ?? closes[closes.length - 1],
              chg: cur?.chg ?? null,   // only a real quote supplies the day change
              series: closes,
              state: cur?.state ?? null,
              gen: (cur?.gen || 0) + 1,
            };
          }
          return next;
        });
      });
    return () => { cancelled = true; };
  }, [watch, live]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live quotes through the shared query cache, folded into each tile's series.
  const board = useQuery(['watch-board', watch], () => fetchBoardQuotes(watch), { refreshMs: POLL_MS, enabled: live });
  React.useEffect(() => {
    const results = board.data;
    if (!live || !Array.isArray(results)) return;
    setQuotes(prev => {
      const next = { ...prev };
      for (const r of results) {
        if (!(r && r.q && r.q.price)) continue;
        const cur = next[r.sym];
        if (!cur) continue;
        if (r.q.market_state === 'CLOSED' && cur.series) {
          next[r.sym] = { ...cur, price: r.q.price, chg: r.q.change_pct ?? cur.chg, state: 'CLOSED' };
          continue;
        }
        const series = [...(cur.series || []).slice(-11), r.q.price];
        next[r.sym] = { price: r.q.price, chg: r.q.change_pct ?? cur.chg ?? null, series,
          state: r.q.market_state || null, gen: (cur.gen || 0) + 1 };
      }
      return next;
    });
  }, [board.updatedAt, live]); // eslint-disable-line react-hooks/exhaustive-deps

  return { quotes, loading: live && board.isLoading && !board.data };
};

export { useBoardQuotes };
