// Screener — rule-based Vietnam stock screener: a rules-funnel panel on the left (strategy,
// how picky, every check), debounced server-side evaluation, results on the right.
// Broad-scan data is third-party (vnstock) and stays UNVERIFIED.

import React from 'react';
import { Button, Card, EmptyState, ErrorState, Skeleton, SkeletonText } from '../../ui/index.js';
import { useScreener } from './useScreener.js';
import { ScreenerFilters } from './ScreenerFilters.jsx';
import { ScreenerResults } from './ScreenerResults.jsx';
import './scan.css';

const LoadingLayout = () => (
  <div className="scan-layout" aria-busy="true">
    <div className="card scan-filters"><div className="scan-filters-body"><SkeletonText lines={8} /></div></div>
    <Card flush><div className="scan-skel"><Skeleton height={14} width="40%" /><SkeletonText lines={6} /></div></Card>
  </div>
);

const PageScreener = ({ setActiveAsset, setPage }) => {
  const s = useScreener();
  const offline = !!s.loadErr;
  const open = (symbol) => {
    if (offline) return;
    setActiveAsset && setActiveAsset('VN:' + symbol);
    setPage && setPage('detail');
  };

  return (
    <div className="page scan-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Stock screener.</h1>
          <p className="page-sub">Pick a strategy, tweak the rules, see who passes</p>
        </div>
        <div className="scan-head-actions">
          <Button disabled={offline || s.busy || !s.catalog} onClick={() => s.requestRefresh('financials')}>Refresh financials</Button>
          <Button variant="primary" icon="sync" disabled={offline || s.busy || !s.catalog} onClick={() => s.requestRefresh('prices')}>Refresh prices</Button>
        </div>
      </header>

      {offline && (
        <Card>
          <EmptyState title="Backend offline"
            description="The screener runs on the backend's market data. Start it with scripts/run.sh, then retry."
            action={{ label: 'Retry', icon: null, onClick: () => s.load() }} />
          <p className="scan-hint scan-center" title={s.loadErr}>{s.loadErr}</p>
        </Card>
      )}

      {!offline && s.loading && !s.catalog && <LoadingLayout />}

      {s.catalog && (
        <div className="scan-layout">
          <ScreenerFilters s={s} />
          <div className="scan-main">
            {s.result ? <ScreenerResults s={s} onOpen={open} /> : s.evaluating ? (
              <Card flush><div className="scan-skel"><SkeletonText lines={6} /></div></Card>
            ) : (
              <ErrorState card title="Could not evaluate the rules" message="The last request failed. Check the numbers or try again."
                onRetry={async () => s.reevaluate()} />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export { PageScreener };
