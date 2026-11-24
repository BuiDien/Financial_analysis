// Lucian UX/UI Prompt #038 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#038
// Context / dropdown menu. The menu blooms from the cursor (or from its anchor) with a spring; near a
// viewport edge it opens the other way and grows from the matching corner. Styles: ./menu.css.
//
// <Menu open onClose(reason) items={[
//     { id: 'open', label: 'Open', icon?: 'eye' | node, kbd?: '↵', danger?, disabled?, onSelect?(item) },
//     { type: 'separator' },
//     { type: 'label', label: 'Move to' },
//   ]}
//   x? y?            viewport coordinates (a right-click: e.clientX / e.clientY)
//   anchor?          an element or a ref; the menu sits under it (flips above when there's no room)
//   align="start|end" (with anchor) · onSelect?(item) · ariaLabel="Menu" · width? · returnFocus? />
//
// Keyboard: focus moves into the menu on open (first enabled item). ↑/↓ move (wrapping), Home/End,
// typing a letter jumps to the next item starting with it, Enter/Space choose, Esc closes, Tab closes.
// On close, focus returns to the element that had it before the menu opened (or `returnFocus`).
// A pointerdown outside, a scroll of the page or a window resize closes it. Portaled to <body>. The
// app's keyboard shortcuts are paused while it is open (as in a Dialog).
//
// useContextMenu() is a small helper for the right-click case:
//   const ctx = useContextMenu();
//   <div onContextMenu={ctx.onContextMenu(row)} />  …  <Menu {...ctx.menuProps} items={itemsFor(ctx.data)} />

import React from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.jsx';
import { cx, useUid } from './util.js';
import { placeMenu, cycleIndex } from './logic.js';
import { HelixShortcuts } from '../shortcuts.jsx';
import './menu.css';

const GAP = 6;        // anchor → menu distance
const EDGE = 8;       // keep this far from the viewport edges

const resolveEl = (a) => (a && typeof a === 'object' && 'current' in a ? a.current : a) || null;

