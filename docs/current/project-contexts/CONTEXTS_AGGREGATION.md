# Contexts: Window Aggregation Logic

**Part of**: Contexts v1 implementation  
**See also**: 
- `CONTEXTS_ARCHITECTURE.md` — Core data model and terminology
- `CONTEXTS_REGISTRY.md` — MECE detection and otherPolicy
- `CONTEXTS_ADAPTERS.md` — Data fetching and adapter integration

---

## Overview

This document defines the window aggregation algorithms for contexts, including:
- The 2D grid model (context × date)
- Data lookup pattern (MANDATORY for all operations)
- Daily grid aggregation algorithm
- MECE aggregation across context keys
- Source policy (daily vs non-daily)
- Subquery generation and batching
- Performance considerations

---

## Data Lookup Pattern (MANDATORY)

**Every aggregation/fetch function must follow this pattern**:

```typescript
function aggregateOrFetch(
  paramFile: Parameter,
  query: { sliceDSL: string; window: DateRange },
  ...
): Result {
  // STEP 1: Isolate slice by PRIMARY KEY (sliceDSL)
  const targetSlice = normalizeSliceDSL(query.sliceDSL);
  const sliceValues = paramFile.values.filter(v => v.sliceDSL === targetSlice);
  
  // STEP 2: (Optional) Check integrity if needed
  if (query.signature && sliceValues.some(v => v.query_signature !== query.signature)) {
    warn('Query configuration changed; data may be stale');
  }
  
  // STEP 3: Operate ONLY on sliceValues
  const dates = extractDates(sliceValues);
  const missing = findMissingDates(query.window, dates);
  // ... rest of logic
}
```

**Violations of this pattern will cause data corruption.**

**Critical assertions**:
- If `values` contains contexts data but no `targetSlice` specified → error
- Never aggregate across different slices
- Always filter by `sliceDSL` before any other logic

---

## The 2D Grid: Context × Date

**Core model**: Each context combination paired with each date represents a **cell** in a 2-dimensional grid.

- **X-axis (Context)**: Context combinations (e.g., `{channel: google}`, `{channel: meta, browser-type: chrome}`, or uncontexted `{}`).
- **Y-axis (Date)**: Daily buckets (d-MMM-yy format, or coarser buckets for non-daily sources).

A user query `context(...) + window(start:end)` selects a **rectangle** in this grid:
- **Horizontally**: One or more context combinations.
- **Vertically**: A date range.

Our aggregation logic must:
1. **Reuse** any existing cells in the rectangle (from prior queries).
2. **Generate subqueries only for missing cells** (per-context, per-date-range gaps).
3. **Aggregate** over the filled rectangle to produce the final result.

### Window Overlap Scenarios (Daily Grid Model)

With the daily grid model, temporal overlap is handled at the day level:

| # | Scenario | How Daily Grid Handles It |
|---|----------|----------------------------|
| 1 | Exact date window + exact context match | Collect existing daily points for that context; if full coverage, aggregate directly |
| 2 | Query window larger than stored window | Existing days are reused; missing days trigger incremental fetch for those specific dates |
| 3 | Query window smaller than stored window | Filter existing daily series to the requested subset of dates; no new fetch needed |
| 4 | Query window partially overlaps stored window | Reuse overlapping days; fetch non-overlapping days |
| 5 | Multiple stored windows with overlapping dates for same context | De-duplicate by date key; policy: latest write wins (or error if conflict detected) |
| 6 | Query has no context constraint, data has MECE partition | Aggregate across all context values (MECE check); per-context daily series are summed independently, then combined |
| 7 | Query has context constraint, data has finer partition (e.g., query=channel:google, data=channel:google+browser:chrome/safari) | Aggregate across browser dimension (MECE check on browser), summing daily series within each day |

**Key insight**: The "partial overlap (ambiguous)" scenarios disappear when we work at day-level granularity. Overlapping windows just mean "some days appear in multiple slices," which we resolve via de-duplication by date key.

### Key Test Cases

**Test Case: Mixed MECE Keys** (validates most complex edge case)

```typescript
// Setup: Have both MECE and non-MECE keys
const windows = [
  { sliceDSL: 'context(browser-type:chrome)', n_daily: [100], k_daily: [20], dates: ['1-Jan-25'] },
  { sliceDSL: 'context(browser-type:safari)', n_daily: [80], k_daily: [12], dates: ['1-Jan-25'] },
  { sliceDSL: 'context(channel:google)', n_daily: [50], k_daily: [8], dates: ['1-Jan-25'] }
];

// Registry: browser-type otherPolicy='null' (MECE), channel otherPolicy='undefined' (not MECE)
// Query: uncontexted (no context constraint)

// Expected: n=180 (chrome + safari only, channel ignored)
// NOT: n=230 (would incorrectly include channel)
```

