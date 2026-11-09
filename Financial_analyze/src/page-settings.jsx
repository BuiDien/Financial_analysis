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

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'VND'];
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
  const [hermesModel, setHermesModel] = React.useState('');

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

  const setBaseCurrency = async (value) => {
    set('baseCurrency', value);
    if (!window.HelixAPI?.live) return;
    try {
      await window.HelixAPI.setPortfolioCurrency(value);
      window.toast?.(`Portfolio display currency is converting to ${value}`, { type: 'info' });
    } catch (e) {
      window.toast?.(`Could not change portfolio currency: ${e.message || e}`, { type: 'error' });
    }
  };

  const testHermes = async () => {
    setHermesStatus('checking');
    try {
      const status = await window.HelixAPI.aiHealth();
      setHermesModel(status.model || 'hermes-agent');
      setHermesStatus('live');
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
  { id: 'email', label: 'Email import', icon: 'download' },
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
                <select className="set-input" value={settings.baseCurrency} onChange={(e) => setBaseCurrency(e.target.value)}>
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
                    <strong style={{ color: 'var(--text)' }}>Hermes Agent</strong> runs on this machine with its skills,
                    memory, and financial MCP tools. The FastAPI backend keeps the agent API key out of the browser.
                  </div>

                  <Field label="Agent gateway" hint="Configured server-side in backend/.env">
                    <div style={{ display: 'flex', gap: 8 }}>
                      <div className="set-input" style={{ flex: 1, color: 'var(--text-muted)', cursor: 'default' }}>
                        FastAPI → Hermes Agent
                      </div>
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
                        Start FastAPI, then run: hermes gateway run
                      </div>
                }
                    {hermesStatus === 'live' && hermesModel &&
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5, fontFamily: 'var(--font-mono)' }}>
                        Model: {hermesModel}
                      </div>
                }
                  </div>
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
                Hermes and Anthropic API keys live server-side in your <span className="ticker" style={{ fontSize: 11 }}>backend/.env</span> file — they are never stored in the browser.
              </div>
            </SettingsCard>
          }

          {section === 'email' && <GmailImportCard />}

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

// Gmail import — the app password is sent to the local server once, stored in
// macOS Keychain, and never returned. The page only learns "password saved".
const GMAIL_INTERVALS = [15, 30, 60, 180, 720, 1440];
const gmailIntervalLabel = (m) => m < 60 ? `${m} min` : m === 1440 ? 'Daily' : `${m / 60} h`;
const gmailWhen = (iso) => {
  if (!iso) return 'never';
  const d = new Date(iso.endsWith('Z') || /[+-]\d\d:\d\d$/.test(iso) ? iso : iso + 'Z');
  return d.toLocaleString();
};

