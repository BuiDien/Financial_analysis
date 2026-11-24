// Settings sections: Hermes Agent, Shortcuts, Backend & API, Email import, Data & Privacy.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { alertsApi } from '../../lib/data.js';
import { Icon } from '../../icons.jsx';
import { ShortcutsEditor } from '../../shortcuts-ui.jsx';
import { askConfirm, Button, Segmented, TextInput, toast } from '../../ui';
import { SettingRow, SettingsCard, SettingsSection, StatusNote } from './SettingsParts.jsx';

const PROVIDERS = [{ value: 'hermes', label: 'Hermes (local)' }, { value: 'claude', label: 'Claude (cloud)' }];
const HERMES_NOTE = {
  live: ['pos', 'Hermes agent reachable'],
  down: ['neg', 'Agent not reachable'],
  checking: ['neutral', 'Checking…'],
  unknown: ['neutral', 'Not tested yet'],
};

export const AiSection = ({ settings, set, hermesStatus, hermesModel, onTest }) => {
  const [tone, title] = HERMES_NOTE[hermesStatus] || HERMES_NOTE.unknown;
  return (
    <SettingsSection id="ai" title="Hermes Agent" subtitle="Run analysis locally with Hermes, or use Claude in the cloud">
      <SettingsCard>
        <SettingRow label="Provider" hint="Where the assistant runs">
          <Segmented size="sm" ariaLabel="AI provider" value={settings.aiProvider} options={PROVIDERS} onChange={v => set('aiProvider', v)} />
        </SettingRow>
        {settings.aiProvider === 'hermes' ? (
          <>
            <p className="set-info"><strong>Hermes Agent</strong> runs on this machine with its skills, memory, and financial MCP tools. The FastAPI backend keeps the agent API key out of the browser.</p>
            <SettingRow label="Agent gateway" hint="Configured server-side in backend/.env — FastAPI → Hermes Agent">
              <Button variant="primary" size="sm" loading={hermesStatus === 'checking'} onClick={onTest}>
                {hermesStatus === 'checking' ? 'Pinging…' : 'Test agent'}
              </Button>
            </SettingRow>
            <StatusNote tone={tone} title={title}>
              {hermesStatus === 'down' && <span className="set-mono">Start FastAPI, then run: hermes gateway run</span>}
              {hermesStatus === 'live' && hermesModel && <span className="set-mono">Model: {hermesModel}</span>}
            </StatusNote>
          </>
        ) : (
          <p className="set-info">Cloud requests go through your backend, which holds the API key and picks the model (configured in <code className="set-code">backend/.env</code>).</p>
        )}
      </SettingsCard>
    </SettingsSection>
  );
};

export const ShortcutsSection = () => (
  <SettingsSection id="shortcuts" title="Keyboard Shortcuts" subtitle="Click any shortcut to record a new key combo. Press Shift + ? anytime to see the cheatsheet.">
    <SettingsCard><ShortcutsEditor /></SettingsCard>
  </SettingsSection>
);

export const BackendSection = ({ settings, set, backendStatus, testing, onTest }) => (
  <SettingsSection id="backend" title="Backend & API" subtitle="Connect to your FastAPI server for live data">
    <SettingsCard>
      <form className="set-inline-form" onSubmit={(e) => { e.preventDefault(); if (!testing) onTest(); }}>
        <TextInput label="Backend URL" hint="Where your uvicorn server is running" value={settings.backendUrl}
          onChange={v => set('backendUrl', v)} placeholder="http://localhost:8000" className="set-grow" />
        <Button type="submit" variant="primary" loading={testing}>{testing ? 'Testing…' : 'Test connection'}</Button>
      </form>
      <StatusNote tone={backendStatus === 'live' ? 'pos' : 'neutral'}
        title={backendStatus === 'live' ? 'Connected — live data active' : backendStatus === 'checking' ? 'Checking…' : 'Not connected'}>
        {backendStatus === 'live'
          ? 'Quotes, statements, portfolio, and AI now flow through your Python backend.'
          : 'Start everything with ./scripts/run.sh — the app reconnects automatically (checked every 10s).'}
      </StatusNote>
      <p className="set-info">Hermes and Anthropic API keys live server-side in your <code className="set-code">backend/.env</code> file — they are never stored in the browser.</p>
    </SettingsCard>
  </SettingsSection>
);

export const EmailSection = () => (
  <SettingsSection id="email" title="Email import" subtitle="Gmail import now lives in the Inbox">
    <SettingsCard>
      <SettingRow label="Gmail import" hint="Address, Keychain app password, auto-check and pulled reports">
        <a className="btn btn-primary btn-sm set-link" href="#/inbox/gmail"><Icon name="download" size={12} /> Open Inbox → Gmail import</a>
      </SettingRow>
    </SettingsCard>
  </SettingsSection>
);

const clearAlerts = async () => {
  if (!HelixAPI?.live) { toast('Backend offline — start with scripts/run.sh', { type: 'error' }); return; }
  if (await askConfirm({ title: 'Clear alerts', message: 'Delete all alerts?', confirmText: 'Clear', danger: true })) {
    try { await alertsApi.clear(); toast('Alerts cleared', { type: 'info' }); }
    catch (e) { toast(`Could not clear alerts: ${e.message || e}`, { type: 'error' }); }
  }
};
const resetWatchBoard = async () => {
  if (await askConfirm({ title: 'Reset watch board', message: 'Reset the Today watch board to its defaults?', confirmText: 'Reset', danger: true })) {
    localStorage.removeItem('helix_home_watch_v1');
    localStorage.removeItem('helix_home_custom_v1');
    toast('Watch board reset — reload to apply', { type: 'info' });
  }
};
const exportAll = () => {
  const dump = {};
  Object.keys(localStorage).filter(k => k.startsWith('helix_')).forEach((k) => { dump[k] = localStorage.getItem(k); });
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'helix-data-export.json'; a.click();
  URL.revokeObjectURL(url);
  toast('Exported helix-data-export.json', { type: 'success' });
};

export const DataSection = () => (
  <SettingsSection id="data" title="Data & Privacy" subtitle="Everything Helix stores in this browser">
    <SettingsCard title="Local data">
      <SettingRow label="Alerts" hint="Price and daily-move alerts (stored on the backend)">
        <Button size="sm" variant="danger" onClick={clearAlerts}>Clear</Button>
      </SettingRow>
      <SettingRow label="Watch board" hint="Instruments pinned on the Today watch board">
        <Button size="sm" variant="danger" onClick={resetWatchBoard}>Clear</Button>
      </SettingRow>
    </SettingsCard>
    <SettingsCard title="Export" subtitle="Take your data with you">
      <SettingRow label="All local data" hint="Every helix_* key in this browser, as JSON">
        <Button size="sm" icon="download" onClick={exportAll}>Export all data (JSON)</Button>
      </SettingRow>
    </SettingsCard>
  </SettingsSection>
);
