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

**Related**: when multiple context dimensions produce multiple hashes for the same edge, the BE must select one hash per `retrieved_at` date to avoid double-counting. See `snapshot_regime_selection.py` and doc 30 (`30-snapshot-regime-selection-contract.md`).

## Anti-pattern 12: Unprefixed IDB key in file lookups

**Signature**: a function loads a file from `db.files.get(fileId)` using the FileRegistry-style unprefixed key (e.g., `event-myEvent`), but IDB stores files under workspace-prefixed keys (e.g., `nous-conversion-main-event-myEvent`). The lookup silently returns nothing.

**Root cause**: the FileRegistry uses unprefixed file IDs, but IDB uses `${repository}-${branch}-${fileId}` as the primary key. A direct `db.files.get(unprefixedId)` will never find a workspace-loaded file.

**Fix**: use `fileRegistry.restoreFile(fileId, workspaceScope)` which handles both unprefixed and prefixed key lookups. See INDEXEDDB_PERSISTENCE_LAYER.md for the prefix contract.

## Anti-pattern 13: Setup scripts that don't install all dependency sets

**Signature**: tests pass locally for weeks, then fail after `./dev-start.sh --clean` or a fresh `./setup.sh` run. The error is a missing module (`ModuleNotFoundError: No module named 'pymc'`) in a subsystem that was previously working.

**Root cause**: the repo has multiple `requirements*.txt` files for different subsystems. Setup and dev-start scripts only installed the primary requirements file, not all of them. The missing deps only existed because someone had manually installed them in a previous venv session — a `--clean` rebuild wiped that implicit state.

**Fix**: ensure `setup.sh` and `dev-start.sh` install ALL requirement files into the shared venv. When adding a new requirements file to the repo, add the install line to both scripts immediately.

**Broader principle**: any state that exists only because of manual one-off commands will eventually be lost. If the release script gates on it, the setup script must produce it.

## Anti-pattern 14: Adding fields to Python types but not to `_build_unified_slices`

**Signature**: you add new fields to `PosteriorSummary` or `LatencyPosteriorSummary` (including `to_webhook_dict()`), wire them through `summarise_posteriors`, and expect them to appear in the FE — but they never arrive. The values are always `undefined`.

**Root cause**: Bayes posterior data flows through a **manually-assembled dict**, not through `to_webhook_dict()`. The path is: `summarise_posteriors()` populates `PosteriorSummary` fields → `_build_unified_slices()` in `worker.py` builds the per-slice dicts → FE reads those dicts. `_build_unified_slices` constructs every field by name — if you add a field to the dataclass but not to `_build_unified_slices`, it never reaches the FE.

**Fix**: when adding a field to `PosteriorSummary` or `LatencyPosteriorSummary`, always also add it to `_build_unified_slices()` in `worker.py` (both the `window` dict and the `cohort` dict), and to `bayesPatchService.ts` projection.

## Anti-pattern 15: Reimplementing FE logic in CLI instead of calling the same function

**Signature**: you need a FE function in Node but it imports `react-hot-toast` or `window.location`, so you rewrite it from scratch. The rewrite works initially but diverges over time — missing fields, different computation paths.

**Root cause**: the assumption that browser-only imports prevent running FE code in Node. In fact, browser dependencies are almost always shallower than expected — `react-hot-toast` is a no-op in Node, `window.location` can be guarded with `typeof window === 'undefined'`.

**Fix**: call the real FE function. Guard browser-specific code at the boundary. Use `fake-indexeddb/auto` for IDB. If a function truly can't run in Node, fix *that function* with a guard — both browser and CLI benefit.

## Anti-pattern 16: E2E test seeding IDB but assuming FileRegistry is populated

**Signature**: you seed data into IDB via `db.files.put()` in a Playwright test, but the from-file pipeline returns empty/stale results because it reads from FileRegistry (in-memory), not IDB.

**Root cause**: `db.files.put()` writes to IndexedDB but does NOT notify FileRegistry. FileRegistry is populated lazily via `restoreFile()` or proactively via `getOrCreateFile()`.

**Fix**: after seeding IDB and reloading, use `dagnetDebug.refetchFromFiles()` to trigger the full from-file pipeline.

## Anti-pattern 17: Parity test that bypasses FE normalisation

