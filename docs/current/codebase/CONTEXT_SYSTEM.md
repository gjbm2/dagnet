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

## Key Files

| File | Role |
|------|------|
| `src/services/contextRegistry.ts` | Context loading and workspace-scoped caching |
| `src/services/contextAggregationService.ts` | 2D grid aggregation, MECE handling |
| `src/services/sheetsContextFallback.ts` | Uncontexted fallback policy |
