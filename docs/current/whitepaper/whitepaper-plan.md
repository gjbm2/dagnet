# White Paper Plan: Compiled Bayesian Inference on Conversion Graphs

**Status**: Draft plan — progressive refinement
**Last updated**: 24-Mar-26

---

## Working Title

**"From Funnels to Inference: A Graph-Compiled Bayesian Approach to Conversion Analytics"**

Alternative: *"The Graph IS the Model: Dynamic Bayesian Compilation for Conversion Graph Analysis"*

---

## Two Threads, One Paper (or Two)

This plan contains two genuinely distinct contributions that are interleaved
because they emerged from the same project:

**Thread A — The Bayesian compiler** (the technical/statistical contribution):
Sections 2–7, 9. How a conversion graph is compiled into a hierarchical Bayesian
model, the LAG latency framework, the inference pipeline, the surprise/
intervention/comparison capabilities. This is the "Bayes helps me run my
business" argument. It stands on its own as a research paper.

**Thread B — The tool development journey** (the engineering/methodological
contribution): Sections 1.1, 1.4, 8, 11. Why the display/data asset split in
organisations is the root problem; why a graph is the right representation
(cognitive science); the architectural choices that make a solo build possible
(git-native, client-centric, serverless); the agentic engineering methodology;
the bidirectional code↔graph loop. This is "how and why this tool came to
exist." It provides essential context for Thread A but could also stand alone.

**Sections that serve both threads**: 1.2–1.3, 1.5 (motivation and gap
analysis), 10 (discussion), 12 (conclusion).

These may be **one paper or two** — genuinely undecided. Both threads are
individually strong enough to stand alone:

- **Paper A** — *"From Funnels to Inference"*: the Bayesian compiler, LAG
  framework, hierarchical model, surprise/intervention capabilities.
  Audience: applied statisticians, marketing scientists, probabilistic
  programming researchers.

- **Paper B** — working title TBD, something like *"The Interrogable Diagram"*
  or *"One Developer, 743K Lines"*: why the display/data asset split in
  organisations is the root problem; the cognitive case for graph-native
  analytics; architectural choices that make a solo build viable (git-native,
  client-centric, serverless); agentic engineering methodology and the
  bidirectional code↔graph loop. Audience: engineering leadership, product/
  analytics practitioners, people interested in what agentic AI changes about
  software development.

Or they could be a single "systems paper" that tells the full story from origin
insight to inference engine to how it was built. The risk of combining is
length and audience diffusion; the risk of splitting is losing the narrative
thread that connects "I wanted a diagram" to "so I built a Bayesian compiler."

For now, both threads are developed in this single plan document. Sections are
tagged **[A]**, **[B]**, or **[A+B]** so either split is possible later
without restructuring.

---

## Thesis Statement

DagNet introduces a **graph-to-model compiler** that automatically translates a
business conversion graph — with its nodes, edges, observed data, and temporal
structure — into a hierarchical Bayesian model executable by a standard MCMC
engine. This eliminates the manual model-specification step that separates every
existing probabilistic programming workflow from business practitioners, and
enables a class of questions no current analytics platform can answer: *"what is
surprising?"*, *"what would happen under intervention?"*, and *"how do concurrent
experiments interact across the conversion structure?"*

---

## Core Commercial Questions

The paper is framed around four questions that DagNet seeks to answer and that
existing tooling cannot:

1. **"What is unexpected in my business? Is what happened this week concerning
   or surprising?"** — Surprise detection via posterior predictive checks
   against the graph's learned generative model. Not "metric X went down" but
   "metric X went down more than the graph structure and upstream evidence
   would predict."

2. **"What would happen if we did things in a different order?"** —
   Interventional reasoning: because the conversion graph is already a causal
   DAG, do-calculus queries are structurally available. Reorder nodes, observe
   implied probability changes via the compiled model.

3. **"How do different conversion paths and/or approaches differ in their
   effectiveness?"** — Path comparison with uncertainty: not just "path A
   converts at 12% and path B at 15%" but "the posterior probability that path
   B is genuinely better than path A is 0.93, accounting for sample size,
   latency maturation, and shared upstream structure."

4. **"What experiments are we currently conducting and how do they impact
   expected performance?"** — Joint experiment modelling: case nodes in the
   graph represent concurrent A/B tests, and the compiled Bayesian model
   captures their joint distribution, including interaction effects that
   isolated testing tools miss entirely.

---

## Proposed Structure

### 1. Introduction & Motivation (5–6 pages) **[A+B]**

#### 1.1 The origin insight: wanting a diagram that is also a model **[B]**

The project began with a deceptively simple desire: **a Sankey-style diagram of
our actual conversion flow, with real numbers on it**.

This turns out to be surprisingly hard to get from existing BI tools. Funnel
analytics platforms (Amplitude, Mixpanel, GA4) present conversion as a linear
sequence of steps — a bar chart that shrinks left to right. They do not render
the actual topology of how users move through a product: the branches, the
parallel paths, the re-entries, the experiments that split traffic, the dead
ends. Sankey/flow visualisation tools (e.g., Google Charts, D3 Sankey, Plotly)
can draw the diagram, but they are static renderers — they take pre-computed
numbers and display them. There is no connection back to the data source, no
query engine, no way to ask "show me this diagram but only for mobile users
last week."

In practice, organisations end up with two disconnected artefact classes:

- **Display assets**: conversion flow diagrams drawn in Figma, Excalidraw,
  Miro, or PowerPoint. These are visually clear and spatially intuitive — they
  show the topology. But they are inert. The numbers on them are pasted in
  manually, stale within days, and disconnected from any data source. They are
  maintained by product or design teams and updated on a "when someone
  remembers" cadence.
- **Data assets**: dashboards, charts, and tables in Amplitude, Looker, or
  Google Sheets. These are connected to real data and update automatically. But
  they are not diagrammatic — they are tabular or chart-based, organised by
  metric rather than by flow topology. They are maintained by analytics or data
  teams. The "source of truth" for the conversion structure often lives in code
  (route definitions, event instrumentation), which neither the display assets
  nor the data assets reference directly.

Nothing unites these surfaces. The diagram doesn't know about the data. The
data doesn't know about the diagram. The code doesn't know about either. Teams
move between Figma, Amplitude, and the codebase, mentally reconstructing the
mapping between them — which node in the diagram corresponds to which event in
Amplitude corresponds to which route in the code. This reconstruction is
error-prone, time-consuming, and different people do it differently, which is
how semantic disagreements arise ("are we measuring the same thing?").

DagNet collapses this into a single artefact: **a diagram that IS the data
asset, that IS connected to the data source, and that IS the input to the
statistical model**. The topology is drawn once and is the source of truth for
queries, for display, and for inference. When the data updates, the diagram
updates. When the diagram is edited, the queries update. There is no
translation layer to maintain, no manual number-pasting, and no drift between
what the diagram shows and what the data says.

The moment you want this unified diagram to be more than decorative — the moment
you want it to be **interrogable** — you cross a further threshold:

- **Conditional**: "show me this flow, but only for users who visited node X"
  — requires path-aware query generation (which events to include/exclude)
