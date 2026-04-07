# MECE Context Aggregation: Complete Design

## Problem Statement

The `@` menu for `li-cohort-segmentation-v2` shows no snapshots, despite the DB containing fresh data from today's automation run. Root cause: the `@` menu computes signatures via an independent codepath (`snapshotRetrievalsService.resolveContextKeys`) that diverges from the fetch/store path. This is the tip of a deeper design gap: the system lacks a unified, general mechanism for reasoning about context dimensions across all consumers (fetch, read-back, `@` menu, planner, integrity checks).

This document defines the complete condition space, identifies gaps in both code and tests, and proposes a generalised solution.

---

## 1. Condition Space

### 1.1 DSL Context Patterns

A graph's `dataInterestsDSL` can express context dimensions in three ways:

| Pattern | Meaning | Example | Stored slice shape |
|---------|---------|---------|-------------------|
| **Single bare key** | Fetch per-value for one MECE dimension | `context(channel)` | `context(channel:v)` |
| **Semicolon** (`;`) | Fetch per-value for each dimension **independently** | `context(a);context(b)` | `context(a:v)` or `context(b:w)` (never both) |
| **Dot-product** (`.`) | Fetch per-value for **cross-product** of dimensions | `context(a).context(b)` | `context(a:v).context(b:w)` (always both) |
| **Mixed** | Semicolon at top, dot-product within groups | `context(a).context(b);context(c)` | `context(a:v).context(b:w)` or `context(c:x)` |

Each can be composed with time modes via `(window;cohort).(contexts)`.

### 1.2 MECE Status of Each Dimension

Each context key has a MECE policy from its context definition:

| Policy | Meaning | Aggregation safe? |
|--------|---------|-------------------|
| `null` | Values are exhaustive; no "other" bucket | Yes, if all values present |
| `computed` | Values + computed "other" bucket are exhaustive | Yes, if "other" present |
| `undefined` | No MECE guarantee | **No** |
| Not loaded / unknown | Context definition not available | **No** (fail-safe) |

A dimension can also be **complete** (all declared values present in data) or **incomplete** (some values missing).

### 1.3 Query Types

The consumer asking for data can be:

| Query context | What it needs | Example DSL |
|--------------|---------------|-------------|
| **Uncontexted** | Total across all contexts | `cohort(-30d:)` |
| **Single-key contexted** | Specific value of one dimension | `context(channel:google).cohort(-30d:)` |
| **Multi-key contexted** | Specific values of multiple dimensions | `context(a:v1).context(b:w1).cohort(-30d:)` |
| **Bare-key contexted** | All values of one dimension separately | `context(channel).cohort(-30d:)` |

### 1.4 Stored Data Shapes

Depending on the fetch pattern, stored slices can be:

| Shape | Arises from | Example slice keys |
|-------|-------------|-------------------|
| **Uncontexted** | Explicit uncontexted fetch | `window(-30d:)` |
| **Single-key** | Semicolon pattern or single bare key | `context(channel:google).window(-30d:)` |
| **Multi-key** | Dot-product pattern | `context(channel:google).context(geo:UK).window(-30d:)` |

---

## 2. Complete Condition Matrix

Every combination of (query type) x (stored data shape) x (MECE status) must have a defined behaviour.

### 2.1 Stored data: single-key slices (from semicolon pattern)

Stored: `context(a:v1)`, `context(a:v2)`, `context(b:w1)`, `context(b:w2)` (each slice has exactly one context key).

| Query | a is MECE | b is MECE | Expected behaviour |
|-------|-----------|-----------|-------------------|
| Uncontexted | Yes | Yes | Pick ONE MECE dim (freshest/most-complete), aggregate across its values |
| Uncontexted | Yes | No | Pick `a` (MECE), aggregate |
| Uncontexted | No | No | `not_resolvable` — no safe aggregation |
| `context(a:v1)` | — | — | Direct slice match — return `context(a:v1)` data |
| `context(b:w1)` | — | — | Direct slice match — return `context(b:w1)` data |
| `context(c:x)` | — | — | No match — no data |

