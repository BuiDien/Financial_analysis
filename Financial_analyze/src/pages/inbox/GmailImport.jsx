// Gmail import: pull SSI broker report emails into the local backend.
// The app password goes straight to the macOS Keychain on the server and is never sent back.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { askConfirm, Badge, Button, Card, EmptyState, ErrorState, Skeleton, TextInput, toast } from '../../ui';
import { GmailAutoCheck, GmailReports, GmailSetupSteps } from './GmailParts.jsx';
import './inbox.css';

const GmailImportCard = () => {
  const live = HelixAPI?.live;
  const [cfg, setCfg] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);
  const [address, setAddress] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [replacing, setReplacing] = React.useState(false);
  const [busy, setBusy] = React.useState('');
  const [reports, setReports] = React.useState([]);
  const [result, setResult] = React.useState(null); // persistent last-action line: { kind: ok|error, action, text, at }

  const apply = (c) => { setCfg(c); setAddress(c.address || ''); setQuery(c.query || ''); };
  const loadReports = async () => { try { setReports((await HelixAPI.gmailReports(20)).reports || []); } catch {} };
  const load = () => {
    setLoadError(null);
    loadReports();
    return HelixAPI.gmailSettings().then(apply).catch((e) => { setLoadError(e); throw e; });
  };
  React.useEffect(() => { if (live) load().catch(() => {}); }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  const ACTION_NAMES = { save: 'Save', test: 'Test connection', check: 'Check now', remove: 'Remove password' };
  const report = (kind, action, text) => {
    setResult({ kind, action, text, at: new Date() });
    toast(text, kind === 'error' ? { type: 'error', duration: 0 } : { type: 'success' });
  };
  // A failed test/check updates last_status/last_error on the server; re-read config (not the form fields).
  const refreshCfg = () => HelixAPI.gmailSettings().then(setCfg).catch(() => {});
  const run = async (label, fn) => {
    setBusy(label);
    try { await fn(); } catch (e) {
      report('error', label, `${ACTION_NAMES[label] || 'Action'} failed: ${e.message || String(e)}`);
      await refreshCfg();
    }
    setBusy('');
  };

  const save = () => run('save', async () => {
    const body = { address, query };
    if (password.trim()) body.password = password;
    const c = await HelixAPI.saveGmailSettings(body);
    apply(c); setPassword(''); setReplacing(false);
    report('ok', 'save', body.password ? 'Saved. App password stored in macOS Keychain.' : 'Saved.');
  });
  const test = () => run('test', async () => {
    const r = await HelixAPI.testGmail();
    report('ok', 'test', `Login OK · ${r.matches} matching email${r.matches === 1 ? '' : 's'} found`);
    await refreshCfg();
  });
  const check = () => run('check', async () => {
    const { summary: s, settings } = await HelixAPI.checkGmail();
    apply(settings); await loadReports();
    report(s.errors && !s.downloaded ? 'error' : 'ok', 'check', s.new
      ? `Downloaded ${s.downloaded} new report${s.downloaded === 1 ? '' : 's'}${s.errors ? ` · ${s.errors} failed` : ''} (${s.matches} matching)`
      : `No new reports (${s.matches} matching, all already pulled)`);
  });
  const removePw = () => run('remove', async () => {
    if (!(await askConfirm({ title: 'Remove app password', message: 'Remove the Gmail app password from Keychain? Auto-check will turn off.', confirmText: 'Remove', danger: true }))) return;
    apply(await HelixAPI.removeGmailPassword());
    report('ok', 'remove', 'App password removed.');
  });
  const patch = (body) => run('save', async () => { apply(await HelixAPI.saveGmailSettings(body)); toast('Auto-check updated', { type: 'success' }); });

  if (!live) {
    return <Card><EmptyState title="Backend offline" description="Start the backend (scripts/run.sh) to configure Gmail import." /></Card>;
  }
  if (loadError && !cfg) {
    return <Card><ErrorState title="Couldn’t load Gmail settings" message={loadError.message} onRetry={load} /></Card>;
  }
  if (!cfg) {
    return <Card title="Gmail import" subtitle="Loading…"><div className="ibx-form"><Skeleton height={36} /><Skeleton height={36} /><Skeleton height={36} /></div></Card>;
  }

  const dirty = Boolean(address !== (cfg.address || '') || query !== (cfg.query || '') || password.trim());
  const canUse = cfg.password_saved && cfg.address && !dirty && !busy;

  return (
    <div className="ibx-gmail">
      <div className="ibx-gmail-grid">
        <Card title="Connection" subtitle="Pull broker trade reports (e.g. SSI “Thông báo kết quả giao dịch”) from your inbox">
          <form className="ibx-form" onSubmit={(e) => { e.preventDefault(); if (dirty && !busy) save(); }}>
            <TextInput label="Gmail address" type="email" value={address} onChange={setAddress} placeholder="you@gmail.com" autoComplete="off" />
            {cfg.password_saved && !replacing ? (
              <div className="ibx-pw-saved">
                <div className="ibx-pw-label">App password</div>
                <div className="ibx-pw-row">
                  <Badge tone="pos" dot sans>Saved in macOS Keychain</Badge>
                  <span className="ibx-pw-btns">
                    <Button size="sm" onClick={() => setReplacing(true)}>Replace</Button>
                    <Button size="sm" variant="danger" onClick={removePw} disabled={!!busy}>Remove</Button>
                  </span>
                </div>
              </div>
            ) : (
              <div className="ibx-pw-row">
                <TextInput label="App password" type="password" value={password} onChange={setPassword} placeholder="xxxx xxxx xxxx xxxx"
                  autoComplete="new-password" hint="16-letter code from myaccount.google.com/apppasswords" />
                {replacing && <Button size="sm" onClick={() => { setReplacing(false); setPassword(''); }}>Cancel</Button>}
              </div>
            )}
            <div>
              <TextInput label="Search filter" value={query} onChange={setQuery} className="ibx-mono" hint="Gmail search syntax, same as the Gmail search box" />
              {query !== cfg.default_query && <Button size="sm" variant="ghost" className="ibx-reset" onClick={() => setQuery(cfg.default_query)}>Reset to SSI default</Button>}
            </div>
            <div className="row ibx-wrap">
              <Button type="submit" variant="primary" loading={busy === 'save'} disabled={!dirty || !!busy}>Save</Button>
              <Button icon="wifi" onClick={test} loading={busy === 'test'} disabled={!canUse}>Test connection</Button>
              <Button icon="download" onClick={check} loading={busy === 'check'} disabled={!canUse}>Check now</Button>
            </div>
            {result && (
              <div className={`ibx-result is-${result.kind}`} role="status" aria-live="polite">
                <Badge tone={result.kind === 'ok' ? 'pos' : 'neg'} dot sans>{ACTION_NAMES[result.action] || 'Last action'}</Badge>
                <span className="ibx-result-text">{result.text}</span>
                <time className="ibx-subtle">{result.at.toLocaleTimeString()}</time>
              </div>
            )}
            <p className="ibx-note">Read-only: Helix never sends, deletes, or marks mail as read. The app password stays on this Mac (Keychain) and is never shown again or sent to the browser.</p>
          </form>
        </Card>
        <div className="stack">
          <GmailSetupSteps cfg={cfg} dirty={dirty} busy={busy} />
          <GmailAutoCheck cfg={cfg} onPatch={patch} busy={busy} />
        </div>
      </div>
      <GmailReports reports={reports} />
    </div>
  );
};

const GmailTab = () => (
  <div className="page ibx-page">
    <div className="page-header">
      <div>
        <h1 className="page-title">Gmail import.</h1>
        <p className="page-sub">Pull SSI broker report emails into the local backend (app password stays in the macOS Keychain)</p>
      </div>
    </div>
    <GmailImportCard />
  </div>
);

export { GmailImportCard, GmailTab };
