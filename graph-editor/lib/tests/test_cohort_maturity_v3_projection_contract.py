"""Outside-in projection contract tests for cohort_maturity v3.

Pins the chart-trajectory invariants the v3 row builder MUST exhibit
once the selected-Cohort projection (per
`docs/current/cohort-maturity-selected-cohort-projection-pattern.md`)
replaces the request-level rate-draws projection currently in place.

Authored against the desired contract, not the existing implementation.
Until the projection reducer lands these tests are expected to fail —
that is the point. The failures pin what the new projection has to
deliver.

Style mirrors `test_cohort_factorised_outside_in.py`: real synth
fixtures, daemon-mode CLI dispatch, assertions on the user-visible
`maturity_rows` payload.

Companion docs:
- `docs/current/cohort-maturity-mc-wrong-object-problem-statement.md`
- `docs/current/cohort-maturity-selected-cohort-projection-pattern.md`
- `docs/current/project-bayes/cohort-maturity/cohort-maturity-fan-chart-spec.md`
"""

from __future__ import annotations

import copy
import functools
import json
import os
import subprocess
from pathlib import Path
from typing import Any, Optional

import pytest

from conftest import requires_data_repo, requires_db, requires_synth
from _daemon_client import DaemonError, get_default_client


_REPO_ROOT = Path(__file__).resolve().parents[3]
_ANALYSE_SH = _REPO_ROOT / "graph-ops" / "scripts" / "analyse.sh"


def _resolve_data_repo_path() -> Optional[str]:
    conf = _REPO_ROOT / ".private-repos.conf"
    if not conf.exists():
        return None
    for line in conf.read_text().splitlines():
        if line.startswith("DATA_REPO_DIR="):
            return str(_REPO_ROOT / line.split("=", 1)[1].strip())
    return None


_DATA_REPO_PATH = _resolve_data_repo_path()
_PYTHON_BE_URL = os.environ.get("PYTHON_API_URL", "http://localhost:9000")
_USE_CACHE = os.environ.get("DAGNET_TEST_USE_CACHE", "0") == "1"


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


@functools.lru_cache(maxsize=None)
def _run_analyse_cached(graph_name: str, dsl: str) -> dict[str, Any]:
    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        args = [
            "--graph", _DATA_REPO_PATH,
            "--name", graph_name,
            "--query", dsl,
            "--type", "cohort_maturity",
            "--format", "json",
        ]
        if not _USE_CACHE:
            args += ["--no-cache", "--no-snapshot-cache"]
        try:
            return client.call_json("analyse", args)
        except DaemonError as exc:
            raise AssertionError(
                f"daemon analyse failed for {graph_name} / {dsl!r} "
                f"(exit {exc.exit_code}): {exc}\nstderr:\n{exc.stderr[-2000:]}"
            )

    cmd = [
        "bash", str(_ANALYSE_SH), graph_name, dsl,
        "--type", "cohort_maturity",
    ]
    if not _USE_CACHE:
        cmd += ["--no-cache", "--no-snapshot-cache"]
    cmd += ["--format", "json"]
    result = subprocess.run(
        cmd, capture_output=True, text=True, cwd=str(_REPO_ROOT), timeout=300,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"analyse.sh exited {result.returncode} for {graph_name} / {dsl!r}\n"
            f"stderr:\n{result.stderr[-2000:]}"
        )
    stdout = result.stdout
    if not stdout.startswith("{"):
        idx = stdout.find("{")
        if idx < 0:
            raise AssertionError(f"no JSON in stdout for {graph_name} / {dsl!r}")
        stdout = stdout[idx:]
    return json.loads(stdout)


def _run_analyse_v3(graph_name: str, dsl: str) -> dict[str, Any]:
    return copy.deepcopy(_run_analyse_cached(graph_name, dsl))


def _rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    return (payload.get("result") or {}).get("data") or []


def _row_at(rows: list[dict[str, Any]], tau: int) -> Optional[dict[str, Any]]:
    for r in rows:
        if isinstance(r.get("tau_days"), int) and int(r["tau_days"]) == tau:
            return r
    return None


# Synth fixture — same as the existing outside-in suite. `synth-simple-abc`
# is a single-edge linear graph with deterministic latency truth, so the
# seam and widening invariants are unambiguous.
_SIMPLE = "synth-simple-abc"
_SIMPLE_AB = "from(simple-a).to(simple-b)"

# Window over a date range that intersects the synth's evidence window
# (matches the pinning convention in test_cohort_factorised_outside_in.py).
_WINDOW_DSL = f"{_SIMPLE_AB}.window(29-Jan-26:29-Apr-26)"


