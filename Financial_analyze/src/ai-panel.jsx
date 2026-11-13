// AI sidebar — sends the question plus a context built from what is actually
// on screen (page, active asset, its live quote, live indices, portfolio).
// No figures are hard-coded here: when a value isn't loaded it is simply left
// out of the context, and offline demo data is labelled as such.

const AI_SUGGESTIONS = {
  dashboard: ['Summarize today\'s market', 'Any unusual moves in my watchlist?', 'What should I watch today?'],
  home: ['What should I watch today?', 'Why is gold moving?', 'Set an alert for one of these'],
  detail: ['Bullish or bearish?', 'Key risks for this stock', 'Compare to sector'],
  portfolio: ['How am I doing today?', 'Concentration risks', 'Rebalance suggestions'],
  screener: ['Explain these rules', 'Why did this ticker fail?', 'Which oversold names look healthiest?'],
  statements: ['Is this company healthy?', 'Red flags in the financials', 'How sustainable are the margins?'],
  news: ['Top story summary', 'What does this mean for my holdings?', 'Macro implications'],
  alerts: ['What alerts should I set for this stock?', 'Good RSI levels to watch', 'Explain my triggered alert']
};

// What each page is — descriptions only, never numbers.
const PAGE_CONTEXT = {
  dashboard: 'The user is viewing the markets dashboard: major indices, their active watchlist with live quotes, top gainers/losers from that watchlist, and the latest news.',
  home: 'The user is on the Home watch board — a tracker they personalized with indices, commodities, rates, crypto, and individual stocks. Help them interpret moves and decide what to monitor.',
  detail: 'The user is viewing the asset detail page for one ticker: price chart, key stats, technical indicators, ratios, notes, and related news.',
  portfolio: 'The user is viewing their portfolio. Use only the live portfolio context supplied with this request; never invent holdings or performance.',
  screener: 'The user is on the Vietnam stock screener: a rules funnel over HOSE/HNX/UPCOM. Good-company rules (ROE, growth, debt, cash flow, P/E vs industry, liquidity, bank ratios) narrow the market, then oversold rules (RSI, price drop, volume spike) flag names to look at now. Data is third-party (vnstock) and unverified.',
  statements: 'The user is analyzing financial statements (income, balance sheet, cash flow, ratios) built from verified company filings.',
  news: 'The user is reading market news (Vietnam market, Vietnam companies, US) and can ask for a focused research briefing on any subject.',
  alerts: 'The user is on the Alerts page, where they configure price and percentage-move alerts on tickers. Help them set sensible alert thresholds.',
  backtest: 'The user is on the Backtest page, testing a trading strategy against historical prices.',
  'ocr-inbox': 'The user is in the OCR Inbox, reviewing machine-read financial statements before publishing them.',
  sync: 'The user is on the Sync page, managing OCR worker machines.',
  settings: 'The user is on the Settings page.'
};

const AI_ASSET_PAGES = new Set(['detail', 'statements', 'alerts']);

// Neutral greetings — no market claims, no numbers.
const aiGreeting = (page, asset) => {
  const sym = asset ? String(asset).replace(/^VN:/, '') : '';
  const m = {
    dashboard: "I can read the indices, your active watchlist, and the latest headlines on this page. What would you like to look at?",
    home: "This is your watch board. Tell me which instrument to break down, or ask me to suggest alert levels.",
    detail: sym ? `Ask me anything about *${sym}* — price action, technicals, ratios, or risks.` : 'Ask me anything about this asset.',
    portfolio: "I can review your live holdings, performance, cash, and concentration. What would you like to examine?",
    screener: "This screener narrows the Vietnam market with **good-company rules**, then flags **oversold** names. Ask me about a rule, a threshold, or why a ticker passed or failed.",
    statements: "Ask me about the statements on screen — profitability, balance-sheet health, cash flow, or red flags.",
    news: "Ask me to summarize a story, explain what it means for your holdings, or research a subject.",
    alerts: "Tell me a ticker and what you want to catch — a breakout, a dip, or a big daily move — and I'll suggest levels."
  };
  return m[page] || 'How can I help?';
};

// Live context for the model, from props + the shared quote cache.
const buildAiView = ({ page, activeAsset, data, live }) => {
  const parts = [PAGE_CONTEXT[page] || `The user is on the ${page} page.`];
  if (!live || data?.demo) {
    parts.push('The backend is offline: any numbers on screen are labelled sample/demo data, not real market data. Do not quote them as real.');
    return parts.join(' ');
  }
  const indices = (data?.indices || []).filter(i => isNum(i.val))
    .map(i => `${i.sym} ${fmtNum(i.val)}${isNum(i.chg) ? ` (${fmtPct(i.chg)})` : ''}`);
  if (indices.length && (page === 'dashboard' || page === 'home' || page === 'news')) parts.push(`Live indices: ${indices.join(', ')}.`);
  if (activeAsset && AI_ASSET_PAGES.has(page)) {
    const holding = (data?.portfolio?.holdings || []).find(h => h.sym === String(activeAsset).replace(/^VN:/, ''));
    const q = liveQuoteFor(activeAsset, holding?.currency);
    const quote = q.status === 'ok'
      ? ` Live quote: ${fmtNativePrice(q.price, q.currency)}${isNum(q.chg) ? `, ${fmtPct(q.chg)} today` : ''}${q.marketCap != null ? `, market cap ${fmtBig(q.marketCap)} ${q.currency}` : ''}.`
      : ' No live quote loaded for it.';
    parts.push(`Active asset: ${activeAsset}.${quote}`);
  }
  if (page === 'dashboard') {
    const active = window.WatchlistStore?.getActive();
    const rows = (active?.symbols || []).map(s => ({ s, q: liveQuoteFor(s) })).filter(r => r.q.status === 'ok')
      .map(r => `${r.s} ${fmtNativePrice(r.q.price, r.q.currency)}${isNum(r.q.chg) ? ` ${fmtPct(r.q.chg)}` : ''}`);
    if (rows.length) parts.push(`Watchlist "${active.name}": ${rows.join(', ')}.`);
  }
  return parts.join(' ');
};

