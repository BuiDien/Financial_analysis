"""Parse SSI monthly statements ("Sao kê tài khoản giao dịch chứng khoán").

Three sections are read:
  * Số dư chứng khoán  — month-end holdings per ticker (for reconciliation)
  * Giao dịch tiền     — every cash event: buys/sells and their fees/taxes,
                         deposits, withdrawals, cash dividends, interest,
                         custody fees, rights payments, and share allocations
                         (Phân bổ quyền: bonus shares / stock dividends)
  * Thông tin lệnh thực hiện — the matched orders of the month

Cash rows are anchored on the line that carries the date in the first
column; the type/description columns wrap onto neighbouring lines. Each
statement self-checks: opening + Σincrease − Σdecrease == closing.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")
NUM_RE = re.compile(r"^\(?-?[\d,]+(\.\d+)?\)?$")  # (1,234) = negative

# x ranges (PDF points) of the cash-table columns, from the header row.
CASH_COLS = {
    "date": (0, 80), "type": (80, 215), "content": (215, 340), "ticker": (340, 392),
    "qty": (392, 445), "price": (445, 495), "inc": (495, 570), "dec": (570, 650),
    "bal": (650, 740), "pending": (740, 900),
}
# Holdings table: right edge of each numeric column.
HOLD_COLS = [("available", 219), ("pending_sell", 295), ("pending_buy", 370), ("pledged", 439),
             ("restricted", 504), ("blocked", 533), ("tax_pending", 593), ("rights", 674),
             ("rights_pending", 739), ("margin", 806)]


# Event kinds, matched as the leading words of the row text (longest first).
KINDS = ["Thuế lãi tiền gửi", "Thuế cổ tức", "Thuế TNCN", "Thuế bán", "Chuyển tiền mua",
         "Nhận tiền bán", "Phí Mua", "Phí Bán", "Nộp tiền", "Rút tiền", "Cổ tức",
         "Phân bổ quyền", "Thanh toán quyền", "Thanh toán phí", "Lãi tiền gửi"]


def _num(s: str) -> Decimal:
    if s in ("", "-"):
        return Decimal(0)
    neg = s.startswith("(") and s.endswith(")")
    v = Decimal(s.strip("()").replace(",", ""))
    return -v if neg else v


def _date(s: str) -> date:
    return datetime.strptime(s, "%d/%m/%Y").date()


@dataclass
class CashEvent:
    day: date
    kind: str          # Vietnamese "Loại giao dịch", normalized spacing
    content: str
    ticker: str | None
    quantity: Decimal
    price: Decimal
    increase: Decimal
    decrease: Decimal
    balance: Decimal


@dataclass
class Order:
    no: int
    trade_date: date
    settle_date: date
    side: str
    ticker: str
    quantity: Decimal
    price: Decimal
    value: Decimal
    fee: Decimal
    tax: Decimal
    amount: Decimal


@dataclass
class Statement:
    account: str | None = None
    period_from: date | None = None
    period_to: date | None = None
    cash_balance: Decimal | None = None
    opening: Decimal | None = None
    closing: Decimal | None = None
    holdings: dict[str, dict[str, Decimal]] = field(default_factory=dict)
    cash: list[CashEvent] = field(default_factory=list)
    orders: list[Order] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def _lines(page):
    words = page.extract_words(x_tolerance=1.5, y_tolerance=2)
    lines: list[list[dict]] = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if lines and abs(lines[-1][0]["top"] - w["top"]) <= 2.5:
            lines[-1].append(w)
        else:
            lines.append([w])
    for ln in lines:
        ln.sort(key=lambda w: w["x0"])
    return lines


def _cash_header(ln) -> dict | None:
    """Column starts from the header row 'Ngày Loại giao dịch Nội dung Chứng Số lượng Giá Tăng Giảm Số dư Chờ'."""
    words = [w["text"] for w in ln]
    if not ({"Loại", "Tăng", "Giảm"} <= set(words)):
        return None
    xs = {}
    so = [w for w in ln if w["text"] == "Số"]
    for w in ln:
        if w["text"] in ("Chứng", "Giá", "Tăng", "Giảm", "Chờ") and w["text"] not in xs:
            xs[w["text"]] = w["x0"]
    if len(so) < 2 or len(xs) < 5:
        return None
    return {"ticker": xs["Chứng"] - 15, "qty": so[0]["x0"], "price": xs["Giá"], "inc": xs["Tăng"],
            "dec": xs["Giảm"], "bal": so[1]["x0"], "pending": xs["Chờ"]}


def _num_col(w, hdr) -> str | None:
    """Right-aligned number -> the column whose header starts at or before its right edge."""
    best = None
    for name in ("qty", "price", "inc", "dec", "bal", "pending"):
        if hdr[name] <= w["x1"] and (best is None or hdr[name] > hdr[best]):
            best = name
    return best


def _hold_header(ln) -> list | None:
    words = [w["text"] for w in ln]
    if "STT" not in words or "khả" not in words:
        return None
    starts = []
    for w in ln:
        if w["text"] in ("CK", "Chờ", "Quyền", "Ký") and w["x0"] > 140:
            starts.append(w["x0"])
    return starts


def _text(ln) -> str:
    return " ".join(w["text"] for w in ln)


def parse_statement(path: str | Path) -> Statement:
    import pdfplumber

    st = Statement()
    try:
        pdf = pdfplumber.open(str(path))
    except Exception as e:
        st.errors.append(f"cannot read PDF: {e}")
        return st
    section = None
    hdr = None
    hold_starts: list | None = None
    hold_extra: list | None = None
    pending_cash: dict | None = None  # entry being assembled
    cash_entries: list[dict] = []

    def flush():
        nonlocal pending_cash
        if pending_cash:
            cash_entries.append(pending_cash)
        pending_cash = None

    with pdf:
        all_lines = []
        for page in pdf.pages:
            all_lines += [("PAGE", None)] + [(None, ln) for ln in _lines(page)]
        i = 0
        while i < len(all_lines):
            marker, ln = all_lines[i]
            i += 1
            if marker == "PAGE":
                continue
            t = _text(ln)
            if st.account is None and (m := re.search(r"\b(\d{3}C\d{6,7})\b", t)):
                st.account = m.group(1)
            if st.period_from is None and t.startswith("Từ ngày"):
                ds = [w["text"] for w in ln if DATE_RE.match(w["text"])]
                if len(ds) >= 2:
                    st.period_from, st.period_to = _date(ds[0]), _date(ds[1])
            if t.startswith("Số dư tiền") and st.cash_balance is None:
                nums = [w["text"] for w in ln if NUM_RE.match(w["text"])]
                if not nums and i < len(all_lines) and all_lines[i][1]:
                    nums = [w["text"] for w in all_lines[i][1] if NUM_RE.match(w["text"])]
                if nums:
                    st.cash_balance = _num(nums[0])
            if t.startswith("Số dư chứng khoán"):
                section = "holdings"; continue
            if t.startswith("Giao dịch tiền"):
                section = "cash"; continue
            if t.startswith("Thông tin lệnh thực hiện"):
                flush(); section = "orders"; continue
            if t.startswith("Giao dịch chứng khoán"):
                flush(); section = "stock"; continue
            if t.startswith("Trang ") or t.startswith("CHI TIẾT") or t.startswith("Người lập") or t.startswith("Người in"):
                continue

            if section == "holdings":
                if (h := _hold_header(ln)) is not None:
                    hold_starts = h
                    # the "CK chờ thu thuế" label sits on the line above the header
                    continue
                if t.startswith("CK chờ") and not ln[0]["text"].isdigit():
                    hold_extra = [w["x0"] for w in ln if w["text"] == "CK"]
                    continue
                if ln[0]["text"].isdigit() and len(ln) >= 3 and ln[0]["x0"] < 60:
                    ticker = ln[1]["text"]
                    vals = {name: Decimal(0) for name, _ in HOLD_COLS}
                    for w in ln[2:]:
                        if not NUM_RE.match(w["text"]) and w["text"] != "-":
                            continue
                        starts = sorted(set((hold_starts or []) + (hold_extra or [])))
                        if starts and len(starts) == len(HOLD_COLS):
                            idx = max((k for k, x in enumerate(starts) if x <= w["x1"]), default=0)
                            name = HOLD_COLS[idx][0]
                        else:
                            name = min(HOLD_COLS, key=lambda c: abs(c[1] - w["x1"]))[0]
                        vals[name] = _num(w["text"])
                    st.holdings[ticker] = vals

            elif section == "cash":
                if (h := _cash_header(ln)) is not None:
                    hdr = h
                    continue
                first = ln[0]
                is_anchor = DATE_RE.match(first["text"]) and first["x0"] < 80
                if t.startswith("Số dư đầu kỳ"):
                    nums = [w for w in ln if NUM_RE.match(w["text"]) and hdr and _num_col(w, hdr) == "bal"]
                    st.opening = _num(nums[0]["text"]) if nums else Decimal(0)
                    continue
                if t.startswith("Số dư cuối kỳ"):
                    flush()
                    nums = [w for w in ln if NUM_RE.match(w["text"]) and hdr and _num_col(w, hdr) == "bal"]
                    st.closing = _num(nums[0]["text"]) if nums else Decimal(0)
                    section = None
                    continue
                if t.startswith("Ngày Loại") or t in ("khoán",):
                    continue
                if is_anchor:
                    flush()
                    pending_cash = {"top": first["top"], "words": list(ln), "pre": [], "hdr": hdr}
                    # a type/content line printed just above the anchor belongs to it
                    if cash_entries and cash_entries[-1].get("lookahead"):
                        pending_cash["pre"] = cash_entries[-1].pop("lookahead")
                    continue
                # Not an anchor: if the NEXT line is an anchor within 3pt, it is that entry's
                # first line; otherwise it continues the current entry.
                nxt = all_lines[i][1] if i < len(all_lines) and all_lines[i][0] is None else None
                if nxt and DATE_RE.match(nxt[0]["text"]) and nxt[0]["x0"] < 80 and abs(nxt[0]["top"] - first["top"]) <= 3:
                    flush()
                    pending_cash = None
                    cash_entries.append({"lookahead": list(ln)})
                    continue
                if pending_cash is not None:
                    pending_cash["words"] += ln

            elif section == "orders":
                toks = [w["text"] for w in ln]
                if len(toks) >= 10 and toks[0].isdigit() and DATE_RE.match(toks[1]):
                    try:
                        st.orders.append(_order(toks))
                    except (ValueError, IndexError, ArithmeticError) as e:
                        st.errors.append(f"order row {toks[0]}: {e} :: {' '.join(toks)}")

    for e in cash_entries:
        if "lookahead" in e and "words" not in e:
            continue
        try:
            st.cash.append(_cash_event(e["pre"] + e["words"], e["hdr"]))
        except (ValueError, IndexError, ArithmeticError) as ex:
            st.errors.append(f"cash row: {ex} :: {' '.join(w['text'] for w in e['words'])[:200]}")
    _self_check(st)
    return st


def _cash_event(words, hdr) -> CashEvent:
    if hdr is None:
        raise ValueError("cash row before table header")
    text_words, nums, ticker = [], {}, None
    day = None
    for w in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
        tx = w["text"]
        if day is None and DATE_RE.match(tx) and w["x0"] < 80:
            day = _date(tx)
            continue
        if w["x0"] >= hdr["ticker"] and w["x1"] <= hdr["qty"] + 5 and re.match(r"^[A-Z0-9]{3,10}$", tx):
            ticker = ticker or tx
            continue
        if w["x0"] >= hdr["ticker"] and NUM_RE.match(tx):
            col = _num_col(w, hdr)
            if col and col not in nums:
                nums[col] = _num(tx)
            continue
        if w["x0"] < hdr["ticker"]:
            text_words.append(tx)
    if day is None:
        raise ValueError("row without date")
    text = " ".join(text_words)
    kind = next((k for k in KINDS if text.startswith(k)), text.split(" ")[0] if text else "?")
    content = text[len(kind):].strip() if text.startswith(kind) else text
    g = lambda k: nums.get(k, Decimal(0))
    return CashEvent(day=day, kind=kind, content=content, ticker=ticker, quantity=g("qty"),
                     price=g("price"), increase=g("inc"), decrease=g("dec"), balance=g("bal"))


def _order(toks: list[str]) -> Order:
    no, td, sd, side_vn, ticker, *nums = toks
    side = {"Mua": "BUY", "Bán": "SELL"}[side_vn]
    n = [Decimal(0) if x == "-" else _num(x) for x in nums]
    if len(n) != 6:
        raise ValueError(f"expected 6 numbers, got {nums}")
    o = Order(int(no), _date(td), _date(sd), side, ticker, *n)
    if abs(o.quantity * o.price - o.value) > 1:
        raise ValueError("value != qty x price")
    expect = o.value + o.fee + o.tax if side == "BUY" else o.value - o.fee - o.tax
    if abs(expect - o.amount) > 1:
        raise ValueError(f"amount {o.amount} != {expect}")
    return o


def _self_check(st: Statement) -> None:
    """Any error recorded here makes the importer reject the whole statement."""
    if st.period_from is None or st.period_to is None:
        st.errors.append("missing statement period (Từ ngày … đến ngày …)")
    if st.opening is None or st.closing is None:
        st.errors.append("missing opening/closing balance")
        return
    bal = st.opening
    for ev in st.cash:
        bal += ev.increase - ev.decrease
        if abs(bal - ev.balance) > 1:
            st.errors.append(f"running balance {bal} != printed {ev.balance} on {ev.day} {ev.kind} {ev.content[:60]}")
            bal = ev.balance  # resync so one bad row doesn't cascade
    if abs(bal - st.closing) > 1:
        st.errors.append(f"closing {st.closing} != computed {bal}")
