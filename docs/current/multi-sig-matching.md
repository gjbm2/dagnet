# Structured Query Signature: Multi-Dimensional Matching

**Status**: Proposal  
**Date**: 29-Jan-26  
**Author**: AI Assistant  
**Supersedes**: Legacy monolithic signature system

---

## 1. Problem Statement

### 1.1 Current Behaviour

The current signature system computes a single SHA-256 hash of all query inputs, including context keys and their definition hashes. Matching is **exact equality only**.

This causes two classes of failure:

| Scenario | Current Outcome | Desired Outcome |
|----------|-----------------|-----------------|
| **Uncontexted query over contexted MECE cache** | Signature mismatch → demands refetch | Should accept (contexted cache is superset) |
| **Single-dimension query over multi-dimensional cache** | Signature mismatch → demands refetch | Should accept if query dimensions ⊆ cache dimensions |

### 1.2 Root Cause

The monolithic hash conflates two independent concerns:

1. **Core semantics**: connection, events, query structure, latency config — must match exactly
2. **Context dimensions**: which context keys are referenced — cache may have a superset

By hashing them together, we lose the ability to reason about dimensional relationships.

### 1.3 Example Failure

```
Cache slices: context(channel:google,device:mobile), context(channel:google,device:desktop), ...
  → Signed with: hash({...core..., context_keys: ['channel', 'device'], ...})

User query: context(channel:google).cohort(1-Nov-25:15-Dec-25)
  → Planner computes: hash({...core..., context_keys: ['channel'], ...})

Result: MISMATCH — planner demands refetch despite having all necessary data
```

---

## 2. Proposed Solution: Structured Signatures

### 2.1 Conceptual Model

Split the signature into two independent components:

```typescript
interface StructuredSignature {
  /**
   * Hash of all non-context semantic inputs:
   * - connection name
   * - from/to/visited/exclude event names and IDs
   * - event_filters
   * - case constraints
   * - cohort mode, anchor event ID
   * - latency parameters (anchor_node_id, latency_parameter)
   * - normalised original query string (minus/plus/visited/exclude)
   */
  coreHash: string;
  
  /**
   * Per-context-key definition hashes.
   * Keys are sorted alphabetically.
   * Values are SHA-256 of normalised context definition.
   * Empty object {} means no context keys (uncontexted query).
   */
  contextDefHashes: Record<string, string>;
}
```

### 2.2 Serialised Format

Store as a JSON string on `ParameterValue.query_signature`:

```json
{"c":"<coreHash>","x":{"channel":"<defHash>","device":"<defHash>"}}
```

Compact keys (`c` for core, `x` for context) minimise storage overhead.

### 2.3 Matching Rules

A cached signature can satisfy a query signature if and only if:

1. **Core hashes match exactly**: `cache.coreHash === query.coreHash`
2. **Query's context keys are present in cache with matching hashes**:
   - For every key K in `query.contextDefHashes`:
     - `cache.contextDefHashes[K]` must exist
     - `cache.contextDefHashes[K] === query.contextDefHashes[K]`
3. **Cache may have extra context keys** (superset is permitted)

### 2.4 Matching Examples

| Cache `contextDefHashes` | Query `contextDefHashes` | Match? | Reason |
|--------------------------|--------------------------|--------|--------|
| `{}` | `{}` | ✓ | Both uncontexted |
| `{channel: "abc"}` | `{}` | ✓ | Cache has superset |
| `{channel: "abc", device: "def"}` | `{channel: "abc"}` | ✓ | Cache has superset |
| `{}` | `{channel: "abc"}` | ✗ | Cache missing required key |
| `{channel: "abc"}` | `{channel: "xyz"}` | ✗ | Definition hash mismatch |
| `{channel: "abc"}` | `{device: "def"}` | ✗ | Cache missing required key |

---

## 3. Implementation Design

### 3.1 New Service: `signatureMatchingService.ts`

**File**: `graph-editor/src/services/signatureMatchingService.ts`

```typescript
/**
 * Structured Query Signature Matching Service
 * 
 * Provides parsing, serialisation, and subset-aware matching for structured signatures.
 */

export interface StructuredSignature {
  coreHash: string;
  contextDefHashes: Record<string, string>;
}

export interface SignatureMatchResult {
  compatible: boolean;
  reason?: string;
}

/**
 * Parse a serialised signature string into structured form.
 */
export function parseSignature(sig: string): StructuredSignature {
  try {
    const parsed = JSON.parse(sig);
    return {
      coreHash: parsed.c || '',
      contextDefHashes: parsed.x || {},
    };
  } catch {
    // Malformed signature — treat as incompatible with everything
    return { coreHash: '', contextDefHashes: {} };
  }
}

/**
 * Serialise a structured signature to string for storage.
 */
export function serialiseSignature(sig: StructuredSignature): string {
  return JSON.stringify({
    c: sig.coreHash,
    x: sig.contextDefHashes,
  });
}

/**
 * Check if a cached signature can satisfy a query signature.
 * 
 * Rules:
 * 1. Core hashes must match exactly
 * 2. For each context key in the QUERY, the cache must have that key with matching def hash
 * 3. Cache may have EXTRA context keys (superset is OK)
 */
export function signatureCanSatisfy(
  cacheSig: StructuredSignature,
  querySig: StructuredSignature
): SignatureMatchResult {
  // Rule 1: Core semantics must match
  if (cacheSig.coreHash !== querySig.coreHash) {
    return { compatible: false, reason: 'core_mismatch' };
  }

  // Rule 2: Query's context keys must be present in cache with matching hashes
  for (const [key, queryDefHash] of Object.entries(querySig.contextDefHashes)) {
    const cacheDefHash = cacheSig.contextDefHashes[key];
    if (cacheDefHash === undefined) {
      return { compatible: false, reason: `missing_context_key:${key}` };
    }
    if (cacheDefHash !== queryDefHash) {
      return { compatible: false, reason: `context_def_mismatch:${key}` };
    }
  }

  // Rule 3: Cache may have extra context keys (superset OK)
  return { compatible: true };
}

/**
 * Convenience: check if cache signature string can satisfy query signature string.
 */
export function canCacheSatisfyQuery(cacheSigStr: string, querySigStr: string): boolean {
  const cacheSig = parseSignature(cacheSigStr);
  const querySig = parseSignature(querySigStr);
  return signatureCanSatisfy(cacheSig, querySig).compatible;
}

/**
 * Get the context keys that are in cache but not in query (unspecified dimensions).
 * Used for determining which dimensions need MECE verification for aggregation.
 */
export function getUnspecifiedDimensions(
  cacheSig: StructuredSignature,
  querySig: StructuredSignature
): string[] {
  const queryKeys = new Set(Object.keys(querySig.contextDefHashes));
  return Object.keys(cacheSig.contextDefHashes).filter(k => !queryKeys.has(k));
}
```

### 3.2 Update Signature Computation

**File**: `graph-editor/src/services/dataOperationsService.ts`

**Function**: `computeQuerySignature`

**New parameter**: Add `eventDefinitions?: Record<string, EventDefinition>` to capture event definition hashes.

Replace the signature computation with:

```typescript
export async function computeQuerySignature(
  queryPayload: any,
  connectionName?: string,
  graph?: Graph | null,
  edge?: any,
  contextKeys?: string[],
  workspace?: { repository: string; branch: string },
  eventDefinitions?: Record<string, any>  // NEW: Event definitions for hashing
): Promise<string> {
  // ... existing event ID extraction logic (unchanged) ...

  // 1. Collect all context keys
  const payloadContextKeys = Array.isArray(queryPayload?.context)
    ? queryPayload.context.map((c: any) => c?.key).filter(Boolean)
    : [];
  const allContextKeys = Array.from(new Set([...(contextKeys || []), ...payloadContextKeys]))
    .map((k) => String(k))
    .sort();

  // 2. Compute per-context definition hashes
  const contextDefHashes: Record<string, string> = {};
  for (const key of allContextKeys) {
    try {
      const ctx = await contextRegistry.getContext(key, workspace ? { workspace } : undefined);
      if (ctx) {
        const normalized = normalizeContextDefinition(ctx);
        contextDefHashes[key] = await hashText(JSON.stringify(normalized));
      } else {
        contextDefHashes[key] = 'missing';
      }
    } catch {
      contextDefHashes[key] = 'error';
    }
  }

  // 3. Resolve latency anchor node to its event_id (not node_id!)
  //    Nodes are transparent; events are semantic.
  const edgeLatency = edge?.p?.latency;
  const anchorEventId = (() => {
    const anchorNodeId = edgeLatency?.anchor_node_id;
    if (!anchorNodeId || !graph?.nodes) return '';
    const anchorNode = graph.nodes.find((n: any) => n.id === anchorNodeId || n.uuid === anchorNodeId);
    return anchorNode?.event_id || '';
  })();

  // 4. Compute event definition hashes (NEW)
  //    This ensures signature changes when event definition files change
  //    (e.g., provider_event_names mapping, amplitude_filters, etc.)
  const eventDefHashes: Record<string, string> = {};
  const allEventIds = [
    from_event_id,
    to_event_id,
    ...(visited_event_ids || []),
    ...(exclude_event_ids || []),
    anchorEventId,
  ].filter(Boolean);

  for (const eventId of allEventIds) {
    const eventDef = eventDefinitions?.[eventId];
    if (eventDef) {
      // Hash the semantically relevant parts of the event definition
      const normalized = {
        id: eventDef.id,
        provider_event_names: eventDef.provider_event_names || {},
        amplitude_filters: eventDef.amplitude_filters || [],
      };
      eventDefHashes[eventId] = await hashText(JSON.stringify(normalized));
    } else {
      eventDefHashes[eventId] = 'not_loaded';
    }
  }

  // 5. Normalize original_query to use event_ids instead of node_ids
  //    This maximizes cache sharing across graphs with same events but different node names
  const normalizeQueryToEventIds = (q: string): string => {
    if (!q || !graph?.nodes) return q;
    let out = q;
    // Replace node references with their event_ids
    for (const node of graph.nodes) {
      if (node.id && node.event_id) {
        // Replace from(nodeId) with from(eventId), etc.
        out = out.replace(new RegExp(`\\b${escapeRegex(node.id)}\\b`, 'g'), node.event_id);
      }
    }
    return out;
  };
  const normalizedOriginalQuery = normalizeQueryToEventIds(originalQueryForSignature);

  // 6. Compute core hash (everything EXCEPT context keys/hashes)
  const coreCanonical = JSON.stringify({
    connection: connectionName || '',
    // Event IDs (semantic identity)
    from_event_id: from_event_id || '',
    to_event_id: to_event_id || '',
    visited_event_ids: visited_event_ids.sort(),
    exclude_event_ids: exclude_event_ids.sort(),
    // Event definition hashes (detect event file changes)
    event_def_hashes: eventDefHashes,
    // Other semantic inputs
    event_filters: queryPayload.event_filters || {},
    case: (queryPayload.case || []).sort(),
    cohort_mode: !!queryPayload.cohort,
    cohort_anchor_event_id: queryPayload?.cohort?.anchor_event_id || '',
    latency_parameter: edgeLatency?.latency_parameter === true,
    latency_anchor_event_id: anchorEventId,
    // Normalized query (uses event_ids, not node_ids)
    original_query: normalizedOriginalQuery,
  });
  const coreHash = await hashText(coreCanonical);

  // 7. Return structured signature
  return serialiseSignature({ coreHash, contextDefHashes });
}

// Helper to escape regex special characters
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

### 3.2.1 Update Call Sites to Pass eventDefinitions

**buildDslFromEdge** already returns `eventDefinitions`. Update callers to pass it through:

```typescript
// In dataOperationsService.ts fetch execution:
const { queryPayload, eventDefinitions } = await buildDslFromEdge(...);
querySignature = await computeQuerySignature(
  queryPayload,
  connectionName,
  graph,
  edge,
  contextKeys,
  workspace,
  eventDefinitions  // NEW: pass event definitions
);

// In plannerQuerySignatureService.ts:
const buildResult = await buildDslFromEdge(edgeForDsl, graph, provider, eventLoader, merged);
const sig = await computeQuerySignature(
  buildResult.queryPayload,
  connectionName,
  graph,
  edgeForDsl,
  baseSignatureContextKeys,
  workspaceForSignature,
  buildResult.eventDefinitions  // NEW: pass event definitions
);
```

### 3.3 Update Fetch Plan Builder

**File**: `graph-editor/src/services/fetchPlanBuilderService.ts`

**Location**: `buildPlanItem` function, around line 433

**Before**:
```typescript
const valuesForCoverage = shouldFilterBySignature
  ? modeFilteredValues.filter((v) => {
      const sig = (v as any).query_signature;
      return sig === currentSignature;
    })
  : modeFilteredValues;
```

**After**:
```typescript
import { canCacheSatisfyQuery } from './signatureMatchingService';

const valuesForCoverage = shouldFilterBySignature
  ? modeFilteredValues.filter((v) => {
      const cacheSig = (v as any).query_signature;
      if (!cacheSig || !currentSignature) return false;
      return canCacheSatisfyQuery(cacheSig, currentSignature);
    })
  : modeFilteredValues;
```

### 3.4 Update Window Aggregation Service

**File**: `graph-editor/src/services/windowAggregationService.ts`

**Function**: `calculateIncrementalFetch`, around line 933

**Before**:
```typescript
const signatureFilteredValues = hasAnySignedValues
  ? allValues.filter(v => v.query_signature === effectiveQuerySignature)
  : allValues;
```

**After**:
```typescript
import { canCacheSatisfyQuery } from './signatureMatchingService';

const signatureFilteredValues = hasAnySignedValues && effectiveQuerySignature
  ? allValues.filter(v => {
      if (!v.query_signature) return false;
      return canCacheSatisfyQuery(v.query_signature, effectiveQuerySignature);
    })
  : allValues;
