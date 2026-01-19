# Core Pipelines Testing Strategy (First Principles) + Current Coverage Analysis

Date: 19-Jan-26

## Purpose

This document provides:

- A **systematic structural analysis** of DagNet’s current automated testing coverage for core foundational systems.
- A **first-principles testing design proposal** that improves assurance for multi-step, subtle logic: retrieval, cache/cut, MECE aggregation, file persistence, update cascades, and probability analysis.

This is explicitly not “add some more tests”. It is a proposal to restructure how we test and what “done” means for core system safety.

## Scope (what this covers)

Core systems:

- Retrieval and planning: pinned DSL explosion, slice planning, incremental fetch, maturity/refetch policy, bounded cohort horizons.
- Cache semantics: query signature, context definition hashing, slice family matching, mode isolation (window vs cohort).
- MECE aggregation: implicit uncontexted totals, partition completeness detection, selection and application.
- Persistence & state: parameter/case file writes, IndexedDB/FileRegistry interactions relevant to correctness, “clear all data”.
- Update cascades: file → graph mappings, graph topo pass recalculation, forecast/evidence attachment and propagation.
- Probability semantics: evidence-only vs forecast vs blended, reach probability analysis, invariants about what data can influence which mode.

Out of scope (for this specific proposal’s first iteration):

- UI testing breadth (menus, panels) except where UI acts as a pipeline trigger.
- Git operations beyond “does not corrupt data semantics” (there are separate service tests for git flows).
- Performance benchmarking; we will treat performance as a gated property only where it affects correctness (timeouts and duplicated work).

## What we have today (coverage map)

### Test estate inventory (service-layer tests)

Within `graph-editor/src/services/__tests__/` (top-level files):

- Approximately **172** test files at the top level.
- Naming convention distribution (approximate):
  - **e2e**: 14
  - **integration**: 20
  - **critical**: 2
  - **golden**: 1
  - **other tests**: 135

Shared test harness:

- `graph-editor/src/services/__tests__/helpers/` currently contains **1** helper module: `testFixtures.ts`.

Implication: the suite is large, but harness reuse is minimal; many tests are “hand-rolled”, which increases variance and leaves gaps in cross-step assertions.

### Existing documentation we should align with

- `docs/current/project-contexts/CONTEXTS_TESTING_ROLLOUT.md` (contexts v1 testing matrix and expectations).
- `docs/archive/TESTING_STRATEGY.md` and `docs/archive/INTEGRATION_TESTING_GUIDE.md` (general pyramid guidance).
- `graph-editor/src/services/__tests__/TEST_SUITE_SUMMARY.md` (data operations test suite summary; useful but narrow in scope).

### What is tested well today (strengths)

The test suite already contains substantial coverage in these areas:

- **DSL parsing/explosion**: multiple tests exist for DSL explosion (`dslExplosion*`) and constraint parsing (`queryDSL` tests), including pinned DSL patterns.
- **Incremental fetch and refetch policies**: `fetchPolicyIntegration.test.ts`, `fetchRefetchPolicy*.test.ts`, `dataOperationsService.openEndedWindowResolution.test.ts`, and related suites cover many policy branches and previously observed regressions (e.g. overlapping windows).
- **MECE and multi-slice behaviour**:
  - `pinnedDsl.orContextKeys.cacheFulfilment.test.ts` asserts MECE fulfilment behaviour for typical pinned patterns.
  - `cohortContext.cacheAndMECE.test.ts` covers `contextAny` coverage requirements and MECE usage for uncontexted cohort queries.
  - Several context MECE equivalence and multi-slice cache tests exist (`multiSliceCache.e2e.test.ts`, `contextMECEEquivalence.*`).
- **Cross-layer integrations in targeted areas**:
  - Multiple “E2E” tests exist which stub specific adapters (e.g. Amplitude) but execute production service logic.
  - Several integration tests exercise data operations and update flows.

### What is structurally weak today (gaps that explain recent regressions)

This section is intentionally blunt and rooted in observed failure classes.

#### 1) Too many “production replicas” rather than production code

Example: `cacheIntegrity.e2e.test.ts` implements its own `CacheCheckService` and IDB store. It validates concepts (timezone, basic caching), but it is not a regression barrier for DagNet’s actual retrieval pipeline because the tested logic is not the logic that runs in production.

Structural consequence: confidence is created where it should not be; regressions can bypass these tests entirely.

#### 2) Weak or inconsistent mode isolation guarantees across the pipeline

We have tests that mention “do not mix window and cohort” and “do not reuse window slice for cohort”. However, recent defects show that:

- Mode isolation was enforced in some places by inspecting `sliceDSL` strings.
- Production data often encodes mode in **fields** (`window_from/window_to` vs `cohort_from/cohort_to`) even when `sliceDSL` is “untyped” (e.g. `context(channel:other)`).

Structural consequence: tests that only reason about `sliceDSL` are insufficient; the pipeline must enforce mode isolation using the actual persisted shape of values.

#### 3) “Retrieve all” success semantics are not tested as an end-state property

Current `retrieveAllSlicesService.test.ts` asserts:

- Per-item exceptions increment the run error count.
- A success marker is written only on a run with zero throws.

It does not test the intended operational contract:

- A subsequent run after partial failure should identify unresolved gaps and fill them.
- A run should never consider itself complete if it silently reused wrong-mode cached data.

Structural consequence: the system can report “complete” while being semantically incomplete (or worse: “complete” based on invalid cache fulfilment), and tests will still pass.

#### 4) Invariants are present but not centralised; there is no “core contract” layer

Many tests contain strong invariants, but they are duplicated ad-hoc:

- Mode isolation.
- Minimal fetch window merging.
- MECE completeness requirements.
- Signature stability/instability expectations.

Structural consequence: invariants drift, coverage is uneven, and new codepaths can violate invariants without a consistent “contract suite” catching it.

#### 5) Limited failure-injection and resumability testing

The system must be resilient to realistic partial failures (rate limits, transient errors) and resume correctly. We have observed live failures (429s) that leave gaps, and then later runs fail to refill.

Structural consequence: without explicit partial-failure + resume tests, the system can be correct only in “perfect network” scenarios.

#### 6) Probability semantics not guarded as system-level invariants

The evidence-only plausibility issue you raised highlights a core risk:

- Evidence-only analysis must not be affected by forecast-only or wrong-mode cache.
- MECE aggregation must not “smear” across incompatible slice sets.

Structural consequence: without first-class invariants for probability semantics, regressions can produce plausible-looking numbers that are wrong.

## First principles (what we must guarantee)

This section defines what “correct” means. These are the system contracts that testing must enforce.

### A. Correctness must be defined as pipeline end-state properties

For core pipelines, correctness cannot be validated solely at a function boundary. It must be validated as:

- “Given pinned DSL P and a graph G, after retrieve-all completes, the planner must report covered for all required slices, or must report explicitly and precisely which items are missing and why.”

### B. Core invariants must be expressed once and reused everywhere

We need a central invariant catalogue that is:

- Versioned.
- Referenced by tests and by diagnostics.
- The basis for gating changes that touch retrieval/cache/probability.

### C. Testing must model the real failure space

The failure space is not “one request fails”. It includes:

- Partial slice failures (some params within a slice fail).
- Partial date windows (gaps).
- Mixed-mode data coexisting in a file.
- Stale signatures mixed with newer signatures.
- MECE partitions that are incomplete or computed.

Testing must deliberately generate and exercise these states.

### D. Avoid “replica logic” tests for core correctness

We should not validate core correctness with substitute cache checkers or alternative planners. We must test the production pipeline, with controlled boundaries:

- External calls are mocked.
- Time is frozen.
- State stores are real (or faithful test doubles), not bespoke stubs that bypass production logic.

## Design proposal: a structural overhaul

### 1) Establish a “Core Contract Suite” (CCS)

Create a curated suite whose job is not breadth, but assurance:

- It contains the invariant catalogue as executable checks.
- It runs fast enough to be a standard gate for core changes.
- It is stable and authoritative; we do not weaken it without explicit review.

CCS should be organised by pipeline stage, not by file ownership:

- Planner/coverage contracts.
- Fetch execution contracts.
- Persistence contracts.
- Update cascade contracts.
- Probability semantics contracts.

### 2) Introduce a shared pipeline harness layer

The harness is the structural change that turns ad-hoc tests into systematic pipeline tests.

The harness should standardise:

- Seeding graph + parameter files + contexts into a consistent test environment.
- Running “retrieve all slices” deterministically over exploded pinned DSL.
- Capturing structured artefacts (not scraped logs) for:
  - planned items and coverage decisions
  - actual fetch windows executed
  - written file values (before/after)
  - resulting graph state

The harness must make it easy to express:

- “simulate partial failure on these (slice, item) tuples”
- “run again; verify only missing gaps are fetched”

### 3) Formalise a failure-class taxonomy and ensure coverage

We should maintain a small taxonomy for foundational systems, each with:

- A precise description.
- The invariant(s) it violates.
- Minimal reproduction state shape.
- Expected detection point (planner, cache cut, merge, topo pass).

