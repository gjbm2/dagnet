"""
Stage 4 tests for the unsupported residual / unparameterised edge guard (73n).

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 4 — Unsupported Residual and Unparameterised Edge Guard".

Coverage maps to plan §"Stage 4" stop condition (line 662):

  - tests prove unsupported residual/complement requirements fail
    loudly or degrade with provenance;
  - adjacency-only residual inference is rejected;
  - no-evidence parameterised primitives remain prior-only rather than
    unsupported residuals;
  - supported split/join/leakage topology continues through the shared
    DAG composer (the guard does not classify those cases as residual);
  - no ``1 - p`` or proportional sibling rebalancing is performed
    inside CF composition (static source audit on this module);
  - CF graph writeback still routes through UpdateManager (static
    import audit confirming Stage 4 does not import composition or
    UpdateManager surfaces).
"""

from __future__ import annotations

import ast
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import numpy as np
import pytest

from runner.primitive_residual_guard import (
    EdgeRequirement,
    EdgeRequirementKind,
    ResidualGuardDecision,
    classify_edge_requirement,
    make_structurally_deterministic_primitive,
    make_unsupported_residual_primitive,
)
from runner.primitives import (
    ConditionedTransitionPrimitive,
    ConditioningStatus,
    DrawFamilyMode,
    DrawFamilyUnavailable,
    PrimitiveScope,
    ResidualPolicyProvenance,
    TimingFamily,
    TransitionIdentity,
)


_MODULE_PATH = (
    Path(__file__).resolve().parent.parent / 'runner' / 'primitive_residual_guard.py'
)


# ─── Fixture helpers ───────────────────────────────────────────────────


def _transition(edge_id: str = 'edge-uv') -> TransitionIdentity:
    return TransitionIdentity(
        source_node='U',
        destination_node='V',
        edge_id=edge_id,
    )


def _scope() -> PrimitiveScope:
    return PrimitiveScope(
        scenario_id='scn-1',
        evidence_role='window_subject_helper',
        date_from='2026-01-29',
        date_to='2026-04-29',
        as_at='2026-04-29',
        context_key=None,
        regime_key='default',
        model_source_preference='best_available',
        resolved_source_identity='analytic-1',
        selected_anchor_days=(),
    )


# ─── Decision matrix ───────────────────────────────────────────────────


def test_parameterised_requirement_forwards_to_conditioning():
    """Plan §572: parameterised edges are owned by Stage 3, not Stage 4."""
    req = EdgeRequirement(
        transition=_transition(),
        kind=EdgeRequirementKind.PARAMETERISED,
    )
    decision = classify_edge_requirement(req)
    assert decision.forward_to_conditioning is True
    assert decision.status_to_emit is None
    assert decision.residual_policy is None
    assert decision.deterministic_p is None
    assert decision.rejection_reason is None


def test_no_evidence_parameterised_does_not_become_unsupported_residual():
    """Plan §95-96, §572: empty evidence under a PARAMETERISED requirement
    is Stage 3's PRIOR_ONLY case, not Stage 4's UNSUPPORTED_RESIDUAL.

    Stage 4's classifier never returns UNSUPPORTED_RESIDUAL for
    PARAMETERISED requirements (unless the composer separately asks
    for adjacency-complement derivation, which is its own error).
    """
    req = EdgeRequirement(
        transition=_transition(),
        kind=EdgeRequirementKind.PARAMETERISED,
    )
    decision = classify_edge_requirement(req)
    assert decision.forward_to_conditioning is True
    assert decision.status_to_emit is None


def test_structurally_deterministic_with_explicit_p_emits_deterministic_primitive():
    req = EdgeRequirement(
        transition=_transition(),
        kind=EdgeRequirementKind.STRUCTURALLY_DETERMINISTIC,
        deterministic_p=1.0,
    )
    decision = classify_edge_requirement(req)
    assert decision.forward_to_conditioning is False
    assert decision.status_to_emit == ConditioningStatus.STRUCTURALLY_DETERMINISTIC
    assert decision.deterministic_p == 1.0


