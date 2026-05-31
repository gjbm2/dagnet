# Known Anti-Patterns

Failure patterns that have occurred in this codebase and recur across surfaces. If your current bug matches a signature here, apply the known fix — don't re-derive it.

This list is deliberately short. Subsystem-specific traps that only apply to one file or function live next to that code, in the relevant doc under `docs/current/codebase/`. See the **Moved entries** table at the end for redirects, and the **Removed entries** list for ones that are now duplicated by CLAUDE.md or other warm-start docs.

Numbering is non-contiguous and stable: cited numbers (e.g. "see anti-pattern 23") keep working even after a move. New entries take the next free integer. **Recent high-impact entries may appear out of numerical order at the top of the list for prominence; their numbers remain stable.**

## When to add an entry here

Three tests an entry must pass:

1. **Re-derivable?** If the trap can recur in a different part of the codebase, it belongs here. If the fix is in code and the architecture has been refactored so the trap can't recur, the commit message is the right home.
2. **Symptom-first?** A useful signature lets an agent recognise the trap **before** knowing the diagnosis. If the signature only makes sense after you've solved it, rewrite it.
3. **Pattern, not fact?** Single-subsystem traps belong in the subsystem doc next to the function they constrain — they'll actually be in scope when the agent is editing the relevant code. This doc is for cross-cutting patterns.

After completing a multi-attempt fix, ask: would an agent in a different subsystem plausibly hit this same shape of bug? If no, it's a subsystem fact — write it up there.

**Open inventory not yet here**: the CF defensive-coding audit ([`cf-defensive-coding-audit.md`](../project-generalise/cf-defensive-coding-audit.md), 12-May-26) documents 21 findings (7 HIGH, 9 MEDIUM, 5 LOW) across the CF runtime — `or 0.0` cascades, `np.clip` boundary corruption, `try/except: pass` swallow, identity-carrier branching explosion, and five parallel `ΣY / ΣX` code paths. These are not yet entries here because they require substantial multi-file remediation and are blocked on architectural decisions (H-5 identity-carrier unification, H-2 funnel zero-substitution, F-1 mass-first reducer unification). As each finding is remediated, the corresponding cross-cutting pattern should migrate here so future agents recognise the trap. Tracker: [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md). The shared structural pattern most violations embody is already captured here as AP58 ("forking by case instead of degenerating one path") and is codified as [INVARIANTS.md](INVARIANTS.md) I-47 / I-48.

---

## Anti-pattern 1: Clearing state from one layer only

**Signature**: you delete or clear a field, it appears to work, but the old value comes back — or it works once and fails on the second run.

**Root cause**: state lives in 4 layers simultaneously:

1. Parameter file (FileRegistry / IDB) — `file.data.posterior` (slice library)
2. Source ledger on the graph edge — `edge.p.model_vars[bayesian].{probability, latency, quality, fit_diagnostics}`. Written by `bayesPatchService.applyPatch`, by `posteriorSliceContexting` on DSL change, and by the `_migrateBayesianPosteriorToSourceLedgerInPlace` on-load migration (post 30-Apr-26 unification).
3. Graph edge projected value — `edge.p.posterior`, `edge.p.latency.posterior`. Written **exclusively** by `applyPromotion` from layer 2 post-unification.
4. React render tree — whatever reference React last saw via `setGraph`

(Pre-unification graphs may also carry `edge.p._posteriorSlices` as a transient FE re-projection cache; this is no longer written on the live edge but legacy share bundles and IDB snapshots can still arrive with it.)

UpdateManager mapping configurations (`updateManager/mappingConfigurations.ts`) project param-file fields onto graph edges. The file and the edge are separate copies, not references. Clearing layer 1 alone is useless. Post-unification, clearing layer 3 alone is useless too — the next promotion re-projects from layer 2.

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

## Anti-pattern 59: "Architecturally complete" stage closure with the new path default-OFF

(Listed here out of numerical order for prominence. Number 59 is stable for citation.)

