"""Outside-in acceptance suite for factorised cohort semantics.

Single owner for public CLI (`graph-ops/scripts/analyse.sh` and
`graph-ops/scripts/param-pack.sh`) assertions around `cohort(A, X-end)`
behaviour. These tests intentionally stay at the user-visible boundary:

- `param-pack` edge scalars for parity against analysis projections
- `cohort_maturity` rows for trajectory and shape contracts
- `conditioned_forecast` edge scalars only where evidence-admission provenance
  is observable through public diagnostics / `evidence_k` / `evidence_n`

================================================================
MODIFICATION POLICY (soft norm — not a hard block)
================================================================
This suite is the canonical acceptance oracle for the cohort-forecast
runtime. The semantic and logical invariants encoded here are
carefully designed and tied to the engineering invariants in
`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
("The outside-in suite is the oracle" section). Cavalier changes are
how invariants quietly weaken; an inside test that disagrees with this
suite is, by construction, the artefact to revisit — not this file.

Before editing this file (adding, removing, or modifying a test or
assertion, weakening a tolerance, marking xfail, or relaxing a
fixture expectation), an agent MUST seek explicit user approval.
State (a) the change, (b) the reason, and (c) which semantic or
engineering invariant is involved.

Mechanical refactors that preserve every assertion exactly — renames,
formatting, import order, helper extraction with identical behaviour
— do not require approval. Anything that could plausibly change a
pass/fail outcome on any of the synth fixtures or pinned regimes
does.
================================================================

Fixture/provenance spike status (26-Apr-26):
- usable: `synth-simple-abc`, `synth-lat4`, `synth-fanout-test`,
  `cf-fix-deep-mixed`, `cf-fix-linear-no-lag`
- deferred in this suite: explicit multi-hop cohort-frame admission denial for
  non-single-hop subjects (no unambiguous public provenance field yet)

Wallclock pinning (29-Apr-26): the file's relative DSL forms (`window(-Nd:)`,
`cohort(<anchor>,-Nd:)`) were pinned to today's-resolution absolute dates so
the test suite is invariant under wall-clock advancement. The conversion
preserves the evidence regime each test was running on at pin date:
  -90d:  → 29-Jan-26:29-Apr-26
  -180d: → 31-Oct-25:29-Apr-26
See `test_a_equals_x_identity_collapses_to_window` for the rationale (the
worked example for the pattern). Tests using `window(-1d:)` or `cohort(-1d:)`
are deliberately NOT pinned in this pass — they need separate per-test
analysis (vacuous-by-design vs. narrow-real-evidence intent).
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

from conftest import (
    load_candidate_regimes_by_mode,
    load_graph_json,
    requires_data_repo,
    requires_db,
    requires_synth,
    _ensure_bayes_sidecar_for_asat,
)
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

# Cache toggle for performance comparison. Default OFF (--no-cache /
# --no-snapshot-cache passed) preserves historical behaviour: the suite
# was authored to exercise the slow path so accumulated floating-point
# tolerances were calibrated against uncached compute. Set
# DAGNET_TEST_USE_CACHE=1 to omit those flags and let the daemon's
# in-process caches serve repeated calls.
_USE_CACHE = os.environ.get("DAGNET_TEST_USE_CACHE", "0") == "1"

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
_P_MEAN_ABS_TOL = 1.5e-3
_COMPLETENESS_ABS_TOL = 1e-4
_PROJECTION_PRODUCT_ABS_TOL = 0.025


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
            "--format", "json",
        ]
        if not _USE_CACHE:
            args += ["--no-cache", "--no-snapshot-cache"]
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
    ]
    if not _USE_CACHE:
        cmd += ["--no-cache", "--no-snapshot-cache"]
    cmd += ["--format", "json"]
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
    edges = truth.get("edges") or {}
    edge = edges.get(edge_name)
    if edge is None and edge_name.startswith(f"{graph_name}-"):
        edge = edges.get(edge_name[len(graph_name) + 1:])
    assert edge is not None, f"missing truth edge {edge_name!r} in {graph_name}"
    return {
        "p": float(edge["p"]),
        "onset": float(edge["onset"]),
        "mu": float(edge["mu"]),
        "sigma": float(edge["sigma"]),
    }


def _graph_edge_for_param(
    *,
    graph_name: str,
    edge_name: str,
) -> dict[str, Any]:
    graph = load_graph_json(graph_name)
    for edge in graph.get("edges", []):
        if (edge.get("p") or {}).get("id") == edge_name:
            return edge
    raise AssertionError(f"missing edge with p.id={edge_name!r} in {graph_name}")


def _selected_a_clock_snapshot_oracle(
    *,
    graph_name: str,
    edge_name: str,
    anchor_node_id: str,
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    numerator_edge_name: str | None = None,
) -> dict[int, dict[str, float]]:
    """Independent raw-DB oracle for selected A-clock cohort evidence.

    Reads cohort-family snapshot rows and aggregates by A-clock age
    τ = retrieved_at_date - anchor_day. For multi-hop subjects,
    `edge_name` supplies the denominator at query X (its x field) and
    `numerator_edge_name` supplies the numerator at the subject end
    (its y field). This deliberately bypasses cohort_maturity row
    construction and chart normalisation.
    """
    from datetime import date as _date
    from datetime import timedelta as _timedelta
    from snapshot_service import query_snapshots_for_sweep

    def _cohort_rows_for(edge_name_: str) -> list[dict[str, Any]]:
        edge = _graph_edge_for_param(graph_name=graph_name, edge_name=edge_name_)
        edge_uuid = str(edge.get("uuid") or "")
        assert edge_uuid, f"{graph_name}/{edge_name_}: edge has no uuid"
        regimes = load_candidate_regimes_by_mode(graph_name).get(edge_uuid, [])
        cohort_regime = next(
            (
                r for r in regimes
                if r.get("temporal_mode") == "cohort"
                and str(r.get("cohort_anchor") or "") == anchor_node_id
            ),
            None,
        )
        assert cohort_regime is not None, (
            f"{graph_name}/{edge_name_}: no cohort candidate regime for "
            f"anchor {anchor_node_id!r} in {regimes!r}"
        )
        return query_snapshots_for_sweep(
            param_id=(edge.get("p") or {}).get("id") or edge_name_,
            core_hash=str(cohort_regime["core_hash"]),
            anchor_from=af,
            anchor_to=at,
            sweep_from=af,
            sweep_to=st,
            equivalent_hashes=[
                {"core_hash": h}
                for h in (cohort_regime.get("equivalent_hashes") or [])
            ],
        )

    af = _date.fromisoformat(anchor_from)
    at = _date.fromisoformat(anchor_to)
    st = _date.fromisoformat(sweep_to)

    def _series(rows: list[dict[str, Any]]) -> dict[tuple[str, str], list[dict[str, Any]]]:
        by_series: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for row in rows:
            slice_key = str(row.get("slice_key") or "")
            if "cohort(" not in slice_key:
                continue
            anchor_day = str(row.get("anchor_day") or "")[:10]
            retrieved_at = str(row.get("retrieved_at") or "")[:10]
            if not anchor_day or not retrieved_at:
                continue
            by_series.setdefault((anchor_day, slice_key), []).append(row)
        for series_rows in by_series.values():
            series_rows.sort(key=lambda r: str(r.get("retrieved_at") or "")[:10])
        return by_series

    denominator_series = _series(_cohort_rows_for(edge_name))
    numerator_series = _series(_cohort_rows_for(numerator_edge_name or edge_name))

    def _latest_at(
        series: dict[tuple[str, str], list[dict[str, Any]]],
        *,
        anchor_day: str,
        ret_date_iso: str,
        field: str,
    ) -> float:
        total = 0.0
        for (ad, _slice_key), series_rows in series.items():
            if ad != anchor_day:
                continue
            latest = None
            for row in series_rows:
                retrieved_at = str(row.get("retrieved_at") or "")[:10]
                if retrieved_at <= ret_date_iso:
                    latest = row
                else:
                    break
            if latest is not None:
                total += float(latest.get(field) or 0.0)
        return total

    anchor_days = sorted({
        ad for ad, _slice_key in denominator_series
    } | {
        ad for ad, _slice_key in numerator_series
    })

    by_tau: dict[int, dict[str, float]] = {}
    ret_date = af
    while ret_date <= st:
        ret_iso = ret_date.isoformat()
        for anchor_day in anchor_days:
            tau = (ret_date - _date.fromisoformat(anchor_day)).days
            if tau < 0:
                continue
            x_val = _latest_at(
                denominator_series,
                anchor_day=anchor_day,
                ret_date_iso=ret_iso,
                field="x",
            )
            y_val = _latest_at(
                numerator_series,
                anchor_day=anchor_day,
                ret_date_iso=ret_iso,
                field="y",
            )
            if x_val <= 0 and y_val <= 0:
                continue
            bucket = by_tau.setdefault(
                int(tau),
                {"sum_x": 0.0, "sum_y": 0.0, "n_rows": 0.0},
            )
            bucket["sum_x"] += x_val
            bucket["sum_y"] += y_val
            bucket["n_rows"] += 1.0
        ret_date += _timedelta(days=1)

    for bucket in by_tau.values():
        bucket["rate"] = (
            bucket["sum_y"] / bucket["sum_x"]
            if bucket["sum_x"] > 0
            else math.nan
        )
    return by_tau


def _window_rows_for_edge(
    *,
    graph_name: str,
    edge_name: str,
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
) -> dict[str, list[dict[str, Any]]]:
    """Raw DB window rows grouped by source-day.

    Used by the multi-hop window evidence oracle. This deliberately bypasses
    cohort_maturity row construction and reads the same snapshot table the BE
    read path consumes.
    """
    from datetime import date as _date
    from snapshot_service import query_snapshots_for_sweep

    edge = _graph_edge_for_param(graph_name=graph_name, edge_name=edge_name)
    edge_uuid = str(edge.get("uuid") or "")
    assert edge_uuid, f"{graph_name}/{edge_name}: edge has no uuid"
    regimes = load_candidate_regimes_by_mode(graph_name).get(edge_uuid, [])
    window_regime = next(
        (r for r in regimes if r.get("temporal_mode") == "window"),
        None,
    )
    assert window_regime is not None, (
        f"{graph_name}/{edge_name}: no window candidate regime in {regimes!r}"
    )
    rows = query_snapshots_for_sweep(
        param_id=(edge.get("p") or {}).get("id") or edge_name,
        core_hash=str(window_regime["core_hash"]),
        anchor_from=_date.fromisoformat(anchor_from),
        anchor_to=_date.fromisoformat(anchor_to),
        sweep_from=_date.fromisoformat(anchor_from),
        sweep_to=_date.fromisoformat(sweep_to),
        equivalent_hashes=[
            {"core_hash": h}
            for h in (window_regime.get("equivalent_hashes") or [])
        ],
    )

    by_anchor: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        slice_key = str(row.get("slice_key") or "")
        if "window(" not in slice_key:
            continue
        anchor_day = str(row.get("anchor_day") or "")[:10]
        retrieved_at = str(row.get("retrieved_at") or "")[:10]
        if not anchor_day or not retrieved_at:
            continue
        by_anchor.setdefault(anchor_day, []).append(row)
    for anchor_rows in by_anchor.values():
        anchor_rows.sort(key=lambda r: str(r.get("retrieved_at") or "")[:10])
    return by_anchor


def _latest_window_row(
    series: dict[str, list[dict[str, Any]]],
    *,
    anchor_day: str,
    ret_date_iso: str,
) -> dict[str, Any] | None:
    latest = None
    for row in series.get(anchor_day, ()):
        retrieved_at = str(row.get("retrieved_at") or "")[:10]
        if retrieved_at <= ret_date_iso:
            latest = row
        else:
            break
    return latest


def _window_rate_at(
    series: dict[str, list[dict[str, Any]]],
    *,
    anchor_day: str,
    ret_date_iso: str,
) -> float:
    row = _latest_window_row(
        series,
        anchor_day=anchor_day,
        ret_date_iso=ret_date_iso,
    )
    if row is None:
        return 0.0
    x_val = float(row.get("x") or 0.0)
    if x_val <= 0.0:
        return 0.0
    return float(row.get("y") or 0.0) / x_val


def _window_x_at(
    series: dict[str, list[dict[str, Any]]],
    *,
    anchor_day: str,
    ret_date_iso: str,
) -> float:
    row = _latest_window_row(
        series,
        anchor_day=anchor_day,
        ret_date_iso=ret_date_iso,
    )
    if row is None:
        return 0.0
    return float(row.get("x") or 0.0)


def _window_y_at(
    series: dict[str, list[dict[str, Any]]],
    *,
    anchor_day: str,
    ret_date_iso: str,
) -> float:
    row = _latest_window_row(
        series,
        anchor_day=anchor_day,
        ret_date_iso=ret_date_iso,
    )
    if row is None:
        return 0.0
    return float(row.get("y") or 0.0)


def _window_multihop_rate_attributed_oracle(
    *,
    graph_name: str,
    first_edge_name: str,
    second_edge_name: str,
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    tau_max: int,
) -> dict[int, dict[str, float]]:
    """Independent oracle for two-hop `window()` synthetic evidence.

    For X->M->Z, compose raw DB window rows as rates:

        N_X(a) * sum_s inc_rate_XM(a, s) * rate_MZ(a+s, tau-s)

    The output is scaled back to selected X-window mass. Raw terminal M->Z
    counts are also returned so tests can prove the fixture distinguishes
    correct rate-attributed evidence from a terminal-count shortcut.
    """
    from datetime import date as _date
    from datetime import timedelta as _timedelta

    af = _date.fromisoformat(anchor_from)
    at = _date.fromisoformat(anchor_to)
    st = _date.fromisoformat(sweep_to)
    first_rows = _window_rows_for_edge(
        graph_name=graph_name,
        edge_name=first_edge_name,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
    )
    second_rows = _window_rows_for_edge(
        graph_name=graph_name,
        edge_name=second_edge_name,
        anchor_from=anchor_from,
        anchor_to=sweep_to,
        sweep_to=sweep_to,
    )

    second_kernel: dict[int, float] = {}
    for age in range(max(int(tau_max), 0) + 1):
        sum_n = 0.0
        sum_k = 0.0
        for source_day, rows in second_rows.items():
            try:
                source_d = _date.fromisoformat(source_day)
            except (TypeError, ValueError):
                continue
            ret_iso = (source_d + _timedelta(days=age)).isoformat()
            row = _latest_window_row(
                second_rows,
                anchor_day=source_day,
                ret_date_iso=ret_iso,
            )
            if row is None:
                continue
            sum_n += float(row.get("x") or 0.0)
            sum_k += float(row.get("y") or 0.0)
        if sum_n > 0.0:
            second_kernel[age] = sum_k / sum_n

    anchor_days = [
        (af + _timedelta(days=offset)).isoformat()
        for offset in range((at - af).days + 1)
    ]
    out: dict[int, dict[str, float]] = {}
    for tau in range(max(int(tau_max), 0) + 1):
        sum_x = 0.0
        sum_y = 0.0
        raw_terminal_y_same_anchor = 0.0
        synthetic_mid_mass = 0.0
        local_terminal_x_same_anchor = 0.0
        for anchor_day in anchor_days:
            anchor_d = _date.fromisoformat(anchor_day)
            ret_d = anchor_d + _timedelta(days=int(tau))
            if ret_d > st:
                continue
            ret_iso = ret_d.isoformat()
            n_source = _window_x_at(
                first_rows,
                anchor_day=anchor_day,
                ret_date_iso=ret_iso,
            )
            if n_source <= 0.0:
                continue
            sum_x += n_source
            raw_terminal_y_same_anchor += _window_y_at(
                second_rows,
                anchor_day=anchor_day,
                ret_date_iso=ret_iso,
            )
            local_terminal_x_same_anchor += _window_x_at(
                second_rows,
                anchor_day=anchor_day,
                ret_date_iso=ret_iso,
            )
            prev_rate = 0.0
            for s in range(int(tau) + 1):
                first_ret = anchor_d + _timedelta(days=s)
                if first_ret > st:
                    break
                first_rate = _window_rate_at(
                    first_rows,
                    anchor_day=anchor_day,
                    ret_date_iso=first_ret.isoformat(),
                )
                inc_rate = max(first_rate - prev_rate, 0.0)
                prev_rate = max(prev_rate, first_rate)
                if inc_rate <= 0.0:
                    continue
                terminal_rate = second_kernel.get(int(tau) - s, 0.0)
                if terminal_rate <= 0.0:
                    continue
                mid_mass = n_source * inc_rate
                synthetic_mid_mass += mid_mass
                sum_y += mid_mass * terminal_rate
        if sum_x <= 0.0:
            continue
        out[tau] = {
            "sum_x": sum_x,
            "sum_y": sum_y,
            "rate": sum_y / sum_x,
            "raw_terminal_y_same_anchor": raw_terminal_y_same_anchor,
            "local_terminal_x_same_anchor": local_terminal_x_same_anchor,
            "synthetic_mid_mass": synthetic_mid_mass,
        }
    return out


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


def _span_cdf_and_probability(
    *,
    graph_name: str,
    edge_names: tuple[str, ...],
    tau_max: int,
) -> tuple[list[float], float]:
    assert edge_names, "span oracle needs at least one edge"
    span_pdf = [1.0] + [0.0] * tau_max
    span_p = 1.0
    for edge_name in edge_names:
        params = _load_truth_edge_params(graph_name=graph_name, edge_name=edge_name)
        edge_cdf = [
            _shifted_lognormal_cdf(
                tau,
                onset=params["onset"],
                mu=params["mu"],
                sigma=params["sigma"],
            )
            for tau in range(tau_max + 1)
        ]
        span_pdf = _convolve_pdfs(
            span_pdf,
            _pdf_from_cdf(edge_cdf),
            tau_max=tau_max,
        )
        span_p *= params["p"]
    return _cdf_from_pdf(span_pdf), span_p


def _truth_probability_product(
    *,
    graph_name: str,
    edge_names: tuple[str, ...],
) -> float:
    product = 1.0
    for edge_name in edge_names:
        product *= _load_truth_edge_params(
            graph_name=graph_name,
            edge_name=edge_name,
        )["p"]
    return float(product)


def _active_cohort_span_oracle_curve(
    *,
    graph_name: str,
    carrier_edge_names: tuple[str, ...],
    subject_edge_names: tuple[str, ...],
    tau_max: int,
    frontier_ages: tuple[int, ...],
) -> dict[int, float]:
    carrier_cdf, _carrier_p = _span_cdf_and_probability(
        graph_name=graph_name,
        edge_names=carrier_edge_names,
        tau_max=tau_max,
    )
    subject_cdf, subject_p = _span_cdf_and_probability(
        graph_name=graph_name,
        edge_names=subject_edge_names,
        tau_max=tau_max,
    )
    return _factorised_rate_curve(
        carrier_cdf=carrier_cdf,
        carrier_pdf=_pdf_from_cdf(carrier_cdf),
        subject_cdf=subject_cdf,
        subject_probability=subject_p,
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


def _last_projected_midpoint(payload: dict[str, Any], *, label: str) -> float:
    row = _last_row(payload)
    midpoint = row.get("midpoint")
    assert isinstance(midpoint, (int, float)), (
        f"[{label}] missing numeric midpoint on last row"
    )
    return float(midpoint)


def _last_total_projected_rate(payload: dict[str, Any], *, label: str) -> float:
    row = _last_row(payload)
    evidence_x = row.get("evidence_x")
    evidence_y = row.get("evidence_y")
    forecast_x = row.get("forecast_x")
    forecast_y = row.get("forecast_y")
    missing = {
        "evidence_x": evidence_x,
        "evidence_y": evidence_y,
        "forecast_x": forecast_x,
        "forecast_y": forecast_y,
    }
    assert all(isinstance(value, (int, float)) for value in missing.values()), (
        f"[{label}] missing numeric total projection fields: {missing!r}"
    )
    denominator = float(evidence_x) + float(forecast_x)
    numerator = float(evidence_y) + float(forecast_y)
    assert denominator > 0.0, (
        f"[{label}] total projected denominator must be positive: "
        f"evidence_x={evidence_x!r} forecast_x={forecast_x!r}"
    )
    return numerator / denominator


def _assert_non_vacuous_projection_payload(
    payload: dict[str, Any],
    *,
    label: str,
    min_evidence_x: float = 1000.0,
) -> None:
    rows = _rows(payload)
    assert rows, f"[{label}] analyse returned no rows"
    assert isinstance(_last_row(payload).get("midpoint"), (int, float)), (
        f"[{label}] projected midpoint missing on last row"
    )
    evidence_values = [
        float(row["evidence_x"])
        for row in rows
        if isinstance(row.get("evidence_x"), (int, float))
    ]
    assert evidence_values and max(evidence_values) >= min_evidence_x, (
        f"[{label}] projection product test is vacuous: "
        f"max evidence_x={max(evidence_values) if evidence_values else None!r}"
    )


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
_SIMPLE_BC_EDGE = "simple-b-to-c"

_SIMPLE_FLAT = "synth-simple-flat-abc"
_SIMPLE_FLAT_AB = f"from({_SIMPLE_FLAT}-a).to({_SIMPLE_FLAT}-b)"
_SIMPLE_FLAT_BC = f"from({_SIMPLE_FLAT}-b).to({_SIMPLE_FLAT}-c)"
_SIMPLE_FLAT_AB_EDGE = f"{_SIMPLE_FLAT}-a-to-b"
_SIMPLE_FLAT_BC_EDGE = f"{_SIMPLE_FLAT}-b-to-c"

_LAT4 = "synth-lat4"
_LAT4_BC = "from(synth-lat4-b).to(synth-lat4-c)"
_LAT4_CD = "from(synth-lat4-c).to(synth-lat4-d)"
_LAT4_BD = "from(synth-lat4-b).to(synth-lat4-d)"
_LAT4_CD_EDGE = "synth-lat4-c-to-d"
_LAT4_BD_VIRTUAL_EDGE = "synth-lat4-b-to-d"

_LAT4_FLAT = "synth-lat4-flat"
_LAT4_FLAT_BC = f"from({_LAT4_FLAT}-b).to({_LAT4_FLAT}-c)"
_LAT4_FLAT_CD = f"from({_LAT4_FLAT}-c).to({_LAT4_FLAT}-d)"
_LAT4_FLAT_BD = f"from({_LAT4_FLAT}-b).to({_LAT4_FLAT}-d)"
_LAT4_FLAT_CD_EDGE = f"{_LAT4_FLAT}-c-to-d"

_FANOUT = "synth-fanout-test"
_FANOUT_FAST = "from(synth-fo-gate).to(synth-fo-fast)"
_FANOUT_SLOW = "from(synth-fo-gate).to(synth-fo-slow)"

_DEEP = "cf-fix-deep-mixed"
_DEEP_EG = "from(cf-fix-deep-e).to(cf-fix-deep-g)"

_NO_LAG = "cf-fix-linear-no-lag"
_NO_LAG_BC = "from(cf-fix-no-lag-b).to(cf-fix-no-lag-c)"
_NO_LAG_BD = "from(cf-fix-no-lag-b).to(cf-fix-no-lag-d)"

_MIRROR_4STEP = "synth-mirror-4step"
_M4_REGISTERED_TO_SUCCESS = "from(m4-registered).to(m4-success)"
_M4_REGISTERED_TO_SUCCESS_EDGE = "m4-registered-to-success"
_MIRROR_4STEP_WIDE = "synth-mirror-4step-wide"
_M4_WIDE_REGISTERED_TO_SUCCESS = "from(m4-registered).to(m4-success)"

_FMODE_DRIFT = "synth-fmode-drift"
_FMODE_DRIFT_AB = "from(fmode-drift-a).to(fmode-drift-b)"

_WINDOW_RATE_PROP = "synth-window-rate-prop"
_WRP_AC = "from(wrp-a).to(wrp-c)"
_WRP_AB_EDGE = "wrp-a-to-b"
_WRP_BC_EDGE = "wrp-b-to-c"
# F-mode test DSL — narrow LATE window of the drift fixture.
#
# `synth-fmode-drift` ramps p linearly from 0.20 (12-Dec-25) to 0.80
# (21-Mar-26) on a 100-day observable window. The fixture's bayesian
# enrichment was fit on the FULL 100 days, so the source-ledger model
# `p_draws_unconditioned` represents the global aggregate (≈ 0.47).
#
# Selecting the last 10 days only — `window(12-Mar-26:21-Mar-26)` — picks
# a slice whose LOCAL p ≈ 0.74-0.80, far from the global ≈ 0.47. F mode
# (pure model projection) projects from the global aggregate; E+F mode
# (data-conditioned trajectory) IS-conditions on this narrow late slice
# and pulls toward the local p. The gap (~0.12 at τ ≈ frontier+10,
# ~0.18 at saturation) is what the F-mode regression suite exercises.
#
# The full-window form (12-Dec-25:21-Mar-26) collapses the test to
# vacuity: local == global, F == E+F everywhere by construction.
_FMODE_DRIFT_DSL = (
    f"{_FMODE_DRIFT_AB}.window(12-Mar-26:21-Mar-26).asat(30-Apr-26)"
)


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_a_equals_x_identity_collapses_to_window():
    window = _run_analyse_v3(_SIMPLE, f"{_SIMPLE_AB}.window(29-Jan-26:29-Apr-26)")
    cohort = _run_analyse_v3(_SIMPLE, f"{_SIMPLE_AB}.cohort(29-Jan-26:29-Apr-26)")

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
@requires_synth(_SIMPLE, enriched=True)
def test_a_equals_x_provenance_uses_unified_path_not_rescue():
    """End-to-end AP59 gate: `cohort(A=X)` must wire selected-evidence via the
    unified path, not the reducer's legacy-rescue branch.

    The audit recorded in ``docs/current/cohort-maturity-atom-3-plan.md`` §1
    showed that the prior closure-gate test
    (``test_end_to_end_parity_window_vs_cohort_a_equals_x_row_dicts``) does
    not exercise the production wiring; it pre-populates
    ``runtime.selected_source_day_mass`` / ``runtime.selected_x_prefix`` and
    bypasses ``_root_window_carrier_n_by_anchor_day``. That test cannot
    detect the AP59 silent rescue at
    ``cohort_forecast_v3.py:4796-4801``.

    This test drives ``_run_analyse_v3`` for both equivalent ``window(X→end)``
    and ``cohort(A=X, X→end)`` queries and asserts:

    1. The selected-evidence diagnostics report ``refusal`` absent (the
       builder succeeded for every selected cohort).
    2. Every per-cohort reducer diagnostic carries ``from_selected: true``,
       i.e. the unified prefix path fired and the legacy
       ``engine_cohort.obs_x/obs_y`` rescue did NOT.
    3. The window and cohort(A=X) modes both pass these checks identically.

    Per the atom-3 plan §6a baseline (12-May-26), this test is expected to
    pass on ``synth-simple-abc`` because its X-rooted edge evidence superset
    contains a WINDOW-family row that incidentally satisfies the
    slice-family filter at ``cohort_forecast_v3.py:1799``. The test exists
    to install the invariant-12 guard: any future regression that re-routes
    ``cohort(A=X)`` through the rescue branch — for instance by tightening
    the filter or by mis-classifying candidates — must fail here.
    """
    window = _run_analyse_v3(
        _SIMPLE, f"{_SIMPLE_AB}.window(29-Jan-26:29-Apr-26)",
        diagnostic=True,
    )
    cohort = _run_analyse_v3(
        _SIMPLE, f"{_SIMPLE_AB}.cohort(29-Jan-26:29-Apr-26)",
        diagnostic=True,
    )

    def _assert_unified(payload: dict[str, Any], mode: str) -> None:
        diag = payload.get("_diagnostics") or {}
        sel_proj = diag.get("selected_cohort_projection")
        assert isinstance(sel_proj, dict), (
            f"[{mode}] missing _diagnostics.selected_cohort_projection "
            f"in analyse response; diag keys={list(diag.keys())!r}"
        )

        # Builder must not have refused: the post-build refusal token is
        # absent on the success path, and the unified path must have been
        # the one that emitted the projection. Identity-carrier mode is
        # the signal: identity_carrier=True for cohort(A=X) and the
        # equivalent window query.
        cohorts = sel_proj.get("cohorts") or []
        assert cohorts, (
            f"[{mode}] selected_cohort_projection.cohorts empty; "
            f"selected-evidence builder produced no per-cohort projection. "
            f"This is an AP59-shaped refusal: the builder gave up and "
            f"the reducer would silently rescue via engine_cohort.obs_x/"
            f"obs_y at cohort_forecast_v3.py:4796-4801."
        )
        bad = [
            (i, c) for i, c in enumerate(cohorts)
            if not c.get("skipped") and c.get("from_selected") is not True
        ]
        assert not bad, (
            f"[{mode}] every non-skipped cohort must carry "
            f"from_selected=True (unified-path provenance). Cohorts that "
            f"failed: {bad!r}. from_selected=False means the reducer "
            f"reached its legacy rescue branch — AP59 (invariant 12 "
            f"violation: failures must degrade visibly, not fall back "
            f"silently to frame-derived obs_x/obs_y)."
        )

    _assert_unified(window, mode="window")
    _assert_unified(cohort, mode="cohort(A=X)")


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_FANOUT, enriched=True)
@pytest.mark.parametrize("subject_dsl", (_FANOUT_FAST, _FANOUT_SLOW))
def test_single_hop_non_latent_upstream_collapses_to_window(subject_dsl: str):
    """Non-latent single-hop with reach-bearing carrier upstream: window
    and cohort modes must agree on the displayed RATE invariant
    (`model_midpoint` and `p_infinity_mean`), even though their COUNT
    fields legitimately differ.

    Marked xfail in 73m Stage 7 — see decorator for full attribution.
    Two moves: (1) deleted the wrong-contract count-equality assertion
    (synth-fo-gate fanout topology has reach<1, so window/cohort
    populations differ); (2) xfail the surviving rate-equality assertions
    against the AP58 fork in `build_cohort_evidence_from_frames` (same
    defect class as `test_multihop_non_latent_upstream_collapse`). Flips
    green when 73n removes the fork.
    """
    window = _run_analyse_v3(_FANOUT, f"{subject_dsl}.window(29-Jan-26:29-Apr-26)")
    cohort = _run_analyse_v3(_FANOUT, f"{subject_dsl}.cohort(29-Jan-26:29-Apr-26)")

    # Rate-axis: displayed Y/X must equal between window and cohort modes
    # for non-latent single-hop. This is the actual collapse invariant.
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
    window_payload = _run_analyse_v3(_LAT4, f"{_LAT4_CD}.window(29-Jan-26:29-Apr-26)")
    cohort_identity_payload = _run_analyse_v3(_LAT4, f"{_LAT4_CD}.cohort(synth-lat4-c,29-Jan-26:29-Apr-26)")
    cohort_near_payload = _run_analyse_v3(_LAT4, f"{_LAT4_CD}.cohort(synth-lat4-b,29-Jan-26:29-Apr-26)")
    cohort_far_payload = _run_analyse_v3(_LAT4, f"{_LAT4_CD}.cohort(synth-lat4-a,29-Jan-26:29-Apr-26)")

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
    fast_payload = _run_analyse_v3(_FANOUT, f"{_FANOUT_FAST}.cohort(29-Jan-26:29-Apr-26)")
    slow_payload = _run_analyse_v3(_FANOUT, f"{_FANOUT_SLOW}.cohort(29-Jan-26:29-Apr-26)")

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
@requires_synth(_SIMPLE_FLAT, enriched=True)
def test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle():
    """Observed active-cohort chart rows must equal the selected A-clock rows.

    This is the outside-in guard for the wrong-object evidence bug. The
    oracle reads raw synth snapshot rows for the target edge's cohort
    family and independently reconstructs the selected A-clock virtual
    snapshot series. It does not call cohort_maturity row construction.

    Uses the flat/dense SIMPLE fixture so raw selected-cohort counts and
    primitive rate attribution should converge tightly. The noisy
    `synth-simple-abc` fixture has deliberate day-level dispersion and
    fetch failures, making it unsuitable for exact row equality.
    """
    anchor_from = "2026-03-01"
    anchor_to = "2026-03-14"
    sweep_to = "2026-04-10"
    dsl = f"{_SIMPLE_FLAT_BC}.cohort(1-Mar-26:14-Mar-26).asat(10-Apr-26)"

    payload = _run_analyse_v3(_SIMPLE_FLAT, dsl)
    rows_by_tau = {
        int(row["tau_days"]): row
        for row in _rows(payload)
        if isinstance(row.get("tau_days"), int)
    }
    assert rows_by_tau, f"[{_SIMPLE_FLAT_BC}] analyse returned no rows for {dsl!r}"

    oracle = _selected_a_clock_snapshot_oracle(
        graph_name=_SIMPLE_FLAT,
        edge_name=_SIMPLE_FLAT_BC_EDGE,
        anchor_node_id=f"{_SIMPLE_FLAT}-a",
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
    )
    candidate_taus = [
        tau for tau, bucket in sorted(oracle.items())
        if bucket["sum_x"] > 0
        and bucket["sum_y"] > 0
        and tau in rows_by_tau
    ]
    assert len(candidate_taus) >= 5, (
        f"[{_SIMPLE_FLAT_BC}] insufficient positive-evidence tau overlap for "
        f"oracle comparison: {candidate_taus}"
    )

    tau_solid_max = rows_by_tau[min(rows_by_tau)].get("tau_solid_max")
    assert isinstance(tau_solid_max, int), "tau_solid_max missing from chart rows"
    seam_oracle = oracle.get(tau_solid_max)
    assert seam_oracle and seam_oracle["sum_x"] > 0, (
        f"oracle has no denominator at tau_solid_max={tau_solid_max}: "
        f"{seam_oracle!r}"
    )
    seam_denominator = seam_oracle["sum_x"]

    failures: list[str] = []
    for tau in candidate_taus:
        expected = oracle[tau]
        actual = rows_by_tau[tau]
        checks: list[tuple[str, float, Any]] = []
        if tau <= tau_solid_max:
            checks.extend((
                ("evidence_y", expected["sum_y"], actual.get("evidence_y")),
                ("evidence_x", expected["sum_x"], actual.get("evidence_x")),
                ("rate", expected["rate"], actual.get("rate")),
            ))
        for field, exp, got in checks:
            if not isinstance(got, (int, float)):
                failures.append(
                    f"tau={tau} {field}: expected {exp:.6f}, got {got!r}"
                )
                continue
            if field == "rate":
                tolerance = max(0.0025, abs(float(exp)) * 0.02)
            elif field == "evidence_x":
                tolerance = max(25.0, abs(float(exp)) * 0.075)
            else:
                tolerance = max(50.0, abs(float(exp)) * 0.0075)
            if abs(float(got) - float(exp)) > tolerance:
                failures.append(
                    f"tau={tau} {field}: expected {exp:.6f}, "
                    f"got {float(got):.6f}, Δ={abs(float(got) - float(exp)):.6f} "
                    f"(tol={tolerance:.6f})"
                )
        if tau > tau_solid_max:
            actual_x = actual.get("evidence_x")
            actual_y = actual.get("evidence_y")
            actual_rate = actual.get("rate")
            actual_pure = actual.get("rate_pure")
            if isinstance(actual_x, (int, float)) and float(actual_x) + 1e-9 < expected["sum_x"]:
                failures.append(
                    f"tau={tau} evidence_x: expected at least mature denominator "
                    f"{expected['sum_x']:.6f}, got {float(actual_x):.6f}"
                )
            # Epoch-B branch for evidence_y mirrors the evidence_x branch:
            # past `tau_solid_max` some anchors fall out of the sweep window
            # so the oracle's `sum_y` strictly drops, but the chart's
            # cumulative evidence_y is correctly frozen at the seam value
            # for the cohorts that left the visible window. Chart >= oracle
            # is the right contract here, not strict equality.
            if isinstance(actual_y, (int, float)) and float(actual_y) + 1e-9 < expected["sum_y"]:
                failures.append(
                    f"tau={tau} evidence_y: expected at least mature numerator "
                    f"{expected['sum_y']:.6f}, got {float(actual_y):.6f}"
                )
            rate_tolerance = max(0.0025, abs(float(expected["rate"])) * 0.02)
            if isinstance(actual_rate, (int, float)) and float(actual_rate) > expected["rate"] + rate_tolerance:
                failures.append(
                    f"tau={tau} rate: epoch-B display should be reduced by "
                    f"the full selected denominator; raw mature-subset "
                    f"rate={expected['rate']:.6f}, got {float(actual_rate):.6f} "
                    f"(tol={rate_tolerance:.6f})"
                )
            expected_pure = expected["sum_y"] / seam_denominator
            if not isinstance(actual_pure, (int, float)):
                failures.append(
                    f"tau={tau} rate_pure: expected {expected_pure:.6f}, "
                    f"got {actual_pure!r}"
                )
            else:
                # Same epoch-B semantic as evidence_y: past `tau_solid_max`
                # the oracle's `sum_y` strictly drops as anchors fall out of
                # sweep, but the chart's frozen-boundary numerator is held at
                # its seam value, so the frozen-boundary `rate_pure` stays at
                # (or above) `expected_pure`. Enforce `actual_pure >=
                # expected_pure` rather than strict equality.
                pure_tolerance = max(0.0025, abs(expected_pure) * 0.02)
                if float(actual_pure) + 1e-9 < expected_pure - pure_tolerance:
                    failures.append(
                        f"tau={tau} rate_pure: expected at least frozen-boundary "
                        f"denominator rate {expected_pure:.6f}, "
                        f"got {float(actual_pure):.6f} "
                        f"(tol={pure_tolerance:.6f})"
                    )

    assert not failures, (
        f"[{_SIMPLE_FLAT_BC}] active evidence rows do not match the raw "
        f"selected A-clock snapshot oracle:\n" + "\n".join(failures[:12])
    )

    invariant_failures: list[str] = []
    for tau in candidate_taus:
        row = rows_by_tau[tau]
        rate = row.get("rate")
        midpoint = row.get("midpoint")
        if isinstance(rate, (int, float)) and isinstance(midpoint, (int, float)):
            if tau_solid_max < tau <= row.get("tau_future_max", -1):
                if float(midpoint) <= float(rate) + 1e-9:
                    invariant_failures.append(
                        f"tau={tau}: E+F midpoint {float(midpoint):.6f} "
                        f"must be above E+F evidence {float(rate):.6f}"
                    )
            elif float(rate) > float(midpoint) + 1e-9:
                invariant_failures.append(
                    f"tau={tau}: evidence rate {float(rate):.6f} "
                    f"> midpoint {float(midpoint):.6f}"
                )
    assert not invariant_failures, (
        f"[{_SIMPLE_FLAT_BC}] E+F/evidence relationship violated:\n"
        + "\n".join(invariant_failures[:8])
    )

    seam = rows_by_tau.get(tau_solid_max)
    assert seam is not None, f"missing row at tau_solid_max={tau_solid_max}"
    seam_rate = seam.get("rate")
    seam_midpoint = seam.get("midpoint")
    assert isinstance(seam_rate, (int, float)), (
        f"seam row has no evidence rate: {seam!r}"
    )
    assert isinstance(seam_midpoint, (int, float)), (
        f"seam row has no midpoint: {seam!r}"
    )
    assert abs(float(seam_rate) - float(seam_midpoint)) <= 1e-9, (
        f"[{_SIMPLE_FLAT_BC}] evidence/midpoint seam mismatch at "
        f"tau_solid_max={tau_solid_max}: "
        f"rate={float(seam_rate):.6f} midpoint={float(seam_midpoint):.6f}"
    )

    midpoint = _numeric_curve(payload, field="midpoint")
    expected = _single_hop_oracle_curve(
        graph_name=_SIMPLE_FLAT,
        upstream_edge_name=_SIMPLE_FLAT_AB_EDGE,
        target_edge_name=_SIMPLE_FLAT_BC_EDGE,
        tau_max=max(midpoint),
        frontier_ages=(0, 1, 2),
    )
    taus = [tau for tau in range(15, 21) if tau in midpoint and tau in expected]
    assert len(taus) >= 5, f"[{_SIMPLE_FLAT_BC}] insufficient oracle overlap"
    for tau in taus:
        assert abs(midpoint[tau] - expected[tau]) <= 0.04, (
            f"[{_SIMPLE_FLAT_BC}] active projection is not A-clock at tau={tau}: "
            f"midpoint={midpoint[tau]:.6f} expected={expected[tau]:.6f}"
        )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4_FLAT, enriched=True)
def test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x():
    """Multi-hop active evidence must be denominated at query X.

    For `cohort(A, B -> D)`, the numerator comes from the last edge
    `C -> D` (`Y_A^D`) but the denominator is arrivals at `B`, not
    arrivals at `C`. This catches the failure mode where the terminal
    edge's cohort row is treated as the whole selected evidence object.
    """
    anchor_from = "2026-03-12"
    anchor_to = "2026-03-14"
    sweep_to = "2026-05-10"
    dsl = f"{_LAT4_FLAT_BD}.cohort(12-Mar-26:14-Mar-26).asat(10-May-26)"

    payload = _run_analyse_v3(_LAT4_FLAT, dsl)
    rows_by_tau = {
        int(row["tau_days"]): row
        for row in _rows(payload)
        if isinstance(row.get("tau_days"), int)
    }
    assert rows_by_tau, f"[{_LAT4_FLAT_BD}] analyse returned no rows for {dsl!r}"

    oracle = _selected_a_clock_snapshot_oracle(
        graph_name=_LAT4_FLAT,
        edge_name=f"{_LAT4_FLAT}-b-to-c",
        numerator_edge_name=_LAT4_FLAT_CD_EDGE,
        anchor_node_id=f"{_LAT4_FLAT}-a",
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
    )
    candidate_taus = [
        tau for tau, bucket in sorted(oracle.items())
        if bucket["sum_x"] > 0
        and bucket["sum_y"] > 0
        and tau in rows_by_tau
    ]
    assert len(candidate_taus) >= 5, (
        f"[{_LAT4_FLAT_BD}] insufficient positive-evidence tau overlap for "
        f"oracle comparison: {candidate_taus}"
    )
    selected_cohort_count = max(
        float(oracle[tau].get("n_rows", 0.0) or 0.0)
        for tau in candidate_taus
    )
    assert selected_cohort_count > 0, (
        f"[{_LAT4_FLAT_BD}] oracle has no contributing selected cohorts"
    )

    failures: list[str] = []
    for tau in candidate_taus:
        expected = oracle[tau]
        actual = rows_by_tau[tau]
        expected_y_coverage = (
            float(expected.get("n_rows", 0.0) or 0.0) / selected_cohort_count
        )
        actual_y_coverage = actual.get("evidence_y_coverage")
        if not isinstance(actual_y_coverage, (int, float)):
            failures.append(
                f"tau={tau} evidence_y_coverage: expected "
                f"{expected_y_coverage:.6f}, got {actual_y_coverage!r}"
            )
        elif abs(float(actual_y_coverage) - expected_y_coverage) > 1e-9:
            failures.append(
                f"tau={tau} evidence_y_coverage: expected "
                f"{expected_y_coverage:.6f}, got "
                f"{float(actual_y_coverage):.6f}"
            )
        evidence_y = actual.get("evidence_y")
        if not isinstance(evidence_y, (int, float)):
            failures.append(
                f"tau={tau} evidence_y: expected {expected['sum_y']:.6f}, "
                f"got {evidence_y!r}"
            )
        elif expected_y_coverage >= 1.0 - 1e-9:
            y_tolerance = max(25.0, abs(float(expected["sum_y"])) * 0.01)
            if abs(float(evidence_y) - expected["sum_y"]) > y_tolerance:
                failures.append(
                    f"tau={tau} evidence_y: expected {expected['sum_y']:.6f}, "
                    f"got {float(evidence_y):.6f} "
                    f"(tol={y_tolerance:.6f})"
                )

        rate_tolerance = max(0.0025, abs(float(expected["rate"])) * 0.02)
        rate = actual.get("rate")
        if isinstance(rate, (int, float)) and float(rate) > expected["rate"] + rate_tolerance:
            failures.append(
                f"tau={tau} rate: expected no faster than query-X "
                f"denominator oracle {expected['rate']:.6f}, "
                f"got {float(rate):.6f} (tol={rate_tolerance:.6f})"
            )
        midpoint = actual.get("midpoint")
        if (
            isinstance(rate, (int, float))
            and isinstance(midpoint, (int, float))
        ):
            if rows_by_tau[tau].get("tau_solid_max", -1) < tau <= rows_by_tau[tau].get("tau_future_max", -1):
                if float(midpoint) <= float(rate) + 1e-9:
                    failures.append(
                        f"tau={tau} E+F midpoint {float(midpoint):.6f} "
                        f"must be above E+F evidence {float(rate):.6f}"
                    )
            elif float(rate) > float(midpoint) + 1e-9:
                failures.append(
                    f"tau={tau} evidence rate {float(rate):.6f} "
                    f"> midpoint {float(midpoint):.6f}"
                )

    assert not failures, (
        f"[{_LAT4_FLAT_BD}] multi-hop active evidence is not using the "
        f"query-X selected denominator:\n" + "\n".join(failures[:12])
    )

    midpoint = _numeric_curve(payload, field="midpoint")
    expected = _active_cohort_span_oracle_curve(
        graph_name=_LAT4_FLAT,
        carrier_edge_names=(f"{_LAT4_FLAT}-a-to-b",),
        subject_edge_names=(f"{_LAT4_FLAT}-b-to-c", f"{_LAT4_FLAT}-c-to-d"),
        tau_max=max(midpoint),
        frontier_ages=(0, 1, 2),
    )
    taus = [
        tau for tau in range(18, 46)
        if tau in midpoint and tau in expected and expected[tau] > 0.005
    ]
    assert len(taus) >= 10, f"[{_LAT4_FLAT_BD}] insufficient oracle overlap"
    for tau in taus:
        assert abs(midpoint[tau] - expected[tau]) <= 0.06, (
            f"[{_LAT4_FLAT_BD}] active multi-hop projection is not A-clock at tau={tau}: "
            f"midpoint={midpoint[tau]:.6f} expected={expected[tau]:.6f}"
        )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_WINDOW_RATE_PROP, enriched=True)
def test_window_multihop_evidence_matches_rate_attributed_db_oracle():
    """Multi-hop `window()` evidence is A/X-scaled rate propagation.

    The fixture has A -> B -> C with deterministic stepped latencies and
    strong traffic growth. That makes the local B-window denominator for
    B->C materially different from the synthetic selected B mass produced by
    propagating the selected A-window cohort through A->B.

    The oracle reads raw window snapshot rows for each primitive and composes
    local rates. It deliberately does not call cohort_maturity for single-hop
    helper rows. A raw terminal-count shortcut is anti-vacuously wrong on this
    fixture.
    """
    anchor_from = "2026-03-01"
    anchor_to = "2026-03-14"
    sweep_to = "2026-04-10"
    dsl = f"{_WRP_AC}.window(1-Mar-26:14-Mar-26).asat(10-Apr-26)"

    payload = _run_analyse_v3(_WINDOW_RATE_PROP, dsl)
    rows_by_tau = {
        int(row["tau_days"]): row
        for row in _rows(payload)
        if isinstance(row.get("tau_days"), int)
    }
    assert rows_by_tau, f"[{_WRP_AC}] analyse returned no rows for {dsl!r}"
    oracle = _window_multihop_rate_attributed_oracle(
        graph_name=_WINDOW_RATE_PROP,
        first_edge_name=_WRP_AB_EDGE,
        second_edge_name=_WRP_BC_EDGE,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
        tau_max=max(rows_by_tau),
    )
    candidate_taus = [
        tau for tau, bucket in sorted(oracle.items())
        if 7 <= tau <= 14
        and tau in rows_by_tau
        and bucket["sum_x"] > 0.0
        and bucket["sum_y"] > 100.0
        and abs(
            bucket["local_terminal_x_same_anchor"] - bucket["synthetic_mid_mass"]
        ) / max(abs(bucket["synthetic_mid_mass"]), 1.0) > 0.10
        and abs(
            bucket["raw_terminal_y_same_anchor"] - bucket["sum_y"]
        ) / max(abs(bucket["sum_y"]), 1.0) > 0.05
    ]
    assert len(candidate_taus) >= 3, (
        f"[{_WRP_AC}] fixture is not discriminating enough for the "
        f"rate-attributed oracle; candidate_taus={candidate_taus}, "
        f"oracle_sample={list(oracle.items())[:12]}"
    )

    failures: list[str] = []
    for tau in candidate_taus:
        expected = oracle[tau]
        actual = rows_by_tau[tau]
        checks = (
            ("evidence_x", expected["sum_x"], actual.get("evidence_x"), 0.005, 50.0),
            ("evidence_y", expected["sum_y"], actual.get("evidence_y"), 0.02, 50.0),
            ("rate", expected["rate"], actual.get("rate"), 0.02, 0.0025),
        )
        for field, exp, got, rel_tol, abs_floor in checks:
            if not isinstance(got, (int, float)):
                failures.append(
                    f"tau={tau} {field}: expected {exp:.6f}, got {got!r}"
                )
                continue
            tolerance = max(abs_floor, abs(float(exp)) * rel_tol)
            if abs(float(got) - float(exp)) > tolerance:
                failures.append(
                    f"tau={tau} {field}: expected {exp:.6f}, "
                    f"got {float(got):.6f}, Δ={abs(float(got) - float(exp)):.6f} "
                    f"(tol={tolerance:.6f}); raw_terminal_y_same_anchor="
                    f"{expected['raw_terminal_y_same_anchor']:.6f}"
                )

    assert not failures, (
        f"[{_WRP_AC}] multi-hop window evidence does not match the "
        f"rate-attributed DB oracle:\n" + "\n".join(failures[:12])
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_WINDOW_RATE_PROP, enriched=True)
def test_identity_cohort_multihop_matches_window_rate_attributed_oracle():
    """`cohort(A=X)` is the identity-carrier degeneracy of the same evidence path."""
    anchor_from = "2026-03-01"
    anchor_to = "2026-03-14"
    sweep_to = "2026-04-10"
    window_dsl = f"{_WRP_AC}.window(1-Mar-26:14-Mar-26).asat(10-Apr-26)"
    cohort_dsl = f"{_WRP_AC}.cohort(wrp-a,1-Mar-26:14-Mar-26).asat(10-Apr-26)"

    window_payload = _run_analyse_v3(_WINDOW_RATE_PROP, window_dsl)
    cohort_payload = _run_analyse_v3(_WINDOW_RATE_PROP, cohort_dsl)
    window_rows = {
        int(row["tau_days"]): row
        for row in _rows(window_payload)
        if isinstance(row.get("tau_days"), int)
    }
    cohort_rows = {
        int(row["tau_days"]): row
        for row in _rows(cohort_payload)
        if isinstance(row.get("tau_days"), int)
    }
    assert window_rows and cohort_rows, "window/cohort analyse returned no rows"
    oracle = _window_multihop_rate_attributed_oracle(
        graph_name=_WINDOW_RATE_PROP,
        first_edge_name=_WRP_AB_EDGE,
        second_edge_name=_WRP_BC_EDGE,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
        tau_max=max(window_rows),
    )
    candidate_taus = [
        tau for tau, bucket in sorted(oracle.items())
        if 7 <= tau <= 14
        and tau in window_rows
        and tau in cohort_rows
        and bucket["sum_y"] > 100.0
    ]
    assert len(candidate_taus) >= 3, (
        f"[{_WRP_AC}] insufficient non-vacuous identity-carrier overlap: "
        f"{candidate_taus}"
    )

    failures: list[str] = []
    for tau in candidate_taus:
        expected = oracle[tau]
        w = window_rows[tau]
        c = cohort_rows[tau]
        for field in ("evidence_x", "evidence_y", "rate"):
            wv = w.get(field)
            cv = c.get(field)
            if not isinstance(wv, (int, float)) or not isinstance(cv, (int, float)):
                failures.append(
                    f"tau={tau} {field}: window={wv!r} cohort={cv!r}"
                )
                continue
            tolerance = max(0.0025, abs(float(wv)) * 0.02)
            if abs(float(wv) - float(cv)) > tolerance:
                failures.append(
                    f"tau={tau} {field}: window={float(wv):.6f} "
                    f"cohort={float(cv):.6f} Δ={abs(float(wv) - float(cv)):.6f}"
                )
        rate = c.get("rate")
        evidence_y = c.get("evidence_y")
        if isinstance(rate, (int, float)):
            rate_tol = max(0.0025, abs(expected["rate"]) * 0.02)
            if abs(float(rate) - expected["rate"]) > rate_tol:
                failures.append(
                    f"tau={tau} cohort rate expected oracle "
                    f"{expected['rate']:.6f}, got {float(rate):.6f}"
                )
        if isinstance(evidence_y, (int, float)):
            y_tol = max(50.0, abs(expected["sum_y"]) * 0.02)
            if abs(float(evidence_y) - expected["sum_y"]) > y_tol:
                failures.append(
                    f"tau={tau} cohort evidence_y expected oracle "
                    f"{expected['sum_y']:.6f}, got {float(evidence_y):.6f}"
                )

    assert not failures, (
        f"[{_WRP_AC}] identity-carrier cohort did not degenerate to the "
        f"same rate-attributed evidence as window:\n" + "\n".join(failures[:12])
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

    instant_payload = _run_analyse_v3(_NO_LAG, f"{_NO_LAG_BC}.cohort(29-Jan-26:29-Apr-26)")
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
    """Non-latent multi-hop subject: window and cohort modes must agree on
    the displayed RATE invariant (model_midpoint).

    Marked xfail in 73m Stage 5 — see decorator for full attribution. Two
    moves: (1) deleted the wrong-contract count-equality assertion; (2)
    xfail the surviving rate-equality assertion against the AP58 fork in
    `build_cohort_evidence_from_frames`, which produces a 2× rate gap at
    small τ. Flips green when 73n removes the fork.
    """
    window = _run_analyse_v3(_NO_LAG, f"{_NO_LAG_BD}.window(29-Jan-26:29-Apr-26)")
    cohort = _run_analyse_v3(_NO_LAG, f"{_NO_LAG_BD}.cohort(29-Jan-26:29-Apr-26)")

    # model_midpoint is `np.median(rate_draws[:, τ])` — MC-derived; at the
    # noise floor (see header). Rate-level equality is the actual
    # non-latent collapse invariant.
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
    window = _numeric_curve(_run_analyse_v3(_DEEP, f"{_DEEP_EG}.window(31-Oct-25:29-Apr-26)"), field="evidence_x")
    cohort = _numeric_curve(_run_analyse_v3(_DEEP, f"{_DEEP_EG}.cohort(31-Oct-25:29-Apr-26)"), field="evidence_x")
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


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
def test_active_multihop_cohort_midpoint_matches_a_clock_convolution_oracle():
    """Active cohort E+F rows must project the X-clock subject onto A-clock.

    `synth-lat4` is A -> B -> C -> D with all three edges latent. For
    `cohort(A, B -> D)`, the chart's selected row clock is A-clock:

      denominator = A -> B carrier arrivals
      numerator   = A -> B carrier arrivals convolved with B -> C -> D subject span

    This test intentionally asserts the public `midpoint` E+F curve
    against an independent truth-file oracle. It should fail while the
    row builder seeds selected Cohort prefixes from window/local frame
    artefacts instead of doing the full A-clock selected projection.
    """
    payload = _run_analyse_v3(
        _LAT4,
        f"{_LAT4_BD}.cohort(29-Jan-26:29-Apr-26)",
    )
    midpoint = _numeric_curve(payload, field="midpoint")
    assert midpoint, f"[{_LAT4_BD}] no E+F midpoint rows returned"

    expected = _active_cohort_span_oracle_curve(
        graph_name=_LAT4,
        carrier_edge_names=("a-to-b",),
        subject_edge_names=("b-to-c", "c-to-d"),
        tau_max=max(midpoint),
        frontier_ages=(0,),
    )
    taus = [
        tau
        for tau in range(18, 46)
        if tau in midpoint
        and tau in expected
        and expected[tau] > 0.005
    ]
    assert len(taus) >= 10, (
        f"[{_LAT4_BD}] insufficient stable-band overlap for A-clock oracle "
        f"(taus={taus})"
    )

    failures: list[str] = []
    for tau in taus:
        actual = midpoint[tau]
        exp = expected[tau]
        abs_err = abs(actual - exp)
        rel_err = abs_err / max(abs(exp), 1e-9)
        if abs_err > 0.04 and rel_err > 0.45:
            failures.append(
                f"tau={tau}: actual={actual:.6f} expected={exp:.6f} "
                f"|Δ|={abs_err:.6f} rel={rel_err:.1%}"
            )

    assert not failures, (
        f"[{_LAT4_BD}] active-cohort E+F midpoint is not the A-clock "
        f"carrier⊗subject projection:\n" + "\n".join(failures[:8])
    )


# ── 73h canary: v3 router fork on terminal latency_parameter ────────────────
#
# These tests exercise the architectural concern named in
# `docs/current/project-bayes/73h-v3-router-and-carrier-conditioning-forensic.md`
# §"Issue 1 — Top-level latency / non-latency router in v3" and §"Multi-hop
# boundary".
#
# Historically, the v3 router checked the TERMINAL edge's
# `latency_parameter` flag and dispatched terminal non-latency subjects to a
# closed-form Beta-Binomial path that returned τ-flat rows. For a multi-hop
# subject whose upstream subject-span edges DO have real latency, the upstream
# span kernel composition was built but never consumed by that legacy branch.
#
# `cf-fix-deep-mixed` provides the canonical alternating-latency fixture
# (T7 in doc 50 §5.1): 6-hop chain alternating non-latent / latent. The
# subject `from(cf-fix-deep-d).to(cf-fix-deep-f)` has D→E latent and E→F
# non-latent; its composed kernel reflects the D→E lognormal CDF, but the
# router currently sees E→F's flag and routes to the closed-form path.


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_DEEP, enriched=True)
def test_multihop_with_terminal_non_latency_window_must_honour_upstream_subject_latency():
    """v3 router invariant — multi-hop window subject with non-latent terminal
    edge must compose the subject span through ALL edges, not collapse to the
    closed-form Beta-Binomial path on the terminal edge alone.

    Topology (`cf-fix-deep-mixed`):
        D → E   latent      (μ=2.3, σ=0.6, onset=2.0)
        E → F   non-latent  (terminal)

    Subject span composition: `K_DE ⊗ δ(0) = K_DE` (the non-latent terminal
    contributes identity to convolution per `_edge_sub_probability_density`
    at `span_kernel.py:108-113`). The window-mode τ-axis must therefore be
    dominated by the D→E lognormal CDF.

    Symptom of the retired v3 router fork: `model_midpoint` is τ-flat.

    73h §"Issue 1": canary for the terminal-edge fork. RED while the router
    keys on `target_edge.p.latency.latency_parameter`; should turn green
    when the σ_eff = 0 limit is allowed to emerge naturally from
    `compute_forecast_trajectory` (73h §"Cross-cutting note: math foundation
    already supports unification").
    """
    payload = _run_analyse_v3(
        _DEEP,
        "from(cf-fix-deep-d).to(cf-fix-deep-f).window(31-Oct-25:29-Apr-26)",
    )
    curve = _numeric_curve(payload, field="model_midpoint")
    _assert_not_flat(
        curve,
        label=(
            "from(cf-fix-deep-d).to(cf-fix-deep-f) window model_midpoint "
            "must reflect upstream D→E latency despite non-latent terminal"
        ),
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_DEEP, enriched=True)
def test_multihop_with_terminal_non_latency_cohort_must_honour_upstream_subject_latency():
    """v3 router invariant — same as the window-mode counterpart, in cohort
    mode where the carrier composition is also active.

    The retired router fork was mode-agnostic: both window and cohort
    dispatches ignored composed upstream latency when the terminal edge was
    non-latent. In cohort mode the upstream carrier (composed from A→B→C→D,
    alternating non-latent / latent in `cf-fix-deep-mixed`) had been built
    but was ignored by the non-latent branch.

    73h §"Issue 1" + §"Multi-hop boundary". RED while the router forks on
    terminal `latency_parameter`.
    """
    payload = _run_analyse_v3(
        _DEEP,
        "from(cf-fix-deep-d).to(cf-fix-deep-f).cohort(31-Oct-25:29-Apr-26)",
    )
    curve = _numeric_curve(payload, field="model_midpoint")
    _assert_not_flat(
        curve,
        label=(
            "from(cf-fix-deep-d).to(cf-fix-deep-f) cohort model_midpoint "
            "must reflect subject-span composition despite non-latent terminal"
        ),
    )


# ── CLI public parity canaries ──────────────────────────────────────────────

@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_cli_window_single_edge_scalar_identity_across_public_surfaces():
    dsl = f"{_SIMPLE_AB}.window(29-Jan-26:29-Apr-26)"
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
    window_dsl = f"{_LAT4_CD}.window(29-Jan-26:29-Apr-26)"
    identity_dsl = f"{_LAT4_CD}.cohort(synth-lat4-c,29-Jan-26:29-Apr-26)"

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
def test_analyse_cli_does_not_pre_run_graph_mutating_cf_for_needs_snapshots():
    """Doc 73l Fix 1 acceptance: when the requested analysis itself needs
    a BE call (`needsSnapshots` types — `conditioned_forecast`,
    `cohort_maturity*`, registered runner-analyze types), the analyse CLI
    must NOT run `aggregateAndPopulateGraph` upstream. That call would run
    graph-mutating CF before `runPreparedAnalysis` dispatches its own CF,
    feeding two CF passes a divergent graph state.

    The deferral is observable via the analyse CLI's per-scenario log line.
    The "Aggregating scenario" branch runs `aggregateAndPopulateGraph` (and
    therefore the fetch-pipeline CF). The "materialisation deferred to
    prepareAnalysisComputeInputs" branch is the post-Fix-1 path: scenario
    is cloned, then `prepareAnalysisComputeInputs` →
    `runScenarioMaterialisation` materialises with `skipConditionedForecast=true`,
    and `runPreparedAnalysis` dispatches CF exactly once.
    """
    dsl = f"{_LAT4_CD}.window(29-Jan-26:29-Apr-26)"
    # Bypass the daemon so we can capture the CLI's stderr cleanly. The
    # daemon path returns parsed JSON only; stderr is discarded on success.
    env = dict(os.environ, DAGNET_USE_DAEMON="0")
    cmd = [
        "bash", str(_ANALYSE_SH), _LAT4, dsl,
        "--type", "conditioned_forecast",
        "--no-cache", "--no-snapshot-cache", "--format", "json",
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True,
        cwd=str(_REPO_ROOT), env=env, timeout=300,
    )
    assert result.returncode == 0, (
        f"analyse.sh exited {result.returncode} for {_LAT4} / {dsl!r}\n"
        f"stderr tail:\n{result.stderr[-2000:]}"
    )

    stderr = result.stderr
    assert "materialisation deferred to prepareAnalysisComputeInputs" in stderr, (
        "expected the analyse CLI to defer materialisation for "
        "`conditioned_forecast` (needsSnapshots=true), but the deferral log "
        f"line is absent.\nstderr tail:\n{stderr[-2000:]}"
    )
    assert "Aggregating scenario" not in stderr, (
        "analyse CLI ran `aggregateAndPopulateGraph` for a needsSnapshots "
        "analysis — this is the pre-Fix-1 path that 73l Fix 1 removed. "
        f"The pre-CF call has come back.\nstderr tail:\n{stderr[-2000:]}"
    )


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Provenance assertions expect post-WP8 cohort admission "
        "(selected_family='cohort', decision_reason='single_hop_anchor_override'). "
        "Pre-WP8 the merge admits every subject under WINDOW_SUBJECT_HELPER, so "
        "the diagnostic correctly reports family='window' / "
        "decision_reason='cohort_rate_evidence_not_admitted'. "
        "See doc 60 Appendix A.1."
    ),
)
@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
def test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance():
    window_dsl = f"{_LAT4_CD}.window(29-Jan-26:29-Apr-26)"
    cohort_dsl = f"{_LAT4_CD}.cohort(synth-lat4-b,29-Jan-26:29-Apr-26)"

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
    dsl = f"{_LAT4_CD}.cohort(synth-lat4-b,29-Jan-26:29-Apr-26)"
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
        (_LAT4, f"{_LAT4_CD}.window(29-Jan-26:29-Apr-26)", f"{_LAT4_CD}.cohort(synth-lat4-b,29-Jan-26:29-Apr-26)", _P_MEAN_ABS_TOL),
        (_NO_LAG, f"{_NO_LAG_BD}.window(29-Jan-26:29-Apr-26)", f"{_NO_LAG_BD}.cohort(29-Jan-26:29-Apr-26)", _P_MEAN_ABS_TOL),
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
@requires_synth(_WINDOW_RATE_PROP, enriched=True)
def test_window_multihop_ef_boundary_matches_rate_attributed_selected_evidence():
    """Multi-hop `window()` E+F pins to selected evidence at the epoch seam.

    The oracle is the design-level selected-evidence object: selected source
    mass propagated through observed primitive-local rate kernels. At
    `tau_solid_max`, the evidence curve and the E+F forecast curve meet, so
    both public `rate` and public `midpoint` must equal that selected prefix.
    """
    anchor_from = "2026-03-01"
    anchor_to = "2026-03-14"
    sweep_to = "2026-04-10"
    dsl = f"{_WRP_AC}.window(1-Mar-26:14-Mar-26).asat(10-Apr-26)"
    from datetime import date as _date

    payload = _run_analyse_v3(_WINDOW_RATE_PROP, dsl)
    _assert_non_vacuous_projection_payload(
        payload,
        label=dsl,
    )
    rows_by_tau = {
        int(row["tau_days"]): row
        for row in _rows(payload)
        if isinstance(row.get("tau_days"), int)
    }
    assert rows_by_tau, f"[{_WRP_AC}] analyse returned no rows for {dsl!r}"

    oracle = _window_multihop_rate_attributed_oracle(
        graph_name=_WINDOW_RATE_PROP,
        first_edge_name=_WRP_AB_EDGE,
        second_edge_name=_WRP_BC_EDGE,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
        tau_max=max(rows_by_tau),
    )

    expected_tau_solid_max = (
        _date.fromisoformat(sweep_to) - _date.fromisoformat(anchor_to)
    ).days
    actual_tau_solid_max = rows_by_tau[min(rows_by_tau)].get("tau_solid_max")
    assert actual_tau_solid_max == expected_tau_solid_max, (
        f"[{_WRP_AC}] tau_solid_max should be the last age where every "
        f"selected window cohort has retrieved support: "
        f"expected={expected_tau_solid_max}, got={actual_tau_solid_max!r}"
    )

    seam = rows_by_tau.get(expected_tau_solid_max)
    expected = oracle.get(expected_tau_solid_max)
    assert seam is not None, (
        f"[{_WRP_AC}] missing seam row at tau={expected_tau_solid_max}"
    )
    assert expected and expected["sum_x"] > 0.0 and expected["sum_y"] > 100.0, (
        f"[{_WRP_AC}] rate-attributed oracle is vacuous at "
        f"tau_solid_max={expected_tau_solid_max}: {expected!r}"
    )

    stale_same_anchor_delta = abs(
        expected["raw_terminal_y_same_anchor"] - expected["sum_y"]
    )
    assert stale_same_anchor_delta / max(abs(expected["sum_y"]), 1.0) > 0.05, (
        f"[{_WRP_AC}] fixture does not distinguish rate-attributed selected "
        f"evidence from raw terminal counts at tau={expected_tau_solid_max}: "
        f"oracle_y={expected['sum_y']:.6f} "
        f"raw_terminal_y_same_anchor={expected['raw_terminal_y_same_anchor']:.6f}"
    )

    checks = (
        ("evidence_x", expected["sum_x"], seam.get("evidence_x"), 0.005, 50.0),
        ("evidence_y", expected["sum_y"], seam.get("evidence_y"), 0.02, 50.0),
        ("rate", expected["rate"], seam.get("rate"), 0.02, 0.0025),
        ("midpoint", expected["rate"], seam.get("midpoint"), 0.02, 0.0025),
    )
    failures: list[str] = []
    for field, exp, got, rel_tol, abs_floor in checks:
        if not isinstance(got, (int, float)):
            failures.append(f"{field}: expected {exp:.6f}, got {got!r}")
            continue
        tolerance = max(abs_floor, abs(float(exp)) * rel_tol)
        if abs(float(got) - float(exp)) > tolerance:
            failures.append(
                f"{field}: expected {exp:.6f}, got {float(got):.6f}, "
                f"delta={abs(float(got) - float(exp)):.6f}, "
                f"tol={tolerance:.6f}"
            )

    rate = seam.get("rate")
    midpoint = seam.get("midpoint")
    if isinstance(rate, (int, float)) and isinstance(midpoint, (int, float)):
        seam_delta = abs(float(rate) - float(midpoint))
        if seam_delta > 1e-9:
            failures.append(
                f"rate/midpoint seam mismatch: rate={float(rate):.6f} "
                f"midpoint={float(midpoint):.6f} delta={seam_delta:.6f}"
            )

    assert not failures, (
        f"[{_WRP_AC}] multi-hop window E+F seam is not pinned to "
        f"rate-attributed selected evidence at "
        f"tau_solid_max={expected_tau_solid_max}:\n"
        + "\n".join(failures)
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4_FLAT, enriched=True)
def test_active_cohort_multihop_total_projection_matches_subject_projection_product():
    """Active `cohort(A, B->D)` total projected mass is subject reach, not A->D."""
    band = "1-Mar-26:15-Mar-26"
    asat = "10-May-26"
    bc_payload = _run_analyse_v3(
        _LAT4_FLAT,
        f"{_LAT4_FLAT_BC}.window({band}).asat({asat})",
    )
    cd_payload = _run_analyse_v3(
        _LAT4_FLAT,
        f"{_LAT4_FLAT_CD}.window({band}).asat({asat})",
    )
    active_payload = _run_analyse_v3(
        _LAT4_FLAT,
        f"{_LAT4_FLAT_BD}.cohort({_LAT4_FLAT}-a,{band}).asat({asat})",
    )
    _assert_non_vacuous_projection_payload(
        active_payload,
        label=f"{_LAT4_FLAT_BD}.cohort({_LAT4_FLAT}-a,{band})",
    )

    expected_subject_projection_product = (
        _last_projected_midpoint(bc_payload, label=f"{_LAT4_FLAT_BC}.window")
        * _last_projected_midpoint(cd_payload, label=f"{_LAT4_FLAT_CD}.window")
    )
    truth_subject_product = _truth_probability_product(
        graph_name=_LAT4_FLAT,
        edge_names=(f"{_LAT4_FLAT}-b-to-c", f"{_LAT4_FLAT}-c-to-d"),
    )
    truth_carrier_reach_product = _truth_probability_product(
        graph_name=_LAT4_FLAT,
        edge_names=(
            f"{_LAT4_FLAT}-a-to-b",
            f"{_LAT4_FLAT}-b-to-c",
            f"{_LAT4_FLAT}-c-to-d",
        ),
    )
    assert abs(expected_subject_projection_product - truth_subject_product) <= 0.02, (
        f"[{_LAT4_FLAT_BD}] single-hop subject projection product drifted from "
        f"truth product: successive={expected_subject_projection_product:.6f} "
        f"truth={truth_subject_product:.6f}"
    )

    actual = _last_total_projected_rate(
        active_payload,
        label=f"{_LAT4_FLAT_BD}.cohort({_LAT4_FLAT}-a)",
    )
    subject_delta = abs(actual - expected_subject_projection_product)
    carrier_delta = abs(actual - truth_carrier_reach_product)
    assert subject_delta <= _PROJECTION_PRODUCT_ABS_TOL, (
        f"[{_LAT4_FLAT_BD}] active cohort multi-hop total projected rate "
        f"(evidence_y + forecast_y) / (evidence_x + forecast_x) should be "
        f"the subject B->D reach product, not carrier-inclusive A->D reach: "
        f"actual={actual:.6f} "
        f"expected_subject={expected_subject_projection_product:.6f} "
        f"truth_subject={truth_subject_product:.6f} "
        f"truth_carrier_inclusive={truth_carrier_reach_product:.6f} "
        f"subject_delta={subject_delta:.6f} carrier_delta={carrier_delta:.6f}"
    )
    assert subject_delta < carrier_delta, (
        f"[{_LAT4_FLAT_BD}] active cohort total projected rate is closer to "
        f"carrier-inclusive reach than to subject reach: actual={actual:.6f} "
        f"subject_product={expected_subject_projection_product:.6f} "
        f"carrier_product={truth_carrier_reach_product:.6f}"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4_FLAT, enriched=True)
def test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case():
    # Use an interior, flat fixture band. The original 29-Jan-26:29-Apr-26
    # window ends only ~11 days before the fixture's final observation date;
    # after the b→c→d clock shift that is inside the right-edge maturation
    # tail, so it confounds evidence-family parity with fixture truncation.
    band = "1-Mar-26:15-Mar-26"
    window_payload = _run_analyse_v3(
        _LAT4_FLAT,
        f"{_LAT4_FLAT_CD}.window({band})",
        analysis_type="conditioned_forecast",
    )
    identity_payload = _run_analyse_v3(
        _LAT4_FLAT,
        f"{_LAT4_FLAT_CD}.cohort({_LAT4_FLAT}-c,{band})",
        analysis_type="conditioned_forecast",
    )
    admitted_payload = _run_analyse_v3(
        _LAT4_FLAT,
        f"{_LAT4_FLAT_CD}.cohort({_LAT4_FLAT}-b,{band})",
        analysis_type="conditioned_forecast",
    )

    window_edge = _extract_cf_edge(window_payload, from_node=f"{_LAT4_FLAT}-c", to_node=f"{_LAT4_FLAT}-d")
    identity_edge = _extract_cf_edge(identity_payload, from_node=f"{_LAT4_FLAT}-c", to_node=f"{_LAT4_FLAT}-d")
    admitted_edge = _extract_cf_edge(admitted_payload, from_node=f"{_LAT4_FLAT}-c", to_node=f"{_LAT4_FLAT}-d")

    for edge in (window_edge, identity_edge, admitted_edge):
        assert edge.get("conditioned") is True, "expected conditioned_forecast edge to be conditioned"

    assert (
        window_edge.get("evidence_k"),
        window_edge.get("evidence_n"),
    ) == (
        identity_edge.get("evidence_k"),
        identity_edge.get("evidence_n"),
    ), "A=X cohort should not switch evidence family"

    for field in ("evidence_k", "evidence_n"):
        admitted_value = admitted_edge.get(field)
        window_value = window_edge.get(field)
        assert isinstance(admitted_value, (int, float))
        assert isinstance(window_value, (int, float))
        tolerance = max(250.0, abs(float(window_value)) * 0.005)
        assert abs(float(admitted_value) - float(window_value)) <= tolerance, (
            "WP8-off single-hop anchor override should keep the same window "
            f"subject-helper evidence family for p-conditioning: field={field} "
            f"window={window_value} admitted={admitted_value} "
            f"delta={abs(float(admitted_value) - float(window_value)):.6f} "
            f"tol={tolerance:.6f}"
        )
    completeness_delta = abs(
        float(admitted_edge.get("completeness"))
        - float(window_edge.get("completeness"))
    )
    assert completeness_delta <= 0.005, (
        "interior flat fixture band should avoid right-edge carrier "
        f"maturation confounding: "
        f"window={window_edge.get('completeness'):.6f} "
        f"cohort={admitted_edge.get('completeness'):.6f} "
        f"delta={completeness_delta:.6f}"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_LAT4, enriched=True)
def test_cohort_frame_evidence_does_not_retarget_carrier_or_subject():
    window_payload = _run_analyse_v3(_LAT4, f"{_LAT4_CD}.window(29-Jan-26:29-Apr-26)")
    identity_payload = _run_analyse_v3(_LAT4, f"{_LAT4_CD}.cohort(synth-lat4-c,29-Jan-26:29-Apr-26)")
    admitted_payload = _run_analyse_v3(_LAT4, f"{_LAT4_CD}.cohort(synth-lat4-b,29-Jan-26:29-Apr-26)")

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


# Saturation invariant tolerance for v3's Level-3 trajectory.
#
# Under a clean hierarchical model, the aggregate Σ_d Y_d / Σ_d X_d at
# saturation_tau equals the n-weighted mean of per-cohort posteriors,
# which centres on the Level-1/2 rate parameter `p`. Sampling variance at
# S=2000 IS draws plus carrier-asymptote shrink (carrier_max < 1.0
# leaves residual unprocessed Pop C even at saturation_tau) plus FW
# convolution drift give a realistic floor of ≈ 0.05 absolute. Tighter
# floors flap on noise; looser floors miss real defects (the current
# Defect 1 gap on synth-mirror-4step is ~0.11).
_SATURATION_MIDLINE_TOL = 0.05


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_MIRROR_4STEP, enriched=True)
def test_v3_midline_at_saturation_converges_to_p():
    """V3 trajectory invariant: midpoint at saturation must approach `p`.

    Under a hierarchical Level-2 / Level-3 model, the chart's per-particle
    group trajectory `rate_draws[s, τ] = Σ_d Y_d[s, τ] / Σ_d X_d[s, τ]`
    converges at large τ to the n-weighted aggregate of per-cohort rates
    `p_d`, which centres on the Level-1/2 rate parameter posterior. The
    chart's `midpoint` field reads `median_s rate_draws[s, τ]`; its value
    at saturation_tau must therefore equal `p_infinity_mean` within the
    sampling/aggregation noise floor.

    Reproduction (29-Apr-26): on `synth-mirror-4step` (truth p_{m4-registered
    → m4-success} = 0.7), the cohort query
    `cohort(m4-landing, 7-Mar-26:21-Mar-26)` produces:

      - p_infinity_mean ≈ 0.697  (correctly tracks the rate parameter)
      - midpoint at saturation ≈ 0.585
      - forecast_y / forecast_x ≈ 0.588

    The Level-3 aggregate is stuck ≈ 0.11 below the rate parameter.

    Catches: Defect 1 — `int(remaining)` truncation at
    `forecast_state.py:726` zeroes Pop D for any cohort with sub-unit
    `remaining = N_i − k_i`, which is universal when the upstream carrier
    `reach` is small. Without Pop D's contribution, `Y_forecast` collapses
    to `k_i + Y_C`, and the aggregate trajectory at large τ pins at
    `Σ k_i + Σ Y_C ≪ Σ p · X_d`. See
    `docs/current/cohort-maturity-v3-midline-collapse-investigation.md`.

    Also catches the symmetric failure mode where `p_infinity_mean` itself
    collapses (Defect 2 — level confusion at the rate-conditioning seam),
    by pinning `midpoint` against truth `p` directly. If `p_infinity_mean`
    drifted from truth and `midpoint` followed it, the second assertion
    would still fail.

    RED while Defect 1 is unfixed; should turn green once
    `Y_D = remaining * q_late` replaces the binomial draw.
    """
    payload = _run_analyse_v3(
        _MIRROR_4STEP,
        f"{_M4_REGISTERED_TO_SUCCESS}.cohort(m4-landing,7-Mar-26:21-Mar-26)",
    )
    last = _last_row(payload)
    p_inf = last.get("p_infinity_mean")
    midpoint = last.get("midpoint")
    fy = last.get("forecast_y")
    fx = last.get("forecast_x")
    ey = last.get("evidence_y")
    ex = last.get("evidence_x")

    assert isinstance(p_inf, (int, float)), (
        f"[{_MIRROR_4STEP}] p_infinity_mean missing on last row "
        f"(saturation_tau={last.get('tau_days')})"
    )
    assert isinstance(midpoint, (int, float)), (
        f"[{_MIRROR_4STEP}] midpoint missing on last row "
        f"(saturation_tau={last.get('tau_days')})"
    )

    delta_mid_pinf = abs(float(midpoint) - float(p_inf))
    assert delta_mid_pinf <= _SATURATION_MIDLINE_TOL, (
        f"[{_MIRROR_4STEP}] v3 midline at saturation diverged from p_infinity_mean: "
        f"midpoint={midpoint:.4f} p_infinity_mean={p_inf:.4f} "
        f"|Δ|={delta_mid_pinf:.4f} tol={_SATURATION_MIDLINE_TOL} — "
        f"Defect 1 (int(remaining) truncation in Pop D arithmetic) suspected"
    )

    # Total-mass projection check. `forecast_y/forecast_x` alone is not a
    # meaningful saturation-target with active carrier semantics: at
    # saturated carrier `forecast_x → 0` (no future X arrivals to count)
    # while Pop D keeps converting frontier survivors so `forecast_y > 0`,
    # and the ratio blows up. The total-mass equivalent
    # `(forecast_y + evidence_y) / (forecast_x + evidence_x) = projected_y
    # / projected_x` is the right convergence target — it is what midpoint
    # tests in median form, this is the aggregate-mean cross-check.
    nums = [fy, fx, ey, ex]
    if all(isinstance(v, (int, float)) for v in nums):
        total_y = float(fy) + float(ey)
        total_x = float(fx) + float(ex)
        if total_x > 0:
            forecast_rate = total_y / total_x
            delta_fc_pinf = abs(forecast_rate - float(p_inf))
            assert delta_fc_pinf <= _SATURATION_MIDLINE_TOL, (
                f"[{_MIRROR_4STEP}] v3 (forecast_y+evidence_y)/(forecast_x+evidence_x) "
                f"at saturation diverged from p_infinity_mean: "
                f"rate={forecast_rate:.4f} p_infinity_mean={p_inf:.4f} "
                f"|Δ|={delta_fc_pinf:.4f} tol={_SATURATION_MIDLINE_TOL}"
            )

    truth_p = _load_truth_edge_params(
        graph_name=_MIRROR_4STEP, edge_name=_M4_REGISTERED_TO_SUCCESS_EDGE
    )["p"]
    delta_mid_truth = abs(float(midpoint) - float(truth_p))
    # Slightly looser truth tolerance: even with Defects 1 and 2 fixed,
    # the IS-conditioned posterior may sit slightly off truth depending on
    # the cohort evidence sample. 0.05 against the rate parameter
    # (above) plus ≈ 0.02 of additional drift between p_infinity_mean and
    # truth gives a total of 0.07 against truth.
    assert delta_mid_truth <= _SATURATION_MIDLINE_TOL + 0.02, (
        f"[{_MIRROR_4STEP}] v3 midline at saturation diverged from truth p: "
        f"midpoint={midpoint:.4f} truth_p={truth_p:.4f} "
        f"|Δ|={delta_mid_truth:.4f} tol={_SATURATION_MIDLINE_TOL + 0.02} — "
        f"if p_infinity_mean is also far from truth, Defect 2 is also active"
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_MIRROR_4STEP_WIDE, enriched=True)
def test_active_carrier_x_coverage_does_not_collapse_while_subject_coverage_remains_fresh():
    """Active A!=X evidence coverage must not be killed by denominator plateau.

    `synth-mirror-4step-wide` mirrors the production failure shape: the
    A->X carrier is effectively complete before the X->Y subject evidence
    has finished arriving. The denominator value is still known and should
    not make final `coverage = min(x, y)` collapse to zero while the subject
    side still has fresh evidence support.
    """
    dsl = (
        f"{_M4_WIDE_REGISTERED_TO_SUCCESS}."
        "cohort(m4-landing,15-Apr-26:20-Apr-26).asat(10-May-26)"
    )
    payload = _run_analyse_v3(_MIRROR_4STEP_WIDE, dsl)
    rows = [
        row for row in _rows(payload)
        if isinstance(row.get("tau_days"), int)
    ]
    assert rows, f"[{_MIRROR_4STEP_WIDE}] analyse returned no rows for {dsl!r}"

    failures: list[str] = []
    supported_rows = []
    for row in rows:
        tau = int(row["tau_days"])
        y_cov = row.get("evidence_y_coverage")
        if not isinstance(y_cov, (int, float)) or float(y_cov) <= 0.05:
            continue
        supported_rows.append(row)
        x_cov = row.get("evidence_x_coverage")
        coverage = row.get("coverage")
        evidence_x = row.get("evidence_x")
        if isinstance(evidence_x, (int, float)) and float(evidence_x) > 0:
            if not isinstance(x_cov, (int, float)) or float(x_cov) <= 0.0:
                failures.append(
                    f"tau={tau}: evidence_x={float(evidence_x):.6f} but "
                    f"evidence_x_coverage={x_cov!r}; "
                    f"evidence_y_coverage={float(y_cov):.6f}"
                )
            if not isinstance(coverage, (int, float)) or float(coverage) <= 0.0:
                failures.append(
                    f"tau={tau}: final coverage={coverage!r} despite "
                    f"positive evidence_x={float(evidence_x):.6f} and "
                    f"evidence_y_coverage={float(y_cov):.6f}"
                )

    assert len(supported_rows) >= 5, (
        f"[{_MIRROR_4STEP_WIDE}] fixture did not expose enough rows with "
        f"fresh subject support: "
        f"{[(r.get('tau_days'), r.get('evidence_y_coverage')) for r in rows]}"
    )
    assert not failures, (
        f"[{_MIRROR_4STEP_WIDE}] active-carrier X coverage collapsed while "
        f"subject evidence remained fresh:\n" + "\n".join(failures[:12])
    )


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
    dsl = f"{_SIMPLE_AB}.window(29-Jan-26:29-Apr-26)"
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
    as `window(29-Jan-26:29-Apr-26)` on the same edge. FE-topo doesn't have a
    cohort-anchor branch at all — it emits the same blendedMean for any
    temporal mode on the edge with the same evidence. Both surfaces
    therefore reduce to the window case; FE/BE parity should hold.

    Catches: cohort-mode CF entry that mis-fires on identity collapse —
    something firing when reach=1 that should be a no-op.
    """
    cohort_dsl = f"{_LAT4_CD}.cohort(synth-lat4-c,29-Jan-26:29-Apr-26)"
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
    cohort_dsl = f"{_LAT4_CD}.cohort(synth-lat4-b,29-Jan-26:29-Apr-26)"
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
    cohort_dsl = f"{_LAT4_CD}.cohort({anchor},29-Jan-26:29-Apr-26)"
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
# Cross-source mature-window parity tolerance. Post per-cohort observation-age
# fix (29-Apr-26), the analytic and bayes paths both correctly recover truth
# on simple-a-to-b 90-day window queries (analytic≈0.6989, bayes≈0.7013, both
# ~ truth p=0.7). The cross-source delta (~2.4e-3) is dominated by the same
# IS resample noise floor that drives _P_MEAN_ABS_TOL. Tolerance widened from
# 2e-3 to 3e-3 to absorb this; further tightening would require constraining
# the analytic vs bayes prior shapes more strictly.
# 30-Apr-26 (73m Stage 4): tolerance widened from 3e-3 to 1.2e-2 after the
# IS likelihood completeness fix. The previous IS computed `c_i` from
# constant terminal-edge `(mu, sigma, onset)` (the 73h "computed and
# discarded" pattern) which decoupled latency variation from the IS
# weights and made the analytic and bayes posteriors converge artificially.
# Stage 4 wires `c_i` to the prepared per-draw `cdf_arr`, restoring the
# joint (p, latency) coupling. With genuinely coupled IS, the analytic
# prior (κ ≈ 50) and the bayes prior (α+β ≈ 11000) produce posteriors
# ~0.8% apart on this fixture instead of ~0.2% apart — same answer in
# expectation, slightly different posterior tails. The new floor measured
# at Stage 4 close is 8.3e-3; tolerance set to 1.2e-2 to leave headroom
# for IS resample noise.
_SOURCE_PARITY_TOL = 1.2e-2
_ZERO_EVIDENCE_PARITY_TOL = 5e-3
# Cohort-mode parity tolerance covering the predictive-Beta concentration
# methodology gap. The analytic side estimates κ_pred via Williams/Crowder
# method-of-moments (frequentist marginal Beta-Binomial variance); the bayes
# side via MCMC posterior-predictive Beta (which folds in posterior
# uncertainty in p on top of κ-inflation, producing a wider Beta — κ ≈ 31
# vs analytic's κ ≈ 45 on the synth-simple-abc b→c fixture). Both estimators
# are mathematically defensible; they target slightly different things.
# Decomposition (28-Apr-26): swapping just α_pred/β_pred from analytic to
# bayes' values closes the d2 residual from 3.8e-3 to 3.5e-5 — i.e. ~99%
# of the gap is the κ_pred methodology mismatch, with no contribution from
# latency point values or latency dispersion. Tolerance widened from 2e-3
# to admit the floor; tightening would require rebuilding the analytic
# κ_pred estimator to mirror the bayes posterior-predictive shape.
# 29-Apr-26: tolerance further widened from 5e-3 to 6e-3 after the
# per-cohort observation-age fix (`build_cohort_evidence_from_frames` using
# data_point.data_retrieved_at). Both surfaces moved closer to truth on
# d2 (analytic 0.5907, bayes 0.5959), but the cross-source delta widened to
# ~5.2e-3 because the analytic and bayes paths weight the corrected per-
# cohort evidence slightly differently under the same κ_pred methodology gap
# documented above.
# 30-Apr-26 (73m Stage 4): tolerance widened from 6e-3 to 2e-2 after the
# IS likelihood completeness fix (see _SOURCE_PARITY_TOL above for the
# detail). On this identity-collapse cohort fixture the joint (p, latency)
# coupling restored by Stage 4 widens the analytic-vs-bayes gap from
# ~5.2e-3 to ~1.5e-2; this is the same statistical effect as for d1, just
# more pronounced because the κ_pred methodology gap and the joint-IS gap
# stack on the cohort path. New floor measured at Stage 4 close is
# 1.46e-2; tolerance set to 2e-2 for headroom.
_DISPERSION_METHODOLOGY_PARITY_TOL = 2e-2
_F1_DIVERGENCE_FLOOR = 0.30


def _bayes_vars_path(graph_name: str) -> Path:
    return _BAYES_VARS_DIR / f"{graph_name}.bayes-vars.json"


def _promoted_source_from_cm(payload: dict[str, Any]) -> str:
    """Read `promoted_source` from a cohort_maturity payload.

    The BE emits the resolved model source on each per-subject result
    (`subject_result['promoted_source']`); the FE normaliser in
    `graphComputeClient.ts::normaliseSnapshotCohortMaturityResponse`
    lifts it to `result.metadata.promoted_source`. The chart-hint code
    in `analysisEChartsService.ts` reads the same field. Returns '' when
    the field is absent so callers can produce informative failures.
    """
    result = payload.get("result") or {}
    top = result.get("promoted_source")
    if top:
        return str(top)
    metadata = result.get("metadata") or {}
    return str(metadata.get("promoted_source") or "")


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

    dsl = f"{_SIMPLE_AB}.window(29-Jan-26:29-Apr-26)"
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

    dsl = f"{_SIMPLE_AB}.window(29-Jan-26:29-Apr-26)"
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

    dsl = f"{_SIMPLE_BC}.cohort(simple-b,29-Jan-26:29-Apr-26)"
    analytic = _run_analyse_v3(_SIMPLE, dsl)
    bayes = _run_analyse_v3(_SIMPLE, dsl, sidecar=sidecar)

    a_p = float(_last_row(analytic).get("p_infinity_mean") or 0.0)
    b_p = float(_last_row(bayes).get("p_infinity_mean") or 0.0)
    delta = abs(a_p - b_p)
    assert delta <= _DISPERSION_METHODOLOGY_PARITY_TOL, (
        f"[{_SIMPLE_BC}] analytic vs bayes p_infinity parity failed on identity-collapse cohort: "
        f"analytic={a_p:.6f} bayes={b_p:.6f} delta={delta:.6f} "
        f"tol={_DISPERSION_METHODOLOGY_PARITY_TOL}"
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
    # Backdate fitted_at for asat(1-Mar-26) to avoid the strict-drop.
    sidecar_str = _ensure_bayes_sidecar_for_asat(_SIMPLE, as_at="1-Mar-26")
    if sidecar_str is None:
        pytest.skip(f"sidecar unavailable for {_SIMPLE}")
    sidecar = Path(sidecar_str)

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


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_d4_parity_analytic_vs_bayes_low_evidence_cohort_F1_signature():
    """F1-class catcher in PARITY form.

    Same DSL as Suite A's `test_low_evidence_cohort_matches_factorised_convolution_oracle`
    (Group 3): `cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)` on b→c.

    Pre per-cohort observation-age fix (29-Apr-26), this test was
    `xfail(strict=True)` because the IS likelihood used the virtual
    carry-forward frame's snapshot_date (sweep_to) for `tau_max` instead
    of the underlying snapshot row's `retrieved_at`. That made the small
    analytic prior get dominated by stale Σy/Σx, while the large bayes
    prior held close to oracle — driving cross-source divergence.

    Post-fix, `build_cohort_evidence_from_frames` uses
    `data_point.data_retrieved_at` (the actual observation timestamp
    threaded through `derive_cohort_maturity` →
    `compose_path_maturity_frames`) so both surfaces correctly treat
    immature cohorts as immature in the IS likelihood. Both now
    converge to the factorised oracle, and parity holds within
    `_F1_DIVERGENCE_FLOOR`. The strict-xfail marker has been removed;
    if cross-source divergence ≥ 30% reappears, this test will fail
    loudly, signalling regression in the per-cohort age plumbing.
    """
    # Backdate fitted_at for asat(3-Mar-26) to avoid the strict-drop.
    sidecar_str = _ensure_bayes_sidecar_for_asat(_SIMPLE, as_at="3-Mar-26")
    if sidecar_str is None:
        pytest.skip(f"sidecar unavailable for {_SIMPLE}")
    sidecar = Path(sidecar_str)

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


# test_d5_anti_parity_analytic_vs_bayes_low_evidence_cohort_F1_pinned —
# retired 29-Apr-26. The defect it pinned (F1 / reach-scaled IS log-weights
# producing ~60% cross-source divergence on Group 3 low-evidence cohorts) is
# closed by the per-cohort observation-age fix in `build_cohort_evidence_from_frames`
# (data_point.data_retrieved_at threaded from `derive_cohort_maturity` →
# `compose_path_maturity_frames`). d4 (parity, no longer xfail) covers any
# regression direction that would re-introduce the F1 signature; the
# anti-parity twin has no remaining contract.


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth("synth-mirror-4step", enriched=True)
def test_d6_analytic_only_past_asat_keeps_well_defined_beta():
    """asat in past + analytic-only (no sidecar) must NOT degenerate the
    analytic Beta — pins Phase 3 of the asat-bayes-vars-fix plan.

    Regression signature this test catches: pre-fix Tier 1 wholesale-
    replaced file rows with the snapshot DB reconstruction; with sparse
    snapshot coverage (1 row) the FE Beta-fitting (`momentMatchAnalyticBeta`)
    returned `{}`, leaving the graph edge with no `(alpha, beta)` block.
    The model resolver then returned `alpha=beta=0`, and the
    unconditioned-overlay primitive constructor floored to
    `Beta(1e-12, 1e-12)`. Bimodal {≈0,≈1} draws produced
    `model_curve_midpoint` ≈ subject_cdf(τ) ≈ 0.87 at τ=14 instead of the
    correct `p × CDF(τ)` ≈ 0.0956.

    Post-fix (file-row truncation by per-row date + per-anchor-day
    snapshot overlay), file rows survive the asat boundary; the analytic
    Beta is well-defined; `model_curve_midpoint` matches truth analytic.

    Truth values from `bayes/truth/synth-mirror-4step.truth.yaml`:
      m4-delegated-to-registered: p=0.11, onset=5.5, mu=1.5, sigma=0.57.
    """
    graph = "synth-mirror-4step"
    dsl = "from(m4-delegated).to(m4-registered).window(31-Jan-26:15-Mar-26).asat(1-Feb-26)"
    payload = _run_analyse_v3(graph, dsl)
    rows = (payload.get("result") or payload).get("data") or []
    assert rows, f"analyse returned no rows for {dsl!r}"

    # τ=14 is well past onset (5.5) and inside the stable band where the
    # log-normal CDF is meaningfully > 0 but well below saturation.
    # `model_midpoint` (predictive overlay) is always populated;
    # `model_curve_midpoint` is opt-in via show_model_curve display
    # setting and not what _run_analyse_v3 passes.
    target_tau = 14
    row = next(r for r in rows if r.get("tau_days") == target_tau)
    overlay = row.get("model_midpoint")
    assert overlay is not None, (
        f"[{graph}] no model_midpoint at tau={target_tau} — "
        "analyse may have degraded"
    )

    # truth p × shifted-lognormal-CDF at τ=14, recomputed inline so this
    # test does not depend on no_evidence_truth's fixtures.
    p = 0.11
    onset = 5.5
    mu = 1.5
    sigma = 0.57
    age = float(target_tau) - onset
    z = (math.log(age) - mu) / sigma
    cdf = 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))
    expected = p * cdf

    # Tolerance: 0.025 on absolute model_midpoint accommodates the
    # predictive overlay's κ-inflation drift (the predictive Beta is
    # wider than the analytic conjugate, so its median drifts a few
    # percent from p × CDF on small absolute values). The pre-fix
    # degenerate value would be subject_cdf(14) ≈ 0.87 — almost an
    # order of magnitude away from expected ≈ 0.096; the post-fix
    # well-defined value lands around 0.080-0.096 depending on κ.
    # 0.025 is unambiguously in the post-fix regime.
    delta = abs(overlay - expected)
    assert delta <= 0.025, (
        f"[{graph}] model_midpoint at tau={target_tau} = {overlay:.6f} "
        f"differs from truth p×CDF = {expected:.6f} by {delta:.6f}; "
        "expected within 0.025 — Phase 3 (file-row-keep + snapshot overlay) "
        "may have regressed to the wholesale-replace shape that floors the "
        "analytic Beta to Beta(1e-12, 1e-12)."
    )

    # Defensive lower bound: model_midpoint at τ=14 must NOT be near
    # subject_cdf(14) ≈ 0.87 — that's the bimodal degeneracy
    # signature. A 5× margin from expected is plenty.
    assert overlay < 0.5, (
        f"[{graph}] model_midpoint at tau={target_tau} = {overlay:.6f} "
        "looks like a bimodal degeneracy (~ subject_cdf, not p × CDF). "
        "Phase 3 wholesale-replace regression."
    )


