// "Add to history" wizard — the four step bodies (tables & periods, lines, checks, add).
// `h` is the context object built by history-wizard.jsx (preview, draft, answers and setters).

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { Badge, Button, LxSegmented, LxSelect, cx } from '../../ui';
import { HISTORY_KIND_NAMES, HISTORY_KIND_OPTIONS, HISTORY_UNIT_OPTIONS, historyMisreadKey, historyMoney, historyPeriodOptions, historyPeriodText, historyPeriodValue, historyRowKey, historyTableKey } from './ocr-inbox-utils.js';

const TONE = { muted: 'neutral', warn: 'warn', neg: 'neg', pos: 'pos', accent: 'accent' };
const HistoryBadge = ({ tone = 'muted', children }) => <Badge tone={TONE[tone] || 'neutral'} sans>{children}</Badge>;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const Blocks = ({ list }) => list.map((b, i) => <p key={i} role="alert" className="ocr-hist-block">{b.message}</p>);

const ScanLink = ({ h, page, label = `Open page ${page}`, className = 'card-action' }) => <a className={className} href={HelixAPI.ocrInboxPageUrl(h.item.id, page)} target="_blank" rel="noreferrer">{label}</a>;

const StepStatus = ({ h, open }) => <div aria-live="polite" className={cx('ocr-hist-status', h.error ? 'is-error' : open ? 'is-open' : null)}>
  {h.error ? h.error : h.loading ? 'Updating…' : h.preview ? (open ? `${plural(open, 'open question')} on this step` : 'Nothing open on this step') : ''}
</div>;

// ── step 1: tables & periods ──
const HistoryColumn = ({ h, t, c }) => {
  const answer = h.columnAnswer(t, c.column);
  const editKey = `${t.page}:${t.table}:${c.column}`;
  const tone = c.skipped ? 'muted' : !c.period ? 'neg' : c.period_source === 'relative' ? 'warn' : c.period_source === 'answer' ? 'accent' : 'pos';
  const badge = c.skipped ? 'skipped' : !c.period ? 'unknown — set it' : c.period_source === 'relative' ? 'proposed — confirm' : c.period_source === 'answer' ? 'set by you' : 'from header';
  const text = historyPeriodText(c.period);
  const showSelect = !c.period || h.editingColumns[editKey] || c.period_source === 'relative';
  return <div className="ocr-hist-sub">
    <div className="ocr-hist-row">
      <span className="ocr-hist-colname" title={c.header}>{c.header || `Column ${c.column}`}</span>
      <HistoryBadge tone={tone}>{badge}</HistoryBadge>
    </div>
    {c.period && !c.skipped && !showSelect && <div className="ocr-hist-period">{text.label} <span className="ocr-muted">{text.hint}</span></div>}
    {showSelect && !c.skipped && <div className="ocr-hist-gap">
      <LxSelect ariaLabel={`Period of column ${c.header || c.column}`} value={historyPeriodValue(c.period)} placeholder="Choose the period"
        options={historyPeriodOptions(h.item.labels?.fiscal_year, c.period)} onChange={value => h.pickPeriod(t, c, value)} />
    </div>}
    <div className="ocr-hist-row ocr-hist-gap">
      {c.period_source === 'relative' && !c.skipped && <Button size="sm" variant="primary" onClick={() => h.setColumn(t, c.column, { period_type: c.period.type, period_start: c.period.start, period_end: c.period.end })}>Confirm {text.label}</Button>}
      {c.period && c.period_source === 'header' && !h.editingColumns[editKey] && <button type="button" className="card-action" onClick={() => h.setEditingColumns(x => ({ ...x, [editKey]: true }))}>Change</button>}
      {!c.skipped && <button type="button" className="card-action" onClick={() => h.setColumn(t, c.column, { skip: true })}>Skip column</button>}
      {answer && <button type="button" className="card-action" onClick={() => h.setColumn(t, c.column, null)}>Undo</button>}
    </div>
  </div>;
};

