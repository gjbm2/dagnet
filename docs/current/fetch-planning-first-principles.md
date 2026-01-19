## Fetch Planning (First Principles): Correctness, Invariants, and Test Strategy

Date: 19-Jan-26

### Purpose

This document defines a **robust and defensible** approach to fetch planning for DagNet’s core retrieval pipeline, from first principles:

- A **general-class planning logic** that produces a set of fetch instructions which (a) fills all missing data and (b) refreshes any data that is plausibly stale, for both `window()` and `cohort()` modes.
- A **single-codepath contract**: planning (analysis), dry-run (“would call”), and live execution must derive from the **same plan**.
- A **serious testing strategy** aligned with `docs/current/CORE_PIPELINES_TESTING_STRATEGY_FIRST_PRINCPLES.md`, with emphasis on end-state properties, failure-space modelling, and avoiding “replica logic”.

This is **design only**. It does not propose or include code.

### Non-goals

- Designing adapter behaviour or provider semantics.
- Changing the meaning of `window()` vs `cohort()`.
- Introducing user-facing toggles for refetch aggressiveness.

---

## Definitions (shared vocabulary)

### Query intent

“Query intent” means the combination of:

- The **mode**: `window()` vs `cohort()` (including cohort anchor semantics).
- The **requested range** \(start, end\) in user DSL terms.
- The **slice family** and context semantics (e.g. `context(channel:paid-search)` vs implicit MECE aggregation).
- The **query spec** as understood by adapters (connection, event mappings, filters, excludes, visited, etc.), which is already represented by signature logic.

### Context semantics (contexted vs uncontexted)

DagNet supports both context-specific slices (e.g. `context(channel:paid-search)`) and uncontexted intent (e.g. `cohort(...)` with no explicit context). This section defines how they should interact in coverage and planning.

Key ideas:

- **Contexted slice**: a slice whose intent includes an explicit fixed value for one or more context keys.
- **Uncontexted query**: a query that does not specify those context keys.
- **Implicit MECE fulfilment**: when an uncontexted query can be satisfied by a *complete* partition set of contexted slices over a MECE key (e.g. all `channel` values), aggregated safely.

This is not a UI detail; it is a core retrieval contract because it affects:

- which cached data may be reused
- which gaps must be fetched
- whether “retrieve all” can converge without re-fetching irrelevant slices

### Coverage

Coverage is the set of dates in the requested range for which the parameter/case file contains daily data that is valid for the query intent.

Coverage is not a single boolean; it is a **state** over dates:

- Present
- Missing
- Present but stale candidate (present, but might be refresh-worthy given maturity rules)

### "Stale candidate"

A date is a stale candidate if re-fetching it could plausibly change its values due to maturity/latency behaviour (e.g. recent cohorts still accruing conversions), given:

- The effective maturity horizon (edge `t95`, or `path_t95` for cohort-mode where applicable)
- The `retrieved_at` metadata for the slice

Important: staleness is a **policy decision**, but it must never override missingness.

#### Staleness threshold (precise definition)

A date \(d\) is a **stale candidate** if and only if:

- The date is present (not missing), AND
- \((\text{now} - d) < \text{effective\_t95}\), where:
  - For **window mode**: `effective_t95 = edge.latency.t95` (edge-local latency)
  - For **cohort mode**: `effective_t95 = edge.latency.path_t95` if available, else `edge.latency.t95` (cumulative path latency preferred)

In other words: dates younger than the effective maturity horizon are stale candidates because the underlying data may still be accruing.

**Edge case**: if the slice has no `retrieved_at` metadata, all dates within the maturity horizon are stale candidates (conservative).

#### Conversion from current implementation

The current `shouldRefetch(...)` returns a decision type (`replace_slice`, `partial`, `use_cache`) plus an optional window — not a per-date set. The plan builder must convert this to a per-date stale set as follows:

- `use_cache` → \(S = \emptyset\) (no stale candidates)
- `partial` with `refetchWindow` → \(S = \{ d : d \in \text{refetchWindow} \}\)
- `replace_slice` for cohort → \(S = \{ d : d \in \text{requestedRange} \land (\text{now} - d) < \text{effective\_t95} \}\)

This conversion is a semantic change from "trailing window" to "date set" representation. The plan builder must implement this mapping explicitly.

### Fetch instruction

A fetch instruction is a plan step that includes:

- The item identity (parameter/case/node)
- Mode (window/cohort)
- The set of **date windows to fetch** (one or more ranges)
- The merge strategy implied by policy (e.g. window merge-by-date; cohort replace-slice semantics)
- The query intent/signature context used to interpret cache state

---

## First-principles invariants (what must always be true)

This section is the “core contract” for fetch planning.

### Invariant A — Missing data is never skipped

If a date is missing for the query intent, the planner must produce instructions that fetch it (unless the item is explicitly unfetchable, e.g. file-only with no external connection).

This applies regardless of:

- Whether the missing dates are at the start, middle, or end
- Whether the range is “older than maturity horizon”
- Whether the file is empty, partially filled, or contains mixed-mode data

### Invariant B — “Bounding” is only allowed as an optimisation on top of proven coverage

Any optimisation that reduces fetch scope must be based on provable facts about coverage. Specifically:

- You may avoid fetching dates that are already present and deemed stable.
- You may not avoid fetching dates just because they are “old”.

Stated differently: “maturity” can justify skipping refetch of already-present stable dates; it cannot justify skipping missing dates.

### Invariant C — Mode isolation is absolute

Cache/coverage must be computed in a way that prevents any reuse across incompatible modes:

- Window-mode data must never satisfy cohort-mode requirements and vice versa.
- Mode isolation must be enforced using both:
  - The requested DSL mode intent, and
  - The persisted value shape (window bounds fields vs cohort bounds fields) and any explicit mode markers

### Invariant C2 — Context semantics are explicit and conservative

Coverage reuse across contexted/uncontexted intent must follow a strict matrix:

- **Contexted query must never be satisfied by an uncontexted slice**. There is no opt-in mechanism for this; it is unconditionally disallowed.
- **Uncontexted query may be satisfied by a complete MECE partition set of contexted slices**, but only if we can prove completeness and compatibility:
  - Same mode (window vs cohort)
  - Same slice family dimensions *other than the MECE key*
  - **Same query signature across all context values in the partition** (no cross-signature MECE; signature isolation is unconditional)
  - Partition completeness for the MECE key is proven (not inferred from partial presence)

If completeness cannot be proven, or if signatures differ across partition members, the uncontexted query is **not covered** even if some contexted slices exist.

**Explicit rule for cross-signature MECE**: A MECE partition is only valid for coverage if *all* contributing context slices share the same `query_signature`. Mixed-signature partitions are treated as incomplete. There is no opt-in to relax this.

### Invariant C3 — `contextAny` is treated as a coverage constraint, not a hint

For intent that uses `contextAny(key)` (or equivalent “any of these contexts”) semantics:

- Coverage must be evaluated against the *exact semantic envelope* of the constraint.
- A partial subset of context values is not a valid cache fulfilment unless the intent explicitly allows partial results.

Practical rule: if the query intent implies “any channel”, but the cache only contains some channels, then the query is not covered.

### Invariant D — Signature isolation is absolute

If the query signature changes in a way that alters the adapter-level query spec, previously cached dates for a different signature must not satisfy coverage for the new intent.

### Invariant E — Single-plan contract (analysis == dry-run == execution)

For any request:

- The analysis view (“needs fetch”, “covered/stale”, “why”) must be derived from the **same plan** that execution will follow.
- Dry-run must produce a faithful preview of the live plan (differing only in the external HTTP boundary).

No second “planner-only” computation of fetch windows is permitted. (The planner may present the plan, but it must not invent it.)

### Invariant F — Minimality and non-overlap of fetch windows

Within a plan for a given item:

- Fetch windows must cover exactly the intended set of dates (missing + stale candidates if refresh is chosen).
- Windows must be merged into a minimal set of non-overlapping contiguous ranges (subject to any provider/request-shaping constraints).

### Invariant G — Convergence under partial failure

If a run partially fails (some gaps fetched, some not), a subsequent run must:

- Detect remaining gaps correctly
- Fetch only what remains missing/refresh-worthy
- Converge to full coverage (or a precise, explicit "unfetchable" classification)

This is an end-state property, not merely a per-step property.

#### Convergence termination criteria (operational definition)

Convergence is defined as follows:

- **Convergence to covered**: a plan for the same intent yields \(F = \emptyset\) (no missing, no stale candidates within the staleness window).
- **Convergence to unfetchable**: an item remains with \(M \neq \emptyset\), *and* that item is classified as "unfetchable" because:
  - The item has no external connection (file-only), or
  - The provider has returned a terminal error (4xx other than 429, or explicit "data unavailable" classification).

**Transient vs terminal classification**:

- **Terminal** (immediate unfetchable): 4xx errors other than 429 indicate the request is invalid or the data doesn't exist. No retry.
- **Transient** (remain as missing; retry on next run): 429 (rate limit) and 5xx (server error). The plan builder is stateless — it will schedule these dates again on the next run. The user decides when to stop retrying.

**No retry counters in planning**: The plan builder does not track execution history. Retry limits, if needed, belong in the execution/rate-limiter layer, not in planning semantics.

---

## The general-class planning logic (conceptual algorithm)

The goal: given arbitrary cache/file state, produce a robust set of fetch instructions that satisfies invariants A–G.

### Overview

Planning consists of three conceptual phases per item:

1) **Normalise intent**: determine mode, requested range, slice family, and query signature inputs.
2) **Compute per-date state** within the requested range: present / missing / stale-candidate.
3) **Compile fetch instructions**: choose whether to fetch missing only, or missing + stale candidates, and produce minimal contiguous windows.

The key is that phase (2) must be performed over the **full requested range**, not a pre-trimmed range.

### Phase 1: Normalise intent (per item)

For each fetchable item, determine:

- **Mode**: window vs cohort, derived from authoritative DSL plus any per-item overrides that are part of the supported model.
- **Requested range**: the user-specified range (after normalising open-ended ranges deterministically).
- **Slice family identity**: the dimensions used for slice matching (context keys, MECE semantics, etc.).
- **Signature inputs**: the same query signature inputs that execution uses when writing or selecting cache.

Output of this phase is a canonical “item intent descriptor”.

#### Context normalisation detail (required)

The intent descriptor must include a canonical “context requirement” component:

- **Context requirement type**:
  - explicit fixed context key/value constraints (`context(k:v)`), potentially multiple
  - uncontexted (no context constraints)
  - `contextAny` (set-valued or “any of these” constraints)
- **MECE key semantics** when uncontexted intent is eligible for MECE fulfilment:
  - which key(s) may be satisfied by MECE aggregation
  - the completeness definition and the provenance used to prove it

This prevents implicit behaviour from leaking into ad-hoc string checks.

### Phase 2: Compute per-date state (present/missing/stale candidate)

For each date in the requested range:

1) Determine if the date is **present** for the item intent:
   - The date exists in persisted daily arrays for a matching slice family and mode
   - The slice is compatible by signature rules (signature isolation invariant)
   - The value is not invalidated by mode isolation rules
   - The value is not invalidated by context semantics rules (context invariants)

2) If present, decide if it is a **stale candidate**:
   - Use maturity/latency policy to decide whether the value might have changed since retrieval
   - Stale candidacy is computed per date, but can be represented compactly as a trailing segment in many cases

3) If not present, mark it **missing**.

This phase yields two sets:

- Missing dates set \(M\)
- Stale-candidate dates set \(S\) (subset of present dates)

Important: missingness is computed without any horizon-based trimming. Maturity affects only stale candidacy.

#### Coverage under context semantics (how “present” is decided)

For each date, determine “present” by the following conservative rules:

- **Case A: Query is contexted (`context(k:v)` present in intent)**:
  - Present if there exists a cache value for that exact context (or an explicitly equivalent slice family representation), same mode, compatible signature.
  - Uncontexted cached values are not substitutes.

