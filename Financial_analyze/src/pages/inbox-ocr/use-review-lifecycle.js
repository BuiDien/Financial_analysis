// Page-Markdown OCR review: whole-review lifecycle — verify (all pages) and reopen a verified review.

import { HelixAPI } from '../../api-client.jsx';
import { toast } from '../../ui';
import { reopenVerifiedOcrReview } from './shared.jsx';

const useReviewLifecycle = ({ item, review, setReview, reload, dirty, setSaving, setActionError }) => {
  // Verify reloads every page from the server: unsaved page text must be saved or discarded first.
  const verify = async () => {
    if (dirty) { setActionError('Save or discard changes first.'); return; }
    setSaving(true);
    setActionError('');
    try {
      const nextReview = await HelixAPI.ocrReviewVerify(review.id, review.revision);
      setReview(nextReview);
      await reload();
      toast?.('Page Markdown review verified', { type: 'success' });
    } catch (error) {
      setActionError(error.message || 'Could not verify the page review');
    } finally {
      setSaving(false);
    }
  };

  const reopen = async () => {
    setSaving(true);
    setActionError('');
    try {
      const result = await reopenVerifiedOcrReview(item, review);
      if (!result) return;
      if (Array.isArray(result.pages) && result.revision !== undefined) setReview(result);
      await reload();
      toast?.('Review reopened — verify it again when done', { type: 'success' });
    } catch (error) {
      setActionError(error.message || 'Could not reopen the review');
    } finally {
      setSaving(false);
    }
  };
  const canReopen = review.status === 'verified';

  return { verify, reopen, canReopen };
};

export { useReviewLifecycle };
