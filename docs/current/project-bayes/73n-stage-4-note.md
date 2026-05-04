# 73n Stage 4 — Unsupported Residual and Unparameterised Edge Guard — note

**Status**: Stage 4 landed
**Date opened**: 1-May-26
**Plan**: [`73n-carrier-evidence-conditioning-implementation-plan.md`](73n-carrier-evidence-conditioning-implementation-plan.md) §"Stage 4 — Unsupported Residual and Unparameterised Edge Guard"
**Stage 0a baseline**: [`73n-stage-0-baseline.md`](73n-stage-0-baseline.md) §1.9 (topology coverage / no live residual requirement), §1.11 (UpdateManager sibling rebalancing)
**Stage 1 contract**: [`73n-stage-1-note.md`](73n-stage-1-note.md) §1.1 (`UNSUPPORTED_RESIDUAL`, `STRUCTURALLY_DETERMINISTIC`, `ResidualPolicyProvenance` slots)
**Stage 2 input**: [`73n-stage-2-note.md`](73n-stage-2-note.md) §1.2 (`validate_span_primitive` rejection signal)
**Stage 3 hand-off**: [`73n-stage-3-note.md`](73n-stage-3-note.md) §1.4 ("Stage 3 deliberately never returns `UNSUPPORTED_RESIDUAL` or `STRUCTURALLY_DETERMINISTIC` — those statuses are Stage 4's surface")

---

## 1. Stage 4 deliverables

### 1.1. Residual / unparameterised edge guard module

[`graph-editor/lib/runner/primitive_residual_guard.py`](../../graph-editor/lib/runner/primitive_residual_guard.py) defines the entry point Stage 5+ composers will call before invoking Stage 3 conditioning, and the constructors that emit the two new primitive surfaces Stage 3 deferred. Public API:

- `EdgeRequirementKind` — enum of the five ways an edge can participate in primitive composition: `PARAMETERISED`, `STRUCTURALLY_DETERMINISTIC`, `UNPARAMETERISED_RESIDUAL`, `UNPARAMETERISED_COMPLEMENT`, `PREPARED_SPAN_REJECTED`.
- `EdgeRequirement` — composer-supplied description of one edge with optional `deterministic_p`, `requires_adjacency_one_minus_p`, `branch_complement_target`, `residual_closure_target`, `prepared_span_rejection_reason`, and `note` slots.
- `ResidualGuardDecision` — outcome carrying `forward_to_conditioning: bool` (True only for the `PARAMETERISED` happy path), the `status_to_emit: ConditioningStatus | None`, the `rejection_reason`, the `residual_policy: ResidualPolicyProvenance | None`, and `deterministic_p: float | None`.
- `classify_edge_requirement(requirement)` — the decision function. The matrix:
  - `PARAMETERISED` + no adjacency-complement request → forward to Stage 3 (`condition_primitive`); empty evidence becomes `PRIOR_ONLY` there, not `UNSUPPORTED_RESIDUAL` here (plan §95-96, §572).
  - `PARAMETERISED` + `requires_adjacency_one_minus_p=True` → `UNSUPPORTED_RESIDUAL` with `branch_complement_required` populated and the rejection reason citing plan §55, §660.
  - `STRUCTURALLY_DETERMINISTIC` with explicit `deterministic_p` ∈ [0, 1] → `STRUCTURALLY_DETERMINISTIC` (no residual policy; no subset/blend policy).
  - `STRUCTURALLY_DETERMINISTIC` without `deterministic_p` → `ValueError`. **Determinism is never inferred from missing evidence** (plan §99).
  - `UNPARAMETERISED_RESIDUAL` → `UNSUPPORTED_RESIDUAL` with `residual_closure_required` populated.
  - `UNPARAMETERISED_COMPLEMENT` → `UNSUPPORTED_RESIDUAL` with `branch_complement_required` populated.
  - `PREPARED_SPAN_REJECTED` → `UNSUPPORTED_RESIDUAL` carrying the Stage 2 `validate_span_primitive` rejection reason (plan §123, §431, §619).
- `make_unsupported_residual_primitive(...)` — constructs an `UNSUPPORTED_RESIDUAL` `ConditionedTransitionPrimitive` with `residual_policy` populated, `subset_policy=None`, `compatibility_blend=None`, `probability_posterior=None`, `timing_posterior=None`, `draw_family_mode=MOMENTS_ONLY`. The Stage 1 contract enforces draw-family refusal (`probability_draws()` / `timing_draws()` raise `DrawFamilyUnavailable`).
- `make_structurally_deterministic_primitive(...)` — constructs a `STRUCTURALLY_DETERMINISTIC` primitive with a constant Beta-degenerate posterior (`mean=p`, `sd=0`, `draws = full(S, p)`) and a Dirac timing CDF (0.0 below `deterministic_shift_days`, 1.0 from there onward). `is_draw_coherent=True` because the constant draw family is well-defined; consumers can compose without a special-case branch.

