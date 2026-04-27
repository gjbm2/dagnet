"""
Pytest configuration for tests under graph-editor/lib/tests.

Provides:
  - sys.path setup so `import lib.*` works
  - Shared fixtures: data_repo_dir, db_url
  - Shared markers: requires_db, requires_data_repo
  - Declarative synth fixture: requires_synth(
        graph_name,
        enriched=bool,
        bayesian=bool,
    )

Bayesian synth contract:
  - `bayesian=True` uses a fingerprinted sidecar in `bayes/fixtures/`
    and replays that cached Bayes payload through the canonical TS
    `applyPatch` path in memory only.
  - The synth graph JSON on disk is not the storage location for Bayes
    vars/posteriors and must not be rewritten during routine pytest
    loads.
  - There is deliberately no fixture-level "force refit" switch here.
    Fresh sidecars are commissioned manually outside the shared pytest
    loader so normal tests do not rerun MCMC.
"""

from __future__ import annotations

import base64
import copy
import functools
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml


# ── sys.path setup ────���─────────────────────────────────────────────────────

GRAPH_EDITOR_DIR = Path(__file__).resolve().parents[2]  # .../graph-editor
DAGNET_ROOT = GRAPH_EDITOR_DIR.parent

if str(GRAPH_EDITOR_DIR) not in sys.path:
    sys.path.insert(0, str(GRAPH_EDITOR_DIR))


# ── Shared resolution helpers ──────���────────────────────────────────────────

def _resolve_data_repo_dir(root: str | None = None) -> Path | None:
    """Resolve data repo from .private-repos.conf. Returns None if unavailable."""
    dagnet = Path(root) if root else DAGNET_ROOT
    conf = dagnet / ".private-repos.conf"
    if not conf.exists():
        return None
    for line in conf.read_text().splitlines():
        if line.startswith("DATA_REPO_DIR="):
            repo_dir = dagnet / line.split("=", 1)[1].strip().strip('"')
            if (repo_dir / "graphs").is_dir():
                return repo_dir
    return None


def _resolve_db_url() -> str:
    """Load DB_CONNECTION from environment or .env.local."""
    url = os.environ.get("DB_CONNECTION", "")
    if url:
        return url
    env_path = GRAPH_EDITOR_DIR / ".env.local"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line.startswith("DB_CONNECTION="):
                return line.split("=", 1)[1].strip().strip('"')
    return ""


def _ensure_db_connection_env() -> str:
    """Populate DB_CONNECTION from .env.local when tests need the DB."""
    url = _resolve_db_url()
    if not url:
        pytest.skip("DB_CONNECTION not set")
    os.environ.setdefault("DB_CONNECTION", url)
    return url


@functools.lru_cache(maxsize=None)
def _load_graph_text(graph_name: str) -> str:
    """Read a graph JSON file once per session."""
    repo = _resolve_data_repo_dir()
    if repo is None:
        raise FileNotFoundError("Data repo not available")
    path = repo / "graphs" / f"{graph_name}.json"
    if not path.exists():
        raise FileNotFoundError(f"Graph not found at {path}")
    return path.read_text()


def load_graph_json(
    graph_name: str,
    *,
    bayesian: bool = False,
) -> dict[str, Any]:
    """Load a graph JSON as a fresh mutable dict.

    When `bayesian=True`, ensure a usable bayesian sidecar exists
    (building it via MCMC if missing or stale) and replay the cached raw
    Bayes payload through the canonical TS `applyPatch` path in memory.

    The on-disk graph file is not mutated — bayesian state lives purely
    in the sidecar and is re-projected at each load.

    Deliberately no "force refit" switch here: routine pytest surfaces
    must reuse the fingerprinted sidecar rather than re-commissioning
    Bayes on every run.
    """
    if bayesian:
        sidecar_path = _ensure_bayes_sidecar(graph_name)
        if sidecar_path is None:
            pytest.skip(
                f"Bayesian sidecar unavailable for {graph_name} "
                f"(MCMC subprocess failed or bayes worker not reachable)"
            )
        graph = _apply_bayes_sidecar_in_memory(graph_name, sidecar_path)
        if graph is None:
            pytest.skip(
                f"Bayesian sidecar could not be replayed through TS apply-patch "
                f"for {graph_name}"
            )
        return graph

    try:
        graph = json.loads(_load_graph_text(graph_name))
    except FileNotFoundError as exc:
        pytest.skip(str(exc))
    return graph


