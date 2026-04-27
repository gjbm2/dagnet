"""CF truth-parity test (doc 50).

Asserts the per-edge conditioned_forecast scalar matches the truth value
within tolerance, by class:

    Class B (non-latency, sigma=0): |cf_p - truth_p| < NON_LATENCY_TOL
        Beta-Binomial closed form should be exact given the resolver's
        alpha/beta. Deviation beyond MC noise indicates a real defect.

    Class A (laggy, sigma>0):       |cf_p - truth_p| < LAGGY_BOUND
        Catastrophic bound — wide enough to tolerate the known kappa=20
        weak-prior bias in the legacy span_kernel/v2 path (doc 56
        Phase 1-4 scope) but tight enough to catch a regression that
        breaks Class A entirely. Per-edge |delta| is printed on failure
        so the bias size remains visible.

Tolerance overrides via env: NON_LATENCY_TOL (default 0.05),
LAGGY_BOUND (default 0.20).

Replaces ``graph-ops/scripts/cf-truth-parity.sh``. The bash file is
preserved as a thin shim that delegates to this pytest module so existing
documentation references and human runners keep working.
"""

from __future__ import annotations

import json
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

_PYTHON_BE_URL = os.environ.get("PYTHON_API_URL", "http://localhost:9000")

NON_LATENCY_TOL = float(os.environ.get("NON_LATENCY_TOL", "0.05"))
LAGGY_BOUND = float(os.environ.get("LAGGY_BOUND", "0.20"))


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


# Same fixture matrix as the bash original (lines 34-41 of cf-truth-parity.sh).
_FIXTURES: list[tuple[str, str]] = [
    ("synth-simple-abc", "window(-120d:)"),
    ("cf-fix-linear-no-lag", "window(-60d:)"),
    ("synth-mirror-4step", "cohort(7-Mar-26:21-Mar-26)"),
    ("cf-fix-branching", "window(-60d:)"),
    ("cf-fix-diamond-mixed", "window(-120d:)"),
    ("cf-fix-deep-mixed", "window(-180d:)"),
]


def _resolve_data_repo_path() -> Optional[str]:
    conf = _REPO_ROOT / ".private-repos.conf"
    if not conf.exists():
        return None
    for line in conf.read_text().splitlines():
        if line.startswith("DATA_REPO_DIR="):
            return str(_REPO_ROOT / line.split("=", 1)[1].strip())
    return None


_DATA_REPO_PATH = _resolve_data_repo_path()


def _run_cf_analyse(graph: str, dsl: str) -> dict[str, Any]:
    """Run conditioned_forecast via the daemon, with subprocess fallback."""
    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        args = [
            "--graph", _DATA_REPO_PATH,
            "--name", graph,
            "--query", dsl,
            "--type", "conditioned_forecast",
            "--format", "json",
        ]
        try:
            return client.call_json("analyse", args)
        except DaemonError as exc:
            raise AssertionError(
                f"daemon analyse failed for {graph} / {dsl!r} "
                f"(exit {exc.exit_code}): {exc}\n"
                f"stderr:\n{exc.stderr[-2000:]}"
            )

    cmd = [
        "bash", str(_ANALYSE_SH), graph, dsl,
        "--type", "conditioned_forecast",
        "--format", "json",
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True,
        cwd=str(_REPO_ROOT), timeout=300,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"analyse.sh exited {result.returncode} for {graph} / {dsl!r}\n"
            f"stderr:\n{result.stderr[-2000:]}"
        )
    idx = result.stdout.find("{")
    if idx < 0:
        raise AssertionError(f"no JSON in stdout for {graph}: {result.stdout[:500]}")
    return json.loads(result.stdout[idx:])


def _load_truth_edges(graph: str) -> dict[tuple[str, str], dict[str, float]]:
    truth_path = _TRUTH_DIR / f"{graph}.truth.yaml"
    if not truth_path.exists():
        pytest.skip(f"missing truth file: {truth_path}")
    truth = yaml.safe_load(truth_path.read_text()) or {}
    out: dict[tuple[str, str], dict[str, float]] = {}
    for _ek, ev in (truth.get("edges") or {}).items():
        out[(ev["from"], ev["to"])] = {
            "sigma": float(ev.get("sigma", 0.0)),
            "p": float(ev["p"]),
        }
    return out


@requires_db
@requires_data_repo
@requires_python_be
@pytest.mark.parametrize(
    "graph_name,dsl",
    _FIXTURES,
    ids=[f"{g}|{d}" for g, d in _FIXTURES],
)
def test_cf_truth_parity_per_edge(graph_name: str, dsl: str) -> None:
    """Doc 50: CF p_mean must match truth p within class-specific tolerance.

    Each fixture is a separate parametrised test, so pytest reports per-graph
    pass/fail directly — no need for the bash original's manual fixture-loop
    accumulator and exit-code packing.
    """
    # check_fe_parity=False: the test itself invokes the FE CLI per graph,
    # so FE-interpretation drift surfaces in the assertions below. Skipping
    # the probe drops the per-graph freshness cost from ~1s subprocess
    # startup to a few ms of SHA-256 file checks.
    _ensure_synth_ready(graph_name, enriched=True, bayesian=False, check_fe_parity=False)

    cf = _run_cf_analyse(graph_name, dsl)
    truth_edges = _load_truth_edges(graph_name)
    cf_edges = (cf.get("scenarios") or [{}])[0].get("edges", [])

    rows: list[str] = []
    non_latency_fails: list[str] = []
    laggy_fails: list[str] = []

    for e in cf_edges:
        fn, tn = e.get("from_node"), e.get("to_node")
        truth_info = truth_edges.get((fn, tn))
        if truth_info is None:
            continue
        cf_p = e.get("p_mean")
        if cf_p is None:
            continue
        sigma = truth_info["sigma"]
        truth_p = truth_info["p"]
        delta = abs(truth_p - cf_p)
        edge_label = f"{fn} -> {tn}"

        if sigma == 0:
            ok = delta < NON_LATENCY_TOL
            tag = "B (non-latency)"
            tol_label = f"tol={NON_LATENCY_TOL}"
            if not ok:
                non_latency_fails.append(edge_label)
        else:
            ok = delta < LAGGY_BOUND
            tag = "A (laggy)"
            tol_label = f"bound={LAGGY_BOUND}"
            if not ok:
                laggy_fails.append(edge_label)

        mark = "✓" if ok else "✗"
        rows.append(
            f"  {mark} {edge_label:<52}  {tag}  truth={truth_p:.4f}  "
            f"cf={cf_p:.4f}  |Δ|={delta:.4f}  {tol_label}"
        )

    if non_latency_fails or laggy_fails:
        report = "\n".join([
            "",
            f"── {graph_name} ({dsl}) ──",
            *rows,
            "",
            f"  Class B (non-latency) failures: {len(non_latency_fails)}  "
            f"-> {non_latency_fails}",
            f"  Class A (laggy) failures: {len(laggy_fails)}  -> {laggy_fails}",
        ])
        pytest.fail(report)
