# 47 — Multi-Hop Cohort/Window Divergence

**Date**: 17-Apr-26
**Status**: Root cause confirmed
**Severity**: High — multi-hop cohort mode produces materially wrong midpoints
**Related**: #46 (V3 cohort midpoint inflation, single-hop)

## Symptom

For a multi-hop query whose upstream segment `a→x` has no latency
edges, cohort mode produces midpoints that are ~38% lower than window
mode at the same taus.

In this repro, the queried subject span `x→y` is
`household-delegated → switch-registered → switch-success` (2 queried
edges, both latency-parameterised). The upstream segment before
`x=household-delegated` is
`Landing-page → household-created → household-delegated` (2
parameterised edges, both non-latent). Because there is no upstream
latency before `x`, cohort and window should use the same observed
subject-evidence basis. They do not.

The defect is present in both V2 and V3. It is not a V3-specific
regression.

## Root cause

The multi-hop cohort handlers select the wrong temporal evidence family
when building the per-edge subject frames that feed
`compose_path_maturity_frames()`.

For a multi-hop `cohort()` query, the implementation should still use
**window evidence for the whole `x→y` subject span** during
subject-frame construction, then apply cohort semantics only at the
composed span / path-level forecast stage (`x_provider`, frontier
logic, IS conditioning, path CDF). Instead, the current code prefers
**cohort** evidence for every subject edge, which injects boundary
evidence that is already diluted by edge-local cohort maturity.

### Mechanism

`_apply_temporal_regime_selection` (`api_handlers.py:1163`) selects
the evidence family based only on the query's `is_window` flag:

    preferred = 'window' if is_window else 'cohort'

This is called inside the per-edge loop (V3: line 1890, V2: line
1345) with the **same `is_window`** flag for every subject edge in
the span.

For a multi-hop cohort query, that means every subject edge is built
from `cohort` rows before composition.

That is the wrong seam. Per doc 29c, Phase A's default subject solve
for multi-hop is edge-wise `window()` composition across the full
`x→y` span; cohort semantics belong to the upstream/path-level side,
not to per-edge subject-frame construction.

The important detail is that the composer does **not** combine all
subject edges symmetrically. `compose_path_maturity_frames()` takes:

- `X` from the `x`-incident / first-edge frames
- `Y` from the `y`-incident / last-edge frames

So the multi-hop cohort chart is effectively inheriting:

- first-edge **cohort** evidence for `X`
- last-edge **cohort** evidence for `Y`

instead of using `window` evidence across the subject span before the
path-level cohort forecast runs.

This matches the runtime evidence exactly:

- multi-hop `evidence_x` equals the first edge's `evidence_x`
- multi-hop `evidence_y` equals the last edge's `evidence_y`

For the repro at `tau=30`:

- first-edge cohort/window `evidence_x` = `8992 / 9492`
- last-edge cohort/window `evidence_y` = `224 / 488`
- multi-hop cohort/window inherits those same values

So the suppressed baseline is not caused by FW recomputing a different
shape kernel. It is caused by selecting the wrong evidence family
before the path-level forecast maths starts.

### Why single-hop is unaffected

