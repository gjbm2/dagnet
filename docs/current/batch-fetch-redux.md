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