- **Case B: Query is uncontexted (no explicit context constraint)**:
  - Present if either:
    - an uncontexted cached value exists for the slice family and mode and signature, OR
    - a complete MECE partition set exists for the relevant MECE key(s), and the MECE aggregation rules are satisfied for that date (see below).

- **Case C: Query uses `contextAny(k)` or equivalent**:
  - Present only if we can prove the cache satisfies the semantics of “any of these contexts” for that date:
    - Either an uncontexted value is explicitly valid for this intent (rare), or
    - The MECE partition set is complete for that date (default expectation), or
    - The intent explicitly allows partial results (not assumed).

#### MECE completeness criteria (planning-time)

The planner must have a deterministic way to prove “complete partition set”, for example:

- A completeness proof derived from the authoritative workspace context definitions (contexts in FileRegistry/IndexedDB, as interpreted by `ContextRegistry`), not from “observed values in cache”.

Observed cache contents alone are insufficient to declare completeness (it causes false “covered” results under partial failures).

### Phase 3: Compile fetch instructions

Given \(M\) and \(S\), decide what to fetch:

- **Always fetch missing**: fetch set includes \(M\).
- **Always include stale candidates**: fetch set includes \(S\) by default.

This yields a required fetch set \(F = M \cup S\). Stable-present dates are excluded from \(F\).

The plan then builds a minimal set of contiguous windows covering the required date set \(F\).

#### Cohort "replace slice" semantics (precise meaning)

For cohort-mode with latency, "replace slice" must be interpreted as:

- **We still fetch only the minimum necessary**: only dates in \(F = M \cup S\) are fetched (do not refetch mature stable dates).
- **Merge rule**: for any fetched date, the newly retrieved data for that same date **overwrites** existing stored data for that date ("more recent/more complete wins per-date").

This is a merge/overwrite policy for *fetched dates*, not permission to truncate the requested range and not permission to refetch stable history.

#### Array-level merge mechanics (implementation detail)

Parameter files store daily data as parallel arrays: `dates[]`, `n_daily[]`, `k_daily[]` (and possibly `n_cumulative[]`, `k_cumulative[]`). "Overwrite per-date" requires array manipulation:

**Merge algorithm**:

1. Let `existing` = the current slice's arrays, `fetched` = the newly retrieved arrays.
2. Build a date-indexed map from `existing`: `{ date → { n, k, ... } }`.
3. For each date in `fetched.dates`, overwrite the map entry with the fetched values.
4. Rebuild the arrays from the map, sorted by date ascending.
5. Replace the slice's arrays with the rebuilt arrays.

**Edge cases**:

- **Fetched dates extend beyond existing range**: the map naturally handles this (new dates are added).
- **Fetched dates are a subset of existing**: only the fetched dates are overwritten; non-fetched dates are preserved.
- **Timezone alignment**: all dates must be normalised to the same timezone (UK dates internally) before merge.

This merge logic already exists in `dataOperationsService` for window mode; the cohort implementation must use the same array merge path with the "overwrite fetched dates" policy.

### Output form: FetchPlan

The plan output must be a stable, serialisable structure containing:

- Item list (stable ordering rules)
- For each item: a list of date windows to fetch (merged/non-overlapping), plus metadata:
  - why each window exists (missing vs refresh)
  - mode and merge strategy
  - signature/slice family identity used
  - any “unfetchable” classification details

This FetchPlan is the single source of truth for:

- Planner analysis rendering
- Dry-run reporting (request preview)
- Live execution

---

## The single-codepath architecture (how we enforce E)

### Required structure

We need one pure plan builder that is used by:

- WindowSelector analysis (planner)
- Retrieve-all / batch flows
- Execution path (fetch)
- Dry-run “would call” reporting

The plan builder must:

- Have no side effects (no external calls, no file writes, no graph mutation)
- Accept explicit inputs (graph snapshot, DSL, file state snapshot, reference “now”)
- Return a plan plus a structured explanation suitable for logs/UI

Execution and dry-run must then be a thin interpreter of the plan:

- Same plan, same windows, same payload construction
- Dry-run differs only at the external boundary (adapter option “dry run”)

### Forbidden structure

- Planner computes its own “bounded window” or “missing dates” in a way that execution doesn’t share.
- Execution adjusts the plan after analysis (other than dynamic backoff/rate limiting) without reflecting that change in reported plan.

---

## Testing strategy (aligned with CORE_PIPELINES_TESTING_STRATEGY_FIRST_PRINCPLES.md)

This section describes a “core contract” testing approach focused on correctness as end-state properties and realistic failure space.

### Guiding principle: test production logic, not replicas

We must not build alternate planners/cache checkers inside tests. Tests should drive the production plan builder and interpreter with controlled boundaries:

- External adapters mocked
- Time frozen
- File/IDB state set up using existing production-facing helpers (or faithful harness)

### What to test (contracts)

#### Contract 1 — Coverage correctness across all gap patterns

For both window and cohort mode, across any slice family:

- Gaps at start
- Gaps in middle (single hole)
- Multiple holes (islands)
- Gaps at end
- Mixed missing + stale candidates
- Mixed signatures in file (old vs new)
- Mixed mode values coexisting (window + cohort in same file)

Expected properties:

- Missing dates are always scheduled for fetch (Invariant A)
- Fetch windows cover exactly the required set and are minimal/non-overlapping (Invariant F)

#### Contract 2 — Staleness refresh is additive and never hides gaps

If refresh-worthy dates exist, they may be fetched in addition to missing dates, but missing dates are never dropped from the fetch set.

#### Contract 3 — Planner == execution == dry-run

Given identical inputs:

- Analysis must report exactly the same plan that execution would run.
- Dry-run must emit a preview of the same request windows that live execution would use.

This should be verified structurally by asserting plan equality (or a canonicalised plan representation).

#### Contract 4 — Convergence after partial failure

Simulate partial failures (rate limits, transient errors) that leave gaps:

- Run 1 partially succeeds (some windows fetched)
- Run 2 plans only remaining missing/refresh-worthy windows
- After sufficient reruns or error resolution, the system converges to covered state or explicit unfetchable classification

