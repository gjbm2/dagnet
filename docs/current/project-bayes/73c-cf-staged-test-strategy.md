# 73c — CF Staged Test Strategy (sidecar to doc 73a)

**Date**: 25-Apr-26
**Status**: Complete — all 8 layers reasoned through from first principles
**Audience**: engineers implementing doc 73a; reviewers verifying test coverage is load-bearing
**Relates to**: `73a-scenario-param-pack-and-cf-supersession-plan.md`, `73b-be-topo-removal-and-forecast-state-separation-plan.md`

## Purpose

Doc 73a names the work and the per-stage gates. This sidecar pins the
**test strategy** that makes silent failure nigh impossible across
the work doc 73a describes.

The strategy is not "more tests". It is: for each layer of the CF
transaction, enumerate concrete failure modes from first principles,
group them into the minimum set of tests that catches each mode
diagnostically (the test points to which phase broke, not just that
something broke), and explicitly state what each test does NOT catch
so reviewers can see the gaps.

This doc is built one layer at a time. Each layer's section is only
added after the per-layer reasoning has actually been done — not
pattern-matched. Layers below marked "Pending" have not yet been
worked through from first principles.

## Method (the per-layer template)

Every completed layer section follows the same six-step structure.
Reviewers should refuse to accept a layer section that skips a step.

1. **What does this layer actually do?** Three-to-five sentence
   statement of the discrete operations at this layer.
2. **Enumerate concrete failure modes.** Numbered (`F1`, `F2`, …) so
   they map back to tests at the end. No reference to test names yet.
3. **Test level for each.** Unit / integration / e2e / static check.
4. **Group risks into the minimum test set.** Which failure modes
   share inputs and can be subcases of one test; which need their
   own test.
5. **Concrete tests.** For each test in the set: file name (proposed),
   inputs (sentinel-driven where relevant), subcases and assertions
   in plain language, **what it catches** (`Fn` references), **what
   it does NOT catch**.
6. **Cross-check.** What was missed in the enumeration? Add as `Fk`
   and either fold into an existing test or add a new one. Anything
   explicitly handed off elsewhere is named here.

## Layer index

| Layer | Topic | Status |
|---|---|---|
| A | CF dispatch (FE → BE entry) | **Complete** (§A below) |
| B | CF response handling (BE → FE return) | **Complete** (§B below) |
| C | Per-scenario graph composition + delivery to BE | **Complete** (§C below) |
| D | Pack lifecycle (extract → store → recompose) | **Complete** (§D below) |
| E | Async lifecycle (slow CF, supersession, ordering) | **Complete** (§E below) |
| F | Cleanup integrity (post-Stage-5c) | **Complete** (§F below) |
| G | Observability (session log shape, levels) | **Complete** (§G below) |
| H | End-to-end (browser + cross-cutting integration) | **Complete** (§H below) |

## C — Per-scenario graph composition + delivery to BE

### C.1 What does this layer actually do?

Two discrete operations:

1. The FE composes a per-scenario request graph from baseline +
   ordered packs (existing behaviour, owned by doc 73a).
2. At analysis-prep / CF request-build time, the FE engorges each
   per-scenario request graph with the parameter-file slice that
   matches that scenario's effective DSL (NEW in doc 73b Stage 4(a)).
   The engorgement preserves today's read shape (`_posteriorSlices`-
   like fields) so BE consumers do not need code changes; what changes
   is that the slice library is no longer persistently stashed on the
   live graph.

This sidecar's Layer C failure modes apply to operation (2). After
the resequence, that is doc 73b Stage 4(a). The test artefacts below
are still useful as written — they are stage gates for that
engorgement and should be cited from doc 73b's acceptance.

### C.2 Enumerate concrete failure modes

- **F1**: Derivation picks the WRONG slice for a scenario's effective
  DSL (string-key lookup mismatch, asat resolution wrong, sibling
  fallback wrong).
- **F1a**: Derivation silently substitutes a slice from a DIFFERENT
  context when the requested context has no matching slice (e.g.,
  returns the bare `window()` slice when the query asks for
  `context(channel:google).window()`). This is silent semantic
  substitution: a fit from a different population labelled as the
  requested context. The no-cross-context-fallback rule (doc 73a §5
  stop rule, restated as a constraint on doc 73b's bundled
  switchover) forbids this; the correct behaviour is to omit the
  bayesian entry, letting the consumer fall through to the analytic
  source.
- **F2**: Derivation picks the right slice but emits the WRONG shape
  (forgets `path_mu`/`path_sigma`, copies `mu` into `sigma`, misses
  `mu_sd_pred`).
- **F3**: Derivation MUTATES the parameter-file source object or the
  persistent graph (writes to the wrong place; corrupts the
  underlying inventory).
- **F4**: Derivation runs for the ANALYSIS path but NOT for the CF
  path (or vice versa) — the two paths diverge silently.
- **F5**: Derivation runs but its OUTPUT doesn't make it onto the
  request payload sent to BE (lost in serialisation, overwritten by
  a later step).
- **F6**: Derivation REPLACES the analytic entry in `model_vars[]`
  instead of just the bayesian entry (clobbers FE topo's analytic
  source).
- **F10**: Per-scenario loop captures stale closure state, so all
  scenarios get the FIRST scenario's derivation (a JS closure bug).
- **F11**: Derivation calls the `ParameterFileResolver` callback
  more times than necessary (perf regression that doesn't affect
  correctness).

Failure modes F7, F8, F9 from earlier drafts (BE-side reads of the
slice material) are explicitly handed off to doc 73b. Under doc 73b's
simplified Stage 4, BE consumers do not migrate — engorgement
preserves today's read shape — so what's tested in doc 73b is that
the engorged material lands in the expected shape, not that consumers
switched read paths.

### C.3 Test level for each

- **F1, F2, F3, F6**: pure function behaviour. **Unit**-testable on
  the derivation helper with hand-rolled inputs.
- **F4**: requires running both code paths with the same input and
  comparing outputs. **Integration** (Vitest with the real services).
- **F5**: requires capturing the actual outgoing request payload.
  **Integration** (intercept the fetch / capture the call).
- **F10**: covered as a multi-scenario subcase of F4's integration
  test.
- **F11**: out of scope for correctness; flagged as a perf concern.

### C.4 Group into the minimum test set

- F1, F2, F3, F6 share inputs (sentinel parameter file with multiple
  distinct slices) → one unit test, four subcases.
- F4 is a separate integration test (different code paths to
  compare).
- F5 is a separate integration test (exercises serialisation).

Result: **three tests** for Layer C (owned by doc 73b Stage 4(a) —
the analysis-prep engorgement step). The fourth test in earlier
drafts — `beReadFromModelVarsOnly.test.py` for F7/F8 — is no longer
required: under doc 73b's simplified Stage 4 the BE consumers keep
their existing read paths; what changes is where the data comes
from (per-call engorgement, not persistent stash).

### C.5 Concrete tests

#### C-Test-1: `perScenarioModelVarsDerivation.test.ts` (Vitest, unit)

**Inputs**: sentinel parameter file with slices
`{window(): {alpha: 100, mu_mean: 1.1, …}, cohort(): {alpha: 200, mu_mean: 1.2, path_mu_mean: 2.2, …}, window(context:foo): {alpha: 300, …}}`.
Pre-existing graph with an `analytic` entry in `model_vars[]`
carrying sentinel `mu = 9.99`.

**Subcases / assertions**:

- Scenario with `effective_dsl = "window()"` → derived bayesian
  entry's `probability.mean` derives from α=100. (F1)
- Scenario with `effective_dsl = "cohort()"` → derived entry's
  `latency.path_mu = 2.2`. (F1, F2)
- Scenario with `effective_dsl = "window(context:foo)"` → derived
  entry uses α=300, NOT α=100. (F1)
- Scenario with `effective_dsl = "window()"` plus `asat=2026-01-01`
  → derived from `fit_history` slice on or before that date, not
  current. (F1, asat path)
- For each subcase: derived entry's full shape matches the expected
  per-field sentinel values. (F2 — catches partial copies)
- Input parameter file object is `Object.freeze`'d before the call —
  function does not throw and returns a fresh entry. (F3)
- Pre-existing `analytic` entry in `model_vars[]` is still present
  and unchanged after derivation. (F6)
- Sentinel parameter file with **only** the bare `window()` slice (no
  `context(channel:google).window()` slice). For a scenario whose
  effective DSL is `context(channel:google).window()`, the derived
  bayesian entry is **omitted** — not silently filled with the bare
  `window()` values. The graph carries no bayesian source for that
  scenario's edges. (F1a)

**Catches**: F1, F1a, F2, F3, F6.

**Does NOT catch**: F4 (path divergence), F5 (serialisation),
F7-F8 (BE-side).

#### C-Test-2: `cfAndAnalysisDerivationParity.test.ts` (Vitest, integration)

**Inputs**: same sentinel parameter file as C-Test-1. Build a
per-scenario request graph for both code paths:
(a) call `analysisComputePreparationService.ts` analysis-prep,
(b) call `conditionedForecastGraphSnapshot.ts` for CF.

Run with **N=3 scenarios** with distinct effective DSLs to also
catch the closure-state failure mode.

**Assertions**:

- For the same `(edge, paramId, effectiveDSL)`, the bayesian
  `model_vars[]` entry on the resulting request graph is byte-equal
  across the two paths. (F4)
- Each of the N scenarios has a distinct, correct entry — not all
  the same as the first scenario. (F10)

**Catches**: F4, F10.

**Does NOT catch**: anything else.

#### C-Test-3: `cfRequestPayloadModelVars.test.ts` (Vitest, integration)

**Inputs**: sentinel parameter file. Use the deferred-CF harness
(doc 73a Stage 0A) so the actual outgoing request can be captured
before it is sent.

**Assertion**: the captured request payload's
`scenarios[i].graph.edges[j].p.model_vars[bayesian]` carries the
sentinel-derived values, byte-equal to what the derivation function
produced standalone (per C-Test-1). (F5)

**Catches**: F5.

**Does NOT catch**: anything else.

#### C-Test-4 — dropped under simplified doc 73b

The earlier `beReadFromModelVarsOnly.test.py` covering F7/F8 (BE
consumer reads the right surface) was premised on a consumer-migration
stage that no longer exists. Doc 73b's simplified Stage 4 leaves BE
read paths unchanged — they continue to read `model_vars[]`,
`posterior.*`, and `latency.posterior.*` on the request graph,
served by per-call engorgement instead of the persistent stash.
The test artefact is therefore not required. C-Test-1 already
asserts the engorged shape matches what consumers read today.

### C.6 Cross-check

- **F7, F8, F9** (BE-side reads of slice material) handed off to
  doc 73b. Under doc 73b's simplified Stage 4 the BE read paths do
  not migrate — engorgement preserves today's shape — so the
  C-Test-4 artefact previously planned for these is dropped, not
  moved.
- **F10** added during cross-check; folded into C-Test-2.
- **F11** flagged as out of scope for correctness; left as a
  potential separate perf regression test if it becomes a concern.
- All in-scope (doc 73a) enumerated failure modes are covered by
  C-Test-1 through C-Test-3.

## A — CF dispatch (FE → BE entry)

### A.1 What does this layer actually do?

Four discrete operations per regeneration cycle:

1. **Enumerate** which scenarios should receive CF (the dispatch
   coverage decision).
2. For each, **increment** the per-scenario supersession generation
   counter and capture the new value.
3. For each, **build** the request envelope: `scenarioId`, the
   scenario's composed graph with per-scenario `model_vars[]` already
   derived (Layer C work has run), `effective_query_dsl`,
   `candidate_regimes_by_edge`.
4. **Send** the request to BE.

Boundary: response routing, response application, and pack extraction
are out of scope for Layer A — they belong to Layers B, D, E.

### A.2 Enumerate concrete failure modes

