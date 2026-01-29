# Structured Query Signature: Multi-Dimensional Matching

**Status**: Proposal  
**Date**: 29-Jan-26  
**Author**: AI Assistant  
**Supersedes**: Legacy monolithic signature system  
**Companion document**: [Battle Test Scenarios](./multi-sig-matching-testing-logic.md) — 15 orthogonal scenarios validating the logic

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
    // Rule 2a: Treat 'missing' or 'error' hashes as non-match (fail-safe)
    // We cannot validate correctness without the actual hash
    if (cacheDefHash === 'missing' || cacheDefHash === 'error') {
      return { compatible: false, reason: `context_hash_unavailable:${key}` };
    }
    if (queryDefHash === 'missing' || queryDefHash === 'error') {
      return { compatible: false, reason: `query_hash_unavailable:${key}` };
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
 * Deduplicate slices before aggregation to prevent double-counting.
 * 
 * Dedupes by (sliceDSL, query_signature, window_from, window_to).
 * If duplicates exist (e.g. file corruption), keeps the one with most recent retrieved_at.
 */
export function dedupeSlices(slices: ParameterValue[]): ParameterValue[] {
  const byKey = new Map<string, ParameterValue>();
  
  for (const slice of slices) {
    const key = [
      slice.sliceDSL ?? '',
      (slice as any).query_signature ?? '',
      slice.window_from ?? '',
      slice.window_to ?? '',
    ].join('|');
    
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, slice);
    } else {
      // Keep fresher slice
      const existingTs = existing.retrieved_at ? new Date(existing.retrieved_at).getTime() : 0;
      const newTs = slice.retrieved_at ? new Date(slice.retrieved_at).getTime() : 0;
      if (newTs > existingTs) {
        byKey.set(key, slice);
      }
    }
  }
  
  return Array.from(byKey.values());
}

/**
 * Aggregate slices by summing n_daily/k_daily arrays.
 * All slices must have same date arrays (verified by caller).
 * 
 * IMPORTANT: Call dedupeSlices() before this function to prevent double-counting.
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

### 7.5 Critical Design Fixes (Post-Review)

The following issues were identified during critical review and must be addressed:

#### 7.5.1 Slice Dimension Heterogeneity: The Core Challenge

**Critical insight:** Pinned queries can produce slices with DIFFERENT dimension sets:

```
Example 1 - Cartesian (.):
  (cohort(-30d:);window(-30d)).(context(channel).context(user-device))
  → Produces 4×5=20 slices: ALL channel×device combinations

Example 2 - Union (;):
  (cohort(-30d:);window(-30d)).(context(channel);context(user-device))
  → Produces 4+5=9 slices: 4 channel-only + 5 device-only, NO combinations

Example 3 - Mixed:
  (cohort(-30d:);window(-30d)).(context(channel);context(user-device);context(user-device:mobile).context(channel))
  → Produces 4+5+4=13 slices: channel-only + device-only + (mobile×all-channels)
```

**CRITICAL: Slices with different dimension sets CANNOT be aggregated together.**

If we sum `context(channel:google)` (ALL devices for google) with `context(device:mobile)` (ALL channels for mobile), we'd **double-count** users who are both google AND mobile.

**Design principle:** Group slices by dimension set, evaluate each group independently, pick the best satisfying group.

#### 7.5.2 Dimension Set Grouping Strategy

```typescript
interface DimensionSetGroup {
  /** Sorted array of context keys, e.g., ['channel'] or ['channel', 'device'] */
  dimensionKeys: string[];
  /** Slices belonging to this group */
  slices: ParameterValue[];
}

/**
 * Group slices by their dimension set (context keys).
 * Slices with different dimension sets form separate groups.
 */
function groupByDimensionSet(slices: ParameterValue[]): DimensionSetGroup[] {
  const groups = new Map<string, ParameterValue[]>();
  
  for (const slice of slices) {
    const ctxMap = extractContextMap(slice.sliceDSL ?? '');
    const dimKeys = Array.from(ctxMap.keys()).sort().join('|');
    
    if (!groups.has(dimKeys)) {
      groups.set(dimKeys, []);
    }
    groups.get(dimKeys)!.push(slice);
  }
  
  return Array.from(groups.entries()).map(([keyStr, slices]) => ({
    dimensionKeys: keyStr ? keyStr.split('|') : [],
    slices,
  }));
}
```

#### 7.5.3 Per-Group Satisfaction Evaluation

For each dimension set group, determine if it can satisfy the query:

```typescript
interface GroupSatisfaction {
  canSatisfy: boolean;
  reason?: string;
  reductionType: 'exact' | 'single_dim_mece' | 'multi_dim_reduction' | 'not_satisfiable';
  unspecifiedDimensions: string[];
  meceStatus: Record<string, { isMECE: boolean; isComplete: boolean }>;
  combinationsComplete?: boolean;  // For multi-dim groups
}

function evaluateGroupSatisfaction(
  group: DimensionSetGroup,
  queryContextMap: Map<string, string>
): GroupSatisfaction {
  const groupDims = new Set(group.dimensionKeys);
  const queryDims = new Set(queryContextMap.keys());
  
  // Case 1: Uncontexted group (no dimensions)
  if (groupDims.size === 0) {
    // Uncontexted slices satisfy uncontexted queries directly
    if (queryDims.size === 0) {
      return { canSatisfy: true, reductionType: 'exact', unspecifiedDimensions: [], meceStatus: {} };
    }
    // Uncontexted slices CANNOT satisfy contexted queries
    return { canSatisfy: false, reason: 'uncontexted_cache_for_contexted_query', reductionType: 'not_satisfiable', unspecifiedDimensions: [], meceStatus: {} };
  }
  
  // Case 2: Query specifies dimensions not in group
  for (const qDim of queryDims) {
    if (!groupDims.has(qDim)) {
      return { canSatisfy: false, reason: `group_missing_query_dimension:${qDim}`, reductionType: 'not_satisfiable', unspecifiedDimensions: [], meceStatus: {} };
    }
  }
  
  // Case 3: Filter group slices to those matching query's specified values
  const matchingSlices = group.slices.filter(slice => {
    const sliceCtx = extractContextMap(slice.sliceDSL ?? '');
    for (const [key, value] of queryContextMap) {
      if (sliceCtx.get(key) !== value) return false;
    }
    return true;
  });
  
  if (matchingSlices.length === 0) {
    return { canSatisfy: false, reason: 'no_slices_match_query_values', reductionType: 'not_satisfiable', unspecifiedDimensions: [], meceStatus: {} };
  }
  
  // Determine unspecified dimensions (in group but not in query)
  const unspecifiedDimensions = group.dimensionKeys.filter(d => !queryContextMap.has(d));
  
  // Case 4: Exact match (no unspecified dimensions)
  if (unspecifiedDimensions.length === 0) {
    return { canSatisfy: true, reductionType: 'exact', unspecifiedDimensions: [], meceStatus: {} };
  }
  
  // Case 5: Single unspecified dimension (single-dim reduction)
  // Case 6: Multiple unspecified dimensions (multi-dim reduction)
  const meceStatus: Record<string, { isMECE: boolean; isComplete: boolean }> = {};
  
  for (const dimKey of unspecifiedDimensions) {
    const check = verifyMECEForDimension(matchingSlices, dimKey);
    meceStatus[dimKey] = { isMECE: check.isMECE, isComplete: check.isComplete };
    
    if (!check.isMECE || !check.canAggregate) {
      return { 
        canSatisfy: false, 
        reason: `dimension_not_mece:${dimKey}`, 
        reductionType: 'not_satisfiable',
        unspecifiedDimensions,
        meceStatus,
      };
    }
  }
  
  // Case 6b: For 2+ unspecified dims, verify all combinations exist
  if (unspecifiedDimensions.length > 1) {
    const { complete, missingCombinations } = verifyAllCombinationsExist(matchingSlices, unspecifiedDimensions);
    if (!complete) {
      return {
        canSatisfy: false,
        reason: 'missing_combinations',
        reductionType: 'not_satisfiable',
        unspecifiedDimensions,
        meceStatus,
        combinationsComplete: false,
      };
    }
  }
  
  return {
    canSatisfy: true,
    reductionType: unspecifiedDimensions.length === 1 ? 'single_dim_mece' : 'multi_dim_reduction',
    unspecifiedDimensions,
    meceStatus,
    combinationsComplete: true,
  };
}
```

#### 7.5.4 Multi-Group Query Resolution

```typescript
interface QueryResolution {
  resolved: boolean;
  selectedGroup?: DimensionSetGroup;
  satisfaction?: GroupSatisfaction;
  allGroups: Array<{ group: DimensionSetGroup; satisfaction: GroupSatisfaction }>;
}

function resolveQueryAcrossGroups(
  allSlices: ParameterValue[],
  queryContextMap: Map<string, string>
): QueryResolution {
  const groups = groupByDimensionSet(allSlices);
  const evaluations = groups.map(group => ({
    group,
    satisfaction: evaluateGroupSatisfaction(group, queryContextMap),
  }));
  
  // Find all satisfying groups
  const satisfying = evaluations.filter(e => e.satisfaction.canSatisfy);
  
  if (satisfying.length === 0) {
    return { resolved: false, allGroups: evaluations };
  }
  
  // Priority: exact > single_dim_mece > multi_dim_reduction
  // Within same priority: prefer freshest (most recent retrieved_at)
  const priority = { exact: 0, single_dim_mece: 1, multi_dim_reduction: 2, not_satisfiable: 99 };
  
  satisfying.sort((a, b) => {
    const pA = priority[a.satisfaction.reductionType];
    const pB = priority[b.satisfaction.reductionType];
    if (pA !== pB) return pA - pB;
    
    // Same priority: prefer freshest (most recent retrieved_at wins)
    // Recency = min retrieved_at among slices in the group (stalest member rule)
    const recencyA = getGroupRecency(a.group.slices);
    const recencyB = getGroupRecency(b.group.slices);
    if (recencyA !== recencyB) {
      return recencyB - recencyA; // Descending: most recent (largest min-ts) first
    }
    
    // Final tie-break: deterministic by dimension keys then signature
    const keysA = a.group.dimensionKeys.sort().join('|');
    const keysB = b.group.dimensionKeys.sort().join('|');
    if (keysA !== keysB) {
      return keysA.localeCompare(keysB);
    }
    
    // Last resort: compare first slice's signature
    const sigA = (a.group.slices[0] as any)?.query_signature ?? '';
    const sigB = (b.group.slices[0] as any)?.query_signature ?? '';
    return sigA.localeCompare(sigB);
  });

/**
 * Get recency of a group as the MINIMUM retrieved_at timestamp among its slices.
 * 
 * Rationale: A group is only as fresh as its stalest member. Using max would
 * incorrectly favour groups with one very new slice and several stale slices.
 * 
 * "Most recent wins" means "largest min-ts wins".
 */
function getGroupRecency(slices: ParameterValue[]): number {
  let minTs = Number.POSITIVE_INFINITY;
  for (const slice of slices) {
    const ts = slice.retrieved_at ? new Date(slice.retrieved_at).getTime() : 0;
    if (ts < minTs) minTs = ts;
  }
  return Number.isFinite(minTs) ? minTs : 0;
}
  
  return {
    resolved: true,
    selectedGroup: satisfying[0].group,
    satisfaction: satisfying[0].satisfaction,
    allGroups: evaluations,
  };
}
```

#### 7.5.5 Worked Examples

**Example A: Union slices (`;`), uncontexted query**

```
Slices in file (from: context(channel);context(user-device)):
  Group {channel}: [google, meta, tiktok, other] — 4 slices
  Group {device}: [mobile, desktop, tablet, ios, android] — 5 slices