### 1.2. Module discipline

`primitive_residual_guard.py` imports only `runner.primitives` (the Stage 1 contract types) and `numpy`. It has zero dependency on `forecast_runtime`, `forecast_state`, `cohort_forecast_v3`, `span_kernel`, `carrier_composition`, or `primitive_conditioning`. Static-import and static-source audits in the test file pin this; the same audits also verify the module contains no `1 - p` arithmetic on probability fields. The discipline mirrors Stages 1-3: a self-contained primitive-layer surface that Stage 5+ composers will call without dragging composition machinery back into the primitive layer.

### 1.3. Tests

[`graph-editor/lib/tests/test_primitive_residual_guard.py`](../../graph-editor/lib/tests/test_primitive_residual_guard.py) — 20 tests, all green. Coverage maps to plan §"Stage 4" stop condition (line 662):

| Test | Plan reference | Coverage |
|---|---|---|
| `test_parameterised_requirement_forwards_to_conditioning` | §572 | `PARAMETERISED` requirements forward to Stage 3 unchanged. |
| `test_no_evidence_parameterised_does_not_become_unsupported_residual` | §95-96, §572 | Empty evidence under `PARAMETERISED` is Stage 3's `PRIOR_ONLY` case; Stage 4's classifier never returns `UNSUPPORTED_RESIDUAL` for parameterised input. |
| `test_structurally_deterministic_with_explicit_p_emits_deterministic_primitive` | §99 | Decision routes to `STRUCTURALLY_DETERMINISTIC` and carries the explicit `deterministic_p`. |
| `test_structurally_deterministic_without_explicit_p_raises_value_error` | §99 | Determinism is never inferred from missing evidence — the call raises with a message naming the rule. |
| `test_structurally_deterministic_p_out_of_range_raises` | §99 | `deterministic_p` outside `[0, 1]` is rejected at classification time. |
| `test_unparameterised_residual_emits_unsupported_residual` | §97, §662 | `UNPARAMETERISED_RESIDUAL` → `UNSUPPORTED_RESIDUAL` with `residual_closure_required` populated. |
| `test_unparameterised_complement_emits_unsupported_residual_with_target` | §55, §97, §662 | `UNPARAMETERISED_COMPLEMENT` → `UNSUPPORTED_RESIDUAL` with `branch_complement_required` populated. |
| `test_adjacency_one_minus_p_rejected_for_parameterised_edge` | §55, §660 | A parameterised edge that requests sibling adjacency complement is rejected as `UNSUPPORTED_RESIDUAL`. |
| `test_prepared_span_rejected_emits_unsupported_residual` | §123, §431, §619 | A Stage 2 span rejection (cross-X or metadata mismatch) is surfaced as `UNSUPPORTED_RESIDUAL` with the original rejection reason. |
| `test_unsupported_residual_primitive_refuses_draws` | §591 | `probability_draws()` / `timing_draws()` raise `DrawFamilyUnavailable` (Stage 1 contract). |
| `test_unsupported_residual_primitive_carries_residual_policy_provenance` | §245 | `subset_policy` / `compatibility_blend` are None; `residual_policy` is the only populated slot. |
| `test_unsupported_residual_provenance_dict_contains_residual_policy_slot` | §245, §744 | `to_provenance_dict()` exposes the three policy slots independently. |
| `test_structurally_deterministic_primitive_serves_constant_draws` | §99 | Probability draws are a constant `full(S, p)` family with `sd=0`; `is_draw_coherent=True`. |
| `test_structurally_deterministic_primitive_with_shifted_dirac` | §83-87 | Dirac timing CDF jumps at `deterministic_shift_days`. |
| `test_structurally_deterministic_primitive_records_compat_fields_as_provenance` | §87, §583 | `mu`/`sigma`/`onset`/`t95` go on `structural_identity_compat`, not on the live timing parameters. |
| `test_structurally_deterministic_p_out_of_range_raises` | §99 | Out-of-range `deterministic_p` is rejected at construction time. |
| `test_supported_split_join_leakage_topology_classifies_as_parameterised` | §660, baseline §1.9 | Splits, joins, fan-in, fan-out, and side-exit leakage edges that are parameterised forward to Stage 3 — the guard does NOT re-classify them as residual just because of their graph role. |
| `test_no_one_minus_p_arithmetic_in_module_source` | §55, §660; baseline §1.9 | Static-source audit: no `1 - p` / `1.0 - p` / `1-p` arithmetic on probability fields appears in the module. |
| `test_module_does_not_import_composition_or_writeback` | §662; baseline §1.11 | Static-import audit: no imports from `forecast_runtime`, `forecast_state`, `cohort_forecast_v3`, `span_kernel`, `carrier_composition`, `primitive_conditioning`, or `UpdateManager`. |
| `test_module_imports_only_primitives_contract` | (discipline) | The only allowed runner-package import is `runner.primitives`. |
| `test_residual_guard_does_not_expose_sibling_rebalancer` | §662; baseline §1.11 | The module's `__all__` contains no name resembling `rebalance`, `sibling`, `writeback`, or `applyBatch` — Stage 4 must not smuggle FE writeback responsibilities into the primitive layer. |

