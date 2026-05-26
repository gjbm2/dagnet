"""
Stage 2 tests for primitive-local evidence resolution (73n).

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 2 — Primitive Evidence Resolution".

These tests cover the per-primitive binding layer that consumes the
prefix-arrival map: ``EvidenceScope`` construction, the unchanged shared
merge call, weighted day binding to the primitive-local clock, the
retrieval superset planner, the request-scoped registry, and span
metadata validation. The prefix-arrival map's correctness is covered
in test_prefix_arrival.py; this file relies on those invariants.

Test categories covered (from plan §609-627):

  - retrieval-superset
  - as-at
  - weighted-view
  - merge opt-in (no change to unrelated callers)
  - mass-accounting (totals come from weighted view)
  - registry-key (clock identity participates in the key)
  - outside-in anti-leak
  - regime-boundary (span primitive validator)
  - WP8 default-off (cohort role rejected)
  - shadow inventory (to_provenance_dict)

Mended from `_attic/test_primitive_evidence.py` per
docs/current/project-bayes/73-attic-mending-process.md. Migration:
`runner.carrier_composition.TransitionPrimitive` →
`runner.timing_span.TimingTransitionPrimitive` (identical fields;
the carrier_composition module was deleted by the 73n CF
generalisation in commit e15e9a9b).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from datetime import date, timedelta

import pytest

from evidence_merge import (
    EvidenceCandidate,
    EvidenceIdentity,
    EvidenceRole,
    EvidenceScope,
    ObservationCoordinate,
    SliceFamily,
    SourceKind,
    TemporalBasis,
    merge_evidence_candidates,
)
from runner.prefix_arrival import (
    PrefixArrivalIdentity,
    build_prefix_arrival_map,
)
from runner.primitive_evidence import (
    PrimitiveBindingError,
    RequestPrimitiveRegistry,
    SpanPrimitiveMetadata,
    bind_primitive_evidence,
    derive_retrieval_superset,
    make_primitive_scope_from_evidence_scope,
    validate_span_primitive,
)
from runner.primitives import TransitionIdentity
from runner.timing_span import TimingTransitionPrimitive


# ─── Fixture helpers ───────────────────────────────────────────────────


def _make_graph(edges):
    nodes_by_uuid = {}
    edge_list = []
    for uuid, from_u, to_u, from_id, to_id in edges:
        nodes_by_uuid[from_u] = {'uuid': from_u, 'id': from_id}
        nodes_by_uuid[to_u] = {'uuid': to_u, 'id': to_id}
        edge_list.append({'uuid': uuid, 'from': from_u, 'to': to_u})
    return {'nodes': list(nodes_by_uuid.values()), 'edges': edge_list}


def _prim(p=0.7, *, mu=0.0, sigma=0.0, onset=0.0, **kw) -> TimingTransitionPrimitive:
    return TimingTransitionPrimitive(
        p=p, mu=mu, sigma=sigma, onset=onset,
        p_sd=0.0, mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0,
        source='test_synthetic',
        **kw,
    )


def _identity(
    *,
    scenario_id='scn-1',
    request_root='A',
    context_key=None,
    regime_key='default',
    as_at='2026-04-01',
    model_source_preference='best_available',
    parameter_fingerprint='fp-1',
):
    return PrefixArrivalIdentity(
        scenario_id=scenario_id,
        request_root=request_root,
        context_key=context_key,
        regime_key=regime_key,
        as_at=as_at,
        model_source_preference=model_source_preference,
        parameter_fingerprint=parameter_fingerprint,
    )


def _evidence_scope(
    *,
    subject_from='U',
    subject_to='V',
    date_from='2026-03-01',
    date_to='2026-03-31',
    as_at='2026-04-01',
    role=EvidenceRole.WINDOW_SUBJECT_HELPER,
    scenario_id='scn-1',
    context_key=None,
    regime_key=None,
):
    return EvidenceScope(
        role=role,
        subject_from=subject_from,
        subject_to=subject_to,
        date_from=date_from,
        date_to=date_to,
        as_at=as_at,
        scenario_id=scenario_id,
        anchor=None,
        context_key=context_key,
        regime_key=regime_key,
    )


def _candidate(
    *,
    observed_date,
    n,
    k,
    subject_from='U',
    subject_to='V',
    source=SourceKind.SNAPSHOT,
    role=EvidenceRole.WINDOW_SUBJECT_HELPER,
    slice_family=SliceFamily.WINDOW,
    retrieved_at='2026-04-01',
    asat_materialised=False,
    context_key=None,
    regime_key=None,
):
    return EvidenceCandidate(
        source=source,
        identity=EvidenceIdentity(
            role=role,
            subject_from=subject_from,
            subject_to=subject_to,
            anchor=None,
            slice_family=slice_family,
            context_key=context_key,
            regime_key=regime_key,
            population_identity=None,
        ),
        coordinate=ObservationCoordinate(
            observed_date=observed_date,
            retrieved_at=retrieved_at,
            temporal_basis=TemporalBasis.WINDOW_DAY,
            asat_materialised=asat_materialised,
        ),
        n=n,
        k=k,
        provenance={},
    )


def _build_arrival_map(
    graph,
    root,
    root_day_weights,
    transitions,
    *,
    identity=None,
    max_tau=60,
    target_node_ids=None,
):
    return build_prefix_arrival_map(
        graph=graph,
        root_node_id=root,
        root_day_weights=root_day_weights,
        transitions=transitions,
        identity=identity or _identity(request_root=root),
        max_tau=max_tau,
        target_node_ids=target_node_ids,
    )


# ─── Stop condition: window-mode totals match raw totals ───────────────


def test_window_mode_weighted_totals_equal_raw_totals():
    """plan §"Stop condition" (line 629): primitive evidence totals
    match existing window evidence totals for simple window queries.

    Window mode: root == primitive source U. arrival_weight[U] equals
    the normalised window day set, so the weighted totals are the raw
    totals scaled by the (uniform) per-day weights — and when only one
    day carries evidence, the bound row's n_weighted == n * 1.0."""
    graph = _make_graph([('e-u-v', 'u-u', 'u-v', 'U', 'V')])
    transitions = {('U', 'V'): _prim(p=0.7)}
    arrival_map = _build_arrival_map(
        graph, 'U', {'2026-03-15': 1.0}, transitions,
    )
    candidates = [
        _candidate(observed_date='2026-03-15', n=20, k=8),
    ]
    transition = TransitionIdentity('U', 'V', 'e-u-v')
    ev_scope = _evidence_scope()
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    res = bind_primitive_evidence(
        transition=transition,
        primitive_scope=primitive_scope,
        evidence_scope=ev_scope,
        candidates=candidates,
        arrival_weights=arrival_map.get('U'),
    )
    assert res.weighted_view is not None
    assert res.weighted_view.n_weighted_total == pytest.approx(20.0)
    assert res.weighted_view.k_weighted_total == pytest.approx(8.0)
    assert res.raw_evidence_set.totals.n == 20
    assert res.raw_evidence_set.totals.k == 8


