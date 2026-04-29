# Known Anti-Patterns

Failure patterns that have occurred in this codebase and recur across surfaces. If your current bug matches a signature here, apply the known fix — don't re-derive it.

This list is deliberately short. Subsystem-specific traps that only apply to one file or function live next to that code, in the relevant doc under `docs/current/codebase/`. See the **Moved entries** table at the end for redirects, and the **Removed entries** list for ones that are now duplicated by CLAUDE.md or other warm-start docs.

Numbering is non-contiguous and stable: cited numbers (e.g. "see anti-pattern 23") keep working even after a move. New entries take the next free integer.

## When to add an entry here

Three tests an entry must pass:

1. **Re-derivable?** If the trap can recur in a different part of the codebase, it belongs here. If the fix is in code and the architecture has been refactored so the trap can't recur, the commit message is the right home.
2. **Symptom-first?** A useful signature lets an agent recognise the trap **before** knowing the diagnosis. If the signature only makes sense after you've solved it, rewrite it.
3. **Pattern, not fact?** Single-subsystem traps belong in the subsystem doc next to the function they constrain — they'll actually be in scope when the agent is editing the relevant code. This doc is for cross-cutting patterns.

After completing a multi-attempt fix, ask: would an agent in a different subsystem plausibly hit this same shape of bug? If no, it's a subsystem fact — write it up there.

---

## Anti-pattern 1: Clearing state from one layer only

**Signature**: you delete or clear a field, it appears to work, but the old value comes back — or it works once and fails on the second run.

**Root cause**: state lives in 4 layers simultaneously:

1. Parameter file (FileRegistry / IDB) — `file.data.posterior`
2. Graph edge projected value — `edge.p.posterior`, `edge.p.latency.posterior`
3. Stashed slices on the edge — `edge.p._posteriorSlices` (raw data for re-projection)
4. React render tree — whatever reference React last saw via `setGraph`

UpdateManager mapping configurations (`updateManager/mappingConfigurations.ts`) project param-file fields onto graph edges. The file and the edge are separate copies, not references. Clearing layer 1 alone is useless.

**Fix**: grep for ALL read/write sites of the field. Clear all of them. Call `setGraph` with a new object reference. Test the already-clean case (field already absent on entry).

## Anti-pattern 3: In-place mutation without new reference

**Signature**: you mutate the graph object, UI doesn't update, but `console.log` shows the data is correct in memory.

**Root cause**: React reconciliation requires a new object reference. `graph.edges[0].p.mean = 0.5` mutates in place — React never sees the change. `setGraph(graph)` with the same reference — React skips the update.

**Fix**: return a new graph object. Use `structuredClone(graph)` or spread, or (preferably) the UpdateManager methods which return new objects by design.

## Anti-pattern 4: FileRegistry vs db for git operations

**Signature**: commit is missing dirty files, includes wrong files, or shows zero dirty files when tabs are clearly dirty.

**Root cause**: `fileRegistry.getDirtyFiles()` queries the in-memory cache (unprefixed IDs, current session only). `db.getDirtyFiles()` queries IndexedDB (source of truth, prefixed + unprefixed, survives reload).

**Fix**: always use `db.getDirtyFiles()` for git operations. Filter by workspace prefix. See `INDEXEDDB_PERSISTENCE_LAYER.md`.

## Anti-pattern 5: Gating cleanup behind a count that can be zero

**Signature**: fix works the first time, fails on subsequent runs. Or works when data is present, fails when data was already cleaned.

**Root cause**: cleanup is inside `if (count > 0)` where `count` tracks how many items were found to clean. On second run, source is clean → count=0 → derived state cleanup is skipped → derived copies persist.

**Fix**: clean derived state unconditionally. Cleanup must be idempotent — work whether the source data is present, absent, or partially cleaned.

## Anti-pattern 6: Blaming HMR / code staleness without proof

**Signature**: agent says "this might be a stale code issue" or "try refreshing the page" without evidence.

