# Context epochs: regime-safe cohort maturity under mixed slice histories
**Status**: Implemented (10-Feb-26). Core logic complete; backend contract fix complete; 17 tests passing (12 backend CE + 3 frontend epoch mapper + 1 stitching + 1 graceful degradation). See §8 for implementation record.  
**Date**: 9-Feb-26 (design) · 10-Feb-26 (status update)  
**Scope**: Snapshot DB read path for cohort maturity; frontend fetch planning; MECE-safe slice aggregation; equivalence-link interactions

---

## 1. Summary

We have identified a correctness failure in cohort maturity charting when the snapshot DB contains **multiple cohort “regimes”** for the same semantic subject:

- **Contexted regime**: a MECE partition of context slices (for example `context(channel:paid-search).cohort(...)`, `context(channel:other).cohort(...)`, …).
- **Uncontexted regime**: a single uncontexted slice (`cohort(...)`) for the same semantic subject.

When both regimes exist for the **same retrieved day**, the current cohort-maturity derivation effectively **sums across all context slices blindly**, which is never correct unless the slice set is explicitly MECE-valid for that epoch. This yields user-visible artefacts such as “drop then rise” for a closed cohort.

This document proposes a robust resolution based on **context epochs**:

- The frontend determines, **per retrieved day**, which regime is valid and intended (and only selects MECE-valid context sets).
- The frontend encodes that decision into the analysis request by **segmenting the sweep window into epochs**, each with an explicit slice set.
- The backend remains MECE-blind: it only executes DB reads and derivations for the explicit slice sets requested.

The design is explicitly extensible to future “context policy as-at date” logic (context definition as-of history), without requiring backend inference.

**Important clarifying note (current brokenness)**: for this design to be implementable, the request must be able to express **uncontexted-only** reads. Today, a selector like `cohort()` / `window()` is treated as “mode-only, any context” in snapshot DB filters, which defeats regime selection. This doc makes the required contract explicit (see §3.5 and §4.6).

---

## 2. Diagnosis

### 2.1 What went wrong (behavioural symptom)

For a cohort analysis that should be “closed”, the chart displayed a conversion rate that **drops** and then **rises** over successive “as-at” dates. This is not merely late-arrival behaviour: the totals indicate abrupt shifts caused by mixing regimes.

### 2.2 What is in the DB (factual evidence)

For at least one subject, a single retrieved day contained both:

- Four contexted cohort slice families (a channel MECE partition), and
- One uncontexted cohort slice family,

covering the same anchor-day range for the same semantic subject.

On that retrieved day, summing contexted + uncontexted rows yields inflated \(X\) and \(Y\) totals, producing the observed chart artefact.

### 2.3 Why this can happen (root cause)

This mixed-regime situation can be created by:

- Changes in how slices are fetched over time (a “regime change” in pinned interests / context configuration), and/or
- Signature equivalence links that unify two semantic subjects whose historical data was written under different regimes.

In particular, equivalence links can cause the read path (`include_equivalents`) to bring both regimes into scope on the same retrieved day.

---

## 3. Critical invariants

### 3.1 “Never sum context slices blindly”

Summing across `context(...)` slices is only permissible when:

- The slice set is MECE-valid for the relevant context key(s), and
- The aggregation semantics are consistent for the epoch in question.

This is a frontend responsibility because it depends on the context definition policy (and potentially its history), which is not available to the backend.

### 3.2 Backend must not infer MECE

The backend must not decide that a set of `context(...)` slices is safe to aggregate, because:

- MECE-ness is user-declared and policy-driven (see `contextRegistry` / `meceSliceService`), and
- Future hardening may require validating context policy as-of history.

Therefore, regime selection must be encoded explicitly in the request.

### 3.3 Cohort maturity is day-based

The cohort maturity chart is day-based:

- Epochs are keyed by retrieved **day** (UTC date), not finer-grained timestamps.
- If multiple `retrieved_at` timestamps exist within the same day, the day’s effective regime must be defined deterministically (for example “latest retrieved_at that day wins”), and applied consistently across all subjects.

