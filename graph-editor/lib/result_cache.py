"""
Generic TTL Result Cache

Module-level registry of named TTL caches. Multiple subsystems can
register their own cache (snapshot DB queries, primitive posteriors,
composed objects, ...) on a single shared ContextVar bypass and a
single ``clear_all()`` bustcache hook.

Design rationale
----------------

Snapshot writes already invalidate the snapshot cache via
``cache_clear()`` calls in ``snapshot_service.append_snapshots`` and
``snapshot_service.delete_snapshots``. This module generalises the
mechanism so any cache registered here is flushed by the same call,
without per-cache wiring at every write site.

Per-request bypass via ``no_cache: true`` (and the dev middleware's
``?no-cache=1``) flows through the shared ContextVar; every registered
cache observes it.

TTL + max-entries eviction matches the snapshot cache's existing
pattern. Cache keys carry scope identity (function name + args) so
scope changes invalidate naturally via key change; TTL bounds
staleness for unchanged-scope cases.

See CLAUDE.md core principle 3 (centralise shared code) and
KNOWN_ANTI_PATTERNS AP58 (no forking by case).
"""

import contextvars
import hashlib
import json
import os
import threading
import time as _time
from typing import Any, Dict, Tuple


# Shared bypass ContextVar. All registered caches observe it.
_bypass_var: "contextvars.ContextVar[bool]" = contextvars.ContextVar(
    'result_cache_bypass', default=False
)

# Module-level registry of named caches. Iterated by clear_all() and
# stats_all(); access protected by _registry_lock.
_registry_lock = threading.Lock()
_registry: Dict[str, "ResultCache"] = {}

DEFAULT_TTL_S = 15 * 60         # 15 minutes
DEFAULT_MAX_ENTRIES = 256


def set_cache_bypass(bypass: bool = True):
    """Enable or disable cache bypass for the current context.

    Returns a token. Pass it to ``reset_cache_bypass()`` to restore the
    previous value (typically in a ``finally:`` block).
    """
    return _bypass_var.set(bypass)


def reset_cache_bypass(token) -> None:
    """Restore the bypass flag to the value before the matching set_cache_bypass()."""
    _bypass_var.reset(token)


def is_cache_bypassed() -> bool:
    return _bypass_var.get()


class cache_bypass_ctx:
    """Context manager that enables cache bypass for the current context.

    Safe under asyncio: the flag lives in a ContextVar, so nested or
    concurrent requests do not observe each other's state.
    """

    def __init__(self, bypass: bool = True):
        self._bypass = bypass
        self._token = None

    def __enter__(self):
        self._token = _bypass_var.set(self._bypass)
        return self

    def __exit__(self, *exc):
        if self._token is not None:
            _bypass_var.reset(self._token)
            self._token = None


def make_key(fn_name: str, *args, **kwargs) -> str:
    """Deterministic cache key from a function name and arguments.

    The key is prefixed with ``fn_name`` for log readability;
    arguments are JSON-serialised with ``sort_keys`` and SHA-256
    truncated to 24 hex chars.
    """
    raw = json.dumps(
        {"fn": fn_name, "a": args, "kw": kwargs},
        sort_keys=True, default=str
    )
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]
    return f"{fn_name}:{digest}"


