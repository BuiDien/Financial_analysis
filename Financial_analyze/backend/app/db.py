"""SQLAlchemy engine, Base, session factory."""

import sys
from datetime import timezone
from decimal import Decimal

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import get_settings

# `python -m app.db init` otherwise creates a second `app.db` module when the
# models import Base, leaving the __main__ metadata empty.
if __name__ == "__main__":
    sys.modules.setdefault("app.db", sys.modules[__name__])

settings = get_settings()
connect_args = (
    {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
)

engine = create_engine(
    settings.database_url, connect_args=connect_args, pool_pre_ping=True
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI dependency — yields a session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Create all tables. Run once on startup or via `python -m app.db init`."""
    # Import models so they're registered on Base.metadata
    from .models import user, portfolio, filing, scan, ocr  # noqa: F401

    _upgrade_legacy_portfolio_schema()
    _upgrade_legacy_ocr_schema()
    Base.metadata.create_all(bind=engine)
    _migrate_legacy_holdings()
    print("✓ Database initialized at", settings.database_url)


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
