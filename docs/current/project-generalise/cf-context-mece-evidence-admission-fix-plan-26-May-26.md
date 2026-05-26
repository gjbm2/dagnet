# CF Context / MECE Evidence Admission Fix Plan

**Date:** 26-May-26  
**Status:** Draft for review  
**Scope:** BE conditioned-forecast evidence admission for context-qualified and MECE snapshot rows.  
**Primary failure surfaced by:** `graph-editor/lib/tests/test_asat_blind.py::TestAsatMixedEpoch::test_t8_context_qualified_asat_in_epoch2`

## Implementation progress

<!-- managed by /implement-carefully — edit checkboxes manually only when the skill is not running -->

- [ ] Stage 1 — Model Context As Evidence Metadata
- [ ] Stage 2 — Extract A Shared Context / Slice Classifier
- [ ] Stage 3 — Port Bayes MECE Admission Semantics To `EvidenceSet`
- [ ] Stage 4 — Thread Context Scope From FE Request To Primitive Binding
- [ ] Stage 5 — Replace Blanket `unsupported_context`
- [ ] Stage 6 — Align Candidate-Regime Filtering With Admission
- [ ] Stage 7 — Preserve The Single Evidence Pool
- [ ] Stage 8 — Tests And Test Repairs

## Executive Summary

The BE conditioned-forecast path is receiving context-qualified snapshot rows, but the primitive evidence admission boundary does not model context as an orthogonal evidence identity axis. It currently treats `context(...).window(...)` as a separate `CONTEXT` family instead of a `WINDOW` row with context metadata. The merge layer then rejects that family as `unsupported_context`.

This is not a failure of FE context slicing or snapshot regime selection. The FE builds candidate regimes and MECE dimensions; the BE preparation layer fetches and selects snapshot rows. The failure is at the handoff from prepared snapshot rows into primitive evidence candidates.

The complete fix is to carry context identity through the evidence scope and candidate identity, classify rows by temporal family first, and make context admission explicit in `evidence_merge`. The fix must not add a parallel context path or patch CF writeback. It must preserve the single evidence-pool invariant.

Important: this is not a greenfield design problem. The Bayes snapshot evidence binder already contains the working semantic pattern for context and MECE snapshot rows. The CF fix should port/reuse that model into the shared primitive evidence path rather than inventing a second policy.

## What Triggered This

The visible regression appeared after CF began writing `evidence_n` / `evidence_k` back to graph L4 evidence. Before that change, FE/from-file evidence could remain visible even when BE CF had not admitted the same evidence. The writeback change made an existing BE evidence-admission gap observable.

For the failing asat case:

- The query asks for `context(synth-channel:google).window(...).asat(...)`.
- FE/from-file evidence is non-zero.
- BE `conditioned_forecast` returns `conditioned=true` but `evidence_n=0`, `evidence_k=0`.
- CF primitive diagnostics show context-qualified rows skipped as `unsupported_context`.

The key correction from the investigation is that the primitive conditioner is not the culprit. The conditioner consumes whatever the primitive evidence binding admits. The defect is in the perimeter between BE preparation and primitive binding.

## Related But Separate Sample-File Issue

`sampleFileQueryFlow.e2e.test.ts` exposed a separate fake-fixture problem: a sample file had inconsistent header totals and daily rows. The test expected header `k=265`, while the daily rows summed to `k=245`. Once later evidence writes re-derived `evidence.mean` from `n/k`, the mismatch surfaced.

That sample-file issue is not the same as the context/MECE admission defect. It is a fixture consistency issue and has already been addressed by making the daily rows sum to the declared header total.

## Existing Intended Contract

The designed context and MECE mechanism already exists at the request and preparation layers.

The FE side:

- Builds per-edge candidate regimes from the graph's pinned DSL and stored slice topology.
- Computes context key sets and MECE dimensions.
- Filters candidate regimes by scenario effective DSL.
- Sends `candidate_regimes_by_edge` and `mece_dimensions` to the BE.

The BE preparation side:

- Resolves snapshot subjects from DSL and candidate regimes.
- Queries rows across candidate hash families.
- Applies temporal regime selection so one regime wins per retrieval date.
- Hands selected rows forward as `evidence_superset_rows`.

The semantic contract from `HASH_SIGNATURE_INFRASTRUCTURE.md` and doc 30 is:

- Context dimension is represented at the hash level.
- Context value is represented in `slice_key`.
- Context is not a temporal mode.
- `window()` and `cohort()` define temporal population semantics.
- MECE aggregation is allowed only when the selected context dimensions are known safe to aggregate.

## Bayes Binder As Existing Reference Implementation

