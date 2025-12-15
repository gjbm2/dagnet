## Cohort View – Path‑Wise Maturity and F/E Semantics

### 1. Context and current behaviour

In the current LAG implementation we treat latency and F/E display as primarily a **per‑edge** concern:

- Edges that have a `latency` block (`legacy maturity field`, `t95`, etc.) get the full LAG treatment:
  - lag fitting (`t95`),
  - completeness,
  - forecast vs evidence vs blended `p.mean`,
  - F/E/F+E visual modes in the viewer.
- Edges without `latency` are treated as “simple” probability parameters:
  - they expose only `p.mean` (and sometimes `stdev`),
  - there is no completeness, no F/E split,
  - the viewer renders them as a single band.

This matches intuition for **window()** queries:

- For edges with meaningful lag, we care about forecast vs evidence and maturity.
- For “instantaneous” edges (no lag), any conversion that has appeared in the window is effectively mature in that window; showing an F/E split usually conveys little.

However, for **cohort()** queries this model breaks down downstream of a lag edge:

- Even if a downstream edge’s *local* lag is zero, **its cohorts are not mature** until the entire path from the anchor (e.g. `landing-page`) to that edge has had time to play out.
- Today those downstream edges typically have no `latency` block at all, so they render as a flat `p.mean` in cohort view, with no completeness or F/E indication, even though many of their cohort journeys are still incomplete because upstream lagged edges have not matured.

This creates an inconsistent user experience in cohort view:

- Some edges on a path show rich F/E and completeness.
- Immediately downstream edges show only a flat probability, even though their cohort evidence is still maturing via upstream lag.

### 2. Cohort mode: path‑wise maturity, not edge‑local

For a cohort query like:

- `cohort(23-Nov-25:29-Nov-25)`

the conceptually correct maturity notion is **path‑wise from the anchor**, not edge‑local:

- We define an anchor node (e.g. `landing-page`) for the cohort.
- For any edge \(E\) on a path from the anchor, we care about the **cumulative lag from anchor → … → E**.
- This is what `path_t95` is already intended to capture:
  - `t95(edge)` = 95th percentile lag for individual leg,
  - `path_t95(anchor → edge)` = sum of t95 values along the active path.

The maturity of a given cohort for an edge \(E\) in **cohort mode** should therefore be driven by:

- The **anchor cohort’s age** (time since entry at anchor), and
- The **path‑level horizon** `path_t95(anchor → E)`.

Intuitively:

- If cohort age ≪ `path_t95`, then even “instantaneous” downstream legs do not yet see their full conversion rate.
- If cohort age ≫ `path_t95`, the entire path to that edge is effectively mature; both upstream and downstream legs have stabilised.

So in cohort view, whether an edge’s evidence is mature or not is **not a function of its local `legacy maturity field` alone**, but of the full path maturity from the anchor.

### 3. Implications for different edge types

Given an anchor‑based cohort view:

- **Lag edges (with `legacy maturity field > 0` and `t95`)**
  - They remain the primary source of path maturity information.
  - Their `t95` values are summed into `path_t95` for downstream edges.
  - They definitely carry F/E, completeness, and all existing LAG metadata.

- **Downstream “instantaneous” edges (no local `latency`)**
  - Locally they may have zero or near‑zero lag.
  - But cohort maturity at those edges is bottlenecked by upstream lag edges.
  - In cohort mode, these edges should conceptually share the **same completeness curve** as the furthest upstream lagged edge on their active path.
  - They should not silently appear as “fully mature flat p.mean” while their upstream path is still maturing.

- **Edges on purely non‑latency segments (no lag anywhere on path)**
  - For these, path‑wise lag is effectively zero (`path_t95 ≈ 0`).
  - In both window() and cohort() views, their evidence can be treated as immediately mature for practical purposes.
  - Showing F/E here is optional; completeness will be ≈1 as soon as data is present.

### 4. Proposed semantics by query mode

