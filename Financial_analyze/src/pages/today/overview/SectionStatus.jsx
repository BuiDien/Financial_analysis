// Shared bits for the Today cards: the offline/loading/error/empty block every
// live section shows when it has nothing to render, and the HCM clock.

import React from 'react';
import { Badge, EmptyState, ErrorState, SkeletonText } from '../../../ui';
import '../shared.css';

const OFFLINE_TEXT = 'Backend offline — start with scripts/run.sh';

// live: backend reachable; q: a useQuery result; emptyText: copy when loaded but empty.
const SectionStatus = ({ live, q, emptyText, lines = 3 }) => {
  if (!live) return <EmptyState plain className="td-quiet" title="Waiting for the backend" />;
  if (q.isLoading) return <SkeletonText lines={lines} />;
  if (q.error && q.data === undefined) {
    return <ErrorState size="sm" title="Unavailable right now" message={q.error.message || undefined} onRetry={() => q.refetch?.()} />;
  }
  return <EmptyState plain className="td-quiet" title={emptyText} />;
};

// Ho Chi Minh clock (HOSE hours 09:00–15:00 ICT) — a UI clock, not a data poll.
// Own component so the once-a-second tick re-renders only this badge.
const HcmClock = ({ live }) => {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const vnTime = now.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
  return <Badge tone={live ? 'pos' : 'neutral'} dot className="td-clock">{live ? 'Live' : 'Offline'} · HCM {vnTime}</Badge>;
};

const todayDate = () => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

export { OFFLINE_TEXT, SectionStatus, HcmClock, todayDate };
