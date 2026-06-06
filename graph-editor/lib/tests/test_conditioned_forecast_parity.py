"""Conditioned forecast parity test (doc 47) — outside-in CLI harness.

Proves that the whole-graph conditioned forecast endpoint produces
correct per-edge scalars by comparing against the v3 chart path
(single-edge reference). Same pipeline as the browser.

  Phase 1: Data health checks (non-vacuousness)
    - Graph JSON exists with expected edges
    - Snapshot DB rows present per edge
    - Conditioned forecast returns edges with non-null p_mean

  Phase 2: Per-edge parity comparison
    - For each edge: cohort_maturity last-row projected_rate (FC at
      saturation) is compared to whole-graph CF p_mean
    - Diagnostic table preserved on failure

  Phase 3: Sibling PMF consistency (sum <= 1.0 per parent)

  Phase 4: Historical asat visibility (synth-simple-abc only)
    - daily_conversions exposes the maturity/forecast boundary shift
    - whole-graph conditioned_forecast lowers visible evidence

Replaces ``graph-ops/scripts/conditioned-forecast-parity-test.sh``. The
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

GRAPH = "synth-simple-abc"  # historical-asat fixture lives here

# Per-graph DSL — bash _define_dsl_<name>(). The default mirrors the
# bash fallback for unknown graphs.
_GRAPH_DSL: dict[str, str] = {
    # Pinned from the 29-Apr-26 wallclock resolution of window(-90d:).
    # The asat cap freezes sweep/eval horizons; the absolute window avoids
    # relative-date drift before the asat clause is interpreted.
    "synth-simple-abc": "window(29-Jan-26:29-Apr-26).asat(29-Apr-26)",
    "synth-mirror-4step": "cohort(7-Mar-26:21-Mar-26)",
}
DSL = _GRAPH_DSL.get(GRAPH, "window(-90d:)")

# Phase 4 fixture (synth-simple-abc only).
ASAT_DATE = "15-Jan-26"
ASAT_TEMPORAL_DSL = "window(12-Dec-25:20-Mar-26)"
ASAT_EDGE_DSL = f"from(simple-a).to(simple-b).{ASAT_TEMPORAL_DSL}"

# Per-edge parity tolerance. Tight enough to catch systematic errors;
# wide enough for MC variance. Bash uses 0.005 absolute on probability.
_PARITY_ABS_TOL = 0.005


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


def _graph_json_path() -> Path:
    assert _DATA_REPO_PATH is not None
    return Path(_DATA_REPO_PATH) / "graphs" / f"{GRAPH}.json"


# ── CLI plumbing ────────────────────────────────────────────────────────────

def _analyse(dsl: str, *, analysis_type: str, no_snapshot_cache: bool = True) -> dict[str, Any]:
    args = [
        "--graph", _DATA_REPO_PATH or "",
        "--name", GRAPH,
        "--query", dsl,
        "--type", analysis_type,
        "--no-cache",
        "--format", "json",
    ]
    if no_snapshot_cache:
        args.append("--no-snapshot-cache")
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
           "--type", analysis_type, "--no-cache", "--format", "json"]
    if no_snapshot_cache:
        cmd.append("--no-snapshot-cache")
    result = subprocess.run(cmd, capture_output=True, text=True,
                            cwd=str(_REPO_ROOT), timeout=300)
    if result.returncode != 0:
        raise AssertionError(
            f"analyse.sh exited {result.returncode}\nstderr:\n{result.stderr[-2000:]}"
        )
    idx = result.stdout.find("{")
    return json.loads(result.stdout[idx:])


# ── Graph helpers ───────────────────────────────────────────────────────────

def _load_graph() -> dict[str, Any]:
    return json.loads(_graph_json_path().read_text())


def _node_id_map(graph: dict[str, Any]) -> dict[str, str]:
    return {n["uuid"]: n.get("id", "") for n in graph.get("nodes", [])}


def _parameterised_edges(graph: dict[str, Any]) -> list[dict[str, Any]]:
    """Edges with p.id whose target name does not contain 'dropout'."""
    nmap = _node_id_map(graph)
    out = []
    for e in graph.get("edges", []):
        p_id = (e.get("p") or {}).get("id", "")
        to_name = nmap.get(e.get("to", ""), "")
        if p_id and "dropout" not in to_name:
            out.append({
                "uuid": e["uuid"],
                "from_id": nmap.get(e.get("from", ""), ""),
                "to_id": to_name,
                "p_id": p_id,
                "raw": e,
            })
    return out


def _wg_edges(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract the conditioned_forecast edges list from the response."""
    scenarios = payload.get("scenarios") or []
    if not scenarios:
        return []
    return scenarios[0].get("edges", []) or []


