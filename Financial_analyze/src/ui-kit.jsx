// ui-kit.jsx — global Toasts + Command Palette (⌘K).
//
// Toasts: call window.toast('Saved', { type:'success' }) from anywhere.
//   types: success | error | info (default). Auto-dismiss ~3s.
//   Mount <ToastHost/> once at the app root.
//
// Command palette: <CommandPalette nav onNavigate onPickTicker /> mounted at root.
//   Opens on ⌘K / Ctrl-K or window.dispatchEvent(new Event('open-command-palette')).

// ── Toasts ────────────────────────────────────────────────────
let _toastSeq = 0;
const _toastSubs = new Set();

window.toast = (message, opts = {}) => {
  const t = { id: ++_toastSeq, message, type: opts.type || 'info', duration: opts.duration ?? 3000 };
  _toastSubs.forEach(fn => fn(t));
  return t.id;
};

const ToastHost = () => {
  const [toasts, setToasts] = React.useState([]);

  React.useEffect(() => {
    const onToast = (t) => {
      setToasts(list => [...list, t]);
      if (t.duration > 0) {
        setTimeout(() => setToasts(list => list.filter(x => x.id !== t.id)), t.duration);
      }
    };
    _toastSubs.add(onToast);
    return () => _toastSubs.delete(onToast);
  }, []);

  const dismiss = (id) => setToasts(list => list.filter(x => x.id !== id));

  const tone = {
    success: { icon: 'starFill', color: 'var(--pos)', bg: 'var(--pos-bg)', bd: 'var(--pos-soft)' },
    error:   { icon: 'alerts', color: 'var(--neg)', bg: 'var(--neg-bg)', bd: 'var(--neg-soft)' },
    info:    { icon: 'sparkle', color: 'var(--accent)', bg: 'var(--bg-elev)', bd: 'var(--border)' },
  };

  return (
    <div style={{
      position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
      zIndex: 2147483000, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center',
      pointerEvents: 'none',
    }}>
      {toasts.map(t => {
        const k = tone[t.type] || tone.info;
        return (
          <div key={t.id} onClick={() => dismiss(t.id)}
            style={{
              pointerEvents: 'auto', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 10,
              background: k.bg, border: `1px solid ${k.bd}`, borderRadius: 8,
              padding: '10px 14px 10px 12px', minWidth: 240, maxWidth: 440,
              boxShadow: '0 8px 28px rgba(0,0,0,0.16)',
              animation: 'toast-in 220ms cubic-bezier(.2,.8,.2,1)',
              fontSize: 13, color: 'var(--text)',
            }}>
            <span style={{ width: 22, height: 22, borderRadius: '50%', background: k.color + '1f', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
              <Icon name={k.icon} size={12} style={{ color: k.color }} />
            </span>
            <span style={{ flex: 1, fontWeight: 500 }}>{t.message}</span>
          </div>
        );
      })}
    </div>
  );
};

// ── Command Palette ───────────────────────────────────────────
const CommandPalette = ({ nav = [], tickers = [], filings = [], onNavigate, onPickTicker, onOpenFiling }) => {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [sel, setSel] = React.useState(0);
  const inputRef = React.useRef(null);

  // Open/close hotkeys
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(o => !o);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    const onOpenEvt = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('open-command-palette', onOpenEvt);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('open-command-palette', onOpenEvt); };
  }, []);

  React.useEffect(() => {
    if (open) { setQuery(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [open]);

  // Build the command list
  const q = query.trim().toLowerCase();
  const items = React.useMemo(() => {
    const navItems = nav.map(n => ({ kind: 'page', id: n.id, label: n.label, sub: 'Page', icon: n.icon || 'arrowRight' }));
    const tickerItems = tickers.map(t => ({ kind: 'ticker', id: t.sym, label: t.sym, sub: t.name || 'Ticker', icon: 'chart' }));
    const filingItems = filings.map(f => ({ kind: 'filing', id: f.id, label: f.name, sub: `${f.ticker} · ${f.type || ''}`.trim(), icon: 'news' }));
    let all = [...navItems, ...tickerItems, ...filingItems];
    if (q) {
      all = all.filter(it => it.label.toLowerCase().includes(q) || (it.sub || '').toLowerCase().includes(q));
      // rank: startsWith first
      all.sort((a, b) => {
        const as = a.label.toLowerCase().startsWith(q) ? 0 : 1;
        const bs = b.label.toLowerCase().startsWith(q) ? 0 : 1;
        return as - bs;
      });
    }
    return all.slice(0, 40);
  }, [nav, tickers, filings, q]);

  React.useEffect(() => { setSel(0); }, [query]);

  const run = (it) => {
    if (!it) return;
    setOpen(false);
    if (it.kind === 'page') onNavigate?.(it.id);
    else if (it.kind === 'ticker') onPickTicker?.(it.id);
    else if (it.kind === 'filing') onOpenFiling?.(it);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(items[sel]); }
  };

  if (!open) return null;

  const groups = [
    { kind: 'page', label: 'Pages' },
    { kind: 'ticker', label: 'Tickers' },
    { kind: 'filing', label: 'Filings' },
  ];

  return (
    <div onClick={() => setOpen(false)}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2147483100, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh' }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 560, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 24px 64px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <Icon name="search" size={16} style={{ color: 'var(--text-subtle)' }} />
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Search pages, tickers, filings…"
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 15, color: 'var(--text)', fontFamily: 'inherit' }} />
          <kbd style={kbdStyle}>ESC</kbd>
        </div>
        <div style={{ maxHeight: 380, overflowY: 'auto', padding: 6 }}>
          {items.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-subtle)', fontSize: 13 }}>No matches for "{query}"</div>
          ) : (
            groups.map(g => {
              const groupItems = items.filter(it => it.kind === g.kind);
              if (!groupItems.length) return null;
              return (
                <div key={g.kind}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)', padding: '8px 10px 4px' }}>{g.label}</div>
                  {groupItems.map(it => {
                    const idx = items.indexOf(it);
                    const active = idx === sel;
                    return (
                      <button key={it.kind + it.id} onClick={() => run(it)} onMouseEnter={() => setSel(idx)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
                          padding: '9px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                          background: active ? 'var(--accent-bg)' : 'transparent',
                        }}>
                        <span style={{ width: 26, height: 26, borderRadius: 6, background: 'var(--bg-sunken)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                          <Icon name={it.icon} size={13} style={{ color: active ? 'var(--accent)' : 'var(--text-muted)' }} />
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 13, fontWeight: 500, color: active ? 'var(--accent)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {it.kind === 'ticker' ? <span className="ticker">{it.label}</span> : it.label}
                          </span>
                          <span style={{ display: 'block', fontSize: 11, color: 'var(--text-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.sub}</span>
                        </span>
                        {active && <kbd style={kbdStyle}>↵</kbd>}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
        <div style={{ display: 'flex', gap: 14, padding: '8px 14px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-subtle)' }}>
          <span><kbd style={kbdStyle}>↑</kbd><kbd style={kbdStyle}>↓</kbd> navigate</span>
          <span><kbd style={kbdStyle}>↵</kbd> open</span>
          <span style={{ marginLeft: 'auto' }}><kbd style={kbdStyle}>⌘K</kbd> toggle</span>
        </div>
      </div>
    </div>
  );
};

const kbdStyle = {
  fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
  padding: '2px 5px', background: 'var(--bg-sunken)', border: '1px solid var(--border)',
  borderRadius: 4, color: 'var(--text-muted)',
};

// Inject animation
if (!document.getElementById('uikit-style')) {
  const s = document.createElement('style');
  s.id = 'uikit-style';
  s.textContent = `@keyframes toast-in { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: translateY(0); } }`;
  document.head.appendChild(s);
}

// ── Prompt modal (replaces browser prompt()) ─────────────────
// Usage: const name = await window.askPrompt({ title, label, placeholder, value, confirmText });
//        returns the trimmed string, or null if cancelled.
let _promptSub = null;

window.askPrompt = (opts = {}) => new Promise((resolve) => {
  if (!_promptSub) { resolve(null); return; }
  _promptSub({ opts, resolve });
});

// Confirm modal — returns true/false. Usage: if (await window.askConfirm({ title, message, confirmText, danger }))
window.askConfirm = (opts = {}) => new Promise((resolve) => {
  if (!_promptSub) { resolve(window.confirm(opts.message || 'Are you sure?')); return; }
  _promptSub({ opts: { ...opts, __confirm: true }, resolve });
});

const PromptHost = () => {
  const [req, setReq] = React.useState(null);  // { opts, resolve }
  const [value, setValue] = React.useState('');
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    _promptSub = (r) => { setReq(r); setValue(r.opts.value || ''); };
    return () => { _promptSub = null; };
  }, []);

  React.useEffect(() => {
    if (req) setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 30);
  }, [req]);

  if (!req) return null;
  const o = req.opts;
  const isConfirm = !!o.__confirm;

  const close = (result) => { req.resolve(result); setReq(null); };
  const submit = () => { if (isConfirm) { close(true); return; } const v = value.trim(); close(v || null); };

  return (
    <div onClick={() => close(null)}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 2147483200, display: 'grid', placeItems: 'center', padding: 24 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 400, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 24px 64px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 className="serif" style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{o.title || (isConfirm ? 'Please confirm' : 'Enter a value')}</h3>
          <button className="icon-btn" onClick={() => close(isConfirm ? false : null)} style={{ width: 26, height: 26 }}><Icon name="close" size={12} /></button>
        </div>
        <div style={{ padding: 18 }}>
          {isConfirm ? (
            <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>{o.message}</div>
          ) : (<>
          {o.label && <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>{o.label}</label>}
          <input ref={inputRef} value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } if (e.key === 'Escape') close(null); }}
            placeholder={o.placeholder || ''}
            style={{ width: '100%', padding: '10px 12px', fontSize: 14, fontFamily: 'inherit', background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text)', outline: 'none' }} />
          </>)}
        </div>
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', background: 'var(--bg-sunken)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={() => close(isConfirm ? false : null)}>Cancel</button>
          <button className={o.danger ? 'btn' : 'btn btn-primary'} onClick={submit} style={o.danger ? { color: 'var(--neg)', borderColor: 'var(--neg-soft)' } : undefined}>{o.confirmText || (isConfirm ? 'Confirm' : 'Save')}</button>
        </div>
      </div>
    </div>
  );
};

window.ToastHost = ToastHost;
window.PromptHost = PromptHost;
window.CommandPalette = CommandPalette;
