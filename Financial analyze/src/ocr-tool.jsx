// OCR Parse tool — simulates scanning a PDF and extracting financial data
// In production: wire to Tesseract.js (client) or AWS Textract / Google Doc AI (server)
// then post-process with Claude to map raw values to tracker fields.

const OCR_RESULTS = (filing) => {
  // Simulated extraction results — in prod these come from Tesseract + Claude validation
  // Each item maps cleanly to a Data Tracker row by section + id
  return [
    // Income — page 49
    { id: 'rev',     section: 'income',   metric: 'Revenue',            curr: '130497', prev: '60922', page: 49, confidence: 99, bbox: { y: 22, h: 6 } },
    { id: 'gp',      section: 'income',   metric: 'Gross Profit',       curr: '97997',  prev: '44301', page: 49, confidence: 98, bbox: { y: 32, h: 6 } },
    { id: 'oi',      section: 'income',   metric: 'Operating Income',   curr: '81589',  prev: '32972', page: 49, confidence: 99, bbox: { y: 50, h: 6 } },
    { id: 'ni',      section: 'income',   metric: 'Net Income',         curr: '72880',  prev: '29760', page: 49, confidence: 99, bbox: { y: 64, h: 6 } },
    { id: 'eps',     section: 'income',   metric: 'EPS (diluted)',      curr: '29.76',  prev: '11.93', page: 49, confidence: 76, bbox: { y: 76, h: 6 } },
    // Balance — page 51
    { id: 'cash',    section: 'balance',  metric: 'Cash & equivalents', curr: '8589',   prev: '7280',  page: 51, confidence: 97 },
    { id: 'ta',      section: 'balance',  metric: 'Total Assets',       curr: '111601', prev: '65728', page: 51, confidence: 99 },
    { id: 'ltd',     section: 'balance',  metric: 'Long-Term Debt',     curr: '8463',   prev: '8460',  page: 51, confidence: 95 },
    { id: 'te',      section: 'balance',  metric: 'Total Equity',       curr: '79292',  prev: '42978', page: 52, confidence: 98 },
    // Cash Flow — page 53
    { id: 'ocf',     section: 'cashflow', metric: 'Operating Cash Flow',curr: '64089',  prev: '28090', page: 53, confidence: 99 },
    { id: 'capex',   section: 'cashflow', metric: 'CapEx',              curr: '-3236',  prev: '-1069', page: 53, confidence: 88 },
    { id: 'fcf',     section: 'cashflow', metric: 'Free Cash Flow',     curr: '60853',  prev: '27021', page: 53, confidence: 94 },
    { id: 'buyback', section: 'cashflow', metric: 'Buybacks',           curr: '-33706', prev: '-9533', page: 54, confidence: 82 },
  ];
};

const SECTION_LABELS = { income: 'Income', balance: 'Balance', cashflow: 'Cash Flow' };
const SECTION_COLORS = { income: '#C2410C', balance: '#1D4ED8', cashflow: '#15803D' };

// ─────────────────────────────────────────────────────────────────────────────