# ─── WP8 default-off: cohort role rejected ─────────────────────────────


def test_wp8_default_off_rejects_cohort_role():
    """plan §"Stop condition" line 629; baseline §1.13 WP8 default-off:
    no cohort-family rows are admitted while WP8 is default-off. The
    primitive evidence binder MUST refuse a DIRECT_COHORT_EXACT_SUBJECT
    role even if the caller supplies cohort candidates."""
    graph = _make_graph([('e-u-v', 'u-u', 'u-v', 'U', 'V')])
    transitions = {('U', 'V'): _prim(p=0.7)}
    arrival_map = _build_arrival_map(
        graph, 'U', {'2026-03-15': 1.0}, transitions,
    )
    transition = TransitionIdentity('U', 'V', 'e-u-v')
    ev_scope = _evidence_scope(role=EvidenceRole.DIRECT_COHORT_EXACT_SUBJECT)
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    with pytest.raises(PrimitiveBindingError):
        bind_primitive_evidence(
            transition=transition,
            primitive_scope=primitive_scope,
            evidence_scope=ev_scope,
            candidates=[],
            arrival_weights=arrival_map.get('U'),
        )


# ─── Weighted view: contradictory evidence on two local days ───────────


def test_weighted_view_weights_contradictory_days_by_arrival_weight():
    """plan §623: contradictory evidence on two local days is weighted
    according to ``arrival_weight[U]``, and the likelihood consumes
    weighted n/k rather than raw retrieval-superset totals.

    Construct two days with contradictory rates (one 0/n, one n/n).
    Set arrival_weight[U] uniform over the two days. The weighted
    totals should be (n_total/2, n_total/4) — half the rows count
    fully, half count zero, so k_weighted = (0+n)/2 = n/2."""
    graph = _make_graph([('e-u-v', 'u-u', 'u-v', 'U', 'V')])
    transitions = {('U', 'V'): _prim(p=0.7)}
    arrival_map = _build_arrival_map(
        graph, 'U',
        {'2026-03-10': 1.0, '2026-03-12': 1.0},
        transitions,
    )
    candidates = [
        _candidate(observed_date='2026-03-10', n=20, k=20),
        _candidate(observed_date='2026-03-12', n=20, k=0),
    ]
    transition = TransitionIdentity('U', 'V', 'e-u-v')
    ev_scope = _evidence_scope()
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    res = bind_primitive_evidence(
        transition=transition,
        primitive_scope=primitive_scope,
        evidence_scope=ev_scope,
        candidates=candidates,
        arrival_weights=arrival_map.get('U'),
    )
    assert res.weighted_view is not None
    # Root entry holds {'2026-03-10': 1.0, '2026-03-12': 1.0} as-is —
    # an identity mask, not a normalised distribution. Each in-window
    # row therefore carries weight 1.0:
    #   n_weighted_total = 1.0 * 20 + 1.0 * 20 = 40
    #   k_weighted_total = 1.0 * 20 + 1.0 *  0 = 20
    assert res.weighted_view.n_weighted_total == pytest.approx(40.0)
    assert res.weighted_view.k_weighted_total == pytest.approx(20.0)


