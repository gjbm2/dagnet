# 71 — Detailed Execution Plan for Doc 66

**Date**: 23-Apr-26
**Status**: Active implementation plan
**Audience**: engineers executing the doc 66 refactor
**Relates to**: `66-shared-cf-runtime-and-wp8-admission-plan.md`, `67-thread-tool-call-audit-before-start.md`, `68-thread-tool-call-audit-after-reversion.md`, `69-thread-tool-call-audit-diff.md`, `70-thread-tool-call-audit-analysis.md`, `../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`

## 1. Purpose and relationship to doc 66

Doc 66 sets the structural contract, the WP8 admission policy, and the
eight-stage shape of the refactor. What it does not do is tell the
engineer how to cross each stage without repeating the failure modes of
the previous attempt captured in docs 67-70.

This note is that operational companion. It assumes the binding contract
and the stage shape from doc 66, and it adds the execution discipline
that the previous attempt did not have: an explicit residue inventory,
sub-stages inside every doc 66 stage, shadow parity before substitution,
provenance that stays observable throughout, commit boundaries, and a
failure-mode register that ties each sub-stage to the specific mistake
it is there to prevent.

It does not reopen doc 66's semantics, does not introduce new work
packages, and does not change the WP8 admission criteria. It sequences
and disciplines the work that doc 66 already authorises.

## 2. What went wrong in the previous attempt

Docs 67, 68, and 69 reconstruct what the code looked like before the
attempt, after the partial reversion, and what moved between the two.
Doc 70 analyses the residual net changes after the rollback. The
failure pattern visible in those records is worth stating explicitly
because it shapes every rule in this plan.

The previous attempt did six things at once. It introduced a new
shared runtime-preparation layer. It rewired the two handlers onto that
layer. It hardcoded a donor-read parameter that had been explicit. It
collapsed direct-cohort provenance so that the wire format could no
longer distinguish admitted from non-admitted paths. It changed engine
behaviour inside `forecast_state.py` in three places that had nothing
structurally to do with runtime preparation. And it weakened several
test assertions so that the new behaviour would pass. When the row
builder was reverted, the preparation layer and the donor collapse and
the engine changes and the weakened tests all survived, leaving the
tree in a state that is neither the old semantics nor the new contract.

There is one deeper pattern underneath those six mistakes. The attempt
treated the structural refactor and the evidence-policy change and the
engine behaviour as one coherent act of tidying. Doc 66 is explicit
that they are three separate things, and that each belongs in a
different layer under different discipline. Once they were allowed to
travel together, the rollback could not take one without leaving the
others, and the test suite lost the provenance it needed to tell them
apart.

## 3. Load-bearing invariants

The semantics doc and doc 66 together define what this refactor must
preserve. They are listed here as one flat list so that every stage
below can be checked against them directly, without having to re-read
the source documents to remember the terms.

The denominator side is always `carrier_to_x`. The numerator side is
always `subject_span(X -> end)`. Single-hop and multi-hop are
degenerations of the same template, not separate systems. The displayed
rate is always `y / x`; cohort mode never promotes it to `y / a`. In
`window()` mode, Pop C is empty by definition. In `cohort()` mode with
`A = X`, the carrier collapses to the identity. Query-scoped posteriors
are never re-conditioned on the same evidence. The WP8 seam may only
change which evidence family moves the numerator-side rate update; it
must not change `carrier_to_x`, `subject_span`, latency semantics,
completeness semantics, numerator representation, or the
degrade-versus-sweep eligibility rule from doc 57. A single semantic
question must receive one admission outcome across every consumer,
never a consumer-local decision.

Any stage that appears to require a change to one of those invariants
is a signal that the stage has been mis-scoped. This plan does not
authorise semantic changes; it authorises the structural moves that
make those invariants easier to keep true.

## 4. Design principles this plan adds to doc 66

### 4.1 Separate layers never travel together in one change

A change that touches the structural runtime must not also touch the
evidence layer or the engine. A change to the evidence layer must not
also touch the engine or the structural runtime. A change to engine
behaviour must not be bundled with a refactor of any kind. The
previous attempt collapsed these three into one motion and lost the
ability to bisect. This plan keeps them in separate phases, and within
each phase keeps structural moves in separate commits from observable
behaviour changes.

### 4.2 Shadow before substitute

