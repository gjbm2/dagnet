# Contexts: Core Architecture

**Part of**: Contexts v1 implementation  
**See also**: 
- `CONTEXTS_REGISTRY.md` — Context definitions and MECE logic
- `CONTEXTS_AGGREGATION.md` — Window aggregation algorithms
- `CONTEXTS_ADAPTERS.md` — Data source integrations
- `CONTEXTS_TESTING_ROLLOUT.md` — Testing and deployment

---

## Overview

This document defines the core architectural principles for contexts support, including:
- Terminology and naming conventions
- Data model and schema changes
- Separation of concerns (indexing vs integrity)
- DSL parsing infrastructure
- Query signature service

---

## Terminology & Naming Conventions

**Key distinction**: A **slice** is a specific data window on a var (contexted, time-bounded result). The graph's **data interests** specification is NOT a slice—it's a query template that gets exploded into multiple slices.

### Graph-Level

- `dataInterestsDSL` (string): Query specification on graph that drives nightly runs  
  Example: `"context(channel);context(browser-type).window(-90d:)"`  
  This describes *what* to fetch, not a specific slice of data.

- `currentQueryDSL` (string): Ephemeral UI state for current user query  
  Example: `"context(channel:google).window(1-Jan-25:31-Mar-25)"`  
  Persisted so graph reopens with same query state.

### Variable/Window-Level

- `sliceDSL` (string): Canonical identifier for a specific data window  
  Example: `"context(channel:google).window(1-Jan-25:31-Mar-25)"`  
  Stored on each window; single source of truth for what that window represents.

### Constraint vs Slice

- **Constraint**: Part of a DSL expression (e.g., `context(...)`, `visited(...)`, `window(...)`)
- **Slice**: A concrete data window with specific n, k, mean, stdev for a given constraint set
- **Data interests**: Graph-level specification that generates multiple slices

### Three Distinct "Queries"

To avoid confusion, we explicitly distinguish three concepts:

| Term | What It Is | Where It Lives | Purpose | Example |
|------|-----------|----------------|---------|---------|
| **User DSL Query** | User-facing query expression in our DSL | Graph metadata (`dataInterestsDSL`, `currentQueryDSL`), UI inputs | Describes what the user wants to fetch/view; decomposed into slices | `"context(channel).window(-30d:)"` |
| **Slice Key** (`sliceDSL`) | Canonical identifier for an atomic slice | `ParameterValue.sliceDSL` | PRIMARY INDEX KEY for data lookup | `"context(channel:google).window(1-Jan-25:31-Jan-25)"` |
| **Data Query Spec** | Normalized specification of what we send to external source (Amplitude/Sheets) | Built dynamically from graph topology + slice + adapter config | Source of truth for `query_signature` integrity checking | `{connection: "amplitude-eu", event: "purchase", filters: ["utm_source=='google'"], granularity: "daily"}` |

**Critical distinction**:
- **User DSL queries** describe *user intent* and can span multiple slices
- **Slice keys** identify *specific data chunks* stored in parameter files
- **Data query specs** describe *external API calls* and determine data validity

**Usage rules**:
- Use **slice keys** for indexing (finding data)
- Use **data query specs** for integrity checking (is data stale?)
- User DSL queries are *never* used directly for indexing or signatures

---

## Data Model & Schema Changes

### Graph Schema Extensions

**Schema authority**: `param-registry/schemas/conversion-graph-1.0.0.json` (remote config repo)  
**Code mirror**: `graph-editor/src/types/index.ts` (`ConversionGraph` / `Graph` types)

Add to graph object:

```typescript
interface Graph {
  // ... existing fields ...
  
  // NEW: Data interests DSL for nightly runs (query specification, not a slice)
  dataInterestsDSL?: string;
  // Example: "context(channel);context(browser-type).window(-90d:)"
  // Drives what slices the nightly runner will fetch and cache
  
  // NEW: Current ephemeral query DSL (contexts + window) for UI state persistence
  currentQueryDSL?: string;
  // Example: "context(channel:google).window(1-Jan-25:31-Mar-25)"
  // Rehydrates UI when graph reopens
}
```