#### 4.1 Window() view

- **Goal:** Show F/E and completeness where it meaningfully reflects lagged maturity at that edge.
- **Behaviour:**
  - **Edges with `latency`** (non‑trivial `legacy maturity field` / `t95`):
    - Continue to show F/E and completeness in F/E/F+E modes.
    - Completeness is computed per edge, for the current window, as today.
  - **Edges without `latency`** (effectively instantaneous):
    - Continue to render as simple `p.mean` in most cases.
    - Completeness is implicitly 1 once they have data in the window.
    - No change needed here for coherence.

This matches the current mental model and remains coherent: window() is about **when conversions happen in time**, and local lag is the right object to look at.

#### 4.2 Cohort() view

- **Goal:** In cohort mode, F/E and completeness should reflect the **path‑wise maturity from the anchor**, not just local edge lag.
- **Proposed rule:**
  - Define `path_t95(anchor → edge)` as we already do today.
  - For a cohort at reference date \(T\), define its **path maturity factor** at edge \(E\) as a function of cohort age versus `path_t95(anchor → E)`.
  - For any edge where `path_t95(anchor → E) > 0`:
    - Treat its cohort evidence as potentially immature until cohort age exceeds that horizon.
    - Expose completeness and F/E style metadata in cohort view.
  - For edges where `path_t95(anchor → E) ≈ 0` (no lag along the path):
    - Cohort evidence is effectively immediate; completeness ≈1.
    - These can remain simple `p.mean` or show trivial F/E if convenient.

Concretely, that means:

- Downstream “instantaneous” edges behind lagged edges should **inherit path‑wise completeness** and not be treated as fully mature by default.
- In cohort mode, the viewer should be able to show F/E view on any edge where the path maturity is still evolving, regardless of whether `legacy maturity field` is set on that edge itself.

### 5. Implementation adjustments (prose only)

This section outlines **what** needs to change conceptually; actual implementation should be kept to service code and use existing patterns (no UI logic, no code in this doc).

#### 5.1 Path‑wise maturity signals

- **Today:**
  - `statisticalEnhancementService` computes per‑edge `t95` and can compute `path_t95(anchor → edge)` transiently.
  - Completeness is computed per edge for its own lag and used mainly on lag‑labelled edges.

- **Needed for cohort view:**
  - Ensure `path_t95` is **reliably available** (at least in memory) for all edges on active paths under the current cohort DSL.
  - For edges without `latency` but with `path_t95 > 0`, derive a **path‑wise completeness** for their cohorts, based on the same anchor‑cohort ages used for upstream lag edges.
  - Optionally, expose a transient field (e.g. `p.latency.path_completeness` or similar) so the viewer can use a consistent API to decide F/E rendering for all edges in cohort mode.

#### 5.2 Retrieval and aggregation

- **Retrieval (dataOperationsService / windowAggregationService):**
  - Today, cohort retrieval horizons and maturity‑aware refetch policies are anchored at latency edges.
  - For non‑latency downstream edges, we still fetch data over the cohort window but do not attach LAG metadata.
  - To make cohort view coherent:
    - When aggregating cohort data for any edge that lies behind a lag path (`path_t95 > 0`), attach enough metadata for the LAG layer to compute or infer path‑wise completeness if needed.
    - This may not require storing new bulk data; it can be expressed in terms of existing cohort counts (`n`, `k`, ages) plus `path_t95` at query time.

#### 5.3 Viewer semantics

- The viewer currently chooses between:
  - **Simple p.mean display**, and
  - **F/E/F+E latency display**, based largely on the presence of `p.latency` and nested forecast/evidence fields.

- In a path‑wise cohort model, the viewer should:
  - In **window() mode**:
    - Keep using edge‑local `latency` as the gate for F/E display (unchanged).
  - In **cohort() mode**:
    - Prefer a more general rule:
      - If an edge has forecast/evidence and a non‑trivial path maturity signal (path‑based completeness), show the F/E view.
      - Only fall back to simple p.mean when both:
        - there is no path lag (no upstream or local latency), or
        - evidence and forecast are indistinguishable and completeness is effectively 1.

