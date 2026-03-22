# Iterate on a Graph — Fetch, Validate, Fix Playbook

How to iteratively improve a conversion graph by fetching real data, analysing results, and fixing issues in a tight loop. This playbook captures the workflow that emerged during the snapshot-db-phase0 work (Feb 2026).

**Prerequisite**: You are on a feature branch in the data repo (see [branch-workflow.md](branch-workflow.md)). The graph has been built and committed (see [build-funnel-graph.md](build-funnel-graph.md) or [create-graph.md](create-graph.md)).

---

## The Iteration Cycle

```
Build/Fix → Commit & Push → Fetch Data → Analyse → Spot Anomaly → Diagnose → Fix → Repeat
```

This cycle is the natural rhythm of graph development. Each round of real data reveals the next issue. Design docs and the graph structure evolve together with the data — not ahead of it.

---

## 1. Set Up Daily Fetch on a Feature Branch

### How daily fetch works

The `retrieveAll` automation is **workspace-scoped** — it operates on whatever `repository + branch` combination the workspace is pointed at. It does NOT hardcode `main`.

When `?retrieveall` runs in enumeration mode:

1. Reads the currently selected repo + branch from the Navigator
2. **Pulls latest** from that branch (remote-wins) — this ensures newly committed graphs are visible
3. Reloads the workspace from IndexedDB
4. Enumerates all graphs with `dailyFetch: true` scoped to that workspace
5. Processes each graph: open → retrieve all slices → commit

### Enabling daily fetch on your graph

1. Open the graph in the editor
2. Set `dailyFetch: true` on the graph (via Graph Settings or by editing the graph JSON directly)
3. Commit and push to your feature branch

Or set it directly in the graph JSON:
```json
{
  "dailyFetch": true,
  ...
}
```

### Running retrieveAll on a feature branch

**Option A — Manual run (recommended during development)**:

1. In the Navigator, select your data repo and the feature branch
2. Navigate to `?retrieveall` (or `?retrieveall=<graph-name>` for a single graph)
3. The automation will pull, fetch, and commit on your branch

**Option B — Automated overnight run**:

- Ensure the overnight automation session is pointed at your feature branch (not main)
- Or create a separate automation session for your branch

### Key points

- A graph on a feature branch **will not** be fetched by the main-branch automation
- After merging to main, the graph is automatically included in the main-branch daily run
- The pre-enumeration pull means any graph you've committed and pushed will be visible — no need to manually clone/load first

---

## 2. The Fetch → Validate → Fix Loop

### First fetch

After building the graph and creating all entity files:

1. Commit and push your branch
2. Open the graph in the editor at your feature branch
3. Run "Retrieve All" (or fetch individual edges)
4. Check the results — conversion rates, data volumes, any errors

### What to look for after each fetch