@functools.lru_cache(maxsize=None)
def _load_db_hashes_by_mode_cached(graph_name: str) -> dict[str, dict[str, list[str]]]:
    """Map each edge UUID to its window/cohort snapshot hashes."""
    _ensure_db_connection_env()
    graph = json.loads(_load_graph_text(graph_name))

    from snapshot_service import _pooled_conn

    result: dict[str, dict[str, list[str]]] = {}
    with _pooled_conn() as conn:
        cur = conn.cursor()
        for edge in graph.get("edges", []):
            p_id = edge.get("p", {}).get("id", "")
            if not p_id:
                continue
            cur.execute(
                "SELECT DISTINCT core_hash, slice_key FROM snapshots "
                "WHERE param_id LIKE %s AND core_hash != '' "
                "AND core_hash NOT LIKE 'PLACEHOLDER%%' "
                "AND slice_key NOT LIKE 'context%%' "
                "ORDER BY core_hash",
                (f"%{p_id}",),
            )
            rows = cur.fetchall()
            if not rows:
                continue
            by_mode = {"window": [], "cohort": []}
            for core_hash, slice_key in rows:
                slice_key = slice_key or ""
                if "window" in slice_key:
                    by_mode["window"].append(core_hash)
                elif "cohort" in slice_key:
                    by_mode["cohort"].append(core_hash)
            result[edge["uuid"]] = by_mode
    return result


def load_db_hashes_by_mode(graph_name: str) -> dict[str, dict[str, list[str]]]:
    """Return a fresh copy of the DB temporal-mode hash map."""
    return copy.deepcopy(_load_db_hashes_by_mode_cached(graph_name))


@functools.lru_cache(maxsize=None)
def _load_candidate_regimes_by_mode_cached(
    graph_name: str,
) -> dict[str, list[dict[str, Any]]]:
    """Build FE-style candidate regimes with temporal_mode tags."""
    by_mode = _load_db_hashes_by_mode_cached(graph_name)
    graph = json.loads(_load_graph_text(graph_name))
    repo = _resolve_data_repo_dir()

    def _short_core_hash(signature: str) -> str:
        digest = hashlib.sha256(signature.encode("utf-8")).digest()[:16]
        return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")

    def _extract_cohort_anchor(slice_dsl: str) -> str | None:
        match = re.search(r"cohort\(([^)]*)\)", str(slice_dsl or ""))
        if not match:
            return None
        args = match.group(1)
        comma_idx = args.find(",")
        if comma_idx <= 0:
            return None
        head = args[:comma_idx].strip()
        return None if ":" in head else head

    hash_meta: dict[str, dict[str, dict[str, Any]]] = {}
    if repo is not None:
        for edge in graph.get("edges", []):
            edge_uuid = edge.get("uuid")
            param_id = edge.get("p", {}).get("id", "")
            if not edge_uuid or not param_id:
                continue
            file_id = param_id.replace("parameter-", "") if param_id.startswith("parameter-") else param_id
            param_path = repo / "parameters" / f"{file_id}.yaml"
            if not param_path.exists():
                continue
            try:
                payload = yaml.safe_load(param_path.read_text()) or {}
            except Exception:
                continue
            values = payload.get("values") or []
            if not isinstance(values, list):
                continue
            edge_meta = hash_meta.setdefault(edge_uuid, {})
            for value in values:
                if not isinstance(value, dict):
                    continue
                signature = value.get("query_signature")
                slice_dsl = value.get("sliceDSL", "")
                if not signature or not slice_dsl:
                    continue
                mode = "cohort" if "cohort" in slice_dsl else "window" if "window" in slice_dsl else None
                if mode is None:
                    continue
                edge_meta[_short_core_hash(signature)] = {
                    "temporal_mode": mode,
                    "cohort_anchor": _extract_cohort_anchor(slice_dsl),
                }

    regimes: dict[str, list[dict[str, Any]]] = {}
    for edge_uuid, mode_hashes in by_mode.items():
        edge_regimes: list[dict[str, Any]] = []
        window_hashes = mode_hashes.get("window", [])
        cohort_hashes = mode_hashes.get("cohort", [])
        if window_hashes:
            edge_regimes.append(
                {
                    "core_hash": window_hashes[0],
                    "equivalent_hashes": window_hashes[1:],
                    "temporal_mode": "window",
                }
            )
        if cohort_hashes:
            cohort_groups: dict[str, list[str]] = {}
            cohort_anchors: dict[str, str | None] = {}
            edge_meta = hash_meta.get(edge_uuid, {})
            for core_hash in cohort_hashes:
                meta = edge_meta.get(core_hash, {})
                anchor = meta.get("cohort_anchor")
                group_key = str(anchor or "")
                cohort_groups.setdefault(group_key, []).append(core_hash)
                cohort_anchors[group_key] = anchor
            for group_key, grouped_hashes in cohort_groups.items():
                if not grouped_hashes:
                    continue
                edge_regimes.append(
                    {
                        "core_hash": grouped_hashes[0],
                        "equivalent_hashes": grouped_hashes[1:],
                        "temporal_mode": "cohort",
                        "cohort_anchor": cohort_anchors.get(group_key),
                    }
                )
        if edge_regimes:
            regimes[edge_uuid] = edge_regimes
    return regimes


