// Lucian UX/UI Prompt #436 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#436
// Modal dialog with the confirm-before-delete look: the card springs in, a danger dialog carries the
// trash-can tile and a red action, Tab loops inside, Esc or the backdrop cancels, focus returns to
// where it was.
//
// <Dialog open onClose title description? icon="danger|info|none"|node size="sm|md|lg|xl|full"
//   onConfirm? confirmText cancelText tone="default|danger" busy? actions?={node} initialFocusRef?
//   bodyClassName? flushBody?>
//   …optional body…
// </Dialog>
// Without `actions`, a Cancel + confirm pair is drawn when onConfirm is given. `actions` is your own row
// (normally src/ui <Button>s): it is laid out right-aligned and wrapping, and the buttons keep their own
// variants and sizes. Widths: sm 320 · md 400 · lg 560 · xl 840 px · full = the viewport less a 16px
// margin. In xl / full the header and actions stay put and only the body scrolls. bodyClassName styles
// the content area; flushBody drops its top gap and lets it run edge to edge (tables, previews).
//
// Promise helpers (mount <DialogHost /> once; <PromptHost /> is the same component):
//   const name = await askPrompt({ title, label, placeholder, value, confirmText, hint? });  // string | null
//   if (await askConfirm({ title, message, confirmText, danger })) …                         // boolean

import React from 'react';
import { createPortal } from 'react-dom';
import { cx, FOCUSABLE, lxReducedMotion, useUid } from './util.js';
import { TextInput } from './Input.jsx';
import { HelixShortcuts } from '../shortcuts.jsx';
import './dialog.css';

const TRASH = (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <g><path d="M5.5 9.5h21" /><path d="M12.5 9V7a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 19.5 7v2" /></g>
    <g><path d="M8 10.5l1.3 14.6a2.4 2.4 0 0 0 2.4 2.2h8.6a2.4 2.4 0 0 0 2.4-2.2L24 10.5" /><path d="M13.5 15v7.5M18.5 15v7.5" /></g>
  </svg>
);
const INFO = <svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="10.5" /><path d="M16 14.5v7M16 10.5h.01" /></svg>;

// Modal lock (shared by every open Dialog): while any modal is open, the app root (#root) is inert and
// aria-hidden, page scroll is locked and the global keyboard shortcuts (including ⌘K) are paused.
// Everything is restored when the last modal closes.
let modalCount = 0;
let saved = null;
const lockModal = () => {
  if (modalCount === 0 && typeof document !== 'undefined') {
    const root = document.getElementById('root');
    saved = {
      shortcuts: HelixShortcuts.enabled,
      overflow: document.body.style.overflow,
      inert: root ? root.inert : false,
      hidden: root ? root.getAttribute('aria-hidden') : null,
    };
    HelixShortcuts.enabled = false;
    if (root) { root.inert = true; root.setAttribute('aria-hidden', 'true'); }
    document.body.style.overflow = 'hidden';
  }
  modalCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    modalCount -= 1;
    if (modalCount === 0 && saved) {
      const root = document.getElementById('root');
      HelixShortcuts.enabled = saved.shortcuts;
      if (root) {
        root.inert = saved.inert;
        if (saved.hidden == null) root.removeAttribute('aria-hidden'); else root.setAttribute('aria-hidden', saved.hidden);
      }
      document.body.style.overflow = saved.overflow;
      saved = null;
    }
  };
};
const isModalOpen = () => modalCount > 0;
const SIZE_CLASS = { sm: 'is-sm', lg: 'is-lg', xl: 'is-xl', full: 'is-full' };

const useDialogPhase = (open) => {
  const [rendered, setRendered] = React.useState(open);
  const [phase, setPhase] = React.useState(open ? 'pre' : 'gone');
  React.useEffect(() => {
    let raf = 0, tm = 0;
    if (open) {
      setRendered(true); setPhase('pre');
      raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => setPhase('in')); });
    } else if (rendered) {
      setPhase('gone');
      tm = setTimeout(() => setRendered(false), lxReducedMotion() ? 0 : 320);
    }
    return () => { cancelAnimationFrame(raf); clearTimeout(tm); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return { rendered, phase };
};

