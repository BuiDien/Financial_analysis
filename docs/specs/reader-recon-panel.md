# Presentation Spec — Reader: Reconciliation Panel

> **STATUS: DEFERRED (2026-06-21).** Decision: reader keeps **OCR mock only** for now; the
> reconciliation panel is parked. Spec kept for when recon is picked up. OCR itself is an
> external system over a port — see `OCR_PROTOCOL.md`.

---


For building in the Claude design artifact. On **mock data**, shapes match `API_CONTRACT.md`.
File touched: `src/page-reader.jsx` (+ maybe a small `recon` helper). OCR tool (`ocr-tool.jsx`) already done.

## Purpose
Turn imported OCR line items into a **verify view**: show which accounting identities balance,
which were **auto-repaired** (back-solve), and which are **flagged** for human review. Let the user
correct a flagged value and re-reconcile — the human-in-the-loop. All client-side on mock now;
at connect, the same panel renders data from `GET /api/statements/{id}` instead.

## Where it lives
New section in the reader, after the Data Tracker (or a 4th tab alongside income/balance/cashflow):
**“Đối soát” (Reconciliation)**. Also add a small status chip in the reader header:
`✓ Cân đối` (all balanced) / `⚠ N cần xử lý` (N open flags).

## Data shapes (mock = contract)

**line_items** (already have via OCR import; add `status`):
```js
{ id:'ta', code:'270', label:'TỔNG CỘNG TÀI SẢN', value:52800000,
  prev_value:51000000, confidence:73, status:'unverified', page:3 }
// status ∈ unverified | verified | repaired | flagged
```

**recon_flags** (produced by mock recon; later from API):
```js
{ id:7, rule:'270 = 100 + 200', expected:52000000, got:52800000,
  member_ids:['ca','lta','ta'], status:'open' }   // open | resolved
```

**corrections** (audit; mock array in localStorage):
```js
{ id:1, line_item_id:'ta', old_value:52800000, new_value:52000000,
  source:'backsolve', created_at: Date.now() }    // backsolve | manual
```

## Mock reconciliation rules (client-side helper)
Encode the TT200 identities the fixture exercises. `tol = 1%`.
```
balance: 270 = 100 + 200
balance: 440 = 300 + 400
balance: 270 = 440
income:  20  = 10 - giá vốn      (skip if giá vốn not extracted)
cashflow: fcf = ocf + capex
```
Map codes→ids from the OCR fixture: 100=ca, 200=lta, 270=ta, 300=liab, 400=te, 440=tr.

**Algorithm (mock recon):**
1. For each rule, compute expected from members; compare to the stated total (tolerance 1%).
2. If `|expected - got| ≤ tol` → all members `status='verified'`.
3. If fails and **exactly one** member has `confidence < 85` → **back-solve**: set that member’s
   value = solved value, `status='repaired'`, push a `correction(source:'backsolve')`. Rule passes.
4. If fails and **≥2** members `confidence < 85` → create `recon_flag(status:'open')`, those members
   `status='flagged'`. No auto-change.

**Expected result on the VNM fixture:**
- Rule `270=100+200`: got 52,800,000 vs expected 52,000,000. Only `ta`(270) is low-conf (73). →
  **auto-repaired** to 52,000,000, correction logged, chip shows it balanced.
- Rule `440=300+400`: 52,000,000 = 17,000,000+35,000,000 → **verified**.
- Cashflow `fcf=ocf+capex`: members ocf(71), capex(68) both low-conf → **flagged** (open flag).

## Panel layout
```
┌ Đối soát (Reconciliation) ───────────────── [✓ Cân đối / ⚠ 1 cần xử lý] ┐
│ ── Nhóm cân đối ─────────────────────────────────────────────────────── │
│  ✓ 270 = 100 + 200      52.000.000 = 36.500.000 + 15.500.000   [Đã sửa]  │  ← repaired badge
│  ✓ 440 = 300 + 400      52.000.000 = 17.000.000 + 35.000.000             │
│  ⚠ FCF = OCF + CapEx    9.400.000 ≠ 11.200.000 + (-1.800.000)  [Cần xử lý]│  ← open flag
│        ├ OCF  11.200.000  (71%)   [sửa]                                   │
│        └ CapEx -1.800.000 (68%)   [sửa]                                   │
│ ── Lịch sử sửa (corrections) ──────────────────────────────────────────  │
│  • 270 (Tổng tài sản): 52.800.000 → 52.000.000  · back-solve · vừa xong   │
└──────────────────────────────────────────────────────────────────────────┘
```

## Badges / colors (reuse existing CSS vars)
- `verified` → green (`--pos`) ✓
- `repaired` → accent (`--accent`) “Đã sửa” + tooltip showing back-solve math
- `flagged` → warn/neg (`--warn`/`--neg`) “Cần xử lý”
- `unverified` → muted

## Interactions
1. **Auto on import:** after OCR import (existing flow), run mock recon → set statuses, flags, corrections. Persist to localStorage alongside tracker.
2. **Edit flagged value:** “sửa” opens inline number input on that member. On save → write
   `correction(source:'manual')`, re-run mock recon for affected rule(s), update statuses/flags,
   update the header chip. If the group now balances → flag `status='resolved'`, members `verified`.
3. **Tooltip on repaired:** show `expected = other members → solved value`, e.g.
   “270 suy ra từ 100+200 = 52.000.000 (sửa từ 52.800.000)”.
4. **Number format:** thousands with `.` (VN), đơn vị triệu đồng noted once at panel top.

## At-connect behavior (don’t build now, just don’t block it)
- On live: `flags` + line-item `status` come from `GET /api/statements/{id}`; edits call
  `PUT /api/line_items/{id}`; corrections from `GET /api/statements/{id}/corrections`; live updates
  arrive via `/ws` (`type:'line_item'`, `type:'recon'`). The mock recon helper is the stand-in that
  gets bypassed when `HelixAPI.live`.

## Acceptance (mock)
- Import VNM OCR → panel shows 270 auto-repaired (52.000.000), 440 verified, FCF group flagged.
- Header chip = `⚠ 1 cần xử lý`.
- Edit OCF or CapEx so FCF balances → flag resolves, chip flips to `✓ Cân đối`, correction logged.
- Reload page → states persist (localStorage).
