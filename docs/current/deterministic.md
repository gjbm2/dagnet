# Deterministic latency horizons (`t95` / `path_t95`)

**Last updated:** 15-Jan-26

This note proposes policy changes intended to make `t95` and `path_t95` deterministic (repeatable given identical inputs), while preserving the core requirement that lag behaviour adapts over time as query periods change.

This is **not** an implementation plan. It is a policy/options analysis with specific recommendations and explicit trade-offs.

---

## 0) Definitions and scope

### 0.1 Determinism contract (what must not vary)

For a given:

- graph topology + authored overrides,
- the effective query DSL (including resolved relative dates),
- the effective slice set used as inputs (window/cohort slices, including MECE implicit uncontexted resolution),
- and forecasting settings,

the following should be identical across “normal” vs “live share” and across different sequencing:

- `edge.p.latency.t95`
- `edge.p.latency.path_t95`
- and any values that are mechanically coupled to those horizons (notably completeness and blended `edge.p.mean` in the Stage‑2 pass).

### 0.2 “Adaptive” contract (what must still vary)

We still want horizons to change when:

- the query’s time period changes (explicit date changes or resolved relative DSL like `-60d:`),
- the underlying cached slices change (new days/cohorts retrieved or different contexts/cases),
- forecasting settings change (repo `settings/settings.yaml` and any runtime settings service overrides).

In other words: horizons should be sensitive to **data and intent**, not to **wall-clock and boot sequence**.

---

## 1) Current behaviour and invariants (code + tests)

### 1.1 Where `t95` / `path_t95` are computed in runtime

The canonical path is Stage‑2 inside `graph-editor/src/services/fetchDataService.ts`:

- `fetchItems(...)` runs Stage‑1 per item.
- `runStage2EnhancementsAndInboundN(...)` runs:
  - `enhanceGraphLatencies(...)` (topo/LAG pass) → produces per-edge `t95`, `path_t95`, completeness, and `blendedMean`.
  - `UpdateManager.applyBatchLAGValues(...)` → applies latency + `p.mean` updates to the graph, rounding horizons.
  - `computeAndApplyInboundN(...)` (post pass).

Key current choice: Stage‑2 uses a real wall-clock reference date:

- `fetchDataService` sets `queryDateForLAG = new Date()` and passes it into `enhanceGraphLatencies(...)`.

### 1.2 Horizon rounding and persistence

Horizon decimal precision is already policy-controlled:

- `LATENCY_HORIZON_DECIMAL_PLACES = 2` in `graph-editor/src/constants/latency.ts`
- `UpdateManager.applyBatchLAGValues(...)` rounds:
  - `edge.p.latency.t95` and `edge.p.latency.path_t95` via `roundHorizonDays(...)`.

Graph→file writeback exists for horizons (and only horizons/metadata):

- `fetchDataService.persistGraphMasteredLatencyToParameterFiles(...)` writes graph-mastered latency horizons back to parameter files (metadata-only, no values) unless in `from-file` mode.
- UpdateManager’s graph→file mapping applies the same horizon rounding when persisting to `latency.t95` / `latency.path_t95`.

Second-order implication: any change that affects the computed horizons can create **file churn** (git diffs) and will also affect “versioned” behaviours that consult file latency config.

### 1.3 Where horizons are consumed (downstream implications)

`path_t95` and `t95` are not just UI values; they influence fetch policy and caching decisions:

- `graph-editor/src/services/windowFetchPlannerService.ts`
  - `checkStaleness(...)` uses `Date.now()` and compares “days from query end to now” vs `t95`/`path_t95`.
  - It tries to use `path_t95` for cohort queries via `getPathT95ForEdge(...)`.
  - If `edge.p.latency.path_t95` is missing, it computes a `computePathT95(...)` map on-demand (cached per graph hash).
    - That on-demand computation uses `edge.p.mean` and may use default injection when an edge has latency enabled but `t95` is missing.
- `graph-editor/src/services/cohortRetrievalHorizon.ts`
  - `computeCohortRetrievalHorizon(...)` **does not trim** the start of cohort windows; it evaluates horizons and classifies cohorts (missing/stale/stable) relative to `referenceDate` (default `new Date()`).
  - Any “minimum fetch” behaviour must come from **coverage-aware planning** (i.e. only skipping dates already present in file), not from horizon-based start truncation.

Second/third-order implication: nondeterministic horizons are not only a testing nuisance; they can change:

- whether a slice is considered stale vs stable,
- whether cohort dates are treated as stale vs stable (and therefore scheduled for refresh),
- and therefore whether a particular fetch run will hit the network at all.

### 1.4 Critical invariants locked by tests (do not ignore)

The existing tests encode important semantic constraints that any policy change must respect:

- **Join-aware path horizon semantics** (not “median-ish” and not dominated by tiny-mass long tails):
  - `graph-editor/src/services/__tests__/pathT95JoinWeightedConstraint.test.ts`
  - It asserts join weighting uses **topological arriving mass** (product from start), not local edge probability, and that horizons do not shrink below topo fallback.
- **Completeness must not be polluted by pre-pass default-injected horizons**:
  - `graph-editor/src/services/__tests__/pathT95CompletenessConstraint.test.ts`
  - It asserts pre-pass `computePathT95(...)` may use `DEFAULT_T95_DAYS`, but completeness must use stored/in-pass horizons, not default-injected ones.
- **Graph/file authority for cohort bounding**:
  - `graph-editor/src/services/__tests__/pathT95GraphIsAuthoritative.cohortBounding.test.ts`
  - It asserts that versioned planning prefers parameter-file `latency.path_t95` when present; otherwise use graph.

These tests are the repo’s current “law”. Any recommendation below explicitly accounts for them.

---

## 2) Proposals + recommendations (with trade-offs and higher-order implications)

### Proposal 1) Deterministic “as-of date” for Stage‑2 (replace wall-clock `new Date()` inside Stage‑2)

#### Current state

- Stage‑2 (LAG topo pass) uses `queryDateForLAG = new Date()` in `fetchDataService`.
- Many downstream policies use “now” too:
  - `WindowFetchPlannerService.checkStaleness(...)` uses `Date.now()` and `getTodayUK()` for resolving open-ended windows.
  - `computeCohortRetrievalHorizon(...)` defaults `referenceDate = new Date()`.

This makes identical query intent behave differently depending on:

- when Stage‑2 happened to run (boot vs later),
- how long the boot sequencing took (live share vs normal),
- and test runtime clock (fake timers vs real).

#### Candidate policies

- **P1-A (recommended): Pin Stage‑2 as-of to the query window end date (day resolution).**
  - If DSL has `window(...)`: as-of = `window.end` (or resolved “today” if open-ended).
  - If DSL has `cohort(...)`: as-of = `cohort.end` (or resolved “today” if open-ended).
  - Always treat it as a day-level value (not milliseconds precision).
- **P1-B: Pin Stage‑2 as-of to retrieval timestamp (`retrieved_at`) of the slice family used.**
  - This would use the data’s freshness rather than the query period.
  - Harder because “from-file” may include slices with mixed `retrieved_at` across contexts/MECE partitions.
- **P1-C: Keep wall-clock now, but quantise to day boundary and pass consistently.**
  - Better than millisecond now, but still makes fixed-date DSLs drift over time.

#### Recommendation

Adopt **P1-A**: Stage‑2 should use a deterministic as-of date derived from the **effective DSL** and snapped to day resolution.

This satisfies both goals:

- **Determinism**: identical resolved DSL ⇒ identical as-of ⇒ repeatable horizons.
- **Adaptiveness**: relative/open-ended DSLs naturally change as “today” changes (via deterministic resolution), producing updated horizons when the user intends “up to now”.

#### Trade-offs (including 2nd/3rd-order implications)

- **Pros**
  - Makes Stage‑2 repeatable under tests without relying on fake timers.
  - Removes a major “boot sequencing” divergence source between normal and live share.
  - Aligns conceptual meaning: when the user asks for a time window, maturity/completeness should be evaluated “as-of that window end”.
- **Cons / risks**
  - For fixed-date DSLs (explicit historical windows), horizons will stop changing as real time passes.
    - This is arguably correct: the query intent is “as-of that historical cut”.
    - If the user wants “as-of now”, they should use an open-ended/relative DSL.
  - Planner staleness logic currently uses `Date.now()` and compares to query end; Stage‑2 as-of will now be “query end”, not “now”.
    - This is not inherently inconsistent, but it means the system must be explicit about which “now” each subsystem uses.
    - Without that clarity, you can still get “determinism” in Stage‑2 but “floatiness” in planner classifications.

**Follow-on note (not part of the core recommendation, but a necessary corollary):**