const OCRDialog = ({ filing, onImport, onClose }) => {
  const [step, setStep] = React.useState('scanning'); // scanning | review
  const [progress, setProgress] = React.useState(0);
  const [statusMessage, setStatusMessage] = React.useState('Initializing OCR engine…');
  const [stats, setStats] = React.useState({ pages: 0, tables: 0, numbers: 0, current: 1 });
  const [results, setResults] = React.useState([]);
  const [selected, setSelected] = React.useState(new Set());
  const [filter, setFilter] = React.useState('all');

  const data = React.useMemo(() => OCR_RESULTS(filing), [filing]);
  const backendRowsRef = React.useRef(null);

  // When the Python backend is live and this filing exists server-side,
  // fetch real parsed rows while the scan animation plays.
  React.useEffect(() => {
    if (window.HelixAPI?.live && typeof filing.id === 'number') {
      window.HelixAPI.ocrParse(filing.id)
        .then(out => { if (out.rows?.length) backendRowsRef.current = out.rows; })
        .catch(() => {});
    }
  }, [filing]);

  // Drive the scanning animation
  React.useEffect(() => {
    if (step !== 'scanning') return;
    const steps = [
      { at: 0,   msg: 'Initializing OCR engine (Tesseract v5)…' },
      { at: 12,  msg: 'Reading PDF pages…' },
      { at: 28,  msg: 'Extracting text from page layout…' },
      { at: 46,  msg: 'Detecting financial tables…' },
      { at: 64,  msg: 'Parsing numerical values…' },
      { at: 78,  msg: 'Validating with Claude Sonnet 4.5…' },
      { at: 92,  msg: 'Mapping to Data Tracker schema…' },
    ];
    let p = 0;
    const tick = setInterval(() => {
      p += 2;
      if (p > 100) p = 100;
      setProgress(p);

      const s = steps.filter(x => p >= x.at).pop();
      if (s) setStatusMessage(s.msg);

      setStats({
        pages: Math.min(filing.pages || 124, Math.round((p / 100) * (filing.pages || 124))),
        tables: Math.min(12, Math.round((p / 100) * 12)),
        numbers: Math.min(247, Math.round((p / 100) * 247)),
        current: Math.min(filing.pages || 124, Math.max(1, Math.round((p / 100) * (filing.pages || 124)))),
      });

      if (p >= 100) {
        clearInterval(tick);
        const finalRows = backendRowsRef.current || data;
        setResults(finalRows);
        setSelected(new Set(finalRows.filter(d => d.confidence >= 85).map(d => d.id)));
        setTimeout(() => setStep('review'), 600);
      }
    }, 70);
    return () => clearInterval(tick);
  }, [step, filing, data]);

  const toggle = (id) => {
    setSelected(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const visible = filtered.map(r => r.id);
    setSelected(s => {
      const allSelected = visible.every(id => s.has(id));
      const next = new Set(s);
      visible.forEach(id => { if (allSelected) next.delete(id); else next.add(id); });
      return next;
    });
  };

  const filtered = results.filter(r => filter === 'all' || r.section === filter);
  const selectedCount = filtered.filter(r => selected.has(r.id)).length;

  const handleImport = () => {
    const toImport = results.filter(r => selected.has(r.id));
    onImport(toImport);
    onClose();
  };

  return (
    <div style={ocrStyles.overlay} onClick={onClose}>
      <div style={ocrStyles.dialog} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={ocrStyles.header}>
          <div className="row" style={{ gap: 10 }}>
            <div style={ocrStyles.headerIcon}>
              <Icon name="search" size={14} />
            </div>
            <div>
              <div style={{ fontFamily: 'var(--font-serif)', fontSize: 16, fontWeight: 600 }}>
                OCR Parse
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {filing.name}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={ocrStyles.closeBtn}>
            <Icon name="close" size={12} />
          </button>
        </div>

        {/* Body — switches by step */}
        {step === 'scanning' ? (
          <ScanningView
            filing={filing}
            progress={progress}
            statusMessage={statusMessage}
            stats={stats}
          />
        ) : (
          <ReviewView
            results={results}
            filtered={filtered}
            selected={selected}
            filter={filter}
            setFilter={setFilter}
            toggle={toggle}
            toggleAll={toggleAll}
            selectedCount={selectedCount}
          />
        )}

        {/* Footer */}
        <div style={ocrStyles.footer}>
          <div style={{ fontSize: 11, color: 'var(--text-subtle)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={ocrStyles.engineBadge}>Tesseract v5</span>
            <span>+</span>
            <span style={ocrStyles.engineBadge}>Claude Sonnet 4.5</span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button onClick={onClose} style={ocrStyles.cancelBtn}>Cancel</button>
            {step === 'review' && (
              <button onClick={handleImport} disabled={selected.size === 0} style={ocrStyles.importBtn}>
                Import {selected.size} {selected.size === 1 ? 'metric' : 'metrics'} →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Scanning view — animated PDF preview with extraction log

const ScanningView = ({ filing, progress, statusMessage, stats }) => {
  return (
    <div style={ocrStyles.body}>
      <div style={ocrStyles.scanLayout}>
        {/* Left: mock PDF with scan line */}
        <div style={ocrStyles.pdfWrap}>
          <div style={ocrStyles.pdfFrame}>
            {/* Stylized page content */}
            <div style={ocrStyles.pdfHeader}>FORM {filing.type}</div>
            <div style={ocrStyles.pdfTitle}>{filing.ticker} · {filing.period}</div>
            <div style={{ marginTop: 16 }}>
              {/* Mock rows that highlight as scan passes */}
              {MOCK_PAGE_ROWS.map((r, i) => {
                const rowProgress = (i + 1) * (100 / MOCK_PAGE_ROWS.length);
                const passed = progress >= rowProgress - 3;
                const recent = passed && progress < rowProgress + 8;
                return (
                  <div key={i} style={{
                    ...ocrStyles.pdfRow,
                    background: recent ? '#FED7AA' : (passed ? '#FFF7ED' : 'transparent'),
                    transition: 'background 300ms ease',
                  }}>
                    <span style={{ flex: 1, fontWeight: r.bold ? 700 : 400 }}>{r.label}</span>
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontWeight: r.bold ? 700 : 500,
                      color: passed ? '#1a1a1a' : '#bbb',
                    }}>
                      {r.val}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Scanning line overlay */}
            <div style={{
              ...ocrStyles.scanLine,
              top: `${(progress / 100) * 90 + 5}%`,
              opacity: progress > 0 && progress < 100 ? 1 : 0,
            }} />
            <div style={{
              ...ocrStyles.scanGlow,
              top: `${(progress / 100) * 90 + 5}%`,
              opacity: progress > 0 && progress < 100 ? 1 : 0,
            }} />
          </div>
          <div style={ocrStyles.pageBadge}>
            Page {stats.current} / {filing.pages || 124}
          </div>
        </div>

        {/* Right: live status */}
        <div style={ocrStyles.scanStatus}>
          <div style={ocrStyles.statusBig}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <SpinDot />
              <span style={{ fontSize: 13, fontWeight: 500 }}>{statusMessage}</span>
            </div>
            <div style={ocrStyles.progressTrack}>
              <div style={{ ...ocrStyles.progressFill, width: `${progress}%` }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {progress.toFixed(0)}% complete
            </div>
          </div>

          <div style={ocrStyles.statsGrid}>
            <ScanStat label="Pages scanned" value={stats.pages} />
            <ScanStat label="Tables found" value={stats.tables} />
            <ScanStat label="Numbers extracted" value={stats.numbers} />
            <ScanStat label="Confidence" value={`${Math.min(96, Math.round(progress * 0.96))}%`} />
          </div>

          <div style={ocrStyles.logBox}>
            <div style={ocrStyles.logTitle}>Activity</div>
            <LogLine show={progress >= 8} text="PDF loaded · 124 pages, 4.2 MB" />
            <LogLine show={progress >= 22} text="Detected machine-readable text" />
            <LogLine show={progress >= 38} text="Found Item 8: Financial Statements at p. 48" />
            <LogLine show={progress >= 52} text="Extracted Consolidated Income Statement table" />
            <LogLine show={progress >= 64} text="Extracted Consolidated Balance Sheet table" />
            <LogLine show={progress >= 74} text="Extracted Consolidated Cash Flow table" />
            <LogLine show={progress >= 86} text="Cross-validated 12 high-confidence numbers" />
            <LogLine show={progress >= 95} text="Mapped to schema · ready for review" highlight />
          </div>
        </div>
      </div>
    </div>
  );
};

const MOCK_PAGE_ROWS = [
  { label: 'Revenue',                       val: '130,497', bold: true },
  { label: 'Cost of revenue',               val: '(32,500)' },
  { label: 'Gross profit',                  val: '97,997',  bold: true },
  { label: 'Research and development',      val: '(12,914)' },
  { label: 'Sales, general & admin',        val: '(3,494)' },
  { label: 'Operating income',              val: '81,589',  bold: true },
  { label: 'Interest income, net',          val: '1,844' },
  { label: 'Income before tax',             val: '83,433' },
  { label: 'Provision for income taxes',    val: '(10,553)' },
  { label: 'Net income',                    val: '72,880',  bold: true },
  { label: 'Diluted earnings per share',    val: '$29.76' },
];

const ScanStat = ({ label, value }) => (
  <div style={ocrStyles.scanStat}>
    <div style={ocrStyles.scanStatLabel}>{label}</div>
    <div style={ocrStyles.scanStatValue}>{value}</div>
  </div>
);

const LogLine = ({ show, text, highlight }) => (
  <div style={{
    fontSize: 11, color: show ? (highlight ? 'var(--accent)' : 'var(--text-muted)') : 'transparent',
    fontFamily: 'var(--font-mono)', padding: '3px 0',
    transition: 'color 300ms ease',
    fontWeight: highlight ? 600 : 400,
  }}>
    {show ? `✓ ${text}` : '◌'}
  </div>
);

const SpinDot = () => (
  <span style={{
    width: 10, height: 10, borderRadius: '50%',
    background: 'var(--accent)',
    boxShadow: '0 0 0 4px var(--accent-bg)',
    animation: 'ocr-pulse 1.2s infinite',
    display: 'inline-block',
  }} />
);

// ─────────────────────────────────────────────────────────────────────────────
// Review view

const ReviewView = ({ results, filtered, selected, filter, setFilter, toggle, toggleAll, selectedCount }) => {
  const avgConfidence = Math.round(results.reduce((s, r) => s + r.confidence, 0) / results.length);
  const allSelected = filtered.length > 0 && filtered.every(r => selected.has(r.id));

  return (
    <div style={ocrStyles.body}>
      {/* Top summary */}
      <div style={ocrStyles.summaryBar}>
        <div>
          <div style={{ fontSize: 13 }}>
            Extracted <strong>{results.length}</strong> metrics from{' '}
            <strong>{[...new Set(results.map(r => r.page))].length}</strong> pages
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            Average confidence: <strong style={{ color: avgConfidence >= 90 ? 'var(--pos)' : 'var(--accent)' }}>{avgConfidence}%</strong>
            {' · '}{selectedCount} selected to import
          </div>
        </div>
        <div style={{ display: 'inline-flex', background: 'var(--bg-sunken)', borderRadius: 4, padding: 2, gap: 2 }}>
          {[{ id: 'all', label: 'All' }, { id: 'income', label: 'Income' }, { id: 'balance', label: 'Balance' }, { id: 'cashflow', label: 'Cash Flow' }].map(t => (
            <button key={t.id} onClick={() => setFilter(t.id)}
              style={{
                padding: '5px 10px', fontSize: 11, fontWeight: 600,
                background: filter === t.id ? 'var(--bg-elev)' : 'transparent',
                color: filter === t.id ? 'var(--text)' : 'var(--text-muted)',
                border: 'none', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit',
                boxShadow: filter === t.id ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
              }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results table */}
      <div style={ocrStyles.resultsWrap}>
        <table style={ocrStyles.resultsTable}>
          <thead>
            <tr>
              <th style={{ ...ocrStyles.resTh, width: 28 }}>
                <input type="checkbox" checked={allSelected} onChange={toggleAll}
                  style={{ accentColor: 'var(--accent)' }} />
              </th>
              <th style={ocrStyles.resTh}>Metric</th>
              <th style={{ ...ocrStyles.resTh, width: 70 }}>Section</th>
              <th style={{ ...ocrStyles.resTh, width: 90, textAlign: 'right' }}>Current</th>
              <th style={{ ...ocrStyles.resTh, width: 80, textAlign: 'right' }}>Prior</th>
              <th style={{ ...ocrStyles.resTh, width: 50, textAlign: 'right' }}>Page</th>
              <th style={{ ...ocrStyles.resTh, width: 110 }}>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => {
              const isSelected = selected.has(r.id);
              return (
                <tr key={r.id} onClick={() => toggle(r.id)} style={{
                  cursor: 'pointer',
                  background: isSelected ? 'var(--accent-bg)' : 'transparent',
                  opacity: isSelected ? 1 : 0.6,
                }}>
                  <td style={ocrStyles.resTd}>
                    <input type="checkbox" checked={isSelected} onChange={() => toggle(r.id)}
                      onClick={e => e.stopPropagation()}
                      style={{ accentColor: 'var(--accent)' }} />
                  </td>
                  <td style={{ ...ocrStyles.resTd, fontWeight: 500 }}>{r.metric}</td>
                  <td style={ocrStyles.resTd}>
                    <span style={{
                      fontSize: 9, fontWeight: 700, padding: '2px 6px',
                      background: SECTION_COLORS[r.section] + '20',
                      color: SECTION_COLORS[r.section],
                      borderRadius: 3, textTransform: 'uppercase', letterSpacing: '0.05em',
                      fontFamily: 'var(--font-mono)',
                    }}>
                      {SECTION_LABELS[r.section]}
                    </span>
                  </td>
                  <td style={{ ...ocrStyles.resTd, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                    {r.curr}
                  </td>
                  <td style={{ ...ocrStyles.resTd, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                    {r.prev}
                  </td>
                  <td style={{ ...ocrStyles.resTd, textAlign: 'right', color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    p.{r.page}
                  </td>
                  <td style={ocrStyles.resTd}>
                    <ConfidenceBar value={r.confidence} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const ConfidenceBar = ({ value }) => {
  const color = value >= 90 ? 'var(--pos)' : value >= 75 ? 'var(--accent)' : 'var(--neg)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 5, background: 'var(--bg-sunken)', borderRadius: 3 }}>
        <div style={{ height: '100%', width: `${value}%`, background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 600, color, fontFamily: 'var(--font-mono)', minWidth: 30, textAlign: 'right' }}>
        {value}%
      </span>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────

const ocrStyles = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 10000,
    display: 'grid', placeItems: 'center', padding: 24,
  },
  dialog: {
    background: 'var(--bg)', borderRadius: 10, width: '100%', maxWidth: 900,
    maxHeight: '90vh', display: 'flex', flexDirection: 'column',
    boxShadow: '0 24px 80px rgba(0,0,0,0.35)', overflow: 'hidden',
  },
  header: {
    padding: '14px 18px', borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: 'var(--bg-elev)',
  },
  headerIcon: {
    width: 32, height: 32, borderRadius: 8,
    background: 'var(--accent-bg)', color: 'var(--accent)',
    display: 'grid', placeItems: 'center',
    border: '1px solid var(--accent-soft)',
  },
  closeBtn: {
    width: 28, height: 28, padding: 0, background: 'transparent',
    border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
    borderRadius: 4,
  },
  body: { flex: 1, overflow: 'auto', minHeight: 0 },
  footer: {
    padding: '12px 18px', borderTop: '1px solid var(--border)',
    background: 'var(--bg-sunken)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  },
  engineBadge: {
    fontSize: 10, fontWeight: 600, padding: '2px 6px',
    background: 'var(--bg-elev)', color: 'var(--text-muted)',
    border: '1px solid var(--border)', borderRadius: 3,
    fontFamily: 'var(--font-mono)',
  },
  cancelBtn: {
    padding: '7px 14px', background: 'transparent',
    border: '1px solid var(--border)', borderRadius: 4,
    fontSize: 12, fontWeight: 500, cursor: 'pointer', color: 'var(--text)',
    fontFamily: 'inherit',
  },
  importBtn: {
    padding: '7px 14px', background: 'var(--accent)', color: 'white',
    border: 'none', borderRadius: 4,
    fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  },

  // Scanning
  scanLayout: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0,
    height: '100%', minHeight: 480,
  },
  pdfWrap: {
    background: '#525659', padding: 24,
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    position: 'relative',
  },
  pdfFrame: {
    background: 'white', color: '#1a1a1a', width: '100%', maxWidth: 340,
    aspectRatio: '8.5/11', padding: '32px 28px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
    position: 'relative', overflow: 'hidden',
    fontFamily: '"Source Serif 4", Georgia, serif', fontSize: 11,
  },
  pdfHeader: {
    fontSize: 14, fontWeight: 700, letterSpacing: '0.05em',
    borderBottom: '2px solid #1a1a1a', paddingBottom: 6, marginBottom: 10,
  },
  pdfTitle: {
    fontSize: 10, color: '#666', fontFamily: 'var(--font-mono)',
  },
  pdfRow: {
    display: 'flex', justifyContent: 'space-between',
    padding: '4px 6px', borderBottom: '1px solid #eee',
    fontSize: 10,
  },
  scanLine: {
    position: 'absolute', left: 0, right: 0, height: 2,
    background: 'linear-gradient(90deg, transparent, #FB923C 30%, #C2410C 50%, #FB923C 70%, transparent)',
    boxShadow: '0 0 12px #C2410C, 0 0 24px #FB923C',
    transition: 'top 100ms linear',
    zIndex: 2,
  },
  scanGlow: {
    position: 'absolute', left: 0, right: 0, height: 40,
    transform: 'translateY(-50%)',
    background: 'linear-gradient(180deg, transparent, rgba(251, 146, 60, 0.18), transparent)',
    transition: 'top 100ms linear',
    pointerEvents: 'none',
  },
  pageBadge: {
    marginTop: 12, padding: '4px 10px',
    background: 'rgba(255,255,255,0.12)', color: 'white',
    borderRadius: 999, fontSize: 11, fontFamily: 'var(--font-mono)',
  },

  scanStatus: {
    padding: 24, display: 'flex', flexDirection: 'column', gap: 16, overflow: 'auto',
  },
  statusBig: {
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  progressTrack: {
    height: 6, background: 'var(--bg-sunken)', borderRadius: 3, overflow: 'hidden',
  },
  progressFill: {
    height: '100%', background: 'linear-gradient(90deg, var(--accent), #FB923C)',
    transition: 'width 150ms ease',
  },
  statsGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8,
  },
  scanStat: {
    padding: 12, background: 'var(--bg-elev)',
    border: '1px solid var(--border)', borderRadius: 6,
  },
  scanStatLabel: {
    fontSize: 10, color: 'var(--text-subtle)', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  },
  scanStatValue: {
    fontSize: 22, fontWeight: 600, fontFamily: 'var(--font-mono)',
    color: 'var(--text)', letterSpacing: '-0.01em', marginTop: 2,
  },
  logBox: {
    padding: 12, background: 'var(--bg-elev)',
    border: '1px solid var(--border)', borderRadius: 6,
  },
  logTitle: {
    fontSize: 10, color: 'var(--text-subtle)', fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6,
  },

  // Review
  summaryBar: {
    padding: '14px 18px', borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: 'var(--bg-elev)', gap: 12, flexWrap: 'wrap',
  },
  resultsWrap: {
    padding: 0, overflow: 'auto', maxHeight: 'calc(90vh - 220px)',
  },
  resultsTable: {
    width: '100%', borderCollapse: 'collapse', fontSize: 12,
  },
  resTh: {
    textAlign: 'left', padding: '10px 12px',
    fontSize: 10, fontWeight: 700, color: 'var(--text-subtle)',
    textTransform: 'uppercase', letterSpacing: '0.05em',
    borderBottom: '1px solid var(--border)', background: 'var(--bg-sunken)',
    position: 'sticky', top: 0, fontFamily: 'inherit',
  },
  resTd: {
    padding: '10px 12px', borderBottom: '1px solid var(--border)',
  },
};

// Inject @keyframes for pulse
if (!document.getElementById('ocr-style')) {
  const s = document.createElement('style');
  s.id = 'ocr-style';
  s.textContent = `
    @keyframes ocr-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.85); }
    }
  `;
  document.head.appendChild(s);
}

window.OCRDialog = OCRDialog;