const AIPanel = ({ page, activeAsset, data, live, onClose }) => {
  // One conversation per page; a reply always lands in the thread of the
  // page that asked, even if the user navigated away meanwhile.
  const [threads, setThreads] = React.useState({});
  const [pending, setPending] = React.useState({});   // page -> true while waiting
  const [input, setInput] = React.useState('');
  const bodyRef = React.useRef(null);
  const messages = threads[page] || [];
  const loading = !!pending[page];

  // Which agent are we talking to? Read live from saved settings.
  const readProvider = () => {
    try {return JSON.parse(localStorage.getItem('helix_settings_v1') || '{}');}
    catch {return {};}
  };
  const [aiCfg, setAiCfg] = React.useState(readProvider);
  const [hermesUp, setHermesUp] = React.useState(null); // null=unknown, true/false
  const [fullscreen, setFullscreen] = React.useState(false);
  const isHermes = (aiCfg.aiProvider || 'hermes') === 'hermes';

  // Re-read settings when the panel opens / page changes, and ask the backend
  // whether the full Hermes Agent gateway is ready.
  React.useEffect(() => {
    const cfg = readProvider();
    setAiCfg(cfg);
    if ((cfg.aiProvider || 'hermes') === 'hermes' && live) {
      window.HelixAPI.aiHealth().
      then(() => setHermesUp(true)).
      catch(() => setHermesUp(false));
    } else if (!live) setHermesUp(false);
  }, [page, live]);

  React.useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, loading]);

  const append = (forPage, msg) => setThreads(t => ({ ...t, [forPage]: [...(t[forPage] || []), msg] }));

  const send = async (text) => {
    const q = (text || input).trim();
    const forPage = page;
    if (!q || pending[forPage]) return;
    setInput('');
    const conversation = [...(threads[forPage] || []), { role: 'user', content: q }];
    append(forPage, { role: 'user', content: q });
    setPending(p => ({ ...p, [forPage]: true }));
    let reply;
    try {
      const toneMap = {
        concise: 'Respond in 2-4 short paragraphs OR a tight bulleted list.',
        detailed: 'Give a thorough answer: short sections with a bulleted breakdown of drivers, context, and caveats.',
        'numbers-only': 'Answer almost entirely in figures: a tight bulleted list of numbers with minimal prose.',
      };
      let aiTone = 'concise';
      try { aiTone = JSON.parse(localStorage.getItem('helix_settings_v1') || '{}').aiTone || 'concise'; } catch {}
      const currentPortfolio = window.__livePortfolioContext || (data?.portfolio?.status === 'ok' ? data.portfolio : null);
      const portfolioContext = live && forPage === 'portfolio' && currentPortfolio ? JSON.stringify({
        currency: currentPortfolio.display_currency || currentPortfolio.displayCurrency || 'USD', totalValue: currentPortfolio.total_value ?? currentPortfolio.totalValue,
        dayChange: currentPortfolio.today_change ?? currentPortfolio.dayChange, totalGain: currentPortfolio.total_gain ?? currentPortfolio.totalGain,
        holdings: (currentPortfolio.holdings || []).slice(0, 20).map(h => ({ ticker: h.ticker || h.sym, weight: h.weight, gainPct: h.gain_pct ?? h.gainPct })),
      }) : '';
      if (live && activeAsset && AI_ASSET_PAGES.has(forPage)) {
        const holding = (data?.portfolio?.holdings || []).find(h => h.sym === String(activeAsset).replace(/^VN:/, ''));
        await QuoteStore.ensure([helixMarketFor(activeAsset, holding?.currency).market]);
      }
      const view = `${buildAiView({ page: forPage, activeAsset, data, live })}${portfolioContext ? ` Live portfolio data: ${portfolioContext}` : ''}`;
      const responseStyle = `${toneMap[aiTone] || toneMap.concise} Use **bold** for key figures and *italic* for ticker symbols. Be direct, no fluff. Don't add disclaimers about not being a financial advisor — the user knows. Do not use emoji.`;
      const out = await window.HelixAPI.complete(q, {
        page: forPage,
        context: { view, responseStyle },
        messages: conversation,
      });
      reply = typeof out === 'string' ? out : out == null ? '' : JSON.stringify(out);
      if (!reply.trim()) reply = 'No answer came back. Try again.';
    } catch (e) {
      reply = 'Connection issue. Try again.';
    }
    append(forPage, { role: 'assistant', content: reply });
    setPending(p => ({ ...p, [forPage]: false }));
  };

  const shown = [{ role: 'assistant', content: aiGreeting(page, activeAsset) }, ...messages];

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
        {shown.map((m, i) =>
          <div key={i} className={`ai-msg ${m.role === 'user' ? 'ai-msg-user' : ''}`}>
            <MarkdownText text={m.content} variant="ai" />
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

window.AIPanel = AIPanel;
