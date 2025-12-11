## Project LAG – Analytics Runner & Views Proposal

### 0. Scope and goals

This document builds on the core LAG implementation (`lag-statistics-reference.md`, `design.md`, `implementation.md`, `cohort-view*.md`) and the contexts/analysis schema (`ANALYSIS_RETURN_SCHEMA.md`) to specify how:

- The **analytics runner** should consume the new LAG variables and scenario visibility modes.
- The **selection and query auto‑builder** should use anchor/path information to construct sensible default analyses.
- Three key **analysis views** (Waterfall, Bridge, Cohorts) should be modelled as runner outputs, all with tabular data suitable for multiple display adaptors.

It is deliberately implementation‑adjacent but prose‑first: concrete code belongs in services, runners, and tests.

---

### 1. Analytics runner and new LAG variables

#### 1.1 Available LAG variables (summary)

From the core LAG implementation and statistics reference, the analytics layer now has access (per edge, per scenario) to:

- **Probability metrics**
  - `p.mean` – blended probability (evidence + forecast).
  - `p.evidence.mean`, `p.evidence.n`, `p.evidence.k` – observed rate and counts.
  - `p.forecast.mean`, `p.forecast.k` – baseline probability and expected converters.
  - `p.n` – forecast population flowing through the edge under the scenario.

- **Latency / maturity metrics**
  - `p.latency.maturity_days` – configured lag horizon.
  - `p.latency.median_lag_days`, `p.latency.mean_lag_days` – local lag.
  - `p.latency.t95` – 95th percentile lag for the edge.
  - `p.latency.path_t95` – cumulative 95th percentile along active path from anchor (scenario‑specific).
  - `p.latency.completeness` – fraction of eventual conversions that should have occurred.

- **Scenario behaviour and visibility**
  - Scenario‑specific `p.mean(S)`, `p.n(S)`, `p.forecast.k(S)` after inbound‑N convolution.
  - Four‑state scenario visibility mode per tab: **F+E**, **F only**, **E only**, **hidden**.

The analytics runner must treat these as **first‑class inputs** so that analysis outputs can expose:

- Evidence‑only, forecast‑only, and blended views.
- Maturity and uncertainty information per edge and per scenario.

#### 1.2 Runner contract alignment with LAG

The existing `AnalysisResult` contract already supports rich outputs via:

- `metadata` for analysis‑level context (path definition, anchors, cohort windows, etc.).
- `structure` for primary/secondary grouping and display hints.
- `data` as an array of items, each of which can contain scenario‑specific values.

For LAG‑aware analyses, the runner should:

- **Extend scenario value payloads** (where appropriate) to carry:
  - Evidence: probability, `n`, `k`.
  - Forecast: probability, projected `k`, and `p.n`.
  - Blended: `p.mean` and any derived expected values.
  - Maturity: completeness, `t95`, `path_t95`, and cohort age where relevant.
- **Record scenario visibility mode** per scenario in `metadata` and/or in each scenario value item so UI adaptors can:
  - Filter out hidden scenarios entirely.
  - Decide whether to present evidence vs forecast vs blended numbers, consistent with the per‑tab F/E setting.
- **Remain agnostic about graph topology and retrieval**:
  - All decisions about which edges have valid LAG data, which cohorts are mature, and which slices are available should be delegated to existing services (data operations, window aggregation, statistical enhancement, fetch planners).
  - The runner sees a read‑only “LAG‑enhanced graph snapshot” plus parameter‑level hooks where deeper cohort evidence is required (see §5).

#### 1.3 Respecting scenario visibility and F/E mode

For every analysis invocation, the runner should receive, alongside the selected nodes/path:

- The set of **active scenarios in the current tab**, each annotated with:
  - Scenario id and name.
  - Visibility mode: F+E, F, E, or hidden.

The runner then applies these rules:

- **Hidden** scenarios are **not** included in analysis outputs at all.
- **F‑only** scenarios:
  - All primary numeric metrics use **forecast** values (e.g. `p.forecast.mean`, `p.forecast.k`, `p.n`).
  - Evidence metrics may be included in metadata for context but are not the primary value rendered.
