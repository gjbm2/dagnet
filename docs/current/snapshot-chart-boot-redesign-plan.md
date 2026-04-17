# Analysis Boot Coordinator Redesign Plan

**Status**: Draft  
**Last Updated**: 10-Mar-26  
**Owner**: Analysis boot redesign

---

## Purpose

This document replaces the current per-chart boot and retry model with a clean-sheet analysis boot design.

The requirement is simple:

- the app should settle
- analysis dependencies should be present
- analyses should then compute once, reliably

This is not a canvas-only problem. Canvas charts are only the surface most heavily exercised so far. Chart tabs and any other analysis surface using the same boot assumptions should be treated as affected unless proven otherwise.

---

## Problem Statement

Analysis boot is currently distributed across individual charts, hooks, ReactFlow reconciliation, and best-effort file hydration. That is the wrong abstraction boundary.

The current failure pattern is:

- each analysis surface tries to infer whether the app has settled
- each analysis instance can block itself, hydrate files, subscribe to updates, retry, or skip
- ReactFlow mount timing leaks into correctness for canvas analyses
- chart tabs are likely to have the same defect through the same underlying assumptions
- workspace restoration, file hydration, and compute start are not coordinated by a single owner

The product requirement is not “teach every chart how to survive boot races”. The requirement is “do not let analyses start until their compute context is ready”.

---

## Scope

This redesign applies to all analysis hosts:

- canvas analyses inside graph tabs
- standalone chart tabs
- panel-based analysis surfaces if they share the same compute path

Snapshot-backed analyses are the strictest consumer because they need extra artefacts. They are not the only consumer of the boot model.

---

## First-Principles Design

### Core Rule

Analyses must not own boot orchestration.

An individual analysis instance should not decide:

- whether workspace restore is still in progress
- whether scenario state is ready
- whether planner artefacts still need hydrating
- whether file registry updates are complete enough
- whether it should subscribe and retry itself

Those decisions must be centralised in one coordinator for the compute context.

### Single Source Of Truth

Introduce one explicit analysis boot coordinator that owns a single settled/not-settled decision and a monotonic ready epoch for each analysis compute context.

The coordinator should be the only place that answers:

- what is the source graph and workspace for this analysis host
- has the underlying app state restored
- is scenario/query state available
- what artefacts are required for this analysis set
- are those artefacts present
- is this compute context now safe to run

### Compute Context

A compute context is the minimum state needed to decide whether analyses may compute. It includes:

- source graph identity
- workspace identity
- scenario and query state
- host type
- required artefact set for snapshot-backed analyses

Hosts may differ, but the boot contract must be the same.

### Expected Flow

1. A host is restored or opened.
2. The coordinator derives the compute context for that host.
3. The coordinator waits for general restore to finish.
4. The coordinator collects the union of required artefacts for all analyses in scope.
5. The coordinator hydrates any missing artefacts centrally.
6. The coordinator waits for required artefacts to be present.
7. The coordinator publishes a new ready epoch.
8. Analyses compute only when the host is in that ready epoch.

---

## Design Goals

- An analysis either waits or computes. It does not orchestrate boot.
- All boot work happens once per compute context, not once per chart.
- Host type must not change correctness.
- ReactFlow mount order must not affect eventual compute correctness.
- Dependency hydration must happen before snapshot-backed analysis compute begins.
- The system must expose one explicit readiness state and one explicit ready epoch.
- Reloading a host must be deterministic and repeatable.

---

## Explicit Non-Goals

- Do not preserve the current per-chart retry and rescue behaviour.
- Do not add more duplicate guards, retry timers, or local subscription heuristics.
- Do not keep correctness dependent on transient chart caches.
- Do not let analyses trigger planner hydration themselves.
- Do not keep diagnostic-ledger code as part of the runtime control path.

---

## Current Approach To Remove

### 1. Per-analysis boot orchestration in `graph-editor/src/hooks/useCanvasAnalysisCompute.ts`

Remove chart-local logic that tries to manage application boot from within an analysis hook, including:

- local blocked and ready state for boot sequencing
- local planner-input hydration triggers
- local file-registry subscriptions for planner artefacts
- local registry version bumping to force retries
- local retry and duplicate-guard boot control
- local rescue paths tied to seeded stale results

