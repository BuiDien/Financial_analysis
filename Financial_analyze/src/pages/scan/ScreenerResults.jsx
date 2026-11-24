// Screener results: freshness + refresh progress, the funnel counts, skipped list and the
// sortable results table (bounce candidates first). Clicking a ticker opens its company page.

import React from 'react';
import * as SP from './screener-plain.js';
import { Badge, Button, Card, DataTable, EmptyState, ProgressBar } from '../../ui/index.js';
import { formatNumber } from '../../lib/format.js';
import { SCR_FLAG_LABEL, fmtAge, fmtDate, scoreClass, scoreTone, scrFmt } from './screener-model.js';
import { useScreenerTable } from './useScreenerTable.js';

const RefreshStatus = ({ rstatus, result, evaluating }) => {
  const fresh = (result && result.freshness) || {};
  const pAsOf = rstatus ? rstatus.prices_as_of : fresh.prices_as_of;
  const fAsOf = rstatus ? rstatus.financials_as_of : fresh.financials_as_of;
  const kindWord = rstatus && rstatus.kind === 'financials' ? 'financials' : 'prices';
  const queued = (rstatus && rstatus.queued) || [];
  const pct = rstatus && rstatus.running && rstatus.total > 0 ? (rstatus.done / rstatus.total) * 100 : null;
  return (
    <div className="scan-fresh">
      <p className="scan-meta">
        <span>Prices as of {fmtAge(pAsOf)} · financials as of {fmtAge(fAsOf)}</span>
        <Badge tone="warn" outline data-tip="Broad-scan data is third-party (vnstock) and unverified — for screening only. Deep-dive a symbol to verify.">Unverified</Badge>
        {evaluating && <span className="scan-eval">Evaluating…</span>}
      </p>
      {rstatus && (rstatus.running || queued.length > 0) && (
        <ProgressBar size="sm" value={pct} status={rstatus.running ? 'running' : 'queued'}
          title={rstatus.running ? `Refreshing ${kindWord}` : `Refresh queued: ${queued.join(', ')}`}
          subtitle={rstatus.running && queued.length ? `then ${queued.join(', ')}` : undefined}
          meta={rstatus.running && rstatus.total > 0 ? `${formatNumber(rstatus.done)} / ${formatNumber(rstatus.total)}` : ''}
          ariaLabel="Screener data refresh" />
      )}
      {rstatus && rstatus.last_error && <p className="scan-meta scan-err">Last refresh error: {rstatus.last_error}</p>}
    </div>
  );
};

const Funnel = ({ counts, showSkipped, onToggleSkipped }) => (
  <div className="scan-funnel-row">
    <ol className="scan-funnel" aria-label="Screening funnel">
      <li><span>Whole market</span><b className="num">{formatNumber(counts.universe)}</b></li>
      <li><span>Pass every check</span><b className="num">{formatNumber(counts.passed)}</b></li>
      <li className="is-hot"><span>Bounce chance now ⚡</span><b className="num">{formatNumber(counts.oversold)}</b></li>
    </ol>
    {counts.skipped > 0 && (
      <Button size="sm" variant="ghost" aria-expanded={showSkipped} onClick={onToggleSkipped}>
        {formatNumber(counts.skipped)} skipped, missing data {showSkipped ? '▴' : '▾'}
      </Button>
    )}
  </div>
);

const TickerCell = ({ r, why }) => (
  <span className="scan-tk" title={why}>
    <span className="ticker">{r.symbol}</span>
    {r.flag && <Badge tone="neg" title="Exchange status (HOSE/HNX warning, control, restriction or suspension)">{SCR_FLAG_LABEL[r.flag] || r.flag}</Badge>}
    {r.note_latest_at && <span title={`Last note ${fmtDate(r.note_latest_at)}`} aria-label="Has notes">📝</span>}
    {r.oversold === 'yes' && <span className="scan-bolt" title="Price just dropped hard — possible bounce" aria-label="Bounce chance">⚡</span>}
    {r.oversold === 'missing' && <span className="scan-hint">no recent price data</span>}
  </span>
);

