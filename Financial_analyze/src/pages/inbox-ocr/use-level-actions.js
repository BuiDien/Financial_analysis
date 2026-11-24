// Page-Markdown OCR review: the label-level tools — auto-detect levels and verify level totals for the
// loaded page (state lives in use-markdown-review.js; this owns the requests), plus the pure list of
// verification issues the review navigates between.

import { HelixAPI } from '../../api-client.jsx';
import { toast } from '../../ui';

// Notice shown when level detection returns after the owner edited the text (the edits are kept).
const LEVELS_NOTICE = 'Level detection finished after you edited — your edits were kept; run it again to apply.';

const useLevelActions = ({
  review, pageReady, contentPage, markdown, markdownRef, updateMarkdown, setViewMode, setDetectingLevels,
  setVerifyingLevelTotals, setActionError, setStaleNotice, setLevelVerification, setSelectedVerificationIssue, setMismatchTarget,
}) => {
  const detectLabelLevels = async () => {
    if (!pageReady) return;
    const sent = markdownRef.current;
    setDetectingLevels(true);
    setActionError('');
    setStaleNotice('');
    try {
      const result = await HelixAPI.ocrReviewAutoLevels(
        review.id,
        contentPage,
        review.revision,
        sent,
      );
      if (markdownRef.current !== sent) { setStaleNotice(LEVELS_NOTICE); return; }
      updateMarkdown(result.markdown);
      setViewMode('tables');
      const relationshipText = `${result.relationships} total relationship${result.relationships === 1 ? '' : 's'}`;
      toast?.(
        `${relationshipText} found · ${result.leveled_rows} label${result.leveled_rows === 1 ? '' : 's'} proposed. Review, then save the correction.`,
        { type: result.relationships ? 'success' : 'info' },
      );
    } catch (error) {
      setActionError(error.message || 'Could not detect table label levels');
    } finally {
      setDetectingLevels(false);
    }
  };

  const verifyLevelTotals = async () => {
    if (!pageReady) return;
    setVerifyingLevelTotals(true);
    setActionError('');
    try {
      const result = await HelixAPI.ocrReviewVerifyLevelTotals(
        review.id,
        contentPage,
        review.revision,
        markdown,
      );
      setLevelVerification(result);
      setSelectedVerificationIssue('');
      setMismatchTarget(null);
    } catch (error) {
      setLevelVerification(null);
      setActionError(error.message || 'Could not verify table level totals');
    } finally {
      setVerifyingLevelTotals(false);
    }
  };

  return { detectLabelLevels, verifyLevelTotals };
};

// Mismatched columns and unverifiable blocks of a level-total verification, as navigable issues.
const verificationIssuesFor = (levelVerification) => (levelVerification ? [
  ...levelVerification.checks.flatMap(check => check.columns
    .filter(column => !column.matches)
    .map(column => ({
      id: `mismatch-${check.table}-${check.parent_row}-${column.column}`,
      table: check.table,
      row: check.parent_row,
      column: column.column,
      label: `Table ${check.table} · row ${check.parent_row} · L${check.parent_level}→L${check.child_level} · ${column.column_label} · difference ${column.difference}`,
    }))),
  ...(levelVerification.unverifiable || []).map((block, index) => ({
    id: `review-${block.table}-${block.child_rows.join('-')}-${index}`,
    table: block.table,
    row: block.child_rows[0],
    column: 1,
    label: `Table ${block.table} · L${block.child_level} rows ${block.child_rows.join(', ')} · choose parent direction`,
  })),
] : []);

export { useLevelActions, verificationIssuesFor };
