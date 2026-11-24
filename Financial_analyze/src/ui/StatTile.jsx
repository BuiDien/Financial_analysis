// Lucian UX/UI Prompt #098 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#098
// KPI tile: each digit of the value rolls on its own (only digits that change spin), a delta badge
// flips its arrow for up/down, and an optional area sparkline morphs to new data.
//
// <StatTile label="Portfolio value" value={500000000} format={v => formatMoney(v, 'VND')}
//   delta={0.3} deltaLabel="today" spark={[…]} live size="sm|md|lg" card />
// value: number (rolled through `format`) or a ready string. delta: % change (sign sets the tone).
// <StatGrid auto?>…tiles…</StatGrid> renders the legacy .stat-grid (hairline-separated tiles).
// <RollingNumber text="1,234 ₫" /> is the digit roller on its own.

import React from 'react';
import { formatPct, isNum } from '../lib/format.js';
import { cx, useReducedMotion, useUid } from './util.js';
import './stat.css';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

// One mask (digit positions) per mount: a new shape remounts and rolls up from zero, a same-shape
// update spins only the digits that differ.
const DigitRun = ({ text, reduced }) => {
  const [armed, setArmed] = React.useState(reduced);
  React.useEffect(() => {
    if (armed) return undefined;
    let r = requestAnimationFrame(() => { r = requestAnimationFrame(() => setArmed(true)); });
    return () => cancelAnimationFrame(r);
  }, [armed]);
  let di = 0;
  return text.split('').map((ch, i) => {
    if (/\d/.test(ch)) {
      const d = armed ? Number(ch) : 0;
      return <span key={i} className="u098-col" style={{ '--d': d, '--i': di++ }} aria-hidden="true">{DIGITS.map(n => <span key={n}>{n}</span>)}</span>;
    }
    return <span key={i} className={cx('u098-sym', (ch === '%' || ch === '₫') && 'sm')} aria-hidden="true">{ch}</span>;
  });
};

const RollingNumber = ({ text, className, label }) => {
  const reduced = useReducedMotion();
  const s = String(text ?? '—');
  const mask = s.replace(/\d/g, '0');
  return (
    <div className={cx('u098-num', className)} role="img" aria-label={label ? `${label} ${s}` : s} style={{ '--n': Math.max(6, s.length) }}>
      <DigitRun key={mask} text={s} reduced={reduced} />
    </div>
  );
};

const W = 100, H = 40;
const sparkPath = (ys) => ys.map((y, i) => `${i ? 'L' : 'M'}${(i * W / (ys.length - 1)).toFixed(2)} ${y.toFixed(2)}`).join('');

// Area sparkline; when the data changes (same length) the line morphs over 600 ms (the element's
// easeInOutCubic tween); the rAF loop is cancelled on change/unmount.
const StatSpark = ({ data }) => {
  const uid = useUid('u098g');
  const reduced = useReducedMotion();
  const target = React.useMemo(() => {
    const v = data.filter(isNum).map(Number);
    if (v.length < 2) return null;
    const mn = Math.min(...v), mx = Math.max(...v), p = (mx - mn) * 0.35 || 1;
    return v.map(x => 4 + (1 - (x - (mn - p)) / ((mx + p) - (mn - p))) * (H - 8));
  }, [data]);
  const [ys, setYs] = React.useState(target);
  const ysRef = React.useRef(target);
  React.useEffect(() => {
    if (!target) { setYs(null); ysRef.current = null; return undefined; }
    const from = ysRef.current;
    if (reduced || !from || from.length !== target.length) { setYs(target); ysRef.current = target; return undefined; }
    let raf = 0; const t0 = performance.now();
    const f = (now) => {
      const t = Math.min(1, (now - t0) / 600), e = t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const cur = from.map((y, j) => y + (target[j] - y) * e);
      ysRef.current = cur; setYs(cur);
      if (t < 1) raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [target, reduced]);
  if (!ys) return null;
  const p = sparkPath(ys), n = ys.length - 1;
  return (
    <div className="u098-sp" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs><linearGradient id={uid} className="u098-gd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopOpacity=".26" /><stop offset="1" stopOpacity="0" /></linearGradient></defs>
        <path d={`${p}L${W} ${H + 4}L0 ${H + 4}Z`} fill={`url(#${uid})`} />
        <path className="u098-ln" d={p} />
      </svg>
      <i className="u098-hd" style={{ left: 'calc(100% - 8px)', top: `${(ys[n] / H) * 100}%` }} />
    </div>
  );
};

const StatTile = ({
  label, value, format, delta, deltaLabel, deltaFormat = (d) => formatPct(Math.abs(d), { sign: false }), spark, tone, live = false,
  size = 'md', card = false, className, children,
}) => {
  const text = typeof value === 'string' ? value : isNum(value) ? (format ? format(Number(value)) : String(value)) : '—';
  const hasDelta = isNum(delta);
  const d = hasDelta ? Number(delta) : 0;
  const t = tone || (d > 0 ? 'pos' : d < 0 ? 'neg' : 'flat');
  const c = t === 'pos' ? 'var(--ux-mint)' : t === 'neg' ? 'var(--ux-danger)' : 'var(--ux-ink-3)';
  return (
    <div className={cx('ux u098', `is-${size}`, card && 'is-card', className)} style={{ '--c': spark && !hasDelta ? 'var(--ux-accent)' : c }}>
      <div className="u098-h">{live && <i className="u098-live" aria-hidden="true" />}<span>{label}</span></div>
      <RollingNumber text={text} label={typeof label === 'string' ? label : undefined} />
      {(hasDelta || deltaLabel) && (
        <div className="u098-dl">
          {hasDelta && (
            <span className={cx('u098-bd', d < 0 && 'dn', t === 'flat' && 'flat')}>
              <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.5L9 7.5H1z" /></svg>
              <b>{d < 0 ? '−' : d > 0 ? '+' : ''}{deltaFormat(d)}</b>
            </span>
          )}
          {deltaLabel && <span>{deltaLabel}</span>}
        </div>
      )}
      {children}
      {spark && <StatSpark data={spark} />}
    </div>
  );
};

const StatGrid = ({ auto = false, className, children, ...rest }) => (
  <div className={cx('stat-grid', auto && 'is-auto', className)} {...rest}>{children}</div>
);

export { StatTile, StatGrid, RollingNumber };
