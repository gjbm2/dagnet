"""cohort_maturity no-evidence model-curve analytic-median canary.

Companion to ``test_cohort_maturity_no_evidence_truth.py`` covering both
window and cohort temporal modes (the truth file fixes the window-mode
boundary; this one exercises the cohort path on the same single edge).

For each row in the bulk-CDF region, the chart's per-family medians
must track the closed-form analytic anticipation:

    model_curve_midpoint  ≈ Beta_median(α, β)        × CDF(τ)
    model_midpoint        ≈ Beta_median(α_pred, β_pred) × CDF(τ)

Beta_median is ``scipy.stats.beta.ppf(0.5, ·, ·)`` (closed form via
inverse CDF). CDF is the shifted lognormal at the prior's mean params.
No MC is invoked by the oracle.

Multi-hop variants are intentionally out of scope — composing the
analytic median across multiple edges is not a closed-form expression
and warrants a separate, composition-aware oracle.

Replaces ``graph-ops/scripts/cohort-maturity-no-evidence-test.sh``.
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

from conftest import (
    requires_data_repo,
    requires_db,
    _ensure_synth_ready,
    _ensure_bayes_sidecar_for_asat,
)
from _daemon_client import DaemonError, get_default_client


_REPO_ROOT = Path(__file__).resolve().parents[3]
_ANALYSE_SH = _REPO_ROOT / "graph-ops" / "scripts" / "analyse.sh"

_PYTHON_BE_URL = os.environ.get("PYTHON_API_URL", "http://localhost:9000")

_GRAPH = "synth-mirror-4step"
_EDGE_NAME = "m4-delegated-to-registered"
_WINDOW = "31-Jan-26:15-Mar-26"
_ASAT = "1-Feb-26"

# Same tolerances and bulk-CDF guard as the truth-degeneracy companion
# test. The first-order analytic identity ``median(p × CDF) ≈
# Beta_median × CDF`` is sharp where CDF dispersion is small (epistemic
# basis). Predictive uses a 4×-larger ``mu_sd_pred`` and carries a
# bounded ~2-3% second-order correction the predictive tolerance
# accommodates.
_REL_TOL_EPI = 0.015
_REL_TOL_PRED = 0.04
_ABS_TOL = 5e-5
_BULK_CDF_LO = 0.30
_BULK_CDF_HI = 0.95
_MIN_INFORMATIVE_ROWS = 5

# Single-hop only — multi-hop median composition is not a closed-form
# anticipation and lives in a separate test design.
_CASES: list[tuple[str, str]] = [
    ("window_single_hop", f"from(m4-delegated).to(m4-registered).window({_WINDOW}).asat({_ASAT})"),
    ("cohort_single_hop", f"from(m4-delegated).to(m4-registered).cohort({_WINDOW}).asat({_ASAT})"),
]


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
            "--display", '{"show_model_curve":true}',
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
        "--type", "cohort_maturity", "--no-cache", "--no-snapshot-cache",
        "--format", "json",
        "--bayes-vars", str(sidecar),
        "--display", '{"show_model_curve":true}',
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


def _beta_median(alpha: float, beta: float) -> float:
    from scipy.stats import beta as _beta_dist
    return float(_beta_dist.ppf(0.5, alpha, beta))


def _read_sidecar_prior(sidecar_path: Path, edge_param_id: str) -> dict[str, float]:
    sc = json.loads(sidecar_path.read_text())
    edges = sc.get("webhook_payload_edges") or []
    edge = next(
        (e for e in edges if e.get("param_id") == edge_param_id),
        None,
    )
    if edge is None:
        pytest.fail(f"sidecar missing edge {edge_param_id!r}")
    slc = (edge.get("slices") or {}).get("window()") or {}
    required = (
        "alpha", "beta", "alpha_pred", "beta_pred",
        "mu_mean", "sigma_mean", "onset_mean",
    )
    missing = [k for k in required if slc.get(k) is None]
    if missing:
        pytest.fail(f"sidecar slice missing fields for {edge_param_id}: {missing}")
    return {k: float(slc[k]) for k in required}


@requires_db
@requires_data_repo
@requires_python_be
@pytest.mark.parametrize(
    "case_name,dsl",
    _CASES,
    ids=[c[0] for c in _CASES],
)
def test_cohort_maturity_no_evidence_collapse(case_name: str, dsl: str) -> None:
    """Per-family chart medians must track Beta_median × CDF analytic
    anticipation in the bulk-CDF window for window and cohort modes."""
    _ensure_synth_ready(_GRAPH, enriched=True, bayesian=True, check_fe_parity=False)

    sidecar_str = _ensure_bayes_sidecar_for_asat(_GRAPH, as_at=_ASAT)
    if sidecar_str is None:
        pytest.skip(f"[{case_name}] Bayes sidecar unavailable for {_GRAPH}")
    sidecar_path = Path(sidecar_str)

    prior = _read_sidecar_prior(sidecar_path, _EDGE_NAME)
    alpha, beta = prior["alpha"], prior["beta"]
    alpha_pred, beta_pred = prior["alpha_pred"], prior["beta_pred"]
    mu, sigma, onset = prior["mu_mean"], prior["sigma_mean"], prior["onset_mean"]
    epi_p_median = _beta_median(alpha, beta)
    pred_p_median = _beta_median(alpha_pred, beta_pred)

    payload = _run_analyse_with_sidecar(_GRAPH, dsl, sidecar_path)
    result_block = payload.get("result") or {}

    rows = result_block.get("data") or []
    if not rows:
        pytest.fail(f"[{case_name}] result.data is empty")

    eligible: list[dict[str, Any]] = []
    for row in rows:
        tau = row.get("tau_days")
        model_midpoint = row.get("model_midpoint")
        overlay = row.get("model_curve_midpoint")
        if tau is None or model_midpoint is None or overlay is None:
            continue
        tau_i = int(tau)
        cdf_tau = _shifted_lognormal_cdf(tau_i, onset=onset, mu=mu, sigma=sigma)
        if not (_BULK_CDF_LO <= cdf_tau <= _BULK_CDF_HI):
            continue
        eligible.append({
            "tau": tau_i,
            "model_midpoint": float(model_midpoint),
            "overlay": float(overlay),
            "oracle_epi": epi_p_median * cdf_tau,
            "oracle_pred": pred_p_median * cdf_tau,
            "cdf": cdf_tau,
        })

    if len(eligible) < _MIN_INFORMATIVE_ROWS:
        pytest.fail(
            f"[{case_name}] only {len(eligible)} bulk-CDF rows found in "
            f"[{_BULK_CDF_LO:.2f}, {_BULK_CDF_HI:.2f}] "
            f"(need ≥ {_MIN_INFORMATIVE_ROWS})"
        )

    def _drift(actual: float, oracle: float) -> tuple[float, float]:
        abs_d = abs(actual - oracle)
        denom = max(abs(oracle), _ABS_TOL)
        return abs_d, abs_d / denom

    violations: list[str] = []
    for r in eligible:
        tau = r["tau"]
        epi_abs, epi_rel = _drift(r["overlay"], r["oracle_epi"])
        pred_abs, pred_rel = _drift(r["model_midpoint"], r["oracle_pred"])
        if epi_abs > _ABS_TOL and epi_rel > _REL_TOL_EPI:
            violations.append(
                f"tau={tau}: overlay={r['overlay']:.8f} drift "
                f"vs Beta_median(α, β)·CDF={r['oracle_epi']:.8f} "
                f"({epi_rel*100:.2f}% rel; tol {_REL_TOL_EPI*100:.1f}%)"
            )
        if pred_abs > _ABS_TOL and pred_rel > _REL_TOL_PRED:
            violations.append(
                f"tau={tau}: model_midpoint={r['model_midpoint']:.8f} drift "
                f"vs Beta_median(α_pred, β_pred)·CDF={r['oracle_pred']:.8f} "
                f"({pred_rel*100:.2f}% rel; tol {_REL_TOL_PRED*100:.1f}%)"
            )

    if violations:
        rows_preview = "\n".join(
            f"  tau={r['tau']:4d}  cdf={r['cdf']:.4f}  "
            f"overlay={r['overlay']:.8f}  oracle_epi={r['oracle_epi']:.8f}  "
            f"model_mid={r['model_midpoint']:.8f}  oracle_pred={r['oracle_pred']:.8f}"
            for r in eligible[:8]
        )
        report = (
            f"\n[{case_name}] analytic-median canary violated:\n"
            f"  Beta_median(epi)  = {epi_p_median:.6f}  "
            f"(α={alpha:.3f}, β={beta:.3f})\n"
            f"  Beta_median(pred) = {pred_p_median:.6f}  "
            f"(α_pred={alpha_pred:.3f}, β_pred={beta_pred:.3f})\n"
            f"  CDF prior params  μ={mu:.4f}  σ={sigma:.4f}  onset={onset:.4f}\n"
            f"{rows_preview}\n\nViolations (first 10):\n  "
            + "\n  ".join(violations[:10])
        )
        pytest.fail(report)
