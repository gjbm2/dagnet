# Domain Primer

What DagNet is, and the three load-bearing concepts to internalise before reading anything deeper.

For codebase architecture, see [TOPOLOGY.md](TOPOLOGY.md).
For acronyms, see [GLOSSARY.md](GLOSSARY.md).

---

## What this software does

DagNet models **conversion funnels** as directed acyclic graphs (DAGs).

A node is a user state ("signed up", "activated", "purchased"). An edge is a conversion step from one state to the next, carrying:

- a **probability** — what fraction of users at the source eventually reach the target
- optionally, a **latency** distribution — how long it takes for those who do convert

Users build these graphs in a browser-based editor, connect edges to live data sources (Amplitude, Sheets, Postgres), and the app answers questions like:

- "What's the probability of A → B → D?"
- "How long until 95% of users who reach C will have reached D?"
- "What if we doubled the conversion rate of edge X — how much does the end-to-end change?"
- "Given today's data, what does the cohort that started in November look like at maturity?"

The hard parts of the modelling:

- **Right-censoring** — recent cohorts haven't finished converting yet; their observed `k/n` understates the true rate. The system must predict "what will this cohort look like once mature?"
- **Path latency** — the lag from cohort entry to a downstream node depends on every edge upstream, not just the final one. Composed via Fenton-Wilkinson moment-matching.
- **Uncertainty** — point estimates aren't enough. The system maintains Bayesian posteriors with HDIs and predictive bands, fitted offline by an MCMC compiler.
- **Slicing** — context dimensions (channel, device, geography) need to be analysed independently and aggregated MECE-correctly.

The system is **git-native**: graphs and parameter files are YAML/JSON committed to a GitHub repo. Git is persistence, collaboration, and audit trail. Models can be diffed, reviewed, and shared like code.

The architecture is **browser-orchestrated**: the FE drives every operation. The Python backend is stateless request/response (Vercel serverless or local dev server). Long-running MCMC runs on Modal with results returning via webhook → atomic git commit.

---

## The three load-bearing concepts

If you understand these three, every other doc makes sense. If you don't, you'll get lost.

### 1. The DSL: window vs cohort

The query DSL is how users describe what they're asking about. Two query modes — `window()` and `cohort()` — are mutually exclusive and select fundamentally different semantics.

**`window(start:end)`** — edge-local mode. The "cohort" is users who arrived at the **edge's source node** within the date range. Latency is **edge-level** (X→Y only). Denominator is fixed: the count of arrivals at X on each anchor_day. Used when you want "what is the rate of this single edge, measured locally?"

**`cohort(start:end)`** or **`cohort(anchor, start:end)`** — anchor-anchored mode. The "cohort" is users who entered at the **anchor node A** within the date range. Latency is **path-level** (accumulated from A through all upstream edges to X). The denominator at X grows over time as upstream maturity delivers people. The displayed rate is still `y/x` (edge rate), but the population being tracked is the anchor cohort rather than the local arrivals at X.

The two modes produce **different distributions on the same edge**. Two effects drive the divergence:

1. **Temporal spread (diffusion)** — cohort members arrive at X spread across the A→X path latency (potentially 100+ days). Even with a stable underlying conversion rate, this widens the cohort outcome distribution relative to a temporally localised window observation.
2. **Temporal shift (real drift)** — conversion rates genuinely move over time. Window captures the current rate; cohort reflects a historical blend. The divergence between them is itself a forecasting signal.

Window and cohort are **distinct distributions, not different views of an invariant rate**. The Bayes compiler maintains separate posteriors for each mode (`alpha`/`beta` vs `cohort_alpha`/`cohort_beta`). Treating them as the same quantity produces double-counted evidence and silently wrong numbers.

A third mode — **`asat(date)`** — is a historical cap: "show me the result as it would have appeared at this date". It's an evidence-and-posterior-frontier, not just a chart label.

See [RESERVED_QUERY_TERMS_GLOSSARY.md](RESERVED_QUERY_TERMS_GLOSSARY.md) for canonical term definitions, [STATISTICAL_DOMAIN_SUMMARY.md](STATISTICAL_DOMAIN_SUMMARY.md) for the underlying model, and [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) for the semantic contract any implementation must preserve.

### 2. The 4-layer state model

This is where every "the value keeps coming back after I deleted it" bug lives.

A single piece of data — say, a Bayesian posterior on an edge — exists simultaneously in **four layers**:

1. **Parameter file** (`file.data.posterior`) — durable, in IDB, the source of truth on disk.
2. **Graph edge projected value** (`edge.p.posterior`, `edge.p.latency.posterior`) — projected onto the live graph by UpdateManager mapping configurations.
3. **Stashed slices** (`edge.p._posteriorSlices`) — raw per-slice data used for re-projection when the query DSL changes.
4. **React render tree** — whatever object reference React last saw via `setGraph`.

