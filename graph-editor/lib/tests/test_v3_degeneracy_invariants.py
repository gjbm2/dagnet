"""v3 degeneracy invariants — outside-in CLI harness.

Locks the public-tooling cohort_maturity (v3) path against the semantic
invariants from
``docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md``
and ``docs/current/project-bayes/60-forecast-adaptation-programme.md``.

Five invariants, each parametrised over the graphs that exercise it:

    I1  Zero-evidence window degenerates to the subject-span CDF shape,
        not a flat line at p.mean.

    I2  Zero-evidence cohort with A != X and non-trivial upstream
        latency rises more slowly than zero-evidence window.

    I3  Zero-evidence cohort with A = X is semantically identical to
        zero-evidence window on the same edge.

    I4  Window asymptotic midpoint equals the Bayesian posterior p.mean
        (within tolerance) when evidence is present and data has matured.

    I5  Cohort midpoint is never materially above window midpoint at
        any tau, on a single-hop edge with any upstream latency.

Replaces ``graph-ops/scripts/v3-degeneracy-invariants.sh``. The bash
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
_FIXTURES_DIR = _REPO_ROOT / "bayes" / "fixtures"

_PYTHON_BE_URL = os.environ.get("PYTHON_API_URL", "http://localhost:9000")

# Edges per the bash original (lines 456-460).
_M4_TERMINAL = "from(m4-registered).to(m4-success)"
_LAT4_BC = "from(synth-lat4-b).to(synth-lat4-c)"

# (graph, edge_dsl) pairs sampled across two graphs of differing topology.
_DUAL_GRAPH_CASES: list[tuple[str, str]] = [
    ("synth-mirror-4step", _M4_TERMINAL),
    ("synth-lat4", _LAT4_BC),
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


def _sidecar_for(graph: str) -> Optional[Path]:
    """Return sidecar path if it exists, None otherwise.

    synth-mirror-4step has a committed sidecar; synth-lat4 does not, so
    its invariants run with analytic vars only (which is what the bash
    harness did too).
    """
    if graph == "synth-mirror-4step":
        path = _FIXTURES_DIR / f"{graph}.bayes-vars.json"
        return path if path.exists() else None
    return None


def _ensure_ready(graph: str) -> Optional[Path]:
    sidecar = _sidecar_for(graph)
    _ensure_synth_ready(
        graph,
        enriched=True,
        bayesian=(sidecar is not None),
        check_fe_parity=False,
    )
    return sidecar


def _run_v3(graph: str, dsl: str, sidecar: Optional[Path]) -> dict[str, Any]:
    args = [
        "--graph", _DATA_REPO_PATH or "",
        "--name", graph,
        "--query", dsl,
        "--type", "cohort_maturity",
        "--no-cache", "--no-snapshot-cache",
        "--format", "json",
    ]
    if sidecar is not None:
        args += ["--bayes-vars", str(sidecar)]

    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        try:
            return client.call_json("analyse", args)
        except DaemonError as exc:
            raise AssertionError(
                f"daemon analyse failed for {graph} / {dsl!r}: {exc}\n"
                f"stderr:\n{exc.stderr[-2000:]}"
            )

    cmd = ["bash", str(_ANALYSE_SH), graph, dsl,
           "--type", "cohort_maturity", "--no-cache", "--no-snapshot-cache", "--format", "json"]
    if sidecar is not None:
        cmd += ["--bayes-vars", str(sidecar)]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(_REPO_ROOT), timeout=300)
    if result.returncode != 0:
        raise AssertionError(f"analyse.sh exit {result.returncode}\nstderr:\n{result.stderr[-2000:]}")
    idx = result.stdout.find("{")
    return json.loads(result.stdout[idx:])


def _model_midpoint_curve(payload: dict[str, Any]) -> dict[int, float]:
    rows = (payload.get("result") or {}).get("data") or []
    out: dict[int, float] = {}
    for r in rows:
        tau = r.get("tau_days")
        m = r.get("model_midpoint")
        if tau is not None and isinstance(m, (int, float)):
            out[int(tau)] = float(m)
    return out


def _midpoint_curve(payload: dict[str, Any]) -> dict[int, float]:
    rows = (payload.get("result") or {}).get("data") or []
    out: dict[int, float] = {}
    for r in rows:
        tau = r.get("tau_days")
        m = r.get("midpoint")
        if tau is not None and isinstance(m, (int, float)):
            out[int(tau)] = float(m)
    return out


@requires_db
@requires_data_repo
@requires_python_be
class TestV3DegeneracyInvariants:
    """Each invariant lives as one or more parametrised tests."""

    # ── I1 ────────────────────────────────────────────────────────────────
    @pytest.mark.parametrize("graph,edge_dsl", _DUAL_GRAPH_CASES, ids=[c[0] for c in _DUAL_GRAPH_CASES])
    def test_i1_zero_evidence_window_not_flat(self, graph: str, edge_dsl: str) -> None:
        """I1: zero-evidence window must produce a rising subject-span CDF, not a flat line."""
        sidecar = _ensure_ready(graph)
        payload = _run_v3(graph, f"{edge_dsl}.window(-1d:)", sidecar)
        curve = _model_midpoint_curve(payload)
        mids = [curve[t] for t in sorted(curve)]

        if len(mids) < 5:
            pytest.fail(f"too few rows to assess curve shape (n={len(mids)}, need ≥ 5)")
        mx = max(mids)
        if mx <= 0:
            pytest.fail(f"curve identically zero across {len(mids)} taus")
        rel_var = (mx - min(mids)) / max(abs(mx), 1e-9)
        if rel_var < 0.01:
            pytest.fail(
                f"curve flat (rel_var={rel_var:.2%}) — first={mids[0]:.4f} last={mids[-1]:.4f} max={mx:.4f}"
            )
        if mids[0] > 0.30 * mx:
            pytest.fail(
                f"curve does not start near 0 — first={mids[0]:.4f} max={mx:.4f}"
            )

    # ── I2 ────────────────────────────────────────────────────────────────
    @pytest.mark.parametrize("graph,edge_dsl", _DUAL_GRAPH_CASES, ids=[c[0] for c in _DUAL_GRAPH_CASES])
    def test_i2_zero_evidence_cohort_lags_window(self, graph: str, edge_dsl: str) -> None:
        """I2: cohort must rise more slowly than window when upstream latency is non-trivial."""
        sidecar = _ensure_ready(graph)
        wp = _run_v3(graph, f"{edge_dsl}.window(-1d:)", sidecar)
        cp = _run_v3(graph, f"{edge_dsl}.cohort(-1d:)", sidecar)
        wc = _model_midpoint_curve(wp)
        cc = _model_midpoint_curve(cp)
        if not wc or not cc:
            pytest.fail(f"missing curve data wc={bool(wc)} cc={bool(cc)}")

        common = sorted(set(wc) & set(cc))
        if len(common) < 5:
            pytest.fail(f"too few overlapping taus to assess lag (n={len(common)})")

        eps = 0.03
        violations = [(t, cc[t], wc[t]) for t in common if cc[t] > wc[t] + eps]
        if violations:
            t, c, w = violations[0]
            pytest.fail(
                f"cohort above window at tau={t}: cohort={c:.4f} window={w:.4f} "
                f"(first of {len(violations)})"
            )

        max_diff = max(abs(wc[t] - cc[t]) for t in common)
        if max_diff < 1e-6:
            pytest.fail(
                f"cohort and window curves identical at every tau (max_diff={max_diff:.2e}) — "
                "mode distinction lost"
            )

        target = 0.5 * max(wc.values())
        def first_reach(curve: dict[int, float], thresh: float) -> Optional[int]:
            for t in sorted(curve):
                if curve[t] >= thresh:
                    return t
            return None

        w_half = first_reach(wc, target)
        c_half = first_reach(cc, target)
        if w_half is None:
            pytest.fail(f"window never reaches 0.5·max — max={max(wc.values()):.4f}")
        if c_half is None:
            return  # cohort lag is severe but valid (PASS in bash)
        if c_half <= w_half:
            pytest.fail(
                f"cohort not lagged — window hits 0.5·max at tau={w_half}, "
                f"cohort at tau={c_half} (expected cohort > window)"
            )

    # ── I3 ────────────────────────────────────────────────────────────────
    @pytest.mark.parametrize(
        "graph,from_node,to_node",
        [
            ("synth-mirror-4step", "m4-registered", "m4-success"),
            ("synth-lat4", "synth-lat4-b", "synth-lat4-c"),
        ],
        ids=["synth-mirror-4step", "synth-lat4"],
    )
    def test_i3_cohort_a_equals_x_collapses_to_window(
        self, graph: str, from_node: str, to_node: str,
    ) -> None:
        """I3: cohort(A,...) with A = from_node must agree with window on the same edge."""
        sidecar = _ensure_ready(graph)
        w_dsl = f"from({from_node}).to({to_node}).window(-1d:)"
        c_dsl = f"from({from_node}).to({to_node}).cohort({from_node},-1d:)"

        wp = _run_v3(graph, w_dsl, sidecar)
        cp = _run_v3(graph, c_dsl, sidecar)
        wc = _model_midpoint_curve(wp)
        cc = _model_midpoint_curve(cp)
        if not cc:
            # Planner may reject cohort(A,…) with A=X — bash treated that as SKIP.
            pytest.skip("cohort query returned no rows (planner may not support A=X DSL form)")
        if not wc:
            pytest.fail("window returned no rows")

        common = sorted(set(wc) & set(cc))
        if not common:
            pytest.fail("no overlap between window and cohort curves")
        max_diff = max(abs(wc[t] - cc[t]) for t in common)
        tol = 0.01
        if max_diff > tol:
            worst = max(common, key=lambda t: abs(wc[t] - cc[t]))
            pytest.fail(
                f"window/cohort differ by {max_diff:.4f} at tau={worst}: "
                f"w={wc[worst]:.4f} c={cc[worst]:.4f}"
            )

    # ── I4 ────────────────────────────────────────────────────────────────
    def test_i4_mature_window_midpoint_matches_posterior_p_mean(self) -> None:
        """I4: mature window midpoint converges to the Bayesian p.mean within 10%.

        Only run on synth-mirror-4step: terminal edge truth p=0.7,
        Bayesian posterior p≈0.7101. Absolute frontier with asat ensures
        evidence binds.
        """
        graph = "synth-mirror-4step"
        sidecar = _ensure_ready(graph)
        if sidecar is None:
            pytest.skip("Bayes sidecar required for I4 but not present")

        payload = _run_v3(graph, f"{_M4_TERMINAL}.window(1-Mar-26:22-Mar-26).asat(22-Mar-26)", sidecar)
        rows = (payload.get("result") or {}).get("data") or []
        mids = [r["midpoint"] for r in rows if isinstance(r.get("midpoint"), (int, float))]
        if len(mids) < 5:
            pytest.fail(f"insufficient rows ({len(mids)})")

        mature = sum(mids[-5:]) / 5
        p_exp = 0.7
        rel_err = abs(mature - p_exp) / max(abs(p_exp), 1e-9)
        if rel_err > 0.10:
            pytest.fail(
                f"mature window midpoint {mature:.4f} diverges from p={p_exp:.4f} ({rel_err:.1%})"
            )

    # ── I5 ────────────────────────────────────────────────────────────────
    @pytest.mark.parametrize("graph,edge_dsl", _DUAL_GRAPH_CASES, ids=[c[0] for c in _DUAL_GRAPH_CASES])
    def test_i5_cohort_never_materially_above_window(self, graph: str, edge_dsl: str) -> None:
        """I5: cohort midpoint must not exceed window midpoint at any tau (zero-evidence)."""
        sidecar = _ensure_ready(graph)
        wp = _run_v3(graph, f"{edge_dsl}.window(-1d:)", sidecar)
        cp = _run_v3(graph, f"{edge_dsl}.cohort(-1d:)", sidecar)
        wc = _midpoint_curve(wp)
        cc = _midpoint_curve(cp)
        if not wc or not cc:
            pytest.fail(f"missing data wc={bool(wc)} cc={bool(cc)}")

        common = sorted(set(wc) & set(cc))
        if not common:
            pytest.fail("no tau overlap")

        eps = 0.03
        violations = [(t, cc[t], wc[t]) for t in common if cc[t] > wc[t] + eps]
        if violations:
            t, c, w = violations[0]
            pytest.fail(
                f"cohort above window at tau={t}: cohort={c:.4f} window={w:.4f} "
                f"(first of {len(violations)}/{len(common)})"
            )
