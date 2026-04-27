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

**Dated annotation — 27-Apr-26 (closed-plan cross-doc inconsistency).**
This document is closed and its body contract is intentionally left unchanged.
Doc 73a records the earlier CF dispersion mapping
`p_sd → p.stdev` with `p_sd_epistemic` response-only. Doc 73b now carries a
newer target contract for the later L5 dispersion split:
`p_sd → p.stdev_pred` (predictive) and `p_sd_epistemic → p.stdev`
(epistemic), with `p.stdev_pred` added to the pack round-trip contract when
that later stage lands. Treat this as a known cross-doc inconsistency, not as
permission to reopen or edit the 73a stages. Reconciliation is owned by doc
73b's later implementation / follow-through work; until then, the main text
below remains the closed 73a record.

## 0. History and posture of this plan

Two prior attempts widened scope into doc 73b's territory (model-vars
vs. promoted-vars vs. current-answer separation) and broke the live
system. Posture for this revision: **do no harm**. Scope is narrow
plumbing — per-scenario CF supersession, faithful pack rebuild, the
existing CF request-graph engorgement, and CLI/FE alignment.
Functionally invariant with respect to current `p.mean` /
`model_vars[]` / `posterior.*` semantics; off-limits files in §3 rule 10.

Every stage has a baseline-capture step and a named regression gate.
No stage commits without its gate passing.

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

`edge.p.mean` is overloaded: FE topo writes the query-scoped
`blendedMean` there; the Python runtime reads it as model input.
Doc 73b Stage 3 owns the FE-side split. Doc 73a does not gate `p.mean`
writes (the fix that broke both prior attempts) — see §5 Stop rules.

### Defect 2 — Python uses two different probability-source rules (handed off to doc 73b)

`resolve_model_params` ([model_resolver.py](graph-editor/lib/runner/model_resolver.py))
reads posterior → forecast → fallback for the target edge;
`_resolve_edge_p` ([forecast_state.py](graph-editor/lib/runner/forecast_state.py))
reads `p.mean` first for the upstream carrier — the path Defect 1
poisons. Doc 73b Stage 4 owns the consumer-side unification.

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

The fix is fully owned by **doc 73b** (Stage 4): the slice library
moves from persistent stash to per-call engorgement on the request
graph. The transient engorged shape preserves today's read paths so
no BE consumer code changes; per-scenario contexting falls out from
each scenario's effective DSL driving the slice selection. The
persistent `_posteriorSlices` write on the live graph is then dead and
removed. See doc 73b §3.2, §3.2a, §6.2a, and Stage 4.

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
   model input. Enforcement is doc 73b's territory; doc 73a leaves the
   current overload alone (see rule 10 for the off-limits file list).

4. **Scenarios stay as thin ordered param-pack deltas.** Layer order is
   semantically load-bearing — later deltas override earlier ones. No
   scenario is a stored graph.

5. **Scenario packs may carry only the active projection** needed for
   rebuild. They may not carry raw `posterior.slices`, full
   `p.model_vars[]` inventory, or `fit_history`.

6. **CF supersession is per-scenario, in tab-scoped scenario state.** Not
   a module-global counter.

7. **`conditional_p` is part of the pack contract and must replay.**
   Storage form differs by layer: on the graph it is an array of
   `{condition: <DSL string>, p: {...}}` objects; in packs it is a
   `Record<string, ProbabilityParam>` keyed by the **actual condition
   string** (e.g. `conditional_p["visited(b)"]`), never by a numeric
   position. The compositor is the only place this array↔Record
   conversion happens. Each entry's `p` block is governed by the same
   rules as the unconditional `p` (resolver, lock discipline, writer
   set) — `conditional_p` is not a special case at the runtime layer,
   only at the storage layer.

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

