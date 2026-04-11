# Doc 37: Contexted Model Compilation — Investigation

**Status**: Open investigation
**Created**: 12-Apr-26
**Severity**: Blocking — contexted regression suite cannot run

---

## Problem Statement

The uncontexted Bayes model compiles and samples correctly. The contexted model does not compile at all — PyTensor C compilation of the gradient function exhausts available memory, crashing the WSL2 VM. This has been reproduced on 3+ separate attempts across multiple sessions. The system never reaches MCMC sampling; it hangs indefinitely at the "compiling" stage, then WSL terminates with `E_UNEXPECTED / Catastrophic failure`.

### What works

- **Uncontexted regression**: 11 synth graphs compile and sample. Simple-abc: ~14s total. Full suite: all pass with `latency_dispersion=true`.
- **Bare DSL on contexted data**: `synth-simple-abc-context` with `--dsl-override` (bare DSL, no context commissioning) — 29,250 context-qualified rows fetched, MECE-aggregated into bare totals, 2 trajectory Potentials, compiles in ~37s, all parameters recovered. **13 free RVs**.
- **Synthetic test**: Programmatically constructed 1-edge × 3-slice model with `has_slices=True` — `build_model()` returns in 2.5s, 1 batched trajectory Potential. But `build_model()` only constructs the symbolic graph; the C compilation that happens inside `pm.sample()` was not tested.

### What fails

- **Any contexted graph with `has_slices=True`**: `synth-simple-abc-context` with its original contexted DSL. The model enters per-slice emission (Section 5 of `build_model`), creates per-slice variables, emits per-slice likelihoods, and then PyTensor C compilation of the `dlogp` function hangs/OOMs.
- **Happens regardless of graph complexity**: Even the simplest contexted graph (2 edges × 3 slices) fails. Lattice (9 edges × 3 slices) is worse but the problem manifests on the smallest case.

### The isolation test

The bare-DSL-on-contexted-data test is a clean control:

| | Bare DSL (works) | Contexted DSL (crashes) |
|---|---|---|
| **Data** | Same 29,250 rows | Same 29,250 rows |
| **Evidence binding** | Same pipeline | Same pipeline |
| **MECE aggregation** | Context rows → bare totals | Context rows → per-slice SliceGroups |
| **`has_slices`** | False | True |
| **Free RVs** | ~13 | ~46 |
| **Trajectory Potentials** | 2 (aggregate) | 2 (batched) — same after fix |
| **Per-slice likelihoods** | None | 6 daily BBs, 6+ window Binomials |
| **Compilation** | ~37s | Never completes |

The **only** difference is `has_slices=True` → per-slice variable creation + per-slice likelihood emission. The data, hashing, DB query, evidence binding, and trajectory Potential structure are identical.

---

## What We Know

### 1. The symbolic graph (`build_model`) constructs quickly

`build_model()` for a 1-edge × 3-slice synthetic test returns in 2.5s. The PyMC model object is well-formed: correct Potentials, correct free RVs, correct deterministics. The problem is not in model construction.

### 2. The bottleneck is PyTensor C compilation of `dlogp`

PyTensor compiles the gradient function (`dlogp`) to C code before NUTS sampling can start. This compilation takes the full symbolic graph and generates a single C function that computes partial derivatives of the log-posterior w.r.t. every free variable. The C compiler then compiles this generated source. For the contexted model, this process either:
- Generates C source too large for the compiler to handle in available memory, or
- Takes so long that it appears to hang (and eventually WSL OOMs)

### 3. The variable count scales linearly with slices

Per-slice variables for one edge with latency:
- `eps_slice` (Normal) — 1 per slice
- `log_kappa_slice` (Normal) — 1 per slice
- `eps_mu_slice`, `eps_sigma_slice`, `eps_onset_slice` (Normal) — 3 per slice
- With `latency_dispersion`: `log_kappa_lat` (Normal) — 1 per slice per obs_type

Total: **6 free RVs per slice per edge with latency** (+ deterministics).

For simple-abc-context (2 edges × 3 slices): ~36 additional free RVs on top of ~10 base = **~46 total**.

### 4. The gradient function size scales with (free_RVs × likelihood_complexity)

Each likelihood term's gradient must be computed w.r.t. every free variable it depends on. With per-slice BetaBinomial likelihoods:
- 9 gammaln evaluations per interval per BetaBinomial
- Each gammaln's gradient is a digamma (polygamma)
- Per-slice kappa_lat flows through to all intervals of that slice

With per-slice trajectory Potentials (even batched):
- CDF computation involves `softplus`, `erfc`, `log`, `clip`
- Gradient of stacked variables through index operations creates scatter (`IncSubtensor`) ops
- Each per-slice onset/mu/sigma contributes a gradient path through the full CDF subgraph