**Test Case: Slice Isolation**

```typescript
// Setup: Multiple slices with same query_signature
const values = [
  { sliceDSL: 'context(channel:google)', dates: ['1-Jan-25', '2-Jan-25'], query_signature: 'abc' },
  { sliceDSL: 'context(channel:meta)', dates: ['2-Jan-25', '3-Jan-25'], query_signature: 'abc' }
];

// Query: channel:google, window 1-Jan to 3-Jan
// Expected missing dates: ['3-Jan-25'] only (not ['1-Jan-25'] from meta slice)
```

---

## Source Policy: Daily vs Non-Daily

### Daily-Capable Sources (e.g., Amplitude)

For sources that return daily time-series:

- Always query for **daily buckets** (`n_daily`, `k_daily`, `dates` arrays).
- Store these in the var file per `(context combination)` slice.
- Any new window query is answered by:
  - Collecting all existing daily points for that context over the requested range.
  - Using **incremental fetch** (extend existing `calculateIncrementalFetch`) to fill in missing days only.
  - Aggregating over the requested date subset.

**Key benefit**: Arbitrary window queries (any `start:end`) are handled **without requiring "exact window match"**—we simply sum the appropriate per-day cells.

### Non-Daily Sources (Pure Aggregates)

For sources that only return coarse aggregates (e.g., certain Sheets backends or summary-only APIs):

- **If the backend supports arbitrary windows**:
  - Re-query for the exact requested `window(start:end)`.
  - Store that as a window with `sliceDSL` encoding both context and window.

- **If the backend only provides fixed, coarse windows**:
  - For sub-window queries: apply a **pro-rata policy**:
    - Compute fraction of overlap between the coarse window and the requested window (by time duration).
    - Scale `n` and `k` by that fraction.
    - Mark result as `status: 'prorated'` with a warning.
  - **Rationale**: No finer-grained data exists; pro-rating is the best available approximation.

**Default assumption**: Most Amplitude-like sources are daily-capable. Pro-rata is a documented fallback for exceptional cases.

---

## Daily Grid Aggregation: Step-by-Step

**Extending existing `windowAggregationService` and `calculateIncrementalFetch` logic.**

### Step 1: Determine Context Combinations

Given `QueryRequest { variable, constraints }`:

```typescript
function determineContextCombinations(constraints: ParsedConstraints): ContextCombination[] {
  const combos: ContextCombination[] = [];
  
  // If query has explicit context constraints
  if (constraints.contexts.length > 0 || constraints.contextAnys.length > 0) {
    // Build combinations from constraints
    // For simplicity in v1: contexts are AND, contextAnys are OR within key
    // Example: context(channel:google).context(browser:chrome) → [{channel: google, browser-type: chrome}]
    combos.push(buildContextComboFromConstraints(constraints));
  } else {
    // No explicit contexts: check if we need to aggregate across a MECE partition
    // This is determined by what's in dataInterestsDSL and what windows exist
    // For v1: if no context constraint, assume uncontexted ({})
    combos.push({});
  }
  
  return combos;
}
```

For **MECE aggregation** (query omits a key that data has): we handle this separately after collecting per-context results (see Step 5).

### Step 2: Per-Context Daily Coverage Check

For each context combination \(c ∈ C\):

```typescript
function getExistingDatesForContext(
  variable: Variable,
  contextCombo: ContextCombination
): Set<string> {
  
  const existingDates = new Set<string>();
  
  // Find all windows matching this context
  for (const window of variable.windows || []) {
    const parsed = parseConstraintString(window.sliceDSL || '');
    
    // Check if context part matches
    if (!contextMatches(parsed.contexts, contextCombo)) {
      continue;
    }
    
    // Extract dates from this window's time series
    if (window.dates && Array.isArray(window.dates)) {
      for (const date of window.dates) {
        existingDates.add(normalizeDate(date));
      }
    }
  }
  
  return existingDates;
}

function contextMatches(
  windowContexts: Array<{key: string; value: string}>,
  queryCombo: ContextCombination
): boolean {
  // Check if windowContexts is exactly queryCombo (order-insensitive)
  const windowSet = new Set(windowContexts.map(c => `${c.key}:${c.value}`));
  const querySet = new Set(Object.entries(queryCombo).map(([k, v]) => `${k}:${v}`));
  
  if (windowSet.size !== querySet.size) return false;
  for (const item of querySet) {
    if (!windowSet.has(item)) return false;
  }
  return true;
}
```

