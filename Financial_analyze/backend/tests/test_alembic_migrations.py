"""Alembic baseline + init_db() startup paths (fresh / legacy / managed)."""

import shutil
import sqlite3
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

from app import db as db_module
from app.db import Base
from app.services import portfolio_engine

BACKUP_DB = (
    Path(__file__).resolve().parent.parent / "helix.db.bak-20261124-before-v2-refactor"
)


def _head() -> str:
    return ScriptDirectory.from_config(db_module.alembic_config()).get_current_head()


def _version(engine) -> str | None:
    with engine.connect() as connection:
        return connection.execute(text("SELECT version_num FROM alembic_version")).scalar()


def _upgraded_engine(path):
    engine = create_engine(f"sqlite:///{path}")
    with engine.begin() as connection:
        command.upgrade(db_module.alembic_config(connection), "head")
    return engine


def _schema(engine) -> dict:
    """Comparable per-table description: columns, PK, FKs, uniques, checks, indexes."""
    insp = inspect(engine)
    out = {}
    for table in sorted(set(insp.get_table_names()) - {"alembic_version"}):
        out[table] = {
            "columns": sorted(
                (c["name"], str(c["type"]), c["nullable"], str(c.get("default")))
                for c in insp.get_columns(table)
            ),
            "pk": sorted(insp.get_pk_constraint(table)["constrained_columns"]),
            "fks": sorted(
                (tuple(f["constrained_columns"]), f["referred_table"],
                 tuple(f["referred_columns"]), str(f.get("options")))
                for f in insp.get_foreign_keys(table)
            ),
            "uniques": sorted(
                (u["name"], tuple(u["column_names"]))
                for u in insp.get_unique_constraints(table)
            ),
            "checks": sorted(
                (c["name"], c["sqltext"]) for c in insp.get_check_constraints(table)
            ),
            "indexes": sorted(
                (i["name"], tuple(i["column_names"]), bool(i["unique"]))
                for i in insp.get_indexes(table)
            ),
        }
    return out


@pytest.fixture
def no_rebuild(monkeypatch):
    rebuilt = []
    monkeypatch.setattr(
        portfolio_engine, "rebuild", lambda session, pid: rebuilt.append(pid)
    )
    return rebuilt


def _point_db_module_at(monkeypatch, engine):
    monkeypatch.setattr(db_module, "engine", engine)
    monkeypatch.setattr(db_module, "SessionLocal", sessionmaker(bind=engine))


# --- Baseline <-> models ------------------------------------------------------


def test_autogenerate_diff_between_models_and_head_is_empty(tmp_path):
    """Fails when a model changes without a migration: run
    `alembic revision --autogenerate -m "..."` (see README)."""
    engine = _upgraded_engine(tmp_path / "head.db")
    with engine.connect() as connection:
        context = MigrationContext.configure(
            connection,
            opts={"compare_type": True, "compare_server_default": True},
        )
        diff = compare_metadata(context, Base.metadata)
    assert diff == []


def test_head_schema_equals_create_all_schema(tmp_path):
    """Autogenerate ignores some details (e.g. CHECK constraints); compare the
    reflected schema of an upgraded DB with one built by create_all."""
    migrated = _upgraded_engine(tmp_path / "head.db")
    created = create_engine(f"sqlite:///{tmp_path / 'create_all.db'}")
    db_module.import_models()
    Base.metadata.create_all(created)
    assert _schema(migrated) == _schema(created)
    assert set(_schema(migrated)) == set(Base.metadata.tables)


def test_downgrade_baseline_drops_everything(tmp_path):
    engine = _upgraded_engine(tmp_path / "head.db")
    with engine.begin() as connection:
        command.downgrade(db_module.alembic_config(connection), "base")
    assert set(inspect(engine).get_table_names()) <= {"alembic_version"}


# --- init_db() paths ----------------------------------------------------------


