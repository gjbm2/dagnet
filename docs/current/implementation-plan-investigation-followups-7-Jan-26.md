## Implementation plan: investigation follow-ups (delegation vs registration) — phases 1–6

**Date:** 7-Jan-26  
**Source investigation:** `investigate/investigation-delegation-vs-registration-1-Nov-25.md`  
**Scope:** Implement **Solutions A–F** and harden **Solution G** (cache selection), with the clarified semantics below.  
**Explicit non-scope:** Phase 7 “exclude term dropped in persisted evidence full_query” remains an **open investigation** item only (no implementation yet).

**Status (updated 8-Jan-26): Completed**
- Phases **1–6** in this plan have now been implemented.
- Phase 7 remains an open investigation item (as stated above).
- Additional follow-on work beyond this plan is now tracked in `investigate/investigation-delegation-vs-registration-1-Nov-25.md` under “Follow-on work (new proposals)”.

---

### Key clarifications (authoritative for this plan)

- **MSMDC should generate `to(X)` `n_query` strings** (normal form). We do not plan a bulk migration: new values will be generated in normal form; legacy `from(A).to(X)` may remain and must continue to work.
- **Window slices** must **not** actively prepend any anchor into `n_query`. (They should interpret `to(X)` as “arrivals at X within the window”.)
- **Cohort slices** must **actively prepend** `from(A)` to an anchor-free `n_query` **iff** a cohort anchor is defined for the slice/edge. (If no anchor exists, we must not invent one.)
- If an `n_query` **already contains** `from(A)`, we may continue to use it (it is no worse than current behaviour).
- Before implementing Amplitude “single event” denominator execution in DAS, we must first use the **existing live Amplitude local E2E machinery** to validate the **exact HTTP syntax and response shape** for single-event queries.

---

## Background: what is unfinished

From the investigation doc, the unfinished work decomposes into:

### 1) Cache selection hardening (Solution G hardening)
The “recency wins” rule is implemented, but must be hardened for:
- multiple competing MECE context slice-sets (multiple “generations”),
- multiple competing explicit uncontexted slices,
- and robust, complete test coverage for subtle selection logic.

### 2) Window-mode denominator correctness (Solutions A & B)
We must eliminate the window-mode denominator mismatch where an anchor-style denominator query behaves like “A→X completions in-window” rather than “arrivals at X in-window”.

### 3) Conditional probabilities end-to-end (Solutions C, D, E)
- Planner coverage and retrieve-all must include `conditional_p` entries (Layer 3b defect).
- Cohort anchoring for conditional branches must be explicit/auditable (Layer 3a clarity).
- Python runner conditional matching must support full constraint DSL (Layer 4).

### 4) What‑If matching precedence (Solution F)
Standardise “most specific wins” semantics across What‑If application and runners (TS + Python).

---

## Architectural invariants (must hold after phases 1–6)

- **Single code path**: planner “needs fetch” and execution “get from file / aggregate / cache cut” must use the same selection semantics (no drift).
- **No logic in UI**: all changes land in services, lib, and Python runner only.
- **Override flags respected**: regenerated fields must not overwrite user overrides.
- **No cross-generation mixing**: aggregation must not mix slice-sets from different provenance “generations” unless explicitly designed and tested.
- **Runner semantics discipline**: runner analytics must not implicitly apply `conditional_p` unless explicitly activated (current Layer 1 decision remains).

---

## Phase 1 — Cache selection hardening + test coverage (Solution G hardening)

### Goal
Make implicit-uncontexted cache fulfilment deterministic, auditable, and safe under realistic parameter files that contain:
- multiple explicit uncontexted slices (duplicates),
- multiple MECE slice-sets for the same key (duplicates / multiple retrieval runs),
- and mixed query signatures.

### Primary code touchpoints
- `graph-editor/src/services/dataOperationsService.ts` (get-from-file selection + aggregation)
- `graph-editor/src/services/windowAggregationService.ts` (coverage / incremental fetch calculations)
- `graph-editor/src/services/meceSliceService.ts` (MECE candidate discovery utilities)
- `graph-editor/src/services/sliceIsolation.ts` (dimension extraction and mode-family isolation)