const Dialog = ({
  open, onClose, title, description, icon, size = 'md', onConfirm, confirmText = 'Confirm', cancelText = 'Cancel',
  tone = 'default', busy = false, actions, initialFocusRef, closeOnBackdrop = true, className, children,
  bodyClassName, flushBody = false,
}) => {
  const uid = useUid('u436');
  const { rendered, phase } = useDialogPhase(open);
  const dRef = React.useRef(null);
  const cancelRef = React.useRef(null);
  const okRef = React.useRef(null);
  const returnTo = React.useRef(null);
  const danger = tone === 'danger';
  const iconKind = icon === undefined ? (danger ? 'danger' : 'none') : icon;

  // Focus in on open (initialFocusRef → first field → Cancel for danger, confirm otherwise); restore on close.
  React.useEffect(() => {
    if (!open) return undefined;
    returnTo.current = document.activeElement;
    const unlock = lockModal();
    const t = setTimeout(() => {
      const d = dRef.current;
      if (!d) return;
      const field = d.querySelector('input,textarea,select');
      const target = initialFocusRef?.current || field || (danger ? cancelRef.current : okRef.current) || d.querySelector(FOCUSABLE) || d;
      target.focus({ preventScroll: true });
      if (field && target === field && field.select) field.select();
    }, 30);
    return () => {
      clearTimeout(t);
      unlock();   // first: the opener sits in #root, which is inert while the modal is open
      // Restore focus only if it is still in the dialog (or nowhere): a caller that already moved
      // focus (e.g. to a new row after askConfirm resolved) keeps it.
      const back = returnTo.current;
      const a = document.activeElement;
      const stillOurs = !a || a === document.body || (dRef.current && dRef.current.contains(a));
      if (stillOurs && back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rendered) return null;

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busy) onClose?.(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(dRef.current?.querySelectorAll(FOCUSABLE) || []).filter(el => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !dRef.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !dRef.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  };

  return createPortal(
    <div className={cx('ux u436 u436-ov', phase === 'pre' && 'is-pre', phase === 'gone' && 'is-gone')}
      onMouseDown={e => { if (closeOnBackdrop && e.target === e.currentTarget && !busy) onClose?.(); }} onKeyDown={onKeyDown}>
      <div ref={dRef} className={cx('u436-d', SIZE_CLASS[size], className)} role={danger ? 'alertdialog' : 'dialog'} aria-modal="true"
        aria-labelledby={`${uid}-t`} aria-describedby={description ? `${uid}-p` : undefined} tabIndex={-1}>
        {onClose && !danger && (
          <button type="button" className="u436-x" aria-label="Close" onClick={() => !busy && onClose()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        )}
        {iconKind === 'danger' ? <div className="u436-ic" aria-hidden="true">{TRASH}</div>
          : iconKind === 'info' ? <div className="u436-ic is-accent" aria-hidden="true">{INFO}</div>
          : iconKind && iconKind !== 'none' ? <div className="u436-ic is-accent" aria-hidden="true">{iconKind}</div> : null}
        <h3 id={`${uid}-t`}>{title}</h3>
        {description && <p id={`${uid}-p`} className="u436-ds">{description}</p>}
        {children != null && <div className={cx('u436-body', flushBody && 'is-flush', bodyClassName)}>{children}</div>}
        {actions != null ? <div className="u436-bs is-custom">{actions}</div> : onConfirm ? (
          <div className="u436-bs">
            <button ref={cancelRef} type="button" className="u436-no" onClick={() => onClose?.()} disabled={busy}>{cancelText}</button>
            <button ref={okRef} type="button" className={cx('u436-ok', danger && 'is-danger')} onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>{confirmText}</button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
};

// ── askPrompt / askConfirm ────────────────────────────────────────
let sub = null;
const pending = [];
const request = (opts, confirm) => new Promise(resolve => {
  const req = { opts, confirm, resolve };
  if (sub) sub(req); else if (confirm && typeof window !== 'undefined') resolve(window.confirm(opts.message || 'Are you sure?')); else pending.push(req);
});
const askPrompt = (opts = {}) => request(opts, false);
const askConfirm = (opts = {}) => request(opts, true);

const DialogHost = () => {
  const [queue, setQueue] = React.useState([]);
  const [value, setValue] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const cur = queue[0];
  const queueRef = React.useRef(queue);
  queueRef.current = queue;
  const nextT = React.useRef(0);
  React.useEffect(() => {
    sub = (req) => setQueue(q => [...q, req]);
    if (pending.length) setQueue(q => [...q, ...pending.splice(0)]);
    return () => { sub = null; };
  }, []);
  React.useEffect(() => {
    if (!cur) return undefined;
    setValue(cur.opts.value || '');
    setOpen(true);
    return undefined;
  }, [cur]);

  // Resolve now, let the exit animation play, then show the next queued request.
  const close = (result) => {
    if (!cur || !open) return;
    cur.resolve(result);
    setOpen(false);
    nextT.current = setTimeout(() => setQueue(q => q.slice(1)), lxReducedMotion() ? 0 : 330);
  };
  // On unmount: stop the pending hand-off and settle anything still waiting (cancelled).
  React.useEffect(() => () => {
    clearTimeout(nextT.current);
    queueRef.current.forEach(r => r.resolve(r.confirm ? false : null));
  }, []);

  if (!cur) return null;
  const o = cur.opts;
  const submit = () => { if (cur.confirm) close(true); else close(value.trim() || null); };
  return (
    <Dialog open={open} onClose={() => close(cur.confirm ? false : null)}
      title={o.title || (cur.confirm ? 'Please confirm' : 'Enter a value')}
      description={cur.confirm ? o.message : o.message || undefined}
      tone={o.danger ? 'danger' : 'default'} icon={o.danger ? 'danger' : 'none'}
      onConfirm={submit} confirmText={o.confirmText || (cur.confirm ? 'Confirm' : 'Save')} cancelText={o.cancelText || 'Cancel'}>
      {!cur.confirm && (
        <form onSubmit={e => { e.preventDefault(); submit(); }}>
          <TextInput label={o.label} value={value} onChange={setValue} placeholder={o.placeholder || ''} hint={o.hint} />
        </form>
      )}
    </Dialog>
  );
};

export { Dialog, DialogHost, DialogHost as PromptHost, askPrompt, askConfirm, isModalOpen };
