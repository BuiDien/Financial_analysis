// Page-Markdown OCR review — the Ollama label review: start a run for marked label rows, poll it,
// accept / reject / edit suggestions, apply accepted ones. Called by use-markdown-review.js, which
// owns the state this reads and writes.

import React from 'react';
import * as SyncPoller from '../../lib/sync-poller.js';
import { HelixAPI } from '../../api-client.jsx';
import { toast } from '../../ui';
import { labelLevelCode } from './ocr-inbox-utils.js';

const useOllamaLabels = ({
  review, setReview, pageReady, dirty, contentPage, hermesRun, setHermesRun, markedHermesRows, setMarkedHermesRows,
  selectedHermesSuggestion, setSelectedHermesSuggestion, setStartingHermes, setActionError, setSaving,
  setPageResult, setMarkdown, setLevelVerification, setMismatchTarget,
}) => {
  React.useEffect(() => {
    if (!hermesRun || !['queued', 'running'].includes(hermesRun.status)) return undefined;
    let canceled = false;
    const runPage = contentPage;
    const poller = SyncPoller.create({
      intervalMs: 1200,
      maxIntervalMs: 15000,
      run: async () => {
        const next = await HelixAPI.ocrHermesLabelReviewRun(review.id, runPage, hermesRun.id);
        if (!canceled) setHermesRun(next);
      },
      onError: error => { if (!canceled) setActionError(error.message || 'Could not refresh the Ollama label review'); },
    });
    poller.start();
    return () => {
      canceled = true;
      poller.stop();
    };
  }, [hermesRun?.id, hermesRun?.status, review.id, contentPage]);

  const startHermesLabelReview = async (targetsOverride = null) => {
    if (!pageReady) return;
    const targets = Array.isArray(targetsOverride) ? targetsOverride : markedHermesRows;
    if (dirty) {
      setActionError('Save or discard table changes before asking Ollama to review labels.');
      return;
    }
    if (['queued', 'running'].includes(hermesRun?.status)) {
      setActionError('Ollama is already reviewing a label. Wait for it to finish.');
      return;
    }
    if (!targets.length) {
      setActionError('Select a label cell, choose “Mark label for Ollama”, then ask Ollama.');
      return;
    }
    setStartingHermes(true);
    setActionError('');
    setSelectedHermesSuggestion('');
    try {
      const run = await HelixAPI.ocrHermesLabelReviewStart(
        review.id,
        contentPage,
        review.revision,
        targets,
      );
      setHermesRun(run);
      setMarkedHermesRows([]);
    } catch (error) {
      setActionError(error.message || 'Could not start the Ollama label review');
    } finally {
      setStartingHermes(false);
    }
  };

  const applyLabelSuggestions = async (run, accepted) => {
    const result = await HelixAPI.ocrHermesLabelSuggestionsApply(
      review.id,
      contentPage,
      review.revision,
      run.page_content_sha256,
      accepted.map(suggestion => suggestion.id),
    );
    setReview(result.review);
    setPageResult(result.page);
    setMarkdown(result.page.effective_markdown || '');
    setLevelVerification(result.verification);
    const nextRun = result.label_review_run;
    const hasRemaining = nextRun?.suggestions?.some(suggestion => (
      suggestion.applied_revision === null
      && !['rejected', 'stale'].includes(suggestion.decision)
    ));
    setHermesRun(hasRemaining ? nextRun : null);
    setSelectedHermesSuggestion('');
    setMismatchTarget(null);
    return result;
  };

  const decideHermesSuggestion = async (suggestion, decision, userEditedLevel = null) => {
    const applyImmediately = decision === 'accepted';
    // Applying replaces the page text with the server's: never over unsaved local changes.
    if (applyImmediately && dirty) { setActionError('Save or discard changes first, then apply Ollama suggestions.'); return; }
    if (applyImmediately) setSaving(true);
    setActionError('');
    try {
      const run = await HelixAPI.ocrHermesLabelSuggestionDecision(
        suggestion.id,
        decision,
        userEditedLevel,
      );
      setHermesRun(run);
      if (decision === 'rejected') {
        setSelectedHermesSuggestion('');
      } else if (applyImmediately) {
        const accepted = run.suggestions.filter(candidate => (
          candidate.id === suggestion.id
          && ['accepted', 'edited'].includes(candidate.decision)
          && candidate.applied_revision === null
        ));
        if (!accepted.length) throw new Error('The accepted suggestion is no longer available');
        await applyLabelSuggestions(run, accepted);
        toast?.(`Label changed to “${accepted[0].suggested_label || labelLevelCode(accepted[0].suggested_level)}”`, { type: 'success' });
      }
    } catch (error) {
      setActionError(error.message || `Could not ${applyImmediately ? 'accept and apply' : 'reject'} the Ollama suggestion`);
    } finally {
      if (applyImmediately) setSaving(false);
    }
  };

  const applyHermesSuggestions = async () => {
    if (dirty) { setActionError('Save or discard changes first, then apply Ollama suggestions.'); return; }
    const accepted = (hermesRun?.suggestions || []).filter(suggestion => (
      ['accepted', 'edited'].includes(suggestion.decision)
      && suggestion.applied_revision === null
    ));
    if (!accepted.length) return;
    setSaving(true);
    setActionError('');
    try {
      await applyLabelSuggestions(hermesRun, accepted);
      toast?.(`${accepted.length} Ollama label suggestion${accepted.length === 1 ? '' : 's'} applied`, { type: 'success' });
    } catch (error) {
      setActionError(error.message || 'Could not apply the Ollama label suggestions');
    } finally {
      setSaving(false);
    }
  };

  const visibleHermesSuggestions = (hermesRun?.suggestions || []).filter(
    suggestion => (
      suggestion.applied_revision === null
      && !['rejected', 'stale'].includes(suggestion.decision)
    ),
  );
  const acceptedHermesSuggestions = visibleHermesSuggestions.filter(
    suggestion => ['accepted', 'edited'].includes(suggestion.decision),
  );
  const navigateToHermesSuggestion = event => {
    const suggestionId = event.target.value;
    setSelectedHermesSuggestion(suggestionId);
    const suggestion = visibleHermesSuggestions.find(
      candidate => String(candidate.id) === suggestionId,
    );
    if (!suggestion) return;
    setMismatchTarget({
      table: suggestion.table,
      row: suggestion.row,
      column: 1,
      token: Date.now(),
    });
  };
  const activeHermesSuggestion = visibleHermesSuggestions.find(
    suggestion => String(suggestion.id) === selectedHermesSuggestion,
  );

  return { startHermesLabelReview, decideHermesSuggestion, applyHermesSuggestions, visibleHermesSuggestions, acceptedHermesSuggestions, navigateToHermesSuggestion, activeHermesSuggestion };
};

export { useOllamaLabels };
