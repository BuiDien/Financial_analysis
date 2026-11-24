// Lucian UX/UI Prompt #416 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#416
// Tabs: pick a tab and the thumb stretches from its leading edge, then the trailing edge catches up
// like jelly; the optional panel glides in from the direction you moved.
//
// <Tabs tabs={[{ value, label, badge?, disabled? }]} value onChange(value) ariaLabel size="sm|md" block
//   renderPanel?={(value) => node} />
// Keyboard: ←/→ move (wrapping), Home/End. Without renderPanel only the tab list is drawn and no tab
// carries aria-controls. renderPanel draws only the active panel, so only the active tab points at it.
// If you render the panel yourself, give it id={tabPanelId(idBase, value)} and pass idBase plus
// controlsPanel: the active tab then gets aria-controls for it.

import React from 'react';
import { cx, useUid } from './util.js';
import './tabs.css';

const tabPanelId = (base, value) => `${base}-p-${String(value).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
const tabId = (base, value) => `${base}-t-${String(value).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

const Tabs = ({ tabs = [], value, onChange, ariaLabel = 'Tabs', size = 'md', block = false, renderPanel, idBase, controlsPanel = false, className }) => {
  const autoId = useUid('u416');
  const base = idBase || autoId;
  const tlRef = React.useRef(null);
  const thRef = React.useRef(null);
  const btnRefs = React.useRef([]);
  const prev = React.useRef(-1);
  const dirRef = React.useRef(1);
  const items = tabs.map(t => (typeof t === 'object' ? t : { value: t, label: String(t) }));
  const index = Math.max(0, items.findIndex(t => String(t.value) === String(value)));

  const thumb = React.useCallback((dir, instant) => {
    const tl = tlRef.current, th = thRef.current, t = btnRefs.current[index];
    if (!tl || !th || !t) return;
    if (instant) th.style.transition = 'none';
    th.style.setProperty('--tl', dir > 0 ? '.62s' : '.38s');
    th.style.setProperty('--tr', dir > 0 ? '.38s' : '.62s');
    th.style.setProperty('--l', t.offsetLeft + 'px');
    th.style.setProperty('--r', (tl.clientWidth - t.offsetLeft - t.offsetWidth) + 'px');
    if (instant) { void th.offsetWidth; th.style.transition = ''; }
  }, [index]);

  React.useLayoutEffect(() => {
    const first = prev.current < 0;
    const dir = index >= prev.current ? 1 : -1;
    if (!first && index !== prev.current) dirRef.current = dir;
    prev.current = index;
    thumb(dir, first);
  }, [index, thumb]);
  React.useEffect(() => {
    if (!('ResizeObserver' in window) || !tlRef.current) return undefined;
    const ro = new ResizeObserver(() => thumb(1, true));
    ro.observe(tlRef.current);
    return () => ro.disconnect();
  }, [thumb]);

  const select = (i, focus) => {
    const t = items[i];
    if (!t || t.disabled) return;
    if (focus) btnRefs.current[i]?.focus({ preventScroll: true });
    btnRefs.current[i]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (i !== index) onChange?.(t.value);
  };
  const onKeyDown = (e) => {
    const n = items.length;
    // ←/→ walk (wrapping) past disabled tabs; Home/End take the first/last enabled tab.
    const step = e.key === 'ArrowRight' || e.key === 'Home' ? 1 : e.key === 'ArrowLeft' || e.key === 'End' ? -1 : 0;
    if (!step || !n) return;
    e.preventDefault();
    let i = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (index + step + n) % n;
    for (let k = 0; k < n && items[i]?.disabled; k++) i = (i + step + n) % n;
    if (!items[i]?.disabled) select(i, true);
  };

  const active = items[index];
  return (
    <div className={cx('ux u416', size === 'sm' && 'is-sm', block && 'is-block', className)}>
      <div ref={tlRef} className="u416-tl" role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown}>
        <span ref={thRef} className="u416-th" aria-hidden="true" />
        {items.map((t, i) => (
          <button key={String(t.value)} ref={el => { btnRefs.current[i] = el; }} className="u416-tab" type="button" role="tab"
            id={tabId(base, t.value)} aria-selected={i === index} aria-controls={i === index && (renderPanel || (controlsPanel && idBase)) ? tabPanelId(base, t.value) : undefined}
            tabIndex={i === index ? 0 : -1} disabled={t.disabled} onClick={() => select(i)}>
            {t.label}
            {t.badge != null && t.badge !== 0 && <span className="u416-bd">{t.badge}</span>}
          </button>
        ))}
      </div>
      {renderPanel && active && (
        <div className="u416-pv">
          <div key={String(active.value)} className="u416-pn" role="tabpanel" tabIndex={0}
            id={tabPanelId(base, active.value)} aria-labelledby={tabId(base, active.value)}
            style={{ '--d': dirRef.current }}>
            {renderPanel(active.value)}
          </div>
        </div>
      )}
    </div>
  );
};

export { Tabs, tabPanelId, tabId };
