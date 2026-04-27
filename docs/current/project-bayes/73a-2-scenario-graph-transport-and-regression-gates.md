# 73a-2 — Scenario Graph Transport and Outside-In Regression Gates

**Date**: 26-Apr-26  
**Status**: Corrective implementation plan for doc 73a gaps  
**Audience**: engineers repairing the 73a implementation before resuming doc 73b work  
**Relates to**:
`73a-scenario-param-pack-and-cf-supersession-plan.md`,
`73b-be-topo-removal-and-forecast-state-separation-plan.md`,
`73c-cf-staged-test-strategy.md`,
`73d-cf-test-strategy-triage.md`,
`../codebase/FE_BE_STATS_PARALLELISM.md`,
`../codebase/PARAMETER_SYSTEM.md`,
`../codebase/STATS_SUBSYSTEMS.md`

## 1. Why this plan exists

Doc 73a Stage 6 was intended to align CLI and FE analysis preparation after
fixing the old CLI bug where the last populated scenario graph became the
base graph for every later scenario. The implementation fixed that base-graph
rebinding bug, but introduced a new transport defect:

1. CLI `analyse` aggregates each scenario into a full enriched
   `populatedGraph`.
2. It immediately collapses that graph through `extractParamsFromGraph`.
3. `prepareAnalysisComputeInputs(mode: custom)` rebuilds the scenario from
   the baseline graph plus those params.

That is not the BE analysis request contract. It is a lossy reuse of the
param-pack export/edit surface as an analysis transport. Param packs are
intentionally thin; they do not carry the full model-source ledger, selector,
runtime-only request material, full file-depth slice inventory, or every
runtime diagnostic field. They must not be treated as lossless scenario
graphs.

The outside-in CLI tests surfaced this gap. That is useful, but it should not
have required ad hoc investigation after 73a was reported complete. This plan
adds the missing corrective work and gates.

## 2. Ownership boundary with doc 73b

This plan owns only the 73a transport and regression-gate gaps.

Doc 73b owns all source-layer and forecast-state redesign:

- FE topo Step 1 analytic source shape, including window/cohort mirrored
  analytic probability fields.
- Removal of `p.evidence.{n,k}` and `p.mean` as model-prior inputs in
  `model_resolver.py`.
- Deletion or quarantine of `analytic_degraded`,
  `alpha_beta_query_scoped`, and related degraded-mode compensation paths.
- Promotion of selected model-source probability into
  `p.forecast.{mean, stdev, source}`.
- Separation of promoted model fields from current-answer fields.
- Fallback/degradation register and Python runner fallback audit.

This plan may cite those items as dependencies, but must not implement them
as side effects.

## 3. Binding terms

**Scenario-owned enriched graph state** means the per-scenario graph after
baseline graph, scenario DSL, fetch pipeline, FE topo Step 1, FE topo Step 2,
CF application, inbound-n propagation, promotion, and scenario visibility
projection have been applied for that scenario.

**Param pack** means the thin scenario export/edit representation defined by
doc 73a and `PARAMETER_SYSTEM.md`. It is not a full graph, not a source
ledger carrier, and not the canonical BE analysis request transport.

**Analysis request graph** means the graph included in the scenario object
sent to Python analysis / CF endpoints. For CLI and FE parity, this must be
derived from the same scenario-owned enriched graph state, with any request
contexting/engorgement applied consistently.

## 4. Defects this plan closes

### Defect A — CLI `analyse` uses param-pack transport for analysis

Current CLI `analyse` aggregates a scenario into `populatedGraph`, extracts
params, and later rebuilds the analysis graph from baseline plus params.
This drops fields by design and can change runtime behaviour.

The fix is not a CLI-specific shortcut and not a single-scenario branch. The
shared analysis preparation contract must accept scenario-owned enriched
graphs as first-class custom scenario inputs.

### Defect B — Custom analysis preparation treats params as the only custom scenario carrier

`prepareAnalysisComputeInputs(mode: custom)` currently knows how to apply
`customScenarios[].params` over a base graph. It does not treat
`customScenarios[].graph` as an authoritative scenario graph.

That makes custom mode suitable for recipe overlays but insufficient for a
caller that has already run the standard Stage 2 enrichment pipeline.

### Defect C — Param-pack parity was used as a proxy for analysis parity

Param-pack output is valuable, but parity between `param-pack` and `analyse`
does not prove that analysis transport is correct unless both surfaces are
known to consume the same enriched graph state. The failed outside-in tests
showed that this assumption was false.

### Defect D — 73a completion gates missed public-surface outside-in tests

Doc 73a's implementation gates did not require running the public CLI surface
tests that compare:

- `param-pack`
- `analyse --type conditioned_forecast`
- `analyse --type cohort_maturity`

