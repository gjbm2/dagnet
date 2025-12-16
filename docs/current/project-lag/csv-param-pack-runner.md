# CSV Param-Pack Runner (TS stats “feel the data” harness)

This document describes the CSV-driven harness that runs **production TypeScript stats logic** over spreadsheet-editable inputs and emits a **wide param-pack CSV** for plotting and inspection.

## Purpose

We need a fast way to “feel the data” and validate how **completeness**, **tail constraint**, and **blending** behave over time without building a bespoke UI or doing the work in a spreadsheet.

This harness:

- Takes an **input CSV** describing daily \(n,k\) and lag stats for a small set of edges
- Takes a **queries CSV** describing `window(...)` / `cohort(...)` DSLs and an **as-of date**
- Runs the **real TS fetch pipeline** (`fetchItems`, `getParameterFromFile`, topo/LAG pass, UpdateManager)
- Writes a **wide output CSV** where columns are **param-pack keys**

## Where it lives

- Harness: `graph-editor/src/services/__tests__/paramPackCsvRunner.csvDriven.tool.test.ts`
- Example inputs:
  - Daily data: `param-registry/test/csv/reach-sweep-input.example.csv`
  - Queries: `param-registry/test/csv/reach-queries.example.csv`
- Example output (generated): `graph-editor/tmp/param-pack-output.example.csv`

## What code it exercises (production)

The harness uses production code paths, not a mocked maths implementation:

- **File-backed retrieval path**: `dataOperationsService.getParameterFromFile(...)`
- **Graph-level LAG/topological pass**: `fetchDataService.fetchItems(...) → enhanceGraphLatencies(...) → UpdateManager.applyBatchLAGValues(...)`
- **Param-pack generation**: `extractParamsFromGraph(...) → flattenParams(...)`

What it does *not* do:

- No Python analytics / GraphCompute
- No external HTTP calls
- No Amplitude adapter; the “data source” is the CSV → parameter-file shape in `FileRegistry`

## Input 1: Daily data CSV

### Required columns

- `date` (ISO `YYYY-MM-DD` or UK `d-MMM-yy`; converted immediately to ISO internally)
- `ab_n`, `ab_k`, `ab_median_lag_days`
- `bc_n`, `bc_k`, `bc_median_lag_days`

### Optional columns (blank = not supplied)

- `ab_mean_lag_days`, `bc_mean_lag_days`
- `ab_t95`, `ab_path_t95`, `bc_t95`, `bc_path_t95`

Notes:

- Blank rows / blank `date` are treated as “no data” and skipped.
- Optional numeric blanks remain **undefined** (they do not become zero).
- If `*_mean_lag_days` is blank, it defaults to the corresponding median lag for that day.
- If `*_t95` / `*_path_t95` is supplied, it is treated as an **authoritative horizon value** for that edge for the run.

## Input 2: Queries CSV

Required columns:

- `dsl` (e.g. `window(1-Jul-25:31-Jul-25)` or `cohort(1-Jul-25:31-Aug-25)`)
- `as_of_date` (ISO or UK; converted immediately)

The harness runs each query at an “as-of” time of **12:00 UTC** on `as_of_date` to avoid timezone edge cases.

## Output: Wide param-pack CSV

The output is a CSV with:

- `dsl`
- `as_of_date` (UK `d-MMM-yy`)
- One column per **param-pack key** (unioned across all query runs)

Missing values are emitted as `""` (an explicit empty string token) so that spreadsheet tooling that uses `SPLIT()` does not collapse columns.

## Running the harness

From `graph-editor/`:

```bash
DAGNET_CSV_RUN=1 \
DAGNET_CSV_DATA=../param-registry/test/csv/reach-sweep-input.example.csv \
DAGNET_CSV_QUERIES=../param-registry/test/csv/reach-queries.example.csv \
DAGNET_CSV_OUT=tmp/param-pack-output.example.csv \
npm test -- --run src/services/__tests__/paramPackCsvRunner.csvDriven.tool.test.ts
```

## Critical implementation details (gotchas)

### As-of time must freeze `new Date()`, not only `Date.now()`

The stats pipeline uses both `Date.now()` and `new Date()` internally. Overriding `Date.now()` alone is not sufficient in V8; `new Date()` can still use the real system clock. This will make cohort ages enormous and produce **nonsensically high completeness**.

The harness therefore uses `vi.useFakeTimers()` + `vi.setSystemTime(...)` per query row so *all* date reads are consistent.

### Override flags are permissions-only

For horizon fields (`t95`, `path_t95`), override flags must **only** gate overwrite permissions. They must not change semantic meaning (“is this value considered?”) inside the stats engine. If a horizon value is present on the graph, the maths must be able to consume it regardless of override flags.

## Typical usage loop

1. Edit the daily CSV and query CSV in Sheets/Excel.
2. Re-run the harness command.
3. Import the output CSV into your workbook (or reference it directly).
4. Plot columns like:
   - `e.A-B.p.latency.completeness`
   - `e.B-C.p.mean` vs `e.B-C.p.evidence.mean` / `e.B-C.p.forecast.mean`
   - Any derived reach proxy you compute in-sheet