- **E‑only** scenarios:
  - All primary numeric metrics use **evidence** values (e.g. `p.evidence.mean`, `p.evidence.n`, `p.evidence.k`).
  - Forecast is available as context but not the main value.
- **F+E** scenarios:
  - Both evidence and forecast values are present per row, with blended `p.mean` and completeness used where needed.
  - Display adaptors can choose to show F/E side by side or emphasise blended values, depending on view type.

This ensures the analytics layer mirrors the mental model of the canvas: some scenarios are “what will probably happen” (F), some show “what has actually happened so far” (E), and some show both.

*** YES, BUT I THINK THE MODEL YOU'RE PROPOSING MAY BE SEENS TO IMPLY THAT THE 'MEANING' OF E.G. P.MEAN FOR AN ANALYSIS CHANGES. THAT WOULD BE RISKY. A GIVEN ANALYSIS TYPE MAY NOT HAVE A USE FOR P.FORECAST, BUT IF P.FORECAST IS AVAILABLE, IT SHOULD BE PROVIDED, AND THE ANALYSIS CAN CHOOSE WHAT TO DO WITH IT. THE _MEANING_ OF EACH TERM I THINK IS INVARIATE. ***

---

### 2. Selection and query auto‑builder (anchor‑aware)

#### 2.1 Single‑node selection: inferring the default funnel

When the user clicks a **single node X** and opens analytics:

- The auto‑builder should:
  - Determine the **anchor A** as the furthest upstream START node that can reach X, using the same `anchor_node_id` semantics already used for LAG.
  - Construct the **canonical path A → … → X** for analysis purposes:
    - Prefer a single, simple path if multiple exist; where ambiguity remains, choose a deterministic “primary path” (e.g. the one with highest forecast traffic `p.n`, or a consistent topological tie‑break).
  - Build a default **funnel analysis** over this path, using the views described in §3–§5.

This gives a natural default: “from where these users first appear (A) to the point I have clicked (X)”.

*** EXISTING LOGIC SORT OF DOES THIS ALREADY (SHOWS "to(switch-success)" SAY IF I CLICK THAT NODE ONLY). QUESTION IS WHETHER WE SHOULD 'AUTO-INJECT' A 'FROM(ANCHOR_NODE_ID)' INTO THE QUERY DSL? HAVE TO IMPACT EXISTING ANALYSIS ***

#### 2.2 Multi‑node selection: explicit funnel bounds

When the user selects **two or more nodes**:

- For **two nodes {U, V}** on a connected path:
  - Treat the earlier node in topological order as **start**, and the later node as **end**, and infer a primary path U → … → V.
- For **more than two nodes**:
  - Use the earliest and latest reachable nodes as start/end bounds.
  - Optionally record additional selected nodes as waypoints of interest in `metadata` (for labelling stages, but not necessarily forcing path segmentation).

In all cases the auto‑builder:

- Delegates the actual path‑finding and anchor semantics to existing graph/LAG services.
- Produces a **single, well‑defined path** object (list of edges/nodes in order), which all three analytics views then consume.

*** THIS ALREADY HAPPENS, AND IS VISIBLE TO THE USER IN THE FORM OF THE 'QUERY DSL'. THIS DOESN'T CHANGE -- IT'S STILL THE QUERY DSL THAT IS SUPPLIED TO ANALYSIS SO THAT IT'S INSPECTABLE AND CLEAR TO THE USER WHAT PATH IS BEING GIVEN TO THE ENGINE ***

#### 2.3 Integrating DSL and retrieval

Given the inferred anchor and path, the auto‑builder should:

- Construct or reuse the **DSL** consistent with the current window/cohort selection:
  - If the tab is in **cohort() mode**, use an anchor‑based cohort DSL (as in existing LAG flows) to drive any cohort‑sensitive analyses (especially the Cohorts view).
  - If the tab is in **window() mode**, use the existing window DSL but still record anchor/path metadata so the runner can interpret maturity correctly.