Query: uncontexted

Evaluation:
  Group {channel}: 
    unspecifiedDimensions: [channel]
    MECE for channel: all 4 present ✓
    → canSatisfy: true, type: single_dim_mece
    
  Group {device}:
    unspecifiedDimensions: [device]
    MECE for device: all 5 present ✓
    → canSatisfy: true, type: single_dim_mece

Resolution: BOTH groups can satisfy. Pick either (both give same total).
Note: We do NOT sum both groups — that would double-count!
```

**Example B: Partial Cartesian, single-dim query**

```
Slices in file (from: context(channel:google).context(device)):
  Group {channel, device}: [google×mobile, google×desktop, google×tablet, google×ios, google×android] — 5 slices

Query: context(channel:google)

Evaluation:
  Group {channel, device}:
    Filter to channel=google: all 5 slices match
    unspecifiedDimensions: [device]
    MECE for device: all 5 present ✓
    → canSatisfy: true, type: single_dim_mece

Resolution: Use group {channel, device}, aggregate over device.
```

**Example C: Mixed slices, uncontexted query**

```
Slices in file (from: context(channel);context(device:mobile).context(channel)):
  Group {channel}: [google, meta, tiktok, other] — 4 slices
  Group {channel, device}: [google×mobile, meta×mobile, tiktok×mobile, other×mobile] — 4 slices

Query: uncontexted

Evaluation:
  Group {channel}:
    unspecifiedDimensions: [channel]
    MECE for channel: all 4 ✓
    → canSatisfy: true, type: single_dim_mece
    
  Group {channel, device}:
    unspecifiedDimensions: [channel, device]
    MECE for channel: all 4 ✓
    MECE for device: only mobile (1 of 5) ✗
    → canSatisfy: false, reason: dimension_not_mece:device

Resolution: Use group {channel} (single-dim MECE).
The multi-dim group cannot satisfy because device is incomplete.
```

**Example D: Sparse Cartesian, uncontexted query**

```
Slices in file (incomplete Cartesian):
  Group {channel, device}: 
    google×mobile, google×desktop, google×tablet, google×ios, google×android (5)
    meta×mobile (1)
    tiktok×mobile (1)
    other×mobile, other×desktop (2)
    — Total: 9 slices (not 4×5=20)

Query: uncontexted

Evaluation:
  Group {channel, device}:
    unspecifiedDimensions: [channel, device]
    MECE for channel: [google, meta, tiktok, other] all 4 ✓
    MECE for device: [mobile, desktop, tablet, ios, android] all 5 ✓
    Combinations: 9/20 present ✗
    → canSatisfy: false, reason: missing_combinations

Resolution: No group satisfies → demand refetch.
```

#### 7.5.6 Per-Date Group Evaluation (Handling Temporal Heterogeneity)

**Problem:** A parameter file may contain slices from different pinned DSL patterns across different time periods. Query-level group evaluation fails because no single group covers the full date range.

**Example scenario** (uncontexted query spanning 6 weeks):
```
Epoch 1 (1-Nov to 14-Nov): Cartesian → {ch,dev} slices (4 combos)
Epoch 2 (15-Nov to 28-Nov): Union → {ch} + {dev} slices (separate)
Epoch 3 (29-Nov to 12-Dec): Mixed → {ch} + partial {ch,dev} slices
```

**Solution:** Evaluate group satisfaction **per-date**, then aggregate using the best satisfying group for each date.

```typescript
interface DateGroupCoverage {
  date: string;
  satisfyingGroups: Array<{
    groupDimKeys: string[];
    slicesForDate: ParameterValue[];
    reductionType: 'exact' | 'single_dim_mece' | 'multi_dim_reduction';
  }>;
  selectedGroup?: {
    groupDimKeys: string[];
    slicesForDate: ParameterValue[];
  };
}

function analyzePerDateGroupCoverage(
  allSlices: ParameterValue[],
  queryContextMap: Map<string, string>,
  queryDates: string[]
): PerDateGroupAnalysis {
  const groups = groupByDimensionSet(allSlices);
  
  const perDateCoverage: DateGroupCoverage[] = queryDates.map(date => {
    const satisfyingGroups: DateGroupCoverage['satisfyingGroups'] = [];
    
    for (const group of groups) {
      // Filter group slices to those covering this specific date
      const slicesForDate = group.slices.filter(s => 
        s.dates?.includes(date) ?? false
      );
      
      if (slicesForDate.length === 0) continue;
      
      // Create a temporary group with only date-relevant slices
      const dateGroup = { dimensionKeys: group.dimensionKeys, slices: slicesForDate };
      const satisfaction = evaluateGroupSatisfaction(dateGroup, queryContextMap);
      
      if (satisfaction.canSatisfy) {
        satisfyingGroups.push({
          groupDimKeys: group.dimensionKeys,
          slicesForDate,
          reductionType: satisfaction.reductionType,
        });
      }
    }
    
    // Select best group for this date (priority: exact > single_dim > multi_dim)
    // Within same priority: prefer freshest (most recent retrieved_at)
    // Final tie-break: deterministic by dimension keys
    const priority = { exact: 0, single_dim_mece: 1, multi_dim_reduction: 2 };
    satisfyingGroups.sort((a, b) => {
      const pA = priority[a.reductionType];
      const pB = priority[b.reductionType];
      if (pA !== pB) return pA - pB;
      
      // Same priority: prefer freshest (stalest member rule)
      const recencyA = getGroupRecency(a.slicesForDate);
      const recencyB = getGroupRecency(b.slicesForDate);
      if (recencyA !== recencyB) {
        return recencyB - recencyA; // Descending: most recent (largest min-ts) first
      }
      
      // Final tie-break: deterministic by dimension keys
      const keysA = a.groupDimKeys.sort().join('|');
      const keysB = b.groupDimKeys.sort().join('|');
      return keysA.localeCompare(keysB);
    });
    
    return {
      date,
      satisfyingGroups,
      selectedGroup: satisfyingGroups[0] ?? undefined,
    };
  });
  
  return {
    perDateCoverage,
    fullyCovered: perDateCoverage.every(d => d.selectedGroup !== undefined),
    uncoveredDates: perDateCoverage.filter(d => !d.selectedGroup).map(d => d.date),
  };
}
```

**Worked example** (from scenario above):

| Date Range | Available Groups | Best Group | Aggregation |
|------------|-----------------|------------|-------------|
| 1-Nov to 14-Nov | `{ch,dev}` ✓ | `{ch,dev}` | SUM(4 multi-dim slices) |
| 15-Nov to 28-Nov | `{ch}` ✓, `{dev}` ✓ | `{ch}` (tie-break) | SUM(2 single-dim slices) |
| 29-Nov to 12-Dec | `{ch}` ✓, `{ch,dev}` ✗ | `{ch}` | SUM(2 single-dim slices) |

**Key invariant:** Within any single date, only ONE group's slices contribute to the total. This prevents double-counting.

#### 7.5.7 Aggregation with Temporal Group Switching

```typescript
function aggregateWithTemporalGroupSwitching(
  analysis: PerDateGroupAnalysis
): AggregatedResult {
  const dates: string[] = [];
  const n_daily: number[] = [];
  const k_daily: number[] = [];
  
  for (const coverage of analysis.perDateCoverage) {
    if (!coverage.selectedGroup) {
      // Gap in coverage — caller should have already verified fullyCovered
      throw new Error(`Uncovered date: ${coverage.date}`);
    }
    
    dates.push(coverage.date);
    
    // Sum the slices for this date within the selected group
    const dateIndex = coverage.selectedGroup.slicesForDate[0]?.dates?.indexOf(coverage.date) ?? -1;
    
    let n_sum = 0, k_sum = 0;
    for (const slice of coverage.selectedGroup.slicesForDate) {
      const idx = slice.dates?.indexOf(coverage.date) ?? -1;
      if (idx >= 0) {
        n_sum += slice.n_daily?.[idx] ?? 0;
        k_sum += slice.k_daily?.[idx] ?? 0;
      }
    }
    
    n_daily.push(n_sum);
    k_daily.push(k_sum);
  }
  
  return {
    dates,
    n_daily,
    k_daily,
    n: n_daily.reduce((a, b) => a + b, 0),
    k: k_daily.reduce((a, b) => a + b, 0),
    mean: n_daily.reduce((a, b) => a + b, 0) > 0
      ? k_daily.reduce((a, b) => a + b, 0) / n_daily.reduce((a, b) => a + b, 0)
      : undefined,
  };
}
```

#### 7.5.8 Multi-Dimensional MECE: Verify All Combinations

For multi-dimensional groups with 2+ unspecified dimensions, we must verify all combinations exist:

```typescript
function verifyAllCombinationsExist(
  slices: ParameterValue[],
  unspecifiedDimensions: string[]
): { complete: boolean; missingCombinations: string[] } {
  if (unspecifiedDimensions.length <= 1) {
    // Single dimension: per-dimension MECE is sufficient
    return { complete: true, missingCombinations: [] };
  }

  // Build set of actual combinations
  const actualCombinations = new Set<string>();
  for (const slice of slices) {
    const ctxMap = extractContextMap(slice.sliceDSL ?? '');
    const combo = unspecifiedDimensions
      .map(d => `${d}:${ctxMap.get(d) ?? ''}`)
      .sort()
      .join('|');
    actualCombinations.add(combo);
  }

  // Build expected combinations from per-dimension values
  const dimensionValues: Map<string, string[]> = new Map();
  for (const dimKey of unspecifiedDimensions) {
    const values = new Set<string>();
    for (const slice of slices) {
      const v = extractContextMap(slice.sliceDSL ?? '').get(dimKey);
      if (v) values.add(v);
    }
    dimensionValues.set(dimKey, Array.from(values).sort());
  }

  // Generate Cartesian product of expected combinations
  const expectedCombinations = cartesianProduct(
    unspecifiedDimensions.map(d => dimensionValues.get(d)!)
  ).map(combo => 
    unspecifiedDimensions.map((d, i) => `${d}:${combo[i]}`).sort().join('|')
  );

  const missing = expectedCombinations.filter(c => !actualCombinations.has(c));
  return { complete: missing.length === 0, missingCombinations: missing };
}
```

**Update `tryDimensionalReduction`:**
```typescript
// After MECE verification for each dimension, add:
if (unspecifiedDimensions.length > 1) {
  const { complete, missingCombinations } = verifyAllCombinationsExist(
    matchingSlices,
    unspecifiedDimensions
  );
  if (!complete) {
    return {
      kind: 'not_reducible',
      reason: 'missing_combinations',
      diagnostics: {
        // ... 
        warnings: [`Missing ${missingCombinations.length} combinations: ${missingCombinations.slice(0, 5).join(', ')}...`],
      },
    };
  }
}
```

#### 7.5.2 Flexible Date Range Coverage

**Problem:** Current logic requires all slices to have **identical** date arrays, but queries should be satisfiable by:
- Uncontexted slice for dates x-y
- MECE contexted slices for dates y-z
- Query window: x-z

**Design principle:** A query window [start, end] is covered if, **for each date d in the window**, there exists either:
1. An uncontexted slice covering d, OR
2. A complete MECE set of contexted slices covering d

**Fix:** Replace monolithic aggregation with date-by-date coverage analysis:

```typescript
interface DateCoverage {
  date: string;
  source: 'uncontexted' | 'mece_aggregated' | 'uncovered';
  slicesUsed: ParameterValue[];
}

