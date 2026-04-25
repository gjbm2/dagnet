# 73a — Execution Plan for FE/CLI Conditioned-Forecast Parity Repair

**Date**: 24-Apr-26 (revised)
**Status**: Active implementation plan — staged and guarded after two failed attempts
**Audience**: engineers executing the next FE/CLI parity repair
**Relates to**:
`72-fe-cli-conditioned-forecast-parity-fix-plan.md`,
`73b-be-topo-removal-and-forecast-state-separation-plan.md`,
`74-doc-72-scope-correction.md`,
`73c-cf-staged-test-strategy.md` (sidecar — per-layer test strategy reasoned from first principles),
`../codebase/PARAMETER_SYSTEM.md`,
`../codebase/SCENARIO_SYSTEM_ARCHITECTURE.md`,
`../codebase/SESSION_LOG_ARCHITECTURE.md`,
`../codebase/STATS_SUBSYSTEMS.md`

## 0. History and posture of this plan

Two prior attempts at this work were reverted. Both attempts widened scope
into the model-vars vs. promoted-vars vs. query-scoped-answer separation —
which is doc 73b's territory — and broke the live system in the process.

The governing posture for this revision is **do no harm**. Doc 73a's job is
narrow plumbing: per-scenario CF supersession, faithful pack rebuild,
the request-graph engorgement *pattern* (rule §3.9 — its existing use by
the CF request snapshot stays here; new uses such as per-scenario
`model_vars[]` derivation moved to doc 73b's bundled switchover), and
CLI/FE alignment on the same contract. Doc 73a does not change which
fields the runtime reads as model input, does not change which fields FE
topo writes, does not extend the promotion writer, and does not change
the Python resolver source order — those are doc 73b's job. Doc 73a is
functionally invariant with respect to the current `p.mean` /
`model_vars[]` / `posterior.*` semantics.

Every stage in this plan has a baseline-capture step and a named regression
gate. No stage commits without its gate passing. The gates are the single
mechanism preventing a third disaster.

## 1. Purpose

Doc 72 described three defects that together produced FE/CLI divergence in
conditioned-forecast (CF) analysis. After the reversion, doc 74 narrowed
the follow-up scope: keep the FE quick topo pass, keep the current scenario
storage model (thin ordered param-pack deltas), but fix the defects that
actually break parity.

This doc is the staged plan for that narrowed pass. It names the files,
fields, behaviours, and named tests for each stage, and gives an
explicit doc 73b boundary so the implementer cannot drift into ownership
work that belongs in doc 73b.

Out of scope: redesigning the FE topo pass, renaming probability fields
project-wide, redesigning the statistical source taxonomy, replacing the
scenario store with persisted per-scenario graphs, separating model-bearing
from query-scoped fields (doc 73b), or unifying Python resolver source
order across target-edge and carrier paths (doc 73b Stage 4).

## 2. The three defect families this plan closes

All defects in this section are **live in the post-revert tree** (verified
against the working copy at plan-revision time). Defects 1 and 2 are
explicitly handed off to doc 73b and remain here only as context. Defects
3a, 3b, 3c are doc 73a's job.

### Defect 1 — FE writes a query-scoped scalar into the model-bearing slot (handed off to doc 73b)

`edge.p.mean` is currently overloaded. The FE topo pass computes a
query-scoped `blendedMean` and writes it into `edge.p.mean`. The Python
runtime later reads that same field as model input (see Defect 2).

**Doc 73a does not fix this.** Doc 73b Stage 3 owns the FE-side split
(provisional display vs. model-bearing). Doc 73a work proceeds on the
assumption that the current overload exists and must remain functionally
unchanged until doc 73b lands. Any temptation to introduce a write gate on
`p.mean` (the fix that broke both prior attempts) is explicitly rejected
here — see §5 Stop rules.

Files cited for context only:
[statisticalEnhancementService.ts](graph-editor/src/services/statisticalEnhancementService.ts),
[UpdateManager.ts](graph-editor/src/services/UpdateManager.ts),
[fetchDataService.ts](graph-editor/src/services/fetchDataService.ts).

### Defect 2 — Python uses two different probability-source rules (handed off to doc 73b)

For the target edge, `resolve_model_params` in
[model_resolver.py](graph-editor/lib/runner/model_resolver.py) follows
posterior → forecast → fallback. For the upstream carrier,
`_resolve_edge_p` in
[forecast_state.py](graph-editor/lib/runner/forecast_state.py) reads
`p.mean` first. The two callers can disagree on the same edge inside the
same solve, and the carrier path is exactly the one Defect 1 poisons.

**Doc 73a does not fix this.** Doc 73b Stage 4 owns the consumer-side
unification ("BE runtime and graph consumers must read model inputs from
model/promoted surfaces, not from current-answer fields"). Doc 73a
proceeds on the assumption that `_resolve_edge_p` keeps reading `p.mean`
first.

### Defect 3a — CF supersession is global, not per-scenario

[fetchDataService.ts:1224](graph-editor/src/services/fetchDataService.ts)
holds a module-global `_conditionedForecastGeneration` counter. It is
incremented at every CF commission ([line 2263](graph-editor/src/services/fetchDataService.ts))
and the stale-response check ([line 2460](graph-editor/src/services/fetchDataService.ts))
compares against the same global. There is no per-scenario state. A CF
commissioned by scenario A and one commissioned by scenario B share
the same counter; whichever fires second cancels the first.

Compounding sub-defect at the call site:
[fetchDataService.ts:2269](graph-editor/src/services/fetchDataService.ts)
invokes `runConditionedForecast(graph, dsl, undefined, workspace)` —
the 5th positional `scenarioId` argument is omitted and defaults to
`'current'` ([conditionedForecastService.ts:96-102](graph-editor/src/services/conditionedForecastService.ts)).
Every CF dispatch — A, B, current — therefore self-tags as `'current'`.
Even after the per-scenario tracker in Stage 1 lands, every entry would
key off the same string. Routing-by-scenarioId, log assertions, and the
supersession check itself would all be vacuously satisfied. Stage 1 must
fix both the tracker plumbing and the call site for the stage to be
load-bearing.

### Defect 3b — Scenario packs cannot rebuild a faithful graph

Three independent gaps in
[GraphParamExtractor.ts](graph-editor/src/services/GraphParamExtractor.ts)
and
[CompositionService.ts](graph-editor/src/services/CompositionService.ts)
combine to silently drop CF state from rebuilt scenario graphs:

1. **Extractor drops `edge.p.n`.** `extractEdgeParams` walks `p` but
   pulls only `evidence.n` ([line 248](graph-editor/src/services/GraphParamExtractor.ts)).
   The edge-level sample count `p.n` (which drives evidence-derived
   fallback in the runtime) is not extracted.
2. **`extractDiffParams` gates the entire `p` block on `p.mean` change**
   ([lines 447–453](graph-editor/src/services/GraphParamExtractor.ts)).
   If CF wrote only `p.evidence.*` or only `p.posterior.*` without
   shifting `p.mean`, those changes are not in the diff and the
   persisted pack omits them.
3. **`applyComposedParamsToGraph` does not replay `p.posterior.*` or
   `p.n`** ([lines 165–195](graph-editor/src/services/CompositionService.ts)),
   and `conditional_p` replay is a literal no-op marked TODO
   ([lines 210–216](graph-editor/src/services/CompositionService.ts)).
   Even if the extractor and diff gate were fixed, the compositor
   would silently discard the replay.
4. **Orchestrator does not wait for CF before the regen pack snapshot
   is taken.**
   [`refreshFromFilesWithRetries`](graph-editor/src/services/fetchOrchestratorService.ts)
   accepts no parameter to await the in-flight CF promise, and
   [ScenariosContext.tsx:995](graph-editor/src/contexts/ScenariosContext.tsx)
   calls `extractDiffParams` immediately after the orchestrator resolves.
   CF runs as a fire-and-forget promise inside `fetchItems` and lands on
   the live graph after the pack snapshot has already been taken. Even
   with gaps 1–3 fixed, the persisted pack contains the pre-CF state.
   The CLI happens to await its background promises, so CLI parity tests
   pass; browser regen produces stale packs and would pass tests
   vacuously. Doc 73a's CLI/FE parity objective is structurally unmet
   without this gate.

Together these mean a regenerated scenario's rebuilt graph diverges
from the working graph on exactly the fields the runtime reads.

### Defect 3c — Per-scenario model parameters are split across two unrelated paths

The FE delivers per-scenario request graphs to BE analysis (and to CF),
but the per-scenario *model parameters* on each graph come from two
unrelated channels with two different scopes:

1. **Probability** (alpha/beta) — flows through
   [`reprojectPosteriorForDsl`](graph-editor/src/services/analysisComputePreparationService.ts),
   which reads from the file-level slice inventory stashed on the
   persistent graph as `edge.p._posteriorSlices` (written by
   [mappingConfigurations.ts](graph-editor/src/services/updateManager/mappingConfigurations.ts)
   Flow G), picks the slice matching each scenario's effective DSL,
   and writes `edge.p.posterior.*` on the per-scenario request graph.
   Per-scenario contexting works for probability.
2. **Latency** (mu/sigma/onset and path variants) — flows through
   the bayesian entry in `edge.p.model_vars[]`, written ONCE per edge
   by the bayes-patch service from one (window, cohort) fit pair and
   inherited unchanged from the baseline graph across every scenario.
   The BE resolver
   ([model_resolver.py](graph-editor/lib/runner/model_resolver.py))
   reads latency from `model_vars[]` first, falling back to
   `latency.posterior` only when `model_vars[]` has no latency.
   **Per-scenario contexting does not work for latency.** Every
   scenario sees the same context's latency, regardless of its
   effective DSL.

`epistemic_bands.py` separately reads `fit_history` from
`_posteriorSlices` for historical bins per `asat` date.

The persistent `_posteriorSlices` stash on the graph is also
file-depth data living on the wrong layer.

The fix is fully owned by **doc 73b**. It bundles three pieces in
one stage so each commit produces an observable behavioural diff:
(a) per-scenario `model_vars[]` delivery — the FE derives each
scenario's bayesian entry per edge from the parameter file's slice
matching that scenario's effective DSL, covering probability AND
latency; (b) the promotion writer extension that projects the
delivered source onto the canonical `p.forecast.*` surface; and
(c) the first BE consumer switch to read from that surface. The
remaining consumer migrations and the cleanup of `_posteriorSlices`
/ `reprojectPosteriorForDsl` follow in subsequent doc 73b stages.
Doc 73a no longer carries any sub-stage of this work — earlier
drafts split it into 73a "delivery" and 73a "cleanup" with 73b in
the middle, but each end was inert in isolation.

The target-edge posterior-mass witness from doc 72
(`alpha=328.66`, `beta=57.38` appearing with no integer-count provenance)
remains a live witness. This plan does not assume it will be resolved by
these stages but must not silently drop it.

## 3. Binding design rules (constraints on all solutions)

1. **Parameter files are the authoritative store.** They keep the full
   posterior slice inventory, fit history, retrieval metadata, and the
   model-source ledger. Nothing the FE or CLI does may shift that
   authority.

2. **The graph holds structure plus current projection.** "Current
   projection" means the active scenario's scalars: `p.mean`, `p.stdev`,
   `p.posterior.*`, `p.evidence.*`, `p.forecast.*`, `p.latency.*`, `p.n`,
   node overrides, `conditional_p`, plus the active entries in
   `p.model_vars[]`. It is not the long-term home for raw slice
   inventories.

3. **The FE topo pass may compute a provisional display answer**, but
   that answer must not occupy the same slot that the runtime reads as
   model input. **Doc 73b owns enforcement of this rule.** Doc 73a work
   proceeds on the assumption that the current overload exists and must
   not be changed by doc 73a work.

4. **Scenarios stay as thin ordered param-pack deltas.** Layer order is
   semantically load-bearing — later deltas override earlier ones. No
   scenario is a stored graph.

5. **Scenario packs may carry only the active projection** needed for
   rebuild. They may not carry raw `posterior.slices`, full
   `p.model_vars[]` inventory, or `fit_history`.

6. **CF supersession is per-scenario, in tab-scoped scenario state.** Not
   a module-global counter.

7. **`conditional_p` is part of the pack contract and must replay.**

8. **The Python runtime is stateless about workspace, parameter files,
   and FileRegistry.** It does not open parameter files by id, does not
   consume workspace context, and does not own a parameter resolver.
   Every piece of model material the runtime needs must arrive on the
   request payload. FE/CLI own parameter-file resolution and are
   responsible for materialising anything the runtime depends on into
   the request graph at request-build time.

9. **Request-graph engorgement is the sanctioned pattern for shipping
   parameter-file material to the runtime.** When a runtime path needs
   more than the active projection (historical posterior depth,
   fit-history slices, multi-DSL fallback state), FE and CLI engorge the
   request graph from the parameter-file resolver before the call. The
   engorged material is request-scoped: not persisted to graph JSON,
   not stored in scenarios, not part of any pack contract. The reference
   implementation is
   [conditionedForecastGraphSnapshot.ts](graph-editor/src/lib/conditionedForecastGraphSnapshot.ts)
   (`buildConditionedForecastGraphSnapshot` + `ParameterFileResolver`).

10. **Doc 73a does not change FE `p.mean` writers, BE consumer read
    paths, or Python resolver source taxonomy.** Specifically out of scope:
    [statisticalEnhancementService.ts](graph-editor/src/services/statisticalEnhancementService.ts),
    [UpdateManager.ts::applyBatchLAGValues](graph-editor/src/services/UpdateManager.ts),
    [fetchDataService.ts](graph-editor/src/services/fetchDataService.ts)
    write paths that gate or remove `p.mean` writes (doc 73b);
    [model_resolver.py](graph-editor/lib/runner/model_resolver.py)
    and [forecast_state.py](graph-editor/lib/runner/forecast_state.py)
    consumer read-path migration to the canonical promoted surface
    `p.forecast.*` (doc 73b — see doc 73b §3.2 and Decision 7);
    and `model_resolver.py`'s *source taxonomy* (which sources exist,
    how `_resolve_promoted_source` selects between them — doc 73b
    territory).

    Doc 73a no longer carries any consumer-read or per-scenario
    `model_vars[]` delivery work. The previous Stage 5a/5b/5c split
    has moved into doc 73b's bundled switchover stage and the
    cleanup stage that follows it. Doc 73a's scope at this boundary
    is now: pin the §15A pre-handoff gates that doc 73b's switchover
    depends on (per-scenario CF supersession, pack contract,
    request-graph shape), and stop.

    If a doc 73a stage appears to require behavioural changes to BE
    consumer read paths, the stage is mis-scoped — stop and re-read
    this rule.

11. **The CF response → graph field mapping is explicit and pinned by
    sentinel-value tests.** Each CF response field has exactly one
    documented graph-apply target (or is documented as response-only).
    See §10 Stage 4 for the live mapping table. Any new field added to
    the CF response, or any change of target for an existing field,
    requires the table to be updated in the same commit. Tests use
    distinct sentinel values per field so a wiring slip is caught
    immediately rather than masked by accidentally-equal values.

12. **CF dispatch coverage**: each visible user live scenario receives
    exactly one CF commission per regeneration cycle. CURRENT receives
    CF via its own path
    ([useDSLReaggregation](graph-editor/src/hooks/useDSLReaggregation.ts))
    when `currentDSL` changes. **BASE does not receive CF.** BASE is
    frozen at file load and only changes via explicit user action —
    commit + close + reopen (the new file becomes the new base) or
    "put to base". Hidden scenarios receive no CF. The
    [`regenerateAllLive` filter at ScenariosContext.tsx:1178](graph-editor/src/contexts/ScenariosContext.tsx)
    that excludes `'base'` and `'current'` is correct as-is.

13. **CF response order is non-load-bearing.** Each scenario's pack
    captures absolute values for fields CF wrote against that scenario's
    own working graph; fields CF did not write get inherited from the
    current state of layers below at recomposition time. So if response
    A returns before B, the UI re-renders A first, then B; both renders
    are individually self-consistent and converge to the right display
    state. Future code must not introduce dispatch-order or
    response-order assumptions for correctness.

## 4. Sequencing rules

- **Stage 0 (baseline freeze) lands first.** Without committed golden
  fixtures of today's observable behaviour, no later stage can prove
  it preserved invariance.
- **Stages 1–4 are commit-bisectable in order.** Each one ends with a
  named test passing, and that test must remain green for every stage
  that follows.
- **Stage 5 is a handoff to doc 73b.** Per-scenario `model_vars[]`
  delivery, the promoted-probability writer extension, BE consumer
  migration, and removal of the legacy `_posteriorSlices` /
  `reprojectPosteriorForDsl` paths are all owned by doc 73b. Earlier
  drafts of this plan held the delivery (5a) and the cleanup (5c)
  inside doc 73a, but in isolation each was inert: 5a shipped data
  no consumer read, and 5c could only run after doc 73b's consumer
  migration. Bundling delivery + writer + the first consumer switch
  inside doc 73b produces an observable behavioural diff at the
  moment any of the work lands. See §11 for the handoff details.
- **Stage 6 (CLI/FE alignment) lands last among behavioural stages
  in doc 73a** because it depends on the pack contract from Stage 2.
- **Stage 7 is the cross-cutting verification rollup**, not new
  behavioural work.

The original draft's interleaving of "FE split" and "Python unification"
into doc 73a is removed. Both are doc 73b's job (see §3.10), and the
per-scenario `model_vars[]` work that this plan briefly held has now
joined them there for the same reason: a switchover that is split
across plans cannot produce a bisectable observable diff.

## 5. Stop rules (abort signals)

These rules trigger an immediate halt. They exist because every prior
attempt failed by ignoring exactly these signals.

- **If a stage's diff touches FE `p.mean` writers, BE consumer read
  paths, BE source taxonomy, the promotion writer, or the legacy
  `_posteriorSlices` / `reprojectPosteriorForDsl` paths**, stop.
  Defer to doc 73b. Specific files that doc 73a must not modify
  behaviourally: `statisticalEnhancementService.ts`,
  `UpdateManager.ts::applyBatchLAGValues` (no new opts gate, no change
  to existing argument shape — see phasing note below),
  `fetchDataService.ts` (no `writeMeanToGraph` plumbing),
  `model_resolver.py` and `forecast_state.py` consumer read paths
  (these migrate to the canonical promoted surface in doc 73b),
  `model_resolver.py::_resolve_promoted_source` (which sources exist
  and how they are selected), `modelVarsResolution.ts::applyPromotion`
  (the promotion writer — extended in doc 73b to populate the wider
  `p.forecast.*` surface), `analysisComputePreparationService.ts`'s
  `reprojectPosteriorForDsl` and the `_posteriorSlices` write in
  `mappingConfigurations.ts` Flow G (both removed in doc 73b after its
  consumer migration). Doc 73a no longer carries any consumer-side
  work — it was previously held in §11 Stage 5c and is now in doc 73b.

  Phasing note for `applyBatchLAGValues`: doc 73b Stage 5 takes ownership
  of bringing this function into the `*_overridden` lock discipline,
  which may extend its argument surface or wrap it. Doc 73a's "no new
  opts gate" rule binds **only during doc 73a's own lifetime** (Stages
  1–7); doc 73b is free to extend the surface in its Stage 5 once doc
  73a's §15A pre-handoff gates have passed. The two plans do not
  conflict — they sequence.
