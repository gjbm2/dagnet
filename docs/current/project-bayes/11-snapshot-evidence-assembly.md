# Doc 11 — Phase S: Snapshot Evidence Assembly

**Status**: Design draft
**Date**: 18-Mar-26
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

## 5. Evidence binder changes

`evidence.py` currently has one evidence path: parse `values[]` from
parameter files. Phase S adds a second path: snapshot rows from the DB.

### New function: `bind_snapshot_evidence()`

```
bind_snapshot_evidence(
    topology: TopologyAnalysis,
    snapshot_rows: dict[str, list[dict]],  # edge_id → rows from DB
    param_files: dict[str, dict],          # fallback + prior source
    settings: dict,
    today: str,
) → BoundEvidence
```

For each edge in the topology:
1. Check if `snapshot_rows[edge_id]` has data
2. If yes: convert rows to `CohortObservation` / `WindowObservation`
   objects, classifying by `slice_key` prefix (`cohort(` vs `window(`)
3. If no: fall back to `param_files` (current `bind_evidence()` logic)
4. Prior resolution from param files — same as current (warm-start,
   moment-matched, or uninformative)
5. Latency prior derivation — from param file latency block or snapshot
   row lag summaries (whichever is richer)
6. Minimum-n gating, diagnostics — same as current

### Maturation trajectory → interval-censored Multinomial

The snapshot DB provides multiple retrievals of the same cohort day at
increasing ages. These are **cumulative** — later counts include earlier
converters. Treating them as independent Binomials would double-count.

The correct likelihood is a **Multinomial over retrieval intervals**
with **anchor entrants (`a`) as the fixed denominator** and the
**path-level probability** `p_path = ∏ p_edge` in the interval
probabilities. The retrieval ages partition each anchor entrant's
outcome into mutually exclusive intervals, and the interval counts
follow a Multinomial whose probabilities are `p_path · CDF_path`
differences. This jointly constrains the path probability and the CDF
shape.

Key design decisions:

- **Anchor-based denominator, not `x`**: the from-step count `x`
  changes between retrieval ages for downstream edges (upstream
  converters are still arriving). `a` is constant. Using `a` with
  `p_path` gives an exact Multinomial for all edges at any depth.
- **Path probability in the likelihood**: `p_path = p_AX · p_XY · ...`
  appears in each interval probability. This creates inter-edge
  coupling — the Y trajectory constrains upstream p's jointly. This
  coupling is correct (the trajectory IS evidence about upstream
  conversion) and handled naturally by NUTS.
- **`x` column not used in likelihood**: each edge uses only its own
  `y` column from its own snapshot rows. `x` becomes a diagnostic
  (model prediction vs observed), not likelihood data.
- **Degeneracy**: a single retrieval reduces to the existing per-day
  Binomial. A first-hop edge reduces to the single-edge form.

The full mathematical formulation, including edge cases (Δy < 0,
single retrieval degeneracy, non-latency edges, interaction with
the window/cohort hierarchy and branch groups) is specified in
**doc 6, Layer 3 § "Maturation trajectory likelihood (Phase S)"**.

The evidence binder produces `CohortDailyTrajectory` objects
(date, `a`, sorted retrieval ages, monotonised cumulative `y`,
path edge IDs). `build_model` emits `pm.Multinomial` per trajectory
day. Days with only one retrieval use the existing per-day Binomial.

### Window observations from snapshots

Window observations are simpler — no maturation effect. Use the latest
retrieval per `(anchor_day, slice_key)` for window-mode rows. The
snapshot DB may have multiple retrievals of the same window, but the
latest is authoritative.

---

## 6. Model impact

`model.py` gains a new likelihood emission path: the trajectory
Multinomial (doc 6, Layer 3 § "Maturation trajectory likelihood"). For
each cohort day with multiple retrieval ages, the model emits a
`pm.Multinomial` over retrieval intervals instead of a single
`pm.Binomial`. Days with only one retrieval continue to use the
existing Binomial path.

The effect: **direct CDF shape identification**. The trajectory
constrains `(mu, sigma)` through the pattern of when converters arrive
across intervals, not just through the age gradient across different
cohort days. This is the core value of querying the snapshot DB.

`inference.py` is unchanged — the Multinomial is a standard PyMC
distribution and ArviZ diagnostics handle it automatically.

---

## 7. Test strategy

### Unit tests (evidence binder)

- Snapshot rows for a solo edge produce the expected CohortDailyObs
  (correct age and completeness per row)
- Fallback to parameter files when no snapshot data exists
- No double-counting: edge with both snapshot rows and param file
  values[] uses snapshot only
- Window observations use latest retrieval only
- Slice keys correctly partition snapshot rows
- Priors still come from parameter files regardless of snapshot source

### Integration tests (parameter recovery)

