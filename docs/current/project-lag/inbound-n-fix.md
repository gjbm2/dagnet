# Inbound‑n Fix – Forecast Population Semantics for Downstream Latency Edges

## 1. Problem Statement

Latency design today focuses on per‑edge probabilities and lag, but it does **not** fully specify how to define the effective population \(n\) for downstream edges under latency when cohorts are immature.

For a downstream edge from node X to node Y (for example `energy-rec → switch-registered`) with a cohort anchored at A (for example `household-created`), we currently have:

- Cohort funnels that give daily \(n_i, k_i\) for A‑anchored paths.
- Per‑edge blended probabilities `p.mean` (evidence plus forecast) and lag distributions.

However, we **do not** have a coherent notion of:

> “How many people will eventually arrive at node X for this cohort under the current DSL?”

This missing concept leads to confusing completeness behaviour for downstream edges and makes it hard to explain why their inferred probabilities do or do not “roll up” cleanly from upstream.

The goal of this document is to introduce a clear ontology for forecast populations and wire it into the existing Project LAG design.

## 2. Desired Semantics

### 2.1 What `n` should mean on a downstream latent edge

For any edge from X to Y, the effective population \(n\) used for completeness and interpretation should be:

- Not “all starts at the anchor A” (that would include users who never reach X).
- Not “arrivals at X observed so far” (that is incomplete for immature cohorts).

Instead, it should represent:

> **The expected number of people who will eventually reach X under the current DSL**, given both upstream probabilities and current cohort ages.

Intuitively:

- Upstream edges from the anchor to X determine **who is “eligible” to even see** the X→Y edge.
- For immature cohorts, many of those eligible users have not yet arrived at X, but we can forecast their eventual arrivals using upstream `p.mean` and lag distributions.

Downstream edges should be interpreted against this **forecast eligible population at X**, not against raw starts at A or partial arrivals at X.

### 2.2 Edge‑local vs path‑level view

The existing design already distinguishes:

- An **edge‑local view**: window slices and lag for each individual edge.
- An **anchor‑level view**: cohort slices anchored at A for the whole path A→X→Y.

What is missing is an explicit **path‑level population forecast** that carries forward the notion:

> “Given everything upstream of node X, how many users will ultimately arrive at X for this query?”

This is the object we need to define and propagate.

## 3. New Ontology Elements

### 3.1 Per‑edge forecast population: `p.n` and internal `p.forecast.k`

For each edge E from U to V, under a particular interactive DSL, we already have:

- `p.mean`: the blended “eventual” probability for this edge under the current DSL, combining evidence with forecast (Formula A).
- Slice‑level evidence from Amplitude (for example `n_daily`, `k_daily` and A‑anchored cohort data).

We refine the meaning of `p.n` and introduce an internal helper:

- `p.n` (exposed in the DSL and UI):
  - Semantics in this context: **forecast population for the edge under the current DSL**, derived from upstream structure and probabilities.
  - For inbound edges into X (for example A→X, B→X), this is a **step‑wise, convolved quantity**:
    - Start from anchor cohorts at A.
    - Push mass forward along the path using upstream `p.mean` values, aggregating at intermediate nodes.
    - The resulting `p.n` on an inbound edge represents “how many users we expect to traverse this edge under the current DSL”, not just the raw observed Amplitude `evidence.n`.
  - As cohorts mature and upstream `p.mean` stabilises on long‑run behaviour, this forecast converges towards the realised number of users who actually traversed the edge, but it remains a derived model quantity.

- `p.forecast.k` (internal, **not** exposed in the DSL):
  - Semantics: expected total number of conversions on this edge for the cohorts or dates covered by the current DSL.
  - Defined as “`p.mean` applied to `p.n`” for the current query.
  - Conceptually, this is the sum of per‑cohort expected converters after applying Formula A.
  - This value is **query‑time**, scenario‑aware, and used inside the statistical service as a building block for propagating population to downstream nodes.

The DSL and graph UI should treat `p.n` as the primary “how many people is this edge about under this DSL?” quantity. `p.forecast.k` stays inside the statistics layer and is only surfaced, if at all, in diagnostic tooling.

### 3.2 Using inbound population for downstream edges

For each downstream edge from X to Y:

- The **probability semantics** on the edge remain as designed:
  - `p.evidence` and `p.mean` are computed from the X→Y slices using Formula A and lag CDFs.
- The **population semantics** for completeness and explanatory tooling should be based on the **total expected arrivals at X** under the current DSL:
  - Internally, the statistical service sums `p.forecast.k` across all inbound edges whose `to` node is X.
  - That sum is then used as the effective `n` when interpreting all outgoing edges from X, especially latency edges for immature cohorts.
  - This node‑level sum is a transient implementation detail and does not need its own named field in the DSL or schema.

