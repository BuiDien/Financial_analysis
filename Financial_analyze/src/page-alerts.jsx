// Alerts page — price/indicator/news alerts with create form, persisted locally.

const ALERTS_KEY = 'helix_alerts_v1';

// monitored: evaluated by the app's alert monitor against live quotes.
// RSI / volume alerts need indicator data the monitor doesn't fetch yet, so
// they can't be created; existing ones are shown as "Not monitored".
// unit 'price' = the listing's own currency (Vietnamese stocks in đồng).
const ALERT_TYPES = [
  { id: 'price_above', label: 'Price rises above', unit: 'price', icon: 'arrowUp', monitored: true },
  { id: 'price_below', label: 'Price falls below', unit: 'price', icon: 'arrowDown', monitored: true },
  { id: 'pct_move', label: 'Daily move exceeds', unit: '%', icon: 'trending', monitored: true },
  { id: 'rsi_above', label: 'RSI rises above', unit: '', icon: 'chart', monitored: false },
  { id: 'rsi_below', label: 'RSI falls below', unit: '', icon: 'chart', monitored: false },
  { id: 'volume_spike', label: 'Volume spikes above avg', unit: '×', icon: 'trending', monitored: false },
];

// New users start with no alerts (no seeded samples); saved ones are kept.
const loadAlerts = () => {
  try {
    const s = JSON.parse(localStorage.getItem(ALERTS_KEY) || 'null');
    if (Array.isArray(s)) return s;
  } catch {}
  return [];
};

const describeAlert = (a) => {
  const t = ALERT_TYPES.find(x => x.id === a.type);
  if (!t) return a.type;
  const val = t.unit === 'price' ? (a.currency ? fmtNativePrice(a.value, a.currency) : fmtNum(a.value, a.value % 1 ? 2 : 0)) : t.unit === '%' ? `${a.value}%` : t.unit === '×' ? `${a.value}×` : a.value;
  return `${t.label} ${val}`;
};

