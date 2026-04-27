"""asat() blind contract tests (doc 42) — outside-in CLI harness.

Asserts the doc 42 invariants for the asat() DSL operator by comparing
CLI output with and without asat in the DSL. Two graphs:

  - synth-simple-abc          single-hop, single epoch
  - synth-context-solo-mixed  two epochs (bare aggregate vs contexted MECE)

Replaces ``graph-ops/scripts/asat-blind-test.sh``. The bash file is
preserved as a thin shim that delegates here.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
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


# ── Graph + DSL constants (mirror the bash original) ────────────────────────

GRAPH_ABC = "synth-simple-abc"
EDGE_ABC = "simple-a-to-b"
FULL_WINDOW = "window(12-Dec-25:20-Mar-26)"
ASAT_EARLY = "15-Jan-26"
ASAT_BEFORE = "11-Dec-25"
ASAT_MID = "15-Feb-26"
ASAT_LATE = "18-Mar-26"

COHORT_DSL_ABC = "from(simple-a).to(simple-b).cohort(12-Dec-25:21-Mar-26)"

GRAPH_MIXED = "synth-context-solo-mixed"
EDGE_MIXED = "synth-context-solo-mixed-synth-ctx1-anchor-to-target"
MIXED_WINDOW = "window(12-Dec-25:11-Mar-26)"
MIXED_ASAT_EPOCH1 = "20-Jan-26"  # day ~39 — bare-only epoch
MIXED_ASAT_EPOCH2 = "10-Feb-26"  # day ~60 — contexted epoch


# ── CLI plumbing ────────────────────────────────────────────────────────────

def _param_pack(graph: str, dsl: str) -> dict[str, Any]:
    """Run param-pack and return the flat JSON payload.

    Bypasses both caches: --no-cache (disk bundle) and
    --no-snapshot-cache (BE TTL). Test correctness requires every
    invocation to recompute against the live BE so that a stale
    cached answer cannot mask a regression.
    """
    args = [
        "--graph", _DATA_REPO_PATH or "",
        "--name", graph,
        "--query", dsl,
        "--no-cache", "--no-snapshot-cache", "--format", "json",
    ]
    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        try:
            return client.call_json("param-pack", args)
        except DaemonError as exc:
            raise AssertionError(
                f"daemon param-pack failed for {graph} / {dsl!r} "
                f"(exit {exc.exit_code}): {exc}\nstderr:\n{exc.stderr[-2000:]}"
            )

    cmd = ["bash", str(_PARAM_PACK_SH), graph, dsl,
           "--no-cache", "--no-snapshot-cache", "--format", "json"]
    result = subprocess.run(cmd, capture_output=True, text=True,
                            cwd=str(_REPO_ROOT), timeout=300)
    if result.returncode != 0:
        raise AssertionError(
            f"param-pack.sh exited {result.returncode} for {graph} / {dsl!r}\n"
            f"stderr:\n{result.stderr[-2000:]}"
        )
    idx = result.stdout.find("{")
    return json.loads(result.stdout[idx:])


def _analyse_cohort_maturity(graph: str, dsl: str) -> dict[str, Any]:
    """Run cohort_maturity analyse and return the JSON payload."""
    args = [
        "--graph", _DATA_REPO_PATH or "",
        "--name", graph,
        "--query", dsl,
        "--type", "cohort_maturity",
        "--no-cache", "--no-snapshot-cache",
        "--format", "json",
    ]
    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        try:
            return client.call_json("analyse", args)
        except DaemonError as exc:
            raise AssertionError(
                f"daemon analyse failed for {graph} / {dsl!r} "
                f"(exit {exc.exit_code}): {exc}\nstderr:\n{exc.stderr[-2000:]}"
            )

    cmd = ["bash", str(_ANALYSE_SH), graph, dsl,
           "--type", "cohort_maturity", "--no-cache", "--no-snapshot-cache",
           "--format", "json"]
    result = subprocess.run(cmd, capture_output=True, text=True,
                            cwd=str(_REPO_ROOT), timeout=300)
    if result.returncode != 0:
        raise AssertionError(
            f"analyse.sh exited {result.returncode} for {graph} / {dsl!r}\n"
            f"stderr:\n{result.stderr[-2000:]}"
        )
    idx = result.stdout.find("{")
    return json.loads(result.stdout[idx:])


def _scalar(payload: dict[str, Any], key: str) -> Optional[Any]:
    """Read e.EDGE.p.X from a flat param-pack payload."""
    return payload.get(key)


def _maturity_row(payload: dict[str, Any], tau: int) -> Optional[dict[str, Any]]:
    rows = (payload.get("result") or {}).get("data") or []
    for r in rows:
        if r.get("tau_days") == tau:
            return r
    return None


# ── Module-scoped payloads (cached across the suite) ────────────────────────
# A single param-pack call is reused by every test that needs its scalars.
# Pytest module fixtures + lru_cache by argument tuples in _param_pack would
# both work; module fixtures keep call-graph visibility plain.

@pytest.fixture(scope="module")
def abc_baseline_pp() -> dict[str, Any]:
    _ensure_synth_ready(GRAPH_ABC, enriched=True, check_fe_parity=False)
    return _param_pack(GRAPH_ABC, FULL_WINDOW)


@pytest.fixture(scope="module")
def abc_asat_early_pp() -> dict[str, Any]:
    _ensure_synth_ready(GRAPH_ABC, enriched=True, check_fe_parity=False)
    return _param_pack(GRAPH_ABC, f"{FULL_WINDOW}.asat({ASAT_EARLY})")


@pytest.fixture(scope="module")
def abc_asat_before_pp() -> dict[str, Any]:
    _ensure_synth_ready(GRAPH_ABC, enriched=True, check_fe_parity=False)
    return _param_pack(GRAPH_ABC, f"{FULL_WINDOW}.asat({ASAT_BEFORE})")


@pytest.fixture(scope="module")
def abc_asat_mid_pp() -> dict[str, Any]:
    _ensure_synth_ready(GRAPH_ABC, enriched=True, check_fe_parity=False)
    return _param_pack(GRAPH_ABC, f"{FULL_WINDOW}.asat({ASAT_MID})")


@pytest.fixture(scope="module")
def abc_cm_baseline() -> dict[str, Any]:
    _ensure_synth_ready(GRAPH_ABC, enriched=True, check_fe_parity=False)
    return _analyse_cohort_maturity(GRAPH_ABC, COHORT_DSL_ABC)


@pytest.fixture(scope="module")
def abc_cm_asat_early() -> dict[str, Any]:
    _ensure_synth_ready(GRAPH_ABC, enriched=True, check_fe_parity=False)
    return _analyse_cohort_maturity(GRAPH_ABC, f"{COHORT_DSL_ABC}.asat({ASAT_EARLY})")


@pytest.fixture(scope="module")
def abc_cm_asat_late() -> dict[str, Any]:
    _ensure_synth_ready(GRAPH_ABC, enriched=True, check_fe_parity=False)
    return _analyse_cohort_maturity(GRAPH_ABC, f"{COHORT_DSL_ABC}.asat({ASAT_LATE})")


@pytest.fixture(scope="module")
def mixed_baseline_pp() -> dict[str, Any]:
    _ensure_synth_ready(GRAPH_MIXED, enriched=True, check_fe_parity=False)
    return _param_pack(GRAPH_MIXED, MIXED_WINDOW)


@pytest.fixture(scope="module")
def mixed_asat_epoch1_pp() -> dict[str, Any]:
    _ensure_synth_ready(GRAPH_MIXED, enriched=True, check_fe_parity=False)
    return _param_pack(GRAPH_MIXED, f"{MIXED_WINDOW}.asat({MIXED_ASAT_EPOCH1})")


@pytest.fixture(scope="module")
def mixed_asat_epoch2_pp() -> dict[str, Any]:
    _ensure_synth_ready(GRAPH_MIXED, enriched=True, check_fe_parity=False)
    return _param_pack(GRAPH_MIXED, f"{MIXED_WINDOW}.asat({MIXED_ASAT_EPOCH2})")


@pytest.fixture(scope="module")
def mixed_ctx_asat_epoch2_pp() -> dict[str, Any]:
    _ensure_synth_ready(GRAPH_MIXED, enriched=True, check_fe_parity=False)
    return _param_pack(
        GRAPH_MIXED,
        f"context(synth-channel:google).{MIXED_WINDOW}.asat({MIXED_ASAT_EPOCH2})",
    )


# ── synth-simple-abc: evidence filtering and signature contracts ───────────

@requires_db
@requires_data_repo
@requires_python_be
class TestAsatEvidenceFiltering:
    """T1, T2, T3, T3b, T4: asat() filters evidence on synth-simple-abc."""

    # ── T1a ──────────────────────────────────────────────────────────────
    def test_t1a_baseline_evidence_present(self, abc_baseline_pp) -> None:
        k = _scalar(abc_baseline_pp, f"e.{EDGE_ABC}.p.evidence.k")
        if k is None:
            pytest.fail("no evidence.k in baseline param-pack")

    # ── T1b ──────────────────────────────────────────────────────────────
    def test_t1b_asat_evidence_less_mature(
        self, abc_baseline_pp, abc_asat_early_pp,
    ) -> None:
        k_b = _scalar(abc_baseline_pp, f"e.{EDGE_ABC}.p.evidence.k")
        k_a = _scalar(abc_asat_early_pp, f"e.{EDGE_ABC}.p.evidence.k")
        if k_a is None:
            pytest.fail("no evidence.k in asat param-pack — asat fork producing no evidence")
        if k_b == k_a:
            pytest.fail(
                f"k identical with and without asat (both={k_b}). "
                f"asat evidence filtering not working."
            )
        if not (float(k_a) < float(k_b)):
            pytest.fail(f"k_asat ({k_a}) >= k_baseline ({k_b}). Expected less mature data.")

    # ── T1c ──────────────────────────────────────────────────────────────
    def test_t1c_blended_pmean_differs(
        self, abc_baseline_pp, abc_asat_early_pp,
    ) -> None:
        m_b = _scalar(abc_baseline_pp, f"e.{EDGE_ABC}.p.mean")
        m_a = _scalar(abc_asat_early_pp, f"e.{EDGE_ABC}.p.mean")
        if m_b is None or m_a is None:
            pytest.fail(f"could not retrieve p.mean (baseline={m_b!r}, asat={m_a!r})")
        if m_b == m_a:
            pytest.fail(
                f"p.mean identical with and without asat (both={m_b}). "
                f"asat not affecting blended rate."
            )

    # ── T2 ───────────────────────────────────────────────────────────────
    def test_t2_asat_before_data_returns_no_evidence(self, abc_asat_before_pp) -> None:
        k = _scalar(abc_asat_before_pp, f"e.{EDGE_ABC}.p.evidence.k")
        # Empty or 0 are both acceptable: asat before any retrieval → no rows.
        if k is None or k == 0:
            return
        pytest.fail(f"k={k} for asat before first retrieval. Expected 0 or empty.")

    # ── T3 ───────────────────────────────────────────────────────────────
    def test_t3_signature_unchanged_by_asat(self) -> None:
        """asat() must not pollute the per-edge signature hash.

        Uses subprocess directly: --show-signatures emits via log.info to
        stderr, which the daemon does not capture per-request. The bash
        original used `2>&1` and grep, mirrored here.
        """
        sig_re = re.compile(r"hash=(\S+)")

        def run_signatures(dsl: str) -> Optional[str]:
            cmd = ["bash", str(_PARAM_PACK_SH), GRAPH_ABC, dsl, "--show-signatures"]
            result = subprocess.run(
                cmd, capture_output=True, text=True,
                cwd=str(_REPO_ROOT), timeout=300,
            )
            for line in (result.stdout + result.stderr).splitlines():
                if EDGE_ABC in line and "hash=" in line:
                    m = sig_re.search(line)
                    if m:
                        return m.group(1)
            return None

        h_baseline = run_signatures(FULL_WINDOW)
        h_asat = run_signatures(f"{FULL_WINDOW}.asat({ASAT_EARLY})")
        if h_baseline is None or h_asat is None:
            pytest.fail(
                f"could not retrieve signatures (baseline={h_baseline!r}, asat={h_asat!r})"
            )
        if h_baseline != h_asat:
            pytest.fail(
                f"signature hash differs: baseline={h_baseline}, asat={h_asat}. "
                f"asat is polluting the signature."
            )

    # ── T3b ──────────────────────────────────────────────────────────────
    def test_t3b_evidence_n_differs(
        self, abc_baseline_pp, abc_asat_early_pp,
    ) -> None:
        n_b = _scalar(abc_baseline_pp, f"e.{EDGE_ABC}.p.evidence.n")
        n_a = _scalar(abc_asat_early_pp, f"e.{EDGE_ABC}.p.evidence.n")
        if n_b is None or n_a is None:
            pytest.fail(f"could not retrieve evidence.n (baseline={n_b!r}, asat={n_a!r})")
        if n_a == 0:
            pytest.fail("asat evidence.n is 0 — hash mismatch? Snapshot DB returned no rows.")
        if n_a == n_b:
            pytest.fail(f"evidence.n identical — asat not filtering (both={n_b})")

    # ── T4 ───────────────────────────────────────────────────────────────
    def test_t4_cohort_maturity_projected_rate_differs(
        self, abc_cm_baseline, abc_cm_asat_early,
    ) -> None:
        b_row = _maturity_row(abc_cm_baseline, 10)
        a_row = _maturity_row(abc_cm_asat_early, 10)
        if b_row is None:
            pytest.fail("no tau=10 row in baseline cohort_maturity (BE running?)")
        if a_row is None:
            pytest.fail("no tau=10 row in asat cohort_maturity")
        b_proj = b_row.get("projected_rate")
        a_proj = a_row.get("projected_rate")
        if b_proj is None:
            pytest.fail("could not retrieve baseline projected_rate at tau=10")
        if a_proj is None:
            pytest.fail(f"asat projected_rate missing at tau=10 (baseline={b_proj})")
        if b_proj == a_proj:
            pytest.fail(
                f"cohort_maturity projected_rate identical with and without asat "
                f"(both={b_proj}). asat not affecting analysis."
            )


# ── synth-simple-abc: read-only contract ────────────────────────────────────

@requires_db
@requires_data_repo
@requires_python_be
class TestAsatReadOnly:
    """T5: an asat query must not modify any param files on disk."""

    def _checksum_param_dir(self) -> str:
        if _DATA_REPO_PATH is None:
            return ""
        param_dir = Path(_DATA_REPO_PATH) / "parameters"
        if not param_dir.is_dir():
            return ""
        h = hashlib.sha256()
        for p in sorted(param_dir.iterdir()):
            if p.suffix in (".yaml", ".json") and p.is_file():
                h.update(p.name.encode())
                h.update(b":")
                h.update(p.read_bytes())
                h.update(b"\n")
        return h.hexdigest()

    def test_t5_param_files_unchanged_after_asat(self) -> None:
        _ensure_synth_ready(GRAPH_ABC, enriched=True, check_fe_parity=False)
        before = self._checksum_param_dir()
        _param_pack(GRAPH_ABC, f"{FULL_WINDOW}.asat({ASAT_EARLY})")
        after = self._checksum_param_dir()
        if before != after:
            pytest.fail("param files changed after asat query. asat is NOT read-only.")


# ── synth-context-solo-mixed: epoch + context boundaries ────────────────────

@requires_db
@requires_data_repo
@requires_python_be
class TestAsatMixedEpoch:
    """T6, T7, T8: asat across mixed bare/contexted epochs."""

    def test_t6_asat_in_bare_epoch_returns_evidence(
        self, mixed_baseline_pp, mixed_asat_epoch1_pp,
    ) -> None:
        k_b = _scalar(mixed_baseline_pp, f"e.{EDGE_MIXED}.p.evidence.k")
        k_e1 = _scalar(mixed_asat_epoch1_pp, f"e.{EDGE_MIXED}.p.evidence.k")
        if k_b is None:
            pytest.fail("no baseline evidence.k for mixed-epoch graph")
        if k_e1 is None:
            pytest.fail(
                "no evidence.k for asat in epoch 1 (bare). Hash mismatch? "
                "Stored sig may be contexted but epoch 1 data uses bare hash."
            )
        if k_e1 == 0:
            pytest.fail(
                "evidence.k=0 for asat in epoch 1. Snapshot query returned no rows — "
                "likely hash family mismatch."
            )
        if not (float(k_e1) < float(k_b)):
            pytest.fail(f"k_epoch1 ({k_e1}) >= k_baseline ({k_b})")

    def test_t7_asat_in_contexted_epoch_returns_evidence(
        self, mixed_asat_epoch1_pp, mixed_asat_epoch2_pp,
    ) -> None:
        k_e2 = _scalar(mixed_asat_epoch2_pp, f"e.{EDGE_MIXED}.p.evidence.k")
        if k_e2 is None:
            pytest.fail("no evidence.k for asat in epoch 2 (contexted)")
        if k_e2 == 0:
            pytest.fail("evidence.k=0 for asat in epoch 2")
        # k_epoch2 should normally be > k_epoch1 (later asat = more mature),
        # but bash treats any non-zero return as PASS so we mirror that.

    def test_t8_context_qualified_asat_in_epoch2(
        self, mixed_ctx_asat_epoch2_pp,
    ) -> None:
        k_ctx = _scalar(
            mixed_ctx_asat_epoch2_pp, f"e.{EDGE_MIXED}.p.evidence.k"
        )
        if k_ctx is None:
            pytest.fail(
                "no evidence.k for context-qualified asat in epoch 2. Known "
                "limitation: stored sig is bare, contexted data under different hash."
            )
        if k_ctx == 0:
            pytest.fail(
                "evidence.k=0 for context-qualified asat. Hash family mismatch — "
                "bare sig can't find contexted rows."
            )


# ── synth-simple-abc: cohort_maturity zone boundaries (D5) ──────────────────

@requires_db
@requires_data_repo
@requires_python_be
class TestAsatCohortMaturityBoundaries:
    """D5a, D5b, D5c: cohort_maturity zone boundaries respect asat."""

    def test_d5a_tau_solid_max_constrained_by_asat(
        self, abc_cm_baseline, abc_cm_asat_late,
    ) -> None:
        b = _maturity_row(abc_cm_baseline, 0)
        a = _maturity_row(abc_cm_asat_late, 0)
        if b is None or b.get("tau_solid_max") is None:
            pytest.fail("could not retrieve baseline tau_solid_max")
        if a is None or a.get("tau_solid_max") is None:
            pytest.fail("could not retrieve asat tau_solid_max")
        if not (float(a["tau_solid_max"]) < 10):
            pytest.fail(
                f"tau_solid_max with asat ({a['tau_solid_max']}) >= 10 — "
                f"not constrained by asat. Baseline={b['tau_solid_max']}."
            )

    def test_d5b_boundary_date_reflects_asat(self, abc_cm_asat_late) -> None:
        from datetime import date
        a = _maturity_row(abc_cm_asat_late, 0)
        if a is None or a.get("boundary_date") is None:
            pytest.fail("could not retrieve boundary_date")
        bd = a["boundary_date"]
        today = date.today().isoformat()
        if bd == today:
            pytest.fail(
                f"boundary_date is today ({today}), not asat date. "
                f"Analysis ignoring asat."
            )

    def test_d5c_evidence_x_differs_with_asat(
        self, abc_cm_baseline, abc_cm_asat_late,
    ) -> None:
        b = _maturity_row(abc_cm_baseline, 10)
        a = _maturity_row(abc_cm_asat_late, 10)
        if b is None or b.get("evidence_x") is None:
            pytest.fail("could not retrieve baseline evidence_x")
        if a is None or a.get("evidence_x") is None:
            pytest.fail("could not retrieve asat evidence_x")
        if b["evidence_x"] == a["evidence_x"]:
            pytest.fail(
                f"evidence_x identical with and without asat (both={b['evidence_x']}). "
                f"Analysis not using asat-filtered data."
            )


# ── synth-simple-abc: completeness at historical age (D3) ───────────────────

@requires_db
@requires_data_repo
@requires_python_be
class TestAsatCompletenessHistorical:
    """D3a-D3d: completeness evaluated at historical age (doc 42 §9)."""

    def test_d3a_completeness_lower_with_early_asat(
        self, abc_baseline_pp, abc_asat_early_pp,
    ) -> None:
        c_b = _scalar(abc_baseline_pp, f"e.{EDGE_ABC}.p.latency.completeness")
        c_a = _scalar(abc_asat_early_pp, f"e.{EDGE_ABC}.p.latency.completeness")
        if c_b is None:
            pytest.fail("could not retrieve baseline completeness")
        if c_a is None:
            pytest.fail(
                "could not retrieve asat completeness. "
                "Completeness may not use evaluation_date."
            )
        if c_b == c_a:
            pytest.fail(
                f"completeness identical with and without asat (both={c_b}). "
                f"evaluation_date not affecting completeness."
            )
        if not (float(c_a) < float(c_b)):
            pytest.fail(
                f"completeness with asat ({c_a}) >= baseline ({c_b}). "
                f"Expected lower completeness for earlier evaluation_date."
            )

    def test_d3b_pstdev_higher_with_early_asat(
        self, abc_baseline_pp, abc_asat_early_pp,
    ) -> None:
        s_b = _scalar(abc_baseline_pp, f"e.{EDGE_ABC}.p.stdev")
        s_a = _scalar(abc_asat_early_pp, f"e.{EDGE_ABC}.p.stdev")
        if s_b is None:
            pytest.fail("could not retrieve baseline p.stdev")
        if s_a is None:
            pytest.fail("could not retrieve asat p.stdev")
        if s_b == s_a:
            pytest.fail(
                f"p.stdev identical (both={s_b}). "
                f"Uncertainty not reflecting historical age."
            )
        # Bash treats "differs but direction unexpected" as PASS as well —
        # the diagnostic value is "evaluation_date is active". Mirror that.

    def test_d3c_completeness_near_zero_for_asat_before_data(
        self, abc_asat_before_pp,
    ) -> None:
        c = _scalar(abc_asat_before_pp, f"e.{EDGE_ABC}.p.latency.completeness")
        if c is None:
            return  # No completeness at all is acceptable.
        if not (float(c) <= 0.05):
            pytest.fail(f"completeness={c} for asat before data. Expected <= 0.05.")

    def test_d3d_completeness_monotonic(
        self, abc_baseline_pp, abc_asat_early_pp, abc_asat_mid_pp,
    ) -> None:
        c_b = _scalar(abc_baseline_pp, f"e.{EDGE_ABC}.p.latency.completeness")
        c_e = _scalar(abc_asat_early_pp, f"e.{EDGE_ABC}.p.latency.completeness")
        c_m = _scalar(abc_asat_mid_pp, f"e.{EDGE_ABC}.p.latency.completeness")
        if c_b is None or c_e is None or c_m is None:
            pytest.fail(
                f"could not retrieve all three completeness values "
                f"(early={c_e}, mid={c_m}, baseline={c_b})"
            )
        if not (float(c_e) < float(c_m) < float(c_b)):
            pytest.fail(
                f"completeness not monotonic: early={c_e}, mid={c_m}, baseline={c_b}. "
                f"Expected early < mid < baseline."
            )
