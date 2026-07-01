// Immersive financial statement reader — full-screen modal with AI annotations,
// plain-English mode, inline charts, smart highlights, scroll-spy AI companion.

const READER_STORAGE_KEY = 'helix_reader_tracker_v1';

const DEFAULT_TRACKER = () => ({
  income: [
    { id: 'rev',    metric: 'Revenue',           curr: '', prev: '', unit: '$M', notes: '' },
    { id: 'gp',     metric: 'Gross Profit',      curr: '', prev: '', unit: '$M', notes: '' },
    { id: 'oi',     metric: 'Operating Income',  curr: '', prev: '', unit: '$M', notes: '' },
    { id: 'ni',     metric: 'Net Income',        curr: '', prev: '', unit: '$M', notes: '' },
    { id: 'eps',    metric: 'EPS (diluted)',     curr: '', prev: '', unit: '$',  notes: '' },
  ],
  balance: [
    { id: 'cash',   metric: 'Cash & equivalents', curr: '', prev: '', unit: '$M', notes: '' },
    { id: 'ta',     metric: 'Total Assets',       curr: '', prev: '', unit: '$M', notes: '' },
    { id: 'ltd',    metric: 'Long-Term Debt',     curr: '', prev: '', unit: '$M', notes: '' },
    { id: 'te',     metric: "Total Equity",      curr: '', prev: '', unit: '$M', notes: '' },
  ],
  cashflow: [
    { id: 'ocf',    metric: 'Operating Cash Flow', curr: '', prev: '', unit: '$M', notes: '' },
    { id: 'capex',  metric: 'CapEx',              curr: '', prev: '', unit: '$M', notes: '' },
    { id: 'fcf',    metric: 'Free Cash Flow',     curr: '', prev: '', unit: '$M', notes: '' },
    { id: 'buyback',metric: 'Buybacks',           curr: '', prev: '', unit: '$M', notes: '' },
  ],
  flags: [],
});

// Document content for the reader — structured by section so we can scroll-spy
const DOCUMENT_SECTIONS = (filing) => {
  const companyName = filing.ticker === 'NVDA' ? 'NVIDIA Corporation'
    : filing.ticker === 'AAPL' ? 'Apple Inc.'
    : filing.ticker + ' Inc.';

  return [
    {
      id: 'cover',
      label: 'Cover Page',
      icon: 'news',
      kind: 'cover',
    },
    {
      id: 'letter',
      label: 'Letter to Shareholders',
      icon: 'news',
      kind: 'narrative',
      title: 'To Our Shareholders',
      readingTime: '4 min',
      body: [
        { type: 'p', text: `Fiscal year ${filing.period} was a defining year for ${companyName}. We delivered record revenue, expanded operating margins to levels rarely seen at our scale, and returned substantial capital to shareholders — all while making the largest investments in our company's history.`, annotations: [
          { text: 'record revenue', kind: 'fact', detail: 'Revenue of $130.5B — up 114% YoY, the largest single-year growth in company history' },
          { text: 'operating margins to levels rarely seen at our scale', kind: 'insight', detail: 'Operating margin reached 62.5%. For context, the S&P 500 average is ~13%, and the next-highest in the sector is ~24%.' },
        ]},
        { type: 'p', text: `Demand for accelerated computing reached a new inflection point. Our data center revenue grew 217% as enterprises across every industry committed to building AI infrastructure. This is not a cyclical bump — it is a generational platform shift, and we are at its center.`, annotations: [
          { text: '217%', kind: 'fact', detail: 'Data center segment specifically — driven by Hopper architecture demand and the early ramp of Blackwell.' },
          { text: 'generational platform shift', kind: 'risk', detail: 'Bold claim. The risk: if AI capex slows for any reason (recession, regulation, efficiency breakthroughs), this growth is highly concentrated and difficult to replace.' },
        ]},
        { type: 'p', text: `We invested $12.9 billion in research and development — more than our entire revenue just four years ago. We strengthened our ecosystem through partnerships with hyperscalers, governments, and the world's most ambitious startups. And we returned $34.5 billion to shareholders through buybacks and dividends.`, annotations: [
          { text: '$12.9 billion in research and development', kind: 'fact', detail: 'R&D as % of revenue: 9.9%. Lower than software peers (15-20%) because revenue is growing faster than R&D.' },
        ]},
        { type: 'p', text: `Looking ahead, we see the opportunity in front of us as larger than at any point in our history. The world has begun a multi-trillion dollar transition from general-purpose computing to accelerated computing and generative AI. We intend to lead it.` },
        { type: 'sig', name: 'Jensen Huang', title: 'Founder & CEO' },
      ],
    },
    {
      id: 'business',
      label: 'Business Overview',
      icon: 'portfolio',
      kind: 'narrative',
      title: 'Item 1. Business',
      readingTime: '8 min',
      body: [
        { type: 'h3', text: 'Overview' },
        { type: 'p', text: `${companyName} is a full-stack accelerated computing platform company. We pioneered accelerated computing to address problems that traditional computers could not. We continue to extend this leadership across compute, networking, and software.`, annotations: [
          { text: 'full-stack', kind: 'insight', detail: 'Plain English: They sell the chips, the networking, the software libraries (CUDA), and the AI development tools. Owning the whole stack creates lock-in.' },
        ]},
        { type: 'h3', text: 'Operating Segments' },
        { type: 'p', text: `We report our financial results in two segments: Compute & Networking and Graphics. The Compute & Networking segment includes our data center compute platforms and end-to-end networking platforms, automotive AI, and Jetson for robotics.` },
        { type: 'p', text: `The Graphics segment includes GeForce GPUs for gaming and creators, the Quadro/RTX GPUs for enterprise workstations, virtual GPU software for cloud-based visual and virtual computing, and Omniverse Enterprise software for building 3D internet applications.` },
        { type: 'h3', text: 'Markets and Customers' },
        { type: 'p', text: `Our customers include the world's largest cloud service providers, consumer internet companies, enterprises across industry verticals, public sector agencies, and millions of developers and researchers.`, annotations: [
          { text: "world's largest cloud service providers", kind: 'risk', detail: 'CONCENTRATION RISK: Roughly 40% of revenue comes from 4 hyperscaler customers (Microsoft, Meta, Amazon, Google). If any one of them pulls back on AI capex, the impact is significant.' },
        ]},
      ],
    },
    {
      id: 'risk',
      label: 'Risk Factors',
      icon: 'alerts',
      kind: 'risk',
      title: 'Item 1A. Risk Factors',
      readingTime: '12 min',
      body: [
        { type: 'p', text: `An investment in our common stock involves a high degree of risk. The following are the most material risks we face. Investors should carefully consider each.` },
        { type: 'risk-item', severity: 'high', title: 'Customer concentration', text: 'A small number of customers comprised a significant portion of our revenue, and the loss of, or a significant reduction in orders from, any of these customers could have a material adverse effect on our business.', flag: 'Top 4 customers = ~40% of revenue' },
        { type: 'risk-item', severity: 'high', title: 'Export controls and geopolitical tensions', text: 'U.S. government export controls have restricted our ability to sell certain products in China and other regions. Further escalation could materially reduce our addressable market.', flag: 'China was ~17% of revenue pre-controls' },
        { type: 'risk-item', severity: 'high', title: 'Supply chain — TSMC dependency', text: 'We rely on third parties to manufacture our products. We are particularly dependent on TSMC for advanced process nodes.', flag: 'Single-supplier risk for leading-edge chips' },
        { type: 'risk-item', severity: 'medium', title: 'Competition', text: 'The markets for our products are intensely competitive and characterized by rapid technological change. We face competition from established companies and well-funded startups developing custom silicon.', flag: 'Hyperscalers building in-house: AWS Trainium, Google TPU, Meta MTIA' },
        { type: 'risk-item', severity: 'medium', title: 'Demand cyclicality', text: 'The semiconductor industry has historically been cyclical. A downturn in AI capex spending would materially impact our results.', flag: 'No historical analog for current data-center buildout' },
        { type: 'risk-item', severity: 'low', title: 'Intellectual property litigation', text: 'We may become subject to claims that our products infringe the intellectual property rights of others.' },
      ],
    },
    {
      id: 'mda',
      label: "MD&A",
      icon: 'chart',
      kind: 'narrative',
      title: "Management's Discussion & Analysis",
      readingTime: '15 min',
      body: [
        { type: 'h3', text: 'Results of Operations' },
        { type: 'p', text: `Revenue for ${filing.period} was $130.5 billion, an increase of 114% from the prior year. The increase was led by data center revenue of $115.2 billion, up 217% year-over-year.`, annotations: [
          { text: '114%', kind: 'fact', detail: 'Three-year revenue CAGR is now 96%. Comparable to no other large-cap company in history.' },
        ]},
        { type: 'p', text: `Gross margin expanded to 75.0% from 72.7% in the prior year, driven by favorable product mix and operating leverage on fixed manufacturing costs.`, annotations: [
          { text: '75.0%', kind: 'insight', detail: 'For comparison: AMD ~50%, Intel ~40%, Broadcom ~63%. NVIDIA gross margins are software-like, not semiconductor-like.' },
        ]},
        { type: 'inline-chart', title: 'Revenue by segment ($ billions)' },
        { type: 'h3', text: 'Liquidity and Capital Resources' },
        { type: 'p', text: `Operating cash flow was $64.1 billion. We invested $3.2 billion in property and equipment and returned $34.5 billion to shareholders.` },
        { type: 'h3', text: 'Recent Developments' },
        { type: 'p', text: `In the fourth quarter, we began shipping our Blackwell architecture in volume. Customer response has exceeded our expectations and Blackwell demand currently outstrips supply.`, annotations: [
          { text: 'demand currently outstrips supply', kind: 'insight', detail: 'Translation: pricing power remains. Margins likely sustain or expand in the near term.' },
        ]},
      ],
    },
    {
      id: 'income',
      label: 'Income Statement',
      icon: 'portfolio',
      kind: 'statement',
      title: 'Consolidated Statements of Income',
      subtitle: '(In millions, except per share data)',
      rows: [
        { label: 'Revenue', curr: 130497, prev: 60922, bold: true },
        { label: 'Cost of revenue', curr: -32500, prev: -16621 },
        { label: 'Gross profit', curr: 97997, prev: 44301, bold: true, highlight: true },
        { label: 'Research and development', curr: -12914, prev: -8675 },
        { label: 'Sales, general and administrative', curr: -3494, prev: -2654 },
        { label: 'Operating income', curr: 81589, prev: 32972, bold: true, highlight: true },
        { label: 'Interest income, net', curr: 1844, prev: 866 },
        { label: 'Income before tax', curr: 83433, prev: 33838 },
        { label: 'Provision for income taxes', curr: -10553, prev: -4078 },
        { label: 'Net income', curr: 72880, prev: 29760, bold: true, highlight: true, accent: true },
        { label: 'Diluted earnings per share', curr: 29.76, prev: 11.93, format: 'eps' },
      ],
    },
    {
      id: 'balance',
      label: 'Balance Sheet',
      icon: 'portfolio',
      kind: 'statement',
      title: 'Consolidated Balance Sheets',
      subtitle: '(In millions)',
      rows: [
        { label: 'Cash and cash equivalents', curr: 8589, prev: 7280 },
        { label: 'Marketable securities', curr: 29898, prev: 18704 },
        { label: 'Accounts receivable, net', curr: 23065, prev: 9999 },
        { label: 'Inventories', curr: 10080, prev: 5282 },
        { label: 'Total current assets', curr: 80126, prev: 44345, bold: true },
        { label: 'Property and equipment, net', curr: 6283, prev: 3914 },
        { label: 'Goodwill', curr: 5188, prev: 4430 },
        { label: 'Other assets', curr: 20004, prev: 13039 },
        { label: 'Total assets', curr: 111601, prev: 65728, bold: true, highlight: true, accent: true },
        { label: 'Accounts payable', curr: 6310, prev: 2699 },
        { label: 'Accrued and other current liabilities', curr: 11737, prev: 7932 },
        { label: 'Long-term debt', curr: 8463, prev: 8460 },
        { label: 'Total liabilities', curr: 32309, prev: 22750, bold: true },
        { label: "Total stockholders' equity", curr: 79292, prev: 42978, bold: true, highlight: true },
      ],
    },
    {
      id: 'cashflow',
      label: 'Cash Flow',
      icon: 'portfolio',
      kind: 'statement',
      title: 'Consolidated Statements of Cash Flows',
      subtitle: '(In millions)',
      rows: [
        { label: 'Net income', curr: 72880, prev: 29760, bold: true },
        { label: 'Depreciation and amortization', curr: 1911, prev: 1508 },
        { label: 'Stock-based compensation', curr: 4737, prev: 3549 },
        { label: 'Changes in working capital', curr: -15439, prev: -6727 },
        { label: 'Net cash from operating activities', curr: 64089, prev: 28090, bold: true, highlight: true, accent: true },
        { label: 'Purchases of property and equipment', curr: -3236, prev: -1069 },
        { label: 'Purchases of marketable securities', curr: -26528, prev: -18211 },
        { label: 'Proceeds from marketable securities', curr: 6343, prev: 9742 },
        { label: 'Net cash used in investing activities', curr: -20421, prev: -10566, bold: true },
        { label: 'Repurchases of common stock', curr: -33706, prev: -9533 },
        { label: 'Dividends paid', curr: -834, prev: -395 },
        { label: 'Net cash used in financing activities', curr: -42359, prev: -13633, bold: true },
        { label: 'Net change in cash', curr: 1309, prev: 4001, bold: true },
      ],
    },
  ];
};

