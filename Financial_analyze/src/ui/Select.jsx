// Lucian UX/UI Prompt #031 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#031
import React from 'react';
import { lxUid, lxReducedMotion } from './util.js';
import { stepEnabled } from './logic.js';
import './select.css';

// 'sm' and 'field' are both 36px; 'field' also takes TextInput's surface, ring, label and type.
const sizeClass = size => (size === 'sm' ? ' is-sm' : size === 'field' ? ' is-sm is-field' : '');

// Custom select listbox. Props: { value, options:[{value,label,hint?,badge?,color?,disabled?}], onChange, label,
// placeholder?, disabled?, ariaLabel?, size: 'md' (56px, the element's own size) | 'sm' (36px) | 'field'
// (36px in TextInput's look, so it sits level with TextInput / NumberInput md in a form row) }.
// Arrow keys glide the highlight (skipping disabled options), Home/End, Enter/Space choose, Escape
// closes, typing letters jumps to matching options. A disabled option is shown dimmed and can't be chosen.
const LxSelect = ({ value, options = [], onChange, label, placeholder = 'Choose…', disabled = false, ariaLabel, size = 'md' }) => {
  const uid = React.useMemo(() => lxUid('u031'), []);
  const rootRef = React.useRef(null);
  const btnRef = React.useRef(null);
  const listRef = React.useRef(null);
  const valueRef = React.useRef(null);
  const typed = React.useRef({ text: '', timer: 0 });
  const lastValue = React.useRef(value);
  const [open, setOpen] = React.useState(false);
  const sel = options.findIndex(o => String(o.value) === String(value));
  const enabled = i => !!options[i] && !options[i].disabled;
  // Next enabled index from i going dir (±1), clamped (no wrap); stays at i if none.
  const step = (i, dir) => stepEnabled(options, i, dir);
  const firstEnabled = () => options.findIndex(o => !o.disabled);
  const lastEnabled = () => { for (let j = options.length - 1; j >= 0; j--) if (enabled(j)) return j; return -1; };
  const startAt = () => (enabled(sel) ? sel : Math.max(0, firstEnabled()));
  const [act, setAct] = React.useState(startAt);
  const current = sel >= 0 ? options[sel] : null;

  const close = React.useCallback(refocus => {
    setOpen(false);
    if (refocus) btnRef.current?.focus({ preventScroll: true });
  }, []);
  const openList = () => {
    if (disabled || !options.length) return;
    setAct(startAt());
    setOpen(true);
  };
  const choose = i => {
    const option = options[i];
    if (option?.disabled) return;
    close(true);
    if (option && String(option.value) !== String(value)) onChange?.(option.value);
  };

  React.useEffect(() => { if (open) listRef.current?.focus({ preventScroll: true }); }, [open]);
  React.useEffect(() => {
    if (!open) return undefined;
    const item = listRef.current?.querySelector(`#${uid}-${act}`);
    item?.scrollIntoView?.({ block: 'nearest' });
    return undefined;
  }, [open, act, uid]);
  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = e => { if (rootRef.current && !rootRef.current.contains(e.target)) close(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, close]);
  const blurTimer = React.useRef(0);
  React.useEffect(() => () => { clearTimeout(typed.current.timer); clearTimeout(blurTimer.current); }, []);
  // The value text springs in when the value changes (the element's v.animate on choose).
  React.useEffect(() => {
    if (String(lastValue.current) === String(value)) return;
    lastValue.current = value;
    const v = valueRef.current;
    if (v?.animate && !lxReducedMotion()) v.animate([{ transform: 'translateY(8px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(.34,1.45,.64,1)' });
  }, [value]);

  const onListKey = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAct(a => step(a, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAct(a => step(a, -1)); }
    else if (e.key === 'Home') { e.preventDefault(); setAct(a => { const f = firstEnabled(); return f >= 0 ? f : a; }); }
    else if (e.key === 'End') { e.preventDefault(); setAct(a => { const l = lastEnabled(); return l >= 0 ? l : a; }); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(act); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
    else if (e.key.length === 1) {
      typed.current.text += e.key.toLowerCase();
      clearTimeout(typed.current.timer);
      typed.current.timer = setTimeout(() => { typed.current.text = ''; }, 600);
      const t = typed.current.text;
      const hit = options.findIndex(o => !o.disabled && (String(o.label).toLowerCase().indexOf(t) === 0 || String(o.badge || '').toLowerCase().indexOf(t) === 0));
      if (hit >= 0) setAct(hit);
    }
  };

  return <div ref={rootRef} className={`ux u031${sizeClass(size)}${open ? ' is-open' : ''}`}>
    <div className="u031-f">
      {label && <span className="u031-lab" id={`${uid}-lab`}>{label}</span>}
      <button ref={btnRef} className="u031-btn" type="button" disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open ? 'true' : 'false'} aria-controls={uid}
        aria-labelledby={label ? `${uid}-lab ${uid}-val` : undefined} aria-label={label ? undefined : ariaLabel}
        onClick={() => (open ? close(true) : openList())}
        onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openList(); } }}>
        {current?.badge && <span className="u031-flag" style={{ '--c': current.color || 'var(--ux-accent)' }} aria-hidden="true">{current.badge}</span>}
        <span className="u031-v" id={`${uid}-val`} ref={valueRef}><b>{current ? current.label : placeholder}</b>{current?.hint && <small>{current.hint}</small>}</span>
        <svg className="u031-car" viewBox="0 0 18 18" aria-hidden="true"><path d="M4.5 7l4.5 4.5L13.5 7" /></svg>
      </button>
      <ul ref={listRef} id={uid} className={`u031-list${open ? ' is-open' : ''}`} role="listbox" tabIndex={-1}
        aria-label={label || ariaLabel} aria-activedescendant={open && options[act] ? `${uid}-${act}` : undefined}
        onKeyDown={onListKey}
        onBlur={() => { clearTimeout(blurTimer.current); blurTimer.current = setTimeout(() => { if (rootRef.current && !rootRef.current.contains(document.activeElement)) setOpen(false); }, 0); }}>
        <li className="u031-hl" role="presentation" aria-hidden="true" style={{ '--i': act }} />
        {options.map((o, i) => <li key={String(o.value)} id={`${uid}-${i}`} className={`u031-o${o.disabled ? ' is-disabled' : ''}`} role="option" aria-selected={i === sel ? 'true' : 'false'}
          aria-disabled={o.disabled ? 'true' : undefined}
          onPointerMove={() => { if (act !== i && !o.disabled) setAct(i); }} onClick={() => choose(i)}>
          {o.badge && <span className="u031-flag" style={{ '--c': o.color || 'var(--ux-accent)' }} aria-hidden="true">{o.badge}</span>}
          <span className="u031-ot">{o.label}{o.hint && <small>{o.hint}</small>}</span>
          <svg className="u031-ck" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 9.5l3.5 3.5L14 6" /></svg>
        </li>)}
      </ul>
    </div>
  </div>;
};

// Text field in the #031 select's look (label, height, radius, focus ring) for forms mixing both.
const LxTextField = ({ label, value, onChange, placeholder, uppercase = false, size = 'md' }) => {
  const uid = React.useMemo(() => lxUid('u031in'), []);
  return <div className={`ux u031${sizeClass(size)}`}>
    <div className="u031-f">
      {label && <label className="u031-lab" htmlFor={uid}>{label}</label>}
      <input id={uid} className="u031-in" value={value || ''} placeholder={placeholder}
        onChange={e => onChange(uppercase ? e.target.value.toUpperCase() : e.target.value)} />
    </div>
  </div>;
};

export { LxSelect, LxTextField };