def test_init_db_fresh_database_upgrades_to_head(tmp_path, monkeypatch, no_rebuild):
    engine = create_engine(f"sqlite:///{tmp_path / 'fresh.db'}")
    _point_db_module_at(monkeypatch, engine)

    db_module.init_db()

    assert _version(engine) == _head()
    assert set(Base.metadata.tables) <= set(inspect(engine).get_table_names())
    db_module.init_db()  # managed path, no-op
    assert _version(engine) == _head()


def test_init_db_legacy_database_is_bridged_and_stamped(tmp_path, monkeypatch, no_rebuild):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE portfolios (id INTEGER PRIMARY KEY, user_id INTEGER, "
            "name VARCHAR NOT NULL, created_at DATETIME)"
        ))
        connection.execute(text(
            "CREATE TABLE holdings (id INTEGER PRIMARY KEY, portfolio_id INTEGER NOT NULL, "
            "ticker VARCHAR NOT NULL, shares FLOAT NOT NULL, cost_basis FLOAT NOT NULL, "
            "opened_at DATETIME)"
        ))
        connection.execute(text(
            "CREATE TABLE ocr_attempts (id INTEGER PRIMARY KEY, status VARCHAR(32))"
        ))
        connection.execute(text("INSERT INTO portfolios (id, name) VALUES (1, 'Main')"))
        connection.execute(text(
            "INSERT INTO holdings (id, portfolio_id, ticker, shares, cost_basis, opened_at) "
            "VALUES (7, 1, 'ABC', 10, 100, '2026-01-02 09:30:00')"
        ))
    _point_db_module_at(monkeypatch, engine)

    db_module.init_db()

    insp = inspect(engine)
    assert _version(engine) == _head()
    assert set(Base.metadata.tables) <= set(insp.get_table_names())
    assert "ledger_revision" in {c["name"] for c in insp.get_columns("portfolios")}
    assert "migrated_at" in {c["name"] for c in insp.get_columns("holdings")}
    assert "result_format" in {c["name"] for c in insp.get_columns("ocr_attempts")}
    with engine.connect() as connection:
        txs = connection.execute(text(
            "SELECT source, external_id FROM portfolio_transactions"
        )).all()
    assert txs == [("legacy_migration", "holding:7")]
    assert no_rebuild == [1]

    db_module.init_db()  # now managed: upgrade head no-op, holdings not re-migrated
    with engine.connect() as connection:
        assert connection.execute(text(
            "SELECT COUNT(*) FROM portfolio_transactions")).scalar() == 1
    assert _version(engine) == _head()


def test_init_db_treats_empty_alembic_version_as_legacy(tmp_path, monkeypatch, no_rebuild):
    engine = create_engine(f"sqlite:///{tmp_path / 'half.db'}")
    db_module.import_models()
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY)"
        ))
    _point_db_module_at(monkeypatch, engine)

    db_module.init_db()

    assert _version(engine) == _head()


# --- Real data (copy of the pre-v2 backup; never the live helix.db) -------------


def _row_counts(path) -> dict[str, int]:
    con = sqlite3.connect(path)
    try:
        tables = [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' AND name != 'alembic_version'"
        )]
        return {t: con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}
    finally:
        con.close()


@pytest.mark.skipif(not BACKUP_DB.exists(), reason="pre-v2 backup DB not present")
def test_init_db_on_copy_of_real_backup(tmp_path, monkeypatch, no_rebuild):
    copy = tmp_path / "helix-copy.db"
    shutil.copyfile(BACKUP_DB, copy)
    before = _row_counts(copy)
    engine = create_engine(f"sqlite:///{copy}")
    db_module.configure_sqlite_engine(engine)
    _point_db_module_at(monkeypatch, engine)

    db_module.init_db()
    db_module.init_db()

    assert _version(engine) == _head()
    after = _row_counts(copy)
    assert {t: after[t] for t in before} == before
    assert set(after) - set(before) <= set(Base.metadata.tables)
    engine.dispose()
