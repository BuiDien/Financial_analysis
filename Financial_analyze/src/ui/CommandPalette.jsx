// Lucian UX/UI Prompt #046 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#046
// Command palette: a search pill unfolds into the palette; typing filters with the matching letters
// highlighted; the highlight bar glides to the chosen row; running a command folds it back up.
//
// <CommandPalette nav={[{ id, label, icon? }]} tickers={[{ sym, name? }]}
//   commands?={[{ id, label, sub?, icon?, kbd?, group?, onRun }]} onNavigate(id) onPickTicker(sym) />
// Opens on window events 'open-command-palette' / 'toggle-command-palette' (the app's rebindable ⌘K
// shortcut and the header search dispatch them) or openCommandPalette(). ↑/↓ move, Enter runs, Esc folds.

import React from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.jsx';
import { cx, isMac, lxReducedMotion, useUid } from './util.js';
import { isModalOpen } from './Dialog.jsx';
import './command-palette.css';

const openCommandPalette = () => window.dispatchEvent(new Event('open-command-palette'));

const hit = (name, q) => {
  if (!q) return name;
  const i = name.toLowerCase().indexOf(q);
  if (i < 0) return name;
  return <>{name.slice(0, i)}<mark>{name.slice(i, i + q.length)}</mark>{name.slice(i + q.length)}</>;
};