- **Contextual**: "show me this flow segmented by channel" — requires
  multi-dimensional slicing with MECE (mutually exclusive, collectively
  exhaustive) awareness
- **Temporal**: "show me this flow for the cohort that entered last week, with
  projected maturation" — requires latency modelling and right-censoring
  correction
- **Comparative**: "show me this flow side-by-side for two scenarios" —
  requires scenario overlays with sparse parameter diffs
- **Probabilistic**: "show me how confident we are in each edge" — requires
  uncertainty quantification, which requires a statistical model
- **Interventional**: "what would this flow look like if we removed step 3?"
  — requires a causal model, not just observed data

Each of these requirements, individually, pushes you into bespoke tooling. No
existing product satisfies more than one or two. Together, they define the
design space that DagNet occupies — and the reason it exists is that the first
requirement (a visual diagram of the actual flow) is so natural and so
universally desired that the absence of a tool that does it properly is itself
a market signal.

The progression from "I want a diagram" to "I want the diagram to answer
questions" to "the diagram needs a generative model behind it" to "the model
should be compiled from the diagram's structure" is the intellectual trajectory
of this project. Each step follows naturally from the last. The result is a
system where the visual representation, the query engine, and the Bayesian
inference model all operate on the same underlying graph — because they must.

#### 1.2 The commercial questions that drive the work **[A+B]**

Frame around the four core questions. Each question maps to a concrete
analytical capability:

| Question | Capability | Existing gap |
|---|---|---|
| What's surprising? | Posterior predictive surprise | Analytics tools report raw metrics; no generative model to define "expected" |
| What if we changed the order? | Interventional reasoning on the DAG | No tool bridges conversion graphs and causal inference |
| How do paths compare? | Path comparison with full posterior uncertainty | Funnel tools report point rates with no uncertainty propagation |
| How do experiments interact? | Joint experiment modelling | A/B tools assume experiment independence |

#### 1.3 Why existing tools fail these questions **[A+B]**

Brief taxonomy of current approaches (expanded in Related Work):

- **Funnel analytics** (Amplitude, Mixpanel, GA4): descriptive, linear, no
  uncertainty, no causal structure
- **A/B testing platforms** (VWO, Optimizely): isolated experiments, no graph
  context, no joint effects
- **Attribution models** (Shapley, Markov removal): correlational credit
  allocation, not causal inference
- **Anomaly detection** (CausalImpact, Prophet): univariate time series, no
  graph-aware propagation
- **Probabilistic programming** (Stan, PyMC): powerful inference engines, but
  require manual model specification — the "last mile" gap between business
  graph and probabilistic model

#### 1.4 Why a graph: the cognitive case for visual reasoning **[B]**

Before describing the technical contribution, it is worth stating a foundational
premise: **humans are poor at reasoning about numbers and excellent at reasoning
about spatial/visual structures**.

This is not a design preference — it is a well-established finding in cognitive
science. Humans struggle to hold more than a handful of numerical comparisons in
working memory (Miller, 1956; Kahneman, 2011), are systematically poor at
intuiting proportions and conditional probabilities (Gigerenzer & Hoffrage,
1995), and are prone to anchoring, base-rate neglect, and framing effects when
presented with tabular data. By contrast, spatial and graphical representations
engage the visual-spatial processing system, which operates in parallel, detects
patterns pre-attentively, and supports rapid comparison without sequential
enumeration (Ware, 2012; Tufte, 2001).

The practical consequence for organisations is that **discussions about
conversion performance conducted over spreadsheets and dashboards routinely
degenerate into arguments about semantics** — what does this metric mean? Are
we looking at the same cohort? Is this the right denominator? These are not
productive disagreements about strategy; they are artefacts of a representation
that forces participants to reconstruct the conversion structure in their heads
from flat numbers.

A visual graph representation resolves this:

- **Shared spatial model**: everyone in the room is looking at the same
  structure. Node A feeds into node B — this is visible, not inferred from
  column headers.
- **Immediate context**: when discussing the conversion rate on edge X → Y,
  the upstream and downstream structure is visible. The question "what feeds
  into this?" is answered by looking at the graph, not by querying a database.
- **Disambiguation by construction**: the graph's topology disambiguates
  metrics that would otherwise be conflated in a table. "Conversion rate from
  landing to purchase" and "conversion rate from landing to purchase via
  signup" are visually distinct paths, not rows that differ by a filter value.
- **Normalised vocabulary**: the graph imposes a shared vocabulary — node names,
  edge labels, path descriptions — that prevents the semantic drift that plagues
  organisations where different teams use different definitions for the same
  metric.

The graph is therefore not merely a visualisation of the model — it is the
**organisational interface** through which teams align on what they are measuring,
what they are comparing, and what they are debating. The Bayesian inference
engine operates on the same structure, ensuring that the statistical model and
the organisational conversation are about exactly the same thing.

#### 1.5 The core contribution: a compiler, not a model **[A]**

The novelty is not a new statistical model per se (Beta-Binomial,
Dirichlet-Multinomial, and shifted lognormals are established). The novelty is
the **systematic compilation** from a domain-specific graph representation to a
probabilistic program — analogous to how a SQL compiler translates declarative
queries into execution plans. The graph IS the model specification language.

---

### 2. Background & Definitions (3–4 pages) **[A]**

#### 2.1 Conversion graphs: formal definition

Define the conversion graph G = (V, E, θ) where:

- **V**: nodes (conversion states) with types {normal, case}, flags {start,
  absorbing}, outcome classifications {success, failure, error, neutral}
- **E**: directed edges with probability parameters p_e, optional latency
  parameters (δ_e, μ_e, σ_e), optional cost parameters
- **θ**: graph-level metadata (data interests, contexts, active scenarios)

Distinguish from standard DAGs in Bayesian network literature: conversion graphs
have **operational semantics** — nodes correspond to measurable events, edges to
observable transitions with sample sizes — that provide both the structure AND
the data contract for inference.

#### 2.2 The query DSL and data contract

Explain how the query DSL (`from(X).to(Y).visited(Z).context(k:v).window(d1:d2)`)
provides a declarative specification of what each edge's observed data means.

The MSMDC algorithm (Minimal Set of Maximally Discriminating Constraints)
automatically generates the correct constraints to uniquely identify a target
path — critical for graphs with multiple paths between the same nodes. Greedy
set-cover approach with ~ln(k) approximation guarantee. Performance: <5–10ms per
edge; <50ms for ~100 params.

Query factorisation reduces N independent parameter fetches to M optimised
queries using weighted set cover, typically cutting API calls by 70–85%.

#### 2.3 Bayesian fundamentals for this domain

Brief review of:
- Beta-Binomial conjugacy for conversion rates
- Dirichlet-Multinomial for branching nodes
- Rationale for overdispersion (day-to-day variation exceeds Binomial noise)
- Notation established for the remainder of the paper

---

### 3. The Latency-Aware Graph (LAG) Framework (4–5 pages) **[A]**

**This is a significant sub-contribution deserving its own section.**

#### 3.1 The right-censoring problem in conversion analytics

