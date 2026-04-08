# Analysis Request Contract Fix

**Status**: Plan — not yet implemented
**Date**: 8-Apr-26
**Depends on**: Doc 30 (regime selection), Doc 31 (BE subject resolution)
**Blocks**: All analysis types — bridge_view currently returns zeros, surprise_gauge unreachable

---

## 1. Problem

The FE→BE analysis request contract diverged from the doc 30/31 design during implementation. Three DSL roles — subject, temporal, and hash regime — are conflated, misplaced, or inconsistently gated. Consequences:

1. **bridge_view returns zeros**: top-level `query_dsl` is a concatenation of `analytics_dsl` (subject) and `currentDSL` (temporal), producing `to(switch-success).from(x).to(y).window(-30d:)`. The BE parses two `to()` and one `from()` clause, computing wrong predicates.
2. **surprise_gauge unreachable**: `analytics_dsl` only sent when `needsSnapshots=true`. surprise_gauge had no `snapshotContract` (now fixed) but the gating logic still prevents `analytics_dsl` from reaching graph-only types.
3. **candidate_regimes_by_edge not filtered per scenario**: all scenarios get the same full inventory. Scenarios with different context dimensions should get different filtered candidate lists (doc 30 §4.1).

---

## 2. Scope

The `analytics_dsl` on a content item is the same string that reaches the BE — there is no translation layer. The field flows directly: content item → preparation service → HTTP request → BE handler. The same is true for `effective_query_dsl` (derived from the scenario's temporal clause) and `candidate_regimes_by_edge` (computed from the graph's pinned DSL).

### What changes

- The **HTTP request body** sent to `/api/runner/analyze`: field placement, gating, and composition
- The **FE preparation service** that constructs the request: `analysisComputePreparationService.ts`
- The **FE HTTP client** that sends it: `graphComputeClient.ts`
- The **BE handler** that receives it: `api_handlers.py`, `analyzer.py`, `runner/types.py`
- The **CLI** analysis command: `cli/commands/analyse.ts`
- **Candidate regime filtering**: `candidateRegimeService.ts` (per-scenario filtering)

### What does NOT change

- `contentItem.analytics_dsl` — the value is unchanged; only where it appears on the request changes (per-scenario → top-level)
- `graph.currentQueryDSL` / `graph.dataInterestsDSL` — graph-level DSL storage
- Share link schema (`sharePayload.ts`) — existing share URLs must still deserialise
- UI components that read/write `analytics_dsl` on content items — they read from the content item, not from the request

---

## 3. Target wire format

```
{
  analysis_type: "cohort_maturity",
  analytics_dsl: "from(x).to(y)",
  mece_dimensions: ["channel"],
  display_settings: { ... },
  scenarios: [
    {
      scenario_id: "scenario-1",
      name: "Before",
      colour: "#F59E0B",
      visibility_mode: "f+e",
      graph: { ... },
      effective_query_dsl: "window(-90d:-30d).context(channel:google)",
      candidate_regimes_by_edge: {
        "<edge-uuid>": [{ core_hash: "H_channel", equivalent_hashes: [...] }]
      }
    },
    {
      scenario_id: "current",
      name: "Current",
      colour: "#3B82F6",
      visibility_mode: "f+e",
      graph: { ... },
      effective_query_dsl: "window(-30d:)",
      candidate_regimes_by_edge: {
        "<edge-uuid>": [{ core_hash: "H_bare", equivalent_hashes: [...] }]
      }
    }
  ]
}
```

### Invariants

| Field | Level | Contains | Never contains |
|-------|-------|----------|----------------|
| `analytics_dsl` | top-level | `from`, `to`, `visited`, `visitedAny`, `exclude` | `window`, `cohort`, `context`, `asat` |
| `effective_query_dsl` | per-scenario | `window`, `cohort`, `context`, `asat` | `from`, `to` |
| `candidate_regimes_by_edge` | per-scenario | hashes filtered to match scenario's context dimensions | full unfiltered inventory |

