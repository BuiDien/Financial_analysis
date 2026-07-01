// Shared primitives: pills, sparklines, formatting helpers

const fmtNum = (n, decimals = 2) => {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

const fmtPct = (n, decimals = 2) => {
  if (n === null || n === undefined) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(decimals)}%`;
};

const fmtCurrency = (n, decimals = 2) => {
  if (n === null || n === undefined) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

const Pill = ({ value, type, prefix = '', suffix = '%', decimals = 2 }) => {
  const t = type || (value > 0 ? 'pos' : value < 0 ? 'neg' : 'neutral');
  const cls = t === 'pos' ? 'pill-pos' : t === 'neg' ? 'pill-neg' : 'pill-neutral';
  const sign = value > 0 ? '+' : '';
  return (
    <span className={`pill ${cls}`}>
      {prefix}{sign}{value.toFixed(decimals)}{suffix}
    </span>
  );
};

const ChangeText = ({ value, decimals = 2, suffix = '%' }) => {
  const cls = value > 0 ? 'pos' : value < 0 ? 'neg' : '';
  const sign = value > 0 ? '+' : '';
  return <span className={`num ${cls}`}>{sign}{value.toFixed(decimals)}{suffix}</span>;
};

// Sparkline SVG
const Sparkline = ({ data, width = 80, height = 24, color, fill = false }) => {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const points = data.map((v, i) => [i * step, height - ((v - min) / range) * height]);
  const path = points.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(' ');
  const last = data[data.length - 1];
  const first = data[0];
  const trendColor = color || (last >= first ? 'var(--pos)' : 'var(--neg)');

  const areaPath = fill ? `${path} L${width},${height} L0,${height} Z` : '';

  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {fill && <path d={areaPath} fill={trendColor} opacity="0.12" />}
      <path d={path} stroke={trendColor} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

// Heat color: maps -3% to +3% to a red->neutral->green gradient
const heatColor = (chg) => {
  const clamp = Math.max(-3, Math.min(3, chg));
  const t = (clamp + 3) / 6; // 0..1
  if (t < 0.5) {
    // red -> neutral
    const k = t * 2; // 0..1 (0 = full red, 1 = neutral)
    const lightness = 35 + k * 15; // 35 -> 50
    const sat = 60 - k * 30;
    return `hsl(0, ${sat}%, ${lightness}%)`;
  } else {
    const k = (t - 0.5) * 2;
    const lightness = 50 - k * 15;
    const sat = 30 + k * 30;
    return `hsl(140, ${sat}%, ${lightness}%)`;
  }
};

window.fmtNum = fmtNum;
window.fmtPct = fmtPct;
window.fmtCurrency = fmtCurrency;
window.Pill = Pill;
window.ChangeText = ChangeText;
window.Sparkline = Sparkline;
window.heatColor = heatColor;