Traditional conversion rates systematically understate truth for recent cohorts.
If median time-to-convert is 3 days, a 1-day-old cohort shows roughly half its
eventual conversions. Every analytics tool reports this naive rate. The standard
industry workaround is "wait longer" — DagNet's approach is "model the latency
and project forward."

#### 3.2 Shifted lognormal latency model

```
T_e = δ_e + X_e,    X_e ~ LogNormal(μ_e, σ_e)
```

- δ_e: onset delay (dead time before any conversions)
- μ_e, σ_e: fitted from observed median and mean lag times
- Derivation: μ = ln(median), σ = √(2 · ln(mean / median))

#### 3.3 Completeness and evidence-forecast blending

Define completeness c_e(t) = F_LN(t − δ_e; μ_e, σ_e) as the fraction of
eventual converters observed by cohort age t. For immature cohorts, blend
observed evidence with baseline forecast:

```
p_hat = w · p_obs + (1 − w) · p_baseline

where w = (c · n_query) / (λ · n_baseline + c · n_query)
```

#### 3.4 Path-level latency composition (Fenton-Wilkinson)

For multi-hop paths A → B → C, total latency is the sum of shifted lognormals.
The Fenton-Wilkinson moment-matching approximation collapses this sum back to a
shifted lognormal:

```
T_{A→C} ≈ (δ_AB + δ_BC) + LogNormal(μ_FW, σ_FW)
```

Present the FW composition formulae. Note approximation quality: good for
moderate σ, degrades for very heterogeneous path segments.

#### 3.5 Join-node moment-matched collapse

When multiple inbound paths merge at a node, the inbound latency distribution is
a mixture of shifted lognormals. Collapse to a single shifted lognormal via
moment-matching of the weighted mixture. Critical for making downstream
composition tractable.

**Key citations**: Fenton (1960) for lognormal sum approximation; Abu-Dayya &
Beaulieu (1994) for extensions. Note that applying FW composition to conversion
path latencies appears to be novel.

---

### 4. The Compiler Architecture (5–6 pages) — Core Contribution **[A]**

#### 4.1 Design philosophy: three-phase IR pipeline

The compiler is structured as three deterministic functions, each producing an
intermediate representation (IR):

| Phase | Input | Output IR | PyMC dependency |
|---|---|---|---|
| `analyse_topology()` | Graph snapshot | `TopologyAnalysis` | None |
| `bind_evidence()` | TopologyAnalysis + parameter files | `BoundEvidence` | None |
| `build_model()` | BoundEvidence | `pm.Model` | Yes (only phase) |

**Key design decision**: Phases 1–2 are pure Python with no probabilistic
programming dependency. The IR is inspectable, serialisable, cacheable, and
engine-agnostic. Only Phase 3 touches PyMC. This means the compilation logic can
be tested, debugged, and fingerprinted without running inference.

#### 4.2 Phase 1: Topology analysis

Walks the graph and extracts:

- **Anchor identification**: the designated start node(s)
- **Branch groups**: sibling edges from the same source node, which must respect
  the Dirichlet simplex constraint
- **Join nodes**: convergence points (in-degree > 1) requiring moment-matched
  collapse
- **Path enumeration**: all anchor-to-target paths, with latency composition via
  FW chaining
- **Topology fingerprint**: deterministic hash for warm-start eligibility

#### 4.3 Phase 2: Evidence binding

Maps observed data to edges:

- **Observation classification**: window vs. cohort mode per data point
- **Completeness pre-computation**: for each observation, compute the shifted
  lognormal CDF scalar
- **Prior derivation**: from previous posteriors (ESS-capped moment-matching) or
  analytic estimates
- **Warm-start priors**: reuse previous posterior as informative prior, with ESS
  cap at 500 to prevent over-confidence
- **Quality gating**: minimum-n thresholds; low-signal edges marked for fallback

#### 4.4 Phase 3: Model construction

The only phase that imports PyMC. Translates bound evidence IR into a
probabilistic program:

**Probability structure:**

| Graph feature | Model primitive |
|---|---|
| Solo edge (out-degree 1 from source) | p_e ~ Beta(α_e, β_e); Y_e ~ BetaBinomial(n_e, p_e·κ_e, (1−p_e)·κ_e) |
| Branch group (out-degree > 1) | (p_e1, …, p_ek, p_drop) ~ Dirichlet(α); Y ~ DirichletMultinomial(n, κ·p) |
| Context slices | Per-slice Dirichlet with pooled concentration: δ_slice ~ N(0, τ), τ ~ HalfNormal(σ_pool) |

**Latency structure:**

| Feature | Model primitive |
|---|---|
| Edge latency | μ_e ~ N(μ_prior, σ_μ); σ_e ~ Gamma(·) |
| Path latency | Deterministic FW composition via PyTensor |
| Cohort completeness | c_path(age) = Φ_LN(age − δ_path; μ_path, σ_path) enters likelihood |

**Probability-latency coupling** (the technically hardest part): cohort
observations simultaneously constrain both probability and latency:

```
Y_cohort,d ~ BetaBinomial(
    n_d,
    p_cohort · c_path(age_d) · κ,
    (1 − p_cohort · c_path(age_d)) · κ
)
```

where p_cohort is linked to p_base via a hierarchical deviation controlled by
temporal volatility and upstream path uncertainty.

#### 4.5 Model fingerprinting and reproducibility

Two-tier deterministic hashing:

- **Topology fingerprint**: hash of TopologyAnalysis — determines warm-start
  eligibility
- **Model fingerprint**: hash of topology + evidence + settings — full cache
  identity

Same graph + same evidence → byte-for-byte identical IR. This is unusual in
probabilistic programming (most PPL workflows are not reproducible in this
sense).

#### 4.6 Inference and posterior summarisation

NUTS sampling via nutpie (or PyMC fallback). Quality gates:

- R-hat < 1.05
- ESS ≥ 400
- Convergence ≥ 90% of parameters

Results summarised as PosteriorSummary per edge (probability + latency
posteriors, HDI, provenance flags).

---

### 5. The Hierarchical Model: Partial Pooling Across Graph Structure (3–4 pages) **[A]**

#### 5.1 The four-layer hierarchy

| Layer | Scope | What it represents |
|---|---|---|
| Graph hyper | Global | Typical conversion rate and concentration across the entire graph |
| Branch family | Per branching node | Dirichlet concentration for sibling edges |
| Edge | Per edge | Edge-level probability (Beta for solo, Dirichlet component for branches) |
| Slice | Per edge × context | Context-specific deviation via logit-normal |

#### 5.2 Why partial pooling matters for conversion analytics

Low-traffic segments (e.g., "mobile + premium tier") have noisy conversion rate
estimates.

- **Full pooling** (assume all segments identical): discards real heterogeneity
- **No pooling** (estimate each independently): wild estimates for small segments
- **Partial pooling**: learns the right degree of shrinkage from the data

The τ parameter (pooling strength) is itself learned: small τ = heavy shrinkage
toward the edge mean; large τ = nearly independent slice estimates.

#### 5.3 Non-exhaustive branching and the dropout component

Real conversion funnels are non-exhaustive: not everyone who reaches node A will
proceed to any of A's children. The Dirichlet-with-dropout pattern adds a
phantom "dropout" component:

```
(p_B, p_C, p_drop) ~ Dirichlet(α_B, α_C, α_drop)
```

This enforces p_B + p_C ≤ 1 automatically via the simplex constraint — a
natural fit for conversion funnels that standard Beta models miss when edges are
modelled independently.

---

### 6. Answering the Commercial Questions (4–5 pages) **[A]**

#### 6.1 "What is surprising?" — Posterior predictive surprise

Define surprise following Baldi & Itti (2010): the KL divergence between the
prior predictive (what the model expected) and the posterior (what the data
showed). Operationally:

1. Compile the graph model with the current topology and historical evidence
2. Observe new data (fresh window or cohort)
3. Compute D_KL(p_posterior ‖ p_prior) per edge
4. Rank edges by surprise; flag those exceeding a threshold

This answers "is what happened this week concerning?" with principled
uncertainty. Unlike z-score anomaly detection (Amplitude), it accounts for the
graph structure: a drop at node B downstream of node A is only surprising if
node A's traffic was normal.

#### 6.2 "What if we changed the order?" — Interventional queries

The conversion graph is already a causal DAG (traffic flows through nodes in a
defined direction). Pearl's do-calculus is structurally applicable:

```
P(Y = y | do(X = x)) ≠ P(Y = y | X = x)
```

DagNet enables this by: (a) the graph provides the causal structure, (b) the
compiled model provides the parameterised joint distribution, (c) scenario
overlays allow the user to modify the graph (reorder nodes, add/remove edges)
and recompile to observe implied changes.

#### 6.3 "How do different paths compare?" — Path comparison with uncertainty

For two paths A → B → D and A → C → D:

- Compute reach probability for each path from the compiled posterior
- Report the full posterior distribution, not just point estimates
- Compute P(path_1 > path_2) directly from posterior samples

This goes beyond standard funnel comparison (which reports point rates) by
quantifying how confident we should be in the comparison.

#### 6.4 "How do concurrent experiments interact?" — Joint experiment modelling

Case nodes in the graph represent A/B tests. Each variant creates a sub-path. In
the compiled model:

- Variant-specific edge probabilities are modelled with their own priors
- The joint posterior captures interaction effects: changing the onboarding
  variant affects downstream purchase probability

No commercial A/B testing tool captures this. They all assume experiment
independence.

---

### 7. Related Work (3–4 pages) **[A]**

Structured comparison across seven areas:

#### 7.1 Bayesian conversion analytics

- Stucchio (2015), VWO's Beta-Binomial A/B testing
- Thompson (1933) / Chapelle & Li (2011) on Thompson Sampling
- Deng et al. (2016) on optional stopping in Bayesian testing
- *DagNet's distinction*: graph-compiled joint model vs. isolated pairwise
  comparison

#### 7.2 Conversion path modelling

- Anderl et al. (2016) Markov chain attribution — closest prior work on
  graph-based conversion modelling
- Shao & Li (2011) Shapley attribution
- Netzer et al. (2008) Hidden Markov Models for customer journeys
- *DagNet's distinction*: full Bayesian inference on the graph vs. frequentist
  credit allocation; non-linear DAG vs. first-order Markov chain

#### 7.3 Probabilistic programming & automated model building

- Stan (Carpenter et al., 2017), PyMC (Salvatier et al., 2016)
- The Automatic Statistician (Grosse et al., 2012; Duvenaud et al., 2013)
- Baudart et al. (2020) on compiling Stan to generative PPLs
- *DagNet's distinction*: domain-specific compiler (conversion graphs → Bayesian
  models) vs. general-purpose PPL requiring manual specification

#### 7.4 Causal inference on DAGs

- Pearl (2000, 2009), do-calculus
- DoWhy (Microsoft), CausalNex (QuantumBlack)
- Athey & Imbens (2017) on causal inference in economics
- *DagNet's distinction*: the operational graph IS the causal DAG — no separate
  specification or discovery step needed

#### 7.5 Anomaly detection in business metrics

- CausalImpact (Brodersen et al., 2015)
- Prophet (Taylor & Letham, 2018)
- Adams & MacKay (2007) Bayesian changepoint detection
- Baldi & Itti (2010) Bayesian surprise
- *DagNet's distinction*: graph-aware anomaly propagation vs. univariate time
  series

#### 7.6 Process mining

- Van der Aalst (2011) — discovers process graphs from event logs but does not
  compile inference models on them
- Celonis, Signavio (commercial): descriptive, not probabilistic
- *DagNet's distinction*: starts with the graph and adds inference, rather than
  discovering the graph and stopping there

#### 7.7 Bayesian networks in business

- Pearl (1988), Koller & Friedman (2009), Fenton & Neil (2012)
- Hugin, GeNIe, AgenaRisk — general-purpose BN tools
- *DagNet's distinction*: automatic compilation from a business graph with
  operational semantics vs. manual CPD specification in a general-purpose tool

---

### 8. Architecture & Implementation (4–5 pages) **[B]**

Not a systems paper, but the architectural choices are themselves part of the
contribution — they reflect a deliberate philosophy about where state, compute,
and authority should live.

#### 8.1 Architectural overview

- **Frontend**: React/TypeScript graph editor with ReactFlow, IndexedDB
  persistence, scenario overlays, ECharts analysis engine
- **Compiler**: Pure Python, three-phase IR pipeline, deterministic
  fingerprinting
- **Inference**: NUTS via nutpie/PyMC on Modal (serverless compute)
- **Data pipeline**: MSMDC query generation, query factorisation (70–85% API
  call reduction), Amplitude/Sheets/PostgreSQL adapters
- **Snapshot DB**: temporal query engine with asat() semantics for historical
  analysis and long-tail latency inference
- **Feedback loop**: posterior webhook commits results back to parameter files →
  warm-start for next run
- **Sharing**: live share links (git-backed) and static share links
  (self-contained snapshots)

#### 8.2 Data as code: git as the philosophical foundation

DagNet treats **git as the primary persistence layer** for all structured
analytical artefacts — conversion graphs, parameter files, node/event
registries, context definitions, and index files. This is a deliberate
architectural choice with deep implications:

- **Versioning is free**: every edit to a conversion graph or parameter file is
  a git commit with full diff, author, timestamp, and message. There is no
  separate "version history" feature to build — git IS the version history.
- **Collaboration is free**: branching, merging, pull requests, and code review
  apply to analytical artefacts exactly as they do to source code. A conversion
  graph can be reviewed in a PR with the same rigour as a code change.
- **Auditability is free**: `git log` and `git blame` provide a complete audit
  trail. When a parameter value changed and who changed it is always
  recoverable.
- **Rollback is free**: `git revert` on a parameter file or graph definition
  restores the previous analytical state with full provenance.
- **Temporal reasoning is native**: git's commit history, combined with the
  snapshot DB's `asat()` semantics, provides two complementary temporal
  dimensions — "what was the graph definition at time T?" (git) and "what data
  did we observe at time T?" (snapshot DB).

The only use of RDBMS is for genuinely tabular data (snapshot rows with
per-cohort-day observations) where relational queries are the natural access
pattern. Everything else — the graph, parameters, schemas, configs — lives in
git as YAML/JSON files.

