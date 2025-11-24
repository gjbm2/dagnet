# Contexts: Implementation Documentation (INDEX)

**Based on**: `CONTEXTS.md` (high-level design)  
**Status**: Implementation specification — COMPLETE  
**Target**: v1 contexts support  
**Last Updated**: 2025-11-24

---

## ⚠️ This Document Has Been Decomposed

This 3937-line implementation document has been split into **5 focused documents** for better readability and maintainability.

**Please refer to the new documentation structure**:

### 📚 [README.md](./README.md) — Start Here
Overview and navigation guide for all contexts documentation.

### 1. [CONTEXTS_ARCHITECTURE.md](./CONTEXTS_ARCHITECTURE.md)
Core architecture, data model, and terminology.

### 2. [CONTEXTS_REGISTRY.md](./CONTEXTS_REGISTRY.md)
Context definitions, otherPolicy, and MECE detection.

### 3. [CONTEXTS_AGGREGATION.md](./CONTEXTS_AGGREGATION.md)
Window aggregation logic and 2D grid model.

### 4. [CONTEXTS_ADAPTERS.md](./CONTEXTS_ADAPTERS.md)
Data source integrations and nightly runner.

### 5. [CONTEXTS_TESTING_ROLLOUT.md](./CONTEXTS_TESTING_ROLLOUT.md)
Testing strategy, validation, and deployment.

---

## Quick Reference

**For implementers**: Start with [README.md](./README.md) → [CONTEXTS_ARCHITECTURE.md](./CONTEXTS_ARCHITECTURE.md)

