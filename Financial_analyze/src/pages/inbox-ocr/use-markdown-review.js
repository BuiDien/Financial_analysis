// Page-Markdown OCR review — all state and actions for one review (page loading, corrections,
// label levels, level-total verification, Ollama label suggestions, verify / reopen).
// markdown-review.jsx and its parts render what this returns.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { askConfirm, toast } from '../../ui';
import { HISTORY_EMPTY_DRAFT, markdownHasTable } from './ocr-inbox-utils.js';
import { useOllamaLabels } from './use-ollama-labels.js';
import { useLevelActions, verificationIssuesFor } from './use-level-actions.js';
import { useReviewLifecycle } from './use-review-lifecycle.js';

// Notice wording per case (shown when local text is kept instead of a server response).
const NOTICE = {
  saved: 'Server returned an update while you were editing — your edits were kept; reload page to see server version.',
  conflict: 'The page changed on the server — your edits were kept. Reload page to see the server version.',
};

const useMarkdownReview = ({ item, review, setReview, reload, onBack }) => {
  const firstPage = review.pages[0]?.page || 1;
  const [selectedPage, setSelectedPage] = React.useState(firstPage);
  const [pageResult, setPageResult] = React.useState(null);
  // The page `pageResult`/`markdown` belong to. Every page-scoped action posts to this page,
  // never to `selectedPage`, so content loaded for one page is never saved onto another.
  const [loadedPage, setLoadedPage] = React.useState(null);
  const pageRequest = React.useRef(0);
  const [pageLoading, setPageLoading] = React.useState(true);
  const [pageError, setPageError] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const [editing, setEditing] = React.useState(false);
  const [viewMode, setViewMode] = React.useState('preview');
  const [markdown, setMarkdown] = React.useState('');
  // A server response may only replace the text if the owner has not typed since the request
  // left (markdownRef is always the newest local text). Otherwise the local text is kept
  // (keepLocalRef carries it across the page reload a save triggers) and staleNotice says so.
  const markdownRef = React.useRef('');
  markdownRef.current = markdown;
  const keepLocalRef = React.useRef(null);
  const [staleNotice, setStaleNotice] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [detectingLevels, setDetectingLevels] = React.useState(false);
  const [verifyingLevelTotals, setVerifyingLevelTotals] = React.useState(false);
  const [levelVerification, setLevelVerification] = React.useState(null);
  const [selectionSummary, setSelectionSummary] = React.useState({ count: 0, total: '—' });
  const [selectedVerificationIssue, setSelectedVerificationIssue] = React.useState('');
  const [mismatchTarget, setMismatchTarget] = React.useState(null);
  const [hermesRun, setHermesRun] = React.useState(null);
  const [startingHermes, setStartingHermes] = React.useState(false);
  const [selectedHermesSuggestion, setSelectedHermesSuggestion] = React.useState('');
  const [markedHermesRows, setMarkedHermesRows] = React.useState([]);
  const labelsMissing = !item.labels?.ticker || !item.labels?.scope || !item.labels?.fiscal_year || !item.labels?.period_code;
  const [labelsOpen, setLabelsOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [historyDraft, setHistoryDraft] = React.useState(HISTORY_EMPTY_DRAFT);
  React.useEffect(() => { setHistoryDraft(HISTORY_EMPTY_DRAFT); }, [review.id]);

  const pageCount = review.pages.length || item.pages || 0;
  const locked = ['verified', 'published'].includes(review.status);
  const dirty = Boolean(pageResult && markdown !== pageResult.effective_markdown);
  const pageReady = Boolean(pageResult) && !pageLoading && loadedPage === selectedPage;
  const contentPage = loadedPage ?? selectedPage;
  // Page navigation waits for the current page and any page-scoped request to finish.
  const pageBusy = pageLoading || saving || detectingLevels || verifyingLevelTotals || startingHermes;

  // Only the newest request may write state: a slow page-2 response must not land under page 3.
  const loadPage = React.useCallback(async () => {
    const requestId = ++pageRequest.current;
    const page = selectedPage;
    setPageLoading(true);
    setPageError('');
    try {
      const [result, latestHermes] = await Promise.all([
        HelixAPI.ocrReviewPage(review.id, page),
        HelixAPI.ocrHermesLabelReviewLatest(review.id, page),
      ]);
      if (requestId !== pageRequest.current) return;
      const keep = keepLocalRef.current?.page === page ? keepLocalRef.current : null;
      keepLocalRef.current = null;
      setPageResult(result);
      setLoadedPage(page);
      const nextMarkdown = keep ? keep.markdown : (result.effective_markdown || '');
      markdownRef.current = nextMarkdown;
      setMarkdown(nextMarkdown);
      // Suggestions were computed for the server text: never offer them over kept local text.
      setHermesRun(keep ? null : latestHermes.run);
      setLevelVerification(null);
      setSelectionSummary({ count: 0, total: '—' });
      setSelectedVerificationIssue('');
      setSelectedHermesSuggestion('');
      setMarkedHermesRows([]);
      setMismatchTarget(null);
      if (!keep) {
        setEditing(false);
        setViewMode(markdownHasTable(result.effective_markdown) ? 'tables' : 'preview');
      }
    } catch (error) {
      if (requestId !== pageRequest.current) return;
      setPageResult(null);
      setLoadedPage(null);
      setPageError(error.message || 'Could not load this OCR page');
    } finally {
      if (requestId === pageRequest.current) setPageLoading(false);
    }
  }, [review.id, review.revision, selectedPage]);

  React.useEffect(() => {
    loadPage();
    return () => { pageRequest.current += 1; };
  }, [loadPage]);
  React.useEffect(() => {
    if (!dirty) return undefined;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const confirmDiscard = async () => {
    if (!dirty) return true;
    return askConfirm({
      title: 'Discard Markdown changes?',
      message: 'Your unsaved changes to this OCR page will be lost.',
      confirmText: 'Discard',
      danger: true,
    });
  };

  const navigate = async nextPage => {
    if (pageBusy || nextPage === selectedPage || nextPage < 1 || nextPage > pageCount) return;
    if (!await confirmDiscard()) return;
    setActionError('');
    setLevelVerification(null);
    setSelectionSummary({ count: 0, total: '—' });
    setSelectedVerificationIssue('');
    setHermesRun(null);
    setSelectedHermesSuggestion('');
    setMarkedHermesRows([]);
    setMismatchTarget(null);
    keepLocalRef.current = null;
    setStaleNotice('');
    setSelectedPage(nextPage);
  };

  const updateMarkdown = nextMarkdown => {
    markdownRef.current = nextMarkdown;
    setMarkdown(nextMarkdown);
    setLevelVerification(null);
    setSelectedVerificationIssue('');
    setHermesRun(null);
    setSelectedHermesSuggestion('');
    setMarkedHermesRows([]);
    setMismatchTarget(null);
  };

  const updateSelectionSummary = React.useCallback(nextSummary => {
    setSelectionSummary(current => (
      current.tableNumber === nextSummary.tableNumber
      && current.count === nextSummary.count
      && current.total === nextSummary.total
        ? current
        : nextSummary
    ));
  }, []);

  const toggleHermesLabelMark = React.useCallback(target => {
    setMarkedHermesRows(current => {
      const exists = current.some(row => row.table === target.table && row.row === target.row);
      return exists
        ? current.filter(row => row.table !== target.table || row.row !== target.row)
        : [...current, target];
    });
  }, []);

  // "Reload page" from the stale notice: drop local edits (after a confirm) and load the server text.
  const reloadPage = async () => {
    if (!await confirmDiscard()) return;
    keepLocalRef.current = null;
    setStaleNotice('');
    await loadPage();
  };
  // Requests computed from the current text: editing waits for them.
  const busyEditing = saving || detectingLevels || verifyingLevelTotals;

  const leave = async () => {
    if (await confirmDiscard()) onBack();
  };

  const pageAction = async (action, correctedMarkdown = null) => {
    if (!pageReady) return;
    const page = loadedPage;
    const sent = markdownRef.current;
    // A kept-local copy from an earlier response must not survive into this action's reload.
    keepLocalRef.current = null;
    setSaving(true);
    setActionError('');
    setStaleNotice('');
    try {
      const nextReview = await HelixAPI.ocrReviewPageAction(
        review.id,
        page,
        action,
        review.revision,
        correctedMarkdown,
      );
      const editedMeanwhile = markdownRef.current !== sent;
      if (editedMeanwhile) {
        keepLocalRef.current = { page, markdown: markdownRef.current };
        setStaleNotice(NOTICE.saved);
      }
      setReview(nextReview);
      setLevelVerification(null);
      if (!editedMeanwhile) {
        setEditing(false);
        if (action === 'correct') setViewMode(markdownHasTable(correctedMarkdown) ? 'tables' : 'preview');
      }
      toast?.(
        action === 'correct' ? `Page ${page} correction saved` : `Page ${page} ${action === 'restore' ? 'reset' : 'approved'}`,
        { type: 'success' },
      );
    } catch (error) {
      setActionError(error.message || `Could not ${action} page ${page}`);
      if (error.status === 409 || error.message?.includes('refresh')) {
        // The reload brings a newer revision; keep unsaved local text across it (like the success path).
        if (pageResult && markdownRef.current !== pageResult.effective_markdown) {
          keepLocalRef.current = { page, markdown: markdownRef.current };
          setStaleNotice(NOTICE.conflict);
        }
        await reload().catch(() => {});
      }
    } finally {
      setSaving(false);
    }
  };

  const saveCorrection = async () => {
    if (!dirty) return;
    await pageAction('correct', markdown);
  };

  const { detectLabelLevels, verifyLevelTotals } = useLevelActions({
    review, pageReady, contentPage, markdown, markdownRef, updateMarkdown, setViewMode, setDetectingLevels,
    setVerifyingLevelTotals, setActionError, setStaleNotice, setLevelVerification, setSelectedVerificationIssue, setMismatchTarget,
  });

  const ollama = useOllamaLabels({
    review, setReview, pageReady, dirty, contentPage, hermesRun, setHermesRun, markedHermesRows, setMarkedHermesRows,
    selectedHermesSuggestion, setSelectedHermesSuggestion, setStartingHermes, setActionError, setSaving,
    setPageResult, setMarkdown, setLevelVerification, setMismatchTarget,
  });
  const { startHermesLabelReview, decideHermesSuggestion, applyHermesSuggestions, visibleHermesSuggestions, acceptedHermesSuggestions, navigateToHermesSuggestion, activeHermesSuggestion } = ollama;

  const { verify, reopen, canReopen } = useReviewLifecycle({ item, review, setReview, reload, dirty, setSaving, setActionError });

  const selectedMeta = review.pages.find(page => page.page === selectedPage);
  const statusLabel = selectedMeta?.status || pageResult?.status || 'pending';
  const verificationIssues = verificationIssuesFor(levelVerification);
  const navigateToVerificationIssue = event => {
    const issueId = event.target.value;
    setSelectedVerificationIssue(issueId);
    const issue = verificationIssues.find(candidate => candidate.id === issueId);
    if (!issue) return;
    setMismatchTarget({ ...issue, token: Date.now() });
  };

  return {
    item, review, reload, leave, labelsOpen, setLabelsOpen, labelsMissing, canReopen, saving, reopen, visibleHermesSuggestions, locked, verify,
    historyOpen, setHistoryOpen, actionError, historyDraft, setHistoryDraft, pageBusy, selectedPage, navigate, pageCount, viewMode, setViewMode,
    editing, setEditing, pageResult, markdown, dirty, markedHermesRows, startingHermes, hermesRun, startHermesLabelReview, detectingLevels,
    verifyingLevelTotals, detectLabelLevels, verifyLevelTotals, statusLabel, pageLoading, pageError, pageReady, loadPage, updateMarkdown,
    levelVerification, mismatchTarget, updateSelectionSummary, toggleHermesLabelMark, decideHermesSuggestion, selectionSummary,
    verificationIssues, selectedVerificationIssue, navigateToVerificationIssue, selectedHermesSuggestion, navigateToHermesSuggestion,
    acceptedHermesSuggestions, activeHermesSuggestion, applyHermesSuggestions, saveCorrection, pageAction,
    staleNotice, setStaleNotice, reloadPage, busyEditing,
  };
};

export { useMarkdownReview };