**Coverage failures** (which scenarios get dispatched):

- **AA1**: A visible user live scenario is NOT dispatched (silent
  miss → that scenario's display drifts stale relative to siblings).
- **AA2**: A hidden scenario IS dispatched (wasted compute; possible
  race if the scenario is later shown and another dispatch fires for
  it).
- **AA3**: BASE is dispatched (against doc 73a §3.12 — BASE frozen
  at load).
- **AA4**: CURRENT is dispatched as part of `regenerateAllLive`
  (against design — CURRENT has its own path via
  `useDSLReaggregation`).
- **AA5**: The same scenario is dispatched multiple times within one
  cycle (loop bug or duplicate registration).
- **AA6**: A scenario created mid-cycle is silently excluded from
  the next cycle (registration race against the visible-list
  snapshot).
- **AA7**: A scenario deleted mid-cycle is still dispatched (cleanup
  race).

**Supersession state failures**:

- **AS1**: Generation counter is incremented for the wrong
  `scenarioId` (cross-scenario contamination at commission time).
- **AS2**: The generation value is captured AFTER the request is
  built rather than before — so an interleaved commission for the
  same scenario advances the counter and the captured value is
  already stale.
- **AS3**: Supersession state is shared across tabs (module-global
  instead of per-tab — the very defect doc 73a Stage 1 fixes).
- **AS4**: Supersession state is allocated fresh per fetch call
  rather than per tab — A's gen-1 record vanishes before A's gen-1
  response arrives, so the response can't be checked against the
  right baseline.

**Envelope contents failures**:

- **AE1**: `scenarioId` on the request doesn't string-equal the
  scenario's actual id.
- **AE2**: `effective_query_dsl` on the request doesn't match the
  scenario's computed effective DSL (stale cache, or computed
  against the wrong context).
- **AE3**: The request graph is BASE (or some other shared graph)
  rather than the per-scenario composed graph.
- **AE4**: Closure capture bug in the dispatch loop — every scenario
  sends the last scenario's graph (because the iteration captured a
  shared mutable reference).
- **AE5**: Per-scenario `model_vars[]` derivation (Layer C) has NOT
  run on the request graph before dispatch — the request carries
  baseline-inherited model_vars instead. Defeats doc 73b's bundled
  switchover delivery sub-step.
- **AE6**: `candidate_regimes_by_edge` is empty or wrong for this
  scenario.
- **AE7**: Building the request payload mutates the live editor's
  source-of-truth graph as a side effect.
- **AE8**: `analytics_dsl` (the subject from/to clauses, separate
  from the per-scenario `effective_query_dsl`) on the request
  doesn't match the chart's analytics subject — BE resolves the
  wrong subject edges.

### A.3 Test level for each

- **All AA, AS, AE failures**: integration-level, observable through
  the deferred-CF transaction harness (doc 73a Stage 0A). The harness
  intercepts every dispatch and exposes the call record (scenarioId,
  payload, captured generation, etc.) for inspection.

Why no unit tests for Layer A? Layer A is the orchestration of FE
state into a request — it has no pure helper that's worth
unit-testing in isolation. The risk is in the orchestration, not in
any single function. Integration through the harness is the
appropriate granularity.

Loud failures (wrong endpoint URL, missing auth, network error) are
out of scope — they fail visibly, not silently, so they're caught by
basic API-contract tests outside doc 73a.

### A.4 Group into the minimum test set

Three orthogonal concerns → three tests. AA, AS, AE don't share
inputs in a way that benefits from merging:

- AA needs a multi-scenario setup with mixed visibility + lifecycle
  CRUD operations.
- AS needs deferred resolutions and manual generation advances.
- AE needs payload inspection with sentinel values per scenario.

AA6/AA7 (lifecycle races) are a different stress pattern from
AA1-AA5 — they need create/delete actions during a regen cycle. The
harness setup is the same as the rest of AA, so I keep them as
subcases of the coverage test under explicit "lifecycle race"
labels.

Result: **three tests** for Layer A.

### A.5 Concrete tests

#### A-Test-1: `cfDispatchCoverage.test.ts` (Vitest, integration)

**Inputs**: tab with 3 user live scenarios (S1, S2, S3) plus BASE
and CURRENT. Use the deferred-CF harness so every dispatch is
captured. Sentinel scenarioIds (`'sent-S1'`, `'sent-S2'`,
`'sent-S3'`).

**Subcases / assertions**:

- All three visible → invoke `regenerateAllLive` → harness records
  exactly 3 dispatch calls, one per visible user scenario, none for
  BASE, none for CURRENT. (AA1, AA3, AA4)
- S2 hidden, S1 + S3 visible → harness records exactly 2 dispatches
  (S1, S3); none for S2, BASE, CURRENT. (AA2)
- All three visible → harness records each scenarioId exactly once
  across the cycle (no duplicates). (AA5)
- **Lifecycle race subcase A** — start `regenerateAllLive`, then
  create S4 mid-cycle (before all dispatches fire). Assert behaviour
  matches a documented choice: either S4 is included in this cycle
  (snapshot taken late) or excluded (snapshot taken early). What
  matters is that the choice is consistent with code intent and
  asserted explicitly. (AA6)
- **Lifecycle race subcase B** — start `regenerateAllLive`, then
  delete S2 mid-cycle. Assert S2 either gets its dispatch (if
  already past the gate) AND its later response is correctly
  discarded, or doesn't get dispatched (if cancelled before the
  gate). Whichever, no orphan response is applied to a non-existent
  scenario. (AA7)

**Catches**: AA1, AA2, AA3, AA4, AA5, AA6, AA7.

**Does NOT catch**: supersession internals (Layer A AS), envelope
contents (Layer A AE), response routing (Layer B).

#### A-Test-2: `cfPerScenarioSupersession.test.ts` (Vitest, integration)

**Inputs**: tab with 2 user live scenarios (S1, S2). Deferred-CF
harness with manual control over supersession state inspection.

**Subcases**:

- **Two scenarios overlapping CF** — dispatch S1, dispatch S2 (both
  in flight). Resolve S2 first. Resolve S1 late. Assert both
  responses are accepted by their respective per-scenario gen check
  (no cross-cancellation). (AS1 — per-scenario isolation)
- **Same scenario, two generations** — dispatch S1 (captures
  `gen=1`). Before S1's response arrives, dispatch S1 again
  (captures `gen=2`). Resolve `gen=1` response. Assert it is
  discarded against S1's current `gen=2`. Resolve `gen=2` response.
  Assert it is applied. (AS2 — capture timing: `gen=1` must have
  been captured BEFORE the second commission incremented it;
  otherwise the response check would compare `gen=2` to `gen=2` and
  silently apply the stale data)
- **Module-global counter symbol** — source-grep + AST check: the
  file containing dispatch logic does not export or reference a
  module-level `_conditionedForecastGeneration` (or equivalent). The
  supersession state is reachable only through the per-tab /
  per-scenario API. (AS3)
- **State persistence across fetches** — dispatch S1 (captures
  `gen=1`). Issue an unrelated fetch operation that completes. Then
  resolve S1's response. Assert the `gen=1` record is still on the
  supersession tracker (didn't get garbage-collected by the
  unrelated fetch). (AS4)

**Catches**: AS1, AS2, AS3, AS4.

**Does NOT catch**: dispatch coverage (Layer A AA), envelope
contents (Layer A AE).

#### A-Test-3: `cfRequestEnvelope.test.ts` (Vitest, integration)

**Inputs**: tab with 2 user live scenarios with distinct DSLs (S1:
`window()`; S2: `cohort(context:foo)`). Sentinel parameter file
matching the slice keys those DSLs would resolve. Deferred-CF
harness captures the full request payload per call. The live editor
graph is fingerprinted before dispatch.

**Subcases**:

- **Identity** — for each captured dispatch, the request
  `scenarioId` string-equals the scenario's id in
  `ScenariosContext`. (AE1)
- **Effective DSL** — for each captured dispatch, the request
  `effective_query_dsl` string-equals the scenario's
  `meta.lastEffectiveDSL` at dispatch time. Modify S1's DSL between
  test setup and the regen call to confirm the dispatch picks up
  the new DSL, not a cached one. (AE2)
- **Per-scenario graph (not BASE)** — S1's request graph and S2's
  request graph have distinct fingerprints; neither equals the BASE
  graph fingerprint. (AE3)
- **Closure capture** — dispatch all three scenarios. For each
  captured payload, the embedded graph fingerprint matches THAT
  scenario's composed graph fingerprint, not the last scenario's.
  Run with N≥3 scenarios to catch the shared-reference bug that
  two-scenario tests can pass through coincidence. (AE4)
- **Layer C derivation ran** — S1's request graph carries
  `model_vars[bayesian]` derived for `window()`'s slice (sentinel α
  matching the slice key); S2's carries the entry derived for
  `cohort(context:foo)`. The two scenarios' bayesian entries
  DIFFER. If the derivation hadn't run, both would carry whatever
  was on the baseline. (AE5)
- **Candidate regimes** — the request's `candidate_regimes_by_edge`
  is non-empty for at least one edge in each scenario; the regime
  keys for S1 and S2 differ where their DSLs imply different
  candidates. (AE6)
- **Live graph not mutated** — before regen, fingerprint the
  editor's live graph. After regen completes, fingerprint again.
  Assert byte-equal. (AE7)
- **Analytics DSL** — the request's `analytics_dsl` string-equals
  the chart's analytics subject (set up in fixture). Mutate the
  chart's subject between setup and dispatch to confirm the
  dispatch picks up the new analytics DSL, not a cached one. (AE8)

**Catches**: AE1, AE2, AE3, AE4, AE5, AE6, AE7, AE8.

**Does NOT catch**: response handling (Layer B), per-scenario
derivation correctness as a function (Layer C — that's the
standalone `perScenarioModelVarsDerivation.test.ts`).

### A.6 Cross-check

- **Dispatch order**: per doc 73a §3.13, response order is
  non-load-bearing for storage correctness. Dispatch order is
  similarly non-load-bearing because each scenario's pack records
  absolute values and recomposition handles the inheritance. Not
  tested as a Layer A concern.
- **Auth / endpoint / network**: loud failures, out of scope.
- **Aborted dispatches** (e.g. tab close mid-regen): edge case. Not
  currently a stated requirement. Flagged as **AS5 candidate** —
  should aborted dispatches leave a clean supersession state?
  Surface for design discussion; not in current scope.
- **Concurrent regen cycles** (user clicks "refresh all" twice
  rapidly): accepted cost. Supersession discards stale results. Not
  a correctness issue. Not tested.
- **AE8 added on cross-check** — `analytics_dsl` was missed in the
  initial enumeration; folded into A-Test-3.

### A.7 Layer A summary

**Three tests** (A-Test-1, A-Test-2, A-Test-3) cover all enumerated
coverage, supersession, and envelope failure modes. AS5 (aborted
dispatches) flagged as a design question, not yet in scope.

## B — CF response handling (BE → FE return)

### B.1 What does this layer actually do?

Five discrete operations per CF response arrival:

1. **Receive** the BE's response (per-scenario shape).
2. **Identify** which scenario the response is for (via `scenarioId`).
3. **Check** the response against that scenario's current
   supersession generation; discard if stale.
4. **Apply** the per-edge response fields to that scenario's working
   graph (per the §10 mapping table in doc 73a).
5. **Emit** the lifecycle outcome to the session log (commission
   complete / superseded / failed / empty).

Boundary: emission to session log is shared with Layer G — Layer B
asserts the apply happens correctly; Layer G asserts the log shape.
Pack extraction is Layer D / E.

### B.2 Enumerate concrete failure modes

**Routing (BR)**:

- **BR1**: Response for scenario A applied to scenario B's working
  graph (cross-contamination).
- **BR2**: Response for scenario A applied to BASE or some other
  shared graph.
