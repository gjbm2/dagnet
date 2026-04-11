"""Blind tests for _audit_harness_log — verify the multi-layered
regression report catches every failure mode.

Each test crafts a synthetic harness log with a known defect and
asserts the audit function detects it correctly. This prevents
regressions in the reporting itself.
"""
import os
import tempfile
import pytest

# Import the function under test
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from run_regression import _audit_harness_log


# ---------------------------------------------------------------------------
# Fixtures: synthetic harness log fragments
# ---------------------------------------------------------------------------

LOG_HEALTHY = """
Log file: /tmp/bayes_harness-graph-synth-test.log
  features: {'latency_dispersion': True}
    model: features: latent_latency=True, cohort_latency=True, overdispersion=True, latent_onset=True, window_only=False, latency_dispersion=True
    model:   latency: abc12345… mu_prior=2.300, sigma_prior=0.501 → latent
    model:   latency: def67890… mu_prior=1.500, sigma_prior=0.400 → latent
    model:   latency_dispersion abc12345_xxxx (window): kappa_lat ~ LogNormal, BetaBinomial intervals
    model:   latency_dispersion def67890_xxxx (window): kappa_lat ~ LogNormal, BetaBinomial intervals
    snapshot: abc12345… → 4872 rows
    snapshot: def67890… → 3201 rows
    evidence: INFO edge abc12345…: 4872 snapshot rows → window(97 trajs, 2 daily), cohort(0 trajs, 0 daily)
    evidence: INFO edge def67890…: 3201 snapshot rows → window(65 trajs, 1 daily), cohort(0 trajs, 0 daily)
  binding receipt: 2 bound, 0 fallback, 0 skipped, 0 no-subjects, 0 warned, 0 failed (mode=log)
    sampling_ms: 15000ms
    sampling_phase2_ms: 12000ms
    inference:   latency abc12345…: mu=2.304±0.004 (prior=2.300), sigma=0.502±0.002 (prior=0.501), rhat=1.005, ess=1668, kappa_lat=559.7±106.8
    inference:   latency def67890…: mu=1.508±0.006 (prior=1.500), sigma=0.398±0.003 (prior=0.400), rhat=1.003, ess=1404, kappa_lat=1003.0±83.5

Status:      complete
Quality:     rhat=1.0050, ess=1404.0, converged=100.0%
"""

LOG_FALLBACK = """
Log file: /tmp/bayes_harness-graph-synth-fallback.log
    model: features: latent_latency=True, cohort_latency=True, overdispersion=True, latent_onset=True, window_only=False, latency_dispersion=True
    model:   latency: abc12345… mu_prior=2.300, sigma_prior=0.501 → latent
    model:   latency_dispersion abc12345_xxxx (window): kappa_lat ~ LogNormal, BetaBinomial intervals
    evidence: INFO edge abc12345…: no snapshot data, using engorged graph edge
    evidence: INFO edge def67890…: no snapshot data, using engorged graph edge
  binding receipt: 2 bound, 0 fallback, 0 skipped, 0 no-subjects, 2 warned, 0 failed (mode=log)
    sampling_ms: 15000ms
    inference:   latency abc12345…: mu=2.304±0.004 (prior=2.300), sigma=0.502±0.002 (prior=0.501), rhat=1.005, ess=1668

Status:      complete
Quality:     rhat=1.0050, ess=1668.0, converged=100.0%
"""

LOG_NO_KAPPA_LAT = """
Log file: /tmp/bayes_harness-graph-synth-nokl.log
    model: features: latent_latency=True, cohort_latency=True, overdispersion=True, latent_onset=True, window_only=False, latency_dispersion=True
    model:   latency: abc12345… mu_prior=2.300, sigma_prior=0.501 → latent
    evidence: INFO edge abc12345…: 4872 snapshot rows → window(97 trajs, 2 daily), cohort(0 trajs, 0 daily)
  binding receipt: 1 bound, 0 fallback, 0 skipped, 0 no-subjects, 0 warned, 0 failed (mode=log)
    sampling_ms: 15000ms
    inference:   latency abc12345…: mu=2.304±0.004 (prior=2.300), sigma=0.502±0.002 (prior=0.501), rhat=1.005, ess=1668

Status:      complete
Quality:     rhat=1.0050, ess=1668.0, converged=100.0%
"""

LOG_NO_PRIORS = """
Log file: /tmp/bayes_harness-graph-synth-nopriors.log
    model: features: latent_latency=True, cohort_latency=True, overdispersion=True, latent_onset=True, window_only=False, latency_dispersion=True
    evidence: INFO edge abc12345…: 4872 snapshot rows → window(97 trajs, 2 daily), cohort(0 trajs, 0 daily)
  binding receipt: 1 bound, 0 fallback, 0 skipped, 0 no-subjects, 0 warned, 0 failed (mode=log)
    sampling_ms: 15000ms
    inference:   latency abc12345…: mu=0.003±0.504 (prior=0.000), sigma=0.999±0.690 (prior=0.500), rhat=1.005, ess=1668

Status:      complete
Quality:     rhat=1.0050, ess=1668.0, converged=100.0%
"""

LOG_INCOMPLETE = """
Log file: /tmp/bayes_harness-graph-synth-incomplete.log
    model: features: latent_latency=True, cohort_latency=True, overdispersion=True, latent_onset=True, window_only=False, latency_dispersion=True

  EARLY ABORT: Estimated 45 min exceeds 3x expected (300s).
"""


# ---------------------------------------------------------------------------
# Helper: write log to temp file and run audit
# ---------------------------------------------------------------------------

