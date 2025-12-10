## Auto-Fetch Behaviour for Window and Cohort Queries

This document defines the **behavioural contract** for how the graph editor decides when to:

- **Auto-read from cache** (what we are calling “auto-fetch” here), and
- **Require an explicit user Fetch action** (Get from source),

for `window()` and `cohort()` queries, including context and MECE handling.

This is a *behaviour spec*, not an implementation plan. It is written to be testable and unambiguous.

---

### 1. Core Concepts

- **Slice family**: All `ParameterValue` entries that share the same **non-window, non-cohort** slice dimensions:
  - Same edge / parameter id.
  - Same context dimensions (e.g. `context(channel:google)`).
  - Same case / cohort anchor semantics.
  - May differ in `window()` or `cohort()` date ranges, but are otherwise the “same” slice.

- **Cohort vs window mode**:
  - **Cohort mode**: Slices whose canonical `sliceDSL` includes `cohort(…)`. Their date range is determined by `cohort_from` / `cohort_to`.
  - **Window mode**: Slices whose canonical `sliceDSL` includes `window(…)`. Their date range is determined by `window_from` / `window_to`.

- **Context coverage**:
  - We always evaluate coverage **within the correct slice family**.
  - That means we look *only* at entries whose `sliceDSL` matches the query’s context and case constraints (including MECE aggregation rules for uncontexted queries on contexted-only files).
  - We **never** borrow coverage across unrelated contexts or cases.

- **Date coverage**:
  - For a given slice family and a given query window (start and end), we ask:
    - “Is this date range **inside** a previously fetched `cohort()` or `window()` slice of the appropriate type, for this family?”
  - This is a property of:
    - The slice’s header range (`cohort_from`/`cohort_to` or `window_from`/`window_to`), and
    - The type of the slice (`cohort` vs `window`).
  - **Crucially**, this is *not* a question about whether the file has a non-zero `n_daily` value for every day:
    - It is entirely possible that a cohort or window slice legitimately contains days with zero traffic.
    - Those days still count as **covered** if they are within the slice’s declared date range.

---

### 2. What “Previously Fetched” Means

For a given query:

- Query has:
  - A **slice type**: `cohort()` or `window()`.
  - A **date range**: `[query_start, query_end]`.
  - A **slice family identity** (context and case dimensions, including MECE semantics).

- The system has a set of stored slices (`ParameterValue` entries) for that parameter.

**Definition: “Previously fetched”**

1. We isolate to the correct **slice family**:
   - Filter the stored values down to those whose `sliceDSL` matches the query’s context and case constraints, including:
     - Pure context matches (e.g. only `…context(channel:google)` for a `channel:google` query).
     - MECE aggregation rules for uncontexted queries when only contexted data exists (as specified elsewhere in the design).

2. Within that family, we select only slices of the **correct type**:
   - For a `cohort()` query, we only consider `cohort()` slices.
   - For a `window()` query, we only consider `window()` slices.

3. For those slices, we look at their **declared date coverage**:
   - Cohort slices: the range `[cohort_from, cohort_to]`.
   - Window slices: the range `[window_from, window_to]`.

4. The query is considered **“previously fetched”** exactly if:
   - The entire query date range `[query_start, query_end]` lies **inside at least one** stored slice of the correct type in this family.
   - In other words, for at least one slice:
     - `slice_start ≤ query_start` **and**
     - `slice_end ≥ query_end`.

Notes:

- The presence or absence of `dates[]`, `n_daily[]`, or `k_daily[]` at particular indices **does not change coverage**:
  - If `query_start` to `query_end` is contained within a slice’s header dates, then those dates are considered **fetched**.
  - Sparsity within the slice (e.g. days with no data) is normal and not a coverage failure.
- If the query’s date range is only *partially* inside the stored slice (e.g. query extends beyond `slice_end`), that does **not** count as “previously fetched”.

---

### 3. Auto-Fetch Behaviour: Cache vs Source

The system distinguishes **two different operations**:

1. **Auto-read from cache** (what we call “auto-fetch” here):
   - Reading parameter values from files / IndexedDB for a new query.
   - Running the appropriate aggregation, evidence, and forecast computations.
   - Updating the graph automatically when the user changes dates or slice DSL.

2. **Fetch from source**:
   - Executing the external query against a remote data source (e.g. Amplitude).
   - Merging results back into parameter files.
   - Potentially recomputing forecast and latency on merge.
   - Always initiated by the user via the **Fetch button**, never automatically.

The **auto-fetch behaviour** we care about in this document is the decision:

> “When a user changes the query (dates, slice DSL), do we automatically read from cache and update the graph, or do we require them to press Fetch first?”

---

### 4. Behavioural Rules

Given a query and the current parameter file state for a particular edge:

#### 4.1 Case A – Fully Covered by Previously Fetched Slices

Conditions:

- We have **at least one** stored slice in the correct slice family whose:
  - Type matches the query (`cohort` vs `window`), and
  - Header date range fully contains `[query_start, query_end]`.

Behaviour:

- The query is considered **previously fetched**.
- The system **must**:
  - Automatically read from cache.
  - Run the normal aggregation and evidence/forecast computation path.
  - Update the graph without any user interaction.
