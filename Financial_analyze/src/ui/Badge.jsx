// Badge / Tag (tokens only) plus the small numeric display helpers Pill, ChangeText and Sparkline
// (moved here from primitives.jsx). Badge renders the legacy .pill classes.
//
// <Badge tone="neutral|pos|neg|warn|info|accent" dot outline sans>Verified</Badge>
// <Tag onRemove?={() => …}>VN30</Tag>
// <Pill value={1.23} />          signed % chip, tone from the sign
// <ChangeText value={-0.4} />    coloured signed % text
// <Sparkline data={[…]} width height color? fill? />

import React from 'react';
import { isNum } from '../lib/format.js';
import { cx } from './util.js';
import './badge.css';

const TONES = new Set(['neutral', 'pos', 'neg', 'warn', 'info', 'accent']);

const Badge = ({ tone = 'neutral', dot = false, outline = false, sans = false, className, children, ...rest }) => (
  <span className={cx('pill', `pill-${TONES.has(tone) ? tone : 'neutral'}`, dot && 'pill-dot', outline && 'pill-outline', sans && 'is-sans', className)} {...rest}>{children}</span>
);

const Tag = ({ onRemove, removeLabel, className, children, ...rest }) => (
  <span className={cx('tag', !onRemove && 'is-static', className)} {...rest}>
    {children}
    {onRemove && (
      <button type="button" className="tag-x" aria-label={removeLabel || `Remove ${typeof children === 'string' ? children : ''}`.trim()} onClick={onRemove}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    )}
  </span>
);

const Pill = ({ value, type, prefix = '', suffix = '%', decimals = 2 }) => {
  if (!isNum(value)) return <Badge>—</Badge>;
  // Sign and tone follow the shown (rounded) value, so -0.001 reads "0.00%" in neutral.
  const v = Number(Number(value).toFixed(decimals)) || 0;
  const t = type || (v > 0 ? 'pos' : v < 0 ? 'neg' : 'neutral');
  return <Badge tone={t}>{prefix}{v > 0 ? '+' : ''}{v.toFixed(decimals)}{suffix}</Badge>;
};

const ChangeText = ({ value, decimals = 2, suffix = '%' }) => {
  if (!isNum(value)) return <span className="num">—</span>;
  const v = Number(Number(value).toFixed(decimals)) || 0;
  return <span className={cx('num', v > 0 && 'pos', v < 0 && 'neg')}>{v > 0 ? '+' : ''}{v.toFixed(decimals)}{suffix}</span>;
};

const Sparkline = ({ data, width = 80, height = 24, color, fill = false }) => {
  if (!data || data.length < 2 || !data.every(isNum)) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const path = data.map((v, i) => `${i ? 'L' : 'M'}${i * step},${height - ((v - min) / range) * height}`).join(' ');
  const trend = color || (data[data.length - 1] >= data[0] ? 'var(--pos)' : 'var(--neg)');
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {fill && <path d={`${path} L${width},${height} L0,${height} Z`} fill={trend} opacity="0.12" />}
      <path d={path} stroke={trend} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

export { Badge, Tag, Pill, ChangeText, Sparkline };
