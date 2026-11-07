import asyncio
import importlib.util
import os
import stat
import sys
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).parents[2] / "scripts" / "ocr_mac_pages.py"
SPEC = importlib.util.spec_from_file_location("ocr_mac_pages", MODULE_PATH)
m = importlib.util.module_from_spec(SPEC)
sys.modules["ocr_mac_pages"] = m
SPEC.loader.exec_module(m)

M = "<!-- M -->"
cfg = m.OCRConfig(sdk_bin=Path("/v/bin/minicpmvocr"), ocr_url="http://127.0.0.1:18499",
                  model="/h/minicpm-ocr-1.0", ocr_home=Path("/h"))


def test_build_parse_command_pins_flags(tmp_path):
    cmd = m.build_parse_command(cfg, tmp_path / "in.pdf", tmp_path / "out.md", M)
    assert cmd[:2] == ["/v/bin/minicpmvocr", "parse"]
    for pair in (["--backend", "openai"], ["--server-url", "http://127.0.0.1:18499"],
                 ["--model", "/h/minicpm-ocr-1.0"], ["--device", "cpu"], ["--workers", "1"],
                 ["--page-delimiter", M], ["--layout-model", "/h/PP-DocLayoutV3_infer"],
                 ["--input", str(tmp_path / "in.pdf")], ["--output", str(tmp_path / "out.md")]):
        i = cmd.index(pair[0])
        assert cmd[i:i + 2] == pair
    assert "engine.max_model_len=40960" in cmd
    assert "pipeline.merge_cross_page_tables=false" in cmd
    assert "--no-merge-pages" not in cmd


