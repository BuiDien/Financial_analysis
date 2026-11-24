// One watch-board tile (select to focus, × to remove) and the focus hero.

import React from 'react';
import '../../../styles/charts.css';   // .helix-line-draw keyframes (sparkline draw-in)
import { AreaChart, Badge, IconButton } from '../../../ui';
import { Icon } from '../../../icons.jsx';
import { formatNumber, formatPct, formatPrice, isNum } from '../../../lib/format.js';
import { INSTRUMENTS, isVnStock } from './instruments.js';

// Native currency only: "$142.36" (USD), "61,500 ₫" (VN stocks), points for
// indices, "%" for yields.
const fmtInstrumentPrice = (sym, v) => {
  const inst = INSTRUMENTS[sym];
  if (!isNum(v) || !inst) return '—';
  if (isVnStock(sym)) return formatPrice(v * 1000, 'VND');
  const s = formatNumber(v, inst.dp);
  if (inst.unit === '$') return `$${s}`;
  return s + (inst.unit === '%' ? '%' : '');
};

const toneOf = (chg) => (!isNum(chg) ? 'neutral' : chg >= 0 ? 'pos' : 'neg');

const TileSpark = ({ series, gen, up }) => {
  if (!series || series.length < 2) return <div className="wb-spark is-empty" aria-hidden="true" />;
  const min = Math.min(...series), max = Math.max(...series), range = (max - min) || 1;
  const step = 190 / (series.length - 1);
  const pts = series.map((v, i) => [i * step, 48 - ((v - min) / range) * 46 - 1]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg className={`wb-spark ${up ? 'is-up' : 'is-down'}`} viewBox="0 0 190 48" preserveAspectRatio="none" aria-hidden="true">
      <path className="wb-spark-area" d={`${line} L190,48 L0,48 Z`} />
      <path key={gen} className="wb-spark-line helix-line-draw" d={line} pathLength="100" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

const WatchTile = ({ sym, q, focused, onFocus, onRemove }) => {
  const inst = INSTRUMENTS[sym];
  const up = !isNum(q.chg) || q.chg >= 0;
  return (
    <div className={`wb-tile${focused ? ' is-focus' : ''}`}>
      <button type="button" className="wb-tile-hit" onClick={onFocus} aria-pressed={focused}
        aria-label={`${sym} ${inst.name}, ${fmtInstrumentPrice(sym, q.price)}`}>
        <span className="wb-tile-head">
          <span className="ticker">{sym}</span>
          {q.state === 'CLOSED' && <Badge sans data-tip="Market closed — chart frozen at the last close">Closed</Badge>}
        </span>
        <span className="wb-tile-name">{inst.name}</span>
        <span className="wb-tile-price num">{fmtInstrumentPrice(sym, q.price)}</span>
        <span className={`wb-tile-chg num is-${toneOf(q.chg)}`}>{formatPct(q.chg)}</span>
        <TileSpark series={q.series} gen={q.gen} up={up} />
      </button>
      <IconButton className="wb-tile-x" icon="close" size="sm" variant="ghost" label={`Remove ${sym}`} onClick={onRemove} />
    </div>
  );
};

const FocusHero = ({ sym, q, onOpen }) => {
  const inst = INSTRUMENTS[sym];
  const isStock = inst.cls === 'Stock' || isVnStock(sym);
  const abs = isNum(q.price) && isNum(q.chg) ? Math.abs(q.price * q.chg / 100) : null;
  return (
    <div className="wb-hero">
      <div className="wb-hero-info">
        <div className="wb-hero-tags">
          <span className="ticker wb-hero-sym">{sym}</span>
          <span className="wb-hero-cls">{inst.cls}</span>
        </div>
        {isStock ? (
          <button type="button" className="wb-hero-name is-link" onClick={onOpen} data-tip="Open full analysis">
            {inst.name} <Icon name="arrowRight" size={14} />
          </button>
        ) : <div className="wb-hero-name">{inst.name}</div>}
        <div className="wb-hero-price num">{fmtInstrumentPrice(sym, q.price)}</div>
        <div className="wb-hero-chg">
          {isNum(q.chg) ? (
            <>
              <Badge tone={toneOf(q.chg)}>{q.chg >= 0 ? '▲' : '▼'} {formatPct(q.chg)}</Badge>
              {abs != null && <span className="num wb-hero-abs">{q.chg >= 0 ? '+' : '−'}{fmtInstrumentPrice(sym, abs)} today</span>}
            </>
          ) : <Badge>—</Badge>}
        </div>
      </div>
      <div className="wb-hero-chart">
        <AreaChart data={q.series?.length >= 2 ? q.series : null} width={760} height={220}
          padding={{ t: 16, r: 50, b: 16, l: 0 }} drawKey={q.gen} />
      </div>
    </div>
  );
};

export { WatchTile, FocusHero, fmtInstrumentPrice };
