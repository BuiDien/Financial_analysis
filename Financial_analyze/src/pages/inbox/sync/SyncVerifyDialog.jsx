// Two-step verify for legacy (non-inbox) sync jobs: review OCR'd rows, then confirm
// (applies them to the filing tracker and registers the company for Statements).

import React from 'react';
import { Button, Dialog } from '../../../ui';

const VERIFY_SECTIONS = { income: 'Income Statement', balance: 'Balance Sheet', cashflow: 'Cash Flow' };

const SyncVerifyDialog = ({ job, onClose, onConfirm, goStatements }) => {
  const [confirmed, setConfirmed] = React.useState(false);
  React.useEffect(() => { setConfirmed(false); }, [job?.id]);
  const rows = job?.rows || [];
  const bySection = {};
  rows.forEach(r => { (bySection[r.section] = bySection[r.section] || []).push(r); });

  const actions = !confirmed ? (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={() => setConfirmed(true)}>Looks right → Confirm</Button>
    </>
  ) : (
    <>
      <Button onClick={() => setConfirmed(false)}>← Back</Button>
      <Button onClick={onConfirm}>Confirm</Button>
      <Button variant="primary" onClick={() => { onConfirm(); goStatements(); }}>Confirm &amp; open statements →</Button>
    </>
  );

  return (
    <Dialog open={!!job} onClose={onClose} size="lg" icon="none" actions={actions}
      title={confirmed ? 'Step 2 · Confirm' : 'Step 1 · Verify data'}
      description={job ? `${job.ticker} · ${rows.length} metrics parsed by ${job.worker} from ${job.filename}` : ''}>
      <div className="syn-steps" aria-hidden="true"><span className="is-on" /><span className={confirmed ? 'is-on' : ''} /></div>
      {!confirmed ? (
        <div className="syn-verify">
          {Object.keys(bySection).map(sec => (
            <section key={sec}>
              <h4 className="syn-verify-sec">{VERIFY_SECTIONS[sec] || sec}</h4>
              {bySection[sec].map(r => (
                <div key={r.id} className="syn-verify-row">
                  <span>{r.metric} <small className="ibx-subtle">p.{r.page}</small></span>
                  <span className="num ibx-muted">{r.prev}</span>
                  <span className="num syn-strong">{r.curr}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="syn-confirm">
          <div className="syn-confirm-title">Add {job?.ticker} to your companies?</div>
          <p className="ibx-muted">
            Confirming applies these {rows.length} metrics to the filing's tracker and adds <strong>{job?.ticker}</strong> to
            the Financial Statements company list, so you can review it there.
          </p>
        </div>
      )}
    </Dialog>
  );
};

export { SyncVerifyDialog };