### 5. What we have NOT yet measured

- **Actual C source size**: How large is the generated C code for the contexted model vs the bare model?
- **Memory profile during compilation**: Where does memory go — PyTensor graph optimisation, C code generation, or gcc compilation?
- **Compilation time vs memory**: Is the process merely slow (would finish given enough RAM/time) or does it hit an exponential blowup?
- **Which specific likelihood terms dominate**: Is it the batched trajectory BetaBinomial, the per-slice daily BetaBinomials, the per-slice window Binomials, or the sheer number of free variables?
- **The effect of disabling `latency_dispersion`**: Does removing BetaBinomial (switching to plain Binomial logp) allow compilation?
- **The effect of sharing latency across slices**: Does reducing per-slice latency variables (eps_mu, eps_sigma, eps_onset) allow compilation?

---

## Hypotheses (to be tested)

### H1: BetaBinomial gammaln gradient is the primary cost driver

BetaBinomial logp expands to 9 gammaln terms per interval. Each gammaln's gradient is a digamma. With `latency_dispersion=true` and per-slice kappa_lat, every per-slice trajectory interval goes through this gammaln gauntlet. Disabling `latency_dispersion` for per-slice Potentials (plain Binomial logp: just `d*log(q) + (n-d)*log(1-q)`) should dramatically reduce the gradient function size.

**Test**: Run contexted graph with `latency_dispersion=false`.

### H2: Per-slice variable count exceeds PyTensor's compilation budget

46 free RVs with complex gradient paths may generate a C function too large for gcc to compile in available memory, regardless of likelihood type. The gradient function has ~46 output dimensions, each potentially depending on hundreds of intermediate nodes.

**Test**: Run contexted graph with shared latency (remove per-slice eps_mu/eps_sigma/eps_onset — only p varies per slice). This cuts ~18 free RVs.

### H3: PyTensor graph optimisation (rewrite rules) causes exponential blowup

PyTensor applies graph optimisation passes before C code generation. Certain patterns (e.g., `Subtensor` indexing into stacked variables + BetaBinomial logp) may trigger rewrite rules that expand the graph exponentially rather than simplify it.

**Test**: Set `pytensor.config.optimizer='fast_compile'` or `'o0'` (minimal optimisation) and measure whether compilation completes (slowly) or still OOMs.

### H4: The batched trajectory Potential is worse than unbatched for compilation

The batched version creates `onset_stack[slice_idx]` index operations that make the single Potential depend on ALL per-slice variables. PyTensor cannot factorise the gradient into independent per-slice blocks. The unbatched version (one Potential per slice) might paradoxically compile better because each Potential's gradient is independent and smaller.

**Test**: Temporarily revert to unbatched (set `skip_trajectory_potentials=False` everywhere, don't call `_emit_batched_slice_trajectories`). Test with `latency_dispersion=false` to remove BetaBinomial complexity.

### H5: nutpie (Rust sampler) compilation differs from PyMC default

The harness may use nutpie (listed in env: `nutpie=0.16.8`). nutpie has its own compilation path that may differ from PyMC's default. The compilation behaviour may be nutpie-specific.

**Test**: Force `pm.sample(... , nuts_sampler='pymc')` to use the default PyMC/PyTensor path instead of nutpie.

---

## Suggested Investigation Order

1. **H1 first** (lowest-risk test): Run `synth-simple-abc-context` with `--feature latency_dispersion=false`. If it compiles, BetaBinomial is the bottleneck.
2. **H3 second** (diagnostic): Set `pytensor.config.optimizer='fast_compile'` with `latency_dispersion=true`. If it compiles (slowly), the optimiser is the bottleneck.
3. **H2 third**: If H1 and H3 both fail, test with shared latency across slices.
4. **H4 and H5**: Only if H1-H3 don't identify the root cause.

---

## Related Work

- **Batched trajectory Potentials**: `model.py` `_emit_batched_slice_trajectories` — reduces O(E×S) Potentials to O(E). Implemented 12-Apr-26, untested on real contexted compilation.
- **Supplementary hash discovery**: `candidateRegimeService.ts` Step 5 — closes the programme.md gap (lines 1310-1330). Implemented 12-Apr-26, verified working.
- **`--dsl-override` flag**: Enables bare-on-contexted isolation test. Implemented 12-Apr-26, verified working.
- **Handover**: `docs/current/handover/12-Apr-26-contexted-compilation-and-supplementary-hashes.md`
- **Programme.md**: Lines 1310-1330 (historical hash discovery — now closed).
- **Doc 34**: `latency_dispersion` background, BetaBinomial approach.
- **Anti-pattern #32**: Signature contamination from param file values (disabled `candidateContextKeys` in `plannerQuerySignatureService.ts`).
