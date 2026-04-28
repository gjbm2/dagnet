# 73h — Shared evidence merge design for BE CF and Bayes

**Status**: Draft design  
**Date opened**: 28-Apr-26  
**Parent investigation**: [`73f-outside-in-cohort-engine-investigation.md`](73f-outside-in-cohort-engine-investigation.md)  
**Semantic source**: [`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md)  

## Purpose

This note designs the shared evidence merge layer needed by both the BE conditioned forecast path and the Bayes compiler.

The immediate trigger is the Q4 investigation on `synth-lat4`:

- Query: `from(synth-lat4-c).to(synth-lat4-d).cohort(synth-lat4-b,-90d:)`
- Current WP8-off rate-conditioning role: use `window(C -> D)` as the subject helper for `p`
- Snapshot-selected window evidence: `n=26206`, `k=13740`
- File-backed uncovered `window(C -> D)` evidence candidate: `n=27976`, `k=18680`
- Current response evidence before fixing this layer: `n=71224`, `k=41700`

The response total is explained by an invalid supplement: the current helper admits multiple bare `cohort(...)` file slices and adds them after conditioning. That is not a valid evidence object for the current role.

The design goal is one canonical object, **E**, built once and consumed consistently:

- E conditions the forecast, or is transformed into an explicit effective evidence object
- E is reported as the BE CF response `evidence_n` / `evidence_k`
- E is what CF writes to graph L4 `p.evidence.{n,k}`
- E is built by the same library in BE CF and Bayes

## Non-Negotiable Semantics

The displayed rate is always `Y / X`, not `Y / A`.

For `cohort(A, X -> Y)`, the runtime has two separate roles:

- `carrier_to_x`: denominator-side object answering who reaches `X`
- `subject_span`: numerator-side object answering how mass at `X` reaches `Y`

The evidence merge layer must preserve that split. It must not let anchor-rooted cohort data silently stand in for `X -> Y` subject-helper evidence unless an explicit admission policy says it may.

Raw rows are stricter than subject-side model vars. A `cohort(A, X -> Y)` row and a `window(X -> Y)` row are on different clocks. They are not interchangeable just because they share the same target edge.

## Definitions

### Global Source Evidence

Global source evidence is the large evidence set used to fit aggregate model vars and priors. It may include broad file and snapshot histories and does not represent the current query scope.

This evidence belongs to model-var production, not to BE CF’s current answer layer.

### Scoped Evidence E

E is the raw observed evidence for a specific semantic role in a specific query scope.

E is built from:

- snapshot rows selected by the correct hash family, regime, slice, context, as-at boundary, and date bounds
- file-backed rows from parameter-file evidence or request-graph engorgement
- a deterministic deduplication rule that prefers snapshot rows over file rows for covered cohort days

E is raw evidence. It is not a blended forecast and not a carrier projection.

### Effective Evidence e

e is optional. It exists only if E is transformed for conditioning, for example by half-life weighting or effective-mass scaling.

If e differs from E, the difference must be explicit in the returned object:

- raw E totals
- effective e totals
- weighting policy
- provenance of the transformation

Decision for the current BE CF work: **e equals E**. BE CF should
condition directly on the canonical raw scoped evidence until a separate
weighting policy is explicitly designed, implemented, and surfaced.

## Evidence Roles

The shared library must take an explicit evidence role. It must not infer role from a broad string test such as “contains `cohort(`”.

### `window_subject_helper`

This is the current WP8-off role for conditioning `p` in `cohort(A, X -> Y)`.

The subject rate remains `X -> Y`, and direct anchor-rooted cohort evidence is not yet admitted for rate conditioning. Therefore the file evidence family must be `window(X -> Y)`.

For the Q4 `synth-lat4` query, this means:

- include the `window(C -> D)` file slice
- include the window-regime snapshot rows for `C -> D`
- do not include `cohort(A -> C -> D)` or `cohort(B -> C -> D)` file slices

### `direct_cohort_exact_subject`

This is the future WP8 role. It is not part of the immediate WP8-off fix,
but the shared merge design must accommodate it because doc 60 WP8 is the
next expected rate-conditioning extension.

It may use direct `cohort(A, X -> Y)` evidence only when the admission policy says the external object is the same semantic question:

- same mode
- same anchor / time origin
- same denominator `X`
- same subject end and full subject span
- same slice, context, and as-at
- same selected cohort set
- same temporal evidence basis and aggregation procedure

This role must not be enabled implicitly by the presence of cohort file rows.
It should be selected only by an explicit runtime flag/admission-policy
decision.

### `bayes_phase1_window`

Bayes Phase 1 fits per-edge window-family probability and latency.

This role should use window evidence for the edge. Cohort file slices must not be mixed into Phase 1 probability evidence.

### `bayes_phase2_cohort`

Bayes Phase 2 uses cohort observations under its own modelling rules.

This is not the same role as BE CF's `direct_cohort_exact_subject`.
Bayes nomenclature is:

- Phase 1 fits from window observations
- Phase 2 uses Phase 1 posterior-as-prior and fits from cohort observations
- cohort trajectories are emitted as trajectory potentials
- in Phase 2, cohort daily observations are native Beta-Binomial evidence
  only for first-edge cases where the edge denominator and cohort anchor
  coincide
- downstream cohort observations are handled through the cohort/path
  trajectory machinery, not as unrestricted per-edge daily Beta-Binomial
  observations

The shared merge library must therefore supply cohort observations in a
role-labelled form. The Bayes model remains responsible for deciding which
cohort observations feed trajectory potentials versus native daily
likelihoods.

## Shared Library Contract

The shared library should live in `graph-editor/lib`, as the current `file_evidence_supplement.py` already does, because both the Python backend and the Bayes compiler can import from that location.

It should replace the current helper with a role-aware merge boundary.

Inputs:

| Input | Meaning |
|---|---|
| Evidence role | One of the explicit roles above |
| Snapshot rows | Already queryable rows from the snapshot DB, before or after regime selection depending on caller boundary |
| File evidence entries | Parameter-file `values[]` or engorged `_bayes_evidence` entries |
| Date bounds | Anchor and sweep limits for the query |
| Subject metadata | Anchor, subject start `X`, subject end, mode, as-at |
| Slice metadata | Slice keys, context, case, and regime metadata available to caller |

Outputs:

| Output | Meaning |
|---|---|
| Raw E totals | `n`, `k`, and `mean` for the canonical scoped evidence |
| Per-day E rows | Included day-level rows with source provenance |
| Snapshot totals | Contribution from snapshot rows |
| File totals | Contribution from file rows |
| Covered days | Anchor days for which snapshot evidence won |
| Skipped file entries | Rows rejected with explicit reasons |
| Role metadata | Evidence role and semantic assumptions used |
| Optional effective evidence | Present only when weighting or effective-mass transformation is applied |
| Provenance summary | Included rows, skipped rows, and skip reasons. Required immediately for tests and diagnostics, even if not all fields are persisted to graph state. |

The library should be pure. It should not query the database and should not read files. Callers supply candidate snapshot rows and file entries.

## Merge Algorithm

### Step 1 — Select Snapshot Rows For The Role

Snapshot rows must already be limited to the relevant edge and query period. The merge library should still validate that each row belongs to a slice family compatible with the role.

For `window_subject_helper`, snapshot rows must be window-family rows for the subject `X -> end`.

For `direct_cohort_exact_subject`, snapshot rows must be cohort-family rows for the exact anchor and subject.

Rows from incompatible families should be skipped with reasons, not silently used.

### Step 2 — Collapse Snapshot Rows By Logical Day

Within the selected role, snapshot evidence wins over file evidence because it is richer.

The logical deduplication key should include:

- anchor day
- normalised slice family
- context / case identity where applicable
- selected regime identity where applicable

For a given key, select the latest valid retrieval at or before the query’s as-at boundary.

If multiple hashes produce identical logical observations through equivalence mappings, count the observation once.

### Step 3 — Select File Entries For The Same Role

File entries must be filtered by the same evidence role.

For `window_subject_helper`, include only window-family file evidence for the subject edge.

For `direct_cohort_exact_subject`, include only the exact matching cohort anchor.

For Bayes Phase 2 roles, include only cohort evidence families appropriate
to the Bayes observation role. The merge library should not decide whether
a cohort observation becomes a trajectory potential or a native daily
likelihood; it should preserve enough typed provenance for `model.py` to
make that decision.

The current rule, “all bare `cohort(...)` daily points,” must be retired. It admits multiple anchor-rooted cohort objects for the same edge and double-counts them.

### Step 4 — Supplement Only Uncovered Days

File rows supplement only anchor days not covered by selected snapshot rows.

If a file row and a snapshot row share the same role-compatible logical day, the file row is skipped as `covered_by_snapshot`.

If a file row is from the wrong evidence role, skip it as `wrong_role`.

If a file row is context-qualified but the role does not support that context, skip it as `unsupported_context`.

### Step 5 — Return E And Provenance

The merged evidence object must expose enough detail to audit the result:

- total raw E
- snapshot component
- file component
- included day count
- skipped row counts by reason
- selected role

This is the object that BE CF reports as `evidence_n` / `evidence_k`.
It must also expose provenance for tests. Minimum provenance fields:

- included snapshot days
- included file days
- skipped file rows by reason
- selected evidence role
- selected file slice families
- selected snapshot families

## Q4 Worked Example

For `from(C).to(D).cohort(B,-90d:)` under WP8-off:

Correct role is `window_subject_helper`.

Observed inputs:

| Source | Role | n | k | Note |
|---|---:|---:|---:|---|
| Snapshot window rows | `window_subject_helper` | 26206 | 13740 | latest snapshot rows for covered days |
| File `window(...)` uncovered days | `window_subject_helper` | 27976 | 18680 | valid supplement candidate |
| File `cohort(A,...)` uncovered days | wrong role | 27976 | 18680 | must be skipped |
| File `cohort(B,...)` uncovered days | wrong role under WP8-off | 30287 | 20030 | must be skipped |

Candidate E for current WP8-off behaviour:

| Total | n | k | mean |
|---|---:|---:|---:|
| Snapshot window + file window uncovered | 54182 | 32420 | 0.5983 |

Current erroneous response:

| Source | n | k |
|---|---:|---:|
| Row/display evidence | about 12960 | about 2990 |
| Wrong file supplement from both cohort slices | 58263 | 38710 |
| Response total | 71224 | 41700 |

The current response is not a valid E object for either `window_subject_helper` or `direct_cohort_exact_subject`.

## BE CF Integration

The BE CF path should change from “row-builder result plus endpoint supplement” to “merged E first.”

Target sequence:

1. Resolve forecast subject and role.
2. Query snapshot rows.
3. Gather file evidence entries from the request graph.
4. Call the shared merge library to build E.
5. Build `CohortEvidence.evidence_n/evidence_k` from E.
6. Run conditioning.
7. Return `evidence_n/evidence_k` from E.
8. Remove response-time file supplement logic.

`compute_cohort_maturity_rows_v3` may still produce chart-row evidence for display. That is not the same as response L4 evidence and should not be copied into `evidence_n/k`.

## Bayes Integration

Bayes already has most of the architecture:

- snapshot rows are bound first
- snapshot rows are grouped and deduped
- file rows supplement uncovered days
- context and MECE aggregation are handled carefully

But Bayes currently calls the same file supplement helper that admits all bare cohort daily points.

Bayes should use the shared merge library with a role chosen from phase and
model context:

- Phase 1 probability and latency: `bayes_phase1_window`
- Phase 2 cohort likelihoods: `bayes_phase2_cohort`

This keeps Bayes and BE CF aligned without forcing them to use the same
evidence role.

The design must preserve Bayes' existing nomenclature:

- `window` observations constrain Phase 1 edge-level p/latency
- `cohort` observations constrain Phase 2 cohort/path behaviour under
  posterior-as-prior
- cohort trajectories and cohort daily observations are different
  observation shapes
- Phase 2 cohort daily observations are only native daily likelihood
  evidence for first-edge cases; deeper cohort observations must not be
  silently treated as unrestricted per-edge daily Beta-Binomial evidence

## Test Plan

Tests must be written against the shared library first.

### Unit / Contract Tests For The Shared Library

1. Snapshot rows cover days 3–5 and file rows cover days 1–5. E includes file days 1–2 and snapshot days 3–5.
2. File entries contain `window`, `cohort(A)`, and `cohort(B)`. Role `window_subject_helper` includes only the window file entry.
3. Role `direct_cohort_exact_subject` with anchor B includes only `cohort(B)` and skips `cohort(A)`.
4. Duplicate snapshot rows from equivalent hashes count once.
5. Context rows are skipped unless the role explicitly supports context and the context is compatible.
6. Skipped rows report reasons.
7. Q4 fixture contract: merged E under WP8-off is snapshot window covered plus file window uncovered, not both cohort anchors.

### BE CF Integration Tests

1. BE CF response `evidence_n/k` equals merged E.
2. Runtime `p_conditioning_evidence.total_x/y` equals merged E or documented effective e.
3. BE CF provenance identifies which file slice family and snapshot family
   contributed to E.
4. If e differs from E in future, response contains both raw E and effective e metadata.
5. For Q4, CF response no longer reports `71224/41700`.

### Bayes Binder Tests

1. Phase 1 does not supplement cohort slices into window evidence.
2. Phase 2 emits cohort observations under the explicit
   `bayes_phase2_cohort` role.
3. First-edge cohort daily observations remain eligible for native daily
   likelihoods.
4. Downstream cohort observations remain trajectory/path observations and
   are not silently promoted into unrestricted per-edge daily likelihoods.
5. Existing MECE/context aggregation behaviour remains unchanged.

## Migration Plan

1. Introduce the shared merge library and tests.
2. Replace `iter_uncovered_bare_cohort_daily_points` usage in BE CF response supplement with the shared library.
3. Move BE CF file supplement before conditioning.
4. Emit E from the merged evidence object.
5. Replace Bayes `_supplement_from_param_file` helper usage with the shared library.
6. Remove or deprecate the old helper once both call sites are migrated.
7. Update doc 60 Appendix A with a pointer that `direct_cohort_exact_subject`
   is an explicitly supported future evidence role for WP8, but remains
   disabled until the WP8 flag/admission path lands.

## Open Questions

1. Which provenance fields should be response-visible versus test-only?
2. Should the first implementation expose provenance under the existing
   `conditioning` block or a new `evidence_provenance` block?
