// Screener — filter equities

const SCREENER_DATA = [
  { sym: 'NVDA', name: 'NVIDIA Corp', sector: 'Technology', mcap: 3490, pe: 67.4, divYield: 0.03, perf1y: 184.2, perf3m: 24.1, vol: 342.1 },
  { sym: 'AAPL', name: 'Apple Inc', sector: 'Technology', mcap: 3550, pe: 35.2, divYield: 0.42, perf1y: 24.8, perf3m: 8.2, vol: 48.2 },
  { sym: 'MSFT', name: 'Microsoft', sector: 'Technology', mcap: 3130, pe: 36.8, divYield: 0.78, perf1y: 18.4, perf3m: 4.1, vol: 22.7 },
  { sym: 'GOOGL', name: 'Alphabet', sector: 'Communication', mcap: 2180, pe: 24.6, divYield: 0.45, perf1y: 32.1, perf3m: 12.4, vol: 31.4 },
  { sym: 'AMZN', name: 'Amazon', sector: 'Consumer Disc.', mcap: 2300, pe: 42.1, divYield: 0, perf1y: 28.7, perf3m: 9.3, vol: 38.6 },
  { sym: 'META', name: 'Meta Platforms', sector: 'Communication', mcap: 1490, pe: 27.8, divYield: 0.32, perf1y: 64.2, perf3m: 14.2, vol: 14.8 },
  { sym: 'TSLA', name: 'Tesla', sector: 'Consumer Disc.', mcap: 1110, pe: 92.4, divYield: 0, perf1y: 42.1, perf3m: -8.4, vol: 92.1 },
  { sym: 'BRK.B', name: 'Berkshire', sector: 'Financials', mcap: 1020, pe: 14.2, divYield: 0, perf1y: 18.4, perf3m: 4.8, vol: 4.2 },
  { sym: 'AVGO', name: 'Broadcom', sector: 'Technology', mcap: 832, pe: 78.4, divYield: 1.18, perf1y: 88.4, perf3m: 32.1, vol: 21.3 },
  { sym: 'JPM', name: 'JPMorgan', sector: 'Financials', mcap: 678, pe: 12.4, divYield: 2.18, perf1y: 32.1, perf3m: 8.2, vol: 11.4 },
  { sym: 'XOM', name: 'Exxon Mobil', sector: 'Energy', mcap: 478, pe: 13.8, divYield: 3.42, perf1y: -4.2, perf3m: -8.4, vol: 15.6 },
  { sym: 'V', name: 'Visa', sector: 'Financials', mcap: 612, pe: 31.2, divYield: 0.74, perf1y: 16.4, perf3m: 4.2, vol: 6.8 },
  { sym: 'JNJ', name: 'Johnson & Johnson', sector: 'Healthcare', mcap: 384, pe: 22.4, divYield: 3.12, perf1y: -2.4, perf3m: -1.8, vol: 8.4 },
  { sym: 'WMT', name: 'Walmart', sector: 'Consumer Staples', mcap: 718, pe: 38.4, divYield: 1.04, perf1y: 48.2, perf3m: 12.1, vol: 18.4 },
  { sym: 'KO', name: 'Coca-Cola', sector: 'Consumer Staples', mcap: 282, pe: 26.8, divYield: 2.84, perf1y: 8.4, perf3m: 2.1, vol: 12.6 },
];

const SECTORS = ['All sectors', 'Technology', 'Healthcare', 'Financials', 'Consumer Disc.', 'Communication', 'Industrials', 'Energy', 'Consumer Staples'];

// Generate a large realistic mock universe on demand (stands in for a real
// 10,000-stock backend screen until the API is wired up).
const SECTOR_POOL = ['Technology', 'Healthcare', 'Financials', 'Consumer Disc.', 'Communication', 'Industrials', 'Energy', 'Consumer Staples', 'Utilities', 'Materials', 'Real Estate'];
const SUFFIX = ['Corp', 'Inc', 'Group', 'Holdings', 'Industries', 'Partners', 'Systems', 'Labs', 'Technologies', 'Capital'];
let _universeCache = null;
const buildUniverse = (n = 800) => {
  if (_universeCache) return _universeCache;
  const out = [...SCREENER_DATA];
  const seen = new Set(out.map(r => r.sym));
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  while (out.length < n) {
    let sym = '';
    const len = 3 + Math.floor(rnd() * 2);
    for (let i = 0; i < len; i++) sym += L[Math.floor(rnd() * 26)];
    if (seen.has(sym)) continue;
    seen.add(sym);
    const sector = SECTOR_POOL[Math.floor(rnd() * SECTOR_POOL.length)];
    const mcap = Math.round((rnd() ** 3) * 800 + 2);          // skew small
    const pe = +(rnd() * 80 + 6).toFixed(1);
    const divYield = +(rnd() < 0.4 ? 0 : rnd() * 4).toFixed(2);
    const perf1y = +((rnd() - 0.4) * 120).toFixed(1);
    const perf3m = +((rnd() - 0.45) * 40).toFixed(1);
    const vol = +(rnd() * 60 + 0.5).toFixed(1);
    out.push({ sym, name: `${sym} ${SUFFIX[Math.floor(rnd() * SUFFIX.length)]}`, sector, mcap, pe, divYield, perf1y, perf3m, vol });
  }
  _universeCache = out;
  return out;
};

