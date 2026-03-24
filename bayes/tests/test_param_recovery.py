"""
Parameter recovery regression tests.

Runs MCMC on synthetic graphs with known ground truth and asserts the
posteriors recover the true parameters within tolerance. These are
slow integration tests (~2-5 min each) that exercise the full pipeline:
  truth file → DB data → harness → topology → evidence → model → MCMC → comparison

NOT run in CI — run manually before merging model changes:
    . graph-editor/venv/bin/activate
    pytest bayes/tests/test_param_recovery.py -v -s --timeout=600

For parallel execution (all graphs simultaneously):
    scripts/run-param-recovery.sh

Requires:
  - Snapshot DB populated (run synth_gen.py --graph X --write-files first)
  - DB_CONNECTION in graph-editor/.env.local
  - Node.js available (for FE hash computation)

Test graphs:
  - synth-simple-abc: 2-step linear, both latency. Tests basic recovery.
  - synth-mirror-4step: 4-step linear, 2 no-latency + 2 latency. Tests
    mixed model, cohort latency hierarchy, path composition.
  - synth-diamond-test: branch + join. EXPECTED TO FAIL (known join-node
    convergence issue). Marked xfail.
"""

from __future__ import annotations

import os
import sys
import json
import re
import subprocess
import yaml
import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Resolve data repo
_conf_path = os.path.join(REPO_ROOT, ".private-repos.conf")
_data_repo_dir = ""
if os.path.exists(_conf_path):
    for line in open(_conf_path):
        if line.strip().startswith("DATA_REPO_DIR="):
            _data_repo_dir = line.strip().split("=", 1)[1].strip().strip('"')
DATA_REPO = os.path.join(REPO_ROOT, _data_repo_dir) if _data_repo_dir else ""

# ---------------------------------------------------------------------------
# Parallel execution defaults
# ---------------------------------------------------------------------------
# 3 chains × 3 cores per test → 5 tests × 3 cores = 15 of 16 cores
DEFAULT_CHAINS = 3
DEFAULT_CORES = 3

# Pin thread counts to prevent nutpie/BLAS/OpenMP from spawning extra threads
# that would cause contention during parallel runs.
_THREAD_PIN_ENV = {
    "OMP_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
    "OPENBLAS_NUM_THREADS": "1",
    "NUMBA_NUM_THREADS": "1",
}


def _has_db_connection() -> bool:
    env_path = os.path.join(REPO_ROOT, "graph-editor", ".env.local")
    if not os.path.exists(env_path):
        return False
    for line in open(env_path):
        if line.startswith("DB_CONNECTION=") and len(line.strip()) > 15:
            return True
    return False


def _has_synth_data(graph_name: str) -> bool:
    """Check if synth data exists in DB by running preflight."""
    truth_path = os.path.join(DATA_REPO, "graphs", f"{graph_name}.truth.yaml")
    graph_path = os.path.join(DATA_REPO, "graphs", f"{graph_name}.json")
    return os.path.exists(truth_path) and os.path.exists(graph_path)


def _load_truth(graph_name: str) -> dict:
    truth_path = os.path.join(DATA_REPO, "graphs", f"{graph_name}.truth.yaml")
    with open(truth_path) as f:
        return yaml.safe_load(f)


def _run_harness(
    graph_name: str,
    timeout: int = 600,
    features: dict | None = None,
    draws: int = 1000,
    tune: int = 500,
    chains: int = DEFAULT_CHAINS,
    cores: int = DEFAULT_CORES,
) -> str:
    """Run test_harness and return stdout.

    Defaults to fast sampling (1000 draws, 500 tune, 3 chains/cores) for
    regression tests. Wider tolerances compensate for fewer samples.
    Thread-pinning env vars prevent BLAS/OpenMP oversubscription during
    parallel runs.
    """
    cmd = [
        sys.executable,
        os.path.join(REPO_ROOT, "bayes", "test_harness.py"),
        "--graph", graph_name,
        "--no-webhook",
        "--timeout", str(timeout),
        "--draws", str(draws),
        "--tune", str(tune),
        "--chains", str(chains),
        "--cores", str(cores),
    ]
    if features:
        for k, v in features.items():
            cmd.extend(["--feature", f"{k}={'true' if v else 'false'}"])

    env = {**os.environ, **_THREAD_PIN_ENV}
    result = subprocess.run(
        cmd, capture_output=True, text=True,
        timeout=timeout + 60,
        env=env,
    )
    output = result.stdout + result.stderr
    if result.returncode != 0:
        pytest.fail(f"Harness failed (exit {result.returncode}):\n{output[-3000:]}")
    return output


