# Selected-Cohort Spine Cutover — Action Plan

**Status**: replacement for `selected-cohort-projection-cutover-plan.md` (superseded)  
**Date**: 15-May-26  
**Scope**: implement Phase 6–9 of the model-first strict span cutover, covering evidence operator supply, selected-Cohort projection boundary, reducer cutover, debranching, and cleanup.

## Goal

Replace legacy selected-prefix machinery (`_SelectedSourceDayMass`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix`, `_selected_cohort_group_rate_draws`) with one mode-blind selected-Cohort projection boundary that evaluates through the Spine (`model_span_spine.py`).

**Hard constraints:**
- No role-by-role authority migration (all three modes — window, `cohort(A=X)`, active cohort — switch together in one atomic cutover)
- No new production branch (new path does not coexist with legacy in production)
- No Pop C / Pop D enumeration (the reducer projects `ΣY / ΣX` directly, never lists population cohorts)
- Spine orchestrates all modes; no mode branching inside the reducer

## Execution Sequence

Work proceeds strictly in phase order. A phase is **complete** only when all atoms are done AND the acceptance gate passes. Later-phase code may exist in the working tree but is not credited until earlier phases close.

---

## Phase 6: Selected-Root-Mass Supply + Evidence Operator Supply

### Atom 6.1: Specify selected-root-mass supply contract (design only)

**Input**: understanding of `ResolvedCFRuntime`, request's selected cohort structure, and the Phase 6 evidence operator contract (already written, `phase-6-evidence-operator-contract.md`).

**Work**: write a prose contract document (not code) that specifies:
- How the selected root mass is sourced: which `ResolvedCFRuntime` fields, what accessor pattern
- The data shape: indexed by anchor day, one source day per anchor at the chain root
- For `window()` mode: root mass = local window denominator at edge start
- For `cohort(A=X)` mode: root mass = anchor-day observed cohort at X
- For active `cohort(A!=X)` mode: root mass = anchor-day observed cohort at A, then subject-projected to X
- Provenance tracking: record which snapshot window supplied each root-mass cell

**Outcome**: one document (can be inline doc comment, does not need to be separate file) with these four sections. Bind to phase-6-evidence-operator-contract.md.

**Acceptance**: design is unambiguous enough that two independent implementers would build compatible code.

---

### Atom 6.2: Implement `SelectedRootMass` dataclass

**Input**: contract from 6.1.

**Location**: add to `graph-editor/lib/runner/model_span_spine.py` (or new module if the structure is large enough to justify separation; default is inline).

**Work**: define a frozen dataclass:
```python
@dataclass(frozen=True)
class SelectedRootMass:
    """Root mass for selected-Cohort evaluation.
    
    Per phase-6-evidence-operator-contract.md §4.2, indexed by 
    anchor day with one source day per anchor at the chain root.
    """
    root_day_by_anchor: Mapping[str, _date]      # anchor_day -> date
    root_count_by_anchor: Mapping[str, float]    # anchor_day -> N
    root_support_by_anchor: Mapping[str, float]  # anchor_day -> [0, 1] coverage
    root_exposure_by_anchor: Mapping[str, float] # anchor_day -> [0, 1] exposure
    provenance: Mapping[str, str] = field(default_factory=dict)
```

Include accessor methods:
- `root_mass_for_anchor(anchor_day: str) -> float`: the count
- `has_support_at_anchor(anchor_day: str) -> bool`: coverage > 0
- `is_exposed_at_anchor(anchor_day: str) -> bool`: exposure > 0

**Acceptance gate**: dataclass is defined, typed, and imports cleanly. No tests yet.

---

### Atom 6.3: Implement selected-root-mass builder

**Input**: 
- contract from 6.1
- existing `ResolvedCFRuntime` structure
- existing A-clock selected-cohort tracking in `cohort_forecast_v3.py`

**Location**: add function to `model_span_spine.py`:
```python
def build_selected_root_mass(
    runtime: ResolvedCFRuntime,
    selected_anchors: Sequence[str],
    mode: str,  # "window" | "cohort_active" | "cohort_identity"
    carrier_end_day: Optional[_date] = None,  # for active cohort only
) -> SelectedRootMass:
    """Build selected root mass from runtime.
    
    Args:
        runtime: resolved runtime with eligible cohorts
        selected_anchors: anchor days to include
        mode: query mode determining mass interpretation
        carrier_end_day: date X for active cohort(A, X-end); 
                         unused for window/cohort(A=X)
    
    Returns: SelectedRootMass with root counts, support, exposure, provenance
    
    Raises: RuntimeError if mode not recognized or runtime ineligible
    """
```

**Implementation contract**:
- For `window` mode: read observed cohort at `runtime.edge_start` node; one source-day per anchor = anchor itself
- For `cohort_identity` mode: read observed cohort at `runtime.anchor_node`; identity carrier means subject root = anchor
- For `cohort_active` mode: 
  - Read observed cohort at `runtime.anchor_node` (seed mass for carrier)
  - Compose carrier to `carrier_end_day` to get synthetic subject root mass distribution
  - Subject conditioning uses X-rooted arrival map, reads `N_X(t)` from that distribution
  - Return the X-rooted distribution as `root_mass_for_subject`
- Root support/exposure: read from existing `SelectedAClockEvidence` coverage/exposure fields, or derive from observation mask
- Provenance: record "window-literal" | "cohort-identity-literal" | "cohort-active-carrier-projection"

**Acceptance gate**:
- Function signature matches spec
- Returns a valid `SelectedRootMass` object
- Unit test: `test_selected_root_mass_builder.py` with fixtures for all three modes, verifying shape and provenance

---

### Atom 6.4: Implement evidence operator supply (primitive → SpanOperator)

**Input**: 
- Phase 6 evidence operator contract §4.1 (per-edge rate kernel spec)
- existing `ConditionedTransitionPrimitive` objects (already conditioned per arrival map)
- existing snapshot evidence buckets (already bucketed per arrival map)

**Location**: add to `graph-editor/lib/runner/span_operator_supply.py` (which already handles `draw_model_primitive_operators`):

```python
def draw_evidence_primitive_operators(
    primitive: ConditionedTransitionPrimitive,
    source_day_set: Sequence[_date],
    horizon: int,
    per_draw_kernel_builder: Callable,  # builds rate(s, age) per source day
) -> Sequence[SpanOperator]:
    """Build evidence-side SpanOperator objects from a conditioned primitive.
    
    One operator per source day in the primitive's evidence bucket.
    
    Args:
        primitive: ConditionedTransitionPrimitive with fit rate/CDF
        source_day_set: days with observed evidence at this edge
        horizon: max age
        per_draw_kernel_builder: (source_day, cdf_draws, p_draws) -> kernel
    
    Returns: list of SpanOperator per source day, ready to compose
    
    See phase-6-evidence-operator-contract.md §4.1 for kernel spec.
    """
```

**Implementation contract**:
- For each source day `s` in the primitive's observed support:
  - Kernel domain: age 0 to horizon
  - If `n(s) > 0` (observed denominator):
    - Read cumulative CDF from fitted posterior or aggregate posterior (depending on stationarity)
    - Convert to per-day density: `Δcdf(s, age)` per contract §3.1 and §3.4
    - Build mask: `𝟙_observed(s, age) = 1` (observed support)
  - If `n(s) = 0` (covered-zero case):
    - Kernel = zeros (no arrival)
    - Mask = 1 (observed support, just no mass)
  - If no evidence row exists for `s` at this edge (absent support):
    - Do not add to domain; skip this source day
- Return one operator per source day with value/support/exposure kernels per contract §4.8
- No interpolation, no central-curvature correction, no fallback policy — raw kernel from evidence

**Acceptance gate**:
- Function exists and type-checks
- Unit test: `test_evidence_operator_supply.py` with fixtures for single-hop and multi-hop, including covered-zero and absent-support cases
- Parity test: compare built kernels against legacy `_interpolated_rate_at` output (should be identical for observed cells)

---

### Atom 6.5: Add evidence operator supply to Spine entry point

**Input**: outputs from 6.2, 6.3, 6.4.

**Location**: modify `model_span_spine.py`:

```python
def build_selected_cohort_projection(
    subject: ComposedPrimitiveSpan,
    carrier: ComposedPrimitiveSpan,
    selected_root_mass: SelectedRootMass,
    evidence_operators_by_edge: Mapping[str, Sequence[SpanOperator]],
    horizon: int,
) -> SelectedCohortProjection:
    """Single mode-blind selected-Cohort projection boundary.
    
    Evaluates carrier-only denominator X and carrier+subject numerator Y 
    from the same root mass through the same operator-chain algebra.
    Per phase-6-evidence-operator-contract.md, no mode branching.
    
    Args:
        subject: composed subject span (A-clock readout)
        carrier: composed carrier span (identity for window/cohort(A=X))
        selected_root_mass: SelectedRootMass from 6.3
        evidence_operators_by_edge: per-edge evidence kernels from 6.4
        horizon: max age
    
    Returns: SelectedCohortProjection with X/Y/coverage/support surfaces
    
    Raises: RuntimeError if inputs inconsistent (subject/carrier shape mismatch)
    """
```

**Implementation contract**:
- No mode flag (mode is encoded upstream in which span/root-mass/operators are supplied)
- Two parallel streams: value and support (per contract §4.8)
- Value stream:
  - Root mass = `selected_root_mass.root_count_by_anchor`
  - Per-edge kernels = `evidence_operators_by_edge[edge_id].value_kernel`
  - Push forward through subject (denominator X) and then through carrier (numerator Y)
  - Return cumulative sums at projection
- Support stream:
  - Same push-forward with masked kernels (`kernel × 𝟙_observed`)
  - Coverage = `support_cumsum / value_cumsum` per cell
- Exposure stream:
  - Unit-reach masked kernels (contrast with value stream's p-scaled kernels)
  - Exposes coverage distinction between covered-zero and absent-support
- Output includes per-(anchor, τ) surfaces for X, Y, coverage, support, exposure
- NaN where X=0 (before carrier arrives), not a defensive zero

**Acceptance gate**: 
- Function exists and type-checks
- Minimal test: single-hop cohort mode with all-observed support, X/Y values match legacy reducer to within floating-point tolerance

---

## Phase 7: Reducer Cutover (All Modes Together)

### Atom 7.1: Replace `_selected_cohort_group_rate_draws` call site

**Input**: output from Phase 6.

**Location**: `cohort_forecast_v3.py`, find all calls to `_selected_cohort_group_rate_draws`.

**Work**:
1. Replace each call with `model_span_spine.build_selected_cohort_projection(...)` passing:
   - Composed subject/carrier from runtime (same as before)
   - `SelectedRootMass` built via 6.3
   - Evidence operators built via 6.4
   - Horizon from request
2. Read `ΣY / ΣX` and support/exposure surfaces from the returned projection
3. Route all three modes (window, cohort(A=X), cohort(A!=X)) through the identical call

**Acceptance gate**: 
- All three modes pass the outside-in oracle (test command TBD, run against focused selected-evidence suite)
- Production row columns (`midpoint`, `fan_*`, `projected_rate`, `forecast_x`, `forecast_y`) match legacy within floating-point tolerance

---

### Atom 7.2: Replace evidence field reads

**Input**: Phase 7.1 done.

**Location**: `_build_selected_a_clock_evidence_from_runtime` and `SelectedAClockEvidence`.

**Work**:
- Modify `_build_selected_a_clock_evidence_from_runtime` to read:
  - `x_at_query_x` from projection's X surface (cumulative)
  - `y_at_subject_end` from projection's Y surface (cumulative)
  - `*_landing_coverage` from projection's coverage surface
  - No longer read from `_CarrierOnlyDenominatorPrefix` or `_RateAttributedSubjectPrefix`
- Evidence fields remain part of the row schema; they are now projections from the unified boundary, not independent prefix objects

**Acceptance gate**:
- Selected evidence outside-in suite remains green
- Evidence cell values match legacy within tolerance
- Coverage values match legacy coverage semantics (per `cohort-maturity-evidence-coverage-design.md`)

---

### Atom 7.3: Verify frontier and support semantics

**Input**: Phase 7.1–7.2 done.

**Location**: `_project_runtime_rows`, frontier calculation logic.

**Work**:
- Frontier age is determined by where `coverage > 0` in the projection
- Support state per edge is now read from `exposure_stream` (distinct from `support_stream` per contract §4.8)
- Verify the three-state trichotomy (absent / covered-zero / observed-positive) propagates correctly through the chain

**Acceptance gate**:
- Frontier calculation produces identical τ to legacy (off by ≤1 day tolerable, must be justified)
- Support-state diagnostics show correct absent vs covered-zero distinction

---

## Phase 8: Debranching

### Atom 8.1: Identify and remove modal branches in reducer

**Input**: Phase 7 complete (legacy path still live, new path on production call).

**Location**: `cohort_forecast_v3.py`, search for identity-carrier and window vs cohort branches.

**Work**: grep for patterns:
- `if carrier_is_identity:`
- `if window_identity:`
- `if mode == "window" or mode == "cohort_identity":`
- any `_CarrierOnlyDenominatorPrefix` or `_RateAttributedSubjectPrefix` instantiation
- old `_SelectedSourceDayMass` construction

For each: either prove it is dead code (unreachable from current call site), or consolidate with the new path. **Do not keep both branches alive.**

**Acceptance gate**: grep finds zero branches matching the patterns above

---

### Atom 8.2: Delete legacy prefix classes

**Input**: Phase 8.1 done (all callers migrated).

**Location**: `cohort_forecast_v3.py`, lines ~586–730.

**Work**:
1. Delete `_SelectedSourceDayMass` (line 586+)
2. Delete `_CarrierOnlyDenominatorPrefix` (line 679+)
3. Delete `_RateAttributedSubjectPrefix` (line 708+)
4. Grep the entire codebase to confirm no remaining references:
   ```bash
   grep -r "_SelectedSourceDayMass\|_CarrierOnlyDenominatorPrefix\|_RateAttributedSubjectPrefix" graph-editor/lib/
   ```
5. If references exist outside of test fixtures or comments, STOP and identify blocker

**Acceptance gate**: grep returns zero results (or only in comments / archive / test fixtures)

---

### Atom 8.3: Delete old observed-prefix amplitude paths

**Input**: Phase 8.2 done.

**Location**: `cohort_forecast_v3.py`, search for `_build_observed_span_evidence_surface`, zero-edge identity handling.

**Work**:
- These were fallback paths when the new evidence operators were not available
- With Phase 7 complete, they are unreachable
- Delete if grep shows no callers, or document as Phase 9 cleanup if callers remain

**Acceptance gate**: grep shows zero production callers (test fixtures acceptable)

---

## Phase 9: Cleanup and Closure

### Atom 9.1: Delete or rename shadow diagnostics

**Input**: Phase 8 complete.

**Location**: `cohort_forecast_v3.py` and `generalised_span_model_shadow.py`.

**Work**:
- `_runtime_provenance_with_generalised_span_shadow` — either delete if unused, or formally own it as a named diagnostic hook
- `_build_generalised_span_shadow_plans` — delete if no production consumer
- `_build_generalised_evidence_shadow_plans` — delete
- `generalised_span_model_shadow.py` — if no callers, delete the entire file

Verify via grep.

**Acceptance gate**: all shadow references accounted for (deleted, formally owned, or documented as out-of-scope)

---

### Atom 9.2: Delete dead code annotations

**Input**: Phase 9.1 done.

**Location**: `cohort_forecast_v3.py`.

**Work**:
- `_composed_pair_request_cdf_draws` — should be replaced in Phase 5b (model-side), but if it somehow lingered, delete it now
- Any `# DEAD CODE — ...` comments marking Phase 5/6/7 migrations
- Scan for `TODO Phase 5` / `TODO Phase 6` markers

**Acceptance gate**: no dead-code comments remain in production files

---

### Atom 9.3: Update codebase documentation

**Input**: Phases 6–9 complete and green.

**Location**: `docs/current/codebase/` and `docs/current/project-generalise/`.

**Work**:
1. Update `docs/current/codebase/TOPOLOGY.md` (§ Cohort Forecast v3) to reflect the spine-based architecture:
   - Selected-Cohort evaluation now routes through `model_span_spine.build_selected_cohort_projection(...)`
   - No per-mode branching; mode is data on the call (which root mass, which operators)
   - Evidence operators are built per-source-day from conditioned primitives
2. Archive or delete `docs/current/project-generalise/selected-cohort-projection-cutover-plan.md` (old)
3. If `selected-cohort-projection-cutover-plan.md` contained design intent not captured elsewhere, migrate to Phase 6 contract or subsystem docs
4. Move this action plan (`ACTION_PLAN_selected_cohort_spine_cutover.md`) to `docs/archive/` after closure

**Acceptance gate**: 
- TOPOLOGY.md reflects current structure
- No docs describe legacy prefix classes as current authority
- Readers of the project-generalise folder see clear handoff to production

---

## Verification Gates (Run After Each Phase)

| Phase | Test Command | Acceptance Criterion |
|-------|--------------|----------------------|
| 6 | `cd graph-editor && pytest lib/tests/test_selected_root_mass_builder.py lib/tests/test_evidence_operator_supply.py lib/tests/test_selected_cohort_projection_boundary.py -xvs` | All tests pass |
| 7 | `cd graph-editor && pytest lib/tests/test_selected_evidence_natural_degeneracy.py lib/tests/test_doc56_phase0_behaviours.py -xvs --strict-markers` | All tests pass, no xfail regressions |
| 8 | `grep -r "_SelectedSourceDayMass\|_CarrierOnlyDenominatorPrefix\|_RateAttributedSubjectPrefix" graph-editor/lib/runner/ graph-editor/lib/tests/` | Zero matches in production (matches in archive acceptable) |
| 9 | `cd graph-editor && pytest lib/tests/ --strict-markers 2>&1 \| tail -1` (just the summary line, no truncation of individual tests) | Full suite green; all xfail markers resolved or documented |

**Final gate (all phases)**: `pytest lib/tests/test_cohort_factorised_outside_in.py -xvs` (the canonical CF oracle)

---

## Stop Conditions

**Do NOT proceed to next atom if:**

- A test fails and the root cause is not understood
- An acceptance gate reports mismatches but they are attributed to "probably staleness" without running `scripts/dev-server-check.sh`
- Modal branching logic is "simplified" by hardcoding a mode instead of removing the branch
- An old prefix class is left "for now" as a fallback without a Phase 8/9 ticket
- Grep results are rationalized away without a systematic audit
- Coverage or frontier values change by >1% without explicit justification in commit message

**Do NOT treat as done:**
- Shadow diagnostics still call legacy code
- Tests pass only with `head -N` truncation on output
- "No visible behavior change" when an xfail marker flipped from xfail to pass (that's progress, document it)

---

## Appendix: Legacy Code Locations (for reference)

| Class / Function | File | Lines | Purpose |
|---|---|---|---|
| `_SelectedSourceDayMass` | `cohort_forecast_v3.py` | 586+ | Selector for source-day buckets per anchor |
| `_CarrierOnlyDenominatorPrefix` | `cohort_forecast_v3.py` | 679+ | Denominator prefix for carrier-only X |
| `_RateAttributedSubjectPrefix` | `cohort_forecast_v3.py` | 708+ | Numerator prefix for subject-only Y attribution |
| `_selected_cohort_group_rate_draws` | `cohort_forecast_v3.py` | ~5083 | Public row builder using legacy prefixes |
| `_build_selected_a_clock_evidence_from_runtime` | `cohort_forecast_v3.py` | ? | Evidence cell builder from prefixes |
| `SelectedAClockEvidence` | `cohort_forecast_v3.py` | 44+ | Data class holding selected-cohort row evidence |
| `model_span_spine.py` | `graph-editor/lib/runner/` | (new) | Spine orchestrator (target for evidence cutover) |

---

## Key Invariants (Do Not Violate)

1. **No role-by-role cutover**: do not migrate window first, then cohort(A=X), then active cohort separately. All three switch in one atomic Atom 7.1 cutover.

2. **Spine is mode-blind**: `build_selected_cohort_projection` takes no `mode` parameter. Mode is encoded upstream in the root mass and operator supply.

3. **No Pop enumeration**: never enumerate Pop C or Pop D population cohorts in the reducer. Project `ΣY / ΣX` directly.

4. **No legacy fallback in new path**: do not keep old prefix construction "in case the new path fails". If the new path is incomplete, block on Phase 6 completion; do not ship a half-baked hybrid.

5. **Support state semantics**: covered-zero (observed-zero) must be distinguished from absent (model-imputed) by the exposure stream, not by a secondary check. Both are included in the value path; support stream zeros out absent cells.

6. **Cumulative vs incremental boundary** (per contract §3.4): internal nodes propagate per-day densities (Δk); the terminal readout projects to cumulative k. Do not mix in the middle of the chain.

---

## Definition of Done

The cutover is **complete** when:

- [ ] Phase 6: Selected-root-mass supply, evidence operator supply, and Spine entry point are implemented and tested
- [ ] Phase 7: All three modes (window, cohort(A=X), cohort(A!=X)) route through the new path; outside-in oracle green
- [ ] Phase 8: Zero legacy prefix classes remain; grep confirms no reachable references
- [ ] Phase 9: All shadow/dead code cleaned up; docs updated; final outside-in oracle passes
- [ ] `git log` shows the refactor as one cohesive series of atoms (not scattered across unrelated commits)
- [ ] **No new xfail markers or loosened test tolerances introduced during the cutover**

