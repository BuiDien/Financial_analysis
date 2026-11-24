// Donut for portfolio allocation (hand-rolled SVG; moved from src/charts.jsx — the area chart now lives in src/ui).
import React from 'react';

const Donut = ({ segments, size = 140, thickness = 22 }) => {
  const r = size / 2 - thickness / 2;
  const cx = size / 2;
  const cy = size / 2;
  segments = (segments || []).filter(x => Number.isFinite(x.value) && x.value > 0);
  const total = segments.reduce((s, x) => s + x.value, 0);
  let acc = 0;
  // A single 100% slice is a full circle — an SVG arc with equal endpoints draws nothing.
  const arcs = segments.length === 1 ? [] : segments.map((seg, i) => {
    const start = (acc / total) * 360 - 90;
    acc += seg.value;
    const end = (acc / total) * 360 - 90;
    const large = end - start > 180 ? 1 : 0;
    const x1 = cx + r * Math.cos((start * Math.PI) / 180);
    const y1 = cy + r * Math.sin((start * Math.PI) / 180);
    const x2 = cx + r * Math.cos((end * Math.PI) / 180);
    const y2 = cy + r * Math.sin((end * Math.PI) / 180);
    return { d: `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2}`, color: seg.color, label: seg.label };
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={segments.length === 1 ? segments[0].color : 'var(--border)'} strokeWidth={thickness} />
      {arcs.map((a, i) => (
        <path key={i} d={a.d} fill="none" stroke={a.color} strokeWidth={thickness} strokeLinecap="butt" />
      ))}
    </svg>
  );
};

export { Donut };
