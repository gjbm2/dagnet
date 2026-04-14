# Hash and Signature Infrastructure

How DagNet content-addresses query semantics, tracks hash discontinuities, and prevents data loss during event/context renames.

**See also**: `SNAPSHOT_DB_SIGNATURES.md` (deep-dive on layer 2+3: the signature registry and equivalence links for archival resilience)

## Overview

The hash/signature system ensures that snapshot data keyed by query semantics remains discoverable even when event or context definitions change. It has five layers:

1. **Core hash**: deterministic content-addressing of query inputs
2. **Structured signatures**: two-dimensional matching (core + context)
3. **Hash mappings**: rename resilience via equivalence links
4. **Hash chain tracing**: reachability validation for historical data
5. **Commit hash guard**: detection of hash-breaking changes at commit time

---

## ⚠ Naming Disambiguation: Two Different "Core Hashes"

The codebase previously used `coreHash` / `core_hash` for two **different values**. To disambiguate, the inner hash is now called `identityHash`.

| Name in code | What it is | Length | Computed from | Where it lives |
|---|---|---|---|---|
| `identityHash` (TS field) / `c` (JSON key) | SHA-256 hex of **non-context** semantic inputs only | ~64 chars hex | connection + event IDs + event def hashes + filters + cases + cohort_mode + latency config + normalised query | Inside the structured signature JSON `{"c":"...","x":{...}}` |
| `core_hash` (DB column) / `coreHash` (DB-level local vars) | Truncated SHA-256 of the **full structured signature** (both `c` and `x`) | ~22 chars base64url | `computeShortCoreHash(serialiseSignature({identityHash, contextDefHashes}))` | `snapshots` table PK, `signature_registry` PK, API requests/responses |

**Key consequence**: changing a context definition changes `core_hash` (DB) but NOT `identityHash` (inner). Changing an event definition changes both.

---

## Hash Lifecycle Walkthrough

End-to-end trace of how a hash is born, stored, and matched. Read this first if you're new to the system.

### 1. Signature computation (write path)

```
Edge query string ("from(A).to(B).context(channel:paid-search).cohort(-100d:)")
    │
    ▼
computeQuerySignature()  [querySignature.ts]
    │
    ├─► Parses DSL, resolves node IDs → event IDs
    ├─► Strips context(...) and window/cohort bounds from query string
    ├─► Hashes event definitions (provider_event_names, amplitude_filters)
    ├─► Builds coreCanonical JSON object (all non-context inputs)
    ├─► SHA-256 hex of coreCanonical → identityHash  (~64 chars)
    ├─► Loads context definitions from contextRegistry
    ├─► Normalises + SHA-256 hex each definition → contextDefHashes
    │
    ▼
serialiseSignature({identityHash, contextDefHashes})  [signatureMatchingService.ts]
    │
    ▼
Canonical JSON string: '{"c":"<64-char-hex>","x":{"channel":"<64-char-hex>"}}'
    │
    ▼
computeShortCoreHash(canonicalJSON)  [coreHashService.ts]
    │
    ├─► SHA-256 of UTF-8 bytes
    ├─► Truncate to first 16 bytes (128 bits)
    ├─► base64url encode, no padding
    │
    ▼
core_hash  (~22 chars, e.g. "aBcDeFgHiJkLmNoPqRsT-_")
    │
    ▼
Sent to Python backend in append_snapshots() request
    │
    ▼
Stored in snapshots table PK: (param_id, core_hash, slice_key, anchor_day, retrieved_at)
```

### 2. Signature lookup (read path)

```
UI requests snapshot data for an edge
    │
    ▼
computePlausibleSignaturesForEdge()  [snapshotRetrievalsService.ts]
    │
    ├─► Enumerates context key-sets from STORED slice topology (not graph config!)
    ├─► Computes a signature for each plausible key-set
    ├─► computeShortCoreHash() on each → set of plausible core_hashes
    │
    ▼
hashMappingsService.getClosureSet()  [hashMappingsService.ts]
    │
    ├─► Expands each core_hash via equivalence links (BFS, transitive closure)
    │
    ▼
Backend query with WHERE core_hash = ANY(%s)
    │
    ├─► Also expands via signature_equivalence recursive CTE (DB-side)
    │
    ▼
Rows returned, filtered by slice_key for context-value-specific views
```

### 3. Cache matching (in-memory)

```
signatureCanSatisfy(cacheSig, querySig)  [signatureMatchingService.ts]
    │
    ├─► identityHash must match exactly
    ├─► Every context key in query must exist in cache with matching def hash
    ├─► Cache may have EXTRA context keys (superset OK)
    │
    ▼
Compatible: true/false (+ reason if false)
```

