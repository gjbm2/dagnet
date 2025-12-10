# Inbound‑n Implementation Plan – Schema and Code Changes (Prose Only)

## 1. Scope and Goals

This implementation plan describes the concrete changes needed to:

1. Implement the **inbound‑n ontology** from `inbound-n-fix.md` (forecast population semantics for downstream latency edges).
2. Ensure the **DSL and UI expose `p.n`** (forecast population under the current DSL), while **`p.forecast.k` remains an internal, query‑time helper** in the statistical service.
3. Keep all business logic in services and statistical helpers, with UI components acting as access points only.

The plan is intentionally prose‑only: it names files, responsibilities, and behaviours without introducing code snippets.

## 2. High‑Level Behavioural Changes

### 2.1 Edge‑local behaviour (per DSL)

For any interactive DSL (window, cohort, or combinations) and scenario:

1. Each edge must have a well‑defined:
   - `p.evidence` (observed n/k under this DSL).
   - `p.mean` (blended eventual probability using Formula A and lag).
2. Additionally, each edge must acquire:
   - A **forecast population `p.n`** representing “how many users we expect to traverse this edge under this DSL”, derived by step‑wise convolution from upstream anchors using `p.mean` and slice evidence.
   - An internal **`p.forecast.k`** representing “expected converters on this edge under this DSL”, used only for propagation to downstream nodes and for diagnostics.

These values are recomputed whenever the interactive DSL or scenario changes.

### 2.2 Node‑level behaviour

For each node X, under a given DSL:

1. The statistical service must:
   - Collect `p.forecast.k` from all inbound edges whose `to` node is X.
   - Use the sum as the effective eligible population when interpreting all outgoing edges from X, particularly:
     - For latency edges, in completeness calculations and maturity reasoning.
     - For non‑latency edges, optionally as a diagnostic indicator of upstream flow.
2. The node‑level sum does not need a dedicated stored property; it can be a transient variable during enhancement.

### 2.3 DSL and UI exposure

The DSL and graph UI should:

1. **Expose `p.n` and `p.mean`** as first‑class quantities on edges for the current DSL, so users can see:
   - “How many users is this edge effectively about under this query?”
   - “What is the inferred eventual probability on this edge?”
2. **Not expose `p.forecast.k` in the core DSL**:
   - It remains an internal statistic used to propagate population downstream.
   - It may be surfaced only in advanced diagnostics or debug tooling if needed.

## 3. Schema and Type Changes

### 3.1 TypeScript graph types

Update the central TypeScript graph type definitions (the ones used across services, graph mutation, and the editor) to:

1. Extend the edge probability object (the structure that currently holds fields such as `mean`, `evidence`, `forecast`, and `latency`) with:
   - A field representing **`p.n`**:
     - Description: “forecast population for this edge under the current DSL, derived from upstream probabilities and slice evidence”.
     - Semantics: query‑time value that may be persisted for the pinned DSL only, but is recomputed whenever the interactive DSL changes.
2. Clarify, in type comments and docstrings, the distinction between:
   - `evidence.n` – purely observed population from slices (Amplitude `n_daily`, cohort funnel counts).
   - `p.n` – convolved, forecast population derived from upstream structure.
3. Avoid adding `p.forecast.k` as a persisted field:
   - If needed, define it in types as an optional, **non‑persistent** field intended only for in‑memory use within the stats service.

The goal is that code consuming edge probabilities can rely on a stable shape where `p.n` and `p.mean` are always present after enhancement for the current DSL.

### 3.2 Parameter schema and param pack types

Review the parameter schema (YAML schemas and their mirrored TS types) to:

1. Confirm that slices continue to store only:
   - Evidence‑level fields: `n`, `k`, `n_daily`, `k_daily`, `dates`, and per‑slice `latency` summaries.
   - Canonical slice labels via `sliceDSL`, `cohort_from`, `cohort_to`, `window_from`, `window_to`.
2. Add documentation explaining:
   - That slice‑level `n` and `k` are **not** the same as `p.n`:
     - They are direct evidence from Amplitude for that slice.
     - `p.n` is computed later, per DSL, by combining slices with the graph’s topology and upstream `p.mean` values.
3. Ensure that param pack types used in services expose these slice fields clearly, but do **not** introduce `p.n` or `p.forecast.k` at the slice level.