- **BR3**: Response with a `scenarioId` that doesn't match any
  current scenario silently no-ops (could mask a real bug).
- **BR4**: Same response applied multiple times to the same graph
  (idempotency).

**Field mapping (BF)** — one per row in doc 73a §10 mapping table:

- **BF1**: `p_mean → p.mean` slip (lands in wrong field).
- **BF2**: `p_mean → p.forecast.mean` slip (one of the two writes
  drops).
- **BF3**: `p_sd → p.stdev` slip.
- **BF4**: `completeness → p.latency.completeness` slip.
- **BF5**: `completeness_sd → p.latency.completeness_stdev` (name
  conversion `sd → stdev`).
- **BF6**: `evidence_k → p.evidence.k`.
- **BF7**: `evidence_n → p.evidence.n`.
- **BF8**: A response-only field (`p_sd_epistemic`) is INCORRECTLY
  persisted to graph.
- **BF9**: A non-CF-owned field is overwritten by the apply (e.g.
  `p.latency.t95` clobbered).

**Edge-case responses (BE)**:

- **BE1**: Empty response (no edges) is treated as success but no
  fields written → silent drop.
- **BE2**: Failed response (HTTP error / rejected promise) leaves
  the working graph in inconsistent state.
- **BE3**: Partial response (some edges present, others missing) —
  missing edges silently skipped vs. flagged as anomaly.
- **BE4**: Response carries `null` for `p_mean` or `completeness` —
  apply path skips that edge correctly (per
  [conditionedForecastService.ts:206](graph-editor/src/services/conditionedForecastService.ts)
  `if (edge.p_mean == null) continue`).
- **BE5**: Response carries an `edge_uuid` that doesn't exist in
  the current scenario's graph (graph was edited between dispatch
  and response) — apply path silently skips per
  [conditionedForecastService.ts:212](graph-editor/src/services/conditionedForecastService.ts)
  `if (!graphEdge?.p) continue`.

**Supersession check on arrival (BS — partial overlap with Layer A)**:

- **BS3**: Supersession check uses the WRONG scenario's gen counter
  (e.g. compares response A's gen to scenario B's current gen).
- **BS4**: Supersession check happens AFTER apply (graph mutated
  even though response is going to be discarded).

(BS1, BS2 are dispatch-side and covered by A-Test-2.)

### B.3 Test level for each

- **All BR, BF, BE, BS3, BS4**: integration. Deferred-CF harness
  with controlled response payloads + intercepted apply calls.

### B.4 Group into the minimum test set

- BR1-BR4 → one routing test.
- BF1-BF9 → one field-mapping test (already named
  `cfFieldMappingSentinel.test.ts` in doc 73a §16).
- BE1-BE5 → one edge-case test.
- BS3, BS4 → extend A-Test-2 (don't create a new test; supersession
  state is one cohesive concern best tested in one place).

Result: **three tests** for Layer B, plus **two subcases extending
A-Test-2**.

### B.5 Concrete tests

#### B-Test-1: `cfResponseRouting.test.ts` (Vitest, integration)

**Inputs**: tab with 3 user live scenarios (S1, S2, S3). Deferred-CF
harness with response payloads pre-set per scenario carrying
distinct sentinel values: S1 returns `p_mean = 0.111`, S2 returns
`0.222`, S3 returns `0.333`.

**Subcases**:

- All three responses arrive in order S2, S1, S3. Each scenario's
  working graph carries its own sentinel value on the relevant edge.
  No cross-contamination. (BR1)
- BASE graph fingerprint is unchanged across all three responses. (BR2)
- S1's response is intercepted and the harness rewrites its
  `scenarioId` to a non-existent value. The harness intercepts the
  apply call. Assert: NO graph (S1's, S2's, S3's, BASE) was mutated.
  The orphan response is logged as a warning. (BR3)
- S1's response is delivered TWICE to the apply path (simulate a
  duplicate-delivery race). Graph fingerprint after first apply
  equals graph fingerprint after second apply (idempotent). (BR4)

**Catches**: BR1, BR2, BR3, BR4.

**Does NOT catch**: field mapping (BF), edge cases (BE), supersession
(BS).

#### B-Test-2: `cfFieldMappingSentinel.test.ts` (Vitest, integration)

(Already named in doc 73a §16 Stage 4.)

**Inputs**: one scenario's response carrying distinct sentinel values
for every field in the §10 mapping table: `p_mean = 0.111`,
`p_sd = 0.222`, `p_sd_epistemic = 0.999`, `completeness = 0.333`,
`completeness_sd = 0.444`, `evidence_k = 999`, `evidence_n = 1234`.

**Subcases / assertions** — after apply:

- `graph.edge.p.mean = 0.111` and `graph.edge.p.forecast.mean = 0.111`.
  (BF1, BF2 — both writes happen)
- `graph.edge.p.stdev = 0.222`. (BF3)
- `graph.edge.p.latency.completeness = 0.333`. (BF4)
- `graph.edge.p.latency.completeness_stdev = 0.444` (name conversion).
  (BF5)
- `graph.edge.p.evidence.k = 999`. (BF6)
- `graph.edge.p.evidence.n = 1234`. (BF7)
- `graph.edge.p.stdev_epistemic` does NOT exist (or any other field
  carrying `0.999`). `p_sd_epistemic` is response-only. (BF8)
- `graph.edge.p.latency.t95` is unchanged from pre-apply value (CF
  doesn't own t95). (BF9)
- For every other graph field not in the mapping table: unchanged.
  Pre/post graph diff returns only the mapping-table targets.

**Catches**: BF1-BF9.

**Does NOT catch**: routing (BR), edge cases (BE), supersession (BS).

#### B-Test-3: `cfResponseEdgeCases.test.ts` (Vitest, integration)

**Inputs**: tab with 1 scenario. Deferred-CF harness with controllable
response payload.

**Subcases**:

- **Empty response** — harness resolves with `{edges: []}`. Working
  graph fingerprint is unchanged (no fields written). Session log
  entry is `warning` level with `'CF returned empty array'` or
  equivalent message. (BE1)
- **Rejected promise** — harness rejects with an Error. Working
  graph fingerprint is unchanged from pre-dispatch state (no partial
  writes). Session log entry is `error` level. (BE2)
- **Partial response** — fixture has 5 target edges; harness returns
  3 with values + 2 missing. The 3 present edges are applied; the 2
  missing edges are unchanged on the graph. Session log entry
  surfaces the partial coverage at `info` or `warning` (per design
  choice — assert what's intended). (BE3)
- **Null per-edge values** — harness returns
  `{edge_uuid: 'X', p_mean: null, ...}`. Apply path skips that edge
  (per existing `if (edge.p_mean == null) continue`). Graph
  fingerprint for that edge unchanged. (BE4)
- **Orphan edge_uuid** — response carries an edge_uuid that no
  longer exists in the scenario's graph. Apply path silently skips
  per `if (!graphEdge?.p) continue`. No exception thrown; other
  edges in the response are still applied normally. (BE5)

**Catches**: BE1, BE2, BE3, BE4, BE5.

**Does NOT catch**: routing (BR), field mapping (BF), supersession
(BS).

#### Extensions to A-Test-2 (`cfPerScenarioSupersession.test.ts`)

Two additional subcases:

- **Cross-scenario gen check** — dispatch S1 (captures `gen=1` for
  S1). Dispatch S2 (captures `gen=1` for S2). Resolve S1's response.
  Assert the supersession check compares S1's response's gen against
  S1's current gen (NOT against S2's). Even if S2's gen had advanced
  past S1's, S1's response is applied. (BS3)
- **Check-before-apply ordering** — supply the harness with a
  response that resolves AFTER an explicit gen advance. Assert: the
  supersession check fires BEFORE any field is written to the graph.
  Use a graph fingerprint comparison: pre-resolve fingerprint equals
  post-resolve fingerprint when discarded. (BS4)

### B.6 Cross-check

- **BS1, BS2** covered in existing A-Test-2; not duplicated.
- **BR3** (orphan scenarioId) — design choice: hard error, logged
  warning, or silent ignore? B-Test-1 asserts "logged warning" —
  flag for design discussion if intent is different.
- **BE3** (partial response) — design choice: same. Assert what's
  intended; if intent isn't recorded, this is a design surface
  doc 73a should pin.
- **BE5 added on cross-check** — orphan edge_uuid silent skip
  (current code behaviour); folded into B-Test-3.

### B.7 Layer B summary

**Three new tests** (B-Test-1, B-Test-2, B-Test-3) plus **two
subcases extending A-Test-2**. All enumerated routing,
field-mapping, edge-case, and arrival-side supersession failure
modes covered.



## D — Pack lifecycle (extract → store → recompose)

### D.1 What does this layer actually do?

Three discrete operations during a regen cycle:

1. **Extract** a per-scenario diff pack from that scenario's working
   graph against (BASE + layers below) — `extractDiffParams`
   ([GraphParamExtractor.ts](graph-editor/src/services/GraphParamExtractor.ts)).
2. **Store** the diff pack as `scenario.params` in IndexedDB.
3. **Recompose** on later read — `applyComposedParamsToGraph` overlays
   packs in stack order onto BASE for analysis-prep / display
   ([CompositionService.ts](graph-editor/src/services/CompositionService.ts)).

Boundary: the *timing* of when extraction fires relative to CF apply
belongs to Layer E (async lifecycle). Layer D is purely about the
contents and round-trip fidelity of the pack itself, given that a
working graph exists at extraction time.

### D.2 Enumerate concrete failure modes

**Extract coverage (DX)**:

- **DX1**: A field present in the contract (doc 73a §8) is in the
  working graph but `extractEdgeParams` doesn't pull it — silently
  dropped from packs.
- **DX2**: `extractDiffParams`'s gate logic excludes a field-family
  from the diff when only a non-`p.mean` field has changed (the
  historical Defect 3b — `if (modifiedParams.p?.mean !== undefined)`
  shape that doc 73a Stage 2 fixes).
- **DX3**: The diff includes a field that's IN the excluded list of
  the contract (`p.model_vars[]`, `p._posteriorSlices`,
  `p.fit_history[]`, retrieval metadata, config) — silently
  widening the pack.
- **DX4**: The diff records a stale value because extract reads from
  a cached snapshot rather than the live working graph.
- **DX5**: Floating-point comparison epsilon is too loose — real
  changes register as no-change and get dropped.
- **DX6**: Floating-point comparison epsilon is too tight — noise
  from previous round-trips registers as change and pollutes the
  pack.
- **DX7**: `extractDiffParams` BASE argument is `null` — function
  must handle this without crashing and return the full working
  params as the diff.

**Store / persistence (DS)**:

- **DS1**: IndexedDB write fails silently — pack is lost.
- **DS2**: The persisted pack is mutated in memory after write but
  before reload (cache vs. IDB drift).
- **DS3**: Pack serialisation drops fields (e.g. via JSON round-trip
  with non-serialisable values).
- **DS4**: Two scenarios' packs are written to the same IDB key
  (cross-scenario corruption).

**Recompose (DR)**:

- **DR1**: A field present in the pack is NOT replayed by
  `applyComposedParamsToGraph` — silently dropped on rebuild (the
  historical Defect 3b — compositor missing `p.posterior` / `p.n` /
  `conditional_p` per doc 73a Stage 2).
- **DR2**: `conditional_p` replay TODO no-op landed without actually
  merging values
  ([CompositionService.ts:210-216](graph-editor/src/services/CompositionService.ts)
  historical defect).
- **DR3**: Compositor uses deep merge where shallow merge is
  intended (or vice versa) — accidentally inherits or overwrites
  nested fields.
- **DR4**: Layer order is wrong — later scenarios applied before
  earlier ones, or BASE applied last instead of first.
- **DR5**: `null` semantics in the pack (which doc 73a notes as
  "Null values remove keys") aren't honoured by the compositor.
- **DR6**: The recomposed graph carries an UNINTENDED field that
  wasn't in BASE or any pack (extraction artefact, deep-clone bug,
  type coercion).