```

### 3.5 PRECISE Call Site Updates Required

**CRITICAL**: The following locations MUST be updated. Each is traced to exact line numbers.

#### 3.5.1 Signature COMPUTATION Call Sites (pass eventDefinitions)

| File | Line | Context | Change |
|------|------|---------|--------|
| `dataOperationsService.ts` | ~1457 | `buildFetchPlan` → `expectedQuerySignature` | Add `compEventDefs` (available at line 1452) as 7th param |
| `dataOperationsService.ts` | ~4875 | `getFromSourceDirect` → `querySignature` | Add `eventDefinitions` (in scope from line 4189/4324) as 7th param |
| `plannerQuerySignatureService.ts` | ~334 | `computePlannerQuerySignaturesForGraph` → `sig` | Add `buildResult.eventDefinitions` (available at line 296) as 7th param |

**Current signature**:
```typescript
computeQuerySignature(queryPayload, connectionName, graph, edge, contextKeys, workspace)
```

**New signature**:
```typescript
computeQuerySignature(queryPayload, connectionName, graph, edge, contextKeys, workspace, eventDefinitions)
```

#### 3.5.2 Signature MATCHING Call Sites (use subset-aware matching)

| File | Line | Context | Change |
|------|------|---------|--------|
| `fetchPlanBuilderService.ts` | ~436 | `buildPlanItem` cache filtering | Replace `sig === currentSignature` with `canCacheSatisfyQuery(sig, currentSignature)` |
| `windowAggregationService.ts` | ~933 | `calculateIncrementalFetch` cache filtering | Replace `v.query_signature === effectiveQuerySignature` with `canCacheSatisfyQuery(v.query_signature, effectiveQuerySignature)` |

**NOTE**: `meceSliceService.ts` groups MECE generations by exact `(key, query_signature)`. This is intentional and MUST NOT change — exact matching ensures coherent generations. The subset-aware matching is only for accepting cache as valid for a query, not for MECE generation grouping.

#### 3.5.3 Utility Function

**`escapeRegex`** exists in `buildDslFromEdge.ts` (line 721) but is not exported. Either:
- Export it from `buildDslFromEdge.ts` and import in `dataOperationsService.ts`, OR
- Inline the function in `dataOperationsService.ts`:
  ```typescript
  function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  ```

### 3.6 No Changes Required

The following files do **not** need modification:

| File | Reason |
|------|--------|
| `meceSliceService.ts` | Groups by exact signature for coherent generations; correct as-is |
| `signaturePolicyService.ts` | Policy flags remain; re-enable after implementation |
| `types/parameterData.ts` | `query_signature: string` type unchanged |

---

## 4. Topology and Event Identity

### 4.1 Principle: Events Are Semantic, Nodes Are Transparent

Signatures should be based on **semantic identity** (what data are we asking for?), not **graph-local identity** (what did we call it in this graph?).

| Identity Level | Example | Should affect signature? |
|----------------|---------|-------------------------|
| **Node ID** | `viewed-coffee-screen` | ❌ No — graph-local, may differ between graphs |
| **Event ID** | `event-coffee-view` | ✅ Yes — semantic identity of the event definition |
| **Event definition** | `provider_event_names`, `amplitude_filters` | ✅ Yes — what actually gets queried |
| **Context definition** | `values`, `otherPolicy` | ✅ Yes — affects MECE and slice semantics |

### 4.2 What's Encoded in coreHash

| Field | What it captures | Triggers invalidation when... |
|-------|------------------|------------------------------|
| `from_event_id`, `to_event_id`, etc. | Event IDs | Node points to different event |
| `event_def_hashes` | Hash of each event definition | Event definition file edited |
| `latency_anchor_event_id` | Resolved anchor event | Anchor node or its event changes |
| `original_query` (normalized) | Query structure using event_ids | Query structure changes |
| `connection` | Data source | Connection changed |
| `cohort_mode`, `cohort_anchor_event_id` | Cohort semantics | Cohort config changes |
| `latency_parameter` | Latency enabled | Latency config changes |
| `event_filters`, `case` | Filters and cases | Filter criteria change |

### 4.3 Event Definition Hashing (NEW)

**Problem identified**: Previously, the signature only captured `event_id`, not the event definition contents. If a user edited the event definition file (e.g., changed `provider_event_names.amplitude` from "OldEvent" to "NewEvent"), the signature would NOT change, leading to stale cache hits.

**Fix**: Hash the semantically relevant parts of each event definition:

```typescript
const eventDefHashes: Record<string, string> = {};
for (const eventId of allEventIds) {
  const eventDef = eventDefinitions?.[eventId];
  if (eventDef) {
    const normalized = {
      id: eventDef.id,
      provider_event_names: eventDef.provider_event_names || {},
      amplitude_filters: eventDef.amplitude_filters || [],
    };
    eventDefHashes[eventId] = await hashText(JSON.stringify(normalized));
  }
}
```

**Result**: Signature changes when:
- `provider_event_names` mapping changes (different Amplitude event)
- `amplitude_filters` change (different filter criteria)
- Event ID changes (already captured)

### 4.4 Normalized original_query (NEW)

**Problem identified**: `original_query` contained node IDs like `from(coffee).to(dashboard)`. This caused unnecessary cache misses when different graphs used different node names for the same events.

**Fix**: Normalize the query to use event_ids instead of node_ids:

```typescript
const normalizeQueryToEventIds = (q: string): string => {
  if (!q || !graph?.nodes) return q;
  let out = q;
  for (const node of graph.nodes) {
    if (node.id && node.event_id) {
      out = out.replace(new RegExp(`\\b${escapeRegex(node.id)}\\b`, 'g'), node.event_id);
    }
  }
  return out;
};
```

**Example**:
```
Before: "from(coffee-screen).to(dashboard-view).minus(signup-flow)"
After:  "from(event-coffee).to(event-dashboard).minus(event-signup)"
```

**Result**: Two graphs with different node names but same events produce identical signatures → cache shared correctly.

### 4.5 Bug Fix: `anchor_node_id` → `latency_anchor_event_id`

The previous implementation used `anchor_node_id` (node ID) in the signature. This was incorrect:

**Problem**:
- Graph A: node `anchor` has `event_id: "event-v1"`
- Graph B: node `anchor` has `event_id: "event-v2"`
- Both used `anchor_node_id: "anchor"` → signatures matched incorrectly!

**Fix**: Resolve `anchor_node_id` to its `event_id` before including in signature:

```typescript
const anchorEventId = (() => {
  const anchorNodeId = edgeLatency?.anchor_node_id;
  if (!anchorNodeId || !graph?.nodes) return '';
  const anchorNode = graph.nodes.find((n: any) => n.id === anchorNodeId || n.uuid === anchorNodeId);
  return anchorNode?.event_id || '';
})();

// In coreCanonical:
latency_anchor_event_id: anchorEventId,  // NOT anchor_node_id
```

### 4.6 Cross-Graph Cache Sharing (Intended Behaviour)

If two different graphs have:
- Same connection
- Same event definitions (same event_ids, same provider event names)
- Same query structure
- Same context definitions

Then their signatures **will match**, and cache **will be shared**.

This is **correct** — they're asking the same semantic question. The cache is keyed by "what question was asked", not "who asked it".

---

## 5. Cache Invalidation

### 5.1 Approach

Since we are not maintaining backward compatibility, **all existing cached signatures become invalid** when this change is deployed.

This is acceptable because:
1. Signature checking is currently disabled (no functional regression)
2. Users will simply see "needs fetch" on first use
3. After one fetch cycle, all data has new-format signatures

### 5.2 No Migration Required

Old signatures will fail to parse as valid JSON and `parseSignature()` returns an empty structure:
```typescript
parseSignature("a1b2c3d4...")  // Legacy hash
  → { coreHash: '', contextDefHashes: {} }
```

This will never match any query signature (empty coreHash), so old data is effectively treated as unsigned.

---

## 6. Multi-Contexted Slice Flow Analysis

### 6.1 Current Architecture: Single-Dimension MECE Only

**Critical finding from code trace**: The MECE service explicitly rejects multi-contexted slices.

```typescript
// meceSliceService.ts, line 95
if (parsed.context.length !== 1) return null;  // ONLY single-context slices eligible
```

This means slices with 2+ context dimensions (e.g., `context(channel:google).context(device:mobile)`) are **never** MECE-eligible.

### 6.2 Flow Trace: Multi-Contexted Cache Scenarios

#### Scenario A: Multi-contexted cache, single-dimension query

**Setup**:
- Cache: 20 slices with `context(channel:X).context(device:Y)`
- Query: `context(channel:google)`

**Flow (with proposed signature matching)**:

```
Step 1: Signature matching
  Cache sig: {c:"core", x:{channel:"abc", device:"def"}}
  Query sig: {c:"core", x:{channel:"abc"}}
  canCacheSatisfyQuery? → YES (query ⊆ cache)

Step 2: valuesForCoverage = all 20 slices (pass signature filter)

Step 3: hasFullSliceCoverageByHeader → isolateSlice(20 slices, "context(channel:google)")
  For each slice: extractSliceDimensions returns "context(channel:google).context(device:mobile)"
  Compare: "context(channel:google).context(device:mobile)" !== "context(channel:google)"
  → ALL slices excluded

Step 4: sliceValues = [] → unionCoversWindow([]) = false

Step 5: RESULT: DEMANDS REFETCH
```

**Conclusion**: Signature matching says "compatible" but slice isolation (correctly) rejects the slices because they're for a *specific* device, not all devices.

#### Scenario B: Multi-contexted cache, uncontexted query

**Setup**:
- Cache: 20 slices with `context(channel:X).context(device:Y)`
- Query: uncontexted (no context specification)

**Flow (with proposed signature matching)**:

```
Step 1: Signature matching
  Cache sig: {c:"core", x:{channel:"abc", device:"def"}}
  Query sig: {c:"core", x:{}}
  canCacheSatisfyQuery? → YES (empty ⊆ anything)

Step 2: valuesForCoverage = all 20 slices

Step 3: hasFullSliceCoverageByHeader → MECE path (uncontexted query, contexted data)
  tryMECEShouldCover → resolveMECEPartitionForImplicitUncontextedSync
    → isEligibleContextOnlySlice checks each slice
    → parsed.context.length === 2 (not 1!) → NOT ELIGIBLE

Step 4: No MECE partition found

Step 5: RESULT: DEMANDS REFETCH
```

**Conclusion**: Even with subset signature matching, multi-contexted slices cannot satisfy uncontexted queries because the MECE service requires single-dimension slices.

### 6.3 What the Proposal DOES Solve

The proposal's subset-aware signature matching solves:

| Scenario | Before | After |
|----------|--------|-------|
| **Uncontexted query over single-context MECE cache** | MISMATCH (refetch) | MATCH → MECE aggregation works |
| **Single-dim query over single-dim cache (same key)** | MISMATCH if file has extra contexts | MATCH if query key ⊆ cache keys |

### 6.4 What Phases 1-4 Do NOT Solve

| Scenario | Status |
|----------|--------|
| **Single-dim query over multi-dim cache** | NOT SOLVED in Phases 1-4 — requires Phase 5 |
| **Uncontexted query over multi-dim cache** | NOT SOLVED in Phases 1-4 — requires Phase 5 |
| **Dimensional reduction with MECE verification** | NOT SOLVED in Phases 1-4 — requires Phase 5 |

---

## 7. Phase 5: Multi-Dimensional Context Aggregation

### 7.1 Problem Statement

When cache contains slices with N context dimensions but query specifies M < N dimensions, the system should:

1. **Filter** slices to those matching ALL M specified dimension values
2. **Verify MECE** for the (N - M) unspecified dimensions within filtered set
3. **Aggregate** across unspecified dimensions to produce the query result

**Example**:
```
Cache: 20 slices (4 channels × 5 devices)
  context(channel:google).context(device:mobile)
  context(channel:google).context(device:desktop)
  context(channel:google).context(device:tablet)
  context(channel:google).context(device:ios)
  context(channel:google).context(device:android)
  context(channel:meta).context(device:mobile)
  ... (16 more)

Query: context(channel:google)

Step 1: Filter to channel:google → 5 slices (all devices for google)
Step 2: Verify device is MECE → all 5 device values present, otherPolicy allows aggregation
Step 3: Aggregate → sum(n_daily), sum(k_daily) across 5 slices
```

### 7.2 Terminology

| Term | Definition |
|------|------------|
| **Specified dimensions** | Context keys present in the query (e.g., `channel` in `context(channel:google)`) |
| **Unspecified dimensions** | Context keys present in cache but NOT in query (e.g., `device` when query is `context(channel:google)`) |
| **Dimensional reduction** | Aggregating across unspecified dimensions when MECE is verified |
| **Partial-dimension match** | Cache slice matches query on specified dimensions but has extra unspecified dimensions |

### 7.3 Architecture Changes

#### 7.3.1 New Service: `dimensionalReductionService.ts`

**File**: `graph-editor/src/services/dimensionalReductionService.ts`

```typescript
/**
 * Dimensional Reduction Service
 * 
 * Handles multi-dimensional context aggregation when query specifies fewer
 * dimensions than cache contains.
 * 
 * Principles:
 * - Only aggregate when ALL unspecified dimensions are MECE-verified
 * - Sum n_daily/k_daily across slices (correct for count-based metrics)
 * - Preserve date alignment (all slices must have same date coverage)
 */

import type { ParameterValue } from '../types/parameterData';
import { parseConstraints } from '../lib/queryDSL';
import { extractSliceDimensions } from './sliceIsolation';
import { contextRegistry } from './contextRegistry';

export interface DimensionalReductionResult {
  kind: 'reduced' | 'not_reducible';
  reason?: string;
  aggregatedValues?: ParameterValue[];
  diagnostics: {
    specifiedDimensions: string[];
    unspecifiedDimensions: string[];
    slicesUsed: number;
    meceVerification: Record<string, { isComplete: boolean; canAggregate: boolean; values: string[] }>;
    warnings: string[];
  };
}

/**
 * Extract context dimensions from a sliceDSL string.
 * Returns a map of key → value for all context() clauses.
 */
export function extractContextMap(sliceDSL: string): Map<string, string> {
  const dims = extractSliceDimensions(sliceDSL);
  if (!dims) return new Map();
  
  const parsed = parseConstraints(dims);
  const map = new Map<string, string>();
  for (const ctx of parsed.context) {
    map.set(ctx.key, ctx.value);
  }
  return map;
}

/**
 * Check if a slice matches ALL specified dimension values.
 */
export function matchesSpecifiedDimensions(
  sliceContextMap: Map<string, string>,
  specifiedDimensions: Map<string, string>
): boolean {
  for (const [key, value] of specifiedDimensions) {
    if (sliceContextMap.get(key) !== value) return false;
  }
  return true;
}

/**
 * Identify unspecified dimensions (keys in slice but not in query).
 */
export function getUnspecifiedDimensions(
  sliceContextMap: Map<string, string>,
  queryContextMap: Map<string, string>
): string[] {
  const unspecified: string[] = [];
  for (const key of sliceContextMap.keys()) {
    if (!queryContextMap.has(key)) {
      unspecified.push(key);
    }
  }
  return unspecified.sort();
}

/**
 * Verify MECE for a specific dimension within filtered slices.
 */
export function verifyMECEForDimension(
  slices: ParameterValue[],
  dimensionKey: string
): { isMECE: boolean; isComplete: boolean; canAggregate: boolean; valuesPresent: string[]; missingValues: string[] } {
  // Extract all values for this dimension from slices
  const valuesPresent = new Set<string>();
  for (const slice of slices) {
    const ctxMap = extractContextMap(slice.sliceDSL ?? '');
    const value = ctxMap.get(dimensionKey);
    if (value) valuesPresent.add(value);
  }
  
  // Check against context definition
  const meceResult = contextRegistry.detectMECEPartitionSync(
    Array.from(valuesPresent).map(v => ({ sliceDSL: `context(${dimensionKey}:${v})` })),
    dimensionKey
  );
  
  return {
    isMECE: meceResult.isMECE,
    isComplete: meceResult.isComplete,
    canAggregate: meceResult.canAggregate,
    valuesPresent: Array.from(valuesPresent).sort(),
    missingValues: meceResult.missingValues,
  };
}

/**
 * Aggregate slices by summing n_daily/k_daily arrays.
 * All slices must have same date arrays (verified by caller).
 */
