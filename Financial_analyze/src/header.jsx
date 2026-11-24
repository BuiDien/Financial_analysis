// Top header with the index ticker tape — VN indices first, then the global
// ones (S&P, NASDAQ, DOW, RUSSELL, VIX, 10Y, BTC, GOLD, OIL); live data or nothing.

import React from 'react';
import { ApiStatusChip } from './api-client.jsx';
import { IconButton, openCommandPalette } from './ui/index.js';
import { formatNumber, formatPct, isNum } from './lib/format.js';
import { useGlobalIndices, useVnIndices } from './lib/data.js';

const TickerTape = ({ indices }) => {
  // Only items with a real value — a failed index is left out, never invented.
  const items = (indices || []).filter(it => isNum(it.val));
  if (!items.length) return <div className="ticker-tape"></div>;
  // Duplicate the list so the marquee loops seamlessly (track translates -50%)
  const loop = [...items, ...items];
  return (
    <div className="ticker-tape">
      <div className="tape-track">
        {loop.map((it, i) => (
          <div key={i} className="tape-item" aria-hidden={i >= items.length ? 'true' : undefined}>
            <span className="sym">{it.sym}</span>
            <span className="num">{formatNumber(it.val, it.val < 1000 ? 2 : 0)}</span>
            {isNum(it.chg) && (
              <span className={it.chg >= 0 ? 'pos num' : 'neg num'}>
                {formatPct(it.chg)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

const Header = ({ theme, setTheme, aiOpen, setAiOpen, setPage }) => {
  const vn = useVnIndices().data;
  const global = useGlobalIndices().data;
  const indices = [...(vn || []), ...(global || [])];
  const readCfg = () => { try { return JSON.parse(localStorage.getItem('helix_settings_v1') || '{}'); } catch { return {}; } };
  const [cfg, setCfg] = React.useState(readCfg);
  React.useEffect(() => {
    const on = () => setCfg(readCfg());
    window.addEventListener('helix-settings-updated', on);
    return () => window.removeEventListener('helix-settings-updated', on);
  }, []);
  return (
    <header className="header">
      <div className="header-status"><ApiStatusChip /></div>

      {cfg.tickerTape !== false ? <TickerTape indices={indices} /> : <div className="header-spacer"></div>}

      <div className="header-actions">
        <button type="button" className="search header-search" onClick={openCommandPalette}
          aria-label="Search tickers and pages" data-tip="Search" data-tip-kbd="⌘ K">
          <span>Search ticker, page…</span>
          <kbd className="kbd">⌘K</kbd>
        </button>
        <IconButton icon="bell" label="Alerts" onClick={() => setPage && setPage('#/today/alerts')} />
        <IconButton icon={theme === 'dark' ? 'sun' : 'moon'} label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
        <IconButton icon="sparkle" label="AI assistant" active={!!aiOpen} onClick={() => setAiOpen(!aiOpen)} />
      </div>
    </header>
  );
};

export { Header };
