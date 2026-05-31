"""73q Phase 5a — surprise_gauge as a scalar-reducer consumer.

Replacement coverage for the trajectory-engine-based gauge tests that
lived in ``test_cf_query_scoped_degradation.py`` before the migration.
Each test pins one semantic intent against the post-migration gauge
contract; the old test names are referenced in docstrings only as
historical anchors so the lineage is traceable.

The gauge is now ``prepare_cf_scalar_bundle`` + ``reduce_cf_scalars`` +
response framing. Tests mock the bundle-prep and the reducer so the
gauge's own contract (z-score math, degenerate handling, response
shape, temporal-mode parsing, id/uuid invariance) can be exercised in
isolation. Behaviours that migrated wholesale into the bundle prep
(candidate-regime selection, sweep bounds, cohort carrier cache keys)
are not re-tested here — they have their own bundle-prep coverage.
"""

import math
import os
import sys
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


# ── Minimal synthetic graph + subject ────────────────────────────


def _two_node_graph(use_uuid: bool = False) -> Dict[str, Any]:
    """Two-node A→B graph with a single latency-bearing edge.

    ``use_uuid`` flips whether the graph references the nodes by ``id``
    or ``uuid`` (the gauge must produce equivalent output either way —
    invariance over reference shape)."""
    a_ref = 'node-a-uuid' if use_uuid else 'node-a'
    b_ref = 'node-b-uuid' if use_uuid else 'node-b'
    return {
        'nodes': [
            {'id': a_ref, 'uuid': a_ref, 'entry': {'is_start': True}},
            {'id': b_ref, 'uuid': b_ref},
        ],
        'edges': [
            {
                'id': 'edge-1',
                'uuid': 'edge-1',
                'from': a_ref,
                'to': b_ref,
                'p': {
                    'forecast': {'mean': 0.4},
                    'latency': {
                        'latency_parameter': True,
                        'mu': 2.0,
                        'sigma': 0.5,
                        'onset_delta_days': 0.0,
                    },
                    'model_vars': [{
                        'source': 'analytic',
                        'probability': {
                            'mean': 0.4,
                            'alpha': 40.0,
                            'beta': 60.0,
                            'alpha_pred': 40.0,
                            'beta_pred': 60.0,
                        },
                        'latency': {
                            'mu': 2.0,
                            'sigma': 0.5,
                            'onset_delta_days': 0.0,
                            'mu_sd': 0.0,
                            'sigma_sd': 0.0,
                            'onset_sd': 0.0,
                            'onset_mu_corr': 0.0,
                        },
                    }],
                },
            },
        ],
    }


def _valid_subject() -> Dict[str, Any]:
    return {
        'subject_id': 'gauge-subject',
        'param_id': 'pytest-gauge-param',
        'core_hash': 'gauge-hash',
        'anchor_from': '2026-04-01',
        'anchor_to': '2026-04-01',
        'slice_keys': [''],
        'target': {'targetId': 'edge-1'},
    }


def _scenario(effective_query_dsl: str = '') -> Dict[str, Any]:
    return {
        'scenario_id': 'gauge-scenario',
        'effective_query_dsl': effective_query_dsl,
        'graph': _two_node_graph(),
        'candidate_regimes_by_edge': {},
        'display_settings': {},
    }


# ── Canned scalar reducer outputs ────────────────────────────────


def _canned_scalars(
    *,
    p_fc_mean: float = 0.52,
    p_fc_sd: float = 0.04,
    p_unc_mean: float = 0.40,
    p_unc_sd: float = 0.08,
    c_fc_mean: float = 0.70,
    c_fc_sd: float = 0.03,
    c_unc_mean: float = 0.55,
    c_unc_sd: float = 0.06,
    evidence_n: Optional[int] = 100,
    evidence_k: Optional[int] = 40,
):
    """Construct a populated ``CFScalarReduction`` with all gauge-relevant
    fields. Defaults sit far enough off the dial that the combined-spread
    z is comfortably non-zero (so tests can detect a true zero from a
    coincidentally-zero one)."""
    from runner.cohort_forecast_v3 import CFScalarReduction

    return CFScalarReduction(
        fc_terminal_rate_mean=p_fc_mean,
        fc_terminal_rate_sd_predictive=p_fc_sd,
        conditioned_span_terminal_rate_sd_epistemic=p_fc_sd,
        fc_frontier_to_terminal_rate_ratio_mean=c_fc_mean,
        fc_frontier_to_terminal_rate_ratio_sd_predictive=c_fc_sd,
        strict_empirical_terminal_evidence_n=evidence_n,
        strict_empirical_terminal_evidence_k=evidence_k,
        unconditioned_terminal_rate_mean_epistemic=p_unc_mean,
        unconditioned_terminal_rate_sd_epistemic=p_unc_sd,
        unconditioned_frontier_to_terminal_cdf_ratio_mean=c_unc_mean,
        unconditioned_frontier_to_terminal_cdf_ratio_sd_epistemic=c_unc_sd,
    )


