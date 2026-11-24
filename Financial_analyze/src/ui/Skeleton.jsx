// Lucian UX/UI Prompt #439 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#439
// Loading skeletons: bones in the place and size of the real content shimmer to hold the space; when
// data arrives the real content fades in over them, one block after another.
//
// <Skeleton width={120} height={14} circle? inline? />      one bone (numbers are px; strings pass through)
// <SkeletonText lines={3} lastWidth="60%" />                a paragraph of bones
// <SkeletonSwap loading={q.loading} skeleton={<SkeletonText lines={4} />}>…real content…</SkeletonSwap>
//   Direct children of the real content fade in with a 0.11 s stagger (the element's --d delays).

import React from 'react';
import { cx } from './util.js';
import './skeleton.css';

const px = (v) => (typeof v === 'number' ? `${v}px` : v);

const Skeleton = ({ width = '100%', height = 12, radius, circle = false, inline = false, className, style }) => (
  <i className={cx('u439-bone', circle && 'is-circle', inline && 'is-inline', className)} aria-hidden="true"
    style={{ width: px(width), height: px(circle ? width : height), ...(radius != null ? { borderRadius: px(radius) } : null), ...style }} />
);

const SkeletonText = ({ lines = 3, height = 11, lastWidth = '58%', className }) => (
  <div className={cx('u439-lines', className)} aria-hidden="true">
    {Array.from({ length: lines }, (_, i) => <Skeleton key={i} height={height} width={i === lines - 1 && lines > 1 ? lastWidth : `${92 - (i % 2) * 6}%`} />)}
  </div>
);

const SkeletonSwap = ({ loading, skeleton, label = 'Loading', className, children }) => (
  <div className={cx('ux u439-swap', loading && 'is-loading', className)} aria-busy={loading || undefined}>
    <div className="u439-real">
      {React.Children.map(children, (child, i) => (React.isValidElement(child)
        ? React.cloneElement(child, { style: { ...child.props.style, '--d': `${(i * 0.11).toFixed(2)}s` } })
        : child))}
    </div>
    <div className="u439-sk" aria-hidden="true">{skeleton}</div>
    {loading && <span className="sr-only" role="status">{label}</span>}
  </div>
);

export { Skeleton, SkeletonText, SkeletonSwap };
