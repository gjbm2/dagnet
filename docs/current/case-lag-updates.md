## Case lag + updates: cohort-aware case display, schedule semantics, and Statsig webhook refresh

**Date:** 9-Jan-26  
**Status:** Design / implementation plan (not yet implemented)  
**Primary goal:** Make case node variant weights **slice-correct** (window vs cohort), historically auditable, and refreshable via Statsig-triggered automation.

---

### Background and problem statement

DagNet supports “case nodes” to represent traffic splits across experiment variants. Today, case variant weights can be fetched (direct or versioned) and displayed in the UI, and case constraints can be used in query DSL. However:

- The **UI displays whatever weights happen to be present on the graph node**, which can drift from the weights that are relevant to the currently selected analytic slice.
- The **cohort() view semantics** introduce time-lag between cohort entry and arriving at the case node; selecting variant weights using the raw cohort dates is not necessarily correct.
- Versioned case history exists (schedules), but the end-to-end contract for schedule shape, closure, coverage, and “which schedules apply to which slice” needs to be hardened and surfaced clearly.
- External updates (Statsig weight changes) require manual refresh; the desired behaviour is automatic refresh on upstream change, with local persistence and proper provenance.

This document enumerates the design decisions and implementation work required to address the above.

---

### Goals

- **Slice-correct display**: When the user is in `window()` mode, the displayed case weights should correspond to that window; when the user is in `cohort()` mode, the displayed weights should correspond to the distribution of case arrivals induced by the cohort slice (a lag-aware mapping).
- **Explicit provenance and history**: Users should be able to answer “what changed and when?” for case weights, ideally at the case node and (where possible) in a graph-wide view.
- **Deterministic selection rules**: For any DSL slice, case weights selection must be deterministic and auditable (and consistent between planner/execution and UI).
- **Automated refresh**: A Statsig webhook should be able to trigger a local API endpoint that runs a versioned refresh for the impacted case(s), updating the case file history and then updating graph node display.
- **No business logic in UI**: All decisions and transformations must live in services / lib, not in menu files or UI components.

---

### Non-goals (for this phase)

- Building a full “case history explorer” UI akin to a full audit UI (we may implement minimal surfacing and defer a richer explorer).
- A perfect statistical convolution of every upstream latency distribution for every path in real-time; the first iteration should choose a safe, well-defined approximation.
- Supporting every possible experiment platform; this plan focuses on Statsig because it is the stated requirement.

---

### Current implementation notes (as of 9-Jan-26)

- The query DSL supports `case(key:variant)` and it propagates into query payloads and signatures.
- The Amplitude adapter applies case filters as user-property segment filters (assuming an `activeGates.*` instrumentation convention).
- Versioned case fetch appends schedule snapshots; there is a window aggregation service for schedules (including time-weighted averaging), and a staleness rule for cases.
- The current “get case from file” path supports windowed aggregation only when the caller passes a window; it does not robustly derive that from the active DSL, and schedule storage shape is not treated as a single canonical source (legacy vs nested forms exist).

---

## Workstream A — Canonical case schedule data model and invariants

### A1) Canonical schedule location and schema

**Decision required:** choose a single canonical schedule location in case files.

- Proposed canonical location: `case.schedules[]`
- Backwards compatibility: read legacy `schedules[]` if present, but write only to the canonical location.

**Canonical schedule entry fields (minimum):**
- `window_from`: start timestamp for when this schedule became effective
- `window_to`: end timestamp for when this schedule stopped being effective (null/empty means “ongoing”)
- `variants`: list of `{ name, weight }`
- `retrieved_at`: timestamp of retrieval from source (or write)
- `source`: provider label (e.g. `statsig`) and optionally connection name
- Optional: `query_signature` (to bind schedule data to the retrieval slice family / mode where relevant)
- Optional: `debug_trace` / request metadata for diagnosis (stored sparingly to avoid file bloat)

