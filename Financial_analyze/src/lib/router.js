// Hash router. Routes:
//   #/today  #/today/news  #/today/alerts
//   #/scan   #/scan/backtest
//   #/company/:ticker/:tab        tab: overview | statements | notes
//   #/portfolio
//   #/inbox/:tab                  tab: ocr | sync | gmail | activity
//   #/settings
//   #/dev/ui                     component gallery (dev server only)
// Unknown hashes resolve to #/today. Old page ids (home, dashboard, detail, …)
// map onto these via legacyPath().

import React from 'react';

const COMPANY_TABS = ['overview', 'statements', 'notes'];
const INBOX_TABS = ['ocr', 'sync', 'gmail', 'activity'];
const TODAY_TABS = ['news', 'alerts'];
const SCAN_TABS = ['backtest'];

const DEFAULT_TICKER = 'FPT';
const ASSET_KEY = 'helix_active_asset';
const LAST_PAGE_KEY = 'helix_last_page';
const SETTINGS_KEY = 'helix_settings_v1';

const normTicker = (t) => String(t || '').trim().toUpperCase();

// '#/company/FPT/notes' -> { section: 'company', ticker: 'FPT', tab: 'notes' }; null if unknown.
const parseHash = (hash) => {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw.startsWith('/')) return null;
  const parts = raw.slice(1).split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
  const [section, a, b] = parts;
  switch (section) {
    case 'today':
      if (!a) return { section, tab: null };
      return TODAY_TABS.includes(a) && !b ? { section, tab: a } : null;
    case 'scan':
      if (!a) return { section, tab: null };
      return SCAN_TABS.includes(a) && !b ? { section, tab: a } : null;
    case 'company': {
      const ticker = a ? normTicker(a) : null;
      if (ticker && !/^[A-Z0-9.:^=\-_]{1,20}$/.test(ticker)) return null;
      if (b && !COMPANY_TABS.includes(b)) return null;
      return { section, ticker, tab: b || 'overview' };
    }
    case 'portfolio':
    case 'settings':
      return a ? null : { section, tab: null };
    case 'dev':
      // Component gallery, dev server only (import.meta.env is undefined under plain node tests).
      return import.meta.env?.DEV && a === 'ui' && !b ? { section, tab: 'ui' } : null;
    case 'inbox':
      if (!a) return { section, tab: 'ocr' };
      return INBOX_TABS.includes(a) && !parts[2] ? { section, tab: a } : null;
    default:
      return null;
  }
};

const buildHash = (r) => {
  if (!r) return '#/today';
  switch (r.section) {
    case 'today': return r.tab ? `#/today/${r.tab}` : '#/today';
    case 'scan': return r.tab ? `#/scan/${r.tab}` : '#/scan';
    case 'company': return `#/company/${encodeURIComponent(normTicker(r.ticker || DEFAULT_TICKER)).replace(/%3A/gi, ':')}/${r.tab || 'overview'}`;
    case 'inbox': return `#/inbox/${r.tab || 'ocr'}`;
    case 'portfolio': return '#/portfolio';
    case 'settings': return '#/settings';
    case 'dev': return '#/dev/ui';
    default: return '#/today';
  }
};

// Old page ids → route hash. `ticker` fills the company routes.
const legacyPath = (id, ticker = DEFAULT_TICKER) => {
  const t = normTicker(ticker) || DEFAULT_TICKER;
  switch (id) {
    case 'home': case 'dashboard': case 'today': return '#/today';
    case 'news': return '#/today/news';
    case 'alerts': return '#/today/alerts';
    case 'screener': case 'scan': return '#/scan';
    case 'backtest': return '#/scan/backtest';
    case 'detail': case 'company': return buildHash({ section: 'company', ticker: t, tab: 'overview' });
    case 'statements': return buildHash({ section: 'company', ticker: t, tab: 'statements' });
    case 'notes': return buildHash({ section: 'company', ticker: t, tab: 'notes' });
    case 'portfolio': return '#/portfolio';
    case 'sync': return '#/inbox/sync';
    case 'ocr-inbox': case 'inbox': return '#/inbox/ocr';
    case 'gmail': return '#/inbox/gmail';
    case 'activity': return '#/inbox/activity';
    case 'settings': return '#/settings';
    default: return null;
  }
};

// Accepts a hash ('#/scan'), a path ('/scan') or an old page id ('screener').
const resolveTarget = (target, ticker) => {
  const s = String(target || '');
  if (s.startsWith('#/')) return parseHash(s) ? s : '#/today';
  if (s.startsWith('/')) return parseHash('#' + s) ? '#' + s : '#/today';
  return legacyPath(s, ticker) || '#/today';
};

const readJSON = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };

const lastTicker = () => { try { return localStorage.getItem(ASSET_KEY) || DEFAULT_TICKER; } catch { return DEFAULT_TICKER; } };
const rememberTicker = (t) => { try { if (t) localStorage.setItem(ASSET_KEY, normTicker(t)); } catch { /* private mode */ } };

// Where the app opens when the URL has no valid route: the Settings
// "Landing page" choice (old page ids still honoured), or the last route.
const landingHash = () => {
  const s = readJSON(SETTINGS_KEY, {}) || {};
  const landing = s.defaultLanding || 'today';
  if (landing === 'last') {
    let last = null;
    try { last = localStorage.getItem(LAST_PAGE_KEY); } catch { /* ignore */ }
    return last ? resolveTarget(last, lastTicker()) : '#/today';
  }
  return resolveTarget(landing, lastTicker());
};

const rememberLastPage = (hash) => { try { localStorage.setItem(LAST_PAGE_KEY, hash); } catch { /* ignore */ } };

const navigate = (hash, { replace = false } = {}) => {
  if (!hash || hash === window.location.hash) return;
  if (replace) {
    window.history.replaceState(window.history.state, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = hash;   // pushes a history entry, fires hashchange
  }
};

// Current route; replaces an empty/unknown hash with the landing route.
const useRoute = () => {
  const read = () => parseHash(window.location.hash);
  const [route, setRoute] = React.useState(() => {
    const r = read();
    if (r) return r;
    const h = window.location.hash ? '#/today' : landingHash();
    window.history.replaceState(window.history.state, '', h);
    return parseHash(h) || { section: 'today', tab: null };
  });
  React.useEffect(() => {
    const on = () => {
      const r = read();
      if (!r) { navigate('#/today', { replace: true }); return; }
      setRoute(prev => (buildHash(prev) === buildHash(r) && prev.ticker === r.ticker ? prev : r));
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
};

export {
  COMPANY_TABS, INBOX_TABS, DEFAULT_TICKER,
  parseHash, buildHash, legacyPath, resolveTarget, landingHash, navigate, useRoute,
  lastTicker, rememberTicker, rememberLastPage, normTicker,
};