def test_weighted_view_skewed_arrival_weight_drives_skewed_k():
    """If 80% of arrivals land on day A (which contradicts) and 20% on
    day B (which agrees), the weighted k must reflect the 80/20 mix —
    not the unweighted raw mean."""
    graph = _make_graph([('e-u-v', 'u-u', 'u-v', 'U', 'V')])
    transitions = {('U', 'V'): _prim(p=0.7)}
    arrival_map = _build_arrival_map(
        graph, 'U',
        {'2026-03-10': 0.8, '2026-03-12': 0.2},
        transitions,
    )
    candidates = [
        _candidate(observed_date='2026-03-10', n=10, k=2),    # 0.2 rate
        _candidate(observed_date='2026-03-12', n=10, k=10),   # 1.0 rate
    ]
    transition = TransitionIdentity('U', 'V', 'e-u-v')
    ev_scope = _evidence_scope()
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    res = bind_primitive_evidence(
        transition=transition,
        primitive_scope=primitive_scope,
        evidence_scope=ev_scope,
        candidates=candidates,
        arrival_weights=arrival_map.get('U'),
    )
    assert res.weighted_view is not None
    n_w = res.weighted_view.n_weighted_total
    k_w = res.weighted_view.k_weighted_total
    # n_w = 0.8*10 + 0.2*10 = 10
    # k_w = 0.8*2 + 0.2*10 = 1.6 + 2.0 = 3.6
    assert n_w == pytest.approx(10.0)
    assert k_w == pytest.approx(3.6)
    weighted_rate = k_w / n_w if n_w > 0 else 0.0
    raw_rate = (
        res.raw_evidence_set.totals.k / res.raw_evidence_set.totals.n
        if res.raw_evidence_set.totals.n > 0 else 0.0
    )
    # The raw mean would be 12/20 = 0.6; the weighted mean is 0.36 —
    # tracking the 80% mass on the contradicting day.
    assert weighted_rate == pytest.approx(0.36)
    assert raw_rate == pytest.approx(0.6)


# ─── Outside-in anti-leak ──────────────────────────────────────────────


def test_outside_in_anti_leak_downstream_primitive_conditions_on_shifted_day():
    """plan §627: construct contradictory evidence on the anchor day
    and the shifted downstream day; the downstream primitive must
    condition on the shifted evidence (its local clock) and not the
    anchor-day evidence.

    Topology: A → U (deterministic 5-day delay) → V. Cohort anchor
    on 2026-03-01. The bucket-centred midpoint stencil
    (``cdf_to_bucket_transition`` with ``read_offset=0.5``) spreads
    a deterministic onset CDF across two adjacent calendar days, so
    for primitive U → V ``arrival_weight[U]`` is
    ``{2026-03-05: 0.5, 2026-03-06: 0.5}`` rather than a delta on
    a single day. Anchor-day evidence on 2026-03-01 (high rate)
    must NOT bleed into U→V's bound view; downstream-day evidence
    on the two clock-supported days (low rate) is the only thing
    the primitive conditions on."""
    graph = _make_graph([
        ('e-a-u', 'u-a', 'u-u', 'A', 'U'),
        ('e-u-v', 'u-u', 'u-v', 'U', 'V'),
    ])
    transitions = {
        ('A', 'U'): _prim(p=0.95, sigma=0.05, mu=-100.0, onset=5.0),
        ('U', 'V'): _prim(p=0.5),
    }
    arrival_map = _build_arrival_map(
        graph, 'A', {'2026-03-01': 1.0}, transitions,
    )
    # Evidence retrieval superset includes both anchor-day-aligned
    # rows and downstream-day rows (the BE call doesn't know which
    # primitive each row belongs to). The downstream evidence sits on
    # both days the midpoint stencil places arrival mass on.
    candidates = [
        _candidate(observed_date='2026-03-01', n=10, k=10),  # high — anchor-day, must not bleed
        _candidate(observed_date='2026-03-05', n=10, k=2),   # low — clock-supported
        _candidate(observed_date='2026-03-06', n=10, k=2),   # low — clock-supported
    ]
    transition_uv = TransitionIdentity('U', 'V', 'e-u-v')
    ev_scope = _evidence_scope(date_from='2026-03-01', date_to='2026-03-10')
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    res = bind_primitive_evidence(
        transition=transition_uv,
        primitive_scope=primitive_scope,
        evidence_scope=ev_scope,
        candidates=candidates,
        arrival_weights=arrival_map.get('U'),
    )
    assert res.weighted_view is not None
    # All rows bind; the anchor-day row carries zero clock weight.
    bound_dates = sorted(r.observed_date for r in res.weighted_view.rows)
    assert bound_dates == ['2026-03-01', '2026-03-05', '2026-03-06']
    assert res.diagnostics.zero_clock_weight_row_count == 1
    assert res.diagnostics.bound_point_count == 3
    # Weighted totals reflect ONLY the downstream-day evidence —
    # 0.5 * 10 + 0.5 * 10 = 10, 0.5 * 2 + 0.5 * 2 = 2.
    assert res.weighted_view.n_weighted_total == pytest.approx(10.0)
    assert res.weighted_view.k_weighted_total == pytest.approx(2.0)


# ─── As-at admission with primitive-local clocks ───────────────────────


