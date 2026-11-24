// Lucian UX/UI Prompt #435 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#435
// App-wide toasts. A toast springs up from below, its icon draws itself and a thin time bar runs down.
// Up to three stack like a deck; hover or focus fans them out and pauses the timers. Flick one
// sideways or press × to dismiss; Esc dismisses the focused one.
//
//   import { toast } from './ui';
//   toast('Saved', { type: 'success' });          // type: success | error | info (default)
//   toast('Failed', 'error');                     // string shorthand for { type }
//   toast('Deleted', { action: { label: 'Undo', onClick: restore } });
//   toast('Uploading…', { duration: 0 });         // 0 = stays until dismissed
//   toast.dismiss(id);
// Mount <ToastHost /> once at the app root. Calls made before it mounts are queued.
// Dedupe: a toast with the same message and type as one still on screen does not stack a copy; the
// visible one gives a small bump, its timer (and time bar) restarts and toast() returns its id. Toasts
// with actions dedupe only when both use the same onClick; a different (or missing) action stacks.
// Pass { dedupe: false } to always stack.

import React from 'react';
import { createPortal } from 'react-dom';
import { cx, lxReducedMotion } from './util.js';
import { findTwin } from './logic.js';
import './toast.css';

const H = 56, GAP = 8, LIFE = 4500, MAX = 3;
let seq = 0;
let host = null;              // the mounted host's push/dismiss
const queue = [];

const toast = (message, opts = {}) => {
  // toast(msg, 'error') is shorthand for toast(msg, { type: 'error' }); 'warn'/'warning' show as info.
  if (typeof opts === 'string') opts = { type: opts };
  if (!opts || typeof opts !== 'object') opts = {};
  if (opts.type === 'warn' || opts.type === 'warning') opts = { ...opts, type: 'info' };
  const t = {
    id: ++seq, message: String(message ?? ''), type: opts.type || 'info',
    duration: opts.duration ?? LIFE, action: opts.action || null, dedupe: opts.dedupe !== false, bump: 0,
  };
  if (host) return host.push(t);
  const twin = findTwin(queue, t);
  if (twin) { twin.duration = t.duration; twin.action = t.action; return twin.id; }
  queue.push(t);
  return t.id;
};
toast.dismiss = (id) => { host?.dismiss(id); };

const ICONS = {
  success: <svg viewBox="0 0 24 24"><path d="m6 12.5 4 4 8-9" /></svg>,
  error: <svg viewBox="0 0 24 24"><path d="M12 6.5v7M12 17.5h.01" /></svg>,
  info: <svg viewBox="0 0 24 24"><path d="M12 11v6.5M12 6.5h.01" /></svg>,
};
const TONE = { success: 'var(--ux-mint)', error: 'var(--ux-danger)', info: 'var(--ux-accent)' };

const ToastItem = ({ t, y, s, o, z, back, register, onDismiss, onAction }) => {
  const ref = React.useRef(null);
  const drag = React.useRef({ on: false, x0: 0, dx: 0, v: 0, last: [] });
  // Enter: start below and small with no transition, then let the spring carry it to its slot.
  React.useLayoutEffect(() => {
    const el = ref.current;
    register(t.id, el);
    if (!el || lxReducedMotion()) return () => register(t.id, null);
    const fin = ['--y', '--s', '--o'].map(k => el.style.getPropertyValue(k));
    el.classList.add('is-in');
    el.style.transition = 'none';
    el.style.setProperty('--y', '84px'); el.style.setProperty('--s', '.9'); el.style.setProperty('--o', '0');
    void el.offsetWidth;
    el.style.transition = '';
    ['--y', '--s', '--o'].forEach((k, i) => el.style.setProperty(k, fin[i]));
    return () => register(t.id, null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Dedupe bump: a quick scale pulse on the toast that absorbed a repeat (the icon redraws too).
  React.useEffect(() => {
    const el = ref.current;
    if (!t.bump || !el || lxReducedMotion()) return;
    el.classList.remove('is-bump'); void el.offsetWidth; el.classList.add('is-bump');
  }, [t.bump]);

  const onPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest('button') || t.gone) return;
    const d = drag.current;
    d.on = true; d.x0 = e.clientX; d.dx = 0; d.v = 0; d.last = [[e.clientX, e.timeStamp]];
    ref.current.classList.add('is-drag');
    try { ref.current.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d.on) return;
    d.dx = e.clientX - d.x0;
    d.last.push([e.clientX, e.timeStamp]);
    if (d.last.length > 5) d.last.shift();
    ref.current.style.setProperty('--x', d.dx.toFixed(1) + 'px');
    ref.current.style.opacity = String(Math.max(0.35, 1 - Math.abs(d.dx) / 320));
  };
  const onPointerEnd = () => {
    const d = drag.current, el = ref.current;
    if (!d.on || !el) return;
    d.on = false;
    const a = d.last[0], b = d.last[d.last.length - 1];
    d.v = b && a && b[1] > a[1] ? (b[0] - a[0]) / (b[1] - a[1]) : 0;
    el.style.opacity = '';
    if (Math.abs(d.dx) > 80 || Math.abs(d.v) > 0.6) { onDismiss(t.id, (Math.abs(d.v) > 0.6 ? d.v : d.dx) > 0 ? 1 : -1, d); return; }
    el.classList.remove('is-drag');
    el.style.setProperty('--x', '0px');
    d.dx = 0;
  };

  return (
    <div ref={ref} className={cx('u435-t', back && 'is-back')} onAnimationEnd={e => { if (e.animationName === 'u435-bump') e.currentTarget.classList.remove('is-bump'); }}
      style={{ '--y': `${y}px`, '--s': s.toFixed(3), '--o': o, '--tc': TONE[t.type] || TONE.info, zIndex: z, pointerEvents: t.gone ? 'none' : undefined }}
      title={t.message.length > 90 ? t.message : undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDismiss(t.id); } }}>
      <span className="u435-ic" aria-hidden="true"><span className="ok">{ICONS[t.type] || ICONS.info}</span></span>
      <span className="u435-tx">{t.message}</span>
      {t.action && <button type="button" className="u435-un" onClick={() => onAction(t)}>{t.action.label}</button>}
      <button type="button" className="u435-x" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
      {t.duration > 0 && <span className="u435-pb" aria-hidden="true"><i key={t.bump || 0} style={{ animationDuration: `${t.duration}ms` }} /></span>}
    </div>
  );
};

