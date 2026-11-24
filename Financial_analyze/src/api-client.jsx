// HelixAPI — single integration point between this frontend and the Python backend.
//
// HOW IT WORKS
//   1. Set the backend URL below (or via localStorage 'helix_api_url').
//   2. On load, HelixAPI pings GET {base}/health (1.5s timeout, 3 tries).
//   3. If reachable → HelixAPI.live = true and pages/AI use real endpoints.
//      Live sections that fail show an empty/error state — never mock numbers.
//   4. If not → offline: pages show honest empty/error states. /health is re-checked
//      every 10s, and repeated connection failures flip a live session offline;
//      onStatusChange subscribers re-hydrate on every transition.
//
// To point at your local FastAPI server:
//   localStorage.setItem('helix_api_url', 'http://localhost:8000'); location.reload();

import React from 'react';
import { Badge } from './ui/Badge.jsx';

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

// Default request timeout. A hung upstream (Yahoo / vnstock) must never leave
// a page waiting forever; long-running calls pass their own `timeout`.
const HELIX_TIMEOUT_MS = 15000;
const HELIX_LONG_MS = 5 * 60 * 1000;     // AI chat, uploads, OCR/Hermes runs
const HELIX_REDETECT_MS = 10000;          // re-check /health while offline
const HELIX_HEARTBEAT_MS = 30000;         // /health heartbeat while live
const HELIX_FAIL_LIMIT = 3;               // consecutive network failures → offline

const abortError = () => Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
const aiFailure = (display, retryable) => Object.assign(new Error(display), { display, retryable });

// Reject with an AbortError as soon as `signal` aborts (for promises that can't be cancelled).
const untilAborted = (promise, signal) => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
};

