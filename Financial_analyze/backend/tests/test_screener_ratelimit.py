import threading
import time

import pytest

from app.screener.ratelimit import RateLimited, RateLimiter


class Fake:
    def __init__(self):
        self.t = 0.0
        self.sleeps = []

    def clock(self):
        return self.t

    def sleep(self, d):
        self.sleeps.append(d)
        self.t += d


def _wait_for(cond, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return
        time.sleep(0.005)
    raise AssertionError("timeout")


def make():
    f = Fake()
    return f, RateLimiter(clock=f.clock, sleep=f.sleep)


def test_spaces_calls():
    f, rl = make()
    rl.call(lambda: 1)
    rl.call(lambda: 2)
    assert len(f.sleeps) == 1
    assert f.sleeps[0] == pytest.approx(3.1)


def test_systemexit_becomes_ratelimited():
    f, rl = make()
    n = []

    def fn():
        n.append(1)
        raise SystemExit("quota")

    with pytest.raises(RateLimited):
        rl.call(fn, priority="background")
    assert len(n) == 2
    assert 61.0 in f.sleeps


def test_rate_error_retries_once_then_succeeds():
    f, rl = make()
    results = [Exception("Rate limit exceeded"), 5]

    def fn():
        r = results.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    assert rl.call(fn, priority="background") == 5
    assert 61.0 in f.sleeps


def test_other_errors_propagate():
    f, rl = make()
    n = []

    def fn():
        n.append(1)
        raise ValueError("bad symbol")

    with pytest.raises(ValueError):
        rl.call(fn)
    assert len(n) == 1


def test_interactive_jumps_queue():
    rl = RateLimiter(interval_s=0.05)
    order = []
    started = threading.Event()
    release = threading.Event()

    def b1():
        started.set()
        release.wait(5)
        order.append("B1")

    t1 = threading.Thread(target=lambda: rl.call(b1, priority="background"))
    t1.start()
    assert started.wait(5)
    t2 = threading.Thread(
        target=lambda: rl.call(lambda: order.append("B2"), priority="background"))
    t2.start()
    t3 = threading.Thread(target=lambda: rl.call(lambda: order.append("I1")))
    t3.start()
    _wait_for(lambda: rl._interactive_waiting == 1)
    release.set()
    for t in (t1, t2, t3):
        t.join(5)
    assert order == ["B1", "I1", "B2"]


def test_benign_error_with_rate_substring_propagates():
    f, rl = make()
    n = []

    def fn():
        n.append(1)
        raise Exception("no data for corporate bond")

    with pytest.raises(Exception, match="corporate"):
        rl.call(fn)
    assert len(n) == 1
    assert 61.0 not in f.sleeps


def test_interactive_fails_fast_on_rate_hit():
    f, rl = make()
    n = []

    def fn():
        n.append(1)
        raise SystemExit("quota")

    with pytest.raises(RateLimited):
        rl.call(fn)
    assert len(n) == 1
    assert 61.0 not in f.sleeps


def test_interactive_fails_fast_during_cooldown():
    f, rl = make()

    def hit():
        raise SystemExit("quota")

    with pytest.raises(RateLimited):
        rl.call(hit)
    called = []
    with pytest.raises(RateLimited):
        rl.call(lambda: called.append(1))
    assert called == []
    assert 61.0 not in f.sleeps


# ---- what counts as a quota error -----------------------------------------

@pytest.mark.parametrize("msg", [
    "Rate limit exceeded", "rate-limit hit", "429 Client Error: Too Many Requests",
    "HTTP 429", "Too many requests, slow down", "quota exceeded for today",
    "Bạn đã gửi quá nhiều request",
])
def test_quota_messages_are_rate_errors(msg):
    from app.screener.ratelimit import _is_rate_error
    assert _is_rate_error(Exception(msg))


@pytest.mark.parametrize("msg", [
    "symbol limit 3 chars", "limit must be positive", "price limited to band",
    "no data for VNM", "row 429 missing",
])
def test_ordinary_errors_mentioning_limit_are_not_rate_errors(msg):
    from app.screener.ratelimit import _is_rate_error
    assert not _is_rate_error(ValueError(msg))


def test_value_error_with_limit_passes_through_without_cooldown():
    f, rl = make()

    def fn():
        raise ValueError("symbol limit 3 chars")

    with pytest.raises(ValueError):
        rl.call(fn, priority="background")
    assert 61.0 not in f.sleeps
    assert rl.call(lambda: 7) == 7  # no cooldown was armed
