// News & Insights page

const PageNews = ({ data }) => {
  const [tab, setTab] = React.useState('all');

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
              <div style={{ padding: '20px 0', borderBottom: '1px solid var(--border)' }}>
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
              <div key={i} className="news-row">
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
                  <Pill value={t.chg} />
                </div>
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
    </div>
  );
};

window.PageNews = PageNews;
