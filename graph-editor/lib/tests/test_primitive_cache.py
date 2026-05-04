"""
73n Stage 7 — Primitive posterior cache tests.

Covers the process-memory cache wrapping ``condition_primitive`` (the
expensive Stage 3 entry point). The cache is registered under
``result_cache`` so the snapshot-write bustcache and the body-level
``no_cache: true`` ContextVar suppress it uniformly without per-call
plumbing.

Tests:

  - cached and uncached calls produce numerically-identical primitives
    (the function is deterministic given its inputs, so the cache must
    return the same object that an uncached call would have produced)
  - cache hit on second call with identical inputs (object identity
    proves a hit, not a re-compute)
  - cache miss when any load-bearing input changes: transition identity,
    evidence rows, prior alpha/beta, n_effective, latency moments,
    prior_source, conditioning options
  - bypass via ``cache_bypass_ctx`` returns a fresh object on every
    call AND does not pollute the cache for non-bypassed callers
  - ``result_cache.clear_all()`` (and therefore
    ``snapshot_service.cache_clear()``) flushes the primitive cache

Mended from `_attic/test_primitive_cache.py` per
docs/current/project-bayes/73-attic-mending-process.md. Migration:
`runner.carrier_composition.TransitionPrimitive` →
`runner.timing_span.TimingTransitionPrimitive`. One test tombstoned
as OBSOLETE because under DrawFamilyKey v2 the cache key deliberately
drops `scenario_seed` (audit File 6 row 2 reclassified GAP → OBSOLETE
during mend).
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import result_cache
import snapshot_service
from evidence_merge import (
    EvidenceCandidate,
    EvidenceIdentity,
    EvidenceRole,
    EvidenceScope,
    ObservationCoordinate,
    SliceFamily,
    SourceKind,
    TemporalBasis,
)
from runner.model_resolver import ResolvedLatency, ResolvedModelParams
from runner.prefix_arrival import build_prefix_arrival_map, PrefixArrivalIdentity
from runner.primitive_conditioning import (
    ConditioningPolicyOptions,
    _primitive_cache,
    condition_primitive,
)
from runner.primitive_evidence import (
    bind_primitive_evidence,
    make_primitive_scope_from_evidence_scope,
)
from runner.primitives import TransitionIdentity
from runner.timing_span import TimingTransitionPrimitive


# ---------------------------------------------------------------------------
# Fixture helpers (same shapes as test_primitive_conditioning.py — kept
# self-contained so cache tests can run independently)
# ---------------------------------------------------------------------------


def _make_graph(edges):
    nodes_by_uuid = {}
    edge_list = []
    for uuid, from_u, to_u, from_id, to_id in edges:
        nodes_by_uuid[from_u] = {'uuid': from_u, 'id': from_id}
        nodes_by_uuid[to_u] = {'uuid': to_u, 'id': to_id}
        edge_list.append({'uuid': uuid, 'from': from_u, 'to': to_u})
    return {'nodes': list(nodes_by_uuid.values()), 'edges': edge_list}


def _identity(request_root='U'):
    return PrefixArrivalIdentity(
        scenario_id='scn-1',
        request_root=request_root,
        context_key=None,
        regime_key='default',
        as_at='2026-04-01',
        model_source_preference='best_available',
        parameter_fingerprint='fp-1',
    )


def _evidence_scope(subject_from='U', subject_to='V'):
    return EvidenceScope(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from=subject_from,
        subject_to=subject_to,
        date_from='2026-03-01',
        date_to='2026-03-31',
        as_at='2026-04-01',
        scenario_id='scn-1',
        anchor=None,
        context_key=None,
        regime_key=None,
    )


def _candidate(*, observed_date, n, k, subject_from='U', subject_to='V'):
    return EvidenceCandidate(
        source=SourceKind.SNAPSHOT,
        identity=EvidenceIdentity(
            role=EvidenceRole.WINDOW_SUBJECT_HELPER,
            subject_from=subject_from,
            subject_to=subject_to,
            anchor=None,
            slice_family=SliceFamily.WINDOW,
            context_key=None,
            regime_key=None,
            population_identity=None,
        ),
        coordinate=ObservationCoordinate(
            observed_date=observed_date,
            retrieved_at='2026-04-01',
            temporal_basis=TemporalBasis.WINDOW_DAY,
            asat_materialised=False,
        ),
        n=n,
        k=k,
        provenance={},
    )


def _resolution(
    *,
    candidates=None,
    src='U', dst='V', edge_id='e-u-v',
):
    if candidates is None:
        candidates = [_candidate(observed_date='2026-03-15', n=100, k=30)]
    graph = _make_graph([(edge_id, f'u-{src.lower()}', f'u-{dst.lower()}',
                          src, dst)])
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id=src,
        root_day_weights={'2026-03-15': 1.0},
        transitions={(src, dst): TimingTransitionPrimitive(
            p=0.7, mu=0.0, sigma=0.0, onset=0.0,
            p_sd=0.0, mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0,
            source='test_synthetic',
        )},
        identity=_identity(request_root=src),
        max_tau=60,
    )
    ev_scope = _evidence_scope(subject_from=src, subject_to=dst)
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    return bind_primitive_evidence(
        transition=TransitionIdentity(src, dst, edge_id),
        primitive_scope=primitive_scope,
        evidence_scope=ev_scope,
        candidates=candidates,
        arrival_weights=arrival_map.get(src),
    )


def _model(
    *,
    alpha=1.0, beta=1.0, n_effective=None,
    mu=0.0, sigma=0.0, onset=0.0,
    source='analytic',
):
    return ResolvedModelParams(
        p_mean=alpha / max(alpha + beta, 1e-12),
        p_sd=0.0,
        alpha=alpha, beta=beta,
        alpha_pred=alpha, beta_pred=beta,
        n_effective=n_effective,
        edge_latency=ResolvedLatency(
            mu=mu, sigma=sigma, onset_delta_days=onset,
            t95=0.0, mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0, onset_mu_corr=0.0,
        ),
        path_latency=None,
        source=source,
    )


@pytest.fixture
def clean_primitive_cache():
    """Flush the primitive cache before and after each test so cache
    state from earlier tests cannot bleed in."""
    _primitive_cache.clear()
    try:
        yield
    finally:
        _primitive_cache.clear()


# ---------------------------------------------------------------------------
# Cache hit / miss
# ---------------------------------------------------------------------------


def test_cache_hit_returns_same_object_for_identical_inputs(clean_primitive_cache):
    res = _resolution()
    rm = _model()
    a = condition_primitive(resolution=res, resolved_model=rm, scenario_seed=42)
    b = condition_primitive(resolution=res, resolved_model=rm, scenario_seed=42)
    # Identity proves a hit (cache returns the stored object, not a re-compute).
    assert a is b
    assert _primitive_cache.stats()['hits'] >= 1


@pytest.mark.skip(
    reason=(
        "OBSOLETE under 73n DrawFamilyKey v2 (Atom 2): scenario_seed was "
        "deliberately dropped from canonical_string — see "
        "runner/primitives.py:146-149. The cache key consumes "
        "draw_family_key.canonical_string() (primitive_conditioning.py:179), "
        "so identical math across scenarios deliberately shares a cached "
        "primitive regardless of scenario_seed. The retained intent (cache "
        "must miss when load-bearing inputs change) is pinned by the eight "
        "other test_cache_miss_for_different_* tests in this file. Audit "
        "File 6 row 2 reclassified GAP → OBSOLETE on mend; tombstoned per "
        "73-attic-mending-process.md §6.2."
    )
)
def test_cache_miss_for_different_scenario_seed(clean_primitive_cache):
    res = _resolution()
    rm = _model()
    a = condition_primitive(resolution=res, resolved_model=rm, scenario_seed=1)
    b = condition_primitive(resolution=res, resolved_model=rm, scenario_seed=2)
    assert a is not b
    s = _primitive_cache.stats()
    assert s['misses'] >= 2


def test_cache_miss_for_different_prior_alpha_beta(clean_primitive_cache):
    res = _resolution()
    a = condition_primitive(
        resolution=res, resolved_model=_model(alpha=1.0, beta=1.0),
        scenario_seed=42,
    )
    b = condition_primitive(
        resolution=res, resolved_model=_model(alpha=2.0, beta=3.0),
        scenario_seed=42,
    )
    assert a is not b
    # Different priors must produce different posterior means.
    assert a.probability_posterior.mean != b.probability_posterior.mean


def test_cache_miss_for_different_evidence(clean_primitive_cache):
    res_a = _resolution(candidates=[
        _candidate(observed_date='2026-03-15', n=100, k=30),
    ])
    res_b = _resolution(candidates=[
        _candidate(observed_date='2026-03-15', n=100, k=60),
    ])
    rm = _model()
    a = condition_primitive(resolution=res_a, resolved_model=rm, scenario_seed=42)
    b = condition_primitive(resolution=res_b, resolved_model=rm, scenario_seed=42)
    assert a is not b
    assert a.probability_posterior.mean != b.probability_posterior.mean


def test_cache_miss_for_different_transition(clean_primitive_cache):
    res_a = _resolution(src='U', dst='V', edge_id='e-u-v')
    res_b = _resolution(src='X', dst='Y', edge_id='e-x-y')
    rm = _model()
    a = condition_primitive(resolution=res_a, resolved_model=rm, scenario_seed=42)
    b = condition_primitive(resolution=res_b, resolved_model=rm, scenario_seed=42)
    assert a is not b


def test_cache_miss_for_different_n_effective(clean_primitive_cache):
    res = _resolution()
    a = condition_primitive(
        resolution=res, resolved_model=_model(n_effective=None),
        scenario_seed=42,
    )
    b = condition_primitive(
        resolution=res, resolved_model=_model(n_effective=1000.0),
        scenario_seed=42,
    )
    assert a is not b


def test_cache_miss_for_different_latency_moments(clean_primitive_cache):
    res = _resolution()
    a = condition_primitive(
        resolution=res, resolved_model=_model(mu=0.0, sigma=0.0),
        scenario_seed=42,
    )
    b = condition_primitive(
        resolution=res, resolved_model=_model(mu=2.5, sigma=0.8),
        scenario_seed=42,
    )
    assert a is not b


def test_cache_miss_for_different_options(clean_primitive_cache):
    res = _resolution()
    rm = _model()
    a = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
        options=ConditioningPolicyOptions(draw_count=1000),
    )
    b = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
        options=ConditioningPolicyOptions(draw_count=2000),
    )
    assert a is not b
    assert a.draw_count != b.draw_count


def test_cache_miss_for_different_prior_source(clean_primitive_cache):
    res = _resolution()
    rm = _model()
    a = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
        prior_source='analytic',
    )
    b = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
        prior_source='bayesian',
    )
    assert a is not b


# ---------------------------------------------------------------------------
# Numerical equivalence: cached and uncached produce the same posterior
# ---------------------------------------------------------------------------


def test_cached_and_uncached_results_have_identical_posterior_fields(
    clean_primitive_cache,
):
    """Plan §739 stop-condition test (softened to the in-memory cache):
    cached and uncached calls must agree numerically. Uncached =
    bypass; cached = warm cache."""
    res = _resolution()
    rm = _model(alpha=2.0, beta=3.0)

    with result_cache.cache_bypass_ctx():
        uncached = condition_primitive(
            resolution=res, resolved_model=rm, scenario_seed=42,
        )

    # Now warm the cache and call again under normal conditions.
    cached_first = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
    )
    cached_second = condition_primitive(
        resolution=res, resolved_model=rm, scenario_seed=42,
    )

    # cache_first computed; cache_second came from cache.
    assert cached_first is cached_second

    # Uncached and cached must match field-by-field on the load-bearing
    # posterior moments. Identity is not required (different objects);
    # numerical equivalence is.
    assert uncached.status == cached_first.status
    assert (
        uncached.probability_posterior.mean
        == pytest.approx(cached_first.probability_posterior.mean)
    )
    assert (
        uncached.probability_posterior.sd
        == pytest.approx(cached_first.probability_posterior.sd)
    )
    np.testing.assert_array_equal(
        uncached.probability_posterior.draws,
        cached_first.probability_posterior.draws,
    )
    # Effective evidence totals are part of the posterior provenance
    # — must agree exactly between cached and uncached.
    assert (
        uncached.effective_evidence_totals
        == cached_first.effective_evidence_totals
    )


# ---------------------------------------------------------------------------
# Bypass via ContextVar
# ---------------------------------------------------------------------------


def test_bypass_returns_fresh_object_on_each_call(clean_primitive_cache):
    res = _resolution()
    rm = _model()
    with result_cache.cache_bypass_ctx():
        a = condition_primitive(
            resolution=res, resolved_model=rm, scenario_seed=42,
        )
        b = condition_primitive(
            resolution=res, resolved_model=rm, scenario_seed=42,
        )
    # No cache hit during bypass — different objects each call.
    assert a is not b


def test_bypass_does_not_pollute_cache_for_other_callers(clean_primitive_cache):
    """A bypassed call must not leave a cache entry that a later
    non-bypassed caller would hit."""
    res = _resolution()
    rm = _model()
    with result_cache.cache_bypass_ctx():
        condition_primitive(resolution=res, resolved_model=rm, scenario_seed=42)
    # The cache should still be empty (bypass disables both get and put).
    assert _primitive_cache.stats()['entries'] == 0


def test_bypass_uses_same_contextvar_as_snapshot_cache(clean_primitive_cache):
    """The plan §"Cache Contract" requires a single bypass switch that
    flips every cache. Setting the ContextVar via the snapshot-service
    re-export must therefore bypass the primitive cache too."""
    res = _resolution()
    rm = _model()
    token = snapshot_service.set_cache_bypass(True)
    try:
        a = condition_primitive(
            resolution=res, resolved_model=rm, scenario_seed=42,
        )
        b = condition_primitive(
            resolution=res, resolved_model=rm, scenario_seed=42,
        )
        assert a is not b
        assert _primitive_cache.stats()['entries'] == 0
    finally:
        snapshot_service.reset_cache_bypass(token)


# ---------------------------------------------------------------------------
# Bustcache via the shared registry
# ---------------------------------------------------------------------------


def test_clear_all_flushes_primitive_cache(clean_primitive_cache):
    res = _resolution()
    rm = _model()
    condition_primitive(resolution=res, resolved_model=rm, scenario_seed=42)
    assert _primitive_cache.stats()['entries'] == 1

    result_cache.clear_all()

    assert _primitive_cache.stats()['entries'] == 0


def test_snapshot_cache_clear_flushes_primitive_cache(clean_primitive_cache):
    """``snapshot_service.cache_clear`` is the bustcache hook called by
    snapshot writes (``append_snapshots``, ``delete_snapshots``). It
    delegates to ``result_cache.clear_all()`` so the primitive cache is
    flushed by the same write path that flushes the snapshot cache —
    the §739 stop condition discharged via the registry."""
    res = _resolution()
    rm = _model()
    condition_primitive(resolution=res, resolved_model=rm, scenario_seed=42)
    assert _primitive_cache.stats()['entries'] == 1

    snapshot_service.cache_clear()

    assert _primitive_cache.stats()['entries'] == 0


# ---------------------------------------------------------------------------
# Registry sanity
# ---------------------------------------------------------------------------


def test_primitive_cache_is_registered_under_known_name():
    assert result_cache.get_cache('primitive') is _primitive_cache
    assert _primitive_cache.name == 'primitive'