Examples (anchored in recent issues):

- Cohort satisfied by window slices due to “untyped sliceDSL” and window bounds fields.
- MECE aggregation failure due to signature fragmentation across context values.
- Duplicate actual fetch windows due to overlapping gap planning.
- “Retrieve all complete” despite unresolved missing coverage after partial failures.
- “Clear all data” leaves stale slices due to wrong workspace file selection or malformed keys.

This taxonomy becomes a structural checklist; changes must consider whether they can reintroduce any listed class.

### 4) Add state-space tests (systematic generators, not random property tests only)

Rather than adding hundreds of example tests, add a small set of systematic state-space tests that vary:

- Mode: cohort vs window.
- Slice encoding: typed `sliceDSL` vs untyped `sliceDSL` with bounds fields.
- MECE completeness: complete vs incomplete.
- Signature: all same vs mixed by timestamp.
- Coverage: full vs gaps at start/middle/end.

The goal is not randomness; it is controlled exploration of the known state dimensions that cause subtle regressions.

### 5) Add post-run “semantic completeness” validation in tests (not in production, initially)

You are correct that production should refill gaps without requiring a separate coverage check. However, tests must validate this end-state explicitly:

- After any retrieve-all run (especially after simulated partial failure), a second run must:
  - plan only what is missing,
  - fetch only what is missing,
  - and converge to covered state for the pinned DSL.

This becomes a hard invariant in CCS.

### 6) Tie probability semantics to retrieval semantics

We need explicit system-level invariants:

- Evidence-only analysis must depend only on evidence-mode slices, never on forecast baselines.
- Evidence-only results must be invariant to the presence of window slices that are not requested in cohort mode.
- MECE aggregation must operate only on compatible slice sets (same mode, same slice family dims, compatible signature rules).

This is where we should use a small number of “golden” or “fixture” graphs whose expected results are stable and externally sanity-checkable.

## Structural recommendations for governance

### Change gating (policy)

Any change touching the following must add or update CCS coverage:

- `dataOperationsService` retrieval planning and cache cutting.
- `windowAggregationService` / incremental fetch logic.
- `sliceIsolation` / slice family matching logic.
- `meceSliceService` and MECE selection.
- query signature computation and context hashing logic.
- topo pass logic that attaches evidence/forecast/blended values.

### Test ownership

- Assign ownership of CCS to a small set of maintainers (review required).
- Treat CCS as a safety barrier; it should fail loudly and be hard to weaken.

## Rollout proposal (phased, structural)

Phase 0 (baseline capture)

- Catalogue existing tests by subsystem and by “production vs replica logic”.
- Identify which tests already express key invariants and could migrate to CCS.

Phase 1 (core contract suite + harness)

- Create CCS structure and a shared harness.
- Migrate a small number of existing high-signal tests to use the harness and become CCS members.

Phase 2 (failure-class coverage + resumability)

- Encode the recent failure classes as CCS tests using harness-based failure injection.
- Add resumability tests for rate limit failures (429) and partial slice completion.

Phase 3 (probability semantics contracts)

- Add golden/fixture graphs for evidence-only reach probability and ensure invariance under irrelevant cache states.

## Success metrics (what “assurance” means)

We should measure:

- **Invariant coverage**: each invariant has at least one CCS test that would fail if violated.
- **Failure-class coverage**: each failure class has a minimal reproduction CCS test.
- **Convergence**: retrieve-all converges to covered state under partial failure + rerun scenarios.
- **No replica logic**: CCS tests must not implement alternative planners/cache checkers for core correctness.

## Immediate observations tied to recent incidents

These incidents are not “more tests needed”; they are symptoms of missing structure:

- **MECE signature regression**: insufficient contract coverage for “MECE grouping must be stable across context values while still invalidating on context definition change”.
- **Duplicate fetch windows**: missing contract coverage for “planned fetch windows must be minimal and non-overlapping for a given run”.
- **Cohort/window mode confusion via untyped sliceDSL**: missing contract coverage for “mode is determined by persisted value shape as well as DSL text; mode isolation is absolute”.
- **Retrieve-all convergence failure after partial errors**: missing contract coverage for “retrieve-all must converge across runs without manual cache busting”.

## Review questions (for you to decide)

1) Should we treat CCS as a mandatory gate for merges affecting core pipelines?
2) Do you want evidence-only probability results to have at least one externally validated golden fixture (e.g. “expected ~5%” graphs)?
3) Should we treat “semantic completeness” as a required post-condition for retrieve-all runs (tests enforce convergence), even if the UI messaging remains per-run?

