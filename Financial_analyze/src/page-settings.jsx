// Settings page — account, appearance, AI/backend, data & privacy.
// Appearance controls are wired to the live app theme state (props).
// Everything else persists to localStorage under 'helix_settings_v1'.

const SETTINGS_KEY = 'helix_settings_v1';

const DEFAULT_SETTINGS = {
  // Profile
  name: 'Jamie Morris',
  email: 'jamie.morris@example.com',
  plan: 'Pro',
  baseCurrency: 'USD',
  // Display
  numberFormat: 'compact', // compact (1.2B) | full (1,234M)
  fiscalLabels: true, // show FY/Q labels
  defaultLanding: 'dashboard',
  tickerTape: true,
  // AI
  aiProvider: 'hermes', // hermes (local) | claude (cloud)
  aiModel: 'claude-sonnet-4-5',
  aiTone: 'concise', // concise | detailed | numbers-only
  aiAutoSummary: true, // auto-generate summaries on filing upload
  // Local Hermes agent
  hermesEndpoint: 'http://localhost:11434', // Ollama default
  hermesModel: 'hermes3',
  hermesContextWindow: 32768, // always use the maximum
  hermesTemperature: 0.4,
  hermesKeepLocal: true, // never send filing text off-device
  // Backend
  backendUrl: 'http://localhost:8000',
  anthropicKeySet: false
};

const loadSettings = () => {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...DEFAULT_SETTINGS, ...s };
  } catch {return { ...DEFAULT_SETTINGS };}
};

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY'];
const LANDING_PAGES = [
{ id: 'last', label: 'Last visited' },
{ id: 'home', label: 'Home' },
{ id: 'dashboard', label: 'Dashboard' },
{ id: 'portfolio', label: 'Portfolio' },
{ id: 'statements', label: 'Financial Statements' },
{ id: 'news', label: 'News & Insights' }];