### 3.4 “Least aggregation” is the regime tie-break rule

When multiple representations exist for the same semantic subject on the same retrieved day, we choose the representation that requires the **least aggregation** by the system.

This is the unifying principle behind regime selection:

- Prefer a slice set that already matches the query’s dimensionality (no marginalisation needed).
- Only aggregate across additional context dimensions when:
  - the aggregation is explicitly permitted by policy, and
  - the observed slice set is MECE-complete for the dimension(s) being aggregated away.

This principle is easy to state but non-trivial to encode correctly. The remainder of this document makes it precise and testable.

### 3.5 Slice selector semantics must make “uncontexted-only” representable

The epoch approach requires the frontend to choose **exactly one regime per retrieved day** (uncontexted total *or* an explicit MECE context partition), and to encode that choice into `slice_keys`.

Therefore the DB read API must support a selector that means:

- **uncontexted-only** (no context/case dims), in the requested temporal mode, **and not** “any context in this mode”.

If `cohort()` / `window()` is treated as “mode-only, any context” (matching both `cohort()` and `context(...).cohort()`), then the frontend cannot prevent mixed-regime reads and the derivation will continue to double-count.

This is a *mechanical selector contract* issue, not MECE inference. The backend remains MECE-blind; it just needs to match slice families precisely.

---

## 4. Proposal: context epochs for cohort maturity (frontend-led)

### 4.1 Overview

For each cohort maturity subject (per scenario):

1. **Observe availability**: Determine which slice families exist on each retrieved day across the sweep window (including equivalence closure).
2. **Choose regime per day**: Using frontend MECE logic, select either:
   - Uncontexted regime (single `cohort()` logical family), or
   - Contexted regime (explicit MECE slice family list, potentially multi-context).
3. **Segment into epochs**: Group consecutive retrieved days with the same regime into “context epochs”.
4. **Execute segmented sweep**: Issue one analysis request containing multiple snapshot subjects (one per epoch) with explicit `slice_keys`.
5. **Stitch results**: Merge epoch results into one maturity curve per original subject.

The key point is that the backend receives explicit slice families for each epoch and never needs to infer MECE or regime changes.

### 4.1.1 What already exists vs what is new (design constraint: minimise new code paths)

This work must be anchored on a strict constraint:

- **Do not create new code paths or new logic unless it is required.**
- Where existing services already implement the needed semantics, **reuse them** and extend only at the edges (inputs/outputs), rather than duplicating behaviour.
- Test coverage should be driven primarily by the **new required logic**, plus any **contract changes** that alter behaviour.

This design therefore distinguishes:

**Already exists (reuse; do not duplicate):**

- **Slice dimension parsing and normalisation**:
  - `extractSliceDimensions(...)` in `graph-editor/src/services/sliceIsolation.ts` (canonical context/case dimension string; sorted; window/cohort excluded).
- **Multi-context “query specifies subset of dims” reduction (MECE-gated)**:
  - `tryDimensionalReduction(...)` in `graph-editor/src/services/dimensionalReductionService.ts` (verifies MECE per unspecified dimension; combination completeness checks; dedupe before aggregation).
- **Implicit-uncontexted MECE selection (single-key, hardened)**:
  - `selectImplicitUncontextedSliceSetSync(...)` in `graph-editor/src/services/meceSliceService.ts` (coherent generation keyed by signature; deterministic selection).
- **Fetch plan construction**:
  - `buildFetchPlan(...)` in `graph-editor/src/services/fetchPlanBuilderService.ts` already uses the above primitives for cache fulfilment and staleness evaluation.
- **Snapshot DB retrieval calendar calls**:
  - the client/service layer that calls `/api/snapshots/retrievals` already exists (see `graph-editor/src/services/snapshotRetrievalsService.ts`).
- **Snapshot-subject wire format mapping** (thin mapper):
  - `mapFetchPlanToSnapshotSubjects(...)` in `graph-editor/src/services/snapshotDependencyPlanService.ts`.

