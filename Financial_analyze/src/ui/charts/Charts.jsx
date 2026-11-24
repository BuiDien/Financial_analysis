// Lucian UX/UI Prompt #400 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#400
import React from 'react';
import { lxUid, lxReducedMotion, lxMeasure, lxFit, LX_FONT } from '../util.js';
import './charts.css';

// Synced-cursor small multiples. Props: { series:[{key,name,color,points:[{x,y,status,origin}]}],
// xs? (ordered x values; default: union of the points' x in first-seen order), onPointClick(series, point),
// formatValue(y, series), formatX?(x), title? }. Charts stack on one x axis, each with its own scale;
// lines draw left to right on first view; one crosshair sweeps all charts. Each chart's title reads
// "name · value · change since the first period" (value = latest, or the cursor's period while hovering;
// a calculated value gets "· calc."); long names are cut to fit. Solid point = printed, hollow =
// calculated (origin), danger ring on the baseline + "⚠ sources differ" = open conflict (status
// 'conflict', no value plotted). Colours may be CSS var() strings. Keyboard: ←/→ move the cursor,
// ↑/↓ pick a chart, Enter opens that point, Esc clears.
const LxSmallMultiples = ({ series = [], xs, onPointClick, formatValue = v => String(v), formatX = x => String(x), title = '' }) => {
  const rootRef = React.useRef(null);
  const ovRef = React.useRef(null);
  const clipRef = React.useRef(null);
  const uid = React.useMemo(() => lxUid('u400'), []);
  const [W, setW] = React.useState(300);
  const [hov, setHov] = React.useState(-1);
  const [band, setBand] = React.useState(-1);

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    setW(Math.max(240, Math.round(el.clientWidth)));
    if (!('ResizeObserver' in window)) return undefined;
    const ro = new ResizeObserver(es => setW(Math.max(240, Math.round(es[0].contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const X_ = React.useMemo(() => {
    if (xs && xs.length) return xs;
    const seen = [];
    series.forEach(s => (s.points || []).forEach(p => { if (!seen.some(x => String(x) === String(p.x))) seen.push(p.x); }));
    return seen;
  }, [xs, series]);
  const N = X_.length;
  const XL = 22, XR = W - 18, TOP = 74, STEP = 86, PH = 50;
  const H = TOP + series.length * STEP + 40;
  const at = (s, i) => (s.points || []).find(p => String(p.x) === String(X_[i])) || null;
  const X = i => (N <= 1 ? (XL + XR) / 2 : XL + i / (N - 1) * (XR - XL));
  const ranges = series.map(s => {
    const ys = (s.points || []).map(p => p.y).filter(y => y !== null && y !== undefined && isFinite(y));
    if (!ys.length) return [0, 1];
    let mn = Math.min(...ys), mx = Math.max(...ys);
    if (mn === mx) { mn -= Math.abs(mn) * 0.1 || 1; mx += Math.abs(mx) * 0.1 || 1; }
    const pad = (mx - mn) * 0.1;
    return [mn - pad, mx + pad];
  });
  const Y = (k, v) => { const r = ranges[k], t = TOP + k * STEP + 22; return t + PH - (v - r[0]) / (r[1] - r[0]) * PH; };
  const has = p => p && p.y !== null && p.y !== undefined && isFinite(p.y);
  const linePath = (s, k) => {
    let d = '', pen = false;
    for (let i = 0; i < N; i++) {
      const p = at(s, i);
      // Any period without a plotted value (missing, or an open conflict) breaks the line: never
      // draw a segment that implies numbers that are not there. Isolated points stay as markers.
      if (!has(p)) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(k, p.y).toFixed(1) + ' ';
      pen = true;
    }
    return d.trim();
  };
  const lastIndex = s => { for (let i = N - 1; i >= 0; i--) if (has(at(s, i))) return i; return -1; };
  const firstIndex = s => { for (let i = 0; i < N; i++) if (has(at(s, i))) return i; return -1; };

  // Draw-in: the clip rect grows left to right once the charts scroll into view.
  React.useEffect(() => {
    const rect = clipRef.current, root = rootRef.current;
    if (!rect || !root) return undefined;
    if (lxReducedMotion() || !('IntersectionObserver' in window)) { rect.setAttribute('width', '100%'); return undefined; }
    let raf = 0, done = false;
    const io = new IntersectionObserver(es => {
      if (!es[0].isIntersecting || done) return;
      done = true; io.disconnect();
      const t0 = performance.now();
      const f = now => {
        const k = Math.min(1, (now - t0) / 1000), e = 1 - Math.pow(1 - k, 3);
        const w = root.clientWidth || 300;
        rect.setAttribute('width', (XL + (w - 18 - XL + 4) * e).toFixed(1));
        if (k < 1) raf = requestAnimationFrame(f); else rect.setAttribute('width', '100%');
      };
      raf = requestAnimationFrame(f);
    });
    io.observe(root);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  const pick = e => {
    const r = ovRef.current.getBoundingClientRect();
    const x = (e.clientX - r.left) + 12;
    const i = N <= 1 ? 0 : Math.max(0, Math.min(N - 1, Math.round((x - XL) / (XR - XL) * (N - 1))));
    const k = Math.max(0, Math.min(series.length - 1, Math.floor((e.clientY - r.top) / STEP)));
    return { i, k };
  };
  const openPoint = (k, i) => {
    const s = series[k];
    const p = s && at(s, i);
    if (s && p) onPointClick?.(s, p);
  };
  const shown = hov < 0 ? -1 : hov;
  const dtText = N === 0 ? 'No periods' : shown < 0 ? `Latest · ${formatX(X_[N - 1])}` : formatX(X_[shown]);
  const ticks = N <= 4 ? X_.map((_, i) => i) : [0, Math.round((N - 1) / 3), Math.round(2 * (N - 1) / 3), N - 1];

  return <div ref={rootRef} className={`ux u400${hov >= 0 ? ' is-hov' : ''}`} style={{ height: H }}>
    <div className="u400-hd"><b>{title}</b></div>
    <div className="u400-dt" aria-live="polite">{dtText}</div>
    <svg className="u400-sv" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <defs><clipPath id={`${uid}c`}><rect ref={clipRef} x="0" y="0" width="0" height={H} /></clipPath></defs>
      <g>
        {series.map((s, k) => {
          const t = TOP + k * STEP, base = TOP + k * STEP + 22 + PH;
          const li = shown < 0 ? lastIndex(s) : shown;
          const p = li >= 0 ? at(s, li) : null;
          const fi = firstIndex(s), lp = lastIndex(s);
          const first = fi >= 0 ? at(s, fi) : null, latest = lp >= 0 ? at(s, lp) : null;
          const chg = first && latest && fi !== lp && first.y !== 0 ? (latest.y - first.y) / Math.abs(first.y) * 100 : null;
          const valueText = q => (has(q) ? formatValue(q.y, s) + (q.origin === 'calculated' ? ' · calc.' : '') : (q && q.status === 'conflict' ? '⚠ sources differ' : '—'));
          const chgText = chg !== null ? `${chg >= 0 ? '+' : ''}${chg.toFixed(0)}% since ${formatX(X_[fi])}` : '';
          // Reserve the widest value this chart can show, so the name does not jump while the cursor moves.
          const widest = Math.max(lxMeasure('—', `900 14px ${LX_FONT}`), ...X_.map((_, i) => lxMeasure(valueText(at(s, i)), `900 14px ${LX_FONT}`)));
          const rightW = widest + (chgText ? lxMeasure(chgText, `850 10px ${LX_FONT}`) + 8 : 0);
          const nameText = lxFit(s.name, XR - XL - rightW - 14, `800 10.5px ${LX_FONT}`);
          const conflictCue = p && !has(p) && p.status === 'conflict';
          return <g key={s.key}>
            <text className="u400-nm" x={XL} y={t + 10}>{nameText}</text>
            <text className="u400-v" x={XR} y={t + 10}>
              <tspan style={conflictCue ? { fill: 'var(--ux-danger)' } : undefined}>{valueText(p)}</tspan>
              {chgText && <tspan className="u400-dl" dx="8" style={{ fill: chg >= 0 ? 'var(--ux-mint)' : 'var(--ux-danger)' }}>{chgText}</tspan>}
            </text>
            <line x1={XL} x2={XR} y1={base} y2={base} stroke="currentColor" strokeOpacity=".1" />
            <g clipPath={`url(#${uid}c)`}>
              <path d={linePath(s, k)} fill="none" style={{ stroke: s.color }} strokeWidth="2" strokeLinejoin="round" />
              {X_.map((x, i) => {
                const q = at(s, i);
                if (!q) return null;
                if (q.status === 'conflict' && !has(q)) {
                  const anchor = N > 1 && i === 0 ? 'start' : N > 1 && i === N - 1 ? 'end' : 'middle';
                  return <g key={i}>
                    <circle className="u400-cf" cx={X(i)} cy={base} r="4.5" />
                    <text className="u400-cfl" x={X(i) + (anchor === 'start' ? -4 : anchor === 'end' ? 4 : 0)} y={base - 8} style={{ textAnchor: anchor }}>⚠ sources differ</text>
                  </g>;
                }
                if (!has(q)) return null;
                return <g key={i}>
                  <circle className={`u400-pt${q.origin === 'calculated' ? ' calc' : ''}`} cx={X(i)} cy={Y(k, q.y)} r="2.6"
                    style={{ fill: q.origin === 'calculated' ? undefined : s.color, stroke: s.color }} />
                  {q.status === 'conflict' && <circle className="u400-cf" cx={X(i)} cy={Y(k, q.y)} r="4.5" />}
                </g>;
              })}
            </g>
            {has(p) && <circle className="u400-dot" r="4" style={{ fill: s.color }} cx={X(li)} cy={Y(k, p.y)} />}
          </g>;
        })}
        {N > 0 && <line className="u400-xh" x1={X(Math.max(0, shown))} x2={X(Math.max(0, shown))} y1={TOP + 14} y2={TOP + Math.max(0, series.length - 1) * STEP + 22 + PH} />}
        {ticks.map(i => <text key={i} className="u400-tk" x={X(i)} y={TOP + Math.max(0, series.length - 1) * STEP + 22 + PH + 14}
          style={N > 1 && i === 0 ? { textAnchor: 'start' } : N > 1 && i === N - 1 ? { textAnchor: 'end' } : undefined}>{formatX(X_[i])}</text>)}
      </g>
    </svg>
    <div ref={ovRef} className="u400-ov" tabIndex={0} role="img" style={{ height: series.length * STEP }}
      aria-label={`${series.map(s => s.name).join(', ')} charts. Use left and right arrows to move between periods, up and down to pick a chart, Enter to open the source.`}
      onPointerMove={e => { const { i } = pick(e); setHov(i); }}
      onPointerDown={e => { const { i } = pick(e); setHov(i); }}
      onPointerLeave={() => setHov(-1)}
      onClick={e => { const { i, k } = pick(e); openPoint(k, i); }}
      onBlur={() => { setHov(-1); setBand(-1); }}
      onKeyDown={e => {
        if (!N) return;
        if (e.key === 'Escape') { setHov(-1); setBand(-1); return; }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPoint(Math.max(0, band), hov < 0 ? N - 1 : hov); return; }
        const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        if (!dx && !dy) return;
        e.preventDefault();
        if (dx) setHov(h => Math.max(0, Math.min(N - 1, (h < 0 ? N - 1 : h) + dx)));
        if (dy) { setBand(b => (b < 0 ? (dy > 0 ? 0 : series.length - 1) : Math.max(0, Math.min(series.length - 1, b + dy)))); setHov(h => (h < 0 ? N - 1 : h)); }
      }}>
      {band >= 0 && <div className="u400-band" style={{ top: band * STEP, height: STEP - 6 }} />}
    </div>
  </div>;
};

// Growth chart (start = 100). No Lucian element matches (spec §6.7a), so it is built from #400's marks,
// tokens, crosshair and draw-in (Lucian UX/UI Prompt #400 · MIT License (c) 2026 Seokwoooo ·
// https://lucianlabs.dev/uxui-prompt/#400). Props: { series:[{key,name,color,points:[{x,y,status,origin}]}],
// xs?, formatValue(y, series), formatX?(x), onPointClick(series, point), title? }.
// One chart, one axis: every line is value / its first value in view × 100. A line whose first value is
// zero or negative cannot be indexed; the legend says so and it is not drawn. The tooltip lists every
// line at the cursor (index first, then the real value). Direct end labels for ≤ 4 lines when they fit
// and do not collide (otherwise the legend carries identity). An open conflict has no value: a danger
// ring + "⚠ sources differ" marks its period in a strip under the period labels. Keyboard: ←/→ move, ↑/↓ pick a line,
// Enter opens the point, Esc clears.
const lxNiceStep = raw => {
  if (!(raw > 0)) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};
const LxGrowthChart = ({ series = [], xs, onPointClick, formatValue = v => String(v), formatX = x => String(x), title = '' }) => {
  const rootRef = React.useRef(null);
  const ovRef = React.useRef(null);
  const clipRef = React.useRef(null);
  const uid = React.useMemo(() => lxUid('lxg'), []);
  const [W, setW] = React.useState(300);
  const [hov, setHov] = React.useState(-1);
  const [band, setBand] = React.useState(-1);

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const inner = el2 => Math.max(240, Math.round(el2.clientWidth - 32));
    setW(inner(el));
    if (!('ResizeObserver' in window)) return undefined;
    const ro = new ResizeObserver(() => setW(inner(el)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const X_ = React.useMemo(() => {
    if (xs && xs.length) return xs;
    const seen = [];
    series.forEach(s => (s.points || []).forEach(p => { if (!seen.some(x => String(x) === String(p.x))) seen.push(p.x); }));
    return seen;
  }, [xs, series]);
  const N = X_.length;
  const has = p => p && p.y !== null && p.y !== undefined && isFinite(p.y);
  const rows = series.map(s => {
    const pts = X_.map(x => (s.points || []).find(p => String(p.x) === String(x)) || null);
    const bi = pts.findIndex(has);
    const base = bi >= 0 ? pts[bi].y : null;
    const ok = base !== null && base > 0;
    return { s, pts, ok, base, vals: pts.map(p => (ok && has(p) ? p.y / base * 100 : null)) };
  });
  const drawn = rows.filter(r => r.ok);

  // Scale: one axis, 100 always in view.
  const all = drawn.flatMap(r => r.vals.filter(v => v !== null));
  let mn = Math.min(100, ...all), mx = Math.max(100, ...all);
  if (mx - mn < 1) { mn -= 5; mx += 5; }
  const step = lxNiceStep((mx - mn) / 4);
  mn = Math.floor(mn / step) * step; mx = Math.ceil(mx / step) * step;
  const ticks = [];
  for (let v = mn; v <= mx + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);

  // Direct labels: ≤ 4 drawn lines, room on the right, no collisions — else none.
  const PH = 220, TOP = 10, XL = 40;
  const labelFont = `750 10.5px ${LX_FONT}`;
  const lastIdx = r => { for (let i = N - 1; i >= 0; i--) if (r.vals[i] !== null) return i; return -1; };
  let labels = null;
  if (drawn.length >= 1 && drawn.length <= 4 && W >= 420) {
    const texts = drawn.map(r => lxFit(r.s.name, 120, labelFont));
    labels = { texts, width: Math.max(...texts.map(t => lxMeasure(t, labelFont))) + 12 };
  }
  const XR = W - (labels ? labels.width : 14);
  const Y = v => TOP + PH - (v - mn) / (mx - mn) * PH;
  const BOTTOM = TOP + PH;
  if (labels) {
    const ys = drawn.map(r => { const i = lastIdx(r); return i >= 0 ? Y(r.vals[i]) : null; });
    const sorted = ys.filter(y => y !== null).sort((a, b) => a - b);
    const collide = sorted.some((y, i) => i > 0 && y - sorted[i - 1] < 13);
    labels = collide || ys.some((y, i) => y !== null && lastIdx(drawn[i]) !== N - 1) ? null : { ...labels, ys };
  }
  const XRf = labels ? XR : W - 14;
  const Xf = i => (N <= 1 ? (XL + XRf) / 2 : XL + i / (N - 1) * (XRf - XL));
  const linePath = r => {
    let d = '', pen = false;
    for (let i = 0; i < N; i++) {
      const v = r.vals[i];
      if (v === null) { pen = false; continue; } // missing period or open conflict: break, never bridge
      d += (pen ? 'L' : 'M') + Xf(i).toFixed(1) + ' ' + Y(v).toFixed(1) + ' ';
      pen = true;
    }
    return d.trim();
  };

  React.useEffect(() => {
    const rect = clipRef.current, root = rootRef.current;
    if (!rect || !root) return undefined;
    if (lxReducedMotion() || !('IntersectionObserver' in window)) { rect.setAttribute('width', '100%'); return undefined; }
    let raf = 0, done = false;
    const io = new IntersectionObserver(es => {
      if (!es[0].isIntersecting || done) return;
      done = true; io.disconnect();
      const t0 = performance.now();
      const f = now => {
        const k = Math.min(1, (now - t0) / 1000), e = 1 - Math.pow(1 - k, 3);
        const w = Math.max(240, (root.clientWidth || 300) - 32);
        rect.setAttribute('width', (XL + (w - XL + 4) * e).toFixed(1));
        if (k < 1) raf = requestAnimationFrame(f); else rect.setAttribute('width', '100%');
      };
      raf = requestAnimationFrame(f);
    });
    io.observe(root);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  const pickI = e => {
    const r = ovRef.current.getBoundingClientRect();
    const x = e.clientX - r.left + XL;
    return N <= 1 ? 0 : Math.max(0, Math.min(N - 1, Math.round((x - XL) / (XRf - XL) * (N - 1))));
  };
  // Open conflicts have no value, so they sit in a strip under the period labels, never on the scale.
  const cueAt = i => rows.some(r => r.pts[i] && r.pts[i].status === 'conflict' && r.vals[i] === null && r.ok);
  const hasCue = X_.some((_, i) => cueAt(i));
  const SVG_H = BOTTOM + 26 + (hasCue ? 22 : 0), CUE_Y = BOTTOM + 34;
  const pickRow = (i, py) => {
    let best = -1, dist = Infinity;
    rows.forEach((r, k) => {
      const p = r.pts[i];
      if (!p) return;
      const y = r.vals[i] !== null ? Y(r.vals[i]) : (p.status === 'conflict' ? CUE_Y : null);
      if (y === null) return;
      const d = Math.abs(y - py);
      if (d < dist) { dist = d; best = k; }
    });
    return best;
  };
  const openPoint = (k, i) => {
    const r = rows[k];
    const p = r && r.pts[i];
    if (r && p) onPointClick?.(r.s, p);
  };
  const shown = hov;
  const dtText = N === 0 ? 'No periods' : shown < 0 ? `${formatX(X_[0])} – ${formatX(X_[N - 1])} · start = 100` : formatX(X_[shown]);
  const xt = N <= 4 ? X_.map((_, i) => i) : [0, Math.round((N - 1) / 3), Math.round(2 * (N - 1) / 3), N - 1];
  const tipLeft = shown >= 0 ? (Xf(shown) > W / 2 ? null : Xf(shown) + 12) : null;
  const tipRight = shown >= 0 && Xf(shown) > W / 2 ? W - Xf(shown) + 12 : null;

  return <div ref={rootRef} className={`ux lxg${hov >= 0 ? ' is-hov' : ''}${band >= 0 ? ' has-band' : ''}`}>
    <div className="lxg-hd"><b>{title}</b></div>
    <div className="lxg-dt" aria-live="polite">{dtText}</div>
    {(rows.length > 1 || rows.some(r => !r.ok)) && <ul className="lxg-lg" aria-label="Legend">
      {rows.map(r => <li key={r.s.key} className={r.ok ? '' : 'off'}>
        <i style={{ background: r.s.color }} aria-hidden="true" />{r.s.name}{!r.ok && <small> · can't index (first value is zero, negative or missing)</small>}
      </li>)}
    </ul>}
    <div className="lxg-plot" style={{ height: SVG_H }}>
      <svg className="lxg-sv" width={W} height={SVG_H} viewBox={`0 0 ${W} ${SVG_H}`} aria-hidden="true">
        <defs><clipPath id={`${uid}c`}><rect ref={clipRef} x="0" y="0" width="0" height={SVG_H} /></clipPath></defs>
        {ticks.map(v => <g key={v}>
          <line className={v === 100 ? 'lxg-base' : 'lxg-grid'} x1={XL} x2={XRf} y1={Y(v)} y2={Y(v)} />
          <text className="lxg-yt" x={XL - 6} y={Y(v) + 3}>{v}</text>
        </g>)}
        <g clipPath={`url(#${uid}c)`}>
          {rows.map((r, k) => r.ok && <g key={r.s.key} className={band >= 0 && band !== k ? 'lxg-dim' : ''}>
            <path d={linePath(r)} fill="none" style={{ stroke: r.s.color }} strokeWidth={band === k ? 3 : 2} strokeLinejoin="round" strokeLinecap="round" />
            {r.pts.map((p, i) => {
              if (!p || r.vals[i] === null) return null;
              const calc = p.origin === 'calculated';
              return <g key={i}>
                <circle className={`lxg-pt${calc ? ' calc' : ''}`} cx={Xf(i)} cy={Y(r.vals[i])} r={calc ? 3.5 : 4}
                  style={calc ? { stroke: r.s.color } : { fill: r.s.color }} />
                {p.status === 'conflict' && <circle className="lxg-cf" cx={Xf(i)} cy={Y(r.vals[i])} r="6.5" />}
              </g>;
            })}
          </g>)}
        </g>
        {X_.map((_, i) => {
          if (!cueAt(i)) return null;
          const end = N > 1 && i === N - 1;
          return <g key={`cue${i}`}>
            <circle className="lxg-cf" cx={Xf(i)} cy={CUE_Y} r="4.5" />
            <text className="lxg-cfl" x={Xf(i) + (end ? -9 : 9)} y={CUE_Y + 3.5} style={{ textAnchor: end ? 'end' : 'start' }}>⚠ sources differ</text>
          </g>;
        })}
        {labels && drawn.map((r, j) => <text key={r.s.key} className="lxg-dl" x={XRf + 8} y={labels.ys[j] + 3.5}>{labels.texts[j]}</text>)}
        {N > 0 && <line className="lxg-xh" x1={Xf(Math.max(0, shown))} x2={Xf(Math.max(0, shown))} y1={TOP} y2={BOTTOM} />}
        {shown >= 0 && rows.map(r => (r.ok && r.vals[shown] !== null
          ? <circle key={r.s.key} className="lxg-dot" r="5" style={{ fill: r.s.color }} cx={Xf(shown)} cy={Y(r.vals[shown])} /> : null))}
        {xt.map(i => <text key={i} className="lxg-tk" x={Xf(i)} y={BOTTOM + 16}
          style={N > 1 && i === 0 ? { textAnchor: 'start' } : N > 1 && i === N - 1 ? { textAnchor: 'end' } : undefined}>{formatX(X_[i])}</text>)}
      </svg>
      <div ref={ovRef} className="lxg-ov" tabIndex={0} role="img" style={{ left: XL, width: Math.max(1, XRf - XL), top: TOP, height: hasCue ? CUE_Y + 9 - TOP : PH }}
        aria-label={`Growth since the first period, start = 100: ${rows.map(r => r.s.name).join(', ')}. Use left and right arrows to move between periods, up and down to pick a line, Enter to open the source.`}
        onPointerMove={e => setHov(pickI(e))}
        onPointerDown={e => setHov(pickI(e))}
        onPointerLeave={() => setHov(-1)}
        onClick={e => {
          const i = pickI(e);
          const k = pickRow(i, e.clientY - ovRef.current.getBoundingClientRect().top + TOP);
          if (k >= 0) openPoint(k, i);
        }}
        onBlur={() => { setHov(-1); setBand(-1); }}
        onKeyDown={e => {
          if (!N) return;
          if (e.key === 'Escape') { setHov(-1); setBand(-1); return; }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const i = hov < 0 ? N - 1 : hov;
            const k = band >= 0 ? band : rows.findIndex(r => r.pts[i]);
            if (k >= 0) openPoint(k, i);
            return;
          }
          const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
          if (!dx && !dy) return;
          e.preventDefault();
          if (dx) setHov(h => Math.max(0, Math.min(N - 1, (h < 0 ? N - 1 : h) + dx)));
          if (dy) { setBand(b => (b < 0 ? (dy > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, b + dy)))); setHov(h => (h < 0 ? N - 1 : h)); }
        }} />
      {shown >= 0 && <div className="lxg-tip" style={{ left: tipLeft ?? 'auto', right: tipRight ?? 'auto' }} aria-hidden="true">
        <div className="lxg-tip-h">{formatX(X_[shown])}</div>
        {rows.map((r, k) => {
          const p = r.pts[shown];
          const v = r.vals[shown];
          return <div key={r.s.key} className={`lxg-row${band === k ? ' on' : ''}`}>
            <i style={{ background: r.s.color }} />
            <b>{v !== null ? Math.round(v) : (p && p.status === 'conflict' ? '⚠' : '—')}</b>
            <span>{has(p) ? formatValue(p.y, r.s) + (p.origin === 'calculated' ? ' · calc.' : '') : (p && p.status === 'conflict' ? 'sources differ' : 'no value')}</span>
            <small>{r.s.name}</small>
          </div>;
        })}
      </div>}
    </div>
  </div>;
};

export { LxGrowthChart, LxSmallMultiples };
