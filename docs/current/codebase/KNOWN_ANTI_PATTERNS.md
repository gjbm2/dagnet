# Known Anti-Patterns

Failure patterns that have occurred in this codebase. If your current bug matches one of these signatures, apply the known fix — don't re-derive it.

## Anti-pattern 1: Clearing state from one layer only

**Signature**: you delete/clear a field, it appears to work, but the old value keeps coming back — or it works once but fails on the second run.

**Root cause**: data lives in 4 layers simultaneously:
1. Parameter file (FileRegistry/IDB) — `file.data.posterior`
2. Graph edge projected value — `edge.p.posterior` (probability) + `edge.p.latency.posterior` (latency)
3. Stashed slices — `edge.p._posteriorSlices` (raw data for re-projection)
4. React render tree — whatever reference React last saw via `setGraph`

Clearing layer 1 is useless unless you also handle layers 2-4. UpdateManager mapping configurations (`updateManager/mappingConfigurations.ts`) project param file fields onto graph edges — the file and the graph edge are separate copies, not references.

**Fix**: grep for ALL locations where the field is read or written. Clear all of them. Call `setGraph` with a new object reference to trigger re-render. Test the "already clean" case (field already absent).

**Example**: the 6-attempt posterior deletion failure — each attempt cleared a different layer but missed the others.

## Anti-pattern 2: Fixing one call site, missing others

**Signature**: you fix a bug, it works in the context menu, but the same bug persists in the properties panel / toolbar / inline picker / keyboard shortcut.

**Root cause**: the same operation is implemented in multiple places (context menu, toolbar, properties panel, inline picker, drag handler). Fixing one leaves the others broken.

**Fix**: before writing any fix, grep for ALL call sites that perform the same mutation. List every code path. Consolidate into ONE canonical function. Fix the function, not the call sites.

**Example**: changing analysis type was done in 4 places. Fix was `setContentItemAnalysisType()` — one function, all four call sites use it.

## Anti-pattern 3: In-place mutation without new reference

**Signature**: you mutate the graph object, but the UI doesn't update. Adding `console.log` shows the data is correct in memory.

**Root cause**: React's reconciliation requires a new object reference to trigger re-render. `graph.edges[0].p.mean = 0.5` mutates in place — React never sees the change. `setGraph(graph)` passes the same reference — React skips the update.

**Fix**: always return a new graph object. Use `structuredClone(graph)` or spread operators to create a new reference before calling `setGraph`. Better: use the UpdateManager methods which return new graph objects by design.

## Anti-pattern 4: Using FileRegistry for git operations

**Signature**: commit doesn't include all dirty files, or includes wrong files, or shows zero dirty files when there are clearly dirty tabs.

**Root cause**: `fileRegistry.getDirtyFiles()` queries the in-memory cache (unprefixed IDs, current session only). `db.getDirtyFiles()` queries IndexedDB (source of truth, prefixed + unprefixed, survives reload).

**Fix**: always use `db.getDirtyFiles()` for git operations. Filter by workspace prefix. See INDEXEDDB_PERSISTENCE_LAYER.md.

## Anti-pattern 5: Gating cleanup behind a count that can be zero

**Signature**: fix works the first time but fails on subsequent runs. Or works when data is present but fails when data was already cleaned.

**Root cause**: cleanup logic is inside `if (count > 0)` where `count` tracks how many items were found to clean. On second run, source is already clean → count=0 → derived state cleanup is skipped → derived copies persist.

**Fix**: always clean derived state unconditionally. The cleanup must be idempotent — it must work whether the source data is present, absent, or partially cleaned.

## Anti-pattern 6: Blaming HMR / code staleness

**Signature**: agent says "this might be a stale code issue" or "try refreshing the page" without evidence.

**Root cause**: HMR failures are rare and have obvious symptoms (console errors, yellow toast). The actual cause is almost always state propagation, IDB prefix mismatch, or sync suppression.

**Fix**: run the 5-step staleness diagnostic (DEV_ENVIRONMENT_AND_HMR.md) before blaming HMR. If all 5 pass, the issue is logic, not staleness.

## Anti-pattern 7: Patching the symptom, not tracing the root cause

