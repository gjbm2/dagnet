# Doc 11 — Phase S: Snapshot Evidence Assembly

**Status**: In progress — Stage 1 (evidence binder rewrite)
**Date**: 18-Mar-26 (design), 19-Mar-26 (implementation plan)
**Purpose**: Scope the work to replace inline parameter-file evidence with
direct snapshot DB queries in the Bayes compiler. This is a distinct
development phase positioned between Phase B (Dirichlet) and Phase C
(slice pooling).

**Related**: `3-compute-and-deployment-architecture.md` (§6 DB access
pattern), `6-compiler-and-worker-pipeline.md` (Layer 4: historic snapshot
data), `programme.md` (phase sequencing), `../project-db/1-reads.md`
(snapshot read architecture)

---

## 0. Background: snapshot data and the pinned DSL

This section provides orientation for the snapshot evidence pipeline.
The authoritative spec is `../project-db/1-reads.md`; this is a
condensed summary of the parts relevant to the Bayes compiler.

### What is in the snapshot DB

The `snapshots` table (PostgreSQL in Neon) stores time-series
conversion evidence. Each row is one observation of a single cohort
day at a specific retrieval date:

| Column | Meaning |
|---|---|
| `param_id` | Workspace-prefixed parameter ID (`repo-branch-param-objectId`) |
| `core_hash` | FE-computed SHA-256 hash of the canonical query signature — the **sole read identity** |
| `slice_key` | Context DSL or `''` for uncontexted (e.g. `context(channel:google).cohort(...)`) |
| `anchor_day` | ISO date — the cohort start date |
| `retrieved_at` | UTC timestamp when the data was fetched from source |
| `a` | Anchor entrants (the fixed cohort population entering the anchor node) |
| `x` | From-step count (entrants reaching the edge's source node by this retrieval) |
| `y` | To-step count (converters reaching the edge's target node by this retrieval) |
| `median_lag_days` / `mean_lag_days` | Per-row lag statistics |
| `anchor_median_lag_days` / `anchor_mean_lag_days` | Upstream anchor-to-source lag |
| `onset_delta_days` | Onset delay |

Multiple rows for the same `(anchor_day, slice_key)` at different
`retrieved_at` dates form the **maturation trajectory** — how the
cumulative conversion count `y` grew as late converters arrived.

### How the data gets there: daily fetch driven by the pinned DSL

The graph's `dataInterestsDSL` (the "pinned query") drives the daily
fetch pipeline. A typical value:

```
context(channel);context(browser_type).window(-90d:)
```

This means: "fetch data sliced by channel and by browser type, over a
90-day rolling window." The daily fetch service (`retrieveAllSlicesService`)
processes this as follows:

1. **Explode** the compound DSL into atomic slices via `explodeDSL()`.
   `context(channel)` (bare key) is expanded by looking up the context
   definition to discover concrete values: `context(channel:google)`,
   `context(channel:facebook)`, `context(channel:organic)`, etc. Each
   gets the temporal clause appended.

2. **Per slice**, build a fetch plan via `buildFetchPlanProduction()`.
   Each plan item has a `querySignature` (semantic identity of the
   query) and a `sliceFamily` (the context component).

3. **Fetch from source** (Amplitude, etc.) for each plan item's missing
   dates. Write the resulting time-series rows to the snapshot DB via
   `snapshotWriteService`.

4. Each DB write produces a row keyed by `(core_hash, slice_key,
   anchor_day, retrieved_at)`. The `core_hash` is derived from the
   `querySignature` and is **different per context value** —
   `context(channel:google)` and `context(channel:facebook)` have
   different signatures, therefore different hashes, therefore different
   DB rows. There is no single "aggregate" hash that covers all slices.

5. Over time, the same `(anchor_day, slice_key)` accumulates multiple
   `retrieved_at` entries as the daily fetch runs repeatedly. This is
   the maturation trajectory.

### Implications for the Bayes compiler

- **Uncontexted snapshots may not exist.** If the graph's daily fetch
  runs with `context(channel).window(-90d:)`, the DB has per-channel
  rows. There may be no uncontexted aggregate rows.
- **Each context value has a different `core_hash`.** To retrieve all
  evidence for an edge, the FE must explode the DSL and compute per-
  slice hashes — one DB query per (edge × context value).
- **The `a` column is the fixed denominator.** Anchor entrants don't
  change across retrieval ages. The `x` column (from-step entrants)
  does change for downstream edges. The trajectory likelihood uses
  `a`, not `x`, as the denominator (see doc 6, Layer 3 §Maturation
  trajectory likelihood).
- **Hash equivalence** (`hash-mappings.json`) handles hash renames.
  The FE computes the closure set and attaches `equivalent_hashes` to
  each snapshot subject so DB queries find rows across renames.

---

## 1. Problem

The compiler currently receives all evidence inline in the submit
payload — parameter files with `values[]` entries containing `(n, k)`,
`(n_daily, k_daily, dates)`, and lag summaries. This is the latest
snapshot only: one observation per cohort day at the day's current age.

The snapshot DB contains **multiple observations of the same cohort day
at different retrieval ages** — the maturation trajectory. For a cohort
day 15-Jan:

| Source | What the compiler sees |
|---|---|
| Parameter file | k=80 at age 45 days (one point) |
| Snapshot DB | k=30 at age 10, k=55 at age 20, k=72 at age 30, k=80 at age 45 |

The maturation trajectory is what identifies the latency distribution.
A single endpoint per day gives the age gradient across days (useful but
indirect). The full trajectory per day traces the CDF shape directly.
Without it, completeness coupling works from a fraction of the available
evidence and the latency model is poorly constrained.

Doc 3 §6 designed three DB interactions for the worker (inventory query,
hierarchy shaping, evidence fetch). None were implemented. The worker
connects to Neon, runs `SELECT 1`, and ignores the DB.

---

## 2. Why before Phase C

Phase C (slice pooling) decides shrinkage strength per slice based on
data volume and cross-slice variance. Building slice pooling on thin
parameter-file evidence (one aggregate per slice) and later swapping in
rich snapshot evidence (full daily trajectories per slice) would require
re-validating all shrinkage behaviour.

Snapshot evidence also immediately improves Phase A/B — the maturation
trajectory directly constrains the completeness coupling already wired
into the model. The deployed pipeline benefits now, not later.

Sequence: **A → B → S → C → D**

---

## 3. What the FE must send at submission time

### Training window: derived from the pinned DSL

The graph's `dataInterestsDSL` (the pinned query that drives daily
fetch) already expresses the training scope:

- **Time window**: e.g. `window(-90d:)` → last 90 days rolling
- **Context dimensions**: e.g. `context(channel);context(browser-type)`
  → which slice families exist
- **Observation types**: `window(...)` vs `cohort(anchor,...)` clauses

This is the natural input for the Bayes training window because it
describes exactly what evidence has been fetched and is available in the
DB. The FE reads `dataInterestsDSL` from the graph and uses it to
derive the snapshot subject requests.

### Forecasting settings: must be included

`useBayesTrigger.ts` currently sends `settings: { placeholder?: true }`
— nearly empty. The `settings` block must include the forecasting model
settings from `forecastingSettingsService.getForecastingModelSettings()`:

- `RECENCY_HALF_LIFE_DAYS` — recency weighting for evidence
- `LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE` — minimum n threshold
- `ONSET_MASS_FRACTION_ALPHA` / `ONSET_AGGREGATION_BETA` — onset
  derivation parameters

These are already defined in `forecastingSettingsService.ts` with
sensible defaults from `constants/latency.ts`. The compiler's evidence
binder already accepts a `settings` dict — it just needs to be
populated.

### Building snapshot subjects: reuse existing infrastructure

The FE already has a complete pipeline for building snapshot subject
requests in `snapshotDependencyPlanService.ts`. The Bayes path reuses
this with minimal new code.

**Existing pipeline** (for analysis views):
1. `buildFetchPlanProduction()` — enumerates parameter targets, produces
   items with `querySignature`
2. `mapFetchPlanToSnapshotSubjects()` — transforms plan items →
   `SnapshotSubjectRequest[]`, computing `core_hash`, resolving
   `slice_keys`, deriving time bounds from DSL

**Key reuse point**: `mapFetchPlanToSnapshotSubjects()` dispatches on an
analysis type's `snapshotContract`, which specifies `scopeRule` and
`readMode`. The scope rule `all_graph_parameters` already exists and
returns all parameter items unfiltered — exactly what Bayes needs.

**Approach**: register a `bayes_fit` entry in the analysis type registry
(`analysisTypes.ts`) with contract:

```
{
  scopeRule: 'all_graph_parameters',
  readMode: 'sweep_simple',
  slicePolicy: 'mece_fulfilment_allowed',
  timeBoundsSource: 'query_dsl_window',
  perScenario: false,
}
```

Then call the existing `mapFetchPlanToSnapshotSubjects()` with
`analysisType: 'bayes_fit'` and the pinned DSL as `queryDsl`. This
produces `SnapshotSubjectRequest[]` with correct hashes, slice keys,
time bounds, and workspace-prefixed param IDs — all computed by the
same code paths that analysis views use.

**Why `sweep_simple`, not `cohort_maturity`**: the `cohort_maturity`
read mode triggers epoch segmentation — a browser-side DB preflight
query (`querySnapshotRetrievals()`), per-day MECE slice selection, and
sweep segmentation into `::epoch:N` suffixed subjects. This is
chart-rendering machinery that the Bayes worker doesn't need. The
`sweep_simple` path (lines 715–741 in
`snapshotDependencyPlanService.ts`) skips all epoch logic and produces
one subject per edge with the full sweep range. The worker then queries
`query_snapshots_for_sweep()` directly with the full range — simple
and correct.

**No generalisation of `mapFetchPlanToSnapshotSubjects()` needed.** The
`sweep_simple` code path already exists and handles the Bayes case
cleanly.

### Per-subject request shape

Each subject in the `snapshot_subjects[]` array:

- **`param_id`**: workspace-prefixed (`repo-branch-param-objectId`)
- **`core_hash`**: FE-computed via `computeShortCoreHash()` — SHA-256
  first 16 bytes, base64url (~22 chars). Sole DB read identity.
- **`canonical_signature`**: the full signature string (for
  provenance/debugging — backend receives both hash and signature)
- **`slice_keys`**: context slice DSL strings. `['']` for uncontexted;
  MECE partition list when contexts are declared.
- **`anchor_from`** / **`anchor_to`**: training window date bounds,
  derived from the pinned DSL's time clause.
- **`sweep_from`** / **`sweep_to`**: retrieval date range for the
  maturation trajectory. `sweep_from` = `anchor_from` (or earlier);
  `sweep_to` = today.
- **`equivalent_hashes`**: closure set from
  `hashMappingsService.getClosureSet()`, so DB queries find rows
  across hash renames.
- **`edge_id`**: edge UUID for mapping rows back to the topology.

### Updated submit payload

```
{
  "graph_snapshot": { ... },
  "parameter_files": { ... },
  "parameters_index": { ... },
  "settings": {
    "RECENCY_HALF_LIFE_DAYS": 45,
    "LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE": 30,
    ...
  },
  "snapshot_subjects": [
    {
      "param_id": "repo-branch-param-abc",
      "core_hash": "aB3x_D1Ef2GhI",
      "canonical_signature": "{ ... }",
      "slice_keys": ["", "context(channel:paid).cohort(...)"],
      "anchor_from": "2024-10-01",
      "anchor_to": "2025-01-01",
      "sweep_from": "2024-10-01",
      "sweep_to": "2025-03-18",
      "equivalent_hashes": ["xY7z..."],
      "edge_id": "edge-uuid-123"
    },
    ...
  ],
  "webhook_url": "...",
  "callback_token": "...",
  "db_connection": "..."
}
```

### FE implementation summary

Changes to `useBayesTrigger.ts`:

1. Read `dataInterestsDSL` from the graph (already in `graphFile.data`)
2. Read forecasting settings via
   `forecastingSettingsService.getForecastingModelSettings()`
3. Build fetch plan via `buildFetchPlanProduction()` using the pinned
   DSL
4. Map to snapshot subjects via `mapFetchPlanToSnapshotSubjects()` with
   `analysisType: 'bayes_fit'`
5. Attach `snapshot_subjects[]` and `settings` to the payload

Steps 3–4 reuse existing code paths. Step 2 is a one-line service call.
The new code is the wiring in `useBayesTrigger.ts` (~20–30 lines).

---

## 4. What the worker does with snapshot subjects

### Data flow: FE → Modal → DB → compiler

```
FE builds snapshot_subjects[] (hashes, bounds, slices)
  → submits to Modal worker
    → worker queries Neon via snapshot_service.query_snapshots_for_sweep()
      → rows flow to evidence binder
        → compiler consumes as likelihood terms
```

No round trips back to the FE. The worker has a direct DB connection
(doc 3 §6) and queries using the FE-provided coordinates.

### Per-subject DB query

For each subject in `snapshot_subjects[]`, the worker calls:

```python
rows = query_snapshots_for_sweep(
    param_id=subject['param_id'],
    core_hash=subject['core_hash'],
    slice_keys=subject.get('slice_keys', ['']),
    anchor_from=date.fromisoformat(subject['anchor_from']),
    anchor_to=date.fromisoformat(subject['anchor_to']),
    sweep_from=date.fromisoformat(subject['sweep_from']),
    sweep_to=date.fromisoformat(subject['sweep_to']),
    equivalent_hashes=subject.get('equivalent_hashes'),
)
```

This function already exists in `snapshot_service.py` (line 518). It
returns all rows matching the hash (including equivalents) within the
anchor and sweep date ranges. Each row has:

- `param_id`, `core_hash`, `slice_key`, `anchor_day`, `retrieved_at`
- `a` (anchor entrants), `x` (from-step count), `y` (to-step count)
- `median_lag_days`, `mean_lag_days`, `anchor_median_lag_days`,
  `anchor_mean_lag_days`, `onset_delta_days`

### Maturation trajectory construction

For each `(anchor_day, slice_key)` pair within a subject's rows, the
worker sees multiple rows at different `retrieved_at` dates. Each row
is an observation of the same cohort day at a different maturation age:

```
anchor_day=2025-01-15, retrieved_at=2025-01-25 → age=10, x=200, y=30
anchor_day=2025-01-15, retrieved_at=2025-02-04 → age=20, x=200, y=55
anchor_day=2025-01-15, retrieved_at=2025-02-14 → age=30, x=200, y=72
anchor_day=2025-01-15, retrieved_at=2025-03-01 → age=45, x=200, y=80
```

Each row becomes a `CohortDailyObs` with:
- `n = x` (from-step entrants — the denominator)
- `k = y` (to-step converters observed by this retrieval date)
- `age_days = (retrieved_at - anchor_day).days`
- `completeness` pre-computed from age and path latency (same Phase A
  logic)

A single cohort day retrieved 5 times produces 5 likelihood terms at 5
different ages. This is the maturation curve the model fits.

### Mapping rows to edges

Each subject carries `edge_id`. The worker maps
`subject.edge_id → topology edge → EdgeEvidence`. Multiple subjects
may map to the same edge (different slice keys or different hash
equivalents) — their rows accumulate into the same `EdgeEvidence`.

### Relationship to parameter-file evidence

Parameter file `values[]` entries are summaries derived from the same
snapshot data. With snapshot evidence available, the compiler should
**prefer snapshot rows** and use parameter file evidence only as
fallback (when no snapshot data exists for an edge).

No double-counting — decision logic per edge:

```
if snapshot_subjects has rows for this edge:
    use snapshot rows (richer, per-retrieval-date trajectory)
    ignore parameter file values[] for this edge
else:
    fall back to parameter file values[] (current behaviour)
    emit diagnostic: "no snapshot data for edge X, using param file"
```

Priors (warm-start from previous posteriors) still come from parameter
files regardless — the `posterior` block on the param file is the prior
source, not the snapshot DB.

---

## 5. Evidence binder: snapshot row transformation

### Cohort-first structure

Raw snapshot DB rows are indexed by `(core_hash, slice_key,
anchor_day, retrieved_at)`. The evidence binder transforms these into
a **Cohort-first** structure where the natural unit is the Cohort —
a group of people who commenced on a specific date (an independent
experiment group).

Both `window()` and `cohort()` slices describe evolving Cohorts with
the same underlying data shape:

```
Cohort 2025-11-19:
  age 82d → y=329
  age 84d → y=329

Cohort 2025-11-20:
  age 81d → y=258
  age 83d → y=258
```

Each Cohort is an independent experiment with a fixed population.
The as-at dates (`retrieved_at`) are successive measurements of the
same monotonic cumulative distribution. The trajectory jointly
constrains both probability and latency — they cannot be separated
because the maturation curve shape reflects both.

### Transformation steps

1. **Group by `(edge_id, anchor_day)`** across all `slice_key`
   values — the slice_key reflects how the FE queried the data, not
   the identity of the Cohort
2. **Deduplicate** rows with identical `(anchor_day, retrieved_at)`
   that appear across overlapping slices (same observation, not
   independent)
3. **Sort** observations within each Cohort by age ascending
4. **Monotonise** cumulative `y` (carry forward if `y` decreases)
5. **Tag** each Cohort with its observation type:
   - `window()` rows → edge-level completeness, `p_window` variable,
     denominator is `x` (from-node entrants)
   - `cohort()` rows → path-level completeness, `p_cohort` variable,
     denominator is `a` (anchor entrants)
6. **Produce** `CohortDailyTrajectory` for Cohorts with multiple
   retrieval ages, `CohortDailyObs` fallback for single-retrieval
   Cohorts

### Denominator: `x` vs `a`

The two observation types use different denominators:

- **`window()` Cohorts**: denominator is `x` (from-node entrants for
  this edge). Direct edge-level observation.
- **`cohort()` Cohorts**: denominator is `a` (anchor entrants).
  Path-level observation — the probability in the likelihood is
  `p_path = ∏ p_edge` (product of all upstream edge probabilities).

For the first edge from anchor, `x = a` and the two coincide.

### Fallback to parameter files

Per edge: if snapshot rows exist, use them (richer per-Cohort
trajectory data). If not, fall back to parameter file `values[]`
entries (current Phase A/B behaviour). No double-counting — decision
is per edge, not per observation.

Priors (warm-start from previous posteriors) always come from
parameter files regardless of snapshot source.

---

## 6. Model impact

The compiler receives Cohort-first trajectory objects from the
evidence binder and emits likelihood terms. The full mathematical
formulation is in **doc 6, Layer 3 § "Maturation trajectory
likelihood"**, including:

- **Interval-censored Multinomial**: cumulative observations
  partitioned into intervals, preventing double-counting of the same
  individuals across retrieval ages
- **`pm.Potential` vectorisation**: one Potential per edge per
  observation type (window/cohort), replacing per-day `pm.Multinomial`
  nodes to avoid PyTensor compilation bottleneck
- **Window/cohort hierarchy**: separate Potentials for `window()` and
  `cohort()` data, linked through `p_base` and shared `(mu, sigma)`
  latency variables (see doc 6, Layer 3 § "Hierarchical pooling")
- **Phase S latency**: fixed from priors (CDF values are constants).
  Phase D makes latency latent — same Potential structure, gradients
  flow through automatically

### What this constrains

- `window()` trajectories **directly pin edge latency** —
  single hop, no path composition, cleanest signal
- `cohort()` trajectories **constrain the full path** — latency
  from all upstream edges is coupled through the composed CDF
- Both share `(mu_edge, sigma_edge)` and connect through `p_base`
- The hierarchical connection ensures they are not modelled
  independently — they observe the same underlying conversion process

---

## 7. Implementation status and plan

### Component status (19-Mar-26)

| Component | Status | Notes |
|---|---|---|
| FE settings in payload | Done | `forecastingSettingsService` settings included |
| `bayes_fit` analysis type | Done | `scopeRule: 'all_graph_parameters'`, `readMode: 'sweep_simple'` |
| FE snapshot subject building | Done | `useBayesTrigger` builds 8 subjects (4 edges × 2 slices), `edge_id` flattened, `equivalent_hashes` from hash-mappings, commission logging |
| Worker DB query | Done | `_query_snapshot_subjects` queries Neon, returns rows grouped by `edge_id`. 6255 rows for test graph |
| Evidence binder | Done | Cohort-first grouping by `anchor_day`, both window/cohort obs types, deduplication, monotonisation |
| Model emission | Done | `pm.Potential` per edge per obs_type. Window uses `p_window`, cohort uses `p_cohort`. Compiles in ~2.5s |
| Latent latency (Phase D) | Done | Per-edge `mu_lat`/`sigma_lat` free variables. Window Potentials use edge-level CDF. Cohort Potentials use FW-composed path-level CDF with differentiable gradients to all upstream edges |
| Inference | Done | nutpie backend, ~31s sampling, rhat=1.002, ess=2432, 0 divergences |
| Posterior extraction | Done | Probability from real samples + moment-matched Beta. Latency from real `mu_lat`/`sigma_lat` samples (not echoed priors) |
| Webhook / patch delivery | Done | Patch file written to git, FE fetches and applies |
| FE patch application | Done | `bayesPatchService` upserts posteriors, cascade runs |
| Test harness | Done | `bayes/test_harness.py` — direct pipeline execution with progress, timeout |
| Wiring harness | Done | `bayes/test_wiring.py` — 111 structural assertions at every integration boundary |

### Development stages

Each stage gates the next. Verification at each integration boundary
before proceeding.

#### Stage 1: Evidence binder rewrite

**Goal**: `_bind_from_snapshot_rows` produces Cohort-first trajectory
objects from both `window()` and `cohort()` rows.

Work:
- Rewrite grouping: `anchor_day` across all slice_keys, not
  `(slice_key, anchor_day)`
- Both `window()` and `cohort()` rows produce trajectory objects
- Tag each with `obs_type` for the compiler (determines denominator,
  probability variable, CDF level)
- Deduplicate rows with identical `(anchor_day, retrieved_at)` across
  slices

Verification (via test harness):
- Per-edge summary showing window Cohorts AND cohort Cohorts
- Trajectory counts, age distributions, denominators (`x` vs `a`)
- No trajectories with zero or negative ages
- Monotonic `y` within each trajectory

#### Stage 2: Model emission — `pm.Potential` vectorisation

**Goal**: model builds in <10s, compiles in <30s, with separate
window and cohort Potentials per edge.

Work:
- Replace per-day `pm.Multinomial` with per-edge `pm.Potential`
- Implement vectorised Multinomial logp (interval partitioning from
  cumulative observations, log-probability sum)
- Separate Potentials for window and cohort data per edge
- Numerical stability: clamp interval probabilities to floor (1e-12),
  use `log1p` where appropriate

Verification (via test harness):
- Model builds without error
- Correct free variable count (13 for Phase S fixed latency)
- Window and cohort Potential nodes present (not 235 Multinomials)
- Compilation time <30s
- logp/dlogp evaluation <10ms

#### Stage 3: End-to-end inference

**Goal**: full pipeline produces posteriors from real snapshot data.

Work:
- Run harness with all 8 subjects, no webhook
- May need sampling config tuning (target_accept, draws)

Verification:
- Sampling completes within 3 minutes
- `rhat < 1.05`, `ess > 400` for all edges
- Posteriors exist for all 4 fitted edges
- Compare against window-only baseline (4-subject run, which
  converged with rhat=1.002, ess=4272): snapshot-enriched posteriors
  should be tighter or materially different where Cohort data adds
  information

#### Stage 4: FE round-trip

**Goal**: full loop works from browser through to posteriors on
canvas.

Work:
- Run via `useBayesTrigger` on the clean test branch
  (`feature/bayes-test-graph`, reset to clean state 19-Mar-26)
- Clear app state, re-clone test branch, trigger Bayes fit

Verification (via session log):
- `BAYES_COMMISSION_PLAN` shows 8 subjects with correct
  `edge_id`, `core_hash`, `equivalent_hashes`
- `BAYES_DEV_COMPLETE` result log shows DB rows fetched,
  window + cohort Cohorts bound, Potentials emitted
- Evidence detail lines show `source=snapshot` with trajectory
  counts for both observation types
- `BAYES_PATCH_APPLIED` shows edges updated
- `BAYES_CASCADE_COMPLETE` shows cascade ran
- Posterior indicators visible on canvas edges
- Cohort maturity chart shows Bayesian curve tracking evidence

---

## 8. Test strategy

### Three-tier verification workflow

Changes to the compiler must pass through three tiers in order.
Each tier gates the next. Do not skip to FE testing without passing
the earlier tiers — wiring bugs found via FE round-trip are expensive
to diagnose.

#### Tier 1: Wiring harness (`bayes/test_wiring.py`) — ~2s

Structural verification of the PyTensor computation graph. No MCMC.
Checks every integration boundary:

```bash
. graph-editor/venv/bin/activate
python bayes/test_wiring.py --no-mcmc
```

111 assertions covering:
- **TOPO**: anchor, edges, branch groups, path composition, latency priors
- **EVID**: snapshot rows → observations, window/cohort split, trajectory
  quality (monotonic y, positive ages, correct denominators)
- **MODEL**: free variables exist, Potentials exist, `p_window` wires to
  window Potentials (not `p_cohort`), `p_cohort` wires to cohort Potentials,
  latent `mu_lat`/`sigma_lat` in computation graph, FW path composition
  verified via PyTensor ancestor traversal (downstream cohort Potentials
  depend on upstream latency variables)
- **Pass criteria**: all 111 checks green

#### Tier 2: Test harness (`bayes/test_harness.py`) — ~35s

Full pipeline execution with real MCMC on the test graph. No browser
needed. Verifies the model compiles, samples, converges, and produces
sensible posteriors.

```bash
. graph-editor/venv/bin/activate
python bayes/test_harness.py --no-webhook --timeout 300 > /tmp/bayes-harness.log 2>&1 &
tail -f /tmp/bayes-harness.log
```

Also supports fast mode via wiring harness:
```bash
python bayes/test_wiring.py          # fast MCMC (200 draws, ~30s)
python bayes/test_wiring.py --full   # full MCMC (2000 draws, ~35s)
```

- **Pass criteria**: `PASS` at end, rhat < 1.05, ESS > 400, 0 divergences
- **Latency check**: inference log must show `latency {edge}…: mu=X±Y
  (prior=Z)` lines confirming posteriors are from real samples, not echoed
  priors. Delta between posterior and prior should be reasonable (not
  massively inflated — that indicates missing path composition)

#### Tier 3: FE round-trip — ~45s

Full browser-based round-trip via `useBayesTrigger`. Validates the
complete async pipeline including webhook, patch application, cascade,
and visual rendering.

1. Ensure dev server is running and reloaded with latest compiler code
2. Trigger Bayes fit from the dev UI on the test graph
3. Check session log for:
   - `BAYES_COMMISSION_PLAN`: 8 subjects, correct hashes
   - `BAYES_DEV_COMPLETE`: status=complete, edges_fitted=4, latency
     posterior diagnostics present
   - `BAYES_PATCH_APPLIED`: 4 edges updated, latency=true for 2 edges
   - `BAYES_CASCADE_COMPLETE`: cascade ran
4. Visual check: cohort maturity chart Bayesian curve tracks the data
   for both short-path and long-path edges

### Diagnosing common failures

| Symptom | Likely cause | Which tier catches it |
|---|---|---|
| Window Potential uses `p_cohort` | `p_window_var` not passed to `_emit_cohort_likelihoods` | Tier 1 (ancestor check) |
| Latency posterior echoes prior exactly | `summarise_posteriors` not reading trace samples | Tier 2 (latency diagnostic lines missing) |
| Downstream edge mu inflated | Cohort CDF using edge-level instead of FW-composed path-level latency | Tier 1 (upstream ancestor check) + Tier 2 (posterior delta) |
| Bayesian curve shape wrong, level OK | FE rendering uses stale latency (point-estimate provenance) | Tier 3 (visual check + patch log `latency=true`) |
| `eps_window` unconstrained | Window trajectories in `cohort_obs` not routing through `p_window` | Tier 1 (ancestor check) |

### Parameter recovery tests (synthetic data)

Same synthetic topologies as Phase A/B tests, with synthetic snapshot
rows generated from known ground truth:
- Solo edges, chains, branch groups
- Immature Cohorts with richer daily granularity
- Recovery at least as good as Phase A/B tests

### Fallback tests

- Edge with snapshot data + edge without → mixed path works
- No snapshot subjects → falls back to param file evidence entirely
- Priors from param files regardless of evidence source

---

## 9. Evidence binder: snapshot row transformation

**Date**: 19-Mar-26

### Data transformation: cohort-first structure

Raw snapshot DB rows are indexed by `(core_hash, slice_key,
anchor_day, retrieved_at)`. Before the compiler sees them, the
evidence binder should transform into a **cohort-first** structure
where the natural unit is the cohort day:

```
Cohort 2025-11-19 (a=651):
  age 82d → y=329
  age 84d → y=329

Cohort 2025-11-20 (a=493):
  age 81d → y=258
  age 83d → y=258
```

Each cohort day is an independent experiment with `a` individuals.
The as-at dates (`retrieved_at`) are successive measurements of the
same monotonic cumulative distribution. The `age` is
`(retrieved_at - anchor_day)` in days.

This transformation:
- Groups all rows for a given `(edge_id, anchor_day)` regardless
  of `slice_key` — the slice_key reflects how the FE queried the
  data, not the identity of the cohort
- Deduplicates rows with identical `(anchor_day, retrieved_at)` that
  appear across overlapping slices (same observation, not independent)
- Sorts observations within each cohort by age ascending
- Monotonises cumulative `y` (carry forward if `y` decreases)
- Produces one `CohortDailyTrajectory` per cohort day (or
  `CohortDailyObs` fallback for single-retrieval days)

Window and cohort rows contribute to the same cohort-first structure
but are tagged with their observation type for the compiler:
- Window rows → edge-level completeness, `p_window` variable
- Cohort rows → path-level completeness, `p_cohort` variable

The compiler design for how these cohort objects become likelihood
terms is specified in **doc 6, Layer 3 § "Maturation trajectory
likelihood"** — including the `pm.Potential` vectorisation approach,
the window/cohort hierarchical connection, and Phase S vs Phase D
latency treatment.

### First integration test results

Test graph `bayes-test-gm-rebuild`, 4 edges, 8 snapshot subjects
(window + cohort), 6135 total DB rows:

| Edge | Total rows | Trajectories | Unique cohort days |
|---|---|---|---|
| landing→created | 663 | 82 (2 ages each) | 120 |
| created→delegated | 504 | 0 (single-retrieval) | 120 |
| delegated→registered | 2360 | 72 (2–31 ages) | 120 |
| registered→success | 2608 | 81 (2–37 ages) | 120 |

The current implementation emits 235 individual `pm.Multinomial`
nodes, causing a 5-minute PyTensor compilation bottleneck (the model
itself evaluates in 2ms per gradient step). The `pm.Potential`
vectorisation approach in doc 6 addresses this.

---

## 10. Phase D sub-phase: latent latency with temporal drift

**Date**: 19-Mar-26
**Status**: Design notes — not yet implemented

### Motivation: why Phase D matters more than originally scoped

Phase S delivers the snapshot data pipeline and uses Cohort
trajectories for completeness-adjusted probability estimation. But
with fixed latency (Phase S), the within-trajectory maturation
shape — the richest signal in the snapshot data — is locked in a
constant. The model uses the cross-Cohort age gradient but not the
within-Cohort curve. Phase D unlocks that by making `(mu, sigma)`
latent.

More importantly: if latency is drifting (the product is getting
faster or slower), a model with stable `(mu, sigma)` averages over
the entire training period. The forecast then projects from a
historical average that may not reflect current conditions. A
speed-up in fulfilment would be misattributed as a change in
conversion probability, leading to materially wrong forecasts.

**The purpose of temporal drift detection is forecasting, not
reporting.** We are not interested in telling the user what the
latency distribution looked like in historic periods — we use
evidence for that. We ARE interested in ensuring the model's forward
projections accommodate the possibility that latency has shifted.
The forecast should project from the **current regime**, informed
by the drift pattern, not from a diluted historical average.

### Phase D sequencing: before Phase C

The original sequence was A → B → S → C → D. Revised proposal:
**A → B → S → D → C**.

Arguments:
- Phase S delivers the data. Phase D extracts the full value from
  that data. Doing C first (slice pooling) adds more data of the
  same kind; doing D first extracts more from what we already have.
- The latency drift question matters more for forecast accuracy than
  the segmentation question (does channel X differ from channel Y?).
- The `pm.Potential` structure extends cleanly to latent CDFs — the
  implementation path is clear.
- Phase C (Dirichlet across slices) can be built on top of latent
  latency more naturally than the reverse.

### Design: time-binned latency

Instead of one fixed `(mu, sigma)` per edge, segment Cohort days
into time bins and allow `mu` to vary by bin:

```
mu_base_XY ~ Normal(prior_mu, prior_sigma)
sigma_drift_XY ~ HalfNormal(small)         # how much mu moves per bin
mu_t_XY ~ Normal(mu_{t-1}_XY, sigma_drift_XY)  for t = 1..T
sigma_XY ~ HalfNormal(prior)                    # shared across bins
```

`mu_t` varies (central tendency of latency shifts over time).
`sigma` is shared (inherent variability of the process, less likely
to drift). The random walk connects successive bins: if `sigma_drift
→ 0`, all bins collapse to `mu_base` and we recover the stable
model. The data decides.

**Bin width**: configurable via model settings (e.g.
`LATENCY_DRIFT_BIN_DAYS = 7`), not a literal "weekly." Each Cohort
day maps to bin `floor((anchor_day - start) / bin_days)`.

**Path composition**: for downstream edges, the path CDF for Cohort
day `d` uses `FW_compose(mu_AB_bin(d), sigma_AB, ..., mu_XY_bin(d),
sigma_XY)`. The bin is determined by the anchor day — "the latency
conditions when this Cohort entered are the ones that apply." FW
composition is computed per unique bin combination (at most T
computations per downstream edge).

**Self-regularisation**: the random walk prior + hierarchical
structure means the model is conservative by default. Insufficient
data per bin → bins collapse to the shared base → stable-latency
behaviour. Rich data with genuine drift → bins separate → model
identifies the current regime.

### Identifiability: p drift vs latency drift

With both `p` and `mu` free to vary over time, the same observation
(more early conversions) could be explained by higher `p` or faster
latency. **Window trajectories resolve this** — the maturation
SHAPE of a window trajectory separates level (p) from shape
(latency). A steep early rise = fast latency. A high final level =
high p. The shape and level are distinguishable when trajectories
have 3+ retrieval ages.

For edges with only 2-point trajectories (e.g. landing→created),
within-trajectory shape information is minimal. Identifiability
relies on the cross-Cohort pattern: different time bins showing
systematically different maturation patterns.

### Posterior output

The model produces per-edge posteriors as now: `(alpha, beta)` for
probability, plus `(mu, sigma)` for latency. The latency posterior
is the **current-regime estimate** — the most recent time bin's
`mu_t`, not a historical average. The drift rate `sigma_drift` is a
diagnostic: near zero = stable, material = latency is moving.

The user sees the same posterior summary and quality metrics. The
time bins are internal model machinery, not exposed in the UI.
The forecast benefits because it projects from current conditions.

### Drift priors from `fit_history`

Doc 6, Layer 5 already specifies trajectory-calibrated priors via
DerSimonian-Laird: the between-run heterogeneity `tau²` estimated
from `fit_history` entries sets the prior concentration. This same
mechanism directly calibrates the drift parameters:

- **`sigma_drift` prior** ← `tau_mu²` from `fit_history[].mu`
  (between-run variance of latency log-mean). If historic fits show
  stable `mu`, `sigma_drift_prior` is small → time bins tightly
  constrained. If `mu` has been jumping, `sigma_drift_prior` is
  large → bins have room to separate.

- **`sigma_temporal` prior** ← `tau²` from `fit_history[].logit(p)`
  (between-run variance of probability in logit space). Already
  specified in doc 6 Layer 5.

This makes the model adaptive without user configuration. The drift
allowance for both probability and latency is calibrated from the
history of each parameter. A newly created edge with no fit history
gets uninformative drift priors (conservative, allows the data to
speak). An edge with 10+ stable fits gets tight drift priors that
resist spurious bin separation.

The mechanism is the same DerSimonian-Laird estimate already
designed for warm-start priors — it just feeds into a different
consumer (drift variance prior rather than prior concentration).

### Interaction with existing model

The probability hierarchy (`p_base`, `p_window`, `p_cohort`,
`sigma_temporal`) is unchanged — it governs p drift independently.
The latency hierarchy (`mu_base`, `mu_t`, `sigma_drift`, `sigma`)
runs in parallel. Both coexist:

- `sigma_temporal`: how much conversion rates move over time
  (prior from fit_history probability trajectory)
- `sigma_drift`: how much latency moves over time
  (prior from fit_history latency trajectory)

Window data anchors both: edge-level p via `p_window`, edge-level
latency via the window trajectory shape. Cohort data constrains
the full path through composed latency and `p_path`.

### Cost estimate

For the test graph (4 edges, ~16 weekly bins):
- ~64 new `mu_t` variables + 4 `sigma_drift` + 4 `sigma` = ~72
  new free variables
- Total ~85 free variables (from current 13)
- NUTS sampling: estimated 5–10 minutes (from current 2 minutes)
- Compilation: unchanged (Potential structure same, CDFs become
  PyTensor expressions instead of constants)

### Implementation status (19-Mar-26)

1. ~~Add `mu_XY`, `sigma_XY` as free variables per latency edge~~
   **Done.** `model.py` creates `pm.Normal(mu_lat_*)` and
   `pm.HalfNormal(sigma_lat_*)` for edges with `sigma > 0.01`.

2. ~~Update Potential emission: CDF becomes PyTensor expression~~
   **Done.** Window Potentials use edge-level latent CDF. Cohort
   Potentials use FW-composed path-level CDF via `pt_fw_chain()`
   in `completeness.py`. Gradients flow through to all upstream
   edge latencies. Verified by PyTensor ancestor traversal in
   `test_wiring.py`.

3. ~~Verify: harness with latent latency, check identifiability~~
   **Done.** Test harness: rhat=1.002, ess=2432, 0 divergences.
   registered→success mu moved from inflated 2.008 (broken
   edge-only CDF) to 1.537 (correct FW-composed path CDF).
   delegated→registered stable at 1.448.

4. ~~Update posterior extraction: report current-regime `(mu, sigma)`~~
   **Done.** `inference.py` reads real `mu_lat`/`sigma_lat` samples
   from the trace. Latency posteriors have `provenance: "bayesian"`,
   real `mu_sd`/`sigma_sd`, per-variable rhat/ESS.

5. Add time bins: `mu_t` random walk, bin assignment per Cohort day
   — **not yet scheduled** (Phase D step 3, see §10 design notes)

6. Verify: harness with binned latency, check drift detection
   — **not yet scheduled**

---

## 11. What this does NOT include (original scope)

- **Snapshot write path**: posteriors go to git/YAML via webhook, not DB
- **Snapshot topology invalidation**: separate concern (doc 10)
- **Batch inventory optimisation**: query row counts before fetching —
  defer unless upfront cost is prohibitive
- **Slice pooling**: Phase C. Phase S provides the data. Phase D
  (latent latency with temporal drift) is now proposed before Phase C.
- **Epoch segmentation**: chart-rendering machinery, not needed for
  Bayes. The worker queries raw rows directly.

---

## 12. Exit criteria

- [x] FE builds and sends `snapshot_subjects[]` in the Bayes submit
  payload, derived from the pinned DSL via existing fetch planning
  infrastructure
- [x] FE includes forecasting settings in the `settings` block
- [x] Worker queries snapshot DB per subject and receives rows
- [x] Evidence binder transforms snapshot rows into Cohort-first
  trajectory objects, both `window()` and `cohort()` observation types
- [x] Model emits `pm.Potential` per edge per observation type
  (not per-day `pm.Multinomial`), compiles in <3s (nutpie)
- [x] Window Potentials use `p_window`, cohort Potentials use `p_cohort`
  (verified by PyTensor graph traversal, `test_wiring.py`)
- [x] Latent latency: per-edge `mu_lat`/`sigma_lat` with edge-level CDF
  for window, FW-composed path-level CDF for cohort (verified by ancestor
  traversal — downstream cohort depends on upstream latency vars)
- [x] Posterior extraction reads real MCMC samples for both probability
  and latency (not echoed priors). Latency provenance = `bayesian`
- [x] Full pipeline produces posteriors from real snapshot data
  (rhat=1.002, ess=2432, 0 divergences)
- [x] Falls back to parameter file evidence when no snapshot data exists
- [x] No double-counting between snapshot and parameter file evidence
- [x] Priors still come from parameter files (warm-start path unchanged)
- [x] At least one real graph fitted with snapshot evidence via FE
  (test graph `bayes-test-gm-rebuild`, 4 edges, 2 latency edges)
- [x] Existing graphs without snapshot data continue to work (graceful
  fallback)
