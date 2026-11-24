// Dated notes log per ticker (backend: /api/notes). Symbol is stored without any "VN:" prefix.
// Used by the Overview grid and the Notes tab.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { formatDateTime } from '../../lib/format.js';
import { Button, Card, EmptyState, ErrorState, SkeletonText, askConfirm } from '../../ui';

const when = (iso) => formatDateTime(iso);

const NoteItem = ({ note, busy, editing, onEdit, onCancel, onSave, onDelete }) => {
  const [text, setText] = React.useState(note.body);
  React.useEffect(() => { if (editing) setText(note.body); }, [editing, note.body]);
  return (
    <li className="co-note">
      <div className="co-note-meta">
        <time dateTime={note.created_at}>{when(note.created_at)}</time>
        {note.updated_at && <span data-tip={`Edited ${when(note.updated_at)}`}>edited</span>}
        <span className="co-spacer" />
        {!editing && <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy}>Edit</Button>}
        <Button size="sm" variant="ghost" className="co-note-del" onClick={onDelete} disabled={busy}>Delete</Button>
      </div>
      {editing ? (
        <div className="co-note-edit">
          <textarea className="co-textarea" value={text} onChange={e => setText(e.target.value)} rows={3} disabled={busy}
            aria-label="Edit note" />
          <div className="co-note-actions">
            <Button size="sm" variant="primary" onClick={() => onSave(text)} disabled={busy || !text.trim()}>Save</Button>
            <Button size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="co-note-body">{note.body}</div>
      )}
    </li>
  );
};

const NotesCard = ({ symbol }) => {
  const sym = String(symbol).toUpperCase().replace(/^VN:/, '');
  const live = !!HelixAPI?.live;
  const [notes, setNotes] = React.useState(null);   // null = loading
  const [failed, setFailed] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [editId, setEditId] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [reload, setReload] = React.useState(0);
  const alive = React.useRef(true);   // card is keyed by symbol, so unmount == symbol switch
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  React.useEffect(() => {
    setNotes(null); setFailed(false);
    if (!live) return undefined;
    let cancelled = false;
    HelixAPI.notesList(sym).then(r => { if (!cancelled) setNotes(r); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [sym, live, reload]);

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { if (alive.current) setErr(e.message || 'Request failed'); }
    if (alive.current) setBusy(false);
  };
  const add = () => run(async () => {
    const n = await HelixAPI.notesAdd(sym, draft);
    if (!alive.current) return;
    setNotes(list => [n, ...(list || [])]); setDraft('');
  });
  const save = (id, body) => run(async () => {
    const n = await HelixAPI.notesEdit(id, body);
    if (!alive.current) return;
    setNotes(list => (list || []).map(x => x.id === id ? n : x)); setEditId(null);
  });
  const del = async (n) => {
    if (!await askConfirm({ title: 'Delete note', message: 'Delete this note? This can\'t be undone.', confirmText: 'Delete', danger: true })) return;
    run(async () => { await HelixAPI.notesDelete(n.id); if (!alive.current) return; setNotes(list => (list || []).filter(x => x.id !== n.id)); });
  };

  return (
    <Card title="Notes" subtitle={notes && notes.length ? `${notes.length} note${notes.length === 1 ? '' : 's'}` : undefined}>
      {!live ? (
        <EmptyState size="sm" plain title="Backend offline" description="Notes need the backend." />
      ) : failed ? (
        <ErrorState size="sm" title="Could not load notes" onRetry={() => { setReload(k => k + 1); return Promise.resolve(); }} />
      ) : (
        <>
          <textarea className="co-textarea" value={draft} onChange={e => setDraft(e.target.value)} rows={3} disabled={busy}
            placeholder={`Why is ${sym} a good company?`} aria-label={`New note for ${sym}`} />
          <div className="co-note-actions">
            <Button variant="primary" size="sm" onClick={add} disabled={busy || !draft.trim()}>Add note</Button>
            {err && <span className="co-err" role="alert">{err}</span>}
          </div>
          {notes === null ? <div className="co-notes-loading"><SkeletonText lines={3} /></div>
            : notes.length === 0 ? <p className="co-muted">No notes yet.</p>
            : (
              <ul className="co-notes">
                {notes.map(n => (
                  <NoteItem key={n.id} note={n} busy={busy} editing={editId === n.id}
                    onEdit={() => setEditId(n.id)} onCancel={() => setEditId(null)}
                    onSave={(body) => save(n.id, body)} onDelete={() => del(n)} />
                ))}
              </ul>
            )}
        </>
      )}
    </Card>
  );
};

export { NotesCard };
