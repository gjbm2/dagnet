# Multi-hop rate composition — single-hop probe Y-deficit investigation

**Status**: Active investigation. X regression resolved; Y regression characterised but root cause not yet identified.

**Date**: 11-May-26

**Related**:
- `docs/current/multi-hop-window-evidence-rate-composition-implementation-plan.md` — the implementation plan whose later stages introduced the regressions described below
- `docs/current/cohort-outside-in-post-73n-regression-tracker.md` — failing outside-in tests are downstream of this issue

---

## TL;DR

After the multi-hop rate-composition rewrite of `cohort_forecast_v3.py`, the single-hop `cohort(b→c)` probe on `synth-lat4` shows:

- **X** — was +3% inflated by the rewrite, now **bit-identical** to photocopy after fix
- **Y** — still ~50% deficit at the rising edge (τ=10), recovers to **~99%** by plateau (τ→∞)

The Y signature is a **timing-shift signature**, not a rate-magnitude signature: the *total* mass eventually delivered is correct to within 1.4%, but each cohort's contribution **arrives later in τ** than it should. A simple rate-magnitude bug (wrong p) would stay scaled forever and never converge.

The interpolation hypothesis was tested and rejected (no effect). The next round of diagnosis should focus on **temporal placement** of cohort mass — most likely candidates are subject-seed time-distribution, convolution τ-axis convention, or Riemann-sum side convention in the Y prefix accumulation.

---

## State of the code (current tree relative to photocopy)

Photocopy is `stash@{0}` = `photocopy-feature-snapshot-db-phase0-2026-05-11` (and `/tmp/cf_v3_photocopy.py`). Only `cohort_forecast_v3.py` differs.

Active edits since photocopy:

| # | File / location | Change | Status |
|---|---|---|---|
| 1 | `cohort_forecast_v3.py` ~L3646 (age-only terminal compact) | Added `if float(value) > 0.0` zero-filter | Kept |
| 2 | `cohort_forecast_v3.py` ~L3735 (source-day-specific terminal compact_cum) | Same zero-filter | Kept |
| 3 | `cohort_forecast_v3.py` ~L4296 (cell-emit τ union) | Removed `y_prefix.taus_for_anchor` from observation marker set, unconditional | **X fix** — kept |
| — | `cohort_forecast_v3.py` ~L3176 (`_build_source_day_rate_cache`) | Tried `_interpolated_rate_at`; no effect on Y; **reverted** to forward-fill | Reverted |

So edits 1–3 are live. No Y-targeted change is currently in the tree.

The pre-fix snapshot of the whole file (state we were in before X-fix and before interpolation attempt) is preserved at:
- `/tmp/cf_v3_current_buggy.py` — pre-X-fix, pre-interp
- `/tmp/cf_v3_photocopy.py` — photocopy (`stash@{0}`)

---

## Where the probe data lives

All probes hit the daemon via `tests._daemon_client`, request `cohort_maturity` with `--no-cache --no-snapshot-cache --diag`, and dump the full JSON response.

**Single-hop cohort `(b→c)` on `synth-lat4`** — current diagnostic surface:

| File | Code state at capture | Notes |
|---|---|---|
| `/tmp/probe_singlehop_cohort_a_bc_photocopy.json` | Photocopy active loop | Reference / ground truth for this fixture |
| `/tmp/probe_singlehop_cohort_a_bc_current.json` | Post-rewrite, no fixes | X +3%, Y deficit |
| `/tmp/probe_singlehop_cohort_a_bc_unconditional.json` | X fix applied (cell-emit τ union change) | X bit-identical, Y unchanged |
| `/tmp/probe_singlehop_cohort_a_bc_fix2.json` | X fix attempt v1 (with branch — discarded) | Superseded by unconditional |
| `/tmp/probe_singlehop_cohort_a_bc_interp.json` | X fix + interpolation in `_build_source_day_rate_cache` | Y unchanged → interpolation rejected |
| `/tmp/probe_singlehop_cohort_a_bc_fixed.json` | Earlier intermediate state | Historical |
| `/tmp/probe_singlehop_bc_photocopy.json` | Photocopy (no `cohort_a` prefix — same content) | Duplicate of photocopy reference |

Each JSON is the verbatim response from `daemon_client.call_json("analyse", args)`. Note: the file's **first line is an nvm preamble** (`Now using node v22.22.0…`), the JSON starts on line 2. Strip the first line before `json.loads`.

The query is fixed:

```
graph: synth-lat4
dsl:   from(synth-lat4-b).to(synth-lat4-c).cohort(12-Mar-26:14-Mar-26).asat(1-May-26)
type:  cohort_maturity
flags: --no-cache --no-snapshot-cache --diag
```

