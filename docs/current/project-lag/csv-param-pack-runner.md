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
- If `*_t95` / `*_path_t95` is supplied, it is treated as an **authoritative horizon value** for that edge.

## Input 2: Queries CSV

Required columns:

- `dsl` (e.g. `window(1-Jul-25:31-Jul-25)` or `cohort(1-Jul-25:31-Aug-25)`)
- `as_of_date` (ISO or UK; converted immediately)

The harness runs each query at an “as-of” time of **12:00 UTC** on `as_of_date` to avoid timezone edge cases.

## Critical nuance: how per-day `t95/path_t95` overrides apply

The daily CSV supplies optional horizon overrides (`*_t95`, `*_path_t95`) **per day**.

For this harness (a cohort-window sweep), we must map “per day” to “per query”. The mapping is:

- For each query DSL `cohort(<start>:<end>)`, the harness looks up the daily CSV row for the **cohort start date**.
- If that row has `ab_t95` / `ab_path_t95` / `bc_t95` / `bc_path_t95`, those values are applied as overrides for that query run.
- If that row is blank for a given override, that means **no override** for that query (the stats engine will derive/fall back as normal).

This avoids a common pitfall: taking the “first finite override in the file” would collapse alternating (value, blank, value, blank…) patterns into “always on”.

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

## Session summary (16-Dec-25): “steady state p.mean”, evidence Bayes correction, and harness correctness

This section records, in extreme detail, the work done in the most recent tuning/debugging session so we can:

- Lock in the “steady state” behaviour as a regression test
- Keep the harness aligned with production semantics
- Capture the remaining work (notably: move evidence adjustments into the `p.mean` blend and purify `p.evidence`)

### Goals (as stated during the session)

- **Stable inputs → broadly stable outputs** for `p.mean`, especially under extreme “steady state” sweeps.
- **Continuous, intuitive, inspectable behaviour**:
  - `p.evidence.mean` should be understandable as a signal and not exhibit spurious discontinuities.
  - Avoid artificial kinks caused solely by cohort window length shrinkage.
- **Correct percentile semantics** for horizons:
  - `path_t95` percentile was corrected to `0.95` (it had been incorrectly treated as `0.99`).
- **Centralise constants** into a single latency constants file (validated in this session).

### What code paths were exercised

The harness exercises production TS machinery (no Python analytics), specifically:

- File-backed parameter retrieval
- LAG/topological latency pass (`enhanceGraphLatencies(...)`)
- Param-pack extraction/flattening to CSV output

### Key finding: the harness was initially “non-production” (and misleading)

The early CSV curves that looked “mad” were largely explained by a critical mismatch:

- The daily CSV supplies `bc_k` / `bc_k_daily` as an **ultimate** conversion count per cohort day.
- Production evidence is **right-censored** by the as-of date (immature cohorts have observed conversions so far, not eventual).

#### Fix: production-like right-censoring of `k_daily` by `as_of_date`

The harness now emulates production “observed evidence so far” for cohort-mode by:

- For each query row (with an `as_of_date`):
  - Computing the cohort age at `as_of_date`
  - Subtracting the anchor lag (path anchoring) to get the effective “time since entering the edge”
  - Using the fitted lognormal CDF to compute an observed fraction
  - Setting `k_daily_observed = k_daily_ultimate * CDF(age_adjusted)`

This change was essential: without it, `p.evidence.mean` could stay high even when completeness is near zero, because the harness was using future information.

### The “alternating row” bug (and its two layers)

You deliberately alternated `*_t95` values (e.g. A–B `t95`) every other day in the daily CSV and observed:

1. **Bug #1**: output looked constant (as though the alternation had no effect).
2. **Bug #2**: even when values appeared in the param packs, there was no discernable impact on the latency distribution / completeness.

#### Root cause of Bug #1 (original harness behaviour)

The harness originally read per-day optional `t95/path_t95` columns using:

- “first finite value in the file” (`firstFinite(...)`)

That means a pattern like (40, blank, 40, blank, …) collapses into “always 40” for every query run.

#### Harness correction: per-query override selection from the cohort-start day

To align with “per parameter, per day” inputs in the daily CSV, the harness now maps overrides to each query run by:

- Parsing the cohort start date from the DSL `cohort(<start>:<end>)`
- Looking up the daily CSV row for that **start date**
- Applying `ab_t95/ab_path_t95/bc_t95/bc_path_t95` from that row as overrides for that query run

#### Remaining subtlety that kept Bug #1 alive (and the final fix)