10. **Off-limits files for doc 73a** (handed to doc 73b):
    `statisticalEnhancementService.ts`,
    `UpdateManager.ts::applyBatchLAGValues`, `fetchDataService.ts`
    write paths that touch `p.mean`; `model_resolver.py` and
    `forecast_state.py` consumer reads; `model_resolver.py`'s source
    taxonomy; `modelVarsResolution.ts::applyPromotion`; and the
    legacy `_posteriorSlices` / `reprojectPosteriorForDsl` paths.

    Doc 73a's scope at this boundary is to pin the §15A pre-handoff
    gates that doc 73b's switchover depends on (per-scenario CF
    supersession, pack contract, request-graph shape), and stop. If
    a stage appears to require behavioural changes to any off-limits
    file, the stage is mis-scoped.

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
    CF via three paths, all outside `regenerateAllLive`: (i)
    [useDSLReaggregation](graph-editor/src/hooks/useDSLReaggregation.ts)
    when `currentDSL` changes; (ii)
    [useFetchData.ts:179](graph-editor/src/hooks/useFetchData.ts) on
    initial current-tab loads; (iii) the share-bundle / share-chart
    boot restores
    ([useShareBundleFromUrl.ts:320](graph-editor/src/hooks/useShareBundleFromUrl.ts),
    [useShareChartFromUrl.ts:224](graph-editor/src/hooks/useShareChartFromUrl.ts))
    on hydration. **BASE does not receive CF.** BASE is frozen at file
    load and only changes via explicit user action — commit + close +
    reopen (the new file becomes the new base) or "put to base".
    Hidden scenarios receive no CF. The
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
- **Stage 5 is a handoff to doc 73b.** Slice-material relocation
  (persistent `_posteriorSlices` stash → per-call engorgement on the
  request graph), the narrow promoted-probability writer, the
  `*_overridden` lock-respecting writer discipline, and removal of
  `reprojectPosteriorForDsl` are all owned by doc 73b. Doc 73a only
  pins the §15A pre-handoff gates. See §11 for the handoff details.
- **Stage 6 (CLI/FE alignment) lands last among behavioural stages
  in doc 73a** because it depends on the pack contract from Stage 2.
- **Stage 7 is the cross-cutting verification rollup**, not new
  behavioural work.

The original draft's interleaving of "FE split" and "Python
unification" into doc 73a is removed. Both are doc 73b's job (see
§3.10).

## 5. Stop rules (abort signals)

These rules trigger an immediate halt. They exist because every prior
attempt failed by ignoring exactly these signals.

- **If a stage touches an off-limits file** (see §3 rule 10), stop.
  Defer to doc 73b. Phasing note: doc 73a's "no new opts gate" on
  `applyBatchLAGValues` binds only through 73a's lifetime; doc 73b
  Stage 5 may extend its argument surface to bring the function into
  the `*_overridden` lock discipline.
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

### 0D — Existing-suite regression baseline

The named per-stage artefacts (built in Stages 1–7) and the Stage 0
golden fixtures only cover what this plan adds or freezes. They do
not catch breakage in tests that already exist and exercise the
same surfaces. Stage 0D pins those existing suites as a regression
net so an agent following this plan in isolation has a complete
list of "must keep green" surfaces.

The four existing surfaces this plan must keep green:

1. **Python BE suite** — `pytest graph-editor/lib/tests/`. Includes
   the recently centralised outside-in cohort suite
   (`test_cohort_factorised_outside_in.py`, drives `analyse.sh` and
   `param-pack.sh` end-to-end on synth fixtures), the new BE
   diagnostics tests (`test_conditioned_forecast_response_contract.py
   ::TestRateEvidenceProvenanceDiagnostics`,
   `test_forecast_state_cohort.py::TestPreparedRuntimeBundle`), the
   CF response contract suite, and the existing forecast-state /
   model-resolver / cohort-maturity / temporal-regime tests. Many
   require `requires_db`, `requires_data_repo`, `requires_synth`,
   `requires_python_be` markers — capture the pass / skip set per
   environment, not just pass count.

2. **TS scenario / CF / composition / pack tests** — the relevant
   slice of `npm test` (filter by file). Concretely the existing
   `CompositionService.test.ts`, `windowCohortSemantics.paramPack.e2e.test.ts`,
   `conditionedForecastCompleteness.test.ts`, and any other test
   under `graph-editor/src/services/__tests__/` that mentions
   scenarios, packs, CF, composition, or extraction. Do not run the
   whole-repo `npm test` — too noisy, and this plan does not own
   unrelated surfaces.