def _parse_results(output: str) -> dict:
    """Parse harness output into structured results."""
    results: dict = {"quality": {}, "edges": {}}

    # Quality
    m = re.search(r"Quality:\s+rhat=([\d.]+),\s+ess=([\d.]+),\s+converged=([\d.]+)%", output)
    if m:
        results["quality"] = {
            "rhat": float(m.group(1)),
            "ess": float(m.group(2)),
            "converged_pct": float(m.group(3)),
        }

    # Per-edge latency posteriors
    for m in re.finditer(
        r"inference:\s+latency (\w{8})…:\s+mu=([\d.]+)±([\d.]+)\s+\(prior=([\d.]+)\),\s+"
        r"sigma=([\d.]+)±([\d.]+)\s+\(prior=([\d.]+)\),\s+rhat=([\d.]+),\s+ess=(\d+)",
        output,
    ):
        prefix = m.group(1)
        results["edges"].setdefault(prefix, {}).update({
            "mu_mean": float(m.group(2)),
            "mu_sd": float(m.group(3)),
            "sigma_mean": float(m.group(5)),
            "sigma_sd": float(m.group(6)),
            "rhat": float(m.group(8)),
            "ess": int(m.group(9)),
        })

    # Onset posteriors
    for m in re.finditer(
        r"inference:\s+onset (\w{8})…:\s+([\d.]+)±([\d.]+)\s+\(prior=([\d.]+)\),\s+"
        r"corr\(onset,mu\)=([-\d.]+)",
        output,
    ):
        prefix = m.group(1)
        results["edges"].setdefault(prefix, {}).update({
            "onset_mean": float(m.group(2)),
            "onset_sd": float(m.group(3)),
            "onset_mu_corr": float(m.group(5)),
        })

    return results


def _map_uuid_to_pid(graph_name: str) -> dict[str, str]:
    """Map 8-char UUID prefix → param_id."""
    graph_path = os.path.join(DATA_REPO, "graphs", f"{graph_name}.json")
    with open(graph_path) as f:
        graph = json.load(f)
    mapping = {}
    for e in graph.get("edges", []):
        pid = e.get("p", {}).get("id", "")
        uuid = e.get("uuid", "")
        if pid and uuid:
            mapping[uuid[:8]] = pid
    return mapping


# ---------------------------------------------------------------------------
# Skip conditions
# ---------------------------------------------------------------------------

requires_db = pytest.mark.skipif(
    not _has_db_connection(),
    reason="No DB_CONNECTION in graph-editor/.env.local",
)

requires_data_repo = pytest.mark.skipif(
    not DATA_REPO or not os.path.isdir(DATA_REPO),
    reason="Data repo not found",
)


# ---------------------------------------------------------------------------
# Recovery assertion helper
# ---------------------------------------------------------------------------