After redesign, this hook should only:

- consume coordinator readiness and epoch
- build compute inputs
- run compute when allowed
- expose normal loading, result, and error state

### 2. Planner-hydration-as-analysis-behaviour in `graph-editor/src/services/analysisComputePreparationService.ts`

Retire the idea that compute preparation returns long-lived blocked boot states that individual analyses must manage.

If retained, this service should become a pure compute-input builder used only after the coordinator has declared the compute context ready.

### 3. Analysis-owned dependency hydration in `graph-editor/src/services/snapshotSubjectResolutionService.ts`

Remove the role of this module as a best-effort boot hydrator called from individual analyses.

This module may keep pure helper logic for:

- enumerating required snapshot planner artefacts
- resolving snapshot subjects once artefacts exist

It should not remain the owner of boot-time mutation loops triggered by analyses.

### 4. ReactFlow coupling in `graph-editor/src/components/GraphCanvas.tsx`

Remove reliance on correctness emerging from ReactFlow sync and remount behaviour.

Canvas analyses must not depend on whether ReactFlow:

- reused a node
- remounted a node
- skipped a sync as unchanged

Graph canvas should consume coordinator state, not serve as an implicit boot engine.

### 5. Boot diagnostics as a control surface

The boot ledger and readiness traces in:

- `graph-editor/src/lib/snapshotBootTrace.ts`
- `graph-editor/src/components/nodes/CanvasAnalysisNode.tsx`
- `graph-editor/src/components/GraphCanvas.tsx`
- `graph-editor/src/hooks/useCanvasAnalysisCompute.ts`

should be downgraded to diagnostics only. They must not shape runtime correctness.

### 6. Detailed inventory of investigation-era additions to unwind

This section is intentionally explicit. We have added multiple layers of local boot handling, recovery, instrumentation, and test scaffolding during this investigation. The redesign must unwind them deliberately rather than leaving half-retired machinery in place.

The right stance is:

- do not blindly delete everything at once
- first replace the ownership model
- then remove each obsolete control path
- keep only pure helpers and genuinely useful diagnostics

#### `graph-editor/src/hooks/useCanvasAnalysisCompute.ts`

This hook is currently carrying far more responsibility than a compute hook should.

Investigation-era behaviour now present here includes:

- chart-local blocked state via `PreparedAnalysisComputeState`
- workspace gating for snapshot-backed analyses
- prepare-version bookkeeping to stop stale async prepare completions
- planner-file subscriptions through `fileRegistry.subscribe(...)`
- `registryVersion` bumping to force local re-prepare loops
- chart-local calls to `hydrateSnapshotPlannerInputs(...)`
- duplicate-run suppression via `activeRunKeyRef` and `completedRunKeyRef`
- seeded-result rescue via `canvasAnalysisTransientCache`
- long-lived result sharing via `canvasAnalysisResultCache`
- special-case retry logic for branch-comparison time-series mismatches
- chart-local `waitingForDeps` semantics that drive `"Loading chart dependencies..."`
- extensive readiness tracing and boot-ledger stage emission

Analysis:

- This hook has effectively become a mini boot coordinator plus compute runner plus cache manager plus debug probe.
- It now owns decisions about when the app is ready, when hydration should start, when to retry, and when a result is safe to reuse.
- That is exactly the architectural mistake this redesign is trying to remove.
- The hook is also now coupled to `FileRegistry`, workspace source metadata, planner artefact restoration, and host-specific UI text.

Disposition:

- Remove all boot ownership from this hook.
- After redesign, this hook should consume coordinator state and run compute only when `bootReady` and `bootReadyEpoch` say it may.
- Reassess both caches separately:
- `canvasAnalysisTransientCache` may still be justified for drag-to-canvas result seeding, but only as a short-lived UX optimisation, not as boot correctness machinery.
- `canvasAnalysisResultCache` should not remain a hidden cross-component correctness dependency; if consumers still need result metadata, provide it from an explicit shared result source.

#### `graph-editor/src/services/analysisComputePreparationService.ts`

This service has been pulled from pure input-building into boot-state production.

Investigation-era behaviour now present here includes:

- blocked-reason enums such as `workspace_missing`, `planner_inputs_pending_hydration`, and `planner_inputs_missing`
- `PreparedAnalysisComputeState` returning either `ready` or `blocked`
- per-scenario calls to `getSnapshotPlannerInputsStatus(...)`
- conversion of planner status into a chart-owned blocked state
- readiness logging at each stage of preparation
- snapshot-subject resolution only after local readiness checks pass
- compute signatures that now include snapshot-subject signatures

Analysis:

- The service currently mixes two concerns that should be separate:
- deciding whether boot is complete
- building the final compute payload once boot is complete
- As long as this service returns long-lived blocked states, every caller is encouraged to become its own scheduler.
- That is why both canvas analyses and panel analyses have grown their own hydration and retry behaviour around it.

Disposition:

- Split this service conceptually into:
- pure requirement enumeration for the coordinator
- pure prepared-input construction after readiness has already been established
- The `blocked` union should disappear from analysis-host call sites.
- If a blocked shape still exists internally, it should belong to the coordinator state machine, not to each chart or panel.

#### `graph-editor/src/services/snapshotSubjectResolutionService.ts`

This module now contains both useful pure logic and investigation-era boot behaviour.

Investigation-era additions now present here include:

- `getSnapshotPlannerInputsStatus(...)`
- `hydrateSnapshotPlannerInputs(...)`
- FileRegistry presence checks for planner artefacts
- IndexedDB fallback checks, including workspace-prefixed file IDs
- context-file discovery by parsing DSL strings for `context(...)` and `contextAny(...)`
- event-file inclusion in planner readiness
- boot-oriented snapshot logging around planner input checks

Analysis:

- Some of this is valuable and should survive in some form.
- The pure part is requirement discovery:
- which parameter, case, event, and context files are needed to build valid snapshot signatures
- which artefacts are missing versus merely not yet restored into `FileRegistry`
- The wrong part is ownership:
- individual analyses currently call into this module to trigger best-effort restoration loops
- that means boot mutation is still chart-owned even though the dependency knowledge is centralised

Disposition:

- Keep the pure dependency enumeration and subject-resolution helpers.
- Move all hydration ownership to the coordinator.
- `hydrateSnapshotPlannerInputs(...)` should either be deleted or reduced to a coordinator-internal primitive that is never called from analysis hooks or panels.

#### `graph-editor/src/components/GraphCanvas.tsx`

Graph canvas now participates directly in snapshot-boot diagnosis and in some cache flows.

Investigation-era behaviour now present here includes:

- registration of snapshot boot expectations at sync start
- recording of `reactflow-node-present` stages
- logging around `GraphCanvas:sync-start`
- logging around `GraphCanvas:sync-skip-unchanged`
- logging around forced reconcile when node counts or payloads diverge
- writes into `canvasAnalysisTransientCache` when pinning an analysis onto the canvas
- reads from `canvasAnalysisResultCache` to infer chart semantics for menus

Analysis:

- The sync diagnostics were useful for discovering that ReactFlow reconciliation was leaking into correctness.
- However, the canvas host should not remain the place where analysis boot is inferred or debugged as a primary runtime mechanism.
- The cache reads also show that compute results are now leaking into unrelated UI decisions through hidden global maps.

Disposition:

- Keep only host wiring that passes host state into the coordinator and renders coordinator output.
- Remove boot-ledger registration and ReactFlow-derived boot assumptions from the long-term design.
- Revisit menu/property consumers that currently depend on cached compute output.

#### `graph-editor/src/components/nodes/CanvasAnalysisNode.tsx`

This node component now reflects the boot investigation in both logging and user-facing state text.

Investigation-era behaviour now present here includes:

- ledger emission for node mount and unmount
- snapshot boot logging on render-state transitions
- distinct UI state for `waitingForDeps`
- user-facing `"Loading chart dependencies..."` messaging separate from `"Computing..."`

Analysis:

- The separate dependency-loading message was useful diagnostically because it distinguished boot wait from compute wait.
- But the node should not own the meaning of dependency readiness.
- It should simply render coordinator state supplied from above.

Disposition:

- Keep the UI distinction only if the coordinator exposes a first-class dependency-loading state.
- Remove node-local participation in boot tracing once the coordinator is stable.

#### `graph-editor/src/components/panels/AnalyticsPanel.tsx`

