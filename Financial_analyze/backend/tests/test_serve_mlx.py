import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).parents[2] / "scripts"


def _load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


s = _load("serve_mlx")
t = _load("ocr_selftest")


def test_strip_stray_think_removes_unclosed_leading_tag():
    assert s.strip_stray_think("<think>\n\n### CỘNG HOÀ") == "### CỘNG HOÀ"


def test_strip_stray_think_keeps_closed_block():
    assert s.strip_stray_think("<think>r</think>\n\nx") == "<think>r</think>\n\nx"


def test_strip_stray_think_keeps_plain_text():
    assert s.strip_stray_think("plain") == "plain"


def test_patch_model_config(tmp_path):
    (tmp_path / "config.json").write_text(json.dumps(
        {"model_type": "minicpm_ocr", "vision_config": {"model_type": "minicpm_ocr_vision"}}))
    (tmp_path / "generation_config.json").write_text(json.dumps({"eos_token_id": [248044, 248046]}))
    assert s.patch_model_config(tmp_path) is True
    cfg = json.loads((tmp_path / "config.json").read_text())
    assert cfg["model_type"] == "minicpmv4_6"
    assert cfg["vision_config"]["model_type"] == "minicpmv4_6_vision"
    assert cfg["eos_token_id"] == [248044, 248046]
    assert json.loads((tmp_path / "config.orig.json").read_text())["model_type"] == "minicpm_ocr"
    assert s.patch_model_config(tmp_path) is False
    assert json.loads((tmp_path / "config.orig.json").read_text())["model_type"] == "minicpm_ocr"


def test_serve_mlx_imports_without_mlx():
    assert "mlx_vlm" not in sys.modules


def test_selftest_accepts_expected_text():
    t.check_selftest_text("### CỘNG HOÀ XÃ HỘI CHỦ NGHĨA VIỆT NAM\nĐộc lập")


def test_selftest_accepts_chu_variant():
    t.check_selftest_text("### CỘNG HOÀ XÃ HỘI CHỮ NGHĨA VIỆT NAM")


def test_selftest_accepts_hoa_variant_and_case():
    t.check_selftest_text("cộng hòa xã hội chủ nghĩa việt nam")


def test_selftest_rejects_empty():
    with pytest.raises(RuntimeError, match="empty"):
        t.check_selftest_text("  ")


def test_selftest_rejects_wrong_text():
    with pytest.raises(RuntimeError, match="expected"):
        t.check_selftest_text("imatedo:\nMB")


def test_patch_config_only_patches_and_exits(tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"model_type": "minicpm_ocr"}))
    assert s.main(["--model-dir", str(tmp_path), "--patch-config-only"]) == 0
    assert json.loads((tmp_path / "config.json").read_text())["model_type"] == "minicpmv4_6"