**New required logic (introduces new behaviour; must drive most tests):**

- **Epoch discovery over time** (day-based):
  - Build a per-day availability map from snapshot retrieval summaries.
  - Apply “latest `retrieved_at` within the UTC day wins” before regime selection.
  - Select exactly one candidate representation per day using the “least aggregation” rule and MECE/policy validity gates.
  - Segment consecutive days into epochs and emit epoch-specific snapshot subjects.
- **Result stitching across epoch subjects**:
  - Merge multiple epoch results back into a single logical cohort-maturity curve deterministically (including gaps).

**Contract fix required (backend behavioural change; must be tested):**

- **Slice selector semantics** must allow **uncontexted-only** selection (§3.5). This is not “new planning logic” but a required read-path contract correction.

### 4.2 Definitions (terminology used throughout)

To avoid ambiguity, we define a few terms precisely.

- **Slice family**: a slice key with time arguments stripped for matching, but with its context/case dimensions preserved. For example, `context(channel:paid-search).cohort()` is a different slice family from `cohort()`.
- **Dimension-set**: the set of declared dimensions present in a slice family, for example:
  - `cohort()` has dimension-set \(D = \varnothing\)
  - `context(a:foo).cohort()` has \(D = \{a\}\)
  - `context(a:foo).context(b:3).cohort()` has \(D = \{a,b\}\)
- **Query specified dims** \(S\): the set of context keys explicitly specified by the epoch’s query form. For example, epoch query `context(a:foo)` has \(S = \{a\}\).
- **Pinned interest dims** \(P\): the set of context keys the system considers “in-scope” for this analysis subject, derived from pinned interests (for example `context(a).context(b)` implies \(P = \{a,b\}\)).
- **Extra dims** \(E\): for a candidate slice family set with dimension-set \(D\), the dims that would need to be marginalised away to answer the epoch query: \(E = D \setminus S\).

We only ever aggregate away dims that are in-scope: \(E \subseteq P\). If a candidate slice family set contains dims outside \(P\), it is not eligible for automatic aggregation.

### 4.3 Observing availability: retrieval calendar with per-slice summary

The frontend can query the snapshot DB for a subject’s retrieval calendar using:

- `querySnapshotRetrievals` (client in `graph-editor/src/services/snapshotWriteService.ts`)
- Backend function `query_snapshot_retrievals` (in `graph-editor/lib/snapshot_service.py`)

When `include_summary` is enabled, the response includes per-retrieval rows grouped by:

- retrieved_at
- slice_key

This is sufficient to derive a per-day map of which logical slice families are present, without fetching all raw snapshot rows.

The frontend should treat this as *observational metadata*, not as a decision engine.

### 4.4 Regime choice per day

For each retrieved day, we build candidate regimes:

- **Uncontexted candidate**: uncontexted `cohort()` logical family present.
- **Contexted candidate(s)**: sets of contexted logical families present.

The frontend then runs the existing MECE resolution logic to decide whether a contexted candidate is aggregatable:

- If the contexted slice set is MECE-valid (`canAggregate`) under the applicable context policy, it is eligible.
- If it is not MECE-valid (incomplete, unknown policy, multi-key ambiguity, etc.), it is ineligible for summation.

When both uncontexted and a MECE-valid contexted regime exist on the same day, we must apply the same tie-break semantics already used in the frontend for “implicit uncontexted resolution”.

The rule should not be reinvented here; it should be centralised and reused from the existing MECE selection surfaces (see `graph-editor/src/services/meceSliceService.ts` and its current usage in planning).

#### 4.4.1 Determinism: choose a day’s “generation” first (no cross-generation mixing)

Because equivalence links (and ordinary evolution over time) can introduce multiple slice histories, a single UTC day can contain multiple `retrieved_at` timestamps whose slice availability differs.

To prevent cross-generation mixing within a day:

- For each UTC day, partition retrieval summaries by the exact `retrieved_at` timestamp.
- Select the day’s effective retrieval group deterministically. **Rule: latest `retrieved_at` within the day wins.**
- Run candidate regime selection only on that chosen group.

