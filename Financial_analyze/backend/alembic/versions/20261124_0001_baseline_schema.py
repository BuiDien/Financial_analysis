"""baseline schema

Full schema as of the v2 refactor (every model in app/models). Pre-Alembic
databases are not upgraded through this revision: app.db.init_db() brings
them up with the legacy bridge and stamps them instead.

Revision ID: 0001
Revises:
Create Date: 2026-11-24 07:20:45.168902

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('company_names',
    sa.Column('symbol', sa.String(length=16), nullable=False),
    sa.Column('official_name', sa.String(), nullable=False),
    sa.Column('fetched_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
    sa.PrimaryKeyConstraint('symbol')
    )
    op.create_table('filings',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=True),
    sa.Column('ticker', sa.String(), nullable=False),
    sa.Column('filing_type', sa.String(), nullable=False),
    sa.Column('period', sa.String(), nullable=False),
    sa.Column('filename', sa.String(), nullable=False),
    sa.Column('storage_path', sa.String(), nullable=False),
    sa.Column('size_bytes', sa.Integer(), nullable=True),
    sa.Column('pages', sa.Integer(), nullable=True),
    sa.Column('status', sa.String(), nullable=True),
    sa.Column('extracted', sa.JSON(), nullable=True),
    sa.Column('analysis', sa.Text(), nullable=True),
    sa.Column('tracker', sa.JSON(), nullable=True),
    sa.Column('uploaded_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('filings', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_filings_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_filings_ticker'), ['ticker'], unique=False)
        batch_op.create_index(batch_op.f('ix_filings_user_id'), ['user_id'], unique=False)

    op.create_table('gmail_config',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('address', sa.String(), nullable=True),
    sa.Column('query', sa.Text(), nullable=True),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('interval_minutes', sa.Integer(), nullable=False),
    sa.Column('last_checked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_status', sa.String(), nullable=True),
    sa.Column('last_error', sa.Text(), nullable=True),
    sa.Column('last_summary', sa.JSON(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('gmail_reports',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('gm_msgid', sa.String(), nullable=False),
    sa.Column('received_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('sender', sa.String(), nullable=True),
    sa.Column('subject', sa.Text(), nullable=True),
    sa.Column('status', sa.String(), nullable=False),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('attachments', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('gmail_reports', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_gmail_reports_gm_msgid'), ['gm_msgid'], unique=True)
        batch_op.create_index(batch_op.f('ix_gmail_reports_id'), ['id'], unique=False)

    op.create_table('news_alerts',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('ticker', sa.String(length=16), nullable=True),
    sa.Column('alert_date', sa.Date(), nullable=False),
    sa.Column('episode_open', sa.Boolean(), nullable=False),
    sa.Column('verdict', sa.String(length=16), nullable=False),
    sa.Column('message', sa.Text(), nullable=False),
    sa.Column('facts', sa.JSON(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('news_alerts', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_news_alerts_alert_date'), ['alert_date'], unique=False)
        batch_op.create_index(batch_op.f('ix_news_alerts_ticker'), ['ticker'], unique=False)

    op.create_table('portfolio_market_data',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=12), nullable=False),
    sa.Column('key', sa.String(length=80), nullable=False),
    sa.Column('date', sa.Date(), nullable=False),
    sa.Column('value', sa.Numeric(precision=28, scale=8), nullable=False),
    sa.Column('provider', sa.String(length=32), nullable=False),
    sa.Column('fetched_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('kind', 'key', 'date', name='uq_portfolio_market_point')
    )
    op.create_table('screener_state',
    sa.Column('key', sa.String(), nullable=False),
    sa.Column('value', sa.JSON(), nullable=True),
    sa.PrimaryKeyConstraint('key')
    )
    op.create_table('screener_strategies',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(), nullable=False),
    sa.Column('starter_key', sa.String(), nullable=True),
    sa.Column('rules', sa.JSON(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name')
    )
    op.create_table('ticker_metrics',
    sa.Column('symbol', sa.String(), nullable=False),
    sa.Column('exchange', sa.String(), nullable=False),
    sa.Column('industry', sa.String(), nullable=True),
    sa.Column('is_bank', sa.Boolean(), nullable=False),
    sa.Column('financials', sa.JSON(), nullable=True),
    sa.Column('financials_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('prices', sa.JSON(), nullable=True),
    sa.Column('prices_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_error', sa.String(), nullable=True),
    sa.Column('board', sa.JSON(), nullable=True),
    sa.PrimaryKeyConstraint('symbol')
    )
    op.create_table('ticker_notes',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('symbol', sa.String(), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('ticker_notes', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_ticker_notes_symbol'), ['symbol'], unique=False)

    op.create_table('users',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('email', sa.String(), nullable=False),
    sa.Column('hashed_password', sa.String(), nullable=False),
    sa.Column('name', sa.String(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_users_email'), ['email'], unique=True)
        batch_op.create_index(batch_op.f('ix_users_id'), ['id'], unique=False)

    op.create_table('ocr_inbox_items',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('filename', sa.String(length=255), nullable=False),
    sa.Column('storage_path', sa.String(length=1024), nullable=False),
    sa.Column('size_bytes', sa.Integer(), nullable=False),
    sa.Column('pages', sa.Integer(), nullable=False),
    sa.Column('checksum_sha256', sa.String(length=64), nullable=False),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('company', sa.String(length=160), nullable=True),
    sa.Column('ticker', sa.String(length=20), nullable=True),
    sa.Column('filing_type', sa.String(length=80), nullable=True),
    sa.Column('period', sa.String(length=80), nullable=True),
    sa.Column('currency', sa.String(length=12), nullable=True),
    sa.Column('unit', sa.String(length=40), nullable=True),
    sa.Column('scope', sa.String(length=16), nullable=True),
    sa.Column('fiscal_year', sa.Integer(), nullable=True),
    sa.Column('period_code', sa.String(length=4), nullable=True),
    sa.Column('published_filing_id', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.ForeignKeyConstraint(['published_filing_id'], ['filings.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('published_filing_id'),
    sa.UniqueConstraint('storage_path')
    )
    with op.batch_alter_table('ocr_inbox_items', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_ocr_inbox_items_checksum_sha256'), ['checksum_sha256'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_inbox_items_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_inbox_items_status'), ['status'], unique=False)

    op.create_table('portfolios',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=True),
    sa.Column('name', sa.String(), nullable=True),
    sa.Column('display_currency', sa.String(length=3), nullable=False),
    sa.Column('ledger_revision', sa.Integer(), nullable=False),
    sa.Column('projection_revision', sa.Integer(), nullable=False),
    sa.Column('projection_status', sa.String(length=24), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('portfolios', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_portfolios_id'), ['id'], unique=False)

    op.create_table('holdings',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('portfolio_id', sa.Integer(), nullable=False),
    sa.Column('ticker', sa.String(), nullable=False),
    sa.Column('shares', sa.Numeric(precision=28, scale=10), nullable=False),
    sa.Column('cost_basis', sa.Numeric(precision=28, scale=8), nullable=False),
    sa.Column('opened_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
    sa.Column('migrated_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['portfolio_id'], ['portfolios.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('holdings', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_holdings_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_holdings_ticker'), ['ticker'], unique=False)

    op.create_table('ocr_attempts',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('inbox_item_id', sa.Integer(), nullable=False),
    sa.Column('parent_attempt_id', sa.Integer(), nullable=True),
    sa.Column('job_id', sa.String(length=64), nullable=True),
    sa.Column('worker_id', sa.String(length=64), nullable=True),
    sa.Column('worker_name', sa.String(length=160), nullable=True),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('progress', sa.Integer(), nullable=False),
    sa.Column('schema_version', sa.Integer(), nullable=True),
    sa.Column('result_format', sa.String(length=40), nullable=False),
    sa.Column('expected_pages', sa.Integer(), nullable=True),
    sa.Column('received_pages', sa.Integer(), nullable=False),
    sa.Column('merged_markdown', sa.Text(), nullable=True),
    sa.Column('result_sha256', sa.String(length=64), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('automatic', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['inbox_item_id'], ['ocr_inbox_items.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['parent_attempt_id'], ['ocr_attempts.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('ocr_attempts', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_ocr_attempts_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_attempts_inbox_item_id'), ['inbox_item_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_attempts_job_id'), ['job_id'], unique=True)
        batch_op.create_index(batch_op.f('ix_ocr_attempts_status'), ['status'], unique=False)

    op.create_table('portfolio_cash_projections',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('portfolio_id', sa.Integer(), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('balance', sa.Numeric(precision=28, scale=8), nullable=False),
    sa.Column('revision', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['portfolio_id'], ['portfolios.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('portfolio_id', 'currency', name='uq_portfolio_cash')
    )
    with op.batch_alter_table('portfolio_cash_projections', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_portfolio_cash_projections_portfolio_id'), ['portfolio_id'], unique=False)

    op.create_table('portfolio_daily_snapshots',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('portfolio_id', sa.Integer(), nullable=False),
    sa.Column('date', sa.Date(), nullable=False),
    sa.Column('display_currency', sa.String(length=3), nullable=False),
    sa.Column('value', sa.Numeric(precision=28, scale=8), nullable=False),
    sa.Column('net_flow', sa.Numeric(precision=28, scale=8), nullable=False),
    sa.Column('twr', sa.Numeric(precision=20, scale=12), nullable=False),
    sa.Column('revision', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['portfolio_id'], ['portfolios.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('portfolio_id', 'date', 'display_currency', name='uq_portfolio_daily_snapshot')
    )
    with op.batch_alter_table('portfolio_daily_snapshots', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_portfolio_daily_snapshots_portfolio_id'), ['portfolio_id'], unique=False)

    op.create_table('portfolio_jobs',
    sa.Column('id', sa.String(length=48), nullable=False),
    sa.Column('portfolio_id', sa.Integer(), nullable=False),
    sa.Column('type', sa.String(length=24), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('progress', sa.Integer(), nullable=False),
    sa.Column('payload', sa.Text(), nullable=True),
    sa.Column('result', sa.Text(), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['portfolio_id'], ['portfolios.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('portfolio_jobs', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_portfolio_jobs_portfolio_id'), ['portfolio_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_portfolio_jobs_status'), ['status'], unique=False)

    op.create_table('portfolio_position_projections',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('portfolio_id', sa.Integer(), nullable=False),
    sa.Column('ticker', sa.String(length=32), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('quantity', sa.Numeric(precision=28, scale=10), nullable=False),
    sa.Column('cost_basis_native', sa.Numeric(precision=28, scale=8), nullable=False),
    sa.Column('cost_basis_display', sa.Numeric(precision=28, scale=8), nullable=False),
    sa.Column('revision', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['portfolio_id'], ['portfolios.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('portfolio_id', 'ticker', 'currency', name='uq_portfolio_position')
    )
    with op.batch_alter_table('portfolio_position_projections', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_portfolio_position_projections_portfolio_id'), ['portfolio_id'], unique=False)

    op.create_table('portfolio_projection_summaries',
    sa.Column('portfolio_id', sa.Integer(), nullable=False),
    sa.Column('display_currency', sa.String(length=3), nullable=False),
    sa.Column('realized_gain', sa.Numeric(precision=28, scale=8), nullable=False),
    sa.Column('income', sa.Numeric(precision=28, scale=8), nullable=False),
    sa.Column('net_contributions', sa.Numeric(precision=28, scale=8), nullable=False),
    sa.Column('revision', sa.Integer(), nullable=False),
    sa.Column('calculated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
    sa.ForeignKeyConstraint(['portfolio_id'], ['portfolios.id'], ),
    sa.PrimaryKeyConstraint('portfolio_id')
    )
    op.create_table('portfolio_transactions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('portfolio_id', sa.Integer(), nullable=False),
    sa.Column('type', sa.String(length=16), nullable=False),
    sa.Column('effective_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('ticker', sa.String(length=32), nullable=True),
    sa.Column('quantity', sa.Numeric(precision=28, scale=10), nullable=True),
    sa.Column('unit_price', sa.Numeric(precision=28, scale=8), nullable=True),
    sa.Column('cash_amount', sa.Numeric(precision=28, scale=8), nullable=True),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('fees', sa.Numeric(precision=28, scale=8), nullable=False),
    sa.Column('taxes', sa.Numeric(precision=28, scale=8), nullable=False),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('source', sa.String(length=32), nullable=False),
    sa.Column('external_id', sa.String(length=160), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('replaces_transaction_id', sa.Integer(), nullable=True),
    sa.Column('currency_assumed', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
    sa.Column('voided_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['portfolio_id'], ['portfolios.id'], ),
    sa.ForeignKeyConstraint(['replaces_transaction_id'], ['portfolio_transactions.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('portfolio_id', 'source', 'external_id', name='uq_portfolio_import_external')
    )
    with op.batch_alter_table('portfolio_transactions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_portfolio_transactions_currency'), ['currency'], unique=False)
        batch_op.create_index(batch_op.f('ix_portfolio_transactions_effective_at'), ['effective_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_portfolio_transactions_portfolio_id'), ['portfolio_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_portfolio_transactions_status'), ['status'], unique=False)
        batch_op.create_index(batch_op.f('ix_portfolio_transactions_ticker'), ['ticker'], unique=False)
        batch_op.create_index(batch_op.f('ix_portfolio_transactions_type'), ['type'], unique=False)

    op.create_table('statement_facts',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('inbox_item_id', sa.Integer(), nullable=False),
    sa.Column('review_id', sa.Integer(), nullable=True),
    sa.Column('review_revision', sa.Integer(), nullable=True),
    sa.Column('ticker', sa.String(length=20), nullable=False),
    sa.Column('scope', sa.String(length=16), nullable=False),
    sa.Column('statement_kind', sa.String(length=16), nullable=False),
    sa.Column('line_key', sa.String(length=80), nullable=False),
    sa.Column('fact_key', sa.String(length=255), nullable=False),
    sa.Column('period_type', sa.String(length=16), nullable=False),
    sa.Column('period_start', sa.Date(), nullable=True),
    sa.Column('period_end', sa.Date(), nullable=False),
    sa.Column('value', sa.BigInteger(), nullable=False),
    sa.Column('origin', sa.String(length=16), nullable=False),
    sa.Column('page_number', sa.Integer(), nullable=True),
    sa.Column('table_number', sa.Integer(), nullable=True),
    sa.Column('row_number', sa.Integer(), nullable=True),
    sa.Column('column_number', sa.Integer(), nullable=True),
    sa.Column('row_label', sa.Text(), nullable=True),
    sa.Column('raw_text', sa.Text(), nullable=True),
    sa.Column('raw_unit', sa.String(length=40), nullable=True),
    sa.Column('inputs', sa.JSON(), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.ForeignKeyConstraint(['inbox_item_id'], ['ocr_inbox_items.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('statement_facts', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_statement_facts_fact_key'), ['fact_key'], unique=False)
        batch_op.create_index(batch_op.f('ix_statement_facts_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_statement_facts_inbox_item_id'), ['inbox_item_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_statement_facts_status'), ['status'], unique=False)

    op.create_table('fact_resolutions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('ticker', sa.String(length=20), nullable=False),
    sa.Column('scope', sa.String(length=16), nullable=False),
    sa.Column('statement_kind', sa.String(length=16), nullable=False),
    sa.Column('fact_key', sa.String(length=255), nullable=False),
    sa.Column('chosen_fact_id', sa.Integer(), nullable=True),
    sa.Column('chosen_value', sa.BigInteger(), nullable=False),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('resolved_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.ForeignKeyConstraint(['chosen_fact_id'], ['statement_facts.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('ticker', 'scope', 'statement_kind', 'fact_key', name='uq_fact_resolution_key')
    )
    with op.batch_alter_table('fact_resolutions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_fact_resolutions_id'), ['id'], unique=False)

    op.create_table('ocr_page_results',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('attempt_id', sa.Integer(), nullable=False),
    sa.Column('page_number', sa.Integer(), nullable=False),
    sa.Column('raw_markdown', sa.Text(), nullable=False),
    sa.Column('reviewed_markdown', sa.Text(), nullable=True),
    sa.Column('review_status', sa.String(length=32), nullable=False),
    sa.Column('content_sha256', sa.String(length=64), nullable=False),
    sa.Column('byte_size', sa.Integer(), nullable=False),
    sa.Column('label_check_status', sa.String(length=24), nullable=False),
    sa.Column('label_check_summary', sa.JSON(), nullable=True),
    sa.Column('label_check_error', sa.Text(), nullable=True),
    sa.Column('label_checked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.CheckConstraint('byte_size >= 0', name='ck_ocr_page_byte_size_nonnegative'),
    sa.CheckConstraint('page_number >= 1', name='ck_ocr_page_number_positive'),
    sa.ForeignKeyConstraint(['attempt_id'], ['ocr_attempts.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('attempt_id', 'page_number', name='uq_ocr_page_attempt_page')
    )
    with op.batch_alter_table('ocr_page_results', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_ocr_page_results_attempt_id'), ['attempt_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_page_results_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_page_results_label_check_status'), ['label_check_status'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_page_results_review_status'), ['review_status'], unique=False)

    op.create_table('ocr_review_jobs',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('inbox_item_id', sa.Integer(), nullable=False),
    sa.Column('attempt_id', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('revision', sa.Integer(), nullable=False),
    sa.Column('schema_version', sa.Integer(), nullable=False),
    sa.Column('result_format', sa.String(length=40), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.Column('verified_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('published_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['attempt_id'], ['ocr_attempts.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['inbox_item_id'], ['ocr_inbox_items.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('attempt_id')
    )
    with op.batch_alter_table('ocr_review_jobs', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_ocr_review_jobs_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_review_jobs_inbox_item_id'), ['inbox_item_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_review_jobs_status'), ['status'], unique=False)

    op.create_table('ocr_label_review_runs',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('review_id', sa.Integer(), nullable=False),
    sa.Column('page_number', sa.Integer(), nullable=False),
    sa.Column('base_revision', sa.Integer(), nullable=False),
    sa.Column('page_content_sha256', sa.String(length=64), nullable=False),
    sa.Column('status', sa.String(length=24), nullable=False),
    sa.Column('trigger', sa.String(length=24), nullable=False),
    sa.Column('skill_name', sa.String(length=80), nullable=False),
    sa.Column('skill_version', sa.String(length=24), nullable=False),
    sa.Column('model', sa.String(length=120), nullable=True),
    sa.Column('requested_rows', sa.JSON(), nullable=True),
    sa.Column('current_table_number', sa.Integer(), nullable=True),
    sa.Column('current_row_number', sa.Integer(), nullable=True),
    sa.Column('processed_count', sa.Integer(), nullable=False),
    sa.Column('tool_call_count', sa.Integer(), nullable=False),
    sa.Column('input_token_count', sa.Integer(), nullable=True),
    sa.Column('output_token_count', sa.Integer(), nullable=True),
    sa.Column('duration_ms', sa.Integer(), nullable=True),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint('page_number >= 1', name='ck_ocr_label_run_page_positive'),
    sa.ForeignKeyConstraint(['review_id'], ['ocr_review_jobs.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('ocr_label_review_runs', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_ocr_label_review_runs_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_label_review_runs_review_id'), ['review_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_label_review_runs_status'), ['status'], unique=False)

    op.create_table('ocr_review_rows',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('review_id', sa.Integer(), nullable=False),
    sa.Column('source_index', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('raw_data', sa.JSON(), nullable=False),
    sa.Column('reviewed_data', sa.JSON(), nullable=True),
    sa.Column('page', sa.Integer(), nullable=False),
    sa.Column('bbox', sa.JSON(), nullable=False),
    sa.Column('confidence', sa.Integer(), nullable=False),
    sa.Column('rejection_reason', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.ForeignKeyConstraint(['review_id'], ['ocr_review_jobs.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('review_id', 'source_index', name='uq_ocr_review_source_index')
    )
    with op.batch_alter_table('ocr_review_rows', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_ocr_review_rows_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_review_rows_review_id'), ['review_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_review_rows_status'), ['status'], unique=False)

    op.create_table('ocr_audit_events',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('review_id', sa.Integer(), nullable=False),
    sa.Column('row_id', sa.Integer(), nullable=True),
    sa.Column('action', sa.String(length=40), nullable=False),
    sa.Column('actor', sa.String(length=120), nullable=False),
    sa.Column('revision', sa.Integer(), nullable=False),
    sa.Column('before_data', sa.JSON(), nullable=True),
    sa.Column('after_data', sa.JSON(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.ForeignKeyConstraint(['review_id'], ['ocr_review_jobs.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['row_id'], ['ocr_review_rows.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('ocr_audit_events', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_ocr_audit_events_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_audit_events_review_id'), ['review_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_audit_events_row_id'), ['row_id'], unique=False)

    op.create_table('ocr_label_suggestions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('run_id', sa.Integer(), nullable=False),
    sa.Column('table_number', sa.Integer(), nullable=False),
    sa.Column('row_number', sa.Integer(), nullable=False),
    sa.Column('label_cell_hash', sa.String(length=64), nullable=False),
    sa.Column('current_label', sa.Text(), nullable=False),
    sa.Column('suggested_label', sa.Text(), nullable=True),
    sa.Column('current_level', sa.Integer(), nullable=True),
    sa.Column('suggested_level', sa.Integer(), nullable=False),
    sa.Column('confidence', sa.String(length=12), nullable=False),
    sa.Column('reason_codes', sa.JSON(), nullable=False),
    sa.Column('evidence', sa.JSON(), nullable=False),
    sa.Column('explanation', sa.Text(), nullable=False),
    sa.Column('visual_confirmation_required', sa.Integer(), nullable=False),
    sa.Column('decision', sa.String(length=16), nullable=False),
    sa.Column('user_edited_level', sa.Integer(), nullable=True),
    sa.Column('applied_revision', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
    sa.CheckConstraint('current_level IS NULL OR current_level BETWEEN -1 AND 3', name='ck_ocr_label_suggestion_current_level'),
    sa.CheckConstraint('suggested_level BETWEEN -1 AND 3', name='ck_ocr_label_suggestion_suggested_level'),
    sa.CheckConstraint('user_edited_level IS NULL OR user_edited_level BETWEEN -1 AND 3', name='ck_ocr_label_suggestion_user_level'),
    sa.ForeignKeyConstraint(['run_id'], ['ocr_label_review_runs.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('run_id', 'table_number', 'row_number', name='uq_ocr_label_suggestion_run_row')
    )
    with op.batch_alter_table('ocr_label_suggestions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_ocr_label_suggestions_decision'), ['decision'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_label_suggestions_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ocr_label_suggestions_run_id'), ['run_id'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('ocr_label_suggestions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_ocr_label_suggestions_run_id'))
        batch_op.drop_index(batch_op.f('ix_ocr_label_suggestions_id'))
        batch_op.drop_index(batch_op.f('ix_ocr_label_suggestions_decision'))

    op.drop_table('ocr_label_suggestions')
    with op.batch_alter_table('ocr_audit_events', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_ocr_audit_events_row_id'))
        batch_op.drop_index(batch_op.f('ix_ocr_audit_events_review_id'))
        batch_op.drop_index(batch_op.f('ix_ocr_audit_events_id'))

    op.drop_table('ocr_audit_events')
    with op.batch_alter_table('ocr_review_rows', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_ocr_review_rows_status'))
        batch_op.drop_index(batch_op.f('ix_ocr_review_rows_review_id'))
        batch_op.drop_index(batch_op.f('ix_ocr_review_rows_id'))

    op.drop_table('ocr_review_rows')
    with op.batch_alter_table('ocr_label_review_runs', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_ocr_label_review_runs_status'))
        batch_op.drop_index(batch_op.f('ix_ocr_label_review_runs_review_id'))
        batch_op.drop_index(batch_op.f('ix_ocr_label_review_runs_id'))

    op.drop_table('ocr_label_review_runs')
    with op.batch_alter_table('ocr_review_jobs', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_ocr_review_jobs_status'))
        batch_op.drop_index(batch_op.f('ix_ocr_review_jobs_inbox_item_id'))
        batch_op.drop_index(batch_op.f('ix_ocr_review_jobs_id'))

    op.drop_table('ocr_review_jobs')
    with op.batch_alter_table('ocr_page_results', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_ocr_page_results_review_status'))
        batch_op.drop_index(batch_op.f('ix_ocr_page_results_label_check_status'))
        batch_op.drop_index(batch_op.f('ix_ocr_page_results_id'))
        batch_op.drop_index(batch_op.f('ix_ocr_page_results_attempt_id'))

    op.drop_table('ocr_page_results')
    with op.batch_alter_table('fact_resolutions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_fact_resolutions_id'))

    op.drop_table('fact_resolutions')
    with op.batch_alter_table('statement_facts', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_statement_facts_status'))
        batch_op.drop_index(batch_op.f('ix_statement_facts_inbox_item_id'))
        batch_op.drop_index(batch_op.f('ix_statement_facts_id'))
        batch_op.drop_index(batch_op.f('ix_statement_facts_fact_key'))

    op.drop_table('statement_facts')
    with op.batch_alter_table('portfolio_transactions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_portfolio_transactions_type'))
        batch_op.drop_index(batch_op.f('ix_portfolio_transactions_ticker'))
        batch_op.drop_index(batch_op.f('ix_portfolio_transactions_status'))
        batch_op.drop_index(batch_op.f('ix_portfolio_transactions_portfolio_id'))
        batch_op.drop_index(batch_op.f('ix_portfolio_transactions_effective_at'))
        batch_op.drop_index(batch_op.f('ix_portfolio_transactions_currency'))

    op.drop_table('portfolio_transactions')
    op.drop_table('portfolio_projection_summaries')
    with op.batch_alter_table('portfolio_position_projections', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_portfolio_position_projections_portfolio_id'))

    op.drop_table('portfolio_position_projections')
    with op.batch_alter_table('portfolio_jobs', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_portfolio_jobs_status'))
        batch_op.drop_index(batch_op.f('ix_portfolio_jobs_portfolio_id'))

    op.drop_table('portfolio_jobs')
    with op.batch_alter_table('portfolio_daily_snapshots', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_portfolio_daily_snapshots_portfolio_id'))

    op.drop_table('portfolio_daily_snapshots')
    with op.batch_alter_table('portfolio_cash_projections', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_portfolio_cash_projections_portfolio_id'))

    op.drop_table('portfolio_cash_projections')
    with op.batch_alter_table('ocr_attempts', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_ocr_attempts_status'))
        batch_op.drop_index(batch_op.f('ix_ocr_attempts_job_id'))
        batch_op.drop_index(batch_op.f('ix_ocr_attempts_inbox_item_id'))
        batch_op.drop_index(batch_op.f('ix_ocr_attempts_id'))

    op.drop_table('ocr_attempts')
    with op.batch_alter_table('holdings', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_holdings_ticker'))
        batch_op.drop_index(batch_op.f('ix_holdings_id'))

    op.drop_table('holdings')
    with op.batch_alter_table('portfolios', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_portfolios_id'))

    op.drop_table('portfolios')
    with op.batch_alter_table('ocr_inbox_items', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_ocr_inbox_items_status'))
        batch_op.drop_index(batch_op.f('ix_ocr_inbox_items_id'))
        batch_op.drop_index(batch_op.f('ix_ocr_inbox_items_checksum_sha256'))

    op.drop_table('ocr_inbox_items')
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_users_id'))
        batch_op.drop_index(batch_op.f('ix_users_email'))

    op.drop_table('users')
    with op.batch_alter_table('ticker_notes', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_ticker_notes_symbol'))

    op.drop_table('ticker_notes')
    op.drop_table('ticker_metrics')
    op.drop_table('screener_strategies')
    op.drop_table('screener_state')
    op.drop_table('portfolio_market_data')
    with op.batch_alter_table('news_alerts', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_news_alerts_ticker'))
        batch_op.drop_index(batch_op.f('ix_news_alerts_alert_date'))

    op.drop_table('news_alerts')
    with op.batch_alter_table('gmail_reports', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_gmail_reports_id'))
        batch_op.drop_index(batch_op.f('ix_gmail_reports_gm_msgid'))

    op.drop_table('gmail_reports')
    op.drop_table('gmail_config')
    with op.batch_alter_table('filings', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_filings_user_id'))
        batch_op.drop_index(batch_op.f('ix_filings_ticker'))
        batch_op.drop_index(batch_op.f('ix_filings_id'))

    op.drop_table('filings')
    op.drop_table('company_names')
