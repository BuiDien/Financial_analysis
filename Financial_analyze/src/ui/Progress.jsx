// ProgressBar (#083) and JobSteps (#454). Styles: ./progress.css.

import React from 'react';
import { cx } from './util.js';
import './progress.css';

const STATUS = {
  queued: ['Queued', 'var(--ux-warn)'],
  running: ['Running', 'var(--ux-accent)'],
  done: ['Done', 'var(--ux-mint)'],
  failed: ['Failed', 'var(--ux-danger)'],
};
// Normalises backend job statuses (pending/queued, running/started, done/finished/ok, failed/error).
const normStatus = (s) => {
  const v = String(s || '').toLowerCase();
  if (['done', 'finished', 'ok', 'success', 'completed', 'ready'].includes(v)) return 'done';
  if (['failed', 'error', 'cancelled', 'canceled'].includes(v)) return 'failed';
  if (['running', 'started', 'processing', 'active'].includes(v)) return 'running';
  return 'queued';
};

// Lucian UX/UI Prompt #083 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#083
// <ProgressBar value={0–100 | null} status="queued|running|done|failed" title? subtitle? label? meta?
//   statusLabel? log?={[{ text, done?, failed?, time? }]} size="sm|md" card? ariaLabel hideMeta? width? />
// hideMeta drops the right-hand meta text (the default "NN%") — the row stays only if there is a label.
// width sets the bar's width (px number or any CSS length) for inline use in a toolbar or table cell.
// value null (or status queued) = indeterminate: two segments stretch and slide. A number turns the same
// track into a filling bar (mint when done, red when failed). title/subtitle add a header with the
// status pill; label/meta make the row under the bar (meta defaults to "NN%").
const ProgressBar = ({
  value = null, status, title, subtitle, label, meta, statusLabel, log, size = 'md', card = false, ariaLabel = 'Progress', className,
  hideMeta = false, width,
}) => {
  const st = status ? normStatus(status) : value == null ? 'queued' : value >= 100 ? 'done' : 'running';
  const det = value != null && Number.isFinite(Number(value)) && st !== 'queued';
  const pct = det ? Math.max(0, Math.min(100, Number(value))) : st === 'done' ? 100 : null;
  const showFill = det || st === 'done' || st === 'failed';
  const [pillText, c] = STATUS[st];
  const metaText = hideMeta ? '' : meta !== undefined ? meta : pct != null ? `${Math.round(pct)}%` : '';
  return (
    <div className={cx('ux u083', showFill && 'is-det', st === 'done' && 'is-done', st === 'failed' && 'is-failed', size === 'sm' && 'is-sm', card && 'is-card', className)}
      style={width != null ? { width, maxWidth: '100%' } : undefined}>
      {(title || subtitle) && (
        <div className="u083-h">
          <span>{title && <b>{title}</b>}{subtitle && <small>{subtitle}</small>}</span>
          <span className="u083-pill" role="status" aria-live="polite" style={{ '--c': c }}>{statusLabel || pillText}</span>
        </div>
      )}
      <div className="u083-trk" role="progressbar" aria-label={ariaLabel} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={pct != null ? Math.round(pct) : undefined} aria-valuetext={pct == null ? (statusLabel || pillText) : undefined}>
        <span className="u083-seg a" aria-hidden="true" /><span className="u083-seg b" aria-hidden="true" />
        <span className="u083-fill" aria-hidden="true" style={{ '--p': (pct ?? (st === 'failed' ? 100 : 0)) / 100 }} />
      </div>
      {(label || metaText) && <div className="u083-meta"><span>{label}</span><span>{metaText}</span></div>}
      {log && log.length > 0 && (
        <ol className="u083-log" aria-label={`${ariaLabel} log`}>
          {log.slice(-6).map((l, i) => (
            <li key={l.key ?? `${i}-${l.text}`} className={l.failed ? 'fail' : l.done ? 'ok' : undefined}>
              <span className="u083-st" aria-hidden="true" />{l.time && <time>{l.time}</time>}<span>{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};

const fmtElapsed = (sec) => (sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`);

// Lucian UX/UI Prompt #454 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#454
// <JobSteps steps={[{ label, status: 'wait'|'run'|'done'|'fail' ('failed' also accepted), meta? }]} startedAt? finishedAt?
//   workingLabel="Working" doneLabel="Done" onRerun? bare? wrap? ariaLabel />
// wrap: long labels (and meta) wrap onto more lines instead of being cut with "…"; each step grows to fit
// and the connector is measured from the first to the last step icon, so it stays joined.
// Each step spins while running and pops into a check when done; the connector fills down to the
// furthest reached step. The footer shows "Working · 12s" (ticking from startedAt) and turns into
// "Done · took 38s" when every step is done (or failed). onRerun shows the ↻ button once finished.
const JobSteps = ({
  steps = [], startedAt, finishedAt, workingLabel = 'Working', doneLabel = 'Done', failedLabel = 'Failed',
  onRerun, bare = false, wrap = false, ariaLabel = 'Steps', className,
}) => {
  // 'failed' (job vocabulary, as in normStatus) is accepted as 'fail'.
  steps = steps.map(s => (s && s.status === 'failed' ? { ...s, status: 'fail' } : s));
  const n = steps.length;
  const finished = n > 0 && steps.every(s => s.status === 'done' || s.status === 'fail');
  const failed = steps.some(s => s.status === 'fail');
  let reach = -1;
  steps.forEach((s, i) => { if (s.status !== 'wait' && s.status != null) reach = i; });
  const t0 = startedAt ? new Date(startedAt).getTime() : null;
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!t0 || finished) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [t0, finished]);
  const end = finished && finishedAt ? new Date(finishedAt).getTime() : now;
  const secs = t0 ? Math.max(0, Math.floor((end - t0) / 1000)) : null;
  const listRef = React.useRef(null);
  // wrap: steps have their own heights, so the connector spans the measured icon centres.
  const [geo, setGeo] = React.useState(null);
  React.useLayoutEffect(() => {
    if (!wrap || n < 2 || !listRef.current) { setGeo(null); return undefined; }
    const list = listRef.current;
    const measure = () => {
      const box = list.parentElement.getBoundingClientRect();
      const cs = Array.from(list.querySelectorAll('.u454-ic')).map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 - box.top; });
      if (cs.length < 2) return;
      const top = cs[0], h = cs[cs.length - 1] - cs[0];
      const p = h > 0 ? (cs[Math.max(0, reach)] - top) / h : 0;
      setGeo(g => (g && Math.abs(g.top - top) < 0.5 && Math.abs(g.h - h) < 0.5 && Math.abs(g.p - p) < 0.001 ? g : { top, h, p }));
    };
    measure();
    if (!('ResizeObserver' in window)) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, [wrap, n, reach, steps.map(s => `${s.label}|${s.meta ?? ''}`).join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps
  const track = wrap && geo
    ? <i className="u454-tr" aria-hidden="true" style={{ top: geo.top, height: geo.h }}><i style={{ '--u454-p': geo.p }} /></i>
    : <i className="u454-tr" aria-hidden="true" style={{ height: (n - 1) * 38 }}><i style={{ '--u454-p': Math.max(0, reach) / (n - 1) }} /></i>;
  return (
    <div className={cx('ux u454', finished && 'is-done', failed && 'is-failed', bare && 'is-bare', wrap && 'is-wrap', className)}>
      <div className="u454-c">
        {n > 1 && track}
        <ol ref={listRef} className="u454-l" aria-label={ariaLabel} tabIndex={-1}>
          {steps.map((s, i) => (
            <li key={s.key ?? i} className="u454-s" data-s={s.status || 'wait'} aria-current={s.status === 'run' ? 'step' : undefined}>
              <span className="u454-ic" aria-hidden="true">
                <i className="u454-d" /><i className="u454-sp" />
                <span className="u454-ck"><svg viewBox="0 0 24 24"><path d="m6 12.5 4 4 8-9" /></svg></span>
                <span className="u454-fx2"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17" /></svg></span>
              </span>
              <span className="u454-t">{s.label}<span className="sr-only">{s.status === 'run' ? ' in progress' : s.status === 'done' ? ' done' : s.status === 'fail' ? ' failed' : ''}</span></span>
              {s.meta != null && <span className={cx('u454-m', s.status === 'run' && 'is-live')}>{s.meta}</span>}
            </li>
          ))}
        </ol>
        {!bare && (
          <div className="u454-f">
            <span className="u454-fi" aria-hidden="true"><i className="u454-pu" /><svg className="u454-ok" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.2" />{failed ? <path d="M9 9l6 6M15 9l-6 6" /> : <path d="m8 12.3 2.8 2.8L16.2 9.6" />}</svg></span>
            <span className="u454-fx">
              <span className="u454-fw" aria-hidden={finished}><b>{workingLabel}</b>{secs != null && <small>{fmtElapsed(secs)}</small>}</span>
              <span className="u454-fd" aria-hidden={!finished}><b>{failed ? failedLabel : doneLabel}</b>{secs != null && <small>· took {fmtElapsed(secs)}</small>}</span>
            </span>
            {onRerun && (
              <button type="button" className="u454-re" aria-label="Run again" tabIndex={finished ? 0 : -1}
                onClick={() => { if (finished) { onRerun(); listRef.current?.focus({ preventScroll: true }); } }}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" /><path d="M4.5 4.5v3.8h3.8" /></svg>
              </button>
            )}
          </div>
        )}
      </div>
      <p className="sr-only" role="status">{finished ? (failed ? failedLabel : doneLabel) : ''}</p>
    </div>
  );
};

export { ProgressBar, JobSteps, normStatus };