Clearing layer 1 doesn't cascade to layers 2-4 automatically. A new `setGraph(graph)` call without a fresh object reference doesn't re-render. UpdateManager re-projects on every relevant change, so partial cleanups silently re-populate the graph from stashed slices.

To delete a value cleanly:

- clear all four layers
- call `setGraph` with a new reference (`structuredClone(graph)` or a UpdateManager method that returns one)
- **test the idempotent case** — where the data is already absent, the cleanup must still clean derived state

This is anti-pattern 1 in [KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) and the root cause of more multi-attempt fixes than any other category.

The same 4-layer pattern applies to data sync directions: `Git ↔ IDB ↔ FileRegistry ↔ GraphStore ↔ ReactFlow`, with bidirectional guards (`isSyncingRef`, `suppressFileToStoreUntilRef`, `writtenStoreContentsRef`) preventing feedback loops. The full map is in [SYNC_SYSTEM_OVERVIEW.md](SYNC_SYSTEM_OVERVIEW.md).

### 3. Source layer vs query-scoped current answer

Probability and latency posteriors live on **two different layers** that serve different purposes. Conflating them produces double-counted evidence and silently wrong numbers — the most frequent class of statistical bug after the 4-layer one.

**Source layer (aggregate)** — `edge.p.model_vars[source].*`. These are aggregate posteriors fitted from a training corpus. Multiple sources can coexist:

- `bayesian` — offline MCMC fit (durable, periodically refreshed).
- `analytic` — moments-based Beta fit produced by FE topo Step 1. Despite being derived from query-scoped evidence at fit time, it's stored as an aggregate posterior for downstream consumers.
- `manual` — user override; always wins.

Promotion (`applyPromotion` in `modelVarsResolution.ts`) selects one source per edge by hierarchy.

**Current-answer layer (query-scoped)** — `edge.p.mean`, `edge.p.sd`, `edge.p.latency.completeness`, `edge.p.latency.completeness_stdev`. These combine the promoted source with the current query's scoped evidence:

- **FE topo Step 2** produces a fast analytic blend.
- **BE CF pass** produces the careful version (IS-conditioned MC) and overwrites Step 2's output when it lands.

**The crucial implication**: when you read `edge.p.mean`, you're reading the answer to the user's **current** query. When you read `edge.p.model_vars[bayesian].probability.alpha`, you're reading an **aggregate** prior.

Treating them interchangeably leads to two failure modes:

- **Double-counting**: using a query-scoped posterior as a prior for a conjugate update with the same query-scoped evidence.
- **Missing query relevance**: using an aggregate prior as if it were the answer for the current query.

The `ResolvedModelParams.alpha_beta_query_scoped` flag distinguishes them at the consumer boundary: True for analytic (already query-scoped); False for bayesian/manual (aggregate priors that need conditioning).

See [STATS_SUBSYSTEMS.md](STATS_SUBSYSTEMS.md) for the full layer disambiguation, and [FE_BE_STATS_PARALLELISM.md](FE_BE_STATS_PARALLELISM.md) for how FE topo and CF cooperate.

---

## Two more concepts that pay back quickly

These aren't in the same league as the three above, but understanding them saves time:

### Snapshot DB virtual reconstruction

The DB stores **partial fetches** (the latency-window "gap" data) at each `retrieved_at`, not complete cohort snapshots. To answer "what did we know on date X?", queries reconstruct a **virtual snapshot** via latest-wins per `anchor_day` over the cohort range. Multiple `retrieved_at` values for the same `anchor_day` form a panel: the same cohort observed repeatedly over time. The Bayes compiler uses the full panel; FE analyses use only the latest per `anchor_day`.

See [SNAPSHOT_DB_ARCHITECTURE.md](SNAPSHOT_DB_ARCHITECTURE.md) and [snapshot-db-data-paths.md](snapshot-db-data-paths.md).

### Hash-as-identity for queries

Same query semantics → same `core_hash`. The hash is a content-addressed identity of `{connection, event_ids, filters, cohort_mode, latency, normalised_query}` plus context-definition hashes. Cache hits work across edits and branches because semantics drive the key, not file path. When event/context definitions change, the hash changes — `hash-mappings.json` provides equivalence links so historical data remains discoverable.

See [HASH_SIGNATURE_INFRASTRUCTURE.md](HASH_SIGNATURE_INFRASTRUCTURE.md).

---

## What to read next

- **[TOPOLOGY.md](TOPOLOGY.md)** — system map, subsystem dependencies.
- **[TOUR_PROBABILITY_EDIT.md](TOUR_PROBABILITY_EDIT.md)** — concrete walkthrough of one user action through the layers.
- **[GLOSSARY.md](GLOSSARY.md)** — keep this open while reading.
- **[TASK_TYPE_READING_GUIDE.md](TASK_TYPE_READING_GUIDE.md)** — if you have a specific task in hand.
- **[INVARIANTS.md](INVARIANTS.md)** — must-be-true rules.