def _wg_edges_by_uuid(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {e.get("edge_uuid"): e for e in _wg_edges(payload)}


# ── Module fixtures ─────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def _ready_synth() -> None:
    _ensure_synth_ready(GRAPH, enriched=True, check_fe_parity=False)


@pytest.fixture(scope="module")
def graph_data(_ready_synth) -> dict[str, Any]:
    if not _graph_json_path().is_file():
        pytest.skip(f"Graph JSON missing: {_graph_json_path()}")
    return _load_graph()


@pytest.fixture(scope="module")
def edges(graph_data) -> list[dict[str, Any]]:
    return _parameterised_edges(graph_data)


@pytest.fixture(scope="module")
def cf_whole_graph(_ready_synth) -> dict[str, Any]:
    """Whole-graph conditioned forecast (default DSL).

    Bypasses the BE TTL cache so the test cannot be satisfied by a
    stale BE-process result when dev edits BE Python without
    restarting the server. Stricter than the bash original.
    """
    return _analyse(DSL, analysis_type="conditioned_forecast", no_snapshot_cache=True)


@pytest.fixture(scope="module")
def per_edge_cohort_maturity(_ready_synth, edges) -> dict[str, dict[str, Any]]:
    """One cohort_maturity v3 chart per parameterised edge, keyed by uuid."""
    out: dict[str, dict[str, Any]] = {}
    for e in edges:
        dsl = f"from({e['from_id']}).to({e['to_id']}).{DSL}"
        out[e["uuid"]] = _analyse(dsl, analysis_type="cohort_maturity")
    return out


# Phase 4 fixtures (synth-simple-abc only).

@pytest.fixture(scope="module")
def dc_live(_ready_synth) -> dict[str, Any]:
    return _analyse(ASAT_EDGE_DSL, analysis_type="daily_conversions")


@pytest.fixture(scope="module")
def dc_asat(_ready_synth) -> dict[str, Any]:
    return _analyse(f"{ASAT_EDGE_DSL}.asat({ASAT_DATE})",
                    analysis_type="daily_conversions")


@pytest.fixture(scope="module")
def wg_asat_live(_ready_synth) -> dict[str, Any]:
    return _analyse(ASAT_TEMPORAL_DSL, analysis_type="conditioned_forecast")


@pytest.fixture(scope="module")
def wg_asat(_ready_synth) -> dict[str, Any]:
    return _analyse(f"{ASAT_TEMPORAL_DSL}.asat({ASAT_DATE})",
                    analysis_type="conditioned_forecast")


# ── Phase 1: Data health ────────────────────────────────────────────────────

@requires_db
@requires_data_repo
@requires_python_be
class TestPhase1Health:
    """Phase 1: graph and snapshot DB present; conditioned forecast non-empty."""

    def test_graph_json_exists(self) -> None:
        if not _graph_json_path().is_file():
            pytest.fail(f"missing graph JSON: {_graph_json_path()}")

    def test_graph_has_parameterised_edges(self, edges) -> None:
        if not edges:
            pytest.fail("graph has no parameterised edges with p.id")

    def test_snapshot_db_has_rows_per_edge(self, edges) -> None:
        """Every parameterised edge must have at least one snapshot row.

        Mirrors the bash psycopg2 query that filters out PLACEHOLDER core_hashes.
        """
        try:
            import psycopg2
        except ImportError:
            pytest.skip("psycopg2 not installed")

        from conftest import _resolve_db_url
        url = _resolve_db_url()
        if not url:
            pytest.skip("DB_CONNECTION not set")

        diagnostic_lines: list[str] = []
        ok = 0
        fail = 0
        with psycopg2.connect(url) as conn, conn.cursor() as cur:
            for e in edges:
                cur.execute(
                    "SELECT 1 FROM snapshots WHERE param_id LIKE %s "
                    "AND core_hash NOT LIKE 'PLACEHOLDER%%' LIMIT 1",
                    (f"%{e['p_id']}",),
                )
                found = cur.fetchone() is not None
                tag = "OK" if found else "MISSING"
                diagnostic_lines.append(
                    f"    {e['from_id']:20s} -> {e['to_id']:20s}  "
                    f"{tag} (snapshot rows present={found})"
                )
                if found:
                    ok += 1
                else:
                    fail += 1
        if fail > 0:
            pytest.fail(
                f"{fail} edges missing snapshot data ({ok} OK)\n"
                + "\n".join(diagnostic_lines)
            )

    def test_conditioned_forecast_returns_edges(self, cf_whole_graph) -> None:
        n = sum(1 for e in _wg_edges(cf_whole_graph) if e.get("p_mean") is not None)
        if n == 0:
            head = json.dumps(cf_whole_graph, indent=2)[:500]
            pytest.fail(
                "Conditioned forecast returned 0 edges with p_mean (THE DOC 47 BUG)\n"
                f"Response head:\n{head}"
            )


# ── Phase 2: Per-edge parity ────────────────────────────────────────────────

@requires_db
@requires_data_repo
@requires_python_be
class TestPhase2Parity:
    """Phase 2: per-edge whole-graph p_mean vs single-edge FC saturation."""

    def _v3_reference(self, v3_payload: dict[str, Any]) -> tuple[Optional[float], Optional[int]]:
        """Engine-evaluated p@∞ from the last row's FC saturation surface."""
        rows = (v3_payload.get("result") or {}).get("data") or \
               (v3_payload.get("result") or {}).get("maturity_rows") or []
        if not rows:
            return None, None
        last = rows[-1]
        tau = last.get("tau_days")
        p_inf = last.get("p_infinity_mean")
        if p_inf is not None:
            return float(p_inf), tau
        projected = last.get("projected_rate")
        if projected is not None:
            return float(projected), tau
        for r in reversed(rows):
            if r.get("midpoint") is not None:
                return float(r["midpoint"]), r.get("tau_days")
        return None, tau

    def test_per_edge_pmean_matches_v3_midpoint(
        self, graph_data, edges, cf_whole_graph, per_edge_cohort_maturity,
    ) -> None:
        if not _wg_edges(cf_whole_graph):
            pytest.skip("conditioned forecast returned no edges (Phase 1 must pass first)")

        wg_by_uuid = _wg_edges_by_uuid(cf_whole_graph)
        # Identify start nodes for the "downstream" diagnostic column.
        start_uuids = {
            n["uuid"] for n in graph_data.get("nodes", [])
            if (n.get("entry") or {}).get("is_start", False)
        }

        rows: list[str] = []
        rows.append(
            f'{"edge":30s} | {"wg p_mean":>10s} | {"v3 FC@T":>10s} | '
            f'{"delta":>8s} | {"downstream":>10s} | result'
        )
        rows.append("-" * 95)

        n_pass = 0
        n_fail = 0
        n_skip = 0
        for e in edges:
            wg_edge = wg_by_uuid.get(e["uuid"])
            wg = wg_edge.get("p_mean") if wg_edge else None
            v3, _v3_tau = self._v3_reference(per_edge_cohort_maturity.get(e["uuid"], {}))
            label = f"{e['from_id']} -> {e['to_id']}"
            from_uuid = e["raw"].get("from", "")
            is_downstream = from_uuid not in start_uuids
            ds = "yes" if is_downstream else "no"
            if wg is None or v3 is None:
                rows.append(
                    f'{label:30s} | '
                    f'{("%10.4f" % wg) if wg is not None else "      None"} | '
                    f'{("%10.4f" % v3) if v3 is not None else "      None"} | '
                    f'    —    | {ds:>10s} | SKIP'
                )
                n_skip += 1
                continue
            delta = abs(wg - v3)
            status = "PASS" if delta < _PARITY_ABS_TOL else "FAIL"
            rows.append(
                f'{label:30s} | {wg:10.4f} | {v3:10.4f} | {delta:8.4f} | '
                f'{ds:>10s} | {status}'
            )
            if status == "PASS":
                n_pass += 1
            else:
                n_fail += 1

        # Skipped edges count as failures (silent omissions hide bugs).
        if n_fail > 0 or n_skip > 0 or n_pass == 0:
            pytest.fail(
                f"Parity: {n_pass} pass, {n_fail} FAIL, {n_skip} SKIPPED "
                f"(skips count as failures)\n" + "\n".join(rows)
            )


# ── Phase 3: Sibling PMF consistency ────────────────────────────────────────

@requires_db
@requires_data_repo
@requires_python_be
class TestPhase3SiblingPMF:
    """Phase 3: applied conditioned-forecast p_mean values must keep
    sibling-edge sums ≤ 1.0 per parent (PMF invariant)."""

    def test_sibling_groups_sum_at_most_one(self, graph_data, cf_whole_graph) -> None:
        if not _wg_edges(cf_whole_graph):
            pytest.skip("no conditioned forecast results")

        nmap = _node_id_map(graph_data)
        wg_by_uuid = _wg_edges_by_uuid(cf_whole_graph)

        # Group edges by parent (from) name.
        groups: dict[str, list[dict[str, Any]]] = {}
        for e in graph_data.get("edges", []):
            from_uuid = e.get("from", "")
            from_name = nmap.get(from_uuid, from_uuid[:12])
            groups.setdefault(from_name, []).append(e)

        report: list[str] = []
        n_pass = 0
        n_fail = 0
        for parent, siblings in groups.items():
            if len(siblings) < 2:
                continue
            total = 0.0
            details = []
            for s in siblings:
                to_name = nmap.get(s.get("to", ""), "?")
                wg_e = wg_by_uuid.get(s["uuid"])
                p = (wg_e.get("p_mean") if wg_e and wg_e.get("p_mean") is not None
                     else (s.get("p") or {}).get("mean", 0))
                total += float(p)
                details.append(f"{to_name}={float(p):.4f}")
            ok = total <= 1.01
            status = "PASS" if ok else "FAIL"
            report.append(
                f"  {parent}: sum={total:.4f} ({' + '.join(details)}) {status}"
            )
            if ok:
                n_pass += 1
            else:
                n_fail += 1

        if n_fail > 0 or n_pass == 0:
            pytest.fail(
                f"{n_fail} sibling groups have PMF > 1.0 ({n_pass} OK)\n"
                + "\n".join(report)
            )


# ── Phase 4: Historical asat visibility ─────────────────────────────────────

@requires_db
@requires_data_repo
@requires_python_be
class TestPhase4AsatVisibility:
    """Phase 4: historical asat lowers visible evidence and shifts boundaries.

    Only meaningful for synth-simple-abc (the bash test SKIPs others).
    """

    def _summarise_dc(self, payload: dict[str, Any]) -> dict[str, Any]:
        result = payload.get("result") or {}
        rs = result.get("data") or result.get("rate_by_cohort") or []

        def _date_sort_key(label: Optional[str]) -> Optional[tuple[int, int, int]]:
            if not label:
                return None
            day_s, mon_s, year_s = str(label).split("-")
            month = {
                "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4,
                "May": 5, "Jun": 6, "Jul": 7, "Aug": 8,
                "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
            }[mon_s]
            year = 2000 + int(year_s)
            return (year, month, int(day_s))

        mature = [
            r for r in rs
            if isinstance(r.get("completeness"), (int, float))
            and float(r["completeness"]) >= 0.95
        ]
        forecast = [
            r for r in rs
            if isinstance(r.get("completeness"), (int, float))
            and 0.0 < float(r["completeness"]) < 0.95
        ]
        null_comp = [r for r in rs if r.get("completeness") is None]
        return {
            "rows": len(rs),
            "mature_rows": len(mature),
            "forecast_rows": len(forecast),
            "null_completeness_rows": len(null_comp),
            "last_mature_date": mature[-1]["date"] if mature else None,
            "last_mature_sort_key": _date_sort_key(mature[-1]["date"] if mature else None),
            "first_forecast_date": forecast[0]["date"] if forecast else None,
            "first_null_completeness_date": null_comp[0]["date"] if null_comp else None,
        }

    def test_daily_conversions_boundary_shift(self, dc_live, dc_asat) -> None:
        """73q Phase 4 cutover: asat() shifts the mature→forecast boundary.

        Contract reclassified vs the pre-cutover canary (plan §"Known
        legacy gaps"): the runtime-backed date reducer reads per-Cohort
        completeness from the shared runtime CDF, so every admitted Cohort
        carries a real completeness (tiny for the youngest, never None).
        The legacy null-completeness band was an enrichment artefact. The
        post-cutover boundary shift is expressed by the asat-capped payload
        carrying fewer visible Cohorts, fewer mature Cohorts, and an earlier
        mature frontier. Both live and asat may contain forecast rows because
        the runtime now emits continuous completeness rather than a backend
        `layer` label.
        """
        if GRAPH != "synth-simple-abc":
            pytest.skip("historical asat fixture is defined only for synth-simple-abc")

        live_s = self._summarise_dc(dc_live)
        asat_s = self._summarise_dc(dc_asat)

        diagnostic = (
            "  Daily conversions boundary diagnostic:\n"
            + json.dumps({"live": live_s, "asat": asat_s}, indent=2)
        )

        ok = (
            live_s["rows"] > asat_s["rows"] > 0
            and live_s["null_completeness_rows"] == 0
            and asat_s["null_completeness_rows"] == 0
            and asat_s["mature_rows"] < live_s["mature_rows"]
            and asat_s["forecast_rows"] > 0
            and live_s["last_mature_date"] is not None
            and asat_s["last_mature_date"] is not None
            and asat_s["last_mature_sort_key"] < live_s["last_mature_sort_key"]
        )
        if not ok:
            pytest.fail(
                "daily_conversions did not expose the expected asat boundary shift\n"
                + diagnostic
            )

    def test_daily_conversions_completeness_matches_scalar_frontier_ratio(self) -> None:
        """Semantic invariant: the date reducer has NO completeness logic of its
        own — per-Cohort completeness must equal the shared FC
        frontier/terminal rate ratio for that same Cohort.

        Non-vacuous by construction: a single Cohort (arrivals at simple-b on
        10-Jan) observed as-at 20-Jan is age 10 days, so completeness ≈ 0.42,
        well below the mature ceiling.
        """
        if GRAPH != "synth-simple-abc":
            pytest.skip("fixture defined only for synth-simple-abc")
        dsl = "from(simple-a).to(simple-b).window(10-Jan-26:10-Jan-26).asat(20-Jan-26)"
        dc_rows = (_analyse(dsl, analysis_type="daily_conversions").get("result") or {}).get("data") or []
        assert len(dc_rows) == 1, f"expected a single Cohort row, got {len(dc_rows)}"
        dc_c = dc_rows[0].get("completeness")
        assert dc_c is not None and 0.0 < dc_c < 1.0, (
            f"expected a non-vacuous immature completeness, got {dc_c!r}"
        )
        pack = _param_pack(dsl)
        scalar_c = pack.get("e.simple-a-to-b.p.latency.completeness")
        assert scalar_c is not None, "param-pack scalar completeness missing for simple-a-to-b"
        cf_edges = (
            (_analyse(dsl, analysis_type="conditioned_forecast").get("scenarios") or [{}])[0]
            .get("edges") or []
        )
        assert len(cf_edges) == 1, f"expected one scalar edge, got {len(cf_edges)}"
        scalar_sd = cf_edges[0].get("completeness_sd")
        assert scalar_sd is not None and scalar_sd > 0, (
            f"scalar completeness_sd missing for simple-a-to-b: {scalar_sd!r}"
        )
        # The scalar endpoint is intentionally run at S=100. Compare the
        # same FC frontier/terminal quantity within the scalar mean's MC
        # standard-error envelope; this catches structural drift while not
        # treating the low-draw scalar estimate as exact.
        scalar_mc_se = scalar_sd / (100 ** 0.5)
        tolerance = max(1e-4, 3.0 * scalar_mc_se)
        # Single-Cohort query: the date reducer's per-Cohort completeness
        # should equal the scalar reducer's frontier/terminal FC ratio.
        assert abs(dc_c - scalar_c) <= tolerance, (
            f"daily_conversions completeness ({dc_c}) must equal scalar "
            f"frontier/terminal completeness ({scalar_c}) within scalar MC "
            f"tolerance ({tolerance}); |Δ|={abs(dc_c - scalar_c):.2e}"
        )

    def test_daily_conversions_window_cohort_do_not_collapse(self) -> None:
        """Semantic invariant: active cohort mode (A≠X) answers a different
        question than window mode on the same edge; the full conditioning +
        subject-resolution machinery must not collapse them (plan Invariant
        'Y/X invariant'; doc56 …do_not_collapse_window_and_cohort).

        synth-simple-abc is a→b→c. For edge b→c, cohort(simple-a,…) is active
        (A=a, X=b, A≠X) while window(…) is edge-local at b. Passes on the legacy
        path today (max |Δrate| ≈ 0.36) → regression guard for the cutover.
        """
        if GRAPH != "synth-simple-abc":
            pytest.skip("fixture defined only for synth-simple-abc")
        band = "1-Mar-26:14-Mar-26"
        edge = "from(simple-b).to(simple-c)"
        win = (_analyse(f"{edge}.window({band})", analysis_type="daily_conversions").get("result") or {}).get("data") or []
        coh = (_analyse(f"{edge}.cohort(simple-a,{band})", analysis_type="daily_conversions").get("result") or {}).get("data") or []
        w = {r["date"]: r for r in win if r.get("date")}
        c = {r["date"]: r for r in coh if r.get("date")}
        assert w and c, "both modes must return Cohort rows"
        shared = sorted(set(w) & set(c))
        assert shared, "expected overlapping Cohort dates to compare modes"
        max_drate = max(abs((w[d].get("rate") or 0.0) - (c[d].get("rate") or 0.0)) for d in shared)
        # Carrier-owned denominator + path-level timing make cohort(A≠X)
        # materially different from edge-local window; well above MC noise.
        assert max_drate > 1e-2, (
            f"window and cohort(A≠X) collapsed on b→c: max |Δrate|={max_drate:.2e} "
            f"across {len(shared)} shared Cohort dates — active cohort mode must differ"
        )

    def test_whole_graph_cf_lowers_visible_evidence(
        self, graph_data, wg_asat_live, wg_asat,
    ) -> None:
        if GRAPH != "synth-simple-abc":
            pytest.skip("historical asat fixture is defined only for synth-simple-abc")

        nmap = _node_id_map(graph_data)
        live_edges = {e.get("edge_uuid"): e for e in _wg_edges(wg_asat_live)}
        asat_edges = {e.get("edge_uuid"): e for e in _wg_edges(wg_asat)}

        rows: list[str] = []
        rows.append(
            f'{"edge":30s} | {"live n":>10s} | {"asat n":>10s} | '
            f'{"live k":>10s} | {"asat k":>10s} | '
            f'{"live comp":>10s} | {"asat comp":>10s} | result'
        )
        rows.append("-" * 118)

        def fmt(v, spec):
            return format(v, spec) if v is not None else "      None"

        n_pass = 0
        n_fail = 0
        for e in graph_data.get("edges", []):
            p_id = (e.get("p") or {}).get("id", "")
            to_name = nmap.get(e.get("to", ""), "")
            from_name = nmap.get(e.get("from", ""), "")
            if not p_id or "dropout" in to_name:
                continue
            label = f"{from_name} -> {to_name}"
            le = live_edges.get(e["uuid"])
            ae = asat_edges.get(e["uuid"])
            live_n = le.get("evidence_n") if le else None
            asat_n = ae.get("evidence_n") if ae else None
            live_k = le.get("evidence_k") if le else None
            asat_k = ae.get("evidence_k") if ae else None
            live_c = le.get("completeness") if le else None
            asat_c = ae.get("completeness") if ae else None
            ok = (
                live_n is not None and asat_n is not None and asat_n < live_n
                and live_k is not None and asat_k is not None and asat_k < live_k
                and live_c is not None and asat_c is not None and asat_c < live_c
            )
            status = "PASS" if ok else "FAIL"
            rows.append(
                f'{label:30s} | {fmt(live_n, "10.0f")} | {fmt(asat_n, "10.0f")} | '
                f'{fmt(live_k, "10.0f")} | {fmt(asat_k, "10.0f")} | '
                f'{fmt(live_c, "10.4f")} | {fmt(asat_c, "10.4f")} | {status}'
            )
            if ok:
                n_pass += 1
            else:
                n_fail += 1

        if n_fail > 0 or n_pass == 0:
            pytest.fail(
                f"whole-graph CF asat visibility failed ({n_pass} pass, {n_fail} fail)\n"
                + "\n".join(rows)
            )


# ── Phase 5: CF <-> param-pack evidence round-trip ──────────────────────────

def _param_pack(dsl: str) -> dict[str, Any]:
    args = [
        "--graph", _DATA_REPO_PATH or "",
        "--name", GRAPH,
        "--query", dsl,
        "--no-cache", "--format", "json",
    ]
    client = get_default_client() if _DATA_REPO_PATH else None
    if client is not None:
        try:
            return client.call_json("param-pack", args)
        except DaemonError as exc:
            raise AssertionError(
                f"daemon param-pack failed for {dsl!r} (exit {exc.exit_code}): {exc}\n"
                f"stderr:\n{exc.stderr[-2000:]}"
            )
    cmd = [
        "bash", str(_REPO_ROOT / "graph-ops" / "scripts" / "param-pack.sh"),
        GRAPH, dsl, "--no-cache", "--format", "json",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True,
                            cwd=str(_REPO_ROOT), timeout=300)
    if result.returncode != 0:
        raise AssertionError(
            f"param-pack.sh exited {result.returncode}\nstderr:\n{result.stderr[-2000:]}"
        )
    idx = result.stdout.find("{")
    return json.loads(result.stdout[idx:])


def _edge_name_from_uuid(graph: dict[str, Any], edge_uuid: str) -> Optional[str]:
    """Resolve the edge id used in param-pack keys (e.g. ``simple-a-to-b``)."""
    for e in graph.get("edges", []):
        if e.get("uuid") == edge_uuid:
            return e.get("id")
    return None


@pytest.fixture(scope="module")
def param_pack_live(_ready_synth) -> dict[str, Any]:
    return _param_pack(ASAT_TEMPORAL_DSL)


@pytest.fixture(scope="module")
def param_pack_asat(_ready_synth) -> dict[str, Any]:
    return _param_pack(f"{ASAT_TEMPORAL_DSL}.asat({ASAT_DATE})")


@requires_db
@requires_data_repo
@requires_python_be
class TestPhase5ParamPackEvidenceRoundTrip:
    """Phase 5: the CF endpoint's per-edge ``evidence_n`` / ``evidence_k``
    must reach ``edge.p.evidence.{n,k}`` via ``applyConditionedForecastToGraph``
    and surface in the param-pack output. Asserts the full round-trip:
    BE engine → CF response → FE upsert → param-pack.

    Tolerance: integer rounding both sides (CF rounds to int in
    ``api_handlers``; param-pack output already integer-valued for n/k),
    so equality is exact.
    """

    def _edge_evidence_pairs(
        self,
        graph: dict[str, Any],
        wg_payload: dict[str, Any],
        pack: dict[str, Any],
    ) -> list[tuple[str, dict[str, Any]]]:
        """Yield (label, {cf_n, cf_k, pack_n, pack_k}) per parameterised edge."""
        nmap = _node_id_map(graph)
        wg_by_uuid = _wg_edges_by_uuid(wg_payload)
        out: list[tuple[str, dict[str, Any]]] = []
        for e in graph.get("edges", []):
            p_id = (e.get("p") or {}).get("id", "")
            to_name = nmap.get(e.get("to", ""), "")
            from_name = nmap.get(e.get("from", ""), "")
            if not p_id or "dropout" in to_name:
                continue
            cf_edge = wg_by_uuid.get(e["uuid"]) or {}
            edge_id = _edge_name_from_uuid(graph, e["uuid"])
            if not edge_id:
                continue
            label = f"{from_name} -> {to_name}"
            out.append((label, {
                "cf_n": cf_edge.get("evidence_n"),
                "cf_k": cf_edge.get("evidence_k"),
                "pack_n": pack.get(f"e.{edge_id}.p.evidence.n"),
                "pack_k": pack.get(f"e.{edge_id}.p.evidence.k"),
            }))
        return out

    def _assert_round_trip(
        self,
        label_pairs: list[tuple[str, dict[str, Any]]],
        *,
        scenario: str,
    ) -> None:
        rows: list[str] = []
        rows.append(
            f'{"edge":30s} | {"cf n":>10s} | {"pack n":>10s} | '
            f'{"cf k":>10s} | {"pack k":>10s} | result'
        )
        rows.append("-" * 90)

        def fmt(v):
            return format(v, "10.0f") if isinstance(v, (int, float)) else "      None"

        n_pass = 0
        n_fail = 0
        for label, p in label_pairs:
            ok = (
                isinstance(p["cf_n"], (int, float))
                and isinstance(p["pack_n"], (int, float))
                and isinstance(p["cf_k"], (int, float))
                and isinstance(p["pack_k"], (int, float))
                and int(round(float(p["cf_n"]))) == int(round(float(p["pack_n"])))
                and int(round(float(p["cf_k"]))) == int(round(float(p["pack_k"])))
            )
            status = "PASS" if ok else "FAIL"
            rows.append(
                f'{label:30s} | {fmt(p["cf_n"])} | {fmt(p["pack_n"])} | '
                f'{fmt(p["cf_k"])} | {fmt(p["pack_k"])} | {status}'
            )
            if ok:
                n_pass += 1
            else:
                n_fail += 1

        if n_fail > 0 or n_pass == 0:
            pytest.fail(
                f"[{scenario}] CF -> param-pack evidence round-trip failed "
                f"({n_pass} pass, {n_fail} fail)\n" + "\n".join(rows)
            )

    def test_live_evidence_round_trip(
        self, graph_data, wg_asat_live, param_pack_live,
    ) -> None:
        if GRAPH != "synth-simple-abc":
            pytest.skip("round-trip fixture is defined only for synth-simple-abc")
        pairs = self._edge_evidence_pairs(graph_data, wg_asat_live, param_pack_live)
        assert pairs, "no parameterised edges to compare"
        self._assert_round_trip(pairs, scenario="live")

    def test_asat_evidence_round_trip(
        self, graph_data, wg_asat, param_pack_asat,
    ) -> None:
        if GRAPH != "synth-simple-abc":
            pytest.skip("round-trip fixture is defined only for synth-simple-abc")
        pairs = self._edge_evidence_pairs(graph_data, wg_asat, param_pack_asat)
        assert pairs, "no parameterised edges to compare"
        self._assert_round_trip(pairs, scenario="asat")
