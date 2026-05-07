"""Probe LAT4 multi-hop: same diagnostic surface as probe_simple_evidence
but for the LAT4 fixture and the BD multi-hop subject span.

Used during Cluster A investigation to confirm the missing-anchors
defect manifested in multi-hop too. With the longer carrier span
(A→B→C), the subject scope's date_from is pushed even further past
the cohort range, so the runtime's parallel carrier map dropped
even more anchors.

See `docs/current/cohort-outside-in-post-73n-regression-tracker.md`
§Cluster A.
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
    for raw in conf.read_text().splitlines():
        line = raw.strip()
        if line.startswith("DATA_REPO_DIR"):
            return str(_REPO_ROOT / line.split("=", 1)[1].strip())
    return None


client = get_default_client()
graph = "synth-lat4"
dsl = "from(synth-lat4-b).to(synth-lat4-d).cohort(12-Mar-26:14-Mar-26).asat(1-May-26)"

args = [
    "--graph", _resolve_data_repo_path(),
    "--name", graph,
    "--query", dsl,
    "--type", "cohort_maturity",
    "--format", "json",
    "--no-cache", "--no-snapshot-cache",
    "--diag",
]
result = client.call_json("analyse", args)
rows = (result.get("result") or {}).get("data") or []
print("row count:", len(rows))
block = rows[0].get("_selected_a_clock_evidence")

print("\n=== diagnostics ===")
print(json.dumps(block.get("diagnostics") or {}, indent=2))

for which in ("carrier_surface", "subject_surface"):
    surf = block.get(which)
    if not surf:
        continue
    prov = dict(surf.get("provenance") or {})
    lineage = prov.pop("row_lineage", None)
    print(f"\n=== {which} ===")
    print(f"  role={surf.get('role')} root={surf.get('root_node')} end={surf.get('end_node')} edges={surf.get('edge_ids')}")
    bindings = prov.get("primitive_bindings") or []
    for b in bindings:
        sc = b.get("scope") or {}
        we = b.get("weighted_evidence") or {}
        print(f"  binding edge={b.get('transition',{}).get('edge_id')} role={sc.get('evidence_role')} dates={sc.get('date_from')}..{sc.get('date_to')} as_at={sc.get('as_at')} sel_anchors={sc.get('selected_anchor_days')} rows={we.get('row_count')} skipped={we.get('skipped_counts_by_reason')}")
    print(f"  raw={prov.get('raw_row_count')} placed={prov.get('placed_count')} off_clock={prov.get('off_clock_count')} emitted={prov.get('emitted_count')} incomplete={prov.get('incomplete_count')}")
    if lineage:
        print(f"  lineage entries={len(lineage)}")
        for i, e in enumerate(lineage[:30]):
            print(f"    [{i}] edge={e.get('edge_id')} obs={e.get('observed_date')} ret={e.get('retrieved_at')} k_w={e.get('k_weighted')} placements={e.get('placements')[:3]} clock={e.get('clock_decision')}")

cells = block.get("cells") or []
print(f"\n=== {len(cells)} emitted SelectedAClockEvidence cells ===")
for cell in cells:
    print(f"  ad={cell.get('anchor_day')} τ={cell.get('tau')} x={cell.get('x_at_query_x')} y={cell.get('y_at_subject_end')}")

print("\n=== row evidence τ=15..50 ===")
for r in rows:
    t = r.get("tau_days")
    if t is None or not (15 <= t <= 50):
        continue
    print(f"  τ={t} ev_x={r.get('evidence_x')} ev_y={r.get('evidence_y')} rate={r.get('rate')}")
