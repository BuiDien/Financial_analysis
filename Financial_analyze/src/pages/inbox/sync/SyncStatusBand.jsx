// Sync status band: this machine (coordinator), pairing code, connected-worker count.

import React from 'react';
import { Icon } from '../../../icons.jsx';
import { Badge, Button, Card, CopyButton } from '../../../ui';
import { SyncStore } from './sync-store.js';

const SyncStatusBand = ({ live, listening, pairCode, wsUrl, workers }) => {
  const idle = workers.filter(w => w.status === 'idle').length;
  const busy = workers.filter(w => w.status === 'busy').length;
  const coordinator = !live
    ? { tone: 'neutral', text: 'Backend offline' }
    : listening ? { tone: 'pos', text: 'Listening for workers' } : { tone: 'neutral', text: 'Not listening' };
  return (
    <Card className="syn-band" flush>
      <div className="syn-band-grid">
        <div className="syn-cell">
          <div className="syn-cell-label"><Icon name="server" size={14} className="syn-accent" /> This machine · Coordinator</div>
          <div className="syn-cell-status">
            <span className={listening ? 'syn-dot is-on' : 'syn-dot'} aria-hidden="true" />
            <span className="syn-cell-title">{coordinator.text}</span>
          </div>
          <div className="syn-url">
            <code className="syn-code">{wsUrl}</code>
            <CopyButton size="sm" text={wsUrl} label="Copy address" onCopied={() => SyncStore.addLog('sys', 'Address copied to clipboard')} />
          </div>
        </div>

        <div className="syn-cell">
          <div className="syn-cell-label">Pairing code</div>
          <div className={listening ? 'syn-big num' : 'syn-big num is-dim'} aria-live="polite">{pairCode}</div>
          <div className="row">
            <Button size="sm" variant="ghost" icon="sync" onClick={SyncStore.regenCode} disabled={!live}>Regenerate</Button>
            {listening && /\d/.test(String(pairCode)) && <CopyButton size="sm" text={pairCode} label="Copy pairing code" />}
          </div>
        </div>

        <div className="syn-cell">
          <div className="syn-cell-label">Workers</div>
          <div className="syn-big num">{workers.length}</div>
          <div className="row ibx-wrap">
            <Badge tone="pos" dot={idle > 0}>{idle} idle</Badge>
            <Badge tone="accent" dot={busy > 0}>{busy} busy</Badge>
            <Badge tone={coordinator.tone} outline>{listening ? 'Live' : live ? 'Paused' : 'Offline'}</Badge>
          </div>
        </div>
      </div>
    </Card>
  );
};

export { SyncStatusBand };