3. **CLI tests** — `graph-editor/src/cli/__tests__/cliAnalyse.test.ts`
   in full. Includes the new `--diag` test that asserts BE
   diagnostics surface through the CLI; Stage 6 changes the prepared
   scenario shape and synth-ID rebinding and could break this.

4. **graph-ops parity scripts** — `graph-ops/scripts/conditioned-forecast-parity-test.sh`
   and `graph-ops/scripts/cf-topology-suite.sh` if reachable in the
   environment. These are end-to-end CLI regressions that bracket
   Stages 4 and 6.

**Capture rule**: at Stage 0 entry, run all four surfaces and
record the pass / skip / fail set into
`graph-editor/lib/tests/fixtures/cf-baseline/regression-baseline.txt`
and `graph-editor/src/services/__tests__/__fixtures__/cf-baseline/regression-baseline.txt`
(plain-text test-id lists). The same files are re-captured at the
end of every stage; the per-stage gate compares deltas. New green
tests added by the stage are expected; new fails or new skips that
were not skips before require explicit attribution in the commit
message.

**A pre-Stage-0 capture must be taken with the plan's own work
*not yet started*** — i.e. against the post-revert tree as it
exists at plan-execution time. Without that, a stage cannot prove
it preserved invariance. If the pre-Stage-0 capture shows existing
failures, those are documented as "carried-in" and not gated against
by later stages, but their disposition is recorded so an agent
working through 73a does not assume every fail it sees is a
regression it caused.

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

Stage 0 fixtures (0A–0D) must remain green; the 0D regression baseline delta must be empty (or fully attributed in the commit message).

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
- `p.forecast.{mean, stdev, source}` — the narrow promoted-probability
  surface per doc 73b §3.2. The Beta-shape and predictive fields
  (`alpha`, `beta`, `alpha_pred`, `beta_pred`, `n_effective`) are NOT
  in the pack; they reach the BE via per-call engorgement on the
  request graph (doc 73b §3.2a). Display surfaces that read the
  promoted layer (`'f'` mode, `ModelRateChart`, edge labels) need only
  the three persisted fields.
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

Stage 0 fixtures (0A–0D) must remain green; the 0D regression baseline delta must be empty (or fully attributed in the commit message).

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

Stage 0 fixtures (0A–0D) must remain green; the 0D regression baseline delta must be empty (or fully attributed in the commit message).

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
bayesian entry (engorged per scenario from the parameter file by
the FE in doc 73b's Stage 4(a)) plus scenario-specific
`p.evidence.*` plus the effective DSL. The per-scenario graph is the dispersion carrier;
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

- Stage 2 contract: `p.stdev`, `p.evidence.k`, and `p.evidence.n`
  are already included (see §8). No further additions required at
  Stage 2.
- Stage 2 extractor / diff gate / compositor: covered by the
  contract-aware diff change in Stage 2 itself; no Stage 4 work.
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

Stage 0 fixtures (0A–0D) must remain green; the 0D regression baseline delta must be empty (or fully attributed in the commit message).

## 11. Stage 5 — Handoff to doc 73b

Slice-material relocation (persistent `_posteriorSlices` stash → per-call
engorgement on the request graph), the narrow promoted-probability
writer, the lock-respecting writer discipline, and removal of
`reprojectPosteriorForDsl` are all owned by doc 73b's Stage 4 and the
cleanup stage that follows it. 73a's role at this boundary is to pin
the §15A pre-handoff gates (per-scenario CF supersession, pack
contract, request-graph shape). Doc 73b §3.2, §3.2a, §6.2a, and
Stage 4 hold the substantive contract.

## 12. Stage 6 — CLI/FE alignment

### Why

FE and CLI diverge today because the CLI in
[analyse.ts](graph-editor/src/cli/commands/analyse.ts) uses the last
populated scenario graph as the base graph for later analysis
preparation, while the FE uses per-scenario graphs rebuilt from the
baseline plus packs. With doc 73a Stage 2 + Stage 4 and doc 73b's
Stage 4 (slice-material engorgement) landed, both must consume the
same contract — including the per-scenario engorgement that 73b's
Stage 4(a) runs at analysis-prep time on each per-scenario graph.

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

Stage 0 fixtures (0A–0D) must remain green; the 0D regression baseline delta must be empty (or fully attributed in the commit message).

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

2. (Retired.) The earlier "cross-cutting assertion bundle" — a
   single test file that re-ran every prior stage gate — has been
   dropped per doc 73d's triage (a test that reruns all tests is a
   CI command, not a test). The CI configuration runs the surviving
   suite from doc 73d in sequence; that is the regression barrier
   for the next refactor.

