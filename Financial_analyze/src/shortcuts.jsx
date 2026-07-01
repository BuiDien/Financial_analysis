// shortcuts.jsx — customizable keyboard shortcuts.
//
// HelixShortcuts is a tiny global registry:
//   • DEFAULT_SHORTCUTS — the built-in actions + default key combos
//   • bindings persist to localStorage ('helix_shortcuts_v1') as { actionId: combo }
//   • install() attaches one global keydown listener that matches combos and fires handlers
//   • handlers are registered by the app via HelixShortcuts.setHandlers({ actionId: fn })
//
// A "combo" is a normalized string like "mod+k", "g h", "shift+?"
//   - "mod" = ⌘ on Mac, Ctrl elsewhere
//   - space-separated tokens = a sequence (press one after another, e.g. "g h")

const SHORTCUTS_KEY = 'helix_shortcuts_v1';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// Action catalogue — grouped for the settings UI
const SHORTCUT_GROUPS = [
  {
    group: 'General',
    actions: [
      { id: 'command-palette', label: 'Open command palette', default: 'mod+k' },
      { id: 'toggle-ai',       label: 'Toggle AI assistant',  default: 'mod+j' },
      { id: 'toggle-theme',    label: 'Toggle light / dark',  default: 'mod+shift+l' },
      { id: 'open-settings',   label: 'Open settings',        default: 'mod+,' },
      { id: 'show-shortcuts',  label: 'Show this cheatsheet',  default: 'shift+?' },
    ],
  },
  {
    group: 'Go to',
    actions: [
      { id: 'go-home',       label: 'Home',                default: 'g h' },
      { id: 'go-dashboard',  label: 'Dashboard',           default: 'g d' },
      { id: 'go-detail',     label: 'Asset Detail',        default: 'g e' },
      { id: 'go-portfolio',  label: 'Portfolio',           default: 'g p' },
      { id: 'go-screener',   label: 'Screener',            default: 'g s' },
      { id: 'go-statements', label: 'Financial Statements', default: 'g f' },
      { id: 'go-sync',       label: 'Sync',                default: 'g y' },
      { id: 'go-news',       label: 'News',                default: 'g n' },
      { id: 'go-alerts',     label: 'Alerts',              default: 'g a' },
    ],
  },
];

const ALL_ACTIONS = SHORTCUT_GROUPS.flatMap(g => g.actions);

const defaultBindings = () => Object.fromEntries(ALL_ACTIONS.map(a => [a.id, a.default]));

const HelixShortcuts = {
  bindings: defaultBindings(),
  handlers: {},
  enabled: true,
  _seq: [],
  _seqTimer: null,
  _subs: new Set(),

  load() {
    try {
      const saved = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || '{}');
      this.bindings = { ...defaultBindings(), ...saved };
    } catch { this.bindings = defaultBindings(); }
    return this.bindings;
  },
  save() {
    localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(this.bindings));
    this._subs.forEach(fn => fn(this.bindings));
  },
  set(actionId, combo) { this.bindings[actionId] = combo; this.save(); },
  reset(actionId) {
    const def = ALL_ACTIONS.find(a => a.id === actionId)?.default;
    if (def) this.set(actionId, def);
  },
  resetAll() { this.bindings = defaultBindings(); this.save(); },
  setHandlers(h) { this.handlers = { ...this.handlers, ...h }; },
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },

  // Find which action owns a combo (excluding one action, for conflict checks)
  conflictFor(combo, exceptId) {
    return Object.entries(this.bindings).find(([id, c]) => c === combo && id !== exceptId)?.[0] || null;
  },

  install() {
    if (this._installed) return;
    this._installed = true;
    this.load();
    window.addEventListener('keydown', (e) => this._onKey(e), true);
  },

  _onKey(e) {
    if (!this.enabled) return;
    const tag = (e.target?.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;

    const single = comboFromEvent(e);          // e.g. "mod+k"
    const isModified = e.metaKey || e.ctrlKey || e.altKey;

    // 1) Try modified single-chord combos (work even while typing, except plain keys)
    if (isModified || single === 'shift+?') {
      const actionId = Object.keys(this.bindings).find(id => this.bindings[id] === single);
      if (actionId && this.handlers[actionId]) {
        e.preventDefault();
        this.handlers[actionId]();
        this._seq = [];
        return;
      }
    }

    // 2) Sequence combos (e.g. "g h") — only when not typing and no modifier
    if (typing || isModified) { this._seq = []; return; }
    const key = (e.key || '').toLowerCase();
    if (key.length === 1 && /[a-z0-9]/.test(key)) {
      this._seq.push(key);
      clearTimeout(this._seqTimer);
      this._seqTimer = setTimeout(() => { this._seq = []; }, 900);
      // Try the last 2 keys as a sequence
      for (let n = Math.min(2, this._seq.length); n >= 1; n--) {
        const candidate = this._seq.slice(-n).join(' ');
        const actionId = Object.keys(this.bindings).find(id => this.bindings[id] === candidate);
        if (actionId && this.handlers[actionId]) {
          e.preventDefault();
          this.handlers[actionId]();
          this._seq = [];
          return;
        }
      }
    }
  },
};

// Normalize a keydown event → combo string
function comboFromEvent(e) {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let k = (e.key || '').toLowerCase();
  const map = { ' ': 'space', 'escape': 'esc', 'arrowup': '↑', 'arrowdown': '↓', 'arrowleft': '←', 'arrowright': '→' };
  k = map[k] || k;
  // Don't duplicate modifier keys themselves
  if (!['control', 'meta', 'shift', 'alt'].includes(k)) parts.push(k);
  return parts.join('+');
}

// Pretty-print a combo for display: "mod+k" → "⌘ K" / "Ctrl K"
function prettyCombo(combo) {
  if (!combo) return '—';
  // sequence?
  if (combo.includes(' ')) {
    return combo.split(' ').map(t => t.toUpperCase()).join(' then ');
  }
  return combo.split('+').map(t => {
    if (t === 'mod') return IS_MAC ? '⌘' : 'Ctrl';
    if (t === 'shift') return IS_MAC ? '⇧' : 'Shift';
    if (t === 'alt') return IS_MAC ? '⌥' : 'Alt';
    if (t === 'esc') return 'Esc';
    if (t === 'space') return 'Space';
    return t.length === 1 ? t.toUpperCase() : t;
  }).join(' ');
}

// A <kbd>-style chip showing a combo
const KbdCombo = ({ combo }) => {
  const txt = prettyCombo(combo);
  const tokens = combo && combo.includes(' ') ? [txt] : txt.split(' ');
  return (
    <span style={{ display: 'inline-flex', gap: 3 }}>
      {tokens.map((t, i) => (
        <kbd key={i} style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600,
          padding: '2px 7px', minWidth: 22, textAlign: 'center',
          background: 'var(--bg-elev)', border: '1px solid var(--border)',
          borderBottomWidth: 2, borderRadius: 5, color: 'var(--text)',
        }}>{t}</kbd>
      ))}
    </span>
  );
};

window.HelixShortcuts = HelixShortcuts;
window.SHORTCUT_GROUPS = SHORTCUT_GROUPS;
window.ALL_SHORTCUT_ACTIONS = ALL_ACTIONS;
window.comboFromEvent = comboFromEvent;
window.prettyCombo = prettyCombo;
window.KbdCombo = KbdCombo;