**Signature**: parity test calls the BE via raw HTTP and compares responses. The test passes, you cut over, and the app breaks — the FE normalisation layer transforms the raw response, and that transformation fails with the new data shape.

**Root cause**: the rendering path is FE preparation → HTTP → BE → HTTP response → FE normalisation → chart. A raw HTTP test skips the last step.

**Fix**: parity tests must call `runPreparedAnalysis` (which goes through `graphComputeClient` including normalisation), not raw `fetch`.

## Anti-pattern 18: Routing on field presence rather than semantic type

**Signature**: a handler checks whether a field exists (e.g. `if scenario.get('analytics_dsl')`) to decide which code path to use. A later change attaches that field to ALL requests, and unrelated request types get misrouted.

**Root cause**: field presence is an unreliable discriminator. The field tells you "the FE provided this data"; the type tells you "this request needs this handler".

**Fix**: route on the semantic type (`analysis_type in ANALYSIS_TYPE_SCOPE_RULES`), not on field presence.

## Anti-pattern 19: Conflating distinct DSL concepts in a single variable

**Signature**: a variable called `queryDsl` sometimes holds the analytics DSL (`from(x).to(y)`) and sometimes the temporal DSL (`window(-90d:)`). Code downstream assumes one meaning, but receives the other.

**Root cause**: `analytics_dsl` (data subject, constant across scenarios) and `query_dsl` (temporal/context, varies per scenario) are fundamentally different concepts that happen to use the same DSL syntax. Combining them loses the distinction.

**Fix**: keep them separate throughout the pipeline. The FE sends `analytics_dsl` at top level (constant — the subject) and `effective_query_dsl` per scenario (varies — the temporal). See `DSL_SYNTAX_REFERENCE.md` § "DSL Roles in the Analysis Request Flow".

## Anti-pattern 20: Single-scenario parity test missing multi-scenario defects

**Signature**: parity test passes for a single scenario, you cut over, and multi-scenario charts break — each scenario gets the same temporal DSL instead of its own `effective_query_dsl`.

**Root cause**: single-scenario tests use one top-level `query_dsl` which happens to be correct for the only scenario. Multi-scenario requires per-scenario temporal DSLs.

**Fix**: parity tests must include multi-scenario cases with different temporal DSLs. The test must verify each scenario's data reflects its own time bounds, not the shared top-level DSL.

## Anti-pattern 22: Treating transient errors as permanent rate limits

**Signature**: automated retrieve-all run takes hours longer than expected. Logs show repeated 45-minute cooldowns triggered by 30-second timeouts rather than actual 429 responses.

**Root cause**: the error classifier treated both explicit 429s and network timeouts as the same category, triggering a 45-minute cooldown for any transient timeout.

**Fix**: classify errors into two tiers. Use `isExplicitRateLimitError()` for 429s only (triggers long cooldown) and `isTimeoutError()` for transient failures (retry with exponential backoff: 30s → 60s → 120s → cap at 5 min). Only escalate from timeout to cooldown if a retry receives an actual 429.

**Broader principle**: not all errors in the same code path deserve the same recovery strategy. Classify by cause, not by location.

## Anti-pattern 23: js-yaml Date conversion corrupts context definition hashes

**Signature**: CLI tool computes a different `core_hash` from the FE browser for the same graph on the same branch. The `x` (context definition) component of the structured signature differs.

**Root cause**: `js-yaml`'s default schema converts ISO date strings in YAML to native JavaScript `Date` objects. `normalizeObjectKeys` checks `typeof v === 'object'` — a `Date` passes this check, but `Object.keys(new Date())` returns `[]`, so the normalised output is `{}` instead of the original date string. The canonical JSON changes, producing a different SHA-256 hash.

**Fix**: use `YAML.load(raw, { schema: YAML.JSON_SCHEMA })` when loading YAML files in the CLI disk loader (`graph-editor/src/cli/diskLoader.ts`).

**Broader principle**: YAML loaders that auto-convert types (dates, booleans, octals) are a hash stability hazard. Any data that enters a hashing pipeline must be loaded with type coercion disabled.

## Anti-pattern 24: Effect fires before async context is ready on boot

**Signature**: after F5, a feature works only after user interaction (which triggers re-render after async context loads). Variants include: scenario overlays stale on boot, FE-only analyses blank, snapshot tabs empty.