const HistoryTable = ({ h, t }) => {
  const answer = h.draft.tables[historyTableKey(t.page, t.table)] || {};
  const blocks = h.blocksFor(t.page, t.table).filter(b => !['column_period_unknown', 'period_unconfirmed', 'table_kind_unknown', 'kind_unconfirmed'].includes(b.code));
  const sample = t.rows.slice(0, 3).map(r => r.label).filter(Boolean).join(' · ');
  const used = t.kind && t.kind !== 'skip';
  return <div className="ocr-hist-card">
    <div className="ocr-hist-row">
      <strong className="ocr-hist-title">Page {t.page} · table {t.table}</strong>
      {h.tableNeedsAnswer(t) ? <HistoryBadge tone="neg">needs an answer</HistoryBadge> : <HistoryBadge tone={used ? 'pos' : 'muted'}>{used ? 'ready' : HISTORY_KIND_NAMES[t.kind] || 'skipped'}</HistoryBadge>}
      <span className="ocr-grow" /><ScanLink h={h} page={t.page} />
    </div>
    {sample && <div className="ocr-muted ocr-hist-sample" title={sample}>{t.rows.length} rows · {sample}</div>}
    <div className="ocr-hist-grid">
      <div>
        <LxSelect label={answer.kind ? (answer.kind === t.proposed_kind ? 'Statement kind · confirmed' : 'Statement kind · set by you') : t.proposed_kind ? 'Statement kind · proposed from the heading' : 'Statement kind'}
          value={t.kind} placeholder="Choose the kind" options={HISTORY_KIND_OPTIONS} onChange={value => h.updateTable(t, { kind: value })} />
        {h.kindUnconfirmed(t) && <div className="ocr-hist-row ocr-hist-gap">
          <HistoryBadge tone="warn">proposed — confirm</HistoryBadge>
          <Button size="sm" variant="primary" onClick={() => h.confirmKinds([t])}>Confirm {HISTORY_KIND_NAMES[t.kind]}</Button>
          <button type="button" className="card-action" onClick={() => h.updateTable(t, { kind: 'skip' })}>Skip table</button>
        </div>}
      </div>
      {used && <LxSelect label={answer.unit_multiplier ? 'Unit · set by you' : t.proposed_unit_multiplier && t.unit_multiplier === t.proposed_unit_multiplier ? 'Unit · read from the page' : 'Unit'}
        value={t.unit_multiplier} placeholder="Choose the unit" options={HISTORY_UNIT_OPTIONS} onChange={value => h.updateTable(t, { unit_multiplier: Number(value) })} />}
    </div>
    {used && t.columns.length > 0 && <div>{t.columns.map(c => <HistoryColumn key={c.column} h={h} t={t} c={c} />)}</div>}
    {used && !t.columns.length && <p className="ocr-hist-block">No value columns were found in this table.</p>}
    <Blocks list={blocks} />
  </div>;
};

const tablesStep = h => <>
  <StepStatus h={h} open={h.tableBlocking.length} />
  {h.globalBlock && <div role="alert" className="ocr-hist-card is-bad">
    <div className="ocr-hist-global">{h.globalBlock.message}</div>
    {h.globalBlock.code === 'labels_missing' && <Button variant="primary" className="ocr-hist-gap" onClick={h.onOpenLabels}>Set upload labels</Button>}
  </div>}
  {!h.globalBlock && h.preview && <>
    <div className="ocr-hist-row ocr-hist-toolbar">
      <LxSegmented ariaLabel="Which tables to show" value={h.filter} onChange={h.setFilter}
        options={[{ value: 'used', label: `Used (${h.usedTables.length})` }, { value: 'open', label: `Open (${h.tables.filter(h.tableNeedsAnswer).length})` }, { value: 'all', label: `All (${h.tables.length})` }]} />
      {h.shownUnconfirmed.length > 0 && <Button size="sm" onClick={() => h.confirmKinds(h.shownUnconfirmed)}>Confirm all shown ({plural(h.shownUnconfirmed.length, 'proposed kind')})</Button>}
      {h.kindlessCount > 0 && <Button size="sm" onClick={h.skipKindless}>Skip {plural(h.kindlessCount, 'table')} with no statement heading</Button>}
    </div>
    {h.shownTables.length ? h.shownTables.map(t => <HistoryTable key={`${t.page}:${t.table}`} h={h} t={t} />) : <p className="ocr-muted ocr-hist-note">{h.filter === 'open' ? 'Every table is answered.' : 'No tables here.'}</p>}
  </>}
