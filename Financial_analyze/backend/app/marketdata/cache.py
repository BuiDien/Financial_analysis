"""The one TTL cache for market data: Redis when REDIS_URL is set and
reachable, else a bounded in-process dict.

Callers own their keys and TTLs (quote 120s, history 300s, market state 600s,
backtest bars 3600s). Values must be JSON-serialisable (Redis stores JSON).
"""
import json
import threading
import time
from typing import Any

from ..config import get_settings

settings = get_settings()

_redis = None
if settings.redis_url:
    try:
        import redis
        _redis = redis.from_url(settings.redis_url, decode_responses=True)
        _redis.ping()
    except Exception:
        _redis = None


# Fallback when Redis isn't configured (the common case in dev): a plain
# in-process dict cache. Without ANY cache, every poller (Watch board every
# 2s, the header ticker tape, multiple browser tabs) hits Yahoo fresh for
# the same ticker — that's what tripped Yahoo's rate limit under normal use.
# Request handlers run on a thread pool, so every access holds the lock, and
# the dict is capped (expired entries are swept first, then soonest-to-expire).
_LOCAL_CACHE_MAX = 2000
_local_cache: dict[str, tuple[float, Any]] = {}
_local_lock = threading.Lock()


def get(key: str):
    if _redis:
        try:
            v = _redis.get(key)
            return json.loads(v) if v else None
        except Exception:
            return None
    with _local_lock:
        hit = _local_cache.get(key)
        if not hit:
            return None
        expires_at, value = hit
        if time.time() >= expires_at:
            _local_cache.pop(key, None)
            return None
        return value


def _evict_locked(now: float) -> None:
    for k in [k for k, (exp, _) in list(_local_cache.items()) if exp <= now]:
        _local_cache.pop(k, None)
    over = len(_local_cache) - _LOCAL_CACHE_MAX + 1
    if over > 0:
        oldest = sorted(_local_cache.items(), key=lambda kv: kv[1][0])[:over]
        for k, _ in oldest:
            _local_cache.pop(k, None)


def set(key: str, value: Any, ttl: int = 60):  # noqa: A001 - module API: cache.set
    if _redis:
        try:
            _redis.setex(key, ttl, json.dumps(value, default=str))
        except Exception:
            pass
        return
    now = time.time()
    with _local_lock:
        if key not in _local_cache and len(_local_cache) >= _LOCAL_CACHE_MAX:
            _evict_locked(now)
        _local_cache[key] = (now + ttl, value)