**Root cause**: HMR failures are rare and have visible symptoms (console errors, yellow toast). The actual cause is almost always state propagation, IDB prefix mismatch, or sync suppression.

**Fix**: run `scripts/dev-server-check.sh <file-you-edited>` before blaming HMR. If FRESH, the problem is your code. If STALE, check the dev-server pane for syntax/import errors blocking the reload. See `DEV_ENVIRONMENT_AND_HMR.md`.

## Anti-pattern 11: Read paths computing signatures from graph config, not stored state

**Signature**: a read-path surface (@ menu, planner, coverage UI) computes a signature independently and gets a different hash from what the write path stored. The surface shows "no data" despite data existing in the DB.

**Root cause**: the read path derives context keys from graph-level config (e.g. `dataInterestsDSL`) rather than from what slices were actually stored in parameter files. Graph config may include all context dimensions (3 MECE keys) while each individual fetch used one key per slice. Different context keys → different context-definition hashes → different `core_hash` → no DB match.

**Fix**: read paths must derive context keys from the **stored slice topology** (`parameterFile.data.values[].sliceDSL`), not from any graph-level config. Enumerate all plausible context key-sets from stored slices and query the DB with all of them. See `enumeratePlausibleContextKeySets` in `snapshotRetrievalsService.ts`.

When multiple context dimensions produce multiple hashes for the same edge, the BE selects one hash per `retrieved_at` date to avoid double-counting. See `snapshot_regime_selection.py`.

## Anti-pattern 13: Setup scripts that don't install all dependency sets

**Signature**: tests pass for weeks, then fail after `./dev-start.sh --clean` or fresh `./setup.sh`. The error is `ModuleNotFoundError` for a module in a previously-working subsystem.

**Root cause**: the repo has multiple `requirements*.txt` files for different subsystems. Setup installed only the primary one. The missing deps existed only because someone manually installed them in a previous venv — `--clean` wiped that implicit state.

**Fix**: `setup.sh` and `dev-start.sh` install ALL requirement files into the shared venv. When adding a new requirements file, add the install line to both scripts immediately.

**Broader principle**: any state that exists only because of manual one-off commands will eventually be lost. If the release script gates on it, the setup script must produce it.

## Anti-pattern 15: Reimplementing FE logic in CLI instead of calling the same function

**Signature**: you need an FE function in Node but it imports `react-hot-toast` or touches `window.location`, so you rewrite it from scratch. The rewrite works initially but diverges over time — missing fields, different computation paths.

**Root cause**: browser dependencies are almost always shallower than expected. `react-hot-toast` is a no-op in Node. `window.location` is guardable with `typeof window === 'undefined'`.

**Fix**: call the real FE function. Guard browser-specific code at the boundary. Use `fake-indexeddb/auto` for IDB. If a function truly can't run in Node, fix *that function* with a guard — both browser and CLI benefit. CLI tooling exists (`graph-ops/scripts/analyse.sh`) to exercise the real production pipeline; use it.

## Anti-pattern 17: Parity tests must include FE normalisation and multi-scenario

**Signature**: parity test passes, you cut over, the app breaks. Variants: passes for a single scenario but multi-scenario fails; both branches return zero rows so the test is vacuous; raw-HTTP test passes but the FE chart breaks because normalisation transforms the response.

**Root cause**: the rendering path is FE preparation → HTTP → BE → response → FE normalisation → chart. Tests that bypass FE prep, normalisation, or use a single scenario miss every defect that depends on per-scenario temporal DSL or shape transformation. Single-scenario tests use one top-level `query_dsl` which happens to be correct for the only scenario; multi-scenario requires per-scenario temporal DSLs. Vacuous tests exercise zero-cohort early-return paths and silently match because both versions short-circuit identically.

**Fix**: parity tests must call `runPreparedAnalysis` (which goes through `graphComputeClient` including normalisation), or use the CLI tooling (`graph-ops/scripts/analyse.sh`) which calls the same FE functions the browser does. Include multi-scenario cases with different temporal DSLs.