</>;

// ── step 2: lines ──
const LineQuestion = ({ h, t, r }) => {
  const answer = h.draft.lines[historyRowKey(t.page, t.table, r.row)];
  const isNew = !!answer && !answer.line_key;
  const value = answer?.line_key || (isNew ? '__new__' : '');
  const options = [
    ...r.suggestions.map(s => ({ value: s.line_key, label: `Same as ${s.line_name}`, hint: `${Math.round(s.score * 100)}% similar` })),
    { value: '__new__', label: 'New line', hint: r.label || 'you name it' },
  ];
  return <div className="ocr-hist-sub">
    <div className="ocr-hist-linelabel">{r.code ? <span className="num ocr-muted ocr-hist-code">{r.code}</span> : null}{r.label || <em className="ocr-muted">row without a label</em>}</div>
    <div className="ocr-muted ocr-hist-lineinfo">{r.parent_label ? `under ${r.parent_label} · ` : ''}row {r.row} · {r.cells.filter(Boolean).slice(0, 2).join(' / ')}</div>
    <LxSelect ariaLabel={`Line for ${r.label || `row ${r.row}`}`} value={value} placeholder="Existing line or new?" options={options} onChange={v => h.setLine(t, r, v)} />
    {isNew && <label className="ocr-field ocr-hist-gap">Name of the new line
      <input className={cx('ocr-input', !(answer.new_line_name || '').trim() && 'is-invalid')} value={answer.new_line_name || ''} onChange={e => h.setLineName(t, r, e.target.value)} placeholder="e.g. Tổng thu nhập hoạt động" />
    </label>}
  </div>;
};

const LinesTable = ({ h, t }) => {
  const asked = t.rows.filter(r => r.status === 'unknown' || h.draft.lines[historyRowKey(t.page, t.table, r.row)]);
  const matched = t.rows.filter(r => r.status === 'matched' && !h.draft.lines[historyRowKey(t.page, t.table, r.row)]);
  const skipped = t.rows.filter(r => r.status === 'skipped');
  const unreadable = t.rows.filter(r => r.unreadable_cells?.length);
  const columnName = c => t.columns.find(col => col.column === c)?.header || `column ${c}`;
  return <div className="ocr-hist-card">
    <div className="ocr-hist-row">
      <strong className="ocr-hist-title">{HISTORY_KIND_NAMES[t.kind]} · page {t.page}</strong>
      <HistoryBadge tone="pos">{matched.length} matched</HistoryBadge>
      {asked.length > 0 && <HistoryBadge tone={asked.some(r => r.status === 'unknown') ? 'neg' : 'accent'}>{asked.length} to answer</HistoryBadge>}
      <span className="ocr-grow" /><ScanLink h={h} page={t.page} />
    </div>
    {unreadable.length > 0 && <div role="note" className="ocr-hist-unreadable">
      <strong>Not stored — cells that could not be read:</strong>
      {unreadable.map(r => <div key={r.row}>{r.label || `row ${r.row}`} (row {r.row}): {r.unreadable_cells.map(columnName).join(', ')}</div>)}
      <div>Correct the page in the review if these values matter.</div>
    </div>}
    {asked.map(r => <LineQuestion key={r.row} h={h} t={t} r={r} />)}
    {skipped.length > 0 && <details className="ocr-more">
      <summary>{plural(skipped.length, 'row')} skipped</summary>
      {skipped.map(r => <div key={r.row} className="ocr-hist-skipped">{r.label || `row ${r.row}`} <span className="ocr-muted">— skipped: {r.skip_reason}</span></div>)}
    </details>}
  </div>;
};

const linesStep = h => <>
  <StepStatus h={h} open={h.lineBlocking.length} />
  {h.unknownRows.length > 0 && <div className="ocr-hist-row ocr-hist-toolbar">
    <span className="ocr-hist-note">{plural(h.unknownRows.length, 'row')} not yet in this company's history.</span>
    {h.namedUnknownRows.length > 0 && <Button size="sm" onClick={h.newLinesForAll}>Make {plural(h.namedUnknownRows.length, 'new line')} from their labels</Button>}
  </div>}
  {!h.usedTables.length && <p className="ocr-muted ocr-hist-note">No statement tables are used. Go back and choose a statement kind.</p>}
  {h.usedTables.map(t => <LinesTable key={`${t.page}:${t.table}`} h={h} t={t} />)}
