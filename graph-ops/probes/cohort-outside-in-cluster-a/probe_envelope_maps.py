"""Inspect the envelope-time carrier and subject arrival maps.

Used during the Cluster A two-clock root-day defect investigation
to confirm that `RequestEnvelopePlan.carrier_arrival_map` was already
rooted on the cohort A-anchor range — the runtime's parallel
construction was the divergence, not the envelope.

See `docs/current/cohort-outside-in-post-73n-regression-tracker.md`
§Cluster A "Two-clock root-day defect".
"""
import json
import os
import sys
from pathlib import Path
from datetime import date

sys.path.insert(0, "/home/reg/dev/dagnet")
sys.path.insert(0, "/home/reg/dev/dagnet/graph-editor")
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

from runner.request_envelope import build_request_envelope_plan  # noqa: E402

graph_path = Path(data_repo_dir) / "graphs" / "synth-simple-abc.json"
graph = json.loads(graph_path.read_text())

plan = build_request_envelope_plan(
    graph=graph,
    query_from_node="simple-b",
    query_to_node="simple-c",
    anchor_node_id="simple-a",
    anchor_from=date.fromisoformat("2026-03-01"),
    anchor_to=date.fromisoformat("2026-03-03"),
    is_window=False,
    graph_preference="best_available",
    as_at="2026-03-20T00:00:00Z",
    scenario_id="Scenario 1",
)

print("=== envelope plan ===")
print(f"is_window: {plan.is_window}")
print(f"public_anchor_from: {plan.public_anchor_from}")
print(f"public_anchor_to: {plan.public_anchor_to}")
print(f"subject_envelopes: {len(plan.subject_envelopes)}")
print(f"carrier_envelopes: {len(plan.carrier_envelopes)}")
print(f"diagnostics: {plan.diagnostics}")

print("\n=== carrier_arrival_map ===")
cam = plan.carrier_arrival_map
if cam is None:
    print("None")
else:
    print(f"identity: {cam.identity}")
    print(f"max_tau: {cam.max_tau}")
    print(f"root_day_weights ({len(cam.root_day_weights)}):")
    for k, v in sorted(cam.root_day_weights.items())[:20]:
        print(f"  {k}: {v}")
    print(f"nodes ({len(cam.nodes)}): {sorted(cam.nodes.keys())}")
    if "simple-a" in cam.nodes:
        n_a = cam.nodes["simple-a"]
        print(f"\n  simple-a (root) weights ({len(n_a.weights)}):")
        for k, v in sorted(n_a.weights.items())[:10]:
            print(f"    {k}: {v}")
        print(f"  simple-a root_day_contributions ({len(n_a.root_day_contributions)}):")
        for k, contribs in sorted(n_a.root_day_contributions.items())[:10]:
            print(f"    {k}: {dict(list(contribs.items())[:5])}")
    if "simple-b" in cam.nodes:
        n_b = cam.nodes["simple-b"]
        print(f"\n  simple-b weights ({len(n_b.weights)} entries, top 10):")
        for k, v in sorted(n_b.weights.items())[:10]:
            print(f"    {k}: {v:.6e}")
        print(f"  simple-b root_day_contributions ({len(n_b.root_day_contributions)}):")
        for k, contribs in sorted(n_b.root_day_contributions.items())[:5]:
            print(f"    {k}: {dict((kk, round(vv, 6)) for kk, vv in list(contribs.items())[:5])}")

print("\n=== subject_arrival_map ===")
sam = plan.subject_arrival_map
if sam is None:
    print("None")
else:
    print(f"identity: {sam.identity}")
    print(f"max_tau: {sam.max_tau}")
    print(f"root_day_weights ({len(sam.root_day_weights)}):")
    for k, v in sorted(sam.root_day_weights.items())[:20]:
        print(f"  {k}: {v}")
    print(f"nodes ({len(sam.nodes)}): {sorted(sam.nodes.keys())}")
