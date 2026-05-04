"""
Stage 2 tests for the request-scoped prefix-arrival map (73n).

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 2 — Primitive Evidence Resolution".

These tests cover the evidence-clock invariants that pin the
``arrival_weight[node_id][calendar_day]`` map BEFORE any wiring into
live conditioning. Stage 2 must prove every primitive can read its
prefix-arrival weights from the new map (built on top of the existing
span/carrier composers) before Stage 3 cuts conditioning over.

Test categories covered (from plan §609-627):

  - clock identity (window(X-Y), cohort(A=X), non-latency prefix)
  - deterministic-shift
  - topological-map (build once, reuse across primitives)
  - contexted-source (identity key changes)
  - stochastic-prefix
  - carrier-DAG (upstream diamond/fan-in/fan-out)
  - subject-DAG (downstream diamond from root)
  - boundary-at-X (root selection determines which side owns the map)
  - no-second-timing-path (provider depends only on existing layer)

Other Stage 2 categories — retrieval-superset, as-at, weighted-view,
merge opt-in, mass-accounting, registry-key, outside-in anti-leak,
regime-boundary — live in test_primitive_evidence.py because they
exercise the per-primitive binding layer rather than the prefix-arrival
provider.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from datetime import date, timedelta

import numpy as np
import pytest

from runner.carrier_composition import TransitionPrimitive
from runner.prefix_arrival import (
    NodeArrivalProvenance,
    NodeArrivalWeights,
    PrefixArrivalIdentity,
    PrefixArrivalMap,
    build_prefix_arrival_map,
)


# ─── Fixture helpers ───────────────────────────────────────────────────


def _make_graph(edges):
    """Build a minimal graph for prefix-arrival testing.

    Each ``spec`` is ``(uuid, from_uuid, to_uuid, from_id, to_id)``.
    Edges carry no per-edge p / latency fields — those come from the
    explicit ``transitions`` map passed to build_prefix_arrival_map.
    The default resolver path (resolve_transitions_from_graph) is
    bypassed by supplying ``transitions`` directly to the carrier
    composer through the map builder.
    """
    nodes_by_uuid = {}
    edge_list = []
    for uuid, from_u, to_u, from_id, to_id in edges:
        nodes_by_uuid[from_u] = {'uuid': from_u, 'id': from_id}
        nodes_by_uuid[to_u] = {'uuid': to_u, 'id': to_id}
        edge_list.append({
            'uuid': uuid,
            'from': from_u,
            'to': to_u,
        })
    return {'nodes': list(nodes_by_uuid.values()), 'edges': edge_list}


def _identity(
    *,
    scenario_id: str = "scn-1",
    request_root: str = "A",
    context_key: str | None = None,
    regime_key: str | None = "default",
    as_at: str | None = "2026-04-01",
    model_source_preference: str = "best_available",
    parameter_fingerprint: str = "fp-1",
) -> PrefixArrivalIdentity:
    return PrefixArrivalIdentity(
        scenario_id=scenario_id,
        request_root=request_root,
        context_key=context_key,
        regime_key=regime_key,
        as_at=as_at,
        model_source_preference=model_source_preference,
        parameter_fingerprint=parameter_fingerprint,
    )


def _prim(
    p: float = 0.7,
    *,
    mu: float = 0.0,
    sigma: float = 0.0,
    onset: float = 0.0,
    p_sd: float = 0.0,
    mu_sd: float = 0.0,
    sigma_sd: float = 0.0,
    onset_sd: float = 0.0,
) -> TransitionPrimitive:
    """Construct a TransitionPrimitive. Defaults: pure non-latency
    probability gate (sigma=0). Pass sigma>0 for latent prefixes;
    sigma in [0.01, 0.1) with onset>0 for deterministic-onset
    behaviour (per ``span_kernel._edge_sub_probability_density``)."""
    return TransitionPrimitive(
        p=p, mu=mu, sigma=sigma, onset=onset,
        p_sd=p_sd, mu_sd=mu_sd, sigma_sd=sigma_sd, onset_sd=onset_sd,
        source='test_synthetic',
    )


# ─── Identity test ─────────────────────────────────────────────────────


def test_window_clock_identity_root_equals_primitive_source():
    """plan §611: window(X-Y) primitives source-node U == request root.
    The map's root entry holds ``root_day_weights`` as-is (no
    normalisation). For an identity-mask input ``{d: 1.0 for d in
    window}`` the binder sees weight 1.0 per in-window day and
    preserves full evidence pressure on each row; for a per-day
    population input the builder leaves the absolute mass intact for
    downstream convolution."""
    graph = _make_graph([
        ('e-x-y', 'u-x', 'u-y', 'X', 'Y'),
    ])
    transitions = {('X', 'Y'): _prim(p=0.7, sigma=0.0)}
    root_day_weights = {
        '2026-03-01': 1.0,
        '2026-03-02': 2.0,
        '2026-03-03': 3.0,
    }
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='X',
        root_day_weights=root_day_weights,
        transitions=transitions,
        identity=_identity(request_root='X'),
        max_tau=30,
    )
    root_entry = arrival_map.get('X')
    assert root_entry is not None
    assert root_entry.provenance.topology_case == 'identity'
    # Root entry holds the raw input weights.
    assert root_entry.weight_on('2026-03-01') == pytest.approx(1.0)
    assert root_entry.weight_on('2026-03-02') == pytest.approx(2.0)
    assert root_entry.weight_on('2026-03-03') == pytest.approx(3.0)
    assert sum(root_entry.weights.values()) == pytest.approx(6.0)


def test_cohort_clock_identity_a_equals_x_collapses_to_anchor_clock():
    """plan §611, §201: cohort(A=X) reads the source clock directly.
    The root entry equals the normalised anchor-day weights, even when
    other nodes exist downstream."""
    graph = _make_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B'),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C'),
    ])
    transitions = {
        ('A', 'B'): _prim(p=0.6, sigma=0.4, mu=1.5),
        ('B', 'C'): _prim(p=0.5, sigma=0.0),
    }
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='A',
        root_day_weights={'2026-03-15': 1.0},
        transitions=transitions,
        identity=_identity(),
        max_tau=60,
    )
    root_entry = arrival_map.get('A')
    assert root_entry is not None
    assert root_entry.provenance.topology_case == 'identity'
    assert list(root_entry.weights.keys()) == ['2026-03-15']
    assert root_entry.weights['2026-03-15'] == pytest.approx(1.0)


def test_non_latency_chain_preserves_root_clock_including_tau_zero():
    """plan §611: non-latency prefixes produce the same primitive-local
    day set as the request source clock, INCLUDING tau=0.

    All-non-latency A → B → C: the prefix delay PMF is delta at 0, so
    arrival_weight[C] equals normalised root_day_weights — same days,
    same masses. tau=0 is not skipped."""
    graph = _make_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B'),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C'),
    ])
    transitions = {
        ('A', 'B'): _prim(p=0.7, sigma=0.0),
        ('B', 'C'): _prim(p=0.6, sigma=0.0),
    }
    root_days = {'2026-04-10': 0.4, '2026-04-11': 0.6}
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='A',
        root_day_weights=root_days,
        transitions=transitions,
        identity=_identity(),
        max_tau=30,
    )
    c_entry = arrival_map.get('C')
    assert c_entry is not None
    assert c_entry.provenance.topology_case == 'composed'
    assert c_entry.provenance.has_latency_edge is False
    # Same calendar days as root — Dirac-at-zero shift means no spread.
    assert set(c_entry.weights.keys()) == {'2026-04-10', '2026-04-11'}
    assert c_entry.weights['2026-04-10'] == pytest.approx(0.4)
    assert c_entry.weights['2026-04-11'] == pytest.approx(0.6)


# ─── Deterministic shift ───────────────────────────────────────────────


def test_deterministic_prefix_shifts_clock_by_exact_day_count():
    """plan §612: a synthetic deterministic prefix delay of d days from
    A to U admits evidence on day d_anchor + d, rejects evidence on the
    unshifted anchor day, and keeps the leading primitive on the anchor
    day.

    A near-degenerate lognormal (sigma in [0.01, 0.1), onset=d, mu very
    negative so exp(mu)≈0) places its sub-probability density mass at
    integer index ``d``. See ``span_kernel._edge_sub_probability_density``
    lines 115-122."""
    graph = _make_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B'),
    ])
    delay_days = 5
    transitions = {
        ('A', 'B'): _prim(p=0.9, sigma=0.05, mu=-100.0, onset=float(delay_days)),
    }
    anchor = '2026-03-01'
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='A',
        root_day_weights={anchor: 1.0},
        transitions=transitions,
        identity=_identity(),
        max_tau=30,
    )
    b_entry = arrival_map.get('B')
    assert b_entry is not None
    assert b_entry.provenance.topology_case == 'composed'

    expected_day = (date.fromisoformat(anchor) + timedelta(days=delay_days)).isoformat()
    # All B-arrival mass concentrates on the shifted day.
    assert b_entry.weight_on(expected_day) == pytest.approx(1.0, abs=1e-6)
    # The unshifted anchor day carries zero B-arrival mass.
    assert b_entry.weight_on(anchor) == pytest.approx(0.0, abs=1e-6)
    # The leading primitive (root A) keeps its anchor-day clock.
    a_entry = arrival_map.get('A')
    assert a_entry is not None
    assert a_entry.weight_on(anchor) == pytest.approx(1.0)


# ─── Topological-map: build once, reuse across primitives ──────────────


def test_topological_map_builds_once_and_reuses_across_primitives():
    """plan §613, §195: do not recompute root → U for each primitive.
    Two primitives whose source-node coincides on U must read the SAME
    NodeArrivalWeights object (object identity), not equal-by-value
    duplicates."""
    graph = _make_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B'),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C'),
        ('e-b-d', 'u-b', 'u-d', 'B', 'D'),
    ])
    transitions = {
        ('A', 'B'): _prim(p=0.8, sigma=0.4, mu=1.5),
        ('B', 'C'): _prim(p=0.5, sigma=0.0),
        ('B', 'D'): _prim(p=0.4, sigma=0.0),
    }
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='A',
        root_day_weights={'2026-03-01': 1.0},
        transitions=transitions,
        identity=_identity(),
        max_tau=60,
    )
    # Two downstream primitives share source node B (B→C, B→D). Their
    # arrival_weight[B] reads MUST resolve to the same object — not
    # recomputed.
    b_for_bc = arrival_map.get('B')
    b_for_bd = arrival_map.get('B')
    assert b_for_bc is not None
    assert b_for_bc is b_for_bd, (
        'arrival_weight[B] must be a single shared object across '
        'primitives sharing source node B'
    )


def test_topological_map_does_not_invoke_carrier_composer_after_construction(monkeypatch):
    """plan §613: instrumented sentinel — once the map is built, no
    additional ``compose_carrier_to_x`` calls occur during map
    queries. Lookups are pure dict reads."""
    from runner import prefix_arrival as pa_mod

    graph = _make_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B'),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C'),
    ])
    transitions = {
        ('A', 'B'): _prim(p=0.7, sigma=0.0),
        ('B', 'C'): _prim(p=0.5, sigma=0.0),
    }
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='A',
        root_day_weights={'2026-03-01': 1.0},
        transitions=transitions,
        identity=_identity(),
        max_tau=20,
    )

    # After construction, replace compose_carrier_to_x with a sentinel
    # that fails on call. Repeated map.get(...) must not invoke it.
    def _fail(*_args, **_kwargs):  # pragma: no cover - explicit failure
        raise AssertionError(
            'compose_carrier_to_x called after prefix_arrival map built'
        )
    monkeypatch.setattr(pa_mod, 'compose_carrier_to_x', _fail)

    for _ in range(5):
        for node_id in ('A', 'B', 'C'):
            assert arrival_map.get(node_id) is not None


# ─── Contexted source: identity key changes the map identity ───────────


def test_contexted_source_changes_cache_key():
    """plan §614: changing context, regime, case scope, or
    ``model_source_preference`` changes the prefix-arrival map key.
    Two requests differing only in the context dimension MUST NOT
    accidentally share a map."""
    base = _identity()
    different_context = _identity(context_key='ios')
    different_regime = _identity(regime_key='quarterly')
    different_source = _identity(model_source_preference='analytic_only')
    different_fp = _identity(parameter_fingerprint='fp-2')

    keys = {
        base.cache_key,
        different_context.cache_key,
        different_regime.cache_key,
        different_source.cache_key,
        different_fp.cache_key,
    }
    assert len(keys) == 5, (
        f'identities differing in any single field must produce 5 '
        f'distinct cache keys; got {keys}'
    )


# ─── Stochastic prefix ─────────────────────────────────────────────────


def test_stochastic_prefix_arrival_mean_matches_lognormal_mean():
    """plan §615: a latent-bearing prefix produces ``arrival_weight[U]``
    from the shared prefix-arrival timing provider, and the day weights
    match the differenced prefix CDF within a fixed tolerance.

    For A → B with shifted-lognormal (mu=2.0, sigma=0.4, onset=0), the
    PMF has mean ~ exp(mu + sigma^2/2). The arrival_weight[B] mean (in
    days from the anchor) should equal that (within discretisation
    tolerance from the integer grid)."""
    graph = _make_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B'),
    ])
    mu, sigma = 2.0, 0.4
    transitions = {
        ('A', 'B'): _prim(p=0.95, sigma=sigma, mu=mu, onset=0.0),
    }
    anchor = '2026-03-01'
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='A',
        root_day_weights={anchor: 1.0},
        transitions=transitions,
        identity=_identity(),
        max_tau=200,
    )
    b_entry = arrival_map.get('B')
    assert b_entry is not None
    assert b_entry.provenance.topology_case == 'composed'
    assert b_entry.provenance.has_latency_edge is True

    base = date.fromisoformat(anchor)
    weighted_offset = sum(
        (date.fromisoformat(d) - base).days * w
        for d, w in b_entry.weights.items()
    )
    expected_mean = np.exp(mu + 0.5 * sigma * sigma)
    # The composer normalises K to a conditional CDF with reach pulled
    # out, so the arrival distribution is the shape only — weighted
    # mean should match the shifted-lognormal mean within ~1 day on a
    # 200-day grid.
    assert abs(weighted_offset - expected_mean) <= 1.5, (
        f'arrival_weight[B] mean offset {weighted_offset:.3f} should '
        f'match lognormal mean {expected_mean:.3f}'
    )


# ─── Carrier-DAG topology ──────────────────────────────────────────────


def test_carrier_dag_diamond_arrival_weight_matches_composer_reach():
    """plan §616: a doc 29b-style upstream diamond builds
    ``arrival_weight[X]`` by topological propagation through the shared
    prefix provider. The reach and timing of the resulting entry
    must match the existing ``compose_carrier_to_x`` DAG algebra
    within fixed tolerance.

    Topology:  A → B → X
                  → C → X
    Both legs latent. Reach(A→X) = 0.6*0.5 + 0.4*0.7 = 0.30 + 0.28 = 0.58."""
    from runner.carrier_composition import compose_carrier_to_x

    graph = _make_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B'),
        ('e-a-c', 'u-a', 'u-c', 'A', 'C'),
        ('e-b-x', 'u-b', 'u-x', 'B', 'X'),
        ('e-c-x', 'u-c', 'u-x', 'C', 'X'),
    ])
    transitions = {
        ('A', 'B'): _prim(p=0.6, sigma=0.4, mu=1.5),
        ('A', 'C'): _prim(p=0.4, sigma=0.4, mu=1.6),
        ('B', 'X'): _prim(p=0.5, sigma=0.4, mu=1.4),
        ('C', 'X'): _prim(p=0.7, sigma=0.4, mu=1.6),
    }
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='A',
        root_day_weights={'2026-03-01': 1.0},
        transitions=transitions,
        identity=_identity(),
        max_tau=120,
    )
    composed_carrier = compose_carrier_to_x(
        graph=graph,
        anchor_node_id='A',
        denominator_node_id='X',
        is_window=False,
        transitions=transitions,
        max_tau=120,
    )
    assert composed_carrier.is_active
    x_entry = arrival_map.get('X')
    assert x_entry is not None
    assert x_entry.provenance.topology_case == 'composed'
    # Reach matches.
    assert x_entry.reach_from_root == pytest.approx(
        composed_carrier.reach, abs=1e-9,
    )
    # Day-weight shape matches the differenced conditional CDF (modulo
    # normalisation): the cumulative weight at each tau equals the CDF
    # at that tau.
    base = date.fromisoformat('2026-03-01')
    cdf_built = []
    cumulative = 0.0
    for tau in range(0, 120 + 1):
        d = (base + timedelta(days=tau)).isoformat()
        cumulative += x_entry.weights.get(d, 0.0)
        cdf_built.append(cumulative)
    composer_cdf = composed_carrier.deterministic_cdf
    # Compare across the support — looser tolerance than 1e-9 because
    # the builder normalises across the calendar days; the composer's
    # CDF is per-tau over the integer grid.
    diff = max(
        abs(cdf_built[tau] - float(composer_cdf[tau]))
        for tau in range(len(composer_cdf))
    )
    assert diff < 1e-6, (
        f'arrival_weight[X] cumulative shape diverges from composer CDF: '
        f'max abs diff {diff}'
    )


# ─── Subject-DAG topology ──────────────────────────────────────────────


def test_subject_dag_fanout_subject_primitives_share_root_arrival():
    """plan §617: a doc 29b-style downstream diamond/fan-in/fan-out
    fixture enumerates and binds all subject-side primitives needed by
    the composed subject_span without recomputing per-primitive
    prefixes independently.

    For window mode root=X, every primitive's source-side reads from
    the same root entry. The map MUST expose all three downstream
    target nodes (Y, Y', Z) as composed entries derived from one
    construction call."""
    graph = _make_graph([
        ('e-x-y', 'u-x', 'u-y', 'X', 'Y'),
        ('e-x-y2', 'u-x', 'u-y2', 'X', 'Y2'),
        ('e-y-z', 'u-y', 'u-z', 'Y', 'Z'),
        ('e-y2-z', 'u-y2', 'u-z', 'Y2', 'Z'),
    ])
    transitions = {
        ('X', 'Y'): _prim(p=0.5, sigma=0.4, mu=1.5),
        ('X', 'Y2'): _prim(p=0.5, sigma=0.4, mu=1.7),
        ('Y', 'Z'): _prim(p=0.6, sigma=0.4, mu=1.6),
        ('Y2', 'Z'): _prim(p=0.6, sigma=0.4, mu=1.6),
    }
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='X',
        root_day_weights={'2026-04-01': 1.0},
        transitions=transitions,
        identity=_identity(request_root='X'),
        max_tau=120,
    )
    for nid in ('X', 'Y', 'Y2', 'Z'):
        entry = arrival_map.get(nid)
        assert entry is not None, f'expected entry for node {nid!r}'
    # Subject-side primitives sharing source node Y or Y2 read the
    # same per-source-node weights without re-derivation.
    assert arrival_map.get('Y') is arrival_map.get('Y')
    assert arrival_map.get('Y2') is arrival_map.get('Y2')


# ─── Boundary at X ─────────────────────────────────────────────────────


def test_boundary_join_at_x_carrier_owns_upstream_primitives():
    """plan §618: a join at X is owned by carrier_to_x. With root=A
    and a join at X, the carrier-side primitives (A→B, A→C, B→X, C→X)
    have their source nodes populated; downstream primitives' source
    nodes (X) have a composed entry that is the carrier readout."""
    graph = _make_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B'),
        ('e-a-c', 'u-a', 'u-c', 'A', 'C'),
        ('e-b-x', 'u-b', 'u-x', 'B', 'X'),
        ('e-c-x', 'u-c', 'u-x', 'C', 'X'),
        ('e-x-y', 'u-x', 'u-y', 'X', 'Y'),
    ])
    transitions = {
        ('A', 'B'): _prim(p=0.6, sigma=0.4, mu=1.5),
        ('A', 'C'): _prim(p=0.4, sigma=0.4, mu=1.6),
        ('B', 'X'): _prim(p=0.5, sigma=0.4, mu=1.4),
        ('C', 'X'): _prim(p=0.7, sigma=0.4, mu=1.6),
        ('X', 'Y'): _prim(p=0.5, sigma=0.4, mu=1.7),
    }
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='A',
        root_day_weights={'2026-04-01': 1.0},
        transitions=transitions,
        identity=_identity(request_root='A'),
        max_tau=120,
    )
    # Carrier-side: B, C, X are composed entries reachable from A.
    for nid in ('A', 'B', 'C', 'X'):
        entry = arrival_map.get(nid)
        assert entry is not None
        assert entry.provenance.topology_case in ('identity', 'composed'), (
            f'node {nid!r} expected identity/composed; got '
            f'{entry.provenance.topology_case}'
        )
    # Subject-side primitive X→Y reads arrival_weight[X] — that's the
    # carrier-side join readout. The same map serves both roles.
    x_entry = arrival_map.get('X')
    assert x_entry is not None
    assert x_entry.provenance.topology_case == 'composed'
    assert x_entry.provenance.composed_edges >= 2, (
        f'X has two upstream contributors via the diamond; got '
        f'composed_edges={x_entry.provenance.composed_edges}'
    )


def test_boundary_split_at_x_subject_primitives_read_root_for_window_mode():
    """plan §618: a split at X is owned by subject_span. In window mode
    (root=X), each downstream alternative reads X's arrival as the
    request source clock — primitives never reuse the carrier-side
    topology for binding evidence."""
    graph = _make_graph([
        ('e-x-y', 'u-x', 'u-y', 'X', 'Y'),
        ('e-x-z', 'u-x', 'u-z', 'X', 'Z'),
    ])
    transitions = {
        ('X', 'Y'): _prim(p=0.5, sigma=0.0),
        ('X', 'Z'): _prim(p=0.4, sigma=0.4, mu=1.7),
    }
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='X',
        root_day_weights={'2026-04-01': 1.0},
        transitions=transitions,
        identity=_identity(request_root='X'),
        max_tau=60,
    )
    # X is the identity root; primitives X→Y and X→Z both read it as
    # source clock.
    x_entry = arrival_map.get('X')
    assert x_entry is not None
    assert x_entry.provenance.topology_case == 'identity'
    assert x_entry.weight_on('2026-04-01') == pytest.approx(1.0)


# ─── No second timing path ─────────────────────────────────────────────


def test_no_second_timing_path_module_imports_only_existing_layer():
    """plan §620: evidence-clock alignment reads prefix timing from the
    same provider as later subject/carrier composition. Static import
    check — the prefix_arrival module must not import from any other
    timing implementation."""
    import runner.prefix_arrival as pa_mod
    import inspect
    src = inspect.getsource(pa_mod)
    # Allowed imports: stdlib (datetime, hashlib, dataclasses, typing),
    # numpy, and the existing carrier_composition module which itself
    # routes through span_kernel. NOT allowed: any second timing path.
    forbidden = (
        'from .forecast_runtime',
        'from .forecast_state',
        'from .cohort_forecast',
        'from .lag_distribution_utils',
        'from .span_evidence',
        'import lag_distribution_utils',
    )
    for needle in forbidden:
        assert needle not in src, (
            f'prefix_arrival must not import {needle!r}; '
            'every prefix delay PMF must come from the existing '
            'span/carrier composition layer (plan §605)'
        )


# ─── Construction diagnostics ──────────────────────────────────────────


def test_degraded_entry_carries_explicit_reason_for_no_path_node():
    """plan §605: cases recorded as degraded or unsupported produce a
    degraded entry with explicit provenance, never a silently
    approximate weight.

    A node disconnected from the root must produce a degraded entry
    with topology_case='degraded' and a non-empty note."""
    graph = _make_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B'),
        # Z is in the graph but has no incoming edge from A.
    ])
    # Add a stranded node Z so node enumeration sees it.
    graph['nodes'].append({'uuid': 'u-z', 'id': 'Z'})
    transitions = {('A', 'B'): _prim(p=0.7, sigma=0.0)}
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='A',
        root_day_weights={'2026-03-01': 1.0},
        transitions=transitions,
        identity=_identity(),
        max_tau=20,
    )
    z_entry = arrival_map.get('Z')
    assert z_entry is not None
    assert z_entry.is_degraded
    assert z_entry.weights == {}
    assert z_entry.reach_from_root == 0.0
    assert z_entry.provenance.note != ''
    # The degraded list carries this node.
    assert 'Z' in arrival_map.degraded_nodes


def test_root_day_weights_pass_through_unchanged_to_root_entry():
    """The root entry holds the input ``root_day_weights`` verbatim
    (no normalisation). Identity-mask inputs ``{d: 1.0 for d in
    window}`` therefore preserve a row's full evidence pressure when
    the binder multiplies the row's ``n,k`` by the weight on the
    observed day. Downstream nodes still produce normalised arrival
    distributions because the convolution step normalises internally."""
    graph = _make_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B'),
    ])
    transitions = {('A', 'B'): _prim(p=0.7, sigma=0.0)}
    arrival_map = build_prefix_arrival_map(
        graph=graph,
        root_node_id='A',
        root_day_weights={'2026-03-01': 17.0, '2026-03-02': 33.0},
        transitions=transitions,
        identity=_identity(),
        max_tau=20,
    )
    a_entry = arrival_map.get('A')
    b_entry = arrival_map.get('B')
    assert a_entry is not None and b_entry is not None
    # Root entry holds the input weights as-is.
    assert a_entry.weights['2026-03-01'] == pytest.approx(17.0)
    assert a_entry.weights['2026-03-02'] == pytest.approx(33.0)
    # Downstream entries are normalised (convolution divides by the
    # input mass total), so they remain probability distributions.
    assert sum(b_entry.weights.values()) == pytest.approx(1.0)
