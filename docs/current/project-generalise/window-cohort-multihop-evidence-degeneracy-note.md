# Window and Cohort Multi-Hop Evidence Degeneracy

**Status**: Working semantic note  
**Date**: 17-May-26  
**Scope**: Algebraic invariants for validating the new spine evidence logic across `cohort()` and `window()` multi-hop cases.

## Purpose

The new spine needs one general evidence construction that covers both `cohort()` and `window()` multi-hop without smuggling one mode's semantics into the other.

The key point is that the two modes degenerate on different axes:

- `cohort()` multi-hop degenerates through **mass/denominator cancellation** under proper A-clocked evidence.
- `window()` multi-hop degenerates through **1:1 local evidence lookup** at each edge's own window clock.

Any candidate algebra must satisfy both. Passing only one is not enough.

## Invariant 1: Cohort Cancellation

For `cohort(A, X -> Z)`, the selected population is a real A-rooted cohort. Multi-hop evidence preserves cohort identity through the path.

At each edge `U -> V`, with proper A-clocked evidence, the local denominator bucket equals the propagated selected mass at `U`:

```text
m_U(C, s) = n_UV(C, s)
```

Therefore the local rate application cancels naturally:

```text
m_U(C, s) * k_UV(C, s, h) / n_UV(C, s)
= k_UV(C, s, h)
```

This is the `cohort()` proof obligation: the rate denominator disappears because candidate admission and clocking selected exactly the rows whose denominator is the propagated cohort mass.

The implementation should not special-case this cancellation. It should fall out of the evidence candidates and clock binding.

## Invariant 2: Window Local Lookup Identity

For `window(C).from(A).to(Z)`, the path deliberately mixes local edge cohorts. There is no cohort integrity to preserve across intermediate nodes.

Each edge lookup is local to that edge's own source clock:

```text
R_UV(C, tau) = k_UV(source_day = C, age = tau) / n_UV(source_day = C)
```

Multi-hop propagation then rate-adjusts the synthetic upstream mass using each edge's same-window local rate:

```text
M_V(C, tau) = M_U(C, tau) * R_UV(C, tau)
```

For a two-hop path `A -> B -> C`:

```text
M_C(C0, tau)
= N_A(C0) * R_AB(C0, tau) * R_BC(C0, tau)
```

The proof obligation for `window()` is that each evidence lookup collapses to this 1:1 local reference. The algebra must not introduce shifted intermediate source days such as:

```text
R_BC(C0 + h, tau - h)
```

That shifted lookup reintroduces a dated synthetic path cohort. That is a `cohort()`-style arrival propagation concept, not the intended `window()` multi-hop evidence semantics.

## Current Spine Concern

In `graph-editor/lib/runner/model_span_spine.py`, `is_window` is consumed during subject primitive preparation: each subject primitive is bound with identity arrival weights at its own source.

That satisfies local primitive evidence binding.

The row projection then evaluates the composed empirical subject span from a root seed:

```text
root_seed = N_C * delta_0
emp_x_value = empirical_carrier(root_seed)
emp_y_value = empirical_subject(emp_x_value)
evidence_y = cumsum(emp_y_value)
```

The empirical span evaluator maps source-index `i` to calendar source day `origin_day + i`, and the density DP applies each downstream kernel from that source index onward. Algebraically, for `A -> B -> C`, this produces:

```text
K_AC(C0, tau)
= N_A(C0) * sum_h Delta R_AB(C0, h) * R_BC(C0 + h, tau - h)
```

That is source-day / remaining-age composition after local binding.

The unresolved semantic question is whether this is acceptable for `window()` multi-hop. Against the invariant above, the expected `window()` degeneracy is instead:

```text
K_AC(C0, tau)
= N_A(C0) * R_AB(C0, tau) * R_BC(C0, tau)
```

## Acceptance Tests Needed

The candidate logic should be tested against both degeneracies.

### Cohort Multi-Hop

Construct A-clocked evidence where each downstream denominator is exactly the propagated selected mass. Verify that:

```text
m_U * k_UV / n_UV
```

reduces naturally to the observed selected count flow at every hop. No mode branch or post-hoc repair should be needed.

### Window Multi-Hop

Construct local window evidence with deliberately different source-day behaviour, so shifted source-day composition and same-window rate multiplication produce different finite-`tau` answers.