**Rationale**:
- `dataInterestsDSL`: Optional query template that gets exploded into atomic slices by runner
- `currentQueryDSL`: UI state only; persisted for UX continuity
- Both are strings in same DSL format but serve different purposes

### Variable Window Schema Extensions

**Current state**:
```typescript
// Existing format (as seen in windowAggregationService.ts and paramRegistryService.ts)
interface ParameterValue {
  n?: number;
  k?: number;
  mean?: number;
  stdev?: number;
  
  // Time-series data (existing)
  n_daily?: number[];
  k_daily?: number[];
  dates?: string[];  // d-MMM-yy format
  
  // Other existing fields...
}
```

**NEW additions**:
```typescript
interface ParameterValue {
  // ... all existing fields ...
  
  // NEW: Canonical slice DSL string for this data (PRIMARY INDEX KEY)
  sliceDSL: string;  // REQUIRED (empty string = uncontexted, all-time slice)
  // Example: "context(channel:google).window(1-Jan-25:31-Mar-25)"
  // This is the PRIMARY KEY for data lookup - NOT query_signature
  // All data operations MUST filter by sliceDSL before any other logic
  
  // EXISTING: Query signature (INTEGRITY TOKEN, not index key)
  query_signature?: string;  // Optional hash for detecting stale config
  // Only used to detect if query *configuration* changed (connection, source settings)
  // NOT used for data lookup (multiple slices can share same signature)
}
```

**Design decisions**:
- **Separation of concerns** (see "Query Signatures vs Slice Keys" section):
  - `sliceDSL` = PRIMARY INDEX KEY (what data this is)
  - `query_signature` = integrity token (is configuration still valid)
- **NO redundant structured metadata**: We store only `sliceDSL` string, parse on-demand.
- **Invariant: atomic slices only**:
  - Persisted `sliceDSL` MUST NOT contain `contextAny(...)`.
  - The nightly runner and UI explode any `contextAny(...)` or `or(...)` constructs into
    fully-specified `context(key:value)` combinations **before** writing windows.
  - All aggregation / MECE logic assumes each window represents exactly one concrete
    `(key:value)` per context key.
- **Date format**: `d-MMM-yy` everywhere (canonical stored format, e.g., `1-Jan-25`)
  - `sliceDSL` window dates: `d-MMM-yy`
  - Time-series `dates` arrays: `d-MMM-yy`
  - **New system from scratch**: No legacy YYYY-MM-DD to support or migrate
- **Required field**: `sliceDSL` on all windows; empty string for uncontexted/all-time data
- **Migration**: Existing data without `sliceDSL` treated as uncontexted slice (empty string)

### Edge Conditional Probability Schema

**No schema changes required** — contexts are already part of the `condition` string in `conditional_ps`:

```typescript
interface ConditionalProbability {
  condition: string;  // e.g. "visited(landing).context(channel:google)"
  mean: number;
  stdev?: number;
  // ... other fields ...
}
```

The existing `UpdateManager.rebalanceConditionalProbabilities` logic already groups by `condition` string, so it will naturally handle context-bearing conditions once we extend the DSL parser.

---

## Query Signatures vs Slice Keys: Separation of Concerns

**Problem Statement**: Current codebase conflates two orthogonal concerns:
1. **Data Indexing**: "Which slice does this data represent?" 
2. **Data Integrity**: "Is this data still valid given current config?"

