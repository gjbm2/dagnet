# Context System

How DagNet registers, aggregates, and applies categorical dimensions (contexts) for segmented data retrieval.

## What Contexts Are

Contexts are metadata-rich categorical/ordinal/continuous dimensions (e.g. `channel:paid-search`) used to segment parameter data. Each context has values, aliases, source mappings (field extraction rules), and metadata.

## Registration

**Location**: `contextRegistry.ts`

- Loads contexts from workspace files (FileRegistry --> IndexedDB)
- Workspace-scoped, never external
- Cache key: `repo/branch:contextId` to avoid collision
- Critical constraint: production must never consult an external "param registry" source of truth

## Aggregation

**Location**: `contextAggregationService.ts`

Implements 2D grid aggregation (context x date) for contexted parameters:
- Handles MECE aggregation (mutually exclusive, collectively exhaustive)
- Generates subqueries for each context slice
- Critical deduplication: when multiple parameter values have overlapping dates, merges daily data and sums merged totals -- **never sums entry-level n/k directly** (which would double-count)

## Sheets Fallback

**Location**: `sheetsContextFallback.ts`

Handles fallback from contexted HRNs to uncontexted when data is missing:
- Try exact match first
- Fall back to uncontexted if allowed
- UI warnings on fallback usage

## MECE Partition Selection

**Location**: `meceSliceService.ts`

When a query is uncontexted but stored data has contexted slices, the system selects one MECE partition to aggregate:

- **Single-key slices** (from semicolon DSL patterns like `context(a);context(b)`): grouped by context key, MECE status checked per key, freshest complete partition wins
- **Multi-key slices** (from dot-product DSL patterns like `context(a).context(b)`): grouped by key-set, ALL keys in the set must be individually MECE AND the cross-product must be fully populated
- **Mixed**: single-key and multi-key candidates compete on the same freshness/coverage basis

Key function: `selectImplicitUncontextedSliceSetSync` in `meceSliceService.ts`. Callers: `fetchPlanBuilderService.ts` (staleness), `fileToGraphSync.ts` (read-back), `windowAggregationService.ts` (display), `snapshotRetrievalsService.ts` (@ menu hash selection).

See `docs/current/project-contexts/mece-context-aggregation-design.md` for the complete condition matrix.

## Snapshot Epoch Spanning

When the graph's `dataInterestsDSL` changes over time (e.g., from uncontexted to contexted fetching), snapshots are stored under different hashes for different time periods. The @ menu and snapshot retrieval system queries across ALL plausible hashes simultaneously to find snapshots from every epoch.

This does NOT use `dataInterestsDSL` directly — it enumerates plausible context key-sets from the stored parameter file's `values[].sliceDSL` topology. See `docs/current/project-contexts/snapshot-epoch-resolution-design.md`.

## Key Files

| File | Role |
|------|------|
| `src/services/contextRegistry.ts` | Context loading and workspace-scoped caching |
| `src/services/contextAggregationService.ts` | 2D grid aggregation, MECE handling |
| `src/services/meceSliceService.ts` | MECE partition selection (single-key and multi-key) |
| `src/services/dimensionalReductionService.ts` | Multi-key → fewer-key aggregation with MECE verification |
| `src/services/sliceIsolation.ts` | Slice dimension extraction, context matching |
| `src/services/snapshotRetrievalsService.ts` | @ menu epoch-spanning snapshot queries |
| `src/services/sheetsContextFallback.ts` | Uncontexted fallback policy |