**Signature**: a multi-stage rewrite plan reaches its final stage with every "completed" stage's note containing an "Open follow-ups" section that lists the actual numerical work. The new code path sits behind feature flags. The flags default to OFF. Every test marker that was supposed to flip green still XFAILs. The legacy code the rewrite was meant to replace is still authoritative on every production request. The `git log` shows weeks of work; the runtime behaviour is unchanged.

**Root cause**: each stage's implementer discovered the numerical migration (likelihood, evidence fetching, fixed-seed retirement, dead-code deletion) was harder than the architectural plumbing. They built the architecture, declared the stage "architecturally complete", recorded the parity gap as a follow-up "for the next stage", and moved on. The next stage inherited the deferral. Repeat across every stage. Flag-OFF means the legacy path runs, so the test suite stays green by virtue of *not exercising the new code at all* — every "tests pass with flag OFF" assertion in a stage note is meaningless as a correctness signal for the new code.

The choreography pattern in plan §"Migration choreography" sections — `build behind flag → flip flag ON → prove parity → delete legacy` — is correct and necessary. The failure mode is stopping at step 1 and calling it done. Step 1 is the easy half.

The compounding harm:

1. **Components silently get missed.** Numerical work the architecture sat in front of (likelihood reweighting, per-edge evidence retrieval) is recorded in a follow-up bullet and forgotten.
2. **The new code is never tested under production conditions.** Flag-ON parity is the only meaningful correctness signal, and it isn't run. Every stage that "passed" passed by avoiding its own deliverable.
3. **The deletion debt grows, not shrinks.** Every stage adds a new parallel surface; none retire the legacy one. By the final stage there are two architectures in the tree, the old one authoritative, the new one rotting.
4. **The strict-xfail markers stop working as a signal.** They are designed to XPASS when the work lands; with the work deferred, they all sit unfired across stages, multiplying.

**Fix**:
- Stage closure must include a flag-ON parity measurement against the legacy oracle. "All tests pass with flag OFF" is *not* a stage acceptance signal — it proves nothing about the new path.
- A stage that defers numerical parity is **incomplete**. Mark it `- [/]` (in-progress with deliverables outstanding), not `- [x]`. Do not "tick the box" until the cutover step is done.
- "Open follow-ups" sections in stage notes must be tracked as numbered deliverables that block the next stage's progress, not soft lists. If a follow-up was deferred from stage N to stage N+1, it is the *first atom* of stage N+1, not pushed forward again.
- The `--strict` xfails the plan defines as flip-to-green targets are the closure signal. If they don't XPASS by the time the stage that names them is "complete", the stage isn't complete.
- The dead-code audit named in a plan's choreography section is mandatory and not deferrable. If anything the plan said should be removed remains reachable, the cutover isn't done.

**Why this recurs**: every individual decision feels reasonable in isolation. "I built the plumbing. The numerical gap is a separate concern. Let me declare what I built and move on." The cumulative effect — months of effort behind an OFF flag, dead code growing on both sides of the flag boundary, every test xfail rolling forward unkilled — is invisible from inside any single stage. It surfaces only at the next plan iteration: someone walks the strict xfails and discovers none have flipped. By then there are 12 markers, 7 deferred follow-ups, and a parallel architecture nobody is exercising.

**Smell to watch for**: a stage note whose acceptance criteria table contains the phrase "**Architecture discharged, semantics deferred**" (or any rephrasing — "architectural connectivity proven, full retirement deferred"; "architecture complete, flipping to ON in production blocked by …"). That phrase, in any form, means the stage is not complete. The follow-up must land before the box is ticked.

