// Filings tab — upload, store, and analyze PDF financial statements

const STORAGE_KEY = 'helix_filings_v1';

const SAMPLE_FILINGS = [
  { id: 's1', name: 'NVIDIA 10-K FY2025.pdf', ticker: 'NVDA', type: '10-K', period: 'FY 2025', size: 4280000, uploaded: '2026-03-12', status: 'analyzed', pages: 124,
    extracted: { revenue: '130.5B', netIncome: '72.9B', fcf: '60.9B', notes: 'Data center revenue +217% YoY. Margins expanded across segments.' } },
  { id: 's2', name: 'NVIDIA 10-Q Q1 FY2026.pdf', ticker: 'NVDA', type: '10-Q', period: 'Q1 FY 2026', size: 1840000, uploaded: '2026-04-28', status: 'analyzed', pages: 48,
    extracted: { revenue: '38.4B', netIncome: '21.3B', fcf: '15.8B', notes: 'Sequential growth slowing. Inventory days up to 212.' } },
  { id: 's3', name: 'AAPL Annual Report 2025.pdf', ticker: 'AAPL', type: '10-K', period: 'FY 2025', size: 6240000, uploaded: '2026-02-04', status: 'analyzed', pages: 102,
    extracted: { revenue: '391.0B', netIncome: '93.7B', fcf: '108.8B', notes: 'Services growth 14%. iPhone flat. Cash returned $110B.' } },
];

const loadFilings = () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch (e) {}
  return SAMPLE_FILINGS;
};

const saveFilings = (filings) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(filings)); } catch (e) {}
};

const fmtBytes = (b) => {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
};

const FILING_TYPES = ['10-K', '10-Q', '8-K', 'Annual Report', 'Earnings Release', 'Investor Presentation', 'Other'];

