"""Outside-in acceptance suite for factorised cohort semantics.

Single owner for public CLI (`graph-ops/scripts/analyse.sh` and
`graph-ops/scripts/param-pack.sh`) assertions around `cohort(A, X-end)`
behaviour. These tests intentionally stay at the user-visible boundary:

- `param-pack` edge scalars for parity against analysis projections
- `cohort_maturity` rows for trajectory and shape contracts
- `conditioned_forecast` edge scalars only where evidence-admission provenance
  is observable through public diagnostics / `evidence_k` / `evidence_n`

Fixture/provenance spike status (26-Apr-26):
- usable: `synth-simple-abc`, `synth-lat4`, `synth-fanout-test`,
  `cf-fix-deep-mixed`, `cf-fix-linear-no-lag`
- deferred in this suite: explicit multi-hop cohort-frame admission denial for
  non-single-hop subjects (no unambiguous public provenance field yet)
"""

from __future__ import annotations

import copy
import functools
import json
import math
import os
import subprocess
from pathlib import Path
from typing import Any, Optional

import pytest
import yaml

from conftest import requires_data_repo, requires_db, requires_synth
from _daemon_client import DaemonError, get_default_client


_REPO_ROOT = Path(__file__).resolve().parents[3]
_ANALYSE_SH = _REPO_ROOT / "graph-ops" / "scripts" / "analyse.sh"
_PARAM_PACK_SH = _REPO_ROOT / "graph-ops" / "scripts" / "param-pack.sh"
_TRUTH_DIR = _REPO_ROOT / "bayes" / "truth"


def _resolve_data_repo_path() -> Optional[str]:
    """Resolve the data repo path for daemon-mode CLI calls.

    The shell scripts read this from `.private-repos.conf` automatically;
    the daemon takes it as an explicit `--graph` arg, so we resolve it
    here once.
    """
    conf = _REPO_ROOT / ".private-repos.conf"
    if not conf.exists():
        return None
    for line in conf.read_text().splitlines():
        if line.startswith("DATA_REPO_DIR="):
            return str(_REPO_ROOT / line.split("=", 1)[1].strip())
    return None


_DATA_REPO_PATH = _resolve_data_repo_path()

_PYTHON_BE_URL = os.environ.get("PYTHON_API_URL", "http://localhost:9000")

# Tolerance noise floor (re-derived 28-Apr-26 following Fix-A on 73f F14).
#
# Pre-Fix-A the BE engine returned a deterministic spliced ``Σy/Σx`` at the
# asymptote; cross-surface and cross-mode comparisons were bit-equal modulo
# accumulation order, so 1e-4 / 1e-9 floors were achievable. Fix-A made the
# public ``p_infinity_mean`` read ``np.median(p_draws)`` from the IS-conditioned
# trajectory, and Fix-1 made the per-cohort completeness an MC-derived
# n-weighted CDF mean over the resampled draws. Both are now stochastic
# functions of the IS evidence vector, even though ``rng = default_rng(42)``
# fixes the seed. Cross-path differences in the evidence vector (different
# cohort partitions, reach-scaled per-cohort ``(n_i, k_i)``, different
# ``theta_transformed`` build placement) propagate through the IS resample to
# the public scalar.
#
# Additional approximation sources where the path goes through forward
# convolution: ``np.convolve(arrival_increments, edge_cdf)`` for Pop C in
# ``_evaluate_cohort`` and ``_convolve_completeness_at_age`` in the carrier
# cache. These accumulate floating-point error proportional to the number of
# convolved entries (typical 90-day cohort: ~1e-5 per per-cell, summing into
# the ~1e-4 range on the projected trajectory). Cross-mode and cross-anchor
# comparisons go through the convolution at most once each, so the
# convolution drift is bounded by ~1e-4 in practice.
#
# Realistic floors:
#   - p_mean / p_infinity_mean: ~1e-3 (post-IS posterior-mean noise floor on
#     S=2000 draws + cross-path drift + FW convolution drift; smaller deltas
#     can't be cleanly separated from numerical drift between equivalent
#     paths).
#   - completeness: ~1e-4 (n-weighted CDF mean over IS-reindexed draws; the
#     reindex step alone can shift the mean by ~1e-5–1e-4 even when the
#     underlying ``cdf_arr`` cells are bit-identical, and convolved-carrier
#     paths add a further ~1e-5 to 1e-4 of accumulation drift).
#
# These constants govern the cross-surface (pack vs CF vs cohort_maturity)
# parity assertions for the same query. Cross-mode and cross-anchor
# invariance assertions use their own per-call-site tolerances (typically
# 1e-3 to 5e-3, see inline comments).
_P_MEAN_ABS_TOL = 1e-3
_COMPLETENESS_ABS_TOL = 1e-4


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


def _parse_json_stdout(
    *,
    stdout: str,
    command_name: str,
    graph_name: str,
    dsl: str,
) -> dict[str, Any]:
    if not stdout.startswith("{"):
        idx = stdout.find("{")
        if idx < 0:
            raise AssertionError(
                f"no JSON in {command_name} stdout for {graph_name} / {dsl!r}\n"
                f"stdout head:\n{stdout[:500]}"
            )
        stdout = stdout[idx:]

    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(
            f"failed to parse {command_name} JSON for {graph_name} / {dsl!r}: {exc}\n"
            f"stdout head:\n{stdout[:500]}"
        )

    assert isinstance(payload, dict), (
        f"expected object JSON from {command_name} for {graph_name} / {dsl!r}, "
        f"got {type(payload).__name__}"
    )
    return payload


@functools.lru_cache(maxsize=None)
def _run_analyse_cached(
    graph_name: str,
    dsl: str,
    *,
    analysis_type: str = "cohort_maturity",
    sidecar_path: Optional[str] = None,
    diagnostic: bool = False,
) -> dict[str, Any]:
    # Daemon path (default): single long-lived dagnet-cli process serves
    # all requests, amortising Node + tsx + module-graph startup over the
    # session. Falls back to per-call subprocess when DAGNET_USE_DAEMON=0.
    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        args = [
            "--graph", _DATA_REPO_PATH,
            "--name", graph_name,
            "--query", dsl,
            "--type", analysis_type,
            "--no-cache", "--no-snapshot-cache",
            "--format", "json",
        ]
        if diagnostic:
            args.append("--diag")
        if sidecar_path is not None:
            sidecar = Path(sidecar_path)
            assert sidecar.exists(), f"sidecar missing: {sidecar}"
            args += ["--bayes-vars", str(sidecar)]
        try:
            return client.call_json("analyse", args)
        except DaemonError as exc:
            raise AssertionError(
                f"daemon analyse failed for {graph_name} / {dsl!r} "
                f"(exit {exc.exit_code}): {exc}\n"
                f"stderr:\n{exc.stderr[-2000:]}"
            )

    cmd = [
        "bash",
        str(_ANALYSE_SH),
        graph_name,
        dsl,
        "--type",
        analysis_type,
        "--no-cache",
        "--no-snapshot-cache",
        "--format",
        "json",
    ]
    if diagnostic:
        cmd.append("--diag")
    if sidecar_path is not None:
        sidecar = Path(sidecar_path)
        assert sidecar.exists(), f"sidecar missing: {sidecar}"
        cmd += ["--bayes-vars", str(sidecar)]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=str(_REPO_ROOT),
        timeout=300,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"analyse.sh exited {result.returncode} for {graph_name} / {dsl!r}\n"
            f"stderr:\n{result.stderr[-2000:]}"
        )

    return _parse_json_stdout(
        stdout=result.stdout,
        command_name="analyse.sh",
        graph_name=graph_name,
        dsl=dsl,
    )


def _run_analyse_v3(
    graph_name: str,
    dsl: str,
    *,
    analysis_type: str = "cohort_maturity",
    sidecar: Optional[Path] = None,
    diagnostic: bool = False,
) -> dict[str, Any]:
    return copy.deepcopy(
        _run_analyse_cached(
            graph_name,
            dsl,
            analysis_type=analysis_type,
            sidecar_path=str(sidecar) if sidecar is not None else None,
            diagnostic=diagnostic,
        )
    )


@functools.lru_cache(maxsize=None)
def _run_param_pack_cached(
    graph_name: str,
    dsl: str,
    *,
    sidecar_path: Optional[str] = None,
    no_be: bool = False,
) -> dict[str, Any]:
    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        args = [
            "--graph", _DATA_REPO_PATH,
            "--name", graph_name,
            "--query", dsl,
            "--no-cache", "--format", "json",
        ]
        if no_be:
            args.append("--no-be")
        if sidecar_path is not None:
            sidecar = Path(sidecar_path)
            assert sidecar.exists(), f"sidecar missing: {sidecar}"
            args += ["--bayes-vars", str(sidecar)]
        try:
            return client.call_json("param-pack", args)
        except DaemonError as exc:
            raise AssertionError(
                f"daemon param-pack failed for {graph_name} / {dsl!r} "
                f"(exit {exc.exit_code}): {exc}\n"
                f"stderr:\n{exc.stderr[-2000:]}"
            )

    cmd = [
        "bash",
        str(_PARAM_PACK_SH),
        graph_name,
        dsl,
        "--no-cache",
        "--format",
        "json",
    ]
    if no_be:
        cmd.append("--no-be")
    if sidecar_path is not None:
        sidecar = Path(sidecar_path)
        assert sidecar.exists(), f"sidecar missing: {sidecar}"
        cmd += ["--bayes-vars", str(sidecar)]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=str(_REPO_ROOT),
        timeout=300,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"param-pack.sh exited {result.returncode} for {graph_name} / {dsl!r}\n"
            f"stderr:\n{result.stderr[-2000:]}"
        )

    return _parse_json_stdout(
        stdout=result.stdout,
        command_name="param-pack.sh",
        graph_name=graph_name,
        dsl=dsl,
    )


def _run_param_pack(
    graph_name: str,
    dsl: str,
    *,
    sidecar: Optional[Path] = None,
    no_be: bool = False,
) -> dict[str, Any]:
    return copy.deepcopy(
        _run_param_pack_cached(
            graph_name,
            dsl,
            sidecar_path=str(sidecar) if sidecar is not None else None,
            no_be=no_be,
        )
    )


def _rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    return (payload.get("result") or {}).get("data") or []


def _numeric_curve(
    payload: dict[str, Any],
    *,
    field: str = "model_midpoint",
) -> dict[int, float]:
    out: dict[int, float] = {}
    for row in _rows(payload):
        tau = row.get("tau_days")
        value = row.get(field)
        if isinstance(tau, int) and isinstance(value, (int, float)):
            out[tau] = float(value)
    return out


