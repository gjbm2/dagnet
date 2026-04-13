# 33 — Snapshot query batching

**Status**: Open
**Date**: 9-Apr-26
**Discovered during**: Binding receipt regression run (doc 14 §16)
**Affects**: Bayes worker, analysis preparation, retrieve-all

---

## 1. Problem

`_query_snapshot_subjects()` in `bayes/worker.py` makes **one DB
round-trip per snapshot subject**. Each subject calls
`snapshot_service.query_snapshots_for_sweep()` independently.

For a graph with N parameterised edges and a pinnedDSL that
produces 2 slices (window + cohort), this is 2N separate queries.
For `li-cohort-segmentation-v2` (31 parameterised edges), this is
62 individual `SELECT ... FROM snapshots WHERE core_hash = ANY(...)`
queries executed sequentially.

Each query has:
- Connection acquisition from pool (~1-5ms)
- Query planning (~1ms)
- Index scan on `core_hash` (fast per query, but repeated)
- Result serialisation and transfer
- Python dict construction per row

The overhead is dominated by round-trip latency, not query
execution. On a remote DB (Neon), each round-trip adds 20-50ms
of network latency. 62 queries × 30ms = ~2 seconds of pure
network wait, before any data processing.

## 2. Scope

This is not specific to the binding receipt. The receipt exposed
the cost by running preflight against many graphs in sequence, but
the per-subject query pattern is used by every Bayes fit.

The same pattern exists in the FE analysis preparation path
(`analysisComputePreparationService.ts` → snapshot subject
resolution), though the FE uses `getBatchRetrievals` which already
batches. The Bayes worker does not use the batch path.

## 3. What a fix looks like

All subjects in a single Bayes fit share the same pinnedDSL, which
means the same anchor range, sweep range, and slice_keys. The only
thing that varies per subject is the core_hash (plus its equivalent
hashes).

So the fix is: collect the union of all core_hashes (primary +
equivalents) across all subjects, issue **one query**, and group
the results by core_hash in Python.

New function in `snapshot_service.py`:

```
query_snapshots_batch(
    core_hashes: list[str],
    slice_keys: list[str],
    anchor_from: date,
    anchor_to: date,
    sweep_from: date,
    sweep_to: date,
    limit: int = 50000,
) -> dict[str, list[dict]]
    # Returns rows grouped by core_hash
```

The caller (`_query_snapshot_subjects`) builds the hash union,
calls this once, and distributes results back to each subject by
core_hash lookup. Subjects with no matching rows get an empty list.

Skip the per-subject cache for the batch path — one query is
already fast enough that caching adds complexity without benefit.

## 4. Expected improvement

| Graph | Subjects | Current queries | Batched queries | Estimated savings |
|---|---|---|---|---|
| synth-simple (2 edges) | 4 | 4 | 1 | ~90ms |
| gm-rebuild (4 edges) | 8 | 8 | 1 | ~200ms |
| li-cohort-seg-v2 (31 edges) | 62 | 62 | 1-2 | ~1.8s |
| Future large graphs (50+ edges) | 100+ | 100+ | 1-3 | ~3s+ |

The savings scale linearly with edge count. For small graphs the
absolute saving is negligible. For large contexted graphs (the
Phase C target), it becomes material.

## 5. Priority

Medium. The current per-subject path works correctly — it's slow,
not wrong. The receipt regression run took ~3 minutes for 13
graphs, most of which was DB query time. For single-graph
preflight during dev, the wait is tolerable (~5s). For batch
regression runs and production Bayes fits on large graphs, the
overhead is worth fixing.

Not blocking for data binding assurance (doc 14 §16). Should be
done before intensive Phase C model work on large contexted graphs.