### Eliminated fields

| Field | Why |
|-------|-----|
| top-level `query_dsl` | meaningless — temporal varies per scenario |
| per-scenario `analytics_dsl` | redundant — subject is constant, belongs at top level |
| `snapshot_subjects` | doc 31 — BE resolves subjects |

---

## 4. Phased implementation

Each phase is gated by tests that must pass before proceeding to the next.

### Phase 0: Golden response capture + contract tests

#### 0a. CLI golden response regression suite

Capture golden JSON responses for every testable analysis type BEFORE any code changes. These are the ground truth. After each phase, re-run the same CLI commands and diff against the golden files. Any difference must be explained and approved.

**Golden responses already captured** in `graph-editor/src/cli/__tests__/golden/`:

| Type | CLI invocation | Rows | File |
|------|---------------|------|------|
| `graph_overview` | `--query "window(-30d:)" --type graph_overview` | 5 | `graph_overview.json` |
| `to_node_reach` | `--query "to(switch-success).window(-30d:)" --type to_node_reach` | 1 | `to_node_reach.json` |
| `from_node_outcomes` | `--query "from(household-delegated).window(-30d:)" --type from_node_outcomes` | 5 | `from_node_outcomes.json` |
| `path_between` | `--query "from(household-delegated).to(switch-success).window(-30d:)" --type path_between` | 2 | `path_between.json` |
| `bridge_view` | `--scenario "window(-90d:-30d)" --scenario "window(-30d:)" --subject "to(switch-success)" --type bridge_view` | 8 | `bridge_view.json` |
| `cohort_maturity` | `--query "from(household-delegated).to(switch-registered).cohort(-90d:)" --type cohort_maturity` | 0 (no snapshot data) | `cohort_maturity.json` |
| `surprise_gauge` | `--query "from(household-delegated).to(switch-registered).window(-30d:)" --type surprise_gauge` | 0 (no snapshot data) | `surprise_gauge.json` |

Graph: `conversion-flow-v2-recs-collapsed` from the data repo.

**New file: `graph-ops/scripts/golden-regression.sh`**

A script that:
1. Re-runs each CLI command above
2. Compares each response against the golden file
3. For each response, checks: `success` flag, `analysis_type`, `data` row count, and for types with real data, the actual probability/reach values (within tolerance for floating point)
4. Reports PASS/FAIL per type

This script is the phase gate. Every phase must pass it before proceeding.

#### 0b. FE contract shape tests

**New file: `graph-editor/src/services/__tests__/analysisRequestContract.test.ts`**

1. **bridge_view contract test**: two scenarios with different temporals. Assert prepared output shape.
2. **cohort_maturity contract test**: snapshot type, two scenarios with different contexts. Assert `analytics_dsl` presence, `effective_query_dsl` per scenario, `candidate_regimes_by_edge` per scenario.
3. **surprise_gauge contract test**: Assert `snapshotContract` is recognised, `analytics_dsl` flows through.
4. **Invariant tests** (parameterised across all analysis types in the registry):
   - `analyticsDsl` never contains `window(`, `cohort(`, `context(`, `asat(`
   - `effective_query_dsl` never contains `from(`, `to(`

Initially these tests document the CURRENT (broken) behaviour — they will be updated in Phase 2 to assert the CORRECT shape.

#### 0c. BE contract tests

**New file: `graph-editor/lib/tests/test_analysis_request_contract.py`**

5. **Standard runner with top-level analytics_dsl**: send request with `analytics_dsl: "to(switch-success)"`, no `query_dsl`. Assert BE routes correctly, parses subject, returns non-error.
6. **Snapshot handler with separate fields**: send request with top-level `analytics_dsl`, per-scenario `effective_query_dsl`. Assert BE composes the full DSL correctly and resolves subjects.
7. **Regime selection per scenario**: two scenarios with different `candidate_regimes_by_edge`. Assert each scenario uses its own regimes.

**Gate**: golden responses captured, regression script written and passing (baseline), FE and BE contract tests written (baseline tests passing, target tests marked as expected failures).

