"""Probe the SIMPLE single-hop case with --diag and dump carrier/subject surface diagnostics.

Used for the Cluster A two-clock root-day defect investigation.
See `docs/current/cohort-outside-in-post-73n-regression-tracker.md` §Cluster A.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, "/home/reg/dev/dagnet/graph-editor/lib")
sys.path.insert(0, "/home/reg/dev/dagnet/graph-editor/lib/tests")

from tests._daemon_client import get_default_client  # noqa: E402

_REPO_ROOT = Path("/home/reg/dev/dagnet")


def _resolve_data_repo_path():
    conf = _REPO_ROOT / ".private-repos.conf"
    if not conf.exists():
        return None
    for raw in conf.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line and line.startswith("DATA_REPO_DIR"):
            return str(_REPO_ROOT / line.split("=", 1)[1].strip())
    return None


_DATA_REPO_PATH = _resolve_data_repo_path()
print("DATA_REPO_PATH:", _DATA_REPO_PATH)

client = get_default_client()
if client is None:
    print("no daemon client")
    sys.exit(1)

graph = "synth-simple-abc"
dsl = "from(simple-b).to(simple-c).cohort(1-Mar-26:3-Mar-26).asat(20-Mar-26)"

args = [
    "--graph", _DATA_REPO_PATH,
    "--name", graph,
    "--query", dsl,
    "--type", "cohort_maturity",
    "--format", "json",
    "--no-cache", "--no-snapshot-cache",
    "--diag",
]
print("calling daemon analyse with --diag ...")
result = client.call_json("analyse", args)

rows = (result.get("result") or {}).get("data") or []
print("row count:", len(rows))
if not rows:
    print(json.dumps(result, indent=2)[:4000])
    sys.exit(0)

block = rows[0].get("_selected_a_clock_evidence")
if block is None:
    print("no _selected_a_clock_evidence block")
    print("row[0] keys:", sorted(rows[0].keys()))
    sys.exit(0)

print("\n=== diagnostics ===")
print(json.dumps(block.get("diagnostics") or {}, indent=2)[:2000])

carrier_surface = block.get("carrier_surface")
subject_surface = block.get("subject_surface")
print("\n=== carrier_surface (provenance, no row_lineage) ===")
if carrier_surface:
    prov = dict(carrier_surface.get("provenance") or {})
    row_lineage = prov.pop("row_lineage", None)
    print(json.dumps({"role": carrier_surface.get("role"),
                      "root_node": carrier_surface.get("root_node"),
                      "end_node": carrier_surface.get("end_node"),
                      "edge_ids": carrier_surface.get("edge_ids"),
                      "provenance": prov}, indent=2, default=str)[:3000])

    if row_lineage is not None:
        print(f"\ncarrier row_lineage entries: {len(row_lineage)}")
        # Group by edge_id and show observed_date / placements
        for i, entry in enumerate(row_lineage[:40]):
            print(f"  [{i}] edge={entry.get('edge_id')} obs={entry.get('observed_date')} ret={entry.get('retrieved_at')} k_w={entry.get('k_weighted')} placements={entry.get('placements')[:3]} clock={entry.get('clock_decision')}")

print("\n=== subject_surface (provenance, no row_lineage) ===")
if subject_surface:
    prov = dict(subject_surface.get("provenance") or {})
    row_lineage = prov.pop("row_lineage", None)
    print(json.dumps({"role": subject_surface.get("role"),
                      "root_node": subject_surface.get("root_node"),
                      "end_node": subject_surface.get("end_node"),
                      "edge_ids": subject_surface.get("edge_ids"),
                      "provenance": prov}, indent=2, default=str)[:3000])
    if row_lineage is not None:
        print(f"\nsubject row_lineage entries: {len(row_lineage)}")
        for i, entry in enumerate(row_lineage[:40]):
            print(f"  [{i}] edge={entry.get('edge_id')} obs={entry.get('observed_date')} ret={entry.get('retrieved_at')} k_w={entry.get('k_weighted')} placements={entry.get('placements')[:3]} clock={entry.get('clock_decision')}")

cells = block.get("cells") or []
print(f"\n=== {len(cells)} emitted cells ===")
for cell in cells:
    print(f"  ad={cell.get('anchor_day')} τ={cell.get('tau')} x={cell.get('x_at_query_x')} y={cell.get('y_at_subject_end')}")

# Also dump per-row tau evidence around τ=8..20
print("\n=== row evidence τ=0..25 ===")
for r in rows:
    t = r.get("tau_days")
    if t is None or t > 25:
        continue
    print(f"  τ={t} ev_x={r.get('evidence_x')} ev_y={r.get('evidence_y')} rate={r.get('rate')} midpoint={r.get('midpoint')}")