3. Keep the target-edge posterior-mass witness from doc 72 alive: add
   a witness assertion that captures `alpha`, `beta` on the named edge
   in the fixture set and flags any change. The plan does not require
   the witness to resolve; it requires the witness to remain visible.
   Doc 73d does not list the witness as a surviving suite artefact,
   but doc 73a retains it because it is the one specific number from
   the original parity defect that must not silently move.

### Stage gate

Playwright spec passes against a clean dev server. The doc 73d
surviving suite passes (run via the CI command, not as one omnibus
test). The 0D regression baseline delta against the post-Stage-0
capture is empty or fully attributed. Witness assertion captures
the same value as Stage 0 or, if it changed, the change is captured
in the commit message.

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
6. **[Doc 73b Stage 4 runs here — slice-material relocation
   (persistent stash → per-call engorgement), narrow promoted
   writer, CF de-collapse. Then doc 73b Stage 5 (lock-respecting
   writer discipline) and Stage 6 (residual cleanup). No doc 73a
   commits in this window.]**
7. Stage 6 — CLI/FE alignment (TS only).
8. Stage 7 — Playwright e2e + cross-cutting verification
   (test infra only).

Each commit message names the stage, the named tests added, and any
change to a Stage 0 fixture (with explicit witness).

## 15. Acceptance gates

The list is split into **§15A pre-handoff gates** (must pass before
doc 73b's Stage 3 begins) and **§15B final-cleanup gates** (depend on
doc 73b's Stage 4 slice-material relocation completing). With the
per-scenario delivery and the legacy-path cleanup both moved into
doc 73b, the §15B set is small — it pins that doc 73b Stage 4 and
the residual cleanup (Stage 6) have demonstrably landed and that doc
73a's verification rollup (Stage 7) still passes against the
post-cleanup tree. Plans complete when all gates in both subsections
hold.

### §15A — pre-handoff gates (binding for 73b Stage 3 start)

These gates are provable by the end of doc 73a Stage 4. Items that
depend on doc 73b's switchover (CLI/FE parity, the verification
rollup) live in §15B because the CLI now consumes the per-scenario
`model_vars[]` derivation that doc 73b owns.

A1. CF supersession is per-scenario. Current and live scenarios do not
    cancel each other's CF responses. The module-global counter is
    absent and a test pins this.
A2. CF dispatch coverage matches §3.12: each visible user live
    scenario receives one CF commission per regen cycle, BASE
    receives none (frozen at load), CURRENT receives CF via its
    three documented paths (DSL-change re-aggregation, initial
    current-tab load, share-bundle/share-chart boot restore) and
    via no others, hidden scenarios receive none. CF response order
    is not assumed by any code path (§3.13).
A3. Scenario packs carry only the §8 contract fields. No pack contains
    full graphs, `p.model_vars[]` inventory, raw `p.posterior.slices`,
    or `p.fit_history`.
A4. A rebuilt scenario graph matches the working graph byte-for-byte
    on the contract fields for every fixture scenario.
A5. CF requests carry the per-scenario composed graph and effective
    DSL; CF responses apply only to their originating scenario's
    graph. Both invariants are pinned by tests using the observability
    added in Stage 3.
A6. After regeneration, the persisted pack contains all CF-derived
    contract fields. Reload + recompose yields the same conditioned
    values.
A7. The Python runtime gains no parameter-file loader and no
    workspace awareness as a consequence of any stage.
A8. The Stage 0 baseline fixtures are still byte-equal at the end of
    Stage 4, except for explicitly named expected deltas captured in
    stage commit messages.
A9. The target-edge posterior-mass witness is explicitly resolved
    (with stage/commit attribution) or explicitly carried forward as
    separate work. It is not silently dropped.