For `A -> B -> C`, verify that `window(C0).from(A).to(C)` at finite `tau` uses:

```text
N_A(C0) * R_AB(C0, tau) * R_BC(C0, tau)
```

and not:

```text
N_A(C0) * sum_h Delta R_AB(C0, h) * R_BC(C0 + h, tau - h)
```

This is the direct test that `window()` evidence lookup has collapsed to one local reference per edge.

## Proposed No-Branching Repair Scope

The repair should not add a `window()` branch to the row reducer. It should make the evidence lookup binding an explicit data object consumed by one generic transition evaluator.

The generic cumulative transition is:

```text
M_V(C, tau)
= sum_h Delta M_U(C, h) * R_UV(lookup_source(C, h, tau), lookup_age(C, h, tau))
```

The mode difference is carried by the lookup binding:

```text
cohort binding:
  lookup_source(C, h, tau) = C + h
  lookup_age(C, h, tau)    = tau - h

window binding:
  lookup_source(C, h, tau) = C
  lookup_age(C, h, tau)    = tau
```

With the `cohort()` binding, the current source-day / remaining-age composition is preserved and the cohort cancellation invariant can fire:

```text
M_V(C, tau)
= sum_h Delta M_U(C, h) * R_UV(C + h, tau - h)
```

With the `window()` binding, the rate term is independent of `h`, so the same generic formula factors naturally:

```text
M_V(C, tau)
= R_UV(C, tau) * sum_h Delta M_U(C, h)
= R_UV(C, tau) * M_U(C, tau)
```

For `A -> B -> C`, that gives:

```text
M_C(C0, tau)
= N_A(C0) * R_AB(C0, tau) * R_BC(C0, tau)
```

The implementation shape implied by this note:

1. Introduce an evidence readout binding for empirical primitives or composed empirical spans:

   ```text
   lookup(anchor_day, source_index, tau_out) -> (evidence_source_day, evidence_age)
   ```

2. Replace strict empirical value evaluation in the selected-cohort row reducer with a cumulative transition evaluator that calls the binding for every edge/source/row lookup.

3. Apply the same binding to support and coverage predicates. This is part of the same repair, not a follow-up: strict value, adjusted value, support, exposure, frontier-tail, and admissibility must all use the same lookup binding. The current checkpoint shape:

   ```text
   O_e(origin_day + source_index, tau - source_index)
   ```

   becomes:

   ```text
   O_e(lookup(anchor_day, source_index, tau))
   ```

   If value is moved to the `window()` local lookup identity while coverage stays on the shifted source-day lookup, the row will split into two incompatible algebras:

   ```text
   value:    R_UV(C, tau)
   coverage: O_UV(C + h, tau - h)
   ```

   That is invalid for the same reason shifted value lookup is invalid.

4. Keep model/F-mode out of this repair unless separately re-scoped. This note concerns empirical evidence, strict/adjusted evidence, evidence coverage, exposure, frontier-tail, and the admissibility gates derived from them.

The acceptance criterion is that both degeneracies are produced by the same evaluator with different lookup-binding data, not by mode branches in projection code.

## Implementation Touch Points

The current implementation sites that need to change are below. The goal is to introduce lookup-binding data at the empirical readout boundary while preserving one evaluator.

### Must Touch

#### `graph-editor/lib/runner/model_span_spine.py`

Owns the selected-cohort reducer and the handoff into empirical evaluation.

Touch points:

- `project_selected_cohort_rows`
  - currently calls `evaluate_empirical_span_from_seed` for strict and adjusted evidence;
  - currently calls `evaluate_row_boundary_chain_cumulative` with `checkpoint_predicate` / `future_checkpoint_predicate`;
  - needs to pass the evidence readout binding into empirical value evaluation, adjusted evidence evaluation, coverage evaluation, exposure evaluation, frontier-tail evaluation, and the admissibility gates that consume exposure.
- `SelectedCohortRowProjection`
  - likely unchanged structurally, but its docstring must describe that strict/adjusted/coverage are produced by lookup-bound empirical/readout evaluation, not by a fixed source-index convention.
- `resolve_request_spans`
  - currently consumes `is_window` only while preparing subject primitives;
  - needs to carry readout-binding data forward with the composed empirical spans or runtime surfaces so projection does not have to branch on mode.

