# Multi-hop Window Evidence — Rate-Attributed Propagation Design

**Status**: Proposal for review  
**Date**: 11-May-26  
**Scope**: `cohort_forecast_v3` selected-evidence value semantics for subject chains across `window()` and `cohort()` bindings  
**Author**: investigation transcript, 11-May-26; conceptual revision, 11-May-26

**Cross-references**:
- [`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) — semantic source of truth; Implementation Invariants §1, §6, §8, §9, §12; Appendix A on per-primitive binding
- [`docs/current/codebase/FORECAST_RUNTIME_ARCHITECTURE.md`](codebase/FORECAST_RUNTIME_ARCHITECTURE.md) — `ResolvedCFRuntime`, selected-Cohort reduction, selected A-clock evidence, row projection
- [`docs/current/codebase/FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md`](codebase/FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md) — selected source-node mass and rate-attributed prefix pseudo-code
- [`docs/current/cohort-maturity-evidence-coverage-design.md`](cohort-maturity-evidence-coverage-design.md) — selected-evidence three-state contract, natural-degeneracy acceptance contract, coverage/value separation
- [`docs/current/codebase/KNOWN_ANTI_PATTERNS.md`](codebase/KNOWN_ANTI_PATTERNS.md) — AP58 (forking by case instead of degenerating one path); AP17 (non-vacuous tests)

---

## 1. Executive summary

Multi-hop `window()` evidence cannot be a literal observed end-to-end count.
A `window(X->Z)` query selects people who were at `X` in the requested date
window. The downstream primitive evidence for `M->Z` is observed on people who
were at `M` in their own local window. Those are not necessarily the same
Cohorts.

The chart still needs a visually meaningful evidence line. The principled
object is **rate-attributed evidence propagation**:

> propagate selected source mass through each primitive by pushing that mass
> through the primitive's observed incremental local-rate kernel.

For each primitive edge `U->V`:

```
selected mass at U on source day u
  × observed local incremental rate U->V at lag l
  = selected mass attributed to V
```

Counts never cross hop boundaries directly. Raw observed counts become local
rates on the edge where they were observed. Those rates are then applied to the
selected mass that reaches the edge's source.

This gives one semantic algorithm for all cases:

- **Single-hop** degenerates because there is only one multiplication:
  `n × (k/n) = k`.
- **Cohort-aligned evidence** degenerates because the selected source mass is
  the same denominator used by the observed row: `n × (k/n) = k`.
- **Multi-hop `window()`** produces synthetic, but explicit, selected-Cohort
  evidence: selected X-window mass propagated through observed local edge
  rates.

The value path should live in the runtime's selected source-mass and
rate-attributed prefix machinery, not in `_build_observed_span_evidence_surface`
as a replacement for `observed_count`. The observed-span surface remains the
coverage/support and diagnostic surface.

## 2. Problem statement

The current symptom is visible on production-shaped multi-hop window queries:

- hop 1 has non-zero local observed evidence;
- hop 2 has non-zero local observed evidence;
- the multi-hop `window()` evidence line emits `evidence_y = 0` across the
  observed epoch.

That all-zero line is not a principled statement that no selected users reached
the subject end. It is an artefact of trying to join raw counts across
primitive-local clock axes.

The older count-level interpretation asks every primitive in the chain to have
an observed count for the same `(anchor_day, tau)` cell. Under Appendix A
window binding, each primitive is local-clock-bound:

- `X->M` rows are keyed by X-arrival dates;
- `M->Z` rows are keyed by M-arrival dates;
- those dates label different Cohorts, even when the calendar date string is
  the same.

Joining the raw `k` counts is therefore invalid. Sometimes it collapses to
zero; in other fixtures it could produce a plausible but semantically
meaningless non-zero number. The fix is not to loosen the count join. The fix
is to stop composing counts.

## 3. Semantic design

### 3.1 The universal object

The selected-evidence value object is a propagated selected mass ledger.

For each selected Cohort `C`, each subject-chain source node `U`, and each
source day `u`, define:

`M_select(U, C, u)` = selected mass from Cohort `C` available at node `U` on
source day `u`.

Naming note for implementation: this document uses `M_select` for the
conceptual selected evidence ledger. The implementation must introduce a
separate evidence-local ledger (`_SelectedEvidenceSourceDayMass` or
equivalent). The current `_SelectedSourceDayMass` object is built from
source-layer timing composition and is consumed by model-timing paths. Do not
mutate or repurpose it for evidence propagation; doing so would collide with
model consumers that need the existing timing-based contract.

For each primitive edge `U->V`, define:

`R_UV(age)` = observed local cumulative conversion rate from `U` to `V` by
edge age `age`, based on primitive-bound evidence rows rooted at `U`.

For `window()`-bound primitives, the rate kernel is intentionally **age-only**.
Appendix A says window evidence is local-clock and "cohorts mixed by design";
that means the primitive's local rows estimate an edge behaviour curve, not a
source-day-specific Cohort identity. Per-source-day indexing is rejected for
the propagated multi-hop value path because synthetic downstream source days
can fall outside the primitive-local window rows that produced the observed
kernel. The correct stationarity assumption is: use the local-window observed
age curve as the edge's empirical transition kernel.

Where later algebra writes a source-day-indexed primitive kernel, read the
`window()` case as the age-only degeneration:

```
K_i(source_day, lag) = K_i(lag)
```

`cohort()` or any future source-day-specific evidence family may keep the
`source_day` index when the evidence binding actually supports it.

Then:

`R_UV(age)` is the cumulative input surface. Propagation uses the incremental
kernel `K_UV(lag)` implied by that surface, so selected mass is pushed to the
destination day where the increment lands. The terminal evidence numerator is
then cumulative-summed at projection time.

The terminal evidence numerator is the cumulative mass attributed to the
subject end by chart age `tau`. The denominator remains the selected mass at
`X`.

### 3.2 Why rates, not counts

Raw counts are attached to the population that produced them. In multi-hop
`window()`, those populations differ by primitive. A hop-2 `k` count is not a
count of selected X-window users; it is a count of users in the M-local window.

The rate `k/n` is different. It describes the local observed behaviour of the
edge under that binding. Applying that local behaviour to selected mass is a
synthetic projection, but it is a well-defined one.

This is the key semantic line:

- invalid: `k_XM` joined with `k_MZ`;
- valid: `M_selected_at_M × (k_MZ / n_MZ)`.

### 3.3 What the evidence line means

For multi-hop `window(X->Z)`, the evidence line means:

> the selected X-window population, propagated through the locally observed
> transition rates of the subject chain.

It is not a direct observed X-window-to-Z count. The row/provenance should make
that explicit, for example:

`evidence_projection = rate_attributed_local_evidence_propagation.v1`

This is still an evidence surface because its transition kernels come from
observed rows, not from posterior priors or model-only curves. It is synthetic
because the downstream selected source mass is inferred through propagation.

### 3.4 Shared-prefix seam invariant

The epoch A/B dovetail is semantic, not a rendering detail:

> the evidence line and the E+F reducer must read the same selected observed
> prefix.

`SelectedAClockEvidence` is the shared object. Row `evidence_x` /
`evidence_y` are aggregated from it via `aggregate_by_tau`, and the E+F
reducer derives `obs_x`, `obs_y`, `x_frozen`, and `y_frozen` through
`prefixes_for_cohorts`. The rate-attributed propagation fix must repair this
shared prefix. A display-only patch that changes row `evidence_y` without
changing the prefix consumed by the reducer would create an epoch A/B seam.

The current broken multi-hop window can still visually dovetail because both
surfaces read the same wrong prefix. The target invariant is stronger:

```
evidence_y(tau_boundary) / evidence_x(tau_boundary)
  == reducer observed-prefix midpoint at tau_boundary
  == rate-attributed oracle at tau_boundary
```

within floating-point and aggregation tolerance.

### 3.5 Coverage remains separate

Value and support answer different questions:

- Value asks: "what selected mass is attributed to the subject end?"
- Coverage asks: "which real observation rows support the local rates used at
  this chart age?"

Forward-filled rates may keep values flat. They must not imply fresh
observation support. Coverage should continue to come from actual retrieval
support and placement shares, not from value movement.

### 3.6 Display mass is not evidence strength

The displayed synthetic row should stay on the selected-Cohort population
scale. For a two-hop `window(A->B->C)` example:

- selected `N_A = 200`;
- observed local `A->B` rate at tau 5 is `0.25`;
- observed local `B->C` rate at tau 5 is `0.30`;
- local `N_B` for the second hop is `100`.

The displayed row is:

```
evidence_x = 200
evidence_y = 200 × 0.25 × 0.30 = 15
rate = 0.075
```

The local `N_B = 100` is not the output denominator. It is the denominator
that estimated the `B->C` local rate. This keeps the chart interpretable:
"starting with 200 selected users at A, the observed local rates imply 15 reach
C by tau 5".

But `evidence_x = 200` must not be interpreted as the Binomial evidence
strength of the terminal synthetic observation. The terminal rate depends on
multiple local estimates, and the second hop may have much less statistical
support than the selected A population size suggests.

Therefore the design separates:

- **display mass**: `evidence_x`, `evidence_y`, and `rate`, scaled to the
  selected Cohort;
- **statistical support**: hop-level evidence sizes and optional derived ESS,
  used for diagnostics, future uncertainty weighting, or future visual
  treatment, but not as the visible denominator.

## 4. Semantic recipe

The following is conceptual pseudo-code in prose. The implementation should
preserve these objects, not necessarily this exact loop shape.

### 4.1 Initialise selected mass at X

For identity-carrier cases (`window()` and `cohort(A=X)`), selected mass starts
at `X` on the selected anchor day:

`M_select(X, C, C.anchor_day) = selected_X_count(C)`

For active `cohort(A!=X)`, selected mass at `X` is produced by the carrier:

`M_select(X, C, u) = selected_A_count(C) × carrier_arrival_mass(C, u)`

This is the same carrier/identity degeneracy already required by the canonical
runtime invariants.

### 4.2 Propagate through each subject primitive

For each edge `U->V` in subject-chain order:

1. Build the edge-local cumulative observed rate surface from primitive-bound
   rows: `R_UV(age) = Σk_weighted / Σn_weighted` by edge age.
2. Derive the incremental local-rate kernel `K_UV(lag)` from `R_UV(age)`.
   Latest-at-or-before semantics may be used to fill the cumulative input
   surface before differencing, but the propagation step consumes increments,
   not cumulative values.
3. For each selected Cohort `C` and source day `u`, read
   `M_select(U, C, u)`.
4. Push source mass through `K_UV` so each increment lands on its destination
   source day.
5. Accumulate that destination mass as the selected source mass for downstream
   primitives.

The terminal destination ledger becomes `evidence_y`. The carrier/identity
ledger at `X` remains `evidence_x`.

### 4.3 Single-hop degeneracy

For a single edge `X->Y`:

`M_select(X, C, u) = n`

`sum_l K_XY(u, l) = k / n`

Therefore:

`sum_l M_select(X, C, u) × K_XY(u, l) = n × (k/n) = k`

No special branch is required. If single-hop values drift, the implementation
has violated the design.

### 4.4 Cohort degeneracy

For the X-rooted primitive itself, Cohort-aligned evidence has the selected
source mass and row denominator as the same object. Pushing that mass through
the primitive's incremental kernel reconstructs the observed numerator:

`selected source mass × sum_l K(l) = n × (k/n) = k`

This degeneracy is deliberately narrow: it holds at the primitive whose source
is the selected denominator `X` when the selected source mass and row
denominator are the same object. Downstream multi-hop subject primitives go
through the same evaluator — selected mass reaching the downstream source is
the input, and the edge contributes an observed incremental kernel.

`cohort(A=X)` and `window()` share the identity carrier by construction. Their
selected-evidence rows are equal only when the primitive kernels supplied to
the evaluator are equivalent. Per the canonical Appendix A, `window()`
primitives are local-clock (`alpha = beta`), while cohort subject primitives
may be `X`-rooted (`alpha = X`); the evaluator is shared, but kernel supply is
part of the mode.

### 4.5 Multi-hop window behaviour

For `window(X->M->Z)`:

1. selected X-window mass is real;
2. pushing it through `K_XM` produces synthetic selected M-day mass;
3. pushing that M-day mass through `K_MZ` produces synthetic selected Z-day
   mass.

The output is not a literal tracked-user count. It is the selected X-window
population propagated through observed local rates. That is the intended
visual evidence object for mixed-Cohort `window()` paths.

### 4.6 Evidence-mass ledger algebra

This subsection is the compact implementation-plan core. Everything else in
this design should be checked against these transformations before code is
changed.

Clean formulation:

> mode selects operators; the evaluator only composes operators.

Everything is a selected-mass measure pushed through kernels. `cohort()` and
`window()` differ by which carrier and primitive kernels they supply, not by a
different evaluator.

Definitions:

```
R  = population root
X  = denominator node
U0 = X, U1, ..., UH = subject_end
C  = selected Cohort rooted at day r_C
```

Define a selected evidence-mass measure at every subject node:

```
L_i^C(d) = selected mass from Cohort C available at node Ui
           on Ui-local day d
```

Seed the subject-start measure with the carrier kernel:

```
L_0^C(d) = N_C * B_{R->X}^C(d)
```

where `B_{R->X}^C` is a day-distribution over selected mass arriving at `X`.
The carrier degeneracies are natural:

```
active cohort(A != X):  B_{A->X} = composed selected carrier kernel
window():               B_{X->X} = delta(anchor day)
cohort(A = X):          B_{X->X} = delta(anchor day)
```

For each subject primitive `Ui -> Ui+1`, define an observed incremental
local-rate kernel:

```
K_i(d, l) = observed fraction of mass at Ui on source day d
            attributed to Ui+1 after lag l
```

`K_i` is incremental and sub-probability-valued: summing it over lags gives the
observed attributed fraction for the primitive, usually `<= 1`. For
`window()`, the primitive remains locally clocked. If the design uses the
age-only stationarity assumption from §3.1, that is simply:

```
K_i(d, l) = K_i(l)
```

so `window()` does not bind downstream primitive evidence onto a shared
`A`-clock. It still composes subject primitives through the same push-forward
rule. This stationarity/mixed-Cohort assumption is an explicit admitted
operator choice for multi-hop `window()`: local primitive evidence behaviour is
applied to selected mass that may have reached the primitive source from a
different source-day population. Coverage/support records how directly the
operator is backed by real row landings; it does not forbid the value path from
using the admitted stationary kernel.

Operator-supply contract for active cohort:

- The evaluator consumes `K_i(d, l)` only after primitive evidence binding has
  admitted or reshaped raw rows into a primitive source-day × lag surface.
- For `cohort(A != X)`, raw subject evidence may arrive with a cohort/root
  clock. The mode-specific binding layer must translate that evidence into
  weighted primitive-local rows with source day `d`, lag `l`, and selected-root
  attribution before the evaluator runs.
- If the available evidence cannot supply such a kernel without inventing
  source-day attribution, then `K_i` is absent for that primitive and the
  selected evidence composition degrades visibly.

This preserves the rule above: mode selects operators; the evaluator only
composes operators. The reshape/admission of raw cohort-clock evidence is part
of operator supply, not a second evaluator.

Discretisation and quadrature corrections also live in operator supply. The
evaluator consumes `B` and `K_i`; it does not decide half-step shifts,
midpoint reads, interpolation, endpoint differencing, curvature correction, or
quantisation. Those policies belong in the construction of `B_{R->X}` and
`K_i` from cumulative observed surfaces. Retaining the current half-step or
curvature corrections is therefore a kernel-construction choice, not a row
projection rule and not a mode branch.

Valid transition kernels are non-negative, bounded sub-probability measures.
When `K_i` is built by differencing a cumulative surface, that surface needs to
be genuinely CDF-like: monotone, bounded, and defined over a stable
support/base population. Differencing pooled `Σk / Σn` values whose
denominator/support changes by age can produce negative increments; such a
surface is not an admissible kernel without an explicit repair or degradation
decision in operator supply.

Do not turn every algebraic invariant into a defensive branch inside the
evaluator. With valid `B` and `K_i` operators, the following are consequences
of the algebra: propagated mass is non-negative, cumulative projected prefixes
are monotone, identity carrier is a Dirac seed, and single-hop exactness follows
from aligned source mass and row denominator. The evaluator should stay a small
push-forward over already-admitted operators.

Runtime guards belong at operator boundaries, not throughout row projection:

- reject or visibly degrade a missing carrier/kernel that the selected value
  path requires;
- reject or repair invalid kernels with negative transition mass, non-finite
  values, or total mass outside admissible bounds;
- keep support/coverage provenance separate from value mass;
- fail loudly if a caller tries to use displayed synthetic mass as direct
  Binomial evidence strength.

Uniform propagation:

```
L_{i+1}^C(v) = sum_d L_i^C(d) * K_i(d, v - d)
```

That is the whole value algebra. Longer paths are repeated push-forwards of the
selected measure through primitive-local kernels.

Public projection is also uniform:

```
X_C(tau) = sum_{d <= r_C + tau} L_0^C(d)
Y_C(tau) = sum_{d <= r_C + tau} L_H^C(d)

evidence_x(tau) = sum_C X_C(tau)
evidence_y(tau) = sum_C Y_C(tau)
rate(tau) = evidence_y(tau) / evidence_x(tau), if evidence_x(tau) > 0
```

The key degeneracy is the seed, not the primitive clock. `window()` and
`cohort(A = X)` seed `L_0` directly at X; active `cohort(A != X)` seeds `L_0`
from carrier evidence distributed over X-days. After seeding, all modes use the
same subject-span evaluator, and every primitive keeps its own local evidence
clock.

Coverage/support remains separate. It is a parallel support projection over the
same admitted carrier and primitive operator cells:

```
S_B(C, d)       = real observation/support for the carrier seed cell
S_i(d, l)       = real observation/support for primitive kernel cell K_i(d, l)
coverage(tau)   = projection of which admitted B/K cells supported the value
                  mass contributing to the row
```

Support is keyed to the operators used by the value path, but it is not itself
value mass and is not convolved as if it were conversion probability. A
forward-filled `K_i` value can carry value; only real row landings can carry
fresh support. Coverage is therefore derived from support/provenance on `B`
and `K_i`, not inferred from propagated mass in `L_i`.

Given valid non-negative operators, cumulative projected values are monotone:
`X_C(tau)` and `Y_C(tau)` are prefixes of selected mass and do not decrease
with `tau`. Daily incremental synthetic arrivals may rise or fall; negative
increments indicate an invalid supplied operator rather than a row-projection
case to patch.

Degeneracies and edge cases:

- `H = 1`: the subject span has one primitive, so the ledger reconstructs
  direct observed `k` via `n * (k / n)` when the selected source mass and row
  denominator are the same object.
- Identity carrier: `window()` and `cohort(A = X)` seed `L_0` directly at X;
  the denominator is fixed after `tau >= 0`, but downstream primitives are
  still locally clocked.
- Active cohort: `B_{A->X}` spreads selected mass across X-days before the
  subject evaluator begins.
- No admissible downstream rate: the affected downstream ledger cells are
  absent/degraded, not silently zeroed as observed no-conversion evidence.
- `n_i = 0`: the local rate is undefined; that row cannot contribute a rate
  kernel or support-derived propagated value.
- Instantaneous or non-latency `delta(0)` edges: the incremental kernel is a
  point mass at lag 0, so propagation transfers mass to the next node on the
  same source day.
- Eventual scalar reach: summing over all lags collapses the convolution to a
  product of total rates only where that scalarisation is explicitly
  appropriate.

## 5. Runtime placement

The value authority should remain the selected-prefix path:

- the new evidence-local ledger helper builds `L_i^C(d)` / `M_select(U, C, u)`.
- `_build_rate_attributed_subject_prefix` or its replacement pushes selected
  source mass through observed incremental kernels.
- `_build_selected_a_clock_evidence_from_runtime` pairs `selected_x_prefix`
  with `selected_y_prefix`.
- `_project_runtime_rows` reads `SelectedAClockEvidence.aggregate_by_tau` for
  `evidence_x`, `evidence_y`, and `rate`.

The main implementation risk lives before the evaluator:

- constructing valid non-negative incremental `K_i`;
- preserving source-day and selected-root attribution through operator supply;
- admitting stationarity or scalarisation only where the design says it is
  allowed;
- ensuring `L_i` is evidence-local selected mass, not reused model-timing mass;
- keeping support/coverage separate from value mass.

The evaluator itself should remain the §4.6 push-forward over admitted
operators.

Do not make `_build_observed_span_evidence_surface.observed_count` the new
value authority. Its current role is coverage/support and diagnostics. It may
continue to expose legacy max-flow counts for diagnostics, but row values
should come from the selected source-mass and rate-attributed prefix ledger.



### 5.1 Current code conflict to resolve

The current implementation is close to the desired shape, but it contains a
load-bearing mismatch. `_build_rate_attributed_subject_prefix` currently reads
source mass for each primitive source node from `runtime.selected_source_day_mass`.
It explicitly does **not** mutate downstream source mass from prior observed
edge rates. That is correct for the older model-timing source-mass contract,
but it is not the rate-attributed evidence propagation contract.

For this proposal, downstream evidence source mass must be produced by the same
edge-local kernel push-forward that produces the displayed evidence value:

```
L_{i+1}^C(v) += L_i^C(u) × K_i(u, v - u)
```

If the evidence-local ledger has no mass at a downstream source node because
the previous primitive did not propagate any selected mass, the implementation
must not emit terminal zero as if that were observed no-conversion evidence. It
must either be a genuine result of the supplied kernels or degrade visibly if a
required kernel/support surface is missing.

### 5.2 Staged implementation protocol

Two implementation attempts failed because they treated the outside-in failures
as permission to widen the runtime surface. The next attempt should proceed as a
sequence of small proof stages. Each stage has a concrete artefact; if the
artefact cannot be produced, the stage ends with a written finding rather than
a compensating code path.

#### Stage 0 — bucket contract audit

Before changing runtime behaviour, inspect the existing
`_SubjectChainEvidenceBuckets` output for the three relevant cases:

- single-hop identity carrier;
- multi-hop `window()`;
- active `cohort(A!=X)` with a multi-hop subject.

The artefact is a short table naming, for each primitive edge, what local-rate
surface is already present in the buckets:

- source-day-specific `(anchor_day, source_day, tau) -> (n, k)`;
- any existing age-only aggregate if present;
- missing surface, if the design requires a surface that the buckets do not
  currently expose.

This is the main lesson from the failed attempts: if the bucket contract is
missing the downstream age-only rate kernel, that is an interface finding. The
implementation should pause there and update this design or the bucket producer
deliberately, rather than reading from another source ad hoc.

#### Stage 1 — inside proof of the evidence-local ledger

Add the smallest possible evidence-local ledger inside the selected-prefix
construction. It should be seeded from the selected mass at the denominator
node `X`, then populated at downstream subject source nodes only by applying
primitive-local observed-rate increments from the bucket contract audited in
Stage 0.

The artefact is a focused in-process test or diagnostic probe that prints the
ledger for `synth-window-rate-prop` at the discriminating taus:

- selected mass at `wrp-a`;
- propagated selected mass at `wrp-b`;
- terminal selected mass at `wrp-c`;
- the local rates used for `wrp-a -> wrp-b` and `wrp-b -> wrp-c`.

This stage does not need the public chart row to pass. It proves the semantic
object exists before it is wired to public projection.

#### Stage 2 — prefix wiring

Wire the terminal evidence-local prefix into
`SelectedAClockEvidenceCell.y_at_subject_end`, keeping the existing
`selected_x_prefix` denominator and existing coverage/support surfaces.

The artefact is a seam probe at `tau_solid_max`: the evidence row and the E+F
reducer must read the same selected prefix for the same Cohort. If the reducer
uses a different observed-prefix source in this regime, record that as a
separate reducer contract issue instead of changing reducer projection
semantics inside this stage.

#### Stage 3 — public outside-in proof

Run the three named outside-in tests in §7.3. Interpret failures by stage:

- Stage 1 failure means the ledger is wrong or the bucket contract is
  insufficient.
- Stage 2 failure means the selected prefix is not wired consistently.
- Stage 3-only failure means the public row/provenance path is not reading the
  selected prefix as expected.

The artefact is the test output plus a short explanation of which stage owns any
remaining failure. Passing tests are not, by themselves, permission to change
fetch envelopes, candidate selection, or model projection behaviour.

#### Stage 4 — active-cohort drift check

Only after Stages 1-3 are coherent, run the drift snapshot from §7.2 and compare
the active `cohort(A!=X)` multi-hop-subject rows against the saved baseline. The
artefact is a small delta summary for `evidence_x`, `evidence_y`, `rate`, and
`midpoint` at the shared taus.

The check is not a blanket acceptance of active-cohort drift. Dense, aligned,
factorised active-cohort cases whose current path already supplies operators
equivalent to `B` and `K_i` are parity cases: movement there is an
operator-supply or wiring bug. Movement is in scope only where the current path
was using a non-equivalent operator, missing support, model-timing mass in place
of evidence-local mass, or another explicitly identified invalid surface. The
purpose of the snapshot is to classify any active-cohort movement before code
is kept, not to excuse it.

### 5.3 Minimal source alterations

If Stage 0 confirms the bucket contract already exposes the required local-rate
surface, the expected code change is small:

1. Add a separate evidence-local source-mass ledger helper
   (`_SelectedEvidenceSourceDayMass` or equivalent). Downstream subject source
   nodes receive mass from observed-rate propagation. `_SelectedSourceDayMass`
   remains model-timing state and must not be mutated for this purpose.
2. Split or replace `_build_rate_attributed_subject_prefix` so it reads the
   audited bucket rate surface, updates the evidence-local ledger, and returns
   the terminal prefix used for `SelectedAClockEvidenceCell.y_at_subject_end`.
3. Add selected-evidence provenance naming the value path:
   `evidence_projection = rate_attributed_local_evidence_propagation.v1`.

The investigation question remains:

> where does the current selected evidence prefix stop carrying propagated
> selected mass through the multi-hop window subject chain?

The correct fix is in selected-prefix value construction. If that question
cannot be answered using the existing bucket contract, the next deliverable is a
bucket-contract design amendment, not a broader runtime patch.

## 6. Invariant audit

This audit describes semantic invariants to preserve, not a checklist of
defensive branches to add. Prefer constructing valid `B`/`K_i` operators and
then letting the §4.6 evaluator's algebra enforce the invariants. Add guards
only at the operator-admission boundaries named in §4.6, or where a public
consumer could otherwise misinterpret synthetic display mass as direct
evidence strength.

### 6.1 Displayed rate remains Y/X

The denominator is still selected mass at `X`. The numerator is selected mass
at the subject end after rate-attributed propagation. The rate is never
retargeted to `Y/A`.

### 6.2 Counts do not cross edge boundaries

Raw `k` from hop 2 is never added to raw `k` from hop 1 and never max-flowed
with it. Hop 2 contributes `k/n`, which is applied to selected mass reaching
hop 2's source.

### 6.3 Projection does not re-decide semantics

Row projection reads resolved selected prefixes. It does not build carriers,
choose subject spans, infer downstream mass from raw counts, or decide whether
window/cohort evidence is admissible. If a needed selected source-mass surface
is missing, the runtime must expose a visible degradation.

### 6.4 Identity carrier is data, not a route

`window()` and `cohort(A=X)` initialise selected mass at `X` the same way.
The algorithm then proceeds through the same subject-chain propagation. There
is no separate window evidence evaluator. Equality between the two modes still
depends on the supplied primitive kernels being equivalent; identity carrier
only proves that the `R->X` seed kernel is the same Dirac object.

### 6.5 Active cohort remains Cohort-preserving but in scope

Active `cohort(A!=X)` gets selected mass at `X` through the carrier. Subject
primitive evidence remains primitive/source-clocked; the selected-evidence
projection places and scales it by pushing selected mass through the subject
kernels supplied by primitive binding. If raw cohort-clock rows need reshaping
into source-day × lag kernels, that happens before the evaluator and must carry
selected-root attribution. Where the row denominator and selected source mass
align at the X-rooted primitive, the propagation degenerates to the observed
`k`. Downstream active-cohort multi-hop primitives still use the same
rate-attributed evaluator. Dense, aligned, factorised active-cohort paths are
parity cases when their supplied operators are equivalent to the new `B`/`K_i`
operators. Value movement is in scope only when the previous path was relying
on a non-equivalent or invalid operator surface, and that movement must be
judged against outside-in oracle tests plus the drift snapshot.

### 6.6 Coverage remains support, not value

Coverage is computed from actual observation placements. A forward-filled rate
can carry value but cannot create support. A row with no fresh support should
fade even if the propagated value remains non-zero.

### 6.7 Missing downstream rates degrade visibly

If a downstream primitive has no admissible local rate rows, the terminal
evidence surface is absent or explicitly degraded. It must not silently emit
zero as if there were observed no-conversion evidence.

### 6.8 Single-hop exactness is mandatory

Single-hop must reproduce existing observed `evidence_y` because
`n × (k/n) = k`. Any single-hop drift is a bug in rate extraction,
selected mass alignment, or carry-forward timing.

### 6.9 Synthetic display `n` is not Binomial ESS

The A/X-scaled synthetic denominator is a population-display denominator. It
must not be passed downstream as if the terminal synthetic rate were directly
observed from `evidence_x` independent Bernoulli trials.

If a downstream consumer needs evidence strength, it must use an explicit
support surface or diagnostic field, not infer strength from `evidence_x`.

## 7. Test strategy

The test suite should prove the semantic object, not just a non-zero symptom.

Required tests:

- A focused identity-carrier multi-hop `M_select` test: selected mass exists
  at `X`, at the intermediate subject source, and reaches the downstream
  primitive with the expected reach scaling rather than disappearing.
- A single-hop degeneracy test: the rate-attributed path returns the same
  `evidence_y` as direct observed `k`.
- A cohort degeneracy test: for aligned cohort evidence, `n × (k/n)` recovers
  today's observed count output.
- A multi-hop `window()` outside-in test: hop-level evidence is non-zero and
  terminal `evidence_y` is positive, support-backed, and in the magnitude
  range implied by the hop rates and selected X denominator.
- A natural-degeneracy parity test: equivalent identity-carrier `window()` and
  `cohort(A=X)` queries produce the same selected-evidence rows when their
  supplied primitive kernels/evidence inputs are equivalent.
- An active-cohort guard test: `cohort(A!=X)` remains on propagated Cohort
  semantics and does not collapse into local-window mixing.
- A missing-downstream-rate test: absence of an admissible primitive rate
  degrades visibly rather than producing a misleading zero line.
- A support-separation test or diagnostic assertion: the synthetic displayed
  `evidence_x` remains selected-Cohort scaled, while hop-level support records
  the actual local denominators used to estimate each rate.
- A seam test at `tau_solid_max`: the evidence-line rate and the reducer's
  observed-prefix midpoint are equal because both read the same repaired
  selected prefix.

Per AP17, tests must be non-vacuous: at least one asserted row must have
positive denominator, positive local primitive evidence, and terminal evidence
whose expected value would be non-zero under the design.

### 7.1 Purpose-built outside-in fixture

The primary outside-in oracle fixture is `synth-window-rate-prop`:

- topology: `wrp-a -> wrp-b -> wrp-c`;
- `wrp-a -> wrp-b`: `p=0.25`, deterministic stepped latency at 5 days;
- `wrp-b -> wrp-c`: `p=0.30`, deterministic stepped latency at 2 days;
- no fetch failures, no random sparsity, no traffic overdispersion;
- strong deterministic traffic growth (`growth_rate_mom: 1.0`).

The traffic growth and deterministic lags make the terminal local
`wrp-b -> wrp-c` window denominator a different population size from the
synthetic selected `wrp-b` mass implied by selected `wrp-a` mass propagated
through `wrp-a -> wrp-b`. This is the discriminating property. A terminal raw
count shortcut and the correct A-scaled synthetic count are materially
different by construction.

The oracle in `test_cohort_factorised_outside_in.py` reads raw snapshot DB
rows directly and computes:

```
expected_y(a, tau)
  = N_A(a) * sum_s inc_rate_AB(a, s) * rate_BC(a+s, tau-s)
```

Then it compares public chart rows for:

```
from(wrp-a).to(wrp-c).window(1-Mar-26:14-Mar-26).asat(10-Apr-26)
```

against the raw-DB oracle. It also checks the identity-carrier query:

```
from(wrp-a).to(wrp-c).cohort(wrp-a,1-Mar-26:14-Mar-26).asat(10-Apr-26)
```

against the same oracle. The test is not allowed to pass merely because
`evidence_y` is non-zero; it must match the independent rate-attributed
synthetic count.

Initial red result on 11-May-26, before implementation, using the age-only
window kernel:

- oracle at tau 7-14: `evidence_x = 1,137,406`, `evidence_y ≈ 81,906.79`,
  `rate ≈ 0.0720119`;
- current `window()` output at the same taus: `evidence_y = 192.138`,
  `rate = 0.0001689`;
- raw same-anchor terminal `wrp-b -> wrp-c` count is `76,419`, and local
  terminal denominator is `253,974` versus synthetic propagated `wrp-b` mass
  `284,437`, proving the fixture distinguishes correct A-scaled propagation
  from terminal local-count shortcuts;
- current identity `cohort(A=X)` output is closer but still wrong at tau 7
  (`evidence_y ≈ 54,397`, `rate ≈ 0.047826`) and only approaches the oracle
  by later taus, so identity-carrier parity is not yet satisfied.

### 7.2 Drift-assessment assets (captured 11-May-26)

A first-attempt implementation was prototyped on 11-May-26 and reverted after
it broke the seam invariant §3.4 (numerator rebuilt on observed rates, denominator
left on model-timing carrier mass → systematic +21% overshoot on lat4
`cohort(A≠X)` at maturity, traced to the ratio
`model-timing-mass-at-X / observed-carrier-mass-at-X ≈ 1.21`). Before the
revert, two assets were captured that remain useful for a second attempt:

**1. Baseline snapshot** — `/tmp/cohort-multihop-drift-snapshot.pre-rewrite.json`

  Per-tau row data (`evidence_x`, `evidence_y`, `rate`, `midpoint`,
  `model_curve_midpoint`, `p_infinity_mean`, `completeness`, `tau_solid_max`,
  `tau_future_max`, …) for 11 queries spanning the three regimes the design
  touches:

  - `window()` multi-hop on `synth-window-rate-prop`, `synth-lat4`,
    `synth-lat4-flat`, `cf-fix-linear-no-lag`, `cf-fix-deep-mixed`
  - `cohort(A=X)` multi-hop on `synth-window-rate-prop`
  - `cohort(A≠X)` multi-hop on `synth-lat4`, `synth-lat4-flat`,
    `cf-fix-linear-no-lag`, `cf-fix-deep-mixed` (subject `e→g` and `d→f`)

  The five `cohort(A≠X)` multi-hop-subject queries are particularly important:
  they exercise the seam case (active carrier × multi-hop subject) but none of
  them are individually pinned by an outside-in oracle assertion today. A
  second-attempt implementation can drift on them without any test going red,
  so this baseline is the only quantitative guardrail. Captured at git_sha
  `a491f5f6` (the head of `feature/snapshot-db-phase0` after the revert).

**2. Snapshot script** — `/tmp/snapshot_cohort_drift.py`

  Iterates the canonical query list, invokes `graph-ops/scripts/analyse.sh`
  against the daemon for each query (`--type cohort_maturity --no-cache
  --no-snapshot-cache --format json`), parses `result.data`, and writes
  `cohort-multihop-drift-snapshot.<label>.json`. Reusable for a second
  attempt: run it pre-change to refresh the baseline at the new HEAD, then
  re-run post-change with a different label and diff. The `QUERIES` constant
  is the canonical query list and is the source of truth for the
  `cohort(A≠X)` multi-hop-subject coverage gap noted above.

  Required env: Python BE daemon up (`localhost:9000`), data repo cloned and
  resolvable via `.private-repos.conf`, all referenced synth fixtures
  enriched. All eleven queries take ≈3–5 minutes total to run.

Both assets currently live in `/tmp/` and are session-transient. They should
be moved to a durable repo-local path (e.g. a gitignored `_scratch/`
directory) before the next reboot. Move them as a unit; the script's path
references are relative to the repo root, not to its own location.

### 7.3 Currently-failing tests (expected red until this work lands)

The following three outside-in tests in
[`graph-editor/lib/tests/test_cohort_factorised_outside_in.py`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py)
are deliberately red on the current baseline and will remain red until the
rate-attributed propagation work is correctly implemented. The first two should
pass on completion; the third must be renamed/reframed before it becomes an
acceptance target because its current scalar-product wording conflicts with
§4.6. Any second attempt should treat their transition from red to green (or to
the reframed green successor for the third) as part of its acceptance criteria,
and should not be merged while any of them are still failing for the reasons
named below.

- **`test_window_multihop_evidence_matches_rate_attributed_db_oracle`** (line
  1903) — multi-hop `window()` evidence on the `synth-window-rate-prop`
  fixture against the §7.1 oracle. Currently fails because `evidence_y`
  collapses to ≈ 192 against an expected ≈ 81,907 at tau 7-14: the raw count
  composition path the existing code follows is not the rate-attributed
  propagation this design specifies.

- **`test_identity_cohort_multihop_matches_window_rate_attributed_oracle`**
  (line 1990) — the identity-carrier `cohort(A=X)` form must use the same
  carrier Dirac seed as `window()`. It should match the `window()` oracle only
  when the primitive kernels supplied to both modes are equivalent. Currently
  it fails because the cohort path produces ≈ 54,397 at tau 7, neither
  matching the window output nor the rate-attributed oracle for the equivalent
  kernel fixture.

- **`test_window_multihop_projected_midpoint_matches_successive_subject_projection_product`**
  (line 2764) — this test name and target are stale under §4.6. For a
  time-indexed multi-hop path, the projected midpoint must match the composed
  subject-kernel oracle, not a same-age scalar product of per-edge projection
  rates. Before implementation, rename/reframe this test around the
  convolutional oracle used by §7.1: `sum_s inc_rate_AB(s) * rate_BC(tau-s)`.
  The current failure remains a useful red signal, but the acceptance target is
  the composed kernel functional, not the scalar product.

A second attempt is not done until this outside-in set, including the reframed
composed-kernel successor for the third test, is green through the staged
protocol in §5.2. A failure in these tests is a routing signal back to the
owning stage, not an instruction to add a new data source or projection rule.
The snapshot baseline (§7.2) remains the final guardrail: it must show that
the `cohort(A≠X)` multi-hop-subject queries have not drifted into the
seam-violation regime described above, or else the drift must be recorded as a
separate design decision before any code is kept.

## 8. ESS reasoning

ESS is a separate statistical-support question:

> how uncertain is the composed terminal rate, given uncertainty in the local
> observed rates?

For real time-indexed multi-hop paths, the terminal rate is generally a
convolutional functional of the local incremental rate kernels, not a scalar
product of per-edge rates at the same chart age. In the two-hop case:

```
q_tau = F_tau(K_1, K_2)
      = sum_{s + r <= tau} K_1(s) * K_2(r)
```

with source-day-specific variants replacing `K_i(lag)` by
`K_i(source_day, lag)` and weighting by the selected evidence-mass ledger from
§4.6. For `N` hops, `F_tau` is the corresponding superposition of local-clock
convolutions. The first-order delta-method support calculation is therefore:

```
Var(q_tau) ≈ grad(F_tau)^T Cov(local_rate_kernels) grad(F_tau)
```

That can be estimated analytically from the composed convolutional functional
or by drawing empirical local rate kernels and composing those draws through
the same propagation algorithm.

The scalar product formula below is a degeneration of this object. It is valid
only for eventual scalar reach, zero/instant lag, or an explicitly scalarised
row approximation where the row is deliberately summarised as independent
scalar hop-rate estimates.

For a simple two-hop scalar product:

```
q = p1 × p2
```

with independent local Binomial estimates:

```
Var(p_i) ≈ p_i(1 - p_i) / n_i
```

the delta-method variance is:

```
Var(q) ≈ p2² Var(p1) + p1² Var(p2)
```

or, approximately on a relative scale:

```
Var(q) / q² ≈ Var(p1) / p1² + Var(p2) / p2²
```

The equivalent terminal-rate ESS is then the Binomial sample size whose
variance would match the composed-rate variance:

```
n_eff(q) = q(1 - q) / Var(q)
```

This is the principled conversion. It is not the geometric mean of hop sample
sizes, and it is not necessarily the minimum hop denominator. It lives on the
terminal rate scale, so low-rate or high-variance hops can dominate the result.

For `N` independent scalar hop-rate estimates:

```
q = product_i p_i
```

the delta method gives:

```
Var(q) ≈ sum_i (dq/dp_i)^2 Var(p_i)
```

and since `dq/dp_i = q / p_i`:

```
Var(q) ≈ q² × sum_i Var(p_i) / p_i²
```

Using the Binomial plug-in variance for each local rate:

```
Var(p_i) ≈ p_i(1 - p_i) / n_i
```

so:

```
Var(q) ≈ q² × sum_i (1 - p_i) / (n_i p_i)
```

and therefore:

```
n_eff(q) ≈ (1 - q) / (q × sum_i (1 - p_i) / (n_i p_i))
```

This is the simple N-hop independent-product approximation. It is suitable as
a diagnostic or first-pass support estimate only when the row can reasonably
be summarised by scalar local rates at that age. It is not a replacement for
the value path and must not rescale visible `evidence_x` / `evidence_y`.

The existing model/posterior MC draw families should not be silently reused as
evidence ESS. They answer a related but different question: uncertainty in the
model or conditioned posterior. Evidence ESS should describe support from the
observed local rows. Reusing model draws would require an explicit design
decision and provenance label.

First-pass recommendation:

- keep visible `evidence_x` / `evidence_y` A/X-scaled;
- carry hop-level `n`, `k`, and rate provenance;
- do not expose or consume terminal ESS unless a downstream consumer actually
  needs it;
- if ESS is needed later, compute it as a variance-matched support field
  (`support_n_eff` or equivalent), not by rescaling displayed counts.

## 9. Acceptance criteria

The proposal is complete when:

- the design doc and code provenance name the evidence value path as
  rate-attributed local evidence propagation, not direct observed counts;
- multi-hop `window()` queries no longer emit an all-zero terminal evidence
  line when every primitive has non-zero local evidence;
- single-hop window evidence is unchanged;
- cohort-aligned evidence recovers existing observed counts through the
  `n × (k/n) = k` degeneracy;
- identity-carrier `window()` and `cohort(A=X)` use the same Dirac carrier
  seed, and selected-evidence row parity holds when their supplied primitive
  kernels/evidence inputs are equivalent;
- the epoch A/B seam remains continuous because evidence rows and the E+F
  reducer read the same selected prefix;
- active `cohort(A!=X)` remains Cohort-preserving;
- coverage still reflects observation support separately from propagated
  value;
- visible synthetic counts stay A/X-scaled while statistical support is kept
  separate from the display denominator;
- diagnostics distinguish direct observed counts from synthetic propagated
  evidence.

## 10. Out of scope

- Changing the meaning of `window()` binding. Window primitives remain
  local-clock and mix Cohorts by design.
- Changing the model curve. The model curve may also compose rates, but its
  inputs are posterior/model surfaces; this proposal concerns evidence-named
  rows whose kernels come from observed rows.
- Changing the coverage formula except where needed to attach support to the
  propagated value path.
- Schema or wire-format changes. The row field names can remain the same, but
  provenance must identify when `evidence_y` is synthetic propagated evidence.
- Using raw count max-flow as the terminal value for mixed-Cohort multi-hop
  window paths.
- Using ESS-scaled counts as the visible first-pass chart values.
