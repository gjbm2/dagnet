# Batch Fetch Redux (Retrieve All as batch-mode fetch)

**Last updated:** 22-Jan-26

This document is a proposal to stabilise and simplify DagNet’s fetch machinery by introducing an explicit **batch mode** for fetch operations, and re-implementing **Retrieve All** as a batch-mode fetch run.

It focuses on fixing the serious defects currently blocking correct planning/execution and intelligible observability, without attempting to solve every determinism issue immediately.

---

## 1) Goals (what “correct” means)

- **Single-plan contract**: analysis/dry-run/live execution are driven by the same plan structure, not ad-hoc per-item decisions.
- **Correct planning**: missing vs stale semantics are computed once per plan build, with explicit reasons per window.
- **Correct execution**: execution follows the plan exactly (no “silent” re-derivation of windows mid-run).
- **Batch-mode discipline**: during Retrieve All, we do not repeatedly re-run expensive or sequencing-sensitive policy computations per item (notably anything that would cause `*t95` semantics to drift during the run).
- **Simulation safety**: simulation/dry-run must not mutate files or graph state.
- **Observability**: each Retrieve All run must emit a compact, deterministic “what we did” artefact into session logs, usable for debugging and for validating that planning matches execution.

Non-goals (for now):

- Making `t95/path_t95` fully deterministic across all boot and live-share sequencing differences. We will not attempt to resolve all known determinism issues in this change-set.
- Introducing per-slice `t95`. This may be sensible later, but is out of scope until we define and enforce a slice/evidence contract.

---

## 2) Known issues to fix (current defects)

### 2.1 Simulation mode writes to files

Observed defect: running Retrieve All in simulation mode can write to parameter files (for example via “no data” markers), which contaminates later retrieval behaviour.

Required fix: simulation must be a no-write, no-graph-mutation run.

### 2.2 Logging is insufficient and misleading for “what was fetched”

Observed defect: logs are not producing a deterministic, structured “what was fetched” summary per parameter per slice. This forces repeated forensic log reading and makes it difficult to validate planning/execution behaviour.

Required fix: add an end-of-run session-log artefact that is both machine-readable and human scannable.

### 2.3 Retrieve All currently recomputes per-item decisions many times

Observed problem: Retrieve All executes a per-item fetch flow repeatedly (effectively “80 times”), which:

- repeats cache analysis and policy logic unnecessarily
- can cause sequencing-sensitive inputs (especially `*t95`-related) to vary during a single run
- makes it difficult to reason about whether “planning” was actually followed, because planning is implicit and local to each item

Required fix: Retrieve All must be reworked to compile a plan once per slice and execute it as a batch.

---

## 3) Proposal: explicit batch mode for fetch

### 3.1 Batch mode definition

A **batch fetch** is a fetch run that:

- treats “planning” as a first-class step that produces a deterministic plan artefact
- executes that plan without re-deriving windows/policy per item
- brackets the run with explicit “start” and “end” lifecycle hooks

Batch mode is an execution posture, not a new feature. It is intended to be used by Retrieve All and any other bulk operations.

### 3.2 Consolidate “batch fetch” into ONE concept (remove duplicate batch orchestration)

Today there are *two* overlapping “batch” concepts:

- **Batch pipeline (canonical direction):** the existing multi-item pipeline in `fetchDataService.fetchItems(...)` (and `fetchItem(...)` delegates to it).
- **Bespoke batch loops (deviant orchestration):** ad-hoc “for each item” loops at higher layers (Retrieve All, planner execution, some modal-level post-passes).

Even if these loops appear “basically identical”, duplication is harmful in practice because it allows drift in:

- planning vs execution coupling (single-plan contract),
- Stage‑2 timing and `*t95` evolution during a run,
- signature isolation and MECE fulfilment behaviour,
- and logging/observability.

**Proposal:** consolidate into a single canonical orchestration path:

- one batch orchestrator that:
  - builds a plan (or accepts a plan),
  - executes items (single or many) using plan-interpreter windows when applicable,
  - brackets execution with batch lifecycle hooks (`get *t95 data` / `set *t95 data`),
  - runs Stage‑2 once per batch when enabled (not “N times opportunistically”),
  - emits the structured “what we did” artefact.

All call sites (WindowSelector fetch button, scenario regeneration, Retrieve All, share/live boot, menus, automation) must call that orchestrator with parameters rather than implementing bespoke loops.

### 3.2 Batch-mode bracketing for `*t95` (crude now, improvable later)

We introduce two explicit lifecycle steps for `*t95` handling:

- **Get `*t95` data (batch start)**: capture a frozen snapshot of the `*t95` dataset used for planning/bounding decisions for the duration of the run.
- **Set `*t95` data (batch end)**: apply/update/persist the run’s resulting `*t95` dataset exactly once.

Initial implementation may be crude (for example, “use the current graph/file values as-is” at start, and “apply the existing Stage‑2 outputs” at end). The key requirement is that we stop leaking `*t95` updates and recomputation into the middle of execution steps.

This supports the longer-term direction described in `docs/current/deterministic.md`: horizons must be sensitive to data and intent, not to sequencing.

---

## 4) Retrieve All as batch-mode fetch

### 4.1 Plan once per slice (not per item)

Retrieve All must:

- explode the pinned DSL into slices
- for each slice:
  - build one FetchPlan for that slice
  - execute the plan exactly

This avoids per-item re-planning and makes execution auditable.

### 4.2 Plan interpreter execution

Execution should run in a “plan interpreter” posture:

- the plan provides explicit windows per item
- execution calls are made with “execute exactly these windows”
- cohort bounding is treated as already decided by the plan, not re-derived during execution

### 4.3 Session log artefact: “what we did”

At the end of each Retrieve All slice (and at the end of the whole run), emit:

- **Machine-readable summary** (structured metadata suitable for later automated checks)
- **Human-readable table** (compact, scan-friendly)

Each row should be keyed by a stable identity that is invariant across runs:

- item key (type, objectId, targetId, slot/conditional index)
- slice identity (normalised slice family)
- mode (window/cohort)

Each row should include:

- planned windows with reasons (missing/stale) and day counts
- whether the item was covered/unfetchable/fetch
- what was executed (windows executed; for simulation: “would execute”)
- cache status at execution time (hit/miss, days-to-fetch, gap count)
- resulting “days returned” and “days persisted” (where applicable)
- errors (if any) with a stable error classification

This is the primary artefact used to validate correctness of planning/execution and to avoid daily forensic log work.

---

## 5) Standardise fetching properly: ONE code path (including scenarios)

If we are standardising fetching, we should standardise it **properly**:

- There must be **one canonical orchestration path** for:
  - planning (“what should we fetch?”)
  - execution (“what did we fetch?”)
  - and post-pass behaviour (Stage‑2, `*t95` bracketing, persistence)
- All call sites (WindowSelector fetch button, scenario regeneration, Retrieve All, share/live boot) must use that orchestration path with **parameters** controlling:
  - whether network fetch is allowed
  - whether missing/stale items are auto-fetched or only fetched on explicit user action
  - where results are applied (Current layer vs scenario-local graph copy)
  - batch vs non-batch execution posture (including bracketing hooks)

This avoids “same DSL, different truth” divergences caused by ad-hoc cache checks and bespoke sequencing.

### 5.0 The consolidation target (what “ONE code path” means operationally)

“One code path” specifically means:

- there is exactly one place in the codebase that:
  - constructs the fetch plan artefact for a DSL (planning),
  - executes from source for planned windows (execution),
  - performs any required post-passes (Stage‑2, `*t95` bracketing),
  - and emits the canonical session-log artefacts.

Entry points may still differ (buttons, modals, automation, share/live boot), but they must be **thin wrappers** that supply parameters and callbacks, not alternate implementations of planning/execution logic.