No path is removed in the same step that its replacement is
introduced. Every extraction runs first as a shadow: the new code path
is called alongside the old path, its outputs are compared to the old
path's outputs, and the comparison has to hold across a stable set of
fixture queries before the old path is retired. This was the single
largest missing discipline in the previous attempt. Extraction without
shadow means the extracted path's first production use is also its
first functional test, and every subtle asymmetry becomes a live
regression.

### 4.3 Provenance stays observable at all times

Every bundle and every evidence object must carry enough fields on the
wire that a test can distinguish "direct-cohort admitted", "direct-
cohort denied with reason X", and "default factorised evidence". The
previous attempt removed `direct_cohort_enabled` from the serialised
bundle and the test assertions along with it. That made the test suite
incapable of telling admitted from denied, which made every subsequent
claim about WP8 behaviour unverifiable. Provenance fields are not
diagnostic decoration; they are the minimum surface on which the
admission policy can be tested.

### 4.4 No silent parametrisation collapse

Any parameter that was explicit must stay explicit or be removed with
a written rationale that survives in the code or the docs. Silently
hardcoding `subject_is_window=True` in `_fetch_upstream_observations`
is the archetype of what this plan does not allow. If an argument is
truly dead, it gets removed with a one-line note explaining why every
caller is provably on the same path. If it is not dead, it stays
explicit and typed.

### 4.5 No test weakening without a written decision

A test assertion that changes from one expected value to another is a
change to the observable contract and must be decided on its own
merits, not as a side-effect of a refactor. Every test change in this
refactor must be traceable to an explicit decision recorded in the
residue inventory (section 5) or, for later stages, in this plan's
stage text. "The new code path produces X, so the test should now
expect X" is not a decision; it is a tautology.

### 4.6 Each stage is provable by a parity point

A stage is finished only when a concrete parity artefact demonstrates
it. "Tests pass" is insufficient; tests pass after weakening too. The
parity artefact is either bit-identical output between the old and new
paths across a fixture pack, or an explicit diff with a written
explanation for each difference. Stages without a parity point are not
complete.

### 4.7 Commit boundaries are load-bearing

The previous attempt's diffs are hard to bisect because a single
conceptual change spans multiple files and multiple kinds of change.
This plan defines commit boundaries explicitly for each sub-stage, and
refuses to bundle structural extraction, evidence-policy adjustment,
engine change, and test change inside one commit. If bisect has to be
used later, the commits it lands on must each mean one thing.

## 5. Residue inventory (decisions to close before Stage 1)

The current tree is not the doc 68 "after reversion" state. Four
subsequent commits advanced the shared-runtime infrastructure, added
the `prepare_forecast_runtime_inputs` entry point, and wired the v3
handler to use it. The chart handler delegates to the shared preparer;
the surprise-gauge and the whole-graph CF handlers do not yet. Several
residues from the partial reversion are still present. Each residue
below is an open decision that must be closed before the structural
stages begin, because each one leaves the codebase with two possible
interpretations of its own contract, and any subsequent refactor will
silently pick one of those interpretations without saying which.

### 5.1 The `should_enable_direct_cohort_p_conditioning` hook

This function exists and returns `False` unconditionally. It looks
wired for a future admission policy and is not. The decision is binary:
either delete every call site and the function itself, or restore it
to a real admission evaluator behind an explicit off-by-default kill
switch. A function that looks alive but is dead is worse than either
option. The preferred resolution for this plan is deletion, because
Stage 6 will introduce a proper admission evaluator with explicit
deny reasons and having a no-op precursor invites confusion about
which is the live seam.

### 5.2 The `p_conditioning_direct_cohort` parameter on the bundle builder

The builder still accepts this parameter and then discards it with
`del`. This is dead argument surface. It must be removed from the
signature and every call site, or restored as a real field on the
`PreparedConditioningEvidence` object. Stage 6 needs a real admission
flag on the evidence object; the cleanest path is to remove the dead
parameter now so that Stage 6 reintroduces it with a single clear
contract rather than reviving a stub.

### 5.3 The `direct_cohort_enabled` field on the evidence object

The field and its serialisation are gone. Tests that asserted on it
are gone. Stage 6 will need to reintroduce this or an equivalent
field, because admission must be observable. The decision to close
now is whether the field returns as `direct_cohort_enabled`, as a
richer `admission_outcome` enumeration, or as something else. The
recommended shape is an enumeration with values covering "default",
"direct_cohort_admitted", and one value per deny reason, because doc
66 Section 5.2 calls out the deny reasons as the load-bearing guard
against silent admission widening. A single boolean cannot carry that.