### Implementation work
- **Centralise the selection algorithm** in a shared service helper (consumed by both `dataOperationsService` and `windowAggregationService`) so planner and execution cannot diverge.
- **Explicit-uncontexted candidate selection**:
  - When multiple explicit uncontexted candidates exist, pick the most recent based on `data_source.retrieved_at` (with the existing fallback logic when absent).
  - Treat the chosen explicit slice as a single dataset (do not merge across multiple explicit slices unless explicitly designed and tested).
- **MECE candidate “generation” selection**:
  - Define “MECE generation” keys to prevent cross-generation mixing. At minimum include:
    - mode family (window vs cohort),
    - MECE key (e.g. `channel`),
    - and `query_signature` when present.
  - Select the most recent **complete** generation (recency defined as the minimum retrieved-at across its members).
  - If no complete generation exists, treat MECE substitution as unavailable (fail safely rather than synthesising a total).
- **Winner decision**:
  - Compare dataset recency between the best explicit-uncontexted candidate and the best MECE generation candidate.
  - Tie-breaking must be deterministic and documented (current behaviour prefers MECE on equal recency; we will keep that unless tests/UX demand otherwise).
- **Diagnostics**:
  - Add structured diagnostics to session logging for every implicit-uncontexted fulfilment decision: which candidate won, recency values, candidate counts, chosen MECE key, chosen generation signature.
  - Ensure logs are sufficient to diagnose “why did it pick that?” without reading code.

### Tests to add (must be comprehensive)
Add focussed tests that cover all subtle selection cases. Prefer placing them under `graph-editor/src/services/__tests__/`.

Minimum required scenarios:
- **Explicit newer than MECE**: explicit must win.
- **MECE newer than explicit**: MECE must win.
- **Multiple MECE generations**:
  - two complete generations: newest complete generation must win,
  - one newer but incomplete generation vs older complete: older complete must win,
  - ensure no mixing of slices across generations.
- **Multiple explicit uncontexted candidates**: newest explicit wins and is the only explicit candidate used.
- **Planner/execution parity**: for the same parameter file state and DSL, the planner’s coverage determination and execution’s aggregation must pick the same slice-set winner.

### Existing harness to leverage
- `graph-editor/src/services/__tests__/multiSliceCache.e2e.test.ts` provides a production-code E2E harness (fake IndexedDB + mocked HTTP). We may extend it for additional cases, but prefer new small tests unless it becomes unwieldy.

---

## Phase 2 — `n_query` normal form and window denominator semantics (Solutions A & B)

### Goal
Unify denominator semantics so that:
- `n_query` stored form is **anchor-free** (`to(X)`) by default (generated by MSMDC),
- cohort-mode execution can anchor that denominator using the cohort anchor **when available**,
- and window-mode execution treats the denominator as **arrivals at X in-window**, never “A→X in-window”.

### Phase 2.1 — MSMDC emits `to(X)` `n_query` (Solution A implementation detail)

#### Primary code touchpoints
- `graph-editor/lib/msmdc.py` (generation)
- `graph-editor/src/services/queryRegenerationService.ts` (application to graph + parameter files, respecting overrides)
- `graph-editor/src/services/__tests__/queryRegenerationService.nQuery.test.ts` (extend with new normal form scenarios)

#### Implementation work
- Update MSMDC’s n_query generation rule for MECE split mechanics so that it emits:
  - **`to(X)`** where X is the from-node arrival target for the edge.
- Continue emitting `n_query` only when MECE split mechanics are detected (exclude/minus/plus), consistent with existing design intent.
- Preserve existing override behaviour:
  - `n_query_overridden` gates application, not generation.
- Ensure regeneration continues to support legacy existing `from(A).to(X)` values without rewriting them unless regeneration happens and overrides allow it.

#### Tests to add / extend
- Add coverage that validates:
  - new regenerated `n_query` is `to(X)` when MECE split mechanics are present,
  - override flags still prevent application,
  - existing legacy `from(A).to(X)` remains acceptable and does not break downstream logic.

### Phase 2.2 — Window-mode denominator uses single-event counts (Solution B)

#### Pre-implementation research gate (required)
Before changing DAS, we must confirm the correct Amplitude HTTP syntax and response shape for “single event count within a window”.