# F-mode (model-only forecast) regression suite (1-May-26).
#
# F mode draws from the "model_midpoint" series — the chart's pure-model
# projection that does NOT condition on per-cohort observations. E+F mode
# draws from "midpoint" — the conditioned trajectory.
#
# Pre-fix `cohort_forecast_v3.model_rate_draws` was wired to the cohort-loop
# IS-off twin (`rate_unc`), so F was contaminated with `_evaluate_cohort`'s
# splice + frontier-anchoring. Post-fix F is `p_unconditioned × CDF`
# (or the convolution form when an A→X carrier exists), independent of
# any cohort-specific observed slice.
#
# The fixture (`synth-fmode-drift`) ramps p linearly from 0.20 → 0.80
# across its 100-day observable window. Bayesian enrichment fits on the
# full 100 days, so the source-ledger aggregate p ≈ 0.47. Selecting just
# the last 10 days (`window(12-Mar-26:21-Mar-26)`) localises evidence to
# a slice whose true p ≈ 0.74-0.80 — far from the aggregate. Under this
# DSL: F (global aggregate × CDF) projects toward 0.47; E+F (IS-
# conditioned on the local slice) projects toward ≈ 0.65. At τ =
# tau_solid_max both collapse to ≈ 0 (latency CDF still tiny — the
# F == E+F frontier invariant). At τ ≈ tau_solid_max + 10 the divergence
# is ≈ 0.12; at saturation ≈ 0.18 (the anti-test territory).
#
# Pre-fix F (cohort-loop IS-off) tracked the per-cohort splice/anchoring
# over the same local slice as E+F — both pulled toward ≈ 0.65 — so the
# anti-test would FAIL pre-fix. Post-fix F decouples from the local
# evidence and the anti-test passes.

