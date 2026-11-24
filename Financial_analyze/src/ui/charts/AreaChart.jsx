// AreaChart (src/ui): the app's area line chart (same props and look as ../../charts.jsx AreaChart),
// drawn at the container's real pixel size instead of a stretched viewBox. No Lucian match (a plain
// price area); built from the app tokens.
//
// <AreaChart data={[n…] | [{ close }…]} width={760} height={320} padding={{ t, r, b, l }} color? drawKey?
//   ticks? formatTick? />
// - The SVG measures its box (ResizeObserver). width / height are only the fallback before the first
//   measure (and the height when the box has none of its own), so text is never squashed: at 375px
//   the axis labels keep their 10px mono size.
// - Axis density follows the space: one gridline per ~44px of plot height (2–`ticks`, default 5), and
//   a label is skipped if it would touch the one above it. The right gutter grows to the widest label.
// - drawKey replays the left-to-right draw-in exactly when you bump it (as before).

import React from 'react';
import { formatCompact, formatNumber } from '../../lib/format.js';
import { lxMeasure } from '../util.js';
import { thinLabels, tickCount } from '../logic.js';
import './area-chart.css';

const axisLabel = (v) => (Math.abs(v) >= 1e4 ? formatCompact(v) : formatNumber(v, 2));
const TICK_FONT = '10px ui-monospace, SFMono-Regular, Menlo, monospace';

const AreaChart = ({
  data, width = 760, height = 320, padding = { t: 10, r: 50, b: 30, l: 0 }, color, drawKey, ticks = 5, formatTick = axisLabel, className,
}) => {
  const boxRef = React.useRef(null);
  const [box, setBox] = React.useState(null);   // { w, h, autoH }
  const gradId = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const values = (data || []).map(d => (typeof d === 'number' ? d : d?.close)).filter(v => Number.isFinite(v));
  const drawable = values.length >= 2;
  React.useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    // autoH: the container gives no height of its own (decided on the first measure), so the chart
    // keeps the caller's width:height ratio instead.
    let autoH = null;
    const read = () => {
      const w = Math.round(el.clientWidth), h = Math.round(el.clientHeight);
      if (autoH === null) autoH = h <= 8;
      setBox(b => (b && b.w === w && b.h === h && b.autoH === autoH ? b : { w, h, autoH }));
    };
    read();
    if (!('ResizeObserver' in window)) return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [drawable]);

  if (!drawable) return null;

  const Wt = box && box.w > 0 ? box.w : width;
  const Ht = box && !box.autoH ? box.h : Math.round(height * (Wt / width));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = max > min ? (max - min) * 0.08 : (Math.abs(max) * 0.01 || 1);
  const yMin = min - pad, yMax = max + pad, yRange = yMax - yMin;

  const t = padding.t ?? 10, b = padding.b ?? 30, l = padding.l ?? 0;
  const H = Math.max(10, Ht - t - b);
  const n = tickCount(H, ticks);
  const tickValues = Array.from({ length: n }, (_, i) => yMin + (yRange * i) / (n - 1));
  const labels = tickValues.map(v => formatTick(v));
  const labelW = Math.ceil(Math.max(...labels.map(s => lxMeasure(s, TICK_FONT)))) + 10;
  const r = Math.max(Math.min(padding.r ?? 50, Wt * 0.3), labelW);
  const W = Math.max(10, Wt - l - r);

  const xScale = i => l + (i / (values.length - 1)) * W;
  const yScale = v => t + ((yMax - v) / yRange) * H;
  const linePath = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${xScale(values.length - 1).toFixed(1)},${t + H} L${xScale(0).toFixed(1)},${t + H} Z`;
  const trend = values[values.length - 1] >= values[0];
  const lineColor = color || (trend ? 'var(--pos)' : 'var(--neg)');

  // Labels top-down; skip one that would overlap the last drawn (12px line box).
  const shown = thinLabels(tickValues.map(v => yScale(v)), 12).map(i => ({ i, y: yScale(tickValues[i]) }));

  return (
    <div ref={boxRef} className={['ui-area', className].filter(Boolean).join(' ')} style={box && box.autoH ? { height: Ht } : undefined}>
      <svg width={Wt} height={Ht} viewBox={`0 0 ${Wt} ${Ht}`} role="img" aria-label={`Line chart, ${values.length} points, ${trend ? 'up' : 'down'} over the range`}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.25" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        {tickValues.map((v, i) => (
          <line key={i} x1={l} x2={Wt - r} y1={yScale(v)} y2={yScale(v)} stroke="var(--border)" strokeWidth="1" strokeDasharray={i === 0 ? '0' : '2,3'} shapeRendering="crispEdges" />
        ))}
        {shown.map(tk => (
          <text key={tk.i} x={Wt - r + 6} y={tk.y + 3} fill="var(--text-subtle)" fontSize="10" fontFamily="var(--font-mono)">{labels[tk.i]}</text>
        ))}
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path key={drawKey ?? values[values.length - 1]} d={linePath} pathLength="100" className="ui-area-line"
          fill="none" stroke={lineColor} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  );
};

export { AreaChart };