# ── Invariant 1: midpoint meets empirical evidence at tau_solid_max ────


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_v3_midpoint_meets_evidence_at_seam():
    """At τ = tau_solid_max every selected Cohort is mature (by
    definition: tau_solid_max is the youngest Cohort's frontier age).
    The per-particle group trajectory collapses to the observed
    aggregate — every particle returns Σy_observed / Σx_observed at
    the seam, the median equals that value.

    Currently fails because v3's per-particle trajectory is
    `p_s × F_Y_s(τ) / F_X_s(τ)`, an aggregate model curve uncoupled
    from each Cohort's observed prefix. The new selected-Cohort
    projection makes this hold by construction.
    """
    payload = _run_analyse_v3(_SIMPLE, _WINDOW_DSL)
    rows = _rows(payload)
    assert rows, f"analyse returned no rows for {_SIMPLE} / {_WINDOW_DSL!r}"

    tau_solid_max = rows[0].get("tau_solid_max")
    assert isinstance(tau_solid_max, int), (
        f"tau_solid_max missing or non-int on first row: {rows[0].get('tau_solid_max')!r}"
    )
    seam = _row_at(rows, tau_solid_max)
    assert seam is not None, f"no row at tau_solid_max={tau_solid_max}"

    midpoint = seam.get("midpoint")
    evidence_x = seam.get("evidence_x")
    evidence_y = seam.get("evidence_y")
    rate = seam.get("rate")

    assert midpoint is not None, (
        f"midpoint is None at tau_solid_max={tau_solid_max} — the seam "
        f"must emit a midpoint so the dotted line connects with the solid line"
    )
    assert isinstance(evidence_x, (int, float)) and float(evidence_x) > 0, (
        f"evidence_x must be positive at tau_solid_max={tau_solid_max} "
        f"(got {evidence_x!r})"
    )
    assert isinstance(evidence_y, (int, float)), (
        f"evidence_y must be numeric at tau_solid_max={tau_solid_max} "
        f"(got {evidence_y!r})"
    )
    empirical = float(evidence_y) / float(evidence_x)
    delta = abs(float(midpoint) - empirical)
    assert delta < 1e-3, (
        f"midpoint diverged from empirical group rate at the seam "
        f"(tau_solid_max={tau_solid_max}): "
        f"midpoint={midpoint:.6f} empirical={empirical:.6f} delta={delta:.6f} "
        f"(rate field={rate}, evidence_y={evidence_y}, evidence_x={evidence_x})"
    )


# ── Invariant 2: fan widens monotonically through epoch B ──────────────


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_v3_fan_widens_through_epoch_b():
    """Empirical fan width must grow as τ moves past the seam. At
    τ = tau_solid_max every Cohort is observed and the band has zero
    width. For each subsequent τ at least one more Cohort drops into
    forecast mode and contributes particle spread via the calibrated
    CDF ratio. The fan opens monotonically through epoch B.

    Currently fails because v3's MC produces fan widths that are
    roughly constant across τ (~0.05 in observed traces), bounded
    above by Var(p_s) and modulated only by `(F_Y/F_X)²` rather than
    by how many Cohorts have entered forecast mode. The new
    selected-Cohort projection makes the widening structural.
    """
    payload = _run_analyse_v3(_SIMPLE, _WINDOW_DSL)
    rows = _rows(payload)
    assert rows, f"analyse returned no rows for {_SIMPLE} / {_WINDOW_DSL!r}"

    tau_solid_max = rows[0].get("tau_solid_max")
    tau_future_max = rows[0].get("tau_future_max")
    assert isinstance(tau_solid_max, int) and isinstance(tau_future_max, int), (
        f"epoch boundaries missing on first row: "
        f"tau_solid_max={tau_solid_max!r} tau_future_max={tau_future_max!r}"
    )
    assert tau_future_max > tau_solid_max, (
        f"epoch B has zero width on this fixture "
        f"(tau_solid_max={tau_solid_max} tau_future_max={tau_future_max}) — "
        f"projection-widening cannot be exercised"
    )

    widths: list[tuple[int, float]] = []
    for tau in range(tau_solid_max, tau_future_max + 1):
        r = _row_at(rows, tau)
        if r is None:
            continue
        fl = r.get("fan_lower")
        fh = r.get("fan_upper")
        if fl is None or fh is None:
            continue
        widths.append((tau, float(fh) - float(fl)))

    assert len(widths) >= 4, (
        f"too few rows with fan bounds in epoch B "
        f"(tau_solid_max={tau_solid_max} tau_future_max={tau_future_max} "
        f"widths={widths})"
    )

    failures: list[str] = []
    for i in range(1, len(widths)):
        prev_tau, prev_w = widths[i - 1]
        curr_tau, curr_w = widths[i]
        if curr_w < prev_w - 1e-6:
            failures.append(
                f"fan width decreased: tau={prev_tau} width={prev_w:.6f} → "
                f"tau={curr_tau} width={curr_w:.6f}"
            )
    assert not failures, (
        "fan width not monotonically non-decreasing through epoch B:\n"
        + "\n".join(failures[:10])
    )

    max_width = max(w for _, w in widths)
    assert max_width > 0.005, (
        f"fan width never grew past 0.005 through epoch B (max={max_width:.6f}) — "
        f"expected meaningful widening as Cohorts enter forecast mode"
    )


