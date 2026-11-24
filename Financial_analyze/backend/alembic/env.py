"""Alembic environment.

Connection source, in priority order:
1. ``config.attributes["connection"]`` — set by ``app.db.init_db()`` so startup
   migrations run on the app's own engine (WAL/busy-timeout pragmas included).
2. ``sqlalchemy.url`` set on the Config (tests).
3. ``app.config`` settings ``database_url`` (CLI: honours DATABASE_URL / .env).
"""

from alembic import context
from sqlalchemy import create_engine, pool

from app.db import Base, configure_sqlite_engine, import_models
from app.config import get_settings

config = context.config
import_models()
target_metadata = Base.metadata

if config.config_file_name is not None and not config.attributes.get("connection"):
    from logging.config import fileConfig

    fileConfig(config.config_file_name, disable_existing_loggers=False)


def _url() -> str:
    return config.get_main_option("sqlalchemy.url") or get_settings().database_url


def _configure(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,  # SQLite cannot ALTER most things; batch = copy-and-swap
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_offline() -> None:
    context.configure(
        url=_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connection = config.attributes.get("connection")
    if connection is not None:
        _configure(connection)
        return
    engine = create_engine(_url(), poolclass=pool.NullPool)
    configure_sqlite_engine(engine)
    with engine.connect() as connection:
        _configure(connection)


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