const HelixAPI = {
  base: localStorage.getItem('helix_api_url') || HELIX_DEFAULT_API,
  live: false,          // true while /health answers
  checked: false,       // first detect() finished
  listeners: [],
  _netFails: 0,
  _redetectTimer: null,

  // fn(live) runs on every live/offline transition (and once after the
  // first check). Returns an unsubscribe function.
  onStatusChange(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(x => x !== fn); };
  },

  _setLive(v) {
    const changed = v !== this.live || !this.checked;
    this.live = v;
    this.checked = true;
    if (v) this._netFails = 0;
    if (changed) this.listeners.slice().forEach(fn => { try { fn(v); } catch (e) { console.error(e); } });
    this._scheduleRedetect();
  },

  // Offline: poll /health every 10s so a backend started later (or
  // restarted) is picked up without reloading. Live: a 30s heartbeat, so a
  // backend that dies while the app sits idle is noticed too (two misses).
  _scheduleRedetect() {
    clearTimeout(this._redetectTimer);
    if (!this.live) {
      this._redetectTimer = setTimeout(() => { this.detect(1); }, HELIX_REDETECT_MS);
      return;
    }
    this._redetectTimer = setTimeout(async () => {
      if (await this._ping()) { this._scheduleRedetect(); return; }
      this.detect(2);
    }, HELIX_HEARTBEAT_MS);
  },

  async _ping() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${this.base}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch { return false; }
  },

  async detect(attempts = 3) {
    // A cold backend (pandas/yfinance imports) can take longer than one
    // 1.5s ping, so the first check retries a few times.
    let ok = false;
    for (let i = 0; i < attempts; i++) {
      ok = await this._ping();
      if (ok || i === attempts - 1) break;
      await new Promise(r => setTimeout(r, 500));
    }
    this._setLive(ok);
    return ok;
  },

  // fetch with a timeout; tracks connection failures so a backend that dies
  // mid-session flips the app to offline instead of failing call by call.
  // init.signal (optional) is the caller's cancel: it is combined with the
  // timeout, and a caller abort rethrows as an AbortError (not a timeout).
  async _fetch(path, init = {}, timeout = HELIX_TIMEOUT_MS) {
    const { signal: callerSignal, ...rest } = init;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const onCallerAbort = () => ctrl.abort();
    if (callerSignal) {
      if (callerSignal.aborted) ctrl.abort();
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    try {
      const res = await fetch(`${this.base}${path}`, { ...rest, signal: ctrl.signal });
      this._netFails = 0;
      return res;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        if (callerSignal?.aborted) throw abortError();
        const err = new Error(`Request timed out after ${Math.round(timeout / 1000)}s: ${path}`);
        err.timeout = true;
        throw err;
      }
      // TypeError = connection refused / reset: the backend itself is gone.
      if (this.live && ++this._netFails >= HELIX_FAIL_LIMIT) this.detect(1);
      throw e;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  },

  async _get(path, { timeout } = {}) {
    const res = await this._fetch(path, {}, timeout);
    if (!res.ok) {
      let detail = `${res.status} ${path}`;
      try { detail = apiErrorDetail(await res.json()) || detail; } catch {}
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return res.json();
  },

  async _send(method, path, body, { timeout, signal } = {}) {
    const res = await this._fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    }, timeout);
    if (!res.ok) {
      let detail = `${res.status} ${path}`;
      let payload = null;
      try { payload = await res.json(); } catch {}
      // Structured 409s ({message, blocking}) read as their message; the raw detail stays on the error.
      if (payload) detail = (typeof payload.detail === 'object' && !Array.isArray(payload.detail) && payload.detail?.message) || apiErrorDetail(payload) || detail;
      const err = new Error(detail);
      err.status = res.status;
      err.detail = payload?.detail;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  },

  // ── Market ────────────────────────────────────────────────
  quote(ticker)                    { return this._get(`/api/quote/${ticker}`); },
  history(ticker, period = '1mo', interval = '1d', end = null) { return this._get(`/api/history/${ticker}?period=${period}&interval=${interval}${end ? `&end=${end}` : ''}`); },
  indices()                        { return this._get('/api/indices'); },

  // ── Backtest ──────────────────────────────────────────────
  backtestStrategies()             { return this._get('/api/backtest/strategies'); },
  backtestRun(body)                { return this._send('POST', '/api/backtest/run', body, { timeout: HELIX_LONG_MS }); },

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
  portfolioRealized()              { return this._get('/api/portfolio/realized'); },
  portfolioTickers()               { return this._get('/api/portfolio/tickers'); },
  portfolioTransactionsExportUrl(){ return `${this.base}/api/portfolio/transactions/export`; },
  portfolioStatementUrl()         { return `${this.base}/api/portfolio/statement`; },
  async portfolioImportPreview(file) {
    const fd = new FormData(); fd.append('file', file);
    const res = await this._fetch('/api/portfolio/imports/preview', { method: 'POST', body: fd }, HELIX_LONG_MS);
    if (!res.ok) {
      let detail = 'Import preview failed';
      try { detail = apiErrorDetail(await res.json()) || detail; } catch {}
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return res.json();
  },
  portfolioImportValidate(id, mapping) { return this._send('POST', `/api/portfolio/imports/${id}/validate`, { mapping }); },
  portfolioImportCommit(id)        { return this._send('POST', `/api/portfolio/imports/${id}/commit`, undefined, { timeout: HELIX_LONG_MS }); },
  portfolioImportErrorsUrl(id)     { return `${this.base}/api/portfolio/imports/${id}/errors`; },
  // Pasted SSI order rows: preview flags rows already in the ledger; commit re-parses server-side.
  portfolioPastePreview(text)      { return this._send('POST', '/api/portfolio/paste/preview', { text }); },
  portfolioPasteCommit(text, keys) { return this._send('POST', '/api/portfolio/paste/commit', { text, keys }, { timeout: HELIX_LONG_MS }); },

  // ── Alerts (backend-stored; same camelCase shape as the old localStorage list) ──
  alerts()                         { return this._get('/api/alerts'); },
  createAlert(alert)               { return this._send('POST', '/api/alerts', alert); },
  updateAlert(id, patch)           { return this._send('PATCH', `/api/alerts/${encodeURIComponent(id)}`, patch); },
  deleteAlert(id)                  { return this._send('DELETE', `/api/alerts/${encodeURIComponent(id)}`); },
  clearAlerts()                    { return this._send('DELETE', '/api/alerts'); },
  importAlerts(list)               { return this._send('POST', '/api/alerts/import', list); },

  // ── Background jobs (unified runner) ──────────────────────
  jobs(params = {}) {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    return this._get('/api/jobs' + (String(q) ? `?${q}` : ''));
  },
  job(id)                          { return this._get(`/api/jobs/${encodeURIComponent(id)}`); },
  cancelJob(id)                    { return this._send('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`); },

  // ── Filing tracker (written by the Sync page's OCR results) ───────
  saveTracker(id, tracker)         { return this._send('PUT', `/api/filings/${id}/tracker`, { tracker }); },

  // ── News ──────────────────────────────────────────────────
  news(limit = 30)                 { return this._get(`/api/news?limit=${limit}`); },
  newsSearch(q, count = 5, timeRange = 'week') { return this._get(`/api/news/search?q=${encodeURIComponent(q)}&count=${count}&time_range=${encodeURIComponent(timeRange)}`, { timeout: 45000 }); },
  newsArticle(url)                 { return this._get(`/api/news/article?url=${encodeURIComponent(url)}`, { timeout: 45000 }); },
  newsDailySummary()               { return this._get('/api/news/summary', { timeout: 30000 }); },

  // ── Sync (distributed OCR coordinator) ─────────────────────────────
  // Drives backend/app/routes/sync.py: the Mac is the coordinator, worker
  // laptops connect to ws://<base>/ws/ocr with the pairing code.
  syncStatus()                     { return this._get('/api/sync/status'); },
  syncRegenCode()                  { return this._send('POST', '/api/sync/pair-code'); },
  syncControlJob(jobId, action)    { return this._send('POST', `/api/sync/jobs/${jobId}/control`, { action }); },
  syncResult(jobId)                { return this._get(`/api/sync/result/${jobId}`); },
  syncWsUrl()                      { return this.base.replace(/^http/, 'ws') + '/ws/ocr'; },

  // ── OCR Inbox + human verification ──────────────────────────────
  // target: optional { ticker, scope, fiscal_year, period_code } labels for every uploaded PDF.
  async ocrInboxUpload(files, allowDuplicate = false, target = null) {
    const fd = new FormData();
    Array.from(files).forEach(file => fd.append('files', file));
    fd.append('allow_duplicate', allowDuplicate ? 'true' : 'false');
    Object.entries(target || {}).forEach(([k, v]) => { if (v !== null && v !== undefined && v !== '') fd.append(k, String(v)); });
    const res = await this._fetch('/api/ocr-inbox', { method: 'POST', body: fd }, HELIX_LONG_MS);
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
  ocrInboxRun(id)                  { return this._send('POST', `/api/ocr-inbox/${id}/run`, undefined, { timeout: HELIX_LONG_MS }); },
  ocrInboxRetry(id)                { return this._send('POST', `/api/ocr-inbox/${id}/retry`); },
  ocrInboxCancel(id)               { return this._send('POST', `/api/ocr-inbox/${id}/cancel`); },
  ocrInboxDelete(id)               { return this._send('DELETE', `/api/ocr-inbox/${id}`); },
  ocrInboxLabels(id, labels)       { return this._send('PATCH', `/api/ocr-inbox/${id}/labels`, labels); },
  ocrReviewReopen(itemId, revision, reason = null) { return this._send('POST', `/api/ocr-inbox/${itemId}/review/reopen`, { revision, reason }); },
  ocrInboxPublish(id)              { return this._send('POST', `/api/ocr-inbox/${id}/publish`, undefined, { timeout: 60000 }); },
  ocrReview(id)                    { return this._get(`/api/ocr-inbox/reviews/${id}`); },
  ocrReviewPage(reviewId, page)    { return this._get(`/api/ocr-inbox/reviews/${reviewId}/pages/${page}`); },
  ocrReviewAutoLevels(reviewId, page, revision, markdown) {
    return this._send('POST', `/api/ocr-inbox/reviews/${reviewId}/label-level-preview/pages/${page}`, { revision, markdown });
  },
  ocrReviewVerifyLevelTotals(reviewId, page, revision, markdown) {
    return this._send('POST', `/api/ocr-inbox/reviews/${reviewId}/level-total-preview/pages/${page}`, { revision, markdown });
  },
  ocrHermesLabelReviewStart(reviewId, page, revision, targets) {
    return this._send('POST', `/api/ocr-inbox/reviews/${reviewId}/pages/${page}/label-review-runs`, { revision, targets }, { timeout: HELIX_LONG_MS });
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

  // ── Company history (facts from verified OCR statements) ─────
  // answers: { revision, tables, lines, accepted_misreads, resolutions } (HistoryAnswersIn).
  historyPreview(reviewId, answers) { return this._send('POST', `/api/ocr-inbox/reviews/${reviewId}/history-preview`, answers, { timeout: 60000 }); },
  historyWrite(reviewId, answers)  { return this._send('POST', `/api/ocr-inbox/reviews/${reviewId}/history`, answers, { timeout: 60000 }); },
  historyRemove(itemId)            { return this._send('DELETE', `/api/ocr-inbox/${itemId}/history`); },
  // body: { statement_kind, fact_key, chosen_fact_id }
  historyResolve(ticker, scope, body) { return this._send('POST', `/api/history/${encodeURIComponent(ticker)}/${encodeURIComponent(scope)}/resolutions`, body); },
  historyCompanies()               { return this._get('/api/history/companies'); },
  historyLines(ticker, scope)      { return this._get(`/api/history/${encodeURIComponent(ticker)}/${encodeURIComponent(scope)}/lines`); },
  historySeries(ticker, scope, { lines = [], grain = 'quarter', from, to } = {}) {
    const params = new URLSearchParams({ lines: (Array.isArray(lines) ? lines : [lines]).join(','), grain });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return this._get(`/api/history/${encodeURIComponent(ticker)}/${encodeURIComponent(scope)}/series?${params}`);
  },

  // ── Screener (rules funnel) ───────────────────────────────
  // Drives backend/app/routes/screener.py. Broad-scan data is third-party
  // (vnstock) — keep it labelled UNVERIFIED in the UI.
  screenerRules()                  { return this._get('/api/screener/rules'); },
  screenerStrategies()             { return this._get('/api/screener/strategies'); },
  screenerCreateStrategy(name, rules) { return this._send('POST', '/api/screener/strategies', { name, rules }); },
  screenerUpdateStrategy(id, patch)   { return this._send('PUT', `/api/screener/strategies/${id}`, patch); },
  screenerDeleteStrategy(id)       { return this._send('DELETE', `/api/screener/strategies/${id}`); },
  screenerResetStrategy(id)        { return this._send('POST', `/api/screener/strategies/${id}/reset`); },
  screenerEvaluate(strategyId, rules) { return this._send('POST', '/api/screener/evaluate', { strategy_id: strategyId, rules }, { timeout: 60000 }); },
  notesList(symbol)                { return this._get(`/api/notes/${encodeURIComponent(symbol)}`); },
  notesAdd(symbol, body)           { return this._send('POST', `/api/notes/${encodeURIComponent(symbol)}`, { body }); },
  notesEdit(id, body)              { return this._send('PUT', `/api/notes/item/${id}`, { body }); },
  notesDelete(id)                  { return this._send('DELETE', `/api/notes/item/${id}`); },
  screenerState()                  { return this._get('/api/screener/state'); },
  screenerRefreshStatus()          { return this._get('/api/screener/refresh'); },
  screenerRefresh(kind)            { return this._send('POST', '/api/screener/refresh', { kind }, { timeout: 60000 }); },

  // ── AI chat (sidebar) ─────────────────────────────────────
  // messages: [{role, content}], page: 'dashboard' | ... , pageContext: {}
  // signal (optional) cancels the HTTP request itself (combined with the timeout).
  async aiChat(page, pageContext, messages, provider = 'hermes', { signal } = {}) {
    const out = await this._send('POST', '/api/ai/chat', { provider, page, page_context: pageContext, messages }, { timeout: HELIX_LONG_MS, signal });
    const answer = out?.answer;
    return typeof answer === 'string' ? answer : answer == null ? '' : JSON.stringify(answer);
  },

  aiHealth()                       { return this._get('/api/ai/health'); },

  // ── Gmail import (app password is write-only; stored in macOS Keychain) ──
  gmailSettings()                  { return this._get('/api/gmail/settings'); },
  saveGmailSettings(body)          { return this._send('PUT', '/api/gmail/settings', body); },
  removeGmailPassword()            { return this._send('DELETE', '/api/gmail/password'); },
  testGmail()                      { return this._send('POST', '/api/gmail/test'); },
  checkGmail()                     { return this._send('POST', '/api/gmail/check', undefined, { timeout: HELIX_LONG_MS }); },
  gmailReports(limit = 50)         { return this._get(`/api/gmail/reports?limit=${limit}`); },

  // Read the user's saved provider preference.
  _aiSettings() {
    try { return JSON.parse(localStorage.getItem('helix_settings_v1') || '{}'); }
    catch { return {}; }
  },

  // One AI round-trip. Hermes always flows through the Python backend, which owns
  // the API key and talks to the full agent (skills + MCP), not raw Ollama; the
  // window.claude stub only answers offline with the cloud provider.
  // Failures THROW an Error carrying `display` (the user-facing notice) and
  // `retryable` (false while the backend is offline); a `signal` abort throws an
  // AbortError and also cancels the HTTP request.
  async ask(prompt, { page = 'dashboard', context = {}, messages = null, signal } = {}) {
    const provider = this._aiSettings().aiProvider === 'claude' ? 'cloud' : 'hermes';
    const chatMessages = messages || [{ role: 'user', content: prompt }];
    if (signal?.aborted) throw abortError();
    if (this.live) {
      try {
        return await this.aiChat(page, context, chatMessages, provider, { signal });
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        const msg = e?.message || e;
        throw aiFailure(provider === 'hermes' ? `Hermes Agent is unavailable. ${msg}` : `The AI request failed. ${msg}`, true);
      }
    }
    if (provider === 'hermes') {
      throw aiFailure('Hermes Agent requires the Helix backend. Start FastAPI, then start Hermes with `hermes gateway run`.', false);
    }
    return untilAborted(window.claude.complete(prompt), signal);
  },

  // Unified completion helper: same as ask(), but a failure comes back as the
  // notice text instead of throwing.
  async complete(prompt, opts = {}) {
    try {
      return await this.ask(prompt, opts);
    } catch (e) {
      if (e?.display) return e.display;
      throw e;
    }
  },
};

// Kick off detection immediately (non-blocking)
HelixAPI.detect();

// React hook: { live, checked }, re-rendering on every status transition.
const useApiLive = () => {
  const [st, setSt] = React.useState(() => ({ live: HelixAPI.live, checked: HelixAPI.checked }));
  React.useEffect(() => {
    const off = HelixAPI.onStatusChange(() => setSt({ live: HelixAPI.live, checked: HelixAPI.checked }));
    setSt({ live: HelixAPI.live, checked: HelixAPI.checked });
    return off;
  }, []);
  return st;
};

// Small status chip — drop <ApiStatusChip /> anywhere to show Live/Offline state
const ApiStatusChip = () => {
  const { live, checked } = useApiLive();
  if (!checked) return null;
  return (
    <Badge tone={live ? 'pos' : 'neutral'} dot className="api-chip"
      title={live ? `Connected to ${HelixAPI.base}` : `Backend not reachable at ${HelixAPI.base} — retrying every 10s. Start it with scripts/run.sh`}>
      {live ? 'API Live' : 'Backend offline'}
    </Badge>
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

export { ApiStatusChip, HelixAPI, useApiLive };
