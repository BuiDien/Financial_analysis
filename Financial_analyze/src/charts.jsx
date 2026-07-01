// Charts — candlestick / area / line, all hand-rolled SVG

// Generate plausible OHLC data
const genOHLC = (n, basePrice = 100, volatility = 0.02, seed = 1) => {
  let s = seed * 9999;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const data = [];
  let price = basePrice;
  for (let i = 0; i < n; i++) {
    const open = price;
    const change = (rnd() - 0.48) * volatility * price;
    const close = open + change;
    const high = Math.max(open, close) + rnd() * volatility * price * 0.5;
    const low = Math.min(open, close) - rnd() * volatility * price * 0.5;
    const volume = Math.round(rnd() * 5000000 + 1000000);
    data.push({ open, high, low, close, volume, idx: i });
    price = close;
  }
  return data;
};

const Candlestick = ({ data, width = 760, height = 320, padding = { t: 10, r: 50, b: 30, l: 0 } }) => {
  if (!data || !data.length) return null;
  const W = width - padding.l - padding.r;
  const H = height - padding.t - padding.b;

  const allPrices = data.flatMap(d => [d.high, d.low]);
  const min = Math.min(...allPrices);
  const max = Math.max(...allPrices);
  const range = max - min;
  const pad = range * 0.08;
  const yMin = min - pad;
  const yMax = max + pad;
  const yRange = yMax - yMin;

  const xScale = i => padding.l + (i / (data.length - 1)) * W;
  const yScale = v => padding.t + ((yMax - v) / yRange) * H;

  const candleWidth = Math.max(2, (W / data.length) * 0.7);

  // y-axis ticks
  const ticks = 5;
  const tickValues = Array.from({ length: ticks }, (_, i) => yMin + (yRange * i) / (ticks - 1));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" width="100%" height="100%">
      {/* gridlines */}
      {tickValues.map((v, i) => (
        <line key={i} x1={padding.l} x2={width - padding.r} y1={yScale(v)} y2={yScale(v)}
          stroke="var(--border)" strokeWidth="1" strokeDasharray={i === 0 ? "0" : "2,3"} />
      ))}
      {/* y-axis labels */}
      {tickValues.map((v, i) => (
        <text key={i} x={width - padding.r + 6} y={yScale(v) + 3}
          fill="var(--text-subtle)" fontSize="10" fontFamily="var(--font-mono)">
          {v.toFixed(2)}
        </text>
      ))}
      {/* candles */}
      {data.map((d, i) => {
        const x = xScale(i);
        const isUp = d.close >= d.open;
        const color = isUp ? 'var(--pos)' : 'var(--neg)';
        const yOpen = yScale(d.open);
        const yClose = yScale(d.close);
        const yHigh = yScale(d.high);
        const yLow = yScale(d.low);
        const bodyTop = Math.min(yOpen, yClose);
        const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={yHigh} y2={yLow} stroke={color} strokeWidth="1" />
            <rect x={x - candleWidth / 2} y={bodyTop} width={candleWidth} height={bodyHeight}
              fill={isUp ? color : color} opacity={isUp ? 1 : 1} />
          </g>
        );
      })}
    </svg>
  );
};

const AreaChart = ({ data, width = 760, height = 320, padding = { t: 10, r: 50, b: 30, l: 0 }, color }) => {
  if (!data || !data.length) return null;
  const W = width - padding.l - padding.r;
  const H = height - padding.t - padding.b;

  const values = data.map(d => typeof d === 'number' ? d : d.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.08;
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
      <path d={linePath} fill="none" stroke={lineColor} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

const VolumeBars = ({ data, width = 760, height = 60, padding = { t: 4, r: 50, b: 4, l: 0 } }) => {
  if (!data || !data.length) return null;
  const W = width - padding.l - padding.r;
  const H = height - padding.t - padding.b;

  const max = Math.max(...data.map(d => d.volume));
  const xScale = i => padding.l + (i / (data.length - 1)) * W;
  const barWidth = Math.max(2, (W / data.length) * 0.7);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" width="100%" height="100%">
      {data.map((d, i) => {
        const h = (d.volume / max) * H;
        const x = xScale(i);
        const isUp = d.close >= d.open;
        return (
          <rect key={i} x={x - barWidth / 2} y={padding.t + H - h}
            width={barWidth} height={h}
            fill={isUp ? 'var(--pos)' : 'var(--neg)'} opacity="0.4" />
        );
      })}
    </svg>
  );
};

// Donut for portfolio allocation
const Donut = ({ segments, size = 140, thickness = 22 }) => {
  const r = size / 2 - thickness / 2;
  const cx = size / 2;
  const cy = size / 2;
  const total = segments.reduce((s, x) => s + x.value, 0);
  let acc = 0;
  const arcs = segments.map((seg, i) => {
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
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={thickness} />
      {arcs.map((a, i) => (
        <path key={i} d={a.d} fill="none" stroke={a.color} strokeWidth={thickness} strokeLinecap="butt" />
      ))}
    </svg>
  );
};

window.genOHLC = genOHLC;
window.Candlestick = Candlestick;
window.AreaChart = AreaChart;
window.VolumeBars = VolumeBars;
window.Donut = Donut;