`bayes/compiler/evidence.py` already implements the correct mental model for snapshot context rows in `_bind_from_snapshot_rows`.

Bayes does **not** treat context as a family alongside window/cohort. It:

- classifies rows by temporal family with `_is_window(slice_key)` / `_is_cohort(slice_key)`;
- separately detects `is_ctx = "context(" in slice_key`;
- uses `context_key(slice_key)` and `dimension_key(...)` to identify the context axis;
- uses `mece_dimensions` to decide whether context rows can be aggregated;
- aggregates MECE context rows into bare `window()` / `cohort()` aggregate observations;
- skips non-MECE context rows from aggregate evidence;
- guards against summing multiple independent MECE dimensions into an inflated aggregate;
- uses `regime_per_date` to decide whether a date's data belongs in aggregate observations or per-context slice likelihoods;
- retains per-context observations for commissioned slices via `SliceGroup`s.

The adversarial Bayes tests already pin this behaviour. In particular, `bayes/tests/test_evidence_binding_adversarial.py` covers:

- MECE context rows summing correctly;
- bare aggregate rows taking precedence over context rows;
- non-MECE context rows being skipped from aggregate evidence;
- regime-per-date partitioning;
- context-prefixed window rows being classified as window observations.

This is the strongest evidence that the CF primitive admission layer is the outlier. CF should reuse the Bayes binder's classification and admission semantics at the shared `EvidenceCandidate` / `EvidenceSet` boundary. Bayes's output objects are Bayes-specific (`EdgeEvidence`, `CohortObservation`, trajectories, `SliceGroup`s), so CF should not call `_bind_from_snapshot_rows` directly. The reusable part is the row classification and context/MECE admission policy.

## Actual Break

The handoff into primitive evidence currently loses or misrepresents context.

Observed code-shape issues:

- `edge_binding_descriptor._evidence_scope_for` builds `EvidenceScope` without context metadata.
- `primitive_readout._per_primitive_evidence_scope` also rebuilds `EvidenceScope` without context metadata.
- `cohort_forecast_v3._runtime_scope` hardcodes `context_key=None`.
- `request_envelope.py` builds prefix identities with `context_key=None`.
- `evidence_adapters._classify_slice_key` checks for `context(` before checking `window(` or `cohort(`, so `context(...).window(...)` becomes `SliceFamily.CONTEXT`.
- `evidence_merge._validate_candidate` rejects `SliceFamily.CONTEXT` as `unsupported_context`.

That means a row whose real identity is "window evidence for channel=google" is represented as "unsupported context evidence". The merge layer never reaches the normal role/family checks for `WINDOW`.

## Correct Model

Evidence identity must separate temporal family from context identity.

For a row like `context(channel:google).window(...)`, the candidate should carry:

- temporal family: `window`
- context selector: `channel=google`
- evidence role: usually `window_subject_helper` in the current WP8-off CF path
- subject span: source node and destination node
- regime identity: selected hash family / equivalent family where applicable
- as-at boundary and retrieval metadata

It must not carry:

- temporal family: `context`

Context is an axis of identity and admission, not a family alongside `window` and `cohort`.

## Design Principles For The Fix

1. **No parallel context path.** Contexted evidence must enter the same candidate pool and merge path as all other evidence.

2. **Perimeter validation only.** Schema parsing, context extraction, and row refusal belong in adapters / merge boundaries, not inside engine math.

3. **One canonical E.** The raw scoped evidence object E is the thing that conditions CF, is reported as `evidence_n/k`, and is written back to graph L4 evidence.

4. **Role and context are both identity.** Cache keys, primitive scope, evidence scope, and provenance must distinguish requests that differ by context where that context slices evidence or priors.

5. **MECE aggregation is explicit.** Uncontexted queries may aggregate context rows only when the FE-selected regime and `mece_dimensions` say the aggregation is safe.

6. **Projection does not repair admission.** If evidence is not admitted at the primitive boundary, row projection and CF writeback must not synthesise replacement counts from another clock or layer.

## Proposed Implementation Scope

### Stage 1 — Model Context As Evidence Metadata

Update the shared evidence-admission data model so context is carried independently of temporal family, using Bayes `_bind_from_snapshot_rows` as the behavioural oracle.

The likely changes:

- Extend `EvidenceScope` / `EvidenceIdentity` to carry enough context selector information to distinguish exact context matches from uncontexted and MECE aggregate scopes.
- Replace the current `SliceFamily.CONTEXT` interpretation for admissible rows.
- Keep `SliceFamily.WINDOW` and `SliceFamily.COHORT` as the temporal family axis.
- Retain a refusal path for truly unsupported context shapes, but do not use it for exact `context(k:v).window(...)` or `context(k:v).cohort(...)`.

