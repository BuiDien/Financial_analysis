// EmptyState (#440) and ErrorState (#090). Styles: ./states.css.

import React from 'react';
import { Icon } from './Icon.jsx';
import { cx, useReducedMotion, useUid } from './util.js';
import './states.css';

// Lucian UX/UI Prompt #440 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#440
// <EmptyState title description? action?={{ label, onClick, icon? } | node} size="sm|md" plain? />
// An empty folder bobs gently; pressing the action drops a document into it (bounce + sparkles) and
// then runs onClick. `plain` renders the quiet text-only block (legacy .empty-state) for tight spots.
// size="sm" is the compact variant of either form: the illustrated one shrinks the folder (112px) and
// type; the plain one drops to 16px padding, a 14px title and 12px text (table cells, side panels).
const EmptyState = ({ title, description, action, size = 'md', plain = false, className, children }) => {
  const [done, setDone] = React.useState(false);
  const rootRef = React.useRef(null);
  if (plain) {
    return (
      <div className={cx('empty-state', size === 'sm' && 'is-sm', className)}>
        {title && <div className="empty-state-title">{title}</div>}
        {description && <div>{description}</div>}
        {action && !React.isValidElement(action) && <div className="u440-act"><button type="button" className="btn" onClick={action.onClick}>{action.label}</button></div>}
        {React.isValidElement(action) && <div className="u440-act">{action}</div>}
        {children}
      </div>
    );
  }
  const run = () => {
    const root = rootRef.current;
    if (done && root) { root.classList.remove('is-done'); void root.offsetWidth; root.classList.add('is-done'); }
    setDone(true);
    action?.onClick?.();
  };
  return (
    <div ref={rootRef} className={cx('ux u440', size === 'sm' && 'is-sm', done && 'is-done', className)}>
      <div className="u440-ill" aria-hidden="true">
        <svg className="u440-il" viewBox="0 0 160 120">
          <ellipse className="sh" cx="80" cy="116" rx="50" ry="5" />
          <path className="sp" d="M138 22l1.8 4.4 4.4 1.8-4.4 1.8-1.8 4.4-1.8-4.4-4.4-1.8 4.4-1.8z" />
          <path className="sp" d="M20 40l1.4 3.4 3.4 1.4-3.4 1.4-1.4 3.4-1.4-3.4-3.4-1.4 3.4-1.4z" />
          <path className="sp" d="M128 70l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z" />
          <g className="fol">
            <path className="bk" d="M28 34a8 8 0 0 1 8-8h22a6 6 0 0 1 4.6 2.2l4.6 5.8H124a8 8 0 0 1 8 8v58a8 8 0 0 1-8 8H36a8 8 0 0 1-8-8z" />
            <g className="doc"><rect className="p" x="50" y="24" width="60" height="58" rx="6" /><rect className="hd" x="57" y="31" width="20" height="5" rx="2.5" /><rect className="ln" x="57" y="42" width="44" height="3.5" rx="1.75" /><rect className="ln" x="57" y="50" width="36" height="3.5" rx="1.75" /></g>
            <path className="fr" d="M22 56a8 8 0 0 1 8-8h100a8 8 0 0 1 8 8.6l-4.4 44a8 8 0 0 1-8 7.4H34.4a8 8 0 0 1-8-7.4z" />
            <path className="fh" d="M30 48h100a8 8 0 0 1 8 8.6l-.3 3H22.1l-.1-3.6A8 8 0 0 1 30 48z" />
          </g>
        </svg>
        <span className="u440-burst">
          {[['-60deg', 'var(--ux-warn)'], ['-25deg', 'var(--ux-mint)'], ['10deg', 'var(--ux-accent-2)'], ['45deg', 'var(--ux-warn)'], ['-95deg', 'var(--ux-accent)'], ['80deg', 'var(--ux-mint)']]
            .map(([a, c], i) => <i key={i} style={{ '--a': a, '--c': c }} />)}
        </span>
      </div>
      {title && <p className="u440-h">{title}</p>}
      {description && <p className="u440-p">{description}</p>}
      {action && (React.isValidElement(action) ? <div className="u440-act">{action}</div> : (
        <div className="u440-act">
          <button type="button" className="u440-go" onClick={run}>
            {action.icon === null ? null : action.icon ? <Icon name={action.icon} size={14} /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>}
            <span>{action.label}</span>
          </button>
        </div>
      ))}
      {children}
    </div>
  );
};

