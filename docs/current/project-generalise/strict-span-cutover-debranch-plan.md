# Strict Span Cutover And Debranch Plan

**Status**: draft for review  
**Date opened**: 13-May-26  
**Scope**: production cutover of the general span readout for `cohort_forecast_v3` selected evidence and model readout.

## Purpose

This plan exists because the previous work did not achieve cutover or debranching. It landed a targeted regression fix and kept the old selected-prefix machinery alive. That is not enough.

A proper cutover means the new span readout is promoted into stable production code, becomes the single authority for span construction/readout, and the candidate files stop being the implementation surface.

A proper debranch means span construction no longer has explicit or implicit mode forks around identity carrier, active carrier, single-hop, multi-hop, latent, non-latent, model, or evidence. Those cases must enter as different operators and root surfaces supplied to one core. If a case needs a branch in the evaluator or row projection, the operator supply boundary is not explicit enough.

## Definitions

**Cutover** means all maintained production span readouts route through the promoted span core. The old bespoke selected-prefix family is no longer an authority, not even as a fallback. Shadow diagnostics are not cutover.

**Debranch** means the runtime compiles request semantics into span plans and then evaluates every span through the same core. Identity carrier is an empty operator sequence. Single-hop is one operator. Multi-hop is multiple operators. Non-latent timing is a point-mass operator. Covered-zero evidence is value zero with support present. Absent evidence is no support.

**Candidate retirement** means files under `docs/current/project-generalise/*_candidate.py` are either promoted into stable locations under `graph-editor/lib/runner/` without the candidate name, or deleted after their tests are migrated. A candidate module must not remain on the production import path.

## Current State

The current branch has:

- Isolated candidate modules under `docs/current/project-generalise/`.
- A production `generalised_span_model_shadow.py` that reimplements operator-chain algebra instead of delegating to the candidate core.
- Production row code in `cohort_forecast_v3.py` that still carries `_SelectedSourceDayMass`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix`, `SelectedAClockEvidence`, and selected-cohort reducer logic.
- A targeted fix for the non-latent upstream collapse oracle, implemented by changing operator supply for that case, not by deleting the old prefix family.
- The stochastic selected-cohort reducer `_selected_cohort_group_rate_draws`, including the Pop D / Pop C projection and its identity-carrier branch. This is in scope. If it remains as an independent projection engine, debranching has not happened.
- A local-window denominator substitution branch (`_build_local_window_denominator_surface` selected for identity or zero-delay active carriers). This is current debt introduced by the targeted fix and must be dissolved into ordinary operator supply.
- `build_cohort_evidence_from_frames` still shapes `engine_cohorts`, `cohort_list`, and observed prefixes through mode-aware branches. These frame responsibilities must either be retired from span authority or explicitly narrowed to perimeter materialisation.
- Production tests currently import candidate modules from `docs/current/project-generalise/` for shadow parity checks. Those imports must be migrated or deleted during promotion; test-only candidate imports are not exempt from candidate retirement.

Therefore the branch is not cut over and not debranched.

## Target End State

The stable runtime has one promoted span readout module and one promoted operator-supply module under `graph-editor/lib/runner/`. Their names do not include `candidate` or `shadow`.

The promoted span core owns only algebra:

- It receives root value/support.
- It receives ordered value/support operators.
- It pushes ledgers forward.
- It projects value/support prefixes by selected root day and row age.
- It carries provenance.

The promoted core does not know whether a request is `window()`, `cohort()`, identity carrier, active carrier, single-hop, multi-hop, latent, non-latent, model, or evidence.

Operator supply owns all case knowledge before the core:

- Model operators come from conditioned primitives and preserve draw-family semantics.
- Evidence operators come from admitted primitive evidence rows and preserve support separately from value.
- Midpoint shifts and interpolation corrections live in observed evidence operator construction.
- Identity carrier supplies an empty carrier operator list.
- Non-latent and deterministic timing supply point-mass operators.

Row projection reads only span-prefix outputs. It does not rebuild carrier semantics, subject semantics, denominator mass, numerator mass, support, coverage, or frontier state.

The old bespoke prefix family is deleted as runtime authority.

## Non-Goals

This plan does not change primitive conditioning. The single conditioning locus remains `primitive_conditioning.condition_primitive`.

This plan does not redesign evidence acquisition. Evidence still enters through the existing candidate pool and primitive-bound rows.

This plan does not weaken the outside-in oracle suite. `test_cohort_factorised_outside_in.py` remains the acceptance oracle after implementation, not a thing to edit into agreement.

This plan does not keep an old/new branch as a rollout strategy. Temporary comparison instrumentation may exist inside one development stage, but it must be deleted before the stage is complete.

## Stage 0: Freeze The Contract

Write the production span contract before moving code. The contract lives at `docs/current/project-generalise/strict-span-production-contract.md` until implementation lands; after cutover it should be promoted or absorbed into `docs/current/codebase/CF_ROW_PIPELINE.md` / `FORECAST_RUNTIME_ARCHITECTURE.md`.

The contract must name the durable objects in prose: span plan, root surface, operator, prefix surface, support surface, and provenance. It must state which layer owns each object and which fields are allowed to influence identity.

Required contract sections:

- **Objects**: `SpanPlan`, `RootSurface`, `SpanOperator`, `PrefixSurface`, `SupportSurface`, provenance.
- **Ownership**: which module builds each object, which module evaluates it, which module projects rows.
- **Identity Rules**: primitive identity, role identity, draw-family identity, evidence identity, and what does not enter identity.
- **Particle Semantics**: how draw-coherent model spans preserve the `S` particle axis.
- **Evidence Semantics**: covered-zero versus absent, support propagation, and source-day-specific evidence.
- **Midpoint Policy**: where midpoint shift, interpolation, and curvature correction live.
- **Reducer Semantics**: whether Pop D / Pop C projection is represented as operators, root surfaces, or a particle-aware projection plan.

Acceptance gate:

- Reviewers can point to one contract and answer: “where is value computed?”, “where is support computed?”, “where does identity carrier degenerate?”, and “where do midpoint corrections live?”
- Reviewers can point to one contract section and answer: “what happens to `_selected_cohort_group_rate_draws`?”
- The contract explicitly rejects shadow-only proof and old/new branch proof.

## Stage 1: Promote The Candidate Core

Move the pure candidate core into a stable runtime module under `graph-editor/lib/runner/`.

The promoted module must be the only implementation of the operator-chain algebra. `generalised_span_model_shadow.py` must either be deleted or reduced to a thin diagnostic wrapper that imports the promoted core and cannot drift.

The candidate tests move from `docs/current/project-generalise/` into `graph-editor/lib/tests/`, renamed as production tests. The old candidate files are removed or archived after promotion; production must not import from `docs/current/project-generalise/`.

Acceptance gate:

- There is no production algebra implementation outside the promoted core.
- The old shadow engine does not contain independent ledger multiplication.
- Tests prove covered-zero and absence are distinct through the promoted production module.
- `graph-editor/lib/tests/test_generalised_span_model_shadow.py` no longer imports candidate modules from `docs/current/project-generalise/`; it either imports the promoted core or is deleted with the old shadow wrapper.

## Stage 2: Promote Operator Supply

Move operator construction into a stable production module under `graph-editor/lib/runner/`.

This module owns primitive-to-operator translation for both model and evidence surfaces.

For model operators, choose and document one production semantic:

- The production model operator must preserve joint draw-family mass where draws are available. The authority is the mass curve implied by the same draw index, not a product of unrelated marginal summaries.
- Marginal `mean(p) × mean(CDF)` curves may exist only as diagnostics and must be labelled as such.

This requires an explicit particle-axis strategy. The current dense candidate core is deterministic and has no `S` axis. Promotion must choose one production representation before model cutover:

- a particle-aware ledger shape such as `(cohort, particle, day)`;
- or one operator chain per particle with shared root/support surfaces;
- or another documented representation that preserves same-index draw-family coherence without multiplying unrelated marginal summaries.

The chosen strategy must cover the stochastic selected-cohort reducer. If Pop D / Pop C projection still runs outside the promoted core, the model path is not debranched.

For evidence operators:

- The input is admitted primitive evidence rows or the canonical request candidate pool, not frame fallbacks or graph fields.
- Value and support are separate.
- Covered-zero is represented as value zero with positive support.
- Midpoint shift and curvature correction are input-surface policies that produce an operator; they are not evaluator branches.

Acceptance gate:

- One model operator path handles latent, non-latent, deterministic, single-edge, and multi-edge inputs by supplied surfaces.
- One evidence operator path handles direct age-indexed rows and source-day-specific rows by supplied surfaces.
- A parity test compares operator-supply output to the promoted span core, not to a second implementation.
- A draw-coherence test proves that two consumers of the same primitive under the same `DrawFamilyKey` get the same per-particle mass curve.
- A covariance-sensitive fixture proves the implementation is not silently using `E[p] × E[CDF]` where the contract requires `E[p × CDF]`.

## Stage 3: Build Production Span Plans

Introduce one production path that compiles a `ResolvedCFRuntime` into role-labelled span plans:

- Carrier model span.
- Subject model span.
- Request model span.
- Denominator evidence span.
- Numerator evidence span.
- Request evidence span when needed for reducer/frontier state.
- Selected-cohort stochastic projection plan, replacing the independent Pop D / Pop C reducer as a separate authority.

Carrier and subject are role labels on the same plan shape. The compiler may inspect runtime semantics; the evaluator must not.

Identity carrier compiles to a carrier plan with no operators. Active carrier compiles to carrier operators. Non-latent upstream chains compile to point-mass operators, so collapse to the equivalent window seed happens algebraically.

`build_cohort_evidence_from_frames` is in scope as a perimeter materialiser only. It may produce raw selected cohort dates, root masses, observation dates, and frame metadata for the plan compiler. It must not remain an authority for observed prefixes once strict span plans exist. Existing `is_window` / active-carrier branches inside it must either be deleted, or proven to live strictly outside span construction.

Acceptance gate:

- No row/projection function asks whether a subject is single-hop or multi-hop.
- No row/projection function asks whether a carrier is identity or active.
- Those distinctions appear only in the plan compiler and only as operator/root-surface selection.
- `build_cohort_evidence_from_frames` no longer emits mode-specific prefix authority consumed by row projection or the reducer.
- The local-window denominator substitution branch has disappeared; zero-delay collapse is represented by point-mass carrier operators and ordinary evidence operator supply.

## Stage 4: Replace Selected Prefix Authorities

Replace `_SelectedSourceDayMass`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix`, and selected A-clock amplitude logic with prefix surfaces returned by the promoted span core.