Review point: whether `context_key` is sufficient, or whether the evidence identity must carry key/value pairs. The current failure strongly suggests key-only is not enough for exact context-value admission, because all values in one MECE dimension share the same hash and differ at the `slice_key` level. Bayes currently uses canonical strings like `context(channel:google)` as the slice identity for `SliceGroup`s; that is a strong candidate representation for shared evidence identity as well.

### Stage 2 — Extract A Shared Context / Slice Classifier

Extract or duplicate-with-tests the Bayes binder's slice parsing rules into a shared helper used by CF evidence adapters. The helper should parse:

- temporal family
- context constraints
- cohort anchor when applicable
- case constraints if relevant

The helper should classify temporal family by the presence of `window()` or `cohort()` first, and attach context metadata separately. It should match Bayes behaviour for `context(...).window(...)` and `context(...).cohort(...)`.

For malformed or unsupported rows:

- Skip with explicit provenance.
- Do not coerce missing context to uncontexted.
- Do not silently downgrade contexted rows to bare rows.

### Stage 3 — Port Bayes MECE Admission Semantics To `EvidenceSet`

Extend `evidence_merge` so the shared `EvidenceSet` can express the same admission choices Bayes already makes:

- exact context rows for exact context scopes;
- MECE context-row aggregation for aggregate scopes;
- bare aggregate precedence when both bare and context rows exist;
- non-MECE context refusal;
- cross-dimension aggregate guard;
- regime-per-date aggregate vs per-slice routing.

This stage should be implemented against tests that compare the shared merge output to Bayes binder expectations for equivalent rows. The target is not to return Bayes objects; it is to produce the same raw E totals and skip/admission reasons for the same semantic scope.

### Stage 4 — Thread Context Scope From FE Request To Primitive Binding

Carry the request's effective context constraints through:

- FE prepared scenario payload
- BE subject resolution and forecast preparation
- per-edge binding descriptors
- primitive scope
- prefix-arrival identity
- evidence scope built inside primitive readout

The context values should come from the scenario effective DSL, not from graph-level pinned DSL, and not from accidental row content. Graph-level pinned DSL informs candidate-regime discovery; scenario effective DSL defines the current query scope.

### Stage 5 — Replace Blanket `unsupported_context`

Replace the blanket rejection of context-qualified rows with compatibility rules:

- Exact context query admits matching context rows.
- Exact context query rejects wrong values or wrong dimensions.
- Bare query admits bare rows directly.
- Bare query may aggregate context rows only through an explicitly selected MECE regime.
- Superset context regimes may be reduced only when extra dimensions are MECE and the requested context values match.
- Non-MECE or ambiguous context rows are refused with clear skip reasons.

This stage should also tighten provenance so diagnostics can distinguish:

- exact context admission
- context mismatch
- unsafe MECE aggregation
- unsupported context shape

### Stage 6 — Align Candidate-Regime Filtering With Admission

Review `candidateRegimeService.filterCandidatesByContext`.

The current doc says a scenario with no context keeps only bare regimes. But mixed-epoch and MECE-summed aggregate behaviour requires careful fallback semantics. The FE must send plausible candidate regimes ordered by closeness, and the BE must select the actual available regime per date.

The plan should confirm:

- Explicit context query prefers exact key set.
- Superset regimes are allowed only when reducible.
- Bare fallback is allowed only when it answers the requested query or when degradation is explicit.
- Full-inventory fallback does not reintroduce unsafe regimes after filtering returns empty.

This stage is about making FE candidate ordering match the BE admission rules, not duplicating DB availability checks in the FE.

### Stage 7 — Preserve The Single Evidence Pool

Ensure `build_superset_candidates_by_edge`, `_aggregate_request_candidates`, and `build_resolved_cf_runtime` continue to produce one canonical `runtime.request_evidence_candidates` pool.

No extra context-specific branch should be added in:

- row projection
- `applyConditionedForecastToGraph`
- `condition_primitive`
- selected-Cohort reducer
- CF scalar response construction

The conditioner should see admitted evidence through the existing primitive evidence resolution path.

### Stage 8 — Tests And Test Repairs

Write failing tests before production changes.

Required test categories:

- Shared classifier tests mirroring Bayes: `context(...).window(...)` is temporal family `window`; `context(...).cohort(...)` is temporal family `cohort`.
- Adapter test proving `context(...).window(...)` is temporal family `window` with context metadata.
- Adapter test proving `context(...).cohort(...)` is temporal family `cohort` with context metadata.
- Merge test proving an exact context query admits matching rows.
- Merge test proving wrong context value is rejected.
- Merge test proving uncontexted MECE aggregation admits rows only when the dimension is MECE.
- Merge test proving non-MECE aggregation refuses rows.
- Shared merge vs Bayes oracle tests for MECE rows, bare precedence, non-MECE skip, cross-dimension guard, and regime-per-date partitioning.
- BE CF integration test for `synth-context-solo-mixed` context-qualified asat query returning non-zero evidence and provenance.
- Outside-in targeted test: `test_asat_blind.py::TestAsatMixedEpoch::test_t8_context_qualified_asat_in_epoch2`.

Existing tests that expect `unsupported_context` must be reviewed. Some are pinning the current wrong model. They should be rewritten to express the actual intended policy:

- unsupported only when context is not compatible with the evidence scope
- not unsupported merely because a row is context-qualified

## Non-Goals

- Do not implement WP8 direct cohort rate conditioning as part of this fix.
- Do not change the CF evidence writeback mapping.
- Do not patch `test_asat_blind.py` to avoid context rows.
- Do not add a graph-side evidence fallback inside CF.
- Do not make the BE infer MECE completeness from DB rows.
- Do not alter the core hash model.
- Do not touch chart display-layer epoch gating.

## Expected Blast Radius

Code likely touched:

- `bayes/compiler/evidence.py` only if extracting a helper; otherwise use as read-only oracle.
- `graph-editor/lib/evidence_merge.py`
- `graph-editor/lib/runner/evidence_adapters.py`
- `graph-editor/lib/runner/edge_binding_descriptor.py`
- `graph-editor/lib/runner/primitive_readout.py`
- `graph-editor/lib/runner/primitives.py`
- `graph-editor/lib/runner/prefix_arrival.py`
- `graph-editor/lib/runner/request_envelope.py`
- `graph-editor/lib/runner/forecast_preparation.py`
- `graph-editor/lib/analysis_subject_resolution.py`
- `graph-editor/src/services/candidateRegimeService.ts`

Tests likely touched:

- `bayes/tests/test_evidence_binding_adversarial.py` should remain green and serve as oracle coverage.
- `graph-editor/lib/tests/test_evidence_adapters.py`
- `graph-editor/lib/tests/test_evidence_merge.py`
- `graph-editor/lib/tests/test_primitive_evidence.py`
- `graph-editor/lib/tests/test_conditioned_forecast_response_contract.py`
- `graph-editor/lib/tests/test_asat_blind.py`
- `graph-editor/src/services/__tests__/candidateRegimeService.test.ts` if present or a new adjacent test if not

## Acceptance Criteria

The fix is complete only when:

- Context-qualified `window` rows are admitted as window-family evidence when the request asks for that exact context.
- Context-qualified `cohort` rows are represented as cohort-family evidence with context metadata.
- Uncontexted queries cannot accidentally consume a context slice unless an explicit MECE aggregate path selected it.
- For equivalent input rows, shared CF evidence admission produces raw E totals matching the Bayes binder's documented context/MECE behaviour.
- The BE CF response for the failing context-qualified asat query returns non-zero `evidence_n/k`.
- CF response provenance names admitted context evidence rather than reporting only `unsupported_context`.
- The targeted failing asat test passes without weakening its assertion.
- Existing uncontexted and bare-window CF tests still pass.

## Review Questions

1. Should evidence identity carry full context key/value pairs, or a canonical context selector string, rather than only `context_key`?

2. How should `contextAny(...)` be represented in primitive evidence identity?

3. Should exact context queries allow bare fallback if no context rows exist, or should that be a visible degradation? Current FE/from-file has some fallback behaviour, but CF evidence admission should probably be stricter.

4. For uncontexted queries over contexted regimes, should primitive evidence receive already-aggregated rows from the preparation layer, or should the merge layer aggregate candidate rows itself using MECE metadata?

5. Should the existing `unsupported_context` skip reason be retained only for context shapes outside the implemented contract, or split into narrower reasons such as `context_mismatch` and `unsafe_mece_aggregation`?

6. Should the Bayes binder's context aggregation logic be extracted into shared helpers now, or should CF first port the semantics behind shared tests and extract only once both paths are aligned?

## Proposed Next Step

Before implementation, agree the representation for context identity in `EvidenceScope` and `EvidenceIdentity`, using Bayes's `context(channel:value)` slice identity as the baseline candidate. Then write shared merge tests that reproduce Bayes binder behaviour before changing CF production code. After that, thread scope through the BE CF path and run the outside-in asat test.
