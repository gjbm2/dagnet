"""
Stage 8 cross-surface substrate-provenance tests (73n).

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 8 — Cross-Surface Projection and Provenance" lines 741-762.

These tests pin the closure-required substrate items per plan §745.
For each of the four readout surfaces (single-hop, multi-hop subject
span, multi-hop window, active cohort A!=X carrier consumer) the
diagnostics dict must let a reviewer explain a CF scalar without
reading logs (plan §762):

  - primitive ids used;
  - evidence role per primitive;
  - raw evidence reference per primitive;
  - weighted evidence totals per primitive after evidence-clock binding;
  - effective evidence totals per primitive;
  - evidence-clock provenance per primitive (arrival_weight summary,
    binding policy, scope key);
  - prior source per primitive;
  - conditioning status per primitive;
  - unsupported residual / complement transition diagnostics, if any;
  - whether the public output came from a primitive readout or a
    composed subject-span readout (subject_probability_source);
  - composed subject and carrier topology + reach/probability summaries.

These tests stitch the existing readout fixtures together — they do not
introduce new readout surfaces; they assert each existing surface
threads ConditionedTransitionPrimitive.to_provenance_dict() through
the diagnostic block so consumers can read the substrate end-to-end.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parents[1]
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

import pytest

from evidence_merge import (
    PROVENANCE_SCHEMA_VERSION,
    EvidenceCandidate,
    EvidenceIdentity,
    EvidencePoint,
    EvidenceProvenance,
    EvidenceRole,
    EvidenceScope,
    EvidenceSet,
    EvidenceTotals,
    ObservationCoordinate,
    SliceFamily,
    SourceKind,
)
from runner.model_resolver import ResolvedLatency, ResolvedModelParams
from runner.primitive_readout import (
    CarrierEdgeResolution,
    SpanEdgeResolution,
    compute_active_cohort_carrier_readout,
    compute_multi_hop_subject_readout,
    compute_multi_hop_window_readout,
    compute_single_hop_readout,
)
from runner.primitives import PrimitiveScope, TransitionIdentity


# ─── Shared fixtures (small wrappers around the existing per-surface
#     fixtures so each test reads cleanly). ──────────────────────────────


def _scope() -> PrimitiveScope:
    return PrimitiveScope(
        scenario_id='scn-stage8',
        evidence_role='window_subject_helper',
        date_from='2026-02-01',
        date_to='2026-04-30',
        as_at='2026-05-01',
        context_key='ctx-A',
        regime_key='regime-default',
        model_source_preference='best_available',
        resolved_source_identity='analytic',
    )


def _resolved(*, alpha=4.0, beta=6.0, mu=0.0, sigma=0.0):
    return ResolvedModelParams(
        alpha=alpha, beta=beta,
        alpha_pred=alpha, beta_pred=beta,
        n_effective=None,
        edge_latency=ResolvedLatency(
            mu=mu, sigma=sigma, onset_delta_days=0.0, t95=0.0,
            mu_sd=0.0, sigma_sd=0.0, onset_sd=0.0, onset_mu_corr=0.0,
        ),
        source='analytic',
    )


def _evidence_set(*, n=100, k=70, subject_from='X', subject_to='Y') -> EvidenceSet:
    identity = EvidenceIdentity(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from=subject_from, subject_to=subject_to,
        anchor=None,
        slice_family=SliceFamily.WINDOW,
        context_key=None, regime_key=None, population_identity=None,
    )
    candidate = EvidenceCandidate(
        source=SourceKind.SNAPSHOT,
        identity=identity,
        coordinate=ObservationCoordinate(
            observed_date='2026-02-15', retrieved_at='2026-02-20'
        ),
        n=n, k=k,
    )
    prov = EvidenceProvenance(
        schema_version=PROVENANCE_SCHEMA_VERSION,
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        scope_key=f'{subject_from}|{subject_to}|window|stage8',
        scenario_id='scn-stage8',
        as_at=None,
        selected_slice_families=(SliceFamily.WINDOW,),
        selected_snapshot_families=(SliceFamily.WINDOW,),
        skipped_counts_by_reason={},
        included_counts_by_source={SourceKind.SNAPSHOT: 1},
        asat_materialised_present=False,
    )
    return EvidenceSet(
        scope=EvidenceScope(
            role=EvidenceRole.WINDOW_SUBJECT_HELPER,
            subject_from=subject_from, subject_to=subject_to,
            date_from='2026-02-01', date_to='2026-04-30',
        ),
        points=(EvidencePoint(candidate=candidate),),
        skipped=(),
        totals=EvidenceTotals(n=n, k=k),
        totals_by_source={SourceKind.SNAPSHOT: EvidenceTotals(n=n, k=k)},
        provenance=prov,
    )


def _graph(edges):
    nodes = set()
    for _, f, t in edges:
        nodes.add(f); nodes.add(t)
    return {
        'nodes': [{'id': n, 'uuid': n} for n in sorted(nodes)],
        'edges': [
            {'edge_id': eid, 'from': f, 'to': t,
             'from_node': f, 'to_node': t}
            for eid, f, t in edges
        ],
    }


# Plan §745 closure-required keys (per primitive). Tests assert these
# all reach the response diagnostic.
_CLOSURE_REQUIRED_KEYS = {
    'transition',  # primitive id
    'scope',  # carries evidence_role + context/regime/source identity
    'status',
    'effective_evidence_totals',
    'subset_policy',
    'compatibility_blend',
    'residual_policy',
    'prior_source',
    'draw_family_mode',
    'draw_family_key_digest',
    'is_draw_coherent',
    'timing_family',
    'raw_evidence_scope_key',
    'has_weighted_evidence',
    'weighted_evidence',
}


def _assert_closure_keys(prov, *, expect_weighted: bool):
    """Every plan §745 closure-required key is reachable from the
    provenance dict. ``expect_weighted`` distinguishes target edges
    (weighted view populated) from prior-only edges (None)."""
    missing = _CLOSURE_REQUIRED_KEYS - set(prov.keys())
    assert not missing, f"primitive provenance missing keys: {missing}"
    assert prov['scope']['evidence_role'] == 'window_subject_helper'
    assert prov['scope']['context_key'] == 'ctx-A'
    assert prov['scope']['regime_key'] == 'regime-default'
    assert prov['transition']['edge_id']
    assert prov['status']
    if expect_weighted:
        assert prov['has_weighted_evidence'] is True
        we = prov['weighted_evidence']
        assert we is not None
        assert 'n_weighted_total' in we
        assert 'k_weighted_total' in we
        assert 'arrival_weight_summary' in we
        assert 'binding_policy' in we
        assert 'evidence_scope_key' in we
    else:
        assert prov['weighted_evidence'] is None or \
            prov['weighted_evidence'].get('n_weighted_total') == 0.0


# ─── Stage 5a — single-hop substrate ─────────────────────────────────


def test_single_hop_diag_carries_primitive_substrate_provenance():
    """Plan §745: the single-hop diagnostic must surface the primitive's
    full to_provenance_dict() under primitive_provenance so a reviewer
    can describe the substrate without reading logs (plan §762)."""
    transition = TransitionIdentity(
        source_node='X', destination_node='Y', edge_id='edge-X-Y'
    )
    result = compute_single_hop_readout(
        eligible=True,
        skip_reason=None,
        transition=transition,
        primitive_scope=_scope(),
        evidence_set=_evidence_set(n=100, k=70),
        resolved_model=_resolved(alpha=4.0, beta=6.0),
        scenario_seed=17,
        legacy_p_mean=0.7, legacy_p_sd=0.04, legacy_p_sd_epistemic=0.04,
        prior_source='analytic',
    )
    assert result.primitive is not None
    diag = result.diagnostics
    assert 'primitive_provenance' in diag
    prov = diag['primitive_provenance']
    _assert_closure_keys(prov, expect_weighted=True)
    # Single-hop readout has only one primitive; the existing flat
    # primitive_* fields must agree with the new substrate block.
    we = prov['weighted_evidence']
    assert we['n_weighted_total'] == diag['primitive_n_weighted_total']
    assert we['k_weighted_total'] == diag['primitive_k_weighted_total']
    assert prov['prior_source'] == 'analytic'
    # The whether-direct-or-composed signal: Stage 5a is a direct
    # primitive readout (not composed), so the substitution flag drives
    # the source label for the public scalar. Plan §745 last bullet.
    # `subject_probability_source` is set at the row-builder seam, not
    # the readout — but the diag carries enough for the substrate
    # narrative on its own.


# ─── Stage 5b — multi-hop subject-span substrate ──────────────────────


def _two_hop_subject_resolutions(target='e-m-y', evidence=None):
    return [
        SpanEdgeResolution(
            transition=TransitionIdentity(
                source_node='X', destination_node='M', edge_id='e-x-m',
            ),
            primitive_scope=_scope(),
            resolved_model=_resolved(alpha=10.0, beta=10.0),
            evidence_set=None,
            is_target=(target == 'e-x-m'),
        ),
        SpanEdgeResolution(
            transition=TransitionIdentity(
                source_node='M', destination_node='Y', edge_id='e-m-y',
            ),
            primitive_scope=_scope(),
            resolved_model=_resolved(alpha=4.0, beta=6.0),
            evidence_set=evidence if target == 'e-m-y' else None,
            is_target=(target == 'e-m-y'),
        ),
    ]


def test_multi_hop_subject_readout_per_primitive_substrate_provenance():
    """Plan §745: each primitive in the composed span must surface a
    full provenance block via diagnostics['primitives']."""
    result = compute_multi_hop_subject_readout(
        eligible=True,
        skip_reason=None,
        graph=_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')]),
        x_node_id='X', end_node_id='Y',
        request_root_node_id='X',
        span_edge_resolutions=_two_hop_subject_resolutions(
            target='e-m-y',
            evidence=_evidence_set(
                n=100, k=70, subject_from='M', subject_to='Y'
            ),
        ),
        scenario_seed=42,
        legacy_p_mean=0.5, legacy_p_sd=0.05, legacy_p_sd_epistemic=0.05,
        prior_source='analytic',
    )
    assert result.composed is not None
    primitives = result.diagnostics.get('primitives')
    assert primitives is not None and len(primitives) == 2
    target_seen = False
    for entry in primitives:
        assert 'provenance' in entry, (
            'Stage 8: every primitive_summaries entry must carry a '
            'provenance block (plan §745).'
        )
        prov = entry['provenance']
        _assert_closure_keys(
            prov, expect_weighted=bool(entry['is_target'])
        )
        if entry['is_target']:
            target_seen = True
            we = prov['weighted_evidence']
            assert we is not None
            # Downstream target evidence is bound on the primitive
            # source-node clock induced by the prefix map. It is not the
            # raw retrieval total once the source is non-root.
            assert 0.0 < we['n_weighted_total'] < 100.0
            assert we['k_weighted_total'] == pytest.approx(
                we['n_weighted_total'] * 0.7
            )
    assert target_seen, 'expected exactly one target subject edge'

    # Composed subject topology + reach/probability summary must also
    # be reachable from the diagnostic (plan §745 last bullets).
    composed = result.diagnostics.get('composed')
    assert composed is not None
    assert composed['x_node_id'] == 'X'
    assert composed['end_node_id'] == 'Y'
    assert composed['primitive_count'] == 2
    assert 'span_p_mean' in composed
    assert 'span_p_sd' in composed
    # subject_probability_source distinguishes direct primitive readout
    # from composed-span readout (plan §745).
    assert result.diagnostics['subject_probability_source'].startswith(
        'composed_subject_span'
    )


# ─── Stage 5c — multi-hop window substrate ────────────────────────────


def test_multi_hop_window_readout_per_primitive_substrate_provenance():
    """Plan §745: multi-hop window primitives carry the same substrate
    block. Stage 5c uses Stage 5b's composer with the identity carrier
    (plan §704)."""
    result = compute_multi_hop_window_readout(
        eligible=True,
        skip_reason=None,
        graph=_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')]),
        x_node_id='X', end_node_id='Y',
        request_root_node_id='X',
        span_edge_resolutions=_two_hop_subject_resolutions(
            target='e-m-y',
            evidence=_evidence_set(
                n=80, k=50, subject_from='M', subject_to='Y'
            ),
        ),
        scenario_seed=42,
        legacy_p_mean=0.5, legacy_p_sd=0.05, legacy_p_sd_epistemic=0.05,
        prior_source='analytic',
    )
    assert result.composed is not None
    primitives = result.diagnostics.get('primitives')
    assert primitives is not None and len(primitives) == 2
    for entry in primitives:
        assert 'provenance' in entry
        _assert_closure_keys(
            entry['provenance'],
            expect_weighted=bool(entry['is_target']),
        )
    assert result.diagnostics['subject_probability_source'].startswith(
        'composed_subject_span_window'
    )


# ─── Stage 6 — active cohort A!=X substrate ───────────────────────────


def _carrier_resolutions():
    return [
        CarrierEdgeResolution(
            transition=TransitionIdentity(
                source_node='A', destination_node='B', edge_id='e-a-b',
            ),
            primitive_scope=_scope(),
            resolved_model=_resolved(alpha=10.0, beta=10.0),
            evidence_set=None,
        ),
        CarrierEdgeResolution(
            transition=TransitionIdentity(
                source_node='B', destination_node='X', edge_id='e-b-x',
            ),
            primitive_scope=_scope(),
            resolved_model=_resolved(alpha=8.0, beta=12.0),
            evidence_set=None,
        ),
    ]


def _stage6_subject_resolutions():
    return [
        SpanEdgeResolution(
            transition=TransitionIdentity(
                source_node='X', destination_node='M', edge_id='e-x-m',
            ),
            primitive_scope=_scope(),
            resolved_model=_resolved(alpha=6.0, beta=6.0),
            evidence_set=None,
            is_target=False,
        ),
        SpanEdgeResolution(
            transition=TransitionIdentity(
                source_node='M', destination_node='Y', edge_id='e-m-y',
            ),
            primitive_scope=_scope(),
            resolved_model=_resolved(alpha=4.0, beta=6.0),
            evidence_set=_evidence_set(
                n=120, k=60, subject_from='M', subject_to='Y'
            ),
            is_target=True,
        ),
    ]


def _stage6_graph():
    return _graph([
        ('e-a-b', 'A', 'B'),
        ('e-b-x', 'B', 'X'),
        ('e-x-m', 'X', 'M'),
        ('e-m-y', 'M', 'Y'),
    ])


def test_active_cohort_carrier_readout_substrate_provenance_for_both_spans():
    """Plan §745: Stage 6 carries TWO disjoint primitive lists — the
    A→X carrier closure and the X→end subject closure. Each list must
    surface the substrate provenance block per primitive, and the
    composed-carrier diagnostic must expose reach + topology so the
    plan §727 connectivity invariants are reviewable from the response
    alone."""
    result = compute_active_cohort_carrier_readout(
        eligible=True,
        skip_reason=None,
        graph=_stage6_graph(),
        anchor_node_id='A',
        x_node_id='X',
        end_node_id='Y',
        carrier_edge_resolutions=_carrier_resolutions(),
        subject_edge_resolutions=_stage6_subject_resolutions(),
        scenario_seed=42,
        legacy_p_mean=0.4, legacy_p_sd=0.05, legacy_p_sd_epistemic=0.05,
        prior_source='analytic',
    )
    diag = result.diagnostics
    # Carrier substrate (A→B→X). Both edges are prior-only in this
    # synthetic fixture (plan §"Stage 6" follow-up wires upstream
    # window(U-V) evidence later); the substrate block must still be
    # populated and identify each carrier primitive.
    carrier_primitives = diag.get('carrier_primitives')
    assert carrier_primitives is not None and len(carrier_primitives) == 2
    for entry in carrier_primitives:
        assert 'provenance' in entry
        _assert_closure_keys(
            entry['provenance'], expect_weighted=False
        )
    # Subject substrate (X→M→Y).
    subject_primitives = diag.get('subject_primitives')
    assert subject_primitives is not None and len(subject_primitives) == 2
    target_seen = False
    for entry in subject_primitives:
        assert 'provenance' in entry
        _assert_closure_keys(
            entry['provenance'],
            expect_weighted=bool(entry['is_target']),
        )
        if entry['is_target']:
            target_seen = True
            we = entry['provenance']['weighted_evidence']
            assert we is not None
            # Active-cohort subject evidence also uses the prefix-clock
            # weights from the unified runtime, so provenance should show
            # weighted totals rather than raw frame totals.
            assert 0.0 < we['n_weighted_total'] < 120.0
            assert we['k_weighted_total'] == pytest.approx(
                we['n_weighted_total'] * 0.5
            )
    assert target_seen
    # Composed carrier topology + reach summary.
    composed_carrier = diag.get('composed_carrier')
    assert composed_carrier is not None
    assert composed_carrier['anchor_node_id'] == 'A'
    assert composed_carrier['x_node_id'] == 'X'
    assert 'reach' in composed_carrier
    assert composed_carrier['role'] == 'carrier_to_x'
    assert composed_carrier['primitive_count'] == 2
    # Composed subject topology + probability summary.
    composed_subject = diag.get('composed_subject')
    assert composed_subject is not None
    assert composed_subject['x_node_id'] == 'X'
    assert composed_subject['end_node_id'] == 'Y'
    assert 'span_p_mean' in composed_subject
    # subject_probability_source signals the composed-substrate path.
    assert diag['subject_probability_source'].startswith(
        'primitive_backed_carrier'
    )


# ─── Stage 8 — substrate JSON-serialisability ─────────────────────────


def test_stage_8_substrate_blocks_are_json_serialisable():
    """Diagnostics are wired into the response payload; every Stage 8
    block must be JSON-serialisable so the api_handlers seam doesn't
    fail at jsonify time."""
    import json
    transition = TransitionIdentity(
        source_node='X', destination_node='Y', edge_id='edge-X-Y'
    )
    single = compute_single_hop_readout(
        eligible=True,
        skip_reason=None,
        transition=transition,
        primitive_scope=_scope(),
        evidence_set=_evidence_set(n=50, k=20),
        resolved_model=_resolved(alpha=2.0, beta=2.0),
        scenario_seed=17,
        legacy_p_mean=0.4, legacy_p_sd=0.05, legacy_p_sd_epistemic=0.05,
        prior_source='analytic',
    )
    json.dumps(dict(single.diagnostics))

    multi = compute_multi_hop_subject_readout(
        eligible=True,
        skip_reason=None,
        graph=_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')]),
        x_node_id='X', end_node_id='Y',
        request_root_node_id='X',
        span_edge_resolutions=_two_hop_subject_resolutions(
            target='e-m-y',
            evidence=_evidence_set(
                n=50, k=20, subject_from='M', subject_to='Y'
            ),
        ),
        scenario_seed=42,
        legacy_p_mean=0.4, legacy_p_sd=0.05, legacy_p_sd_epistemic=0.05,
        prior_source='analytic',
    )
    json.dumps(dict(multi.diagnostics))

    window = compute_multi_hop_window_readout(
        eligible=True,
        skip_reason=None,
        graph=_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')]),
        x_node_id='X', end_node_id='Y',
        request_root_node_id='X',
        span_edge_resolutions=_two_hop_subject_resolutions(
            target='e-m-y',
            evidence=_evidence_set(
                n=50, k=20, subject_from='M', subject_to='Y'
            ),
        ),
        scenario_seed=42,
        legacy_p_mean=0.4, legacy_p_sd=0.05, legacy_p_sd_epistemic=0.05,
        prior_source='analytic',
    )
    json.dumps(dict(window.diagnostics))

    stage6 = compute_active_cohort_carrier_readout(
        eligible=True,
        skip_reason=None,
        graph=_stage6_graph(),
        anchor_node_id='A',
        x_node_id='X',
        end_node_id='Y',
        carrier_edge_resolutions=_carrier_resolutions(),
        subject_edge_resolutions=_stage6_subject_resolutions(),
        scenario_seed=42,
        legacy_p_mean=0.4, legacy_p_sd=0.05, legacy_p_sd_epistemic=0.05,
        prior_source='analytic',
    )
    json.dumps(dict(stage6.diagnostics))


# ─── Stage 8 — optional cache_status snapshot (plan §760) ─────────────


def _assert_cache_status(diag):
    assert 'cache_status' in diag, (
        'Stage 8 (plan §760): each readout diag must carry a '
        'cache_status snapshot.'
    )
    snap = diag['cache_status']
    # snap may legitimately be None if the registry happens to be
    # unavailable, but in this synthetic test it is populated. Tests
    # that exercise the readouts above register caches in the process.
    assert snap is not None
    # Each entry must carry name + entries + the canonical counters.
    expected_fields = {
        'name', 'entries', 'hits', 'misses',
        'evictions', 'invalidations', 'bypasses',
    }
    for entry in snap:
        assert expected_fields.issubset(entry.keys()), (
            f'cache_status entry missing required fields: '
            f'{expected_fields - set(entry.keys())}'
        )


def test_single_hop_diag_carries_cache_status_snapshot():
    transition = TransitionIdentity(
        source_node='X', destination_node='Y', edge_id='edge-X-Y'
    )
    result = compute_single_hop_readout(
        eligible=True,
        skip_reason=None,
        transition=transition,
        primitive_scope=_scope(),
        evidence_set=_evidence_set(n=50, k=20),
        resolved_model=_resolved(alpha=2.0, beta=2.0),
        scenario_seed=17,
        legacy_p_mean=0.4, legacy_p_sd=0.05, legacy_p_sd_epistemic=0.05,
        prior_source='analytic',
    )
    _assert_cache_status(result.diagnostics)


def test_multi_hop_subject_readout_carries_cache_status_snapshot():
    result = compute_multi_hop_subject_readout(
        eligible=True,
        skip_reason=None,
        graph=_graph([('e-x-m', 'X', 'M'), ('e-m-y', 'M', 'Y')]),
        x_node_id='X', end_node_id='Y',
        request_root_node_id='X',
        span_edge_resolutions=_two_hop_subject_resolutions(
            target='e-m-y',
            evidence=_evidence_set(
                n=50, k=20, subject_from='M', subject_to='Y'
            ),
        ),
        scenario_seed=42,
        legacy_p_mean=0.4, legacy_p_sd=0.05, legacy_p_sd_epistemic=0.05,
        prior_source='analytic',
    )
    _assert_cache_status(result.diagnostics)


def test_active_cohort_carrier_readout_carries_cache_status_snapshot():
    result = compute_active_cohort_carrier_readout(
        eligible=True,
        skip_reason=None,
        graph=_stage6_graph(),
        anchor_node_id='A',
        x_node_id='X',
        end_node_id='Y',
        carrier_edge_resolutions=_carrier_resolutions(),
        subject_edge_resolutions=_stage6_subject_resolutions(),
        scenario_seed=42,
        legacy_p_mean=0.4, legacy_p_sd=0.05, legacy_p_sd_epistemic=0.05,
        prior_source='analytic',
    )
    _assert_cache_status(result.diagnostics)


# ─── Stage 8 — p_conditioning_evidence compatibility-metadata pin
#     (plan §762) ────────────────────────────────────────────────────


def test_readouts_do_not_accept_p_conditioning_evidence_parameter():
    """Plan §762: no live consumer requires ``p_conditioning_evidence``
    to decide evidence ownership. The four readout entry points must
    accept primitive evidence (typed ``EvidenceSet`` and
    ``PrimitiveScope``) directly; they must not gain a
    ``p_conditioning_evidence`` parameter or any synonym that would
    re-route ownership through the legacy compatibility block.
    """
    import inspect
    for fn in (
        compute_single_hop_readout,
        compute_multi_hop_subject_readout,
        compute_multi_hop_window_readout,
        compute_active_cohort_carrier_readout,
    ):
        sig = inspect.signature(fn)
        params = set(sig.parameters)
        forbidden = {
            'p_conditioning_evidence',
            'conditioning_evidence',
            'pce_total_x', 'pce_total_y',
        }
        leaked = params & forbidden
        assert not leaked, (
            f'{fn.__name__} accepts forbidden p_conditioning_evidence '
            f'synonyms: {leaked}; per plan §762 the readouts must take '
            'typed EvidenceSet evidence, not legacy compatibility totals.'
        )


def test_prepared_conditioning_evidence_to_dict_marks_compatibility_metadata():
    """Plan §762: when the runtime-bundle diag exposes
    ``p_conditioning_evidence``, it must be flagged as compatibility
    metadata so reviewers do not mistake it for an evidence-ownership
    decider."""
    from runner.forecast_runtime import (
        PreparedConditioningEvidence,
        PreparedForecastRuntimeBundle,
        serialise_runtime_bundle,
    )
    bundle = PreparedForecastRuntimeBundle(
        p_conditioning_evidence=PreparedConditioningEvidence(
            temporal_family='window',
            source='snapshot',
            evidence_points=2,
            total_x=100.0,
            total_y=70.0,
        ),
    )
    diag = serialise_runtime_bundle(bundle)
    pce = diag['p_conditioning_evidence']
    assert pce['total_x'] == 100.0
    assert pce['total_y'] == 70.0
    # Stage 8 — compatibility-metadata note must be present in the
    # serialised diagnostic.
    assert 'compatibility_metadata_note' in pce
    assert 'plan §762' in pce['compatibility_metadata_note']
    assert 'compatibility metadata' in pce['compatibility_metadata_note']