- **DR7**: Compositor's `JSON.parse(JSON.stringify(graph))` deep-clone
  ([CompositionService.ts:153](graph-editor/src/services/CompositionService.ts))
  drops `Date`, `undefined`, `Symbol`, `function` values silently.

**Round-trip fidelity (DT)**:

- **DT1**: For some field, `extract → store → recompose` produces a
  value that differs from the working graph original (full
  round-trip not byte-stable).
- **DT2**: For an excluded field, the recomposed graph carries it
  anyway because BASE has it (correct) — but the pack must NOT
  carry it.
- **DT3**: A field that should be inherited from BELOW after a
  scenario doesn't override it isn't (or vice versa — pack falsely
  overrides).

### D.3 Test level for each

- **DX1-DX7, DR1-DR7, DT1-DT3**: pure function behaviour.
  **Unit**-testable on `extractEdgeParams`, `extractDiffParams`,
  `applyComposedParamsToGraph`, `composeParams`.
- **DS1-DS4**: integration with the IDB layer.

### D.4 Group into the minimum test set

Three orthogonal concerns:

- DX (extract): one unit test against `extractEdgeParams` +
  `extractDiffParams` with sentinel inputs covering every contract
  field as a separate subcase.
- DR (recompose): one unit test against `applyComposedParamsToGraph`
  + `composeParams` with sentinel packs for every contract field.
- DT (round-trip): one integration test that runs `extract →
  applyComposed → rebuilt`, asserting byte-equality on the contract.
- DS (store): one focused IDB test for write/read fidelity.

Result: **four tests** for Layer D. DX and DR could merge into the
round-trip test (DT), but separating them adds diagnostic value: a
DT failure tells you "round-trip broken"; DX/DR tell you "broken at
extract" vs. "broken at recompose". Keep them separate.

The historically-bitten cases (DX2, DR1, DR2) are folded into DX and
DR as named subcases — they're the regressions that prompted Stage 2
in doc 73a.

### D.5 Concrete tests

#### D-Test-1: `extractDiffParamsContractCoverage.test.ts` (Vitest, unit)

**Inputs**: a sentinel BASE graph carrying baseline values for every
contract field. A sentinel WORKING graph that mutates ONE contract
field at a time (one subcase per field). Both graphs use distinct
sentinel values per field per Stage 0B sentinel ranges.

**Subcases / assertions** (one per contract field):

- For each contract field F, modify only F on the working graph
  (leaving `p.mean` and other fields equal to BASE). Call
  `extractDiffParams(working, base)`. Assert F appears in the diff
  with the working value. (DX2 — diff gate covers all contract
  fields, not just `p.mean`)
- For every excluded field E (`p.model_vars[]`, `p._posteriorSlices`,
  `p.fit_history[]`, `p.evidence.retrieved_at`,
  `p.latency.latency_parameter`), set E to a distinct sentinel on
  the working graph. Call extract. Assert E does NOT appear in the
  diff. (DX3)
- Set `p.mean` on working to a value `1e-12` away from BASE. Call
  extract. Assert `p.mean` does NOT appear in the diff (within
  epsilon). (DX5/DX6)
- Set `p.mean` on working to a value `1e-6` away from BASE. Call
  extract. Assert `p.mean` DOES appear. (DX5/DX6 — boundary)
- Modify a node's `entry.entry_weight` and a node's `case.variants`
  independently; assert each appears correctly. (DX1)
- Working graph is `Object.freeze`'d before the call — function does
  not throw and returns a fresh diff object (no mutation of working).
  (partial DX4 — extract is read-only)
- BASE argument is `null`; function returns the full working params
  as the diff, without throwing. (DX7)

**Catches**: DX1, DX2, DX3, DX5, DX6, DX7, partial DX4.

**Does NOT catch**: store layer (DS), recompose (DR), full round-trip
(DT).

#### D-Test-2: `compositorReplayCoverage.test.ts` (Vitest, unit)

**Inputs**: a sentinel BASE graph. Per-field sentinel packs, one
per contract field, that override only that field.

**Subcases** (one per contract field):

- For each contract field F, build a pack with only F set to a
  sentinel value. Call `applyComposedParamsToGraph(base, pack)`.
  Assert F lands at the right location in the rebuilt graph with the
  sentinel value. (DR1)
- `conditional_p` subcase — pack has
  `conditional_p['cond_X'] = {p: {mean: 0.5}, posterior: {alpha: 999, beta: 111}}`.
  Rebuilt graph's `conditional_p` array contains the merged
  condition. Posterior fields landed correctly (catches DR2 TODO
  no-op).
- `p.evidence.*` shallow-merge subcase — BASE has
  `p.evidence.{n: 100, k: 50}`; pack has `p.evidence.{n: 200}`.
  Rebuilt graph has `{n: 200, k: 50}` (n overridden, k inherited).
  (DR3)
- Layer-order subcase — three packs (P1, P2, P3) all set `p.mean`
  to distinct values; compose in order [P1, P2, P3]. Rebuilt has
  P3's value. Compose in [P3, P2, P1]; rebuilt has P1's value. (DR4)
- Null subcase — pack has `edges: {edge_X: null}` (per doc 73a "Null
  values remove keys"). Rebuilt graph removes edge_X's overlay (or
  whatever the documented null semantics is — assert the documented
  behaviour). (DR5)
- Excluded-field subcase — pack contains `p.fit_history` (which it
  shouldn't). Compositor should either error, ignore, or warn —
  assert the documented behaviour. NOT silently merge it onto the
  rebuilt graph. (DR6)
- Deep-clone subcase — fixture validity check: assert no contract
  field in any fixture uses `Date`, `undefined`, `Symbol`, or
  `function` types (which `JSON.parse(JSON.stringify(...))` would
  silently drop). If any do, document the exclusion explicitly. (DR7)

**Catches**: DR1, DR2, DR3, DR4, DR5, DR6, DR7.

**Does NOT catch**: extract (DX), store (DS), full round-trip
semantics (DT).

#### D-Test-3: `scenarioPackContractRoundtrip.test.ts` (Vitest, integration)

(Already named in doc 73a §16 Stage 2.)

**Inputs**: a sentinel scenario graph carrying distinct values for
every contract field (per Stage 0B sentinels). BASE graph at default
values.

**Assertions**:

- Run `extract = extractDiffParams(working, base); rebuilt = applyComposedParamsToGraph(base, extract)`.
  Assert `rebuilt` is byte-equal to `working` on every contract
  field. (DT1)
- For every excluded field E, assert `rebuilt[E]` equals `base[E]`
  (inherited from BASE, not from any pack). (DT2)
- Run with two scenarios A (with pack P_A) and B (with pack P_B).
  Compose for A: BASE + P_A. Compose for B: BASE + P_A + P_B (B
  above A in stack). Assert B's recomposition correctly inherits
  unchanged fields from P_A and overrides where P_B specifies. (DT3)
- Run with the `conditional_p` shape from D-Test-2 to verify
  round-trip for nested records.
- Run the round-trip TWICE
  (`extract → recompose → extract → recompose`). Assert both
  round-trips produce identical packs and identical rebuilt graphs
  (idempotency).

**Catches**: DT1, DT2, DT3, plus regression-witness for DX2 / DR1 /
DR2 acting together.

**Does NOT catch**: store layer (DS), individual extract or recompose
defects in isolation (D-Test-1 / D-Test-2 catch those
diagnostically).

#### D-Test-4: `scenarioPackPersistence.test.ts` (Vitest, integration)

**Inputs**: a real or in-memory IDB instance (per existing test
infrastructure). Sentinel scenario packs.

**Subcases**:

- Write S1's pack to IDB; read back; assert byte-equal. (DS3 —
  serialisation fidelity)
- Write S1's pack and S2's pack with distinct keys; read both back;
  assert no cross-contamination. (DS4)
- Mutate the pack object in memory after the IDB write; re-read
  from IDB; assert the IDB value reflects the original write, not
  the post-write mutation. (DS2)
- Simulate an IDB write failure (mock the put to reject); assert
  the failure is surfaced (logged at error level, exception
  propagated, or whatever the documented contract is — NOT silently
  swallowed). (DS1)

**Catches**: DS1, DS2, DS3, DS4.

**Does NOT catch**: extract (DX), recompose (DR), round-trip
semantics (DT).

### D.6 Cross-check

- **Stage-overlap**: `scenarioPackContractRoundtrip.test.ts`
  (D-Test-3) is already in doc 73a §16 Stage 2. D-Test-1 and
  D-Test-2 are new but match the gaps the sidecar's Layer D analysis
  surfaces.
- **DX7** added on cross-check (null BASE handling).
- **DR7** added on cross-check (deep-clone type drops).
- **Out of scope acknowledged**:
  - Performance of round-trip — not a correctness concern.
  - IDB schema migration — handled by separate IDB persistence tests
    outside doc 73a.

### D.7 Layer D summary

**Four tests** (D-Test-1, D-Test-2, D-Test-3, D-Test-4) cover all
enumerated extract, recompose, round-trip, and persistence failure
modes. DX7 and DR7 added on cross-check.



## E — Async lifecycle (slow CF, supersession, ordering)

### E.1 What does this layer actually do?

Layer E is the temporal coordination layer. It concerns the
*ordering and timing* of async operations during a regen cycle:

1. **Race** the CF response against the 500ms fast-path deadline.
2. **Choose** fast-path (CF result arrived in time → merge into the
   FE topo apply for a single render) vs. slow-path (FE topo applies
   its provisional values; CF lands later via a background handler).
3. **Sequence** pack extraction so it runs only AFTER CF has resolved
   (applied, superseded, or failed) — the doc 73a Stage 4 fix.
4. **Manage** in-flight CF promises across concurrent regen cycles or
   across rapid-fire user actions.

Boundary: dispatch contents (Layer A), response apply correctness
(Layer B), and per-scenario state mechanics (Layer A AS) are tested
elsewhere. Layer E is purely about **when** things happen and how
concurrent in-flight state is resolved.

### E.2 Enumerate concrete failure modes

**Fast/slow path race (EF)**:

- **EF1**: CF returns at 250ms (well within 500ms) but the fast-path
  code path is not taken — slow-path apply fires anyway, causing
  two renders.
- **EF2**: CF returns at 600ms (past 500ms) but the fast-path code
  path treats it as fast — slow-path handler is never registered,
  CF result lands without rendering.
- **EF3**: CF returns at exactly 500ms (boundary) — behaviour is
  unspecified or non-deterministic.
- **EF4**: Fast-path takes the CF response but ALSO leaves a
  slow-path handler armed; CF result applied twice.
- **EF5**: Slow-path handler fires but the response is empty or
  failed; FE topo's provisional values are silently overwritten with
  nothing.
- **EF6**: CF response arrives BEFORE the FE topo apply has even
  fired (network faster than expected). Should fast-path still work,
  or does the FE topo apply gate it? Behaviour must be documented.

**Pack-extraction sequencing (EP)** — the doc 73a Stage 4 fix:

- **EP1**: Pack extraction fires immediately after
  `refreshFromFilesWithRetries` returns, BEFORE CF's slow-path has
  applied. Persisted pack lacks CF-derived fields.
- **EP2**: Pack extraction fires AFTER CF resolves but
  `awaitBackgroundPromises` doesn't actually await *that scenario's*
  CF — only some other promise. False-pass.
- **EP3**: A scenario's regen waits indefinitely because the CF
  promise was never registered with the orchestrator (lost handle).
- **EP4**: Pack extraction fires after a *superseded* CF resolves,
  against the now-superseded graph state — pack records stale
  CF-derived values.
- **EP5**: Pack extraction fires after a *failed* CF — but should
  the pack still be extracted (against pre-CF state) or skipped?
  Ambiguous if not pinned.
