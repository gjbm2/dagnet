"""Multi-hop composition parity test (window/cohort convergence).

Asserts that the multi-hop cohort_maturity midpoint converges to the
product of per-edge midpoints, in cohort mode, on a 2-hop path. Catches
structural defects where the multi-hop engine's carrier, IS conditioning,
or CDF composition over-suppresses or inflates the rate.

Two assertions per graph:

    1. Cohort composition: midpoint(C→D→E) ≈ midpoint(C→D) × midpoint(D→E)
       within max(15% relative, 0.015 absolute).
    2. Cross-mode divergence: |window_mh − cohort_mh| within a bound that
       grows with the per-edge window/cohort divergences (multi-hop
       divergence should not compound beyond ~2× the sum of per-edge
       divergences + 10%).

Window composition (midpoint(mh) ≈ midpoint(e1) × midpoint(e2) in window
mode) is INFORMATIONAL only — the bash original skipped it as an
assertion because per-edge analyses see different population maturation
mixes than multi-hop.

Replaces ``graph-ops/scripts/window-cohort-convergence-test.sh``. The
bash file is preserved as a thin shim that delegates here. Two
additional graph configurations (``synth-slow-path``, ``synth-lat4``)
exist in the bash original; only ``synth-mirror-4step`` is run by
default to match historical CI behaviour. Add them by extending
``_CASES`` if needed.
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

# label, graph, edge1_subject, edge2_subject, multihop_subject, date_range, anchor
_CASES: list[tuple[str, str, str, str, str, str, str]] = [
    (
        "synth-mirror-4step:c-d-e",
        "synth-mirror-4step",
        "from(m4-delegated).to(m4-registered)",
        "from(m4-registered).to(m4-success)",
        "from(m4-delegated).to(m4-success)",
        "22-Mar-26:21-Apr-26",
        "m4-landing",
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


def _run_analyse(graph: str, dsl: str) -> dict[str, Any]:
    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        args = [
            "--graph", _DATA_REPO_PATH,
            "--name", graph,
            "--query", dsl,
            "--type", "cohort_maturity",
            "--no-cache", "--no-snapshot-cache",
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
        "--type", "cohort_maturity", "--no-cache", "--no-snapshot-cache", "--format", "json",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(_REPO_ROOT), timeout=300)
    if result.returncode != 0:
        raise AssertionError(f"analyse.sh exit {result.returncode}\nstderr:\n{result.stderr[-2000:]}")
    idx = result.stdout.find("{")
    return json.loads(result.stdout[idx:])


def _mature_midpoint(payload: dict[str, Any]) -> Optional[float]:
    """Average of the last 5 non-null midpoints in result.data, or None."""
    rows = (payload.get("result") or {}).get("data") or []
    midpoints = [float(r["midpoint"]) for r in rows if r.get("midpoint") is not None]
    if len(midpoints) < 5:
        return None
    tail = midpoints[-5:]
    return sum(tail) / len(tail)


@requires_db
@requires_data_repo
@requires_python_be
@pytest.mark.parametrize(
    "label,graph,edge1,edge2,multihop,date_range,anchor",
    _CASES,
    ids=[c[0] for c in _CASES],
)
def test_multi_hop_composition(
    label: str,
    graph: str,
    edge1: str,
    edge2: str,
    multihop: str,
    date_range: str,
    anchor: str,
) -> None:
    """midpoint(MH) must converge to midpoint(E1)×midpoint(E2) in cohort mode."""
    _ensure_synth_ready(graph, enriched=True, bayesian=False, check_fe_parity=False)

    # 6 analyses per case: e1, e2, mh × {window, cohort}
    midpoints: dict[tuple[str, str], Optional[float]] = {}
    for mode in ("window", "cohort"):
        if mode == "window":
            dsls = {
                "e1": f"{edge1}.window({date_range})",
                "e2": f"{edge2}.window({date_range})",
                "mh": f"{multihop}.window({date_range})",
            }
        else:
            dsls = {
                "e1": f"{edge1}.cohort({anchor},{date_range})",
                "e2": f"{edge2}.cohort({anchor},{date_range})",
                "mh": f"{multihop}.cohort({anchor},{date_range})",
            }
        for tag, dsl in dsls.items():
            payload = _run_analyse(graph, dsl)
            midpoints[(mode, tag)] = _mature_midpoint(payload)

    failures: list[str] = []
    table_lines: list[str] = []

    # Cohort composition: midpoint(mh) ≈ midpoint(e1) × midpoint(e2)
    e1_c, e2_c, mh_c = midpoints[("cohort", "e1")], midpoints[("cohort", "e2")], midpoints[("cohort", "mh")]
    if None in (e1_c, e2_c, mh_c):
        failures.append(
            f"cohort composition: missing data e1={e1_c} e2={e2_c} mh={mh_c}"
        )
    else:
        product_c = e1_c * e2_c
        delta_c = abs(mh_c - product_c)
        rel_c = delta_c / max(product_c, 1e-6)
        threshold_c = max(0.015, 0.15 * product_c)
        table_lines.append(
            f"  cohort:  e1={e1_c:.5f}  e2={e2_c:.5f}  product={product_c:.5f}  "
            f"mh={mh_c:.5f}  Δ={delta_c:.5f}  rel={rel_c:.1%}  thresh={threshold_c:.5f}"
        )
        if delta_c > threshold_c:
            failures.append(
                f"cohort composition broken: |mh - product|={delta_c:.5f} > "
                f"threshold {threshold_c:.5f} ({rel_c:.1%} off)"
            )

    # Window composition: informational only — DO NOT assert (per bash original)
    e1_w, e2_w, mh_w = midpoints[("window", "e1")], midpoints[("window", "e2")], midpoints[("window", "mh")]
    if None not in (e1_w, e2_w, mh_w):
        product_w = e1_w * e2_w
        delta_w = abs(mh_w - product_w)
        table_lines.append(
            f"  window:  e1={e1_w:.5f}  e2={e2_w:.5f}  product={product_w:.5f}  "
            f"mh={mh_w:.5f}  Δ={delta_w:.5f}  (informational only)"
        )

    # Cross-mode divergence: |window_mh - cohort_mh| bounded by per-edge divergences
    if mh_w is not None and mh_c is not None:
        delta_cross = abs(mh_w - mh_c)
        avg_cross = (mh_w + mh_c) / 2
        rel_cross = delta_cross / avg_cross if avg_cross > 0 else 0.0

        if all(v is not None for v in (e1_w, e1_c, e2_w, e2_c)):
            d1 = abs(e1_w - e1_c) / max(e1_w, e1_c) if max(e1_w, e1_c) > 0 else 0.0
            d2 = abs(e2_w - e2_c) / max(e2_w, e2_c) if max(e2_w, e2_c) > 0 else 0.0
            bound = 2 * (d1 + d2) + 0.10
            table_lines.append(
                f"  cross:   window_mh={mh_w:.5f}  cohort_mh={mh_c:.5f}  Δ={delta_cross:.5f}  "
                f"rel={rel_cross:.1%}  per-edge sum={d1+d2:.1%}  bound={bound:.1%}"
            )
            if rel_cross > bound:
                failures.append(
                    f"multi-hop divergence {rel_cross:.1%} exceeds bound {bound:.1%}"
                )
        else:
            table_lines.append(
                f"  cross:   window_mh={mh_w:.5f}  cohort_mh={mh_c:.5f}  Δ={delta_cross:.5f}  "
                f"rel={rel_cross:.1%}"
            )
            if rel_cross > 0.30:
                failures.append(
                    f"multi-hop divergence {rel_cross:.1%} exceeds fallback 30% bound"
                )
    else:
        failures.append(f"cross-mode: missing data window_mh={mh_w} cohort_mh={mh_c}")

    if failures:
        report = (
            f"\n[{label}] multi-hop composition parity violated\n"
            + "\n".join(table_lines)
            + "\n\nFailures:\n  "
            + "\n  ".join(failures)
        )
        pytest.fail(report)