// ─────────────────────────────────────────────────────────────────────────────
// Main reader component

const StatementReader = ({ filing, onClose }) => {
  const sections = React.useMemo(() => DOCUMENT_SECTIONS(filing), [filing]);
  const [activeSection, setActiveSection] = React.useState(sections[0].id);
  const [plainEnglish, setPlainEnglish] = React.useState(false);
  const [showAI, setShowAI] = React.useState(true);
  const [highlights, setHighlights] = React.useState([]);
  const trackerKey = `${READER_STORAGE_KEY}_${filing.id}`;
  const [tracker, setTracker] = React.useState(() => {
    try {
      const stored = localStorage.getItem(trackerKey);
      if (stored) return JSON.parse(stored);
    } catch {}
    return DEFAULT_TRACKER();
  });
  const [selectedAnnotation, setSelectedAnnotation] = React.useState(null);
  const [askInput, setAskInput] = React.useState('');
  const [showOCR, setShowOCR] = React.useState(false);
  const [askMessages, setAskMessages] = React.useState([]);
  const [asking, setAsking] = React.useState(false);
  const [readProgress, setReadProgress] = React.useState(0);

  const scrollRef = React.useRef(null);
  const sectionRefs = React.useRef({});

  // Save tracker to localStorage (and backend when live)
  React.useEffect(() => {
    localStorage.setItem(trackerKey, JSON.stringify(tracker));
    if (window.HelixAPI?.live && typeof filing.id === 'number') {
      clearTimeout(window.__trackerSaveT);
      window.__trackerSaveT = setTimeout(() => {
        window.HelixAPI.saveTracker(filing.id, tracker).catch(() => {});
      }, 800);
    }
  }, [tracker, trackerKey]);

  // Scroll spy
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const scrollTop = el.scrollTop;
      const scrollHeight = el.scrollHeight - el.clientHeight;
      setReadProgress(scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0);
      let current = sections[0].id;
      for (const s of sections) {
        const node = sectionRefs.current[s.id];
        if (node && node.offsetTop - 100 <= scrollTop) {
          current = s.id;
        }
      }
      setActiveSection(current);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [sections]);

  const jumpToSection = (id) => {
    const node = sectionRefs.current[id];
    if (node && scrollRef.current) {
      scrollRef.current.scrollTo({ top: node.offsetTop - 16, behavior: 'smooth' });
    }
  };

  const addHighlight = () => {};
  const removeHighlight = () => {};

  // Escape closes the reader
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const askQuestion = async (q) => {
    const text = (q || askInput).trim();
    if (!text || asking) return;
    setAskInput('');
    setAskMessages(m => [...m, { role: 'user', content: text }]);
    setAsking(true);
    try {
      const prompt = `You are an expert financial analyst helping a reader understand the ${filing.type} filing for ${filing.ticker} (${filing.period}). The reader is currently viewing the "${sections.find(s => s.id === activeSection)?.label}" section. Answer their question concisely (2-4 short paragraphs OR a tight bulleted list). Use **bold** for key numbers and *italic* for ticker symbols. Be direct. No disclaimers.\n\nQuestion: ${text}`;
      // Backend path: if the filing exists server-side, use the filing-aware RAG endpoint
      let reply;
      if (window.HelixAPI?.live && typeof filing.id === 'number') {
        try {
          const out = await window.HelixAPI.askFiling(filing.id, text, sections.find(s => s.id === activeSection)?.label);
          reply = out.answer;
        } catch { /* fall through */ }
      }
      if (!reply) reply = await window.HelixAPI.complete(prompt, { page: 'filings' });
      setAskMessages(m => [...m, { role: 'assistant', content: reply }]);
    } catch (e) {
      setAskMessages(m => [...m, { role: 'assistant', content: 'Connection error. Try again.' }]);
    }
    setAsking(false);
  };

  const currentSection = sections.find(s => s.id === activeSection);

  return (
    <div style={readerStyles.overlay}>
      <div style={readerStyles.shell}>
        {/* Header */}
        <header style={readerStyles.header}>
          <div className="row" style={{ gap: 12, flex: 1, minWidth: 0 }}>
            <button onClick={onClose} style={readerStyles.closeBtn}>
              <Icon name="close" size={14} /> Close
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <div style={readerStyles.pdfBadge}>PDF</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{filing.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)' }}>
                  {filing.ticker} · {filing.type} · {filing.period} · {filing.pages} pp
                </div>
              </div>
            </div>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <button
              onClick={() => setShowOCR(true)}
              style={{ ...readerStyles.toggle, background: 'var(--accent)', color: 'white', borderColor: 'var(--accent)' }}
              title="Parse data from PDF with OCR"
            >
              <Icon name="search" size={12} /> OCR Parse
            </button>
            <button
              onClick={() => setPlainEnglish(!plainEnglish)}
              style={{ ...readerStyles.toggle, ...(plainEnglish ? readerStyles.toggleOn : {}) }}
              title="Translate jargon to plain English"
            >
              <Icon name="sparkle" size={12} /> Plain English
            </button>
            <button
              onClick={() => setShowAI(!showAI)}
              style={{ ...readerStyles.toggle, ...(showAI ? readerStyles.toggleOn : {}) }}
            >
              <Icon name="sparkle" size={12} /> AI Companion
            </button>
            <button style={readerStyles.toggle} title="Download original">
              <Icon name="download" size={12} />
            </button>
          </div>
        </header>

        {/* Progress bar */}
        <div style={readerStyles.progressTrack}>
          <div style={{ ...readerStyles.progressFill, width: `${readProgress}%` }} />
        </div>

        {/* Body grid */}
        <div style={{
          flex: 1, minHeight: 0, display: 'grid',
          gridTemplateColumns: showAI ? '380px 1fr 340px' : '380px 1fr',
          background: 'var(--bg-sunken)',
        }}>
          {/* Left rail: Data Tracker */}
          <aside style={readerStyles.outlinePanel}>
            <DataTracker
              tracker={tracker}
              setTracker={setTracker}
              filing={filing}
              currentSection={currentSection}
            />
          </aside>

          {/* Center: Document */}
          <main ref={scrollRef} style={readerStyles.docScroll}>
            <article style={readerStyles.page}>
              {sections.map(s => (
                <section
                  key={s.id}
                  ref={el => sectionRefs.current[s.id] = el}
                  style={{ marginBottom: 64, scrollMarginTop: 16 }}
                >
                  <SectionContent
                    section={s}
                    filing={filing}
                    plainEnglish={plainEnglish}
                    onAnnotationClick={setSelectedAnnotation}
                    onHighlight={addHighlight}
                  />
                </section>
              ))}
            </article>
          </main>

          {/* Right rail: AI Companion */}
          {showAI && (
            <aside style={readerStyles.aiPanel}>
              <AICompanion
                section={currentSection}
                filing={filing}
                selectedAnnotation={selectedAnnotation}
                onClearAnnotation={() => setSelectedAnnotation(null)}
                askInput={askInput}
                setAskInput={setAskInput}
                askMessages={askMessages}
                asking={asking}
                onAsk={askQuestion}
              />
            </aside>
          )}
        </div>

        {/* OCR Dialog */}
        {showOCR && (
          <OCRDialog
            filing={filing}
            onClose={() => setShowOCR(false)}
            onImport={(rows) => {
              setTracker(t => {
                const next = { ...t };
                for (const sec of ['income', 'balance', 'cashflow']) {
                  next[sec] = (t[sec] || []).map(r => {
                    const match = rows.find(x => x.section === sec && x.id === r.id);
                    if (match) return { ...r, curr: match.curr, prev: match.prev };
                    return r;
                  });
                  for (const x of rows.filter(x => x.section === sec)) {
                    if (!next[sec].find(r => r.id === x.id)) {
                      next[sec].push({ id: x.id, metric: x.metric, curr: x.curr, prev: x.prev, unit: '$M', notes: `OCR p.${x.page} · ${x.confidence}%` });
                    }
                  }
                }
                return next;
              });
            }}
          />
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Section rendering

const SectionContent = ({ section, filing, plainEnglish, onAnnotationClick, onHighlight }) => {
  if (section.kind === 'cover') {
    return <CoverPage filing={filing} />;
  }
  if (section.kind === 'statement') {
    return <StatementSection section={section} onHighlight={onHighlight} />;
  }
  if (section.kind === 'risk') {
    return <RiskSection section={section} />;
  }
  return <NarrativeSection section={section} plainEnglish={plainEnglish} onAnnotationClick={onAnnotationClick} onHighlight={onHighlight} />;
};

const CoverPage = ({ filing }) => {
  const company = filing.ticker === 'NVDA' ? 'NVIDIA CORPORATION' : filing.ticker === 'AAPL' ? 'APPLE INC.' : filing.ticker + ' INC.';
  return (
    <div style={readerStyles.cover}>
      <div style={readerStyles.coverSeal}>
        UNITED STATES<br />
        SECURITIES AND EXCHANGE COMMISSION<br />
        <span style={{ fontWeight: 400, fontSize: 11, letterSpacing: 0 }}>Washington, D.C. 20549</span>
      </div>
      <div style={readerStyles.coverFormBox}>FORM {filing.type}</div>
      <div style={{ marginTop: 24, fontSize: 12, fontWeight: 600, letterSpacing: '0.04em' }}>
        {filing.type === '10-K' ? 'ANNUAL REPORT' : filing.type === '10-Q' ? 'QUARTERLY REPORT' : 'CURRENT REPORT'} PURSUANT TO SECTION 13 OR 15(d)<br />
        OF THE SECURITIES EXCHANGE ACT OF 1934
      </div>
      <div style={{ marginTop: 24, fontSize: 12 }}>For the period ended <strong>{filing.period}</strong></div>
      <div style={readerStyles.coverCompany}>{company}</div>
      <div style={{ fontStyle: 'italic', color: '#666', fontSize: 11 }}>(Exact name of registrant as specified in its charter)</div>
      <div style={readerStyles.coverGrid}>
        <div>
          <strong style={{ fontSize: 12 }}>Delaware</strong>
          <div style={{ fontSize: 10, color: '#666', fontStyle: 'italic' }}>State of incorporation</div>
        </div>
        <div>
          <strong style={{ fontSize: 12 }}>94-1234567</strong>
          <div style={{ fontSize: 10, color: '#666', fontStyle: 'italic' }}>IRS Employer ID</div>
        </div>
      </div>
    </div>
  );
};

const NarrativeSection = ({ section, plainEnglish, onAnnotationClick, onHighlight }) => {
  return (
    <>
      <SectionHeader section={section} />
      {section.body.map((block, i) => {
        if (block.type === 'h3') {
          return <h3 key={i} style={readerStyles.h3}>{block.text}</h3>;
        }
        if (block.type === 'sig') {
          return (
            <div key={i} style={readerStyles.signature}>
              <div style={{ fontFamily: 'cursive', fontSize: 24, fontStyle: 'italic', color: '#1a1a1a' }}>{block.name}</div>
              <div style={{ borderTop: '1px solid #999', marginTop: 4, paddingTop: 4, fontSize: 11, color: '#555' }}>
                {block.name}<br />{block.title}
              </div>
            </div>
          );
        }
        if (block.type === 'inline-chart') {
          return <InlineChart key={i} title={block.title} />;
        }
        // Paragraph with annotations
        return (
          <AnnotatedParagraph
            key={i}
            text={block.text}
            annotations={block.annotations}
            plainEnglish={plainEnglish}
            onAnnotationClick={onAnnotationClick}
            onHighlight={onHighlight}
          />
        );
      })}
    </>
  );
};

const SectionHeader = ({ section }) => (
  <div style={{ marginBottom: 20, paddingBottom: 12, borderBottom: '2px solid #1a1a1a' }}>
    <div style={{ fontSize: 10, fontWeight: 600, color: '#999', textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
      {section.label}
    </div>
    <h2 style={readerStyles.h2}>{section.title}</h2>
    {section.subtitle && (
      <div style={{ fontSize: 11, color: '#666', fontStyle: 'italic', marginTop: 4 }}>{section.subtitle}</div>
    )}
  </div>
);

// Paragraph with inline annotation hotspots
const AnnotatedParagraph = ({ text, annotations, plainEnglish, onAnnotationClick, onHighlight }) => {
  const ref = React.useRef(null);

  const handleMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const selText = sel.toString().trim();
    if (selText.length > 5 && ref.current && ref.current.contains(sel.anchorNode)) {
      // Could open a context menu — for now, just highlight on triple-click etc.
    }
  };

  // Render text with annotations as inline highlighted spans
  let segments = [{ text, kind: 'plain' }];
  if (annotations) {
    annotations.forEach(ann => {
      const next = [];
      segments.forEach(seg => {
        if (seg.kind !== 'plain') { next.push(seg); return; }
        const idx = seg.text.indexOf(ann.text);
        if (idx === -1) { next.push(seg); return; }
        if (idx > 0) next.push({ text: seg.text.slice(0, idx), kind: 'plain' });
        next.push({ text: ann.text, kind: 'annotation', ann });
        if (idx + ann.text.length < seg.text.length) {
          next.push({ text: seg.text.slice(idx + ann.text.length), kind: 'plain' });
        }
      });
      segments = next;
    });
  }

  return (
    <p ref={ref} style={readerStyles.p} onMouseUp={handleMouseUp}>
      {segments.map((seg, i) => {
        if (seg.kind === 'annotation') {
          return (
            <Annotation key={i} ann={seg.ann} onClick={() => onAnnotationClick(seg.ann)} plainEnglish={plainEnglish} />
          );
        }
        return <span key={i}>{seg.text}</span>;
      })}
      {annotations && annotations.length > 0 && (
        <button
          onClick={() => onHighlight(text.slice(0, 120) + (text.length > 120 ? '…' : ''), null)}
          style={readerStyles.highlightBtn}
          title="Save to highlights"
        >
          <Icon name="star" size={11} />
        </button>
      )}
    </p>
  );
};

const Annotation = ({ ann, onClick, plainEnglish }) => {
  const colors = {
    fact: { bg: '#FEF3C7', under: '#F59E0B', icon: '◆' },
    insight: { bg: '#DBEAFE', under: '#3B82F6', icon: '●' },
    risk: { bg: '#FEE2E2', under: '#EF4444', icon: '▲' },
  };
  const c = colors[ann.kind] || colors.fact;

  // In plain-English mode, show the explanation inline
  if (plainEnglish) {
    return (
      <span style={{
        background: c.bg, padding: '1px 4px', borderRadius: 2,
        borderBottom: `2px solid ${c.under}`, position: 'relative',
      }} onClick={onClick}>
        {ann.text}
        <span style={{
          display: 'block', background: '#fff', border: `1px solid ${c.under}`,
          padding: '4px 8px', borderRadius: 4, fontSize: 11, color: '#333',
          marginTop: 2, fontStyle: 'italic',
        }}>
          <span style={{ color: c.under, fontWeight: 700 }}>{c.icon}</span> {ann.detail}
        </span>
      </span>
    );
  }

  return (
    <span
      onClick={onClick}
      style={{
        background: c.bg, padding: '0 2px', borderBottom: `2px solid ${c.under}`,
        cursor: 'pointer', borderRadius: 1,
      }}
    >
      {ann.text}
      <sup style={{ color: c.under, fontWeight: 700, fontSize: 9, marginLeft: 2, fontFamily: 'var(--font-mono)' }}>{c.icon}</sup>
    </span>
  );
};

// Risk Factors section — each risk as a card with severity badge
const RiskSection = ({ section }) => {
  return (
    <>
      <SectionHeader section={section} />
      <p style={readerStyles.p}>{section.body[0].text}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
        {section.body.filter(b => b.type === 'risk-item').map((r, i) => (
          <div key={i} style={readerStyles.riskCard}>
            <div style={readerStyles.riskHeader}>
              <span style={{
                ...readerStyles.severityBadge,
                background: r.severity === 'high' ? '#FEE2E2' : r.severity === 'medium' ? '#FEF3C7' : '#E0E7FF',
                color: r.severity === 'high' ? '#991B1B' : r.severity === 'medium' ? '#92400E' : '#3730A3',
              }}>
                {r.severity.toUpperCase()}
              </span>
              <h4 style={readerStyles.riskTitle}>{r.title}</h4>
            </div>
            <p style={{ ...readerStyles.p, marginTop: 6 }}>{r.text}</p>
            {r.flag && (
              <div style={readerStyles.riskFlag}>
                <Icon name="alerts" size={11} /> <strong>Flag:</strong> {r.flag}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
};

// Statement section — beautifully typeset table with inline data viz
const StatementSection = ({ section, onHighlight }) => {
  const max = Math.max(...section.rows.map(r => Math.abs(r.curr)));

  return (
    <>
      <SectionHeader section={section} />
      <table style={readerStyles.statementTable}>
        <thead>
          <tr>
            <th style={readerStyles.stTh}>Line item</th>
            <th style={{ ...readerStyles.stTh, textAlign: 'right' }}>Current</th>
            <th style={{ ...readerStyles.stTh, textAlign: 'right' }}>Prior</th>
            <th style={{ ...readerStyles.stTh, textAlign: 'right' }}>YoY</th>
            <th style={{ ...readerStyles.stTh, width: 100 }}>Relative</th>
          </tr>
        </thead>
        <tbody>
          {section.rows.map((r, i) => {
            const yoy = r.prev ? ((r.curr - r.prev) / Math.abs(r.prev)) * 100 : null;
            const bar = (Math.abs(r.curr) / max) * 100;
            return (
              <tr key={i} style={{ background: r.highlight ? '#FFF7ED' : 'transparent' }}>
                <td style={{
                  ...readerStyles.stTd,
                  fontWeight: r.bold ? 700 : 400,
                  color: r.accent ? '#C2410C' : (r.bold ? '#1a1a1a' : '#444'),
                  paddingLeft: r.bold ? 8 : 24,
                }}>
                  {r.label}
                </td>
                <td style={{ ...readerStyles.stTd, textAlign: 'right', fontWeight: r.bold ? 700 : 500 }}>
                  {fmtStatementValue(r.curr, r.format)}
                </td>
                <td style={{ ...readerStyles.stTd, textAlign: 'right', color: '#888' }}>
                  {fmtStatementValue(r.prev, r.format)}
                </td>
                <td style={{ ...readerStyles.stTd, textAlign: 'right', fontWeight: 600, color: yoy >= 0 ? '#15803D' : '#B91C1C' }}>
                  {yoy !== null ? `${yoy >= 0 ? '+' : ''}${yoy.toFixed(0)}%` : ''}
                </td>
                <td style={readerStyles.stTd}>
                  <div style={{ height: 6, background: '#F4F3EE', borderRadius: 3, position: 'relative' }}>
                    <div style={{
                      height: '100%',
                      width: `${bar}%`,
                      background: r.curr < 0 ? '#B91C1C' : (r.accent ? '#C2410C' : '#15803D'),
                      borderRadius: 3,
                      opacity: r.bold ? 1 : 0.5,
                    }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={readerStyles.statementNote}>
        The accompanying notes are an integral part of these consolidated financial statements.
      </div>
    </>
  );
};

const fmtStatementValue = (v, format) => {
  if (v === null || v === undefined) return '—';
  if (format === 'eps') return v < 0 ? `(${Math.abs(v).toFixed(2)})` : `$${v.toFixed(2)}`;
  const abs = Math.abs(v);
  const str = abs.toLocaleString('en-US');
  return v < 0 ? `(${str})` : str;
};

// Inline mini chart in MD&A
const InlineChart = ({ title }) => {
  const data = [
    { label: 'Data Center', value: 115.2, color: '#C2410C' },
    { label: 'Gaming', value: 11.4, color: '#9A3412' },
    { label: 'Pro Viz', value: 1.9, color: '#A16207' },
    { label: 'Auto', value: 1.7, color: '#7C2D12' },
    { label: 'OEM', value: 0.3, color: '#451A03' },
  ];
  const max = Math.max(...data.map(d => d.value));
  return (
    <div style={readerStyles.inlineChart}>
      <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 12, fontFamily: 'var(--font-mono)' }}>
        ◆ Embedded by AI · {title}
      </div>
      {data.map(d => (
        <div key={d.label} style={{ display: 'grid', gridTemplateColumns: '100px 1fr 80px', gap: 12, alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontSize: 12, color: '#444' }}>{d.label}</div>
          <div style={{ height: 14, background: '#F4F3EE', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(d.value / max) * 100}%`, background: d.color, transition: 'width 600ms ease' }} />
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, textAlign: 'right' }}>${d.value.toFixed(1)}B</div>
        </div>
      ))}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// AI Companion right rail

const AICompanion = ({ section, filing, selectedAnnotation, onClearAnnotation, askInput, setAskInput, askMessages, asking, onAsk }) => {
  return (
    <div style={readerStyles.aiInner}>
      <div style={readerStyles.aiHeader}>
        <span style={readerStyles.aiDot} />
        <span style={{ fontFamily: 'var(--font-serif)', fontWeight: 600 }}>Reading Companion</span>
      </div>

      {/* Context card — updates based on visible section */}
      <div style={readerStyles.aiSection}>
        <div style={readerStyles.aiSectionLabel}>Currently reading</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{section?.label}</div>
        {section?.readingTime && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{section.readingTime} remaining</div>}
        <SectionInsight section={section} filing={filing} />
      </div>

      {/* Selected annotation detail */}
      {selectedAnnotation && (
        <div style={{ ...readerStyles.aiSection, background: 'var(--accent-bg)', border: '1px solid var(--accent-soft)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {selectedAnnotation.kind === 'fact' ? '◆ Fact' : selectedAnnotation.kind === 'insight' ? '● Insight' : '▲ Risk'}
            </span>
            <button onClick={onClearAnnotation} style={readerStyles.tinyBtn}>
              <Icon name="close" size={10} />
            </button>
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, fontStyle: 'italic' }}>"{selectedAnnotation.text}"</div>
          <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.55 }}>{selectedAnnotation.detail}</div>
        </div>
      )}

      {/* Ask anything */}
      <div style={readerStyles.aiSection}>
        <div style={readerStyles.aiSectionLabel}>Ask about this filing</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 240, overflowY: 'auto', marginBottom: 8 }}>
          {askMessages.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-subtle)', fontStyle: 'italic' }}>
              Try: "What's the biggest risk here?" or "Compare margins to last year."
            </div>
          )}
          {askMessages.map((m, i) => (
            <div key={i} style={{
              fontSize: 12, lineHeight: 1.5,
              padding: '8px 10px', borderRadius: 6,
              background: m.role === 'user' ? 'var(--accent-bg)' : 'var(--bg-elev)',
              border: '1px solid var(--border)',
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '92%',
            }}>
              {m.role === 'assistant' ? <FormattedText text={m.content} /> : m.content}
            </div>
          ))}
          {asking && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Reading filing…
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <textarea
            value={askInput}
            onChange={e => setAskInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onAsk(); } }}
            placeholder="Ask anything..."
            rows={2}
            style={readerStyles.askInput}
          />
          <button onClick={() => onAsk()} disabled={asking || !askInput.trim()} style={readerStyles.askBtn}>
            <Icon name="send" size={12} />
          </button>
        </div>
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {['Summarize this section', 'What changed YoY?', 'Red flags?'].map(s => (
            <button key={s} onClick={() => onAsk(s)} style={readerStyles.suggestChip}>{s}</button>
          ))}
        </div>
      </div>
    </div>
  );
};

const SectionInsight = ({ section, filing }) => {
  const map = {
    cover: { label: 'About this filing', body: `${filing.type}s are filed annually with the SEC. They contain the most comprehensive view of a company. Plan ~45 minutes for a thorough read.` },
    letter: { label: 'How to read this', body: 'CEO letters often signal what management wants you to focus on — and what they hope you miss. Watch for what is NOT mentioned.' },
    business: { label: 'Key questions', body: 'What does the company actually do? How do they make money? What is their moat? Pay attention to segment breakdowns.' },
    risk: { label: 'Read carefully', body: 'Risk Factors are often dismissed as boilerplate, but specific, customer-named risks (vs. generic ones) signal real concerns. ' + filing.ticker + ' has 4 high-severity flags.' },
    mda: { label: 'The narrative', body: "MD&A is where management tells their story. Cross-check claims against the actual numbers in the next sections." },
    income: { label: 'What to look for', body: 'Revenue growth vs. cost growth = operating leverage. Margin trends matter more than absolute levels.' },
    balance: { label: 'What to look for', body: 'Current ratio above 2 = healthy liquidity. Debt-to-equity below 0.5 = conservative balance sheet.' },
    cashflow: { label: 'The truth meter', body: 'Operating cash flow should track net income. Big divergence = accounting quality concerns.' },
  };
  const insight = map[section?.id];
  if (!insight) return null;
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
        {insight.label}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.55 }}>{insight.body}</div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Data Tracker — capture key financial data, ratios, and flags while reading

const TRACKER_SECTIONS = [
  { key: 'income',   label: 'Income Statement' },
  { key: 'balance',  label: 'Balance Sheet' },
  { key: 'cashflow', label: 'Cash Flow' },
];

const parseValue = (s) => {
  if (!s) return null;
  const str = String(s).trim().replace(/,/g, '').replace(/\$/g, '');
  const m = str.match(/^(-?\d+\.?\d*)\s*([BMK%])?$/i);
  if (!m) return null;
  let v = parseFloat(m[1]);
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'B') v *= 1000;
  else if (suffix === 'K') v /= 1000;
  return v;
};

const yoyPct = (curr, prev) => {
  const c = parseValue(curr);
  const p = parseValue(prev);
  if (c === null || p === null || p === 0) return null;
  return ((c - p) / Math.abs(p)) * 100;
};

const DataTracker = ({ tracker, setTracker, filing, currentSection }) => {
  const [activeTab, setActiveTab] = React.useState('income');
  const [newFlag, setNewFlag] = React.useState('');
  const [saveState, setSaveState] = React.useState('idle'); // idle | saving | saved | error
  const [newFlagKind, setNewFlagKind] = React.useState('risk');

  // Auto-focus tab matching the section being read
  React.useEffect(() => {
    if (!currentSection) return;
    const map = { income: 'income', balance: 'balance', cashflow: 'cashflow' };
    if (map[currentSection.id]) setActiveTab(map[currentSection.id]);
  }, [currentSection]);

  const updateRow = (section, id, field, value) => {
    setTracker(t => ({
      ...t,
      [section]: t[section].map(r => r.id === id ? { ...r, [field]: value } : r),
    }));
  };

  const addRow = (section) => {
    setTracker(t => ({
      ...t,
      [section]: [...t[section], { id: 'r_' + Date.now(), metric: '', curr: '', prev: '', unit: '$M', notes: '' }],
    }));
  };

  const removeRow = (section, id) => {
    setTracker(t => ({ ...t, [section]: t[section].filter(r => r.id !== id) }));
  };

  const addFlag = () => {
    const text = newFlag.trim();
    if (!text) return;
    setTracker(t => ({
      ...t,
      flags: [{ id: 'f_' + Date.now(), kind: newFlagKind, text, ts: Date.now() }, ...(t.flags || [])],
    }));
    setNewFlag('');
  };

  const removeFlag = (id) => {
    setTracker(t => ({ ...t, flags: (t.flags || []).filter(f => f.id !== id) }));
  };

  const autoFill = () => {
    const dataMap = {
      income: { Revenue: ['130497','60922'], 'Gross Profit': ['97997','44301'], 'Operating Income': ['81589','32972'], 'Net Income': ['72880','29760'], 'EPS (diluted)': ['29.76','11.93'] },
      balance: { 'Cash & equivalents': ['8589','7280'], 'Total Assets': ['111601','65728'], 'Long-Term Debt': ['8463','8460'], 'Total Equity': ['79292','42978'] },
      cashflow: { 'Operating Cash Flow': ['64089','28090'], 'CapEx': ['-3236','-1069'], 'Free Cash Flow': ['60853','27021'], 'Buybacks': ['-33706','-9533'] },
    };
    setTracker(t => {
      const next = { ...t };
      for (const [section, mapping] of Object.entries(dataMap)) {
        next[section] = t[section].map(r => {
          const vals = mapping[r.metric];
          if (vals && !r.curr) return { ...r, curr: vals[0], prev: vals[1] };
          return r;
        });
      }
      return next;
    });
  };

  const exportCSV = () => {
    const lines = [['Section', 'Metric', 'Current', 'Prior', 'YoY %', 'Notes'].join(',')];
    for (const sec of TRACKER_SECTIONS) {
      for (const r of (tracker[sec.key] || [])) {
        if (!r.metric) continue;
        const yoy = yoyPct(r.curr, r.prev);
        lines.push([sec.label, r.metric, r.curr, r.prev, yoy !== null ? yoy.toFixed(1) + '%' : '', r.notes].map(v => `"${(v || '').toString().replace(/"/g, '""')}"`).join(','));
      }
    }
    if (tracker.flags?.length) {
      lines.push('');
      lines.push(['Flag', 'Note'].join(','));
      tracker.flags.forEach(f => lines.push([f.kind, f.text].map(v => `"${v.replace(/"/g, '""')}"`).join(',')));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${filing.ticker}_${filing.period.replace(/\s+/g, '_')}_tracker.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const reset = async () => {
    if (await window.askConfirm({ title: 'Reset tracker', message: 'Clear all tracked data for this filing?', confirmText: 'Reset', danger: true })) setTracker(DEFAULT_TRACKER());
  };

  const saveToDatabase = async () => {
    setSaveState('saving');
    try {
      if (window.HelixAPI?.live && typeof filing.id === 'number') {
        await window.HelixAPI.saveTracker(filing.id, tracker);
      } else {
        // No backend reachable — persist locally so nothing is lost.
        localStorage.setItem(`helix_reader_tracker_v1_${filing.id}`, JSON.stringify(tracker));
        await new Promise(r => setTimeout(r, 400));
      }
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch (e) {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 3000);
    }
  };

  const computedRatios = React.useMemo(() => {
    const get = (sec, id) => {
      const r = tracker[sec]?.find(x => x.id === id);
      return r ? { curr: parseValue(r.curr), prev: parseValue(r.prev) } : { curr: null, prev: null };
    };
    const rev = get('income', 'rev'), gp = get('income', 'gp'), oi = get('income', 'oi'), ni = get('income', 'ni');
    const ltd = get('balance', 'ltd'), te = get('balance', 'te');
    const ratios = [];
    if (rev.curr && gp.curr) ratios.push({ label: 'Gross Margin', curr: (gp.curr/rev.curr)*100, prev: (rev.prev && gp.prev) ? (gp.prev/rev.prev)*100 : null, unit: '%' });
    if (rev.curr && oi.curr) ratios.push({ label: 'Operating Margin', curr: (oi.curr/rev.curr)*100, prev: (rev.prev && oi.prev) ? (oi.prev/rev.prev)*100 : null, unit: '%' });
    if (rev.curr && ni.curr) ratios.push({ label: 'Net Margin', curr: (ni.curr/rev.curr)*100, prev: (rev.prev && ni.prev) ? (ni.prev/rev.prev)*100 : null, unit: '%' });
    if (te.curr && ni.curr) ratios.push({ label: 'ROE', curr: (ni.curr/te.curr)*100, prev: (te.prev && ni.prev) ? (ni.prev/te.prev)*100 : null, unit: '%' });
    if (te.curr && ltd.curr) ratios.push({ label: 'Debt / Equity', curr: ltd.curr/te.curr, prev: (te.prev && ltd.prev) ? ltd.prev/te.prev : null, unit: '×' });
    return ratios;
  }, [tracker]);

  const fillCount = React.useMemo(() => {
    let total = 0, filled = 0;
    for (const sec of TRACKER_SECTIONS) {
      for (const r of (tracker[sec.key] || [])) {
        total++;
        if (r.curr) filled++;
      }
    }
    return { total, filled };
  }, [tracker]);

  return (
    <div style={trackerStyles.root} className="reader-tracker">
      <div style={trackerStyles.header}>
        <div>
          <div style={trackerStyles.title}>Data Tracker</div>
          <div style={trackerStyles.subtitle}>
            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{fillCount.filled}</span>
            <span style={{ color: 'var(--text-subtle)' }}> of {fillCount.total} metrics filled</span>
          </div>
        </div>
        <button onClick={autoFill} style={trackerStyles.autofillBtn} title="Pre-fill from filing">
          <Icon name="sparkle" size={11} /> Auto-fill
        </button>
      </div>

      <div style={trackerStyles.tabs}>
        {TRACKER_SECTIONS.map(s => (
          <button key={s.key} onClick={() => setActiveTab(s.key)}
            style={{ ...trackerStyles.tab, ...(activeTab === s.key ? trackerStyles.tabActive : {}) }}>
            {s.label}
          </button>
        ))}
        <button onClick={() => setActiveTab('flags')}
          style={{ ...trackerStyles.tab, ...(activeTab === 'flags' ? trackerStyles.tabActive : {}) }}>
          Flags
          {tracker.flags?.length > 0 && <span style={trackerStyles.tabBadge}>{tracker.flags.length}</span>}
        </button>
      </div>

      <div style={trackerStyles.content}>
        {activeTab !== 'flags' ? (
          <>
            <div style={trackerStyles.tableHeader}>
              <div style={{ flex: 1 }}>Metric</div>
              <div style={trackerStyles.valCol}>Current</div>
              <div style={trackerStyles.valCol}>Prior</div>
              <div style={trackerStyles.yoyCol}>YoY</div>
              <div style={{ width: 18 }} />
            </div>
            {(tracker[activeTab] || []).map(row => (
              <TrackerRow key={row.id} row={row}
                onChange={(field, value) => updateRow(activeTab, row.id, field, value)}
                onRemove={() => removeRow(activeTab, row.id)} />
            ))}
            <button onClick={() => addRow(activeTab)} style={trackerStyles.addRowBtn}>
              <Icon name="plus" size={11} /> Add metric
            </button>

            {computedRatios.length > 0 && activeTab === 'income' && (
              <>
                <div style={trackerStyles.sectionLabel}>Auto-computed ratios</div>
                <div style={trackerStyles.ratiosGrid}>
                  {computedRatios.map((r, i) => {
                    const change = r.prev !== null ? r.curr - r.prev : null;
                    return (
                      <div key={i} style={trackerStyles.ratioCard}>
                        <div style={trackerStyles.ratioLabel}>{r.label}</div>
                        <div style={trackerStyles.ratioValue}>
                          {r.curr.toFixed(r.unit === '×' ? 2 : 1)}{r.unit}
                        </div>
                        {change !== null && (
                          <div style={{ fontSize: 10, color: change >= 0 ? 'var(--pos)' : 'var(--neg)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                            {change >= 0 ? '+' : ''}{change.toFixed(r.unit === '×' ? 2 : 1)}{r.unit === '%' ? 'pp' : r.unit}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        ) : (
          <FlagsTab flags={tracker.flags || []}
            newFlag={newFlag} setNewFlag={setNewFlag}
            newFlagKind={newFlagKind} setNewFlagKind={setNewFlagKind}
            onAdd={addFlag} onRemove={removeFlag} />
        )}
      </div>

      <div style={trackerStyles.footer}>
        <button onClick={reset} style={trackerStyles.resetBtn}>Reset</button>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={exportCSV} style={trackerStyles.exportBtn}>
            <Icon name="download" size={11} /> CSV
          </button>
          <button onClick={saveToDatabase} disabled={saveState === 'saving'} style={{
            ...trackerStyles.exportBtn,
            background: saveState === 'saved' ? 'var(--pos)' : saveState === 'error' ? 'var(--neg)' : 'var(--accent)',
            color: 'white',
          }}>
            <Icon name={saveState === 'saved' ? 'starFill' : 'portfolio'} size={11} />
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Retry' : 'Save to database'}
          </button>
        </div>
      </div>
      {(window.HelixAPI && !window.HelixAPI.live) && (
        <div style={{ padding: '0 12px 10px', fontSize: 10, color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)', textAlign: 'right' }}>
          Backend offline — saved locally
        </div>
      )}
    </div>
  );
};

const TrackerRow = ({ row, onChange, onRemove }) => {
  const yoy = yoyPct(row.curr, row.prev);
  const [showNotes, setShowNotes] = React.useState(!!row.notes);

  return (
    <div style={trackerStyles.row} className="row">
      <div style={trackerStyles.rowMain}>
        <input value={row.metric}
          onChange={e => onChange('metric', e.target.value)}
          placeholder="Metric name"
          style={{ ...trackerStyles.input, flex: 1, fontWeight: 500 }} />
        <input value={row.curr}
          onChange={e => onChange('curr', e.target.value)}
          placeholder="—"
          style={{ ...trackerStyles.input, width: 60, textAlign: 'right', fontFamily: 'var(--font-mono)' }} />
        <input value={row.prev}
          onChange={e => onChange('prev', e.target.value)}
          placeholder="—"
          style={{ ...trackerStyles.input, width: 60, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }} />
        <div style={{
          ...trackerStyles.yoyCol,
          fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600,
          color: yoy === null ? 'var(--text-subtle)' : yoy >= 0 ? 'var(--pos)' : 'var(--neg)',
        }}>
          {yoy !== null ? `${yoy >= 0 ? '+' : ''}${yoy.toFixed(0)}%` : '—'}
        </div>
        <button onClick={onRemove} style={trackerStyles.rowAction} title="Remove">
          <Icon name="close" size={10} />
        </button>
      </div>
      {!showNotes ? (
        <button onClick={() => setShowNotes(true)} style={trackerStyles.notesToggle}>+ note</button>
      ) : (
        <input value={row.notes}
          onChange={e => onChange('notes', e.target.value)}
          placeholder="Add a note about this metric..."
          style={{ ...trackerStyles.input, width: '100%', marginTop: 4, fontSize: 11, fontStyle: 'italic' }} />
      )}
    </div>
  );
};

const FlagsTab = ({ flags, newFlag, setNewFlag, newFlagKind, setNewFlagKind, onAdd, onRemove }) => {
  const kinds = [
    { id: 'strength',    label: 'Strength', color: '#15803D', bg: '#F0FDF4', icon: '↑' },
    { id: 'risk',        label: 'Risk',     color: '#B91C1C', bg: '#FEF2F2', icon: '▲' },
    { id: 'question',    label: 'Question', color: '#A16207', bg: '#FEFCE8', icon: '?' },
    { id: 'investigate', label: 'Look up',  color: '#1D4ED8', bg: '#EFF6FF', icon: '◎' },
  ];

  return (
    <>
      <div style={trackerStyles.flagInputWrap}>
        <div style={trackerStyles.flagKindPicker}>
          {kinds.map(k => (
            <button key={k.id} onClick={() => setNewFlagKind(k.id)}
              style={{
                ...trackerStyles.flagKind,
                background: newFlagKind === k.id ? k.bg : 'transparent',
                color: newFlagKind === k.id ? k.color : 'var(--text-muted)',
                borderColor: newFlagKind === k.id ? k.color : 'var(--border)',
              }} title={k.label}>
              <span style={{ fontWeight: 700 }}>{k.icon}</span> {k.label}
            </button>
          ))}
        </div>
        <textarea value={newFlag}
          onChange={e => setNewFlag(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onAdd(); }}
          placeholder="e.g. Customer concentration ~40% of revenue"
          rows={2}
          style={{ ...trackerStyles.input, width: '100%', resize: 'none', marginTop: 6 }} />
        <button onClick={onAdd} disabled={!newFlag.trim()} style={trackerStyles.addFlagBtn}>
          Add observation
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {flags.length === 0 ? (
          <div style={trackerStyles.empty}>
            Capture qualitative observations as you read — strengths, risks, questions, things to investigate later.
          </div>
        ) : flags.map(f => {
          const k = kinds.find(x => x.id === f.kind) || kinds[1];
          return (
            <div key={f.id} style={{ ...trackerStyles.flagItem, borderLeftColor: k.color }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: k.color, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {k.icon} {k.label}
                </span>
                <button onClick={() => onRemove(f.id)} style={trackerStyles.rowAction}>
                  <Icon name="close" size={9} />
                </button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text)', marginTop: 2, lineHeight: 1.45 }}>
                {f.text}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
};

const trackerStyles = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  header: {
    padding: '14px 14px 10px', display: 'flex', alignItems: 'flex-start',
    justifyContent: 'space-between', gap: 8, borderBottom: '1px solid var(--border)',
  },
  title: { fontSize: 14, fontWeight: 600, fontFamily: 'var(--font-serif)' },
  subtitle: { fontSize: 11, marginTop: 2, fontFamily: 'var(--font-mono)' },
  autofillBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 9px',
    background: 'var(--accent-bg)', color: 'var(--accent)',
    border: '1px solid var(--accent-soft)', borderRadius: 4,
    fontSize: 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    textTransform: 'uppercase', letterSpacing: '0.05em',
  },
  tabs: { display: 'flex', padding: '8px 10px 0', gap: 2, borderBottom: '1px solid var(--border)' },
  tab: {
    padding: '6px 8px', background: 'none', border: 'none', cursor: 'pointer',
    fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
    borderBottom: '2px solid transparent', marginBottom: -1, fontFamily: 'inherit',
    display: 'inline-flex', alignItems: 'center', gap: 5,
  },
  tabActive: { color: 'var(--text)', borderBottomColor: 'var(--accent)' },
  tabBadge: {
    fontSize: 9, fontWeight: 700, padding: '1px 5px',
    background: 'var(--accent)', color: 'white', borderRadius: 999, fontFamily: 'var(--font-mono)',
  },
  content: { flex: 1, overflowY: 'auto', padding: 10 },
  tableHeader: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '4px 4px 6px',
    fontSize: 9, fontWeight: 700, color: 'var(--text-subtle)',
    textTransform: 'uppercase', letterSpacing: '0.05em',
    borderBottom: '1px solid var(--border)', marginBottom: 4,
  },
  valCol: { width: 60, textAlign: 'right' },
  yoyCol: { width: 44, textAlign: 'right' },
  row: { padding: '4px 4px', borderRadius: 4 },
  rowMain: { display: 'flex', alignItems: 'center', gap: 4 },
  rowAction: {
    width: 18, height: 18, padding: 0, background: 'transparent',
    border: 'none', cursor: 'pointer', color: 'var(--text-subtle)',
    display: 'grid', placeItems: 'center', opacity: 0.4, borderRadius: 3,
  },
  input: {
    padding: '5px 7px', background: 'var(--bg-elev)',
    border: '1px solid transparent', borderRadius: 3,
    color: 'var(--text)', fontSize: 12, fontFamily: 'inherit', outline: 'none',
  },
  notesToggle: {
    background: 'none', border: 'none', padding: '2px 0 0 4px',
    color: 'var(--text-subtle)', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit',
  },
  addRowBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '6px 10px', marginTop: 8,
    background: 'transparent', border: '1px dashed var(--border-strong)',
    borderRadius: 4, color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer',
    fontFamily: 'inherit', width: '100%', justifyContent: 'center',
  },
  sectionLabel: {
    fontSize: 10, fontWeight: 700, color: 'var(--text-subtle)',
    textTransform: 'uppercase', letterSpacing: '0.08em', margin: '16px 0 6px',
  },
  ratiosGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 },
  ratioCard: { padding: '8px 10px', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 4 },
  ratioLabel: { fontSize: 10, color: 'var(--text-subtle)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' },
  ratioValue: { fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, marginTop: 2 },
  flagInputWrap: { padding: '4px 0' },
  flagKindPicker: { display: 'flex', gap: 4, flexWrap: 'wrap' },
  flagKind: {
    padding: '4px 8px', border: '1px solid', borderRadius: 999,
    fontSize: 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  },
  addFlagBtn: {
    marginTop: 6, padding: '6px 12px', background: 'var(--text)',
    color: 'var(--bg)', border: 'none', borderRadius: 4,
    fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', width: '100%',
  },
  flagItem: {
    background: 'var(--bg-elev)', border: '1px solid var(--border)',
    borderLeft: '3px solid', borderRadius: 4, padding: '8px 10px',
  },
  empty: {
    padding: 14, fontSize: 11, color: 'var(--text-subtle)',
    fontStyle: 'italic', lineHeight: 1.5, textAlign: 'center',
  },
  footer: {
    padding: '10px 12px', borderTop: '1px solid var(--border)',
    display: 'flex', gap: 6, justifyContent: 'space-between',
  },
  resetBtn: {
    padding: '6px 10px', background: 'transparent', border: '1px solid var(--border)',
    borderRadius: 4, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit',
  },
  exportBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '6px 12px', background: 'var(--text)', color: 'var(--bg)',
    border: 'none', borderRadius: 4, fontSize: 11, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
};

// Input focus styles (injected once)
if (!document.getElementById('reader-tracker-style')) {
  const s = document.createElement('style');
  s.id = 'reader-tracker-style';
  s.textContent = `
    .reader-tracker input:focus, .reader-tracker textarea:focus {
      border-color: var(--accent) !important; background: var(--bg-sunken) !important;
    }
    .reader-tracker input:hover, .reader-tracker textarea:hover {
      border-color: var(--border) !important;
    }
    .reader-tracker .row:hover button[title="Remove"] { opacity: 1 !important; }
  `;
  document.head.appendChild(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles

const readerStyles = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999,
    display: 'grid', placeItems: 'center', padding: 0,
  },
  shell: {
    width: '100%', height: '100%', background: 'var(--bg)', display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 16px', borderBottom: '1px solid var(--border)',
    background: 'var(--bg-elev)', gap: 16,
  },
  closeBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '6px 12px', background: 'var(--bg-sunken)',
    border: '1px solid var(--border)', borderRadius: 4,
    color: 'var(--text)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
  },
  pdfBadge: {
    width: 30, height: 36, background: 'var(--neg-bg)', color: 'var(--neg)',
    border: '1px solid var(--neg-soft)', borderRadius: 3,
    display: 'grid', placeItems: 'center',
    fontSize: 9, fontWeight: 700, fontFamily: 'var(--font-mono)', flexShrink: 0,
  },
  toggle: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '6px 10px', background: 'var(--bg-elev)',
    border: '1px solid var(--border)', borderRadius: 4,
    color: 'var(--text-muted)', fontSize: 11, fontWeight: 500, cursor: 'pointer',
    fontFamily: 'inherit',
  },
  toggleOn: {
    background: 'var(--accent-bg)', borderColor: 'var(--accent-soft)', color: 'var(--accent)',
  },
  progressTrack: {
    height: 2, background: 'var(--bg-sunken)', position: 'relative', overflow: 'hidden',
  },
  progressFill: {
    height: '100%', background: 'var(--accent)', transition: 'width 150ms ease',
  },

  // Left rail
  outlinePanel: {
    background: 'var(--bg-sunken)', borderRight: '1px solid var(--border)',
    padding: '16px 12px', overflowY: 'auto',
  },
  outlineLabel: {
    fontSize: 10, fontWeight: 700, color: 'var(--text-subtle)',
    textTransform: 'uppercase', letterSpacing: '0.08em', padding: '4px 8px', marginBottom: 4,
  },
  outlineItem: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '7px 10px', border: 'none', background: 'transparent',
    borderRadius: 4, fontSize: 12, color: 'var(--text-muted)',
    width: '100%', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
  },
  outlineItemActive: {
    background: 'var(--bg-elev)', color: 'var(--text)', fontWeight: 600,
    boxShadow: '0 0 0 1px var(--border)',
  },
  outlineTime: {
    fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-subtle)',
  },
  outlineEmpty: {
    fontSize: 11, color: 'var(--text-subtle)', fontStyle: 'italic',
    padding: '8px 10px', lineHeight: 1.5,
  },
  highlightItem: {
    display: 'flex', alignItems: 'flex-start', gap: 6,
    padding: '8px 10px', cursor: 'pointer', borderRadius: 4,
  },
  highlightBar: {
    width: 3, alignSelf: 'stretch', background: '#F59E0B', borderRadius: 2, flexShrink: 0,
  },
  highlightText: {
    fontSize: 11, color: 'var(--text)', lineHeight: 1.4,
    overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
  },
  highlightMeta: {
    fontSize: 10, color: 'var(--text-subtle)', marginTop: 2,
    fontFamily: 'var(--font-mono)',
  },
  removeHl: {
    background: 'none', border: 'none', padding: 2, cursor: 'pointer',
    color: 'var(--text-subtle)', opacity: 0.6,
  },

  // Center document
  docScroll: {
    overflowY: 'auto', background: 'var(--bg-sunken)', padding: '24px 0',
  },
  page: {
    maxWidth: 760, margin: '0 auto', background: 'white', color: '#1a1a1a',
    padding: '64px 72px', fontFamily: '"Source Serif 4", Georgia, serif',
    fontSize: '11.5pt', lineHeight: 1.65, boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
    borderRadius: 4,
  },
  h2: {
    fontSize: 22, fontWeight: 700, color: '#1a1a1a', margin: '0',
    letterSpacing: '-0.005em',
  },
  h3: {
    fontSize: 14, fontWeight: 700, color: '#1a1a1a', margin: '24px 0 10px',
    paddingBottom: 4, borderBottom: '1px solid #e5e5e0',
  },
  p: {
    margin: '12px 0', color: '#2a2a2a', position: 'relative',
  },
  signature: {
    marginTop: 32, paddingTop: 12, borderTop: '1px solid #ccc',
    width: 240,
  },
  highlightBtn: {
    position: 'absolute', right: -32, top: 4,
    width: 22, height: 22, border: '1px solid #e5e5e0', background: 'white',
    borderRadius: 3, display: 'inline-grid', placeItems: 'center', cursor: 'pointer',
    color: '#999', opacity: 0,
    transition: 'opacity 150ms',
  },

  // Cover
  cover: {
    textAlign: 'center', padding: '40px 0', borderBottom: '3px double #1a1a1a',
  },
  coverSeal: {
    fontSize: 13, fontWeight: 700, letterSpacing: '0.08em',
  },
  coverFormBox: {
    display: 'inline-block', border: '3px solid #1a1a1a', padding: '12px 40px',
    fontSize: 22, fontWeight: 700, marginTop: 24,
  },
  coverCompany: {
    fontSize: 22, fontWeight: 700, marginTop: 32, letterSpacing: '0.04em',
  },
  coverGrid: {
    marginTop: 32, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16,
    width: '60%', margin: '32px auto 0',
  },

  // Risk
  riskCard: {
    border: '1px solid #e5e5e0', borderLeft: '4px solid #B91C1C',
    padding: '14px 18px', borderRadius: 4, background: '#FFFBF9',
  },
  riskHeader: {
    display: 'flex', alignItems: 'center', gap: 10,
  },
  severityBadge: {
    fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
    letterSpacing: '0.05em', fontFamily: 'var(--font-mono)',
  },
  riskTitle: {
    fontSize: 14, fontWeight: 700, margin: 0, color: '#1a1a1a',
  },
  riskFlag: {
    marginTop: 8, padding: '6px 10px', background: 'white',
    border: '1px solid #FECACA', borderRadius: 3, fontSize: 11,
    color: '#7F1D1D', display: 'flex', alignItems: 'center', gap: 6,
  },

  // Statement table
  statementTable: {
    width: '100%', borderCollapse: 'collapse', marginTop: 16,
    fontFamily: 'var(--font-mono)', fontSize: 11,
  },
  stTh: {
    textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid #1a1a1a',
    fontFamily: '"Source Serif 4", Georgia, serif', fontSize: 11,
    fontWeight: 700, color: '#1a1a1a', textTransform: 'uppercase', letterSpacing: '0.05em',
  },
  stTd: {
    padding: '7px 10px', borderBottom: '1px solid #ececec',
  },
  statementNote: {
    marginTop: 14, fontStyle: 'italic', color: '#888', fontSize: 11, textAlign: 'right',
  },

  // Inline chart
  inlineChart: {
    margin: '16px 0', padding: 16, background: '#FFF8F2',
    border: '1px solid #FED7AA', borderRadius: 6,
  },

  // AI panel
  aiPanel: {
    background: 'var(--bg-sunken)', borderLeft: '1px solid var(--border)',
    overflow: 'hidden', display: 'flex', flexDirection: 'column',
  },
  aiInner: {
    padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12,
  },
  aiHeader: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 14,
  },
  aiDot: {
    width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)',
    boxShadow: '0 0 0 3px var(--accent-bg)',
  },
  aiSection: {
    background: 'var(--bg-elev)', border: '1px solid var(--border)',
    borderRadius: 6, padding: 12,
  },
  aiSectionLabel: {
    fontSize: 10, fontWeight: 700, color: 'var(--text-subtle)',
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6,
  },
  askInput: {
    flex: 1, padding: '8px 10px',
    background: 'var(--bg-sunken)', border: '1px solid var(--border)',
    borderRadius: 4, color: 'var(--text)', fontSize: 12, resize: 'none',
    fontFamily: 'inherit',
  },
  askBtn: {
    width: 36, background: 'var(--accent)', color: 'white',
    border: 'none', borderRadius: 4, cursor: 'pointer',
  },
  suggestChip: {
    padding: '4px 8px', background: 'var(--bg-elev)',
    border: '1px solid var(--border)', borderRadius: 999,
    fontSize: 10, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit',
  },
  tinyBtn: {
    width: 18, height: 18, padding: 0, background: 'transparent',
    border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
  },
};

window.StatementReader = StatementReader;