The row series is at `data["result"]["data"]`, one row per `tau_days` (0..102, 103 rows). Each row contains `tau_days`, `evidence_x`, `evidence_y`, `evidence_x_coverage`, `evidence_y_coverage`, etc. The `_selected_a_clock_evidence` block is at the top of the first row only and contains carrier/subject surface provenance plus emitted cells with `(anchor_day, tau, x_at_query_x, y_at_subject_end)`.

---

## What the probe data shows

### Headline table (evidence_x / evidence_y by τ across all four code states)

| τ | photo X | curr X | Xfix X | interp X | photo Y | curr Y | Xfix Y | interp Y |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 2 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| 3 | 7.74 | 7.89 | 7.74 | 7.74 | 0.00 | 0.00 | 0.00 | 0.00 |
| 5 | 2325.12 | 2487.07 | 2325.12 | 2325.12 | ≈0 | 0.00 | 0.00 | 0.00 |
| 8 | 21571.24 | 21721.89 | 21571.24 | 21571.24 | 0.90 | 0.51 | 0.51 | 0.51 |
| 10 | 35781.55 | 36267.38 | 35781.55 | 35781.55 | **65.46** | **32.33** | **32.33** | **32.33** |
| 15 | 55913.51 | 56408.64 | 55913.51 | 55913.51 | 3365.25 | 2690.55 | 2690.55 | 2690.55 |
| 20 | 61205.41 | 62433.02 | 61205.41 | 61205.41 | 12170.40 | 11149.83 | 11149.83 | 11149.83 |
| 30 | 62801.81 | 64628.24 | 62801.81 | 62801.81 | 22417.17 | 21926.87 | 21926.87 | 21926.87 |
| 50 | 62917.52 | 64870.79 | 62917.52 | 62917.52 | 23998.51 | 23663.69 | 23663.69 | 23663.69 |
| 80 | 62918.16 | 64876.45 | 62918.16 | 62918.16 | 24005.48 | 23671.57 | 23671.57 | 23671.57 |
| 100 | 62918.16 | 64876.51 | 62918.16 | 62918.16 | 24005.48 | 23671.57 | 23671.57 | 23671.57 |

### What the X column tells us

- Current (no fix) was +3% inflated across all τ
- "Xfix" (unconditional cell-emit τ change) is **bit-identical** to photocopy at all τ
- The X regression was 100% explained by **`y_prefix.taus_for_anchor` polluting the cell-emit observation marker set**. Removing that union restores X exactly.
- Interpolation change did not affect X (expected — the fix is upstream of X).

### What the Y column tells us

Y deficit ratio (current / photocopy):

| τ | curr/photo |
|---|---:|
| 8 | 0.57 |
| 10 | 0.494 |
| 15 | 0.799 |
| 20 | 0.916 |
| 30 | 0.978 |
| 50 | 0.986 |
| 80 | 0.986 |
| 100 | 0.986 |

**Shape**: large deficit at the rising edge, converges to ~98.6% by plateau. Asymptotic delta is small (~333 / 24005 = 1.4%) — most of the missing mass eventually shows up.

**Both the X-fix and the interpolation attempt left Y unchanged.** All three post-rewrite states (current, Xfix, interp) produce **identical Y** to four decimal places. So none of the levers we've touched so far influences Y.

### What this rules out