### Phase 1: Fix BE to accept new shape (backward-compatible)

**File: `graph-editor/lib/runner/types.py`**

- Add to `ScenarioData`: `effective_query_dsl: Optional[str] = None`, `candidate_regimes_by_edge: Optional[dict] = None`
- Add to `AnalysisRequest`: `analytics_dsl: Optional[str] = None`, `mece_dimensions: Optional[list[str]] = None`
- Keep `query_dsl` as Optional (deprecated — old clients still send it)

**File: `graph-editor/lib/api_handlers.py`**

- `handle_runner_analyze` routing (line 608): read `analytics_dsl` from `data.get('analytics_dsl')` (top level). Check `is_snapshot_type and (analytics_dsl or scenarios_with_snapshots)` for snapshot routing. For the standard runner path, set `request_obj.query_dsl = analytics_dsl or data.get('query_dsl')` as a backward-compat shim.

- `_handle_snapshot_analyze_subjects` DSL composition (line 1191): read `analytics_dsl` from `data.get('analytics_dsl')` (top level). For each scenario, read `temporal_dsl` from `scenario.get('effective_query_dsl')`. Compose cleanly: `full_dsl = f"{analytics_dsl}.{temporal_dsl}"` when both non-empty, else whichever is non-empty. Add runtime assertion: `analytics_dsl` does not contain `window(`/`cohort(`, `temporal_dsl` does not contain `from(`/`to(`.

**File: `graph-editor/lib/runner/analyzer.py`**

- `analyze` (line 40): read `request.analytics_dsl`. If present, pass to `analyze_scenario` as the subject DSL. Fall back to `request.query_dsl` for backward compat.
- `analyze_scenario` (line 89): use `analytics_dsl` for `compute_predicates_from_dsl` and `parse_query` (from/to/visited extraction). `query_dsl` becomes unused when `analytics_dsl` is present.

**Gate**: Phase 0 BE contract tests updated to assert correct behaviour and passing. Golden regression script passes (BE changes must not alter response content — only request routing changes).

### Phase 2: Fix FE preparation service

**File: `graph-editor/src/services/analysisComputePreparationService.ts`**

- Remove the concatenation at lines 367-369. Replace with: `const queryDsl = currentDSL;` (temporal only, for backward compat during transition). The `analyticsDsl` variable (line 359) stays as the pure subject.

- Update `PreparedAnalysisComputeReady` (line 122): add `analyticsDsl: string`. Keep `queryDsl` temporarily for signature compat.

- Remove the `needsSnapshots` gate on `analytics_dsl`. The prepared output always carries `analyticsDsl` at top level. `candidate_regimes_by_edge` stays gated by `needsSnapshots` (requires workspace).

- `runBackendAnalysis` (line 644): pass `prepared.analyticsDsl` to the client methods as a new top-level parameter.

**File: `graph-editor/src/lib/graphComputeClient.ts`**

- `analyzeMultipleScenarios` (line 1592): accept `analyticsDsl: string`. Set `analytics_dsl: analyticsDsl` at top level of request. Remove per-scenario `analytics_dsl`. Stop sending top-level `query_dsl`. Ensure each scenario sends `effective_query_dsl` (mandatory, not conditional).

- `analyzeSelection` (line 1403): accept `analyticsDsl: string`, `effectiveQueryDsl: string`. Set `analytics_dsl` at top level. Set `effective_query_dsl` on the scenario. Remove top-level `query_dsl`.

- Update `AnalysisRequest` interface (line 1929): add `analytics_dsl?: string`, `mece_dimensions?: string[]`. Deprecate `query_dsl`.

- Update `ScenarioData` interface (line 1918): add `effective_query_dsl?: string`, `candidate_regimes_by_edge?: Record<string, any>`.

- Update cache keys in both methods: replace `queryDsl` with `analyticsDsl` + per-scenario `effective_query_dsl` hash.

- Update `createPreparedSignature` (line 261): replace `queryDsl` parameter with `analyticsDsl`.

