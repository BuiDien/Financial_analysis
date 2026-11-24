// Lucian UX/UI Prompt #433 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#433
// Checkbox, Radio(Group) and Switch: the checkbox bounces as its check draws in, the radio dot springs
// over, the switch thumb stretches while pressed before gliding across. Native inputs underneath, so
// Tab / Space / arrow keys work as usual. All controlled.
//
// <Checkbox checked onChange(bool) label description? indeterminate? disabled />
// <Switch checked onChange(bool) label labelPosition="start|end" disabled />
// <RadioGroup value onChange(value) options={[{ value, label, disabled? }]} ariaLabel direction="row|column" />

import React from 'react';
import { cx, useUid } from './util.js';
import './choice.css';

const Label = ({ label, description }) => (label == null && description == null ? null : (
  <span>{label}{description && <span className="u433-desc">{description}</span>}</span>
));

const Checkbox = ({ checked = false, onChange, label, description, indeterminate = false, disabled = false, className, ...rest }) => {
  const ref = React.useRef(null);
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate && !checked; }, [indeterminate, checked]);
  return (
    <label className={cx('ux u433 u433-row', disabled && 'is-disabled', className)}>
      <input ref={ref} className="u433-in" type="checkbox" checked={!!checked} disabled={disabled}
        onChange={e => onChange?.(e.target.checked, e)} {...rest} />
      <span className="u433-cb" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5.5 12.5 4 4 9-9.5" /></svg><i /></span>
      <Label label={label} description={description} />
    </label>
  );
};

const Switch = ({ checked = false, onChange, label, description, labelPosition = 'start', disabled = false, className, ...rest }) => {
  const [press, setPress] = React.useState(false);
  const off = () => setPress(false);
  return (
    <label className={cx('ux u433 u433-row u433-sw-row', labelPosition === 'end' && 'is-end', press && 'is-press', disabled && 'is-disabled', className)}
      onPointerDown={e => { if (e.button === 0 && !disabled) setPress(true); }}
      onPointerUp={off} onPointerLeave={off} onPointerCancel={off}>
      {labelPosition !== 'end' && <Label label={label} description={description} />}
      <input className="u433-in" type="checkbox" role="switch" checked={!!checked} disabled={disabled}
        onChange={e => onChange?.(e.target.checked, e)}
        onKeyDown={e => { if (e.key === ' ') setPress(true); }} onKeyUp={off} {...rest} />
      <span className="u433-sw" aria-hidden="true" />
      {labelPosition === 'end' && <Label label={label} description={description} />}
    </label>
  );
};

const Radio = ({ checked, onChange, label, description, name, value, disabled, className }) => (
  <label className={cx('u433-row', disabled && 'is-disabled', className)}>
    <input className="u433-in" type="radio" name={name} value={String(value)} checked={!!checked} disabled={disabled}
      onChange={() => onChange?.(value)} />
    <span className="u433-rd" aria-hidden="true" />
    <Label label={label} description={description} />
  </label>
);

const RadioGroup = ({ value, onChange, options = [], ariaLabel, name, direction = 'row', disabled = false, className }) => {
  const uid = useUid('u433');
  const group = name || uid;
  return (
    <div className={cx('ux u433-rg', direction === 'column' && 'is-col', className)} role="radiogroup" aria-label={ariaLabel}>
      {options.map(o => {
        const opt = typeof o === 'object' ? o : { value: o, label: String(o) };
        return <Radio key={String(opt.value)} name={group} value={opt.value} label={opt.label} description={opt.description}
          checked={String(opt.value) === String(value)} disabled={disabled || opt.disabled} onChange={onChange} />;
      })}
    </div>
  );
};

export { Checkbox, Switch, Radio, RadioGroup };