**Invariant:** schedules must be interpretable as a timeline without ambiguity:
- Ongoing schedules must have `window_to` unset/null.
- If multiple schedules exist, their effective windows must not overlap in a way that makes selection ambiguous.

### A2) Schedule closure policy

**Decision required:** when appending a new schedule entry, do we automatically close the prior schedule’s `window_to`?

Proposed default policy:
- When writing a new schedule entry with `window_from = now`, set the immediately previous schedule’s `window_to = now` if it is currently null.

Rationale:
- Prevent indefinite overlap.
- Enable time-weighted aggregation and “what applied during this window?” to work deterministically.

Edge cases to specify:
- Multiple updates in quick succession.
- Out-of-order writes (should be prevented by writing only “now”, but webhook retries could produce duplicates).

### A3) Idempotency and duplicate suppression

**Decision required:** define what constitutes a “duplicate schedule entry” for the same effective time.

Proposed rule:
- If a new schedule entry has the same `window_from` (or is within a small tolerance) and the same variant weights, treat it as a no-op.
- If same `window_from` but different weights, treat as conflict and surface as a warning (do not silently overwrite).

---

## Workstream B — Slice-correct selection of variant weights for display and computation

### B1) Centralised “case slice resolution” service

Create a dedicated service responsible for determining the case weights to apply for the current slice.

Responsibilities:
- Parse the authoritative DSL (from the graph store / scenario state).
- Determine whether the slice is `window()` or `cohort()`.
- Resolve an “effective evaluation window” for the case node.
- Select/aggregate schedules from the case file for that effective window.
- Return both:
  - the weights to apply, and
  - diagnostics (coverage percentage, schedules used, warnings).

**Invariant:** planner/execution/UI must call the same service for selection semantics.

### B2) Window() semantics

For `window(a:b)`:
- Select schedules that overlap the window and compute the effective weights for that window.
- If coverage is partial (no schedules cover part of the window), surface a warning and clearly indicate “fallback used” or “coverage incomplete”.

### B3) Cohort() semantics (lag-aware mapping)

For `cohort(a:b)`:

We need to map a cohort entry window to a distribution over “arrival times at the case node”. This requires deciding:

- **Lag reference point**: what is “time zero” for the cohort? Typically the cohort anchor entry event in cohort semantics.
- **Lag estimate to the case node**: how to estimate the time offset between cohort entry and reaching the case node.
- **How to mix schedules**: whether to:
  - approximate with a shifted/expanded window, or
  - do a weighted mix using a lag distribution.

**Design decisions required (must be resolved before implementation):**

1) **Mapping strategy**
   - Option 1: simple window expansion (conservative)
     - Effective case window = \([cohortStart, cohortEnd + lagUpper]\)
   - Option 2: shifted window (sharper)
     - Effective case window = \([cohortStart + lagMedian, cohortEnd + lagUpper]\)
   - Option 3: weighted mixture (“convolution-like”)
     - Estimate a lag distribution to the case node; integrate schedule weights across time using that distribution.

2) **Lag source**
   - Use existing path-level latency summaries (`path_t95`, `t95`) where available.
   - Decide whether to derive:
     - lag to the case node from the cohort anchor using graph traversal, or
     - lag using only local edge latency metadata (less accurate).

3) **Multi-path behaviour**
   - How to combine multiple paths to the case node (max, weighted by forecast flow, or another rule).

**Proposed first iteration (subject to approval):**
- Implement Option 1 or 2 using a single lag bound derived from existing latency metadata, then iterate to Option 3 if/when needed.
- Ensure the chosen approximation is:
  - deterministic,
  - logged (so users can see “we used lag=Xd to map cohort→case”), and
  - testable.

### B4) Where the resolved weights live

**Decision required:** do we overwrite `graph.nodes[].case.variants` with the slice-correct weights, or do we render slice-correct weights as an overlay without mutating the graph?

Considerations:
- Mutating the graph makes UI rendering simpler but risks confusing “persisted” vs “derived for the current slice”.
- Overlay rendering avoids persistence confusion but requires UI to read from a separate derived store.

