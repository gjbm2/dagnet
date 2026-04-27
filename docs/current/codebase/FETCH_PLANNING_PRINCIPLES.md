# Fetch Planning: Correctness, Invariants, and Architecture

**Source**: `docs/current/fetch-planning-first-principles.md`
**Last reviewed**: 17-Mar-26

---

## 1. Core Principle

Fetch planning produces a set of fetch instructions that: (a) fills all missing data and (b) refreshes any data that is plausibly stale, for both `window()` and `cohort()` modes.

**Single-codepath contract**: planning (analysis), dry-run ("would call"), and live execution must derive from the **same plan**.

---

## 2. Definitions

### Query Intent

The combination of:
- **Mode**: `window()` vs `cohort()` (including cohort anchor semantics)
- **Requested range**: start/end in DSL terms
- **Slice family**: context semantics (e.g. `context(channel:paid-search)` vs implicit MECE)
- **Query spec**: connection, event mappings, filters, excludes, visited (represented by signature)

### Staleness

Data is stale when it was last retrieved sufficiently long ago that it may have changed due to:
- Latency (late-arriving conversions)
- Recency (recent days more likely to change than old ones)
- External changes (upstream data corrections)

### Coverage

A query intent is "covered" when the cache contains all anchor-days in the requested range with values that are not stale.

---

## 3. Planning Invariants

### I-1: Complete coverage

After planning, every anchor-day in the requested range must be either: (a) scheduled for fetch, or (b) covered by a non-stale cached value.

### I-2: No redundant fetches

The planner must not schedule a fetch for an anchor-day range already covered by non-stale cached data.

### I-3: Staleness is mode-aware

- **Window mode**: staleness is a function of how recently the data was retrieved and how close the anchor-day is to "today"
- **Cohort mode**: staleness additionally depends on cohort maturity (`path_t95`) — mature cohorts are stable

### I-4: Deterministic output

Given identical query intent, cache state, and reference date → identical fetch plan. No wall-clock coupling.

### I-5: Single source of truth for slice resolution

The planner must use the same slice resolution (MECE expansion, implicit uncontexted) as the execution path. No "planning sees different slices than execution".

---

## 4. Window Mode Planning

### Gap Analysis

For window mode, the planner:
1. Resolves the DSL date range to absolute dates
2. Checks cached values for each anchor-day in the range
3. Classifies each day as: missing, stale, or fresh
4. Builds fetch instructions for contiguous missing/stale ranges

### Staleness for Window Mode

A cached window value is stale if:
- `days_since_retrieval > staleness_threshold`
- Threshold depends on recency: recent days (close to today) need more frequent refresh; old days are stable

---

## 5. Cohort Mode Planning

### Horizon-Aware Planning

Cohort mode planning uses latency horizons (`t95`, `path_t95`) to determine maturity:
- **Mature cohorts** (age > path_t95): unlikely to change; can skip refetch
- **Immature cohorts** (age ≤ path_t95): actively accumulating late conversions; need refresh

### Coverage-Aware Start

The planner does NOT truncate the start of cohort windows based on horizons. It evaluates coverage and staleness across the full requested range, then schedules fetches only for dates that need it.

---

## 6. Context Semantics

### Contexted vs Uncontexted

When the query has context slices (e.g. `context(channel:google)`), the planner must check coverage **per slice**. Each slice can have independent staleness.

### MECE Implicit Uncontexted

When the query uses implicit uncontexted resolution (the system selects a MECE partition and sums), the planner must:
1. Resolve the MECE slice set using `meceSliceService`
2. Check coverage per slice in the set
3. Fetch any slice that is missing or stale

---

## 7. Key Source Locations

- `src/services/windowFetchPlannerService.ts` — window staleness, path_t95 lookup
- `src/services/cohortRetrievalHorizon.ts` — cohort maturity classification
- `src/services/fetchPlanBuilderService.ts` — `buildFetchPlan()` orchestration
- `src/services/fetchDataService.ts` — Stage-1 (per-item fetch) and Stage-2 (LAG enhancement)
- `src/services/meceSliceService.ts` — MECE slice resolution
- `src/services/sliceIsolation.ts` — `extractSliceDimensions()`

---

## 8. Testing Invariants

Tests should verify **end-state properties**, not replicate planning logic:
- "After plan execution, all anchor-days in range have non-stale values"
- "No fetched range overlaps with already-fresh cached data"
- "Plan output is identical for identical inputs"
- "Cohort plan does not fetch mature cohorts when cached values exist"