def test_structurally_deterministic_without_explicit_p_raises_value_error():
    """Plan §99: determinism is never inferred from missing evidence.

    The guard must reject a STRUCTURALLY_DETERMINISTIC requirement that
    arrives without an explicit ``deterministic_p``.
    """
    req = EdgeRequirement(
        transition=_transition(),
        kind=EdgeRequirementKind.STRUCTURALLY_DETERMINISTIC,
        deterministic_p=None,
    )
    with pytest.raises(ValueError) as info:
        classify_edge_requirement(req)
    assert 'must not infer determinism' in str(info.value).lower()


def test_structurally_deterministic_p_out_of_range_raises():
    req = EdgeRequirement(
        transition=_transition(),
        kind=EdgeRequirementKind.STRUCTURALLY_DETERMINISTIC,
        deterministic_p=1.5,
    )
    with pytest.raises(ValueError) as info:
        classify_edge_requirement(req)
    assert 'out of range' in str(info.value).lower()


def test_unparameterised_residual_emits_unsupported_residual():
    req = EdgeRequirement(
        transition=_transition(),
        kind=EdgeRequirementKind.UNPARAMETERISED_RESIDUAL,
        residual_closure_target='X-end via residual closure',
    )
    decision = classify_edge_requirement(req)
    assert decision.forward_to_conditioning is False
    assert decision.status_to_emit == ConditioningStatus.UNSUPPORTED_RESIDUAL
    assert decision.residual_policy is not None
    assert decision.residual_policy.residual_closure_required == 'X-end via residual closure'
    assert decision.residual_policy.branch_complement_required is None


def test_unparameterised_complement_emits_unsupported_residual_with_target():
    req = EdgeRequirement(
        transition=_transition(),
        kind=EdgeRequirementKind.UNPARAMETERISED_COMPLEMENT,
        branch_complement_target='sibling-edge-uw',
    )
    decision = classify_edge_requirement(req)
    assert decision.forward_to_conditioning is False
    assert decision.status_to_emit == ConditioningStatus.UNSUPPORTED_RESIDUAL
    assert decision.residual_policy is not None
    assert decision.residual_policy.branch_complement_required == 'sibling-edge-uw'
    assert decision.residual_policy.residual_closure_required is None


def test_adjacency_one_minus_p_rejected_for_parameterised_edge():
    """Plan §55, §660: CF composition does not derive 1 - p from siblings.

    A PARAMETERISED requirement that flags adjacency-complement is
    rejected as UNSUPPORTED_RESIDUAL with an explicit reason citing
    the no-1-p invariant.
    """
    req = EdgeRequirement(
        transition=_transition(),
        kind=EdgeRequirementKind.PARAMETERISED,
        requires_adjacency_one_minus_p=True,
        branch_complement_target='sibling-edge-failure',
    )
    decision = classify_edge_requirement(req)
    assert decision.forward_to_conditioning is False
    assert decision.status_to_emit == ConditioningStatus.UNSUPPORTED_RESIDUAL
    assert decision.residual_policy is not None
    assert decision.residual_policy.branch_complement_required == 'sibling-edge-failure'
    assert 'sibling adjacency complement' in (decision.rejection_reason or '')


def test_prepared_span_rejected_emits_unsupported_residual():
    """Plan §123, §431, §619: spans crossing X or mixing metadata are
    Stage 2 rejections; Stage 4 surfaces them as UNSUPPORTED_RESIDUAL
    when no edge fallback is possible."""
    req = EdgeRequirement(
        transition=_transition(),
        kind=EdgeRequirementKind.PREPARED_SPAN_REJECTED,
        prepared_span_rejection_reason='span crosses the X boundary',
    )
    decision = classify_edge_requirement(req)
    assert decision.forward_to_conditioning is False
    assert decision.status_to_emit == ConditioningStatus.UNSUPPORTED_RESIDUAL
    assert decision.rejection_reason == 'span crosses the X boundary'


