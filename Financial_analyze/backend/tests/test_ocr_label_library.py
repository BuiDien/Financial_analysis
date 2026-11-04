from app.services.ocr_label_library import (
    ObsidianLabelLibrary,
    normalize_label,
)


MARKDOWN = """| Label | Current |
| --- | ---: |
| TOTAL ASSETS | 100 |
| Cash | 40 |
| Inventory | 60 |"""


def _suggestion(result, label):
    return next(item for item in result["suggestions"] if item["current_label"] == label)


def test_normalizes_vietnamese_accents_and_spacing():
    assert normalize_label("  TÀI  SẢN  NGẮN-HẠN ") == "tai san ngan han"
    assert normalize_label("Tài sản ngắn hạn") == "tai san ngan han"


def test_records_unique_documents_and_returns_strong_quick_correct(tmp_path):
    library = ObsidianLabelLibrary(tmp_path / "vault", "Financial Analyze/Label Library")

    first = library.record_verified_page("balance_sheet", MARKDOWN, "a" * 64)
    repeated = library.record_verified_page("balance_sheet", MARKDOWN, "a" * 64)
    second = library.record_verified_page("balance_sheet", MARKDOWN, "b" * 64)
    third = library.record_verified_page("balance_sheet", MARKDOWN, "c" * 64)

    assert first["notes_updated"] == 3
    assert repeated["patterns_updated"] == 0
    assert second["patterns_updated"] == 3
    assert third["patterns_updated"] == 3

    result = library.suggest("balance_sheet", MARKDOWN)
    cash = _suggestion(result, "Cash")
    assert cash["suggested_level"] == 1
    assert cash["approval_count"] == 3
    assert cash["confidence"] == "strong"
    assert cash["match_score"] >= 70

    note = tmp_path / "vault/Financial Analyze/Label Library/balance_sheet/cash.md"
    assert note.is_file()
    assert "document_hash: a" + "a" * 63 in note.read_text(encoding="utf-8")


def test_keeps_context_patterns_separate(tmp_path):
    library = ObsidianLabelLibrary(tmp_path / "vault", "Financial Analyze/Label Library")
    first = """| Label | Current |
| --- | ---: |
| TOTAL ASSETS | 100 |
| Cash | 100 |"""
    second = """| Label | Current |
| --- | ---: |
| CURRENT ASSETS | 100 |
| Cash | 100 |"""

    library.record_verified_page("balance_sheet", first, "a" * 64)
    library.record_verified_page("balance_sheet", second, "b" * 64)

    note = tmp_path / "vault/Financial Analyze/Label Library/balance_sheet/cash.md"
    text = note.read_text(encoding="utf-8")
    assert "parent_label: TOTAL ASSETS" in text
    assert "parent_label: CURRENT ASSETS" in text


def test_classifies_known_obsidian_and_unknown_label_text(tmp_path):
    library = ObsidianLabelLibrary(
        tmp_path / "vault", "Financial Analyze/Label Library",
    )
    verified = """| Label | Current |
| --- | ---: |
| NỢ PHẢI TRẢ | 60 |"""
    library.record_verified_page("balance_sheet", verified, "a" * 64)

    exact = library.match_label_texts(verified)
    assert exact["known_count"] == 1
    assert exact["candidates"] == []

    accent_error = library.match_label_texts("""| Label | Current |
| --- | ---: |
| NƠ PHAI TRA | 60 |""")
    assert accent_error["candidate_count"] == 1
    assert accent_error["candidates"][0] == {
        "table": 1,
        "row": 2,
        "label": "NƠ PHAI TRA",
        "level": None,
        "source": "obsidian",
        "suggested_label": "NỢ PHẢI TRẢ",
        "confidence": "high",
    }

    unknown = library.match_label_texts("""| Label | Current |
| --- | ---: |
| LƠI NHUÂN SAU THUÊ | 40 |""")
    assert unknown["candidates"][0]["source"] == "ollama"
