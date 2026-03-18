# Project Bayes: Compiler implementation phases

**Status**: Draft
**Date**: 17-Mar-26
**Purpose**: Phased delivery plan for the compiler and worker pipeline.
This doc owns development sequencing; `6-compiler-and-worker-pipeline.md`
contains the end-state technical design.

**Related**: `6-compiler-and-worker-pipeline.md` (design spec),
`programme.md` (programme-level sequencing),
`4-async-roundtrip-infrastructure.md` (async roundtrip, webhook)

---

## Principle

The design spec (doc 6) describes the full end-state system: six data
layers, distribution family extensibility, trajectory-calibrated priors,
evidence inheritance, completeness coupling, hierarchical Dirichlet with
slice pooling. This document sequences the *implementation* of that
design into deliverable phases.

Each phase produces a working, deployable system. Later phases add
capability without breaking earlier phases. The design spec should be
read as "what the system does when complete" — this document says "in
what order we build it."

---

## Phase A: Independent edges, end-to-end pipeline

**Goal**: prove the full pipeline works end-to-end with real posteriors.
One graph fitted, posteriors committed to git, FE reads them back.

**What is built**:

- **Compiler**: `analyse_topology` and `bind_evidence` — full IR
  production, but only solo-edge and branch-group identification (no
  hierarchical parameters). Each edge gets an independent
  `Beta(alpha, beta)` prior.
- **Model materialisation**: `build_model` emits `pm.Beta` + `pm.Binomial`
  (or `pm.Multinomial` for branch groups with shared denominator). No
  Dirichlet hierarchy, no slice pooling, no latency coupling.
- **Evidence binding**: window and cohort `values[]` entries bound to
  edges with observation-type classification. Each edge gets the
  hierarchical probability structure: `p_base`, `p_window` (tight
  pooling), `p_cohort` (path-informed divergence via
  `τ_cohort = σ_temporal · path_sigma_AX`). Window completeness
  (edge-level) and cohort completeness (path-level) both wired.
  Daily arrays used for cohort. Aggregate used for window.
- **Warm-start**: simple warm-start from last posterior's `(alpha, beta)`.
  Fixed ESS cap. No trajectory calibration yet (insufficient
  `fit_history` for new edges).
- **Inference**: `pm.sample` on compute vendor. Posterior summarisation
  (mean, stdev, HDI, r-hat, ESS). Quality gates.
- **Webhook**: posterior payload committed to parameter files + `_bayes`
  metadata to graph. `fit_history` appended.
- **FE integration**: submission route, job tracking, pull-and-read.

**What is NOT built**:

- Dirichlet branch-group coupling (edges in a branch group are fitted
  independently, each as Beta + Binomial/Multinomial)
- Slice pooling (context slices are separate independent fits, no
  hierarchical shrinkage)
- Latency coupling in the likelihood (completeness is computed and wired,
  but latency variables are not latent — priors are point estimates from
  observed lag summaries, not sampled)
- Trajectory-calibrated priors (no fit_history depth yet)
- Evidence inheritance annotations
- Distribution family dispatch (shifted lognormal hardcoded)
- `conditional_p` support

**Simplifications that Phase A accepts**:

- Latency priors are fixed (not latent). Completeness uses point-estimate
  `(mu, sigma)` from observed lag summaries, not posterior samples. This
  means completeness does not co-vary with latency uncertainty — it's a
  deterministic function per daily observation, not a joint inference
  target. Acceptable because the primary goal is to prove the pipeline,
  not to fully couple the model.
- Branch groups use Multinomial with shared denominator but no simplex
  constraint across siblings (each sibling has an independent Beta, not
  a joint Dirichlet). If `k_B + k_C > n_A`, the independent Betas can
  produce `p_B + p_C > 1`, which is inconsistent. Phase B fixes this
  with the Dirichlet.
