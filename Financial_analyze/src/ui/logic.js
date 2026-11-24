// Pure helpers behind src/ui components (no React, no DOM), so node tests can import them
// (scripts/test-ui-logic.mjs). Each one is used by exactly the component named in its comment.

// DataTable — a group marker item in `rows`: { group: label, meta?, key? } and nothing else.
const MARKER_KEYS = new Set(['group', 'meta', 'key']);
const isGroupMarker = (r) => !!r && typeof r === 'object' && !Array.isArray(r) && r.group != null
  && Object.keys(r).every(k => MARKER_KEYS.has(k));

// DataTable — split rows into groups: [{ label, meta?, key, rows }], or null when not grouped.
// Marker items win over groupBy. Data rows before the first marker go in a leading group with
// label null (no header row). groupBy groups keep first-appearance order. sortSeg sorts inside each.
const groupRows = (rows, groupBy, sortSeg = (x) => x) => {
  if (rows.some(isGroupMarker)) {
    const out = [];
    let cur = null;
    rows.forEach(r => {
      if (isGroupMarker(r)) { cur = { label: r.group, meta: r.meta, key: r.key ?? `g${out.length}:${r.group}`, rows: [] }; out.push(cur); return; }
      if (!cur) { cur = { label: null, key: 'g-lead', rows: [] }; out.push(cur); }
      cur.rows.push(r);
    });
    return out.map(g => ({ ...g, rows: sortSeg(g.rows) }));
  }
  if (groupBy) {
    const get = typeof groupBy === 'function' ? groupBy : (r) => r?.[groupBy];
    const map = new Map();
    rows.forEach(r => {
      const label = get(r) ?? '—';
      const id = String(label);
      if (!map.has(id)) map.set(id, { label, key: `g:${id}`, rows: [] });
      map.get(id).rows.push(r);
    });
    return [...map.values()].map(g => ({ ...g, rows: sortSeg(g.rows) }));
  }
  return null;
};

// Menu — where a menu of size mw×mh goes in a vw×vh viewport. With anchorRect ({left,top,right,bottom})
// it sits `gap` below the anchor (start- or end-aligned) and flips above when there is no room; at a
// point (x, y) it opens down-right and flips left / up near the edges. Always kept `edge` px inside.
const placeMenu = ({ x = 0, y = 0, anchorRect = null, align = 'start', mw, mh, vw, vh, gap = 6, edge = 8 }) => {
  let px, py, flipX = false, flipY = false;
  if (anchorRect) {
    px = align === 'end' ? anchorRect.right - mw : anchorRect.left;
    py = anchorRect.bottom + gap;
    if (py + mh > vh - edge && anchorRect.top - gap - mh >= edge) { py = anchorRect.top - gap - mh; flipY = true; }
    flipX = align === 'end';
  } else {
    px = x; py = y;
    if (px + mw > vw - edge) { px = Math.max(edge, px - mw); flipX = true; }
    if (py + mh > vh - edge) { py = Math.max(edge, py - mh); flipY = true; }
  }
  px = Math.max(edge, Math.min(px, vw - mw - edge));
  py = Math.max(edge, Math.min(py, vh - mh - edge));
  return { left: Math.round(px), top: Math.round(py), origin: `${flipX ? 'right' : 'left'} ${flipY ? 'bottom' : 'top'}` };
};

// Menu — next enabled index from position k in `enabled` (indices of enabled items), wrapping.
// k = -1 (nothing focused) starts from the first (dir 1) or last (dir -1).
const cycleIndex = (enabled, k, dir) => {
  if (!enabled.length) return -1;
  if (k < 0) return enabled[dir > 0 ? 0 : enabled.length - 1];
  return enabled[(k + dir + enabled.length) % enabled.length];
};

// Select — next enabled option index from i going dir (±1), clamped (no wrap); i itself if none.
const stepEnabled = (options, i, dir) => {
  for (let j = i + dir; j >= 0 && j < options.length; j += dir) if (options[j] && !options[j].disabled) return j;
  return i;
};

// AreaChart — gridlines that fit a plot h px tall: one per ~44px, between 2 and max.
const MIN_TICK_GAP = 44;
const tickCount = (h, max = 5) => Math.max(2, Math.min(max, Math.floor(h / MIN_TICK_GAP) + 1));

// AreaChart — drop axis labels that would overlap (minGap px apart, top-down). ys: label y positions.
const thinLabels = (ys, minGap = 12) => {
  let last = -Infinity;
  return ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y).filter(t => {
    if (t.y - last < minGap) return false;
    last = t.y;
    return true;
  }).map(t => t.i);
};

// Toast — two actions are compatible for dedupe when neither toast has one, or both call the same
// onClick (a different handler, e.g. Undo of another item, must keep its own toast).
const sameAction = (a, b) => (!a && !b) || (!!a && !!b && a.onClick === b.onClick);
// Toast — the visible toast a new one would duplicate (same message, type and action; both dedupe-able).
const findTwin = (list, t, liveIds) => (t.dedupe === false ? null
  : list.find(x => !x.gone && x.dedupe !== false && (!liveIds || liveIds.includes(x.id)) && x.message === t.message && x.type === t.type
    && sameAction(x.action, t.action)) || null);

export { isGroupMarker, groupRows, placeMenu, cycleIndex, stepEnabled, tickCount, thinLabels, findTwin, sameAction };