**Current Issues**:
- `query_signature` is used for both purposes
- Signature is a hash of *data query spec* (what we'd send to the source)
- When query spec is identical but slice parameters differ (e.g., different contexts), signatures collide
- This makes signatures unsuitable as primary index keys

**Design Decision**:

| Concern | Field | Type | Purpose | Example |
|---------|-------|------|---------|---------|
| **Indexing** | `sliceDSL` | String (canonical) | Primary key to identify which slice this data belongs to | `"context(channel:google).window(1-Jan-25:31-Jan-25)"` |
| **Integrity** | `query_signature` | String (hash) | Detect if *data query spec* has changed (topology, connection, mappings) | `"a1b2c3..."` (SHA-256 of normalized data query spec) |

### Usage Patterns

#### 1. Finding data for a query

```typescript
// CORRECT: Index by sliceDSL
const targetSlice = normalizeSliceDSL(userQuery);
const matchingValues = allValues.filter(v => v.sliceDSL === targetSlice);

// WRONG: Index by signature (will return mixed slices)
const matchingValues = allValues.filter(v => v.query_signature === sig);
```

#### 2. Checking if data is stale

```typescript
// CORRECT: After isolating slice, check signature
const sliceData = values.filter(v => v.sliceDSL === targetSlice);
const currentSpec = buildDataQuerySpec(slice, graph, contexts, adapter);
const currentSig = computeSignature(currentSpec);

if (sliceData.some(v => v.query_signature !== currentSig)) {
  warn('Data query spec changed; data may be stale');
}
```

#### 3. Incremental fetch logic

```typescript
// CORRECT: Filter by slice FIRST, then analyze dates
const sliceData = values.filter(v => v.sliceDSL === targetSlice);
const existingDates = extractDates(sliceData);
const missingDates = findMissingDates(requestedWindow, existingDates);

// CORRECT: Partial windows are valid if signature unchanged
// E.g., overnight fetched window(-30d:), user queries window(-7d:)
// Can reuse last 7 days from the 30-day fetch without new retrieval
```

### Implementation Requirements

1. `sliceDSL` is REQUIRED on all `ParameterValue` entries (empty string = uncontexted, all-time)
2. All data lookup/aggregation MUST filter by `sliceDSL` first
3. `query_signature` is OPTIONAL and used only for staleness detection
4. Signature generation MUST be consistent (deterministic hash of normalized data query spec)
5. **For daily-capable sources**: Date ranges are EXCLUDED from signature (partial windows remain valid)
6. **For aggregate-only sources**: Date ranges MAY be included in signature (depends on re-usability)

**Migration Note**: Existing data has `query_signature` but not `sliceDSL`. During contexts implementation, add logic to handle legacy data (treat missing `sliceDSL` as uncontexted slice).

---

## Slice Isolation Helper (Risk Mitigation)

**File**: `graph-editor/src/services/sliceIsolation.ts` (NEW)

```typescript
/**
 * Helper to enforce slice isolation in aggregation functions.
 * Returns filtered values for a specific slice, with validation.
 */
export function isolateSlice<T extends { sliceDSL?: string }>(
  values: T[],
  targetSlice: string
): T[] {
  const normalized = normalizeConstraintString(targetSlice);
  const matched = values.filter(v => (v.sliceDSL ?? '') === normalized);
  
  // Validate: if file has contexts but we got nothing, that's likely a bug
  const hasContexts = values.some(v => v.sliceDSL && v.sliceDSL !== '');
  if (hasContexts && matched.length === 0 && normalized === '') {
    throw new Error(
      `Slice isolation error: file has contexted data but query requested uncontexted. ` +
      `Use MECE aggregation if intentional.`
    );
  }
  
  return matched;
}
```

**Usage pattern**:
```typescript
function aggregateWindow(allValues: ParameterValue[], targetSlice: string, window: DateRange) {
  const values = isolateSlice(allValues, targetSlice);
  // ... rest of logic operates only on isolated values
}
```

**Integration**: Apply to `dataOperationsService.ts` and `windowAggregationService.ts` in Task 2.1/2.2.

---

## Data Query Signature Service

**Problem**: Signature generation is currently ad-hoc and risks inconsistency.

**Solution**: Centralize into `QuerySignatureService` that handles all signature logic.

**File**: `graph-editor/src/services/querySignatureService.ts` (NEW)

```typescript
/**
 * Query Signature Service
 * 
 * Centralizes data query signature generation and validation.
 * Ensures consistency across adapters and incremental fetch logic.
 * 
 * CRITICAL: Signatures are for DATA QUERY SPECS, not user DSL queries or slice keys.
 */

export interface DataQuerySpec {
  // Connection
  connectionId: string;
  connectionType: 'amplitude' | 'sheets' | 'statsig' | 'optimizely';
  
  // Graph topology (as seen by adapter)
  fromNode: string;
  toNode: string;
  visited: string[];
  excluded: string[];
  cases: Array<{ key: string; value: string }>;
  
  // Context filters (as transformed for this source)
  contextFilters: Array<{
    key: string;
    value: string;
    sourceField: string;      // e.g., "utm_source"
    sourcePredicate: string;  // e.g., "utm_source == 'google'"
  }>;
  
  // Time handling
  granularity: 'daily' | 'aggregate';
  // For 'aggregate' mode: include window bounds
  // For 'daily' mode: EXCLUDE window bounds (partial windows remain valid)
  windowBounds?: { start: string; end: string };
  
  // Adapter-specific config
  adapterOptions: Record<string, any>;  // Deterministically ordered
}

export class QuerySignatureService {
  /**
   * Build signature for a daily-capable query.
   * Excludes date bounds so partial windows remain valid.
   */
  buildDailySignature(spec: Omit<DataQuerySpec, 'windowBounds'>): string {
    const normalized = this.normalizeSpec({ ...spec, granularity: 'daily' });
    return this.hashSpec(normalized);
  }
  
  /**
   * Build signature for an aggregate-only query.
   * Includes date bounds since the slice is tied to that specific window.
   */
  buildAggregateSignature(spec: DataQuerySpec): string {
    if (spec.granularity !== 'aggregate') {
      throw new Error('buildAggregateSignature requires granularity: aggregate');
    }
    const normalized = this.normalizeSpec(spec);
    return this.hashSpec(normalized);
  }
  
  /**
   * Check if stored signature matches current query spec.
   * Returns { valid: boolean; reason?: string }
   */
  validateSignature(
    storedSignature: string,
    currentSpec: DataQuerySpec
  ): { valid: boolean; reason?: string } {
    const currentSig = currentSpec.granularity === 'daily'
      ? this.buildDailySignature(currentSpec)
      : this.buildAggregateSignature(currentSpec);
    
    if (storedSignature === currentSig) {
      return { valid: true };
    }
    
    return { 
      valid: false, 
      reason: 'Data query spec changed (topology, connection, or context mappings differ)' 
    };
  }
  
  /**
   * Normalize spec to deterministic form for hashing.
   * - Sort arrays (visited, excluded, contextFilters)
   * - Remove undefined/null fields
   * - Order object keys
   */
  private normalizeSpec(spec: Partial<DataQuerySpec>): Record<string, any> {
    // Implementation: deep sort, remove nulls, canonical JSON
    // ...
  }
  
  /**
   * Hash normalized spec using SHA-256.
   */
  private hashSpec(normalized: Record<string, any>): string {
    const canonical = JSON.stringify(normalized);
    // Use crypto.subtle.digest or equivalent
    return sha256Hex(canonical);
  }
}

export const querySignatureService = new QuerySignatureService();
```

### Usage in Adapters

```typescript
// Amplitude adapter
async fetch(edge, slice, window) {
  const spec: DataQuerySpec = {
    connectionId: this.connection.id,
    connectionType: 'amplitude',
    fromNode: edge.from,
    toNode: edge.to,
    visited: parseSliceDSL(slice).visited,
    // ... build full spec from graph + slice + contexts
    granularity: 'daily',
    // NO windowBounds for daily mode
  };
  
  const signature = querySignatureService.buildDailySignature(spec);
  
  // Fetch from Amplitude...
  const data = await amplitudeAPI.query(/* ... */);
  
  return {
    n_daily: data.n_daily,
    k_daily: data.k_daily,
    dates: data.dates,
    sliceDSL: slice,
    query_signature: signature,  // Store for future validation
  };
}
```

### Updates Required to Existing Code

1. **`dataOperationsService.ts`** (lines ~2100-2300):
   - Replace ad-hoc signature comparison with `querySignatureService.validateSignature()`
   - Build `DataQuerySpec` from current graph state
   - Use service for all signature checks

2. **`amplitudeDASAdapter.ts`** (or equivalent):
   - Replace inline signature generation with `querySignatureService.buildDailySignature()`
   - Build `DataQuerySpec` from adapter request

3. **`sheetsAdapter.ts`**:
   - Use `querySignatureService.buildAggregateSignature()` (Sheets typically returns aggregates)
   - Include window bounds in spec since Sheets data is often window-specific

4. **`windowAggregationService.ts`**:
   - When checking validity, use `querySignatureService.validateSignature()`
   - No direct signature generation (that's adapter responsibility)

---

## DSL Parsing & Normalization

**Key principle**: Extend existing parsing infrastructure rather than create parallel systems.

### DSL Schema Updates

**Files to update**:

1. **`graph-editor/public/schemas/query-dsl-1.0.0.json`**:

```json
{
  "constraintFunctions": {
    "visited": { "description": "Require visit to specified nodes", "args": "nodeId[,nodeId...]" },
    "visitedAny": { "description": "Require visit to any of specified nodes", "args": "nodeId[,nodeId...]" },
    "exclude": { "description": "Exclude users who visited nodes", "args": "nodeId[,nodeId...]" },
    "case": { "description": "Filter by case variant", "args": "caseId:variantName" },
    "context": { "description": "Filter by context dimension", "args": "key:value" },
    "contextAny": { "description": "Filter by any of several context values", "args": "key:value[,key:value...]" },
    "window": { "description": "Time window for data", "args": "start:end" }
  }
}
```

2. **TypeScript types** (`graph-editor/src/types/queryDSL.ts` or inline in `constraintParser.ts`):

```typescript
export interface ParsedConstraints {
  visited: string[];
  visitedAny: string[];
  exclude: string[];
  cases: Array<{ key: string; value: string }>;
  contexts: Array<{ key: string; value: string }>;      // NEW
  contextAnys: Array<{ pairs: Array<{ key: string; value: string }> }>; // NEW
  window: { start?: string; end?: string } | null;      // NEW
}

export type ContextCombination = Record<string, string>; // NEW: e.g. {channel: 'google', 'browser-type': 'chrome'}
```

3. **Monaco language registration** (`graph-editor/src/lib/queryDSL.ts`):

Update `QUERY_FUNCTIONS` constant to include:

```typescript
export const QUERY_FUNCTIONS = {
  // ... existing functions ...
  context: {
    signature: 'context(key:value)',
    description: 'Filter data by a context dimension (e.g., channel, browser-type)',
    examples: ['context(channel:google)', 'context(browser-type:chrome)']
  },
  contextAny: {
    signature: 'contextAny(key:value,key:value,...)',
    description: 'Filter by any of several context values (OR within key, AND across keys)',
    examples: ['contextAny(channel:google,meta)', 'contextAny(source:facebook,source:instagram)']
  },
  window: {
    signature: 'window(start:end)',
    description: 'Time window for data retrieval (absolute d-MMM-yy or relative -Nd)',
    examples: ['window(1-Jan-25:31-Mar-25)', 'window(-90d:)', 'window(-30d:-7d)']
  }
};
```

### Extending Existing Infrastructure

**Already implemented**:
- ✓ `context(key:value)` parsing in `queryDSL.ts` (lines 173-177)
- ✓ Context schemas (`contexts-index-schema.yaml`, `context-definition-schema.yaml`)
- ✓ `paramRegistryService.loadContext()` and `loadContextsIndex()`
- ✓ Navigator section for contexts (already shows in sidebar)
- ✓ File type registry entry for contexts

**What's actually new**:
1. Add `contextAny(...)` to `ParsedConstraints` interface (currently missing)
2. Add `window(...)` to `ParsedConstraints` interface (currently missing)
3. Add chip rendering for `contextAny` and `window` in `QueryExpressionEditor`
4. Wire contexts into data aggregation (currently parsed but not used for data slicing)

### Constraint Parsing Extensions

**Existing**: `queryDSL.ts` already has:
- `parseConstraints()` function
- `ParsedConstraints` interface with `context: Array<{key, value}>`
- `normalizeConstraintString()` function

**What to add**:
1. Extend `ParsedConstraints` interface in `queryDSL.ts`:
   - Add `contextAnys: Array<{ pairs: Array<{ key: string; value: string }> }>`
   - Add `window: { start?: string; end?: string } | null`

2. Update `parseConstraints()` to handle:
   - `contextAny(key:val,key:val,...)` → new regex pattern
   - `window(start:end)` → new regex pattern

3. Update `normalizeConstraintString()` to include new constraint types in canonical order

**No major refactoring needed** - just extending existing utilities.

### Python Parser Extensions

**File**: `python-backend/query_dsl.py` (or equivalent)

Mirror all TypeScript changes:
- Add `context`, `contextAny`, `window` to constraint patterns
- Implement same normalization logic
- Ensure constraint ordering matches TypeScript (for deterministic cache keys)

---

## Implementation Risks & Critical Paths

### 1. Data Operations Service: Incremental Fetch Corruption

- **Risk**: Existing logic in `dataOperationsService.ts` (lines 2180+) filters parameter values by `query_signature` only.
- **Problem**: Multiple context slices (e.g., `channel:google`, `channel:fb`) will share the same `query_signature` (derived from base query config). Filtering by signature alone will return a mixed bag of slices. `calculateIncrementalFetch` will then merge dates from different contexts, falsely believing data exists for a date when it only exists for a *different* context.
- **Fix**: Filter MUST be updated to check `query_signature` **AND** `sliceDSL`. Only values matching the exact requested slice should be considered for incremental fetch analysis.

### 2. Window Aggregation: Time-Series Assumptions (CRITICAL)

- **Risk**: `windowAggregationService.ts` logic assumes the `values` array represents a single logical time-series.
- **Problem**: With contexts, `values` will contain multiple disjoint time-series (one per slice). Naive iteration over `values` will aggregate disparate contexts.
- **Fix**: 
  1. All aggregation functions must accept a target `sliceDSL` parameter
  2. First line of each function: `const matchingValues = values.filter(v => v.sliceDSL === targetSliceDSL)`
  3. All subsequent logic operates only on `matchingValues`
- **Safeguard**: Add assertion that fails if aggregation is called without a `sliceDSL` when `values.length > 0 && values.some(v => v.sliceDSL)` (i.e., if file has contexts data, must specify which slice to aggregate)

### 3. Condition String Parsing in UpdateManager

- **Current State**: 
  - `UpdateManager.ts` uses `path.split('.')` to traverse object properties (for internal state paths like `nodes[id].data.x`)
  - Graph files and user references DO key conditional_p by condition string (e.g., `"visited(a).context(b:c)"`)
  - Current naive split on `.` will break when condition strings contain dots
- **Required Changes**:
  1. **Distinguish path types**: 
     - State paths (internal): `nodes[0].case.variants` → safe to split on `.`
     - Condition strings (user-facing): `visited(a).context(b:c)` → must parse via DSL parser
  2. **New utility in `constraintParser.ts`**: 
     ```typescript
     parseConditionForLookup(condition: string): {
       edgeId?: string;
       groupId?: string;
       condition: string;
     }
     ```
  3. **UpdateManager pattern**: When path contains a condition reference, detect this (e.g., path starts with `edge:` or `group:`) and use DSL-aware parsing instead of naive split
  4. **HRNResolver updates**: Already uses DSL parsing; ensure it's used consistently for all condition string lookups

---

## Component Reuse Confirmation

**For complete visual design and UX patterns**: See `CONTEXTS_UI_DESIGN.md`.

### Existing Components We're Extending (NOT Rebuilding)

**1. WindowSelector Component** (`WindowSelector.tsx`):
- **What we add**: Instance of extended QueryExpressionEditor (for context chips), `[+ Context ▾]` button, `[⤵]` unroll button
- **What we remove**: Existing Context button placeholder, What-if button (moved to Scenarios panel)
- **What we reuse unchanged**: Date presets, date picker, Fetch button
- **Details**: `CONTEXTS_UI_DESIGN.md` → WindowSelector Toolbar section

**2. QueryExpressionEditor Component** (`QueryExpressionEditor.tsx`):
- **What we extend**: Per-chip `▾` dropdown trigger, chips for `context`/`contextAny`/`window`
- **What we reuse**: Entire chip rendering, edit mode toggle, Monaco mounting, validation
- **Details**: `CONTEXTS_UI_DESIGN.md` → Extension to QueryExpressionEditor section

**3. ContextValueSelector Component** (NEW shared component):
- **Purpose**: Reusable dropdown for both per-chip and Add Context interactions
- **Modes**: `'single-key'` (per-chip) and `'multi-key'` (Add Context with accordion)
- **Pattern**: Same anchoring as existing What-if dropdown
- **Details**: `CONTEXTS_UI_DESIGN.md` → Components Breakdown section

**4. Monaco Language & Autocomplete** (`graph-editor/src/lib/queryDSL.ts`):
- **Extending `QUERY_FUNCTIONS`**: Add `context`, `contextAny`, `window` definitions
- **Details**: DSL Schema Updates section above

### Architectural Principle

**We are NOT building parallel systems**. Every new component or function either:
- **Extends an existing component** (WindowSelector gains context chips)
- **Reuses an existing utility** (parseDate, normalizeDate, calculateIncrementalFetch)
- **Follows an existing pattern** (Context dropdown mirrors What-if dropdown)

**Complete implementation guidance**: `CONTEXTS_UI_DESIGN.md` provides:
- Component hierarchy (full tree)
- 10 detailed user flows with step-by-step interactions
- Implementation pseudocode for all new components
- Responsive behavior and width transitions
- Apply/Cancel pattern for draft mode

---

## UI Components Overview

**Complete visual design**: See `CONTEXTS_UI_DESIGN.md` for comprehensive UI specifications.

**Summary of UI components** (brief overview; full detail in UI design doc):

### WindowSelector Toolbar
- Dynamic-width Monaco component (60-450px) for context chips
- Per-chip `▾` dropdown for value swapping
- `[+ Context ▾]` button (becomes `[+ ▾]` when contexts exist)
- `[⤵]` unroll button for full DSL editor
- Fetch button (appears when data not cached)

### ContextValueSelector Component (shared)
- Mode: `'single-key'` for per-chip dropdown
- Mode: `'multi-key'` for Add Context dropdown
- Apply/Cancel pattern (draft mode prevents jarring updates)
- Accordion sections for multi-key mode
- Auto-uncheck behavior (nudges toward single-key selections)

### Pinned Query Modal
- Monaco editor for `dataInterestsDSL`
- Live preview of implied slices (enumeration + count)
- Warning if slice count exceeds 500

**Binding to DSL strings**:
- Context chips → `currentQueryDSL` (context portion)
- Full query (unrolled) → `currentQueryDSL` (contexts + window)
- Pinned Query modal → `dataInterestsDSL`

**For complete details**: Component hierarchy, user flows (10 scenarios), implementation pseudocode, styling, and responsive behavior are all in `CONTEXTS_UI_DESIGN.md`.

---

## Next Steps

1. Review `CONTEXTS_REGISTRY.md` for context definitions, otherPolicy, and MECE detection
2. Review `CONTEXTS_AGGREGATION.md` for window aggregation algorithms and scenarios
3. Review `CONTEXTS_ADAPTERS.md` for Amplitude/Sheets integration details
4. Review `CONTEXTS_UI_DESIGN.md` for complete visual design and UX patterns
5. Review `CONTEXTS_TESTING_ROLLOUT.md` for testing strategy and rollout plan

