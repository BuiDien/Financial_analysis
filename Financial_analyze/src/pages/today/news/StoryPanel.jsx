// Story side panel (#273): headline, badges, "read full story" extraction and
// related headlines. J / K step through the current feed.

import React from 'react';
import { HelixAPI } from '../../../api-client.jsx';
import { Button, EmptyState, ErrorState, MarkdownText, SidePanel, SkeletonText } from '../../../ui';
import { safeHttpUrl } from '../../../lib/safe-url.js';
import { NewsMeta } from './NewsRow.jsx';

const StoryPanel = ({ story, list = [], allNews = [], onSelect, onClose }) => {
  const [read, setRead] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  React.useEffect(() => { setRead(''); setError(null); setLoading(false); }, [story]);

  const idx = story ? list.indexOf(story) : -1;
  const storyUrl = story ? safeHttpUrl(story.url) : null;
  const related = story ? allNews.filter(n => n !== story && (n.tags || []).some(t => (story.tags || []).includes(t))).slice(0, 3) : [];

  const expand = async () => {
    if (loading || !storyUrl) return;
    setLoading(true);
    setError(null);
    try {
      const article = await HelixAPI.newsArticle(storyUrl);
      setRead(article.text);
    } catch (e) {
      setError(String((e && e.message) || e));
    }
    setLoading(false);
  };

  return (
    <SidePanel open={!!story} onClose={onClose} title={story?.title} subtitle={story ? `${story.time} · ${story.src}` : undefined}
      contentKey={idx} indexLabel={idx >= 0 ? `${idx + 1} / ${list.length}` : ''}
      onPrev={idx > 0 ? () => onSelect(list[idx - 1]) : undefined}
      onNext={idx >= 0 && idx < list.length - 1 ? () => onSelect(list[idx + 1]) : undefined}>
      {story && (
        <div className="nw-story">
          <NewsMeta n={story} maxTags={6} />
          {!storyUrl && <EmptyState plain className="td-quiet" title="No source link available" />}
          {storyUrl && !read && !loading && !error && (
            <div className="nw-story-cta">
              <Button variant="accent" icon="sparkle" onClick={expand}>Read full story</Button>
              <a href={storyUrl} target="_blank" rel="noopener noreferrer">Open original ↗</a>
            </div>
          )}
          {loading && <SkeletonText lines={6} />}
          {error && (
            <>
              <ErrorState size="sm" title="Could not load the article" message={error} onRetry={expand} />
              <a className="nw-story-orig" href={storyUrl} target="_blank" rel="noopener noreferrer">Open original ↗</a>
            </>
          )}
          {read && <div className="nw-story-text"><MarkdownText text={read} variant="news" /></div>}
          {related.length > 0 && (
            <div className="nw-related">
              <div className="nw-related-label">Related</div>
              <ul>
                {related.map((r, i) => (
                  <li key={i}><button type="button" onClick={() => onSelect(r)}>{r.title}</button></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </SidePanel>
  );
};

export { StoryPanel };
