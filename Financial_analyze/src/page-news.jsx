// News & Insights page

const PageNews = ({ data }) => {
  const [tab, setTab] = React.useState('all');
  const [subject, setSubject] = React.useState('');
  const [briefing, setBriefing] = React.useState(null);
  const [results, setResults] = React.useState([]);
  const [searchError, setSearchError] = React.useState(null);
  const [researching, setResearching] = React.useState(false);
  const [timeRange, setTimeRange] = React.useState('week');
  const [story, setStory] = React.useState(null);
  const [digest, setDigest] = React.useState(null);
  const [digestExpanded, setDigestExpanded] = React.useState(false);
  // Live: this page pulls its own, larger feed (the app-level snapshot is
  // only a fallback while it loads). Offline: the labelled demo stories.
  const [feed, setFeed] = React.useState(null);        // null = not loaded
  const [feedError, setFeedError] = React.useState('');
  const live = !data.demo;

  React.useEffect(() => {
    if (!live) { setFeed(null); return undefined; }
    let cancelled = false;
    window.HelixAPI.news(30)
      .then(items => { if (!cancelled) { setFeed(mapNews(Array.isArray(items) ? items : [])); setFeedError(''); } })
      .catch(e => { if (!cancelled) setFeedError(e.message || 'News feed unavailable'); });
    return () => { cancelled = true; };
  }, [live]);

  React.useEffect(() => {
    let cancelled = false;
    window.HelixAPI.newsDailySummary()
      .then(d => { if (!cancelled) setDigest(d); })
      .catch(() => { if (!cancelled) setDigest({ stale: true, day_summary: null, articles: [] }); });
    return () => { cancelled = true; };
  }, []);

  const SUGGESTED = ['AI semiconductors', 'Fed rate path', 'NVDA earnings', 'Oil & energy', 'China tech'];

  const research = async (subj) => {
    const topic = (subj || subject).trim();
    if (!topic || researching) return;
    setSubject(topic);
    setResearching(true);
    setBriefing(null);
    setResults([]);
    setSearchError(null);

    let hits;
    try {
      hits = await window.HelixAPI.newsSearch(topic, 8, timeRange);
      setResults(hits);
    } catch (e) {
      setSearchError('Search unavailable — start ./scripts/run_searxng.sh');
      setResearching(false);
      return;
    }

    try {
      const context = hits.map(h => `- ${h.title}${h.published ? ` (${h.published})` : ''}${h.source ? ` [${h.source}]` : ''}: ${h.content}`).join('\n');
      const prompt = `You are a financial news analyst agent. Focus ONLY on this subject: "${topic}".\n\nFrom the search results below, synthesize a focused briefing on "${topic}". Use this exact format:\n\n**Why it matters:** [one sharp sentence]\n\n**Key developments:**\n- [point with specifics]\n- [point]\n- [point]\n\n**What to watch:** [1-2 forward-looking items]\n\n**Affected tickers:** [comma-separated symbols]\n\nBe concise and numerical. Use **bold** for figures, *italic* for tickers. No disclaimers, no emoji.\n\nSEARCH RESULTS:\n${context}`;
      const reply = await window.HelixAPI.complete(prompt, { page: 'news', context: { subject: topic } });
      setBriefing(reply);
    } catch (e) {
      setBriefing('Could not generate a briefing right now. Try again.');
    }
    setResearching(false);
  };

  const filterFor = {
    all: () => true,
    vn_market: n => n.category === 'market',
    vn_companies: n => n.category === 'companies',
    us: n => n.category === 'us',
  };

  const allNews = live ? (feed || data.news || []) : (data.news || []);
  const filtered = allNews.filter(filterFor[tab]);
  const emptyText = live && feed === null && !feedError && !allNews.length ? 'Loading news…'
    : live && feedError && !allNews.length ? `News feed unavailable: ${feedError}`
    : tab === 'all' ? 'No stories yet.' : 'No stories in this section right now.';

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">News & insights.</h1>
          <p className="page-sub">{live ? 'Vietnam market, Vietnam companies, and US headlines.' : 'Offline · sample headlines (demo data).'}</p>
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
            <select
              value={timeRange}
              onChange={e => setTimeRange(e.target.value)}
              disabled={researching}
              aria-label="News freshness"
              className="search"
              style={{ width: 112, cursor: 'pointer' }}
            >
              <option value="day">24 hours</option>
              <option value="week">7 days</option>
              <option value="month">30 days</option>
            </select>
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

          {searchError && (
            <div style={{ marginTop: 14, padding: 14, background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13, color: 'var(--text-muted)' }}>
              {searchError}
            </div>
          )}

          {!searchError && results.length > 0 && (
            <div style={{ marginTop: 14, padding: 14, background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-subtle)', marginBottom: 8 }}>Sources</div>
              {results.map((r, i) => (
                <div key={i} style={{ padding: '6px 0', borderBottom: i < results.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  {safeHttpUrl(r.url)
                    ? <a href={safeHttpUrl(r.url)} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none' }}>{r.title}</a>
                    : <span style={{ fontSize: 13, color: 'var(--text)' }}>{r.title}</span>}
                  {(r.source || r.published) && (
                    <div style={{ marginTop: 2, fontSize: 10, color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)' }}>
                      {[r.source, r.published].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {!searchError && (researching || briefing) && (
            <div style={{ marginTop: 14, padding: 16, background: 'var(--accent-bg)', border: '1px solid var(--accent-soft)', borderRadius: 8 }}>
              <div className="row" style={{ gap: 8, marginBottom: 8, justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <Icon name="sparkle" size={11} style={{ verticalAlign: 'middle', marginRight: 5 }} />
                  Analyst briefing · {subject}
                </span>
                {briefing && (
                  <button onClick={() => { setBriefing(null); setSubject(''); setResults([]); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-subtle)' }}><Icon name="close" size={12} /></button>
                )}
              </div>
              {researching ? (
                <div style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>Searching the web for “{subject}”…</div>
              ) : (
                <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text)' }}>
                  <MarkdownText text={briefing} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {digest && !digest.stale && digest.day_summary && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <h3 className="card-title">Daily Digest</h3>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{digest.date} · {digest.articles.length} articles</span>
          </div>
          <div className="card-body" style={{ padding: 16 }}>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text)' }}>
              <MarkdownText text={digest.day_summary} />
            </div>
            {digest.articles.length > 0 && (
              <>
                <button
                  onClick={() => setDigestExpanded(v => !v)}
                  style={{ marginTop: 12, fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}
                >
                  {digestExpanded ? 'Hide' : 'Show'} all {digest.articles.length} articles {digestExpanded ? '↑' : '↓'}
                </button>
                {digestExpanded && (
                  <div style={{ marginTop: 10 }}>
                    {digest.articles.map((a, i) => (
                      <div key={i} style={{ padding: '8px 0', borderBottom: i < digest.articles.length - 1 ? '1px solid var(--border)' : 'none' }}>
                        {safeHttpUrl(a.url)
                          ? <a href={safeHttpUrl(a.url)} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: 'var(--text)', textDecoration: 'none', fontWeight: 500 }}>{a.title}</a>
                          : <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{a.title}</span>}
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{a.summary}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-subtle)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>{a.source}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {digest && digest.stale && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-body" style={{ padding: 16, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
            No digest yet — check back after today's run.
          </div>
        </div>
      )}

      <div className="tabs">
        {[
          { id: 'all', label: 'Top stories' },
          { id: 'vn_market', label: 'VN Market' },
          { id: 'vn_companies', label: 'VN Companies' },
          { id: 'us', label: 'US' },
        ].map(t => (
          <button key={t.id} className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="card">
        <div className="card-body" style={{ padding: '0 20px' }}>
          {filtered.length === 0 && (
            <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>{emptyText}</div>
          )}
          {/* Hero story */}
          {filtered[0] && (
            <div onClick={() => setStory(filtered[0])} style={{ padding: '20px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
              <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', background: 'var(--accent)', color: 'white', letterSpacing: '0.05em' }}>TOP STORY</span>
                <span style={{ fontSize: 11, color: 'var(--text-subtle)' }} className="num">{filtered[0].time} · {filtered[0].src}</span>
              </div>
              <h2 className="serif" style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.25, margin: '0 0 12px' }}>
                {filtered[0].title}
              </h2>
              <div className="news-tags" style={{ marginTop: 10 }}>
                {(filtered[0].tags || []).map(t => <span key={t} style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-sunken)', color: 'var(--text-muted)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{t}</span>)}
              </div>
            </div>
          )}

          {filtered.slice(1).map((n, i) => (
            <div key={i} className="news-row" onClick={() => setStory(n)} style={{ cursor: 'pointer', gridTemplateColumns: '96px 1fr' }}>
              <span className="news-time">{n.time}</span>
              <div>
                <div className="news-title">{n.title}</div>
                <div className="news-meta row" style={{ gap: 8, marginTop: 4 }}>
                  <span style={{ color: 'var(--text-subtle)' }}>{n.src}</span>
                  {(n.tags || []).length > 0 && <span style={{ color: 'var(--text-subtle)' }}>·</span>}
                  <div className="news-tags">
                    {(n.tags || []).slice(0, 3).map(t => <span key={t} style={{ fontSize: 10, padding: '1px 5px', background: 'var(--bg-sunken)', color: 'var(--text-muted)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{t}</span>)}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {story && <StoryModal story={story} allNews={allNews} onClose={() => setStory(null)} />}
    </div>
  );
};

window.PageNews = PageNews;

const StoryModal = ({ story, allNews = [], onClose }) => {
  const [read, setRead] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);

  const expand = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const article = await window.HelixAPI.newsArticle(storyUrl);
      setRead(article.text);
    } catch (e) {
      setError(String(e && e.message || e));
    }
    setLoading(false);
  };

  React.useEffect(() => { setRead(''); setError(null); }, [story]);

  const storyUrl = safeHttpUrl(story.url);
  const related = allNews.filter(n => n !== story && (n.tags || []).some(t => (story.tags || []).includes(t))).slice(0, 3);

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
          </div>
          <h2 className="serif" style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.25, margin: '0 0 14px' }}>{story.title}</h2>
          <div className="news-tags" style={{ marginBottom: 18 }}>
            {(story.tags || []).map(t => <span key={t} style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg-sunken)', color: 'var(--text-muted)', fontWeight: 600, fontFamily: 'var(--font-mono)', marginRight: 4 }}>{t}</span>)}
          </div>

          {!storyUrl && (
            <div style={{ padding: 20, background: 'var(--bg-sunken)', borderRadius: 8, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
              No source link available{story.url ? '' : ' (sample story)'}.
            </div>
          )}

          {storyUrl && !read && !loading && !error && (
            <div style={{ padding: 20, background: 'var(--bg-sunken)', borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>Read the full article.</div>
              <button className="btn btn-accent" onClick={expand}><Icon name="sparkle" size={12} /> Read full story</button>
            </div>
          )}
          {loading && <div style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>Fetching article…</div>}
          {error && (
            <div style={{ padding: 16, background: 'var(--bg-sunken)', borderRadius: 8 }}>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>Could not load the article: {error}</div>
              <a href={storyUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: 'var(--accent)' }}>Open original ↗</a>
            </div>
          )}
          {read && <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--text)' }}><MarkdownText text={read} /></div>}

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
