// OCR Inbox — "Add to history" wizard. Split out of page-ocr-inbox.jsx; pure helpers
// live in ocr-inbox-utils.js (bound as globals by page-ocr-inbox.jsx).

// ── "Add to history" (company history from a verified Markdown review) ─────────
// Every answer re-posts history-preview; the server decides what still blocks. Code here never
// picks a period, unit, line or conflict value for the owner: options are listed, the owner chooses.

const HistoryBadge = ({ tone = 'muted', children }) => {
  const colors = { muted: 'var(--text-muted)', warn: 'var(--warn)', neg: 'var(--neg)', pos: 'var(--pos)', accent: 'var(--accent)' };
  const c = colors[tone] || colors.muted;
  return <span style={{ display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, color: c, background: `color-mix(in srgb, ${c} 13%, transparent)`, whiteSpace: 'nowrap' }}>{children}</span>;
};
const historyCard = { border: '1px solid var(--ux-line-2)', borderRadius: 16, padding: 14, marginBottom: 12, background: 'var(--ux-surface)' };
const historyBlockText = { margin: '8px 0 0', fontSize: 12, color: 'var(--neg)' };

const OCRHistoryWizard = ({ item, review, draft, setDraft, onClose, onWritten, onOpenLabels }) => {
  const [preview, setPreview] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [writing, setWriting] = React.useState(false);
  const [filter, setFilter] = React.useState('used');
  const [editingColumns, setEditingColumns] = React.useState({});
  const [touched, setTouched] = React.useState({}); // tables answered here stay listed under "Open"
  const dialogRef = React.useRef(null);
  const seq = React.useRef(0);

  // Re-post the preview on every answer (debounced so quick clicks share one request).
  React.useEffect(() => {
    const id = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const next = await window.HelixAPI.historyPreview(review.id, historyPayload(draft, review.revision));
        if (id !== seq.current) return;
        setPreview(next); setError('');
        // A conflict choice only means something while that conflict exists: an answer elsewhere
        // (period, line, kind) can make a fact_key disappear, so drop choices for keys no longer listed.
        const live = new Set((next.conflicts || []).map(c => c.fact_key));
        setDraft(d => {
          const stale = Object.keys(d.resolutions).filter(key => !live.has(key));
          if (!stale.length) return d;
          const resolutions = { ...d.resolutions };
          stale.forEach(key => { delete resolutions[key]; });
          return { ...d, resolutions };
        });
      } catch (e) {
        if (id !== seq.current) return;
        setError(e.message || 'Could not prepare the history preview');
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [draft, review.id, review.revision]);

  React.useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.focus({ preventScroll: true });
    return () => { if (opener && opener.isConnected) opener.focus?.({ preventScroll: true }); };
  }, []);
  const onDialogKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(dialogRef.current.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter(el => el.offsetParent !== null && !el.closest('[inert]') && !el.closest('[aria-hidden="true"]'));
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const blocking = preview?.blocking || [];
  const tables = preview?.tables || [];
  const usedTables = tables.filter(t => t.kind && t.kind !== 'skip');
  // Year-less headers are proposals from the labelled year: the owner confirms each one.
  const unconfirmed = usedTables.flatMap(t => t.columns
    .filter(c => !c.skipped && c.period_source === 'relative')
    .map(c => ({ code: 'period_unconfirmed', page: t.page, table: t.table, column: c.column, message: `Confirm the proposed period of column ${c.header || c.column}` })));
  // A kind proposed from the page heading is only a proposal (spec §6.3): the owner confirms it per table
  // (sent back as an explicit `kind` answer) or picks another kind / Skip.
  const kindUnconfirmed = t => !!t.proposed_kind && t.kind === t.proposed_kind && !draft.tables[historyTableKey(t.page, t.table)]?.kind;
  const unconfirmedKinds = tables.filter(kindUnconfirmed)
    .map(t => ({ code: 'kind_unconfirmed', page: t.page, table: t.table, message: `Confirm that page ${t.page} table ${t.table} is a ${HISTORY_KIND_NAMES[t.kind].toLowerCase()}, or skip it` }));
  const tableBlocking = [...blocking.filter(b => HISTORY_TABLE_CODES.has(b.code)), ...unconfirmedKinds, ...unconfirmed];
  const lineBlocking = blocking.filter(b => b.code === 'line_unanswered');
  const checkBlocking = blocking.filter(b => b.code === 'misread_unaccepted');
  const otherBlocking = blocking.filter(b => !HISTORY_TABLE_CODES.has(b.code) && !['line_unanswered', 'misread_unaccepted'].includes(b.code));
  const blocksFor = (page, table) => tableBlocking.filter(b => b.page === page && b.table === table);
  const globalBlock = blocking.find(b => b.code === 'review_not_verified' || b.code === 'labels_missing');
  const ready = !!preview && !loading && !error;

  const touch = t => setTouched(x => ({ ...x, [historyTableKey(t.page, t.table)]: true }));
  const updateTable = (t, patch) => { touch(t); setDraft(d => {
    const key = historyTableKey(t.page, t.table);
    const prev = d.tables[key] || { columns: {} };
    return { ...d, tables: { ...d.tables, [key]: { ...prev, ...patch, columns: { ...(prev.columns || {}), ...(patch.columns || {}) } } } };
  }); };
  const setColumn = (t, column, answer) => { touch(t); setDraft(d => {
    const key = historyTableKey(t.page, t.table);
    const prev = d.tables[key] || { columns: {} };
    const columns = { ...(prev.columns || {}) };
    if (answer) columns[column] = { column, ...answer }; else delete columns[column];
    return { ...d, tables: { ...d.tables, [key]: { ...prev, columns } } };
  }); };
  const columnAnswer = (t, column) => draft.tables[historyTableKey(t.page, t.table)]?.columns?.[column];
  const pickPeriod = (t, c, value) => {
    if (value === 'skip') { setColumn(t, c.column, { skip: true }); return; }
    const [type, start, end] = String(value).split('|');
    setColumn(t, c.column, { period_type: type, period_start: start || null, period_end: end });
    setEditingColumns(x => ({ ...x, [`${t.page}:${t.table}:${c.column}`]: false }));
  };
  const skipKindless = () => setDraft(d => {
    const next = { ...d.tables };
    tables.filter(t => !t.kind && !t.proposed_kind).forEach(t => {
      const key = historyTableKey(t.page, t.table);
      next[key] = { ...(next[key] || { columns: {} }), kind: 'skip' };
    });
    return { ...d, tables: next };
  });
  const unknownRows = usedTables.flatMap(t => t.rows.filter(r => r.status === 'unknown').map(r => ({ t, r })));
  const namedUnknownRows = unknownRows.filter(({ t, r }) => (r.label || '').trim() && !draft.lines[historyRowKey(t.page, t.table, r.row)]);
  const newLinesForAll = () => setDraft(d => {
    const lines = { ...d.lines };
    namedUnknownRows.forEach(({ t, r }) => { lines[historyRowKey(t.page, t.table, r.row)] = { new_line_name: r.label }; });
    return { ...d, lines };
  });
  const setLineName = (t, r, name) => setDraft(d => ({ ...d, lines: { ...d.lines, [historyRowKey(t.page, t.table, r.row)]: { new_line_name: name } } }));
  const setLine = (t, r, value) => setDraft(d => {
    const lines = { ...d.lines };
    const key = historyRowKey(t.page, t.table, r.row);
    if (!value) delete lines[key];
    else lines[key] = value === '__new__' ? { new_line_name: r.label } : { line_key: value };
    return { ...d, lines };
  });
  const toggleMisread = m => setDraft(d => {
    const misreads = { ...d.misreads };
    const key = historyMisreadKey(m);
    if (misreads[key]) delete misreads[key];
    else misreads[key] = { page: m.page, content_sha256: m.content_sha256, table: m.table, parent_row: m.parent_row, column_label: m.column_label };
    return { ...d, misreads };
  });
  const setResolution = (factKey, value) => setDraft(d => {
    const resolutions = { ...d.resolutions };
    if (value === 'open') delete resolutions[factKey];
    else resolutions[factKey] = value === 'incoming' ? 'incoming' : Number(value);
    return { ...d, resolutions };
  });

  const finish = async () => {
    setWriting(true);
    try {
      const live = new Set(conflicts.map(c => c.fact_key));
      const current = { ...draft, resolutions: Object.fromEntries(Object.entries(draft.resolutions).filter(([key]) => live.has(key))) };
      const result = await window.HelixAPI.historyWrite(review.id, historyPayload(current, review.revision));
      window.toast?.(`Added to history: ${result.written} written · ${result.superseded} superseded · ${result.conflicts_open} conflicts open`, { type: 'success', duration: 7000 });
      onWritten?.(result);
    } catch (e) {
      if (e.detail?.blocking) setPreview(p => ({ ...(p || {}), blocking: e.detail.blocking }));
      window.toast?.(e.message || 'Could not add to history', { type: 'error' });
    } finally { setWriting(false); }
  };

  const scanLink = page => <a className="card-action" href={window.HelixAPI.ocrInboxPageUrl(item.id, page)} target="_blank" rel="noreferrer">Open page {page}</a>;
  const status = open => <div aria-live="polite" style={{ minHeight: 18, fontSize: 12, color: error ? 'var(--neg)' : open ? 'var(--warn)' : 'var(--text-muted)', margin: '0 0 10px' }}>
    {error ? error : loading ? 'Updating…' : preview ? (open ? `${open} open question${open === 1 ? '' : 's'} on this step` : 'Nothing open on this step') : ''}
  </div>;

  // ── step 1: tables & periods ──
  const tableNeedsAnswer = t => blocksFor(t.page, t.table).length > 0;
  const shownTables = tables.filter(t => filter === 'all' ? true : filter === 'used' ? (t.kind && t.kind !== 'skip') : (tableNeedsAnswer(t) || touched[historyTableKey(t.page, t.table)]));
  const shownUnconfirmed = shownTables.filter(kindUnconfirmed);
  const confirmKinds = list => { list.forEach(touch); setDraft(d => {
    const next = { ...d.tables };
    list.forEach(t => { const key = historyTableKey(t.page, t.table); next[key] = { ...(next[key] || { columns: {} }), kind: t.kind }; });
    return { ...d, tables: next };
  }); };
  const kindlessCount = tables.filter(t => !t.kind && !t.proposed_kind && !draft.tables[historyTableKey(t.page, t.table)]?.kind).length;
  const renderColumn = (t, c) => {
    const answer = columnAnswer(t, c.column);
    const editKey = `${t.page}:${t.table}:${c.column}`;
    const tone = c.skipped ? 'muted' : !c.period ? 'neg' : c.period_source === 'relative' ? 'warn' : c.period_source === 'answer' ? 'accent' : 'pos';
    const badge = c.skipped ? 'skipped' : !c.period ? 'unknown — set it' : c.period_source === 'relative' ? 'proposed — confirm' : c.period_source === 'answer' ? 'set by you' : 'from header';
    const text = historyPeriodText(c.period);
    const showSelect = !c.period || editingColumns[editKey] || c.period_source === 'relative';
    return <div key={c.column} style={{ padding: 10, borderRadius: 12, background: 'var(--ux-surface-2)', marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600, flex: '1 1 160px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.header}>{c.header || `Column ${c.column}`}</span>
        <HistoryBadge tone={tone}>{badge}</HistoryBadge>
      </div>
      {c.period && !c.skipped && !showSelect && <div style={{ fontSize: 13, fontWeight: 700, marginTop: 6 }}>{text.label} <span style={{ fontWeight: 500, color: 'var(--text-muted)', fontSize: 12 }}>{text.hint}</span></div>}
      {showSelect && !c.skipped && <div style={{ marginTop: 8 }}>
        <LxSelect ariaLabel={`Period of column ${c.header || c.column}`} value={historyPeriodValue(c.period)} placeholder="Choose the period"
          options={historyPeriodOptions(item.labels?.fiscal_year, c.period)} onChange={value => pickPeriod(t, c, value)} />
      </div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {c.period_source === 'relative' && !c.skipped && <button className="btn btn-primary" onClick={() => setColumn(t, c.column, { period_type: c.period.type, period_start: c.period.start, period_end: c.period.end })}>Confirm {text.label}</button>}
        {c.period && c.period_source === 'header' && !editingColumns[editKey] && <button className="card-action" onClick={() => setEditingColumns(x => ({ ...x, [editKey]: true }))}>Change</button>}
        {!c.skipped && <button className="card-action" onClick={() => setColumn(t, c.column, { skip: true })}>Skip column</button>}
        {answer && <button className="card-action" onClick={() => setColumn(t, c.column, null)}>Undo</button>}
      </div>
    </div>;
  };
  const renderTable = t => {
    const answer = draft.tables[historyTableKey(t.page, t.table)] || {};
    const blocks = blocksFor(t.page, t.table).filter(b => b.code !== 'column_period_unknown' && b.code !== 'period_unconfirmed' && b.code !== 'table_kind_unknown' && b.code !== 'kind_unconfirmed');
    const sample = t.rows.slice(0, 3).map(r => r.label).filter(Boolean).join(' · ');
    const used = t.kind && t.kind !== 'skip';
    return <div key={`${t.page}:${t.table}`} style={historyCard}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>Page {t.page} · table {t.table}</strong>
        {tableNeedsAnswer(t) ? <HistoryBadge tone="neg">needs an answer</HistoryBadge> : <HistoryBadge tone={used ? 'pos' : 'muted'}>{used ? 'ready' : HISTORY_KIND_NAMES[t.kind] || 'skipped'}</HistoryBadge>}
        <span style={{ flex: 1 }} />{scanLink(t.page)}
      </div>
      {sample && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sample}>{t.rows.length} rows · {sample}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginTop: 10 }}>
        <div>
          <LxSelect label={answer.kind ? (answer.kind === t.proposed_kind ? 'Statement kind · confirmed' : 'Statement kind · set by you') : t.proposed_kind ? 'Statement kind · proposed from the heading' : 'Statement kind'}
            value={t.kind} placeholder="Choose the kind" options={HISTORY_KIND_OPTIONS} onChange={value => updateTable(t, { kind: value })} />
          {kindUnconfirmed(t) && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <HistoryBadge tone="warn">proposed — confirm</HistoryBadge>
            <button className="btn btn-primary" onClick={() => confirmKinds([t])}>Confirm {HISTORY_KIND_NAMES[t.kind]}</button>
            <button className="card-action" onClick={() => updateTable(t, { kind: 'skip' })}>Skip table</button>
          </div>}
        </div>
        {used && <LxSelect label={answer.unit_multiplier ? 'Unit · set by you' : t.proposed_unit_multiplier && t.unit_multiplier === t.proposed_unit_multiplier ? 'Unit · read from the page' : 'Unit'}
          value={t.unit_multiplier} placeholder="Choose the unit" options={HISTORY_UNIT_OPTIONS} onChange={value => updateTable(t, { unit_multiplier: Number(value) })} />}
      </div>
      {used && t.columns.length > 0 && <div style={{ marginTop: 6 }}>{t.columns.map(c => renderColumn(t, c))}</div>}
      {used && !t.columns.length && <p style={historyBlockText}>No value columns were found in this table.</p>}
      {blocks.map((b, i) => <p key={i} role="alert" style={historyBlockText}>{b.message}</p>)}
    </div>;
  };
  const tablesStep = () => <>
    {status(tableBlocking.length)}
    {globalBlock && <div role="alert" style={{ ...historyCard, borderColor: 'var(--neg)' }}>
      <div style={{ color: 'var(--neg)', fontSize: 13, fontWeight: 600 }}>{globalBlock.message}</div>
      {globalBlock.code === 'labels_missing' && <button className="btn btn-primary" style={{ marginTop: 10 }} onClick={onOpenLabels}>Set upload labels</button>}
    </div>}
    {!globalBlock && preview && <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <LxSegmented ariaLabel="Which tables to show" value={filter} onChange={setFilter}
          options={[{ value: 'used', label: `Used (${usedTables.length})` }, { value: 'open', label: `Open (${tables.filter(tableNeedsAnswer).length})` }, { value: 'all', label: `All (${tables.length})` }]} />
        {shownUnconfirmed.length > 0 && <button className="btn" onClick={() => confirmKinds(shownUnconfirmed)}>Confirm all shown ({shownUnconfirmed.length} proposed kind{shownUnconfirmed.length === 1 ? '' : 's'})</button>}
        {kindlessCount > 0 && <button className="btn" onClick={skipKindless}>Skip {kindlessCount} table{kindlessCount === 1 ? '' : 's'} with no statement heading</button>}
      </div>
      {shownTables.length ? shownTables.map(renderTable) : <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>{filter === 'open' ? 'Every table is answered.' : 'No tables here.'}</p>}
    </>}
  </>;

  // ── step 2: lines ──
  const linesStep = () => <>
    {status(lineBlocking.length)}
    {unknownRows.length > 0 && <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
      <span style={{ fontSize: 13 }}>{unknownRows.length} row{unknownRows.length === 1 ? '' : 's'} not yet in this company's history.</span>
      {namedUnknownRows.length > 0 && <button className="btn" onClick={newLinesForAll}>Make {namedUnknownRows.length} new line{namedUnknownRows.length === 1 ? '' : 's'} from their labels</button>}
    </div>}
    {!usedTables.length && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No statement tables are used. Go back and choose a statement kind.</p>}
    {usedTables.map(t => {
      const asked = t.rows.filter(r => r.status === 'unknown' || draft.lines[historyRowKey(t.page, t.table, r.row)]);
      const matched = t.rows.filter(r => r.status === 'matched' && !draft.lines[historyRowKey(t.page, t.table, r.row)]);
      const skipped = t.rows.filter(r => r.status === 'skipped');
      const unreadable = t.rows.filter(r => r.unreadable_cells?.length);
      const columnName = c => t.columns.find(col => col.column === c)?.header || `column ${c}`;
      return <div key={`${t.page}:${t.table}`} style={historyCard}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14 }}>{HISTORY_KIND_NAMES[t.kind]} · page {t.page}</strong>
          <HistoryBadge tone="pos">{matched.length} matched</HistoryBadge>
          {asked.length > 0 && <HistoryBadge tone={asked.some(r => r.status === 'unknown') ? 'neg' : 'accent'}>{asked.length} to answer</HistoryBadge>}
          <span style={{ flex: 1 }} />{scanLink(t.page)}
        </div>
        {unreadable.length > 0 && <div role="note" style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, padding: '6px 10px', borderRadius: 8, background: 'var(--ux-surface-2)' }}>
          <strong style={{ color: 'var(--text)' }}>Not stored — cells that could not be read:</strong>
          {unreadable.map(r => <div key={r.row}>{r.label || `row ${r.row}`} (row {r.row}): {r.unreadable_cells.map(columnName).join(', ')}</div>)}
          <div>Correct the page in the review if these values matter.</div>
        </div>}
        {asked.map(r => {
          const answer = draft.lines[historyRowKey(t.page, t.table, r.row)];
          const isNew = !!answer && !answer.line_key;
          const value = answer?.line_key || (isNew ? '__new__' : '');
          const options = [
            ...r.suggestions.map(s => ({ value: s.line_key, label: `Same as ${s.line_name}`, hint: `${Math.round(s.score * 100)}% similar` })),
            { value: '__new__', label: 'New line', hint: r.label || 'you name it' },
          ];
          return <div key={r.row} style={{ padding: 10, borderRadius: 12, background: 'var(--ux-surface-2)', marginTop: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{r.code ? <span className="num" style={{ color: 'var(--text-muted)', marginRight: 6 }}>{r.code}</span> : null}{r.label || <em style={{ fontWeight: 500, color: 'var(--text-muted)' }}>row without a label</em>}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 8px' }}>{r.parent_label ? `under ${r.parent_label} · ` : ''}row {r.row} · {r.cells.filter(Boolean).slice(0, 2).join(' / ')}</div>
            <LxSelect ariaLabel={`Line for ${r.label || `row ${r.row}`}`} value={value} placeholder="Existing line or new?" options={options} onChange={v => setLine(t, r, v)} />
            {isNew && <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>Name of the new line
              <input value={answer.new_line_name || ''} onChange={e => setLineName(t, r, e.target.value)} placeholder="e.g. Tổng thu nhập hoạt động"
                style={{ display: 'block', width: '100%', marginTop: 3, padding: 8, border: `1px solid ${(answer.new_line_name || '').trim() ? 'var(--border)' : 'var(--neg)'}`, borderRadius: 6, background: 'var(--bg-elev)', color: 'var(--text)', fontSize: 13 }} />
            </label>}
          </div>;
        })}
        {skipped.length > 0 && <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>{skipped.length} row{skipped.length === 1 ? '' : 's'} skipped</summary>
          {skipped.map(r => <div key={r.row} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>{r.label || `row ${r.row}`} <span style={{ color: 'var(--text-muted)' }}>— skipped: {r.skip_reason}</span></div>)}
        </details>}
      </div>;
    })}
  </>;

  // ── step 3: checks ──
  const misreads = preview?.misreads || [];
  const conflicts = preview?.conflicts || [];
  const checksStep = () => <>
    {status(checkBlocking.length)}
    {!misreads.length && !conflicts.length && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No subtotal problems and no disagreement with values already in the history.</p>}
    {misreads.length > 0 && <h5 style={{ margin: '0 0 8px', fontSize: 13 }}>Subtotals that do not add up ({misreads.length})</h5>}
    {misreads.map(m => {
      const accepted = !!draft.misreads[historyMisreadKey(m)] || m.accepted;
      return <div key={historyMisreadKey(m)} style={historyCard}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>Page {m.page} · table {m.table} · row {m.parent_row}</strong>
          <HistoryBadge tone={accepted ? 'pos' : 'neg'}>{accepted ? 'correct as printed' : 'likely misread'}</HistoryBadge>
        </div>
        <p style={{ fontSize: 12, margin: '6px 0 10px' }}>“{m.parent_label}” ({m.column_label}) shows {m.parent} but its rows add up to {m.children_sum} — off by {m.difference}.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a className="btn" href={window.HelixAPI.ocrInboxPageUrl(item.id, m.page)} target="_blank" rel="noreferrer">Open page</a>
          <button className={accepted ? 'btn btn-primary' : 'btn'} aria-pressed={accepted} onClick={() => toggleMisread(m)}>Value correct as printed</button>
        </div>
      </div>;
    })}
    {conflicts.length > 0 && <h5 style={{ margin: '14px 0 8px', fontSize: 13 }}>Values that disagree with the history ({conflicts.length})</h5>}
    {conflicts.map(c => {
      const chosen = draft.resolutions[c.fact_key];
      const options = [
        { value: 'open', label: 'Leave open', hint: 'decide later on the history page' },
        ...c.existing.map(e => ({ value: e.fact_id, label: historyMoney(e.value), hint: `${e.filename} · page ${e.page ?? '—'}${e.origin === 'calculated' ? ' · calculated' : ''}` })),
        { value: 'incoming', label: historyMoney(c.incoming.value), hint: `this document · page ${c.incoming.page}, row ${c.incoming.row}` },
      ];
      const period = historyPeriodText(c.period);
      return <div key={c.fact_key} style={historyCard}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>{c.line_name}</strong><HistoryBadge tone={chosen ? 'accent' : 'warn'}>{chosen ? 'source chosen' : 'open conflict'}</HistoryBadge>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 10px' }}>{HISTORY_KIND_NAMES[c.statement_kind]} · {period.label} ({period.hint})</div>
        <LxSelect label="Which source is right?" value={chosen === undefined ? 'open' : chosen} options={options} onChange={v => setResolution(c.fact_key, v)} />
      </div>;
    })}
  </>;

  // ── step 4: add ──
  const newLines = Object.values(draft.lines).filter(l => l.new_line_name).length;
  const matchedRows = usedTables.reduce((n, t) => n + t.rows.filter(r => r.status === 'matched').length, 0);
  const remaining = [...tableBlocking, ...lineBlocking, ...checkBlocking, ...otherBlocking];
  const openConflicts = conflicts.filter(c => draft.resolutions[c.fact_key] === undefined).length;
  const addStep = () => <div className="u042-done">
    {remaining.length
      ? <span role="img" aria-label="Open questions" style={{ width: 76, height: 76, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 34, fontWeight: 800, color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 14%, transparent)' }}>!</span>
      : <span className="u042-big"><svg viewBox="0 0 34 34"><path d="M9 17.5l5.5 5.5L25.5 12" /></svg></span>}
    <h4>{remaining.length ? 'Some questions are still open' : 'Ready to add to history'}</h4>
    <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-muted)', maxWidth: 420 }}>
      {item.labels?.ticker} · {item.labels?.scope} · {item.labels?.period_code} {item.labels?.fiscal_year}<br />
      {usedTables.length} statement table{usedTables.length === 1 ? '' : 's'} · {matchedRows} rows ({newLines} new line{newLines === 1 ? '' : 's'})<br />
      {misreads.length} subtotal check{misreads.length === 1 ? '' : 's'} · {openConflicts} conflict{openConflicts === 1 ? '' : 's'} left open
    </p>
    {remaining.slice(0, 5).map((b, i) => <p key={i} role="alert" style={historyBlockText}>{b.message}</p>)}
    {status(remaining.length)}
  </div>;

  const steps = [
    { id: 'tables', title: 'Tables & periods', label: 'Tables', description: 'Confirm what each table is, its unit, and the period of each value column.', render: tablesStep, canNext: ready && tableBlocking.length === 0 },
    { id: 'lines', title: 'Lines', label: 'Lines', description: 'Rows the history has not seen: the same as an existing line, or a new line?', render: linesStep, canNext: ready && lineBlocking.length === 0 },
    { id: 'checks', title: 'Checks', label: 'Checks', description: 'Subtotals that do not add up, and values that disagree with the history.', render: checksStep, canNext: ready && checkBlocking.length === 0 },
    { id: 'add', title: 'Add', label: 'Add', bare: true, render: addStep, canNext: ready && remaining.length === 0 && !writing },
  ];

  return <div onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center', padding: 8 }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Add ${item.filename} to history`} tabIndex={-1} onKeyDown={onDialogKey}
      style={{ position: 'relative', width: 'min(780px, 100%)', height: 'min(800px, calc(100vh - 16px))', outline: 'none' }}>
      <LxWizard steps={steps} busy={writing} finishLabel="Add to history" ariaLabel="Add to history steps" onFinish={finish}
        header={<div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 780 }}>Add to history</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.filename}</div>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose} style={{ width: 30, height: 30 }}><Icon name="close" size={12} /></button>
        </div>} />
    </div>
  </div>;
};
