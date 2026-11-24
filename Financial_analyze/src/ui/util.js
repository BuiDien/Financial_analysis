// Shared helpers for src/ui components.
import React from 'react';

const lxUid = prefix => prefix + '-' + Math.random().toString(36).slice(2, 7);
const lxReducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
// Text width in px for SVG labels (SVG text cannot ellipsize): canvas measure, rough fallback.
const LX_FONT = "Inter, system-ui, sans-serif";
let lxCanvas = null;
const lxMeasure = (text, font) => {
  try {
    if (!lxCanvas) lxCanvas = document.createElement('canvas').getContext('2d');
    lxCanvas.font = font;
    return lxCanvas.measureText(String(text)).width;
  } catch { return String(text).length * 6.5; }
};
const lxFit = (text, max, font) => {
  const t = String(text || '');
  if (max <= 0) return '';
  if (lxMeasure(t, font) <= max) return t;
  let lo = 0, hi = t.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lxMeasure(t.slice(0, mid) + '…', font) <= max) lo = mid; else hi = mid - 1; }
  return lo > 0 ? t.slice(0, lo).trimEnd() + '…' : '';
};

// Join class names, skipping falsy parts: cx('a', on && 'b') → 'a b'.
const cx = (...parts) => parts.filter(Boolean).join(' ');
const isMac = () => /Mac|iPhone|iPad/.test((typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '');
// Stable id for aria wiring (useId is React 18+, prefix keeps ids valid CSS selectors).
const useUid = (prefix) => {
  const id = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return `${prefix}-${id}`;
};
// Live prefers-reduced-motion flag (the matchMedia listener is removed on unmount).
const useReducedMotion = () => {
  const [rm, setRm] = React.useState(lxReducedMotion);
  React.useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setRm(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return rm;
};
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export { lxUid, lxReducedMotion, lxMeasure, lxFit, LX_FONT, cx, isMac, useUid, useReducedMotion, FOCUSABLE };