- There is **no need** to show an urgent Fetch button for coverage reasons:
  - The user may still fetch from source if they explicitly choose to (e.g. to refresh stale data), but coverage does not demand it.

#### 4.2 Case B – Not Fully Covered (Any Date Outside All Matching Slices)

Conditions:

- For the correct slice family and slice type, **no stored slice** fully contains the query window.
- This includes:
  - Query ranges that lie completely outside all stored slices (e.g. December cohort when only September–November cohorts are stored).
  - Query ranges that only partially overlap stored slices (e.g. window that extends beyond the cached window).

Behaviour:

- The query is considered **not previously fetched**, even if:
  - Some portion lies inside a stored slice, or
  - Some daily data would be available for part of the range.
- The system **must not**:
  - Automatically synthesise a new “answer” from whatever partial coverage happens to exist.
  - Silently apply a partial curve or partial scalar as if it were authoritative for the requested range.
- Instead, the system **must**:
  - Mark the parameter as **“needs fetch”** for this query window and slice family.
  - Drive the UI into a state where:
    - The **Fetch button is clearly visible and enabled** as the next action.
    - The graph does **not** present a new result for this window until the user has fetched.
    - The panel presents a clear message (exact wording is a UI concern) indicating that this window has not yet been fetched from source.

Logging:

- This is **not** a hard error.
- It should be logged as a normal or warning-level condition such as:
  - “No cached data for requested window” or
  - “Requested window not fully covered by existing slices”.
- It should **not** be reported as a GET_FROM_FILE failure.

---

### 5. Interaction with Context and MECE

Contexted data and MECE aggregation influence **which slices** count towards coverage, not **how coverage is evaluated**.

#### 5.1 Contexted Queries

- For a query with context (e.g. `context(channel:google)`):
  - Only slices whose `sliceDSL` matches that context are considered part of the slice family for coverage:
    - `…context(channel:google)` counts.
    - `…context(channel:organic)` and other contexts **do not** count.
  - Coverage is then computed exactly as above, but strictly within that context slice family.

#### 5.2 Uncontexted Queries on Contexted Files (MECE)

- When a file has **only contexted slices** and the query has **no context**, MECE aggregation semantics apply (as defined in the wider design):
  - We treat the collection of slices as a MECE partition.
  - For coverage, a date is considered **covered** only if it is covered by **all** slices participating in the MECE group.
  - Only then is the uncontexted query considered “previously fetched”.
- If any slice in the MECE set does not cover the full query window, the uncontexted query should be treated as **not previously fetched** for coverage purposes, and the Fetch button should be required.

---

### 6. What Does Not Matter for Coverage

To avoid confusion, the following **do not** affect the coverage decision:

- Whether the data is **mature** with respect to `t95` or `maturity_days`.
  - Maturity is a **quality** and **refetch policy** concern, not a coverage concern.
  - Immature but present data still means “we fetched this date”.
- Whether `n_daily` or `k_daily` is zero or non-zero on a given day.
  - Zero-traffic days are still part of the slice’s coverage.
- Whether an aggregate `mean` or `n` has been pre-computed for that window or cohort.
  - Coverage is based on the slice’s declared date range, not on the presence of aggregates.

These factors may influence:

- How we choose to **refetch** (e.g. `shouldRefetch` decisions like `gaps_only`, `partial`, `replace_slice`, `use_cache`), and
- How we interpret or decorate the data (e.g. warnings about immaturity),

but they do **not** change whether the window is considered “previously fetched” for the purposes of auto-fetch behaviour.

---

### 7. Sample Workspace Behaviour

The sample file set is a special case:

- It acts as a **pre-populated cache** only.
- There is no real external source connected.

Behavioural expectations:

- For queries whose windows **are fully covered** by the sample slices:
  - Auto-read from the sample files exactly as in a real workspace.
- For queries whose windows are **not fully covered** by sample slices:
  - Treat them as **not previously fetched**.
  - Do **not** auto-synthesise answers from partial coverage.
  - Show a state equivalent to “no cached data for this window”.
  - The Fetch button behaviour in this workspace may be:
    - Disabled with an explanatory tooltip, or
    - Wired to a simulated fetch, but **must not** generate hard errors for missing sample data.

The key property is that the sample workspace still respects the **same coverage contract** as a real workspace; the only difference is what happens when the user asks to fetch from source.

---

### 8. Testability

To ensure the implementation matches this behaviour:

- We must have tests that:
  - Construct parameter files with specific cohort and window slices (with known `cohort_from` / `cohort_to` / `window_from` / `window_to` and contexts).
  - Run the coverage logic for a variety of queries:
    - Exact matches inside a single slice.
    - Narrower windows fully inside a slice.
    - Wider windows that extend beyond a slice.
    - Queries entirely outside all slices.
    - Contexted vs uncontexted queries, including MECE scenarios.
  - Assert that:
    - The auto-fetch decision (“previously fetched or not”) depends **only** on:
      - Slice type (cohort vs window),
      - Correct slice family isolation (context, case, MECE),
      - Header date coverage (`cohort_from` / `cohort_to` / `window_from` / `window_to`).
    - It does **not** depend on:
      - Maturity of data,
      - Presence of non-zero daily counts,
      - Presence of pre-computed aggregates.

This document should be treated as the reference for those tests and for any future refactors of the fetch automation logic.