The row evidence fields read from the strict evidence prefix:

- `evidence_x` reads the denominator evidence prefix value.
- `evidence_y` reads the numerator evidence prefix value.
- Coverage reads the prefix support channel.
- Frontier state reads the same prefix object.

The selected-cohort reducer must read `x_frozen` and `y_frozen` from the same prefix object that row evidence uses. This is the seam invariant and the primary cutover gate.

Acceptance gate:

- There is one prefix object per role, produced by the promoted core.
- Row evidence and reducer frontier state read the same object.
- No model carrier prefix can populate evidence-named row fields.
- `_build_local_window_denominator_surface` is gone; it is not retained as a special-case supplier.

## Stage 5: Replace Model Row Readout And Reducer

Model rows and the selected-cohort stochastic reducer must use the same promoted core rather than bespoke composed-span readout helpers or standalone Pop D / Pop C projection.

F-mode, model-curve, and request-level model surfaces become projections of model span prefix outputs.

The semantic upgrade must be explicit: where draw-coherent primitives exist, the row readout uses the joint mass implied by the draw family. If this changes existing `model_midpoint` values, the outside-in tests should record the intended semantic upgrade rather than chasing product-of-marginals parity.

`_selected_cohort_group_rate_draws` must not remain as an independent model projection engine. Its Pop D / Pop C mechanics must be represented by the promoted plan/core contract. If a small reducer wrapper remains, it may only aggregate already-produced prefix surfaces and divide `ΣY / ΣX`; it must not contain carrier/subject semantics or identity/active branches.

Acceptance gate:

- Model row readout does not call a separate composed-span curve helper.
- Model readout and evidence readout differ by operators, not by evaluator.
- Draw-family coherence is preserved across carrier, subject, and request spans.
- `_selected_cohort_group_rate_draws` is deleted, or reduced to a semantics-free `ΣY / ΣX` aggregator over promoted prefix surfaces.
- No Pop D / Pop C carrier/subject convolution remains outside the promoted plan/core contract.

## Stage 6: Delete Old Branches And Dead Code

Delete old runtime authorities after the promoted span path is the only caller:

- `_SelectedSourceDayMass`
- `_CarrierOnlyDenominatorPrefix`
- `_RateAttributedSubjectPrefix`
- `_build_local_window_denominator_surface`
- `_primitives_are_zero_delay` if its only purpose is mode-specific denominator substitution
- mode-specific prefix branches in `build_cohort_evidence_from_frames`
- `_selected_cohort_group_rate_draws` as a semantic projection engine
- independent `generalised_span_model_shadow.py` algebra
- selected-prefix construction functions that exist only for the old objects
- evidence amplitude code that reads `x_prefix` / `y_prefix`
- row-projection branches whose only job is identity versus active evidence routing
- any old/new or shadow comparison branch used during development

This stage is not optional. A branch that remains reachable means debranching is incomplete.

Acceptance gate:

- Grep shows no reachable production use of the old selected-prefix classes.
- Grep shows no `candidate` import in production runtime.
- Grep shows no independent shadow evaluator.
- The only span evaluator in production is the promoted core.
- Grep shows no local-window denominator substitution branch.
- Grep shows no semantic Pop D / Pop C reducer outside the promoted core/plan contract.

## Stage 7: Oracle And Regression Proof

Run the outside-in oracle after deletion, not before.

Minimum required matrix:

- Identity carrier single-hop.
- Active carrier single-hop.
- Identity carrier multi-hop.
- Active carrier multi-hop.
- Non-latent upstream chain collapse.
- Latent upstream divergence.
- Covered-zero versus absent evidence.
- Model draw-family joint-mass preservation.
- Row evidence and reducer frontier same-prefix seam.

The protected outside-in suite remains the final acceptance surface. If it disagrees with an internal test, the internal test or implementation is wrong until proven otherwise.

Acceptance gate:

- The current fixed oracle remains green.
- Multi-hop latent upstream divergence remains green.
- Single-hop evidence remains unchanged except where the plan explicitly names a semantic upgrade.
- No new `xfail` is added.
- No oracle assertion, tolerance, fixture, or DSL is weakened.

## Stage 8: Documentation Close-Out

Update the codebase docs after the cutover lands:

- `CF_ROW_PIPELINE.md` must describe the promoted strict span readout as the row engine.
- `CF_PRIMITIVE_SUBSTRATE.md` must name how primitive-bound evidence becomes operators.
- `FORECAST_RUNTIME_ARCHITECTURE.md` must describe the stable span plan compiler and delete references to the old prefix family.
- `CF_DEFENSIVE_FINDINGS.md` must mark the relevant branch/fallback findings retired, or narrow them to remaining true debt.

Archive or rewrite the old candidate plan so future agents do not treat candidate files as the maintained implementation.

Acceptance gate:

- Docs describe what is true now, not the history of the attempt.
- The candidate plan no longer reads like the production strategy.
- Reviewers can navigate from `TASK_TYPE_READING_GUIDE.md` to the new stable span readout docs.

## Stop Conditions

Stop and report rather than continuing if:

- A production old/new branch becomes necessary to keep tests green.
- The outside-in oracle requires a tolerance or assertion change.
- The promoted core cannot represent a case without evaluator branching.
- Evidence support cannot distinguish covered-zero from absence.
- Model operator supply cannot preserve joint draw-family mass.
- Deleting the old prefix classes reveals an unplanned caller.

## Completion Criteria

The work is complete only when all of the following are true:

- The promoted core lives under `graph-editor/lib/runner/` and no longer has candidate naming.
- Production span construction routes through that core.
- The old selected-prefix family is deleted or demonstrably unreachable.
- Shadow diagnostics, if retained, call the promoted core and do not reimplement it.
- The outside-in oracle suite is green without new xfails.
- The codebase docs describe the new long-term architecture.

Anything short of that is not cutover. Anything with a live old/new path is not debranched.