def load_candidate_regimes_by_mode(
    graph_name: str,
) -> dict[str, list[dict[str, Any]]]:
    """Return a fresh copy of cached candidate regimes."""
    return copy.deepcopy(_load_candidate_regimes_by_mode_cached(graph_name))


# ── Session fixtures ───────────────��────────────────────────────��───────────

@pytest.fixture(scope="session")
def data_repo_dir() -> Path | None:
    return _resolve_data_repo_dir()


@pytest.fixture(scope="session")
def db_url() -> str:
    return _resolve_db_url()


# ── Skip markers (single definitions — no more copy-paste) ─────────────────

_DATA_REPO = _resolve_data_repo_dir()
_DB_URL = _resolve_db_url()

requires_db = pytest.mark.skipif(not _DB_URL, reason="DB_CONNECTION not set")
requires_data_repo = pytest.mark.skipif(
    _DATA_REPO is None, reason="Data repo not available"
)


# ── Declarative synth fixture ─────────────────────────────────────────────

# Session-scoped cache: graph_name → status after verification/bootstrap.
# Prevents redundant regen within a single pytest session.
_SYNTH_CACHE: dict[str, str] = {}

# Session-scoped cache of fresh sidecar file paths
# (`graph_name:fingerprint-json` → absolute path). Prevents MCMC from
# running more than once per fingerprint per pytest process.
_SIDECAR_CACHE: dict[str, str] = {}


def _synth_cache_clear():
    """Clear the session cache (for testing the fixture itself)."""
    _SYNTH_CACHE.clear()
    _SIDECAR_CACHE.clear()


# ── Bayesian sidecar resolution ──────────────────────────────────────────

def _resolve_bayes_fixtures_dir() -> Path:
    """Where committed bayesian sidecars live."""
    return DAGNET_ROOT / "bayes" / "fixtures"


def _resolve_truth_path(graph_name: str) -> Path | None:
    """Return the truth YAML for this graph, preferring the canonical
    location (bayes/truth/) over the data repo's graphs/ dir.

    Matches verify_synth_data's lookup order."""
    canonical = DAGNET_ROOT / "bayes" / "truth" / f"{graph_name}.truth.yaml"
    if canonical.is_file():
        return canonical
    repo = _resolve_data_repo_dir()
    if repo is not None:
        candidate = repo / "graphs" / f"{graph_name}.truth.yaml"
        if candidate.is_file():
            return candidate
    return None


def _resolve_param_paths(graph_name: str) -> list[Path]:
    """Resolve per-edge param YAML files for the fingerprint. Inspects
    the graph's edges for `p.id`, then looks each up in the data repo's
    parameters/ dir. Missing files are silently dropped — fingerprint
    still catches meaningful changes via truth + the params that exist.
    """
    repo = _resolve_data_repo_dir()
    if repo is None:
        return []
    try:
        graph = json.loads(_load_graph_text(graph_name))
    except FileNotFoundError:
        return []
    param_ids: list[str] = []
    for edge in graph.get("edges", []):
        pid = (edge.get("p") or {}).get("id") or edge.get("id")
        if pid and pid not in param_ids:
            param_ids.append(pid)
    paths = [repo / "parameters" / f"{pid}.yaml" for pid in param_ids]
    return [p for p in paths if p.is_file()]


def _compute_bayes_fingerprint(graph_name: str):
    """Return the fingerprint for a graph's bayesian sidecar, or None
    if the truth file is missing (fingerprint cannot be computed)."""
    truth_path = _resolve_truth_path(graph_name)
    if truth_path is None:
        return None
    root = str(DAGNET_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)
    from bayes.sidecar import compute_fingerprint
    param_paths = _resolve_param_paths(graph_name)
    return compute_fingerprint(str(truth_path), [str(p) for p in param_paths])


