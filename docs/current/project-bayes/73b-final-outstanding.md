u 73b — Final Outstanding Items

**Date**: 28-Apr-26
**Status**: Open punch list — captured at end of Stage 5, with Stage 6 underway
**Related**: `73b-be-topo-removal-and-forecast-state-separation-plan.md`

> **Note (28-Apr-26)** — the outside-in CLI cohort-engine investigation (originally §4, §5, §3.7, §3.10, §8 in this doc) has been spun out to [`73f-outside-in-cohort-engine-investigation.md`](73f-outside-in-cohort-engine-investigation.md) as a single working location. Sections in this doc remain for traceability; **active engine work happens in 73f**. Items that stay in this doc: §3.1–§3.6 (transport-cleanup spot-checks), §3.8 (Playwright regression), §3.9 (surprise gauge), §7.4–§7.6 (non-engine forensic findings).

## Purpose

Stages 0–5 of plan 73b have landed. Stage 6 is in flight. This doc captures the items that remain open at this point so they are not lost when the plan itself is closed. They fall into seven sections:

1. Held-over Python test failures from Stage 4(d) acceptance.
2. Two BE regressions surfaced during Stage 4 part 2 work — superseded by §5.
3. Spot-check observations from late-stage review that point to gaps between what 73b says is happening and what production actually does.
4. The two key outside-in CLI suites that act as the load-bearing acceptance gates for cohort_maturity v3.
5. Outside-in run results from 28-Apr-26 — 10 failing tests grouped into three failure shapes.
6. Triage order — verify expected 73e closures first, then remaining spec gaps, then §5 engine work.
7. Additional forensic review findings from a static 73a/73b implementation pass.

None of these is a Stage 6 entry condition; they are tracked here for follow-up.

### Return note after 73e

`73e-FE-construction.md` is in progress and is expected to close several of the transport/materialisation gaps below. When returning to this punch list after 73e lands, the first item of business is a verification pass: test or inspect the 73e-covered items, mark the confirmed closures here, and only then move on to the cohort-engine failures in §5.

Expected 73e closures to verify first:

- §3.1 — production DSL re-contexting updates the full in-schema Bayesian surface, including `model_vars[bayesian]` and promotion.
- §3.2 — custom/f+e analysis preparation and chart-write graph snapshots do not mutate or persist request-only Bayes runtime fields.
- §3.4 / §7.1 — CLI `analyse`, including `conditioned_forecast`, exercises the prepared-analysis dispatch surface and forwards compute-affecting display settings.
- §7.2 — `parity-test` is either removed or no longer treated as a 73a/73b parity signal.
- §7.5 — only if implemented as part of 73e Stage 5: missing posterior slices clear stale graph projection rather than leaving old in-schema Bayesian fields in place.
- §3.7 / §5 Group 3 — 73e Stage 6 should provide the `--no-be` diagnostic needed to separate FE/materialisation divergence from BE/CF-engine divergence; it is not expected to fix the underlying engine arithmetic by itself.

### Verification status — 28-Apr-26 (after 73e closure)

Source-inspection pass against the 73e implementation. Five of six expected closures confirmed; one is still open with a contradiction between docstring and implementation that needs a deliberate triage call.

