// News & Insights page

const PageNews = ({ data }) => {
  const [tab, setTab] = React.useState('all');
  const [subject, setSubject] = React.useState('');
  const [briefing, setBriefing] = React.useState(null);
  const [researching, setResearching] = React.useState(false);
  const [story, setStory] = React.useState(null);

  const SUGGESTED = ['AI semiconductors', 'Fed rate path', 'NVDA earnings', 'Oil & energy', 'China tech'];

  const research = async (subj) => {
    const topic = (subj || subject).trim();
    if (!topic || researching) return;
    setSubject(topic);
    setResearching(true);
    setBriefing(null);
    try {
      const headlines = data.news.map(n => `- ${n.title} (${n.src})`).join('\n');
      const prompt = `You are a financial news analyst agent. Focus ONLY on this subject: "${topic}".\n\nFrom the day's headlines below, synthesize a focused briefing on "${topic}". Use this exact format:\n\n**Why it matters:** [one sharp sentence]\n\n**Key developments:**\n- [point with specifics]\n- [point]\n- [point]\n\n**What to watch:** [1-2 forward-looking items]\n\n**Affected tickers:** [comma-separated symbols]\n\nBe concise and numerical. Use **bold** for figures, *italic* for tickers. No disclaimers, no emoji.\n\nTODAY'S HEADLINES:\n${headlines}`;
      const reply = await window.HelixAPI.complete(prompt, { page: 'news', context: { subject: topic } });
      setBriefing(reply);
    } catch (e) {
      setBriefing('Could not generate a briefing right now. Try again.');
    }
    setResearching(false);
  };

  const filterFor = {
    all: () => true,
    macro: n => n.tags.some(t => ['MACRO','FED','RATES','BONDS','OIL','EU'].includes(t)),
    equities: n => n.tags.some(t => ['NVDA','TSLA','AAPL','MSFT','EARNINGS','AI','AUTOS','CAPEX'].includes(t)),
    crypto: n => n.tags.includes('CRYPTO') || n.tags.includes('BTC'),
  };

  const filtered = data.news.filter(filterFor[tab]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">News & insights.</h1>
          <p className="page-sub">Curated. Filtered to what affects your watchlist.</p>
        </div>
      </div>

      {/* Focus the analyst on a subject */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-body" style={{ padding: 16 }}>
          <div className="row" style={{ gap: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: 1, background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0 12px' }}>
              <Icon name="sparkle" size={15} style={{ color: 'var(--accent)' }} />
              <input
                value={subject}
                onChange={e => setSubject(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') research(); }}
                placeholder="Focus the analyst on a subject — e.g. AI chips, Fed policy, a ticker…"
                style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', padding: '11px 0', fontSize: 14, color: 'var(--text)', fontFamily: 'inherit' }}
              />
            </span>
            <button className="btn btn-primary" onClick={() => research()} disabled={researching || !subject.trim()}>
              <Icon name="search" size={13} /> {researching ? 'Researching…' : 'Research'}
            </button>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Try:</span>
            {SUGGESTED.map(s => (
              <button key={s} onClick={() => research(s)} style={{ fontSize: 11, padding: '4px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 999, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit' }}>{s}</button>
            ))}
          </div>

          {(researching || briefing) && (
            <div style={{ marginTop: 14, padding: 16, background: 'var(--accent-bg)', border: '1px solid var(--accent-soft)', borderRadius: 8 }}>
              <div className="row" style={{ gap: 8, marginBottom: 8, justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <Icon name="sparkle" size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />
                  Analyst briefing · {subject}
                </span>
                {briefing && (
                  <button onClick={() => { setBriefing(null); setSubject(''); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-subtle)' }}><Icon name="close" size={12} /></button>
                )}
              </div>
              {researching ? (
                <div style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>Scanning today’s headlines for “{subject}”…</div>
              ) : (
                <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text)' }}>
                  <NewsFormatted text={briefing} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="tabs">
        {[
          { id: 'all', label: 'Top stories' },
          { id: 'macro', label: 'Macro' },
          { id: 'equities', label: 'Equities' },
          { id: 'crypto', label: 'Crypto' },
        ].map(t => (
          <button key={t.id} className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="grid-2">
        {/* Stories list */}
        <div className="card">
          <div className="card-body" style={{ padding: '0 20px' }}>
            {/* Hero story */}
            {filtered[0] && (
              <div onClick={() => setStory(filtered[0])} style={{ padding: '20px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', background: 'var(--accent)', color: 'white', letterSpacing: '0.05em' }}>BREAKING</span>
                  <span style={{ fontSize: 11, color: 'var(--text-subtle)' }} className="num">{filtered[0].time} · {filtered[0].src}</span>
                </div>
                <h2 className="serif" style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.25, margin: '0 0 12px' }}>
                  {filtered[0].title}
                </h2>
                <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>
                  Federal Reserve officials emphasized a measured pace for monetary easing, citing sticky services inflation and a still-resilient labor market. Markets are now pricing in two cuts for 2026, down from three earlier this month.
                </p>
                <div className="news-tags" style={{ marginTop: 10 }}>
                  {filtered[0].tags.map(t => <span key={t} style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-sunken)', color: 'var(--text-muted)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{t}</span>)}
                </div>
              </div>
            )}

            {filtered.slice(1).map((n, i) => (
              <div key={i} className="news-row" onClick={() => setStory(n)} style={{ cursor: 'pointer' }}>
                <span className="news-time">{n.time}</span>
                <div>
                  <div className="news-title">{n.title}</div>
                  <div className="news-meta row" style={{ gap: 8, marginTop: 4 }}>
                    <span style={{ color: 'var(--text-subtle)' }}>{n.src}</span>
                    <span style={{ color: 'var(--text-subtle)' }}>·</span>
                    <div className="news-tags">
                      {n.tags.slice(0, 3).map(t => <span key={t} style={{ fontSize: 10, padding: '1px 5px', background: 'var(--bg-sunken)', color: 'var(--text-muted)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{t}</span>)}
                    </div>
                  </div>
                </div>
                <span className="pill" style={{
                  background: n.sentiment === 'positive' ? 'var(--pos-bg)' : n.sentiment === 'negative' ? 'var(--neg-bg)' : 'var(--bg-sunken)',
                  color: n.sentiment === 'positive' ? 'var(--pos)' : n.sentiment === 'negative' ? 'var(--neg)' : 'var(--text-muted)',
                  alignSelf: 'flex-start',
                }}>
                  {n.sentiment === 'positive' ? '↗ Positive' : n.sentiment === 'negative' ? '↘ Negative' : '→ Neutral'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Sidebar: trending + economic calendar */}
        <div className="stack">
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Trending Tickers</h3>
              <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Mentions ↑ today</span>
            </div>
            <div className="card-body" style={{ padding: '4px 0' }}>
              {[
                { sym: 'NVDA', mentions: 1284, chg: 32 },
                { sym: 'TSLA', mentions: 892, chg: 18 },
                { sym: 'AAPL', mentions: 612, chg: 12 },
                { sym: 'BTC', mentions: 548, chg: 24 },
                { sym: 'MSFT', mentions: 421, chg: 8 },
              ].map((t, i) => (
                <div key={t.sym} style={{ display: 'grid', gridTemplateColumns: '24px 60px 1fr auto', gap: 8, padding: '8px 16px', alignItems: 'center', borderBottom: i < 4 ? '1px solid var(--border)' : 'none' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)' }}>#{i + 1}</span>
                  <span className="ticker">{t.sym}</span>
                  <span className="num" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.mentions} mentions</span>
                  <Pill value={t.chg} />                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Economic Calendar</h3>
              <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>This week</span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              {[
                { date: 'Wed', time: '14:00 ET', event: 'FOMC Minutes', importance: 3 },
                { date: 'Thu', time: '08:30 ET', event: 'CPI (YoY)', importance: 3, est: '2.6%', prev: '2.7%' },
                { date: 'Thu', time: '08:30 ET', event: 'Initial Jobless Claims', importance: 2, est: '218K', prev: '224K' },
                { date: 'Fri', time: '08:30 ET', event: 'Retail Sales', importance: 2, est: '+0.4%', prev: '+0.7%' },
                { date: 'Fri', time: '10:00 ET', event: 'U-Mich Sentiment', importance: 1, est: '72.5', prev: '71.8' },
              ].map((e, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 12, padding: '12px 16px', alignItems: 'center', borderBottom: i < 4 ? '1px solid var(--border)' : 'none' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-serif)', fontWeight: 600, fontSize: 13 }}>{e.date}</div>
                    <div className="num" style={{ fontSize: 10, color: 'var(--text-subtle)' }}>{e.time}</div>
                  </div>
                  <div>
                    <div className="row" style={{ gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{e.event}</span>
                      <span style={{ display: 'inline-flex', gap: 1 }}>
                        {[1, 2, 3].map(n => (
                          <span key={n} style={{ width: 4, height: 4, borderRadius: '50%', background: n <= e.importance ? 'var(--accent)' : 'var(--border-strong)' }}></span>
                        ))}
                      </span>
                    </div>
                    {e.est && <div className="num" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Est. {e.est} · Prev {e.prev}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {story && <StoryModal story={story} allNews={data.news} onClose={() => setStory(null)} />}
    </div>
  );
};

window.PageNews = PageNews;

const StoryModal = ({ story, allNews = [], onClose }) => {
  const [read, setRead] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  const expand = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const prompt = `You are a financial journalist. Expand this headline into a concise news read (~3 short paragraphs). Headline: "${story.title}" (source: ${story.src}). Tags: ${story.tags.join(', ')}. Use **bold** for key figures and *italic* for tickers. End with a one-line "Market impact:" note. No disclaimers, no emoji.`;
      const reply = await window.HelixAPI.complete(prompt, { page: 'news', context: { headline: story.title } });
      setRead(reply);
    } catch {
      setRead('Could not load the full story right now.');
    }
    setLoading(false);
  };

  React.useEffect(() => { setRead(''); }, [story]);

  const related = allNews.filter(n => n !== story && n.tags.some(t => story.tags.includes(t))).slice(0, 3);
  const sentColor = story.sentiment === 'positive' ? 'var(--pos)' : story.sentiment === 'negative' ? 'var(--neg)' : 'var(--text-muted)';

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 520, height: '100%', background: 'var(--bg-elev)', borderLeft: '1px solid var(--border)', boxShadow: '-12px 0 40px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', animation: 'story-in 200ms ease' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)' }}>Story</span>
          <button className="icon-btn" onClick={onClose} style={{ width: 28, height: 28 }}><Icon name="close" size={13} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <span className="num" style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{story.time} · {story.src}</span>
            <span className="pill" style={{ background: 'var(--bg-sunken)', color: sentColor }}>
              {story.sentiment === 'positive' ? '↗ Positive' : story.sentiment === 'negative' ? '↘ Negative' : '→ Neutral'}
            </span>
          </div>
          <h2 className="serif" style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.25, margin: '0 0 14px' }}>{story.title}</h2>
          <div className="news-tags" style={{ marginBottom: 18 }}>
            {story.tags.map(t => <span key={t} style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-sunken)', color: 'var(--text-muted)', fontWeight: 600, fontFamily: 'var(--font-mono)', marginRight: 4 }}>{t}</span>)}
          </div>

          {!read && !loading && (
            <div style={{ padding: 20, background: 'var(--bg-sunken)', borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>Get the AI-expanded read of this headline.</div>
              <button className="btn btn-accent" onClick={expand}><Icon name="sparkle" size={12} /> Read full story</button>
            </div>
          )}
          {loading && <div style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>Writing the story…</div>}
          {read && <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--text)' }}><NewsFormatted text={read} /></div>}

          {related.length > 0 && (
            <div style={{ marginTop: 28, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)', marginBottom: 10 }}>Related</div>
              {related.map((r, i) => (
                <div key={i} style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0', borderBottom: i < related.length - 1 ? '1px solid var(--border)' : 'none', lineHeight: 1.4 }}>{r.title}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

if (!document.getElementById('story-style')) {
  const s = document.createElement('style');
  s.id = 'story-style';
  s.textContent = `@keyframes story-in { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`;
  document.head.appendChild(s);
}

// Lightweight markdown formatter for the briefing (**bold**, *italic*, - lists)
const NewsFormatted = ({ text }) => {
  const lines = String(text).split('\n');
  const out = [];
  let list = [];
  const flush = () => { if (list.length) { out.push(<ul key={'u' + out.length} style={{ margin: '6px 0', paddingLeft: 18 }}>{list.map((l, i) => <li key={i} style={{ margin: '3px 0' }}>{inline(l)}</li>)}</ul>); list = []; } };
  const inline = (s) => {
    const parts = []; let rem = s; let k = 0;
    while (rem.length) {
      const b = rem.match(/\*\*(.+?)\*\*/); const it = rem.match(/\*(.+?)\*/);
      let m = null;
      if (b && (!it || b.index <= it.index)) m = { ...b, t: 'b' }; else if (it) m = { ...it, t: 'i' };
      if (!m) { parts.push(rem); break; }
      if (m.index > 0) parts.push(rem.slice(0, m.index));
      parts.push(m.t === 'b' ? <strong key={k++}>{m[1]}</strong> : <em key={k++} style={{ fontStyle: 'normal', color: 'var(--accent)', fontWeight: 600 }}>{m[1]}</em>);
      rem = rem.slice(m.index + m[0].length);
    }
    return parts;
  };
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('- ') || t.startsWith('• ')) list.push(t.slice(2));
    else { flush(); if (t) out.push(<p key={'p' + i} style={{ margin: '6px 0' }}>{inline(t)}</p>); }
  });
  flush();
  return <>{out}</>;
};
