## Window Fetch Planner Service – Design

**Date:** 9-Dec-25  
**Status:** Draft for review  
**Related docs:** `design.md`, `auto-fetch-redux.md`, `window-cohort-caching-fixes.md`, `cohort-window-fixes.md`

---

## 1. Purpose and Scope

The purpose of this document is to define a dedicated window fetch planner service and the associated refactor of the window selector fetch logic.

The planner will answer, for any given graph and query:

1. Whether the query is certainly covered by cached data for all fetchable items.
2. Whether there are gaps that can be filled by fetching from external sources.
3. Whether the cached data is complete but likely stale, so that a refreshed fetch is desirable.

The scope is limited to:

- Planning and triggering of fetches for the graph level window selector.
- Coverage and freshness decisions for parameters and cases connected to external data sources.
- Refactors needed in the window selector component and existing aggregation utilities so they use a single, shared decision path.

Out of scope:

- Changes to external data source adapters.
- Changes to query syntax or semantics beyond what is already defined in `design.md`.
- Changes to the low level maturity and latency mathematics, except where a simple classification hook is required.

---

## 2. Background and Problems with Current Behaviour

The current behaviour is described in `auto-fetch-redux.md` and existing window selector code. The main issues are:

1. Coverage and fetch trigger decisions are split across multiple places in the window selector, with duplicated logic and separate iterations over graph edges and nodes.
2. Two different coverage utilities are used independently, with potential disagreement between them.
3. There is no explicit representation of the three user outcome states that the product actually needs:
   - Query is certainly within cache and stable.
   - Query is not within cache and needs a fetch.
   - Query is covered by cache but newer data may be available.
4. The decision about whether cached data is merely complete or also effectively fresh is implicit, spread across several layers, and difficult to change safely.
5. The fetch button behaviour and the auto aggregation behaviour are coupled through incidental state rather than a shared, declarative plan.

The result is a component that:

- Is hard to reason about and modify.
- Can disagree with itself about whether a fetch is needed.
- Cannot easily support richer user interface states such as a distinct “Fetch latest” call to action.

---

## 3. Target Outcomes

### 3.1 User Outcome States

The new design must support three explicit, mutually exclusive user outcome states, evaluated on load and on every query change:

1. **Covered and stable**
   - All fetchable items are fully covered by cached data for the current query window.
   - There is no strong reason to believe a re fetch would materially change the aggregates.
   - Behaviour:
     - Auto aggregate from cache where possible.
     - Show a neutral fetch button state with a tooltip that explains that data is already fully covered.

2. **Not covered – missing data**
   - At least one fetchable item is not covered by cached data for the current query window.
   - Behaviour:
     - Auto aggregate from cache for items that are fully covered.
     - Show a “Fetch data” call to action with the button enabled.
     - Provide a tooltip that summarises the missing coverage, for example by reporting missing dates and affected parameters.

3. **Covered but potentially stale**
   - All fetchable items are covered by cached data for the current query window.
   - One or more items are likely to be stale, for example because cohorts that were immature at last fetch have now matured.
   - Behaviour:
     - Auto aggregate from cache for all covered items.
     - Show a “Fetch latest” call to action with the button enabled.
     - Provide a tooltip that explains why a refresh might be valuable, for example immature cohorts that may now have matured.

File only gaps, where there is no external connection, should never force a “needs fetch” outcome, but should still be reported clearly so the user is not surprised by missing data.

### 3.2 Architectural Outcomes

Architecturally, the new design should deliver:

- A single, centralised planning function in the service layer that determines coverage, staleness, and fetch requirements.
- A clear separation between:
  - Planning, which is a pure analysis step.
  - Execution, which performs network fetches and merges new data into files.
- A thinner window selector component that:
  - Delegates coverage and freshness decisions to the planner.
  - Consumes a declarative planner result to decide:
    - Whether to auto aggregate.
    - How to render the fetch button and its tooltip.
    - Which toasts or messages to show.

---

## 4. High Level Design

### 4.1 Planner Responsibilities

The window fetch planner will be a service that:

1. Accepts, as input:
   - The current graph, including edges and nodes.
   - The authoritative query representation from the graph store, including date window and any context clauses.
   - Any relevant maturity and latency configuration for edges, as already stored on the graph and its probability parameters.
2. Analyses cached data for each relevant item, by:
   - Looking up the corresponding parameter or case file where one exists.
   - Determining whether the item is:
     - **fetchable** (has a configured connection and can be retrieved from an external source), or
     - **file only** (has local data but no connection anywhere, so can only ever be served from cache and never refreshed from source).
   - Assessing coverage for the current query window, including context and cohort or window semantics.
   - Identifying any missing dates or gaps that would need retrieving from source rather than simply aggregating from cache.
   - For covered items, classifying freshness based on date of retrieval and, for cohort and latency edges, maturity rules.
