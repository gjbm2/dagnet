"""Stage 0 outside-in CLI regression gate (doc 73b §8 Stage 0).

§8: "Outside-in CLI regressions that compare param-pack, CF, and
cohort-maturity public surfaces are mandatory gates, not optional
follow-up."

This test pins the named outside-in regression suite so a future
revision cannot silently delete the gate. The named files are the
public-surface comparators for the three gate categories called out
in the plan:

- **Param-pack**: ``test_v2_v3_parity_outside_in.py`` and the
  shared CLI/FE prepared-graph alignment regressions are the public
  param-pack parity surfaces (per doc 73a §12 and 73b §11.2).
- **CF**: ``test_cf_truth_parity.py``,
  ``test_conditioned_forecast_parity.py``,
  ``test_conditioned_forecast_response_contract.py`` are the public
  CF surfaces.
- **Cohort-maturity**: ``test_cohort_maturity_v3_contract.py``,
  ``test_cohort_maturity_model_parity.py``, and the supporting
  derivation / no-evidence files cover the public cohort-maturity
  surfaces.

The plan also documents the post-handoff baseline (8 newly-failing
tests assigned to Stage 4(d) plus Stage 2 / Stage 4(a) per the
ownership table in §8). Stage 0's gate role is *existence and
collectability*, not *all-green status* — the failing entries are
known and owned. Stage 0 does not weaken or skip them.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

TESTS_ROOT = os.path.dirname(os.path.abspath(__file__))

PARAM_PACK_GATES = (
    'test_v2_v3_parity_outside_in.py',
    'test_v2_v3_parity.py',
    'test_multihop_evidence_parity.py',
    'test_window_cohort_convergence.py',
)

CF_GATES = (
    'test_cf_truth_parity.py',
    'test_conditioned_forecast_parity.py',
    'test_conditioned_forecast_response_contract.py',
)

COHORT_MATURITY_GATES = (
    'test_cohort_maturity_v3_contract.py',
    'test_cohort_maturity_model_parity.py',
    'test_cohort_maturity_derivation.py',
    'test_cohort_maturity_no_evidence.py',
    'test_cohort_maturity_no_evidence_truth.py',
    'test_cohort_factorised_outside_in.py',
)


@pytest.mark.parametrize('filename', PARAM_PACK_GATES)
def test_param_pack_outside_in_gate_exists(filename):
    path = os.path.join(TESTS_ROOT, filename)
    assert os.path.exists(path), (
        f"Outside-in param-pack regression gate `{filename}` is missing. "
        f"§8 Stage 0 names this as a mandatory public-surface gate. "
        f"Re-add it or update this test if the gate was renamed."
    )


@pytest.mark.parametrize('filename', CF_GATES)
def test_cf_outside_in_gate_exists(filename):
    path = os.path.join(TESTS_ROOT, filename)
    assert os.path.exists(path), (
        f"Outside-in CF regression gate `{filename}` is missing. "
        f"§8 Stage 0 names CF-public-surface comparators as mandatory."
    )


@pytest.mark.parametrize('filename', COHORT_MATURITY_GATES)
def test_cohort_maturity_outside_in_gate_exists(filename):
    path = os.path.join(TESTS_ROOT, filename)
    assert os.path.exists(path), (
        f"Outside-in cohort-maturity regression gate `{filename}` is "
        f"missing. §8 Stage 0 names cohort-maturity public-surface "
        f"comparators as mandatory."
    )


def test_baseline_failure_set_documented_in_plan():
    """Pin the 8 newly-failing entries from the doc 73a-2 receiving
    handoff so the plan and the test ownership stay synchronised. If
    the failing set drifts, Stage 0 has not been re-baselined and the
    drift must be classified explicitly.
    """
    plan_path = os.path.normpath(
        os.path.join(
            TESTS_ROOT, '..', '..', '..',
            'docs', 'current', 'project-bayes',
            '73b-be-topo-removal-and-forecast-state-separation-plan.md',
        )
    )
    with open(plan_path, 'r', encoding='utf-8') as f:
        plan = f.read()

    expected_failures = (
        'test_multihop_evidence_parity.py::TestMultihopCollapse::test_evidence_x_parity',
        'test_multihop_evidence_parity.py::TestMultihopCollapse::test_evidence_y_parity',
        'test_v2_v3_parity_outside_in.py::TestV2V3ParityOutsideIn::test_midpoint_parity_per_tau[single-hop-cohort-wide]',
        'test_v2_v3_parity_outside_in.py::TestV2V3ParityOutsideIn::test_v2_returns_non_vacuous_data[single-hop-cohort-narrow]',
        'test_v2_v3_parity_outside_in.py::TestV2V3ParityOutsideIn::test_midpoint_parity_per_tau[multi-hop-cohort-wide]',
        'test_v2_v3_parity_outside_in.py::TestV2V3ParityOutsideIn::test_midpoint_parity_per_tau[multi-hop-cohort-narrow]',
        'test_v2_v3_parity_outside_in.py::TestV2V3ParityOutsideIn::test_midpoint_parity_per_tau[single-hop-window]',
        'test_window_cohort_convergence.py::test_multi_hop_composition[synth-mirror-4step:c-d-e]',
    )
    for nodeid in expected_failures:
        assert nodeid in plan, (
            f"Stage 0 receiving handoff drift: expected failure "
            f"`{nodeid}` not listed in the plan's §8 baseline section. "
            f"Either the entry was resolved (and the plan must record "
            f"it) or new failures appeared (and the plan must classify "
            f"them per §8 expected-versus-unexpected receipt rules)."
        )


def test_baseline_counts_documented_in_plan():
    """Pin the documented baseline + current-rerun counts so a future
    revision cannot quietly drift them. §8 says: collected 1163 →
    1247; passed 1122 → 1198; skipped 31 → 31; failed 10 → 18; delta
    +84 / +76 / 0 / +8.
    """
    plan_path = os.path.normpath(
        os.path.join(
            TESTS_ROOT, '..', '..', '..',
            'docs', 'current', 'project-bayes',
            '73b-be-topo-removal-and-forecast-state-separation-plan.md',
        )
    )
    with open(plan_path, 'r', encoding='utf-8') as f:
        plan = f.read()

    assert 'collected 1163' in plan
    assert 'collected 1247' in plan
    assert 'failed 10' in plan
    assert 'failed 18' in plan
    assert '+84 collected, +76 passed, +0 skipped, +8 failed' in plan
