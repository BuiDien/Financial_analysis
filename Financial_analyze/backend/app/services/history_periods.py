"""Pure parsing of period, unit and statement-kind text from OCR tables."""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date

from app.services.ocr_label_library import normalize_label

_DATE_RE = re.compile(r"(?<!\d)(\d{1,2})/(\d{1,2})/(\d{4})(?!\d)")
_QUARTER_RE = re.compile(r"\bquy\s*([1-4])\s*(?:nam)?\s*(\d{4})\b")

_LABEL_MONTHS = {
    "Q1": (1, 3),
    "Q2": (4, 6),
    "Q3": (7, 9),
    "Q4": (10, 12),
    "H1": (1, 6),
    "H2": (7, 12),
    "9M": (1, 9),
    "FY": (1, 12),
}


@dataclass(frozen=True)
class Period:
    type: str  # instant | quarter | ytd | year
    start: date | None
    end: date


def _month_end(year: int, month: int) -> date:
    return date(year, month, calendar.monthrange(year, month)[1])


def _to_date(match: re.Match) -> date | None:
    day, month, year = (int(g) for g in match.groups())
    try:
        return date(year, month, day)
    except ValueError:
        return None


_CUMULATIVE_RE = re.compile(r"\bluy ke\b|\btu dau nam\b")
# Words of a period of time: a single date under them is the period's end, not a
# balance-sheet instant.
_FLOW_RE = re.compile(
    r"\bket thuc\b|\bcho ky\b|\bnam tai chinh\b|\bgiai doan\b"
    r"|\b(?:chin|sau|ba|muoi hai) thang\b"
)
# "Số cuối quý 3 năm 2026" / "Số đầu kỳ": a balance at a date, not a quarter's flow.
_CLOSING_RE = re.compile(r"\bso (?:cuoi|dau)\b")


def parse_column_period(header: str) -> Period | None:
    """Period printed in a column header, or None when it is not unambiguous.

    A cumulative header ("Lũy kế", "Từ đầu năm") is never a quarter or an
    instant: it is year-to-date only with an explicit Jan 1 start and end date.
    A single date under period words ("kết thúc ngày", "cho kỳ", ...) is not an
    instant. More than two dates are not interpreted.
    """
    text = header or ""
    norm = normalize_label(text)
    cumulative = bool(_CUMULATIVE_RE.search(norm))
    dates = [d for d in (_to_date(m) for m in _DATE_RE.finditer(text)) if d]
    if len(dates) > 2:
        return None
    if len(dates) == 1:
        if cumulative or _FLOW_RE.search(norm):
            return None
        return Period("instant", None, dates[0])
    if len(dates) == 2:
        start, end = dates[0], dates[1]
        if end < start:
            return None
        months = (end.year - start.year) * 12 + end.month - start.month + 1
        jan1 = start.month == 1 and start.day == 1
        if cumulative:
            if not jan1 or end != _month_end(end.year, end.month) or end.year != start.year:
                return None
            return Period("year", start, end) if months == 12 else Period("ytd", start, end)
        if months == 3:
            return Period("quarter", start, end)
        if months == 12:
            return Period("year", start, end)
        if jan1 and 4 <= months <= 11:
            return Period("ytd", start, end)
        return None
    if cumulative or _CLOSING_RE.search(norm):
        return None  # a cumulative quarter may be proposed by parse_relative_period
    match = _QUARTER_RE.search(norm)
    if match:
        quarter, year = int(match.group(1)), int(match.group(2))
        first = (quarter - 1) * 3 + 1
        return Period("quarter", date(year, first, 1), _month_end(year, first + 2))
    return None


_RELATIVE_QUARTER_RE = re.compile(r"\bquy\s+(iv|i{1,3}|[1-4])\b")
_ROMAN_QUARTERS = {"i": 1, "ii": 2, "iii": 3, "iv": 4}