This "data as code" philosophy means the conversion graph is not a dashboard
configuration stored in a vendor database — it is a **versioned, reviewable,
diffable analytical artefact** with the same lifecycle guarantees as source code.

#### 8.3 Client-centric / serverless architecture: "compute is free"

DagNet inverts the traditional web application architecture. The browser is the
primary execution environment — not a thin client rendering server responses:

**The browser as general-purpose platform:**

- **Database**: IndexedDB serves as the working-state database, holding file
  content, dirty flags, git metadata, and workspace state. This is not a cache
  layer in front of a server — it IS the source of truth for the active
  workspace.
- **State engine**: React state + Zustand stores + IndexedDB form a three-tier
  state management system entirely within the browser. The application can
  operate offline and sync when connectivity returns.
- **Rendering engine**: ReactFlow (graph canvas), ECharts (analysis charts),
  Monaco (code editing) — all rendering is client-side with no server-side
  rendering involved.
- **Automation runtime**: daily fetch automation runs in the browser via Web
  Workers and Web Locks API (cross-tab exclusion), scheduled against UK
  day-boundary timestamps.
- **Cryptographic engine**: webhook credential encryption (AES-GCM, PBKDF2) is
  performed in the browser via the Web Crypto API — secrets never transit a
  DagNet-controlled server.

**Server-side compute is purely offloaded, not architectural:**

- **Bayesian inference**: MCMC sampling is computationally intensive and runs on
  Modal (serverless, pay-per-use). The browser submits a compiled job; Modal
  executes it; results return via webhook. There is no persistent server.
- **Statistical enhancement**: time-series analytics (lag CDF fitting, cohort
  maturation) that require NumPy/SciPy run on a lightweight Python dev-server
  or can be offloaded to Modal.
- **Git operations**: GitHub API calls are made directly from the browser to
  GitHub — no proxy server.

The implication: **compute cost scales to zero when idle**. There is no server
to keep running, no database to maintain, no infrastructure to monitor. The
per-inference cost on Modal is measured in cents. This is a fundamentally
different cost structure from traditional server-driven analytics platforms,
and it is what makes a solo-developer operation economically viable.

#### 8.4 Why this architecture matters for the white paper

The architectural choices are not incidental — they are **preconditions** for the
system's existence as a solo-developer project:

- Git as persistence eliminates the need for a database team, a migration
  strategy, a backup regime, and a data modelling exercise
- Client-centric execution eliminates the need for server infrastructure,
  deployment pipelines, uptime monitoring, and scaling engineering
- Serverless compute eliminates fixed costs and makes Bayesian inference an
  operational expense proportional to usage
- The browser's built-in capabilities (IndexedDB, Web Crypto, Web Workers, Web
  Locks) replace what would otherwise be server-side services requiring
  separate development and maintenance

Each of these choices reduces the surface area that a single developer must
maintain, while preserving — or in some cases improving — the capabilities
available to the end user.

---

### 9. Evaluation & Case Studies (4–5 pages) **[A]**

#### 9.1 Synthetic benchmarks

- Graph compilation correctness: verify Dirichlet constraints hold, FW
  composition accuracy, completeness scalar accuracy vs. ground truth
- Scaling: compilation time and inference time vs. graph size (nodes, edges,
  context slices)
- Posterior recovery: simulated data from known parameters → compiled model →
  posterior covers true values

#### 9.2 Real-world conversion graph case study

(Anonymised):

- Multi-step conversion funnel with branches, case nodes, latency-tracked edges
- Demonstrate surprise detection: identify an edge whose conversion rate dropped
  below posterior predictive
- Demonstrate path comparison: quantify P(path A > path B) with full uncertainty
- Demonstrate latency forecasting: immature cohort projected correctly

#### 9.3 Comparison with baselines

| Baseline | What it lacks |
|---|---|
| Naive conversion rates (point estimates) | No uncertainty |
| Beta-Binomial per edge (independent) | No graph structure, no partial pooling |
| First-order Markov model | Graph-aware but frequentist, no uncertainty propagation |

Show that the compiled hierarchical model produces:

- Tighter credible intervals (partial pooling)
- More accurate immature-cohort forecasts (latency awareness)
- Correct surprise rankings (graph-aware anomaly propagation)

---

### 10. Discussion & Future Work (2–3 pages) **[A+B]**

#### 10.1 Limitations

- **DAG assumption**: conversion graphs must be acyclic (no re-entry loops
  modelled in the current framework)
- **FW approximation quality**: degrades for very heterogeneous path segments
- **MCMC inference cost**: large graphs with many context slices can be
  computationally expensive; variational approximations not yet implemented
- **Causal claims**: require the conversion graph to be correctly specified
  (standard causal inference caveat — the graph encodes domain knowledge)

#### 10.2 Future directions

- **Latent onset learning**: currently onset is fixed from histogram; make it a
  latent variable in the model (Phase D.O)
- **Temporal dynamics**: Dynamic Bayesian network extension for non-stationary
  conversion rates
- **Automated graph structure learning**: causal discovery from event logs to
  suggest graph edits
- **Real-time inference**: variational inference or Laplace approximation for
  interactive what-if queries
- **Multi-graph composition**: linking separate conversion graphs (e.g.,
  acquisition → activation → retention)
- **Cost-optimal path inference**: extend the model to jointly optimise
  conversion probability and cost (monetary + temporal) along paths

---

### 11. Agentic Engineering: A Case Study in AI-Augmented Solo Development (3–4 pages) **[B]**

**This section is a meta-contribution**: the system described in this paper was
built by a single developer working evenings and weekends over approximately five
months, with extensive agentic AI support. The codebase statistics are worth
stating plainly:

| Category | Files | Lines of code |
|---|---|---|
| Source code | 1,069 | 334,773 |
| Tests | 382 | 108,482 |
| Documentation | 572 | 300,449 |
| **Total** | **2,023** | **743,704** |

**Language breakdown** (source only):

| Language | Files | Lines |
|---|---|---|
| TypeScript | 590 | 168,888 |
| YAML (schemas, configs, parameter files) | 151 | 95,078 |
| Python | 139 | 34,672 |
| CSS | 64 | 15,629 |
| JavaScript | 18 | 8,101 |
| Shell (Bash/PowerShell) | 38 | 4,788 |
| Other (HTML, CSV, INI, diff) | 69 | 1,617 |

The disciplinary breadth spans:

- **Frontend engineering**: React, TypeScript, ReactFlow, ECharts, IndexedDB,
  Web Workers, Web Locks API, Service Workers
- **Backend/systems**: Python, Pydantic, FastAPI, Modal serverless, webhook
  cryptography (AES-GCM, PBKDF2)
- **Data science / statistics**: Bayesian hierarchical modelling, PyMC, NUTS
  sampling, survival analysis, moment-matching, Fenton-Wilkinson composition
- **Data engineering**: Amplitude API integration, query factorisation, snapshot
  temporal DB, daily automation pipelines
- **DevOps**: CI/CD, Playwright E2E testing, Vitest integration testing,
  cross-browser extension support