- Ask the data services to:
  - Ensure required slices (window/cohort) are present in param files or fetched from source.
  - Surface an analysis‑time “LAG‑enhanced graph snapshot” that contains populated `p.*` and `p.latency.*` for all edges on the selected path, under each active scenario.

The analytics runner itself should **not** issue Amplitude or file operations directly; it trusts the data services to provide consistent inputs.

---

### 3. View 1 – Waterfall (single‑scenario path breakdown)

#### 3.1 Purpose

The Waterfall view explains, **for a single scenario**, how probability and/or volume evolves along a specific path from start to end:

- “Given scenario S, how do conversions and probabilities accumulate or drop at each stage between A and X?”

It is inherently **single‑scenario** because the core question is intra‑scenario structure; cross‑scenario differences are handled by the Bridge view.

#### 3.2 Inputs and filters

For a given analysis invocation, the runner needs:

- A single **scenario S** (selected explicitly or as “current scenario” from the tab).
- The **ordered path** A → … → X (list of nodes and edges).
- The **mode** for S (F/E/F+E), which determines whether the primary metric is:
  - Forecast probability / volume (F),
  - Evidence probability / volume (E), or
  - Both, with blended `p.mean` as needed (F+E).
- The **query mode** (cohort vs window), to interpret maturity and completeness correctly.

Only edges/nodes on the chosen path are included.

#### 3.3 Metrics and tabular shape

Each row in the waterfall table represents a **stage** on the path (typically corresponding to either the node at that position or the incoming edge), and contains:

- Stage index and identifiers:
  - Stage number (0 for anchor, 1…N for subsequent steps).
  - Node id and label.
  - Edge id and label (where relevant).

- Volume metrics (depending on F/E mode):
  - Inbound population at this stage (`p.n` or equivalent for evidence).
  - Cumulative converters to this stage (`p.forecast.k` or evidence `k`).

- Probability metrics:
  - Local edge probability (F, E, or blended).
  - Cumulative probability from anchor to this stage.

- Change metrics:
  - Absolute change in probability vs previous stage.
  - Absolute change in expected converters vs previous stage.
  - Percentage drop‑off between stages.

- Maturity and uncertainty:
  - Completeness at this edge.
  - `t95` and `path_t95` where available.

The **analysis structure** for Waterfall should typically be:

- `primary = "stage"`, `secondary` omitted (single scenario), `display_hint = "funnel"` or `"table"`.

This supports both a table and a funnel/waterfall chart adaptor using the same data.

#### 3.4 Respecting scenario mode in Waterfall

The scenario’s F/E mode drives which numbers are surfaced as the **primary** values in the table:

- **F mode**: use forecast probabilities and `p.n`/`p.forecast.k` as the main series; evidence may appear in secondary columns.
- **E mode**: use evidence rates and counts as the main series; forecast is contextual.
- **F+E mode**: show both evidence and forecast columns, plus blended `p.mean` where the user wants a single “best” estimate.

Completeness and `t95`/`path_t95` are interpreted consistently regardless of mode; they describe timing, not scenario optimism/pessimism.

---

### 4. View 2 – Bridge (scenario‑to‑scenario comparison)

#### 4.1 Purpose

The Bridge view explains how **one scenario differs from another** along the same path:

- “How does an optimistic scenario differ from current between A and X, and where are the deltas largest?”

It is naturally **two‑scenario**:

- A **base scenario** (e.g. “Current”).
- A **comparison scenario** (e.g. “Optimistic”).

#### 4.2 Inputs and scenario selection

The runner requires:

- The ordered **path** A → … → X, as in Waterfall.
- Two scenarios S₁ and S₂, each with:
  - Visibility mode (F/E/F+E).
  - LAG‑enhanced metrics on each edge of the path.

Scenario choice can follow UI rules such as:

- Default to “current” vs the **most recently toggled visible** alternative scenario.
- Allow the user to explicitly pick base and comparison scenarios in the analytics panel.

#### 4.3 Metrics and tabular shape