### 5.1 Scenario regeneration must not be a deviant fetch path

Current scenario regeneration uses `fetchDataService.checkDSLNeedsFetch(...)` and then calls `fetchDataService.fetchItems(...)` in either:

- versioned mode (fetch from source) when missing and allowed, or
- from-file mode (cache only) otherwise.

Even if the executor work is similar, this is still a deviant *orchestration* path because:

- it can disagree with the planner/plan-builder about what “needs fetch” means, especially around:
  - stale vs missing semantics
  - signature isolation
  - MECE / implicit-uncontexted fulfilment
- it can produce different execution windows compared to the user-triggered fetch path.

Under this proposal, scenario regeneration must call the same “plan → (optional execute) → (optional from-file refresh)” pipeline as user-triggered fetch, with parameters controlling:

- apply target (scenario graph vs Current graph)
- allowFetchFromSource (hard gate; share/live boot sets false)
- autoFetchMissing (scenarios may set true; WindowSelector auto fetch remains false)
- skipStage2 (for performance) vs runStage2 (for parity)
- execution mode (single vs batch)

### 5.2 Identify and eliminate other deviant orchestration paths

We must actively audit and remove any additional call sites that:

- decide “needs fetch” via a mechanism other than the plan builder, or
- execute from source without going through the plan interpreter contract, or
- perform bespoke post-pass work that should be part of batch bracketing.

Known entrypoints that must be reviewed under this proposal:

- `graph-editor/src/components/WindowSelector.tsx`
  - planning via `windowFetchPlannerService.analyse(...)`
  - explicit execution via `windowFetchPlannerService.executeFetchPlan(...)` (good canonical direction)
  - auto-aggregation via `fetchDataService.fetchItems(..., mode: 'from-file')` (cache-only)
- `graph-editor/src/contexts/ScenariosContext.tsx`
  - deviant “needs fetch” decision via `fetchDataService.checkDSLNeedsFetch(...)` (must unify)
  - execution via `fetchDataService.fetchItems(...)`
- Share/live boot hooks:
  - `graph-editor/src/hooks/useShareBundleFromUrl.ts`
  - `graph-editor/src/hooks/useShareChartFromUrl.ts`
  - these must remain `allowFetchFromSource=false`, but should still use the unified plan + from-file pipeline
- Batch UI:
  - `graph-editor/src/components/modals/AllSlicesModal.tsx` (Retrieve All UI wrapper)
  - currently includes additional bespoke “post retrieve topo pass” work; this should be revisited and, where appropriate, moved into batch bracketing.

This list must remain explicit in the proposal so “one code path” is not aspirational; it is operationally enforced.

---

## 6) Schematic: single fetch vs batch fetch

This section describes the logical sequence of operations. It is intentionally declarative rather than implementation-specific.

### 5.1 Single-item fetch (normal mode)

1. Resolve intent (effective DSL, resolved dates, slice identity).
2. Load current cache state for the item (file state, existing coverage).
3. Decide what to fetch (missing and any policy-driven refresh window).
4. Execute external retrieval for the decided windows.
5. Persist results (if versioned) and refresh graph view from file.
6. (Optional) Run post-pass computations, if required by the entrypoint.
7. Emit session logs for planning, execution, and persistence.

### 5.2 Batch fetch (Retrieve All) — per slice

Batch start (once per run or per slice; policy choice must be explicit):

1. Capture frozen inputs:
   - resolve effective DSL for the slice (including resolved relative dates)
   - acquire `*t95` dataset snapshot for planning/bounding
   - acquire forecasting settings snapshot used in maturity-related decisions

Plan build:

2. Build FetchPlan for the slice:
   - enumerate targets
   - compute per-item coverage (missing)
   - compute per-item refresh needs (stale), using the frozen snapshots
   - compile minimal windows with explicit reasons
3. Emit “plan built” session log artefact (machine-readable + compact table).

Plan execution:

4. Execute the plan in plan-interpreter mode:
   - for each plan item:
     - if covered: record as covered (no network)
     - if unfetchable: record unfetchable
     - if fetch: execute exactly the planned windows
5. Emit per-item execution results into a structured accumulator.

Batch end:

6. Apply end-of-run steps exactly once:
   - update/persist `*t95` dataset (crude now, improvable later)
   - apply any other required post-pass computations for batch parity
7. Emit “what we did” session log artefact:
   - machine-readable (for later checks)
   - human-readable table

Simulation variant:

- identical sequencing, except:
  - no external HTTP is executed (only request construction is logged)
  - no file writes
  - no graph mutation

---

## 7) Testing strategy (broad and careful; no weakening)

This work affects fetch planning/execution correctness and observability. Tests must be updated deliberately and must not weaken safety properties.

### 6.1 Principles

- Prefer extending existing suites.
- Avoid snapshot-style weakening; prefer explicit assertions on structured artefacts.
- Tests must cover both live and simulation modes.

### 6.2 Tests to revisit / extend (likely homes)

- Retrieve All behaviour and simulation safety:
  - `graph-editor/src/services/__tests__/retrieveAllSlicesService.test.ts`
  - `graph-editor/src/services/__tests__/allSlicesSimulation.test.ts`
- Plan builder invariants (missing vs stale windows, determinism/canonicalisation):
  - `graph-editor/src/services/__tests__/fetchPlanBuilderService.test.ts` (or the closest existing plan-builder suite)
- Cohort bounding authority rules (graph vs file, path horizon usage):
  - tests referenced by `docs/current/deterministic.md` (join weighting, completeness constraints, authority)

### 6.3 Minimum scenarios to cover

For Retrieve All batch mode:

- Covered items: ensure no external execution is scheduled when plan says covered.
- Unfetchable items: ensure they appear in the “what we did” artefact with an explicit reason.
- Fetch items with multiple windows (gaps): ensure execution follows planned windows exactly.
- Simulation mode: ensure no file writes and that dry-run HTTP entries exist, while “what we did” artefact is still emitted.
- Stability: ensure planning artefact and execution artefact line up (same item keys, same windows, consistent counts).

For `*t95` bracketing:

- Ensure `get *t95 data` is called once per batch and `set *t95 data` is called once per batch.
- Ensure `*t95` inputs used for planning do not change during execution within a single batch run (even if individual items produce new evidence).

---

## 8) Rollout notes and risks

- The primary risk is behavioural drift from existing “implicit per-item” logic. Mitigation: retain the same low-level executor for actual retrieval/persistence, but drive it through explicit plan windows.
- Logging changes must be treated as part of correctness: the “what we did” artefact is required for validating the system during iteration.
- `*t95` handling is intentionally crude initially, but must be structurally isolated behind explicit batch start/end steps to prevent further entanglement.


---

## 9) Detailed implementation plan (prose-only; end-to-end)

This section is an implementation plan for the **entire** change-set described above. It is intentionally detailed and operational, but contains **no code snippets**. It is written to minimise behavioural drift and to keep the system shippable in incremental stages.

### 9.1 Scope, constraints, and invariants (must hold throughout)

- **Single-plan contract**:
  - For a given slice and graph snapshot, analysis/dry-run/live must be driven by the same plan artefact.
  - Execution must not silently re-derive windows/policy mid-run; if any runtime condition forces deviation (rate limiting, adapter constraints), the deviation must be surfaced in the execution artefact as “planned vs executed”.

- **Simulation safety**:
  - Simulation/dry-run must never write to parameter files, case files, node files, or any IndexedDB-backed state.
  - Simulation/dry-run must never mutate the graph state.
  - Simulation/dry-run may emit log artefacts and may construct request payloads/commands for observability.

