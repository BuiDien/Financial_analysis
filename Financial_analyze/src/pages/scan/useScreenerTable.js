// Screener results table model: which rule columns to show, the row order (bounce candidates
// first, then the chosen sort, blanks last), plain-language tooltips and CSV export.
// DataTable only displays: each column's sortValue returns the row's precomputed position.

import React from 'react';
import * as SP from './screener-plain.js';
import { toast } from '../../ui/index.js';
import { SCR_COLS, SCR_OVER, scrFmt } from './screener-model.js';

export const useScreenerTable = (result, catalog) => {
  const [sort, setSort] = React.useState({ key: 'strength', dir: 'desc' });
  const rows = result ? result.rows : [];
  const goodIds = rows.length ? Object.keys(SCR_COLS).filter(id => !SCR_OVER.includes(id) && rows[0].rules[id]) : [];
  const overIds = rows.length ? SCR_OVER.filter(id => rows[0].rules[id]) : [];

  const headerOf = (id) => (SP.PLAIN[id] ? SP.PLAIN[id].short : SCR_COLS[id][0]);
  const labelOf = (id) => (SP.PLAIN[id] ? SP.PLAIN[id].name : catalog && catalog[id] ? catalog[id].label : id);
  const tipOf = (id) => (SP.PLAIN[id] ? `${SP.PLAIN[id].name} — ${SP.PLAIN[id].help}` : labelOf(id));

  const sortVal = (r, key) => key === 'strength' ? r.strength : key === 'symbol' ? r.symbol
    : (r.rules[key] && !SP.isNotApplicable(r.rules[key]) ? r.rules[key].value : null);
  const ordered = React.useMemo(() => {
    const sortRows = (list) => [...list].sort((x, y) => {
      const a = sortVal(x, sort.key), b = sortVal(y, sort.key);
      if (a === null || a === undefined) return (b === null || b === undefined) ? 0 : 1;   // blanks last
      if (b === null || b === undefined) return -1;
      const c = typeof a === 'string' ? a.localeCompare(b) : a - b;
      return sort.dir === 'asc' ? c : -c;
    });
    return [...sortRows(rows.filter(r => r.oversold === 'yes')), ...sortRows(rows.filter(r => r.oversold !== 'yes'))];
  }, [rows, sort]);
  const pos = React.useMemo(() => new Map(ordered.map((r, i) => [r.symbol, i])), [ordered]);
  // DataTable reverses for 'desc'; feed it the position so its order equals `ordered`.
  const posFor = () => (r) => (sort.dir === 'asc' ? pos.get(r.symbol) : -pos.get(r.symbol));
  // New column → descending first, except Ticker (A→Z).
  const onSortChange = (next) => setSort(sort.key === next.key
    ? { key: next.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
    : { key: next.key, dir: next.key === 'symbol' ? 'asc' : 'desc' });

  // Ticker tooltip: why this stock passed, in plain words.
  const whyOf = (r) => ['Why it passed:', ...goodIds.map((id) => {
    const c = r.rules[id];
    if (!c) return null;
    if (SP.isNotApplicable(c)) return `– ${labelOf(id)}: ${SP.NA_TIP.toLowerCase()}`;
    const how = c.score === null || c.score === undefined ? '' : c.score >= 50 ? ' (well above the bar)' : ' (just above the bar)';
    return `✓ ${labelOf(id)}: ${scrFmt(id, c.value)}${how}`;
  }).filter(Boolean), ...(r.oversold === 'yes' ? ['⚡ Price just dropped hard — possible bounce'] : [])].join('\n');

  const exportCSV = () => {
    const ids = [...goodIds, ...overIds];
    const q = v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
    const out = [['#', 'Ticker', 'Oversold', 'Strength', ...ids.map(headerOf)].map(q).join(',')];
    ordered.forEach((r, i) => out.push([i + 1, r.symbol, r.oversold, r.strength, ...ids.map(id => {
      if (SP.isNotApplicable(r.rules[id])) return 'n/a';
      const v = r.rules[id] ? r.rules[id].value : null;
      return v === null || v === undefined ? '' : v;
    })].map(q).join(',')));
    const url = URL.createObjectURL(new Blob([out.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'screener_results.csv'; a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} rows`, { type: 'success' });
  };

  return {
    rows, ordered, goodIds, overIds, sort, onSortChange, posFor, headerOf, labelOf, tipOf, whyOf, exportCSV,
    hotCount: rows.filter(r => r.oversold === 'yes').length,
  };
};