const ToastHost = () => {
  const [list, setList] = React.useState([]);
  const [open, setOpen] = React.useState(false);
  const els = React.useRef(new Map());
  const timers = React.useRef(new Map());     // id → { tm, left, t0 }
  const openRef = React.useRef(false);
  const leaveT = React.useRef(0);
  const regionRef = React.useRef(null);
  const liveIds = React.useRef([]);           // ids not yet dismissed, oldest first (sync mirror)
  const anims = React.useRef(new Set());      // running exit animations (cancelled on unmount)
  const mounted = React.useRef(true);
  // One persistent live region per politeness: screen readers announce text written into an existing
  // region more reliably than a region inserted already holding text.
  const [said, setSaid] = React.useState({ polite: '', assertive: '', n: 0 });

  const remove = React.useCallback((id) => {
    setList(l => l.filter(x => x.id !== id));
    const tm = timers.current.get(id); if (tm) clearTimeout(tm.tm);
    timers.current.delete(id);
  }, []);

  const dismiss = React.useCallback((id, dir, dragInfo, quiet) => {
    if (!liveIds.current.includes(id)) return;
    liveIds.current = liveIds.current.filter(x => x !== id);
    const tm = timers.current.get(id); if (tm) clearTimeout(tm.tm);
    setList(l => l.map(x => (x.id === id ? { ...x, gone: true } : x)));
    const el = els.current.get(id);
    if (el && el.contains(document.activeElement)) {
      const other = [...els.current.entries()].reverse().find(([k, e]) => k !== id && e);
      other ? other[1].querySelector('.u435-x')?.focus({ preventScroll: true }) : document.activeElement.blur();
    }
    if (!el || lxReducedMotion() || !el.animate) { remove(id); return; }
    const y = el.style.getPropertyValue('--y') || '0px', s = Number(el.style.getPropertyValue('--s') || 1);
    let anim;
    if (dir) {
      const v = Math.max(1.2, Math.abs(dragInfo?.v || 0)), dist = 380, dur = Math.max(160, Math.min(320, dist / v));
      el.classList.add('is-drag');
      anim = el.animate([{ transform: `translate3d(${dragInfo?.dx || 0}px,${y},0) scale(${s})`, opacity: 1 }, { transform: `translate3d(${dir * dist}px,${y},0) scale(${s}) rotate(${dir * 6}deg)`, opacity: 0 }], { duration: dur, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
    } else {
      anim = el.animate([{ opacity: quiet ? 0 : 1 }, { transform: `translate3d(0,calc(${y} + 14px),0) scale(${s * 0.94})`, opacity: 0 }], { duration: 260, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' });
    }
    anims.current.add(anim);
    anim.onfinish = () => { anims.current.delete(anim); if (mounted.current) remove(id); };
  }, [remove]);

  const startTimer = React.useCallback((id, ms) => {
    const old = timers.current.get(id); if (old) clearTimeout(old.tm);
    const rec = { left: ms, t0: Date.now(), tm: 0 };
    if (!openRef.current) rec.tm = setTimeout(() => dismiss(id), ms);
    timers.current.set(id, rec);
  }, [dismiss]);

  const listRef = React.useRef(list);
  listRef.current = list;
  const push = React.useCallback((t) => {
    // Dedupe against a toast that is still visible (not exiting) with the same message and type.
    const twin = findTwin(listRef.current, t, liveIds.current);
    if (twin) {
      const upd = (x) => ({ ...x, bump: (x.bump || 0) + 1, duration: t.duration, action: t.action });
      listRef.current = listRef.current.map(x => (x.id === twin.id ? upd(x) : x));
      setList(l => l.map(x => (x.id === twin.id ? upd(x) : x)));
      if (t.duration > 0) startTimer(twin.id, t.duration);
      else { const old = timers.current.get(twin.id); if (old) clearTimeout(old.tm); timers.current.delete(twin.id); }
      setSaid(x => ({ ...(t.type === 'error' ? { polite: '', assertive: t.message } : { polite: t.message, assertive: '' }), n: x.n + 1 }));
      return twin.id;
    }
    liveIds.current = [...liveIds.current, t.id];
    listRef.current = [...listRef.current, t];
    setList(l => [...l, t]);
    // Alternate a zero-width space so the same message twice is still announced.
    setSaid(x => ({ ...(t.type === 'error' ? { polite: '', assertive: t.message } : { polite: t.message, assertive: '' }), n: x.n + 1 }));
    if (t.duration > 0) startTimer(t.id, t.duration);
    if (liveIds.current.length > MAX) dismiss(liveIds.current[0], 0, null, true);
    return t.id;
  }, [dismiss, startTimer]);

  React.useEffect(() => {
    mounted.current = true;
    host = { push, dismiss: (id) => dismiss(id) };
    // Timers stopped by a previous cleanup (StrictMode re-run, or a host remount) resume here with
    // the time they had left.
    timers.current.forEach((r, id) => {
      if (!r.tm && !openRef.current && liveIds.current.includes(id)) { r.t0 = Date.now(); r.tm = setTimeout(() => dismiss(id), r.left); }
    });
    setList(l => (l.some(x => x.gone) ? l.filter(x => !x.gone) : l));   // exits cut short by a cleanup
    queue.splice(0).forEach(push);
    const tms = timers.current;
    const running = anims.current;
    return () => {
      mounted.current = false;
      host = null;
      tms.forEach(r => { if (r.tm) { clearTimeout(r.tm); r.left = Math.max(500, r.left - (Date.now() - r.t0)); r.tm = 0; } });
      running.forEach(a => { a.onfinish = null; a.cancel(); });
      running.clear();
      clearTimeout(leaveT.current);
    };
  }, [push, dismiss]);

  // Hover / focus fans the deck out and pauses every timer (remaining time is kept, min 0.5 s).
  const setFan = (v) => {
    if (openRef.current === v) return;
    openRef.current = v;
    setOpen(v);
    timers.current.forEach((r, id) => {
      if (v) { if (r.tm) { clearTimeout(r.tm); r.left = Math.max(500, r.left - (Date.now() - r.t0)); r.tm = 0; } }
      else { r.t0 = Date.now(); r.tm = setTimeout(() => dismiss(id), r.left); }
    });
  };

  React.useEffect(() => { if (!list.length && openRef.current) { openRef.current = false; setOpen(false); } }, [list.length]);

  const live = list.filter(x => !x.gone);
  const n = live.length;
  const regionH = open && n > 1 ? n * H + (n - 1) * GAP : H + 20;
  const pos = new Map(live.map((t, k) => [t.id, n - 1 - k]));

  // Portaled to <body>: outside #root, so toasts stay clickable and announced while a modal Dialog
  // makes #root inert / aria-hidden.
  return createPortal(
    <section ref={regionRef} className={cx('ux u435-rg', open && 'is-paused', list.length === 0 && 'is-empty')} aria-label="Notifications"
      style={{ height: regionH }}
      onPointerEnter={() => { clearTimeout(leaveT.current); if (n) setFan(true); }}
      onPointerLeave={() => { clearTimeout(leaveT.current); leaveT.current = setTimeout(() => { if (!regionRef.current?.contains(document.activeElement)) setFan(false); }, 120); }}
      onFocus={() => setFan(true)}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setFan(false); }}>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{said.polite ? said.polite + (said.n % 2 ? '\u200b' : '') : ''}</p>
      <p className="sr-only" role="alert" aria-atomic="true">{said.assertive ? said.assertive + (said.n % 2 ? '\u200b' : '') : ''}</p>
      {list.map(t => {
        const i = pos.has(t.id) ? pos.get(t.id) : 0;
        const y = open ? -i * (H + GAP) : -i * 11;
        const s = open ? 1 : 1 - i * 0.055;
        return (
          <ToastItem key={t.id} t={t} y={y} s={s} o={i < MAX ? 1 : 0} z={20 - i} back={!open && i > 0}
            register={(id, el) => { if (el) els.current.set(id, el); else els.current.delete(id); }}
            onDismiss={(id, dir, d) => dismiss(id, dir, d)}
            onAction={(x) => { try { x.action.onClick?.(); } finally { dismiss(x.id); } }} />
        );
      })}
    </section>,
    document.body,
  );
};

export { toast, ToastHost };