This is a key regression barrier for “retrieve all” behaviour (Invariant G).

#### Contract 5 — Mode isolation and signature isolation

Explicitly seed files with confusing states:

- Untyped sliceDSL but typed fields (bounds) that indicate mode
- Cohort values with window-shaped headers and vice versa
- Multiple signatures present; ensure only appropriate signature satisfies coverage

Expected: mode and signature isolation prevent false cache fulfilment (Invariants C and D).

#### Contract 6 — Contexted vs uncontexted interaction (MECE fulfilment and `contextAny`)

We must explicitly cover the interaction matrix, because it is a primary source of subtle regressions:

- **Uncontexted query satisfied by uncontexted slice**:
  - Full coverage, partial coverage (gaps), mixed signatures.

- **Uncontexted query satisfied by contexted slices via MECE**:
  - Complete MECE set present: covered
  - One context missing: not covered (even if “most” contexts are present)
  - Complete MECE set present but mixed signatures across contexts: not covered (unless explicitly allowed)
  - Complete MECE set present but mixed mode values: not covered
  - Partial failures in retrieve-all: rerun converges by fetching only missing contexts/dates

- **Contexted query**:
  - Must only use the exact matching contexted slice, never uncontexted or other contexts.

- **`contextAny` queries**:
  - Behave as “requires completeness of the relevant set” unless the intent explicitly encodes partial allowance.

These tests should assert both:

- the computed plan (missing/stale sets and fetch windows), and
- convergence behaviour under partial failure + rerun.

### How to structure the test suite (CCS + harness)

Aligned with the referenced strategy doc:

- Establish a “Core Contract Suite” subset for these invariants, treated as a safety gate.
- Build or reuse a shared harness that can:
  - Seed graphs and file states deterministically
  - Invoke the plan builder
  - Run execution in dry-run mode and live mode with mocked adapters
  - Capture structured artefacts (plan, executed windows, written file results)

### Failure injection and resumability

Tests must intentionally inject:

- Per-window failures (one gap fails)
- Per-item failures within a batch
- Provider-side failures (e.g. rate limit error classification)

The primary assertion is convergence and accurate remaining-gap planning, not “error count increments”.

### Golden / fixture tests for semantics (optional but recommended)

Add a small number of stable fixture graphs to assert:

- Evidence-only results are invariant to the presence of irrelevant forecast-only slices
- MECE aggregation respects completeness rules and signature constraints

This aligns probability semantics to retrieval semantics and prevents plausible-but-wrong regressions.

---

## Resolved policy decisions (authoritative)

### 1) Refresh policy scope

The plan **always includes stale segments** by default. There is no separate “refresh vs fetch” decision path in planning: the plan defines \(F = M \cup S\).

### 2) Cohort replace semantics

For cohort mode, we **only fetch the minimum necessary** (missing + stale candidate dates), and we **merge by date** such that:

- For any date we fetch, the new data for that date **overwrites** existing stored data for that date.
- We do **not** refetch stable/mature history.

### 3) Plan identity (why this exists and what it must be)

This is a testing/assurance requirement: to enforce “planner == dry-run == execution”, we need a deterministic representation of a FetchPlan so tests can assert equality.

Requirement:

- The plan must be serialisable to a canonical JSON form where ordering is deterministic:
  - items sorted by stable key (type/objectId/targetId/slot/index)
  - windows sorted and normalised (UK dates at plan level; ISO only at adapter boundary)
  - per-window reason tags (missing vs stale) included so the plan is explainable

### 4) MECE completeness source of truth (current codebase)

MECE completeness is defined by the **workspace context definitions** (context files) and interpreted through `ContextRegistry`:

- Context definitions are loaded from the workspace via FileRegistry/IndexedDB (`graph-editor/src/services/contextRegistry.ts`).
- Expected value membership (including handling of `otherPolicy`) is derived from the context definition’s `values` plus `otherPolicy` rules.
- Completeness/aggregatability is computed by `ContextRegistry.detectMECEPartition(...)` / `detectMECEPartitionSync(...)`, which returns:
  - `isComplete` (missingValues empty) and
  - `canAggregate` (policy permits treating the partition as a safe implicit total only when complete).

Therefore, planning/coverage logic must:

- Use `ContextRegistry`-based completeness proofs (not "observed cache implies completeness").
- Treat missing/unavailable context definitions as "not provably complete" (fail-safe) for core correctness.

#### Known divergence: `policy=unknown` fallback in `meceSliceService`

The current `meceSliceService.ts` contains a fallback:

```typescript
// If context definition is not loaded, assume the pinned slice set is intended to be MECE.
const meceCheck = raw.policy === 'unknown'
  ? { isMECE: true, isComplete: true, canAggregate: true, missingValues: [], policy: 'unknown' }
  : raw;
```

This is the **opposite** of fail-safe: it assumes completeness when we cannot prove it.

**Required action**: The plan builder must treat `policy=unknown` as "not provably complete" (same as missing context definition). This changes the existing fallback behaviour and may cause some currently-passing tests to fail. Those tests should be updated to either:

- Provide a context definition, or
- Expect "not covered" for the uncontexted query.

This is a correctness fix, not a regression.

### 5) Retrieve-all batching semantics

When a "retrieve all" operation is triggered (via pinned DSL explosion into multiple slices), how does the plan relate to the batch?

**Design decision**: Each slice in the explosion gets its own FetchPlanItem. The FetchPlan contains *all* items for the batch. This means:

- A single `FetchPlan` object covers the entire "retrieve all" operation.
- Items are independent: failure of one item does not affect planning for others.
- The plan is built once at the start of retrieve-all, then executed item-by-item.
- Convergence is evaluated per-item within the batch.

**Implication for pinned DSL explosion**: The plan builder receives the full exploded slice list and produces a combined plan. The UI can render per-item status from this single plan.


---

## Implementation plan (extraordinarily thorough; prose-only)

This plan describes how to replace the current fetch planning machinery with a **single, general-class FetchPlan builder** that:

- Produces a minimal set of fetch windows covering \(F = M \cup S\) (missing ∪ stale) for *any* coverage pattern.
- Preserves current behaviour where it is already correct, and fixes the classes of failures that motivated this redesign.
- Uses a **single codepath** for planner analysis, dry-run reporting, and live execution.
- Accommodates the existing test estate, while adding strategically comprehensive coverage aligned with `docs/current/CORE_PIPELINES_TESTING_STRATEGY_FIRST_PRINCPLES.md`.

### 0) Current implementation acknowledgement (what exists today)

The current pipeline is distributed across several layers:

- **Planner / UI analysis**
  - `graph-editor/src/services/windowFetchPlannerService.ts` performs analysis.
  - It delegates “needs fetch” coverage to `fetchDataService.getItemsNeedingFetch(...)`.
  - It adds staleness semantics via `shouldRefetch(...)`.
  - It computes a cohort “bounded window” (currently via `computeCohortRetrievalHorizon(...)`) for cohort-mode latency edges.

- **Execution**
  - `graph-editor/src/services/fetchDataService.ts` orchestrates multi-item fetch and calls `dataOperationsService`.
  - `graph-editor/src/services/dataOperationsService.ts` implements the operational truth:
    - Constructs adapter payloads, computes signatures, applies refetch policy, performs cache cutting via `calculateIncrementalFetch(...)`, and executes one request per planned gap.
    - In dry-run mode (`dontExecuteHttp`) it currently builds request previews without performing network I/O.

- **Coverage primitives and semantics**
  - `graph-editor/src/services/windowAggregationService.ts` contains `calculateIncrementalFetch(...)` and coverage logic.
  - `graph-editor/src/services/sliceIsolation.ts` and `meceSliceService.ts` implement slice-family matching and implicit-uncontexted MECE selection.
  - `graph-editor/src/services/contextRegistry.ts` is the source-of-truth interpreter for context definitions and MECE completeness (`detectMECEPartition*`).
  - `graph-editor/src/services/querySignatureService.ts` and `dataOperationsService.computeQuerySignature(...)` represent signature logic (today there are two parallel mechanisms; the new planning must not invent a third).

Known structural issue motivating this redesign:

- The planning decisions are partially duplicated and partially inconsistent across planner vs execution, especially for cohort-mode “horizon bounding” and the relationship between “maturity” and “missingness”.

### 1) Target architecture (new “FetchPlan machinery”)

#### 1.1 Introduce a pure FetchPlan builder service

Add a new service module under `graph-editor/src/services/` (name TBD, e.g. “fetchPlanService” or “fetchPlanBuilderService”) with one main entry point:

- Inputs (all explicit; no hidden global time):
  - Graph snapshot
  - Authoritative DSL (and per-item overrides if part of the supported model)
  - File/cache snapshot accessors (read-only)
  - Reference “now” (provided by caller; tests freeze it)
  - Options for:
    - mode (versioned/direct/from-file)
    - dry-run flag (affects only execution boundary; plan must be identical)
    - whether file-only items are included and how they are reported

- Outputs:
  - A serialisable FetchPlan (canonical form; see “Plan identity” requirement)
  - An explanation artefact suitable for session logging and UI rendering

The builder is responsible for:

- Computing item intent (mode, slice family, signature context, context semantics)
- Computing per-date missingness and stale candidacy under all invariants (including context/MECE rules)
- Producing minimal contiguous fetch windows for \(F = M \cup S\)
- Attaching merge semantics metadata (window merge-by-date; cohort replace-by-date overwrite for fetched dates)

#### 1.2 Make planner, dry-run, and execution consume the same FetchPlan

- `windowFetchPlannerService.analyse(...)` becomes:
  - “build plan” + “render summary of plan”
  - It must not compute any additional windows beyond what is in the plan.

- `windowFetchPlannerService.executeFetchPlan(...)` becomes:
  - “build plan” (fresh) + “execute plan”
  - It must not re-derive windows separately.

- `dataOperationsService.getFromSourceDirect(...)` becomes:
  - A plan interpreter, not a plan author.
  - It may still handle request construction and persistence, but the set of windows and their rationale come from the plan.

- Dry-run (`dontExecuteHttp`) becomes:
  - “execute plan with external boundary disabled”
  - It emits request previews corresponding exactly to the plan windows.

This directly enforces Invariant E.

### 2) Step-by-step implementation phases (delta-aware)

This is intentionally phased to minimise blast radius and to keep the system shippable at each step.

#### Phase 0 — Catalogue and pin current behaviour (before refactor)

Goal: avoid “unknown unknowns” while changing core logic.

- Identify the exact set of places where planning occurs today:
  - `windowFetchPlannerService.ts` (analysis)
  - `fetchDataService.getItemsNeedingFetch(...)` (coverage gating)
  - `dataOperationsService.getFromSourceDirect(...)` (actual window selection + gap chaining)
  - `windowAggregationService.calculateIncrementalFetch(...)` (gap detection)
  - `meceSliceService` and `contextRegistry` (MECE and completeness)
  - signature-related logic (`querySignatureService` and `dataOperationsService.computeQuerySignature`)

- Record the existing test suites that cover pieces of this pipeline (non-exhaustive but high-signal):
  - `graph-editor/src/services/__tests__/fetchPolicyIntegration.test.ts`
  - `graph-editor/src/services/__tests__/fetchRefetchPolicy*.test.ts`
  - `graph-editor/src/services/__tests__/windowFetchPlannerService.test.ts`
  - `graph-editor/src/services/__tests__/dataOperationsService.openEndedWindowResolution.test.ts`
  - `graph-editor/src/services/__tests__/multiSliceCache.e2e.test.ts`
  - `graph-editor/src/services/__tests__/pinnedDsl.orContextKeys.cacheFulfilment.test.ts`
  - `graph-editor/src/services/__tests__/implicitUncontextedSelection.hardening.test.ts`
  - `graph-editor/src/services/__tests__/meceSliceService.preferMECEOverExplicit.test.ts`
  - `graph-editor/src/services/__tests__/contextRegistry*.test.ts`
  - Any retrieve-all tests (e.g. `retrieveAllSlicesService` suites) that assert run semantics