#### `graph-editor/lib/runner/empirical_evidence_operator.py`

Owns empirical kernel construction and source-day lookup during evaluation.

Touch points:

- `EmpiricalEvidencePrimitive`
  - may need to carry the readout binding, or enough metadata for a composed empirical span to resolve it.
- `_kernel_for_source_day`
  - currently accepts a concrete `source_day` and returns the corresponding per-source-day or aggregate kernel;
  - should remain the low-level row lookup, but callers should supply `(evidence_source_day, evidence_age)` selected by the binding.
- `evaluate_empirical_span_from_seed`
  - currently maps `source_index -> origin_day + source_index`;
  - needs a binding-aware cumulative transition evaluator so `window()` can resolve every hop to `(C, tau)` while `cohort()` resolves to `(C + h, tau - h)`.
- `_build_empirical_delta_kernel_draws`
  - probably does not need semantic changes; it already builds per-source-day cumulative-rate increments and masks. It may need helper accessors for cumulative `R(source_day, age)` as well as increment `Delta R`.

#### `graph-editor/lib/runner/subject_span_composer.py`

Owns conditioned support/exposure row-boundary evaluation used by coverage.

Touch points:

- `evaluate_row_boundary_chain_cumulative`
  - currently gates by `predicate(primitive, origin_day + source_index, tau_out - source_index, S)`;
  - needs to call the same evidence readout binding used by empirical value evaluation.
- `_make_row_boundary_kernel_provider`
  - current hard-coded source/age mapping should move behind the binding.
- `checkpoint_predicate` and `future_checkpoint_predicate`
  - should remain predicate functions over `(primitive, evidence_source_day, evidence_age, S)`;
  - callers should stop deriving those two inputs with the fixed `origin + source_index`, `tau - source_index` rule.

Coverage-specific acceptance requirement: after the repair, there must be no path where `evidence_y_strict` uses one lookup binding while `coverage_y`, `exposure_y`, `frontier_tail_y`, or `strict_admissible_y` uses another.

### Probably Leave Alone

#### `graph-editor/lib/runner/timing_span.py`

The density DP is probably still the correct low-level executor.

`_run_dp_density_trace_from_seed` already accepts an `edge_kernel_provider(ce, source_index)` callback. The fix should use that callback boundary rather than changing the DP itself. If this file needs edits, it is a sign the abstraction has slipped too low.

#### `graph-editor/lib/runner/subject_span_composer.py` conditioned value composition

Conditioned/model value surfaces may be out of scope unless separately re-scoped. This note is about empirical evidence, strict/adjusted evidence, and evidence coverage. Do not silently change F-mode/model overlay behaviour while repairing empirical evidence.

### Tests To Touch

#### `graph-editor/lib/tests/test_model_span_spine_selected_cohort.py`

Primary spine-level test file.

Add or update:

- a finite-`tau` `window()` multi-hop test that distinguishes:

  ```text
  N_A(C) * R_AB(C, tau) * R_BC(C, tau)
  ```

  from:

  ```text
  N_A(C) * sum_h Delta R_AB(C, h) * R_BC(C + h, tau - h)
  ```

- a `cohort()` multi-hop cancellation test where denominator equality makes the rate terms cancel without a mode branch;
- coverage tests proving the same lookup binding is used by `checkpoint_predicate` / `future_checkpoint_predicate`.

#### `graph-editor/lib/tests/test_mcar_sparsity_recovery.py`

Review after the binding change.

The current MCAR expectations use the old source-index path-product framing. If `window()` coverage changes to same-date/same-age lookup, the expected coverage behaviour must be re-derived against the new window invariant, not mechanically preserved.

#### Outside-in tests

Any outside-in window multi-hop oracle that currently encodes shifted source-day composition must be audited against this note. If the intended runtime semantics are the `window` local lookup identity, those oracles should be updated only after the spine-level algebraic tests pin the new invariant.

## Terminology

Use these names consistently:

- **Cohort cancellation**: `m_U = n_UV`, so the rate denominator cancels under A-clocked evidence.
- **Window local lookup identity**: each edge reads `R_UV(C, tau)` directly on its own local window clock.
- **Shifted source-day composition**: terms of the form `R_UV(C + h, tau - h)`. This is valid only when the readout is intentionally preserving an arrival-date path cohort.