3. Produces a structured planner result that contains:
   - A list of items that are fully covered and suitable for auto aggregation.
   - A list of items that require fetching, including summary details for tooltips.
   - A list of items that are covered but likely stale and therefore candidates for a “Fetch latest”.
   - A list of file only gaps that cannot be fixed by fetching.
   - A derived overall outcome state (covered stable, not covered, or covered stale).
4. Provides an execution entry point that:
   - Converts the items that require fetching into the structures used by the existing fetch infrastructure.
   - Invokes the existing fetch operations and merge policies.
   - After a successful fetch, invalidates any cached planner results and triggers a recomputation of coverage and staleness.

The planner analysis must be side effect free. All network traffic, file merges, and state updates are part of the execution step or existing services it delegates to.

### 4.2 Single Path for Pre Fetch and Fetch

The planner analysis acts as a dry run for the full fetch behaviour:

- When the window selector needs to decide which user outcome state applies, it calls the planner analysis in dry run mode.
- When the user clicks the fetch button, the same planner logic is used to build the concrete fetch plan, which is then executed through the existing data operations machinery.

This ensures that:

- The information used for pre fetch user interface decisions is always consistent with the behaviour of a real fetch.
- The tooltip and toast messages can describe, in advance, what a fetch will actually do.

### 4.3 Session logging for analysis and triage

The planner must emit rich session logging for both the analysis (pre fetch) step and the fetch triage decision. This is essential for debugging coverage and freshness issues in production, especially for latency tracked edges.

At a minimum:

1. Each planner analysis invocation should:
   - Start a session log operation that clearly identifies:
     - The query DSL and window being analysed.
     - Whether the analysis was triggered by an initial load, a DSL change, or a user initiated refresh.
   - Add child log entries that summarise:
     - How many fetchable items were inspected.
     - How many items are fully covered, how many need fetching, how many are stale candidates, and how many are file only gaps.
     - The derived outcome state (covered stable, not covered, or covered stale).
   - End the operation with a success or error status, including any analysis errors or edge cases in the details string.
2. Each time the planner computes or reuses a fetch plan for execution:
   - Add a dedicated “fetch triage” log entry that:
     - Summarises which items will be fetched from source and which will be served from cache only.
     - Distinguishes between newly detected gaps and items that are being refreshed despite having complete coverage (for example, stale latency cohorts).
     - Records the reasons for not fetching when the outcome state is covered and stable (for example, “all cohorts already mature under current t95 and maturity rules”).
   - Where possible, link the triage log entry to the subsequent data operations service logs for the actual get from source operations, so that a single trace shows analysis, decision, and execution.

Logging should reuse the existing session logging conventions (including operation types and severity levels) and must not duplicate the low level logging already performed inside the data operations and window aggregation services. Planner logging should provide a higher level narrative that explains why coverage and freshness decisions were taken for a particular query.

---

## 5. Coverage and Staleness Semantics

### 5.1 Coverage Semantics

Coverage is concerned with whether cached data is sufficient for the requested query.

For parameters:

- The planner must respect the slice and context semantics used elsewhere in the system, including:
  - Window versus cohort modes.
  - Context and context any clauses.
  - MECE style combinations where an uncontexted query is aggregated over a collection of contexted slices.
- Coverage should be determined at the level of the requested window:
  - The planner considers the dates implied by the query window.
  - Cached daily data is used to determine which dates already exist for the relevant slice family.
  - Missing dates in that window are the basis for deciding whether a fetch is needed.

For cases:

- Similar logic applies, using case files and any associated schedules or coverage representations that already exist.

Coverage for file only items, without an external connection on either the graph edge or the underlying file, must not be allowed to block auto aggregation of other items with complete coverage. These items should:

- Contribute to a separate “unfetchable gaps” bucket for messaging and logging.
- Be clearly labelled in planner results and logs as “sample / file only data”.
- Never appear in the fetch plan, since there is no data source to retrieve from.

### 5.2 Staleness Semantics

Staleness is concerned with whether cached data, while complete for the requested window, is likely to be out of date in a way that matters.

For window mode edges without cohort or latency semantics:

- A simple first stage is to treat data as stable once coverage is complete.
- In this release, the planner must include a concrete staleness test based on retrieval timestamps and latency statistics, rather than deferring this to a future enhancement. In particular:
  - If more than one day has passed since the last retrieval timestamp for a fetchable item and, for at least one relevant parameter, the current query horizon is still **within** that parameter’s t95 (for window() queries) or path_t95 (for cohort() queries), then that item should be treated as a **refresh candidate** rather than permanently cached.
  - Conversely, once all evidence that was previously immature is now comfortably beyond the relevant t95 or path_t95 thresholds, the planner should treat that item as “reasonably mature” and therefore **covered and stable**, and should not continue to prompt a refresh solely on the basis of age.

