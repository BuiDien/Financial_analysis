"""Settings anchor relative paths to the backend dir, not the process cwd."""
from pathlib import Path

from sqlalchemy import create_engine, text

from app.config import BACKEND_DIR, Settings, resolve_backend_path, to_storage_path
from app.db import configure_sqlite_engine


def _settings(**kw):
    return Settings(_env_file=None, **kw)


def test_backend_dir_is_the_backend_folder():
    assert (BACKEND_DIR / "app" / "config.py").is_file()


def test_defaults_are_absolute_under_backend(monkeypatch, tmp_path):
    for name in ("DATABASE_URL", "UPLOAD_DIR", "GMAIL_DOWNLOAD_DIR"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.chdir(tmp_path)
    s = _settings()
    assert s.database_url == f"sqlite:///{BACKEND_DIR / 'helix.db'}"
    assert Path(s.upload_dir) == BACKEND_DIR / "uploads"
    assert Path(s.gmail_download_dir) == BACKEND_DIR / "data" / "gmail_reports"


def test_relative_overrides_resolve_against_backend(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    s = _settings(
        database_url="sqlite:///./helix.db",
        upload_dir="./uploads",
        gmail_download_dir="data/gmail_reports",
    )
    assert s.database_url == f"sqlite:///{BACKEND_DIR / 'helix.db'}"
    assert Path(s.upload_dir) == BACKEND_DIR / "uploads"
    assert Path(s.gmail_download_dir) == BACKEND_DIR / "data" / "gmail_reports"


def test_absolute_and_special_urls_are_untouched(tmp_path):
    assert _settings(database_url=f"sqlite:///{tmp_path}/x.db").database_url == f"sqlite:///{tmp_path}/x.db"
    assert _settings(database_url="sqlite:///:memory:").database_url == "sqlite:///:memory:"
    pg = "postgresql://u:p@localhost/db"
    assert _settings(database_url=pg).database_url == pg
    assert _settings(upload_dir=str(tmp_path)).upload_dir == str(tmp_path)


def test_news_settings_come_from_settings():
    s = _settings(searxng_url="http://127.0.0.1:9999", vault_news_dir="/tmp/news")
    assert s.searxng_url == "http://127.0.0.1:9999"
    assert s.vault_news_dir == "/tmp/news"


def test_stored_relative_paths_resolve_against_backend(tmp_path):
    assert resolve_backend_path("uploads/ocr-inbox/a.pdf") == BACKEND_DIR / "uploads/ocr-inbox/a.pdf"
    assert resolve_backend_path("./uploads/a.pdf") == BACKEND_DIR / "uploads/a.pdf"
    assert resolve_backend_path(tmp_path / "a.pdf") == tmp_path / "a.pdf"
    assert to_storage_path(BACKEND_DIR / "uploads" / "a.pdf") == "uploads/a.pdf"
    assert to_storage_path(tmp_path / "a.pdf") == str(tmp_path / "a.pdf")


def test_sqlite_connections_use_wal_and_long_busy_timeout(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'wal.db'}")
    configure_sqlite_engine(engine)
    with engine.connect() as conn:
        assert conn.execute(text("PRAGMA journal_mode")).scalar() == "wal"
        assert conn.execute(text("PRAGMA busy_timeout")).scalar() == 30000
        assert conn.execute(text("PRAGMA synchronous")).scalar() == 1  # NORMAL
