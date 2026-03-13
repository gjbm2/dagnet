# Reference Implementation Notes

**Source**: `ccl08/dagnet-bayesian-analysis` (GitHub, public)
**Reviewed**: 13-Mar-26
**Relevance**: Independent implementation of a DAG → Bayesian inference pipeline targeting conversion funnels. Covers our Blocks 1–4 partially. Useful as validation of our architectural choices and as concrete PyMC 5 reference for model construction.

---

## 1. Architecture alignment

The repo mirrors our compiler → IR → model-builder → runner separation almost exactly. This is encouraging independent validation that the "runtime-agnostic IR" approach (Block 0, §3) is the right abstraction boundary.

Their pipeline:

```
DAG JSON  →  compile_graph()  →  HierarchyIR  →  build_model()  →  pm.Model  →  run_inference()  →  InferenceResult
```

Maps to our blocks:

| Their layer | Our block | Notes |
|---|---|---|
| `compile_graph()` | Block 3 (graph-to-hierarchy compiler) | 6 of 8 steps implemented |
| `HierarchyIR` | Hierarchy IR output | Flat (no slice layer) |
| `build_model()` | Block 4 (model materialisation) | Clean PyMC 5 translation |
| `run_inference()` | Block 4 + Block 5 (inference + summarisation) | Combined in one function |
| `InferenceResult` | Block 6 (artefact persistence) | Plain dicts, no PyMC/ArviZ leakage |

**Key design insight they got right**: the model builder knows nothing about DAGs; the compiler knows nothing about PyMC. This boundary is exactly what our Block 3/4 split prescribes.

---

## 2. Useful implementation patterns

### 2.1 PyMC model construction (their `model_builder.py`)

The cleanest part of the repo. Three patterns worth adopting directly:

**Binary edges → Beta + Binomial**:

```python
p = pm.Beta(f"p_{edge_id}", alpha=prior_alpha, beta=prior_beta)

if evidence_exists:
    effective_n = int(n * completeness)
    effective_k = int(k * completeness)
    pm.Binomial(f"obs_{edge_id}", n=effective_n, p=p, observed=effective_k)
```

- Variable naming convention `p_{edge_id}` / `obs_{edge_id}` gives direct traceability from posterior samples back to the DAG. We should adopt this.
- Completeness weighting is applied by scaling n and k before passing to the likelihood — simple and effective for the flat (no-slice) case.

**Branch groups → Dirichlet + Multinomial**:

```python
concentration = np.ones(k) * group.concentration
weights = pm.Dirichlet(f"w_{group_id}", a=concentration, dims=coord_name)

effective_ks = (observed_ks * completeness).astype(int)
pm.Multinomial(f"obs_{group_id}", n=effective_ks.sum(), p=weights, observed=effective_ks)
```

- Uses PyMC `coords` and `dims` for labelled dimensions — this integrates cleanly with ArviZ xarray output and is the right way to handle variant labelling.
- Concentration vector is uniform (`ones * scalar`). For our slice-level extension, we'd replace this with a learned per-branch-family concentration (our Block 3, step 3).

**Latency edges → LogNormal (prior only)**:

```python
pm.LogNormal(f"lag_{edge_id}", mu=lat.mu, sigma=lat.sigma)
```

- They treat latency as a prior-only variable (no observed likelihood). This is because they skip probability–latency coupling entirely. In our design, latency parameters participate in the completeness CDF constraint and therefore *do* have an implied likelihood via the joint model (see doc 1, §4).

### 2.2 Prior overflow guard

A pragmatic numerical stability pattern:

```python
MAX_PRIOR_COUNTS = 500
if alpha + beta_param > MAX_PRIOR_COUNTS:
    prior_alpha_capped = 2.0
    prior_beta_capped = 2.0
```

At large n, Beta(k, n−k) overflows float precision. Their solution: cap the prior at a weak Beta(2, 2) and let the Binomial likelihood carry all the information. Mathematically equivalent (the posterior is dominated by the likelihood at large n), but numerically stable. We should adopt this guard.

### 2.3 Inference runner: plain-dict artefacts

Their `InferenceResult` exposes only plain Python types (floats, lists, dicts) — no PyMC trace objects, no ArviZ InferenceData. This is deliberate: the artefact layer must be serialisable to JSON/database without PyMC as a dependency.

Useful patterns from their runner:

- **HDI extraction**: `az.hdi(trace, var_names=[name], hdi_prob=0.94)` — they use 94% HDI (ArviZ default), which is fine for our purposes.
- **Win probability**: For branch groups, computed as fraction of posterior samples where variant *i* has the maximum weight. Simple, interpretable, serialisable.
- **Convergence flag**: `max(az.rhat(trace).max()) < 1.05` — single boolean, suitable for quality gates.

### 2.4 Evidence degradation ladder

Four levels, assigned by observation count thresholds:

| Level | Condition | Meaning |
|---|---|---|
| 0 | No evidence | Cold start — Beta(1,1) uniform prior |
| 1 | 0 < n < 10 | Weak — prior-dominated |
| 2 | n ≥ 10 | Mature — likelihood-dominated |
| 3 | n ≥ 10 + converged posterior | Full Bayesian |

Maps cleanly to our provenance flags (`bayesian / pooled-fallback / point-estimate / skipped`). The threshold of n=10 is arbitrary but reasonable as a "prior vs likelihood dominance" crossover for Beta-Binomial.

### 2.5 Completeness blend weight

```python
w = 1.0 - exp(-n / BLEND_K)    # BLEND_K = 50
```

