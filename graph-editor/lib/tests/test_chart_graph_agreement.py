"""Chart-graph agreement test (doc 29f §Phase G).

Asserts the topo pass and cohort_maturity chart produce consistent
forecast rates for the same edge on the same data, across two date
ranges that exercise different scoping scenarios.

Two assertions per case:

    A. p.mean ≈ model_midpoint at max_tau
       Both are the (roughly) unconditioned asymptotic rate. p.mean
       comes from the topo pass; model_midpoint comes from p_draws ×
       CDF (chart prior). Different codepaths, similar question.
       Expected: GREEN today.

    B. p.mean ≈ midpoint at max_tau
       Both should be the IS-conditioned asymptotic rate. midpoint
       comes from per-cohort sequential IS + population model;
       p.mean comes from aggregate tempered IS. Different IS
       strategies. Expected: RED until Phase G unifies the codepaths.

Replaces ``graph-ops/scripts/chart-graph-agreement-test.sh``. The bash
file is preserved as a thin shim that delegates here.
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
_PARAM_PACK_SH = _REPO_ROOT / "graph-ops" / "scripts" / "param-pack.sh"

_PYTHON_BE_URL = os.environ.get("PYTHON_API_URL", "http://localhost:9000")
_TOL = 0.05

_GRAPH = "synth-mirror-4step"
_EDGE_ID = "m4-registered-to-success"

# Same case matrix as chart-graph-agreement-test.sh (lines 63-66).
# label | chart_dsl | pp_dsl
_CASES: list[tuple[str, str, str]] = [
    (
        "full-range",
        "from(m4-registered).to(m4-success).cohort(12-Dec-25:21-Mar-26)",
        "cohort(12-Dec-25:21-Mar-26)",
    ),
    (
        "narrow-range",
        "from(m4-registered).to(m4-success).cohort(7-Mar-26:21-Mar-26)",
        "cohort(7-Mar-26:21-Mar-26)",
    ),
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


def _run_param_pack(graph: str, dsl: str) -> dict[str, Any]:
    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        args = [
            "--graph", _DATA_REPO_PATH,
            "--name", graph,
            "--query", dsl,
            "--format", "json",
        ]
        try:
            return client.call_json("param-pack", args)
        except DaemonError as exc:
            raise AssertionError(
                f"daemon param-pack failed for {graph} / {dsl!r}: {exc}\n"
                f"stderr:\n{exc.stderr[-2000:]}"
            )
    cmd = ["bash", str(_PARAM_PACK_SH), graph, dsl, "--format", "json"]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(_REPO_ROOT), timeout=300)
    if result.returncode != 0:
        raise AssertionError(f"param-pack.sh exit {result.returncode}\nstderr:\n{result.stderr[-2000:]}")
    idx = result.stdout.find("{")
    return json.loads(result.stdout[idx:])


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


def _last_row_values(chart_payload: dict[str, Any]) -> tuple[Optional[int], Optional[float], Optional[float]]:
    """Walk the chart rows from the end and return (last_tau, model_midpoint, midpoint)."""
    result_block = chart_payload.get("result") or {}
    rows = result_block.get("data") or result_block.get("maturity_rows") or []
    last_tau: Optional[int] = None
    model_mid: Optional[float] = None
    mid: Optional[float] = None
    for r in reversed(rows):
        if last_tau is None:
            last_tau = r.get("tau_days")
        if model_mid is None and r.get("model_midpoint") is not None:
            model_mid = float(r["model_midpoint"])
        if mid is None and r.get("midpoint") is not None:
            mid = float(r["midpoint"])
        if model_mid is not None and mid is not None:
            break
    return last_tau, model_mid, mid


@requires_db
@requires_data_repo
@requires_python_be
@pytest.mark.parametrize(
    "label,chart_dsl,pp_dsl",
    _CASES,
    ids=[c[0] for c in _CASES],
)
def test_chart_graph_agreement(label: str, chart_dsl: str, pp_dsl: str) -> None:
    """Doc 29f §G: FE quick pass p.mean must agree with chart prior + IS-conditioned rate.

    Assertion A (p.mean ≈ model_midpoint) is expected to pass today.
    Assertion B (p.mean ≈ midpoint) is expected to FAIL until Phase G
    unifies the IS codepaths — failure here is a known state, not a
    regression. The bash original returned non-zero in this case; this
    pytest equivalent does the same so the regression posture is
    unchanged. If you want to silence B-failures, mark the test xfail
    under whatever gate Phase G is tracked behind.
    """
    _ensure_synth_ready(_GRAPH, enriched=True, bayesian=False, check_fe_parity=False)

    pp_payload = _run_param_pack(_GRAPH, pp_dsl)
    pp_mean_raw = pp_payload.get(f"e.{_EDGE_ID}.p.mean")
    if pp_mean_raw is None:
        pytest.fail(f"[{label}] no p.mean in param-pack for edge {_EDGE_ID}")
    pp_mean = float(pp_mean_raw)

    chart_payload = _run_analyse_cohort_maturity(_GRAPH, chart_dsl)
    last_tau, model_mid, mid = _last_row_values(chart_payload)
    if last_tau is None:
        pytest.fail(f"[{label}] no chart rows returned")

    failures: list[str] = []

    if model_mid is None:
        failures.append(
            f"[{label}] A SKIPPED — no model_midpoint in chart rows"
        )
    else:
        delta_a = abs(pp_mean - model_mid)
        if delta_a >= _TOL:
            failures.append(
                f"[{label}] A FAIL: p.mean={pp_mean:.4f} "
                f"model_midpoint@{last_tau}={model_mid:.4f} "
                f"|Δ|={delta_a:.4f} tol={_TOL}"
            )

    if mid is None:
        failures.append(
            f"[{label}] B SKIPPED — no midpoint in chart rows"
        )
    else:
        delta_b = abs(pp_mean - mid)
        if delta_b >= _TOL:
            failures.append(
                f"[{label}] B FAIL: p.mean={pp_mean:.4f} "
                f"midpoint@{last_tau}={mid:.4f} "
                f"|Δ|={delta_b:.4f} tol={_TOL}  "
                f"(expected — Phase G unifies IS codepaths)"
            )

    if failures:
        pytest.fail("\n  ".join(["", *failures]))
