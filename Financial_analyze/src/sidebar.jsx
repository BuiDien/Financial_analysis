// Sidebar: the six route sections (SideNav, Lucian #417) plus the user's watchlists.

import React from 'react';
import { SideNav, askPrompt, toast } from './ui/index.js';
import { useWatchlists } from './watchlist-store.jsx';
import { useAlerts } from './lib/data.js';

// Six sections; each maps to a route (lib/router.js).
const NAV = [
  { id: 'today', label: 'Today', icon: 'home', href: '#/today' },
  { id: 'scan', label: 'Scan', icon: 'screener', href: '#/scan' },
  { id: 'company', label: 'Company', icon: 'chart', href: null },   // last ticker
  { id: 'portfolio', label: 'Portfolio', icon: 'portfolio', href: '#/portfolio' },
  { id: 'inbox', label: 'Inbox', icon: 'search', href: '#/inbox/ocr' },
  { id: 'settings', label: 'Settings', icon: 'settings', href: '#/settings' },
];

const Sidebar = ({ route, setPage, rail, forced, onToggleRail }) => {
  const store = useWatchlists();
  const lists = store.getLists();
  const activeId = store.getState().activeId;
  const alertsQ = useAlerts();
  const triggered = (alertsQ.data || []).filter(a => a.triggered).length;
  const section = route?.section;

  const newList = async () => {
    const name = await askPrompt({ title: 'New watchlist', label: 'Name', placeholder: 'e.g. Banks', confirmText: 'Create' });
    if (name) { store.create(name); setPage('#/today'); toast(`Created "${name}"`, { type: 'success' }); }
  };

  const items = NAV.map(n => (n.id === 'today' && triggered > 0
    ? { ...n, badge: triggered, badgeTitle: `${triggered} triggered alert${triggered === 1 ? '' : 's'}` }
    : n));
  const watchlists = {
    id: 'watchlists',
    label: 'Watchlists',
    items: [
      ...lists.map(wl => ({
        id: wl.id, label: wl.name, icon: wl.id === activeId ? 'starFill' : 'star', mark: wl.id === activeId,
        meta: wl.symbols.length, current: section === 'today' && wl.id === activeId,
        onSelect: () => { store.setActive(wl.id); setPage('#/today'); },
      })),
      { id: '__new', label: 'New watchlist', icon: 'plus', muted: true, onSelect: newList },
    ],
  };

  return (
    <SideNav items={items} activeId={section} onSelect={it => setPage(it.href || it.id)}
      sections={[watchlists]} rail={rail} forced={forced} onToggleRail={onToggleRail} />
  );
};

export { Sidebar };