# ─── Primitive constructors ────────────────────────────────────────────


def test_unsupported_residual_primitive_refuses_draws():
    """Plan §591: UNSUPPORTED_RESIDUAL primitives must refuse to serve a
    coherent draw family. The Stage 1 contract enforces this — Stage 4
    just needs to construct a primitive that uses the right slots."""
    prim = make_unsupported_residual_primitive(
        transition=_transition(),
        scope=_scope(),
        draw_count=1000,
        residual_policy=ResidualPolicyProvenance(
            branch_complement_required='sibling-failure',
            residual_closure_required=None,
            note='requested complement of evidence-backed sibling',
        ),
        rejection_reason='requested complement of evidence-backed sibling',
    )
    assert prim.status == ConditioningStatus.UNSUPPORTED_RESIDUAL
    assert prim.is_draw_coherent is False
    assert prim.draw_family_mode == DrawFamilyMode.MOMENTS_ONLY
    with pytest.raises(DrawFamilyUnavailable):
        prim.probability_draws()
    with pytest.raises(DrawFamilyUnavailable):
        prim.timing_draws()


def test_unsupported_residual_primitive_carries_residual_policy_provenance():
    """The residual_policy slot must name the structural element that
    would have been required so callers can diagnose the rejection."""
    prim = make_unsupported_residual_primitive(
        transition=_transition('edge-residual'),
        scope=_scope(),
        draw_count=500,
        residual_policy=ResidualPolicyProvenance(
            branch_complement_required=None,
            residual_closure_required='X-end residual closure',
            note='no parameterised primitive on residual closure',
        ),
        rejection_reason='no parameterised primitive on residual closure',
    )
    assert prim.subset_policy is None
    assert prim.compatibility_blend is None
    assert prim.residual_policy is not None
    assert prim.residual_policy.residual_closure_required == 'X-end residual closure'


def test_unsupported_residual_provenance_dict_contains_residual_policy_slot():
    """Stage 8 will roll provenance into the response. The dump must
    expose the residual_policy slot separately from subset_policy and
    compatibility_blend (plan §245)."""
    prim = make_unsupported_residual_primitive(
        transition=_transition(),
        scope=_scope(),
        draw_count=100,
        residual_policy=ResidualPolicyProvenance(
            branch_complement_required='sibling',
            residual_closure_required=None,
            note='note',
        ),
        rejection_reason='reason',
    )
    dump = prim.to_provenance_dict()
    assert dump['status'] == 'unsupported_residual'
    assert dump['residual_policy'] == {
        'branch_complement_required': 'sibling',
        'residual_closure_required': None,
        'note': 'note',
    }
    assert dump['subset_policy'] is None
    assert dump['compatibility_blend'] is None
    assert dump['probability_posterior'] is None


def test_structurally_deterministic_primitive_serves_constant_draws():
    """STRUCTURALLY_DETERMINISTIC is a coherent draw family of one
    repeated value. The contract's is_draw_coherent must be True
    (status not in {DEGRADED, UNAVAILABLE, UNSUPPORTED_RESIDUAL}, mode
    not MOMENTS_ONLY)."""
    prim = make_structurally_deterministic_primitive(
        transition=_transition(),
        scope=_scope(),
        draw_count=128,
        deterministic_p=1.0,
    )
    assert prim.status == ConditioningStatus.STRUCTURALLY_DETERMINISTIC
    assert prim.is_draw_coherent is True
    assert prim.draw_family_mode == DrawFamilyMode.KEYED_PRIOR
    p_draws = prim.probability_draws()
    assert p_draws.shape == (128,)
    np.testing.assert_array_equal(p_draws, np.full(128, 1.0))
    assert prim.probability_posterior is not None
    assert prim.probability_posterior.sd == 0.0
    # Timing: Dirac at zero by default → CDF all ones, every draw == cdf_mean.
    timing_draws = prim.timing_draws()
    assert timing_draws.shape[0] == 128
    np.testing.assert_array_equal(timing_draws[0], np.ones_like(timing_draws[0]))