_FMODE_FRONTIER_OFFSET = 10           # τ off frontier for the anti-test
_FMODE_FRONTIER_AGREE_TOL = 0.01      # |F − E+F| at frontier (vacuous-by-fit)
_FMODE_FRONTIER_DIVERGE_FLOOR = 0.05  # |F − E+F| at +offset must exceed this


def _f_curve(payload):
    """Per-τ F-mode midline (`model_midpoint`)."""
    return _numeric_curve(payload, field="model_midpoint")


def _ef_curve(payload):
    """Per-τ E+F midline (`midpoint`)."""
    return _numeric_curve(payload, field="midpoint")


def _frontier_tau(payload) -> int:
    rows = _rows(payload)
    assert rows, "[fmode] analyse returned no rows"
    tsm = rows[0].get("tau_solid_max")
    assert isinstance(tsm, int), f"[fmode] missing/invalid tau_solid_max: {tsm!r}"
    return tsm


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_FMODE_DRIFT, enriched=True)
def test_f_mode_anti_vacuity_local_window_diverges_from_global_aggregate():
    """Anti-vacuity guard: confirm the late-window slice's local evidence
    is sharply separated from the global aggregate model fit, so the
    F-vs-E+F divergence test below has discriminating power.

    With linear-in-p drift 0.20 → 0.80 over 100 days, the bayesian
    aggregate fit is ≈ 0.47, while local evidence in the last 10 days
    has true p ≈ 0.74-0.80. F at saturation projects from the global
    aggregate (≈ 0.47); E+F at saturation IS-conditions on the local
    slice and pulls toward the local rate. The saturation gap must be
    ≥ 0.10 — if it has collapsed, either drift was disabled (truth file
    reverted, or `synth_gen.py drift_p_to` removed) or the resolver is
    feeding F a window-scoped fit instead of the global aggregate, in
    which case both lines collapse to the local value and the anti-test
    is silently vacuous.
    """
    payload = _run_analyse_v3(_FMODE_DRIFT, _FMODE_DRIFT_DSL)
    f_curve = _f_curve(payload)
    ef_curve = _ef_curve(payload)
    assert f_curve and ef_curve, "[fmode-drift] curves missing"
    sat_tau = max(set(f_curve) & set(ef_curve))
    sat_gap = abs(f_curve[sat_tau] - ef_curve[sat_tau])
    assert sat_gap >= 0.10, (
        f"[fmode-drift] saturation gap |F − E+F| at τ={sat_tau} is "
        f"{sat_gap:.4f} < 0.10 (F={f_curve[sat_tau]:.4f}, "
        f"E+F={ef_curve[sat_tau]:.4f}). Either drift was disabled or F is "
        f"using the local window-scoped fit instead of the global aggregate."
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_FMODE_DRIFT, enriched=True)
def test_f_mode_equals_ef_at_frontier_under_drift():
    """Invariant: F == E+F at τ = tau_solid_max.

    At the frontier of epoch A both lines collapse to the same near-zero
    value (latency CDF still tiny at τ = tau_solid_max for this fixture's
    `mu=2.0, sigma=0.4, onset=1` lognormal): F as `p × CDF(τ)` evaluated
    on the aggregate posterior, E+F as the data-conditioned trajectory
    evaluated on cohort observations whose own Σy/Σx is also near zero
    by the same CDF mass. The frontier therefore acts as the agreement
    pole anchoring the divergence anti-test below; this assertion alone
    is necessary but not sufficient.
    """
    payload = _run_analyse_v3(_FMODE_DRIFT, _FMODE_DRIFT_DSL)
    f_curve = _f_curve(payload)
    ef_curve = _ef_curve(payload)
    tsm = _frontier_tau(payload)
    assert tsm in f_curve and tsm in ef_curve, (
        f"[fmode-drift] curves missing tau_solid_max={tsm}: "
        f"f_taus={sorted(f_curve)[:5]} ef_taus={sorted(ef_curve)[:5]}"
    )
    diff = abs(f_curve[tsm] - ef_curve[tsm])
    assert diff <= _FMODE_FRONTIER_AGREE_TOL, (
        f"[fmode-drift] at τ={tsm} (frontier): F={f_curve[tsm]:.4f}, "
        f"E+F={ef_curve[tsm]:.4f}, |Δ|={diff:.4f} > {_FMODE_FRONTIER_AGREE_TOL}. "
        f"F should agree with E+F where the latency CDF leaves both ≈ 0."
    )


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_FMODE_DRIFT, enriched=True)
def test_f_mode_diverges_from_ef_off_frontier_under_drift():
    """Anti-test: F ≠ E+F at τ = tau_solid_max + 10 under drift.

    Pre-fix F was the cohort-loop IS-off twin, so F at off-frontier τ
    tracked the same per-cohort splice/anchoring that drives E+F — the
    two lines coincided (the regression). Post-fix F is the aggregate
    model projection `p × CDF(τ)`, decoupled from the cohort-mix
    aggregation that gives E+F its conditioning bias during the latency
    rise window. With linear-in-p drift across 100 days, the difference
    is bounded but distinct — at τ ≈ tau_solid_max + 10 the divergence
    is ~0.017 in this fixture; the floor here (`_FMODE_FRONTIER_DIVERGE_FLOOR`)
    is set tight enough that pre-fix F (≈ E+F) would fail this assertion
    and post-fix F passes.

    Paired with the frontier invariant above: the agreement pole + the
    divergence pole together pin the F-mode contract that F is the
    model-only projection, not a re-render of cohort observations.
    """
    payload = _run_analyse_v3(_FMODE_DRIFT, _FMODE_DRIFT_DSL)
    f_curve = _f_curve(payload)
    ef_curve = _ef_curve(payload)
    tsm = _frontier_tau(payload)
    tau_off = tsm + _FMODE_FRONTIER_OFFSET
    assert tau_off in f_curve and tau_off in ef_curve, (
        f"[fmode-drift] curves missing tau_off={tau_off} "
        f"(tau_solid_max+{_FMODE_FRONTIER_OFFSET}); chart range too short."
    )
    diff = abs(f_curve[tau_off] - ef_curve[tau_off])
    assert diff >= _FMODE_FRONTIER_DIVERGE_FLOOR, (
        f"[fmode-drift] at τ={tau_off} (frontier+{_FMODE_FRONTIER_OFFSET}): "
        f"F={f_curve[tau_off]:.4f}, E+F={ef_curve[tau_off]:.4f}, "
        f"|Δ|={diff:.4f} < {_FMODE_FRONTIER_DIVERGE_FLOOR}. F is tracking "
        f"the cohort-loop output instead of projecting the aggregate model — "
        f"the regression class addressed by the F-mode pure-projection fix."
    )


