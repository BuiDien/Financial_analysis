# Reconciliation Engine — Design Spec

**Date:** 2026-06-23
**Status:** Approved (brainstorm), ready for implementation plan.
**Part of:** Distributed Financial Analysis System (see `PLAN.md`, `CORE_DESIGN.md`).

## Purpose
The system's core differentiator — **"trust nothing until verified."** OCR-extracted Vietnamese
financial statement values (TT200 Mã số) are treated as a *draft*. Reconciliation uses the statement's
own internal accounting identities (totals = sums of parts) to catch misread digits: a wrong value makes
a total stop balancing. Verified data — and only verified data — flows to analysis (Hermes).

## Placement & invariants
- Lives in the **Core** (Mac), pure Python, **deterministic** — **no LLM in the verification path.**
- Runs **immediately after OCR** writes `line_items`, **before** any line item is `verified` or any
  statement is sent to Hermes.
- Input: a statement's `line_items` (code/value/prev_value/confidence). Output: updated `line_items.status`,
  `recon_flags` rows, `corrections` rows, and a **user notification** if anything remains unresolved.

## Decisions (locked in brainstorm)
- **Auto-repair, logged** — confident single-error back-solves are applied automatically and written to
  the `corrections` audit log (not surfaced for pre-approval).
- **Core identities first** (v1 rule set, below); subtotal roll-ups added later.
- **Suspect = low-confidence AND math-balancing** — back-solve only when exactly one member is both
  low-confidence AND the value whose correction makes the group balance. Both signals must agree.
- **Tolerance = relative % + absolute floor** — balances if `|expected-got|/|expected| ≤ 1%`
  OR `|expected-got| ≤ floor` (small absolute, for tiny numbers).
- **Missing data → flag the gap** — a rule that can't evaluate (a member wasn't extracted / only one
  statement parsed) raises a flag so the incomplete extraction is surfaced.
- **Iterative solver (Approach B)** with **max 5 iterations**.
- **Human-in-the-loop** — after the loop, any still-failing rule → open flag → **notify the user**
  (dashboard now; Slack/push later). User edit → recon re-runs → flag resolves or persists.

## Rules (declarative data, not code)
TT200 accounting identities as data; the engine interprets them. Adding a rule = add a list entry.
```python
RULES = [
  {"type": "sum",    "total": "270", "parts": ["100", "200"]},            # tổng TS = TS ngắn hạn + dài hạn
  {"type": "sum",    "total": "440", "parts": ["300", "400"]},            # tổng NV = nợ + vốn chủ
  {"type": "equals", "members": ["270", "440"]},                          # TS = NV (master balance)
  {"type": "sum",    "total": "20",  "parts": ["10", "11"], "signs": [+1, -1]},  # LN gộp = DT thuần - giá vốn
  {"type": "sum",    "total": "50",  "parts": ["20", "30", "40"]},        # LC thuần = HĐKD + HĐĐT + HĐTC
  # cross-statement (when both statements present):
  {"type": "equals", "members": ["CDKT:110", "LCTT:70"]},                 # tiền (CĐKT) = tiền cuối kỳ (LCTT)
]
```
- `sum`: `total == Σ(parts × signs)`. `signs` optional (default all +1); handles subtractions.
- `equals`: all listed members equal each other.
- Members are Mã số codes; a `STMT:code` form addresses a code in a specific statement (cross-statement).

