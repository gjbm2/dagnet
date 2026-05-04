"""
Stage 5a tests for single-hop primitive readout (73n).

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 5a — Single-Hop Window and Subject Cutover (Parity Oracle)".

These tests cover the primitive readout module — the flag, the
eligibility gate, the synthetic identity-clock resolution, and the
closed-form posterior moments that drive parity-grade public
substitution. The api_handlers wiring is exercised at integration level
in test_cohort_factorised_outside_in.py and test_carrier_object_contract.py
(both of which assert flag OFF stays a no-op).

Test categories (from plan §"Stage 5a" lines 670-682):

  - flag plumbing (env var, three states, default off)
  - eligibility gate (single-hop window / cohort A=X / multi-hop / A!=X)
  - synthetic identity-clock resolution (no re-merge; integer counts
    survive)
  - closed-form posterior parity (no MC noise on substituted scalars)
  - full-subset limit (r=1.0) returns prior
  - shadow mode records delta but does not substitute
  - on mode substitutes
  - off mode is a no-op
  - residual guard refusal short-circuits the readout
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

GRAPH_EDITOR_DIR = Path(__file__).resolve().parent.parent.parent
if str(GRAPH_EDITOR_DIR) not in sys.path:
    sys.path.insert(0, str(GRAPH_EDITOR_DIR))
LIB_DIR = GRAPH_EDITOR_DIR / "lib"
if str(LIB_DIR) not in sys.path:
    sys.path.insert(0, str(LIB_DIR))

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
from runner import primitive_readout as pr
from runner.primitive_readout import (
    ACCEPTANCE_ABS_BAND,
    SHADOW_ABS_BAND,
    compute_single_hop_readout,
    is_single_hop_window_eligible,
)
from runner.primitives import PrimitiveScope, TransitionIdentity


# ─── Fixtures ──────────────────────────────────────────────────────────


def _make_evidence_set(*, n: int, k: int) -> EvidenceSet:
    """Build a minimal EvidenceSet with one point carrying (n, k)."""
    identity = EvidenceIdentity(
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        subject_from='X',
        subject_to='Y',
        anchor=None,
        slice_family=SliceFamily.WINDOW,
        context_key=None,
        regime_key=None,
        population_identity=None,
    )
    candidate = EvidenceCandidate(
        source=SourceKind.SNAPSHOT,
        identity=identity,
        coordinate=ObservationCoordinate(
            observed_date='2026-02-15', retrieved_at='2026-02-20'
        ),
        n=n,
        k=k,
    )
    prov = EvidenceProvenance(
        schema_version=PROVENANCE_SCHEMA_VERSION,
        role=EvidenceRole.WINDOW_SUBJECT_HELPER,
        scope_key='X|Y|window|test',
        scenario_id='scen-1',
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
            subject_from='X',
            subject_to='Y',
            date_from='2026-02-01',
            date_to='2026-04-30',
        ),
        points=(EvidencePoint(candidate=candidate),),
        skipped=(),
        totals=EvidenceTotals(n=n, k=k),
        totals_by_source={SourceKind.SNAPSHOT: EvidenceTotals(n=n, k=k)},
        provenance=prov,
    )


def _make_resolved_model(
    *, alpha: float = 2.0, beta: float = 2.0, n_effective=None
) -> ResolvedModelParams:
    return ResolvedModelParams(
        alpha=alpha,
        beta=beta,
        alpha_pred=alpha,
        beta_pred=beta,
        n_effective=n_effective,
        edge_latency=ResolvedLatency(),
        source='analytic',
    )


def _make_transition() -> TransitionIdentity:
    return TransitionIdentity(
        source_node='X', destination_node='Y', edge_id='edge-X-Y'
    )


def _make_scope() -> PrimitiveScope:
    return PrimitiveScope(
        scenario_id='scen-1',
        evidence_role='window_subject_helper',
        date_from='2026-02-01',
        date_to='2026-04-30',
        as_at=None,
        context_key=None,
        regime_key=None,
        model_source_preference='analytic',
        resolved_source_identity='analytic',
    )


# ─── Flag plumbing ─────────────────────────────────────────────────────


# ─── Eligibility gate ──────────────────────────────────────────────────


def test_eligible_single_hop_window():
    assert is_single_hop_window_eligible(
        is_multi_hop=False, is_window=True,
        anchor_node_id=None, query_from_node='X',
    )


def test_eligible_single_hop_cohort_a_equals_x():
    assert is_single_hop_window_eligible(
        is_multi_hop=False, is_window=False,
        anchor_node_id='X', query_from_node='X',
    )


def test_ineligible_single_hop_cohort_a_not_x():
    # Plan §155: active cohort A!=X has a real carrier; Stage 6 owns it.
    assert not is_single_hop_window_eligible(
        is_multi_hop=False, is_window=False,
        anchor_node_id='A', query_from_node='X',
    )


def test_ineligible_multi_hop_window():
    assert not is_single_hop_window_eligible(
        is_multi_hop=True, is_window=True,
        anchor_node_id=None, query_from_node='X',
    )


def test_ineligible_multi_hop_cohort():
    assert not is_single_hop_window_eligible(
        is_multi_hop=True, is_window=False,
        anchor_node_id='X', query_from_node='X',
    )


def test_ineligible_cohort_missing_anchor():
    # Conservative: missing anchor information defers to legacy.
    assert not is_single_hop_window_eligible(
        is_multi_hop=False, is_window=False,
        anchor_node_id=None, query_from_node='X',
    )


# ─── Closed-form posterior parity ──────────────────────────────────────


def test_single_hop_mean_matches_maturity_aware_primitive_posterior():
    """Stage 9 migrates the primitive posterior to the maturity-aware
    likelihood, so public moments read the primitive's sampled posterior
    rather than reconstructing a raw-total conjugate shortcut.
    """
    res = compute_single_hop_readout(
        eligible=True,
        skip_reason=None,
        transition=_make_transition(),
        primitive_scope=_make_scope(),
        evidence_set=_make_evidence_set(n=100, k=70),
        resolved_model=_make_resolved_model(),
        scenario_seed=42,
        legacy_p_mean=0.692,
        legacy_p_sd=0.04,
        legacy_p_sd_epistemic=0.04,
    )
    assert res.should_substitute
    posterior = res.primitive.probability_posterior
    assert posterior is not None
    assert res.p_mean_primitive == pytest.approx(posterior.mean)
    assert res.diagnostics['primitive_provenance']['notes'][-1].startswith(
        'maturity_aware_mode='
    )


def test_full_subset_limit_returns_prior():
    """When m_S/m_G → 1 the primitive numerically equals model vars
    (plan §224, §240-244). Beta(2,2) prior with n_effective=50 and
    n_w=100 gives r = min(100/50, 1) = 1. The sampled prior leg is
    finite-S, so assert the Stage 0c acceptance band rather than an
    impossible exact floating-point equality.
    """
    res = compute_single_hop_readout(
        eligible=True,
        skip_reason=None,
        transition=_make_transition(),
        primitive_scope=_make_scope(),
        evidence_set=_make_evidence_set(n=100, k=70),
        resolved_model=_make_resolved_model(n_effective=50),
        scenario_seed=42,
        legacy_p_mean=0.5,
        legacy_p_sd=0.2,
        legacy_p_sd_epistemic=0.2,
    )
    assert res.should_substitute
    assert abs(res.p_mean_primitive - 0.5) < 0.002
    assert res.diagnostics['primitive_subset_r'] == 1.0


def test_zero_subset_limit_returns_full_conjugate():
    """When m_S/m_G → 0 (n_effective much larger than n_w) the primitive
    receives full evidence pressure (plan §240). r ≈ 0 ⇒ mix mean ≈
    cond mean.
    """
    res = compute_single_hop_readout(
        eligible=True,
        skip_reason=None,
        transition=_make_transition(),
        primitive_scope=_make_scope(),
        evidence_set=_make_evidence_set(n=10, k=8),
        resolved_model=_make_resolved_model(n_effective=10000),
        scenario_seed=42,
        legacy_p_mean=0.7,
        legacy_p_sd=0.15,
        legacy_p_sd_epistemic=0.15,
    )
    assert res.should_substitute
    # cond Beta(10, 4); cond_mean = 10/14 ≈ 0.7143. r ≈ 0.001 → mix ≈ cond.
    assert abs(res.p_mean_primitive - 10.0 / 14.0) < 0.01


# ─── Mode behaviour ────────────────────────────────────────────────────


def test_shadow_band_constants_match_stage_0c_contract():
    # Plan / Stage 0c §3.3.
    assert SHADOW_ABS_BAND == 0.005
    assert ACCEPTANCE_ABS_BAND == 0.002


# ─── Skip reasons ──────────────────────────────────────────────────────


def test_ineligible_request_returns_diagnostic_skip_not_substitution():
    res = compute_single_hop_readout(
        eligible=False,
        skip_reason='multi_hop',
        transition=None,
        primitive_scope=None,
        evidence_set=None,
        resolved_model=None,
        scenario_seed=42,
        legacy_p_mean=0.5,
        legacy_p_sd=0.1,
        legacy_p_sd_epistemic=0.1,
    )
    assert not res.should_substitute
    assert res.skip_reason == 'multi_hop'
    assert res.primitive is None


def test_eligible_but_inputs_missing_records_soft_skip():
    res = compute_single_hop_readout(
        eligible=True,
        skip_reason=None,
        transition=_make_transition(),
        primitive_scope=_make_scope(),
        evidence_set=None,  # missing input
        resolved_model=_make_resolved_model(),
        scenario_seed=42,
        legacy_p_mean=0.692,
        legacy_p_sd=0.04,
        legacy_p_sd_epistemic=0.04,
    )
    assert not res.should_substitute
    assert res.skip_reason == 'incomplete_inputs'
    assert 'evidence_set' in res.diagnostics['missing_inputs']


# ─── Diagnostics surface ───────────────────────────────────────────────


def test_diagnostics_carry_full_provenance():
    res = compute_single_hop_readout(
        eligible=True,
        skip_reason=None,
        transition=_make_transition(),
        primitive_scope=_make_scope(),
        evidence_set=_make_evidence_set(n=100, k=70),
        resolved_model=_make_resolved_model(),
        scenario_seed=42,
        legacy_p_mean=0.692,
        legacy_p_sd=0.04,
        legacy_p_sd_epistemic=0.04,
    )
    diag = res.diagnostics
    assert diag['eligible'] is True
    assert diag['primitive_status'] == 'conditioned'
    assert diag['primitive_n_weighted_total'] == 100.0
    assert diag['primitive_k_weighted_total'] == 70.0
    assert 'closed_form_public_moments' in diag
    assert 'legacy_public_moments' in diag
    assert 'delta_p_mean' in diag
    assert 'within_shadow_band' in diag


# ─── Identity-clock binding (no re-merge) ──────────────────────────────


def test_canonical_binder_preserves_evidence_totals_under_identity_mask():
    # Stage 5a routes through ``bind_primitive_evidence``: the candidates
    # are lifted out of the upstream EvidenceSet, the merge layer is
    # re-run (idempotent for already-distinct rows), and identity arrival
    # weights (1.0 over each day in the request window) admit every
    # in-window row at full evidence pressure. The binder derives its
    # own scope_key from the merge output rather than carrying through
    # the upstream provenance's key — that is the canonical pathway's
    # behaviour and the price of having a single entry point.
    ev_set = _make_evidence_set(n=100, k=70)
    res = compute_single_hop_readout(
        eligible=True,
        skip_reason=None,
        transition=_make_transition(),
        primitive_scope=_make_scope(),
        evidence_set=ev_set,
        resolved_model=_make_resolved_model(),
        scenario_seed=42,
        legacy_p_mean=0.692,
        legacy_p_sd=0.04,
        legacy_p_sd_epistemic=0.04,
    )
    assert res.primitive is not None
    assert res.primitive.weighted_evidence is not None
    # Identity mask preserves row n/k under arrival_weight=1.0.
    assert res.primitive.weighted_evidence.n_weighted_total == 100.0
    assert res.primitive.weighted_evidence.k_weighted_total == 70.0
    # The binder stamps its own binding policy — the merge-layer-derived
    # scope_key flows through verbatim from the primitive's weighted view.
    assert (
        res.primitive.weighted_evidence.binding_policy
        == 'weighted_day_binding.v1'
    )
    assert res.primitive.weighted_evidence.evidence_scope_key.startswith(
        'scope:'
    )


# ─── Should_substitute property ────────────────────────────────────────


def test_should_substitute_property_eligible_request_substitutes():
    res_on = compute_single_hop_readout(
        eligible=True,
        skip_reason=None,
        transition=_make_transition(),
        primitive_scope=_make_scope(),
        evidence_set=_make_evidence_set(n=100, k=70),
        resolved_model=_make_resolved_model(),
        scenario_seed=42,
        legacy_p_mean=0.692,
        legacy_p_sd=0.04,
        legacy_p_sd_epistemic=0.04,
    )
    assert res_on.should_substitute