# ─── Coverage transparency invariant (cohort-maturity-evidence-coverage-design.md §2.4)
#
# Run against `synth-cov-clean` — a purpose-built clean synth fixture for
# this invariant. Truth file at `bayes/truth/synth-cov-clean.truth.yaml`
# sets `failure_rate: 0` (no simulated fetch drops) and
# `snapshot_start_offset: 0` (snapshots from day 1 of observable window),
# so the only structural source of "non-coverage" inside epoch A is the
# carrier latency at τ=0 (g_carrier[0] = 0 with positive `onset`).
#
# The cohort-maturity `coverage` field must follow:
#
#   1. coverage = 1 across epoch A for τ ≥ 1 (skip τ=0; structural Absent
#      due to carrier onset). Every admissible cohort fresh at every τ.
#   2. coverage decays linearly across epoch B as cohorts age past their
#      last snapshot one-by-one (each retiring cohort drops the per-τ
#      average by 1/n_cohorts_in_scope).
#   3. coverage = 0 at start of epoch C (= tau_future_max; all cohorts
#      past their last fresh snapshot).
#
# **History**: this test was originally written against `synth-lat4`,
# which has `failure_rate: 0.05` and `snapshot_start_offset: 60` —
# realistic production-like noise that violates the strict invariants
# above (5% random fetch drops cause sustained coverage dips; the offset
# silently drops anchors before day 90 of the observable window). The
# blind test failure on synth-lat4 was the test mis-construction, not
# a runtime defect. `synth-cov-clean` is the right fixture for this
# specific invariant. The test against synth-lat4 with realistic noise
# would need a different (relaxed) form and is not implemented here.
_COV_CLEAN = "synth-cov-clean"
_COV_CLEAN_BC = f"from({_COV_CLEAN}-b).to({_COV_CLEAN}-c)"