For a single-hop query, there is only one subject edge
(`path_role='only'`). There is no multi-edge subject composition step,
so using the query's temporal mode for that lone edge is correct. The
single-hop cohort/window gap (#46) has a different root cause.

### Why window mode is unaffected

Window queries set `is_window=True`, so `preferred='window'` for
every edge. The window evidence family gives raw aggregate counts,
which is correct for both single-hop and multi-hop.

## Path under test

Graph: `bayes-test-gm-rebuild`
Query: `from(household-delegated).to(switch-success).cohort(17-Mar-26:13-Apr-26)`
Query dates: `17-Mar-26:13-Apr-26`

Subject span under test:

- `household-delegated → switch-registered`
- `switch-registered → switch-success`

Both queried edges are latency-parameterised.

Upstream anchor segment before `x=household-delegated`:

- `Landing-page → household-created`
- `household-created → household-delegated`

These upstream edges are the non-latent part of the funnel. The full
anchor-to-target funnel therefore has 4 parameterised edges, with the
first 2 non-latent and the last 2 latent.

## Quantitative evidence

### Multi-hop: cohort vs window (V3)

| tau | Cohort midpoint | Window midpoint | Cohort Y | Window Y | Cohort X | Window X |
|-----|----------------|-----------------|----------|----------|----------|----------|
| 5   | 0.00023 | 0.00137 | 2.0   | 13.0   | 8799   | 9492 |
| 7   | 0.00827 | 0.03434 | 73.0  | 326.0  | 8830   | 9492 |
| 10  | 0.01274 | 0.04372 | 114.0 | 415.0  | 8868   | 9492 |
| 14  | 0.02197 | 0.05273 | 198.0 | 500.5  | 8922   | 9492 |
| 20  | 0.03935 | 0.07501 | 360.0 | 712.0  | 8972   | 9492 |
| 30  | 0.06294 | 0.10219 | 590.9 | 970.0  | 8992   | 9492 |
| 50  | 0.08641 | 0.13685 | 856.9 | 1299.0 | 9020.6 | 9492 |
| 100 | 0.10354 | 0.16150 | 1091.3 | 1533.0 | 9738.7 | 9492 |

Cohort midpoint at tau=100 is **0.104** vs window **0.162** — a 36%
deficit.

### Multi-hop: cohort vs window (V2)

| tau | Cohort midpoint | Window midpoint | Cohort Y | Window Y | Cohort X | Window X |
|-----|----------------|-----------------|----------|----------|----------|----------|
| 5   | 0.00023 | 0.00137 | 2.0   | 13.0  | 8804  | 9492 |
| 10  | 0.01274 | 0.04362 | 115.2 | 414.9 | 8947  | 9492 |
| 20  | 0.03890 | 0.07491 | 398.4 | 696.9 | 9401  | 9492 |
| 30  | 0.06207 | 0.10188 | 752.7 | 942.5 | 10071 | 9492 |
| 39  | 0.07496 | —       | 1005.2 | —    | 10765 | —    |

V2 shows the same pattern: cohort midpoints are 38% lower than window
at tau=30. The defect is version-independent.

### Single-hop control: cohort vs window (V3)

Edge: `switch-registered → switch-success`
Query: same dates `17-Mar-26:13-Apr-26`

| tau | Cohort midpoint | Window midpoint | Cohort Y | Window Y | Cohort X | Window X |
|-----|----------------|-----------------|----------|----------|----------|----------|
| 5   | 0.00485 | 0.01186 | 2.0   | 15.0  | 412.2  | 1265 |
| 7   | 0.12713 | 0.28617 | 72.1  | 362.0 | 567.7  | 1265 |
| 10  | 0.13051 | 0.37708 | 101.9 | 477.0 | 780.3  | 1265 |
| 14  | 0.18043 | 0.42609 | 158.6 | 539.0 | 879.2  | 1265 |
| 20  | 0.29310 | 0.52016 | 290.6 | 658.0 | 991.5  | 1265 |
| 30  | 0.45233 | 0.55178 | 495.3 | 698.0 | 1095.4 | 1265 |

Single-hop also shows cohort lower than window, but the gap narrows
at higher taus (0.452 vs 0.552 at tau=30 — 18% deficit). This is a
different issue — the single-hop cohort evidence IS the correct
family for single-hop. Tracked separately as #46.

## Code trace

### `_apply_temporal_regime_selection` (`api_handlers.py:1163-1217`)

Selects which evidence family (window or cohort) to use for snapshot
regime selection. Line 1205:

    preferred = 'window' if is_window else 'cohort'

Orders candidate regimes so the preferred temporal mode is tried
first by `select_regime_rows`.

### V3 per-edge loop (`api_handlers.py:1866-1900`)

Iterates over all subject edges in the path. Line 1890:

    rows = _apply_temporal_regime_selection(rows, subj, is_window)

Called with the same `is_window` flag for every subject edge. For a
multi-hop cohort query, all subject edges currently get cohort
evidence preference.

### V2 per-edge loop (`api_handlers.py:1320-1350`)

Same pattern. Line 1345:

    rows = _apply_temporal_regime_selection(rows, subj, is_window)

### `compose_path_maturity_frames` (`span_evidence.py`)

Receives the per-edge derivation results and composes them into a
path-level frame by taking arrivals at `x` from `x`-incident /
first-edge frames and arrivals at `y` from `y`-incident / last-edge
frames. By this point the damage is done — the wrong evidence family
has already been baked into the boundary `data_points` that become the
chart baseline.

## How to reproduce

All commands from the dagnet repo root.

### Multi-hop cohort (V3)
```
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(household-delegated).to(switch-success).cohort(17-Mar-26:13-Apr-26)" \
  --type cohort_maturity --topo-pass --no-cache --no-snapshot-cache
```

### Multi-hop window (V3)
```
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(household-delegated).to(switch-success).window(17-Mar-26:13-Apr-26)" \
  --type cohort_maturity --topo-pass --no-cache --no-snapshot-cache
```

### Multi-hop cohort (V2)
```
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(household-delegated).to(switch-success).cohort(17-Mar-26:13-Apr-26)" \
  --type cohort_maturity_v2 --topo-pass --no-cache --no-snapshot-cache
```

### Multi-hop window (V2)
```
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(household-delegated).to(switch-success).window(17-Mar-26:13-Apr-26)" \
  --type cohort_maturity_v2 --topo-pass --no-cache --no-snapshot-cache
```

### Single-hop control (cohort)
```
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(switch-registered).to(switch-success).cohort(17-Mar-26:13-Apr-26)" \
  --type cohort_maturity --topo-pass --no-cache --no-snapshot-cache
```

### Single-hop control (window)
```
bash graph-ops/scripts/analyse.sh bayes-test-gm-rebuild \
  "from(switch-registered).to(switch-success).window(17-Mar-26:13-Apr-26)" \
  --type cohort_maturity --topo-pass --no-cache --no-snapshot-cache
```

### Forensic data

Temporary forensic instrumentation writes to `/tmp/v2_forensic.json`
and `/tmp/v3_forensic.json` after each run. These contain per-tau
Y/X/rate medians and per-cohort input summaries. Run a cohort then
window variant and compare:

```
python3 -c "
import json
with open('/tmp/v3_forensic.json') as f: data = json.load(f)
for t in [5, 7, 10, 14, 20, 30]:
    row = data.get(str(t), {})
    print(f'tau={t}: Y={row.get(\"Y_med\")} X={row.get(\"X_med\")} rate={row.get(\"rate_med\")}')
"
```

## Fix

The fix is to decouple **subject evidence family** from **query
temporal mode** in the V2/V3 per-edge loops.

For **multi-hop cohort** queries:

- subject-frame construction should use **window** evidence for the
  whole `x→y` span
- path-level forecast semantics should remain **cohort**

That means:

- use `window` evidence when reading rows that feed
  `derive_cohort_maturity()` / `compose_path_maturity_frames()`
- keep `is_window=False` for the downstream span kernel, path-level
  CDF choice, `x_provider`, frontier logic, and IS conditioning

Critically, this is **not** an "intermediate edges only" fix. Leaving
the last edge on `cohort` would preserve the dominant `Y` defect,
because `compose_path_maturity_frames()` sources `Y` from the
`y`-incident / last-edge side.

The practical rule is:

- single-hop `cohort()` (`path_role='only'`): keep the query temporal mode
- multi-hop `cohort()` (`len(subjects) > 1`): use `window` evidence for
  all subject edges during frame construction

This applies to both V2 (line 1345) and V3 (line 1890) handlers.
