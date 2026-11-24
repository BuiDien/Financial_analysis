// AI side panel (Hermes) — sends the question plus a context built from what is
// actually on screen (page, active asset, its live quote, live indices,
// portfolio). One conversation per page; a reply always lands in the thread of
// the page that asked, even if the user navigated away meanwhile.

import React from 'react';
import { handoff } from '../../../handoff.js';
import { HelixAPI } from '../../../api-client.jsx';
import { Badge, Button, IconButton, MarkdownText } from '../../../ui';
import { isModalOpen } from '../../../ui/Dialog.jsx';
import { FOCUSABLE } from '../../../ui/util.js';
import { QuoteStore, helixMarketFor } from '../../../watchlist-store.jsx';
import {
  AI_ASSET_PAGES, AI_SUGGESTIONS, aiGreeting, buildAiView, holdingFor, portfolioContext, readAiSettings, responseStyle,
} from './ai-context.js';
import { askModel } from './ai-request.js';
import './ai-panel.css';

// History sent to the model: error notices are never sent, and neither is the
// user turn that only got an error back (it would leave two user turns in a row).
const historyFor = (thread) => thread.filter((m, i) => !m.error && !(m.role === 'user' && thread[i + 1]?.error))
  .map(({ role, content }) => ({ role, content }));

const HERMES_STATE = { true: ['pos', 'Ready'], false: ['neg', 'Unavailable'], null: ['neutral', 'Checking…'] };

