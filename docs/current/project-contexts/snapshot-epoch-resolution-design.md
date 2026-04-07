# Snapshot Epoch Resolution Design

## Problem

Over time, the hash under which snapshots are stored for a given edge changes. There are two classes of change:

### Class 1: dataInterestsDSL epoch changes

The user changes what information they retrieve daily. For example:

- **Epoch A**: uncontexted fetches → snapshots stored under hash H0 (context keys = `[]`)
- **Epoch B**: `dataInterestsDSL` adds `context(channel)` → snapshots stored under hash H1 (context keys = `['channel']`)
- **Epoch C**: `dataInterestsDSL` changes to `context(geo)` → snapshots stored under hash H2 (context keys = `['geo']`)

H0, H1, H2 are semantically different signatures. They are NOT linked by hash mappings because they represent genuinely different query structures. But for an uncontexted consumer (analysis, Bayes, @ menu), all three provide valid data for the same logical quantity.

### Class 2: channel/query definition changes

Event definitions, context definitions, or query structure changes that alter the core hash for the SAME logical query. For example, an event's Amplitude filter changes. The old and new hashes produce the same logical data but with different technical identities.

These are linked by hash mappings (`hash-mappings.json`) when the user wants to maintain data continuity. The existing equivalence closure system handles this class.

## What this affects

### 1. @ menu (snapshot calendar)

**Question**: on which days do snapshots exist for this edge?

Must query across ALL plausible hashes for the queryDSL. For an uncontexted queryDSL, plausible hashes include:
- The uncontexted hash (H0)
- Each single MECE context dim hash (H1, H2, ...)
- Each multi-key MECE cross-product hash

Per edge per day: boolean — any hit from any hash = day is covered. No double-counting.

### 2. Virtual snapshot query (`asat()` DSL)

**Question**: what did the data look like on date D?

For a given `asat(5-Apr-26)`, the system must find the best available snapshot for that date. If date D falls in epoch B, the snapshot is stored under H1. If it falls in epoch A, under H0.

The virtual snapshot query currently takes a single `core_hash`. It needs to accept **multiple candidate hashes** and, for the requested date, pick the snapshot from whichever hash has data.

Priority when multiple hashes have data for the same date: latest `retrieved_at` wins (most recent fetch is freshest).

### 3. Analysis pipeline

Consumes virtual snapshots across a date range. The date range may span multiple epochs. For example, a 90-day window starting 1-Mar might have:
- Days 1-Mar to 15-Mar: only H0 (uncontexted) snapshots exist
- Days 16-Mar to 31-Mar: H0 and H1 (channel-contexted) both exist
- Days 1-Apr to 7-Apr: only H1 exists

The analysis pipeline should stitch these together seamlessly. For each date, pick the best available snapshot from any plausible hash.

### 4. Bayes / cohort forecast

Same as analysis pipeline — consumes historical snapshots across a date range. When contexted Bayes is implemented, the hash selection becomes more constrained: a `context(channel:google)` Bayes query needs snapshots that contain channel-level data, not uncontexted aggregates. But for uncontexted Bayes, the same epoch-spanning logic applies.

### 5. Staleness / nudge system

The staleness system checks "when was this edge last fetched?" It currently looks at the most recent `retrieved_at` across all values. This doesn't need epoch-aware hash selection — it just needs the most recent timestamp from any source.

## Epoch resolution algorithm

### Inputs

1. **Edge** — identifies the parameter
2. **queryDSL** — what the consumer is asking for (uncontexted, contexted, etc.)
3. **Stored parameter values** — the `sliceDSL` topology in the parameter file
4. **Context definitions** — MECE status per context key
5. **Date range** — the dates of interest (for analysis/Bayes/asat)

### Step 1: Enumerate plausible context key-sets

