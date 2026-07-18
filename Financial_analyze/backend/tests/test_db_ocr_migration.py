from sqlalchemy import create_engine, inspect, text

from app import db as db_module


def test_legacy_ocr_schema_upgrade_is_additive_and_idempotent(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE ocr_attempts (id INTEGER PRIMARY KEY, status VARCHAR(32))"
        ))
        connection.execute(text(
            "CREATE TABLE ocr_review_jobs (id INTEGER PRIMARY KEY, status VARCHAR(32))"
        ))
    monkeypatch.setattr(db_module, "engine", engine)

    db_module._upgrade_legacy_ocr_schema()
    db_module._upgrade_legacy_ocr_schema()

    attempt_columns = {
        column["name"] for column in inspect(engine).get_columns("ocr_attempts")
    }
    review_columns = {
        column["name"] for column in inspect(engine).get_columns("ocr_review_jobs")
    }
    assert {
        "result_format", "expected_pages", "received_pages", "merged_markdown",
        "result_sha256",
    } <= attempt_columns
    assert "result_format" in review_columns
