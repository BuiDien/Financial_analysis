// Lucian UX/UI Prompt #042 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#042
import React from 'react';
import { lxUid, lxReducedMotion } from './util.js';
import './wizard.css';

// Step-by-step wizard. Props: { steps:[{id,title,label?,description?,bare?,render,canNext}], onFinish, busy,
// finishLabel?, ariaLabel?, header? }. header is an optional slot above the step circles (title, close). The progress line fills to the current circle, finished circles turn
// into checks (press one to go back), content slides in the direction of travel, and the last step's
// button becomes finishLabel. Next is disabled while the step's canNext is false or busy is true.
const LxWizard = ({ steps = [], onFinish, busy = false, finishLabel = 'Finish', ariaLabel = 'Steps', header = null }) => {
  const [cur, setCur] = React.useState(0);
  const [leaving, setLeaving] = React.useState(null); // { index, dir }
  const curRef = React.useRef(null);
  const leaveRef = React.useRef(null);
  const timer = React.useRef(0);
  const moved = React.useRef(0); // direction of the last move, 0 before the first one
  const last = steps.length - 1;
  const step = steps[Math.min(cur, last)];

  const go = i => {
    if (i < 0 || i > last || i === cur) return;
    const dir = i > cur ? 1 : -1;
    moved.current = dir;
    clearTimeout(timer.current);
    setLeaving({ index: cur, dir });
    setCur(i);
    timer.current = setTimeout(() => setLeaving(null), 560);
  };
  React.useEffect(() => () => clearTimeout(timer.current), []);
  React.useLayoutEffect(() => {
    const dir = moved.current;
    const p = curRef.current;
    if (p && dir) {
      p.style.transition = 'none';
      p.style.transform = `translateX(${dir * 40}%)`; p.style.opacity = '0';
      void p.offsetWidth;
      p.style.transition = '';
      p.style.transform = 'none'; p.style.opacity = '1';
      p.scrollTop = 0;
    }
    const old = leaveRef.current;
    if (old && leaving) {
      old.inert = true;
      old.style.transition = 'none'; old.style.transform = 'none'; old.style.opacity = '1';
      void old.offsetWidth;
      old.style.transition = '';
      old.style.transform = `translateX(${-leaving.dir * 40}%)`; old.style.opacity = '0';
    }
  }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!step) return null;
  const canNext = !busy && step.canNext !== false;
  const isLast = cur === last;
  const pane = (s, k, ref, on) => <section key={s.id} ref={ref} className={`u042-pane${on ? ' on' : ''}`} aria-hidden={on ? 'false' : 'true'}>
    {!s.bare && <h4>{s.title}</h4>}
    {!s.bare && s.description && <p>{s.description}</p>}
    {s.render()}
  </section>;

  return <div className={`ux u042${isLast ? ' is-last' : ''}`}>
    {header}
    <ol className="u042-steps" aria-label={ariaLabel}>
      <li className="u042-line" aria-hidden="true" style={{ '--p': last > 0 ? (cur / last).toFixed(3) : 0 }}><i /></li>
      {steps.map((s, k) => {
        const name = s.label || s.title;
        return <li key={s.id} className={`u042-st${k < cur ? ' done' : ''}${k === cur ? ' cur' : ''}`}>
          <button className="u042-dot" type="button" tabIndex={k < cur ? 0 : -1}
            aria-current={k === cur ? 'step' : undefined}
            aria-label={`Step ${k + 1}, ${name}${k < cur ? ', done. Press to go back' : k === cur ? ', current step' : ''}`}
            onClick={() => { if (k < cur) go(k); }}>
            <span>{k + 1}</span><svg viewBox="0 0 16 16"><path d="M3.5 8.4l3 3 6-6.4" /></svg>
          </button>
          <small>{name}</small>
        </li>;
      })}
    </ol>
    <div className="u042-view" aria-live="polite">
      {leaving && steps[leaving.index] && pane(steps[leaving.index], leaving.index, leaveRef, false)}
      {pane(step, cur, curRef, true)}
    </div>
    <div className="u042-foot">
      <button className="u042-b u042-prev" type="button" aria-disabled={cur === 0 ? 'true' : 'false'} onClick={() => go(cur - 1)}>Back</button>
      <button className="u042-b u042-next" type="button" disabled={!canNext}
        onClick={() => { if (!canNext) return; if (isLast) onFinish?.(); else go(cur + 1); }}>
        {isLast ? (busy ? 'Working…' : finishLabel) : 'Next'}
      </button>
    </div>
  </div>;
};

export { LxWizard };
