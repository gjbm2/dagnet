# Proposal: Declarative Field Mastering for Graph/File Config

**Status**: Proposal
**Date**: 18-Mar-26
**Context**: Fix for latency_parameter drift bug (retrieveAll not returning lag data)

## The Problem

DagNet has two representations of parameter config: the graph edge (in-memory, the primary editing surface) and the parameter file (persistent, enables versioned/async workflows). Parameter files are optional — the graph works without them — but when present, they must not silently contradict the graph in ways that break downstream operations.

Today there is no general mechanism ensuring consistency. Each field handles sync ad hoc:

- `connection`: hardcoded in `selectPersistedProbabilityConfig` to always read from graph
- `anchor_node_id`: excluded from file-to-graph mappings by comment convention
- `query`/`n_query`: cascaded on topology change via bespoke functions in `queryRegenerationService`
- `latency_parameter`: drifted silently until a point fix added a lazy merge in `mergeLatencyConfig`
- Everything else: drifts until explicit "Put to File"

The consequence: when a developer adds a new field to the shared config surface, there is no structural prompt to declare how it should behave. It silently inherits the default (drift until PUT), and the bug only surfaces when someone hits a code path that reads from the wrong source.

## Two Halves of the Same Problem

`mappingConfigurations.ts` already declares field relationships — source field, target field, override flag, sync direction. This governs **write-time sync** (UpdateManager operations).

`selectPersistedProbabilityConfig` separately decides **read-time config selection** — which source to consult when both exist. This logic is hardcoded and maintained independently of the mappings.

These are two views of the same question: *who owns this field?* The mapping declarations know how to sync a field but not who owns it at read time. So `selectPersistedProbabilityConfig` re-derives ownership with bespoke code, and `mergeLatencyConfig` is yet another re-derivation.

## Proposal: Mastering Annotations on Field Mappings

Add a `mastering` annotation to each mapping entry. Three values:

| Mastering | Read-time rule | Typical fields |
|---|---|---|
| `'graph'` | Always from graph, regardless of file state | `anchor_node_id`, `connection` |
| `'file'` | Always from file in versioned mode (graph in direct mode) | `mu`, `sigma`, `posterior`, `model_trained_at` |
| `'override-gated'` | File wins if file's `_overridden` is true (file is locked); otherwise graph cascades | `latency_parameter`, `t95`, `path_t95`, `onset_delta_days`, `mean`, `stdev` |

This is not a new concept — it's the formalisation of rules that already exist implicitly in scattered code. The annotation makes them explicit, co-located with the mapping declaration, and machine-readable.

## How It Works

### Declaration

The `FieldMapping` type in `updateManager/types.ts` gains an optional field:

```
mastering?: 'graph' | 'file' | 'override-gated'
```

Each existing mapping entry is annotated. Most are already implicitly categorised:
- Entries with `overrideFlag` → `'override-gated'`
- Entries documented as graph-mastered → `'graph'`
- Entries without override and without graph-mastered documentation → `'file'`

Making this explicit is a one-time annotation pass, not a refactor.

### Resolution

A single utility function resolves any field:

```
resolveFieldValue(fileValue, graphValue, mastering, fileOverridden) →
  'graph'          → graphValue
  'file'           → fileValue
  'override-gated' → fileOverridden ? fileValue : graphValue
```

### Read-time merge (replaces bespoke merge functions)

When `selectPersistedProbabilityConfig` (or any future consumer) needs a merged config, it walks the declared mappings for the relevant config block and calls `resolveFieldValue` per field. No hardcoded field names. Adding a new field means adding one mapping entry with its mastering annotation — the merge logic never needs updating.

The current `mergeLatencyConfig` (with its hardcoded `OVERRIDE_GATED_LATENCY_PAIRS` and `GRAPH_MASTERED_LATENCY_KEYS`) becomes a thin wrapper that reads from the annotations instead.

### Write-time sync (unchanged)

UpdateManager continues to use the existing `sourceField`/`targetField`/`overrideFlag` for sync operations. The `mastering` annotation is orthogonal — direction governs sync writes, mastering governs read-time conflict resolution. Both live on the same declaration but serve independent concerns.

## What This Prevents

When a developer adds a new field (say `latency.foo`):

1. They add a mapping entry in `mappingConfigurations.ts` (they already must do this for sync to work)
2. The entry includes `mastering: 'override-gated'` (or `'graph'` or `'file'`)
3. The generic merge automatically picks up the new field at read time
4. No updates needed in `mergeLatencyConfig`, `selectPersistedProbabilityConfig`, or any other consumer

Without the annotation, the developer would need to know about every bespoke merge function and update each one. That's the knowledge gap that caused the original bug.

## Scope and Boundaries

**What this covers**: Read-time config selection for any code path that needs a merged graph+file view. Currently that's `selectPersistedProbabilityConfig` (fetch config) and potentially future consumers.

**What this doesn't cover**: The timing of when actual file writes happen. Files still won't get updated until a sync operation runs (fetch, PUT, commit). The annotations ensure that *reads* are always correct regardless of whether the file has caught up. Actual write-time cascade remains lazy by design.

**What this doesn't change**: The `_overridden` flag semantics. `_overridden` remains purely an inbound lock on the file ("don't write to me"). The mastering annotation governs who wins at read time; the override flag governs who wins at write time. They compose cleanly.

## Coupling Concern

The main risk is coupling `selectPersistedProbabilityConfig` (a lightweight pure function) to the UpdateManager mapping infrastructure (a heavier system). The annotations should be extractable as a lightweight lookup — a typed map from field path to mastering rule — that both systems can consult independently. The annotations live in `mappingConfigurations.ts` because that's where the field relationships are declared, but the resolution logic doesn't need to import UpdateManager.

## Implementation Path

1. Add `mastering` to the `FieldMapping` type
2. Annotate existing mapping entries (one-time pass — most are inferrable from existing structure)
3. Build a lightweight lookup: `getMasteringRule(direction, operation, subDest, fieldPath) → 'graph' | 'file' | 'override-gated'`
4. Rewrite `mergeLatencyConfig` to use the lookup instead of hardcoded field lists
5. Extend to non-latency config blocks if/when needed (query, connection are already handled correctly but could be unified)

Steps 1-3 are the structural investment. Step 4 is the immediate payoff. Step 5 is optional future work.