- Same synthetic graph topologies as Phase A/B tests
- Synthetic snapshot rows generated from known ground truth (per-day
  observations with completeness-censored k)
- Recovery should be at least as good as Phase A/B tests
- Key test: immature cohort recovery (A4 analogue) with richer daily
  granularity

### DB integration test (requires Neon access)

- End-to-end: real graph, real DB query via
  `query_snapshots_for_sweep()`, compiler pipeline, verify posteriors
- Manual validation step, not CI

---

## 8. Implementation steps

### Step 1: FE settings in payload

Update `useBayesTrigger.ts` to include forecasting settings:
- Call `forecastingSettingsService.getForecastingModelSettings()`
- Merge into `settings` block alongside existing `placeholder` flag

Small change, no new infrastructure. Can be done immediately.

### Step 2: Register `bayes_fit` analysis type contract

Add entry to `analysisTypes.ts` with `scopeRule: 'all_graph_parameters'`
and `readMode: 'cohort_maturity'`. This is a type registration only —
no chart rendering, no UI. Enables reuse of
`mapFetchPlanToSnapshotSubjects()`.

Assess whether `mapFetchPlanToSnapshotSubjects()` needs generalisation
to skip epoch segmentation for the `bayes_fit` contract. If the epoch
logic is tightly coupled, extract the core hash/slice/bounds resolution
into a shared helper that both the epoch path and the Bayes path can
call.

### Step 3: FE snapshot subject building

Update `useBayesTrigger.ts`:
1. Read `dataInterestsDSL` from graph
2. Build fetch plan via `buildFetchPlanProduction()` with pinned DSL
3. Map to subjects via `mapFetchPlanToSnapshotSubjects()` with
   `analysisType: 'bayes_fit'`
4. Attach `snapshot_subjects[]` to payload

### Step 4: Worker DB query

Update `worker.py` `_fit_graph_compiler()`:
1. Extract `snapshot_subjects[]` from payload
2. For each subject: call `snapshot_service.query_snapshots_for_sweep()`
3. Group resulting rows by `edge_id`
4. Pass grouped rows to the evidence binder

**Modal image dependency**: `snapshot_service.py` lives in
`graph-editor/lib/` alongside its dependencies (`graph_types.py`,
`query_dsl.py`, etc.). The Modal image (`bayes/app.py`) currently
uploads only `bayes/` to `/root/bayes`. Phase S must add a second
`.add_local_dir()` for `graph-editor/lib/` and extend PYTHONPATH so
`snapshot_service` and dependencies are importable:

```python
worker_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(...)
    .env({"PYTHONPATH": "/root/bayes:/root/lib"})
    .add_local_dir("bayes/", remote_path="/root/bayes", ...)
    .add_local_dir("graph-editor/lib/", remote_path="/root/lib", ...)
)
```

This follows doc 3 §5's design ("the MCMC worker is a new entry point
that imports from the same `lib/`"). No code changes to
`snapshot_service.py` — it already uses `psycopg2` and takes a
connection string.

### Step 5: Evidence binder snapshot path

New `bind_snapshot_evidence()` in `evidence.py`:
- Convert snapshot rows to `CohortObservation` / `WindowObservation`
- Fall back to param files per-edge
- Priors from param files regardless

### Step 6: Wire it together

Worker calls `bind_snapshot_evidence()` when `snapshot_subjects` are
present, else falls back to `bind_evidence()` (current param-file path).

### Step 7: Tests

- Synthetic snapshot row generators
- Phase S parameter recovery tests
- Verify fallback works (no snapshot data → param file behaviour)

### Step 8: Real graph validation

Run on `bayes-test-gm-rebuild` with actual DB access. Compare posteriors
against Phase A/B param-file-only baseline.

---

## 9. What this does NOT include

- **Snapshot write path**: posteriors go to git/YAML via webhook, not DB
- **Snapshot topology invalidation**: separate concern (doc 10)
- **Batch inventory optimisation**: query row counts before fetching —
  defer unless upfront cost is prohibitive
- **Slice pooling**: Phase C. Phase S provides the data.
- **Latent latency**: Phase D. Phase S provides richer evidence for the
  fixed-latency completeness coupling.
- **Epoch segmentation**: chart-rendering machinery, not needed for
  Bayes. The worker queries raw rows directly.

---

## 10. Exit criteria

- FE builds and sends `snapshot_subjects[]` in the Bayes submit payload,
  derived from the pinned DSL via existing fetch planning infrastructure
- FE includes forecasting settings in the `settings` block
- Worker queries snapshot DB per subject and receives rows
- Evidence binder converts snapshot rows to likelihood terms
- Falls back to parameter file evidence when no snapshot data exists
- No double-counting between snapshot and parameter file evidence
- Priors still come from parameter files (warm-start path unchanged)
- At least one real graph fitted with snapshot evidence
- Existing graphs without snapshot data continue to work (graceful
  fallback)