If Stage‑2 adopts P1-A, the planner should also be explicit about reference dates. Otherwise, Stage‑2 determinism will not guarantee end-to-end determinism for “fetch vs stale candidate” decisions.

---

### Proposal 2) Quantise/round horizons more aggressively (discrete contracts)

#### Current state

Rounding already exists and is centralised:

- `LATENCY_HORIZON_DECIMAL_PLACES = 2` (days) in `graph-editor/src/constants/latency.ts`.
- `UpdateManager.applyBatchLAGValues(...)` rounds:
  - `edge.p.latency.t95`
  - `edge.p.latency.path_t95`

There are also other rounding/precision constants:

- `PRECISION_DECIMAL_PLACES = 4` for probability-scale values.

#### Candidate policies

- **P2-A (status quo): Keep 2 d.p. days for horizons.**
- **P2-B: Round horizons to 0.1 days (~2.4 hours).**
- **P2-C: Round horizons to whole days.**

#### Recommendation

Keep **P2-A** (2 d.p.) as the default horizon rounding policy, and treat further quantisation as a targeted tool rather than a global change.

Reason: this codebase already has a deliberate policy (`LATENCY_HORIZON_DECIMAL_PLACES`) and multiple subsystems depend on it (graph↔file sync, planner messages, cohort bounding summaries). Tightening it further would introduce churn and semantic distortion without addressing the primary nondeterminism drivers (reference date + sequence dependence).

#### Trade-offs and higher-order implications

- **Pros of keeping current rounding**
  - Low behavioural risk: preserves existing semantics and test expectations.
  - Prevents git churn from unnecessary rounding policy changes.
  - Avoids introducing large step discontinuities in horizon-driven policies (bounding windows, stale vs stable thresholds).
- **Cons**
  - Rounding does not solve wall-clock coupling or sequence dependence; it merely reduces visible jitter.
  - Tests that assert exact numeric equality will remain brittle if upstream nondeterminism exists.

If a future change requires even stronger stability (for UX or tests), prefer:

- comparing rounded/normalised horizons at the boundary where they matter (planner decisions),
- rather than globally rounding earlier and losing information inside the statistical pass.

---

### Proposal 3) Stage‑2 must be a pure function of a frozen input snapshot (no “stateful reuse” across runs)

#### Current state

There are explicit signs the system has had sequence-dependence problems:

- `fetchDataService.fetchItems(...)` includes comments and logic to track the freshest graph reference (`latestGraph`) so Stage‑2 doesn’t run on stale data if `getUpdatedGraph()` is missing.
- Live share boot explicitly recomputes even when cached artefacts exist (to avoid stale divergence), but sequencing differences remain an outstanding issue in `TODO.md`.

There are multiple potential sources of “non-frozen inputs”:

- Graph fields that are outputs of Stage‑2 (blended `p.mean`, completeness, `path_t95`) being present before a subsequent Stage‑2 run.
- On-demand `computePathT95(...)` in the planner, which depends on current `edge.p.mean` and may use default-injected `t95`.
- Scenario composition (`CompositionService.applyComposedParamsToGraph`) can write scenario overrides into `edge.p.*` (including `p.mean`) and thereby change the graph state between passes.

#### Candidate policies

- **P3-A (recommended): Define an explicit Stage‑2 input snapshot contract.**
  - Stage‑2 must read only:
    - graph topology and configuration (latency enablement, anchor node id, etc.),
    - per-DSL evidence/forecast inputs (from cache/file) for the selected slice family,
    - and a deterministic as-of date (see Proposal 1).
  - Stage‑2 must not treat any previously computed “transient outputs” on the graph as authoritative inputs.
- **P3-B: Allow reuse, but require fixed-point convergence.**
  - If Stage‑2 is run repeatedly on a stable dataset, it must converge quickly and be idempotent at convergence.
  - This is harder to specify and test, and tends to hide real sequencing bugs until later.

#### Recommendation

Adopt **P3-A**: explicitly specify Stage‑2 as a pure transform from “(graph config + cached per-DSL inputs + as-of)” → “computed outputs”, and treat any pre-existing computed outputs on the graph as stale/cache that must not influence computation.

This is the only robust way to make “run once vs run twice” behaviour identical.

#### Trade-offs and higher-order implications

- **Pros**
  - Greatly improves testability: Stage‑2 can be reasoned about as a deterministic transform.
  - Reduces normal vs live share divergences caused by different boot ordering.
  - Makes it easier to identify genuine semantic bugs (incorrect slice selection) vs incidental sequencing noise.
