## Lag Implementation Fixes – Proposal

### 1. Scope and Objectives

This document describes a set of targeted fixes to bring the current LAG (Latency-Aware Graph) implementation back into alignment with the design in `design.md`, with a particular focus on:

- Ensuring that `p.mean`, `p.evidence`, `p.forecast`, and latency scalars are computed and wired exactly as specified in the design (query-time vs retrieval-time semantics).
- Ensuring that graph edges and scenario param packs expose the correct scalars for the UI and scenario editor, without leaking internal or bulk data.
- Cleaning up naming and field usage so that param packs and runtime structures are consistent and predictable.

The intent is to change **wiring and responsibilities**, not to re‑design the maths, which is already specified in detail in `design.md`.


### 2. Current Behaviour vs Design – Gaps

#### 2.1 Query‑Time vs Retrieval‑Time Values

From `design.md` (query architecture and inference sections):

- `p.forecast` is primarily a **retrieval‑time** scalar, derived from mature cohorts in window slices for a pinned DSL, but reused at query time.
- `p.evidence` is a **query‑time** scalar: the raw observed rate over the current query window, defined as the sum of conversions over the sum of exposures.
- `p.mean` is also a **query‑time** scalar: a blended probability produced by Formula A, which incorporates forecasted tail conversions for immature cohorts.
- Latency scalars (`t95`, `median_lag_days`, `completeness`) are computed from lag fitting and cohort ages, and may be partially persisted for the pinned DSL, but are always conceptually tied to the current query window.

The current TypeScript implementation has the following gaps relative to that model:

- The latency maths pipeline (`statisticalEnhancementService`) correctly computes all of `p_evidence`, `p_mean`, `p_infinity`, `t95`, and `completeness` from per‑cohort data, but
  these scalars are not consistently written back into the graph edge or param files.
- `dataOperationsService`’s window aggregation path still treats the simple k/n estimate as the authoritative `mean` in the aggregated slice, and does not distinguish between raw evidence and the blended `p.mean` specified in the design.
- Graph edges currently receive raw evidence counts and some latency scalars via `UpdateManager`, but do not receive the query‑time `p.evidence.mean` or the Formula‑A `p.mean` in a way that is visible to the rest of the UI and the scenario machinery.


#### 2.2 Param Packs vs Param Files vs Graph Edges

The design draws a clear boundary between three layers:

- **Param files** (slices in the registry) hold raw n/k arrays, per‑cohort lag arrays, and a small number of pinned‑DSL scalars (such as baseline `p.forecast` and a t95 under that DSL).
- **Graph edges** hold query‑context scalars for the current interactive DSL: `p.mean`, `p.evidence`, `p.forecast`, and latency scalars; these can be re‑derived whenever the query changes.
- **Scenario param packs** hold only the scalars needed for scenario composition and rendering, expressed per edge and per scenario DSL, with no bulk arrays.

The current codebase is partially aligned with this separation, but has two important inconsistencies:

- Param packs (via `scenarios.ts` and `GraphParamExtractor`) already use nested `p.forecast.mean`, `p.evidence.mean`, and `p.latency.*` fields, matching how the UI and HRN keys behave, but the underlying graph edge rarely has those values populated by the real query pipeline. The e2e tests are currently synthesising some of these values rather than exercising the real path.
- Param files store a `mean` scalar in each `values[]` row, but in the latency path this is currently being fed with the simple k/n evidence rather than the blended `p.mean` for the pinned DSL, which is not what the design describes.


#### 2.3 Naming and Labelling

There is also a small but important naming mismatch between the design document and the current implementation:

- The design’s param‑pack section uses flat field names such as `forecast_mean` and `evidence_mean` as examples.
- The implemented scenario types and Param Pack DSL use nested shapes such as `p.forecast.mean` and `p.evidence.mean`, and the UI already expects HRN keys of that form.

Given the current reality of the codebase and your expectations in the HRN layer, the nested naming (`p.forecast.mean`, `p.evidence.mean`, `p.latency.*`) should be treated as canonical for implementation, and the older flat names in `design.md` can be regarded as needing editorial alignment rather than as a conflicting specification.


### 3. Target End State (Conceptual)

This section defines the **intended semantics** for each relevant field once the fixes are applied. It is deliberately implementation‑agnostic and focuses on behaviour.

#### 3.1 On Graph Edges (`edge.p.*`)

For any given interactive query DSL (window or cohort, plus contexts and cases), after the query pipeline runs for a latency‑tracked edge, the edge should satisfy:

- `edge.p.evidence.n` and `edge.p.evidence.k` hold the aggregated counts (sum of n and sum of k) over all cohorts or days in the current query window, consistent with the way `statisticalEnhancementService` builds `p_evidence`.
- `edge.p.evidence.mean` is the raw observed rate for that query, defined as `p_evidence = Σk / Σn`.
- `edge.p.evidence.stdev` holds an appropriate uncertainty measure for that evidence rate (for example, a binomial stdev based on Σn and `p_evidence`), consistent with the rest of the statistical enhancement layer.
- `edge.p.forecast.mean` holds the asymptotic conversion probability `p_infinity`, derived from mature cohorts (either from window slices or an implicit baseline, as per the design).
- `edge.p.forecast.stdev` holds an appropriate uncertainty measure for that forecast.
- `edge.p.mean` holds the blended probability from Formula A for that query DSL: the expected eventual conversions (including forecasted tail) divided by the total exposure across cohorts in the query.
- `edge.p.stdev` holds an uncertainty measure associated with `p.mean`.
- `edge.p.latency.completeness` holds the aggregate completeness over cohorts in the current query window, as defined in the design: the weighted fraction of eventual conversions that have already been observed.
- `edge.p.latency.t95` holds the effective 95th percentile lag for this edge, taking into account the current maturity and the quality gates discussed in the design.
- `edge.p.latency.median_lag_days` (and `mean_lag_days` if present) reflect the query‑context aggregate lag statistics used to fit the CDF.

Non‑latency edges continue to use the simpler semantics described in the design: evidence and mean coincide, and latency fields are either absent or treated as degenerate.


#### 3.2 In Param Files (`values[]` in parameter files)

For pinned DSL flows (versioned fetches into the registry), each `values[]` entry for a given canonical `sliceDSL` should represent a particular cohort or window slice under that pinned DSL, and:

- `values[].mean` should represent the blended `p.mean` for that slice under the pinned DSL, not just the raw k/n evidence.
- `values[].n` and `values[].k` must continue to store the raw counts that underpin that slice, so that evidence can always be recovered and new query windows can be evaluated without re‑hitting the source.
- `values[].latency.*` fields must store the slice‑level latency summaries (`median_lag_days`, `mean_lag_days`, `t95`, `completeness`) derived at retrieval time, as already described in `design.md`.
- `values[].forecast` (or the equivalent forecast field) must store the pinned‑DSL baseline forecast probability for that slice when window data is available.

Persisting a separate scalar for `evidence.mean` within `values[]` is **optional** from a design perspective, because raw evidence can always be reconstructed from `n` and `k`. If such a field is added in future, it must be named clearly and mapped consistently, but it is not a hard requirement for the fixes described here.


#### 3.3 In Scenario Param Packs (`ScenarioParams` / Param Pack HRN)

Per the design’s param‑pack section and your clarified expectations, scenario param packs should contain, per edge and per scenario DSL:

- `p.mean` and `p.stdev` as the scenario’s blended probability and uncertainty, suitable for edge width and CI rendering.
- `p.evidence.mean` and `p.evidence.stdev` as the scenario’s evidence rate and uncertainty, corresponding to the inner “evidence” layer in F/E/F+E rendering.
- `p.forecast.mean` and `p.forecast.stdev` as the scenario’s mature baseline probability and uncertainty, corresponding to the outer forecast layer where applicable.
- `p.latency.completeness`, `p.latency.t95`, and `p.latency.median_lag_days` as the latency‑display scalars needed for beads and lag visualisations.

Param packs must **not** include bulk arrays (`n_daily`, `k_daily`, `median_lag_days[]`, histograms), raw config internals (`legacy maturity field`, `anchor_node_id`), or raw provenance fields (`window_from`, `window_to`, raw `source` details). Those remain in param files and on the graph edge where needed for diagnostics, not in the scenario editor.


### 4. Concrete Fixes (By Responsibility)

This section outlines the concrete responsibilities and changes for each major component, without specifying code.

#### 4.1 Statistical Enhancement Layer

The existing statistical enhancement layer already computes all of the quantities described in the design (evidence probability, blended mean, completeness, t95, p‑infinity). No changes are required to the underlying maths for this proposal.

The key responsibility of this layer remains:

- Given per‑cohort or per‑day data and any necessary baseline information, produce a complete set of scalars: `p_evidence`, `p_mean`, `p_infinity`, `t95`, `completeness`, plus any needed uncertainty measures.

The only alignment work here is documentation: ensure that the names used in this layer are clearly documented as mapping to `p.evidence.mean`, `p.mean`, and `p.forecast.mean` in the rest of the system.


#### 4.2 Data Operations Layer

The key missing wiring today is in the data operations layer that takes time‑series slices (from param files or direct sources), aggregates them, and applies the statistical enhancement results.

The required behavioural changes are:

- When producing an aggregated scalar slice for a given query window, treat the **blended** probability from the enhancement layer as the `mean` that is written back to the param file or applied to the graph for that DSL, rather than the simple k/n evidence. This aligns `values[].mean` (and therefore `edge.p.mean` under pinned DSL) with the design’s definition of `p.mean`.
- In addition to raw `n` and `k`, explicitly compute and apply `p.evidence.mean` (and, where appropriate, `p.evidence.stdev`) onto the graph edge for the current query context, using the evidence scalar from the enhancement layer.
- Ensure that latency scalars (`completeness`, `t95`, and aggregate `median_lag_days`) from the enhancement layer are applied to `edge.p.latency.*` in a way that is consistent with the design’s storage architecture.
- Preserve the existing distinction between versioned flows (which also write slices into param files) and direct flows (which may update only the graph edge) while ensuring that the **graph edge** always reflects the full set of query‑time scalars after a query completes.