export function aggregateSlices(slices: ParameterValue[]): ParameterValue | null {
  if (slices.length === 0) return null;
  if (slices.length === 1) return slices[0];
  
  // Use first slice as template
  const template = slices[0];
  const dates = template.dates;
  if (!dates || dates.length === 0) return null;
  
  // Verify all slices have same dates
  for (const slice of slices) {
    if (!slice.dates || slice.dates.length !== dates.length) {
      return null; // Date arrays don't match
    }
    for (let i = 0; i < dates.length; i++) {
      if (slice.dates[i] !== dates[i]) return null;
    }
  }
  
  // Sum n_daily and k_daily
  const n_daily = new Array(dates.length).fill(0);
  const k_daily = new Array(dates.length).fill(0);
  
  for (const slice of slices) {
    for (let i = 0; i < dates.length; i++) {
      n_daily[i] += slice.n_daily?.[i] ?? 0;
      k_daily[i] += slice.k_daily?.[i] ?? 0;
    }
  }
  
  // Compute aggregate statistics
  const n = n_daily.reduce((sum, v) => sum + v, 0);
  const k = k_daily.reduce((sum, v) => sum + v, 0);
  
  return {
    ...template,
    sliceDSL: '', // Becomes uncontexted after full reduction
    n,
    k,
    mean: n > 0 ? k / n : undefined,
    n_daily,
    k_daily,
    dates,
    // Clear individual slice metadata
    data_source: {
      ...template.data_source,
      aggregated_from: slices.length,
    },
  };
}

/**
 * Attempt dimensional reduction for a query over multi-dimensional cache.
 */
export function tryDimensionalReduction(
  allSlices: ParameterValue[],
  queryDSL: string
): DimensionalReductionResult {
  const warnings: string[] = [];
  
  // Parse query dimensions
  const queryDims = extractSliceDimensions(queryDSL);
  const queryParsed = parseConstraints(queryDims || '');
  const queryContextMap = new Map<string, string>();
  for (const ctx of queryParsed.context) {
    queryContextMap.set(ctx.key, ctx.value);
  }
  
  // Get all unique dimension sets from slices
  const sliceDimensionSets = new Set<string>();
  for (const slice of allSlices) {
    const dims = extractSliceDimensions(slice.sliceDSL ?? '');
    if (dims) sliceDimensionSets.add(dims);
  }
  
  // Find slices that match specified dimensions (but may have extras)
  const matchingSlices: ParameterValue[] = [];
  let unspecifiedDimensions: string[] | null = null;
  
  for (const slice of allSlices) {
    const sliceContextMap = extractContextMap(slice.sliceDSL ?? '');
    
    if (matchesSpecifiedDimensions(sliceContextMap, queryContextMap)) {
      matchingSlices.push(slice);
      
      // Determine unspecified dimensions from first matching slice
      if (unspecifiedDimensions === null) {
        unspecifiedDimensions = getUnspecifiedDimensions(sliceContextMap, queryContextMap);
      }
    }
  }
  
  if (matchingSlices.length === 0) {
    return {
      kind: 'not_reducible',
      reason: 'no_matching_slices',
      diagnostics: {
        specifiedDimensions: Array.from(queryContextMap.keys()),
        unspecifiedDimensions: [],
        slicesUsed: 0,
        meceVerification: {},
        warnings: ['No slices match the specified dimension values'],
      },
    };
  }
  
  unspecifiedDimensions = unspecifiedDimensions ?? [];
  
  if (unspecifiedDimensions.length === 0) {
    // No dimensional reduction needed - exact match
    return {
      kind: 'reduced',
      aggregatedValues: matchingSlices,
      diagnostics: {
        specifiedDimensions: Array.from(queryContextMap.keys()),
        unspecifiedDimensions: [],
        slicesUsed: matchingSlices.length,
        meceVerification: {},
        warnings: [],
      },
    };
  }
  
  // Verify MECE for each unspecified dimension
  const meceVerification: Record<string, { isComplete: boolean; canAggregate: boolean; values: string[] }> = {};
  
  for (const dimKey of unspecifiedDimensions) {
    const meceCheck = verifyMECEForDimension(matchingSlices, dimKey);
    meceVerification[dimKey] = {
      isComplete: meceCheck.isComplete,
      canAggregate: meceCheck.canAggregate,
      values: meceCheck.valuesPresent,
    };
    
    if (!meceCheck.isMECE) {
      return {
        kind: 'not_reducible',
        reason: `dimension_not_mece:${dimKey}`,
        diagnostics: {
          specifiedDimensions: Array.from(queryContextMap.keys()),
          unspecifiedDimensions,
          slicesUsed: matchingSlices.length,
          meceVerification,
          warnings: [`Dimension '${dimKey}' is not MECE (missing: ${meceCheck.missingValues.join(', ')})`],
        },
      };
    }
    
    if (!meceCheck.canAggregate) {
      return {
        kind: 'not_reducible',
        reason: `dimension_not_aggregatable:${dimKey}`,
        diagnostics: {
          specifiedDimensions: Array.from(queryContextMap.keys()),
          unspecifiedDimensions,
          slicesUsed: matchingSlices.length,
          meceVerification,
          warnings: [`Dimension '${dimKey}' policy does not allow aggregation`],
        },
      };
    }
    
    if (!meceCheck.isComplete) {
      warnings.push(`Dimension '${dimKey}' is incomplete but aggregatable (missing: ${meceCheck.missingValues.join(', ')})`);
    }
  }
  
  // Group slices by their specified-dimension values for aggregation
  // (For single-value specified dimensions, this is just one group)
  const aggregated = aggregateSlices(matchingSlices);
  
  if (!aggregated) {
    return {
      kind: 'not_reducible',
      reason: 'aggregation_failed',
      diagnostics: {
        specifiedDimensions: Array.from(queryContextMap.keys()),
        unspecifiedDimensions,
        slicesUsed: matchingSlices.length,
        meceVerification,
        warnings: [...warnings, 'Failed to aggregate slices (date arrays may not align)'],
      },
    };
  }
  
  // Update sliceDSL to reflect remaining dimensions only
  const remainingDims = Array.from(queryContextMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `context(${k}:${v})`)
    .join('.');
  aggregated.sliceDSL = remainingDims || undefined;
  
  return {
    kind: 'reduced',
    aggregatedValues: [aggregated],
    diagnostics: {
      specifiedDimensions: Array.from(queryContextMap.keys()),
      unspecifiedDimensions,
      slicesUsed: matchingSlices.length,
      meceVerification,
      warnings,
    },
  };
}
```

#### 7.3.2 Extend `meceSliceService.ts`

**Change**: Relax `isEligibleContextOnlySlice` to support multi-dimensional slices for dimensional reduction scenarios.

**New function** (add to meceSliceService.ts):

```typescript
/**
 * Check if a slice is eligible for multi-dimensional MECE reduction.
 * Unlike isEligibleContextOnlySlice (single-key only), this accepts
 * slices with multiple context dimensions.
 * 
 * Returns the context map if eligible, null otherwise.
 */
export function isEligibleMultiContextSlice(
  value: ParameterValue
): Map<string, string> | null {
  const dsl = value.sliceDSL ?? '';
  const dims = extractSliceDimensions(dsl);
  if (!dims) return null;
  
  // Reject case dimensions (only context supported)
  if (dims.includes('case(')) return null;
  
  const parsed = parseConstraints(dims);
  
  // Reject contextAny (ambiguous)
  if (parsed.contextAny.length > 0) return null;
  
  // Require at least one context dimension
  if (parsed.context.length === 0) return null;
  
  // Build and return context map
  const map = new Map<string, string>();
  for (const ctx of parsed.context) {
    map.set(ctx.key, ctx.value);
  }
  return map;
}

/**
 * Compute MECE generation candidates for multi-dimensional slices.
 * Groups by (specified dimensions, query_signature) and verifies MECE
 * for unspecified dimensions within each group.
 */