def test_as_at_admission_uses_retrieved_at_not_anchor_day():
    """plan §622, baseline §3.1: a downstream primitive-local evidence
    day after the anchor date is admitted only when its retrieved_at
    satisfies the request as-at boundary, regardless of how the
    primitive-local day relates to the anchor.

    Candidates on the two clock-supported days
    (``arrival_weight[U] = {2026-03-05: 0.5, 2026-03-06: 0.5}`` —
    see test_outside_in_anti_leak for the midpoint-stencil rationale):
    each day has one row retrieved before as_at=2026-04-01 (admitted)
    and one retrieved after (rejected by merge as 'after_as_at').
    The primitive-local day is later than the anchor — that does NOT
    cause rejection."""
    graph = _make_graph([
        ('e-a-u', 'u-a', 'u-u', 'A', 'U'),
        ('e-u-v', 'u-u', 'u-v', 'U', 'V'),
    ])
    transitions = {
        ('A', 'U'): _prim(p=0.95, sigma=0.05, mu=-100.0, onset=5.0),
        ('U', 'V'): _prim(p=0.5),
    }
    arrival_map = _build_arrival_map(
        graph, 'A', {'2026-03-01': 1.0}, transitions,
    )
    candidates = [
        _candidate(
            observed_date='2026-03-05', n=10, k=3,
            retrieved_at='2026-03-15',  # before as_at — admitted
        ),
        _candidate(
            observed_date='2026-03-05', n=10, k=9,
            retrieved_at='2026-04-15',  # after as_at — rejected
        ),
        _candidate(
            observed_date='2026-03-06', n=10, k=3,
            retrieved_at='2026-03-15',  # before as_at — admitted
        ),
        _candidate(
            observed_date='2026-03-06', n=10, k=9,
            retrieved_at='2026-04-15',  # after as_at — rejected
        ),
    ]
    transition_uv = TransitionIdentity('U', 'V', 'e-u-v')
    ev_scope = _evidence_scope(
        date_from='2026-03-01', date_to='2026-03-10',
        as_at='2026-04-01',
    )
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    res = bind_primitive_evidence(
        transition=transition_uv,
        primitive_scope=primitive_scope,
        evidence_scope=ev_scope,
        candidates=candidates,
        arrival_weights=arrival_map.get('U'),
    )
    # The merge layer rejects the after-as_at candidates; two admitted
    # rows on the shifted clock (one per clock-supported day).
    assert res.diagnostics.raw_point_count == 2
    assert res.weighted_view is not None
    # 0.5 * 10 + 0.5 * 10 = 10; 0.5 * 3 + 0.5 * 3 = 3.
    assert res.weighted_view.n_weighted_total == pytest.approx(10.0)
    assert res.weighted_view.k_weighted_total == pytest.approx(3.0)


# ─── Retrieval superset ────────────────────────────────────────────────


def test_retrieval_superset_envelopes_all_primitive_local_clocks():
    """plan §621, §326: the retrieval layer fetches rows outside the
    public anchor date bounds when a downstream primitive's local clock
    requires them.

    Topology: A → B (delay 3) → C (delay 7). Anchor on 2026-03-01.
    Primitive A→B's source clock is 2026-03-01. The bucket-centred
    midpoint stencil (``cdf_to_bucket_transition`` with
    ``read_offset=0.5``) spreads each deterministic onset CDF across
    two adjacent calendar days, so primitive B→C's source clock spans
    [2026-03-03, 2026-03-04] and primitive C→D's source clock spans
    [2026-03-10, 2026-03-11]. The retrieval superset must envelope
    the union: [2026-03-01, 2026-03-11]."""
    graph = _make_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B'),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C'),
        ('e-c-d', 'u-c', 'u-d', 'C', 'D'),
    ])
    transitions = {
        ('A', 'B'): _prim(p=0.8, sigma=0.05, mu=-100.0, onset=3.0),
        ('B', 'C'): _prim(p=0.7, sigma=0.05, mu=-100.0, onset=7.0),
        ('C', 'D'): _prim(p=0.6),
    }
    arrival_map = _build_arrival_map(
        graph, 'A', {'2026-03-01': 1.0}, transitions, max_tau=60,
    )
    spec = derive_retrieval_superset(
        arrival_map=arrival_map,
        primitive_source_nodes=['A', 'B', 'C'],
        as_at='2026-04-01',
    )
    assert spec.date_from == '2026-03-01'
    assert spec.date_to == '2026-03-11'  # 3 + 7 + 0 = 10 days from anchor → 11th
    # Each primitive's local extent is recorded; the midpoint stencil
    # places arrival mass on the two adjacent days bracketing the
    # deterministic onset (root day for A is exact identity).
    assert spec.primitive_clock_extents['A'] == ('2026-03-01', '2026-03-01')
    assert spec.primitive_clock_extents['B'] == ('2026-03-03', '2026-03-04')
    assert spec.primitive_clock_extents['C'] == ('2026-03-10', '2026-03-11')


# ─── Merge opt-in: unrelated callers see no behavioural change ─────────


def test_merge_evidence_candidates_signature_unchanged_for_non_primitive_callers():
    """plan §624: primitive weighted binding is active for primitive
    evidence scopes and does not silently change unrelated callers of
    merge_evidence_candidates.

    Non-primitive callers that import merge_evidence_candidates and
    use it with a window-mode scope must see the same EvidenceSet as
    they would have seen before Stage 2. This test calls
    merge_evidence_candidates directly with a scope and confirms its
    integer totals and provenance shape are intact — no weighted-view
    fields, no new totals, no behaviour change."""
    scope = _evidence_scope(subject_from='C', subject_to='D')
    candidates = [
        _candidate(
            observed_date='2026-03-15', n=10, k=4,
            subject_from='C', subject_to='D',
        ),
    ]
    raw = merge_evidence_candidates(scope, candidates)
    # EvidenceSet keeps integer totals — non-primitive callers see no
    # weighted-view fields injected.
    assert isinstance(raw.totals.n, int)
    assert isinstance(raw.totals.k, int)
    assert raw.totals.n == 10
    assert raw.totals.k == 4
    # No weighted_view attribute on EvidenceSet.
    assert not hasattr(raw, 'weighted_view')
    assert not hasattr(raw, 'n_weighted_total')