**Gate**: Phase 0 FE contract tests updated to assert correct shape and passing. Golden regression script passes — all analysis types return identical results to baseline.

### Phase 3: Fix CLI analyse command

**File: `graph-editor/src/cli/commands/analyse.ts`**

- Line 147: stop concatenating `subject + "." + baseDsl`. Set `analyticsDsl = subject || ''` and `currentDSL = currentEntry.queryDsl` as separate arguments to `prepareAnalysisComputeInputs`.

**Gate**: CLI tests passing. Golden regression script passes.

### Phase 4: Per-scenario candidate regime filtering

**File: `graph-editor/src/services/candidateRegimeService.ts`**

- Add function `filterCandidatesByContext(allRegimes: Record<string, CandidateRegime[]>, effectiveQueryDsl: string): Record<string, CandidateRegime[]>`. Parses context dimension keys from the DSL, filters each edge's candidate list to only retain regimes whose key-set matches.

- Logic: parse `effectiveQueryDsl` with `parseConstraints`, extract context keys via `extractContextKeysFromConstraints`. For each edge, keep only regimes whose key-set is a subset of the query's context keys. If query has no context, keep only bare (uncontexted `x: {}`) regimes.

**File: `graph-editor/src/services/analysisComputePreparationService.ts`**

- In the `needsSnapshots` block: call `buildCandidateRegimesByEdge` once (full inventory). Then for each scenario, call `filterCandidatesByContext(fullInventory, scenario.effective_query_dsl)`.

**New file: `graph-editor/src/services/__tests__/candidateRegimeFiltering.test.ts`**

Tests:
1. `context(channel:google)` → only channel-dimension regimes pass
2. No context → only bare regimes pass
3. `context(channel:google).context(device:mobile)` → only cross-product regimes pass
4. Unknown dimension → empty result

**Gate**: filtering tests passing. Golden regression script passes. Parity test passes:

```bash
bash graph-ops/scripts/parity-test.sh conversion-flow-v2-recs-collapsed \
  "from(household-delegated).to(switch-registered).window(-30d:)"
```

### Phase 5: Fix response contract and call sites

The BE response currently echoes a single `query_dsl` field. This is misleading — it conflates the subject with the temporal, and pretends a single DSL is true for all scenarios. The correct response shape carries `analytics_dsl` (the subject) and per-scenario `effective_query_dsl` within each scenario's result.

**File: `graph-editor/lib/runner/types.py`**

- `AnalysisResponse`: add `analytics_dsl: Optional[str] = None`. Deprecate `query_dsl`.

**File: `graph-editor/lib/api_handlers.py`**

- Both the standard runner and snapshot handler: set `response.analytics_dsl = analytics_dsl` (the subject from the top-level request field). Per-scenario results should carry their `effective_query_dsl` so callers know which temporal produced each scenario's data.

**FE call sites that read `response.query_dsl` — fix each to read the correct field:**

| Call site | Current behaviour | Correct behaviour |
|-----------|-------------------|-------------------|
| `AnalyticsPanel.tsx:253` | Reads `results.query_dsl` as "the panel's analytics DSL" | Read `results.analytics_dsl` for subject. For temporal, read from the scenario being displayed. |
| `shareLinkService.ts:469` | Writes `query_dsl` to share payload from response | Write `analytics_dsl` for subject. Write per-scenario `effective_query_dsl` for temporal. |
| `graphComputeClient.ts` normalise functions | Propagate `query_dsl` from response | Propagate `analytics_dsl`. Per-scenario normalisers should preserve each scenario's `effective_query_dsl`. |
| `AnalyticsPanel.tsx:995,1183` | Passes `query_dsl: snapshotChartDsl || results.query_dsl` to chart source | Multi-scenario types: use the visible scenario's `effective_query_dsl`. Single-scenario types: use the first/only scenario's `effective_query_dsl`. |
| `CanvasAnalysisNode.tsx:757` | Passes `query_dsl: contentItem?.analytics_dsl` to chart source | Already correct — reads from content item, not response. No change. |

