# Project Bayes: High-level logical blocks

**Status**: Stub  
**Date**: 4-Mar-26  
**Purpose**: Define the high-level engineering blocks for graph-specific nightly
Bayesian fitting, with detailed reasoning on the graph-to-hierarchy compiler.

---

## Scope

- Each graph gets its own statistical model, built dynamically from its topology.
- Nightly fitting targets parameters in graphs configured for daily retrieval.
- Snapshot DB is the evidence source of truth.
- Outputs are persisted model artefacts for frontend and runner analysis.

---

## Top-level block map

1. Nightly run orchestration
2. Subject discovery and evidence assembly
3. **Graph-to-hierarchy compiler** (core complexity — see below)
4. Probabilistic model materialisation and inference
5. Posterior summarisation and quality gates
6. Artefact persistence and serving

Blocks 1, 2, 4, 5, and 6 are substantial but mostly conventional engineering.
Block 3 is where graph semantics are translated into model structure.

---

## Prior art

### Network meta-analysis (closest precedent)

**GeMTC** and **multinma** automatically build JAGS/Stan models from evidence
network graphs. The treatment comparison network defines which edges exist; the
model builder emits consistency equations, heterogeneity priors, and random
effects. multinma adds treatment-class partial pooling (exchangeable, common, or
independent) — analogous to our slice pooling.

Relevance: proves that programmatic model construction from a domain graph is
viable and has been shipped in production R packages for over a decade.

Key difference from our problem: NMA networks are flat (no topological ordering,
no branching constraints, no compositional latency). Our DAG adds structural
coupling that NMA does not face.

### PyMC-Marketing `BuildModelFromDAG`

Takes a causal DAG and creates a PyMC model where each edge `A → B` becomes a
slope prior on A's contribution to B's mean. Walks the DAG topologically, creates
priors per edge, and binds observed data per node.

Relevance: demonstrates the pattern of topological walk → per-edge latent
variables → likelihood binding, all inside PyMC.

Key difference: it emits a simple linear regression structure. No branching
constraints, no hierarchical pooling across groups, no compositional quantities.

### Briggs, Ades & Price (2003)

Established that the Dirichlet distribution is the correct prior for branching
probabilities in decision trees with multiple mutually exclusive branches. The
Dirichlet ensures probabilities sum to 1 while representing uncertainty.

Relevance: directly applicable to our sibling-edge constraint problem at
branching nodes.

### bayesvl

R package that generates Stan code from user-specified DAG structures. Closer to
a code generator than a compiler — the user defines the model shape; the tool
emits syntactically valid Stan.

Relevance: confirms the DAG-to-Stan-code generation pattern. Not structurally
sophisticated enough to be a template for our compiler.

### Summary

No existing tool compiles a domain-specific DAG with branching constraints,
compositional latency, and contextual partial pooling into a hierarchical
Bayesian model. The pieces exist separately (NMA model builders, Dirichlet
branching, DAG-to-PyMC scaffolding) but combining them for conversion graphs is
novel.

---

## The hard part: graph-to-hierarchy compiler

### Why this is the core challenge

The hierarchy is not fixed. It depends on:

- current DAG topology (which nodes, which edges, which are active)
- branching fan-out at each node (determines constraint structure)
- contextual slice layout present in snapshot evidence (determines pooling groups)
- path composition from anchor to target (determines latency coupling)
- optional conditional probability semantics (determines tied parameters)

The compiler must be a deterministic function from `(graph, evidence inventory,
policy)` to a model plan that a downstream inference engine can execute.

### Compiler inputs and outputs

**Inputs**

- Canonical graph snapshot (nodes, edges, metadata, active state)
- Evidence inventory: `(param_id, core_hash, slice_key)` → row counts and
  maturity assessment per edge
- Modelling policy: prior families, pooling policy, quality thresholds,
  exhaustiveness rules, runtime limits
- Run context: graph version, training window, feature flags

**Outputs**

- Hierarchy IR: levels, groups, parent-child links, latent variable catalogue
- Constraint map: simplex groups, positivity bounds, censoring tags, tied params
- Likelihood binding plan: which evidence rows feed which latent variables
- Compile diagnostics: unsupported features, low-signal groups, fallbacks
- Model fingerprint: deterministic hash for reproducibility and warm-start eligibility

---

## Compiler logic: step by step

### Step 1 — Canonicalise the graph

Normalise graph input into a stable internal form.

- Resolve active nodes and edges; remove inactive surfaces.
- Topologically sort nodes with deterministic tiebreaking (by stable node id).
- Assign canonical edge identities that remain stable across runs where the
  graph structure hasn't changed.

Why this matters: unstable identities break posterior tracking between nightly
runs and invalidate warm starts. The canonical form must be invariant to
serialisation order and irrelevant metadata changes.

### Step 2 — Identify branch groups (sibling sets)

For each node with out-degree > 1, the outgoing edges form a **sibling set**
whose probabilities are structurally coupled.

Example: node A has edges A→B, A→C, A→D. These three edges share a branching
constraint.

The key question per branch group is **exhaustiveness**:

