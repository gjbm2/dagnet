# Doc 22: Sampling Performance — Investigation and Optimisation Paths

**Status**: Research complete, no experiments run yet
**Date**: 25-Mar-26
**Purpose**: Document the performance bottleneck in MCMC sampling, what has
been tried, what was researched, and the concrete optimisation paths available.
All future experiments should be journalled in doc 18 (compiler journal) under
a `### Performance experiment:` heading.

**Related**: `3-compute-and-deployment-architecture.md` (compute vendor),
`18-compiler-journal.md` (compilation time concern, §21-Mar-26),
`6-compiler-and-worker-pipeline.md` (engine-independent IR)

---

## 1. Current state

### Hardware available (local dev, 25-Mar-26)

| Resource | Spec | Currently used by MCMC |
|---|---|---|
| CPU cores | 20 | 4 (one per chain) |
| GPU 0 | NVIDIA RTX 4060 (8 GB, CUDA 12.7) | Not used |
| GPU 1 | NVIDIA Quadro P4000 (8 GB) | Not used |

### Sampler stack

- **nutpie 0.16.8** (Rust NUTS sampler) via `nutpie.compile_pymc_model()`
- **PyTensor numba backend** (default) — compiles logp+gradient to numba/LLVM
- **PyMC 5.28+** model definition
- **4 chains, 2000 draws, 1000 tune** (default `SamplingConfig`)
- BLAS threads pinned to 1 in `param_recovery.py` (prevents oversubscription)
- No JAX, NumPyro, or BlackJAX installed

### Typical timings

| Graph | Variables | Potentials | Compile (PyTensor→numba) | Sampling (4 chains) | Total |
|---|---|---|---|---|---|
| Simple (4-edge) | ~24 | few | ~3s | ~50-90s | ~1-2 min |
| Branch (10-edge) | ~49 | 18-20 | ~155s | ~90-240s | ~4-7 min |

The branch graph spends **roughly half its time compiling** before sampling
even starts.

### Compute utilisation

With 4 chains on 4 cores, the system uses ~20% of available CPU and 0% of
available GPU. This is the core problem.

---

## 2. Prior JAX experiment (undocumented — pre-25-Mar-26)

JAX was tried at some point before this investigation. **Result: performance
got worse, not better.** The experiment was not journalled, so the exact
configuration is unknown. Based on research, the most likely explanation:

### Why JAX was probably slower

Three factors compound for this model's profile (small variable count, large
data tensors in Potentials):

1. **GPU dispatch overhead dominates small models.** With ~49 variables, the
   gradient vector is tiny. GPU kernel launch + PCIe transfer latency
   (~10-100μs) exceeds the actual compute time per gradient evaluation. The
   GPU never gets enough work to amortise its fixed overhead.

2. **nutpie + JAX backend = per-step dispatch overhead.** With
   `nutpie.compile_pymc_model(model, backend="jax")`, the Rust sampler still
   manages chains on CPU threads. Each gradient evaluation dispatches from
   Rust → Python → JAX (→ GPU if CUDA, else CPU XLA). Over ~96,000 gradient
   evaluations (4 chains × 3000 steps × ~8 leapfrog steps), this overhead
   accumulates to seconds or minutes of pure dispatch latency.

3. **XLA compilation is slower than numba for Potential-heavy models.** The
   model's DM logp Potentials contain thousands of gammaln/erfc nodes (one
   per age point — up to 12,000 per edge). XLA traces and optimises the
   entire graph, which takes longer than numba's approach. The already-slow
   155s numba compile would likely be **worse** with JAX.

### What the research says about GPU crossover