def test_parse_env_is_local_only(tmp_path):
    env = m.parse_env(cfg, tmp_path)
    assert env["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] == "True"
    assert env["OCR_ASSETS_DIR"] == "/h"
    assert env["OCR_RUN_ROOT"] == str(tmp_path / "runs")
    assert env["HF_HUB_OFFLINE"] == "1"
    assert env["NO_PROXY"] == "127.0.0.1,localhost"
    assert env["no_proxy"] == "127.0.0.1,localhost"


def test_parse_timeout():
    assert m.parse_timeout(1) == 300.0
    assert m.parse_timeout(61) == 3660.0


def test_make_page_marker_is_unique_comment():
    a, b = m.make_page_marker(), m.make_page_marker()
    assert a != b
    assert a.startswith("<!-- MACOCR-PAGE-") and a.endswith(" -->")


def test_split_pages_numbers_pages():
    pages = m.split_pages(f"a{M}b{M}c", M, 3)
    assert pages == [m.OCRPage(1, "a"), m.OCRPage(2, "b"), m.OCRPage(3, "c")]


def test_split_pages_keeps_blank_page():
    pages = m.split_pages(f"a{M}  \n{M}c", M, 3)
    assert pages[1] == m.OCRPage(2, "")


def test_split_pages_count_mismatch_raises():
    with pytest.raises(m.InvalidPageResult):
        m.split_pages(f"a{M}b{M}c", M, 4)


def test_clean_removes_image_links():
    assert m.clean_page_markdown("x\n\n![image](imgs/p_001/a.png)\n\ny") == "x\n\ny"


def test_clean_keeps_non_imgs_links():
    s = "![logo](http://x/y.png)"
    assert m.clean_page_markdown(s) == s


def test_clean_converts_unconverted_otsl():
    src = "<otsl><fcel>A<fcel>1.000<nl><fcel>B<ecel><nl></otsl>"
    assert m.clean_page_markdown(src) == (
        "<table><tr><td>A</td><td>1.000</td></tr><tr><td>B</td><td></td></tr></table>")


def test_clean_otsl_without_close_ends_at_blank_line():
    assert m.clean_page_markdown("<otsl><fcel>A<nl>\n\nNext para") == (
        "<table><tr><td>A</td></tr></table>\n\nNext para")


def test_clean_drops_stray_otsl_tag_keeps_text():
    assert m.clean_page_markdown("<otsl>BÁO CÁO TÌNH HÌNH\n\nx") == "BÁO CÁO TÌNH HÌNH\n\nx"


def test_clean_stray_otsl_before_real_block_keeps_text():
    src = "Tổng tài sản <otsl>Ghi chú 5\nmore text\n<otsl><fcel>A<fcel>1<nl></otsl>"
    out = m.clean_page_markdown(src)
    assert "Ghi chú 5" in out and "more text" in out
    assert "<table><tr><td>A</td><td>1</td></tr></table>" in out


def test_clean_keeps_text_before_first_cell_token():
    out = m.clean_page_markdown("<otsl>lead text<fcel>A<nl></otsl>")
    assert "lead text" in out
    assert "<table><tr><td>A</td></tr></table>" in out


def test_clean_leaves_html_tables_and_vietnamese_untouched():
    s = "<table><tr><td>Tiền mặt, vàng bạc, đá quý</td><td>5.630.243</td></tr></table>"
    assert m.clean_page_markdown(s) == s


def test_otsl_spans_and_escaping():
    out = m.otsl_to_html("<fcel>A<lcel><fcel>x &amp; y<nl><ucel><xcel><fcel>z<nl>")
    assert out == ("<table><tr><td>A</td><td>x &amp; y</td></tr>"
                   "<tr><td>z</td></tr></table>")


def test_check_parse_log_accepts_zero_failures():
    m.check_parse_log('{"failed": 0, "failed_blocks": 0, "pages_with_failed_blocks": 0}')


def test_check_parse_log_rejects_failures():
    with pytest.raises(m.ParseFailed):
        m.check_parse_log('"failed_blocks": 2')


@pytest.mark.anyio
async def test_run_parse_nonzero_exit_raises(tmp_path):
    with pytest.raises(m.ParseFailed):
        await m.run_parse(["/bin/sh", "-c", "exit 3"], env={}, timeout_s=5, log_path=tmp_path / "l")


@pytest.mark.anyio
async def test_run_parse_timeout_kills_process(tmp_path):
    with pytest.raises(m.ParseFailed, match="timed out"):
        await m.run_parse(["/bin/sh", "-c", f"echo $$ > {tmp_path}/pid; sleep 60"],
                          env={}, timeout_s=0.5, log_path=tmp_path / "l")
    pid = int((tmp_path / "pid").read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


@pytest.mark.anyio
async def test_run_parse_cancel_kills_process(tmp_path):
    task = asyncio.create_task(m.run_parse(
        ["/bin/sh", "-c", f"echo $$ > {tmp_path}/pid; sleep 60"],
        env={}, timeout_s=30, log_path=tmp_path / "l"))
    for _ in range(100):
        if (tmp_path / "pid").exists() and (tmp_path / "pid").read_text().strip():
            break
        await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    pid = int((tmp_path / "pid").read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


@pytest.mark.anyio
async def test_ocr_pdf_pages_end_to_end_with_fake_sdk(tmp_path):
    from pypdf import PdfWriter
    import io
    w = PdfWriter()
    w.add_blank_page(width=100, height=100)
    w.add_blank_page(width=100, height=100)
    buf = io.BytesIO()
    w.write(buf)
    fake = tmp_path / "fake_sdk"
    fake.write_text(
        f"#!{sys.executable}\n"
        "import sys\n"
        "a = sys.argv\n"
        "d = a[a.index('--page-delimiter') + 1]\n"
        "o = a[a.index('--output') + 1]\n"
        "open(o, 'w').write('p1' + d + '![i](imgs/a.png)p2')\n"
        "print('\"failed\": 0')\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    work = tmp_path / "work"
    work.mkdir()
    c = m.OCRConfig(sdk_bin=fake, ocr_url="http://x", model="mm", ocr_home=tmp_path)
    pages = await m.ocr_pdf_pages(buf.getvalue(), work, c)
    assert pages == [m.OCRPage(1, "p1"), m.OCRPage(2, "p2")]


def test_pdf_page_count_zero_pages_invalid():
    with pytest.raises(m.InvalidPageResult):
        m.pdf_page_count(b"")