**This extends existing `calculateIncrementalFetch`**, which currently scans across all values in a param file; we now **scope it per context combination** by filtering on `sliceDSL` context match.

### Step 3: Generate Subqueries for Missing Daily Cells

For each `c ∈ C`:

```typescript
function generateMissingSubqueries(
  variable: Variable,
  contextCombo: ContextCombination,
  requestedWindow: DateRange
): SubQuerySpec[] {
  
  const existingDates = getExistingDatesForContext(variable, contextCombo);
  
  // Generate all dates in requested window (reuse existing logic)
  const allDatesInWindow = generateDateRange(requestedWindow.start, requestedWindow.end);
  
  // Find missing dates
  const missingDates = allDatesInWindow.filter(d => !existingDates.has(d));
  
  if (missingDates.length === 0) {
    return []; // No fetch needed for this context
  }
  
  // Group into contiguous date ranges (existing logic from calculateIncrementalFetch)
  const fetchWindows = groupIntoContiguousRanges(missingDates);
  
  // Build one SubQuerySpec per fetch window
  return fetchWindows.map(fw => ({
    variable,
    constraints: {
      visited: [],
      visitedAny: [],
      exclude: [],
      cases: [],
      contexts: Object.entries(contextCombo).map(([k, v]) => ({ key: k, value: v })),
      contextAnys: [],
      window: fw,
    },
  }));
}
```

**Key integration**: This uses the existing `calculateIncrementalFetch` pattern but **per context combination**, and returns a structured `SubQuerySpec[]` that the DAS executor can batch.

### Step 4: Execute Subqueries and Merge Results

```typescript
async function executeMissingSubqueries(
  subqueries: SubQuerySpec[],
  variable: Variable
): Promise<void> {
  
  for (const sq of subqueries) {
    // Build Amplitude query with context filters
    const amplitudeQuery = amplitudeAdapter.buildQuery(variable, sq.constraints);
    
    // Execute (returns daily buckets)
    const result = await amplitudeAdapter.executeQuery(amplitudeQuery);
    // result: { n_daily: number[], k_daily: number[], dates: string[] }
    
    // Merge into variable's time series for this context
    mergeTimeSeriesForContext(variable, sq.constraints.contexts, result);
  }
}

function mergeTimeSeriesForContext(
  variable: Variable,
  contextConstraints: ContextConstraint[],
  newData: { n_daily: number[]; k_daily: number[]; dates: string[] }
): void {
  
  // Find or create the window for this context
  const contextCombo = Object.fromEntries(contextConstraints.map(c => [c.key, c.value]));
  const sliceContextPart = buildContextDSL(contextConstraints);
  
  let targetWindow = variable.windows?.find(w => {
    const parsed = parseConstraintString(w.sliceDSL || '');
    return contextMatches(parsed.contexts, contextCombo);
  });
  
  if (!targetWindow) {
    // Create new window for this context
    targetWindow = {
      n_daily: [],
      k_daily: [],
      dates: [],
      sliceDSL: sliceContextPart,  // No window part; this is the "all dates" slice for this context
    };
    variable.windows = variable.windows || [];
    variable.windows.push(targetWindow);
  }
  
  // Merge new daily data (extend existing mergeTimeSeriesIntoParameter logic)
  mergeTimeSeriesIntoParameter(targetWindow, newData.n_daily, newData.k_daily, newData.dates);
}
```

**Reuses existing**: `mergeTimeSeriesIntoParameter` from `windowAggregationService` (which already de-duplicates by date and handles gaps).

### Step 5: Aggregate Over the Filled Rectangle

After all subqueries are executed and merged:

```typescript
async function aggregateWindowsWithContexts(
  variable: Variable,
  constraints: ParsedConstraints
): Promise<AggregationResult> {
  
  // Determine context combinations
  const contextCombos = determineContextCombinations(constraints);
  
  // For each context, ensure we have daily coverage
  const subqueries: SubQuerySpec[] = [];
  for (const combo of contextCombos) {
    const missing = generateMissingSubqueries(variable, combo, constraints.window!);
    subqueries.push(...missing);
  }
  
  // Execute any missing subqueries
  if (subqueries.length > 0) {
    await executeMissingSubqueries(subqueries, variable);
  }
  
  // Now aggregate per context over the requested window
  const perContextResults: Array<{ n: number; k: number; contextCombo: ContextCombination }> = [];
  
  for (const combo of contextCombos) {
    // Get all daily data for this context
    const timeSeries = getTimeSeriesForContext(variable, combo);
    
    // Filter to requested window and aggregate (reuse existing aggregateWindow)
    const windowResult = aggregateWindow(timeSeries, constraints.window!);
    
    perContextResults.push({
      n: windowResult.n,
      k: windowResult.k,
      contextCombo: combo,
    });
  }
  
  // If query has no context constraints, check if we can/should aggregate across contexts
  if (constraints.contexts.length === 0 && constraints.contextAnys.length === 0) {
    return tryMECEAggregationAcrossContexts(perContextResults, variable);
  }
  
  // Otherwise, return the specific context result(s)
  if (perContextResults.length === 1) {
    const result = perContextResults[0];
    const mean = result.n > 0 ? result.k / result.n : 0;
    const stdev = calculateStdev(result.n, result.k);
    
    return {
      status: 'exact_match',
      data: { n: result.n, k: result.k, mean, stdev },
      usedWindows: [],  // TBD: track which windows contributed
      warnings: [],
    };
  }
  
  // Multiple context combos but query was specific → shouldn't happen
  throw new Error('Query resulted in multiple context combinations; logic error');
}
```