- **Domain modelling**: conversion graph schema design, query DSL design and
  parsing, MSMDC constraint generation
- **Technical writing**: 300K+ lines of documentation including architecture
  docs, user guides, API references, design specs

In previous engineering epochs, this scope would require a multi-disciplinary
team: frontend engineers, a backend/infrastructure engineer, a data scientist or
applied statistician, a data engineer, a QA engineer, and a technical writer.
The domain complexity alone — bridging web analytics, Bayesian inference,
graph theory, and survival analysis — would typically require months of
cross-team alignment before a line of code is written.

#### 11.1 What agentic collaboration changes

The key shift is not that AI "writes the code" (a reductive framing). It is that
agentic AI collapses the **context-switching cost** and **ramp-up time** across
disciplines. A solo developer with deep domain knowledge can:

- Maintain architectural coherence across 155+ service modules because the
  agent holds the full codebase context and enforces documented conventions
  (CLAUDE.md as executable specification)
- Move fluently between TypeScript frontend, Python compiler, YAML schemas,
  and Shell automation without the cognitive overhead of context-switching
  between language ecosystems
- Write integration tests that exercise real subsystem boundaries (not mocked
  shims) because the agent understands the test philosophy and enforces it
- Produce documentation at a density (300K lines) that would be impractical
  for a solo developer without AI augmentation — and keep it synchronised
  with the code as it evolves
- Iterate on statistical model design (the Bayesian compiler) while
  simultaneously evolving the frontend that visualises its outputs, because
  both sides of the stack are accessible in the same working session

#### 11.2 The CLAUDE.md pattern: convention as compilation

A distinctive feature of this development process is the use of a comprehensive
project conventions file (CLAUDE.md, ~1,200 lines) that functions as an
**executable specification** for the agentic collaborator. It encodes:

- Architectural invariants (service layer pattern, no logic in UI files)
- Testing standards (integration-default, mock discipline, assertion quality)
- Safety gates (approval discipline, discussion-mode confirmation)
- Debugging workflows (mark-based log extraction, systematic caution)

This is not documentation in the traditional sense — it is a **behavioural
contract** between the human developer and the AI agent. The agent reads and
follows it on every interaction. The effect is that a single developer can
enforce the kind of consistency and discipline that normally requires code review
by multiple team members. The conventions file is itself a living document,
refined iteratively as failure modes are discovered.

#### 11.3 Agentic graph generation: closing the loop between code and instrument

A particularly striking application of agentic engineering is the **roundtrip
generation of conversion graphs from production source code**.

The development environment places three repositories in a contiguous folder
structure:

1. **DagNet source** — the graph editor, compiler, and services
2. **Production monorepo** — the actual web application whose conversion funnels
   are being modelled
3. **Data repo** — conversion graphs, parameter files, event definitions, and
   operational playbooks

This colocation is deliberate: it allows an agentic session to traverse the
production codebase (reading route definitions, event instrumentation, A/B test
configurations, feature flags) and the DagNet schema simultaneously. Purpose-
built Claude skills and operational playbooks in the data repo define structured
workflows for:

- **Graph generation**: the agent reads production code pathways, identifies
  conversion-relevant events, traces the DAG of user states, and emits a
  conversion graph YAML that conforms to DagNet's schema
- **Graph validation**: the generated graph is checked against the actual code
  — does every node correspond to a real instrumented event? Does every edge
  represent a transition that users can actually make? Are case nodes aligned
  with active experiments in the experiment platform?
- **Testable confirmation**: the roundtrip produces artefacts that can be
  verified — event IDs resolve in Amplitude, query DSL expressions return data,
  graph topology matches the code's branching structure

This creates a **feedback loop between the BI instrument and the system it
measures**. The conversion graph is not a hand-drawn approximation of how users
flow through the product — it is a machine-verified depiction of actual code
pathways, generated by an agent that can read both the code and the graph schema.

When the production code changes (a new step is added to the funnel, an A/B test
is launched, a feature flag is toggled), the same agentic workflow can update the
conversion graph to match. The graph stays in sync with the code because the same
agent that reads the code also writes the graph.

This is a qualitatively different relationship between a BI tool and the system
it measures than the traditional one, where dashboards are manually configured
by analysts who may not have access to — or understanding of — the underlying
code.

**The reverse direction is equally important**: the loop closes in both
directions.

- **Code → Graph** (described above): agent reads production code, generates or
  updates the conversion graph to match actual application behaviour
- **Graph → Code**: a product or engineering team can edit the conversion graph
  — adding a step, reordering a flow, introducing a new experiment — and then
  commission an agent to **draft the corresponding code changes and PRs** that
  would make the real application conform to the graph. The graph becomes a
  **design surface** for the application's conversion architecture, not merely
  a measurement instrument.

This bidirectionality means the conversion graph is simultaneously:

1. A **descriptive model** of how the application currently works
2. A **prescriptive specification** of how it should work
3. A **probabilistic model** of how well it works (via the Bayesian compiler)

#### 11.3.1 Staging validation under controlled conditions

The loop is not purely theoretical. In practice, the conversion graph can be
connected to the real application in a staging environment and validated under
Monte Carlo test conditions:

- **Event flow verification**: synthetic or real traffic is driven through
  staging; the graph's event IDs are confirmed to fire in the correct order,
  with the correct properties, along the correct paths