| Signal | Likely cause | Fix |
|--------|-------------|-----|
| Zero data on an edge | Wrong Amplitude event name or filter; missing `event_id` on graph node; context DSL filtering too aggressively | Check event file, cross-reference with monorepo, verify `event_id` is on both node file and graph node |
| Data on wrong edges | Query DSL references wrong node IDs; parameter file has stale query | Check `query` field on both the graph edge and the parameter file |
| Wildly wrong conversion rates | Denominator mismatch (from-node population doesn't match expectation); date range issue | Compare N values against Amplitude reference; check DSL window dates |
| Planner warnings (wall of warnings) | Queries on unfetchable edges (missing `event_id` on source or target node) | Remove `query` from both graph edge and parameter file for unfetchable edges |
| "Signature not found" errors | Hash drift; slice-key mismatch | Check slice-key normalisation; verify core_hash matches between planner and DB |
| Non-monotonic cohort maturity curve | Denominator bias for downstream edges (known issue — see `2-time-series-charting.md` §2.3.11) | Affects edges that are not the first in the graph; use F-mode (model CDF) for now |

### After fixing

1. Fix the entity files / graph JSON / parameter files
2. Run pre-flight validation:
   ```bash
   bash graph-ops/scripts/validate-indexes.sh
   bash graph-ops/scripts/validate-graph.sh graphs/<graph>.json --deep
   ```
3. Commit and push
4. Fetch again
5. Repeat until clean

See [Validate a Graph](validate-graph.md) for full details on interpreting validation output.

### Typical number of iterations

Expect 3–5 cycles for a new graph:

1. **First fetch**: discover event name/filter mismatches, missing bindings
2. **Second fetch**: fix query DSL issues, denominator mismatches
3. **Third fetch**: validate rates against Amplitude reference, fix edge cases
4. **Fourth fetch**: fine-tune context filters, handle special cases (server-side events, conditional steps)
5. **Steady state**: rates match expectations, all edges fetch cleanly

---

## 3. Validating Against Amplitude Reference Data

After each fetch cycle, compare your graph's conversion rates against the Amplitude funnel:

1. Open the Amplitude funnel chart for the same date range
2. For each measurable edge, compare:
   - **Absolute N** (denominator) — should be in the same ballpark
   - **Conversion rate** — should match within a few percentage points
   - **Trend shape** — rates should move in the same direction over time

Common discrepancies and their causes:

- **Graph rate is higher**: your denominator is smaller (stricter from-node filter)
- **Graph rate is lower**: your denominator is larger (broader from-node definition)
- **Graph rate is correct for recent data but wrong for old**: context or event definition changed over time; you may need context epochs
- **Rates match for first edge but diverge downstream**: upstream latency effects; immature cohorts are biased (see denominator bias §2.3.11)

---

## 4. When to Merge to Main

Merge when:

- [ ] All measurable edges return data
- [ ] Conversion rates are within expected ranges (validated against Amplitude reference)
- [ ] Pre-flight validation passes (`validate-graph.sh --deep` + `validate-indexes.sh`)
- [ ] No orphaned entity files or missing index entries
- [ ] `dailyFetch: true` is set (if the graph should be in the automated overnight run)
- [ ] At least one full fetch cycle has completed cleanly on the feature branch

After merging to main, the graph will automatically be included in the main-branch daily fetch automation. No further action needed.

---

## 5. Troubleshooting

### "My graph isn't being picked up by daily fetch"

1. Is `dailyFetch: true` set on the graph? Check the graph JSON.
2. Is the automation pointed at the correct branch? Check which branch the Navigator has selected.
3. Has the graph been committed and pushed? The pre-enumeration pull fetches from the remote.
4. Is the graph loaded in IndexedDB? Clone/load the workspace for that branch if it's a fresh session.

### "Fetch completed but data looks wrong"

1. Check the session log for warnings or errors during fetch
2. Inspect the parameter file's `values` array — look at `data_source.retrieved_at` to confirm data freshness
3. Compare raw X/Y values against Amplitude's funnel step counts (not just rates)
4. Check whether context DSL is filtering the data down to a small segment

### "Parity comparison shows mismatches after recompute"

This applies when the forecasting parallel-run is enabled:

1. Check the diagnostic error in the session log — it includes subject ID, field name, both values, delta, and tolerance
2. Most mismatches are **input mismatches** (wrong anchor range, wrong slice key, wrong onset) rather than algorithmic errors
3. Verify the parity comparison is sending the same inputs the FE topo pass used
4. See `analysis-forecasting-implementation-plan.md` Phase 8.5 for the catalogue of known defect patterns

---

## Reference

- [branch-workflow.md](branch-workflow.md) — Git workflow for feature branches
- [build-funnel-graph.md](build-funnel-graph.md) — End-to-end graph construction
- [edit-existing-graph.md](edit-existing-graph.md) — Modifying existing graphs
- `docs/current/project-db/snapshot-db-phase0-summary.md` — Summary of the snapshot DB phase 0 work
- `docs/current/project-db/2-time-series-charting.md` §2.3.11 — Denominator bias problem