**Gate**: all call sites updated, tests passing. Verify that chart subtitles/axis labels show the correct per-scenario temporal, not a stale shared DSL.

### Phase 6: Cleanup

- Remove `query_dsl` from `AnalysisRequest` on both FE (`graphComputeClient.ts`) and BE (`types.py`)
- Remove `query_dsl` from `AnalysisResponse` on BE
- Remove `snapshot_subjects` from `ScenarioData`
- Remove per-scenario `analytics_dsl` from the request
- Remove all concatenation code that joined subject + temporal
- Remove backward-compat shim in `analyzer.py` that falls back to `query_dsl`
- Remove diagnostic logging added in this session (`[bridge_diag]` prints in `runners.py`)

**Gate**: full test suite passing. Golden regression script passes. FE manual test of bridge_view, cohort_maturity, surprise_gauge in the browser.

---

## 5. Adversarial review

### 5a. Design review

**Q: What if analytics_dsl is empty?**
Graph-only types like `graph_overview` have no subject — `analytics_dsl` is `""`. The BE must handle this: if `analytics_dsl` is empty, the standard runner uses an empty DSL which produces `node_count=0`, matching `graph_overview`. This works today with empty `query_dsl` and will work with empty `analytics_dsl`.

**Q: What if effective_query_dsl is empty?**
A scenario with no temporal clause (e.g. "use the graph's base probabilities, no window"). This is valid — the BE uses default time bounds (today). The FE should set `effective_query_dsl` to `""` explicitly, never `undefined`.

**Q: What about the analyzeSelection single-scenario path?**
Currently takes 12 positional parameters. The refactor must not just add more — should consolidate into a request object parameter. But that's a larger refactor. For now, add `analyticsDsl` and `effectiveQueryDsl` parameters and deprecate `queryDsl`.

**Q: Will existing share links break?**
No. Share payloads have their own schema (`sharePayload.ts`). The FE's `useShareChartFromUrl` reads `chartPayload.analysis.query_dsl` and passes it through the preparation service, which will handle it as `currentDSL` (temporal). The `analytics_dsl` comes from the content item definition in the share payload. These are already separate in the share schema.

**Q: Will removing response.query_dsl break callers?**
Yes, unless we fix them. Several FE callers read `response.query_dsl` to get the subject or temporal back. These callers are already buggy — they treat a single `query_dsl` as if it applies to all scenarios, which is incorrect when scenarios have different temporals. Phase 5 fixes each call site: subject comes from `response.analytics_dsl`, temporal comes from the specific scenario's `effective_query_dsl` in its result. Single-scenario types use the first scenario's DSL; multi-scenario types must not assume a shared temporal.

**Q: What about the Bayes worker path?**
`bayes/worker.py` reads `candidate_regimes_by_edge` from the payload top-level. The Bayes path is separate from the analysis path — it doesn't go through `handle_runner_analyze`. No change needed for Phase 1-4. Phase 6 should verify the Bayes path still works.