This file now proves that the defect is broader than canvas charts, because the panel path has acquired its own version of the same local boot behaviour.

Investigation-era behaviour now present here includes:

- calling `prepareAnalysisComputeInputs(...)` and handling blocked states locally
- storing planner file IDs locally
- triggering `hydrateSnapshotPlannerInputs(...)` from the panel
- panel-specific readiness tracing
- panel-local loading suppression while dependencies are unresolved

Analysis:

- This is not merely duplicated code. It is duplicated ownership of the same boot problem.
- Any architecture that leaves this file with its own readiness loop will simply recreate the current defect outside canvas charts.

Disposition:

- Remove all panel-owned hydration and blocked-state orchestration.
- Make panel analyses consume the same coordinator contract as canvas analyses and chart tabs.

#### `graph-editor/src/components/editors/GraphEditor.tsx`

Graph editor now contains snapshot-specific sync diagnostics around file-to-store flow.

Investigation-era behaviour now present here includes:

- snapshot-chart filtering via `summariseSnapshotCharts(...)`
- snapshot-specific logs for file-to-store sync being skipped because it is suspended, suppressed, unchanged, or treated as a stale echo
- snapshot-specific logs for successful file-to-store sync

Analysis:

- These logs were useful while chasing races between file restoration and graph-store updates.
- They should not remain part of the conceptual solution.
- They are diagnosing a symptom of missing central ownership, not implementing the correct ownership model.

Disposition:

- Downgrade these logs to temporary diagnostics and remove them after the coordinator transition unless they still surface a separate GraphEditor sync defect.

#### `graph-editor/src/lib/transform.ts`

This file now emits snapshot-boot lifecycle stages during ReactFlow materialisation.

Investigation-era behaviour now present here includes:

- `reactflow-node-materialised` ledger events for snapshot-backed analyses

Analysis:

- This is pure instrumentation.
- It was useful to prove whether chart nodes had actually been materialised.
- It should not survive as required runtime plumbing.

Disposition:

- Remove once the coordinator rollout has stabilised and the host no longer needs lifecycle forensics.

#### `graph-editor/src/lib/snapshotBootTrace.ts`

This is the main accumulation point for the investigation’s diagnostic framework.

It currently contains:

- snapshot-chart classification helpers
- boot-ledger entry tracking
- cycle tracking per analysis
- watchdog timers that warn when expected stages do not appear
- generic chart readiness trace logging
- global mutable state stored on `globalThis`

Analysis:

- This module was useful because the existing architecture had no single owner and therefore no authoritative account of where boot stopped.
- In the replacement architecture, the coordinator itself should make the system legible.
- That means this file should become optional diagnostics, not structural runtime support.

Disposition:

- Keep only while migrating.
- Remove or sharply reduce once the coordinator can expose first-class state for `restoring`, `hydrating`, `ready`, and `failed`.

#### Cache consumers outside the compute hook

The investigation-era caches are no longer confined to the hook that created them.

Current consumers include:

- `graph-editor/src/components/GraphCanvas.tsx` using `canvasAnalysisResultCache` for context-menu chart semantics
- `graph-editor/src/components/PropertiesPanel.tsx` using `canvasAnalysisResultCache` while editing a canvas analysis
- test code that now mocks these caches directly

Analysis:

- This is exactly how temporary rescue mechanisms harden into architecture.
- Once multiple components depend on a hidden cache, removing it becomes harder and the cache quietly becomes part of the product contract.

Disposition:

- During the redesign, either:
- replace these reads with explicit result data owned by the coordinator or compute-result store
- or accept that these consumers only have access to persisted recipe/configuration data, not hidden computed metadata

#### Investigation-era tests and harnesses

We also need to unwind tests that currently encode the wrong architecture.

`graph-editor/src/hooks/__tests__/useCanvasAnalysisCompute.dsl.test.ts`

- This file now contains not only DSL correctness tests but also tests for chart-owned boot behaviour:
- waiting for workspace source metadata
- moving from blocked to ready when planner files appear in `FileRegistry`
- not retrying after an empty snapshot result
- recomputing after clearing a seeded transient result
- suppressing duplicate in-flight live computes
- The DSL correctness tests are still valuable.
- The boot-orchestration tests should be deleted or rewritten once that orchestration no longer lives in the hook.