# ─── Mass accounting (admitted rows, not retrieval superset) ───────────


def test_zero_clock_weight_rows_bind_but_do_not_contribute_weighted_mass():
    """Primitive evidence resolution keeps the retrieval superset shape and
    lets clock weights decide contribution. Rows outside clock support stay
    visible with zero weighted mass instead of being clipped."""
    graph = _make_graph([
        ('e-a-u', 'u-a', 'u-u', 'A', 'U'),
        ('e-u-v', 'u-u', 'u-v', 'U', 'V'),
    ])
    transitions = {
        ('A', 'U'): _prim(p=0.9, sigma=0.05, mu=-100.0, onset=2.0),
        ('U', 'V'): _prim(p=0.6),
    }
    arrival_map = _build_arrival_map(
        graph, 'A', {'2026-03-01': 1.0}, transitions, max_tau=10,
    )
    # arrival_weight[U] = {2026-03-02: 0.5, 2026-03-03: 0.5} — the
    # bucket-centred midpoint stencil spreads a deterministic onset CDF
    # across two adjacent days (see test_outside_in_anti_leak for the
    # midpoint rationale).
    candidates = [
        _candidate(observed_date='2026-03-02', n=10, k=4),  # primitive day
        _candidate(observed_date='2026-03-03', n=10, k=4),  # primitive day
        _candidate(observed_date='2026-03-05', n=20, k=8),  # zero clock weight
    ]
    transition_uv = TransitionIdentity('U', 'V', 'e-u-v')
    ev_scope = _evidence_scope(
        date_from='2026-03-01', date_to='2026-03-10',
        subject_from='U', subject_to='V',
    )
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    res = bind_primitive_evidence(
        transition=transition_uv,
        primitive_scope=primitive_scope,
        evidence_scope=ev_scope,
        candidates=candidates,
        arrival_weights=arrival_map.get('U'),
    )
    assert res.weighted_view is not None
    raw_bound_n = sum(row.n for row in res.weighted_view.rows)
    assert raw_bound_n == 40
    assert res.diagnostics.zero_clock_weight_row_count == 1
    assert res.diagnostics.bound_point_count == 3
    # 0.5 * 10 + 0.5 * 10 = 10; 0.5 * 4 + 0.5 * 4 = 4. The 2026-03-05
    # row binds with zero clock weight and contributes no weighted mass.
    assert res.weighted_view.n_weighted_total == pytest.approx(10.0)
    assert res.weighted_view.k_weighted_total == pytest.approx(4.0)
    # The retrieval superset's raw row count is 40, but only the rows with
    # non-zero clock weight contribute weighted likelihood pressure.
    assert res.raw_evidence_set.totals.n == 40


# ─── Registry key includes evidence-clock alignment ────────────────────


def test_registry_key_includes_evidence_clock_alignment_identity():
    """plan §626: primitive cache/registry keys include the
    evidence-clock alignment identity, so two scenarios with the same
    edge but different induced local clocks cannot share a posterior
    accidentally.

    Construct two registries: one with arrival map identity X, one
    with identity Y. Register a primitive with the same transition
    and primitive_scope in each. The keys returned must differ."""
    graph = _make_graph([('e-u-v', 'u-u', 'u-v', 'U', 'V')])
    transitions = {('U', 'V'): _prim(p=0.7)}

    # Two arrival maps differing only in identity.
    map_x = _build_arrival_map(
        graph, 'U', {'2026-03-15': 1.0}, transitions,
        identity=_identity(parameter_fingerprint='fp-X'),
    )
    map_y = _build_arrival_map(
        graph, 'U', {'2026-03-15': 1.0}, transitions,
        identity=_identity(parameter_fingerprint='fp-Y'),
    )

    transition = TransitionIdentity('U', 'V', 'e-u-v')
    ev_scope = _evidence_scope()
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )

    def _bind(amap):
        return bind_primitive_evidence(
            transition=transition,
            primitive_scope=primitive_scope,
            evidence_scope=ev_scope,
            candidates=[_candidate(observed_date='2026-03-15', n=10, k=4)],
            arrival_weights=amap.get('U'),
        )

    reg_x = RequestPrimitiveRegistry(arrival_map=map_x)
    reg_y = RequestPrimitiveRegistry(arrival_map=map_y)
    key_x = reg_x.register(_bind(map_x))
    key_y = reg_y.register(_bind(map_y))
    assert key_x != key_y, (
        'registry keys must differ when the prefix-arrival identity '
        'differs, even if the primitive identity and scope are equal'
    )


