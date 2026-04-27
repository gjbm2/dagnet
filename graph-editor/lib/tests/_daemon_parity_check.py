#!/usr/bin/env python3
"""Parity harness: subprocess vs daemon, byte-equal check on captured JSON.

Picks a representative slice of the (graph, dsl, type) tuples used by
test_cohort_factorised_outside_in.py and runs each through both code paths,
comparing the parsed JSON. Run manually:

    cd /home/reg/dev/dagnet
    . graph-editor/venv/bin/activate
    python graph-editor/lib/tests/_daemon_parity_check.py

Exits non-zero if any tuple disagrees.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _daemon_client import DaemonClient  # noqa: E402

_DAGNET_ROOT = Path(__file__).resolve().parents[3]
_ANALYSE_SH = _DAGNET_ROOT / "graph-ops" / "scripts" / "analyse.sh"
_PARAM_PACK_SH = _DAGNET_ROOT / "graph-ops" / "scripts" / "param-pack.sh"


def _resolve_data_repo() -> Path:
    conf = (_DAGNET_ROOT / ".private-repos.conf").read_text()
    for line in conf.splitlines():
        if line.startswith("DATA_REPO_DIR="):
            return _DAGNET_ROOT / line.split("=", 1)[1].strip()
    raise RuntimeError("DATA_REPO_DIR missing")


_DATA_REPO = str(_resolve_data_repo())


# Representative slice — a few tuples spanning small / fanout / lat4 graphs and
# both window and cohort temporal modes. param-pack included to exercise the
# other command. Add more here if you suspect a specific contamination case.
ANALYSE_TUPLES = [
    ("synth-simple-abc", "from(synth-simple-abc-a).to(synth-simple-abc-b).cohort(-90d:)", "cohort_maturity"),
    ("synth-simple-abc", "from(synth-simple-abc-a).to(synth-simple-abc-b).window(-90d:)", "cohort_maturity"),
    ("synth-fanout-test", "from(synth-fanout-test-a).to(synth-fanout-test-fast).cohort(-90d:)", "cohort_maturity"),
    ("synth-lat4", "from(synth-lat4-c).to(synth-lat4-d).cohort(synth-lat4-c,-90d:)", "cohort_maturity"),
    ("synth-simple-abc", "from(synth-simple-abc-a).to(synth-simple-abc-b).cohort(-90d:)", "conditioned_forecast"),
]
PARAM_PACK_TUPLES = [
    ("synth-simple-abc", "window(-90d:)"),
    ("synth-lat4", "from(synth-lat4-b).to(synth-lat4-d).window(-1d:)"),
]


def run_subprocess_analyse(graph: str, dsl: str, atype: str) -> dict:
    cmd = [
        "bash", str(_ANALYSE_SH), graph, dsl,
        "--type", atype,
        "--no-cache", "--no-snapshot-cache",
        "--format", "json",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(_DAGNET_ROOT), timeout=300)
    if result.returncode != 0:
        raise RuntimeError(f"subprocess failed: {result.stderr[-1000:]}")
    idx = result.stdout.find("{")
    return json.loads(result.stdout[idx:])


def run_subprocess_param_pack(graph: str, dsl: str) -> dict:
    cmd = [
        "bash", str(_PARAM_PACK_SH), graph, dsl,
        "--no-cache", "--format", "json",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(_DAGNET_ROOT), timeout=300)
    if result.returncode != 0:
        raise RuntimeError(f"subprocess failed: {result.stderr[-1000:]}")
    idx = result.stdout.find("{")
    return json.loads(result.stdout[idx:])


def daemon_analyse(client: DaemonClient, graph: str, dsl: str, atype: str) -> dict:
    args = [
        "--graph", _DATA_REPO,
        "--name", graph,
        "--query", dsl,
        "--type", atype,
        "--no-cache", "--no-snapshot-cache",
        "--format", "json",
    ]
    return client.call_json("analyse", args)


def daemon_param_pack(client: DaemonClient, graph: str, dsl: str) -> dict:
    args = [
        "--graph", _DATA_REPO,
        "--name", graph,
        "--query", dsl,
        "--no-cache", "--format", "json",
    ]
    return client.call_json("param-pack", args)


def compare(a: dict, b: dict, label: str) -> bool:
    """Compare two JSON payloads. Returns True if equal, False otherwise."""
    a_str = json.dumps(a, sort_keys=True)
    b_str = json.dumps(b, sort_keys=True)
    if a_str == b_str:
        return True
    print(f"  ✗ MISMATCH for {label}", file=sys.stderr)
    # Diff at top level for readability
    a_keys, b_keys = set(a.keys()) if isinstance(a, dict) else set(), set(b.keys()) if isinstance(b, dict) else set()
    if a_keys != b_keys:
        print(f"    top-level keys differ: subprocess={sorted(a_keys)} daemon={sorted(b_keys)}", file=sys.stderr)
    else:
        for k in sorted(a_keys):
            av, bv = a.get(k), b.get(k)
            if json.dumps(av, sort_keys=True) != json.dumps(bv, sort_keys=True):
                print(f"    key {k!r} differs", file=sys.stderr)
                if isinstance(av, str) and isinstance(bv, str):
                    print(f"      subprocess: {av[:200]}", file=sys.stderr)
                    print(f"      daemon    : {bv[:200]}", file=sys.stderr)
    return False


def main() -> int:
    print("=== Subprocess (gold) ===")
    sub_t0 = time.monotonic()
    sub_results: dict[tuple, dict] = {}
    for graph, dsl, atype in ANALYSE_TUPLES:
        t = time.monotonic()
        sub_results[("analyse", graph, dsl, atype)] = run_subprocess_analyse(graph, dsl, atype)
        print(f"  analyse {graph} {atype}  {(time.monotonic()-t)*1000:.0f}ms")
    for graph, dsl in PARAM_PACK_TUPLES:
        t = time.monotonic()
        sub_results[("param-pack", graph, dsl)] = run_subprocess_param_pack(graph, dsl)
        print(f"  param-pack {graph}  {(time.monotonic()-t)*1000:.0f}ms")
    sub_total = time.monotonic() - sub_t0
    print(f"  subprocess total: {sub_total*1000:.0f}ms")

    print()
    print("=== Daemon ===")
    daemon_t0 = time.monotonic()
    client = DaemonClient.start()
    daemon_ready = time.monotonic() - daemon_t0
    print(f"  daemon ready: {daemon_ready*1000:.0f}ms")

    daemon_results: dict[tuple, dict] = {}
    try:
        for graph, dsl, atype in ANALYSE_TUPLES:
            t = time.monotonic()
            daemon_results[("analyse", graph, dsl, atype)] = daemon_analyse(client, graph, dsl, atype)
            print(f"  analyse {graph} {atype}  {(time.monotonic()-t)*1000:.0f}ms")
        for graph, dsl in PARAM_PACK_TUPLES:
            t = time.monotonic()
            daemon_results[("param-pack", graph, dsl)] = daemon_param_pack(client, graph, dsl)
            print(f"  param-pack {graph}  {(time.monotonic()-t)*1000:.0f}ms")
    finally:
        client.quit()
    daemon_total = time.monotonic() - daemon_t0
    print(f"  daemon total (incl. ready): {daemon_total*1000:.0f}ms")

    print()
    print("=== Parity ===")
    failures = 0
    for key in sub_results:
        label = " ".join(str(p) for p in key)
        if not compare(sub_results[key], daemon_results[key], label):
            failures += 1
        else:
            print(f"  ✓ {label}")

    print()
    print(f"=== Summary ===")
    print(f"  subprocess wall: {sub_total*1000:.0f}ms")
    print(f"  daemon wall:     {daemon_total*1000:.0f}ms")
    print(f"  speedup:         {sub_total/daemon_total:.2f}×")
    print(f"  failures:        {failures}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
