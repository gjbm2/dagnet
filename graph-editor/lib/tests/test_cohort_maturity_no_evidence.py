"""cohort_maturity no-evidence degeneration contract test.

At a public-tooling no-evidence limit (early `asat()` on a window that
still yields rows), the cohort_maturity result must collapse onto one
model-only forecast family:

    - conditioned row midpoint (`midpoint`)
    - forecast-only row midpoint (`model_midpoint`)
    - metadata overlay curve (`metadata.model_curves[*].curve`)

must all coincide, while raw `evidence_x` / `evidence_y` stay null.

Fan upper/lower bounds (`fan_upper`/`fan_lower`) must equal their
model-only counterparts (`model_fan_upper`/`model_fan_lower`) at every
informative tau.

Replaces ``graph-ops/scripts/cohort-maturity-no-evidence-test.sh``.
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
_WINDOW = "31-Jan-26:15-Mar-26"
_ASAT = "1-Feb-26"
_EPS = 1e-6
_MIN_INFORMATIVE_ROWS = 5
_NEAR_ZERO_FLOOR = 1e-4

# Same case matrix as cohort-maturity-no-evidence-test.sh (lines 206-216).
_CASES: list[tuple[str, str]] = [
    ("window_single_hop", f"from(m4-delegated).to(m4-registered).window({_WINDOW}).asat({_ASAT})"),
    ("cohort_single_hop", f"from(m4-delegated).to(m4-registered).cohort({_WINDOW}).asat({_ASAT})"),
    ("window_multi_hop", f"from(m4-created).to(m4-success).window({_WINDOW}).asat({_ASAT})"),
    ("cohort_multi_hop", f"from(m4-created).to(m4-success).cohort({_WINDOW}).asat({_ASAT})"),
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


def _run_analyse_cohort_maturity(graph: str, dsl: str) -> dict[str, Any]:
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


@requires_db
@requires_data_repo
@requires_python_be
@pytest.mark.parametrize(
    "case_name,dsl",
    _CASES,
    ids=[c[0] for c in _CASES],
)
def test_cohort_maturity_no_evidence_collapse(case_name: str, dsl: str) -> None:
    """At the no-evidence limit, midpoint/model_midpoint/overlay must collapse and evidence stay null."""
    _ensure_synth_ready(_GRAPH, enriched=True, bayesian=False, check_fe_parity=False)

    payload = _run_analyse_cohort_maturity(_GRAPH, dsl)
    result_block = payload.get("result") or {}

    rows = result_block.get("data") or []
    if not rows:
        pytest.fail(f"[{case_name}] result.data is empty")

    model_curves = (result_block.get("metadata") or {}).get("model_curves") or {}
    if not model_curves:
        pytest.fail(f"[{case_name}] metadata.model_curves missing")

    first_curve_entry = next(iter(model_curves.values()))
    curve = first_curve_entry.get("curve") or []
    curve_by_tau: dict[int, float] = {}
    for p in curve:
        tau = p.get("tau_days")
        rate = p.get("model_rate")
        if tau is not None and rate is not None:
            curve_by_tau[int(tau)] = float(rate)
    if not curve_by_tau:
        pytest.fail(f"[{case_name}] promoted overlay curve is empty")

    # Build the eligible-row table: skip the dead/zero segment before the
    # model has risen since it is mechanically equal and not informative.
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
        if max(abs(float(midpoint)), abs(float(model_midpoint)), abs(float(overlay))) < _NEAR_ZERO_FLOOR:
            continue
        eligible.append({
            "tau": tau_i,
            "midpoint": float(midpoint),
            "model_midpoint": float(model_midpoint),
            "overlay": float(overlay),
            "evidence_x": row.get("evidence_x"),
            "evidence_y": row.get("evidence_y"),
            "fan_upper": row.get("fan_upper"),
            "model_fan_upper": row.get("model_fan_upper"),
            "fan_lower": row.get("fan_lower"),
            "model_fan_lower": row.get("model_fan_lower"),
        })

    if len(eligible) < _MIN_INFORMATIVE_ROWS:
        pytest.fail(
            f"[{case_name}] only {len(eligible)} informative rows found "
            f"(need ≥ {_MIN_INFORMATIVE_ROWS})"
        )

    violations: list[str] = []
    for r in eligible:
        tau = r["tau"]
        midpoint = r["midpoint"]
        model_midpoint = r["model_midpoint"]
        overlay = r["overlay"]

        if r["evidence_x"] is not None or r["evidence_y"] is not None:
            violations.append(
                f"tau={tau}: expected evidence_x/evidence_y null, "
                f"got {r['evidence_x']!r}/{r['evidence_y']!r}"
            )
        if abs(midpoint - model_midpoint) > _EPS:
            violations.append(
                f"tau={tau}: midpoint={midpoint:.8f} != model_midpoint={model_midpoint:.8f}"
            )
        if abs(overlay - model_midpoint) > _EPS:
            violations.append(
                f"tau={tau}: overlay={overlay:.8f} != model_midpoint={model_midpoint:.8f}"
            )

        fu, mfu = r["fan_upper"], r["model_fan_upper"]
        fl, mfl = r["fan_lower"], r["model_fan_lower"]
        if fu is not None and mfu is not None and abs(float(fu) - float(mfu)) > _EPS:
            violations.append(
                f"tau={tau}: fan_upper={float(fu):.8f} != model_fan_upper={float(mfu):.8f}"
            )
        if fl is not None and mfl is not None and abs(float(fl) - float(mfl)) > _EPS:
            violations.append(
                f"tau={tau}: fan_lower={float(fl):.8f} != model_fan_lower={float(mfl):.8f}"
            )

    if violations:
        # Print a head-of-table preview alongside the violations so the
        # operator sees what the actual values were.
        rows_preview = "\n".join(
            f"  tau={r['tau']:4d}  midpoint={r['midpoint']:.8f}  "
            f"model_mid={r['model_midpoint']:.8f}  overlay={r['overlay']:.8f}"
            for r in eligible[:8]
        )
        report = (
            f"\n[{case_name}] degeneration invariant violated:\n"
            f"{rows_preview}\n\nViolations (first 10):\n  "
            + "\n  ".join(violations[:10])
        )
        pytest.fail(report)