def _stub_bundle_pipeline(
    monkeypatch: pytest.MonkeyPatch,
    *,
    scalars=None,
    last_edge_id: Optional[str] = 'edge-1',
    cf_mode: str = 'sweep',
    cf_reason: Optional[str] = None,
    capture: Optional[Dict[str, Any]] = None,
):
    """Patch the bundle-prep pipeline so the gauge runs against canned
    scalars. ``capture`` (if provided) receives the args bundle prep was
    called with, so tests can assert temporal-mode and other plumbing."""
    from runner import forecast_preparation, cf_analysis, cohort_forecast_v3
    import api_handlers

    if scalars is None:
        scalars = _canned_scalars()

    preparation = MagicMock()
    preparation.last_edge_id = last_edge_id
    preparation.per_edge_results = []
    preparation.anchor_from = '2026-04-01'
    preparation.sweep_to = '2026-05-01'
    preparation.query_from_node = 'node-a'
    preparation.query_to_node = 'node-b'
    preparation.anchor_node = 'node-a'
    preparation.envelope_plan = None
    preparation.composed_frames = []

    def _fake_prepare_subject_group(**kwargs):
        if capture is not None:
            capture['subject_group_kwargs'] = kwargs
        return preparation

    bundle = MagicMock()
    bundle.cf_mode = cf_mode
    bundle.cf_reason = cf_reason
    prepared = MagicMock()
    prepared.bundle = bundle
    prepared.runtime_bundle_diag = None

    def _fake_prepare_scalar_bundle(_preparation, **kwargs):
        if capture is not None:
            capture['scalar_bundle_kwargs'] = kwargs
        return prepared

    def _fake_reduce(_bundle):
        if capture is not None:
            capture['reduce_called_with_bundle'] = _bundle
        return scalars

    # Make the gauge see the patched implementations via the api_handlers
    # function-local imports.
    monkeypatch.setattr(
        forecast_preparation, 'prepare_forecast_subject_group',
        _fake_prepare_subject_group,
    )
    monkeypatch.setattr(
        cf_analysis, 'prepare_cf_scalar_bundle', _fake_prepare_scalar_bundle,
    )
    monkeypatch.setattr(
        cohort_forecast_v3, 'reduce_cf_scalars', _fake_reduce,
    )

    # ``_compute_extent_for_scenario`` consults the graph + display
    # settings to compute the compose horizon; bypass it with a small
    # fixed value so we don't need a full graph to be wired up.
    monkeypatch.setattr(
        api_handlers, '_compute_extent_for_scenario',
        lambda **_kwargs: 60,
    )


# ── Variable lookup helper ───────────────────────────────────────


def _var(result: Dict[str, Any], name: str) -> Dict[str, Any]:
    return next(v for v in result['variables'] if v['name'] == name)


# ─────────────────────────────────────────────────────────────────
# Contract: response shape
# ─────────────────────────────────────────────────────────────────


