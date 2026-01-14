## Src Slimdown Plan (Large File Modularisation)

**Created:** 15-Dec-25  
**Last reviewed:** 14-Jan-26  
**Status:** Ready for implementation (structural refactor only; no intended behavioural changes)

---

### Purpose

Several files under `graph-editor/src/` remain too large and mix multiple responsibilities. This plan defines a safe, test-guided approach to split those files into smaller, navigable modules **without creating duplicate code paths** and while preserving DagNet’s architectural constraints (services own logic; UI owns composition).

This document is intended to be the **single source of truth** for the slimdown work. Earlier refactor proposals for the same surface area have been archived under `docs/archive/refactor/` (see “Related documents”).

---

### Scope (What This Plan Is / Isn’t)

- **In scope**
  - Structural extraction and file modularisation
  - Naming, organisation, and dependency direction improvements
  - Deleting clearly-dead code only when it is obviously unused and protected by existing tests
- **Out of scope (unless explicitly approved later)**
  - Changes to caching semantics, query semantics, persistence formats, or data shape
  - “While we’re here” feature work or large behavioural clean-ups

---

### Goals (What “Good” Looks Like)

- **Maintainability**: Each module has a single, clearly named responsibility and is small enough to be navigable.
- **Stable public surface**: Call sites keep importing from the same existing file paths unless there is an explicit, agreed migration.
- **No behavioural change**: Refactor steps are structural; behaviour remains identical unless explicitly approved.
- **No duplicate code paths**: We extract and centralise; we do not re-implement logic in multiple places.
- **Tests as proof**: Existing relevant tests remain green throughout (run per-file, not the full suite).

---

### Non‑Negotiables (Repo Rules to Preserve)

- **No logic in UI/menu files**: UI components and menus remain access points only; business logic stays in services/hooks.
- **IndexedDB is source of truth for git/data ops**: Avoid introducing new in-memory “truths” while moving code around.
- **Session logging**: External/data operations must keep `sessionLogService` coverage; do not lose log events during extraction.
- **UK date format**: Internal/UI/logging stays `d-MMM-yy` unless at an external API boundary.
- **Minimise surface area**: Avoid temporary compatibility shims and parallel entry points; keep one “canonical” import per domain.

---

### Current Inventory (as of 14-Jan-26)

Primary targets (current line counts):

- **Services**
  - `graph-editor/src/services/dataOperationsService.ts` (~8,874)
  - `graph-editor/src/services/UpdateManager.ts` (~4,915)
  - `graph-editor/src/services/statisticalEnhancementService.ts` (~3,106)
  - `graph-editor/src/services/integrityCheckService.ts` (~3,072)
- **UI**
  - `graph-editor/src/components/GraphCanvas.tsx` (~5,500)
  - `graph-editor/src/components/edges/ConversionEdge.tsx` (~3,092)
  - `graph-editor/src/components/PropertiesPanel.tsx` (~2,818)

Secondary candidates (only after the above are stable):

- `graph-editor/src/contexts/TabContext.tsx` (~2,715)
- `graph-editor/src/components/editors/GraphEditor.tsx` (~2,244)
- `graph-editor/src/components/QueryExpressionEditor.tsx` (~2,132)

---

### Key Invariants to Preserve (Newer / Easy to Break)

These couplings exist today and must not be altered accidentally during extraction:

- **Contexts and slice semantics**
  - Slice/context/window behaviour flows through DSL and the slice-aware services (for example `sliceIsolation`, `querySignatureService`, `contextRegistry`).
  - Signature mechanisms are used for integrity/staleness signalling; do not accidentally reintroduce signature-as-indexing patterns.
- **Date format**
  - UK date format (`d-MMM-yy`) is expected internally; ISO is for external API boundaries only.
  - Do not change date comparison/normalisation behaviours while moving code (move first; change later only with explicit approval).
- **Single-path behaviour**
  - Avoid “special” code paths for auto-aggregation vs manual fetch, scenario overlays vs current layer, or menu vs toolbar actions. If a single path exists today, keep it single.

---

### Up-Front Decisions (So Implementation Can Be Procedural)

This section enumerates the areas where subtle judgement is typically required during large-file modularisation. The goal is to make these decisions **once, up front**, so the implementation work can be executed as a mostly mechanical sequence of safe extractions.

