## Phase 2 Execution Action Plan (t95 / latency_parameter)

**Created:** 15-Dec-25  
**Status:** In progress — executed stepwise with explicit approval gates  

---

### Purpose

We have started making Phase 2 implementation changes without a properly enforced approval boundary and without a complete, test-driven verification that Phase 2 is truly complete. This document defines:

- A strict approval workflow (especially for test changes)
- A completeness definition for Phase 2
- A stepwise execution plan to bring Phase 2 to a proven “green” state
- A formal audit checklist against the Phase 2 design and implementation plan

This plan is prose-only and is intended to be the single operational reference for completing Phase 2 work.

---

### Progress (live status)

This section is updated as work proceeds.

- **Schema parity (LatencyConfig)**
  - Status: ✅ Green (schema parity automated test passing)

- **TypeScript compile**
  - Status: ✅ Green (`npx tsc --noEmit`)

- **Legacy maturity field deletion**
  - Status: ✅ Green (repo-wide excluding explicit user-owned exclusions)
  - Notes:
    - `graph-editor/`: ✅ Green (runtime, tests, and shipped schemas/docs updated; no remaining references)
    - Repo root: user-owned `test.json`/`test2.json` explicitly excluded by user (ignored; remaining references live only there)

- **Phase 2 tests (canonical blend + override semantics)**
  - Status: ✅ Green
  - Notes:
    - Schema parity + canonical blend + default injection + override gating tests are green.
    - Formula A has been deleted; completeness uses a one-way t95 tail constraint; focused Phase 2 suite is green.
    - Some Phase 1-only contracts remain explicitly skipped where they conflict with Phase 2 semantics.

---

### Non-Negotiables (Operating Rules)

- **Tests are the gold standard.** Code changes must be driven by failing tests and verified by green tests.
- **Test changes require explicit user approval.** The assistant must not modify tests unless the user has explicitly authorised that specific test change.
- **No logic in UI/menu files.** UI must remain an access point only; business logic (default injection, gating, persistence rules) must live in services.
- **No duplicate code paths.** Any new Phase 2 behaviour must be centralised (single service path) and all call sites updated to use it.
- **Parity and schema correctness are mandatory.** Schema/TypeScript/Python parity tests must pass.

---

### Phase 2 Definition of “Complete”

We may claim “Phase 2 is complete” only when all of the following are true:

- **Phase 2 tests enabled and passing** (the Phase 2 “red tests” are no longer skipped and pass green).
- **Schema parity tests passing** (including automated schema/type parity checks).
- **Solid test coverage exists for the Phase 2 latency fields and override behaviour.**
  - The test suite must explicitly cover:
    - `latency_parameter` enablement behaviour
    - `latency_parameter_overridden` behaviour (graph↔file mapping and gating)
    - `t95` / `t95_overridden` behaviour (default injection + “do not overwrite when overridden”)
    - `path_t95` / `path_t95_overridden` behaviour (topo-computed value + “do not overwrite when overridden”)
  - Coverage must include both unit-level service tests and at least one pipeline-level integration test.
- **No active Phase 1-only contract tests contradict Phase 2 semantics.**
  - Such tests must be explicitly deprecated (skipped) with a clear reason and link to Phase 2 docs, or updated to Phase 2 expectations (with explicit approval).
- **No Phase 2 business logic resides in UI.**
  - Default injection, override gating, and persistence behaviour must be implemented in services, not UI.
- **Fixtures/samples updated** so that Phase 2 schema fields are represented wherever required.
- **The legacy maturity field has been completely deleted from the codebase.**
  - Zero references across TypeScript, Python, schemas, services, and tests.
  - No deprecated fallbacks or “migration-only” code paths remain in runtime logic.

---

### Explicit Approval Gates

Before each of the following actions, the assistant must request approval and wait:

- **Any test file modification**
- **Any behaviour change that intentionally breaks a previously-green contract**
- **Any schema change that affects stored file format or compatibility**

The user may approve or reject each gate independently.

---

### Immediate Reset (Stabilise Before Proceeding)

Goal: stop churn and establish a clean baseline from which to run TDD.

- Revert any unauthorised test edits back to the last approved state.
- Confirm the working tree only contains:
  - intended Phase 2 implementation changes, and
  - explicitly approved test changes (none by default).
- Run the minimum viable set of tests to re-establish a known baseline (see “Test Execution Strategy”).

Deliverable: a short report listing which files are changed and why.

---

### Observed Gaps vs Phase 2 Spec (as of 15-Dec-25)

This section lists concrete gaps already observed between the current working state and `t95-fix-implementation-plan.md`.
It is intentionally specific (tests, files, symptoms) and will be expanded/validated by the Phase 2 audit.

- **Schema parity for `LatencyConfig`**
  - Previous symptom: automated parity test reported schema missing Phase 2 fields (`latency_parameter`, `latency_parameter_overridden`, `t95_overridden`, `path_t95_overridden`).
  - Current status: ✅ fixed; parity test passing.

- **Phase 2 canonical blend not yet enforced end-to-end**
  - Symptom: Phase 2 expectation “window-mode p.mean becomes the canonical blend” fails when enabled.
  - Likely cause: the fetch pipeline still contains Phase 1 behaviour that can suppress application of blended p.mean for `window()` execution.
  - Required outcome: for latency edges, window-mode `p.mean` reflects the canonical blend (non-latency edges remain unblended).