- **EP6**: Pack extraction reads against the working graph at the
  moment CF settled, not the moment of extract — but if a UI edit
  intervened between CF apply and extract, what's captured? Edge
  case requiring pinned semantics.

**Concurrent regen cycles (EC)**:

- **EC1**: User clicks "refresh all" twice rapidly. Cycle 2 starts
  before cycle 1 completes. Cycle 1's in-flight CF responses race
  with cycle 2's. Per-scenario supersession discards cycle-1
  responses — but does the orchestrator know cycle 1's `await`
  chain can complete safely?
- **EC2**: Cycle 1 dispatches S1; before S1's CF returns, S1 is
  deleted by user; cycle 2 starts and doesn't include S1. Cycle 1's
  S1 CF response arrives — orphan handling per Layer B BR3, but the
  orchestrator's await chain may still be waiting on S1.
- **EC3**: Two independent triggers fire simultaneously (e.g.
  "refresh all" + a single-scenario regen for S2). Both want to
  dispatch S2. Two in-flight CF for S2; per-scenario supersession
  discards the older. But does the orchestrator get confused about
  which `await` belongs to which trigger?

**Promise lifecycle (EL)**:

- **EL1**: A CF promise is awaited but never resolves (BE timeout,
  dropped connection) — regen cycle hangs indefinitely.
- **EL2**: A CF promise resolves but its `then`/`catch` handler
  throws — error is swallowed, regen never completes.
- **EL3**: Aborted CF (tab close, navigation) leaves an orphan
  promise that resolves later against a destroyed React context —
  silent error or memory leak.

### E.3 Test level for each

- **EF1-EF6**: integration. Deferred-CF harness with controlled
  resolve timing.
- **EP1-EP6**: integration. Same harness, plus inspection of pack
  contents post-regen.
- **EC1-EC3**: integration. Trigger overlapping regen cycles via
  the harness; observe in-flight state and final settled state.
- **EL1-EL3**: integration with timeout / abort signals. Some are
  edge cases that may need stub timeouts.

### E.4 Group into the minimum test set

Three orthogonal concerns + one edge-case bucket:

- EF (fast/slow race): one timing test with controllable resolve
  delays.
- EP (pack-extraction sequencing): one test asserting pack contents
  reflect the resolved CF state regardless of fast/slow path.
- EC (concurrent cycles): one test for cycle-vs-cycle interference.
- EL (promise lifecycle edge cases): one focused test for hanging /
  aborted / throwing promises.

Result: **four tests** for Layer E.

EF and EP are tightly coupled in practice (EP1 is exactly the
slow-CF + early-extract race), but separating them adds diagnostic
value: EF tests "did the right path fire?"; EP tests "did
extraction wait for the right thing?". An EF failure is a routing
issue; an EP failure is an awaiting issue. Different fixes.

### E.5 Concrete tests

#### E-Test-1: `cfFastSlowPathSentinel.test.ts` (Vitest, integration)

(Already named in doc 73a §16 Stage 4 with weaker description —
strengthen here.)

**Inputs**: tab with 1 scenario. Deferred-CF harness with
controllable resolve delay.

**Subcases**:

- **Fast path** — harness resolves CF at 100ms (well within 500ms).
  Assert: only ONE `applyConditionedForecastToGraph` call fires
  (fast-path merge), not a separate FE-topo apply followed by a
  slow-path overwrite. Session log entry tagged `fast` (per Layer G
  shape). (EF1)
- **Slow path** — harness resolves CF at 700ms (past 500ms).
  Assert: FE topo apply fires first (provisional values land), then
  slow-path handler fires (CF values land). Two sequential
  `applyConditionedForecastToGraph`-equivalent calls, in order.
  (EF2)
- **Boundary** — harness resolves CF at exactly 500ms. Assert:
  behaviour matches a documented choice (fast OR slow, but
  consistently the same path). NOT non-deterministic. (EF3)
- **Fast-path no double-apply** — harness resolves CF at 100ms.
  Wait an additional 1000ms after fast-path completes. Assert: no
  further apply call fires (slow-path handler was correctly
  disarmed). (EF4)
- **Slow-path empty response** — harness resolves at 700ms with
  `{edges: []}`. FE topo's provisional values landed at 500ms.
  After the empty CF arrives: assert FE topo's values are preserved
  (not overwritten with nothing). Session log entry surfaces empty
  CF as a warning. (EF5)
- **Pre-FE-apply response** — harness resolves CF at 0ms (instantly,
  before FE topo even fires). Assert: documented behaviour holds
  (likely fast-path applies as soon as FE topo runs; assert what's
  intended, not non-determinism). (EF6)

**Catches**: EF1, EF2, EF3, EF4, EF5, EF6.

**Does NOT catch**: pack-extraction sequencing (EP), concurrent
cycles (EC), promise edge cases (EL).

#### E-Test-2: `scenarioRegenerationCfUpsert.test.ts` (Vitest, integration)