`graph-editor/e2e/snapshotChartBoot.spec.ts`

- This is a heavyweight reproduction harness that:
- loads a real production graph from the data repo
- overlays exact runtime state from a debug graph snapshot
- seeds large amounts of IndexedDB state
- loads parameter and node files from disk
- mocks only GitHub API access
- exercises the real preparation and compute pipeline after a page load
- This spec has been useful as a reproduction asset, but it is also tied to the current architecture and to a very heavy seeded state.
- After the coordinator lands, this spec should be reviewed and likely split into clearer contracts:
- minimal restore state followed by coordinator hydration
- graph-tab host readiness
- chart-tab host readiness
- panel host readiness if still applicable

`graph-editor/src/components/__tests__/CanvasAnalysisPropertiesSection.test.tsx`

- This test suite now mocks the analysis caches because the UI has become coupled to them.
- That is a signal that the cache has leaked into component contracts and must be revisited during the unwind.

#### Unwind rule for all of the above

The key rule is not “delete every line touched during the investigation”.

The key rule is:

- delete every line whose only job is to compensate for missing central boot ownership
- keep only pure dependency-discovery or subject-resolution helpers that remain valid under the new architecture
- rewrite tests so they prove the coordinator contract, not the old chart-local rescue logic
- do not allow temporary caches or debug probes to survive as hidden product contracts

---

## Replacement Architecture

### New Owner: Analysis Boot Coordinator

Create a dedicated coordinator for each analysis compute context.

Suggested location:

- `graph-editor/src/services/` for orchestration logic
- a small host-specific wiring layer in `graph-editor/src/contexts/` or host-level hooks

### State Model

The coordinator owns a state machine such as:

- `idle`
- `restoring`
- `collecting_requirements`
- `hydrating_requirements`
- `ready`
- `failed`

### Inputs To The Coordinator

The coordinator should consume:

- host identity
- host type
- source graph identity
- workspace identity
- scenario state
- query state
- restore completion signal
- analyses in scope for that host

### Outputs From The Coordinator

The coordinator should publish:

- `bootReady`
- `bootReadyEpoch`
- `bootStatus`
- `bootError`

It may also publish snapshot-specific information for diagnostics, but the main contract should remain generic.

### Host Adapters

The coordinator should be host-agnostic. Host adapters should supply the coordinator with the right inputs.

#### Graph Tab Host

The graph tab host should:

- provide the visible graph
- provide graph-tab scenario state
- provide all canvas analyses in the graph

#### Chart Tab Host

The chart tab host should:

- provide its source graph identity
- provide its scenario and query state
- either attach to an existing source compute context or create its own coordinator instance

Chart tabs must not get their own separate boot heuristics.

#### Other Hosts

Any other analysis surface should either:

- consume the same coordinator directly, or
- provide a host adapter with the same contract

### Behavioural Contract

All analysis hosts should behave as follows:

- if `bootReady` is false, analyses wait
- if `bootReady` becomes true for a new epoch, analyses compute once for that epoch
- if the epoch changes later, analyses recompute from the new epoch

Snapshot-backed analyses add one extra rule:

- the coordinator must not publish ready until required snapshot artefacts are present

Non-snapshot analyses do not need to wait for snapshot artefacts, but they should still respect the general settle gate.

---

## Requirement Collection Strategy

The coordinator should compute the required artefact set across all snapshot-backed analyses in scope before any snapshot-backed compute starts.

This collection step should:

- inspect all analyses in scope for the host
- identify which ones are snapshot-backed
- build the scenario-specific graph variants needed for those analyses
- collect required parameter, event, case, and context artefacts
- union the required file identifiers

The output should be one central requirement set for the compute context.

This replaces repeated per-analysis requirement discovery.

---

## Hydration Strategy

Hydration should be central, bounded, and deterministic.

### Rules

- hydrate from the union requirement set, not from individual analyses
- hydrate once per boot cycle
- wait until all hydratable required artefacts are present before declaring readiness
- if a required artefact is unavailable, fail the boot cycle explicitly rather than leaving hosts in indefinite loading

### Required Behaviour

- artefacts already in FileRegistry count as ready immediately
- artefacts in IndexedDB but not yet restored should be restored by the coordinator
- artefacts unavailable in both places should produce a terminal failure state