- **Default injection is not proven to be correctly centralised and persisted**
  - Spec requirement: default `t95` must be injected by the service layer on `latency_parameter` enablement and must persist via dirty tracking.
  - Previous issue: attempts to assert persistence in node test environment failed due to `window` not existing (FileRegistry dispatched browser events).
  - Current status: ✅ fixed; FileRegistry dispatch is guarded in node environment, and the persistence test passes.

- **Override gating is not fully proven on the real write-back path**
  - Spec requirement: derived values must not overwrite overridden values.
  - Observed symptom: Phase 2 override tests fail when enabled if the write path applies derived values unconditionally.
  - Required outcome: override gating must apply in the actual update path used by the pipeline (not only in static mappings).

- **Legacy maturity field deletion is not yet achieved**
  - New completeness requirement: the legacy maturity field must be completely deleted from the codebase (no runtime references, no schema/types, no tests).
  - Required outcome: zero references across TypeScript, Python, schemas, services, and tests; sample/fixture files touched by this work must also remove the legacy maturity field.

---

### Phase 2 Audit (Prove Completeness vs the Spec)

Goal: verify Phase 2 work against `t95-fix-implementation-plan.md` and identify gaps.

Audit dimensions:

- **Schema / Types / Python model parity**
  - Confirm `LatencyConfig` fields match across:
    - TypeScript types
    - YAML schema
    - Python Pydantic model
  - Confirm parity tests are green.

- **Enablement semantics**
  - Confirm `latency_parameter` is the canonical enablement flag in all logic.
  - Confirm the legacy maturity field is completely deleted from the codebase (no runtime logic, no schema/type presence, no tests referencing it).

- **Default injection**
  - Confirm defaults are injected by the service layer at the correct moment.
  - Confirm defaults persist via the file dirty mechanism and are observable in storage.

- **Override gating**
  - Confirm write-back of derived values respects override flags:
    - derived `t95` does not overwrite when `t95_overridden` is true
    - derived `path_t95` does not overwrite when `path_t95_overridden` is true
    - `latency_parameter` respects `latency_parameter_overridden`

- **Canonical blend**
  - Confirm `p.mean` is computed via the canonical blend formula for latency edges in window and cohort modes as specified.
  - Confirm non-latency edges retain non-blended behaviour.

- **Fixtures / samples / bundled graphs**
  - Confirm any bundled graphs and test fixtures align with Phase 2 schema fields where required.

Deliverable: a table “Spec requirement → current implementation status → failing tests (if any) → files to change”.

---

### Test Execution Strategy (Fast, Focused, Repeatable)

We will not run the full suite unless explicitly requested.

Core Phase 2 test set:

- Schema parity automated test(s) relevant to `LatencyConfig`
- The Phase 2 “red tests” file(s) once enabled

Required additional coverage (if not already present after enabling Phase 2 tests):

- **Service-level tests (UpdateManager)**
  - Default injection on enablement:
    - When `latency_parameter` transitions false→true, `t95` is injected to the default if missing and not overridden.
    - The injected default is persisted via the file dirty mechanism (or equivalent persistence path used in the test environment).
  - Override gating:
    - Derived `t95` must not overwrite when `t95_overridden` is true.
    - Derived `path_t95` must not overwrite when `path_t95_overridden` is true.
    - `latency_parameter` must respect `latency_parameter_overridden` in graph↔file synchronisation.

- **Pipeline-level integration tests (fetch pipeline)**
  - Window-mode canonical blend:
    - For latency edges, `p.mean` reflects the canonical blend of evidence and forecast weighted by completeness.
    - For non-latency edges, `p.mean` equals evidence mean (no blend), and forecast remains present when available.
  - Cohort-mode override respect:
    - The topo/LAG pass may compute `path_t95`, but must not overwrite an overridden `path_t95`.

Notes on test environment:

- Tests must be runnable in the declared Vitest environment for the file.
- If a test asserts file “dirty” behaviour, it must do so via a test-safe mechanism that does not assume a browser `window` object in node environments.

Execution pattern:

- Enable a minimal set of Phase 2 tests (with approval).
- Run only those tests.
- Fix code until green.
- Re-run the same tests to confirm no regression.

Deliverable: terminal output showing each run and final green state.

---

### Implementation Steps (Order of Operations)

This is the expected order once the audit is complete and test enabling is approved:

1. **Schema parity first**
   - Ensure the schema contains the new Phase 2 fields required by parity tests.
   - Re-run schema parity tests until green.

2. **Enable Phase 2 tests (approved)**
   - Convert Phase 2 “red tests” from skipped/todo to active, minimal diff only.
   - Explicitly mark superseded Phase 1 contracts as deprecated if they conflict with Phase 2 semantics.

3. **Drive code to green**
   - Remove any remaining Phase 1 behavioural shims that block Phase 2 outcomes.
   - Implement default injection and override gating in services (not UI).
   - Ensure canonical blend is applied in the execution pipeline per spec.

4. **Fixture/samples alignment**
   - Update fixtures/samples only when required for Phase 2 correctness (with approval if tests must change).

5. **Final verification**
   - Re-run the approved Phase 2 test set and schema parity tests.
   - Produce a short completion report: “what changed, why, and which tests prove it”.

---

### Open Questions (Must Be Resolved Explicitly)

- What is the intended migration policy for the legacy maturity field in stored files?
  - Phase 2 requirement: the legacy maturity field is removed completely from the codebase.
  - Sample/fixture policy: the legacy maturity field is removed completely in any sample/fixture files touched by this work.
  - Repository-wide migration of other files: handled separately by the user.

- Exactly which Phase 1 contract tests should remain as compatibility expectations (if any), vs being deprecated?

---

