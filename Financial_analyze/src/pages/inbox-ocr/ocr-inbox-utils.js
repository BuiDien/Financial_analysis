// OCR Inbox pure helpers (no React, no DOM): Markdown table parsing, exact decimal
// arithmetic, label-level markers, and the "Add to history" answer helpers.
// Plain JS ES module, imported by the bundle and by node (scripts/test-ocr-inbox-utils.js).
// The helpers live in focused modules (ocr-markdown-table, exact-decimal, label-levels,
// history-answers); this file keeps the one import path (and the default `api` object) for callers.

import { splitMarkdownTableRow, isMarkdownTableSeparator, markdownHasTable, serializeMarkdownTableRow, safeTableSpan, spreadsheetColumnLabel } from './ocr-markdown-table.js';
import { parseExactDecimal, exactMagnitude, compareExactMagnitudes, addExactMagnitudes, subtractExactMagnitudes, addExactUnits, scaleExactUnits, sumExactDecimals, subtractExactDecimals, formatExactDecimal } from './exact-decimal.js';
import { LABEL_LEVEL_VALUES, LABEL_LEVELS, LABEL_LEVEL_SHORT, LABEL_LEVEL_MARKER, labelLevelCode, labelLevelIndent, explicitLabelLevel, visibleCellText, withLabelLevel, levelMismatchCells, inferredLabelLevel } from './label-levels.js';
import { HISTORY_KIND_OPTIONS, HISTORY_KIND_NAMES, HISTORY_UNIT_OPTIONS, HISTORY_TABLE_CODES, HISTORY_EMPTY_DRAFT, historyTableKey, historyRowKey, historyMisreadKey, historyDmy, historyPeriodValue, historyPeriodText, historyPeriodOptions, historyMoney, historyPayload, HISTORY_SCOPE_OPTIONS, HISTORY_PERIOD_CODE_OPTIONS, LABEL_UNIT_OPTIONS, inboxLabelSummary, inboxLatestQuarter, historyFiscalYearOptions } from './history-answers.js';

const OCR_STATUS = {
  uploaded: ['Uploaded', 'var(--text-muted)'], queued: ['Queued', '#B45309'],
  held: ['Held', '#B45309'],
  processing: ['Processing', '#1D4ED8'], ready_for_review: ['Ready for review', '#7C3AED'],
  reviewing: ['Reviewing', '#7C3AED'], verified: ['Verified · needs labels', '#15803D'],
  ready_to_publish: ['Ready to publish', '#15803D'], published: ['Published', '#15803D'],
  failed: ['Failed', '#B91C1C'],
};

const fmtInboxBytes = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

const api = { OCR_STATUS, fmtInboxBytes, splitMarkdownTableRow, isMarkdownTableSeparator, markdownHasTable, serializeMarkdownTableRow, parseExactDecimal, exactMagnitude, compareExactMagnitudes, addExactMagnitudes, subtractExactMagnitudes, addExactUnits, scaleExactUnits, sumExactDecimals, subtractExactDecimals, formatExactDecimal, safeTableSpan, spreadsheetColumnLabel, LABEL_LEVEL_VALUES, LABEL_LEVELS, LABEL_LEVEL_SHORT, LABEL_LEVEL_MARKER, labelLevelCode, labelLevelIndent, explicitLabelLevel, visibleCellText, withLabelLevel, levelMismatchCells, inferredLabelLevel, HISTORY_KIND_OPTIONS, HISTORY_KIND_NAMES, HISTORY_UNIT_OPTIONS, HISTORY_TABLE_CODES, HISTORY_EMPTY_DRAFT, historyTableKey, historyRowKey, historyMisreadKey, historyDmy, historyPeriodValue, historyPeriodText, historyPeriodOptions, historyMoney, historyPayload, HISTORY_SCOPE_OPTIONS, HISTORY_PERIOD_CODE_OPTIONS, LABEL_UNIT_OPTIONS, inboxLabelSummary, inboxLatestQuarter, historyFiscalYearOptions };

export { OCR_STATUS, fmtInboxBytes, splitMarkdownTableRow, isMarkdownTableSeparator, markdownHasTable, serializeMarkdownTableRow, parseExactDecimal, exactMagnitude, compareExactMagnitudes, addExactMagnitudes, subtractExactMagnitudes, addExactUnits, scaleExactUnits, sumExactDecimals, subtractExactDecimals, formatExactDecimal, safeTableSpan, spreadsheetColumnLabel, LABEL_LEVEL_VALUES, LABEL_LEVELS, LABEL_LEVEL_SHORT, LABEL_LEVEL_MARKER, labelLevelCode, labelLevelIndent, explicitLabelLevel, visibleCellText, withLabelLevel, levelMismatchCells, inferredLabelLevel, HISTORY_KIND_OPTIONS, HISTORY_KIND_NAMES, HISTORY_UNIT_OPTIONS, HISTORY_TABLE_CODES, HISTORY_EMPTY_DRAFT, historyTableKey, historyRowKey, historyMisreadKey, historyDmy, historyPeriodValue, historyPeriodText, historyPeriodOptions, historyMoney, historyPayload, HISTORY_SCOPE_OPTIONS, HISTORY_PERIOD_CODE_OPTIONS, LABEL_UNIT_OPTIONS, inboxLabelSummary, inboxLatestQuarter, historyFiscalYearOptions };
export default api;