### Important Constraint

The coordinator must not depend on ad hoc remounts, clicks, or focus changes to observe progress.

---

## UI Behaviour

### Before Ready

Hosts should display a single consistent waiting state driven by the coordinator, not by local blocked reasons.

The waiting state should mean one thing only:

- this compute context has not yet completed boot

### After Ready

Once the host enters a ready epoch:

- analyses compute normally
- host-local loading then represents actual compute work, not app boot ambiguity

### Failure

If boot fails:

- the host should show a clear dependency failure state
- the error should come from the coordinator
- analyses should not individually invent separate blocked reasons

---

## Migration Plan

### Phase 1: Define The New Boundary

Create the analysis boot contract and wire it above existing analysis hosts.

Deliverables:

- new coordinator state model
- explicit ready epoch
- host adapter API

Acceptance criteria:

- one place in the app determines whether a compute context is boot-ready
- no analysis needs to inspect planner artefact presence to decide whether boot is complete

### Phase 2: Move Requirement Collection And Hydration

Move snapshot planner requirement discovery and hydration out of `useCanvasAnalysisCompute`.

Deliverables:

- central requirement collector
- central hydrator
- central completion wait

Acceptance criteria:

- planner artefacts are hydrated once per compute context boot
- individual analyses no longer subscribe to planner file updates
- individual analyses no longer trigger planner hydration

### Phase 3: Simplify Analysis Compute Hooks

Reduce analysis hooks to post-boot compute only.

Deliverables:

- simplified `useCanvasAnalysisCompute`
- equivalent simplification for any chart-tab-specific compute hooks if present
- removal of local boot rescue logic
- removal of local retry loops

Acceptance criteria:

- compute hooks consume coordinator readiness and epoch
- compute starts only after coordinator readiness
- analysis logic is smaller and easier to reason about

### Phase 4: Remove Debug-Driven Runtime Machinery

Delete or reduce the boot-specific diagnostics and reconciliation-era workarounds added during this debugging cycle.

Acceptance criteria:

- runtime correctness no longer depends on boot diagnostic code
- logs are optional observability, not part of the control path

### Phase 5: Rebuild Test Coverage Around The New Model

Replace the current race-chasing test shape with tests that prove the coordinator contract.

Acceptance criteria:

- tests prove that analyses do not begin compute until the host is ready
- tests prove that snapshot-backed analyses compute after a single settled boot cycle
- tests prove that missing artefacts fail explicitly rather than hanging indefinitely
- tests cover both canvas hosts and chart tab hosts

---

## File-Level Plan

### Files To Add

- a new analysis boot coordinator module under `graph-editor/src/services/`
- a small host-adapter surface under `graph-editor/src/contexts/` or host-level hooks

### Files To Simplify

- `graph-editor/src/hooks/useCanvasAnalysisCompute.ts`
- `graph-editor/src/services/analysisComputePreparationService.ts`
- `graph-editor/src/services/snapshotSubjectResolutionService.ts`
- `graph-editor/src/components/nodes/CanvasAnalysisNode.tsx`
- `graph-editor/src/components/GraphCanvas.tsx`

Also simplify any chart-tab boot path that currently reconstructs similar local readiness logic.

### Files To Retain For Compute Logic

Retain existing subject-resolution and compute-building logic only where it remains pure and post-boot:

- snapshot subject resolution
- compute payload construction
- analysis execution via the graph compute client

### Files To Rework Or Remove Tests From

- `graph-editor/e2e/snapshotChartBoot.spec.ts`
- `graph-editor/src/hooks/__tests__/useCanvasAnalysisCompute.dsl.test.ts`

Add chart-tab boot coverage rather than treating canvas coverage as sufficient.

---

## Test Design

### Invariants Being Protected

- analyses never compute before their host is boot-ready
- boot work runs once per compute context, centrally
- ReactFlow reuse or remount timing does not affect eventual correctness
- chart tabs and canvas analyses obey the same boot contract
- missing required artefacts produce explicit failure, not indefinite loading
- a fresh ready epoch triggers a fresh compute cycle

### Integration Scenarios

