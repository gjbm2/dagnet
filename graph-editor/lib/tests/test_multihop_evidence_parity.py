"""Multi-hop cohort/window metamorphic canary (doc 64 Family D + G).

Two metamorphic claims that pin down subject-evidence selection on
``synth-mirror-4step``:

  Claim 1 — COLLAPSE on non-latent upstream.
    Subject ``from(m4-delegated).to(m4-success)``. Upstream
    ``m4-landing → m4-created → m4-delegated`` is instant. cohort()
    and window() must agree on evidence_x, evidence_y, and midpoint.

  Claim 2 — DIVERGE on latent upstream.
    Subject ``from(m4-registered).to(m4-success)``. Upstream
    ``m4-delegated → m4-registered`` has latency. cohort() and
    window() evidence_x must differ — proves the Claim-1 fix wasn't
    applied too broadly.

A retained v2 cross-version signal helps distinguish "v3 regression"
from "shared defect" when Claim 1 fails. It will be removed alongside
v2 (doc 64 §8.3, §11).

Replaces ``graph-ops/scripts/multihop-evidence-parity-test.sh``. The
bash file is preserved as a thin shim that delegates here.
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

GRAPH = "synth-mirror-4step"
DATE_RANGE = "1-Feb-26:15-Mar-26"

MULTIHOP_DSL = "from(m4-delegated).to(m4-success)"
SINGLEHOP_DSL = "from(m4-registered).to(m4-success)"

MIN_TAU_COLLAPSE = 3  # below this, sweep boundary artefact masks the rule.


def _python_be_reachable() -> bool:
    try:
        import urllib.request
        with urllib.request.urlopen(
            f"{_PYTHON_BE_URL}/__dagnet/server-info", timeout=2,
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


def _analyse(dsl: str, *, analysis_type: str) -> dict[str, Any]:
    args = [
        "--graph", _DATA_REPO_PATH or "",
        "--name", GRAPH,
        "--query", dsl,
        "--type", analysis_type,
        "--no-cache", "--no-snapshot-cache",
        "--format", "json",
    ]
    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        try:
            return client.call_json("analyse", args)
        except DaemonError as exc:
            raise AssertionError(
                f"daemon analyse failed for {dsl!r} type={analysis_type} "
                f"(exit {exc.exit_code}): {exc}\nstderr:\n{exc.stderr[-2000:]}"
            )
    cmd = ["bash", str(_ANALYSE_SH), GRAPH, dsl,
           "--type", analysis_type, "--no-cache", "--no-snapshot-cache",
           "--format", "json"]
    result = subprocess.run(cmd, capture_output=True, text=True,
                            cwd=str(_REPO_ROOT), timeout=300)
    if result.returncode != 0:
        raise AssertionError(
            f"analyse.sh exited {result.returncode}\nstderr:\n{result.stderr[-2000:]}"
        )
    idx = result.stdout.find("{")
    return json.loads(result.stdout[idx:])


def _rows_by_tau(payload: dict[str, Any]) -> dict[int, dict[str, Any]]:
    rows = (payload.get("result") or {}).get("data") or []
    return {int(r["tau_days"]): r for r in rows if "tau_days" in r}


# ── Module fixtures: one analyse() per (DSL, mode, type) tuple ──────────────

@pytest.fixture(scope="module")
def _ready_synth() -> None:
    _ensure_synth_ready(GRAPH, enriched=True, check_fe_parity=False)


@pytest.fixture(scope="module")
def v3_window_multihop(_ready_synth) -> dict[str, Any]:
    return _analyse(f"{MULTIHOP_DSL}.window({DATE_RANGE})",
                    analysis_type="cohort_maturity")


@pytest.fixture(scope="module")
def v3_cohort_multihop(_ready_synth) -> dict[str, Any]:
    return _analyse(f"{MULTIHOP_DSL}.cohort({DATE_RANGE})",
                    analysis_type="cohort_maturity")


@pytest.fixture(scope="module")
def v2_window_multihop(_ready_synth) -> dict[str, Any]:
    return _analyse(f"{MULTIHOP_DSL}.window({DATE_RANGE})",
                    analysis_type="cohort_maturity_v2")


@pytest.fixture(scope="module")
def v2_cohort_multihop(_ready_synth) -> dict[str, Any]:
    return _analyse(f"{MULTIHOP_DSL}.cohort({DATE_RANGE})",
                    analysis_type="cohort_maturity_v2")


@pytest.fixture(scope="module")
def v3_window_singlehop(_ready_synth) -> dict[str, Any]:
    return _analyse(f"{SINGLEHOP_DSL}.window({DATE_RANGE})",
                    analysis_type="cohort_maturity")


@pytest.fixture(scope="module")
def v3_cohort_singlehop(_ready_synth) -> dict[str, Any]:
    return _analyse(f"{SINGLEHOP_DSL}.cohort({DATE_RANGE})",
                    analysis_type="cohort_maturity")


# ── Comparison helpers ──────────────────────────────────────────────────────

def _collapse_table(
    w_by_tau: dict[int, dict[str, Any]],
    c_by_tau: dict[int, dict[str, Any]],
    *,
    field: str,
    tol: float,
    min_tau: int,
    skip_zero_w: bool = True,
    fmt: str = "10.0f",
    fmt_w_label: str = "window_x",
    fmt_c_label: str = "cohort_x",
) -> tuple[list[int], str]:
    """Return (failing taus, diagnostic table string).

    Mirrors the bash python3 inline blocks: print up to 15 rows or any
    rows with gap >= tol; mark failures with ✗.
    """
    shared = sorted(set(w_by_tau) & set(c_by_tau))
    rows: list[str] = []
    rows.append(f'  {"tau":>4s}  {fmt_w_label:>10s}  {fmt_c_label:>10s}  {"ratio":>8s}')

    failures: list[int] = []
    printed = 0
    for tau in shared:
        if tau < min_tau:
            continue
        w = w_by_tau[tau].get(field)
        c = c_by_tau[tau].get(field)
        if w is None or c is None:
            continue
        if skip_zero_w and w == 0:
            continue
        if w == 0 and c == 0:
            continue
        if w == 0:
            failures.append(tau)
            continue
        ratio = c / w
        gap = abs(1.0 - ratio)
        if printed < 15 or gap >= tol:
            marker = " ✗" if gap >= tol else ""
            rows.append(f"  {tau:4d}  {w:{fmt}}  {c:{fmt}}  {ratio:8.3f}{marker}")
            printed += 1
        if gap >= tol:
            failures.append(tau)
    return failures, "\n".join(rows)


def _midpoint_table(
    w_by_tau: dict[int, dict[str, Any]],
    c_by_tau: dict[int, dict[str, Any]],
    *,
    tol: float,
) -> tuple[list[int], str]:
    shared = sorted(set(w_by_tau) & set(c_by_tau))
    rows: list[str] = []
    rows.append(f'  {"tau":>4s}  {"window_mid":>12s}  {"cohort_mid":>12s}  {"ratio":>8s}')

    failures: list[int] = []
    printed = 0
    for tau in shared:
        w = w_by_tau[tau].get("midpoint")
        c = c_by_tau[tau].get("midpoint")
        if w is None or c is None:
            continue
        if w < 0.001:
            continue
        ratio = c / w
        gap = abs(1.0 - ratio)
        if printed < 15 or gap >= tol:
            marker = " ✗" if gap >= tol else ""
            rows.append(f"  {tau:4d}  {w:12.5f}  {c:12.5f}  {ratio:8.3f}{marker}")
            printed += 1
        if gap >= tol:
            failures.append(tau)
    return failures, "\n".join(rows)


# ── Tests ───────────────────────────────────────────────────────────────────

@requires_db
@requires_data_repo
@requires_python_be
class TestMultihopCollapse:
    """Claim 1: cohort vs window collapse on non-latent upstream multi-hop."""

    def test_evidence_x_parity(self, v3_window_multihop, v3_cohort_multihop) -> None:
        w = _rows_by_tau(v3_window_multihop)
        c = _rows_by_tau(v3_cohort_multihop)
        if not w or not c:
            pytest.fail(f"no data returned (window={len(w)}, cohort={len(c)})")
        failures, table = _collapse_table(
            w, c, field="evidence_x", tol=0.05, min_tau=MIN_TAU_COLLAPSE,
            fmt="10.0f", fmt_w_label="window_x", fmt_c_label="cohort_x",
        )
        if failures:
            pytest.fail(
                f"evidence_x diverges at {len(failures)} tau values (>5% gap)\n"
                f"{table}"
            )

    def test_evidence_y_parity(self, v3_window_multihop, v3_cohort_multihop) -> None:
        w = _rows_by_tau(v3_window_multihop)
        c = _rows_by_tau(v3_cohort_multihop)
        if not w or not c:
            pytest.fail("no data returned")
        # bash uses skip_zero_w=False so both 0 are skipped silently and
        # window=0 alone counts as a failure. Mirror by not skipping.
        failures, table = _collapse_table(
            w, c, field="evidence_y", tol=0.05, min_tau=0,
            skip_zero_w=False,
            fmt="10.0f", fmt_w_label="window_y", fmt_c_label="cohort_y",
        )
        if failures:
            pytest.fail(
                f"evidence_y diverges at {len(failures)} tau values (>5% gap)\n"
                f"{table}"
            )

    def test_midpoint_parity(self, v3_window_multihop, v3_cohort_multihop) -> None:
        w = _rows_by_tau(v3_window_multihop)
        c = _rows_by_tau(v3_cohort_multihop)
        if not w or not c:
            pytest.fail("no data returned")
        failures, table = _midpoint_table(w, c, tol=0.15)
        if failures:
            pytest.fail(
                f"midpoint diverges at {len(failures)} tau values (>15% gap)\n"
                f"{table}"
            )


@requires_db
@requires_data_repo
@requires_python_be
class TestV2CrossVersionSignal:
    """Diagnostic: when Claim 1 fails, does v2 also fail (shared defect)
    or pass (v3 regression)? Will be removed alongside v2."""

    def test_v2_multihop_collapse_holds(
        self, v2_window_multihop, v2_cohort_multihop,
    ) -> None:
        w = _rows_by_tau(v2_window_multihop)
        c = _rows_by_tau(v2_cohort_multihop)
        if not w or not c:
            pytest.fail("no V2 data returned — v2 retired or BE rejected query")
        failures, _table = _collapse_table(
            w, c, field="evidence_x", tol=0.05, min_tau=MIN_TAU_COLLAPSE,
            fmt="10.0f",
        )
        if failures:
            pytest.fail(
                f"V2 evidence_x also diverges at {len(failures)} tau values — "
                "defect is shared, not v3-specific"
            )


@requires_db
@requires_data_repo
@requires_python_be
class TestSinglehopDiverge:
    """Claim 2: cohort and window must differ on a single-hop with latent upstream."""

    def test_singlehop_evidence_x_diverges(
        self, v3_window_singlehop, v3_cohort_singlehop,
    ) -> None:
        w = _rows_by_tau(v3_window_singlehop)
        c = _rows_by_tau(v3_cohort_singlehop)
        if not w or not c:
            pytest.fail("no single-hop data returned")
        shared = sorted(set(w) & set(c))
        divergent = 0
        for tau in shared:
            w_x = w[tau].get("evidence_x")
            c_x = c[tau].get("evidence_x")
            if w_x is not None and c_x is not None and w_x > 0:
                if abs(c_x / w_x - 1.0) > 0.05:
                    divergent += 1
        if divergent == 0:
            pytest.fail(
                "single-hop evidence_x identical between cohort and window — "
                "fix may have been applied too broadly"
            )
