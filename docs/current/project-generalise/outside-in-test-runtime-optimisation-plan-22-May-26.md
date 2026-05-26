# Outside-In Test Runtime Optimisation Plan

**Date:** 22-May-26  
**Status:** active optimisation project  
**Scope:** reduce the wallclock cost of outside-in semantic/parity tests by shrinking artificial date breadth, tau sweep, and MC draw counts to the minimum needed for each assertion.

## 1. Problem

Several outside-in test files are currently shaped more like load tests than semantic parity tests. They run broad synthetic fixture windows, large tau sweeps, and default MC draw counts even when the assertion only needs a local semantic witness.

This is operationally harmful:

- date breadth is directly multiplicative in snapshot reads, cohort materialisation, row projection, and per-anchor reductions;
- tau breadth is directly multiplicative in row-building and projection surfaces;
- default `mc_draws=1000` is unnecessary for many inequality/presence/parity canaries where `64` draws is enough to preserve the semantic signal;
- slow outside-in files compete with the canonical oracle for the same wallclock budget, so agents avoid running them and regressions become easier to miss.

The optimisation target is not to weaken semantics. It is to stop using fixture-lifetime windows where the test only needs a small, non-vacuous witness.

## 2. Principle

Each outside-in test must state the smallest data regime that makes its claim non-vacuous.

The default posture for these files should be:

- narrow absolute date windows inside the deterministic synth fixture;
- one representative edge or subject when the invariant is detectable on any edge;
- tau assertions at named, necessary tau values rather than full-row sweeps;
- reduced MC draw count when the assertion is qualitative, inequality-based, or tolerant to small deterministic MC noise;
- full fixture breadth only when the assertion is explicitly about full-period coverage, epoch routing across multiple epochs, or aggregate lifetime behaviour.

If a broad date range is kept, the test must explain which invariant requires that breadth. "Matches the original harness" is not a justification.

## 3. Required Executions

### 3.1 `graph-editor/lib/tests/test_asat_blind.py`

This file requires an optimisation pass.

Forensic finding: the current date windows are inherited from the original blind harness and doc-42 fixture-span checks. The pytest assertions mostly test presence, absence, inequality, monotonicity, signature exclusion, and read-only behaviour. They do not assert the historical full-window totals recorded in `docs/current/project-bayes/42b-asat-remedial-workplan.md`.

Current artificial breadth:

- `FULL_WINDOW` covers nearly the whole `synth-simple-abc` observable fixture.
- `COHORT_DSL_ABC` covers nearly the whole same fixture and feeds `cohort_maturity`, making the breadth especially expensive.
- `MIXED_WINDOW` covers the full `synth-context-solo-mixed` epoch fixture, even though the assertions only need one bare-epoch witness and one contexted-epoch witness.

Required changes:

- Split `synth-simple-abc` scalar windows from `cohort_maturity` windows. Do not reuse one broad constant for unrelated assertions.
- Narrow scalar `param-pack` windows to a small range that still has evidence by `asat(15-Jan-26)` and remains visible without `asat`.
- Narrow monotonic completeness checks to cohorts whose age changes across `15-Jan-26`, `15-Feb-26`, and the live baseline. The query window does not need to extend to the later as-at dates; those dates are evaluation frontiers, not cohort-window requirements.
- Split early-asat and late-boundary `cohort_maturity` checks into separate narrow ranges. The late `tau_solid_max`/boundary tests need a small March witness around `asat(18-Mar-26)`, not the full December-March fixture.
- Narrow the mixed-epoch fixture to a small range straddling the epoch boundary. `synth-context-solo-mixed` has bare rows on days 0-44 and context rows on days 45-89; a local range around the boundary is enough to test bare/context regime selection.
- Pass `mc_draws=64` through `analyse` calls that hit `cohort_maturity`.
- Use `--no-be` only where the assertion does not depend on CF output, such as signature-only checks and read-only file checksum checks. Do not use it for tests asserting CF-authored `p.mean`, completeness, or analysis row fields.

Expected outcome: the file remains an outside-in `asat()` contract canary, but becomes a semantic witness instead of a fixture-lifetime sweep.

### 3.2 `graph-editor/lib/tests/test_doc56_phase0_behaviours.py`

This file requires the same diagnostic and optimisation pass.

Forensic finding: the file is already known as a major outside-in wallclock contributor. Its stated purpose is cross-consumer semantic agreement, but several cells use relative windows such as `window(-120d:)`, `window(-180d:)`, `cohort(-180d:)`, and `window(-90d:)`. Against fixed synth fixtures, those ranges are both wallclock-sensitive and much broader than most claims require.

The file should be treated as a semantic parity suite, not a load test.

Required diagnostic pass:

- For each test, identify the exact consumer agreement claim: CF versus v3 chart, edge-order invariance, lag-fit versus surprise-gauge, chart versus daily conversions, or bayesian sidecar split preservation.
- For each claim, identify the minimum graph, edge, date range, and tau point that makes the claim non-vacuous.
- Replace broad relative date scopes with narrow absolute windows inside the synth evidence span.
- Reduce `mc_draws` to `64` anywhere the assertion tolerates MC noise or asserts qualitative separation. If a test genuinely needs the default draw count, document why.
- Reduce tau inspection to named tau values. Avoid generating broad row surfaces when the assertion samples one early or middle tau.
- Keep only topology breadth that contributes unique coverage. The topology matrix should not also multiply by unnecessary date breadth and full draw count.
- Reassess xfailed or stale claims during the pass. A strict or long-running xfail still consumes design attention and may consume runtime if it performs setup before xfail evaluation.

Expected outcome: `test_doc56_phase0_behaviours.py` remains a cross-consumer semantic agreement suite, but stops exercising broad synthetic lifetimes merely to prove local parity.

Required work packages:

- **D56-WP1: Thread low-draw request settings through direct handler helpers.** `_run_cf_cached`, `_run_cf_on_graph`, `_run_v3_cached`, and `_run_runner_analysis` call Python handlers directly, so they currently inherit default `mc_draws=1000`. Add an explicit low-draw forecasting-settings payload for semantic agreement tests, with a local exception path only where a test documents that default draw count is required.
- **D56-WP2: Replace relative fixture-lifetime scopes with narrow absolute windows.** Audit every `window(-Nd:)` and `cohort(-Nd:)` in the file. Convert each to a narrow absolute in-fixture range that preserves non-vacuous evidence. Treat `-120d`, `-180d`, and `-90d` as defects unless the test states why full breadth is necessary.
- **D56-WP3: Rework the CF-v3 topology matrix.** Keep the topology diversity only where it contributes unique coverage. For each matrix row, use one representative edge and a local date slice. The purpose is consumer agreement across topology classes, not full-period load coverage.
- **D56-WP4: Redesign or retire the weak identity-carrier parity check.** `test_query_scoped_identity_carrier_collapses_public_evidence_basis` currently asserts late taus up to `80` with broad rows and weak tolerances. Either move it to a smoother, sharper fixture with a smaller tau witness set, or replace it with coverage in the canonical outside-in oracle if the semantic claim is already duplicated there.
- **D56-WP5: Narrow edge-order invariance.** Edge-order invariance does not require broad cohort history. Use a local absolute cohort window for both `synth-mirror-4step` and the deep-mixed witness, and keep the comparison focused on response equality under reordered edges.
- **D56-WP5a: Investigate the deep-mixed edge-order blow-up as a performance canary.** The pre-optimisation run was killed after roughly 13 minutes while executing `test_whole_graph_cf_is_invariant_under_edge_reorder[cf-fix-deep-mixed-cohort(-180d:)]`. The specific strategic canary query is `cf-fix-deep-mixed` with `cohort(-180d:)` under whole-graph CF, run twice against original and reversed edge order. This may expose a real pathologically-scaling carrier/donor cache or deep-cohort preparation issue. Do not lose the canary when tactically narrowing the test; preserve it as a separate performance investigation with explicit profiling and bounded runtime.
- **D56-WP6: Resolve stale xfailed downstream/bayesian canaries.** The xfailed tests still encode stale contracts and can still perform expensive setup/execution. Decide per test whether to delete, skip before expensive setup, invert into the post-WP8 contract, or move the live semantic claim to another suite.
- **D56-WP7: Narrow daily-conversions split coverage.** `test_chart_and_daily_conversions_do_not_collapse_window_and_cohort` samples tau `5` and one overlapping daily row. Replace the broad `-90d` scopes with a small absolute slice that still proves the window/cohort population split.

## 4. Non-Goals

This project must not:

- weaken outside-in assertions to match current runtime output;
- delete semantic coverage because it is slow without first identifying whether it duplicates the canonical outside-in oracle;
- introduce mocks for snapshot DB, graph loading, CF, or analysis runners;
- use `.asat()` as a generic wallclock freeze where the test is not about `asat()` semantics;
- turn a semantic parity suite into a cache-dependent timing benchmark.

## 5. Acceptance Criteria

The optimisation is complete for a file only when:

- every broad date scope has an explicit reason or has been narrowed;
- every `cohort_maturity`/CF call has an explicit draw-count decision;
- every tau assertion is tied to the smallest row surface that proves the claim;
- non-vacuousness is preserved by checking that the narrowed range still exercises real evidence;
- the test still runs through the real production boundary it is meant to protect;
- the file-level runtime is low enough that an agent can reasonably run it during relevant work.

## 6. Tracking Notes

`docs/current/post-cf-rebuild-py-test-audit-7-may-26.md` already identified `test_doc56_phase0_behaviours.py` and `test_asat_blind.py` as notable outside-in wallclock contributors. This document turns that observation into a concrete optimisation programme.

The work should be executed before treating these files as routine verification gates for future CF or analysis-runner changes. Otherwise they will continue to discourage verification and distort local development into waiting on synthetic load-test workloads.
