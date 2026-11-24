"""In-process cache fallback: race-safe expiry, bounded size."""
import threading

import pytest

from app.marketdata import cache


@pytest.fixture
def local(monkeypatch):
    monkeypatch.setattr(cache, "_redis", None)
    monkeypatch.setattr(cache, "_local_cache", {})
    return cache


def test_expired_entry_removed_concurrently_is_not_a_keyerror(local, monkeypatch):
    """Two threads both see an expired entry; the second `del` used to raise
    KeyError, which the quote route turned into 'Quote unavailable' 404."""
    class Racy(dict):
        def get(self, key, default=None):
            hit = super().get(key, default)
            self.pop(key, None)  # another thread deleted it right after our read
            return hit

    racy = Racy({"quote:X": (0.0, {"price": 1})})
    monkeypatch.setattr(cache, "_local_cache", racy)
    assert cache.get("quote:X") is None


def test_cache_is_capped(local, monkeypatch):
    monkeypatch.setattr(cache, "_LOCAL_CACHE_MAX", 50)
    for i in range(500):
        cache.set(f"k{i}", i, ttl=600)
    assert len(cache._local_cache) <= 50
    assert cache.get("k499") == 499  # newest survives


def test_cap_sweeps_expired_first(local, monkeypatch):
    monkeypatch.setattr(cache, "_LOCAL_CACHE_MAX", 3)
    cache.set("old", 1, ttl=-1)  # already expired
    cache.set("a", 2, ttl=600)
    cache.set("b", 3, ttl=600)
    cache.set("c", 4, ttl=600)
    assert "old" not in cache._local_cache
    assert {cache.get(k) for k in "abc"} == {2, 3, 4}


def test_concurrent_get_set_never_raises(local, monkeypatch):
    monkeypatch.setattr(cache, "_LOCAL_CACHE_MAX", 20)
    errors = []

    def worker(n):
        try:
            for i in range(300):
                cache.set(f"k{(n + i) % 40}", i, ttl=0 if i % 2 else 600)
                cache.get(f"k{(n * 7 + i) % 40}")
        except Exception as e:  # pragma: no cover - the bug
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == [] and len(cache._local_cache) <= 20