No fundamental schema change is required, but comments and field descriptions must align with the new ontology.

### 3.3 Python models

Review Python Pydantic models for parameters and graph structures to:

1. Confirm they carry only:
   - Evidence and retrieval‑time statistics (such as per‑slice n/k and lag summaries).
2. Add comments in the relevant models or docstrings clarifying:
   - That **forecast population semantics (`p.n`) and `p.forecast.k` are computed in the TypeScript statistical layer**, not in Python.

This ensures Python remains responsible for retrieval‑time data and Amplitude interfacing, while TS owns the query‑time forecast n semantics.

## 4. Service‑Level Changes (TypeScript)

### 4.1 Statistical enhancement service

Identify or create the central statistical enhancement service (the component that today:

- Aggregates slices by DSL.
- Applies Formula A.
- Computes `p.mean`, completeness, and `p.latency.t95`.

Extend this service with a new, structured enhancement pass that:

1. **Per‑edge evidence and probability computation** (existing behaviour, to be refactored but not fundamentally changed):
   - For each edge and the current DSL:
     - Load relevant slices from the param registry or direct fetch results.
     - Aggregate evidence to obtain `evidence.n` and `evidence.k`.
     - Apply lag and Formula A to compute `p.mean`, completeness, and any updated latency scalars needed.
2. **Step‑wise forecast population (`p.n`) computation**:
   - Using a topological traversal from anchor nodes:
     - For anchor edges (A=X, where A is a START node): `p.n` equals the slice's `evidence.n` directly.
     - For downstream edges (X→Y where X is not START): `p.n` equals the sum of inbound `p.forecast.k` at node X.
   - This step should treat `p.n` as a modelled quantity that can be recomputed whenever upstream evidence or the DSL changes.
3. **Internal `p.forecast.k` computation and propagation**:
   - For each edge: `p.forecast.k = p.n × p.mean` (internal helper, not persisted).
   - For each node X in topo order:
     - Sum inbound `p.forecast.k` to form a transient "expected arrivals at X" value.
     - Use this sum as the effective eligible population when interpreting downstream edges from X, particularly for latency completeness.

The service should keep the stage boundaries clear so that:

- UI and DSL‑level consumers see only `p.n`, `p.mean`, completeness, and latency summaries.
- `p.forecast.k` and node‑level sums remain internal implementation details.

### 4.2 Scenario and conditional_p selection (critical)

**This is the subtle issue:** When computing `p.forecast.k` for propagation, we must use the **scenario‑effective probability**, not a raw `p.mean`.

The existing whatIf logic (`computeEffectiveEdgeProbability` in `lib/whatIf.ts`) already handles:

- Case variants that activate or deactivate edges.
- `conditional_p` arrays where different probability entries apply under different conditions.
- Scenario‑specific probability overrides.

The inbound‑n computation must:

1. **Use the scenario‑effective probability** when computing `p.forecast.k`:
   - For edges with `conditional_p`, select the appropriate entry based on the current scenario's case/condition state.
   - For edges deactivated under the scenario, treat `p.forecast.k = 0` (no flow through that edge).
2. **Respect the same active‑edge set** used for path maturity calculations (see existing `get_active_edges` logic in the design).
3. **Recompute when scenario changes**:
   - If the user switches scenarios or modifies case allocations, the entire `p.n` / `p.forecast.k` propagation must re‑run with the new effective probabilities.

This ensures that the forecast population at each node reflects the actual scenario being modelled, not a blend of all possible paths.

### 4.3 Integration with existing query flows

Integrate the enhanced statistical pass into existing flows that already call into the statistical service, including:

1. Versioned flow (pinned DSL → param files → graph update):
   - After batch fetch completes and slices are written or refreshed:
     - Run the enhanced statistical pass for the pinned DSL.
     - Update `p.n`, `p.mean`, completeness, and latency fields on the graph edges for that pinned DSL.
     - Optionally write `p.n` into param packs or graph JSON for the pinned view, if considered helpful.
2. Direct flow (interactive DSL with or without param files):
   - After fetching any required slices directly from Amplitude:
     - Run the enhanced statistical pass **for the current interactive DSL only**, without committing to param files beyond any existing policy.
     - Ensure the graph edges in memory have up‑to‑date `p.n`, `p.mean`, completeness, and latency for rendering.

In both flows, keep changes confined to services; menu components and UI layers should only call high‑level service methods and read edge fields already populated by the enhancement pass.

## 5. UI and DSL Layer Changes

### 5.1 Edge tooltips and inspectors

Update UI components that display edge metrics (for example probability inspectors, latency tooltips, and cohort views) so that:

1. They read and display:
   - `p.mean` as the primary probability figure.
   - `p.n` as the forecast population for the current DSL (in addition to or instead of any raw evidence n where it is helpful).
   - completeness and latency metrics as already designed.
2. They **do not introduce any new calculations**:
   - All numerical values must come directly from the enhanced edge state.
   - If debug views show `p.forecast.k`, they should label it clearly as an internal “expected converters” value.

### 5.2 DSL‑aware views

For any view that explains or visualises the impact of the DSL (for example cohort views or “All slices” diagnostics), ensure:

1. When describing population semantics, the UI clearly distinguishes:
   - Evidence‑level counts (directly from Amplitude).
   - Forecast‑level counts `p.n` derived from upstream structure.
2. Any textual descriptions, legends, or documentation links align with the definitions in `inbound-n-fix.md`.

No new DSL syntax is required; the change is in how existing DSL clauses drive the statistical enhancement pipeline.

## 6. Testing Strategy (High Level)

### 6.1 Unit and integration tests in TypeScript

Add or extend tests in the TS test suites to cover:

1. **Anchor edge case (A=X, 2‑step funnel)**:
   - Graph where the first edge's `from` node is also the anchor/START node.
   - Verify that:
     - `p.n` on this edge equals `evidence.n` directly (no convolution needed).
     - Downstream edges correctly receive this as their inbound population.
2. **Simple path graphs (3‑step funnel)**:
   - Anchor A → X → Y, with known synthetic slices on both edges.
   - Verify that:
     - `p.n` on A→X matches the expected forecast population given the synthetic data.
     - `p.n` on X→Y reflects the expected arrivals at X after convolving upstream probabilities.
3. **Branching graphs**:
   - Multiple inbound edges into X (for example A→X and B→X).
   - Verify that:
     - The node‑level inbound population for X is the sum of forecast converters on all inbound edges.
     - Downstream edges from X use this combined forecast population in their interpretation.
4. **Maturing cohorts**:
   - Synthetic scenarios where upstream cohorts gradually mature:
     - Check that as more evidence arrives, `p.mean` and the derived `p.n` converge toward the realised number of arrivals.
5. **Scenario / conditional_p selection**:
   - Graph with `conditional_p` on an edge, where different conditions activate different probability entries.
   - Verify that:
     - Changing the scenario (case variant) causes `p.forecast.k` to recompute with the appropriate effective probability.
     - Downstream `p.n` values reflect the scenario‑specific flow, not a blend.

These tests should focus on service behaviour and mathematical consistency, not on UI rendering.

### 6.2 End‑to‑end behaviour checks

For full flows that hit Amplitude (or mocks thereof), add high‑level tests that:

1. Run the full “fetch slices → enhance → render” pipeline for a small graph with latency edges.
2. Assert that:
   - Downstream edges show intuitively correct and monotonic completeness behaviour as cohorts mature.
   - Changing the DSL window or cohort range produces consistent changes in `p.n` and `p.mean`.

## 7. Migration and Backwards Compatibility

### 7.1 Existing graphs and param files

Because the new semantics rely on:

- Existing slice data.
- Existing latency configuration.
- New query‑time computations only.

No migration of existing graphs or param files is required beyond:

1. Updating TypeScript types and services as described.
2. Ensuring that any cached `p.n` fields for pinned DSLs are either recomputed on first use or ignored if they do not yet align with the new semantics.

### 7.2 Rollout considerations

During rollout:

1. It may be useful to gate UI exposure of new `p.n` semantics and any debug displays of `p.forecast.k` behind a configuration flag.
2. Early adopters can verify that downstream edges behave as expected (for example progressively lower completion rates anchored at the right node) before the feature is considered stable.

Once validated, the gating can be removed and the new semantics treated as the default behaviour for all latency‑aware graphs.