def test_registry_within_one_request_dedupes_same_primitive_scope():
    """Plan §314, §316: the resolver dedupes primitives by scope so the
    same U→V primitive is conditioned once per scenario/scope. The
    registry MUST refuse a duplicate registration for the same
    (transition, primitive_scope) under one identity."""
    graph = _make_graph([('e-u-v', 'u-u', 'u-v', 'U', 'V')])
    transitions = {('U', 'V'): _prim(p=0.7)}
    amap = _build_arrival_map(
        graph, 'U', {'2026-03-15': 1.0}, transitions,
    )
    transition = TransitionIdentity('U', 'V', 'e-u-v')
    ev_scope = _evidence_scope()
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )

    def _bind():
        return bind_primitive_evidence(
            transition=transition,
            primitive_scope=primitive_scope,
            evidence_scope=ev_scope,
            candidates=[_candidate(observed_date='2026-03-15', n=10, k=4)],
            arrival_weights=amap.get('U'),
        )

    reg = RequestPrimitiveRegistry(arrival_map=amap)
    reg.register(_bind())
    with pytest.raises(ValueError):
        reg.register(_bind())  # same key twice


# ─── Span-primitive metadata validator (regime boundary) ───────────────


def test_span_primitive_crossing_x_boundary_is_rejected():
    """plan §619, §123: a prepared span primitive that spans nodes on
    both sides of X is rejected and the caller must fall back to edge
    primitives."""
    span = SpanPrimitiveMetadata(
        span_node_ids=('B', 'X', 'Y'),
        slice_metadata='m1',
        context_key=None,
        regime_key='default',
        as_at=None,
    )
    result = validate_span_primitive(
        span=span,
        carrier_closure=('A', 'B', 'X'),
        subject_closure=('X', 'Y'),
        request_slice_metadata='m1',
        request_context_key=None,
        request_regime_key='default',
        request_as_at=None,
    )
    assert not result.accepted
    assert result.suggested_fallback == 'edge_primitives'
    assert 'X boundary' in (result.rejection_reason or '')


def test_span_primitive_metadata_mismatch_is_rejected():
    """A span fitting wholly inside one closure must still be rejected
    if its slice / context / regime / as-at metadata mismatches the
    request (plan §431 — regime containment is the load-bearing
    complex-topology guard)."""
    span_carrier_only = SpanPrimitiveMetadata(
        span_node_ids=('A', 'B', 'X'),
        slice_metadata='m1',
        context_key='ios',
        regime_key='default',
        as_at=None,
    )
    result = validate_span_primitive(
        span=span_carrier_only,
        carrier_closure=('A', 'B', 'X'),
        subject_closure=('X', 'Y'),
        request_slice_metadata='m1',
        request_context_key=None,  # request has no context, span has 'ios'
        request_regime_key='default',
        request_as_at=None,
    )
    assert not result.accepted
    assert 'context_key' in (result.rejection_reason or '')


def test_span_primitive_in_carrier_closure_with_matching_metadata_is_accepted():
    """A span that fits wholly inside one closure with matching
    slice / context / regime / as-at is acceptable. The first 73n
    implementation prefers edge primitives but the validator must
    allow this case so future work can opt in."""
    span = SpanPrimitiveMetadata(
        span_node_ids=('A', 'B', 'X'),
        slice_metadata='m1',
        context_key=None,
        regime_key='default',
        as_at='2026-04-01',
    )
    result = validate_span_primitive(
        span=span,
        carrier_closure=('A', 'B', 'X'),
        subject_closure=('X', 'Y'),
        request_slice_metadata='m1',
        request_context_key=None,
        request_regime_key='default',
        request_as_at='2026-04-01',
    )
    assert result.accepted


# ─── Shadow primitive inventory ────────────────────────────────────────


def test_registry_to_provenance_dict_emits_per_primitive_inventory():
    """plan §"Stop condition" line 629: the shadow primitive inventory
    is reviewable. The registry's provenance dump records each
    primitive's binding decision, raw and weighted totals, and the
    topology case it was bound under."""
    graph = _make_graph([
        ('e-a-u', 'u-a', 'u-u', 'A', 'U'),
        ('e-u-v', 'u-u', 'u-v', 'U', 'V'),
    ])
    transitions = {
        ('A', 'U'): _prim(p=0.95, sigma=0.05, mu=-100.0, onset=2.0),
        ('U', 'V'): _prim(p=0.6),
    }
    amap = _build_arrival_map(
        graph, 'A', {'2026-03-01': 1.0}, transitions, max_tau=10,
    )
    transition_uv = TransitionIdentity('U', 'V', 'e-u-v')
    ev_scope = _evidence_scope(
        date_from='2026-03-01', date_to='2026-03-10',
        subject_from='U', subject_to='V',
    )
    ps = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    # arrival_weight[U] = {2026-03-02: 0.5, 2026-03-03: 0.5} from the
    # midpoint stencil spreading the onset=2 CDF; candidates on both
    # clock-supported days so weighted totals integrate to the full n/k.
    res = bind_primitive_evidence(
        transition=transition_uv,
        primitive_scope=ps,
        evidence_scope=ev_scope,
        candidates=[
            _candidate(observed_date='2026-03-02', n=10, k=4),
            _candidate(observed_date='2026-03-03', n=10, k=4),
        ],
        arrival_weights=amap.get('U'),
    )
    reg = RequestPrimitiveRegistry(arrival_map=amap)
    reg.register(res)
    inv = reg.to_provenance_dict()
    assert inv['primitive_count'] == 1
    p = inv['primitives'][0]
    assert p['transition']['edge_id'] == 'e-u-v'
    assert p['topology_case'] == 'composed'
    assert p['preclock_candidate_total_n'] == 20
    assert p['preclock_candidate_total_k'] == 8
    assert p['clocked_weighted_total_n'] == pytest.approx(10.0)
    assert p['clocked_weighted_total_k'] == pytest.approx(4.0)
    # Identity cache key flows through.
    assert inv['identity_cache_key'] == amap.identity.cache_key
    # Diagnostics envelope from the arrival map is preserved.
    assert 'composed_count' in inv['arrival_map_diagnostics']