- No warm-start for anything except solo-edge Beta posteriors. Branch
  group posteriors are not warm-started (the independent-Beta posterior
  shape doesn't map cleanly to a Dirichlet component in Phase B).

**Entry criteria**: async infrastructure Steps 1–3 done (webhook +
atomic commit). Compute vendor operational.

**Exit criteria**:
- At least one real graph fitted end-to-end
- Independent Beta posteriors committed to git via webhook
- Quality metrics (r-hat < 1.05, ESS > 400) within acceptable bounds
- FE reads real posterior values after pull
- Existing graphs without posteriors continue to load
- Idempotency holds (duplicate webhook = no duplicate commit)

---

## Phase B: Dirichlet branch groups

**Goal**: sibling edges at branching nodes share a Dirichlet prior,
enforcing the simplex constraint (`Σ p_i ≤ 1`).

**What changes from Phase A**:

- **Compiler**: branch groups emit `pm.Dirichlet` with base simplex and
  concentration parameter `κ`, instead of independent `pm.Beta` per
  sibling.
- **Dropout component**: non-exhaustive branch groups (the common case)
  get a phantom dropout component. Exhaustive groups (per-node metadata
  flag) have `Σ p_i = 1`.
- **Multinomial likelihood**: the Multinomial now uses the Dirichlet
  components directly, enforcing mass conservation in the likelihood.

**What is NOT changed**:
- Latency coupling remains point-estimate (not latent)
- Slice pooling not yet active
- Warm-start: Beta posteriors from Phase A are NOT used to seed the
  Dirichlet (shape mismatch). Branch groups start fresh. Solo edges
  continue warm-starting as before.

**Exit criteria**:
- Branch groups fitted with Dirichlet, simplex constraint enforced
- Dropout component absorbs residual correctly
- Solo edges unaffected (same results as Phase A)
- `Σ p_i ≤ 1` holds for all branch groups in posterior

---

## Phase C: Slice pooling and hierarchical Dirichlet

**Goal**: context slices (e.g. `context(device:mobile)`,
`context(channel:organic)`) are partially pooled toward the edge-level
base rate via hierarchical shrinkage.

**What changes from Phase B**:

- **Slice deviations**: per-slice offsets from the base probability,
  with a per-edge shrinkage parameter `τ_slice` that the model learns.
  High-data slices deviate freely; low-data slices shrink toward the
  base rate.
- **MECE classification**: MECE dimensions get partition-based
  double-counting prevention (exclude aggregate when slices are
  exhaustive). Non-MECE dimensions get independent per-slice
  likelihoods.
- **Hierarchical Dirichlet**: for branch groups with slices, the
  Dirichlet base simplex is itself informed by slice-level data.
- **`conditional_p` support**: treated as named slices with partial
  pooling (structurally identical to `context()` slicing).

**What is NOT changed**:
- Latency coupling remains point-estimate
- Warm-start: no warm-start for Dirichlet base simplex, κ, or slice
  deviations (hierarchical structure may change between runs). Solo-edge
  Beta warm-start continues.

**Exit criteria**:
- Slice pooling produces tighter posteriors for low-data slices
  (measurable shrinkage toward base rate)
- MECE partitioning prevents double-counting
- `conditional_p` entries compile and produce per-condition posteriors
- High-data slices are not over-shrunk (slice posterior reflects data,
  not just the base rate)

---

## Phase D: Probability–latency coupling

**Goal**: latency variables become fully latent. The model jointly infers
conversion probability and latency, using the completeness CDF as the
coupling mechanism.

**What changes from Phase C**:

- **Latent latency variables**: `mu_edge` and `sigma_edge` are
  `pm.Normal` and `pm.Gamma` respectively, not fixed point estimates.
  NUTS explores the joint (p, mu, sigma) space.
- **Path composition becomes differentiable**: FW composition of
  edge-level latents into path-level `(path_mu, path_sigma)` via
  PyTensor deterministic nodes. Gradients flow through the composition.
- **Join-node collapse becomes differentiable**: moment-matching at joins
  uses latent traffic weights `w_i = p_path_i / Σ p_path_i`, computed
  as PyTensor expressions.
- **Completeness coupling is fully joint**: the CDF in each cohort
  likelihood term is a function of latent `(path_mu, path_sigma)`,
  which are themselves functions of upstream latent variables. The
  sampler resolves "low p vs slow latency" jointly.
- **Window completeness couples to latent edge latency**: window terms
  use `CDF(obs_time - onset, mu_XY, sigma_XY)` where `mu_XY`,
  `sigma_XY` are latent, not fixed.

**What is NOT changed**:
- Warm-start: no warm-start for latency posteriors (latency interacts
  with completeness coupling; warm-starting while changing the evidence
  window could bias the coupled model). Revisit after Phase D is stable.

**Exit criteria**:
- Joint model can distinguish low-p from slow-latency given a mix of
  mature and immature daily observations (parameter recovery test)
- Path composition via FW is differentiable and gradients are correct
  (numerical gradient check)
- Completeness-adjusted Multinomial produces correct effective
  probabilities with per-sibling completeness factors
- `p_effective_dropout` converges to `1 - Σ p_i` as age → ∞
- r-hat and ESS acceptable for the joint model (may need longer chains
  than Phase A–C)

---

## Phase E (optional): Parallel chain fan-out

**Goal**: compile once, dispatch N workers (one per MCMC chain), merge
traces.

**What changes from Phase D**:

- The serialisable IR boundary enables a compile-once, sample-many
  pattern. Dispatch N workers via Modal `.spawn()`, each running
  `build_model` → `pm.sample(chains=1)` independently. Merge traces
  via `az.concat`.
- Wall-clock time for sampling scales as `1/N` (minus dispatch overhead).

**Not required for initial delivery**: PyMC parallelises chains across
cores on a single machine, and wall-clock time is not a binding
constraint for the current use case.

**Exit criteria**:
- Multi-worker fan-out produces identical posteriors (within MCMC noise)
  to single-worker multi-chain
- `az.concat` merge preserves r-hat and ESS diagnostics

---

## Cross-phase features

Some capabilities in doc 6 are not tied to a single phase but activate
when sufficient infrastructure exists:

### Trajectory-calibrated priors

**Activates**: after 3+ `fit_history` entries exist for an edge (any
phase). The DerSimonian-Laird machinery estimates between-run
heterogeneity and calibrates prior width automatically.

**Phase A**: most edges will not have enough history initially. Simple
warm-start (last posterior, fixed ESS cap) is the fallback.

**Phase B+**: as `fit_history` accumulates, trajectory calibration
activates per-edge. No code change needed — the evidence binder checks
`K ≥ 3` and switches automatically.

### Evidence inheritance

**Activates**: post-Phase-A (once the basic pipeline is proven and
`fit_history` is being written). Requires the `evidence_inherit`
annotation object on edges.

**Why not Phase A**: the annotation mechanism adds complexity to the
evidence binder. Phase A should prove the pipeline without it.
Uninformative priors are acceptable for the first few runs.

### Distribution family dispatch

**Activates**: post-Phase-D (once the full coupled model is stable).
The family tag exists in the IR from Phase A (as a default-valued
field), but only `shifted_lognormal` and `Beta`/`Dirichlet` are
implemented. Adding a new family means implementing the four extension
points (variable creation, chain composition, join collapse,
completeness CDF) for that family.

### Backtesting and model validation

**Activates**: post-Phase-A (posteriors in YAML files) + sufficient
`fit_history` depth + snapshot DB with historical evidence. See
`programme.md` Posterior consumption section.

---

## Warm-start rules by phase

Warm-starting is progressively enabled as the model stabilises:

| Parameter type | Phase A | Phase B | Phase C | Phase D |
|---|---|---|---|---|
| Solo-edge Beta | Yes (simple) | Yes (trajectory when K ≥ 3) | Yes | Yes |
| Branch-group Beta → Dirichlet | No (shape mismatch) | Fresh start | Fresh start | Fresh start |
| Dirichlet base simplex, κ | N/A | No | No (structure may change) | No |
| Slice deviations | N/A | N/A | No (slices may change) | No |
| Latency (mu, sigma) | N/A (not latent) | N/A (not latent) | N/A (not latent) | No (coupling risk) |
| Evidence inheritance | No | Available | Available | Available |

Once the full model is stable and the parameter-file schema carries
sufficient metadata (component counts, slice identities, training windows
per posterior), warm-starting hierarchical parameters becomes feasible.
The cost of getting it wrong (silent double-counting or shape mismatch)
is higher than the cost of a cold start, so this is deferred until the
model's behaviour is well understood through backtesting.

---

## Dependency graph

```
Phase A ──→ Phase B ──→ Phase S ──→ Phase C ──→ Phase D ──→ Phase E (optional)
  │                       │                        │
  │                       │                        ├──→ Distribution family dispatch
  ├──→ Trajectory cal.    │                        │
  ├──→ Evidence inherit.  │                        │
  └──→ Backtesting        └──→ Backtesting         └──→ Backtesting (structural)
                               (snapshot-enriched)
```

Phase A is the critical path. Phase S (snapshot evidence assembly,
doc 11) is positioned between B and C because slice pooling (Phase C)
needs rich per-slice evidence from the snapshot DB to make meaningful
shrinkage decisions. Phase S also immediately improves Phase A/B
posteriors by providing maturation trajectories for completeness
coupling. Phases B–D are sequential (each adds model complexity that
builds on the previous). Phase E and the cross-phase features are
independent of each other.

---

## Test data strategy

Each phase must be validated against synthetic data with known ground
truth before running on production data. This is **parameter recovery
testing** — the gold standard for Bayesian model validation. The process:

1. Choose ground-truth parameter values
2. Generate synthetic evidence (observations) from those parameters
3. Run the full pipeline (compiler → sampler) on the synthetic evidence
4. Check that the posteriors recover the true values

If the model cannot recover known parameters from clean synthetic data,
it cannot be trusted on noisy real data. Parameter recovery testing is
a prerequisite for each phase's exit criteria — the phase-specific exit
tests listed above assume this infrastructure exists.

### Synthetic graph library

A small set of synthetic graphs that exercise progressively more complex
structures. These are reused across phases (each phase adds model
complexity to the same graph structures):

- **Linear chain** (A → B → C → D): 3 edges in series, no branching,
  no joins. Tests basic edge fitting, path composition, and cohort
  completeness along a chain.
- **Single branch** (A → {B, C, D}): one branching node with 3 siblings.
  Tests branch group identification, Multinomial/Dirichlet fitting,
  dropout component.
- **Diamond** (A → {B, C} → D): branch then join. Tests branch groups,
  join-node collapse, path composition through the join, and the
  interaction between branching probabilities and join-level derived
  quantities.
- **Asymmetric funnel**: realistic shape — an anchor node, a branch
  group, one dominant path and one minor path, a join, then a
  post-join edge. Tests the full feature set including asymmetric
  traffic weights at the join.
- **Multi-branch with shared nodes**: two branch groups at different
  levels, a join between them. Tests multiple simultaneous branch
  groups and complex path enumeration.

Each synthetic graph has a corresponding set of ground-truth parameters
(probability, latency mu, latency sigma, onset per edge) stored
alongside it. These are the "answer key" for parameter recovery.

### Synthetic evidence generation

Given a synthetic graph and ground-truth parameters, generate realistic
evidence that mimics what the snapshot DB and parameter files would
contain. The generation process must be faithful to how real data
arrives — otherwise the test validates the wrong thing.

**Window evidence generation**:
- For each edge with ground-truth `(p_true, mu_true, sigma_true,
  onset_true)`:
  - Draw `n_window` users entering the source node
  - For each user, draw `converted ~ Bernoulli(p_true)`
  - For converted users, draw `lag ~ onset + Lognormal(mu_true, sigma_true)`
  - Apply the observation window cutoff: users whose lag exceeds the
    window are censored (observed as non-converted). This naturally
    produces window-level completeness effects
  - Aggregate to `(n, k)` and lag histogram
- The observation window length is a test parameter: short windows
  produce incomplete data (testing completeness coupling), long windows
  produce near-complete data (testing the simple case)

**Cohort evidence generation**:
- For each path from anchor to edge, with ground-truth path latency
  (composed from edge latencies via the true convolution):
  - For each synthetic cohort date, draw `n_daily` users anchored that day
  - For each user, draw conversion and lag through each edge on the path
    (sequential: A→B lag, then B→C lag, etc.)
  - At each snapshot date, observe which users have completed each edge
    — this produces the `(n_daily, k_daily)` arrays at each snapshot age
  - Varying snapshot ages produce the maturation curve that the
    completeness model must fit
- Cohort ages should span immature (age < path onset + 2σ) to mature
  (age >> path onset + 3σ), so the model has both informative and
  near-saturated observations

**Branch group evidence generation**:
- At a branching node with ground-truth `Dirichlet(α_1, ..., α_K)` or
  equivalently `(p_1, ..., p_K)` with `Σ p_i ≤ 1`:
  - Draw `n_A` users entering the source node
  - Draw their branch assignment from `Multinomial(n_A, [p_1, ..., p_K, p_dropout])`
  - This produces `(k_1, ..., k_K)` with the mass conservation property
    built in
- For the "missing denominator" test variant: omit `n_A` from the
  evidence and verify the compiler estimates it correctly

**Slice evidence generation**:
- For each context dimension with known per-slice true parameters:
  - Assign each synthetic user to a slice (MECE: partition assignment;
    non-MECE: independent membership)
  - Generate per-slice `(n, k)` from the slice-specific `p_true`
  - Generate aggregate `(n, k)` from the marginal (for testing
    double-counting prevention)

**Latency evidence generation** (for priors):
- The lag histogram in the parameter file is the compiler's source for
  latency priors. Generate it from the ground-truth `(onset, mu, sigma)`:
  - Sample N lags from `onset + Lognormal(mu, sigma)`
  - Bin into day-width bins
  - Compute median and mean lag summaries
- This tests that the compiler's prior derivation (onset subtraction,
  moment fitting) recovers the true model-space parameters

