// Dashboard page — market overview, watchlist, sector heatmap

const StatTile = ({ label, value, delta, suffix = '', spark }) => (
  <div className="stat">
    <div className="stat-label">{label}</div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
      <div>
        <div className="stat-value">{value}{suffix}</div>
        {delta !== undefined && (
          <div className="stat-delta">
            <ChangeText value={delta} />
            <span style={{ color: 'var(--text-subtle)', marginLeft: 6 }}>today</span>
          </div>
        )}
      </div>
      {spark && <Sparkline data={spark} width={70} height={32} fill />}
    </div>
  </div>
);

const WatchlistTable = ({ rows, onSelect, onRemove }) => (
  <table className="table">
    <thead>
      <tr>
        <th>Ticker</th>
        <th>Name</th>
        <th className="right">Last</th>
        <th className="right">Change</th>
        <th className="right">Volume</th>
        <th className="right">Mkt Cap</th>
        <th className="right" style={{ width: 90 }}>1D</th>
        <th style={{ width: 30 }}></th>
      </tr>
    </thead>
    <tbody>
      {rows.length === 0 ? (
        <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-subtle)', padding: '28px 12px', cursor: 'default' }}>
          No symbols yet — add one with the field above.
        </td></tr>
      ) : rows.map((r) => (
        <tr key={r.sym} onClick={() => onSelect && onSelect(r.sym)} className="wl-row">
          <td><span className="ticker">{r.sym}</span></td>
          <td style={{ color: 'var(--text-muted)' }}>{r.name}</td>
          <td className="right num">{fmtNum(r.price)}</td>
          <td className="right"><Pill value={r.chg} /></td>
          <td className="right num" style={{ color: 'var(--text-muted)' }}>{r.vol}</td>
          <td className="right num" style={{ color: 'var(--text-muted)' }}>{r.mcap}</td>
          <td className="right"><Sparkline data={r.spark} width={80} height={20} /></td>
          <td className="right">
            <button className="wl-remove" title="Remove from watchlist"
              onClick={(e) => { e.stopPropagation(); onRemove && onRemove(r.sym); }}
              style={{ width: 22, height: 22, padding: 0, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-subtle)', borderRadius: 3, opacity: 0 }}>
              <Icon name="close" size={11} />
            </button>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

// Add-symbol field with catalog autocomplete
const AddSymbol = ({ onAdd, existing }) => {
  const [q, setQ] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const matches = React.useMemo(() => {
    const term = q.trim().toUpperCase();
    if (!term) return [];
    return Object.keys(SYMBOL_CATALOG)
      .filter(s => !existing.includes(s))
      .filter(s => s.includes(term) || SYMBOL_CATALOG[s].name.toUpperCase().includes(term))
      .slice(0, 6);
  }, [q, existing]);

  const commit = (sym) => {
    const s = (sym || q).trim().toUpperCase();
    if (!s) return;
    onAdd(s);
    setQ(''); setOpen(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={q}
          onChange={e => { setQ(e.target.value); setOpen(true); }}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setOpen(false); }}
          placeholder="Add ticker (e.g. AMD)…"
          style={{ width: 200, padding: '6px 10px', fontSize: 12, fontFamily: 'var(--font-mono)', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text)', outline: 'none' }}
        />
        <button className="btn" onClick={() => commit()}><Icon name="plus" size={12} /> Add</button>
      </div>
      {open && matches.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 280, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 20, overflow: 'hidden' }}>
          {matches.map(s => (
            <button key={s} onClick={() => commit(s)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
              <span className="ticker" style={{ fontSize: 12, minWidth: 52 }}>{s}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1 }}>{SYMBOL_CATALOG[s].name}</span>
              <Icon name="plus" size={11} style={{ color: 'var(--accent)' }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// Full watchlist card — list switcher + add/remove + rename/delete
const WatchlistCard = ({ data, onSelect }) => {
  const store = useWatchlists();
  const lists = store.getLists();
  const active = store.getActive();
  const rows = active.symbols.map(sym => quoteFor(sym, data));

  const renameList = () => {
    const name = prompt('Rename watchlist', active.name);
    if (name && name.trim()) store.rename(active.id, name.trim());
  };
  const deleteList = () => {
    if (lists.length <= 1) { alert('Keep at least one watchlist.'); return; }
    if (confirm(`Delete "${active.name}"?`)) store.remove(active.id);
  };

  return (
    <div className="card">
      <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          {lists.map(l => (
            <button key={l.id} onClick={() => store.setActive(l.id)}
              style={{
                padding: '5px 10px', fontSize: 12, fontWeight: 600, borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                border: l.id === active.id ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: l.id === active.id ? 'var(--accent-bg)' : 'transparent',
                color: l.id === active.id ? 'var(--accent)' : 'var(--text-muted)',
              }}>
              {l.name} <span style={{ opacity: 0.6, fontFamily: 'var(--font-mono)' }}>{l.symbols.length}</span>
            </button>
          ))}
          <button onClick={() => { const n = prompt('Name your watchlist'); if (n && n.trim()) store.create(n.trim()); }}
            className="icon-btn" title="New watchlist" style={{ width: 28, height: 28 }}>
            <Icon name="plus" size={13} />
          </button>
        </div>
        <div className="row" style={{ gap: 4 }}>
          <button className="icon-btn" onClick={renameList} title="Rename list" style={{ width: 28, height: 28 }}><Icon name="settings" size={12} /></button>
          <button className="icon-btn" onClick={deleteList} title="Delete list" style={{ width: 28, height: 28 }}><Icon name="close" size={12} /></button>
        </div>
      </div>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <AddSymbol onAdd={(s) => store.addSymbol(active.id, s)} existing={active.symbols} />
      </div>
      <div className="card-body flush">
        <WatchlistTable rows={rows} onSelect={onSelect} onRemove={(s) => store.removeSymbol(active.id, s)} />
      </div>
    </div>
  );
};

const SectorHeatmap = ({ sectors, watchlist }) => {
  // Place sectors as treemap-ish using grid spans proportional to weight.
  // For visual fidelity, hand-tuned spans for the given data.
  const layout = [
    { name: 'Technology', span: 'span 6 / span 6', rows: 'span 3' },
    { name: 'Healthcare', span: 'span 6 / span 4', rows: 'span 2' },
    { name: 'Financials', span: 'span 6 / span 4', rows: 'span 1' },
    { name: 'Consumer Disc.', span: 'span 4', rows: 'span 1' },
    { name: 'Communication', span: 'span 4', rows: 'span 1' },
    { name: 'Industrials', span: 'span 4', rows: 'span 1' },
    { name: 'Energy', span: 'span 3', rows: 'span 1' },
    { name: 'Consumer Staples', span: 'span 3', rows: 'span 1' },
    { name: 'Utilities', span: 'span 2', rows: 'span 1' },
    { name: 'Real Estate', span: 'span 2', rows: 'span 1' },
    { name: 'Materials', span: 'span 2', rows: 'span 1' },
  ];
  const cellMap = Object.fromEntries(sectors.map(s => [s.name, s]));

  return (
    <div className="heatmap-grid">
      {layout.map((l, i) => {
        const s = cellMap[l.name];
        if (!s) return null;
        return (
          <div key={i} className="heat-cell"
            style={{ gridColumn: l.span, gridRow: l.rows, background: heatColor(s.chg) }}>
            <div className="sym">{s.name.toUpperCase()}</div>
            <div className="chg">{s.chg >= 0 ? '+' : ''}{s.chg.toFixed(2)}%</div>
          </div>
        );
      })}
    </div>
  );
};

const MoversList = ({ rows, type }) => (
  <div>
    {rows.map(r => (
      <div key={r.sym} style={{
        display: 'grid', gridTemplateColumns: '60px 1fr auto', gap: 8,
        padding: '8px 0', borderBottom: '1px solid var(--border)', alignItems: 'center',
        fontSize: 13,
      }}>
        <span className="ticker">{r.sym}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 12, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{r.name}</span>
        <span><Pill value={r.chg} /></span>
      </div>
    ))}
  </div>
);

const PageDashboard = ({ data, setPage, setActiveAsset }) => {
  const handleSelect = (sym) => {
    setActiveAsset(sym);
    setPage('detail');
  };

  const gainers = [...data.watchlist].sort((a, b) => b.chg - a.chg).slice(0, 5);
  const losers = [...data.watchlist].sort((a, b) => a.chg - b.chg).slice(0, 5);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Markets, at a glance.</h1>
          <p className="page-sub">Tuesday, May 4 · Equities open · Fed minutes due Wednesday</p>
        </div>
        <div className="row">
          <span style={{ fontSize: 11, color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Last update 09:42:18 ET</span>
          <button className="btn"><Icon name="download" size={12} /> Export</button>
        </div>
      </div>

      {/* Stat strip */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <StatTile label="S&P 500" value="5,847.32" delta={0.42} spark={data.indices[0].spark} />
        <StatTile label="NASDAQ" value="18,634.21" delta={0.89} spark={data.indices[1].spark} />
        <StatTile label="VIX" value="14.23" delta={-3.21} spark={data.indices[4].spark} />
        <StatTile label="10Y Treasury" value="4.21" suffix="%" delta={0.04} spark={data.indices[5].spark} />
      </div>

      {/* Main grid */}
      <div className="grid-2" style={{ marginBottom: 20 }}>
        {/* Watchlist */}
        <WatchlistCard data={data} onSelect={handleSelect} />

        {/* Right column */}
        <div className="stack">
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Top Gainers</h3>
              <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>S&P 500</span>
            </div>
            <div className="card-body" style={{ padding: '4px 16px' }}>
              <MoversList rows={gainers} />
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Top Losers</h3>
              <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>S&P 500</span>
            </div>
            <div className="card-body" style={{ padding: '4px 16px' }}>
              <MoversList rows={losers} />
            </div>
          </div>
        </div>
      </div>

      {/* Heatmap + News teaser */}
      <div className="grid-2" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Sector Performance · Today</h3>
            <div className="row">
              <span className="num" style={{ fontSize: 11, color: 'var(--text-subtle)' }}>
                <span style={{ display: 'inline-block', width: 10, height: 10, background: heatColor(-2), marginRight: 4, verticalAlign: 'middle', borderRadius: 2 }}></span>
                -2%
                <span style={{ display: 'inline-block', width: 10, height: 10, background: heatColor(0), marginLeft: 8, marginRight: 4, verticalAlign: 'middle', borderRadius: 2 }}></span>
                0%
                <span style={{ display: 'inline-block', width: 10, height: 10, background: heatColor(2), marginLeft: 8, marginRight: 4, verticalAlign: 'middle', borderRadius: 2 }}></span>
                +2%
              </span>
            </div>
          </div>
          <div className="card-body">
            <SectorHeatmap sectors={data.sectors} watchlist={data.watchlist} />
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Latest from the Wire</h3>
            <button className="card-action" onClick={() => setPage('news')}>All news →</button>
          </div>
          <div className="card-body" style={{ padding: '0 16px' }}>
            {data.news.slice(0, 5).map((n, i) => (
              <div key={i} className="news-row" style={{ gridTemplateColumns: '50px 1fr', padding: '12px 0' }}>
                <span className="news-time">{n.time}</span>
                <div>
                  <div className="news-title" style={{ fontSize: 13 }}>{n.title}</div>
                  <div className="news-meta">
                    <span style={{ color: 'var(--text-subtle)' }}>{n.src}</span>
                    {' · '}
                    <span className="num" style={{ fontSize: 10, fontWeight: 600, color: n.sentiment === 'positive' ? 'var(--pos)' : n.sentiment === 'negative' ? 'var(--neg)' : 'var(--text-muted)' }}>
                      {n.tags[0]}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom: macro band */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Macro Watch</h3>
          <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Key indicators · Last 30 days</span>
        </div>
        <div className="card-body">
          <div className="grid-3">
            <MacroIndicator name="US 10-Year Yield" value="4.21%" delta={0.04} spark={[4.10,4.12,4.15,4.18,4.16,4.19,4.21]} />
            <MacroIndicator name="DXY (Dollar Index)" value="106.43" delta={-0.18} spark={[107,106.9,106.7,106.6,106.5,106.4,106.43]} />
            <MacroIndicator name="Crude Oil (WTI)" value="$71.24" delta={-1.43} spark={[73,72.8,72.5,72,71.8,71.5,71.24]} />
          </div>
        </div>
      </div>
    </div>
  );
};

const MacroIndicator = ({ name, value, delta, spark }) => (
  <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
    <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{name}</div>
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 6 }}>
      <div>
        <div className="num" style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
        <ChangeText value={delta} />
      </div>
      <Sparkline data={spark} width={100} height={36} fill />
    </div>
  </div>
);

window.PageDashboard = PageDashboard;