def parse_relative_period(header: str, fiscal_year: int) -> Period | None:
    """Period for a year-less header relative to the labelled fiscal year.

    "Quý III ... Năm nay" is Q3 of ``fiscal_year``; "Năm trước" shifts one
    year back. "Lũy kế ... cuối quý III" is year-to-date through that quarter.
    Without exactly one named quarter and exactly one of Năm nay/Năm trước
    the header is not interpreted. The result is a proposal the owner confirms.
    """
    norm = normalize_label(header)
    if _DATE_RE.search(header or "") or _CLOSING_RE.search(norm):
        return None
    if _CUMULATIVE_RE.search(norm):
        # "Lũy kế ... quý 3 năm 2026": year-to-date through the named quarter.
        dated = {(int(q), int(y)) for q, y in _QUARTER_RE.findall(norm)}
        if len(dated) == 1:
            quarter, year = dated.pop()
            end = _month_end(year, quarter * 3)
            return Period("year" if quarter == 4 else "ytd", date(year, 1, 1), end)
    quarters = {
        _ROMAN_QUARTERS.get(token) or int(token)
        for token in _RELATIVE_QUARTER_RE.findall(norm)
    }
    current, previous = "nam nay" in norm, "nam truoc" in norm
    if len(quarters) != 1 or current == previous:
        return None
    quarter = quarters.pop()
    year = fiscal_year if current else fiscal_year - 1
    end = _month_end(year, quarter * 3)
    if _CUMULATIVE_RE.search(norm):
        return Period("ytd", date(year, 1, 1), end) if quarter < 4 else Period("year", date(year, 1, 1), end)
    return Period("quarter", date(year, quarter * 3 - 2, 1), end)


_UNIT_WORDS = {"ty": 1_000_000_000, "trieu": 1_000_000, "nghin": 1_000, "ngan": 1_000}
_UNIT_PREFIXED_RE = re.compile(r"\b(ty|trieu|nghin|ngan)\s+(?:dong|vnd)\b")
_UNIT_BARE_ONLY_RE = re.compile(r"(?:don vi(?: tinh)?\s+)?(?:dong|vnd)")
_UNIT_CUE_RE = re.compile(r"\bdon vi(?: tinh)?\s+(.*)")


def parse_unit_multiplier(text: str) -> int | None:
    """Unit multiplier, or None when absent or when signals disagree.

    A bare currency word ("dong"/"VND") is only trusted when it is the whole
    text or the value of an "Don vi [tinh]" cue, because accent folding turns
    names like "Dong A" into "dong".
    """
    norm = normalize_label(text)
    found: set[int] = {_UNIT_WORDS[m.group(1)] for m in _UNIT_PREFIXED_RE.finditer(norm)}
    if _UNIT_BARE_ONLY_RE.fullmatch(norm):
        found.add(1)
    for match in _UNIT_CUE_RE.finditer(norm):
        tokens = match.group(1).split()[:4]
        cue_units: set[int] = set()
        i = 0
        while i < len(tokens):
            token = tokens[i]
            if token in _UNIT_WORDS:
                cue_units.add(_UNIT_WORDS[token])
                if i + 1 < len(tokens) and tokens[i + 1] in ("dong", "vnd"):
                    i += 1  # "trieu dong" is one unit
            elif token in ("dong", "vnd"):
                cue_units.add(1)
            i += 1
        if len(cue_units) > 1:
            return None
        found |= cue_units
    return found.pop() if len(found) == 1 else None


_UNIT_CUE_ONLY_RE = re.compile(r"\bdon vi(?: tinh)?\s+(.*)")


def parse_unit_cue(text: str) -> int | None:
    """Unit named directly after an "Đơn vị [tính]" cue in page text, else None.

    Only the tokens right after the cue count, and the first must be a unit
    word, so "Đơn vị kiểm toán: ... 50 tỷ đồng" sets no unit.
    """
    found: set[int] = set()
    for match in _UNIT_CUE_ONLY_RE.finditer(normalize_label(text)):
        tokens = match.group(1).split()[:4]
        if not tokens or (tokens[0] not in _UNIT_WORDS and tokens[0] not in ("dong", "vnd")):
            continue
        i = 0
        while i < len(tokens):
            token = tokens[i]
            if token in _UNIT_WORDS:
                found.add(_UNIT_WORDS[token])
                if i + 1 < len(tokens) and tokens[i + 1] in ("dong", "vnd"):
                    i += 1
            elif token in ("dong", "vnd"):
                found.add(1)
            i += 1
    return found.pop() if len(found) == 1 else None


def detect_statement_kind(text: str) -> str | None:
    norm = normalize_label(text)
    if "tinh hinh tai chinh" in norm or "can doi ke toan" in norm:
        return "balance"
    if "ket qua hoat dong" in norm or "ket qua kinh doanh" in norm:
        return "income"
    if "luu chuyen tien" in norm:
        return "cashflow"
    return None


def label_period(fiscal_year: int, period_code: str) -> tuple[date, date]:
    try:
        first, last = _LABEL_MONTHS[period_code.upper()]
    except KeyError:
        raise ValueError(f"unknown period code: {period_code!r}") from None
    return date(fiscal_year, first, 1), _month_end(fiscal_year, last)


def columns_cover_label(periods: list[Period], fiscal_year: int, period_code: str) -> bool:
    _, end = label_period(fiscal_year, period_code)
    return any(p.end == end for p in periods)
