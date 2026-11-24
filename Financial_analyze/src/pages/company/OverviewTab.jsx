// Company › Overview: header, price chart, key stats, technicals, ratios, notes, news.
// Every number comes from the backend (quote, history, ratios) or is computed from real
// daily closes. When a source is missing the field shows "—" or an empty state.

import React from 'react';
import { handoff } from '../../handoff.js';
import { toast } from '../../ui';
import { formatMoney } from '../../lib/format.js';
import { SYMBOL_CATALOG, useWatchlists } from '../../watchlist-store.jsx';
import { LIVE_TICKER as HOME_LIVE_TICKER } from '../today/watch-board/instruments.js';
import { CompanyHeader } from './CompanyHeader.jsx';
import { PriceChartCard } from './PriceChartCard.jsx';
import { KeyStats, NewsCard, RatiosCard, TechnicalsCard } from './OverviewCards.jsx';
import { NotesCard } from './NotesCard.jsx';
import { useCompanyMarket } from './useCompanyMarket.js';
import './company.css';

const MARKET_STATE = { REGULAR: 'Market open', PRE: 'Pre-market', POST: 'After hours' };

// Related news: the feed's ticker tags first, then a whole-word title match on the symbol
// (3+ letters, to avoid noise) or the company name.
const relatedNews = (news, bareAsset, activeAsset, assetName, sameSym) => {
  const terms = [];
  if (bareAsset.length >= 3) terms.push(bareAsset);
  if (assetName && assetName !== activeAsset && assetName.length >= 4) terms.push(assetName.split(' ')[0]);
  const esc = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const titleRe = esc.length ? new RegExp(`(^|[^\\p{L}\\p{N}])(${esc.join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu') : null;
  const tickerHit = (n) => (n.tickers || n.tags || []).some(t => sameSym(String(t).toUpperCase().replace(/^VN:/, '')));
  return [
    ...(news || []).filter(tickerHit),
    ...(news || []).filter(n => !tickerHit(n) && titleRe && titleRe.test(n.title || '')),
  ].slice(0, 6);
};

const PageDetail = ({ activeAsset = 'FPT', data, setActiveAsset, setPage }) => {
  const [range, setRange] = React.useState('1D');            // candle timeframe
  const [chartType, setChartType] = React.useState('candle'); // candle | area
  const [showTrades, setShowTrades] = React.useState(true);
  const store = useWatchlists();

  const holdings = data.portfolio?.holdings || [];
  // The screener opens VN tickers as "VN:HDB" so a bare symbol that is also a US ticker (HDB)
  // is not routed to Yahoo; holdings, names and tags use the bare symbol.
  const bareAsset = String(activeAsset).toUpperCase().replace(/^VN:/, '');
  const sameSym = (sym) => sym === activeAsset || sym === bareAsset;
  const nameOf = (sym) => {
    const bare = String(sym).toUpperCase().replace(/^VN:/, '');
    return (data.watchlist || []).find(x => x.sym === sym || x.sym === bare)?.name || (SYMBOL_CATALOG || {})[bare]?.name || sym;
  };
  const holding = holdings.find(h => sameSym(h.sym));

  const m = useCompanyMarket({ activeAsset, holding, range, showTrades });
  const { live, vn, quote, daily } = m;

  // Vietnamese tickers without a fixed route are stored as "VN:XXX" so the watchlist quotes
  // them from VCI, not a same-named US listing.
  const vnAsset = String(activeAsset).toUpperCase().startsWith('VN:') || holding?.currency === 'VND';
  const watchSym = vnAsset && !(HOME_LIVE_TICKER || {})[bareAsset] ? `VN:${bareAsset}` : bareAsset;
  const inWatchlist = store.isInAny(bareAsset) || store.isInAny(`VN:${bareAsset}`);
  const activeListName = store.getActive()?.name || 'watchlist';
  const toggleWatch = () => {
    const active = store.getActive();
    const present = [bareAsset, `VN:${bareAsset}`].filter(x => active.symbols.includes(x));
    if (present.length) present.forEach(x => store.removeSymbol(active.id, x));
    else store.addSymbol(active.id, watchSym);
    const added = !present.length;
    toast(added ? `Added ${bareAsset} to ${activeListName}` : `Removed ${bareAsset} from ${activeListName}`, { type: added ? 'success' : 'info' });
  };

  // Prices are shown in the listing's own currency, exactly as the exchange quotes them —
  // no FX conversion. VND → "53,600 ₫"; others → "186.64 USD".
  const nativeCcy = (quote?.currency || holding?.currency || (vn ? 'VND' : 'USD')).toUpperCase();
  const money = (n) => formatMoney(n, nativeCcy);   // VND "115,900 ₫", USD "$186.64"

  // VCI gives no 52W range — derive it from the real 1Y daily bars.
  const yearLow = quote?.year_low ?? (daily?.length ? Math.min(...daily.map(b => b.low)) : null);
  const yearHigh = quote?.year_high ?? (daily?.length ? Math.max(...daily.map(b => b.high)) : null);
  // Holding price is a real (ledger-valued) fallback only when live — never the demo snapshot.
  const price = quote?.price ?? (live ? holding?.price : null) ?? null;
  const lastVolume = daily && daily.length ? daily[daily.length - 1].volume : null;

  const statusText = !live
    ? 'Backend offline — no market data'
    : quote
      ? `${MARKET_STATE[quote.market_state] || 'Market closed'} · ${vn ? 'VCI' : 'Yahoo'} · as of ${new Date(quote.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · auto-refresh 60s${m.quoteErr ? ' · last refresh failed' : ''}`
      : m.quoteErr ? `No quote for ${m.market}` : 'Loading quote…';

  const assetName = nameOf(activeAsset);
  const news = relatedNews(data.news, bareAsset, activeAsset, assetName, sameSym);

  return (
    <div className="page co-page">
      <CompanyHeader activeAsset={activeAsset} name={assetName} holdings={holdings} portfolioStatus={data.portfolio?.status}
        live={live} isActive={sameSym} nameOf={nameOf} onPick={(sym) => setActiveAsset && setActiveAsset(sym)}
        price={price} chg={quote?.change_pct ?? null} chgAbs={quote?.change ?? null} money={money}
        statusText={statusText} marketOpen={live && quote?.market_state === 'REGULAR'} quoteErr={m.quoteErr}
        inWatchlist={inWatchlist} activeListName={activeListName} onToggleWatch={toggleWatch}
        onFinancials={() => { handoff.statementsTicker = bareAsset; setPage && setPage('statements'); }}
        onAlert={() => { handoff.alertTicker = watchSym; setPage && setPage('alerts'); }} />

      <PriceChartCard activeAsset={activeAsset} live={live} vn={vn} chartType={chartType} setChartType={setChartType}
        range={range} setRange={setRange} chartState={m.chartState} olderState={m.olderState} ohlc={m.ohlc}
        markers={m.tradeMarkers} currency={nativeCcy} onReachStart={m.loadOlder} marketOff={m.marketOff}
        myTicker={m.myTicker} showTrades={showTrades} setShowTrades={setShowTrades} />

      <KeyStats quote={quote} money={money} yearLow={yearLow} yearHigh={yearHigh} lastVolume={lastVolume}
        nativeCcy={nativeCcy} pe={m.ratios?.valuation?.pe_trailing} />

      <div className="co-grid">
        <TechnicalsCard live={live} daily={daily} tech={m.tech} money={money} />
        <RatiosCard live={live} vn={vn} ratios={m.ratios} />
        <NotesCard key={bareAsset} symbol={activeAsset} />
      </div>

      <NewsCard activeAsset={activeAsset} items={news} />
    </div>
  );
};

export { PageDetail };
