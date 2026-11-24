// CSV import: upload → map columns → validate → atomic commit. The ProgressBar tracks the
// step (and spins while a request is in flight); the ledger rebuild after commit is tracked
// by the page-level job bar.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { Button, Dialog, ProgressBar, Select } from '../../ui';
import { formatNumber } from '../../lib/format.js';

const STEPS = ['Upload', 'Map columns', 'Validate', 'Commit'];

const ImportDialog = ({ onClose, onCommitted }) => {
  const [preview, setPreview] = React.useState(null);
  const [mapping, setMapping] = React.useState({});
  const [validation, setValidation] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [fileName, setFileName] = React.useState('');

  const upload = async file => {
    if (!file) return;
    setFileName(file.name); setBusy(true); setError('');
    try {
      const p = await HelixAPI.portfolioImportPreview(file);
      setPreview(p);
      const auto = {};
      p.headers.forEach(h => { const match = p.canonical_fields.find(f => f.toLowerCase() === h.trim().toLowerCase()); if (match) auto[h] = match; });
      setMapping(auto);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const validate = async () => {
    setBusy(true); setError('');
    try { setValidation(await HelixAPI.portfolioImportValidate(preview.import_id, mapping)); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const commit = async () => {
    setBusy(true);
    try { onCommitted(await HelixAPI.portfolioImportCommit(preview.import_id)); } catch (e) { setError(e.message); setBusy(false); }
  };

  const step = !preview ? 0 : !validation ? 1 : validation.can_commit ? 3 : 2;
  const fieldOptions = preview ? [{ value: '', label: 'Ignore' }, ...preview.canonical_fields.map(f => ({ value: f, label: f }))] : [];

  return (
    <Dialog open onClose={onClose} size="lg" busy={busy} className="pf-import"
      title="Import transaction CSV" description="Upload → map → validate → atomic commit"
      actions={<>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        {preview && <Button disabled={busy} onClick={validate}>Validate</Button>}
        <Button variant="primary" disabled={busy || !validation?.can_commit} onClick={commit}>Commit atomically</Button>
      </>}>
      <ProgressBar size="sm" ariaLabel="Import progress"
        value={busy ? null : (step / (STEPS.length - 1)) * 100}
        status={error ? 'failed' : busy ? 'queued' : 'running'}
        label={`Step ${step + 1} of ${STEPS.length} · ${STEPS[step]}${busy ? ' …' : ''}`}
        meta={fileName || undefined} />

      {!preview ? (
        <label className="pf-drop">
          <input type="file" accept=".csv,text/csv" disabled={busy} onChange={e => upload(e.target.files?.[0])} />
          <span className="pf-drop-title">Choose a CSV file</span>
          <span className="pf-drop-sub">Exported broker history or your own ledger. Nothing is written until you commit.</span>
        </label>
      ) : <>
        <p className="pf-import-count">{formatNumber(preview.row_count)} rows · map source columns to ledger fields.</p>
        <div className="pf-map">
          {preview.headers.map(h => (
            <div key={h} className="pf-map-row">
              <span className="pf-map-src">{h}</span>
              <Select size="sm" value={mapping[h] || ''} options={fieldOptions} ariaLabel={`Field for ${h}`}
                onChange={v => { setMapping(m => ({ ...m, [h]: v })); setValidation(null); }} />
            </div>
          ))}
        </div>
        {validation && (
          <div className={validation.error_rows ? 'pf-validate is-bad' : 'pf-validate is-ok'} role="status">
            {validation.valid_rows} valid · {validation.error_rows} errors
            {validation.errors?.slice(0, 5).map(e => <div key={e.row} className="pf-validate-row">Row {e.row}: {e.message}</div>)}
            {validation.error_rows > 0 && <a className="btn btn-sm pf-validate-dl" href={HelixAPI.portfolioImportErrorsUrl(preview.import_id)}>Download error report</a>}
          </div>
        )}
      </>}
      {error && <p className="pf-error" role="alert">{error}</p>}
    </Dialog>
  );
};

export { ImportDialog };