**Non-vacuousness gate**: assert `evidence_x > 0` for at least some rows. If every row has `evidence_x = 0`, the test is vacuous — it's testing the zero-cohort path, not the population model.

## Anti-pattern 18: Routing on data presence rather than feature enablement / semantic type

**Signature**: a handler branches on whether a field exists or its fitted value (`if scenario.get('analytics_dsl')`, `if resolved.latency.sigma <= 0`, `if median_lag_days !== undefined`) and gets it wrong when an unrelated request type or transient fit happens to set the field.

**Root cause**: field presence and fitted scalars are unreliable discriminators. Field presence tells you "data was provided"; type / enablement flag tells you "this object needs this handler". Promoted sigma can appear on non-latency edges (inherited from sibling slice fits, default fallbacks, legacy values). Latency edges can have σ=0 transiently (fit failure, insufficient evidence). `median_lag_days` can exist on `latency_parameter: false` edges from any enrichment writer.

**Fix**: route on the semantic type or enablement flag — `analysis_type in ANALYSIS_TYPE_SCOPE_RULES`, `(p or {}).get('latency', {}).get('latency_parameter') is True`, etc. Gate feature-specific UI on the feature's enablement flag, not on presence of data the feature would consume.

**Broader principle**: "is this feature enabled for this object?" is a configuration question; "what value did the fit produce?" is a data question. Never substitute one for the other. (Subsumes former AP36 and AP50.)

## Anti-pattern 22: Classify errors by cause, not by location

**Signature**: an automated process runs hours longer than expected because it treats transient errors as permanent. Logs show repeated long cooldowns triggered by short timeouts rather than actual rate-limit responses.

**Root cause**: error classifier treats two distinct failure modes (e.g. 429 rate limit vs 30s network timeout) as the same category, triggering the same recovery for both.

**Fix**: classify into tiers. Use explicit predicates per cause (`isExplicitRateLimitError`, `isTimeoutError`). Different causes get different recoveries — long cooldown for true rate limits, exponential backoff for transient timeouts (e.g. 30s → 60s → 120s → cap at 5 min). Only escalate from transient to persistent if a retry confirms.

**Broader principle**: not all errors in the same code path deserve the same recovery strategy.

## Anti-pattern 24: Effect fires before async context is ready on boot

**Signature**: after F5, a feature works only after user interaction (which triggers re-render once async context loads). Variants: scenario overlays stale on boot, FE-only analyses blank, snapshot tabs empty.

**Root cause**: async contexts (NavigatorContext, ScenariosContext, credentials) load from IDB and can take seconds. Effects depending on them fire immediately on mount with undefined values. Version-counter or dedup-key guards then prevent retry even after the context becomes available.

**Fix**: guard effects on the context being populated (`sourceRepo && sourceBranch`, `scenariosLoaded`, etc.). The effect re-fires when deps transition empty → populated. For FE-only computation types that don't need async context (e.g. `edge_info`, `node_info`), skip the readiness gate entirely so they aren't blocked.

## Anti-pattern 42: Silent `except Exception` hiding missing imports

**Signature**: new Python code runs correctly in direct testing (`PYTHONPATH=lib python3 -c "from module import func; func(...)"`) but has no effect via the running server. No log error. Feature silently falls back to default behaviour.

**Root cause**: code uses a stdlib module (`re`, `json`, `os`) inside a `try/except Exception` block, but the module isn't imported at the top of the file. The `NameError` is caught silently. Direct testing works because the REPL has the module in global namespace; the production import path doesn't.

**Fix**:
- Check imports when adding code to a file you didn't write — don't assume stdlib modules are imported.
- Never use bare `except Exception` without logging: at minimum `except Exception as e: print(f"WARNING: {e}", flush=True)`.
- After adding code, exercise it via the actual server path, not just a direct function call.

## Anti-pattern 48: Per-item failure aborting the whole batch response

