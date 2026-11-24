// Lucian UX/UI Prompt #010 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#010
// Split action button: the main action and its options in one control. The arrow unfolds a menu from
// the button's corner; the picked option rolls into the main label. Running it shows a progress bar
// inside the button, then a mint "done" state.
//
// <SplitButton options={[{ value, label, description?, icon?, busyLabel?, doneLabel? }]}
//   value onChange(value) onRun(value) size="sm|md" align="right|left" busy? disabled? menuLabel? />
// onRun may return a Promise: busy until it settles, "done" for 1.8 s on success, back to idle on error.
// Pass `busy` to drive the busy state yourself (e.g. from a job's status).

import React from 'react';
import { Icon } from './Icon.jsx';
import { cx, useReducedMotion, useUid } from './util.js';
import './split-button.css';

const GO = <svg className="u010-go" viewBox="0 0 24 24"><path d="M12 15l-3-3c1.5-4.5 4.5-7.5 10-8-.5 5.5-3.5 8.5-8 10zM9 12H5l2.5-3.5H11M12 15v4l3.5-2.5V13M6.5 17.5l-2 2" /></svg>;

// The label rolls: the old text slides up and out while the new one rises in (0.5 s spring).
const RollingLabel = ({ text, reduced }) => {
  const [state, setState] = React.useState({ cur: text, prev: null, n: 0 });
  React.useEffect(() => {
    if (text === state.cur) return undefined;
    setState(s => ({ cur: text, prev: reduced ? null : s.cur, n: s.n + 1 }));
    if (reduced) return undefined;
    const t = setTimeout(() => setState(s => ({ ...s, prev: null })), 520);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className="u010-labs">
      {state.prev != null && <span key={`o${state.n}`} className="is-out" aria-hidden="true">{state.prev}</span>}
      <span key={`i${state.n}`} className={state.n ? 'is-in' : undefined}>{state.cur}</span>
    </span>
  );
};

const SplitButton = ({
  options = [], value, onChange, onRun, size = 'md', align = 'right', busy, disabled = false,
  menuLabel = 'Options', caretLabel = 'More options', className,
}) => {
  const uid = useUid('u010');
  const reduced = useReducedMotion();
  const rootRef = React.useRef(null);
  const caretRef = React.useRef(null);
  const optRefs = React.useRef([]);
  const timers = React.useRef([]);
  const [open, setOpen] = React.useState(false);
  const [runState, setRunState] = React.useState('idle');
  const [live, setLive] = React.useState('');
  const idx = Math.max(0, options.findIndex(o => String(o.value) === String(value)));
  const cur = options[idx] || { label: '' };
  const state = busy ? 'busy' : runState;

  React.useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn, ms) => { timers.current.push(setTimeout(fn, ms)); };

  // Outside press closes the menu (document listener only while open).
  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const openMenu = (focusFirst) => {
    setOpen(true);
    if (focusFirst) later(() => optRefs.current[idx]?.focus({ preventScroll: true }), 30);
  };
  const pick = (o) => {
    setOpen(false);
    caretRef.current?.focus({ preventScroll: true });
    if (String(o.value) !== String(value)) onChange?.(o.value);
  };
  const run = () => {
    if (state !== 'idle' || disabled) return;
    setOpen(false);
    const busyText = cur.busyLabel || `${cur.label}…`;
    const doneText = cur.doneLabel || 'Done';
    const finish = (ok) => {
      if (!ok) { setRunState('idle'); setLive(''); return; }
      setRunState('done'); setLive(doneText);
      later(() => { setRunState('idle'); setLive(''); }, reduced ? 800 : 1800);
    };
    let result;
    try { result = onRun?.(cur.value); } catch (e) { finish(false); throw e; }
    if (result && typeof result.then === 'function') {
      setRunState('busy'); setLive(busyText);
      result.then(() => finish(true), () => finish(false));
    } else finish(true);
  };

  const text = state === 'busy' ? (cur.busyLabel || `${cur.label}…`) : state === 'done' ? (cur.doneLabel || 'Done') : cur.label;

  return (
    <div ref={rootRef} className={cx('ux u010', size === 'sm' && 'is-sm', align === 'left' && 'is-left', className)}
      data-state={state} data-open={open ? '1' : '0'}
      onKeyDown={e => { if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); caretRef.current?.focus({ preventScroll: true }); } }}>
      <div className="u010-grp">
        <button className="u010-main" type="button" onClick={run} disabled={disabled} aria-busy={state === 'busy' || undefined}>
          <span className="u010-ic" aria-hidden="true">
            {cur.icon ? (typeof cur.icon === 'string' ? <Icon name={cur.icon} className="u010-go" /> : cur.icon) : GO}
            <svg className="u010-spin" viewBox="0 0 24 24"><path d="M12 4a8 8 0 1 0 8 8" /></svg>
            <svg className="u010-ok" viewBox="0 0 24 24"><path d="M5.5 12.5l4.2 4.2L18.5 8" /></svg>
          </span>
          <RollingLabel text={text} reduced={reduced} />
          <span className="u010-bar" aria-hidden="true" />
        </button>
        <span className="u010-div" aria-hidden="true" />
        <button ref={caretRef} className="u010-caret" type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={`${uid}-m`}
          aria-label={caretLabel} disabled={disabled}
          onClick={e => (open ? setOpen(false) : openMenu(e.detail === 0))}
          onKeyDown={e => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); openMenu(true); } }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 9.5l5.5 5.5 5.5-5.5" /></svg>
        </button>
      </div>
      <ul className="u010-menu" role="menu" id={`${uid}-m`} aria-label={menuLabel}>
        {options.map((o, i) => (
          <li role="none" key={String(o.value)}>
            <button ref={el => { optRefs.current[i] = el; }} className="u010-opt" type="button" role="menuitemradio"
              aria-checked={i === idx} tabIndex={open ? 0 : -1} onClick={() => pick(o)}
              onKeyDown={e => {
                const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
                if (d) { e.preventDefault(); optRefs.current[(i + d + options.length) % options.length]?.focus(); }
              }}>
              {o.icon && <span className="u010-oi" aria-hidden="true">{typeof o.icon === 'string' ? <Icon name={o.icon} /> : o.icon}</span>}
              <span><b>{o.label}</b>{o.description && <small>{o.description}</small>}</span>
              <span className="u010-chk" aria-hidden="true"><svg viewBox="0 0 12 12"><path d="M2.5 6.2l2.2 2.2L9.5 3.6" /></svg></span>
            </button>
          </li>
        ))}
      </ul>
      <span className="u010-live" aria-live="polite">{live}</span>
    </div>
  );
};

export { SplitButton };
