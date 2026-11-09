"""Pull broker trade-report PDFs from Gmail over IMAP (read-only).

Flow: login with the app password from Keychain -> open "All Mail" (found by
its \\All flag; the name is localized) -> run the Gmail search query ->
skip messages already recorded (by X-GM-MSGID) -> download PDF attachments
to `gmail_download_dir` -> record one GmailReport per message.

Mailbox access sits behind a small interface so tests use a fake.
"""
from __future__ import annotations

import email
import hashlib
import imaplib
import io
import re
import threading
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime
from pathlib import Path

from sqlalchemy.orm import Session

from ..config import get_settings
from ..models.gmail import GmailConfig, GmailReport
from . import secret_store

DEFAULT_QUERY = 'subject:"Thông báo kết quả giao dịch" SSI has:attachment newer_than:60d'
# Monthly statements are always searched too (authoritative: bonus shares, dividends, cash).
STATEMENT_QUERY = 'from:ssi.com.vn has:attachment filename:TradingAccountStatement'
SECRET_NAME = "gmail"
SECRET_ACCOUNT = "app-password"
MAX_NEW_PER_RUN = 50

_run_lock = threading.Lock()


class GmailError(RuntimeError):
    pass


class GmailAuthError(GmailError):
    pass


class GmailBusy(GmailError):
    pass


# ── Mailbox ────────────────────────────────────────────────────────────

_MSGID_RE = re.compile(rb"X-GM-MSGID (\d+)")
_UID_RE = re.compile(rb"UID (\d+)")


def _all_mail_folder(lines) -> str:
    for line in lines or []:
        s = line.decode(errors="replace") if isinstance(line, bytes) else str(line)
        if "\\All" in s:
            if s.endswith('"'):
                return s[s.rindex(' "', 0, len(s) - 1) + 1:]
            return s.rsplit(" ", 1)[-1]
    return '"INBOX"'


class ImapMailbox:
    """Thin read-only wrapper over imaplib for Gmail."""

    def __init__(self, conn):
        self.conn = conn
        self.folder = None

    @classmethod
    def open(cls, address: str, password: str) -> "ImapMailbox":
        try:
            conn = imaplib.IMAP4_SSL("imap.gmail.com", timeout=30)
        except OSError as e:
            raise GmailError(f"cannot reach imap.gmail.com: {e}") from e
        try:
            conn.login(address, password)
        except imaplib.IMAP4.error as e:
            raise GmailAuthError(_auth_hint(str(e))) from e
        box = cls(conn)
        _, lines = conn.list()
        box.folder = _all_mail_folder(lines)
        typ, _ = conn.select(box.folder, readonly=True)
        if typ != "OK":
            raise GmailError(f"cannot open folder {box.folder}")
        return box

    def search(self, query: str) -> list[bytes]:
        # Non-ASCII (Vietnamese) query must go as a UTF-8 literal.
        self.conn.literal = query.encode("utf-8")
        typ, data = self.conn.uid("SEARCH", "CHARSET", "UTF-8", "X-GM-RAW")
        if typ != "OK":
            raise GmailError(f"search failed: {data!r}"[:300])
        return data[0].split() if data and data[0] else []

    def msgids(self, uids: list[bytes]) -> dict[bytes, str]:
        if not uids:
            return {}
        typ, data = self.conn.uid("FETCH", b",".join(uids).decode(), "(X-GM-MSGID)")
        out = {}
        for item in data or []:
            raw = item[0] if isinstance(item, tuple) else item
            if not isinstance(raw, bytes):
                continue
            m, u = _MSGID_RE.search(raw), _UID_RE.search(raw)
            if m and u:
                out[u.group(1)] = m.group(1).decode()
        return out

    def fetch(self, uid: bytes) -> bytes:
        typ, data = self.conn.uid("FETCH", uid.decode(), "(BODY.PEEK[])")  # PEEK: don't mark read
        for item in data or []:
            if isinstance(item, tuple) and len(item) > 1:
                return item[1]
        raise GmailError(f"empty message body for uid {uid!r}")

    def close(self) -> None:
        try:
            self.conn.logout()
        except Exception:
            pass


def _auth_hint(msg: str) -> str:
    if "Application-specific password required" in msg:
        return "Gmail needs an app password, not your normal password (myaccount.google.com/apppasswords)."
    if "AUTHENTICATIONFAILED" in msg or "Invalid credentials" in msg:
        return "Gmail rejected the address or app password."
    return f"Gmail login failed: {msg}"


mailbox_factory = ImapMailbox.open  # tests replace this


# ── Config / secret ────────────────────────────────────────────────────

def get_config(db: Session) -> GmailConfig:
    cfg = db.get(GmailConfig, 1)
    if cfg is None:
        cfg = GmailConfig(id=1, query=DEFAULT_QUERY, enabled=False, interval_minutes=30)
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    return cfg


def get_password() -> str | None:
    return secret_store.get_store().get(SECRET_NAME, SECRET_ACCOUNT)


def set_password(password: str) -> None:
    secret_store.get_store().set(SECRET_NAME, SECRET_ACCOUNT, password)


def delete_password() -> None:
    secret_store.get_store().delete(SECRET_NAME, SECRET_ACCOUNT)


def _open(cfg: GmailConfig):
    if not cfg.address:
        raise GmailError("Gmail address is not set.")
    password = get_password()
    if not password:
        raise GmailError("App password is not saved.")
    return mailbox_factory(cfg.address, password)


