// News & insights: subject research, the daily digest and the filterable feed.

import React from 'react';
import { useApiLive } from '../../../api-client.jsx';
import { Badge, Card, EmptyState, ErrorState, SearchInput, SkeletonText, Tabs } from '../../../ui';
import { useNews } from '../../../lib/data.js';
import { ResearchCard } from './ResearchCard.jsx';
import { DailyDigest } from './DailyDigest.jsx';
import { NewsRow, NewsMeta } from './NewsRow.jsx';
import { StoryPanel } from './StoryPanel.jsx';
import '../shared.css';
import './news.css';

const SECTIONS = [
  { value: 'all', label: 'Top stories', test: () => true },
  { value: 'vn_market', label: 'VN market', test: n => n.category === 'market' },
  { value: 'vn_companies', label: 'VN companies', test: n => n.category === 'companies' },
  { value: 'us', label: 'US', test: n => n.category === 'us' },
];

const matches = (n, term) => {
  if (!term) return true;
  const t = term.toLowerCase();
  return String(n.title || '').toLowerCase().includes(t) || String(n.src || '').toLowerCase().includes(t)
    || (n.tickers || n.tags || []).some(x => String(x).toLowerCase() === t || String(x).toLowerCase().startsWith(t));
};

const TopStory = ({ n, onOpen }) => (
  <div className="nw-top">
    <div className="nw-top-tag"><Badge tone="accent" sans>Top story</Badge><span className="num">{n.time}</span></div>
    <button type="button" className="nw-top-title" onClick={() => onOpen(n)}>{n.title}</button>
    <NewsMeta n={n} maxTags={6} />
  </div>
);

const PageNews = () => {
  const [tab, setTab] = React.useState('all');
  const [term, setTerm] = React.useState('');
  const [story, setStory] = React.useState(null);
  const { live } = useApiLive();
  const q = useNews(30);
  const allNews = live ? (q.data || []) : [];
  const section = SECTIONS.find(s => s.value === tab) || SECTIONS[0];
  const filtered = allNews.filter(section.test).filter(n => matches(n, term.trim()));
  const counts = Object.fromEntries(SECTIONS.map(s => [s.value, allNews.filter(s.test).length]));

  let empty = null;
  if (filtered.length === 0) {
    if (!live) empty = <EmptyState plain title="Backend offline" description="Start it with scripts/run.sh to load headlines." />;
    else if (q.isLoading) empty = <SkeletonText lines={6} />;
    else if (q.error && !allNews.length) empty = <ErrorState size="sm" title="News feed unavailable" message={q.error.message} onRetry={() => q.refetch?.()} />;
    else empty = <EmptyState plain title={term ? `No stories match “${term}”` : tab === 'all' ? 'No stories yet' : 'No stories in this section right now'} />;
  }

  return (
    <div className="page nw-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">News & insights.</h1>
          <p className="page-sub">{live ? 'Vietnam market, Vietnam companies, and US headlines.' : 'Backend offline — no headlines.'}</p>
        </div>
      </header>

      <ResearchCard />
      <DailyDigest />

      <Card className="nw-feed" flush overflow>
        <div className="nw-toolbar">
          <Tabs size="sm" ariaLabel="News sections" value={tab} onChange={setTab}
            tabs={SECTIONS.map(s => ({ value: s.value, label: s.label, badge: live && counts[s.value] ? counts[s.value] : null }))} />
          <SearchInput size="sm" value={term} onChange={setTerm} placeholder="Filter by ticker, source, word" ariaLabel="Filter headlines" className="nw-filter" />
        </div>
        <div className="nw-feed-body">
          {empty || (
            <>
              <TopStory n={filtered[0]} onOpen={setStory} />
              <ul className="nw-list">
                {filtered.slice(1).map((n, i) => <NewsRow key={n.url || i} n={n} onOpen={setStory} />)}
              </ul>
            </>
          )}
        </div>
      </Card>

      <StoryPanel story={story} list={filtered} allNews={allNews} onSelect={setStory} onClose={() => setStory(null)} />
    </div>
  );
};

export { PageNews };
