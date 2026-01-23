# Project DB: Initial Thinking (Directional Notes)

Date: 23-Jan-26

## What we’re trying to solve

DagNet currently persists slice evidence inside parameter YAML files under `values[]` (e.g. `dates[]`, `n_daily[]`, `k_daily[]`, and cohort-latency arrays). This is performant enough for the current “2D” use-cases, but it limits what we can do with time:

- **Cohort maturation analysis**: how a fixed cohort (e.g. 1-Nov) accumulates conversions over subsequent days and how that changes as we re-fetch.
- **Forecasting and backtesting**: fan charts, re-fitting latency tails, and seeing whether forecasts drift when latency drifts.
- **Richer latency modelling**: move beyond a single simplistic family and respond dynamically to temporal shifts.

The emerging architecture is: keep parameter files as the semantic index, and add a centrally hosted DB to store **append-only snapshot histories**.

## What we verified from the repo (no guessing)

From recorded Amplitude fixtures (e.g. `docs/current/project-lag/test-data/REFERENCE-axy-funnel-response.json`):

- Payloads are **daily series** (one row per cohort-entry day), not a cohort triangle.
  - 3-step A→X→Y cohort payloads have `dayFunnels.series` width 3.
  - The number of rows equals the cohort entry window length (e.g. 91 days in that fixture).
- The current persistence pipeline materialises those daily series into arrays in `values[]` and applies a **canonical “latest wins” merge by cohort day**.
  - This is great for “what is the current best view?”.
  - It does **not** preserve a history of successive snapshots.
- Data volumes per slice-window are not large (hundreds of numeric entries for ~30 days), so the core problem is **query shape and longitudinal access**, not raw storage capacity.

## Scale / data volumes (directional)

The important practical point from this discussion is that the snapshot datasets we are talking about are **small** in absolute terms, even at “daily snapshots × many slices”.

Key observed shape (from fixtures and current persistence):

- Cohort/window data is a **daily series**: roughly one row per day in the requested cohort/window range.
- For A→X→Y cohort slices, the per-day data we care about is essentially **three counts** (A, X, Y). (Optionally we may also keep per-day lag summary fields, but the core snapshot evidence is counts.)

Back-of-envelope (order-of-magnitude) example, consistent with the thread:

- Suppose a typical query window is ~30 days and we have on the order of ~12 contexts total, with both window+cohort => ~24 slices.
- Per daily snapshot, per param:
  - rows written ≈ 30 days × 24 slices = 720 rows
  - values per row ≈ A/X/Y counts (3 integers) => ~2,160 integers/day/param
  - even with generous overhead (SQL row overhead + indexes), this remains modest.

The bigger “weight” concern is not bytes; it’s whether we can keep:

- DB queries fast for “latest wins” and maturity/history views
- the repo’s offline/local experience intact (if we choose pointers-only vs shadow-write)

On the Git side: we corrected an earlier mis-framing. In the plan where parameter files remain as the index (one file per param) and we only add lightweight references (or we continue to store arrays but add DB shadow-write), Git write volume is not the driver; correctness and query ergonomics are.

## Key concepts (aligning terminology)

There are two “time axes” and we need both:u

- **`cohort_day`** (aka the x-axis day in `dates[]`)
  - In cohort mode: the **A-entry day** (cohort entry day).
  - In window mode: the **X-entry day** (from-step day).
- **`retrieved_at`** (aka snapshot time)
  - When the retrieval ran (typically daily).
  - This is what makes “snapshots” meaningful.

The app’s typical UX is “latest wins” indexed by `cohort_day`, but the analytical value comes from sometimes querying across `retrieved_at`.

## Directional DB shape: one big table (append-only snapshot facts)

We can model the DB as a single large table (or a small set of tables) with rows keyed by:

- `param_id`
- `slice_id` (or `slice_key`): stable identity for a specific contexted slice within a parameter
- `slice_signature`: semantic integrity boundary (existing notion; treated as a namespace)
- `slice_type`: `cohort` or `window`
- `cohort_day`
- `retrieved_at`

The “big table” approach is preferred over “one table per param” because schema evolution and operational overhead are much simpler, and indexing can be handled via composite indexes / partitioning.

## A→X→Y must be first-class (not just X→Y)

Our retrieval machinery is engineered to produce A→X→Y cohorts, and snapshot storage must preserve that evidence.

For each `(cohort_day, retrieved_at)` row (for a 3-step cohort slice) we want, at minimum:

- **A count** (anchor entrants for that cohort day)
- **X count** (from-step count)
- **Y count** (to-step count)

This supports:

- A→X maturity curves and derived histograms
- A→Y maturity curves and derived histograms

We should explicitly treat “derive X→Y lag distribution” as a separate topic. Snapshot differences of Y over time give A→Y timing directly; X→Y is not identical without further assumptions/adjustments.

## “Latest wins” and “snapshots” are both supported (different query modes)

This model supports two primary read patterns:

- **Default (“latest wins”)**
  - For each `(slice_signature, slice_id, cohort_day)`, select the row with max `retrieved_at`.
  - Aggregate across the applicable slice_ids for a param (MECE, contexts, etc.).
  - This reproduces the current “best available view” semantics.
- **Snapshot-aware / maturity**
  - Fix `(slice_signature, slice_id, cohort_day)` and query across `retrieved_at` to see maturation.
  - Or fix a `retrieved_at` (or “as of” date) and reconstruct how the whole cohort window looked then.