---

## MECE Aggregation Across Context Keys

**Try to aggregate across a MECE partition when query has no context constraints.**

**CRITICAL EDGE CASE**: When we have windows for multiple keys (e.g., browser-type AND channel), we can only aggregate across MECE keys. Non-MECE keys are ignored.

**Example**:
- Windows: browser-type:chrome, browser-type:safari, browser-type:firefox (MECE, otherPolicy:null)
- Also: channel:google, channel:meta (NOT MECE, otherPolicy:undefined, missing others)
- Query: uncontexted (no context constraint)
- Result: Aggregate across browser-type (ignore channel slices)

```typescript
function tryMECEAggregationAcrossContexts(
  perContextResults: Array<{ n: number; k: number; contextCombo: ContextCombination }>,
  variable: Variable
): AggregationResult {
  
  // Group results by "which single key they vary on"
  // Exclude uncontexted results and multi-key results
  const singleKeyGroups = groupResultsBySingleContextKey(perContextResults);
  
  // For each key group, check if it's MECE and can aggregate
  const aggregatableCandidates: Array<{
    key: string;
    results: typeof perContextResults;
    meceCheck: ReturnType<typeof detectMECEPartition>;
  }> = [];
  
  for (const [key, results] of Object.entries(singleKeyGroups)) {
    // Build mock windows for MECE check
    const mockWindows = results.map(r => ({
      sliceDSL: Object.entries(r.contextCombo).map(([k, v]) => `context(${k}:${v})`).join('.')
    }));
    
    const meceCheck = detectMECEPartition(mockWindows, key, contextRegistry);
    
    // Can we aggregate across this key?
    if (meceCheck.canAggregate) {
      aggregatableCandidates.push({ key, results, meceCheck });
    }
  }
  
  // If exactly one MECE key found, aggregate across it
  if (aggregatableCandidates.length === 1) {
    const { key, results, meceCheck } = aggregatableCandidates[0];
    
    if (meceCheck.isComplete) {
      // Complete MECE partition
      const totalN = results.reduce((sum, r) => sum + r.n, 0);
      const totalK = results.reduce((sum, r) => sum + r.k, 0);
      const mean = totalN > 0 ? totalK / totalN : 0;
      const stdev = calculateStdev(totalN, totalK);
      
      return {
        status: 'mece_aggregation',
        data: { n: totalN, k: totalK, mean, stdev },
        usedWindows: [],
        warnings: [`Aggregated across MECE partition of '${key}' (complete coverage)`],
      };
    } else {
      // Incomplete MECE partition (partial data)
      const totalN = results.reduce((sum, r) => sum + r.n, 0);
      const totalK = results.reduce((sum, r) => sum + r.k, 0);
      const mean = totalN > 0 ? totalK / totalN : 0;
      const stdev = calculateStdev(totalN, totalK);
      
      return {
        status: 'partial_data',
        data: { n: totalN, k: totalK, mean, stdev },
        usedWindows: [],
        warnings: [
          `Partial MECE aggregation across '${key}': missing ${meceCheck.missingValues.join(', ')}`,
          'Result represents subset of data; fetch missing values for complete picture'
        ],
      };
    }
  }
  
  // If multiple MECE keys available (e.g., both browser-type and device-type are MECE)
  // Pick the first complete one; they should give same total (different partitions of same space)
  if (aggregatableCandidates.length > 1) {
    // Prefer complete partitions over incomplete
    const completeCandidate = aggregatableCandidates.find(c => c.meceCheck.isComplete);
    const chosen = completeCandidate || aggregatableCandidates[0];
    
    const totalN = chosen.results.reduce((sum, r) => sum + r.n, 0);
    const totalK = chosen.results.reduce((sum, r) => sum + r.k, 0);
    const mean = totalN > 0 ? totalK / totalN : 0;
    const stdev = calculateStdev(totalN, totalK);
    
    const otherKeys = aggregatableCandidates
      .filter(c => c.key !== chosen.key)
      .map(c => c.key)
      .join(', ');
    
    return {
      status: 'mece_aggregation',
      data: { n: totalN, k: totalK, mean, stdev },
      usedWindows: [],
      warnings: [
        `Aggregated across MECE partition of '${chosen.key}'`,
        `Note: Also have MECE keys {${otherKeys}} (would give same total if complete)`
      ],
    };
  }
  
  // No aggregatable MECE keys found
  // Check if we have uncontexted data (no contextCombo at all)
  const uncontextedResult = perContextResults.find(r => Object.keys(r.contextCombo).length === 0);
  if (uncontextedResult) {
    const mean = uncontextedResult.n > 0 ? uncontextedResult.k / uncontextedResult.n : 0;
    const stdev = calculateStdev(uncontextedResult.n, uncontextedResult.k);
    
    return {
      status: 'complete',
      data: { n: uncontextedResult.n, k: uncontextedResult.k, mean, stdev },
      usedWindows: [],
      warnings: [],
    };
  }
  
  // No MECE partition and no uncontexted data:
  // We STILL aggregate across whatever slices we have, but must clearly mark as PARTIAL.
  const totalN = perContextResults.reduce((sum, r) => sum + r.n, 0);
  const totalK = perContextResults.reduce((sum, r) => sum + r.k, 0);
  const mean = totalN > 0 ? totalK / totalN : 0;
  const stdev = calculateStdev(totalN, totalK);
  
  return {
    status: 'partial_data',
    data: { n: totalN, k: totalK, mean, stdev },
    usedWindows: [],
    warnings: [
      'Aggregated across NON-MECE context slices; result represents only a subset of total space',
      'If you intended a complete total, add a context constraint or ensure MECE configuration'
    ],
  };
}

/**
 * Group results by single context key.
 * Returns only results that have exactly ONE key in their contextCombo.
 */
function groupResultsBySingleContextKey(
  results: Array<{ n: number; k: number; contextCombo: ContextCombination }>
): Record<string, typeof results> {
  
  const groups: Record<string, typeof results> = {};
  
  for (const result of results) {
    const keys = Object.keys(result.contextCombo);
    
    // Only group if exactly one context key
    if (keys.length === 1) {
      const key = keys[0];
      if (!groups[key]) groups[key] = [];
      groups[key].push(result);
    }
  }
  
  return groups;
}
```

