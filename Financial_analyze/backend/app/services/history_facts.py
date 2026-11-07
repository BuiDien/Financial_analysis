"""Pure fact keys, point states and derived quarters. Never touches the DB."""

from __future__ import annotations

import calendar
from dataclasses import dataclass, field
from datetime import date

from app.services.history_periods import Period


def fact_key(line_key: str, period: Period) -> str:
    start = period.start.isoformat() if period.start else ""
    return f"{line_key}|{period.type}|{start}|{period.end.isoformat()}"


def _key_of(fact: dict) -> str:
    start = fact.get("period_start")
    start_text = start.isoformat() if start else ""
    return f"{fact['line_key']}|{fact['period_type']}|{start_text}|{fact['period_end'].isoformat()}"


@dataclass
class PointState:
    fact_key: str
    value: int | None
    status: str  # single | agree | resolved | conflict
    origin: str
    source_ids: list[int] = field(default_factory=list)


def _origin_of(facts: list[dict]) -> str:
    return "printed" if any(f.get("origin") == "printed" for f in facts) else "calculated"


def point_states(facts: list[dict], resolutions: dict[str, dict]) -> dict[str, PointState]:
    groups: dict[str, list[dict]] = {}
    for fact in facts:
        if fact.get("status") != "active":
            continue
        groups.setdefault(_key_of(fact), []).append(fact)

    states: dict[str, PointState] = {}
    for key, group in groups.items():
        ids = sorted(f["id"] for f in group if f.get("id") is not None)
        values = {f["value"] for f in group}
        if len(values) == 1:
            # "agree" means two documents printed it; one PDF is one source.
            documents = {f.get("inbox_item_id") for f in group}
            status = "agree" if len(documents) > 1 else "single"
            states[key] = PointState(key, group[0]["value"], status, _origin_of(group), ids)
            continue
        resolution = resolutions.get(key)
        if resolution:
            chosen = next(
                (
                    f
                    for f in group
                    if f.get("id") == resolution.get("chosen_fact_id")
                    and f["value"] == resolution.get("chosen_value")
                ),
                None,
            )
            if chosen is not None:
                states[key] = PointState(key, chosen["value"], "resolved", chosen.get("origin", "printed"), ids)
                continue
        states[key] = PointState(key, None, "conflict", _origin_of(group), ids)
    return states


def _month_end(year: int, month: int) -> date:
    return date(year, month, calendar.monthrange(year, month)[1])


def derive_missing_quarters(facts: list[dict]) -> list[dict]:
    """Derive quarters from printed year/ytd/quarter facts of one line.

    Returns a calculated fact for each derivable quarter that has no printed value,
    and (flagged conflicts_with_printed) for one whose printed value differs.
    """
    printed = [f for f in facts if f.get("origin") == "printed" and f.get("status") == "active"]
    years = sorted({f["period_end"].year for f in printed if f.get("period_type") != "instant"})
    out: list[dict] = []
    for year in years:
        jan1 = date(year, 1, 1)
        # cum[m]: value from Jan 1 to end of month m, with the fact ids behind it.
        raw_ytd: dict[int, list[dict]] = {}
        quarters: dict[int, list[dict]] = {}
        for fact in printed:
            end = fact["period_end"]
            start = fact.get("period_start")
            if end.year != year or start is None:
                continue
            ptype = fact["period_type"]
            if ptype in ("ytd", "year") and start == jan1 and end == _month_end(year, end.month):
                if ptype == "year" and end.month != 12:
                    continue
                raw_ytd.setdefault(end.month, []).append(fact)
            elif ptype == "quarter" and start.day == 1 and start.year == year and start.month in (1, 4, 7, 10):
                if end == _month_end(year, start.month + 2):
                    quarters.setdefault(start.month, []).append(fact)
        ytd_cum = _resolve_cum(raw_ytd)
        cum = dict(ytd_cum)
        if 1 in quarters and 3 not in cum:
            cum.update(_resolve_cum({3: quarters[1]}))

        template = printed[0]
        for index, start_month in enumerate((1, 4, 7, 10)):
            end_month = start_month + 2
            if start_month == 1:
                src_hi = ytd_cum.get(3)
                src_lo = (0, None)
            else:
                src_hi = cum.get(end_month)
                src_lo = cum.get(start_month - 1)
            if src_hi is None or src_lo is None:
                continue
            derived_value = src_hi[0] - src_lo[0]
            inputs = [i for i in (src_hi[1], src_lo[1]) if i is not None]
            existing = quarters.get(start_month, [])
            existing_values = {f["value"] for f in existing}
            conflicts = False
            if existing:
                if len(existing_values) > 1 or derived_value in existing_values:
                    continue
                conflicts = True
            out.append(
                {
                    "id": None,
                    "line_key": template["line_key"],
                    "period_type": "quarter",
                    "period_start": date(year, start_month, 1),
                    "period_end": _month_end(year, end_month),
                    "value": derived_value,
                    "origin": "calculated",
                    "inbox_item_id": None,
                    "status": "active",
                    "inputs": inputs,
                    "conflicts_with_printed": conflicts,
                }
            )
    return out


def _resolve_cum(raw: dict[int, list[dict]]) -> dict[int, tuple[int, int | None]]:
    """One usable cumulative value per month; disagreeing printed values are dropped."""
    out: dict[int, tuple[int, int | None]] = {}
    for month, group in raw.items():
        if len({f["value"] for f in group}) == 1:
            ids = [f["id"] for f in group if f.get("id") is not None]
            out[month] = (group[0]["value"], min(ids) if ids else None)
    return out
