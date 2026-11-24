// Lucian UX/UI Prompt #437 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#437
// One tooltip for the whole app. Rest on any element with data-tip="Label" (optional
// data-tip-kbd="⌘ K") and after 400 ms a bubble with an arrow pops out of it; moving to the next
// target glides it along with no second wait. Keyboard focus (:focus-visible) shows it too; Esc hides.
//
// Mount <TooltipHost /> once. Then either set the attributes yourself, or wrap one child:
//   <Tooltip label="Refresh" kbd="R"><button …/></Tooltip>
// IconButton sets data-tip from its label automatically.

import React from 'react';
import { createPortal } from 'react-dom';
import { cx } from './util.js';
import './tooltip.css';

const Tooltip = ({ label, kbd, children }) => {
  const child = React.Children.only(children);
  return React.cloneElement(child, { 'data-tip': label, 'data-tip-kbd': kbd || undefined });
};

const OPEN_DELAY = 400, CLOSE_DELAY = 100, REGLIDE = 300;

const TooltipHost = () => {
  const tipRef = React.useRef(null);
  const [tip, setTip] = React.useState({ on: false, text: '', kbd: '', glide: false, below: false });
  React.useEffect(() => {
    const id = 'u437-tip';
    let cur = null, openT = 0, closeT = 0, raf = 0, lastClose = 0, muted = null;
    const targetOf = (el) => (el && el.closest ? el.closest('[data-tip]') : null);
    const place = (b) => {
      const t = tipRef.current;
      if (!t) return;
      const br = b.getBoundingClientRect();
      const w = t.offsetWidth, h = t.offsetHeight;
      const cx = br.left + br.width / 2;
      const x = Math.max(8, Math.min(window.innerWidth - 8 - w, cx - w / 2));
      const below = br.top - h - 10 < 4;
      const y = below ? br.bottom + 10 : br.top - h - 10;
      t.style.setProperty('--x', x.toFixed(1) + 'px');
      t.style.setProperty('--y', y.toFixed(1) + 'px');
      t.style.setProperty('--ax', Math.max(10, Math.min(w - 10, cx - x)).toFixed(1) + 'px');
      return below;
    };
    const show = (b, glide) => {
      const text = b.getAttribute('data-tip');
      if (!text) return;
      if (cur && cur !== b) cur.removeAttribute('aria-describedby');
      cur = b;
      if (!b.hasAttribute('aria-label') || b.getAttribute('aria-label') !== text) b.setAttribute('aria-describedby', id);
      // Render the new text first, then measure and place on the next frame.
      setTip(s => ({ ...s, text, kbd: b.getAttribute('data-tip-kbd') || '', glide }));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (cur !== b || !b.isConnected) return;
        const below = place(b);
        setTip(s => ({ ...s, on: true, below }));
      });
    };
    const hide = () => {
      clearTimeout(openT);
      if (!cur) { setTip(s => (s.on ? { ...s, on: false } : s)); return; }
      cur.removeAttribute('aria-describedby');
      cur = null;
      lastClose = Date.now();
      setTip(s => ({ ...s, on: false }));
    };
    const want = (b) => {
      if (b === muted) return;
      clearTimeout(closeT); clearTimeout(openT);
      if (cur === b) return;
      if (cur || Date.now() - lastClose < REGLIDE) show(b, !!cur);
      else openT = setTimeout(() => { if (b.isConnected) show(b, false); }, OPEN_DELAY);
    };
    const unwant = (b) => {
      if (muted === b) muted = null;
      clearTimeout(openT); clearTimeout(closeT);
      closeT = setTimeout(hide, CLOSE_DELAY);
    };
    const onOver = (e) => {
      // A target removed while hovered never fires pointerout: drop the tip on the next pointer move.
      if (cur && !cur.isConnected) { cur = null; hide(); }
      if (e.pointerType === 'touch') return;
      const b = targetOf(e.target);
      if (b) want(b);
    };
    const onOut = (e) => { const b = targetOf(e.target); if (b && !b.contains(e.relatedTarget)) unwant(b); };
    const onFocusIn = (e) => { const b = targetOf(e.target); if (b && b === e.target && b.matches(':focus-visible')) want(b); };
    const onFocusOut = (e) => { const b = targetOf(e.target); if (b) unwant(b); };
    const onDown = (e) => { const b = targetOf(e.target); if (b) { muted = b; hide(); } };
    const onKey = (e) => { if (e.key === 'Escape' && cur) { muted = cur; hide(); } };
    const onScroll = () => { if (cur) hide(); };
    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      clearTimeout(openT); clearTimeout(closeT); cancelAnimationFrame(raf);
      if (cur) cur.removeAttribute('aria-describedby');
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, []);
  const keys = tip.kbd ? tip.kbd.split(/\s+/).filter(Boolean) : [];
  return createPortal(
    <div ref={tipRef} id="u437-tip" role="tooltip" className={cx('ux u437-tip', tip.on && 'is-on', tip.glide && 'is-glide', tip.below && 'is-below')} aria-hidden={!tip.on}>
      <div className="u437-in"><span>{tip.text}</span>{keys.length > 0 && <kbd>{keys.map((k, i) => <span key={i}>{k}</span>)}</kbd>}<i className="u437-ar" /></div>
    </div>,
    document.body,
  );
};

export { Tooltip, TooltipHost };