export function computeMultiDimMECECandidates(
  candidateValues: ParameterValue[],
  specifiedDimensions: Map<string, string>,
  options?: { requireComplete?: boolean }
): {
  candidates: Array<{
    specifiedDims: Map<string, string>;
    unspecifiedDims: string[];
    querySignature: string | null;
    values: ParameterValue[];
    meceStatus: Record<string, { isMECE: boolean; isComplete: boolean; canAggregate: boolean }>;
    warnings: string[];
    recencyMs: number;
  }>;
  warnings: string[];
} {
  const requireComplete = options?.requireComplete !== false;
  const warnings: string[] = [];
  
  // Filter to eligible multi-context slices that match specified dims
  const eligible: Array<{
    pv: ParameterValue;
    contextMap: Map<string, string>;
    sig: string | null;
  }> = [];
  
  for (const pv of candidateValues) {
    const ctxMap = isEligibleMultiContextSlice(pv);
    if (!ctxMap) continue;
    
    // Must match all specified dimensions
    let matches = true;
    for (const [key, value] of specifiedDimensions) {
      if (ctxMap.get(key) !== value) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    
    eligible.push({
      pv,
      contextMap: ctxMap,
      sig: normaliseQuerySignature((pv as any).query_signature),
    });
  }
  
  if (eligible.length === 0) {
    return { candidates: [], warnings: ['No eligible multi-context slices found'] };
  }
  
  // Determine unspecified dimensions from first eligible slice
  const firstCtxMap = eligible[0].contextMap;
  const unspecifiedDims = Array.from(firstCtxMap.keys())
    .filter(k => !specifiedDimensions.has(k))
    .sort();
  
  // Group by query_signature
  const bySignature = new Map<string, ParameterValue[]>();
  for (const e of eligible) {
    const sigKey = e.sig ?? '__legacy__';
    const arr = bySignature.get(sigKey) ?? [];
    arr.push(e.pv);
    bySignature.set(sigKey, arr);
  }
  
  // For each signature group, verify MECE for all unspecified dimensions
  const candidates: Array<{
    specifiedDims: Map<string, string>;
    unspecifiedDims: string[];
    querySignature: string | null;
    values: ParameterValue[];
    meceStatus: Record<string, { isMECE: boolean; isComplete: boolean; canAggregate: boolean }>;
    warnings: string[];
    recencyMs: number;
  }> = [];
  
  for (const [sigKey, slices] of bySignature) {
    const meceStatus: Record<string, { isMECE: boolean; isComplete: boolean; canAggregate: boolean }> = {};
    let allMECE = true;
    let allCanAggregate = true;
    const genWarnings: string[] = [];
    
    for (const dimKey of unspecifiedDims) {
      const check = verifyMECEForDimension(slices, dimKey);
      meceStatus[dimKey] = {
        isMECE: check.isMECE,
        isComplete: check.isComplete,
        canAggregate: check.canAggregate,
      };
      
      if (!check.isMECE) allMECE = false;
      if (!check.canAggregate) allCanAggregate = false;
      if (!check.isComplete && check.missingValues.length > 0) {
        genWarnings.push(`Dimension '${dimKey}' incomplete: missing ${check.missingValues.join(', ')}`);
      }
    }
    
    if (!allMECE || !allCanAggregate) continue;
    if (requireComplete) {
      const anyIncomplete = Object.values(meceStatus).some(s => !s.isComplete);
      if (anyIncomplete) continue;
    }
    
    // Compute recency (stalest member)
    const recencyMs = slices.reduce(
      (min, s) => Math.min(min, parameterValueRecencyMs(s)),
      Number.POSITIVE_INFINITY
    );
    
    candidates.push({
      specifiedDims: specifiedDimensions,
      unspecifiedDims,
      querySignature: sigKey === '__legacy__' ? null : sigKey,
      values: slices,
      meceStatus,
      warnings: genWarnings,
      recencyMs: Number.isFinite(recencyMs) ? recencyMs : 0,
    });
  }
  
  return { candidates, warnings };
}
```

#### 7.3.3 Extend `sliceIsolation.ts`

**New function** (add to sliceIsolation.ts):

```typescript
/**
 * Isolate slices with partial dimension matching.
 * 
 * Unlike isolateSlice (exact match), this finds slices that:
 * - Match ALL specified dimensions exactly
 * - May have additional unspecified dimensions
 * 
 * Use for dimensional reduction scenarios where query specifies
 * fewer dimensions than cache contains.
 */
export function isolateSlicePartialMatch<T extends { sliceDSL?: string }>(
  values: T[],
  targetSlice: string
): { matched: T[]; unspecifiedDims: string[] } {
  const parsed = parseConstraints(targetSlice);
  
  // Build specified dimensions map
  const specifiedDims = new Map<string, string>();
  for (const ctx of parsed.context) {
    specifiedDims.set(ctx.key, ctx.value);
  }
  
  if (specifiedDims.size === 0) {
    // Uncontexted query - return all contexted values for MECE consideration
    const contexted = values.filter(v => extractSliceDimensions(v.sliceDSL ?? '') !== '');
    const unspecified = new Set<string>();
    for (const v of contexted) {
      const dims = extractSliceDimensions(v.sliceDSL ?? '');
      if (!dims) continue;
      const p = parseConstraints(dims);
      for (const c of p.context) unspecified.add(c.key);
    }
    return { matched: contexted, unspecifiedDims: Array.from(unspecified).sort() };
  }
  
  // Find values matching specified dimensions
  const matched: T[] = [];
  let unspecifiedDims: string[] | null = null;
  
  for (const v of values) {
    const dims = extractSliceDimensions(v.sliceDSL ?? '');
    if (!dims) continue;
    
    const vParsed = parseConstraints(dims);
    const vDims = new Map<string, string>();
    for (const c of vParsed.context) vDims.set(c.key, c.value);
    
    // Check if all specified dimensions match
    let allMatch = true;
    for (const [key, value] of specifiedDims) {
      if (vDims.get(key) !== value) {
        allMatch = false;
        break;
      }
    }
    
    if (allMatch) {
      matched.push(v);
      
      // Capture unspecified dimensions from first match
      if (unspecifiedDims === null) {
        unspecifiedDims = Array.from(vDims.keys())
          .filter(k => !specifiedDims.has(k))
          .sort();
      }
    }
  }
  
  return { matched, unspecifiedDims: unspecifiedDims ?? [] };
}
```

#### 7.3.4 Update `windowAggregationService.ts`

**Modify** `hasFullSliceCoverageByHeader` to try dimensional reduction when exact match fails:

```typescript
// Add after line 354 (after tryMECEShouldCover returns false)

// 3) Try dimensional reduction for multi-dim cache
const dimReductionResult = tryDimensionalReductionCoverage(
  modeFiltered,
  targetSlice,
  requestedWindow
);
if (dimReductionResult) return true;

return false;

// New helper function
function tryDimensionalReductionCoverage(
  values: ParameterValue[],
  targetSlice: string,
  requestedWindow: DateRange
): boolean {
  const { matched, unspecifiedDims } = isolateSlicePartialMatch(values, targetSlice);
  if (matched.length === 0 || unspecifiedDims.length === 0) return false;
  
  // Verify MECE for all unspecified dimensions
  for (const dimKey of unspecifiedDims) {
    const meceCheck = verifyMECEForDimension(matched, dimKey);
    if (!meceCheck.isMECE || !meceCheck.canAggregate) return false;
  }
  
  // Check if matched slices cover the window
  return unionCoversWindow(matched);
}
```

### 7.4 Algorithm Flow

```
Query: context(channel:google).window(1-Nov-25:7-Nov-25)
Cache: 20 slices with context(channel:X).context(device:Y)

┌─────────────────────────────────────────────────────────────┐
│ Step 1: Signature Matching (canCacheSatisfyQuery)           │
│   Query sig: {c:"core", x:{channel:"abc"}}                  │
│   Cache sig: {c:"core", x:{channel:"abc", device:"def"}}    │
│   Result: COMPATIBLE (query ⊆ cache)                        │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 2: Exact Slice Isolation (isolateSlice)                │
│   Target: "context(channel:google)"                         │
│   Cache slices: "context(channel:google).context(device:X)" │
│   Result: NO EXACT MATCH (dims differ)                      │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 3: Partial Match Isolation (isolateSlicePartialMatch)  │
│   Specified dims: {channel: "google"}                       │
│   Matched: 5 slices (google+mobile, google+desktop, ...)    │
│   Unspecified dims: ["device"]                              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 4: MECE Verification (verifyMECEForDimension)          │
│   Dimension: "device"                                       │
│   Values present: [mobile, desktop, tablet, ios, android]   │
│   Context definition: 5 values, otherPolicy: undefined      │
│   Result: isMECE=true, isComplete=true, canAggregate=true   │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 5: Window Coverage Check (unionCoversWindow)           │
│   5 matched slices all have window_from/to covering query   │
│   Result: COVERED                                           │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 6: Aggregation (aggregateSlices)                       │
│   Sum n_daily across 5 slices                               │
│   Sum k_daily across 5 slices                               │
│   Result: Single aggregated ParameterValue                  │
└─────────────────────────────────────────────────────────────┘
```

### 7.5 Edge Cases and Handling

| Edge Case | Handling |
|-----------|----------|
| **Slices have different date arrays** | Aggregation fails → demand refetch |
| **One unspecified dimension incomplete** | MECE check fails → demand refetch |
| **Multiple unspecified dimensions** | Verify MECE for ALL, aggregate if all pass |
| **otherPolicy forbids aggregation** | canAggregate=false → demand refetch |
| **Mixed signatures within filtered set** | Group by signature, pick best MECE generation |
| **contextAny in cache** | Rejected by isEligibleMultiContextSlice |
| **case dimensions in cache** | Rejected by isEligibleMultiContextSlice |

### 7.6 Implementation Files Summary

| File | Changes |
|------|---------|
| `dimensionalReductionService.ts` | **NEW** — Core dimensional reduction logic |
| `meceSliceService.ts` | **EXTEND** — Add `isEligibleMultiContextSlice`, `computeMultiDimMECECandidates` |
| `sliceIsolation.ts` | **EXTEND** — Add `isolateSlicePartialMatch` |
| `windowAggregationService.ts` | **MODIFY** — Add `tryDimensionalReductionCoverage` in `hasFullSliceCoverageByHeader` |
| `fetchPlanBuilderService.ts` | **MODIFY** — Use dimensional reduction for coverage check |

---

## 8. Phase 5 Test Strategy

### 8.1 Unit Tests: dimensionalReductionService.test.ts

```typescript
describe('dimensionalReductionService', () => {
  describe('extractContextMap', () => {
    it('extracts single context dimension', () => {
      const map = extractContextMap('context(channel:google)');
      expect(map.get('channel')).toBe('google');
      expect(map.size).toBe(1);
    });

    it('extracts multiple context dimensions', () => {
      const map = extractContextMap('context(channel:google).context(device:mobile)');
      expect(map.get('channel')).toBe('google');
      expect(map.get('device')).toBe('mobile');
      expect(map.size).toBe(2);
    });

    it('returns empty map for uncontexted', () => {
      expect(extractContextMap('')).toEqual(new Map());
      expect(extractContextMap('window(1-Nov-25:7-Nov-25)')).toEqual(new Map());
    });

    it('ignores window/cohort in sliceDSL', () => {
      const map = extractContextMap('context(channel:google).window(1-Nov-25:7-Nov-25)');
      expect(map.size).toBe(1);
      expect(map.get('channel')).toBe('google');
    });
  });

  describe('matchesSpecifiedDimensions', () => {
    it('returns true for exact match', () => {
      const slice = new Map([['channel', 'google']]);
      const query = new Map([['channel', 'google']]);
      expect(matchesSpecifiedDimensions(slice, query)).toBe(true);
    });

    it('returns true for superset (slice has extra dims)', () => {
      const slice = new Map([['channel', 'google'], ['device', 'mobile']]);
      const query = new Map([['channel', 'google']]);
      expect(matchesSpecifiedDimensions(slice, query)).toBe(true);
    });

    it('returns false for value mismatch', () => {
      const slice = new Map([['channel', 'meta']]);
      const query = new Map([['channel', 'google']]);
      expect(matchesSpecifiedDimensions(slice, query)).toBe(false);
    });

    it('returns false for missing dimension in slice', () => {
      const slice = new Map([['device', 'mobile']]);
      const query = new Map([['channel', 'google']]);
      expect(matchesSpecifiedDimensions(slice, query)).toBe(false);
    });

    it('returns true for empty query (uncontexted)', () => {
      const slice = new Map([['channel', 'google'], ['device', 'mobile']]);
      const query = new Map<string, string>();
      expect(matchesSpecifiedDimensions(slice, query)).toBe(true);
    });
  });

  describe('getUnspecifiedDimensions', () => {
    it('identifies single unspecified dimension', () => {
      const slice = new Map([['channel', 'google'], ['device', 'mobile']]);
      const query = new Map([['channel', 'google']]);
      expect(getUnspecifiedDimensions(slice, query)).toEqual(['device']);
    });

    it('identifies multiple unspecified dimensions', () => {
      const slice = new Map([['channel', 'google'], ['device', 'mobile'], ['region', 'uk']]);
      const query = new Map([['channel', 'google']]);
      expect(getUnspecifiedDimensions(slice, query)).toEqual(['device', 'region']);
    });

    it('returns empty array for exact match', () => {
      const slice = new Map([['channel', 'google']]);
      const query = new Map([['channel', 'google']]);
      expect(getUnspecifiedDimensions(slice, query)).toEqual([]);
    });

    it('returns all dimensions for uncontexted query', () => {
      const slice = new Map([['channel', 'google'], ['device', 'mobile']]);
      const query = new Map<string, string>();
      expect(getUnspecifiedDimensions(slice, query)).toEqual(['channel', 'device']);
    });
  });

  describe('verifyMECEForDimension', () => {
    beforeEach(() => {
      // Seed context definitions
      vi.spyOn(contextRegistry, 'detectMECEPartitionSync').mockImplementation((windows, key) => {
        if (key === 'device') {
          const values = windows.map(w => {
            const m = w.sliceDSL?.match(/context\(device:([^)]+)\)/);
            return m?.[1];
          }).filter(Boolean);
          const expected = ['mobile', 'desktop', 'tablet', 'ios', 'android'];
          const missing = expected.filter(v => !values.includes(v));
          return {
            isMECE: missing.length === 0,
            isComplete: missing.length === 0,
            canAggregate: true,
            missingValues: missing,
            policy: 'undefined',
          };
        }
        return { isMECE: false, isComplete: false, canAggregate: false, missingValues: [], policy: 'unknown' };
      });
    });

    it('returns MECE=true when all values present', () => {
      const slices = [
        { sliceDSL: 'context(channel:google).context(device:mobile)' },
        { sliceDSL: 'context(channel:google).context(device:desktop)' },
        { sliceDSL: 'context(channel:google).context(device:tablet)' },
        { sliceDSL: 'context(channel:google).context(device:ios)' },
        { sliceDSL: 'context(channel:google).context(device:android)' },
      ] as ParameterValue[];

      const result = verifyMECEForDimension(slices, 'device');
      expect(result.isMECE).toBe(true);
      expect(result.isComplete).toBe(true);
      expect(result.canAggregate).toBe(true);
    });

    it('returns MECE=false when values missing', () => {
      const slices = [
        { sliceDSL: 'context(channel:google).context(device:mobile)' },
        { sliceDSL: 'context(channel:google).context(device:desktop)' },
        // Missing tablet, ios, android
      ] as ParameterValue[];

      const result = verifyMECEForDimension(slices, 'device');
      expect(result.isMECE).toBe(false);
      expect(result.missingValues).toContain('tablet');
    });
  });

  describe('aggregateSlices', () => {
    it('sums n_daily and k_daily across slices', () => {
      const slices: ParameterValue[] = [
        { sliceDSL: 'context(device:mobile)', dates: ['1-Nov-25', '2-Nov-25'], n_daily: [100, 110], k_daily: [50, 55] },
        { sliceDSL: 'context(device:desktop)', dates: ['1-Nov-25', '2-Nov-25'], n_daily: [200, 220], k_daily: [100, 110] },
      ] as any;

      const result = aggregateSlices(slices);
      expect(result?.n_daily).toEqual([300, 330]);
      expect(result?.k_daily).toEqual([150, 165]);
      expect(result?.n).toBe(630);
      expect(result?.k).toBe(315);
    });

    it('returns null if date arrays do not match', () => {
      const slices: ParameterValue[] = [
        { sliceDSL: 'context(device:mobile)', dates: ['1-Nov-25', '2-Nov-25'], n_daily: [100, 110], k_daily: [50, 55] },
        { sliceDSL: 'context(device:desktop)', dates: ['1-Nov-25', '3-Nov-25'], n_daily: [200, 220], k_daily: [100, 110] },
      ] as any;

      expect(aggregateSlices(slices)).toBeNull();
    });

    it('returns single slice unchanged', () => {
      const slice = { sliceDSL: 'context(device:mobile)', dates: ['1-Nov-25'], n_daily: [100], k_daily: [50] } as any;
      expect(aggregateSlices([slice])).toBe(slice);
    });

    it('returns null for empty array', () => {
      expect(aggregateSlices([])).toBeNull();
    });

    it('handles missing n_daily/k_daily gracefully', () => {
      const slices: ParameterValue[] = [
        { sliceDSL: 'context(device:mobile)', dates: ['1-Nov-25'], n_daily: [100], k_daily: [50] },
        { sliceDSL: 'context(device:desktop)', dates: ['1-Nov-25'] }, // missing arrays
      ] as any;

      const result = aggregateSlices(slices);
      expect(result?.n_daily).toEqual([100]); // 100 + 0
      expect(result?.k_daily).toEqual([50]);  // 50 + 0
    });
  });

  describe('tryDimensionalReduction', () => {
    const makeSlice = (channel: string, device: string): ParameterValue => ({
      sliceDSL: `context(channel:${channel}).context(device:${device})`,
      dates: ['1-Nov-25', '2-Nov-25'],
      n_daily: [100, 100],
      k_daily: [50, 50],
      window_from: '1-Nov-25',
      window_to: '2-Nov-25',
    } as any);

    beforeEach(() => {
      // Mock MECE verification
      vi.spyOn(contextRegistry, 'detectMECEPartitionSync').mockImplementation((windows, key) => {
        if (key === 'device') {
          const values = windows.map(w => {
            const m = w.sliceDSL?.match(/context\(device:([^)]+)\)/);
            return m?.[1];
          }).filter(Boolean);
          const expected = ['mobile', 'desktop'];
          const missing = expected.filter(v => !values.includes(v));
          return {
            isMECE: missing.length === 0,
            isComplete: missing.length === 0,
            canAggregate: true,
            missingValues: missing,
            policy: 'undefined',
          };
        }
        return { isMECE: false, isComplete: false, canAggregate: false, missingValues: [], policy: 'unknown' };
      });
    });

    it('reduces single-dim query over two-dim MECE cache', () => {
      const slices = [
        makeSlice('google', 'mobile'),
        makeSlice('google', 'desktop'),
        makeSlice('meta', 'mobile'),
        makeSlice('meta', 'desktop'),
      ];

      const result = tryDimensionalReduction(slices, 'context(channel:google)');
      
      expect(result.kind).toBe('reduced');
      expect(result.aggregatedValues?.length).toBe(1);
      expect(result.diagnostics.specifiedDimensions).toEqual(['channel']);
      expect(result.diagnostics.unspecifiedDimensions).toEqual(['device']);
      expect(result.diagnostics.slicesUsed).toBe(2); // google+mobile, google+desktop
    });

    it('fails reduction when MECE incomplete', () => {
      const slices = [
        makeSlice('google', 'mobile'),
        // Missing google+desktop
        makeSlice('meta', 'mobile'),
        makeSlice('meta', 'desktop'),
      ];

      const result = tryDimensionalReduction(slices, 'context(channel:google)');
      
      expect(result.kind).toBe('not_reducible');
      expect(result.reason).toContain('dimension_not_mece');
    });

    it('handles uncontexted query over multi-dim cache', () => {
      // For uncontexted query, ALL dimensions become unspecified
      // This requires MECE for BOTH channel AND device
      vi.spyOn(contextRegistry, 'detectMECEPartitionSync').mockImplementation((windows, key) => {
        const expected = key === 'channel' ? ['google', 'meta'] : ['mobile', 'desktop'];
        const regex = new RegExp(`context\\(${key}:([^)]+)\\)`);
        const values = windows.map(w => {
          const m = w.sliceDSL?.match(regex);
          return m?.[1];
        }).filter(Boolean);
        const missing = expected.filter(v => !values.includes(v));
        return {
          isMECE: missing.length === 0,
          isComplete: missing.length === 0,
          canAggregate: true,
          missingValues: missing,
          policy: 'undefined',
        };
      });

      const slices = [
        makeSlice('google', 'mobile'),
        makeSlice('google', 'desktop'),
        makeSlice('meta', 'mobile'),
        makeSlice('meta', 'desktop'),
      ];

      const result = tryDimensionalReduction(slices, ''); // uncontexted
      
      expect(result.kind).toBe('reduced');
      expect(result.diagnostics.unspecifiedDimensions).toEqual(['channel', 'device']);
      expect(result.diagnostics.slicesUsed).toBe(4);
    });

    it('returns no_matching_slices when specified dim value not in cache', () => {
      const slices = [
        makeSlice('google', 'mobile'),
        makeSlice('google', 'desktop'),
      ];

      const result = tryDimensionalReduction(slices, 'context(channel:tiktok)');
      
      expect(result.kind).toBe('not_reducible');
      expect(result.reason).toBe('no_matching_slices');
    });
  });
});
```

### 8.2 Unit Tests: meceSliceService Multi-Dim Extensions

```typescript
describe('meceSliceService - multi-dimensional extensions', () => {
  describe('isEligibleMultiContextSlice', () => {
    it('returns context map for single-context slice', () => {
      const pv = { sliceDSL: 'context(channel:google)' } as ParameterValue;
      const result = isEligibleMultiContextSlice(pv);
      expect(result?.get('channel')).toBe('google');
      expect(result?.size).toBe(1);
    });

    it('returns context map for multi-context slice', () => {
      const pv = { sliceDSL: 'context(channel:google).context(device:mobile)' } as ParameterValue;
      const result = isEligibleMultiContextSlice(pv);
      expect(result?.get('channel')).toBe('google');
      expect(result?.get('device')).toBe('mobile');
      expect(result?.size).toBe(2);
    });

    it('returns null for uncontexted slice', () => {
      const pv = { sliceDSL: 'window(1-Nov-25:7-Nov-25)' } as ParameterValue;
      expect(isEligibleMultiContextSlice(pv)).toBeNull();
    });

    it('returns null for case dimensions', () => {
      const pv = { sliceDSL: 'context(channel:google).case(region:uk)' } as ParameterValue;
      expect(isEligibleMultiContextSlice(pv)).toBeNull();
    });

    it('returns null for contextAny', () => {
      const pv = { sliceDSL: 'contextAny(channel:google,channel:meta)' } as ParameterValue;
      expect(isEligibleMultiContextSlice(pv)).toBeNull();
    });
  });

  describe('computeMultiDimMECECandidates', () => {
    // Tests for grouping by signature and verifying MECE for each group
    it('groups slices by query_signature', () => {
      const slices = [
        { sliceDSL: 'context(channel:google).context(device:mobile)', query_signature: 'sig-a' },
        { sliceDSL: 'context(channel:google).context(device:desktop)', query_signature: 'sig-a' },
        { sliceDSL: 'context(channel:google).context(device:mobile)', query_signature: 'sig-b' },
      ] as ParameterValue[];

      // Mock MECE for device
      vi.spyOn(contextRegistry, 'detectMECEPartitionSync').mockReturnValue({
        isMECE: true, isComplete: true, canAggregate: true, missingValues: [], policy: 'undefined'
      });

      const result = computeMultiDimMECECandidates(
        slices,
        new Map([['channel', 'google']])
      );

      // sig-a has 2 slices (mobile, desktop) → MECE
      // sig-b has 1 slice (mobile only) → NOT MECE
      expect(result.candidates.length).toBe(1);
      expect(result.candidates[0].querySignature).toBe('sig-a');
    });

    it('selects freshest MECE generation', () => {
      // Test that among multiple valid generations, the freshest is preferred
      // (This is tested via the caller's selection logic)
    });
  });
});
```

### 8.3 Unit Tests: sliceIsolation Partial Match

```typescript
describe('sliceIsolation - partial match', () => {
  describe('isolateSlicePartialMatch', () => {
    const makeSlice = (dims: string) => ({ sliceDSL: dims } as { sliceDSL: string });

    it('matches slices with superset dimensions', () => {
      const values = [
        makeSlice('context(channel:google).context(device:mobile)'),
        makeSlice('context(channel:google).context(device:desktop)'),
        makeSlice('context(channel:meta).context(device:mobile)'),
      ];

      const { matched, unspecifiedDims } = isolateSlicePartialMatch(values, 'context(channel:google)');
      
      expect(matched.length).toBe(2);
      expect(unspecifiedDims).toEqual(['device']);
    });

    it('returns all contexted slices for uncontexted query', () => {
      const values = [
        makeSlice('context(channel:google).context(device:mobile)'),
        makeSlice('context(channel:meta)'),
        makeSlice('window(1-Nov-25:7-Nov-25)'), // uncontexted
      ];

      const { matched, unspecifiedDims } = isolateSlicePartialMatch(values, '');
      
      expect(matched.length).toBe(2); // Both contexted slices
      expect(unspecifiedDims).toContain('channel');
    });

    it('requires ALL specified dimensions to match', () => {
      const values = [
        makeSlice('context(channel:google).context(device:mobile).context(region:uk)'),
        makeSlice('context(channel:google).context(device:mobile).context(region:us)'),
      ];

      const { matched } = isolateSlicePartialMatch(
        values,
        'context(channel:google).context(device:desktop)' // device mismatch
      );
      
      expect(matched.length).toBe(0);
    });

    it('handles three-dimensional slices', () => {
      const values = [
        makeSlice('context(channel:google).context(device:mobile).context(region:uk)'),
        makeSlice('context(channel:google).context(device:mobile).context(region:us)'),
        makeSlice('context(channel:google).context(device:desktop).context(region:uk)'),
        makeSlice('context(channel:google).context(device:desktop).context(region:us)'),
      ];

      const { matched, unspecifiedDims } = isolateSlicePartialMatch(
        values,
        'context(channel:google).context(device:mobile)'
      );
      
      expect(matched.length).toBe(2); // uk + us for google+mobile
      expect(unspecifiedDims).toEqual(['region']);
    });
  });
});
```

### 8.4 Integration Tests: Dimensional Reduction E2E

```typescript
describe('Dimensional Reduction E2E', () => {
  describe('hasFullSliceCoverageByHeader with dimensional reduction', () => {
    beforeEach(() => {
      // Seed context definitions for MECE verification
      seedContextDefinition('channel', ['google', 'meta', 'tiktok', 'other']);
      seedContextDefinition('device', ['mobile', 'desktop', 'tablet']);
    });

    it('returns true for single-dim query over complete multi-dim MECE cache', () => {
      const paramFileData = {
        values: [
          // Complete 4×3 = 12 slices
          ...['google', 'meta', 'tiktok', 'other'].flatMap(ch =>
            ['mobile', 'desktop', 'tablet'].map(dev => ({
              sliceDSL: `context(channel:${ch}).context(device:${dev})`,
              window_from: '1-Nov-25',
              window_to: '7-Nov-25',
            }))
          ),
        ],
      };

      expect(hasFullSliceCoverageByHeader(
        paramFileData,
        { start: '1-Nov-25', end: '7-Nov-25' },
        'context(channel:google).window(1-Nov-25:7-Nov-25)'
      )).toBe(true);
    });

    it('returns false when unspecified dimension is incomplete', () => {
      const paramFileData = {
        values: [
          // Missing tablet for google
          { sliceDSL: 'context(channel:google).context(device:mobile)', window_from: '1-Nov-25', window_to: '7-Nov-25' },
          { sliceDSL: 'context(channel:google).context(device:desktop)', window_from: '1-Nov-25', window_to: '7-Nov-25' },
          // tablet missing!
        ],
      };

      expect(hasFullSliceCoverageByHeader(
        paramFileData,
        { start: '1-Nov-25', end: '7-Nov-25' },
        'context(channel:google).window(1-Nov-25:7-Nov-25)'
      )).toBe(false);
    });

    it('returns true for uncontexted query over complete multi-dim cache', () => {
      const paramFileData = {
        values: [
          // Complete 2×2 = 4 slices
          { sliceDSL: 'context(channel:google).context(device:mobile)', window_from: '1-Nov-25', window_to: '7-Nov-25' },
          { sliceDSL: 'context(channel:google).context(device:desktop)', window_from: '1-Nov-25', window_to: '7-Nov-25' },
          { sliceDSL: 'context(channel:meta).context(device:mobile)', window_from: '1-Nov-25', window_to: '7-Nov-25' },
          { sliceDSL: 'context(channel:meta).context(device:desktop)', window_from: '1-Nov-25', window_to: '7-Nov-25' },
        ],
      };

      // Adjust context defs for this test
      seedContextDefinition('channel', ['google', 'meta']);
      seedContextDefinition('device', ['mobile', 'desktop']);

      expect(hasFullSliceCoverageByHeader(
        paramFileData,
        { start: '1-Nov-25', end: '7-Nov-25' },
        'window(1-Nov-25:7-Nov-25)' // uncontexted
      )).toBe(true);
    });
  });

  describe('fetchPlanBuilder with dimensional reduction', () => {
    it('reports covered for single-dim query over multi-dim MECE cache', async () => {
      // Setup: Parameter file with multi-dimensional cache
      const paramFile = {
        id: 'param-test',
        data: {
          values: [
            // ... multi-dim slices with signatures
          ],
        },
      };
      mockFileRegistry.getFile.mockReturnValue(paramFile);

      // Build plan for single-dim query
      const plan = await buildFetchPlan({
        graph: mockGraph,
        dsl: 'context(channel:google).window(1-Nov-25:7-Nov-25)',
        // ... other params
      });

      expect(plan.items[0].classification).toBe('covered');
    });
  });

  describe('Aggregation correctness', () => {
    it('correctly sums n_daily/k_daily across reduced dimensions', async () => {
      const slices: ParameterValue[] = [
        {
          sliceDSL: 'context(channel:google).context(device:mobile)',
          dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25'],
          n_daily: [100, 110, 120],
          k_daily: [50, 55, 60],
        },
        {
          sliceDSL: 'context(channel:google).context(device:desktop)',
          dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25'],
          n_daily: [200, 210, 220],
          k_daily: [100, 105, 110],
        },
      ] as any;

      const result = tryDimensionalReduction(slices, 'context(channel:google)');
      
      expect(result.kind).toBe('reduced');
      const agg = result.aggregatedValues![0];
      expect(agg.n_daily).toEqual([300, 320, 340]);
      expect(agg.k_daily).toEqual([150, 160, 170]);
      expect(agg.n).toBe(960); // sum of n_daily
      expect(agg.k).toBe(480); // sum of k_daily
      expect(agg.mean).toBeCloseTo(0.5); // 480/960
    });

    it('preserves data_source metadata with aggregation info', async () => {
      // Verify aggregated values include metadata about source slices
    });
  });
});
```

### 8.5 Test Matrix: All Dimensional Scenarios

| # | Cache Dims | Query Dims | MECE Status | Expected Result | Test File |
|---|------------|------------|-------------|-----------------|-----------|
| 1 | 1 (channel) | 0 (uncontexted) | Complete | REDUCED | `meceSliceService.test.ts` |
| 2 | 1 (channel) | 1 (channel:google) | N/A (exact) | EXACT MATCH | `sliceIsolation.test.ts` |
| 3 | 2 (ch+dev) | 0 (uncontexted) | Both complete | REDUCED | `dimensionalReduction.test.ts` |
| 4 | 2 (ch+dev) | 1 (channel:google) | Device complete | REDUCED | `dimensionalReduction.test.ts` |
| 5 | 2 (ch+dev) | 1 (channel:google) | Device incomplete | NOT REDUCIBLE | `dimensionalReduction.test.ts` |
| 6 | 2 (ch+dev) | 2 (ch:g + dev:m) | N/A (exact) | EXACT MATCH | `sliceIsolation.test.ts` |
| 7 | 3 (ch+dev+reg) | 1 (channel:google) | Both dev+reg complete | REDUCED | `dimensionalReduction.test.ts` |
| 8 | 3 (ch+dev+reg) | 2 (ch:g + dev:m) | Region complete | REDUCED | `dimensionalReduction.test.ts` |
| 9 | 3 (ch+dev+reg) | 2 (ch:g + dev:m) | Region incomplete | NOT REDUCIBLE | `dimensionalReduction.test.ts` |
| 10 | 2 (ch+dev) | 0 (uncontexted) | Channel incomplete | NOT REDUCIBLE | `dimensionalReduction.test.ts` |
| 11 | 2 (ch+dev) | 1 (channel:google) | Device not aggregatable | NOT REDUCIBLE | `dimensionalReduction.test.ts` |
| 12 | 2 mixed sigs | 1 (channel:google) | One sig complete | REDUCED (best sig) | `meceSliceService.test.ts` |

### 8.6 Regression Tests

```typescript
describe('Dimensional Reduction Regressions', () => {
  it('REGRESSION: Single-dim MECE still works (no breakage from Phase 5)', () => {
    // Verify Phases 1-4 behaviour is preserved
    const paramFileData = {
      values: [
        { sliceDSL: 'context(channel:google)', window_from: '1-Nov-25', window_to: '7-Nov-25' },
        { sliceDSL: 'context(channel:meta)', window_from: '1-Nov-25', window_to: '7-Nov-25' },
        { sliceDSL: 'context(channel:other)', window_from: '1-Nov-25', window_to: '7-Nov-25' },
      ],
    };

    seedContextDefinition('channel', ['google', 'meta', 'other']);

    expect(hasFullSliceCoverageByHeader(
      paramFileData,
      { start: '1-Nov-25', end: '7-Nov-25' },
      'window(1-Nov-25:7-Nov-25)' // uncontexted
    )).toBe(true);
  });

  it('REGRESSION: Exact dimension match still uses exact path', () => {
    // Verify we don't unnecessarily use dimensional reduction
    const paramFileData = {
      values: [
        { sliceDSL: 'context(channel:google)', window_from: '1-Nov-25', window_to: '7-Nov-25' },
      ],
    };

    // Should use exact match, not dimensional reduction
    const result = isolateSlice(paramFileData.values, 'context(channel:google)');
    expect(result.length).toBe(1);
  });

  it('REGRESSION: case dimensions still rejected', () => {
    // case() is NOT supported for dimensional reduction
    const pv = { sliceDSL: 'context(channel:google).case(region:uk)' } as ParameterValue;
    expect(isEligibleMultiContextSlice(pv)).toBeNull();
  });
});
```

### 8.7 Test Count Summary (Phase 5)

| Category | Test Count | Description |
|----------|------------|-------------|
| **extractContextMap** | 4 | Single, multi, empty, with window |
| **matchesSpecifiedDimensions** | 5 | Exact, superset, mismatch, missing, empty query |
| **getUnspecifiedDimensions** | 4 | Single, multiple, exact, uncontexted |
| **verifyMECEForDimension** | 3 | Complete, incomplete, policy check |
| **aggregateSlices** | 5 | Sum, date mismatch, single, empty, missing arrays |
| **tryDimensionalReduction** | 5 | Happy path, MECE fail, uncontexted, no match, multi-dim |
| **isEligibleMultiContextSlice** | 5 | Single, multi, uncontexted, case, contextAny |
| **computeMultiDimMECECandidates** | 3 | Signature grouping, MECE selection, freshness |
| **isolateSlicePartialMatch** | 4 | Superset, uncontexted, all match, 3-dim |
| **Integration: coverage** | 4 | Complete MECE, incomplete, uncontexted, aggregation |
| **Test matrix scenarios** | 12 | All dimensional permutations |
| **Regressions** | 3 | Single-dim, exact match, case rejection |
| **Phase 5 Total** | **57** |

### 8.8 Updated Grand Total

| Phase | Tests |
|-------|-------|
| Phases 1-4 (from proposal) | 71 |
| Phase 5 (multi-dim) | 57 |
| **Grand Total** | **128** |

---

## 9. Implementation Plan (Complete)

### Phase 1: signatureMatchingService + Unit Tests

**Deliverables**:
- [ ] `src/services/signatureMatchingService.ts`
- [ ] `src/services/__tests__/signatureMatchingService.test.ts`

**Acceptance criteria**:
- All unit tests pass (37 tests)
- 100% branch coverage on matching logic

### Phase 2: Update computeQuerySignature + Component Tests

**Deliverables**:
- [ ] Updated `computeQuerySignature` in `dataOperationsService.ts`
  - Add `eventDefinitions` parameter
  - Add event definition hashing
  - Add `original_query` normalization (node_ids → event_ids)
  - Resolve `anchor_node_id` → `latency_anchor_event_id`
- [ ] Update call sites to pass `eventDefinitions` (from `buildDslFromEdge` result)
- [ ] `src/services/__tests__/dataOperationsService.signature.test.ts`

**Acceptance criteria**:
- Signature output is valid structured JSON
- Core hash stability tests pass
- Event definition hashing tests pass
- original_query normalization tests pass
- Latency anchor resolution tests pass
- Context hash correctness tests pass (22 tests total)

### Phase 3: Update Call Sites + Integration Tests

**Deliverables**:
- [ ] Updated `fetchPlanBuilderService.ts`
- [ ] Updated `windowAggregationService.ts`
- [ ] Integration tests in respective test files

**Acceptance criteria**:
- Superset matching works in planner
- Superset matching works in aggregation
- Rejection cases correctly demand refetch (7 tests)

### Phase 4: Enable + E2E Tests

**Deliverables**:
- [ ] Set `SIGNATURE_CHECKING_ENABLED = true`
- [ ] Set `SIGNATURE_WRITING_ENABLED = true`
- [ ] `src/services/__tests__/signature.e2e.test.ts`
- [ ] `src/services/__tests__/signatureRegression.test.ts`

**Acceptance criteria**:
- Original bug is fixed (regression test passes)
- Full fetch-cache-query cycle works
- All re-enabled tests pass (5 tests)

### Phase 5: Multi-Dimensional Context Aggregation

**Deliverables**:
- [ ] `src/services/dimensionalReductionService.ts` (NEW)
- [ ] `src/services/__tests__/dimensionalReductionService.test.ts` (NEW)
- [ ] Extended `meceSliceService.ts` with multi-dim functions
- [ ] Extended `sliceIsolation.ts` with `isolateSlicePartialMatch`
- [ ] Modified `windowAggregationService.ts` with dimensional reduction path
- [ ] Integration tests for multi-dim coverage
- [ ] Regression tests for single-dim behaviour

**Acceptance criteria**:
- All 57 Phase 5 tests pass
- Single-dim query over multi-dim cache: USES CACHE (when MECE)
- Uncontexted query over multi-dim cache: USES CACHE (when all dims MECE)
- Aggregation correctness verified (sum n_daily/k_daily)
- No regression in single-dim MECE behaviour
- case dimensions correctly rejected

**Dependencies**:
- Phases 1-4 must be complete (signature matching infrastructure)

---

## 10. Risk Assessment (Updated)

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| All existing caches invalidated | Certain | Low | Expected; one fetch cycle restores |
| Performance regression (JSON parse) | Low | Low | Parse is fast; cache if needed |
| False positive (accept invalid cache) | Low | Medium | Core hash + MECE verification protect |
| False negative (reject valid cache) | Very Low | Low | Subset matching is strictly more permissive |
| Test coverage gaps | Medium | High | 128 tests with full scenario matrix |
| **Phase 5: Aggregation math errors** | Low | High | Unit tests verify sum correctness |
| **Phase 5: Date array misalignment** | Medium | Medium | Explicit validation before aggregation |
| **Phase 5: MECE verification too strict** | Medium | Low | Follows existing context definition policies |
| **Phase 5: Performance with large slice sets** | Low | Medium | Lazy evaluation; early exit on MECE fail |

---

## 11. Success Criteria (Updated)

1. **Primary bug fixed**: Uncontexted query over single-dim MECE cache no longer demands refetch
2. **Multi-dim support**: Single-dim query over multi-dim MECE cache uses cache
3. **Full uncontexted support**: Uncontexted query over multi-dim MECE cache uses cache
4. **Tests pass**: All 128 unit, integration, and E2E tests pass
5. **Coverage**: 100% branch coverage on matching and reduction logic
6. **No regressions**: Existing single-dim MECE behaviour preserved
7. **Aggregation correctness**: Sum-based reduction verified mathematically
8. **Debuggable**: Session logs show dimensional reduction diagnostics

**Example**:
```
Cache: context(channel:google,device:mobile), context(channel:google,device:desktop), ...
Query: context(channel:google)