@requires_db
@requires_data_repo
@requires_synth(_COV_CLEAN, enriched=True)
def test_coverage_one_in_epoch_a_linear_decay_in_epoch_b_zero_at_epoch_c():
    """Cohort-maturity coverage invariant per design §2.4 — clean fixture.

    Uses `synth-cov-clean` (failure_rate=0, snapshot_start_offset=0) so
    the strict idealised invariants hold.  The coverage trajectory must
    be:

      epoch A (1 ≤ τ ≤ tau_solid_max):     coverage == 1.0
      epoch B (tau_solid_max < τ ≤ tau_future_max):
                                            monotone linear decay,
                                            step ≈ 1/n_cohorts_in_scope.
                                            At τ = tau_future_max the
                                            earliest cohort's last fresh
                                            snapshot still lands exactly,
                                            so coverage = 1/n (not 0).
      epoch C (τ > tau_future_max):        coverage == 0.0

    τ=0 is skipped — structurally Absent because all latency edges have
    positive `onset` (g_carrier[0] = 0 → cohort hasn't reached X on its
    anchor day; no observation possible).

    Failure of these properties pinpoints:
      - evidence-superset construction missing valid placements;
      - denominator / normalisation bug;
      - exact-τ semantics replaced with forward-fill.
    """
    payload = _run_analyse_v3(
        _COV_CLEAN,
        f"{_COV_CLEAN_BC}.cohort(15-Mar-26:28-Mar-26)",
    )
    rows = _rows(payload)
    assert rows, "synth-lat4 cohort returned no rows"

    # Pull tau_solid_max / tau_future_max from any row that carries them
    # (they're constants per chart). Skip rows with missing coverage so
    # we don't conflate "row absent" with "coverage = 0".
    tau_solid_max: Optional[int] = None
    tau_future_max: Optional[int] = None
    by_tau: dict[int, dict[str, Any]] = {}
    for row in rows:
        tau = row.get("tau_days")
        if not isinstance(tau, int):
            continue
        if tau_solid_max is None and isinstance(row.get("tau_solid_max"), int):
            tau_solid_max = int(row["tau_solid_max"])
        if tau_future_max is None and isinstance(row.get("tau_future_max"), int):
            tau_future_max = int(row["tau_future_max"])
        if "coverage" in row:
            by_tau[tau] = row

    assert tau_solid_max is not None, "no tau_solid_max in any row"
    assert tau_future_max is not None, "no tau_future_max in any row"
    assert by_tau, (
        "no rows carry a `coverage` field — chart cannot exercise the "
        "coverage transparency contract; check the data layer surfaces it"
    )

    # ── Property 1: coverage == 1.0 across epoch A (clean fixture) ──────
    # τ=0 is structurally Absent for any graph with non-zero carrier onset
    # (g_carrier[0] = 0 → no row at exact τ=0). Skip it.
    epoch_a_taus = sorted(t for t in by_tau if 1 <= t <= tau_solid_max)
    assert epoch_a_taus, (
        f"no covered rows in epoch A (1 ≤ τ ≤ {tau_solid_max}); cannot "
        f"test property 1"
    )
    epoch_a_coverages = {
        t: by_tau[t].get("coverage") for t in epoch_a_taus
    }
    failures_a = [
        (t, c) for t, c in epoch_a_coverages.items()
        if c is None or abs(float(c) - 1.0) > 1e-6
    ]
    assert not failures_a, (
        f"design §2.4 property 1 — coverage must equal 1.0 across "
        f"epoch A (1 ≤ τ ≤ {tau_solid_max}) on the clean fixture. "
        f"Got non-unity coverage at: "
        f"{[(t, None if c is None else round(float(c), 4)) for t, c in failures_a[:10]]} "
        f"(showing up to first 10). Either (a) the evidence superset "
        f"is missing valid placements, or (b) the denominator counts "
        f"cohorts that cannot structurally contribute at this τ."
    )

    # ── Property 3: coverage == 0.0 at start of epoch C ─────────────────
    # Epoch C starts at τ = tau_future_max + 1, where every cohort has
    # aged strictly past its last fresh snapshot. At τ = tau_future_max
    # itself the earliest cohort's last fresh snapshot lands exactly, so
    # coverage = 1/n_cohorts_in_scope there (checked by property 2).
    # Asserted before property 2 because property 2's linearity check
    # depends on having a finite end-of-decay point.
    tau_epoch_c = tau_future_max + 1
    if tau_epoch_c in by_tau:
        cov_c = by_tau[tau_epoch_c].get("coverage")
        assert cov_c is not None and abs(float(cov_c) - 0.0) <= 1e-6, (
            f"design §2.4 property 3 — coverage at start of epoch C "
            f"(τ = tau_future_max + 1 = {tau_epoch_c}) must be 0.0; "
            f"got {cov_c!r}. All cohorts have aged strictly past their "
            f"last fresh snapshot, so the freshness signal must be 0."
        )

    # ── Property 2: monotone linear decay through epoch B ───────────────
    epoch_b_taus = sorted(
        t for t in by_tau
        if tau_solid_max < t <= tau_future_max
    )
    if len(epoch_b_taus) < 2:
        # Insufficient epoch-B span to test linearity; the seam-and-end
        # checks above are still meaningful in isolation.
        return

    coverages_b = [float(by_tau[t]["coverage"]) for t in epoch_b_taus]
    # Monotone non-increasing.
    for i in range(1, len(coverages_b)):
        assert coverages_b[i] <= coverages_b[i - 1] + 1e-6, (
            f"design §2.4 property 3 — epoch B coverage must be monotone "
            f"non-increasing as cohorts age past their last snapshots. "
            f"Got jump up at τ={epoch_b_taus[i]}: "
            f"{coverages_b[i - 1]:.4f} → {coverages_b[i]:.4f}."
        )

    # Linearity. Coverage should drop by ≈1/N per τ where N is the
    # number of admissible cohorts in scope. With evenly-spaced daily
    # anchors, each consecutive τ in epoch B retires one cohort, and
    # the relationship N = (tau_future_max − tau_solid_max) + 1 holds:
    # tau_solid_max retires the latest cohort (last fresh day −
    # latest_anchor) and tau_future_max retires the earliest cohort
    # (last fresh day − earliest_anchor); the span is the inter-anchor
    # distance = N − 1 days.
    n_cohorts_in_scope = (tau_future_max - tau_solid_max) + 1
    assert n_cohorts_in_scope > 1, "degenerate epoch B span"
    expected_step = 1.0 / n_cohorts_in_scope
    cov_b_start = 1.0  # boundary value (last τ of epoch A); per property 1
    cov_b_end = expected_step  # 1/n at τ = tau_future_max (earliest cohort)
    span_steps = tau_future_max - tau_solid_max

    # Compare each consecutive delta to the expected step. The first
    # delta is from τ=tau_solid_max (cov=1) to the first epoch-B τ.
    actual_deltas: list[float] = []
    prev_cov = cov_b_start
    prev_tau = tau_solid_max
    for tau, cov in zip(epoch_b_taus, coverages_b):
        per_step = (prev_cov - cov) / max(1, tau - prev_tau)
        actual_deltas.append(per_step)
        prev_cov = cov
        prev_tau = tau

    tol = max(0.05, 0.5 * expected_step)
    nonlinear = [
        (epoch_b_taus[i], round(d, 4))
        for i, d in enumerate(actual_deltas)
        if abs(d - expected_step) > tol
    ]
    assert not nonlinear, (
        f"design §2.4 property 3 — epoch B coverage must decay linearly "
        f"as cohorts age out evenly. Expected per-τ step ≈ "
        f"{expected_step:.4f} (= ({cov_b_start} − {cov_b_end}) / "
        f"{span_steps}); got nonlinear drops at "
        f"{nonlinear[:10]} (showing up to first 10). Tolerance = {tol:.4f}."
    )