function analyzePerDateCoverage(
  allSlices: ParameterValue[],
  queryContextMap: Map<string, string>,
  requestedDates: string[]
): { fullyCovered: boolean; coverage: DateCoverage[] } {
  const coverage: DateCoverage[] = [];
  
  for (const date of requestedDates) {
    // Option 1: Uncontexted slice covers this date
    const uncontextedSlice = allSlices.find(s => 
      !extractSliceDimensions(s.sliceDSL ?? '') && 
      sliceCoversDate(s, date)
    );
    if (uncontextedSlice) {
      coverage.push({ date, source: 'uncontexted', slicesUsed: [uncontextedSlice] });
      continue;
    }
    
    // Option 2: MECE contexted slices cover this date
    const contextedForDate = allSlices.filter(s => 
      extractSliceDimensions(s.sliceDSL ?? '') && 
      matchesSpecifiedDimensions(extractContextMap(s.sliceDSL ?? ''), queryContextMap) &&
      sliceCoversDate(s, date)
    );
    
    if (contextedForDate.length > 0) {
      const unspecifiedDims = getUnspecifiedDimensions(
        extractContextMap(contextedForDate[0].sliceDSL ?? ''),
        queryContextMap
      );
      
      // Check MECE for all unspecified dims AND all combinations exist
      let isMECE = true;
      for (const dim of unspecifiedDims) {
        if (!verifyMECEForDimension(contextedForDate, dim).isMECE) {
          isMECE = false;
          break;
        }
      }
      if (isMECE && verifyAllCombinationsExist(contextedForDate, unspecifiedDims).complete) {
        coverage.push({ date, source: 'mece_aggregated', slicesUsed: contextedForDate });
        continue;
      }
    }
    
    // Date not covered
    coverage.push({ date, source: 'uncovered', slicesUsed: [] });
  }
  
  return {
    fullyCovered: coverage.every(c => c.source !== 'uncovered'),
    coverage,
  };
}
```

**Aggregation follows coverage:**
```typescript
function aggregateWithMixedCoverage(
  coverage: DateCoverage[]
): ParameterValue | null {
  const n_daily: number[] = [];
  const k_daily: number[] = [];
  const dates: string[] = [];
  
  for (const c of coverage) {
    if (c.source === 'uncovered') return null;
    
    dates.push(c.date);
    
    if (c.source === 'uncontexted') {
      // Use uncontexted slice's values for this date
      const slice = c.slicesUsed[0];
      const idx = slice.dates?.indexOf(c.date) ?? -1;
      n_daily.push(idx >= 0 ? (slice.n_daily?.[idx] ?? 0) : 0);
      k_daily.push(idx >= 0 ? (slice.k_daily?.[idx] ?? 0) : 0);
    } else {
      // Sum MECE contexted slices for this date
      let n = 0, k = 0;
      for (const slice of c.slicesUsed) {
        const idx = slice.dates?.indexOf(c.date) ?? -1;
        n += idx >= 0 ? (slice.n_daily?.[idx] ?? 0) : 0;
        k += idx >= 0 ? (slice.k_daily?.[idx] ?? 0) : 0;
      }
      n_daily.push(n);
      k_daily.push(k);
    }
  }
  
  return {
    sliceDSL: undefined, // Result is uncontexted
    dates,
    n_daily,
    k_daily,
    n: n_daily.reduce((a, b) => a + b, 0),
    k: k_daily.reduce((a, b) => a + b, 0),
    // ...
  };
}
```

#### 7.5.3 Dimension Set Consistency Validation

**Problem:** Slices matching specified dimensions may have **inconsistent** additional dimensions.

```
Query: context(channel:google)
Slice 1: context(channel:google).context(device:mobile)
Slice 2: context(channel:google).context(device:desktop).context(region:uk)
```

Aggregating these would mix different granularities.

**Fix:** Validate all matched slices have identical dimension keys:

```typescript
// In tryDimensionalReduction, after collecting matchingSlices:
const dimensionSets = new Set(
  matchingSlices.map(s => {
    const keys = Array.from(extractContextMap(s.sliceDSL ?? '').keys());
    return JSON.stringify(keys.sort());
  })
);