### Recovery criteria

"Recovery" means the posterior is consistent with the ground truth.
Specific criteria:

- **HDI coverage**: the 90% HDI must contain the true value. For a
  well-calibrated model, this should hold ~90% of the time across
  repeated synthetic datasets (simulation-based calibration).
- **Posterior mean bias**: the posterior mean should be within 1 posterior
  standard deviation of the true value. Systematic bias (mean
  consistently above or below truth) indicates a model specification
  error.
- **Concentration**: the posterior should be appropriately tight given the
  data volume. More data → tighter posterior. If the posterior is
  unexpectedly wide, the model is losing information. If unexpectedly
  tight, it's overconfident (double-counting or incorrect likelihood).
- **Convergence**: r-hat < 1.05, ESS > 400, zero divergences on clean
  synthetic data. Divergences on synthetic data indicate a model
  specification bug, not a data quality issue.

### Phase-specific test scenarios

**Phase A — independent edges**:

- **Solo edge, abundant window data**: single edge, large n, long
  observation window. Basic sanity check — the simplest possible case.
  Recovery should be easy. If this fails, nothing else will work.
- **Solo edge, sparse data**: small n (e.g. 50 trials). Posterior should
  be wide but centred on truth. Tests that the model doesn't
  overfit sparse data.
- **Solo edge, window + cohort jointly**: same edge observed by both
  window and cohort data. `p_base` posterior should be tighter than
  either observation type alone. `p_window` and `p_cohort` should
  diverge by an amount consistent with the path's `τ_cohort`. Tests
  the hierarchical registration machinery.