| Source | Finding |
|---|---|
| [Martin Ingram benchmark](https://martiningram.github.io/mcmc-comparison/) | GPU wins past ~50,000 observations with a model that has *thousands* of variables (Bradley-Terry player skills). 4-11× speedup at 160K matches. |
| [PyMC discourse: GPU vs CPU](https://discourse.pymc.io/t/sampling-time-gpu-vs-cpu/11297) | GPU **slower** than CPU (19 min vs 14 min) for a complex model. Response: "not at all unusual" — GPUs help for "large dense linear algebra" (e.g. GPs), not arbitrary element-wise ops. |
| [PyMC discourse: NumPyro slow](https://discourse.pymc.io/t/numpyro-jax-sampling-very-slow/12469) | 1-3 it/s with NumPyro JAX on 600K rows. Advice: "nutpie should be faster than JAX on CPU." |
| [nutpie docs](https://pymc-devs.github.io/nutpie/pymc-usage.html) | "numba tends to have relatively long compilation times, but samples small models very efficiently. For larger models the JAX backend sometimes outperforms numba." |

**Conclusion**: this model's profile (few variables, heavy element-wise
Potentials) is in the regime where CPU numba is expected to win. GPU
acceleration targets a different workload shape.

---

## 3. Optimisation paths — ranked by expected impact

### Path 1: Fix compilation time (highest priority for dev iteration)

**Problem**: The branch graph takes 155s to compile vs 3s for the simple
graph. The journal (21-Mar-26) identifies the cause: "each age point →
symbolic gammaln/erfc node in the gradient graph." With 10,000-12,000 age
points per edge, the PyTensor symbolic graph becomes enormous.

**Hypothesis**: Data arrays are being embedded into the symbolic expression
tree rather than passed as shared/constant variables. PyTensor then
differentiates through every element, creating a gradient graph proportional
to data size.

**Approaches to investigate**:

1. **`freeze_model=True`** in `nutpie.compile_pymc_model()` — treats shared
   variables as compile-time constants, potentially simplifying the gradient
   graph significantly. Zero code change in model.py.

2. **Audit data representation in Potentials** — verify that observation
   arrays (counts, weights, ages) are passed via `pt.as_tensor_variable()`
   from numpy arrays (constant data, not differentiated) rather than built
   up symbolically. If the logp expression constructs data element-by-element
   in the symbolic graph, the gradient graph explodes.

3. **PyTensor graph inspection** — use `pytensor.dprint()` on the compiled
   model's logp function to count nodes. Compare simple vs branch graph.
   If the node count scales with data volume (not model variables), the
   representation issue is confirmed.

**Expected impact**: If compilation drops from 155s to ~10s, the branch graph
total time drops from ~7 min to ~4 min. For dev iteration this is huge —
compile-edit-rerun cycles become bearable.

### Path 2: Reduce draws for development work

**Current defaults**: 2000 draws, 1000 tune, 4 chains = 12,000 total steps.

**Dev-mode settings**: 500 draws, 300 tune, 2 chains = 1,600 total steps.
This is a ~7.5× reduction in sampling work. Convergence diagnostics will be
noisier but sufficient for checking that the model runs, doesn't diverge
catastrophically, and produces reasonable posterior shapes.

**Expected impact**: Sampling time drops from ~90s to ~12s (simple) or
~240s to ~32s (branch). Combined with Path 1, branch graph total: ~42s.

**Implementation**: Already supported via CLI flags (`--draws`, `--tune`,
`--chains`). Could add a `--dev` flag that sets all three.

### Path 3: More chains across more cores

**Current**: 4 chains on 4 cores. **Available**: 20 cores.

Running `--chains 8 --cores 8` doubles the effective samples in roughly the
same wall time (nutpie runs chains in parallel). This doesn't make any single
chain faster, but:

- Better convergence diagnostics (r-hat is more reliable with more chains)
- Higher ESS per wall-clock second
- Better utilisation of available CPU

**Caveat**: Each chain's gradient function uses ~1 core. With numba's BLAS
threads pinned to 1, there's no inter-chain contention. 8 chains on 8 cores
should scale linearly.

**Expected impact**: 2× ESS/wall-clock. Useful for production (Modal with
many cores), less useful for dev iteration where speed per run matters more.

### Path 4: NumPyro vectorised chains on GPU (worth trying, uncertain payoff)

**NOT the same as what was tried before.** The prior experiment likely used
`nutpie.compile_pymc_model(model, backend="jax")` — which keeps the Rust
sampler and adds JAX dispatch overhead per step.

NumPyro is fundamentally different:

```python
pm.sample(nuts_sampler="numpyro", chains=8, cores=1)
```

This compiles the **entire NUTS algorithm** (including all chains) as a
single JAX program and runs it on GPU via `jax.vmap`. No per-step Python
dispatch, no Rust↔Python↔JAX round trips. All chains share GPU memory
bandwidth.

**Why it might help**: eliminates the per-step dispatch overhead that killed
the nutpie+JAX approach. With 8+ vectorised chains, the GPU gets a larger
batch of work per kernel launch.

**Why it might not help**: the model's Potentials are element-wise
gammaln/erfc sums, not matrix multiplies. GPUs excel at dense linear algebra
(matmul, Cholesky), not element-wise transcendentals. The RTX 4060 may not
be faster than 4 CPU cores for this specific workload pattern.

**Honest assessment**: probably 50/50. Worth a controlled experiment with
the simple graph first. If it's not faster on the simple graph (where
compilation is only 3s), it won't help on the branch graph either.

**Requirements**: `pip install "jax[cuda12]" numpyro`

**Trade-off**: bypasses nutpie entirely. Loses the Rust progress callbacks
(would need a different progress mechanism). The `_sample_nutpie()` code
path in inference.py would need a parallel `_sample_numpyro()` path.

### Path 5: Faster cloud CPUs

If staying CPU-bound (which is likely optimal for this model profile), faster
single-core clocks help directly.

| Provider | CPU | Single-core clock | Approx. cost | Notes |
|---|---|---|---|---|
| Hetzner dedicated | AMD EPYC 4565p | 5.1 GHz boost | ~€0.02/hr/core | ~2× cloud EPYC clocks; bare metal |
| AWS `c7i.metal-24xl` | Sapphire Rapids | 3.6 GHz sustained | ~$4/hr (96 vCPU) | High sustained clocks |
| Lambda Labs | Varies + GPU | Varies | ~$1-2/hr | Scientific compute focus |
| Modal (current) | Shared EPYC | ~2.5-3 GHz | Per-second | Convenience, not speed |

**Expected impact**: A 5.1 GHz EPYC vs ~3 GHz Modal = ~1.7× speedup from
clock speed alone. Modest but free of code changes.

### Path 6: float32 precision (speculative)

The [GPU vs CPU discourse thread](https://discourse.pymc.io/t/sampling-time-gpu-vs-cpu/11297)
reports dramatic speedups from float32:

- CPU float64: 14 min → **float32: 4 min** (3.5× faster)
- GPU float64: 19 min → **float32: 9 min** (2.1× faster)

PyMC/JAX can be configured to use float32 globally. This halves memory
bandwidth and doubles throughput for transcendental ops (gammaln, erfc).

**Risk**: float32 may introduce numerical issues in the posterior, especially
for gammaln with large arguments or erfc near 0/1. Would need careful
validation against float64 posteriors.

**Not recommended yet** — investigate after Paths 1-2 are exhausted.

---

## 4. Experiment protocol

All performance experiments must be journalled in
`18-compiler-journal.md` under a heading like:

```
### DD-Mon-YY: Performance experiment — [description]
```

Each entry must record:

1. **What was changed** (backend, flags, config, hardware)
2. **Exact command** (reproducible)
3. **Graph used** (simple / branch / production)
4. **Timings** (compile time, sampling time, total wall time)
5. **Convergence quality** (max rhat, min ESS, divergences)
6. **Comparison baseline** (what it's compared against, with timings)
7. **Conclusion** (faster/slower/same, by how much, and why)

Without all seven fields, the experiment is not useful — we've already lost
one JAX experiment to lack of documentation.

---

## 5. Recommended sequence

For **compiler development iteration** (the immediate pain point):

1. **Path 1**: Investigate and fix compilation time. Audit Potential data
   representation. Try `freeze_model=True`. Target: branch graph compiles
   in <15s.
2. **Path 2**: Add a `--dev` flag to test_harness.py that sets
   500/300/2 (draws/tune/chains). Use this as the default dev workflow.
3. Journal both experiments per §4 protocol.

For **production throughput** (later, when nightly scheduling is active):

4. **Path 3**: Increase default chains to 8 on Modal (which has many cores).
5. **Path 4**: Controlled NumPyro experiment on simple graph. If it wins,
   add as an alternative sampler backend in inference.py.
6. **Path 5**: Evaluate Hetzner/AWS for production compute if Modal clock
   speeds are a bottleneck.

---

## 6. Sources

- [Martin Ingram: MCMC for big datasets — faster sampling with JAX and the GPU](https://martiningram.github.io/mcmc-comparison/)
- [PyMC discourse: Sampling time GPU vs CPU](https://discourse.pymc.io/t/sampling-time-gpu-vs-cpu/11297)
- [PyMC discourse: Some questions on GPU based sampling](https://discourse.pymc.io/t/some-questions-on-gpu-based-sampling/16583)
- [PyMC discourse: NumPyro JAX sampling very slow](https://discourse.pymc.io/t/numpyro-jax-sampling-very-slow/12469)
- [nutpie docs: PyMC usage — backend selection](https://pymc-devs.github.io/nutpie/pymc-usage.html)
- [PyMC example gallery: Fast sampling with JAX and Numba](https://www.pymc.io/projects/examples/en/latest/samplers/fast_sampling_with_jax_and_numba.html)
- [Cloud VM benchmarks 2026: performance / price](https://dev.to/dkechag/cloud-vm-benchmarks-2026-performance-price-1i1m)
