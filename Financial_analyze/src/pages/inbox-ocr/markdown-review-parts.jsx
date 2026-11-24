// Page-Markdown OCR review — the content pane's header (title, page facts, tools, view tabs) and its
// footer bar (selection total, level verification, Ollama suggestions, page actions).
// `r` is the object from use-markdown-review.js.

import React from 'react';
import { Badge, Button, Tabs, cx } from '../../ui';
import { fmtInboxBytes, markdownHasTable, LABEL_LEVEL_VALUES, labelLevelCode } from './ocr-inbox-utils.js';
import { InboxStatus } from './shared.jsx';

const VIEW_TABS = [{ value: 'tables', label: 'Spreadsheet' }, { value: 'preview', label: 'Page' }, { value: 'source', label: 'Source' }];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ContentHeader = ({ r }) => {
  const ollamaBusy = ['queued', 'running'].includes(r.hermesRun?.status);
  const tableTools = !r.editing && r.viewMode === 'tables' && markdownHasTable(r.markdown);
  const check = r.pageResult?.label_check;
  return <div className="ocr-pane-head">
    <div className="ocr-pane-heading">
      <div className="ocr-pane-titlerow">
        <h3 className="card-title">{r.viewMode === 'tables' && !r.editing ? 'Spreadsheet review' : 'Markdown'} · page {r.selectedPage}</h3>
        <InboxStatus status={r.statusLabel} />
        {r.busyEditing
          ? <Badge tone="info" dot sans role="status">{r.saving ? 'Saving… editing paused' : r.detectingLevels ? 'Detecting levels… editing paused' : 'Verifying totals… editing paused'}</Badge>
          : r.dirty && <Badge tone="warn" sans>Unsaved changes</Badge>}
      </div>
      {r.pageResult && <div className="num ocr-muted ocr-tiny">{fmtInboxBytes(r.pageResult.byte_size)} · {r.pageResult.content_sha256.slice(0, 12)}…</div>}
      {check && <div className={cx('ocr-tiny', check.error ? 'ocr-error-text' : 'ocr-muted')}>Label checker: {check.status}{check.status === 'checked' ? ` · ${check.known_count} known · ${check.candidate_count} to review` : ''}{check.error ? ` · ${check.error}` : ''}</div>}
      {r.pageResult?.total_check?.likely_misreads?.length > 0 && <div role="status" className="ocr-misreads">
        {r.pageResult.total_check.likely_misreads.map((flag, index) => <div key={index}>⚠ Total check: “{flag.parent_label}” ({flag.column_label}) shows {flag.parent} but its rows add up to {flag.children_sum} — off by {flag.difference}, likely one misread digit. Compare with the PDF.</div>)}
      </div>}
    </div>
    <div className="ocr-pane-tools">
      {tableTools && !r.locked && <Button size="sm"
        disabled={r.dirty || r.saving || !r.markedHermesRows.length || r.startingHermes || ollamaBusy}
        onClick={() => r.startHermesLabelReview()}
        title={r.dirty ? 'Save or discard table changes before asking Ollama' : r.markedHermesRows.length ? 'Send marked labels to Ollama one at a time' : 'Select a label cell and mark it for Ollama first'}
      >{r.startingHermes || ollamaBusy ? 'Ollama reviewing…' : `Ask Ollama (${r.markedHermesRows.length})`}</Button>}
      {tableTools && !r.locked && <Button size="sm"
        disabled={r.saving || r.detectingLevels || r.verifyingLevelTotals || ollamaBusy}
        onClick={r.detectLabelLevels}
        title="Use exact arithmetic to propose label levels from the corrected table values"
      >{r.detectingLevels ? 'Detecting levels…' : 'Auto-detect levels'}</Button>}
      {tableTools && <Button size="sm"
        disabled={r.saving || r.detectingLevels || r.verifyingLevelTotals}
        onClick={r.verifyLevelTotals}
        title="Check that every L0–L2 parent equals the total of its direct next-level rows"
      >{r.verifyingLevelTotals ? 'Verifying totals…' : 'Verify level totals'}</Button>}
      {!r.editing && <Tabs size="sm" ariaLabel="Markdown display mode" tabs={VIEW_TABS} value={r.viewMode} onChange={r.setViewMode} />}
    </div>
  </div>;
};