const PageSettings = ({ theme, setTheme, density, setDensity, accent, setAccent, accents }) => {
  const [settings, setSettings] = React.useState(loadSettings);
  const [section, setSection] = React.useState(() => localStorage.getItem('helix_settings_section') || 'account');
  const goToSection = (id) => {setSection(id);localStorage.setItem('helix_settings_section', id);};
  const [saved, setSaved] = React.useState(false);
  const [backendStatus, setBackendStatus] = React.useState(window.HelixAPI?.live ? 'live' : 'mock');
  const [testing, setTesting] = React.useState(false);
  const [showPlan, setShowPlan] = React.useState(false);
  const [hermesStatus, setHermesStatus] = React.useState('unknown'); // unknown | live | down | checking

  const set = (key, value) => {
    setSettings((s) => {
      const next = { ...s, [key]: value };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event('helix-settings-updated'));
      return next;
    });
    setSaved(true);
    clearTimeout(window.__settingsSaveT);
    window.__settingsSaveT = setTimeout(() => setSaved(false), 1500);
  };

  const testHermes = async () => {
    setHermesStatus('checking');
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      // Ollama exposes GET /api/tags; LM Studio / llama.cpp expose /v1/models
      let res;
      try {
        res = await fetch(`${settings.hermesEndpoint}/api/tags`, { signal: ctrl.signal });
      } catch {
        res = await fetch(`${settings.hermesEndpoint}/v1/models`, { signal: ctrl.signal });
      }
      clearTimeout(t);
      setHermesStatus(res && res.ok ? 'live' : 'down');
    } catch {
      setHermesStatus('down');
    }
  };

  const testBackend = async () => {
    setTesting(true);
    setBackendStatus('checking');
    if (window.HelixAPI) {
      window.HelixAPI.base = settings.backendUrl;
      localStorage.setItem('helix_api_url', settings.backendUrl);
      const live = await window.HelixAPI.detect();
      setBackendStatus(live ? 'live' : 'mock');
    }
    setTesting(false);
  };

  const SECTIONS = [
  { id: 'account', label: 'Account', icon: 'portfolio' },
  { id: 'appearance', label: 'Appearance', icon: 'eye' },
  { id: 'display', label: 'Data & Display', icon: 'screener' },
  { id: 'ai', label: 'Hermes Agent', icon: 'sparkle' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'settings' },
  { id: 'backend', label: 'Backend & API', icon: 'settings' },
  { id: 'data', label: 'Data & Privacy', icon: 'alerts' }];


  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings.</h1>
          <p className="page-sub">Manage your account, appearance, and how Helix works</p>
        </div>
        <div className="row">
          {saved &&
          <span style={{ fontSize: 12, color: 'var(--pos)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--pos)' }}></span>
              Saved
            </span>
          }
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 24, alignItems: 'start' }}>
        {/* Section nav */}
        <div style={{ position: 'sticky', top: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {SECTIONS.map((s) =>
          <button key={s.id} onClick={() => goToSection(s.id)}
          className="nav-item"
          aria-current={section === s.id ? 'page' : undefined}
          style={{ borderRadius: 6 }}>
              <Icon name={s.icon} className="icon" />
              <span>{s.label}</span>
            </button>
          )}
        </div>

        {/* Section content */}
        <div className="stack">
          {section === 'account' &&
          <SettingsCard title="Profile" subtitle="Your account details">
              <Field label="Full name">
                <input className="set-input" value={settings.name} onChange={(e) => set('name', e.target.value)} />
              </Field>
              <Field label="Email">
                <input className="set-input" type="email" value={settings.email} onChange={(e) => set('email', e.target.value)} />
              </Field>
              <Field label="Base currency" hint="Used across portfolio and statements">
                <select className="set-input" value={settings.baseCurrency} onChange={(e) => set('baseCurrency', e.target.value)}>
                  {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Plan">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span className="pill" style={{ background: 'var(--accent-bg)', color: 'var(--accent)' }}>{settings.plan}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>NYSE real-time · unlimited filings</span>
                  </span>
                  <button className="btn" onClick={() => setShowPlan(true)}>Manage plan</button>
                </div>
              </Field>
            </SettingsCard>
          }

          {section === 'appearance' &&
          <>
              <SettingsCard title="Theme" subtitle="Light or dark interface">
                <div style={{ display: 'flex', gap: 10 }}>
                  {['light', 'dark'].map((t) =>
                <button key={t} onClick={() => setTheme(t)}
                style={{
                  flex: 1, padding: 14, borderRadius: 8, cursor: 'pointer',
                  border: theme === t ? '2px solid var(--accent)' : '1px solid var(--border)',
                  background: t === 'light' ? '#FAFAF7' : '#0E0E0C',
                  color: t === 'light' ? '#1A1815' : '#F2EFE6',
                  textAlign: 'left', fontFamily: 'inherit'
                }}>
                      <div style={{ fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>{t}</div>
                      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{t === 'light' ? 'Bright & clean' : 'Easy on the eyes'}</div>
                      <div style={{ display: 'flex', gap: 3, marginTop: 10 }}>
                        {['#C2410C', t === 'light' ? '#E5E3DA' : '#26241F', t === 'light' ? '#6B6862' : '#9A968B'].map((c, i) =>
                    <span key={i} style={{ width: 18, height: 6, borderRadius: 3, background: c }}></span>
                    )}
                      </div>
                    </button>
                )}
                </div>
              </SettingsCard>

              <SettingsCard title="Accent color" subtitle="Highlights, links, and primary actions">
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {accents.map((a) =>
                <button key={a.id} onClick={() => setAccent(a.id)} title={a.label}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                  borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
                  border: accent === a.id ? '2px solid var(--text)' : '1px solid var(--border)',
                  background: 'var(--bg-sunken)', color: 'var(--text)'
                }}>
                      <span style={{ width: 16, height: 16, borderRadius: 4, background: a.id }}></span>
                      {a.label}
                    </button>
                )}
                </div>
              </SettingsCard>

              <SettingsCard title="Density" subtitle="Spacing in tables and lists">
                <SegmentedControl
                options={[{ id: 'compact', label: 'Compact' }, { id: 'normal', label: 'Normal' }, { id: 'comfortable', label: 'Comfortable' }]}
                value={density} onChange={setDensity} />
              </SettingsCard>
            </>
          }

          {section === 'display' &&
          <>
              <SettingsCard title="Number formatting" subtitle="How figures appear throughout the app">
                <SegmentedControl
                options={[{ id: 'compact', label: '1.2B' }, { id: 'full', label: '1,234M' }]}
                value={settings.numberFormat} onChange={(v) => set('numberFormat', v)} />
                <Toggle label="Show fiscal period labels" hint="Display FY / Q tags on statement columns"
              value={settings.fiscalLabels} onChange={(v) => set('fiscalLabels', v)} />
              </SettingsCard>

              <SettingsCard title="Layout" subtitle="Default views and chrome">
                <Field label="Landing page" hint="Where Helix opens on launch">
                  <select className="set-input" value={settings.defaultLanding} onChange={(e) => set('defaultLanding', e.target.value)}>
                    {LANDING_PAGES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </Field>
                <Toggle label="Ticker tape in header" hint="Scrolling index prices at the top"
              value={settings.tickerTape} onChange={(v) => set('tickerTape', v)} />
              </SettingsCard>
            </>
          }

          {section === 'ai' &&
          <SettingsCard title="AI Assistant" subtitle="Run analysis locally with Hermes, or use Claude in the cloud">
              <Field label="Provider" hint="Where the assistant runs">
                <SegmentedControl
                options={[{ id: 'hermes', label: 'Hermes (local)' }, { id: 'claude', label: 'Claude (cloud)' }]}
                value={settings.aiProvider} onChange={(v) => set('aiProvider', v)} />
              </Field>

              {settings.aiProvider === 'hermes' ?
            <>
                  <div style={{
                padding: 12, borderRadius: 8, background: 'var(--bg-sunken)',
                border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5
              }}>
                    The <strong style={{ color: 'var(--text)' }}>Hermes</strong> agent runs entirely on your machine via a local server
                    (Ollama, LM Studio, or llama.cpp). Filing text never leaves your device.
                  </div>

                  <Field label="Local endpoint" hint="Ollama default is :11434">
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input className="set-input" value={settings.hermesEndpoint}
                  onChange={(e) => set('hermesEndpoint', e.target.value)} style={{ flex: 1 }}
                  placeholder="http://localhost:11434" />
                      <button className="btn btn-primary" onClick={testHermes} disabled={hermesStatus === 'checking'}>
                        {hermesStatus === 'checking' ? 'Pinging…' : 'Test agent'}
                      </button>
                    </div>
                  </Field>

                  <div style={{
                padding: 12, borderRadius: 8,
                background: hermesStatus === 'live' ? 'var(--pos-bg)' : hermesStatus === 'down' ? 'var(--neg-bg)' : 'var(--bg-sunken)',
                border: `1px solid ${hermesStatus === 'live' ? 'var(--pos-soft)' : hermesStatus === 'down' ? 'var(--neg-soft)' : 'var(--border)'}`
              }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: hermesStatus === 'live' ? 'var(--pos)' : hermesStatus === 'down' ? 'var(--neg)' : 'var(--text-subtle)' }}></span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: hermesStatus === 'live' ? 'var(--pos)' : hermesStatus === 'down' ? 'var(--neg)' : 'var(--text)' }}>
                        {hermesStatus === 'live' ? 'Hermes agent reachable' : hermesStatus === 'down' ? 'Agent not reachable' : hermesStatus === 'checking' ? 'Checking…' : 'Not tested yet'}
                      </span>
                    </div>
                    {hermesStatus === 'down' &&
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5, fontFamily: 'var(--font-mono)' }}>
                        Start it with: ollama run {settings.hermesModel || 'hermes3'}
                      </div>
                }
                  </div>

                  <Field label="Model" hint="Must be pulled into your local server">
                    <select className="set-input" value={settings.hermesModel} onChange={(e) => set('hermesModel', e.target.value)}>
                      <option value="hermes3">Hermes 3 (8B · balanced)</option>
                      <option value="hermes3:70b">Hermes 3 70B (deepest)</option>
                      <option value="nous-hermes2">Nous Hermes 2</option>
                      <option value="nous-hermes2-mixtral">Nous Hermes 2 · Mixtral 8x7B</option>
                      <option value="custom">Custom (set in endpoint)</option>
                    </select>
                  </Field>

                  <Field label={`Temperature · ${settings.hermesTemperature}`} hint="Lower = more deterministic">
                    <SegmentedControl
                      options={[{ id: 0.1, label: 'Precise' }, { id: 0.4, label: 'Balanced' }, { id: 0.8, label: 'Creative' }]}
                      value={settings.hermesTemperature}
                      onChange={(v) => set('hermesTemperature', v)} />
                  </Field>

                  <Field label="Context window" hint="Always uses the maximum your model supports">
                    <div className="set-input" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--text-muted)', cursor: 'default' }}>
                      <span>Maximum available</span>
                      <span className="ticker" style={{ fontSize: 11, color: 'var(--text)' }}>32K tokens</span>
                    </div>
                  </Field>

                  <Toggle label="Keep everything on-device" hint="Block any cloud fallback — local agent only"
              value={settings.hermesKeepLocal} onChange={(v) => set('hermesKeepLocal', v)} />
                </> :

            <Field label="Model" hint="Runs in the cloud via your backend's API key">
                  <select className="set-input" value={settings.aiModel} onChange={(e) => set('aiModel', e.target.value)}>
                    <option value="claude-sonnet-4-5">Claude Sonnet 4.5 (recommended)</option>
                    <option value="claude-opus-4">Claude Opus 4 (deepest)</option>
                    <option value="claude-haiku-4">Claude Haiku 4 (fastest)</option>
                  </select>
                </Field>
            }
            </SettingsCard>
          }

          {section === 'shortcuts' &&
          <SettingsCard title="Keyboard Shortcuts" subtitle="Click any shortcut to record a new key combo. Press Shift + ? anytime to see the cheatsheet.">
              <ShortcutsEditor />
          </SettingsCard>
          }

          {section === 'backend' &&
          <SettingsCard title="Python Backend" subtitle="Connect to your FastAPI server for live data">
              <Field label="Backend URL" hint="Where your uvicorn server is running">
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="set-input" value={settings.backendUrl} onChange={(e) => set('backendUrl', e.target.value)} style={{ flex: 1 }} placeholder="http://localhost:8000" />
                  <button className="btn btn-primary" onClick={testBackend} disabled={testing}>
                    {testing ? 'Testing…' : 'Test connection'}
                  </button>
                </div>
              </Field>
              <div style={{
              padding: 14, borderRadius: 8, marginTop: 4,
              background: backendStatus === 'live' ? 'var(--pos-bg)' : 'var(--bg-sunken)',
              border: `1px solid ${backendStatus === 'live' ? 'var(--pos-soft)' : 'var(--border)'}`
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: backendStatus === 'live' ? 'var(--pos)' : 'var(--text-subtle)' }}></span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: backendStatus === 'live' ? 'var(--pos)' : 'var(--text)' }}>
                    {backendStatus === 'live' ? 'Connected — live data active' : backendStatus === 'checking' ? 'Checking…' : 'Not connected — using mock data'}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
                  {backendStatus === 'live' ?
                'Quotes, statements, filings, and AI now flow through your Python backend.' :
                'Start the server with: cd backend && uvicorn app.main:app --reload --port 8000'}
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12, padding: 12, background: 'var(--bg-sunken)', borderRadius: 6 }}>
                The Anthropic API key lives server-side in your <span className="ticker" style={{ fontSize: 11 }}>backend/.env</span> file — it is never stored in the browser.
              </div>
            </SettingsCard>
          }

          {section === 'data' &&
          <>
              <SettingsCard title="Local data" subtitle="Everything Helix stores in this browser">
                <DataRow label="Filing trackers" desc="Captured metrics & flags from the Reader" onClear={async () => {
                if (await window.askConfirm({ title: 'Clear tracker data', message: 'Clear all filing tracker data?', confirmText: 'Clear', danger: true })) {
                  Object.keys(localStorage).filter((k) => k.startsWith('helix_reader_tracker')).forEach((k) => localStorage.removeItem(k));
                  window.toast && window.toast('Tracker data cleared', { type: 'info' });
                }
              }} />
                <DataRow label="Uploaded filings" desc="PDF filing library metadata" onClear={async () => {
                if (await window.askConfirm({ title: 'Clear filings', message: 'Clear the filings library?', confirmText: 'Clear', danger: true })) { localStorage.removeItem('helix_filings_v1'); window.toast && window.toast('Filings cleared', { type: 'info' }); }
              }} />
                <DataRow label="Highlights & notes" desc="Saved reading highlights" onClear={async () => {
                if (await window.askConfirm({ title: 'Clear highlights', message: 'Clear highlights?', confirmText: 'Clear', danger: true })) { localStorage.removeItem('helix_reader_state_v1'); window.toast && window.toast('Highlights cleared', { type: 'info' }); }
              }} />
              </SettingsCard>

              <SettingsCard title="Export" subtitle="Take your data with you">
                <Toggle label="" hint="" hidden />
                <button className="btn" onClick={() => {
                const dump = {};
                Object.keys(localStorage).filter((k) => k.startsWith('helix_')).forEach((k) => dump[k] = localStorage.getItem(k));
                const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');a.href = url;a.download = 'helix-data-export.json';a.click();
                URL.revokeObjectURL(url);
              }}>
                  <Icon name="download" size={12} /> Export all data (JSON)
                </button>
              </SettingsCard>
            </>
          }
        </div>
      </div>
      {showPlan && <PlanModal current={settings.plan} onClose={() => setShowPlan(false)}
        onSelect={(pl) => { set('plan', pl); setShowPlan(false); window.toast && window.toast(`Plan set to ${pl}`, { type: 'success' }); }} />}
    </div>);

};

