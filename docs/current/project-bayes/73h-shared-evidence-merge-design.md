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

Minimum provenance for `bayes_phase2_cohort` candidates must include:

- cohort anchor identity and anchor node
- cohort specification DSL or equivalent normalised cohort selector
- subject edge id and subject span
- edge depth from the cohort anchor, with the first edge marked
  unambiguously
- path prefix from anchor to the subject edge, or an equivalent path
  identity
- observation temporal basis, especially whether the observed day is an
  anchor day or an edge-local window day
- population identity for the selected cohort set

That provenance is required because the merge library cannot decide the
Bayes likelihood shape by looking at `n/k` alone. `model.py` must be able to
distinguish first-edge cohort daily observations from downstream cohort/path
trajectory observations without re-parsing lossy slice strings.

## First-Principles Generalisation

The previous partial wiring is not a complete solution. It moved some
file-supplement logic earlier and made it role-aware in a narrow sense, but
it still treats evidence as loose `(age, n, k)` tuples threaded through
scenario-specific code. That is not enough for multi-scenario correctness,
as-at correctness, or Bayes/BE parity.

The proper abstraction is not "a helper that adds file rows." The proper
abstraction is:

> for one evidence role, one scenario identity, one subject identity, and one
> as-at boundary, build the canonical observed evidence set E from typed
> candidates, then derive any effective evidence e explicitly from E.

Everything else follows from that.

### Identity And Observation Coordinates Before Counts

Evidence counts are only meaningful when their identity is fixed. The shared
library must therefore represent identity and observation coordinates
explicitly before summing `n/k`.

These are separate concepts.

`EvidenceIdentity` answers: "what evidence object would these rows belong
to if they were compatible?" It is the summability identity. It must include
at least:

- evidence role
- edge / subject span: source `X`, destination `Y`, and mode if relevant
- cohort anchor / origin where the role is cohort-family
- context / case / scenario identity, or an explicit marker that context is
  unsupported for this role
- regime / slice family identity where available
- population identity where the role depends on the selected cohort set

`ObservationCoordinate` answers: "which observation of that evidence object
is this?" It must include at least:

- observed date on the correct clock
- retrieval/source timestamp
- temporal basis used by that source, for example window day versus anchor
  day
- source freshness/admission metadata, including whether the candidate was
  already materialised at the requested as-at boundary

Two rows may be summed only if their identities are compatible. Two rows may
be deduped only if they share the same observed-date coordinate under the
same identity. `retrieved_at` is a version/admission coordinate: it decides
which candidate is the latest valid observation, not whether two rows are
semantically summable. The date is therefore not part of `EvidenceIdentity`;
it is the coordinate the merge iterates over.

### Scenario Scope Is Part Of E

Multi-scenario correctness requires E to be scoped per scenario. The merge
library must not accept ambient process state or caller globals. It receives a
single `EvidenceScope` and produces one `EvidenceSet`.

`EvidenceScope` must describe:

- scenario id / request id if available
- role
- subject span
- cohort anchor when applicable
- date bounds for the evidence window
- as-at boundary
- context / case constraints
- regime constraints
- snapshot coverage policy

If a request has multiple scenario dates, contexts, or as-at scopes, callers
must call the library once per scope. Reusing one E across scenarios is a
defect unless the scopes are proven identical and the admitted candidates
share the same identities and observation coordinates.

### Population Identity

`population_key` is load-bearing for future `direct_cohort_exact_subject`
admission, so it must not remain an undefined placeholder.

For roles where the selected cohort set matters, `population_identity`
should be a deterministic key for the selected population before counts are
summed. It is not `n`, and it is not inferred from `k/n`.

For direct cohort roles, the key must be derived from:

- query mode and evidence role
- anchor node / time origin
- denominator node `X` and full subject span
- cohort date bounds and the sorted selected anchor-day set
- context / case constraints
- regime or hash-family identity used to select rows
- as-at boundary
- population universe key if the source can provide one

