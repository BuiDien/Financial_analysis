// shortcuts-ui.jsx — the settings editor + the cheatsheet overlay.

// ── Recorder row: click to capture a new combo ────────────────
const ShortcutRow = ({ action, combo, recording, onStartRecord, onStopRecord, onClear }) => {
  React.useEffect(() => {
    if (!recording) return;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = (e.key || '').toLowerCase();
      // ignore lone modifier presses — wait for a real key
      if (['control', 'meta', 'shift', 'alt'].includes(key)) return;
      if (key === 'escape') { onStopRecord(null); return; }
      const c = window.comboFromEvent(e);
      onStopRecord(c);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 13, color: 'var(--text)' }}>{action.label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {recording ? (
          <span style={{
            fontSize: 11, fontWeight: 600, color: 'var(--accent)',
            padding: '4px 10px', borderRadius: 6, border: '1px dashed var(--accent)',
            background: 'var(--accent-bg)', minWidth: 110, textAlign: 'center',
          }}>
            Press keys…
          </span>
        ) : (
          <button onClick={onStartRecord} title="Click to change"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            <KbdCombo combo={combo} />
          </button>
        )}
        <button onClick={recording ? () => onStopRecord(null) : onStartRecord}
          className="btn" style={{ padding: '4px 10px', fontSize: 11 }}>
          {recording ? 'Cancel' : 'Edit'}
        </button>
        <button onClick={onClear} title="Reset to default"
          className="icon-btn" style={{ width: 26, height: 26 }}>
          <Icon name="arrowDown" size={11} style={{ transform: 'rotate(90deg)' }} />
        </button>
      </div>
    </div>
  );
};

// ── Settings editor (rendered inside the Settings page) ───────
const ShortcutsEditor = () => {
  const [bindings, setBindings] = React.useState(() => window.HelixShortcuts.load());
  const [recordingId, setRecordingId] = React.useState(null);
  const [conflict, setConflict] = React.useState(null);

  React.useEffect(() => window.HelixShortcuts.subscribe(setBindings), []);

  const commit = (actionId, combo) => {
    setRecordingId(null);
    if (!combo) return;
    const owner = window.HelixShortcuts.conflictFor(combo, actionId);
    if (owner) {
      const label = window.ALL_SHORTCUT_ACTIONS.find(a => a.id === owner)?.label || owner;
      setConflict({ combo, label });
      setTimeout(() => setConflict(null), 2600);
      return;
    }
    window.HelixShortcuts.set(actionId, combo);
    window.toast && window.toast('Shortcut updated', { type: 'success' });
  };

  return (
    <>
      {conflict && (
        <div style={{
          padding: '8px 12px', marginBottom: 12, borderRadius: 6,
          background: 'var(--neg-bg)', border: '1px solid var(--neg-soft)',
          color: 'var(--neg)', fontSize: 12,
        }}>
          <strong>{window.prettyCombo(conflict.combo)}</strong> is already used by “{conflict.label}”. Pick another.
        </div>
      )}
      {window.SHORTCUT_GROUPS.map(group => (
        <div key={group.group} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)', marginBottom: 4 }}>
            {group.group}
          </div>
          {group.actions.map(action => (
            <ShortcutRow
              key={action.id}
              action={action}
              combo={bindings[action.id]}
              recording={recordingId === action.id}
              onStartRecord={() => setRecordingId(action.id)}
              onStopRecord={(combo) => commit(action.id, combo)}
              onClear={() => { window.HelixShortcuts.reset(action.id); window.toast && window.toast('Reset to default', { type: 'info' }); }}
            />
          ))}
        </div>
      ))}
      <button className="btn" onClick={() => { window.HelixShortcuts.resetAll(); window.toast && window.toast('All shortcuts reset', { type: 'info' }); }}>
        Reset all to defaults
      </button>
    </>
  );
};

// ── Cheatsheet overlay (Shift+? ) ─────────────────────────────
const ShortcutCheatsheet = () => {
  const [open, setOpen] = React.useState(false);
  const [bindings, setBindings] = React.useState(() => window.HelixShortcuts.bindings);

  React.useEffect(() => {
    const show = () => { setBindings({ ...window.HelixShortcuts.bindings }); setOpen(true); };
    window.addEventListener('show-shortcuts', show);
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    const unsub = window.HelixShortcuts.subscribe(setBindings);
    return () => { window.removeEventListener('show-shortcuts', show); window.removeEventListener('keydown', onKey); unsub(); };
  }, []);

  if (!open) return null;

  return (
    <div onClick={() => setOpen(false)}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2147483200, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 560, maxHeight: '80vh', overflowY: 'auto', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 24px 64px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: 0, fontFamily: 'var(--font-serif)', fontSize: 18, fontWeight: 600 }}>Keyboard shortcuts</h3>
          <button className="icon-btn" onClick={() => setOpen(false)} style={{ width: 28, height: 28 }}>
            <Icon name="close" size={13} />
          </button>
        </div>
        <div style={{ padding: '12px 20px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 32px' }}>
          {window.SHORTCUT_GROUPS.map(group => (
            <div key={group.group} style={{ gridColumn: group.group === 'Go to' ? '2' : '1', gridRow: group.group === 'Go to' ? 'span 2' : 'auto' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)', margin: '12px 0 6px' }}>
                {group.group}
              </div>
              {group.actions.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{a.label}</span>
                  <KbdCombo combo={bindings[a.id]} />
                </div>
              ))}
            </div>
          ))}
        </div>
        <div style={{ padding: '10px 20px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-subtle)' }}>
          Customize any of these in Settings → Shortcuts.
        </div>
      </div>
    </div>
  );
};

window.ShortcutsEditor = ShortcutsEditor;
window.ShortcutCheatsheet = ShortcutCheatsheet;