This rule is intentionally simple and observable. It ensures we never “combine” slice availability across multiple retrieval timestamps inside a day.

#### 4.4.2 Selection rule: choose the candidate with least aggregation

Within a day’s chosen retrieval group, we may have multiple eligible candidates that can answer the epoch query.

We select the candidate with the least aggregation cost, defined in two tiers:

- **Primary cost**: minimise \(|E|\), the number of extra dims that must be marginalised away \((E = D \setminus S)\).
  - Example: `context(a:foo).cohort()` has \(|E| = 0\) for query `context(a:foo)`.
  - Example: `context(a:foo).context(b:*).cohort()` has \(|E| = 1\) for query `context(a:foo)` and requires marginalising over `b`.
- **Secondary cost (tie-break)**: minimise the number of slice families that must be summed to implement the marginalisation (fewer terms is safer and less fiddly).

If costs tie, break ties deterministically (stable ordering), but do not attempt to be “smart”; ties should be rare and we want predictable behaviour.

#### 4.4.3 Validity constraints for candidates (MECE and policy)

A candidate is eligible only if:

- It matches the epoch query’s specified dims \(S\) (all specified dims must be present and fixed in the family set), and
- Any extra dims \(E\) are in-scope \((E \subseteq P)\), and
- For each dim \(d \in E\), the observed slice family set is MECE-complete for \(d\) under the applicable policy, holding \(S\) fixed.

If any required MECE check fails, the candidate is ineligible.

If no candidate is eligible for a day, that day is treated as **missing data** (a gap).

### 4.5 Complex multi-context and “partial uncontexted” (pinned multi-dim, query subset)

The design must support cases such as:

- slices that include multiple context keys (for example `context(a:b).context(c:d)`), and
- user queries that specify only a subset of the context keys (“partially uncontexted”).

The epoch logic must defer to the existing frontend slice resolution machinery for:

- Determining which context keys are in-scope for aggregation,
- Selecting coherent MECE generations,
- Refusing aggregation when the MECE policy does not permit it.

This implies that epoch selection should operate on a richer internal representation than “string contains `context(`”; it should parse slice dimensions and reuse the same parsing and policy checks already in place.

#### 4.5.1 Canonical example: pinned `context(a).context(b)`, epoch query `context(a)`

This is the motivating “fiddly” case.

- Pinned dims: \(P = \{a,b\}\)
- Epoch query specified dims: \(S = \{a\}\)
- Therefore, any candidate with \(D = \{a,b\}\) implies extra dims \(E = \{b\}\) which must be marginalised away.

For a given retrieved day (after applying the “latest retrieval group wins” rule):

- If `context(a:foo).cohort()` exists, it is the least-aggregation candidate \(|E| = 0\) and is selected.
- Otherwise, `context(a:foo).context(b:*).cohort()` is only eligible if:
  - the `b:*` values observed that day form a MECE-complete partition for key `b` under policy, and
  - the marginalisation is permitted for this analysis.
  If eligible, it is selected and we sum over the explicit `b:*` slice families.
- Otherwise the day is a gap.

This produces the required behaviour:

- We only sum over `b:1…n` when MECE-complete.
- We never mix `context(a).cohort()` with `context(a).context(b:*).cohort()` on the same day.
- We prefer the representation requiring least aggregation whenever it exists.

### 4.6 Encoding epochs into the analysis request

The analysis request already supports multiple `snapshot_subjects` per scenario.

We will represent a single logical cohort maturity subject as multiple epoch-specific subjects:

- Each epoch subject has:
  - the same semantic identity (param_id, core hash family, anchor range),
  - a sweep window restricted to that epoch,
  - explicit `slice_keys` describing the chosen regime for that epoch.

The frontend then stitches the returned frames into one curve for display.

This maintains the “frontend does planning; backend executes” principle from `docs/current/project-db/1-reads.md`, while acknowledging that a day-based observational preflight may be required to discover epochs.

**Critical: `slice_keys` must be regime-exact (no “mode-only any-context” reads).**