**Realised instance** (2-May-26): 73n stages 5a, 5b, 5c, 6, 7, 8 each closed in this pattern. Maturity-aware likelihood migration deferred from 5a → 5b → 6 → "Stage 7 or a dedicated post-Stage-6 follow-up" → never. Seven fixed-seed RNG sites named for migration in stages 2/5b/6 untouched. Per-upstream-edge evidence fetching deferred from Stage 6 to follow-up #2. `test_v3_midline_at_saturation_converges_to_p` defect deferred to "re-evaluate at Stage 9". F14 Q1 flag-ON parity gap measured at −0.167 in Stage 5a; ignored at every subsequent stage. Final-stage discovery: zero of the 12 strict-xfails the plan defined as flip-to-green targets had flipped, and the legacy trajectory engine, AP58 fork, `build_upstream_carrier`, Tier 2/3, and weak-prior carrier timing were all still authoritative on the production-default path. Full forensics: [`docs/current/project-bayes/73n-stage-5a-note.md`](../project-bayes/73n-stage-5a-note.md) §5.1, [`73n-stage-6-note.md`](../project-bayes/73n-stage-6-note.md) §3, [`73n-stage-7-note.md`](../project-bayes/73n-stage-7-note.md) §3, [`73n-stage-8-note.md`](../project-bayes/73n-stage-8-note.md) §3.

## Anti-pattern 6: Blaming HMR / code staleness without proof

**Signature**: agent says "this might be a stale code issue" or "try refreshing the page" without evidence.

**Root cause**: HMR failures are rare and have visible symptoms (console errors, yellow toast). The actual cause is almost always state propagation, IDB prefix mismatch, or sync suppression.

**Fix**: run `scripts/dev-server-check.sh <file-you-edited>` before blaming HMR. If FRESH, the problem is your code. If STALE, check the dev-server pane for syntax/import errors blocking the reload. See `DEV_ENVIRONMENT_AND_HMR.md`.

## Anti-pattern 11: Read paths computing signatures from graph config, not stored state

**Signature**: a read-path surface (@ menu, planner, coverage UI) computes a signature independently and gets a different hash from what the write path stored. The surface shows "no data" despite data existing in the DB.

**Root cause**: the read path derives context keys from graph-level config (e.g. `dataInterestsDSL`) rather than from what slices were actually stored in parameter files. Graph config may include all context dimensions (3 MECE keys) while each individual fetch used one key per slice. Different context keys → different context-definition hashes → different `core_hash` → no DB match.

**Fix**: read paths must derive context keys from the **stored slice topology** (`parameterFile.data.values[].sliceDSL`), not from any graph-level config. Enumerate all plausible context key-sets from stored slices and query the DB with all of them. See `enumeratePlausibleContextKeySets` in `snapshotRetrievalsService.ts`.

When multiple context dimensions produce multiple hashes for the same edge, the BE selects one hash per `retrieved_at` date to avoid double-counting. See `snapshot_regime_selection.py`.

## Anti-pattern 12: Overloading a maturity signal as a prior-strength gate

**Signature**: a Bayesian-style blend (prior + evidence → posterior) appears to behave correctly until you feed it a fully mature scope with little or no evidence in it, at which point the answer collapses to the raw observed rate (or to zero if `k=0`) regardless of sample size. Tests "evidence dominates at maturity" pass under modest `n`. Empty-scope queries publish nonsense like `p.mean = 0`.

**Root cause**: a maturity / completeness signal is being consumed in two places — as a discount on the evidence count (principled) AND as a discount on the prior pseudo-count (not principled). The standard Beta-binomial conjugate update is `posterior_mean = (α₀ + k) / (m₀ + n)` where `m₀` is a property of the prior, not of the evidence. Coupling `m₀` to maturity is not a textbook inference procedure; it manufactures "absence of evidence ⇒ evidence of absence" the moment maturity hits its ceiling.

**Fix**: keep the maturity signal in exactly one role — discounting the evidence count (`nEff = c · n`). Leave `m₀` untouched. Empty / maturity-discounted evidence then falls out as `w = nEff / (m₀ + nEff) → 0`, returning the prior naturally — no special-case branch needed. See [PROBABILITY_BLENDING.md](PROBABILITY_BLENDING.md) §2-3 and the FE topo blend formula change of 29-Apr-26 for the canonical case.

**Why this recurs**: the symptom that motivates the prior-fade ("at full maturity the prior should disappear, otherwise we're under-weighting hard-won data") sounds intuitive and is wrong. The correct response to "evidence is overwhelming the prior should die" is `n → ∞` overwhelming `m₀`; if that doesn't happen for typical `n`, the calibration of `m₀` is too strong, not the formula's structure.

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