**Signature**: a BE request with multiple subjects (or multiple scenarios × subjects) returns 400 or `success: false` even though most subjects would compute fine. One failing gate raises, the entire scenario's result is lost — including sibling subjects already completed. The FE shows "No result returned from compute" or a gate error that's not actually about the edge in view.

**Root cause**: a `for subj in subjects:` loop lets per-subject exceptions propagate. The exception leaves the scenario loop and `_handle_snapshot_analysis`, becoming a 400 via FastAPI's `ValueError` handling. `per_subject_results` is discarded — including any successes already appended.

**Fix**: per-subject validation and gating must append a failure entry (`{subject_id, success: False, error: <message>}`) and `continue`, never raise. Scenario-level `success` becomes `any(s.get('success') for s in per_subject_results)`. The FE surfaces `response.error` when `response.result` is absent.

**Broader principle**: in any loop that collects per-item results for a batched response, item failures must become item-level failure entries, not exceptions. Reserve exceptions for whole-request invalidation (auth, malformed input, infra failure).

## Anti-pattern 51: React Fast Refresh failure on mixed-export context files

**Signature**: after editing a Context file (`XxxContext.tsx`), behaviour tied to that context silently stops working — effects don't fire, handlers feel stale, no progress indicators or regeneration for actions that used to produce them. TypeScript compiles cleanly, no runtime errors. The Vite console shows:

```
[vite] invalidate /src/contexts/XxxContext.tsx: Could not Fast Refresh ("useXxxContext" export is incompatible)
[vite] hot updated: /src/contexts/XxxContext.tsx
```

The page does **not** auto-reload.

**Root cause**: React Fast Refresh requires a module to export *either* only React components *or* only non-component values — not both. Context files that co-export the Context object, the Provider component, the `useXxxContext` hook, type interfaces, and helper functions violate this rule. Fast Refresh bails out and falls back to plain HMR: Vite swaps the module in, but the React tree keeps references to the **old** provider and hooks. New effects never re-subscribe; new closures never bind.

**Fix (immediate)**: hard refresh (`Ctrl+Shift+R`). This rebuilds the React tree against the new code.

**Fix (durable)**: split non-component exports out of the context file. Move the Context object, `useXxxContext`, `useXxxContextOptional`, and any type-only exports into a sibling file (`XxxContextHooks.ts`). Leave only `XxxProvider` in `XxxContext.tsx`. Fast Refresh then preserves state across edits.

**How to spot**: in long-running sessions, check whether the dev console has shown a previous `Could not Fast Refresh` warning for the file you're about to edit. If so, hard-refresh before testing your edit — otherwise you'll mistake the stale tree for a bug in your new code.

## Anti-pattern 52: Bare field name carrying multiple semantics

**Signature**: a single field name carries different meaning depending on upstream state, with no name-level signal. Reviewers reading a consumer call site can't tell which semantic they're getting. Code written assuming semantic A continues to compile and produce numerical output when the field carries semantic B.

**Root cause**: the emitting code path has a conditional overwrite or alias. When a higher-level state flag (a fitted parameter, a feature flag, a config option) is enabled, the field carries quantity X; otherwise Y. Alternative-flavour values may exist under suffixed names but those names are reserved for "audit" or "fallback" purposes rather than being the primary surface. Asymmetric naming ("bare name swaps meaning, _suffix names are stable") makes grep audits produce wrong answers.

**Fix**: rename so every field has stable, context-independent semantics. Use explicit suffixes for every variant — including the previously-bare one. Apply the convention uniformly across sibling and cousin field families; inconsistency between families is itself a footgun.

**How to spot**: scan for fields whose comment includes "when X" or "if Y" describing semantic content. The comment is the red flag — if a reader needs the comment to know what the value means, the name is inadequate. Grep for conditional-assignment patterns where the same field is populated in multiple branches with different quantities.

## Anti-pattern 54: Enumeration loophole reasoning against safety rules