---

## Core Hash

**Location**: `coreHashService.ts`

Produces a stable, reproducible hash of query semantic inputs:
- Algorithm: SHA-256 --> truncate to first 16 bytes --> base64url encode (no padding) --> ~22 character string
- Input: canonical signature string (e.g. `'{"c":"...","x":{...}}'`)
- Must match Python backend's `short_core_hash_from_canonical_signature` exactly
- Runtime-portable: detects `crypto.subtle`, Node.js `crypto`, or pure-JS fallback

## Structured Signatures

**Location**: `signatureMatchingService.ts`

Splits query identity into two independent components:

```
{
  identityHash: "...",           // Hash of non-context semantics
  contextDefHashes: {           // Per-context-key definition hash
    "dimension_key": "hash1",
    "segmentation_key": "hash2"
  }
}
```

### Matching rules

- Core hash: **exact match required**
- Context keys: query's context keys must be **present in cache with matching hashes**
- Cache may have **extra context keys** (superset is acceptable) -- enables reuse of multi-context slices for single-context queries
- Fail-safe: hashes of `'missing'` or `'error'` reject matching

This solved the bug where uncontexted queries rejected contexted MECE cache slices.

### What is and is not in the hash

The `core_hash` stored in the snapshots table is
`computeShortCoreHash(serialiseSignature({identityHash, contextDefHashes}))` —
a hash of the full structured signature including both `c` and `x`.

**Included in `c` (core)**: connection name, from/to event IDs, event
definition hashes, event filters, case constraints, `cohort_mode`
flag, cohort anchor event ID, latency config, normalised query
string (with context and date clauses stripped).

**Included in `x` (context definitions)**: a hash of each context
**definition** YAML file, keyed by context key name. This is the
hash of the MECE value list, not the specific value.

**NOT included**: context values (`channel:google` vs
`channel:meta` produce the same hash), date bounds (`window(-90d:)`
vs `window(-30d:)` produce the same hash). These are carried in
the `slice_key` column, not in `core_hash`.

Consequences for snapshot reads:
- All values within one MECE dimension share one `core_hash`.
  Querying by `core_hash` returns rows for ALL values.
- Different context dimensions produce different `core_hash` values.
- Window and cohort mode produce different `core_hash` values.
- Uncontexted (`x: {}`) is a different hash from any contexted
  variant.

### Two-level filtering for context-specific views