**Decision status:** Agreed (14-Jan-26)

**Decision 1 — Behavioural freeze (what we will not change during slimdown)**

During the slimdown phases, we treat the following as **frozen semantics**:

- Contexts/slice semantics (including when/where slice isolation is applied)
- Query signature behaviour (including warning vs indexing semantics)
- UK date handling behaviour (normalisation rules, boundary conversion, comparison semantics)
- Override gating, permission-flag propagation, and rebalancing triggers
- Session log event coverage and event identity (event names/categories/shape)
- “Single code path” guarantees (do not introduce alternate pathways during extraction)

If a proposed extraction *forces* a change to any of the above, the correct response is to **stop** and resolve that issue explicitly before proceeding.

**Decision 2 — Public surface and entrypoints**

To minimise churn and avoid accidental “parallel entrypoints”:

- The existing file paths remain the only public entrypoints during slimdown.
- We do not add new public barrel entrypoints (for example `services/foo/index.ts`) as part of slimdown.
- We do not add “temporary compatibility shims” or alias exports; if something must change, do it deliberately and in one sweep.

**Decision 3 — A standard extraction template (repeatable per PR)**

Each slimdown PR should follow the same procedural shape:

- Identify one coherent cluster to extract (types/constants, pure helpers, or one subsystem).
- Extract into an internal directory adjacent to the facade file.
- Keep dependency direction one-way (facade imports module; module does not import facade).
- Keep runtime order stable (no re-ordering “for tidiness”).
- Run the agreed narrow set of tests for that target (by explicit file paths).

**Decision 4 — Module-boundary rubric (how we choose seams)**

To avoid circular dependencies and “grab-bag” modules:

- A module should tell one story (for example “Get-from-file”, “Put-to-file”, “Mapping config”, “Rebalance logic”, “Sankey layout”).
- Modules should not cross-import siblings; if two modules need shared types/helpers, factor a tiny shared module.
- Prefer extracting pure helpers first; avoid moving orchestration until the end.

**Decision 5 — Explicit stop-list (areas requiring extra care / review)**

Before extracting code that touches any of these areas, pause and explicitly confirm the invariants being preserved:

- `UpdateManager` mapping initialisation and shared caching behaviour
- `UpdateManager` evidence/window/date handling
- `UpdateManager` rebalancing and override gating
- `dataOperationsService` slice/DSL flows (`targetSlice`, `currentDSL`) and signature warnings
- External→file append + file→graph update orchestration (versioned fetch)
- Fetch/refetch policy boundaries and “bust cache” semantics
- `GraphCanvas` / `ConversionEdge` scenario overlay rules (selection, suppression during pan/drag) and what-if propagation

**Decision 6 — Deletion policy (avoid accidental semantic change)**

- Default is **no deletion** during Phase 1–2; prefer move-and-isolate.
- Deletion is allowed only in the final clean-up phase, and only for code that is obviously unused and protected by existing tests.

**Decision 7 — Performance guardrails (UI refactors)**

- Avoid introducing new React state layers or broad dependency-array changes as part of extraction.
- Avoid changing prop shapes that would increase render frequency unless there is a measured reason (slimdown is not a performance project).

**Decision 8 — Tests and authorisation gates**

- We run tests by explicit file path only (no suite-wide scanning).
- If a refactor step requires modifying an existing test file, obtain explicit approval before doing so.
- If tests fail due to brittle coupling, prefer adjusting the refactor to preserve behaviour over weakening test expectations.

---

### Implementation Kick-Off Checklist (First PR)

Before starting the first code-change PR under this plan:

- Confirm no other active branches/PRs are refactoring the same “mega files”.
- Confirm the first target in the fixed programme order and pick the first coherent extractable cluster (types/constants or pure helpers).
- Document the exact test file paths that will be run for that target in the PR description (Core always; Safety net only at target gates).
- Confirm whether any test-file edits might be required; if yes, obtain explicit approval first.

---

### Single Implementation Plan (Whole Programme)

This section is the **single implementation plan** for the entire slimdown programme. Once agreed, the execution should be essentially procedural: follow the order, apply the standard extraction template, run the fixed test set, and stop only at the explicit stop/gate points.

#### Programme Principles (Execution Discipline)