def _first_row(payload: dict[str, Any]) -> dict[str, Any]:
    rows = _rows(payload)
    assert rows, "analyse returned no rows"
    return rows[0]


def _last_row(payload: dict[str, Any]) -> dict[str, Any]:
    rows = _rows(payload)
    assert rows, "analyse returned no rows"
    return rows[-1]


def _param_pack_edge_scalar(
    payload: dict[str, Any],
    *,
    edge_name: str,
    field: str,
) -> float:
    key = f"e.{edge_name}.{field}"
    value = payload.get(key)
    assert isinstance(value, (int, float)), f"missing numeric param-pack key {key!r}: {value!r}"
    return float(value)


def _common_taus(*curves: dict[int, float]) -> list[int]:
    if not curves:
        return []
    shared = set(curves[0])
    for curve in curves[1:]:
        shared &= set(curve)
    return sorted(shared)


@functools.lru_cache(maxsize=None)
def _load_truth(graph_name: str) -> dict[str, Any]:
    truth_path = _TRUTH_DIR / f"{graph_name}.truth.yaml"
    assert truth_path.exists(), f"missing truth file: {truth_path}"
    return yaml.safe_load(truth_path.read_text()) or {}


def _load_truth_edge_params(
    *,
    graph_name: str,
    edge_name: str,
) -> dict[str, float]:
    truth = _load_truth(graph_name)
    edge = (truth.get("edges") or {}).get(edge_name)
    assert edge is not None, f"missing truth edge {edge_name!r} in {graph_name}"
    return {
        "p": float(edge["p"]),
        "onset": float(edge["onset"]),
        "mu": float(edge["mu"]),
        "sigma": float(edge["sigma"]),
    }


def _shifted_lognormal_cdf(
    tau: int,
    *,
    onset: float,
    mu: float,
    sigma: float,
) -> float:
    model_age = float(tau) - float(onset)
    if sigma <= 0:
        # Degenerate deterministic-lag edge: jump to 1 at onset.
        return 1.0 if model_age >= 0 else 0.0
    if model_age <= 0:
        return 0.0
    z = (math.log(model_age) - float(mu)) / float(sigma)
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def _edge_cdf_series(
    *,
    graph_name: str,
    edge_name: str,
    tau_max: int,
) -> list[float]:
    params = _load_truth_edge_params(graph_name=graph_name, edge_name=edge_name)
    return [
        _shifted_lognormal_cdf(
            tau,
            onset=params["onset"],
            mu=params["mu"],
            sigma=params["sigma"],
        )
        for tau in range(tau_max + 1)
    ]


def _pdf_from_cdf(cdf_values: list[float]) -> list[float]:
    if not cdf_values:
        return []
    out = [cdf_values[0]]
    out.extend(
        max(cdf_values[idx] - cdf_values[idx - 1], 0.0)
        for idx in range(1, len(cdf_values))
    )
    return out


def _convolve_pdfs(left: list[float], right: list[float], *, tau_max: int) -> list[float]:
    out = [0.0] * (tau_max + 1)
    for i, left_val in enumerate(left):
        if left_val == 0.0:
            continue
        for j, right_val in enumerate(right):
            tau = i + j
            if tau > tau_max:
                break
            out[tau] += left_val * right_val
    return out


def _cdf_from_pdf(pdf_values: list[float]) -> list[float]:
    running = 0.0
    out: list[float] = []
    for value in pdf_values:
        running += max(value, 0.0)
        out.append(min(max(running, 0.0), 1.0))
    return out


def _factorised_rate_curve(
    *,
    carrier_cdf: list[float],
    carrier_pdf: list[float],
    subject_cdf: list[float],
    subject_probability: float,
    tau_max: int,
    frontier_ages: tuple[int, ...],
) -> dict[int, float]:
    curve: dict[int, float] = {}
    ages = tuple(max(int(age), 0) for age in frontier_ages) or (0,)
    for tau in range(tau_max + 1):
        total_x = 0.0
        total_y = 0.0
        for age in ages:
            if tau <= age:
                continue
            x_tail = max(carrier_cdf[tau] - carrier_cdf[age], 0.0)
            y_tail = 0.0
            for u in range(age + 1, tau + 1):
                y_tail += carrier_pdf[u] * subject_cdf[tau - u]
            total_x += x_tail
            total_y += subject_probability * y_tail
        curve[tau] = total_y / total_x if total_x > 0 else 0.0
    return curve


def _single_hop_oracle_curve(
    *,
    graph_name: str,
    upstream_edge_name: str,
    target_edge_name: str,
    tau_max: int,
    frontier_ages: tuple[int, ...],
) -> dict[int, float]:
    upstream = _load_truth_edge_params(graph_name=graph_name, edge_name=upstream_edge_name)
    target = _load_truth_edge_params(graph_name=graph_name, edge_name=target_edge_name)
    upstream_cdf = [
        _shifted_lognormal_cdf(
            tau,
            onset=upstream["onset"],
            mu=upstream["mu"],
            sigma=upstream["sigma"],
        )
        for tau in range(tau_max + 1)
    ]
    target_cdf = [
        _shifted_lognormal_cdf(
            tau,
            onset=target["onset"],
            mu=target["mu"],
            sigma=target["sigma"],
        )
        for tau in range(tau_max + 1)
    ]
    return _factorised_rate_curve(
        carrier_cdf=upstream_cdf,
        carrier_pdf=_pdf_from_cdf(upstream_cdf),
        subject_cdf=target_cdf,
        subject_probability=target["p"],
        tau_max=tau_max,
        frontier_ages=frontier_ages,
    )


def _subject_kernel_oracle_curve(
    *,
    graph_name: str,
    edge_name: str,
    tau_max: int,
) -> dict[int, float]:
    params = _load_truth_edge_params(graph_name=graph_name, edge_name=edge_name)
    cdf = [
        _shifted_lognormal_cdf(
            tau,
            onset=params["onset"],
            mu=params["mu"],
            sigma=params["sigma"],
        )
        for tau in range(tau_max + 1)
    ]
    return {tau: params["p"] * cdf[tau] for tau in range(tau_max + 1)}


def _extract_cf_edge(
    payload: dict[str, Any],
    *,
    from_node: str,
    to_node: str,
) -> dict[str, Any]:
    scenarios = payload.get("scenarios") or []
    assert scenarios, "conditioned_forecast returned no scenarios"
    edges = scenarios[0].get("edges") or []
    for edge in edges:
        if edge.get("from_node") == from_node and edge.get("to_node") == to_node:
            return edge
    raise AssertionError(f"missing edge {from_node}->{to_node} in conditioned_forecast payload")


def _extract_cf_provenance(
    payload: dict[str, Any],
    *,
    from_node: str,
    to_node: str,
) -> dict[str, Any]:
    diag = payload.get("_diagnostics") or {}
    entries = diag.get("rate_evidence_provenance_by_edge") or []
    assert entries, f"missing CF rate-evidence provenance in diagnostics: {diag!r}"
    for entry in entries:
        if entry.get("from_node") == from_node and entry.get("to_node") == to_node:
            return entry
    raise AssertionError(
        f"missing CF provenance for edge {from_node}->{to_node}: {entries!r}"
    )


def _extract_cm_provenance(payload: dict[str, Any]) -> dict[str, Any]:
    diag = payload.get("_diagnostics") or {}
    entry = diag.get("rate_evidence_provenance")
    assert isinstance(entry, dict), f"missing cohort_maturity provenance in diagnostics: {diag!r}"
    return entry


def _collect_public_edge_scalars(
    graph_name: str,
    dsl: str,
    *,
    edge_name: str,
    from_node: str,
    to_node: str,
) -> dict[str, Any]:
    param_pack = _run_param_pack(graph_name, dsl)
    cf_payload = _run_analyse_v3(graph_name, dsl, analysis_type="conditioned_forecast")
    cm_payload = _run_analyse_v3(graph_name, dsl)
    cf_edge = _extract_cf_edge(cf_payload, from_node=from_node, to_node=to_node)
    cm_last = _last_row(cm_payload)
    return {
        "param_pack": param_pack,
        "cf_payload": cf_payload,
        "cm_payload": cm_payload,
        "cf_edge": cf_edge,
        "cm_last": cm_last,
        "pack_p_mean": _param_pack_edge_scalar(param_pack, edge_name=edge_name, field="p.mean"),
        "pack_completeness": _param_pack_edge_scalar(
            param_pack,
            edge_name=edge_name,
            field="p.latency.completeness",
        ),
    }


def _assert_public_scalar_parity(
    scalars: dict[str, Any],
    *,
    label: str,
    p_abs_tol: float = _P_MEAN_ABS_TOL,
    completeness_abs_tol: float = _COMPLETENESS_ABS_TOL,
) -> None:
    cf_edge = scalars["cf_edge"]
    cm_last = scalars["cm_last"]

    cf_p_mean = cf_edge.get("p_mean")
    cm_p_mean = cm_last.get("p_infinity_mean")
    cf_completeness = cf_edge.get("completeness")
    cm_completeness = cm_last.get("completeness")

    assert isinstance(cf_p_mean, (int, float)) and isinstance(cm_p_mean, (int, float))
    assert isinstance(cf_completeness, (int, float)) and isinstance(cm_completeness, (int, float))

    pack_p_mean = scalars["pack_p_mean"]
    pack_completeness = scalars["pack_completeness"]

    assert abs(pack_p_mean - float(cf_p_mean)) <= p_abs_tol, (
        f"[{label}] param-pack p.mean != conditioned_forecast p_mean: "
        f"pack={pack_p_mean:.6f} cf={float(cf_p_mean):.6f}"
    )
    assert abs(pack_p_mean - float(cm_p_mean)) <= p_abs_tol, (
        f"[{label}] param-pack p.mean != cohort_maturity last-row p_infinity_mean: "
        f"pack={pack_p_mean:.6f} cm={float(cm_p_mean):.6f}"
    )
    assert abs(pack_completeness - float(cf_completeness)) <= completeness_abs_tol, (
        f"[{label}] param-pack completeness != conditioned_forecast completeness: "
        f"pack={pack_completeness:.6f} cf={float(cf_completeness):.6f}"
    )
    assert abs(pack_completeness - float(cm_completeness)) <= completeness_abs_tol, (
        f"[{label}] param-pack completeness != cohort_maturity last-row completeness: "
        f"pack={pack_completeness:.6f} cm={float(cm_completeness):.6f}"
    )