### 5.4 The surprise-gauge provenance string

`_compute_surprise_gauge` hardcodes `p_conditioning_source =
'aggregate_evidence'`. The previous value was chosen dynamically
between `'direct_cohort_exact_subject'` and `'aggregate_evidence'`
based on the dead admission helper. For now the only live path is the
aggregate path, so the hardcoded value is functionally correct, but
the hardcoding hides the fact that no admission is being consulted.
The decision is whether to leave it hardcoded with a comment pointing
to Stage 6, or to make it go through the same evidence selector that
Stage 6 will build. The recommended close is: leave hardcoded for
now, tag the line with a reference to Stage 6, and require Stage 6 to
remove the tag as part of its completion criteria.

### 5.5 The `_fetch_upstream_observations` donor-read semantics

The `subject_is_window` parameter was removed; donor subjects are now
prepared as if `subject_is_window=True`. For cohort-mode donor reads
this can bind upstream evidence on the window family when the caller
was cohort-rooted. This is the highest-risk residue in the inventory
because it silently changes evidence semantics rather than refactoring
them. The decision is whether the cohort-mode donor path was in use
at all, and if so whether the old `subject_is_window=False` behaviour
was correct. Resolution requires a fixture pack that exercises a
cohort-rooted donor read and compares output before and after the
flip. The parameter must be restored as explicit, and its value must
be driven from the caller's actual mode. If the audit shows the old
behaviour was itself wrong, the parameter still goes back but its
default changes with a written decision, not by omission.

### 5.6 The `_resolve_subject_temporal_mode` anchor comparison

This helper switches the resolved rate family to `'cohort'` when
`anchor_node_id != query_from_node` and to `'window'` otherwise. In
the semantics doc the mode is a property of the query, not a function
of whether the anchor and the query-from happen to match. If the two
mean the same thing in every reachable call, the helper is merely a
refactored restatement of existing logic and is fine. If there is a
query shape where the caller says `cohort()` but `A = X`, the helper
would downgrade that query to `window`, which collapses Pop C even
though the query language already promised it is empty, so the effect
is semantically neutral but the route is surprising. The decision is
to confirm by direct case analysis that every live call produces the
same mode as the caller's own mode field, and if so to rename the
helper or add an invariant assertion. If any case diverges, this is a
semantic change and must be escalated before any later stage
proceeds.

### 5.7 The `forecast_state.py` engine changes

Three behaviours changed: the zero-denominator fallback now convolves
the upstream carrier with the subject span when carrier data is
available; rate conditioning is skipped when `alpha_beta_query_scoped`
is true; and completeness weighting falls back from `x_frozen` to
`a_pop` when `x_frozen <= 0`. Each of these is defensible individually
but none of them is a refactor. The decision is whether each change
is kept, with doc 57 used to justify the rate-conditioning skip,
doc 52 used to justify the completeness fallback, and a direct
written justification attached to the zero-denominator convolution.
Any change that cannot be justified in terms of the binding
invariants is reverted. None of these decisions are made as part of
later stages; they are closed here, because later stages will rely on
engine behaviour being stable.

### 5.8 Tests with weakened assertions or NOTE blocks

The `p_conditioning_direct_cohort` assertions in
`test_cf_query_scoped_degradation.py` and `test_v2_v3_parity.py` were
removed. The `p_conditioning_source` expectations were rewritten. A
NOTE block in `test_cf_query_scoped_degradation.py` rationalises the
rewrites. Every weakened assertion must be re-decided: either the
assertion is reinstated with the new provenance field from 5.3, or
the test is explicitly narrowed with a comment pointing at the doc
section that authorises the narrowing. NOTE blocks that rationalise
current code are deleted in favour of explicit decisions; NOTE blocks
that explain genuinely intentional narrowings remain.

### 5.9 Existence of a Daily Conversions parity canary

Doc 66 Stage 0 calls for this canary. It does not exist in the guard
pack today. The decision here is not whether to add it but when. The
recommended close is to add it now, fixture-only and passing against
current behaviour, so that later stages have a pre-existing oracle
rather than having to write one while under refactor pressure.

## 6. Execution stages

