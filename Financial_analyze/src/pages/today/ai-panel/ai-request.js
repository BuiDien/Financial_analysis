// One AI round-trip for the side panel: HelixAPI.ask() owns the routing, the
// error wording and the cancel (`signal` aborts the HTTP request itself on
// close/unmount). Failures THROW with `display` (the panel's notice) and
// `retryable` (false while the backend is offline), so the panel can show them
// as non-persisted errors with a Retry.

import { HelixAPI } from '../../../api-client.jsx';

const askModel = async ({ question, page, context, messages, signal }) => {
  const out = await HelixAPI.ask(question, { page, context, messages, signal });
  const reply = typeof out === 'string' ? out : out == null ? '' : JSON.stringify(out);
  if (!reply.trim()) throw Object.assign(new Error('No answer came back. Try again.'), { display: 'No answer came back. Try again.', retryable: true });
  return reply;
};

export { askModel };
