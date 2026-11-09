from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import get_settings
from app.db import Base, get_db
from app.main import app
from app.models.gmail import GmailReport
from app.services import gmail_pull, secret_store

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def make_mail(subject, pdf_name="TK1786441_20261106_Ket_Qua_Giao_Dich.PDF"):
    m = EmailMessage()
    m["From"] = "SSI <noreply@ssi.com.vn>"
    m["Subject"] = subject
    m["Date"] = "Fri, 06 Nov 2026 18:00:00 +0700"
    m.set_content("see attachment")
    if pdf_name:
        m.add_attachment(PDF, maintype="application", subtype="pdf", filename=pdf_name)
    return m.as_bytes()


class FakeMailbox:
    def __init__(self, messages):
        self.messages = messages  # uid(bytes) -> (msgid, raw)
        self.folder = '"[Gmail]/All Mail"'
        self.fetched = []
        self.queries = []

    def search(self, query):
        self.queries.append(query)
        return list(self.messages)

    def msgids(self, uids):
        return {u: self.messages[u][0] for u in uids}

    def fetch(self, uid):
        self.fetched.append(uid)
        raw = self.messages[uid][1]
        if raw is None:
            raise RuntimeError("boom")
        return raw

    def close(self):
        pass


@pytest.fixture
def env(tmp_path, monkeypatch):
    store = secret_store.MemoryStore()
    secret_store.use_store(store)
    monkeypatch.setattr(get_settings(), "gmail_download_dir", str(tmp_path / "reports"))
    box = FakeMailbox({
        b"1": ("111", make_mail("CTCP Chứng Khoán SSI - Thông báo kết quả giao dịch ngày 06/11/2026")),
        b"2": ("222", make_mail("no attachment", pdf_name=None)),
    })
    seen = {}

    def factory(address, password):
        seen["login"] = (address, password)
        return box
    monkeypatch.setattr(gmail_pull, "mailbox_factory", factory)

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def override():
        s = Session()
        try:
            yield s
        finally:
            s.close()
    app.dependency_overrides[get_db] = override
    yield {"client": TestClient(app), "store": store, "box": box, "seen": seen, "Session": Session, "tmp": tmp_path}
    app.dependency_overrides.clear()
    secret_store.use_store(secret_store.KeychainStore())


def save(client, **kw):
    body = {"address": "me@gmail.com", "password": "abcd efgh ijkl mnop", **kw}
    return client.put("/api/gmail/settings", json=body)


def test_password_is_write_only_and_stored_in_secret_store(env):
    r = save(env["client"])
    assert r.status_code == 200
    body = r.json()
    assert body["password_saved"] is True
    assert "abcd" not in r.text
    assert env["store"].get("gmail", "app-password") == "abcdefghijklmnop"  # spaces stripped
    assert "abcd" not in env["client"].get("/api/gmail/settings").text


def test_rejects_bad_password_and_enable_without_credentials(env):
    c = env["client"]
    assert c.put("/api/gmail/settings", json={"enabled": True}).status_code == 400
    assert save(c, password="bad pass!").status_code == 400


def test_remove_password_disables_auto_check(env):
    c = env["client"]
    save(c, enabled=True)
    body = c.delete("/api/gmail/password").json()
    assert body["password_saved"] is False and body["enabled"] is False


def test_test_connection_counts_matches(env):
    c = env["client"]
    save(c)
    r = c.post("/api/gmail/test")
    assert r.status_code == 200 and r.json()["matches"] == 2
    assert env["seen"]["login"] == ("me@gmail.com", "abcdefghijklmnop")


def test_check_downloads_once_and_records_reports(env):
    c = env["client"]
    save(c)
    r = c.post("/api/gmail/check")
    assert r.status_code == 200
    s = r.json()["summary"]
    assert {k: s[k] for k in ("matches", "new", "downloaded", "no_pdf", "errors")} == {"matches": 2, "new": 2, "downloaded": 1, "no_pdf": 1, "errors": 0}
    assert s["import"]["failed_reports"]  # the fake PDF can't be parsed -> flagged, not imported
    files = list((env["tmp"] / "reports").iterdir())
    assert len(files) == 1 and files[0].read_bytes() == PDF
    assert files[0].name.startswith("20261106_111_")

    # second run: nothing new, nothing re-fetched
    env["box"].fetched.clear()
    r2 = c.post("/api/gmail/check").json()
    assert r2["summary"]["new"] == 0 and env["box"].fetched == []

    reports = c.get("/api/gmail/reports").json()["reports"]
    assert {x["status"] for x in reports} == {"parse_error", "no_pdf"}
    pdf = next(x for x in reports if x["status"] == "parse_error")
    assert pdf["subject"].startswith("CTCP Chứng Khoán SSI")
    assert pdf["attachments"][0]["filename"].endswith(".PDF")
    assert "path" not in pdf["attachments"][0]


def test_failed_message_is_retried(env):
    c = env["client"]
    save(c)
    env["box"].messages[b"3"] = ("333", None)
    s = c.post("/api/gmail/check").json()["summary"]
    assert s["errors"] == 1
    env["box"].messages[b"3"] = ("333", make_mail("retry ok"))
    s2 = c.post("/api/gmail/check").json()["summary"]
    assert s2["new"] == 1 and s2["downloaded"] == 1


def test_check_without_password_reports_error(env):
    c = env["client"]
    c.put("/api/gmail/settings", json={"address": "me@gmail.com"})
    r = c.post("/api/gmail/check")
    assert r.status_code == 400
    assert c.get("/api/gmail/settings").json()["last_status"] == "error"


def test_is_due():
    from app.models.gmail import GmailConfig
    now = datetime(2026, 11, 8, 12, tzinfo=timezone.utc)
    cfg = GmailConfig(enabled=True, address="a@b.c", interval_minutes=30, last_checked_at=None)
    assert gmail_pull.is_due(cfg, now)
    cfg.last_checked_at = (now - timedelta(minutes=10)).replace(tzinfo=None)  # naive like SQLite
    assert not gmail_pull.is_due(cfg, now)
    cfg.last_checked_at = now - timedelta(minutes=31)
    assert gmail_pull.is_due(cfg, now)
    cfg.enabled = False
    assert not gmail_pull.is_due(cfg, now)


def test_all_mail_folder_localized():
    lines = [b'(\\HasNoChildren) "/" "INBOX"', b'(\\All \\HasNoChildren) "/" "[Gmail]/T&HqU-t c&HqM- th&AbA-"']
    assert gmail_pull._all_mail_folder(lines) == '"[Gmail]/T&HqU-t c&HqM- th&AbA-"'
    assert gmail_pull._all_mail_folder([b'(\\HasNoChildren) "/" "INBOX"']) == '"INBOX"'