---

## Subquery Batching & Execution Strategy

When `aggregateWindowsWithContexts` identifies missing cells in the (context × date) grid, it generates **SubQuerySpec** objects representing exactly the (context, date-range) pairs we need to fetch.

### Batching Strategy

```typescript
interface SubQuerySpec {
  variable: Variable;
  contextCombo: ContextCombination;  // e.g. {channel: 'google', browser-type: 'chrome'}
  dateRange: DateRange;              // Missing dates to fetch
}

/**
 * Batch subqueries by context to minimize API calls.
 * 
 * Example: If we need to fetch:
 *   - context(channel:google) for dates [1-Jan, 2-Jan, 5-Jan, 6-Jan]
 * We group into contiguous ranges:
 *   - SubQuery 1: context(channel:google).window(1-Jan:2-Jan)
 *   - SubQuery 2: context(channel:google).window(5-Jan:6-Jan)
 */
function batchSubqueries(specs: SubQuerySpec[]): SubQuerySpec[] {
  // Already batched by generateMissingSubqueries (contiguous date ranges per context)
  // For v1: execute as-is; future optimization could further batch across contexts
  return specs;
}

/**
 * Execute all missing subqueries and merge results into variable.
 * EXTENDS: Existing DAS query execution (compositeQueryExecutor, DASRunner)
 */
async function executeMissingSubqueries(
  subqueries: SubQuerySpec[],
  variable: Variable
): Promise<void> {
  
  console.log(`[executeMissingSubqueries] Executing ${subqueries.length} subqueries`);
  
  // Execute all subqueries in parallel (or batched, depending on rate limits)
  const results = await Promise.all(
    subqueries.map(sq => executeSingleSubquery(sq))
  );
  
  // Merge each result into variable
  for (let i = 0; i < results.length; i++) {
    const sq = subqueries[i];
    const result = results[i];
    
    await mergeTimeSeriesForContext(variable, sq.contextCombo, result);
  }
}

async function executeSingleSubquery(
  spec: SubQuerySpec
): Promise<{ n_daily: number[]; k_daily: number[]; dates: string[] }> {
  
  // Build constraints from spec
  const constraints: ParsedConstraints = {
    visited: [],
    visitedAny: [],
    exclude: [],
    cases: [],
    contexts: Object.entries(spec.contextCombo).map(([k, v]) => ({ key: k, value: v })),
    contextAnys: [],
    window: spec.dateRange,
  };
  
  // Build Amplitude query (with context filters from registry mappings)
  const amplitudeQuery = amplitudeAdapter.buildQuery(spec.variable, constraints);
  
  // Execute via existing DASRunner
  const result = await DASRunner.execute(connectionName, amplitudeQuery);
  
  if (!result.success) {
    throw new Error(`Subquery failed: ${result.error}`);
  }
  
  // Extract daily data from result
  // Amplitude returns: { from_count, to_count, time_series: [{date, n, k, p}] }
  const timeSeries = result.raw.time_series || [];
  
  const n_daily = timeSeries.map((point: any) => point.n || 0);
  const k_daily = timeSeries.map((point: any) => point.k || 0);
  const dates = timeSeries.map((point: any) => normalizeDate(point.date));
  
  return { n_daily, k_daily, dates };
}
```