## Histograms without Amplitude bins: deriving bins from snapshot maturation

Amplitude bin histograms are limited (e.g. only the first ~10 days), so snapshot history is the way to build long-horizon empirical bins.

For a fixed cohort \(c\), define a cumulative conversions series \(Y(c, t)\) observed at snapshot time \(t\). Then daily lag bins can be approximated as:

\[
\Delta Y_a \approx Y(c, c+a) - Y(c, c+a-1)
\]

This is effectively a discrete PMF; its cumulative form is a CDF.

Important implications:

- We need **successive snapshots** (daily is good) to get stable bin estimates.
- We must handle real-world messiness:
  - non-monotone counts due to attribution drift, sampling, and provider-side changes
  - backfills and re-processing that change historical numbers
  - “maturity” not being a single scalar (different cohorts mature differently)

These issues don’t invalidate the approach; they just mean we should define a policy for negative deltas and stability checks.

## Interaction with Git persistence and offline usage

We considered two paths:

1) **Pointers-only (files are headers + DB references)**
   - Pros: reduces Git writes dramatically.
   - Cons: pushes a lot of existing “file-as-cache” behaviour (coverage, incremental fetch, aggregation) onto DB-backed reads; also weakens offline usage unless we add a local cache for DB data.

2) **Shadow-write DB while keeping current file `values[]` (recommended initial posture)**
   - Pros: preserves current offline-first behaviour (IndexedDB + file-resident arrays remain sufficient).
   - Pros: DB becomes an analytics/history store without being a hard runtime dependency.
   - Cons: you still write `values[]` into Git during normal interactive usage (but daily analytics runs can be online-only).

Given that analytics runs (and daily retrieve passes) are intrinsically online, shadow-writing is a low-risk first step.

## How this fits the current code architecture (directional)

We already have centralisation that makes this tractable:

- `fetchDataService` orchestrates fetch behaviour (single pipeline entrypoint).
- `dataOperationsService` is the natural service-layer boundary for source→file→graph semantics.
- `fileRegistry` is the local persistence layer (in-memory + IndexedDB).

Directionally, we add a dedicated DB adapter/service (e.g. `snapshotStoreService`) with:

- Write: append snapshot rows for each slice fetch
- Read: “latest wins” by `cohort_day` for a slice set
- Read: history across `retrieved_at` for maturity/histogram derivations

## Open areas requiring further exploration & evaluation

### DB product choice (low-management preference)

The preference stated in the discussion is:

- **avoid self-hosting and management overhead**
- data itself is not commercially sensitive in isolation (semantic index lives in private Git), so hosted managed services are acceptable
- volumes are modest

Candidate approaches (to evaluate):

- **Managed Postgres (default recommendation for simplicity)**
  - Pros: easiest operationally and conceptually; strong fit for “latest wins”, “as-of”, and maturity/history scans.
  - Pros: trivial to keep append-only + idempotent uniqueness constraints.
  - Cons: if maturity/history queries become very large and frequent, we may want columnar later.
  - Examples (vendor-agnostic list): hosted Postgres offerings (serverless or managed) on major clouds, plus Postgres-as-a-service providers.

- **Columnar managed analytics DB (e.g. ClickHouse Cloud, BigQuery)**
  - Pros: very strong for large aggregations and scanning history.
  - Pros: “latest wins” can be implemented efficiently (e.g. argMax-style patterns / windowing).
  - Cons: more conceptual overhead; might be overkill given expected volumes.

- **Object storage + Parquet + query engine (DuckDB/Trino/Athena-style)**
  - Pros: very low “DB ops”; cheap storage; good for big offline analysis.
  - Cons: you must manage compaction to avoid lots of tiny files; “latest wins” and idempotency are more fiddly than in a transactional DB.

Expected query mix:

- Frequent: “latest wins by cohort_day” for a slice set.
- Occasional but heavier: “maturity/history by retrieved_at” and derived histograms.

### Exact row schema and naming

- Clarify `param_id` vs `edge_id` vs “slot id” as the primary identity.
- Clarify `slice_id` / `slice_key` definition and its stability across edits.
- Confirm what constitutes `slice_signature` today and whether it is sufficient as a semantic namespace.

### Indexing and partitioning

- Composite indexes to support:
  - latest-wins per `(slice_signature, slice_id, cohort_day)`
  - maturity scans per `(slice_signature, slice_id, cohort_day)` over `retrieved_at`
  - as-of reconstruction (“max retrieved_at ≤ T”)
- Partitioning strategy (by time or by param) if the table grows.

### Snapshot integrity and idempotency

- Avoid accidental double-writes for the same `(slice_signature, slice_id, cohort_day, retrieved_at)`.
- Decide whether each daily run has an explicit run ID (recommended) vs using wall-clock `retrieved_at` only.

### Negative deltas and attribution drift

- Define an explicit policy:
  - clamp negative deltas to 0?
  - smooth across days?
  - treat drift as signal (and measure it), not noise?
- Decide what to do when mature totals change after the fact.

### Security and clients

- Even if data is not commercially sensitive in isolation, DB write access must be controlled.
- Decide whether DB access is:
  - analysis-server only (frontend never talks to DB), or
  - frontend reads some views directly.

### Relationship to derived models and YAML

- DB stores retrieved evidence/snapshots.
- Parameter files remain the home for derived/scalar values (forecasts, fitted params, curated metadata), and act as the index for which slices exist.