- **Stage‑2 / LAG discipline** (explicitly addressing the “Stage‑2 after entire fetch” point):
  - Stage‑2 must not run per item.
  - For Retrieve All / batch runs, Stage‑2 is treated as a **post-pass** that runs **once after execution**, and is driven by an explicit decision about *which DSL it is anchoring to*.
  - Stage‑2 must be invoked from the canonical orchestrator (services layer), not from UI components.

- **No business logic in UI files**:
  - `AllSlicesModal.tsx` must not contain bespoke orchestration loops beyond calling a service/hook.
  - Any “post retrieve topo pass” behaviour must be moved into service-layer batch bracketing (or removed if it is redundant under the unified pipeline).

- **No duplicate code paths**:
  - There must be exactly one orchestration path for “build plan → execute plan → post-pass → artefacts”.
  - Entry points (WindowSelector, Retrieve All, scenarios regen, share boot) must call the orchestrator with parameters rather than implementing bespoke loops.

### 9.2 Phase 0 — Audit and pin the current behaviour (no behavioural changes)

Goal: ensure we understand the current end-to-end paths and can detect drift.

- **Trace entrypoints** and record the current call graph in this doc (add a short appendix table):
  - WindowSelector “Fetch data”: `WindowSelector.tsx` → `windowFetchPlannerService.executeFetchPlan(...)` → existing fetch pipeline.
  - Retrieve All UI: `AllSlicesModal.tsx` → `retrieveAllSlicesService.execute(...)` → `dataOperationsService.getFromSource(...)`.
  - Scenario regeneration: `ScenariosContext.tsx` → `fetchDataService.checkDSLNeedsFetch(...)` / `fetchDataService.fetchItems(...)` / from-file path.
  - Share/live boot: share hooks → from-file load path (fetch disabled).

- **Confirm and document Stage‑2 posture**:
  - Identify where Stage‑2 runs today (including “post retrieve topo pass” from the modal) and what DSL it anchors to.
  - Confirm which flows run Stage‑2 in `from-file` mode and which suppress it.

- **Catalogue existing test coverage** (do not change tests yet):
  - Retrieve All simulation safety: `graph-editor/src/services/__tests__/allSlicesSimulation.test.ts`.
  - Retrieve All service: `graph-editor/src/services/__tests__/retrieveAllSlicesService.test.ts`.
  - Fetch button end-to-end: `graph-editor/src/services/__tests__/fetchButtonE2E.integration.test.tsx`.
  - Multi-slice cache fulfilment suites (MECE, incomplete partitions, etc.): existing `multiSliceCache` and `contextMECEEquivalence` tests.

Deliverable: an explicit “baseline behaviour notes” subsection in this doc (what currently happens, not what we want).

### 9.3 Phase 1 — Define the canonical batch artefacts (plan + execution summary)

Goal: make observability and testability first-class so later refactors are defensible.

- **Define a canonical item key** used everywhere (plan rows and execution rows), stable across runs:
  - Must include at minimum: item type, objectId, targetId, and where applicable param slot and conditional index.
  - Must be independent of UI labels and not dependent on array iteration order.

- **Define the plan artefact schema** (serialisable, deterministic):
  - One plan per slice.
  - For each item: classification (covered / unfetchable / fetch), and if fetch, the planned windows with explicit reasons (missing vs stale) and derived counts.
  - The plan artefact must have deterministic ordering rules (items and windows).

- **Define the execution artefact schema** (“what we did”, deterministic):
  - One execution artefact per slice, plus an optional run-level aggregate artefact for the whole Retrieve All run.
  - For each item, record:
    - planned classification and planned windows,
    - executed classification and executed windows (or “would execute” in simulation),
    - cache status at execution time (hit/miss, days-to-fetch, gap count),
    - outcomes (days returned / days persisted, where applicable),
    - errors using a stable error classification.

- **Define error classification**:
  - A small, stable set of error kinds (e.g. invalid request, missing connection, provider rate limit, provider server error, file write blocked, etc.).
  - Make the classification suitable for later automation and for human scanning.