- **Instrumentation coverage**: edges in the graph that do not receive events
  in staging are flagged — either the graph is wrong (the transition doesn't
  exist) or the instrumentation is incomplete (the event isn't firing)
- **Experiment wiring**: case nodes can be verified against the experiment
  platform — do the variant weights match? Does traffic actually split as
  configured? Do variant-specific events fire correctly?
- **Latency validation**: observed time-to-convert in staging can be compared
  against the graph's latency model parameters as a sanity check

This closes the gap between "the graph says this is what happens" and "this is
actually what happens." The graph is not a belief about the application — it is
a **testable assertion** about its behaviour.

#### 11.3.2 Impact on product and engineering teams

The practical consequence for a product/engineering team is a significant
increase in capacity to **manage complexity and move at pace**:

- **Shared language** (see Section 1.4): the conversion graph provides a single
  visual artefact that product managers, analysts, and engineers can all read
  and point at. It is more precise than a flowchart (it has real event IDs,
  real probabilities, real latency distributions) and more accessible than
  code or spreadsheets (it is visual and navigable). Discussions converge
  faster because participants are reasoning about a shared spatial structure,
  not reconstructing it from numbers — and semantic ambiguity is resolved by
  the graph's topology rather than by argument.
- **Change impact analysis**: before shipping a code change that affects a
  conversion path, the team can see — in the graph — which edges will be
  affected, what the current conversion rates and latency distributions are,
  and what the Bayesian model expects. This is not a "data request" to an
  analyst — it is immediately available in the graph.
- **Experiment design at the graph level**: rather than designing experiments
  in isolation ("let's A/B test the checkout page"), teams can design
  experiments in the context of the full conversion graph, seeing how a
  change at one node propagates through downstream edges.
- **Regression detection**: if a deployment changes conversion behaviour at
  an edge, the Bayesian surprise mechanism will flag it — and the agentic
  loop can trace the change back to a specific commit in the production
  codebase.

The conversion graph becomes **operational infrastructure** for the product
team, not a separate analytics deliverable maintained by a different group on
a different cadence.

#### 11.4 What this implies

The implication is not that teams are obsolete. Complex systems still benefit
from diverse human perspectives, and the domain knowledge that drives the system
design (conversion graph modelling, Bayesian inference for marketing analytics)
must come from the human developer. What has changed is the **minimum viable
team size** for building sophisticated, multi-disciplinary software systems. A
single developer with deep domain expertise and effective agentic collaboration
can produce working systems of a scope and quality that previously required 5–10
people and 12–18 months.

This is an order-of-magnitude shift in what is technically and practically
possible. It deserves attention not as a productivity anecdote but as evidence
of a structural change in how complex software can be built.

#### 11.5 Relevant context for this claim

- The system is not a prototype or demo — it is in daily operational use with
  real conversion data, automated daily refreshes, and live sharing
- The test suite (382 files, 108K lines) reflects production-grade quality
  expectations, not "move fast and break things"
- The Bayesian compiler pipeline has deterministic fingerprinting and
  warm-start — engineering that only matters if you expect the system to run
  repeatedly and reliably
- The documentation density (300K lines) is a deliberate investment in
  long-term maintainability, not a side-effect of AI verbosity

---

### 12. Conclusion (1 page) **[A+B]**

Restate the core contribution: a **domain-specific compiler** that bridges the
gap between business conversion graphs and Bayesian inference. The graph IS the
model. The compiler IS the innovation. The questions it enables — surprise
detection, interventional reasoning, path comparison with uncertainty, joint
experiment modelling — represent a class of analytics that no existing tool
provides.

The secondary contribution — that this system was built by a single developer
with agentic AI support in a timeframe and at a scale that would previously have
required a multi-disciplinary team — is itself evidence of a structural shift in
software engineering capability that the research community should examine.

---

## Novelty Claims

| Claim | Prior art | DagNet's advance |
|---|---|---|
| **The graph IS the model** | BN tools require manual CPD tables; PPLs require hand-written model code | Automatic compilation from an operational business graph |
| **Dynamic recompilation** | Stan/PyMC models are static once written | Graph edits → IR regeneration → model recompilation, with topology fingerprinting for warm-start |
| **Latency as first-class model component** | Survival analysis exists but is separate from funnel models | Shifted lognormal latency compiled into the graph model; probability and time-to-convert coupled in a single joint posterior |
| **FW-composed path latency** | Fenton (1960) for lognormal sums | Path-level latency via FW chaining with onset accumulation and join-node moment-matched collapse — novel application to conversion paths |
| **Surprise-first analytics** | Baldi & Itti (2010) for surprise; CausalImpact for time series | Graph-aware surprise: anomaly at node B only flagged if not explained by upstream node A |
| **Joint experiment modelling** | A/B tools test independently | Case nodes → variant-specific Dirichlet components → interaction effects captured in joint posterior |
| **Hierarchical pooling across graph contexts** | Standard in multilevel models | Applied to conversion graph slices with Dirichlet branching constraints — pooling respects the simplex |
| **Data as code (git-native persistence)** | BI tools store configs in vendor databases; git used only for application code | Conversion graphs, parameters, schemas are versioned git artefacts — diffable, reviewable, auditable with standard dev tooling |
| **Client-centric / serverless architecture** | Analytics platforms are server-driven SaaS | Browser as database + state engine + crypto runtime; server-side compute is pay-per-use offload only; zero idle cost |
| **Bidirectional agentic loop (code ↔ graph)** | BI instruments are manually configured by analysts; no link back to code | Agent generates graphs from code AND drafts code changes from graph edits; staging validation under MC test conditions confirms the graph is a testable assertion about application behaviour, not a belief |

---

## Key Citations

| # | Reference | Relevance |
|---|---|---|
| 1 | Pearl, *Probabilistic Reasoning in Intelligent Systems* (1988) | Bayesian networks on DAGs |
| 2 | Pearl, *Causality* (2000, 2nd ed. 2009) | Causal inference, do-calculus, interventional reasoning |
| 3 | Koller & Friedman, *Probabilistic Graphical Models* (2009) | Comprehensive PGM reference |
| 4 | Carpenter et al., "Stan: A Probabilistic Programming Language" (JSS, 2017) | Compiled probabilistic programming |
| 5 | Salvatier et al., "Probabilistic Programming in Python Using PyMC3" (PeerJ CS, 2016) | Programmatic model construction |
| 6 | Hoffman & Gelman, "The No-U-Turn Sampler" (JMLR, 2014) | NUTS — the inference engine that makes this practical |
| 7 | Anderl et al., "Mapping the Customer Journey" (IJRM, 2016) | Closest prior work: Markov chain conversion path modelling |
| 8 | Brodersen et al., "Inferring Causal Impact Using BSTS" (AOAS, 2015) | Bayesian time-series anomaly detection baseline |
| 9 | Baldi & Itti, "Of Bits and Wows: A Bayesian Theory of Surprise" (2010) | Theoretical grounding for "what's surprising?" |
| 10 | Gelman & Hill, *Data Analysis Using Regression and Multilevel Models* (2006) | Partial pooling rationale |
| 11 | Rossi, Allenby & McCulloch, *Bayesian Statistics and Marketing* (2005) | Hierarchical Bayes in marketing |
| 12 | Fenton, "The Sum of Log-Normal Probability Distributions..." (1960) | FW approximation for latency composition |
| 13 | Abu-Dayya & Beaulieu, "Outage Probabilities..." (1994) | FW extensions |
| 14 | Adams & MacKay, "Bayesian Online Changepoint Detection" (2007) | Online anomaly detection |
| 15 | Taylor & Letham, "Forecasting at Scale" (2018) | Prophet — time-series baseline |
| 16 | Van der Aalst, *Process Mining* (2011) | Graph discovery from event logs |
| 17 | Stucchio, "Bayesian A/B Testing at VWO" (2015) | Industry-standard Bayesian testing |
| 18 | Grosse et al., "Exploiting Compositionality..." (UAI, 2012) | Automated model construction (closest in spirit) |
| 19 | Fenton & Neil, *Risk Assessment with Bayesian Networks* (2012) | Applied BNs for business |
| 20 | Thompson, "On the Likelihood..." (Biometrika, 1933) | Thompson Sampling origin |
| 21 | Chapelle & Li, "An Empirical Evaluation of Thompson Sampling" (NeurIPS, 2011) | Modern Thompson Sampling |
| 22 | Deng et al., "Continuous Monitoring of A/B Tests..." (2016) | Optional stopping in Bayesian testing |
| 23 | Netzer et al., "A Hidden Markov Model of Customer Relationship Dynamics" (Marketing Science, 2008) | HMM for customer journeys |
| 24 | Shao & Li, "Data-Driven Multi-Touch Attribution Models" (KDD, 2011) | Shapley attribution |
| 25 | Baudart et al., "Compiling Stan to Generative Probabilistic Languages..." (2020) | PPL compilation |
| 26 | Murphy, "Dynamic Bayesian Networks" (PhD thesis, UC Berkeley, 2002) | DBNs — relevant to temporal extensions |
| 27 | Athey & Imbens, "The State of Applied Econometrics" (JEP, 2017) | Causal inference in business/economics |
| 28 | Brooks, *The Mythical Man-Month* (1975, anniversary ed. 1995) | Why adding people to a project doesn't scale linearly — baseline for the agentic engineering claim |
| 29 | Anthropic, "Claude Code: Best Practices for Agentic Coding" (2025) | The CLAUDE.md pattern and agentic collaboration methodology |
| 30 | Cognition AI / Devin, "SWE-bench" benchmarks (2024–2025) | Context for AI-assisted software engineering capabilities |
| 31 | Miller, "The Magical Number Seven, Plus or Minus Two" (Psychological Review, 1956) | Working memory limits — why humans struggle with numerical comparison |
| 32 | Kahneman, *Thinking, Fast and Slow* (2011) | Systematic biases in numerical reasoning (anchoring, base-rate neglect, framing) |
| 33 | Gigerenzer & Hoffrage, "How to Improve Bayesian Reasoning Without Instruction" (Psychological Review, 1995) | Humans reason poorly about conditional probabilities from numbers; natural frequencies and visual formats help |
| 34 | Ware, *Information Visualization: Perception for Design* (3rd ed., 2012) | Pre-attentive visual processing; why spatial representations support parallel pattern detection |
| 35 | Tufte, *The Visual Display of Quantitative Information* (2nd ed., 2001) | Foundational work on graphical data representation and its cognitive advantages |
| 36 | Larkin & Simon, "Why a Diagram is (Sometimes) Worth Ten Thousand Words" (Cognitive Science, 1987) | Formal analysis of when diagrammatic representations outperform sentential ones — directly relevant to the graph-vs-table argument |

> **Note**: All citations should be verified against actual publications before
> submission. Some venue/year details may need correction. Citations 28–30
> support the agentic engineering section; 31–36 support the cognitive case for
> visual reasoning (Section 1.3). Both areas may need updating.

---

## Audience & Venue

### If one paper (combined)

- **Audience**: Applied data scientists and engineering leaders who care about
  both the statistical method and how it was built
- **Venues**: arXiv preprint + industry white paper (broadest reach); KDD
  applied track; possibly a "systems" venue
- **Length**: ~10,000–14,000 words (30–40 pages)

### If two papers

**Paper A — The Bayesian compiler**:
- **Audience**: Applied statisticians, marketing scientists, PGM/PPL researchers
- **Venues**: Marketing Science, AISTATS, UAI, Journal of Marketing Research
- **Length**: ~6,000–8,000 words (20–25 pages)

**Paper B — The interrogable diagram / agentic engineering**:
- **Audience**: Engineering leadership, product/analytics practitioners, AI-
  augmented development community
- **Venues**: arXiv (cs.SE or cs.HC), ACM Queue, Increment, or standalone
  industry essay
- **Length**: ~4,000–6,000 words (15–20 pages)

Section 4 (The Compiler Architecture) is the longest and most technically dense —
it is where the core technical contribution lives. Section 11 (Agentic
Engineering) carries the meta-contribution and may attract as much attention as
the technical content.

---

## Gap Analysis: What Exists vs. What DagNet Does

### Existing tools and their limitations

| Tool category | Representative tools | What they do | What they cannot do |
|---|---|---|---|
| Funnel analytics | Amplitude, Mixpanel, GA4, Heap | Descriptive: step-by-step conversion rates in linear funnels | Non-linear graphs; uncertainty; causal reasoning; "what's surprising?" |
| A/B testing | VWO, Optimizely, LaunchDarkly, Kameleoon | Pairwise variant comparison (Beta-Binomial) | Joint inference across funnel stages; interaction effects between concurrent experiments |
| Attribution | ChannelAttribution (R), GA4 DDA | Credit allocation across touchpoints (Markov/Shapley) | Uncertainty quantification; interventional reasoning; non-channel graph structures |
| Anomaly detection | CausalImpact, Prophet, Anodot | Univariate time-series anomaly flagging | Graph-aware anomaly propagation; structural surprise |
| Probabilistic programming | Stan, PyMC, NumPyro, Pyro | Flexible Bayesian model specification and inference | Automatic model generation from business graphs (requires manual specification) |
| Causal inference | DoWhy, CausalNex, Tetrad | DAG-based causal analysis | Automatic DAG from business conversion graphs (requires manual specification) |
| Process mining | Celonis, Signavio | Graph discovery from event logs | Probabilistic inference on the discovered graph |
| Bayesian networks | Hugin, GeNIe, AgenaRisk | General-purpose BN inference | Domain-specific compilation from conversion graphs; operational semantics |

### What DagNet uniquely combines

1. The conversion graph already encodes the causal DAG — no separate
   specification
2. The compiler automatically translates graph topology into probabilistic
   constraints
3. Latency is a first-class model component, not a separate analysis
4. Hierarchical partial pooling respects both the graph structure (Dirichlet
   branching) and the context structure (slice pooling)
5. The snapshot DB provides temporal depth for the inference engine (asat()
   semantics)
6. The feedback loop (posterior → parameter files → warm-start) creates a
   continuously learning system

---

## Implementation Reality Check

This is not a theoretical proposal. The system described is implemented and
operational:

- **743,704 total lines** across 2,023 files
- **334,773 lines of source code** (TypeScript, Python, YAML, CSS, Shell)
- **108,482 lines of tests** across 382 test files
- **300,449 lines of documentation** across 572 markdown files
- **Three-phase compiler** with deterministic IR and fingerprinting
- **NUTS inference** via nutpie on Modal serverless compute
- **Snapshot DB** with temporal query semantics
- **155+ service modules**, 319 Vitest test files, 24 Playwright E2E specs
- **Daily automation** for data refresh, cohort tracking, and latency model
  updates
- Built by **a single developer** over ~5 months (evenings/weekends) with
  agentic AI support (see Section 11)

The white paper describes a working system, not a research prototype.

---

## Open Questions for Refinement

- [ ] How much implementation detail to include vs. keeping it conceptual?
- [ ] Should we include a formal grammar for the query DSL?
- [ ] Which case study to use (anonymised real graph vs. synthetic example)?
- [ ] How strongly to lean into the causal inference claims (do-calculus) vs.
  keeping them as "structurally available but not yet fully implemented"?
- [ ] Whether to include the cost/labour modelling as a separate contribution or
  leave for future work
- [ ] **One paper or two?** Thread A (Bayesian compiler) and Thread B (tool
  journey / agentic engineering) serve different audiences. Options:
  (a) single "systems paper" with both threads (broadest story, longest);
  (b) technical paper [A] for a stats/ML venue + companion essay [B] for a
  practitioner/SE audience; (c) single paper with [B] material in appendices.
  The current plan develops both threads so either split is possible later.
- [ ] How much detail on the agentic engineering methodology? Could be a
  standalone companion piece vs. a section within the main paper
- [ ] Whether to include CLAUDE.md excerpts as an appendix (illustrating the
  "convention as compilation" pattern)