#### 4.3 Update Manager (File ↔ Graph Mappings)

The Update Manager is responsible for moving scalars between param file slices and graph edges for pinned DSL flows. To support the target semantics:

- The mapping that moves `values[latest].mean` into `edge.p.mean` must continue to do so, but with the understanding that `values[].mean` is now the **blended** probability for that slice.
- The mappings that move `values[latest].n` and `values[latest].k` into `edge.p.evidence.n` and `edge.p.evidence.k` remain valid and must be preserved.
- If, as an optional extension, we later choose to persist an explicit evidence scalar in the slice (for example, a dedicated evidence mean), the Update Manager would need corresponding mappings into `edge.p.evidence.mean` and `edge.p.evidence.stdev`. For the current proposal, the more important requirement is to ensure that the graph edge is updated directly by the data operations layer after each query, using the enhancement layer’s evidence scalar.
- Existing mappings for latency config and data fields (`legacy maturity field`, `anchor_node_id`, `latency.median_lag_days`, `latency.completeness`, `latency.t95`) should be reviewed to ensure they are consistent with the enhanced data flow, but they already broadly match the design’s expectations and do not require fundamental changes for this proposal.


#### 4.4 Types and Param Pack Extraction

To support the above behaviour consistently through the TypeScript type system and param‑pack machinery:

- The **graph‑level Evidence type** must be extended to include scalar fields for `mean` and `stdev`, in addition to the existing raw counts and provenance fields. This allows `edge.p.evidence.mean` and `edge.p.evidence.stdev` to be represented explicitly and consumed by the rest of the codebase.
- Scenario param types in `scenarios.ts` already use nested `p.forecast` and `p.evidence` objects with `mean` and `stdev` fields, and `GraphParamExtractor` has been updated to extract exactly the fields that should be visible in param packs. This nested structure should be treated as canonical, aligning with the HRN keys you expect to see.
- `GraphParamExtractor` should **rely entirely on the graph edge** for these scalars, not recompute them from raw n/k or param files. Once the data operations layer and Update Manager are correctly wiring `p.mean`, `p.evidence.mean`, `p.forecast.mean`, and latency scalars onto the edge, the extractor’s job is simply to copy those values into the sparse `ScenarioParams` representation for the current scenario.
- Param Pack DSL round‑tripping (flattening and unflattening) must remain selective: only `p.mean`, `p.stdev`, `p.evidence.mean`, `p.evidence.stdev`, `p.forecast.mean`, `p.forecast.stdev`, and the latency scalars should appear in param packs. Internal configuration fields and bulk evidential data must not leak into HRN keys.


### 5. Testing and Verification Strategy

Given the architectural complexity described in `design.md`, the fixes above must be validated end‑to‑end, not only at unit level. The existing `sampleFileQueryFlow.e2e.test.ts` is a good foundation for this and should be extended rather than replaced.

Key test expectations include:

- For a latency‑tracked edge with complete sample data in the test param files, a query in cohort mode and a query in window mode should both:
  - Use the real coverage and aggregation logic (including any implicit baseline windows) to assemble cohort/day data.
  - Pass that data through the statistical enhancement layer to compute `p.evidence`, `p.mean`, `p.forecast`, `t95`, and `completeness` according to the design formulas.
  - Write those scalars back onto the graph edge (`edge.p.*`) as described above.
  - Produce scenario param packs whose values for `p.mean`, `p.evidence.mean`, `p.forecast.mean`, and the latency scalars match what is mathematically expected from the sample data, within reasonable tolerances.
- Specific cases should be included to cover:
  - A fully mature cohort window, where evidence and blended mean coincide and completeness is near one.
  - A partially mature window, where evidence is significantly below forecast and blended mean sits between them.
  - A case with insufficient data for a reliable baseline, where forecast is unavailable but evidence and completeness are still computed.
- The e2e tests must **assert against the values produced by the real pipeline** (param files → data operations → statistical enhancement → graph edges → param packs), not against synthetic values created inside the test. This ensures that any regression in wiring or semantics is caught immediately.


### 6. Summary

The core of this proposal is not to change the underlying latency maths, which is already specified and mostly implemented, but to:

- Make the computed scalars from the latency and forecasting pipeline first‑class citizens on the graph edges for the current query DSL.
- Treat param files as a cache of raw evidence and pinned‑DSL scalars, with `values[].mean` representing the blended probability for that DSL rather than the raw evidence.
- Treat scenario param packs as a thin, user‑facing projection of those graph‑level scalars, exposing only `p.mean`, `p.evidence.mean`, `p.forecast.mean`, and the latency display fields required for the UI and scenario editor.

Once these responsibilities and data flows are enforced consistently, both the visualisation layer and the param‑pack based scenario editing should behave in line with the design and with your expectations from the sample data and interactive queries.