**Signature**: agent performs an action that obviously violates the spirit of a documented rule, but justifies it on the grounds that the rule's enumerated trigger list does not literally name the specific command or pattern just used. Typical phrasings: "no git writes — just file copies", "this isn't a destructive command — it's a backup", "the rule lists `mv` but says nothing about `cp`". The pre-action reasoning trace shows the agent inspecting the listed examples, not the rule's stated intent.

**Root cause**: agent reasons over the *literal text* of an enumerated list rather than the rule's purpose. Whenever a safety rule is presented as "X, Y, Z, …" — whether in CLAUDE.md, a hook config, a permission file, or a comment — agents tend to treat the list as exhaustive. Anything outside it reads as authorised. Spirit-clauses ("any command that destroys uncommitted work") are routinely ignored when an enumeration is present, because the enumeration offers a cheaper, more decidable test ("is this string on the list?") than the spirit-clause's judgement call.

This is a structural problem with enumerated rules, not a bug in any specific rule.

**Fix**:

1. **Tool-level enforcement, not prose-level appeals**: a CLAUDE.md sentence saying "any operation that overwrites uncommitted work is gated" gets ignored when a hook config explicitly lists `rm`, `mv`, `truncate` and stops there. Ship the spirit *as enumerated patterns the hook actually catches*, not as an exhortation. The destructive-gate fix in `.claude/hooks/gates.json` (cp/mv/tee/dd/awk -i added 27-Apr-26) is the canonical example: prose alone leaks; the enumerated patterns close the leak.
2. **Audit enumerated lists for surface coverage**: every time a safety rule is added to a hook, ask "what other commands accomplish the same effect?" and add them. `cp` overwriting a file is functionally equivalent to `mv` overwriting it; `tee` without `-a` is a redirect overwrite; `dd of=` truncates; `awk -i inplace` rewrites. If the rule covers one, it must cover the others.
3. **Where enumeration is impossible**, treat any reasoning that begins "this isn't on the list, so…" as a stop signal and ask the user.

**Broader principle**: agents fill the gap between literal text and intent in the direction that minimises work, not in the direction the author meant. Enumerated rules will always have gaps; prose addenda do not close them. Enforcement must live at the tool layer, with the enumeration kept honest by ongoing audit.

**Where this matters in this repo**: any rule under CLAUDE.md "Pre-flight Checks" that lists triggering commands; the `.claude/hooks/gates.json` patterns; permission allowlists in `settings.json`. When in doubt, the hook config is authoritative — CLAUDE.md text is documentation, not enforcement.

## Anti-pattern 55: Pull merge absorbs local content into baseline

**Signature**: a file is dirty, you auto-pull and the merge succeeds. The next auto-pull (with the same dirty content still uncommitted) silently overwrites the file with remote, wiping the locally-merged additions. UI dirty indicators flicker off after the first pull. Symptom is most visible for files the user rarely edits directly (parameter YAMLs holding bayes posteriors, settings) because the user does not notice "I lost my dirty marker" the way they would for a graph file.

**Root cause**: after a successful 3-way merge, the writer sets `file.originalData = mergedContent` and `file.isDirty = false`. The first pull works correctly — local changes survive the merge. But `originalData` is now the merged result, not the remote baseline. On the second pull, the dirty-detection branch checks `hasLocalChanges = file.isDirty || (data !== originalData)` — both are false (data and originalData are now identical) — so the writer falls into the remote-wins branch (`finalData = remoteData`) and overwrites the file. The locally-merged content is lost.

**Fix**: post-merge, `file.originalData` must reflect the last known REMOTE state, not the merged result. `file.isDirty` must be `(merged !== remote)` — true whenever the merge absorbed local-only content. The `dagnet:fileDirtyChanged` event must report the actual post-merge state, not a hardcoded `false`. Do not set `isInitializing = true` after a merge — that re-engages the [TabContext.updateFile](src/contexts/TabContext.tsx) absorption path which folds the merged-in local content into `originalData` on the next normalisation pass, defeating the dirty preservation.

