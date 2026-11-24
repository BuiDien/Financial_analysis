// Upload labels (ticker, scope, year, period, unit) for one inbox item, and publication of a
// verified review. Used in the inbox list (labels only) and in both review workspaces.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { Button, LxSelect, LxTextField, toast } from '../../ui';
import { HISTORY_SCOPE_OPTIONS, HISTORY_PERIOD_CODE_OPTIONS, LABEL_UNIT_OPTIONS, historyFiscalYearOptions } from './ocr-inbox-utils.js';
import { openStatementsFor } from './shared.jsx';

const OCRPublishPanel = ({ item, reload, setPage, canPublish = true, title = 'Label before publication' }) => {
  const [labels, setLabels] = React.useState(() => {
    const stored = Object.fromEntries(Object.entries(item.labels || {}).filter(([, v]) => v !== null && v !== ''));
    const merged = { company: '', ticker: '', filing_type: 'BCTC', period: '', currency: 'VND', unit: null, scope: null, fiscal_year: null, period_code: null, ...stored };
    // Old free-text units ("million") are not understood by company history: make the owner pick.
    if (!LABEL_UNIT_OPTIONS.some(o => o.value === merged.unit)) merged.unit = null;
    return merged;
  });
  const [inHistory, setInHistory] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const set = (key, value) => setLabels(x => ({ ...x, [key]: value }));
  const save = async () => {
    const missing = [['ticker', 'Ticker'], ['scope', 'Scope'], ['fiscal_year', 'Fiscal year'], ['period_code', 'Period'], ['unit', 'Unit']]
      .filter(([key]) => !labels[key]).map(([, name]) => name);
    if (missing.length) { toast?.(`Please set: ${missing.join(', ')}`, { type: 'error' }); return; }
    const payload = {
      ...labels,
      company: (labels.company || '').trim() || labels.ticker,
      period: `${labels.period_code} ${labels.fiscal_year}`,
      filing_type: (labels.filing_type || '').trim() || 'BCTC',
      currency: (labels.currency || '').trim() || 'VND',
    };
    try {
      await HelixAPI.ocrInboxLabels(item.id, payload);
      setInHistory(false);
      await reload();
      toast?.('Labels saved', { type: 'success' });
    } catch (e) {
      if (e.status === 409 && /remove this document from history first/i.test(e.message || '')) setInHistory(true);
      else toast?.(e.message, { type: 'error' });
    }
  };
  const removeFromHistory = async () => {
    setRemoving(true);
    try {
      const result = await HelixAPI.historyRemove(item.id);
      setInHistory(false);
      await reload();
      toast?.(`Removed from history: ${result.superseded} value${result.superseded === 1 ? '' : 's'} superseded. Save the labels again.`, { type: 'success' });
    } catch (e) { toast?.(e.message, { type: 'error' }); }
    finally { setRemoving(false); }
  };
  const publish = async () => { try { await HelixAPI.ocrInboxPublish(item.id); await reload(); toast?.('Verified data published', { type: 'success' }); } catch (e) { toast?.(e.message, { type: 'error' }); } };
  if (item.status === 'published') return <div className="ocr-publish"><Button variant="primary" onClick={() => openStatementsFor(item, setPage)}>Open published filing</Button></div>;
  const textField = (key, label, placeholder) => <LxTextField key={key} label={label} value={labels[key]} placeholder={placeholder} uppercase={key === 'ticker'} onChange={value => set(key, value)} />;
  return <div className="ocr-publish">
    <div className="ocr-publish-title">{title}</div>
    <p className="ocr-muted ocr-publish-sub">Which company and which report is this PDF? Company history uses these to place every number.</p>
    <div className="ocr-form-grid">
      {textField('ticker', 'Ticker', 'e.g. MBB')}
      <LxSelect label="Scope" value={labels.scope} options={HISTORY_SCOPE_OPTIONS} onChange={value => set('scope', value)} />
      <LxSelect label="Fiscal year" value={labels.fiscal_year} options={historyFiscalYearOptions(labels.fiscal_year)} onChange={value => set('fiscal_year', Number(value))} />
      <LxSelect label="Period" value={labels.period_code} options={HISTORY_PERIOD_CODE_OPTIONS} onChange={value => set('period_code', value)} />
      {textField('company', 'Company', 'e.g. Ngân hàng TMCP Quân đội')}
      <LxSelect label="Unit printed in the PDF" value={labels.unit} options={LABEL_UNIT_OPTIONS} onChange={value => set('unit', value)} />
    </div>
    <details className="ocr-more">
      <summary>More</summary>
      <div className="ocr-form-grid is-tight">
        {textField('filing_type', 'Statement type', 'BCTC')}
        {textField('currency', 'Currency', 'VND')}
      </div>
    </details>
    {inHistory && <div role="alert" className="ocr-alert">
      <span>Remove this document from history first. Its values are in the company history, so its labels cannot change.</span>
      <Button size="sm" loading={removing} onClick={removeFromHistory}>{removing ? 'Removing…' : 'Remove from history'}</Button>
    </div>}
    <div className="ocr-actions-end">
      <Button onClick={save}>Save labels</Button>
      {canPublish && <Button variant="primary" disabled={item.status !== 'ready_to_publish'} onClick={publish}>Publish verified data</Button>}
    </div>
  </div>;
};

export { OCRPublishPanel };