**Current status:** `selectImplicitUncontextedSliceSetSync` handles this correctly for the uncontexted case. Direct slice matches work via `isolateSlice`.

### 2.2 Stored data: multi-key slices (from dot-product pattern)

Stored: `context(a:v1).context(b:w1)`, `context(a:v1).context(b:w2)`, `context(a:v2).context(b:w1)`, `context(a:v2).context(b:w2)`.

| Query | a is MECE | b is MECE | Expected behaviour |
|-------|-----------|-----------|-------------------|
| **Uncontexted** | Yes | Yes | Aggregate ALL cross-product slices (they partition the population) |
| **Uncontexted** | Yes | No | **Cannot aggregate** — `b` is not MECE so cross-product doesn't partition |
| **Uncontexted** | No | Yes | **Cannot aggregate** — same reason (both dims must be MECE for cross-product to partition) |
| **Uncontexted** | No | No | `not_resolvable` |
| **`context(a:v1)`** | — | Yes (b) | Aggregate over `b` values for `a=v1`: sum `context(a:v1).context(b:w1)` + `context(a:v1).context(b:w2)` |
| **`context(a:v1)`** | — | No (b) | **Cannot aggregate** — `b` is not MECE |
| **`context(b:w1)`** | Yes (a) | — | Aggregate over `a` values for `b=w1` |
| **`context(b:w1)`** | No (a) | — | **Cannot aggregate** |
| **`context(a:v1).context(b:w1)`** | — | — | Direct slice match |

**Current status:** `tryDimensionalReduction` handles the `context(a:v1)` → aggregate over `b` case. But `selectImplicitUncontextedSliceSetSync` **rejects** multi-key slices entirely (line 95: `context.length !== 1 → null`). The uncontexted case is **broken**.

### 2.3 Stored data: mixed (from mixed pattern)

Stored: `context(a:v1).context(b:w1)`, `context(a:v1).context(b:w2)`, ..., `context(c:x1)`, `context(c:x2)`.

| Query | Expected behaviour |
|-------|-------------------|
| Uncontexted | Must choose: aggregate cross-product `(a,b)` slices OR aggregate `c` slices. NOT both. Both routes must individually be MECE-safe. Pick by freshness/coverage. |
| `context(a:v1)` | Aggregate over `b` for `a=v1` (if `b` is MECE). Ignore `c` slices. |
| `context(c:x1)` | Direct match on `context(c:x1)` slices. Ignore `(a,b)` slices. |

**Current status:** Partially handled. `isolateSlice` handles direct matches. `tryDimensionalReduction` handles the `context(a:v1)` case. The uncontexted case with mixed shapes is **not handled**.

### 2.4 Completeness conditions for aggregation

For aggregation to be safe, ALL of these must hold:

1. **Every unspecified dimension must be MECE** — its context definition has a policy that permits aggregation (`null` or `computed`)
2. **Every unspecified dimension must be complete** — all declared values (per the context definition) are present in the data. (Or `requireComplete=false` with appropriate warnings.)
3. **The cross-product must be fully populated** — no missing cells in the grid. If `a` has 3 values and `b` has 4, there must be 12 slices (for dot-product data).
4. **Date arrays must align** — all slices being aggregated must cover the same date range (for array-based aggregation like `n_daily`/`k_daily`).

---

## 3. Current Codepath Map

Six production call sites compute signatures via `computeQuerySignature`:

| Call site | Context keys source | Used for |
|-----------|-------------------|----------|
| **getFromSourceDirect.ts:1802** | From actual fetch DSL constraints | Writing snapshots (WRITE path) |
| **snapshotRetrievalsService.ts:142** | `resolveContextKeys` — falls back to ALL keys from `dataInterestsDSL` | `@` menu lookup (READ path) — **BROKEN** |
| **plannerQuerySignatureService.ts:392** | From DSL + candidate keys from cached file values | Coverage planning |
| **commitHashGuardService.ts:354** | From explicit context keys | Commit guard |
| **integrityCheckService.ts:3355** | From explicit context keys | Integrity checks |
| **fileToGraphSync.ts:845** | From DSL constraints | File-to-graph sync |