From the stored parameter values, extract all distinct context key-sets:
- Parse each value's `sliceDSL` to get its context keys
- Group by key-set (e.g., `{[]}`, `{channel}`, `{geo}`, `{channel, geo}`)
- For each key-set, verify it can fulfil the queryDSL:
  - Uncontexted query: any MECE key-set works (including empty set = explicit uncontexted)
  - `context(channel:google)` query: key-set must contain `channel`, and all other keys must be MECE (for aggregation)

### Step 2: Compute signatures for each plausible key-set

For each viable key-set, compute `computeQuerySignature` with those context keys → get the hash. Also get the equivalence closure for each hash (Class 2 changes).

Result: a set of `(hash, closure)` pairs, each representing a different epoch's fetch strategy.

### Step 3: Query the snapshot DB

Pass ALL hashes (including closures) to the retrieval endpoint. The response includes `(retrieved_at, hash)` pairs.

### Step 4: Per-date resolution

For each date of interest:
- Find all snapshots on that date across all hashes
- Deduplicate: if multiple hashes have a snapshot on the same date, pick the one with the latest `retrieved_at`
- The "winning" hash for that date determines which snapshot data to use

### Step 5: Output

- **@ menu**: set of dates that have at least one snapshot (boolean per date)
- **asat() query**: the winning hash + retrieved_at for the requested date
- **Analysis/Bayes**: a sequence of (date, winning_hash, retrieved_at) tuples spanning the requested range

## Python-side changes

### `query_snapshot_retrievals` (snapshot_service.py)

Currently accepts a single `core_hash` (plus optional `equivalent_hashes` for closure).

Change: accept a **list** of `core_hash` groups, where each group is `{ core_hash, equivalent_hashes? }`. The query becomes:

```sql
WHERE core_hash = ANY(all_hashes_flattened)
```

The response remains the same shape — distinct `retrieved_at` values. The caller doesn't need to know which hash produced each result (for the @ menu, it's just "does a snapshot exist on this day?").

### `query_snapshots_virtual` (snapshot_service.py)

Currently uses a single `core_hash` to reconstruct the "latest per anchor_day" snapshot.

Change: accept multiple hash groups. The virtual snapshot query becomes:

```sql
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY anchor_day
      ORDER BY retrieved_at DESC
    ) AS rn
  FROM snapshots
  WHERE core_hash = ANY(all_hashes_flattened)
    AND retrieved_at <= %s  -- asat cutoff
)
SELECT * FROM ranked WHERE rn = 1
```

This automatically picks the freshest snapshot for each anchor_day, regardless of which hash it came from. If epoch B's contexted snapshot is fresher than epoch A's uncontexted snapshot for the same anchor_day, epoch B wins.

### `query_batch_retrievals` (snapshot_service.py)

Currently each subject has a single `core_hash` + optional `equivalent_hashes`.

Change: each subject gains a `hash_groups` field — a list of `{ core_hash, equivalent_hashes? }`. The per-subject query unions all hashes from all groups:

```python
all_hashes = []
for group in subject['hash_groups']:
    all_hashes.append(group['core_hash'])
    for eq in group.get('equivalent_hashes', []):
        all_hashes.append(eq['core_hash'])
# dedupe
hashes = list(set(all_hashes))
```

### Backward compatibility

The existing single-hash API remains valid — a single `core_hash` with `equivalent_hashes` is just a single hash group. The new `hash_groups` field is additive.

## Frontend changes

### `snapshotRetrievalsService.ts`

`computeCurrentSignatureForEdge` → rename/refactor to `computePlausibleSignaturesForEdge`:
- Returns `EdgeSignatureResult[]` instead of `EdgeSignatureResult | null`
- Enumerates key-sets from stored parameter values
- Computes signature + closure for each
- Each result includes the key-set used

### `getSnapshotCoverageForEdgesBatched`

Per edge: compute all plausible signatures. Build batch retrieval subjects with `hash_groups` per edge. The coverage aggregation remains boolean per edge per day.

### `getSnapshotRetrievalsForEdge`

Same multi-hash approach for single-edge retrieval.