// drawer: narrow screens (≤ 900px) — the panel is a modal drawer over a backdrop (app.jsx): focus
// moves in, Tab is trapped, Esc closes, and focus returns to the opener.
const AIPanel = ({ page, activeAsset, data, live, onClose, drawer = false }) => {
  const [threads, setThreads] = React.useState({});
  const [pending, setPending] = React.useState({});   // page -> true while waiting
  const [input, setInput] = React.useState('');
  const [aiCfg, setAiCfg] = React.useState(readAiSettings);
  const [hermesUp, setHermesUp] = React.useState(null); // null = unknown
  const [fullscreen, setFullscreen] = React.useState(false);
  const bodyRef = React.useRef(null);
  const asideRef = React.useRef(null);
  const fullscreenRef = React.useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const messages = threads[page] || [];
  const loading = !!pending[page];
  const isHermes = (aiCfg.aiProvider || 'hermes') === 'hermes';

  // Re-read settings when the page changes; ask whether the Hermes gateway is ready.
  React.useEffect(() => {
    const cfg = readAiSettings();
    setAiCfg(cfg);
    if ((cfg.aiProvider || 'hermes') === 'hermes' && live) {
      HelixAPI.aiHealth().then(() => setHermesUp(true)).catch(() => setHermesUp(false));
    } else if (!live) setHermesUp(false);
  }, [page, live]);

  React.useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, loading]);

  // Esc leaves full screen.
  React.useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  // Drawer mode: focus in, trap Tab, Esc closes (full screen's own Esc handler wins while it's on).
  React.useEffect(() => {
    if (!drawer) return undefined;
    const el = asideRef.current;
    if (!el) return undefined;
    const opener = document.activeElement;
    (el.querySelector('textarea') || el).focus({ preventScroll: true });
    const onKey = (e) => {
      if (isModalOpen()) return;   // a dialog above the drawer owns the keyboard
      if (e.key === 'Escape') {
        if (!fullscreenRef.current) { e.preventDefault(); onCloseRef.current?.(); }
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(el.querySelectorAll(FOCUSABLE)).filter(n => n.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1], active = document.activeElement;
      if (!el.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body || el.contains(active))) opener.focus({ preventScroll: true });
    };
  }, [drawer]);

  // Close / unmount: stop waiting for every in-flight reply (no late state updates).
  const controllers = React.useRef(new Set());
  React.useEffect(() => () => { controllers.current.forEach(c => c.abort()); controllers.current.clear(); }, []);

  const append = (forPage, msg) => setThreads(t => ({ ...t, [forPage]: [...(t[forPage] || []), msg] }));

  // retry: re-ask the question of the trailing error notice (no new user bubble).
  const send = async (text, { retry = false } = {}) => {
    const q = (text || input).trim();
    const forPage = page;
    if (!q || pending[forPage]) return;
    const prior = threads[forPage] || [];
    const base = retry && prior[prior.length - 1]?.error ? prior.slice(0, -1) : [...prior, { role: 'user', content: q }];
    if (!retry) setInput('');
    setThreads(t => ({ ...t, [forPage]: base }));
    setPending(p => ({ ...p, [forPage]: true }));
    const ctrl = new AbortController();
    controllers.current.add(ctrl);
    let msg;
    try {
      const currentPortfolio = handoff.livePortfolioContext || (data?.portfolio?.status === 'ok' ? data.portfolio : null);
      const pfCtx = live && forPage === 'portfolio' ? portfolioContext(currentPortfolio) : '';
      if (live && activeAsset && AI_ASSET_PAGES.has(forPage)) {
        await QuoteStore.ensure([helixMarketFor(activeAsset, holdingFor(data, activeAsset)?.currency).market]);
      }
      const view = `${buildAiView({ page: forPage, activeAsset, data, live })}${pfCtx ? ` Live portfolio data: ${pfCtx}` : ''}`;
      const reply = await askModel({ question: q, page: forPage, context: { view, responseStyle: responseStyle() }, messages: historyFor(base), signal: ctrl.signal });
      msg = { role: 'assistant', content: reply };
    } catch (e) {
      if (ctrl.signal.aborted) return;   // panel closed: nothing to update
      msg = { role: 'assistant', error: true, question: q, retryable: e?.retryable !== false, content: e?.display || 'Connection issue. Try again.' };
    } finally {
      controllers.current.delete(ctrl);
    }
    if (ctrl.signal.aborted) return;
    append(forPage, msg);
    setPending(p => ({ ...p, [forPage]: false }));
  };

  const shown = [{ role: 'assistant', content: aiGreeting(page, activeAsset) }, ...messages];
  const [tone, stateLabel] = HERMES_STATE[String(hermesUp)];
  const last = messages[messages.length - 1];
  const announcement = loading ? 'Analyst is thinking…' : last?.role === 'assistant' ? last.content : '';

  return (
    <aside ref={asideRef} className={`ai aip${fullscreen ? ' is-full' : ''}${drawer ? ' is-drawer' : ''}`} aria-label="AI analyst"
      {...(drawer ? { role: 'dialog', 'aria-modal': 'true', tabIndex: -1 } : {})}>
      <div className="aip-head">
        <div className="aip-title">
          <span>{isHermes ? 'Hermes Analyst' : 'Helix Analyst'}</span>
          {isHermes && <Badge tone={tone} dot sans>{stateLabel}</Badge>}
        </div>
        <div className="aip-head-actions">
          <IconButton icon={fullscreen ? 'close' : 'expand'} size="sm" variant="ghost"
            label={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={() => setFullscreen(f => !f)} />
          {!fullscreen && <IconButton icon="close" size="sm" variant="ghost" label="Close panel" onClick={onClose} />}
        </div>
      </div>

      <div className="aip-body" ref={bodyRef}>
        <div className="aip-thread">
          {shown.map((m, i) => (
            <div key={i} className={`aip-msg is-${m.role === 'user' ? 'user' : 'bot'}${m.error ? ' is-error' : ''}`}>
              {m.error ? (
                <>
                  <MarkdownText text={m.content} variant="ai" />
                  {i === shown.length - 1 && m.retryable && live && (
                    <Button size="sm" icon="sync" onClick={() => send(m.question, { retry: true })} disabled={loading}>Retry</Button>
                  )}
                </>
              ) : <MarkdownText text={m.content} variant="ai" />}
            </div>
          ))}
          {loading && <div className="aip-msg is-bot aip-typing" aria-hidden="true"><i /><i /><i /></div>}
        </div>
      </div>
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>

      {(AI_SUGGESTIONS[page] || []).length > 0 && (
        <div className="aip-chips" aria-label="Suggested questions">
          {AI_SUGGESTIONS[page].map(s => (
            <button key={s} type="button" className="aip-chip" disabled={loading} onClick={() => send(s)}>{s}</button>
          ))}
        </div>
      )}

      <form className="aip-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea rows={2} aria-label="Ask the analyst" placeholder="Ask about markets, your portfolio, anything…"
          value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <IconButton type="submit" icon="send" label="Send" className="aip-send" disabled={loading || !input.trim()} />
      </form>
    </aside>
  );
};

export { AIPanel };
