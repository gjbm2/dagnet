"""v2-vs-v3 cohort_maturity parity test (outside-in CLI variant).

Proves that ``cohort_maturity`` (v3) produces results compatible with
``cohort_maturity_v2`` on synth graphs, exercised through the public
CLI tooling. Distinct from the row-schema/handler-level
``test_v2_v3_parity.py`` — that one calls the BE handler directly on
synth-simple-abc; this one drives the full FE→BE pipeline through
``analyse.sh`` on synth-mirror-4step.

Three phases:

    Phase 1 — data health: graph file exists, non-dropout edges have
              ``p.id``, DB has cohort + window snapshots per edge,
              and CLI v2/v3 return non-vacuous rows (midpoint present,
              evidence_x > 0).

    Phase 2 — parity: midpoint per tau within 0.06 absolute. Fan width
              and forecast_x/y intentionally diverge (v3's SMC mutation
              produces wider but honest bands; parity not sought).

    Phase 3 — frontier-zero degeneration: SKIPPED on synth-mirror-4step
              (small N at the funnel's last edge gives binomial
              quantisation noise that swamps the signal — the diamond
              graph and a unit test cover this case).

Replaces ``graph-ops/scripts/v2-v3-parity-test.sh``. The bash file is
preserved as a thin shim that delegates here. The bash original
supported ``synth-diamond-test`` as an alternative graph; the pytest
module currently parametrises only ``synth-mirror-4step``. Extend
``_CASES`` if needed.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Optional

import pytest

from conftest import requires_data_repo, requires_db, _ensure_synth_ready, _resolve_db_url
from _daemon_client import DaemonError, get_default_client


_REPO_ROOT = Path(__file__).resolve().parents[3]
_ANALYSE_SH = _REPO_ROOT / "graph-ops" / "scripts" / "analyse.sh"

_PYTHON_BE_URL = os.environ.get("PYTHON_API_URL", "http://localhost:9000")

_GRAPH = "synth-mirror-4step"

# Same case matrix as v2-v3-parity-test.sh _define_cases_synth_mirror_4step.
_CASES: list[tuple[str, str, str]] = [
    ("single-hop-cohort-wide",   "from(m4-registered).to(m4-success).cohort(7-Mar-26:21-Mar-26)",  "cohort"),
    ("single-hop-cohort-narrow", "from(m4-registered).to(m4-success).cohort(15-Mar-26:21-Mar-26)", "cohort"),
    ("multi-hop-cohort-wide",    "from(m4-delegated).to(m4-success).cohort(7-Mar-26:21-Mar-26)",   "cohort"),
    ("multi-hop-cohort-narrow",  "from(m4-delegated).to(m4-success).cohort(15-Mar-26:21-Mar-26)",  "cohort"),
    ("single-hop-window",        "from(m4-registered).to(m4-success).window(7-Mar-26:21-Mar-26)",  "window"),
]

# Phase-2 midpoint tolerance (per bash original line 344). v3's SMC
# mutation shifts the posterior centre slightly vs v2's pure IS; ~5%
# accumulated shift is intentional and acceptable.
_MIDPOINT_TOL = 0.06


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
_GRAPH_FILE = (
    Path(_DATA_REPO_PATH) / "graphs" / f"{_GRAPH}.json"
    if _DATA_REPO_PATH else None
)


def _run_analyse(graph: str, dsl: str, *, analysis_type: str) -> dict[str, Any]:
    args = [
        "--graph", _DATA_REPO_PATH or "",
        "--name", graph,
        "--query", dsl,
        "--type", analysis_type,
        "--no-snapshot-cache",
        "--format", "json",
    ]
    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        try:
            return client.call_json("analyse", args)
        except DaemonError as exc:
            raise AssertionError(
                f"daemon analyse failed for {graph} / {dsl!r} ({analysis_type}): {exc}\n"
                f"stderr:\n{exc.stderr[-2000:]}"
            )
    cmd = ["bash", str(_ANALYSE_SH), graph, dsl,
           "--type", analysis_type, "--no-snapshot-cache", "--format", "json"]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(_REPO_ROOT), timeout=300)
    if result.returncode != 0:
        raise AssertionError(f"analyse.sh exit {result.returncode}\nstderr:\n{result.stderr[-2000:]}")
    idx = result.stdout.find("{")
    return json.loads(result.stdout[idx:])


def _rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    res = payload.get("result") or {}
    return res.get("data") or res.get("maturity_rows") or []


def _summarise_rows(rows: list[dict[str, Any]]) -> dict[str, int]:
    n_with_mid = sum(1 for r in rows if r.get("midpoint") is not None)
    n_with_fx = sum(1 for r in rows if isinstance(r.get("forecast_x"), (int, float)) and r["forecast_x"] > 0)
    n_with_ev = sum(1 for r in rows if isinstance(r.get("evidence_x"), (int, float)) and r["evidence_x"] > 0)
    return {"total": len(rows), "midpoint": n_with_mid, "forecast_x": n_with_fx, "evidence_x": n_with_ev}


@pytest.fixture(scope="module", params=_CASES, ids=[c[0] for c in _CASES])
def case_payloads(request: pytest.FixtureRequest) -> dict[str, Any]:
    """Run v2 + v3 once per case, share across the three per-case tests."""
    label, dsl, mode = request.param
    _ensure_synth_ready(_GRAPH, enriched=True, bayesian=False, check_fe_parity=False)
    v2 = _run_analyse(_GRAPH, dsl, analysis_type="cohort_maturity_v2")
    v3 = _run_analyse(_GRAPH, dsl, analysis_type="cohort_maturity")
    return {
        "label": label,
        "dsl": dsl,
        "mode": mode,
        "v2": v2,
        "v3": v3,
        "v2_rows": _rows(v2),
        "v3_rows": _rows(v3),
    }


@requires_db
@requires_data_repo
@requires_python_be
class TestV2V3ParityOutsideIn:
    """Phase 1 health checks + Phase 2 parity comparison."""

    def test_graph_file_exists(self) -> None:
        if _GRAPH_FILE is None or not _GRAPH_FILE.exists():
            pytest.fail(f"graph file missing: {_GRAPH_FILE}")

    def test_non_dropout_edges_have_param_id(self) -> None:
        if _GRAPH_FILE is None or not _GRAPH_FILE.exists():
            pytest.skip(f"graph file missing: {_GRAPH_FILE}")
        graph = json.loads(_GRAPH_FILE.read_text())
        nmap = {n["uuid"]: n.get("id", "") for n in graph["nodes"]}
        n = sum(
            1 for e in graph["edges"]
            if "dropout" not in nmap.get(e.get("to", ""), "")
            and (e.get("p") or {}).get("id", "")
        )
        assert n > 0, "no non-dropout edges with p.id"

    def test_snapshot_db_has_rows_per_edge(self) -> None:
        conn_str = _resolve_db_url()
        if not conn_str:
            pytest.skip("DB_CONNECTION not set")
        if _GRAPH_FILE is None or not _GRAPH_FILE.exists():
            pytest.skip(f"graph file missing: {_GRAPH_FILE}")
        try:
            import psycopg2
        except ImportError:
            pytest.skip("psycopg2 not installed")

        graph = json.loads(_GRAPH_FILE.read_text())
        nmap = {n["uuid"]: n.get("id", "") for n in graph["nodes"]}

        missing: list[str] = []
        with psycopg2.connect(conn_str) as conn:
            with conn.cursor() as cur:
                for e in graph["edges"]:
                    p_id = (e.get("p") or {}).get("id", "")
                    f_name = nmap.get(e.get("from", ""), "")
                    t_name = nmap.get(e.get("to", ""), "")
                    if not p_id or "dropout" in t_name:
                        continue
                    cur.execute(
                        "SELECT slice_key, COUNT(*) FROM snapshots "
                        "WHERE param_id LIKE %s AND core_hash NOT LIKE 'PLACEHOLDER%%' "
                        "GROUP BY slice_key",
                        (f"%{p_id}",),
                    )
                    rows = cur.fetchall()
                    has_cohort = any(sk == "cohort()" and n > 0 for sk, n in rows)
                    has_window = any(sk == "window()" and n > 0 for sk, n in rows)
                    if not (has_cohort and has_window):
                        missing.append(
                            f"{f_name} -> {t_name}: cohort={has_cohort} window={has_window}"
                        )

        if missing:
            pytest.fail(
                f"{len(missing)} edges missing snapshot data:\n  "
                + "\n  ".join(missing)
            )

    def test_v2_returns_non_vacuous_data(self, case_payloads: dict[str, Any]) -> None:
        s = _summarise_rows(case_payloads["v2_rows"])
        assert s["total"] > 5 and s["midpoint"] > 0 and s["evidence_x"] > 0, (
            f"v2 [{case_payloads['label']}] vacuous: "
            f"total={s['total']} midpoint={s['midpoint']} "
            f"forecast_x={s['forecast_x']} evidence_x={s['evidence_x']}"
        )

    def test_v3_returns_non_vacuous_data(self, case_payloads: dict[str, Any]) -> None:
        s = _summarise_rows(case_payloads["v3_rows"])
        assert s["total"] > 5 and s["midpoint"] > 0 and s["evidence_x"] > 0, (
            f"v3 [{case_payloads['label']}] vacuous: "
            f"total={s['total']} midpoint={s['midpoint']} "
            f"forecast_x={s['forecast_x']} evidence_x={s['evidence_x']}"
        )

    def test_midpoint_parity_per_tau(self, case_payloads: dict[str, Any]) -> None:
        v2_by_tau = {r["tau_days"]: r for r in case_payloads["v2_rows"] if "tau_days" in r}
        v3_by_tau = {r["tau_days"]: r for r in case_payloads["v3_rows"] if "tau_days" in r}
        shared = sorted(set(v2_by_tau) & set(v3_by_tau))
        if len(shared) < 5:
            pytest.fail(
                f"[{case_payloads['label']}] too few shared tau ({len(shared)}) for parity"
            )

        failures: list[str] = []
        for tau in shared:
            r2, r3 = v2_by_tau[tau], v3_by_tau[tau]
            m2, m3 = r2.get("midpoint"), r3.get("midpoint")
            if m2 is None or m3 is None:
                continue
            d = abs(m2 - m3)
            if d > _MIDPOINT_TOL:
                failures.append(
                    f"τ={tau}: v2={m2:.4f} v3={m3:.4f} |Δ|={d:.4f} > tol={_MIDPOINT_TOL}"
                )

        if failures:
            table = ["TAU  |  v2 mid  |  v3 mid  |  Δ mid  |  v2 fx   |  v3 fx"]
            for tau in shared[:25]:
                r2, r3 = v2_by_tau[tau], v3_by_tau[tau]
                m2 = r2.get("midpoint")
                m3 = r3.get("midpoint")
                dm = abs(m2 - m3) if m2 is not None and m3 is not None else 0
                fx2 = r2.get("forecast_x")
                fx3 = r3.get("forecast_x")
                f = lambda v: f"{v:8.4f}" if isinstance(v, (int, float)) else "    None"
                fx = lambda v: f"{v:8.1f}" if isinstance(v, (int, float)) else "    None"
                table.append(
                    f"{tau:4d} | {f(m2)} | {f(m3)} | {dm:7.4f} | {fx(fx2)} | {fx(fx3)}"
                )

            report = (
                f"\n[{case_payloads['label']}] {len(failures)} τ exceed tolerance\n"
                + "\n".join(table)
                + "\n\nFailures (first 10):\n  "
                + "\n  ".join(failures[:10])
            )
            pytest.fail(report)