- Rate-magnitude bug (would not converge to 99% at plateau)
- Forward-fill vs interpolation in `_build_source_day_rate_cache` (interpolation attempt produced no change)
- Cell-emit τ marker set (didn't move Y when changed)
- Zero-filter compaction (the changes there are kept and don't affect Y meaningfully)

### What this points at

A **temporal shift** mechanism: cohort mass is arriving in Y later than it should, by something like 1–3 days on average, with a long tail that catches up. The plateau deficit (1.4%) is consistent with a few X-arrival cohorts at the very end of the eligibility window getting cropped by `as_at` after the shift pushes them past the boundary.

Candidate mechanisms, in rough order of how fundamental:

1. **Subject seed time-distribution**: `_SelectedSourceDayMass.by_node[X]` may be placing X-arrival mass at later anchors than the photocopy's `B_{R→X}` produced. X amplitude (total) is correct, but the *time histogram* of X-arrival cohorts may be shifted.
2. **Convolution τ-axis convention**: dense composer for `K_i ⋆ K_j` may treat the kernel's age=0 at a different offset than the photocopy loop did, shifting every contribution by one step.
3. **Riemann-sum side in `_RateAttributedSubjectPrefix`**: left-edge vs right-edge accumulation per τ-step. Off-by-one in this loop gives exactly the "rising edge delayed by ~1 step, plateau preserved" signature.
4. **Anchor placement of subject buckets**: old code used `local_age = τ − source_offset`; new code may evaluate at `anchor_day` directly without applying the offset to mass placement, even though the rate cache *does* apply it.

---

## How to do this research (procedure)

### Re-running the probe

The probe script is **not** checked in — it's a small inline daemon call that was run from the shell. The minimal recipe:

```python
# /tmp/probe_singlehop.py (recreate as needed)
import json, sys
from pathlib import Path
sys.path.insert(0, "/home/reg/dev/dagnet/graph-editor/lib")
sys.path.insert(0, "/home/reg/dev/dagnet/graph-editor/lib/tests")
from tests._daemon_client import get_default_client

def _resolve_data_repo_path():
    conf = Path("/home/reg/dev/dagnet/.private-repos.conf")
    for raw in conf.read_text().splitlines():
        line = raw.strip()
        if line.startswith("DATA_REPO_DIR"):
            return str(Path("/home/reg/dev/dagnet") / line.split("=", 1)[1].strip())
    raise RuntimeError("DATA_REPO_DIR not found")

client = get_default_client()
args = [
    "--graph", _resolve_data_repo_path(),
    "--name", "synth-lat4",
    "--query", "from(synth-lat4-b).to(synth-lat4-c).cohort(12-Mar-26:14-Mar-26).asat(1-May-26)",
    "--type", "cohort_maturity",
    "--format", "json",
    "--no-cache", "--no-snapshot-cache",
    "--diag",
]
result = client.call_json("analyse", args)
print(json.dumps(result, indent=2))
```

Activate the venv first and redirect output to `/tmp/probe_singlehop_<label>.json`:

```bash
. graph-editor/venv/bin/activate
python3 /tmp/probe_singlehop.py > /tmp/probe_singlehop_cohort_a_bc_<label>.json
```

The daemon must be running. If it isn't, the client will fail loudly — start it via the existing daemon script.

### Comparing probes

```python
# Quick comparison snippet
import json
def load(path):
    with open(path) as f:
        first = f.readline()
        return json.loads((first if first.startswith('{') else '') + f.read())

probes = {
    'photo': '/tmp/probe_singlehop_cohort_a_bc_photocopy.json',
    'mine':  '/tmp/probe_singlehop_cohort_a_bc_<my-label>.json',
}
data = {k: load(p) for k, p in probes.items()}
for tau in [3, 5, 8, 10, 15, 20, 30, 50, 100]:
    for k, d in data.items():
        rows = d['result']['data']
        r = next((r for r in rows if r['tau_days'] == tau), {})
        print(f'τ={tau:>3} {k:>6} X={r.get("evidence_x")!s:>10} Y={r.get("evidence_y")!s:>10}')
    print('---')
```

### Switching between code states

The photocopy is on the stash list. To restore the photocopy version of `cohort_forecast_v3.py` only (without disturbing the rest of the working tree):

```bash
# Inspect the stash diff first to confirm it's the right one
git stash show stash@{0} --name-only
# Restore only the one file from the stash
git checkout stash@{0} -- graph-editor/lib/runner/cohort_forecast_v3.py
```

To go back to the post-fix state (current tree), the file is preserved in this repo's working tree — no special action needed. To restore the *pre-X-fix* state for re-running diagnostics:

```bash
cp /tmp/cf_v3_current_buggy.py graph-editor/lib/runner/cohort_forecast_v3.py
```

**Every code state switch needs the daemon to be restarted (or reload-triggered) before re-running the probe.** Always verify with `scripts/dev-server-check.sh <path>` that the daemon is FRESH on the file before drawing conclusions about a probe result.

### Useful diagnostic dimensions inside the probe JSON

The `data["result"]["data"][0]["_selected_a_clock_evidence"]` block contains:

- `diagnostics` — top-level counters
- `carrier_surface.provenance` — primitive bindings, row lineage, raw/placed/emitted counts
- `subject_surface.provenance` — same shape, for the subject side
- `cells[]` — `(anchor_day, tau, x_at_query_x, y_at_subject_end)` per emitted cell

To probe the time-distribution hypothesis (candidate 1 above), extract the **X-arrival mass histogram** from cells: bucket cells by `anchor_day` and sum `x_at_query_x`. Compare photocopy vs current. If the distribution by anchor differs, that's mechanism 1. If it matches, suspicion moves to mechanism 2–4 (downstream of seed placement).

---

## Next steps (not yet executed)

1. **Diagnose, don't fix.** Do not edit `cohort_forecast_v3.py` until the root cause is named.
2. **Quantify X-arrival mass placement**: extract per-anchor `x_at_query_x` from both probes, compare distributions.
3. **If anchors match**: trace one specific X-arrival cohort through the Y prefix accumulation by hand and locate the first τ where its contribution should appear vs where the current code actually deposits it.
4. **Apply a single, minimal, branchless fix** once the mechanism is named. Verify against the probe with Y reaching ≥99.9% of photocopy at all τ.
5. Only after Y matches: run the failing outside-in tests to confirm the cluster recovers.