Stages below correspond one-to-one with doc 66 Stages 0 through 8,
but each one is broken into sub-stages small enough that each
sub-stage is one commit and has its own parity point. Entry, stop,
and exit rules from doc 66 are inherited; the text below adds what
doc 66 leaves implicit. Where doc 66 names files, this plan uses the
same names, and where doc 66 names symbols this plan uses the same
symbols.

### Stage 0. Close residues, freeze guards, and baseline the tree

This stage does no structural work. Its job is to resolve every
decision in section 5, produce a characterisation harness that
captures current observable behaviour, and record a frozen list of
what the downstream stages are allowed to change.

Sub-stage 0.1 is the decision log. Every item in section 5 is closed
with an explicit answer in a short commit to this document or to a
companion decision file in the same directory. No structural code
changes happen in this sub-stage; it is pure writing.

Sub-stage 0.2 is the residue cleanup itself. Each closed decision is
landed as its own commit. The hardcoded-donor residue in 5.5 gets
its own commit, separately from the evidence-field removal in 5.3,
which is separately from the dead-argument removal in 5.2, and so
on. The engine changes in 5.7 are landed only if the decision was
"keep", each in its own commit with its own test covering the new
behaviour; otherwise they are reverted, each in its own commit.

Sub-stage 0.3 is the characterisation harness. A single new test
file, or a small set of fixtures added to an existing test file,
records current outputs for a deliberately chosen set of queries:
one `window()` single-hop, one `window()` multi-hop, one
`cohort()` single-hop with `A = X`, one `cohort()` single-hop with
`A != X`, one `cohort()` multi-hop, one scoped CF, one whole-graph
CF edge read, one cohort-maturity chart, and one Daily Conversions
slice. The harness records the full serialised bundle, the projected
response, and the per-edge scalar outputs. This harness is the
reference against which every subsequent parity point is measured.

Sub-stage 0.4 is the Daily Conversions parity canary from 5.9 and
any other guard-pack gap-fills identified while writing 0.3.

The exit rule for Stage 0 is that section 5 is closed, the tree
compiles, every guard-pack test is green, and the characterisation
harness is committed. No symbol introduced by this stage may change
semantics of the live code; any sub-stage commit whose diff implies a
behaviour change is flagged as mis-scoped and returned to Stage 0.

### Stage 1. Remove structuralised single-hop and WP8 forks

Doc 66 Stage 1 says this stage replaces boolean single-hop gating
with an admission-policy result object. That is true but overbroad;
within this plan Stage 1 is narrower. Stage 1 removes structural
branching that uses "single-hop" or "exact cohort" as a
structural-layer predicate, while leaving the evidence layer as it is
after Stage 0.

Sub-stage 1.1 audits every branch in `forecast_runtime.py`,
`api_handlers.py`, and `cohort_forecast_v3.py` that conditions a
structural decision on "single-hop", "exact subject", or
"direct-cohort". The audit is a prose document committed to this
directory as a companion decision file. Each branch is classified as
structural or evidence. Structural branches must express only the
structural decision they exist for and must not mention admission.
Evidence branches are left alone in Stage 1.

Sub-stage 1.2 extracts each misclassified branch into its cleaner
form in its own commit. No commit in this sub-stage touches more than
one branch. Each commit is accompanied by a characterisation-harness
re-run; the harness outputs must be bit-identical across the
sub-stage.

The exit rule for Stage 1 is that single-hop survives only as the
natural degeneration of the factorised template, as doc 66 requires,
and the characterisation harness is unchanged from the Stage 0
baseline.

### Stage 2. Make one runtime builder authoritative

This is the stage where the previous attempt failed hardest. The
failure mode was extracting the new builder, rewiring both handlers
at once, and discovering behavioural asymmetries only in production
fixtures. This plan uses shadow running and per-handler cutover to
prevent that.

Sub-stage 2.1 consolidates all structural decisions currently made
by `_handle_cohort_maturity_v3`, the scoped path in
`handle_conditioned_forecast`, and `cohort_forecast_v3._prepare_
runtime_bundle` into one named authoritative builder. The builder is
introduced in `forecast_preparation.py` or `forecast_runtime.py` as
doc 66 Stage 2 directs. It does not replace any existing path; the
existing paths continue to run exactly as they did after Stage 1. The
new builder is callable but not yet on a critical path.

