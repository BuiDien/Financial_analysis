// Sidebar with nav

const NAV = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'detail', label: 'Asset Detail', icon: 'chart' },
  { id: 'portfolio', label: 'Portfolio', icon: 'portfolio' },
  { id: 'screener', label: 'Screener', icon: 'screener' },
  { id: 'statements', label: 'Financial Statements', icon: 'portfolio' },
  { id: 'totals', label: 'Totals', icon: 'screener' },
  { id: 'sync', label: 'Sync', icon: 'sync' },
  { id: 'news', label: 'News & Insights', icon: 'news' },
];

const WATCHLIST_NAV = [
  { id: 'wl1', label: 'AI & Semis', count: 8 },
  { id: 'wl2', label: 'Dividend Aristocrats', count: 12 },
  { id: 'wl3', label: 'Macro Hedges', count: 6 },
];

const Sidebar = ({ page, setPage }) => {
  const store = useWatchlists();
  const lists = store.getLists();
  const activeId = store.getState().activeId;

  const openList = (id) => { store.setActive(id); setPage('dashboard'); };
  const newList = () => {
    const name = prompt('Name your watchlist');
    if (name && name.trim()) { store.create(name.trim()); setPage('dashboard'); }
  };

  return (
    <aside className="sidebar">
      <div style={{ height: 8 }}></div>

      <div className="nav-section">
        <div className="nav-section-label">Workspace</div>
        {NAV.map(item => (
          <button key={item.id}
            className="nav-item"
            aria-current={page === item.id ? 'page' : undefined}
            onClick={() => setPage(item.id)}>
            <Icon name={item.icon} className="icon" />
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      <div className="nav-section">
        <div className="nav-section-label">Watchlists</div>
        {lists.map(wl => (
          <button key={wl.id} className="nav-item"
            aria-current={(page === 'dashboard' && wl.id === activeId) ? 'page' : undefined}
            onClick={() => openList(wl.id)}>
            <Icon name={wl.id === activeId ? 'starFill' : 'star'} className="icon"
              style={wl.id === activeId ? { color: 'var(--accent)' } : undefined} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wl.name}</span>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)' }}>{wl.symbols.length}</span>
          </button>
        ))}
        <button className="nav-item" style={{ color: 'var(--text-subtle)' }} onClick={newList}>
          <Icon name="plus" className="icon" />
          <span>New watchlist</span>
        </button>
      </div>

      <div className="nav-section">
        <div className="nav-section-label">Account</div>
        <button className="nav-item" aria-current={page === 'alerts' ? 'page' : undefined} onClick={() => setPage('alerts')}>
          <Icon name="alerts" className="icon" />
          <span style={{ flex: 1 }}>Alerts</span>
          <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', background: 'var(--accent-bg)', color: 'var(--accent)', borderRadius: 999 }}>1</span>
        </button>
        <button className="nav-item" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}>
          <Icon name="settings" className="icon" />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
};

window.Sidebar = Sidebar;