1. Unspecified dimensions: ['device']
2. Filter: slices where channel=google (5 slices)
3. Verify: device values in those 5 slices form complete MECE for 'device' context
4. Aggregate: sum those 5 slices
```

---

## 12. Future Work (Beyond Phase 5)

1. **Signature diagnostics UI**: Show signature match details in developer tools
2. **Cache warming**: Pre-compute signatures for likely queries after fetch
3. **Cross-parameter aggregation**: Aggregate across different parameter files with compatible signatures

---

## 13. Unit Tests: `signatureMatchingService.test.ts` (Phases 1-4)

### 13.1 Core Hash Matching Tests (continued)

```typescript
describe('signatureCanSatisfy - core hash edge cases', () => {
  it('rejects when query core is empty', () => {
    const cache = { coreHash: 'abc', contextDefHashes: {} };
    const query = { coreHash: '', contextDefHashes: {} };
    expect(signatureCanSatisfy(cache, query).compatible).toBe(false);
  });

  it('treats core hash comparison as case-sensitive', () => {
    const cache = { coreHash: 'ABC', contextDefHashes: {} };
    const query = { coreHash: 'abc', contextDefHashes: {} };
    expect(signatureCanSatisfy(cache, query).compatible).toBe(false);
  });
});
```

### 13.2 Matching Tests: Context Keys (THE CRITICAL CASES)

```typescript
describe('signatureCanSatisfy - context keys', () => {
  describe('superset matching (primary use case)', () => {
    it('CRITICAL: uncontexted query matches contexted cache', () => {
      // This is THE bug we're fixing
      const cache = { coreHash: 'abc', contextDefHashes: { channel: 'ch-hash' } };
      const query = { coreHash: 'abc', contextDefHashes: {} };
      expect(signatureCanSatisfy(cache, query).compatible).toBe(true);
    });

    it('CRITICAL: single-dimension query matches multi-dimensional cache', () => {
      const cache = { 
        coreHash: 'abc', 
        contextDefHashes: { channel: 'ch-hash', device: 'dv-hash' } 
      };
      const query = { coreHash: 'abc', contextDefHashes: { channel: 'ch-hash' } };
      expect(signatureCanSatisfy(cache, query).compatible).toBe(true);
    });

    it('matches when cache has 3+ extra dimensions', () => {
      const cache = { 
        coreHash: 'abc', 
        contextDefHashes: { a: '1', b: '2', c: '3', d: '4' } 
      };
      const query = { coreHash: 'abc', contextDefHashes: { a: '1' } };
      expect(signatureCanSatisfy(cache, query).compatible).toBe(true);
    });
  });

  describe('subset rejection (cache missing required key)', () => {
    it('rejects when cache has no context but query requires one', () => {
      const cache = { coreHash: 'abc', contextDefHashes: {} };
      const query = { coreHash: 'abc', contextDefHashes: { channel: 'ch-hash' } };
      const result = signatureCanSatisfy(cache, query);
      expect(result.compatible).toBe(false);
      expect(result.reason).toBe('missing_context_key:channel');
    });

    it('rejects when cache missing one of multiple required keys', () => {
      const cache = { coreHash: 'abc', contextDefHashes: { channel: 'ch-hash' } };
      const query = { 
        coreHash: 'abc', 
        contextDefHashes: { channel: 'ch-hash', device: 'dv-hash' } 
      };
      const result = signatureCanSatisfy(cache, query);
      expect(result.compatible).toBe(false);
      expect(result.reason).toBe('missing_context_key:device');
    });

    it('rejects when cache has different key than query requires', () => {
      const cache = { coreHash: 'abc', contextDefHashes: { region: 'rg-hash' } };
      const query = { coreHash: 'abc', contextDefHashes: { channel: 'ch-hash' } };
      expect(signatureCanSatisfy(cache, query).compatible).toBe(false);
    });
  });

  describe('definition hash mismatch', () => {
    it('rejects when same key has different def hash', () => {
      const cache = { coreHash: 'abc', contextDefHashes: { channel: 'old-hash' } };
      const query = { coreHash: 'abc', contextDefHashes: { channel: 'new-hash' } };
      const result = signatureCanSatisfy(cache, query);
      expect(result.compatible).toBe(false);
      expect(result.reason).toBe('context_def_mismatch:channel');
    });

    it('rejects when one of multiple keys has different def hash', () => {
      const cache = { 
        coreHash: 'abc', 
        contextDefHashes: { channel: 'ch-hash', device: 'old-dv-hash' } 
      };
      const query = { 
        coreHash: 'abc', 
        contextDefHashes: { channel: 'ch-hash', device: 'new-dv-hash' } 
      };
      expect(signatureCanSatisfy(cache, query).compatible).toBe(false);
    });

    it('superset with matching subset still valid', () => {
      // Cache has channel+device, query only needs channel (which matches)
      const cache = { 
        coreHash: 'abc', 
        contextDefHashes: { channel: 'ch-hash', device: 'dv-hash' } 
      };
      const query = { coreHash: 'abc', contextDefHashes: { channel: 'ch-hash' } };
      expect(signatureCanSatisfy(cache, query).compatible).toBe(true);
    });
  });

  describe('special context hash values', () => {
    it('handles "missing" def hash (context not loaded)', () => {
      const cache = { coreHash: 'abc', contextDefHashes: { channel: 'missing' } };
      const query = { coreHash: 'abc', contextDefHashes: { channel: 'missing' } };
      // Both have 'missing' - this is technically a match, but both are invalid
      expect(signatureCanSatisfy(cache, query).compatible).toBe(true);
    });

    it('rejects "missing" vs real hash', () => {
      const cache = { coreHash: 'abc', contextDefHashes: { channel: 'missing' } };
      const query = { coreHash: 'abc', contextDefHashes: { channel: 'real-hash' } };
      expect(signatureCanSatisfy(cache, query).compatible).toBe(false);
    });

    it('handles "error" def hash', () => {
      const cache = { coreHash: 'abc', contextDefHashes: { channel: 'error' } };
      const query = { coreHash: 'abc', contextDefHashes: { channel: 'error' } };
      expect(signatureCanSatisfy(cache, query).compatible).toBe(true);
    });
  });

  describe('both empty context', () => {
    it('matches when both have empty context', () => {
      const cache = { coreHash: 'abc', contextDefHashes: {} };
      const query = { coreHash: 'abc', contextDefHashes: {} };
      expect(signatureCanSatisfy(cache, query).compatible).toBe(true);
    });
  });
});
```

### 13.3 Convenience Function Tests

```typescript
describe('canCacheSatisfyQuery', () => {
  it('works with serialised signatures', () => {
    const cacheSig = '{"c":"abc","x":{"channel":"ch1"}}';
    const querySig = '{"c":"abc","x":{}}';
    expect(canCacheSatisfyQuery(cacheSig, querySig)).toBe(true);
  });

  it('returns false for malformed cache signature', () => {
    const cacheSig = 'not json';
    const querySig = '{"c":"abc","x":{}}';
    expect(canCacheSatisfyQuery(cacheSig, querySig)).toBe(false);
  });

  it('returns false for malformed query signature', () => {
    const cacheSig = '{"c":"abc","x":{}}';
    const querySig = 'not json';
    expect(canCacheSatisfyQuery(cacheSig, querySig)).toBe(false);
  });
});

