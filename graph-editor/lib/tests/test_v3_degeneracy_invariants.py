"""Outside-in pytest suite for v3 degeneracy invariants.

Exercises the public CLI (`graph-ops/scripts/analyse.sh`) against stable
synth fixtures and asserts the semantic invariants from
`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
and `docs/current/project-bayes/60-forecast-adaptation-programme.md`.

Every test drives the same code path a browser or CLI user would hit —
no internals, no private diagnostics. Failures here mean the public
v3 chart surface is violating the contract.

Invariants:
  I1  Zero-evidence window must rise toward p.mean as a subject-span CDF,
      not be flat at p.mean or a zero-length stub.
  I2  Zero-evidence cohort with A != X and non-trivial upstream latency
      must rise materially more slowly than zero-evidence window.
  I2b Low-evidence cohort on a simple A→B→C chain should still
      approximately follow the FW-composed A→C truth curve.
  I3  Zero-evidence cohort with A = X must equal window on the same edge.
  I4  Window asymptotic midpoint must equal the Bayesian posterior p.mean
      within tolerance when evidence is present and data has matured.
  I5  Cohort midpoint must never be materially above window midpoint at
      any tau on a single-hop edge.

Baseline (23-Apr-26): I1 and I2 fail on synth-mirror-4step (too few rows);
I2 fails on synth-lat4 (cohort and window curves are byte-identical — mode
distinction lost on the zero-evidence path).
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Optional

import pytest
import yaml

from conftest import (
    requires_db,
    requires_data_repo,
    requires_synth,
    _resolve_data_repo_dir,
)


# ── Location of the analyse.sh CLI and the Bayes-vars sidecar dir ────

_REPO_ROOT = Path(__file__).resolve().parents[3]
_ANALYSE_SH = _REPO_ROOT / "graph-ops" / "scripts" / "analyse.sh"
_SIDECAR_DIR = _REPO_ROOT / "bayes" / "fixtures"


# ── Skip rules ───────────────────────────────────────────────────────

_PYTHON_BE_URL = os.environ.get("PYTHON_API_URL", "http://localhost:9000")


def _python_be_reachable() -> bool:
    """Check the BE server is up. The CLI needs it for all analyse calls."""
    try:
        import urllib.request
        with urllib.request.urlopen(
            f"{_PYTHON_BE_URL}/__dagnet/server-info", timeout=2,
        ) as r:
            return r.status == 200
    except Exception:
        return False


requires_python_be = pytest.mark.skipif(
    not _python_be_reachable(),
    reason=f"Python BE not reachable at {_PYTHON_BE_URL}",
)


# ── Helpers ──────────────────────────────────────────────────────────


def _run_analyse_v3(
    graph: str,
    dsl: str,
    sidecar: Optional[Path] = None,
) -> dict:
    """Invoke analyse.sh for cohort_maturity v3 and return parsed JSON.

    Raises AssertionError with stderr on any failure. No --diag — that
    only adds noise to the parsed output.
    """
    cmd = [
        "bash", str(_ANALYSE_SH), graph, dsl,
        "--type", "cohort_maturity",
        "--no-cache", "--no-snapshot-cache",
        "--format", "json",
    ]
    if sidecar is not None:
        assert sidecar.exists(), f"sidecar missing: {sidecar}"
        cmd += ["--bayes-vars", str(sidecar)]

    result = subprocess.run(
        cmd, capture_output=True, text=True, cwd=str(_REPO_ROOT), timeout=300,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"analyse.sh exited {result.returncode} for {graph} / {dsl!r}\n"
            f"stderr:\n{result.stderr[-2000:]}"
        )

    # Strip any nvm "Now using node …" line that slips into stdout.
    stdout = result.stdout
    if not stdout.startswith("{"):
        idx = stdout.find("{")
        if idx < 0:
            raise AssertionError(
                f"no JSON in analyse.sh stdout for {graph} / {dsl!r}\n"
                f"stdout (first 500 chars):\n{stdout[:500]}"
            )
        stdout = stdout[idx:]
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as e:
        raise AssertionError(
            f"failed to parse analyse.sh JSON for {graph} / {dsl!r}: {e}\n"
            f"stdout head:\n{stdout[:500]}"
        )


def _rows(payload: dict) -> list[dict]:
    """Return the v3 data[] row list (midpoint, model_midpoint, tau_days)."""
    return (payload.get("result") or {}).get("data") or []


def _curve(payload: dict, field: str = "model_midpoint") -> dict[int, float]:
    """Return {tau_days: field_value} for rows where field is numeric."""
    out: dict[int, float] = {}
    for r in _rows(payload):
        tau = r.get("tau_days")
        val = r.get(field)
        if isinstance(tau, int) and isinstance(val, (int, float)):
            out[tau] = float(val)
    return out


def _sidecar(graph_name: str) -> Optional[Path]:
    p = _SIDECAR_DIR / f"{graph_name}.bayes-vars.json"
    return p if p.exists() else None


def _shifted_lognormal_cdf(
    tau: int,
    *,
    onset: float,
    mu: float,
    sigma: float,
) -> float:
    import math

    model_age = float(tau) - float(onset)
    if model_age <= 0 or sigma <= 0:
        return 0.0
    z = (math.log(model_age) - float(mu)) / float(sigma)
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def _load_truth_edge_params(
    *,
    graph_name: str,
    edge_name: str,
) -> dict[str, float]:
    truth_path = _REPO_ROOT / "bayes" / "truth" / f"{graph_name}.truth.yaml"
    truth = yaml.safe_load(truth_path.read_text())
    edge = (truth.get("edges") or {}).get(edge_name)
    assert edge is not None, f"missing truth edge {edge_name!r} in {truth_path}"
    return {
        "p": float(edge["p"]),
        "mu": float(edge["mu"]),
        "sigma": float(edge["sigma"]),
        "onset": float(edge["onset"]),
    }


def _fw_truth_curve_from_edges(
    *,
    graph_name: str,
    upstream_edge_name: str,
    target_edge_name: str,
    tau_max: int,
) -> dict[int, float]:
    from runner.stats_engine import LagDistributionFit, fw_compose_pair

    upstream = _load_truth_edge_params(
        graph_name=graph_name,
        edge_name=upstream_edge_name,
    )
    target = _load_truth_edge_params(
        graph_name=graph_name,
        edge_name=target_edge_name,
    )
    fw = fw_compose_pair(
        LagDistributionFit(
            mu=upstream["mu"],
            sigma=upstream["sigma"],
            empirical_quality_ok=True,
            total_k=100,
        ),
        LagDistributionFit(
            mu=target["mu"],
            sigma=target["sigma"],
            empirical_quality_ok=True,
            total_k=100,
        ),
    )
    assert fw is not None, (
        f"FW composition failed for {graph_name} "
        f"{upstream_edge_name}->{target_edge_name}"
    )
    mu_fw, sigma_fw = fw
    path_onset = upstream["onset"] + target["onset"]
    return {
        tau: target["p"] * _shifted_lognormal_cdf(
            tau,
            onset=path_onset,
            mu=mu_fw,
            sigma=sigma_fw,
        )
        for tau in range(tau_max + 1)
    }


# ═════════════════════════════════════════════════════════════════════
# Fixtures under test
# ═════════════════════════════════════════════════════════════════════
#
# synth-mirror-4step: linear 4-edge chain with non-latency upstream
# segments and two latency edges; terminal edge (m4-registered ->
# m4-success) is the direct structural analogue of the production
# defect in doc 65.
#
# synth-lat4: 3-edge chain with latency on every edge; designated per
# doc 60 for proving upstream-latency-driven window-vs-cohort divergence.

_M4 = "synth-mirror-4step"
_M4_TERMINAL = "from(m4-registered).to(m4-success)"
_M4_P_TRUTH = 0.70  # truth file ground-truth; Bayesian posterior recovers 0.7101

_LAT4 = "synth-lat4"
_LAT4_BC = "from(synth-lat4-b).to(synth-lat4-c)"

_SIMPLE = "synth-simple-abc"
_SIMPLE_BC = "from(simple-b).to(simple-c)"


# ═════════════════════════════════════════════════════════════════════
# I1 — Zero-evidence window rises as a subject-span CDF, not a flat line
# ═════════════════════════════════════════════════════════════════════


@requires_db
@requires_data_repo
@requires_python_be
class TestI1ZeroEvidenceWindowShape:
    """Without post-frontier evidence, v3 window should still produce a
    rising latency-aware curve. A flat line at p.mean, an empty trajectory,
    or a 2-row stub all violate the contract."""

    @requires_synth(_M4, bayesian=True)
    def test_m4_terminal_edge(self):
        payload = _run_analyse_v3(
            _M4, f"{_M4_TERMINAL}.window(-1d:)", sidecar=_sidecar(_M4),
        )
        self._assert_rising_curve(payload, label=f"{_M4}/{_M4_TERMINAL}")

    @requires_synth(_LAT4, enriched=True)
    def test_lat4_bc_edge(self):
        payload = _run_analyse_v3(
            _LAT4, f"{_LAT4_BC}.window(-1d:)", sidecar=_sidecar(_LAT4),
        )
        self._assert_rising_curve(payload, label=f"{_LAT4}/{_LAT4_BC}")

    @staticmethod
    def _assert_rising_curve(payload: dict, *, label: str) -> None:
        mids = [r.get("model_midpoint") for r in _rows(payload)
                if isinstance(r.get("model_midpoint"), (int, float))]
        assert len(mids) >= 5, (
            f"[{label}] too few rows to assess curve shape (n={len(mids)}, "
            "need ≥ 5) — v3 is not producing a trajectory"
        )
        mx = max(mids)
        assert mx > 0, (
            f"[{label}] model curve is identically zero across {len(mids)} "
            "taus — v3 is producing neither a rate nor a model curve"
        )
        rel_var = (max(mids) - min(mids)) / max(abs(mx), 1e-9)
        assert rel_var >= 0.01, (
            f"[{label}] curve is flat (rel_var={rel_var:.2%}) — "
            f"first={mids[0]:.4f} last={mids[-1]:.4f} max={mx:.4f}; "
            "expected a rising subject-span CDF"
        )
        assert mids[0] <= 0.30 * mx, (
            f"[{label}] curve does not start near 0 — "
            f"first={mids[0]:.4f} max={mx:.4f}; expected "
            "model_midpoint(tau=0) ≈ 0 for a latency edge"
        )


# ═════════════════════════════════════════════════════════════════════
# I2 — Zero-evidence cohort lags window under non-trivial upstream latency
# ═════════════════════════════════════════════════════════════════════


@requires_db
@requires_data_repo
@requires_python_be
class TestI2ZeroEvidenceCohortLagsWindow:
    """Cohort and window must produce distinct curves when the anchor is
    upstream of X with real A→X latency. Byte-identical curves indicate
    the mode distinction has been dropped entirely on the v3 path."""

    @requires_synth(_M4, bayesian=True)
    def test_m4_terminal_edge(self):
        win = _curve(_run_analyse_v3(
            _M4, f"{_M4_TERMINAL}.window(-1d:)", sidecar=_sidecar(_M4),
        ))
        coh = _curve(_run_analyse_v3(
            _M4, f"{_M4_TERMINAL}.cohort(-1d:)", sidecar=_sidecar(_M4),
        ))
        self._assert_cohort_lags_window(win, coh, label=f"{_M4}/{_M4_TERMINAL}")

    @requires_synth(_LAT4, enriched=True)
    def test_lat4_bc_edge(self):
        win = _curve(_run_analyse_v3(
            _LAT4, f"{_LAT4_BC}.window(-1d:)", sidecar=_sidecar(_LAT4),
        ))
        coh = _curve(_run_analyse_v3(
            _LAT4, f"{_LAT4_BC}.cohort(-1d:)", sidecar=_sidecar(_LAT4),
        ))
        self._assert_cohort_lags_window(win, coh, label=f"{_LAT4}/{_LAT4_BC}")

    @staticmethod
    def _assert_cohort_lags_window(
        win: dict[int, float], coh: dict[int, float], *, label: str,
    ) -> None:
        common = sorted(set(win) & set(coh))
        assert len(common) >= 5, (
            f"[{label}] too few overlapping taus to assess lag "
            f"(n={len(common)}) — v3 is not producing a trajectory "
            "long enough to compare"
        )

        eps = 0.03  # MC noise tolerance
        for t in common:
            assert coh[t] <= win[t] + eps, (
                f"[{label}] cohort above window at tau={t}: "
                f"cohort={coh[t]:.4f} window={win[t]:.4f}"
            )

        max_diff = max(abs(win[t] - coh[t]) for t in common)
        assert max_diff >= 1e-6, (
            f"[{label}] cohort and window curves are identical at every "
            f"tau (max_diff={max_diff:.2e}) — mode distinction lost"
        )

        target = 0.5 * max(win.values())
        w_half = next((t for t in sorted(win) if win[t] >= target), None)
        c_half = next((t for t in sorted(coh) if coh[t] >= target), None)
        assert w_half is not None, (
            f"[{label}] window never reaches 0.5 * max — "
            f"max={max(win.values()):.4f}"
        )
        if c_half is None:
            # Cohort lag is so severe it never reaches 0.5 * max in the
            # observed range. That is a valid pass — the lag is present.
            return
        assert c_half > w_half, (
            f"[{label}] cohort not lagged — window hits 0.5·max at "
            f"tau={w_half}, cohort at tau={c_half}; expected cohort > window"
        )


# ═════════════════════════════════════════════════════════════════════
# I2b — Low-evidence cohort tracks the simple-chain FW oracle
# ═════════════════════════════════════════════════════════════════════


@requires_db
@requires_data_repo
@requires_python_be
class TestI2bLowEvidenceCohortMatchesFwConvolution:
    """Public hard oracle for lightly conditioned `cohort(a, b-c)`.

    On the simple A→B→C synth, a short historical cohort slice gives a
    low-evidence public query while preserving a clean truth-backed FW
    oracle. The exposed midpoint should remain in the neighbourhood of
    the A→C FW path curve rather than hugging zero for most of the plot.
    """

    @requires_synth(_SIMPLE, enriched=True)
    def test_simple_bc_edge(self):
        payload = _run_analyse_v3(
            _SIMPLE,
            f"{_SIMPLE_BC}.cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)",
        )
        rows = _rows(payload)
        mids = _curve(payload, field="midpoint")
        expected = _fw_truth_curve_from_edges(
            graph_name=_SIMPLE,
            upstream_edge_name="simple-a-to-b",
            target_edge_name="simple-b-to-c",
            tau_max=max(mids) if mids else 0,
        )

        assert rows, f"[{_SIMPLE}/{_SIMPLE_BC}] analyse returned no rows"

        taus = [tau for tau in range(15, 21) if tau in mids and tau in expected]
        assert len(taus) >= 5, (
            f"[{_SIMPLE}/{_SIMPLE_BC}] insufficient overlap with FW oracle: "
            f"{taus}"
        )

        failures: list[str] = []
        for tau in taus:
            actual = mids[tau]
            exp = expected[tau]
            abs_err = abs(actual - exp)
            rel_err = abs_err / max(abs(exp), 1e-9)
            if abs_err > 0.02 and rel_err > 0.35:
                failures.append(
                    f"tau={tau}: midpoint={actual:.6f} expected={exp:.6f} "
                    f"|Δ|={abs_err:.6f} rel={rel_err:.1%}"
                )

        assert not failures, (
            f"[{_SIMPLE}/{_SIMPLE_BC}] low-evidence cohort drifted from "
            "truth-backed FW path oracle:\n" + "\n".join(failures[:6])
        )


# ═════════════════════════════════════════════════════════════════════
# I3 — A = X cohort is identical to window
# ═════════════════════════════════════════════════════════════════════


@requires_db
@requires_data_repo
@requires_python_be
class TestI3CohortAEqualsXMatchesWindow:
    """When the anchor is the edge's from-node, carrier_to_x collapses to
    identity and the cohort query is semantically window. The two v3
    outputs must agree numerically within 1 percentage point."""

    @requires_synth(_M4, bayesian=True)
    def test_m4_terminal_edge(self):
        win = _curve(_run_analyse_v3(
            _M4, f"{_M4_TERMINAL}.window(-1d:)", sidecar=_sidecar(_M4),
        ))
        coh = _curve(_run_analyse_v3(
            _M4,
            "from(m4-registered).to(m4-success).cohort(m4-registered,-1d:)",
            sidecar=_sidecar(_M4),
        ))
        self._assert_cohort_matches_window(win, coh, label=_M4)

    @requires_synth(_LAT4, enriched=True)
    def test_lat4_bc_edge(self):
        win = _curve(_run_analyse_v3(
            _LAT4, f"{_LAT4_BC}.window(-1d:)", sidecar=_sidecar(_LAT4),
        ))
        coh = _curve(_run_analyse_v3(
            _LAT4,
            "from(synth-lat4-b).to(synth-lat4-c).cohort(synth-lat4-b,-1d:)",
            sidecar=_sidecar(_LAT4),
        ))
        self._assert_cohort_matches_window(win, coh, label=_LAT4)

    @staticmethod
    def _assert_cohort_matches_window(
        win: dict[int, float], coh: dict[int, float], *, label: str,
    ) -> None:
        if not coh:
            pytest.skip(
                f"[{label}] cohort(A,…) with A=X returned no rows "
                "(planner may not support this DSL form here)"
            )
        assert win, f"[{label}] window returned no rows"
        common = sorted(set(win) & set(coh))
        assert common, f"[{label}] no overlap between window and cohort curves"
        max_diff = max(abs(win[t] - coh[t]) for t in common)
        tol = 0.01  # 1 absolute percentage point
        worst = max(common, key=lambda t: abs(win[t] - coh[t]))
        assert max_diff <= tol, (
            f"[{label}] window/cohort differ by {max_diff:.4f} at tau={worst}: "
            f"w={win[worst]:.4f} c={coh[worst]:.4f} "
            f"(A=X should collapse to identity carrier)"
        )


# ═════════════════════════════════════════════════════════════════════
# I4 — Window asymptote equals posterior p.mean (evidence present)
# ═════════════════════════════════════════════════════════════════════


@requires_db
@requires_data_repo
@requires_python_be
class TestI4WindowAsymptoteMatchesP:
    """With evidence present and data matured, v3 window midpoint at large
    tau must converge to the edge probability p. Large divergence implies
    the rate side is drifting from its posterior."""

    @requires_synth(_M4, bayesian=True)
    def test_m4_terminal_edge(self):
        # Frontier 1-Mar-26 with asat=22-Mar-26 gives ~21 days of matured
        # observations on synth-mirror-4step.
        payload = _run_analyse_v3(
            _M4,
            f"{_M4_TERMINAL}.window(1-Mar-26:22-Mar-26).asat(22-Mar-26)",
            sidecar=_sidecar(_M4),
        )
        mids = [r.get("midpoint") for r in _rows(payload)
                if isinstance(r.get("midpoint"), (int, float))]
        assert len(mids) >= 5, (
            f"[{_M4}/{_M4_TERMINAL}] insufficient mature-range rows "
            f"(n={len(mids)})"
        )
        mature = sum(mids[-5:]) / 5
        rel_err = abs(mature - _M4_P_TRUTH) / max(abs(_M4_P_TRUTH), 1e-9)
        assert rel_err <= 0.10, (
            f"[{_M4}/{_M4_TERMINAL}] mature window midpoint {mature:.4f} "
            f"diverges from p={_M4_P_TRUTH:.4f} ({rel_err:.1%} off)"
        )


# ═════════════════════════════════════════════════════════════════════
# I5 — Cohort never materially above window on a single-hop edge
# ═════════════════════════════════════════════════════════════════════


@requires_db
@requires_data_repo
@requires_python_be
class TestI5CohortNeverAboveWindow:
    """A blanket guard: for any zero-evidence probe on a single-hop edge,
    cohort midpoint must not exceed window midpoint at any tau. Overshoot
    indicates a sign error or mode crossover in the cohort computation."""

    @requires_synth(_M4, bayesian=True)
    def test_m4_terminal_edge(self):
        win = _curve(_run_analyse_v3(
            _M4, f"{_M4_TERMINAL}.window(-1d:)",
            sidecar=_sidecar(_M4),
        ), field="midpoint")
        coh = _curve(_run_analyse_v3(
            _M4, f"{_M4_TERMINAL}.cohort(-1d:)",
            sidecar=_sidecar(_M4),
        ), field="midpoint")
        self._assert_cohort_not_above_window(win, coh, label=_M4)

    @requires_synth(_LAT4, enriched=True)
    def test_lat4_bc_edge(self):
        win = _curve(_run_analyse_v3(
            _LAT4, f"{_LAT4_BC}.window(-1d:)",
            sidecar=_sidecar(_LAT4),
        ), field="midpoint")
        coh = _curve(_run_analyse_v3(
            _LAT4, f"{_LAT4_BC}.cohort(-1d:)",
            sidecar=_sidecar(_LAT4),
        ), field="midpoint")
        self._assert_cohort_not_above_window(win, coh, label=_LAT4)

    @staticmethod
    def _assert_cohort_not_above_window(
        win: dict[int, float], coh: dict[int, float], *, label: str,
    ) -> None:
        common = sorted(set(win) & set(coh))
        assert common, f"[{label}] no tau overlap between window and cohort"
        eps = 0.03
        for t in common:
            assert coh[t] <= win[t] + eps, (
                f"[{label}] cohort above window at tau={t}: "
                f"cohort={coh[t]:.4f} window={win[t]:.4f}"
            )
