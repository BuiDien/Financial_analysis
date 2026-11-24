// Cross-page hand-off state (was window.__* globals): one page sets a value right
// before navigating, the target page reads and clears it on mount.
//   statementsTicker     detail / OCR inbox → Financial Statements
//   ocrTarget            Financial Statements → OCR Inbox ({ ticker } | null)
//   alertTicker          detail → Alerts (prefill symbol)
//   livePortfolioContext Portfolio → AI panel (live portfolio snapshot)
//   settingsSaveT        Settings "saved" badge timer
export const handoff = {};
