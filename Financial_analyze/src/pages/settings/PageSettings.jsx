// Settings page — one scrolling page of grouped sections with a sticky anchor nav on the left
// (scroll-spy highlights the section in view). Appearance controls are wired to the live app theme
// state (props); everything else persists to localStorage under 'helix_settings_v1'.
// Every change confirms with a (debounced) "Settings saved" toast.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { Icon } from '../../icons.jsx';
import { toast, useReducedMotion } from '../../ui';
import { loadSettings, saveSettings, SECTION_KEY, SECTIONS } from './settings-store.js';
import { AppearanceSection, DisplaySection, GeneralSection } from './SectionsGeneral.jsx';
import { AiSection, BackendSection, DataSection, EmailSection, ShortcutsSection } from './SectionsSystem.jsx';
import './settings.css';

let savedTimer = 0;
const notifySaved = () => {
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => toast('Settings saved', { type: 'success', duration: 2200 }), 600);
};

// Highlights the last section whose top has scrolled past ~30% of the viewport
// (or the final section once the scroller reaches the bottom).
const useScrollSpy = (ids) => {
  const [current, setCurrent] = React.useState(() => {
    try { return localStorage.getItem(SECTION_KEY) || ids[0]; } catch { return ids[0]; }
  });
  React.useEffect(() => {
    const first = document.getElementById(`set-${ids[0]}`);
    const scroller = first?.closest('.main') || window;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const el = scroller === window ? document.documentElement : scroller;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      const line = window.innerHeight * 0.3;
      let pick = ids[0];
      ids.forEach((id) => { const n = document.getElementById(`set-${id}`); if (n && n.getBoundingClientRect().top <= line) pick = id; });
      if (atBottom && el.scrollTop > 0) pick = ids[ids.length - 1];
      setCurrent(pick);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => { scroller.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [ids]);
  return [current, setCurrent];
};

const SECTION_IDS = SECTIONS.map(s => s.id);

const PageSettings = ({ theme, setTheme, density, setDensity, accent, setAccent, accents }) => {
  const [settings, setSettings] = React.useState(loadSettings);
  const [section, setSection] = useScrollSpy(SECTION_IDS);
  const reduced = useReducedMotion();
  const [backendStatus, setBackendStatus] = React.useState(HelixAPI?.live ? 'live' : 'offline');
  const [testing, setTesting] = React.useState(false);
  const [hermesStatus, setHermesStatus] = React.useState('unknown'); // unknown | live | down | checking
  const [hermesModel, setHermesModel] = React.useState('');

  const goToSection = (id, smooth = true) => {
    setSection(id);
    try { localStorage.setItem(SECTION_KEY, id); } catch {}
    document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: smooth && !reduced ? 'smooth' : 'auto', block: 'start' });
  };
  // Re-open where the user left off.
  React.useEffect(() => {
    let id = null;
    try { id = localStorage.getItem(SECTION_KEY); } catch {}
    if (id && id !== SECTION_IDS[0] && SECTION_IDS.includes(id)) goToSection(id, false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // persist only (no toast) — for free-text fields saved per keystroke (backend URL: feedback comes from Test).
  const persist = (key, value) => {
    setSettings((s) => { const next = { ...s, [key]: value }; saveSettings(next); return next; });
  };
  const set = (key, value) => { persist(key, value); notifySaved(); };
  React.useEffect(() => () => { clearTimeout(savedTimer); savedTimer = 0; }, []);
  const withSaved = (fn) => (v) => { fn(v); notifySaved(); };

  const setBaseCurrency = async (value) => {
    set('baseCurrency', value);
    if (!HelixAPI?.live) return;
    try {
      await HelixAPI.setPortfolioCurrency(value);
      toast(`Portfolio display currency is converting to ${value}`, { type: 'info' });
    } catch (e) {
      toast(`Could not change portfolio currency: ${e.message || e}`, { type: 'error' });
    }
  };

  const testHermes = async () => {
    setHermesStatus('checking');
    try {
      const status = await HelixAPI.aiHealth();
      setHermesModel(status.model || 'hermes-agent');
      setHermesStatus('live');
    } catch {
      setHermesStatus('down');
    }
  };

  const testBackend = async () => {
    setTesting(true);
    setBackendStatus('checking');
    if (HelixAPI) {
      HelixAPI.base = settings.backendUrl;
      localStorage.setItem('helix_api_url', settings.backendUrl);
      const live = await HelixAPI.detect();
      setBackendStatus(live ? 'live' : 'offline');
      toast(live ? `Backend URL saved · connected to ${settings.backendUrl}` : `Backend URL saved · ${settings.backendUrl} not reachable`, { type: live ? 'success' : 'error' });
    }
    setTesting(false);
  };

  return (
    <div className="page set-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings.</h1>
          <p className="page-sub">Appearance, data, AI, and how Helix works</p>
        </div>
      </div>

      <div className="set-layout">
        <nav className="set-nav" aria-label="Settings sections">
          {SECTIONS.map(s => (
            <button key={s.id} type="button" className="set-nav-item" aria-current={section === s.id ? 'true' : undefined}
              onClick={() => goToSection(s.id)}>
              <Icon name={s.icon} size={14} />
              <span>{s.label}</span>
            </button>
          ))}
        </nav>

        <div className="set-content">
          <GeneralSection settings={settings} onBaseCurrency={setBaseCurrency} />
          <AppearanceSection theme={theme} setTheme={withSaved(setTheme)} accent={accent} setAccent={withSaved(setAccent)}
            accents={accents || []} density={density} setDensity={withSaved(setDensity)} />
          <DisplaySection settings={settings} set={set} />
          <AiSection settings={settings} set={set} hermesStatus={hermesStatus} hermesModel={hermesModel} onTest={testHermes} />
          <ShortcutsSection />
          <BackendSection settings={settings} set={persist} backendStatus={backendStatus} testing={testing} onTest={testBackend} />
          <EmailSection />
          <DataSection />
        </div>
      </div>
    </div>
  );
};

export { PageSettings };