This links downstream completeness to the upstream view of who is expected to reach X, rather than to raw anchor counts or partially observed arrivals at X.

## 4. Data Model and Type Changes (High Level)

The following changes are needed at the schema and type level.

### 4.1 Graph‑side probability types

In the TypeScript graph types:

- Extend the probability parameter representation so that it can carry, per query or per pinned DSL:
  - An explicit `p.n` field for the **forecast population** used in the last enhancement run for that DSL (derived step‑wise from upstream `p.mean`s and slice evidence).
  - A transient, query‑time `p.forecast.k` field used **internally** by the stats layer and, at most, surfaced in low‑level diagnostics.

Persisted graph JSON and IndexedDB should only store `p.n` where it represents the pinned DSL view; `p.forecast.k` should remain a derived quantity that can be recomputed when the interactive DSL changes and should not be part of the public DSL surface.

### 4.2 Parameter files

Parameter files do not need to change schema to support `p.n` or `p.forecast.k` directly, because:

- The building blocks already exist in slices:
  - Per‑cohort or per‑day populations (`n_daily`).
  - Per‑cohort lag and window coverage.
- Query‑time aggregates such as `p.n` and `p.forecast.k` are derived from those slices and from the fitted lag distributions.

What may be added is:

- A clear comment and doc section in the parameter schema and public docs explaining that:
  - Edge‑level values such as `mean`, `n`, `k`, and `latency` in param files are **slice‑level evidence and retrieval‑time summaries**.
  - Query‑time constructs like `p.n` and `p.forecast.k` are computed by the enhancement layer on top of these slices and are not extra fields in the param files.

### 4.3 Python models

Pydantic models in the Python layer do not need new persisted fields for `p.forecast.k`. They may need:

- Documentation comments clarifying that:
  - Retrieval‑time statistics supplied by the Python services (for example those derived from window slices and cohort slices) are inputs to the TypeScript enhancement layer.
  - `p.n` and `p.forecast.k` are downstream aggregates on the TS side, not additional values coming back from Amplitude.

## 5. Algorithmic Flow (Prose Only)

### 5.1 High‑level enhancement stages

For a given interactive DSL and scenario, the enhancement pipeline should conceptually proceed as follows (re‑using the existing topological ordering used elsewhere in Project LAG):

1. **Per‑edge local enhancement**:
   - For every edge, look up the relevant slices (cohort and/or window) from param files or direct fetch responses.
   - From those slices and the current DSL, compute slice‑level evidence and apply lag‑aware Formula A to derive `p.mean` and completeness for this edge.
2. **Per‑edge forecast population and converters**:
   - Using upstream structure and `p.mean` values (step‑wise convolution from the anchor), derive a forecast `p.n` for each edge under this DSL.
   - From `p.n` and `p.mean`, derive an internal `p.forecast.k` (“expected converters on this edge for this query”).
3. **Per‑node inbound population use for downstream edges**:
   - At each node X in topological order:
     - Sum `p.forecast.k` across all inbound edges whose `to` node is X.
     - Use that sum as the effective `n` when interpreting all outgoing edges from X, particularly latency edges for immature cohorts.

These stages can be implemented within the existing statistical enhancement service without changing the external API surface, as long as they respect the “no business logic in UI files” rule and keep all heavy lifting in services.

## 6. UI and Reporting Implications

Introducing this ontology gives us new quantities that can be optionally surfaced in the UI:

- On an edge tooltip or inspector:
  - Show `p.n` (forecast population under the DSL, derived from upstream structure and evidence).
  - Show `p.mean` (blended eventual probability).
  - Optionally show `p.forecast.k` in a diagnostics view (for example advanced tooltips or a debug panel), but not as a first‑class DSL field.

These values are particularly useful for explaining why downstream edges may appear more or less complete than naive expectations based solely on raw starts or partial arrivals.

## 7. Open Questions and Follow‑Ups

1. **Scenario interactions**:
   - How should `p.n` and internal `p.forecast.k` behave when cases and conditional probabilities change the set of active inbound edges to a node?
   - The working assumption is that they should be recomputed per scenario using the same active edge logic as path maturity.
2. **Multi‑anchor or multi‑entry graphs**:
   - When multiple start nodes or alternative anchors are in play, we need clear rules for which anchor and which path are used when labelling cohort slices and when computing step‑wise forecast populations.
3. **Persistence**:
   - Which, if any, of these quantities should be persisted for the pinned DSL view and which should remain purely query‑time, especially in IndexedDB?
   - The default stance is that `p.n` may be persisted for convenience, while `p.forecast.k` and node‑level sums remain transient.

These questions should be resolved in incremental design deltas as we wire this ontology into the existing Project LAG implementation.