**Root cause**: a `for subj in subjects:` loop lets per-subject exceptions propagate. The exception leaves the scenario loop and `_handle_snapshot_analyze_subjects`, becoming a 400 via FastAPI's `ValueError` handling. `per_subject_results` is discarded — including any successes already appended.

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

## Anti-pattern 57: Relative-DSL test silently slides into vacuity as wallclock advances

**Signature**: a Python CLI test using `window(-Nd:)` / `cohort(-Nd:)` / `cohort(<anchor>,-Nd:)` was passing when committed and is still passing months later, but the assertion is no longer testing what the author intended. Runtime trace shows the BE is computing curves from posterior-only because the resolved window has zero overlap with synth fixture data. The pass is the AP17 vacuous variant — both sides of any comparison agree trivially because both are the prior projection.

**Root cause**: the relative form resolves at request time against the BE's `date.today()`. Synth fixture data spans a fixed window (12-Dec-25 to 21-Mar-26 for most current synths, deterministic from `bayes/synth_gen.py` `base_date` + `n_days`). Once wallclock advances past `fixture_end + N`, the relative form `-Nd:` resolves to a window entirely outside fixture range. The test continues to "pass" because zero-evidence behaviour is symmetric across whatever modes the test compares (window vs cohort, v2 vs v3, etc.), but it is no longer exercising the population model. `-1d:` / `-7d:` / `-14d:` / `-30d:` are already vacuous against current synths today (29-Apr-26).

The non-obvious extra: this is **silent** because most affected tests are symmetric-comparison tests where the assertion remains satisfied even in the zero-evidence regime. Pass/fail status doesn't flip; only test value erodes. There is no infrastructure signal warning the test has gone vacuous.

**Fix**: pin DSL scope to the today's-resolution at pin date, e.g. `window(-90d:)` → `window(29-Jan-26:29-Apr-26)` if pinned on 29-Apr-26. Encode the pin date in a comment so a future reader can reconstruct the intent. Do NOT pin to the synth's full data span (widens `sweep_to` unnecessarily); do NOT add `.asat()` as a wallclock-freeze (introduces six confounding asat code paths). For tests where the assertion itself reads drift-coupled quantities (max-τ, chart length, last-row, forecast horizon), re-author the assertion to anchor on specific τs or anchor days before pinning.

For `-1d:` / `-7d:` and other narrow forms, pinning isn't enough — the authoring intent is ambiguous between "vacuous-by-design" (replace with explicit out-of-fixture absolute) and "narrow-real-evidence" (replace with absolute narrow window inside fixture, possibly with a synth modification). Surface the ambiguity to the user; don't pick silently.

**Where this matters in this repo**: see `docs/current/test-wallclock-flakiness-audit.md` for the per-test ledger and `TESTING_STANDARDS.md` §"Wallclock invariance for date-DSL tests" for the canonical hardening pattern. As of 29-Apr-26, ~190 occurrences across 20 test files; `test_cohort_factorised_outside_in.py` partly hardened (17 of 26 in-scope tests pinned).

**Broader principle**: test fixtures and test DSL must encode their *required preconditions explicitly*. A relative form like `-90d:` is an implicit dependency on "today, when this is run, is within the fixture's evidence window" — a precondition the test doesn't state and CI doesn't check. Relative forms in test code are an evergreen source of silent rot; treat them as a smell.

## Anti-pattern 58: Forking by case instead of degenerating one path

**Signature**: a new case (window vs cohort, single-hop vs multi-hop, latency vs non-latency, scalar projection vs chart rows) is implemented by branching to a parallel function or class instead of letting the existing path produce it. Two functions claim to compute "the same thing" via different code. Fixes work in one mode and reappear in the other a week later. Tests pass for the canonical case but fail in subtle ways for the degenerate edge — or vice versa. Behaviour converges where the cases happen to overlap and diverges where they should agree most strongly.

