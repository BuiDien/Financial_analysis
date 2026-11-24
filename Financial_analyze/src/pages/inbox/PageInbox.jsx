// Inbox — everything that arrives or runs in the background: OCR Inbox,
// Sync (worker laptops), Gmail import, and Activity (GET /api/jobs).
// Route: #/inbox/:tab.

import React from 'react';
import { RouteTabs } from '../../route-tabs.jsx';
import { PageOCRInbox } from '../inbox-ocr/inbox-page.jsx';
import { PageSync } from './sync/PageSync.jsx';
import { GmailTab } from './GmailImport.jsx';
import { ActivityTab } from './ActivityTab.jsx';

const TABS = [
  { id: 'ocr', label: 'OCR Inbox', href: '#/inbox/ocr' },
  { id: 'sync', label: 'Sync', href: '#/inbox/sync' },
  { id: 'gmail', label: 'Gmail import', href: '#/inbox/gmail' },
  { id: 'activity', label: 'Activity', href: '#/inbox/activity' },
];

const PageInbox = ({ route, setPage }) => {
  const tab = route.tab || 'ocr';
  return (
    <>
      <RouteTabs tabs={TABS} current={tab} label="Inbox sections" />
      {tab === 'sync' ? <PageSync setPage={setPage} />
        : tab === 'gmail' ? <GmailTab />
          : tab === 'activity' ? <ActivityTab />
            : <PageOCRInbox setPage={setPage} />}
    </>
  );
};

export { PageInbox };
