"""Score OCR page markdown against the human-reviewed answer key.

Usage:  .venv/bin/python score.py <engine_dir> [<engine_dir> ...]
        (each dir holds <key>.md files matching truth/<key>.md)

Metrics per page (and totals):
  num_recall   share of answer-key numbers found in output (multiset)
  invented     numbers in output that the key does not contain (multiset)
  placed       share of (row label, number) pairs reproduced on the right row
  cer          character error rate of normalized plain text (lower = better)
  rows         output table rows / key table rows
"""
import re
import sys
import unicodedata
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

from rapidfuzz.distance import Levenshtein

TRUTH = Path(__file__).parent / "truth"
# Financial values: grouped thousands (28.346.499), optional parens/minus; or plain 4+ digit ints.
# Dates (31/03/2026) and note refs (III.15) are excluded.
NUM_RE = re.compile(r"(?<![\d/.,])(?:\(?-?\d{1,3}(?:[.,]\d{3})+\)?|\(?-?\d{5,}\)?)(?![\d/])")


def norm_text(s: str) -> str:
    s = unicodedata.normalize("NFC", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def norm_num(tok: str) -> str:
    neg = tok.startswith("(") or tok.startswith("-")
    digits = re.sub(r"\D", "", tok)
    return ("-" if neg else "") + digits.lstrip("0") or "0"


class _Tables(HTMLParser):
    """Collect every <tr> as a list of cell texts; everything else as plain text."""

    def __init__(self):
        super().__init__()
        self.rows, self.text = [], []
        self._row = self._cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None:
            self._row.append(norm_text("".join(self._cell)))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        (self._cell if self._cell is not None else self.text).append(data)
        if self._cell is not None:
            self.text.append(data)


def parse(md: str):
    p = _Tables()
    p.feed(md)
    plain = norm_text(" ".join(p.text))
    plain = re.sub(r"[#*|>`]", "", plain)
    return p.rows, norm_text(plain)


def numbers(s: str) -> Counter:
    return Counter(norm_num(t) for t in NUM_RE.findall(s))


def labelled_rows(rows):
    """[(label, Counter(numbers))] for rows whose first cell is a text label."""
    out = []
    for row in rows:
        if not row or not re.search(r"[^\W\d_]", row[0]):
            continue
        nums = Counter()
        for cell in row[1:]:
            nums += numbers(cell)
        if nums:
            out.append((row[0], nums))
    return out


def placement(t_rows, o_rows, min_sim=0.8):
    """Numbers found on the output row whose label best matches the key row's label.
    Fuzzy label match so an OCR typo in the label is not counted as misplacement."""
    t_lab, o_lab = labelled_rows(t_rows), labelled_rows(o_rows)
    total = hit = 0
    n_t, n_o = max(len(t_lab), 1), max(len(o_lab), 1)
    for i, (label, nums) in enumerate(t_lab):
        total += sum(nums.values())
        # Repeated labels (same line name in several sections): prefer the row
        # at the same relative position in the page.
        scored = [
            (Levenshtein.normalized_similarity(label, o_label), -abs(i / n_t - j / n_o), o_nums)
            for j, (o_label, o_nums) in enumerate(o_lab)
        ]
        scored = [s for s in scored if s[0] >= min_sim]
        if scored:
            best_sim = max(s[0] for s in scored)
            near_best = [s for s in scored if s[0] >= best_sim - 0.05]
            hit += overlap(nums, max(near_best, key=lambda s: s[1])[2])
    return total, hit


def overlap(a: Counter, b: Counter) -> int:
    return sum((a & b).values())


def score_page(out_md: str, truth_md: str) -> dict:
    t_rows, t_text = parse(truth_md)
    o_rows, o_text = parse(out_md)
    t_nums, o_nums = numbers(t_text), numbers(o_text)
    pair_total, pair_hit = placement(t_rows, o_rows)
    return {
        "num_total": sum(t_nums.values()),
        "num_hit": overlap(t_nums, o_nums),
        "invented": sum((o_nums - t_nums).values()),
        "pair_total": pair_total,
        "pair_hit": pair_hit,
        "cer": Levenshtein.normalized_distance(o_text, t_text),
        "rows_out": len(o_rows),
        "rows_key": len(t_rows),
    }


def pct(a, b):
    return f"{100 * a / b:5.1f}%" if b else "  n/a"


def report(engine_dir: Path):
    print(f"\n== {engine_dir.name} ==")
    print(f"{'page':<14}{'num_recall':>11}{'invented':>9}{'placed':>8}{'cer':>7}{'rows':>9}")
    tot = Counter()
    cers = []
    for truth_file in sorted(TRUTH.glob("*.md")):
        out_file = engine_dir / truth_file.name
        if not out_file.exists():
            print(f"{truth_file.stem:<14}  (missing)")
            continue
        s = score_page(out_file.read_text(), truth_file.read_text())
        cers.append(s["cer"])
        for k in ("num_total", "num_hit", "invented", "pair_total", "pair_hit"):
            tot[k] += s[k]
        print(f"{truth_file.stem:<14}{pct(s['num_hit'], s['num_total']):>11}{s['invented']:>9}"
              f"{pct(s['pair_hit'], s['pair_total']):>8}{s['cer']:>7.3f}{s['rows_out']:>4}/{s['rows_key']:<4}")
    if cers:
        print(f"{'TOTAL':<14}{pct(tot['num_hit'], tot['num_total']):>11}{tot['invented']:>9}"
              f"{pct(tot['pair_hit'], tot['pair_total']):>8}{sum(cers) / len(cers):>7.3f}")


if __name__ == "__main__":
    for d in sys.argv[1:]:
        report(Path(d))