### Merge Strategy

```typescript
/**
 * Merge new daily time series for a context into the appropriate window.
 * EXTENDS: mergeTimeSeriesIntoParameter from windowAggregationService
 */
async function mergeTimeSeriesForContext(
  variable: Variable,
  contextCombo: ContextCombination,
  newData: { n_daily: number[]; k_daily: number[]; dates: string[] }
): Promise<void> {
  
  // Find existing window for this context (context part only, no window constraint)
  let targetWindow = variable.windows?.find(w => {
    if (!w.sliceDSL) return false;
    
    const parsed = parseConstraintString(w.sliceDSL);
    
    // Match context, ignore any window(...) term in sliceDSL
    return contextMatches(parsed.contexts, contextCombo);
  });
  
  if (!targetWindow) {
    // Create new window for this context
    const sliceContextPart = buildContextDSL(contextCombo);
    
    targetWindow = {
      n_daily: [],
      k_daily: [],
      dates: [],
      sliceDSL: sliceContextPart,  // Context only; no window(...) term
    };
    
    variable.windows = variable.windows || [];
    variable.windows.push(targetWindow);
  }
  
  // Merge new daily data using existing utility
  // REUSES: mergeTimeSeriesIntoParameter from windowAggregationService.ts
  mergeTimeSeriesIntoParameter(
    targetWindow,
    newData.n_daily,
    newData.k_daily,
    newData.dates
  );
}

function buildContextDSL(contextCombo: ContextCombination): string {
  if (Object.keys(contextCombo).length === 0) {
    return '';  // Uncontexted
  }
  
  // Build context(...) clauses, alphabetically by key
  const sorted = Object.entries(contextCombo).sort(([a], [b]) => a.localeCompare(b));
  return sorted.map(([key, value]) => `context(${key}:${value})`).join('.');
}
```

**Key points**:
- Each `(context combination)` has **at most one window** on the var, which accumulates all daily points for that context across all time.
- The `sliceDSL` for these windows contains **only the context part**, not a `window(...)` term, because they represent "all dates we've ever fetched for this context."
- When we query for a specific `window(start:end)`, we **filter** that window's daily series to the requested range in memory (via `aggregateWindow`).

---

## Complete Daily-Grid Aggregation Algorithm

**Top-level function** (replaces the old "exact match" approach):