Sub-stage 2.2 is the shadow harness. A single decision point is
added in each of the three current preparation paths such that,
after they compute their bundle, the shared builder is also invoked
with the same inputs, its bundle is compared field by field to the
local one, and any divergence is logged with a unique tag naming the
handler and the semantic question. Shadow comparison runs for every
test in the guard pack and for every query in the characterisation
harness. Divergences are fixed in the shared builder, never in the
local paths. The shared builder's job at this point is to reproduce,
exactly, what the local paths produce.

Sub-stage 2.3 is the reconciliation loop. Any divergence is a
sub-bug. Each divergence is closed as its own commit with its own
fixture. No cutover happens while the shadow divergence log is
non-empty.

Sub-stage 2.4 cuts over the chart handler. `_handle_cohort_maturity_v3`
delegates to the shared builder and drops its local preparation. The
shadow stays on in the scoped CF and in the internal v3 preparer. The
chart characterisation fixtures are re-run and must be bit-identical.

Sub-stage 2.5 cuts over the scoped CF handler. Same discipline as
2.4: the shadow goes off for scoped CF, the characterisation fixtures
are re-run, bit-identity is required.

Sub-stage 2.6 cuts over the internal v3 preparer, so that
`cohort_forecast_v3` receives a prepared bundle rather than building
one. The shadow goes off entirely after this cutover.

The exit rule for Stage 2 is that the shared builder is the only
path constructing runtime bundles for chart, scoped CF, and v3, the
shadow harness is retired, and the characterisation harness is
unchanged from Stage 0.

### Stage 3. Make the row builder projection-only

Stage 3 in doc 66 reduces `cohort_forecast_v3` to projection. This
plan requires that the row builder's local preparation is not deleted
outright. Instead, it is first neutered by assertion: the prepared
bundle is injected, and an invariant is added that the prepared
values match the locally computed values. Only once the invariant
holds across the full fixture pack is the local computation deleted.

Sub-stage 3.1 injects the prepared bundle into the row builder and
adds the parity invariant over each structural field currently
computed locally: `carrier_to_x`, `subject_span` inputs, the span
kernel, the resolved priors, the `x_provider`, and the degrade
eligibility. The invariant is soft at first: on divergence it logs,
it does not raise. Divergences are driven to zero through the guard
pack.

Sub-stage 3.2 hardens the invariant from log to assert once the
divergence log is empty.

Sub-stage 3.3 deletes the local computation. Each deleted block is a
separate commit. After each deletion, the characterisation harness
must still match Stage 0.

The exit rule for Stage 3 is that the row builder owns no structural
decisions and no resolved priors, only projection.

### Stage 4. Unify `cohort_maturity` and scoped CF

Doc 66 Stage 4's work is mostly done by Stage 2 sub-stages 2.4 and
2.5 in this plan. What remains is the last piece of caller-local
divergence: the two handlers' input marshalling before they hand off
to the shared builder. This is where differences in how the same
subject is resolved still survive.

Sub-stage 4.1 audits the two handlers for any remaining pre-builder
divergence in subject resolution, frame preparation, regime
selection, or donor reads. The audit is committed as prose. Each
divergence is a row in the audit with a resolution.

Sub-stage 4.2 consolidates subject resolution and frame preparation
into one shared helper that both handlers call before the shared
builder. The characterisation harness asserts that scoped CF and
chart now differ only in projection.

The exit rule for Stage 4 is that scoped CF and chart share subject
resolution, frame preparation, runtime preparation, and differ only
in projection.

### Stage 5. Harden whole-graph CF without creating a second semantic system

Whole-graph CF is an orchestration variant. Its correctness depends
on topological ordering and donor cache reuse, not on a different
solve. The hazard at this stage is donor cache keys that use
incidental edge ordering instead of semantic identity. If two
equivalent semantic questions land on different cache keys, they can
receive different priors or different evidence families, and
whole-graph CF becomes a second semantic system by accident.

Sub-stage 5.1 routes whole-graph CF through the shared builder for
each edge, using the Stage 4 shared subject-resolution helper. The
shadow pattern from Stage 2 is re-enabled for this handler only.

Sub-stage 5.2 audits donor cache keys. Each cache key is classified
as semantic or incidental. Incidental components are removed or
replaced with semantic equivalents. Each cache-key change is its own
commit and comes with a characterisation-harness re-run.

Sub-stage 5.3 adds a parity canary that takes a whole-graph CF
single-edge read and the matching scoped CF single-edge read for the
same semantic question and asserts bit-identity of the serialised
bundle.