## Test plan

## Test plan

The two change classes (dataInterestsDSL epochs × hash mappings) create a 2D space. Tests must cover each axis independently AND their interaction.

### Test structure

One integration test file. DB seeded once in `beforeAll` using `appendSnapshots` with synthetic data under controlled hashes and dates. Each scenario is a separate `it` block querying the pre-seeded data.

Seed data uses a single synthetic param (`test-epoch-param`) with snapshots planted under known hashes on known dates.

### Axis 1: dataInterestsDSL epoch changes (no hash mappings)

| # | Scenario | Stored slices (param file) | Snapshots in DB | Query | Expected |
|---|----------|---------------------------|-----------------|-------|----------|
| E1 | **Single epoch, uncontexted** | `sliceDSL = ''` | H0 on days 1-5 | uncontexted | days 1-5 |
| E2 | **Two epochs: uncontexted → MECE channel** | `''` + `context(channel:google)` + `context(channel:meta)` | H0 on days 1-5, H1 on days 6-10 | uncontexted | days 1-10 |
| E3 | **Three epochs: uncontexted → channel → geo** | `''` + `context(channel:...)` + `context(geo:...)` | H0 on days 1-3, H1 on days 4-6, H2 on days 7-9 | uncontexted | days 1-9 |
| E4 | **Epoch regression: MECE → uncontexted** | `context(channel:...)` + `''` | H1 on days 1-5, H0 on days 6-10 | uncontexted | days 1-10 |
| E5 | **MECE to different MECE** | `context(channel:...)` + `context(geo:...)` | H1 on days 1-5, H2 on days 6-10 | uncontexted | days 1-10 |
| E6 | **Dot-product epoch** | `context(channel:...).context(geo:...)` | H_cg on days 1-5 | uncontexted | days 1-5 (if both dims MECE) |
| E7 | **Semicolon → dot-product epoch** | `context(channel:...)` + `context(channel:...).context(geo:...)` | H1 on days 1-5, H_cg on days 6-10 | uncontexted | days 1-10 |

### Axis 2: hash mappings within a single epoch

| # | Scenario | Hash mappings | Snapshots in DB | Query | Expected |
|---|----------|---------------|-----------------|-------|----------|
| M1 | **No mapping, single hash** | none | H0 on days 1-5 | uncontexted | days 1-5 |
| M2 | **Event def change mid-epoch** | H0 → H0' | H0 on days 1-3, H0' on days 4-6 | uncontexted | days 1-6 |
| M3 | **Two mappings in chain** | H0 → H0' → H0'' | H0 on days 1-2, H0' on days 3-4, H0'' on days 5-6 | uncontexted | days 1-6 |
| M4 | **Context def change (contexted hash mapping)** | H1 → H1' (both have context keys = `['channel']`) | H1 on days 1-3, H1' on days 4-6 | uncontexted | days 1-6 |

### Axis 1 × Axis 2: combined

| # | Scenario | Epochs | Hash mappings | Snapshots | Expected |
|---|----------|--------|---------------|-----------|----------|
| X1 | **Two epochs, mapping in second** | uncontexted → channel | H1 → H1' in epoch B | H0 days 1-3, H1 days 4-5, H1' days 6-7 | days 1-7 |
| X2 | **Three epochs, mapping in first** | uncontexted → channel → geo | H0 → H0' in epoch A | H0 days 1-2, H0' days 3-4, H1 days 5-6, H2 days 7-8 | days 1-8 |
| X3 | **Mapping boundary coincides with epoch boundary** | uncontexted → channel | H0 → H0' on same day epoch changes | H0 day 1-3, H0' day 3 (duplicate), H1 day 3-5 | day 3 counted once, days 1-5 total |

### Overlap and deduplication