def _assert_max_abs_diff(
    left: dict[int, float],
    right: dict[int, float],
    *,
    abs_tol: float,
    label: str,
) -> None:
    common = _common_taus(left, right)
    assert common, f"[{label}] no overlapping taus"
    worst_tau = max(common, key=lambda tau: abs(left[tau] - right[tau]))
    max_diff = abs(left[worst_tau] - right[worst_tau])
    assert max_diff <= abs_tol, (
        f"[{label}] max diff {max_diff:.6f} at tau={worst_tau} exceeds {abs_tol:.6f}: "
        f"left={left[worst_tau]:.6f} right={right[worst_tau]:.6f}"
    )


def _assert_not_flat(curve: dict[int, float], *, label: str) -> None:
    assert curve, f"[{label}] empty curve"
    values = list(curve.values())
    assert len(values) >= 5, f"[{label}] too few rows ({len(values)})"
    peak = max(values)
    assert peak > 0.0, f"[{label}] curve is identically zero"
    rel_var = (max(values) - min(values)) / max(abs(peak), 1e-9)
    assert rel_var >= 0.01, f"[{label}] curve is effectively flat (rel_var={rel_var:.2%})"
    assert values[0] <= 0.30 * peak, (
        f"[{label}] expected near-zero start; first={values[0]:.6f} peak={peak:.6f}"
    )


_SIMPLE = "synth-simple-abc"
_SIMPLE_AB = "from(simple-a).to(simple-b)"
_SIMPLE_BC = "from(simple-b).to(simple-c)"
_SIMPLE_AB_EDGE = "simple-a-to-b"

_LAT4 = "synth-lat4"
_LAT4_BC = "from(synth-lat4-b).to(synth-lat4-c)"
_LAT4_CD = "from(synth-lat4-c).to(synth-lat4-d)"
_LAT4_BD = "from(synth-lat4-b).to(synth-lat4-d)"
_LAT4_CD_EDGE = "synth-lat4-c-to-d"
_LAT4_BD_VIRTUAL_EDGE = "synth-lat4-b-to-d"

_FANOUT = "synth-fanout-test"
_FANOUT_FAST = "from(synth-fo-gate).to(synth-fo-fast)"
_FANOUT_SLOW = "from(synth-fo-gate).to(synth-fo-slow)"

_DEEP = "cf-fix-deep-mixed"
_DEEP_EG = "from(cf-fix-deep-e).to(cf-fix-deep-g)"

_NO_LAG = "cf-fix-linear-no-lag"
_NO_LAG_BC = "from(cf-fix-no-lag-b).to(cf-fix-no-lag-c)"
_NO_LAG_BD = "from(cf-fix-no-lag-b).to(cf-fix-no-lag-d)"


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_a_equals_x_identity_collapses_to_window():
    window = _run_analyse_v3(_SIMPLE, f"{_SIMPLE_AB}.window(-90d:)")
    cohort = _run_analyse_v3(_SIMPLE, f"{_SIMPLE_AB}.cohort(-90d:)")

    w_rows = {row["tau_days"]: row for row in _rows(window) if isinstance(row.get("tau_days"), int)}
    c_rows = {row["tau_days"]: row for row in _rows(cohort) if isinstance(row.get("tau_days"), int)}
    shared = sorted(set(w_rows) & set(c_rows))
    assert len(shared) >= 20, f"[{_SIMPLE_AB}] too few shared taus ({len(shared)})"

    for tau in [value for value in shared if value >= 3]:
        w = w_rows[tau]
        c = c_rows[tau]
        for field in ("evidence_x", "evidence_y"):
            wv, cv = w.get(field), c.get(field)
            if not isinstance(wv, (int, float)) or not isinstance(cv, (int, float)):
                continue
            if abs(float(wv)) <= 1e-9:
                assert abs(float(cv) - float(wv)) <= 1e-6, (
                    f"[{_SIMPLE_AB}] {field} diverged at tau={tau}: window={wv} cohort={cv}"
                )
            else:
                rel = abs(float(cv) - float(wv)) / abs(float(wv))
                assert rel <= 0.05, (
                    f"[{_SIMPLE_AB}] {field} diverged at tau={tau}: "
                    f"window={wv} cohort={cv} rel={rel:.2%}"
                )

    # Cross-mode model_midpoint and p_infinity_mean: both paths go through
    # `compute_forecast_trajectory` with IS-reindexed draws and FW
    # convolution; tolerance set at the post-Fix-A noise floor (see header).
    _assert_max_abs_diff(
        _numeric_curve(window),
        _numeric_curve(cohort),
        abs_tol=_P_MEAN_ABS_TOL,
        label=f"{_SIMPLE_AB} model_midpoint",
    )

    w_p = _first_row(window).get("p_infinity_mean")
    c_p = _first_row(cohort).get("p_infinity_mean")
    assert isinstance(w_p, (int, float)) and isinstance(c_p, (int, float))
    assert abs(float(w_p) - float(c_p)) <= _P_MEAN_ABS_TOL, (
        f"[{_SIMPLE_AB}] p_infinity_mean mismatch: window={w_p} cohort={c_p}"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_FANOUT, enriched=True)