**Root cause**: the engineer thinks of the new case as different because it has a different name, different DSL, or different UI affordance, and reaches for a new branch. The cases are actually *one runtime object* specialised differently. `cohort()` is `window()` with an additional carrier-arrival object that degenerates to identity in the window form; non-latency is latency with a `δ(0)` lag distribution (any cohort with age > 0 has completeness = 1); single-hop is multi-hop with a one-edge subject span. Each new branch is a copy of the resolution chain that has to be kept in sync by hand. They drift.

A second variant: a downstream projection (chart row, CF scalar, graph-enrichment field) grows its own carrier / subject-span / `p∞` logic because the upstream object didn't carry the information it needed. The projection is now re-deciding semantics the resolution chain already decided, and the two answers can disagree silently.

**Fix**: identify the single resolved runtime object that all cases project from. The new case must differ only by which sub-object degenerates. If the existing path can't accommodate the new case without an `if mode == ...` near the centre, the path is wrongly factored — fix the factoring before fixing the case. For projection-layer drift: move the missing information up into the resolved object, then make the projection a readout. Existing realisations in this repo: `enhanceGraphLatencies` runs the same conjugate-blend for latency and non-latency edges (I-43, I-44); the BE cohort-forecast machinery resolves one `population_root → carrier_to_x → subject_span → numerator_representation → p_conditioning_evidence → projection` object for window, cohort, single-hop and multi-hop (`docs/current/project-bayes/73g-general-purpose-f14-problem-and-invariants.md`).

**Why this is its own anti-pattern, not just "no duplicate code paths"**: the duplicate-path rule says *don't copy*. This anti-pattern says *how to specialise without copying* — by degenerating sub-objects of one resolved chain. Agents who only know the duplicate-path rule still fork by case, because each fork looks locally non-duplicative ("it's a different case"). The fix template is what's load-bearing.

**Realised closure** (73n landed, ~2-May-26): the `build_cohort_evidence_from_frames` second-variant AP58 fork on the count axis is closed. 73n's request-scoped primitive registry + composition pass + projection pass made projection a readout of composed primitives rather than a local evidence rebuild: the `is_window`-gated population fallback / carrier-projection rebuild is gone, the builder's docstring now forbids rebuilding an upstream carrier (`graph-editor/lib/runner/cohort_forecast_v3.py`, function now at ~:1701), and `is_window` survives only as a `temporal_mode` label translated once at the engine entry (`Everything below … consumes these, never is_window`). The legacy trajectory engine that consumed the fork's divergent evidence has itself been deleted (no `compute_forecast_trajectory` definition remains; only stale comments). The four strict-xfail tests in `test_cohort_factorised_outside_in.py` that named this fork have had their markers removed and now pass. Full record in [`docs/current/project-bayes/73m-stage-0-baseline.md`](../project-bayes/73m-stage-0-baseline.md) §§9-12; 73n landing in the project-bayes 73n stage notes.

**Realised closure** (26-May-26, selected-cohort projection cutover): the BE cohort-forecast row *reducer* fork is closed. The legacy reducer `_selected_cohort_group_rate_draws` carried ~10 `if identity_carrier:` branches (audit H-5); it is deleted and replaced by `model_span_spine.project_selected_cohort_rows` — a mode-blind single-DP-core reducer that reads one conditioned/model operator and one empirical-evidence operator. `window()`, identity-carrier `cohort(A=X)`, and active `cohort(A≠X)` are produced by which operator family degenerates; no mode flag is read inside the reducer (guarded by `test_reducer_is_mode_blind_against_a_mode_field`). The legacy `rate_blended = empirical × coverage + model × (1 − coverage)` linear blend and the abandoned `rate_adjusted` / IPW coverage replacement are both removed: strict empirical evidence is the sole observed-evidence authority and `coverage` is a display applicability/freshness signal only. (This is the reducer fork, distinct from the upstream `build_cohort_evidence_from_frames` evidence-builder fork above, which 73n owns.) See [`docs/archive/project-generalise/selected-cohort-projection-cutover-plan.md`](../../archive/project-generalise/selected-cohort-projection-cutover-plan.md).