- Each PR extracts **one coherent cluster** only.
- Each PR must be reversible (small diff, no broad reformatting).
- Each PR must keep the existing public entrypoints stable (Decision 2).
- Each PR runs only the agreed relevant tests for that target (Decision 8), following the Core/Safety net policy below.
- If any stop-list area is touched, the PR must include an explicit “invariants check” note in its description.

#### Test Policy (Core vs Safety Net; Offline by Default)

To keep execution procedural and low-friction:

- **Core tests** run on **every PR** for that target.
- **Safety net tests** run at the **target gates** (for example UM-PR2/UM-PR4/UM-PR6) and at the end of the target.
- **Offline by default**: tests in the standard runlists must not require external credentials, real network calls, or human interaction.

Explicitly excluded from routine slimdown PRs unless deliberately requested:

- Playwright specs under `graph-editor/e2e/`
- “Real API” tests (for example files under `graph-editor/tests/phase4-e2e/` such as `amplitude-real-api.test.ts`)

#### Programme Order (Fixed)

Execute in this order, because it reduces risk and avoids rework:

1. `graph-editor/src/services/UpdateManager.ts`
2. `graph-editor/src/services/dataOperationsService.ts`
3. `graph-editor/src/services/statisticalEnhancementService.ts`
4. `graph-editor/src/services/integrityCheckService.ts`
5. `graph-editor/src/components/GraphCanvas.tsx`
6. `graph-editor/src/components/PropertiesPanel.tsx`
7. `graph-editor/src/components/edges/ConversionEdge.tsx`
8. Secondary candidates (only after the above are stable)

#### Work Breakdown by Target (Procedural PR Sequence)

For each target file below, follow the same internal sequencing. The intent is to avoid “where do we start?” decisions during execution.

##### Target A — `UpdateManager.ts`

PR sequence:

- **UM-PR1 (types + small pure helpers)**: Extract public types/contracts and clearly-pure helpers into `graph-editor/src/services/updateManager/`.
- **UM-PR2 (mapping configuration declaration)**: Extract mapping table declarations and related data-only configuration into `graph-editor/src/services/updateManager/`.
- **UM-PR3 (mapping application engine)**: Extract the apply/engine routines (override gating, transforms, change tracking) into `graph-editor/src/services/updateManager/`.
- **UM-PR4 (graph-specific behaviours)**: Extract rebalancing, topology lookups, and evidence/window/date handling into `graph-editor/src/services/updateManager/`.
- **UM-PR5 (audit + logging helpers)**: Extract audit record construction and logging helpers into `graph-editor/src/services/updateManager/`.
- **UM-PR6 (facade tidy-up)**: Reduce `UpdateManager.ts` to a thin facade that composes the extracted modules and preserves initialisation order.

Stop/gates:

- After UM-PR2: explicitly confirm shared mapping initialisation and caching behaviour is unchanged.
- After UM-PR4: explicitly confirm evidence/window/date handling semantics remain unchanged.

Core tests (run for every UM PR, unless the PR explicitly does not touch the covered surface area):

- `graph-editor/src/services/UpdateManager.test.ts`
- `graph-editor/src/services/__tests__/UpdateManager.rebalance.test.ts`
- `graph-editor/src/services/__tests__/UpdateManager.graphToGraph.test.ts`
- `graph-editor/src/services/__tests__/updateManager.externalToGraphEvidenceFields.test.ts`
- `graph-editor/src/services/__tests__/updateManager.updateConditionalProbabilityEvidenceWindow.test.ts`

Safety net tests (run at UM gates and UM end-state):

- `graph-editor/tests/unit/update-manager-uuids.test.ts`
- `graph-editor/tests/state-sync/multi-source-truth.test.ts`

##### Target B — `dataOperationsService.ts`

PR sequence:

- **DOS-PR1 (types + small pure helpers)**: Extract local options/result types and clearly-pure helpers into `graph-editor/src/services/dataOperations/`.
- **DOS-PR2 (notifications boundary)**: Extract toast/notification helpers into `graph-editor/src/services/dataOperations/` so other modules can stay UI-agnostic.
- **DOS-PR3 (get-from-file subsystem)**: Extract “Get from file” orchestration into `graph-editor/src/services/dataOperations/`.
- **DOS-PR4 (put-to-file subsystem)**: Extract “Put to file” orchestration into `graph-editor/src/services/dataOperations/`.
- **DOS-PR5 (get-from-source subsystem)**: Extract “Get from source (versioned)” orchestration into `graph-editor/src/services/dataOperations/`.
- **DOS-PR6 (facade tidy-up)**: Reduce `dataOperationsService.ts` to a thin facade.