Deliverable: a short checklist inside this doc (or referenced note) that names the above as the baseline.

#### Phase 1 — Define the canonical FetchPlan shape and canonicalisation

Goal: make plan identity testable and enforceable.

**Concrete FetchPlan schema** (TypeScript shape):

```
interface FetchPlan {
  version: 1;
  createdAt: string;           // ISO timestamp (frozen in tests)
  referenceNow: string;        // ISO timestamp used for staleness (frozen in tests)
  dsl: string;                 // The authoritative DSL this plan was built for
  items: FetchPlanItem[];      // Sorted by itemKey (see below)
}

interface FetchPlanItem {
  itemKey: string;             // Canonical: `${type}:${objectId}:${targetId}:${slot ?? ''}:${conditionalIndex ?? ''}`
  type: 'parameter' | 'case';
  objectId: string;
  targetId: string;
  slot?: 'p' | 'cost_gbp' | 'labour_cost';
  conditionalIndex?: number;
  
  mode: 'window' | 'cohort';
  sliceFamily: string;         // Canonical slice dimensions (e.g. 'context(channel:paid-search)')
  querySignature: string;      // Signature used for cache matching
  
  classification: 'fetch' | 'covered' | 'unfetchable';
  unfetchableReason?: string;  // If classification is 'unfetchable'
  
  windows: FetchWindow[];      // Sorted by start date ascending; empty if covered/unfetchable
}

interface FetchWindow {
  start: string;               // UK date format (e.g. '1-Nov-25')
  end: string;                 // UK date format
  reason: 'missing' | 'stale'; // Why this window is in the plan
  dayCount: number;            // Convenience: number of days in the window
}
```

**Ordering rules**:

- `items` sorted lexicographically by `itemKey`
- `windows` sorted by `start` date ascending (UK date parse order)

**Equality definition**: two plans are equal if their canonical JSON serialisations (with sorted keys) are byte-identical. Tests should use a `plansEqual(a, b)` helper that applies canonicalisation before comparison.

This phase is "paperwork" but is critical to avoid regression tests that are non-deterministic.

#### Phase 2 — Implement the pure plan builder (read-only)

Goal: build the new plan without changing execution yet.

**Complexity acknowledgement**: This phase consolidates logic currently scattered across multiple files. The following existing code paths must be understood and unified (not reimplemented from scratch):

| Concern | Current location | Notes |
|---------|------------------|-------|
| DSL parsing / range extraction | `lib/queryDSL.ts`, `windowAggregationService.ts` | Multiple entry points exist |
| Context constraint extraction | `sliceIsolation.ts` (`extractSliceDimensions`, `expandContextAny`) | |
| Mode detection from DSL | `windowAggregationService.ts` (`isCohortModeValue`) | |
| Mode detection from persisted value shape | `windowAggregationService.ts` (bounds field inspection) | |
| Signature computation | `dataOperationsService.ts` (`computeQuerySignature`) | |
| MECE completeness | `contextRegistry.ts` (`detectMECEPartition*`) | |
| Refetch policy | `fetchRefetchPolicy.ts` (`shouldRefetch`) | Returns decision type, not date set |
| Gap detection | `windowAggregationService.ts` (`calculateIncrementalFetch`) | Returns windows, not date set |

The plan builder must:

- **Reuse** these existing functions where possible (avoid reimplementing signature logic, MECE detection, etc.)
- **Wrap** them to produce the canonical FetchPlan shape
- **Convert** `shouldRefetch` output to a per-date stale set (see "Conversion from current implementation" above)
- **Convert** `calculateIncrementalFetch` output to a per-date missing set, then merge with stale set

**Implementation substeps**:

1. Implement intent normalisation:
   - DSL window/cohort extraction (including open-ended ranges; tests freeze "now")
   - Context semantics normalisation:
     - contexted vs uncontexted vs contextAny
     - MECE eligibility and completeness via `ContextRegistry`
   - Mode isolation using persisted value shape (not only `sliceDSL` strings)
   - Signature isolation using the existing signature mechanisms (do not introduce new signature semantics)

2. Implement per-date state computation:
   - Compute \(M\) missing dates for the requested range (after mode/context/signature filters)
   - Compute \(S\) stale-candidate dates:
     - Window mode: stale dates correspond to immaturity horizon logic (existing `shouldRefetch` encodes parts of this; the plan builder must apply the policy per-date and produce a stale date set, not just a window).
     - Cohort mode: stale dates are derived from cohort maturity and retrieval timestamp semantics, using effective maturity \(path_t95 preferred, otherwise edge t95\). The output is a date set, not a pre-bounded range.
   - Produce \(F = M \cup S\)

3. Compile minimal contiguous windows:
   - Convert \(F\) into minimal non-overlapping date ranges.
   - Preserve invariants under multiple islands, single-day holes, etc.

Crucially, this phase produces a plan but does not yet drive execution.

#### Phase 3 — Wire planner analysis to the plan builder (analysis output may change)

Goal: align analysis output with the new plan without changing the fetch engine yet.

**Honesty about visible changes**: The analysis output *will* change in user-visible ways because:

- Stale candidates are now always included (previously, horizon bounding could hide them)
- Missing dates that were previously "bounded away" will now appear in the "needs fetch" list
- Item counts and summaries will reflect the correct plan, not the old bounded plan

These are **intended changes** — the old output was wrong. Tests that asserted the old output must be updated to assert the new (correct) output.

- Change `windowFetchPlannerService.analyse(...)` to:
  - Build plan using the new plan builder
  - Render "needs fetch" and "stale candidates" based on the plan contents rather than local computations
  - Update user-facing summaries to reflect plan-derived counts

- Update tests in `windowFetchPlannerService.test.ts` to expect the new analysis output (this is a functional change, not a test weakening).

#### Phase 4 — Wire dry-run reporting to the plan builder (single plan preview)

Goal: dry-run becomes a faithful preview of plan execution.