for the same graph and DSL. Those tests are now mandatory 73a-2 gates.

### Defect E — Temporary diagnostic guards must not become design

During diagnosis, a narrow guard was added in the working tree to suppress
CF evidence-count projection in `analytic_degraded` / query-scoped-posterior
mode. That guard helped isolate the defect, but it is not a 73a-2 design.
It must be either reverted or explicitly absorbed by doc 73b's fallback
register. It must not ship as an unowned compatibility branch.

## 5. Required implementation changes

### Stage 1 — Add enriched-graph custom scenario support

Extend the custom scenario input shape used by
`prepareAnalysisComputeInputs` so a custom scenario may carry an already
enriched `graph` object.

Rules:

- If `customScenarios[].graph` is present, it is the scenario graph for
  analysis preparation.
- The service may still apply visibility-mode projection and request
  contexting/engorgement where those are part of the normal shared analysis
  path.
- It must not first reduce that graph to params and rebuild it from baseline.
- If both `graph` and `params` are present, `graph` wins for analysis
  transport. `params` may remain available for labels, diagnostics, export,
  or recipe-style callers, but cannot overwrite the graph unless explicitly
  requested by a separate, named mode.
- Existing recipe callers that only pass `params` continue to work, but tests
  must make clear that this is overlay mode, not enriched-graph transport.

Affected surface:

- `graph-editor/src/services/analysisComputePreparationService.ts`
- Type definitions for custom scenario inputs
- Any tests that construct custom scenarios

### Stage 2 — Fix CLI `analyse` scenario transport

Change CLI `analyse` so each scenario entry carries the `populatedGraph`
returned by `aggregateAndPopulateGraph`.

Rules:

- `baseGraph` remains the original graph. It must not be rebound to the last
  populated scenario.
- Scenario IDs remain externally stable and deduplicated as already fixed by
  73a.
- The CLI passes `customScenarios[].graph` to
  `prepareAnalysisComputeInputs`.
- `extractParamsFromGraph(populatedGraph)` is no longer part of the analysis
  transport. It may still be used by `param-pack` and by explicit export /
  diagnostic surfaces.
- There is no branch that says "if there is one scenario, bypass the prep
  service". The same custom-scenario graph contract is used for one or many
  scenarios.

Affected surface:

- `graph-editor/src/cli/commands/analyse.ts`
- CLI integration tests under `graph-editor/src/cli/__tests__/`

### Stage 3 — Preserve shared BE request construction

Conditioned forecast analysis and normal analysis dispatch must continue to
share the same preparation state.

Rules:

- `analyse --type conditioned_forecast` builds its CF payload from the
  prepared scenario graph, not from a separately reconstructed graph.
- `buildConditionedForecastGraphSnapshot` remains the runtime-neutral helper
  for request snapshots.
- The CLI must not import browser-only `conditionedForecastService.ts` just
  to construct payloads.
- Any request graph contexting or engorgement required by doc 73b Stage 4(a)
  is applied by the shared preparation path, not by a CLI-only branch.

Affected surface:

- `graph-editor/src/cli/commands/analyse.ts`
- `graph-editor/src/lib/conditionedForecastGraphSnapshot.ts`
- `graph-editor/src/services/analysisComputePreparationService.ts`

### Stage 4 — Add outside-in regression gates

The following tests are mandatory before 73a-2 can be called complete:

1. Public scalar identity for a single-edge `window()` DSL:
   `param-pack` `p.mean` and completeness match
   `analyse --type conditioned_forecast` and
   `analyse --type cohort_maturity` final-row outputs to the established
   tolerances.
2. Identity `cohort(A == X)` collapse matches the equivalent `window()`
   public surfaces.
3. CLI `analyse` request graph preserves model-vars and latency/path fields
   from `populatedGraph` through preparation.
4. Multi-scenario CLI analysis sends one scenario-owned graph per scenario
   and does not leak state from the last populated graph.
5. Param-pack output remains thin and unchanged except for explicitly
   approved field-list changes from doc 73a. No test should "fix" analysis
   transport by thickening param packs into whole graphs.

Primary test home:

- `graph-editor/lib/tests/test_cohort_factorised_outside_in.py`
- `graph-editor/src/cli/__tests__/cliAnalyse.test.ts`
- service-level tests for `analysisComputePreparationService`

### Stage 5 — Document and reconcile gates

Update documentation after implementation:

- Doc 73a gets a note that Stage 6's original implementation was incomplete
  until 73a-2 landed.
- `PARAMETER_SYSTEM.md` keeps the thin-by-design param-pack contract.
- `FE_BE_STATS_PARALLELISM.md` and `STATS_SUBSYSTEMS.md` must not imply that
  param packs are analysis request carriers.
- Doc 73b remains owner of source-layer / resolver / fallback-register
  semantics.

## 6. Explicit non-goals