const Menu = ({
  open, onClose, items = [], x, y, anchor, align = 'start', onSelect, ariaLabel = 'Menu', width, returnFocus, className,
}) => {
  const uid = useUid('u038');
  const menuRef = React.useRef(null);
  const itemRefs = React.useRef([]);
  const back = React.useRef(null);
  const typed = React.useRef({ text: '', timer: 0 });
  const [pos, setPos] = React.useState(null);     // { left, top, origin }
  const [shown, setShown] = React.useState(false);
  const enabled = items.map((it, i) => (it && it.type !== 'separator' && it.type !== 'label' && !it.disabled ? i : -1)).filter(i => i >= 0);

  const close = React.useCallback((reason, refocus = true) => {
    // Focus goes back first (synchronously), so an action that opens a Dialog records the opener as
    // the place to return to.
    if (refocus) {
      const el = resolveEl(returnFocus) || back.current;
      if (el && el.isConnected && typeof el.focus === 'function') el.focus({ preventScroll: true });
    }
    onClose?.(reason);
  }, [onClose, returnFocus]);

  // Remember the opener's focus; position; then focus the first item.
  React.useLayoutEffect(() => {
    if (!open) { setShown(false); setPos(null); return undefined; }
    if (!menuRef.current?.contains(document.activeElement)) back.current = document.activeElement;
    const m = menuRef.current;
    if (!m) return undefined;
    const a = resolveEl(anchor);
    setPos(placeMenu({
      x: x ?? 0, y: y ?? 0, anchorRect: a && a.getBoundingClientRect ? a.getBoundingClientRect() : null, align,
      mw: m.offsetWidth, mh: m.offsetHeight, vw: window.innerWidth, vh: window.innerHeight, gap: GAP, edge: EDGE,
    }));
    return undefined;
  }, [open, x, y, anchor, align, items.length]);

  React.useEffect(() => {
    if (!open || !pos) return undefined;
    const raf = requestAnimationFrame(() => setShown(true));
    const t = setTimeout(() => { const i = enabled[0]; (i != null ? itemRefs.current[i] : menuRef.current)?.focus({ preventScroll: true }); }, 30);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [open, pos]); // eslint-disable-line react-hooks/exhaustive-deps

  // Outside pointerdown / scroll / resize close it (without stealing focus back on an outside click).
  React.useEffect(() => {
    if (!open) return undefined;
    // A press on the anchor itself is left to the anchor's own toggle (no close-then-reopen).
    const onDown = (e) => {
      const a = resolveEl(anchor);
      if (menuRef.current && !menuRef.current.contains(e.target) && !(a && a.contains && a.contains(e.target))) close('outside', false);
    };
    const onScroll = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) close('scroll', false); };
    const onResize = () => close('resize', false);
    // Esc closes even when focus has left the menu (e.g. a press on the panel padding put it on body).
    const onDocKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (menuRef.current && menuRef.current.contains(e.target)) return;   // the menu's own handler runs
      e.preventDefault();
      close('escape');
    };
    document.addEventListener('keydown', onDocKey);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onDocKey);
    };
  }, [open, close, anchor]);
  React.useEffect(() => () => clearTimeout(typed.current.timer), []);
  // Typing in the menu (type-ahead) must not fire the app's single-key shortcut sequences.
  React.useEffect(() => {
    if (!open) return undefined;
    const was = HelixShortcuts.enabled;
    HelixShortcuts.enabled = false;
    return () => { HelixShortcuts.enabled = was; };
  }, [open]);

  if (!open) return null;

  const choose = (it) => {
    if (!it || it.disabled) return;
    close('select');
    it.onSelect?.(it);
    onSelect?.(it);
  };
  const focusAt = (i) => itemRefs.current[i]?.focus({ preventScroll: true });
  const onKeyDown = (e) => {
    const cur = itemRefs.current.indexOf(document.activeElement);
    const k = enabled.indexOf(cur);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      if (!enabled.length) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      focusAt(cycleIndex(enabled, k, d));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault(); e.stopPropagation();
      if (enabled.length) focusAt(enabled[e.key === 'Home' ? 0 : enabled.length - 1]);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      close('escape');
    } else if (e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation();
      close('tab');
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.stopPropagation();
      typed.current.text += e.key.toLowerCase();
      clearTimeout(typed.current.timer);
      typed.current.timer = setTimeout(() => { typed.current.text = ''; }, 600);
      const t = typed.current.text;
      const order = [...enabled.slice(k + 1), ...enabled.slice(0, k + 1)];
      const hit = (t.length > 1 ? enabled : order).find(i => String(items[i].label ?? '').toLowerCase().startsWith(t));
      if (hit != null) focusAt(hit);
    }
  };

  return createPortal(
    <div ref={menuRef} id={uid} className={cx('ux u038 u038-menu', shown && 'is-open', className)} role="menu" aria-orientation="vertical" aria-label={ariaLabel}
      tabIndex={-1} onKeyDown={onKeyDown} onContextMenu={e => e.preventDefault()}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, transformOrigin: pos?.origin, width: width ?? undefined }}>
      <ul className="u038-p" role="none">
        {items.map((it, i) => {
          if (!it) return null;
          if (it.type === 'separator') return <li key={`sep${i}`} className="u038-sep" role="separator" />;
          if (it.type === 'label') return <li key={`lab${i}`} className="u038-lab" role="presentation">{it.label}</li>;
          return (
            <li key={it.id ?? i} role="none">
              <button ref={el => { itemRefs.current[i] = el; }} type="button" role="menuitem" tabIndex={-1}
                className={cx('u038-mi', it.danger && 'danger')} disabled={it.disabled} aria-disabled={it.disabled || undefined}
                onClick={() => choose(it)}
                onPointerMove={e => { if (!it.disabled && document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true }); }}>
                {it.icon ? (typeof it.icon === 'string' ? <Icon name={it.icon} size={17} /> : it.icon) : null}
                <span className="u038-t">{it.label}</span>
                {it.kbd && <kbd>{it.kbd}</kbd>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
};

// Right-click helper: state for one context menu plus a handler factory.
const useContextMenu = () => {
  const [st, setSt] = React.useState({ open: false, x: 0, y: 0, data: null });
  const onContextMenu = React.useCallback((data) => (e) => {
    e.preventDefault();
    setSt({ open: true, x: e.clientX, y: e.clientY, data });
  }, []);
  const openAt = React.useCallback((x, y, data) => setSt({ open: true, x, y, data }), []);
  const close = React.useCallback(() => setSt(s => ({ ...s, open: false })), []);
  return { ...st, onContextMenu, openAt, close, menuProps: { open: st.open, x: st.x, y: st.y, onClose: close } };
};

export { Menu, useContextMenu };