const PageFilings = () => {
  const [filings, setFilings] = React.useState(loadFilings);
  const [selected, setSelected] = React.useState(null);
  const [showUpload, setShowUpload] = React.useState(false);
  const [filterTicker, setFilterTicker] = React.useState('');
  const [filterType, setFilterType] = React.useState('All');
  const [analyzing, setAnalyzing] = React.useState(null);
  const [analysisOutput, setAnalysisOutput] = React.useState({});
  const [readerFiling, setReaderFiling] = React.useState(null);

  React.useEffect(() => { saveFilings(filings); }, [filings]);

  const addFiling = (filing) => {
    setFilings(f => [filing, ...f]);
    setShowUpload(false);
    // Settings → auto-summarize on upload
    let auto = false;
    try { auto = !!JSON.parse(localStorage.getItem('helix_settings_v1') || '{}').aiAutoSummary; } catch {}
    if (auto) { setSelected(filing); analyzeFiling(filing); }
    window.toast && window.toast(`Added "${filing.name}"`, { type: 'success' });
  };

  const removeFiling = (id) => {
    setFilings(f => f.filter(x => x.id !== id));
    if (selected?.id === id) setSelected(null);
    window.toast && window.toast('Filing removed', { type: 'info' });
  };

  const analyzeFiling = async (filing) => {
    setAnalyzing(filing.id);
    try {
      const prompt = `You are reviewing a "${filing.type}" financial filing for ${filing.ticker} (${filing.period}). The document is "${filing.name}". Extract the **5 most important findings** an analyst should know. Use this format strictly:\n\n**Bottom line:** [one sentence verdict]\n\n**Key findings:**\n- [finding 1, with specific numbers if relevant]\n- [finding 2]\n- [finding 3]\n- [finding 4]\n- [finding 5]\n\n**Watch list:** [2-3 risks or things to monitor]\n\nBe specific, numerical, and direct. No fluff.`;
      const result = await window.claude.complete(prompt);
      setAnalysisOutput(o => ({ ...o, [filing.id]: result }));
      setFilings(f => f.map(x => x.id === filing.id ? { ...x, status: 'analyzed' } : x));
    } catch (e) {
      setAnalysisOutput(o => ({ ...o, [filing.id]: 'Analysis failed. Please retry.' }));
    }
    setAnalyzing(null);
  };

  const filtered = filings.filter(f =>
    (!filterTicker || f.ticker.toLowerCase().includes(filterTicker.toLowerCase())) &&
    (filterType === 'All' || f.type === filterType)
  );

  const tickers = [...new Set(filings.map(f => f.ticker))];
  const totalSize = filings.reduce((s, f) => s + f.size, 0);

  return (
    <>
      {/* Stats */}
      <div className="stat-grid" style={{ marginBottom: 20, gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="stat">
          <div className="stat-label">Filings in library</div>
          <div className="stat-value">{filings.length}</div>
          <div className="stat-delta" style={{ color: 'var(--text-muted)' }}>{tickers.length} companies</div>
        </div>
        <div className="stat">
          <div className="stat-label">Analyzed</div>
          <div className="stat-value">{filings.filter(f => f.status === 'analyzed').length}</div>
          <div className="stat-delta" style={{ color: 'var(--text-muted)' }}>AI-summarized</div>
        </div>
        <div className="stat">
          <div className="stat-label">Storage used</div>
          <div className="stat-value">{fmtBytes(totalSize)}</div>
          <div className="stat-delta" style={{ color: 'var(--text-muted)' }}>of 5 GB</div>
        </div>
        <div className="stat">
          <div className="stat-label">Latest filing</div>
          <div className="stat-value" style={{ fontSize: 18 }}>{filings[0]?.type || '—'}</div>
          <div className="stat-delta" style={{ color: 'var(--text-muted)' }}>{filings[0]?.uploaded || ''}</div>
        </div>
      </div>

      {/* Toolbar + library */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <h3 className="card-title">Filings Library</h3>
          <div className="row">
            <input className="search" placeholder="Filter by ticker..." value={filterTicker} onChange={e => setFilterTicker(e.target.value)} style={{ width: 160 }} />
            <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{
              padding: '6px 10px', background: 'var(--bg-elev)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', color: 'var(--text)', fontSize: 12,
            }}>
              <option>All</option>
              {FILING_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
            <button className="btn btn-primary" onClick={() => setShowUpload(true)}>
              <Icon name="plus" size={12} /> Upload PDF
            </button>
          </div>
        </div>

        <div className="card-body flush">
          {filtered.length === 0 ? (
            <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: 14, marginBottom: 8 }}>No filings match your filters</div>
              <button className="btn" onClick={() => { setFilterTicker(''); setFilterType('All'); }}>Clear filters</button>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 28 }}></th>
                  <th>Document</th>
                  <th>Ticker</th>
                  <th>Type</th>
                  <th>Period</th>
                  <th className="right">Pages</th>
                  <th className="right">Size</th>
                  <th>Uploaded</th>
                  <th>Status</th>
                  <th className="right" style={{ width: 80 }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(f => (
                  <tr key={f.id} onClick={() => setSelected(f)} style={{ background: selected?.id === f.id ? 'var(--bg-hover)' : undefined }}>
                    <td><PdfIcon /></td>
                    <td style={{ fontWeight: 500, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</td>
                    <td><span className="ticker">{f.ticker}</span></td>
                    <td><span style={{ fontSize: 11, padding: '2px 6px', background: 'var(--bg-sunken)', color: 'var(--text-muted)', borderRadius: 3, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{f.type}</span></td>
                    <td style={{ color: 'var(--text-muted)' }}>{f.period}</td>
                    <td className="right num" style={{ color: 'var(--text-muted)' }}>{f.pages || '—'}</td>
                    <td className="right num" style={{ color: 'var(--text-muted)' }}>{fmtBytes(f.size)}</td>
                    <td className="num" style={{ color: 'var(--text-muted)', fontSize: 12 }}>{f.uploaded}</td>
                    <td><StatusBadge status={f.status} /></td>
                    <td className="right">
                      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); removeFiling(f.id); }} title="Remove" style={{ width: 24, height: 24 }}>
                        <Icon name="close" size={11} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Selected filing details */}
      {selected && (
        <FilingDetail
          filing={selected}
          onClose={() => setSelected(null)}
          onAnalyze={() => analyzeFiling(selected)}
          analyzing={analyzing === selected.id}
          analysis={analysisOutput[selected.id]}
          onOpenReader={() => setReaderFiling(selected)}
        />
      )}

      {showUpload && <UploadDialog onClose={() => setShowUpload(false)} onUpload={addFiling} />}
      {readerFiling && <StatementReader filing={readerFiling} onClose={() => setReaderFiling(null)} />}
    </>
  );
};

const PdfIcon = () => (
  <div style={{
    width: 22, height: 26,
    background: 'var(--neg-bg)',
    border: '1px solid var(--neg-soft)',
    borderRadius: 2,
    color: 'var(--neg)',
    fontSize: 8,
    fontWeight: 700,
    display: 'grid', placeItems: 'center',
    fontFamily: 'var(--font-mono)',
  }}>PDF</div>
);

const StatusBadge = ({ status }) => {
  const map = {
    analyzed: { label: 'Analyzed', bg: 'var(--pos-bg)', fg: 'var(--pos)' },
    processing: { label: 'Processing', bg: 'var(--accent-bg)', fg: 'var(--accent)' },
    pending: { label: 'Pending', bg: 'var(--bg-sunken)', fg: 'var(--text-muted)' },
    failed: { label: 'Failed', bg: 'var(--neg-bg)', fg: 'var(--neg)' },
  };
  const s = map[status] || map.pending;
  return (
    <span style={{ fontSize: 10, padding: '2px 8px', background: s.bg, color: s.fg, borderRadius: 999, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
      {s.label}
    </span>
  );
};

const FilingDetail = ({ filing, onClose, onAnalyze, analyzing, analysis, onOpenReader }) => {
  return (
    <div className="grid-2">
      {/* PDF preview placeholder */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">{filing.name}</h3>
          <div className="row">
            <button className="icon-btn" title="Expand"><Icon name="expand" size={12} /></button>
            <button className="icon-btn" title="Download"><Icon name="download" size={12} /></button>
            <button className="icon-btn" onClick={onClose}><Icon name="close" size={12} /></button>
          </div>
        </div>
        <div style={{ padding: 16, background: 'var(--bg-sunken)', minHeight: 480 }}>
          <PdfPreview filing={filing} />
        </div>
      </div>

      {/* AI summary panel */}
      <div className="stack">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Document Summary</h3>
            <div className="row">
              <button className="btn btn-accent" onClick={onOpenReader} title="Open immersive reader" style={{ background: 'var(--accent)', color: 'white', border: 'none' }}>
                <Icon name="sparkle" size={11} /> Open in Reader
              </button>
              <button className="btn" onClick={() => openFilingInNewTab(filing)} title="Open PDF in new tab">
                <Icon name="expand" size={11} /> Open PDF
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{filing.ticker} · {filing.period}</span>
            </div>
          </div>
          <div className="card-body">
            {filing.extracted && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
                  <ExtractTile label="Revenue" value={filing.extracted.revenue} />
                  <ExtractTile label="Net Income" value={filing.extracted.netIncome} />
                  <ExtractTile label="Free Cash Flow" value={filing.extracted.fcf} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, padding: 12, background: 'var(--bg-sunken)', borderRadius: 4 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Auto-extracted notes</div>
                  {filing.extracted.notes}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--accent)', borderRadius: '50%', marginRight: 8, verticalAlign: 'middle' }}></span>
              AI Deep Analysis
            </h3>
            <button className="btn btn-accent" onClick={onAnalyze} disabled={analyzing} style={{ fontSize: 11, padding: '5px 10px' }}>
              <Icon name="sparkle" size={11} /> {analyzing ? 'Analyzing…' : analysis ? 'Re-analyze' : 'Analyze with AI'}
            </button>
          </div>
          <div className="card-body">
            {!analysis && !analyzing && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                Click <strong style={{ color: 'var(--text)' }}>Analyze with AI</strong> to extract key findings, risks, and quality signals.
              </div>
            )}
            {analyzing && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                <div className="row" style={{ justifyContent: 'center', gap: 4, marginBottom: 8 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', animation: 'pulse 1s infinite' }}></span>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', animation: 'pulse 1s infinite 150ms' }}></span>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', animation: 'pulse 1s infinite 300ms' }}></span>
                </div>
                Reading filing and extracting findings...
              </div>
            )}
            {analysis && (
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                <FormattedText text={analysis} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const ExtractTile = ({ label, value }) => (
  <div style={{ padding: 10, background: 'var(--bg-sunken)', borderRadius: 4 }}>
    <div style={{ fontSize: 10, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{label}</div>
    <div className="num" style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>${value}</div>
  </div>
);

// Visual placeholder for PDF — stylized first page
const PdfPreview = ({ filing }) => (
  <div style={{
    background: 'white', maxWidth: 380, margin: '0 auto', aspectRatio: '8.5/11',
    boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: '40px 36px',
    color: '#1a1a1a', fontFamily: 'Times, serif', fontSize: 9, lineHeight: 1.4,
    overflow: 'hidden',
  }}>
    <div style={{ textAlign: 'center', borderBottom: '2px solid #1a1a1a', paddingBottom: 12, marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.05em' }}>UNITED STATES</div>
      <div style={{ fontSize: 13, fontWeight: 700 }}>SECURITIES AND EXCHANGE COMMISSION</div>
      <div style={{ fontSize: 9, marginTop: 4 }}>Washington, D.C. 20549</div>
    </div>
    <div style={{ textAlign: 'center', margin: '20px 0' }}>
      <div style={{ fontSize: 18, fontWeight: 700, border: '2px solid #1a1a1a', padding: '8px 24px', display: 'inline-block' }}>FORM {filing.type}</div>
    </div>
    <div style={{ textAlign: 'center', fontSize: 10, fontWeight: 600 }}>
      ANNUAL REPORT PURSUANT TO SECTION 13 OR 15(d)<br/>OF THE SECURITIES EXCHANGE ACT OF 1934
    </div>
    <div style={{ textAlign: 'center', margin: '16px 0', fontSize: 9 }}>
      For the fiscal year ended {filing.period}
    </div>
    <div style={{ textAlign: 'center', fontSize: 16, fontWeight: 700, margin: '24px 0 4px', letterSpacing: '0.05em' }}>
      {filing.ticker === 'NVDA' ? 'NVIDIA CORPORATION' : filing.ticker === 'AAPL' ? 'APPLE INC.' : filing.ticker.toUpperCase() + ' INC.'}
    </div>
    <div style={{ textAlign: 'center', fontSize: 8, color: '#666', marginBottom: 20 }}>
      (Exact name of registrant as specified in its charter)
    </div>
    <div style={{ borderTop: '1px solid #ccc', paddingTop: 12, color: '#666', fontSize: 8 }}>
      <div>Delaware &nbsp; · &nbsp; 94-1234567</div>
      <div>{filing.pages || '—'} pages · Filed electronically</div>
    </div>
    <div style={{ marginTop: 20, fontSize: 8, color: '#999', fontStyle: 'italic', textAlign: 'center' }}>
      [Document preview · {filing.pages} pages total]
    </div>
  </div>
);

const UploadDialog = ({ onClose, onUpload }) => {
  const [dragActive, setDragActive] = React.useState(false);
  const [file, setFile] = React.useState(null);
  const [meta, setMeta] = React.useState({ ticker: '', type: '10-K', period: '' });
  const inputRef = React.useRef(null);

  const handleFile = (f) => {
    if (!f) return;
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      window.toast && window.toast('Please choose a PDF file', { type: 'error' });
      return;
    }
    setFile(f);
    // Try to auto-detect ticker from filename
    const m = f.name.match(/^([A-Z]{2,5})/);
    if (m && !meta.ticker) setMeta(x => ({ ...x, ticker: m[1] }));
  };

  const submit = () => {
    if (!file || !meta.ticker || !meta.period) {
      window.toast && window.toast('Add a file, ticker, and period', { type: 'error' });
      return;
    }
    const newFiling = {
      id: 'f_' + Date.now(),
      name: file.name,
      ticker: meta.ticker.toUpperCase(),
      type: meta.type,
      period: meta.period,
      size: file.size,
      uploaded: new Date().toISOString().slice(0, 10),
      status: 'analyzed',
      pages: Math.round(file.size / 40000) || 1,
      extracted: {
        revenue: '—',
        netIncome: '—',
        fcf: '—',
        notes: 'Newly uploaded. Click "Analyze with AI" to extract findings.',
      },
    };
    onUpload(newFiling);
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
      display: 'grid', placeItems: 'center', padding: 24,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8,
        width: '100%', maxWidth: 520, padding: 0, overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
      }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 className="serif" style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Upload Financial Statement</h3>
          <button className="icon-btn" onClick={onClose}><Icon name="close" size={12} /></button>
        </div>
        <div style={{ padding: 20 }}>
          <div
            onDragOver={e => { e.preventDefault(); setDragActive(true); }}
            onDragLeave={() => setDragActive(false)}
            onDrop={e => {
              e.preventDefault();
              setDragActive(false);
              handleFile(e.dataTransfer.files[0]);
            }}
            onClick={() => inputRef.current?.click()}
            style={{
              border: `2px dashed ${dragActive ? 'var(--accent)' : 'var(--border-strong)'}`,
              background: dragActive ? 'var(--accent-bg)' : 'var(--bg-sunken)',
              borderRadius: 6, padding: 32, textAlign: 'center',
              cursor: 'pointer', transition: 'all 150ms ease',
              marginBottom: 16,
            }}>
            <input ref={inputRef} type="file" accept=".pdf,application/pdf" onChange={e => handleFile(e.target.files[0])} style={{ display: 'none' }} />
            {file ? (
              <>
                <PdfIcon />
                <div style={{ marginTop: 12, fontWeight: 600 }}>{file.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{fmtBytes(file.size)} · Click to replace</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 28, marginBottom: 6, color: 'var(--text-subtle)' }}>↥</div>
                <div style={{ fontWeight: 600 }}>Drop a PDF here, or click to browse</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>10-K, 10-Q, 8-K, earnings releases · up to 50 MB</div>
              </>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <FormField label="Ticker">
              <input type="text" value={meta.ticker} onChange={e => setMeta(x => ({ ...x, ticker: e.target.value }))}
                placeholder="NVDA" style={inputStyle} />
            </FormField>
            <FormField label="Type">
              <select value={meta.type} onChange={e => setMeta(x => ({ ...x, type: e.target.value }))} style={inputStyle}>
                {FILING_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </FormField>
            <FormField label="Period">
              <input type="text" value={meta.period} onChange={e => setMeta(x => ({ ...x, period: e.target.value }))}
                placeholder="FY 2025" style={inputStyle} />
            </FormField>
          </div>
        </div>
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', background: 'var(--bg-sunken)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Stored locally · auto-extract on upload</span>
          <div className="row">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={submit} disabled={!file}>Add to library</button>
          </div>
        </div>
      </div>
    </div>
  );
};

const inputStyle = {
  width: '100%', padding: '7px 10px',
  background: 'var(--bg-elev)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', color: 'var(--text)', fontSize: 13,
  fontFamily: 'inherit',
};

const FormField = ({ label, children }) => (
  <div>
    <label style={{ fontSize: 11, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, display: 'block', marginBottom: 4 }}>{label}</label>
    {children}
  </div>
);

window.PageFilings = PageFilings;

const openFilingInNewTab = (filing) => {
  const w = window.open('', '_blank');
  if (!w) return;
  const companyName = filing.ticker === 'NVDA' ? 'NVIDIA CORPORATION'
    : filing.ticker === 'AAPL' ? 'APPLE INC.'
    : filing.ticker.toUpperCase() + ' INC.';
  const ext = filing.extracted || {};
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${filing.name}</title>
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #525659; font-family: 'Source Serif 4', Georgia, serif; padding: 32px 0; }
  .toolbar { position: sticky; top: 0; background: #323639; color: #ddd; padding: 10px 24px; display: flex; gap: 16px; align-items: center; font-family: ui-sans-serif, system-ui; font-size: 13px; margin: -32px 0 24px; z-index: 10; }
  .toolbar .title { flex: 1; font-weight: 500; }
  .toolbar .meta { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #999; }
  .toolbar button { background: #4a4d50; color: #fff; border: 1px solid #555; padding: 5px 12px; border-radius: 3px; font-size: 12px; cursor: pointer; font-family: inherit; }
  .toolbar button:hover { background: #5a5d60; }
  .page { width: 850px; min-height: 1100px; background: white; margin: 24px auto; padding: 80px 90px; box-shadow: 0 4px 24px rgba(0,0,0,0.3); color: #1a1a1a; line-height: 1.5; font-size: 11pt; }
  .page-num { text-align: center; font-size: 9pt; color: #888; margin-top: 40px; font-family: ui-sans-serif; }
  h1 { font-size: 22pt; font-weight: 700; text-align: center; letter-spacing: 0.02em; margin: 0 0 8px; }
  h2 { font-size: 14pt; font-weight: 700; margin: 32px 0 12px; border-bottom: 1px solid #1a1a1a; padding-bottom: 4px; }
  h3 { font-size: 12pt; font-weight: 700; margin: 20px 0 8px; }
  .cover { text-align: center; padding: 60px 0 40px; border-bottom: 3px double #1a1a1a; margin-bottom: 32px; }
  .cover .seal { font-size: 11pt; font-weight: 700; letter-spacing: 0.08em; }
  .cover .form-box { display: inline-block; border: 3px solid #1a1a1a; padding: 12px 40px; font-size: 20pt; font-weight: 700; margin: 24px 0; }
  .cover .registrant { font-size: 18pt; font-weight: 700; margin: 32px 0 8px; letter-spacing: 0.04em; }
  .cover .small { font-size: 9pt; color: #555; font-style: italic; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-family: 'JetBrains Mono', monospace; font-size: 10pt; }
  th, td { padding: 6px 10px; border-bottom: 1px solid #ccc; text-align: left; }
  th { background: #f5f5f0; font-weight: 700; font-family: 'Source Serif 4', serif; font-size: 10pt; }
  td.right, th.right { text-align: right; }
  td.bold { font-weight: 700; }
  p { margin: 8px 0; text-align: justify; }
  .highlight { background: #fff8d4; padding: 12px 16px; border-left: 3px solid #b8860b; margin: 16px 0; font-size: 10pt; }
  .toc-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px dotted #ccc; font-size: 10pt; }
</style></head>
<body>
<div class="toolbar">
  <div class="title">${filing.name}</div>
  <span class="meta">${filing.pages || '—'} pages · ${(filing.size/1024/1024).toFixed(1)} MB</span>
  <button onclick="window.print()">Print / Save</button>
  <button onclick="window.close()">Close</button>
</div>

<div class="page">
  <div class="cover">
    <div class="seal">UNITED STATES<br>SECURITIES AND EXCHANGE COMMISSION<br><span style="font-weight:400;font-size:9pt;">Washington, D.C. 20549</span></div>
    <div class="form-box">FORM ${filing.type}</div>
    <p style="font-weight:600;font-size:10pt;">${filing.type === '10-K' ? 'ANNUAL REPORT PURSUANT TO SECTION 13 OR 15(d)' : filing.type === '10-Q' ? 'QUARTERLY REPORT PURSUANT TO SECTION 13 OR 15(d)' : 'CURRENT REPORT'}<br>OF THE SECURITIES EXCHANGE ACT OF 1934</p>
    <p style="font-size:10pt;">For the period ended <strong>${filing.period}</strong></p>
    <div class="registrant">${companyName}</div>
    <div class="small">(Exact name of registrant as specified in its charter)</div>
    <table style="width:60%;margin:24px auto;font-size:9pt;border:none;">
      <tr style="border:none;"><td style="border:none;text-align:center;"><strong>Delaware</strong><br><span class="small">State of incorporation</span></td>
      <td style="border:none;text-align:center;"><strong>94-1234567</strong><br><span class="small">IRS Employer ID</span></td></tr>
    </table>
  </div>

  <h2>Table of Contents</h2>
  <div class="toc-row"><span>PART I — Item 1. Business</span><span>3</span></div>
  <div class="toc-row"><span>Item 1A. Risk Factors</span><span>14</span></div>
  <div class="toc-row"><span>Item 7. Management's Discussion and Analysis (MD&amp;A)</span><span>32</span></div>
  <div class="toc-row"><span>Item 8. Financial Statements and Supplementary Data</span><span>48</span></div>
  <div class="toc-row"><span>&nbsp;&nbsp;&nbsp;Consolidated Statements of Income</span><span>49</span></div>
  <div class="toc-row"><span>&nbsp;&nbsp;&nbsp;Consolidated Balance Sheets</span><span>51</span></div>
  <div class="toc-row"><span>&nbsp;&nbsp;&nbsp;Consolidated Statements of Cash Flows</span><span>53</span></div>
  <div class="toc-row"><span>&nbsp;&nbsp;&nbsp;Notes to the Consolidated Financial Statements</span><span>55</span></div>
  <div class="toc-row"><span>PART II — Other Information</span><span>98</span></div>
  <div class="page-num">— 1 —</div>
</div>

<div class="page">
  <h2>Item 7. Management's Discussion and Analysis</h2>
  <h3>Overview</h3>
  <p>${companyName} delivered record performance for ${filing.period}, with revenue of <strong>$${ext.revenue || 'XXX'}</strong> and net income of <strong>$${ext.netIncome || 'XXX'}</strong>. Free cash flow generation reached <strong>$${ext.fcf || 'XXX'}</strong>, reflecting strong operational execution and continued discipline in capital allocation.</p>
  <p>${ext.notes || 'Management continues to focus on long-term value creation through investment in research and development, market expansion, and disciplined capital returns to shareholders.'}</p>

  <div class="highlight">
    <strong>Key Performance Highlights</strong><br>
    Revenue grew significantly year-over-year, supported by strong customer demand and favorable product mix. Operating margins expanded as the company benefited from operating leverage and a more efficient cost structure.
  </div>

  <h3>Results of Operations</h3>
  <table>
    <thead><tr><th>(USD millions)</th><th class="right">Current Period</th><th class="right">Prior Period</th><th class="right">% Change</th></tr></thead>
    <tbody>
      <tr><td>Revenue</td><td class="right bold">$${ext.revenue || '130,497'}</td><td class="right">$60,922</td><td class="right">+114%</td></tr>
      <tr><td>Cost of Revenue</td><td class="right">32,500</td><td class="right">16,621</td><td class="right">+96%</td></tr>
      <tr><td>Gross Profit</td><td class="right bold">97,997</td><td class="right">44,301</td><td class="right">+121%</td></tr>
      <tr><td>Operating Expenses</td><td class="right">16,408</td><td class="right">11,329</td><td class="right">+45%</td></tr>
      <tr><td>Operating Income</td><td class="right bold">81,588</td><td class="right">32,972</td><td class="right">+147%</td></tr>
      <tr><td>Net Income</td><td class="right bold">$${ext.netIncome || '72,880'}</td><td class="right">$29,760</td><td class="right">+145%</td></tr>
    </tbody>
  </table>

  <h3>Liquidity and Capital Resources</h3>
  <p>As of the end of the reporting period, the company held substantial cash, cash equivalents, and marketable securities. Operating cash flow was <strong>$${ext.fcf ? (parseFloat(ext.fcf) + 3).toFixed(1) + 'B' : '64.1B'}</strong>, providing ample liquidity for ongoing operations, strategic investments, and shareholder returns.</p>
  <div class="page-num">— 32 —</div>
</div>

<div class="page">
  <h2>Item 8. Consolidated Statements of Income</h2>
  <p style="font-style:italic;font-size:9pt;color:#666;">(In millions, except per share data)</p>
  <table>
    <thead><tr><th>Line Item</th><th class="right">${filing.period}</th><th class="right">Prior Year</th></tr></thead>
    <tbody>
      <tr><td class="bold">Revenue</td><td class="right bold">$${ext.revenue || '130,497'}</td><td class="right">$60,922</td></tr>
      <tr><td>Cost of revenue</td><td class="right">(32,500)</td><td class="right">(16,621)</td></tr>
      <tr><td class="bold">Gross profit</td><td class="right bold">97,997</td><td class="right">44,301</td></tr>
      <tr><td>Research and development</td><td class="right">(12,914)</td><td class="right">(8,675)</td></tr>
      <tr><td>Sales, general and administrative</td><td class="right">(3,494)</td><td class="right">(2,654)</td></tr>
      <tr><td class="bold">Operating income</td><td class="right bold">81,589</td><td class="right">32,972</td></tr>
      <tr><td>Interest income, net</td><td class="right">1,844</td><td class="right">866</td></tr>
      <tr><td>Income before tax</td><td class="right">83,433</td><td class="right">33,838</td></tr>
      <tr><td>Provision for income taxes</td><td class="right">(10,553)</td><td class="right">(4,078)</td></tr>
      <tr><td class="bold">Net income</td><td class="right bold">$${ext.netIncome || '72,880'}</td><td class="right">$29,760</td></tr>
      <tr><td class="bold">Diluted earnings per share</td><td class="right bold">$29.76</td><td class="right">$11.93</td></tr>
    </tbody>
  </table>

  <p style="margin-top:20px;font-style:italic;font-size:10pt;color:#666;">The accompanying notes are an integral part of these consolidated financial statements.</p>
  <div class="page-num">— 49 —</div>
</div>

<div class="page" style="display:flex;align-items:center;justify-content:center;flex-direction:column;color:#888;font-style:italic;">
  <div style="font-size:14pt;margin-bottom:12px;">[Pages 50–${filing.pages || 124} omitted from preview]</div>
  <div style="font-size:10pt;">Full filing contains ${filing.pages || 124} pages including notes,<br>risk factors, and supplementary schedules.</div>
  <button onclick="window.print()" style="margin-top:24px;padding:10px 20px;background:#1a1a1a;color:white;border:none;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12pt;">Print full document</button>
</div>
</body></html>`;
  w.document.write(html);
  w.document.close();
};
