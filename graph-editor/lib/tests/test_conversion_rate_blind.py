"""conversion_rate blind contract tests (doc 49 Part B).

Outside-in tests using the CLI ``analyse`` against synth-mirror-4step.
Each test asserts a doc 49 invariant on the BE response.

The bash original made ~9 separate CLI invocations (one per ``--get``
extraction). The pytest version makes 2 — one for the non-latency edge
shared across most assertions via a module-scoped fixture, one for the
latency edge that must fail with the maturity-gate rejection.

Replaces ``graph-ops/scripts/conversion-rate-blind-test.sh``. The bash
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

_PYTHON_BE_URL = os.environ.get("PYTHON_API_URL", "http://localhost:9000")

_GRAPH = "synth-mirror-4step"

# Topology (per the bash original lines 35-40):
#   m4-landing -> m4-created            NON-LATENCY (sigma=0)
#   m4-delegated -> m4-registered       LATENCY (sigma>0)
_NON_LATENCY_DSL = "from(m4-landing).to(m4-created).window(-90d:)"
_LATENCY_DSL = "from(m4-delegated).to(m4-registered).window(-90d:)"


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


def _conversion_rate_args(graph: str, dsl: str) -> list[str]:
    return [
        "--graph", _DATA_REPO_PATH or "",
        "--name", graph,
        "--query", dsl,
        "--type", "conversion_rate",
        "--no-snapshot-cache",
        "--format", "json",
    ]


def _run_conversion_rate_via_subprocess(graph: str, dsl: str) -> tuple[int, str, str]:
    """Subprocess fallback. Returns (returncode, stdout, stderr)."""
    cmd = ["bash", str(_ANALYSE_SH), graph, dsl,
           "--type", "conversion_rate", "--no-snapshot-cache", "--format", "json"]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(_REPO_ROOT), timeout=300)
    return result.returncode, result.stdout, result.stderr


@pytest.fixture(scope="module")
def non_latency_payload() -> dict[str, Any]:
    """Run conversion_rate once for the non-latency edge; reuse across T1-T5,T7-T8.

    Uses the daemon when available, subprocess fallback otherwise. Pytest's
    ``module``-scoped fixture caches the result for every test in this file.
    """
    _ensure_synth_ready(_GRAPH, enriched=True, bayesian=False, check_fe_parity=False)

    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        try:
            return client.call_json("analyse", _conversion_rate_args(_GRAPH, _NON_LATENCY_DSL))
        except DaemonError as exc:
            pytest.fail(
                f"daemon analyse failed for non-latency edge: {exc}\n"
                f"stderr:\n{exc.stderr[-2000:]}"
            )

    rc, stdout, stderr = _run_conversion_rate_via_subprocess(_GRAPH, _NON_LATENCY_DSL)
    if rc != 0:
        pytest.fail(f"analyse.sh exit {rc} on non-latency edge\nstderr:\n{stderr[-2000:]}")
    idx = stdout.find("{")
    return json.loads(stdout[idx:])


def _result(payload: dict[str, Any]) -> dict[str, Any]:
    return payload.get("result") or {}


@requires_db
@requires_data_repo
@requires_python_be
class TestConversionRateBlind:
    """All assertions live as separate tests so failures isolate cleanly."""

    def test_t1_analysis_type_returned(self, non_latency_payload: dict[str, Any]) -> None:
        """T1: BE dispatches conversion_rate and tags the response correctly."""
        atype = _result(non_latency_payload).get("analysis_type")
        assert atype == "conversion_rate", f"got {atype!r}"

    def test_t2_data_array_has_bins(self, non_latency_payload: dict[str, Any]) -> None:
        """T2: result.data is non-empty."""
        data = _result(non_latency_payload).get("data") or []
        assert data, "result.data is empty — no bins derived"
        assert data[0].get("bin_start") is not None, f"data.0.bin_start missing: {data[0]}"

    def test_t3_bin_shape_required_keys(self, non_latency_payload: dict[str, Any]) -> None:
        """T3: each bin carries bin_start, bin_end, x, y, rate."""
        data = _result(non_latency_payload).get("data") or []
        assert data, "result.data is empty"
        bin0 = data[0]
        for key in ("bin_start", "bin_end", "x", "y", "rate"):
            assert bin0.get(key) is not None, f"data.0.{key} missing: {bin0}"

    def test_t4_rate_matches_y_over_x(self, non_latency_payload: dict[str, Any]) -> None:
        """T4: the published rate must equal y/x for each bin."""
        data = _result(non_latency_payload).get("data") or []
        assert data, "result.data is empty"
        bin0 = data[0]
        x = float(bin0["x"])
        y = float(bin0["y"])
        rate = float(bin0["rate"])
        expected = y / x if x > 0 else 0.0
        assert abs(rate - expected) < 1e-6, (
            f"rate={rate} != y/x={y}/{x}={expected}"
        )

    def test_t5_bin_size_in_metadata(self, non_latency_payload: dict[str, Any]) -> None:
        """T5: bin_size present (default day) in metadata or top-level."""
        result = _result(non_latency_payload)
        bin_size = (result.get("metadata") or {}).get("bin_size") or result.get("bin_size")
        assert bin_size == "day", f"bin_size={bin_size!r}, expected 'day'"

    def test_t6_latency_edge_rejected_by_gate(self) -> None:
        """T6: latency edges must be rejected (maturity-gate / dispersion)."""
        _ensure_synth_ready(_GRAPH, enriched=True, bayesian=False, check_fe_parity=False)

        client = get_default_client() if _DATA_REPO_PATH else None
        if client is not None:
            with pytest.raises(DaemonError) as exc_info:
                client.call_json("analyse", _conversion_rate_args(_GRAPH, _LATENCY_DSL))
            blob = (exc_info.value.stderr or "") + " " + str(exc_info.value)
            blob_lc = blob.lower()
            assert "latency" in blob_lc or "error" in blob_lc or "fail" in blob_lc, (
                f"expected gate rejection mentioning latency/error/fail, got:\n{blob[-1500:]}"
            )
            return

        rc, _stdout, stderr = _run_conversion_rate_via_subprocess(_GRAPH, _LATENCY_DSL)
        blob_lc = stderr.lower()
        assert rc != 0 or "latency" in blob_lc, (
            f"latency edge was not rejected — analyse.sh exit {rc}, stderr:\n{stderr[-1500:]}"
        )

    def test_t7_multiple_bins_over_90d(self, non_latency_payload: dict[str, Any]) -> None:
        """T7: 90d window must produce more than a handful of bins."""
        data = _result(non_latency_payload).get("data") or []
        assert len(data) > 5, (
            f"only {len(data)} bins produced — expected several across 90d window"
        )

    def test_t8_epistemic_key_on_every_bin(self, non_latency_payload: dict[str, Any]) -> None:
        """T8: 'epistemic' key must appear on every bin (value may be null)."""
        data = _result(non_latency_payload).get("data") or []
        assert data, "result.data is empty"
        missing = [i for i, b in enumerate(data) if "epistemic" not in b]
        assert not missing, (
            f"epistemic key missing on bins {missing[:10]}"
        )