The **write path** (getFromSourceDirect) produces signatures with exactly the context keys present in the per-slice fetch DSL — typically ONE key for semicolon patterns, TWO+ keys for dot-product patterns.

The **`@` menu read path** (snapshotRetrievalsService) computes its own signature and tries to match against stored signatures. Its `resolveContextKeys` function falls back to `dataInterestsDSL`, injecting ALL context keys — producing a signature that matches nothing stored.

### 3.1 Aggregation functions

| Function | Handles single-key slices | Handles multi-key slices |
|----------|--------------------------|--------------------------|
| `selectImplicitUncontextedSliceSetSync` | Yes — picks one MECE dim | **No** — rejects `context.length !== 1` |
| `tryDimensionalReduction` | N/A (for reducing multi→fewer keys) | Yes — aggregates unspecified dims if MECE |
| `tryMECEAggregationAcrossContexts` | Yes — picks one MECE dim | **No** — only considers single-key groups |
| `isolateSlice` | Exact match only | Exact match only (no partial matching) |

---

## 4. Gaps

### 4.1 Code gaps

| Gap | Impact | Severity |
|-----|--------|----------|
| **G1: `@` menu signature divergence** | `@` menu shows no snapshots for contexted graphs | Critical — user-visible, affects li-cohort-segmentation-v2 |
| **G2: Uncontexted aggregation of multi-key slices** | `selectImplicitUncontextedSliceSetSync` rejects `context.length !== 1`; `tryMECEAggregationAcrossContexts` same | High — dot-product `dataInterestsDSL` would silently produce empty data |
| **G3: Mixed single-key + multi-key uncontexted** | No logic to choose between aggregating `(a,b)` cross-product vs `c` single-key slices | Medium — only arises with mixed semicolon+dot patterns |
| **G4: No codepath sharing** | Six call sites compute signatures independently; `@` menu doesn't use the same logic as fetch | High — any change to signature computation requires updating 6 places |

### 4.2 Test gaps

| Gap | Scenario not tested |
|-----|-------------------|
| **T1** | 3+ MECE dimensions (semicolon), uncontexted query — pick 1 |
| **T2** | Dot-product `context(a).context(b)` both MECE — uncontexted aggregation |
| **T3** | Dot-product `context(a).context(b)` — `context(a:v)` query aggregating over `b` |
| **T4** | Dot-product with one non-MECE dim — rejection |
| **T5** | Mixed semicolon+dot: `context(a).context(b);context(c)` — uncontexted |
| **T6** | `@` menu with contexted graph — signature parity with stored snapshots |
| **T7** | `@` menu with uncontexted DSL on graph with MECE contexts — should find snapshots |
| **T8** | Multi-key slice rejection by `isEligibleContextOnlySlice` — explicit test |
| **T9** | Duplicate context key: `context(a).context(a)` — behaviour undefined |

---

## 5. Design: Generalised Context Resolution

### 5.1 Core principle

**One function answers: "given this query DSL and this graph's stored data, what is the effective signature (or set of signatures) to look up?"**

This function must be used by ALL consumers: fetch planning, `@` menu, planner, integrity checks. It must handle all combinations in the condition matrix above.

### 5.2 Proposed function: `resolveEffectiveSignatures`

```
resolveEffectiveSignatures(args: {
  graph: GraphData;
  edge: Edge;
  queryDSL: string;           // the user's current DSL (may or may not have context)
  workspace: { repository, branch };
}): Promise<{
  signatures: Array<{
    signature: string;
    shortHash: string;
    contextKeys: string[];    // keys that went into this signature
    scope: 'exact' | 'mece_aggregation' | 'dimensional_reduction';
  }>;
  diagnostics: { ... };
}>
```

The function:

1. **Parses the query DSL** to extract explicit context keys
2. **If explicit context keys present**: compute signature with those keys (single result)
3. **If no explicit context keys (uncontexted query)**:
   a. Look at what data actually exists in the parameter file (cached values)
   b. Determine the stored slice shapes (single-key vs multi-key)
   c. For **single-key slices**: use `selectImplicitUncontextedSliceSetSync` to pick one MECE dim → compute signature with that one key
   d. For **multi-key slices**: all dims must be MECE → compute signature with all keys in the cross-product
   e. For **mixed**: evaluate both routes independently, pick by freshness/coverage
   f. Return the signature(s) that match stored data

4. **The `@` menu** calls this function per edge, gets back the signature(s) that actually match stored snapshots, then queries the DB with those hashes.

### 5.3 Fixing `selectImplicitUncontextedSliceSetSync`

The line 95 filter (`context.length !== 1 → reject`) must be relaxed to support multi-key slices:

- **Group multi-key slices** by their key-set (e.g., all slices with `{channel, geo}`)
- **Verify ALL keys in the set are MECE** 
- **Verify cross-product completeness** (all cells present)
- **Treat the entire key-set as one aggregation candidate**, competing with single-key candidates on freshness/coverage

This generalises the existing logic: a single-key MECE partition is just a special case of a multi-key MECE cross-product where the key-set has cardinality 1.

### 5.4 Fixing `@` menu signature lookup

Replace `resolveContextKeys` (the broken fallback to `dataInterestsDSL`) with a call to `resolveEffectiveSignatures`. The `@` menu then queries the DB using the returned hash(es), potentially unioning results across multiple signatures if the function returns multiple candidates.

This guarantees parity with the fetch path because `resolveEffectiveSignatures` examines what was actually stored, not what the graph's DSL says should theoretically exist.

---

## 6. Test Plan

### 6.1 Logic tests (condition matrix coverage)

Each test loads real context definitions, constructs parameter values with specific slice shapes, and verifies the aggregation function produces correct results.

**Single-key stored slices (semicolon pattern):**

| Test | Stored slices | Query | MECE status | Expected |
|------|--------------|-------|-------------|----------|
| L1 | `a:v1, a:v2` | uncontexted | a=MECE | Aggregate over a |
| L2 | `a:v1, a:v2, b:w1, b:w2` | uncontexted | a=MECE, b=MECE | Pick one (freshest), aggregate |
| L3 | `a:v1, a:v2, b:w1, b:w2` | uncontexted | a=MECE, b=non-MECE | Pick a, aggregate |
| L4 | `a:v1, a:v2, b:w1, b:w2` | uncontexted | a=non-MECE, b=non-MECE | `not_resolvable` |
| L5 | `a:v1, a:v2, b:w1, b:w2, c:x1, c:x2` | uncontexted | all MECE | Pick one of three |
| L6 | `a:v1, a:v2` | `context(a:v1)` | — | Direct match |
| L7 | `a:v1, a:v2, b:w1` | uncontexted | a=MECE, b=MECE but incomplete | Pick a (complete), not b |

**Multi-key stored slices (dot-product pattern):**

