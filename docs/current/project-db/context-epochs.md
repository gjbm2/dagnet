# Context epochs: regime-safe cohort maturity under mixed slice histories
**Status**: Draft (proposed)  
**Date**: 9-Feb-26  
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

### 4.2 Observing availability: retrieval calendar with per-slice summary

The frontend can query the snapshot DB for a subject’s retrieval calendar using:

- `querySnapshotRetrievals` (client in `graph-editor/src/services/snapshotWriteService.ts`)
- Backend function `query_snapshot_retrievals` (in `graph-editor/lib/snapshot_service.py`)

When `include_summary` is enabled, the response includes per-retrieval rows grouped by:

- retrieved_at
- slice_key

This is sufficient to derive a per-day map of which logical slice families are present, without fetching all raw snapshot rows.

The frontend should treat this as *observational metadata*, not as a decision engine.

### 4.3 Regime choice per day

For each retrieved day, we build candidate regimes:

- **Uncontexted candidate**: uncontexted `cohort()` logical family present.
- **Contexted candidate(s)**: sets of contexted logical families present.

The frontend then runs the existing MECE resolution logic to decide whether a contexted candidate is aggregatable:

- If the contexted slice set is MECE-valid (`canAggregate`) under the applicable context policy, it is eligible.
- If it is not MECE-valid (incomplete, unknown policy, multi-key ambiguity, etc.), it is ineligible for summation.

When both uncontexted and a MECE-valid contexted regime exist on the same day, we must apply the same tie-break semantics already used in the frontend for “implicit uncontexted resolution”.

The rule should not be reinvented here; it should be centralised and reused from the existing MECE selection surfaces (see `graph-editor/src/services/meceSliceService.ts` and its current usage in planning).

### 4.4 Complex multi-context and “partial uncontexted”

The design must support cases such as:

- slices that include multiple context keys (for example `context(a:b).context(c:d)`), and
- user queries that specify only a subset of the context keys (“partially uncontexted”).

The epoch logic must defer to the existing frontend slice resolution machinery for:

- Determining which context keys are in-scope for aggregation,
- Selecting coherent MECE generations,
- Refusing aggregation when the MECE policy does not permit it.

This implies that epoch selection should operate on a richer internal representation than “string contains `context(`”; it should parse slice dimensions and reuse the same parsing and policy checks already in place.

### 4.5 Encoding epochs into the analysis request

The analysis request already supports multiple `snapshot_subjects` per scenario.

We will represent a single logical cohort maturity subject as multiple epoch-specific subjects:

- Each epoch subject has:
  - the same semantic identity (param_id, core hash family, anchor range),
  - a sweep window restricted to that epoch,
  - explicit `slice_keys` describing the chosen regime for that epoch.

The frontend then stitches the returned frames into one curve for display.

This maintains the “frontend does planning; backend executes” principle from `docs/current/project-db/1-reads.md`, while acknowledging that a day-based observational preflight may be required to discover epochs.

### 4.6 Roundtrip concerns and caching

This approach introduces a potential additional network call (retrieval calendar observation) before analysis execution.

To keep UX acceptable:

- Prefer a single preflight for the whole analysis run (batching across subjects where feasible).
- Cache retrieval calendars per subject (short TTL or session cache).
- Only preflight when ambiguity is possible (for example when mode-only slice selection would otherwise be used).

---

## 5. Testing strategy (must be comprehensive)

This change is correctness-critical and must be proven with both unit and integration tests.

### 5.1 Unit tests (frontend)

Add unit tests for pure logic functions that:

- Normalise slice keys to logical families (window/cohort args stripped; canonical clause ordering expectations).
- Build per-day availability maps from retrieval summaries.
- Validate MECE eligibility of a candidate context slice set (including:
  - unknown policy,
  - incomplete partitions,
  - multi-key partitions,
  - contextAny and other non-aggregatable constructs).
- Choose a regime on tie days using the existing implicit-uncontexted selection semantics.
- Segment days into epochs and produce deterministic epoch boundaries.
- Stitch epoch results into a single maturity curve, with guarantees:
  - monotonicity is not assumed,
  - missing days are handled consistently,
  - duplicate as-at days across epochs are resolved deterministically.

Critical unit scenarios to cover:

- Uncontexted-only history across the whole sweep.
- Contexted-only MECE history across the whole sweep.
- Regime change mid-sweep (contexted-only → uncontexted-only, and vice versa).
- Mixed regimes on a single day (due to equivalence links) with explicit tie-break verification.
- Multi-context slices where only one key is MECE-eligible (partial-uncontexted behaviour).
- Multiple retrieval timestamps within the same UTC day (ensure “latest per day wins” is applied consistently).

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

### 5.3 “Serious” coverage expectations

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

- Tie-break semantics when both regimes exist on the same day: confirm the current frontend rule used in fetch planning / implicit uncontexted resolution and reuse it.
- Behaviour when neither regime is valid for a day (for example contexted present but non-MECE, uncontexted absent): define whether the chart should:
  - omit the day,
  - carry-forward last valid day,
  - or fail the subject with a clear error.
- How to handle equivalence closure that introduces multiple param_id sources with different retrieval patterns: ensure per-day observation is done on the resolved family, not on a single param_id bucket.

---

## 7. Immediate next steps

1. Locate and document the existing frontend tie-break rule for “explicit uncontexted vs MECE partition” (expected in `graph-editor/src/services/meceSliceService.ts` and its planner call sites).
2. Design the epoch selection and stitching functions as pure, testable utilities.
3. Wire cohort maturity analysis orchestration to:
   - preflight retrieval summaries (cached/batched),
   - build epoch-specific subjects,
   - execute and stitch results.
4. Implement the full unit + integration test matrix described above before declaring the behaviour safe.

