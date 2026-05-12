"""One-shot drift snapshot for cohort/window multi-hop subject queries.

Run pre- and post- the `_build_rate_attributed_subject_prefix` rewrite to
quantify numerical drift introduced by switching downstream subject
M_select from timing-span composed to rate-attributed propagated.

Captures `evidence_x`, `evidence_y`, `rate`, `model_midpoint`,
`p_infinity_mean`, `completeness` per tau_days for each query.

Output: /tmp/cohort-multihop-drift-snapshot.<label>.json

Not a permanent test. Discard once design integrity is confirmed.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1] / "home" / "reg" / "dev" / "dagnet"
if not REPO_ROOT.exists():
    REPO_ROOT = Path("/home/reg/dev/dagnet")
ANALYSE_SH = REPO_ROOT / "graph-ops" / "scripts" / "analyse.sh"

# Three regimes the design touches.
QUERIES: list[dict[str, Any]] = [
    # cohort(A!=X) multi-hop subject — currently passing, design says may move
    {
        "label": "cohort_AneqX_lat4_bd",
        "graph": "synth-lat4",
        "dsl": "from(synth-lat4-b).to(synth-lat4-d).cohort(29-Jan-26:29-Apr-26)",
        "regime": "cohort_AneqX_multihop",
    },
    {
        "label": "cohort_AneqX_lat4flat_bd",
        "graph": "synth-lat4-flat",
        "dsl": "from(synth-lat4-flat-b).to(synth-lat4-flat-d).cohort(12-Mar-26:14-Mar-26).asat(10-May-26)",
        "regime": "cohort_AneqX_multihop",
    },
    {
        "label": "cohort_AneqX_nolag_bd",
        "graph": "cf-fix-linear-no-lag",
        "dsl": "from(cf-fix-no-lag-b).to(cf-fix-no-lag-d).cohort(29-Jan-26:29-Apr-26)",
        "regime": "cohort_AneqX_multihop",
    },
    {
        "label": "cohort_AneqX_deep_eg",
        "graph": "cf-fix-deep-mixed",
        "dsl": "from(cf-fix-deep-e).to(cf-fix-deep-g).cohort(31-Oct-25:29-Apr-26)",
        "regime": "cohort_AneqX_multihop",
    },
    {
        "label": "cohort_AneqX_deep_df",
        "graph": "cf-fix-deep-mixed",
        "dsl": "from(cf-fix-deep-d).to(cf-fix-deep-f).cohort(31-Oct-25:29-Apr-26)",
        "regime": "cohort_AneqX_multihop",
    },
    # cohort(A=X) multi-hop — design says converges to window
    {
        "label": "cohort_AeqX_wrp_ac",
        "graph": "synth-window-rate-prop",
        "dsl": "from(wrp-a).to(wrp-c).cohort(wrp-a,1-Mar-26:14-Mar-26).asat(10-Apr-26)",
        "regime": "cohort_AeqX_multihop",
    },
    # window() multi-hop — design says goes from broken to oracle-matching
    {
        "label": "window_wrp_ac",
        "graph": "synth-window-rate-prop",
        "dsl": "from(wrp-a).to(wrp-c).window(1-Mar-26:14-Mar-26).asat(10-Apr-26)",
        "regime": "window_multihop",
    },
    {
        "label": "window_lat4_bd",
        "graph": "synth-lat4",
        "dsl": "from(synth-lat4-b).to(synth-lat4-d).window(29-Jan-26:29-Apr-26)",
        "regime": "window_multihop",
    },
    {
        "label": "window_nolag_bd",
        "graph": "cf-fix-linear-no-lag",
        "dsl": "from(cf-fix-no-lag-b).to(cf-fix-no-lag-d).window(29-Jan-26:29-Apr-26)",
        "regime": "window_multihop",
    },
    {
        "label": "window_deep_eg",
        "graph": "cf-fix-deep-mixed",
        "dsl": "from(cf-fix-deep-e).to(cf-fix-deep-g).window(31-Oct-25:29-Apr-26)",
        "regime": "window_multihop",
    },
    {
        "label": "window_lat4flat_bd",
        "graph": "synth-lat4-flat",
        "dsl": "from(synth-lat4-flat-b).to(synth-lat4-flat-d).window(12-Mar-26:14-Mar-26).asat(10-May-26)",
        "regime": "window_multihop",
    },
]

CAPTURED_FIELDS = (
    "tau_days",
    "evidence_x",
    "evidence_y",
    "rate",
    "rate_pure",
    "rate_blended",
    "midpoint",
    "model_midpoint",
    "model_curve_midpoint",
    "projected_rate",
    "forecast_x",
    "forecast_y",
    "evidence_x_coverage",
    "evidence_y_coverage",
    "coverage",
    "applicable_coverage",
    "completeness",
    "completeness_sd",
    "p_infinity_mean",
    "p_infinity_sd",
    "tau_solid_max",
    "tau_future_max",
    "cohorts_covered_base",
    "cohorts_covered_projected",
)


def _run_analyse(graph: str, dsl: str) -> dict[str, Any]:
    cmd = [
        "bash", str(ANALYSE_SH), graph, dsl,
        "--type", "cohort_maturity",
        "--no-cache", "--no-snapshot-cache",
        "--format", "json",
    ]
    started = time.time()
    result = subprocess.run(
        cmd, capture_output=True, text=True,
        cwd=str(REPO_ROOT), timeout=600,
    )
    elapsed = time.time() - started
    if result.returncode != 0:
        return {
            "_error": f"analyse.sh exit {result.returncode}",
            "_stderr_tail": result.stderr[-1500:],
            "_elapsed_s": elapsed,
        }
    stdout = result.stdout
    first_brace = stdout.find("{")
    if first_brace < 0:
        return {
            "_error": "no JSON found in stdout",
            "_stdout_tail": stdout[-1500:],
            "_elapsed_s": elapsed,
        }
    try:
        payload = json.loads(stdout[first_brace:])
    except json.JSONDecodeError as exc:
        return {
            "_error": f"JSON parse failed: {exc}",
            "_stdout_tail": stdout[-1500:],
            "_elapsed_s": elapsed,
        }
    return {"payload": payload, "_elapsed_s": elapsed}


def _extract_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    # Actual path: payload.result.data is a list of row dicts.
    result = payload.get("result") if isinstance(payload, dict) else None
    if isinstance(result, dict):
        data = result.get("data")
        if isinstance(data, list):
            return [r for r in data if isinstance(r, dict)]
        if isinstance(data, dict) and isinstance(data.get("rows"), list):
            return [r for r in data["rows"] if isinstance(r, dict)]
    return []


def _slim_row(row: dict[str, Any]) -> dict[str, Any]:
    return {k: row.get(k) for k in CAPTURED_FIELDS if k in row}


def main(label: str) -> int:
    out_path = Path(f"/tmp/cohort-multihop-drift-snapshot.{label}.json")
    print(f"[snapshot:{label}] writing to {out_path}")
    captured = {
        "label": label,
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "git_sha": subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=str(REPO_ROOT)
        ).stdout.strip(),
        "queries": [],
    }
    for i, q in enumerate(QUERIES, 1):
        print(f"[{i}/{len(QUERIES)}] {q['label']}: {q['dsl']}", flush=True)
        run = _run_analyse(q["graph"], q["dsl"])
        entry = dict(q)
        entry["elapsed_s"] = round(run.get("_elapsed_s", 0.0), 2)
        if "_error" in run:
            entry["error"] = run["_error"]
            entry["stderr_tail"] = run.get("_stderr_tail", "")
            entry["stdout_tail"] = run.get("_stdout_tail", "")
            print(f"  ERROR: {run['_error']}")
        else:
            rows = _extract_rows(run["payload"])
            entry["row_count"] = len(rows)
            entry["rows"] = [_slim_row(r) for r in rows if isinstance(r, dict)]
            print(f"  ok: {len(rows)} rows in {entry['elapsed_s']}s")
        captured["queries"].append(entry)
    out_path.write_text(json.dumps(captured, indent=2, sort_keys=True))
    print(f"[snapshot:{label}] wrote {out_path}")
    ok = sum(1 for q in captured["queries"] if "error" not in q)
    print(f"[snapshot:{label}] {ok}/{len(captured['queries'])} queries succeeded")
    return 0 if ok == len(captured["queries"]) else 1


if __name__ == "__main__":
    label = sys.argv[1] if len(sys.argv) > 1 else "pre-rewrite"
    sys.exit(main(label))
