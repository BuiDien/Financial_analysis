// Statements tab with data: company history from verified OCR statements. Filters (company,
// period range, grain, chart view, picked lines), the charts, the statement table and the
// source side panel.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { Button, EmptyState, ErrorState, GrowthChart, Segmented, Select, SidePanel, SmallMultiples, TagInput, toast } from '../../ui';
import {
  HX_KIND, HX_MAX_LINES, HX_SCOPE, HX_SLOTS, hxDate, hxPeriodRun, hxStore, hxTy, hxTyRaw, hxXLabel,
} from './statements-format.js';
import { StatementsTable } from './StatementsTable.jsx';
import { SourceBody } from './SourceBody.jsx';
import { StatementsShell, hxAddStatement } from './StatementsShell.jsx';

const Field = ({ label, className, children }) => (
  <div className={className ? `co-field ${className}` : 'co-field'}>
    <span className="co-field-label">{label}</span>
    {children}
  </div>
);

const CompanyHistory = ({ companies, wanted = null, setPage }) => {
  const options = React.useMemo(() => companies.map(c => ({
    value: `${c.ticker}|${c.scope}`,
    label: `${c.ticker} · ${HX_SCOPE[c.scope] || c.scope}`,
    hint: `${c.documents} document${c.documents === 1 ? '' : 's'} · to ${hxDate(c.last_period_end)}`,
  })), [companies]);
  const [company, setCompany] = React.useState(() => {
    const byHint = wanted && options.find(o => o.value.startsWith(`${wanted}|`));
    const saved = hxStore.get('hx_history_company');
    return (byHint || options.find(o => o.value === saved) || options[0]).value;
  });
  const [ticker, scope] = company.split('|');
  const storeKey = `hx_history_lines_${ticker}_${scope}`;

  const [catalog, setCatalog] = React.useState([]);
  const [picked, setPicked] = React.useState([]); // [{key, slot}]
  const [grain, setGrain] = React.useState('quarter');
  const [view, setView] = React.useState('small');
  const [range, setRange] = React.useState({ from: '', to: '' });
  const [data, setData] = React.useState(null); // series lines, in API order
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [reload, setReload] = React.useState(0);
  const [panel, setPanel] = React.useState(null); // {key, factKey}
  const [busy, setBusy] = React.useState(false);
  const [showTable, setShowTable] = React.useState(true);
  const seq = React.useRef(0);

  // Line catalogue for this company and scope; restore the last picks (and their colours).
  React.useEffect(() => {
    let alive = true;
    hxStore.set('hx_history_company', company);
    setCatalog([]); setData(null); setPanel(null); setRange({ from: '', to: '' });
    const saved = hxStore.get(storeKey);
    setPicked(Array.isArray(saved) ? saved.filter(p => p && p.key && p.slot >= 0 && p.slot < HX_MAX_LINES) : []);
    HelixAPI.historyLines(ticker, scope)
      .then(list => {
        if (!alive) return;
        setCatalog(list || []);
        const keys = new Set((list || []).map(l => l.key));
        setPicked(cur => cur.filter(p => keys.has(p.key)));
      })
      .catch(e => { if (alive) { setError(e.message); toast(`Could not load lines: ${e.message}`, { type: 'error' }); } });
    return () => { alive = false; };
  }, [company]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => { hxStore.set(storeKey, picked); }, [picked, storeKey]);

  const pickedKeys = picked.map(p => p.key).join(',');
  React.useEffect(() => {
    if (!pickedKeys) { setData(null); setLoading(false); return; }
    const mine = ++seq.current;
    setLoading(true); setError('');
    HelixAPI.historySeries(ticker, scope, { lines: pickedKeys.split(','), grain })
      .then(res => { if (mine === seq.current) setData(res.lines || []); })
      .catch(e => {
        if (mine !== seq.current) return;
        setError(e.message);
        toast(`Could not load the history: ${e.message}`, { type: 'error' });
      })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [ticker, scope, pickedKeys, grain, reload]);

  const byKey = React.useMemo(() => new Map(catalog.map(l => [l.key, l])), [catalog]);
  const lineOf = key => (data || []).find(l => l.key === key) || null;
  const nameOf = key => lineOf(key)?.name || byKey.get(key)?.name || key;
  // Mã số, when the line catalogue carries one (optional field; "—" otherwise).
  const codeOf = React.useCallback(key => lineOf(key)?.code || byKey.get(key)?.code || null, [data, byKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const addLine = (s) => setPicked(cur => {
    if (cur.length >= HX_MAX_LINES || cur.some(p => p.key === s.key)) return cur;
    const used = new Set(cur.map(p => p.slot));
    const slot = HX_SLOTS.findIndex((_, i) => !used.has(i));
    return [...cur, { key: s.key, slot }];
  });
  const removeLine = (key) => {
    setPicked(cur => cur.filter(p => p.key !== key));
    if (panel && panel.key === key) setPanel(null);
  };

  // The x axis is the full consecutive run of periods for the grain (every quarter end, or
  // every 31/12) from the earliest to the latest point, so time is spaced evenly and a period
  // no picked line has stays an empty slot instead of dropping out of the axis.
  const allXs = React.useMemo(() => {
    const set = new Set();
    (data || []).forEach(l => l.points.forEach(p => set.add(p.period_end)));
    const have = [...set].sort();
    if (!have.length) return [];
    const run = hxPeriodRun(have[0], have[have.length - 1], grain);
    have.forEach(x => { if (!run.includes(x)) run.push(x); }); // off-grid dates are kept, never dropped
    return run.sort();
  }, [data, grain]);
  const from = range.from && allXs.includes(range.from) ? range.from : allXs[0];
  const to = range.to && allXs.includes(range.to) ? range.to : allXs[allXs.length - 1];
  const xs = allXs.filter(x => x >= from && x <= to);
  const fmtX = React.useCallback(x => hxXLabel(String(x), grain), [grain]);

  const series = picked.map(p => {
    const line = lineOf(p.key);
    return {
      key: p.key, name: nameOf(p.key), color: HX_SLOTS[p.slot], kind: line?.kind || byKey.get(p.key)?.kind,
      points: (line ? line.points : []).filter(q => q.period_end >= from && q.period_end <= to)
        .map(q => ({ x: q.period_end, y: q.value, status: q.status, origin: q.origin, raw: q })),
    };
  }).filter(s => lineOf(s.key));

  const suggestions = React.useMemo(() => catalog.map(l => ({ key: l.key, label: l.name })), [catalog]);
  const items = picked.map(p => ({ key: p.key, label: nameOf(p.key), color: HX_SLOTS[p.slot] }));
  const rangeOptions = allXs.map(x => ({ value: x, label: fmtX(x), hint: hxDate(x) }));

  // Source panel: the clicked point, with J / K (or the arrows) stepping through that line.
  const panelLine = panel ? series.find(s => s.key === panel.key) : null;
  const panelIdx = panelLine ? panelLine.points.findIndex(q => q.raw.fact_key === panel.factKey) : -1;
  const panelPoint = panelIdx >= 0 ? panelLine.points[panelIdx].raw : null;
  const openPoint = React.useCallback((s, p) => setPanel({ key: s.key, factKey: p.raw.fact_key }), []);
  const stepPanel = d => {
    const next = panelLine && panelLine.points[panelIdx + d];
    if (next) setPanel({ key: panelLine.key, factKey: next.raw.fact_key });
  };

  const choose = async (src) => {
    if (!panelLine || !panelPoint) return;
    setBusy(true);
    try {
      await HelixAPI.historyResolve(ticker, scope, { statement_kind: panelLine.kind, fact_key: panelPoint.fact_key, chosen_fact_id: src.fact_id });
      toast(`Using ${hxTy(src.value)} tỷ from ${src.filename || 'the calculation'}`, { type: 'success' });
      setReload(n => n + 1);
    } catch (e) {
      toast(`Could not save the choice: ${e.message}`, { type: 'error' });
    } finally { setBusy(false); }
  };

  const copyTable = async () => {
    const head = ['Period', ...series.map(s => `${s.name} (tỷ đồng)`)].join('\t');
    const rows = xs.map(x => [fmtX(x), ...series.map(s => {
      const q = s.points.find(p => p.x === x);
      if (!q) return '';
      return q.status === 'conflict' ? 'sources differ' : hxTyRaw(q.y);
    })].join('\t'));
    try {
      await navigator.clipboard.writeText([head, ...rows].join('\n'));
      toast('Table copied', { type: 'success' });
    } catch {
      toast('Copy is blocked in this browser — select the table instead', { type: 'error' });
    }
  };

  const conflicts = series.reduce((n, s) => n + s.points.filter(p => p.status === 'conflict').length, 0);
  const title = `${ticker} · ${HX_SCOPE[scope] || scope}`;

  return (
    <StatementsShell sub="Company history from verified OCR statements · values in tỷ đồng"
      action={<Button variant="primary" icon="plus" onClick={() => hxAddStatement(ticker, setPage)}>Add statement</Button>}>
      {/* Filters: one block above everything they scope. */}
      <div className="co-filters">
        <Field label="Company · scope" className="is-company">
          <Select value={company} options={options} onChange={setCompany} ariaLabel="Company and scope" />
        </Field>
        <Field label="From" className="is-period">
          <Select value={from || ''} options={rangeOptions.filter(o => !to || o.value <= to)} placeholder="—"
            disabled={!allXs.length} ariaLabel="From period" onChange={v => setRange(r => ({ ...r, from: v }))} />
        </Field>
        <Field label="To" className="is-period">
          <Select value={to || ''} options={rangeOptions.filter(o => !from || o.value >= from)} placeholder="—"
            disabled={!allXs.length} ariaLabel="To period" onChange={v => setRange(r => ({ ...r, to: v }))} />
        </Field>
        <Field label="Periods">
          <Segmented value={grain} ariaLabel="Quarter or year"
            options={[{ value: 'quarter', label: 'Quarter' }, { value: 'year', label: 'Year' }]}
            onChange={g => { setGrain(g); setRange({ from: '', to: '' }); setPanel(null); }} />
        </Field>
        <Field label="View">
          <Segmented value={view} ariaLabel="Chart view"
            options={[{ value: 'small', label: 'Small charts' }, { value: 'growth', label: 'Growth (start = 100)' }]}
            onChange={setView} />
        </Field>
        <Field label={`Lines · ${picked.length} / ${HX_MAX_LINES}`} className="is-wide">
          <TagInput items={items} suggestions={suggestions} onAdd={addLine} onRemove={removeLine}
            max={HX_MAX_LINES} maxMessage={`Up to ${HX_MAX_LINES} lines`} ariaLabel="Add a line" idleSuggestions={picked.length ? 0 : 8}
            placeholder={catalog.length ? 'Search lines, e.g. “tổng tài sản”, press Enter' : 'Loading lines…'} />
        </Field>
      </div>

      {!picked.length && (
        <EmptyState title="Pick lines to compare"
          description={`Search the line catalogue above and add up to ${HX_MAX_LINES} lines. Each line keeps its colour while it is on screen.`} />
      )}
      {picked.length > 0 && !data && loading && <EmptyState plain title="Loading the history…" description={`Reading the verified facts for ${ticker}.`} />}
      {picked.length > 0 && !data && !loading && error && (
        <ErrorState title="The history could not be loaded" message={error} onRetry={() => { setReload(n => n + 1); return Promise.resolve(); }} />
      )}

      {picked.length > 0 && data && (
        <div className={loading ? 'co-st-body is-loading' : 'co-st-body'} aria-busy={loading ? 'true' : 'false'}>
          {!xs.length ? (
            <EmptyState plain title="No values in this range"
              description={grain === 'year' ? 'Year view shows full-year values and year-end balances only.' : 'Quarter view shows quarters and balance dates; year-to-date values are never plotted.'} />
          ) : view === 'small' ? (
            <SmallMultiples series={series} xs={xs} formatX={fmtX} formatValue={v => hxTy(v)} title={`${title} · tỷ đồng`} onPointClick={openPoint} />
          ) : (
            <GrowthChart series={series} xs={xs} formatX={fmtX} formatValue={v => `${hxTy(v)} tỷ`} title={`${title} · growth, first period = 100`} onPointClick={openPoint} />
          )}

          <div className="co-st-legend">
            <span><b>●</b> printed</span>
            <span><b>○</b> calculated</span>
            <span className="co-neg"><b>◯</b> ⚠ sources differ{conflicts ? ` (${conflicts} open)` : ''}</span>
            <span>Click a point for its source.</span>
            <span className="co-spacer" />
            <Button size="sm" aria-expanded={showTable} aria-controls="hx-table" onClick={() => setShowTable(v => !v)}>
              {showTable ? 'Hide table' : 'Show table'}
            </Button>
          </div>

          {showTable && xs.length > 0 && (
            <StatementsTable series={series} xs={xs} fmtX={fmtX} codeOf={codeOf} onOpenPoint={openPoint} onCopy={copyTable} />
          )}
        </div>
      )}

      <SidePanel open={!!panelPoint} onClose={() => setPanel(null)}
        title={panelLine ? panelLine.name : ''}
        subtitle={panelLine ? `${HX_KIND[panelLine.kind] || panelLine.kind} · ${ticker} · ${HX_SCOPE[scope] || scope}` : ''}
        indexLabel={panelLine ? `${panelIdx + 1} / ${panelLine.points.length}` : ''}
        contentKey={panel ? panel.factKey : ''}
        onPrev={panelIdx > 0 ? () => stepPanel(-1) : undefined}
        onNext={panelLine && panelIdx < panelLine.points.length - 1 ? () => stepPanel(1) : undefined}>
        {panelPoint && <SourceBody point={panelPoint} busy={busy} onChoose={choose} />}
      </SidePanel>
    </StatementsShell>
  );
};

export { CompanyHistory };