We will reuse the existing local-only live Amplitude E2E pattern from:
- `graph-editor/src/services/__tests__/cohortAxy.meceSum.vsAmplitude.local.e2e.test.ts`

Key aspects of that harness that we will follow:
- Local-only gating using repo-root `.env.amplitude.local` and opt-in env var `DAGNET_RUN_REAL_AMPLITUDE_E2E=1`.
- Direct baseline requests constructed manually via `undici` (no DagNet query builder) to validate provider semantics.
- Use `graph-editor/public/defaults/connections.yaml` defaults (notably excluded cohorts) to mirror production adapter behaviour.
- Fixtures registered into `fileRegistry` from `param-registry/test/...` so production fetch pipeline can run without mocks.

Research tasks:
- Add a new local-only test (similar gating and structure) that:
  - constructs and executes a single-event query for a chosen event X within a window,
  - documents the endpoint used, required parameters, and the exact response fields needed to derive daily counts,
  - and confirms how excluded cohorts and segment filters must be represented for parity with DagNet’s existing Amplitude adapter.
- Capture findings in the implementation plan comments within the new test file, so future maintainers do not need to rediscover Amplitude semantics.

#### DAS implementation work (after research gate passes)

Primary code touchpoints (exact files may vary by adapter layout; resolve during implementation):
- `graph-editor/src/lib/das/` (DAS runner + adapter wiring)
- `graph-editor/src/services/dataOperationsService.ts` (dual-query / denominator logic)
- `graph-editor/src/lib/das/buildDslFromEdge.ts` (payload building or execution plumbing as needed)

Implementation tasks:
- Introduce a provider execution path for “single event daily counts” sufficient to compute denominator \(N(X)\) for window slices.
- Modify the `n_query` dual-query path so that:
  - When the active slice is window-mode and an `n_query` exists, denominator is computed from the single-event counts for X (derived from `to(X)` or from the `to(...)` portion of legacy `from(A).to(X)`).
  - The main funnel query continues to produce numerator (k) as today.
- Ensure cohort-mode behaviour remains anchor-aware:
  - For `to(X)` denominators, prepend the cohort anchor `from(A)` **iff** an anchor is defined for that cohort slice.
  - If no anchor is available, do not invent one; document and handle fallback behaviour deterministically.

#### “Real E2E” test of production code (required before deploy)
After implementing the DAS logic, we must add a true local-only E2E test that exercises production code end-to-end, using the same fixture style as the existing live Amplitude E2E:
- Extend the `param-registry/test` fixture set (contexts, events, parameters, graphs) so a representative graph includes an edge whose denominator will use the new single-event path.
- In the test:
  - run the production fetch pipeline for a window slice that triggers the new denominator logic,
  - perform a direct Amplitude baseline call (manual construction) for the single-event count of X over the same window and exclusions,
  - assert parity between the denominator used by DagNet and the baseline.

---

## Phase 3 — Fetch planning includes `conditional_p` (Solution E)

### Goal
Planner-driven workflows (coverage check, retrieve-all, staleness checks) must treat conditional probabilities as first-class fetch targets.

### Primary code touchpoints
- `graph-editor/src/services/fetchDataService.ts` (`getItemsNeedingFetch` must include conditional items)
- `graph-editor/src/services/windowFetchPlannerService.ts` (consumes `getItemsNeedingFetch`)
- `graph-editor/src/services/dataOperationsService.ts` (execution already accepts `conditionalIndex`; ensure parity with planning)

### Implementation work
- Extend fetch item enumeration so each edge’s conditional branch probability is represented as a fetch item.
- Define and enforce connection fallback rules for conditional branches:
  - use conditional branch connection if present,
  - otherwise fall back to the base edge connection.
- Ensure slice matching uses the conditional branch query for conditional items.

### Tests to add
- Coverage test proving conditional fetch items are included when missing and excluded when covered.
- Retrieve-all flow test proving conditional items are fetched in the same run as base items.
- Ensure topological ordering and staleness behaviour do not regress when conditional items are added.

---

## Phase 4 — Per-conditional anchors for cohort clarity (Solution D)

### Goal
Make cohort anchoring for conditional branch retrieval explicit and auditable (no implicit inheritance from base edge state).