**Root cause**: async contexts (NavigatorContext, ScenariosContext, credentials) load from IDB and can take several seconds to populate. Effects that depend on these contexts fire immediately on mount — with undefined/empty values. Version-counter or dedup-key guards then prevent retry even after the context becomes available.

**Fix**: guard effects on the context being populated (`sourceRepo && sourceBranch`, `scenariosLoaded`, etc.). The effect re-fires when the deps transition from empty to populated. For FE-only computation types that don't need async context at all (e.g. `edge_info`, `node_info`), skip the readiness gate entirely.

## Anti-pattern 27: Confusing context hash filtering with context value filtering

**Signature**: selecting a context value (e.g. `context(channel:paid-search)`) in a snapshot filter returns the same count as no filter.

**Root cause**: context values within one MECE dimension share the same `core_hash` (the hash encodes the context **definition**, not the specific value). To filter by value, you need `slice_key` filtering — either via the `slice_keys` parameter on `querySnapshotRetrievals`, or client-side by matching `slice_key` strings.

**Two-level model**: (1) context *dimension* changes the hash (channel-contexted ≠ device-contexted ≠ uncontexted); (2) context *value* is carried in `slice_key` within a hash family. Both levels must be filtered for context-specific snapshot views.

**Reference**: `HASH_SIGNATURE_INFRASTRUCTURE.md` §"What is and is not in the hash".

## Anti-pattern 28: Duplicate hash computation codepaths

**Signature**: hashes computed by path A don't match hashes computed by path B for the same graph. Snapshot DB queries return 0 rows even though data was just written.

**Root cause**: multiple independent implementations of hash/signature computation that diverge over time. Each path makes slightly different choices about what inputs to hash.

**Fix**: ONE codepath for hash computation. The FE service layer (`computeQuerySignature` via `buildFetchPlanProduction` → `mapFetchPlanToSnapshotSubjects`) is the single source of truth. All other hash computations (synth_gen, test harness, scripts) must call the CLI which uses this real FE code, not hand-rolled reimplementations.

## Anti-pattern 31: Regex not handling optional prefixes in DSL clauses

**Signature**: `_extract_time_bounds` (or similar DSL parsers) returns today's date instead of the dates in the DSL. Downstream filters silently exclude all historical data.

**Root cause**: `cohort(anchor,start:end)` has an optional anchor node prefix before the date range. A regex like `cohort\(([^:]*):([^)]*)\)` captures `anchor,start-date` as group 1. `_resolve_date('anchor,12-Dec-25')` fails all date format checks and falls through to `today.isoformat()`.

**Fix**: make the anchor prefix optional in the regex: `cohort\((?:[^,)]*,)?([^:,]*):([^)]*)\)`. Test with both `cohort(start:end)` and `cohort(anchor,start:end)` forms. Check the grammar in `DSL_SYNTAX_REFERENCE.md` before writing DSL regexes.

## Anti-pattern 33: Per-subject random effects on hazard parameters

**Signature**: adding per-cohort (or per-trajectory) latent offsets to a shared parameter (mu, sigma, onset) in the product-of-conditional-Binomials likelihood. ESS collapses to single digits, shared parameter drifts to its prior, onset-mu correlation approaches ±1.0.

**Root cause**: with N trajectories and N per-cohort offsets, the model has as many parameters as data points. Each cohort's offset absorbs its own trajectory's signal, leaving the shared parameter unconstrained.

**Fix**: use per-interval observation-level overdispersion instead. Replace `Binomial(n_j, q_j)` with `BetaBinomial(n_j, q_j * kappa_lat, (1 - q_j) * kappa_lat)`. This adds ONE scalar parameter per edge, not N. See doc 34 for the full design.

**Broader principle**: the analogue of kappa for any distribution is a scalar that inflates variance at the observation level, not per-subject latent variables.

## Anti-pattern 34: Phase 2 onset_cohort drift on deep join-node paths

**Signature**: Phase 2 `onset_cohort` drifts 3-6 days above truth on edges with composed path onset > 3 days (diamond, 3-way-join, lattice topologies). `p_cohort` overestimates to compensate. rhat > 2.0 with 4 chains.