class ResultCache:
    """A single named TTL cache. Constructed via ``make_cache(...)``.

    Each instance owns its own dict and lock; the registry holds a
    reference so ``clear_all()`` can flush every cache atomically.
    """

    def __init__(
        self,
        name: str,
        *,
        ttl_s: int,
        max_entries: int,
        log_prints: bool = True,
    ):
        self.name = name
        self.ttl_s = int(ttl_s)
        self.max_entries = int(max_entries)
        self._log_prints = log_prints
        self._store: Dict[str, Tuple[float, Any]] = {}
        self._lock = threading.Lock()
        self._stats = {
            "hits": 0,
            "misses": 0,
            "evictions": 0,
            "invalidations": 0,
            "bypasses": 0,
        }

    def get(self, key: str) -> Tuple[bool, Any]:
        """Return ``(hit, value)``. Expired entries are treated as misses.

        Bypass is checked before lookup; bypassed reads never hit and
        increment the ``bypasses`` counter.
        """
        fn = key.split(':', 1)[0] if ':' in key else key[:24]
        if is_cache_bypassed():
            with self._lock:
                self._stats["bypasses"] += 1
            if self._log_prints:
                print(f"[{self.name}_cache] BYPASS {fn}")
            return False, None
        with self._lock:
            entry = self._store.get(key)
            if entry is not None:
                expiry, value = entry
                if _time.time() < expiry:
                    self._stats["hits"] += 1
                    if self._log_prints:
                        print(f"[{self.name}_cache] HIT {fn} ({len(self._store)} entries)")
                    return True, value
                # Expired — remove.
                del self._store[key]
            self._stats["misses"] += 1
            if self._log_prints:
                print(f"[{self.name}_cache] MISS {fn} ({len(self._store)} entries)")
            return False, None

    def put(self, key: str, value: Any, ttl_s: int = None) -> None:
        """Store a value with TTL. Evicts the oldest-expiry entry if over capacity.

        Skips storage when bypass is active (so bypassed requests
        cannot pollute the cache).
        """
        if is_cache_bypassed():
            return
        ttl = int(ttl_s) if ttl_s is not None else self.ttl_s
        with self._lock:
            self._store[key] = (_time.time() + ttl, value)
            if len(self._store) > self.max_entries:
                oldest_key = min(self._store, key=lambda k: self._store[k][0])
                del self._store[oldest_key]
                self._stats["evictions"] += 1

    def clear(self) -> Dict[str, Any]:
        """Clear this cache's entries. Returns stats before clearing."""
        with self._lock:
            stats = dict(self._stats)
            stats["name"] = self.name
            stats["entries_cleared"] = len(self._store)
            self._store.clear()
            self._stats["invalidations"] += 1
            return stats

    def stats(self) -> Dict[str, Any]:
        """Read-only stats snapshot."""
        with self._lock:
            stats = dict(self._stats)
            stats["name"] = self.name
            stats["entries"] = len(self._store)
            return stats


def make_cache(
    name: str,
    *,
    ttl_s: int = DEFAULT_TTL_S,
    max_entries: int = DEFAULT_MAX_ENTRIES,
    log_prints: bool = True,
) -> ResultCache:
    """Create and register a named cache.

    Idempotent: if a cache with the same ``name`` is already
    registered, the existing instance is returned and the
    ``ttl_s``/``max_entries``/``log_prints`` arguments on the second
    call are ignored. This makes module re-imports under reload safe.
    """
    with _registry_lock:
        existing = _registry.get(name)
        if existing is not None:
            return existing
        cache = ResultCache(
            name,
            ttl_s=ttl_s,
            max_entries=max_entries,
            log_prints=log_prints,
        )
        _registry[name] = cache
        return cache


def get_cache(name: str) -> ResultCache:
    """Look up a registered cache by name. Raises ``KeyError`` if unknown."""
    with _registry_lock:
        return _registry[name]


def clear_all() -> Dict[str, Any]:
    """Flush every registered cache. Returns aggregate pre-clear stats.

    This is the bustcache hook. Snapshot writes call it (transitively
    via ``snapshot_service.cache_clear``) so caches in other
    subsystems registered here are flushed in lockstep with the data
    they consume.
    """
    with _registry_lock:
        caches = list(_registry.values())
    aggregate = {
        "caches_cleared": [],
        "total_entries_cleared": 0,
    }
    for cache in caches:
        s = cache.clear()
        aggregate["caches_cleared"].append(s)
        aggregate["total_entries_cleared"] += s["entries_cleared"]
    return aggregate


def clear(name: str) -> Dict[str, Any]:
    """Flush one named cache. Raises ``KeyError`` if unknown."""
    return get_cache(name).clear()


def stats_all() -> Dict[str, Any]:
    """Stats for every registered cache (non-destructive)."""
    with _registry_lock:
        caches = list(_registry.values())
    return {
        "caches": [c.stats() for c in caches],
    }


def _reset_registry_for_tests() -> None:
    """Drop all registered caches. Test-only helper.

    Production code must NOT call this — it would orphan ResultCache
    instances held by importers, leading to silent divergence between
    a stale local handle and a freshly-registered cache of the same
    name.
    """
    with _registry_lock:
        _registry.clear()