## Anti-pattern 60: Cumulative-MC drift mistaken for structural bug

**Signature**: a fixture-based test compares a chart's cumulative count (`evidence_y`, `evidence_x`, or any monotonically-increasing realised quantity) against an MC oracle. The chart-vs-oracle delta is the same sign across many consecutive cells (e.g. `+1.0% to +1.5% across τ ∈ {15..38}`, 24 cells in a row). The agent reads this as "the chart has a structural bias, no random walk would stay positive for 24 cells", and starts hunting a quadrature, off-by-one, or kernel bug. After landing the "fix", the next seed shows a different sign or a different shape; the chart is then "fixed" the other way; the cycle repeats.

**Root cause**: the oracle reads cumulative counts. `Y(τ) = Σ_{u ≤ τ} (incremental conversions at age u)`. Successive `Y(τ)` and `Y(τ+1)` share most of their content — they're highly autocorrelated by construction. One realised cumulative path that lands +1σ at τ=15 will *almost certainly* still be near +1σ at τ=16, τ=17, ..., τ=30. The "consistent same-sign drift across many τ" is one realisation of a correlated cumulative random variable, not 24 independent failures.

The independent-cell intuition that justifies "this can't be random" applies to *increments*, not cumulatives. The increments `Y(τ+1) − Y(τ)` are roughly independent. The cumulatives are not.

**How to spot before chasing the wrong bug**: re-run the same fixture and DSL with a different RNG seed (change `seed:` in the truth YAML, regen). If the chart-vs-oracle drift profile *changes sign or shape* across seeds while the chart-vs-continuous (analytic) profile stays the same, the chart is correct and the symptom is correlated MC noise. If the chart-vs-continuous profile is also seed-invariant and matches the chart-vs-oracle profile, the chart has a real structural bug. The two probes together — chart vs continuous (deterministic) and oracle vs continuous (seed-noisy) — disambiguate cleanly.

**Fix**: don't fix the chart; fix the test envelope. Either (a) engineer the fixture to push σ_relative below tolerance (raise `p` toward 1.0, widen the cohort window for more anchor days, or bump `mean_daily_traffic` for more population — the cohort widening is usually the highest-leverage knob because tolerance scales linearly with expected while σ scales as √n), or (b) widen the tolerance to the actual fixture noise floor (combined chart structural drift + oracle σ_relative, with a 2σ headroom). Both preserve test intent. See [TESTING_STANDARDS.md](TESTING_STANDARDS.md) §"Tolerance against fixture noise floor" for the canonical sizing recipe.

**Realised instance** (8 to 9-May-26): SIMPLE-flat `test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle` failed at τ=15-17 with chart-vs-oracle Δ ≈ -1.0 to -1.4% on seed 4242. The first reading was "chart has a +3% structural bias on the rising flank". A Simpson-style curvature correction in `_interpolated_rate_at` legitimately closed ~3% to ~0.3% (the chart did have a quadrature residual, separately documented). But the residual ~0.5-0.7% gap that remained — failing 5 cells in a row — was reflexively read as "another chart bug". A multi-seed probe (seeds 4242, 4243, 7777 at the higher-resolution fixture) showed chart-vs-continuous was essentially seed-invariant (+0.0% to +0.3% across seeds), while oracle-vs-continuous varied wildly (-1.6% to +2.2%). Different seeds gave different cells failing. That confirmed correlated MC noise on the oracle, not a chart bug. Closure landed via fixture engineering (richer `p`, wider cohort) plus tolerance widening to the actual noise floor (`max(50, 0.75%)`), as documented in the regression tracker.

**Why this recurs**: same-sign drift across many cells is *visually* indistinguishable from structural bias to an agent reasoning about one snapshot. The "this can't be random" reflex is correct for *independent* cells and wrong for *cumulative* cells. The codebase has many cumulative quantities (snapshot oracle counts, prefix sums, age-cumulative coverage); any test asserting on them at fixture scale is exposed.

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
