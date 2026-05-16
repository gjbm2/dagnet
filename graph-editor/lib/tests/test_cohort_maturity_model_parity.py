"""cohort_maturity model-curve analytic-median + band-membership canary.

Per-family chart medians must track the closed-form analytic median of
their own prior:

    model_curve_midpoint  ≈ Beta_median(α, β)        × CDF(τ)   (epistemic)
    model_midpoint        ≈ Beta_median(α_pred, β_pred) × CDF(τ) (predictive)

Beta_median is the inverse Beta CDF at 0.5.
``CDF`` is the shifted lognormal at the prior's mean params. The
oracle invokes no Monte Carlo. Each chart median is checked against
its own family's analytic anticipation, not the other family's —
predictive and epistemic medians legitimately differ for skewed
priors and a cross-family parity check is structurally meaningless
under the new median-based midline contract.

Three checks per case:

    1. Promoted overlay's peak must reach a meaningful fraction of
       its ``forecast_mean`` (≥10%). Catches p-scaling bugs that
       silently suppress the rate.
    2. Promoted overlay must stay within its own
       ``model_curve_fan_lower`` / ``model_curve_fan_upper`` envelope.
    3. ``model_midpoint`` and ``model_curve_midpoint`` each track
       their own per-family analytic-median oracle in the bulk-CDF
       region.

Multi-hop variants are intentionally out of scope — composing the
analytic median across multiple edges is not a closed-form expression
and warrants a separate, composition-aware oracle.

Replaces ``graph-ops/scripts/cohort-maturity-model-parity-test.sh``.
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

# Analytic-median oracle tolerance. Mirror of the truth-degeneracy
# companion — sharp on the epistemic side; predictive carries a
# bounded second-order CDF-dispersion correction (mu_sd_pred ~ 4×
# the epistemic mu_sd in the synth fixture).
_REL_TOL_EPI = 0.015
_REL_TOL_PRED = 0.04
_ABS_TOL = 5e-5
_BULK_CDF_LO = 0.30
_BULK_CDF_HI = 0.95
_PEAK_FRACTION = 0.10  # overlay peak must reach ≥10% of its forecast_mean

# Single-hop only — multi-hop median composition is not a closed-form
# anticipation and lives in a separate test design.
_CASES: list[tuple[str, str]] = [
    ("window_single_hop", f"from(m4-delegated).to(m4-registered).window({_WINDOW}).asat({_ASAT})"),
    ("cohort_single_hop_widened", f"from(m4-delegated).to(m4-registered).cohort({_WINDOW}).asat({_ASAT})"),
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
    from runner.numpy_stats import beta_ppf
    return float(beta_ppf(0.5, alpha, beta))


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
def test_main_midline_matches_promoted_overlay(case_name: str, dsl: str) -> None:
    """Per-family chart medians track Beta_median × CDF analytic
    anticipation; overlay stays within its own bands; peak reaches
    a meaningful fraction of forecast_mean."""
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
    result_block = payload.get("result") or payload

    metadata = result_block.get("metadata") or {}
    promoted = result_block.get("promoted_source") or metadata.get("promoted_source")

    rows = result_block.get("data") or []
    overlay_by_tau: dict[int, float] = {}
    midline_by_tau: dict[int, Optional[float]] = {}
    band_upper_by_tau: dict[int, float] = {}
    band_lower_by_tau: dict[int, float] = {}
    forecast_mean: Optional[float] = None
    for r in rows:
        tau = r.get("tau_days")
        if tau is None:
            continue
        tau_i = int(tau)
        midline_by_tau[tau_i] = r.get("model_midpoint")
        oc = r.get("model_curve_midpoint")
        if oc is not None:
            overlay_by_tau[tau_i] = float(oc)
        bu = r.get("model_curve_fan_upper")
        bl = r.get("model_curve_fan_lower")
        if bu is not None:
            band_upper_by_tau[tau_i] = float(bu)
        if bl is not None:
            band_lower_by_tau[tau_i] = float(bl)
        if forecast_mean is None:
            pim = r.get("p_infinity_mean")
            if pim is not None:
                forecast_mean = float(pim)

    if not overlay_by_tau:
        pytest.fail(f"[{case_name}] overlay curve empty (promoted={promoted})")
    if not midline_by_tau:
        pytest.fail(f"[{case_name}] main chart has no model_midpoint rows")
    if not band_upper_by_tau or not band_lower_by_tau:
        pytest.fail(f"[{case_name}] promoted overlay band missing")

    # ── Check 1: overlay peak reaches a meaningful fraction of forecast_mean ──
    source_curve_issues: list[str] = []
    if forecast_mean is not None and forecast_mean > 0:
        peak = max(overlay_by_tau.values())
        if peak < _PEAK_FRACTION * forecast_mean:
            source_curve_issues.append(
                f"{promoted}: peak={peak:.6f} but forecast_mean={forecast_mean:.6f} "
                f"(<{int(_PEAK_FRACTION*100)}% of expected asymptote — likely p-scaling bug)"
            )

    # ── Sample taus in the bulk-CDF region for the analytic-oracle check ──
    common_taus = sorted(set(overlay_by_tau) & set(midline_by_tau))
    bulk_taus: list[int] = []
    for t in common_taus:
        cdf_t = _shifted_lognormal_cdf(t, onset=onset, mu=mu, sigma=sigma)
        if _BULK_CDF_LO <= cdf_t <= _BULK_CDF_HI:
            bulk_taus.append(t)
    if not bulk_taus:
        pytest.fail(
            f"[{case_name}] no τ in bulk-CDF window "
            f"[{_BULK_CDF_LO:.2f}, {_BULK_CDF_HI:.2f}]"
        )

    table_lines = [
        f"  promoted source: {promoted}",
        f"  Beta_median(epi)  = {epi_p_median:.6f}  (α={alpha:.3f}, β={beta:.3f})",
        f"  Beta_median(pred) = {pred_p_median:.6f}  "
        f"(α_pred={alpha_pred:.3f}, β_pred={beta_pred:.3f})",
        f"  CDF prior params  μ={mu:.4f}  σ={sigma:.4f}  onset={onset:.4f}",
        f"  τ in [{min(common_taus)}, {max(common_taus)}]; "
        f"sampling {len(bulk_taus)} bulk points",
        f"  {'τ':>4}  {'overlay':>10}  {'oracle_e':>10}  "
        f"{'midline':>10}  {'oracle_p':>10}",
    ]
    epi_failures: list[tuple[int, float, float, float]] = []
    pred_failures: list[tuple[int, float, float, float]] = []
    band_failures: list[tuple[int, Optional[float], float, Optional[float]]] = []

    for t in bulk_taus:
        overlay = overlay_by_tau[t]
        midline = midline_by_tau.get(t)
        midline_f = float(midline) if midline is not None else None
        cdf_t = _shifted_lognormal_cdf(t, onset=onset, mu=mu, sigma=sigma)
        oracle_epi = epi_p_median * cdf_t
        oracle_pred = pred_p_median * cdf_t

        epi_abs = abs(overlay - oracle_epi)
        epi_rel = epi_abs / max(abs(oracle_epi), _ABS_TOL)
        if epi_abs > _ABS_TOL and epi_rel > _REL_TOL_EPI:
            epi_failures.append((t, overlay, oracle_epi, epi_rel))

        if midline_f is not None:
            pred_abs = abs(midline_f - oracle_pred)
            pred_rel = pred_abs / max(abs(oracle_pred), _ABS_TOL)
            if pred_abs > _ABS_TOL and pred_rel > _REL_TOL_PRED:
                pred_failures.append((t, midline_f, oracle_pred, pred_rel))

        bu = band_upper_by_tau.get(t)
        bl = band_lower_by_tau.get(t)
        if bu is None or bl is None or not (bl <= overlay <= bu):
            band_failures.append((t, bl, overlay, bu))

        table_lines.append(
            f"  {t:>4}  {overlay:>10.6f}  {oracle_epi:>10.6f}  "
            f"{(midline_f if midline_f is not None else 0):>10.6f}  "
            f"{oracle_pred:>10.6f}"
        )

    failures: list[str] = []
    if source_curve_issues:
        failures.append("per-source scaling issues:")
        failures.extend(f"  {issue}" for issue in source_curve_issues)
    if band_failures:
        failures.append("promoted overlay left its own band:")
        for t, bl, o, bu in band_failures[:5]:
            failures.append(f"  τ={t}: band=[{bl}, {bu}] overlay={o}")
    if epi_failures:
        failures.append(
            f"epistemic overlay drift vs Beta_median(α, β)·CDF "
            f"at {len(epi_failures)} τ (tol {_REL_TOL_EPI*100:.1f}% rel):"
        )
        for t, ov, orc, rel in epi_failures[:5]:
            failures.append(
                f"  τ={t}: overlay={ov:.6f} oracle={orc:.6f} ({rel*100:.2f}% rel)"
            )
    if pred_failures:
        failures.append(
            f"predictive midline drift vs Beta_median(α_pred, β_pred)·CDF "
            f"at {len(pred_failures)} τ (tol {_REL_TOL_PRED*100:.1f}% rel):"
        )
        for t, mid, orc, rel in pred_failures[:5]:
            failures.append(
                f"  τ={t}: midline={mid:.6f} oracle={orc:.6f} ({rel*100:.2f}% rel)"
            )

    if failures:
        report = (
            f"\n[{case_name}] cohort_maturity model-curve canary violated\n"
            + "\n".join(table_lines)
            + "\n\n"
            + "\n".join(failures)
        )
        pytest.fail(report)
