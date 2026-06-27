// AI sidebar — calls window.claude.complete with context about the current page

const AI_SUGGESTIONS = {
  dashboard: ['Summarize today\'s market', 'What sectors are outperforming?', 'Any unusual moves?'],
  home: ['What should I watch today?', 'Why is gold moving?', 'Set an alert for one of these'],
  detail: ['Bullish or bearish?', 'Key risks for this stock', 'Compare to sector'],
  portfolio: ['How am I doing today?', 'Concentration risks', 'Rebalance suggestions'],
  screener: ['Stocks like NVDA but cheaper', 'Defensive dividend plays', 'Oversold quality names'],
  statements: ['Is this company healthy?', 'Red flags in the financials', 'How sustainable are the margins?'],
  totals: ['Summarize what I’ve collected', 'Which flags matter most?', 'What’s the headline takeaway?'],
  news: ['Top story summary', 'What does this mean for my holdings?', 'Macro implications'],
  alerts: ['What alerts should I set for NVDA?', 'Good RSI levels to watch', 'Explain my triggered alert']
};

const PAGE_CONTEXT = {
  dashboard: 'The user is viewing a markets dashboard with major indices (S&P 500 +0.42%, NASDAQ +0.89%, DOW -0.18%, VIX 14.23 -3.21%, 10Y yield 4.21%, BTC $98,234), a watchlist (NVDA +2.84%, AAPL +0.56%, TSLA -2.18%), and a sector heatmap (Tech leading +1.42%, Energy lagging -1.23%).',
  home: 'The user is on the Home watch board — a real-time tracker they have personalized with indices, gold and other commodities, rates, crypto, and individual stocks. Help them interpret moves and decide what to monitor.',
  detail: 'The user is viewing the asset detail page for NVIDIA (NVDA) at $142.36, +2.84% today. Market cap $3.49T, P/E 67.4. They\'re looking at a 1-month candlestick chart.',
  portfolio: 'The user is viewing their portfolio: $248,731 total value, +1.32% today (+$3,247), +23.81% all-time. Top holdings: NVDA (14%), AAPL (10%), MSFT (10%), GOOGL (9%). Bonds (TLT) are down 8%.',
  screener: 'The user is using the stock screener to filter equities by market cap, P/E ratio, dividend yield, and sector.',
  statements: 'The user is analyzing financial statements (income, balance sheet, cash flow, ratios) for NVDA. FY25: Revenue $130B (+114% YoY), Net Income $73B (+145%), FCF $61B. Margins: gross 75%, op 62%, net 56%. ROE 119%. P/E 48x. They can compare line items 5 years back and benchmark ratios against sector peers.',
  totals: 'The user is on the Totals page — a consolidated rollup of everything collected: headline statement totals, every line item across income/balance/cash flow with YoY and 5Y CAGR, plus data and flags captured from their PDF filing trackers.',
  news: 'The user is reading market news. Top stories include Fed rate signals, NVIDIA Q3 earnings (data center +94%), Tesla delivery miss, and Apple AI partnership.',
  alerts: 'The user is on the Alerts page, where they configure price, technical (RSI), percentage-move, and volume alerts on tickers. Help them set sensible alert thresholds.'
};