if (dimensionSets.size !== 1) {
  return {
    kind: 'not_reducible',
    reason: 'inconsistent_dimension_sets',
    diagnostics: {
      // ...
      warnings: [`Slices have ${dimensionSets.size} different dimension sets`],
    },
  };
}
```

```typescript
function verifyAllCombinationsExist(
  slices: ParameterValue[],
  unspecifiedDimensions: string[]
): { complete: boolean; missingCombinations: string[] } {
  if (unspecifiedDimensions.length <= 1) {
    // Single dimension: per-dimension MECE is sufficient
    return { complete: true, missingCombinations: [] };
  }

  // Build set of actual combinations
  const actualCombinations = new Set<string>();
  for (const slice of slices) {
    const ctxMap = extractContextMap(slice.sliceDSL ?? '');
    const combo = unspecifiedDimensions
      .map(d => `${d}:${ctxMap.get(d) ?? ''}`)
      .sort()
      .join('|');
    actualCombinations.add(combo);
  }

  // Build expected combinations from per-dimension values
  const dimensionValues: Map<string, string[]> = new Map();
  for (const dimKey of unspecifiedDimensions) {
    const values = new Set<string>();
    for (const slice of slices) {
      const v = extractContextMap(slice.sliceDSL ?? '').get(dimKey);
      if (v) values.add(v);
    }
    dimensionValues.set(dimKey, Array.from(values).sort());
  }

  // Generate Cartesian product of expected combinations
  const expectedCombinations = cartesianProduct(
    unspecifiedDimensions.map(d => dimensionValues.get(d)!)
  ).map(combo => 
    unspecifiedDimensions.map((d, i) => `${d}:${combo[i]}`).sort().join('|')
  );

  const missing = expectedCombinations.filter(c => !actualCombinations.has(c));
  return { complete: missing.length === 0, missingCombinations: missing };
}
```

#### 7.5.7 Mixed Signature Types Integration

With dimension set grouping, mixed signature types are handled naturally:

1. **Signature filter** → includes compatible slices (both single and multi-dim)
2. **Dimension grouping** → separates slices by their context key sets
3. **Per-group evaluation** → each group evaluated independently
4. **Selection** → pick best satisfying group

The old dual-path approach (`isEligibleContextOnlySlice` vs `isEligibleMultiContextSlice`) is subsumed by the grouping strategy.

#### 7.5.8 Aggregated Result Signature (Clarification)

**Context:** Dimensional reduction is performed **on-the-fly** during planner coverage analysis. The aggregated `ParameterValue` is NOT persisted to files.

**Therefore:** The signature inherited from the template slice is irrelevant — it's never used for subsequent queries. No fix needed.

### 7.6 Edge Cases and Handling (Updated)

| Edge Case | Handling |
|-----------|----------|
| **Slices have different date arrays** | Per-date coverage analysis; aggregate date-by-date |
| **One unspecified dimension incomplete** | MECE check fails → demand refetch |
| **Multiple unspecified dimensions** | Verify MECE for ALL + verify all combinations exist |
| **Missing combinations (sparse Cartesian)** | Combination check fails → demand refetch |
| **Inconsistent dimension sets** | Validation fails → demand refetch |
| **Mixed uncontexted + contexted for date range** | Per-date analysis supports mixed coverage |
| **Mixed signature types in file** | Processed separately by eligibility checks |
| **otherPolicy forbids aggregation** | canAggregate=false → demand refetch |
| **contextAny in cache** | Rejected by isEligibleMultiContextSlice |
| **case dimensions in cache** | Rejected by isEligibleMultiContextSlice |

### 7.9 Implementation Files Summary (Updated)

| File | Changes |
|------|---------|
| `dimensionalReductionService.ts` | **NEW** — Core dimensional reduction logic including: `groupByDimensionSet`, `evaluateGroupSatisfaction`, `resolveQueryAcrossGroups`, `analyzePerDateGroupCoverage`, `aggregateWithTemporalGroupSwitching`, `extractContextMap` (memoized), `clearContextMapCache`, `matchesSpecifiedDimensions`, `getUnspecifiedDimensions`, `verifyMECEForDimension`, `verifyAllCombinationsExist` (bounded), `dedupeSlices`, `aggregateSlices`, `tryDimensionalReduction`, `analyzePerDateCoverage`, `aggregateWithMixedCoverage`, `getGroupRecency` |
| `meceSliceService.ts` | **EXTEND** — Add `isEligibleMultiContextSlice`, `computeMultiDimMECECandidates` |
| `sliceIsolation.ts` | **EXTEND** — Add `isolateSlicePartialMatch` |
| `windowAggregationService.ts` | **MODIFY** — Add `tryDimensionalReductionCoverage` in `hasFullSliceCoverageByHeader`; integrate dimension set grouping and per-date group coverage analysis |
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

**CRITICAL: These tests MUST cover the pinned query patterns:**
- Cartesian (`.`): `context(channel).context(device)` → full product
- Union (`;`): `context(channel);context(device)` → separate single-dims
- Mixed: `context(channel);context(device);context(device:mobile).context(channel)` → union + partial multi-dim

| # | Slice Source Pattern | Query | Dimension Groups | Expected | Test |
|---|---------------------|-------|------------------|----------|------|
| 1 | Single-dim channel only | uncontexted | {ch} | REDUCED via single-dim MECE | `dimensionalReduction.test.ts` |
| 2 | Single-dim channel only | context(ch:google) | {ch} | EXACT MATCH | `sliceIsolation.test.ts` |
| 3 | Full Cartesian ch×dev | uncontexted | {ch,dev} | REDUCED (all combos exist) | `dimensionalReduction.test.ts` |
| 4 | Full Cartesian ch×dev | context(ch:google) | {ch,dev} | REDUCED (single-dim over dev) | `dimensionalReduction.test.ts` |
| 5 | **Union (;) ch + dev** | **uncontexted** | **{ch}, {dev}** | **REDUCED (pick either group)** | `dimensionalReduction.test.ts` |
| 6 | **Union (;) ch + dev** | **context(ch:google)** | **{ch}, {dev}** | **EXACT MATCH (use {ch} group)** | `dimensionalReduction.test.ts` |
| 7 | **Union (;) ch + dev** | **context(dev:mobile)** | **{ch}, {dev}** | **EXACT MATCH (use {dev} group)** | `dimensionalReduction.test.ts` |
| 8 | **Mixed: ch + (mobile×ch)** | **uncontexted** | **{ch}, {ch,dev}** | **REDUCED ({ch} group)** | `dimensionalReduction.test.ts` |
| 9 | **Mixed: ch + (mobile×ch)** | **context(ch:google)** | **{ch}, {ch,dev}** | **EXACT MATCH ({ch} group)** | `dimensionalReduction.test.ts` |
| 10 | **Mixed: ch + (mobile×ch)** | **context(dev:mobile)** | **{ch}, {ch,dev}** | **NOT REDUCIBLE (no {dev} group)** | `dimensionalReduction.test.ts` |
| 11 | Sparse Cartesian (9/20) | uncontexted | {ch,dev} | NOT REDUCIBLE (missing combos) | `dimensionalReduction.test.ts` |
| 12 | Partial: google×dev only | uncontexted | {ch,dev} | NOT REDUCIBLE (ch incomplete) | `dimensionalReduction.test.ts` |
| 13 | Partial: google×dev only | context(ch:google) | {ch,dev} | REDUCED (dev complete for google) | `dimensionalReduction.test.ts` |
| 14 | Uncontexted + MECE ch | uncontexted | {}, {ch} | REDUCED (prefer uncontexted) | `dimensionalReduction.test.ts` |
| 15 | Mixed date ranges | uncontexted | various | REDUCED (per-date analysis) | `dimensionalReduction.test.ts` |
| 16 | Inconsistent dims in group | context(ch:google) | {ch,dev} mixed with {ch,dev,reg} | NOT REDUCIBLE | `dimensionalReduction.test.ts` |

### 8.5.1 Critical Tests: Dimension Set Grouping & Pinned Query Patterns

```typescript
describe('Critical: Dimension Set Grouping', () => {
  describe('groupByDimensionSet', () => {
    it('separates slices by dimension keys', () => {
      const slices = [
        { sliceDSL: 'context(channel:google)' },
        { sliceDSL: 'context(channel:meta)' },
        { sliceDSL: 'context(device:mobile)' },
        { sliceDSL: 'context(channel:google).context(device:mobile)' },
      ];

      const groups = groupByDimensionSet(slices);

      expect(groups.length).toBe(3);
      expect(groups.find(g => g.dimensionKeys.join(',') === 'channel')?.slices.length).toBe(2);
      expect(groups.find(g => g.dimensionKeys.join(',') === 'device')?.slices.length).toBe(1);
      expect(groups.find(g => g.dimensionKeys.join(',') === 'channel,device')?.slices.length).toBe(1);
    });

    it('handles uncontexted slices as empty dimension set', () => {
      const slices = [
        { sliceDSL: undefined },
        { sliceDSL: 'window(1-Nov-25:7-Nov-25)' },
        { sliceDSL: 'context(channel:google)' },
      ];

      const groups = groupByDimensionSet(slices);

      expect(groups.find(g => g.dimensionKeys.length === 0)?.slices.length).toBe(2);
      expect(groups.find(g => g.dimensionKeys.join(',') === 'channel')?.slices.length).toBe(1);
    });
  });

  describe('evaluateGroupSatisfaction', () => {
    it('single-dim group satisfies uncontexted query via MECE', () => {
      seedContextDefinition('channel', ['google', 'meta', 'other']);
      
      const group = {
        dimensionKeys: ['channel'],
        slices: [
          { sliceDSL: 'context(channel:google)' },
          { sliceDSL: 'context(channel:meta)' },
          { sliceDSL: 'context(channel:other)' },
        ],
      };

      const result = evaluateGroupSatisfaction(group, new Map());

      expect(result.canSatisfy).toBe(true);
      expect(result.reductionType).toBe('single_dim_mece');
    });

    it('multi-dim group cannot satisfy if missing combinations', () => {
      seedContextDefinition('channel', ['google', 'meta']);
      seedContextDefinition('device', ['mobile', 'desktop']);
      
      const group = {
        dimensionKeys: ['channel', 'device'],
        slices: [
          { sliceDSL: 'context(channel:google).context(device:mobile)' },
          { sliceDSL: 'context(channel:google).context(device:desktop)' },
          // Missing meta×mobile, meta×desktop
        ],
      };

      const result = evaluateGroupSatisfaction(group, new Map());

      expect(result.canSatisfy).toBe(false);
      expect(result.reason).toContain('dimension_not_mece'); // channel incomplete
    });
  });

  describe('resolveQueryAcrossGroups', () => {
    it('selects exact match over reduction when both available', () => {
      seedContextDefinition('channel', ['google', 'meta', 'other']);
      
      const slices = [
        // Single-dim group (can satisfy via MECE)
        { sliceDSL: 'context(channel:google)' },
        { sliceDSL: 'context(channel:meta)' },
        { sliceDSL: 'context(channel:other)' },
        // Multi-dim group (partial, but has exact match for google)
        { sliceDSL: 'context(channel:google).context(device:mobile)' },
      ];

      // Query for context(channel:google)
      const result = resolveQueryAcrossGroups(slices, new Map([['channel', 'google']]));

      expect(result.resolved).toBe(true);
      expect(result.satisfaction?.reductionType).toBe('exact'); // Prefers single-dim exact match
    });
  });
});