def assert_recovery(
    graph_name: str,
    results: dict,
    truth: dict,
    *,
    mu_atol: float = 0.5,
    sigma_atol: float = 0.3,
    onset_atol: float = 1.5,
    rhat_max: float = 1.05,
    min_ess: float = 200,
):
    """Assert parameter recovery within absolute tolerances.

    Uses absolute tolerance (not z-score) because with large data the
    posteriors can be very tight, making z-scores overly sensitive to
    sub-percent deviations that are scientifically irrelevant.
    """
    uuid_map = _map_uuid_to_pid(graph_name)
    truth_edges = truth.get("edges", {})
    quality = results.get("quality", {})

    # Global convergence
    assert quality.get("rhat", 99) < rhat_max, (
        f"Max rhat {quality['rhat']:.4f} exceeds {rhat_max}"
    )
    assert quality.get("ess", 0) > min_ess, (
        f"Min ESS {quality['ess']:.0f} below {min_ess}"
    )
    assert quality.get("converged_pct", 0) >= 90.0, (
        f"Convergence too low: {quality['converged_pct']}%"
    )

    # Per-edge recovery
    failures = []
    for prefix, post in results.get("edges", {}).items():
        pid = uuid_map.get(prefix, prefix)
        t = truth_edges.get(pid, {})
        if not t:
            continue
        has_latency = t.get("onset", 0) > 0.01 or t.get("mu", 0) > 0.01
        if not has_latency:
            continue

        for param, tkey, pkey, atol in [
            ("mu", "mu", "mu_mean", mu_atol),
            ("sigma", "sigma", "sigma_mean", sigma_atol),
            ("onset", "onset", "onset_mean", onset_atol),
        ]:
            truth_val = t.get(tkey)
            post_val = post.get(pkey)
            if truth_val is None or post_val is None:
                continue
            err = abs(post_val - truth_val)
            if err > atol:
                failures.append(
                    f"{pid} {param}: truth={truth_val:.3f} post={post_val:.3f} "
                    f"err={err:.3f} > atol={atol}"
                )

    if failures:
        pytest.fail(
            f"Parameter recovery failed for {graph_name}:\n"
            + "\n".join(f"  {f}" for f in failures)
        )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@requires_db
@requires_data_repo
@pytest.mark.slow
class TestParamRecovery:
    """Parameter recovery regression tests.

    Each test runs full MCMC and checks posteriors against ground truth.

    Single graph:
        pytest bayes/tests/test_param_recovery.py::TestParamRecovery::test_2step_synth -v -s
    All (sequential):
        pytest bayes/tests/test_param_recovery.py -v -s --timeout=600
    All (parallel via tmux):
        scripts/run-param-recovery.sh
    """

    def test_2step_synth(self):
        """2-step all-latency linear chain: recovery + convergence diagnostics.

        Checks mu/sigma/onset recovery AND zero divergences + non-degenerate
        onset-mu correlation (merged from formerly separate tests to avoid
        a redundant 5-min MCMC run on the same graph).
        """
        graph_name = "synth-simple-abc"
        if not _has_synth_data(graph_name):
            pytest.skip(f"No synth data for {graph_name} — run synth_gen.py first")

        truth = _load_truth(graph_name)
        output = _run_harness(graph_name, timeout=600)
        results = _parse_results(output)

        # --- Recovery ---
        assert_recovery(graph_name, results, truth)

        # --- Convergence diagnostics ---
        # Zero divergences on clean synth data
        div_match = re.search(r"divergences=(\d+)", output)
        if div_match:
            assert int(div_match.group(1)) == 0, "Expected 0 divergences on clean synth data"

        # Onset-mu correlation isn't degenerate (identifiability check)
        for prefix, post in results.get("edges", {}).items():
            corr = post.get("onset_mu_corr")
            if corr is not None:
                assert abs(corr) < 0.99, (
                    f"Edge {prefix}: onset-mu correlation {corr:.3f} is nearly "
                    f"degenerate — identifiability problem"
                )

    def test_4step_mirror_recovery(self):
        """4-step mirror (2 no-latency + 2 latency) recovers latency params."""
        graph_name = "synth-mirror-4step"
        if not _has_synth_data(graph_name):
            pytest.skip(f"No synth data for {graph_name} — run synth_gen.py first")

        truth = _load_truth(graph_name)
        output = _run_harness(graph_name, timeout=300)
        results = _parse_results(output)
        assert_recovery(graph_name, results, truth)

    @pytest.mark.xfail(reason="Join-node convergence issue — known model structure problem")
    def test_diamond_recovery(self):
        """Diamond (branch + join) — expected to fail until join handling is fixed."""
        graph_name = "synth-diamond-test"
        if not _has_synth_data(graph_name):
            pytest.skip(f"No synth data for {graph_name} — run synth_gen.py first")

        truth = _load_truth(graph_name)
        output = _run_harness(graph_name, timeout=600)
        results = _parse_results(output)
        assert_recovery(graph_name, results, truth)