| # | Scenario | Snapshots | Expected |
|---|----------|-----------|----------|
| O1 | **Same day, two hashes, different retrieved_at** | H0 on day 3 at 06:00, H1 on day 3 at 09:00 | day 3 counted once. Virtual snapshot picks H1 (fresher). |
| O2 | **Same day, same hash, two retrievals** | H0 on day 3 at 06:00, H0 on day 3 at 09:00 | day 3 counted once. Virtual snapshot picks 09:00. |
| O3 | **Same day, three hashes from three epochs** | H0, H1, H2 all on day 5 | day 5 counted once. |

### Query type narrowing

| # | Scenario | Stored slices | Query | Expected |
|---|----------|---------------|-------|----------|
| Q1 | **Uncontexted query, mixed epochs** | `''` + `context(channel:...)` | uncontexted | finds both epoch hashes |
| Q2 | **Contexted query, mixed epochs** | `''` + `context(channel:...)` | `context(channel:google)` | finds ONLY channel-epoch hash (H1), NOT uncontexted (H0) |
| Q3 | **Contexted query, wrong dimension** | `context(channel:...)` | `context(geo:UK)` | finds nothing — no geo data stored |
| Q4 | **Contexted query, dot-product data** | `context(channel:...).context(geo:...)` | `context(channel:google)` | finds H_cg if geo is MECE (reduces over geo) |
| Q5 | **Contexted query, dot-product, non-MECE dim** | `context(channel:...).context(source:...)` | `context(channel:google)` | finds nothing — source is not MECE, cannot reduce |

### Non-MECE rejection

| # | Scenario | Context defs | Stored slices | Query | Expected |
|---|----------|-------------|---------------|-------|----------|
| N1 | **Non-MECE dim in stored slices** | channel=MECE, source=non-MECE | `context(channel:...)` + `context(source:...)` | uncontexted | finds ONLY channel hash (MECE), ignores source |
| N2 | **All dims non-MECE** | source=non-MECE, campaign=non-MECE | `context(source:...)` + `context(campaign:...)` | uncontexted | finds nothing — no safe aggregation |
| N3 | **MECE status changes between epochs** | channel was MECE in epoch A, becomes non-MECE in epoch B (def changed) | `context(channel:...)` in both epochs | uncontexted | depends on CURRENT def — if non-MECE now, neither epoch usable |

### Adversarial edge cases

| # | Scenario | Why it's adversarial | Expected |
|---|----------|---------------------|----------|
| A1 | **Empty parameter file** | No stored values → no key-sets to enumerate | graceful empty result, no error |
| A2 | **Parameter file has values but no dates arrays** | aggregation would fail | @ menu can still show days exist; virtual snapshot may fail |
| A3 | **Hash mapping creates a cycle** | H0 → H1 → H0 | closure terminates (BFS visited set), no infinite loop |
| A4 | **Hash mapping links across epochs** | User manually links H0 (uncontexted) to H1 (channel) | closure expands to include both — works, but semantically dubious. Not our problem to prevent. |
| A5 | **Stale context definition** | Context def not loaded (e.g., fresh session, file missing) | fail-safe: treat dim as non-MECE, don't include in plausible hashes |
| A6 | **100+ hashes from many epoch changes** | Performance: flattened hash list is huge | SQL `ANY(array)` handles this; may need a practical cap (e.g., 50 hashes per subject) |
| A7 | **Identical snapshot data under two hashes** | Two different fetch strategies produced identical n/k/dates | no harm — one wins by retrieved_at, result is correct either way |
| A8 | **Hash mapping to a hash with no snapshots** | Mapping exists but target hash was never fetched | closure includes it; SQL finds nothing for it; no effect |
| A9 | **Parameter file has case() dims** | case dims should be excluded from context key-set enumeration | `isEligibleContextOnlySlice` already rejects case dims |
| A10 | **Parameter file has contextAny() slices** | contextAny is a multi-value query, not a MECE partition member | rejected by MECE selection, ignored for hash enumeration |
| A11 | **Two edges share same param but different epochs** | edge A opened graph in epoch B, edge B opened in epoch C | each edge resolves independently from the same param file — correct |
| A12 | **Concurrent fetch writes new values while @ menu reads** | param file values change mid-enumeration | eventual consistency — next @ click picks up new values |