**Signature**: fix addresses the visible symptom (e.g., "add a null check here") but the same class of bug keeps appearing in different forms.

**Root cause**: agent didn't trace the full data path to understand WHY the value was null/wrong. The null check masks the real issue.

**Fix**: apply the root-cause gate. Can you name the root cause in one sentence with a "because"? If not, keep investigating. Read the architecture doc for the subsystem. Trace from user action to persistence.

## Anti-pattern 8: Testing the mock, not the system

**Signature**: all tests pass, but the real feature is broken. Tests assert values that the mock was configured to return.

**Root cause**: test mocks IDB, mocks FileRegistry, mocks the service, then asserts against the mock's return value. The test is a closed loop — it proves the mock works, not the system.

**Fix**: use real IDB (fake-indexeddb), real FileRegistry, real GraphStore. Mock only external APIs (GitHub, Amplitude). Assert state in all affected subsystems, not just the return value. See Testing Standards in CLAUDE.md.

## Anti-pattern 9: Suppression window race during rapid mutations

**Signature**: state appears correct immediately after a change but reverts to a previous value after ~500ms.

**Root cause**: store→file sync sets a 500ms suppression window on file→store sync. If the suppression expires before all pending FileRegistry writes complete, a stale file notification can overwrite the store.

**Fix**: check `suppressFileToStoreUntilRef` timing. Check `writtenStoreContentsRef` for stale echo detection. See SYNC_SYSTEM_OVERVIEW.md for the full guard system.

## Anti-pattern 10: Assuming isInitializing is false

**Signature**: dirty detection doesn't work for a newly-loaded file. File appears clean despite real edits.

**Root cause**: `isInitializing` is true for 500ms after file load. During this phase, all edits are absorbed into `originalData` without marking dirty. If `completeInitialization()` doesn't fire (e.g., callback lost, file re-loaded), the phase never ends.

**Fix**: check `file.isInitializing` in the debugger. Verify `completeInitialization(fileId)` is scheduled and fires. See FILE_REGISTRY_LIFECYCLE.md.

## Anti-pattern 11: Computing signatures from graph config instead of stored state

**Signature**: a read-path surface (@ menu, planner, coverage UI) computes a signature independently and gets a different hash from what the write path (data fetch) stored. The surface shows "no data" despite data existing in the DB.

**Root cause**: the read path derives context keys from graph-level config (e.g., `dataInterestsDSL`) rather than examining what slices were actually stored in parameter files. The graph config may include ALL context dimensions (e.g., 3 MECE keys), while each individual fetch used just ONE context key per slice. Different context keys → different context definition hashes → different signature → different `core_hash` → no match in DB.

**Fix**: read paths must derive context keys from the **stored slice topology** (`parameterFile.data.values[].sliceDSL`), not from `dataInterestsDSL` or any other graph-level config. Enumerate all plausible context key-sets from stored slices, compute a signature for each, and query the DB with all of them. See `enumeratePlausibleContextKeySets` in `snapshotRetrievalsService.ts`.

**Example**: the @ menu showed no snapshots for `li-cohort-segmentation-v2` because `resolveContextKeys` fell back to `dataInterestsDSL` (3 context keys) while fetches stored snapshots under single-key signatures. Fixed by replacing the fallback with slice-topology-based enumeration.

**Related**: when multiple context dimensions produce multiple hashes for the same edge, the BE must select one hash per `retrieved_at` date to avoid double-counting. See `snapshot_regime_selection.py` and doc 30 (`30-snapshot-regime-selection-contract.md`). The candidate hashes for regime selection are derived from the current pinned DSL's explosion (which produces specific per-cross-product key-sets), not from a flat union of all dimensions.

## Anti-pattern 12: Unprefixed IDB key in file lookups

**Signature**: a function loads a file from `db.files.get(fileId)` using the FileRegistry-style unprefixed key (e.g., `event-myEvent`), but IDB stores files under workspace-prefixed keys (e.g., `nous-conversion-main-event-myEvent`). The lookup silently returns nothing.

**Root cause**: the FileRegistry uses unprefixed file IDs, but IDB uses `${repository}-${branch}-${fileId}` as the primary key. A direct `db.files.get(unprefixedId)` will never find a workspace-loaded file.

