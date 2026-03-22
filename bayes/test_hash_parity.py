#!/usr/bin/env python3
"""Test that synth_gen's computed core hashes match the FE algorithm
and are present in the snapshot DB."""

import sys, json, yaml, os, hashlib, base64

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor", "lib"))
sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor"))
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))

# Load DB connection
env_path = os.path.join(REPO_ROOT, "graph-editor", ".env.local")
db_conn = ""
if os.path.exists(env_path):
    for line in open(env_path):
        if line.strip().startswith("DB_CONNECTION="):
            db_conn = line.strip().split("=", 1)[1].strip().strip('"')
            break
os.environ["DB_CONNECTION"] = db_conn

from synth_gen import compute_core_hashes, _resolve_data_repo
from compiler.topology import analyse_topology
from lib.snapshot_service import get_db_connection

data_repo = _resolve_data_repo()
graph_path = os.path.join(data_repo, "graphs", "synth-diamond-test.json")

with open(graph_path) as f:
    graph = json.load(f)

topology = analyse_topology(graph)
computed = compute_core_hashes(graph, topology, data_repo)

print("Computed hashes per edge:")
for pid, hashes in computed.items():
    if pid.startswith("parameter-"):
        continue
    print(f"  {pid:30s}  window={hashes['window_hash']}  cohort={hashes['cohort_hash']}")

# Check DB
print("\nDB check:")
conn = get_db_connection()
cur = conn.cursor()

for pid, hashes in computed.items():
    if pid.startswith("parameter-"):
        continue
    for hash_type in ["window_hash", "cohort_hash"]:
        h = hashes[hash_type]
        cur.execute(
            "SELECT COUNT(*) FROM snapshots WHERE param_id = %s AND core_hash = %s",
            (pid, h),
        )
        count = cur.fetchone()[0]
        status = "OK" if count > 0 else "MISSING"
        print(f"  {pid:30s}  {hash_type}={h}  rows={count}  {status}")

# Also check what hashes ARE in the DB for these param_ids
print("\nAll DB hashes per param_id:")
for pid in computed:
    if pid.startswith("parameter-"):
        continue
    cur.execute(
        "SELECT DISTINCT core_hash, COUNT(*) FROM snapshots WHERE param_id = %s GROUP BY core_hash",
        (pid,),
    )
    rows = cur.fetchall()
    for core_hash, cnt in rows:
        match = ""
        if core_hash == computed[pid].get("window_hash"):
            match = " ← window"
        elif core_hash == computed[pid].get("cohort_hash"):
            match = " ← cohort"
        print(f"  {pid:30s}  {core_hash}  ({cnt} rows){match}")

conn.close()