- Ensure `dontExecuteHttp` uses the plan windows and reasons, and that request previews are emitted per plan window.
- Ensure composite/dual-query special cases are still represented in the plan explanation layer (the plan may include “sub-requests” metadata or explicitly declare “composite expansion not previewed” where current behaviour has that limitation).

This phase explicitly satisfies Invariant E for the dry-run boundary.

#### Phase 5 — Wire live execution to the plan builder (behavioural change point)

Goal: execution becomes an interpreter of the plan.

**Scope acknowledgement**: This is the largest phase. `dataOperationsService.ts` is ~9000 lines and deeply integrated with:

- Rate limiting (`rateLimiter`)
- Error handling and retry logic
- Adapter-specific request construction (`buildDslFromEdge`, `createDASRunner`)
- File persistence (`putToFile`, array merge logic)
- Session logging

The changes required are:

1. **Plan consumption entry point**:
   - Add a new internal method `executeFromPlan(plan: FetchPlan, options)` that:
     - Iterates over `plan.items` where `classification === 'fetch'`
     - For each item, iterates over `item.windows`
     - Calls the existing adapter execution logic for each window
   - The existing `getFromSourceDirect(...)` becomes a thin wrapper: build plan → execute plan.

2. **Remove inline window derivation**:
   - The current code computes `actualFetchWindows` inline using `calculateIncrementalFetch`, `shouldRefetch`, and `computeCohortRetrievalHorizon`.
   - This logic must be **removed** from execution and replaced with plan consumption.
   - The plan builder (Phase 2) now owns window derivation.

3. **Merge semantics enforcement**:
   - Window mode: merge-by-date remains; the set of dates is now plan-driven.
   - Cohort mode: apply array-level merge (see "Array-level merge mechanics" above) for fetched dates only.
   - Verify that the existing merge logic in `putToFile` / `mergeParameterValues` supports per-date overwrite.

4. **Error handling integration**:
   - If a window fails (transient error), record the failure but continue with remaining windows.
   - The next plan build will see the unfetched dates as missing and schedule them again.
   - If a window fails with a terminal error, mark it as `unfetchable` in the result (but this does not affect the plan itself — plans are immutable once built).

5. **Composite/dual-query handling**:
   - Some edges require two queries (e.g. window + cohort for different purposes).
   - The plan must represent these as separate windows (or sub-items) so execution can process them independently.
   - This is currently handled with `compositeResult` / dual-query logic in `getFromSourceDirect`; the plan must capture the same structure.

6. **Session logging alignment**:
   - Log plan contents at the start of execution.
   - Log per-window success/failure as children of the execution operation.
   - Ensure dry-run and live execution produce comparable log structures.

This is the core behavioural change point. It must be gated by the contract tests below.

#### Phase 6 — Remove duplicate legacy planning paths

Goal: no duplicate decision paths exist.

**Specific deletions/deprecations**:

| Location | Function/Code | Action |
|----------|---------------|--------|
| `dataOperationsService.ts` | Inline `calculateIncrementalFetch` calls for window derivation | Remove; plan builder owns this |
| `dataOperationsService.ts` | Inline `shouldRefetch` calls for stale window selection | Remove; plan builder owns this |
| `dataOperationsService.ts` | `computeCohortRetrievalHorizon` usage (if any remains) | Remove; plan builder handles maturity without start-bounding |
| `windowFetchPlannerService.ts` | `computeBoundedCohortWindow` method | Remove; plan builder produces unbounded windows |
| `cohortRetrievalHorizon.ts` | Entire module (if only used for start-bounding) | Deprecate or delete; audit call sites first |
| `fetchDataService.ts` | Any inline gap/window computation | Verify it delegates to plan builder; remove if duplicate |

**Retention**:

| Location | Function/Code | Reason to keep |
|----------|---------------|----------------|
| `windowAggregationService.ts` | `calculateIncrementalFetch` | Plan builder reuses this as a primitive |
| `fetchRefetchPolicy.ts` | `shouldRefetch` | Plan builder reuses this as a primitive |
| `contextRegistry.ts` | `detectMECEPartition*` | Plan builder reuses this as a primitive |

**Verification**: After Phase 6, grep for direct calls to `calculateIncrementalFetch`, `shouldRefetch`, and `computeCohortRetrievalHorizon` outside the plan builder. There should be zero (except tests that explicitly test these primitives in isolation).

### 3) Test strategy: accommodate existing tests + strategic delta coverage

This section is a delta plan: what stays, what moves, what is added.

#### 3.1 Existing tests: honest framing about expected changes

**Reality**: Some existing tests assert the *old* bounded-window behaviour, which is now considered incorrect. Changing these tests to assert the new behaviour is a **functional change**, not a "test strengthening".

We must be honest about this:

- Tests that assert "bounded to X–Y" where the new logic produces "full range X–Z" must be updated to expect "X–Z".
- This is changing the expected output, not improving coverage.
- It is still *correct* to make this change because the new expected output is the *correct* output.

**Framing for review**: When updating these tests, explicitly annotate each change:

```typescript
// CHANGED: Old assertion expected bounded window due to horizon logic.
// New assertion expects full range because missing dates are never skipped (Invariant A).
expect(plan.windows).toEqual([{ start: '1-Nov-25', end: '30-Nov-25' }]);
```

**What "do not weaken" actually means**: We must not remove assertions, loosen tolerances, or delete test scenarios. We *may* change expected values when the new expected value reflects the correct (first-principles) behaviour.

#### 3.2 Where to place new tests (minimise new files)

Default approach: extend existing suites:

- Add plan equality assertions to:
  - `windowFetchPlannerService.test.ts` (analysis plan equals execution plan for same inputs)
  - `fetchPolicyIntegration.test.ts` (plan windows correspond to interpreter execution windows)
  - `dataOperationsService.openEndedWindowResolution.test.ts` (plan respects open-ended semantics deterministically)

Add the context/MECE interaction matrix primarily to:

- `pinnedDsl.orContextKeys.cacheFulfilment.test.ts`
- `multiSliceCache.e2e.test.ts`
- `implicitUncontextedSelection.hardening.test.ts`
- `contextMECEEquivalence.*` tests, where appropriate

Only introduce a new test file if there is no sensible existing home for a new cross-cutting invariant (and document why).

#### 3.3 Strategic new coverage (contract-focused, not “more tests”)

Add a small number of high-signal contract scenarios that systematically explore the state space:

- Coverage patterns for \(M\) (missing) and \(S\) (stale) across:
  - start / middle / end gaps
  - multiple islands
  - mixed signature generations
  - mixed mode values in one file
  - uncontexted satisfied by explicit uncontexted vs by MECE partition, including incomplete partitions

For each scenario, assert:

- The plan’s \(F\) set is correct (missing ∪ stale, stable excluded)
- The produced windows are minimal/non-overlapping
- The plan is identical between planner analysis and execution for identical inputs

#### 3.4 Convergence and resumability tests

Introduce explicit "partial failure then rerun" scenarios.

**Test mechanics (how to implement)**:

1. **Mocking partial failures**:
   - Mock the adapter to fail for specific date ranges (e.g. `if (window.start === '15-Nov-25') throw new Error('simulated 429')`)
   - Use a stateful mock that fails on first call, succeeds on retry (for transient error testing)

2. **Simulating persistence between runs**:
   - Use an in-memory file store (e.g. a `Map<fileId, fileContents>`) that persists across test runs
   - After each "run", the successful windows are merged into the in-memory store
   - On the next "run", the plan builder reads from this store and sees the partial coverage

3. **Multi-run test structure**:

```typescript
it('converges after partial failure + rerun', async () => {
  const fileStore = new Map(); // In-memory file store
  const adapter = createFailingAdapterMock(['15-Nov-25:20-Nov-25']); // Fails this window
  
  // Run 1: partial success
  const plan1 = buildPlan({ ... }, fileStore);
  const result1 = await executePlan(plan1, adapter, fileStore);
  expect(result1.failedWindows).toHaveLength(1);
  expect(result1.succeededWindows).toHaveLength(/* N-1 */);
  
  // Run 2: retry failed windows
  adapter.clearFailures(); // Now succeeds
  const plan2 = buildPlan({ ... }, fileStore); // Sees partial coverage
  expect(plan2.items[0].windows).toEqual([{ start: '15-Nov-25', end: '20-Nov-25', reason: 'missing' }]);
  const result2 = await executePlan(plan2, adapter, fileStore);
  expect(result2.failedWindows).toHaveLength(0);
  
  // Run 3: converged
  const plan3 = buildPlan({ ... }, fileStore);
  expect(plan3.items[0].classification).toBe('covered');
});
```

4. **Where to place these tests**:
   - Extend `fetchPolicyIntegration.test.ts` or `retrieveAllSlicesService.test.ts` (whichever has existing multi-run semantics)
   - If neither is suitable, create `fetchPlanConvergence.contract.test.ts` (new file justified by cross-cutting nature)

This is essential to make "retrieve all" semantically complete, not merely "no throws".

#### 3.5 Fixture construction strategy (shared helpers)

Creating test fixtures for complex scenarios (MECE partitions, mixed signatures, mixed modes) is fiddly. We should provide shared helpers to avoid each test reimplementing fixture construction.

**Proposed fixture factory helpers** (add to `graph-editor/src/services/__tests__/helpers/testFixtures.ts` or create new helper file):

```typescript
// Create a parameter file with specified coverage
function createParameterFile(options: {
  fileId: string;
  mode: 'window' | 'cohort';
  coveredDates: string[];           // e.g. ['1-Nov-25', '2-Nov-25', ...]
  sliceDSL?: string;                // e.g. 'context(channel:paid-search)'
  querySignature?: string;
  retrievedAt?: string;
}): ParameterFileData;

// Create a MECE partition set
function createMECEPartition(options: {
  contextKey: string;               // e.g. 'channel'
  contextValues: string[];          // e.g. ['paid-search', 'organic', 'other']
  mode: 'window' | 'cohort';
  coveredDates: string[];
  querySignature?: string;          // Same for all, or per-value if testing mixed
  signaturePerValue?: Record<string, string>; // For mixed-signature tests
}): ParameterValue[];

// Create a context definition for MECE completeness testing
function createContextDefinition(options: {
  id: string;
  values: string[];
  otherPolicy: 'null' | 'computed' | 'explicit' | 'undefined';
}): ContextDefinition;
```

**Usage in tests**:

```typescript
it('uncontexted query not satisfied by incomplete MECE partition', () => {
  const contextDef = createContextDefinition({
    id: 'channel',
    values: ['paid-search', 'organic', 'other'],
    otherPolicy: 'computed',
  });
  const partition = createMECEPartition({
    contextKey: 'channel',
    contextValues: ['paid-search', 'organic'], // Missing 'other'
    mode: 'cohort',
    coveredDates: ['1-Nov-25', '2-Nov-25'],
  });
  
  // Plan builder should report 'not covered' because MECE is incomplete
  const plan = buildPlan({ ... });
  expect(plan.items[0].classification).toBe('fetch');
});
```

**Why this matters**: Without shared fixtures, each test will construct its own bespoke data structures, leading to inconsistency and making it hard to verify that scenarios are correctly specified.

### 4) Risk controls and rollout

To keep this defensible:

- Freeze time in all relevant tests (no ambient `Date.now()`).
- Ensure the plan builder is pure and deterministic.
- Wire analysis first, then dry-run, then execution (behaviour change last).
- Use session logging to surface plan contents and mismatches early during rollout.

### 5) Acceptance criteria (what “done” means)

The redesign is complete only when:

- Planner analysis, dry-run, and execution all consume the same plan (Invariant E).
- Missing is never skipped; stale is always included (policy decision) (Invariants A and resolved policy).
- Context/MECE completeness is proven via `ContextRegistry`, not inferred from observed cache (context invariants).
- The system converges under partial failure + rerun (Invariant G).
- The strategically comprehensive contract tests pass and serve as a safety gate for future changes.