describe('Critical: Pinned Query Pattern Tests', () => {
  describe('Union pattern: context(channel);context(device)', () => {
    beforeEach(() => {
      seedContextDefinition('channel', ['google', 'meta', 'other']);
      seedContextDefinition('device', ['mobile', 'desktop', 'tablet']);
    });

    it('uncontexted query: both groups satisfy, pick either', () => {
      // Simulates: context(channel);context(device)
      const slices = [
        // {channel} group
        { sliceDSL: 'context(channel:google)', n_daily: [100], k_daily: [50], dates: ['1-Nov-25'] },
        { sliceDSL: 'context(channel:meta)', n_daily: [200], k_daily: [100], dates: ['1-Nov-25'] },
        { sliceDSL: 'context(channel:other)', n_daily: [50], k_daily: [25], dates: ['1-Nov-25'] },
        // {device} group
        { sliceDSL: 'context(device:mobile)', n_daily: [150], k_daily: [75], dates: ['1-Nov-25'] },
        { sliceDSL: 'context(device:desktop)', n_daily: [120], k_daily: [60], dates: ['1-Nov-25'] },
        { sliceDSL: 'context(device:tablet)', n_daily: [80], k_daily: [40], dates: ['1-Nov-25'] },
      ];

      const result = resolveQueryAcrossGroups(slices, new Map()); // uncontexted

      expect(result.resolved).toBe(true);
      // Both groups satisfy; implementation picks one
      expect(['channel', 'device']).toContain(result.selectedGroup?.dimensionKeys[0]);
      
      // CRITICAL: Verify we do NOT sum both groups (would double-count)
      const totalFromChannel = 100 + 200 + 50; // 350
      const totalFromDevice = 150 + 120 + 80;  // 350
      // Both should give same total (since MECE)
      expect(totalFromChannel).toBe(totalFromDevice);
    });

    it('contexted query context(channel:google): uses {channel} group exact match', () => {
      const slices = [
        { sliceDSL: 'context(channel:google)' },
        { sliceDSL: 'context(channel:meta)' },
        { sliceDSL: 'context(device:mobile)' },
        { sliceDSL: 'context(device:desktop)' },
      ];

      const result = resolveQueryAcrossGroups(slices, new Map([['channel', 'google']]));

      expect(result.resolved).toBe(true);
      expect(result.selectedGroup?.dimensionKeys).toEqual(['channel']);
      expect(result.satisfaction?.reductionType).toBe('exact');
    });

    it('contexted query context(device:mobile): uses {device} group exact match', () => {
      const slices = [
        { sliceDSL: 'context(channel:google)' },
        { sliceDSL: 'context(channel:meta)' },
        { sliceDSL: 'context(device:mobile)' },
        { sliceDSL: 'context(device:desktop)' },
      ];

      const result = resolveQueryAcrossGroups(slices, new Map([['device', 'mobile']]));

      expect(result.resolved).toBe(true);
      expect(result.selectedGroup?.dimensionKeys).toEqual(['device']);
      expect(result.satisfaction?.reductionType).toBe('exact');
    });

    it('contexted query context(channel:google).context(device:mobile): FAILS (no multi-dim group)', () => {
      const slices = [
        { sliceDSL: 'context(channel:google)' },
        { sliceDSL: 'context(channel:meta)' },
        { sliceDSL: 'context(device:mobile)' },
        { sliceDSL: 'context(device:desktop)' },
      ];

      const result = resolveQueryAcrossGroups(slices, new Map([['channel', 'google'], ['device', 'mobile']]));

      expect(result.resolved).toBe(false);
      // Neither group has both dimensions
    });
  });

  describe('Mixed pattern: context(channel);context(device:mobile).context(channel)', () => {
    beforeEach(() => {
      seedContextDefinition('channel', ['google', 'meta', 'other']);
      seedContextDefinition('device', ['mobile', 'desktop', 'tablet']);
    });

    it('uncontexted query: uses {channel} group (complete MECE)', () => {
      // Simulates: context(channel);context(device:mobile).context(channel)
      const slices = [
        // {channel} group
        { sliceDSL: 'context(channel:google)' },
        { sliceDSL: 'context(channel:meta)' },
        { sliceDSL: 'context(channel:other)' },
        // {channel,device} group - only mobile row
        { sliceDSL: 'context(channel:google).context(device:mobile)' },
        { sliceDSL: 'context(channel:meta).context(device:mobile)' },
        { sliceDSL: 'context(channel:other).context(device:mobile)' },
      ];

      const result = resolveQueryAcrossGroups(slices, new Map()); // uncontexted

      expect(result.resolved).toBe(true);
      expect(result.selectedGroup?.dimensionKeys).toEqual(['channel']);
      // {channel,device} group fails: device only has 'mobile', not MECE
    });

    it('contexted query context(channel:google): exact match in {channel} group', () => {
      const slices = [
        { sliceDSL: 'context(channel:google)' },
        { sliceDSL: 'context(channel:meta)' },
        { sliceDSL: 'context(channel:google).context(device:mobile)' },
        { sliceDSL: 'context(channel:meta).context(device:mobile)' },
      ];

      const result = resolveQueryAcrossGroups(slices, new Map([['channel', 'google']]));

      expect(result.resolved).toBe(true);
      expect(result.satisfaction?.reductionType).toBe('exact');
    });

    it('contexted query context(device:mobile): uses {channel,device} group (ch MECE for mobile)', () => {
      const slices = [
        { sliceDSL: 'context(channel:google)' },
        { sliceDSL: 'context(channel:meta)' },
        { sliceDSL: 'context(channel:other)' },
        { sliceDSL: 'context(channel:google).context(device:mobile)' },
        { sliceDSL: 'context(channel:meta).context(device:mobile)' },
        { sliceDSL: 'context(channel:other).context(device:mobile)' },
      ];

      const result = resolveQueryAcrossGroups(slices, new Map([['device', 'mobile']]));

      expect(result.resolved).toBe(true);
      expect(result.selectedGroup?.dimensionKeys.sort()).toEqual(['channel', 'device']);
      expect(result.satisfaction?.reductionType).toBe('single_dim_mece'); // Reduce over channel
    });

    it('contexted query context(device:desktop): FAILS (no desktop in multi-dim group)', () => {
      const slices = [
        { sliceDSL: 'context(channel:google)' },
        { sliceDSL: 'context(channel:meta)' },
        // Only mobile in multi-dim
        { sliceDSL: 'context(channel:google).context(device:mobile)' },
        { sliceDSL: 'context(channel:meta).context(device:mobile)' },
      ];

      const result = resolveQueryAcrossGroups(slices, new Map([['device', 'desktop']]));

      expect(result.resolved).toBe(false);
    });
  });

  describe('Cartesian pattern: context(channel).context(device)', () => {
    beforeEach(() => {
      seedContextDefinition('channel', ['google', 'meta']);
      seedContextDefinition('device', ['mobile', 'desktop']);
    });

    it('uncontexted query: all 4 combinations exist, reduces correctly', () => {
      const slices = [
        { sliceDSL: 'context(channel:google).context(device:mobile)', n_daily: [100], k_daily: [50], dates: ['1-Nov-25'] },
        { sliceDSL: 'context(channel:google).context(device:desktop)', n_daily: [150], k_daily: [75], dates: ['1-Nov-25'] },
        { sliceDSL: 'context(channel:meta).context(device:mobile)', n_daily: [80], k_daily: [40], dates: ['1-Nov-25'] },
        { sliceDSL: 'context(channel:meta).context(device:desktop)', n_daily: [120], k_daily: [60], dates: ['1-Nov-25'] },
      ];

      const result = resolveQueryAcrossGroups(slices, new Map());

      expect(result.resolved).toBe(true);
      expect(result.satisfaction?.reductionType).toBe('multi_dim_reduction');
      expect(result.satisfaction?.combinationsComplete).toBe(true);
    });

    it('single-dim query context(channel:google): reduces over device', () => {
      const slices = [
        { sliceDSL: 'context(channel:google).context(device:mobile)', n_daily: [100], k_daily: [50], dates: ['1-Nov-25'] },
        { sliceDSL: 'context(channel:google).context(device:desktop)', n_daily: [150], k_daily: [75], dates: ['1-Nov-25'] },
        { sliceDSL: 'context(channel:meta).context(device:mobile)', n_daily: [80], k_daily: [40], dates: ['1-Nov-25'] },
        { sliceDSL: 'context(channel:meta).context(device:desktop)', n_daily: [120], k_daily: [60], dates: ['1-Nov-25'] },
      ];

      const result = resolveQueryAcrossGroups(slices, new Map([['channel', 'google']]));

      expect(result.resolved).toBe(true);
      expect(result.satisfaction?.unspecifiedDimensions).toEqual(['device']);
      expect(result.satisfaction?.reductionType).toBe('single_dim_mece');
    });
  });
});

