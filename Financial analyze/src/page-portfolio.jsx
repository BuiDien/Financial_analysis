// Portfolio page

const PagePortfolio = ({ data, setActiveAsset, setPage }) => {
  const p = data.portfolio;

  // Performance series — cumulative gain over time
  const perfSeries = React.useMemo(() => {
    const days = 90;
    const arr = [];
    let v = p.totalValue - p.totalGain;
    for (let i = 0; i < days; i++) {
      const drift = 0.0008 + Math.sin(i / 12) * 0.002;
      const noise = (Math.sin(i * 1.7) + Math.cos(i * 0.9)) * 0.004;
      v = v * (1 + drift + noise);
      arr.push(v);
    }
    arr[arr.length - 1] = p.totalValue;
    return arr;
  }, [p.totalValue, p.totalGain]);

  const allocColors = ['#C2410C', '#9A3412', '#7C2D12', '#A16207', '#1D4ED8', '#15803D', '#7C3AED', '#0E7490', '#9333EA', '#BE185D', '#0F766E'];
  const allocSegments = p.holdings.map((h, i) => ({ value: h.value, color: allocColors[i % allocColors.length], label: h.sym }));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Your portfolio.</h1>
          <p className="page-sub">11 holdings · Last rebalanced 3 weeks ago</p>
        </div>
        <div className="row">
          <button className="btn"><Icon name="download" size={12} /> Statement</button>
          <button className="btn btn-primary"><Icon name="plus" size={12} /> Add position</button>
        </div>
      </div>

      {/* Hero stat */}
      <div className="card" style={{ marginBottom: 20, padding: 24 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 32, alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Total Value</div>
            <div className="num" style={{ fontSize: 44, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 4 }}>
              ${fmtNum(p.totalValue, 0)}<span style={{ color: 'var(--text-subtle)', fontSize: 24 }}>.{(p.totalValue % 1).toFixed(2).slice(2)}</span>
            </div>
            <div className="row" style={{ marginTop: 12, gap: 16, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Today</div>
                <div className="row" style={{ gap: 6 }}>
                  <span className="num pos" style={{ fontSize: 16, fontWeight: 600 }}>+${fmtNum(p.dayChange)}</span>
                  <Pill value={p.dayChangePct} />
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>All-time</div>
                <div className="row" style={{ gap: 6 }}>
                  <span className="num pos" style={{ fontSize: 16, fontWeight: 600 }}>+${fmtNum(p.totalGain, 0)}</span>
                  <Pill value={p.totalGainPct} />
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Cash</div>
                <div className="num" style={{ fontSize: 16, fontWeight: 600 }}>${fmtNum(p.cash, 0)}</div>
              </div>
            </div>
          </div>
          <div style={{ height: 160 }}>
            <AreaChart data={perfSeries} width={760} height={160} padding={{ t: 8, r: 50, b: 8, l: 0 }} />
          </div>
        </div>
      </div>

      {/* Allocation + Performance attribution */}
      <div className="grid-2" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Allocation</h3>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>By position</span>
          </div>
          <div className="card-body" style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
            <Donut segments={allocSegments} size={160} thickness={28} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {p.holdings.slice(0, 7).map((h, i) => (
                <div key={h.sym} style={{ display: 'grid', gridTemplateColumns: '12px 1fr auto', gap: 8, alignItems: 'center', fontSize: 12 }}>
                  <span style={{ width: 10, height: 10, background: allocColors[i % allocColors.length], borderRadius: 2 }}></span>
                  <span className="ticker" style={{ fontSize: 12 }}>{h.sym}</span>
                  <span className="num" style={{ color: 'var(--text-muted)' }}>{h.weight.toFixed(1)}%</span>
                </div>
              ))}
              <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginTop: 4 }}>+ {p.holdings.length - 7} more</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Performance Attribution · Today</h3>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {[...p.holdings].sort((a, b) => Math.abs(b.gain * 0.01) - Math.abs(a.gain * 0.01)).slice(0, 6).map(h => {
              const dayContrib = h.value * (data.watchlist.find(w => w.sym === h.sym)?.chg || 0) / 100;
              return (
                <div key={h.sym} style={{
                  display: 'grid', gridTemplateColumns: '60px 1fr 80px', gap: 12,
                  padding: '10px 16px', borderBottom: '1px solid var(--border)', alignItems: 'center',
                }}>
                  <span className="ticker">{h.sym}</span>
                  <div style={{ position: 'relative', height: 18, background: 'var(--bg-sunken)', borderRadius: 3 }}>
                    <div style={{
                      position: 'absolute', left: '50%', top: 0, height: '100%',
                      width: `${Math.min(50, Math.abs(dayContrib) / 50)}%`,
                      background: dayContrib >= 0 ? 'var(--pos)' : 'var(--neg)',
                      transform: dayContrib >= 0 ? 'none' : 'translateX(-100%)',
                      borderRadius: 3,
                    }} />
                    <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--border-strong)' }} />
                  </div>
                  <span className={`num ${dayContrib >= 0 ? 'pos' : 'neg'}`} style={{ fontSize: 12, fontWeight: 600, textAlign: 'right' }}>
                    {dayContrib >= 0 ? '+' : ''}${fmtNum(Math.abs(dayContrib), 0)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Holdings table */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Holdings</h3>
          <div className="row">
            <button className="btn"><Icon name="filter" size={12} /> Filter</button>
            <button className="btn"><Icon name="download" size={12} /> Export</button>
          </div>
        </div>
        <div className="card-body flush">
          <table className="table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th className="right">Shares</th>
                <th className="right">Avg Cost</th>
                <th className="right">Last</th>
                <th className="right">Market Value</th>
                <th className="right">Total Gain</th>
                <th className="right">% Gain</th>
                <th className="right">Weight</th>
              </tr>
            </thead>
            <tbody>
              {p.holdings.map(h => (
                <tr key={h.sym} onClick={() => { setActiveAsset(h.sym); setPage('detail'); }}>
                  <td><span className="ticker">{h.sym}</span></td>
                  <td className="right num">{h.shares}</td>
                  <td className="right num" style={{ color: 'var(--text-muted)' }}>${fmtNum(h.avgCost)}</td>
                  <td className="right num">${fmtNum(h.price)}</td>
                  <td className="right num">${fmtNum(h.value, 0)}</td>
                  <td className={`right num ${h.gain >= 0 ? 'pos' : 'neg'}`}>{h.gain >= 0 ? '+' : ''}${fmtNum(Math.abs(h.gain), 0)}</td>
                  <td className="right"><Pill value={h.gainPct} /></td>
                  <td className="right num" style={{ color: 'var(--text-muted)' }}>{h.weight.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

window.PagePortfolio = PagePortfolio;