For cohort and latency aware edges:

- The existing latency configuration and cohort data allow the planner to reason about maturity:
  - Cohort dates, their ages, and the maturity horizon already exist in the data model and services.
  - When data was last fetched, some cohorts may have been immature relative to the maturity horizon.
  - As time passes, those cohorts can become mature, meaning an updated fetch may substantially change aggregate values and completeness.
- The planner should:
  - Identify cohort entries that were immature at the time of last fetch and are now at or beyond the maturity horizon.
  - Treat edges with such cohorts as "covered but stale" candidates rather than purely covered stable.

For cases (A/B test gates):

- Cases do not have latency or maturity semantics. Their weights can change at any time in the external system.
- The planner uses a simple time-based staleness rule: if the most recent case schedule was retrieved more than one day ago, the case is treated as stale and should be refreshed.
- This ensures case data stays reasonably fresh without the complexity of maturity calculations.

The exact thresholds and mathematical details for parameters are owned by the statistical enhancement and latency services; the planner only needs a clear interface or helper to classify an edge as stable or stale based on information already present.

---

## 6. Planner Result Model

The planner result should provide enough information for both the window selector user interface and the fetch execution layer.

At a conceptual level, the result needs to include:

1. **Status**
   - An indication of whether analysis is still running, complete, or has failed.
2. **Outcome**
   - One of the three user outcome states:
     - Covered and stable.
     - Not covered and needs fetch.
     - Covered but potentially stale.
3. **Auto aggregation plan**
   - A collection of items that can be safely aggregated from cache for this query, including identifiers and any extra metadata needed by existing aggregation functions.
4. **Fetch plan**
   - A collection of items that need data from external sources:
     - Each item must carry the identifiers needed by existing fetch infrastructure.
     - Each item should have summary information about missing coverage, for example number of missing dates.
5. **Stale candidates**
   - A collection of items that are covered but likely stale, including summary information suitable for tooltips or toasts.
6. **Unfetchable gaps**
   - A collection of file only items with gaps that cannot be fixed by fetching, to support clear user messaging.
7. **Summaries for user messaging**
   - Pre digested text fragments and counts that can be used directly in:
     - Button tooltips.
     - Small toasts that explain why a fetch is or is not needed.

The result model does not need to be exposed outside the services layer as an explicit type in this document; it is enough that it consistently supports the responsibilities listed above.

---

## 7. Integration with Window Selector

### 7.1 Effects and State in Window Selector

The window selector component should be refactored so that:

1. It no longer performs its own coverage analysis by iterating edges and nodes.
2. It instead calls the planner analysis whenever:
   - The authoritative query representation in the graph store changes.
   - The selected window changes.
3. It stores:
   - The latest planner result.
   - A compact view of the derived outcome state.
   - A small aggregation state that tracks whether an auto aggregation is currently in progress.

The effects in the component should be responsible for:

- Triggering planner analysis and tracking loading state.
- Triggering auto aggregation when the planner result indicates that it is safe and useful to do so.
- Triggering user notifications, such as toasts, based on the planner derived outcome and message summaries.
- Ensuring that last aggregated window and last aggregated query representation are updated in the graph store once a successful auto aggregation or fetch has completed.

### 7.2 Fetch Button Behaviour

The fetch button should become a thin reflection of planner state:

- Visibility:
  - Controlled by high level checks about whether the graph has any parameter or case items at all.
- Enabled or disabled:
  - Primarily controlled by whether the planner has any items to fetch, or any stale candidates, and whether analysis or fetch is currently in progress.
- Label:
  - “Fetch data” when the outcome state is “not covered”.
  - “Refresh” when the outcome state is “covered but potentially stale”.
  - A neutral label, with a neutral tooltip, when the outcome state is “covered and stable”.
- Tooltip:
  - Sourced from the planner summaries so that it can say, for example, “Fetch two missing dates for four parameters” or “Fetch latest for three edges with maturing cohorts”.

When the button is clicked:

- The component should delegate to the planner execution entry point, which:
  - Re computes the plan if necessary.
  - Executes the fetch against external sources using existing data operations services.
  - Signals completion so that planner analysis can rerun and the window selector can update its state.

---

## 8. Required Changes in Existing Services

To support the planner, several existing services need to be adjusted or wrapped.

