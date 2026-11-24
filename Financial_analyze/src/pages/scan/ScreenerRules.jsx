// Screener rule rows: the compact number box, an Advanced rule row (switch + params) and a
// Simple-view rule (plain sentence + ⓘ explanation).

import React from 'react';
import * as SP from './screener-plain.js';
import { Switch } from '../../ui/index.js';
import { scrStep } from './screener-model.js';

// Number box: type a value, or hover and scroll the mouse wheel (Shift = 10 steps),
// or use ↑/↓. Clamped to the rule's min/max.
const ScrNumInput = ({ value, p, onChange, label }) => {
  const ref = React.useRef(null);
  const step = scrStep(p);
  const latest = React.useRef({ value, onChange });
  latest.current = { value, onChange };
  const bump = React.useCallback((dir, big) => {
    const cur = parseFloat(latest.current.value);
    const base = Number.isFinite(cur) ? cur : (p.default ?? p.min ?? 0);
    const dec = step < 1 ? 1 : 0;
    let next = +(base + dir * step * (big ? 10 : 1)).toFixed(dec);
    if (p.min != null) next = Math.max(p.min, next);
    if (p.max != null) next = Math.min(p.max, next);
    latest.current.onChange(String(next));
  }, [step, p.min, p.max, p.default]);
  React.useEffect(() => {
    const el = ref.current;
    // Non-passive so the page does not scroll while adjusting the value.
    const onWheel = (e) => { e.preventDefault(); bump(e.deltaY < 0 ? 1 : -1, e.shiftKey); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [bump]);
  const n = parseFloat(value);
  const bad = value === '' || !Number.isFinite(n) || (p.min != null && n < p.min) || (p.max != null && n > p.max);
  return (
    <input ref={ref} type="number" className={`scan-num${bad ? ' is-bad' : ''}`} value={value} min={p.min} max={p.max} step={step}
      aria-label={label} aria-invalid={bad || undefined} title="Type a number, or scroll / ↑↓ to adjust (Shift = ×10)"
      onKeyDown={e => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault(); bump(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
        }
      }}
      onChange={e => onChange(e.target.value === '' ? '' : e.target.value)} />
  );
};

const PARAM_WORD = { x: 'Value', n: 'Years', d: 'Days' };

const ScrRuleRow = ({ spec, cfg, onChange }) => {
  const P = SP.PLAIN[spec.id] || {};
  const name = P.name || spec.label;
  return (
    <div className={`scan-rule${cfg.on ? '' : ' is-off'}`}>
      <Switch checked={!!cfg.on} onChange={(on) => onChange({ on })} aria-label={name} className="scan-rule-sw" />
      <div className="scan-rule-text" data-tip={P.help || undefined}>
        <span className="scan-rule-name">{name}</span>
        <span className="scan-rule-sub">{spec.label}</span>
      </div>
      <div className="scan-rule-params">
        {Object.entries(spec.params).map(([k, p]) => (
          <label key={k} className="scan-param">
            <span className="scan-param-k">{k}</span>
            <ScrNumInput value={cfg[k]} p={p} onChange={v => onChange({ [k]: v })} label={`${name}: ${PARAM_WORD[k] || k}`} />
            {p.unit && <span className="scan-param-u">{p.unit}</span>}
          </label>
        ))}
      </div>
    </div>
  );
};

// Simple view: one active check as a plain sentence with an ⓘ explanation.
const ScrPlainRule = ({ id, cfg }) => {
  const [open, setOpen] = React.useState(false);
  const P = SP.PLAIN[id] || { name: id, help: '' };
  return (
    <div className="scan-plain">
      <span className="scan-plain-check" aria-hidden="true">✓</span>
      <div className="scan-plain-body">
        <span className="scan-plain-name">{P.name}</span>
        <span className="scan-plain-say">{SP.sentence(id, cfg)}</span>
        {open && <span className="scan-plain-help">{P.help}</span>}
      </div>
      {P.help && (
        <button type="button" className={`scan-info${open ? ' is-on' : ''}`} onClick={() => setOpen(!open)}
          aria-expanded={open} aria-label={`What does “${P.name}” mean?`}>ⓘ</button>
      )}
    </div>
  );
};

export { ScrNumInput, ScrRuleRow, ScrPlainRule };