| Test | Stored slices | Query | MECE status | Expected |
|------|--------------|-------|-------------|----------|
| L8 | `a:v1.b:w1, a:v1.b:w2, a:v2.b:w1, a:v2.b:w2` | uncontexted | a=MECE, b=MECE | Aggregate ALL 4 slices |
| L9 | `a:v1.b:w1, a:v1.b:w2, a:v2.b:w1, a:v2.b:w2` | `context(a:v1)` | b=MECE | Aggregate `a:v1.b:w1` + `a:v1.b:w2` |
| L10 | `a:v1.b:w1, a:v1.b:w2, a:v2.b:w1, a:v2.b:w2` | `context(b:w1)` | a=MECE | Aggregate `a:v1.b:w1` + `a:v2.b:w1` |
| L11 | `a:v1.b:w1, a:v1.b:w2, a:v2.b:w1, a:v2.b:w2` | uncontexted | a=MECE, b=non-MECE | `not_resolvable` (cross-product doesn't partition) |
| L12 | `a:v1.b:w1, a:v1.b:w2, a:v2.b:w1` (missing cell) | uncontexted | a=MECE, b=MECE | `not_resolvable` (incomplete cross-product) |
| L13 | `a:v1.b:w1, a:v1.b:w2, a:v2.b:w1, a:v2.b:w2` | `context(a:v1)` | b=non-MECE | Cannot aggregate over b |
| L14 | `a:v1.b:w1.c:x1, ...` (3-key cross-product) | uncontexted | all MECE | Aggregate all N*M*P slices |

**Mixed stored slices (semicolon+dot pattern):**

| Test | Stored slices | Query | MECE status | Expected |
|------|--------------|-------|-------------|----------|
| L15 | `a:v1.b:w1, a:v1.b:w2, a:v2.b:w1, a:v2.b:w2, c:x1, c:x2` | uncontexted | all MECE | Pick cross-product(a,b) route OR single-key(c) route — whichever fresher. NOT both. |
| L16 | `a:v1.b:w1, ..., c:x1, c:x2` | `context(a:v1)` | b=MECE | Aggregate over b for a=v1. Ignore c slices. |
| L17 | `a:v1.b:w1, ..., c:x1, c:x2` | `context(c:x1)` | — | Direct match on c:x1. Ignore (a,b) slices. |

**Edge cases:**

| Test | Scenario | Expected |
|------|----------|----------|
| L18 | `context(a).context(a)` in DSL (duplicate key) | Should deduplicate — treat as single `context(a)` |
| L19 | Context definition not loaded for one dim | Fail-safe: that dim is non-MECE → cannot aggregate over it |
| L20 | All slices have same dates (alignable) vs mismatched dates | Aligned: aggregate. Mismatched: reject with diagnostic. |

### 6.2 `@` menu integration tests

| Test | Graph | DSL | Expected |
|------|-------|-----|----------|
| A1 | li-cohort-segmentation-v2 (3 semicolon contexts) | `cohort(15-Mar-26:30-Mar-26)` (uncontexted) | `@` menu shows snapshot days matching stored data |
| A2 | li-cohort-segmentation-v2 | `context(channel:paid-search).cohort(15-Mar-26:30-Mar-26)` | `@` menu shows days for channel-keyed snapshots |
| A3 | gm-rebuild-jan-26 (no contexts) | `cohort(15-Mar-26:30-Mar-26)` | `@` menu shows days (baseline, should continue working) |
| A4 | Hypothetical dot-product graph | uncontexted | `@` menu shows days from cross-product aggregated snapshots |
| A5 | Per-edge vs batched parity | both graphs | Batched path produces identical results to per-edge path |

### 6.3 Signature parity tests

| Test | Scenario | Expected |
|------|----------|----------|
| S1 | Compute signature via `resolveEffectiveSignatures` for a li-v2 edge | Hash matches what's in the snapshot DB |
| S2 | Compute signature via write path (getFromSourceDirect) for same edge | Same hash as S1 |
| S3 | Repeat for gm edge | Hashes match |
| S4 | Repeat for hypothetical dot-product edge | Hashes match |

---

## 7. Implementation Order

1. **Write tests L1-L7** (single-key cases) — confirm existing logic passes
2. **Write tests L8-L14** (multi-key cases) — confirm failures where expected
3. **Generalise `selectImplicitUncontextedSliceSetSync`** to handle multi-key slices (fix G2)
4. **Write tests L15-L20** (mixed + edge cases) — confirm generalised logic
5. **Implement `resolveEffectiveSignatures`** as the single codepath (fix G4)
6. **Rewire `@` menu** to use `resolveEffectiveSignatures` (fix G1)
7. **Write tests A1-A5 and S1-S4** — confirm end-to-end
8. **Rewire other call sites** (planner, integrity, commit guard) to use same function where applicable