Each row again represents a **stage** on the path, and includes:

- Identifiers:
  - Stage index, node/edge ids and labels (as per Waterfall).

- Scenario values:
  - For S₁: local and cumulative probability, volumes, completeness.
  - For S₂: the same metrics.
  - Respect F/E modes for each scenario when choosing primary metrics (e.g. if S₁ is E‑mode and S₂ is F‑mode, they can legitimately show different flavours).

- Delta metrics:
  - Absolute difference in local probability (S₂ − S₁).
  - Absolute difference in cumulative probability A → stage.
  - Absolute and relative change in expected converters at each stage.
  - When cohorts are immature, optionally also include differences in completeness, to show where the comparison is still speculative.

For the schema, Bridge fits cleanly into:

- `primary = "stage"`, `secondary = "scenario"`, `display_hint = "comparison"` or `"funnel"`.

Each stage row then contains a list of scenario values with explicit deltas either:

- Embedded alongside each scenario value (e.g. “vs base”), or
- Represented as additional fields on the stage item keyed by scenario ids.

#### 4.4 Scenario modes and interpretation

Because the Bridge view compares arbitrary scenarios, it must be explicit about:

- Which flavour is being compared:
  - Evidence vs evidence, forecast vs forecast, or blended vs blended.
- How differences are interpreted when completeness is low:
  - The table should include completeness for both scenarios so users can see when differences are dominated by immaturity rather than structural changes.

The runner should surface enough metadata for UI hints such as:

- “Differences at this stage are primarily forecast‑based; evidence is still immature.”

---

### 5. View 3 – Cohorts (maturity, projection, and fan chart)

#### 5.1 Purpose and relationship to core LAG

The Cohorts view focuses on **how particular cohorts are progressing over time along a path**, and for immature cohorts, how they are likely to complete:

- “For cohorts entering between these dates, how far have they progressed along A → … → X, and what does LAG imply about their eventual outcomes?”

This view is more evidence‑heavy than the other two and needs access to **time‑series cohort data**, not just aggregated scalars.

Existing LAG infrastructure already stores, per latency edge and cohort slice:

- `dates[]`, `n_daily[]`, `k_daily[]`.
- Per‑cohort `median_lag_days[]`, `mean_lag_days[]`.
- Anchor arrays `anchor_n_daily[]`, `anchor_median_lag_days[]`, `anchor_mean_lag_days[]`.

However, the typical LAG pipeline consumes these into summary scalars for display on the canvas. The Cohorts view must be able to **look back into these arrays** (and, where necessary, request fresh slices) to construct cohort trajectories.

#### 5.2 Data access requirements

To support the Cohorts view without duplicating logic:

- The analytics runner should depend on a dedicated **cohort analytics service** that:
  - Queries the param registry / data operations layer for the requisite cohort slices along the selected path (anchored at A).
  - Reuses existing window aggregation and statistical enhancement functions to:
    - Compute cohort ages as at the analysis date.
    - Determine completeness per cohort and per edge on the path.
    - Apply Formula A to project final conversion probabilities where evidence is immature.
  - Exposes, per cohort and per edge:
    - Observed converters to date (from `k_daily`).
    - Estimated eventual converters (from forecast/Formula A).
    - Uncertainty bands (using LAG’s log‑normal distribution and, where appropriate, binomial variance heuristics).

- The runner itself then:
  - Builds higher‑level cohort summaries across the entire path (not just per edge).
  - Shapes the results into tabular structures for display.

Retrieval of **daily evidence data** remains the responsibility of the existing pipeline; the cohorts service should call into it rather than opening new data paths.

#### 5.3 Cohorts view dimensions and grouping

There are two natural grouping choices for this view:

- **Primary = cohort, secondary = scenario**:
  - One row per cohort (e.g. by cohort start date or bucketed by week), with per‑scenario values listing maturity/projection metrics along the path.
  - Suitable when the question is “how do different cohorts behave under each scenario?”.

- **Primary = stage, secondary = cohort**:
  - One row per stage on the path, with nested cohort entries tracking maturity at that stage.
  - Suitable when the question is “at which stage are cohorts bottlenecked?”.

