"""cohort_maturity main-midline == promoted-overlay contract test.

Invariant: in f-view the main chart's ``model_midpoint`` (unconditioned
sweep midline, ``p × CDF_path(τ)`` with no evidence conditioning) must
equal the promoted source's ``model_curve`` overlay at every τ. Bands
differ legitimately (main fan = predictive via alpha_pred + latency
dispersions; overlay bands = epistemic) but midlines must match.

Three checks per case:

    1. Per-source curves' peaks must approach their own
       ``forecast_mean`` (within 10%). If a source curve peaks below
       10% of its forecast_mean, a p-scaling bug is silently
       suppressing the rate.
    2. Promoted overlay must stay within its own
       ``bayesBandLower`` / ``bayesBandUpper`` envelope at every
       sampled τ.
    3. Sampled-τ midline must match overlay within 0.1% relative
       (with a 1e-6 absolute floor for near-zero rates).

Replaces ``graph-ops/scripts/cohort-maturity-model-parity-test.sh``.
The bash file is preserved as a thin shim that delegates here.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Optional

import pytest

from conftest import requires_data_repo, requires_db, _ensure_synth_ready
from _daemon_client import DaemonError, get_default_client


_REPO_ROOT = Path(__file__).resolve().parents[3]
_ANALYSE_SH = _REPO_ROOT / "graph-ops" / "scripts" / "analyse.sh"

_PYTHON_BE_URL = os.environ.get("PYTHON_API_URL", "http://localhost:9000")

_GRAPH = "synth-mirror-4step"

# Per cohort-maturity-model-parity-test.sh lines 59-61.
_EPS_REL = 0.001  # 0.1% relative drift acceptable
_EPS_ABS = 1e-6   # absolute floor for near-zero rates
_PEAK_FRACTION = 0.10  # source curve peak must reach ≥10% of its forecast_mean

# Same case matrix as the bash original (lines 258-276).
_CASES: list[tuple[str, str]] = [
    ("window_single_hop", "from(m4-delegated).to(m4-registered).window(-90d:)"),
    ("cohort_single_hop_widened", "from(m4-delegated).to(m4-registered).cohort(-90d:)"),
    ("cohort_multi_hop", "from(m4-created).to(m4-success).cohort(-90d:)"),
    ("window_multi_hop", "from(m4-created).to(m4-success).window(-90d:)"),
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


def _run_analyse(graph: str, dsl: str) -> dict[str, Any]:
    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        args = [
            "--graph", _DATA_REPO_PATH,
            "--name", graph,
            "--query", dsl,
            "--type", "cohort_maturity",
            "--no-snapshot-cache",
            "--format", "json",
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
        "--type", "cohort_maturity", "--no-snapshot-cache", "--format", "json",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(_REPO_ROOT), timeout=300)
    if result.returncode != 0:
        raise AssertionError(f"analyse.sh exit {result.returncode}\nstderr:\n{result.stderr[-2000:]}")
    idx = result.stdout.find("{")
    return json.loads(result.stdout[idx:])


def _build_tau_map(curve: list[dict[str, Any]]) -> dict[int, float]:
    out: dict[int, float] = {}
    for c in curve:
        tau = c.get("tau_days")
        rate = c.get("model_rate")
        if tau is not None and rate is not None:
            out[int(tau)] = float(rate)
    return out


@requires_db
@requires_data_repo
@requires_python_be
@pytest.mark.parametrize(
    "case_name,dsl",
    _CASES,
    ids=[c[0] for c in _CASES],
)
def test_main_midline_matches_promoted_overlay(case_name: str, dsl: str) -> None:
    """main.model_midpoint[τ] == overlay.model_rate[τ] at every sampled τ."""
    _ensure_synth_ready(_GRAPH, enriched=True, bayesian=False, check_fe_parity=False)

    payload = _run_analyse(_GRAPH, dsl)
    result_block = payload.get("result") or payload

    metadata = result_block.get("metadata") or {}
    model_curves = metadata.get("model_curves") or {}
    if not model_curves:
        pytest.fail(f"[{case_name}] no model_curves in metadata")
    entry_key = next(iter(model_curves))
    entry = model_curves[entry_key]

    overlay_by_tau = _build_tau_map(entry.get("curve") or [])
    band_upper_by_tau = _build_tau_map(entry.get("bayesBandUpper") or [])
    band_lower_by_tau = _build_tau_map(entry.get("bayesBandLower") or [])
    promoted = entry.get("promotedSource") or metadata.get("promoted_source")

    rows = result_block.get("data") or []
    midline_by_tau: dict[int, Optional[float]] = {}
    for r in rows:
        tau = r.get("tau_days")
        if tau is None:
            continue
        midline_by_tau[int(tau)] = r.get("model_midpoint")

    if not overlay_by_tau:
        pytest.fail(f"[{case_name}] overlay curve empty (promoted={promoted})")
    if not midline_by_tau:
        pytest.fail(f"[{case_name}] main chart has no model_midpoint rows")
    if not band_upper_by_tau or not band_lower_by_tau:
        pytest.fail(f"[{case_name}] promoted overlay band missing")

    # ── Check 1: per-source curves reach a meaningful fraction of forecast_mean ──
    source_curves = entry.get("sourceModelCurves") or {}
    source_curve_issues: list[str] = []
    for src_name, src_entry in source_curves.items():
        src_curve = src_entry.get("curve") or []
        src_params = src_entry.get("params") or {}
        src_fm = src_params.get("forecast_mean")
        if src_fm is None or not src_curve:
            continue
        rates = [c["model_rate"] for c in src_curve if c.get("model_rate") is not None]
        if not rates:
            continue
        peak = max(rates)
        if src_fm > 0 and peak < _PEAK_FRACTION * src_fm:
            source_curve_issues.append(
                f"{src_name}: peak={peak:.6f} but forecast_mean={src_fm:.6f} "
                f"(<{int(_PEAK_FRACTION*100)}% of expected asymptote — likely p-scaling bug)"
            )

    # ── Sample taus across the curve for the midline/overlay/band checks ──
    common_taus = sorted(set(overlay_by_tau) & set(midline_by_tau))
    if not common_taus:
        pytest.fail(f"[{case_name}] no common τ between overlay and midline")
    tau_max = max(common_taus)
    sample_candidates = [1, 5, 10, 15, 20, 25, 30, tau_max // 2, tau_max - 1]
    sample_taus = sorted(set(t for t in sample_candidates if t in overlay_by_tau and t in midline_by_tau))
    if not sample_taus:
        sample_taus = common_taus[: min(10, len(common_taus))]

    table_lines = [
        f"  promoted source: {promoted}",
        f"  τ in [{min(common_taus)}, {tau_max}], sampling {len(sample_taus)} points",
        f"  {'τ':>4}  {'overlay':>10}  {'midline':>10}  {'abs_diff':>10}  {'rel_diff':>8}",
    ]
    midline_failures: list[tuple[int, float, float, float]] = []
    band_failures: list[tuple[int, Optional[float], float, Optional[float]]] = []
    worst_tau: Optional[int] = None
    worst_rel = 0.0

    for t in sample_taus:
        overlay = overlay_by_tau[t]
        midline = midline_by_tau.get(t)
        if midline is None:
            continue
        midline_f = float(midline)
        abs_diff = abs(midline_f - overlay)
        denom = max(abs(overlay), abs(midline_f), _EPS_ABS)
        rel_diff = abs_diff / denom
        marker = " "
        if abs_diff > _EPS_ABS and rel_diff > _EPS_REL:
            marker = "!"
            midline_failures.append((t, overlay, midline_f, rel_diff))
        if rel_diff > worst_rel:
            worst_rel = rel_diff
            worst_tau = t

        bu = band_upper_by_tau.get(t)
        bl = band_lower_by_tau.get(t)
        if bu is None or bl is None or not (bl <= overlay <= bu):
            band_failures.append((t, bl, overlay, bu))

        table_lines.append(
            f" {marker}{t:>4}  {overlay:>10.6f}  {midline_f:>10.6f}  "
            f"{abs_diff:>10.6f}  {rel_diff*100:>7.2f}%"
        )

    failures: list[str] = []
    if source_curve_issues:
        failures.append("per-source scaling issues:")
        failures.extend(f"  {issue}" for issue in source_curve_issues)
    if band_failures:
        failures.append("promoted overlay left its own band:")
        for t, bl, o, bu in band_failures[:5]:
            failures.append(f"  τ={t}: band=[{bl}, {bu}] overlay={o}")
    if midline_failures:
        failures.append(
            f"midline differs from overlay at {len(midline_failures)} τ "
            f"(worst: τ={worst_tau}, rel={worst_rel*100:.2f}%) — "
            "overlay path CDF diverges from main chart sweep."
        )

    if failures:
        report = (
            f"\n[{case_name}] cohort_maturity model parity violated\n"
            + "\n".join(table_lines)
            + "\n\n"
            + "\n".join(failures)
        )
        pytest.fail(report)