**Fix**: use `fileRegistry.restoreFile(fileId, workspaceScope)` which handles both unprefixed and prefixed key lookups. See `plannerQuerySignatureService.ts:152-168` for the correct pattern.

**Example**: `loadEventDefinition` in `snapshotRetrievalsService.ts` had `db.files.get(fileId)` as its IDB fallback — this always failed silently, causing event definitions to be missing from signature computation.

## Anti-pattern 13: Setup scripts that don't install all dependency sets

**Signature**: tests pass locally for weeks, then fail after `./dev-start.sh --clean` or a fresh `./setup.sh` run. The error is a missing module (`ModuleNotFoundError: No module named 'pymc'`) in a subsystem that was previously working.

**Root cause**: the repo has multiple `requirements*.txt` files for different subsystems (e.g., `graph-editor/requirements-local.txt` for the frontend Python backend, `bayes/requirements.txt` for the Bayesian compiler). Setup and dev-start scripts only installed the primary requirements file, not all of them. The missing deps only existed because someone had manually installed them in a previous venv session — a `--clean` rebuild wiped that implicit state.

**Fix**: ensure `setup.sh` and `dev-start.sh` install ALL requirement files into the shared venv. Both scripts must produce an identical, complete environment. Grep for all `requirements*.txt` files in the repo and verify each is referenced in both setup paths. When adding a new requirements file to the repo, add the install line to both scripts immediately.

**Broader principle**: any state that exists only because of manual one-off commands will eventually be lost. If the release script gates on it (e.g., bayes compiler tests), the setup script must produce it.

## Anti-pattern 14: Adding fields to Python types but not to `_build_unified_slices`

**Signature**: you add new fields to `PosteriorSummary` or `LatencyPosteriorSummary` (including `to_webhook_dict()`), wire them through `summarise_posteriors`, and expect them to appear in the FE — but they never arrive. The FE patch service reads them from the slice dict, the FE types accept them, the FE components render them, yet the values are always `undefined`.

**Root cause**: Bayes posterior data flows through a **manually-assembled dict**, not through `to_webhook_dict()`. The path is: `summarise_posteriors()` populates `PosteriorSummary` fields → `_build_unified_slices()` in `worker.py` builds the per-slice dicts that go into the webhook patch → FE reads those dicts. `_build_unified_slices` constructs every field by name — it does not call `to_webhook_dict()` or iterate the dataclass fields. If you add a field to the dataclass but not to `_build_unified_slices`, the field exists in Python memory but never reaches the patch file and therefore never reaches the FE.

**Fix**: when adding a field to `PosteriorSummary` or `LatencyPosteriorSummary`, always also add it to `_build_unified_slices()` in `worker.py` (both the `window` dict and the `cohort` dict). Grep for `_build_unified_slices` and trace how each existing field is emitted — follow the same pattern.

**Broader principle**: the Bayes data pipeline has **three serialisation boundaries** that all need updating when a new field is added: (1) Python dataclass, (2) `_build_unified_slices` in worker.py, (3) FE patch service projection in `bayesPatchService.ts`. Missing any one silently drops the field. The `to_webhook_dict()` method on the dataclass is used only by the earlier `model_inspect_only` path and does not affect real MCMC fits.

## Anti-pattern 15: Reimplementing FE logic in CLI instead of calling the same function

**Signature**: you need a FE function in Node but it imports `react-hot-toast` or `window.location`, so you rewrite it from scratch. The rewrite works initially but diverges over time — missing fields (`scope_from/to`), different complement edge computation, different LAG pass inputs.

**Root cause**: the assumption that browser-only imports prevent running FE code in Node. In fact, `react-hot-toast` is a no-op in Node (no DOM to render to), `window.location` can be guarded with `typeof window === 'undefined'`, and `import.meta.env` can be guarded with optional chaining. The browser dependency surface is almost always shallower than expected.

**Fix**: call the real FE function. Guard browser-specific code at the boundary (`import.meta.env?.DEV`, `getUrlSearchParams()` helper). Use `fake-indexeddb/auto` for IDB. If a function truly can't run in Node, fix *that function* with a guard — both browser and CLI benefit.

