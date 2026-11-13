// Shared primitives: pills, sparklines, formatting helpers, light markdown.
// Every number formatter returns "—" for a missing value — never 0 or NaN.

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

// locale 'user' = the browser's locale; default stays en-US (1,234.56).
const fmtNum = (n, decimals = 2, locale = 'en-US') => {
  if (!isNum(n)) return '—';
  return Number(n).toLocaleString(locale === 'user' ? undefined : locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

const fmtPct = (n, decimals = 2) => {
  if (!isNum(n)) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(decimals)}%`;
};

// Compact magnitude: 3.49T / 832.00B / 21.30M / 4.5K.
const fmtBig = (n) => {
  if (!isNum(n)) return '—';
  const v = Number(n);
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
};

// Locale currency format (Intl): "$1,234.56", "₫1,234,000".
const fmtMoney = (value, currency = 'USD', digits = 2) => {
  if (!isNum(value)) return '—';
  const n = Number(value);
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n); }
  catch { return `${currency} ${n.toLocaleString(undefined, { maximumFractionDigits: digits })}`; }
};

// A listing's price in its own currency, no FX: "53,600 ₫", "186.64 USD".
const fmtNativePrice = (n, ccy = 'USD') => {
  if (!isNum(n)) return '—';
  const c = String(ccy || 'USD').toUpperCase();
  return c === 'VND' ? `${fmtNum(n, 0)} ₫` : `${fmtNum(n)} ${c}`;
};

// Only http(s) links are ever rendered as clickable (no javascript:/data: URLs).
const safeHttpUrl = (u) => {
  if (typeof u !== 'string' || !u) return null;
  try {
    const url = new URL(u, window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
};

// News timestamp (epoch seconds): "14:05" today, "Nov 10 14:05" otherwise.
const fmtNewsTime = (epochSec) => {
  if (!isNum(epochSec)) return '—';
  const d = new Date(Number(epochSec) * 1000);
  const hm = d.toTimeString().slice(0, 5);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hm;
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return `${md} ${hm}`;
};

const Pill = ({ value, type, prefix = '', suffix = '%', decimals = 2 }) => {
  if (!isNum(value)) return <span className="pill pill-neutral">—</span>;
  const v = Number(value);
  const t = type || (v > 0 ? 'pos' : v < 0 ? 'neg' : 'neutral');
  const cls = t === 'pos' ? 'pill-pos' : t === 'neg' ? 'pill-neg' : 'pill-neutral';
  const sign = v > 0 ? '+' : '';
  return (
    <span className={`pill ${cls}`}>
      {prefix}{sign}{v.toFixed(decimals)}{suffix}
    </span>
  );
};

const ChangeText = ({ value, decimals = 2, suffix = '%' }) => {
  if (!isNum(value)) return <span className="num">—</span>;
  const v = Number(value);
  const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  const sign = v > 0 ? '+' : '';
  return <span className={`num ${cls}`}>{sign}{v.toFixed(decimals)}{suffix}</span>;
};

// Sparkline SVG
const Sparkline = ({ data, width = 80, height = 24, color, fill = false }) => {
  if (!data || data.length < 2 || !data.every(isNum)) return null;
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

// ── Light markdown (**bold**, *italic*, - lists, paragraphs) ─────────────
// variant 'ai':   AI chat — also [text](url) and bare http(s) URLs as links.
//                 Images (![alt](url)) are rendered as a link, never loaded.
// variant 'news': briefings / article text — emphasis only, accent italics.
const mdLinkStyle = {
  color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: 2,
  fontWeight: 500, wordBreak: 'break-word'
};

const MD_PATTERNS = {
  ai: [
    { type: 'img', re: /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/ },
    { type: 'link', re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/ },
    { type: 'url', re: /(https?:\/\/[^\s)]+)/ },
    { type: 'b', re: /\*\*(.+?)\*\*/ },
    { type: 'i', re: /\*(.+?)\*/ }],
  news: [
    { type: 'b', re: /\*\*(.+?)\*\*/ },
    { type: 'i', re: /\*(.+?)\*/ }],
};

const mdInline = (str, variant) => {
  const patterns = MD_PATTERNS[variant] || MD_PATTERNS.news;
  const parts = [];
  let remaining = str;
  let key = 0;
  while (remaining.length) {
    let best = null;
    for (const p of patterns) {
      const m = remaining.match(p.re);
      if (m && (best === null || m.index < best.index)) best = { ...m, type: p.type, _len: m[0].length };
      if (best && best.index === 0) break;
    }
    if (!best) { parts.push(remaining); break; }
    if (best.index > 0) parts.push(remaining.slice(0, best.index));
    const href = (best.type === 'img' || best.type === 'link') ? safeHttpUrl(best[2]) : best.type === 'url' ? safeHttpUrl(best[1]) : null;
    if (best.type === 'img') {
      parts.push(href
        ? <a key={key++} href={href} target="_blank" rel="noopener noreferrer" style={mdLinkStyle}>{`Image: ${best[1] || href}`}</a>
        : best[1]);
    } else if (best.type === 'link') {
      parts.push(href ? <a key={key++} href={href} target="_blank" rel="noopener noreferrer" style={mdLinkStyle}>{best[1]}</a> : best[1]);
    } else if (best.type === 'url') {
      parts.push(href ? <a key={key++} href={href} target="_blank" rel="noopener noreferrer" style={mdLinkStyle}>{best[1]}</a> : best[1]);
    } else if (best.type === 'b') {
      parts.push(<strong key={key++}>{best[1]}</strong>);
    } else if (variant === 'ai') {
      parts.push(<em key={key++}>{best[1]}</em>);
    } else {
      parts.push(<em key={key++} style={{ fontStyle: 'normal', color: 'var(--accent)', fontWeight: 600 }}>{best[1]}</em>);
    }
    remaining = remaining.slice(best.index + best._len);
  }
  return parts;
};

const MarkdownText = ({ text, variant = 'news' }) => {
  const ai = variant === 'ai';
  const lines = String(text ?? '').split('\n');
  const out = [];
  let list = [];
  const flush = () => {
    if (!list.length) return;
    out.push(ai
      ? <ul key={`ul-${out.length}`}>{list.map((l, i) => <li key={i}>{mdInline(l, variant)}</li>)}</ul>
      : <ul key={'u' + out.length} style={{ margin: '6px 0', paddingLeft: 18 }}>{list.map((l, i) => <li key={i} style={{ margin: '3px 0' }}>{mdInline(l, variant)}</li>)}</ul>);
    list = [];
  };
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('- ') || t.startsWith('• ')) list.push(t.slice(2));
    else {
      flush();
      if (t) out.push(<p key={'p' + i} style={{ margin: ai ? '0 0 8px' : '6px 0' }}>{mdInline(t, variant)}</p>);
    }
  });
  flush();
  return <>{out}</>;
};

window.isNum = isNum;
window.fmtNum = fmtNum;
window.fmtPct = fmtPct;
window.fmtBig = fmtBig;
window.fmtMoney = fmtMoney;
window.fmtNativePrice = fmtNativePrice;
window.safeHttpUrl = safeHttpUrl;
window.fmtNewsTime = fmtNewsTime;
window.Pill = Pill;
window.ChangeText = ChangeText;
window.Sparkline = Sparkline;
window.heatColor = heatColor;
window.MarkdownText = MarkdownText;
