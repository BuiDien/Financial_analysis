// Settings persisted to localStorage under 'helix_settings_v1' (read by router, header, ai-panel,
// api-client). Only settings something actually reads — single-user local app, no profile/plan.

export const SETTINGS_KEY = 'helix_settings_v1';
export const SECTION_KEY = 'helix_settings_section';

export const DEFAULT_SETTINGS = {
  baseCurrency: 'USD',          // portfolio display currency (PATCH /api/portfolio/preferences)
  defaultLanding: 'today',      // lib/router.js landingHash()
  tickerTape: true,             // header.jsx
  aiProvider: 'hermes',         // hermes (local) | claude (cloud) — api-client complete()
  aiTone: 'concise',            // concise | detailed | numbers-only — ai-panel
  backendUrl: 'http://localhost:8000',
};

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'VND'];

// Values are route names (old page ids saved by earlier versions still resolve).
export const LANDING_PAGES = [
  { id: 'last', label: 'Last visited' },
  { id: 'today', label: 'Today' },
  { id: 'scan', label: 'Scan' },
  { id: 'company', label: 'Company (last ticker)' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'news', label: 'News' },
];
const LEGACY_LANDING = { home: 'today', dashboard: 'today', detail: 'company', statements: 'company', screener: 'scan', backtest: 'scan', alerts: 'today', news: 'today', 'ocr-inbox': 'inbox', sync: 'inbox' };

export const loadSettings = () => {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const out = { ...DEFAULT_SETTINGS, ...s };
    if (LEGACY_LANDING[out.defaultLanding]) out.defaultLanding = LEGACY_LANDING[out.defaultLanding];
    return out;
  } catch { return { ...DEFAULT_SETTINGS }; }
};

export const saveSettings = (next) => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
  window.dispatchEvent(new Event('helix-settings-updated'));
};

export const SECTIONS = [
  { id: 'account', label: 'General', icon: 'portfolio' },
  { id: 'appearance', label: 'Appearance', icon: 'eye' },
  { id: 'display', label: 'Data & Display', icon: 'screener' },
  { id: 'ai', label: 'Hermes Agent', icon: 'sparkle' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'settings' },
  { id: 'backend', label: 'Backend & API', icon: 'settings' },
  { id: 'email', label: 'Email import', icon: 'download' },
  { id: 'data', label: 'Data & Privacy', icon: 'alerts' },
];