**Example**: `aggregate.ts` was initially a 280-line reimplementation of `fileToGraphSync.getParameterFromFile()`. It missed `scope_from/to`, computed complements differently, and used a separate LAG helper setup. Replaced with a thin wrapper calling `fetchDataService.fetchItems({ mode: 'from-file' })` — same function the browser calls, zero divergence.

## Anti-pattern 16: E2E test seeding IDB but assuming FileRegistry is populated

**Signature**: you seed data into IDB via `db.files.put()` in a Playwright test, but the from-file pipeline or planner returns empty/stale results because it reads from FileRegistry (in-memory), not IDB.

**Root cause**: `db.files.put()` writes to IndexedDB but does NOT notify FileRegistry. FileRegistry is populated lazily via `restoreFile()` (called during tab hydration) or proactively via `getOrCreateFile()`. The app's boot sequence hydrates the graph file into FileRegistry (via `loadTabsFromDB`), but parameter files remain in IDB until something requests them.

**Fix**: after seeding IDB and reloading, use `dagnetDebug.refetchFromFiles()` to trigger the full from-file pipeline. This causes FileRegistry to lazily load parameter files as the pipeline requests them. Alternatively, seed the `currentQueryDSL` to a different value than the target and then change it after boot — this triggers `useDSLReaggregation` which runs the from-file pipeline.

## Anti-pattern 17: Parity test that bypasses FE normalisation

**Signature**: you write a parity test that calls the BE via raw HTTP and compares responses. The test passes, you cut over, and the app breaks — the FE normalisation layer (e.g. `normaliseSnapshotCohortMaturityResponse` in `graphComputeClient.ts`) transforms the raw response, and that transformation fails with the new data shape.

**Root cause**: the rendering path is FE preparation → HTTP → BE handler → HTTP response → FE normalisation → chart. A raw HTTP test skips the last step. The normalisation often depends on the REQUEST shape (e.g. iterating `snapshot_subjects` keys from the request to build iteration keys for the response), so changing the request shape breaks normalisation even when the BE response is correct.

**Fix**: parity tests must call `runPreparedAnalysis` (which goes through `graphComputeClient` including normalisation), not raw `fetch`. They must also test with the "mixed" state where both old and new fields are present on the request, because that's the browser state during transition.

## Anti-pattern 18: Routing on field presence rather than semantic type

**Signature**: a handler entry-point checks whether a field exists (e.g. `if scenario.get('analytics_dsl')`) to decide which code path to use. A later change attaches that field to ALL requests (not just the ones that need the handler), and unrelated request types get misrouted.

**Root cause**: field presence is an unreliable discriminator. The `analytics_dsl` field was attached to all scenarios for snapshot types, but the BE routing check at `handle_runner_analyze` used its presence to route ALL requests (including `bridge_view`) to the snapshot handler.

**Fix**: route on the semantic type (`analysis_type in ANALYSIS_TYPE_SCOPE_RULES`), not on field presence. The field tells you "the FE provided this data"; the type tells you "this request needs this handler".

## Anti-pattern 19: Conflating distinct DSL concepts in a single variable

**Signature**: a variable called `queryDsl` sometimes holds the analytics DSL (`from(x).to(y)`) and sometimes the temporal DSL (`window(-90d:)`). Code downstream assumes one meaning, but receives the other.

**Root cause**: `analytics_dsl` (data subject, constant across scenarios) and `query_dsl` (temporal/context, varies per scenario) are fundamentally different concepts that happen to use the same DSL syntax. Combining them with `analyticsDsl || currentDSL` loses the distinction — downstream code that needs the temporal DSL gets the path DSL instead, and vice versa.

**Fix**: keep them separate throughout the pipeline. The FE sends `analytics_dsl` at top level (constant — the subject) and `effective_query_dsl` per scenario (varies — the temporal). They are never concatenated on the FE. The BE composes them when needed for snapshot subject resolution. See `DSL_SYNTAX_REFERENCE.md` § "DSL Roles in the Analysis Request Flow" and `docs/current/project-y/8-Apr-26-analysis-contract-fix.md`.

## Anti-pattern 20: Single-scenario parity test missing multi-scenario defects

