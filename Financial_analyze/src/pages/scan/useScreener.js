// Screener state: catalog + strategies, working rules, debounced server-side evaluation,
// refresh polling and the strategy actions (save / save as / rename / reset / delete).

import React from 'react';
import * as SP from './screener-plain.js';
import { HelixAPI } from '../../api-client.jsx';
import { askConfirm, askPrompt, toast as uiToast } from '../../ui/index.js';
import { scrDefaultCfg, scrNormalize, scrPayload } from './screener-model.js';

const toast = (msg, type = 'info') => uiToast(msg, { type });
const doneKey = (st) => `${st.running}:${st.kind}:${st.done}`;

export const useScreener = () => {
  const api = HelixAPI;
  const [catalog, setCatalog] = React.useState(null);
  const [strategies, setStrategies] = React.useState([]);
  const [activeId, setActiveId] = React.useState(null);
  const [rules, setRules] = React.useState([]);          // working copy
  const [result, setResult] = React.useState(null);      // last good evaluate response
  const [loadErr, setLoadErr] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [evaluating, setEvaluating] = React.useState(false);
  const [rstatus, setRstatus] = React.useState(null);    // GET /refresh
  const lastDone = React.useRef('');
  const seq = React.useRef(0);
  const timer = React.useRef(null);

  const active = strategies.find(s => s.id === activeId) || null;
  const dirty = !!(catalog && active) &&
    JSON.stringify(scrNormalize(catalog, rules)) !== JSON.stringify(scrNormalize(catalog, active.rules));
  const isStarter = !!(active && active.starter_key);
  // Easy / Normal / Strict: Normal = the strategy as saved; the others move every number one step.
  const level = catalog && active ? SP.detectLevel(catalog, active.rules, rules) : 'normal';

  // Debounced evaluation (250 ms). seq is bumped when an evaluate is SCHEDULED, so any older
  // in-flight response (or pending timer) can never paint over newer rules. Failures keep the last good result.
  const evaluate = (nextRules, strategyId, immediate = false, cat = catalog) => {
    clearTimeout(timer.current);
    const mine = ++seq.current;
    const run = async () => {
      const payload = scrPayload(cat, nextRules);
      if (!payload) { setEvaluating(false); return; }    // a field is blank; wait for a number
      setEvaluating(true);
      try {
        const res = await api.screenerEvaluate(strategyId ?? null, payload);
        if (mine === seq.current) setResult(res);
      } catch (e) {
        if (mine === seq.current) toast(e.message || 'Evaluate failed', 'error');
      } finally {
        if (mine === seq.current) setEvaluating(false);
      }
    };
    if (immediate) run(); else timer.current = setTimeout(run, 250);
  };

  // Latest values for async callbacks (polling) without stale closures.
  const latest = React.useRef({});
  latest.current = { rules, activeId, dirty, catalog };

  // Refresh polling: every 5 s only while a refresh runs or is queued.
  const busy = !!(rstatus && (rstatus.running || (rstatus.queued || []).length));
  React.useEffect(() => {
    if (!busy) return undefined;
    const iv = setInterval(async () => {
      try {
        const st = await api.screenerRefreshStatus();
        const prev = lastDone.current;
        lastDone.current = doneKey(st);
        setRstatus(st);
        if (lastDone.current !== prev) {
          const L = latest.current;
          evaluate(L.rules, L.dirty ? null : L.activeId, true, L.catalog);
        }
      } catch (e) { /* transient; next tick retries */ }
    }, 5000);
    return () => clearInterval(iv);
  }, [busy]);

  const requestRefresh = async (kind) => {
    try {
      const st = await api.screenerRefresh(kind);
      lastDone.current = doneKey(st);
      setRstatus(st);
    } catch (e) {
      toast(e.status === 409 ? 'Already refreshing' : (e.message || 'Refresh failed'), e.status === 409 ? 'info' : 'error');
      if (e.status === 409) {
        try { const st = await api.screenerRefreshStatus(); lastDone.current = doneKey(st); setRstatus(st); } catch (e2) { /* ignore */ }
      }
    }
  };

  // Load: catalog + strategies + last used strategy. Also used by the offline Retry.
  const dead = React.useRef(false);
  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, strats, state] = await Promise.all([api.screenerRules(), api.screenerStrategies(), api.screenerState()]);
      api.screenerRefreshStatus().then(st => { if (!dead.current) { lastDone.current = doneKey(st); setRstatus(st); } }).catch(() => {});
      if (dead.current) return;
      const pick = strats.find(s => s.id === state?.last_strategy_id) || strats.find(s => s.starter_key === 'quality') || strats[0];
      setLoadErr(null);
      setCatalog(rulesRes.catalog);
      setStrategies(strats);
      if (pick) {
        setActiveId(pick.id);
        setRules(pick.rules);
        evaluate(pick.rules, pick.id, true, rulesRes.catalog);
      }
    } catch (e) {
      if (!dead.current) setLoadErr(e.message || 'Could not load the screener');
    } finally {
      if (!dead.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    dead.current = false;
    load();
    return () => { dead.current = true; clearTimeout(timer.current); };
  }, [load]);

  const selectStrategy = async (s) => {
    if (s.id === activeId) return;
    if (dirty && !(await askConfirm({ title: 'Discard changes', message: `Discard your unsaved changes to “${active.name}”?`, confirmText: 'Discard', danger: true }))) return;
    setActiveId(s.id);
    setRules(s.rules);
    evaluate(s.rules, s.id, true);
  };

  const editRule = (id, patch) => {
    const spec = catalog[id];
    const next = rules.some(r => r.id === id)
      ? rules.map(r => r.id === id ? { ...r, ...patch } : r)
      : [...rules, { ...scrDefaultCfg(spec), ...patch }];
    setRules(next);
    evaluate(next, null);   // modified rules are not the stored strategy — don't record them as last-used
  };

  const setLevel = (lv) => {
    if (!active || !SP.LEVELS.includes(lv)) return;
    const next = SP.applyLevel(catalog, active.rules, lv);
    setRules(next);
    evaluate(next, lv === 'normal' ? active.id : null, true);
  };

  const refreshList = async () => {
    const strats = await api.screenerStrategies();
    setStrategies(strats);
    return strats;
  };

  const save = async () => {
    const payload = scrPayload(catalog, rules);
    if (!payload) return toast('Fill in every number first', 'error');
    try {
      const s = await api.screenerUpdateStrategy(activeId, { rules: payload });
      await refreshList();
      setRules(s.rules);
      toast(`Saved “${s.name}”`, 'success');
      evaluate(s.rules, s.id, true);
    } catch (e) { toast(e.message || 'Save failed', 'error'); }
  };

  const saveAsNew = async () => {
    const payload = scrPayload(catalog, rules);
    if (!payload) return toast('Fill in every number first', 'error');
    const name = await askPrompt({ title: 'New strategy', label: 'Name', placeholder: 'e.g. My value screen', confirmText: 'Create' });
    if (!name) return;
    try {
      const s = await api.screenerCreateStrategy(name, payload);
      await refreshList();
      setActiveId(s.id); setRules(s.rules);
      toast(`Created “${s.name}”`, 'success');
      evaluate(s.rules, s.id, true);
    } catch (e) { toast(e.message || 'Create failed', 'error'); }
  };

  const discard = () => { setRules(active.rules); evaluate(active.rules, active.id, true); };

  const resetStarter = async () => {
    try {
      const s = await api.screenerResetStrategy(activeId);
      await refreshList();
      setRules(s.rules);
      toast(`Reset “${s.name}” to default`, 'success');
      evaluate(s.rules, s.id, true);
    } catch (e) { toast(e.message || 'Reset failed', 'error'); }
  };

  const rename = async () => {
    const name = await askPrompt({ title: 'Rename strategy', label: 'Name', value: active.name, confirmText: 'Rename' });
    if (!name || name === active.name) return;
    try {
      await api.screenerUpdateStrategy(activeId, { name });
      await refreshList();
      toast(`Renamed to “${name}”`, 'success');
    } catch (e) { toast(e.message || 'Rename failed', 'error'); }
  };

  const remove = async () => {
    if (!await askConfirm({ title: 'Delete strategy', message: `Delete “${active.name}”? This can't be undone.`, confirmText: 'Delete', danger: true })) return;
    try {
      await api.screenerDeleteStrategy(activeId);
      const strats = await refreshList();
      const fallback = strats.find(s => s.starter_key === 'quality') || strats[0];
      setActiveId(fallback.id); setRules(fallback.rules);
      toast('Strategy deleted', 'success');
      evaluate(fallback.rules, fallback.id, true);
    } catch (e) { toast(e.message || 'Delete failed', 'error'); }
  };

  const reevaluate = () => evaluate(rules, dirty ? null : activeId, true);

  return {
    catalog, strategies, active, activeId, rules, result, loadErr, loading, evaluating, rstatus, busy,
    dirty, isStarter, level,
    load, requestRefresh, selectStrategy, editRule, setLevel, save, saveAsNew, discard, resetStarter, rename, remove, reevaluate,
  };
};