const PageAlerts = ({ setActiveAsset, setPage }) => {
  const [alerts, setAlerts] = React.useState(loadAlerts);
  const [showForm, setShowForm] = React.useState(false);
  const [prefillSym, setPrefillSym] = React.useState('');
  const [filter, setFilter] = React.useState('all'); // all | active | triggered

  // Open the form pre-filled when arriving from the Asset Detail "Alert" button
  React.useEffect(() => {
    if (window.__alertTicker) {
      setPrefillSym(window.__alertTicker);
      setShowForm(true);
      window.__alertTicker = null;
    }
  }, []);

  React.useEffect(() => {
    localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts));
    window.dispatchEvent(new Event('helix-alerts-saved'));   // lets the monitor check new alerts now
  }, [alerts]);

  // Refresh when the app's alert monitor fires a trigger
  React.useEffect(() => {
    const reload = () => setAlerts(loadAlerts());
    window.addEventListener('helix-alerts-updated', reload);
    return () => window.removeEventListener('helix-alerts-updated', reload);
  }, []);

  const addAlert = (a) => { setAlerts(prev => [{ ...a, id: 'a_' + Date.now(), created: new Date().toISOString().slice(0, 10), triggered: false }, ...prev]); setShowForm(false); window.toast && window.toast(`Alert created for ${a.ticker || 'asset'}`, { type: 'success' }); };
  const removeAlert = (id) => { setAlerts(prev => prev.filter(a => a.id !== id)); window.toast && window.toast('Alert removed', { type: 'info' }); };
  const toggleAlert = (id) => setAlerts(prev => prev.map(a => a.id === id ? { ...a, active: !a.active } : a));

  const filtered = alerts.filter(a =>
    filter === 'all' ? true : filter === 'active' ? a.active && !a.triggered : a.triggered
  );

  const counts = {
    all: alerts.length,
    active: alerts.filter(a => a.active && !a.triggered).length,
    triggered: alerts.filter(a => a.triggered).length,
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Alerts.</h1>
          <p className="page-sub">In-app notice when a price or daily-move condition is met · checked every 5 minutes while the backend is live</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm(true)}>
          <Icon name="plus" size={12} /> New alert
        </button>
      </div>

      {/* Summary */}
      <div className="stat-grid" style={{ marginBottom: 20, gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="stat">
          <div className="stat-label">Active alerts</div>
          <div className="stat-value">{counts.active}</div>
          <div className="stat-delta" style={{ color: 'var(--text-muted)' }}>{window.HelixAPI?.live ? 'watching live quotes' : 'paused · backend offline'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Triggered</div>
          <div className="stat-value" style={{ color: counts.triggered ? 'var(--accent)' : 'var(--text)' }}>{counts.triggered}</div>
          <div className="stat-delta" style={{ color: 'var(--text-muted)' }}>need your attention</div>
        </div>
        <div className="stat">
          <div className="stat-label">Total configured</div>
          <div className="stat-value">{counts.all}</div>
          <div className="stat-delta" style={{ color: 'var(--text-muted)' }}>across your watchlist</div>
        </div>
      </div>

      {/* Alerts list */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Your Alerts</h3>
          <div style={{ display: 'inline-flex', background: 'var(--bg-sunken)', borderRadius: 4, padding: 2, gap: 2 }}>
            {[{ id: 'all', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'triggered', label: 'Triggered' }].map(t => (
              <button key={t.id} onClick={() => setFilter(t.id)}
                style={{
                  padding: '5px 12px', fontSize: 11, fontWeight: 600, border: 'none', borderRadius: 3,
                  cursor: 'pointer', fontFamily: 'inherit',
                  background: filter === t.id ? 'var(--bg-elev)' : 'transparent',
                  color: filter === t.id ? 'var(--text)' : 'var(--text-muted)',
                }}>
                {t.label} <span style={{ opacity: 0.6 }}>{counts[t.id]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="card-body flush">
          {filtered.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: 14, marginBottom: 8 }}>No alerts here yet</div>
              <button className="btn" onClick={() => setShowForm(true)}><Icon name="plus" size={12} /> Create your first alert</button>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}></th>
                  <th>Ticker</th>
                  <th>Condition</th>
                  <th>Note</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th className="right" style={{ width: 80 }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(a => {
                  const t = ALERT_TYPES.find(x => x.id === a.type);
                  return (
                    <tr key={a.id}>
                      <td>
                        <span style={{
                          width: 28, height: 28, borderRadius: 6, display: 'grid', placeItems: 'center',
                          background: a.triggered ? 'var(--accent-bg)' : 'var(--bg-sunken)',
                          color: a.triggered ? 'var(--accent)' : 'var(--text-muted)',
                        }}>
                          <Icon name={t?.icon || 'alerts'} size={14} />
                        </span>
                      </td>
                      <td onClick={() => { setActiveAsset(a.ticker); setPage('detail'); }} style={{ cursor: 'pointer' }}>
                        <span className="ticker">{a.ticker}</span>
                      </td>
                      <td style={{ color: 'var(--text)' }}>{describeAlert(a)}</td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{a.note || '—'}</td>
                      <td className="num" style={{ color: 'var(--text-subtle)', fontSize: 12 }}>{a.created}</td>
                      <td>
                        {a.triggered ? (
                          <span className="pill" style={{ background: 'var(--accent-bg)', color: 'var(--accent)' }} title={a.triggeredAt ? `Triggered ${new Date(a.triggeredAt).toLocaleString()}${a.triggeredPrice != null ? ` at ${fmtNativePrice(a.triggeredPrice, a.currency || 'USD')}` : ''}` : undefined}>● Triggered</span>
                        ) : !t?.monitored ? (
                          <span className="pill pill-neutral" title="RSI and volume alerts are not evaluated yet">Not monitored</span>
                        ) : a.active ? (
                          <span className="pill pill-pos">Active</span>
                        ) : (
                          <span className="pill pill-neutral">Paused</span>
                        )}
                      </td>
                      <td className="right">
                        <div style={{ display: 'inline-flex', gap: 4 }}>
                          <button className="icon-btn" style={{ width: 26, height: 26 }} title={a.active ? 'Pause' : 'Resume'} onClick={() => toggleAlert(a.id)}>
                            <Icon name={a.active ? 'eye' : 'eye'} size={12} />
                          </button>
                          <button className="icon-btn" style={{ width: 26, height: 26 }} title="Delete" onClick={() => removeAlert(a.id)}>
                            <Icon name="close" size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showForm && <AlertForm defaultSym={prefillSym} onClose={() => { setShowForm(false); setPrefillSym(''); }} onCreate={addAlert} />}
    </div>
  );
};

const AlertForm = ({ onClose, onCreate, defaultSym = '' }) => {
  const [ticker, setTicker] = React.useState(defaultSym);
  const [type, setType] = React.useState('price_above');
  const isVn = /^VN:/.test(ticker) || (window.HOME_LIVE_TICKER || {})[ticker.trim().toUpperCase()]?.startsWith('VN:');
  const [value, setValue] = React.useState('');
  const [note, setNote] = React.useState('');
  const [channels, setChannels] = React.useState({ inApp: true });
  const [error, setError] = React.useState('');

  const selectedType = ALERT_TYPES.find(t => t.id === type);

  const submit = () => {
    if (!ticker.trim()) { setError('Enter a ticker symbol'); return; }
    if (value === '' || isNaN(parseFloat(value))) { setError('Enter a numeric value'); return; }
    if (!selectedType?.monitored) { setError('This condition is not monitored yet'); return; }
    onCreate({ ticker: ticker.trim().toUpperCase(), type, value: parseFloat(value), note: note.trim(), active: true, channels, ...(selectedType.unit === 'price' && isVn ? { currency: 'VND' } : {}) });
  };

  const inputStyle = {
    width: '100%', padding: '9px 11px', fontSize: 13, fontFamily: 'inherit',
    background: 'var(--bg-sunken)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', color: 'var(--text)', outline: 'none',
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'grid', placeItems: 'center', padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, width: '100%', maxWidth: 460, overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 className="serif" style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>New alert</h3>
          <button className="icon-btn" onClick={onClose}><Icon name="close" size={12} /></button>
        </div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>Ticker</label>
            <input style={inputStyle} value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} placeholder="e.g. NVDA" />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>Condition</label>
            <select style={inputStyle} value={type} onChange={e => setType(e.target.value)}>
              {ALERT_TYPES.map(t => <option key={t.id} value={t.id} disabled={!t.monitored}>{t.label}{t.monitored ? '' : ' — not monitored yet'}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>
              Value {selectedType?.unit && <span style={{ color: 'var(--text-subtle)' }}>({selectedType.unit === 'price' ? (isVn ? 'price in đồng, e.g. 61500' : "price in the listing's currency") : selectedType.unit === '%' ? 'percent' : selectedType.unit === '×' ? 'multiple' : 'level'})</span>}
            </label>
            <input style={inputStyle} type="number" value={value} onChange={e => setValue(e.target.value)} placeholder="0" />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>Note <span style={{ color: 'var(--text-subtle)', fontWeight: 400 }}>(optional)</span></label>
            <input style={inputStyle} value={note} onChange={e => setNote(e.target.value)} placeholder="Why this matters to you" />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>Notify via</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {[{ k: 'inApp', label: 'In-app' }].map(c => (
                <button key={c.k} onClick={() => setChannels(s => ({ ...s, [c.k]: !s[c.k] }))}
                  style={{
                    flex: 1, padding: '8px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                    border: channels[c.k] ? '1px solid var(--accent)' : '1px solid var(--border)',
                    background: channels[c.k] ? 'var(--accent-bg)' : 'var(--bg-sunken)',
                    color: channels[c.k] ? 'var(--accent)' : 'var(--text-muted)',
                  }}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', background: 'var(--bg-sunken)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--neg)' }}>{error}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={submit}>Create alert</button>
          </div>
        </div>
      </div>
    </div>
  );
};

window.PageAlerts = PageAlerts;
