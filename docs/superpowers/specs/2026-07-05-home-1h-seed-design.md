# Home dashboard — seed charts with 1 hour of history before real-time polling

**Date:** 2026-07-05 · **Status:** approved

## Problem

In live mode the Home watch board starts every tile with `series: null` and builds each chart one
point per 5-minute poll — the board is empty (or, worse, the first poll fabricates a fake
`makeSeries` random walk around the live price). The user wants each chart seeded with the **last
hour of real intraday data** on load, with real-time polling appending from there.

## Decisions

- **Interval: 5m → 12 points.** Each seeded point has the same spacing as the 5-minute poll
  cadence, so appended points continue the series coherently. (1m/60pts considered, rejected.)
- **Reuse `GET /api/history/{ticker}?period&interval`** — no new endpoint (batch `/api/spark`
  rejected: YAGNI; per-symbol parallel fetch matches the existing quote-poll pattern).
- **Local edit to `page-home.jsx` + port note** — file is artifact-owned (`design-source-of-truth`);
  the change must be ported to the design artifact like the page-sync/page-filings edits.

## Design

### Backend — `backend/app/services/market.py`
- `get_history` gains a `VN:` branch (it currently goes straight to yfinance, so VNINDEX/VNM/…
  would 404): new `_get_history_vn(symbol, period, interval)` using VCI `Quote.history` with a
  period→day-span and yfinance-interval→VCI-token mapping (`5m`→`5m`, `1d`→`1D`, `1h`→`1H`, …).
  Returns the same row shape `{date, open, high, low, close, volume}`. Cached 300s like the
  Yahoo path. Yahoo path unchanged (`period=1d&interval=5m` already works).

### Frontend — `src/api-client.jsx`
- `history(ticker, period='1mo', interval='1d')` — pass `interval` through as a query param.
  Existing caller (`page-detail.jsx`, 2-arg) unaffected.

### Frontend — `src/page-home.jsx`
- **Seed effect** (live mode only, on mount and when a symbol is added): for each watch symbol
  whose quote has no `series`, fetch `history(LIVE_TICKER[sym], '1d', '5m')`, take the **last 12
  closes** (= last hour of the most recent session; for closed markets that's the final hour of
  the last session, shown frozen), seed `series`, bump `gen` (draw-in animation). Price/chg from
  an already-landed quote poll win; history only fills the chart.
- **Race rule:** inside the `setQuotes` updater, a symbol that already has a `series` is left
  alone — authoritative regardless of stale closure reads.
- **Poll fallback change:** `pollLive` no longer fabricates `makeSeries(price, 1)` when `series`
  is null — it appends real points capped at 12 (`[...(cur?.series || []).slice(-11), price]`).
  No fake data in live mode; if the history fetch failed, the chart builds from real polls.
- Mock mode (`makeSeries` + `tickMock`) unchanged. CLOSED freeze logic unchanged.

## Failure handling

History fetch fails → tile shows price from quote polls and the chart accumulates poll points
(2 polls until a line appears). No error UI.

## Testing

- Backend: unit test for the `VN:` history branch with a faked `vnstock.explorer.vci.Quote`
  (sys.modules injection — no network), plus row-shape assertion.
- Manual: reload Home in live mode → all tiles show a 12-point chart immediately; VN symbols
  included; add-instrument seeds the new tile.

## Port to artifact

`page-home.jsx` and `api-client.jsx` changes must be replicated in the design artifact, else the
next re-export wipes them.