**Q: What about cache invalidation?**
One-time invalidation only. Current cache keys include `queryDsl` (the concatenated mess). Changing to `analyticsDsl` + per-scenario `effective_query_dsl` hashes invalidates all existing caches on first load. This is correct — stale caches with wrong DSL composition should be flushed. The new key scheme is strictly more correct (invalidates when any scenario's temporal changes). No chronic caching issue.

**Q: What if candidate regime filtering produces empty results for a scenario?**
If no snapshot data exists for a scenario's context hash, there's no data. The analysis degrades gracefully — graph-only probabilities still work, snapshot overlays are empty. This is correct behaviour: showing data from a different regime (different context dimension) would be wrong data.

### 5b. Test plan review

**Q: Are we testing the wire format or just the preparation?**
Phase 0 tests the preparation output (the `PreparedAnalysisComputeReady` shape). We should also test the actual HTTP request body. Add an assertion in the FE test that intercepts `fetch` and checks the JSON body matches the target schema.

**Q: What about regression on existing snapshot types?**
The parity test (`parity-test.sh`) exercises `daily_conversions`, `lag_histogram`, `cohort_maturity` across old and new paths. Run it as a gate. Add `surprise_gauge` to the parity test.

**Q: What about multi-scenario snapshot types?**
`outcome_comparison` and `branch_comparison` with `time_series` chart kind use the snapshot path with `children_of_selected_node` scope. The DSL for these is `visitedAny(a,b)` which doesn't have `from()` — the BE's `_resolve_children` requires `from()`. This is a pre-existing gap, not introduced by this fix. Document it as a known limitation.

**Q: What about the dual-path types (outcome_comparison, branch_comparison)?**
These have both a `snapshotContract` AND a standard runner. When `needsSnapshots=false` (e.g. chart kind is `bar_grouped`), they go through the standard runner. The standard runner needs `analytics_dsl` for subject resolution — and with this fix, it will get it (Phase 1b shims `query_dsl = analytics_dsl`). This is actually a fix — previously these types got the concatenated DSL.

**Q: What if the FE sends the new format but the BE hasn't been updated?**
Phase 1 makes the BE accept both formats (all new fields are Optional, fallback to old fields). Phase 1 code must be committed and the dev server restarted before Phase 2 changes are tested. Since this is single-dev deployment (FE and BE in the same repo), the risk is low — just restart the dev server between phases.

**Q: What breaks if we remove top-level query_dsl but the Phase 1 shim isn't in place?**
Every graph-only analysis type breaks. The standard runner parses from/to from `query_dsl`. Without it and without the `query_dsl = analytics_dsl` shim, the BE gets an empty DSL, produces `node_count=0`, and dispatches to `graph_overview` regardless of the forced `analysis_type`. Phase ordering is critical: BE (Phase 1) before FE (Phase 2).

---

## 6. Full impact site catalogue

### MUST CHANGE (wire format boundary)

| File | Lines | What | Phase |
|------|-------|------|-------|
| `lib/runner/types.py` | 17-52 | Add fields to Pydantic models | 1 |
| `lib/api_handlers.py` | 608-655 | Handler routing — read top-level `analytics_dsl` | 1 |
| `lib/api_handlers.py` | 1191-1210 | DSL composition — separate subject + temporal | 1 |
| `lib/runner/analyzer.py` | 40-70 | `analyze()` — read `analytics_dsl` | 1 |
| `lib/runner/analyzer.py` | 89-170 | `analyze_scenario()` — use `analytics_dsl` for predicates | 1 |
| `src/services/analysisComputePreparationService.ts` | 122-130 | `PreparedAnalysisComputeReady` — add `analyticsDsl` | 2 |
| `src/services/analysisComputePreparationService.ts` | 359-369 | Remove concatenation | 2 |
| `src/services/analysisComputePreparationService.ts` | 480-516 | Remove `needsSnapshots` gate on `analytics_dsl` | 2 |
| `src/services/analysisComputePreparationService.ts` | 261-282 | `createPreparedSignature` — replace `queryDsl` | 2 |
| `src/services/analysisComputePreparationService.ts` | 644-683 | `runBackendAnalysis` — pass `analyticsDsl` | 2 |
| `src/lib/graphComputeClient.ts` | 1403-1485 | `analyzeSelection` — restructure params | 2 |
| `src/lib/graphComputeClient.ts` | 1592-1692 | `analyzeMultipleScenarios` — restructure params | 2 |
| `src/lib/graphComputeClient.ts` | 1918-1939 | `ScenarioData`, `AnalysisRequest` interfaces | 2 |
| `src/lib/graphComputeClient.ts` | 1422-1428, 1626-1632 | Cache key computation | 2 |
| `src/cli/commands/analyse.ts` | 145-197 | Remove subject+temporal concatenation | 3 |
| `src/services/candidateRegimeService.ts` | 32-121 | Add `filterCandidatesByContext` | 4 |
| `lib/runner/types.py` | 136-148 | `AnalysisResponse` — add `analytics_dsl`, deprecate `query_dsl` | 5 |
| `lib/api_handlers.py` | response construction | Set `analytics_dsl` on response, per-scenario `effective_query_dsl` on results | 5 |
| `src/lib/graphComputeClient.ts` | normalise functions | Propagate `analytics_dsl` instead of `query_dsl` from response | 5 |
| `src/components/panels/AnalyticsPanel.tsx` | 253, 995, 1183 | Read subject from `analytics_dsl`, temporal from scenario's `effective_query_dsl` | 5 |
| `src/services/shareLinkService.ts` | 469, 580 | Write `analytics_dsl` for subject, per-scenario temporal for share payloads | 5 |

### NOT CHANGED

These files read/write `analytics_dsl` or `query_dsl` but only on content items, recipes, or share payloads — not on the analysis HTTP request. The values they produce flow into the preparation service, which handles the translation to the new request shape.

| File | What it does | Why no change needed |
|------|-------------|---------------------|
| `src/components/panels/analysisTypes.ts` | Defines `snapshotContract` per analysis type | Already correct (surprise_gauge added) |
| `src/types/index.ts` (ContentItem) | Stores `analytics_dsl` on content items | Same value, just placement on request changes |
| `src/types/chartRecipe.ts` | Recipe schema with `analytics_dsl` / `query_dsl` | Recipe feeds prep service; prep service handles new shape |
| `src/services/shareLinkService.ts` | Serialises DSLs into share URLs | Own schema; deserialisers feed prep service |
| `src/hooks/useShareChartFromUrl.ts` | Reads share payload, feeds prep service | Prep service handles new shape |
| `src/hooks/useShareBundleFromUrl.ts` | Same | Same |
| `src/components/panels/AnalyticsPanel.tsx` | Reads `analytics_dsl` from content items | Feeds prep service via useCanvasAnalysisCompute |
| `src/components/PropertiesPanel.tsx` | Edits `analytics_dsl` on content items | Same value, prep service translates |
| `src/components/nodes/CanvasAnalysisNode.tsx` | Reads/writes `analytics_dsl` on tabs | Same value |
| `src/services/canvasAnalysisCreationService.ts` | Sets `analytics_dsl` on new content items | Same value |
| `src/services/canvasAnalysisMutationService.ts` | Backfills `analytics_dsl` on content items | Same value |
| `src/components/HoverAnalysisPreview.tsx` | Creates temp content items with `analytics_dsl` | Same value |
| `src/services/chartRecomputeService.ts` | Reads DSL from recipe for staleness | Reads from recipe, not request |
| `src/components/charts/ChartViewer.tsx` | Reads DSL from recipe | Same |
| `bayes/worker.py` | Reads `candidate_regimes_by_edge` from Bayes payload | Separate Bayes path, own contract |

### VERIFY ONLY (should work but confirm)

| File | What to verify |
|------|---------------|
| `src/hooks/useCanvasAnalysisCompute.ts` | Passes `analyticsDsl` and `currentDSL` correctly to prep service |
| `src/services/analysisBootCoordinatorService.ts` | Collects DSLs from content items (not wire) — should be unaffected |
| `src/cli/commands/parity-test.ts` | Update expected shape assertions |
| `lib/tests/test_doc31_parity.py` | Update expected request shape |
| `lib/tests/test_analysis_subject_resolution.py` | Add test cases with separate analytics_dsl + temporal |

---

## 7. Documentation updates

- `docs/current/codebase/DSL_SYNTAX_REFERENCE.md` §"DSL Roles": update lines 257-260 to reflect new wire format (no top-level `query_dsl`, `analytics_dsl` at top level, `effective_query_dsl` per scenario)
- `docs/current/project-bayes/31-be-analysis-subject-resolution.md` §2.1: update "After" contract
- `docs/current/project-bayes/30-snapshot-regime-selection-contract.md` §4.1: add note about per-scenario filtering of candidate regimes
