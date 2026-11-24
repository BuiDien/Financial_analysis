import os
import tempfile

# Never let a test open the real helix.db: any code path that falls through to
# app.db.SessionLocal lands in a throwaway file instead. Env vars beat .env.
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(
    tempfile.mkdtemp(prefix="helix-test-"), "test.db")
os.environ.setdefault("ENABLE_GMAIL_POLLER", "false")
os.environ.setdefault("ENABLE_SCREENER_REFRESH", "false")
os.environ.setdefault("SCREENER_PROVIDER", "fixture")  # tests never build VnstockProvider via settings

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.models import user, portfolio, filing, ocr, gmail, screener, newswatch  # noqa: F401 — register tables


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture(autouse=True)
def _fresh_vnstock_limiter(monkeypatch):
    """Fresh, non-sleeping limiter per test so cooldown/spacing state never leaks."""
    from app.screener import ratelimit
    monkeypatch.setattr(ratelimit, "vnstock_limiter",
                        ratelimit.RateLimiter(interval_s=0.0, cooldown_s=0.0))


@pytest.fixture(autouse=True)
def _fresh_ocr_dispatch_lock():
    """The OCR coordinator is a module singleton; its asyncio.Lock binds to the
    first event loop it is contended on, and every TestClient has its own loop.
    Give every test a fresh, unbound lock."""
    import asyncio
    from app.routes.sync import coordinator
    coordinator._dispatch_lock = asyncio.Lock()
    yield
