// HelixAPI — single integration point between this frontend and the Python backend.
//
// HOW IT WORKS
//   1. Set the backend URL below (or via localStorage 'helix_api_url').
//   2. On load, HelixAPI pings GET {base}/health (1.5s timeout).
//   3. If reachable → HelixAPI.live = true and pages/AI use real endpoints.
//   4. If not → everything falls back to the built-in mock data. The UI works either way.
//
// To point at your local FastAPI server:
//   localStorage.setItem('helix_api_url', 'http://localhost:8000'); location.reload();
// To force mock mode:
//   localStorage.removeItem('helix_api_url'); location.reload();

const HELIX_DEFAULT_API = 'http://localhost:8000';

const HelixAPI = {
  base: localStorage.getItem('helix_api_url') || HELIX_DEFAULT_API,
  live: false,          // set true after a successful /health ping
  checked: false,
  listeners: [],

  onStatusChange(fn) { this.listeners.push(fn); },

  async detect() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${this.base}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      this.live = res.ok;
    } catch {
      this.live = false;
    }
    this.checked = true;
    this.listeners.forEach(fn => fn(this.live));
    return this.live;
  },

  async _get(path) {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return res.json();
  },

  async _send(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return res.json();
  },

  // ── Market ────────────────────────────────────────────────
  quote(ticker)                    { return this._get(`/api/quote/${ticker}`); },
  history(ticker, period = '1mo')  { return this._get(`/api/history/${ticker}?period=${period}`); },
  indices()                        { return this._get('/api/indices'); },
  screener(params = {})            { return this._get('/api/screener?' + new URLSearchParams(params)); },

  // ── Fundamentals ──────────────────────────────────────────
  statements(ticker, period = 'annual') { return this._get(`/api/statements/${ticker}?period=${period}`); },
  ratios(ticker)                   { return this._get(`/api/ratios/${ticker}`); },

  // ── Portfolio ─────────────────────────────────────────────
  portfolio()                      { return this._get('/api/portfolio'); },
  addHolding(h)                    { return this._send('POST', '/api/portfolio/holdings', h); },
  removeHolding(id)                { return this._send('DELETE', `/api/portfolio/holdings/${id}`); },

  // ── Filings ───────────────────────────────────────────────
  filings(ticker)                  { return this._get('/api/filings' + (ticker ? `?ticker=${ticker}` : '')); },
  async uploadFiling(file, meta) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('ticker', meta.ticker);
    fd.append('filing_type', meta.type);
    fd.append('period', meta.period);
    const res = await fetch(`${this.base}/api/filings/upload`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error('Upload failed');
    return res.json();
  },
  analyzeFiling(id)                { return this._send('POST', `/api/filings/${id}/analyze`); },
  ocrParse(id)                     { return this._send('POST', `/api/filings/${id}/ocr-parse`); },
  askFiling(id, question, section) { return this._send('POST', `/api/filings/${id}/ask`, { question, section }); },
  getTracker(id)                   { return this._get(`/api/filings/${id}/tracker`); },
  saveTracker(id, tracker)         { return this._send('PUT', `/api/filings/${id}/tracker`, { tracker }); },
  filingFileUrl(id)                { return `${this.base}/api/filings/${id}/file`; },
  deleteFiling(id)                 { return this._send('DELETE', `/api/filings/${id}`); },

  // ── Sync (distributed OCR coordinator) ─────────────────────────────
  // Drives backend/app/routes/sync.py: the Mac is the coordinator, worker
  // laptops connect to ws://<base>/ws/ocr with the pairing code.
  syncStatus()                     { return this._get('/api/sync/status'); },
  syncRegenCode()                  { return this._send('POST', '/api/sync/pair-code'); },
  syncDispatch(filingId)           { return this._send('POST', `/api/sync/dispatch/${filingId}`); },
  syncResult(jobId)                { return this._get(`/api/sync/result/${jobId}`); },
  syncWsUrl()                      { return this.base.replace(/^http/, 'ws') + '/ws/ocr'; },

  // ── AI chat (sidebar) ─────────────────────────────────────
  // messages: [{role, content}], page: 'dashboard' | ... , pageContext: {}
  async aiChat(page, pageContext, messages) {
    const out = await this._send('POST', '/api/ai/chat', { page, page_context: pageContext, messages });
    return out.answer;
  },

  // Read the user's saved AI settings (provider, hermes endpoint, etc.)
  _aiSettings() {
    try { return JSON.parse(localStorage.getItem('helix_settings_v1') || '{}'); }
    catch { return {}; }
  },

  // Call a locally-running Hermes agent (Ollama / LM Studio / llama.cpp).
  // Tries the Ollama /api/generate shape first, then the OpenAI-compatible
  // /v1/chat/completions shape that LM Studio + llama.cpp expose.
  async hermesComplete(prompt, settings) {
    const base = (settings.hermesEndpoint || 'http://localhost:11434').replace(/\/$/, '');
    const model = settings.hermesModel === 'custom' ? (settings.hermesModelCustom || 'hermes3') : (settings.hermesModel || 'hermes3');
    const temperature = settings.hermesTemperature ?? 0.4;
    const system = settings.hermesPersona || 'You are Hermes, a precise financial analysis agent. Be concise, numerical, and direct.';

    // 1) Ollama native
    try {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, system, stream: false, options: { temperature } }),
      });
      if (res.ok) { const j = await res.json(); if (j.response) return j.response; }
    } catch (e) { /* try next */ }

    // 2) OpenAI-compatible (LM Studio, llama.cpp server, vLLM)
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error('Hermes endpoint unreachable');
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  },

  // Unified completion helper.
  // Provider order: local Hermes (if selected) → Python backend (if live) → window.claude.
  async complete(prompt, { page = 'dashboard', context = {} } = {}) {
    const settings = this._aiSettings();
    if (settings.aiProvider === 'hermes') {
      try {
        return await this.hermesComplete(prompt, settings);
      } catch (e) {
        // If the user demanded on-device only, surface the failure instead of leaking to cloud
        if (settings.hermesKeepLocal) {
          return 'The local Hermes agent is unreachable. Start it (e.g. `ollama run hermes3`) or turn off "Keep everything on-device" in Settings → Hermes Agent.';
        }
        /* otherwise fall through to cloud */
      }
    }
    if (this.live) {
      try {
        return await this.aiChat(page, context, [{ role: 'user', content: prompt }]);
      } catch (e) { /* fall through to claude */ }
    }
    return window.claude.complete(prompt);
  },
};