@pytest.mark.parametrize("subject_dsl", (_FANOUT_FAST, _FANOUT_SLOW))
def test_single_hop_non_latent_upstream_collapses_to_window(subject_dsl: str):
    window = _run_analyse_v3(_FANOUT, f"{subject_dsl}.window(-90d:)")
    cohort = _run_analyse_v3(_FANOUT, f"{subject_dsl}.cohort(-90d:)")

    window_x = _numeric_curve(window, field="evidence_x")
    cohort_x = _numeric_curve(cohort, field="evidence_x")
    shared_x = _common_taus(window_x, cohort_x)
    assert shared_x, f"[{subject_dsl}] no overlapping evidence_x taus"
    for tau in shared_x:
        baseline = max(abs(window_x[tau]), 1.0)
        rel = abs(window_x[tau] - cohort_x[tau]) / baseline
        assert rel <= 0.03, (
            f"[{subject_dsl}] evidence_x diverged at tau={tau}: "
            f"window={window_x[tau]:.6f} cohort={cohort_x[tau]:.6f} rel={rel:.2%}"
        )
    _assert_max_abs_diff(
        _numeric_curve(window),
        _numeric_curve(cohort),
        abs_tol=_P_MEAN_ABS_TOL,
        label=f"{subject_dsl} model_midpoint",
    )

    w_p = _first_row(window).get("p_infinity_mean")
    c_p = _first_row(cohort).get("p_infinity_mean")
    assert isinstance(w_p, (int, float)) and isinstance(c_p, (int, float))
    assert abs(float(w_p) - float(c_p)) <= _P_MEAN_ABS_TOL


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
def test_single_hop_latent_upstream_lags_window_but_converges_to_same_subject_p():
    window_curve = _numeric_curve(_run_analyse_v3(_LAT4, f"{_LAT4_BC}.window(-1d:)"))
    cohort_curve = _numeric_curve(_run_analyse_v3(_LAT4, f"{_LAT4_BC}.cohort(-1d:)"))

    shared = _common_taus(window_curve, cohort_curve)
    assert len(shared) >= 10, f"[{_LAT4_BC}] too few shared taus ({len(shared)})"

    eps = 0.03
    for tau in shared:
        assert cohort_curve[tau] <= window_curve[tau] + eps, (
            f"[{_LAT4_BC}] cohort above window at tau={tau}: "
            f"cohort={cohort_curve[tau]:.6f} window={window_curve[tau]:.6f}"
        )

    max_diff = max(abs(window_curve[tau] - cohort_curve[tau]) for tau in shared)
    assert max_diff >= 1e-6, f"[{_LAT4_BC}] curves are identical; latent lag should be visible"

    target = 0.5 * max(window_curve.values())
    w_half = next((tau for tau in sorted(window_curve) if window_curve[tau] >= target), None)
    c_half = next((tau for tau in sorted(cohort_curve) if cohort_curve[tau] >= target), None)
    assert w_half is not None, f"[{_LAT4_BC}] window never reaches half-rise target"
    assert c_half is None or c_half > w_half, (
        f"[{_LAT4_BC}] expected cohort half-rise after window: "
        f"window_tau={w_half} cohort_tau={c_half}"
    )

    window_p = _first_row(_run_analyse_v3(_LAT4, f"{_LAT4_BC}.window(-1d:)")).get("p_infinity_mean")
    cohort_p = _first_row(_run_analyse_v3(_LAT4, f"{_LAT4_BC}.cohort(-1d:)")).get("p_infinity_mean")
    assert isinstance(window_p, (int, float)) and isinstance(cohort_p, (int, float))
    assert abs(float(window_p) - float(cohort_p)) <= _P_MEAN_ABS_TOL


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
def test_anchor_depth_monotonicity_for_same_subject():
    window_payload = _run_analyse_v3(_LAT4, f"{_LAT4_CD}.window(-90d:)")
    cohort_identity_payload = _run_analyse_v3(_LAT4, f"{_LAT4_CD}.cohort(synth-lat4-c,-90d:)")
    cohort_near_payload = _run_analyse_v3(_LAT4, f"{_LAT4_CD}.cohort(synth-lat4-b,-90d:)")
    cohort_far_payload = _run_analyse_v3(_LAT4, f"{_LAT4_CD}.cohort(synth-lat4-a,-90d:)")

    x_window = _numeric_curve(window_payload, field="evidence_x")
    x_identity = _numeric_curve(cohort_identity_payload, field="evidence_x")
    x_near = _numeric_curve(cohort_near_payload, field="evidence_x")
    x_far = _numeric_curve(cohort_far_payload, field="evidence_x")

    tau_band = [
        tau
        for tau in range(10, 26)
        if tau in x_window and tau in x_identity and tau in x_near and tau in x_far
    ]
    assert len(tau_band) >= 10, f"[{_LAT4_CD}] insufficient tau overlap for anchor-depth check"

    for tau in tau_band:
        assert x_far[tau] <= x_near[tau] * 1.02 + 1e-6, (
            f"[{_LAT4_CD}] far anchor exceeded near anchor at tau={tau}: "
            f"far={x_far[tau]:.6f} near={x_near[tau]:.6f}"
        )
        assert x_near[tau] <= x_identity[tau] * 1.02 + 1e-6, (
            f"[{_LAT4_CD}] near anchor exceeded identity anchor at tau={tau}: "
            f"near={x_near[tau]:.6f} identity={x_identity[tau]:.6f}"
        )
        assert abs(x_identity[tau] - x_window[tau]) <= max(1.0, 0.01 * x_window[tau]), (
            f"[{_LAT4_CD}] identity anchor diverged from window at tau={tau}: "
            f"identity={x_identity[tau]:.6f} window={x_window[tau]:.6f}"
        )

    m_window = _numeric_curve(window_payload)
    m_near = _numeric_curve(cohort_near_payload)
    m_far = _numeric_curve(cohort_far_payload)
    m_shared = [tau for tau in tau_band if tau in m_window and tau in m_near and tau in m_far]
    assert m_shared, f"[{_LAT4_CD}] no shared midpoint taus for anchor-depth monotonicity"
    for tau in m_shared:
        assert m_far[tau] <= m_near[tau] + 0.03
        assert m_near[tau] <= m_window[tau] + 0.03

    p_values = [
        _first_row(payload).get("p_infinity_mean")
        for payload in (window_payload, cohort_identity_payload, cohort_near_payload, cohort_far_payload)
    ]
    assert all(isinstance(value, (int, float)) for value in p_values)
    # Cross-anchor `p∞` spread: even with seed=42 fixed, different anchors
    # admit different cohorts and reach-scale per-cohort `(n_i, k_i)`
    # differently, so the IS-resampled posterior mean drifts. The 1e-3 floor
    # captures expected drift; deltas above this are the genuine cross-anchor
    # invariance gap (73f class (a)) where evidence construction needs to
    # carry the same effective sufficient statistic regardless of anchor.
    assert max(float(value) for value in p_values) - min(float(value) for value in p_values) <= _P_MEAN_ABS_TOL


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_FANOUT, enriched=True)
def test_same_carrier_shared_across_different_subjects():
    fast_payload = _run_analyse_v3(_FANOUT, f"{_FANOUT_FAST}.cohort(-90d:)")
    slow_payload = _run_analyse_v3(_FANOUT, f"{_FANOUT_SLOW}.cohort(-90d:)")

    x_fast = _numeric_curve(fast_payload, field="evidence_x")
    x_slow = _numeric_curve(slow_payload, field="evidence_x")
    shared = _common_taus(x_fast, x_slow)
    assert shared, "no shared taus between fanout subjects"
    for tau in shared:
        assert abs(x_fast[tau] - x_slow[tau]) <= max(1.0, 0.01 * x_fast[tau]), (
            f"[fanout] shared carrier diverged at tau={tau}: "
            f"fast={x_fast[tau]:.6f} slow={x_slow[tau]:.6f}"
        )

    m_fast = _numeric_curve(fast_payload)
    m_slow = _numeric_curve(slow_payload)
    midpoint_shared = _common_taus(m_fast, m_slow)
    assert midpoint_shared, "no shared midpoint taus between fanout subjects"
    max_diff = max(abs(m_fast[tau] - m_slow[tau]) for tau in midpoint_shared)
    assert max_diff >= 0.05, (
        "different subjects on shared carrier should diverge materially in midpoint shape"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_low_evidence_cohort_matches_factorised_convolution_oracle():
    payload = _run_analyse_v3(
        _SIMPLE,
        f"{_SIMPLE_BC}.cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)",
    )
    midpoint = _numeric_curve(payload, field="midpoint")
    assert midpoint, f"[{_SIMPLE_BC}] no midpoint rows returned"

    expected = _single_hop_oracle_curve(
        graph_name=_SIMPLE,
        upstream_edge_name="simple-a-to-b",
        target_edge_name="simple-b-to-c",
        tau_max=max(midpoint),
        frontier_ages=(0, 1, 2),
    )
    taus = [tau for tau in range(15, 21) if tau in midpoint and tau in expected]
    assert len(taus) >= 5, f"[{_SIMPLE_BC}] insufficient overlap with oracle on stable tau band"

    failures: list[str] = []
    for tau in taus:
        actual = midpoint[tau]
        exp = expected[tau]
        abs_err = abs(actual - exp)
        rel_err = abs_err / max(abs(exp), 1e-9)
        if abs_err > 0.02 and rel_err > 0.35:
            failures.append(
                f"tau={tau}: actual={actual:.6f} expected={exp:.6f} "
                f"|Δ|={abs_err:.6f} rel={rel_err:.1%}"
            )
    assert not failures, (
        f"[{_SIMPLE_BC}] low-evidence curve drifted from factorised oracle:\n"
        + "\n".join(failures[:6])
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_no_evidence_single_hop_matches_unconditioned_fw_convolution_midline():
    payload = _run_analyse_v3(_SIMPLE, f"{_SIMPLE_BC}.cohort(-1d:)")
    model = _numeric_curve(payload)
    assert model, f"[{_SIMPLE_BC}] no model_midpoint rows returned"

    expected = _single_hop_oracle_curve(
        graph_name=_SIMPLE,
        upstream_edge_name="simple-a-to-b",
        target_edge_name="simple-b-to-c",
        tau_max=max(model),
        frontier_ages=(0,),
    )
    taus = [tau for tau in range(15, 26) if tau in model and tau in expected]
    assert len(taus) >= 8, f"[{_SIMPLE_BC}] insufficient stable-band overlap for no-evidence oracle"

    for tau in taus:
        actual = model[tau]
        exp = expected[tau]
        abs_err = abs(actual - exp)
        rel_err = abs_err / max(abs(exp), 1e-9)
        assert abs_err <= 0.01 or rel_err <= 0.15, (
            f"[{_SIMPLE_BC}] no-evidence oracle mismatch at tau={tau}: "
            f"actual={actual:.6f} expected={exp:.6f} "
            f"|Δ|={abs_err:.6f} rel={rel_err:.1%}"
        )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_low_evidence_single_hop_remains_near_unconditioned_oracle():
    payload = _run_analyse_v3(
        _SIMPLE,
        f"{_SIMPLE_BC}.cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)",
    )
    midpoint = _numeric_curve(payload, field="midpoint")
    assert midpoint, f"[{_SIMPLE_BC}] no midpoint rows returned"

    expected = _single_hop_oracle_curve(
        graph_name=_SIMPLE,
        upstream_edge_name="simple-a-to-b",
        target_edge_name="simple-b-to-c",
        tau_max=max(midpoint),
        frontier_ages=(0, 1, 2),
    )
    taus = [tau for tau in range(15, 21) if tau in midpoint and tau in expected]
    assert len(taus) >= 5

    for tau in taus:
        actual = midpoint[tau]
        exp = expected[tau]
        abs_err = abs(actual - exp)
        rel_err = abs_err / max(abs(exp), 1e-9)
        assert abs_err <= 0.02 or rel_err <= 0.30, (
            f"[{_SIMPLE_BC}] low-evidence curve left near-unconditioned neighbourhood at tau={tau}: "
            f"actual={actual:.6f} expected={exp:.6f} "
            f"|Δ|={abs_err:.6f} rel={rel_err:.1%}"
        )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
@requires_synth(_NO_LAG, enriched=True)
def test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel():
    identity_payload = _run_analyse_v3(_SIMPLE, f"{_SIMPLE_AB}.cohort(-1d:)")
    identity_curve = _numeric_curve(identity_payload)
    identity_expected = _subject_kernel_oracle_curve(
        graph_name=_SIMPLE,
        edge_name="simple-a-to-b",
        tau_max=max(identity_curve),
    )
    identity_taus = [tau for tau in range(8, 21) if tau in identity_curve and tau in identity_expected]
    assert identity_taus, f"[{_SIMPLE_AB}] no stable-band overlap for identity reduction"
    for tau in identity_taus:
        actual = identity_curve[tau]
        exp = identity_expected[tau]
        abs_err = abs(actual - exp)
        rel_err = abs_err / max(abs(exp), 1e-9)
        assert abs_err <= 0.04 or rel_err <= 0.25, (
            f"[{_SIMPLE_AB}] identity reduction mismatch at tau={tau}: "
            f"actual={actual:.6f} expected={exp:.6f} "
            f"|Δ|={abs_err:.6f} rel={rel_err:.1%}"
        )

    instant_payload = _run_analyse_v3(_NO_LAG, f"{_NO_LAG_BC}.cohort(-90d:)")
    instant_curve = _numeric_curve(instant_payload)
    p_inf = _first_row(instant_payload).get("p_infinity_mean")
    assert isinstance(p_inf, (int, float))
    assert instant_curve, f"[{_NO_LAG_BC}] no curve rows for instant-carrier reduction"
    # Per-tau model_midpoint vs `p_inf`: with no-lag carrier the subject CDF
    # collapses, so `p × CDF(τ) ≈ p` everywhere — but `p_inf` reads
    # `np.median(p_draws)` from the IS-conditioned set, while the per-tau
    # midpoint reads `np.median(rate_draws[:, τ])`. Both project the same
    # particle-set, but indexing into a fresh array via `rate_draws` versus
    # the resampled `p_draws` introduces a sub-1e-3 residual after IS
    # reweighting. Tolerance at the noise floor.
    for tau, value in instant_curve.items():
        assert abs(value - float(p_inf)) <= _P_MEAN_ABS_TOL, (
            f"[{_NO_LAG_BC}] expected flat subject-kernel reduction at tau={tau}: "
            f"value={value:.6f} p_inf={float(p_inf):.6f}"
        )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_NO_LAG, enriched=True)
def test_multihop_non_latent_upstream_collapse():
    window = _run_analyse_v3(_NO_LAG, f"{_NO_LAG_BD}.window(-90d:)")
    cohort = _run_analyse_v3(_NO_LAG, f"{_NO_LAG_BD}.cohort(-90d:)")

    # evidence_x is observed counts, deterministic given fixture; left at
    # 1e-6 to flag any cohort-partition rounding differences.
    _assert_max_abs_diff(
        _numeric_curve(window, field="evidence_x"),
        _numeric_curve(cohort, field="evidence_x"),
        abs_tol=1e-6,
        label=f"{_NO_LAG_BD} evidence_x",
    )
    # model_midpoint is `np.median(rate_draws[:, τ])` — MC-derived; at the
    # noise floor (see header).
    _assert_max_abs_diff(
        _numeric_curve(window),
        _numeric_curve(cohort),
        abs_tol=_P_MEAN_ABS_TOL,
        label=f"{_NO_LAG_BD} model_midpoint",
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_DEEP, enriched=True)
def test_multihop_latent_upstream_divergence():
    window = _numeric_curve(_run_analyse_v3(_DEEP, f"{_DEEP_EG}.window(-180d:)"), field="evidence_x")
    cohort = _numeric_curve(_run_analyse_v3(_DEEP, f"{_DEEP_EG}.cohort(-180d:)"), field="evidence_x")
    shared = _common_taus(window, cohort)
    assert shared, f"[{_DEEP_EG}] no shared taus"

    divergent = []
    for tau in shared:
        if window[tau] <= 0:
            continue
        rel = abs(cohort[tau] / window[tau] - 1.0)
        if rel > 0.05:
            divergent.append(tau)
    assert len(divergent) >= 5, (
        f"[{_DEEP_EG}] expected many latent-upstream divergences; got {len(divergent)}"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
def test_multihop_subject_span_is_not_last_edge_or_param_pack_scalar():
    param_pack = _run_param_pack(_LAT4, f"{_LAT4_BD}.window(-1d:)")
    assert not any(key.startswith(f"e.{_LAT4_BD_VIRTUAL_EDGE}.") for key in param_pack), (
        f"[{_LAT4_BD}] param-pack must not invent path-level scalars for virtual span "
        f"{_LAT4_BD_VIRTUAL_EDGE}"
    )

    full_span = _numeric_curve(_run_analyse_v3(_LAT4, f"{_LAT4_BD}.window(-1d:)"))
    terminal = _numeric_curve(_run_analyse_v3(_LAT4, f"{_LAT4_CD}.window(-1d:)"))

    shared = _common_taus(full_span, terminal)
    assert len(shared) >= 8, f"[{_LAT4_BD}] insufficient overlap to check last-edge regression"

    tau = 15
    assert tau in full_span and tau in terminal
    assert full_span[tau] < terminal[tau] * 0.7, (
        f"[{_LAT4_BD}] full-span query too close to terminal-edge shape at tau={tau}: "
        f"full_span={full_span[tau]:.6f} terminal={terminal[tau]:.6f}"
    )

    max_diff = max(abs(full_span[t] - terminal[t]) for t in shared)
    assert max_diff >= 0.05, (
        f"[{_LAT4_BD}] expected material full-span vs terminal-edge separation; "
        f"max_diff={max_diff:.6f}"
    )


# ── CLI public parity canaries ──────────────────────────────────────────────

@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_cli_window_single_edge_scalar_identity_across_public_surfaces():
    dsl = f"{_SIMPLE_AB}.window(-90d:)"
    scalars = _collect_public_edge_scalars(
        _SIMPLE,
        dsl,
        edge_name=_SIMPLE_AB_EDGE,
        from_node="simple-a",
        to_node="simple-b",
    )

    _assert_public_scalar_parity(scalars, label=dsl)


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
def test_cli_identity_collapse_matches_window_across_public_surfaces():
    window_dsl = f"{_LAT4_CD}.window(-90d:)"
    identity_dsl = f"{_LAT4_CD}.cohort(synth-lat4-c,-90d:)"

    window_scalars = _collect_public_edge_scalars(
        _LAT4,
        window_dsl,
        edge_name=_LAT4_CD_EDGE,
        from_node="synth-lat4-c",
        to_node="synth-lat4-d",
    )
    identity_scalars = _collect_public_edge_scalars(
        _LAT4,
        identity_dsl,
        edge_name=_LAT4_CD_EDGE,
        from_node="synth-lat4-c",
        to_node="synth-lat4-d",
    )

    _assert_public_scalar_parity(window_scalars, label=window_dsl)
    _assert_public_scalar_parity(identity_scalars, label=identity_dsl)

    comparisons = (
        ("param-pack p.mean", window_scalars["pack_p_mean"], identity_scalars["pack_p_mean"], _P_MEAN_ABS_TOL),
        (
            "conditioned_forecast p_mean",
            float(window_scalars["cf_edge"]["p_mean"]),
            float(identity_scalars["cf_edge"]["p_mean"]),
            _P_MEAN_ABS_TOL,
        ),
        (
            "cohort_maturity p_infinity_mean",
            float(window_scalars["cm_last"]["p_infinity_mean"]),
            float(identity_scalars["cm_last"]["p_infinity_mean"]),
            _P_MEAN_ABS_TOL,
        ),
        (
            "param-pack completeness",
            window_scalars["pack_completeness"],
            identity_scalars["pack_completeness"],
            _COMPLETENESS_ABS_TOL,
        ),
        (
            "conditioned_forecast completeness",
            float(window_scalars["cf_edge"]["completeness"]),
            float(identity_scalars["cf_edge"]["completeness"]),
            _COMPLETENESS_ABS_TOL,
        ),
        (
            "cohort_maturity completeness",
            float(window_scalars["cm_last"]["completeness"]),
            float(identity_scalars["cm_last"]["completeness"]),
            _COMPLETENESS_ABS_TOL,
        ),
    )
    for name, window_value, identity_value, tol in comparisons:
        delta = abs(window_value - identity_value)
        assert delta <= tol, (
            f"[{_LAT4_CD}] identity collapse failed for {name}: "
            f"window={window_value:.6f} identity={identity_value:.6f} delta={delta:.6f}"
        )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
def test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance():
    window_dsl = f"{_LAT4_CD}.window(-90d:)"
    cohort_dsl = f"{_LAT4_CD}.cohort(synth-lat4-b,-90d:)"

    window_scalars = _collect_public_edge_scalars(
        _LAT4,
        window_dsl,
        edge_name=_LAT4_CD_EDGE,
        from_node="synth-lat4-c",
        to_node="synth-lat4-d",
    )
    cohort_scalars = _collect_public_edge_scalars(
        _LAT4,
        cohort_dsl,
        edge_name=_LAT4_CD_EDGE,
        from_node="synth-lat4-c",
        to_node="synth-lat4-d",
    )

    _assert_public_scalar_parity(cohort_scalars, label=cohort_dsl)

    # Anchor-override completeness gap floor (re-derived 28-Apr-26).
    #
    # Geometry: snapshot_start_offset=60 (synth-lat4 truth.yaml), so the
    # snapshot DB carries 60d of c→d evidence. In window mode, c-arrival
    # ages at the frontier are uniform on [0, 59]. In cohort=b mode, the
    # b→c latency (t50 ≈ 10.5d) shifts c-arrivals forward, producing
    # effective ages roughly uniform on [0, 49]. Numerically integrating
    # the c→d CDF (mu=1.8, sigma=0.5, onset=2.5, t95≈16d) over each
    # range yields:
    #
    #   window E[CDF] ≈ 0.838      cohort=b E[CDF] ≈ 0.806
    #   predicted gap ≈ 0.032
    #
    # The original 0.05 floor was unjustified — never derived from the
    # fixture's actual carrier shape. This floor is set at 0.02 to
    # provide margin below the predicted ~0.032 (covers traffic-variation
    # noise on the order of cv=1.0) while staying well above the
    # _COMPLETENESS_ABS_TOL noise floor. Engine collapse onto window-
    # equivalent behaviour would compress the gap below 0.02 and trip
    # the floor.
    #
    # Test (3) ("provenance metadata correct") below remains the
    # authoritative check that the override fired — this floor only
    # asserts the override produced a downstream effect of the right
    # magnitude.
    completeness_delta = abs(
        cohort_scalars["pack_completeness"] - window_scalars["pack_completeness"]
    )
    assert completeness_delta >= 0.02, (
        f"[{_LAT4_CD}] expected cohort anchor override to change completeness versus window "
        f"by at least 0.02 (predicted ~0.032 from synth-lat4 fixture geometry): "
        f"window={window_scalars['pack_completeness']:.6f} "
        f"cohort={cohort_scalars['pack_completeness']:.6f} "
        f"delta={completeness_delta:.6f}"
    )

    cf_diag = _run_analyse_v3(
        _LAT4,
        cohort_dsl,
        analysis_type="conditioned_forecast",
        diagnostic=True,
    )
    cm_diag = _run_analyse_v3(_LAT4, cohort_dsl, diagnostic=True)

    expected = {
        "selected_family": "cohort",
        "selected_anchor_node": "synth-lat4-b",
        "admission_decision": "admitted",
        "decision_reason": "single_hop_anchor_override",
    }
    for provenance in (
        _extract_cf_provenance(cf_diag, from_node="synth-lat4-c", to_node="synth-lat4-d"),
        _extract_cm_provenance(cm_diag),
    ):
        for key, expected_value in expected.items():
            assert provenance.get(key) == expected_value, (
                f"[{_LAT4_CD}] provenance mismatch for {key}: "
                f"expected={expected_value!r} actual={provenance.get(key)!r}"
            )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
def test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point():
    dsl = f"{_LAT4_CD}.cohort(synth-lat4-b,-90d:)"
    scalars = _collect_public_edge_scalars(
        _LAT4,
        dsl,
        edge_name=_LAT4_CD_EDGE,
        from_node="synth-lat4-c",
        to_node="synth-lat4-d",
    )
    rows = _rows(scalars["cm_payload"])
    assert len(rows) >= 10, f"[{_LAT4_CD}] insufficient rows for projection-parity canary"

    first_row = rows[0]
    last_row = scalars["cm_last"]
    assert first_row.get("tau_days") != last_row.get("tau_days"), (
        f"[{_LAT4_CD}] expected non-terminal row for projection guard"
    )

    assert abs(scalars["pack_p_mean"] - float(last_row["p_infinity_mean"])) <= _P_MEAN_ABS_TOL
    assert abs(scalars["pack_completeness"] - float(last_row["completeness"])) <= _COMPLETENESS_ABS_TOL

    first_midpoint = first_row.get("model_midpoint")
    assert isinstance(first_midpoint, (int, float))
    assert abs(float(first_midpoint) - scalars["pack_p_mean"]) >= 0.05, (
        f"[{_LAT4_CD}] non-terminal midpoint should not be used as scalar parity target: "
        f"tau={first_row.get('tau_days')} midpoint={float(first_midpoint):.6f} "
        f"pack={scalars['pack_p_mean']:.6f}"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
@requires_synth(_NO_LAG, enriched=True)
@pytest.mark.parametrize(
    "graph_name,window_dsl,cohort_dsl,tol",
    (
        # All three cases converge through `compute_forecast_trajectory`'s IS
        # resampling; the realistic floor is the noise-floor constant.
        # Deltas above this expose the 73f class (a) anchor-override
        # evidence-binding asymmetry (see header).
        (_LAT4, f"{_LAT4_BC}.window(-1d:)", f"{_LAT4_BC}.cohort(-1d:)", _P_MEAN_ABS_TOL),
        (_LAT4, f"{_LAT4_CD}.window(-90d:)", f"{_LAT4_CD}.cohort(synth-lat4-b,-90d:)", _P_MEAN_ABS_TOL),
        (_NO_LAG, f"{_NO_LAG_BD}.window(-90d:)", f"{_NO_LAG_BD}.cohort(-90d:)", _P_MEAN_ABS_TOL),
    ),
)
def test_cohort_and_window_p_infinity_converge_for_same_subject_rate(
    graph_name: str,
    window_dsl: str,
    cohort_dsl: str,
    tol: float,
):
    window_row = _last_row(_run_analyse_v3(graph_name, window_dsl))
    cohort_row = _last_row(_run_analyse_v3(graph_name, cohort_dsl))
    window_p = window_row.get("p_infinity_mean")
    cohort_p = cohort_row.get("p_infinity_mean")
    assert isinstance(window_p, (int, float)) and isinstance(cohort_p, (int, float))
    delta = abs(float(window_p) - float(cohort_p))
    assert delta <= tol, (
        f"[{graph_name}] p_infinity mismatch for window/cohort subject-equivalent pair: "
        f"window={window_p:.6f} cohort={cohort_p:.6f} delta={delta:.6f}"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
def test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case():
    window_payload = _run_analyse_v3(
        _LAT4,
        f"{_LAT4_CD}.window(-90d:)",
        analysis_type="conditioned_forecast",
    )
    identity_payload = _run_analyse_v3(
        _LAT4,
        f"{_LAT4_CD}.cohort(synth-lat4-c,-90d:)",
        analysis_type="conditioned_forecast",
    )
    admitted_payload = _run_analyse_v3(
        _LAT4,
        f"{_LAT4_CD}.cohort(synth-lat4-b,-90d:)",
        analysis_type="conditioned_forecast",
    )

    window_edge = _extract_cf_edge(window_payload, from_node="synth-lat4-c", to_node="synth-lat4-d")
    identity_edge = _extract_cf_edge(identity_payload, from_node="synth-lat4-c", to_node="synth-lat4-d")
    admitted_edge = _extract_cf_edge(admitted_payload, from_node="synth-lat4-c", to_node="synth-lat4-d")

    for edge in (window_edge, identity_edge, admitted_edge):
        assert edge.get("conditioned") is True, "expected conditioned_forecast edge to be conditioned"

    assert (
        window_edge.get("evidence_k"),
        window_edge.get("evidence_n"),
    ) == (
        identity_edge.get("evidence_k"),
        identity_edge.get("evidence_n"),
    ), "A=X cohort should not switch evidence family"

    assert admitted_edge.get("evidence_n") < window_edge.get("evidence_n"), (
        "single-hop anchor override should admit narrower cohort-frame evidence"
    )
    assert admitted_edge.get("evidence_k") < window_edge.get("evidence_k"), (
        "single-hop anchor override should reduce admitted numerator evidence"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
def test_cohort_frame_evidence_does_not_retarget_carrier_or_subject():
    window_payload = _run_analyse_v3(_LAT4, f"{_LAT4_CD}.window(-90d:)")
    identity_payload = _run_analyse_v3(_LAT4, f"{_LAT4_CD}.cohort(synth-lat4-c,-90d:)")
    admitted_payload = _run_analyse_v3(_LAT4, f"{_LAT4_CD}.cohort(synth-lat4-b,-90d:)")

    window_curve = _numeric_curve(window_payload)
    identity_curve = _numeric_curve(identity_payload)
    admitted_curve = _numeric_curve(admitted_payload)

    # A=X collapse: window and identity-cohort SHOULD project the same
    # trajectory because the carrier collapses to identity. Both paths still
    # go through `compute_forecast_trajectory` with IS resampling, so the
    # cross-path tolerance is the noise floor (see header).
    _assert_max_abs_diff(
        window_curve,
        identity_curve,
        abs_tol=_P_MEAN_ABS_TOL,
        label=f"{_LAT4_CD} A=X collapse",
    )

    for tau in (5, 10):
        assert tau in window_curve and tau in admitted_curve
        assert admitted_curve[tau] <= window_curve[tau] - 0.02, (
            f"[{_LAT4_CD}] admitted cohort lost carrier-driven lag at tau={tau}: "
            f"window={window_curve[tau]:.6f} admitted={admitted_curve[tau]:.6f}"
        )

    window_p = _last_row(window_payload).get("p_infinity_mean")
    identity_p = _last_row(identity_payload).get("p_infinity_mean")
    admitted_p = _last_row(admitted_payload).get("p_infinity_mean")
    assert all(isinstance(value, (int, float)) for value in (window_p, identity_p, admitted_p))
    # Cross-cohort-frame `p∞` spread (window / identity / admitted): see
    # cross-anchor commentary above. Deltas above the noise floor are the
    # 73f class (a) anchor-override evidence-binding asymmetry.
    assert max(float(value) for value in (window_p, identity_p, admitted_p)) - min(
        float(value) for value in (window_p, identity_p, admitted_p)
    ) <= _P_MEAN_ABS_TOL


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
def test_zero_evidence_window_rises_as_subject_cdf():
    for graph_name, subject_dsl in (
        (_SIMPLE, _SIMPLE_BC),
        (_LAT4, _LAT4_BC),
    ):
        payload = _run_analyse_v3(graph_name, f"{subject_dsl}.window(-1d:)")
        _assert_not_flat(_numeric_curve(payload), label=f"{graph_name}/{subject_dsl}")


# ──────────────────────────────────────────────────────────────────────
# Suite C — FE/BE parity canaries via `--no-be`
# ──────────────────────────────────────────────────────────────────────
#
# Doc 73e §8.3 Stage 6 added a `--no-be` flag to `param-pack` that
# suppresses every BE-bound call. With the flag, `p.mean` reflects FE
# topo Step 2's `blendedMean = w_e · evidence.mean + (1 − w_e) ·
# forecast.mean` (see FE_BE_STATS_PARALLELISM.md §"Two logical steps in
# one pass"). Without the flag, `p.mean` is the CF-conditioned posterior
# from `compute_forecast_trajectory` (IS reweighting + doc 52 blend).
#
# The two writers fill the same field. On synthetic graphs with abundant
# evidence and well-calibrated priors, FE-topo's blend and CF's
# IS-conditioned mean should converge — and where they diverge, that is
# direct evidence that CF arithmetic is producing a different answer
# than the analytic baseline. Each test here picks a query that makes
# the convergence argument explicit, with a tolerance justified from
# the input scale (prior strength vs evidence strength) rather than
# pulled out of the air.
#
# Pre-existing failing tests (Group 2 / Group 3 in 73b §5) are
# semantic-correctness assertions against factorised oracles. These
# parity canaries are complementary: they catch CF arithmetic drift
# even on fixtures where the absolute oracle is hard to construct, by
# pinning CF against its own cheaper analytic baseline.


# Tolerance for FE/BE p.mean parity. Synth fixtures sample Bernoulli draws
# at finite N (e.g. ~450k draws over a 90-day window at simple-a→b gives
# sample-mean SE ≈ √(0.7·0.3/450k) ≈ 7e-4 on raw k/n alone). Maturity
# censoring, recency-weighted partial sums, the prior-strength term in
# w_evidence, and CF's IS reweighting each add independent components on
# top. 1e-2 is the honest "FE/BE arithmetic agree to within fixture noise"
# floor; tighter values flap on noise rather than catching real defects.
_PARITY_P_MEAN_TOL = 1e-2


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_parity_window_mature_high_evidence_p_mean():
    """Sanity / golden-path canary.

    On a fully-mature high-evidence window query (90 days of data on
    `simple-a-to-b`, truth p=0.7, t95 ≈ 24 days), CF's IS-conditioned
    posterior should collapse to ≈ Σy/Σx ≈ evidence.k/n. FE-topo's
    blendedMean approaches the same limit as `w_evidence → 1`. If the
    two surfaces disagree by more than the doc-52 blend residual on
    abundant evidence, something fundamental in CF (proposal / IS /
    blend wiring) is broken — independent of the cohort-anchor path.
    """
    dsl = f"{_SIMPLE_AB}.window(-90d:)"
    fe_only = _run_param_pack(_SIMPLE, dsl, no_be=True)
    full = _run_param_pack(_SIMPLE, dsl)

    fe_mean = _param_pack_edge_scalar(fe_only, edge_name=_SIMPLE_AB_EDGE, field="p.mean")
    full_mean = _param_pack_edge_scalar(full, edge_name=_SIMPLE_AB_EDGE, field="p.mean")
    delta = abs(fe_mean - full_mean)
    assert delta <= _PARITY_P_MEAN_TOL, (
        f"[{_SIMPLE_AB}] FE/BE p.mean parity failed on mature high-evidence window: "
        f"fe_only={fe_mean:.6f} full_be={full_mean:.6f} delta={delta:.6f} "
        f"tol={_PARITY_P_MEAN_TOL}"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
def test_parity_cohort_identity_collapse_p_mean():
    """Identity-collapse parity.

    `cohort(synth-lat4-c, -90d:)` on edge `c→d` is the identity case:
    the anchor equals the edge's from_node, so the carrier-materialisation
    block in `cohort_forecast_v3.py` (use_factorised_carrier=True gate)
    short-circuits with reach=1, and CF should produce the same answer
    as `window(-90d:)` on the same edge. FE-topo doesn't have a
    cohort-anchor branch at all — it emits the same blendedMean for any
    temporal mode on the edge with the same evidence. Both surfaces
    therefore reduce to the window case; FE/BE parity should hold.

    Catches: cohort-mode CF entry that mis-fires on identity collapse —
    something firing when reach=1 that should be a no-op.
    """
    cohort_dsl = f"{_LAT4_CD}.cohort(synth-lat4-c,-90d:)"
    fe_only = _run_param_pack(_LAT4, cohort_dsl, no_be=True)
    full = _run_param_pack(_LAT4, cohort_dsl)

    fe_mean = _param_pack_edge_scalar(fe_only, edge_name=_LAT4_CD_EDGE, field="p.mean")
    full_mean = _param_pack_edge_scalar(full, edge_name=_LAT4_CD_EDGE, field="p.mean")
    delta = abs(fe_mean - full_mean)
    assert delta <= _PARITY_P_MEAN_TOL, (
        f"[{_LAT4_CD}] FE/BE p.mean parity failed on identity-collapse cohort: "
        f"fe_only={fe_mean:.6f} full_be={full_mean:.6f} delta={delta:.6f} "
        f"tol={_PARITY_P_MEAN_TOL}"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
def test_parity_subject_equivalent_cohort_anchor_override_p_mean():
    """Subject-equivalent cohort vs window across surfaces — Group 2 catcher.

    `cohort(synth-lat4-b, -90d:)` on edge `c→d` is the canonical
    single-hop anchor-override case (truth p_cd = 0.65). The cohort
    framing changes the latency-completeness story but should not
    change the long-run edge rate — the same edge population is
    observed on the same days. FE-topo, which has no cohort-anchor
    branch, returns the same blendedMean as for a window query. CF
    *should* converge to the same edge rate at saturation; the
    carrier-materialisation block changes how cohorts are projected but
    not the asymptotic edge p.

    Catches: 73b §5 Group 2's 12–18% under-shift. With the CF defect
    present (reach-scaled evidence counts feeding IS log-weight, see
    73b §8.2), FE/BE diverge by ~0.1+ on this query.
    """
    cohort_dsl = f"{_LAT4_CD}.cohort(synth-lat4-b,-90d:)"
    fe_only = _run_param_pack(_LAT4, cohort_dsl, no_be=True)
    full = _run_param_pack(_LAT4, cohort_dsl)

    fe_mean = _param_pack_edge_scalar(fe_only, edge_name=_LAT4_CD_EDGE, field="p.mean")
    full_mean = _param_pack_edge_scalar(full, edge_name=_LAT4_CD_EDGE, field="p.mean")
    delta = abs(fe_mean - full_mean)
    assert delta <= _PARITY_P_MEAN_TOL, (
        f"[{_LAT4_CD}] FE/BE p.mean parity failed on single-hop anchor-override cohort: "
        f"fe_only={fe_mean:.6f} full_be={full_mean:.6f} delta={delta:.6f} "
        f"tol={_PARITY_P_MEAN_TOL} — likely Group 2 (carrier-materialisation reach-scaling)"
    )


@pytest.mark.parametrize(
    "anchor",
    [
        "synth-lat4-c",
        "synth-lat4-b",
    ],
)
@requires_db
@requires_data_repo
@requires_synth(_LAT4, enriched=True)
def test_fe_topo_cohort_c_to_d_p_mean_stays_near_truth(anchor: str):
    """F10 regression: FE-topo must not over-lift near-mature c→d evidence.

    `param-pack --no-be` exposes FE-topo Step 2 without CF. On synth-lat4
    c→d, both the analytic window baseline and raw scoped evidence are near
    truth. The FE-only current-answer scalar should therefore stay near the
    c→d truth rate rather than being lifted to the old 0.8105 failure value.
    """
    cohort_dsl = f"{_LAT4_CD}.cohort({anchor},-90d:)"
    fe_only = _run_param_pack(_LAT4, cohort_dsl, no_be=True)

    truth_p = _load_truth_edge_params(graph_name=_LAT4, edge_name="c-to-d")["p"]
    fe_mean = _param_pack_edge_scalar(fe_only, edge_name=_LAT4_CD_EDGE, field="p.mean")
    assert abs(fe_mean - truth_p) <= 0.03, (
        f"[{_LAT4_CD}] FE-topo --no-be p.mean should stay near c→d truth on cohort({anchor}): "
        f"fe_mean={fe_mean:.6f} truth={truth_p:.6f} delta={abs(fe_mean - truth_p):.6f}"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_parity_zero_evidence_cohort_returns_prior():
    """Zero-evidence baseline — both surfaces should return the prior.

    A degenerate one-day cohort window with no maturation has no
    evidence to condition on. FE-topo's blendedMean reduces to
    `forecast.mean` (the model_vars[analytic] aggregate prior mean) as
    `w_evidence → 0`. CF's conjugate update with `Σy ≈ Σx ≈ 0` returns
    `α_prior / (α + β) = prior mean`. The IS reweighting gate at
    `forecast_state.py:1152` (`_E_fail >= 1.0`) does not fire on
    degenerate-zero evidence; doc-52 blend trivially returns the
    prior. Both surfaces should land at the prior mean, and at each
    other.

    Catches: CF doing anything *interesting* on zero-evidence, which
    is a defect — there is nothing to condition on. Pins the prior
    baseline so the low-evidence Group 3 test can define the slope.
    """
    cohort_dsl = f"{_SIMPLE_BC}.cohort(1-Mar-26:1-Mar-26).asat(1-Mar-26)"
    fe_only = _run_param_pack(_SIMPLE, cohort_dsl, no_be=True)
    full = _run_param_pack(_SIMPLE, cohort_dsl)

    fe_mean = _param_pack_edge_scalar(fe_only, edge_name="simple-b-to-c", field="p.mean")
    full_mean = _param_pack_edge_scalar(full, edge_name="simple-b-to-c", field="p.mean")
    delta = abs(fe_mean - full_mean)
    assert delta <= _PARITY_P_MEAN_TOL, (
        f"[{_SIMPLE_BC}] FE/BE p.mean parity failed on zero-evidence cohort: "
        f"fe_only={fe_mean:.6f} full_be={full_mean:.6f} delta={delta:.6f} "
        f"tol={_PARITY_P_MEAN_TOL} — both surfaces should return the prior on zero evidence"
    )


# ──────────────────────────────────────────────────────────────────────
# Suite D — analytic ↔ bayes source parity canaries via `--bayes-vars`
# ──────────────────────────────────────────────────────────────────────
#
# Purpose: assert that analytic-source and bayesian-source promotion paths
# converge on golden-condition queries where they should. Complements
# Suite A (oracle correctness), Suite B (FE/CLI surface parity), and
# Suite C (FE/BE parity within one source) by pinning the *source* axis
# of variation.
#
# Pattern: each test runs `analyse --type cohort_maturity` twice on the
# same DSL — once **without** sidecar (analytic source promoted, kappa-
# derived prior) and once **with** the matching
# `bayes/fixtures/<graph>.bayes-vars.json` sidecar (bayesian source
# promoted, fitted posterior). Both runs use full BE/CF. Compare per-tau
# `midpoint` curves and last-row `p_infinity_mean` with tolerances
# justified per test.
#
# Why this matters: outside-in tests have been running on analytic
# sources because synth fixture parameter files don't carry `posterior:`
# blocks (see 73f F3). Suite D forces the bayesian projection path to
# run by injecting a fitted posterior via `--bayes-vars`. Where Suite
# C's `--no-be` flag distinguishes BE-arithmetic vs FE-only divergence,
# Suite D's sidecar distinguishes analytic-source vs bayesian-source
# promotion in the model resolver and downstream consumers. F1-class
# defects (reach-scaled IS log-weight, see 73f) typically affect the
# small analytic prior far more than the large bayes prior; that
# asymmetry is the core diagnostic Suite D pins.
#
# `analyse` (not `param-pack`) is used because F1 manifests at
# intermediate τ — the asymptote can land near truth while the
# conditioned median collapses at τ=15-20. Curve comparison catches
# what a scalar comparison would miss.

_BAYES_VARS_DIR = _REPO_ROOT / "bayes" / "fixtures"

# Cross-source parity tolerance (analytic vs bayes posterior priors fed
# to the same trajectory engine).
#
# Re-derived 28-Apr-26 from 1e-3 to 2e-3. The two paths feed different
# `(α, β)` priors to `rng.beta(...)` inside `compute_forecast_trajectory`,
# which produces different particle clouds even at fixed seed=42 because
# `rng.beta` consumes parameters into its gamma sampling. The clouds then
# go through different IS log-likelihoods and resample to different
# posterior `mean(p_draws)` values.
#
# Noise-floor estimate:
#   - Analytic prior sd ≈ 0.04 → SE on mean(p_draws) for S=2000 ≈ 9e-4.
#   - Bayes prior with n_effective ~ 1e5 → sd ≈ 0.005 → SE ≈ 1e-4.
#   - Cross-source comparison floor ≈ max(SE_analytic, SE_bayes) + FW
#     convolution drift + IS resample drift ≈ 2e-3.
#
# Cross-source deltas above 2e-3 indicate genuine prior pull-through —
# the conditioned posterior is not fully evidence-dominated for the query
# at hand, and the prior shape is leaking into the public scalar. That is
# a real semantic question (per-cohort `evidence_n` / `evidence_k` carrying
# the same effective sufficient statistic regardless of source) and the
# fix surface is upstream evidence construction, not the public scalar.
_SOURCE_PARITY_TOL = 2e-3
_ZERO_EVIDENCE_PARITY_TOL = 5e-3
_F1_DIVERGENCE_FLOOR = 0.30


def _bayes_vars_path(graph_name: str) -> Path:
    return _BAYES_VARS_DIR / f"{graph_name}.bayes-vars.json"


def _promoted_source_from_cm(payload: dict[str, Any]) -> str:
    """Read `promoted_source` from cohort_maturity payload's first model curve.

    The cohort_maturity payload carries per-scenario per-subject curves
    under `result.metadata.model_curves[<key>].params.promoted_source`.
    For Suite D's single-scenario queries there is exactly one curve.
    Returns '' when absent so callers can produce informative failures.
    """
    metadata = (payload.get("result") or {}).get("metadata") or {}
    curves = metadata.get("model_curves") or {}
    if not curves:
        return ""
    first = next(iter(curves.values())) or {}
    params = first.get("params") or {}
    return str(params.get("promoted_source") or "")


def _max_pointwise_relative_diff(
    curve_a: dict[int, float],
    curve_b: dict[int, float],
    *,
    tau_min: int,
    tau_max: int,
    eps: float = 1e-9,
) -> tuple[float, int]:
    """Return (max relative diff, tau where it occurs) on shared τ in [tau_min, tau_max]."""
    shared = sorted(t for t in (set(curve_a) & set(curve_b)) if tau_min <= t <= tau_max)
    if not shared:
        return 0.0, -1
    best_rel, best_tau = 0.0, shared[0]
    for tau in shared:
        a, b = curve_a[tau], curve_b[tau]
        denom = max(abs(a), abs(b), eps)
        rel = abs(a - b) / denom
        if rel > best_rel:
            best_rel, best_tau = rel, tau
    return best_rel, best_tau


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_d0_bayes_vars_actually_promotes_to_bayesian():
    """Sanity: --bayes-vars sidecar promotes to bayesian source.

    Without sidecar: synth fixture has no `posterior:` block (see 73f F3),
    so promotion falls back to analytic. With sidecar: the bayes patch
    service applies the fitted posterior via the same applyPatchAndCascade
    codepath the browser uses for webhook patches (see
    `cohort-cf-defect-and-cli-fe-parity.md`); the rhat/ess gate passes
    (rhat=1.0013, ess=16026 in `bayes/fixtures/synth-simple-abc.bayes-vars.json`)
    and bayesian is promoted.

    If this fails, the rest of Suite D is meaningless — the sidecar
    never took effect and the two runs are both analytic. Guards every
    other Suite D test.
    """
    sidecar = _bayes_vars_path(_SIMPLE)
    if not sidecar.exists():
        pytest.skip(f"sidecar missing: {sidecar}")

    dsl = f"{_SIMPLE_AB}.window(-90d:)"
    analytic = _run_analyse_v3(_SIMPLE, dsl)
    bayes = _run_analyse_v3(_SIMPLE, dsl, sidecar=sidecar)

    analytic_source = _promoted_source_from_cm(analytic)
    bayes_source = _promoted_source_from_cm(bayes)

    assert analytic_source == "analytic", (
        f"expected promoted_source='analytic' without sidecar, got {analytic_source!r}; "
        f"the synth fixture parameter file may have grown a posterior block "
        f"(in which case 73f F3 needs revisiting)"
    )
    assert bayes_source == "bayesian", (
        f"expected promoted_source='bayesian' with sidecar, got {bayes_source!r}; "
        f"sidecar plumbing or quality gate may be broken (see 73f F3 / bayesPatchService)"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_d1_parity_analytic_vs_bayes_mature_window():
    """Mature high-evidence window — both surfaces converge to evidence.k/n.

    On a 90-day window with ~5000/day at simple-a (truth p=0.7), evidence
    overwhelms both priors. Analytic promotion (kappa-derived α+β ≈ 50)
    and bayesian promotion (fitted α+β ≈ 11000) should both produce
    `p.mean ≈ k/n ≈ 0.7099`. Asymptote parity to 1e-3; curve parity to
    2e-2 across τ ∈ [10, 60] (looser because the curve carries some
    early-τ shape that posterior dispersion can perturb without moving
    the asymptote).

    Catches: bayes-vars projection bugs that skew p.posterior; window-
    mode rate computation regressions on either source; bayesian-side
    IS proposal divergence under abundant evidence.
    """
    sidecar = _bayes_vars_path(_SIMPLE)
    if not sidecar.exists():
        pytest.skip(f"sidecar missing: {sidecar}")

    dsl = f"{_SIMPLE_AB}.window(-90d:)"
    analytic = _run_analyse_v3(_SIMPLE, dsl)
    bayes = _run_analyse_v3(_SIMPLE, dsl, sidecar=sidecar)

    a_p = float(_last_row(analytic).get("p_infinity_mean") or 0.0)
    b_p = float(_last_row(bayes).get("p_infinity_mean") or 0.0)
    delta = abs(a_p - b_p)
    assert delta <= _SOURCE_PARITY_TOL, (
        f"[{_SIMPLE_AB}] analytic vs bayes p_infinity parity failed on mature window: "
        f"analytic={a_p:.6f} bayes={b_p:.6f} delta={delta:.6f} tol={_SOURCE_PARITY_TOL}"
    )

    a_curve = _numeric_curve(analytic, field="midpoint")
    b_curve = _numeric_curve(bayes, field="midpoint")
    rel_diff, tau_at = _max_pointwise_relative_diff(
        a_curve, b_curve, tau_min=10, tau_max=60
    )
    assert rel_diff <= 0.02, (
        f"[{_SIMPLE_AB}] analytic vs bayes midpoint curve diverges in stable band: "
        f"max rel diff {rel_diff:.4f} at tau={tau_at} on a mature window where "
        f"both surfaces should be evidence-dominated"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_d2_parity_analytic_vs_bayes_identity_collapse_cohort():
    """Identity-collapse cohort A=X — carrier collapses, both → window result.

    `cohort(simple-b, simple-b-to-c, -90d:)` is the A=X case for edge
    b→c: the anchor equals the edge's from_node, so the carrier-
    materialisation gate at cohort_forecast_v3.py:953 short-circuits
    with reach=1. Both analytic and bayesian sources should collapse to
    the same window edge rate.

    Catches: cohort-mode bayesian path that mis-fires on identity
    collapse — something firing when reach=1 that should be a no-op,
    but only on the bayes side (e.g., bayes posterior projection
    interacting with the identity-collapse gate differently from
    analytic).
    """
    sidecar = _bayes_vars_path(_SIMPLE)
    if not sidecar.exists():
        pytest.skip(f"sidecar missing: {sidecar}")

    dsl = f"{_SIMPLE_BC}.cohort(simple-b,-90d:)"
    analytic = _run_analyse_v3(_SIMPLE, dsl)
    bayes = _run_analyse_v3(_SIMPLE, dsl, sidecar=sidecar)

    a_p = float(_last_row(analytic).get("p_infinity_mean") or 0.0)
    b_p = float(_last_row(bayes).get("p_infinity_mean") or 0.0)
    delta = abs(a_p - b_p)
    assert delta <= _SOURCE_PARITY_TOL, (
        f"[{_SIMPLE_BC}] analytic vs bayes p_infinity parity failed on identity-collapse cohort: "
        f"analytic={a_p:.6f} bayes={b_p:.6f} delta={delta:.6f} tol={_SOURCE_PARITY_TOL}"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_d3_parity_analytic_vs_bayes_zero_evidence_returns_prior():
    """Zero-evidence cohort — both surfaces return their respective prior.

    A degenerate one-day cohort with no maturation has nothing to
    condition on. Both surfaces should return their prior:
      - analytic: `forecast_mean` from values block ≈ 0.6034
      - bayesian: α/(α+β) ≈ 6925.5 / 11510.5 ≈ 0.6017

    The two priors differ by ~1.7e-3 at source (synth_gen vs bayes-fit
    drift). Tolerance loosened to 5e-3 to tolerate this and small
    downstream drift; tightening would require reconciling synth-gen's
    analytic forecast_mean with the bayes-fitted α/β mean upstream.

    Catches: prior-vs-evidence wiring bug where one surface interprets
    the prior differently from the other on zero evidence; CF doing
    anything *interesting* on zero-evidence on one source but not the
    other.
    """
    sidecar = _bayes_vars_path(_SIMPLE)
    if not sidecar.exists():
        pytest.skip(f"sidecar missing: {sidecar}")

    dsl = f"{_SIMPLE_BC}.cohort(1-Mar-26:1-Mar-26).asat(1-Mar-26)"
    analytic = _run_analyse_v3(_SIMPLE, dsl)
    bayes = _run_analyse_v3(_SIMPLE, dsl, sidecar=sidecar)

    a_p = float(_last_row(analytic).get("p_infinity_mean") or 0.0)
    b_p = float(_last_row(bayes).get("p_infinity_mean") or 0.0)
    delta = abs(a_p - b_p)
    assert delta <= _ZERO_EVIDENCE_PARITY_TOL, (
        f"[{_SIMPLE_BC}] analytic vs bayes p_infinity parity failed on zero-evidence cohort: "
        f"analytic={a_p:.6f} bayes={b_p:.6f} delta={delta:.6f} tol={_ZERO_EVIDENCE_PARITY_TOL} "
        f"— both surfaces should return their respective prior on zero evidence"
    )


@pytest.mark.xfail(
    strict=True,
    reason=(
        "73f F1 — reach-scaled evidence counts feeding IS log-weight. "
        "Analytic source's small prior (kappa~50) is overwhelmed by reach-"
        "scaled cohort evidence and produces Group 3's ~60% under-shift; "
        "bayes-vars' large prior (α+β≈11500) dominates and stays close to "
        "oracle. Parity therefore fails until F1 is fixed. Strict-xfail: "
        "when F1 lands, this test starts passing and the marker fires, "
        "signalling closure."
    ),
)
@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_d4_parity_analytic_vs_bayes_low_evidence_cohort_F1_signature():
    """F1-class catcher in PARITY form (currently xfail-strict).

    Same DSL as Suite A's `test_low_evidence_cohort_matches_factorised_convolution_oracle`
    (Group 3): `cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)` on b→c.

    Without sidecar: F1 reach-scales the IS log-weight evidence at
    `forecast_state.py:1149-1173`, the small analytic prior gets
    dominated, and the cohort midpoint collapses ~60% below the
    factorised oracle in τ=15-20.
    With sidecar: bayes prior strength (α+β≈11500) dominates the reach-
    scaled correction; midpoint stays close to prior/oracle.
    Result: parity fails until F1 is fixed.

    When F1 is fixed, both surfaces converge and this test passes;
    strict=True fires the xfail marker as the "F1 closed" signal.
    """
    sidecar = _bayes_vars_path(_SIMPLE)
    if not sidecar.exists():
        pytest.skip(f"sidecar missing: {sidecar}")

    dsl = f"{_SIMPLE_BC}.cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)"
    analytic = _run_analyse_v3(_SIMPLE, dsl)
    bayes = _run_analyse_v3(_SIMPLE, dsl, sidecar=sidecar)

    a_curve = _numeric_curve(analytic, field="midpoint")
    b_curve = _numeric_curve(bayes, field="midpoint")
    rel_diff, tau_at = _max_pointwise_relative_diff(
        a_curve, b_curve, tau_min=15, tau_max=20
    )
    assert rel_diff <= _F1_DIVERGENCE_FLOOR, (
        f"[{_SIMPLE_BC}] analytic vs bayes midpoint curves diverge by "
        f"{rel_diff:.4f} (at tau={tau_at}) on the low-evidence cohort — "
        f"currently expected to fail (F1, see 73f)"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_d5_anti_parity_analytic_vs_bayes_low_evidence_cohort_F1_pinned():
    """F1-class catcher in ANTI-PARITY form (currently passing, fires on fix).

    Dual of D4: asserts that the analytic vs bayes midpoint curves
    DIVERGE by at least `_F1_DIVERGENCE_FLOOR` (30%) on the same low-
    evidence cohort that exhibits Group 3. Currently passes because F1's
    reach-scaling affects the small analytic prior much more than the
    large bayes prior.

    When F1 is fixed and both surfaces converge to oracle, this assertion
    starts failing — the diagnostic signal that F1 is closed. Together
    with D4 (xfail-strict), Suite D pins F1's status from two angles:
      - D4: parity assertion currently failing (xfail), passes on fix
      - D5: anti-parity assertion currently passing, fails on fix

    A failure here without a corresponding D4 transition (D4 still
    failing) would indicate that the bayes-vars projection has stopped
    taking effect, in which case re-check D0 first.
    """
    sidecar = _bayes_vars_path(_SIMPLE)
    if not sidecar.exists():
        pytest.skip(f"sidecar missing: {sidecar}")

    dsl = f"{_SIMPLE_BC}.cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)"
    analytic = _run_analyse_v3(_SIMPLE, dsl)
    bayes = _run_analyse_v3(_SIMPLE, dsl, sidecar=sidecar)

    a_curve = _numeric_curve(analytic, field="midpoint")
    b_curve = _numeric_curve(bayes, field="midpoint")
    rel_diff, tau_at = _max_pointwise_relative_diff(
        a_curve, b_curve, tau_min=15, tau_max=20
    )
    assert rel_diff > _F1_DIVERGENCE_FLOOR, (
        f"[{_SIMPLE_BC}] analytic vs bayes midpoint curves agree to within "
        f"{rel_diff:.4f} (at tau={tau_at}) on the low-evidence cohort — "
        f"unexpected convergence. If F1 has been fixed (see 73f), expect "
        f"this test to fail intentionally; if not, the bayes-vars projection "
        f"may have stopped taking effect (re-check D0). "
        f"floor={_F1_DIVERGENCE_FLOOR:.2f}"
    )
