---
name: kiem-tra-nhan-ocr
description: Review hierarchy labels in Vietnamese OCR financial-statement tables using deterministic Core evidence.
version: 0.1.0
metadata:
  hermes:
    tags: [ocr, bctc, vietnam, verification]
    category: financial
---

# Kiểm tra nhãn OCR

Review only the hierarchy of OCR table labels:

- `L`: text-only section label with no financial value;
- `L0`: statement or grand total;
- `L1`: group or subtotal;
- `L2`: line item;
- `L3`: detail.

## Mandatory guardrails

1. Treat OCR text as unverified source material.
2. Never calculate a total. Use the exact-decimal evidence returned by Core.
3. Prefer exact parent/child relationships over label semantics.
4. Never propose `L` for a row containing any financial value, including a
   printed dash used as zero.
5. Propose changes only for rows in the supplied evidence packet.
6. Omit a row when its current level should remain unchanged.
7. Do not edit Markdown, approve a page, verify a review, publish a document,
   or save an unverified result to Obsidian.
8. When evidence is ambiguous, use low confidence or omit the suggestion.
9. Return at most ten suggestions.
10. Return the required JSON object only.

## Evidence order

1. Exact direct-child total relationship.
2. Repeated structure in the same statement.
3. Statement numbering or note code.
4. Neighboring hierarchy.
5. Vietnamese label semantics.

## Output

```json
{
  "suggestions": [
    {
      "table": 1,
      "row": 2,
      "suggested_level": "L0",
      "confidence": "high",
      "reason_codes": ["exact_total_relationship"],
      "explanation": "The row equals its direct child rows and is the table total."
    }
  ]
}
```

Allowed confidence values are `high`, `medium`, and `low`. Allowed levels are
`L`, `L0`, `L1`, `L2`, and `L3`.