Even after switching to “use the cohort-start row”, the harness still had a second collapsing behaviour:

- If the cohort-start row existed but had a blank override, it fell back to the global `firstFinite(...)`.

That again collapses (value, blank, value, blank…) patterns.

**Final fix** (implemented and validated):

- If the cohort-start row exists and the override cell is blank, that means **no override**.
- Global fallback is only used if a cohort-start row cannot be located at all.

This is now documented above under “Critical nuance”.

#### Proof that the alternation now works (sanity check)

With the current example daily CSV that alternates `ab_t95` and `bc_t95` on alternating days, the regenerated output now shows toggling:

- For cohort windows starting on dates where `ab_t95` is present, the output uses that override for A–B.
- For cohort windows starting on dates where `ab_t95` is blank, the output falls back to derived/fitted values (and does **not** “inherit” the previous day’s override).

### Why “no discernable difference” can still happen (Bug #2 framing)

Even when overrides are correctly applied, it can still be hard to “see” differences if you look at the wrong output:

- `latency.t95` in the output is often the **moment-fit t95** (computed from median/mean), not necessarily the override itself.
- The override’s primary effect can be via the **one-way tail constraint** on completeness (fatter tails → lower completeness for immature cohorts).
- If you want to see impact, you usually need to inspect:
  - `e.*.p.latency.completeness`
  - and/or whether the tail constraint was applied (debug fields; future enhancement could add these to the CSV output explicitly).

### `p.mean` stability work: baseline sample size, completeness, and “drift”

The session repeatedly returned to the core design principle:

- Forecast dominates when cohorts are immature; evidence dominates as cohorts mature.
- Under a steady state (stable underlying data), `p.mean` should not exhibit non-intuitive drift.

Two major instability drivers were addressed/confirmed:

- **Baseline sample size (`nBaseline`) stability**: prefer window-slice `n` as the backing data for forecast so weights don’t jump discontinuously.
- **Avoid hard gates** in evidence de-biasing that flip on/off and produce discontinuities.

### Evidence adjustment: current behaviour and tuning outcome

We ended with a pragmatic, inspectable approach:

- A **Bayesian completeness correction** applied to `p.evidence.mean` for cohort-path-anchored mode.
- A prior centred on `forecastMean` whose strength increases as completeness decreases.
- A “conservative completeness” mapping for evidence correction: `cEff = c^γ` with γ tuned; the current tuned value is **γ = 0.6**.

Important notes recorded in-code (for future refactor):

- This is **temporary evidence manipulation for inspectability**.
- We intend to move this logic into `p.mean` blending (so `p.evidence.mean` becomes pure observed k/n again).

### Debug flag rename and test lock-in

We renamed the debug flag from:

- `evidenceMeanDebiasedByCompleteness` → `evidenceMeanBayesAdjusted`

and updated the relevant production plumbing so logs/outputs reflect the new meaning.

We also updated tests to lock in the “steady state” acceptance criterion:

- In `cohortEvidenceDebiasing.e2e.test.ts`, the “steady inputs” case now:
  - Uses production-like right-censored `k` (rather than “ultimate” conversions)
  - Checks an acceptance envelope of **±10% around target** for `p.mean` under varying cohort completeness.

### Constants cleanup

- Removed an unused evidence-adjustment constant (`EVIDENCE_COMPLETENESS_ADJUST_MIN_COMPLETENESS`) and its dead comment block from `constants/latency.ts`.
- Current key constants used by the tuned Bayes evidence correction include:
  - `LATENCY_EPSILON`
  - `LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE` (currently 350)

### Remaining work (explicit TODOs)

1. **Move evidence adjustment out of `p.evidence` and into the `p.mean` blender**
   - Goal: restore `p.evidence.mean` to pure observed k/n for semantic clarity.
   - Keep the same adjustment logic but apply it only when computing `p.mean` (or compute an internal `evidenceAdjustedForBlend`).
   - The current evidence adjustment block is intentionally labelled as “TEMPORARY … port-to-blend later” to make this transfer straightforward.

2. **Expose “tail constraint applied?” and “authoritative t95 used” into CSV outputs**
   - Right now users infer these from `completeness` and the derived `t95/path_t95`.
   - Adding explicit debug columns would make it far easier to see whether a `t95` override is materially affecting the fitted/constraint distribution.

3. **Add a second canned example** designed to demonstrate `t95` override impact
   - Use a thin moment-fit (mean ≈ median) and then large `t95` overrides to force tail constraint changes.
   - Not required for the steady-state acceptance, but reduces future confusion.