**For reviewers**: See critical sections in [README.md](./README.md#key-design-decisions)

**For specific topics**:
- Data model and sliceDSL → [CONTEXTS_ARCHITECTURE.md](./CONTEXTS_ARCHITECTURE.md#data-model--schema-changes)
- otherPolicy impact → [CONTEXTS_REGISTRY.md](./CONTEXTS_REGISTRY.md#otherpolicy-detailed-specification)
- MECE aggregation → [CONTEXTS_AGGREGATION.md](./CONTEXTS_AGGREGATION.md#mece-aggregation-across-context-keys)
- Amplitude adapter → [CONTEXTS_ADAPTERS.md](./CONTEXTS_ADAPTERS.md#amplitude-adapter-extensions)
- Test requirements → [CONTEXTS_TESTING_ROLLOUT.md](./CONTEXTS_TESTING_ROLLOUT.md#unit-tests)

---

## Design Status

All major design questions have been resolved:

1. ✓ **Terminology**: `dataInterestsDSL` (graph) vs `sliceDSL` (window) vs `currentQueryDSL` (UI)
2. ✓ **Data model**: `sliceDSL` as PRIMARY KEY; query_signature as integrity token
3. ✓ **Amplitude API**: Dashboard REST API with property filters documented
4. ✓ **Sheets fallback**: Fallback to uncontexted with warning
5. ✓ **MECE aggregation**: Full algorithm with otherPolicy support (4 variants)
6. ✓ **Window overlap**: 7 scenarios for daily grid model
7. ✓ **Performance**: In-memory index, <1s latency target

---

## Archive Notice

The original 3937-line document content is preserved below for historical reference.
**All sections below are superseded by the new decomposed documentation.**

For current implementation guidance, please use the documents linked above.

---

# ARCHIVED CONTENT BELOW

---

## Table of Contents (ARCHIVED)

1. [Terminology & Naming Conventions](#terminology--naming-conventions)
2. [Data Model & Schema Changes](#data-model--schema-changes)
3. [DSL Parsing & Normalization (Extending Existing Code)](#dsl-parsing--normalization-extending-existing-code)
4. [Context Registry Structure](#context-registry-structure)
5. [Window Aggregation Logic (Complete Redesign)](#window-aggregation-logic-complete-redesign)
6. [Adapter Extensions](#adapter-extensions)
7. [UI Components & Flows](#ui-components--flows)
8. [Nightly Runner Integration](#nightly-runner-integration)
9. [Testing Strategy](#testing-strategy)
10. [Migration & Rollout](#migration--rollout)

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

---

## Data Model & Schema Changes

**Summary**: Schema updates required for contexts v1

| Schema File | Status | Changes Needed |
|-------------|--------|----------------|
| `graph-schema.json` | Extend | Add `dataInterestsDSL`, `currentQueryDSL` fields |
| `context-definition-schema.yaml` | **Extend** | Add `otherPolicy`, `sources` (with `field`, `filter`, `pattern`, `patternFlags`) |
| `contexts-index-schema.yaml` | **Exists** | No changes needed |
| `query-dsl-1.0.0.json` | Extend | Register `context`, `contextAny`, `window` functions |

**Note**: Individual context definition files (e.g., `contexts/channel.yaml`) will be created following the extended `context-definition-schema.yaml`.

---

### 1. Graph Schema Extensions

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

### 2. Variable Window Schema Extensions

**Current state** (from existing codebase):
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
  dates?: string[];  // YYYY-MM-DD format
  
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

### 3. Edge Conditional Probability Schema

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

## DSL Parsing & Normalization (Extending Existing Code)

**Key principle**: Extend existing parsing infrastructure rather than create parallel systems.

### 0. DSL Schema Updates

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

This ensures Monaco autocomplete suggests the new functions.

---

### Existing Constraint Parsing Infrastructure

**Files to extend**:
1. `graph-editor/src/services/ParamPackDSLService.ts` — Already has regex for `visited|context|case|exclude` (line 426)
2. `graph-editor/src/services/HRNResolver.ts` — Resolves conditional HRNs (line 126)
3. `graph-editor/src/services/HRNParser.ts` — Parses HRN strings into components
4. **`graph-editor/src/components/QueryExpressionEditor.tsx`** — Monaco-based chip editor (ALREADY has `context` in outerChipConfig line 67-70!)

**Current pattern** (from ParamPackDSLService.ts line 426):
```typescript
const conditionalMatch = key.match(/^e\.([^.]+)\.((?:visited|context|case|exclude)\([^)]+\)(?:\.(?:visited|context|case|exclude)\([^)]+\))*)\.p\.(.+)$/);
```

This regex ALREADY includes `context` in the pattern! We need to:
1. Ensure it handles `context(key:value)` syntax correctly (already does, based on colon separator)
2. Add `contextAny` and `window` to the pattern
3. Add chip rendering for `contextAny` and `window` in `QueryExpressionEditor`

### 1. Extend ParamPackDSLService.ts

**Current location**: Line 424-442 handles conditional probability parsing

**Changes needed**:

```typescript
// UPDATE regex pattern to include contextAny and window
const conditionalMatch = key.match(/^e\.([^.]+)\.((?:visited|visitedAny|context|contextAny|case|exclude|window)\([^)]+\)(?:\.(?:visited|visitedAny|context|contextAny|case|exclude|window)\([^)]+\))*)\.p\.(.+)$/);

// Rest of logic remains the same — we store the full condition string as-is
// Normalization happens separately via normalizeConstraintString
```

**Add normalization function** (new):
```typescript
/**
 * Normalize a constraint string to canonical form.
 * Sorts constraints alphabetically within each type, normalizes dates.
 * 
 * Example:
 *   "context(channel:google).visited(promo).window(1-Jan-25:31-Jan-25)"
 * → "visited(promo).context(channel:google).window(1-Jan-25:31-Jan-25)"
 *   (visited first, then context, then window)
 */
export function normalizeConstraintString(condition: string): string {
  if (!condition) return '';
  
  // Parse into constraint types
  const constraints = {
    visited: [] as string[],
    visitedAny: [] as string[],
    exclude: [] as string[],
    cases: [] as Array<{key: string; value: string}>,
    contexts: [] as Array<{key: string; value: string}>,
    contextAnys: [] as Array<{pairs: Array<{key: string; value: string}>}>,
    window: null as {start?: string; end?: string} | null,
  };
  
  // Split on '.' and parse each token
  const tokens = condition.split('.');
  for (const token of tokens) {
    // visited(...)
    const visitedMatch = token.match(/^visited\(([^)]+)\)$/);
    if (visitedMatch) {
      constraints.visited.push(...visitedMatch[1].split(',').map(s => s.trim()));
      continue;
    }
    
    // visitedAny(...)
    const visitedAnyMatch = token.match(/^visitedAny\(([^)]+)\)$/);
    if (visitedAnyMatch) {
      constraints.visitedAny.push(...visitedAnyMatch[1].split(',').map(s => s.trim()));
      continue;
    }
    
    // exclude(...)
    const excludeMatch = token.match(/^exclude\(([^)]+)\)$/);
    if (excludeMatch) {
      constraints.exclude.push(...excludeMatch[1].split(',').map(s => s.trim()));
      continue;
    }
    
    // case(key:value)
    const caseMatch = token.match(/^case\(([^:]+):([^)]+)\)$/);
    if (caseMatch) {
      constraints.cases.push({ key: caseMatch[1], value: caseMatch[2] });
      continue;
    }
    
    // context(key:value)
    const contextMatch = token.match(/^context\(([^:]+):([^)]+)\)$/);
    if (contextMatch) {
      constraints.contexts.push({ key: contextMatch[1], value: contextMatch[2] });
      continue;
    }
    
    // contextAny(key:val,key:val,...)
    const contextAnyMatch = token.match(/^contextAny\((.+)\)$/);
    if (contextAnyMatch) {
      const pairs = contextAnyMatch[1].split(',').map(pair => {
        const [key, value] = pair.split(':');
        return { key: key.trim(), value: value.trim() };
      });
      constraints.contextAnys.push({ pairs });
      continue;
    }
    
    // window(start:end)
    const windowMatch = token.match(/^window\(([^:]*):([^)]*)\)$/);
    if (windowMatch) {
      constraints.window = {
        start: windowMatch[1] || undefined,
        end: windowMatch[2] || undefined,
      };
      continue;
    }
  }
  
  // Rebuild in canonical order: visited, visitedAny, exclude, case, context, contextAny, window
  const parts: string[] = [];
  
  if (constraints.visited.length > 0) {
    parts.push(`visited(${constraints.visited.sort().join(',')})`);
  }
  if (constraints.visitedAny.length > 0) {
    parts.push(`visitedAny(${constraints.visitedAny.sort().join(',')})`);
  }
  if (constraints.exclude.length > 0) {
    parts.push(`exclude(${constraints.exclude.sort().join(',')})`);
  }
  constraints.cases.sort((a, b) => a.key.localeCompare(b.key));
  for (const c of constraints.cases) {
    parts.push(`case(${c.key}:${c.value})`);
  }
  constraints.contexts.sort((a, b) => a.key.localeCompare(b.key));
  for (const c of constraints.contexts) {
    parts.push(`context(${c.key}:${c.value})`);
  }
  for (const ca of constraints.contextAnys) {
    const pairStrs = ca.pairs.map(p => `${p.key}:${p.value}`).sort();
    parts.push(`contextAny(${pairStrs.join(',')})`);
  }
  if (constraints.window) {
    const start = normalizeWindowDate(constraints.window.start);
    const end = normalizeWindowDate(constraints.window.end);
    parts.push(`window(${start}:${end}`);
  }
  
  return parts.join('.');
}

function normalizeWindowDate(date: string | undefined): string {
  if (!date) return '';
  // If relative offset, leave as-is
  if (date.match(/^-?\d+[dwmy]$/)) return date;
  // Otherwise parse and convert to d-MMM-yy
  return formatDateUK(parseDate(date));
}
```

### 2. Refactor: Extract Constraint Parsing as Shared Utility

**NEW FILE**: `graph-editor/src/services/constraintParser.ts`

Move the parsing logic from ParamPackDSLService into a shared utility that can be used by:
- ParamPackDSLService (for ingesting Sheets params)
- Window aggregation service (for matching slices)
- Query builder (for constructing DAS queries)
- UI components (for parsing/displaying constraints)

```typescript
export interface ParsedConstraints {
  visited: string[];
  visitedAny: string[];
  exclude: string[];
  cases: Array<{ key: string; value: string }>;
  contexts: Array<{ key: string; value: string }>;
  contextAnys: Array<{ pairs: Array<{ key: string; value: string }> }>;
  window: { start?: string; end?: string } | null;
}

export function parseConstraintString(condition: string): ParsedConstraints {
  // Implementation as above
}

export function normalizeConstraintString(condition: string): string {
  // Implementation as above
}

export function buildConstraintString(parsed: ParsedConstraints): string {
  // Inverse of parseConstraintString
}
```

**Refactoring scope**:
- Extract constraint parsing from ParamPackDSLService.ts
- Update HRNResolver.ts to use shared utility
- Update any other files that currently parse constraint strings inline

### 3. Python Parser Extensions

**File**: `python-backend/query_dsl.py` (or equivalent)

Mirror all TypeScript changes:
- Add `context`, `contextAny`, `window` to constraint patterns
- Implement same normalization logic
- Ensure constraint ordering matches TypeScript (for deterministic cache keys)

---

## Context Registry Structure

**Pattern**: Mirrors parameter registry (index file + individual definition files)

### 1. Context Index File

**File**: `param-registry/contexts-index.yaml`

**Purpose**: Lightweight registry listing all available context keys (like `registry.yaml` for parameters)

```yaml
version: "1.0.0"
created_at: "2025-11-23T00:00:00Z"
updated_at: "2025-11-23T00:00:00Z"

contexts:
  - id: channel
    file_path: "contexts/channel.yaml"
    type: categorical
    status: active
    category: marketing
    created_at: "2025-11-23T00:00:00Z"
    version: "1.0.0"
  
  - id: browser_type
    file_path: "contexts/browser-type.yaml"
    type: categorical
    status: active
    category: technical
    created_at: "2025-11-23T00:00:00Z"
    version: "1.0.0"
```

**Schema**: `graph-editor/public/param-schemas/contexts-index-schema.yaml` (exists)

**Loading**: ContextRegistry loads this index first, then loads individual context definitions on-demand or eagerly.

---

### 2. Individual Context Definition Files

**Pattern**: One YAML file per context key (mirrors `params/*.yaml` structure)

**File**: `param-registry/contexts/channel.yaml`

**Schema**: `graph-editor/public/param-schemas/context-definition-schema.yaml` (EXISTS, needs extension)

**Required schema additions**:

```yaml
# Add to context-definition-schema.yaml properties:

otherPolicy:
  type: string
  enum: [null, computed, explicit, undefined]
  description: |
    Controls how the "other" catch-all bucket is handled:
    - null: No "other"; values are asserted MECE (complete)
    - computed: "other" = ALL - explicit values (computed dynamically)
    - explicit: "other" is a regular value with explicit mappings
    - undefined: No "other"; values NOT MECE (can't aggregate to total)
  default: undefined

# Add to values[].properties:

sources:
  type: object
  description: "Source-specific mappings for this value"
  additionalProperties:
    type: object
    properties:
      field:
        type: string
        description: "Source property/field name"
        examples: ["utm_source", "browser", "device_type"]
      
      filter:
        type: string
        description: "Explicit filter expression for this value"
        examples: ["utm_source == 'google'", "browser in ['Chrome', 'Chromium']"]
      
      pattern:
        type: string
        description: "Regex pattern for matching raw values (alternative to filter)"
        examples: ["^google", "^(facebook|fb|instagram|ig)_"]
      
      patternFlags:
        type: string
        description: "Regex flags (e.g., 'i' for case-insensitive)"
        examples: ["i", "im"]
```

**Example context definition file** (`param-registry/contexts/channel.yaml`):

```yaml
id: channel
name: Marketing Channel
description: Primary acquisition channel (paid, organic, direct, etc.)
type: categorical
otherPolicy: computed  # NEW field
# - null: No "other" exists; explicitly listed values are asserted to be MECE (complete coverage)
# - computed: "other" exists and is defined as ALL_RESULTS - sum(all explicitly listed values)
# - explicit: "other" is defined as a regular value below (with its own filter/mapping)
# - undefined: No "other" exists, and values are NOT asserted to be MECE (incomplete; can't aggregate)

values:
  - id: google
    label: Google Ads  # Schema uses 'label', not 'displayName'
    description: "Google Ads campaigns"
    sources:  # NEW field (add to schema)
      amplitude:
        field: utm_source
        filter: "utm_source == 'google'"
      sheets:
        # For Sheets, user manually provides context-labeled data; no source mapping needed
            
  - id: meta
    label: Meta (Facebook/Instagram)
        sources:
          amplitude:
            field: utm_source
            filter: "utm_source in ['facebook', 'instagram']"
            # Note: regex support for collapsing many raw values
            
      - id: organic
    label: Organic Search
        sources:
          amplitude:
            field: utm_source
            filter: "utm_source == 'organic'"
            
      - id: direct
    label: Direct Traffic
        sources:
          amplitude:
            field: utm_source
            filter: "utm_source is null or utm_source == 'direct'"
            
      - id: other
    label: Other Channels
        sources:
          amplitude:
            # If otherPolicy=computed: adapter generates "NOT (google OR facebook OR ...)" at query time
            # If otherPolicy=explicit: must specify filter here
            filter: "utm_source not in ['google', 'facebook', 'instagram', 'organic', 'direct']"

  - id: browser-type
    name: Browser Type
    description: User's browser (Chrome, Safari, Firefox, etc.)
    type: categorical
    otherPolicy: computed
    
    values:
      - id: chrome
    label: Chrome
        sources:
          amplitude:
            field: browser
            filter: "browser == 'Chrome'"
            
      - id: safari
    label: Safari
        sources:
          amplitude:
            field: browser
            filter: "browser == 'Safari'"
            
      - id: firefox
    label: Firefox
        sources:
          amplitude:
            field: browser
            filter: "browser == 'Firefox'"
            
      - id: other
    label: Other Browsers
        sources:
          amplitude:
            # otherPolicy=computed means adapter will generate this automatically
```

**File structure**:
- `param-registry/contexts-index.yaml` — Index listing all context keys (lightweight, always loaded)
- `param-registry/contexts/channel.yaml` — Full definition for "channel" key
- `param-registry/contexts/browser-type.yaml` — Full definition for "browser-type" key
- etc.

**Key points**:
- Follows same pattern as parameter registry (index + individual files)
- `otherPolicy` controls how "other" buckets are constructed (see detailed section below)
- `sources[amplitude].filter` is the Amplitude-specific query predicate
- `sources[amplitude].pattern` provides regex support for high-cardinality raw values (see Regex Mapping section below)

---

### 2. Context Registry Loading

**File**: `graph-editor/src/services/contextRegistry.ts`

```typescript
export class ContextRegistry {
  private index: ContextsIndex | null = null;
  private definitions: Map<string, ContextDefinition> = new Map();
  
  /**
   * Load the contexts index (lightweight).
   * Called on app startup.
   */
  async loadIndex(): Promise<void> {
    const yaml = await fetchYaml('/param-schemas/contexts-index.yaml');
    this.index = yaml;
  }
  
  /**
   * Load a specific context definition file.
   * Called on-demand when a context key is first used.
   */
  async loadContextDefinition(contextId: string): Promise<ContextDefinition> {
    // Check if already loaded
    if (this.definitions.has(contextId)) {
      return this.definitions.get(contextId)!;
    }
    
    // Find in index
    const indexEntry = this.index?.contexts.find(c => c.id === contextId);
    if (!indexEntry) {
      throw new Error(`Context '${contextId}' not found in registry index`);
    }
    
    // Load definition file
    const defPath = `/param-schemas/${indexEntry.file_path}`;
    const yaml = await fetchYaml(defPath);
    
    // Validate against context-definition-schema.yaml
    // (schema validation happens here)
    
    this.definitions.set(contextId, yaml);
    return yaml;
  }
  
  /**
   * Get context definition (load if needed).
   */
  async getContext(id: string): Promise<ContextDefinition | undefined> {
    if (!this.definitions.has(id)) {
      try {
        await this.loadContextDefinition(id);
      } catch (error) {
        console.error(`Failed to load context '${id}':`, error);
        return undefined;
      }
    }
    return this.definitions.get(id);
  }
  
  /**
   * Get all context keys from index (doesn't load full definitions).
   */
  getAllContextKeys(): Array<{ id: string; name?: string; type: string; status: string }> {
    return this.index?.contexts || [];
  }
}

export const contextRegistry = new ContextRegistry();
```

**Benefits**:
- Fast startup (only index loads, ~1-2KB)
- Lazy loading of context definitions (only load keys actually used)
- Mirrors parameter registry pattern (familiar code structure)

---

### 3. "Other" Policy: Detailed Specification

The `otherPolicy` field controls whether and how a catch-all "other" bucket is handled for a context key. This affects **multiple systems**:

#### A. Impact on Value Enumeration (for UI, MECE detection, etc.)

**When building the list of values for a key** (used in dropdowns, MECE checks, etc.):

| otherPolicy | Values list includes "other"? | Behavior |
|-------------|------------------------------|----------|
| `null` | NO | Explicitly listed values only; asserts they are MECE |
| `computed` | YES | Include "other" as a value; computed at query time |
| `explicit` | YES | Include "other" as a regular value with its own mapping |
| `undefined` | NO | Explicitly listed values only; NOT asserted to be MECE |

**Code impact**:

```typescript
function getValuesForContext(contextId: string): ContextValue[] {
  const ctx = contextRegistry.getContext(contextId);
  if (!ctx) return [];
  
  // If otherPolicy is null or undefined, don't include "other" in enumeration
  // (even if it exists in the values array)
  if (ctx.otherPolicy === 'null' || ctx.otherPolicy === 'undefined') {
    return ctx.values.filter(v => v.id !== 'other');
  }
  
  // For computed or explicit, include all values (including "other")
  return ctx.values;
}
```

#### B. Impact on MECE Detection

**When checking if windows form a MECE partition**:

```typescript
function detectMECEPartition(
  windows: ParameterValue[],
  contextKey: string,
  contextRegistry: ContextRegistry
): { isMECE: boolean; isComplete: boolean; canAggregate: boolean; missingValues: string[] } {
  
  const contextDef = contextRegistry.getContext(contextKey);
  if (!contextDef) {
    return { isMECE: false, isComplete: false, canAggregate: false, missingValues: [] };
  }
  
  // Get expected values based on otherPolicy
  const expectedValues = getExpectedValues(contextDef);
  
  // Extract values from windows
  const windowValues = extractValuesFromWindows(windows, contextKey);
  
  // Check completeness
  const missingValues = expectedValues.filter(v => !windowValues.has(v));
  const isComplete = missingValues.length === 0;
  
  // Can we aggregate (sum) across all windows for this key?
  const canAggregate = determineIfCanAggregate(contextDef, isComplete);
  
  return {
    isMECE: true,  // Assume MECE if values match registry
    isComplete,
    canAggregate,
    missingValues,
  };
}

function determineIfCanAggregate(
  contextDef: ContextDefinition,
  isComplete: boolean
): boolean {
  
  switch (contextDef.otherPolicy) {
    case 'null':
      // Values are MECE; can aggregate if we have all of them
      return isComplete;
      
    case 'computed':
    case 'explicit':
      // Values + "other" are MECE; can aggregate if we have all (including "other")
      return isComplete;
      
    case 'undefined':
      // Values are NOT MECE; cannot safely aggregate even if we have all of them
      return false;
      
    default:
      return false;
  }
}
```

#### C. Impact on Query Building (Adapters)

**When building Amplitude query for `context(channel:other)`**:

```typescript
function buildFilterForContextValue(
  key: string,
  value: string,
  source: string
): string {
  
  const mapping = contextRegistry.getSourceMapping(key, value, source);
  
  if (value === 'other') {
    const contextDef = contextRegistry.getContext(key);
    
    if (contextDef.otherPolicy === 'computed') {
      // Generate NOT filter dynamically
      const explicitValues = contextDef.values.filter(v => v.id !== 'other');
      const explicitFilters = explicitValues.map(v => {
        const m = contextRegistry.getSourceMapping(key, v.id, source);
        return m?.filter || `${contextDef.field} == '${v.id}'`;
      });
      
      // Return: NOT (value1 OR value2 OR ...)
      return `NOT (${explicitFilters.join(' OR ')})`;
    }
    
    if (contextDef.otherPolicy === 'explicit') {
      // Use explicit filter from mapping
      if (!mapping?.filter) {
        throw new Error(`otherPolicy=explicit but no filter defined for ${key}:other`);
      }
      return mapping.filter;
    }
    
    // If otherPolicy is null or undefined, "other" shouldn't be queryable
    throw new Error(`Cannot query ${key}:other with otherPolicy=${contextDef.otherPolicy}`);
  }
  
  // Regular (non-other) value: use filter from mapping
  if (!mapping?.filter) {
    throw new Error(`No ${source} mapping for ${key}:${value}`);
  }
  return mapping.filter;
}
```

#### D. Impact on UI Value Lists

**In Add Context dropdown and per-chip dropdowns**:

- `otherPolicy: null` → Show only explicit values (google, meta, direct); no "other" checkbox
- `otherPolicy: computed` → Show explicit values + "other" (all queryable)
- `otherPolicy: explicit` → Show explicit values + "other" (all queryable)
- `otherPolicy: undefined` → Show only explicit values; no "other" checkbox

**Implication for "all values checked = remove chip"**:

- Only applies when otherPolicy allows aggregation (null, computed, explicit)
- If otherPolicy=undefined, checking all visible values does NOT mean "all data" (can't remove chip)

---

### 3. Regex Pattern Support for Source Mappings

**Problem**: Raw source values are often high-cardinality or messy (e.g., UTM sources like `"google_search_brand_exact"`, `"google_display_retargeting"`, etc.).

**Solution**: Allow regex patterns to collapse many raw values into one logical value.

**Registry example**:

```yaml
contexts:
  - id: source
    name: Traffic Source
    type: categorical
    otherPolicy: computed
    
    values:
      - id: google
    label: Google (All)
        sources:
          amplitude:
            field: utm_source
            # Pattern matches any utm_source starting with "google"
            pattern: "^google"
            patternFlags: "i"  # Case-insensitive
            # Adapter will generate: utm_source matches '^google' (case-insensitive)
            
      - id: facebook
    label: Facebook/Instagram
        sources:
          amplitude:
            field: utm_source
            pattern: "^(facebook|instagram|fb|ig)"
            patternFlags: "i"
            
      - id: other
    label: Other Sources
        sources:
          amplitude:
            # Computed: NOT (google OR facebook patterns)
```

**Adapter logic with regex**:

```typescript
function buildFilterForContextValue(
  key: string,
  value: string,
  source: string
): string {
  
  const mapping = contextRegistry.getSourceMapping(key, value, source);
  const contextDef = contextRegistry.getContext(key);
  
  // If pattern provided, use regex matching
  if (mapping?.pattern) {
    const flags = mapping.patternFlags || '';
    // Amplitude syntax for regex (check API docs for exact syntax)
    return `${contextDef.field} matches '${mapping.pattern}'${flags ? ` (${flags})` : ''}`;
  }
  
  // Otherwise use explicit filter
  if (mapping?.filter) {
    return mapping.filter;
  }
  
  // Handle computed "other"
  if (value === 'other' && contextDef.otherPolicy === 'computed') {
    return buildComputedOtherFilter(key, source);
  }
  
  throw new Error(`No ${source} mapping for ${key}:${value}`);
}

function buildComputedOtherFilter(key: string, source: string): string {
  const contextDef = contextRegistry.getContext(key);
  const explicitValues = contextDef.values.filter(v => v.id !== 'other');
  
  const filters: string[] = [];
  for (const v of explicitValues) {
    const mapping = contextRegistry.getSourceMapping(key, v.id, source);
    
    if (mapping?.pattern) {
      // If explicit value uses pattern, include pattern in NOT clause
      const flags = mapping.patternFlags || '';
      filters.push(`${contextDef.field} matches '${mapping.pattern}'${flags ? ` (${flags})` : ''}`);
    } else if (mapping?.filter) {
      filters.push(mapping.filter);
    }
  }
  
  // Return: NOT (all explicit filters ORed together)
  return `NOT (${filters.join(' OR ')})`;
}
```

**Benefits**:
- Single regex `"^google"` captures `google_search`, `google_display`, `google_shopping`, etc.
- Registry stays small and maintainable
- Raw value space can be arbitrarily large; we collapse to manageable logical enum
- "other" computation automatically handles new raw values without registry updates

### 2. Registry Loading & Validation

**File**: `graph-editor/src/services/contextRegistry.ts`

```typescript
export interface ContextDefinition {
  id: string;
  name: string;
  description: string;
  type: 'categorical' | 'ordinal' | 'continuous';
  otherPolicy: 'null' | 'computed' | 'explicit' | 'undefined';  // NEW field (add to schema)
  values: ContextValue[];
  comparison_support?: boolean;  // Existing schema field (for ordinal)
  default_value?: string;         // Existing schema field
  metadata: {                     // Existing schema field (required)
    category?: string;
    data_source?: string;
    created_at: string;
    updated_at?: string;
    version: string;
    status: 'active' | 'deprecated' | 'draft';
    author?: string;
    deprecation_notice?: string;
    replacement_context_id?: string;
  };
}

export interface ContextValue {
  id: string;
  label: string;        // Schema field name (not displayName)
  description?: string;
  order?: number;       // For ordinal contexts
  aliases?: string[];   // Alternative identifiers
  sources: Record<string, SourceMapping>;  // NEW: source-specific mappings
}

export interface SourceMapping {
  field?: string;           // Source property name (e.g., "utm_source", "browser")
  filter?: string;          // Filter expression for this value (e.g., "utm_source == 'google'")
  pattern?: string;         // Regex pattern for matching raw values to this logical value
  patternFlags?: string;    // Regex flags (e.g., "i" for case-insensitive)
  
  // For complex mappings: either filter OR pattern, not both
  // If pattern provided: adapter matches raw values against pattern, then builds appropriate filter
}


---

### 3. Graph-Level Validation of Pinned DSL

Pinned DSL (`dataInterestsDSL`) must be **consistent** with the context registry:

- All `context(key:value)` references must:
  - Use a known `key` from `contexts.yaml`
  - Use a known `value` under that key
- Any mismatch is treated as a **configuration error**, but we **degrade gracefully** in the UI.

**Validation points**:

1. **On graph save**:
   - Run parser on `dataInterestsDSL`
   - For each `context(key:value)`:
     - If `key` or `value` unknown → show inline error in modal + WARN ON  save  [DO NOT BLOCK SAVE]
   - For each bare `context(key)`:
     - If key unknown → error
   - This prevents obviously broken pinned configs from being persisted.

2. **On graph load**:
   - Re-validate `dataInterestsDSL` against current registry
   - If mismatches:
     - Context UI for that graph is **disabled** (no context dropdown)
     - Show a non-blocking toast: "Pinned contexts refer to unknown key:value pairs; please fix in graph settings."
     - Nightly runner skips this graph until fixed.

3. **Nightly runner**:
   - Assumes `dataInterestsDSL` has passed validation
   - If parsing still fails (e.g. malformed DSL), log warning and skip graph
   - No hard crash; other graphs continue to run

**Error policy**:
- For **pinned DSL in settings modal** → we can WARN ON Save on validation errors (authoring-time feedback).
- For **runtime usage (graphs already saved)** → never hard fail user interaction; instead:
  - Disable context UI where impossible to interpret
  - Show clear toast + log error for investigation

---

### 4. Summary: otherPolicy Impact Matrix

Quick reference showing how `otherPolicy` affects different parts of the system:

| System | `null` | `computed` | `explicit` | `undefined` |
|--------|--------|------------|------------|-------------|
| **"other" in value enum?** | NO | YES | YES | NO |
| **"other" queryable?** | NO (error) | YES (dynamic filter) | YES (explicit filter) | NO (error) |
| **MECE assertion?** | YES (explicit MECE) | YES (explicit + other MECE) | YES (explicit + other MECE) | NO (incomplete) |
| **Can aggregate across key?** | If complete | If complete (inc. "other") | If complete (inc. "other") | Never |
| **UI dropdown shows "other"?** | NO | YES | YES | NO |
| **All-checked removes chip?** | YES (semantic: no filter) | YES (semantic: no filter) | YES (semantic: no filter) | NO (not all data) |
| **Adapter "other" filter** | N/A | Computed: NOT (explicit) | From registry mapping | N/A |
| **Typical use case** | Complete enum (e.g., A/B test variants) | Open property with catch-all (e.g., utm_source) | Custom "other" grouping (e.g., minor channels lumped) | Exploratory, incomplete tagging |

**Core principle**: 
- `null`, `computed`, `explicit` → MECE keys where summing all values gives "total" (safe aggregation)
- `undefined` → Non-MECE keys where values don't exhaust the space (unsafe to aggregate; only filter/slice)

**Implementation requirements**:
1. **UI** (`ContextValueSelector`): Check `otherPolicy` before including "other" in dropdown checkboxes
2. **MECE detection** (`detectMECEPartition`): Use `otherPolicy` to determine `canAggregate` flag
3. **Adapter** (`buildFilterForContextValue`): Handle `otherPolicy: computed` by dynamically generating NOT filter
4. **Aggregation** (`aggregateWindowsWithContexts`): Check `canAggregate` before summing across context values
5. **All-checked logic** (UI): Only remove chip if `otherPolicy !== 'undefined'`

---

## Adapter Extensions

### Research Summary: Amplitude Dashboard REST API (for contexts)

**Goal**: Understand how to express Dagnet context slices as Amplitude queries, and what we need to store back on var files.

#### 1. Relevant APIs

- **Dashboard REST API** (Analytics):  
  - Provides read access to the same aggregates you see in the Amplitude UI.  
  - Key endpoints (conceptual):  
    - **Funnels**: “from → to” conversion counts over a date range, with property filters and breakdowns.  
    - **Segmentation / Events**: counts for a single event type, optionally segmented by properties, over a date range.  
  - All of these:
    - Take **start/end date** parameters (YYYY-MM-DD or ISO timestamps).  
    - Allow **property filters** and **segmentation** by event or user properties.  
    - Can return **aggregates** (total counts) and, for some endpoints, **time-series** buckets (daily, weekly, etc.).

- **Export / HTTP Ingest APIs** are **not** directly relevant for contexts — we only care about query‑side filters, not ingestion.

#### 2. Property filters ↔ context mapping

Amplitude’s Dashboard REST API lets you filter by **event or user properties**, e.g.:
- `utm_source == 'google'`
- `browser == 'Chrome'`

For Dagnet contexts, this lines up cleanly with the design of `contexts.yaml`:

- Each context key (`channel`, `browser-type`, etc.) maps to:
  - a **source field** in Amplitude (e.g. `utm_source`, `browser`, custom event/user property), and  
  - a **filter expression** for each value (`google`, `meta`, `other`), expressed in Amplitude’s property filter syntax.

Therefore, for contexts we need to store, per (key, value, source):

- `field`: the Amplitude property name (e.g. `"utm_source"`, `"browser"`).  
- `filter`: a filter expression that can be dropped into the Dashboard REST API’s filter parameter for that value, e.g.:  
  - `"utm_source == 'google'"`  
  - `"utm_source in ['facebook', 'instagram']"`  
  - `"browser == 'Chrome'"`  

This matches the `sources[amplitude].field` / `sources[amplitude].filter` design already sketched in the registry section.

#### 3. Time windows & response shape

- **Request side**:  
  - All relevant endpoints accept a **start** and **end** time (date or timestamp).  
  - These map directly to Dagnet’s `window(start:end)` DSL: we resolve relative windows to absolute dates and pass them through.

- **Response side** (conceptually):  
  - Funnels: counts like `from_count`, `to_count`, and derived rates over the requested window.  
  - Segmentation: counts per event/property bucket, with optional time-series buckets (e.g. per day).  

For contexts v1 we only need, per query:

- **Aggregate n, k** (e.g. `from_count`, `to_count`) over the requested window, and optionally  
- **daily time-series** (if we choose to keep using `n_daily`, `k_daily`, `dates` for fine‑grained windows).

We do **not** need to store any Amplitude‑specific IDs for dashboards or charts — only the numeric counts and the time axis.

#### 4. What we need to persist on var files

Given the above, the minimal additional fields we need on var files for Amplitude‑backed context slices are:

- `sliceDSL`: Canonical DSL string describing **which slice** this is (contexts + window).  
- Existing numeric data:
  - `n`, `k`, `mean`, `stdev` (as today).  
  - Optionally `n_daily`, `k_daily`, `dates` if we fetch time-series buckets instead of a single aggregate.

We **do not** need to persist:
- Raw Amplitude query JSON.  
- Dashboard IDs.  
- Property filter syntax, beyond what is already encoded in `sliceDSL` + `contexts.yaml`.

The Amplitude adapter can always reconstruct the query solely from:
- the edge/graph HRN (what we are measuring),  
- the **resolved context mapping** from `contexts.yaml`, and  
- the **resolved time window** from `window(...)` in the slice/query DSL.

#### 5. DAS adapter implications (condensed)

- When building a DAS query for Amplitude from a slice or `currentQueryDSL`:
  1. Parse the DSL into constraints (visited, context, window).  
  2. For each `context(key:value)` / `contextAny(key:...)`:  
     - Look up `sources[amplitude].field` + `filter` in the context registry.  
     - Combine all such filters into the Dashboard REST API’s property filter parameter (AND across keys, OR within `contextAny`).  
  3. Resolve `window(start:end)` to absolute dates and pass as `start`, `end` in the API call.  
  4. Call the appropriate endpoint (funnel vs segmentation), then:
     - Extract `n`, `k` (and optionally daily buckets) from the response.  
     - Write/update the corresponding `sliceDSL` window on the var file.

This closes the original open question at a design level; the remaining work is to wire the exact parameter names and response paths once we plug into a concrete Amplitude project.

---

### 1. Amplitude DAS Adapter (Pending API Research)

**File**: `graph-editor/src/lib/das/amplitudeAdapter.ts` (or buildDslFromEdge.ts)

**Current state** (from codebase review):
- `buildDslFromEdge.ts` builds DSL object with `from`, `to`, `visited`, etc.
- `DASRunner.ts` executes queries and returns `{ success: boolean; raw: {...} }`
- Response includes `from_count`, `to_count`, and optionally `time_series` array

#### Extend query builder to handle contexts

```typescript
interface AmplitudeQueryBuilder {
  buildQuery(variable: Variable, constraints: ParsedConstraints): AmplitudeQuery;
}

function buildQuery(variable: Variable, constraints: ParsedConstraints): AmplitudeQuery {
  const query: AmplitudeQuery = {
    // ... existing base query structure ...
  };
  
  // Add context filters
  const filters: string[] = [];
  
  for (const ctx of constraints.contexts) {
    const mapping = contextRegistry.getSourceMapping(ctx.key, ctx.value, 'amplitude');
    if (!mapping || !mapping.filter) {
      throw new Error(`No Amplitude mapping for context ${ctx.key}:${ctx.value}`);
    }
    filters.push(mapping.filter);
  }
  
  for (const ctxAny of constraints.contextAnys) {
    // contextAny is OR over values for a given key
    // Group by key, build OR clause per key, then AND across keys
    const byKey = groupBy(ctxAny.pairs, p => p.key);
    
    for (const [key, pairs] of Object.entries(byKey)) {
      const orClauses = pairs.map(p => {
        const mapping = contextRegistry.getSourceMapping(key, p.value, 'amplitude');
        if (!mapping || !mapping.filter) {
          throw new Error(`No Amplitude mapping for context ${key}:${p.value}`);
        }
        return mapping.filter;
      });
      
      filters.push(`(${orClauses.join(' or ')})`);
    }
  }
  
  // Handle "other" buckets if needed
  // If a context key has an "other" value and otherPolicy=computed:
  // Generate filter as NOT (all other specified values)
  // Implementation TBD based on final registry schema
  
  // Add date window filter
  if (constraints.window) {
    const { startDate, endDate } = resolveWindowDates(constraints.window);
    query.start = startDate.toISOString();
    query.end = endDate.toISOString();
  }
  
  // Combine filters into query
  query.filters = filters.join(' and ');
  
  return query;
}

function resolveWindowDates(window: WindowConstraint): { startDate: Date; endDate: Date } {
  const now = new Date();
  
  let startDate: Date;
  if (!window.start) {
    startDate = new Date(0);  // beginning of time
  } else if (window.start.match(/^-?\d+[dwmy]$/)) {
    // Relative offset
    startDate = applyRelativeOffset(now, window.start);
  } else {
    // Absolute date in d-MMM-yy format
    startDate = parseUKDate(window.start);
  }
  
  let endDate: Date;
  if (!window.end) {
    endDate = now;
  } else if (window.end.match(/^-?\d+[dwmy]$/)) {
    endDate = applyRelativeOffset(now, window.end);
  } else {
    endDate = parseUKDate(window.end);
  }
  
  return { startDate, endDate };
}

function applyRelativeOffset(base: Date, offset: string): Date {
  const match = offset.match(/^(-?\d+)([dwmy])$/);
  if (!match) throw new Error(`Invalid relative offset: ${offset}`);
  
  const amount = parseInt(match[1]);
  const unit = match[2];
  
  const result = new Date(base);
  switch (unit) {
    case 'd':
      result.setDate(result.getDate() + amount);
      break;
    case 'w':
      result.setDate(result.getDate() + amount * 7);
      break;
    case 'm':
      result.setMonth(result.getMonth() + amount);
      break;
    case 'y':
      result.setFullYear(result.getFullYear() + amount);
      break;
  }
  
  return result;
}
```

### 2. Sheets Adapter & Fallback Policy

**File**: `graph-editor/src/services/ParamPackDSLService.ts` (already handles Sheets param-pack ingestion)

**Current state**:
- Sheets adapter parses HRNs like `e.edge-id.visited(...).p.mean`
- Already has regex for conditional patterns (line 426)
- Stores conditions in `conditional_ps` array on edges

#### Context Handling (Simple Extension)

Sheets users supply context-labeled parameters directly:

```yaml
e.landing-conversion.context(channel:google).p.mean: 0.15
e.landing-conversion.context(channel:meta).p.mean: 0.12
e.landing-conversion.p.mean: 0.10  # Uncontexted fallback
```

**Extension needed**: Already supported! The existing regex includes `context` pattern. Just ensure normalization happens.

#### Fallback Policy (Resolved)

**Scenario**: User queries `e.my-edge.context(source:google).p.mean` but Sheets only has `e.my-edge.p.mean`.

**Policy Options**:

| Option | Behavior | Pros | Cons |
|--------|----------|------|------|
| **A. Strict (fail)** | Throw error if exact context not found | Explicit, prevents silent errors | Requires all contexts in Sheets |
| **B. Fallback with warning** | Use uncontexted value, show warning in UI | Pragmatic, works with sparse data | Could hide data quality issues |
| **C. Configurable** | Per-connection or per-graph setting | Flexible | Added complexity |
| **D. Return null** | Treat as missing data | Safe, explicit | Requires manual data entry |

**Recommended for v1**: **Option B (Fallback with warning)**

**Rationale**:
- Sheets is often manually maintained, incomplete data is common
- Strict mode would break many existing Sheets-based graphs
- Warning in UI alerts user to data quality issue without blocking
- Can add strict mode as opt-in later

**Implementation**:

```typescript
function resolveSheetParameter(
  hrn: string,
  paramPack: Record<string, unknown>,
  fallbackPolicy: 'strict' | 'fallback' = 'fallback'
): { value: number | null; warning?: string } {
  
  // Try exact match first
  if (hrn in paramPack) {
    return { value: paramPack[hrn] as number };
  }
  
  if (fallbackPolicy === 'strict') {
    return { value: null, warning: `Exact match for ${hrn} not found` };
  }
  
  // Fallback: try uncontexted version
  const uncontextedHrn = removeContextFromHRN(hrn);
  if (uncontextedHrn in paramPack) {
    return {
      value: paramPack[uncontextedHrn] as number,
      warning: `Using uncontexted fallback for ${hrn}`,
    };
  }
  
  return { value: null, warning: `No data found for ${hrn} (tried contexted and uncontexted)` };
}

function removeContextFromHRN(hrn: string): string {
  // Remove all context(...) clauses from HRN
  return hrn.replace(/\.context\([^)]+\)/g, '');
}
```

---

## Window Aggregation Logic (Complete Redesign)

**Files affected**:
- `graph-editor/src/services/windowAggregationService.ts` (existing, ~818 lines)
- `graph-editor/src/services/dataOperationsService.ts` (uses window aggregation)

### Current State Review

**Existing capabilities** (from windowAggregationService.ts):
1. Aggregates daily time-series (`n_daily`, `k_daily`, `dates`) into window stats
2. Handles date range filtering and incremental fetching
3. Detects missing dates and gaps
4. Computes weighted mean, pooled stdev

**Current limitations**:
1. No context-aware filtering
2. No MECE partition detection
3. No logic for aggregating across multiple windows
4. No overlap/partial overlap handling

### New Requirements

1. **Slice isolation (CRITICAL)**: All functions MUST filter by `sliceDSL` before any logic
   - First line: `const matchingValues = values.filter(v => v.sliceDSL === targetSlice)`
   - Never aggregate across different slices
   - Assertion: If `values` contains contexts data but no `targetSlice` specified → error
2. **Context matching**: Filter windows by context constraints from query
3. **MECE aggregation**: Detect when windows are MECE partitions and sum correctly
4. **Overlap handling**: Comprehensive logic for all overlap scenarios
5. **Fetch gap detection**: Identify missing slices and commission new queries

### Data Lookup Pattern (MANDATORY)

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

### The 2D Grid: Context × Date

**Core model**: Each context combination paired with each date represents a **cell** in a 2-dimensional grid.

- **X-axis (Context)**: Context combinations (e.g., `{channel: google}`, `{channel: meta, browser-type: chrome}`, or uncontexted `{}`).
- **Y-axis (Date)**: Daily buckets (`YYYY-MM-DD` for Amplitude, or coarser buckets for non-daily sources).

A user query `context(...) + window(start:end)` selects a **rectangle** in this grid:
- **Horizontally**: One or more context combinations.
- **Vertically**: A date range.

Our aggregation logic must:
1. **Reuse** any existing cells in the rectangle (from prior queries).
2. **Generate subqueries only for missing cells** (per-context, per-date-range gaps).
3. **Aggregate** over the filled rectangle to produce the final result.

---

### Source Policy: Daily vs Non-Daily

#### Daily-Capable Sources (e.g., Amplitude)

For sources that return daily time-series:

- Always query for **daily buckets** (`n_daily`, `k_daily`, `dates` arrays).
- Store these in the var file per `(context combination)` slice.
- Any new window query is answered by:
  - Collecting all existing daily points for that context over the requested range.
  - Using **incremental fetch** (extend existing `calculateIncrementalFetch`) to fill in missing days only.
  - Aggregating over the requested date subset.

**Key benefit**: Arbitrary window queries (any `start:end`) are handled **without requiring "exact window match"**—we simply sum the appropriate per-day cells.

#### Non-Daily Sources (Pure Aggregates)

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

### Daily Grid Aggregation: Step-by-Step

**Extending existing `windowAggregationService` and `calculateIncrementalFetch` logic.**

#### Step 1: Determine Context Combinations (C)

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

#### Step 2: Per-Context Daily Coverage Check

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

#### Step 3: Generate Subqueries for Missing Daily Cells

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

#### Step 4: Execute Subqueries and Merge Results

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

#### Step 5: Aggregate Over the Filled Rectangle

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

/**
 * Try to aggregate across a MECE partition when query has no context constraints.
 * 
 * CRITICAL EDGE CASE: When we have windows for multiple keys (e.g., browser-type AND channel),
 * we can only aggregate across MECE keys. Non-MECE keys are ignored.
 * 
 * Example:
 *   - Windows: browser-type:chrome, browser-type:safari, browser-type:firefox (MECE, otherPolicy:null)
 *   - Also: channel:google, channel:meta (NOT MECE, otherPolicy:undefined, missing others)
 *   - Query: uncontexted (no context constraint)
 *   - Result: Aggregate across browser-type (ignore channel slices)
 */
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

**Reuses existing**: `aggregateWindow` from `windowAggregationService` for per-context time aggregation.

---

### Window Overlap Scenarios (Revised with Daily Grid)

With the daily grid model, the previous "scenarios matrix" simplifies because **temporal overlap is handled at the day level**:

| # | Scenario | How Daily Grid Handles It |
|---|----------|----------------------------|
| 1 | Exact date window + exact context match | Collect existing daily points for that context; if full coverage, aggregate directly |
| 2 | Query window larger than stored window | Existing days are reused; missing days trigger incremental fetch for those specific dates |
| 3 | Query window smaller than stored window | Filter existing daily series to the requested subset of dates; no new fetch needed |
| 4 | Query window partially overlaps stored window | Reuse overlapping days; fetch non-overlapping days |
| 5 | Multiple stored windows with overlapping dates for same context | De-duplicate by date key; policy: latest write wins (or error if conflict detected) |
| 6 | Query has no context constraint, data has MECE partition | Aggregate across all context values (MECE check); per-context daily series are summed independently, then combined |
| 7 | Query has context constraint, data has finer partition (e.g., query=channel:google, data=channel:google+browser:chrome/safari) | Aggregate across browser dimension (MECE check on browser), summing daily series within each day |

**Key insight**: The "partial overlap (ambiguous)" rows from the old matrix (scenarios 8, 9) **disappear** when we work at day-level granularity. Overlapping windows just mean "some days appear in multiple slices," which we resolve via de-duplication by date key.

---

### MECE Detection Algorithm (Revised with otherPolicy)

**Input**: Set of windows, context key from context registry

**Output**: MECE status, completeness, whether aggregation is safe

```typescript
function detectMECEPartition(
  windows: ParameterValue[],
  contextKey: string,
  contextRegistry: ContextRegistry
): { 
  isMECE: boolean;        // Are values mutually exclusive?
  isComplete: boolean;    // Do we have all expected values?
  canAggregate: boolean;  // Is it safe to sum n/k across these windows?
  missingValues: string[];
  policy: string;         // Which otherPolicy applies
} {
  
  // Get context definition
  const contextDef = contextRegistry.getContext(contextKey);
  if (!contextDef) {
    return { isMECE: false, isComplete: false, canAggregate: false, missingValues: [], policy: 'unknown' };
  }
  
  // Get expected values based on otherPolicy
  const expectedValues = getExpectedValuesForPolicy(contextDef);
  
  // Extract values from windows
  const windowValues = new Set<string>();
  for (const window of windows) {
    const parsed = parseConstraintString(window.sliceDSL || '');
    const contextConstraint = parsed.contexts.find(c => c.key === contextKey);
    if (contextConstraint) {
      windowValues.add(contextConstraint.value);
    }
  }
  
  // Check for duplicates (non-MECE)
  if (windowValues.size < windows.length) {
    return { 
      isMECE: false, 
      isComplete: false, 
      canAggregate: false, 
      missingValues: [], 
      policy: contextDef.otherPolicy 
    };
  }
  
  // Check for extras (values not in registry)
  const hasExtras = Array.from(windowValues).some(v => !expectedValues.has(v));
  if (hasExtras) {
    return { 
      isMECE: false, 
      isComplete: false, 
      canAggregate: false, 
      missingValues: [], 
      policy: contextDef.otherPolicy 
    };
  }
  
  // Check completeness
  const missingValues = Array.from(expectedValues).filter(v => !windowValues.has(v));
  const isComplete = missingValues.length === 0;
  
  // Determine if aggregation is safe
  const canAggregate = determineAggregationSafety(contextDef, isComplete);
  
  return {
    isMECE: true,
    isComplete,
    canAggregate,
    missingValues,
    policy: contextDef.otherPolicy,
  };
}

function getExpectedValuesForPolicy(contextDef: ContextDefinition): Set<string> {
  const values = new Set<string>();
  
  switch (contextDef.otherPolicy) {
    case 'null':
      // Only explicit values; no "other"
      for (const v of contextDef.values) {
        if (v.id !== 'other') values.add(v.id);
      }
      break;
      
    case 'computed':
    case 'explicit':
      // All values including "other"
      for (const v of contextDef.values) {
        values.add(v.id);
      }
      break;
      
    case 'undefined':
      // Only explicit values; no "other"; NOT MECE
      for (const v of contextDef.values) {
        if (v.id !== 'other') values.add(v.id);
      }
      break;
  }
  
  return values;
}

function determineAggregationSafety(
  contextDef: ContextDefinition,
  isComplete: boolean
): boolean {
  /**
   * IMPORTANT SEMANTICS:
   * - This flag means "safe to treat aggregation across this key as COMPLETE (total space)".
   * - Even when this returns false (e.g. otherPolicy='undefined'), we may still aggregate
   *   the available slices, but MUST surface the result as PARTIAL with a warning.
   */
  switch (contextDef.otherPolicy) {
    case 'null':
    case 'computed':
    case 'explicit':
      // MECE assured; safe to TREAT aggregation as complete only if we have all values
      return isComplete;
      
    case 'undefined':
      // NOT MECE; we can still sum available slices, but NEVER treat as complete
      return false;
      
    default:
      return false;
  }
}
```

**Key insight**: `otherPolicy` determines not just "is there an other bucket" but "is this key MECE at all" (can we safely sum values to get total).

---

### 3. Regex Pattern Support for Source Mappings

**Use case**: Collapse high-cardinality raw property values into manageable logical values.

**Example**: UTM sources in Amplitude might be:
- `"google_search_brand_exact"`
- `"google_search_generic_broad"`  
- `"google_display_retargeting"`
- `"facebook_feed_carousel"`
- `"facebook_stories_video"`

We want to map these to:
- Logical value `google` (for all google variants)
- Logical value `facebook` (for all facebook variants)

**Registry with patterns**:

```yaml
contexts:
  - id: source
    name: Traffic Source
    type: categorical
    otherPolicy: computed
    
    values:
      - id: google
    label: Google
        sources:
          amplitude:
            field: utm_source
            pattern: "^google"      # Matches anything starting with "google"
            patternFlags: "i"        # Case-insensitive
            
      - id: facebook
    label: Facebook/Instagram
        sources:
          amplitude:
            field: utm_source
            pattern: "^(facebook|instagram|fb|ig)_"
            patternFlags: "i"
            
      - id: organic
    label: Organic
        sources:
          amplitude:
            field: utm_source
            filter: "utm_source is null OR utm_source == 'organic'"
            # No pattern; explicit filter for this case
            
      - id: other
    label: Other
        # Computed automatically: NOT (google OR facebook OR organic patterns)
```

**Adapter implementation**:

```typescript
function buildFilterFromMapping(
  mapping: SourceMapping,
  field: string
): string {
  
  // If pattern provided, build regex filter
  if (mapping.pattern) {
    const flags = mapping.patternFlags || '';
    
    // Amplitude syntax (example; verify with API docs)
    // Might be: field ~ 'pattern' or REGEXP_MATCH(field, 'pattern')
    return `REGEXP_MATCH(${field}, '${mapping.pattern}', '${flags}')`;
  }
  
  // Otherwise use explicit filter
  if (mapping.filter) {
    return mapping.filter;
  }
  
  throw new Error('Mapping must have either pattern or filter');
}
```

**When to use pattern vs filter**:

- **Pattern**: High-cardinality raw space that collapses to logical value (UTM sources, campaign names, etc.)
- **Filter**: Low-cardinality or complex boolean logic (e.g., `utm_source is null OR utm_source == 'organic'`)
- **Both**: Not allowed; use one or the other per value

**Discovery**: Future enhancement could scan Amplitude property values, match against patterns, report unmapped raw values as candidates for adding to registry or extending patterns.

### Complete Daily-Grid Aggregation Algorithm

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
 * - In future async mode, warnings will also be collected into logs, but v1 focuses on user-visible toasts.
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

**Key changes from old design**:
- Daily sources use `aggregateDailySource` with 2D grid logic (no "exact window match" requirement).
- Non-daily sources branch to `aggregateCoarseSource` with pro-rata fallback clearly documented.
- Reuses `aggregateWindow`, `mergeTimeSeriesIntoParameter`, `calculateIncrementalFetch` patterns from existing code.

### Subquery Batching & Execution Strategy

When `aggregateWindowsWithContexts` identifies missing cells in the (context × date) grid, it generates **SubQuerySpec** objects representing exactly the (context, date-range) pairs we need to fetch.

#### Batching Strategy

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

#### Merge Strategy

When merging fetched data into a variable, we find or create the window for the context combination and merge daily points:

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

This keeps var files from exploding with one window per (context, date-range) pair; instead we have one window per context, with a unified time series.

---

### Performance Considerations

**Question**: Do we need an index for window lookup with contexts?

**Answer**: NO *persisted* index needed, but **in-memory indexing recommended** for acceptable query latency.

**Performance requirements**:
- Live queries in UI must complete in **<1s for aggregation** (excluding external API calls)
- At scale (100 params, 16 slices/param, 365 days each), we have:
  - ~1,600 total slices across all params
  - Per param: ~16 windows, each with ~365 daily points
  - Per query touching 10-20 params: scanning ~160-320 windows, aggregating over ~5K-10K daily points

**In-memory optimization strategy** (v1):

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

## Adapter Extensions

### Research Summary: Amplitude Dashboard REST API

Based on review of Amplitude's API documentation and existing codebase integration:

**Relevant APIs**:
- **Dashboard REST API**: Provides analytics endpoints for funnels and segmentation
- Supports property filters on event and user properties
- Returns aggregates (`from_count`, `to_count`) and optionally time-series (daily buckets)

**What we need for contexts**:

1. **Property Filters** (Amplitude `where` clause):
   - Event properties: `utm_source == 'google'`, `browser == 'Chrome'`
   - User properties: similar syntax
   - Complex filters: AND/OR logic supported

2. **Date Ranges**:
   - `start` and `end` parameters (ISO timestamps or dates)
   - Can request daily bucketing via parameters

3. **Response Fields**:
   - Aggregates: `from_count`, `to_count` (existing, already handled)
   - Time-series (if requested): `time_series: [{ date, n, k, p }]`
   - We currently use this in compositeQueryExecutor.ts

**What to store in var files**:
- Same as today: `n_daily`, `k_daily`, `dates` (YYYY-MM-DD format)
- Plus: `sliceDSL` to identify which context produced this data
- NO need for raw Amplitude query JSON or dashboard IDs

**Contexts.yaml mappings**:

For each context value, we store:
- `field`: Amplitude property name (e.g., `utm_source`, `browser`)
- `filter`: Filter expression (e.g., `utm_source == 'google'`, `utm_source in ['facebook', 'instagram']`)

When building a query with `context(channel:google)`:
1. Look up `channel:google` in registry
2. Get `filter` for Amplitude source
3. Inject into Amplitude query's `where` clause
4. Multiple contexts → AND them together
5. contextAny → OR within key, AND across keys

**No schema changes to Amplitude response handling**: Existing `compositeQueryExecutor` and `DASRunner` already handle time-series responses; we just add context filters to the outgoing query.

---

### 1. Amplitude DAS Adapter

**File**: `graph-editor/src/lib/das/buildDslFromEdge.ts` (or equivalent)

**Current state** (from codebase review):
- `buildDslFromEdge.ts` builds DSL object with `from`, `to`, `visited`, etc.
- `DASRunner.ts` executes queries via compositeQueryExecutor
- Response includes `from_count`, `to_count`, and optionally `time_series` array

#### Extend query builder to inject context filters

```typescript
/**
 * Build Amplitude query DSL with context filters.
 * EXTENDS: existing buildDslFromEdge
 */
export async function buildDslFromEdge(
  edge: any,
  graph: any,
  connectionProvider?: string,
  eventLoader?: EventLoader,
  constraints?: ParsedConstraints  // NEW parameter
): Promise<DslObject> {
  
  // Existing logic to build base DSL with from/to/visited
  const baseDsl = await buildBaseDsl(edge, graph, connectionProvider, eventLoader);
  
  // NEW: Add context filters if constraints provided
  if (constraints && (constraints.contexts.length > 0 || constraints.contextAnys.length > 0)) {
    baseDsl.filters = buildContextFilters(constraints, connectionProvider || 'amplitude');
  }
  
  // NEW: Add window/date range if provided
  if (constraints && constraints.window) {
    const { startDate, endDate } = resolveWindowDates(constraints.window);
    baseDsl.start = startDate.toISOString();
    baseDsl.end = endDate.toISOString();
  }
  
  return baseDsl;
}

function buildContextFilters(
  constraints: ParsedConstraints,
  source: string
): string[] {
  const filters: string[] = [];
  
  // Process context(...) constraints
  for (const ctx of constraints.contexts) {
    const mapping = contextRegistry.getSourceMapping(ctx.key, ctx.value, source);
    if (!mapping ||!mapping.filter) {
      throw new Error(`No ${source} mapping for context ${ctx.key}:${ctx.value}`);
    }
    filters.push(mapping.filter);
  }
  
  // Process contextAny(...) constraints
  for (const ctxAny of constraints.contextAnys) {
    // Group by key
    const byKey = new Map<string, string[]>();
    for (const pair of ctxAny.pairs) {
      if (!byKey.has(pair.key)) {
        byKey.set(pair.key, []);
      }
      byKey.get(pair.key)!.push(pair.value);
    }
    
    // For each key, build OR clause
    for (const [key, values] of byKey.entries()) {
      const orClauses = values.map(value => {
        const mapping = contextRegistry.getSourceMapping(key, value, source);
        if (!mapping || !mapping.filter) {
          throw new Error(`No ${source} mapping for context ${key}:${value}`);
        }
        return mapping.filter;
      });
      
      if (orClauses.length === 1) {
        filters.push(orClauses[0]);
      } else {
        filters.push(`(${orClauses.join(' or ')})`);
      }
    }
  }
  
  return filters;
}
```

**Integration point**: When calling `buildDslFromEdge` from data operations or nightly runner, pass the `constraints` parameter derived from the query/slice DSL.

**Backward compatibility**: If `constraints` is not provided, function behaves exactly as today.

---

### 2. Sheets Adapter & Fallback Policy

**File**: `graph-editor/src/services/ParamPackDSLService.ts` (already handles Sheets param-pack ingestion)

**Current state**:
- Sheets adapter parses HRNs like `e.edge-id.visited(...).p.mean`
- Already has regex for conditional patterns (line 426)
- Stores conditions in `conditional_ps` array on edges

#### Context Handling (Simple Extension)

Sheets users supply context-labeled parameters directly:

```yaml
e.landing-conversion.context(channel:google).p.mean: 0.15
e.landing-conversion.context(channel:meta).p.mean: 0.12
e.landing-conversion.p.mean: 0.10  # Uncontexted fallback
```

**Extension needed**: Already supported! The existing regex includes `context` pattern. Just ensure normalization happens.

#### Fallback Policy (RESOLVED)

**Decision**: **Option B (Fallback with warning)**

**Scenario**: User queries `e.my-edge.context(source:google).p.mean` but Sheets only has `e.my-edge.p.mean`.

**Behavior**:
1. Try exact match first
2. If not found and policy is 'fallback', try uncontexted version
3. Show UI warning: "Using uncontexted fallback for source:google"
4. If neither found, return null with warning

**Implementation**:

```typescript
function resolveSheetParameter(
  hrn: string,
  paramPack: Record<string, unknown>,
  fallbackPolicy: 'strict' | 'fallback' = 'fallback'
): { value: number | null; warning?: string } {
  
  // Try exact match first
  if (hrn in paramPack) {
    return { value: paramPack[hrn] as number };
  }
  
  if (fallbackPolicy === 'strict') {
    return { value: null, warning: `Exact match for ${hrn} not found` };
  }
  
  // Fallback: try uncontexted version
  const uncontextedHrn = removeContextFromHRN(hrn);
  if (uncontextedHrn !== hrn && uncontextedHrn in paramPack) {
    return {
      value: paramPack[uncontextedHrn] as number,
      warning: `Using uncontexted fallback for ${hrn}`,
    };
  }
  
  return { value: null, warning: `No data found for ${hrn}` };
}

function removeContextFromHRN(hrn: string): string {
  // Remove all context(...) and contextAny(...) clauses from HRN
  return hrn.replace(/\.context(?:Any)?\([^)]+\)/g, '');
}
```

**Rationale**:
- Sheets is manually maintained; sparse data is common
- Strict mode would break many existing graphs
- Warning alerts user without blocking
- Can add strict mode as opt-in later

---

## UI Components & Flows

**See**: `CONTEXTS_UI_DESIGN.md` for complete visual design, user flows, and component specifications.

**Summary of UI approach**:

### WindowSelector Integration

**Component**: Extend existing `WindowSelector.tsx` (`graph-editor/src/components/WindowSelector.tsx`)

**What we add**:
1. **Context chips** (using enhanced QueryExpressionEditor):
   - Inline Monaco component showing contexts as chips: `[channel:google ▾✕]`
   - Dynamic width (60-450px) that grows smoothly as contexts added
   - Each chip has `▾` dropdown for value swapping (Apply/Cancel pattern)
   
2. **Add Context button** `[+ Context ▾]` or `[+ ▾]`:
   - Full label when empty; compact when contexts exist
   - Opens accordion dropdown with key:value pairs from `dataInterestsDSL`
   - **Mutual exclusion**: Expanding one key section auto-collapses and unchecks others
   - Enforces pinned scope via UI (arbitrary combos require Monaco editing)
   
3. **Unroll button** `[⤵]`:
   - Expands WindowSelector downward (one additional line)
   - Shows full `currentQueryDSL` as editable chips
   - Includes `[Pinned query]` button (tooltip shows `dataInterestsDSL`; click opens modal)

**What we remove**:
- Placeholder "Context" button (replaced with actual implementation)
- What-if button (moved to Scenarios panel where it belongs)

**What we reuse unchanged**:
- Date presets (Today, 7d, 30d, 90d)
- DateRangePicker component
- Fetch button and coverage checking logic
- Dropdown anchoring pattern (same as What-if dropdown)

### Key UI Components (NEW)

1. **ContextValueSelector** (shared component):
   - Mode: `'single-key'` (per-chip dropdown) or `'multi-key'` (Add Context dropdown)
   - Renders checkboxes, accordion sections, Apply/Cancel buttons
   - Handles mutual exclusion logic in multi-key mode

2. **Enhanced QueryExpressionEditor**:
   - Add chip rendering for `context`, `contextAny`, `window`
   - Embed `▾` button in context chips (opens ContextValueSelector)
   - Already has Monaco edit mode, autocomplete, validation

3. **Pinned Query Modal**:
   - Monaco editor for `dataInterestsDSL`
   - **Live summary of implied queries**:
     - Show **count** of atomic slices implied by `dataInterestsDSL` (after expansion)
     - Enumerate each implied slice as a human-readable line, e.g.  
       `context(channel:google).window(-90d:)`, `context(browser-type:chrome).window(-90d:)`
     - If count exceeds a safety threshold (e.g. 200 slices), show only first N and a message:  
       `"… plus 184 more slices. This may be too many for nightly runs."`
   - Save/Cancel buttons
   - **No hard failure**: If implied slice count is very large, we **warn** in the modal (and via toast) but do not prevent saving; future async logging will capture this as a configuration warning.

For detailed visual mockups, interaction flows, and implementation pseudocode, see `CONTEXTS_UI_DESIGN.md`.

---

## Nightly Runner Integration

### 1. Runner Algorithm

**File**: `python-backend/nightly_runner.py` (or equivalent)

```python
def run_nightly_for_graph(graph_id: str):
    graph = load_graph(graph_id)
    pinned_dsl = graph.get('dataInterestsDSL', 'window(-90d:)')  # default
    
    # Split on ';' to get list of pinned clauses
    clauses = pinned_dsl.split(';')
    
    # For each clause, explode into atomic slice expressions
    atomic_slices = []
    for clause in clauses:
        expanded = expand_clause(clause)
        atomic_slices.extend(expanded)
    
    # For each atomic slice and each variable, fetch and store
    for var_id in graph.get('variables', []):
        variable = load_variable(var_id)
        
        for slice_expr in atomic_slices:
            # Parse slice expression
            constraints = parse_constraints(slice_expr)
            
            # Inject default window if missing
            if not constraints.get('window'):
                constraints['window'] = {'start': '-90d', 'end': ''}
            
            # Build and execute query
            query = build_amplitude_query(variable, constraints)
            result = execute_query(query)
            
            # Store as new window
            new_window = {
                'n': result['n'],
                'k': result['k'],
                'mean': result['mean'],
                'stdev': result['stdev'],
                'sliceDSL': normalize_constraint_string(slice_expr),
            }
            
            variable['windows'] = variable.get('windows', [])
            variable['windows'].append(new_window)
            
            save_variable(variable)

def expand_clause(clause: str) -> List[str]:
    """
    Expand a clause into atomic slice expressions.
    
    Examples:
      - "context(channel)" → ["context(channel:google)", "context(channel:meta)", ...]
      - "or(context(channel), context(browser-type))" → all channel slices + all browser slices
      - "context(channel).window(-30d:)" → ["context(channel:google).window(-30d:)", ...]
    """
    
    # Parse the clause
    constraints = parse_constraints(clause)
    
    # Check for context() with no value (enumerate mode)
    # Check for or(...) expressions
    # Generate Cartesian product if multiple context keys present
    # Return list of fully-specified slice expressions
    
    # Implementation TBD; pseudocode:
    atomic = []
    
    if has_enum_context(constraints):
        # e.g. "context(channel)" with no specific value
        # Look up all values from registry and generate one slice per value
        for value in context_registry.get_values('channel'):
            atomic.append(f"context(channel:{value.id})")
    else:
        atomic.append(clause)
    
    return atomic
```

### 2. Scheduling & Deduplication

- Run nightly for all graphs with `dataInterestsDSL` set
- Before writing a new window, check if an equivalent `sliceDSL` already exists (by timestamp and context)
- If exists and fresh (< 24 hours old), skip; otherwise overwrite/update

---

## Component Reuse Confirmation

### Existing Components We're Extending (NOT Rebuilding)

**1. WindowSelector Component** (`WindowSelector.tsx`):
- **What it is**: The main query/search bar for graphs; contains date picker, What-if button, Context button placeholder (line 72)
- **What we add**:
  - Context chips display in the toolbar (between date picker and What-if)
  - `[▾]` caret to open Context Filters dropdown (similar to existing What-if dropdown pattern)
  - `[⤵ DSL]` unroll button to expand and show Monaco editor for `currentQueryDSL`
- **What we reuse unchanged**: Date presets, date picker (`DateRangePicker`), What-if dropdown infrastructure

**2. QueryExpressionEditor Component** (`QueryExpressionEditor.tsx`):
- **What it is**: Monaco-based query editor that renders as chips until user clicks to edit; supports autocomplete for `from`, `to`, `visited`, `case`, etc.
- **What we extend**:
  - Add `context`, `contextAny`, `window` to `outerChipConfig` (line 67-70 already has `context` placeholder!)
  - Add parsing for new constraint types in `parseQueryToChips` function (line 96)
  - Register new functions in Monaco language definition for autocomplete
- **What we reuse**: Entire chip rendering, edit mode toggle, Monaco mounting, validation, all existing for `visited`/`case`/etc.

**3. WhatIfAnalysisControl Component** (`WhatIfAnalysisControl.tsx`):
- **Reuse pattern**: The Context Filters dropdown should follow the same UI pattern as the What-if dropdown (anchored to WindowSelector, similar styling, close-on-outside-click behavior)
- **Not rebuilding**: We're not creating a parallel query builder; Context Filters is just a specialized UI for manipulating `currentQueryDSL`'s context terms via chips/checkboxes

**4. Monaco Language & Autocomplete** (`graph-editor/src/lib/queryDSL.ts`):
- **Extending `QUERY_FUNCTIONS`**: Add `context`, `contextAny`, `window` definitions for autocomplete
- **Already registered**: The `dagnet-query` language is already configured; we just add new functions to the existing vocabulary

### Architectural Principle

**We are NOT building parallel systems**. Every new component or function either:
- **Extends an existing component** (WindowSelector gains context chips; QueryExpressionEditor gains context/window chip rendering)
- **Reuses an existing utility** (parseDate, normalizeDate, calculateIncrementalFetch, aggregateWindow, mergeTimeSeriesIntoParameter)
- **Follows an existing pattern** (Context dropdown mirrors What-if dropdown; context chips follow same chip pattern as query chips)

This keeps code surface area minimal, testing burden manageable, and ensures consistent UX across the app.

---

## Testing Strategy

### Coverage Scope

All intricate aspects of the implementation MUST have comprehensive test coverage, including:
- **DSL parsing edge cases** (malformed, mixed constraints, normalization idempotence)
- **2D grid aggregation logic** (all 7 scenarios from revised matrix)
- **Subquery generation** (missing date ranges per context, batching, de-duplication)
- **MECE detection** (complete/incomplete partitions, cross-dimension)
- **Amplitude adapter** (context filter generation, query building, response handling)
- **Sheets fallback** (exact match, fallback, warnings)
- **UpdateManager** (rebalancing with context-bearing conditions)

**Test-driven approach**: Implement aggregation window logic and subquery generation WITH tests in parallel; each scenario from the matrix gets at least one test case.

### 1. Unit Tests

#### DSL Parsing & Normalization

**File**: `graph-editor/src/services/__tests__/constraintParser.test.ts` (NEW)

- ✓ Parse `context(key:value)` correctly
- ✓ Parse `contextAny(key:v1,v2,...)` correctly
- ✓ Parse `window(start:end)` with absolute and relative dates
- ✓ Parse complex chains: `visited(a).context(b:c).window(d:e).p.mean`
- ✓ `normalizeConstraintString` produces deterministic, sorted output
- ✓ `normalizeConstraintString` is idempotent (normalize(normalize(x)) === normalize(x))
- ✓ Date normalization: ISO → d-MMM-yy, relative offsets unchanged
- ✓ Handles malformed strings gracefully (error or return empty?)

#### Context Registry

**File**: `graph-editor/src/services/__tests__/contextRegistry.test.ts` (NEW)

- ✓ Load and parse `contexts.yaml`
- ✓ Validate schema (required fields, value uniqueness)
- ✓ Retrieve source mappings by context key + value + source
- ✓ **otherPolicy handling** (all 4 policies):
  - `null`: "other" not in enumeration; values asserted MECE
  - `computed`: "other" in enumeration; filter computed dynamically
  - `explicit`: "other" in enumeration with explicit filter
  - `undefined`: "other" not in enumeration; NOT MECE (aggregation disallowed)
- ✓ **Regex pattern support**:
  - Pattern matching for value mappings
  - Pattern + flags (case-insensitive, etc.)
  - Computed "other" with pattern-based explicit values
  - Error when both pattern and filter provided
- ✓ Detect unmapped context values (values not in registry)

#### Slice Isolation & Query Signatures (CRITICAL — Data Integrity)

**File**: `graph-editor/src/services/__tests__/sliceIsolation.test.ts` (NEW)

Test separation of indexing (sliceDSL) vs integrity (query_signature):

- ✓ **Slice lookup by sliceDSL**:
  - File contains 3 slices: `channel:google`, `channel:fb`, `channel:other`
  - All share same `query_signature` (same base config)
  - Lookup for `channel:google` returns ONLY that slice's data, not others
- ✓ **Incremental fetch isolation**:
  - `channel:google` has dates [1,2,5], `channel:fb` has dates [2,3,4]
  - Query for `channel:google` + window [1-5] should request dates [3,4] ONLY
  - NOT dates [1,5] (which would assume fb's data counts for google)
- ✓ **Signature mismatch handling**:
  - Slice has data with signature A
  - New query has signature B (config changed)
  - System warns but still uses slice (keyed by sliceDSL, not signature)
- ✓ **Empty sliceDSL handling**:
  - Legacy data without sliceDSL treated as empty string (uncontexted)
  - Can coexist with contexted slices in same file
- ✓ **Aggregation assertion**:
  - Call aggregation on file with contexts but no targetSlice specified
  - Should throw error, not silently aggregate mixed slices

#### Window Aggregation & MECE Logic (CRITICAL TEST COVERAGE)

**Files**: 
- `graph-editor/src/services/__tests__/windowAggregation.dailyGrid.test.ts` (NEW — daily grid model)
- `graph-editor/src/services/__tests__/windowAggregation.mece.test.ts` (NEW — MECE logic)
- `graph-editor/src/services/__tests__/windowAggregation.subqueries.test.ts` (NEW — subquery generation)

**Daily Grid Model Tests** (Section 5: The 2D Grid):

Test that **context × date** grid works correctly:

| Test # | Scenario | Expected Outcome |
|--------|----------|------------------|
| 1 | Query window = stored window (exact daily coverage) | Aggregate from existing daily points; no fetch |
| 2 | Query window < stored window (subset of days) | Filter daily series to requested range; no fetch |
| 3 | Query window > stored window (superset of days) | Reuse existing days; generate subqueries for missing days only |
| 4 | Query window partially overlaps stored (some overlap) | Reuse overlapping days; fetch non-overlapping days |
| 5 | Multiple windows for same context with duplicate dates | De-duplicate by date key; latest write wins |
| 6 | Query has no context, data has MECE partition | Aggregate across MECE context values; daily series summed per-day then totaled |
| 7 | Query has context, data has finer partition (e.g., query=channel:google, data=channel:google+browser:*) | Aggregate across finer dimension (MECE check), sum daily series |

**Subquery Generation Tests** (CRITICAL — Section 5: Step 3):

Test that `generateMissingSubqueries` correctly identifies gaps in the 2D grid:

- ✓ **Single context, no existing data**: Generates 1 subquery for full date range
- ✓ **Single context, partial date coverage**: 
  - Existing: days 1-10, 20-30
  - Query: days 1-30
  - Expected: 1 subquery for days 11-19
- ✓ **Single context, multiple gaps**:
  - Existing: days 1-5, 15-20
  - Query: days 1-30
  - Expected: 2 subqueries (days 6-14, days 21-30)
- ✓ **Multiple contexts, different coverage per context**:
  - Context A: has days 1-30
  - Context B: has days 1-10
  - Query: both contexts, days 1-30
  - Expected: 0 subqueries for A, 1 subquery for B (days 11-30)
- ✓ **MECE aggregation triggers subqueries for missing context values**:
  - Have: `context(channel:google)` for days 1-30
  - Query: uncontexted, days 1-30
  - Registry: channel has values {google, meta, other}, otherPolicy: computed
  - Expected: 2 subqueries (`channel:meta.window(1-Jan:30-Jan)`, `channel:other.window(1-Jan:30-Jan)`)
- ✓ **Mixed otherPolicy: aggregate across MECE key only** (CRITICAL EDGE CASE):
  - Have: `context(browser-type:chrome)`, `context(browser-type:safari)`, `context(browser-type:firefox)` (days 1-30)
  - Also: `context(channel:google)`, `context(channel:meta)` (days 1-30)
  - Registry: browser-type otherPolicy:null (MECE, complete); channel otherPolicy:undefined (NOT MECE)
  - Query: uncontexted, days 1-30
  - Expected: Aggregate across browser-type values ONLY (ignore channel slices)
  - Result: Sum of chrome + safari + firefox data
  - Warning: "Aggregated across MECE partition of 'browser-type' (complete coverage)"
- ✓ **Multiple MECE keys available**:
  - Have: All browser-type values (MECE) AND all device-type values (MECE)
  - Query: uncontexted
  - Expected: Aggregate across first complete MECE key (browser-type or device-type)
  - Warning: "Also have MECE keys {...} (would give same total if complete)"

**MECE Detection Tests** (with otherPolicy variants):

**otherPolicy: null** (values are MECE as-is):
- ✓ Complete partition (all values present) → `canAggregate: true`
- ✓ Incomplete partition (missing values) → `canAggregate: false`
- ✓ "other" value NOT included in expected values
- ✓ Cannot query for `context(key:other)` (error)

**otherPolicy: computed** (other = ALL - explicit):
- ✓ Complete partition (all explicit + "other") → `canAggregate: true`
- ✓ Missing "other" → `canAggregate: false`, missingValues includes "other"
- ✓ "other" filter built dynamically as NOT (explicit values)
- ✓ Works correctly when explicit values use regex patterns

**otherPolicy: explicit** (other has its own filter):
- ✓ Complete partition (all explicit + "other") → `canAggregate: true`
- ✓ "other" filter read from registry mapping
- ✓ Behaves like any other value

**otherPolicy: undefined** (NOT MECE):
- ✓ Even with all values present → `canAggregate: false` (never safe)
- ✓ "other" NOT included in expected values
- ✓ Warns user that aggregation across this key is unsupported
- ✓ Use case: exploratory context that's not yet well-defined

**General MECE tests**:
- ✓ Detects duplicate values (non-MECE)
- ✓ Detects extra values not in registry
- ✓ Handles windows with missing sliceDSL (treated as uncontexted)

**Cross-key aggregation tests** (mixed otherPolicy):
- ✓ **Scenario 1**: browser-type (MECE, null) + channel (NOT MECE, undefined)
  - Uncontexted query aggregates across browser-type only
  - Channel slices ignored (NOT MECE)
  - Result is complete
- ✓ **Scenario 2**: Both keys MECE (browser-type:null, channel:computed)
  - Either key can be used for aggregation
  - Prefer complete partition over incomplete
  - Warn that multiple MECE keys available
- ✓ **Scenario 3**: Both keys NOT MECE (browser-type:undefined, channel:undefined)
  - Cannot aggregate at all
  - Return error/warning: "No MECE partition available"
- ✓ **Scenario 4**: One key incomplete MECE, other NOT MECE
  - Use incomplete MECE key (browser-type missing 'other')
  - Status: 'partial_data' with missing values listed
  - Ignore NOT MECE key entirely

**Merge & De-duplication Tests**:
- ✓ `mergeTimeSeriesForContext` de-duplicates by date (latest wins)
- ✓ Handles existing + new daily data correctly
- ✓ Preserves `n_daily`, `k_daily`, `dates` array integrity

#### Sheets Fallback Policy

**File**: `graph-editor/src/services/__tests__/sheetsFallback.test.ts` (NEW)

- ✓ Exact match found → use it
- ✓ Exact match not found, uncontexted exists → fallback with warning
- ✓ Neither found → return null with warning
- ✓ Strict mode → error on missing exact match

#### Amplitude Adapter (Context Filters & Regex)

**File**: `graph-editor/src/lib/das/__tests__/amplitudeAdapter.contexts.test.ts` (NEW)

**Context filter generation**:
- ✓ Single `context(key:value)` → generates correct filter string
- ✓ Multiple contexts (AND) → filters combined with AND logic
- ✓ `contextAny(key:v1,v2)` → generates OR clause for values, AND across keys

**Regex pattern support**:
- ✓ Value with `pattern` field → generates regex filter (not literal filter)
- ✓ Pattern with flags (case-insensitive) → includes flags in query
- ✓ Multiple values with patterns → OR them correctly
- ✓ Error when value has both pattern and filter

**otherPolicy in adapter**:
- ✓ `otherPolicy: null` → error if user queries for "other"
- ✓ `otherPolicy: computed` → dynamically builds NOT (explicit values) filter
- ✓ `otherPolicy: computed` with patterns → NOT includes pattern-based filters
- ✓ `otherPolicy: explicit` → uses filter from "other" value mapping
- ✓ `otherPolicy: undefined` → error if user queries for "other"

### 2. Integration Tests

#### End-to-End Query Flow

1. User selects `context(channel:google)` + `window(1-Jan-25:31-Mar-25)` in UI
2. App aggregates windows; finds none matching
3. App shows "Fetch required" indicator
4. User clicks Fetch; query constructs with context filter
5. (Mock) Amplitude returns data
6. New window written to var with correct `sliceDSL = "context(channel:google).window(1-Jan-25:31-Mar-25)"`
7. Subsequent query for same slice finds cached window (status='exact_match')

#### Nightly Runner Explosion

1. Graph has `dataInterestsDSL = "context(channel);context(browser-type).window(-90d:)"`
2. Runner splits on `;` → 2 clauses
3. First clause `context(channel)` → enumerate all channel values from registry
4. Generates: `context(channel:google).window(-90d:)`, `context(channel:meta).window(-90d:)`, etc.
5. Second clause similar for browser-type
6. Runner executes all atomic queries
7. Each result stored as window with normalized `sliceDSL`

#### UpdateManager Rebalancing with Contexts

**File**: `graph-editor/src/services/__tests__/UpdateManager.contexts.test.ts` (NEW)

1. Create edge with `conditional_ps`:
   - `{ condition: "context(channel:google)", mean: 0.3 }`
   - `{ condition: "context(channel:google)", mean: 0.7 }` (sibling edge)
   - `{ condition: "context(channel:meta)", mean: 0.2 }` (different context)
2. Edit first entry to mean = 0.4
3. Verify second entry rebalanced to mean = 0.6 (same condition)
4. Verify third entry unchanged (different condition)
5. Verify per-condition PMF sums to 1.0

### 3. Regression Tests

- ✓ Existing graphs without `dataInterestsDSL` still load and work
- ✓ Existing windows without `sliceDSL` are treated as uncontexted, all-time
- ✓ Existing HRNs with `visited(...)`, `case(...)` still parse correctly
- ✓ ParamPackDSLService continues to handle non-contexted params
- ✓ Window aggregation for non-contexted queries works as before

---

## Rollout

**Note**: Contexts is a **new feature** built from scratch. No legacy data migration needed.

### Phase 1: Core Infrastructure

**Schema & Types**:
- Add `dataInterestsDSL` and `currentQueryDSL` to graph schema
- Add `sliceDSL` to `ParameterValue` (required field; empty string for legacy)
- Extend `context-definition-schema.yaml` (add `otherPolicy`, `sources` with `field`/`filter`/`pattern`)

**DSL Parsing**:
- Implement `constraintParser.ts` (shared parsing utility for `context`, `contextAny`, `window`)
- Update `query-dsl-1.0.0.json` schema (register new functions)
- Mirror changes in Python `query_dsl.py`

**Query Signature Service (NEW)**:
- Implement `querySignatureService.ts` (centralized signature generation/validation)
  - `buildDailySignature()` — excludes date bounds for daily-capable sources
  - `buildAggregateSignature()` — includes date bounds for aggregate sources
  - `validateSignature()` — checks if stored sig matches current spec
- Define `DataQuerySpec` interface (normalized form of "what we'd send to external source")

**Context Registry**:
- Deploy `contexts-index.yaml` + individual context definition files
- Implement `ContextRegistry.ts` (lazy-load definitions, validate against extended schema)

**Date Handling**:
- All date formatting uses `d-MMM-yy` format from day one (no YYYY-MM-DD anywhere)

### Phase 2: Data Operations Refactoring (CRITICAL)

**Existing Code Updates** (to fix signature/indexing conflation):

1. **`dataOperationsService.ts`** (~200 lines affected, lines 2100-2300):
   - Replace all `filter(v => v.query_signature === sig)` with `filter(v => v.sliceDSL === targetSlice)`
   - Use `querySignatureService.validateSignature()` for staleness checks AFTER slice isolation
   - Build `DataQuerySpec` from current graph state before signature comparison
   - Add assertions: if file has contexts but no `targetSlice` specified, throw error

2. **`windowAggregationService.ts`** (~100 lines affected):
   - All functions accept `targetSlice: string` parameter
   - First line of each function: `const sliceValues = values.filter(v => v.sliceDSL === targetSlice)`
   - Replace ad-hoc signature checks with `querySignatureService.validateSignature()`
   - Add safeguard: if `values` has contexts but no `targetSlice` → error

3. **Amplitude/Sheets Adapters**:
   - Replace inline signature generation with `querySignatureService.buildDailySignature()` or `buildAggregateSignature()`
   - Build `DataQuerySpec` from adapter request parameters
   - Store returned `query_signature` on fetched `ParameterValue` entries

**New Aggregation Logic**:
- Implement context-aware window aggregation (2D grid, MECE detection, otherPolicy)
- Add in-memory `VariableAggregationCache` for performance (<1s latency target)

### Phase 3: UI Components

- Extend `WindowSelector.tsx` with context chips (using enhanced QueryExpressionEditor)
- Implement `ContextValueSelector` component (shared for per-chip and Add Context dropdowns)
- Add unroll state with full DSL editor
- Implement Pinned Query modal with slice count/enumeration preview
- Remove What-if button from WindowSelector (moved to Scenarios panel)

### Phase 4: Nightly Runner

- Implement `expand_clause()` logic with explosion cap (warn if >500 slices)
- Schedule nightly runs for graphs with `dataInterestsDSL`
- Monitor API usage and query volume
- Implement graceful degradation (skip graph on errors, log warnings)

### Phase 5: Validation & Polish

- Graph-level validation of `dataInterestsDSL` against registry
- AggregationResult status → UI behavior (toasts, badges, Fetch button logic)
- Comprehensive test suite (all 7 daily grid scenarios + 4 otherPolicy variants + regex)
- Performance profiling (confirm <1s aggregation latency)

---

## Design Completeness

### All Major Questions Resolved

1. ✓ **Terminology**: `dataInterestsDSL` (graph) vs `sliceDSL` (window) vs `currentQueryDSL` (UI state)
2. ✓ **Data model**: `sliceDSL` only (no redundant metadata); `d-MMM-yy` date format everywhere
3. ✓ **Stored slices are atomic**: No `contextAny(...)` in persisted `sliceDSL`
4. ✓ **DSL parsing**: Extend existing ParamPackDSLService; extract to shared `constraintParser.ts`
5. ✓ **otherPolicy**: 4 variants (null, computed, explicit, undefined) fully specified
6. ✓ **Regex patterns**: For collapsing high-cardinality source values; in `SourceMapping.pattern`
7. ✓ **MECE detection**: Respects otherPolicy; sets `canAggregate` flag
8. ✓ **Mixed MECE keys**: Aggregate across MECE key only; ignore non-MECE keys
9. ✓ **Daily grid model**: 2D (context × date); reuse existing daily points; incremental fetch
10. ✓ **Window aggregation**: 7 scenarios documented; always aggregate what user asked for; MECE controls "complete" vs "partial" status
11. ✓ **Amplitude adapter**: Property filters + regex; context → filter mapping via registry
12. ✓ **Sheets fallback**: Fallback to uncontexted with warning
13. ✓ **UI design**: See `CONTEXTS_UI_DESIGN.md` for complete visual spec
14. ✓ **Performance**: In-memory index per variable (lazy build); target <1s aggregation latency
15. ✓ **Error policy**: Never hard fail; graceful degradation with toasts/warnings
16. ✓ **Pinned DSL validation**: Validate on Save; show slice count + enumeration; warn if >500 slices
17. ✓ **Nightly explosion cap**: Warn (don't block) if expansion exceeds safe threshold

### Terminology: Three Distinct "Queries"

To avoid confusion, we explicitly distinguish three concepts that all use the word "query":

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

### Query Signatures vs Slice Keys: Separation of Concerns

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

**Usage Patterns**:

1. **Finding data for a query**:
   ```typescript
   // CORRECT: Index by sliceDSL
   const targetSlice = normalizeSliceDSL(userQuery);
   const matchingValues = allValues.filter(v => v.sliceDSL === targetSlice);
   
   // WRONG: Index by signature (will return mixed slices)
   const matchingValues = allValues.filter(v => v.query_signature === sig);
   ```

2. **Checking if data is stale**:
   ```typescript
   // CORRECT: After isolating slice, check signature
   const sliceData = values.filter(v => v.sliceDSL === targetSlice);
   const currentSpec = buildDataQuerySpec(slice, graph, contexts, adapter);
   const currentSig = computeSignature(currentSpec);
   
   if (sliceData.some(v => v.query_signature !== currentSig)) {
     warn('Data query spec changed; data may be stale');
   }
   ```

3. **Incremental fetch logic**:
   ```typescript
   // CORRECT: Filter by slice FIRST, then analyze dates
   const sliceData = values.filter(v => v.sliceDSL === targetSlice);
   const existingDates = extractDates(sliceData);
   const missingDates = findMissingDates(requestedWindow, existingDates);
   
   // CORRECT: Partial windows are valid if signature unchanged
   // E.g., overnight fetched window(-30d:), user queries window(-7d:)
   // Can reuse last 7 days from the 30-day fetch without new retrieval
   ```

**Implementation Requirements**:
1. `sliceDSL` is REQUIRED on all `ParameterValue` entries (empty string = uncontexted, all-time)
2. All data lookup/aggregation MUST filter by `sliceDSL` first
3. `query_signature` is OPTIONAL and used only for staleness detection
4. Signature generation MUST be consistent (deterministic hash of normalized data query spec)
5. **For daily-capable sources**: Date ranges are EXCLUDED from signature (partial windows remain valid)
6. **For aggregate-only sources**: Date ranges MAY be included in signature (depends on re-usability)

**Migration Note**: Existing data has `query_signature` but not `sliceDSL`. During contexts implementation, add logic to handle legacy data (treat missing `sliceDSL` as uncontexted slice).

---

### Data Query Signature Service (NEW)

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

**Usage in adapters**:

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

**Usage in incremental fetch**:

```typescript
// dataOperationsService.ts
function shouldRefetch(storedValues: ParameterValue[], currentSpec: DataQuerySpec): boolean {
  if (storedValues.length === 0) return true;
  
  // Check if any stored value has mismatched signature
  const currentSig = currentSpec.granularity === 'daily'
    ? querySignatureService.buildDailySignature(currentSpec)
    : querySignatureService.buildAggregateSignature(currentSpec);
  
  const staleValues = storedValues.filter(v => 
    v.query_signature && v.query_signature !== currentSig
  );
  
  if (staleValues.length > 0) {
    console.warn(`[DataOps] ${staleValues.length} values have stale signatures; considering refetch`);
    // Policy: warn but allow reuse if dates are recent; OR force refetch
  }
  
  return staleValues.length > 0; // Or more nuanced policy
}
```

**Updates Required to Existing Code**:

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

**Testing**: 
- `querySignatureService.test.ts` with cases:
  - Same spec → same signature (deterministic)
  - Spec + different window → same signature (daily mode)
  - Spec + different window → different signature (aggregate mode)
  - Spec + different topology → different signature
  - Spec + different context mapping → different signature

---

### Implementation Risks & Critical Paths

**1. Data Operations Service: Incremental Fetch Corruption**
- **Risk**: Existing logic in `dataOperationsService.ts` (lines 2180+) filters parameter values by `query_signature` only.
- **Problem**: Multiple context slices (e.g., `channel:google`, `channel:fb`) will share the same `query_signature` (derived from base query config). Filtering by signature alone will return a mixed bag of slices. `calculateIncrementalFetch` will then merge dates from different contexts, falsely believing data exists for a date when it only exists for a *different* context.
- **Fix**: Filter MUST be updated to check `query_signature` **AND** `sliceDSL`. Only values matching the exact requested slice should be considered for incremental fetch analysis.

**2. Window Aggregation: Time-Series Assumptions (CRITICAL)**
- **Risk**: `windowAggregationService.ts` logic assumes the `values` array represents a single logical time-series.
- **Problem**: With contexts, `values` will contain multiple disjoint time-series (one per slice). Naive iteration over `values` will aggregate disparate contexts.
- **Fix**: 
  1. All aggregation functions must accept a target `sliceDSL` parameter
  2. First line of each function: `const matchingValues = values.filter(v => v.sliceDSL === targetSliceDSL)`
  3. All subsequent logic operates only on `matchingValues`
- **Safeguard**: Add assertion that fails if aggregation is called without a `sliceDSL` when `values.length > 0 && values.some(v => v.sliceDSL)` (i.e., if file has contexts data, must specify which slice to aggregate)

**3. Condition String Parsing in UpdateManager & Edge References (REQUIRES WORK)**
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
- **Testing**: Add test cases for condition strings containing dots in multiple constraint types

### Implementation-Time Details (Defer to Code)

These are intentionally left to implementation (not blocking design sign-off):

1. **Exact Amplitude API syntax**: Verify property filter and regex syntax with API docs during adapter implementation
2. **UI polish**: Exact toast timing, badge styling, icon choices
3. **Error message copy**: User-facing text for various warnings/errors
4. **Performance tuning**: Profiling-driven optimization if <1s budget isn't met
5. **Retention policy**: How long to keep old daily data (can add later based on usage patterns)

### Deliverables

1. **Schema Extensions**:
   - `dataInterestsDSL`, `currentQueryDSL` on graphs
   - `sliceDSL` (required) on `ParameterValue`
   - Extended `context-definition-schema.yaml` (otherPolicy, sources)
   - All dates use `d-MMM-yy` format

2. **Query Signature Service (NEW)**:
   - `querySignatureService.ts` — centralized signature generation/validation
   - `DataQuerySpec` interface — normalized form of external API calls
   - `buildDailySignature()` — excludes dates for partial window reuse
   - `buildAggregateSignature()` — includes dates for window-specific data
   - Clear separation: signatures for *data query specs*, NOT for indexing

3. **Existing Code Refactoring** (signature/indexing separation):
   - `dataOperationsService.ts` — replace signature-based filtering with sliceDSL-based
   - `windowAggregationService.ts` — add mandatory `targetSlice` parameter to all functions
   - Adapters — use `querySignatureService` for signature generation
   - Add safeguards: error if contexts present but no `targetSlice` specified

4. **Shared constraint parser**: `constraintParser.ts` with `context`/`contextAny`/`window` support

5. **Context registry**: Loader, otherPolicy (4 variants), regex pattern support, MECE detection

6. **Window aggregation**: 2D grid model, MECE logic, 7 daily-grid scenarios, mixed-otherPolicy handling

7. **In-memory indexing**: `VariableAggregationCache` for <1s query latency

8. **Adapters**: 
   - Amplitude: context filter generation with regex pattern support
   - Sheets: fallback policy (fallback with warning)
   - Both: integrate `querySignatureService`

9. **UI**: See `CONTEXTS_UI_DESIGN.md` (enhanced QueryExpressionEditor, ContextValueSelector, WindowSelector integration)

10. **Nightly runner**: Explode `dataInterestsDSL` with cap/warning at 500 slices

11. **Validation**: Graph-level DSL validation; graceful degradation on errors

12. **Testing**: 
    - Slice isolation tests (prevent cross-slice corruption)
    - 7 daily grid + 4 otherPolicy + regex + mixed-MECE scenarios
    - Signature service tests (deterministic, daily vs aggregate modes)

### Implementation Priority

**Phase 1: Core Infrastructure**
1. Schema updates (`dataInterestsDSL`, `sliceDSL`, `currentQueryDSL`)
2. `constraintParser.ts` (extract from ParamPackDSLService, add context/window support)
3. Context registry loader with otherPolicy + regex support
4. Monaco DSL schema updates (register `context`, `contextAny`, `window` functions)

**Phase 2: Window Aggregation (CRITICAL PATH)**
1. MECE detection algorithm (with otherPolicy logic)
2. Daily grid aggregation (`aggregateWindowsWithContexts`, `tryMECEAggregationAcrossContexts`)
3. In-memory `VariableAggregationCache`
4. Comprehensive test suite (daily grid scenarios, otherPolicy variants, mixed-MECE cases)

**Phase 3: Adapters**
1. Amplitude adapter: context filter + regex pattern → Amplitude query
2. Verify Amplitude API syntax (property filters, regex matching)
3. Sheets adapter: context HRN parsing + fallback policy
4. Integration tests (mock Amplitude/Sheets responses)

**Phase 4: UI Components**
1. Enhanced QueryExpressionEditor (add `▾` to context chips)
2. ContextValueSelector component (shared for per-chip and Add Context)
3. WindowSelector integration (chips, Add button, unroll state)
4. Pinned Query modal (with slice count preview, enumeration, explosion warning)
5. Remove What-if from WindowSelector

**Phase 5: Nightly Runner & Validation**
1. Runner explosion logic (`expand_clause` with cap)
2. Graph-level DSL validation (on Save, on load)
3. AggregationResult → UI mapping (status → toasts/badges)
4. End-to-end testing

**Phase 6: Performance Validation**
1. Profile aggregation with realistic data (100 params, 16 slices, 365 days)
2. Confirm <1s latency budget
3. Optimize if needed (likely already met with in-memory index)

---

## Appendix: otherPolicy & Regex Summary

### otherPolicy Impact Matrix

| System | `null` | `computed` | `explicit` | `undefined` |
|--------|--------|------------|------------|-------------|
| **"other" in value enum?** | NO | YES | YES | NO |
| **"other" queryable?** | NO (error) | YES (dynamic filter) | YES (explicit filter) | NO (error) |
| **MECE assertion?** | YES | YES | YES | NO |
| **Can aggregate across key?** | If complete (total) | If complete (total) | If complete (total) | YES (but ALWAYS partial) |
| **UI dropdown shows "other"?** | NO | YES | YES | NO |
| **All-values-checked removes chip?** | YES | YES | YES | NO |
| **Adapter builds "other" filter** | N/A | Dynamically (NOT explicit) | From registry | N/A |
| **Typical use case** | Complete finite enum (A/B variants) | Open property + catch-all (utm_source) | Custom "other" definition | Exploratory/incomplete |

**Where this matters in code**:
1. `getValuesForContext()` — Includes/excludes "other" from enumeration
2. `detectMECEPartition()` — Sets `canAggregate` flag based on policy
3. `buildFilterForContextValue()` — Generates dynamic NOT filter for `otherPolicy: computed`
4. UI dropdowns — Shows/hides "other" checkbox based on policy
5. All-checked chip removal — Only removes if policy != `undefined`

### Regex Pattern Support

**Purpose**: Map many raw source values to one logical context value.

**Example** (utm_source collapsing):

```yaml
# Raw Amplitude values: google_search_brand, google_display_retargeting, google_shopping_pla
# Logical value: "google"

values:
  - id: google
    sources:
      amplitude:
        field: utm_source
        pattern: "^google"   # Matches any value starting with "google"
        patternFlags: "i"     # Case-insensitive
```

**Adapter generates**: `utm_source REGEXP_MATCHES '^google' (case-insensitive)`

**When to use**:
- High-cardinality source properties (UTM campaigns, referrers, etc.)
- Need to collapse many raw values to manageable logical enum
- Simpler than maintaining explicit value list

**When NOT to use**:
- Low-cardinality with stable values → use `filter` instead
- Complex boolean logic → use `filter` with AND/OR
- Cannot use both `pattern` and `filter` (adapter will error)

---

**CRITICAL PATH ITEMS FOR IMPLEMENTATION**:
1. ✓ otherPolicy properly designed (4 variants, impact on MECE/UI/adapters documented)
2. ✓ Regex pattern support designed (pattern + patternFlags fields, adapter logic, test cases)
3. Amplitude API syntax verification needed (exact regex filter syntax — verify with API docs)
4. Test coverage for all otherPolicy variants (see Testing Strategy section)
5. Test coverage for regex patterns (matching, NOT generation for computed "other")

---