Proposed approach:
- Store slice-correct weights in a derived, non-persisted structure (or a dedicated evidence/provenance block) and render from that.
- If we must mutate the graph for now, ensure:
  - it is clearly tagged as “derived” (not user-edited),
  - it does not set override flags in a way that blocks future refreshes,
  - and it does not get written back to the case file unless explicitly requested.

---

## Workstream C — UI surfacing (without embedding logic in UI)

### C1) Node-level display expectations

Case node UI should show:
- The variant names and effective weights **for the current slice**.
- A visible indicator when:
  - schedules do not fully cover the slice window, or
  - the cohort→case lag mapping was approximated (and which approximation was used).

### C2) Properties panel / details view

Add a properties section for case nodes that shows:
- Effective weights for the active slice.
- The schedule entries used (count and time span).
- Retrieval provenance (retrieved_at, source).
- A human-readable summary of the lag mapping when in cohort mode.

### C3) Graph-wide surfacing (optional but desirable)

Add a lightweight “case freshness / drift” view that can:
- list cases referenced by the graph,
- show whether they are stale by the staleness policy,
- show last retrieved timestamp,
- offer a one-click “refresh cases” action (implemented as a service call).

---

## Workstream D — Fetch planning, cache/staleness, and execution parity

### D1) Planner semantics for cases

Currently, case planning tends to treat cases as “covered” if any case file exists. For slice-correct behaviour, the planner must understand:
- whether schedules cover the effective window for the current DSL slice (window or cohort-mapped window),
- whether the most recent schedule is stale (time since retrieved),
- and whether missing schedule coverage should cause a “needs fetch” classification.

**Decision required:** should missing schedule coverage block “covered” status (like parameters do), or be treated as “warning but proceed”?

### D2) Auto-aggregation from file

When the user changes DSL (or scenario), the system should:
- re-resolve case weights for the slice and refresh the node display using the centralised service,
- in the same way that parameters are aggregated from file when covered.

---

## Workstream E — Statsig webhook → local API → versioned refresh

### E1) Desired behaviour

When a Statsig gate/experiment weight changes:
- Statsig triggers a webhook to DagNet.
- DagNet validates the request, maps it to one or more case ids, and runs a **versioned retrieve** for those cases.
- DagNet appends a schedule entry (closing the previous schedule if needed), records provenance, and updates any currently-open graphs that reference the case so the UI reflects the new weights.

### E2) Statsig configuration work (external)

Steps (to be performed by an operator with Statsig access):
- Create/configure a webhook in Statsig for the relevant project/environment.
- Choose the event type(s) that correspond to gate config changes (and confirm payload content).
- Configure a secret (or signing key) for request verification.
- Set the destination URL to the DagNet local API endpoint (or a tunnel / reverse proxy if required).

### E3) Local API endpoint in DagNet

**Decision required:** where to implement the endpoint.

Options:
- Add an endpoint to the existing Python dev server (if that is the intended long-lived local API surface).
- Add an endpoint to an existing Node server component (if present), or introduce a minimal server if one already exists for local tooling.

Requirements for the endpoint:
- Authenticate and validate webhook requests (signature/secret, timestamp, replay protection).
- Parse payload and extract an identifier (gate id / experiment id).
- Map that identifier to one or more DagNet case ids (see E4).
- Enqueue or execute the versioned case refresh.
- Return a clear success/failure response to Statsig.

Operational safety requirements:
- Idempotency: webhook retries must not create duplicate schedule entries.
- Rate limiting: prevent thundering herds if many changes occur.
- Observability: session logging entries for received webhooks and resulting refresh operations.

### E4) Mapping Statsig identifiers to DagNet case ids

We need an explicit mapping policy:
- Current convention-based mapping: `caseId` transforms to `gate_id` by replacing `-` with `_`.
- Webhook payloads may present gate id in a different normal form. Define:
  - canonicalisation rules (underscores vs hyphens, prefixes, etc.),
  - how to handle ambiguous matches,
  - and how to handle “no matching case found”.

