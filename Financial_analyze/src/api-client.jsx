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

const apiErrorDetail = payload => {
  const detail = payload?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map(issue => {
      const field = Array.isArray(issue?.loc) ? issue.loc.slice(1).join('.') : '';
      return field ? `${field}: ${issue.msg || 'invalid value'}` : (issue?.msg || 'invalid request');
    }).join('; ');
  }
  return detail && typeof detail === 'object' ? JSON.stringify(detail) : '';
};

const HelixAPI = {
  base: localStorage.getItem('helix_api_url') || HELIX_DEFAULT_API,
  live: false,          // set true after a successful /health ping
  checked: false,
  listeners: [],

  onStatusChange(fn) { this.listeners.push(fn); },

  async detect() {
    // A cold backend (pandas/yfinance/anthropic imports) can take longer to
    // answer than one 1.5s ping — a single failed check used to lock `live`
    // false for the rest of the page session (nothing ever re-checked it).
    // Retry a few times before giving up.
    const ATTEMPTS = 3;
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const res = await fetch(`${this.base}/health`, { signal: ctrl.signal });
        clearTimeout(t);
        this.live = res.ok;
      } catch {
        this.live = false;
      }
      if (this.live || i === ATTEMPTS - 1) break;
      await new Promise(r => setTimeout(r, 500));
    }
    this.checked = true;
    this.listeners.forEach(fn => fn(this.live));
    return this.live;
  },

  async _get(path) {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) {
      let detail = `${res.status} ${path}`;
      try { detail = apiErrorDetail(await res.json()) || detail; } catch {}
      throw new Error(detail);
    }
    return res.json();
  },

  async _send(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let detail = `${res.status} ${path}`;
      try { detail = apiErrorDetail(await res.json()) || detail; } catch {}
      throw new Error(detail);
    }
    return res.json();
  },

  // ── Market ────────────────────────────────────────────────
  quote(ticker)                    { return this._get(`/api/quote/${ticker}`); },
  history(ticker, period = '1mo', interval = '1d') { return this._get(`/api/history/${ticker}?period=${period}&interval=${interval}`); },
  indices()                        { return this._get('/api/indices'); },
  screener(params = {})            { return this._get('/api/screener?' + new URLSearchParams(params)); },

  // ── Fundamentals ──────────────────────────────────────────
  statements(ticker, period = 'annual') { return this._get(`/api/statements/${ticker}?period=${period}`); },
  ratios(ticker)                   { return this._get(`/api/ratios/${ticker}`); },

  // ── Portfolio ─────────────────────────────────────────────
  portfolio(currency)              { return this._get('/api/portfolio' + (currency ? `?currency=${encodeURIComponent(currency)}` : '')); },
  portfolioPerformance(range = '1y') { return this._get(`/api/portfolio/performance?range=${encodeURIComponent(range)}`); },
  portfolioTransactions(params = {}) { return this._get('/api/portfolio/transactions?' + new URLSearchParams(params)); },
  addTransaction(tx)               { return this._send('POST', '/api/portfolio/transactions', tx); },
  replaceTransaction(id, tx)       { return this._send('PATCH', `/api/portfolio/transactions/${id}`, tx); },
  voidTransaction(id)              { return this._send('DELETE', `/api/portfolio/transactions/${id}`); },
  setPortfolioCurrency(display_currency) { return this._send('PATCH', '/api/portfolio/preferences', { display_currency }); },
  portfolioJob(id)                 { return this._get(`/api/portfolio/jobs/${id}`); },
  portfolioTransactionsExportUrl(){ return `${this.base}/api/portfolio/transactions/export`; },
  portfolioStatementUrl()         { return `${this.base}/api/portfolio/statement`; },
  async portfolioImportPreview(file) {
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`${this.base}/api/portfolio/imports/preview`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).detail || 'Import preview failed');
    return res.json();
  },
  portfolioImportValidate(id, mapping) { return this._send('POST', `/api/portfolio/imports/${id}/validate`, { mapping }); },
  portfolioImportCommit(id)        { return this._send('POST', `/api/portfolio/imports/${id}/commit`); },
  portfolioImportErrorsUrl(id)     { return `${this.base}/api/portfolio/imports/${id}/errors`; },
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
    if (!res.ok) {
      let detail = 'Upload failed';
      try { detail = (await res.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    return res.json();
  },
  analyzeFiling(id)                { return this._send('POST', `/api/filings/${id}/analyze`); },
  ocrParse(id)                     { return this._send('POST', `/api/filings/${id}/ocr-parse`); },
  askFiling(id, question, section) { return this._send('POST', `/api/filings/${id}/ask`, { question, section }); },
  getTracker(id)                   { return this._get(`/api/filings/${id}/tracker`); },
  saveTracker(id, tracker)         { return this._send('PUT', `/api/filings/${id}/tracker`, { tracker }); },
  filingFileUrl(id)                { return `${this.base}/api/filings/${id}/file`; },
  deleteFiling(id)                 { return this._send('DELETE', `/api/filings/${id}`); },

  // ── News ──────────────────────────────────────────────────
  news(limit = 30)                 { return this._get(`/api/news?limit=${limit}`); },
  newsSearch(q, count = 5, timeRange = 'week') { return this._get(`/api/news/search?q=${encodeURIComponent(q)}&count=${count}&time_range=${encodeURIComponent(timeRange)}`); },
  newsArticle(url)                 { return this._get(`/api/news/article?url=${encodeURIComponent(url)}`); },
  newsDailySummary()               { return this._get('/api/news/summary'); },

  // ── Sync (distributed OCR coordinator) ─────────────────────────────
  // Drives backend/app/routes/sync.py: the Mac is the coordinator, worker
  // laptops connect to ws://<base>/ws/ocr with the pairing code.
  syncStatus()                     { return this._get('/api/sync/status'); },
  syncRegenCode()                  { return this._send('POST', '/api/sync/pair-code'); },
  syncDispatch(filingId)           { return this._send('POST', `/api/sync/dispatch/${filingId}`); },
  syncControlJob(jobId, action)    { return this._send('POST', `/api/sync/jobs/${jobId}/control`, { action }); },
  syncResult(jobId)                { return this._get(`/api/sync/result/${jobId}`); },
  syncWsUrl()                      { return this.base.replace(/^http/, 'ws') + '/ws/ocr'; },

  // ── OCR Inbox + human verification ──────────────────────────────
  async ocrInboxUpload(files, allowDuplicate = false) {
    const fd = new FormData();
    Array.from(files).forEach(file => fd.append('files', file));
    fd.append('allow_duplicate', allowDuplicate ? 'true' : 'false');
    const res = await fetch(`${this.base}/api/ocr-inbox`, { method: 'POST', body: fd });
    if (!res.ok) {
      let detail = 'OCR Inbox upload failed';
      try {
        const body = await res.json();
        detail = typeof body.detail === 'string' ? body.detail : (body.detail?.message || detail);
        const err = new Error(detail);
        err.status = res.status;
        err.detail = body.detail;
        throw err;
      } catch (e) { if (e.status) throw e; }
      throw new Error(detail);
    }
    return res.json();
  },
  ocrInbox(status)                 { return this._get('/api/ocr-inbox' + (status ? `?status=${encodeURIComponent(status)}` : '')); },
  ocrInboxItem(id)                 { return this._get(`/api/ocr-inbox/${id}`); },
  ocrInboxFileUrl(id)              { return `${this.base}/api/ocr-inbox/${id}/file`; },
  ocrInboxPageUrl(id, page)        { return `${this.base}/api/ocr-inbox/${id}/pages/${page}`; },
  ocrInboxRun(id)                  { return this._send('POST', `/api/ocr-inbox/${id}/run`); },
  ocrInboxRetry(id)                { return this._send('POST', `/api/ocr-inbox/${id}/retry`); },
  ocrInboxCancel(id)               { return this._send('POST', `/api/ocr-inbox/${id}/cancel`); },
  ocrInboxDelete(id)               { return this._send('DELETE', `/api/ocr-inbox/${id}`); },
  ocrInboxLabels(id, labels)       { return this._send('PATCH', `/api/ocr-inbox/${id}/labels`, labels); },
  ocrInboxPublish(id)              { return this._send('POST', `/api/ocr-inbox/${id}/publish`); },
  ocrReview(id)                    { return this._get(`/api/ocr-inbox/reviews/${id}`); },
  ocrReviewPage(reviewId, page)    { return this._get(`/api/ocr-inbox/reviews/${reviewId}/pages/${page}`); },
  ocrReviewAutoLevels(reviewId, page, revision, markdown) {
    return this._send('POST', `/api/ocr-inbox/reviews/${reviewId}/label-level-preview/pages/${page}`, { revision, markdown });
  },
  ocrReviewVerifyLevelTotals(reviewId, page, revision, markdown) {
    return this._send('POST', `/api/ocr-inbox/reviews/${reviewId}/level-total-preview/pages/${page}`, { revision, markdown });
  },
  ocrHermesLabelReviewStart(reviewId, page, revision, targets) {
    return this._send('POST', `/api/ocr-inbox/reviews/${reviewId}/pages/${page}/label-review-runs`, { revision, targets });
  },
  ocrHermesLabelReviewLatest(reviewId, page) {
    return this._get(`/api/ocr-inbox/reviews/${reviewId}/pages/${page}/label-review-runs/latest`);
  },
  ocrHermesLabelReviewRun(reviewId, page, runId) {
    return this._get(`/api/ocr-inbox/reviews/${reviewId}/pages/${page}/label-review-runs/${runId}`);
  },
  ocrHermesLabelSuggestionDecision(suggestionId, decision, userEditedLevel = null) {
    return this._send('POST', `/api/ocr-inbox/label-suggestions/${suggestionId}/decision`, { decision, user_edited_level: userEditedLevel });
  },
  ocrHermesLabelSuggestionsApply(reviewId, page, revision, pageContentSha256, suggestionIds) {
    return this._send('POST', `/api/ocr-inbox/reviews/${reviewId}/pages/${page}/apply-label-suggestions`, { revision, page_content_sha256: pageContentSha256, suggestion_ids: suggestionIds });
  },
  ocrReviewPageAction(reviewId, page, action, revision, markdown = null) {
    return this._send('POST', `/api/ocr-inbox/reviews/${reviewId}/pages/${page}/${action}`, { revision, markdown });
  },
  ocrReviewMarkdownUrl(reviewId, source = 'effective') {
    return `${this.base}/api/ocr-inbox/reviews/${reviewId}/markdown?source=${encodeURIComponent(source)}`;
  },
  ocrReviewAction(reviewId, rowId, action, revision, data, reason) {
    return this._send('POST', `/api/ocr-inbox/reviews/${reviewId}/rows/${rowId}/${action}`, { revision, data, reason });
  },
  ocrReviewAdd(reviewId, revision, data) { return this._send('POST', `/api/ocr-inbox/reviews/${reviewId}/rows`, { revision, data }); },
  ocrReviewVerify(reviewId, revision) { return this._send('POST', `/api/ocr-inbox/reviews/${reviewId}/verify`, { revision }); },

  // ── VN Market Scanner (broad scan tier) ───────────────────
  // Drives backend/app/routes/scan.py. Results are third-party (vnstock)
  // data, always verified=false — screening only, deep-dive to verify.
  scanLatest()                     { return this._get('/api/scan/latest'); },
  scanRun(limit = null)            { return this._send('POST', '/api/scan', { limit }); },

  // ── AI chat (sidebar) ─────────────────────────────────────
  // messages: [{role, content}], page: 'dashboard' | ... , pageContext: {}
  async aiChat(page, pageContext, messages, provider = 'hermes') {
    const out = await this._send('POST', '/api/ai/chat', { provider, page, page_context: pageContext, messages });
    return out.answer;
  },

  aiHealth()                       { return this._get('/api/ai/health'); },

  // Read the user's saved provider preference.
  _aiSettings() {
    try { return JSON.parse(localStorage.getItem('helix_settings_v1') || '{}'); }
    catch { return {}; }
  },

  // Unified completion helper. Hermes always flows through the Python backend,
  // which owns the API key and talks to the full agent (skills + MCP), not raw Ollama.
  async complete(prompt, { page = 'dashboard', context = {}, messages = null } = {}) {
    const settings = this._aiSettings();
    const provider = settings.aiProvider === 'claude' ? 'cloud' : 'hermes';
    const chatMessages = messages || [{ role: 'user', content: prompt }];
    if (this.live) {
      try {
        return await this.aiChat(page, context, chatMessages, provider);
      } catch (e) {
        if (provider === 'hermes') return `Hermes Agent is unavailable. ${e.message || e}`;
      }
    }
    if (provider === 'hermes') {
      return 'Hermes Agent requires the Helix backend. Start FastAPI, then start Hermes with `hermes gateway run`.';
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
