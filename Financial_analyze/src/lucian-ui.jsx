// Lucian UX/UI base components, ported to React (Babel standalone, no build step).
// Each component is ported from one Lucian element; its license line precedes it.
// Styles live in src/lucian-ui.css (the --ux-* tokens point at the app's theme variables).
// Every listener added outside the component's own DOM, timer, rAF loop and observer is undone
// on unmount (StrictMode-safe).

const lxUid = prefix => prefix + '-' + Math.random().toString(36).slice(2, 7);
const lxReducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
// Text width in px for SVG labels (SVG text cannot ellipsize): canvas measure, rough fallback.
const LX_FONT = "Inter, system-ui, sans-serif";
let lxCanvas = null;
const lxMeasure = (text, font) => {
  try {
    if (!lxCanvas) lxCanvas = document.createElement('canvas').getContext('2d');
    lxCanvas.font = font;
    return lxCanvas.measureText(String(text)).width;
  } catch { return String(text).length * 6.5; }
};
const lxFit = (text, max, font) => {
  const t = String(text || '');
  if (max <= 0) return '';
  if (lxMeasure(t, font) <= max) return t;
  let lo = 0, hi = t.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lxMeasure(t.slice(0, mid) + '…', font) <= max) lo = mid; else hi = mid - 1; }
  return lo > 0 ? t.slice(0, lo).trimEnd() + '…' : '';
};

