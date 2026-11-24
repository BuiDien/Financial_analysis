// What the AI panel knows about each page: suggestion chips, page descriptions,
// greetings and the live context string sent with every question. No figures
// are hard-coded: a value that isn't loaded is simply left out.

import { formatCompact, formatPct, formatNumber, formatPrice, isNum } from '../../../lib/format.js';
import { WatchlistStore, liveQuoteFor } from '../../../watchlist-store.jsx';

const AI_SUGGESTIONS = {
  dashboard: ['Summarize today\'s market', 'Any unusual moves in my watchlist?', 'What should I watch today?'],
  home: ['What should I watch today?', 'Why is gold moving?', 'Set an alert for one of these'],
  detail: ['Bullish or bearish?', 'Key risks for this stock', 'Compare to sector'],
  portfolio: ['How am I doing today?', 'Concentration risks', 'Rebalance suggestions'],
  screener: ['Explain these rules', 'Why did this ticker fail?', 'Which oversold names look healthiest?'],
  statements: ['Is this company healthy?', 'Red flags in the financials', 'How sustainable are the margins?'],
  news: ['Top story summary', 'What does this mean for my holdings?', 'Macro implications'],
  alerts: ['What alerts should I set for this stock?', 'Suggest a daily-move threshold', 'Explain my triggered alert'],
};

// What each page is — descriptions only, never numbers.
const PAGE_CONTEXT = {
  dashboard: 'The user is on the Today page: Vietnam market pulse (VN-Index, VN30, HNX), global indices, their holdings snapshot, triggered alerts, latest news, a watch board, and their active watchlist with live quotes and top movers.',
  activity: 'The user is on the Inbox Activity tab, looking at background jobs (OCR runs, refreshes, imports) and their status.',
  gmail: 'The user is on the Inbox Gmail import tab, configuring the import of SSI broker report emails.',
  home: 'The user is on the Home watch board — a tracker they personalized with indices, commodities, rates, crypto, and individual stocks. Help them interpret moves and decide what to monitor.',
  detail: 'The user is viewing the asset detail page for one ticker: price chart, key stats, technical indicators, ratios, notes, and related news.',
  portfolio: 'The user is viewing their portfolio. Use only the live portfolio context supplied with this request; never invent holdings or performance.',
  screener: 'The user is on the Vietnam stock screener: a rules funnel over HOSE/HNX/UPCOM. Good-company rules (ROE, growth, debt, cash flow, P/E vs industry, liquidity, bank ratios) narrow the market, then oversold rules (RSI, price drop, volume spike) flag names to look at now. Data is third-party (vnstock) and unverified.',
  statements: 'The user is analyzing financial statements (income, balance sheet, cash flow, ratios) built from verified company filings.',
  news: 'The user is reading market news (Vietnam market, Vietnam companies, US) and can ask for a focused research briefing on any subject.',
  alerts: 'The user is on the Alerts page, where they configure price and percentage-move alerts on tickers. Help them set sensible alert thresholds.',
  backtest: 'The user is on the Backtest page, testing a trading strategy against historical prices.',
  'ocr-inbox': 'The user is in the OCR Inbox, reviewing machine-read financial statements before publishing them.',
  sync: 'The user is on the Sync page, managing OCR worker machines.',
  settings: 'The user is on the Settings page.',
};

const AI_ASSET_PAGES = new Set(['detail', 'statements', 'alerts']);

// Neutral greetings — no market claims, no numbers.
const aiGreeting = (page, asset) => {
  const sym = asset ? String(asset).replace(/^VN:/, '') : '';
  const m = {
    dashboard: 'I can read the Vietnam indices, your active watchlist, and the latest headlines on this page. What would you like to look at?',
    home: 'This is your watch board. Tell me which instrument to break down, or ask me to suggest alert levels.',
    detail: sym ? `Ask me anything about *${sym}* — price action, technicals, ratios, or risks.` : 'Ask me anything about this asset.',
    portfolio: 'I can review your live holdings, performance, cash, and concentration. What would you like to examine?',
    screener: 'This screener narrows the Vietnam market with **good-company rules**, then flags **oversold** names. Ask me about a rule, a threshold, or why a ticker passed or failed.',
    statements: 'Ask me about the statements on screen — profitability, balance-sheet health, cash flow, or red flags.',
    news: 'Ask me to summarize a story, explain what it means for your holdings, or research a subject.',
    alerts: "Tell me a ticker and what you want to catch — a breakout, a dip, or a big daily move — and I'll suggest levels.",
  };
  return m[page] || 'How can I help?';
};