const CommandPalette = ({ nav = [], tickers = [], commands = [], onNavigate, onPickTicker, placeholder = 'Search pages, tickers, commands…' }) => {
  const uid = useUid('u046');
  const [mounted, setMounted] = React.useState(false);
  const [closed, setClosed] = React.useState(true);   // the folded-pill look (enter / exit)
  const [query, setQuery] = React.useState('');
  const [act, setAct] = React.useState(0);
  const [instant, setInstant] = React.useState(true);
  const inputRef = React.useRef(null);
  const bodyRef = React.useRef(null);
  const listRef = React.useRef(null);
  const hlRef = React.useRef(null);
  const returnTo = React.useRef(null);
  const timers = React.useRef([]);
  const stateRef = React.useRef({ mounted: false, closing: false });

  const raf = React.useRef(0);
  const later = (fn, ms) => { timers.current.push(setTimeout(fn, ms)); };
  React.useEffect(() => () => { timers.current.forEach(clearTimeout); cancelAnimationFrame(raf.current); }, []);

  const open = React.useCallback(() => {
    if (stateRef.current.mounted && !stateRef.current.closing) return;
    if (isModalOpen()) return;   // never over a modal dialog
    timers.current.forEach(clearTimeout); timers.current = [];
    stateRef.current = { mounted: true, closing: false };
    returnTo.current = document.activeElement;
    setQuery(''); setAct(0); setInstant(true);
    setMounted(true); setClosed(true);
    // Unfold on the next frames (start folded so the clip-path transition runs).
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => { raf.current = requestAnimationFrame(() => { setClosed(false); inputRef.current?.focus({ preventScroll: true }); }); });
  }, []);
  const close = React.useCallback(() => {
    if (!stateRef.current.mounted || stateRef.current.closing) return;
    stateRef.current.closing = true;
    setClosed(true);
    const back = returnTo.current;
    later(() => {
      stateRef.current = { mounted: false, closing: false };
      setMounted(false);
      if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
    }, lxReducedMotion() ? 0 : 500);
  }, []);

  React.useEffect(() => {
    const onOpen = () => open();
    const onToggle = () => (stateRef.current.mounted && !stateRef.current.closing ? close() : open());
    window.addEventListener('open-command-palette', onOpen);
    window.addEventListener('toggle-command-palette', onToggle);
    return () => {
      window.removeEventListener('open-command-palette', onOpen);
      window.removeEventListener('toggle-command-palette', onToggle);
    };
  }, [open, close]);

  const q = query.trim().toLowerCase();
  const items = React.useMemo(() => {
    const all = [
      ...nav.map(n => ({ kind: 'page', group: 'Pages', id: n.id, label: n.label, sub: n.sub, icon: n.icon || 'arrowRight' })),
      ...commands.map(c => ({ kind: 'cmd', group: c.group || 'Commands', id: c.id, label: c.label, sub: c.sub, icon: c.icon || 'sparkle', kbd: c.kbd, onRun: c.onRun })),
      ...tickers.map(t => ({ kind: 'ticker', group: 'Tickers', id: t.sym, label: t.sym, sub: t.name || 'Ticker', icon: 'chart' })),
    ];
    if (!q) return all.slice(0, 40);
    const found = all.filter(it => it.label.toLowerCase().includes(q) || String(it.sub || '').toLowerCase().includes(q));
    const groups = [...new Set(all.map(it => it.group))];
    // Starts-with matches first, groups kept together in their original order.
    found.sort((a, b) => (groups.indexOf(a.group) - groups.indexOf(b.group)) || ((a.label.toLowerCase().startsWith(q) ? 0 : 1) - (b.label.toLowerCase().startsWith(q) ? 0 : 1)));
    return found.slice(0, 40);
  }, [nav, commands, tickers, q]);

  React.useEffect(() => { setAct(0); setInstant(true); }, [q]);
  React.useLayoutEffect(() => { if (mounted) inputRef.current?.focus({ preventScroll: true }); }, [mounted]);

  // Glide the highlight to the active row and keep it in view.
  React.useLayoutEffect(() => {
    if (!mounted) return;
    const body = bodyRef.current, hl = hlRef.current;
    const o = listRef.current?.querySelector(`#${uid}-${act}`);
    if (!body || !hl || !o) return;
    const top = o.offsetTop + 6;
    if (instant) hl.style.transition = 'none';
    hl.style.setProperty('--y', top + 'px');
    if (instant) { void hl.offsetWidth; hl.style.transition = ''; }
    const behavior = instant || lxReducedMotion() ? 'auto' : 'smooth';
    if (top + o.offsetHeight > body.scrollTop + body.clientHeight) body.scrollTo({ top: top + o.offsetHeight - body.clientHeight + 6, behavior });
    else if (top < body.scrollTop + 30) body.scrollTo({ top: act === 0 ? 0 : top - 30, behavior });
  }, [act, instant, items, mounted, uid]);

  const run = (it) => {
    if (!it) return;
    close();
    if (it.kind === 'page') onNavigate?.(it.id);
    else if (it.kind === 'ticker') onPickTicker?.(it.id);
    else it.onRun?.();
  };
  const move = (d) => { if (!items.length) return; setInstant(false); setAct(a => (a + d + items.length) % items.length); };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); run(items[act]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') e.preventDefault();   // focus stays in the field (options use aria-activedescendant)
  };

  if (!mounted) return null;
  const mac = isMac();
  let n = -1, lastGroup = null;
  return createPortal(
    <div className={cx('ux u046-ov', closed && 'is-closed')} onMouseDown={e => { if (e.target === e.currentTarget) close(); }}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}>
      <div className={cx('u046', closed && 'is-closed')} role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="u046-pal">
          <label className="u046-field">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>
            <input ref={inputRef} className="u046-in" type="text" role="combobox" aria-expanded={!closed} aria-autocomplete="list"
              aria-controls={`${uid}-lb`} aria-activedescendant={items[act] ? `${uid}-${act}` : undefined}
              autoComplete="off" spellCheck="false" placeholder={placeholder} aria-label="Search commands"
              value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown} />
            <kbd className="u046-kbd">esc</kbd>
          </label>
          <div ref={bodyRef} className="u046-body">
            <span ref={hlRef} className="u046-hl" aria-hidden="true" style={{ opacity: items.length ? 1 : 0 }} />
            <ul ref={listRef} className="u046-list" role="listbox" id={`${uid}-lb`} aria-label="Commands">
              {items.length === 0 ? (
                <li className="u046-empty" role="presentation"><b>No results for ‘{query.trim()}’</b>Try another word</li>
              ) : items.map((it) => {
                n += 1;
                const i = n;
                const head = it.group !== lastGroup ? <li key={`g-${it.group}`} className="u046-g" role="presentation">{it.group}</li> : null;
                lastGroup = it.group;
                return (
                  <React.Fragment key={`${it.kind}-${it.id}`}>
                    {head}
                    <li className="u046-op" role="option" id={`${uid}-${i}`} aria-selected={i === act} style={{ '--i': i }}
                      onPointerMove={() => { if (act !== i) { setInstant(false); setAct(i); } }}
                      onClick={() => run(it)}>
                      <span className="u046-ic" aria-hidden="true"><Icon name={it.icon} size={14} /></span>
                      <span className="u046-tx">
                        <span className={it.kind === 'ticker' ? 'ticker' : undefined}>{hit(it.label, q)}</span>
                        {it.sub && <small>{it.sub}</small>}
                      </span>
                      {it.kbd ? <kbd className="u046-kbd">{it.kbd}</kbd> : i === act ? <kbd className="u046-kbd">↵</kbd> : null}
                    </li>
                  </React.Fragment>
                );
              })}
            </ul>
          </div>
          <div className="u046-foot" aria-hidden="true">
            <span><kbd className="u046-kbd">↑↓</kbd>Move</span><span><kbd className="u046-kbd">↵</kbd>Open</span>
            <span className="u046-end"><kbd className="u046-kbd">{mac ? '⌘K' : 'Ctrl K'}</kbd>Toggle</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export { CommandPalette, openCommandPalette };
