// Icon for src/ui: the app's icon set (../icons.jsx) plus a few extra glyphs owned here, in the same
// 24-unit stroke style. `<Icon name="refresh" size={14} />`. Unknown names fall through to ../icons.jsx,
// so every existing name renders exactly as before. Components that take `icon="name"` (Button,
// IconButton, EmptyState actions, SearchInput suggestions) resolve names through this component.

import React from 'react';
import { Icon as BaseIcon } from '../icons.jsx';

const EXTRA = {
  // Circular arrow, clockwise, with the head at the top right (reload / refresh data).
  refresh: <><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" /></>,
};

const Icon = ({ name, size = 16, ...props }) => {
  if (!EXTRA[name]) return <BaseIcon name={name} size={size} {...props} />;
  const s = { width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };
  return <svg viewBox="0 0 24 24" {...s} {...props}>{EXTRA[name]}</svg>;
};

const RefreshIcon = (props) => <Icon name="refresh" {...props} />;
const UI_ICON_NAMES = Object.keys(EXTRA);

export { Icon, RefreshIcon, UI_ICON_NAMES };