const GmailImportCard = () => {
  const live = window.HelixAPI?.live;
  const [cfg, setCfg] = React.useState(null);
  const [address, setAddress] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [replacing, setReplacing] = React.useState(false);
  const [busy, setBusy] = React.useState('');
  const [result, setResult] = React.useState(null); // {kind: ok|error, text}
  const [reports, setReports] = React.useState([]);

  const apply = (c) => { setCfg(c); setAddress(c.address || ''); setQuery(c.query || ''); };
  const loadReports = async () => { try { setReports((await window.HelixAPI.gmailReports(20)).reports); } catch {} };
  React.useEffect(() => {
    if (!live) return;
    window.HelixAPI.gmailSettings().then(apply).catch((e) => setResult({ kind: 'error', text: e.message }));
    loadReports();
  }, [live]);

  const run = async (label, fn) => {
    setBusy(label); setResult(null);
    try { await fn(); } catch (e) { setResult({ kind: 'error', text: e.message || String(e) }); }
    setBusy('');
  };

  const save = () => run('save', async () => {
    const body = { address, query };
    if (password.trim()) body.password = password;
    const c = await window.HelixAPI.saveGmailSettings(body);
    apply(c); setPassword(''); setReplacing(false);
    setResult({ kind: 'ok', text: body.password ? 'Saved. App password stored in macOS Keychain.' : 'Saved.' });
  });
  const test = () => run('test', async () => {
    const r = await window.HelixAPI.testGmail();
    setResult({ kind: 'ok', text: `Login OK · ${r.matches} matching email${r.matches === 1 ? '' : 's'} found` });
  });
  const check = () => run('check', async () => {
    const { summary: s, settings } = await window.HelixAPI.checkGmail();
    apply(settings); await loadReports();
    setResult({ kind: 'ok', text: s.new ? `Downloaded ${s.downloaded} new report${s.downloaded === 1 ? '' : 's'}${s.errors ? ` · ${s.errors} failed` : ''}` : `No new reports (${s.matches} matching, all already pulled)` });
  });
  const removePw = () => run('remove', async () => {
    if (!(await window.askConfirm({ title: 'Remove app password', message: 'Remove the Gmail app password from Keychain? Auto-check will turn off.', confirmText: 'Remove', danger: true }))) return;
    apply(await window.HelixAPI.removeGmailPassword());
    setResult({ kind: 'ok', text: 'App password removed.' });
  });
  const patch = (body) => run('save', async () => apply(await window.HelixAPI.saveGmailSettings(body)));

  if (!live) {
    return <SettingsCard title="Gmail import" subtitle="Pull broker trade reports from your inbox">
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Start the backend to configure Gmail import.</div>
    </SettingsCard>;
  }
  if (!cfg) return <SettingsCard title="Gmail import" subtitle="Loading…" />;

  const dirty = address !== (cfg.address || '') || query !== (cfg.query || '') || password.trim();
  const statusOk = cfg.last_status === 'ok';
  const summary = cfg.last_summary;

  return <>
    <SettingsCard title="Gmail import" subtitle="Pull broker trade reports (e.g. SSI “Thông báo kết quả giao dịch”) from your inbox">
      <Field label="Gmail address">
        <input className="set-input" type="email" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="you@gmail.com" autoComplete="off" />
      </Field>

      <Field label="App password" hint="16-letter code from myaccount.google.com/apppasswords">
        {cfg.password_saved && !replacing ?
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="set-input" style={{ flex: 1, color: 'var(--pos)', cursor: 'default' }}>✓ Saved in macOS Keychain</div>
            <button className="btn" onClick={() => setReplacing(true)}>Replace</button>
            <button className="btn" onClick={removePw} disabled={!!busy} style={{ color: 'var(--neg)', borderColor: 'var(--neg-soft)' }}>Remove</button>
          </div> :
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="set-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="xxxx xxxx xxxx xxxx" autoComplete="new-password" style={{ flex: 1 }} />
            {replacing && <button className="btn" onClick={() => { setReplacing(false); setPassword(''); }}>Cancel</button>}
          </div>}
      </Field>

      <Field label="Search filter" hint="Gmail search syntax, same as the Gmail search box">
        <input className="set-input" value={query} onChange={(e) => setQuery(e.target.value)} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} />
        {query !== cfg.default_query &&
          <button className="btn" style={{ marginTop: 6, fontSize: 11 }} onClick={() => setQuery(cfg.default_query)}>Reset to SSI default</button>}
      </Field>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={save} disabled={!dirty || !!busy}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        <button className="btn" onClick={test} disabled={!cfg.password_saved || !cfg.address || dirty || !!busy}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
        <button className="btn" onClick={check} disabled={!cfg.password_saved || !cfg.address || dirty || !!busy}>{busy === 'check' ? 'Checking…' : 'Check now'}</button>
      </div>

      {result &&
        <div style={{ padding: 12, borderRadius: 8, fontSize: 12, lineHeight: 1.5,
          background: result.kind === 'ok' ? 'var(--pos-bg)' : 'var(--neg-bg)',
          border: `1px solid ${result.kind === 'ok' ? 'var(--pos-soft)' : 'var(--neg-soft)'}`,
          color: result.kind === 'ok' ? 'var(--pos)' : 'var(--neg)' }}>{result.text}</div>}

      <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 12, background: 'var(--bg-sunken)', borderRadius: 6, lineHeight: 1.5 }}>
        Read-only: Helix never sends, deletes, or marks mail as read. The app password stays on this Mac (Keychain) and is never shown again or sent to the browser.
      </div>
    </SettingsCard>

    <SettingsCard title="Auto-check" subtitle="The server checks Gmail in the background while it is running">
      <Toggle label="Check Gmail automatically" hint={cfg.password_saved && cfg.address ? 'New reports are downloaded once; repeats are skipped' : 'Save address and app password first'}
        value={cfg.enabled} onChange={(v) => patch({ enabled: v })} />
      <Field label="Every">
        <select className="set-input" value={cfg.interval_minutes} onChange={(e) => patch({ interval_minutes: Number(e.target.value) })}>
          {GMAIL_INTERVALS.map((m) => <option key={m} value={m}>{gmailIntervalLabel(m)}</option>)}
        </select>
      </Field>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: !cfg.last_status ? 'var(--text-subtle)' : statusOk ? 'var(--pos)' : 'var(--neg)' }}></span>
        <span style={{ color: 'var(--text-muted)' }}>
          Last check: {gmailWhen(cfg.last_checked_at)}
          {statusOk && summary && ` · ${summary.matches} matching, ${summary.new} new`}
        </span>
      </div>
      {cfg.last_status === 'error' && cfg.last_error &&
        <div style={{ fontSize: 12, color: 'var(--neg)', fontFamily: 'var(--font-mono)' }}>{cfg.last_error}</div>}
    </SettingsCard>

    <SettingsCard title="Pulled reports" subtitle="Saved locally in backend/data/gmail_reports — not imported into the portfolio yet">
      {reports.length === 0 ?
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Nothing pulled yet. Click “Check now”.</div> :
        <table className="table" style={{ width: '100%', fontSize: 12 }}>
          <thead><tr><th style={{ textAlign: 'left' }}>Received</th><th style={{ textAlign: 'left' }}>Subject</th><th style={{ textAlign: 'left' }}>Attachment</th><th style={{ textAlign: 'left' }}>Status</th></tr></thead>
          <tbody>{reports.map((r) =>
            <tr key={r.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{gmailWhen(r.received_at)}</td>
              <td>{r.subject}</td>
              <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.attachments.map((a) => <div key={a.filename}>{a.filename}{a.encrypted ? ' 🔒' : ''}</div>)}</td>
              <td style={{ color: r.status === 'downloaded' ? 'var(--pos)' : r.status === 'error' ? 'var(--neg)' : 'var(--text-muted)' }} title={r.error || ''}>{r.status === 'no_pdf' ? 'no PDF' : r.status}</td>
            </tr>)}
          </tbody>
        </table>}
    </SettingsCard>
  </>;
};

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
