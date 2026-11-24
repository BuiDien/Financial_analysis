// Source panel body for one statement value: value, period, origin, the calculation, and every
// source (printed scan or Helix calculation) with "Use this value" for conflicts.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { Button } from '../../ui';
import { hxDate, hxDong, hxFormula, hxPeriodText, hxQuarterOrYear, hxStatusText, hxTy } from './statements-format.js';

const SourceBody = ({ point, busy, onChoose }) => {
  const conflict = point.status === 'conflict';
  const canChoose = conflict || point.status === 'resolved';
  return <>
    <div className="u273-kv">
      <div><small>Value</small><b className={conflict ? 'co-neg' : undefined}>{conflict ? '⚠ sources differ' : `${hxTy(point.value)} tỷ`}</b></div>
      <div><small>Period</small><b>{point.period_type === 'instant' ? hxDate(point.period_end) : hxQuarterOrYear(point)}</b></div>
      <div><small>Origin</small><b>{point.origin === 'calculated' ? 'Calculated' : 'Printed'}</b></div>
      <div><small>Sources</small><b>{hxStatusText(point)}</b></div>
    </div>
    <small className="co-src-period">
      {hxPeriodText(point)}{!conflict && point.value !== null ? ` · ${hxDong(point.value)}` : ''}
    </small>
    {point.origin === 'calculated' && <>
      <h5>How it was calculated</h5>
      <div className="u273-ac">{hxFormula(point)}</div>
      {point.inputs && point.inputs.length > 0 && <div className="u273-ac">inputs: {point.inputs.map(i => `fact #${i}`).join(', ')} (printed, verified)</div>}
    </>}
    <h5>{conflict ? 'Sources — pick the right one, or correct the OCR page' : 'Sources'}</h5>
    {point.sources.map(src => {
      const chosen = point.status === 'resolved' && src.value === point.value;
      return (
        <div key={src.fact_id} className="co-src">
          {src.origin === 'printed' ? <>
            <div className="co-src-file">{src.filename || `Document #${src.inbox_item_id}`}</div>
            <div className="co-src-meta">page {src.page} · row “{src.row_label || `#${src.row}`}” · reviewed ✓</div>
          </> : <div className="co-src-file">Calculated by Helix · {hxFormula(point).replace('calculated: ', '')}</div>}
          <div className="co-src-actions">
            <b className="co-src-value">{hxTy(src.value)} tỷ{chosen ? ' · your choice' : ''}</b>
            {src.origin === 'printed' && src.page && (
              <Button size="sm" onClick={() => window.open(HelixAPI.ocrInboxPageUrl(src.inbox_item_id, src.page), '_blank', 'noopener')}>Open scan</Button>
            )}
            {canChoose && !chosen && <Button size="sm" variant="primary" disabled={busy} onClick={() => onChoose(src)}>Use this value</Button>}
          </div>
        </div>
      );
    })}
  </>;
};

export { SourceBody };