Stop/gates:

- After DOS-PR3: explicitly confirm slice/DSL flows and signature warning behaviour are unchanged.
- After DOS-PR5: explicitly confirm external→file append + file→graph update orchestration semantics and logging remain unchanged.

Core tests (run for every DOS PR, unless the PR explicitly does not touch the covered surface area):

- `graph-editor/src/services/__tests__/dataOperationsService.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.integration.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.incrementalGapPersistence.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.openEndedWindowResolution.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.directFetchFailurePropagation.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.forecastFromDailyArrays.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.persistedConfigByMode.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.casePersistedConfigByMode.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.putParameterToFile.metadataOnly.test.ts`
- `graph-editor/src/services/__tests__/dataOperationsService.putParameterToFile.forceCopyClearsNQuery.test.ts`
- `graph-editor/src/services/__tests__/versionedFetch.integration.test.ts`
- `graph-editor/src/services/__tests__/fetchPolicyIntegration.test.ts`
- `graph-editor/src/services/__tests__/fetchDataService.test.ts`
- `graph-editor/src/services/__tests__/fetchDataService.fromFile.permissionsDefault.test.ts`
- `graph-editor/src/services/__tests__/fetchDataService.conditionalFetchPlanning.test.ts`

Safety net tests (run at DOS gates and DOS end-state):

- `graph-editor/tests/pipeline-integrity/simple-query-flow.test.ts`
- `graph-editor/tests/pipeline-integrity/composite-query-flow.test.ts`
- `graph-editor/tests/identity/signature-consistency.test.ts`

##### Target C — `statisticalEnhancementService.ts`

PR sequence:

- **SES-PR1 (types + constants + small helpers)**: Extract pure helpers/constants into `graph-editor/src/services/statisticalEnhancement/`.
- **SES-PR2 (core algorithms split)**: Group related computation routines into a small number of focused modules (no behavioural changes).
- **SES-PR3 (facade tidy-up)**: Reduce the main file to orchestration + re-exports.

Stop/gates:

- After SES-PR2: confirm no changes to numeric output behaviour, rounding, or default assumptions.

Core tests:

- `graph-editor/src/services/__tests__/statisticalEnhancementService.test.ts`
- `graph-editor/src/services/__tests__/lagDistribution.golden.test.ts`
- `graph-editor/src/services/__tests__/lagStatsFlow.integration.test.ts`
- `graph-editor/src/services/__tests__/pathT95Computation.test.ts`
- `graph-editor/src/services/__tests__/pathT95CompletenessConstraint.test.ts`
- `graph-editor/src/services/__tests__/pathT95JoinWeightedConstraint.test.ts`
- `graph-editor/src/services/__tests__/addEvidenceAndForecastScalars.test.ts`
- `graph-editor/src/services/__tests__/cohortHorizonIntegration.test.ts`
- `graph-editor/src/services/__tests__/fetchMergeEndToEnd.test.ts`
- `graph-editor/src/services/__tests__/paramPackCsvRunner.csvDriven.tool.test.ts`

Safety net tests (run at SES gates and SES end-state):

- `graph-editor/src/services/__tests__/cohortEvidenceDebiasing.e2e.test.ts`
- `graph-editor/src/services/__tests__/windowCohortSemantics.paramPack.e2e.test.ts`
- `graph-editor/src/services/__tests__/sampleFileQueryFlow.e2e.test.ts`

##### Target D — `integrityCheckService.ts`

PR sequence:

- **ICS-PR1 (types + constants + pure helpers)**: Extract pure helpers/constants into `graph-editor/src/services/integrityCheck/`.
- **ICS-PR2 (check orchestration split)**: Group checks into focused modules (for example: graph invariants, file invariants, index invariants).
- **ICS-PR3 (facade tidy-up)**: Reduce the main file to orchestration + re-exports.

Stop/gates:

- After ICS-PR2: confirm check coverage is unchanged (no dropped checks).

Core tests:

- `graph-editor/src/services/__tests__/integrityCheckService.fileId.test.ts`
- `graph-editor/src/services/__tests__/integrityCheckService.blankStringEqualsUndefined.test.ts`
- `graph-editor/src/services/__tests__/integrityCheckService.graphParameterDrift.test.ts`
- `graph-editor/src/services/__tests__/integrityCheckService.graphCaseDrift.test.ts`
- `graph-editor/src/services/__tests__/integrityCheckService.conditionalSiblingAlignment.test.ts`
- `graph-editor/src/services/__tests__/integrityCheckService.semanticEvidenceIssues.test.ts`

Safety net tests (run at ICS gates and ICS end-state):

- `graph-editor/src/services/__tests__/sampleFilesIntegrity.test.ts`

##### Target E — `GraphCanvas.tsx`

PR sequence:

- **GC-PR1 (pure helpers first)**: Extract pure helpers into `graph-editor/src/components/canvas/` (prefer existing directory).
- **GC-PR2 (interaction suppression hooks)**: Extract panning/dragging suppression and related state coordination to `components/canvas/`.
- **GC-PR3 (layout clusters)**: Extract dagre and Sankey layout orchestration into `components/canvas/`.
- **GC-PR4 (diagnostics control)**: Consolidate debug logging behind a single toggle mechanism (no behaviour changes unless explicitly approved).
- **GC-PR5 (facade tidy-up)**: Reduce the main file size while keeping ReactFlow wiring and render structure stable.

Stop/gates:

- After GC-PR3: explicitly confirm no render-loop or reactivity changes were introduced (dependency arrays and state ownership preserved).

Core tests:

- `graph-editor/src/components/canvas/__tests__/buildScenarioRenderEdges.test.ts`
- `graph-editor/src/components/canvas/__tests__/buildScenarioRenderEdges.efGeometry.test.ts`
- `graph-editor/src/components/edges/__tests__/EdgeBeads.test.tsx`
- `graph-editor/src/components/edges/__tests__/EdgeBeads.probabilityMode.test.tsx`
- `graph-editor/src/components/edges/__tests__/EdgeBeads.probabilityMode.scalarEvidence.test.tsx`
- `graph-editor/src/components/edges/__tests__/EdgeBeads.derivedBracket.test.tsx`
- `graph-editor/src/components/edges/__tests__/EdgeBeads.derivedForecastBracket.test.tsx`
- `graph-editor/src/components/edges/__tests__/ConversionEdge.sankeyParity.test.tsx`
- `graph-editor/src/services/__tests__/graphStoreSyncIntegration.test.ts`
- `graph-editor/src/services/__tests__/edgeReconnection.test.ts`

Safety net tests (run at GC gates and GC end-state):

- `graph-editor/tests/smoke.test.ts`

##### Target F — `PropertiesPanel.tsx`

PR sequence:

- **PP-PR1 (validation + formatting helpers)**: Extract pure-ish UI helpers into `graph-editor/src/components/panels/properties/`.
- **PP-PR2 (section components)**: Extract major UI sections into `components/panels/properties/` (no business logic).
- **PP-PR3 (panel-specific hooks)**: Extract panel coordination hooks (local buffers, commit-on-blur/apply patterns) into `components/panels/properties/`.
- **PP-PR4 (facade tidy-up)**: Reduce `PropertiesPanel.tsx` to composition and wiring.

Stop/gates:

- After PP-PR3: confirm persistence wiring and “authoritative DSL” behaviour is unchanged.

Core tests (run for every PP PR, unless the PR explicitly does not touch the covered surface area):

- `graph-editor/src/components/__tests__/PropertiesPanel.hooks.test.tsx`
- `graph-editor/src/components/__tests__/PropertiesPanel.latencyToggleTriggersGraphMutation.test.tsx`

Safety net tests (run at PP gates and PP end-state):

- `graph-editor/src/components/__tests__/QueryExpressionEditor.test.tsx`

##### Target G — `ConversionEdge.tsx`

PR sequence:

- **CE-PR1 (pure helpers)**: Move additional pure computations into existing `edges/*helpers*` modules (or new siblings next to them).
- **CE-PR2 (render subcomponents)**: Extract render-only subcomponents (labels/decorations) into siblings within `graph-editor/src/components/edges/`.
- **CE-PR3 (interaction handlers)**: Extract interaction handlers into a focused module that delegates to existing services/menus (no business rules).
- **CE-PR4 (facade tidy-up)**: Reduce `ConversionEdge.tsx` to composition and wiring.