### Primary code touchpoints
- `graph-editor/lib/msmdc.py` (anchor computation for conditional branches)
- `graph-editor/src/services/queryRegenerationService.ts` (apply anchors to conditional branch latency config, respecting overrides)
- `graph-editor/src/lib/das/buildDslFromEdge.ts` (ensure conditional fetch uses conditional branch anchor when building cohort payloads)
- `graph-editor/src/services/dataOperationsService.ts` (ensure conditional fetch passes an edge-like object whose latency config corresponds to the conditional branch when `conditionalIndex` is used)

### Implementation work
- Extend MSMDC to compute and return anchors for conditional branch parameters (not only base edge).
- Apply anchor updates into the conditional branch’s latency config with override flags mirroring existing anchor override semantics.
- Ensure cohort-mode query payload construction for conditional branches draws anchor from the conditional branch latency config (or explicit cohort DSL anchor if present).

### Tests to add
- Query regeneration test that conditional anchors are computed and applied (and respect overrides).
- End-to-end fetch test that conditional branch cohort payload uses the conditional anchor (auditable via logged payload metadata in test harness).

---

## Phase 5 — Python runner conditional semantics parity (Solution C)

### Goal
When conditional activation is requested, Python runner conditional evaluation must match TS constraint semantics:
- `visited`, `exclude`, `visitedAny`, `context`, `case`
and must never silently ignore malformed/unsupported conditions.

### Primary code touchpoints
- `graph-editor/lib/runner/path_runner.py` (conditional evaluation)
- `graph-editor/lib/query_dsl.py` (parsing utilities; align with TS as appropriate)
- `graph-editor/lib/runner/analyzer.py` (surface warnings/errors in analysis outputs)

### Implementation work
- Implement full constraint parsing and evaluation in Python for conditional conditions.
- Add explicit surfacing for malformed/unsupported condition DSL:
  - must be visible to the user as a warning/error, not a silent non-match.
- Add semantic lint for conditional group alignment across sibling edges (surfaced in issues viewer category `semantic`):
  - detect missing conditional groups among siblings.

### Tests to add
- Python unit tests that validate matching semantics for each supported construct.
- Python unit tests that validate malformed/unsupported conditions produce explicit warnings/errors.
- Service-level tests (where appropriate) to ensure these warnings flow through analysis response surfaces.

---

## Phase 6 — What‑If precedence: “most specific wins” (Solution F)

### Goal
Standardise matching precedence for conditional groups across:
- What‑If application logic,
- TS runner logic,
- Python runner logic (when conditional activation is enabled).

### Primary code touchpoints
- `graph-editor/src/lib/whatIf.ts`
- `graph-editor/src/lib/runner.ts`
- `graph-editor/lib/runner/path_runner.py`
- `graph-editor/src/lib/queryDSL.ts` (condition normalisation utilities)

### Implementation work
- Define “specificity” deterministically (documented rule, consistent across languages).
- Apply the same precedence rule in all conditional matching sites.
- Ensure condition normalisation is applied consistently before comparing or grouping conditions.

### Tests to add
- TS tests where multiple conditions match and the more specific must win.
- Python tests mirroring the same scenarios.
- Integration test ensuring What‑If overrides select the correct conditional branch under overlap.

---

## Phase 7 — Open investigation only (no implementation yet)

**Potential defect:** exclude term(s) dropped in persisted evidence `full_query` (e.g. `exclude(a,b)` becoming `exclude(b)`).

This plan does **not** implement a fix yet. We will:
- keep this documented as an open issue,
- and schedule a separate investigation pass to determine whether it is:
  - a query construction/adapter bug, or
  - a cache/signature selection bug attaching stale provenance.

---

## Rollout strategy (local-first, then guarded changes)

- Implement phases in order (1 → 6) because later phases rely on earlier stability:
  - Phase 1 hardens and makes cache behaviour auditable.
  - Phase 2 fixes the major window-mode denominator inconsistency.
  - Phases 3–6 align conditional behaviour across planning, retrieval, and analysis.
- Use local-only E2E tests (opt-in) for any real Amplitude HTTP behaviour, following the established harness described above.
- Ensure every behavioural change is covered by new tests. If any existing tests require updates, present diffs for explicit approval before editing.


