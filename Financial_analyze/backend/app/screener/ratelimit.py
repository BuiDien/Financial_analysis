"""Shared vnstock rate limiter: spaces calls across threads, lets interactive
calls jump ahead of background ones, and cools down + retries once on quota
errors."""
import re
import threading
import time

from .provider import ProviderRateLimited


class RateLimited(ProviderRateLimited):
    pass


# Only real quota messages. A bare "limit" is NOT one: ValueError("... limit 3
# chars") must stay a per-ticker error, not trigger a 61s cooldown + abort.
_RATE_PATTERNS = [re.compile(p, re.I) for p in (
    r"rate[ _-]?limit", r"too many requests", r"\b(http|status|error)[ :]*429\b",
    r"\b429 client error\b", r"quota (exceeded|limit|reached)",
    r"(quá nhiều|vượt quá) (yêu cầu|request|giới hạn)", r"giới hạn (truy cập|request|yêu cầu)")]


def _is_rate_error(e: BaseException) -> bool:
    if isinstance(e, SystemExit):
        return True
    msg = str(e)
    return any(p.search(msg) for p in _RATE_PATTERNS)


class RateLimiter:
    def __init__(self, interval_s: float = 3.1, cooldown_s: float = 61.0,
                 clock=time.monotonic, sleep=time.sleep):
        self.interval_s = interval_s
        self.cooldown_s = cooldown_s
        self._clock = clock
        self._sleep = sleep
        self._cond = threading.Condition()
        self._busy = False
        self._interactive_waiting = 0
        self._last_call: float | None = None
        self._cooldown_until = 0.0

    def _acquire(self, interactive: bool) -> None:
        with self._cond:
            if interactive:
                self._interactive_waiting += 1
            try:
                while self._busy or (not interactive and self._interactive_waiting):
                    self._cond.wait()
            finally:
                if interactive:
                    self._interactive_waiting -= 1
            self._busy = True

    def _release(self) -> None:
        with self._cond:
            self._busy = False
            self._cond.notify_all()

    def _space(self) -> None:
        if self._last_call is not None:
            wait = self._last_call + self.interval_s - self._clock()
            if wait > 0:
                self._sleep(wait)
        self._last_call = self._clock()

    def call(self, fn, *args, priority: str = "interactive", **kwargs):
        """Interactive calls never wait out a cooldown (they raise RateLimited);
        background calls wait it out and retry once."""
        interactive = priority == "interactive"
        for attempt in (1, 2):
            self._acquire(interactive)
            wait = 0.0
            try:
                remaining = self._cooldown_until - self._clock()
                if remaining > 0:
                    if interactive:
                        raise RateLimited("vnstock cooldown active")
                    wait = remaining
                else:
                    self._space()
                    try:
                        return fn(*args, **kwargs)
                    except (SystemExit, Exception) as e:
                        if not _is_rate_error(e):
                            raise
                        self._cooldown_until = self._clock() + self.cooldown_s
                        if interactive or attempt == 2:
                            raise RateLimited(f"vnstock rate limit: {e}") from None
                        wait = self.cooldown_s
            finally:
                self._release()
            self._sleep(wait)  # outside the limiter
        raise RateLimited("vnstock cooldown active")


vnstock_limiter = RateLimiter()