const PLAN_TIERS = [
  { id: 'Free', price: '$0', tagline: 'Get started', feats: ['15-min delayed quotes', '1 watchlist', '3 filings / month', 'Basic AI summaries'] },
  { id: 'Pro', price: '$29/mo', tagline: 'For active investors', feats: ['NYSE real-time data', 'Unlimited watchlists', 'Unlimited filings + OCR', 'Full AI analyst & briefings', 'Alerts & screener presets'] },
  { id: 'Desk', price: '$99/mo', tagline: 'For teams & desks', feats: ['Everything in Pro', 'Multi-laptop Sync workers', 'Priority data feeds', 'Team sharing & exports', 'Dedicated support'] },
];

const PlanModal = ({ current, onClose, onSelect }) =>
  <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'grid', placeItems: 'center', padding: 24 }}>
    <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 760, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 24px 64px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 className="serif" style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Choose your plan</h3>
        <button className="icon-btn" onClick={onClose} style={{ width: 28, height: 28 }}><Icon name="close" size={13} /></button>
      </div>
      <div style={{ padding: 20, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {PLAN_TIERS.map(t => {
          const active = current === t.id;
          return (
            <div key={t.id} style={{ border: active ? '2px solid var(--accent)' : '1px solid var(--border)', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, background: active ? 'var(--accent-bg)' : 'var(--bg-elev)' }}>
              <div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 15, fontWeight: 700 }}>{t.id}</span>
                  {active && <span className="pill" style={{ background: 'var(--accent)', color: '#fff' }}>Current</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.tagline}</div>
              </div>
              <div className="num" style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}>{t.price}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                {t.feats.map((f, i) => (
                  <div key={i} style={{ display: 'flex', gap: 7, fontSize: 12, color: 'var(--text-muted)' }}>
                    <span style={{ color: 'var(--pos)', fontWeight: 700 }}>✓</span> {f}
                  </div>
                ))}
              </div>
              <button className={active ? 'btn' : 'btn btn-primary'} disabled={active} onClick={() => onSelect(t.id)}>
                {active ? 'Current plan' : `Switch to ${t.id}`}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  </div>;

const SettingsCard = ({ title, subtitle, children }) =>
<div className="card">
    <div className="card-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
      <h3 className="card-title" style={{ textTransform: 'none', fontSize: 15, letterSpacing: 0, fontFamily: 'var(--font-serif)', color: 'var(--text)' }}>{title}</h3>
      {subtitle && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{subtitle}</span>}
    </div>
    <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {children}
    </div>
  </div>;


const Field = ({ label, hint, children }) =>
<div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
      <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{label}</label>
      {hint && <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{hint}</span>}
    </div>
    {children}
  </div>;


const Toggle = ({ label, hint, value, onChange, hidden }) => {
  if (hidden) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{hint}</div>}
      </div>
      <button onClick={() => onChange(!value)}
      style={{
        width: 40, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer',
        background: value ? 'var(--accent)' : 'var(--border-strong)',
        position: 'relative', transition: 'background 150ms', flexShrink: 0
      }}>
        <span style={{
          position: 'absolute', top: 2, left: value ? 20 : 2, width: 18, height: 18,
          borderRadius: '50%', background: 'white', transition: 'left 150ms',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
        }}></span>
      </button>
    </div>);

};

const SegmentedControl = ({ options, value, onChange }) =>
<div style={{ display: 'inline-flex', background: 'var(--bg-sunken)', borderRadius: 6, padding: 3, gap: 2 }}>
    {options.map((o) =>
  <button key={o.id} onClick={() => onChange(o.id)}
  style={{
    padding: '6px 14px', borderRadius: 4, border: 'none', cursor: 'pointer',
    fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
    background: value === o.id ? 'var(--bg-elev)' : 'transparent',
    color: value === o.id ? 'var(--text)' : 'var(--text-muted)',
    boxShadow: value === o.id ? '0 1px 2px rgba(0,0,0,0.06)' : 'none'
  }}>
        {o.label}
      </button>
  )}
  </div>;


const DataRow = ({ label, desc, onClear }) =>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '4px 0' }}>
    <div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{desc}</div>
    </div>
    <button className="btn" onClick={onClear} style={{ color: 'var(--neg)', borderColor: 'var(--neg-soft)' }}>Clear</button>
  </div>;


// Inject input styles
if (!document.getElementById('settings-style')) {
  const s = document.createElement('style');
  s.id = 'settings-style';
  s.textContent = `
    .set-input {
      width: 100%; padding: 9px 11px; font-size: 13px; font-family: inherit;
      background: var(--bg-sunken); border: 1px solid var(--border);
      border-radius: var(--radius); color: var(--text); outline: none;
    }
    .set-input:focus { border-color: var(--accent); }
  `;
  document.head.appendChild(s);
}

window.PageSettings = PageSettings;