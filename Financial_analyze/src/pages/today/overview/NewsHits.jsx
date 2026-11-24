// Today card: the six latest headlines.

import React from 'react';
import { useApiLive } from '../../../api-client.jsx';
import { Button, Card } from '../../../ui';
import { useNews } from '../../../lib/data.js';
import { NewsRow } from '../news/NewsRow.jsx';
import { SectionStatus } from './SectionStatus.jsx';
import '../news/news.css';

const NewsHits = ({ setPage }) => {
  const { live } = useApiLive();
  const q = useNews(30);
  const items = q.data || [];
  return (
    <Card title="Latest news" className="td-card td-news"
      actions={<Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => setPage('#/today/news')}>All news</Button>}>
      {items.length === 0 ? <SectionStatus live={live} q={q} emptyText="No stories yet." lines={4} /> : (
        <ul className="nw-list">
          {items.slice(0, 6).map((n, i) => <NewsRow key={n.url || i} n={n} compact />)}
        </ul>
      )}
    </Card>
  );
};

export { NewsHits };
