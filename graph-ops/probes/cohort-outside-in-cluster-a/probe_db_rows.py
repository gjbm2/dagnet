"""Enumerate snapshot rows for SIMPLE A→B in the carrier binding scope.

Used during Cluster A investigation to confirm the per-anchor carrier
k_w time-series — proves that the snapshot DB returns 52 rows
(17+18+17 across the 3 anchor days), with k_w summing exactly to the
oracle's 2696 at τ=8. Excludes the supersession hypothesis.

See `docs/current/cohort-outside-in-post-73n-regression-tracker.md`
§Cluster A.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, "/home/reg/dev/dagnet/graph-editor/lib")
sys.path.insert(0, "/home/reg/dev/dagnet/graph-editor/lib/tests")

_REPO_ROOT = Path("/home/reg/dev/dagnet")
_conf = _REPO_ROOT / ".private-repos.conf"
data_repo_dir = None
for raw in _conf.read_text().splitlines():
    line = raw.strip()
    if line.startswith("DATA_REPO_DIR"):
        data_repo_dir = str(_REPO_ROOT / line.split("=", 1)[1].strip())
        break

os.environ["DAGNET_DATA_REPO_DIR"] = data_repo_dir

import snapshot_service as svc  # noqa: E402

graph_path = Path(data_repo_dir) / "graphs" / "synth-simple-abc.json"
graph = json.loads(graph_path.read_text())
edges = {e.get("p", {}).get("id"): e for e in graph.get("edges", []) if e.get("p")}

# Find the A→B edge by its p.id
ab_edge = edges.get("simple-a-to-b")
print("AB edge:", json.dumps({
    "uuid": ab_edge.get("uuid"),
    "p": ab_edge.get("p"),
    "from": ab_edge.get("from"),
    "to": ab_edge.get("to"),
}, indent=2))

# Find candidate regimes via load_candidate_regimes_by_mode
from conftest import load_candidate_regimes_by_mode  # noqa: E402

regimes_by_uuid = load_candidate_regimes_by_mode("synth-simple-abc")
ab_regimes = regimes_by_uuid.get(str(ab_edge["uuid"]), [])
print(f"\nAB regimes: {len(ab_regimes)}")
for r in ab_regimes:
    print(f"  mode={r.get('temporal_mode')} core_hash={r.get('core_hash')} anchor={r.get('cohort_anchor')}")

# Pick the WINDOW regime — that's what WINDOW_SUBJECT_HELPER admits
window_regime = next((r for r in ab_regimes if r.get("temporal_mode") == "window"), None)
print(f"\nwindow regime: {window_regime}")

from datetime import date  # noqa: E402

# Replicate the carrier binding scope: date_from..date_to = anchor window
af = "2026-03-01"
at = "2026-03-03"
sweep_to = "2026-03-20"

# Query window snapshots over [af..at] for [af..sweep_to]
rows = svc.query_snapshots_for_sweep(
    param_id=ab_edge["p"]["id"],
    core_hash=str(window_regime["core_hash"]),
    anchor_from=date.fromisoformat(af),
    anchor_to=date.fromisoformat(at),
    sweep_from=date.fromisoformat(af),
    sweep_to=date.fromisoformat(sweep_to),
    equivalent_hashes=[
        {"core_hash": h} for h in (window_regime.get("equivalent_hashes") or [])
    ],
)
print(f"\nwindow rows in [{af}..{at}] × [{af}..{sweep_to}]: {len(rows)}")

# Group by observed_date and count retrievals per group
from collections import defaultdict
by_obs = defaultdict(list)
for r in rows:
    od = str(r.get("observed_date") or r.get("anchor_day") or "")[:10]
    rd = str(r.get("retrieved_at") or "")[:10]
    if od and rd:
        by_obs[od].append((rd, r.get("x"), r.get("y"), r.get("n"), r.get("k")))

print(f"\nunique observed_dates: {len(by_obs)}")
print("\n--- y growth across retrievals (one row per unique retrieval, max-y kept) ---")
for od in sorted(by_obs):
    by_ret = {}
    for retrieval, x, y, n, k in by_obs[od]:
        prev = by_ret.get(retrieval)
        if prev is None or (y or 0) > (prev[1] or 0):
            by_ret[retrieval] = (x, y)
    print(f"\nobs={od}: x stays at {next(iter(by_ret.values()))[0]}, y series:")
    for retrieval in sorted(by_ret):
        x, y = by_ret[retrieval]
        # tau computed as (retrieval - obs).days
        from datetime import date as _date
        tau = (_date.fromisoformat(retrieval) - _date.fromisoformat(od)).days
        print(f"  ret={retrieval} (τ={tau:>2}): y={y}")