**Where this matters in this repo**: [`pullFile`](src/services/repositoryOperationsService.ts) and [`workspaceService.pullLatest`](src/services/workspaceService.ts). I-20a. The force-replace branch (explicit user-authorised "throw away local") correctly sets `originalData = remote, isDirty = false` — that path is not the bug.

## Anti-pattern 56: Window-event wiring across components is fragile

**Signature**: a button or menu item dispatches `window.dispatchEvent(new CustomEvent('foo:thing', { detail: { id } }))` and expects a single specific component to be mounted as a listener. The button is clicked, nothing happens, and the failure leaves no diagnostic trail because the dispatcher does not know whether anyone heard the event. Symptom is intermittent: works when the listener is mounted, silent when it is not.

**Root cause**: window-event coupling depends on a downstream component happening to be mounted with a closure over the right id. ReactFlow virtualisation, tab switches, alternate viewing surfaces (canvas vs chart-viewer-tab), or stale closures with the wrong id can all break the wiring without producing any error. The dispatcher has no `await listener.success` — `dispatchEvent` returns synchronously regardless of whether anyone handled the event.

**Fix**: replace the window event with a per-id registry — a module-level `Map<id, fn>` that the consuming hook registers/unregisters into via `useEffect`. The button calls `serviceFunction(id)` directly, which looks up the registered fn and either invokes it or surfaces a visible warning when nothing is registered. Failure becomes loud (console warning) instead of silent. The registry pattern also lets the service-level function do work even when no consumer is mounted (e.g. clear caches), so the fallback case is meaningful rather than degenerate.

**Where this matters in this repo**: the canvas-analysis refresh button used `dagnet:canvasAnalysisRefresh` listened only by `CanvasAnalysisNode`; replaced 29-Apr-26 by `canvasAnalysisRefreshRegistry` ([src/services/canvasAnalysisRefreshRegistry.ts](src/services/canvasAnalysisRefreshRegistry.ts)). The bayes-posteriors-updated event survives because it is genuinely broadcast (every mounted `useDSLReaggregation` hook should re-project its own graph) — that case is appropriate for an event. The refresh-button case was inappropriate because it targeted a single specific component instance.

## Anti-pattern 53: Dead-caller residue in shared merge / dispatch helpers

**Signature**: a helper that combines, merges, or dispatches between multiple inputs has an asymmetric branch — one set of fields handled with one precedence rule, another set with a different rule. The asymmetry has no documented justification at the call site, and producing the symptom requires the function to be called in a regime the asymmetry was not designed for. The function may have a name advertising the now-bypassed behaviour ("…Preserving…", "…Canonical…", "…Authoritative…").

**Root cause**: the helper had multiple callers when written, and the branch was load-bearing for one of them — typically a defence against partial / transient / lower-trust output from one caller, where preserving an existing value made sense. A later refactor removed the demanding caller without revisiting the helper's contract. The branch survives and now applies to a sole remaining caller for which the original rationale doesn't hold.

**Fix**: when removing a caller of a shared helper, re-read each branch with one question: "is this still earning its keep against the surviving callers?" If not, simplify. Asymmetries between sibling families of fields (edge-local vs path-level, primary vs derived, fitted vs preserved) where the only remaining caller treats them uniformly should be flattened. If the function name advertises removed behaviour, rename — names that lie are landmines.

**How to spot**: investigating "stale value persists across what should be a re-fit" symptoms — look for shared merge functions in the data-flow path. `git log -S '<helper_name>' --all -- <file>` finds the introducing commit; if a multi-caller diff has since lost a caller, the surviving branches are suspect.

---

## Moved entries (subsystem-specific traps)

These were moved to the doc that owns the relevant code. Cited references by number still work — Ctrl+F the destination doc.

