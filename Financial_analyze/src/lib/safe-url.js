// Only http(s) links are ever rendered as clickable (no javascript:/data: URLs).
const safeHttpUrl = (u) => {
  if (typeof u !== 'string' || !u) return null;
  try {
    const url = new URL(u, window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
};

export { safeHttpUrl };
