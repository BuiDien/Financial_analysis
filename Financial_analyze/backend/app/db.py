"""SQLAlchemy engine, Base, session factory."""

import importlib
import sys
from datetime import timezone
from decimal import Decimal
from pathlib import Path

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import get_settings

# `python -m app.db init` otherwise creates a second `app.db` module when the
# models import Base, leaving the __main__ metadata empty.
if __name__ == "__main__":
    sys.modules.setdefault("app.db", sys.modules[__name__])

settings = get_settings()
_IS_SQLITE = settings.database_url.startswith("sqlite")
# timeout = sqlite3's busy handler (seconds); PRAGMA busy_timeout below sets
# the same on every connection, including ones not made through connect_args.
connect_args = {"check_same_thread": False, "timeout": 30} if _IS_SQLITE else {}

SQLITE_BUSY_TIMEOUT_MS = 30_000


def configure_sqlite_engine(target_engine) -> None:
    """WAL + generous busy timeout: many background writers (OCR socket,
    Gmail poller, screener refresh, label review) share one SQLite file, and
    the default rollback journal makes readers and writers block each other."""
    if target_engine.dialect.name != "sqlite":
        return

    @event.listens_for(target_engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _record):
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS}")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
        finally:
            cursor.close()


engine = create_engine(
    settings.database_url, connect_args=connect_args, pool_pre_ping=True
)
configure_sqlite_engine(engine)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI dependency — yields a session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


MODEL_MODULES = ("user", "portfolio", "filing", "ocr", "gmail", "screener", "newswatch", "alerts", "jobs")
ALEMBIC_INI = Path(__file__).resolve().parent.parent / "alembic.ini"


def import_models() -> None:
    """Register every model on Base.metadata (needed by create_all and Alembic)."""
    for name in MODEL_MODULES:
        importlib.import_module(f"{__package__}.models.{name}")


def alembic_config(connection=None):
    """Alembic Config for this backend. With `connection`, migrations run on it
    (so they share the app engine); otherwise env.py uses settings.database_url."""
    from alembic.config import Config

    config = Config(str(ALEMBIC_INI))
    if connection is not None:
        config.attributes["connection"] = connection
    return config


def _alembic(command_name: str, revision: str = "head") -> None:
    from alembic import command

    with engine.begin() as connection:
        getattr(command, command_name)(alembic_config(connection), revision)


def _schema_state() -> str:
    """'fresh' (no tables), 'managed' (has an alembic revision) or 'legacy'
    (tables created by the pre-Alembic create_all + ad-hoc ALTER era)."""
    names = set(inspect(engine).get_table_names())
    if "alembic_version" in names:
        with engine.connect() as connection:
            if connection.execute(text("SELECT version_num FROM alembic_version")).first():
                return "managed"
        names.discard("alembic_version")
    return "legacy" if names else "fresh"


def init_db():
    """Bring the database schema to Alembic head. Runs on every startup or via
    `python -m app.db init`.

    - fresh DB              -> `alembic upgrade head` (baseline creates everything)
    - managed DB            -> `alembic upgrade head`
    - legacy DB (no revision, pre-Alembic) -> legacy column ALTERs + create_all
      for tables that did not exist yet, then `alembic stamp head`. The bridge is
      only correct while head == the schema create_all builds from the models,
      which holds for the one-time switch to Alembic.

    Afterwards any legacy `holdings` rows not yet moved to the ledger are migrated
    (idempotent; a no-op for every DB created after the ledger shipped).
    """
    import_models()
    state = _schema_state()
    if state == "legacy":
        _upgrade_legacy_portfolio_schema()
        _upgrade_legacy_ocr_schema()
        _upgrade_screener_schema()
        Base.metadata.create_all(bind=engine)
        _alembic("stamp")
    else:
        _alembic("upgrade")
    _migrate_legacy_holdings()
    print(f"✓ Database initialized ({state}) at", settings.database_url)


# --- Legacy (pre-Alembic) bridge ----------------------------------------------
# Only called by init_db() for databases without an alembic revision. New schema
# changes go in alembic/versions/, never here.


def _upgrade_screener_schema():
    """Add columns introduced after ticker_metrics first shipped (idempotent)."""
    if "ticker_metrics" not in set(inspect(engine).get_table_names()):
        return
    columns = {c["name"] for c in inspect(engine).get_columns("ticker_metrics")}
    with engine.begin() as conn:
        if "board" not in columns:
            conn.execute(text("ALTER TABLE ticker_metrics ADD COLUMN board JSON"))


