// Button, IconButton (tokens only — no Lucian match for a dense app button) and CopyButton (#008).
// <Button>/<IconButton> render the legacy .btn / .icon-btn classes, so migrated and un-migrated
// markup look the same. Styles: ./button.css.

import React from 'react';
import { Icon } from './Icon.jsx';
import { cx, lxReducedMotion } from './util.js';
import './button.css';

// `icon` may be an Icon name ('plus') or any node.
const renderIcon = (icon, size) => (typeof icon === 'string' ? <Icon name={icon} size={size} /> : icon);

const VARIANT = { primary: 'btn-primary', secondary: '', ghost: 'btn-ghost', danger: 'btn-danger', accent: 'btn-accent' };

// <Button variant="primary|secondary|ghost|danger|accent" size="sm|md" loading icon iconRight block />
// Extra props go to the <button>. `loading` disables it and swaps the icon for a spinner.
const Button = React.forwardRef(({
  variant = 'secondary', size = 'md', loading = false, icon = null, iconRight = null, block = false,
  type = 'button', disabled, className, children, ...rest
}, ref) => (
  <button ref={ref} type={type}
    className={cx('btn', VARIANT[variant], size === 'sm' && 'btn-sm', block && 'btn-block', loading && 'is-loading', className)}
    disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
    {loading ? <span className="btn-spin" aria-hidden="true" /> : icon ? <span className="btn-ic" aria-hidden="true">{renderIcon(icon, size === 'sm' ? 12 : 14)}</span> : null}
    {children}
    {iconRight && <span className="btn-ic" aria-hidden="true">{renderIcon(iconRight, size === 'sm' ? 12 : 14)}</span>}
  </button>
));
Button.displayName = 'Button';

// <IconButton icon="close" label="Close" size="sm|md" variant="default|ghost" active />
// `label` is required: it becomes aria-label and the tooltip (data-tip, shown by <TooltipHost/>).
const IconButton = React.forwardRef(({
  icon, label, size = 'md', variant = 'default', active, tip = true, kbd, type = 'button', className, children, ...rest
}, ref) => (
  <button ref={ref} type={type} aria-label={label}
    data-tip={tip ? label : undefined} data-tip-kbd={tip && kbd ? kbd : undefined}
    data-active={active === undefined ? undefined : String(!!active)}
    aria-pressed={active === undefined ? undefined : !!active}
    className={cx('icon-btn', size === 'sm' && 'icon-btn-sm', variant === 'ghost' && 'icon-btn-ghost', className)} {...rest}>
    {renderIcon(icon, size === 'sm' ? 12 : 14)}
    {children}
  </button>
));
IconButton.displayName = 'IconButton';

const writeClipboard = (text) => {
  try {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => false);
  } catch { /* fall through */ }
  // Fallback for http://127.0.0.1 in some browsers: a hidden textarea + execCommand.
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return Promise.resolve(ok);
  } catch { return Promise.resolve(false); }
};

// Lucian UX/UI Prompt #008 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#008
// <CopyButton text="VN:FPT" label="Copy ticker" size="sm|md" onCopied? />
// Press it: the stacked-squares icon is redrawn as a check on a mint fill and a "Copied" bubble pops
// up for 1.8 s. `text` may be a function returning the string at press time.
const CopyButton = ({ text, label = 'Copy', size = 'md', doneLabel = 'Copied', onCopied, className }) => {
  const rootRef = React.useRef(null);
  const timer = React.useRef(0);
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = () => {
    const value = typeof text === 'function' ? text() : String(text ?? '');
    writeClipboard(value).then(ok => { if (ok) onCopied?.(value); });
    clearTimeout(timer.current);
    // Restart the morph even when pressed again mid-animation (the element's remove + reflow + add).
    const root = rootRef.current;
    if (root && copied && !lxReducedMotion()) { root.classList.remove('is-copied'); void root.offsetWidth; root.classList.add('is-copied'); }
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };
  return (
    <span ref={rootRef} className={cx('ux u008', size === 'sm' && 'is-sm', copied && 'is-copied', className)}>
      <button className="u008-btn" type="button" aria-label={label} onClick={onClick}>
        <svg className="u008-cp" viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" /><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></svg>
        <svg className="u008-ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.5l4.2 4.2L18.5 8" /></svg>
      </button>
      <span className="u008-tip" role="status">{copied ? doneLabel : ''}</span>
    </span>
  );
};

export { Button, IconButton, CopyButton, writeClipboard };
