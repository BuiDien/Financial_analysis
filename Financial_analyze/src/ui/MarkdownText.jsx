// Light markdown renderer for AI chat and news text (moved from primitives.jsx).
// <MarkdownText text variant="news|ai" />
//   news: **bold**, *accent italics*, "- " lists, paragraphs.
//   ai:   also [text](url) and bare http(s) URLs as links; images become a link, never loaded.

import React from 'react';
import { safeHttpUrl } from '../lib/safe-url.js';
import './markdown.css';

// ── Light markdown (**bold**, *italic*, - lists, paragraphs) ─────────────
// variant 'ai':   AI chat — also [text](url) and bare http(s) URLs as links.
//                 Images (![alt](url)) are rendered as a link, never loaded.
// variant 'news': briefings / article text — emphasis only, accent italics.

const MD_PATTERNS = {
  ai: [
    { type: 'img', re: /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/ },
    { type: 'link', re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/ },
    { type: 'url', re: /(https?:\/\/[^\s)]+)/ },
    { type: 'b', re: /\*\*(.+?)\*\*/ },
    { type: 'i', re: /\*(.+?)\*/ }],
  news: [
    { type: 'b', re: /\*\*(.+?)\*\*/ },
    { type: 'i', re: /\*(.+?)\*/ }],
};

const mdInline = (str, variant) => {
  const patterns = MD_PATTERNS[variant] || MD_PATTERNS.news;
  const parts = [];
  let remaining = str;
  let key = 0;
  while (remaining.length) {
    let best = null;
    for (const p of patterns) {
      const m = remaining.match(p.re);
      if (m && (best === null || m.index < best.index)) best = { ...m, type: p.type, _len: m[0].length };
      if (best && best.index === 0) break;
    }
    if (!best) { parts.push(remaining); break; }
    if (best.index > 0) parts.push(remaining.slice(0, best.index));
    const href = (best.type === 'img' || best.type === 'link') ? safeHttpUrl(best[2]) : best.type === 'url' ? safeHttpUrl(best[1]) : null;
    if (best.type === 'img') {
      parts.push(href
        ? <a key={key++} href={href} target="_blank" rel="noopener noreferrer" className="md-link">{`Image: ${best[1] || href}`}</a>
        : best[1]);
    } else if (best.type === 'link') {
      parts.push(href ? <a key={key++} href={href} target="_blank" rel="noopener noreferrer" className="md-link">{best[1]}</a> : best[1]);
    } else if (best.type === 'url') {
      parts.push(href ? <a key={key++} href={href} target="_blank" rel="noopener noreferrer" className="md-link">{best[1]}</a> : best[1]);
    } else if (best.type === 'b') {
      parts.push(<strong key={key++}>{best[1]}</strong>);
    } else if (variant === 'ai') {
      parts.push(<em key={key++}>{best[1]}</em>);
    } else {
      parts.push(<em key={key++} className="md-hl">{best[1]}</em>);
    }
    remaining = remaining.slice(best.index + best._len);
  }
  return parts;
};

const MarkdownText = ({ text, variant = 'news' }) => {
  const ai = variant === 'ai';
  const lines = String(text ?? '').split('\n');
  const out = [];
  let list = [];
  const flush = () => {
    if (!list.length) return;
    out.push(ai
      ? <ul key={`ul-${out.length}`}>{list.map((l, i) => <li key={i}>{mdInline(l, variant)}</li>)}</ul>
      : <ul key={'u' + out.length} className="md-news-ul">{list.map((l, i) => <li key={i}>{mdInline(l, variant)}</li>)}</ul>);
    list = [];
  };
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('- ') || t.startsWith('• ')) list.push(t.slice(2));
    else {
      flush();
      if (t) out.push(<p key={'p' + i} className={ai ? 'md-ai-p' : 'md-news-p'}>{mdInline(t, variant)}</p>);
    }
  });
  flush();
  return <>{out}</>;
};

export { MarkdownText };
