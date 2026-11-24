// Text inputs: SearchInput (#429), TextInput + NumberInput (#434). Styles: ./input.css.

import React from 'react';
import { Icon } from './Icon.jsx';
import { cx, isMac, lxReducedMotion, useUid } from './util.js';
import './input.css';

const highlight = (text, q) => {
  const s = String(text ?? '');
  if (!q) return s;
  const i = s.toLowerCase().indexOf(q);
  if (i < 0) return s;
  return <>{s.slice(0, i)}<mark>{s.slice(i, i + q.length)}</mark>{s.slice(i + q.length)}</>;
};

// Lucian UX/UI Prompt #429 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#429
// <SearchInput value onChange(text) placeholder suggestions? onSelect?(item) shortcut? size="sm|md"
//   ariaLabel maxResults=6 onSubmit?(text) />
// suggestions: [{ value, label, meta?, icon? (Icon name or short text like "VN") }] or (query) => items.
// Typing opens up to maxResults matches with the matching letters bold; ↑/↓ spring the selection bar,
// Enter picks (onSelect) or submits the text (onSubmit), Esc folds the list. `shortcut` shows the ⌘K
// hint and focuses the field on ⌘K while focus is inside it (it does not add a global hotkey).
const SearchInput = React.forwardRef(({
  value = '', onChange, placeholder = 'Search', suggestions, onSelect, onSubmit, shortcut = false,
  size = 'md', ariaLabel, maxResults = 6, clearable = true, autoFocus, className, id,
}, fwdRef) => {
  const uid = useUid('u429');
  const inputRef = React.useRef(null);
  React.useImperativeHandle(fwdRef, () => inputRef.current);
  const [open, setOpen] = React.useState(false);
  const [act, setAct] = React.useState(-1);
  const [jump, setJump] = React.useState(true);
  const q = String(value || '').trim().toLowerCase();

  const list = React.useMemo(() => {
    if (!suggestions || !q) return [];
    if (typeof suggestions === 'function') return (suggestions(q) || []).slice(0, maxResults);
    return suggestions
      .filter(d => String(d.label).toLowerCase().includes(q) || String(d.meta || '').toLowerCase().includes(q) || String(d.value).toLowerCase().includes(q))
      .sort((a, b) => (String(a.label).toLowerCase().startsWith(q) ? 0 : 1) - (String(b.label).toLowerCase().startsWith(q) ? 0 : 1))
      .slice(0, maxResults);
  }, [suggestions, q, maxResults]);

  React.useEffect(() => { setAct(list.length ? 0 : -1); setJump(true); }, [list]);
  const hasList = !!suggestions;
  const isOpen = hasList && open && !!q;

  const choose = (i) => {
    const d = list[i];
    if (!d) return;
    setOpen(false);
    onSelect ? onSelect(d) : onChange?.(String(d.label));
  };
  const onKeyDown = (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && list.length) {
      e.preventDefault();
      if (!isOpen) { setOpen(true); return; }
      setJump(false);
      setAct(a => (a + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      if (isOpen && act >= 0) { e.preventDefault(); choose(act); }
      else if (onSubmit) { e.preventDefault(); onSubmit(String(value || '')); }
    } else if (e.key === 'Escape' && isOpen) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  };
  const mac = isMac();
  const pillStyle = { '--py': `${Math.max(0, act) * 34}px`, '--po': act >= 0 ? 1 : 0, ...(jump ? { transition: 'none' } : null) };

  return (
    <div className={cx('ux u429', size === 'sm' && 'is-sm', isOpen && 'is-open', className)}
      onKeyDown={e => { if (shortcut && (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); inputRef.current?.focus({ preventScroll: true }); inputRef.current?.select(); } }}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <label className="u429-f">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
        <input ref={inputRef} id={id} className="u429-in" type="search" value={value} placeholder={placeholder} autoComplete="off" spellCheck="false"
          aria-label={ariaLabel || placeholder} autoFocus={autoFocus}
          role={hasList ? 'combobox' : undefined} aria-expanded={hasList ? isOpen : undefined}
          aria-autocomplete={hasList ? 'list' : undefined} aria-controls={hasList ? `${uid}-lb` : undefined}
          aria-activedescendant={isOpen && act >= 0 ? `${uid}-${act}` : undefined}
          onChange={e => { onChange?.(e.target.value); setOpen(true); }}
          onClick={() => setOpen(true)} onKeyDown={onKeyDown} />
        {clearable && value ? (
          <button type="button" className="u429-x" aria-label="Clear search" onClick={() => { onChange?.(''); inputRef.current?.focus(); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        ) : shortcut ? <kbd className="u429-kb" aria-hidden="true">{mac ? '⌘K' : 'Ctrl K'}</kbd> : null}
      </label>
      {hasList && (
        <div className="u429-dd" onMouseDown={e => e.preventDefault()}>
          <i className="u429-pill" aria-hidden="true" style={pillStyle} />
          <div className="u429-lb" role="listbox" id={`${uid}-lb`} aria-label={ariaLabel || placeholder}
            onPointerMove={e => {
              const o = e.target.closest('.u429-o');
              if (!o) return;
              const i = Number(o.dataset.i);
              if (i !== act) { setJump(false); setAct(i); }
            }}>
            {list.length ? list.map((d, i) => (
              <div key={String(d.value)} className="u429-o" role="option" id={`${uid}-${i}`} data-i={i} aria-selected={i === act}
                style={{ '--i': i }} onClick={() => choose(i)}>
                <span className="u429-ic" aria-hidden="true">{d.icon ? (d.icon.length > 3 ? <Icon name={d.icon} size={12} /> : d.icon) : <Icon name="search" size={12} />}</span>
                <span className="u429-t">{highlight(d.label, q)}</span>
                {d.meta && <span className="u429-m">{d.meta}</span>}
                <span className="u429-en" aria-hidden="true">↵</span>
              </div>
            )) : <div className="u429-no">No results</div>}
          </div>
        </div>
      )}
      <p className="u429-live" role="status">{isOpen ? (list.length ? `${list.length} results` : 'No results') : ''}</p>
    </div>
  );
});
SearchInput.displayName = 'SearchInput';

const CHECK = <svg viewBox="0 0 24 24"><path d="m5.5 12.5 4 4 9-9.5" /></svg>;
const BANG = <svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01" /></svg>;

// Shared #434 shell: label, field with glow / shake / check, animated hint row.
const FieldShell = ({ label, inputId, hint, error, success, size, disabled, focus, prefix, suffix, children, className }) => {
  const fRef = React.useRef(null);
  const st = error ? 'err' : success ? 'ok' : 'idle';
  // Shake once each time a new error message appears (the element's remove + reflow + add).
  const lastErr = React.useRef(null);
  React.useEffect(() => {
    const f = fRef.current;
    if (!f || !error || error === lastErr.current) { lastErr.current = error || null; return; }
    lastErr.current = error;
    if (lxReducedMotion()) return;
    f.classList.remove('is-shake'); void f.offsetWidth; f.classList.add('is-shake');
  }, [error]);
  const msgId = `${inputId}-m`;
  const hasMsg = !!(hint || (typeof error === 'string' && error) || (typeof success === 'string' && success));
  return (
    <div className={cx('ux u434', size === 'sm' && 'is-sm', size === 'compact' && 'is-compact', className)} data-s={st}>
      {label && <label className="u434-lb" htmlFor={inputId}>{label}</label>}
      <div ref={fRef} className={cx('u434-f', focus && 'is-focus', st === 'err' && 'is-err', st === 'ok' && 'is-ok', disabled && 'is-disabled')}
        onAnimationEnd={e => e.currentTarget.classList.remove('is-shake')}>
        {prefix != null && <span className="u434-ax">{prefix}</span>}
        {children(hasMsg ? msgId : undefined, st === 'err')}
        {suffix != null && <span className="u434-ax">{suffix}</span>}
        {(error || success) && <span className="u434-ic" aria-hidden="true"><span className="ok u434-ok">{CHECK}</span><span className="no">{BANG}</span></span>}
      </div>
      {hasMsg && (
        <p className="u434-msg" id={msgId} aria-live="polite">
          <span className="h" aria-hidden={st !== 'idle'}>{hint || ''}</span>
          <span className="e" aria-hidden={st !== 'err'}>{typeof error === 'string' ? error : ''}</span>
          <span className="s" aria-hidden={st !== 'ok'}>{typeof success === 'string' ? success : ''}</span>
        </p>
      )}
    </div>
  );
};

// Lucian UX/UI Prompt #434 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#434
// <TextInput label value onChange(value, event) placeholder hint error success prefix suffix size="sm|md|compact"
//   type="text" disabled ariaLabel? ...inputProps />
// ariaLabel names the input when there is no visible label (e.g. a cell editor in a table row).
// error / success: true for the ring only, or a message string shown under the field.
const TextInput = React.forwardRef(({
  label, value, onChange, hint, error, success, prefix, suffix, size = 'md', id, className, disabled,
  onFocus, onBlur, type = 'text', ariaLabel, ...rest
}, ref) => {
  const autoId = useUid('u434');
  const inputId = id || autoId;
  const [focus, setFocus] = React.useState(false);
  return (
    <FieldShell label={label} inputId={inputId} hint={hint} error={error} success={success} size={size}
      disabled={disabled} focus={focus} prefix={prefix} suffix={suffix} className={className}>
      {(describedBy, invalid) => (
        <input ref={ref} id={inputId} className="u434-in" type={type} value={value ?? ''} disabled={disabled}
          aria-label={ariaLabel} aria-invalid={invalid || undefined} aria-describedby={describedBy}
          onChange={e => onChange?.(e.target.value, e)}
          {...rest} onFocus={e => { setFocus(true); onFocus?.(e); }} onBlur={e => { setFocus(false); onBlur?.(e); }} />
      )}
    </FieldShell>
  );
});
TextInput.displayName = 'TextInput';

const parseNum = (s) => {
  const t = String(s ?? '').replace(/[,\s_]/g, '');
  if (t === '' || t === '-' || t === '.') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};
const showNum = (n, decimals) => (n == null || !Number.isFinite(n) ? '' : decimals == null ? String(n) : Number(n).toFixed(decimals));

// <NumberInput label value={number|null} onChange(number|null) min max step decimals suffix size="sm|md|compact"
//   wheel? ariaLabel? />
// Accepts "1,500,000" style typing; keeps your text while focused and tidies it on blur. Arrow keys
// step by `step` (Shift ×10). A value outside min/max or unparsable shows the error ring. With `wheel`,
// the mouse wheel steps the value too, but only while the field has focus (so page scroll is never
// hijacked by a field the pointer merely passes over).
const NumberInput = React.forwardRef(({
  label, value, onChange, min, max, step = 1, decimals, hint, error, success, prefix, suffix, size = 'md',
  id, className, disabled, placeholder, onFocus, onBlur, onKeyDown, wheel = false, ariaLabel, ...rest
}, ref) => {
  const autoId = useUid('u434n');
  const inputId = id || autoId;
  const [focus, setFocus] = React.useState(false);
  const inRef = React.useRef(null);
  const setRefs = React.useCallback((el) => {
    inRef.current = el;
    if (typeof ref === 'function') ref(el); else if (ref) ref.current = el;
  }, [ref]);
  const [text, setText] = React.useState(() => showNum(value, decimals));
  React.useEffect(() => { if (!focus) setText(showNum(value, decimals)); }, [value, decimals, focus]);
  const parsed = parseNum(text);
  const bad = Number.isNaN(parsed) || (parsed != null && ((min != null && parsed < min) || (max != null && parsed > max)));
  const rangeMsg = Number.isNaN(parsed) ? 'Not a number' : min != null && max != null ? `Between ${min} and ${max}` : min != null ? `At least ${min}` : `At most ${max}`;
  const commit = (s) => {
    setText(s);
    const n = parseNum(s);
    if (!Number.isNaN(n)) onChange?.(n);
  };
  const bump = (dir, big) => {
    const base = Number.isFinite(parsed) ? parsed : (min ?? 0);
    let n = base + dir * step * (big ? 10 : 1);
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    n = Number(n.toFixed(decimals ?? 10));
    commit(showNum(n, decimals));
  };
  // Wheel: a native non-passive listener (React's onWheel is passive, so it cannot stop the page
  // scrolling). Only acts while this input is focused; wheel up = step up, Shift = ×10.
  const bumpRef = React.useRef(bump);
  bumpRef.current = bump;
  React.useEffect(() => {
    const el = inRef.current;
    if (!wheel || !el || disabled) return undefined;
    const onWheel = (e) => {
      if (document.activeElement !== el) return;
      const d = e.deltaY || e.deltaX;
      if (!d) return;
      e.preventDefault();
      bumpRef.current(d < 0 ? 1 : -1, e.shiftKey);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [wheel, disabled]);
  return (
    <FieldShell label={label} inputId={inputId} hint={hint} error={error || (bad ? rangeMsg : undefined)} success={success}
      size={size} disabled={disabled} focus={focus} prefix={prefix} suffix={suffix} className={className}>
      {(describedBy, invalid) => (
        <input ref={setRefs} id={inputId} className="u434-in is-num" type="text" inputMode="decimal" value={text} disabled={disabled}
          placeholder={placeholder} aria-label={ariaLabel} aria-invalid={invalid || undefined} aria-describedby={describedBy}
          aria-valuemin={min} aria-valuemax={max} aria-valuenow={Number.isFinite(parsed) ? parsed : undefined} role="spinbutton"
          onChange={e => commit(e.target.value)}
          {...rest}
          onKeyDown={e => { onKeyDown?.(e); if (!e.defaultPrevented && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); bump(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey); } }}
          onFocus={e => { setFocus(true); onFocus?.(e); }}
          onBlur={e => { setFocus(false); if (Number.isFinite(parsed)) setText(showNum(parsed, decimals)); onBlur?.(e); }} />
      )}
    </FieldShell>
  );
});
NumberInput.displayName = 'NumberInput';

// <NativeSelect label? value onChange(value, event) options={[{ value, label, disabled? }] | string[]}
//   placeholder? size="sm|md|compact" disabled? hint? error? ariaLabel? ...selectProps />
// A real <select> in TextInput's shell (#434: same height, ring, focus glow, label and hint row), for
// dense forms and table cells where a native picker (OS list, type-to-jump, mobile wheel) is better
// than the custom #031 listbox. onChange gets the option's original value (a number stays a number).
// `placeholder` adds an empty first option that can't be re-chosen.
const NativeSelect = React.forwardRef(({
  label, value, onChange, options = [], placeholder, hint, error, success, size = 'md', id, className, disabled,
  ariaLabel, onFocus, onBlur, ...rest
}, ref) => {
  const autoId = useUid('u434s');
  const inputId = id || autoId;
  const [focus, setFocus] = React.useState(false);
  const opts = options.map(o => (o !== null && typeof o === 'object' ? o : { value: o, label: String(o) }));
  const idx = opts.findIndex(o => String(o.value) === String(value));
  return (
    <FieldShell label={label} inputId={inputId} hint={hint} error={error} success={success} size={size}
      disabled={disabled} focus={focus} className={cx('is-select', className)}>
      {(describedBy, invalid) => (
        <>
          <select ref={ref} id={inputId} className="u434-in u434-sel" value={idx >= 0 ? String(idx) : ''} disabled={disabled}
            aria-label={ariaLabel} aria-invalid={invalid || undefined} aria-describedby={describedBy}
            onChange={e => { const o = opts[Number(e.target.value)]; if (o) onChange?.(o.value, e); }}
            {...rest} onFocus={e => { setFocus(true); onFocus?.(e); }} onBlur={e => { setFocus(false); onBlur?.(e); }}>
            {(placeholder != null || idx < 0) && <option value="" disabled>{placeholder ?? ''}</option>}
            {opts.map((o, i) => <option key={String(o.value)} value={String(i)} disabled={o.disabled}>{o.label}</option>)}
          </select>
          <svg className="u434-car" viewBox="0 0 18 18" aria-hidden="true"><path d="M4.5 7l4.5 4.5L13.5 7" /></svg>
        </>
      )}
    </FieldShell>
  );
});
NativeSelect.displayName = 'NativeSelect';

export { SearchInput, TextInput, NumberInput, NativeSelect };