- **Solo edge, immature cohort only**: cohort with short observation
  window (age ≈ onset + 1σ). Tests completeness coupling — the model
  must correctly attribute low observed k to immaturity rather than
  low p.
- **Branch group, independent Betas**: branch group fitted as independent
  Betas (Phase A simplification). Check that individual edge posteriors
  are reasonable even without the simplex constraint. Note that
  `p_B + p_C` may exceed 1 — this is expected and Phase B fixes it.
- **Linear chain, path completeness**: 3-edge chain with cohort data.
  Tests FW path composition and path-level completeness. The
  completeness correction on immature days should allow the model to
  recover the true p despite censoring.
- **Missing denominator**: branch group where `n_A` is omitted from the
  evidence. Tests the estimation fallback and diagnostic.

**Phase B — Dirichlet branch groups**:

- **Symmetric branch group**: 3 siblings with equal true probabilities.
  The Dirichlet should recover a symmetric simplex. Tests basic
  Dirichlet fitting.
- **Asymmetric branch group**: one dominant sibling (p = 0.6) and two
  minor siblings (p = 0.1 each). Tests that the Dirichlet correctly
  concentrates mass.
- **Near-exhaustive branch group**: siblings that nearly sum to 1
  (p_dropout ≈ 0.05). Tests the dropout component with small residual.