def _sidecar_cache_key(graph_name: str, fingerprint: dict[str, Any]) -> str:
    return f"{graph_name}:{json.dumps(fingerprint, sort_keys=True)}"


def _explain_sidecar_staleness(
    sidecar_path: Path,
    expected_fingerprint: dict[str, Any],
) -> list[str]:
    """Return human-readable reasons load_sidecar() rejected the file.

    Mirrors the rejection contract in bayes.sidecar.load_sidecar — file
    missing, schema drift, or fingerprint mismatch — but expanded into
    a list of specific reasons so the operator can see exactly what
    changed before MCMC is launched.
    """
    if not sidecar_path.is_file():
        return [f"sidecar file missing: {sidecar_path}"]
    try:
        data = json.loads(sidecar_path.read_text())
    except Exception as exc:
        return [f"sidecar unreadable ({type(exc).__name__}): {exc}"]
    from bayes.sidecar import SCHEMA_VERSION
    if data.get("schema_version") != SCHEMA_VERSION:
        return [
            f"schema_version drift: expected={SCHEMA_VERSION!r} "
            f"found={data.get('schema_version')!r}"
        ]
    saved = data.get("sidecar_fingerprint") or {}
    if saved == expected_fingerprint:
        # Defensive — if we got here, load_sidecar should have returned
        # the data; report so the operator knows we got an unexpected path.
        return ["fingerprints match but load_sidecar returned None (investigate)"]
    diffs: list[str] = []
    keys = set(saved) | set(expected_fingerprint)
    for k in sorted(keys):
        if saved.get(k) != expected_fingerprint.get(k):
            diffs.append(
                f"fingerprint[{k}] changed: saved={saved.get(k)!r} "
                f"expected={expected_fingerprint.get(k)!r}"
            )
    return diffs or ["fingerprint mismatch (no field-level diff isolated)"]


def _ensure_bayes_sidecar(
    graph_name: str,
):
    """Return the fresh sidecar path for `graph_name`, running MCMC via
    `bayes.test_harness --fe-payload --sidecar-out` when missing or stale.

    Session-cached — at most one MCMC run per process for a given
    fingerprint. Fresh sidecars are reused; only missing or stale
    sidecars trigger the harness.

    Returns None when the subprocess fails — caller is expected to
    pytest.skip. Never writes to the graph file. Contract coverage lives
    in `graph-editor/lib/tests/test_bayes_sidecar_conftest.py` and
    `bayes/tests/test_test_harness_sidecar.py`.
    """
    root = str(DAGNET_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)
    from bayes.sidecar import load_sidecar

    fingerprint = _compute_bayes_fingerprint(graph_name)
    if fingerprint is None:
        return None
    cache_key = _sidecar_cache_key(graph_name, fingerprint)
    if cache_key in _SIDECAR_CACHE:
        return _SIDECAR_CACHE[cache_key]
    sidecar_path = _resolve_bayes_fixtures_dir() / f"{graph_name}.bayes-vars.json"
    sidecar_payload = load_sidecar(str(sidecar_path), expected_fingerprint=fingerprint)
    if sidecar_payload is not None:
        _SIDECAR_CACHE[cache_key] = str(sidecar_path)
        return str(sidecar_path)

    # Audit trail: explain WHY the sidecar was rejected before kicking
    # off a multi-minute MCMC. "Stale" with no reason is unacceptable.
    reasons = _explain_sidecar_staleness(sidecar_path, fingerprint)
    print(
        f"[requires_synth] {graph_name}: bayesian sidecar rejected — "
        f"running MCMC (this may take minutes). Reasons:"
    )
    for r in reasons:
        print(f"[requires_synth]   • {r}")
    sidecar_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable, "-m", "bayes.test_harness",
        "--graph", graph_name,
        "--fe-payload",
        "--enrich",
        "--no-webhook",
        "--sidecar-out", str(sidecar_path),
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=900,
        cwd=str(DAGNET_ROOT),
        env={**os.environ, "DB_CONNECTION": _resolve_db_url()},
    )
    if result.returncode != 0:
        print(f"[requires_synth] sidecar MCMC failed for {graph_name}:\n"
              f"{result.stderr[-2000:]}")
        return None

    sidecar_payload = load_sidecar(str(sidecar_path), expected_fingerprint=fingerprint)
    if sidecar_payload is None:
        print(f"[requires_synth] MCMC completed but sidecar missing or "
              f"fingerprint mismatched for {graph_name}")
        return None
    _SIDECAR_CACHE[cache_key] = str(sidecar_path)
    return str(sidecar_path)


