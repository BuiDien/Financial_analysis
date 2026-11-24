// Sync — distributed OCR coordinator control panel (Inbox → Sync, #/inbox/sync).
// State lives in the module-level SyncStore (sync-store.js) so "listening" survives
// tab switches; this component subscribes via useSyncExternalStore.

import React from 'react';
import * as SyncPoller from '../../../lib/sync-poller.js';
import { handoff } from '../../../handoff.js';
import { HelixAPI } from '../../../api-client.jsx';
import { Button, toast } from '../../../ui';
import { SyncStore } from './sync-store.js';
import { SyncStatusBand } from './SyncStatusBand.jsx';
import { DispatchCard, WorkersCard } from './SyncLists.jsx';
import { SyncJobsCard } from './SyncJobsCard.jsx';
import { PairingSteps, SyncLogCard } from './SyncGuide.jsx';
import { SyncVerifyDialog } from './SyncVerifyDialog.jsx';
import '../inbox.css';
import './sync.css';

// OCR Inbox list for the dispatch card: no overlapping requests, back-off while the
// backend is down, paused in a hidden tab, one log line per outage (plus one on recovery).
const useInboxItems = () => {
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const pollerRef = React.useRef(null);
  React.useEffect(() => {
    let alive = true;
    const poller = SyncPoller.create({
      intervalMs: 1800,
      maxIntervalMs: 30000,
      run: async () => {
        if (!HelixAPI?.live) { if (alive) setLoading(false); return; }
        try {
          const next = await HelixAPI.ocrInbox();
          if (alive) setItems(next);
        } finally { if (alive) setLoading(false); }
      },
      onError: e => SyncStore.addLog('error', `Could not load OCR Inbox: ${e.message || e} — retrying with back-off`),
      onRecover: () => SyncStore.addLog('sys', 'OCR Inbox reachable again.'),
    });
    pollerRef.current = poller;
    poller.start();
    return () => { alive = false; poller.stop(); if (pollerRef.current === poller) pollerRef.current = null; };
  }, []);
  const refresh = React.useCallback(() => (pollerRef.current ? pollerRef.current.poke() : Promise.resolve()), []);
  return { items, loading, refresh };
};

const PageSync = ({ setPage }) => {
  const { listening, pairCode, workers, jobs, log } = React.useSyncExternalStore(SyncStore.subscribe, SyncStore.getSnapshot);
  const inbox = useInboxItems();
  const [verifyJob, setVerifyJob] = React.useState(null);
  const live = SyncStore.isLive();
  const wsUrl = SyncStore.getWsUrl();

  const dispatch = async (item) => { await SyncStore.dispatch(item); await inbox.refresh(); };
  const resume = async (job) => {
    const item = inbox.items.find(x => x.id === job.inboxItemId);
    if (item) await dispatch(item);
  };
  const confirmResult = (job) => {
    SyncStore.confirmResult(job);
    toast(`${job.ticker} verified & added to companies`, { type: 'success' });
    setVerifyJob(null);
  };
  const goStatements = () => {
    handoff.statementsTicker = verifyJob?.ticker ? `VN:${String(verifyJob.ticker).toUpperCase().replace(/^VN:/, '')}` : null;
    setVerifyJob(null);
    if (setPage) setPage('statements');
  };

  return (
    <div className="page ibx-page syn-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Sync.</h1>
          <p className="page-sub">Hand off OCR Inbox PDFs to a worker laptop — parsed statement data comes back for review automatically</p>
        </div>
        <div className="row">
          <Button variant={listening ? 'secondary' : 'primary'} icon={listening ? 'close' : 'wifi'} onClick={SyncStore.toggleListen}>
            {listening ? 'Stop listening' : 'Start listening'}
          </Button>
        </div>
      </div>

      <div className="stack">
        <SyncStatusBand live={live} listening={listening} pairCode={pairCode} wsUrl={wsUrl} workers={workers} />

        <SyncJobsCard jobs={jobs} onClearDone={SyncStore.clearDone} onControl={SyncStore.controlJob} onResume={resume}
          onReview={() => setPage('ocr-inbox')} onVerify={setVerifyJob} />

        <div className="syn-grid">
          <DispatchCard inboxItems={inbox.items} inboxLoading={inbox.loading} jobs={jobs} listening={listening}
            workers={workers} onDispatch={dispatch} setPage={setPage} />
          <WorkersCard workers={workers} listening={listening} />
        </div>

        <div className="syn-grid">
          <PairingSteps live={live} listening={listening} workers={workers} jobs={jobs} wsUrl={wsUrl} pairCode={pairCode} />
          <SyncLogCard log={log} />
        </div>
      </div>

      <SyncVerifyDialog job={verifyJob} onClose={() => setVerifyJob(null)}
        onConfirm={() => verifyJob && confirmResult(verifyJob)} goStatements={goStatements} />
    </div>
  );
};

export { PageSync };