73a-2 does not:

- Change FE topo analytic source mathematics.
- Add analytic `alpha`, `beta`, `cohort_alpha`, `cohort_beta`, or
  `n_effective` fields.
- Remove resolver fallbacks.
- Change `analytic_degraded` behaviour.
- Change `p.forecast.*` promotion.
- Change the param-pack field whitelist except for a clearly scoped doc 73a
  correction approved separately.
- Add CLI-only behaviour branches.

Those belong to doc 73b or to a later explicitly scoped plan.

## 7. Acceptance criteria

73a-2 is complete only when all of the following are true:

1. CLI `analyse` no longer uses `extractParamsFromGraph` as its analysis
   transport.
2. `prepareAnalysisComputeInputs(mode: custom)` supports scenario-owned
   enriched graphs and all callers share that contract.
3. `param-pack` remains an export/edit surface and still uses
   `extractParamsFromGraph`.
4. Outside-in CLI public-surface tests pass for the failing windows and
   identity-cohort cases that exposed the defect.
5. No CLI-only single-scenario shortcut exists.
6. Any diagnostic guard added during investigation is either removed or
   explicitly owned by doc 73b.
7. The final verification report lists the public CLI commands or tests run,
   including at least the targeted outside-in suite.
8. If 73a-2 closes under §7.1 with red outside-in tests, the full red-suite
   handoff receipt is written into doc 73b (Stage 0 gate record) before
   73a-2 can be declared complete.

## 7.1 Red-suite handoff rule

73a-2 may finish with outside-in public CLI tests still red only under this
strict condition:

- every remaining failure has a reproduced command / test name;
- the observed delta is recorded;
- the failure is assigned to a named doc 73b stage and gate;
- the same details are copied into doc 73b as the receiving handoff receipt
  (do not leave them only in doc 73a-2, chat notes, or ad hoc logs);
- the failure is not caused by CLI analysis graph transport, scenario identity,
  CF supersession, or param-pack extraction/replay mechanics.

If any remaining failure still depends on the lossy
`populatedGraph → param pack → rebuilt graph` path, 73a-2 is not complete.
If the remaining failure depends on FE topo analytic source shape, resolver
fallbacks, or promoted/current-answer separation, 73a-2 may hand it off to
doc 73b with the evidence above. That handoff is complete only when doc 73b
contains a concrete red-suite receipt entry naming the failing tests/commands,
observed deltas, assigned 73b stage/gate, and owner.

## 8. Relationship to doc 73b after 73a-2

After 73a-2, the analysis transport is no longer a confounding factor. Doc 73b
can then address the remaining substantive statistical design issues cleanly:

- FE topo Step 1 analytic source contract for window and cohort families.
- Removal of evidence-count prior synthesis in `model_resolver.py`.
- Honest analytic degradation when shape is unavailable.
- Promotion of model-source probability to `p.forecast.*`.
- Fallback/degradation register and Python runner audit.

If public-surface parity still fails after 73a-2 with transport fixed, the
remaining failure is presumed to belong to doc 73b unless proven otherwise.

## 9. Implementation receipt (27-Apr-26)

This section records the concrete 73a-2 implementation work that landed for
Defects A-D, and the verification runs used for acceptance.

### 9.1 Code changes applied

1. Shared custom-scenario transport now accepts scenario-owned enriched graphs:
   - `graph-editor/src/services/analysisComputePreparationService.ts`
   - `ChartRecipeScenarioLike` now supports optional `graph`.
   - `prepareAnalysisComputeInputs(mode: custom)` now treats
     `customScenarios[].graph` as authoritative when present.
   - Legacy params-only custom callers still work; params overlay is retained
     only when no scenario graph is provided.
2. CLI `analyse` now passes per-scenario enriched graphs directly:
   - `graph-editor/src/cli/commands/analyse.ts`
   - analysis transport no longer uses `extractParamsFromGraph`.
   - each `--scenario` aggregation result (`populatedGraph`) is passed via
     `customScenarios[].graph`.
   - `baseGraph` remains the original baseline graph.
3. Contract tests were added for graph-over-params precedence and
   params-overlay fallback:
   - `graph-editor/src/services/__tests__/analysisRequestContract.test.ts`

### 9.2 Verification runs

Commands run:

- `npm test -- --run src/services/__tests__/analysisRequestContract.test.ts src/cli/__tests__/cliAnalyse.test.ts`
- `pytest lib/tests/test_cohort_factorised_outside_in.py`

Observed result:

- targeted TS suites passed;
- outside-in public CLI parity suite passed end-to-end (`23 passed`).

### 9.3 Red-suite handoff artefacts

The recovered baseline receipt and full-suite delta evidence for any remaining
red suites are written to doc 73b Stage 0 gate records per §7.1 handoff rule.