### 1.4. What Stage 4 deliberately does NOT do

- **No live wiring.** `compute_forecast_trajectory`, `prepare_forecast_runtime_inputs`, `_resolve_frame_carrier_state`, `cohort_forecast_v3`, and the `XProvider` carrier path are unchanged. The new module is dormant until Stage 5+ wires it in (plan §391-399 migration choreography).
- **No residual derivation.** The guard never derives a residual probability, complement, or `1 - p` value. The static source audit pins this. CF composition continues to contain no `1 - p`, residual-sibling, or branch-complement code (baseline §1.9, §1.11).
- **No FE writeback ownership change.** `UpdateManager.applyBatchLAGValues` and `rebalanceSiblingEdges` remain the live owners of graph-surface sibling mass balancing after CF writes (baseline §1.11). The static-import + `__all__` audits pin that the residual guard cannot accidentally start owning that responsibility.
- **No determinism inference.** A `STRUCTURALLY_DETERMINISTIC` requirement without an explicit `deterministic_p` raises `ValueError`. The graph/schema must declare deterministic identity explicitly; the guard refuses to invent it from missing evidence (plan §99).
- **No prior-only re-routing.** A `PARAMETERISED` requirement with empty evidence still flows to Stage 3, which emits `PRIOR_ONLY` per Stage 3 §1.1.1. Stage 4's classifier never returns `UNSUPPORTED_RESIDUAL` for parameterised input (unless the composer separately sets `requires_adjacency_one_minus_p`, which is its own misuse).
- **No span geometry duplication.** Stage 2's `validate_span_primitive` already rejects spans that cross `X` or mix incompatible metadata. Stage 4 consumes that rejection signal via `EdgeRequirementKind.PREPARED_SPAN_REJECTED` and emits the corresponding `UNSUPPORTED_RESIDUAL` primitive; it does not re-validate geometry.

---

## 2. Stop-condition discharge

Plan §"Stage 4" stop condition (line 662):

> tests prove unsupported residual/complement requirements fail loudly or degrade with provenance, adjacency-only residual inference is rejected, no-evidence parameterised primitives remain prior-only rather than unsupported residuals, supported split/join/leakage topology continues through the shared DAG composer, no `1 - p` or proportional sibling rebalancing is performed inside CF composition, and CF graph writeback still routes through UpdateManager so existing sibling rebalancing remains outside the runtime model.

