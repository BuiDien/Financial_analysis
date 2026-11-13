// Charts — area line + allocation donut, hand-rolled SVG

// Redraw the line from left to right whenever its data changes (e.g. a new
// live quote lands) — pathLength normalizes stroke-dasharray to a fixed
// unit regardless of actual on-screen path length.
if (!document.getElementById('helix-linedraw-style')) {
  const s = document.createElement('style');
  s.id = 'helix-linedraw-style';
  s.textContent = `
    @keyframes helix-line-draw { from { stroke-dashoffset: 100; } to { stroke-dashoffset: 0; } }
    .helix-line-draw { stroke-dasharray: 100; animation: helix-line-draw 500ms ease-out; }
  `;
  document.head.appendChild(s);
}

const AreaChart = ({ data, width = 760, height = 320, padding = { t: 10, r: 50, b: 30, l: 0 }, color, drawKey }) => {
  if (!data || !data.length) return null;
  const W = width - padding.l - padding.r;
  const H = height - padding.t - padding.b;

  const values = data.map(d => typeof d === 'number' ? d : d?.close).filter(v => Number.isFinite(v));
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series (closed market, unchanged price) would give a zero range
  // and NaN paths — pad around the value instead.
  const pad = max > min ? (max - min) * 0.08 : (Math.abs(max) * 0.01 || 1);
  const yMin = min - pad;
  const yMax = max + pad;
  const yRange = yMax - yMin;

  const xScale = i => padding.l + (i / (values.length - 1)) * W;
  const yScale = v => padding.t + ((yMax - v) / yRange) * H;

  const linePath = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xScale(i)},${yScale(v)}`).join(' ');
  const areaPath = `${linePath} L${xScale(values.length - 1)},${padding.t + H} L${xScale(0)},${padding.t + H} Z`;

  const trend = values[values.length - 1] >= values[0];
  const lineColor = color || (trend ? 'var(--pos)' : 'var(--neg)');

  const ticks = 5;
  const tickValues = Array.from({ length: ticks }, (_, i) => yMin + (yRange * i) / (ticks - 1));

  const gradId = `grad-${Math.random().toString(36).slice(2, 9)}`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" width="100%" height="100%">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={lineColor} stopOpacity="0.25" />
          <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      {tickValues.map((v, i) => (
        <line key={i} x1={padding.l} x2={width - padding.r} y1={yScale(v)} y2={yScale(v)}
          stroke="var(--border)" strokeWidth="1" strokeDasharray={i === 0 ? "0" : "2,3"} />
      ))}
      {tickValues.map((v, i) => (
        <text key={i} x={width - padding.r + 6} y={yScale(v) + 3}
          fill="var(--text-subtle)" fontSize="10" fontFamily="var(--font-mono)">
          {v.toFixed(2)}
        </text>
      ))}
      <path d={areaPath} fill={`url(#${gradId})`} />
      {/* drawKey: caller-controlled redraw generation (e.g. bumped once per data
          poll) so the draw-in replays exactly when new data arrives — never from
          unrelated re-renders. Falls back to the last value for static charts. */}
      <path key={drawKey ?? values[values.length - 1]} d={linePath} pathLength="100" className="helix-line-draw"
        fill="none" stroke={lineColor} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

// Donut for portfolio allocation
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

window.AreaChart = AreaChart;
window.Donut = Donut;