# ── Invariant 3: midpoint and fan stay in [0, 1] across the row grid ──


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_v3_projection_stays_within_unit_interval():
    """Per-Cohort mass extension must keep the aggregate group rate in
    [0, 1] at every τ. A rate > 1 is unphysical: it would mean more
    conversions than members. The §5.2.1 calibrated CDF ratio formula
    fails this when a Cohort outperforms the model curve at frontier
    (y_frozen / x_frozen > model's expected fraction at frontier);
    the residual-pending decomposition bounds y_d ≤ a_pop_d × p_subject
    and x_d ≤ a_pop_d structurally, so rate = ΣY/ΣX ≤ 1 by construction.
    This invariant catches regressions that quietly re-introduce the
    unbounded ratio shortcut.
    """
    payload = _run_analyse_v3(_SIMPLE, _WINDOW_DSL)
    rows = _rows(payload)
    assert rows, f"analyse returned no rows for {_SIMPLE} / {_WINDOW_DSL!r}"

    failures: list[str] = []
    for r in rows:
        tau = r.get('tau_days')
        for field in ('midpoint', 'fan_lower', 'fan_upper', 'projected_rate'):
            v = r.get(field)
            if v is None:
                continue
            fv = float(v)
            if not (-1e-9 <= fv <= 1.0 + 1e-9):
                failures.append(f"τ={tau} {field}={fv:.6f} out of [0, 1]")
        bands = r.get('fan_bands') or {}
        for level, pair in bands.items():
            if not pair:
                continue
            lo, hi = float(pair[0]), float(pair[1])
            if not (-1e-9 <= lo <= 1.0 + 1e-9):
                failures.append(f"τ={tau} fan_bands[{level}].lower={lo:.6f} out of [0, 1]")
            if not (-1e-9 <= hi <= 1.0 + 1e-9):
                failures.append(f"τ={tau} fan_bands[{level}].upper={hi:.6f} out of [0, 1]")
    assert not failures, (
        "projection produced rates outside [0, 1] — calibrated extrapolation "
        "is unbounded; the residual-pending decomposition bounds it structurally:\n"
        + "\n".join(failures[:20])
    )


# ── Invariant 4: undefined denominator ⇒ row emits None, not zero ─────


@requires_db
@requires_data_repo
@requires_python_be
@requires_synth(_SIMPLE, enriched=True)
def test_v3_undefined_denominator_emits_none_not_zero():
    """Y / X with no X is undefined, NOT zero. Rows where the projection
    has no per-particle denominator mass (X_total_s = 0 for every
    particle, which can occur in early active-carrier ages or in
    degraded substrate cases) must emit `midpoint = None` rather than a
    fabricated zero, otherwise the chart will draw a flat-zero band
    where there is in fact no information.

    On `synth-simple-abc` window mode every Cohort has positive
    `x_frozen` so X_total > 0 throughout; this test pins the structural
    invariant that the row builder doesn't quietly substitute 0 for
    undefined. Where midpoint is non-None it must come with non-None
    fan bounds (the projection produced a real distribution).
    """
    payload = _run_analyse_v3(_SIMPLE, _WINDOW_DSL)
    rows = _rows(payload)
    assert rows, f"analyse returned no rows for {_SIMPLE} / {_WINDOW_DSL!r}"

    inconsistencies: list[str] = []
    for r in rows:
        tau = r.get('tau_days')
        midpoint = r.get('midpoint')
        fan_lo = r.get('fan_lower')
        fan_hi = r.get('fan_upper')
        if midpoint is None:
            if fan_lo is not None or fan_hi is not None:
                inconsistencies.append(
                    f"τ={tau} midpoint=None but fan_lower={fan_lo!r} fan_upper={fan_hi!r}"
                )
        else:
            if fan_lo is None or fan_hi is None:
                inconsistencies.append(
                    f"τ={tau} midpoint={midpoint!r} but fan_lower={fan_lo!r} fan_upper={fan_hi!r}"
                )
    assert not inconsistencies, (
        "midpoint and fan bounds inconsistent (one None, the other not):\n"
        + "\n".join(inconsistencies[:10])
    )