const AIPanel = ({ page, onClose }) => {
  const [messages, setMessages] = React.useState([
  {
    role: 'assistant',
    content: getInitialMessage(page)
  }]
  );
  const [input, setInput] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const bodyRef = React.useRef(null);

  // Which agent are we talking to? Read live from saved settings.
  const readProvider = () => {
    try {return JSON.parse(localStorage.getItem('helix_settings_v1') || '{}');}
    catch {return {};}
  };
  const [aiCfg, setAiCfg] = React.useState(readProvider);
  const [hermesUp, setHermesUp] = React.useState(null); // null=unknown, true/false
  const [fullscreen, setFullscreen] = React.useState(false);
  const isHermes = aiCfg.aiProvider === 'hermes';

  // Re-read settings when the panel opens / page changes, and ping Hermes.
  React.useEffect(() => {
    const cfg = readProvider();
    setAiCfg(cfg);
    if (cfg.aiProvider === 'hermes') {
      const base = (cfg.hermesEndpoint || 'http://localhost:11434').replace(/\/$/, '');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      fetch(`${base}/api/tags`, { signal: ctrl.signal }).
      then((r) => setHermesUp(r.ok)).
      catch(() => fetch(`${base}/v1/models`, { signal: ctrl.signal }).then((r) => setHermesUp(r.ok)).catch(() => setHermesUp(false))).
      finally(() => clearTimeout(t));
    }
  }, [page]);

  React.useEffect(() => {
    setMessages([{ role: 'assistant', content: getInitialMessage(page) }]);
  }, [page]);

  React.useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, loading]);

  const send = async (text) => {
    const q = (text || input).trim();
    if (!q || loading) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: q }]);
    setLoading(true);
    try {
      const prompt = `You are Helix, a sharp, concise financial market assistant inside an analysis app. Current view: ${PAGE_CONTEXT[page] || ''}\n\nUser asks: "${q}"\n\nRespond in 2-4 short paragraphs OR a tight bulleted list. Use **bold** for key figures and *italic* for ticker symbols. Be direct, no fluff. Don't add disclaimers about not being a financial advisor — the user knows. Do not use emoji.`;
      const reply = await window.HelixAPI.complete(prompt, { page, context: { view: PAGE_CONTEXT[page] || '' } });
      setMessages((m) => [...m, { role: 'assistant', content: reply }]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: 'Connection issue. Try again.' }]);
    }
    setLoading(false);
  };

  return (
    <aside className="ai" style={fullscreen ? { position: 'fixed', inset: 0, zIndex: 9998, width: '100vw', borderLeft: 'none' } : undefined}>
      <div className="ai-header">
        <div className="ai-title">
          <span className="ai-dot" style={isHermes ? { background: hermesUp ? 'var(--pos)' : hermesUp === false ? 'var(--neg)' : 'var(--text-subtle)', boxShadow: `0 0 0 3px ${hermesUp ? 'var(--pos-bg)' : 'var(--bg-sunken)'}` } : undefined}></span>
          <span>{isHermes ? 'Hermes Analyst' : 'Helix Analyst'}</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="icon-btn" onClick={() => setFullscreen((f) => !f)} style={{ width: 24, height: 24 }} title={fullscreen ? 'Exit full screen' : 'Full screen'}>
            <Icon name={fullscreen ? 'close' : 'expand'} size={12} />
          </button>
          {!fullscreen &&
          <button className="icon-btn" onClick={onClose} style={{ width: 24, height: 24 }} title="Close">
              <Icon name="close" size={12} />
            </button>
          }
        </div>
      </div>

      <div className="ai-body" ref={bodyRef}>
        <div style={fullscreen ? { maxWidth: 760, margin: '0 auto', width: '100%' } : undefined}>
        {messages.map((m, i) =>
          <div key={i} className={`ai-msg ${m.role === 'user' ? 'ai-msg-user' : ''}`}>
            <FormattedText text={m.content} />
          </div>
          )}
        {loading &&
          <div className="ai-msg" style={{ display: 'flex', gap: 4 }}>
            <Dot delay={0} /><Dot delay={150} /><Dot delay={300} />
          </div>
          }
        </div>
      </div>

      <div className="ai-suggestions">
        {(AI_SUGGESTIONS[page] || []).map((s, i) =>
        <button key={i} className="ai-chip" onClick={() => send(s)}>{s}</button>
        )}
      </div>

      <div className="ai-input-wrap">
        <textarea
          className="ai-input"
          placeholder="Ask about markets, your portfolio, anything…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }} />
        
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginTop: 8 }}>
          <button className="btn btn-accent" onClick={() => send()} disabled={loading || !input.trim()}>
            <Icon name="send" size={12} /> Send
          </button>
        </div>
      </div>
    </aside>);

};

const Dot = ({ delay }) =>
<span style={{
  width: 6, height: 6, borderRadius: '50%',
  background: 'var(--text-subtle)',
  animation: `pulse 1s infinite ${delay}ms`,
  display: 'inline-block'
}} />;


