// #/today, #/today/news, #/today/alerts — overview plus the full News and Alerts views.

import React from 'react';
import { RouteTabs } from '../../route-tabs.jsx';
import { useAlerts } from '../../lib/data.js';
import { PageToday } from './overview/PageToday.jsx';
import { PageNews } from './news/PageNews.jsx';
import { PageAlerts } from './alerts/PageAlerts.jsx';

const PageTodaySection = ({ route, setPage, setActiveAsset }) => {
  const alertsQ = useAlerts();
  const triggered = (alertsQ.data || []).filter(a => a.triggered).length;
  const tab = route.tab || 'overview';
  const tabs = [
    { id: 'overview', label: 'Overview', href: '#/today' },
    { id: 'news', label: 'News', href: '#/today/news' },
    { id: 'alerts', label: 'Alerts', href: '#/today/alerts', badge: triggered || null },
  ];
  return (
    <>
      <RouteTabs tabs={tabs} current={tab} label="Today sections" />
      {tab === 'news' ? <PageNews />
        : tab === 'alerts' ? <PageAlerts setPage={setPage} setActiveAsset={setActiveAsset} />
          : <PageToday setPage={setPage} setActiveAsset={setActiveAsset} />}
    </>
  );
};

export { PageTodaySection, PageToday };