- **If a stage's diff causes the Stage 0 baseline to drift** without a
  named expected-delta in this plan, stop. Capture the witness, do not
  commit. The drift is either a regression or a planning miss.
- **If a stage requires persisting full scenario graphs**, stop. Re-read
  doc 74.
- **No fallbacks across contexts at the bayesian-source layer.** This
  rule is doc 73b's to enforce now that delivery has moved there, but
  it remains stated here because it is a constraint on every plan that
  ships per-scenario bayesian material. Returning a fit from a
  different context (e.g. bare `window()` when the scenario asks for
  `context(channel:google).window()`) and labelling it as the
  requested context is silent semantic substitution. No bayesian entry
  is preferable to a wrong-context bayesian entry; consumers fall
  through to the analytic entry for the correct context. The current
  resolver `resolvePosteriorSlice`
  ([posteriorSliceResolution.ts:167-171](graph-editor/src/services/posteriorSliceResolution.ts#L167-L171))
  silently strips context dimensions and returns the bare-mode
  aggregate when no exact match exists; doc 73b's delivery work must
  not inherit this behaviour. Data integrity matters.
- **If a consumer appears to need raw posterior inventory on the graph**
  to work, migrate it onto request-graph engorgement (rule §3.9). Do not
  widen the persistent graph or the pack, and do not give the Python
  runtime a parameter-file loader (rule §3.8).
- **If Stage 1 reverification finds Defect 3a fully resolved by the
  post-revert tree**, the stage becomes test-only. Don't reintroduce
  defunct mechanisms just to re-fix them.
- **If the target-edge posterior-mass witness changes value during any
  stage**, capture the change in that stage's commit message. Do not
  assume the change means the underlying defect is fixed — it may have
  only moved.
- **If a stage adds a CF response → graph projection that is not in
  §10 Stage 4's mapping table**, stop. Promotion of a response-only
  field to graph state is a design-owner decision; the table is the
  authoritative record. Doc 73a's settled persistences are `p_sd → p.stdev`,
  `evidence_k → p.evidence.k`, `evidence_n → p.evidence.n`. Anything
  else (e.g. promoting `p_sd_epistemic` or any future CF response
  field) requires a recorded decision and a table update in the same
  commit.

## 6. Stage 0 — Test infrastructure (no behaviour change)

### Why

Two prior attempts failed in part because no deterministic test
infrastructure existed to attribute a failure to a specific phase of
the CF transaction. Outcome-only tests catch "something changed";
they do not say *which phase broke*. Stage 0 builds the tooling that
makes every later stage diagnosable, then captures golden fixtures as
a safety net.

### Stage 0 priority order

1. **Deferred-CF transaction harness** (the primary diagnostic tool).
2. **Sentinel graph fixtures** (per-field distinct values so naming
   slips fail loudly).
3. **Golden behavioural fixtures** (regression safety net for
   Stage 7 cross-cutting verification).

The order is load-bearing. Without the harness, golden fixtures only
tell you a regression happened — not where. Without sentinels, equal
values across fields can mask field-routing slips.

### 0A — Deferred-CF transaction harness

Build a single test harness that treats the CF call as a controlled
deferred promise, not a real backend round-trip. The harness must let
a test author inject any of these states deterministically:

- Fast CF response (resolves before the 500ms fast-path deadline).
- Slow CF response (resolves after the 500ms deadline; FE fallback
  applies first; CF lands on the slow path).
- Two scenarios A and B with overlapping in-flight CF calls.
- Two generations for the same scenario in flight (A1 then A2).
- CF failure (rejected promise).
- CF empty response (resolves with an empty edges array).
- CF superseded (programmatically advance the supersession state
  before the response resolves).
- Pack extraction triggered before vs. after CF settlement.

The harness is the single mechanism every CF test in this plan uses.
It exposes named control points so tests read as:
*"commission CF for A → commission CF for B → resolve B → resolve A
late → assert A's response was applied to A's graph"*. Implementation
detail (manual Promise resolvers, Promise.withResolvers, or a small
queue facade) is the implementer's choice — the public surface must
support all eight states above.

Live in `graph-editor/src/services/__tests__/helpers/cfTransactionHarness.ts`.

### 0B — Sentinel graph fixtures

Build a small set of synthetic graphs where every contract field has
a deliberately distinct value. Sentinel ranges for clarity:
`p.mean` in `[0.10–0.19]`, `p.stdev` in `[0.20–0.29]`,
`p.posterior.alpha` in `[100–199]`, `p.posterior.cohort_alpha` in
`[200–299]`, `p.evidence.n` in `[300–399]`, `p.forecast.mean` in
`[0.30–0.39]`, `p.latency.completeness` in `[0.40–0.49]`,
`p.latency.completeness_stdev` in `[0.50–0.59]`, `p.n` in
`[400–499]`, plus distinct sentinels for `conditional_p` slots, node
`entry.entry_weight`, and node `case.variants`.

Sentinels make field-naming and field-routing slips fail at the
specific line — a test asserting "after CF apply, edge X's
`p.latency.completeness` is in `[0.40–0.49]`" pinpoints the issue if
the value lands as `0.30` (forecast.mean) or `0.50` (completeness_stdev).

Live in `graph-editor/src/services/__tests__/__fixtures__/sentinel/`.

### 0C — Golden behavioural fixtures

For one Bayes-fitted real graph from the data repo plus one
synthetic, capture today's observable behaviour:

- Per-scenario CF request payload (engorged graph snapshot,
  `effective_query_dsl`, `candidate_regimes_by_edge`).
- Per-scenario CF response payload.
- Per-scenario post-CF graph state on every contract field.
- Per-scenario persisted pack.
- Per-regeneration session-log shape (tags, levels, message templates;
  not timestamps).
- Per-scenario epistemic-band output (current `_posteriorSlices`
  path).
- CLI parity output (per-scenario CF response and prepared scenario
  graph).

Live in `graph-editor/src/services/__tests__/__fixtures__/cf-baseline/`
(TS) and `graph-editor/lib/tests/fixtures/cf-baseline/` (Python). Each
directory has a README naming the source graph, scenario set, capture
date, and regeneration script.

### Stage gate

- The harness is in place and `cfTransactionHarness.test.ts` (a meta-
  test of the harness itself) passes: each of the eight states
  resolves to the documented internal state.
- Sentinel fixtures load and parse.
- `cfBaseline.fixture.test.ts` (TS) and `test_cf_baseline_fixture.py`
  (Python) reproduce the captured behaviour exactly on the
  post-revert tree.

## 7. Stage 1 — Per-scenario CF supersession

### Why

Defect 3a. Implement per-scenario supersession state, retire the
module-global counter, and pin the behaviour with tests that would
fail if a future refactor regressed to a global.

### Changes

1. Introduce a `ConditionedForecastSupersessionState` value type. Place
   it next to the CF service or in a small dedicated module. Shape:
   a `Map<scenarioId, generation>` plus `nextGeneration(scenarioId)`
   and `latestGeneration(scenarioId)` accessors. No singleton; no
   module-global instance.
2. Allocate one instance per tab in
   [ScenariosContext.tsx](graph-editor/src/contexts/ScenariosContext.tsx)
   (e.g. via `useMemo`). Expose it on the tab's scenario context so
   CF call sites in this tab can reach it.
3. Thread it through `FetchOptions` so
   [fetchDataService.ts](graph-editor/src/services/fetchDataService.ts)
   receives the per-tab tracker on every fetch call. Default behaviour
   when no tracker is supplied (e.g. share-bundle code path) must be
   safe — either a freshly created per-call instance or a clearly
   scoped fallback that does not cross scenarios.
4. Replace the module-global increment at `fetchDataService.ts:2263`
   with `cfSupersessionState.nextGeneration(scenarioId)`. Replace the
   stale-response check at line 2460 with a check against
   `latestGeneration(scenarioId)`.
4a. At
    [fetchDataService.ts:2269](graph-editor/src/services/fetchDataService.ts),
    pass the resolved `scenarioId` as the 5th argument to
    `runConditionedForecast`. The CF call must carry the same
    `scenarioId` used for the supersession bump in step 4 above. Without
    this, every CF self-tags as `'current'` regardless of who
    commissioned it (see §2 Defect 3a sub-defect) and the per-scenario
    tracker is keyed off one string for every entry.
5. Delete `let _conditionedForecastGeneration = 0` at line 1224. A test
   asserts the symbol is absent.
6. The literal `'current'` scenario id may default only on the Current
   tab itself. Other call sites must pass an explicit `scenarioId`.

### Call-site matrix

Every CF dispatch needs two values: a `scenarioId` (string) and a
`ConditionedForecastSupersessionState` instance. The table below
enumerates every entry point that reaches `runConditionedForecast` (via
`fetchDataService.fetchItems`) today, and pins where each value comes
from. New work in this stage must conform to this matrix; tests assert
each row.

| Call site | scenarioId source | Supersession-state source |
|---|---|---|
| `ScenariosContext.tsx:964` (live-scenario regen, including Current and named live scenarios) | The iterated `scenario.id` from `regenerateAllLive`; explicit, never defaulted | The per-tab instance owned by `ScenariosContext` (allocated via `useMemo`, exposed on the scenario context) |
| `ScenariosContext.tsx:1150` (per-scenario CF dispatch path) | Same as above | Same per-tab instance |
| `useFetchData.ts:179` (generic fetch hook used by current-tab loads) | Resolved from the active scenario via `useScenarios()`; falls back to literal `'current'` only when invoked with no active scenario context | Same per-tab instance |
| `useShareBundleFromUrl.ts:320` (share-bundle restore on boot) | Literal `'current'` — share bundles hydrate the Current tab | A freshly-allocated single-shot instance for the boot pass; discarded after hydration |
| `useShareChartFromUrl.ts:224` (share-chart restore on boot) | Literal `'current'` — same rationale | Same as share-bundle: freshly-allocated single-shot |
| `cli/aggregate.ts` → `analyse.ts` (CLI scenario commission) | The real `scenarioId` from the input bundle (post-Stage-6: `analyse.ts:176` synth-ID rebinding is removed, ID flows through verbatim) | A freshly-allocated per-call instance — CLI is single-threaded with no cross-scenario races, but the instance is still per-call to keep the contract uniform with the FE |
| `retrieveAllSlicesService.ts:1265` (slice retrieval, analysis-prep) | Literal `'current'` — slice retrieval is not scenario-scoped | A degenerate "no-track" instance: increments are no-ops, latest-check always returns true. Required so the API surface is uniform but supersession is bypassed for non-scenario flows |
| `lagHorizonsService.ts:85` (lag-horizon computation) | Same as retrieveAllSlices: literal `'current'` | Same: degenerate no-track instance |

The degenerate no-track instance is deliberate. These callers do not run
CF as a per-scenario activity; forcing them through a per-tab tracker
would either require a fake scenarioId (making logs misleading) or
require them to share a tracker they have no business writing to.
A degenerate instance documents the boundary in code.

### Stage gate

`cfPerScenarioSupersession.test.ts` (new) covering:

- Two scenarios A and B both have an in-flight CF; B's response
  arriving second does not cancel A's.
- A late response for A, returned after a newer A commission, is
  discarded.
- A late response for A, returned after a B commission only, is
  accepted.
- Module-global counter is absent (negative test:
  `_conditionedForecastGeneration` is not exported, not referenced in
  the supersession check).

Stage 0 fixtures must remain green.

## 8. Stage 2 — Pack contract freeze + extractor/compositor fixes

### Why

Defect 3b. The contract list below must exist as a single source of
truth, and the extractor + diff + compositor must implement it
faithfully. The post-revert tree has three named gaps (see Defect 3b
in §2); this stage closes them.

### The minimal projection contract

**Included** (model-bearing fields the runtime reads):

- `p.mean`, `p.stdev`
- `p.posterior.{alpha, beta, hdi_lower, hdi_upper, ess, rhat, fitted_at,
  fingerprint, provenance}` plus cohort-slice variants
- `p.evidence.{mean, stdev, n, k}`
- `p.forecast.{mean, stdev, alpha, beta, alpha_pred, beta_pred,
  n_effective, source}` — the promoted-probability surface frozen by
  doc 73b §3.2. Carrying these in the pack keeps per-scenario state
  faithful through extract → diff → recompose; without them, scenarios
  that differ in slice-resolved predictive state (which the Python
  runtime reads via `resolved.alpha_pred` / `beta_pred` /
  `n_effective`) would lose that state on rebuild.
- `p.latency.{mu, sigma, t95, path_t95, promoted_*_sd, completeness,
  completeness_stdev, median_lag_days}` plus latency posterior
- `p.n`
- `conditional_p` (same shape per condition, including posterior and
  evidence blocks)
- node `entry.entry_weight`
- node `case.variants`

**Excluded** (file-depth or source-ledger data):

- `p.model_vars[]` (source inventory — lives on graph, reconstructed on
  fetch; not carried in packs)
- raw `p.posterior.slices[]` and `p._posteriorSlices` (file-depth slice
  inventory)
- `p.fit_history[]` (file-only)
- `p.evidence.{scope_from, scope_to, source, retrieved_at}` (retrieval
  metadata)
- `p.latency.{latency_parameter, anchor_node_id}` (config)

**Conditionally included**: `p.forecast.k` is admitted only if the
audit proves a live consumer needs it after `p.n` replay is fixed
(because `k` can be derived from `p.n × p.mean` for many purposes).

### Changes

1. Pin the contract list into one canonical place — the
   `ProbabilityParam` / `EdgeParamDiff` / `NodeParamDiff` types in
   [scenarios.ts](graph-editor/src/types/scenarios.ts) — with a header
   comment naming this doc as the design source.
2. Add cross-references from
   [GraphParamExtractor.ts](graph-editor/src/services/GraphParamExtractor.ts)
   whitelists and
   [SCENARIO_SYSTEM_ARCHITECTURE.md](../codebase/SCENARIO_SYSTEM_ARCHITECTURE.md)
   to the canonical contract.
3. **Extractor**: in
   [GraphParamExtractor.ts](graph-editor/src/services/GraphParamExtractor.ts)
   `extractEdgeParams`, add `p.n` and `p.stdev` to the extracted
   fields (alongside the existing `evidence.n`). `p.stdev` is the
   conditioned dispersion scalar that Stage 4's CF apply newly writes
   to the graph (see §10 mapping table) — for it to round-trip
   through the pack it must be in the extractor. Audit the full
   contract list and add any other contract field the function
   currently skips.
4. **Diff**: in
   [GraphParamExtractor.ts::extractDiffParams](graph-editor/src/services/GraphParamExtractor.ts)
   ([lines 447–453](graph-editor/src/services/GraphParamExtractor.ts)),
   replace the `p.mean`-only inclusion gate with a contract-aware
   diff: include `p` in `diffParams` if any contract field under `p`
   differs from the base — `p.mean`, `p.stdev`, `p.evidence.*`,
   `p.posterior.*`, `p.forecast.*`, `p.latency.*`, `p.n`,
   `conditional_p`. The comparison must use the same epsilon discipline
   currently applied to `p.mean` for the numeric fields and
   value-equality for the structured ones.
5. **Compositor**: in
   [CompositionService.ts::applyComposedParamsToGraph](graph-editor/src/services/CompositionService.ts)
   ([lines 165–216](graph-editor/src/services/CompositionService.ts)),
   add explicit replay for `p.posterior`, `p.n`, and `p.stdev`
   (`p.stdev` already has a line in the existing scalar copy at
   line 170 — verify it actually fires; if it's gated only when
   `edgeParams.p` is present, ensure the new contract-aware diff
   gate from change 4 above carries `p.stdev` through). All three
   follow the existing `evidence` / `forecast` / `latency`
   shallow-merge pattern. Replace the `conditional_p` TODO no-op
   with a real merge that converts pack Record format into the
   graph's array format and
   shallow-merges per condition's nested probability + posterior +
   evidence blocks.
6. Leave
   [`buildGraphForAnalysisLayer`](graph-editor/src/services/CompositionService.ts)
   composition rules unchanged. This stage is fidelity, not restacking.

### Stage gate

`scenarioPackContractRoundtrip.test.ts` (new) and tightened assertions
in
[CompositionService.test.ts](graph-editor/src/services/__tests__/CompositionService.test.ts)
and
[windowCohortSemantics.paramPack.e2e.test.ts](graph-editor/src/services/__tests__/windowCohortSemantics.paramPack.e2e.test.ts):

- For every fixture scenario, `extract(workingGraph) → applyComposed →
  rebuiltGraph` is byte-equal to `workingGraph` on every contract field.
- For every excluded field, the rebuilt graph either does not carry it
  or carries the value sourced from the parameter file at fetch time —
  not from the pack.

Stage 0 fixtures must remain green.

## 9. Stage 3 — CF input/output observability

### Why

The user-named gaps "CF receives per-scenario graphs correctly" and
"CF returns graphs" are not currently observable from outside the
system. Without observability, the per-scenario isolation invariant is
unprovable. Stage 3 adds the observability without changing CF
behaviour.

### Changes

1. Add structured debug-level session-log entries at the CF call site in
   [fetchDataService.ts](graph-editor/src/services/fetchDataService.ts)
   capturing, for each scenario's CF call:
   - `scenarioId`
   - `effectiveDsl` (the DSL string actually sent)
   - graph fingerprint (hash of the engorged snapshot, not the raw
     payload)
   - generation counter value at commission

2. Add a complementary structured entry on the response apply path,
   capturing:
   - `scenarioId`
   - generation counter at response time
   - whether the response was applied, superseded, or discarded
   - target graph fingerprint at apply time

3. Add a test-only hook (under `__test__` or `__getCfTrace__` naming
   convention) that returns the last N CF call records from a fetch
   session. The hook must not be wired into production code paths.

### Stage gate

`cfPerScenarioRouting.test.ts` (new): in a multi-scenario regeneration,
every scenario's CF call carries that scenario's composed graph
fingerprint and effective DSL; every CF response is applied to that
scenario's graph and no other.

`cfSessionLogShape.test.ts` (new): for one regeneration, assert exactly
the expected child entries appear under the parent op, each with
expected level + tag (`CONDITIONED_FORECAST`) and the supersession
outcome present in the trace stream.

Stage 0 fixtures must remain green.

## 10. Stage 4 — Post-CF param pack upsert correctness

### Why

The user-named gap "FE upserts param packs with correct post-CF data".
The race is live in the post-revert tree:
[ScenariosContext.tsx:964](graph-editor/src/contexts/ScenariosContext.tsx)
awaits `refreshFromFilesWithRetries(...)` (which does not await
background CF promises) and then calls `extractDiffParams(...)`
immediately at line 995. If CF goes down the slow path (i.e. misses
the 500ms fast-path deadline), it lands after the diff is already
extracted — and the persisted pack omits the conditioned fields.

This race is necessary but not sufficient on its own to corrupt the
pack: with Stage 2 fixed (the `p.mean`-only inclusion gate replaced
by a contract-aware diff), the pack will faithfully reflect the
working graph at extraction time. The race determines *when* that
snapshot is taken; Stage 4 ensures the snapshot is taken *after* CF
has resolved (applied, superseded, or failed).

### Changes

1. Add an `awaitBackgroundPromises` (or equivalently named) option
   to the orchestrator entry point so callers can request "do not
   return until all background CF / late-apply promises have settled
   for this fetch". Default `false` to preserve existing behaviour
   for non-regeneration callers.
2. Thread the option through
   [fetchOrchestratorService.ts](graph-editor/src/services/fetchOrchestratorService.ts)
   and
   [fetchDataService.ts](graph-editor/src/services/fetchDataService.ts)
   to the slow-path CF handler. The handler must register its work as
   an awaitable promise that the orchestrator can collect.
3. In
   [ScenariosContext.tsx](graph-editor/src/contexts/ScenariosContext.tsx),
   pass `awaitBackgroundPromises: true` from the regeneration call
   site so `extractDiffParams` runs only after CF has resolved.
4. CF apply logic itself is unchanged. No new global. No change to the
   500ms fast-path / slow-path race semantics for non-regeneration
   callers.
5. Edge case: if CF was superseded (per Stage 1) or failed, the
   orchestrator still resolves; pack extraction proceeds against
   whatever state is on the graph. A test pins this fallback.

### CF response → graph apply mapping (binding rule §3.11)

This table is the single source of truth for which CF response field
lands where on the graph. Verified against
[conditionedForecastService.ts::applyConditionedForecastToGraph](graph-editor/src/services/conditionedForecastService.ts).

| CF response field | Graph target | Notes |
|---|---|---|
| `p_mean` | `p.mean` AND `p.forecast.mean` | Both are written today via `applyBatchLAGValues`'s `blendedMean` and `forecast.mean` arguments. The double-write into a model-bearing slot is doc 73b Stage 4 territory; **doc 73a must not change this**. |
| `p_sd` | `p.stdev` | **New: persist (decision B-narrow).** Asymptotic edge-level conditioned dispersion scalar, computed by CF as `sqrt(α·β / (s²·(s+1)))` from the conditioned posterior. Adds Stage 2 contract field and Stage 4 apply path. |
| `p_sd_epistemic` | (response-only, diagnostic) | Optional epistemic component of `p_sd`. Not persisted on the graph; remains a diagnostic in the response. |
| `completeness` | `p.latency.completeness` | Direct. CF is the authoritative writer. |
| `completeness_sd` | `p.latency.completeness_stdev` | Name converts: `sd` → `stdev`. CF is the authoritative writer. |
| `evidence_k` | `p.evidence.k` | **New: persist (decision B-narrow).** Per-scenario observed conversions at the CF horizon. Already in Stage 2 contract; Stage 4 apply path now writes from CF. |
| `evidence_n` | `p.evidence.n` | **New: persist (decision B-narrow).** Per-scenario observed arrivals at the CF horizon. Already in Stage 2 contract; Stage 4 apply path now writes from CF. |

**Sentinel-test invariant**: with sentinel-loaded scenario graphs
(Stage 0B) and a deferred CF response carrying distinct sentinel
values for every response field, after apply the graph's targeted
fields land in the expected sentinel ranges. Any field-naming or
field-routing slip fails on the specific line.

### Why these decisions

The wider BE analysis contract sends a per-scenario request graph to
each analysis endpoint, and engines (`cohort_maturity_v3`,
`epistemic_bands.py`, `forecast_state.py`) derive scenario-specific
dispersion at compute time from the per-scenario `model_vars[]`
bayesian entry (derived per scenario from the parameter file by
the FE in doc 73b's bundled switchover, Stage 4(a)) plus
scenario-specific `p.evidence.*` plus the effective DSL. The per-scenario graph is the dispersion carrier;
engines own the derivation.

In that contract, CF's response scalars are **summary outputs** at
the asymptotic τ for a single edge. Persisting them on the graph
gives consumers a self-consistent edge-level snapshot of the
conditioned answer without needing to re-run an engine for every
read. They do not replace per-row dispersion derived by engines;
they complement it.

**`posterior.alpha/beta` is NOT extended by CF**. The engines own
posterior derivation for their own outputs; adding it to the CF
response would create two sources for "the conditioned posterior"
(CF response vs. engine output) which would diverge.

### Implementation impact

- Stage 2 contract: add `p.stdev` to the included list. (`p.evidence.k`
  and `p.evidence.n` are already in the contract.)
- Stage 2 extractor: add `p.stdev` to the extracted fields.
- Stage 2 diff gate: covered by the contract-aware diff change.
- Stage 2 compositor: add `p.stdev` to the replay path.
- Stage 4 apply path
  ([conditionedForecastService.ts::applyConditionedForecastToGraph](graph-editor/src/services/conditionedForecastService.ts)):
  add the three new writes — `p_sd → p.stdev`, `evidence_k → p.evidence.k`,
  `evidence_n → p.evidence.n` — using the same per-edge merge pattern
  as `completeness*`.

### Stage gate

`scenarioRegenerationCfUpsert.test.ts` (new): after a live-scenario
regeneration completes, the persisted pack contains every CF-derived
contract field (`p.mean`, `p.evidence.*`, `p.forecast.*`,
`p.latency.completeness*`, `p.posterior.*` if CF wrote it). Reloading
the scenario from IDB and recomposing yields the same conditioned
values.

Stage 0 fixtures must remain green.

## 11. Stage 5 — Handoff to doc 73b

### Why

Earlier drafts of this plan held two halves of the per-scenario
`model_vars[]` work inside doc 73a: a "delivery" sub-stage (5a) that
shipped per-scenario bayesian material onto each request graph, and a
"cleanup" sub-stage (5c) that removed the legacy `_posteriorSlices` /
`reprojectPosteriorForDsl` paths once doc 73b had migrated BE
consumers off them. In isolation each end was inert. 5a shipped data
no consumer read; 5c could only run after doc 73b finished. The first
observable behavioural change happened inside doc 73b, three commits
into the chain.

That phasing has been retired. The whole switchover — delivery,
promotion-writer extension, and the first BE consumer migration —
now lives inside a single doc 73b stage so that the bundled commit
moves a number on screen. The remaining consumer migrations and the
legacy cleanup follow as further doc 73b stages, each one bisectable.

### What doc 73b now owns

- Per-scenario `model_vars[bayesian]` derivation from the parameter
  file's matching slice, applied at both the analysis-prep entry
  point and the CF request-build entry point. Same derivation
  function on FE and CLI.
- Extension of `applyPromotion` to project the derived bayesian (or
  analytic) source onto the full `p.forecast.*` surface defined in
  doc 73b §3.2.
- BE consumer migration off `posterior.*` / `latency.posterior.*` /
  `_posteriorSlices` and onto the canonical `p.forecast.*` surface.
- Removal of `_posteriorSlices`, `reprojectPosteriorForDsl`,
  `projectProbabilityPosterior`, `projectLatencyPosterior`,
  `resolveAsatPosterior`, the `mappingConfigurations.ts` Flow G
  stash, and the related cleanup paths in `bayesPriorService.ts`.
- The no-cross-context-fallback rule on the slice resolver
  (`resolvePosteriorSlice`'s context-stripping fallback at
  [posteriorSliceResolution.ts:167-171](graph-editor/src/services/posteriorSliceResolution.ts#L167-L171)
  must be removed at source or guarded against at the seam — see §5
  stop rule).

### What doc 73a still owns under §15A

Doc 73a still owns the per-scenario CF supersession (Stage 1), the
pack contract (Stage 2), CF observability (Stage 3), the CF response
→ graph apply mechanics (Stage 4), CLI/FE prepared-graph alignment
(Stage 6), and the verification rollup (Stage 7). The §15A
pre-handoff gates are the binding precondition for doc 73b's bundled
switchover stage; until they pass, the per-scenario request-graph
shape that the switchover relies on is not stable.

The previous 5a / 5b / 5c sub-stages are retired. The behavioural
work has moved into doc 73b's bundled switchover stage; the contract
for the derived bayesian `ModelVarsEntry` shape (probability fields
widened to carry `alpha`, `beta`, `alpha_pred`, `beta_pred`,
`n_effective`; the `derivation` provenance block; the
no-exact-slice "omit, do not substitute" rule) is now stated inside
doc 73b. Test artefacts previously listed at 5a / 5c are referenced
in doc 73b's stage gates rather than in §16 of this plan.

## 12. Stage 6 — CLI/FE alignment

### Why

FE and CLI diverge today because the CLI in
[analyse.ts](graph-editor/src/cli/commands/analyse.ts) uses the last
populated scenario graph as the base graph for later analysis
preparation, while the FE uses per-scenario graphs rebuilt from the
baseline plus packs. With doc 73a Stage 2 + Stage 4 and doc 73b's
bundled switchover (Stage 4) landed, both must consume the same
contract — including the per-scenario `model_vars[]` derivation
delivered by that switchover.

### Changes

1. Keep
   [analysisComputePreparationService.ts](graph-editor/src/services/analysisComputePreparationService.ts)
   as the single scenario-build entry point for FE and CLI. Any shared
   request-shape normalisation stays there; no CLI-only equivalent is
   created.

2. Update [analyse.ts](graph-editor/src/cli/commands/analyse.ts) and
   [aggregate.ts](graph-editor/src/cli/aggregate.ts):
   - Stop using the last populated graph as the universal base graph.
     The current `baseGraph = populatedGraph` rebinding at
     [analyse.ts:185](graph-editor/src/cli/commands/analyse.ts) must
     go; every scenario is prepared from the baseline graph plus its
     own ordered scenario packs.
   - Stop synthesising scenario IDs at the CLI boundary. The current
     `scenario-${i+1}` / `'current'` synthesis at
     [analyse.ts:176](graph-editor/src/cli/commands/analyse.ts) must
     accept and forward the real `scenarioId` from the input bundle
     so it matches the FE contract.
   - Use the Stage 2 replay contract exclusively. If the CLI keeps a
     param-pack path for editing or export, that path is separate from
     the analysis path.

3. Verify the other scenario-build surfaces that reuse
   `buildGraphForAnalysisLayer()` — live, custom, share-style consumers
   — all route through the same contract.

### Stage gate

`cliFeScenarioParity.test.ts` (new): given the same base graph, the
same ordered scenario packs, and the same effective DSL, FE and CLI
produce byte-identical scenario graphs on the contract fields, and
byte-identical BE request payloads.

Stage 0 fixtures must remain green.

## 13. Stage 7 — Verification rollup and Playwright e2e

### Why

The per-stage gates prove their own stage's invariants in isolation.
Stage 7 is the cross-cutting confirmation that the whole flow still
works in a real browser end-to-end and that no stage's invariant has
silently regressed.

### Changes

1. Author a new Playwright spec
   `liveScenarioConditionedForecastRoundtrip.spec.ts` in
   `graph-editor/e2e/`:
   - Boot the editor with a known graph fixture.
   - Create one Current scenario and at least two live scenarios with
     overlapping but distinct DSLs.
   - Wait for CF to complete on each scenario (slow-path observable
     via session log toast or DOM marker).
   - Assert per-scenario chart reads match expected per-scenario
     conditioned values.
   - Trigger a regeneration; assert post-regeneration packs reload
     correctly after a page refresh.

2. Cross-cutting assertion bundle: a single test file that re-runs
   every prior stage gate in sequence and asserts the Stage 0 fixtures
   are still byte-equal. This is the regression barrier for the next
   refactor in the area.

3. Keep the target-edge posterior-mass witness from doc 72 alive: add
   a witness assertion that captures `alpha`, `beta` on the named edge
   in the fixture set and flags any change. The plan does not require
   the witness to resolve; it requires the witness to remain visible.

### Stage gate

Playwright spec passes against a clean dev server. Cross-cutting
bundle passes. Witness assertion captures the same value as Stage 0
or, if it changed, the change is captured in the commit message.

## 14. Commit groups

The work lands in seven separately bisectable commit groups:

1. Stage 0 — Test infrastructure: deferred-CF harness, sentinel
   fixtures, golden baselines (test infra only).
2. Stage 1 — Per-scenario CF supersession state + tests (TS only).
3. Stage 2 — Pack contract pin + extractor/diff/compositor gap
   closure including `p.stdev` round-trip (TS only).
4. Stage 3 — CF input/output observability + routing tests
   (TS only; debug-level logging only).
5. Stage 4 — Post-CF upsert correctness + new field projections
   (`p.stdev`, `p.evidence.k/n`) + tests (TS only).
6. **[Doc 73b switchover bundle runs here — per-scenario delivery,
   promoted writer extension, and the first BE consumer migration.
   Then the remaining consumer migrations and the legacy-path
   cleanup. No doc 73a commits in this window.]**
7. Stage 6 — CLI/FE alignment (TS only).
8. Stage 7 — Playwright e2e + cross-cutting verification
   (test infra only).

Each commit message names the stage, the named tests added, and any
change to a Stage 0 fixture (with explicit witness).

## 15. Acceptance gates

The list is split into **§15A pre-handoff gates** (must pass before
doc 73b's Stage 3 begins) and **§15B final-cleanup gates** (depend on
doc 73b's consumer migration completing). With the per-scenario
delivery and the legacy-path cleanup both moved into doc 73b, the
§15B set is small — it pins that doc 73b's switchover and cleanup
have demonstrably landed and that doc 73a's verification rollup
(Stage 7) still passes against the post-cleanup tree. Plans complete
when all gates in both subsections hold.

### §15A — pre-handoff gates (binding for 73b Stage 3 start)

These gates are provable by the end of doc 73a Stage 4. Items that
depend on doc 73b's switchover (CLI/FE parity, the verification
rollup) live in §15B because the CLI now consumes the per-scenario
`model_vars[]` derivation that doc 73b owns.

1. CF supersession is per-scenario. Current and live scenarios do not
   cancel each other's CF responses. The module-global counter is
   absent and a test pins this.
1a. CF dispatch coverage matches §3.12: each visible user live
    scenario receives one CF commission per regen cycle, BASE
    receives none (frozen at load), CURRENT receives CF via its own
    DSL-change path, hidden scenarios receive none. CF response order
    is not assumed by any code path (§3.13).
2. Scenario packs carry only the §8 contract fields. No pack contains
   full graphs, `p.model_vars[]` inventory, raw `p.posterior.slices`,
   or `p.fit_history`.
3. A rebuilt scenario graph matches the working graph byte-for-byte on
   the contract fields for every fixture scenario.
4. CF requests carry the per-scenario composed graph and effective
   DSL; CF responses apply only to their originating scenario's
   graph. Both invariants are pinned by tests using the observability
   added in Stage 3.
5. After regeneration, the persisted pack contains all CF-derived
   contract fields. Reload + recompose yields the same conditioned
   values.
7. (Retired.) Per-scenario `model_vars[]` delivery has moved to
   doc 73b's bundled switchover stage. The acceptance gate that
   pinned per-scenario divergence on the request graph is now stated
   in doc 73b's stage 4 acceptance.
8. The Python runtime gains no parameter-file loader and no
   workspace awareness as a consequence of any stage.
11a. The Stage 0 baseline fixtures are still byte-equal at the end
    of Stage 4, except for explicitly named expected deltas captured
    in stage commit messages.
12. The target-edge posterior-mass witness is explicitly resolved
    (with stage/commit attribution) or explicitly carried forward as
    separate work. It is not silently dropped.
13a. No file in the §3.10 doc-73-owned set has been modified
    behaviourally by doc 73a work. The boundary: doc 73a must not
    change which fields the FE topo pass writes
    (`statisticalEnhancementService.ts`,
    `UpdateManager.ts::applyBatchLAGValues` write paths), must not
    migrate BE consumer reads (`model_resolver.py`,
    `forecast_state.py`, `epistemic_bands.py` read paths — these
    move to the canonical promoted surface in doc 73b), must not
    change `model_resolver.py`'s source taxonomy, must not extend
    the promotion writer (`modelVarsResolution.ts::applyPromotion` —
    doc 73b territory), and must not modify the legacy
    `_posteriorSlices` / `reprojectPosteriorForDsl` paths
    (removed in doc 73b after its consumer migration).

### §15B — post-handoff gates (binding after the doc 73b switchover bundle has landed)

The §15B gates pass only after doc 73b's bundled switchover (Stage 4)
acceptance gate has landed. They cover doc 73a work that depends on
the per-scenario `model_vars[]` derivation that switchover delivers.

9. FE and CLI produce identical prepared scenario graphs and
   identical BE request payloads from the same base graph, scenario
   packs, and effective DSL — including the per-scenario
   `model_vars[]` derivation now produced by doc 73b's switchover.
   Pinned by doc 73a Stage 6's named test
   (`cliFeScenarioParity.test.ts`).
10. The Playwright roundtrip spec passes (Stage 7).
11b. The Stage 0 baseline fixtures are still byte-equal at the end
    of Stage 6 and Stage 7, except for explicitly named expected
    deltas captured in stage commit messages. Deltas attributable to
    doc 73b's switchover are listed in doc 73b's Stage 4 acceptance,
    not here.

## 16. Testing regime — index of named artefacts

The deferred-CF transaction harness from Stage 0A is the foundation
of every CF test in stages 1–4 and 7. Tests assert the *transaction
phase* that broke (request envelope, supersession check, response
routing, apply, diff extraction), not just final values. Sentinel
fixtures from Stage 0B are loaded into every per-stage test that
touches contract-field routing.

**Per-layer reasoning**:
[73c-cf-staged-test-strategy.md](73c-cf-staged-test-strategy.md) is
the sidecar that reasons through each layer of the CF transaction
from first principles — enumerating concrete failure modes, grouping
them into the minimum diagnostic test set, and stating what each
test does NOT catch. The index below names the test artefacts; the
sidecar names the failure modes each artefact catches and why. A
test in the table below without a corresponding entry in the
sidecar is unaccounted-for coverage; a failure mode named in the
sidecar without a test in this index is a coverage gap.

| Stage | Artefact | Type | Notes |
|---|---|---|---|
| 0A | `helpers/cfTransactionHarness.ts` | Vitest helper | Deferred CF promise harness |
| 0A | `cfTransactionHarness.test.ts` | Vitest | Meta-test of the harness itself |
| 0B | `__fixtures__/sentinel/` | Fixture dir | Per-field distinct sentinel values |
| 0C | `__fixtures__/cf-baseline/` (TS) and `lib/tests/fixtures/cf-baseline/` (Python) | Fixture dirs | Golden behavioural baselines |
| 0C | `cfBaseline.fixture.test.ts` | Vitest | Loads + reproduces TS goldens |
| 0C | `test_cf_baseline_fixture.py` | pytest | Loads + reproduces Python goldens |
| 1 | `cfPerScenarioSupersession.test.ts` | Vitest | Deferred-promise harness; A/B isolation; A1/A2 ordering; module-global absent |
| 1 | `cfRequestEnvelope.test.ts` | Vitest | Per-call CF envelope: real `scenarioId`, effective DSL, scenario-specific graph fingerprint, candidate regimes, engorged parameter material; live graph not mutated |
| 2 | `scenarioPackContractRoundtrip.test.ts` | Vitest | Sentinel round-trip: extract → applyComposed → rebuilt is byte-equal on contract fields; excluded fields absent |
| 2 | tightened `CompositionService.test.ts` | Vitest | Posterior + n + conditional_p replay |
| 2 | tightened `windowCohortSemantics.paramPack.e2e.test.ts` | Vitest | Diff-gate covers all contract fields |
| 3 | `cfPerScenarioRouting.test.ts` | Vitest | Fingerprint-based routing: response A applied to graph A, never to base/current |
| 3 | `cfDispatchCoverage.test.ts` | Vitest | Each visible user live scenario receives one CF commission per regen cycle; BASE receives none (frozen at load); CURRENT receives CF only via its own DSL-change path; hidden scenarios receive none. Asserts no dispatch-order assumption (responses can return in any order). |
| 3 | `cfSessionLogShape.test.ts` | Vitest | Expected child entries, levels, tags |
| 4 | `scenarioRegenerationCfUpsert.test.ts` | Vitest | Slow CF keeps regen unresolved; persisted params recompose to post-CF values |
| 4 | `cfFieldMappingSentinel.test.ts` | Vitest | Sentinel CF response → §10 mapping table holds; `p_sd → p.stdev` is persisted; `p_sd_epistemic` is response-only and is NOT on the graph |
| 5 | (handoff — see doc 73b) | n/a | Per-scenario `model_vars[]` derivation, promoted-writer extension, BE consumer migration, and `_posteriorSlices` / `reprojectPosteriorForDsl` removal are all owned by doc 73b's bundled switchover stage and the cleanup that follows it. Test artefacts live in doc 73b. |
| 6 | `cliFeScenarioParity.test.ts` | Vitest | Same base + packs + DSL + resolver → byte-identical prepared graphs and CF payloads |
| 7 | `liveScenarioConditionedForecastRoundtrip.spec.ts` | Playwright | Real-browser end-to-end |
| 7 | cross-cutting verification bundle (file TBD) | Vitest | Re-runs every prior gate; goldens still byte-equal |