Stop/gates:

- After CE-PR3: confirm scenario overlay selection rules and bead suppression semantics are unchanged.

Core tests:

- `graph-editor/src/components/edges/__tests__/ConversionEdge.sankeyParity.test.tsx`

Safety net tests (run at CE gates and CE end-state):

- `graph-editor/src/components/edges/__tests__/EdgeBeads.test.tsx`
- `graph-editor/src/components/edges/__tests__/EdgeBeads.probabilityMode.test.tsx`

#### Programme-Level Gates (When to Stop and Reassess)

Stop and reassess before continuing if any of the following occur:

- A PR requires editing existing tests (approval needed).
- A refactor step forces a change to frozen semantics (Decision 1).
- A circular dependency emerges that cannot be resolved by a small shared types/helpers module.
- A UI refactor introduces a render loop or performance regression that cannot be resolved without behavioural change.

#### Secondary Candidates (Only After Primary Targets Stabilise)

After the primary targets are stable and the programme gates are satisfied, apply the same procedural approach to:

- `graph-editor/src/contexts/TabContext.tsx`
- `graph-editor/src/components/editors/GraphEditor.tsx`
- `graph-editor/src/components/QueryExpressionEditor.tsx`

Each secondary candidate uses the same extraction discipline, with fixed PR sequences defined here (so execution remains procedural).

##### Secondary 1 — `TabContext.tsx`

PR sequence:

- **TC-PR1 (types + pure helpers)**: Extract pure types and helpers into `graph-editor/src/contexts/tabContext/`.
- **TC-PR2 (registry/cache boundaries)**: Extract internal data structures and caching helpers into `contexts/tabContext/` without changing semantics.
- **TC-PR3 (operations split)**: Extract tab operations into `contexts/tabContext/` (facade retains the exported context/hook surface).
- **TC-PR4 (facade tidy-up)**: Reduce `TabContext.tsx` to composition + exports.

Stop/gates:

- After TC-PR3: explicitly confirm “source of truth” rules remain unchanged (IndexedDB vs in-memory caches, and any fileRegistry boundaries).

Tests:

- `graph-editor/tests/state-sync/multi-source-truth.test.ts`
- `graph-editor/src/services/__tests__/graphStoreSyncIntegration.test.ts`

##### Secondary 2 — `GraphEditor.tsx`

PR sequence:

- **GE-PR1 (local contexts and small components)**: Extract embedded local contexts/components into dedicated files under `graph-editor/src/components/editors/` (no behavioural changes).
- **GE-PR2 (layout orchestration split)**: Extract rc-dock layout orchestration into a hook under `graph-editor/src/components/editors/`.
- **GE-PR3 (event wiring split)**: Extract event/listener wiring into a focused module/hook.
- **GE-PR4 (facade tidy-up)**: Reduce `GraphEditor.tsx` to composition + exports.

Stop/gates:

- After GE-PR2: explicitly confirm layout persistence and panel selection behaviours remain unchanged.

Tests:

- `graph-editor/tests/smoke.test.ts`
- `graph-editor/src/services/__tests__/graphStoreSyncIntegration.test.ts`

##### Secondary 3 — `QueryExpressionEditor.tsx`

PR sequence:

- **QEE-PR1 (pure parsing/render helpers)**: Extract chip parsing and deterministic helpers into `graph-editor/src/components/editors/queryExpression/`.
- **QEE-PR2 (UI subcomponents)**: Extract chip UI subcomponents into `components/editors/queryExpression/`.
- **QEE-PR3 (facade tidy-up)**: Reduce the editor file to composition + exports.

Stop/gates:

- After QEE-PR2: explicitly confirm normalisation behaviour and chip rendering semantics remain unchanged.

Tests:

- `graph-editor/src/components/__tests__/QueryExpressionEditor.test.tsx`
- `graph-editor/tests/unit/query-dsl.test.ts`
- `graph-editor/tests/unit/composite-query-parser.test.ts`

---

### Strategy: How We Split Without Breaking Things

This work should be executed as a sequence of small, reversible steps:

- **Keep the existing file path as the facade**
  - The existing file remains the public entry point used by callers.
  - Internals move into sibling modules under a dedicated directory and are imported by the facade.
  - We do **not** introduce new public “replacement” entrypoints (for example `services/dataOperations/index.ts`) during the slimdown itself.

- **Extract by dependency direction**
  - Start with **pure utilities/types** (no imports from app state or UI).
  - Then extract **domain logic** (deterministic transforms, parsing, derivations).
  - Finally extract **orchestration** (calls to services, DB, network, toasts, logging).

- **Prefer one-way module dependencies**
  - Avoid cross-imports between new modules that used to be “free” inside one giant file.
  - If two parts need shared types/utilities, create a small shared module rather than a cycle.

- **Avoid re-ordering side effects**
  - Keep initialisation order stable while splitting. Re-ordering “just for tidiness” is a frequent source of regressions.

---

### Proposed Module Boundaries (Updated for Current Code)

#### 1) `dataOperationsService.ts` → internal modules under `graph-editor/src/services/dataOperations/…`

Current reality (as of 14-Jan-26):

- It coordinates window aggregation, fetch/refetch policy, contexts/slice isolation, UpdateManager application, statistical enhancements, session logging, and user notifications.
- There is real coupling to contexts + target slices, and to UK date conversion utilities.

Proposed internal split:

- **Core types and small helpers**
  - Local types for “options” and “results”, plus small pure helper functions.
- **Get-from-file**
  - File→graph orchestration and related transforms (keeping override/permission semantics unchanged).
- **Get-from-source (versioned)**
  - External→file append + file→graph update orchestration, including session logging.
- **Put-to-file**
  - Graph→file persistence orchestration (keeping IndexedDB/gitrepo invariants intact).
- **Fetch planning and policy**
  - Fetch/refetch decision helpers and window computations (most of which already exist as services; extraction here is mainly about readability and call-site shape).
- **Notifications boundary**
  - Keep toast usage centralised so other modules can stay UI-agnostic.

Guardrails:

- No changes to slice isolation logic, signature warning behaviour, or date format conversions during extraction.
- Do not introduce alternative fetching paths; keep the existing service API stable.

#### 2) `UpdateManager.ts` → internal modules under `graph-editor/src/services/updateManager/…`

Current reality (as of 14-Jan-26):

- It includes public types, mapping table initialisation (with shared static caching), mapping application engine, conflict strategies, audit, logging, and graph-specific behaviours (including rebalancing and evidence/window field handling).

Proposed internal split:

- **Public types and contracts**
- **Mapping configuration declaration**
- **Mapping application engine (override gating + transforms + change tracking)**
- **Graph-specific behaviours**
  - Rebalancing, conditional-edge sibling logic, evidence/window field updates, and any topology lookups.
- **Audit + session logging utilities**

Guardrails:

- Preserve the “single code path” rule for rebalancing and override gating.
- Preserve shared mapping configuration caching behaviour (it exists for test performance and CI stability).

#### 3) `GraphCanvas.tsx` → continue extracting into existing `graph-editor/src/components/canvas/…`

Current reality (as of 14-Jan-26):

- `graph-editor/src/components/canvas/` already exists (for example `buildScenarioRenderEdges.ts`).
- `GraphCanvas.tsx` still mixes ReactFlow wiring, interaction suppression, routing/bundling, Sankey layout, scenario rendering, diagnostics, and event plumbing.

Plan for this area:

- Prefer to extract into the **existing** `components/canvas/` directory, rather than inventing a new layout.
- Treat probability/what-if behaviour as a high-risk invariant: reduce duplication by centralising where appropriate, but do not change semantics.

#### 4) `PropertiesPanel.tsx` → internal modules under `graph-editor/src/components/panels/properties/…` (preferred)

Current reality (as of 14-Jan-26):

- There is already a wrapper: `graph-editor/src/components/panels/PropertiesPanelWrapper.tsx`.
- The panel mixes UI sections, local edit buffering, validation helpers, and service/hook wiring.

Proposed split:

- **Panel section components**
  - Extract major sections into dedicated components under `components/panels/properties/`.
- **Validation and formatting helpers**
  - Keep UI-only validation local; promote shared validation to `lib/` or an appropriate service only if it’s used elsewhere.