## Algorithm — iterative constraint solver
```
def reconcile(line_items):
    by_code = index(line_items)                 # code -> line_item
    for iteration in range(MAX_ITERS = 5):
        changed = False
        for rule in RULES:
            members = lookup(rule, by_code)
            if any member missing:
                continue                         # handled in post-loop gap pass
            expected, got = evaluate(rule, members)
            if within_tolerance(expected, got):
                mark(members, 'verified' if currently unverified)
                continue
            # rule fails — try to repair
            suspect = single_member that is (confidence < LOW_CONF_THRESHOLD = 85)
                                       AND (replacing it balances the group)
            if suspect is uniquely determined:
                old = suspect.value
                suspect.value = solved_value
                suspect.status = 'repaired'
                log_correction(suspect, old, suspect.value, source='backsolve')
                changed = True
            # else: leave; may resolve via another rule next pass
        if not changed:
            break                                # fixpoint reached

    # post-loop: human-in-the-loop
    for rule in RULES:
        members = lookup(rule, by_code)
        if any member missing:
            open_flag(rule, reason='missing_data')          # flag the gap
        elif not within_tolerance(*evaluate(rule, members)):
            open_flag(rule, expected, got, member_ids)
            mark(uncertain members, 'flagged')

    if any_open_flags():
        notify_user(statement)                              # dashboard; Slack/push later
```
- **Why iterate:** a value (e.g. `270`) appears in multiple rules; re-checking each pass propagates a
  repair and enforces cross-rule consistency. A repair that satisfies one rule but breaks another won't
  survive — the broken rule fails next pass and the group ends up flagged.
- **Oscillation guard:** `MAX_ITERS = 5`; loop also exits early on a no-change fixpoint.
- **Constants:** `TOLERANCE_REL = 0.01` (1%), `TOLERANCE_ABS = 1.0` (1 triệu đồng floor, since values
  are in triệu — absorbs sub-million rounding), `LOW_CONF_THRESHOLD = 85` (matches OCR review default).

## Line-item status outcomes
- `verified` — member of a balancing group, trusted.
- `repaired` — back-solved automatically, logged in `corrections`.
- `flagged` — in a failed group, ambiguous, awaiting human edit.
- `unchecked` — no rule covered it (orphan line) — distinct from a flagged gap.

## Data model (already in `backend/app/models/core.py`)
- `line_items.status` ∈ unverified | verified | repaired | flagged.
- `recon_flags`: `rule, expected, got, member_ids(json), status(open|resolved), [reason]`.
- `corrections`: `line_item_id, old_value, new_value, source(backsolve|manual), created_at`.
- *(Add `reason` column to `recon_flags` for `missing_data` vs imbalance — minor migration.)*

## Human-in-the-loop flow
1. Recon leaves open flags → **notify** (dashboard chip "⚠ N cần xử lý"; review panel lists failing
   identities with expected vs got + suspect values highlighted).
2. User edits a flagged value (`PUT /api/line_items/{id}`) → write `correction(source=manual)` →
   **re-run reconcile** for affected rules → update flags/statuses → push update.
3. Flag `status='resolved'` when its group balances; members become `verified`.
4. Analysis (Hermes) is gated: a statement with open flags is **not** sent for analysis.

## Components (isolated units)
- `recon_rules.py` — the declarative `RULES` data + lookup/evaluate/tolerance helpers. No state.
- `recon.py` — the solver (`reconcile()`), back-solve, flag/correction writes, notify trigger.
- `routes/line_items.py` — `PUT /api/line_items/{id}` correction endpoint → re-run.
- Notification hook — dashboard now (status + flags via existing statement API); Slack/push later.

## Testing (deterministic — the planted VNM fixture is the oracle)
- `270` (52.800.000 @ conf 73, low) with `100`+`200` high-conf →
  rule `270=100+200` fails → single low-conf suspect that balances → **repaired** to 52.000.000;
  correction(source=backsolve) logged; `270=440` re-checked and consistent.
- `440 = 300 + 400` (52.000.000 = 17.000.000 + 35.000.000) → **verified**.
- LCTT group with two low-conf members (ocf 71, capex 68) → no unique suspect → **flagged** →
  open flag created → `notify_user` fires.
- Missing-member case (only CĐKT parsed, no LCTT) → cross-statement rule → **flag the gap**.
- Manual correction of a flagged value → re-run → flag resolves.

## Out of scope (v1)
Full subtotal roll-ups, multi-unknown constraint solving (Approach C), Slack/push notification
(dashboard only for now), reconciliation across more than the previous period.
