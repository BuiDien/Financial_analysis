// Lucian UX/UI Prompt #029 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#029
import React from 'react';
import { lxUid, lxReducedMotion } from './util.js';
import './tag-input.css';

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

export { LxTagInput };