const OllamaStatus = ({ r }) => {
  const run = r.hermesRun;
  const visible = r.visibleHermesSuggestions;
  const active = r.activeHermesSuggestion;
  let body;
  if (['queued', 'running'].includes(run.status)) {
    body = <span>sent label {(run.processed_count || 0) + 1} of {run.total_count || run.selected_rows?.length || 0} to Ollama{run.active_target ? ` · table ${run.active_target.table}, row ${run.active_target.row}` : ''}</span>;
  } else if (run.status === 'failed') {
    body = <span title={run.error}>{run.error || 'review failed'}</span>;
  } else if (visible.length) {
    body = <>
      <select className="ocr-select is-ai is-wide" value={r.selectedHermesSuggestion} onChange={r.navigateToHermesSuggestion} aria-label="Go to an Ollama label suggestion">
        <option value="">{plural(visible.length, 'suggestion')} · {r.acceptedHermesSuggestions.length} accepted</option>
        {visible.map(suggestion => <option key={suggestion.id} value={suggestion.id}>Table {suggestion.table} · row {suggestion.row} · {suggestion.suggested_label ? `${suggestion.current_label} → ${suggestion.suggested_label}` : `${suggestion.current_level === null ? 'Unassigned' : labelLevelCode(suggestion.current_level)} → ${labelLevelCode(suggestion.user_edited_level ?? suggestion.suggested_level)}`} · {suggestion.decision}</option>)}
      </select>
      {active && <>
        {active.suggested_label ? <span>Use: {active.suggested_label}</span> : <label className="ocr-inline-field">Use
          <select className="ocr-select is-ai" value={active.user_edited_level ?? active.suggested_level} onChange={event => r.decideHermesSuggestion(active, 'edited', Number(event.target.value))} aria-label="Change the accepted Ollama label level">
            {LABEL_LEVEL_VALUES.map(level => <option key={level} value={level}>{labelLevelCode(level)}</option>)}
          </select>
        </label>}
        <button type="button" className="card-action" disabled={r.dirty || ['accepted', 'edited'].includes(active.decision)} title={r.dirty ? 'Save or discard changes first' : undefined} onClick={() => r.decideHermesSuggestion(active, 'accepted')}>Accept</button>
        <button type="button" className="card-action" onClick={() => r.decideHermesSuggestion(active, 'rejected')}>Reject</button>
      </>}
      <Button size="sm" variant="primary" disabled={!r.acceptedHermesSuggestions.length || r.saving || r.dirty} title={r.dirty ? 'Save or discard changes first' : undefined} onClick={r.applyHermesSuggestions}>Apply accepted ({r.acceptedHermesSuggestions.length})</Button>
    </>;
  } else {
    body = <span>{run.suggestions?.some(suggestion => suggestion.applied_revision !== null) ? 'Suggestions applied' : run.suggestions?.length ? 'All suggestions resolved' : `Ollama reviewed ${plural(run.processed_count || 0, 'marked label')} · no changes suggested`}</span>;
  }
  return <div role="status" aria-live="polite" className={cx('ocr-ollama', run.status === 'failed' && 'is-failed')}>
    <span>{run.trigger === 'worker_auto' ? 'Automatic Ollama' : 'Ollama'}</span>{body}
  </div>;
};

const StatusBar = ({ r }) => {
  const issues = r.verificationIssues;
  const resetEdit = () => { r.updateMarkdown(r.pageResult?.effective_markdown || ''); r.setEditing(false); r.setViewMode(markdownHasTable(r.pageResult?.effective_markdown) ? 'tables' : 'preview'); };
  return <div className="ocr-pane-foot">
    <div className="ocr-pane-foot-info">
      {!r.editing && r.viewMode === 'tables' && <>
        <span role="status" aria-live="polite" className="ocr-sum">
          <strong>Selected: <span className="num">{r.selectionSummary.count}</span></strong>
          <strong>Total: <span className="num ocr-sum-total">{r.selectionSummary.total}</span></strong>
        </span>
        {r.levelVerification && <label className={cx('ocr-inline-field ocr-verify', issues.length ? 'is-bad' : 'is-good')}>
          Verification
          <select className="ocr-select is-wide" value={r.selectedVerificationIssue} disabled={!issues.length} onChange={r.navigateToVerificationIssue} aria-label="Go to a level verification issue">
            <option value="">{issues.length ? `${plural(issues.length, 'issue')} · ${r.levelVerification.matched} matched` : `No issues · ${r.levelVerification.matched} matched`}</option>
            {issues.map(issue => <option key={issue.id} value={issue.id}>{issue.label}</option>)}
          </select>
        </label>}
        {r.hermesRun && <OllamaStatus r={r} />}
      </>}
    </div>
    {!r.locked && <div className="ocr-pane-foot-actions">
      {r.editing ? <>
        <Button disabled={r.saving} onClick={resetEdit}>Cancel</Button>
        <Button variant="primary" disabled={r.saving || !r.dirty} onClick={r.saveCorrection}>{r.saving ? 'Saving…' : 'Save correction'}</Button>
      </> : r.dirty ? <>
        <Button disabled={r.saving} onClick={() => r.updateMarkdown(r.pageResult?.effective_markdown || '')}>Discard table changes</Button>
        <Button variant="primary" disabled={r.saving} onClick={r.saveCorrection}>{r.saving ? 'Saving…' : 'Save correction'}</Button>
      </> : <>
        {r.statusLabel === 'pending' && <Button variant="primary" disabled={r.saving} onClick={() => r.pageAction('approve')}>Approve page</Button>}
        <Button disabled={r.saving} onClick={() => { r.updateMarkdown(r.pageResult?.effective_markdown || ''); r.setViewMode('source'); r.setEditing(true); }}>Edit Markdown</Button>
        {r.statusLabel !== 'pending' && <Button disabled={r.saving} onClick={() => r.pageAction('restore')}>Reset to pending</Button>}
      </>}
    </div>}
  </div>;
};

export { ContentHeader, StatusBar };
