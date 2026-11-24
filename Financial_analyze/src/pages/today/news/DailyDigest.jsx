// Daily digest card (GET /api/news/summary — the vault note written by the collector).

import React from 'react';
import { HelixAPI } from '../../../api-client.jsx';
import { Button, Card, EmptyState, MarkdownText } from '../../../ui';
import { safeHttpUrl } from '../../../lib/safe-url.js';

const DailyDigest = () => {
  const [digest, setDigest] = React.useState(null);
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    HelixAPI.newsDailySummary()
      .then(d => { if (!cancelled) setDigest(d); })
      .catch(() => { if (!cancelled) setDigest({ stale: true, day_summary: null, articles: [] }); });
    return () => { cancelled = true; };
  }, []);

  if (!digest) return null;
  if (digest.stale || !digest.day_summary) {
    return <Card><EmptyState plain className="td-quiet" title="No digest yet" description="Check back after today's run." /></Card>;
  }
  const articles = digest.articles || [];
  return (
    <Card title="Daily digest" subtitle={`${digest.date} · ${articles.length} articles`} className="nw-digest">
      <div className="nw-digest-text"><MarkdownText text={digest.day_summary} variant="news" /></div>
      {articles.length > 0 && (
        <>
          <Button size="sm" variant="ghost" className="nw-digest-toggle" aria-expanded={expanded}
            iconRight={expanded ? 'arrowUp' : 'arrowDown'} onClick={() => setExpanded(v => !v)}>
            {expanded ? 'Hide' : 'Show'} all {articles.length} articles
          </Button>
          {expanded && (
            <ul className="nw-digest-list">
              {articles.map((a, i) => (
                <li key={i}>
                  {safeHttpUrl(a.url)
                    ? <a href={safeHttpUrl(a.url)} target="_blank" rel="noopener noreferrer">{a.title}</a>
                    : <span className="nw-digest-title">{a.title}</span>}
                  {a.summary && <p>{a.summary}</p>}
                  <small className="num">{a.source}</small>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
};

export { DailyDigest };