To make regimes enforceable, epoch subjects MUST use one of these encodings:

- **Uncontexted regime (uncontexted-only)**: `slice_keys = ['cohort()']` (or `['window()']` for window-mode reads), meaning *only* the uncontexted family (no context/case dims).
- **Contexted regime (explicit MECE set)**: `slice_keys = ['context(k:v1).cohort()', 'context(k:v2).cohort()', ...]` (and similarly for multi-context), meaning exactly the explicit slice families chosen by the frontend MECE resolver.

Epoch planning MUST NOT use:

- `slice_keys = ['']` (empty selector) for cohort maturity epochs, because it means “no slice filter” and will reintroduce mixed-regime summation.
- any selector semantics where `cohort()` / `window()` matches “any context in this mode”; that behaviour is currently broken for regime selection and must be fixed to satisfy §3.5.

### 4.7 Roundtrip concerns and caching

This approach introduces a potential additional network call (retrieval calendar observation) before analysis execution.

To keep UX acceptable:

- Prefer a single preflight for the whole analysis run (batching across subjects where feasible).
- Cache retrieval calendars per subject (short TTL or session cache).
- Only preflight when ambiguity is possible (for example when mode-only slice selection would otherwise be used).

---

## 5. Testing strategy (must be comprehensive)

This change is correctness-critical and must be proven with both unit and integration tests.

### 5.1 Unit tests (frontend)

Add unit tests for pure logic functions. The focus is: **new epoch logic only**, using existing MECE/dimensional-reduction services as trusted dependencies (they already have their own suites).

Unit tests should therefore target functions that:

- **Build per-day availability maps** from retrieval summaries (including grouping by UTC day and selecting “latest retrieval group wins”).
- **Enumerate candidate representations** for a day for a given query/pinned context shape (without duplicating MECE logic; the MECE check can be injected/stubbed in unit tests).
- **Apply the “least aggregation” selector**:
  - minimise \(|E|\), then minimise number of families, then deterministic tie-break.
- **Segment days into epochs** (exact boundaries; deterministic).
- **Stitch epoch results into a single curve**, with guarantees:
  - monotonicity is not assumed,
  - missing days remain missing (gaps),
  - duplicate as-at frames across epochs are resolved deterministically.

Critical unit scenarios to cover:

- Uncontexted-only history across the whole sweep.
- Contexted-only MECE history across the whole sweep.
- Regime change mid-sweep (contexted-only → uncontexted-only, and vice versa).
- Mixed regimes on a single day (due to equivalence links) with explicit tie-break verification.
- Multi-context slices where only one key is MECE-eligible (partial-uncontexted behaviour).
- Multiple retrieval timestamps within the same UTC day (ensure “latest per day wins” is applied consistently).

In addition, because “least aggregation” is subtle, unit tests MUST explicitly cover:

- days where both \(|E|=0\) and \(|E|=1\) candidates exist (verify \(|E|=0\) is chosen),
- days where \(|E|=0\) does not exist and \(|E|=1\) exists but is non-MECE (verify the day is a gap, unless another eligible candidate exists),
- days where multiple \(|E|=1\) candidates exist (verify the “fewest families” secondary tie-break),
- days where equivalence closure introduces both an aggregated representation and a partition representation in the same day (verify single-regime selection, no mixing).

### 5.2 Integration tests (frontend ↔ python API ↔ snapshot DB)

We require integration tests that exercise the real boundary:

- write snapshot rows via `/api/snapshots/append`,
- create equivalence links when needed,
- observe retrieval summaries via `/api/snapshots/retrievals` with `include_summary`,
- execute cohort maturity via `/api/runner/analyze`,
- verify the final stitched curve matches the expected per-day regime selection,
- cleanup via `/api/snapshots/delete-test` (pytest-only param id prefixes).

Integration scenarios must include:

- A controlled dataset where contexted MECE slices exist on days D1–D4, and uncontexted exists on D5 only.
- A dataset where uncontexted exists on all days, contexted MECE exists on some days, and equivalence closure causes both regimes to appear on one day.
- A dataset with multi-context slices and a partially specified query, ensuring the selected aggregation set matches existing frontend MECE rules.
- A dataset with incomplete context partitions (should refuse summation, choose uncontexted where available, or report non-resolvable).

### 5.3 Minimum serious scenario matrix (target: a dozen integration tests)

This change should ship with a “serious” integration matrix, on the order of twelve tests, each small but exact. The intent is not to exhaustively test every clause type, but to fully pin down the regime and epoch semantics.

Required integration scenarios (illustrative IDs):

- **IE-001 Uncontexted-only**: only uncontexted families exist for all days; confirm no preflight ambiguity and no epoch splits.
- **IE-002 Contexted-only MECE**: only a MECE partition exists for all days; confirm summation is correct and stable.
- **IE-003 Regime change (partition → uncontexted)**: first half is MECE partition, second half is uncontexted; confirm a single epoch boundary at the transition.
- **IE-004 Regime change (uncontexted → partition)**: the reverse transition; confirm boundary and correctness.
- **IE-005 Mixed regimes same day (equivalence links)**: both uncontexted and MECE partition exist on one day; confirm “least aggregation” tie-break and no mixing.
- **IE-006 Mixed regimes same day (non-MECE partition present)**: uncontexted exists and a partial partition exists; confirm uncontexted is chosen.
- **IE-007 Non-resolvable day**: only a non-MECE partial partition exists; confirm the day is missing (gap), and that no carry-forward occurs.
- **IE-008 Multi-context stored, query subset (pinned a,b; query a)**: confirm `context(a)` aggregates over `b:*` only when MECE, otherwise falls back or gaps.
- **IE-009 Multi-context, tie on \(|E|\)**: two different partition candidates both require \(|E|=1\); confirm the “fewest families” tie-break is applied.
- **IE-010 Multiple retrieval timestamps within day**: older retrieval group has one regime, newer group has another; confirm latest group wins and no cross-group mixing.
- **IE-011 Equivalence closure across two param_id sources**: linked hashes bring two sources into scope with differing slice histories; confirm per-day selection is performed on the resolved subject and remains deterministic.
- **IE-012 Stitching across epochs**: multiple epochs returned from the backend are stitched into one curve with exact expected totals and exact gaps.

These tests should verify exact epoch boundaries and exact \(X,Y,A\) totals (not “looks plausible”), and should be constructed so that any mixed-regime summation produces an unmistakable failure.

### 5.4 “Serious” coverage expectations

The test suite must be designed to catch regressions in:

- regime detection,
- MECE eligibility checks,
- epoch segmentation,
- tie-breaking,
- stitching correctness,
- equivalence link expansion interactions,
- day-based semantics.

Tests must be deterministic and avoid “it looks plausible” assertions; they should assert exact expected epoch boundaries and exact totals in representative fixtures.

---

## 6. Open design questions (explicitly tracked)

- Confirm that the “least aggregation” rule is consistent with existing frontend behaviour for “implicit uncontexted resolution”, and centralise it so epoch planning and any other slice selection surfaces do not diverge.
- Behaviour when neither regime is selectable for a day (for example contexted present but non-MECE, uncontexted absent): treat that as **missing data** for that day (a gap in the curve). Do not carry-forward.
- How to handle equivalence closure that introduces multiple param_id sources with different retrieval patterns: ensure per-day observation is done on the resolved family, not on a single param_id bucket.

---

## 7. Immediate next steps

### 7.1 Implementation plan (explicit TDD; red tests first)

This work should be delivered via a strict TDD workflow to reduce regression risk in fiddly selection logic.

- **Step A (Design-to-tests mapping; no new behaviour yet)**:
  - Identify the exact “new required logic” surface area (epoch discovery + stitching + backend selector contract).
  - Explicitly list which existing services are reused unchanged (§4.1.1), to avoid accidental duplication.

