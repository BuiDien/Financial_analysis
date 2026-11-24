// Lucian UX/UI Prompt #273 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#273
import React from 'react';
import { lxUid, lxReducedMotion } from './util.js';
import './side-panel.css';

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

export { LxSidePanel };