Optional improvement:
- Allow case files to explicitly declare a Statsig id (gate id / experiment id) to avoid relying on naming conventions.

### E5) Triggering the versioned retrieve

The endpoint should call the same service path as the UI’s “versioned get from source for case”, so there is only one code path.

Implementation expectations:
- The service should:
  - fetch from Statsig using the configured connection,
  - append a schedule entry with `window_from` corresponding to the effective time (likely “now”, but define precisely),
  - close the previous schedule window if applicable,
  - update any open graph views to reflect the new slice-correct weights.

### E6) Security and environment handling

Define how local dev vs production should behave:
- For local dev, webhooks may be delivered via a tunnel; document the operational workflow.
- Secrets must not be committed. Use environment variables or credentials manager entries.
- Ensure we do not allow arbitrary callers to trigger data operations without validation.

---

## Workstream F — Session logging and provenance

All external/data operations require session logging:
- Webhook receipt and validation outcomes.
- Case refresh operations (start, success, failure).
- Schedule append actions (including schedule closure).
- Case slice resolution decisions in cohort mode (including lag values used and coverage).

Ensure logs include enough metadata to diagnose:
- “Why did the UI show this variant mix for this slice?”
- “What schedule entries were used?”
- “Which webhook caused this update?”

---

## Workstream G — Testing strategy (plain English only)

### Test policy note
Per repository rules, updating existing tests requires explicit user authorisation. This plan anticipates changes that will likely require extending or updating existing tests (especially around `getCaseFromFile`, planning, and UI display state).

### Required tests (minimum)

- **Schedule parsing + canonicalisation**
  - Reading schedules from canonical nested location.
  - Reading legacy root schedules (if present) and treating them equivalently.
  - Ensuring writes go only to the canonical location.

- **Schedule closure**
  - Appending a new schedule closes the previous schedule window.
  - Duplicate suppression behaves as defined (no-op vs conflict).

- **Window slice selection**
  - Given a window and schedules, the resolved weights match the expected time-weighted result.
  - Coverage warnings appear when schedules do not cover the window.

- **Cohort slice mapping**
  - Given a cohort slice and a chosen lag mapping strategy, the effective case window is computed deterministically.
  - The resolved weights match the schedules expected under that mapping.
  - The mapping decision is logged / surfaced in diagnostics.

- **Planner/execution parity**
  - The fetch planner and the execution path use the same case slice resolution logic for the same DSL.

- **Webhook flow**
  - Webhook authentication is enforced.
  - Mapping from Statsig gate id to case id is correct under the chosen policy.
  - A webhook triggers exactly one versioned refresh operation (idempotent).
  - The case file schedules update and the graph display updates as expected.

---

## Open questions to resolve before implementation

- Cohort→case mapping strategy (simple expand vs shifted vs weighted mixture).
- How to compute lag to a case node (which latency metrics, how to combine multiple paths).
- Whether case weights should be stored as derived overlay state or written into the graph node fields.
- Planner semantics for “missing schedule coverage”: block fetch coverage vs warn-and-proceed.
- Canonical case file schema fields for Statsig id mapping (explicit field vs naming convention).
- Endpoint hosting choice (Python dev server vs other runtime), and production deployment expectations.

---

## Suggested implementation sequencing (high-level)

- Phase 1: Canonicalise schedule shape + closure + idempotency rules in services.
- Phase 2: Implement centralised case slice resolution for `window()` and wire UI display to it.
- Phase 3: Add cohort-aware mapping once mapping strategy + lag source are decided.
- Phase 4: Update planner to reason about case coverage/staleness using the same resolver.
- Phase 5: Add Statsig webhook endpoint + secure validation + versioned refresh trigger.
- Phase 6: Add/extend tests for the above, with explicit approval for any existing test edits.


