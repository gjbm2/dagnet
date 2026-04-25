# 60 — Forecast Adaptation Implementation Plan

**Date**: 21-Apr-26  
**Status**: Active implementation record (BE-topo scope superseded)  
**Updated**: 24-Apr-26  
**Review status**: Work packages WP0-WP9 have now landed in code; this document remains the execution record and acceptance checklist  
**Review pack role**: 3 of 3 — delivery plan for the target contract  
**Superseded-scope note (24-Apr-26)**: [doc 73b](73b-be-topo-removal-and-forecast-state-separation-plan.md) supersedes every rule in this document about the BE topo pass remaining a distinct analytic subsystem. The quick BE topo pass, `analytic_be` model-var source, `/api/lag/topo-pass` endpoint, `handle_stats_topo_pass` handler, `lib/runner/stats_engine.py`, `beTopoPassService.ts`, and `forecastingParityService.ts` have been removed. Sections of this doc that describe the BE topo pass as a live surface (§3 public-surfaces analytic-fallback row, §4 "non-goals" BE-topo clause, §11 "BE topo pass remains analytically bounded", and the BE-topo entries in the surface-preservation and contract-change tables) no longer reflect the live system; they remain as historical execution record.  
**Primary references**: `59-cohort-window-forecast-implementation-scheme.md`, `42-asat-contract.md`, `../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`, `../codebase/STATS_SUBSYSTEMS.md`, `../codebase/FE_BE_STATS_PARALLELISM.md`, `45-forecast-parity-design.md`, `47-multi-hop-cohort-window-divergence.md`, `52-subset-conditioning-double-count-correction.md`, `56-forecast-stack-residual-v1-v2-coupling.md`, `57-cf-eligibility-topological-degradation.md`, `73b-be-topo-removal-and-forecast-state-separation-plan.md`, `../codebase/TESTING_STANDARDS.md`  
**Audience**: engineer delivering the forecast adaptation workstream and peers reviewing its delivery logic

---

**Status note (22-Apr-26)**: the work packages in this programme have now
been implemented through WP9. This note therefore serves two live roles:

- the historical execution record for how the forecast-adaptation workstream
  was sequenced
- the acceptance checklist for broader outside-in confirmation that still
  sits above the focused package-level tests

The main remaining validation work is no longer "what should we implement
next?" but "which broader harnesses do we still want to run before calling
the workstream fully closed?" Later B3 and chart-retirement workstreams
remain separate.

## 1. Peer Review Frame

This document should be reviewed third, after the semantic reference and
the target implementation scheme. Its job is not to prove the target
contract correct by itself. Its job is to state a delivery plan that is
coherent, testable, and low-risk enough to move the live system toward
that contract without losing control of the public surfaces already in
use.

The intended peer review is systematic rather than ceremonial. Reviewers
should feel free to challenge omissions, sequencing, scope boundaries,
test adequacy, file ownership, or hidden assumptions. The prompts below
are meant to structure that review effort; they are not a request to
affirm the plan as written.

Suggested review order for the three-document pack:

1. `../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
2. `59-cohort-window-forecast-implementation-scheme.md`
3. `60-forecast-adaptation-programme.md`

Useful review questions for this note are:

1. Does the plan preserve the correct public surfaces and field-authority
   boundaries while changing internals?
2. Are any prerequisites, design decisions, or dependencies missing,
   premature, or incorrectly treated as settled?
3. Is the proposed sequencing likely to reduce risk, or is there a safer
   order of attack?
4. Are any file responsibilities, caller boundaries, or rollout seams too
   vague to implement safely?
5. Are the proposed tests and conformance gates sufficient to catch the
   most likely semantic and consumer regressions?
6. Does the plan leave any material risk, unresolved ambiguity, or hidden
   coupling outside its final acceptance criteria?

Useful review outputs include contradictions between the three docs,
missing work packages, weak test seams, unclear ownership boundaries,
unjustified sequencing choices, and places where the implementation plan
quietly depends on knowledge that is not yet written down. Reviewers do
not need to accept the current package boundaries or PR grouping for
their review to be valuable.

## 2. Role of this document

This is the delivery document for the forecast adaptation workstream.
It should be specific enough that an engineer can pick up the work,
understand the current system boundaries, know which decisions are
already settled, and execute the refactor without reconstructing the
whole conversation that produced it.

Doc 59 remains the target-state contract. The cohort/window semantics
note remains the semantic source of truth. This document does a
different job: it states exactly what this workstream is for, which
files and surfaces it touches, what order the work should land in, what
tests should guide it, and what "done" means.

An engineer should not start implementation from doc 60 alone. They
should read the following references first, in this order:

1. `../codebase/STATS_SUBSYSTEMS.md` — mandatory subsystem map; clarifies
   the five distinct statistical subsystems, field authority, and the
   correct public entry points.
2. `../codebase/FE_BE_STATS_PARALLELISM.md` — Stage 2 orchestration,
   conditioned-forecast fast/slow path, merge semantics, and BE/FE
   coordination.
3. `../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` —
   the semantic contract for `window()` and `cohort()` including
   factorised versus gross-fitted numerator treatment.
4. `42-asat-contract.md` — the binding `asat()` semantics: evidence
   cutoff, posterior cutoff, evaluation date, read-only invariant, and
   blind test contract.
5. `59-cohort-window-forecast-implementation-scheme.md` — the target
   runtime contract for this workstream.
6. `45-forecast-parity-design.md` — chart/graph parity invariant and the
   required separation between analytic model-var generation and
   conditioned forecasting.
7. `47-multi-hop-cohort-window-divergence.md` — the specific multi-hop
   subject-frame bug and its correct seam.
8. `56-forecast-stack-residual-v1-v2-coupling.md` — the runtime-boundary
   precondition; this workstream must not reintroduce v1/v2 coupling.
9. `52-subset-conditioning-double-count-correction.md` — blend
   discipline for aggregate priors; required context for any rate-side
   conditioning change.
10. `57-cf-eligibility-topological-degradation.md` — the already-agreed
   degraded-output contract for query-scoped posteriors.
11. `../codebase/TESTING_STANDARDS.md` — test design rules, parity-test
    rules, and the repo's TDD boundaries.

If any of those references are still unclear, stop and read them before
changing code. Through WP7, the workstream is not blocked on open
architectural questions. The main job is to deliver the already-decided
structural design cleanly. WP8 is different: doc 59 sketches a narrow,
flagged recommended path, but that late behaviour change should be
treated as separately ratified work rather than assumed pre-approved.

## 3. Workstream goal

This workstream adapts the live forecast stack behind the existing public
surfaces. It is explicitly **not** a clean-slate rewrite.

The goal is to make the live implementation satisfy the contract already
set out in docs 42, 45, 47, 56, 57, and 59 while preserving the main
public surfaces that the product already depends on.

The required outcomes are:

1. the whole-graph conditioned-forecast pass, scoped conditioned-forecast
   consumers, trajectory consumers, summary consumers, and graph-state
   consumers all work from one coherent runtime contract
2. the implementation uses explicit semantic roles rather than hidden
   mode-specific shortcuts
3. conditioned graph fields have a clear writer boundary, with CF owning
   the fields it is supposed to own
4. multi-hop and cohort/window semantics are implemented at the correct
   seam, not patched per consumer
5. the workstream can be delivered and maintained with explicit tests at
   the right boundaries

### Public surfaces that must be preserved

| Consumer or surface | Public contract that must remain coherent | Main entry point(s) |
|---|---|---|
| whole-graph conditioned graph enrichment | authoritative conditioned graph fields for `p.mean`, `p.forecast.mean`, and CF-owned completeness fields | `graph-editor/lib/api_handlers.py::handle_conditioned_forecast` plus `graph-editor/src/services/conditionedForecastService.ts` |
| scoped conditioned-forecast response | per-edge conditioned response for a path or edge, consumed directly by higher-level callers | `graph-editor/lib/api_handlers.py::handle_conditioned_forecast` with `analytics_dsl` |
| chart trajectory projection | per-`tau` rows for `cohort_maturity_v3` | `graph-editor/lib/api_handlers.py::_handle_cohort_maturity_v3` and `graph-editor/lib/runner/cohort_forecast_v3.py::compute_cohort_maturity_rows_v3` |
| scalar summary projection | bounded summary output or explicit unavailable / degraded result | `graph-editor/lib/runner/forecast_state.py::compute_forecast_summary` and `_compute_surprise_gauge` |
| direct CF consumer | consumption of the public CF surface rather than inner kernels | `graph-editor/lib/runner/runners.py::run_conversion_funnel` |
| analytic fallback | provisional model-var and fallback outputs only | `graph-editor/lib/api_handlers.py::handle_stats_topo_pass` |

## 4. Preconditions, assumptions, and non-goals

### Preconditions

The following are prerequisites for this workstream:

- The doc 56 runtime-boundary work is either already green or is landed
  first. Production forecast callers must not import
  `cohort_forecast_v2.py`, `cohort_forecast.py`, or `span_adapter.py`.
  These modules may still exist in the tree as parity-oracle or frozen-v2
  infrastructure pending later cleanup; the precondition is about live
  production imports, not file presence. If production callers still use
  them, stop and resolve that boundary before starting the semantic
  adaptation packages below.
- The five-subsystem split in `STATS_SUBSYSTEMS.md` is treated as
  binding. BE topo pass and BE CF pass remain different subsystems with
  different responsibilities.
- The target semantic contract is already settled in docs 59 and
  `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` for the structural
  work through WP7, and `42-asat-contract.md` is binding wherever shared
  preparation, admissibility, evidence selection, or posterior
  resolution touches `asat()`. This workstream implements that contract;
  it does not reopen it.
- The degraded-output contract for query-scoped posteriors in doc 57 is
  a binding input to this workstream, not an optional side experiment.
- WP8 is a separately ratified late enhancement, not a prerequisite for
  starting or completing the structural work packages below. Do not treat
  doc 59's recommended direct-`cohort()`-for-`p` path as auto-approved
  implementation scope.

### Non-goals

The following are explicitly out of scope:

- B3 or any wider redesign of mature cohort latency correction
- Bayes compiler changes
- turning the BE topo pass into a second conditioned-forecast path
- new analysis types or chart features except where needed to preserve
  the existing consumer contracts listed above
- retirement of the v1/v2 chart features, except where that retirement
  is already independently in flight
- migration of `_handle_cohort_maturity_v2` onto the shared preparation
  helper; the v2 parity-oracle / frozen-chart path stays on its own local
  preparation until the separate retirement / cleanup work removes it
- a clean-slate graph-schema redesign

This workstream may add or adjust CF provenance fields already agreed in
doc 57, but it must not sprawl into unrelated schema work.

## 5. Verified current-state problems this plan must close

The workstream is not solving a lack of public surfaces. The public
surfaces mostly already exist. The main problem is semantic drift and
incomplete generalisation behind those surfaces.

The verified implementation problems are:

1. **Shared preparation drift between chart and CF.**  
   `handle_conditioned_forecast` and `_handle_cohort_maturity_v3` still
   encode overlapping but not identical preparation paths. The specific
   high-severity instance is doc 47's multi-hop cohort subject-frame
   divergence.

2. **Runtime roles are still implicit.**  
   Meaning is currently spread across flags and local branches such as
   `is_window`, `is_multi_hop`, and historical shortcuts such as
   `_widen_span`. This makes it too easy for one consumer to drift from
   another.

3. **The factorised cohort default is not explicit enough.**  
   The target contract requires `carrier_to_x + subject_span(X -> end)`
   as the default runtime template for cohort mode, but the current live
   code still carries anchor-rooted shortcuts and legacy shaping.

4. **`span_kernel.py` is not yet cleanly downstream of prepared semantic
   inputs.**  
   The subject-span layer should execute prepared operator parameters,
   not act like a secondary resolver or raw-field selector.

5. **The summary path is not clearly aligned or bounded.**  
   `compute_forecast_summary` and the surprise-gauge path still sit too
   far outside the shared runtime contract, which makes it unclear when
   they are legitimate reduced projections and when they are semantic
   forks.

6. **Whole-graph CF sequencing and donor routing are not yet strong
   enough.**  
   The whole-graph CF pass is the live conditioned writer of record, but
   its ordering and donor-routing discipline is still too ad hoc for a
   first-class writer.

7. **Query-scoped posterior edges need an explicit degraded path.**  
   Per doc 57, edges with `alpha_beta_query_scoped == True` cannot
   coherently run the sweep again. That decision must become a shared,
   explicit branch across callers.

8. **The analytic topo-pass boundary must stay tight.**  
   `handle_stats_topo_pass` may remain a model-var / provisional fallback
   writer, but it must not grow into a second conditioned-forecast
   implementation.

9. **`asat()` is not yet explicit enough as a shared preparation seam.**  
   Evidence cutoff, posterior cutoff, evaluation date, and admissibility
   metadata must remain aligned across first-class consumers. If one
   caller drifts on `asat()` handling, identical semantic questions can
   diverge even when the rest of the runtime contract matches.

## 6. Resolved design decisions

The following decisions are already made and should not be re-litigated
inside the implementation workstream:

1. The whole-graph conditioned-forecast pass is a first-class consumer
   and the authoritative conditioned writer for graph state.
2. The chart path and the scoped CF path are two projections of the same
   underlying solve, not two separate semantic systems.
3. `window()` remains `X`-rooted throughout. It does not become
   anchor-rooted downstream by stealth.
4. The default cohort runtime is factorised: denominator-side
   `carrier_to_x` plus numerator-side `subject_span(X -> end)`.
5. `A = X` is a general identity case, not a special-case hack.
6. Multi-hop subject semantics always mean the full `X -> end` span, not
   the last edge into the end node.
7. For multi-hop `cohort()` queries, subject-frame construction uses
   `window` evidence for the whole subject span; cohort semantics apply
   at the path-level forecast stage.
8. `ResolvedModelParams.alpha_beta_query_scoped` is the canonical
   predicate for "already query-scoped posterior" behaviour. Do not
   replace it with source-name heuristics scattered through callers.
9. CF owns the conditioned graph fields it is already meant to own:
   `edge.p.mean`, `edge.p.forecast.mean`,
   `edge.p.latency.completeness`, and
   `edge.p.latency.completeness_stdev`.
10. The funnel remains a consumer of the public CF response. It must not
    be moved onto inner kernels.
11. The BE topo pass remains analytically bounded. It must not be used as
    a second path for solving semantic problems that belong in CF.
12. `asat()` remains a first-class semantic input to preparation,
    admissibility, evidence visibility, and posterior selection. Callers
    must not improvise local `asat()` behaviour outside the shared seam.
13. Direct `cohort()` evidence for `p` is a late, flagged enhancement. It
    is not part of the settled structural contract through WP7. Doc 59
    recommends a narrow path, but implementation still requires explicit
    ratification before coding.

## 7. Final file ownership after this workstream

The engineer should treat the following file responsibilities as the
intended steady-state boundary.

| File or symbol | Final responsibility | Must not do | Main work packages |
|---|---|---|---|
| `graph-editor/lib/runner/forecast_runtime.py` plus `graph-editor/lib/runner/model_resolver.py` | own the explicit runtime bundle, admission-policy outputs, prepared operator inputs, and sweep-eligibility predicate | project graph fields or chart rows directly | WP1-WP4, WP7-WP8 |
| `graph-editor/lib/runner/span_kernel.py` plus `graph-editor/lib/runner/span_evidence.py` | execute subject-span composition from prepared inputs | pick semantic sources from raw edge fields or caller-local flags | WP1, WP4 |
| `graph-editor/lib/runner/forecast_state.py::{compute_forecast_trajectory, compute_forecast_summary}` | solve from prepared runtime inputs and return trajectory or bounded summary outputs | infer semantic roles from path length, local booleans, or incidental helper fields | WP2, WP5, WP7 |
| `graph-editor/lib/api_handlers.py::handle_conditioned_forecast` | orchestrate whole-graph and scoped CF, then emit the response projection inputs | own a chart-only prep path, local semantic policy, or ad hoc donor routing | WP1, WP5-WP8 |
| `graph-editor/lib/api_handlers.py::_handle_cohort_maturity_v3` plus `graph-editor/lib/runner/cohort_forecast_v3.py::compute_cohort_maturity_rows_v3` | trajectory projection from the shared preparation and runtime bundle | fork chart-only semantics from CF | WP1-WP5, WP7 |
| `graph-editor/src/services/conditionedForecastService.ts` | authoritative graph projection of CF-owned scalars | preserve FE/topo values over CF-owned fields or reinterpret runtime semantics while projecting | WP5, WP7 |
| `graph-editor/lib/api_handlers.py::handle_stats_topo_pass` | analytic model-var generation and explicit provisional fallback only | become a second conditioned-forecast implementation | WP5 |
| `graph-editor/lib/runner/runners.py::run_conversion_funnel` and `graph-editor/lib/runner/graph_builder.py::apply_visibility_mode` | consume public forecast outputs at direct-response or graph-state level | import inner forecast kernels or reconstruct runtime semantics from flat helper fields | WP5 |

## 8. Delivery strategy

The workstream should land seam-first, not consumer-first.

The correct order is:

1. freeze contracts and test surfaces
2. remove duplicated preparation
3. make the runtime bundle explicit
4. restore the factorised cohort default
5. make subject-span execution consume prepared inputs
6. enforce projection boundaries
7. harden whole-graph sequencing
8. land the query-scoped degraded path
9. only then consider the late flagged direct-`cohort()` `p` path
10. remove obsolete branches and align docs

This order matters. If the workstream lands the late rate-conditioning
enhancement before the structural cleanup, it will be impossible to tell
whether later regressions come from a genuine semantic change or from a
still-fragmented runtime boundary.

## 9. Work packages

### WP0 — Verify the substrate and freeze the public contracts

**Objective**

Before changing semantics, refresh the live harness status, make sure the
workstream has usable red/green feedback at the correct boundaries, and
verify that the doc 56 runtime boundary is not regressing.

**Primary files**

- `graph-editor/lib/tests/test_forecast_stack_dependencies.py`
- `graph-editor/lib/tests/test_conditioned_forecast_response_contract.py`
- `graph-editor/src/services/__tests__/conditionedForecastCompleteness.test.ts`
- `graph-editor/lib/tests/test_doc56_phase0_behaviours.py`
- `graph-editor/lib/tests/test_cf_query_scoped_degradation.py`
- `graph-editor/lib/tests/test_analysis_subject_resolution.py`

**Required changes**

- Keep the dependency-audit test green so the production forecast stack
  does not drift back onto v1/v2/span-adapter imports.
- Make the CF response contract explicit at the handler boundary,
  including completeness and provenance fields.
- Make the FE graph-projection authority explicit for CF-owned fields,
  including fast-path and slow-path overwrite behaviour.
- Make whole-graph subject coverage explicit for the `all_graph_parameters`
  scope.
- Preserve or tighten chart-versus-CF parity checks for equivalent
  semantic questions.
- Preserve the query-scoped degradation tests that already encode doc 57.
- Refresh stale harness status notes before triaging gaps. As of
  22-Apr-26, the focused suites
  `test_conditioned_forecast_response_contract.py`,
  `test_temporal_regime_separation.py`, and
  `conditionedForecastCompleteness.test.ts` are green even though
  some comments or filenames still describe them as RED / expected-fail
  style guards.
- Make the `asat()` seam explicit in the harness map so shared
  preparation, evidence filtering, and posterior resolution do not drift
  silently when historical basis changes.
- Freeze a small outside-in CLI assurance layer around the public tooling,
  not just in-process tests. At minimum, classify and retain the
  `graph-ops` harnesses that cover `asat()` blind behaviour, whole-graph
  CF versus chart parity, and multi-hop degeneracy in limit cases.
- Freeze the designated synth-fixture set for that outside-in layer up
  front. Do not opportunistically swap fixtures mid-series, and treat any
  oracle-capturing harness as subject to the fixture-ownership problem
  described in `../test-fixture-ownership-problem.md`.

Before WP1 starts, record an explicit disposition for each overlapping
pre-existing red in doc 58: fix now, `xfail(strict=True)` pending a later
package, or rewrite against the live public contract. At minimum that
disposition must cover
`test_doc56_phase0_behaviours.py::test_cf_span_prior_matches_resolver_concentration`;
if any `test_bayes_cohort_maturity_wiring.py` cases are being reused as
overlay / parity guards, doc 58 Groups A/B/D are rewrite-or-quarantine
candidates rather than silent blockers. A forward-looking contract canary
(for example a scoped multi-hop CF case) is fine, but it must be labelled
as such rather than inherited as an unexplained red.

**Do not do**

- Do not start semantic changes before these tests exist.
- Do not mistake full-row golden snapshots or exact MC trace equality for
  the main guidance mechanism. Those are poor TDD anchors here.

**Done when**

- the engineer has green or intentionally-red tests at the public
  contract, parity, authority, and subject-coverage seams
- dependency audit is green
- no overlapping harness red remains unexplained; anything intentionally
  red is explicitly classified
- the workstream can move internals without flying blind

### WP1 — Extract one shared preparation path for chart and CF

**Objective**

Stop the chart path and the CF path from deciding subject semantics,
regime selection, and frame composition separately.

**Primary files**

- `graph-editor/lib/api_handlers.py`
- `graph-editor/lib/analysis_subject_resolution.py` if subject-resolution
  outputs need to be widened or clarified
- `graph-editor/lib/runner/forecast_runtime.py` or a sibling runtime
  preparation module
- `graph-editor/lib/runner/cohort_maturity_derivation.py`
- `graph-editor/lib/runner/span_evidence.py`

**Required changes**

- Introduce one shared preparation helper for chart and CF.
- That helper should own, at minimum:
  - subject resolution from query DSL
  - temporal-mode selection
  - candidate-regime handling
  - doc 47's multi-hop cohort subject-frame rule
  - `asat()` propagation: evidence cutoff, evaluation date, posterior
    cutoff, and continuity of `asat()` metadata into admissibility and
    evidence selection
  - snapshot reads
  - frame derivation
  - span-evidence composition
  - identification of anchor, denominator node `X`, and subject end
- Both `handle_conditioned_forecast` and `_handle_cohort_maturity_v3`
  must delegate to this helper instead of maintaining their own local
  preparation branches.

**Do not do**

- Do not redesign the engine here.
- Do not add a separate whole-graph-only preparation path if the same
  semantics can be expressed through the shared helper.
- Do not leave a local `is_window` branch inside one caller that changes
  subject evidence family independently of the shared helper.
- Do not let one caller treat `asat()` as only a snapshot-read filter
  while another also changes posterior or admissibility basis. The
  three-date contract must enter from one seam.

**Done when**

- chart and CF are demonstrably using the same preparation policy for the
  same semantic question
- doc 47's rule applies in both callers from the same seam
- `asat()` cases preserve one shared evidence / posterior / evaluation
  basis rather than caller-local variants

### WP2 — Make the runtime bundle explicit

**Objective**

Turn the semantic roles from doc 59 into explicit runtime data, so later
packages are moving a known object model rather than a cloud of flags.

**Primary files**

- `graph-editor/lib/runner/forecast_runtime.py`
- `graph-editor/lib/runner/model_resolver.py`
- `graph-editor/lib/runner/forecast_state.py`
- `graph-editor/lib/runner/cohort_forecast_v3.py`

**Required changes**

- Introduce an explicit prepared runtime bundle. The engineer may choose
  the exact type names, but the bundle must carry at least:
  - `population_root`
  - `carrier_to_x`
  - `subject_span`
  - `numerator_representation`
  - `p_conditioning_evidence`
- The same bundle should also carry the prepared operator inputs,
  admissibility outputs, and any later `sweep_eligible` or degraded-path
  flags so callers do not reconstruct them for themselves.
- Add an explicit diagnostic serialiser if tests need to inspect the
  bundle. Do not teach tests to reach through private locals or transient
  `_forensic` detail.

**Do not do**

- Do not make the bundle itself the public API. It is an internal
  contract between preparation, engine, and projection layers.
- Do not let callers keep inferring roles from path length or
  `is_multi_hop` once the bundle exists.

**Done when**

- chart, CF, and any bounded summary caller are all consuming an explicit
  prepared runtime bundle
- the semantic roles are inspectable through explicit diagnostics rather
  than incidental internal state

### WP3 — Restore the factorised default for cohort mode

**Objective**

Make the live runtime actually follow the factorised cohort contract from
docs 59 and the semantics note.

**Primary files**

- `graph-editor/lib/runner/forecast_runtime.py`
- `graph-editor/lib/runner/cohort_forecast_v3.py`
- `graph-editor/lib/api_handlers.py`
- `graph-editor/lib/runner/forecast_state.py`

**Required changes**

- Make the default cohort runtime:
  - denominator side: `carrier_to_x`
  - numerator side: `subject_span(X -> end)`
- Ensure that:
  - single-hop `cohort(A, X-Y)` uses `A -> X` plus `X -> Y`
  - multi-hop `cohort(A, X-Z)` uses `A -> X` plus full `X -> Z`
  - `A = X` collapses the carrier cleanly in single-hop and multi-hop
  - `window()` remains identity-carrier / `X`-rooted
- Keep whole-query numerator reuse behind explicit admission policy only.
- Remove, replace, or neutralise `_widen_span` as a semantic decision
  point in `handle_conditioned_forecast` and
  `_handle_cohort_maturity_v3`. Do not broaden this package into
  `_handle_cohort_maturity_v2` or the frozen v2 chart / parity-oracle
  path. If a similarly named helper survives, it must represent a
  derived collapse, not a policy switch.

**Do not do**

- Do not treat anchor-rooted whole-query objects as the default subject
  solve.
- Do not fix multi-hop only while leaving the single-hop cohort runtime
  anchored on the wrong side of `X`.

**Done when**

- the live cohort default is factorised
- multi-hop subject semantics are full `X -> end`
- chart, scoped CF, and whole-graph CF still agree externally for
  equivalent cases

### WP4 — Move subject-span execution onto prepared operator parameters

**Objective**

Make `span_kernel.py` a subject-span executor, not a semantic source
selector.

**Primary files**

- `graph-editor/lib/runner/span_kernel.py`
- `graph-editor/lib/runner/span_evidence.py`
- `graph-editor/lib/runner/forecast_runtime.py`
- `graph-editor/lib/runner/model_resolver.py`

**Required changes**

- Make the runtime layer responsible for choosing the rate prior block,
  latency prior block, and any admitted helper or gross-numerator
  consequence.
- Pass prepared operator parameters into `span_kernel.py`.
- Remove semantic source selection from `span_kernel.py` itself.
- Ensure the same prepared subject-operator path feeds both the chart and
  CF runtime.

**Do not do**

- Do not turn `span_kernel.py` into a second resolver.
- Do not leave raw field walks or source-name heuristics in the kernel if
  those decisions can be made earlier.

**Done when**

- `span_kernel.py` executes prepared subject-span inputs only
- semantic source selection sits in the runtime / resolver layer
- helper order or projection order no longer changes multi-hop meaning

### WP5 — Enforce the projection contract and consumer boundaries

**Objective**

Make all first-class consumers read correct projections from the shared
runtime, and keep the analytic fallback explicitly bounded.

**Primary files**

- `graph-editor/lib/api_handlers.py::handle_conditioned_forecast`
- `graph-editor/src/services/conditionedForecastService.ts`
- `graph-editor/lib/runner/runners.py`
- `graph-editor/lib/runner/forecast_state.py`
- `graph-editor/lib/api_handlers.py::_compute_surprise_gauge`
- `graph-editor/lib/api_handlers.py::handle_stats_topo_pass`

**Required changes**

- Treat the CF response as the authoritative conditioned scalar surface.
- Treat `conditionedForecastService.ts` as the authoritative graph
  projection of CF-owned fields.
- Preserve CF authority over:
  - `edge.p.mean`
  - `edge.p.forecast.mean`
  - `edge.p.latency.completeness`
  - `edge.p.latency.completeness_stdev`
- Keep `run_conversion_funnel` on the public CF response rather than on
  inner kernels.
- Bring summary callers onto the shared runtime contract where coherent.
  Where not coherent, return an explicit degraded or unavailable result
  instead of an accidental semantic fork.
- Keep `handle_stats_topo_pass` bounded. If its minimal forecast tail
  remains temporarily, it must stay explicitly provisional and must not
  be expanded to patch semantic gaps that belong in CF.

**Do not do**

- Do not preserve FE/topo completeness over CF completeness on CF-owned
  fields.
- Do not move direct consumers such as the funnel onto inner kernels
  "for convenience".
- Do not let the analytic topo path become a silent second conditioned
  writer.

**Done when**

- graph-state consumers read authoritative conditioned fields
- direct-response consumers see the same semantics as the conditioned
  writer of record
- summary consumers are either aligned or explicitly bounded

### WP6 — Harden whole-graph sequencing and donor routing

**Objective**

Make the whole-graph CF pass a genuinely trustworthy first-class writer.

**Primary files**

- `graph-editor/lib/api_handlers.py::handle_conditioned_forecast`
- `graph-editor/lib/runner/forecast_runtime.py`
- any graph-ordering or subject-resolution helper needed to support the
  above

**Required changes**

- Use a real topological order across the parameterised graph for
  whole-graph CF.
- Route upstream donor information through the same preparation policy as
  the main subject path.
- Ensure cached donor results are keyed by semantic identity, not by
  incidental edge-list order.
- Add or strengthen an order-invariance test: the same graph and the same
  semantics with a different edge-list order must produce the same
  conditioned response and the same graph projection.

**Do not do**

- Do not keep a shallow "start-node edges first, everything else later"
  ordering rule as the long-term solution.
- Do not let donor-routing logic pick regimes or evidence families by
  ad hoc local shortcuts.

**Done when**

- whole-graph CF is invariant under edge-list reorder
- more-than-one-layer donor propagation is correct
- donor routing obeys the same semantic policy as the main subject prep

### WP7 — Implement query-scoped sweep eligibility and degraded outputs

**Objective**

Land doc 57 on the cleaned runtime boundary.

**Primary files**

- `graph-editor/lib/runner/forecast_runtime.py`
- `graph-editor/lib/api_handlers.py::handle_conditioned_forecast`
- `graph-editor/lib/api_handlers.py::_handle_cohort_maturity_v3`
- `graph-editor/lib/api_handlers.py` daily-conversions forecast annotation
  path, plus any helper it uses for `rate_by_cohort` projections
- `graph-editor/lib/runner/cohort_forecast_v3.py`
- `graph-editor/lib/api_handlers.py::_compute_surprise_gauge`
- every other active caller of the same sweep predicate; the named list
  above is illustrative, not a licence to defer a live consumer because
  its file was not in the first batch

**Required changes**

- Implement one shared runtime helper based on
  `ResolvedModelParams.alpha_beta_query_scoped`.
- Eligible edges run the sweep. Query-scoped posterior edges do not.
- CF degraded edges stay in the normal `edges[]` response and carry the
  provenance and conditioning fields agreed in doc 57.
- Reuse the existing Beta closed-form semantics for the degraded rate-side
  outputs. Do not invent separate degraded formulas per caller.
- Apply the same predicate and caller-facing contract across CF, the v3
  chart path, the daily-conversions forecast path, the surprise gauge's
  unavailable branch, and any other live first-class consumer that
  reaches the same decision. Do not defer a live caller merely because it
  was not in the first file list.
- Make the surprise gauge explicitly unavailable rather than emitting a
  degraded numeric substitute.
- Keep the rule per-edge. Do not propagate ineligibility downstream
  topologically.

**Do not do**

- Do not branch on source-name heuristics when
  `alpha_beta_query_scoped` already captures the semantic property.
- Do not route degraded edges into `skipped_edges[]` if doc 57 says they
  belong in the normal result set.
- Do not create one degraded contract for CF, another for chart, and a
  third for the gauge.
- Do not leave one live caller on legacy query-scoped sweep logic while
  another has moved to the shared helper. The invariant is pack-wide.

**Done when**

- doc 57's degraded-output and unavailable contracts are implemented
  consistently across all active callers of the shared predicate
- previously query-scoped sweep paths are explicit and honest rather than
  silently incoherent

### WP8 — Add the flagged direct-`cohort()` rate-conditioning path

**Objective**

Add the late, narrow evidence enhancement from doc 59 only after the
structural and degraded-path work is green, and only if the owner has
explicitly ratified that behaviour change for this workstream.

**Primary files**

- `graph-editor/lib/runner/forecast_runtime.py`
- `graph-editor/lib/runner/model_resolver.py` only if a small plumbing
  addition is genuinely required
- any caller that needs the flag wired through the runtime bundle

**Required changes**

- Confirm that WP8 itself is in scope before coding it. If the late
  behaviour change has not been ratified, stop after WP7 and treat this
  package as deferred follow-on work rather than implied scope.
- Add an explicit flag controlling only `p_conditioning_evidence`.
- First landing should be cohort mode only and limited to exact or
  low-ambiguity subject matches, preferably single-hop first.
- Keep carrier semantics, latency semantics, and representation choice
  unchanged.
- Continue obeying `alpha_beta_query_scoped` discipline:
  aggregate priors may update; query-scoped posteriors still do not.
- Preserve the existing aggregate-prior blend discipline from doc 52
  wherever the late flag changes the rate-conditioning seam.
- Start WP8 with a short design note that fixes the exact rate-update
  mechanism for this flag and how doc 52's aggregate-prior discipline is
  preserved.

**Do not do**

- Do not let this flag silently promote gross whole-query numerators.
- Do not let it rewrite latency or carrier semantics.
- Do not land it in the same change as the structural packages above.

**Done when**

- the behaviour change is isolated to the intended rate-conditioning seam
- earlier parity, authority, and degradation tests remain green

### WP9 — Remove obsolete branches and align the docs

**Objective**

Finish the workstream by removing the semantic forks that are no longer
needed and bringing the docs back into sync with the code.

**Primary files**

- the in-scope runtime, handler, and consumer files above
- `docs/current/project-bayes/59-cohort-window-forecast-implementation-scheme.md`
- `docs/current/project-bayes/60-forecast-adaptation-programme.md`
- `docs/current/project-bayes/57-cf-eligibility-topological-degradation.md`
- any codebase doc whose field-authority or subsystem description changed

**Required changes**

- Delete or collapse duplicated preparation branches that survived the
  transition.
- Delete or collapse obsolete semantic flags that no longer carry real
  policy.
- Keep the dependency audit green; do not reintroduce legacy imports.
- Update the docs to acknowledge any rare residual fallback that remains
  after WP7 (for example the no-posterior / no-manual-override weak-prior
  path) rather than implying that every such branch vanished entirely.
- Update the docs so they describe the live boundary rather than both the
  old and new boundary side by side.

**Do not do**

- Do not reopen the separate v1/v2 chart-retirement workstream here.
- Do not leave a broad "temporary" branch in place without an explicit
  owner and follow-up.

**Done when**

- one preparation policy remains
- one explicit runtime bundle remains
- one projection contract remains
- docs and code describe the same system

## 10. Required tests and likely homes

The tests below are the main guidance system for this workstream.

| Test category | Protects against | Likely home | Main packages |
|---|---|---|---|
| CF response contract | response-shape drift, missing completeness / provenance fields | `graph-editor/lib/tests/test_conditioned_forecast_response_contract.py` | WP0, WP5, WP7 |
| CF graph authority | FE/topo values surviving over CF-owned fields in fast or slow path | `graph-editor/src/services/__tests__/conditionedForecastCompleteness.test.ts` | WP0, WP5, WP7 |
| chart / CF parity at equivalent question | drift between whole-graph CF, scoped CF, and chart horizon reads | `graph-editor/lib/tests/test_doc56_phase0_behaviours.py` | WP0-WP3 |
| subject coverage and `all_graph_parameters` scope | whole-graph CF touching the wrong edge set | `graph-editor/lib/tests/test_analysis_subject_resolution.py` | WP0, WP1, WP6 |
| multi-hop regime separation and doc 47 rule | wrong evidence family during subject-frame construction | `graph-editor/lib/tests/test_temporal_regime_separation.py` | WP1, WP3 |
| `asat()` evidence / posterior / evaluation-date contract | drift between shared preparation, evidence visibility, posterior selection, and historical-basis projections | `graph-editor/lib/tests/test_asat_contract.py` and `graph-editor/src/services/__tests__/asatPosteriorResolution.integration.test.ts` | WP0, WP1, WP5 |
| runtime dependency audit | regression back onto legacy v1/v2 runtime helpers | `graph-editor/lib/tests/test_forecast_stack_dependencies.py` | WP0, WP9 |
| query-scoped degraded contract | double-conditioning on already-query-scoped posteriors | `graph-editor/lib/tests/test_cf_query_scoped_degradation.py` and `graph-editor/lib/tests/test_forecast_state_cohort.py` | WP0, WP5, WP7 |
| span-operator contract | subject-span layer still doing resolver work or raw-field selection | `graph-editor/lib/tests/test_span_kernel.py` | WP4 |
| funnel boundary | direct CF consumer bypassing the public CF surface | `graph-editor/lib/tests/test_funnel_contract.py` | WP5 |
| whole-graph order invariance | edge-list-order-dependent whole-graph CF outputs | extend `graph-editor/lib/tests/test_doc56_phase0_behaviours.py` or add a dedicated whole-graph CF topology contract test | WP6 |

Status note for WP0 triage: some focused suites still carry historical
"RED" wording in comments or filenames, but that wording is not the live
status signal. As of 22-Apr-26, targeted runs of
`test_conditioned_forecast_response_contract.py`,
`test_temporal_regime_separation.py`, and
`conditionedForecastCompleteness.test.ts` are green. WP0 should
refresh stale status notes before using those files as evidence of an
open gap.

### Outside-in CLI / graph-ops harnesses

The table above is not the whole assurance story. For this programme, a
small set of outside-in CLI harnesses should also be treated as part of
the guidance system because they exercise the public tooling on stable
fixtures and catch semantic drift in degeneracy / limit cases that
unit-level tests can miss.

Fixture-selection rule for these harnesses:

1. choose the smallest graph that makes the invariant non-vacuous
2. use topology matrices only for topology / whole-graph claims
3. use one-purpose fixtures for `asat()` and semantic degeneracies first
4. keep sparse, high-cardinality, slow-path, and identifiability fixtures
   out of the core gate set unless that exact property is under test

| Outside-in harness | Preferred fixtures | Protects against | Main packages | Expectation in this workstream |
|---|---|---|---|---|
| `graph-ops/scripts/asat-blind-test.sh` | `synth-simple-abc` primary; `synth-context-solo-mixed` when context / epoch interaction is the point | `asat()` drift across `param-pack.sh` and `analyse.sh`; historical evidence / posterior / evaluation-date inconsistencies leaking through the public tooling | WP0, WP1, WP5 | Core outside-in gate |
| `graph-ops/scripts/conditioned-forecast-parity-test.sh` plus `graph-ops/scripts/cf-topology-suite.sh` | `synth-simple-abc`, `cf-fix-linear-no-lag`, `synth-mirror-4step`, `cf-fix-branching`, `cf-fix-diamond-mixed`, `cf-fix-deep-mixed` | whole-graph CF drifting from the v3 chart reference; topology-specific regressions across the T1-T7 matrix; daily-conversions / asat visibility regressions already encoded in the harness | WP5-WP7 | Core outside-in gate |
| `graph-ops/scripts/multihop-evidence-parity-test.sh` | `synth-mirror-4step` | failure of the doc 47 seam in the non-latent-upstream limit where `cohort()` and `window()` should degenerate to the same evidence basis | WP0-WP3 | Core outside-in canary; may begin life as intentional red and must then be classified explicitly |
| `graph-ops/scripts/window-cohort-convergence-test.sh` | `synth-mirror-4step` primary; `synth-lat4` secondary when genuine upstream-latency divergence is the property under test | cohort multi-hop composition drift in approximate / limit-case behaviour | WP3, WP6 | Secondary sanity check, not the primary acceptance oracle |
| `graph-ops/scripts/cohort-maturity-model-parity-test.sh` | `synth-mirror-4step` | chart main-midline versus promoted-overlay divergence on `cohort_maturity` surfaces | WP3-WP5 when overlay-bearing chart surfaces are touched | Targeted guard, not a universal gate |
| `graph-editor/lib/tests/test_v3_degeneracy_invariants.py` (with shell companion `graph-ops/scripts/v3-degeneracy-invariants.sh`) | `synth-mirror-4step` primary; `synth-lat4` for all-latency divergence | v3 chart losing mode distinction on the zero-evidence path; window asymptote drift from `p.mean`; `A = X` cohort failing to collapse onto window; cohort overshooting window | WP3-WP6 and anything touching `cohort_forecast_v3.compute_cohort_maturity_rows_v3` | Core outside-in gate for v3-only semantic degeneracies; baseline reds on 23-Apr-26 recorded in doc 65 §14 |

Rationale for the designated graphs:

- `synth-simple-abc` is the primary outside-in history / tooling fixture
  because it is a tiny linear graph, easy to reason about, already used
  successfully by the `asat()` blind tests, and simple enough that
  changes in evidence visibility, completeness, or daily-conversions
  boundary behaviour remain interpretable.
- `synth-mirror-4step` is the primary multi-hop / mixed-class fixture
  because it combines non-latent upstream segments with a latency-bearing
  subject span. That makes it the cleanest graph for doc 47's
  non-latent-upstream degeneracy, multi-hop cohort/window comparisons,
  overlay checks, and mixed latency / non-latency public-tooling checks.
- The `cf-fix-*` fixtures belong in the whole-graph CF topology suite,
  not as general-purpose fixtures for every harness. Their value is the
  T1-T7 topology matrix: linear no-lag, branching, diamond, and deep
  mixed-depth coverage.
- `synth-context-solo-mixed` is a secondary `asat()` fixture rather than a
  default one. Use it when the question is specifically about
  context-qualified or mixed-epoch historical basis, not for every
  outside-in run.
- `synth-lat4` is a secondary divergence fixture. It is useful when the
  engineer needs to prove that upstream latency should make `cohort()`
  and `window()` differ, so the non-latent degeneracy rule from
  `synth-mirror-4step` is not over-generalised.

Do not promote `synth-slow-path`, `synth-mirror-4step-slow`, sparse
high-cardinality fixtures, or two-dimension context graphs into the core
gate set for this programme. Those are useful research or stress assets,
but they introduce too much unrelated noise for the main structural
refactor.

For `param-pack.sh`, no separate graph matrix is required here: treat
`graph-ops/scripts/asat-blind-test.sh` as the outside-in `param-pack`
gate. For `analyse.sh --type cohort_maturity`, the primary outside-in
graphs are `synth-simple-abc` for simple historical-basis checks and
`synth-mirror-4step` for multi-hop / mixed-class checks. For
daily-conversions outside-in assurance, keep the existing
`synth-simple-abc` historical-boundary checks in the conditioned-forecast
parity harness rather than inventing a second broad parity matrix.

The intent is not to promote every existing CLI or shell harness into a
mandatory pre-merge gate. The valuable addition here is a **small**
outside-in layer that exercises the same public tooling users and agents
actually call.

### Good TDD candidates

The best red-test candidates for this workstream are:

- public response contracts
- graph field-authority contracts
- cross-consumer parity seams
- subject-coverage seams
- query-scoped degraded/unavailable contracts
- whole-graph ordering invariants
- outside-in degeneracy checks through the CLI tooling on stable synth or
  fixed fixtures

### Bad TDD candidates

The following are poor programme-level guides and should not drive the
delivery plan:

- full golden snapshots of `maturity_rows`
- exact multi-hop numeric expectations with no closed-form oracle
- tests coupled to private runtime-bundle dict layout
- AST tests that assert local variable names or helper-call shape instead
  of user-visible contract
- full forensic-payload equality across consumers

Those checks may still be useful for local forensics, but they are too
brittle to act as the main delivery guardrails.

## 11. Recommended landing order and PR boundaries

The work packages above should land in this order:

1. **Prerequisite check / harness** — WP0
2. **Shared preparation seam** — WP1
3. **Explicit runtime bundle** — WP2
4. **Factorised cohort default** — WP3
5. **Prepared operator path** — WP4
6. **Projection boundary cleanup** — WP5
7. **Whole-graph sequencing** — WP6
8. **Query-scoped degraded path** — WP7
9. **Late flagged direct-`cohort()` `p` enhancement** — WP8
10. **Cleanup and documentation alignment** — WP9

WP0-WP7 are the implementation-ready structural programme. WP8 is a
separate, ratified-only follow-on package. If that behaviour change is
not ratified, stopping after WP7 is a coherent delivery point rather than
an incomplete half-state.

Recommended PR grouping:

- PR 1: WP0 + the smallest substrate fixes needed to make the tests
  meaningful
- PR 2: WP1
- PR 3: WP2 + WP3
- PR 4: WP4
- PR 5: WP5 + WP6
- PR 6: WP7
- PR 7: WP8, if ratified
- PR 8: WP9

If WP1 proves too large to review coherently as one PR, split it into an
early subject / temporal-identity pass and a follow-on regime / frame-
composition pass. Do not split the shared-preparation seam across
unrelated packages.

This grouping keeps each reviewable unit coherent:

- PR 1 freezes the guidance system
- PR 2 removes duplicated preparation
- PR 3 makes the runtime semantics explicit and correct
- PR 4 cleans the subject-span execution seam
- PR 5 cleans the consumer and whole-graph writer boundaries
- PR 6 lands the already-agreed degraded path on the cleaned substrate
- PR 7 adds the late enhancement in isolation
- PR 8 removes leftovers and updates docs

Do not combine WP8 with the structural packages. That would hide whether a
regression came from the late enhancement or from the runtime cleanup.

## 12. Final acceptance criteria

The workstream is complete only when all of the following are true:

1. chart and conditioned forecast share one preparation policy
2. the runtime bundle carries the semantic roles explicitly
3. the default cohort runtime is factorised
4. multi-hop subject semantics are always full `X -> end`
5. doc 47's subject-frame rule is true in both chart and CF callers
6. the whole-graph CF pass is topologically stable and order-invariant
7. CF owns its graph fields and the FE projection respects that ownership
8. direct consumers such as the funnel consume the public CF surface
9. summary callers are either aligned with the shared runtime or
   explicitly degraded / unavailable
10. query-scoped posterior edges do not run the sweep again, and the
    degraded / unavailable contract is consistent across all active
    callers of that predicate
11. `asat()` evidence visibility, posterior selection, evaluation date,
    and admissibility metadata remain aligned across shared preparation
    and downstream projections
12. the selected outside-in CLI harnesses for `asat()`, multi-hop
    degeneracy, and whole-graph CF parity pass on their designated
    fixtures, or are explicitly classified when still intentional red
13. the analytic topo pass remains bounded and cannot shadow CF
14. the dependency audit stays green
15. the docs describe the live boundary accurately

## 13. Relationship to later work

This implementation plan is compatible with later B3 work, but it does
not depend on B3 and must not be blocked on B3.

This plan also does not subsume the separate workstreams that retire the
v1/v2 chart features or any later consumer feature work. Its purpose is
to leave the forecast stack clean enough that those later workstreams can
build on a stable semantic boundary instead of extending today's drift.