// Kick off detection immediately (non-blocking)
HelixAPI.detect();

// Small status chip — drop <ApiStatusChip /> anywhere to show Live/Mock state
const ApiStatusChip = () => {
  const [live, setLive] = React.useState(HelixAPI.live);
  const [checked, setChecked] = React.useState(HelixAPI.checked);
  React.useEffect(() => {
    HelixAPI.onStatusChange(v => { setLive(v); setChecked(true); });
    if (HelixAPI.checked) { setLive(HelixAPI.live); setChecked(true); }
  }, []);
  if (!checked) return null;
  return (
    <span title={live ? `Connected to ${HelixAPI.base}` : 'Backend not reachable — using mock data. Run: uvicorn app.main:app --port 8000'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-mono)',
        padding: '2px 8px', borderRadius: 999, cursor: 'default',
        background: live ? 'var(--pos-bg)' : 'var(--bg-sunken)',
        color: live ? 'var(--pos)' : 'var(--text-subtle)',
        border: `1px solid ${live ? 'var(--pos-soft)' : 'var(--border)'}`,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: live ? 'var(--pos)' : 'var(--text-subtle)' }}></span>
      {live ? 'API Live' : 'Mock data'}
    </span>
  );
};

// Mock shim — window.claude.complete only exists inside the Claude artifact
// sandbox. In a plain browser with no backend (and no local Hermes), define a
// stub so AI features degrade to a canned reply instead of throwing
// ReferenceError. Real providers (Hermes / Python backend) take priority in
// complete() above; this only runs as the last-resort fallback.
if (!window.claude || typeof window.claude.complete !== 'function') {
  window.claude = {
    async complete(prompt) {
      await new Promise(r => setTimeout(r, 400));
      return '_[Mock AI — no backend connected]_\n\n' +
        'Start the FastAPI core and the local Hermes/Ollama agent to get real analysis. ' +
        'This placeholder confirms the AI wiring works end-to-end on mock data.';
    },
  };
}

window.HelixAPI = HelixAPI;
window.ApiStatusChip = ApiStatusChip;