- graph tab boot with all required artefacts already present
- graph tab boot with required artefacts present in IndexedDB only
- graph tab boot with required artefacts split across present and hydratable sets
- graph tab boot with one unavailable required artefact
- graph tab boot with multiple snapshot-backed analyses sharing overlapping requirement sets
- chart tab boot with the same snapshot-backed requirements
- mixed host scenarios where non-snapshot analyses coexist and compute independently after general settle

### End-To-End Scenarios

- full reload into a graph tab with snapshot-backed analyses and realistic restore timing
- full reload into a chart tab with snapshot-backed analyses and realistic restore timing
- analyses remain in waiting state until the coordinator declares ready
- all analyses render after settlement without click nudges or incidental interaction
- failure path shows an explicit dependency error instead of indefinite loading

### Mock Decisions

- use real IndexedDB, FileRegistry, GraphStore, and tab restoration state
- mock external compute and network boundaries only where necessary
- avoid mocking coordinator internals unless isolating a very specific pure helper

### What A Failing Test Would Prove

- if a boot integration test fails, the app no longer knows how to settle analysis requirements before compute
- if a host-specific e2e test fails, a user can again reach a state where analyses hang during reload
- if a failure-state test fails, the app can again leave users in indefinite fake-loading rather than surfacing a real dependency problem

---

## Rollout Strategy

### Step 1

Build the coordinator in parallel with the old path, but keep the old path inactive for migrated hosts once the new gate is wired.

### Step 2

Switch canvas analyses to the new coordinator.

### Step 3

Switch chart tabs to the same coordinator contract.

### Step 4

Delete the old per-analysis boot and hydration path completely rather than leaving compatibility shims.

### Step 5

Reduce instrumentation to a minimal observable set after the new path is proven.

---

## Risks And How To Control Them

### Risk: Requirement collection misses a needed artefact

Mitigation:

- build requirement collection from the same pure logic used for post-boot snapshot subject resolution
- cover multi-analysis union cases across multiple hosts

### Risk: Coordinator waits forever

Mitigation:

- explicit terminal failure state for unavailable artefacts
- explicit completion criteria for hydratable artefacts
- no open-ended local waiting loops

### Risk: Old and new paths conflict during migration

Mitigation:

- remove analysis ownership of hydration early
- keep one clear source of readiness truth throughout migration

### Risk: Hidden dependence on host-specific render timing remains

Mitigation:

- treat host renderers as consumers only
- base correctness on coordinator readiness epoch, not mount timing

---

## Success Criteria

The redesign is complete when all of the following are true:

- reloading into a graph tab is deterministic
- reloading into a chart tab is deterministic
- analyses do not compute until their compute context has settled
- snapshot-backed analyses compute after one settled boot cycle
- no host requires a click, focus change, remount, or incidental nudge to leave loading
- missing dependencies fail explicitly rather than hanging
- compute hooks and host code are materially simpler than today
- the previous per-analysis boot, hydration, and retry machinery has been deleted

---

## Investigation Record To Carry Forward

This section captures the critical context from the full debugging cycle so the next session does not need the chat transcript to understand why this redesign exists.

### What We Observed Across The Investigation

The investigation did not reveal one isolated bug. It revealed a family of symptoms produced by the same architectural mistake.

Observed symptom classes:

- snapshot-backed analyses sometimes stayed on `"Computing..."` indefinitely
- snapshot-backed analyses sometimes stayed on `"Loading chart dependencies..."` indefinitely
- some runs produced `"No data available"` when the real defect was incomplete planner inputs and therefore incorrect signature construction
- some local fixes improved one symptom while exposing another, which is strong evidence that the underlying ownership model was wrong

### Key Log Evidence From Mark `stuck`

The most important evidence from this context came from the `stuck` mark analysis.

What mattered in that log window:

- four snapshot-backed charts were discovered during graph boot
- workspace `events` and `contexts` arrived later
- `GraphCanvas:sync-skip-unchanged` appeared for the affected analyses
- after that, the affected charts did not emit the expected `node-mounted`, `hook-mounted`, `prepare-triggered`, `prepared-ready`, or `compute-start` stages

Interpretation:

- those charts were not merely waiting on data
- they had fallen out of the expected boot path entirely
- ReactFlow reconciliation was reusing stale analysis nodes such that later dependency availability did not reliably restart the compute path

Important nuance:

- this evidence explains the most recent visible failure mode
- it does not mean ReactFlow is the root cause
- the deeper root cause is still distributed boot ownership, because correctness currently depends on whether host-local remount and retry heuristics happen to re-enter the path

### What Earlier Fixes Were Actually Telling Us

Several investigation-era fixes were locally rational but collectively diagnostic of the wrong architecture.

What those fixes taught us:

- the duplicate-run guard issue showed that compute scheduling had become too stateful and fragile inside the chart hook
- gating readiness on events, parameters, and contexts showed that signature construction truly depends on planner artefacts beyond the original assumptions
- hydration-via-analysis-hook and hydration-via-panel both showed that hosts were being forced to own restore orchestration
- boot-ledger instrumentation was needed only because there was no authoritative owner of the boot process

Conclusion:

- each patch was uncovering another place where analyses had been forced to compensate for missing top-level coordination
- the right answer is therefore not a better local patch but a different ownership boundary

### Conclusions Already Agreed In This Context

These points should be treated as settled starting assumptions for the next context unless new evidence disproves them.

- this is not a canvas-only bug
- this is not a snapshot-chart-only architectural problem, even if snapshot-backed analyses are the strictest case
- chart tabs should be assumed affected unless proven otherwise
- panel-based analysis surfaces are already showing the same wrong ownership pattern
- the app needs one explicit settle gate before analyses compute
- per-analysis boot orchestration should be removed rather than improved
- ReactFlow mount or reuse timing must not affect eventual correctness
- diagnostics may help migration, but diagnostics must not remain part of runtime correctness

### Things We Should Not Re-Litigate Next Time

The next context should not spend time reconsidering the following unless there is genuinely new contradictory evidence.

- whether another local fix in `useCanvasAnalysisCompute` is worth trying
- whether the problem should be framed as only a canvas problem
- whether snapshot-backed chart tabs can be ignored
- whether chart-local planner hydration is an acceptable long-term design
- whether hidden caches and retry guards are an acceptable substitute for a coordinator

### Existing Reproduction And Diagnostic Assets

The following assets already exist and were useful during this investigation.

- mark-based log extraction via `scripts/extract-mark-logs.sh`
- boot-ledger and readiness traces in `snapshotBootTrace.ts`
- the heavyweight reproduction harness in `graph-editor/e2e/snapshotChartBoot.spec.ts`
- debug graph snapshots under `debug/graph-snapshots/`

How to treat them in the next context:

- use them to validate the redesign and to compare old versus new behaviour
- do not mistake them for the design itself
- expect some of them to be deleted or reduced once the coordinator path is stable

### Old Pending Tasks From The Previous Debugging Direction

Before the redesign direction was fully accepted, three concrete debugging tasks were queued:

- build a fake GitHub API route that serves real file content from the data repo with realistic latency
- seed IndexedDB with only a minimal prior-session production-like state
- assert the defect under that minimal restore path

Status and interpretation:

- these tasks are still potentially useful as validation assets
- they belong to the old defect-reproduction track, not to the architecture itself
- if they are picked up in the next context, they should be used to test the coordinator design, not to justify another local patch series

### Recommended Starting Point For The Next Context

The next context should begin from this document, not from the transcript.

Recommended execution order:

1. Define the coordinator contract and compute-context boundary.
2. Identify every host that currently owns boot state, hydration, or retry logic.
3. Move requirement collection and hydration to the coordinator.
4. Simplify hosts and compute hooks so they consume readiness instead of inventing it.
5. Rebuild tests around the new contract.
6. Only after the new path is proven, delete the temporary diagnostics and caches that were only compensating for the old design.

### Core Message To Carry Forward

The lesson from this entire debugging cycle is not "we need one more fix".

The lesson is:

- we used the wrong ownership boundary
- we taught analyses to survive boot races instead of giving the app one owner for boot readiness
- everything added during the investigation should now be judged by one question:
- does this still make sense once a central coordinator exists?
- if not, it should be removed

---

## Immediate Recommendation

Do not implement another local fix in `useCanvasAnalysisCompute`.

Start the redesign by introducing the generic analysis boot coordinator and deleting analysis ownership of planner hydration. Snapshot-backed analyses should be the first strict consumer, not the architectural boundary.