- **Non-exhaustive branch group**: siblings that sum to 0.5 (large
  dropout). Tests that the dropout component absorbs the residual
  correctly.
- **Simplex constraint enforcement**: verify that all posterior samples
  satisfy `Σ p_i ≤ 1`. This is structurally guaranteed by the Dirichlet
  but should be verified empirically from the trace.

**Phase C — slice pooling**:

- **High-data slice**: slice with n = 10,000. The slice posterior should
  be close to the data-only estimate (minimal shrinkage toward base
  rate). Tests that the hierarchy doesn't over-pool.
- **Low-data slice**: slice with n = 20. The slice posterior should be
  pulled toward the base rate (visible shrinkage). Tests that the
  hierarchy provides useful regularisation.
- **Slice with different true p**: one slice has p = 0.3, another has
  p = 0.5, both with moderate data. Tests that the model can represent
  genuine between-slice differences without collapsing them.
- **MECE partition with aggregate**: exhaustive slices plus aggregate
  observation. Assert the aggregate is excluded from the likelihood
  (no double-counting). Compare posteriors with and without the
  aggregate — they should be identical.
- **Non-MECE dimension**: overlapping slices (e.g. `visited()` filters).
  Assert independent per-slice likelihoods without partition constraint.

**Phase D — probability–latency coupling**:

- **Low-p vs slow-latency**: two synthetic datasets that produce
  identical immature-day `(n, k)` observations but for different
  reasons — one has low p with fast latency, the other has high p with
  slow latency. With immature data only, the model should show wide
  posteriors reflecting the ambiguity. With a mix of mature and immature
  data, the model should correctly disentangle them. This is the key
  identifiability test.
- **FW composition accuracy**: known edge latencies along a 3-edge chain.
  Generate path-level observations from the true convolution (not from
  the FW approximation). Check that the FW-based model still recovers
  the true edge parameters. The FW approximation error should not cause
  systematic bias in the posteriors. If it does, this is the signal that
  FW is inadequate for this path shape.
- **Joint window + cohort with latent latency**: window data constrains
  edge-level latency via `p_window`; cohort data constrains path-level
  latency via `p_cohort`. With both present, shared latency posteriors
  (`mu_XY`, `sigma_XY`) should be tighter than with cohort alone (the
  window anchors the edge contribution). `p_window` and `p_cohort`
  should diverge proportionally to `σ_temporal · path_sigma_AX`. Tests
  the full hierarchical machinery including the path-informed
  divergence allowance.
- **Non-latency edge in a chain**: one edge in a 3-edge chain has no
  latency parameter (completeness = 1.0). Path composition should
  treat that edge as zero-latency. Recovery of the other edges'
  latency should be unaffected.
- **High-variance path (FW stress test)**: edge latencies with large
  sigma (> 1.0 in log-space). FW approximation degrades for
  high-variance lognormals. Check whether the posterior shows bias or
  poor convergence. If so, this identifies the threshold where FW
  becomes unreliable — useful data for deciding when to switch
  distribution family.

### Cross-phase test scenarios

These test the cross-phase features that activate independently of
the A–D sequence:

- **Trajectory calibration convergence**: run the same synthetic graph
  5+ times with slightly different synthetic data each time (simulating
  weekly runs with new cohort data). Verify that `fit_history`
  accumulates, trajectory calibration activates at K = 3, and the
  prior width adapts to the observed between-run variance. A stable
  synthetic parameter should produce tighter priors over time; a
  parameter that varies between runs should produce wider priors.
- **Evidence inheritance**: change the synthetic graph structure (add a
  node, splitting one edge into two). Add an `evidence_inherit`
  annotation on the new edge pointing at the old one. Verify the new
  edge's prior reflects the old edge's posterior, decayed by the
  annotation's age and strength. Run the model and verify the new
  edge converges faster than an uninherited cold-start edge with the
  same data.
- **Topology change resilience**: after a topology change that
  invalidates cohort data but preserves window data, verify that:
  (a) window evidence continues to constrain edge parameters,
  (b) inherited evidence provides a reasonable starting point for
  path-level parameters, and (c) new cohort data progressively
  improves the posterior as it matures.
- **Surprise detection**: run 5+ times with stable synthetic data to
  establish a trajectory, then introduce a regime change (shift the
  true p by 3σ). Verify the z-score diagnostic fires. Then introduce
  a shift within the historical range — verify no false alarm.

### Test data management

Synthetic graphs and ground-truth parameters should be version-
controlled alongside the compiler code (not generated on-the-fly, to
ensure reproducibility). The synthetic evidence can be regenerated from
the ground truth + a fixed random seed.

Structure:
- `tests/synthetic/graphs/` — synthetic graph YAML files
- `tests/synthetic/params/` — ground-truth parameter files with known
  values embedded as comments or a separate `_truth.yaml` sidecar
- `tests/synthetic/generate.py` — deterministic evidence generator
  (takes graph + truth + seed → parameter files with synthetic
  `values[]` entries)
- `tests/synthetic/recover.py` — runs the compiler + sampler on
  synthetic evidence and checks recovery criteria

The generator must produce evidence in exactly the same format as real
parameter files and snapshot data, so the compiler processes it through
the same codepath as production data. No special "test mode" in the
compiler.
