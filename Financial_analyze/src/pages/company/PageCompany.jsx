// Company — one ticker, tabbed: Overview (header, chart, stats, technicals, news),
// Statements (verified history from OCR), Notes. Route: #/company/:ticker/:tab.

import React from 'react';
import { RouteTabs } from '../../route-tabs.jsx';
import { buildHash } from '../../lib/router.js';
import { PageDetail } from './OverviewTab.jsx';
import { PageStatements } from './StatementsTab.jsx';
import { NotesCard } from './NotesCard.jsx';
import './company.css';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'statements', label: 'Statements' },
  { id: 'notes', label: 'Notes' },
];

const NotesTab = ({ bare }) => (
  <div className="page co-page">
    <div className="page-header">
      <div>
        <h1 className="page-title">Notes · {bare}.</h1>
        <p className="page-sub">Dated research notes for this company, stored on the backend</p>
      </div>
    </div>
    <div className="co-notes-tab"><NotesCard key={`notes-${bare}`} symbol={bare} /></div>
  </div>
);

const PageCompany = ({ route, data, setPage, setActiveAsset }) => {
  const ticker = route.ticker;
  const bare = String(ticker).replace(/^VN:/, '');
  const tabs = TABS.map(t => ({ ...t, href: buildHash({ section: 'company', ticker, tab: t.id }) }));
  return (
    <>
      <RouteTabs tabs={tabs} current={route.tab} label={`${bare} sections`}>
        <span className="route-tabs-title">{bare}</span>
      </RouteTabs>
      {route.tab === 'statements' ? (
        <PageStatements key={`st-${bare}`} ticker={bare} setPage={setPage} />
      ) : route.tab === 'notes' ? (
        <NotesTab bare={bare} />
      ) : (
        <PageDetail activeAsset={ticker} data={data} setPage={setPage} setActiveAsset={setActiveAsset} />
      )}
    </>
  );
};

export { PageCompany };