def _apply_bayes_sidecar_in_memory(
    graph_name: str,
    sidecar_path: str,
) -> dict[str, Any] | None:
    """Replay a cached Bayes sidecar through the TS CLI in memory.

    The CLI uses the production `applyPatch` path but, with
    `--print-enriched-graph`, skips all disk writeback and returns the
    enriched graph JSON on stdout.
    """
    repo = _resolve_data_repo_dir()
    if repo is None:
        return None

    graph_editor_dir = DAGNET_ROOT / "graph-editor"
    nvm_prefix = (
        'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}" && '
        '. "$NVM_DIR/nvm.sh" 2>/dev/null; '
        f'cd {shlex.quote(str(graph_editor_dir))} && '
        'nvm use "$(cat .nvmrc)" >/dev/null 2>&1; '
    )
    tsx_cmd = (
        f"{nvm_prefix}"
        "npx tsx src/cli/bayes.ts "
        f"--graph {shlex.quote(str(repo))} "
        f"--name {shlex.quote(graph_name)} "
        f"--apply-patch {shlex.quote(sidecar_path)} "
        "--print-enriched-graph --no-cache"
    )
    result = subprocess.run(
        ["bash", "-lc", tsx_cmd],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(DAGNET_ROOT),
        env=dict(os.environ),
    )
    if result.returncode != 0:
        print(
            f"[requires_synth] TS apply-patch replay failed for {graph_name}:\n"
            f"{result.stderr[-2000:]}"
        )
        return None
    stdout = result.stdout
    json_start = stdout.find("{")
    if json_start < 0:
        print(
            f"[requires_synth] TS apply-patch replay returned no JSON stdout "
            f"for {graph_name}:\n{stdout[-2000:]}"
        )
        return None
    try:
        return json.loads(stdout[json_start:])
    except json.JSONDecodeError:
        print(
            f"[requires_synth] TS apply-patch replay returned non-JSON stdout "
            f"for {graph_name}:\n{stdout[-2000:]}"
        )
        return None


def _call_verify_synth_data(graph_name: str, data_repo: str, **kwargs) -> dict:
    """Call verify_synth_data from bayes.synth_gen.

    Isolated into a function so tests can patch it.
    """
    # Add dagnet root to sys.path so bayes.synth_gen is importable
    root = str(DAGNET_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)
    from bayes.synth_gen import verify_synth_data
    return verify_synth_data(graph_name, data_repo, **kwargs)


def _bootstrap_synth_graph(graph_name: str, *, enrich: bool = False,
                            bust_cache: bool = False) -> bool:
    """Run synth_gen.py to regenerate a graph. Returns True on success."""
    cmd = [
        sys.executable, "-m", "bayes.synth_gen",
        "--graph", graph_name,
        "--write-files",
    ]
    if bust_cache:
        cmd.append("--bust-cache")
    if enrich:
        cmd.append("--enrich")

    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=600,
        cwd=str(DAGNET_ROOT),
        env={**os.environ, "DB_CONNECTION": _resolve_db_url()},
    )
    if result.returncode != 0:
        print(f"[requires_synth] Bootstrap failed for {graph_name}:\n{result.stderr[:500]}")
        return False
    return True