- **Define where the artefacts live in session logs**:
  - Use `sessionLogService` with one start/end operation per slice and child events for the plan and the final artefact.
  - Ensure the “human-readable table” is a deterministic rendering of the structured metadata, not the other way round.

Deliverable: add a subsection to this doc that fully specifies the artefact schemas and deterministic ordering rules.

### 9.4 Phase 2 — Implement batch-mode bracketing as explicit service-layer lifecycle hooks

Goal: make “batch start / batch end” explicit so we can enforce sequencing, `*t95` isolation, and Stage‑2 timing.

- **Introduce a single “batch run context” concept** (service layer):
  - This context is created at batch start and passed through planning and execution.
  - It must carry:
    - resolved DSL for the slice (including resolved relative dates),
    - a frozen reference date / day (for determinism),
    - any frozen `*t95`/latency inputs used by planning/bounding decisions.

- **Batch start hook**:
  - Capture and freeze the inputs required for planning so they cannot drift mid-run.
  - Ensure this is done once per slice execution (and optionally once per entire Retrieve All run if we later choose to scope it that way).

- **Batch end hook**:
  - Apply any end-of-run steps exactly once:
    - Stage‑2 post-pass (see next phase for the exact posture),
    - `*t95` persistence/update if required by the pipeline.
  - Emit the canonical “what we did” artefact.

Deliverable: a dedicated service-layer module responsible for batch lifecycle management, invoked by the canonical orchestrator only.

### 9.5 Phase 3 — Make Retrieve All “plan once per slice, execute plan exactly”

Goal: rework Retrieve All so it is a true batch-mode fetch per slice with an explicit plan artefact and plan-interpreter execution.

- **Create a per-slice plan builder entry point** used by Retrieve All:
  - It must:
    - enumerate targets once for the graph snapshot,
    - compute coverage/missing/stale decisions once,
    - compile windows once (explicit reasons),
    - produce a deterministic plan artefact.

- **Execute in plan-interpreter mode**:
  - Execution must call the existing low-level executor with “execute exactly these windows” inputs (the plan windows).
  - It must not recompute `shouldRefetch`, cohort bounding, cache cutting, or gap discovery inside the per-item loop.
  - In simulation/dry-run, execution must still run the same interpreter, but with external HTTP disabled and all writes/mutations blocked.

- **Progress reporting**:
  - Continue to report progress per slice and per item, but derive “what is being fetched” from the plan and “what happened” from the interpreter results.

- **Remove or relocate deviant post-passes**:
  - The current “post retrieve topo pass” in `AllSlicesModal.tsx` must be moved into the batch end hook (service layer), with an explicit explanation of why it exists and what DSL it anchors to.
  - UI should remain an access point only.

Files expected to be involved (non-exhaustive; exact edits will be traced during implementation):
- `graph-editor/src/services/retrieveAllSlicesService.ts`
- `graph-editor/src/services/retrieveAllSlicesPlannerService.ts` (likely remains as target enumerator)
- `graph-editor/src/components/modals/AllSlicesModal.tsx` (thin wrapper only; remove bespoke orchestration)
- `graph-editor/src/services/dataOperationsService.ts` (use interpreter inputs; enforce no-write in simulation)

### 9.6 Phase 4 — Standardise all entrypoints onto the one orchestrator (eliminate deviant paths)

Goal: enforce the “one code path” principle operationally.

- **WindowSelector fetch button**:
  - Ensure it uses the same plan builder + interpreter path (single-item run is a degenerate batch).
  - Ensure dry-run/analysis and execution share plan identity (same windows, same reasons).

- **Scenario regeneration**:
  - Replace any deviant “needs fetch” computation that bypasses the plan builder.
  - Scenarios must call the same plan + interpreter machinery with parameters controlling:
    - apply target (scenario graph copy),
    - allowFetchFromSource (false in share/live),
    - whether to run Stage‑2 (often skipped for performance; must be explicit).