1. **Window aggregation and incremental fetch utilities**
   - The existing coverage and incremental fetch utilities already answer important parts of the coverage question.
   - They should be reused by the planner rather than duplicated.
   - If they expose behaviour that is currently too low level, the planner should wrap them in higher level helper functions rather than reimplementing logic in the window selector.
2. **Statistical and latency services**
   - The maturity awareness for cohort and latency edges already exists.
   - The planner needs a small, clear way to ask whether a given edge, for the current query, should be considered stable or stale.
   - If this does not exist in a sufficiently high level form, a new helper should be added in the statistical enhancement service or a closely related module, not in the user interface layer.
3. **Data operations service**
   - The execution side of the planner will route fetch operations through existing data operations functions.
   - Any new helper added for planner execution should remain within the services layer and respect session logging conventions.
   - The planner must not bypass existing merge and logging policies.

These changes should be made in a way that reduces, not increases, the number of distinct code paths for deciding how and when to fetch data.

---

## 9. Testing and Verification

The planner and its integration should be covered by tests at two levels.

1. **Service level tests for the planner**
   - Given controlled graphs, parameter files, and query representations, verify that the planner:
     - Produces the correct outcome state for a variety of scenarios, including:
       - Fully covered and stable.
       - Missing coverage with fetchable gaps.
       - File only gaps that should not trigger a fetch.
       - Cohort scenarios where cohorts move from immature to mature.
     - Produces sensible fetch plans and auto aggregation plans for these scenarios.
     - Produces message summaries that match expectations.
2. **Component level tests for the window selector**
   - Using suitable test harnesses, verify that the window selector:
     - Calls the planner when the query changes.
     - Renders the fetch button label and enabled state according to planner outcome.
     - Calls the auto aggregation path when the planner says all requirements for auto aggregation are satisfied.
     - Shows toasts that reflect planner derived summaries, including cases where the planner explicitly decides that no fetch is required because all previously immature cohorts have now matured.
   - Where feasible, verify via captured session logs that:
     - Planner analysis invocations are logged with clear DSL and window context.
     - Fetch triage decisions (including “no fetch” outcomes) are recorded with enough detail to reconstruct why a particular outcome state was selected.

Existing tests that currently embed coverage logic in the component should be migrated to target the planner where appropriate, or updated to assert behaviour through the new, centralised path.

---

## 10. Migration and Rollout Plan

The migration should proceed in stages to reduce risk.

1. Introduce the planner service and its tests without changing window selector behaviour.
   - The planner should be exercised with synthetic inputs that mirror existing test scenarios.
2. Refactor the window selector to call the planner for analysis while still retaining the old logic for comparison, under a temporary behind the scenes guard.
   - This allows comparison of outcomes in development and test environments.
3. Once confidence is high that the planner reproduces the desired behaviour and supports the new user outcome states, remove the old coverage logic from the window selector and let it rely solely on the planner.
4. Finally, introduce the explicit “Fetch latest” outcome state in the user interface, once the planner staleness classification is stable and well tested.

Throughout this process, care should be taken to avoid creating new duplicate code paths for coverage and fetch decisions; instead, the planner should become the single point of truth for those decisions.

---

## 11. Open Questions

Several details remain open and should be resolved before implementation:

1. The exact thresholds and heuristics for when cached data should be considered stale in non cohort window mode.

   For latency tracked edges, the intention is that an edge should only be treated as stale while there is a meaningful gap between the current query date and the point at which previously immature cohorts are expected to have matured (for example, relative to t95 where available). Once enough time has passed that it is reasonable to assume all relevant cohorts are mature, the edge should revert to “covered and stable” rather than continuing to prompt a refresh.

2. Whether the planner should be aware of user level configuration for aggressiveness of refetching, or whether that belongs solely in existing refetch policy code.

   At this stage there is no requirement for additional user facing configuration of planner aggressiveness; the planner should depend on the existing refetch policy and latency configuration without introducing extra tuning knobs.

3. How much of the planner result should be persisted across sessions, if any, versus recomputed on each load.

   The planner result itself should not be persisted. Instead, the system should continue to persist the authoritative query DSL onto the graph (and graph store) after each completed retrieve from source, so that on reload the window selector can restore the last used query and recompute planner analysis deterministically. As part of implementation, the existing behaviour for persisting the current DSL to the graph after fetch completion should be confirmed and, if necessary, aligned with this design.

4. Whether the planner should support alternative time horizons or implicit baseline windows beyond what is already described in `design.md`.

   The planner should not introduce any new baseline window semantics. It should rely on the implicit baseline window logic, t95 handling, and related concepts that are already defined in `design.md`, and should not add extra window variants of its own.

These questions do not block the overall shape of the design, but they do affect some of the finer details of the planner result model, staleness classification, and how the analysis is surfaced through logging and user interface behaviour.