def _upgrade_legacy_portfolio_schema():
    """Small compatibility bridge for databases created before Alembic.

    The project historically used create_all, which cannot add columns. These
    idempotent additions make an existing local database safe before metadata
    creates the new ledger/projection tables.
    """
    names = set(inspect(engine).get_table_names())
    if "portfolios" not in names:
        return
    columns = {c["name"] for c in inspect(engine).get_columns("portfolios")}
    additions = {
        "display_currency": "VARCHAR(3) NOT NULL DEFAULT 'USD'",
        "ledger_revision": "INTEGER NOT NULL DEFAULT 0",
        "projection_revision": "INTEGER NOT NULL DEFAULT 0",
        "projection_status": "VARCHAR(24) NOT NULL DEFAULT 'ready'",
    }
    with engine.begin() as conn:
        for name, ddl in additions.items():
            if name not in columns:
                conn.execute(text(f"ALTER TABLE portfolios ADD COLUMN {name} {ddl}"))
        if "holdings" in names:
            holding_columns = {
                c["name"] for c in inspect(engine).get_columns("holdings")
            }
            if "migrated_at" not in holding_columns:
                timestamp_type = (
                    "DATETIME" if engine.dialect.name == "sqlite" else "TIMESTAMP"
                )
                conn.execute(
                    text(
                        f"ALTER TABLE holdings ADD COLUMN migrated_at {timestamp_type}"
                    )
                )


def _upgrade_legacy_ocr_schema():
    """Idempotently add page-result columns to pre-migration local databases."""
    names = set(inspect(engine).get_table_names())
    additions_by_table = {
        "ocr_inbox_items": {
            "scope": "VARCHAR(16)",
            "fiscal_year": "INTEGER",
            "period_code": "VARCHAR(4)",
        },
        "ocr_attempts": {
            "result_format": "VARCHAR(40) NOT NULL DEFAULT 'structured_rows_v1'",
            "expected_pages": "INTEGER",
            "received_pages": "INTEGER NOT NULL DEFAULT 0",
            "merged_markdown": "TEXT",
            "result_sha256": "VARCHAR(64)",
        },
        "ocr_review_jobs": {
            "result_format": "VARCHAR(40) NOT NULL DEFAULT 'structured_rows_v1'",
        },
        "ocr_label_review_runs": {
            "requested_rows": "JSON",
            "current_table_number": "INTEGER",
            "current_row_number": "INTEGER",
            "processed_count": "INTEGER NOT NULL DEFAULT 0",
            "trigger": "VARCHAR(24) NOT NULL DEFAULT 'user'",
        },
        "ocr_label_suggestions": {
            "suggested_label": "TEXT",
        },
        "ocr_page_results": {
            "label_check_status": "VARCHAR(24) NOT NULL DEFAULT 'pending'",
            "label_check_summary": "JSON",
            "label_check_error": "TEXT",
            "label_checked_at": "TIMESTAMP",
        },
    }
    with engine.begin() as conn:
        for table_name, additions in additions_by_table.items():
            if table_name not in names:
                continue
            columns = {
                column["name"]
                for column in inspect(engine).get_columns(table_name)
            }
            for name, ddl in additions.items():
                if name not in columns:
                    conn.execute(
                        text(f"ALTER TABLE {table_name} ADD COLUMN {name} {ddl}")
                    )
        if "ocr_page_results" in names:
            # The model indexes this ALTER-added column; create_all skips
            # existing tables, so the index never appeared on legacy DBs.
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_ocr_page_results_label_check_status "
                "ON ocr_page_results (label_check_status)"
            ))


def _migrate_legacy_holdings():
    from .models.portfolio import Holding, Portfolio, PortfolioTransaction
    from .services import portfolio_engine

    session = SessionLocal()
    try:
        touched = set()
        for holding in (
            session.query(Holding).filter(Holding.migrated_at.is_(None)).all()
        ):
            portfolio = session.get(Portfolio, holding.portfolio_id)
            if not portfolio:
                continue
            shares = Decimal(str(holding.shares))
            cost = Decimal(str(holding.cost_basis))
            session.add(
                PortfolioTransaction(
                    portfolio_id=portfolio.id,
                    type="BUY",
                    effective_at=holding.opened_at,
                    ticker=holding.ticker,
                    quantity=shares,
                    unit_price=cost / shares if shares else Decimal("0"),
                    currency="USD",
                    fees=0,
                    taxes=0,
                    source="legacy_migration",
                    external_id=f"holding:{holding.id}",
                    currency_assumed=True,
                )
            )
            holding.migrated_at = __import__("datetime").datetime.now(timezone.utc)
            portfolio.ledger_revision += 1
            touched.add(portfolio.id)
        session.commit()
        for portfolio_id in touched:
            portfolio_engine.rebuild(session, portfolio_id)
    finally:
        session.close()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "init":
        init_db()
    else:
        print("Usage: python -m app.db init")
