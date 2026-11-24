# Portfolio: Sync email + Paste SSI orders — design

## Intent
From the Portfolio page the user can (a) pull new SSI trade emails now and (b) paste the
trade rows they see in an SSI "Thông báo kết quả giao dịch" email/PDF, preview them, and add
them to the ledger — without going to Inbox → Gmail. Real money ledger: never guess a row.

## Approaches (user picked 1)
1. **Reuse the backend SSI row parser** (`services/ssi_trade_report.py`) for pasted text,
   preview with arithmetic check, commit as manual-like rows. ← picked
2. Parse in the browser, add each row via `addTransaction` — duplicates the parser, loses verify.
3. Generic column-guessing parser — any broker, higher misread risk.

## Design
### Backend
- `ssi_trade_report.parse_text(text) -> Report`: NFC-normalise, tolerate tabs / extra spaces /
  rows split across lines (scan tokens for row starts: `STT dd/mm/yyyy [dd/mm/yyyy] Mua|Bán TICKER`
  followed by numbers until the next row start or a non-number token). Reuse `_parse_row` +
  `_verify` unchanged; pick up account (`\d{3}C\d{6,7}`) if present. Rows failing verify go
  to `errors`, never guessed. PDF path keeps working (shared code, no behaviour change).
- `POST /api/portfolio/paste/preview {text}` → `{account, trades:[{…trade, key, duplicate: bool,
  duplicate_of?: {id, source}}], errors:[…]}`. `duplicate` = an active BUY/SELL already in the
  ledger with same local trade day, ticker, side, qty, price (any source: ssi_email,
  ssi_statement, manual, paste). No DB writes.
- `POST /api/portfolio/paste/commit {text, keys:[…]}` → re-parses server-side (never trusts
  client numbers), inserts only the selected non-duplicate rows as `source="manual"`,
  `effective_at` same rule as SSI import (trade date 15:00 VN + no seconds), fees/taxes from the
  row, note `"Pasted SSI order · <account|no account> · row <no>"`. Runs
  `validate_ledger_sequence` (oversell → 409/422 with message), bumps ledger revision, schedules
  rebuild. Returns `{added, skipped, job}`.
  Being `manual`, a later email import of the same trade replaces it via the existing
  3-day/same-qty/price rule → never double counted.
- Thin route in `routes/portfolio.py`, logic in a new `services/portfolio_paste.py`.

### Frontend (Portfolio page)
- Header + TransactionsPanel: **Sync email** button → `HelixAPI.checkGmail()`; spinner while
  running; toast with summary (new emails / trades imported / errors); refresh portfolio queries.
  If Gmail is not set up (no address/password) → toast with link to `#/inbox/gmail`.
  Replace the old "Import SSI" nav-only button with Sync email (keep a "Gmail settings" link).
- **Paste orders** button → Dialog: textarea → "Preview" → table (date, side, ticker, qty, price,
  fee, tax, amount, status: OK / Already in ledger / Error) with checkboxes (duplicates and
  errors unchecked + disabled) → "Add N trades". Errors listed verbatim. VND via lib/format.
- Uses src/ui components (Dialog, DataTable, Button, Badge, toast); existing api-client methods
  added: `portfolioPastePreview`, `portfolioPasteCommit`.

## Non-goals
Other brokers; parsing email body HTML automatically; editing parsed numbers in the dialog
(user edits afterwards via the normal Edit transaction).

## Left to the builder
Exact token-scan implementation; dialog layout details; test fixtures (use rows from
tests/test_ssi_import.py plus tab-separated and line-wrapped variants).