- **Exhaustive** (all traffic from A goes somewhere): p(A→B) + p(A→C) + p(A→D) = 1.
  Model as a Dirichlet.
- **Non-exhaustive** (some traffic drops out): p(A→B) + p(A→C) + p(A→D) ≤ 1.
  Model as a Dirichlet with a phantom "dropout" component:
  `(p_B, p_C, p_D, p_dropout) ~ Dirichlet(α)` where `p_dropout = 1 - Σp_i`.

In conversion funnels, non-exhaustive is the norm. The Dirichlet-with-dropout
approach is preferred because:

- It naturally enforces the sum constraint without ad-hoc clipping.
- It allows information sharing between siblings (if one goes up, others adjust).
- It's conjugate to the multinomial likelihood.
- The dropout rate is itself informative (overall conversion propensity at that node).

For nodes with out-degree = 1, the single edge gets an independent Beta prior —
no sibling coupling needed.

### Step 3 — Build the probability hierarchy

This is where the levels are assembled.

**Graph hyper layer**: global parameters that anchor the priors for all branch
groups. Conceptually: "what is the typical conversion rate and concentration in
this graph?" These could be a global mean logit-rate and a global concentration
parameter for the Dirichlet.

**Branch family layer**: per-branch-group concentration parameters. For a
Dirichlet branch with k+1 components (k edges + dropout), the concentration
vector `α` is drawn from the graph-level hyperprior. This controls how peaked or
diffuse the branch split is, and allows sharing across branch groups if the
graph has multiple branching nodes.

**Edge layer**: per-edge conversion probability. For edges in a branch group,
these are the components of the Dirichlet draw. For solo edges, these are
independent Beta draws.

**Slice layer** (partial pooling within each edge): if an edge has evidence
across multiple context slices (e.g. `context(channel:paid)`,
`context(channel:organic)`), each slice gets a deviation from the edge mean:

```
logit(p_edge_slice) = logit(p_edge) + δ_slice
δ_slice ~ Normal(0, τ_slice)
```

`τ_slice` is the pooling strength — small τ means heavy pooling toward the edge
mean; large τ means slices are nearly independent.

**Critical subtlety**: if the edge is part of a Dirichlet branch group, the
slice deviations must respect the simplex constraint **per slice**. At each
branch node, for each slice independently, the sibling probabilities should sum
to ≤ 1. This means the Dirichlet applies per-slice, with the per-slice
concentration parameters pooled across slices via a shared branch-level
distribution. This is a **hierarchical Dirichlet** pattern (not the HDP — a
simpler parametric version where per-slice concentrations are drawn from a
common distribution).

### Step 4 — Build the latency hierarchy

For each edge with latency evidence:

**Edge-level latency**: `mu_edge`, `sigma_edge` for the lognormal lag
distribution, with graph-level hyperpriors on the typical latency scale.

**Slice-level latency deviations**: `mu_edge_slice = mu_edge + δ_mu`, with
partial pooling controlled by a latency-specific τ.

**Path-level composition**: this is NOT a hierarchy level — it's a deterministic
function. For a path A→X→Y, the path latency is the sum of edge latencies
A→X and X→Y.

In MCMC, this composition is natural: each posterior draw gives concrete
`(mu_i, sigma_i)` per edge. For that draw, we can compute the exact path
latency distribution (sum of lognormals — either by simulation within the
draw, or by Fenton-Wilkinson approximation at each draw). No pre-computation
or closed-form approximation is needed at compile time.

The compiler's job is to identify which paths exist and which edge sequences
compose them, so the model builder knows which deterministic path nodes to
create.

### Step 5 — Encode the probability–latency coupling

The conversion probability and latency models are coupled through
**completeness**. For each observation:

- Mature cohort (high completeness): `Y ~ Binomial(X, p)`
- Immature cohort: `Y ~ Binomial(X, p × c(age, mu_path, sigma_path))`

where `c()` is the lognormal CDF giving the fraction of eventual converters
observed by the cohort's age.

This means the likelihood for immature data jointly constrains both `p` (via
the total conversion count) and `(mu, sigma)` (via the age-dependent
completeness). The compiler must:

- Partition evidence rows into mature vs immature per edge × slice.
- For immature rows, tag which path-level latency parameters enter the
  completeness term.
- Emit censoring metadata so the model builder constructs the right likelihood.

### Step 6 — Bind evidence to hierarchy leaves

Map snapshot rows to the hierarchy's leaf-level latent variables.

- Each row is identified by `(param_id, core_hash, slice_key, anchor_day)`.
- The compiler maps `param_id` → edge, `slice_key` → slice group, using the
  signature equivalence closure.
- Mature vs immature partition is determined by cohort age relative to the
  edge's current t95 estimate (or a policy threshold).
- Recency weighting (if used) is defined at bind time as metadata, not applied
  ad hoc in model code.

Key risk: silent row leakage across groups due to signature drift or stale
equivalence mappings. The compiler should validate that every bound row maps
to exactly one edge × slice group.

### Step 7 — Validate and plan fallbacks