- **Cons / risks**
  - Requires careful definition of “inputs” across modes:
    - in `from-file` mode, the graph is updated from parameter files (evidence/forecast/latency summaries) and then Stage‑2 runs.
    - in “direct”/versioned fetch paths, graph fields may be partially updated item-by-item before Stage‑2 runs once.
  - If any consumer currently relies on intermediate computed outputs being present mid-fetch, this policy will surface that coupling (which is good, but may break existing workflows).

This proposal is synergistic with Proposal 1 and partially overlapping with Proposal 4 (because “what Stage‑2 should use as weight inputs” is part of defining the input snapshot).

---

### Proposal 4) Break the `p.mean` → join weighting → `path_t95` → completeness → blend → `p.mean` sensitivity

#### Current state (what the code does)

In `statisticalEnhancementService.enhanceGraphLatencies(...)`, join-aware path horizons use a *weighted* percentile of inbound path horizons, where weights are a “flow mass proxy” computed as a topological product of `edge.p.mean` (starting from entry weight).

The key test `pathT95JoinWeightedConstraint.test.ts` asserts that:

- join weighting must be based on arriving mass (topological product), not on proximate/local probabilities,
- and that horizons must not shrink below topo fallback.

So “weighted join horizons” are not optional: they are an intended behaviour and currently tested.

However, `p.mean` is also a Stage‑2 output (blended mean), and it can be changed by scenario composition. Therefore, if Stage‑2 runs in different sequences or multiple times, the weight field used for join weighting can differ.

#### Candidate policies

- **P4-A (recommended): Define a stable, explicit probability basis for join weighting that Stage‑2 does not overwrite.**
  - For example, use one of:
    - evidence mean (`edge.p.evidence.mean`) as the mass proxy,
    - forecast mean (`edge.p.forecast.mean`) as a stable baseline proxy,
    - or a dedicated “pre-blend” probability field (would be a schema change).
  - The core requirement is: join-weight mass must be derived from a field that is not itself overwritten by the same pass.
- **P4-B: Keep using `p.mean`, but require Stage‑2 to restore/normalise `p.mean` to a deterministic pre-pass value before computing horizons.**
  - This can be thought of as “Stage‑2 always starts from evidence-state, never from previous blended-state”.
  - This avoids a schema change, but is easy to get subtly wrong across entrypoints.
- **P4-C: Remove weighting (use max or unweighted percentile).**
  - Rejected: violates the explicit design intent and the current tests, and would materially change cohort bounding behaviour (tiny-mass long paths could dominate).

#### Recommendation

Adopt **P4-A**: define a stable join-weight basis that is not overwritten by Stage‑2.

The safest near-term basis in the existing schema is **evidence**:

- use `edge.p.evidence.mean` (per-DSL observed rate) as the probability used for flow-mass weighting inside the topo pass, with conservative fallbacks when evidence is missing.

This retains the core intention (“tiny-mass branches should not dominate horizons”) while removing the biggest sequence-dependent input (`p.mean` which Stage‑2 overwrites).

#### Trade-offs and higher-order implications

- **Pros**
  - Removes a major feedback channel: Stage‑2 output no longer feeds back into join weighting inputs.
  - Aligns semantics: path horizon weighting is about “how much population actually reaches the join”, and evidence is closer to an “observed reaching mass” than blended means in immature regimes.
  - Fits the repo’s existing separation of concerns:
    - `p.evidence.mean` is documented as “raw observed signal” (kept stable),
    - blending is a separate operation that computes `p.mean`.
- **Cons / risks**
  - When evidence is sparse (small `n`), evidence-based weights can be noisy. That could make join horizons *more* variable if the underlying evidence inputs are varying (e.g. missing days, MECE incomplete partitions).
    - This risk is mitigated by Proposal 1 (pinned as-of) and by the fact that the main nondeterminism complaint is *sequence*, not “data changed”.
  - Scenario/what-if overlays that intentionally change probabilities may not be reflected in evidence-based weights unless the overlay also updates `p.evidence.mean` (it typically does not).
    - If scenario behaviour must influence join weighting, this implies the need for a dedicated “scenario effective probability used for flow mass” input (a new field or a deterministic recomputation layer).

**Second-order implication:**