describe('getUnspecifiedDimensions', () => {
  it('returns keys in cache but not in query', () => {
    const cache = { coreHash: 'abc', contextDefHashes: { a: '1', b: '2', c: '3' } };
    const query = { coreHash: 'abc', contextDefHashes: { a: '1' } };
    expect(getUnspecifiedDimensions(cache, query).sort()).toEqual(['b', 'c']);
  });

  it('returns empty array when cache has no extra keys', () => {
    const cache = { coreHash: 'abc', contextDefHashes: { a: '1' } };
    const query = { coreHash: 'abc', contextDefHashes: { a: '1', b: '2' } };
    expect(getUnspecifiedDimensions(cache, query)).toEqual([]);
  });

  it('returns all cache keys when query has none', () => {
    const cache = { coreHash: 'abc', contextDefHashes: { a: '1', b: '2' } };
    const query = { coreHash: 'abc', contextDefHashes: {} };
    expect(getUnspecifiedDimensions(cache, query).sort()).toEqual(['a', 'b']);
  });
});
```

---

## 14. Component Tests: Signature Computation

### 14.1 `computeQuerySignature` Structure Tests

```typescript
describe('computeQuerySignature - structured output', () => {
  it('returns valid JSON structure', async () => {
    const sig = await computeQuerySignature(
      { from: 'A', to: 'B' },
      'amplitude-prod',
      mockGraph,
      mockEdge,
      [],
      undefined
    );
    expect(() => JSON.parse(sig)).not.toThrow();
    const parsed = JSON.parse(sig);
    expect(parsed.c).toBeDefined();
    expect(parsed.x).toBeDefined();
  });

  it('includes context key when provided', async () => {
    // Setup: mock contextRegistry to return a context definition
    const sig = await computeQuerySignature(
      { from: 'A', to: 'B' },
      'amplitude-prod',
      mockGraph,
      mockEdge,
      ['channel'],
      undefined
    );
    const parsed = parseSignature(sig);
    expect(parsed.contextDefHashes['channel']).toBeDefined();
  });

  it('produces empty context for uncontexted query', async () => {
    const sig = await computeQuerySignature(
      { from: 'A', to: 'B' },
      'amplitude-prod',
      mockGraph,
      mockEdge,
      [],
      undefined
    );
    const parsed = parseSignature(sig);
    expect(parsed.contextDefHashes).toEqual({});
  });

  describe('core hash stability', () => {
    it('same inputs produce same core hash', async () => {
      const sig1 = await computeQuerySignature(payload, conn, graph, edge, [], ws);
      const sig2 = await computeQuerySignature(payload, conn, graph, edge, [], ws);
      expect(parseSignature(sig1).coreHash).toBe(parseSignature(sig2).coreHash);
    });

    it('different connection produces different core hash', async () => {
      const sig1 = await computeQuerySignature(payload, 'conn-a', graph, edge, [], ws);
      const sig2 = await computeQuerySignature(payload, 'conn-b', graph, edge, [], ws);
      expect(parseSignature(sig1).coreHash).not.toBe(parseSignature(sig2).coreHash);
    });

    it('different from/to produces different core hash', async () => {
      const sig1 = await computeQuerySignature({ from: 'A', to: 'B' }, conn, graph, edge, [], ws);
      const sig2 = await computeQuerySignature({ from: 'A', to: 'C' }, conn, graph, edge, [], ws);
      expect(parseSignature(sig1).coreHash).not.toBe(parseSignature(sig2).coreHash);
    });

    it('different visited produces different core hash', async () => {
      const sig1 = await computeQuerySignature({ from: 'A', to: 'B', visited: ['X'] }, ...);
      const sig2 = await computeQuerySignature({ from: 'A', to: 'B', visited: ['Y'] }, ...);
      expect(parseSignature(sig1).coreHash).not.toBe(parseSignature(sig2).coreHash);
    });

    it('context keys do NOT affect core hash', async () => {
      const sig1 = await computeQuerySignature(payload, conn, graph, edge, [], ws);
      const sig2 = await computeQuerySignature(payload, conn, graph, edge, ['channel'], ws);
      expect(parseSignature(sig1).coreHash).toBe(parseSignature(sig2).coreHash);
    });
  });

  describe('latency anchor event_id resolution (BUG FIX)', () => {
    it('uses event_id, not node_id, for latency anchor', async () => {
      // Two graphs with same node ID but different event_ids
      const graphA = {
        nodes: [{ id: 'anchor', event_id: 'event-v1' }]
      };
      const graphB = {
        nodes: [{ id: 'anchor', event_id: 'event-v2' }]
      };
      const edge = { p: { latency: { anchor_node_id: 'anchor' } } };

      const sig1 = await computeQuerySignature(payload, conn, graphA, edge, [], ws);
      const sig2 = await computeQuerySignature(payload, conn, graphB, edge, [], ws);

      // Signatures MUST differ because event_ids differ
      expect(parseSignature(sig1).coreHash).not.toBe(parseSignature(sig2).coreHash);
    });

    it('same event_id with different node_ids produces same core hash', async () => {
      // Two graphs with different node IDs but same event_id
      const graphA = {
        nodes: [{ id: 'anchor-old', event_id: 'event-x' }]
      };
      const graphB = {
        nodes: [{ id: 'anchor-new', event_id: 'event-x' }]
      };
      const edgeA = { p: { latency: { anchor_node_id: 'anchor-old' } } };
      const edgeB = { p: { latency: { anchor_node_id: 'anchor-new' } } };

      const sig1 = await computeQuerySignature(payload, conn, graphA, edgeA, [], ws);
      const sig2 = await computeQuerySignature(payload, conn, graphB, edgeB, [], ws);

      // Signatures SHOULD match because event_ids are the same
      expect(parseSignature(sig1).coreHash).toBe(parseSignature(sig2).coreHash);
    });

    it('missing anchor node resolves to empty event_id', async () => {
      const graph = { nodes: [{ id: 'other-node', event_id: 'other-event' }] };
      const edge = { p: { latency: { anchor_node_id: 'nonexistent' } } };

      const sig = await computeQuerySignature(payload, conn, graph, edge, [], ws);
      // Should not throw, should produce valid signature
      expect(parseSignature(sig).coreHash).toBeTruthy();
    });

    it('no latency config produces empty anchor event_id', async () => {
      const graph = { nodes: [{ id: 'a', event_id: 'e1' }] };
      const edgeNoLatency = { p: {} };

      const sig = await computeQuerySignature(payload, conn, graph, edgeNoLatency, [], ws);
      expect(parseSignature(sig).coreHash).toBeTruthy();
    });
  });

  describe('event definition hashing (NEW)', () => {
    it('signature changes when provider_event_names changes', async () => {
      const eventDefsV1 = {
        'event-a': { id: 'event-a', provider_event_names: { amplitude: 'OldEventName' } },
        'event-b': { id: 'event-b', provider_event_names: { amplitude: 'EventB' } },
      };
      const eventDefsV2 = {
        'event-a': { id: 'event-a', provider_event_names: { amplitude: 'NewEventName' } },
        'event-b': { id: 'event-b', provider_event_names: { amplitude: 'EventB' } },
      };
      const graph = {
        nodes: [
          { id: 'from', event_id: 'event-a' },
          { id: 'to', event_id: 'event-b' },
        ]
      };
      const payload = { from: 'event-a', to: 'event-b' };

      const sig1 = await computeQuerySignature(payload, conn, graph, edge, [], ws, eventDefsV1);
      const sig2 = await computeQuerySignature(payload, conn, graph, edge, [], ws, eventDefsV2);

      // Signatures MUST differ because event definition changed
      expect(parseSignature(sig1).coreHash).not.toBe(parseSignature(sig2).coreHash);
    });

    it('signature changes when amplitude_filters changes', async () => {
      const eventDefsV1 = {
        'event-a': { id: 'event-a', provider_event_names: { amplitude: 'Event' }, amplitude_filters: [] },
      };
      const eventDefsV2 = {
        'event-a': { id: 'event-a', provider_event_names: { amplitude: 'Event' }, amplitude_filters: [{ prop: 'x', op: 'is', values: ['y'] }] },
      };

      const sig1 = await computeQuerySignature(payload, conn, graph, edge, [], ws, eventDefsV1);
      const sig2 = await computeQuerySignature(payload, conn, graph, edge, [], ws, eventDefsV2);

      expect(parseSignature(sig1).coreHash).not.toBe(parseSignature(sig2).coreHash);
    });

    it('signature unchanged when non-semantic event fields change', async () => {
      const eventDefsV1 = {
        'event-a': { id: 'event-a', provider_event_names: { amplitude: 'Event' }, description: 'Old desc' },
      };
      const eventDefsV2 = {
        'event-a': { id: 'event-a', provider_event_names: { amplitude: 'Event' }, description: 'New desc' },
      };

      const sig1 = await computeQuerySignature(payload, conn, graph, edge, [], ws, eventDefsV1);
      const sig2 = await computeQuerySignature(payload, conn, graph, edge, [], ws, eventDefsV2);

      // Description is not semantically relevant - signatures should match
      expect(parseSignature(sig1).coreHash).toBe(parseSignature(sig2).coreHash);
    });

    it('handles missing eventDefinitions gracefully', async () => {
      const sig = await computeQuerySignature(payload, conn, graph, edge, [], ws, undefined);
      expect(parseSignature(sig).coreHash).toBeTruthy();
    });

    it('all referenced event_ids get hashed', async () => {
      const eventDefs = {
        'event-from': { id: 'event-from', provider_event_names: { amplitude: 'From' } },
        'event-to': { id: 'event-to', provider_event_names: { amplitude: 'To' } },
        'event-visited': { id: 'event-visited', provider_event_names: { amplitude: 'Visited' } },
        'event-exclude': { id: 'event-exclude', provider_event_names: { amplitude: 'Exclude' } },
      };
      const payload = {
        from: 'event-from',
        to: 'event-to',
        visited: ['event-visited'],
        exclude: ['event-exclude'],
      };

      // Should not throw, should include all event hashes
      const sig = await computeQuerySignature(payload, conn, graph, edge, [], ws, eventDefs);
      expect(parseSignature(sig).coreHash).toBeTruthy();
    });
  });

  describe('original_query normalization (NEW)', () => {
    it('replaces node_ids with event_ids in original_query', async () => {
      const graph = {
        nodes: [
          { id: 'coffee-screen', event_id: 'event-coffee' },
          { id: 'dashboard-view', event_id: 'event-dashboard' },
        ]
      };
      const edgeA = { query: 'from(coffee-screen).to(dashboard-view)' };
      const edgeB = { query: 'from(home-screen).to(main-view)' }; // Different node names
      const graphB = {
        nodes: [
          { id: 'home-screen', event_id: 'event-coffee' },  // Same event_ids!
          { id: 'main-view', event_id: 'event-dashboard' },
        ]
      };

      const sig1 = await computeQuerySignature(payload, conn, graph, edgeA, [], ws, eventDefs);
      const sig2 = await computeQuerySignature(payload, conn, graphB, edgeB, [], ws, eventDefs);

      // Signatures SHOULD match because event_ids are the same
      expect(parseSignature(sig1).coreHash).toBe(parseSignature(sig2).coreHash);
    });

    it('different event_ids produce different signatures even with same node names', async () => {
      const graphA = {
        nodes: [
          { id: 'screen', event_id: 'event-v1' },
          { id: 'dest', event_id: 'event-v2' },
        ]
      };
      const graphB = {
        nodes: [
          { id: 'screen', event_id: 'event-v3' },  // Different event_ids
          { id: 'dest', event_id: 'event-v4' },
        ]
      };
      const edge = { query: 'from(screen).to(dest)' };

      const sig1 = await computeQuerySignature(payload, conn, graphA, edge, [], ws, eventDefs);
      const sig2 = await computeQuerySignature(payload, conn, graphB, edge, [], ws, eventDefs);

      expect(parseSignature(sig1).coreHash).not.toBe(parseSignature(sig2).coreHash);
    });

    it('preserves query structure (minus/plus/visited/exclude)', async () => {
      const graph = {
        nodes: [
          { id: 'a', event_id: 'e1' },
          { id: 'b', event_id: 'e2' },
          { id: 'c', event_id: 'e3' },
        ]
      };
      const edge1 = { query: 'from(a).to(b)' };
      const edge2 = { query: 'from(a).to(b).minus(c)' };

      const sig1 = await computeQuerySignature(payload, conn, graph, edge1, [], ws, eventDefs);
      const sig2 = await computeQuerySignature(payload, conn, graph, edge2, [], ws, eventDefs);

      // Adding .minus() changes the query semantics
      expect(parseSignature(sig1).coreHash).not.toBe(parseSignature(sig2).coreHash);
    });
  });

  describe('context hash correctness', () => {
    it('context def hash changes when context definition changes', async () => {
      // First signature with context def v1
      mockContextRegistry.getContext.mockResolvedValueOnce(contextDefV1);
      const sig1 = await computeQuerySignature(payload, conn, graph, edge, ['channel'], ws);

      // Second signature with context def v2
      mockContextRegistry.getContext.mockResolvedValueOnce(contextDefV2);
      const sig2 = await computeQuerySignature(payload, conn, graph, edge, ['channel'], ws);

      const parsed1 = parseSignature(sig1);
      const parsed2 = parseSignature(sig2);
      expect(parsed1.contextDefHashes['channel']).not.toBe(parsed2.contextDefHashes['channel']);
    });

    it('multiple context keys all get hashes', async () => {
      const sig = await computeQuerySignature(
        payload, conn, graph, edge,
        ['channel', 'device', 'region'],
        ws
      );
      const parsed = parseSignature(sig);
      expect(Object.keys(parsed.contextDefHashes).sort()).toEqual(['channel', 'device', 'region']);
    });
  });
});
```

---

## 15. Integration Tests: Planner and Aggregation

### 15.1 FetchPlanBuilder Signature Filtering

```typescript
describe('fetchPlanBuilderService - signature filtering', () => {
  beforeEach(() => {
    // Enable signature checking for these tests
    vi.mocked(isSignatureCheckingEnabled).mockReturnValue(true);
  });

  describe('superset matching in coverage calculation', () => {
    it('CRITICAL: accepts contexted cache for uncontexted query', async () => {
      // Setup: 4 MECE contexted slices with signatures
      const contextedSig = serialiseSignature({
        coreHash: 'abc',
        contextDefHashes: { channel: 'ch-hash' }
      });
      const values = [
        { sliceDSL: 'context(channel:paid-search)', query_signature: contextedSig, cohort_from: '1-Nov-25', cohort_to: '15-Dec-25' },
        { sliceDSL: 'context(channel:influencer)', query_signature: contextedSig, cohort_from: '1-Nov-25', cohort_to: '15-Dec-25' },
        { sliceDSL: 'context(channel:paid-social)', query_signature: contextedSig, cohort_from: '1-Nov-25', cohort_to: '15-Dec-25' },
        { sliceDSL: 'context(channel:other)', query_signature: contextedSig, cohort_from: '1-Nov-25', cohort_to: '15-Dec-25' },
      ];

      // Query: uncontexted (empty context)
      const querySig = serialiseSignature({
        coreHash: 'abc',
        contextDefHashes: {}
      });

      const result = buildFetchPlan({
        graph,
        dsl: 'cohort(10-Nov-25:12-Nov-25)',
        window: { start: '10-Nov-25', end: '12-Nov-25' },
        querySignatures: { 'parameter:test:edge:p:': querySig },
        // ... other params
      });

      // Should classify as covered, not needs_fetch
      expect(result.plan.items[0].classification).toBe('covered');
    });

    it('CRITICAL: accepts multi-dimensional cache for single-dimension query', async () => {
      // Setup: slices with channel+device
      const cacheSig = serialiseSignature({
        coreHash: 'abc',
        contextDefHashes: { channel: 'ch-hash', device: 'dv-hash' }
      });
      const values = [
        { sliceDSL: 'context(channel:google,device:mobile)', query_signature: cacheSig, ... },
        { sliceDSL: 'context(channel:google,device:desktop)', query_signature: cacheSig, ... },
        // ... more slices
      ];

      // Query: only specifies channel
      const querySig = serialiseSignature({
        coreHash: 'abc',
        contextDefHashes: { channel: 'ch-hash' }
      });

      // ... build and verify result.plan.items[0].classification === 'covered'
    });
  });

  describe('rejection cases', () => {
    it('rejects when core hash differs', async () => {
      const cacheSig = serialiseSignature({ coreHash: 'old-core', contextDefHashes: {} });
      const querySig = serialiseSignature({ coreHash: 'new-core', contextDefHashes: {} });
      // ... verify needs_fetch
    });

    it('rejects when context def hash differs', async () => {
      const cacheSig = serialiseSignature({ coreHash: 'abc', contextDefHashes: { channel: 'old' } });
      const querySig = serialiseSignature({ coreHash: 'abc', contextDefHashes: { channel: 'new' } });
      // ... verify needs_fetch
    });

    it('rejects when cache missing required context key', async () => {
      const cacheSig = serialiseSignature({ coreHash: 'abc', contextDefHashes: {} });
      const querySig = serialiseSignature({ coreHash: 'abc', contextDefHashes: { channel: 'ch' } });
      // ... verify needs_fetch
    });
  });
});
```

### 15.2 WindowAggregationService Signature Filtering

```typescript
describe('calculateIncrementalFetch - signature filtering', () => {
  it('accepts cache values with superset context keys', () => {
    const cacheSig = serialiseSignature({
      coreHash: 'abc',
      contextDefHashes: { channel: 'ch-hash' }
    });
    const querySig = serialiseSignature({
      coreHash: 'abc',
      contextDefHashes: {}
    });

    const result = calculateIncrementalFetch(
      { values: [{ query_signature: cacheSig, dates: ['1-Nov-25', '2-Nov-25'], ... }] },
      { start: '1-Nov-25', end: '2-Nov-25' },
      querySig,
      false,
      'cohort(1-Nov-25:2-Nov-25)'
    );

    expect(result.needsFetch).toBe(false);
    expect(result.daysAvailable).toBe(2);
  });

  // ... additional tests for rejection cases
});
```

---

## 16. End-to-End Tests: Full Flow

### 16.1 Regression Test: The Original Bug

```typescript
describe('REGRESSION: signature isolation must not block valid MECE cache', () => {
  /**
   * This test reproduces the exact bug from TODO.md:
   * - User runs Retrieve All (writes contexted MECE slices)
   * - User changes DSL to uncontexted cohort query
   * - Planner must report 'covered', NOT 'needs_fetch'
   */
  it('uncontexted query over contexted MECE cache reports covered', async () => {
    // 1. Setup: simulate Retrieve All having written contexted slices
    //    Each slice has a structured signature with contextDefHashes: { channel: 'hash' }

    // 2. Register channel context definition with complete MECE values

    // 3. Query: uncontexted cohort
    const dsl = 'cohort(10-Nov-25:12-Nov-25)';

    // 4. Run planner
    const result = await windowFetchPlannerService.analyse(graph, dsl, 'dsl_change');

    // 5. Assert: must be covered
    expect(result.outcome).toBe('covered_stable');
    expect(result.fetchPlanItems.length).toBe(0);
  });
});
```

### 16.2 Full Fetch-Cache-Query Cycle

```typescript
describe('E2E: fetch → cache → query cycle', () => {
  it('complete cycle with signature validation', async () => {
    // Phase 1: Fetch
    // - Execute fetch for contexted query
    // - Verify signatures are written in structured format

    // Phase 2: Cache
    // - Verify file contains structured signatures
    // - Verify all MECE slices have same coreHash, same contextDefHashes

    // Phase 3: Query
    // - Run uncontexted query
    // - Verify planner uses superset matching
    // - Verify no refetch demanded
  });

  it('detects stale cache when connection changes', async () => {
    // Phase 1: Fetch with connection A
    // Phase 2: Change connection to B
    // Phase 3: Query - should demand refetch (core hash differs)
  });

  it('detects stale cache when context definition changes', async () => {
    // Phase 1: Fetch with context def v1
    // Phase 2: Modify context definition (add a value)
    // Phase 3: Query - should demand refetch (context def hash differs)
  });
});
```

---

## 17. Stress Test and Edge Case Analysis

### 17.1 Scenario Matrix

| # | Scenario | Old Behaviour | New Behaviour | Correct? |
|---|----------|---------------|---------------|----------|
| 1 | **Same events, different node names** | Different coreHash (no cache sharing) | Same coreHash (cache shared) | ✅ Yes |
| 2 | **User changes event definition `provider_event_names`** | No signature change (stale cache!) | coreHash changes (invalidated) | ✅ Yes |
| 3 | **User changes event definition `amplitude_filters`** | No signature change (stale cache!) | coreHash changes (invalidated) | ✅ Yes |
| 4 | **User changes context definition `values`** | contextDefHash changes | contextDefHash changes | ✅ Yes |
| 5 | **Uncontexted query over single-dim MECE cache** | MISMATCH (demands refetch) | MATCH → MECE works | ✅ Yes |
| 6 | **Contexted query over uncontexted cache** | MISMATCH | MISMATCH (cache missing key) | ✅ Yes |
| 7 | **Same context key, different def hash** | MISMATCH | MISMATCH | ✅ Yes |
| 8 | **Legacy (plain hash) signature in cache** | N/A | Parse fails → coreHash='' → never matches | ✅ Yes |
| 9 | **Graph A anchor "node-x"→event-v1, Graph B anchor "node-x"→event-v2** | Same signature (WRONG!) | Different coreHash (correct) | ✅ Yes |

### 17.1.1 Multi-Contexted Slice Scenarios (NOT SOLVED by this proposal)

| # | Scenario | Signature Match? | Slice Isolation? | Final Result | Notes |
|---|----------|------------------|------------------|--------------|-------|
| A | **Single-dim query over multi-dim cache** | ✅ Pass | ❌ Fail | REFETCH | Slice dims don't match |
| B | **Uncontexted query over multi-dim cache** | ✅ Pass | ❌ Fail | REFETCH | MECE rejects multi-dim slices |
| C | **Multi-dim query matches multi-dim cache exactly** | ✅ Pass | ✅ Pass | USES CACHE | Exact match works |

**Explanation**: Signature matching is the FIRST filter. Even if signatures match, slice isolation may still reject slices because:
- `isolateSlice` requires **exact dimension match** (line 145: `valueSlice !== normalizedTarget`)
- `isEligibleContextOnlySlice` requires **single context key** (line 95: `context.length !== 1`)

### 17.2 Cross-Graph Cache Sharing Analysis

**Scenario**: Two graphs reference the same events but with different node IDs.

| Graph A | Graph B | Should share cache? | New system behaviour |
|---------|---------|---------------------|---------------------|
| `from(coffee-screen)` → `event-coffee` | `from(home-view)` → `event-coffee` | ✅ Yes | Same `from_event_id` → same coreHash |
| `to(dashboard)` → `event-dashboard` | `to(main-page)` → `event-dashboard` | ✅ Yes | Same `to_event_id` → same coreHash |
| `anchor(reg-flow)` → `event-reg` | `anchor(signup)` → `event-reg` | ✅ Yes | Same `latency_anchor_event_id` |

**Risk**: Node in query string that doesn't exist in current graph
- **Mitigation**: `normalizeQueryToEventIds` only replaces nodes that exist in the current graph
- **Behaviour**: If node not found, original node ID remains (won't pollute, just won't normalise)

### 17.3 Edge Cases for original_query Normalization

| Edge Case | Handling |
|-----------|----------|
| Node ID contains regex special chars (e.g., `node.with.dots`) | `escapeRegex` escapes before replacement |
| Two node IDs map to same event_id | Both replaced with same event_id — correct, semantically equivalent |
| Node ID not found in graph | Kept as-is (conservative — won't incorrectly normalise) |
| Empty query string | Returns empty string (no change) |
| Query with `.minus()`, `.plus()`, `.visited()` | Structure preserved, only node refs replaced |

### 17.4 MECE Generation Coherence

**Question**: Does subset-aware matching break MECE generation coherence?

**Answer**: NO. The subset-aware matching is ONLY used in:
- `fetchPlanBuilderService.ts` — determining if cache can satisfy a query
- `windowAggregationService.ts` — filtering values for coverage calculation

MECE generation grouping in `meceSliceService.ts` (line 217) uses EXACT signature matching:
```typescript
const genKey = `${e.key}||${e.sig ?? '__legacy__'}`;
```

This is correct: within a MECE generation, all slices MUST have the same signature to ensure coherent semantics. The subset matching only relaxes "can this query use this cache", not "are these slices in the same generation".

### 17.5 Invalid Signature Handling

| Input | `parseSignature` output | Matching behaviour |
|-------|------------------------|-------------------|
| `""` (empty) | `{ coreHash: '', contextDefHashes: {} }` | Never matches (empty coreHash) |
| `"abc123..."` (legacy hash) | `{ coreHash: '', contextDefHashes: {} }` | Never matches |
| `null` / `undefined` | `{ coreHash: '', contextDefHashes: {} }` | Never matches |
| `"{malformed"` | `{ coreHash: '', contextDefHashes: {} }` | Never matches |
| `{"c":"abc","x":{}}` (valid) | `{ coreHash: 'abc', contextDefHashes: {} }` | Matches if coreHash equals |

**Result**: All legacy/invalid signatures are effectively busted, forcing refetch on first access.

### 17.6 Race Condition Analysis

| Concern | Analysis | Risk |
|---------|----------|------|
| **Async event loading** | `buildDslFromEdge` awaits all event definitions before returning | None |
| **Context registry cache** | `contextRegistry.getContext` is async but deterministic | None |
| **Concurrent signature computation** | Each computation is independent (no shared mutable state) | None |
| **File write during computation** | Signature computed before write; write is atomic | None |

---

## Appendix A: Full Type Definitions

```typescript
// signatureMatchingService.ts