The exit rule for Stage 5 is that the whole-graph canary is green
across the fixture pack and donor cache keys are semantic.

### Stage 6. Reintroduce WP8 correctly as a shared evidence overlay

Stage 6 is where admission returns. By this point the structural
runtime is shared, the row builder is projection-only, and the tests
have explicit provenance fields to assert on. The risk is that the
admission policy reintroduces a structural branch under a different
name. The discipline below keeps admission strictly in the evidence
layer.

Sub-stage 6.1 introduces the admission evaluator as a pure function:
inputs are the resolved runtime bundle and the request, output is an
admission outcome carrying either "default factorised" or "direct-
cohort admitted" or one of the deny reasons enumerated in doc 66
Section 5.2. The evaluator is added to the shared runtime layer, is
called by every handler, and its outcome is attached to the
`p_conditioning_evidence` object on the bundle. At this sub-stage the
outcome is metadata only: it does not yet control execution.

Sub-stage 6.2 adds test assertions across the guard pack that pin the
admission outcome for every fixture query. This replaces the
assertions weakened in the previous attempt. The expected outcomes
are "default factorised" for every fixture except the one that was
designed to exercise exact single-hop cohort, which asserts
"direct-cohort admitted".

Sub-stage 6.3 wires the evidence selector. The evidence selector is a
second pure function that consumes the admission outcome and the
resolved bundle and returns the evidence family for the numerator-
side rate update. Until this sub-stage, everything runs on the
default factorised path; after this sub-stage, the single admitted
fixture swings over to the direct-cohort path. The
characterisation harness records the new output for the admitted
fixture, and doc 62's constraints on that path (aggregate prior
scope, unchanged carrier, unchanged subject span) are re-asserted
explicitly.

Sub-stage 6.4 gates the selector behind an off-by-default kill
switch so that the admitted path can be disabled in one place if
regressions appear.

The exit rule for Stage 6 is that WP8 is live for the single admitted
fixture and denied for every other fixture with an explicit deny
reason observable in tests, and no structural field on the bundle
changes when WP8 toggles between admitted and denied on the same
fixture.

### Stage 7. Move Daily Conversions onto the shared solve

Daily Conversions is the last remaining consumer-local solve. Its
current handler reaches into the inner forecast kernel directly. The
risk at this stage is that the projection layer for Daily
Conversions is not yet fully expressed by the shared runtime, so
moving the handler without extending the runtime creates projection
gaps.

Sub-stage 7.1 extends the shared runtime to expose the per-cohort
evaluation outputs that Daily Conversions needs. No handler moves in
this sub-stage; the runtime simply carries richer projection
coordinates.

Sub-stage 7.2 introduces a new Daily Conversions derivation that
reads from the shared runtime bundle. It runs in shadow alongside
the existing derivation. Divergences are closed against the
characterisation harness.

Sub-stage 7.3 cuts Daily Conversions over and deletes the direct
inner-kernel call.

The exit rule for Stage 7 is that Daily Conversions differs from
chart and scoped CF only in projection, and the Daily Conversions
parity canary from Stage 0 is green.

### Stage 8. Remove dead scaffolding and align the docs

Sub-stage 8.1 walks the surface introduced by the earlier stages and
deletes any field that was added to the runtime bundle but does not
control execution. Each deletion is its own commit and its own
characterisation run.

Sub-stage 8.2 aligns docs 60, 62, 66, and this document. Any
language that describes WP8 as a structural exception is rewritten to
describe it as a shared evidence overlay.

Sub-stage 8.3 retires the shadow harnesses and the divergence logs
from Stages 2 and 5, leaving only the parity canaries and the
characterisation harness in the guard pack.

The exit rule for Stage 8 is that one preparation path, one runtime
contract, one admission policy, one evidence selector, and one solve
remain, and the docs describe the code that exists.

## 7. Provenance discipline through the stages

The `p_conditioning_evidence` object is the observability seam for
admission. It must carry, from Stage 0 onwards, the fields that let
tests and operators tell admitted from denied. Stage 0 closes whether
that surface is a boolean, an enumeration, or a richer object; Stage
6 populates the field as admission evaluates. No stage between Stage
0 and Stage 6 may remove a provenance field. If an earlier stage
wants to stop populating a field, it marks the field with a default
that is distinguishable from admitted and denied, and leaves the
field on the wire.