Exponential saturation curve: at n=50, w≈0.63; at n=150, w≈0.95. This is a simplified proxy for our CDF-based completeness model (doc 1, §3–4). Their approach is adequate for the flat case but cannot express the edge-level latency dependence our contract requires. Still, it's a useful fallback for edges where latency parameters are unavailable.

### 2.6 Lognormal fitting from summary statistics

```python
mu = log(median)
sigma = sqrt(2 * (log(mean) - mu))
```

Derives μ and σ from median and mean without scipy. Includes a floor (`max(sigma_sq, 0.01)`) and a conservative default (σ=0.5) when data is insufficient. This is the same approach our `lagDistributionUtils.ts` uses — confirms we're on the same page.

### 2.7 t95-constrained sigma

The compiler inflates σ to ensure P(lag ≤ t95) ≥ 0.95 under the LogNormal model. This prevents "thin-tail optimism" where a fitted distribution underestimates the tail and causes premature cohort maturity declarations. We identified this same concern in doc 1, §4.2. Their implementation is a simple `max(fitted_sigma, required_sigma)` — adequate for our needs.

---

## 3. Gaps relative to our design

These are areas where the reference implementation stops short. Listed here so we don't mistake "validated by external code" for "fully solved".

### 3.1 No slice layer (critical gap)

Their hierarchy is flat: graph → edge. No contextual partial pooling (paid vs organic, mobile vs desktop, etc.). Our 4-layer hierarchy (graph hyper → branch family → edge → slice) is substantially more complex. The Dirichlet parameterisation they use would need to be extended with per-slice deviations while preserving the simplex constraint — this is the "hierarchical Dirichlet" challenge identified in doc 0, §3.3.

### 3.2 No probability–latency coupling (critical gap)

Latency edges are prior-only — no joint constraint with conversion probability via the completeness CDF. This means their model cannot distinguish "low conversion because users don't convert" from "low conversion because the cohort is immature and converters haven't been observed yet". Our contract doc (doc 1) exists precisely to solve this. Their approach is not wrong for mature cohorts but fails for the immature-cohort case that matters most in practice.

### 3.3 No exhaustive vs non-exhaustive branch classification

They assume all branch groups are exhaustive (traffic sums to 1.0). No phantom dropout component for non-exhaustive groups. Our design (doc 0, §3.2) handles this with a k+1 Dirichlet where the extra component represents dropout — this is important for real-world funnels where not all traffic from a node reaches a downstream node.

### 3.4 No model fingerprinting for warm-start

They compute a SHA256 fingerprint but don't use it for anything beyond identification. No warm-start logic (reuse previous posterior as prior when fingerprint matches). Our design requires this for incremental learning (doc 0, §7).

### 3.5 No fallback degradation strategy

If evidence is thin for one branch group, the entire model either runs or doesn't. No per-group downgrade to pooled-only or point-estimate while continuing Bayesian inference for well-evidenced groups. Our design (doc 0, §7.3) requires graceful per-group degradation.

### 3.6 Compiler steps 3–5 stubbed

The hardest compilation steps — building the probability hierarchy with pooling, encoding probability–latency coupling, and binding evidence to hierarchy leaves with censoring metadata — are marked as TODO. These correspond to the core complexity of our Block 3.

---

## 4. Decisions to carry forward

Based on reviewing this implementation, the following concrete decisions should inform our Block 3/4 implementation:

1. **Variable naming**: Adopt `p_{edge_id}`, `w_{group_id}`, `lag_{edge_id}`, `obs_{edge_id}` convention. Extend for slices: `p_{edge_id}_{slice_id}`.

2. **PyMC coords/dims**: Use `coords` dict and `dims` parameter on all Dirichlet variables. This gives us labelled xarray output from ArviZ for free.

3. **Prior overflow guard**: Cap Beta prior parameters at 500; fall back to weak prior + strong likelihood. Simple, effective, no downsides.

4. **Artefact boundary**: InferenceResult must expose only plain Python types. No PyMC or ArviZ objects cross the persistence boundary. This is non-negotiable for our snapshot DB integration.

5. **Completeness weighting**: Their `int(n * w)` approach (scale observations by completeness weight) works for the Binomial/Multinomial likelihood. For our CDF-based coupling, the completeness weight becomes a function of latency parameters rather than a static scalar — but the mechanical pattern of scaling n and k before passing to the likelihood is the same.

6. **HDI + win probability**: 94% HDI via ArviZ and sample-fraction win probabilities are the right summary statistics. Simple, interpretable, serialisable.

7. **Convergence gate**: `max(rhat) < 1.05` as a single boolean quality gate. Extend with ESS checks for production.

---

## 5. Test patterns worth noting

Their test suite (13 tests) covers:

- Evidence parsing from YAML and snapshot DB formats
- Lognormal parameter fitting edge cases (zero values, null sigma)
- Completeness weight at known n values
- Compiler output structure for linear and branching graphs
- Fingerprint determinism (same input → same hash)
- PyMC model variable existence (Beta, Dirichlet, observed variables present)

**What's missing from their tests** (and we must cover):

- No test for slice-level hierarchy construction
- No test for probability–latency coupling
- No test for non-exhaustive branches (dropout component)
- No test for warm-start from prior posterior
- No test for partial-graph fallback degradation
- No integration test that runs inference and checks posterior values against known ground truth (their tests only check model *structure*, not model *correctness*)

That last point is important: their model-builder tests verify that the right PyMC variables exist but never sample and check that posteriors recover known parameters. We should include at least one "parameter recovery" test that generates synthetic data from known parameters, runs inference, and checks that the posterior HDI contains the true values.