export interface StructuredSignature {
  /** SHA-256 hash of non-context semantic inputs */
  coreHash: string;
  
  /** Map from context key → SHA-256 of normalised definition */
  contextDefHashes: Record<string, string>;
}

export interface SignatureMatchResult {
  /** Whether the cache signature can satisfy the query signature */
  compatible: boolean;
  
  /** If not compatible, the reason for mismatch */
  reason?: 
    | 'core_mismatch'
    | `missing_context_key:${string}`
    | `context_def_mismatch:${string}`;
}
```

---

## Appendix B: Serialisation Format

**Serialised**:
```json
{"c":"a1b2c3d4e5f6...","x":{"channel":"f1e2d3c4...","device":"b5a6c7d8..."}}
```

**Compact keys**:
- `c` = coreHash
- `x` = contextDefHashes (mnemonic: "conteXt")

**Size estimate**:
- coreHash: 64 chars (SHA-256 hex)
- Per context key: ~10 chars key name + 64 chars hash
- Overhead: ~10 chars JSON structure
- **Typical (1 context key)**: ~150 chars
- **Multi-dimensional (3 keys)**: ~300 chars

Compared to legacy (64 chars), this is larger but still reasonable for YAML storage.

---

## Appendix C: Test Coverage Summary

### Unit Tests (signatureMatchingService.test.ts)

| Category | Test Count | Description |
|----------|------------|-------------|
| **Parsing: valid inputs** | 4 | Normal JSON, multiple keys, empty context, missing fields |
| **Parsing: invalid inputs** | 5 | Malformed JSON, empty string, legacy hash, null/undefined, wrong structure |
| **Parsing: edge cases** | 3 | Long hash, special chars, unicode |
| **Serialisation** | 3 | Valid JSON, round-trip, empty context |
| **Core hash matching** | 5 | Identical, different, empty cache, empty query, case-sensitive |
| **Context superset (CRITICAL)** | 3 | Uncontexted→contexted, single→multi-dim, 3+ extra dims |
| **Context subset rejection** | 3 | No context in cache, missing one key, wrong key |
| **Def hash mismatch** | 3 | Same key diff hash, one of multiple differs, superset with matching subset |
| **Special hash values** | 3 | 'missing', 'error', both 'missing' |
| **Convenience functions** | 5 | canCacheSatisfyQuery variants, getUnspecifiedDimensions |
| **Total** | **37** | |

### Component Tests (dataOperationsService.signature.test.ts)

| Category | Test Count | Description |
|----------|------------|-------------|
| **Structure validation** | 3 | Valid JSON, context keys included, empty context for uncontexted |
| **Core hash stability** | 5 | Same inputs, diff connection, diff from/to, diff visited, context doesn't affect core |
| **Latency anchor event_id (BUG FIX)** | 4 | Uses event_id not node_id, same event_id matches, missing node, no latency config |
| **Event definition hashing (NEW)** | 5 | provider_event_names change, amplitude_filters change, non-semantic unchanged, missing defs, all events hashed |
| **original_query normalization (NEW)** | 3 | Node→event_id replacement, different events differ, query structure preserved |
| **Context hash correctness** | 2 | Def change changes hash, multiple keys all hashed |
| **Total** | **22** | |

### Integration Tests (fetchPlanBuilderService, windowAggregationService)

| Category | Test Count | Description |
|----------|------------|-------------|
| **Superset matching** | 2 | Contexted cache for uncontexted query, multi-dim for single-dim |
| **Rejection cases** | 3 | Core mismatch, def hash mismatch, missing key |
| **Incremental fetch** | 2 | Superset accepted, rejection cases |
| **Total** | **7** | |

### E2E Tests (signature.e2e.test.ts, signatureRegression.test.ts)

| Category | Test Count | Description |
|----------|------------|-------------|
| **Regression** | 1 | Original bug reproduction and fix verification |
| **Full cycle** | 4 | Fetch→cache→query, connection change, context def change, event def change |
| **Total** | **5** | |

### Grand Total: **71 tests**

### Coverage Targets

| File | Target | Notes |
|------|--------|-------|
| `signatureMatchingService.ts` | 100% branch | Core matching logic must be exhaustively tested |
| `computeQuerySignature` changes | 100% branch | New structured output code paths |
| `fetchPlanBuilderService.ts` filter | 90%+ | Integration with existing code |
| `windowAggregationService.ts` filter | 90%+ | Integration with existing code |

---

## Appendix D: Existing Tests to Re-enable

After implementation, these currently-disabled tests should pass:

| File | Test | Status |
|------|------|--------|
| `windowAggregationService.querySignatureCache.test.ts` | "treats data as NOT cached when sliceDSL matches but query_signature differs" | Conditional on `isSignatureCheckingEnabled()` |
| `windowAggregationService.querySignatureCache.test.ts` | "does not force refetch for legacy values with no query_signature" | Conditional on `isSignatureCheckingEnabled()` |
| `fetchButtonE2E.integration.test.tsx` | "CRITICAL: planner must NOT demand fetch when cohort headers fully cover requested window via MECE (signature-aware)" | Conditional on `isSignatureCheckingEnabled()` |
| `fetchButtonE2E.integration.test.tsx` | "CRITICAL: if signed cache signatures do NOT match, planner must demand fetch (negative test)" | Conditional on `isSignatureCheckingEnabled()` |
| `signature-consistency.test.ts` | "query signature: invalidated by any query change" | Skipped (flaky CI timeout) |
| `signature-consistency.test.ts` | "query signature: includes connection name" | Skipped (flaky CI timeout) |

---

## Appendix E: Code Trace Verification (29-Jan-26)

This appendix documents the exact code paths traced during review.

### E.1 Signature Computation Flow

```
User triggers fetch
        ↓