Serialisation of the bundle must also stay stable through the
refactor. Any change to the serialised shape is a change to the
observable contract of every consumer, including the frontend. Stage
0 records the current shape; no later stage changes it without an
explicit decision and a paired frontend check.

## 8. Shadow and parity methodology

Shadow running is used in Stages 2, 5, and 7. The pattern in each
case is the same. The old path computes its outputs. The new path is
invoked in parallel with the same inputs. The outputs are compared at
a well-defined granularity: the serialised bundle, the per-edge
scalar outputs, and the projected response. Comparison is
field-by-field with numeric tolerance of zero for structural fields
and a documented small tolerance for anything driven by Monte Carlo
that is not reproducible under a fixed seed. Every divergence is
logged to a file under `bayes/shadow_logs/` with the handler name,
the fixture identifier, the field that diverged, and the old-versus-
new values. No cutover is permitted while that log is non-empty.
Every log entry resolves to a commit that either closes the
divergence or explicitly accepts it with a written decision attached
to the bundle's provenance field.

Parity canaries are different from shadow harnesses. Canaries are
permanent. They compare two consumers answering the same semantic
question and assert that their structural outputs agree. The
whole-graph versus scoped canary from Stage 5 and the Daily
Conversions canary from Stage 7 are the two main canaries introduced
here.

## 9. Commit boundaries

A commit in this plan covers one sub-stage. It may touch multiple
files, but it does one kind of thing: either a structural move, or an
evidence-layer change, or an engine change, or a test change. It does
not bundle kinds. If a sub-stage seems to require two kinds of
change, it is split further.

Commit messages reference the stage and sub-stage number from this
document, the doc 66 stage they implement, and the invariant from
section 3 they preserve. If a commit cannot cite an invariant it
preserves, that is a signal the commit is changing behaviour rather
than structure, and the change is re-scoped into its correct stage.

Revert is the preferred recovery. If any sub-stage ships and the
characterisation harness reports a divergence the stage did not
expect, the sub-stage's commits are reverted and the stage is
redesigned. Partial rollback of the kind that produced docs 67-70 is
not allowed.

## 10. Failure-mode register

This register lists each failure mode observed in the previous
attempt and names the sub-stage that prevents it.

The silent collapse of `subject_is_window` into a hardcoded `True`
is prevented by sub-stage 5.5 in the residue inventory and by the
explicit-parameter rule in design principle 4.4.

The collapse of direct-cohort provenance such that admitted and
denied look identical on the wire is prevented by sub-stages 5.2,
5.3, 6.1, and 6.2, and by the provenance discipline in section 7.

The bundling of the runtime-preparation extraction with a donor
rewiring, an engine change, and test weakenings is prevented by the
commit-boundary rule in section 9 and the sub-stage decomposition in
Stages 2, 3, and 5.

The cutover of both handlers simultaneously, with divergences
discovered only in production, is prevented by the shadow pattern in
Stage 2 sub-stages 2.1 through 2.6 and the per-handler cutover in
2.4, 2.5, and 2.6.

The survival of misleading no-op wiring after a partial rollback is
prevented by the residue inventory in section 5, which forces an
explicit close of every such stub before any structural stage begins.

The test weakening that hides regressions is prevented by design
principle 4.5, by the characterisation harness in sub-stage 0.3, and
by the explicit admission assertions in sub-stage 6.2.

The introduction of a second semantic system by accident through
whole-graph CF's donor cache keying is prevented by sub-stage 5.2
and the whole-graph parity canary in 5.3.

## 11. Permanent stop conditions

The stop conditions from doc 66 Section 8 are inherited in full. This
plan adds one further stop condition: if at any point the
characterisation harness recorded in sub-stage 0.3 diverges without
the current sub-stage having explicitly authorised the divergence,
the sub-stage is reverted immediately and its plan is re-examined.
The harness is the silent witness against which every stage is
checked; losing its baseline is losing the plan.

## 12. Final acceptance criteria

This plan is delivered only when doc 66's Section 9 acceptance
criteria are met, and in addition the residue inventory from section
5 is fully closed, the characterisation harness runs green, the
Daily Conversions parity canary runs green, the whole-graph versus
scoped parity canary runs green, and every weakened or removed
provenance assertion from the previous attempt has been explicitly
re-decided and either reinstated or deleted with a written decision
visible in the tree or the docs.