const holdingFor = (data, activeAsset) => (data?.portfolio?.holdings || []).find(h => h.sym === String(activeAsset).replace(/^VN:/, ''));

// Live context for the model, from props + the shared quote cache.
const buildAiView = ({ page, activeAsset, data, live }) => {
  const parts = [PAGE_CONTEXT[page] || `The user is on the ${page} page.`];
  if (!live) {
    parts.push('The backend is offline: no market data is on screen. Do not invent numbers.');
    return parts.join(' ');
  }
  const indices = (data?.indices || []).filter(i => isNum(i.val))
    .map(i => `${i.sym} ${formatNumber(i.val, 2)}${isNum(i.chg) ? ` (${formatPct(i.chg)})` : ''}`);
  if (indices.length && (page === 'dashboard' || page === 'home' || page === 'news')) parts.push(`Live indices (Vietnam first, then global): ${indices.join(', ')}.`);
  if (activeAsset && AI_ASSET_PAGES.has(page)) {
    const q = liveQuoteFor(activeAsset, holdingFor(data, activeAsset)?.currency);
    const quote = q.status === 'ok'
      ? ` Live quote: ${formatPrice(q.price, q.currency)}${isNum(q.chg) ? `, ${formatPct(q.chg)} today` : ''}${q.marketCap != null ? `, market cap ${formatCompact(q.marketCap)} ${q.currency}` : ''}.`
      : ' No live quote loaded for it.';
    parts.push(`Active asset: ${activeAsset}.${quote}`);
  }
  if (page === 'dashboard') {
    const active = WatchlistStore?.getActive();
    const rows = (active?.symbols || []).map(s => ({ s, q: liveQuoteFor(s) })).filter(r => r.q.status === 'ok')
      .map(r => `${r.s} ${formatPrice(r.q.price, r.q.currency)}${isNum(r.q.chg) ? ` ${formatPct(r.q.chg)}` : ''}`);
    if (rows.length) parts.push(`Watchlist "${active.name}": ${rows.join(', ')}.`);
  }
  return parts.join(' ');
};

const TONE = {
  concise: 'Respond in 2-4 short paragraphs OR a tight bulleted list.',
  detailed: 'Give a thorough answer: short sections with a bulleted breakdown of drivers, context, and caveats.',
  'numbers-only': 'Answer almost entirely in figures: a tight bulleted list of numbers with minimal prose.',
};

const readAiSettings = () => {
  try { return JSON.parse(localStorage.getItem('helix_settings_v1') || '{}'); } catch { return {}; }
};

const responseStyle = () => `${TONE[readAiSettings().aiTone] || TONE.concise} Use **bold** for key figures and *italic* for ticker symbols. Be direct, no fluff. Don't add disclaimers about not being a financial advisor — the user knows. Do not use emoji.`;

// Compact live portfolio JSON for the Portfolio page (camel- or snake-cased input).
const portfolioContext = (pf) => (pf ? JSON.stringify({
  currency: pf.display_currency || pf.displayCurrency || 'USD', totalValue: pf.total_value ?? pf.totalValue,
  dayChange: pf.today_change ?? pf.dayChange, totalGain: pf.total_gain ?? pf.totalGain,
  holdings: (pf.holdings || []).slice(0, 20).map(h => ({ ticker: h.ticker || h.sym, weight: h.weight, gainPct: h.gain_pct ?? h.gainPct })),
}) : '');

export { AI_SUGGESTIONS, AI_ASSET_PAGES, aiGreeting, buildAiView, holdingFor, readAiSettings, responseStyle, portfolioContext };
