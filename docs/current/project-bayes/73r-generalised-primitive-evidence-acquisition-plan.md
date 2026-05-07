# 73r — Generalised Primitive Evidence Acquisition Plan

**Status**: Draft implementation plan  
**Date opened**: 4-May-26  
**Scope**: Complete the evidence-acquisition side of the 73g / 73n CF runtime unification so every conditioned primitive receives all admissible file and snapshot evidence through one path.

## Purpose

The primitive conditioning substrate is already general once it receives typed evidence candidates. It can merge file and snapshot evidence, dedupe overlapping observations, bind rows onto the primitive-local clock, apply subset/effective-evidence policy, and condition the primitive posterior.

The remaining defect is upstream of that substrate. Candidate construction is still target-edge-biased:

- the target edge gets file evidence plus snapshot evidence as typed candidates
- non-target subject edges and active-carrier edges mostly get evidence reconstructed from derived frames
- those frame-derived evidence sets contain snapshot-style rows only
- therefore file evidence can be lost from query-time conditioning for intermediate subject primitives and carrier primitives

This plan specifies the missing generalisation.

## Source Contracts

This plan is bound by:

- `docs/current/project-bayes/73g-general-purpose-f14-problem-and-invariants.md`
- `docs/current/project-bayes/73n-unified-cf-runtime-invariants-and-audit.md` (landed; this plan builds on the merged state, not on a parallel branch). 73r is the explicit closure of 73n's deferred work item: "Wire active-cohort upstream carrier primitive evidence through the real runtime retrieval/binding path, not only through test injection seams" (closure work item 3), generalised to non-target subject edges as well as carrier edges. 73n invariant E is the audit-side statement of the bug 73r fixes.
- `docs/current/codebase/KNOWN_ANTI_PATTERNS.md` AP59 ("architecturally complete stage closure with the new path default-OFF") names per-upstream-edge evidence fetching as a deferred-then-forgotten item from 73n stages 5b/6. Per AP59's fix template, that deferred follow-up is the first atom of the next plan. 73r is that plan.
- `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
- `docs/current/codebase/FORECAST_STACK_DATA_FLOW.md`
- `docs/current/snapshot-fetch-envelope-design.md`

The important existing contract from `FORECAST_STACK_DATA_FLOW.md` is that BE CF has a broader evidence base than the FE topo path: it reads the transient request graph, including file-backed Bayes evidence, and it also queries the snapshot DB directly. File evidence and snapshot evidence are complementary sources. Snapshot evidence may supersede file evidence for the same observation, but snapshot evidence must not replace file evidence globally.

## Current State

### What Already Works

The shared evidence machinery is not the problem. These pieces are the intended downstream path and should be preserved:

- `EvidenceCandidate` (`graph-editor/lib/evidence_merge.py:130`) represents one candidate observation from a source such as `FILE`, `SNAPSHOT`, or `RECONSTRUCTED`.
- `merge_evidence_candidates()` (`graph-editor/lib/evidence_merge.py:498`) admits candidates for a requested evidence scope, dedupes by observation identity and date, lets snapshot rows beat file rows for the same observation, and keeps file rows for observations not covered by snapshots.
- `bind_primitive_evidence()` (`graph-editor/lib/runner/primitive_evidence.py:215`) binds admitted rows to a primitive-local evidence clock using arrival weights.
- `condition_primitive()` (`graph-editor/lib/runner/primitive_conditioning.py:210`) updates the primitive posterior exactly once from the bound evidence.
- `compose_primitive_span()` (`graph-editor/lib/runner/subject_span_composer.py:211`) composes conditioned primitives for both subject and carrier roles.

The target-edge path already feeds this machinery with a useful candidate set. In `prepare_forecast_runtime_inputs()` (`graph-editor/lib/runner/forecast_runtime.py:1403`), the target edge's `_bayes_evidence` is converted to file candidates via `bayes_file_evidence_to_candidates()` (`graph-editor/lib/runner/evidence_adapters.py:139`) and its `snapshot_rows` are converted to snapshot candidates inline (around `forecast_runtime.py:1862`). Those candidates are passed onward as `evidence_candidates`.

### What Is Still Wrong

The non-target and carrier paths do not use the same candidate-construction contract.

`build_per_edge_evidence()` (`graph-editor/lib/runner/cohort_forecast_v3.py:226`) walks a subject or carrier topology and synthesises `EvidenceSet` objects from already-derived frames. Those frames come from snapshot reads and are converted into `SourceKind.SNAPSHOT` candidates (per-edge candidate construction at `cohort_forecast_v3.py:134`). The helper does not also read each edge's `_bayes_evidence`, so it cannot produce file candidates for those edges. The request-level pool builder `_aggregate_request_candidates()` (`cohort_forecast_v3.py:309`) inherits this asymmetry: target-edge candidates carry both file and snapshot, non-target/carrier candidates carry snapshot only.

That means:

- a multi-hop subject's intermediate edges can miss file evidence
- an active Cohort mode carrier's upstream edges can miss file evidence
- sparse or no-snapshot cases can fall back to prior-only even when file evidence exists
- the runtime behaves as if the full primitive evidence system exists, while part of the candidate feed is still a snapshot-only adapter

This is a data-loss bug in the query-time conditioning evidence path. It is not a loss of persisted file data.

## Target State

Every parameterised primitive edge in a CF request must have one evidence candidate feed:

```text
file evidence from the request graph
+ snapshot rows from the per-edge snapshot fetch
+ reconstructed/as-at evidence where applicable
-> EvidenceCandidate[]
```

All primitive edge candidates are then combined into one request candidate pool:

```text
all primitive-edge EvidenceCandidate[]
-> per-primitive merge_evidence_candidates()
-> bind_primitive_evidence()
-> condition_primitive()
-> compose_primitive_span()
-> runtime projection
```

This applies uniformly to:

- target subject edge
- non-target subject edges in a multi-hop `X -> end` span
- carrier edges in active `cohort(A, X -> end)` requests
- Window mode
- Cohort mode
- `A = X` identity Cohort mode

Single-hop is simply a one-edge subject topology. Multi-hop is the same topology contract with more subject edges. `window()` and `cohort()` differ by binding descriptor data, not by separate evidence acquisition machinery.

## Definitions

### File Evidence

File evidence is evidence carried on the request graph from parameter files or Bayes engorgement, including `_bayes_evidence` and parameter-file evidence entries. It is persistent or request-graph materialised. It may exist when the snapshot DB has no rows for the current request.

### Snapshot Evidence

Snapshot evidence is queried from the snapshot DB for the current request and edge. It is direct observed data. When file evidence and snapshot evidence describe the same observation, snapshot evidence wins during merge/dedupe.

### Reconstructed Evidence

Reconstructed evidence is an as-at materialisation derived from snapshots but represented as a distinct evidence source when it is explicitly materialised. It is not a generic substitute for file evidence or snapshot evidence.

### Primitive Edge

A primitive edge is one parameterised graph edge that can be conditioned independently before composition. In a multi-hop subject there are multiple subject primitive edges. In active Cohort mode, the `A -> X` carrier contains carrier primitive edges.

### Binding Descriptor

A binding descriptor is the per-primitive-edge object that names:

- evidence binding type: window binding or cohort binding
- clock anchor
- source node
- target node
- semantic role: subject or carrier
- request date bounds and `asat()`
- graph/source preference needed to resolve priors and fetch envelopes
- retrieval identity needed to query snapshots

The descriptor is the only legitimate place where window/cohort and subject/carrier differences affect evidence acquisition.

## Required Design

### One Per-Edge Candidate Builder

Introduce or complete a single candidate builder that accepts a primitive-edge binding descriptor and returns typed evidence candidates for that edge.

For each descriptor, it must:

- read file evidence from the request graph edge
- convert file evidence through the existing file evidence adapter
- fetch snapshot rows for that edge using the descriptor's snapshot envelope
- convert snapshot rows into `SourceKind.SNAPSHOT` candidates
- include reconstructed/as-at candidates only when the source is actually reconstructed
- preserve `asat()` as a retrieval-time admission gate, not as an anchor-day truncation rule
- return raw candidates, not a pre-merged `EvidenceSet` as the semantic authority

The builder must not know whether the edge is target, intermediate subject, or carrier except through descriptor metadata.

### One Request Candidate Pool

The runtime preparation layer must collect candidates for every primitive edge in the request topology and pass one complete candidate pool into `compute_resolved_runtime_readout()`.

The candidate pool must contain:

- target subject edge candidates
- all non-target subject edge candidates
- all active-carrier edge candidates

The pool may include candidates that are irrelevant to a given primitive. The primitive-local merge is responsible for admitting only rows whose subject identity, date bounds, role, context, regime, anchor, and `asat()` match that primitive's evidence scope.

### Existing Merge/Bind/Condition Path Remains The Owner

This work must not introduce a second merge, weighting, or conditioning implementation.

The downstream owner remains:

```text
merge_evidence_candidates()
bind_primitive_evidence()
condition_primitive()
compose_primitive_span()
```

Projection code must not inspect file rows, snapshot rows, or source precedence. It should only read the resolved runtime.

### Frame-Derived Evidence Is Not Conditioning Authority

Derived frames remain useful for chart display, observed row rendering, and backward compatibility during migration. They must not be the source of truth for primitive conditioning.

`build_per_edge_evidence()` should be retired as a semantic input to primitive conditioning or reduced to a temporary adapter. If it remains temporarily, its use must be labelled as incomplete because it cannot carry file evidence.

### Delete Legacy Tuple Plumbing

`extra_conditioning_evidence` (defined at `graph-editor/lib/runner/forecast_runtime.py:1310`; assigned at `forecast_runtime.py:1915`; consumed at `cohort_forecast_v3.py:1247` and `cohort_forecast_v3.py:1875`) is a lossy compatibility bridge that extracts non-snapshot merged points into `(age_days, n, k)` tuples. Once every primitive edge receives typed candidates directly, this bridge should be deleted.

The desired shape is not:

```text
EvidenceSet -> tuple extras -> special update path
```

It is:

```text
EvidenceCandidate[] -> primitive-local merge/bind/condition
```

## Implementation Scope

### In Scope

1. Build or finish per-edge binding descriptors for every primitive edge in the request topology.
2. Build one evidence candidate feed per descriptor.
3. Convert file evidence for every primitive edge, not only the target edge.
4. Fetch snapshot rows for every primitive edge through the descriptor envelope.
5. Pass the full request candidate pool into the primitive runtime.
6. Remove or quarantine `build_per_edge_evidence()` as a conditioning authority.
7. Remove `extra_conditioning_evidence` after parity tests prove typed candidates cover the same cases.
8. Remove target-edge-only evidence construction branches.
9. Remove duplicated active-carrier upstream fetch logic where it becomes an adapter over the descriptor-based per-edge fetch contract.
10. Preserve response provenance so reviewers can see file, snapshot, reconstructed, skipped, and deduped counts by source.

### Out Of Scope

- Changing the semantics of `merge_evidence_candidates()`.
- Changing snapshot-over-file dedupe precedence.
- Changing the statistical update in `condition_primitive()`.
- Adding gross-fitted numerator admission.
- Adding hierarchical per-Cohort conditioning.
- Changing FE topo semantics.
- Changing observed chart-row derivations except where they were incorrectly acting as conditioning evidence.

## Affected Files

Likely implementation files:

- `graph-editor/lib/runner/forecast_runtime.py`
- `graph-editor/lib/runner/forecast_preparation.py`
- `graph-editor/lib/runner/request_envelope.py`
- `graph-editor/lib/runner/cohort_forecast_v3.py`
- `graph-editor/lib/runner/primitive_readout.py`
- `graph-editor/lib/evidence_merge.py` only if provenance or helper API additions are needed; the merge algorithm should not change
- `graph-editor/lib/api_handlers.py` for deleting duplicated fetch/adaptor logic

Likely test files:

- `graph-editor/lib/tests/test_evidence_merge.py`
- `graph-editor/lib/tests/test_evidence_adapters.py`
- `graph-editor/lib/tests/test_primitive_evidence.py`
- `graph-editor/lib/tests/test_primitive_conditioning.py`
- `graph-editor/lib/tests/test_cohort_factorised_outside_in.py`
- `graph-editor/lib/tests/test_conditioned_forecast_response_contract.py`
- `graph-editor/lib/tests/test_cf_cache_machinery.py`

## Acceptance Criteria

### Functional Acceptance

For every parameterised primitive edge in the request topology:

- file evidence is converted to typed candidates when present
- snapshot evidence is converted to typed candidates when present
- file evidence is still admitted when no matching snapshot row exists
- snapshot evidence supersedes file evidence for the same observation
- no duplicate file/snapshot observation is counted twice
- no primitive falls back to prior-only when admissible file evidence exists for that primitive

### Shape Acceptance

The code path should have:

- one binding descriptor plan per request
- one candidate builder per primitive edge
- one request candidate pool
- one primitive-local merge/bind/condition path
- no target-edge-only file-evidence path
- no frame-only conditioning path for non-target subject or carrier edges
- no `extra_conditioning_evidence` once candidate parity is proven

### Semantic Acceptance

The runtime must preserve:

- displayed rates are `Y / X`, never `Y / A`
- `carrier_to_x` owns denominator arrival
- `subject_span` owns numerator progression
- Window-mode primitive evidence is local-clock evidence
- Cohort-mode carrier evidence is carrier-clock evidence
- Cohort-mode subject evidence is subject-clock evidence rooted at `X`
- file evidence and snapshot evidence are complementary, not mutually exclusive

### Provenance Acceptance

Diagnostics or response provenance must be able to show, for the conditioned evidence set:

- total admitted `n` and `k`
- admitted totals by source kind
- candidate counts by source kind
- skipped counts by reason
- rows skipped because snapshot covered the same observation
- rows skipped by role, subject, date, context, regime, anchor, or `asat()`

## Test Plan

### Unit Tests

Add tests proving that a per-edge candidate builder:

- emits file candidates when only file evidence exists
- emits snapshot candidates when only snapshot rows exist
- emits both when both are present
- preserves file-only days when snapshots cover other days
- lets snapshot rows beat file rows for the same observation
- respects `asat()` by `retrieved_at`, not by clipping `anchor_day`

Add tests proving the request candidate pool contains candidates for:

- target subject edge
- non-target subject edge
- active-carrier edge

### Integration Tests

Add runtime tests for:

- multi-hop window subject with no snapshot rows on an intermediate edge but with file evidence on that intermediate edge
- multi-hop cohort subject with file evidence on a non-target subject edge
- active Cohort mode where carrier edge has file evidence but no snapshot rows
- active Cohort mode where carrier edge has both file and snapshot evidence and dedupe picks snapshot only for overlapping observations

Each test should assert the primitive provenance shows conditioning from the expected source mix.

### Outside-In Tests

Extend public-path tests so at least one `conditioned_forecast` or `cohort_maturity` query proves that:

- an intermediate subject edge's file evidence affects the public result when snapshots are absent
- an active-carrier edge's file evidence affects the public result when snapshots are absent
- adding snapshot rows for a subset of dates changes only those observations' source, not the whole evidence set

### Static / Removal Tests

Add static assertions or search-based tests that fail if:

- primitive conditioning for non-target/carrier edges is sourced only from frame-derived `EvidenceSet`s
- target-only file evidence construction is the only call to `bayes_file_evidence_to_candidates()`
- `extra_conditioning_evidence` remains in the public CF path after the migration is complete

## Suggested Implementation Sequence

### Stage 1 — Current-State Lock Test

Add a failing test in `graph-editor/lib/tests/test_primitive_evidence.py` (or a new sibling file if the existing one is the wrong shape) that demonstrates the bug:

- construct a request with file evidence on a non-target subject edge or carrier edge
- omit snapshot rows for that edge
- assert that the conditioned primitive's posterior reflects the file evidence (not the prior)

The test should fail against `main` and pass only when file evidence is included for every primitive edge. Keep the test in the suite after implementation as the guard against regression.

### Stage 2 — Binding Descriptor Inventory

Introduce a request binding plan that enumerates every primitive edge needed by a request:

- subject edges from `X -> end`
- carrier edges from `A -> X` when active Cohort mode
- no carrier edges for Window mode or `A = X`

The descriptor should carry enough information to build file candidates and snapshot candidates without target-edge special handling.

### Stage 3 — Per-Edge Candidate Builder

Implement the per-edge candidate builder over one descriptor.

It should read:

- request graph edge evidence for file candidates
- snapshot rows fetched under the descriptor envelope for snapshot candidates

It should return raw `EvidenceCandidate[]`.

### Stage 4 — Runtime Candidate Pool Cutover

Feed the descriptor-built per-edge candidates into `_aggregate_request_candidates()` so the request-level pool now contains file candidates for every primitive edge, not only the target. The function itself remains the canonical pool builder; the change is to its inputs, not its existence.

At this point, target, non-target subject, and carrier primitives should all receive evidence through the same pool and the same primitive-local merge.

### Stage 5 — Remove Frame-Derived Conditioning Authority

Stop using `build_per_edge_evidence()` as an input to primitive conditioning.

Keep frame evidence only for observed chart display or delete it if no longer needed.

### Stage 6 — Delete Compatibility Bridges

Remove:

- `extra_conditioning_evidence`
- target-edge-only candidate plumbing
- pre-merged `EvidenceSet` shims where they are only compatibility inputs
- duplicated upstream fetch branches superseded by descriptor-based fetching

### Stage 7 — Public Acceptance

Run focused primitive evidence tests, runtime tests, and the outside-in CF/cohort suites. Preserve failing tests until the code satisfies the public semantics; do not weaken assertions to fit the migration.

## Risks

### Over-Fetching

Per-edge snapshot envelopes may initially be wider than strictly necessary. Prefer correctness and dedupe over tight fetches. Optimise only after the evidence source mix is correct and proven.

### Cache Identity

Candidate pools will change for multi-hop and active-carrier requests because file evidence will now be included. Cache keys must include the evidence identity that already affects primitive conditioning. If a cache key currently misses source mix or candidate identity, fix the key before enabling cache reuse on the new path.

### Role Mismatch

File evidence must be converted with the correct evidence role for the primitive. A target edge, intermediate subject edge, and carrier edge may share physical graph structure but are not necessarily the same evidence question. Role must live in the binding descriptor and candidate identity.

### Window Mode Binding

Window-mode multi-hop subjects must use per-primitive local-clock evidence. Do not implement this work by building one propagated X-rooted evidence map for all Window-mode subject edges.

## Completion Definition

This work is complete when every primitive edge in CF runtime construction receives file, snapshot, and reconstructed evidence through the same typed candidate contract, and all later stages are projections of the resolved runtime.

The final pipeline should be:

```text
request
-> binding descriptors for primitive edges
-> per-edge file + snapshot candidate construction
-> one request candidate pool
-> per-primitive merge / bind / condition
-> subject and carrier composition
-> runtime projection
```

No conditioning evidence path should remain that is target-only, snapshot-only by construction, or based on lossy tuple bridges.