# ── Operations ─────────────────────────────────────────────────────────

def test_connection(db: Session) -> dict:
    cfg = get_config(db)
    box = _open(cfg)
    try:
        uids = box.search(cfg.query or DEFAULT_QUERY)
        return {"ok": True, "folder": box.folder, "matches": len(uids)}
    finally:
        box.close()


def _dec(s) -> str:
    try:
        return str(make_header(decode_header(s))) if s else ""
    except Exception:
        return str(s or "")


def _safe_name(name: str) -> str:
    name = Path(name).name  # drop any path parts
    name = re.sub(r"[^\w.\-]+", "_", name, flags=re.UNICODE).strip("._")
    return name[:120] or "attachment.pdf"


def _is_encrypted(payload: bytes) -> bool | None:
    try:
        from pypdf import PdfReader
        return bool(PdfReader(io.BytesIO(payload)).is_encrypted)
    except Exception:
        return None


def _save_message(raw: bytes, gm_msgid: str, out_dir: Path) -> dict:
    msg = email.message_from_bytes(raw)
    try:
        received = parsedate_to_datetime(msg["Date"]) if msg["Date"] else None
        # SQLite drops the offset, so store UTC (the UI reads stored times as UTC).
        if received is not None:
            received = (received if received.tzinfo else received.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    except (TypeError, ValueError):
        received = None
    attachments = []
    for part in msg.walk():
        fn = part.get_filename()
        if not fn:
            continue
        fn = _dec(fn)
        if not fn.lower().endswith(".pdf"):
            continue
        payload = part.get_payload(decode=True) or b""
        day = (received or datetime.now(timezone.utc)).strftime("%Y%m%d")
        dest = out_dir / f"{day}_{gm_msgid}_{_safe_name(fn)}"
        dest.write_bytes(payload)
        attachments.append({
            "filename": fn,
            "path": str(dest),
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "encrypted": _is_encrypted(payload),
        })
    return {
        "received_at": received,
        "sender": _dec(msg["From"]),
        "subject": _dec(msg["Subject"]),
        "attachments": attachments,
    }


def run_check(db: Session, *, now: datetime | None = None) -> dict:
    """Search Gmail and download new reports. Raises GmailBusy if a check is running."""
    if not _run_lock.acquire(blocking=False):
        raise GmailBusy("A Gmail check is already running.")
    try:
        cfg = get_config(db)
        try:
            summary = _run_check_locked(db, cfg)
        except Exception as e:
            cfg.last_status, cfg.last_error = "error", str(e)[:500]
            cfg.last_checked_at = now or datetime.now(timezone.utc)
            db.commit()
            if isinstance(e, GmailError):
                raise
            raise GmailError(str(e)) from e
        # New PDFs flow straight into the portfolio ledger.
        from . import ssi_import
        try:
            if summary["new"] >= MAX_NEW_PER_RUN:
                # More messages are waiting: import once everything is here, so a
                # half-downloaded set of statements never looks like missing months.
                summary["import"] = {"deferred": True}
            else:
                summary["import"] = ssi_import.import_pending(db)
        except Exception as e:  # keep the pull result; report the import problem
            db.rollback()
            summary["import"] = {"error": str(e)[:500]}
        cfg = get_config(db)
        cfg.last_status, cfg.last_error, cfg.last_summary = "ok", None, summary
        cfg.last_checked_at = now or datetime.now(timezone.utc)
        db.commit()
        return summary
    finally:
        _run_lock.release()


def _run_check_locked(db: Session, cfg: GmailConfig) -> dict:
    out_dir = Path(get_settings().gmail_download_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    box = _open(cfg)
    try:
        uids = box.search(cfg.query or DEFAULT_QUERY)
        uids += [u for u in box.search(STATEMENT_QUERY) if u not in set(uids)]
        ids = box.msgids(uids)
        done = {r.gm_msgid: r for r in db.query(GmailReport).filter(GmailReport.gm_msgid.in_(list(ids.values()))).all()} if ids else {}
        todo = [(u, m) for u, m in ids.items() if m not in done or done[m].status == "error"]
        todo = todo[-MAX_NEW_PER_RUN:]
        downloaded = no_pdf = errors = 0
        for uid, gm_msgid in todo:
            row = done.get(gm_msgid) or GmailReport(gm_msgid=gm_msgid, status="error", attachments=[])
            try:
                info = _save_message(box.fetch(uid), gm_msgid, out_dir)
                row.received_at, row.sender, row.subject = info["received_at"], info["sender"], info["subject"]
                row.attachments = info["attachments"]
                row.status = "downloaded" if info["attachments"] else "no_pdf"
                row.error = None
                downloaded += bool(info["attachments"])
                no_pdf += not info["attachments"]
            except Exception as e:  # one bad message must not stop the run
                row.status, row.error = "error", str(e)[:500]
                errors += 1
            db.add(row)
            db.commit()
        return {"matches": len(uids), "new": len(todo), "downloaded": downloaded,
                "no_pdf": no_pdf, "errors": errors}
    finally:
        box.close()


def is_due(cfg: GmailConfig, now: datetime) -> bool:
    if not cfg.enabled or not cfg.address:
        return False
    if cfg.last_checked_at is None:
        return True
    last = cfg.last_checked_at
    if last.tzinfo is None:  # SQLite returns naive datetimes
        last = last.replace(tzinfo=timezone.utc)
    return (now - last).total_seconds() >= max(cfg.interval_minutes, 5) * 60
