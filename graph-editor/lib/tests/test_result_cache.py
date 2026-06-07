"""
Unit tests for ``lib/result_cache.py`` (73n Stage 7 utility).

The cache utility is the shared TTL/bypass/registry plumbing the
snapshot cache and the new primitive posterior + composed-object
caches register on. Tests cover put/get, TTL, eviction, bypass via
ContextVar, registry idempotency, ``clear``/``clear_all`` semantics,
and stats accounting.
"""

from __future__ import annotations

import os
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import result_cache
from result_cache import (
    ResultCache,
    cache_bypass_ctx,
    clear,
    clear_all,
    clear_request_scoped,
    get_cache,
    is_cache_bypassed,
    make_cache,
    make_key,
    reset_cache_bypass,
    set_cache_bypass,
    stats_all,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def isolated_registry():
    """Snapshot the registry, run the test against an empty registry,
    then restore. The reset helper is module-internal; production code
    must not call it but test isolation requires it."""
    original = dict(result_cache._registry)
    result_cache._reset_registry_for_tests()
    try:
        yield
    finally:
        result_cache._reset_registry_for_tests()
        with result_cache._registry_lock:
            result_cache._registry.update(original)


# ---------------------------------------------------------------------------
# make_key
# ---------------------------------------------------------------------------


class TestMakeKey:
    def test_deterministic_for_same_args(self):
        k1 = make_key('q', 'a', 'b', x=1)
        k2 = make_key('q', 'a', 'b', x=1)
        assert k1 == k2

    def test_distinct_for_different_positional(self):
        assert make_key('q', 'a') != make_key('q', 'b')

    def test_distinct_for_different_kwargs(self):
        assert make_key('q', x=1) != make_key('q', x=2)

    def test_kwarg_order_independent(self):
        # JSON sort_keys means kwarg ordering doesn't matter.
        assert make_key('q', x=1, y=2) == make_key('q', y=2, x=1)

    def test_distinct_for_different_fn_name(self):
        assert make_key('a', 1) != make_key('b', 1)

    def test_key_is_prefixed_with_fn_name(self):
        # Used by log readability and BYPASS-tag extraction.
        assert make_key('myfn', 1).startswith('myfn:')


# ---------------------------------------------------------------------------
# Basic put/get
# ---------------------------------------------------------------------------


class TestPutGet:
    def test_miss_on_unknown_key(self, isolated_registry):
        c = make_cache('t', log_prints=False)
        hit, value = c.get('nope')
        assert hit is False
        assert value is None
        assert c.stats()['misses'] == 1

    def test_round_trip_hit(self, isolated_registry):
        c = make_cache('t', log_prints=False)
        c.put('k', 42)
        hit, value = c.get('k')
        assert hit is True
        assert value == 42
        assert c.stats()['hits'] == 1

    def test_overwrite_replaces_value(self, isolated_registry):
        c = make_cache('t', log_prints=False)
        c.put('k', 'first')
        c.put('k', 'second')
        hit, value = c.get('k')
        assert hit is True
        assert value == 'second'

    def test_stats_count_misses_and_hits_independently(self, isolated_registry):
        c = make_cache('t', log_prints=False)
        c.get('a')      # miss
        c.put('a', 1)
        c.get('a')      # hit
        c.get('a')      # hit
        c.get('b')      # miss
        s = c.stats()
        assert s['misses'] == 2
        assert s['hits'] == 2


# ---------------------------------------------------------------------------
# TTL expiry
# ---------------------------------------------------------------------------


class TestTTL:
    def test_expired_entry_is_miss(self, isolated_registry):
        c = make_cache('t', ttl_s=1, log_prints=False)
        c.put('k', 'v')
        # Override expiry to be in the past.
        c._store['k'] = (time.time() - 1.0, 'v')
        hit, value = c.get('k')
        assert hit is False
        assert value is None
        # Expired entry is removed during the get().
        assert 'k' not in c._store

    def test_per_call_ttl_override(self, isolated_registry):
        c = make_cache('t', ttl_s=1000, log_prints=False)
        c.put('k', 'v', ttl_s=1)
        expiry, _ = c._store['k']
        # Within a few seconds of now+1, not now+1000.
        assert abs(expiry - (time.time() + 1)) < 1.0


# ---------------------------------------------------------------------------
# Bypass via ContextVar
# ---------------------------------------------------------------------------


class TestBypass:
    def test_get_returns_miss_under_bypass(self, isolated_registry):
        c = make_cache('t', log_prints=False)
        c.put('k', 'v')
        with cache_bypass_ctx():
            hit, value = c.get('k')
        assert hit is False
        assert value is None
        # Original entry remains for non-bypassed callers.
        assert c.get('k')[0] is True

    def test_put_skipped_under_bypass(self, isolated_registry):
        c = make_cache('t', log_prints=False)
        with cache_bypass_ctx():
            c.put('k', 'v')
        # Bypassed put did not store anything.
        assert 'k' not in c._store

    def test_bypass_increments_bypass_counter(self, isolated_registry):
        c = make_cache('t', log_prints=False)
        c.put('k', 'v')
        with cache_bypass_ctx():
            c.get('k')
            c.get('k')
        s = c.stats()
        assert s['bypasses'] == 2

    def test_set_reset_bypass_token_pair(self, isolated_registry):
        token = set_cache_bypass(True)
        try:
            assert is_cache_bypassed() is True
        finally:
            reset_cache_bypass(token)
        assert is_cache_bypassed() is False

    def test_bypass_propagates_across_caches(self, isolated_registry):
        a = make_cache('a', log_prints=False)
        b = make_cache('b', log_prints=False)
        a.put('k', 1)
        b.put('k', 2)
        with cache_bypass_ctx():
            # Both caches honour the same ContextVar.
            assert a.get('k') == (False, None)
            assert b.get('k') == (False, None)


# ---------------------------------------------------------------------------
# Eviction
# ---------------------------------------------------------------------------


class TestEviction:
    def test_evicts_oldest_expiry_when_over_capacity(self, isolated_registry):
        c = make_cache('t', ttl_s=10000, max_entries=3, log_prints=False)
        c.put('a', 1, ttl_s=1)       # earliest expiry
        c.put('b', 2, ttl_s=10)
        c.put('c', 3, ttl_s=100)
        c.put('d', 4, ttl_s=1000)    # triggers eviction
        # 'a' had the earliest expiry, so it is evicted.
        assert 'a' not in c._store
        assert {'b', 'c', 'd'}.issubset(c._store.keys())
        assert c.stats()['evictions'] == 1

    def test_no_eviction_when_under_capacity(self, isolated_registry):
        c = make_cache('t', max_entries=10, log_prints=False)
        for i in range(5):
            c.put(str(i), i)
        assert c.stats()['evictions'] == 0
        assert len(c._store) == 5


# ---------------------------------------------------------------------------
# Clear
# ---------------------------------------------------------------------------


class TestClear:
    def test_clear_one_cache_returns_pre_clear_stats(self, isolated_registry):
        c = make_cache('t', log_prints=False)
        c.put('a', 1)
        c.put('b', 2)
        c.get('a')
        c.get('missing')
        stats = c.clear()
        assert stats['name'] == 't'
        assert stats['entries_cleared'] == 2
        assert stats['hits'] == 1
        assert stats['misses'] == 1
        assert len(c._store) == 0

    def test_clear_increments_invalidations_counter(self, isolated_registry):
        c = make_cache('t', log_prints=False)
        c.clear()
        c.clear()
        assert c.stats()['invalidations'] == 2

    def test_clear_all_flushes_every_registered_cache(self, isolated_registry):
        a = make_cache('a', log_prints=False)
        b = make_cache('b', log_prints=False)
        a.put('k1', 1)
        a.put('k2', 2)
        b.put('k3', 3)
        result = clear_all()
        assert result['total_entries_cleared'] == 3
        names = {entry['name'] for entry in result['caches_cleared']}
        assert names == {'a', 'b'}
        assert len(a._store) == 0
        assert len(b._store) == 0

    def test_clear_named_cache_via_module_helper(self, isolated_registry):
        a = make_cache('a', log_prints=False)
        b = make_cache('b', log_prints=False)
        a.put('k', 1)
        b.put('k', 2)
        clear('a')
        assert len(a._store) == 0
        assert len(b._store) == 1     # b untouched

    def test_clear_unknown_name_raises(self, isolated_registry):
        with pytest.raises(KeyError):
            clear('does-not-exist')


# ---------------------------------------------------------------------------
# Request-scoped flush
# ---------------------------------------------------------------------------


class TestRequestScoped:
    """`clear_request_scoped()` flushes only caches tagged
    ``request_scoped=True`` (the draw-scaled runner caches) and leaves
    persistent caches (e.g. the snapshot cache) intact. This is the
    ResultCache memory-leak fix: per-request caches whose keys never
    repeat across requests are flushed at request end so a warm worker
    does not accumulate them past the count cap."""

    def test_default_cache_is_not_request_scoped(self, isolated_registry):
        c = make_cache('t', log_prints=False)
        assert c.request_scoped is False

    def test_request_scoped_flag_is_recorded(self, isolated_registry):
        c = make_cache('t', request_scoped=True, log_prints=False)
        assert c.request_scoped is True

    def test_clears_only_request_scoped_caches(self, isolated_registry):
        rs = make_cache('rs', request_scoped=True, log_prints=False)
        persistent = make_cache('persistent', log_prints=False)
        rs.put('k', 1)
        persistent.put('k', 2)
        clear_request_scoped()
        assert len(rs._store) == 0          # flushed
        assert len(persistent._store) == 1  # untouched

    def test_returns_aggregate_pre_clear_stats(self, isolated_registry):
        rs1 = make_cache('rs1', request_scoped=True, log_prints=False)
        rs2 = make_cache('rs2', request_scoped=True, log_prints=False)
        make_cache('persistent', log_prints=False)
        rs1.put('a', 1)
        rs1.put('b', 2)
        rs2.put('c', 3)
        result = clear_request_scoped()
        assert result['total_entries_cleared'] == 3
        names = {entry['name'] for entry in result['caches_cleared']}
        assert names == {'rs1', 'rs2'}  # persistent not reported

    def test_noop_when_no_request_scoped_caches(self, isolated_registry):
        make_cache('persistent', log_prints=False)
        result = clear_request_scoped()
        assert result['total_entries_cleared'] == 0
        assert result['caches_cleared'] == []

    def test_idempotency_preserves_request_scoped_flag(self, isolated_registry):
        a1 = make_cache('a', request_scoped=True, log_prints=False)
        # Second make_cache for the same name returns the original and
        # ignores the conflicting flag (matches the ttl/max_entries rule).
        a2 = make_cache('a', request_scoped=False, log_prints=False)
        assert a1 is a2
        assert a2.request_scoped is True


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


class TestRegistry:
    def test_make_cache_idempotent_for_same_name(self, isolated_registry):
        a1 = make_cache('a', log_prints=False)
        a2 = make_cache('a', log_prints=False)
        assert a1 is a2

    def test_make_cache_ignores_subsequent_args_with_same_name(self, isolated_registry):
        a1 = make_cache('a', ttl_s=100, max_entries=10, log_prints=False)
        a2 = make_cache('a', ttl_s=999, max_entries=999, log_prints=False)
        # Same instance, original config wins.
        assert a1 is a2
        assert a2.ttl_s == 100
        assert a2.max_entries == 10

    def test_get_cache_returns_registered_instance(self, isolated_registry):
        a = make_cache('a', log_prints=False)
        assert get_cache('a') is a

    def test_get_unknown_cache_raises(self, isolated_registry):
        with pytest.raises(KeyError):
            get_cache('does-not-exist')

    def test_stats_all_lists_every_registered_cache(self, isolated_registry):
        make_cache('a', log_prints=False)
        make_cache('b', log_prints=False)
        report = stats_all()
        names = {c['name'] for c in report['caches']}
        assert names == {'a', 'b'}


# ---------------------------------------------------------------------------
# Type / construction
# ---------------------------------------------------------------------------


class TestResultCacheConstruction:
    def test_make_cache_returns_result_cache_instance(self, isolated_registry):
        assert isinstance(make_cache('t', log_prints=False), ResultCache)

    def test_default_ttl_and_max_entries(self, isolated_registry):
        c = make_cache('t', log_prints=False)
        assert c.ttl_s == 15 * 60
        assert c.max_entries == 256
