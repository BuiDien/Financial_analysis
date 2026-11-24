// Lucian UX/UI Prompt #047 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#047
import React from 'react';
import { lxUid, lxReducedMotion } from './util.js';
import './segmented.css';

// Period segmented control. Props: { value, options:[{value,label}] | string[], onChange, ariaLabel? }.
// The knob stretches toward the new option (leading edge fast, trailing edge springs); left/right
// arrows move the choice. value={null} = no selection: no option is checked and the knob is hidden;
// the first option takes the Tab stop, Space/Enter checks the focused one, → checks the first option and ← the last. (A value that matches no option
// still shows the first one, as before.)
const LxSegmented = ({ value, options = [], onChange, ariaLabel = 'Choose one', size = 'md' }) => {
  const opts = options.map(o => (typeof o === 'object' ? o : { value: o, label: String(o) }));
  const segRef = React.useRef(null);
  const knobRef = React.useRef(null);
  const btnRefs = React.useRef([]);
  const prevIndex = React.useRef(-1);
  const none = value === null;
  const index = none ? -1 : Math.max(0, opts.findIndex(o => String(o.value) === String(value)));

  const place = React.useCallback(dir => {
    const seg = segRef.current, knob = knobRef.current, o = btnRefs.current[index];
    if (seg && knob) knob.classList.toggle('is-none', index < 0);
    if (!seg || !knob || !o) return;
    seg.classList.toggle('go-r', dir > 0);
    seg.classList.toggle('go-l', dir < 0);
    knob.style.setProperty('--l', o.offsetLeft + 'px');
    knob.style.setProperty('--r', (seg.clientWidth - o.offsetLeft - o.offsetWidth) + 'px');
  }, [index]);
  React.useLayoutEffect(() => {
    const dir = prevIndex.current < 0 || index < 0 ? 0 : index > prevIndex.current ? 1 : index < prevIndex.current ? -1 : 0;
    prevIndex.current = index;
    place(dir);
  }, [index, place]);
  React.useEffect(() => {
    if (!('ResizeObserver' in window) || !segRef.current) return undefined;
    const ro = new ResizeObserver(() => place(0));
    ro.observe(segRef.current);
    return () => ro.disconnect();
  }, [place]);

  const select = (i, focus) => {
    if (focus) btnRefs.current[i]?.focus();
    if (i !== index) onChange?.(opts[i].value);
  };
  return <div className={`ux u047${size === 'sm' ? ' is-sm' : ''}`}>
    <div ref={segRef} className="u047-seg" role="radiogroup" aria-label={ariaLabel} style={{ gridTemplateColumns: `repeat(${opts.length || 1},1fr)` }}>
      <span ref={knobRef} className="u047-knob" aria-hidden="true" />
      {opts.map((o, i) => <button key={String(o.value)} ref={el => { btnRefs.current[i] = el; }} className="u047-opt" type="button" role="radio"
        aria-checked={i === index ? 'true' : 'false'} tabIndex={i === index || (index < 0 && i === 0) ? 0 : -1}
        onClick={() => select(i)}
        onKeyDown={e => {
          const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
          // No selection yet: → checks the first option, ← the last.
          if (d) { e.preventDefault(); select(index < 0 ? (d > 0 ? 0 : opts.length - 1) : (i + d + opts.length) % opts.length, true); }
        }}>{o.label}</button>)}
    </div>
  </div>;
};

export { LxSegmented };