Before emitting the final IR:

- Check minimum signal thresholds per group (minimum Y, minimum anchor days).
- Detect degenerate groups: zero variance, zero converters, no mature rows.
- For insufficient groups, mark them for fallback:
  - **Pooled-only**: collapse slices to edge mean, skip slice layer.
  - **Point estimate**: fall back to current moment-based fitting for that edge.
  - **Skip**: exclude from model, flag for operator review.
- Never start expensive inference on an invalid model structure.

### Step 8 — Emit the hierarchy IR

The IR is a serialisable data structure consumed by the model builder. It
contains:

- **Latent variable catalogue**: every latent variable, its name, type
  (probability, latency, hyperparameter), and parent group.
- **Group structure**: branch groups, slice groups, path compositions,
  with parent-child links.
- **Constraint annotations**: simplex flags, positivity bounds, censoring tags.
- **Evidence binding table**: which rows feed which likelihood terms, with
  maturity and weighting metadata.
- **Diagnostics**: any warnings, fallback decisions, or unsupported topology
  features encountered during compilation.
- **Fingerprint**: deterministic hash of (canonical graph state + policy +
  evidence window) for reproducibility.

---

## The per-slice Dirichlet problem (worked example)

This is the hardest modelling subtlety. Consider node A with edges A→B, A→C,
and two slices: paid and organic.

**Naive approach** (wrong): fit a single Dirichlet `(p_B, p_C, p_dropout)` and
then add slice deviations in logit space. This violates the simplex constraint
per slice — the deviations could push `p_B_paid + p_C_paid > 1`.

**Correct approach**: for each slice independently, draw from a Dirichlet:

```
(p_B_paid, p_C_paid, p_dropout_paid) ~ Dirichlet(α_paid)
(p_B_organic, p_C_organic, p_dropout_organic) ~ Dirichlet(α_organic)
```

The partial pooling across slices comes from sharing the concentration
parameters:

```
α_paid ~ f(α_branch)
α_organic ~ f(α_branch)
```

where `α_branch` is the branch-level hyperprior. This way:

- Each slice respects the simplex constraint independently.
- Slices borrow strength from each other through the shared α_branch.
- The model scales naturally with the number of slices.

The compiler must recognise this pattern whenever a branch group intersects with
a slice group and emit the hierarchical Dirichlet structure rather than the
simpler "Dirichlet + logit deviations" structure.

---

## Determinism and reproducibility

- Same (graph snapshot + policy + evidence window) must produce the same IR.
- Every latent variable must have a stable deterministic id derived from
  graph-structural identifiers (not array indices or iteration order).
- Every posterior artefact must carry the model fingerprint.
- Warm-start eligibility: if the fingerprint matches the prior run (same graph
  structure + same policy, different data window), warm-start from previous
  posterior. If the fingerprint differs, start fresh.

---

## Compiler / inference separation

The compiler should be runtime-agnostic. It emits IR and binding plans; a
separate model builder consumes them and produces a PyMC (or Stan, or Pyro)
model object.

This separation enables:

- Swapping inference engines without redoing topology logic.
- Dry-run compilation (validate IR, inspect diagnostics) without sampling.
- Clear debugging: compile failure vs sampler failure are distinct.
- Testing the compiler with deterministic assertions on IR shape, independent
  of stochastic inference.

---

## Failure strategy

If compilation cannot produce a valid hierarchy for part of the graph:

- Downgrade only affected groups to fallback paths.
- Continue fit for unaffected groups.
- Emit explicit diagnostics for operator review.
- Never silently mix fallback and Bayesian outputs — every parameter carries
  a provenance flag (bayesian / pooled-fallback / point-estimate / skipped).

---

## First practical implementation slice

1. Implement compiler IR schema and the canonicaliser + structural analyser.
   Test on a real graph, assert deterministic IR output.
2. Build the joint probability + latency hierarchy from the start. The
   probability–latency coupling through completeness is the core of the model,
   not an add-on. Inferring latency distributions is half the challenge; a
   probability-only model would not exercise the hard parts.
3. Build a minimal model materialiser that takes the IR and emits a PyMC model.
4. Bind snapshot evidence and run full inference on a single real graph. Runtime
   budget is generous (hours available overnight, compute is cheap) so there is
   no need to artificially constrain chain length or model scope.
5. Persist summaries and quality flags.

This front-loads the hardest logic (graph-to-hierarchy synthesis with joint
latency) while keeping the blast radius to a single graph.

---

## Open questions

- Exhaustiveness policy: how to determine whether a branch group is exhaustive
  or has dropout? Is this a graph metadata flag, or inferred from data?
- Pooling policy: should slice pooling strength (τ) be estimated per edge, per
  branch group, or globally? More granular = more parameters = slower.
- Latency composition strategy: Fenton-Wilkinson per MCMC draw, or simulation
  within each draw? With generous runtime budget, accuracy can be preferred
  over speed.
- Conditional probability interaction: edges with existing `conditional_p`
  definitions — do these become informative priors, hard constraints, or are
  they ignored by the Bayesian model?