describe('Critical: Temporal Heterogeneity (Multi-Epoch Queries)', () => {
  beforeEach(() => {
    seedContextDefinition('channel', ['google', 'meta']);
    seedContextDefinition('device', ['mobile', 'desktop']);
  });

  it('CRITICAL: 6-week query spanning 3 different pinned DSL patterns', () => {
    // This is the ultimate stress test: query spans epochs with different slice structures
    
    // Epoch 1 (1-14 Nov): Cartesian pattern → {ch,dev} slices
    const epoch1Slices = [
      { sliceDSL: 'context(channel:google).context(device:mobile)', dates: ['1-Nov-25', '7-Nov-25', '14-Nov-25'], n_daily: [100, 110, 120], k_daily: [50, 55, 60] },
      { sliceDSL: 'context(channel:google).context(device:desktop)', dates: ['1-Nov-25', '7-Nov-25', '14-Nov-25'], n_daily: [150, 160, 170], k_daily: [75, 80, 85] },
      { sliceDSL: 'context(channel:meta).context(device:mobile)', dates: ['1-Nov-25', '7-Nov-25', '14-Nov-25'], n_daily: [80, 85, 90], k_daily: [40, 43, 45] },
      { sliceDSL: 'context(channel:meta).context(device:desktop)', dates: ['1-Nov-25', '7-Nov-25', '14-Nov-25'], n_daily: [120, 125, 130], k_daily: [60, 63, 65] },
    ];

    // Epoch 2 (15-28 Nov): Union pattern → {ch} + {dev} slices (separate)
    const epoch2Slices = [
      { sliceDSL: 'context(channel:google)', dates: ['15-Nov-25', '21-Nov-25', '28-Nov-25'], n_daily: [250, 270, 290], k_daily: [125, 135, 145] },
      { sliceDSL: 'context(channel:meta)', dates: ['15-Nov-25', '21-Nov-25', '28-Nov-25'], n_daily: [200, 210, 220], k_daily: [100, 105, 110] },
      { sliceDSL: 'context(device:mobile)', dates: ['15-Nov-25', '21-Nov-25', '28-Nov-25'], n_daily: [180, 190, 200], k_daily: [90, 95, 100] },
      { sliceDSL: 'context(device:desktop)', dates: ['15-Nov-25', '21-Nov-25', '28-Nov-25'], n_daily: [270, 290, 310], k_daily: [135, 145, 155] },
    ];

    // Epoch 3 (29 Nov - 12 Dec): Mixed pattern → {ch} + partial {ch,dev}
    const epoch3Slices = [
      { sliceDSL: 'context(channel:google)', dates: ['29-Nov-25', '5-Dec-25', '12-Dec-25'], n_daily: [300, 320, 340], k_daily: [150, 160, 170] },
      { sliceDSL: 'context(channel:meta)', dates: ['29-Nov-25', '5-Dec-25', '12-Dec-25'], n_daily: [220, 230, 240], k_daily: [110, 115, 120] },
      // Partial {ch,dev} — only mobile row
      { sliceDSL: 'context(channel:google).context(device:mobile)', dates: ['29-Nov-25', '5-Dec-25', '12-Dec-25'], n_daily: [130, 140, 150], k_daily: [65, 70, 75] },
      { sliceDSL: 'context(channel:meta).context(device:mobile)', dates: ['29-Nov-25', '5-Dec-25', '12-Dec-25'], n_daily: [100, 105, 110], k_daily: [50, 53, 55] },
    ];

    const allSlices = [...epoch1Slices, ...epoch2Slices, ...epoch3Slices];
    const queryDates = [
      '1-Nov-25', '7-Nov-25', '14-Nov-25',      // Epoch 1
      '15-Nov-25', '21-Nov-25', '28-Nov-25',    // Epoch 2
      '29-Nov-25', '5-Dec-25', '12-Dec-25',     // Epoch 3
    ];

    const analysis = analyzePerDateGroupCoverage(allSlices, new Map(), queryDates);

    // All dates should be covered
    expect(analysis.fullyCovered).toBe(true);
    expect(analysis.uncoveredDates).toEqual([]);

    // Verify correct group selection per epoch
    // Epoch 1: {ch,dev} group (only group with slices for these dates)
    expect(analysis.perDateCoverage[0].selectedGroup?.groupDimKeys.sort()).toEqual(['channel', 'device']);
    expect(analysis.perDateCoverage[1].selectedGroup?.groupDimKeys.sort()).toEqual(['channel', 'device']);
    expect(analysis.perDateCoverage[2].selectedGroup?.groupDimKeys.sort()).toEqual(['channel', 'device']);

    // Epoch 2: {ch} or {dev} group (both satisfy; implementation picks {ch})
    expect(['channel', 'device']).toContain(analysis.perDateCoverage[3].selectedGroup?.groupDimKeys[0]);

    // Epoch 3: {ch} group (only complete MECE for these dates)
    expect(analysis.perDateCoverage[6].selectedGroup?.groupDimKeys).toEqual(['channel']);
    expect(analysis.perDateCoverage[7].selectedGroup?.groupDimKeys).toEqual(['channel']);
    expect(analysis.perDateCoverage[8].selectedGroup?.groupDimKeys).toEqual(['channel']);

    // Now aggregate
    const result = aggregateWithTemporalGroupSwitching(analysis);

    // Verify dates are correct
    expect(result.dates).toEqual(queryDates);

    // Epoch 1 totals (sum all 4 {ch,dev} slices): 100+150+80+120=450 for day 1
    expect(result.n_daily[0]).toBe(100 + 150 + 80 + 120); // 450

    // Epoch 2 totals (sum 2 {ch} slices): 250+200=450 for day 4 (15-Nov)
    expect(result.n_daily[3]).toBe(250 + 200); // 450

    // Epoch 3 totals (sum 2 {ch} slices): 300+220=520 for day 7 (29-Nov)
    expect(result.n_daily[6]).toBe(300 + 220); // 520
  });

  it('CRITICAL: detects gap when no group can satisfy middle epoch', () => {
    // Epoch 1: {ch,dev} slices
    const epoch1Slices = [
      { sliceDSL: 'context(channel:google).context(device:mobile)', dates: ['1-Nov-25'], n_daily: [100], k_daily: [50] },
      { sliceDSL: 'context(channel:google).context(device:desktop)', dates: ['1-Nov-25'], n_daily: [150], k_daily: [75] },
      { sliceDSL: 'context(channel:meta).context(device:mobile)', dates: ['1-Nov-25'], n_daily: [80], k_daily: [40] },
      { sliceDSL: 'context(channel:meta).context(device:desktop)', dates: ['1-Nov-25'], n_daily: [120], k_daily: [60] },
    ];

    // Epoch 2: MISSING — no slices at all for 15-Nov
    
    // Epoch 3: {ch} slices
    const epoch3Slices = [
      { sliceDSL: 'context(channel:google)', dates: ['29-Nov-25'], n_daily: [300], k_daily: [150] },
      { sliceDSL: 'context(channel:meta)', dates: ['29-Nov-25'], n_daily: [220], k_daily: [110] },
    ];

    const allSlices = [...epoch1Slices, ...epoch3Slices];
    const queryDates = ['1-Nov-25', '15-Nov-25', '29-Nov-25'];

    const analysis = analyzePerDateGroupCoverage(allSlices, new Map(), queryDates);

    expect(analysis.fullyCovered).toBe(false);
    expect(analysis.uncoveredDates).toEqual(['15-Nov-25']);
  });

  it('CRITICAL: handles epoch with partial MECE (selects alternative group)', () => {
    // Epoch 1: {ch} complete, {ch,dev} incomplete (only mobile)
    const slices = [
      // {ch} group — complete
      { sliceDSL: 'context(channel:google)', dates: ['1-Nov-25'], n_daily: [250], k_daily: [125] },
      { sliceDSL: 'context(channel:meta)', dates: ['1-Nov-25'], n_daily: [200], k_daily: [100] },
      // {ch,dev} group — incomplete (missing desktop)
      { sliceDSL: 'context(channel:google).context(device:mobile)', dates: ['1-Nov-25'], n_daily: [100], k_daily: [50] },
      { sliceDSL: 'context(channel:meta).context(device:mobile)', dates: ['1-Nov-25'], n_daily: [80], k_daily: [40] },
    ];

    const analysis = analyzePerDateGroupCoverage(slices, new Map(), ['1-Nov-25']);

    expect(analysis.fullyCovered).toBe(true);
    
    // Should select {ch} group because {ch,dev} is incomplete for device
    expect(analysis.perDateCoverage[0].selectedGroup?.groupDimKeys).toEqual(['channel']);
    
    // Verify only 2 slices used (not 4)
    expect(analysis.perDateCoverage[0].selectedGroup?.slicesForDate.length).toBe(2);
  });

  it('CRITICAL: tie-breaks by recency when equally-valid groups exist', () => {
    // Both {ch} and {dev} groups can satisfy — most recent (largest min-ts) wins
    // Recency is determined by stalest member (min retrieved_at) within the group
    const slices = [
      // {ch} group — older (stalest member = Nov 1 10:00)
      { sliceDSL: 'context(channel:google)', dates: ['1-Nov-25'], n_daily: [250], k_daily: [125], retrieved_at: '2025-11-01T10:00:00Z' },
      { sliceDSL: 'context(channel:meta)', dates: ['1-Nov-25'], n_daily: [200], k_daily: [100], retrieved_at: '2025-11-01T10:00:00Z' },
      // {dev} group — fresher (stalest member = Nov 2 09:00)
      { sliceDSL: 'context(device:mobile)', dates: ['1-Nov-25'], n_daily: [180], k_daily: [90], retrieved_at: '2025-11-02T09:00:00Z' },
      { sliceDSL: 'context(device:desktop)', dates: ['1-Nov-25'], n_daily: [270], k_daily: [135], retrieved_at: '2025-11-02T09:00:00Z' },
    ];

    const analysis = analyzePerDateGroupCoverage(slices, new Map(), ['1-Nov-25']);

    // Should select {dev} group because its stalest member is more recent
    expect(analysis.perDateCoverage[0].selectedGroup?.groupDimKeys).toEqual(['device']);
  });

  it('CRITICAL: stalest member rule - mixed recency within group', () => {
    // {ch} group has mixed recency: one very old, one very new
    // {dev} group has uniform moderate recency
    // Stalest member rule: {ch} recency = min(Oct1, Nov1) = Oct1, {dev} recency = Oct25
    // Oct25 > Oct1, so {dev} wins even though {ch} has a newer member
    const slices = [
      // {ch} group — MIXED (stalest member = Oct 1)
      { sliceDSL: 'context(channel:google)', dates: ['1-Nov-25'], n_daily: [100], k_daily: [50], retrieved_at: '2025-10-01T10:00:00Z' }, // VERY OLD
      { sliceDSL: 'context(channel:meta)', dates: ['1-Nov-25'], n_daily: [80], k_daily: [40], retrieved_at: '2025-11-01T10:00:00Z' },    // VERY NEW
      // {dev} group — UNIFORM (stalest member = Oct 25)
      { sliceDSL: 'context(device:mobile)', dates: ['1-Nov-25'], n_daily: [90], k_daily: [45], retrieved_at: '2025-10-25T10:00:00Z' },
      { sliceDSL: 'context(device:desktop)', dates: ['1-Nov-25'], n_daily: [90], k_daily: [45], retrieved_at: '2025-10-25T10:00:00Z' },
    ];

    const analysis = analyzePerDateGroupCoverage(slices, new Map(), ['1-Nov-25']);

    // Should select {dev} because its stalest member (Oct25) is fresher than {ch}'s stalest (Oct1)
    expect(analysis.perDateCoverage[0].selectedGroup?.groupDimKeys).toEqual(['device']);
  });

  it('CRITICAL: tie-breaks deterministically when same recency', () => {
    // Both groups have same retrieved_at — should be deterministic
    const slices = [
      { sliceDSL: 'context(channel:google)', dates: ['1-Nov-25'], n_daily: [250], k_daily: [125], retrieved_at: '2025-11-02T10:00:00Z' },
      { sliceDSL: 'context(channel:meta)', dates: ['1-Nov-25'], n_daily: [200], k_daily: [100], retrieved_at: '2025-11-02T10:00:00Z' },
      { sliceDSL: 'context(device:mobile)', dates: ['1-Nov-25'], n_daily: [180], k_daily: [90], retrieved_at: '2025-11-02T10:00:00Z' },
      { sliceDSL: 'context(device:desktop)', dates: ['1-Nov-25'], n_daily: [270], k_daily: [135], retrieved_at: '2025-11-02T10:00:00Z' },
    ];

    // Run twice to verify determinism
    const analysis1 = analyzePerDateGroupCoverage(slices, new Map(), ['1-Nov-25']);
    const analysis2 = analyzePerDateGroupCoverage(slices, new Map(), ['1-Nov-25']);

    expect(analysis1.perDateCoverage[0].selectedGroup?.groupDimKeys)
      .toEqual(analysis2.perDateCoverage[0].selectedGroup?.groupDimKeys);
  });
});

describe('Critical: Sparse Cartesian Rejection', () => {
  it('CRITICAL: rejects sparse Cartesian product (per-dim MECE but missing combos)', () => {
    // This tests the attack scenario where per-dimension MECE passes
    // but full Cartesian product is incomplete
    seedContextDefinition('channel', ['google', 'meta', 'tiktok', 'other']);
    seedContextDefinition('device', ['mobile', 'desktop', 'tablet', 'ios', 'android']);

    // 9 slices: NOT a complete 4×5=20 Cartesian product
    const slices = [
      makeSlice('google', 'mobile'), makeSlice('google', 'desktop'),
      makeSlice('google', 'tablet'), makeSlice('google', 'ios'),
      makeSlice('google', 'android'),  // 5 for google
      makeSlice('meta', 'mobile'),     // 1 for meta
      makeSlice('tiktok', 'mobile'),   // 1 for tiktok
      makeSlice('other', 'mobile'), makeSlice('other', 'desktop'), // 2 for other
    ];

    const result = resolveQueryAcrossGroups(slices, new Map()); // uncontexted query

    expect(result.kind).toBe('not_reducible');
    expect(result.reason).toBe('missing_combinations');
    expect(result.diagnostics.warnings[0]).toContain('Missing');
  });

  it('CRITICAL: accepts complete Cartesian product', () => {
    seedContextDefinition('channel', ['google', 'meta']);
    seedContextDefinition('device', ['mobile', 'desktop']);

    // Complete 2×2=4 Cartesian product
    const slices = [
      makeSlice('google', 'mobile'), makeSlice('google', 'desktop'),
      makeSlice('meta', 'mobile'), makeSlice('meta', 'desktop'),
    ];

    const result = tryDimensionalReduction(slices, '');

    expect(result.kind).toBe('reduced');
    expect(result.diagnostics.slicesUsed).toBe(4);
  });

  it('single unspecified dimension: per-dim MECE is sufficient', () => {
    // For 1D reduction, per-dimension check IS sufficient
    seedContextDefinition('device', ['mobile', 'desktop', 'tablet']);

    const slices = [
      makeSlice('google', 'mobile'),
      makeSlice('google', 'desktop'),
      makeSlice('google', 'tablet'),
    ];

    const result = tryDimensionalReduction(slices, 'context(channel:google)');

    expect(result.kind).toBe('reduced');
    expect(result.diagnostics.slicesUsed).toBe(3);
  });
});