**Root cause**: `onset_cohort = softplus(composed_onset + eps × path_onset_sd)` with `path_onset_sd ≈ 0.1` allows drift because the only constraint is `path_t95_obs` with wide sigma. The t95 constraint allows onset and mu to trade off freely: onset drifts up while mu drifts down (or vice versa), keeping t95 constant. This creates a ridge in the posterior.

**Not yet fixed**. Potential approaches: (a) derive `path_onset_sd` from Phase 1 posterior SD; (b) add a per-edge onset observation; (c) reparameterise onset multiplicatively; (d) add a joint onset+mu constraint that penalises the ridge.

See compiler journal 13-Apr-26 update 11.

## Anti-pattern 35: Edge ID key order mismatch (uuid-first vs id-first)

**Signature**: `computeInboundN` returns different n values for sibling edges from the same node, or returns an empty/partial map despite the graph having data. The bug is silent — no errors, just wrong numbers.

**Root cause**: `computeInboundN` uses `getEdgeId()` which returns `edge.uuid || edge.id` (uuid-first). If the caller builds the `activeEdges` set or `getEffectiveP` lookup using `edge.id || edge.uuid` (id-first), edges with both fields populated resolve to different keys. The edge is absent from `activeEdges`, so the topo walk skips it. Downstream nodes receive incomplete population, and siblings get different n values.

**Fix**: all call sites that interact with `computeInboundN` must use `uuid || id` (uuid-first) consistently. Search for `edge.id || edge.uuid` near any `computeInboundN` usage and reverse the order.

**Broader principle**: whenever a function uses an internal key derivation (like `getEdgeId`), all callers must match that derivation exactly. A mismatch is invisible at the type level (both are strings) and produces silently wrong results.

## Anti-pattern 36: Latency bead gate checking data presence instead of feature enablement

**Signature**: non-latency edges (with `latency_parameter: false` or undefined) show latency beads after a BE topo pass run.

**Root cause**: the `checkExists` gate for the latency bead checked `edge.p.latency.median_lag_days !== undefined` without also checking `latency_parameter === true`. The BE topo pass writes `median_lag_days` to any edge with a `latency` block, regardless of whether latency tracking is enabled. An edge can have `latency: { latency_parameter: false, median_lag_days: 5 }` — the block exists (from a prior edit or schema default) but the feature is disabled.

**Fix**: gate on `latency_parameter === true && median_lag_days !== undefined`. More generally: always gate feature-specific UI on the feature's enablement flag, not on the presence of data that the feature would consume.

## Anti-pattern 37: Devtool "clear" action that destroys diagnostic data

**Signature**: a keybinding, script, or UI action labelled "clear" or "clean up" that silently deletes primary diagnostic output (log files, trace files, recovery results). The user invokes it expecting a display reset and loses irreplaceable run data.

**Root cause**: the developer conflates "clear the display" with "delete the underlying data". A function intended to tidy the UI uses `rm -f` on the source files instead of hiding them from the display layer. There is no confirmation prompt and no warning that data will be destroyed.

**Fix**: devtool "clear" actions must NEVER delete log files, trace outputs, or diagnostic data. They should operate on the display layer only (hide entries, reset scroll position, clear a UI list). If a genuinely destructive action is needed (e.g. freeing disk space), it must be a separate, explicitly-named command with a confirmation prompt. The naming must be unambiguous: "delete all finished logs" not "clear finished".

**Broader principle**: devtool infrastructure handles two kinds of state: (1) ephemeral display state (which panes are visible, what's scrolled, what's highlighted) and (2) durable diagnostic data (log files, recovery results, trace dumps). These must be managed by completely separate code paths. A display operation must never call `rm` on a data file. A data cleanup operation must never be bound to a casual keybinding.

**Example**: `bayes-monitor.sh` bound `^b e` ("clear finished") to a handler that `rm -f` all harness log files for finished graphs. The user pressed it after a 3-hour regression run, deleting all 21 graphs' diagnostic logs. The data could not be recovered. Fixed: `^b e` now writes hidden graph names to a display-only filter file; log files are untouched.

## Anti-pattern 38: Devtool script with unvalidated side effects on shared state

**Signature**: a helper script (monitor, status dashboard, cleanup tool) modifies shared state (`/tmp` files, lock files, process signals) as a side effect of a display or monitoring operation. The modification is not visible to the user and is not logged.