```typescript
interface QueryRequest {
  variable: Variable;
  constraints: ParsedConstraints;  // From query DSL
  sourceType: 'daily' | 'aggregate';  // Determined from connection metadata
}

interface AggregationResult {
  status: 'complete' | 'mece_aggregation' | 'partial_data' | 'prorated';
  data: { n: number; k: number; mean: number; stdev: number };
  usedWindows: ParameterValue[];
  warnings: string[];
  fetchedSubqueries?: number;  // How many new fetches were executed
}

/**
 * UX mapping for AggregationResult.status:
 *
 * - 'complete':
 *   - Meaning: Query answered fully for the requested slice/window.
 *   - UI: Normal render; no toast. "Fetch" button hidden if no missing days.
 *
 * - 'mece_aggregation':
 *   - Meaning: Aggregated across a MECE partition (e.g., all browser-type values).
 *   - UI: Normal render; small inline hint like "Aggregated across browser-type".
 *   - "Fetch" button hidden if no missing slices/days.
 *
 * - 'partial_data':
 *   - Meaning: We aggregated across a subset of the relevant space (incomplete MECE
 *     or non-MECE); result is useful but NOT a true total.
 *   - UI:
 *     - Non-blocking toast: "This result is based on a partial set of contexts; treat as indicative only."
 *     - Inline badge near legend or query bar: "Partial".
 *     - "Fetch" button shown if we can identify missing slices/days to fill in.
 *
 * - 'prorated':
 *   - Meaning: Answer derived via time pro-rating from a coarse aggregate (no daily data).
 *   - UI:
 *     - Non-blocking toast: "This value is prorated from a coarser window; may be approximate."
 *     - Inline badge: "Prorated".
 *     - "Fetch" button generally hidden (no better data available).
 *
 * GENERAL ERROR POLICY:
 * - We never hard-fail user interactions in the UI.
 * - All aggregation outcomes return some result (even if partial), with warnings where appropriate.
 * - Errors in adapters/registry/pinned DSL are surfaced as toasts + inline messages, not crashes.
 */

/**
 * Main aggregation entry point.
 * Extends existing windowAggregationService with context-aware logic.
 */
async function aggregateWindowsWithContexts(
  request: QueryRequest
): Promise<AggregationResult> {
  
  const { variable, constraints, sourceType } = request;
  
  if (sourceType === 'daily') {
    return await aggregateDailySource(variable, constraints);
  } else {
    return await aggregateCoarseSource(variable, constraints);
  }
}

/**
 * Aggregation for daily-capable sources (Amplitude, etc.)
 * Uses 2D grid model: context × date.
 */
async function aggregateDailySource(
  variable: Variable,
  constraints: ParsedConstraints
): Promise<AggregationResult> {
  
  // Step 1: Determine context combinations the query cares about
  const contextCombos = determineContextCombinations(constraints);
  
  // Step 2: For each context, ensure daily coverage over requested window
  const allSubqueries: SubQuerySpec[] = [];
  
  for (const combo of contextCombos) {
    const missing = generateMissingSubqueries(variable, combo, constraints.window!);
    allSubqueries.push(...missing);
  }
  
  // Step 3: Execute missing subqueries (batch if possible)
  if (allSubqueries.length > 0) {
    await executeMissingSubqueries(allSubqueries, variable);
  }
  
  // Step 4: Aggregate per context over the requested window
  const perContextResults: Array<{
    n: number;
    k: number;
    contextCombo: ContextCombination;
    timeSeries: TimeSeriesPoint[];
  }> = [];
  
  for (const combo of contextCombos) {
    // Get unified time series for this context (across all date ranges stored)
    const timeSeries = getTimeSeriesForContext(variable, combo);
    
    // Filter to requested window and aggregate
    // REUSES: aggregateWindow from windowAggregationService.ts
    const windowResult = windowAggregationService.aggregateWindow(
      timeSeries,
      constraints.window!
    );
    
    perContextResults.push({
      n: windowResult.n,
      k: windowResult.k,
      contextCombo: combo,
      timeSeries,
    });
  }
  
  // Step 5: Aggregate across contexts if applicable
  return finalizeAggregation(perContextResults, constraints, allSubqueries.length);
}

/**
 * Aggregation for non-daily sources (coarse aggregates only)
 */
async function aggregateCoarseSource(
  variable: Variable,
  constraints: ParsedConstraints
): Promise<AggregationResult> {
  
  // Try to find exact matching window
  const matchingWindows = findExactMatchingWindows(variable, constraints);
  
  if (matchingWindows.length === 1) {
    return {
      status: 'complete',
      data: {
        n: matchingWindows[0].n || 0,
        k: matchingWindows[0].k || 0,
        mean: matchingWindows[0].mean || 0,
        stdev: matchingWindows[0].stdev || 0,
      },
      usedWindows: matchingWindows,
      warnings: [],
    };
  }
  
  // Check if backend supports arbitrary windows
  const canRequery = checkIfSourceSupportsArbitraryWindows(variable);
  
  if (canRequery) {
    // Execute fresh query for exact requested window
    const newWindow = await fetchCoarseWindow(variable, constraints);
    return {
      status: 'complete',
      data: {
        n: newWindow.n || 0,
        k: newWindow.k || 0,
        mean: newWindow.mean || 0,
        stdev: newWindow.stdev || 0,
      },
      usedWindows: [newWindow],
      warnings: ['Fetched new coarse window (source does not support daily data)'],
      fetchedSubqueries: 1,
    };
  }
  
  // Backend only has fixed coarse window(s); apply pro-rata
  const prorated = prorateCoarseWindow(matchingWindows, constraints.window!);
  
  return {
    status: 'prorated',
    data: prorated,
    usedWindows: matchingWindows,
    warnings: ['Pro-rated from coarse window (source does not support finer granularity)'],
  };
}

/**
 * Pro-rate n and k from a coarse window to a sub-window.
 */
function prorateCoarseWindow(
  windows: ParameterValue[],
  requestedWindow: WindowConstraint
): { n: number; k: number; mean: number; stdev: number } {
  
  // Assume single coarse window for simplicity
  const coarseWindow = windows[0];
  
  // Parse both windows to absolute dates
  const coarseStart = parseDate(extractWindowStart(coarseWindow.sliceDSL));
  const coarseEnd = parseDate(extractWindowEnd(coarseWindow.sliceDSL));
  const requestedStart = resolveWindowDate(requestedWindow.start!);
  const requestedEnd = resolveWindowDate(requestedWindow.end!);
  
  // Compute overlap fraction
  const overlapStart = Math.max(coarseStart.getTime(), requestedStart.getTime());
  const overlapEnd = Math.min(coarseEnd.getTime(), requestedEnd.getTime());
  const overlapDuration = Math.max(0, overlapEnd - overlapStart);
  
  const coarseDuration = coarseEnd.getTime() - coarseStart.getTime();
  const fraction = coarseDuration > 0 ? overlapDuration / coarseDuration : 0;
  
  // Pro-rate n and k
  const n = (coarseWindow.n || 0) * fraction;
  const k = (coarseWindow.k || 0) * fraction;
  const mean = n > 0 ? k / n : 0;
  const stdev = calculateStdev(n, k);
  
  return { n, k, mean, stdev };
}
```