(Already named in doc 73a §16 Stage 4. Already has a baseline
assertion; this layer's reasoning sharpens the subcases.)

**Inputs**: tab with N=2 scenarios (S1, S2). Deferred-CF harness
with controllable resolve delay per scenario. Sentinel CF response
payloads with distinct values per scenario.

**Subcases**:

- **Slow CF, awaited correctly** — set S1's CF to resolve at 700ms
  (slow-path). Call `regenerateScenario(S1)`. Assert: the call does
  NOT resolve before CF resolves at 700ms+. After resolution, the
  persisted pack contains the CF-derived sentinel values (proves
  `awaitBackgroundPromises` plumbing works). (EP1)
- **Awaited, but the awaited promise is the wrong one** — set up a
  scenario where TWO promises are in-flight (CF + something else).
  Resolve the "something else" first. Assert: regen does NOT
  resolve yet (must still wait for CF specifically). (EP2)
- **Promise registration** — induce a code path where CF dispatch
  happens but the orchestrator doesn't get the handle. Assert:
  regen detects this (logs error or times out cleanly), does NOT
  hang indefinitely. (EP3)
- **Superseded mid-extraction** — dispatch S1's CF (gen=1). Before
  resolution, dispatch S1 again (gen=2). Resolve gen=1. Assert:
  gen=1's response is discarded (per Layer A AS), AND pack
  extraction does NOT run against gen=1's state. The first regen
  cycle either waits for gen=2 or settles cleanly with the
  documented "superseded" outcome. (EP4)
- **Failed CF, what happens to pack** — set S1's CF to reject at
  200ms. Call `regenerateScenario(S1)`. Assert: regen completes
  (doesn't hang). Pack extraction proceeds against pre-CF graph
  state (or skips entirely — assert documented behaviour). Session
  log records the failure at error level. (EP5)
- **Mid-extract UI edit** — start regen, force CF onto slow-path
  (700ms). Between CF resolution and pack extraction, simulate a
  UI edit on the working graph. Assert: extraction reads against
  the documented graph state (either the post-edit or post-CF
  snapshot). Pin the documented behaviour. (EP6)

**Catches**: EP1, EP2, EP3, EP4, EP5, EP6.

**Does NOT catch**: fast/slow path mechanics (EF), concurrent cycles
(EC), other promise edge cases (EL).

#### E-Test-3: `cfConcurrentRegenCycles.test.ts` (Vitest, integration)

**Inputs**: tab with 2 scenarios (S1, S2). Deferred-CF harness with
explicit promise control (so we can step through commission and
resolution manually).

**Subcases**:

- **Cycle 1 in flight, cycle 2 starts** — call `regenerateAllLive`
  (cycle 1). Before cycle 1's CFs resolve, call `regenerateAllLive`
  again (cycle 2). Cycle 2 dispatches fresh CFs (advancing
  per-scenario gen). Resolve cycle-1 CFs. Assert: cycle-1 responses
  are discarded (gen mismatch). Resolve cycle-2 CFs. Assert:
  cycle-2 responses are applied. Both cycle 1's and cycle 2's
  `await` chains complete cleanly without hanging. (EC1)
- **Scenario deleted between cycles** — cycle 1 dispatches S1 + S2.
  Before cycle 1 resolves, user deletes S1. Cycle 2 starts
  (dispatches S2 only). Resolve cycle-1 S1 CF. Assert: no graph
  mutation (S1 doesn't exist). Cycle-1's `await` chain on S1
  settles cleanly (doesn't hang). (EC2)
- **Trigger interleaving** — call `regenerateAllLive` and immediately
  call `regenerateScenario(S2)` (single-scenario trigger). Both want
  to dispatch S2. Two in-flight S2 CFs. Per-scenario supersession
  discards the older. Assert: both `await` chains complete; final
  S2 state matches the LATER dispatch's response. (EC3)

**Catches**: EC1, EC2, EC3.

**Does NOT catch**: fast/slow path (EF), pack-extraction sequencing
(EP), promise edge cases (EL).

#### E-Test-4: `cfPromiseLifecycleEdgeCases.test.ts` (Vitest, integration)

**Inputs**: tab with 1 scenario. Deferred-CF harness.

**Subcases**:

- **Hanging promise** — harness never resolves the CF promise. Set
  a regen-level timeout in the test (e.g. 5s). Assert: the regen
  call settles with a documented timeout outcome (rejected promise,
  error log) within the timeout window. NOT silently hung. (EL1)
- **Throwing handler** — harness resolves CF normally but the apply
  handler throws an Error mid-apply. Assert: the error propagates
  to the regen caller (or is logged at error level), the working
  graph is left in a documented state (either rolled back to
  pre-apply or marked as partially-applied with a flag), and
  `await` chains do not hang. (EL2)
- **Aborted dispatch** — start the regen, then trigger an abort
  signal (simulating tab close / navigation). Resolve the CF
  promise after abort. Assert: no graph mutation occurs (no
  React-context use-after-destroy), no orphan errors thrown, no
  memory leak (the promise's then-handler completes silently or is
  unregistered). (EL3)

**Catches**: EL1, EL2, EL3.

**Does NOT catch**: any other concern.

### E.6 Cross-check

- **Cross-stage cohesion**: Layer E inherits the per-scenario
  supersession state from Layer A. EP4 explicitly cross-checks by
  re-running the supersession-discard scenario and asserting
  pack-extraction also respects the discard.
- **EP6** added on cross-check (mid-extract UI edit semantics).
- **EF6** added on cross-check (response arrives before FE topo
  apply).
- **Ordering of dispatches within a cycle**: per doc 73a §3.13,
  response order is non-load-bearing; dispatch order similarly. No
  Layer E test needed for dispatch order. If a future change makes
  order load-bearing, that's a regression to catch elsewhere.
- **Out of scope**:
  - BE timeout configuration (network layer concern).
  - Browser-tab-suspend behaviour (browser concern; out of doc 73a
    scope).

### E.7 Layer E summary

**Four tests** (E-Test-1, E-Test-2, E-Test-3, E-Test-4) cover all
enumerated fast/slow-path, pack-extraction sequencing,
concurrent-cycles, and promise lifecycle failure modes. EP6 and EF6
added on cross-check.



## F — Cleanup integrity (post-cleanup stage in doc 73b)

### F.1 What does this layer actually do?

Doc 73b's cleanup stage (Stage 6) removes mechanisms that the new
architecture renders dead: the `_posteriorSlices` graph-side stash,
`reprojectPosteriorForDsl` and its projection helpers, and
(potentially) `posterior.*` / `latency.posterior.*` writes from
`mappingConfigurations.ts` if no FE display path still consumes
them. Layer F's job is to make removal **stick** — to prevent silent
re-introduction by future commits and to detect any consumer that
quietly depended on the removed surface and now reads stale or
undefined state.

This layer is mostly **static analysis** (grep / AST) plus a small
set of "reads still work" integration tests. It's narrow.

### F.2 Enumerate concrete failure modes

**Re-introduction (FR)**:

- **FR1**: `_posteriorSlices` is accidentally re-introduced as a
  write target by some new code path.
- **FR2**: `reprojectPosteriorForDsl` (or `projectProbabilityPosterior`
  / `projectLatencyPosterior` / `resolveAsatPosterior`) is referenced
  by a new caller after the function was supposedly removed (broken
  import / runtime error in production).
- **FR3**: `posterior.*` / `latency.posterior.*` writes by
  `mappingConfigurations.ts` (if removed) are re-introduced.
- **FR4**: A test fixture or seed graph still carries a
  `_posteriorSlices` field on persistent edges — masking the
  removal.

**Silent-consumer regressions (FC)**:

- **FC1**: An FE display surface that read `edge.p.posterior.alpha`
  directly (e.g. an edge property panel, a Bayesian posterior card)
  silently shows blank or stale values because the field is no
  longer maintained on persistent graph state.
- **FC2**: An FE chart that read from `edge.p.latency.posterior.mu_mean`
  shows a default-zero curve instead of the right curve.
- **FC3**: A non-CF code path (e.g. a per-edge inspection tool, a
  bayes-fit-quality badge) silently breaks because its data source
  was removed.
- **FC4**: Share-bundle restore (`useShareBundleFromUrl`) had its
  own read path that touched `_posteriorSlices` — silent regression
  on link-restore flow.

**Schema integrity (FS)**:

- **FS1**: Persistent graph files in IDB or on disk still contain
  `_posteriorSlices` data — read code dies on parse, or carries dead
  weight forever.
- **FS2**: Schema definitions (TypeScript types, JSON schemas) still
  declare the removed fields — type-safe code that "should have"
  caught the removal doesn't.

### F.3 Test level for each

- **FR1, FR2, FR3**: source-grep gates. Static, fast, CI-enforced.
- **FR4**: fixture audit. Static.
- **FC1, FC2, FC3, FC4**: integration / Playwright. The FE display
  surfaces must actually render correctly post-removal.
- **FS1**: integration with IDB; could be a migration / seed-cleanup
  check.
- **FS2**: TypeScript compile-time check (already enforced by
  `tsc`); the test pins that types are removed in the same commit
  as the writes.

### F.4 Group into the minimum test set

Three concerns:

- **Re-introduction** (FR1-FR4): one CI-enforced grep gate
  (multi-pattern). Single test file.
- **Silent-consumer regressions** (FC1-FC4): one Playwright spec
  that walks every FE surface that used to read the removed fields
  and asserts each renders correctly.
- **Schema/fixture integrity** (FS1, FS2): one cleanup audit that
  runs as a CI check.

Result: **three tests** for Layer F. All small. Most are static
checks.

### F.5 Concrete tests

#### F-Test-1: `cleanupGrepGates.test.ts` (Vitest, static)

**What it does**: runs `grep -r` (or equivalent in Node) over the
source tree for symbols that should not appear in production code
after doc 73b's cleanup stage. Asserts the count of matches is zero outside of
explicitly-allowed locations (the test file itself, the cleanup
commit message, archived docs).

**Patterns** (one assertion per pattern):

- `_posteriorSlices` in `graph-editor/src/**/*.ts`,
  `graph-editor/src/**/*.tsx`, `graph-editor/lib/**/*.py` — zero
  matches outside `__tests__/`. (FR1)
- `reprojectPosteriorForDsl` in any production source file — zero
  matches outside `__tests__/`. (FR2)
- `projectProbabilityPosterior`, `projectLatencyPosterior`,
  `resolveAsatPosterior` — zero matches outside `__tests__/`. (FR2)
- If doc 73b's cleanup stage removes the mapping-config posterior writes:
  `targetField:.*'p.posterior.*'`,
  `targetField:.*'p.latency.posterior.*'` in
  `mappingConfigurations.ts` — zero matches. (FR3)

**Catches**: FR1, FR2, FR3.

**Does NOT catch**: silent consumer breakage (FC), persistent
fixture data (FR4 / FS1).

#### F-Test-2: `feDisplayAfterPosteriorRemoval.spec.ts` (Playwright)

**What it does**: loads a real graph fixture in the browser. Walks
each FE surface that historically read `edge.p.posterior` or
`edge.p.latency.posterior` directly. Asserts each surface renders
correct, non-blank values.

**Surfaces to walk** (each a subcase):

- Edge property panel — open an edge with a known Bayesian fit.
  Assert the displayed alpha/beta/HDI values are correct. The data
  must come from `model_vars[bayesian]` post-Stage-5b. (FC1)
- Bayesian posterior card / `BayesPosteriorCard` — open the card.
  Assert it displays HDI bounds, ESS, rhat correctly. (FC1)
- Model rate chart / fan band — open a chart that historically
  rendered the posterior fan. Assert the band has non-zero width
  and matches the model_vars-derived values. (FC2)
- Model curve overlay on cohort-maturity chart — assert the overlay
  matches the engine output (which now reads from model_vars). (FC2)
- `ModelVarsCards` or per-source display — the bayesian card shows
  the right per-context data. (FC3)
- Share-bundle restore — open a share link with a known scenario;
  assert the restored display matches a fresh view of the same
  scenario. (FC4)

**Catches**: FC1, FC2, FC3, FC4.

**Does NOT catch**: re-introduction (FR), schema integrity (FS).

#### F-Test-3: `cleanupSchemaAudit.test.ts` (Vitest, static + IDB)

**What it does**: a small set of static and IDB-runtime checks.

**Subcases**:

- **Fixture audit** (FR4) — load every graph fixture in
  `graph-editor/src/services/__tests__/__fixtures__/` and assert no
  edge has a `_posteriorSlices` field present. If a fixture was
  generated with stash data, fail and surface the fixture path.
- **TypeScript types** (FS2) — assert that the `EdgeP` (or
  equivalent) type definition does NOT include `_posteriorSlices`
  as a field. Done via a `expectType` / `tsd`-style compile-time
  assertion that fails if the field is declared.
- **IDB persisted state** (FS1) — load a fresh IDB-backed fixture
  (representing a reload scenario). Assert that no edge carries
  `_posteriorSlices`. If old data is found in IDB, the migration /
  seed-cleanup logic for the cleanup release must scrub it; this
  test pins that requirement.

**Catches**: FR4, FS1, FS2.

**Does NOT catch**: production source re-introduction (F-Test-1),
display regressions (F-Test-2).

### F.6 Cross-check

- All three concerns (FR, FC, FS) covered by the three tests.
- **Stage-overlap**: F-Test-1's grep gates correspond to the
  cleanup-stage entry condition in doc 73b (the pinned grep
  classification table). This sidecar
  formalises them as a named test artefact.
- **Migration concern**: if existing IDB-backed graphs (from before
  doc 73b's cleanup stage) carry `_posteriorSlices`, what happens on
  first read? Two options: (a) migration code scrubs the field on
  load; (b) the field is silently ignored. F-Test-3's IDB subcase
  pins whichever is intended; if option (b), the field lingers in
  IDB forever (wasteful but harmless). Flag for design decision if
  not pinned in doc 73b.
- **Out of scope**: removal of fields from the parameter file format
  itself (that's a separate parameter-system cleanup, not doc 73b's
  cleanup-stage scope).
- **FC4** added on cross-check (share-bundle restore).

### F.7 Layer F summary

**Three tests** (F-Test-1, F-Test-2, F-Test-3) cover all enumerated
re-introduction, silent-consumer-regression, and schema-integrity
failure modes. FC4 added on cross-check.



## G — Observability (session log shape, levels)

### G.1 What does this layer actually do?

The session log is the user-facing trace of what the system did with
their data. For CF, every dispatch and resolution should produce
structured log entries that let:

- A Business Analyst understand what CF did per regen ("CF for
  scenario A returned in 320ms with 5 conditioned edges").
- A developer / agent diagnose a CF regression ("CF for scenario A
  was superseded by scenario B's commission at gen=3").
- An automation harness assert lifecycle visibility (cross-cutting
  Layer H consumes log shape to verify Layer E timing).

Layer G's job: ensure the log entries for the CF lifecycle are
present, structurally stable, level-appropriate, and carry the
structured fields downstream consumers depend on.

### G.2 Enumerate concrete failure modes

**Coverage gaps (GC)** — entries that should appear but don't:

- **GC1**: A new branch in CF flow is added but no log entry. The
  new branch is invisible.
- **GC2**: A CF lifecycle stage that ought to log doesn't —
  commission, fast-path resolve, slow-path resolve, supersession
  discard, empty response, failure, apply, upsert. Missing any
  breaks lifecycle traceability.
- **GC3**: A log entry exists but is conditional in a way that drops
  it for some scenarios (e.g. only logs if `edges.length > 0`).
- **GC4**: BA-facing scenario CF verdict toast (per
  `finaliseCfToast`) silently drops cases — terminal op missing for
  some outcomes.

**Shape drift (GS)**:

- **GS1**: A log message template changes wording in a way that
  breaks downstream parsers / test snapshots.
- **GS2**: Required structured fields (e.g. `scenarioId`,
  `generation`, `cf_mode`, `elapsedMs`) absent from a log entry that
  historically carried them.
- **GS3**: Tag (the second arg to `addChild`, e.g.
  `'CONDITIONED_FORECAST'`) changes — downstream filters break.
- **GS4**: Log entry hierarchy changes — a child that should be
  under a CF batch op is logged as a top-level entry.

**Level drift (GL)**:

- **GL1**: An outcome that should be `info`/`success` is logged at
  `debug` — invisible to default users, regression masked.
- **GL2**: An outcome that should be `warning` (e.g. CF returned
  empty) is logged at `info` — fails to draw attention.
- **GL3**: An outcome that should be `error` (e.g. CF failed) is
  logged at `warning` — silent failure pattern.
- **GL4**: A genuinely-routine event is logged at `error`
  (cry-wolf), training users to ignore real errors.

**Threshold and persistence (GT)**:

- **GT1**: `trace`/`debug` entries persist past `endOperation`
  because the parent op never called `endOperation` (handler
  exception swallowed it).
- **GT2**: `isLevelEnabled('trace')` gate around heavy payload
  allocation is missing — heavy `JSON.stringify` runs unconditionally
  even when threshold is `info`.
- **GT3**: `getDiagnosticLoggingEnabled()` returns true at the wrong
  threshold — wrong server-side diagnostic flag set.

**Ordering (GO)**:

- **GO1**: Log entries for a single CF lifecycle appear out of
  causal order (e.g. "CF resolved" before "CF commissioned") —
  confuses readers debugging.
- **GO2**: Children of a CF op appear under a different parent op
  (e.g. CF child registered under a previous, already-ended op).

### G.3 Test level for each

- **GC1-GC4**: integration. Run a sentinel CF lifecycle through the
  harness; capture the log; assert expected entries present.
- **GS1-GS4**: integration with structural-snapshot assertion (not
  raw text snapshot).
- **GL1-GL4**: integration; level assertion per outcome.
- **GT1**: covered by existing `sessionLogService` tests; not
  duplicated.
- **GT2**: static gate (extension to F-Test-1).
- **GT3**: covered by existing `sessionLogService` tests; not
  duplicated.
- **GO1, GO2**: integration; assert relative ordering of children
  within a CF op.

### G.4 Group into the minimum test set

Two concerns:

- **Shape + coverage + ordering** (GC, GS, GO): one test that runs
  sentinel CF lifecycles (one per outcome — fast, slow, superseded,
  empty, failed) and asserts the log structure.
- **Level invariance** (GL1-GL4): one focused test that asserts the
  level-vs-outcome contract.

GT failure modes are largely covered by existing
`sessionLogService` tests — Layer G should NOT duplicate, but
**should** include one CF-call-site grep gate for `isLevelEnabled`
discipline (added as a subcase to F-Test-1).

Result: **two tests** for Layer G plus **one subcase added to
F-Test-1's grep gates** for GT2.

### G.5 Concrete tests

#### G-Test-1: `cfSessionLogShape.test.ts` (Vitest, integration)

(Already named in doc 73a §16 Stage 3.)

**Inputs**: deferred-CF harness + access to
`sessionLogService.getEntries()`. Sentinel scenarios.

**Subcases — one per CF outcome path**:

- **Fast-path apply** — harness resolves CF at 100ms with non-empty
  edges. Assert under the parent regen op, the expected CF children
  exist in order:
  1. `tag='CONDITIONED_FORECAST'`, level `info`, message template
     matches `/Conditioned forecast started/`, structured field
     `scenarioId` present, `generation` present.
  2. `tag='CONDITIONED_FORECAST'`, level `info`, message template
     matches `/applied in \d+ms.*fast path/`, structured fields
     `scenarioId`, `generation`, `elapsedMs`, `edges` (array of
     edge summaries) present.
- **Slow-path apply** — harness resolves CF at 700ms. Expected
  children in order:
  1. Commission `info`.
  2. FE topo apply (boundary with another layer's logs — assert
     presence, not detail).
  3. CF subsequent overwrite, `info` level, message matches
     `/subsequent overwrite applied/`.
- **Superseded** — dispatch CF (gen=1), re-dispatch (gen=2) before
  resolution, resolve gen=1. Expected children:
  1. Commission `info` (gen=1).
  2. Commission `info` (gen=2).
  3. Discard for gen=1, `warning` level, message matches
     `/result discarded.*stale gen \d+ < \d+/`, structured fields
     `scenarioId`, `generation`, `currentGeneration`.
- **Empty response** — harness resolves with `{edges: []}`. Expected
  child: `warning` level, message matches `/returned empty array/`,
  structured fields `scenarioId`, `elapsedMs`.
- **Failed CF** — harness rejects with `Error('test failure')`.
  Expected child: `error` level, message matches
  `/Conditioned forecast failed:/`, structured fields `scenarioId`,
  error message text.
- **Verdict toast** (GC4) — for each outcome above, assert the
  per-scenario terminal op (the `scenario-cf` toast op per
  SCENARIO_SYSTEM_ARCHITECTURE.md) is emitted with the right verdict
  string (e.g. `"<ScenarioName> · CF 320ms (5/8 conditioned)"` for
  success, `"· CF failed"` for failure, `"· CF superseded"` for
  superseded).

**For all subcases**: assert the children appear under the correct
parent op (the regen batch op for that scenario), in causal order,
with no out-of-order entries. (GO1, GO2)

**Catches**: GC1, GC2, GC3, GC4, GS1, GS2, GS3, GS4, GO1, GO2.

**Does NOT catch**: level drift on outcomes that aren't in the
sentinel set (GL — covered in G-Test-2), threshold mechanics (GT —
covered by existing sessionLogService tests).

#### G-Test-2: `cfLogLevelInvariance.test.ts` (Vitest, integration)

**What it does**: focused on the level-vs-outcome contract. For each
documented CF outcome, assert the log level is the documented one
and not drifted.

**Inputs**: deferred-CF harness + log capture.

**Subcases**:

- Commission → `info`.
- Fast-path apply success → `info`.
- Slow-path apply success → `info`.
- Superseded discard → `warning`. (GL2 — must not drop to `info`)
- Empty response → `warning`. (GL2)
- Failed CF (rejected promise / HTTP error) → `error`. (GL3 — must
  not drop to `warning`)
- Apply error (CF response was OK but `applyConditionedForecastToGraph`
  threw) → `error`. (GL3)
- Routine internal event (e.g. "promise registered") that should be
  invisible by default → `debug` or `trace`. NOT `info`/`error`.
  (GL1 catches the wrong-direction drift; GL4 catches `error`
  overuse)

**For each subcase**: assert level matches the documented value; if
the documented value is wrong (cry-wolf at `error` for routine
events, or `info` for true failures), the test fails and surfaces
the mismatch.

**Catches**: GL1, GL2, GL3, GL4.

**Does NOT catch**: shape / coverage (G-Test-1 covers those).

#### CF call-site audit — extension to F-Test-1

Add one pattern to the grep gates: every `addChild(*, 'trace', ...)`
call in `fetchDataService.ts` and `conditionedForecastService.ts` is
preceded by an `isLevelEnabled('trace')` guard within the same
scope. AST walker preferred but a regex over textual context is
acceptable for small files. (GT2)

### G.6 Cross-check

- All four buckets (GC, GS, GL, GO) covered. GT2 folded into
  existing static gate. GT1, GT3 deferred to existing
  sessionLogService tests.
- **Cross-stage cohesion**: G-Test-1's structural snapshot is the
  reference Layer H's H-Test-1 indirectly relies on for "session
  log records the right lifecycle outcome" assertions. Layer G
  defines the shape; Layer H asserts behaviour matches the shape.
- **Open question for design**: when CF is dispatched in batch
  (e.g. `regenerateAllLive` over 3 scenarios), should the parent
  op be ONE batch op with 3 sets of CF children, or 3 separate
  per-scenario ops? Affects G-Test-1's parent-op-correctness
  assertion. Pin in doc 73a §16 if not already.
- **GC4 added on cross-check** (BA-facing verdict toast).

### G.7 Layer G summary

**Two tests** (G-Test-1, G-Test-2) plus one subcase added to
F-Test-1 (GT2 isLevelEnabled audit). Covers all enumerated coverage,
shape, level, and ordering failure modes. GT1/GT3 deferred to
existing sessionLogService tests; GC4 added on cross-check.



## H — End-to-end (browser + cross-cutting integration)

### H.1 What does this layer actually do?

Layer H exercises the complete CF transaction across ALL layers
using **real implementations at every seam** — no per-layer mocks.
Two modes:

1. **Cross-cutting Vitest** — real FE services wired together,
   deferred-CF harness for the BE boundary, sentinel inputs
   end-to-end. Catches seam-level wiring failures that per-layer
   mocks hide.
2. **Real Playwright browser** — actual editor in a browser, real
   React render cycle, real IDB, optional real BE. Catches
   browser-specific failures and persistence/reload integrity.

The role of Layer H is precisely the seam-catching the per-layer
tests cannot perform: each per-layer test uses mocks at its
boundaries; Layer H replaces those mocks with the real adjacent
implementations to prove the seams actually wire up.

### H.2 Enumerate concrete failure modes

**Cross-layer seam failures (HC)**:

- **HC1**: Layer A dispatches correctly and Layer B's apply fires
  on what A sent — but the apply target graph reference is NOT the
  same reference the working-graph holder reads at extract time.
  Updates land "somewhere" but the pack extracts against a stale
  ref.
- **HC2**: Layer C's derivation produces value X standalone; Layer
  A's dispatch payload carries value Y. Silent serialisation
  mismatch at the C→A seam.
- **HC3**: Layer B's apply succeeds against the working graph;
  Layer D extracts against BASE. But the working graph's React-state
  reference rotated between B and D (a `setGraph` call between
  them). Diff is against the new identity, missing intervening
  writes.
- **HC4**: Layer E's `awaitBackgroundPromises` awaits *a* promise —
  but not the SAME promise instance Layer A's dispatch returned.
  Extract fires before the right CF lands.
- **HC5**: All layers report success, but the chart layer reads
  from a different state shape than what was persisted. Pack
  contents correct; display wrong.
- **HC6**: A field slips through Layer A/B mocks because the mock
  didn't simulate real JSON serialisation — real fetch drops it
  (e.g. function-typed fields, undefined values, BigInt).
- **HC7**: Display/render layer reads from a different source than
  the per-scenario composed graph (e.g. reads the live editor
  graph). All seams correct internally; display wrong because the
  wrong source is read.

**Async commissioning seam (HX)**:

- **HX1**: `regenerateAllLive` enumerates 3 visible scenarios, but
  only 2 actually fire CF dispatch — the loop completed without
  registering one of them. Per-layer cfDispatchCoverage uses the
  harness; harness might be lenient.
- **HX2**: All 3 dispatch, but one's awaited promise resolves with
  a response intended for a different scenario (the dispatch and
  response were paired wrong somewhere in the orchestrator's
  promise plumbing).
- **HX3**: 3 dispatches, 3 responses, but the apply targets are
  mis-mapped — S2's response lands on S1's working graph because
  the orchestrator's per-scenario await keys collided.

**Real-browser failures (HB)**:

- **HB1**: React render cycle re-fires a regen during an in-flight
  regen (state-update-during-effect race). Two overlapping cycles
  produce inconsistent final state.
- **HB2**: IDB transaction commits asynchronously after the JS
  callback returns. A subsequent read sees stale data.
- **HB3**: React effect dependency chain misses a dispatch trigger
  (e.g. scenario added but the effect didn't re-fire).
- **HB4**: Component unmounts mid-CF, leaving orphan handlers that
  fire against a destroyed React context — silent error or memory
  leak.

**Persistence and reload integrity (HP)**:

- **HP1**: CF results applied → pack extracted → persisted → page
  refresh → recomposed → does the recomposed scenario render with
  the SAME chart values as before refresh? End-to-end identity
  check.
- **HP2**: Multiple scenarios with multiple CF responses → all
  persisted → reload → all recompose correctly. Cross-scenario
  isolation survives a full reload cycle.
- **HP3**: User edits a scenario → CF dispatched → user navigates
  away mid-CF → returns → final state is consistent (no
  half-applied CF).

**Multi-scenario seam interaction (HM)**:

- **HM1**: Three live scenarios with distinct DSLs → each gets its
  own derived model_vars → each gets its own response → display
  chart shows three visibly-distinct lines. End-to-end proof of
  per-scenario isolation.
- **HM2**: Scenario reorder (drag) during in-flight CF → CF results
  land on the right scenarios despite the layer-order change.

### H.3 Test level for each

All Layer H failure modes are integration or browser-level. There
is no unit-level Layer H — by definition Layer H is "no per-layer
mocks":

- **HC, HX, HM (cross-cutting only)**: cross-cutting Vitest
  integration. Real services, deferred-CF harness only at the BE
  boundary, intercepts at every seam.
- **HB, HP, HM (browser-real)**: Playwright browser. Real React,
  real IDB, real DOM.

### H.4 Group into the minimum test set

- **HC1-HC7, HX1-HX3, HM1**: one cross-cutting Vitest integration
  test (real FE services + harness only at BE boundary + sentinel
  inputs end-to-end).
- **HB1-HB4, HP1-HP3, HM2**: one Playwright spec (real browser).

Result: **two tests** for Layer H. Not redundant — H-Test-1 catches
seams in deterministic in-process conditions (so when it fails, you
can pinpoint the seam); H-Test-2 catches real-browser conditions
where in-process tests can't reach.

### H.5 Concrete tests

#### H-Test-1: `cfFullPipelineSentinel.integration.test.ts` (Vitest, cross-cutting)

The "no mocks at layer boundaries" test. The deferred-CF harness is
the ONLY mock — and only at the BE boundary. Every FE service is
real.

**Inputs**:

- Sentinel parameter file with 3 distinct slices (window / cohort /
  window-with-context).
- Sentinel BASE graph.
- 3 scenarios with distinct effective DSLs that resolve to those 3
  slices.
- Deferred-CF harness with sentinel response payloads per scenario
  (S1: `p_mean=0.111`; S2: `0.222`; S3: `0.333`).
- Real `ScenariosContext`, `analysisComputePreparationService`,
  `conditionedForecastService`, `GraphParamExtractor`,
  `CompositionService`, in-memory IDB.

**Subcases / assertions — one per seam**:

- **Seam C→A** (did CF process the right inputs?): for each captured
  CF dispatch payload, the embedded scenario graph's
  `model_vars[bayesian]` matches the standalone output of the
  per-scenario derivation function for that scenario's DSL. Run
  derivation function standalone and compare. (HC2)
- **Seam A→A** (does async commissioning catch every graph?):
  invoke `regenerateAllLive`. Harness records exactly 3 dispatches
  with 3 distinct scenario-specific graph fingerprints. Extract
  per-scenario composed graph fingerprints separately and assert
  each dispatch's payload fingerprint matches the corresponding
  scenario's. No two dispatches share a fingerprint; no fingerprint
  matches BASE. (HX1)
- **Seam A↔B** (dispatch-to-response pairing): resolve all 3 CFs in
  REVERSE order (S3, S2, S1). Each scenario's working graph receives
  ITS OWN response's `p_mean`. Cross-check by asserting S1's working
  graph carries `0.111`, never `0.222` or `0.333`. (HX2, HX3)
- **Seam B→D** (do param packs go back in?): after each CF resolves,
  intercept the working graph reference at apply time. Then
  intercept again at extract time. Assert: same reference (or, if
  React state rotation is intended, the extract reads the
  post-rotation graph that includes the apply). Pack contents
  reflect the CF-applied sentinel values. (HC1, HC3)
- **Seam E→D**: with the harness, force one scenario's CF onto
  slow-path (resolve at 700ms). Assert pack extraction for that
  scenario fires AFTER 700ms (not at the 500ms FE-topo apply
  moment). Pack contains CF-derived sentinels. (HC4)
- **Real serialisation**: the dispatch payload that the harness
  captures is what `JSON.stringify` would produce (force a
  stringify-roundtrip in the harness). Assert the captured payload
  after stringify-roundtrip is byte-equal to before. Catches any
  field that real fetch would drop. (HC6)
- **Display-state agreement**: read the value the chart layer would
  render for each scenario (call the chart-data builder against the
  recomposed scenario graph). Assert it equals the per-scenario
  sentinel value. (HC5, HC7)
- **Multi-scenario isolation**: assert all three scenarios' final
  pack values are distinct, scenario-correct, and survive a
  recomposition cycle. (HM1)

**Catches**: HC1-HC7, HX1-HX3, HM1.

**Does NOT catch**: real-browser failures (HB),
persistence-across-reload (HP), real-BE value correctness.

#### H-Test-2: `liveScenarioConditionedForecastRoundtrip.spec.ts` (Playwright)

(Already named in doc 73a §16 Stage 7. Strengthen with subcases
here.)

**Inputs**: real graph fixture loaded into the editor at boot. Real
BE if available in test environment; otherwise fixture-stubbed via
the test-mode harness already used by other Playwright specs.

**Subcases**:

- **Boot and initial CF** — boot editor with known graph. Wait for
  initial CF on Current. Capture chart values. (HB2, HB3)
- **Create scenarios** — UI-create 3 live scenarios with distinct
  DSLs. Wait for each scenario's CF. Assert each chart shows
  distinct values per its DSL. (HM1, HB3)
- **Refresh all** — invoke "refresh all" via UI. Wait for all CFs.
  Assert chart values updated. (HB1)
- **Page reload** — reload the page. Assert: post-reload, each
  scenario shows the same chart values as before reload. Tests pack
  persistence + recompose + render. (HP1, HP2)
- **Navigate-away-and-back** — switch tab away, switch back. Assert
  no console errors, state preserved. (HB4, HP3)
- **Scenario reorder** — drag a scenario to a new position. Assert
  chart updates correctly (re-composition with new order). (HM2)
- **Mid-CF interaction** — trigger refresh-all; while CF is in
  flight, click another UI element that triggers a state update.
  Assert no error and final settled state is consistent. (HB1)

**Catches**: HB1-HB4, HP1-HP3, HM1 (browser-real version), HM2.

**Does NOT catch**: per-seam diagnostic detail — when this test
fails, you know "something broke in the browser" but you may need
to drill down. H-Test-1 provides the per-seam diagnostic.

### H.6 Cross-check

- Layer H is a **ladder**: H-Test-1 catches seam wiring
  (deterministic, diagnostic); H-Test-2 catches real-browser
  conditions. If H-Test-2 fails but H-Test-1 passes, the bug is in
  the browser layer. If H-Test-1 fails, the bug is in the in-process
  wiring.
- **HC7** added on cross-check (display reads from wrong source).
- **Open question for design**: should H-Test-2 run against a real
  BE or a stubbed BE? Real BE catches BE-side regressions but is
  unstable across BE changes. Stubbed BE is stable but doesn't catch
  BE-side. Suggested split: `e2e:stubbed` (CI-required) and
  `e2e:realbe` (manual / nightly).

### H.7 Layer H summary

**Two tests** (H-Test-1 cross-cutting Vitest, H-Test-2 Playwright).
H-Test-1 catches seam wiring failures (the user's "does async
commissioning catch every graph", "did CF process the right inputs",
"do param packs go back in" concerns). H-Test-2 catches real-browser
failures and persistence integrity.



## Failure-mode → test mapping (whole sidecar)

The reviewer-friendly index. Every enumerated failure mode in this
sidecar maps to exactly one named test. A failure mode without a
mapped test is a coverage gap; a test in doc 73a §16 without a
sidecar entry is unaccounted-for coverage.

| Failure mode | Catching test | Layer |
|---|---|---|
| AA1 (visible scenario not dispatched) | `cfDispatchCoverage.test.ts` | A |
| AA2 (hidden scenario dispatched) | `cfDispatchCoverage.test.ts` | A |
| AA3 (BASE dispatched against frozen-at-load rule) | `cfDispatchCoverage.test.ts` | A |
| AA4 (CURRENT dispatched in regenerateAllLive) | `cfDispatchCoverage.test.ts` | A |
| AA5 (same scenario dispatched twice in one cycle) | `cfDispatchCoverage.test.ts` | A |
| AA6 (mid-cycle scenario create — race) | `cfDispatchCoverage.test.ts` | A |
| AA7 (mid-cycle scenario delete — race) | `cfDispatchCoverage.test.ts` | A |
| AS1 (gen incremented for wrong scenarioId) | `cfPerScenarioSupersession.test.ts` | A |
| AS2 (gen captured after request built) | `cfPerScenarioSupersession.test.ts` | A |
| AS3 (supersession state shared across tabs) | `cfPerScenarioSupersession.test.ts` | A |
| AS4 (supersession state lost between fetches) | `cfPerScenarioSupersession.test.ts` | A |
| AE1 (scenarioId on request mismatched) | `cfRequestEnvelope.test.ts` | A |
| AE2 (effective DSL on request mismatched) | `cfRequestEnvelope.test.ts` | A |
| AE3 (request graph is BASE not per-scenario) | `cfRequestEnvelope.test.ts` | A |
| AE4 (closure capture — all scenarios send last graph) | `cfRequestEnvelope.test.ts` | A |
| AE5 (Layer C derivation didn't run before dispatch) | `cfRequestEnvelope.test.ts` | A |
| AE6 (candidate_regimes_by_edge empty/wrong) | `cfRequestEnvelope.test.ts` | A |
| AE7 (live editor graph mutated as side effect) | `cfRequestEnvelope.test.ts` | A |
| AE8 (analytics_dsl on request mismatched) | `cfRequestEnvelope.test.ts` | A |
| BR1 (response A applied to graph B) | `cfResponseRouting.test.ts` | B |
| BR2 (response applied to BASE) | `cfResponseRouting.test.ts` | B |
| BR3 (orphan scenarioId silently ignored) | `cfResponseRouting.test.ts` | B |
| BR4 (response applied twice — idempotency) | `cfResponseRouting.test.ts` | B |
| BF1-BF9 (CF response → graph field mapping slips) | `cfFieldMappingSentinel.test.ts` | B |
| BE1 (empty response treated as success) | `cfResponseEdgeCases.test.ts` | B |
| BE2 (failed response leaves inconsistent graph) | `cfResponseEdgeCases.test.ts` | B |
| BE3 (partial response mishandled) | `cfResponseEdgeCases.test.ts` | B |
| BE4 (null per-edge values mishandled) | `cfResponseEdgeCases.test.ts` | B |
| BE5 (orphan edge_uuid in response) | `cfResponseEdgeCases.test.ts` | B |
| BS3 (cross-scenario gen check) | `cfPerScenarioSupersession.test.ts` (extension) | B |
| BS4 (supersession check after apply) | `cfPerScenarioSupersession.test.ts` (extension) | B |
| F1 (derivation picks wrong slice for DSL) | `perScenarioModelVarsDerivation.test.ts` | C |
| F2 (derivation emits wrong shape) | `perScenarioModelVarsDerivation.test.ts` | C |
| F3 (derivation mutates source) | `perScenarioModelVarsDerivation.test.ts` | C |
| F4 (CF and analysis paths diverge) | `cfAndAnalysisDerivationParity.test.ts` | C |
| F5 (derived data doesn't reach BE payload) | `cfRequestPayloadModelVars.test.ts` | C |
| F6 (derivation clobbers analytic entry) | `perScenarioModelVarsDerivation.test.ts` | C |
| F10 (closure-state bug in per-scenario loop) | `cfAndAnalysisDerivationParity.test.ts` | C |
| F7-F9 (BE consumer-read migration) | (handed off to doc 73b) | C / 73b |
| F11 (derivation perf) | (out of scope; flagged) | C |
| DX1-DX7 (extract failures) | `extractDiffParamsContractCoverage.test.ts` | D |
| DR1-DR7 (recompose failures) | `compositorReplayCoverage.test.ts` | D |
| DT1-DT3 (round-trip failures) | `scenarioPackContractRoundtrip.test.ts` | D |
| DS1-DS4 (IDB persistence failures) | `scenarioPackPersistence.test.ts` | D |
| EF1-EF6 (fast/slow path race) | `cfFastSlowPathSentinel.test.ts` | E |
| EP1-EP6 (pack-extraction sequencing) | `scenarioRegenerationCfUpsert.test.ts` | E |
| EC1-EC3 (concurrent regen cycles) | `cfConcurrentRegenCycles.test.ts` | E |
| EL1-EL3 (promise lifecycle edge cases) | `cfPromiseLifecycleEdgeCases.test.ts` | E |
| FR1-FR3 (re-introduction of removed symbols) | `cleanupGrepGates.test.ts` | F |
| FR4 (fixture still carries _posteriorSlices) | `cleanupSchemaAudit.test.ts` | F |
| FC1-FC4 (silent FE display regression after removal) | `feDisplayAfterPosteriorRemoval.spec.ts` | F |
| FS1, FS2 (schema/IDB integrity) | `cleanupSchemaAudit.test.ts` | F |
| GC1-GC4 (log coverage gaps) | `cfSessionLogShape.test.ts` | G |
| GS1-GS4 (log shape drift) | `cfSessionLogShape.test.ts` | G |
| GO1, GO2 (log ordering) | `cfSessionLogShape.test.ts` | G |
| GL1-GL4 (log level drift) | `cfLogLevelInvariance.test.ts` | G |
| GT2 (isLevelEnabled audit at CF call sites) | `cleanupGrepGates.test.ts` (extension) | G |
| GT1, GT3 (sessionLogService internals) | (existing sessionLogService tests; not duplicated) | G |
| HC1-HC7 (cross-layer seam failures) | `cfFullPipelineSentinel.integration.test.ts` | H |
| HX1-HX3 (async commissioning seam) | `cfFullPipelineSentinel.integration.test.ts` | H |
| HB1-HB4 (real-browser failures) | `liveScenarioConditionedForecastRoundtrip.spec.ts` | H |
| HP1-HP3 (persistence and reload) | `liveScenarioConditionedForecastRoundtrip.spec.ts` | H |
| HM1 (per-scenario isolation, in-process) | `cfFullPipelineSentinel.integration.test.ts` | H |
| HM1, HM2 (per-scenario isolation, browser) | `liveScenarioConditionedForecastRoundtrip.spec.ts` | H |