// Lucian UX/UI Prompt #031 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#031
// Custom select listbox. Props: { value, options:[{value,label,hint?,badge?,color?}], onChange, label,
// placeholder?, disabled?, ariaLabel? }. Arrow keys glide the highlight, Home/End, Enter/Space choose,
// Escape closes, typing letters jumps to matching options.
const LxSelect = ({ value, options = [], onChange, label, placeholder = 'Choose…', disabled = false, ariaLabel }) => {
  const uid = React.useMemo(() => lxUid('u031'), []);
  const rootRef = React.useRef(null);
  const btnRef = React.useRef(null);
  const listRef = React.useRef(null);
  const valueRef = React.useRef(null);
  const typed = React.useRef({ text: '', timer: 0 });
  const lastValue = React.useRef(value);
  const [open, setOpen] = React.useState(false);
  const sel = options.findIndex(o => String(o.value) === String(value));
  const [act, setAct] = React.useState(Math.max(0, sel));
  const current = sel >= 0 ? options[sel] : null;

  const close = React.useCallback(refocus => {
    setOpen(false);
    if (refocus) btnRef.current?.focus({ preventScroll: true });
  }, []);
  const openList = () => {
    if (disabled || !options.length) return;
    setAct(Math.max(0, sel));
    setOpen(true);
  };
  const choose = i => {
    const option = options[i];
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
    if (e.key === 'ArrowDown') { e.preventDefault(); setAct(a => Math.min(options.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAct(a => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setAct(0); }
    else if (e.key === 'End') { e.preventDefault(); setAct(options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(act); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
    else if (e.key.length === 1) {
      typed.current.text += e.key.toLowerCase();
      clearTimeout(typed.current.timer);
      typed.current.timer = setTimeout(() => { typed.current.text = ''; }, 600);
      const t = typed.current.text;
      const hit = options.findIndex(o => String(o.label).toLowerCase().indexOf(t) === 0 || String(o.badge || '').toLowerCase().indexOf(t) === 0);
      if (hit >= 0) setAct(hit);
    }
  };

  return <div ref={rootRef} className={`ux u031${open ? ' is-open' : ''}`}>
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
        {options.map((o, i) => <li key={String(o.value)} id={`${uid}-${i}`} className="u031-o" role="option" aria-selected={i === sel ? 'true' : 'false'}
          onPointerMove={() => { if (act !== i) setAct(i); }} onClick={() => choose(i)}>
          {o.badge && <span className="u031-flag" style={{ '--c': o.color || 'var(--ux-accent)' }} aria-hidden="true">{o.badge}</span>}
          <span className="u031-ot">{o.label}{o.hint && <small>{o.hint}</small>}</span>
          <svg className="u031-ck" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 9.5l3.5 3.5L14 6" /></svg>
        </li>)}
      </ul>
    </div>
  </div>;
};

// Lucian UX/UI Prompt #042 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#042
// Step-by-step wizard. Props: { steps:[{id,title,label?,description?,bare?,render,canNext}], onFinish, busy,
// finishLabel?, ariaLabel?, header? }. header is an optional slot above the step circles (title, close). The progress line fills to the current circle, finished circles turn
// into checks (press one to go back), content slides in the direction of travel, and the last step's
// button becomes finishLabel. Next is disabled while the step's canNext is false or busy is true.
const LxWizard = ({ steps = [], onFinish, busy = false, finishLabel = 'Finish', ariaLabel = 'Steps', header = null }) => {
  const [cur, setCur] = React.useState(0);
  const [leaving, setLeaving] = React.useState(null); // { index, dir }
  const curRef = React.useRef(null);
  const leaveRef = React.useRef(null);
  const timer = React.useRef(0);
  const moved = React.useRef(0); // direction of the last move, 0 before the first one
  const last = steps.length - 1;
  const step = steps[Math.min(cur, last)];

  const go = i => {
    if (i < 0 || i > last || i === cur) return;
    const dir = i > cur ? 1 : -1;
    moved.current = dir;
    clearTimeout(timer.current);
    setLeaving({ index: cur, dir });
    setCur(i);
    timer.current = setTimeout(() => setLeaving(null), 560);
  };
  React.useEffect(() => () => clearTimeout(timer.current), []);
  React.useLayoutEffect(() => {
    const dir = moved.current;
    const p = curRef.current;
    if (p && dir) {
      p.style.transition = 'none';
      p.style.transform = `translateX(${dir * 40}%)`; p.style.opacity = '0';
      void p.offsetWidth;
      p.style.transition = '';
      p.style.transform = 'none'; p.style.opacity = '1';
      p.scrollTop = 0;
    }
    const old = leaveRef.current;
    if (old && leaving) {
      old.inert = true;
      old.style.transition = 'none'; old.style.transform = 'none'; old.style.opacity = '1';
      void old.offsetWidth;
      old.style.transition = '';
      old.style.transform = `translateX(${-leaving.dir * 40}%)`; old.style.opacity = '0';
    }
  }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!step) return null;
  const canNext = !busy && step.canNext !== false;
  const isLast = cur === last;
  const pane = (s, k, ref, on) => <section key={s.id} ref={ref} className={`u042-pane${on ? ' on' : ''}`} aria-hidden={on ? 'false' : 'true'}>
    {!s.bare && <h4>{s.title}</h4>}
    {!s.bare && s.description && <p>{s.description}</p>}
    {s.render()}
  </section>;

  return <div className={`ux u042${isLast ? ' is-last' : ''}`}>
    {header}
    <ol className="u042-steps" aria-label={ariaLabel}>
      <li className="u042-line" aria-hidden="true" style={{ '--p': last > 0 ? (cur / last).toFixed(3) : 0 }}><i /></li>
      {steps.map((s, k) => {
        const name = s.label || s.title;
        return <li key={s.id} className={`u042-st${k < cur ? ' done' : ''}${k === cur ? ' cur' : ''}`}>
          <button className="u042-dot" type="button" tabIndex={k < cur ? 0 : -1}
            aria-current={k === cur ? 'step' : undefined}
            aria-label={`Step ${k + 1}, ${name}${k < cur ? ', done. Press to go back' : k === cur ? ', current step' : ''}`}
            onClick={() => { if (k < cur) go(k); }}>
            <span>{k + 1}</span><svg viewBox="0 0 16 16"><path d="M3.5 8.4l3 3 6-6.4" /></svg>
          </button>
          <small>{name}</small>
        </li>;
      })}
    </ol>
    <div className="u042-view" aria-live="polite">
      {leaving && steps[leaving.index] && pane(steps[leaving.index], leaving.index, leaveRef, false)}
      {pane(step, cur, curRef, true)}
    </div>
    <div className="u042-foot">
      <button className="u042-b u042-prev" type="button" aria-disabled={cur === 0 ? 'true' : 'false'} onClick={() => go(cur - 1)}>Back</button>
      <button className="u042-b u042-next" type="button" disabled={!canNext}
        onClick={() => { if (!canNext) return; if (isLast) onFinish?.(); else go(cur + 1); }}>
        {isLast ? (busy ? 'Working…' : finishLabel) : 'Next'}
      </button>
    </div>
  </div>;
};

// Lucian UX/UI Prompt #047 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#047
// Period segmented control. Props: { value, options:[{value,label}] | string[], onChange, ariaLabel? }.
// The knob stretches toward the new option (leading edge fast, trailing edge springs); left/right
// arrows move the choice.
const LxSegmented = ({ value, options = [], onChange, ariaLabel = 'Choose one' }) => {
  const opts = options.map(o => (typeof o === 'object' ? o : { value: o, label: String(o) }));
  const segRef = React.useRef(null);
  const knobRef = React.useRef(null);
  const btnRefs = React.useRef([]);
  const prevIndex = React.useRef(-1);
  const index = Math.max(0, opts.findIndex(o => String(o.value) === String(value)));

  const place = React.useCallback(dir => {
    const seg = segRef.current, knob = knobRef.current, o = btnRefs.current[index];
    if (!seg || !knob || !o) return;
    seg.classList.toggle('go-r', dir > 0);
    seg.classList.toggle('go-l', dir < 0);
    knob.style.setProperty('--l', o.offsetLeft + 'px');
    knob.style.setProperty('--r', (seg.clientWidth - o.offsetLeft - o.offsetWidth) + 'px');
  }, [index]);
  React.useLayoutEffect(() => {
    const dir = prevIndex.current < 0 ? 0 : index > prevIndex.current ? 1 : index < prevIndex.current ? -1 : 0;
    prevIndex.current = index;
    place(dir);
  }, [index, place]);
  React.useEffect(() => {
    if (!('ResizeObserver' in window) || !segRef.current) return undefined;
    const ro = new ResizeObserver(() => place(0));
    ro.observe(segRef.current);
    return () => ro.disconnect();
  }, [place]);

  const select = (i, focus) => {
    if (focus) btnRefs.current[i]?.focus();
    if (i !== index) onChange?.(opts[i].value);
  };
  return <div className="ux u047">
    <div ref={segRef} className="u047-seg" role="radiogroup" aria-label={ariaLabel} style={{ gridTemplateColumns: `repeat(${opts.length || 1},1fr)` }}>
      <span ref={knobRef} className="u047-knob" aria-hidden="true" />
      {opts.map((o, i) => <button key={String(o.value)} ref={el => { btnRefs.current[i] = el; }} className="u047-opt" type="button" role="radio"
        aria-checked={i === index ? 'true' : 'false'} tabIndex={i === index ? 0 : -1}
        onClick={() => select(i)}
        onKeyDown={e => {
          const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
          if (d) { e.preventDefault(); select((i + d + opts.length) % opts.length, true); }
        }}>{o.label}</button>)}
    </div>
  </div>;
};

// Lucian UX/UI Prompt #029 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#029
// Colored tag input. Props: { items:[{key,label,color?}], suggestions:[{key,label}], onAdd(suggestion),
// onRemove(key), placeholder?, label?, ariaLabel?, max?, maxMessage?, allowFree?, idleSuggestions? (chips shown
// before anything is typed; default 12) }. Enter adds the first suggestion that matches
// the typed text (or the text itself when allowFree); suggestion chips add on press; in an empty field
// Backspace once arms the last tag and a second press removes it.
const LX_TAG_PALETTE = ['#7B61FF', '#E0457B', '#0E9F8E', '#D6731E', '#2F7FE0', '#B04FD0'];
const lxColorOf = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return LX_TAG_PALETTE[h % LX_TAG_PALETTE.length]; };
const lxFold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

const LxTagInput = ({ items = [], suggestions = [], onAdd, onRemove, placeholder = 'Type, press Enter', label, ariaLabel, max, maxMessage, allowFree = false, idleSuggestions = 12 }) => {
  const fieldRef = React.useRef(null);
  const inputRef = React.useRef(null);
  const timers = React.useRef(new Set());
  const [text, setText] = React.useState('');
  const [armed, setArmed] = React.useState(null);
  const [leaving, setLeaving] = React.useState([]);
  const [msg, setMsg] = React.useState({ text: '', warn: false });
  React.useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear(); }, []);
  const later = (fn, ms) => { const t = setTimeout(() => { timers.current.delete(t); fn(); }, ms); timers.current.add(t); };
  const msgTimer = React.useRef(0);
  const say = (t, warn) => {
    setMsg({ text: t, warn: !!warn });
    if (msgTimer.current) { clearTimeout(msgTimer.current); timers.current.delete(msgTimer.current); }
    const id = setTimeout(() => { timers.current.delete(id); setMsg({ text: '', warn: false }); }, 1800);
    msgTimer.current = id; timers.current.add(id);
  };
  const shake = () => { const f = fieldRef.current; if (!f) return; f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake'); };

  const have = new Set(items.map(i => String(i.key)));
  const q = lxFold(text.trim());
  const visible = suggestions.filter(s => !q || lxFold(s.label).includes(q)).slice(0, q ? 12 : idleSuggestions);
  const add = s => {
    if (!s) return false;
    if (max && items.length >= max) { say(maxMessage || `You can add up to ${max}`, true); shake(); return false; }
    if (have.has(String(s.key))) { say(`${s.label} is already added`, true); return false; }
    setArmed(null);
    onAdd?.(s);
    say(`Added ${s.label}`);
    return true;
  };
  const remove = key => {
    if (leaving.includes(key)) return;
    const item = items.find(i => String(i.key) === String(key));
    setLeaving(l => [...l, key]);
    if (item) say(`Removed ${item.label}`);
    later(() => { setLeaving(l => l.filter(k => k !== key)); onRemove?.(key); }, 280);
  };
  const onKey = e => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const raw = text.trim();
      if (!raw) return;
      const exact = suggestions.find(s => lxFold(s.label) === q && !have.has(String(s.key)));
      const pick = exact || visible.find(s => !have.has(String(s.key))) || (allowFree ? { key: raw, label: raw } : null);
      if (!pick) { say(`Nothing matches “${raw}”`, true); return; }
      if (add(pick)) setText('');
    } else if (e.key === 'Backspace' && !text) {
      const live = items.filter(i => !leaving.includes(i.key));
      const lastItem = live[live.length - 1];
      if (!lastItem) return;
      if (armed === lastItem.key) remove(lastItem.key); else setArmed(lastItem.key);
    } else setArmed(null);
  };

  return <div className="ux u029">
    {label && <div className="u029-head"><b>{label}</b>{max ? <span className={`u029-n${items.length >= max ? ' full' : ''}`}>{items.length} / {max}</span> : null}</div>}
    <div ref={fieldRef} className="u029-field" onClick={e => { if (e.target === fieldRef.current) inputRef.current?.focus(); }}
      onAnimationEnd={e => { if (e.target === fieldRef.current) fieldRef.current.classList.remove('shake'); }}>
      {items.map(item => <span key={item.key} className={`u029-tag${leaving.includes(item.key) ? ' out' : ''}${armed === item.key ? ' armed' : ''}`}
        style={{ '--c': item.color || lxColorOf(String(item.key)) }}>
        <span>{item.label}</span>
        <button type="button" className="u029-x" aria-label={`Remove ${item.label}`} onClick={() => { remove(item.key); inputRef.current?.focus(); }}>
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8" /></svg>
        </button>
      </span>)}
      <input ref={inputRef} className="u029-in" type="text" value={text} placeholder={placeholder} aria-label={ariaLabel || (label ? `Add to ${label}` : 'Add')}
        autoComplete="off" onChange={e => setText(e.target.value)} onKeyDown={onKey} onBlur={() => setArmed(null)} />
    </div>
    <p className={`u029-msg${msg.warn ? ' warn' : ''}`} aria-live="polite">{msg.text}</p>
    {visible.length > 0 && <div className="u029-sg-row" role="group" aria-label="Suggestions">
      {visible.map(s => <button key={s.key} type="button" className={`u029-sg${have.has(String(s.key)) ? ' used' : ''}`} aria-label={`Add ${s.label}`} onClick={() => { if (add(s)) setText(''); }}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v8M2 6h8" /></svg>{s.label}
      </button>)}
    </div>}
  </div>;
};

// Lucian UX/UI Prompt #273 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#273
// Detail side panel. Props: { open, title, onClose, onPrev?, onNext?, indexLabel?, subtitle?,
// contentKey?, children }. Slides in from the right over a dimmed overlay; the arrows (or J / K) step
// to the previous / next item and the content swaps up or down in that direction; Esc or a press
// outside tucks it back in and focus returns to where it was.
const LxSidePanel = ({ open, title, subtitle, onClose, onPrev, onNext, indexLabel, contentKey, children }) => {
  const closeRef = React.useRef(null);
  const pageRef = React.useRef(null);
  const returnTo = React.useRef(null);
  const dir = React.useRef(0);
  const firstKey = React.useRef(true);
  // Callbacks live in a ref so a parent re-render (inline arrows) does not re-run the open effect,
  // which would bounce focus back to the opener and then to the close button on every J / K.
  const handlers = React.useRef({ onClose, onPrev, onNext });
  handlers.current = { onClose, onPrev, onNext };

  React.useEffect(() => {
    if (!open) return undefined;
    returnTo.current = document.activeElement;
    const t = setTimeout(() => closeRef.current?.focus({ preventScroll: true }), 30);
    const onKey = e => {
      const h = handlers.current;
      if (e.key === 'Escape') { e.preventDefault(); h.onClose?.(); return; }
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '') || e.target?.isContentEditable) return;
      if ((e.key === 'j' || e.key === 'J') && h.onNext) { dir.current = 1; h.onNext(); }
      if ((e.key === 'k' || e.key === 'K') && h.onPrev) { dir.current = -1; h.onPrev(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      const back = returnTo.current;
      if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
    };
  }, [open]);
  // Content swap: the new page enters from the side we moved toward.
  React.useLayoutEffect(() => {
    if (firstKey.current) { firstKey.current = false; return; }
    const p = pageRef.current, d = dir.current;
    dir.current = 0;
    if (!p || !d || !open || lxReducedMotion()) return;
    p.classList.add('is-in'); p.style.transform = `translateY(${d * 40}px)`; p.style.opacity = '0';
    void p.offsetWidth;
    p.classList.remove('is-in'); p.style.transform = ''; p.style.opacity = '';
  }, [contentKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className={`ux u273${open ? ' is-open' : ''}`}>
    <div className="u273-ov" aria-hidden="true" onClick={() => onClose?.()} />
    <aside className="u273-pn" role="dialog" aria-modal="false" aria-label={title || 'Details'} aria-hidden={open ? 'false' : 'true'}>
      <div className="u273-tb">
        <button type="button" className="u273-pv" aria-label="Previous" disabled={!onPrev} onClick={() => { dir.current = -1; onPrev?.(); }}><svg viewBox="0 0 11 11" aria-hidden="true"><path d="M2 7l3.5-3.5L9 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
        <button type="button" className="u273-nx" aria-label="Next" disabled={!onNext} onClick={() => { dir.current = 1; onNext?.(); }}><svg viewBox="0 0 11 11" aria-hidden="true"><path d="M2 4l3.5 3.5L9 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
        <span className="u273-ix">{indexLabel || ''}</span>
        <button ref={closeRef} type="button" className="u273-x" aria-label="Close panel" onClick={() => onClose?.()}><svg viewBox="0 0 11 11" aria-hidden="true"><path d="M2.5 2.5l6 6M8.5 2.5l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></button>
      </div>
      <div className="u273-bd" aria-live="polite">
        <div ref={pageRef} className="u273-pg">
          {title && <h4>{title}</h4>}
          {subtitle && <small>{subtitle}</small>}
          {children}
        </div>
      </div>
    </aside>
  </div>;
};

// Lucian UX/UI Prompt #400 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#400
// Synced-cursor small multiples. Props: { series:[{key,name,color,points:[{x,y,status,origin}]}],
// xs? (ordered x values; default: union of the points' x in first-seen order), onPointClick(series, point),
// formatValue(y, series), formatX?(x), title? }. Charts stack on one x axis, each with its own scale;
// lines draw left to right on first view; one crosshair sweeps all charts. Each chart's title reads
// "name · value · change since the first period" (value = latest, or the cursor's period while hovering;
// a calculated value gets "· calc."); long names are cut to fit. Solid point = printed, hollow =
// calculated (origin), danger ring on the baseline + "⚠ sources differ" = open conflict (status
// 'conflict', no value plotted). Colours may be CSS var() strings. Keyboard: ←/→ move the cursor,
// ↑/↓ pick a chart, Enter opens that point, Esc clears.
const LxSmallMultiples = ({ series = [], xs, onPointClick, formatValue = v => String(v), formatX = x => String(x), title = '' }) => {
  const rootRef = React.useRef(null);
  const ovRef = React.useRef(null);
  const clipRef = React.useRef(null);
  const uid = React.useMemo(() => lxUid('u400'), []);
  const [W, setW] = React.useState(300);
  const [hov, setHov] = React.useState(-1);
  const [band, setBand] = React.useState(-1);

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    setW(Math.max(240, Math.round(el.clientWidth)));
    if (!('ResizeObserver' in window)) return undefined;
    const ro = new ResizeObserver(es => setW(Math.max(240, Math.round(es[0].contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const X_ = React.useMemo(() => {
    if (xs && xs.length) return xs;
    const seen = [];
    series.forEach(s => (s.points || []).forEach(p => { if (!seen.some(x => String(x) === String(p.x))) seen.push(p.x); }));
    return seen;
  }, [xs, series]);
  const N = X_.length;
  const XL = 22, XR = W - 18, TOP = 74, STEP = 86, PH = 50;
  const H = TOP + series.length * STEP + 40;
  const at = (s, i) => (s.points || []).find(p => String(p.x) === String(X_[i])) || null;
  const X = i => (N <= 1 ? (XL + XR) / 2 : XL + i / (N - 1) * (XR - XL));
  const ranges = series.map(s => {
    const ys = (s.points || []).map(p => p.y).filter(y => y !== null && y !== undefined && isFinite(y));
    if (!ys.length) return [0, 1];
    let mn = Math.min(...ys), mx = Math.max(...ys);
    if (mn === mx) { mn -= Math.abs(mn) * 0.1 || 1; mx += Math.abs(mx) * 0.1 || 1; }
    const pad = (mx - mn) * 0.1;
    return [mn - pad, mx + pad];
  });
  const Y = (k, v) => { const r = ranges[k], t = TOP + k * STEP + 22; return t + PH - (v - r[0]) / (r[1] - r[0]) * PH; };
  const has = p => p && p.y !== null && p.y !== undefined && isFinite(p.y);
  const linePath = (s, k) => {
    let d = '', pen = false;
    for (let i = 0; i < N; i++) {
      const p = at(s, i);
      // Any period without a plotted value (missing, or an open conflict) breaks the line: never
      // draw a segment that implies numbers that are not there. Isolated points stay as markers.
      if (!has(p)) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(k, p.y).toFixed(1) + ' ';
      pen = true;
    }
    return d.trim();
  };
  const lastIndex = s => { for (let i = N - 1; i >= 0; i--) if (has(at(s, i))) return i; return -1; };
  const firstIndex = s => { for (let i = 0; i < N; i++) if (has(at(s, i))) return i; return -1; };

  // Draw-in: the clip rect grows left to right once the charts scroll into view.
  React.useEffect(() => {
    const rect = clipRef.current, root = rootRef.current;
    if (!rect || !root) return undefined;
    if (lxReducedMotion() || !('IntersectionObserver' in window)) { rect.setAttribute('width', '100%'); return undefined; }
    let raf = 0, done = false;
    const io = new IntersectionObserver(es => {
      if (!es[0].isIntersecting || done) return;
      done = true; io.disconnect();
      const t0 = performance.now();
      const f = now => {
        const k = Math.min(1, (now - t0) / 1000), e = 1 - Math.pow(1 - k, 3);
        const w = root.clientWidth || 300;
        rect.setAttribute('width', (XL + (w - 18 - XL + 4) * e).toFixed(1));
        if (k < 1) raf = requestAnimationFrame(f); else rect.setAttribute('width', '100%');
      };
      raf = requestAnimationFrame(f);
    });
    io.observe(root);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  const pick = e => {
    const r = ovRef.current.getBoundingClientRect();
    const x = (e.clientX - r.left) + 12;
    const i = N <= 1 ? 0 : Math.max(0, Math.min(N - 1, Math.round((x - XL) / (XR - XL) * (N - 1))));
    const k = Math.max(0, Math.min(series.length - 1, Math.floor((e.clientY - r.top) / STEP)));
    return { i, k };
  };
  const openPoint = (k, i) => {
    const s = series[k];
    const p = s && at(s, i);
    if (s && p) onPointClick?.(s, p);
  };
  const shown = hov < 0 ? -1 : hov;
  const dtText = N === 0 ? 'No periods' : shown < 0 ? `Latest · ${formatX(X_[N - 1])}` : formatX(X_[shown]);
  const ticks = N <= 4 ? X_.map((_, i) => i) : [0, Math.round((N - 1) / 3), Math.round(2 * (N - 1) / 3), N - 1];

  return <div ref={rootRef} className={`ux u400${hov >= 0 ? ' is-hov' : ''}`} style={{ height: H }}>
    <div className="u400-hd"><b>{title}</b></div>
    <div className="u400-dt" aria-live="polite">{dtText}</div>
    <svg className="u400-sv" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <defs><clipPath id={`${uid}c`}><rect ref={clipRef} x="0" y="0" width="0" height={H} /></clipPath></defs>
      <g>
        {series.map((s, k) => {
          const t = TOP + k * STEP, base = TOP + k * STEP + 22 + PH;
          const li = shown < 0 ? lastIndex(s) : shown;
          const p = li >= 0 ? at(s, li) : null;
          const fi = firstIndex(s), lp = lastIndex(s);
          const first = fi >= 0 ? at(s, fi) : null, latest = lp >= 0 ? at(s, lp) : null;
          const chg = first && latest && fi !== lp && first.y !== 0 ? (latest.y - first.y) / Math.abs(first.y) * 100 : null;
          const valueText = q => (has(q) ? formatValue(q.y, s) + (q.origin === 'calculated' ? ' · calc.' : '') : (q && q.status === 'conflict' ? '⚠ sources differ' : '—'));
          const chgText = chg !== null ? `${chg >= 0 ? '+' : ''}${chg.toFixed(0)}% since ${formatX(X_[fi])}` : '';
          // Reserve the widest value this chart can show, so the name does not jump while the cursor moves.
          const widest = Math.max(lxMeasure('—', `900 14px ${LX_FONT}`), ...X_.map((_, i) => lxMeasure(valueText(at(s, i)), `900 14px ${LX_FONT}`)));
          const rightW = widest + (chgText ? lxMeasure(chgText, `850 10px ${LX_FONT}`) + 8 : 0);
          const nameText = lxFit(s.name, XR - XL - rightW - 14, `800 10.5px ${LX_FONT}`);
          const conflictCue = p && !has(p) && p.status === 'conflict';
          return <g key={s.key}>
            <text className="u400-nm" x={XL} y={t + 10}>{nameText}</text>
            <text className="u400-v" x={XR} y={t + 10}>
              <tspan style={conflictCue ? { fill: 'var(--ux-danger)' } : undefined}>{valueText(p)}</tspan>
              {chgText && <tspan className="u400-dl" dx="8" style={{ fill: chg >= 0 ? 'var(--ux-mint)' : 'var(--ux-danger)' }}>{chgText}</tspan>}
            </text>
            <line x1={XL} x2={XR} y1={base} y2={base} stroke="currentColor" strokeOpacity=".1" />
            <g clipPath={`url(#${uid}c)`}>
              <path d={linePath(s, k)} fill="none" style={{ stroke: s.color }} strokeWidth="2" strokeLinejoin="round" />
              {X_.map((x, i) => {
                const q = at(s, i);
                if (!q) return null;
                if (q.status === 'conflict' && !has(q)) {
                  const anchor = N > 1 && i === 0 ? 'start' : N > 1 && i === N - 1 ? 'end' : 'middle';
                  return <g key={i}>
                    <circle className="u400-cf" cx={X(i)} cy={base} r="4.5" />
                    <text className="u400-cfl" x={X(i) + (anchor === 'start' ? -4 : anchor === 'end' ? 4 : 0)} y={base - 8} style={{ textAnchor: anchor }}>⚠ sources differ</text>
                  </g>;
                }
                if (!has(q)) return null;
                return <g key={i}>
                  <circle className={`u400-pt${q.origin === 'calculated' ? ' calc' : ''}`} cx={X(i)} cy={Y(k, q.y)} r="2.6"
                    style={{ fill: q.origin === 'calculated' ? undefined : s.color, stroke: s.color }} />
                  {q.status === 'conflict' && <circle className="u400-cf" cx={X(i)} cy={Y(k, q.y)} r="4.5" />}
                </g>;
              })}
            </g>
            {has(p) && <circle className="u400-dot" r="4" style={{ fill: s.color }} cx={X(li)} cy={Y(k, p.y)} />}
          </g>;
        })}
        {N > 0 && <line className="u400-xh" x1={X(Math.max(0, shown))} x2={X(Math.max(0, shown))} y1={TOP + 14} y2={TOP + Math.max(0, series.length - 1) * STEP + 22 + PH} />}
        {ticks.map(i => <text key={i} className="u400-tk" x={X(i)} y={TOP + Math.max(0, series.length - 1) * STEP + 22 + PH + 14}
          style={N > 1 && i === 0 ? { textAnchor: 'start' } : N > 1 && i === N - 1 ? { textAnchor: 'end' } : undefined}>{formatX(X_[i])}</text>)}
      </g>
    </svg>
    <div ref={ovRef} className="u400-ov" tabIndex={0} role="img" style={{ height: series.length * STEP }}
      aria-label={`${series.map(s => s.name).join(', ')} charts. Use left and right arrows to move between periods, up and down to pick a chart, Enter to open the source.`}
      onPointerMove={e => { const { i } = pick(e); setHov(i); }}
      onPointerDown={e => { const { i } = pick(e); setHov(i); }}
      onPointerLeave={() => setHov(-1)}
      onClick={e => { const { i, k } = pick(e); openPoint(k, i); }}
      onBlur={() => { setHov(-1); setBand(-1); }}
      onKeyDown={e => {
        if (!N) return;
        if (e.key === 'Escape') { setHov(-1); setBand(-1); return; }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPoint(Math.max(0, band), hov < 0 ? N - 1 : hov); return; }
        const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        if (!dx && !dy) return;
        e.preventDefault();
        if (dx) setHov(h => Math.max(0, Math.min(N - 1, (h < 0 ? N - 1 : h) + dx)));
        if (dy) { setBand(b => (b < 0 ? (dy > 0 ? 0 : series.length - 1) : Math.max(0, Math.min(series.length - 1, b + dy)))); setHov(h => (h < 0 ? N - 1 : h)); }
      }}>
      {band >= 0 && <div className="u400-band" style={{ top: band * STEP, height: STEP - 6 }} />}
    </div>
  </div>;
};

// Growth chart (start = 100). No Lucian element matches (spec §6.7a), so it is built from #400's marks,
// tokens, crosshair and draw-in (Lucian UX/UI Prompt #400 · MIT License (c) 2026 Seokwoooo ·
// https://lucianlabs.dev/uxui-prompt/#400). Props: { series:[{key,name,color,points:[{x,y,status,origin}]}],
// xs?, formatValue(y, series), formatX?(x), onPointClick(series, point), title? }.
// One chart, one axis: every line is value / its first value in view × 100. A line whose first value is
// zero or negative cannot be indexed; the legend says so and it is not drawn. The tooltip lists every
// line at the cursor (index first, then the real value). Direct end labels for ≤ 4 lines when they fit
// and do not collide (otherwise the legend carries identity). An open conflict has no value: a danger
// ring + "⚠ sources differ" marks its period in a strip under the period labels. Keyboard: ←/→ move, ↑/↓ pick a line,
// Enter opens the point, Esc clears.
const lxNiceStep = raw => {
  if (!(raw > 0)) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};
const LxGrowthChart = ({ series = [], xs, onPointClick, formatValue = v => String(v), formatX = x => String(x), title = '' }) => {
  const rootRef = React.useRef(null);
  const ovRef = React.useRef(null);
  const clipRef = React.useRef(null);
  const uid = React.useMemo(() => lxUid('lxg'), []);
  const [W, setW] = React.useState(300);
  const [hov, setHov] = React.useState(-1);
  const [band, setBand] = React.useState(-1);

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const inner = el2 => Math.max(240, Math.round(el2.clientWidth - 32));
    setW(inner(el));
    if (!('ResizeObserver' in window)) return undefined;
    const ro = new ResizeObserver(() => setW(inner(el)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const X_ = React.useMemo(() => {
    if (xs && xs.length) return xs;
    const seen = [];
    series.forEach(s => (s.points || []).forEach(p => { if (!seen.some(x => String(x) === String(p.x))) seen.push(p.x); }));
    return seen;
  }, [xs, series]);
  const N = X_.length;
  const has = p => p && p.y !== null && p.y !== undefined && isFinite(p.y);
  const rows = series.map(s => {
    const pts = X_.map(x => (s.points || []).find(p => String(p.x) === String(x)) || null);
    const bi = pts.findIndex(has);
    const base = bi >= 0 ? pts[bi].y : null;
    const ok = base !== null && base > 0;
    return { s, pts, ok, base, vals: pts.map(p => (ok && has(p) ? p.y / base * 100 : null)) };
  });
  const drawn = rows.filter(r => r.ok);

  // Scale: one axis, 100 always in view.
  const all = drawn.flatMap(r => r.vals.filter(v => v !== null));
  let mn = Math.min(100, ...all), mx = Math.max(100, ...all);
  if (mx - mn < 1) { mn -= 5; mx += 5; }
  const step = lxNiceStep((mx - mn) / 4);
  mn = Math.floor(mn / step) * step; mx = Math.ceil(mx / step) * step;
  const ticks = [];
  for (let v = mn; v <= mx + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);

  // Direct labels: ≤ 4 drawn lines, room on the right, no collisions — else none.
  const PH = 220, TOP = 10, XL = 40;
  const labelFont = `750 10.5px ${LX_FONT}`;
  const lastIdx = r => { for (let i = N - 1; i >= 0; i--) if (r.vals[i] !== null) return i; return -1; };
  let labels = null;
  if (drawn.length >= 1 && drawn.length <= 4 && W >= 420) {
    const texts = drawn.map(r => lxFit(r.s.name, 120, labelFont));
    labels = { texts, width: Math.max(...texts.map(t => lxMeasure(t, labelFont))) + 12 };
  }
  const XR = W - (labels ? labels.width : 14);
  const Y = v => TOP + PH - (v - mn) / (mx - mn) * PH;
  const BOTTOM = TOP + PH;
  if (labels) {
    const ys = drawn.map(r => { const i = lastIdx(r); return i >= 0 ? Y(r.vals[i]) : null; });
    const sorted = ys.filter(y => y !== null).sort((a, b) => a - b);
    const collide = sorted.some((y, i) => i > 0 && y - sorted[i - 1] < 13);
    labels = collide || ys.some((y, i) => y !== null && lastIdx(drawn[i]) !== N - 1) ? null : { ...labels, ys };
  }
  const XRf = labels ? XR : W - 14;
  const Xf = i => (N <= 1 ? (XL + XRf) / 2 : XL + i / (N - 1) * (XRf - XL));
  const linePath = r => {
    let d = '', pen = false;
    for (let i = 0; i < N; i++) {
      const v = r.vals[i];
      if (v === null) { pen = false; continue; } // missing period or open conflict: break, never bridge
      d += (pen ? 'L' : 'M') + Xf(i).toFixed(1) + ' ' + Y(v).toFixed(1) + ' ';
      pen = true;
    }
    return d.trim();
  };

  React.useEffect(() => {
    const rect = clipRef.current, root = rootRef.current;
    if (!rect || !root) return undefined;
    if (lxReducedMotion() || !('IntersectionObserver' in window)) { rect.setAttribute('width', '100%'); return undefined; }
    let raf = 0, done = false;
    const io = new IntersectionObserver(es => {
      if (!es[0].isIntersecting || done) return;
      done = true; io.disconnect();
      const t0 = performance.now();
      const f = now => {
        const k = Math.min(1, (now - t0) / 1000), e = 1 - Math.pow(1 - k, 3);
        const w = Math.max(240, (root.clientWidth || 300) - 32);
        rect.setAttribute('width', (XL + (w - XL + 4) * e).toFixed(1));
        if (k < 1) raf = requestAnimationFrame(f); else rect.setAttribute('width', '100%');
      };
      raf = requestAnimationFrame(f);
    });
    io.observe(root);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  const pickI = e => {
    const r = ovRef.current.getBoundingClientRect();
    const x = e.clientX - r.left + XL;
    return N <= 1 ? 0 : Math.max(0, Math.min(N - 1, Math.round((x - XL) / (XRf - XL) * (N - 1))));
  };
  // Open conflicts have no value, so they sit in a strip under the period labels, never on the scale.
  const cueAt = i => rows.some(r => r.pts[i] && r.pts[i].status === 'conflict' && r.vals[i] === null && r.ok);
  const hasCue = X_.some((_, i) => cueAt(i));
  const SVG_H = BOTTOM + 26 + (hasCue ? 22 : 0), CUE_Y = BOTTOM + 34;
  const pickRow = (i, py) => {
    let best = -1, dist = Infinity;
    rows.forEach((r, k) => {
      const p = r.pts[i];
      if (!p) return;
      const y = r.vals[i] !== null ? Y(r.vals[i]) : (p.status === 'conflict' ? CUE_Y : null);
      if (y === null) return;
      const d = Math.abs(y - py);
      if (d < dist) { dist = d; best = k; }
    });
    return best;
  };
  const openPoint = (k, i) => {
    const r = rows[k];
    const p = r && r.pts[i];
    if (r && p) onPointClick?.(r.s, p);
  };
  const shown = hov;
  const dtText = N === 0 ? 'No periods' : shown < 0 ? `${formatX(X_[0])} – ${formatX(X_[N - 1])} · start = 100` : formatX(X_[shown]);
  const xt = N <= 4 ? X_.map((_, i) => i) : [0, Math.round((N - 1) / 3), Math.round(2 * (N - 1) / 3), N - 1];
  const tipLeft = shown >= 0 ? (Xf(shown) > W / 2 ? null : Xf(shown) + 12) : null;
  const tipRight = shown >= 0 && Xf(shown) > W / 2 ? W - Xf(shown) + 12 : null;

  return <div ref={rootRef} className={`ux lxg${hov >= 0 ? ' is-hov' : ''}${band >= 0 ? ' has-band' : ''}`}>
    <div className="lxg-hd"><b>{title}</b></div>
    <div className="lxg-dt" aria-live="polite">{dtText}</div>
    {(rows.length > 1 || rows.some(r => !r.ok)) && <ul className="lxg-lg" aria-label="Legend">
      {rows.map(r => <li key={r.s.key} className={r.ok ? '' : 'off'}>
        <i style={{ background: r.s.color }} aria-hidden="true" />{r.s.name}{!r.ok && <small> · can't index (first value is zero, negative or missing)</small>}
      </li>)}
    </ul>}
    <div className="lxg-plot" style={{ height: SVG_H }}>
      <svg className="lxg-sv" width={W} height={SVG_H} viewBox={`0 0 ${W} ${SVG_H}`} aria-hidden="true">
        <defs><clipPath id={`${uid}c`}><rect ref={clipRef} x="0" y="0" width="0" height={SVG_H} /></clipPath></defs>
        {ticks.map(v => <g key={v}>
          <line className={v === 100 ? 'lxg-base' : 'lxg-grid'} x1={XL} x2={XRf} y1={Y(v)} y2={Y(v)} />
          <text className="lxg-yt" x={XL - 6} y={Y(v) + 3}>{v}</text>
        </g>)}
        <g clipPath={`url(#${uid}c)`}>
          {rows.map((r, k) => r.ok && <g key={r.s.key} className={band >= 0 && band !== k ? 'lxg-dim' : ''}>
            <path d={linePath(r)} fill="none" style={{ stroke: r.s.color }} strokeWidth={band === k ? 3 : 2} strokeLinejoin="round" strokeLinecap="round" />
            {r.pts.map((p, i) => {
              if (!p || r.vals[i] === null) return null;
              const calc = p.origin === 'calculated';
              return <g key={i}>
                <circle className={`lxg-pt${calc ? ' calc' : ''}`} cx={Xf(i)} cy={Y(r.vals[i])} r={calc ? 3.5 : 4}
                  style={calc ? { stroke: r.s.color } : { fill: r.s.color }} />
                {p.status === 'conflict' && <circle className="lxg-cf" cx={Xf(i)} cy={Y(r.vals[i])} r="6.5" />}
              </g>;
            })}
          </g>)}
        </g>
        {X_.map((_, i) => {
          if (!cueAt(i)) return null;
          const end = N > 1 && i === N - 1;
          return <g key={`cue${i}`}>
            <circle className="lxg-cf" cx={Xf(i)} cy={CUE_Y} r="4.5" />
            <text className="lxg-cfl" x={Xf(i) + (end ? -9 : 9)} y={CUE_Y + 3.5} style={{ textAnchor: end ? 'end' : 'start' }}>⚠ sources differ</text>
          </g>;
        })}
        {labels && drawn.map((r, j) => <text key={r.s.key} className="lxg-dl" x={XRf + 8} y={labels.ys[j] + 3.5}>{labels.texts[j]}</text>)}
        {N > 0 && <line className="lxg-xh" x1={Xf(Math.max(0, shown))} x2={Xf(Math.max(0, shown))} y1={TOP} y2={BOTTOM} />}
        {shown >= 0 && rows.map(r => (r.ok && r.vals[shown] !== null
          ? <circle key={r.s.key} className="lxg-dot" r="5" style={{ fill: r.s.color }} cx={Xf(shown)} cy={Y(r.vals[shown])} /> : null))}
        {xt.map(i => <text key={i} className="lxg-tk" x={Xf(i)} y={BOTTOM + 16}
          style={N > 1 && i === 0 ? { textAnchor: 'start' } : N > 1 && i === N - 1 ? { textAnchor: 'end' } : undefined}>{formatX(X_[i])}</text>)}
      </svg>
      <div ref={ovRef} className="lxg-ov" tabIndex={0} role="img" style={{ left: XL, width: Math.max(1, XRf - XL), top: TOP, height: hasCue ? CUE_Y + 9 - TOP : PH }}
        aria-label={`Growth since the first period, start = 100: ${rows.map(r => r.s.name).join(', ')}. Use left and right arrows to move between periods, up and down to pick a line, Enter to open the source.`}
        onPointerMove={e => setHov(pickI(e))}
        onPointerDown={e => setHov(pickI(e))}
        onPointerLeave={() => setHov(-1)}
        onClick={e => {
          const i = pickI(e);
          const k = pickRow(i, e.clientY - ovRef.current.getBoundingClientRect().top + TOP);
          if (k >= 0) openPoint(k, i);
        }}
        onBlur={() => { setHov(-1); setBand(-1); }}
        onKeyDown={e => {
          if (!N) return;
          if (e.key === 'Escape') { setHov(-1); setBand(-1); return; }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const i = hov < 0 ? N - 1 : hov;
            const k = band >= 0 ? band : rows.findIndex(r => r.pts[i]);
            if (k >= 0) openPoint(k, i);
            return;
          }
          const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
          if (!dx && !dy) return;
          e.preventDefault();
          if (dx) setHov(h => Math.max(0, Math.min(N - 1, (h < 0 ? N - 1 : h) + dx)));
          if (dy) { setBand(b => (b < 0 ? (dy > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, b + dy)))); setHov(h => (h < 0 ? N - 1 : h)); }
        }} />
      {shown >= 0 && <div className="lxg-tip" style={{ left: tipLeft ?? 'auto', right: tipRight ?? 'auto' }} aria-hidden="true">
        <div className="lxg-tip-h">{formatX(X_[shown])}</div>
        {rows.map((r, k) => {
          const p = r.pts[shown];
          const v = r.vals[shown];
          return <div key={r.s.key} className={`lxg-row${band === k ? ' on' : ''}`}>
            <i style={{ background: r.s.color }} />
            <b>{v !== null ? Math.round(v) : (p && p.status === 'conflict' ? '⚠' : '—')}</b>
            <span>{has(p) ? formatValue(p.y, r.s) + (p.origin === 'calculated' ? ' · calc.' : '') : (p && p.status === 'conflict' ? 'sources differ' : 'no value')}</span>
            <small>{r.s.name}</small>
          </div>;
        })}
      </div>}
    </div>
  </div>;
};

// Text field in the #031 select's look (label, height, radius, focus ring) for forms mixing both.
const LxTextField = ({ label, value, onChange, placeholder, uppercase = false }) => {
  const uid = React.useMemo(() => lxUid('u031in'), []);
  return <div className="ux u031">
    <div className="u031-f">
      {label && <label className="u031-lab" htmlFor={uid}>{label}</label>}
      <input id={uid} className="u031-in" value={value || ''} placeholder={placeholder}
        onChange={e => onChange(uppercase ? e.target.value.toUpperCase() : e.target.value)} />
    </div>
  </div>;
};

Object.assign(window, { LxSelect, LxTextField, LxWizard, LxSegmented, LxTagInput, LxSidePanel, LxSmallMultiples, LxGrowthChart });
