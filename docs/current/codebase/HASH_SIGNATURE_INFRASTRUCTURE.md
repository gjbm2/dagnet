# Hash and Signature Infrastructure

How DagNet content-addresses query semantics, tracks hash discontinuities, and prevents data loss during event/context renames.

## Overview

The hash/signature system ensures that snapshot data keyed by query semantics remains discoverable even when event or context definitions change. It has five layers:

1. **Core hash**: deterministic content-addressing of query inputs
2. **Structured signatures**: two-dimensional matching (core + context)
3. **Hash mappings**: rename resilience via equivalence links
4. **Hash chain tracing**: reachability validation for historical data
5. **Commit hash guard**: detection of hash-breaking changes at commit time

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
  coreHash: "...",              // Hash of non-context semantics
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

## Integrity Checks

Two integrity service phases validate hash infrastructure health:

### Phase 9: Hash Continuity (local, runs on every check)

Validates that hash-mappings.json is structurally correct and that the full hash chain is intact for every parameter. For each fetchable edge: computes the current core_hash from live event/context definitions, traces through equivalence closures via `hashChainService`, and reports breaks with severity based on age. Issues appear under the `hash-continuity` category (🔑).

### Phase 10: Snapshot DB Coverage (deep only, requires Python server)

Validates that snapshots actually exist in the DB for each fetchable edge. For each edge: computes all plausible hashes via `computePlausibleSignaturesForEdge` (handles epoch variants from different `dataInterestsDSL` regimes), builds equivalence closures for each, and issues a single batched `getBatchRetrievals` call. Edges with zero snapshots under any plausible hash are reported under `snapshot-coverage` (📡).

This phase only runs on manual "Check Integrity" (File Menu) or the Refresh button in the Graph Issues panel — not on the auto-debounced background checks triggered by file changes.
