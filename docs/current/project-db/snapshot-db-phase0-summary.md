# Iterating on a Graph: What Worked

**Date**: 12-Feb-26  
**Context**: Building out the high-intent flow graph on `feature/snapshot-db-phase0`

---

## The process

We followed a tight loop: **fetch real data → spot anomaly → diagnose → fix → fetch again**. Each cycle surfaced the next issue — event name mismatches, slice-key problems, denominator bias — and the fix was always small and obvious once the data made the problem visible.

The key insight: don't try to get the graph right by inspection. Get it roughly right, fetch, and let the data tell you what's wrong. Three to five cycles is typical for a new graph.

## What made it effective

- **Everything in one workspace** — the monorepo (for tracing production events), the DagNet codebase (for fixing tooling issues as they arose), and the data repo (the actual graph/entity files) all accessible in the same environment. When a fetch returned wrong data, we could trace from graph edge → parameter file → Amplitude event → monorepo flow config → fix, without context-switching between repos or tools.
- **Helper scripts alongside the data** — `graph-ops/` playbooks and validation scripts (`validate-graph.sh`, `validate-indexes.sh`) caught structural mistakes before they became data mysteries. Pre-flight checks before every commit meant we never wasted a fetch cycle on a malformed graph.
- **Daily fetch on the feature branch** — enabling `dailyFetch: true` before merging meant snapshot history accumulated while we iterated. By merge time, the DB already had multi-day coverage.
- **Parallel-run comparison** — running both FE and BE statistical pipelines simultaneously caught every parity defect automatically. The diagnostic output made each fix a 15-minute job.
- **The input is usually the bug** — most issues were wrong inputs to correct code (wrong anchor range, wrong slice key), not algorithmic errors. Having the full context to trace inputs end-to-end was what made diagnosis fast.

## Playbooks updated

- `graph-ops/playbooks/iterate-on-graph.md` (new) — the fetch → validate → fix cycle
- `graph-ops/playbooks/branch-workflow.md` — §5a: daily fetch before merge