# ─── Degraded primitive ────────────────────────────────────────────────


# ─── Raw / weighted / effective separation ─────────────────────────────


def test_raw_and_weighted_evidence_are_explicitly_separate_even_when_equal():
    """plan §"Stop condition" line 629: raw E, weighted evidence view,
    and effective e are stored separately even when they are
    numerically equal.

    Window-mode primitive with single anchor day: raw n/k EQUAL the
    weighted n/k numerically, but the WeightedPrimitiveEvidenceView is
    a SEPARATE object from the EvidenceSet — different shape, distinct
    identity, distinct binding policy stamp."""
    graph = _make_graph([('e-u-v', 'u-u', 'u-v', 'U', 'V')])
    transitions = {('U', 'V'): _prim(p=0.7)}
    amap = _build_arrival_map(
        graph, 'U', {'2026-03-15': 1.0}, transitions,
    )
    transition = TransitionIdentity('U', 'V', 'e-u-v')
    ev_scope = _evidence_scope()
    ps = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    res = bind_primitive_evidence(
        transition=transition,
        primitive_scope=ps,
        evidence_scope=ev_scope,
        candidates=[_candidate(observed_date='2026-03-15', n=12, k=5)],
        arrival_weights=amap.get('U'),
    )
    assert res.weighted_view is not None
    # Numerically equal.
    assert res.raw_evidence_set.totals.n == 12
    assert res.weighted_view.n_weighted_total == pytest.approx(12.0)
    # Distinct objects, distinct field shapes.
    assert res.raw_evidence_set is not res.weighted_view
    assert res.weighted_view.binding_policy == 'weighted_day_binding.v1'
    # Weighted-view rows are floating point even when raw n/k were ints.
    row = res.weighted_view.rows[0]
    assert isinstance(row.n_weighted, float)
    assert isinstance(row.k_weighted, float)
    assert isinstance(row.n, int)
    assert isinstance(row.k, int)


# ─── Selected A-clock superset evidence boundary ──────────────────────
#
# Regression guards for the strict evidence-superset boundary in
# docs/current/cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md.
# Downstream code must translate already-fetched superset rows into
# candidates; it must not read `_bayes_evidence` or wrap candidates in
# per-edge EvidenceSets before building the request pool.


def _superset_rows(*, date: str, n: int, k: int) -> list[dict]:
    return [{
        "anchor_day": date,
        "slice_key": f"window({date}:{date})",
        "core_hash": "superset-core",
        "retrieved_at": "2026-04-01",
        "a": n,
        "x": n,
        "y": k,
    }]


def test_superset_candidates_admitted_for_non_target_subject_edge():
    """Multi-hop subject X -> U -> V with fetched superset rows on U -> V.
    The downstream translator must emit raw candidates, not an EvidenceSet,
    and must not require graph-side `_bayes_evidence`."""
    from runner.cohort_forecast_v3 import build_superset_candidates_by_edge

    graph = _make_graph([
        ('e-x-u', 'u-X', 'u-U', 'X', 'U'),
        ('e-u-v', 'u-U', 'u-V', 'U', 'V'),
    ])

    candidates_by_edge = build_superset_candidates_by_edge(
        graph=graph,
        from_node='X',
        to_node='V',
        per_edge_results_by_uuid={
            'e-u-v': {
                'evidence_superset_rows': _superset_rows(date='2026-03-15', n=20, k=8),
            },
        },
        anchor_from='2026-03-01',
        sweep_to='2026-03-31',
        as_at=None,
        scenario_id='scn-1',
    )

    candidates = candidates_by_edge.get('e-u-v') or candidates_by_edge.get('U->V')
    assert candidates is not None, (
        f"Expected candidates for the U->V non-target edge; "
        f"got keys {list(candidates_by_edge.keys())}"
    )
    assert [c.n for c in candidates] == [20]
    assert [c.k for c in candidates] == [8]


def test_effective_dsl_context_scope_parser_uses_exact_context_and_mece_dimensions():
    from runner.forecast_preparation import extract_forecast_context_scope

    scope = extract_forecast_context_scope(
        "context(channel:google).window(1-Apr-26:4-Apr-26).asat(15-Apr-26)",
        mece_dimensions=["channel"],
    )

    assert scope.context_key == "channel"
    assert scope.context_selector == "context(channel:google)"
    assert scope.mece_dimensions == ("channel",)


def test_edge_descriptor_threads_context_scope_to_evidence_scope():
    from runner.edge_binding_descriptor import (
        _evidence_scope_for,
        enumerate_per_edge_descriptors,
    )

    graph = _make_graph([
        ('e-x-u', 'u-X', 'u-U', 'X', 'U'),
    ])

    descriptors = enumerate_per_edge_descriptors(
        graph=graph,
        from_node='X',
        to_node='U',
        is_carrier=False,
        target_edge_uuid=None,
        anchor_from='2026-03-01',
        sweep_to='2026-03-31',
        as_at=None,
        scenario_id='scn-1',
        anchor_node_id=None,
        context_key='channel',
        context_selector='context(channel:google)',
        mece_dimensions=('channel',),
    )

    assert len(descriptors) == 1
    scope = _evidence_scope_for(descriptors[0])
    assert scope.context_key == 'channel'
    assert scope.context_selector == 'context(channel:google)'
    assert scope.mece_dimensions == ('channel',)


