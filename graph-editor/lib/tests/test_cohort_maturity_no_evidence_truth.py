"""cohort_maturity zero-evidence truth-degeneracy canary.

Locks the FE / CLI / analysis stack on the public no-evidence boundary,
asserting that the chart curves degenerate onto the analytic
``p × CDF(tau)`` implied by the synth truth file.

The companion direct-Python contract test locks the ``fe is None`` logic
path; this one locks the public-tooling path. Both must hold or the
public output silently diverges from the analytic limit.

Fixture: synth-mirror-4step, single edge m4-delegated -> m4-registered,
query ``window(31-Jan-26:15-Mar-26).asat(1-Feb-26)`` with the canonical
Bayes sidecar applied via ``--bayes-vars``.

Replaces ``graph-ops/scripts/cohort-maturity-no-evidence-truth-test.sh``.
The bash file is preserved as a thin shim that delegates here.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
from pathlib import Path
from typing import Any, Optional

import pytest
import yaml

from conftest import requires_data_repo, requires_db, _ensure_synth_ready
from _daemon_client import DaemonError, get_default_client


_REPO_ROOT = Path(__file__).resolve().parents[3]
_ANALYSE_SH = _REPO_ROOT / "graph-ops" / "scripts" / "analyse.sh"
_TRUTH_DIR = _REPO_ROOT / "bayes" / "truth"
_FIXTURES_DIR = _REPO_ROOT / "bayes" / "fixtures"

_PYTHON_BE_URL = os.environ.get("PYTHON_API_URL", "http://localhost:9000")

_GRAPH = "synth-mirror-4step"
_EDGE_NAME = "m4-delegated-to-registered"
_QUERY = "from(m4-delegated).to(m4-registered).window(31-Jan-26:15-Mar-26).asat(1-Feb-26)"

# Per cohort-maturity-no-evidence-truth-test.sh PY block (lines 94-96).
_TOL = 0.012
_COLLAPSE_TOL = 1e-6
_MIN_EXPECTED = 0.003
_MIN_INFORMATIVE_ROWS = 8


def _python_be_reachable() -> bool:
    try:
        import urllib.request

        with urllib.request.urlopen(
            f"{_PYTHON_BE_URL}/__dagnet/server-info",
            timeout=2,
        ) as response:
            return response.status == 200
    except Exception:
        return False


requires_python_be = pytest.mark.skipif(
    not _python_be_reachable(),
    reason=f"Python BE not reachable at {_PYTHON_BE_URL}",
)


def _resolve_data_repo_path() -> Optional[str]:
    conf = _REPO_ROOT / ".private-repos.conf"
    if not conf.exists():
        return None
    for line in conf.read_text().splitlines():
        if line.startswith("DATA_REPO_DIR="):
            return str(_REPO_ROOT / line.split("=", 1)[1].strip())
    return None


_DATA_REPO_PATH = _resolve_data_repo_path()


def _run_analyse_with_sidecar(graph: str, dsl: str, sidecar: Path) -> dict[str, Any]:
    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        args = [
            "--graph", _DATA_REPO_PATH,
            "--name", graph,
            "--query", dsl,
            "--type", "cohort_maturity",
            "--no-cache", "--no-snapshot-cache",
            "--format", "json",
            "--bayes-vars", str(sidecar),
        ]
        try:
            return client.call_json("analyse", args)
        except DaemonError as exc:
            raise AssertionError(
                f"daemon analyse failed for {graph} / {dsl!r}: {exc}\n"
                f"stderr:\n{exc.stderr[-2000:]}"
            )
    cmd = [
        "bash", str(_ANALYSE_SH), graph, dsl,
        "--type", "cohort_maturity",
        "--no-cache", "--no-snapshot-cache",
        "--format", "json",
        "--bayes-vars", str(sidecar),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(_REPO_ROOT), timeout=300)
    if result.returncode != 0:
        raise AssertionError(f"analyse.sh exit {result.returncode}\nstderr:\n{result.stderr[-2000:]}")
    idx = result.stdout.find("{")
    return json.loads(result.stdout[idx:])


def _shifted_lognormal_cdf(tau: int, *, onset: float, mu: float, sigma: float) -> float:
    model_age = float(tau) - onset
    if model_age <= 0 or sigma <= 0:
        return 0.0
    z = (math.log(model_age) - mu) / sigma
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


@requires_db
@requires_data_repo
@requires_python_be
def test_no_evidence_curve_matches_truth_analytic() -> None:
    """Public no-evidence chart must equal analytic p×CDF(tau) within tolerance."""
    _ensure_synth_ready(_GRAPH, enriched=True, bayesian=True, check_fe_parity=False)

    sidecar_path = _FIXTURES_DIR / f"{_GRAPH}.bayes-vars.json"
    if not sidecar_path.exists():
        pytest.skip(f"Bayes sidecar missing: {sidecar_path}")

    truth_path = _TRUTH_DIR / f"{_GRAPH}.truth.yaml"
    if not truth_path.exists():
        pytest.skip(f"Truth file missing: {truth_path}")
    truth = yaml.safe_load(truth_path.read_text())
    edge = (truth.get("edges") or {}).get(_EDGE_NAME)
    if edge is None:
        pytest.fail(f"truth edge {_EDGE_NAME!r} missing from {truth_path}")
    p = float(edge["p"])
    mu = float(edge["mu"])
    sigma = float(edge["sigma"])
    onset = float(edge["onset"])

    payload = _run_analyse_with_sidecar(_GRAPH, _QUERY, sidecar_path)
    result_block = payload.get("result") or payload

    rows = result_block.get("data") or []
    if not rows:
        pytest.fail("result.data is empty")

    model_curves = (result_block.get("metadata") or {}).get("model_curves") or {}
    if not model_curves:
        pytest.fail("metadata.model_curves missing")
    curve = next(iter(model_curves.values())).get("curve") or []
    curve_by_tau: dict[int, float] = {}
    for point in curve:
        tau = point.get("tau_days")
        rate = point.get("model_rate")
        if tau is not None and rate is not None:
            curve_by_tau[int(tau)] = float(rate)
    if not curve_by_tau:
        pytest.fail("promoted overlay curve is empty")

    eligible: list[dict[str, Any]] = []
    for row in rows:
        tau = row.get("tau_days")
        midpoint = row.get("midpoint")
        model_midpoint = row.get("model_midpoint")
        if tau is None or midpoint is None or model_midpoint is None:
            continue
        tau_i = int(tau)
        overlay = curve_by_tau.get(tau_i)
        if overlay is None:
            continue
        expected = p * _shifted_lognormal_cdf(tau_i, onset=onset, mu=mu, sigma=sigma)
        if expected < _MIN_EXPECTED:
            continue
        eligible.append({
            "tau": tau_i,
            "midpoint": float(midpoint),
            "model_midpoint": float(model_midpoint),
            "overlay": float(overlay),
            "expected": float(expected),
            "evidence_x": row.get("evidence_x"),
            "evidence_y": row.get("evidence_y"),
        })

    if len(eligible) < _MIN_INFORMATIVE_ROWS:
        pytest.fail(
            f"only {len(eligible)} informative rows found "
            f"(need ≥ {_MIN_INFORMATIVE_ROWS})"
        )

    violations: list[str] = []
    for r in eligible:
        tau = r["tau"]
        midpoint = r["midpoint"]
        model_midpoint = r["model_midpoint"]
        overlay = r["overlay"]
        expected = r["expected"]
        evidence_x = r["evidence_x"]
        evidence_y = r["evidence_y"]

        if evidence_x is not None or evidence_y is not None:
            violations.append(
                f"tau={tau}: expected null evidence, got "
                f"evidence_x/evidence_y={evidence_x!r}/{evidence_y!r}"
            )
        if abs(midpoint - model_midpoint) > _COLLAPSE_TOL:
            violations.append(
                f"tau={tau}: midpoint={midpoint:.8f} != model_midpoint={model_midpoint:.8f}"
            )
        if abs(overlay - model_midpoint) > _COLLAPSE_TOL:
            violations.append(
                f"tau={tau}: overlay={overlay:.8f} != model_midpoint={model_midpoint:.8f}"
            )
        if abs(midpoint - expected) > _TOL:
            violations.append(
                f"tau={tau}: midpoint={midpoint:.8f} differs from expected={expected:.8f}"
            )
        if abs(model_midpoint - expected) > _TOL:
            violations.append(
                f"tau={tau}: model_midpoint={model_midpoint:.8f} differs from expected={expected:.8f}"
            )
        if abs(overlay - expected) > _TOL:
            violations.append(
                f"tau={tau}: overlay={overlay:.8f} differs from expected={expected:.8f}"
            )

    if violations:
        rows_preview = "\n".join(
            f"  tau={r['tau']:4d}  midpoint={r['midpoint']:.8f}  "
            f"model_mid={r['model_midpoint']:.8f}  overlay={r['overlay']:.8f}  "
            f"expected={r['expected']:.8f}"
            for r in eligible[:8]
        )
        report = (
            f"\nTruth-degeneracy invariant violated on {_GRAPH} / {_EDGE_NAME}\n"
            f"{rows_preview}\n\nViolations (first 12):\n  "
            + "\n  ".join(violations[:12])
        )
        pytest.fail(report)