</>;

// ── step 3: checks ──
const checksStep = h => <>
  <StepStatus h={h} open={h.checkBlocking.length} />
  {!h.misreads.length && !h.conflicts.length && <p className="ocr-muted ocr-hist-note">No subtotal problems and no disagreement with values already in the history.</p>}
  {h.misreads.length > 0 && <h5 className="ocr-hist-h">Subtotals that do not add up ({h.misreads.length})</h5>}
  {h.misreads.map(m => {
    const accepted = !!h.draft.misreads[historyMisreadKey(m)] || m.accepted;
    return <div key={historyMisreadKey(m)} className="ocr-hist-card">
      <div className="ocr-hist-row">
        <strong className="ocr-hist-title is-sm">Page {m.page} · table {m.table} · row {m.parent_row}</strong>
        <HistoryBadge tone={accepted ? 'pos' : 'neg'}>{accepted ? 'correct as printed' : 'likely misread'}</HistoryBadge>
      </div>
      <p className="ocr-hist-text">“{m.parent_label}” ({m.column_label}) shows {m.parent} but its rows add up to {m.children_sum} — off by {m.difference}.</p>
      <div className="ocr-hist-row">
        <ScanLink h={h} page={m.page} label="Open page" className="btn btn-sm" />
        <Button size="sm" variant={accepted ? 'primary' : 'secondary'} aria-pressed={accepted} onClick={() => h.toggleMisread(m)}>Value correct as printed</Button>
      </div>
    </div>;
  })}
  {h.conflicts.length > 0 && <h5 className="ocr-hist-h is-spaced">Values that disagree with the history ({h.conflicts.length})</h5>}
  {h.conflicts.map(c => {
    const chosen = h.draft.resolutions[c.fact_key];
    const options = [
      { value: 'open', label: 'Leave open', hint: 'decide later on the history page' },
      ...c.existing.map(e => ({ value: e.fact_id, label: historyMoney(e.value), hint: `${e.filename} · page ${e.page ?? '—'}${e.origin === 'calculated' ? ' · calculated' : ''}` })),
      { value: 'incoming', label: historyMoney(c.incoming.value), hint: `this document · page ${c.incoming.page}, row ${c.incoming.row}` },
    ];
    const period = historyPeriodText(c.period);
    return <div key={c.fact_key} className="ocr-hist-card">
      <div className="ocr-hist-row">
        <strong className="ocr-hist-title is-sm">{c.line_name}</strong><HistoryBadge tone={chosen ? 'accent' : 'warn'}>{chosen ? 'source chosen' : 'open conflict'}</HistoryBadge>
      </div>
      <div className="ocr-muted ocr-hist-lineinfo">{HISTORY_KIND_NAMES[c.statement_kind]} · {period.label} ({period.hint})</div>
      <LxSelect label="Which source is right?" value={chosen === undefined ? 'open' : chosen} options={options} onChange={v => h.setResolution(c.fact_key, v)} />
    </div>;
  })}
</>;

// ── step 4: add ──
const addStep = h => {
  const { item, remaining } = h;
  return <div className="u042-done">
    {remaining.length
      ? <span role="img" aria-label="Open questions" className="ocr-hist-bang">!</span>
      : <span className="u042-big"><svg viewBox="0 0 34 34"><path d="M9 17.5l5.5 5.5L25.5 12" /></svg></span>}
    <h4>{remaining.length ? 'Some questions are still open' : 'Ready to add to history'}</h4>
    <p className="ocr-muted ocr-hist-summary">
      {item.labels?.ticker} · {item.labels?.scope} · {item.labels?.period_code} {item.labels?.fiscal_year}<br />
      {plural(h.usedTables.length, 'statement table')} · {h.matchedRows} rows ({plural(h.newLines, 'new line')})<br />
      {plural(h.misreads.length, 'subtotal check')} · {plural(h.openConflicts, 'conflict')} left open
    </p>
    <Blocks list={remaining.slice(0, 5)} />
    <StepStatus h={h} open={remaining.length} />
  </div>;
};

export { tablesStep, linesStep, checksStep, addStep };
