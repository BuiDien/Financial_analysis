import pytest

from app.services.history_lines import LineCatalog, get_line_catalog
from app.services.ocr_label_library import LabelLibraryError

REL = "Financial Analyze/Line Catalog"


def label_alias(label, parent=None):
    from app.services.ocr_label_library import normalize_label
    return f"label:{normalize_label(parent or '')}>{normalize_label(label)}"


def test_new_line_then_match_by_label(tmp_path):
    cat = LineCatalog(tmp_path, REL)
    key = cat.add_line("MBB", "consolidated", "balance", "Tổng tài sản có", None,
                       [label_alias("TỔNG TÀI SẢN CÓ")])
    assert key.startswith("ln_") and len(key) == 15
    m = cat.match("MBB", "consolidated", "balance", "TONG TÀI SAN CÓ", None, None)
    assert m.key == key


def test_code_alias_wins_over_label(tmp_path):
    cat = LineCatalog(tmp_path, REL)
    a = cat.add_line("MBB", "consolidated", "balance", "A", None,
                     [label_alias("Foo"), "code:100"])
    b = cat.add_line("MBB", "consolidated", "balance", "B", None, [label_alias("Bar")])
    assert cat.match("MBB", "consolidated", "balance", "Bar", None, "100").key == a
    assert cat.match("MBB", "consolidated", "balance", "Bar", None, None).key == b


def test_same_label_different_parent_is_unknown(tmp_path):
    cat = LineCatalog(tmp_path, REL)
    k = cat.add_line("MBB", "consolidated", "balance", "Dự phòng rủi ro", None,
                     [label_alias("Dự phòng rủi ro", "Cho vay khách hàng")])
    m = cat.match("MBB", "consolidated", "balance", "Dự phòng rủi ro",
                  "Chứng khoán đầu tư", None)
    assert m.key is None
    assert k in [s[0] for s in m.suggestions]
    assert len(m.suggestions) <= 5
    # match never creates anything
    assert len(cat.lines("MBB", "consolidated", "balance")) == 1


def test_persists_to_obsidian_and_reloads(tmp_path):
    cat = LineCatalog(tmp_path, REL)
    k = cat.add_line("MBB", "consolidated", "balance", "Tổng tài sản", None, ["code:270"])
    note = tmp_path / REL / "MBB-consolidated-balance.md"
    assert note.read_text(encoding="utf-8").startswith("---\n")
    assert k in note.read_text(encoding="utf-8")
    other = LineCatalog(tmp_path, REL)
    line = other.get("MBB", "consolidated", "balance", k)
    assert line.name == "Tổng tài sản" and "code:270" in line.aliases
    other.add_alias("MBB", "consolidated", "balance", k, "code:271")
    assert "code:271" in cat.get("MBB", "consolidated", "balance", k).aliases  # mtime refresh


def test_scopes_are_separate(tmp_path):
    cat = LineCatalog(tmp_path, REL)
    cat.add_line("MBB", "consolidated", "balance", "X", None, [label_alias("X")])
    assert cat.match("MBB", "separate", "balance", "X", None, None).key is None
    assert cat.lines("MBB", "separate", "balance") == []


def test_unsafe_names_rejected(tmp_path):
    cat = LineCatalog(tmp_path, REL)
    for bad in ("../x", "a/b", ""):
        with pytest.raises(LabelLibraryError):
            cat.lines(bad, "consolidated", "balance")
        with pytest.raises(LabelLibraryError):
            cat.lines("MBB", bad, "balance")
        with pytest.raises(LabelLibraryError):
            cat.lines("MBB", "consolidated", bad)
    with pytest.raises(LabelLibraryError):
        LineCatalog(tmp_path, "../out")


def test_add_alias_unknown_key_and_cached_factory(tmp_path):
    cat = LineCatalog(tmp_path, REL)
    with pytest.raises(LabelLibraryError):
        cat.add_alias("MBB", "consolidated", "balance", "ln_nope", "code:1")
    assert get_line_catalog(str(tmp_path), REL) is get_line_catalog(str(tmp_path), REL)
    with pytest.raises(LabelLibraryError):
        get_line_catalog("  ", REL)
