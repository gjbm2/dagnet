## nqueryfixes.md

Last updated: 22-Dec-25

### Background and problem statement

We observed “reach drift” in Evidence mode where modelled reach probabilities (computed by composing edge probabilities) do not match observed reach counts derived from funnel evidence. After instrumented direct fetch logging (`tmp2.log`) and a fresh graph export (`test2.json`), the internal pipeline is consistent (what is logged is what is persisted), so the integrity problem is in the semantics of how denominators and horizons are defined, not in caching or writeback.

Two distinct failure modes were identified:

1) **Denominator shrinkage on MECE split edges**

- The graph encodes MECE fan-outs (outgoing edge probabilities sum to 1 at each split node).
- To enforce MECE, the auto-generated edge query strings include `.exclude(...)`, `.minus(...)` and/or composite forms.
- In the Amplitude adapter, `exclude(...)` is implemented using native segment filters.
- Native segment filters apply to the entire funnel population, which can shrink the “from-step” count returned by Amplitude, even when the intended denominator is “all arrivals at the from-node”.
- Result: for a MECE split edge, `evidence.n` can become “from arrivals subject to the branch restriction”, which breaks conservation and causes reach drift even with high completeness.

2) **Inconsistent cohort conversion windows across edges**

- In cohort (anchor) mode, Amplitude’s `cs` (conversion window) controls how long after the anchor event we allow users to complete downstream steps.
- When `cs` varies by edge, the effective definition of “arrived at node X” varies by which edge you look at (because “arrivals” are measured within different horizons).
- This guarantees non-conservation at shared nodes and therefore reach drift, even if all queries are otherwise correct and MECE.

We validated this with a controlled curl experiment: when the same cohort funnels are re-run with a single consistent `cs` equal to the maximum graph horizon, the mismatch between “arrivals at an intermediate node” and the downstream edge’s start population collapses to zero for the tested case (non-energy recommendation → switch registered).

This document specifies two changes to eliminate these failure modes.

---

### Change A: Auto-generate `n_query` wherever it is required for MECE maths

#### Goal

Ensure that MECE split edges always have a denominator definition that corresponds to **unrestricted arrivals at the from-node**, so that:

- outgoing probabilities at a split node can be treated as a valid partition of that node’s arrivals, and
- composed reach probabilities do not drift purely due to denominator shrinkage from split mechanics.

#### Non-goals

- Do not change user-authored overrides.
- Do not place business logic in UI/menu files.
- Do not create a separate, parallel “fetch-time special-case” path that diverges from the standard regeneration/update pattern.

#### Design principle (standard app pattern)

Generate `n_query` through the existing **MSMDC/query regeneration** path (the same place where auto query strings are produced), and rely on the existing **UpdateManager override flag mechanics** to protect user overrides.

#### When `n_query` is “required”

`n_query` is required when the edge’s query mechanics can change the start population in a way that conflicts with MECE semantics at the from-node.

The primary cases are:

- `.exclude(...)` in edge query strings (especially when implemented as native segment filters in the Amplitude adapter).
- `.minus(...)` / `.plus(...)` composite patterns that are used to enforce MECE splits.

In practice, this should be determined by the same logic that decides the query is being generated in a MECE-split context (for example: “this edge is a member of a generated fan-out partition”).

#### Generation rule

MSMDC/query regeneration should compute candidate `query` and `n_query` for all edges. Override flags must not suppress generation; they only suppress application of regenerated values.

When applying regenerated values to graph/files:

- If `query_overridden` is true, do not apply the regenerated `query` (leave the stored value unchanged).
- If `n_query_overridden` is true, do not apply the regenerated `n_query` (leave the stored value unchanged).
- Otherwise, apply regenerated values normally.

Separately, ensure that when an edge query is (or becomes) a MECE-split query (exclude/minus/plus semantics as described above), the generated candidate `n_query` represents “arrivals at the from-node” for the relevant mode.

The generated `n_query` should:

- match the slice mode semantics (cohort vs window),
- be stable and deterministic,
- be derived from graph structure (anchor and from-node), not from user reasoning.

#### Cohort mode (`cohort(...)`) semantics for generated `n_query`

For cohort-anchored funnels, define the base denominator as:

- “users in the cohort who reached the from-node within the same cohort conversion window”