def test_descriptor_does_not_read_graph_side_evidence_sources():
    """The selected A-clock candidate translator must stay behind the
    evidence-superset interface."""
    from pathlib import Path

    src = (
        Path(__file__).resolve().parent.parent
        / "runner"
        / "edge_binding_descriptor.py"
    ).read_text(encoding="utf-8")

    assert "_bayes_evidence" not in src
    assert "bayes_file_evidence_to_candidates" not in src


def test_runtime_preparation_does_not_construct_target_evidence():
    """Target evidence is supplied by the shared superset-candidate path,
    not by `prepare_forecast_runtime_inputs`."""
    from pathlib import Path

    src = (
        Path(__file__).resolve().parent.parent
        / "runner"
        / "forecast_runtime.py"
    ).read_text(encoding="utf-8")

    body = src[src.index("def prepare_forecast_runtime_inputs("):]
    assert "build_candidates_for_descriptor" not in body
    assert "merge_evidence_candidates" not in body
    assert "_bayes_evidence" not in body


def test_superset_candidates_admitted_by_primitive_local_merge():
    """End-to-end: superset evidence on a non-target subject edge of a
    multi-hop subject flows from the descriptor translator through the
    primitive-local merge with the correct primitive-source-clock
    arrival weights.

    Multi-hop subject X -> U -> V, fetched superset rows on U -> V (the
    non-target intermediate edge). The U-rooted arrival weights model
    the U-arrival distribution induced by the X-rooted prefix in the
    request; this primitive's binder must admit the supplied candidate on
    the day it carries.
    """
    from runner.cohort_forecast_v3 import build_superset_candidates_by_edge

    graph = _make_graph([
        ('e-x-u', 'u-X', 'u-U', 'X', 'U'),
        ('e-u-v', 'u-U', 'u-V', 'U', 'V'),
    ])

    per_edge = build_superset_candidates_by_edge(
        graph=graph,
        from_node='X',
        to_node='V',
        per_edge_results_by_uuid={
            'e-u-v': {
                'evidence_superset_rows': _superset_rows(date='2026-03-15', n=20, k=8),
            },
        },
        anchor_from='2026-03-01',
        sweep_to='2026-03-31',
        as_at=None,
        scenario_id='scn-1',
    )
    candidates = list(per_edge['e-u-v'])
    assert candidates, "superset translator must emit a candidate for U->V"

    # Build a U-rooted arrival map (window-mode multi-hop with primitive
    # source U; in window mode the primitive-local clock has identity
    # weights at the days the primitive's source node carries mass).
    transitions = {
        ('X', 'U'): _prim(p=0.5),
        ('U', 'V'): _prim(p=0.7),
    }
    arrival_map = _build_arrival_map(
        graph, 'U', {'2026-03-15': 1.0}, transitions,
        target_node_ids=('U', 'V'),
    )

    transition = TransitionIdentity('U', 'V', 'e-u-v')
    ev_scope = _evidence_scope()
    primitive_scope = make_primitive_scope_from_evidence_scope(
        evidence_scope=ev_scope,
        model_source_preference='best_available',
        resolved_source_identity='bayesian',
    )
    res = bind_primitive_evidence(
        transition=transition,
        primitive_scope=primitive_scope,
        evidence_scope=ev_scope,
        candidates=candidates,
        arrival_weights=arrival_map.get('U'),
    )

    # Superset evidence is admitted into the weighted view, not silently
    # dropped to prior-only.
    assert res.weighted_view is not None
    assert res.weighted_view.n_weighted_total == pytest.approx(20.0)
    assert res.weighted_view.k_weighted_total == pytest.approx(8.0)
    assert res.raw_evidence_set.totals.n == 20
    assert res.raw_evidence_set.totals.k == 8


def test_superset_candidates_admitted_for_active_carrier_edge():
    """Active cohort A -> X -> end where the carrier A -> X carries
    fetched superset rows. The carrier translator must emit raw candidates
    for the A -> X edge without reading graph-side evidence fields."""
    from runner.cohort_forecast_v3 import build_carrier_superset_candidates_by_edge

    graph = _make_graph([
        ('e-a-x', 'u-A', 'u-X', 'A', 'X'),
        ('e-x-v', 'u-X', 'u-V', 'X', 'V'),
    ])

    candidates_by_edge = build_carrier_superset_candidates_by_edge(
        graph=graph,
        anchor_node_id='A',
        query_from_node='X',
        per_edge_results_by_uuid={
            'e-a-x': {
                'evidence_superset_rows': _superset_rows(date='2026-03-15', n=22, k=14),
            },
        },
        anchor_from='2026-03-01',
        sweep_to='2026-03-31',
        as_at=None,
        scenario_id='scn-1',
    )

    candidates = candidates_by_edge.get('e-a-x') or candidates_by_edge.get('A->X')
    assert candidates is not None, (
        f"Expected candidates for the A->X carrier edge; "
        f"got keys {list(candidates_by_edge.keys())}"
    )
    assert [c.n for c in candidates] == [22]
    assert [c.k for c in candidates] == [14]
