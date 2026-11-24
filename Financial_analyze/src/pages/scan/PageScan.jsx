// Scan — Screener (rules funnel) + Backtest. Routes: #/scan, #/scan/backtest.

import React from 'react';
import { RouteTabs } from '../../route-tabs.jsx';
import { PageScreener } from './ScreenerPage.jsx';
import { PageBacktest } from './BacktestPage.jsx';

const TABS = [
  { id: 'screener', label: 'Screener', href: '#/scan' },
  { id: 'backtest', label: 'Backtest', href: '#/scan/backtest' },
];

const PageScan = ({ route, setPage, setActiveAsset }) => {
  const tab = route.tab === 'backtest' ? 'backtest' : 'screener';
  return (
    <>
      <RouteTabs tabs={TABS} current={tab} label="Scan sections" />
      {tab === 'backtest' ? <PageBacktest /> : <PageScreener setPage={setPage} setActiveAsset={setActiveAsset} />}
    </>
  );
};

export { PageScan };