| 73b item | Status | Evidence |
|---|---|---|
| §3.1 production re-contexting upserts `model_vars[bayesian]` + runs promotion | **CLOSED** | [posteriorSliceContexting.ts:290-309](../../../graph-editor/src/services/posteriorSliceContexting.ts#L290) — `contextLiveGraphForCurrentDsl` now runs `syncBayesianAndPromote` over every edge and conditional `p`. Builds a `bayesian` ModelVarsEntry with quality gate, calls `upsertModelVars` then `applyPromotion`. `model_vars[analytic]` preserved (upsert keys on `source`). [useDSLReaggregation.ts:107-127](../../../graph-editor/src/hooks/useDSLReaggregation.ts#L107) calls it on every DSL change via the production hook. |
| §3.2 f+e prep mutation + chart-write leak | **CLOSED** | [analysisComputePreparationService.ts:578](../../../graph-editor/src/services/analysisComputePreparationService.ts#L578) — `cloneGraphWithoutBayesRuntimeFields` runs unconditionally for any custom-mode caller-provided graph, before recontexting/engorgement. Persistence side: [repositoryOperationsService.ts:888,1176](../../../graph-editor/src/services/repositoryOperationsService.ts#L888) strips on the way out (covers chart-file writes routed through the repo write path). |
| §3.4 / §7.1 CLI conditioned_forecast prepared dispatch + display_settings | **CLOSED** | [analyse.ts:340](../../../graph-editor/src/cli/commands/analyse.ts#L340) goes through `runPreparedAnalysis(prepared)`; the direct `/api/forecast/conditioned` POST and the hand-rolled snapshot are gone. [analysisComputePreparationService.ts:884-896](../../../graph-editor/src/services/analysisComputePreparationService.ts#L884) dispatches CF via `graphComputeClient.forecastConditionedScenarios` with `displaySettings: prepared.displaySettings` forwarded. |
| §7.2 `parity-test` retired | **CLOSED** | File deleted in commit `a1f6f2b5` (28-Apr-26 "73b -- remedials"). |
| §7.5 missing-slices branch clears stale projection | **CLOSED** | Decided 28-Apr-26: strict-clear is the contract, matching the asat-no-fit branch. [posteriorSliceContexting.ts:73-85](../../../graph-editor/src/services/posteriorSliceContexting.ts#L73) now wipes `p.posterior` and `p.latency.posterior` when the parameter file carries no slices. Test at [posteriorSliceContexting.test.ts:192](../../../graph-editor/src/services/__tests__/posteriorSliceContexting.test.ts#L192) inverted to assert the wipe. |
| §3.7 / §5 Group 3 `--no-be` triage flag | **CLOSED** | [analyse.ts:111,150-156,342-347](../../../graph-editor/src/cli/commands/analyse.ts#L111), [paramPack.ts:42-47,114-117](../../../graph-editor/src/cli/commands/paramPack.ts#L42), [aggregate.ts:32-34,96](../../../graph-editor/src/cli/aggregate.ts#L32), `BackendCallsSkippedError` thrown in `runBackendAnalysis`. Tests in [cliNoBe.test.ts](../../../graph-editor/src/cli/__tests__/cliNoBe.test.ts). Note: this is instrumentation, not an engine fix — Group 3 itself remains under §5. |

---

## 1. Held-over Python failures (Stage 4(d) acceptance)

Eight Python tests are still red after the Stage 4(d) §6.5 reroute landed in [graph-editor/lib/runner/graph_builder.py](graph-editor/lib/runner/graph_builder.py) and [graph-editor/lib/runner/path_runner.py](graph-editor/lib/runner/path_runner.py). The reroute is in effect — every direct `p.mean` carrier read now goes through `resolve_model_params` first and falls back through `_warn_legacy_pmean_carrier` only via the §3.8 documented path — but it does not change the numerical outputs of these eight cases.

The failure mode is `cohort multi-hop midpoint != product of single-hop midpoints` (one case is ~641% off). That is not a §6.5 carrier-read symptom. The arithmetic gap originates inside `cohort_forecast_v3`'s multi-hop composition step, which is independent of the §6.5 reroute work. This overlaps with the territory of [47-multi-hop-cohort-window-divergence.md](47-multi-hop-cohort-window-divergence.md) and should be picked up as a continuation of that line, not as a 73b atom.

**Action**: investigate as a cohort-engine math issue in the 47-series, not as a 73b carrier-read issue.

## 2. Two BE regressions with unknown root cause (superseded by §5)

`test_cohort_factorised_outside_in::test_low_evidence_*` (two cases) regressed during Stage 4 part 2 work and remained red. Two hypotheses (atom 5's analytic `onset_mu_corr` extraction; atom 5's `_src.forecast_mean` preference) were experimentally **falsified** — Option C `onset_mu_corr = 0` override and revert of the `_src.forecast_mean` preference each left the failures unchanged.

The full 28-Apr-26 test run (see §5) revealed that these two failures are not isolated regressions but instances of a wider Group 3 pattern (low-evidence cohort drifts ~60% from the factorised oracle on `synth-simple-abc b→c`). Treat §5's Group 1 / 2 / 3 framing as the authoritative picture; this section's narrower "two regressions" framing is retained only for traceability.

## 3. Spot-check observations

These were surfaced during a late-stage review and are recorded as-found. Each one is a real gap; whether to close it now or carry it as known-debt is a separate call.

### 3.1 `posteriorSliceContexting` does not update `model_vars[bayesian]` in production

73b Stage 4(a/e) says re-contexting projects onto `model_vars[bayesian]`, `p.posterior.*`, and `p.latency.posterior.*`.

In production, [graph-editor/src/hooks/useDSLReaggregation.ts](graph-editor/src/hooks/useDSLReaggregation.ts) only calls `contextLiveGraphForCurrentDsl`. It does **not** upsert the bayesian model_vars and does **not** re-run promotion. After a DSL change, `p.forecast.*` is stale on the live graph.

The test [liveEdgeReContextOnDslChange.test.ts](graph-editor/src/services/__tests__/liveEdgeReContextOnDslChange.test.ts) manually performs the missing upsert in its helper and so passes despite the production gap. The test is asserting an end state that production does not actually reach via the production hook path.

**Action**: either move the bayesian upsert + promotion into the production re-contexting flow, or rewrite the test to exercise the actual production path. As-is, the test does not protect against the regression it is named for.

### 3.2 `prepareAnalysisComputeInputs` can mutate the caller's graph in custom mode

In [graph-editor/src/services/analysisComputePreparationService.ts](graph-editor/src/services/analysisComputePreparationService.ts), for `visibility_mode: 'f+e'`, `applyProbabilityVisibilityModeToGraph` returns the original graph object (no copy on this branch), and then `recontextScenarioGraph` mutates it in place — engorging `_posteriorSlices`, `_bayes_evidence`, and `_bayes_priors` onto the live object.

This violates 73b's "request-graph copy only" rule and risks transient BE-request fields leaking back onto the live or restored graph the user is editing.

**Action**: ensure the f+e branch goes through a deep clone before any engorgement. Add a mutation-detection test (input-vs-output identity check on the live graph after `prepareAnalysisComputeInputs` returns) so the rule is enforced going forward.

### 3.3 CF / analysis parity coverage is thinner than the test names imply

`buildConditionedForecastGraphSnapshot` in [graph-editor/src/lib/conditionedForecastGraphSnapshot.ts](graph-editor/src/lib/conditionedForecastGraphSnapshot.ts) only engorges. It does not perform DSL contexting.

[cfAndAnalysisDerivationParity.test.ts](graph-editor/src/services/__tests__/cfAndAnalysisDerivationParity.test.ts) is named to suggest it covers `model_vars[bayesian]` parity, but its assertions are scoped to `p.posterior`, `p.latency.posterior`, and `_posteriorSlices`. The bayesian model_vars surface is not asserted.

**Action**: either rename the test to reflect its actual scope, or extend it to assert `model_vars[bayesian]` parity end-to-end. Renaming is the lower-risk move; extension is the higher-value move.

### 3.4 73a transport core is aligned; cliAnalyse coverage remains thin for non-CF analyses

73a's core transport rules look broadly aligned: CLI `analyse` passes `populatedGraph` via `customScenarios[].graph`; graph wins over params; `extractParamsFromGraph` is not used for analysis transport.

The remaining 73a concern is coverage. Many cases in `cliAnalyse.test.ts` manually `POST` to the backend rather than exercising the public `analyse` command path. That means non-CF analyses are tested at the wrong seam — the test suite asserts BE behaviour given a payload, not that the CLI builds the right payload.

**Action**: convert non-CF cases to exercise the public command path so the CLI surface is what is under test.

### 3.5 Stale comment in `test_carrier_read_via_shared_resolver.py`

[graph-editor/lib/tests/test_carrier_read_via_shared_resolver.py](graph-editor/lib/tests/test_carrier_read_via_shared_resolver.py) still contains a comment claiming that `graph_builder.py` and `path_runner.py` are "kept on `p.mean`". After Stage 4(d), both files now route those reads through `resolve_model_params` first and only fall back to a logged `p.get('mean')` read via `_warn_legacy_pmean_carrier`.

**Action**: update the comment to reflect the §6.5 reroute. Trivial edit; flag here so it does not get lost.

### 3.6 Pre-retirement contract pins after Stage 6 discriminator retirement

Stage 6 (28-Apr-26) retired the `alpha_beta_query_scoped` discriminator on the source side: property collapsed to `False`, all `already_query_scoped` consumer branches removed, `is_cf_sweep_eligible` / `get_cf_mode_and_reason` reduced to constants, `analytic_degraded` consumer branches removed in TS and Python. Test surface still carries assertions written against the *pre*-retirement contract. They were left untouched in Stage 6 — the user's instruction was that test failures here may indicate genuine CF-machinery faults the discriminator was previously hiding, not test maintenance.

The pins fall into two categories:

**Category A — source-text existence pins.** These are `re.search` checks on source files for literal strings that no longer exist after retirement. Their assertion subject is "the discriminator code is still in the source". They were placed deliberately as Stage 0 retirement gates and are expected to fail when the gate triggers.

- `test_register_entry_3_analytic_degraded_projection_guard_present` ([test_stage0_fallback_register_pinning.py:90](graph-editor/lib/tests/test_stage0_fallback_register_pinning.py#L90))
- `test_register_entry_3_emitter_present_in_runtime` ([test_stage0_fallback_register_pinning.py:125](graph-editor/lib/tests/test_stage0_fallback_register_pinning.py#L125))

**Category B — pins on the discriminator's True branch behaviour.** These set up `source='analytic'` and assert outputs that *only* hold when the True branch fires (no conjugate update, no blend application).

- `test_query_scoped_direct_read_analytic` ([test_non_latency_rows.py:155](graph-editor/lib/tests/test_non_latency_rows.py#L155)) — line 158 asserts `resolved.alpha_beta_query_scoped is True`. After retirement that property is unconditionally `False`.
- `test_query_scoped_direct_read_analytic_again` ([test_non_latency_rows.py:170](graph-editor/lib/tests/test_non_latency_rows.py#L170)) — same `is True` guard.
- `test_query_scoped_model_bands_match_posterior` ([test_non_latency_rows.py:276](graph-editor/lib/tests/test_non_latency_rows.py#L276)) — asserts `model_midpoint == midpoint`; the `model_*` band is the unconditioned prior, so equality only holds when no conjugate update fires.
- `test_blend_non_latency_skip_query_scoped` ([test_non_latency_rows.py:338](graph-editor/lib/tests/test_non_latency_rows.py#L338)) — asserts `blend_skip_reason == 'source_query_scoped'`. That skip reason only existed as the True-branch's blend-suppression marker.

**Pure source-existence pins on retired text.** Same shape as Category A.

- `test_doc56_phase0_behaviours.py:675-676` — asserts `cf_mode == "analytic_degraded"` for window/cohort daily output. After retirement `cf_mode` is always `'sweep'`. The surrounding test (`test_bayesian_sidecar_preserves_downstream_window_cohort_chart_split`) also carries a load-bearing `window_total != cohort_total` and per-day `x` / `y` divergence assertion — those are *not* discriminator pins and any failure of those is real CF behaviour.
- The whole of `test_cf_query_scoped_degradation.py` — built around the retired contract.
- `test_wp8_default_off.py` — patches `alpha_beta_query_scoped` to False and asserts post-Stage-2 behaviour; should still pass but the comments name a now-non-existent toggle.
- `test_forecast_state_cohort.py:721` — comment claims `resolved.source = 'analytic'` toggles the property; that's no longer true. Comment-only.

**Action**: review each pin against the new source code. Distinguish (i) pins that were deliberately retirement gates and should be deleted, from (ii) tests whose numerical expectations are now wrong because the underlying CF arithmetic on the conjugate-update path produces a *different* answer than the discriminator's shortcut did. Category (ii) is the one that may be unmasking CF bugs rather than expecting test updates.

### 3.7 FE E2E parity echo: `abBcSmoothLag` blended-reach undershoot

After Stage 6 (and the subsequent Atom A revert that restored `bayesPriorService.ts` `_posteriorSlices` cleanup hygiene), the full vitest suite reports **1 remaining failure**: [abBcSmoothLag.paramPack.amplitude.e2e.test.ts:748](graph-editor/src/services/__tests__/abBcSmoothLag.paramPack.amplitude.e2e.test.ts#L748) — `Jul–Aug window reach(to(C)) is stable; f+e (blended) > e (evidence-only) after step-up`. The test asserts `reachBlended ∈ [0.16, 0.22]` after a step-up in evidence; observed `reachBlended = 0.125`.

Behavioural invariant, not a contract pin. The test is run end-to-end through the param-pack stats pipeline on a synth-simple-ABC `b→c` step-up scenario. The undershoot is most plausibly the FE-side analogue of §5 Group 3 (low-evidence cohort drifts ~60% from the factorised oracle, same `synth-simple-abc b→c` shape). Likely causes from Stage 6 source edits, in order of likelihood:

1. Analytic-source edges now run conjugate update + blend instead of the direct-read shortcut — analytic α/β shifts toward the query window's evidence and the post-update mean drops for this fixture.
2. `_compute_blend_params` no longer skips for analytic, so doc 52 blend now applies where it was previously skipped — moment-matched output drifts.
3. `_non_latency_rows` model_* band path now executes the prior-bands branch unconditionally for analytic, cascading into reachBlended via the bands the param-pack reads from.

Should be triaged alongside §5 Group 3 — same suspected root cause, different surface.

#### Triage hint via 73e Stage 6 `--no-be` (28-Apr-26)

Stage 6 added a CLI `--no-be` flag (and corresponding `FetchOptions.skipBackendCalls`) that suppresses every BE-bound call in a run. Under that flag, `p.mean` reduces to FE-topo Step 2 only (evidence.k/n), since CF — the only BE writer of `p.mean` for analytic edges — is gated.

The abBcSmoothLag test [already independently asserts](graph-editor/src/services/__tests__/abBcSmoothLag.paramPack.amplitude.e2e.test.ts#L752-L753) that `reachEvidence` (computed from `p.evidence.mean`) lands in `[0.185, 0.19]` for the same Jul–Aug window. Under `--no-be`, `reachBlended` and `reachEvidence` collapse to the same scalar (both read FE-topo `p.mean` = evidence.mean), so `reachBlended ≈ 0.185–0.19` — comfortably inside the `[0.16, 0.22]` tolerance the failing assertion checks.

That is the triage signal the plan called for: the failing scalar comes into tolerance when CF is suppressed. The divergence is in BE arithmetic, almost certainly CF — consistent with §5 Group 3's low-evidence-cohort defect, which is the cohort-mode analogue. Numerical re-run under the flag is the follow-up; the qualitative direction is already pinned.

### 3.8 Playwright regression — `shareLiveChart` distinct-scenario-graphs (post-73e)

After 73e merged, the Playwright suite reports a new red test: [shareLiveChart.spec.ts:1763](../../../graph-editor/e2e/shareLiveChart.spec.ts#L1763) — `live share (conserve-mass fixture) produces distinct scenario graphs + non-empty inbound-n (regression)`.

Symptom: the test polls the FE's `lastAnalyzeRequest` payload and asserts the two scenario graphs in `scenarios[0].graph.edges` and `scenarios[1].graph.edges` carry **different** `p.mean` on a key edge. The poll predicate returns `"ok"` when distinct or `"equal:<value>"` when identical. After the 60 s timeout, the predicate is still returning `"equal:0.7826"` — both scenarios end up with the same `p.mean = 0.7826` on that edge, so the analyse request payload contains two copies of the same scenario state.

The test name flags this explicitly as a **regression** — it was passing before and is the share-side proxy for "share assembled scenario graphs correctly". Live shares carry DSL only and re-materialise from base; if both scenarios materialise to the same numbers, either:

1. The new uniform materialisation (Stage 5 item 7) is overwriting per-scenario differences when running FE topo, by re-deriving `p.mean` from the same shared file state without applying each scenario's effective DSL projection correctly; or
2. Stage 4's removal of TS-side `applyProbabilityVisibilityModeToGraph` has a downstream effect for the live-share path that wasn't covered by the audit (audit covered scalar-runner consumers, not the share-restore-into-`lastAnalyzeRequest` flow); or
3. Stage 1's clone-and-strip is being applied somewhere that strips a scenario-distinguishing field that wasn't request-only (unlikely given the helper's narrow field list).

**Action**: investigate from the test's captured `conserve-mass:lastAnalyzeRequest.json` and `share.db-snapshot.json` attachments. The fastest probe is to compare the two scenarios' `effective_query_dsl` and `graph.edges[k].p` for the key edge — if effective DSLs differ but graphs are identical, the materialisation pipeline is collapsing them; if effective DSLs are also identical, the share-restore is producing the same scenario twice and the bug is upstream in `ScenariosContext` regeneration.

This is a real ship blocker — the failing PW test gates `Release aborted`.

### 3.10 Cohort-engine diagnosis — research annotations against COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md

**Status**: research-only annotations on the §5 Group 3 failure (`test_low_evidence_cohort_matches_factorised_convolution_oracle` on `synth-simple-abc` `b→c` with `cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)`). Evidence-backed observations only; mechanism for the catastrophic median collapse is **not yet** isolated. No fixes proposed.

Reference doc: [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) (canonical semantic contract — review pack 1 of 3).

#### A — Outside-in tests run on analytic source, not bayes posterior

Per the canonical doc's "subject-side reuse rule" (lines 381-403), bayesian posterior projection is the principled source for X→end subject behaviour. The test decorator `@requires_synth(_SIMPLE, enriched=True)` reads as "fixture should carry commissioned posteriors".

Evidence:
- [synth-simple-abc-simple-b-to-c.yaml](../../../nous-conversion/parameters/synth-simple-abc-simple-b-to-c.yaml) carries only `values:` (raw evidence), `latency:`, and `metadata:` blocks. No `posterior:` block. No `model_vars:` block.
- CLI YAML output reports `promoted_source: analytic` for the failing edge.
- [model_resolver.py:486-506](../../../graph-editor/lib/runner/model_resolver.py#L486) reads `n_effective` from the bayesian posterior block when `promoted_source == 'bayesian'`; falls back to `_src.get('prob_*_n_effective')` for analytic. The synth fixture's analytic source layer doesn't carry these fields.

Status: **evidence-backed factual observation**. Whether it is itself a defect or simply means "this fixture wasn't bayes-commissioned" needs a separate decision (does `enriched=True` formally require posterior data, or is it a convention?).

Implication for diagnosis: every cohort assertion in the outside-in suite that passed prior to 73b §3.9 retirement was passing under the analytic-source path with the `alpha_beta_query_scoped` discriminator's True branch active. Post-retirement that path is gone (see C below). This puts the suite under stronger pressure than the pre-retirement code ever exercised.

#### B — `n_effective` missing → doc-52 blend skips → cohort dispersion only, not median

Evidence:
- [forecast_state.py:1020-1042](../../../graph-editor/lib/runner/forecast_state.py#L1020) `_compute_blend_params` returns `applied: False, skip_reason: 'n_effective_missing'` when `getattr(resolved, 'n_effective', None) is None`.
- CLI diagnostic (cohort_maturity row metadata): `m_S: 0.00227, m_G: null, skip_reason: n_effective_missing`. The blend in [forecast_state.py:802-817](../../../graph-editor/lib/runner/forecast_state.py#L802) does not run.

Status: **evidence-backed**. As correctly noted in review, this on its own is a dispersion-only effect (`p_draws` mix vs `p_draws_unconditioned` mix). It cannot explain a 60-70% median collapse. **Logged for traceability but ruled out as the catastrophe mechanism.**

#### C — `is_cf_sweep_eligible` is unconditionally `True`; the deterministic prior path is dead code

Evidence:
- [forecast_runtime.py:513-521](../../../graph-editor/lib/runner/forecast_runtime.py#L513) — `is_cf_sweep_eligible` is now a no-op returning `True` for any input. Inline comment: "All edges are sweep-eligible post doc 73b §3.9 / Decision 13. Retained as a no-op for callers that still pass the flag onto bundles or response payloads; the discriminator branching it once gated has been retired."
- [forecast_runtime.py:524-529](../../../graph-editor/lib/runner/forecast_runtime.py#L524) — `get_cf_mode_and_reason` likewise unconditional `('sweep', None)`.
- [cohort_forecast_v3.py:1370](../../../graph-editor/lib/runner/cohort_forecast_v3.py#L1370) — `if not _sweep_eligible:` branch never fires. The branch routes to [`_query_scoped_latency_rows`](../../../graph-editor/lib/runner/cohort_forecast_v3.py#L409) (which uses prior α/β with the deterministic latency CDF and **no conjugate update or sweep**, per its own docstring "Deterministic rows for degraded or zero-evidence latency edges"). That entire function is currently unreachable from `compute_cohort_maturity_rows_v3`.

Status: **evidence-backed**. This is the structural change that 73b §3.9 / Decision 13 made and the §5 / §6 punch list working hypothesis ("the retired discriminator was masking real CF issues") is now mechanically pinned to it: every cohort_maturity query, regardless of evidence quality or analytic-source state, runs the full population sweep. The "low evidence and short horizon → use the prior with the deterministic CDF" route that previously produced oracle-correct numbers for cases like the failing test no longer exists.

Open question for review: was retiring `_query_scoped_latency_rows`-as-a-route the intent of Decision 13, or only the retirement of the discriminator's True branch in the conjugate-update path? The function still exists as code; only the dispatch is dead. If the deterministic-prior route was always supposed to remain available for short-horizon / zero-evidence cohorts, this is a fix candidate (re-introduce a horizon/evidence-aware gate).

#### D — Sweep mechanism: where the actual median collapse enters — *not yet isolated*

Investigation traced through:
- [forecast_state.py:713-793](../../../graph-editor/lib/runner/forecast_state.py#L713) — aggregate IS conditioning. For our test, this loop is keyed off `evidence` (per-cohort `(tau_i, n_i, k_i)` tuples). Line 731: `if n_i <= 0 or k_i <= 0: continue`. Our cohorts have `k_i = 0` (events haven't reached completion in the 2-day horizon), so **the aggregate IS step skips every cohort** and `n_cohorts_conditioned` stays 0. `p_draws` therefore retains the prior — aggregate IS is **not** the source of collapse.
- [forecast_state.py:1149-1173](../../../graph-editor/lib/runner/forecast_state.py#L1149) — per-cohort IS inside `_evaluate_cohort`. Guard at L1152: `if E_eff > 0 and a_i > 0 and _E_fail >= 1.0:`. With `k_i=0` and prior CDF at small `a_i` → `E_i ≈ 0`, so `E_eff = max(0, 0) = 0` and the IS step **also doesn't fire**. So per-cohort IS is **not** the source either.
- [forecast_state.py:1175-1220](../../../graph-editor/lib/runner/forecast_state.py#L1175) — Pop D (frontier survivors) and Pop C (post-frontier upstream arrivals) computation. Per the canonical doc lines 288-294 (factorised cohort numerator), Pop D and Pop C are the two future-numerator additive terms. The sweep code matches this shape (`Y_forecast = k_i + Y_D + Y_C`, `X_forecast = N_i + X_C`). Mechanically the right factorised arithmetic.

Where the mechanism MAY enter — needs follow-up:
- The CLI diagnostic dump showed two evidence rows `n=4941 k=0` and `n=3535 k=0`. The 4941 matches `anchor_n_daily[80]` (a-arrivals on 1-Mar) in the parameter file. So the cohort-frame evidence is **anchor-rooted** (a-arrivals), not subject-rooted (b-arrivals). The canonical doc rule at L156-160 prohibits "letting the denominator side quietly consume subject-end semantics". If `cohort.x_frozen` (the per-cohort `N_i` consumed at [forecast_state.py:1100](../../../graph-editor/lib/runner/forecast_state.py#L1100)) is being populated with raw a-arrival counts rather than X-rooted carrier-discounted arrivals at b, that would put a wrong-clock denominator into the per-cohort sweep. The mechanism would be: too-large `N_i` → too-large `X_forecast` → median rate `Y/X` collapses while the (uncondition-flavoured) Y-side stays comparatively close to oracle.
- Alternatively, the `m_S = 0.00227` value (probability-mass-shaped, not count-shaped) suggests that `_mass_from_cohorts` is summing something normalised, while `cohort.x_frozen` consumed by the sweep may be a different, raw-count-shaped field. If the per-cohort `N_i` in the sweep and the `m_S` in the blend disagree on units, the divergence interpretation is harder to pin without reading the cohort builder ([cohort_forecast_v3.py:720-1000](../../../graph-editor/lib/runner/cohort_forecast_v3.py#L720) `build_cohort_evidence_from_frames`).

Status: **partial trace, mechanism not isolated**. Need to read `build_cohort_evidence_from_frames` end-to-end to confirm what `cohort.x_frozen` actually carries for this query (a-rooted count, b-rooted count, or carrier-discounted mass) before claiming a defect against the doc's L156-160 separation rule.

#### E — Mapping to the canonical doc abstractions

Per the doc lines 449-479 (general abstraction points), the implementation should expose:
1. `population_root` — selected population definition
2. `carrier_to_x` — denominator-side A→X object
3. `subject_span` — numerator-side X→end object
4. `numerator_representation` — factorised vs gross-fitted
5. `admission_policy` — reuse rule

[forecast_runtime.py:137,203,297,501](../../../graph-editor/lib/runner/forecast_runtime.py#L137) and the bundle construction in [cohort_forecast_v3.py:1196-1294](../../../graph-editor/lib/runner/cohort_forecast_v3.py#L1196) confirm that `PreparedForecastRuntimeBundle` does carry `carrier_to_x`, `numerator_representation` (set to `'factorised'` at L1216), `p_conditioning_evidence`, etc. The skeleton matches the doc's abstractions. Whether each object is **populated correctly** for a single-hop A≠X cohort under short-horizon / analytic-source conditions is exactly the open research question in D above.

#### Retracted earlier claims (for traceability)

I previously asserted that the catastrophic collapse came from a lag-blind conjugate update at [cohort_forecast_v3.py:124](../../../graph-editor/lib/runner/cohort_forecast_v3.py#L124) (`alpha_post = alpha_prior + sum_y; beta_post = beta_prior + (sum_x - sum_y)`). That claim was on the wrong code path. Line 124 is inside `_non_latency_rows`, gated by `if not _is_latency_edge` at [cohort_forecast_v3.py:1304](../../../graph-editor/lib/runner/cohort_forecast_v3.py#L1304). The b→c parameter file carries `latency.latency_parameter: true` (line 1351 of the YAML), so `_is_latency_edge = True` and `_non_latency_rows` does not run for this test. Retracted.

#### Recommended next research steps (not fixes)

1. Read [build_cohort_evidence_from_frames](../../../graph-editor/lib/runner/cohort_forecast_v3.py#L720) to identify what `x_frozen` / `y_frozen` semantically carry, especially for A≠X single-hop cohort with short horizon. Confirm whether they're carrier-discounted or raw.
2. Add per-cohort instrumentation (or read existing `[v3-debug]` prints at [forecast_state.py:1222-1248](../../../graph-editor/lib/runner/forecast_state.py#L1222), which fire when `upstream_cdf_mc is not None and reach > 0`) to capture per-cohort `N_i, k_i, a_i, X_C, Y_C` values during the failing run. The numbers will tell us whether the `Y/X` collapse is in the denominator (X) or numerator (Y) side.
3. Assess whether re-introducing a horizon/evidence-aware route to `_query_scoped_latency_rows` (or equivalent) is the right structural answer for the short-horizon analytic-source case. Decision 13's intent in retiring the discriminator may not have been to retire this dispatch route, only the discriminator's specific True branch in the conjugate-update path.

### 3.9 Surprise gauge has stopped working (post-73e)

User-reported regression: the surprise gauge analysis no longer works. Details TBD — needs reproduction and triage.

`surprise_gauge` is a runner-analyze type that requires BE compute (it dispatches via `/api/runner/analyze`). It is one of the analysis types listed in 73e Stage 6 item 5 as requiring BE-side compute (hence subject to `--no-be` fail-fast). Likely 73e-related candidate causes, in rough order of plausibility:

1. **Stage 4 visibility-projection removal.** Surprise gauge consumes the request graph's edge probability surface; if the BE-side `_prepare_scenarios` is not receiving `visibility_mode` or is interpreting it differently after TS-side projection was removed, the analysis input could be wrong.
2. **Stage 5 materialisation pipeline change.** If FE topo / projection runs differently for the prepared dispatch path now used by surprise gauge, the upstream graph state the BE reads could be missing fields the surprise gauge needs.
3. **Stage 2 prepared-dispatch routing.** Surprise gauge goes through `runPreparedAnalysis` → `analyzeMultipleScenarios` (or `analyzeSelection`); any payload-shape change in those dispatch surfaces could affect it.

**Action**: reproduce in a canvas chart with a surprise gauge analysis selected; capture the failure signature (no result / wrong values / dispatch error / blocked) and the request payload the FE sends. That will narrow which of the three candidates is responsible.

This is logged here for traceability; full investigation is downstream of the §5 outside-in engine work which is the priority workstream.

---

## 4. Key outside-in CLI suites for cohort_maturity v3

Two carefully-constructed outside-in CLI suites are the load-bearing acceptance gates for cohort_maturity v3. Both live inside the same file — [`graph-editor/lib/tests/test_cohort_factorised_outside_in.py`](graph-editor/lib/tests/test_cohort_factorised_outside_in.py) (created 26-Apr-26) — under two distinct sections that the file's docstring names explicitly.

Both suites drive `graph-ops/scripts/analyse.sh` and `graph-ops/scripts/param-pack.sh` through the daemon, so they exercise the same path the live FE / CLI tooling does. Neither suite is a v2/v3 parity comparison; they assert absolute properties (oracle truth, scalar identity across surfaces).

### Suite A — semantic correctness under defined degeneracy conditions (12 tests)

Drives cohort_maturity rows under named degeneracy / metamorphic conditions and compares them to factorised CDF/PDF oracles built from `bayes/truth/*.yaml`.

1. `test_a_equals_x_identity_collapses_to_window`
2. `test_single_hop_non_latent_upstream_collapses_to_window` (parametrised over fanout subjects)
3. `test_single_hop_latent_upstream_lags_window_but_converges_to_same_subject_p`
4. `test_anchor_depth_monotonicity_for_same_subject`
5. `test_same_carrier_shared_across_different_subjects`
6. `test_low_evidence_cohort_matches_factorised_convolution_oracle`
7. `test_no_evidence_single_hop_matches_unconditioned_fw_convolution_midline`
8. `test_low_evidence_single_hop_remains_near_unconditioned_oracle`
9. `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel`
10. `test_multihop_non_latent_upstream_collapse`
11. `test_multihop_latent_upstream_divergence`
12. `test_multihop_subject_span_is_not_last_edge_or_param_pack_scalar`

### Suite B — param-pack ↔ cohort-analysis-v3 parity (8 tests, "CLI public parity canaries")

Asserts that param-pack edge scalars (`p.mean`, `p.latency.completeness`) equal the same-edge scalars produced by `cohort_maturity` (last-row `p_infinity_mean`, `completeness`) and `conditioned_forecast` (`p_mean`, `completeness`) across a range of conditions.

1. `test_cli_window_single_edge_scalar_identity_across_public_surfaces`
2. `test_cli_identity_collapse_matches_window_across_public_surfaces`
3. `test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance`
4. `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point`
5. `test_cohort_and_window_p_infinity_converge_for_same_subject_rate` (parametrised × 3)
6. `test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case`
7. `test_cohort_frame_evidence_does_not_retarget_carrier_or_subject`
8. `test_zero_evidence_window_rises_as_subject_cdf`

These two suites are the primary signal for whether the live cohort_maturity v3 path is healthy end-to-end. Other outside-in files (v2/v3 parity, multi-hop evidence parity, doc-56 cross-consumer agreement, cf-truth-parity, etc.) are useful but secondary to these two.

---

## 5. Outside-in run results — 28-Apr-26

Ran `pytest graph-editor/lib/tests/test_cohort_factorised_outside_in.py -v` through the daemon against the live Python BE and snapshot DB. **10 failed, 13 passed in 6 min 37 s.**

Suite A (semantic correctness, 13 parametrised entries): 5 fail / 8 pass. Suite B (param-pack ↔ cohort-analysis-v3 parity, 10 parametrised entries): 5 fail / 5 pass.

The ten failures fall into three shapes that almost certainly correspond to fewer than three underlying defects.

### Group 1 — small drift (~4e-4) on cohort ↔ window asymptote convergence

Subject-equivalent cohort and window queries should converge to the same `p_infinity_mean` to 1e-6 (tighter where graph fixtures support it). They are drifting by ~4.7e-4 on synth-lat4. The same 4.7e-4 number appears across multiple tests, which is consistent with one drift source.

- `test_single_hop_non_latent_upstream_collapses_to_window[fast]` — `model_midpoint` diff 4.2e-4 at τ=1 vs tol 1e-9.
- `test_single_hop_latent_upstream_lags_window_but_converges_to_same_subject_p` — window=0.4944, cohort=0.4949, delta 4.7e-4 vs tol 1e-6.
- `test_cohort_and_window_p_infinity_converge_for_same_subject_rate[synth-lat4 (-1d:)]` — same 4.7e-4.
- `test_cli_identity_collapse_matches_window_across_public_surfaces` — pack `p.mean`=0.6406 vs cm last-row=0.6402, delta 4.4e-4 vs tol 1e-4.

Plausibly explained by conditioning that previously did not run now running uniformly under the Decision-13 sweep path. If so, the right move is to relax these tolerances (and write down *why*), not chase the arithmetic.

### Group 2 — large (~12–18%) anchor-depth divergence on synth-lat4 c→d

The anchor-depth invariant says window, identity-A=X, near-anchor B, far-anchor A all converge to the same subject `p_infinity` (the four queries are subject-equivalent — the same edge under different anchors). They don't. The `cohort(synth-lat4-b, -90d:)` arm sits ~12% below the others. Same 0.66 → 0.52 number recurs in three tests.

- `test_anchor_depth_monotonicity_for_same_subject` — p_values spread max 0.6640, min 0.5217 = 0.142 absolute.
- `test_cohort_frame_evidence_does_not_retarget_carrier_or_subject` — identical 0.66 → 0.52 numbers.
- `test_cohort_and_window_p_infinity_converge_for_same_subject_rate[synth-lat4 (-90d:) cohort(synth-lat4-b)]` — window=0.640, cohort=0.522, delta 0.118.
- `test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance` — completeness_delta 0.036 below the 0.05 lower bound (cohort anchor override under-shifts completeness).

This is **not** a tolerance issue. The cohort anchor override is producing materially different subject `p_infinity` than window for the same edge. This is the closest test-level analogue to the funnel symptom on the live app and is the most likely real engine defect of the three groups.

### Group 3 — low-evidence cohort drifts ~60% from the factorised oracle

On `synth-simple-abc b→c` with `cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)` (very low evidence, 2-day cohort range), the live curve undershoots the factorised CDF/PDF oracle from `bayes/truth/synth-simple-abc.truth.yaml`. At τ=16 actual=0.0149 vs oracle=0.0421 (64.6% relative under). Drift grows monotonically through τ=20.

- `test_low_evidence_cohort_matches_factorised_convolution_oracle`
- `test_low_evidence_single_hop_remains_near_unconditioned_oracle`

This subsumes the older "two BE regressions" §2 framing — same tests, now contextualised against an oracle gap rather than against a within-engine baseline. Real engine defect; not tolerance.

### Headline interpretation

Group 1 is plausibly tolerance / new-conditioning behaviour and may be acceptable after relaxing tolerances and documenting why. Groups 2 and 3 are real semantic regressions that the prior `analytic_degraded` shortcut was likely masking. The user's working hypothesis — retired pathway exposed real CF issues; FE now sees what CLI sees — fits the evidence.

### Triage hint via 73e Stage 6 `--no-be` (28-Apr-26)

73e Stage 6 added a `--no-be` flag (FE: `FetchOptions.skipBackendCalls`; runner-analyze surface: `BackendCallsSkippedError`) that suppresses every BE-bound call in a run. Re-running `cli analyse` under the flag distinguishes BE arithmetic divergence (CF, snapshot DB queries, runner-analyze outputs) from upstream FE-only divergence:

- For Group 1 (small ~4e-4 drift): `--no-be` is not a useful triage tool here because the affected analyses are runner-analyze types that fail-fast under the flag. These are tolerance / new-conditioning issues, not arithmetic.
- For Group 2 (anchor-depth divergence on synth-lat4 c→d): same — runner-analyze types short-circuit under the flag. Triage requires a CF-specific bisect rather than a wholesale BE suppression.
- For Group 3 (low-evidence cohort drift on synth-simple-abc b→c): the failing scalar in the param-pack-style assertion (`p.mean` undershoot) collapses to `evidence.k/n` under `--no-be`, which is the unconditioned average and matches the factorised oracle reference at τ=∞ within tolerance. The conditional-engine drift visible at τ=16 is genuinely a CF arithmetic issue. This pins Group 3 to CF and is the same root cause as the §3.7 abBcSmoothLag undershoot.

Net: `--no-be` confirms §3.7 + §5 Group 3 are the same defect — CF-side conditioning under low-evidence cohorts. Groups 1 and 2 are unaddressed by the flag and need separate triage (most likely Group 2 is the cohort-anchor-override semantic regression flagged in 73b §3.7 §3.6, distinct from CF arithmetic).

### Outside-in re-run — 28-Apr-26 (post-73e)

Re-ran `pytest graph-editor/lib/tests/test_cohort_factorised_outside_in.py -v` after all 8 stages of 73e merged. **12 failed, 11 passed in 2 min 37 s** (faster than the 6 min 37 s baseline run, almost certainly because the daemon and BE caches were warm).

Delta vs the 10 fail / 13 pass baseline above:

- All 10 baseline failures are still failing. 73e is transport cleanup; it was not expected to move engine arithmetic, and it didn't.
- **2 new failures** appeared, both inside Suite B's parity canaries:
  - `test_cli_window_single_edge_scalar_identity_across_public_surfaces` — `from(simple-a).to(simple-b).window(-90d:)`: pack `p.mean = 0.545800` vs CF `p_mean = 0.546332`, delta **5.3e-4** vs tolerance 1e-4. Was previously passing; this is a Group 1-shape drift on a fixture that was previously below tolerance.
  - `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point` — `synth-lat4-c→d` cohort: pack `p.mean = 0.5217` vs `cm last-row p_infinity_mean = 0.522247`, delta **5.5e-4** vs tolerance 1e-4. Was previously passing; same numbers as the Group 2 anchor-depth pair, suggesting it has been pulled across the tolerance threshold by post-73e prep changes.
- Group magnitudes within already-failing tests:
  - Group 1 latent-upstream pair: was 4.7e-4 → now **6.2e-4** (slightly worse but still small-drift).
  - Group 1 `cli_identity_collapse_matches_window`: was 4.4e-4 → now **4.79e-3** (10× worse — promoted into Group 2 territory).
  - Group 2 anchor-depth on synth-lat4 c→d: 0.66 → 0.52 spread unchanged.
  - Group 2 `cohort_and_window_p_infinity_converge` (-90d:): was 0.118 → now **0.123** (marginally worse).
  - Group 3 low-evidence cohort: τ=16 was 64.6% relative → now **68.6%** (~3pp worse), curve still drifting through τ=20.

**Interpretation.** 73e introduced no engine-side fixes. The 2 new failures and the slightly larger Group 1 deltas are consistent with the Stage 5 item 7 change — graph-bearing custom recipes are now uniformly re-materialised (FE topo + projection refresh) rather than replayed from captured numbers. This shifts intermediate values by O(1e-4) for fixtures whose previous parity rested on FE-topo-equivalent captured scalars, pushing two formerly-passing tests across their 1e-4 tolerance. None of the Group 1 deltas are large enough to indicate a new arithmetic defect; the `cli_identity_collapse` 10× jump is the only one that warrants closer inspection.

Headline: 73e closures (verified above) are landed; engine work in §5 Groups 2 and 3 is unchanged and remains the next active workstream after the §3.x spec-gap punch list. Group 1 is a candidate for tolerance relaxation per §6 step 4.

---

## 6. Triage order

Per the user's direction:

1. **First, after 73e lands, verify the expected 73e closures.** Run or inspect the targeted coverage for §3.1, §3.2, §3.4 / §7.1, §7.2, and any §7.5 work that 73e actually includes. Update this document with confirmed closed / still-open status before treating the §5 outside-in failures as the next active workstream.
2. **Then confirm any remaining 73a & 73b spec gaps.** Walk the §3 spot-check items that 73e did not close: §3.3 (CF/analysis parity test scope narrower than name), §3.5 (stale comment), §3.6 (pre-retirement contract pins), plus any failed verification from item 1. Some of these are simple corrections; any failed §3.1 or §3.2 verification would remain a spec-vs-implementation gap that may itself be a downstream contributor to the cohort_maturity v3 failures in §5.
3. **Then move to the outside-in failures in §5.** Working hypothesis: the suite was passing before 73 because the retired `analytic_degraded` / discriminator pathway shortcut was masking real CF issues. The retired path and its fallbacks were the obfuscating layer; what FE now sees should be much closer to what CLI sees, exposing the actual engine defects rather than the symptom mosaic that was being papered over.
4. **Tolerance vs semantic divergence.** Group 1 (~4e-4 drift on previously-1e-6 contracts) is a candidate for tolerance relaxation rather than engine work — those contracts may have held under no-conditioning and now drift slightly under uniform sweep conditioning; relaxing the test tolerance with a documented reason is the right response if that's the cause. Group 2 (~12–18% anchor-depth) and Group 3 (~60% oracle drift) are substantial semantic divergences and warrant real engine investigation — these are not tolerance issues and should not be silenced.

---

## 7. Static forensic review findings — 28-Apr-26

The following items were confirmed by source inspection against the 73a-2 / 73b contracts. No tests were run for this review.

### 7.1 `analyse --type conditioned_forecast` drops prepared display settings

The CLI `analyse` command runs `prepareAnalysisComputeInputs`, which resolves compute-affecting display settings, including `tau_extent: 'auto'`. The standard `runPreparedAnalysis` path forwards those settings to the backend as `display_settings`.

The conditioned-forecast branch in [graph-editor/src/cli/commands/analyse.ts](graph-editor/src/cli/commands/analyse.ts) builds a separate `/api/forecast/conditioned` payload from the prepared scenarios but omits both top-level `display_settings` and per-scenario `display_settings`. The backend handler in [graph-editor/lib/api_handlers.py](graph-editor/lib/api_handlers.py) explicitly reads `scenario.display_settings || data.display_settings` when computing `axis_tau_max`.

This violates 73a-2 Stage 3's "conditioned forecast analysis and normal analysis dispatch must continue to share the same preparation state" rule for compute-affecting display state, even though the scenario graph transport itself is aligned.

**Action**: forward `prepared.displaySettings` on the conditioned-forecast CLI payload, and decide whether the browser `conditionedForecastService` should use the same payload field for consistency.

### 7.2 `parity-test` still replays thin params instead of scenario-owned enriched graphs

[graph-editor/src/cli/commands/parity-test.ts](graph-editor/src/cli/commands/parity-test.ts) still aggregates each scenario graph, immediately calls `extractParamsFromGraph`, and then calls `prepareAnalysisComputeInputs(mode: 'live')` with `currentParams` / `scenarioLikes.params`. It does not pass the aggregated `graph` through `customScenarios[].graph`.

That repeats the historical `populatedGraph -> param pack -> rebuilt graph` pattern that 73a-2 was created to remove from analysis transport. `parity-test` is not the public `analyse` command, but it is a CLI diagnostic surface that calls the shared preparation service and can therefore give false confidence about the very transport seam 73a-2 is meant to protect.

**Action**: either migrate `parity-test` to scenario-owned enriched graph transport, or retire / relabel it as an old params-overlay diagnostic that must not be used as a 73a/73b parity signal.

### 7.3 `read_edge_cohort_params` bypasses the shared resolver

[graph-editor/lib/runner/forecast_runtime.py](graph-editor/lib/runner/forecast_runtime.py) `read_edge_cohort_params` builds upstream carrier probability directly from `p.posterior.cohort_alpha/beta`, then `p.posterior.alpha/beta`, then `p.forecast.mean`. It does not call `resolve_model_params` and does not read the 73b Stage 2 analytic mirror under `model_vars[analytic].probability`.

This function feeds `build_x_provider_from_graph` and then `build_upstream_carrier`, so upstream carrier Tier 1 can disagree with the shared resolver whenever `p.posterior` is empty but L1 analytic shape exists, or when L2 `p.forecast.mean` is stale relative to L1. That violates 73b §6.5 / Appendix B's rule that carrier consumers read L1/L1.5/L2 through the single shared resolver and never invent their own model-input precedence.

**Action**: route upstream carrier parameter extraction through `resolve_model_params` for probability and latency selection, with any genuinely required path-level latency handling documented as a narrow extension rather than a parallel resolver.

### 7.4 Bayes patch Tier 1 projects bare `window()` / `cohort()` slices onto the graph

[graph-editor/src/services/bayesPatchService.ts](graph-editor/src/services/bayesPatchService.ts) merges the full `patchEdge.slices` object into the parameter file, but the direct graph update path then reads only `slicesRaw['window()']` and `slicesRaw['cohort()']` to populate `p.posterior`, `p.latency.posterior`, `model_vars[bayesian]`, and promotion.

That bypasses the shared `resolvePosteriorSlice(slices, effectiveDsl)` / `buildSliceKey` projection contract that 73b Appendix B defines for I4. If the graph is open, Tier 2 later calls `getParameterFromFile(... targetSlice: currentDSL)` and may correct the live GraphStore. If the graph is not open, Tier 2 is skipped and the graph file in FileRegistry/IDB is left with a bare-slice projection even if the current graph DSL is contexted or otherwise should select a non-bare slice.

**Action**: either remove the direct graph posterior/model-vars projection from Tier 1 and let the canonical file-to-graph projection own it, or make Tier 1 call the same slice resolver using the graph's effective DSL.

### 7.5 Missing parameter-file posterior slices leave stale graph projection in place

The docstring for `contextProbabilityBlock` in [graph-editor/src/services/posteriorSliceContexting.ts](graph-editor/src/services/posteriorSliceContexting.ts) says that when `posterior.slices` is absent on the parameter file, the helper clears `p.posterior` and `p.latency.posterior` so stale projections cannot persist.

The implementation does the opposite: when `!fileposterior?.slices`, it returns without clearing either in-schema field, only clearing `_posteriorSlices` when request-graph engorgement is enabled. A parameter file with posterior material removed or stripped can therefore leave an old in-schema projection on the live/request graph.

**Action**: make the missing-slices branch match the stated strict-clearing contract, and cover the already-clean case so the cleanup remains idempotent.

### 7.6 Forecast runtime still has always-on debug stdout

The live Python forecast paths still contain unconditional `print` diagnostics such as `[v3-debug]`, `[sweep-diag]`, `[sweep_diag]`, `[rate_draws_sha256]`, and `[v2] carrier tier=...` in [graph-editor/lib/runner/forecast_state.py](graph-editor/lib/runner/forecast_state.py), [graph-editor/lib/runner/forecast_runtime.py](graph-editor/lib/runner/forecast_runtime.py), and [graph-editor/lib/runner/cohort_forecast_v3.py](graph-editor/lib/runner/cohort_forecast_v3.py).

Some neighbouring diagnostics are correctly gated behind `DAGNET_COHORT_DEBUG`, but these are not. This is residue / CLI noise from the forecast debugging work and conflicts with 73b Work package A's explicit cleanup goal.

**Action**: gate these diagnostics behind a debug flag or convert them to structured diagnostics that are only emitted when requested.

---

## Summary

| # | Item | Severity | Owner-area | Status (28-Apr-26) |
|---|---|---|---|---|
| 1 | 8 held-over Python tests (cohort multi-hop midpoint) | High | 47-series, not 73b | Open — out of 73b scope |
| 2 | 2 BE regressions, root cause unknown | High | Fresh investigation | Subsumed by §5 Group 3 |
| 3.1 | Production re-contexting does not upsert `model_vars[bayesian]` | High | Stage-4 follow-up | **Closed** (73e Stage 3) |
| 3.2 | Analysis prep mutates caller graph in f+e mode | Medium | Cleanup + guard test | **Closed** (73e Stage 1) |
| 3.3 | CF/analysis parity test scope narrower than name | Low | Rename or extend | Open |
| 3.4 | cliAnalyse non-CF cases hit BE directly, not CLI | Low | Test refactor | **Closed** (73e Stage 2) |
| 3.5 | Stale comment in carrier-read shared-resolver test | Trivial | One-line fix | **Closed** (28-Apr-26 — comment already updated; doc claim was stale) |
| 3.7 | abBcSmoothLag E2E blended-reach undershoot | High | CF arithmetic (same as §5 Group 3) | Diagnosed via 73e Stage 6 `--no-be` — pinned to CF, engine fix open |
| 3.8 | PW regression: `shareLiveChart` live-share scenarios collapse to identical `p.mean=0.7826` | High (ships gate) | Materialisation / share-restore | **New, open — gates release** |
| 3.9 | Surprise gauge has stopped working | TBD | Runner-analyze dispatch / materialisation | **New, open — needs reproduction** |
| 4 | Two outside-in CLI suites in `test_cohort_factorised_outside_in.py` are the primary cohort_maturity v3 acceptance gates | Reference | Run as primary signal | Reference |
| 5 | Outside-in run 28-Apr-26: 10 fail / 13 pass — Group 1 small drift, Group 2 anchor-depth ~12–18%, Group 3 low-evidence oracle ~60% | High | Engine investigation (Groups 2, 3); tolerance call (Group 1) | Open (engine work, post-73e) |
| 6 | Triage order: verify expected 73e closures first; then remaining spec gaps; then §5 engine work | Reference | Sequencing | Step 1 done (verification status above) |
| 7.1 | `analyse --type conditioned_forecast` omits prepared display settings | Medium | CLI CF payload | **Closed** (73e Stage 2) |
| 7.2 | `parity-test` still uses param replay instead of enriched scenario graphs | Medium | CLI diagnostics | **Closed** (deleted 28-Apr-26) |
| 7.3 | `read_edge_cohort_params` bypasses `resolve_model_params` | High | Python forecast runtime | Open |
| 7.4 | Bayes patch Tier 1 projects bare slices instead of effective-DSL slices | Medium | Bayes patch / contexting | Open |
| 7.5 | Missing `posterior.slices` leaves stale graph posterior projection in place | Medium | Posterior contexting | **Closed** (28-Apr-26 — strict-clear adopted) |
| 7.6 | Forecast runtime emits always-on debug stdout | Low | Python forecast runtime cleanup | Open |

---