const ScreenerResults = ({ s, onOpen }) => {
  const { result, catalog, busy } = s;
  const [showSkipped, setShowSkipped] = React.useState(false);
  const t = useScreenerTable(result, catalog);
  const { rows, goodIds, overIds, labelOf } = t;

  const naCell = (id) => <span className="scan-na" title={`${labelOf(id)}: ${SP.NA_TIP.toLowerCase()}`}>n/a</span>;
  const ruleCol = (id, over) => ({
    key: id, numeric: true, label: <span title={t.tipOf(id)}>{t.headerOf(id)}</span>, headerTitle: t.tipOf(id),
    sortValue: t.posFor(id),
    render: (r) => {
      const c = r.rules[id];
      if (SP.isNotApplicable(c)) return naCell(id);
      if (over) return <span className={r.oversold === 'yes' ? 'scan-over-hot' : ''}>{scrFmt(id, c ? c.value : null)}</span>;
      const tone = scoreTone(c);
      return (
        <span className={scoreClass(c)}>
          {tone && <i className={`scan-dot is-${tone}`} title={tone === 'hi' ? 'Well above the bar' : 'Just above the bar'} />}
          {scrFmt(id, c ? c.value : null)}
        </span>
      );
    },
  });
  const columns = [
    { key: 'rank', label: '#', numeric: true, sortable: false, width: 40, render: (r, i) => <span className="scan-rank">{i + 1}</span> },
    { key: 'symbol', label: 'Ticker', sortValue: t.posFor('symbol'), render: (r) => <TickerCell r={r} why={t.whyOf(r)} /> },
    {
      key: 'strength', label: 'Score', numeric: true, sortValue: t.posFor('strength'),
      headerTitle: '0–100: how far past the bar the stock is, on average over all checks',
      render: (r) => (
        <span className="scan-score">
          <span className="scan-bar" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, r.strength))}%` }} /></span>
          {formatNumber(r.strength, 1)}
        </span>
      ),
    },
    ...goodIds.map(id => ruleCol(id, false)),
    ...overIds.map(id => ruleCol(id, true)),
  ];

  const emptyMarket = result && result.counts.universe === 0;
  const empty = emptyMarket ? (
    <EmptyState size="sm" title="No market data yet" description="Refresh prices and financials to start."
      action={<div className="scan-actions">
        <Button size="sm" disabled={busy} onClick={() => s.requestRefresh('financials')}>Refresh financials</Button>
        <Button size="sm" variant="primary" icon="sync" disabled={busy} onClick={() => s.requestRefresh('prices')}>Refresh prices</Button>
      </div>} />
  ) : (
    <EmptyState size="sm" title="No stock passes every check"
      description="Loosen the rules: try Easy under “How picky?”."
      action={s.active && s.level !== 'easy' ? { label: 'Try Easy', icon: null, onClick: () => s.setLevel('easy') } : undefined} />
  );

  return (
    <div className="scan-results">
      <RefreshStatus rstatus={s.rstatus} result={result} evaluating={s.evaluating} />
      <Funnel counts={result.counts} showSkipped={showSkipped} onToggleSkipped={() => setShowSkipped(!showSkipped)} />
      {showSkipped && (
        <div className="panel scan-skipped" role="region" aria-label="Skipped stocks">
          {(result.skipped || []).map(sk => (
            <div key={sk.symbol} className="scan-skip-row">
              <span className="ticker">{sk.symbol}</span>
              <span className="scan-hint">missing: {sk.missing.map(labelOf).join(' · ')}</span>
            </div>
          ))}
        </div>
      )}
      <Card flush title={`${formatNumber(rows.length)} passing`}
        subtitle={t.hotCount ? `${formatNumber(t.hotCount)} bounce candidates listed first` : undefined}
        actions={<Button size="sm" icon="download" onClick={() => t.exportCSV()} disabled={!rows.length}>Export</Button>}>
        <DataTable ariaLabel="Screener results" rows={t.ordered} rowKey="symbol" columns={columns}
          sort={t.sort} onSortChange={t.onSortChange} maxHeight={640} dense
          rowClassName={(r) => (r.oversold === 'yes' ? 'scan-hot' : undefined)}
          onRowClick={(r) => onOpen(r.symbol)} empty={empty} loading={s.evaluating && !rows.length && !emptyMarket} />
      </Card>
      <p className="scan-legend">
        Every stock here passed all the checks. Score = how far past the bar, 0–100.{' '}
        <i className="scan-dot is-hi" /> well above the bar · <i className="scan-dot is-lo" /> just above it.{' '}
        <i>n/a</i> = not applicable to this company type. ⚡ rows (price just dropped hard) stay on top.
        Hover a ticker to see why it passed, hover a column name for what it means, click a column to sort, click a row to open the company.
      </p>
    </div>
  );
};

export { ScreenerResults };