### What's NOT tested (and why)

- **Fetch planner behaviour**: the fetch planner picks the single best current strategy. It doesn't need epoch-spanning logic because it only cares about "should I fetch now?" not "what did I fetch historically?"
- **Hash mapping creation**: creating hash mappings is a separate workflow (graph-ops). We test that existing mappings are traversed, not that they're created correctly.
- **Context definition editing**: changing a context's MECE policy is a user action. We test that the current policy is respected, not the edit flow.

## Implementation status (as of 7-Apr-26)

| # | Item | Status |
|---|------|--------|
| 1 | Python: `query_batch_retrievals` accepts `hash_groups` | DONE — `snapshot_service.py:1778` |
| 2 | Python: `query_snapshots_virtual` multi-hash support | DEFERRED — not needed until asat() consumes epoch-spanning data |
| 3 | Frontend: `computePlausibleSignaturesForEdge` (returns array) | DONE — `snapshotRetrievalsService.ts:185` |
| 4 | Frontend: `getSnapshotCoverageForEdgesBatched` uses `hash_groups` | DONE — one subject per edge with all plausible hashes |
| 5 | Frontend: `getSnapshotRetrievalsForEdge` uses `hash_groups` | DONE — single subject with all plausible hashes |
| 6 | Frontend: removed broken `resolveContextKeys` / `dataInterestsDSL` fallback | DONE — replaced with `enumeratePlausibleContextKeySets` |
| 7 | Frontend: fixed event/param file loading with `restoreFile` | DONE — uses workspace-prefixed IDB fallback |
| 8 | Frontend: `selectImplicitUncontextedSliceSetSync` multi-key support | DONE — `meceSliceService.ts` |

### Test coverage

| Suite | File | Tests | Status |
|-------|------|-------|--------|
| MECE resolution (L1-L25) | `meceContextResolution.red.test.ts` | 24 | GREEN |
| DSL explosion (sections 1-7) | `dslExplosion.test.ts` | 44 | GREEN |
| @ menu retrieval | `snapshotAtMenuRetrieval.integration.test.ts` | 8 | GREEN |
| Epoch resolution (E/M/O/A) | `snapshotEpochResolution.integration.test.ts` | 12 | GREEN |
| Query narrowing (Q/N) | `snapshotQueryNarrowing.test.ts` | 15 | GREEN |
| Existing regressions (7 suites) | various | 17 | GREEN |
| **Total** | | **120** | **GREEN** |

### Pending cleanup

- Delete `src/services/__tests__/snapshotAtMenuDiagnostic.integration.test.ts` — superseded by `snapshotAtMenuRetrieval.integration.test.ts`

### Deferred work

- **`query_snapshots_virtual` multi-hash**: needed when `asat()` DSL queries consume epoch-spanning data (e.g., Bayes consuming historical snapshots across signature changes). The current `asat()` path uses a single `core_hash`; extending it to accept `hash_groups` follows the same pattern as `query_batch_retrievals`.
- **Contexted Bayes**: a `context(channel:google)` Bayes query needs to narrow plausible key-sets to those containing `channel`. The `enumeratePlausibleContextKeySets` function already handles this (Q4 test), but the Bayes pipeline doesn't yet call it.
- **`context.asat()`**: reconstructing context definitions as they were at a historical point in time, to bridge context definition changes without hash mappings. Currently a known limitation (N3 test documents this).

## Scope boundaries

- This design does NOT change how fetching works. The fetch planner still picks the single best strategy for the current epoch.
- This design does NOT create hash mappings between epoch hashes. H0 and H1 remain unlinked — they are resolved by the multi-hash query, not by equivalence.
- Contexted Bayes (narrowing plausible key-sets for contexted queries) is a future extension that builds on this foundation but is not implemented here.