def _ensure_synth_ready(
    graph_name: str,
    enriched: bool,
    bayesian: bool = False,
    *,
    check_fe_parity: bool = True,
) -> None:
    """Check freshness and bootstrap if needed. Calls pytest.skip on failure.

    `bayesian=True` triggers the bayesian-sidecar path (usable sidecar
    ensured in `bayes/fixtures/`).

    The on-disk graph file is never mutated for bayesian state —
    canonical TS apply-patch replay happens at
    `load_graph_json(..., bayesian=True)` call time.

    `check_fe_parity` (default True) controls the cross-runtime probe
    inside `verify_synth_data` that spawns an FE CLI subprocess per
    graph to detect FE-interpretation drift invisible to file hashes.
    Pass `False` from tests that themselves invoke the FE CLI per
    graph — the test's own assertions already surface that drift, and
    skipping the probe drops the per-graph freshness cost from
    ~1s of CLI startup to a few ms of file-hash checks.
    """
    repo = _resolve_data_repo_dir()
    if repo is None:
        pytest.skip("Data repo not available")
    db = _resolve_db_url()
    if not db:
        pytest.skip("DB_CONNECTION not set")

    cache_key = (
        f"{graph_name}:enriched={enriched}:bayesian={bayesian}"
    )
    if cache_key in _SYNTH_CACHE:
        return

    # Structural freshness: truth + params + DB rows. Bayesian state is
    # NOT checked here — it lives in the sidecar and is resolved at
    # load_graph_json(bayesian=True) time. This split prevents a bayesian
    # mutation (which the sidecar handles) from invalidating structural
    # freshness and triggering an expensive DB regen.
    need_enrich = enriched or bayesian

    result = _call_verify_synth_data(
        graph_name, str(repo),
        check_enrichment=need_enrich,
        check_bayesian=False,
        check_param_files=True,
        check_event_hashes=True,
        check_fe_parity=check_fe_parity,
    )
    status = result["status"]

    if status in ("stale", "missing"):
        # Surface every reason the verifier flagged — operators must be
        # able to see WHY a regen happened. "Just runs sometimes" is not
        # acceptable for dev-tool reliability.
        reasons = result.get("reasons") or [result.get("reason", "<no reason>")]
        print(f"[requires_synth] {graph_name}: {status} — bootstrapping. Reasons:")
        for r in reasons:
            print(f"[requires_synth]   • {r}")
        ok = _bootstrap_synth_graph(graph_name)
        if not ok:
            pytest.skip(f"Synth bootstrap failed for {graph_name}")
        if need_enrich:
            status = "needs_enrichment"
        else:
            status = "fresh"

    if status == "needs_enrichment" and need_enrich:
        reasons = result.get("reasons") or [result.get("reason", "needs enrichment")]
        print(f"[requires_synth] {graph_name}: enriching (hydrate). Reasons:")
        for r in reasons:
            print(f"[requires_synth]   • {r}")
        ok = _bootstrap_synth_graph(graph_name, enrich=True)
        if not ok:
            pytest.skip(f"Synth enrichment failed for {graph_name}")
        status = "fresh"

    if status == "no_truth":
        pytest.skip(f"No truth file for {graph_name}")

    # Bayesian sidecar: ensured separately so graph-file clobber can no
    # longer destroy MCMC work. The returned sidecar is replayed through
    # the canonical TS apply-patch path at load time.
    if bayesian:
        sidecar_path = _ensure_bayes_sidecar(graph_name)
        if sidecar_path is None:
            pytest.skip(
                f"Bayesian sidecar unavailable for {graph_name} "
                f"(MCMC subprocess failed or bayes worker not reachable)"
            )

    _SYNTH_CACHE[cache_key] = status


def requires_synth(
    graph_name: str,
    *,
    enriched: bool = False,
    bayesian: bool = False,
):
    """Decorator that ensures a synth graph is ready before the test runs.

    Works on both functions and classes. When applied to a class, wraps
    every test method.

    Checks freshness via verify_synth_data. If stale or missing, triggers
    bootstrap via synth_gen.py --write-files. If enriched=True (or
    bayesian=True, which implies it) and graph is not hydrate-enriched,
    triggers synth_gen.py --enrich. If bayesian=True, additionally
    ensures the fingerprinted sidecar in `bayes/fixtures/` exists before
    the graph is loaded and replayed through the canonical TS
    apply-patch path at runtime.

    Skips cleanly if infrastructure (data repo, DB, bayes worker) is
    unavailable. Session-scoped: regen/enrichment happens at most once
    per (graph, enriched, bayesian) tuple per session.
    """
    def decorator(fn_or_cls):
        import inspect
        if inspect.isclass(fn_or_cls):
            # Class decorator: wrap every test_ method
            for name in list(vars(fn_or_cls)):
                if name.startswith("test_") and callable(getattr(fn_or_cls, name)):
                    original = getattr(fn_or_cls, name)
                    @functools.wraps(original)
                    def wrapped(*args, _orig=original, **kwargs):
                        _ensure_synth_ready(
                            graph_name,
                            enriched,
                            bayesian,
                        )
                        return _orig(*args, **kwargs)
                    setattr(fn_or_cls, name, wrapped)
            return fn_or_cls
        else:
            @functools.wraps(fn_or_cls)
            def wrapper(*args, **kwargs):
                _ensure_synth_ready(
                    graph_name,
                    enriched,
                    bayesian,
                )
                return fn_or_cls(*args, **kwargs)
            return wrapper
    return decorator