**Root cause**: devtool scripts are often written quickly as "just a helper" without the same rigour applied to production code. Side effects are added for convenience ("clean up stale locks while we're at it") without considering that the script may be invoked in unexpected contexts or at unexpected times.

**Fix**: devtool scripts must follow the same side-effect discipline as production code:
- **Read-only by default**: monitoring and status scripts should only read state, never modify it.
- **Explicit modification**: any script that modifies state (kills processes, removes files, writes config) must be named and documented to make the modification obvious.
- **No bundled side effects**: a "status" script should not also "clean up". A "monitor" script should not also "delete". Each action gets its own script or explicit flag.
- **Audit trail**: any state modification should be logged to stdout so the user sees what happened.

**Example**: the bayes monitor status script removed stale lock files as a side effect of checking process status. This is low-risk in isolation but establishes a pattern where display scripts casually modify shared state — which led directly to anti-pattern 37.

## Anti-pattern 39: Graph JSON regeneration strips critical metadata

**Signature**: a synth graph that previously worked (data binding succeeded, MCMC ran with full evidence) suddenly produces zero snapshot rows. The harness reports `all expected hashes returned no data` for every edge. The DB has data (verified by querying with synth-meta hashes), but the FE CLI produces zero snapshot subjects.

**Root cause**: the graph JSON was regenerated by a code path that doesn't set `pinnedDSL` / `dataInterestsDSL`. Without the DSL, the FE CLI cannot build snapshot subjects, cannot compute core_hashes, and falls back to param files only — losing all trajectory data, context slices, and kappa_lat evidence. The graph looks structurally valid (correct nodes, edges, UUIDs) but is functionally broken for Bayes.

Multiple code paths can regenerate the graph JSON: `graph_from_truth.py` (truth-based generation), `synth_gen.py --write-files` (which calls `set_simulation_guard`), and `synth_gen.py --bust-cache` (which regenerates from truth but may skip the `--write-files` path). Only `set_simulation_guard` sets the DSL — if it's not called, the DSL is silently stripped.

**Fix**: `graph_from_truth.py` now sets `pinnedDSL`, `dataInterestsDSL`, and `currentQueryDSL` directly during graph generation, using the simulation config and context dimensions from the truth file. The DSL is no longer dependent on a separate `set_simulation_guard` call. Every code path that generates a graph JSON now produces a complete, functional graph.

**Broader principle**: when a file is regenerated, ALL required fields must be set by the generator — not split across multiple tools invoked in a specific order. If field X is required for the file to function, the generator must set field X unconditionally. Deferring to a separate step creates a fragile dependency chain where any code path that skips the step silently produces a broken artefact.

## Anti-pattern 40: `--rebuild --no-mcmc` no-op for synth data

**Signature**: agent runs `param_recovery.py --rebuild --no-mcmc` expecting synth data to be regenerated, but the DB rows remain unchanged. Subsequent MCMC runs produce identical results to pre-rebuild.

**Root cause**: `--rebuild` deletes `.synth-meta.json`, which would trigger `verify_synth_data` to re-bootstrap on the next harness run. But `--no-mcmc` skips the harness subprocess entirely — `param_recovery.py` just prints the truth table and exits. The synth data gate in `test_harness.py` (line 769) only runs during payload construction, which `--no-mcmc` bypasses. The rebuild takes effect only on the NEXT run without `--no-mcmc`.

**Fix**: to force immediate synth data regeneration, use `synth_gen.py --graph X --write-files --bust-cache` directly. This runs the full generation pipeline (simulate, hash, write to DB, write param files) without any harness or MCMC indirection.

**Broader principle**: a flag that prepares state for a later step is invisible when the later step is skipped. If `--rebuild` means "regenerate data", it should regenerate data — not set a flag that a different code path checks later. When combining flags, verify the end-to-end effect, not just that each flag does its documented thing.

## Anti-pattern 41: BE results bypassing UpdateManager sibling rebalancing

**Signature**: after a fetch completes, one edge's `p.mean` is correct (reflecting BE topo pass blended_mean) but its sibling edges still show stale pre-fetch probabilities. Siblings don't sum to 1. Refreshing or fetching again appears to fix it (because the FE path runs first and rebalances).