- **State coordination hooks**
  - Panel-specific hooks for local buffers and commit-on-blur/apply patterns (UI boundary only).

Guardrails:

- Do not introduce business logic into the panel; delegate to existing services/hooks.
- Keep the “authoritative DSL” and persistence behaviours unchanged.

#### 5) `ConversionEdge.tsx` → finish consolidation within existing `graph-editor/src/components/edges/…`

Current reality (as of 14-Jan-26):

- Significant extraction already exists: `EdgeBeads.tsx`, `edgeBeadHelpers.tsx`, `edgeLabelHelpers.tsx`, `BeadLabelBuilder.tsx`.

Plan for this area:

- Consolidate remaining mixed responsibilities into the existing helper modules (or new siblings next to them), rather than creating a parallel `edges/conversion/` subtree.
- Keep overlay/scenario rendering rules stable (especially selection rules and bead suppression during pan/drag).

---

### Execution Plan (Phased, Safe, and Test-Guided)

#### Phase 0 — Readiness and Guardrails (must be true before the first implementation PR)

- Confirm there are no other active refactors touching the same mega files (to avoid merge-conflict churn).
- Confirm and document (in this file) the invariants we are preserving for:
  - contexts/slice isolation
  - date format handling
  - rebalancing and override gating
- Agree the entrypoint rule: existing file paths remain the only public entry points during slimdown.
- Identify the specific existing test files to run per target (by file path).
  - Note: modifying existing tests requires explicit authorisation.

#### Phase 1 — Extract “Pure” Modules (Low Risk)

For each target file:

- Extract constants, types, and pure helper functions into a dedicated internal directory.
- Keep imports one-directional (facade imports helpers).
- Keep behaviour unchanged.

#### Phase 2 — Extract Subsystems (Medium Risk)

- Move coherent clusters into dedicated modules (for example: mapping config vs engine; Sankey vs routing; get-from-file vs get-from-source).
- Keep orchestration in the facade until the end of this phase to avoid accidental initialisation re-ordering.

#### Phase 3 — Clean-up and Documentation (Controlled)

- Delete clearly dead code only when it is obviously unused and protected by existing tests.
- Add brief module-level responsibility notes so future contributors know where to add new behaviour.

---

### Testing Plan (Relevant Tests Only)

Principles:

- Run tests by **explicit file paths** only.
- Do not run the full suite unless explicitly requested or the change is genuinely pervasive.
- If a refactor step requires updating an existing test file, obtain explicit approval first.

Plan:

- For each refactor PR, list the specific test file paths that cover the touched area and run only those.
- If a failure reveals an untested coupling, propose a test improvement separately (with explicit approval).

---

### Risk Register (Updated)

- **Circular dependencies after splitting**
  - Mitigation: extract shared types/utilities into small shared modules; keep dependencies one-way.
- **Behavioural drift from “small” refactor**
  - Mitigation: small PRs; stable entrypoints; run the same narrow test set per PR; revert quickly on unexpected changes.
- **Loss of session logging coverage**
  - Mitigation: treat logging calls as part of orchestration boundaries; keep log event names stable.
- **UI performance regressions (GraphCanvas / ConversionEdge)**
  - Mitigation: preserve memoisation boundaries; avoid new state layers; avoid broad dependency-array changes as part of extraction.
- **Accidental slice/date semantic changes**
  - Mitigation: treat contexts/date logic as invariants; move code first, change behaviour later only with explicit approval.

---

### Definition of Done

This slimdown effort is “done” when:

- Each primary target file is reduced to a maintainable size, or replaced by a thin facade that delegates to internal modules.
- Each new module has a single responsibility and a clear name aligned with existing directory structure.
- No duplicate code paths exist for the same operation (especially in update/rebalance/data ops and scenario rendering).
- Relevant existing tests for the touched domains pass.
- Session logging for external/data operations remains intact.

---

### Related Documents

- **Primary plan**: this file.
- **Archived (superseded) refactor proposals and analyses** (archived during the 14-Jan-26 update of this plan):
  - `docs/archive/refactor/REFACTORING_PLAN_GRAPH_COMPONENTS.md`
  - `docs/archive/refactor/GRAPH_CANVAS_ARCHITECTURE.md`
  - `docs/archive/refactor/GRAPH_EDITOR_ARCHITECTURE.md`
