// "Focus the analyst on a subject": web search, then an AI briefing from the hits.

import React from 'react';
import { HelixAPI } from '../../../api-client.jsx';
import { Icon } from '../../../icons.jsx';
import { Button, Card, ErrorState, IconButton, MarkdownText, Panel, Select, SkeletonText, TextInput } from '../../../ui';
import { safeHttpUrl } from '../../../lib/safe-url.js';

const SUGGESTED = ['VN-Index outlook', 'Vietnam banks', 'FPT earnings', 'SBV interest rates', 'Fed rate path'];
const RANGES = [{ value: 'day', label: '24 hours' }, { value: 'week', label: '7 days' }, { value: 'month', label: '30 days' }];

const briefingPrompt = (topic, hits) => {
  const context = hits.map(h => `- ${h.title}${h.published ? ` (${h.published})` : ''}${h.source ? ` [${h.source}]` : ''}: ${h.content}`).join('\n');
  return `You are a financial news analyst agent. Focus ONLY on this subject: "${topic}".\n\nFrom the search results below, synthesize a focused briefing on "${topic}". Use this exact format:\n\n**Why it matters:** [one sharp sentence]\n\n**Key developments:**\n- [point with specifics]\n- [point]\n- [point]\n\n**What to watch:** [1-2 forward-looking items]\n\n**Affected tickers:** [comma-separated symbols]\n\nBe concise and numerical. Use **bold** for figures, *italic* for tickers. No disclaimers, no emoji.\n\nSEARCH RESULTS:\n${context}`;
};

const ResearchCard = () => {
  const [subject, setSubject] = React.useState('');
  const [timeRange, setTimeRange] = React.useState('week');
  const [briefing, setBriefing] = React.useState(null);
  const [results, setResults] = React.useState([]);
  const [searchError, setSearchError] = React.useState(null);
  const [researching, setResearching] = React.useState(false);

  const research = async (subj) => {
    const topic = (subj || subject).trim();
    if (!topic || researching) return;
    setSubject(topic);
    setResearching(true);
    setBriefing(null);
    setResults([]);
    setSearchError(null);
    let hits;
    try {
      hits = await HelixAPI.newsSearch(topic, 8, timeRange);
      setResults(hits);
    } catch {
      setSearchError('Search unavailable — start ./scripts/run_searxng.sh');
      setResearching(false);
      return;
    }
    try {
      setBriefing(await HelixAPI.complete(briefingPrompt(topic, hits), { page: 'news', context: { subject: topic } }));
    } catch {
      setBriefing('Could not generate a briefing right now. Try again.');
    }
    setResearching(false);
  };
  const reset = () => { setBriefing(null); setSubject(''); setResults([]); };

  return (
    <Card title="Research a subject" subtitle="Web search, then an analyst briefing on what it means." className="nw-research" overflow>
      <form className="nw-research-bar" onSubmit={(e) => { e.preventDefault(); research(); }}>
        <TextInput className="nw-research-input" value={subject} onChange={setSubject} aria-label="Research subject"
          prefix={<Icon name="sparkle" size={14} />} placeholder="AI chips, Fed policy, a ticker…" />
        <Select size="sm" ariaLabel="News freshness" value={timeRange} onChange={setTimeRange} options={RANGES} disabled={researching} />
        <Button type="submit" variant="primary" icon="search" loading={researching} disabled={!subject.trim()}>
          {researching ? 'Researching…' : 'Research'}
        </Button>
      </form>
      <div className="nw-chips" aria-label="Suggested subjects">
        <span className="nw-chips-label">Try</span>
        {SUGGESTED.map(s => <Button key={s} size="sm" variant="ghost" className="nw-chip" onClick={() => research(s)}>{s}</Button>)}
      </div>

      {searchError && <ErrorState size="sm" title="Search unavailable" message={searchError} />}

      {!searchError && results.length > 0 && (
        <Panel title="Sources" className="nw-sources">
          <ul>
            {results.map((r, i) => (
              <li key={i}>
                {safeHttpUrl(r.url)
                  ? <a href={safeHttpUrl(r.url)} target="_blank" rel="noopener noreferrer">{r.title}</a>
                  : <span>{r.title}</span>}
                {(r.source || r.published) && <small className="num">{[r.source, r.published].filter(Boolean).join(' · ')}</small>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {!searchError && (researching || briefing) && (
        <div className="nw-briefing">
          <div className="nw-briefing-head">
            <span><Icon name="sparkle" size={11} /> Analyst briefing · {subject}</span>
            {briefing && <IconButton icon="close" size="sm" variant="ghost" label="Clear briefing" onClick={reset} />}
          </div>
          {researching ? <SkeletonText lines={4} /> : <MarkdownText text={briefing} variant="news" />}
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {researching ? `Researching ${subject}…` : searchError || (briefing ? `Briefing on ${subject} ready` : '')}
      </div>
    </Card>
  );
};

export { ResearchCard };