// Lucian UX/UI Prompt #090 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#090
// <ErrorState title message? detail? onRetry?={() => promise} autoRetry={seconds} label="Failed to load"
//   size="sm|md" card? />
// The widget waits with its plug pulled. With autoRetry the ring around the button drains to the next
// automatic try (up to 3 tries). On retry the plug moves in and wobbles; a rejected promise bounces it
// back with sparks and a shake, a resolved one plugs in and the light turns green.
const MAX_TRIES = 3;
const ErrorState = ({
  title = 'Couldn’t load this', message, detail, onRetry, autoRetry = 0, label = 'Failed to load',
  size = 'md', card = false, className,
}) => {
  const uid = useUid('u090');
  const reduced = useReducedMotion();
  const rootRef = React.useRef(null);
  const errRef = React.useRef(null);
  const ringRef = React.useRef(null);
  const timers = React.useRef([]);
  const [st, setSt] = React.useState('wait');
  const [tries, setTries] = React.useState(0);
  const [dots, setDots] = React.useState(['f', '', '']);
  const [left, setLeft] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  React.useEffect(() => clear, []);

  const attempt = React.useCallback(() => {
    if (!onRetry) return;
    clear();
    const n = tries + 1;
    setTries(n);
    setSt('try');
    setDots(d => d.map((x, i) => (i === Math.min(n, MAX_TRIES - 1) ? 'cur' : x)));
    let p;
    try { p = onRetry(); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(() => {
      setDots(d => d.map((x, i) => (i === Math.min(n, MAX_TRIES - 1) ? 'ok' : x)));
      setSt('ok');
    }, () => {
      setDots(d => d.map((x, i) => (i === Math.min(n, MAX_TRIES - 1) ? 'f' : x)));
      const root = rootRef.current;
      if (root) { root.classList.remove('zap'); void root.offsetWidth; root.classList.add('zap'); }
      if (!reduced && errRef.current?.animate) errRef.current.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-3px)' }, { transform: 'none' }], { duration: 420, easing: 'ease-out' });
      setSt('wait');
    });
  }, [onRetry, tries, reduced]);

  // Auto retry countdown: the ring drains linearly over `autoRetry` seconds, the text counts down.
  React.useEffect(() => {
    const ring = ringRef.current;
    if (st !== 'wait' || !autoRetry || !onRetry || tries >= MAX_TRIES - 1) {
      if (ring) { ring.style.transition = 'none'; ring.style.strokeDashoffset = 0; }
      setLeft(0);
      return undefined;
    }
    if (ring) {
      ring.style.transition = 'none'; ring.style.strokeDashoffset = 0; ring.getBoundingClientRect();
      ring.style.transition = `stroke-dashoffset ${autoRetry}s linear`; ring.style.strokeDashoffset = 100;
    }
    let s = autoRetry;
    setLeft(s);
    const tick = () => {
      s -= 1;
      if (s <= 0) { attempt(); return; }
      setLeft(s);
      timers.current.push(setTimeout(tick, 1000));
    };
    timers.current.push(setTimeout(tick, 1000));
    return clear;
  }, [st, autoRetry, tries]); // eslint-disable-line react-hooks/exhaustive-deps

  const pill = st === 'try' ? ['Reconnecting', 'var(--ux-warn)'] : st === 'ok' ? ['OK', 'var(--ux-mint)'] : [label, 'var(--ux-danger)'];
  const status = st === 'try' ? `Attempt ${tries + 1}…` : st === 'ok' ? 'Connected' : left > 0 ? `Retrying automatically in ${left}s` : tries ? `${tries} ${tries === 1 ? 'retry' : 'retries'} failed` : '';
  return (
    <div ref={rootRef} className={cx('ux u090', size === 'sm' && 'is-sm', card && 'is-card', className)} data-s={st} role="group" aria-labelledby={`${uid}-t`}>
      <span className="u090-pill" role="status" style={{ '--c': pill[1] }}>{pill[0]}</span>
      <div ref={errRef} className="u090-err">
        <svg className="u090-plug" viewBox="0 0 220 70" aria-hidden="true">
          <g className="u090-L"><path className="u090-cord" d="M-14 54C24 54 40 35 72 35" /><path className="u090-pr" d="M100 28h14M100 42h14" /><rect className="u090-bd" x="68" y="19" width="34" height="32" rx="8" /></g>
          <g className="u090-spark"><path d="M121 20l-2-7M129 24l5-5M113 24l-5-5M121 50l-2 7M129 46l5 5M113 46l-5 5" /></g>
          <g className="u090-R"><rect className="u090-bd" x="124" y="17" width="38" height="36" rx="9" /><path className="u090-hole" d="M124 28h6M124 42h6" /><circle className="u090-led" cx="153" cy="25" r="3" /><path className="u090-cord" d="M162 35C188 35 194 16 236 16" /></g>
        </svg>
      </div>
      <p className="u090-t" id={`${uid}-t`}>{title}</p>
      {message && <p className="u090-s">{message}</p>}
      {onRetry && <div className="u090-at"><span className="u090-dots" aria-hidden="true">{dots.map((d, i) => <i key={i} className={d} />)}</span><span aria-live="polite">{status}</span></div>}
      {detail && <>
        <button className="u090-more" type="button" aria-expanded={open} aria-controls={`${uid}-det`} onClick={() => setOpen(o => !o)}>
          Details<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" /></svg>
        </button>
        <div className="u090-det" id={`${uid}-det`}><div><code>{detail}</code></div></div>
      </>}
      {onRetry && (
        <button className="u090-go" type="button" aria-disabled={st === 'try'} onClick={() => { if (st === 'wait') attempt(); }}>
          <svg className="u090-ring" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" /><circle ref={ringRef} cx="10" cy="10" r="8" pathLength="100" /></svg>
          <span>{st === 'try' ? 'Connecting' : 'Retry now'}</span>
        </button>
      )}
    </div>
  );
};

export { EmptyState, ErrorState };