This keeps the window() behaviour intuitive while making cohort view reflect the fact that **all edges on a lagged path are affected by upstream immaturity**, not just the explicitly lag‑labelled ones.

### 6. Open design questions

Before implementing, a few points need explicit decisions.

- **Data model for path‑wise completeness:**
  - In cohort mode, we want a notion of **latency completeness for all edges on lagged paths**, not just the explicitly latency‑labelled ones.
  - The natural source of truth is:
    - anchor‑based A→edge lag distributions (for latency edges where we already query Amplitude), and
    - `path_t95(anchor → edge)` derived from those distributions and from DP over the graph.
  - A plausible implementation is:
    - Compute a **path‑wise completeness scalar** per edge for the current cohort DSL (e.g. `path_completeness` or re‑using the existing `completeness` field semantics),
    - Store it transiently in `p.latency` or an analogous structure for the lifetime of the analysis/graph instance,
    - Drive F/E rendering in cohort mode from this scalar plus the existing forecast/evidence fields.
  - For edges where `path_t95 = 0` along all active paths, we can treat completeness as **instantaneously 1** (typical for early, effectively instantaneous conversions such as “visit page → click proceed”).

- **Multiple paths and branching:**
  - When a node/edge is reachable via multiple upstream paths with different lags, the safe path‑wise maturity horizon is:
    - \`path_t95(anchor → E) = max\_paths Σ t95(edge on path)\`
    - i.e. the **maximum** cumulative t95 over all active upstream paths.
  - For latency edges where we already run anchor‑based cohort queries, we can:
    - Derive **path‑level t95 directly from the A→edge distribution** (via DAS),
    - Store it as `p.latency.path_t95` alongside the edge‑local `t95`,
    - Persist it in the parameter file.
  - For edges (or providers) where we cannot obtain A→edge distributions, we can:
    - Fall back to DP over per‑edge `t95` using the “max of sum over paths” rule in topological order.
  - Downstream instantaneous edges then simply **inherit the latest upstream `path_t95`**; we do not need to “go back to anchor” or convolve A→X and X→Y distributions.
  - In graphs where the maximum `path_t95` to an edge remains 0 across all active paths, **window() retrieval is sufficient**; otherwise, cohort() retrieval is required for lags to be handled correctly.
  - A possible future elaboration (not in this scope) would be to explore **weighted combinations of upstream path_t95 values** (e.g. by traffic share) rather than a pure max; this is a natural follow‑up once the basic `path_t95` persistence is in place.

- **Performance considerations:**
  - The heavy work is the Amplitude IO and lag fitting we already perform for latency edges.
  - Once we have per‑edge `t95` and persisted `path_t95` scalars, computing path‑wise completeness is:
    - A linear pass over nodes/edges in topological order,
    - And some arithmetic over cohort ages, all of which is small relative to external IO.
  - We should still **compute path_t95 and path‑wise completeness once per analysis** (planner / LAG service) and cache the results alongside the graph, instead of recomputing them at render time.

- **Partial adoption:**
  - We can phase this in:
    - Step 1: Ensure `path_t95` is reliably computed and/or persisted for all latency‑tracked edges, and that it is available to both planner and LAG layer for cohort queries.
    - Step 2: Extend completeness computation to use `path_t95` for edges behind lagged paths, attaching a path‑wise completeness signal wherever `path_t95 > 0`.
    - Step 3: Adjust viewer gating logic in cohort mode to use path‑wise maturity signals (path_t95 + path completeness), while keeping window() gating unchanged and still driven by edge‑local latency.

This document is intentionally high‑level and prose‑only; implementation details should live in the relevant service files and associated tests, following existing LAG and planner design documents.