Any UI that needs to show snapshots for a specific context value
(e.g. the evidence tab's context dropdown) must filter at **both**
levels:

1. **Hash level** (dimension): select the correct `core_hash` family.
   `computePlausibleSignaturesForEdge` enumerates key-sets from the
   DSL's context clauses — passing `context(channel:paid-search)`
   produces only the channel-contexted hash.

2. **Slice level** (value): filter within the hash family by
   `slice_key`. `buildSnapshotRetrievalsQueryForEdge` constructs a
   `slice_keys` array by matching stored slices whose
   `extractSliceDimensions` equals the DSL's context dimensions.
   `querySnapshotRetrievals` passes this to the backend.

Hash-only filtering returns all values within the dimension.
Slice-only filtering without the correct hash might match rows
from the wrong family. Both are needed. See anti-pattern 27 in
`KNOWN_ANTI_PATTERNS.md`.

### Regime selection

When a graph's pinned DSL has multiple independent MECE context
dimensions (e.g. `context(channel);context(device)`), each
dimension produces a different `core_hash`. Both dimensions' rows
represent the same underlying conversions sliced differently.
Summing across dimensions double-counts.

`snapshot_regime_selection.py` provides `select_regime_rows()` which
picks one hash per `retrieved_at` date from an ordered candidate
list. The BE applies this after querying the snapshot DB and before
passing rows to derivation functions. See
`docs/current/project-bayes/30-snapshot-regime-selection-contract.md`
for the full design.

## Hash Mappings

**Location**: `hashMappingsService.ts`

Bridges hash discontinuities caused by definition changes.

### File: `hash-mappings.json`

```json
{
  "version": 1,
  "mappings": [
    {
      "core_hash": "old_hash",
      "equivalent_to": "new_hash",
      "operation": "equivalent",
      "weight": 1,
      "reason": "event renamed from Signup to SignupEvent",
      "created_by": "user@example.com"
    }
  ]
}
```

### Closure algorithm

- Only `operation: 'equivalent'` rows participate
- Edges are undirected (A-->B and B-->A are equivalent)
- BFS builds transitive closure from a seed hash
- Cycle-safe via visited set
- Deterministic: sorted alphabetically

## Hash Chain Tracing

**Location**: `hashChainService.ts`

Validates whether historical parameter data remains reachable:

### Input

- Current computed core_hash (from up-to-date definitions)
- Parameter's stored values (each with `query_signature` + date range)
- Hash mappings (equivalence links)

### Output

```
{
  currentHash: "...",
  epochs: [
    { coreHash: "hash1", earliestDate, latestDate, reachable: true },
    { coreHash: "hash2", earliestDate, latestDate, reachable: false }
  ],
  chainIntact: boolean,
  earliestReachableDate, earliestBreakDate, breakAgeDays
}
```

Chain breaks occur when a parameter's stored values use an old core_hash with no mapping connecting it to the current hash. Historical snapshot data with that hash becomes unreachable.

## Commit Hash Guard

**Location**: `commitHashGuardService.ts`

Detects hash-breaking changes at commit time:

1. Identify event/context files in commit changeset
2. Load old versions from git HEAD
3. Find affected parameters by tracing reverse dependencies (event --> node --> edge)
4. Compute old vs new core hashes
5. Only include if hash actually changed
6. Output structured tree: changed file --> graph --> parameter, with old/new hash pairs

### Key behaviour

- Only tracks parameters that have previously been fetched (no stored `query_signature` = skip)
- No-op for new files (no old version = no old hash to preserve)
- Ready to feed into mapping creation workflow

## How They Work Together

**Scenario: event renamed**

1. **Commit time**: hash guard detects event change, finds affected parameters, computes old/new hash pairs
2. **User accepts mapping**: creates entry in `hash-mappings.json` linking old to new hash
3. **Future queries**: hash chain tracer builds closure from new hash, finds old snapshots via equivalence, historical data remains accessible

## Signature Policy

**Location**: `signaturePolicyService.ts`

- `SIGNATURE_CHECKING_ENABLED = true` (since 29-Jan-26): cache matching uses structured signatures
- `SIGNATURE_WRITING_ENABLED = true`: new queries compute and store structured signatures

## Key Files

| File | Role |
|------|------|
| `src/services/coreHashService.ts` | SHA-256 content-addressing |
| `src/services/signatureMatchingService.ts` | Two-dimensional cache matching |
| `src/services/hashMappingsService.ts` | Equivalence links for rename resilience |
| `src/services/hashChainService.ts` | Reachability validation |
| `src/services/commitHashGuardService.ts` | Commit-time detection |
| `src/services/signaturePolicyService.ts` | Feature flags |
| `src/lib/stableSignature.ts` | Canonical signature construction |
| `src/services/integrityCheckService.ts` | Phase 9 (hash continuity) + Phase 10 (snapshot DB coverage) |
| `src/services/snapshotRetrievalsService.ts` | `computePlausibleSignaturesForEdge` — epoch-aware hash enumeration |
| `src/services/candidateRegimeService.ts` | `buildCandidateRegimesByEdge`, `computeMeceDimensions` — FE candidate construction for regime selection |
| `lib/snapshot_regime_selection.py` | `select_regime_rows`, `validate_mece_for_aggregation` — BE regime selection utility |

## Integrity Checks

Two integrity service phases validate hash infrastructure health:

### Phase 9: Hash Continuity (local, runs on every check)

Validates that hash-mappings.json is structurally correct and that the full hash chain is intact for every parameter. For each fetchable edge: computes the current core_hash from live event/context definitions, traces through equivalence closures via `hashChainService`, and reports breaks with severity based on age. Issues appear under the `hash-continuity` category (🔑).

### Phase 10: Snapshot DB Coverage (deep only, requires Python server)

Validates that snapshots actually exist in the DB for each fetchable edge. For each edge: computes all plausible hashes via `computePlausibleSignaturesForEdge` (handles epoch variants from different `dataInterestsDSL` regimes), builds equivalence closures for each, and issues a single batched `getBatchRetrievals` call. Edges with zero snapshots under any plausible hash are reported under `snapshot-coverage` (📡).

This phase only runs on manual "Check Integrity" (File Menu) or the Refresh button in the Graph Issues panel — not on the auto-debounced background checks triggered by file changes.

## CLI / Node.js context

The CLI tools (`dagnet-cli bayes`, `dagnet-cli analyse`, `test_harness.py`
via `compute_snapshot_subjects.mjs`) compute hashes in a Node.js process
rather than the browser. The hash computation code is shared — the same
`computeQuerySignature` and `computeShortCoreHash` functions run in both
contexts. However, the **data loading path** differs:

- **Browser**: YAML-sourced data enters via IDB, where values are stored
  as serialised JSON. Date strings remain strings. Objects pass through
  `structuredClone` on IDB write/read, which strips prototype chains.

- **CLI**: YAML files are loaded from disk by `js-yaml`. By default,
  js-yaml's `DEFAULT_SCHEMA` converts ISO date strings to native `Date`
  objects. This breaks `normalizeObjectKeys` in `querySignature.ts`,
  which treats `Date` as a plain object (empty keys), producing a
  different canonical JSON and therefore a different hash.

**Fix**: the CLI disk loader (`src/cli/diskLoader.ts`) uses
`YAML.load(raw, { schema: YAML.JSON_SCHEMA })` to prevent type
coercion. This keeps all scalars as strings, matching the browser's
IDB-serialised representation.

**See also**: anti-pattern 23 in `KNOWN_ANTI_PATTERNS.md`.

---

## Hash Inputs Reference

Exact fields that enter `coreCanonical` in `computeQuerySignature()` ([querySignature.ts](graph-editor/src/services/dataOperations/querySignature.ts)). If a field is missing or wrong, the hash changes and snapshot lookups fail silently.

| `coreCanonical` field | Source | Varies by context? | Varies by date? |
|---|---|---|---|
| `connection` | `connectionName` arg | No | No |
| `from_event_id` | Graph node lookup via parsed DSL `.from` | No | No |
| `to_event_id` | Graph node lookup via parsed DSL `.to` | No | No |
| `visited_event_ids` | Graph node lookup via parsed DSL `.visited` (sorted) | No | No |
| `exclude_event_ids` | Graph node lookup via parsed DSL `.exclude` (sorted) | No | No |
| `event_def_hashes` | SHA-256 of `{id, provider_event_names, amplitude_filters}` per event | No | No |
| `event_filters` | `queryPayload.event_filters` | No | No |
| `case` | `queryPayload.case` (sorted) | No | No |
| `cohort_mode` | `!!queryPayload.cohort` | No | No |
| `cohort_anchor_event_id` | `queryPayload.cohort.anchor_event_id` | No | No |
| `latency_parameter` | `edge.p.latency.latency_parameter === true` | No | No |
| `latency_anchor_event_id` | Resolved from `edge.p.latency.anchor_node_id` → event_id | No | No |
| `original_query` | Edge query with context/window/cohort clauses stripped, node IDs → event IDs | No | No |

**NOT in coreCanonical** (these vary per slice, carried in `slice_key` or `anchor_day`):
- Context values (`channel:paid-search`)
- Date bounds (`window(-90d:)`)
- `retrieved_at` timestamp

**In `x` (contextDefHashes), NOT in `c`**:
- Per-context-key SHA-256 of the full normalised context definition YAML (values list, metadata, otherPolicy)

---

## Common Hash Failures (Anti-Pattern Cross-Reference)

When debugging hash mismatches, check these known failure patterns first:

| Anti-pattern | One-line summary | Key symptom |
|---|---|---|
| **AP 11** — Signatures from graph config | Read path uses `dataInterestsDSL` instead of stored slice topology → wrong context keys → wrong hash | "No data" despite data existing in DB |
| **AP 23** — js-yaml Date conversion | `js-yaml` default schema converts ISO dates to `Date` objects → different canonical JSON → different hash | CLI computes different `core_hash` from browser for same graph |
| **AP 27** — Confusing hash vs value filtering | Context *dimension* changes the hash; context *value* is in `slice_key`. Both levels must be filtered. | Wrong context slices returned, or all values mixed together |
| **AP 28** — Duplicate hash computation codepaths | Multiple independent hash implementations diverge over time → different hashes for same input | Freshly written snapshots not found on read |

**The canonical hash computation path is**: `computeQuerySignature()` in `querySignature.ts` → `serialiseSignature()` → `computeShortCoreHash()`. All other paths (CLI, synth_gen, test harness) must call the CLI which uses this real FE code. Never hand-roll a parallel implementation.

---

## `stableSignature.ts` — NOT Part of This System

[stableSignature.ts](graph-editor/src/lib/stableSignature.ts) provides `stableStringify()` and `fnv1a32()` — a non-cryptographic FNV-1a hash used for **staleness signatures** (chart dependency stamps). It has nothing to do with snapshot DB hashing, query signatures, or `core_hash`. Do not confuse the two systems.
