// OCR Inbox — small shared pieces: status badges, label-level chip, inline Markdown, and the
// reopen / open-statements helpers used by the list and both review workspaces.

import React from 'react';
import { handoff } from '../../handoff.js';
import { HelixAPI } from '../../api-client.jsx';
import { askConfirm, Badge } from '../../ui';
import { OCR_STATUS, LABEL_LEVELS, labelLevelCode } from './ocr-inbox-utils.js';

// Verified reviews are read-only; POST /api/ocr-inbox/{item_id}/review/reopen makes one
// editable again. Resolves null when the owner cancels.
const reopenVerifiedOcrReview = async (item, review) => {
  const confirmed = await askConfirm({
    title: 'Reopen verified review?',
    message: 'The review becomes editable again. Verify it again before adding it to history or publishing.',
    confirmText: 'Reopen',
  });
  if (!confirmed) return null;
  return HelixAPI.ocrReviewReopen(item.id, review.revision);
};
const ocrNeedsReopen = message => /must be reopened/i.test(String(message || ''));

// Company → Statements for the filing's own ticker (#/company/<ticker>/statements).
const openStatementsFor = (item, setPage) => {
  const ticker = String(item?.labels?.ticker || item?.ticker || '').trim().toUpperCase();
  // OCR filings are Vietnamese statements: "VN:" keeps the Overview tab on VCI.
  handoff.statementsTicker = ticker ? (ticker.includes(':') ? ticker : `VN:${ticker}`) : null;
  setPage && setPage('statements');
};

// Item, review, page and row statuses share one badge. Labels come from OCR_STATUS when known.
const STATUS_TONE = {
  uploaded: 'neutral', queued: 'warn', held: 'warn', processing: 'info',
  ready_for_review: 'accent', reviewing: 'accent',
  verified: 'pos', ready_to_publish: 'pos', published: 'pos', failed: 'neg',
  pending: 'warn', approved: 'pos', corrected: 'info', rejected: 'neg', manually_added: 'info',
};
const statusText = status => OCR_STATUS[status]?.[0]
  || String(status || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

const InboxStatus = ({ status }) => (
  <Badge tone={STATUS_TONE[status] || 'neutral'} dot sans className="ocr-status">{statusText(status)}</Badge>
);

const LabelLevelBadge = ({ level }) => (
  <span aria-hidden="true" title={`${labelLevelCode(level)} · ${LABEL_LEVELS[level]}`}
    className={`ocr-lvl${level <= 0 ? ' is-total' : ''}`}>{labelLevelCode(level)}</span>
);

const safeMarkdownHref = href => {
  try {
    const url = new URL(href, window.location.href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
};

const MarkdownInline = ({ text, prefix }) => {
  const tokens = String(text || '').split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return <>{tokens.map((token, index) => {
    const key = `${prefix}-${index}`;
    if (token.startsWith('`') && token.endsWith('`')) return <code key={key} className="ocr-code">{token.slice(1, -1)}</code>;
    if (token.startsWith('**') && token.endsWith('**')) return <strong key={key}>{token.slice(2, -2)}</strong>;
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = safeMarkdownHref(link[2]);
      return href ? <a key={key} href={href} target="_blank" rel="noreferrer">{link[1]}</a> : <span key={key}>{link[1]}</span>;
    }
    return <React.Fragment key={key}>{token}</React.Fragment>;
  })}</>;
};

const BackLink = ({ onBack }) => <button type="button" className="card-action ocr-back" onClick={onBack}>← OCR Inbox</button>;

// Indent classes for label levels (L → 0 … L3 → 4); CSS turns them into padding / margins.
const indentClass = indent => `ocr-ind-${Math.max(0, Math.min(4, indent))}`;

export { BackLink, reopenVerifiedOcrReview, ocrNeedsReopen, openStatementsFor, InboxStatus, LabelLevelBadge, MarkdownInline, indentClass, statusText };