def test_structurally_deterministic_primitive_with_shifted_dirac():
    """A deterministic edge with a fixed delay is still a Dirac; the
    CDF jumps from 0 to 1 at deterministic_shift_days."""
    prim = make_structurally_deterministic_primitive(
        transition=_transition(),
        scope=_scope(),
        draw_count=4,
        deterministic_p=0.5,
        deterministic_shift_days=3,
        timing_cdf_max_tau=5,
    )
    assert prim.timing_posterior is not None
    assert prim.timing_posterior.cdf_mean == (0.0, 0.0, 0.0, 1.0, 1.0, 1.0)
    assert prim.timing_posterior.deterministic_shift_days == 3


def test_structurally_deterministic_primitive_records_compat_fields_as_provenance():
    """Plan §87, §583: mu/sigma/onset/completeness compat fields are
    provenance only — never evidence-conditioned timing parameters."""
    prim = make_structurally_deterministic_primitive(
        transition=_transition(),
        scope=_scope(),
        draw_count=8,
        deterministic_p=1.0,
        timing_family=TimingFamily.NON_LATENT,
        structural_identity_compat={
            'mu': 0.0,
            'sigma': 0.0,
            'onset_delta_days': 0.0,
            't95': 0.0,
        },
    )
    assert prim.timing_family == TimingFamily.NON_LATENT
    assert prim.timing_posterior is not None
    compat = prim.timing_posterior.structural_identity_compat
    assert compat == {
        'mu': 0.0,
        'sigma': 0.0,
        'onset_delta_days': 0.0,
        't95': 0.0,
    }


def test_structurally_deterministic_p_out_of_range_raises():
    with pytest.raises(ValueError):
        make_structurally_deterministic_primitive(
            transition=_transition(),
            scope=_scope(),
            draw_count=4,
            deterministic_p=2.0,
        )


# ─── Topology-supported cases ──────────────────────────────────────────


def test_supported_split_join_leakage_topology_classifies_as_parameterised():
    """Plan §660 / baseline §1.9: splits, joins, fan-in, fan-out, and
    side-exit leakage edges that lie inside the carrier or subject
    closure and are parameterised remain ordinary DAG-composition
    inputs. The guard must NOT re-classify them as residual or
    complement requirements just because their *graph* role is a
    split/join/leakage role."""
    topology_roles = (
        'split-at-X',
        'join-at-X',
        'fan-out-downstream',
        'fan-in-upstream',
        'side-exit-leakage',
    )
    for role_label in topology_roles:
        req = EdgeRequirement(
            transition=_transition(f'edge-{role_label}'),
            kind=EdgeRequirementKind.PARAMETERISED,
            note=f'graph role: {role_label}',
        )
        decision = classify_edge_requirement(req)
        assert decision.forward_to_conditioning is True, (
            f'parameterised {role_label} edge must forward to Stage 3, '
            f'not be intercepted by Stage 4'
        )
        assert decision.status_to_emit is None
        assert decision.residual_policy is None


# ─── Static source / import audits ─────────────────────────────────────


def _module_source() -> str:
    return _MODULE_PATH.read_text(encoding='utf-8')