const PageScreener = ({ setActiveAsset, setPage }) => {
  const [sector, setSector] = React.useState('All sectors');
  const [mcapMin, setMcapMin] = React.useState(0);
  const [peMax, setPeMax] = React.useState(100);
  const [divMin, setDivMin] = React.useState(0);
  const [perfMin, setPerfMin] = React.useState(-50);
  const [sortKey, setSortKey] = React.useState('mcap');
  const [sortDir, setSortDir] = React.useState('desc');
  const [universe, setUniverse] = React.useState(SCREENER_DATA);
  const [scanning, setScanning] = React.useState(false);
  const [fullRun, setFullRun] = React.useState(false);
  const [scanPct, setScanPct] = React.useState(0);
  const [scanCount, setScanCount] = React.useState(0);
  const TOTAL_UNIVERSE = 10000;

  const runFullScreen = () => {
    if (scanning) return;
    setScanning(true);
    setScanPct(0);
    setScanCount(0);
    const started = Date.now();
    const DURATION = 1400;
    const tick = setInterval(() => {
      const t = Math.min(1, (Date.now() - started) / DURATION);
      // ease-out
      const eased = 1 - Math.pow(1 - t, 2);
      setScanPct(Math.round(eased * 100));
      setScanCount(Math.round(eased * TOTAL_UNIVERSE));
      if (t >= 1) {
        clearInterval(tick);
        setUniverse(buildUniverse(800));
        setFullRun(true);
        setScanning(false);
        window.toast && window.toast('Scanned 10,000 stocks · expanded universe', { type: 'success' });
      }
    }, 60);
  };

  const filtered = universe.filter(r =>
    (sector === 'All sectors' || r.sector === sector) &&
    r.mcap >= mcapMin &&
    r.pe <= peMax &&
    r.divYield >= divMin &&
    r.perf1y >= perfMin
  ).sort((a, b) => {
    const m = sortDir === 'asc' ? 1 : -1;
    return (a[sortKey] - b[sortKey]) * m;
  });

  const setSort = (key) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  // ── Saved presets (localStorage) ───────────────────────────
  const PRESETS_KEY = 'helix_screener_presets_v1';
  const [presets, setPresets] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]'); } catch { return []; }
  });
  const persistPresets = (next) => { setPresets(next); localStorage.setItem(PRESETS_KEY, JSON.stringify(next)); };

  const savePreset = async () => {
    const name = await window.askPrompt({ title: 'Save screen preset', label: 'Preset name', value: `Screen ${presets.length + 1}`, confirmText: 'Save' });
    if (!name) return;
    const preset = { id: 'p_' + Date.now(), name, sector, mcapMin, peMax, divMin, perfMin, sortKey, sortDir };
    persistPresets([preset, ...presets.filter(p => p.name !== name)]);
    window.toast && window.toast(`Saved preset “${name}”`, { type: 'success' });
  };

  const applyPreset = (p) => {
    setSector(p.sector); setMcapMin(p.mcapMin); setPeMax(p.peMax);
    setDivMin(p.divMin); setPerfMin(p.perfMin);
    setSortKey(p.sortKey || 'mcap'); setSortDir(p.sortDir || 'desc');
    window.toast && window.toast(`Applied “${p.name}”`, { type: 'info' });
  };

  const deletePreset = (id) => persistPresets(presets.filter(p => p.id !== id));

  const exportResultsCSV = () => {
    const header = ['Ticker', 'Name', 'Sector', 'Market Cap ($B)', 'P/E', 'Div Yield %', '3M %', '1Y %'];
    const rows = [header.join(',')];
    filtered.forEach(r => {
      rows.push([r.sym, `"${r.name}"`, `"${r.sector}"`, r.mcap, r.pe, r.divYield, r.perf3m, r.perf1y].join(','));
    });
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'screener_results.csv'; a.click();
    URL.revokeObjectURL(url);
    window.toast && window.toast(`Exported ${filtered.length} matches`, { type: 'success' });
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Stock screener.</h1>
          <p className="page-sub">Filter the market by what matters to you</p>
        </div>
        <div className="row">
          <button className="btn" onClick={savePreset}>Save preset</button>
          <button className="btn btn-primary" onClick={runFullScreen} disabled={scanning}>
            {scanning ? `Scanning… ${scanPct}%` : fullRun ? 'Re-run full screen ↻' : 'Run on 10,000 stocks →'}
          </button>
        </div>
      </div>

      {presets.length > 0 && (
        <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Presets</span>
          {presets.map(p => (
            <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 6px 5px 12px', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 999, fontSize: 12 }}>
              <button onClick={() => applyPreset(p)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12, padding: 0 }}>{p.name}</button>
              <button onClick={() => deletePreset(p.id)} title="Delete preset" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-subtle)', display: 'grid', placeItems: 'center', padding: 2, borderRadius: '50%' }}>
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Filters card */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <h3 className="card-title">Filters</h3>
          <button className="card-action" onClick={() => { setSector('All sectors'); setMcapMin(0); setPeMax(100); setDivMin(0); setPerfMin(-50); }}>Reset</button>
        </div>
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16 }}>
          <FilterField label="Sector">
            <select value={sector} onChange={e => setSector(e.target.value)} style={selectStyle}>
              {SECTORS.map(s => <option key={s}>{s}</option>)}
            </select>
          </FilterField>
          <FilterRange label="Market Cap (min, $B)" value={mcapMin} setValue={setMcapMin} min={0} max={4000} step={50} suffix="B" />
          <FilterRange label="P/E Ratio (max)" value={peMax} setValue={setPeMax} min={5} max={200} step={5} />
          <FilterRange label="Div Yield (min %)" value={divMin} setValue={setDivMin} min={0} max={5} step={0.1} suffix="%" />
          <FilterRange label="1Y Performance (min %)" value={perfMin} setValue={setPerfMin} min={-50} max={200} step={5} suffix="%" />
        </div>
      </div>

      {/* Results */}
      <div className="card" style={{ position: 'relative' }}>
        {scanning && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 5, borderRadius: 'var(--radius-lg)',
            background: 'color-mix(in srgb, var(--bg-elev) 85%, transparent)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12,
          }}>
            <div className="num" style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>
              {scanCount.toLocaleString()} <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)' }}>screened</span>
            </div>
            <div style={{ width: 220, height: 4, background: 'var(--bg-sunken)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${scanPct}%`, background: 'var(--accent)', transition: 'width 60ms linear' }} />
            </div>
          </div>
        )}
        <div className="card-header">
          <h3 className="card-title">{filtered.length.toLocaleString()} matches</h3>
          <div className="row">
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>of {universe.length.toLocaleString()} screened · sorted by {sortKey} · {sortDir}</span>
            <button className="btn" onClick={exportResultsCSV}><Icon name="download" size={12} /> Export</button>
          </div>
        </div>
        <div className="card-body flush">
          <table className="table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Name</th>
                <th>Sector</th>
                <SortHeader label="Mkt Cap" k="mcap" sk={sortKey} sd={sortDir} onClick={() => setSort('mcap')} />
                <SortHeader label="P/E" k="pe" sk={sortKey} sd={sortDir} onClick={() => setSort('pe')} />
                <SortHeader label="Div Yield" k="divYield" sk={sortKey} sd={sortDir} onClick={() => setSort('divYield')} />
                <SortHeader label="3M" k="perf3m" sk={sortKey} sd={sortDir} onClick={() => setSort('perf3m')} />
                <SortHeader label="1Y" k="perf1y" sk={sortKey} sd={sortDir} onClick={() => setSort('perf1y')} />
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 100).map(r => (
                <tr key={r.sym} onClick={() => { setActiveAsset(r.sym); setPage('detail'); }}>
                  <td><span className="ticker">{r.sym}</span></td>
                  <td style={{ color: 'var(--text-muted)' }}>{r.name}</td>
                  <td>
                    <span style={{ fontSize: 11, padding: '2px 6px', background: 'var(--bg-sunken)', borderRadius: 3, color: 'var(--text-muted)' }}>{r.sector}</span>
                  </td>
                  <td className="right num">${r.mcap >= 1000 ? (r.mcap / 1000).toFixed(2) + 'T' : r.mcap + 'B'}</td>
                  <td className="right num">{r.pe.toFixed(1)}</td>
                  <td className="right num" style={{ color: r.divYield > 0 ? 'var(--text)' : 'var(--text-subtle)' }}>{r.divYield.toFixed(2)}%</td>
                  <td className="right"><Pill value={r.perf3m} /></td>
                  <td className="right"><Pill value={r.perf1y} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 100 && (
            <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-subtle)', textAlign: 'center', borderTop: '1px solid var(--border)' }}>
              Showing first 100 of {filtered.length.toLocaleString()} matches · tighten filters or Export to see all
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const selectStyle = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--bg-sunken)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  color: 'var(--text)',
  fontSize: 13,
};

const FilterField = ({ label, children }) => (
  <div>
    <div style={{ fontSize: 11, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 6 }}>{label}</div>
    {children}
  </div>
);

const FilterRange = ({ label, value, setValue, min, max, step, suffix = '' }) => (
  <FilterField label={label}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => setValue(parseFloat(e.target.value))}
        style={{ flex: 1, accentColor: 'var(--accent)' }} />
      <span className="num" style={{ fontSize: 12, fontWeight: 600, minWidth: 50, textAlign: 'right' }}>
        {value}{suffix}
      </span>
    </div>
  </FilterField>
);

const SortHeader = ({ label, k, sk, sd, onClick, className = 'right' }) => (
  <th className={className} onClick={onClick} style={{ cursor: 'pointer' }}>
    {label}
    {sk === k && <span style={{ marginLeft: 4, color: 'var(--accent)' }}>{sd === 'asc' ? '↑' : '↓'}</span>}
  </th>
);

window.PageScreener = PageScreener;