dataOperationsService.getFromSourceDirect()
        ↓
[Line 4181] buildDslFromEdge(edgeForDsl, graph, provider, eventLoader, constraints)
        ↓
[Line 4188-4189] queryPayload = buildResult.queryPayload
                  eventDefinitions = buildResult.eventDefinitions  ← AVAILABLE
        ↓
[Line 4875] computeQuerySignature(queryPayload, connectionName, graph, edge, contextKeys, workspace)
                                                                              ↑
                                                               eventDefinitions NOT PASSED (BUG)
```

### E.2 Planner Signature Flow

```
Planner analyses fetch plan
        ↓
plannerQuerySignatureService.computePlannerQuerySignaturesForGraph()
        ↓
[Line 296] buildResult = await buildDslFromEdge(edgeForDsl, graph, provider, eventLoader, merged)
        ↓
[Line 297] queryPayload = buildResult.queryPayload  (eventDefinitions IGNORED!)
        ↓
[Line 334] computeQuerySignature(queryPayload, connectionName, graph, edgeForDsl, contextKeys, workspace)
                                                                                    ↑
                                                                   eventDefinitions NOT PASSED (BUG)
```

### E.3 Signature Matching Flow (fetchPlanBuilder)

```
buildFetchPlan() analyses cache coverage
        ↓
[Line 426-430] shouldFilterBySignature = isSignatureCheckingEnabled() && hasAnySignedValuesInFile && currentSignature
        ↓
[Line 433-438] valuesForCoverage = modeFilteredValues.filter((v) => {
                 const sig = (v as any).query_signature;
                 return sig === currentSignature;  ← EXACT MATCH ONLY (needs canCacheSatisfyQuery)
               })
```

### E.4 Signature Matching Flow (windowAggregation)

```
calculateIncrementalFetch() checks coverage
        ↓
[Line 920] effectiveQuerySignature = isSignatureCheckingEnabled() ? querySignature : undefined
        ↓
[Line 931-934] hasAnySignedValues = ... allValues.some(v => !!v.query_signature)
               signatureFilteredValues = hasAnySignedValues
                 ? allValues.filter(v => v.query_signature === effectiveQuerySignature)  ← EXACT MATCH (needs canCacheSatisfyQuery)
                 : allValues
```

### E.5 MECE Generation Grouping (meceSliceService — NO CHANGE NEEDED)

```
selectImplicitUncontextedSliceSetSync() groups MECE generations
        ↓
computeMECEGenerationCandidates()
        ↓
[Line 209] sig: normaliseQuerySignature((pv as any).query_signature)
        ↓
[Line 217] genKey = `${e.key}||${e.sig ?? '__legacy__'}`  ← EXACT MATCH (CORRECT — ensures coherent generations)
```

### E.6 buildDslFromEdge Return Type

```typescript
// Line 107-110 of buildDslFromEdge.ts
export interface BuildQueryPayloadResult {
  queryPayload: QueryPayload;
  eventDefinitions: Record<string, EventDefinition>;  ← AVAILABLE FOR SIGNATURE
}
```

### E.7 escapeRegex Location

```typescript
// Line 721-723 of buildDslFromEdge.ts (NOT exported)
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

### E.8 Key Line Numbers Summary

| File | Line | Purpose | Status |
|------|------|---------|--------|
| `dataOperationsService.ts` | 600-835 | `computeQuerySignature` function | NEEDS eventDefinitions param |
| `dataOperationsService.ts` | 808 | `anchor_node_id` in signature | NEEDS event_id resolution |
| `dataOperationsService.ts` | 1452 | `compEventDefs` available | NEEDS passing to line 1457 |
| `dataOperationsService.ts` | 1457 | Signature computation | NEEDS eventDefinitions param |
| `dataOperationsService.ts` | 4188-4189 | `eventDefinitions` captured | NEEDS passing to line 4875 |
| `dataOperationsService.ts` | 4875 | Signature computation | NEEDS eventDefinitions param |
| `plannerQuerySignatureService.ts` | 296 | `buildResult.eventDefinitions` available | NEEDS passing to line 334 |
| `plannerQuerySignatureService.ts` | 334 | Signature computation | NEEDS eventDefinitions param |
| `fetchPlanBuilderService.ts` | 436 | Exact signature match | NEEDS canCacheSatisfyQuery |
| `windowAggregationService.ts` | 933 | Exact signature match | NEEDS canCacheSatisfyQuery |
| `meceSliceService.ts` | 217 | MECE generation grouping | NO CHANGE (exact match correct) |
| `signaturePolicyService.ts` | 13-14 | Flags disabled | RE-ENABLE after implementation |
| `buildDslFromEdge.ts` | 721-723 | `escapeRegex` utility | EXPORT or inline |