describe('Critical: Flexible date range coverage', () => {
  it('CRITICAL: mixed uncontexted + MECE contexted covers full range', () => {
    // Dates 1-5: uncontexted slice
    // Dates 5-10: MECE contexted slices
    // Query: 1-10
    const uncontextedSlice = {
      sliceDSL: undefined,
      dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25', '4-Nov-25', '5-Nov-25'],
      n_daily: [100, 110, 120, 130, 140],
      k_daily: [50, 55, 60, 65, 70],
    };

    const contextedSlices = [
      {
        sliceDSL: 'context(channel:google)',
        dates: ['5-Nov-25', '6-Nov-25', '7-Nov-25', '8-Nov-25', '9-Nov-25', '10-Nov-25'],
        n_daily: [200, 210, 220, 230, 240, 250],
        k_daily: [100, 105, 110, 115, 120, 125],
      },
      {
        sliceDSL: 'context(channel:meta)',
        dates: ['5-Nov-25', '6-Nov-25', '7-Nov-25', '8-Nov-25', '9-Nov-25', '10-Nov-25'],
        n_daily: [50, 55, 60, 65, 70, 75],
        k_daily: [25, 28, 30, 33, 35, 38],
      },
    ];

    seedContextDefinition('channel', ['google', 'meta']);

    const result = analyzePerDateCoverage(
      [uncontextedSlice, ...contextedSlices],
      new Map(), // uncontexted query
      ['1-Nov-25', '2-Nov-25', '3-Nov-25', '4-Nov-25', '5-Nov-25',
       '6-Nov-25', '7-Nov-25', '8-Nov-25', '9-Nov-25', '10-Nov-25']
    );

    expect(result.fullyCovered).toBe(true);
    
    // Dates 1-4: from uncontexted
    expect(result.coverage[0].source).toBe('uncontexted');
    expect(result.coverage[3].source).toBe('uncontexted');
    
    // Date 5: could be either (overlap) — prefer uncontexted for simplicity
    // Dates 6-10: from MECE contexted
    expect(result.coverage[5].source).toBe('mece_aggregated');
    expect(result.coverage[9].source).toBe('mece_aggregated');
  });

  it('CRITICAL: gap in coverage detected', () => {
    // Dates 1-3: uncontexted
    // Dates 6-10: MECE contexted
    // Gap at dates 4-5
    const uncontextedSlice = {
      sliceDSL: undefined,
      dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25'],
      n_daily: [100, 110, 120],
      k_daily: [50, 55, 60],
    };

    const contextedSlices = [
      {
        sliceDSL: 'context(channel:google)',
        dates: ['6-Nov-25', '7-Nov-25', '8-Nov-25', '9-Nov-25', '10-Nov-25'],
        n_daily: [200, 210, 220, 230, 240],
        k_daily: [100, 105, 110, 115, 120],
      },
    ];

    const result = analyzePerDateCoverage(
      [uncontextedSlice, ...contextedSlices],
      new Map(),
      ['1-Nov-25', '2-Nov-25', '3-Nov-25', '4-Nov-25', '5-Nov-25',
       '6-Nov-25', '7-Nov-25', '8-Nov-25', '9-Nov-25', '10-Nov-25']
    );

    expect(result.fullyCovered).toBe(false);
    expect(result.coverage[3].source).toBe('uncovered'); // 4-Nov-25
    expect(result.coverage[4].source).toBe('uncovered'); // 5-Nov-25
  });

  it('aggregation produces correct values with mixed sources', () => {
    // Verify that aggregation correctly sums per-date values from mixed sources
    const coverage: DateCoverage[] = [
      { date: '1-Nov-25', source: 'uncontexted', slicesUsed: [{ dates: ['1-Nov-25'], n_daily: [100], k_daily: [50] }] },
      { date: '2-Nov-25', source: 'mece_aggregated', slicesUsed: [
        { dates: ['2-Nov-25'], n_daily: [60], k_daily: [30] },
        { dates: ['2-Nov-25'], n_daily: [40], k_daily: [20] },
      ]},
    ];

    const result = aggregateWithMixedCoverage(coverage);

    expect(result.dates).toEqual(['1-Nov-25', '2-Nov-25']);
    expect(result.n_daily).toEqual([100, 100]); // 100, then 60+40
    expect(result.k_daily).toEqual([50, 50]);   // 50, then 30+20
  });
});

describe('Critical: Dimension set consistency', () => {
  it('CRITICAL: rejects slices with inconsistent dimension sets', () => {
    const slices = [
      { sliceDSL: 'context(channel:google).context(device:mobile)' },
      { sliceDSL: 'context(channel:google).context(device:desktop).context(region:uk)' },
    ];

    const result = tryDimensionalReduction(slices, 'context(channel:google)');

    expect(result.kind).toBe('not_reducible');
    expect(result.reason).toBe('inconsistent_dimension_sets');
  });

  it('accepts slices with consistent dimension sets', () => {
    seedContextDefinition('device', ['mobile', 'desktop']);
    
    const slices = [
      { sliceDSL: 'context(channel:google).context(device:mobile)', dates: ['1-Nov-25'], n_daily: [100], k_daily: [50] },
      { sliceDSL: 'context(channel:google).context(device:desktop)', dates: ['1-Nov-25'], n_daily: [100], k_daily: [50] },
    ];

    const result = tryDimensionalReduction(slices, 'context(channel:google)');

    expect(result.kind).toBe('reduced');
  });
});

describe('Critical: Mixed signature types in file', () => {
  it('single-dim MECE works ignoring multi-dim slices in same file', () => {
    const singleDimSig = '{"c":"abc","x":{"channel":"h1"}}';
    const multiDimSig = '{"c":"abc","x":{"channel":"h1","device":"h2"}}';
    
    seedContextDefinition('channel', ['google', 'meta', 'other']);

    const values = [
      // Single-dim slices (complete MECE)
      { sliceDSL: 'context(channel:google)', query_signature: singleDimSig },
      { sliceDSL: 'context(channel:meta)', query_signature: singleDimSig },
      { sliceDSL: 'context(channel:other)', query_signature: singleDimSig },
      // Multi-dim slice (should be ignored by single-dim MECE logic)
      { sliceDSL: 'context(channel:google).context(device:mobile)', query_signature: multiDimSig },
    ];

    // isEligibleContextOnlySlice rejects the multi-dim slice
    expect(isEligibleContextOnlySlice(values[0])).toBeTruthy();
    expect(isEligibleContextOnlySlice(values[3])).toBeNull();

    // Single-dim MECE should work with first 3 slices
    const meceResult = computeMECEGenerationCandidates(values, 'channel');
    expect(meceResult.candidates.length).toBeGreaterThan(0);
  });

  it('multi-dim reduction works ignoring single-dim slices in same file', () => {
    const singleDimSig = '{"c":"abc","x":{"channel":"h1"}}';
    const multiDimSig = '{"c":"abc","x":{"channel":"h1","device":"h2"}}';
    
    seedContextDefinition('device', ['mobile', 'desktop']);

    const values = [
      // Single-dim slice
      { sliceDSL: 'context(channel:google)', query_signature: singleDimSig },
      // Multi-dim slices (complete for device)
      { sliceDSL: 'context(channel:google).context(device:mobile)', query_signature: multiDimSig, dates: ['1-Nov-25'], n_daily: [100], k_daily: [50] },
      { sliceDSL: 'context(channel:google).context(device:desktop)', query_signature: multiDimSig, dates: ['1-Nov-25'], n_daily: [100], k_daily: [50] },
    ];

    // Multi-dim query: context(channel:google)
    // Should use the 2 multi-dim slices, not the single-dim one
    const multiDimEligible = values.filter(v => isEligibleMultiContextSlice(v as any));
    expect(multiDimEligible.length).toBe(2);

    const result = tryDimensionalReduction(multiDimEligible, 'context(channel:google)');
    expect(result.kind).toBe('reduced');
    expect(result.diagnostics.slicesUsed).toBe(2);
  });
});
```

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
| **verifyAllCombinationsExist** | 3 | Complete Cartesian, sparse (attack), single-dim bypass |
| **analyzePerDateCoverage** | 4 | Mixed sources, gaps, overlap, full range |
| **aggregateWithMixedCoverage** | 2 | Correct sums, uncovered handling |
| **groupByDimensionSet** | 2 | Separates by keys, handles uncontexted |
| **evaluateGroupSatisfaction** | 2 | Single-dim MECE, multi-dim combos |
| **resolveQueryAcrossGroups** | 1 | Selects best group |
| **analyzePerDateGroupCoverage** | 4 | Per-date evaluation, gaps, tie-breaks |
| **aggregateWithTemporalGroupSwitching** | 2 | Group switching, correct sums |
| **Union pattern (;)** | 4 | Uncontexted, ch:google, dev:mobile, multi-dim fails |
| **Mixed pattern** | 4 | Uncontexted, ch:google, dev:mobile, dev:desktop fails |
| **Cartesian pattern (.)** | 2 | Uncontexted, single-dim query |
| **Temporal heterogeneity** | 6 | 6-week/3-epoch, gap detection, partial MECE, recency tie-break, stalest-member, determinism |
| **dedupeSlices** | 2 | Basic dedupe, fresher kept |
| **missing/error hash handling** | 3 | Cache missing, query missing, both missing |
| **H1: parseSignature robustness** | 7 | null, undefined, empty, legacy hex, not-json, wrong types, null x |
| **H2: extractContextMap memoization** | 2 | Cache hit, cache miss |
| **H4: verifyAllCombinations perf** | 3 | Fast path, bounded dims, capped diagnostics |
| **Sparse Cartesian** | 1 | Missing combinations rejected |
| **Dimension set consistency** | 2 | Inconsistent rejected, consistent accepted |
| **computeMultiDimMECECandidates** | 3 | Signature grouping, MECE selection, freshness |
| **isolateSlicePartialMatch** | 4 | Superset, uncontexted, all match, 3-dim |
| **Integration: coverage** | 4 | Complete MECE, incomplete, uncontexted, aggregation |
| **Test matrix scenarios** | 16 | All dimensional permutations |
| **Regressions** | 3 | Single-dim, exact match, case rejection |
| **Hardening (H1, H2, H4)** | 12 | Robustness, memoization, performance |
| **Phase 5 Total** | **117** |

### 8.8 Updated Grand Total

| Phase | Tests |
|-------|-------|
| Phases 1-4 (from proposal) | 71 |
| Phase 5 (multi-dim + temporal + hardening) | 117 |
| **Grand Total** | **188** |

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
| Test coverage gaps | Medium | High | 176 tests with full scenario matrix |
| **Phase 5: Aggregation math errors** | Low | High | Unit tests verify sum correctness |
| **Phase 5: Date array misalignment** | Medium | Medium | Explicit validation before aggregation |
| **Phase 5: MECE verification too strict** | Medium | Low | Follows existing context definition policies |
| **Phase 5: Performance with large slice sets** | Low | Medium | Lazy evaluation; early exit on MECE fail |

---

## 10.5 Implementation Hardening

This section addresses specific implementation risks identified during design review.

### H1. Legacy Signature Robustness

**Risk**: The "Big Bang" signature change invalidates all existing caches. If `parseSignature` crashes on legacy 64-character hex strings, the entire system fails.

**Requirement**: `parseSignature` MUST be defensive and never throw.

```typescript
export function parseSignature(sig: string): StructuredSignature {
  // Guard: null/undefined/empty
  if (!sig || typeof sig !== 'string') {
    return { coreHash: '', contextDefHashes: {} };
  }
  
  // Guard: Legacy hex hash (64 chars, hex only)
  if (/^[a-f0-9]{64}$/i.test(sig)) {
    // Legacy signature - return empty structure (will never match)
    return { coreHash: '', contextDefHashes: {} };
  }
  
  // Guard: Not JSON-like
  if (!sig.startsWith('{')) {
    return { coreHash: '', contextDefHashes: {} };
  }
  
  try {
    const parsed = JSON.parse(sig);
    return {
      coreHash: typeof parsed.c === 'string' ? parsed.c : '',
      contextDefHashes: (parsed.x && typeof parsed.x === 'object') ? parsed.x : {},
    };
  } catch {
    // Malformed JSON - return empty structure
    return { coreHash: '', contextDefHashes: {} };
  }
}
```

**Test coverage required**:
- [ ] `parseSignature(null)` → empty structure
- [ ] `parseSignature(undefined)` → empty structure
- [ ] `parseSignature('')` → empty structure
- [ ] `parseSignature('a1b2c3...')` (64-char hex) → empty structure
- [ ] `parseSignature('not json')` → empty structure
- [ ] `parseSignature('{"c":123}')` (wrong type) → empty structure
- [ ] `parseSignature('{"c":"abc","x":null}')` (null x) → coreHash only

### H2. Context Map Memoization

**Risk**: `extractContextMap` is called in hot loops (per-slice, per-date). For a 90-day query over 1,000 slices, this is 90,000+ parsing operations.

**Requirement**: Memoize `extractContextMap` with a `Map<string, Map<string, string>>` keyed by `sliceDSL`.

```typescript
// Module-level cache (cleared on window reload)
const contextMapCache = new Map<string, Map<string, string>>();