| Stop-condition clause | Discharge |
|---|---|
| Unsupported residual/complement requirements fail loudly or degrade with provenance | `test_unparameterised_residual_emits_unsupported_residual`, `test_unparameterised_complement_emits_unsupported_residual_with_target`, `test_unsupported_residual_primitive_refuses_draws` (refusal via `DrawFamilyUnavailable`), `test_unsupported_residual_primitive_carries_residual_policy_provenance` (named provenance slot). |
| Adjacency-only residual inference is rejected | `test_adjacency_one_minus_p_rejected_for_parameterised_edge` — `requires_adjacency_one_minus_p=True` produces `UNSUPPORTED_RESIDUAL` with the rejection reason citing plan §55, §660. |
| No-evidence parameterised primitives remain `PRIOR_ONLY`, not `UNSUPPORTED_RESIDUAL` | `test_no_evidence_parameterised_does_not_become_unsupported_residual` — Stage 4 forwards parameterised requirements to Stage 3 (which owns `PRIOR_ONLY`); the classifier never emits `UNSUPPORTED_RESIDUAL` for parameterised input. |
| Supported split/join/leakage topology continues through the shared DAG composer | `test_supported_split_join_leakage_topology_classifies_as_parameterised` — five graph roles (split-at-X, join-at-X, fan-out, fan-in, side-exit-leakage) classify as `PARAMETERISED` and forward to Stage 3 unchanged. The guard does not intercept them. |
| No `1 - p` or proportional sibling rebalancing inside CF composition | `test_no_one_minus_p_arithmetic_in_module_source` (AST-level static audit on the module's binary subtractions); the residual guard explicitly REFUSES the derivation rather than performing it. |
| CF graph writeback still routes through UpdateManager | `test_module_does_not_import_composition_or_writeback`, `test_residual_guard_does_not_expose_sibling_rebalancer` — neither `UpdateManager` nor any rebalancer surface appears in the module's imports or `__all__`. The Stage 4 surface has no path that could move FE writeback responsibilities into CF composition. |

---

## 3. Suggested commit messages (per atom)

The skill does not commit. The following commit messages are suggested for each atom; the user decides timing and granularity.

| Atom | Files | Suggested message |
|---|---|---|
| 1 | `graph-editor/lib/runner/primitive_residual_guard.py` | `73n stage 4: primitive_residual_guard module — classify edge requirements, emit UNSUPPORTED_RESIDUAL / STRUCTURALLY_DETERMINISTIC primitives (§654-662)` |
| 2 | `graph-editor/lib/tests/test_primitive_residual_guard.py` | `73n stage 4: residual-guard tests — adjacency-1−p rejection, residual/complement provenance, deterministic Dirac, no-1−p source audit, no composition/writeback imports (§"Stage 4" stop condition)` |
| 3 | `docs/current/project-bayes/73n-stage-4-note.md`, `docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md` | `73n stage 4: stage-4 note + mark stage 4 complete in progress block` |

---

## 4. What unblocks for later stages

- **Stage 5a (Single-Hop Window and Subject Cutover)** can now route every edge encountered along the single-hop subject closure through `classify_edge_requirement` before invoking `condition_primitive`. The `PARAMETERISED` happy path is unchanged from Stage 3; the `STRUCTURALLY_DETERMINISTIC` and `UNSUPPORTED_RESIDUAL` paths produce primitives whose `is_draw_coherent` flag tells the composer whether the consumer can build a draw-coherent window output or must surface degraded provenance.
- **Stage 5b (Multi-Hop Subject Span Composition)** consumes the same classifier per primitive on the subject span. A primitive on the span that classifies as `UNSUPPORTED_RESIDUAL` must collapse the composed result to degraded — the composed `subject_span(X → Z)` cannot ignore one missing primitive and pretend coherence (plan §"Stage 5b" reject-fallback rule, line 696).
- **Stage 5c (Multi-Hop Window Readout)** inherits the Stage 5b composition's degradation provenance; nothing extra to wire.
- **Stage 6 (Carrier Consumer)** consumes the classifier on the carrier closure too. The `PREPARED_SPAN_REJECTED` path is the seam that lets carrier composition fall back to edge primitives when a prepared span fails Stage 2's `validate_span_primitive` (plan §123, §619). The retirement of `_resolve_frame_carrier_state` / `build_upstream_carrier` (Stage 0a §1.3) lands here too — the carrier composer reads classified primitives from the registry, never from the legacy empirical Tier 2 / weak-prior path.
- **Stage 8 (Cross-Surface Projection and Provenance)** can roll the residual-policy slot from each registered primitive into the response provenance block: `to_provenance_dict()` already exposes `subset_policy`, `compatibility_blend`, and `residual_policy` as three named slots (plan §245). The Stage 4 tests pin this surface contract.

---

## 5. Open follow-ups (not Stage 4 blocking)

1. **No live composer is wired yet.** The `EdgeRequirement` shape will be populated by Stage 5a's window/subject cutover when it walks the carrier and subject closures. Until then, the only consumer is the test file. If Stage 5a discovers it needs an additional `EdgeRequirementKind` (e.g. for an explicit `OUT_OF_SCOPE` case), the enum extension should land at the start of that stage rather than be retro-fitted into Stage 4.
2. **No graph/schema reader for "structurally deterministic"** is provided yet. Stage 5+ composers will need to inspect the graph for the explicit identity flag (e.g. an `absorbing` failure node with explicit `outcome_type='deterministic'`) and produce the `EdgeRequirement(kind=STRUCTURALLY_DETERMINISTIC, deterministic_p=...)` themselves. The graph/schema is the source of truth; this module trusts the composer's classification.
3. **`graph_builder.apply_visibility_mode('e')`** at [`graph_builder.py:578`](../../graph-editor/lib/runner/graph_builder.py) performs evidence-mode complement fill on the *graph mutation* layer for the FE visibility filter. This is unchanged: it is a graph-mutation utility for the path-runner consumer, not part of CF primitive composition. The two surfaces should not be conflated; if a future regression tries to consume `apply_visibility_mode` from a CF runtime path, it should be classified through the residual guard instead.
