// Overview cards: key-stat tiles, technical indicators, key ratios, related news.

import React from 'react';
import { Card, EmptyState, StatGrid, StatTile } from '../../ui';
import { formatCompact, formatNumber, formatPct } from '../../lib/format.js';
import { safeHttpUrl } from '../../lib/safe-url.js';
import { clampPct } from './market-utils.js';

const zoneSignal = (v, hi, lo) => v == null ? '' : v >= hi ? 'Overbought' : v <= lo ? 'Oversold' : 'Neutral';
const maSignal = (ma, last) => {
  if (ma == null || last == null) return 'Not enough history';
  const d = ((last - ma) / ma) * 100;
  return `${d >= 0 ? 'Above' : 'Below'} · ${formatPct(d, 1)}`;
};
const signed = (v, d) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${formatNumber(v, d)}`);
const ratioPct = (x) => (x == null ? '—' : formatPct(x * 100, { decimals: 1, sign: false }));

const KeyStats = ({ quote, money, yearLow, yearHigh, lastVolume, nativeCcy, pe }) => {
  const range = (lo, hi) => (lo != null && hi != null ? `${money(lo)} – ${money(hi)}` : '—');
  const cap = quote?.market_cap == null ? '—' : `${formatCompact(quote.market_cap)} ${nativeCcy === 'VND' ? '₫' : nativeCcy}`;
  return (
    <StatGrid auto className="co-stats">
      <StatTile size="sm" label="Open" value={money(quote?.open)} />
      <StatTile size="sm" label="Day range" value={range(quote?.day_low, quote?.day_high)} />
      <StatTile size="sm" label="52W range" value={range(yearLow, yearHigh)} />
      <StatTile size="sm" label="Volume" value={formatCompact(lastVolume)} />
      <StatTile size="sm" label="Mkt cap" value={cap} />
      <StatTile size="sm" label="P/E" value={formatNumber(pe, 1)} />
    </StatGrid>
  );
};

const Indicator = ({ label, value, signal, gauge }) => (
  <li className="co-ind">
    <div className="co-ind-text"><span className="co-ind-label">{label}</span><span className="co-ind-signal">{signal}</span></div>
    <span className="num co-ind-value">{value}</span>
    <span className={gauge == null ? 'co-gauge is-none' : 'co-gauge'} aria-hidden="true">
      {gauge != null && <i className={gauge > 70 ? 'is-hot' : undefined} style={{ width: `${clampPct(gauge)}%` }} />}
    </span>
  </li>
);

const TechnicalsCard = ({ live, daily, tech, money }) => {
  const macd = tech.macd;
  const boll = tech.boll;
  return (
    <Card title="Technical indicators" subtitle="Daily · from 1Y closes" flush>
      {!daily || !daily.length ? (
        <EmptyState size="sm" plain title={live ? (daily ? 'No daily history' : 'Loading…') : 'Backend offline'}
          description={live ? (daily ? 'No daily history available.' : undefined) : 'Connect the backend to compute indicators.'} />
      ) : (
        <ul className="co-list">
          <Indicator label="RSI (14)" value={formatNumber(tech.rsi, 1)} signal={zoneSignal(tech.rsi, 70, 30)} gauge={tech.rsi} />
          <Indicator label="MACD (12,26,9)" value={macd ? signed(macd.line, 2) : '—'}
            signal={!macd ? 'Not enough history' : macd.crossUp ? 'Bullish crossover' : macd.crossDown ? 'Bearish crossover' : macd.line > macd.signal ? 'Above signal line' : 'Below signal line'} />
          <Indicator label="MA 50" value={money(tech.ma50)} signal={maSignal(tech.ma50, tech.last)} />
          <Indicator label="MA 200" value={money(tech.ma200)} signal={maSignal(tech.ma200, tech.last)} />
          <Indicator label="Stochastic %K (14)" value={formatNumber(tech.stoch, 1)} signal={zoneSignal(tech.stoch, 80, 20)} gauge={tech.stoch} />
          <Indicator label="Bollinger (20,2)" value={boll ? `${signed(boll.z, 2)}σ` : '—'}
            signal={!boll ? 'Not enough history' : boll.pctB > 100 ? 'Above upper band' : boll.pctB < 0 ? 'Below lower band' : 'Inside bands'}
            gauge={boll ? clampPct(boll.pctB) : null} />
        </ul>
      )}
    </Card>
  );
};

const RatioRow = ({ label, value }) => (
  <li className="co-ratio"><span>{label}</span><span className="num">{value}</span></li>
);

const RatiosCard = ({ live, vn, ratios }) => {
  const v = ratios?.valuation || {}, p = ratios?.profitability || {}, l = ratios?.liquidity || {};
  return (
    <Card title="Key ratios" subtitle="TTM" flush>
      {!ratios ? (
        <EmptyState size="sm" plain title={!live ? 'Backend offline' : vn ? 'No ratio source yet' : 'Ratios unavailable'}
          description={!live ? 'Connect the backend to load ratios.' : vn ? 'No ratio source for Vietnamese listings yet — see the Statements tab for statement data.' : 'Ratios unavailable for this ticker.'} />
      ) : (
        <ul className="co-list">
          <RatioRow label="P/E (TTM)" value={formatNumber(v.pe_trailing, 1)} />
          <RatioRow label="P/E (Forward)" value={formatNumber(v.pe_forward, 1)} />
          <RatioRow label="P/S" value={formatNumber(v.ps, 1)} />
          <RatioRow label="P/B" value={formatNumber(v.pb, 1)} />
          <RatioRow label="EV/EBITDA" value={formatNumber(v.ev_ebitda, 1)} />
          <RatioRow label="Gross margin" value={ratioPct(p.gross_margin)} />
          <RatioRow label="Net margin" value={ratioPct(p.net_margin)} />
          <RatioRow label="ROE" value={ratioPct(p.roe)} />
          <RatioRow label="Debt / Equity" value={l.debt_to_equity == null ? '—' : `${formatNumber(l.debt_to_equity / 100, 2)}x`} />
        </ul>
      )}
    </Card>
  );
};

const NewsCard = ({ activeAsset, items }) => (
  <Card title={`${activeAsset} news`}>
    {items.length === 0 ? (
      <EmptyState size="sm" plain title="No recent news" description={`No recent news tagged ${activeAsset}.`} />
    ) : (
      <ul className="co-news">
        {items.map((n, i) => {
          const url = safeHttpUrl(n.url);
          return (
            <li key={i} className="co-news-row">
              <span className="news-time">{n.time}</span>
              <div>
                <div className="news-title co-news-title">
                  {url ? <a href={url} target="_blank" rel="noopener noreferrer">{n.title}</a> : n.title}
                </div>
                <div className="news-meta">{n.src}</div>
              </div>
            </li>
          );
        })}
      </ul>
    )}
  </Card>
);

export { KeyStats, TechnicalsCard, RatiosCard, NewsCard };