def _run_audit(log_content: str, graph_name: str = "synth-test") -> dict:
    """Write log content to the expected path and run audit."""
    path = f"/tmp/bayes_harness-graph-{graph_name}.log"
    with open(path, "w") as f:
        f.write(log_content)
    try:
        return _audit_harness_log(graph_name)
    finally:
        os.remove(path)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestAuditHealthyLog:
    def test_log_found(self):
        a = _run_audit(LOG_HEALTHY)
        assert a["log_found"] is True

    def test_completed(self):
        a = _run_audit(LOG_HEALTHY)
        assert a["completed"] is True

    def test_snapshot_binding(self):
        a = _run_audit(LOG_HEALTHY)
        assert a["data_binding"]["snapshot_edges"] == 2
        assert a["data_binding"]["fallback_edges"] == 0

    def test_binding_receipt(self):
        a = _run_audit(LOG_HEALTHY)
        assert a["data_binding"]["total_bound"] == 2
        assert a["data_binding"]["total_failed"] == 0

    def test_latency_priors(self):
        a = _run_audit(LOG_HEALTHY)
        assert a["priors"]["edges_with_latency_prior"] == 2

    def test_kappa_lat(self):
        a = _run_audit(LOG_HEALTHY)
        assert a["model"]["kappa_lat_edges"] == 2
        assert a["model"]["latency_dispersion_flag"] is True

    def test_inference_mu(self):
        a = _run_audit(LOG_HEALTHY)
        assert a["inference"]["edges_with_mu"] == 2
        details = a["inference"]["mu_details"]
        assert details[0]["uuid"] == "abc12345"
        assert abs(details[0]["mu"] - 2.304) < 0.001
        assert abs(details[0]["prior"] - 2.300) < 0.001
        assert details[0]["ess"] == 1668
        assert abs(details[0]["kappa_lat"] - 559.7) < 0.1

    def test_convergence(self):
        a = _run_audit(LOG_HEALTHY)
        assert abs(a["convergence"]["rhat"] - 1.005) < 0.001
        assert a["convergence"]["ess"] == 1404.0
        assert a["convergence"]["converged_pct"] == 100.0

    def test_phase2_sampled(self):
        a = _run_audit(LOG_HEALTHY)
        assert a["model"]["phase1_sampled"] is True
        assert a["model"]["phase2_sampled"] is True


class TestAuditFallbackLog:
    def test_detects_fallback(self):
        a = _run_audit(LOG_FALLBACK, "synth-fallback")
        assert a["data_binding"]["fallback_edges"] == 2
        assert a["data_binding"]["snapshot_edges"] == 0

    def test_still_completed(self):
        a = _run_audit(LOG_FALLBACK, "synth-fallback")
        assert a["completed"] is True


class TestAuditNoKappaLat:
    def test_flag_on_but_no_kl(self):
        a = _run_audit(LOG_NO_KAPPA_LAT, "synth-nokl")
        assert a["model"]["latency_dispersion_flag"] is True
        assert a["model"]["kappa_lat_edges"] == 0

    def test_snapshot_binding_ok(self):
        a = _run_audit(LOG_NO_KAPPA_LAT, "synth-nokl")
        assert a["data_binding"]["snapshot_edges"] == 1
        assert a["data_binding"]["fallback_edges"] == 0


class TestAuditNoPriors:
    def test_no_mu_prior_lines(self):
        a = _run_audit(LOG_NO_PRIORS, "synth-nopriors")
        # No "mu_prior=" lines in model section (only in inference)
        assert a["priors"]["edges_with_latency_prior"] == 0

    def test_inference_still_found(self):
        a = _run_audit(LOG_NO_PRIORS, "synth-nopriors")
        assert a["inference"]["edges_with_mu"] == 1
        assert abs(a["inference"]["mu_details"][0]["prior"] - 0.0) < 0.001


class TestAuditIncompleteLog:
    def test_not_completed(self):
        a = _run_audit(LOG_INCOMPLETE, "synth-incomplete")
        assert a["log_found"] is True
        assert a["completed"] is False

    def test_no_inference(self):
        a = _run_audit(LOG_INCOMPLETE, "synth-incomplete")
        assert a["inference"]["edges_with_mu"] == 0


class TestAuditMissingLog:
    def test_missing_log(self):
        # Don't create any log file
        a = _audit_harness_log("synth-nonexistent-graph-xyz")
        assert a["log_found"] is False
        assert a["completed"] is False
        assert a["data_binding"]["snapshot_edges"] == 0


class TestAuditJobLabel:
    """Verify run_id-bound log files are found correctly."""

    def test_job_label_takes_precedence(self):
        """When job_label log exists, it's used instead of graph_name log."""
        # Write a healthy log under the job_label path
        label = "synth-test-r1234567890"
        path = f"/tmp/bayes_harness-{label}.log"
        with open(path, "w") as f:
            f.write(LOG_HEALTHY)
        # Write a DIFFERENT log under the graph_name path (should be ignored)
        graph_path = f"/tmp/bayes_harness-graph-synth-test.log"
        with open(graph_path, "w") as f:
            f.write(LOG_FALLBACK)
        try:
            a = _audit_harness_log("synth-test", job_label=label)
            # Should find the healthy log (via job_label), not the fallback one
            assert a["data_binding"]["snapshot_edges"] == 2
            assert a["data_binding"]["fallback_edges"] == 0
        finally:
            os.remove(path)
            os.remove(graph_path)

    def test_falls_back_to_graph_name(self):
        """Without job_label, falls back to graph_name log."""
        a = _run_audit(LOG_HEALTHY)
        assert a["log_found"] is True
        assert a["data_binding"]["snapshot_edges"] == 2
