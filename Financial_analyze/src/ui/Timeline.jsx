// Lucian UX/UI Prompt #271 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#271
// Vertical timeline (activity / news feed) with an optional chip filter: the highlight pill slides to
// the chosen chip while entries that don't match fold away and the rest close up.
//
// <Timeline items={[{ id, title, body?, date?, meta?, tag?, href?, isNew? }]}
//   filters?={[{ value, label, color? }]}   (an "All" chip is added first)
//   filter? onFilterChange?  maxHeight? emptyText? onItemClick?(item) ariaLabel />
// item.tag matches a filter value and picks the dot / tag colour; links open in a new tab (http(s) only).

import React from 'react';
import { cx } from './util.js';
import { safeHttpUrl } from '../lib/safe-url.js';
import './timeline.css';

const FALLBACK = ['var(--ux-accent)', 'var(--ux-accent-2)', 'var(--ux-mint)', 'var(--ux-warn)', 'var(--ux-danger)'];

const Timeline = ({ items = [], filters, filter: filterProp, onFilterChange, maxHeight, emptyText = 'Nothing yet', onItemClick, ariaLabel = 'Timeline', className }) => {
  const [own, setOwn] = React.useState('all');
  const filter = filterProp !== undefined ? filterProp : own;
  const chips = filters ? [{ value: 'all', label: 'All' }, ...filters] : null;
  const colorOf = (tag) => {
    const i = (filters || []).findIndex(f => String(f.value) === String(tag));
    return i < 0 ? 'var(--ux-ink-3)' : filters[i].color || FALLBACK[i % FALLBACK.length];
  };
  const labelOf = (tag) => (filters || []).find(f => String(f.value) === String(tag))?.label || tag;
  const k = chips ? Math.max(0, chips.findIndex(c => String(c.value) === String(filter))) : 0;
  const btns = React.useRef([]);
  const pick = (i, focus) => {
    const v = chips[i].value;
    if (filterProp === undefined) setOwn(v);
    onFilterChange?.(v);
    if (focus) btns.current[i]?.focus();
  };
  const visible = items.filter(it => filter === 'all' || String(it.tag) === String(filter));
  return (
    <div className={cx('ux u271', className)}>
      {chips && (
        <div className="u271-cs" role="radiogroup" aria-label="Filter" style={{ '--n': chips.length, '--gaps': `${(chips.length - 1) * 2}px` }}>
          <span className="u271-pl" aria-hidden="true" style={{ '--k': k }} />
          {chips.map((c, i) => {
            const n = c.value === 'all' ? items.length : items.filter(it => String(it.tag) === String(c.value)).length;
            return (
              <button key={String(c.value)} ref={el => { btns.current[i] = el; }} type="button" role="radio" className={cx('u271-ch', i === k && 'is-on')}
                aria-checked={i === k} tabIndex={i === k ? 0 : -1} onClick={() => pick(i)}
                onKeyDown={e => { const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (d) { e.preventDefault(); pick((i + d + chips.length) % chips.length, true); } }}>
                <span>{c.label}</span><i>{n}</i>
              </button>
            );
          })}
        </div>
      )}
      <div className="u271-sc" style={maxHeight ? { maxHeight } : undefined} tabIndex={maxHeight ? 0 : undefined} aria-label={maxHeight ? ariaLabel : undefined}>
        <ol className="u271-tl" aria-label={ariaLabel}>
          {items.map((it, i) => {
            const off = filter !== 'all' && String(it.tag) !== String(filter);
            const href = it.href ? safeHttpUrl(it.href) : null;
            return (
              <li key={it.id ?? i} className={cx('u271-en', off && 'is-off')} aria-hidden={off || undefined}>
                <div>
                  <div className="u271-in" style={{ '--c': colorOf(it.tag) }}>
                    <span className={cx('u271-dt', it.isNew && 'is-new')} aria-hidden="true" />
                    {(it.date || it.meta || it.tag != null || it.isNew) && (
                      <div className="u271-mt">
                        {it.date && <b>{it.date}</b>}
                        {it.meta && <span>{it.date ? '· ' : ''}{it.meta}</span>}
                        {it.tag != null && filters && <span className="u271-tg">{labelOf(it.tag)}</span>}
                        {it.isNew && <span className="u271-nw">New</span>}
                      </div>
                    )}
                    <h4>{href ? <a href={href} target="_blank" rel="noopener noreferrer" tabIndex={off ? -1 : undefined}>{it.title}</a>
                      : onItemClick ? <a href="#" role="button" tabIndex={off ? -1 : undefined} onClick={e => { e.preventDefault(); onItemClick(it); }}>{it.title}</a> : it.title}</h4>
                    {it.body && <p>{it.body}</p>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        {visible.length === 0 && <div className="u271-empty">{emptyText}</div>}
      </div>
    </div>
  );
};

export { Timeline };