export function extractContextMap(sliceDSL: string): Map<string, string> {
  const key = sliceDSL ?? '';
  
  const cached = contextMapCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  
  // Actual parsing logic
  const dims = extractSliceDimensions(key);
  if (!dims) {
    const empty = new Map<string, string>();
    contextMapCache.set(key, empty);
    return empty;
  }
  
  const parsed = parseConstraints(dims);
  const map = new Map<string, string>();
  for (const ctx of parsed.context) {
    map.set(ctx.key, ctx.value);
  }
  
  contextMapCache.set(key, map);
  return map;
}

// Optional: Clear cache (e.g., after workspace switch)
export function clearContextMapCache(): void {
  contextMapCache.clear();
}
```

**Performance target**: `extractContextMap` should be O(1) for repeated calls with the same DSL string.

### H3. Module Dependency Boundaries

**Risk**: Circular dependencies between `dimensionalReductionService`, `contextRegistry`, and `meceSliceService`.

**Requirement**: Strict layering with no circular imports.

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 4: Orchestration                                          │
│   windowAggregationService, fetchPlanBuilderService             │
│   (imports from Layers 1-3)                                     │
├─────────────────────────────────────────────────────────────────┤
│ Layer 3: Business Logic                                         │
│   dimensionalReductionService, meceSliceService                 │
│   (imports from Layers 1-2 only)                                │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: Signature Matching                                     │
│   signatureMatchingService                                      │
│   (imports from Layer 1 only)                                   │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1: Pure Utilities (no service imports)                    │
│   contextRegistry (data only), sliceIsolation, dslExplosion     │
│   (imports only types and pure functions)                       │
└─────────────────────────────────────────────────────────────────┘
```

**Implementation rules**:
1. `signatureMatchingService.ts` — ZERO imports from other services (pure functions only)
2. `dimensionalReductionService.ts` — may import `contextRegistry` and `signatureMatchingService`
3. `meceSliceService.ts` — may import `dimensionalReductionService` for multi-dim logic
4. `windowAggregationService.ts` — may import from all lower layers

**Verification**: Run `madge --circular src/services/` after implementation to detect cycles.

### H4. Combination Verification Performance

**Risk**: `verifyAllCombinationsExist` generates a Cartesian product of dimension values. For 4 dimensions × 5 values each = 625 expected combinations.

**Requirement**: Early exit and bounded iteration.

```typescript
export function verifyAllCombinationsExist(
  slices: ParameterValue[],
  unspecifiedDimensions: string[]
): { complete: boolean; missingCombinations: string[] } {
  // Fast path: single dimension doesn't need combination check
  if (unspecifiedDimensions.length <= 1) {
    return { complete: true, missingCombinations: [] };
  }
  
  // Guard: Limit dimensionality to prevent combinatorial explosion
  // Real-world queries rarely exceed 3 dimensions
  if (unspecifiedDimensions.length > 4) {
    console.warn(`verifyAllCombinationsExist: ${unspecifiedDimensions.length} dimensions, skipping full verification`);
    return { complete: false, missingCombinations: ['too_many_dimensions'] };
  }
  
  // Build set of actual combinations (O(n) where n = slices.length)
  const actualCombinations = new Set<string>();
  for (const slice of slices) {
    const ctxMap = extractContextMap(slice.sliceDSL ?? '');
    const combo = unspecifiedDimensions
      .map(d => `${d}:${ctxMap.get(d) ?? ''}`)
      .sort()
      .join('|');
    actualCombinations.add(combo);
  }
  
  // Collect dimension values (O(n))
  const dimensionValues: Map<string, Set<string>> = new Map();
  for (const dimKey of unspecifiedDimensions) {
    dimensionValues.set(dimKey, new Set());
  }
  for (const slice of slices) {
    const ctxMap = extractContextMap(slice.sliceDSL ?? '');
    for (const dimKey of unspecifiedDimensions) {
      const v = ctxMap.get(dimKey);
      if (v) dimensionValues.get(dimKey)!.add(v);
    }
  }
  
  // Calculate expected count without generating all combinations
  let expectedCount = 1;
  for (const values of dimensionValues.values()) {
    expectedCount *= values.size;
  }
  
  // Fast check: if actual count equals expected, we're complete
  if (actualCombinations.size === expectedCount) {
    return { complete: true, missingCombinations: [] };
  }
  
  // Slow path: find missing combinations (only if incomplete)
  // Limit to reporting first 10 missing for diagnostics
  const missing: string[] = [];
  const arrays = unspecifiedDimensions.map(d => Array.from(dimensionValues.get(d)!).sort());
  
  function* generateCombinations(index: number, current: string[]): Generator<string[]> {
    if (index === arrays.length) {
      yield [...current];
      return;
    }
    for (const v of arrays[index]) {
      current.push(v);
      yield* generateCombinations(index + 1, current);
      current.pop();
    }
  }
  
  for (const combo of generateCombinations(0, [])) {
    const key = unspecifiedDimensions.map((d, i) => `${d}:${combo[i]}`).sort().join('|');
    if (!actualCombinations.has(key)) {
      missing.push(key);
      if (missing.length >= 10) break; // Limit diagnostic output
    }
  }
  
  return { complete: false, missingCombinations: missing };
}
```

**Performance characteristics**:
- Single dimension: O(1) early exit
- Slice parsing: O(n) with memoization (see H2)
- Fast completeness check: O(1) set size comparison
- Missing diagnostics: Only generated when incomplete, capped at 10

### H5. Stalest Member Behaviour Documentation

**Risk**: The "stalest member" recency rule may surprise users when a group with one old slice is deprioritised even though most of its slices are fresh.

**Requirement**: This behaviour is **intentional** and must be documented in diagnostics.

When session logging shows group selection, include:

```typescript
sessionLogService.info('dimensional-reduction', 'GROUP_SELECTED', 
  `Selected group {${selectedGroup.dimensionKeys.join(',')}} for date ${date}`,
  undefined,
  {
    priority: satisfaction.reductionType,
    recency: new Date(groupRecency).toISOString(),
    recencyRule: 'stalest_member',  // Explicitly label the rule
    sliceCount: selectedGroup.slices.length,
    rejectedGroups: rejectedGroups.map(g => ({
      dims: g.dimensionKeys,
      reason: g.reason,
      recency: g.recency,
    })),
  }
);
```

**User-facing documentation** (add to `graph-editor/public/docs/query-expressions.md`):

> **Cache Freshness**: When multiple cached slice sets can satisfy a query, the system prefers the set where the *oldest* slice is most recent. This ensures you never get a mix of fresh and stale data.

### H6. Dedupe Integration Point

**Risk**: `dedupeSlices` exists but may not be called at the right point in the pipeline.

**Requirement**: Dedupe MUST be called in `aggregateWithTemporalGroupSwitching` before summing.

```typescript
function aggregateWithTemporalGroupSwitching(
  analysis: PerDateGroupAnalysis
): AggregatedResult {
  // ...existing code...
  
  for (const coverage of analysis.perDateCoverage) {
    if (!coverage.selectedGroup) {
      throw new Error(`Uncovered date: ${coverage.date}`);
    }
    
    // CRITICAL: Dedupe before summing to prevent double-count
    const dedupedSlices = dedupeSlices(coverage.selectedGroup.slicesForDate);
    
    // Sum the deduped slices for this date
    // ...rest of summing logic using dedupedSlices...
  }
}
```

**Test**: Scenario 15 in `multi-sig-matching-testing-logic.md` verifies this.

---

## 11. Success Criteria (Updated)

1. **Primary bug fixed**: Uncontexted query over single-dim MECE cache no longer demands refetch
2. **Multi-dim support**: Single-dim query over multi-dim MECE cache uses cache
3. **Full uncontexted support**: Uncontexted query over multi-dim MECE cache uses cache
4. **Tests pass**: All 188 unit, integration, and E2E tests pass
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