For a first iteration, primary‑cohort is likely the more intuitive tabular representation:

- `primary = "cohort"` (represented as a label such as `1-Nov-25` or `week starting 1-Nov-25`).
- `secondary = "scenario"`.
- `display_hint = "table"` (chart adaptors can still build fan charts from the same data).

#### 5.4 Metrics per cohort and scenario

For each `(cohort, scenario)` pair, the runner should aim to expose:

- Identification:
  - Cohort label and date range.
  - Anchor node id and path identifier.

- Progress along the path:
  - Fraction of the cohort that has reached the end node by the analysis date (evidence).
  - Intermediate milestones (e.g. fraction reaching key waypoints), either aggregated into a small set of named stages or kept as a compact structure in metadata.

- Maturity:
  - Cohort age at analysis date.
  - Path‑wise completeness (based on `path_t95` and anchor‑based lag semantics).

- Projection and fan chart parameters:
  - Projected eventual conversion probability (from Formula A).
  - Projected eventual number of converters (probability × anchor cohort size).
  - Lower and upper bounds (e.g. a 90% or 95% interval) for final conversion counts.
  - Any quality flags indicating whether projections are extrapolation‑heavy (very low completeness) or data‑driven (high completeness, large n).

Display adaptors can then:

- Plot, for each cohort, the **observed trajectory** vs the **projected trajectory** along time since entry.
- Use the interval bounds to render a **fan chart** around the projected curve.

#### 5.5 Interaction with F/E and scenarios

Because Cohorts is fundamentally about evidence:

- The **primary series** should usually be evidence‑based, with forecast used to project forward where cohorts are immature.
- Scenario visibility modes still apply:
  - If a scenario is F‑only, its rows focus on projections and long‑run means; evidence columns may be suppressed or shown only where relevant.
  - If a scenario is E‑only, projections must still be based on an underlying forecast model, but the UI can emphasise empirical progression.
  - Hidden scenarios remain absent from the table and any charts.

The runner should make explicit, via metadata, which parts of each row are **observed** vs **forecasted** to support clear legends and tooltips.

---

### 6. Respecting scenario visibility and layered views

Across all three analytics views:

- Only **visible** scenarios participate; hidden ones are filtered out entirely at the runner layer.
- The **F/E visibility mode** determines which metrics appear in the main table columns for each scenario, but:
  - LAG internals (completeness, `t95`, `path_t95`, cohort ages) are still computed per scenario and can appear as supporting context where helpful.
- Because each tab can mix F‑based and E‑based scenarios, analytics outputs should:
  - Treat scenario values as **tagged with their mode** so adaptors can style and explain them differently.
  - Avoid silently averaging across scenarios with different modes; comparisons should be explicit (especially in the Bridge view).

This allows a user to build a tab where some scenarios show **forecast‑heavy** futures, others show **evidence‑driven** current reality, and the analytics views all respect that layering consistently.

---

### 7. Implementation notes and next steps

This proposal implies the following broad implementation steps, all following existing architectural patterns:

- **Runner wiring and typing**
  - Extend analysis runner types to carry LAG‑aware scenario value fields and per‑scenario visibility modes.
  - Ensure runners receive the already LAG‑enhanced graph and do not re‑implement retrieval or fitting logic.

- **Selection and auto‑builder**
  - Implement anchor‑aware path inference for single and multi‑node selections, delegating to existing graph/LAG services.
  - Surface the inferred path and DSL (cohort/window) into runner invocation parameters.

- **Analytics views**
  - Implement Waterfall and Bridge as thin, deterministic transformations from “path + scenarios + LAG metrics” into `AnalysisResult` payloads.
  - Implement a cohort analytics service that exposes per‑cohort, per‑edge time‑series summaries to the runner, and build the Cohorts view on top of it.

Each of these should be accompanied by targeted tests (runner unit tests plus end‑to‑end analytics panel tests) to ensure that the analytics outputs remain stable as LAG internals evolve.