Operationally, this corresponds to an anchor funnel of the form “anchor → from”.

This ensures that:

- the denominator is not shrunk by branch exclusions, and
- the denominator aligns with the same anchor semantics used elsewhere in the cohort slice.

#### Window mode (`window(...)`) semantics for generated `n_query`

For window-based evidence, the base denominator should correspond to:

- “all users at the from-node within the window bounds”

The concrete DSL representation should mirror whatever the established internal meaning of “arrivals at from” is for window mode in DagNet’s query DSL.

#### Persistence and override flags

This change must follow the existing override patterns:

- Do not set `n_query_overridden` as part of auto-generation.
- Do not overwrite any field where `*_overridden` is already true.
- Allow `n_query` to be copied to parameter files via existing UpdateManager mappings in contexts where the app already does such copying.

#### Expected outcome

MECE split edges that rely on exclusions/composites no longer shrink denominators when evidence is fetched, so:

- split-node outgoing probabilities remain interpretable as shares of the same population, and
- reach drift due to denominator shrinkage is eliminated (subject to the conversion window consistency in Change B).

---

### Change B: Use a single, graph-level cohort conversion window (`cs`) per slice

#### Goal

Eliminate non-conservation caused by per-edge cohort horizons by forcing a single consistent cohort conversion window across all cohort-mode funnel requests in a slice.

This makes “arrivals at node X” a coherent concept everywhere in the slice.

#### Policy

Define a graph-level cohort conversion window in days:

graph_cs_days = ceil(maxEdgeHorizonDays) + bufferDays

Where:

- maxEdgeHorizonDays is the maximum of the available latency horizon metric per edge (prefer path-level latency where available; otherwise use the best available edge latency horizon).
- bufferDays is a small constant (recommend 1–2 days) to absorb rounding and tail noise.

Clamp the result:

- graph_cs_days = min(graph_cs_days, 90)

If no latency horizon exists anywhere in the graph, fall back to the current default behaviour (typically 30 days).

#### Application rule

When executing cohort-mode evidence retrieval for a slice:

- Always send Amplitude `cs` based on graph_cs_days for all edges in that slice.
- Do not allow per-edge `cs` selection for cohort-mode evidence, even if individual edges have smaller path_t95 values.

#### Rationale

If `cs` differs per edge, then upstream and downstream edges are not measuring the same “arrivals” populations, which guarantees reach drift.

A single graph-level `cs` ensures:

- upstream arrival counts and downstream denominators agree (subject to data quality),
- flow conservation becomes plausible,
- reach probabilities computed by composition in E mode are meaningful against observed counts.

#### Performance considerations

Amplitude response size (daily series length) is driven primarily by the cohort date range length (number of days between cohort start/end) and number of funnel steps. Increasing `cs` changes the counts, not the number of returned daily points. However, a longer `cs` may increase query latency and rate-limit pressure; the 90-day clamp is intended to prevent pathological slow queries.

---

### Combined effects and ordering

These changes address complementary failure modes:

- Change B (graph-level `cs`) fixes horizon inconsistency drift.
- Change A (auto `n_query` generation for MECE splits) fixes denominator shrinkage drift introduced by MECE mechanics (exclude/minus/plus).

They should be implemented together for full effect.

---

### Verification plan (prose only)

#### Logging-based verification

Using diagnostic fetch logs:

- Confirm that all cohort-mode adapter executions report the same `cs` value for a slice.
- Confirm that MECE split edges that previously shrank denominators now use a denominator consistent with the from-node arrivals.

#### Data-level invariants to check

Within a single cohort slice:

- For any node X with a single upstream edge, the upstream edge’s implied arrivals at X should match the start population used by X’s downstream edges (to within data noise).
- For each MECE fan-out node, outgoing edge probabilities should sum to ~1 and should be defined over the same denominator population.

#### Targeted curl sanity checks

For a selected intermediate node (e.g. non-energy recommendation) and downstream edge:

- With `cs = graph_cs_days`, the “arrivals at X” funnel and the “X → downstream” funnel should report matching start populations for X.

---

### Open questions (for review)

- Whether graph_cs_days should be computed across all edges in the graph, or only edges participating in cohort-mode evidence retrieval for the slice.
- Whether bufferDays should be 1 or 2 by default (recommend 2 unless performance concerns are significant).


