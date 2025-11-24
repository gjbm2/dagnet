# Contexts: Registry & MECE Detection

**Part of**: Contexts v1 implementation  
**See also**: 
- `CONTEXTS_ARCHITECTURE.md` — Core architecture and data model
- `CONTEXTS_AGGREGATION.md` — Window aggregation algorithms
- `CONTEXTS_ADAPTERS.md` — Adapter usage of registry mappings

---

## Overview

This document defines:
- Context registry structure (index + individual definition files)
- Context definition schema (otherPolicy, source mappings, regex patterns)
- MECE detection algorithm
- Impact of otherPolicy on system behavior

---

## Context Registry Structure

**Pattern**: Mirrors parameter registry (index file + individual definition files)

### Context Index File

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

## Individual Context Definition Files

**Pattern**: One YAML file per context key (mirrors `params/*.yaml` structure)

**File**: `param-registry/contexts/channel.yaml`

**Schema**: `graph-editor/public/param-schemas/context-definition-schema.yaml` (EXISTS, needs extension)

### Required Schema Additions

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

### Example Context Definition

**File**: `param-registry/contexts/channel.yaml`

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
```

**File structure**:
- `param-registry/contexts-index.yaml` — Index listing all context keys (lightweight, always loaded)
- `param-registry/contexts/channel.yaml` — Full definition for "channel" key
- `param-registry/contexts/browser-type.yaml` — Full definition for "browser-type" key
- etc.

---

## Context Registry Loading

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

## otherPolicy: Detailed Specification

The `otherPolicy` field controls whether and how a catch-all "other" bucket is handled for a context key. This affects **multiple systems**:

### A. Impact on Value Enumeration

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

### B. Impact on MECE Detection

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
  /**
   * IMPORTANT SEMANTICS:
   * - This flag means "safe to treat aggregation across this key as COMPLETE (total space)".
   * - Even when this returns false (e.g. otherPolicy='undefined'), we may still aggregate
   *   the available slices, but MUST surface the result as PARTIAL with a warning.
   */
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

### C. Impact on Query Building (Adapters)

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

### D. Impact on UI Value Lists

**In Add Context dropdown and per-chip dropdowns**:

- `otherPolicy: null` → Show only explicit values (google, meta, direct); no "other" checkbox
- `otherPolicy: computed` → Show explicit values + "other" (all queryable)
- `otherPolicy: explicit` → Show explicit values + "other" (all queryable)
- `otherPolicy: undefined` → Show only explicit values; no "other" checkbox

**Implication for "all values checked = remove chip"**:

- Only applies when otherPolicy allows aggregation (null, computed, explicit)
- If otherPolicy=undefined, checking all visible values does NOT mean "all data" (can't remove chip)

---

## otherPolicy Impact Matrix

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

## Regex Pattern Support for Source Mappings

**Problem**: Raw source values are often high-cardinality or messy (e.g., UTM sources like `"google_search_brand_exact"`, `"google_display_retargeting"`, etc.).

**Solution**: Allow regex patterns to collapse many raw values into one logical value.

### Registry Example with Patterns

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

### Adapter Logic with Regex

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

### When to Use Pattern vs Filter

- **Pattern**: High-cardinality raw space that collapses to logical value (UTM sources, campaign names, etc.)
- **Filter**: Low-cardinality or complex boolean logic (e.g., `utm_source is null OR utm_source == 'organic'`)
- **Both**: Not allowed; use one or the other per value

---

## MECE Detection Algorithm

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

## Graph-Level Validation of Pinned DSL

Pinned DSL (`dataInterestsDSL`) must be **consistent** with the context registry:

- All `context(key:value)` references must:
  - Use a known `key` from `contexts.yaml`
  - Use a known `value` under that key
- Any mismatch is treated as a **configuration error**, but we **degrade gracefully** in the UI.

### Validation Points

1. **On graph save**:
   - Run parser on `dataInterestsDSL`
   - For each `context(key:value)`:
     - If `key` or `value` unknown → show inline error in modal + WARN ON SAVE [DO NOT BLOCK SAVE]
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

### Error Policy

- For **pinned DSL in settings modal** → we can WARN ON Save on validation errors (authoring-time feedback).
- For **runtime usage (graphs already saved)** → never hard fail user interaction; instead:
  - Disable context UI where impossible to interpret
  - Show clear toast + log error for investigation

---

## TypeScript Interface Definitions

```typescript
export interface ContextDefinition {
  id: string;
  name: string;
  description: string;
  type: 'categorical' | 'ordinal' | 'continuous';
  otherPolicy: 'null' | 'computed' | 'explicit' | 'undefined';  // NEW field
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
```

---

## UI Integration

**How UI components use registry information**: See `CONTEXTS_UI_DESIGN.md` for complete details.

**Key UI integration points**:

1. **Value lists in dropdowns** (`ContextValueSelector` component):
   ```typescript
   const values = contextRegistry.getValuesForContext(contextKey);
   // Returns values based on otherPolicy:
   // - null/undefined: excludes "other" from list
   // - computed/explicit: includes "other" as selectable value
   ```

2. **All-values-checked logic** (when user checks all boxes in dropdown):
   ```typescript
   if (allValuesChecked && canAggregate) {
     // Remove chip (equivalent to no filter)
     // Show brief tooltip: "All values selected = no filter"
   } else {
     // Keep chip (incomplete coverage)
   }
   ```

3. **Add Context dropdown** (accordion sections):
   - Built from `dataInterestsDSL` parsed against registry
   - Each key becomes an accordion section
   - Only shows values that exist in both pinned DSL and registry

**Complete visual design**: `CONTEXTS_UI_DESIGN.md` provides mockups, user flows, and implementation pseudocode for all UI components that consume registry data.

---

## Next Steps

1. Review `CONTEXTS_AGGREGATION.md` for window aggregation algorithms that use MECE detection
2. Review `CONTEXTS_ADAPTERS.md` for how adapters use source mappings and build filters
3. Review `CONTEXTS_UI_DESIGN.md` for how UI components consume registry data
4. Review `CONTEXTS_TESTING_ROLLOUT.md` for comprehensive test coverage of otherPolicy variants

