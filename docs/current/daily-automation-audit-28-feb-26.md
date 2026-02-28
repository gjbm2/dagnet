# Daily Automation Audit — 28-Feb-26

**Session:** 11:23:52–12:32:35 UTC (~69 min), DagNet v1.6.15b
**Source log:** `tmp.log` (108,757 lines of session JSON)
**Overall status:** Finished with **error** flag
**Graphs processed:** 5 (all with `dailyFetch=true`)

---

## Issue 1: Git Commit Race — "Tree SHA does not exist" (CRITICAL)

### Symptom

Graph 4/5 failed to commit with:

> Tree SHA does not exist — https://docs.github.com/rest/git/commits#create-a-commit

The error surfaced twice:

1. **`DAILY_RETRIEVE_ALL` error** (line ~54026) — the automation-level orchestrator marked the graph as failed
2. **`GIT_COMMIT` error** (line ~82363) — the underlying commit service logged the same failure

### Sequence of events

1. Data retrieval succeeded: 58/58 slices fetched, 0 errors
2. Commit step started; remote was **ahead** (another graph's commit had landed moments earlier)
3. System pulled remote, then retried commit — retry **also** failed with "Tree SHA does not exist"
4. `DAILY_RETRIEVE_ALL` logged as error; graph marked failed
5. A second full cycle (pull → re-retrieve → commit) was attempted
6. Second cycle **succeeded** — committed 31 files at ~12:31 UTC (~13 min late)
7. Session ended with **error** status because of the initial failure

### Root cause hypothesis

The GitHub Contents/Git Data API requires a valid `base_tree` SHA when creating a commit. When multiple graphs commit sequentially to the same repo/branch, a commit from graph N invalidates the tree SHA that graph N+1 resolved during its pull. The current retry logic pulls the latest commit but may still be constructing the tree from a stale base.

Specifically, graph 3 committed 2 files at ~12:18. Graph 4's commit started at ~12:24 with a tree SHA from before that commit. The pull fetched the new HEAD but the tree-creation call still referenced the old tree.

### Affected graphs

- Graph 4/5 (31 files: 1 graph + 29 parameters + hash-mappings)

### Investigation pointers

- `repositoryOperationsService.ts` — commit flow, tree SHA resolution
- `gitService.ts` — GitHub API `createTree` / `createCommit` calls
- The retry-after-pull logic needs to re-resolve the base tree SHA, not just the HEAD commit SHA
- Consider: should the retry reconstruct the full tree from the freshly-pulled HEAD, rather than reusing the previously constructed tree?

### Impact

- Graph eventually committed (no data loss)
- Session flagged as error (may trigger alerts / confuse monitoring)
- ~13 min delay for one graph
- If the second full cycle had also failed, the graph's data would have been lost (not persisted to remote)

---

## Issue 2: Forecasting Parity Drift — Severe Divergence (HIGH)

### Summary

The forecasting parity checker detected significant drift between front-end (FE) and back-end (BE) forecast parameters across **9 edges in 2 graphs**. The errors are repeated on each tab-switch/round (the same check fires multiple times during automation), so the 107 error + 10 warning log entries reduce to 9 unique edge problems.

### Affected edges — Graph A (7 edges)

| Edge UUID (short) | Parameter | FE value | BE value | Rel. drift | onset_delta |
|---|---|---|---|---|---|
| `10e37cc7` | mu | 1.010 | 0.635 | **37.1%** | 1.8 |
| `10e37cc7` | sigma | 1.281 | 1.509 | 17.8% | 1.8 |
| `10e37cc7` | t95_days | 23.29 | 24.39 | abs 1.1d | 1.8 |
| `d45debd8` | mu | 2.002 | 1.854 | 7.4% | 2.2 |
| `d45debd8` | sigma | 0.385 | 0.475 | **23.4%** | 2.2 |
| `370dce1d` | mu | 0.886 | 0.814 | 8.1% | 5.0 |
| `370dce1d` | sigma | 0.742 | 0.785 | 5.9% | 5.0 |
| `13b5397f` | mu | 0.600 | 0.574 | 4.3% | 0 |
| `13b5397f` | sigma | 0.553 | 0.614 | 11.1% | 0 |
| `9624cce1` | mu | 2.075 | 2.013 | 3.0% | 2.6 |
| `9624cce1` | sigma | 0.520 | 0.558 | 7.2% | 2.6 |
| `9624cce1` | t95_days | 19.83 | 21.34 | abs 1.51d | 2.6 |
| `77d0a69e` | mu | -0.559 | -0.565 | 1.1% | 1.4 |

Edge `8c23ea34` had mu/sigma drift <1% (warning level only).

### Affected edges — Graph B (2 edges)

| Edge UUID (short) | Parameter | FE value | BE value | Rel. drift | onset_delta |
|---|---|---|---|---|---|
| `97b11265` | mu | 0.650 | 1.070 | **64.7%** | 4.8 |
| `7bb83fbf` | mu | 1.949 | 1.697 | **12.9%** | 5.4 |

### Evidence diffs

Most edges show **100/100 dates matching** between FE and BE evidence data. Two edges had minor evidence divergences:

- `10e37cc7`: 1 divergent date out of 100 (2025-12-16, `retrieved_at` = 2026-02-05)
- `9624cce1`: 2 divergent dates out of 100 (2025-11-27 and 2026-01-11)

The divergences are in the `k` vs `y` field naming (FE uses `k`, BE uses `y`) but the values match — the evidence data itself is essentially identical. **The drift is in the computed forecast parameters (mu, sigma, t95_days), not the underlying evidence.**

### What this means

The FE (TypeScript `statisticalEnhancementService`) and BE (Python stats service) are producing materially different lognormal fits from the same (or near-identical) evidence. This points to an **algorithmic divergence** in the fitting procedure, not a data problem.

### Likely causes to investigate

1. **onset_delta handling**: The `onset_delta` values vary (0 to 5.0). If the FE and BE handle onset shifting differently (e.g. which datum is chosen as the "onset anchor", or how onset_delta interacts with the lognormal fit), the resulting mu/sigma will diverge. The TODO already documents a known defect: "FE defect: topo pass leaves stale `onset_delta_days` on edge when window() slices lack onset data" — this could directly cause the parity drift.

2. **Evidence windowing**: If the FE and BE select slightly different date ranges or apply different censoring/completeness thresholds before fitting, the fit inputs differ.

3. **Fitting algorithm differences**: Different numerical implementations of the lognormal MLE/method-of-moments could produce different results, especially with small sample sizes or outlier dates.

4. **t95 derivation**: t95_days drifts of 1–1.5 days suggest different CDF inversion or different mu/sigma feeding the t95 calculation.

### Severity ranking

| Priority | Edge | Worst drift |
|---|---|---|
| P1 | `97b11265` (Graph B) | 64.7% mu |
| P1 | `10e37cc7` (Graph A) | 37.1% mu |
| P2 | `d45debd8` (Graph A) | 23.4% sigma |
| P2 | `7bb83fbf` (Graph B) | 12.9% mu |
| P3 | `13b5397f` (Graph A) | 11.1% sigma |
| P3 | others (Graph A) | <10% |

### Investigation pointers

- FE fitting: `statisticalEnhancementService.ts` (topo pass, lognormal fit, onset_delta handling)
- BE fitting: Python stats service (lognormal fit endpoint)
- Parity test: `forecastingParity.queryFlow.snapshotDb.integration.test.ts`
- Known related defect: stale `onset_delta_days` (see TODO.md)
- The TODO already notes: "We should remove the parity testing piece and complete cutover of BE stats service soon" — these results reinforce the urgency of that cutover

---

## Issue 3: No-Data Warnings (MODERATE)

### Summary

82 warnings of `FETCH_NO_DATA_RETURNED` across two graphs, plus 3 from a third graph. All relate to edge parameters for a flow that is either very new, very low-volume, or not yet instrumented.

### Detail

The `PLANNER_FILE_ONLY_GAPS` warning explicitly flagged 29 parameters as having "file-only gaps" — the parameter files exist but have no corresponding data from the source.

### Impact

- No data stored or committed for these parameters (harmless for now)
- If the events are supposed to have data, the event definitions or query construction may be wrong
- Worth validating whether these edges are expected to have traffic

---

## Other Observations

### Successful graphs

All 5 graphs completed and committed data. The commit failure on graph 4 was recovered via a second full cycle.

| Graph | Files committed | Notes |
|---|---|---|
| Graph 1/5 | 31 | Clean commit |
| Graph 2/5 | 6 | Clean commit |
| Graph 3/5 | 2 | Clean commit (most params had no data) |
| Graph 4/5 | 31 | Committed after recovery from Tree SHA failure |
| Graph 5/5 | 2 | Clean commit |

### Remote-ahead handling

Two instances of remote-ahead detection + pull + retry, both during graph 4. The first retry failed (Tree SHA); the second full cycle succeeded. The remote-ahead handling itself worked correctly — it's the tree SHA reconstruction after pull that's the problem.

### `BATCH_ALL_SLICES_SKIPPED` (2 occurrences)

"Retrieve All Slices skipped: no pinned query" — expected behaviour for graphs without pinned queries. Not a problem.