A10. No file in the §3.10 doc-73-owned set has been modified
     behaviourally by doc 73a work. The boundary: doc 73a must not
     change which fields the FE topo pass writes
     (`statisticalEnhancementService.ts`,
     `UpdateManager.ts::applyBatchLAGValues` write paths), must not
     change BE consumer reads (`model_resolver.py`,
     `forecast_state.py`, `epistemic_bands.py` — under doc 73b
     slice-material readers keep their existing read paths and the
     data reaches them via per-call request-graph engorgement
     instead of the persistent stash; the carrier read in
     `_resolve_edge_p` is the one consumer that does change, routed
     in doc 73b Stage 4(d) through the shared `resolve_model_params`
     resolver), must not change `model_resolver.py`'s source
     taxonomy, must not extend the promotion writer
     (`modelVarsResolution.ts::applyPromotion` — doc 73b territory),
     and must not modify the legacy `_posteriorSlices` /
     `reprojectPosteriorForDsl` paths (removed in doc 73b's Stage 6
     cleanup, after Stage 4's slice-material relocation makes them
     dead).

### §15B — post-handoff gates (binding after doc 73b Stage 4 has landed)

The §15B gates pass only after doc 73b's Stage 4 (slice-material
relocation) acceptance gate has landed. They cover doc 73a work that
depends on the per-scenario engorgement Stage 4(a) introduces.

B1. FE and CLI produce identical prepared scenario graphs and
    identical BE request payloads from the same base graph, scenario
    packs, and effective DSL — including the per-scenario engorgement
    that doc 73b Stage 4(a) runs at analysis-prep time. Pinned by
    doc 73a Stage 6's named test (`cliFeScenarioParity.test.ts`).
B2. The Playwright roundtrip spec passes (Stage 7).
B3. The Stage 0 baseline fixtures are still byte-equal at the end
    of Stage 6 and Stage 7, except for explicitly named expected
    deltas captured in stage commit messages. Deltas attributable to
    doc 73b's switchover are listed in doc 73b's Stage 4 acceptance,
    not here.

## 16. Testing regime — index of named artefacts

Tests assert the transaction *phase* that broke (request envelope,
supersession check, response routing, apply, diff extraction), not
just final values. The deferred-CF harness (Stage 0A) is the
foundation; Stage 0B sentinel fixtures load into every contract-field
test.

**Source of truth**: the active surviving suite is
[73d](73d-cf-test-strategy-triage.md) §5; doc 73d wins where it
diverges from this index. [73c](73c-cf-staged-test-strategy.md) is
kept as the per-layer reasoning archive only.

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
| 3 | `cfDispatchCoverage.test.ts` | Vitest | Each visible user live scenario receives one CF commission per regen cycle; BASE receives none (frozen at load); CURRENT receives CF via its three documented paths (DSL-change re-aggregation, initial current-tab load, share-bundle / share-chart boot restore) and via no others; hidden scenarios receive none. Asserts no dispatch-order assumption (responses can return in any order). |
| 3 | `cfSessionLogShape.test.ts` | Vitest | Expected child entries, levels, tags |
| 4 | `scenarioRegenerationCfUpsert.test.ts` | Vitest | Slow CF keeps regen unresolved; persisted params recompose to post-CF values |
| 4 | `cfFieldMappingSentinel.test.ts` | Vitest | Sentinel CF response → §10 mapping table holds; `p_sd → p.stdev` is persisted; `p_sd_epistemic` is response-only and is NOT on the graph |
| 5 | (handoff — see doc 73b) | n/a | Slice-material relocation, narrow promoted writer, lock-respecting writer discipline, and `reprojectPosteriorForDsl` removal are all owned by doc 73b's Stages 4–6. Test artefacts live in doc 73b. |
| 6 | `cliFeScenarioParity.test.ts` | Vitest | Same base + packs + DSL + resolver → byte-identical prepared graphs and CF payloads |
| 7 | `liveScenarioConditionedForecastRoundtrip.spec.ts` | Playwright | Real-browser end-to-end |
| 7 | (no separate cross-cutting bundle) | n/a | The doc 73d surviving suite, run as a CI sequence, is the regression barrier. No omnibus test file. |

---

