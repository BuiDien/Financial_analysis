// Lucian UX/UI Prompt #417 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#417
// App sidebar: icons + labels; the highlight springs to the active item; the round toggle collapses the
// column to an icon-only rail as the labels melt away. Up/Down arrows move between items.
//
// <SideNav items={[{ id, label, icon, href?, badge?, badgeTitle? }]} activeId onSelect(item)
//   sections?={[{ id, label, action?, items: [{ id, label, icon, meta?, current?, mark?, muted?, onSelect }] }]}
//   rail onToggleRail forced? ariaLabel />
// const [rail, toggleRail, forced] = useSidebarRail();   // persisted; forced on narrow screens (≤ 760px)
// The shell sets <div className="app" data-rail={rail}> so the grid column follows.

import React from 'react';
import { Icon } from './Icon.jsx';
import { cx } from './util.js';
import './side-nav.css';

const RAIL_KEY = 'helix_sidebar_rail';
const NARROW = '(max-width: 760px)';

const useMediaQuery = (query) => {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [match, setMatch] = React.useState(get);
  React.useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return match;
};

const useSidebarRail = () => {
  const [collapsed, setCollapsed] = React.useState(() => { try { return localStorage.getItem(RAIL_KEY) === '1'; } catch { return false; } });
  const forced = useMediaQuery(NARROW);
  const toggle = React.useCallback(() => setCollapsed(c => {
    const v = !c;
    try { localStorage.setItem(RAIL_KEY, v ? '1' : '0'); } catch { /* private mode */ }
    return v;
  }), []);
  return [forced || collapsed, toggle, forced];
};

const NavItem = React.forwardRef(({ item, current, rail, onClick, mark }, ref) => {
  const label = item.label;
  return (
    <a ref={ref} href={item.href || '#'} className={cx('u417-it', item.mark && 'is-mark', item.muted && 'is-muted')}
      aria-current={current || undefined} data-tip={rail ? label : undefined}
      onClick={e => { e.preventDefault(); onClick(); }}>
      {typeof item.icon === 'string' ? <Icon name={item.icon} size={16} /> : item.icon}
      <span className="u417-lb">{label}</span>
      {item.meta != null && <span className="u417-mt" aria-hidden={rail || undefined}>{item.meta}</span>}
      {item.badge ? <span className="u417-bd" title={item.badgeTitle}>{item.badge}<span className="sr-only">{item.badgeTitle ? `, ${item.badgeTitle}` : ''}</span></span> : null}
      {mark}
    </a>
  );
});
NavItem.displayName = 'NavItem';

const SideNav = ({ items = [], activeId, onSelect, sections = [], rail = false, forced = false, onToggleRail, ariaLabel = 'Sections', className }) => {
  const rootRef = React.useRef(null);
  const plRef = React.useRef(null);
  const itemRefs = React.useRef([]);
  const firstPlace = React.useRef(true);
  const activeIndex = items.findIndex(i => i.id === activeId);

  // Spring the highlight to the active item (instant on first paint, like the element's init).
  React.useLayoutEffect(() => {
    const pl = plRef.current, a = itemRefs.current[activeIndex];
    if (!pl) return;
    if (!a) { pl.style.opacity = '0'; return; }
    pl.style.opacity = '1';
    if (firstPlace.current) pl.style.transition = 'none';
    pl.style.setProperty('--py', a.parentNode.offsetTop + 'px');
    if (firstPlace.current) { void pl.offsetWidth; pl.style.transition = ''; firstPlace.current = false; }
  }, [activeIndex, items.length]);

  const onKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = Array.from(rootRef.current?.querySelectorAll('.u417-it') || []);
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    const to = all[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (to) { e.preventDefault(); to.focus(); }
  };

  return (
    <aside ref={rootRef} className={cx('sidebar ux u417', rail && 'is-rail', forced && 'is-forced', className)} onKeyDown={onKeyDown}>
      <nav className="u417-sec" aria-label={ariaLabel}>
        <ul className="u417-nav">
          <li className="u417-pl" aria-hidden="true" ref={plRef} />
          {items.map((it, i) => (
            <li key={it.id}>
              <NavItem ref={el => { itemRefs.current[i] = el; }} item={it} rail={rail} current={it.id === activeId ? 'page' : undefined} onClick={() => onSelect?.(it)} />
            </li>
          ))}
        </ul>
      </nav>
      {sections.map(sec => (
        <div key={sec.id} className="u417-sec is-plain" role="group" aria-label={sec.label}>
          {sec.label && <div className="u417-sh" aria-hidden="true"><span>{sec.label}</span></div>}
          <ul className="u417-nav">
            {sec.items.map(it => (
              <li key={it.id}><NavItem item={it} rail={rail} current={it.current ? 'true' : undefined} onClick={() => it.onSelect?.()} /></li>
            ))}
          </ul>
        </div>
      ))}
      {onToggleRail && (
        <div className="u417-ft">
          <button type="button" className="u417-tg" aria-expanded={!rail} aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'}
            data-tip={rail ? 'Expand sidebar' : 'Collapse sidebar'} onClick={onToggleRail}>
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" /></svg>
          </button>
        </div>
      )}
    </aside>
  );
};

export { SideNav, useSidebarRail, useMediaQuery };
