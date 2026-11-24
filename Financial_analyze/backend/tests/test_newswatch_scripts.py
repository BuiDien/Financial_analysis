"""Hermes entry scripts: stdout is the Telegram message, so it must carry the
alert text only (nothing on a quiet day, never a banner or a traceback)."""
import importlib.util
import os
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
VENV_PYTHON = Path(__file__).resolve().parents[1] / ".venv" / "bin" / "python"

# Importing a script re-execs it under backend/.venv when run by another
# interpreter; only load it when that guard is a no-op.
pytestmark = pytest.mark.skipif(
    VENV_PYTHON.exists() and os.path.realpath(sys.executable) != os.path.realpath(VENV_PYTHON),
    reason="entry scripts re-exec under backend/.venv; run pytest with that interpreter",
)


@pytest.fixture(params=["newswatch_after_close", "newswatch_morning"])
def script(request, monkeypatch):
    env = dict(os.environ)  # the script pops PYTHONPATH/PYTHONHOME at import
    spec = importlib.util.spec_from_file_location(f"_{request.param}", SCRIPTS / f"{request.param}.py")
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    finally:
        os.environ.clear()
        os.environ.update(env)
    mod.NAME = request.param
    return mod


def test_alert_text_is_the_whole_stdout(script, monkeypatch, capsys):
    monkeypatch.setattr(script, "_run", lambda: "ALERT")
    assert script.main() == 0
    assert capsys.readouterr().out == "ALERT"


def test_quiet_day_prints_nothing(script, monkeypatch, capsys):
    monkeypatch.setattr(script, "_run", lambda: "")
    assert script.main() == 0
    assert capsys.readouterr().out == ""


def test_failure_goes_to_stderr_and_exits_1(script, monkeypatch, capsys):
    def boom():
        raise ValueError("db locked")
    monkeypatch.setattr(script, "_run", boom)
    assert script.main() == 1
    out, err = capsys.readouterr()
    assert out == ""
    assert f"{script.NAME} failed: ValueError: db locked" in err


def test_banners_are_kept_off_stdout(script, monkeypatch, capsys):
    def noisy():
        print("vnstock banner: welcome")
        return "X"
    monkeypatch.setattr(script, "_run", noisy)
    assert script.main() == 0
    out, err = capsys.readouterr()
    assert out == "X"
    assert "vnstock banner" in err