If member-level population hashes are unavailable, the fallback key is a
canonical selector hash over the items above. That fallback proves only that
the same cohort selector was used, not that two external systems observed
identical member IDs. The admission policy must surface that distinction in
provenance.

For `window_subject_helper`, direct cohort rows are rejected by role before
this key becomes decisive. For `direct_cohort_exact_subject`, equality of
`population_identity` is required; matching anchor text or matching date
bounds alone is insufficient.

### Snapshot And File Are Candidate Sources, Not Separate Evidence Objects

Snapshots and files are not rival truths. They are two candidate sources for
the same logical observations.

The library should ingest typed candidates:

- source kind: snapshot, file, or reconstructed-as-at materialisation
- evidence identity
- observation coordinate
- counts `n/k`
- provenance

The merge then decides inclusion by identity, role, as-at, and dedupe rules.
Callers may have different mechanisms for finding candidates, but they must
convert those candidates into this common representation before summing.

### As-At Is An Admission Boundary

As-at is not a display filter. It is part of evidence admission.

A candidate is admissible only if:

- its observation date is inside the evidence date bounds
- its retrieval/source timestamp is known and at or before the scope as-at,
  unless that candidate is explicitly declared as already as-at materialised
- it does not describe an observation after its own retrieval timestamp
- it matches the role and subject identity
- its context/regime identity is compatible with the scope

If the candidate lacks enough timestamp metadata to enforce the as-at
contract, the library must not silently use it. It should either reject it
with `missing_retrieved_at` or accept it only under an explicit
candidate-level `asat_materialised` policy supplied by the caller.

This flag belongs on the candidate, not the scope. A single merge may contain
reconstructed snapshot candidates that are already materialised for the
requested as-at boundary alongside raw file candidates that still need their
own `retrieved_at` checked.

### Dedupe Is By Logical Observation Identity

The dedupe key is not just date. It is the logical observed fact:

- evidence role
- subject span and anchor identity required by that role
- observed date on the correct clock
- context / case / regime identity
- selected cohort/population identity where applicable

Snapshot candidates win over file candidates for the same logical observation
because snapshots are the materialised, hash-aggregated source. Equivalent
snapshot hashes count once. File duplicates count once unless they represent
different compatible contexts that the scope explicitly asks to aggregate.

### E And e Must Not Be Elided

`EvidenceSet` is raw E. It exposes raw included points and raw totals.

If the conditioner needs weighting, half-life decay, thinning, or effective
mass scaling, that transformation creates an `EffectiveEvidenceSet` from E.
For current BE CF, `e == E`. That equality should be represented directly,
not recreated by summing separate fields in downstream code.

### General Object Shape

The shared library should converge on separate objects for:

- `EvidenceScope`: one role, scenario, subject, context, date window, and
  as-at boundary
- `EvidenceIdentity`: the summability identity for compatible rows
- `ObservationCoordinate`: observed date, retrieval timestamp, temporal
  basis, and candidate-level as-at materialisation metadata
- `EvidenceCandidate`: one source row expressed as identity, coordinate,
  counts, and provenance
- `EvidencePoint`: one included observation after admission and dedupe
- `EvidenceSet`: raw E, with totals, included points, skipped candidates,
  and provenance

The exact Python names can change during implementation, but these concepts
must remain separate. In particular, `EvidenceIdentity`,
`ObservationCoordinate`, `EvidenceScope`, and `EvidenceSet` must not collapse
into ad-hoc tuple lists.

## Shared Library Contract

The shared library should live in `graph-editor/lib`, as the current `file_evidence_supplement.py` already does, because both the Python backend and the Bayes compiler can import from that location.

It should replace the current helper with a role-aware merge boundary.

Inputs:

| Input | Meaning |
|---|---|
| Evidence scope | Role, subject, scenario, context, date bounds, and as-at boundary |
| Snapshot candidates | Typed `EvidenceCandidate` rows derived from snapshot/hash aggregates |
| File candidates | Typed `EvidenceCandidate` rows derived from parameter-file evidence or graph engorgement |
| Reconstructed candidates | Typed `EvidenceCandidate` rows materialised by as-at reconstruction |
| Role policy | Compatibility rules for the selected evidence role |
| Dedupe policy | Snapshot/file priority and equivalent-hash handling |

Outputs:

| Output | Meaning |
|---|---|
| Raw E totals | `n`, `k`, and `mean` for the canonical scoped evidence |
| E observations | Included observations with source provenance |
| Totals by source | Contribution from snapshot, file, and reconstructed candidates |
| Covered observations | Logical observations for which snapshot evidence won |
| Skipped candidates | Rows rejected with explicit reasons |
| Role metadata | Evidence role and semantic assumptions used |
| Optional effective evidence | Present only when weighting or effective-mass transformation is applied |
| Provenance summary | Included rows, skipped rows, and skip reasons. Required immediately for tests and diagnostics, even if not all fields are persisted to graph state. |

The library should be pure. It should not query the database and should not
read files. Callers supply typed candidates. Candidate extraction can live in
thin adapters for BE CF, Bayes, and as-at reconstruction, but the merge and
dedupe rules must live in one place.

## Merge Algorithm

### Step 1 — Normalise Candidates Into Identities And Coordinates

Every snapshot row, file row, and reconstructed row is first converted into
an `EvidenceCandidate` with an `EvidenceIdentity` and
`ObservationCoordinate`.

Rows that cannot be assigned a valid identity are skipped before any summing.
This includes missing role information, unsupported context, missing required
anchor, undefined population identity where the role requires it, invalid
date, invalid `n/k`, and missing retrieval metadata when the as-at policy
requires it.

### Step 2 — Select Snapshot Rows For The Role

Snapshot rows must already be limited to the relevant edge and query period. The merge library should still validate that each row belongs to a slice family compatible with the role.

For `window_subject_helper`, snapshot rows must be window-family rows for the subject `X -> end`.

For `direct_cohort_exact_subject`, snapshot rows must be cohort-family rows for the exact anchor and subject.

Rows from incompatible families should be skipped with reasons, not silently used.

### Step 3 — Collapse Snapshot Rows By Logical Observation

Within the selected role, snapshot evidence wins over file evidence because it is richer.

The logical deduplication key should include:

- role
- subject span
- cohort anchor where applicable
- observed date on the correct observation clock
- normalised slice family
- context / case identity where applicable
- selected regime identity where applicable
- population or equivalent-hash identity where applicable

For a given identity plus observed date, select the latest valid retrieval at
or before the query’s as-at boundary, unless the candidate itself is marked
as already materialised for that as-at boundary.

If multiple hashes produce identical logical observations through equivalence mappings, count the observation once.

### Step 4 — Select Non-Snapshot Entries For The Same Role

File and reconstructed entries must be filtered by the same evidence role.

For `window_subject_helper`, include only window-family file evidence for the subject edge.

For `direct_cohort_exact_subject`, include only the exact matching cohort anchor.

For Bayes Phase 2 roles, include only cohort evidence families appropriate
to the Bayes observation role. The merge library should not decide whether
a cohort observation becomes a trajectory potential or a native daily
likelihood; it should preserve enough typed provenance for `model.py` to
make that decision.

The current rule, “all bare `cohort(...)` daily points,” must be retired. It admits multiple anchor-rooted cohort objects for the same edge and double-counts them.

### Step 5 — Supplement Only Uncovered Logical Observations

Non-snapshot rows supplement only logical observations not covered by
selected snapshot rows.

If a file row or reconstructed row and a snapshot row share the same
role-compatible logical observation, the non-snapshot row is skipped as
`covered_by_snapshot`.

If a candidate is from the wrong evidence role, skip it as `wrong_role`.

If a candidate is context-qualified but the role does not support that context, skip it as `unsupported_context`.

If a raw candidate is after the scope as-at boundary, skip it as `after_as_at`.