class TestGaugeResponseShape:

    def test_emits_two_variables_named_p_and_completeness(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        from api_handlers import _compute_surprise_gauge

        _stub_bundle_pipeline(monkeypatch)
        result = _compute_surprise_gauge(
            _two_node_graph(), 'edge-1', _valid_subject(),
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        names = [v['name'] for v in result['variables']]
        assert names == ['p', 'completeness']

    def test_required_per_variable_fields_are_present(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        # The FE renders each gauge from a fixed contract: needle/dial
        # numbers (`observed`, `expected`), spread (`posterior_sd`,
        # `combined_sd`), z-score (`sigma`, `quantile`), zone
        # classification (`zone`), and an availability flag.
        from api_handlers import _compute_surprise_gauge

        _stub_bundle_pipeline(monkeypatch)
        result = _compute_surprise_gauge(
            _two_node_graph(), 'edge-1', _valid_subject(),
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        required = {
            'observed', 'expected', 'posterior_sd', 'combined_sd',
            'sigma', 'quantile', 'zone', 'available',
        }
        for name in ('p', 'completeness'):
            v = _var(result, name)
            assert required <= set(v.keys()), (
                f"variable {name} missing required keys: "
                f"{required - set(v.keys())}"
            )
            assert v['available'] is True

    def test_top_level_envelope_carries_cf_mode_and_reference_source(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        from api_handlers import _compute_surprise_gauge

        _stub_bundle_pipeline(monkeypatch, cf_mode='sweep')
        result = _compute_surprise_gauge(
            _two_node_graph(), 'edge-1', _valid_subject(),
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        assert result['analysis_type'] == 'surprise_gauge'
        assert result['analysis_name'] == 'Expectation Gauge'
        assert result['cf_mode'] == 'sweep'
        assert result.get('reference_source') is not None


# ─────────────────────────────────────────────────────────────────
# Contract: z-score is the combined-spread formula
# ─────────────────────────────────────────────────────────────────


class TestGaugeZScoreMath:
    """z = (needle_mean − dial_mean) / sqrt(needle_sd² + dial_sd²)

    Two distributions, distance-between-means scaled by joint spread.
    Both gauges use the same formula on their respective marginal pairs:
    p (FC predictive vs unc epistemic), completeness (same)."""

    def test_p_sigma_matches_combined_spread_formula(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        from api_handlers import _compute_surprise_gauge

        scalars = _canned_scalars(
            p_fc_mean=0.6, p_fc_sd=0.03,
            p_unc_mean=0.4, p_unc_sd=0.08,
        )
        _stub_bundle_pipeline(monkeypatch, scalars=scalars)
        result = _compute_surprise_gauge(
            _two_node_graph(), 'edge-1', _valid_subject(),
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        expected_z = (0.6 - 0.4) / math.sqrt(0.03 ** 2 + 0.08 ** 2)
        assert _var(result, 'p')['sigma'] == pytest.approx(
            round(expected_z, 3), abs=1e-3,
        )

    def test_completeness_sigma_matches_combined_spread_formula(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        from api_handlers import _compute_surprise_gauge

        scalars = _canned_scalars(
            c_fc_mean=0.8, c_fc_sd=0.02,
            c_unc_mean=0.5, c_unc_sd=0.05,
        )
        _stub_bundle_pipeline(monkeypatch, scalars=scalars)
        result = _compute_surprise_gauge(
            _two_node_graph(), 'edge-1', _valid_subject(),
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        expected_z = (0.8 - 0.5) / math.sqrt(0.02 ** 2 + 0.05 ** 2)
        assert _var(result, 'completeness')['sigma'] == pytest.approx(
            round(expected_z, 3), abs=1e-3,
        )

    def test_combined_sd_field_is_joint_spread(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        # `combined_sd` is the denominator of the z formula —
        # sqrt(needle_sd² + dial_sd²). The FE renders it as the "effective
        # spread" annotation under the gauge.
        from api_handlers import _compute_surprise_gauge

        scalars = _canned_scalars(p_fc_sd=0.06, p_unc_sd=0.08)
        _stub_bundle_pipeline(monkeypatch, scalars=scalars)
        result = _compute_surprise_gauge(
            _two_node_graph(), 'edge-1', _valid_subject(),
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        expected = math.sqrt(0.06 ** 2 + 0.08 ** 2)
        assert _var(result, 'p')['combined_sd'] == pytest.approx(
            round(expected, 6), abs=1e-6,
        )

    def test_zero_dial_sd_does_not_crash(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        # A tight prior (e.g. cohort too young for onset) collapses the
        # dial SD to zero. The denominator is floored at 1e-12 so the
        # gauge still emits a finite z without exploding (doc 55 §3.3).
        from api_handlers import _compute_surprise_gauge

        scalars = _canned_scalars(
            p_fc_mean=0.5, p_fc_sd=0.0, p_unc_mean=0.5, p_unc_sd=0.0,
        )
        _stub_bundle_pipeline(monkeypatch, scalars=scalars)
        result = _compute_surprise_gauge(
            _two_node_graph(), 'edge-1', _valid_subject(),
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        p_var = _var(result, 'p')
        assert math.isfinite(p_var['sigma'])
        # equal means with zero spread → z = 0, quantile = 0.5, zone = expected
        assert p_var['sigma'] == 0.0
        assert p_var['quantile'] == pytest.approx(0.5, abs=1e-6)


# ─────────────────────────────────────────────────────────────────
# Contract: evidence sums surface for display (not consumed by maths)
# ─────────────────────────────────────────────────────────────────


class TestGaugeEvidenceSurface:

    def test_evidence_totals_from_scalar_reducer_surface_on_p_variable(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        # Σn, Σk live on the scalar reducer's strict empirical terminal
        # evidence fields
        # fields and pass through to the gauge response as display context.
        # They do NOT enter the gauge maths (the FC needle already
        # incorporates them via conditioning).
        from api_handlers import _compute_surprise_gauge

        scalars = _canned_scalars(evidence_n=250, evidence_k=120)
        _stub_bundle_pipeline(monkeypatch, scalars=scalars)
        result = _compute_surprise_gauge(
            _two_node_graph(), 'edge-1', _valid_subject(),
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        p_var = _var(result, 'p')
        assert p_var['evidence_n'] == 250
        assert p_var['evidence_k'] == 120

    def test_none_evidence_totals_degrade_to_zero_safely(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        # When the empirical operator has no admitted evidence the
        # reducer emits None for strict empirical terminal evidence. The gauge renders zeros
        # (not crashes, not omitted fields).
        from api_handlers import _compute_surprise_gauge

        scalars = _canned_scalars(evidence_n=None, evidence_k=None)
        _stub_bundle_pipeline(monkeypatch, scalars=scalars)
        result = _compute_surprise_gauge(
            _two_node_graph(), 'edge-1', _valid_subject(),
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        p_var = _var(result, 'p')
        assert p_var['evidence_n'] == 0
        assert p_var['evidence_k'] == 0


# ─────────────────────────────────────────────────────────────────
# Contract: temporal mode comes from effective_query_dsl
# ─────────────────────────────────────────────────────────────────


class TestGaugeTemporalModeRouting:
    """Successor to ``test_surprise_gauge_uses_effective_query_dsl_for_temporal_mode``.

    The gauge consumes ``effective_query_dsl`` (per-scenario) when
    routing temporal mode, falling back to ``data['query_dsl']`` only
    when the effective DSL is silent on temporal scope. ``window(…)``
    forces window mode; ``cohort(…)`` forces cohort mode."""

    def test_window_dsl_in_effective_query_routes_to_window_mode(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        from api_handlers import _compute_surprise_gauge

        capture: Dict[str, Any] = {}
        _stub_bundle_pipeline(monkeypatch, capture=capture)
        _compute_surprise_gauge(
            _two_node_graph(), 'edge-1', _valid_subject(),
            {'query_dsl': 'from(a).to(b)'},
            _scenario(),
            effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        assert capture['subject_group_kwargs']['is_window'] is True
        assert capture['scalar_bundle_kwargs']['is_window'] is True

    def test_cohort_dsl_in_effective_query_routes_to_cohort_mode(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        from api_handlers import _compute_surprise_gauge

        capture: Dict[str, Any] = {}
        _stub_bundle_pipeline(monkeypatch, capture=capture)
        _compute_surprise_gauge(
            _two_node_graph(), 'edge-1', _valid_subject(),
            {'query_dsl': 'from(a).to(b)'},
            _scenario(),
            effective_query_dsl='cohort(1-Apr-26:1-Apr-26)',
        )
        assert capture['subject_group_kwargs']['is_window'] is False
        assert capture['scalar_bundle_kwargs']['is_window'] is False


# ─────────────────────────────────────────────────────────────────
# Contract: id / uuid graph references produce equivalent output
# ─────────────────────────────────────────────────────────────────


class TestGaugeReferenceShapeInvariance:
    """Successor to ``test_surprise_gauge_mixed_ids_match_same_semantic_graph``.

    The gauge resolves edges and nodes by either ``id`` or ``uuid`` —
    the same semantic graph using either reference style must produce
    the same gauge response."""

    def test_id_and_uuid_reference_shapes_yield_same_response(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        from api_handlers import _compute_surprise_gauge

        scalars = _canned_scalars()
        _stub_bundle_pipeline(monkeypatch, scalars=scalars)
        a = _compute_surprise_gauge(
            _two_node_graph(use_uuid=False), 'edge-1', _valid_subject(),
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        b = _compute_surprise_gauge(
            _two_node_graph(use_uuid=True), 'edge-1', _valid_subject(),
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        # Strip cf_reason from both (None on both, but defaults differ
        # across runs in degenerate paths). All else must match.
        for k in ('analysis_type', 'analysis_name', 'cf_mode'):
            assert a[k] == b[k]
        # Per-variable numbers are identical because the scalar reducer
        # is mocked with the same canned values regardless of reference
        # shape — this confirms the gauge isn't routing differently
        # based on id-vs-uuid.
        for name in ('p', 'completeness'):
            va, vb = _var(a, name), _var(b, name)
            for field in ('observed', 'expected', 'sigma', 'quantile', 'zone'):
                assert va[field] == vb[field], (
                    f"variable {name} field {field} diverged: "
                    f"id={va[field]!r} vs uuid={vb[field]!r}"
                )


# ─────────────────────────────────────────────────────────────────
# Contract: unavailable-with-reason paths
# ─────────────────────────────────────────────────────────────────


class TestGaugeUnavailablePaths:
    """The gauge has well-defined unavailable branches that must emit
    ``available: false`` with a human-readable reason, not crash or
    return malformed output. These are the doc-55 §3.4 degradations."""

    def test_unavailable_when_target_id_missing_from_graph(self):
        from api_handlers import _compute_surprise_gauge

        result = _compute_surprise_gauge(
            _two_node_graph(), 'nonexistent-edge', _valid_subject(),
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        for v in result['variables']:
            assert v['available'] is False
            assert v.get('reason')

    def test_unavailable_when_subject_missing_snapshot_query_fields(self):
        from api_handlers import _compute_surprise_gauge

        bare = {'subject_id': 's', 'target': {'targetId': 'edge-1'}}
        result = _compute_surprise_gauge(
            _two_node_graph(), 'edge-1', bare,
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        for v in result['variables']:
            assert v['available'] is False
            assert v.get('reason')

    def test_unavailable_when_no_resolvable_subject_edge(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        # Successor to ``test_surprise_gauge_renders_when_preparation_has_no_rows``
        # and the no-frames / no-data-points / no-cohorts-matching trio.
        # All four old tests pinned the same underlying invariant:
        # preparation that produces no usable edge degrades gracefully.
        # Under the new architecture this collapses to one condition:
        # ``preparation.last_edge_id is None`` — the gauge can't proceed
        # without a resolved edge.
        from api_handlers import _compute_surprise_gauge

        _stub_bundle_pipeline(monkeypatch, last_edge_id=None)
        result = _compute_surprise_gauge(
            _two_node_graph(), 'edge-1', _valid_subject(),
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        for v in result['variables']:
            assert v['available'] is False
            assert v.get('reason')


# ─────────────────────────────────────────────────────────────────
# Contract: zone classification thresholds (doc 55 §3.3)
# ─────────────────────────────────────────────────────────────────


class TestGaugeZoneClassification:
    """The five zones are defined on the two-tailed probability of the
    quantile: 'expected' (<60% tail), 'noteworthy' (<80%), 'unusual'
    (<90%), 'surprising' (<98%), 'alarming' (≥98%). Doc 55 §3.3."""

    # tail = abs(quantile - 0.5) * 2 = 2·Φ(|z|) - 1
    # Picked z values comfortably away from threshold edges so floating
    # point doesn't flip the zone:
    #   z=0.5  → tail≈0.383  → expected
    #   z=1.0  → tail≈0.683  → noteworthy
    #   z=1.5  → tail≈0.866  → unusual
    #   z=1.7  → tail≈0.911  → surprising
    #   z=2.5  → tail≈0.988  → alarming
    @pytest.mark.parametrize('delta,expected_zone', [
        (0.0, 'expected'),
        (0.5, 'expected'),
        (1.0, 'noteworthy'),
        (1.5, 'unusual'),
        (1.7, 'surprising'),
        (2.5, 'alarming'),
    ])
    def test_p_zone_matches_doc55_thresholds(
        self, monkeypatch: pytest.MonkeyPatch,
        delta: float, expected_zone: str,
    ):
        from api_handlers import _compute_surprise_gauge

        # Tune dial / needle so z = delta exactly. With unc_sd=1.0,
        # fc_sd=0 (predictive collapsed for control), combined_sd=1.0.
        scalars = _canned_scalars(
            p_fc_mean=0.5 + delta, p_fc_sd=0.0,
            p_unc_mean=0.5, p_unc_sd=1.0,
        )
        _stub_bundle_pipeline(monkeypatch, scalars=scalars)
        result = _compute_surprise_gauge(
            _two_node_graph(), 'edge-1', _valid_subject(),
            {}, _scenario(), effective_query_dsl='window(1-Apr-26:1-Apr-26)',
        )
        assert _var(result, 'p')['zone'] == expected_zone