**Signature**: parity test passes for a single scenario, you cut over, and multi-scenario charts break — each scenario gets the same temporal DSL instead of its own `effective_query_dsl`.

**Root cause**: single-scenario tests use one top-level `query_dsl` which happens to be correct for the only scenario. Multi-scenario requires per-scenario temporal DSLs. The top-level `query_dsl` is the current scenario's DSL — other scenarios get the wrong time bounds.

**Fix**: parity tests must include multi-scenario cases with different temporal DSLs (e.g. `--query "window(-90d:)" --query2 "window(-30d:)"`). The test must verify each scenario's data reflects its own time bounds, not the shared top-level DSL.

## Anti-pattern 21: Display planner forcing single-scenario on multi-scenario-capable charts

**Signature**: a time-series chart type (e.g. `daily_conversions`) has data for multiple scenarios in the result, but only one scenario renders. The legend shows "N" / "Conversion %" instead of per-scenario labels.

**Root cause**: `chartDisplayPlanningService.ts` has a `multiScenarioTimeSeriesKinds` set that controls which time-series chart kinds are allowed to render multiple scenarios. Chart kinds not in this set are forced to `current_only` mode (only the last scenario renders). The `daily_conversions` builder already handles multi-scenario correctly (separate series per scenario, unioned date axis), but the planner blocks it.

**Fix**: add the chart kind to `multiScenarioTimeSeriesKinds` in `chartDisplayPlanningService.ts`. Verify the ECharts builder handles multi-scenario grouping before adding — check that it groups by `scenario_id`, creates separate series per scenario, and aligns to a common date set.

## Anti-pattern 22: Treating transient errors as permanent rate limits

**Signature**: automated retrieve-all run takes hours longer than expected. Logs show repeated 45-minute cooldowns triggered by 30-second timeouts rather than actual 429 responses.

**Root cause**: the error classifier (`rateLimiter.isRateLimitError`) treated both explicit 429s and network timeouts as the same category, triggering a 45-minute cooldown for any transient timeout. In a real incident, 5 consecutive timeouts caused 3h 45m of wasted cooldowns, while a simple 30s retry would have succeeded.

**Fix**: classify errors into two tiers. Use `isExplicitRateLimitError()` for 429s only (triggers long cooldown) and `isTimeoutError()` for transient failures (retry with exponential backoff: 30s → 60s → 120s → cap at 5 min). Only escalate from timeout to cooldown if a retry receives an actual 429. See `rateLimiter.ts`, `retrieveAllSlicesService.ts`.

**Broader principle**: not all errors in the same code path deserve the same recovery strategy. Classify by cause, not by location.

## Anti-pattern 23: js-yaml Date conversion corrupts context definition hashes

**Signature**: CLI tool computes a different `core_hash` from the FE browser for the same graph on the same branch. The `x` (context definition) component of the structured signature differs. Receipt shows "all expected hashes returned no data" despite data existing in the DB.

**Root cause**: `js-yaml`'s default schema converts ISO date strings in YAML (e.g. `created_at: '2025-11-24T00:00:00Z'`) to native JavaScript `Date` objects. The `normalizeObjectKeys` function in `querySignature.ts` checks `typeof v === 'object'` — a `Date` passes this check, but `Object.keys(new Date())` returns `[]`, so the normalised output is `{}` instead of the original date string. The canonical JSON changes, producing a different SHA-256 hash. The FE browser doesn't hit this because IDB stores context definitions as serialised JSON where dates are already strings.

**Fix**: use `YAML.load(raw, { schema: YAML.JSON_SCHEMA })` when loading YAML files in the CLI disk loader (`graph-editor/src/cli/diskLoader.ts`). This prevents js-yaml from converting any scalars to non-string types. Do not change `normalizeObjectKeys` in production — the browser path is correct.

**Broader principle**: YAML loaders that auto-convert types (dates, booleans, octals) are a hash stability hazard. Any data that enters a hashing pipeline must be loaded with type coercion disabled, or coerced back to strings before hashing.

## When to add to this document

After completing a multi-attempt fix, check: does my bug match a generalisable pattern? If so, add it here following the format: Signature (how to recognise it), Root cause (why it happens), Fix (what to do), Example (optional, specific instance).