---

## Performance Considerations

**Question**: Do we need an index for window lookup with contexts?

**Answer**: NO *persisted* index needed, but **in-memory indexing recommended** for acceptable query latency.

### Performance Requirements

- Live queries in UI must complete in **<1s for aggregation** (excluding external API calls)
- At scale (100 params, 16 slices/param, 365 days each), we have:
  - ~1,600 total slices across all params
  - Per param: ~16 windows, each with ~365 daily points
  - Per query touching 10-20 params: scanning ~160-320 windows, aggregating over ~5K-10K daily points

### In-Memory Optimization Strategy

```typescript
class VariableAggregationCache {
  private contextIndexByVar: Map<string, Map<string, ParameterValue>> = new Map();
  
  /**
   * Get window for a specific context combo (O(1) after first build).
   */
  getWindowForContext(
    variable: Variable,
    contextCombo: ContextCombination
  ): ParameterValue | undefined {
    
    const varId = variable.id;
    
    // Build index lazily on first access
    if (!this.contextIndexByVar.has(varId)) {
      this.buildIndexForVariable(variable);
    }
    
    const index = this.contextIndexByVar.get(varId)!;
    const key = contextComboToKey(contextCombo); // e.g. "browser-type:chrome|channel:google"
    
    return index.get(key);
  }
  
  private buildIndexForVariable(variable: Variable): void {
    const index = new Map<string, ParameterValue>();
    
    for (const window of variable.windows || []) {
      const parsed = parseConstraintString(window.sliceDSL || '');
      const combo = contextConstraintsToCombo(parsed.contexts);
      const key = contextComboToKey(combo);
      
      index.set(key, window);
    }
    
    this.contextIndexByVar.set(variable.id, index);
  }
  
  invalidate(variableId: string): void {
    this.contextIndexByVar.delete(variableId);
  }
}
```

**Benefits**:
- First aggregation for a variable: O(#windows) to build index (negligible)
- Subsequent aggregations: O(1) context lookup, O(#days) time aggregation
- No persistence, no sync complexity
- Invalidate on write (when new windows added)

**Estimated latency** (with in-memory index):
- 20 params × 16 windows each × 365 days:
  - Index build: <10ms total (happens once per param per session)
  - Per-query aggregation: <50ms (mostly time-series summing)
  - **Total latency**: <100ms for aggregation (well under 1s budget)

**Daily series deduplication**: When merging, de-duplicate by date key with "latest write wins" policy (or error on conflict, TBD based on testing).

**File loading optimization**:
- Ensure `workspaceService` / `paramRegistryService` caches parsed param files in memory per tab/session
- YAML → JSON parse happens once per file (or on change), not per query
- Queries operate on in-memory `variable.windows` arrays, not IndexedDB/YAML

---

## Next Steps

1. Review `CONTEXTS_ADAPTERS.md` for how adapters build queries and fetch data
2. Review `CONTEXTS_TESTING_ROLLOUT.md` for comprehensive test coverage of aggregation scenarios