## Appendix Z — Post-completion notes (forward-reference only, 26-Apr-26)

**Status of this appendix.** The body of this plan above is the
record of doc 73a as implemented and is not changed by this
appendix. The notes below were written after 73a's completion to
keep the cross-references to doc 73b accurate as that plan's
framing tightened during its own review. They are reference
annotations only — they do not modify, supersede, or invalidate any
section above, any stage, any gate, any test spec, or any handoff
boundary defined in 73a. If an ambiguity arises between the body
and this appendix, the body wins.

These notes restate, in the body's own terms, the same handoff
boundary already documented above; readers do not need them to
understand 73a as shipped. Their value is forward — when reading
73a alongside the latest revision of 73b, the terminology lines up.

### Z.1 Contexting vs engorgement (terminology used in 73b)

Doc 73b's revised §3.2a / Decision 15 splits what 73a referred to
generically as "request-graph engorgement" (rule 9, §15A A10, §10,
§8 pack contract) into two operations on the request-graph copy:

- **Contexting** — projection of the matching parameter-file slice
  onto the standard schema fields the live graph already
  recognises: `model_vars[bayesian]`, `p.posterior.*`,
  `p.latency.posterior.*`. In-schema only.
- **Engorgement** — writing of out-of-schema fields the BE consumes
  but the live graph never holds. Today's set, all bayes-related:
  `_bayes_evidence`, `_bayes_priors`, and (added by 73b Stage 4(a))
  `_posteriorSlices.fit_history`.

Where 73a's body says "engorgement" in handoff text (rule 9, §2
defect 3c, §8 pack contract Beta-shape note, §10 dispersion-carrier
paragraph, §15A A10, §15B B1), the corresponding 73b operation is
contexting for in-schema fields and engorgement for out-of-schema
fields. 73a's prescribed work does not depend on which of the two
produces a given field — that distinction is enforced inside doc
73b's territory.

### Z.2 Carrier-read site list (73b Stage 4(d))

73a §15A A10 names `_resolve_edge_p` in
[`forecast_state.py`](graph-editor/lib/runner/forecast_state.py)
as the one carrier-style consumer that changes under 73b Stage
4(d). The same Stage 4(d) audit confirmed today by file inspection
that two sibling sites read `p.mean` as a model input and join the
same rerouting:

- [`graph_builder.py:202`](graph-editor/lib/runner/graph_builder.py#L202)
  — `return p.get('mean')`
- [`path_runner.py:105`](graph-editor/lib/runner/path_runner.py#L105)
  — `pv = float(p.get('mean') or 0.0)`

The §15A A10 boundary statement is not narrowed by this — 73a
still does not modify any of these sites; doc 73b owns the
rerouting. Listed here only so a future reader sees the actual
audited site list rather than the single-site shorthand.

### Z.3 Live-edge re-context on currentDSL change (73b Stage 4(e))

After 73a was completed, doc 73b added Stage 4(e) — a re-context
of the live edge's `model_vars[bayesian]` / `p.posterior.*` /
`p.latency.posterior.*` whenever `currentDSL` changes — to prevent
canvas displays going stale once Stage 4(c) removes CF's
compensating write of `forecast.mean = p_mean`. §15B's "doc 73b
Stage 4 acceptance gate" precondition implicitly covers this; no
73a-side gate is added.

### Z.4 CLI subtask of 73b Stage 4(a)

73a §15B B1 requires FE/CLI byte-identical prepared scenario
graphs. Doc 73b Stage 4(a) splits out a CLI subtask (wiring the
contexting + engorgement step into the CLI's
`analysisComputePreparationService` consumer) as a binding
precondition for B1. Same precondition the body already states
("after doc 73b Stage 4 acceptance gate has landed"); flagged
here for traceability when reading the two plans side by side.

### Z.5 Share-bundle / share-chart hydration (73b Stage 4(a) coverage)

Doc 73b §4(e) clarifies that share-restore depends transitively on
73b Stage 4(a)'s rewiring of `reprojectPosteriorForDsl`
(read-from-parameter-file instead of read-from-stash), pinned by
73d's `shareRestorePosteriorRehydration.test.ts`. No 73a-side
change; noted here so the dependency is traceable from this plan.

