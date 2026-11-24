// Section tab strip for routed sub-pages (Company, Scan, Inbox, Today).
// Plain links: each tab is a real #/ URL, so middle-click, back/forward and
// deep links all work.

import React from 'react';

const RouteTabs = ({ tabs, current, label, children }) => (
  <nav className="route-tabs" aria-label={label}>
    {children}
    <div className="route-tabs-list" role="tablist">
      {tabs.map(t => (
        <a key={t.id} href={t.href} role="tab" className="route-tab"
          aria-selected={t.id === current ? 'true' : 'false'}
          aria-current={t.id === current ? 'page' : undefined}>
          {t.label}
          {t.badge ? <span className="route-tab-badge">{t.badge}</span> : null}
        </a>
      ))}
    </div>
  </nav>
);

export { RouteTabs };
