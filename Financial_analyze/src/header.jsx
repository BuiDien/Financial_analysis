// Top header with ticker tape and actions

const TickerTape = ({ indices }) => {
  // Only items with a real value — a failed index is left out, never invented.
  const items = (indices || []).filter(it => isNum(it.val));
  if (!items.length) return <div className="ticker-tape" style={{ flex: 1 }}></div>;
  // Duplicate the list so the marquee loops seamlessly (track translates -50%)
  const loop = [...items, ...items];
  return (
    <div className="ticker-tape">
      <div className="tape-track">
        {loop.map((it, i) => (
          <div key={i} className="tape-item" aria-hidden={i >= items.length ? 'true' : undefined}>
            <span className="sym">{it.sym}</span>
            <span className="num">{fmtNum(it.val, it.val < 1000 ? 2 : 0)}</span>
            {isNum(it.chg) && (
              <span className={it.chg >= 0 ? 'pos num' : 'neg num'}>
                {it.chg >= 0 ? '+' : ''}{Number(it.chg).toFixed(2)}%
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

const Header = ({ indices, theme, setTheme, aiOpen, setAiOpen, setPage }) => {
  const readCfg = () => { try { return JSON.parse(localStorage.getItem('helix_settings_v1') || '{}'); } catch { return {}; } };
  const [cfg, setCfg] = React.useState(readCfg);
  React.useEffect(() => {
    const on = () => setCfg(readCfg());
    window.addEventListener('helix-settings-updated', on);
    return () => window.removeEventListener('helix-settings-updated', on);
  }, []);
  return (
    <header className="header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        <ApiStatusChip />
      </div>

      {cfg.tickerTape !== false ? <TickerTape indices={indices} /> : <div style={{ flex: 1 }}></div>}

      <div className="header-actions">
        <button className="search" onClick={() => window.dispatchEvent(new Event('open-command-palette'))}
          style={{ textAlign: 'left', color: 'var(--text-subtle)', cursor: 'text', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Search ticker, page…</span>
          <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, padding: '1px 5px', background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-muted)' }}>⌘K</kbd>
        </button>
        <button className="icon-btn" title="Alerts" onClick={() => setPage && setPage('alerts')}>
          <Icon name="bell" size={14} />
        </button>
        <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme">
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
        </button>
        <button className="icon-btn" data-active={aiOpen} onClick={() => setAiOpen(!aiOpen)} title="AI assistant">
          <Icon name="sparkle" size={14} />
        </button>
      </div>
    </header>
  );
};

window.Header = Header;