// Light markdown-ish formatting: **bold**, *italic*, - lists, paragraphs
const FormattedText = ({ text }) => {
  const lines = text.split('\n');
  const elements = [];
  let listBuf = [];

  const flushList = () => {
    if (listBuf.length) {
      elements.push(<ul key={`ul-${elements.length}`}>{listBuf.map((l, i) => <li key={i}>{renderInline(l)}</li>)}</ul>);
      listBuf = [];
    }
  };

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
      listBuf.push(trimmed.slice(2));
    } else if (trimmed === '') {
      flushList();
    } else {
      flushList();
      elements.push(<p key={`p-${i}`} style={{ margin: '0 0 8px' }}>{renderInline(trimmed)}</p>);
    }
  });
  flushList();

  return <>{elements}</>;
};

const renderInline = (str) => {
  // Supports: ![alt](img), [text](url), bare URLs, **bold**, *italic*
  const parts = [];
  let remaining = str;
  let key = 0;

  const patterns = [
  { type: 'img', re: /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/ },
  { type: 'link', re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/ },
  { type: 'url', re: /(https?:\/\/[^\s)]+)/ },
  { type: 'b', re: /\*\*(.+?)\*\*/ },
  { type: 'i', re: /\*(.+?)\*/ }];


  while (remaining.length) {
    let best = null;
    for (const p of patterns) {
      const m = remaining.match(p.re);
      if (m && (best === null || m.index < best.index)) best = { ...m, type: p.type, _len: m[0].length };
      if (best && best.index === 0) break;
    }
    if (!best) {parts.push(remaining);break;}
    if (best.index > 0) parts.push(remaining.slice(0, best.index));

    if (best.type === 'img') {
      parts.push(
        <a key={key++} href={best[2]} target="_blank" rel="noopener noreferrer" style={{ display: 'block', margin: '6px 0' }}>
          <img src={best[2]} alt={best[1]} style={{ maxWidth: '100%', borderRadius: 6, border: '1px solid var(--border)' }} />
        </a>
      );
    } else if (best.type === 'link') {
      parts.push(<a key={key++} href={best[2]} target="_blank" rel="noopener noreferrer" style={aiLinkStyle}>{best[1]}</a>);
    } else if (best.type === 'url') {
      parts.push(<a key={key++} href={best[1]} target="_blank" rel="noopener noreferrer" style={aiLinkStyle}>{best[1]}</a>);
    } else if (best.type === 'b') {
      parts.push(<strong key={key++}>{best[1]}</strong>);
    } else {
      parts.push(<em key={key++}>{best[1]}</em>);
    }
    remaining = remaining.slice(best.index + best._len);
  }
  return parts;
};

const aiLinkStyle = {
  color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: 2,
  fontWeight: 500, wordBreak: 'break-word'
};

function getInitialMessage(page) {
  const m = {
    dashboard: "Markets opened mixed but tech is leading. **NASDAQ +0.89%** on strong AI/semi names. Fed minutes Wednesday could shift sentiment — *VIX* at 14 is complacent. Want me to dig into anything specific?",
    home: "This is your live watch board. **Gold** is holding near $2,683, *VIX* is calm at 14, and 10Y yields sit at 4.21%. Tell me which instrument to break down, or ask me to suggest alert levels.",
    detail: "*NVDA* up **2.84%** to **$142.36** on continued data-center momentum. RSI at 64 — approaching but not yet overbought. Earnings in 12 days. Ask me anything about it.",
    portfolio: "You're up **+1.32% today** ($3,247), led by *NVDA* and *META*. Heads up: tech concentration is at **40%** of portfolio — worth considering. Bonds (*TLT*) are dragging.",
    screener: "Tell me what you're hunting for — quality, value, momentum, dividend, defensive — and I'll suggest filters.",
    statements: "*NVDA* FY25 is extraordinary: revenue **$130B (+114%)**, net income **$73B (+145%)**, FCF **$61B**. Op margin **62.5%** — best-in-class. The catch: P/E **48×**, ~50% premium to sector. Want me to flag risks or compare to peers?",
    totals: "This is your collection hub — statement totals plus everything you've tracked and flagged from filings. Ask me to summarize the headline numbers or rank the flags by what matters.",
    news: "Three stories actually matter today: **Fed rate posture**, **NVIDIA's data-center beat**, and **Tesla delivery miss**. Want me to break any of those down?",
    alerts: "Set alerts so the market tells you when to act. Good starting points: a **price target** to trim, a **buy-the-dip** level, and an **RSI > 70** overbought warning. Tell me a ticker and I'll suggest levels."
  };
  return m[page] || "How can I help?";
}

window.AIPanel = AIPanel;