| # | Title (abbrev) | Moved to |
|---|----------------|----------|
| 9  | Suppression window race during rapid mutations | `SYNC_ENGINE_GUARD_STATE_MACHINE.md` |
| 10 | Assuming `isInitializing` is false | `FILE_REGISTRY_LIFECYCLE.md` |
| 12 | Unprefixed IDB key in file lookups | `INDEXEDDB_PERSISTENCE_LAYER.md` |
| 14 | Adding fields to Python types but not to `_build_unified_slices` | `BE_RUNNER_CLUSTER.md` |
| 16 | E2E test seeding IDB but assuming FileRegistry is populated | `INDEXEDDB_PERSISTENCE_LAYER.md` |
| 19 | Conflating distinct DSL concepts in a single variable | `DSL_SYNTAX_REFERENCE.md` |
| 23 | js-yaml Date conversion corrupts context-definition hashes | `HASH_SIGNATURE_INFRASTRUCTURE.md` |
| 27 | Confusing context-hash filtering with context-value filtering | `HASH_SIGNATURE_INFRASTRUCTURE.md` |
| 28 | Duplicate hash-computation codepaths | `HASH_SIGNATURE_INFRASTRUCTURE.md` |
| 31 | Regex not handling optional prefixes in DSL clauses | `DSL_PARSING_ARCHITECTURE.md` |
| 33 | Per-subject random effects on hazard parameters | `BAYESIAN_ENGINE_RESEARCH.md` |
| 35 | Edge ID key order mismatch (uuid-first vs id-first) | `GRAPH_MUTATION_UPDATE_MANAGER.md` |
| 37 | Devtool "clear" action that destroys diagnostic data | `DEVTOOL_ENGINEERING_PRINCIPLES.md` |
| 38 | Devtool script with unvalidated side effects on shared state | `DEVTOOL_ENGINEERING_PRINCIPLES.md` |
| 39 | Graph JSON regeneration strips critical metadata | `BAYES_REGRESSION_TOOLING.md` |
| 40 | `--rebuild --no-mcmc` no-op for synth data | `BAYES_REGRESSION_TOOLING.md` |
| 41 | Enrichment results bypassing UpdateManager sibling rebalancing | `FE_BE_STATS_PARALLELISM.md` |
| 44 | Weak Beta prior overwhelmed by per-cohort IS conditioning | `BAYESIAN_ENGINE_RESEARCH.md` |
| 45 | ECharts legend `data` referencing empty-data series | `ANALYSIS_ECHARTS_BUILDERS.md` |
| 46 | Synth graph hash divergence from connection-string inconsistency | `BAYES_REGRESSION_TOOLING.md` |
| 47 | `cohort_alpha`/`cohort_beta` vs `alpha`/`beta` confusion | `SNAPSHOT_FIELD_SEMANTICS.md` |
| 49 | ECharts legend icon using default palette when series `color` is omitted | `ANALYSIS_ECHARTS_BUILDERS.md` |

Merged into other anti-patterns:

| # | Title | Merged into |
|---|-------|-------------|
| 20 | Single-scenario parity test missing multi-scenario defects | AP17 |
| 36 | Latency bead gate checking data presence not enablement | AP18 |
| 50 | Routing non-latency edges by `sigma <= 0` heuristic | AP18 |
| (second) 39 / (second) 40 | Reimplementing FE pipeline / vacuous synth-graph tests | AP17 |

## Removed entries

Removed because they duplicate guidance already in CLAUDE.md or warm-start docs:

- **AP2** (Fixing one call site, missing others) — duplicated by CLAUDE.md core principle 2.
- **AP7** (Patching the symptom, not tracing the root cause) — duplicated by `DEBUGGING_DISCIPLINE.md` root-cause gate.
- **AP8** (Testing the mock, not the system) — duplicated by `TESTING_STANDARDS.md`.

Removed because they describe an open issue rather than a recurring pattern:

- **AP34** (Phase 2 onset_cohort drift on deep join-node paths) — open research issue, lives in `project-bayes/programme.md` and `project-bayes/18-compiler-journal.md`.

Removed because the surface no longer exists:

- **AP43** (CLI topo pass not scoping to query DSL) — `--topo-pass` flag and supporting code removed by doc 73b.