If a raw candidate's observation date is after its own `retrieved_at`, skip it as
`after_retrieved_at`.

### Step 6 — Return E And Provenance

The merged evidence object must expose enough detail to audit the result:

- total raw E
- snapshot component
- file component
- reconstructed component
- included observation count
- skipped candidate counts by reason
- selected role

This is the object that BE CF reports as `evidence_n` / `evidence_k`.
It must also expose provenance for tests. Minimum provenance fields:

- included snapshot observations
- included file observations
- included reconstructed observations
- skipped candidates by reason
- selected evidence role
- selected file slice families
- selected snapshot families
- response provenance version

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

1. Resolve forecast subject, scenario scope, as-at boundary, and evidence role.
2. Query snapshot rows for that exact scope.
3. Gather file evidence entries from the request graph for that exact scope.
4. Convert both sources into typed candidates.
5. Call the shared merge library to build E.
6. Pass E, or explicit e derived from E, into conditioning.
7. Return `evidence_n/evidence_k` from E.
8. Persist/upsert E to graph L4 evidence.
9. Remove response-time file supplement logic.

`compute_cohort_maturity_rows_v3` may still produce chart-row evidence for
display. That is not the same as response L4 evidence and should not be
copied into `evidence_n/k`. If conditioned forecast and cohort maturity need
the same p-conditioning object, they must both receive the same `EvidenceSet`
from the shared preparation step, not rebuild evidence independently.

## As-At Reconstruction Integration

As-at reconstruction should use the same candidate and merge model when it
reconstructs file-like evidence from snapshots.

The reconstruction path may produce candidates whose source is snapshot-like
but whose immediate representation looks file-like. That does not justify a
separate merge rule. The reconstructed rows should be tagged with provenance
that says how they were materialised, then admitted through the same
`EvidenceScope` and `EvidenceIdentity` checks.

The key invariant is:

> an as-at reconstruction may change how candidates are obtained; it must not
> change what counts as the canonical E for a scope.

If reconstructed evidence is already materialised at the requested as-at
boundary, the adapter marks those candidates as `asat_materialised`.
That marker is candidate-level because the same merge may also contain raw
file candidates whose own `retrieved_at` must still be enforced.

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

The shared merge output for Bayes must therefore preserve enough provenance
for the model builder to route observations after E is built. At minimum,
the included point provenance must retain the cohort anchor, cohort selector,
subject edge/span, edge depth from anchor, path identity, temporal basis, and
population identity. If any of those are missing for a cohort candidate, the
adapter should reject it before merge rather than emit a lossy E that
`model.py` cannot classify safely.

## CF Response Provenance Contract

Stage 3 must expose compact provenance under a dedicated
`evidence_provenance` block on each conditioned forecast result.

It should not be placed under `conditioning`. `conditioning` is the runtime
conditioning/effective-evidence surface; provenance describes the raw E that
was admitted and reported. Keeping it separate avoids another name-level
elision.

The response-visible block should include:

- provenance schema version
- evidence role
- scope key or scenario id
- raw E totals
- totals by source kind
- included observation counts by source
- selected snapshot families and file slice families
- skipped candidate counts by reason
- as-at boundary
- whether any included candidate was as-at materialised

Full per-row provenance is required internally and in tests, but it need not
be shipped on every CF response unless a diagnostic flag explicitly asks for
it. The graph L4 upsert should persist raw E totals and may persist compact
provenance later; Stage 3 must at least make the response contract stable
for FE consumers, regression harnesses, and parity tests.

## Test Plan

Tests must be written against the shared library first.

### Blind-Test Gate

The current plan includes the right categories, but they must be made blind
explicitly. For each implementation stage, write or update the failing
contract tests before changing production code for that stage. The test must
encode expected E, provenance, and skip reasons from fixture data, not from
the implementation's own merge output.

Minimum blind tests:

1. Pure-library Q4 blind fixture. Feed snapshot candidates plus window,
   `cohort(A)`, and `cohort(B)` file candidates. Under
   `window_subject_helper`, expected E is snapshot-window covered
   observations plus file-window uncovered observations; both cohort file
   slices are skipped as wrong role, and the result must not be
   `71224/41700`.
2. As-at admission blind fixture. Use two as-at boundaries over the same
   candidate set. Later retrieved candidates are invisible to the earlier
   scope and visible to the later scope. Reconstructed candidates marked
   `asat_materialised` can coexist with raw file candidates whose
   `retrieved_at` is still enforced.
3. Multi-scenario blind fixture. One request contains two scenarios with
   different as-at or context scope. Their E objects and
   `evidence_provenance.scope` values must not be shared unless the scopes
   are identical.
4. Population-identity blind fixture. A direct-cohort candidate with the
   right anchor text and date bounds but a different `population_identity`
   is rejected. This protects the future WP8 role before the old helper is
   retired.
5. Bayes Phase 2 routing blind fixture. First-edge cohort observations carry
   enough provenance to remain eligible for native daily likelihoods;
   downstream cohort observations carry depth/path provenance and are not
   silently promoted to unrestricted per-edge daily likelihoods.
6. CF response blind fixture. The conditioned forecast response exposes
   compact `evidence_provenance` under that exact block name, not under
   `conditioning`, with version, role, scope, source totals, selected
   families, skipped counts, as-at boundary, and as-at-materialised marker.
7. Outside-in as-at blind harness. `graph-ops/scripts/asat-blind-test.sh`
   remains a core gate for this work, with `synth-simple-abc` as the primary
   fixture and `synth-context-solo-mixed` when context or epoch interaction
   is under test. It must catch drift between `param-pack.sh` and
   `analyse.sh` on evidence visibility, posterior selection, and evaluation
   date.
8. Outside-in CF parity blind harness. `conditioned-forecast-parity-test.sh`
   and `cf-topology-suite.sh` remain gates once BE CF integration starts,
   with an explicit evidence/provenance assertion added for this workstream.

These blind tests should be classified before implementation as expected
red, expected green, or existing harness extension. If a test is too slow or
requires a live server or data repo, the plan must name that prerequisite
instead of silently replacing it with a narrower unit test.

### Unit / Contract Tests For The Shared Library

1. Snapshot rows cover days 3–5 and file rows cover days 1–5. E includes file days 1–2 and snapshot days 3–5.
2. File entries contain `window`, `cohort(A)`, and `cohort(B)`. Role `window_subject_helper` includes only the window file entry.
3. Role `direct_cohort_exact_subject` with anchor B includes only `cohort(B)` and skips `cohort(A)`.
4. Duplicate snapshot rows from equivalent hashes count once.
5. Direct cohort role rejects a candidate with matching anchor text but a different `population_identity`.
6. Two scenarios with different as-at boundaries produce different E when later candidates are only visible to the later scenario.
7. Two scenarios with different context keys do not share E.
8. A file row with `observed_date > retrieved_at` is skipped as `after_retrieved_at`.
9. A raw row after the scope as-at boundary is skipped as `after_as_at`.
10. An as-at materialised reconstructed candidate can coexist with a raw file candidate in the same merge.
11. Context rows are skipped unless the role explicitly supports context and the context is compatible.
12. Skipped rows report reasons.
13. Q4 fixture contract: merged E under WP8-off is snapshot window covered plus file window uncovered, not both cohort anchors.

### BE CF Integration Tests

1. BE CF response `evidence_n/k` equals merged E.
2. Runtime `p_conditioning_evidence.total_x/y` equals merged E or documented effective e.
3. BE CF provenance identifies which file slice family and snapshot family
   contributed to E.
4. If e differs from E in future, response contains both raw E and effective e metadata.
5. For Q4, CF response no longer reports `71224/41700`.
6. Two conditioned forecast scenarios in one request do not share evidence
   when their scenario scope differs.