- **Share/live boot**:
  - Must route through the same pipeline with allowFetchFromSource=false and still emit plan/execution artefacts (execution is from-file refresh + logs, not network).

Deliverable: an explicit call-site audit checklist in this doc and a requirement that no other fetch orchestration loops remain.

### 9.7 Phase 5 — Stage‑2 and `*t95` bracketing integration (with explicit authority)

Goal: implement the batch bracketing semantics that stop sequencing-sensitive drift.

- **Stage‑2 timing**:
  - Enforce: Stage‑2 runs once after execution (never per item) for the chosen anchoring DSL.
  - Specify the anchoring DSL for Retrieve All:
    - Minimum viable behaviour: after completing all slices, run one from-file refresh pass for the authoritative current DSL (to update graph scalars and LAG values) in the batch end hook.
    - If additional per-slice Stage‑2 is required later, it must be explicitly justified and tested, but is not part of the minimum viable batch stabilisation.

- **`*t95` handling**:
  - Implement “freeze at batch start, apply at batch end” semantics behind the lifecycle hooks.
  - Ensure no intermediate updates leak into planning/execution decisions mid-run.

Important note: any change that affects horizon calculation or persistence has behavioural risk (file churn, staleness decisions). Keep the initial version structurally isolating rather than “perfecting determinism”.

### 9.8 Phase 6 — Tests (extend existing suites; no weakening)

Goal: prove correctness and prevent regressions, without weakening coverage.

Tests to extend (preferred homes; update as implementation reveals the most appropriate suites):
- **Retrieve All batch mode semantics**:
  - Extend `graph-editor/src/services/__tests__/retrieveAllSlicesService.test.ts` to assert:
    - planning happens once per slice (not per item),
    - execution follows the plan windows exactly (planned vs executed match),
    - “what we did” artefact is emitted and is deterministic for fixed inputs.
- **Simulation safety**:
  - Extend `graph-editor/src/services/__tests__/allSlicesSimulation.test.ts` to assert:
    - no file writes,
    - no graph mutation,
    - plan artefact and execution artefact are still emitted.
- **Cross-entrypoint unification**:
  - Extend `graph-editor/src/services/__tests__/fetchButtonE2E.integration.test.tsx` to assert the WindowSelector path uses the same plan machinery (plan identity fields present in logs/metadata).
- **Scenario path parity**:
  - Extend an existing scenarios integration test (prefer one already covering regeneration) to assert it uses the unified pipeline and respects allowFetchFromSource=false in share contexts.

Minimum scenarios to cover (must be explicitly asserted):
- Covered items: plan says covered → no external execution scheduled.
- Unfetchable items: appear in artefact with explicit reason, do not trigger network.
- Multiple-gap items: plan windows are multiple and are executed exactly.
- Partial failure: one window fails → remaining windows still run; rerun plans only remaining gaps.

### 9.9 Phase 7 — Cleanup and enforcement

Goal: keep the codebase honest going forward.

- **Remove duplicate orchestration loops** after callers are migrated.
- **Add grep-able invariants** in docs and (where appropriate) in service-level comments:
  - “All entrypoints must call the orchestrator; no bespoke loops.”
- **Audit session logging**:
  - Ensure batch start/end boundaries are visible and that artefacts are easy to locate.

### 9.10 Acceptance criteria (definition of “ready to implement” and “done”)

This proposal is ready to implement when this section is fully specified (no ambiguous “maybe later” semantics for the core contract). The implementation is “done” when:

- Retrieve All compiles a plan once per slice and executes exactly that plan (no per-item re-planning).
- Simulation mode is provably no-write and no-graph-mutation, while still producing deterministic artefacts.
- All relevant entrypoints route through the same canonical orchestration path.
- Stage‑2 is invoked only via the canonical orchestrator (not UI) and runs once after execution in batch mode.
- Session logs include:
  - a deterministic plan artefact and a deterministic “what we did” artefact per slice (and optionally per run),
  - stable row keys and stable error classifications suitable for later automated checking.