Because `path_t95` feeds cohort bounding and staleness classification, changing join weighting will change which cohorts are considered “mature enough”, and therefore will change fetch plans for some graphs. This is a real behavioural change; it must be handled with explicit acceptance and good tests (especially around joins).

---

### Proposal 5) Bucketed or gated horizon updates (avoid “continuous refitting” churn)

#### Current state

The system already persists graph-mastered horizons back to parameter files (metadata-only) after Stage‑2 in non-`from-file` modes.

This has benefits (prevents direct vs versioned divergence), but it also means:

- any small change in computed horizons can produce file churn,
- repeated runs can repeatedly rewrite the same values,
- and if Stage‑2’s as-of is wall-clock, horizons will drift without any explicit user intent change.

#### Candidate policies

- **P5-A (recommended, but only after Proposal 1): Gate persistence and/or recomputation by a deterministic bucket.**
  - Example: only persist horizons when the Stage‑2 as-of day changes, or when the underlying slice inputs changed (new retrieval, new cohorts/days).
  - The gating must be based on explicit, logged criteria, not “time since last run”.
- **P5-B: Never persist computed horizons (graph-only transient).**
  - Rejected for this repo’s parity goals: versioned behaviours consult file latency config and the tests explicitly care about file/graph authority decisions.
- **P5-C: Persist always (status quo).**
  - Acceptable only if Proposal 1 is adopted; otherwise it bakes wall-clock drift into the repo.

#### Recommendation

Adopt **P5-A**, but only once Proposal 1 (deterministic as-of) is in place.

Without Proposal 1, gating persistence by buckets would be fighting the symptom while keeping the root cause (wall-clock drift) in the pipeline.

#### Trade-offs and higher-order implications

- **Pros**
  - Reduces git churn and makes diffs more meaningful.
  - Makes repeated fetch/test runs stable: “same day, same intent, same horizons” becomes an explicit contract.
  - Improves parity between normal/live share when both resolve the same DSL end date.
- **Cons / risks**
  - Risk of delaying legitimate updates if the gating signal is too coarse.
    - This is why gating must consider “inputs changed” (new cohorts/days retrieved) as well as day buckets.
  - Adds complexity to the persistence pipeline and requires careful logging to remain debuggable.

---

## 3) Summary table (recommended posture per proposal)

- **Proposal 1 (as-of date)**: **Adopt**. Pin Stage‑2 as-of to resolved DSL end date (day resolution).
- **Proposal 2 (quantisation)**: **Keep** current rounding (2 d.p.). Do not increase quantisation as a primary stabiliser.
- **Proposal 3 (pure Stage‑2 snapshot)**: **Adopt**. Stage‑2 must be a deterministic transform of explicit inputs; do not allow “previous computed outputs” to influence a later pass.
- **Proposal 4 (join weighting basis)**: **Adopt in principle** (stable input basis), with a strong warning: changing the weight basis is semantically meaningful and will affect fetch plans; it should be introduced only with explicit agreement and with tests for joins.
- **Proposal 5 (bucketed updates)**: **Adopt after Proposal 1**. Gate persistence/recompute to avoid churn and unintended drift.

---

## 4) Appendix: key code touchpoints (for reviewers)

- Stage‑2 orchestration:
  - `graph-editor/src/services/fetchDataService.ts` (`fetchItems`, `runStage2EnhancementsAndInboundN`, `persistGraphMasteredLatencyToParameterFiles`)
- Topo/LAG pass:
  - `graph-editor/src/services/statisticalEnhancementService.ts` (`enhanceGraphLatencies`, join-aware weighting, path horizon logic)
- Rounding/persistence:
  - `graph-editor/src/constants/latency.ts` (`LATENCY_HORIZON_DECIMAL_PLACES`)
  - `graph-editor/src/services/UpdateManager.ts` (`applyBatchLAGValues`, graph↔file mappings)
- Planner consumers:
  - `graph-editor/src/services/windowFetchPlannerService.ts` (`getPathT95ForEdge`, `checkStaleness`, bounded cohort windows)
  - `graph-editor/src/services/cohortRetrievalHorizon.ts`
- Behavioural tests worth re-reading before any implementation:
  - `graph-editor/src/services/__tests__/pathT95JoinWeightedConstraint.test.ts`
  - `graph-editor/src/services/__tests__/pathT95CompletenessConstraint.test.ts`
  - `graph-editor/src/services/__tests__/pathT95GraphIsAuthoritative.cohortBounding.test.ts`