def test_no_one_minus_p_arithmetic_in_module_source():
    """Plan §55, §660 / baseline §1.9: CF composition contains no
    ``1 - p``, residual-sibling, or branch-complement code today.
    Stage 4's guard must not introduce one. We assert no source line
    contains ``1 - p`` / ``1.0 - p`` / ``1-p`` against a probability
    field — the module's purpose is to *refuse* such derivations,
    not to perform them.

    The static check runs over the AST so docstrings and the
    docstring's mention of ``1 - p`` (which is conceptual, not
    arithmetic) are excluded.
    """
    tree = ast.parse(_module_source())
    pattern = re.compile(r'1(\.0)?\s*-\s*p\b')
    offenders = []
    for node in ast.walk(tree):
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Sub):
            try:
                segment = ast.get_source_segment(_module_source(), node) or ''
            except Exception:
                segment = ''
            if pattern.search(segment):
                offenders.append(segment)
    assert offenders == [], (
        f'Stage 4 module must contain no 1 - p arithmetic on probability '
        f'fields; found: {offenders!r}'
    )


def test_module_does_not_import_composition_or_writeback():
    """Plan §662 / baseline §1.11: Stage 4 must not import composition
    surfaces (forecast_runtime, forecast_state, cohort_forecast_v3,
    span_kernel, carrier_composition) or the FE writeback layer
    (UpdateManager). Sibling rebalancing remains owned by
    UpdateManager after CF writeback; the residual guard must not move
    it into CF composition."""
    tree = ast.parse(_module_source())
    forbidden = {
        'forecast_runtime',
        'forecast_state',
        'cohort_forecast_v3',
        'cohort_forecast_v2',
        'cohort_forecast',
        'span_kernel',
        'span_evidence',
        'span_upstream',
        'span_adapter',
        'carrier_composition',
        'primitive_conditioning',
        'updatemanager',
        'UpdateManager',
    }
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                base = alias.name.split('.')[0]
                if base in forbidden:
                    found.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            mod = (node.module or '')
            base = mod.split('.')[-1] if '.' in mod else mod
            if mod in forbidden or base in forbidden:
                found.add(mod)
    assert found == set(), (
        f'Stage 4 module imports forbidden composition / writeback '
        f'surfaces: {found!r}'
    )


def test_module_imports_only_primitives_contract():
    """The guard sits next to the Stage 1 contract module. Any imports
    beyond ``runner.primitives``, stdlib, and numpy would mean the
    guard has acquired a runtime dependency it should not need."""
    tree = ast.parse(_module_source())
    allowed_runner_modules = {'primitives'}
    runner_imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            mod = node.module or ''
            if mod.startswith('runner') or mod.startswith('.') or mod in {
                'primitives', 'primitive_evidence', 'primitive_conditioning',
                'forecast_runtime', 'forecast_state', 'cohort_forecast_v3',
                'span_kernel', 'carrier_composition',
            }:
                runner_imports.append(mod.lstrip('.'))
    for mod in runner_imports:
        assert mod in allowed_runner_modules, (
            f'Stage 4 module imports runner.{mod!r}; only '
            f'runner.primitives is allowed'
        )


# ─── Invariance: writeback ownership ───────────────────────────────────


def test_residual_guard_does_not_expose_sibling_rebalancer():
    """Baseline §1.11 / plan §662: graph-output sibling rebalancing
    remains owned by UpdateManager.applyBatchLAGValues after CF
    writeback. The guard module's public API exposes only
    classification + primitive constructors; nothing that resembles a
    sibling rebalancer.

    This is a structural assertion against the module's __all__ to
    catch a future regression that smuggles a rebalancer in via the
    guard surface."""
    from runner import primitive_residual_guard as mod

    expected = {
        'EdgeRequirement',
        'EdgeRequirementKind',
        'ResidualGuardDecision',
        'classify_edge_requirement',
        'make_structurally_deterministic_primitive',
        'make_unsupported_residual_primitive',
    }
    assert set(mod.__all__) == expected
    forbidden_substrings = ('rebalance', 'sibling', 'writeback', 'applyBatch')
    for name in mod.__all__:
        lowered = name.lower()
        for needle in forbidden_substrings:
            assert needle.lower() not in lowered, (
                f'Stage 4 must not expose a sibling-rebalancing surface: '
                f'{name!r}'
            )