**Root cause**: the BE topo pass wrote `edge.p.mean = beScalars.blended_mean` directly on the graph object, then called `setGraph()`. This bypassed `UpdateManager.applyBatchLAGValues`, which is the single code path for sibling probability rebalancing. The FE path correctly used `applyBatchLAGValues` (which collects edges whose `p.mean` changed and runs `findSiblingsForRebalance` + `rebalanceSiblingEdges`), but the BE path skipped it entirely.

**Fix**: restructured the fetch pipeline so both FE and BE results flow through `applyBatchLAGValues`. BE scalars are merged into the FE `EdgeLAGValues` array before application, rather than applied as a separate direct-mutation pass. See `FE_BE_STATS_PARALLELISM.md` §Orchestration for the race-based flow.

**Broader principle**: when a subsystem has a single canonical mutation path (UpdateManager for graph state), every code path that writes the same fields must go through it. A "shortcut" that writes directly to the object and calls `setGraph` bypasses all the invariants the canonical path maintains — rebalancing, override flag checks, conditional probability propagation. The more code paths that write the same field, the more likely one of them forgets a side effect.

## Anti-pattern 39: Reimplementing the FE pipeline in test code

**Signature**: a test for a BE handler builds its own hash lookup, candidate regime construction, or subject resolution — bypassing the FE's `prepareAnalysisComputeInputs` → `runPreparedAnalysis` path. The test passes but the production render shows completely different behaviour.

**Root cause**: the FE pipeline does hash computation (`computeShortCoreHash`), temporal-mode-aware regime selection, snapshot contract resolution, and FE normalisation. Reimplementing any of this in Python test helpers creates a parallel path that silently diverges from production. The most common failure: the test's manual hash lookup returns the wrong temporal mode's hash (e.g. window hash for a cohort query), so the snapshot query returns 0 rows, the handler runs the zero-cohort code path, and the test "passes" because both v2 and v3 produce the same zero-cohort output — exercising a completely different code path from production.

**Fix**: use the CLI tooling (`graph-ops/scripts/analyse.sh`) which calls the same FE functions the browser does. Run it twice with different `--type` values and compare the JSON output. See `graph-ops/scripts/v2-v3-parity-test.sh` for the working implementation.

**Non-vacuousness gate**: any parity test MUST assert that `evidence_x > 0` for at least some rows. If every row has `evidence_x = 0` or `evidence_x = None`, the test is vacuous — it's testing the zero-cohort early-return path, not the population model with IS conditioning, carrier, and forecast_x growth.

**Broader principle**: when CLI tooling exists that exercises the real production pipeline, always use it for testing. The cost of reimplementing is not just the initial effort — it's the silent divergence that makes every test pass while production is broken.

## Anti-pattern 40: Vacuous synth graph tests (missing snapshot data linkage)

**Signature**: a parity test on a synth graph shows `cohorts=0` or `rows=0`. The handler runs the zero-cohort model-only code path. The test passes but catches none of the real bugs (carrier scaling, IS conditioning, forecast_x growth).

**Root cause**: the synth graph's core_hash (as computed by the FE's hash function) doesn't match what `synth_gen.py` wrote to the snapshot DB. This happens when: (a) the test helper computes hashes differently from the FE, (b) hydration changed edge fields that affect the hash, or (c) the query window's date range doesn't overlap the synth data's date range.

**Fix**: use `analyse.sh --topo-pass --no-snapshot-cache` which computes hashes identically to the FE. For query windows, use absolute dates matching the synth data range (check `base_date` in the synth config and the `anchor_day` range in the DB). Relative dates like `-14d:` fail because they're relative to today, which may be months after the synth data.

**Detection**: the `v2-v3-parity-test.sh` Phase 1 health checks assert `evidence_x > 0`. If this fails, the snapshot linkage is broken and the parity comparison would be vacuous.

## When to add to this document

After completing a multi-attempt fix, check: does my bug match a generalisable pattern? If so, add it here following the format: Signature (how to recognise it), Root cause (why it happens), Fix (what to do), Example (optional, specific instance).

Entries should be **generalisable patterns** that an agent could plausibly hit again in a different part of the codebase. One-off bugs with fixes already in git history do not belong here — the commit message has the context, the code has the fix. If the insight is subsystem-specific rather than pattern-generalisable, it belongs in the relevant codebase architecture doc instead.
