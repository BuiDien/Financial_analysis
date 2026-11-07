"""Sanity tests for score.py — run: .venv/bin/python test_score.py"""
from pathlib import Path
from score import score_page, numbers

key = Path("truth/q1-2026_p04.md").read_text()

# 1. key vs itself is perfect
s = score_page(key, key)
assert s["num_hit"] == s["num_total"] > 0 and s["invented"] == 0, s
assert s["pair_hit"] == s["pair_total"] > 0 and s["cer"] == 0, s

# 2. one wrong digit: one miss + one invented, placement drops by one
bad = key.replace("905.800.592", "905.800.692", 1)
s = score_page(bad, key)
assert s["num_total"] - s["num_hit"] == 1 and s["invented"] == 1, s
assert s["pair_total"] - s["pair_hit"] == 1, s

# 3. right number on wrong row: numbers fine, placement drops
moved = key.replace("Tiền gửi của khách hàng", "Phát hành trái phiếu XYZ", 1)
s = score_page(moved, key)
assert s["num_hit"] == s["num_total"] and s["pair_hit"] < s["pair_total"], s

# 4. number formats: parens = negative, ignores dates / note refs
assert numbers("(1.234.567) 31/03/2026 III.15 12.345") == numbers("-1234567 12345")

# 5. label-level attributes / quote style don't matter
plain = key.replace(' data-ocr-label-level-source="auto"', "")
assert score_page(plain, key)["cer"] == 0
print("all scorer tests passed")

# 6. typo in label only: placement unaffected
typo = key.replace("Các khoản nợ Chính phủ và NHNN", "Các khoản nợ Chính phủ và NHỦN", 1)
s = score_page(typo, key)
assert s["pair_hit"] == s["pair_total"], s
print("label-typo test passed")

# 7. every key page scored against itself = 100% placement (repeated labels ok)
for f in sorted(Path("truth").glob("*.md")):
    s = score_page(f.read_text(), f.read_text())
    assert s["pair_hit"] == s["pair_total"] and s["invented"] == 0, (f.name, s)
print("self-score test passed on all pages")