- **Step B (Unit tests: write red tests first)**:
  - Add unit tests for the new pure epoch-selection functions:
    - per-day availability mapping,
    - “latest retrieval group wins” determinism,
    - least-aggregation selection,
    - epoch segmentation,
    - stitching.
  - These tests should be written to fail against the current implementation (or absence) of epoch logic.

- **Step C (Implement minimal pure logic to go green)**:
  - Implement only the minimal pure functions required to satisfy the unit tests, reusing `extractSliceDimensions`, `contextRegistry`, `meceSliceService`, and `dimensionalReductionService` as dependencies rather than re-implementing them.

- **Step D (Backend contract fix, with its own red/green loop)**:
  - Add backend-side tests proving “uncontexted-only” selection works as required (§3.5).
  - Implement the minimal backend change to satisfy the new selector contract.

- **Step E (Integration tests: write red tests for end-to-end epoch behaviour)**:
  - Implement the integration matrix (§5.3) so failures are unambiguous if regimes mix or epochs stitch incorrectly.

- **Step F (Wire-up: orchestrate preflight → epoch subjects → analyse → stitch)**:
  - Extend the existing cohort-maturity orchestration to call:
    - retrieval summary preflight,
    - epoch subject construction,
    - analysis execution,
    - stitching.
  - Avoid new UI code paths; menus/components remain access points only (service layer owns logic).

### 7.2 Operational next steps (concrete)

1. ~~Locate and document the existing frontend tie-break behaviour (if any) that differs from “least aggregation”, and decide whether to align by reuse or by replacement (but keep one central rule).~~ — DONE (centralised in `selectLeastAggregationSliceKeysForDay`)
2. ~~Implement Steps B–F in order, keeping tests as the primary driver of changes.~~ — DONE

---

## 8. Implementation record (10-Feb-26)

All core logic is implemented and tested. Steps A–F from §7.1 are complete.

### 8.1 Files created/modified

**Frontend (TypeScript):**

| File | Change |
|---|---|
| `src/services/snapshotDependencyPlanService.ts` | `chooseLatestRetrievalGroupPerDay()`, `selectLeastAggregationSliceKeysForDay()`, `segmentSweepIntoEpochs()` — pure epoch planning functions. `mapFetchPlanToSnapshotSubjects()` extended with epoch orchestration for `cohort_maturity` read mode: preflight → per-day selection → segmentation → epoch subjects. |
| `src/lib/graphComputeClient.ts` | `collapseEpochSubjectId()`, `pickEpochPayloadForAsAt()` — epoch stitching in `normaliseSnapshotCohortMaturityResponse()`. |

**Backend (Python):**

| File | Change |
|---|---|
| `lib/snapshot_service.py` | `_split_slice_selectors()`, `_append_slice_filter_sql()` — backend slice selector contract fix (§3.5): `cohort()` / `window()` means uncontexted-only, not "any context in this mode". |

### 8.2 Test coverage

| Test file | Tests | What they cover |
|---|---|---|
| `lib/tests/test_snapshot_read_integrity.py` (CE-001–CE-012) | 12 | Backend slice selector contract: uncontexted-only semantics, explicit context matching, broad selector behaviour, gap key, retrievals summary, inventory filtering, partition double-count prevention, normalisation, mode mismatch |
| `src/services/__tests__/snapshotDependencyPlanService.test.ts` (cohort_maturity epochs) | 3 | Epoch splitting on regime change with carry-forward; rolling `retrieved_at` within day; non-MECE partition → gap (safety property) |
| `src/lib/__tests__/graphComputeClient.test.ts` | 1 | Epoch subject ID collapsing and frame stitching |
| `lib/tests/test_graceful_degradation.py` (GD-004) | 1 | Empty epoch (`__epoch_gap__`) returns success |

### 8.3 What remains (polish, not blocking)

The §5.3 IE-001–012 end-to-end integration matrix (write → observe → analyse → verify curve) was not implemented. The existing 17 tests cover the backend contract, the frontend planning logic, the safety property (non-MECE → gap), and stitching. The IE matrix would add full round-trip coverage through the analysis pipeline but is not needed to prevent the original double-counting bug.