7. `cohort_maturity_v3` and `conditioned_forecast` consume the same prepared
   E for the same p-conditioning scope.
8. CF response includes compact `evidence_provenance` with stable version,
   role, scope, source totals, skipped counts, selected families, and as-at
   boundary.

### Bayes Binder Tests

1. Phase 1 does not supplement cohort slices into window evidence.
2. Phase 2 emits cohort observations under the explicit
   `bayes_phase2_cohort` role.
3. First-edge cohort daily observations remain eligible for native daily
   likelihoods.
4. Downstream cohort observations remain trajectory/path observations and
   are not silently promoted into unrestricted per-edge daily likelihoods.
5. Phase 2 provenance includes cohort anchor, cohort selector, edge depth
   from anchor, subject span, temporal basis, path identity, and population
   identity.
6. Existing MECE/context aggregation behaviour remains unchanged.

## Migration Plan

### Stage 0 — Freeze The Current Partial Wiring

Do not deepen the current tuple-threaded implementation. Treat it as a
temporary diagnostic bridge only. New work should target the typed
`EvidenceScope` / `EvidenceIdentity` / `ObservationCoordinate` /
`EvidenceSet` design.

### Stage 1 — Shared E Library Only

Implement the pure shared library with:

- `EvidenceScope`
- `EvidenceIdentity`
- `ObservationCoordinate`
- population identity / selected-cohort-set key helpers
- `EvidenceCandidate`
- `EvidencePoint`
- `EvidenceSet`
- `merge_evidence_candidates`

No BE CF, cohort maturity, Bayes, or as-at integration in this stage.

Tests:

- role filtering
- file/snapshot overlap
- equivalent snapshot duplicates
- as-at admission
- retrieved-at admission
- context mismatch
- multi-scenario separation
- direct cohort population-identity mismatch
- candidate-level as-at materialisation
- Q4 expected E fixture

### Stage 2 — Candidate Adapters

Add thin adapters that convert existing BE CF snapshot rows, graph-engorged
file evidence, Bayes parameter-file evidence, and as-at reconstructed rows
into `EvidenceCandidate`s.

These adapters may know about current row shapes. They must not perform final
evidence summing. They must attach candidate-level as-at materialisation
metadata, observation coordinates, and role-specific provenance. The Bayes
adapter must attach the Phase 2 provenance required to distinguish first-edge
native daily likelihood candidates from downstream trajectory/path
observations.

### Stage 3 — BE CF Prepared Runtime

Move BE CF p-conditioning evidence construction into one prepared-runtime
step:

1. build `EvidenceScope`
2. extract candidates
3. merge E
4. pass E/e into conditioning
5. return E with compact `evidence_provenance`
6. upsert raw E totals to graph L4 evidence

Remove endpoint-level evidence supplements and any independent evidence
reconstruction inside `conditioned_forecast`.

### Stage 4 — Cohort Maturity Parity

Ensure `cohort_maturity_v3` and `conditioned_forecast` consume the same
prepared E for the same p-conditioning scope. Chart display evidence may
remain separate, but it must be named separately and cannot feed L4
`p.evidence`.

### Stage 5 — Bayes Integration

Replace Bayes file supplement calls with the shared merge library through the
Bayes candidate adapter. Preserve Bayes-specific modelling choices after E is
built:

- Phase 1 window evidence
- Phase 2 cohort observations
- first-edge native daily likelihood eligibility
- downstream trajectory/path observations

### Stage 6 — As-At Reconstruction Integration

Route as-at reconstructed file-like evidence through the same candidate and
merge path. This closes the gap where reconstruction and live CF could
otherwise produce different E for the same scope.

### Stage 7 — Retire Old Helpers

Remove or hard-deprecate helpers whose contract is "supplement uncovered bare
cohort daily points." They encode the original defect.

Update doc 60 Appendix A with a pointer that `direct_cohort_exact_subject` is
an explicitly supported future evidence role for WP8, but remains disabled
until the WP8 flag/admission path lands.
