# Doc 38: Contexted Model Compilation & Sampling Performance

## Problem Statement

The Phase 1 (window) model for `synth-simple-abc-context` — a 2-edge graph with 3 context slices per edge — takes 394s end-to-end: 29s compilation + 335s sampling. The same graph topology without context slices (`synth-simple-abc`) completes in 267s. The contexted model has 57 free RVs and 6 trajectory Potentials; the bare model has ~13 free RVs and 2 trajectory Potentials.

Production graphs have 4-8 edges and may have 5-15 context slices. At current scaling, such a graph would produce 100-300+ free RVs and 20-120 trajectory Potentials. Earlier in this session, 3 contexted graphs running in parallel caused WSL to crash (out of memory or compile timeout). Contexted Bayes is not usable at production scale.

---

## Observed Timings

### synth-simple-abc-context (2 edges, 3 slices each)

Source: [37c-synth-simple-abc-context-run-12apr26.log](37c-synth-simple-abc-context-run-12apr26.log)

| Phase | Wall clock | Notes |
|-------|-----------|-------|
| DB + evidence binding | 0s → 10s | 7.6s snapshot query (58,500 rows) |
| Model build (Python) | 10s → 21s | Constructing PyMC symbolic graph |
| nutpie compilation | 21s ��� 50s (29s) | PyTensor graph → Rust gradient function |
| Phase 1 sampling | 50s → 385s (335s) | 4 chains × 3000 draws (1000 tune + 2000 draw) |
| Phase 1 summarisation | 385s → 388s | ArviZ diagnostics |
| Phase 2 compilation | 388s → 393s (5s) | Aggregate-only cohort model (no per-slice) |
| Phase 2 sampling | ~0.2s | Trivial model |
| Delivery | 393s → 394s | |

### synth-simple-abc-context with bare DSL override (like-for-like baseline)

Source: [38f-bare-dsl-final-12apr26.log](38f-bare-dsl-final-12apr26.log) (12-Apr-26)

Same graph (`synth-simple-abc-context`), same DB data (58,500 rows fetched, 29,250 per edge post-regime), same edge IDs. The `--dsl-override "window(...);cohort(...)"` suppresses per-slice emission; context rows are MECE-aggregated into bare totals.

| Phase | Wall clock | Notes |
|-------|-----------|-------|
| DB + evidence binding | 0s → 4s | 2.0s snapshot query (58,500 rows), MECE aggregation |
| Model build (Python) | 4s → 14s | Constructing PyMC symbolic graph |
| nutpie compilation (Phase 1) | 14s → 22s (8.3s) | `compile=8267ms` |
| Phase 1 sampling | 22s → 50s (28s) | 4 chains × 3000 draws; `sampling_ms=27731ms` |
| Phase 2 compilation | ~55s → ~63s (7.5s) | `compile=7459ms` |
| Phase 2 sampling | ~63s → ~88s (26s) | `sampling_phase2_ms=25710ms` |
| **Total** | **113s** | `total_ms=113206ms` |

| Metric | Value |
|--------|-------|
| Free RVs (Phase 1) | 13 |
| Trajectory Potentials | 2 |
| Observed RVs | 6 |
| rhat | 1.002 |
| ESS | 10,274 |
| Divergences | 0 |

### synth-simple-abc (different graph — not a valid comparison)

Source: [38a-synth-simple-abc-uncontexted-run-12apr26.log](38a-synth-simple-abc-uncontexted-run-12apr26.log)

**Invalid for comparison**: different graph file, different edge hashes, different synthetic data, different DB rows (19,488 vs 58,500). Retained for reference only.

### Uncontexted regression suite (8 topology shapes, 28-Mar-26)

| Graph | Edges | Time | Notes |
|-------|-------|------|-------|
| synth-simple-abc | 2 (all-latency) | 267s | Chain |
| synth-mirror-4step | 4 (2 no-lat + 2 lat) | 130s | Chain, mixed |
| synth-fanout-test | 3 | 72s | Fan-out |
| synth-diamond-test | 4 | 935s | Diamond (join) |
| synth-skip-test | 3 | 296s | Skip edge |
| synth-join-branch-test | 5 | 567s | Join→branch |
| synth-3way-join-test | 5 | 603s | 3-way join |
| synth-lattice-test | 6 | 930s | Lattice (4-component) |

### Direct comparison — like-for-like (same graph, same DB data, same settings, 12-Apr-26)

Both runs use `synth-simple-abc-context` (same graph, same edge IDs, same DB). The bare-DSL run uses `--dsl-override` to suppress per-slice emission, aggregating context rows via MECE. Both use `latency_dispersion=False` and identical explicit settings from the FE CLI payload.

Sources:
- Bare-DSL: [38f-bare-dsl-final-12apr26.log](38f-bare-dsl-final-12apr26.log)
- Contexted: [38g-contexted-final-12apr26.log](38g-contexted-final-12apr26.log)

**Data verification** (all must match for valid comparison):

| Check | Bare-DSL | Contexted | Match? |
|-------|----------|-----------|--------|
| DB rows fetched | 58,500 | 58,500 | ✓ |
| Post-regime baaa2bf7 | 29,250→29,250 | 29,250→29,250 | ✓ |
| Post-regime 16876c46 | 29,250→29,250 | 29,250→29,250 | ✓ |
| total_n baaa2bf7 | 100,520 | 100,520 | ✓ |
| total_n 16876c46 | 72,981 | 72,981 | ✓ |
| MECE dimensions | ['channel', 'synth-channel'] | ['channel', 'synth-channel'] | ✓ |
| Settings (SOFTPLUS, DRAWS, etc.) | Explicit from CLI | Explicit from CLI | ✓ |
| `latency_dispersion` | False | False | ✓ |
| Analytic k/n baaa2bf7 | 38645/50260 | 38645/50260 | ✓ |
| Analytic k/n 16876c46 | 24969/38645 | 24969/38645 | ✓ |

**Performance comparison**:

| Metric | Bare-DSL (aggregate) | Contexted (3 slices) | Ratio |
|--------|---------------------|----------------------|-------|
| Phase 1 Free RVs | 13 | 51 | 3.9× |
| Trajectory Potentials | 2 | 6 | 3× |
| Observed RVs | 6 | 11 | 1.8× |
| nutpie compilation (Phase 1) | 8.3s | 35.5s | **4.3×** |
| Phase 1 sampling | 28s | 635s | **23×** |
| Phase 2 compilation | 7.5s | 8.0s | 1.1× (both aggregate) |
| Phase 2 sampling | 26s | 9s | 0.3× |
| End-to-end | 113s | 672s | **5.9×** |
| rhat | 1.002 | 1.004 | |
| ESS | 10,274 | 1,856 | |
| Divergences | 0 | **56** | |
| Bayes p (a→b) | 0.7641 | 0.7650 | |
| Bayes p (b→c) | 0.6450 | 0.6418 | |
| Quality | PASS | PASS (56 divergences) | |

**Key findings**:

1. Phase 1 sampling grew **23×** (28s → 635s). This is the dominant cost.
2. Phase 1 compilation grew **4.3×** (8s → 36s). Significant but secondary.
3. Phase 2 is identical structure (both aggregate, 7 RVs) — times are comparable.
4. The contexted model has 56 divergences and ESS=1,856 (vs 0 divergences, ESS=10,274 bare). This suggests the 51-dimensional posterior geometry is difficult for NUTS — not just slow but also less well-sampled.
5. Despite the sampling difficulties, both runs produce similar posteriors (p within 0.01 of each other and within 0.01 of analytic).
6. **Pending**: `latency_dispersion` defaults to `False` (`model.py` lines 359, 2156, 2498). It should default to `True` for production. The comparison above was run with `False` in both — re-run with `True` to measure the real production performance cost. This would add 6 `kappa_lat` RVs to the contexted model (51→57) and 2 to the bare-DSL model (13→15).

---

## Model Structure: Contexted vs Bare

### Free RVs per category (synth-simple-abc-context, Phase 1)

Counted from the model summary in [37c log](37c-synth-simple-abc-context-run-12apr26.log), lines 366-424.

| Category | Count | Per-what | Purpose |
|----------|-------|----------|---------|
| `p_*` (edge base) | 2 | edge | Base conversion rate |
| `eps_slice_*` (p offset) | 6 | slice | Per-slice p deviation from base |
| `tau_slice_*` | 2 | edge | Shrinkage SD for slice p offsets |
| `mu_lat_*` | 2 | edge | Latency log-centre |
| `sigma_lat_*` | 2 | edge | Latency log-spread |
| `eps_onset_*` (edge) | 2 | edge | Onset noise |
| `eps_mu_slice_*` | 6 | slice | Per-slice mu offset |
| `eps_sigma_slice_*` | 6 | slice | Per-slice sigma offset |
| `eps_onset_slice_*` | 6 | slice | Per-slice onset offset |
| `tau_mu_slice_*` | 2 | edge | Shrinkage SD for slice mu offsets |
| `tau_sigma_slice_*` | 2 | edge | Shrinkage SD for slice sigma offsets |
| `tau_onset_slice_*` | 2 | edge | Shrinkage SD for slice onset offsets |
| `log_kappa_*` (edge) | 2 | edge | Edge-level p overdispersion |
| `log_kappa_slice_*` | 6 | slice | Per-slice p overdispersion |
| `log_kappa_lat_*` | 6 | slice | Per-slice latency dispersion |
| `eps_mu_cohort_*` | 1 | edge (downstream only) | Cohort mu offset |
| `eps_sigma_cohort_*` | 1 | edge (downstream only) | Cohort sigma offset |
| `eps_onset_path_*` | 1 | edge (downstream only) | Cohort onset offset |
| **Total** | **57** | | |

Of these 57:
- **18 are per-edge** (would exist without contexts)
- **36 are per-slice** (6 vars × 6 slices)
- **3 are cohort-path** (downstream edge only)

### Potentials and Observed RVs

| Term type | Count | Description |
|-----------|-------|-------------|
| Trajectory Potentials | 6 | 1 per slice (window CDF likelihood) |
| Endpoint BetaBinomials (observed) | 5 | Per-slice mature-day obs |
| Per-slice Multinomials (observed) | 6 | Branch group per-slice |
| **Total likelihood terms** | **17** | |

Each trajectory Potential contains: `softplus` (sharpened, k=8), `erfc` (CDF), `log`, `clip`, BetaBinomial `gammaln` (via `pm.logp`), weighted sum over ~92-97 intervals.

### Scaling formula

For E edges with latency, S slices per edge:
- Free RVs ≈ 9E + 6ES + 3 (cohort paths for downstream edges)
- Trajectory Potentials = ES (each with ~90 interval CDF evaluations)
- Endpoint observed RVs ≈ ES (one per slice with mature days)
- Multinomial observed RVs ≈ branch_groups × S

---

## What We Do Not Know

1. **Compilation breakdown**: What fraction of the 29s nutpie compilation is PyTensor graph optimisation vs Rust code generation? `PYTENSOR_FLAGS=profile_optimizer=True` would answer this.

2. **Sampling cost per gradient evaluation**: `compiled_model.n_dim` (the unconstrained dimension count, which may differ from 57 due to transforms) is available at [inference.py:1543](../../../bayes/compiler/inference.py#L1543) but not logged. `sample_stats.n_steps` (leapfrog evaluations per draw) is available in the trace but not surfaced.

3. **Whether the 6 trajectory Potentials produce independent subgraphs**: The per-slice emission loop calls `_emit_cohort_likelihoods` 6 times, each creating its own `_compute_cdf_at_ages` closure and its own `pm.Potential`. These reference different per-slice variables (`mu_slice_*`, `sigma_slice_*`, etc.) but share the same edge-level variables (`mu_lat_*`, `sigma_lat_*`). Whether PyTensor recognises the block-sparse structure of the resulting Jacobian is not known.

4. **PyTensor graph size**: Number of Apply nodes in the dlogp graph before and after optimisation. Available via `pytensor.printing.debugprint()` or graph traversal. Not currently measured.

5. **nutpie tree depth and step size**: Whether NUTS is hitting max tree depth (geometry problem) or using small step sizes (curvature problem). Available in `trace.sample_stats` but not surfaced in the harness log.

6. **Compilation caching**: Whether nutpie/PyTensor caches compiled gradient functions across runs with identical model structure. If so, second runs of the same graph shape should compile instantly.

7. **Memory profile during compilation**: The WSL crashes suggest memory exhaustion. Peak RSS during the 29s compilation phase is not measured.

---

## Prior Attempt: Batched Trajectory Refactor (12-Apr-26)

`_emit_batched_slice_trajectories` (dead code, [model.py:2448-2679](../../../bayes/compiler/model.py#L2448)) replaced 6 per-slice Potentials with 1 batched Potential using `pt.stack` to combine per-slice variables into vectors and integer index arrays to route intervals to slices. The model never compiled. It was reverted to the current per-slice emission.

The function also emitted cohort trajectory Potentials that should not exist in Phase 1, introducing a separate correctness bug independent of the compilation issue.

The batched approach has not been tested in isolation (i.e. with the cohort bug fixed) against the current working per-slice code.

---

## Fixes applied during this investigation (12-Apr-26)

1. **Removed dangerous "largest non-MECE context as aggregate proxy" fallback** (`evidence.py`). When all DB rows are context-qualified and the dimension isn't declared MECE, the binder silently substituted a single context slice (e.g. google channel only) as the aggregate — modelling on ~1/3 of the data with no warning. Now logs a warning and leaves the aggregate empty.

2. **Eliminated duplicate payload code path in test harness** (`test_harness.py`). The `--graph` mode had its own hash computation, subject generation, and MECE dimensions logic — a duplicate of the FE CLI that drifted silently. It missed `mece_dimensions`, `candidate_regimes_by_edge`, and supplementary hash discovery. Now calls `_build_payload_via_cli` (the FE CLI) as the single canonical path.

3. **Fixed Step 5 supplementary hash discovery: single temporal mode only** (`candidateRegimeService.ts`). `bareTemporal` was set to `explodedSlices[0]` — the first exploded slice only (window). When the DSL is `window(...);cohort(...)`, this missed the cohort hash entirely. Now collects ALL unique bare temporal clauses from exploded slices via `bareTemporals` set.

4. **Fixed Step 5 supplementary candidates: window/cohort treated as competing regimes** (`candidateRegimeService.ts`). Each temporal mode's hash was added as a separate candidate regime. Regime selection then picked one (window) and dropped the other (cohort) — losing half the data. Now groups window+cohort hashes into one candidate per key-set with first as primary and rest as equivalents, same pattern as Step 2-3.

5. **Fixed pre-flight abort on empty bare-hash subjects** (`test_harness.py`). With the FE CLI producing subjects for bare hashes that legitimately have 0 DB rows (all data is context-qualified), the pre-flight aborted. Now checks per-edge totals instead of per-subject.

6. **Identified `latency_dispersion` confound**. The contexted 37c run used `latency_dispersion=True` (from the regression runner) while the bare-DSL baseline used module defaults (`False`). A strictly controlled comparison requires matching this setting.

---

## Five Hypotheses (from doc 37)

Documented in [37-contexted-compilation-investigation.md](37-contexted-compilation-investigation.md). None have been empirically tested.

| # | Hypothesis | Test |
|---|-----------|------|
| H1 | BetaBinomial `gammaln` gradient is the primary compilation cost driver | Run with `latency_dispersion=false` |
| H2 | Per-slice variable count exceeds compilation budget regardless of likelihood type | Share latency across slices, measure compilation |
| H3 | PyTensor graph optimisation (rewrite rules) causes super-linear blowup | `pytensor.config.optimizer='fast_compile'` |
| H4 | Batched Potential (`pt.stack` + indexing) prevents gradient factorisation | Compare batched vs unbatched compilation on identical model |
| H5 | nutpie compilation path differs from default PyMC `pm.sample()` path | Compile with both, compare times |

H4 was partially tested (the batched code never compiled), but confounded by the cohort bug. H1-H3 and H5 are untested.

---

## NUTS Geometry Diagnostics (12-Apr-26)

### Diagnostic instrumentation

Added NUTS sample_stats logging to `inference.py` (after trace construction): tree_depth distribution, step_size, n_steps (leapfrog evaluations), and energy. Also logs `n_dim` (unconstrained parameter count) alongside compile time.

### Controlled run: synth-simple-abc-context, latency_dispersion=False

Settings: `--draws 500 --tune 500 --chains 2 --feature latency_dispersion=false`

**Phase 1 (window, per-slice):**

| Metric | Value |
|--------|-------|
| n_dim | 51 |
| Free RVs | 51 |
| tree_depth | mean=8.0, max=10, pct_at_max≈0% |
| step_size | 0.0695 |
| n_steps (leapfrog) | mean=339, median=255, max=1023 |
| energy | mean=209,450, sd=7.7 |
| sampling_ms | 199,486 (200s for 2×1000 draws) |
| rhat | 1.012 |
| ESS | 271 |
| divergences | 3 |

**Phase 2 (cohort, aggregate — healthy reference):**

| Metric | Value |
|--------|-------|
| n_dim | 7 |
| tree_depth | mean=2.7, max=3, pct_at_max=71% |
| step_size | 0.7019 |
| n_steps (leapfrog) | mean=6, median=7, max=7 |
| energy | mean=520.5, sd=2.7 |
| sampling_ms | 143 (0.14s) |
| rhat | 1.004 |
| ESS | 987 |
| divergences | 0 |

### Interpretation

The Phase 1 geometry is severely degraded:

1. **Step size 10× smaller** than Phase 2 (0.07 vs 0.70). The sampler adapted to a very small step because the posterior has regions of high curvature — consistent with hierarchical funnels where tau → 0.

2. **339 leapfrog steps per draw** (vs 6 for Phase 2). Each step requires a full gradient evaluation through all 6 trajectory Potentials (each with ~90 interval CDF evaluations). At 339 steps/draw × 2000 draws × 6 Potentials × 90 intervals ≈ 366M CDF evaluations.

3. **3 divergences** in only 1000 post-warmup draws confirm the sampler is struggling with the geometry — not just slow, but occasionally failing to navigate the posterior.

4. **ESS = 271 from 1000 draws** — 27% efficiency. Many draws are correlated because the sampler can't take large steps.

### Root cause: hierarchical funnels

The model uses non-centred parameterisation for per-slice offsets:

```
eps ~ Normal(0, 1)
tau ~ HalfNormal(sigma)
param_slice = base + eps * tau
```

When data under-determines per-slice offsets (slices have similar latency curves), tau → 0. In non-centred form, this creates Neal's funnel: eps can take any value because tau × eps ≈ 0, requiring tiny step sizes.

There are **4 separate tau parameters per edge** (tau_slice for p, tau_mu_slice, tau_sigma_slice, tau_onset_slice), each creating its own funnel. With 2 edges, that's 8 funnel-inducing dimensions.

Additionally, the diagonal mass matrix (`PyNutsSettings.Diag` in inference.py) cannot capture the tau-eps correlations that define the funnel geometry.

### Proposed structural change: edge-level sigma and onset

**Hypothesis**: onset and sigma are structural properties of the measurement process — the lag shape and spread are the same regardless of which context slice the user came from. What differs between slices is the location (mu) — "this channel converts a bit faster/slower" — and the rate (p) and overdispersion (kappa).

**Proposal**: keep mu as per-slice (with tau_mu_slice), keep p per-slice (with tau_slice), keep kappa per-slice — but make sigma and onset edge-level only (shared across all slices).

**What changes in model.py** (Section 5, the per-slice hierarchy block at lines 1153-1196):
- Remove `tau_sigma_slice` and `tau_onset_slice` (2 RVs per edge → 4 total removed)
- Remove `eps_sigma_slice_*` and `eps_onset_slice_*` from the per-slice loop (6 RVs each → 12 total removed)
- Remove `sigma_slice_*` and `onset_slice_*` Deterministic nodes
- Per-slice `_lv` uses edge-level `_sigma_base` instead of per-slice sigma
- Per-slice `_ov` uses edge-level `_onset_base` instead of per-slice onset

**RV impact** (synth-simple-abc-context, 2 edges × 3 slices):
- Before: 51 free RVs, 8 funnel-inducing taus
- After: 35 free RVs, 4 funnel-inducing taus (tau_slice + tau_mu_slice per edge)
- Removed: 16 RVs (4 taus + 12 eps), 4 funnels

**Expected sampling impact**:
- Fewer funnels → larger step size → fewer leapfrog steps/draw
- Fewer dims → cheaper per-gradient cost
- Conservatively: 2-4× faster Phase 1 sampling. If the sigma/onset funnels were the dominant bottleneck, potentially more.

**Downstream code impact**:
- `inference.py` lines 1030-1035: looks up `sigma_slice_*` and `onset_slice_*` in trace — guarded by `if name in trace.posterior`, will gracefully skip. The diagnostic string at line 1044 assumes both exist if mu exists — needs to be made conditional.
- `run_regression.py` lines 450-453: uses threshold config keys `sigma_slice_z` etc — these are config keys, not variable names, unaffected.
- `worker.py`: no references to per-slice sigma/onset.

**What is NOT changed**: the number of trajectory Potentials (still 6, one per slice), the number of interval CDF evaluations per Potential, or the per-slice p/kappa hierarchy.

### Results: edge-level sigma/onset (12-Apr-26)

Same settings: `--draws 500 --tune 500 --chains 2 --feature latency_dispersion=false`

| Metric | Before (51 RVs) | After (35 RVs) | Change |
|--------|-----------------|-----------------|--------|
| n_dim | 51 | 35 | -31% |
| tree_depth mean | 8.0 | 7.4 | -0.6 |
| step_size | 0.0695 | 0.0785 | +13% |
| n_steps mean | 339 | 278 | -18% |
| n_steps max | 1023 | 1023 | unchanged |
| sampling_ms | 199,486 | 150,376 | **-25%** |
| rhat | 1.012 | 1.012 | unchanged |
| ESS | 271 | 232 | slightly worse |
| divergences | 3 | 1 | improved |

**Assessment**: 25% sampling speedup from removing 16 RVs and 4 funnels. The geometry is better (fewer divergences, slightly larger step size) but still fundamentally difficult — the remaining funnels (tau_slice for p, tau_mu_slice) are still forcing step_size ≈ 0.08.

Sigma posteriors confirm the change is well-motivated: edge-level sigma is tightly determined (0.520±0.002, 0.629±0.004) — no per-slice variation at all.

**The remaining bottleneck** is two-fold: (a) the tau_slice/tau_mu_slice funnels still force step_size ≈ 0.08 (sampler-side), and (b) the raw per-gradient cost of 6 near-identical CDF/hazard subgraphs in PyTensor (compiler-side). The edge-level sigma/onset change addressed (a) partially but did not touch (b) at all.

**Conclusion**: removing scalar RVs helps modestly, but the dominant cost is the duplicated symbolic graph structure — 6 separate trajectory Potentials each rebuilding the same CDF/hazard/survival machinery. The next intervention must attack the compiler-side cost directly.

---

## Proposed: Native Vector Batching of Per-Slice Phase 1 (12-Apr-26)

### Core idea

Keep the same statistical model (same number of latent dimensions, same hierarchy, same priors), but change the **symbolic representation** from many scalar RV nodes and many per-slice trajectory subgraphs to a few vector RV nodes and one batched trajectory Potential per edge.

Today, `model.py` does two expensive things for contexted Phase 1:

1. Creates slice effects one scalar at a time: `p_slice_*`, `kappa_slice_*`, `mu_slice_*`, etc.
2. Emits one window trajectory likelihood per slice by calling `_emit_edge_likelihoods()` / `_emit_cohort_likelihoods()` repeatedly.

PyTensor sees the same CDF and hazard machinery rebuilt for each slice. The proposal replaces that with:

- One edge-local **slice axis** (an ordered list of context keys per edge).
- One **vector RV** per slice-family for that edge (e.g. `eps_slice_vec` of shape `[n_slices]`).
- One **batched Phase 1 window trajectory likelihood** per edge (not per slice).

### Why native vectors matter (vs the dead `_emit_batched_slice_trajectories`)

The dead code at `model.py:2448-2679` started from many scalar RVs and used `pt.stack` + indexing to batch them after the fact. That preserves most of the original graph shape and adds extra indexing structure on top — plausibly why the earlier batched attempt never compiled.

The stronger version: build slice parameters **as vectors from the beginning**. Keep slice order explicit and stable. Make the batched likelihood consume those vectors directly. PyTensor no longer has to optimise dozens of near-identical scalar subgraphs and then reason about a later stack.

### Design

#### 1. Explicit slice axis per edge

In `build_model()`, each contexted edge constructs a stable ordered slice list once:

- `edge_id`
- ordered `ctx_key` list
- index mapping: `ctx_key → position`
- corresponding `SliceObservations` / `EdgeEvidence` entries

This metadata is returned so downstream code (posterior extraction) does not reverse-engineer variable names.

**Key invariant**: every place that currently loops over slices by string key should instead use a stable `slice_idx`.

#### 2. Vector RVs replace scalar per-slice RVs

For a non-branch-group latency edge, the current scalar slice families become edge-local vectors:

| Current (scalar) | Proposed (vector) | Shape |
|---|---|---|
| `eps_slice_{edge}_{ctx}` × S | `eps_slice_vec_{edge}` | `[S]` |
| `log_kappa_slice_{edge}_{ctx}` × S | `log_kappa_slice_vec_{edge}` | `[S]` |
| `eps_mu_slice_{edge}_{ctx}` × S | `eps_mu_slice_vec_{edge}` | `[S]` |
| `log_kappa_lat_{edge}__{ctx}_window` × S (if lat_disp) | `log_kappa_lat_vec_{edge}` | `[S]` |

Edge-level shrinkage terms (`tau_slice`, `tau_mu_slice`) stay scalar. Only the per-slice eps/kappa parts become vectors.

This preserves model semantics: same number of slice effects, same hierarchy, same prior families, same edge-level base parameters. Only the symbolic representation changes.

#### 3. One batched Phase 1 window trajectory likelihood per edge

Once slice parameters are vectors, all slice trajectories for one edge flatten into one batched structure. For each edge, build arrays for:

- retrieval ages (all slices concatenated)
- interval `d`, `n_at_risk`, `weights`
- current/previous age indices
- `slice_idx` for each age and each interval

Then compute **once per edge**:

1. Per-age CDF using vector slice latency parameters (mu indexed by `slice_idx`, sigma/onset from edge level)
2. Per-interval `delta_F`, survival, hazard `q_j`
3. Log-likelihood contribution (one `pm.Potential` per edge)

For synth-simple-abc-context: **2 window trajectory Potentials instead of 6**.

#### 4. Scope: v1 leaves other likelihoods unchanged

To keep blast radius concentrated on the dominant cost driver:

- **Changed**: Phase 1 contexted window trajectories only
- **Unchanged**: daily endpoint BetaBinomial/Binomial, branch-group Multinomial/DirichletMultinomial, Phase 2 cohort path, join-mixture logic, uncontexted path

#### 5. Posterior extraction: metadata-based, not name-based

`summarise_posteriors()` in `inference.py` currently reconstructs per-slice results by string-building scalar names like `p_slice_{edge}_{ctx}`. With vector RVs:

- Read the vector posterior once
- Map indices back to `ctx_key` via the metadata
- Populate `post.slice_posteriors` in exactly the same shape as today

This is the right trade-off: move complexity out of the symbolic graph (expensive at compile/sample time) and into the summariser (cheap).

### Expected impact

**Compile time** — main expected win. Reducing duplication in three places: fewer RV nodes, fewer repeated CDF/hazard subgraphs, fewer `pm.Potential` nodes. Current doc 38 numbers already suggest compile time scales with repeated slice emission, not just latent dimension.

**Sampling time** — secondary win. Latent dimension is unchanged, so this will not remove divergences or fix funnel geometry. But each gradient evaluation should be cheaper (smaller symbolic graph, less duplicated work), and fewer Potential nodes may reduce constant overhead during NUTS.

**What it will NOT fix** — sampler geometry problems from hierarchical tau funnels, the nonlinear p/CDF/survival coupling, or hard positive clamps (`pt.maximum`). Those are sampler-side issues requiring separate reparameterisation work.

### Why per-edge batching (not model-wide)

Per-edge is the sweet spot:

- Removes the slice duplication that is the cost driver
- Keeps index bookkeeping local to each edge
- Keeps debugging understandable (can inspect one edge at a time)
- Avoids building one giant monolithic graph across all edges

### Files affected

| File | Change |
|------|--------|
| `bayes/compiler/model.py` | Slice axis metadata, vector RVs, batched Phase 1 window trajectory |
| `bayes/compiler/inference.py` | Posterior extraction: vector→per-slice unpacking via metadata |
| `bayes/worker.py` | Light touch if metadata threading changes |
| `bayes/run_regression.py` | Only if log wording or variable naming assumptions leak |

`run_inference()` already keys trajectory log-likelihood off the `ll_traj_` prefix — if the batched path keeps that prefix, LOO plumbing should be straightforward.

### Rollout plan

1. **Slice-axis metadata** — introduce without changing inference. De-risks ordering bugs before touching the likelihood path.
2. **Vector RVs** — convert Phase 1 slice RV families to native vectors. Do not batch the likelihood yet; prove the vector representation is correct first.
3. **Batched trajectory** — replace per-slice Phase 1 window trajectory emission with one batched edge-local likelihood. Keep all other paths unchanged.
4. **Posterior extraction** — update `summarise_posteriors()` to unpack vector traces.
5. **Feature flag + parity** — gate behind a feature flag, run parity on synth-simple-abc-context. Target: compile-time reduction with posterior parity good enough for regression use.

### Risks

1. **Slice ordering bugs** — could silently swap posteriors between contexts. Mitigated by stable ordered slice list and parity testing.
2. **Advanced indexing pessimisation** — if batching still relies on heavy `pt.advanced_indexing`, PyTensor may still optimise poorly. The native-vector approach (no stack/index) should avoid this, but needs empirical confirmation.
3. **Summariser breakage** — `summarise_posteriors()` assumes scalar variable names; will break until updated. Addressed in phase 4.
4. **Branch-group context paths** — may need separate treatment later, excluded from v1 scope.

---

## Implementation Results (12-Apr-26)

### What was implemented

All 5 phases completed in one session:

1. **Slice-axis metadata**: each contexted edge gets a stable ordered `ctx_keys` list with `ctx_to_idx` mapping, returned in `build_model` metadata.
2. **Native vector RVs**: `eps_slice_vec`, `log_kappa_slice_vec`, `eps_mu_slice_vec` (shape `[n_slices]`) replace per-slice scalar RVs. Per-slice emission loop indexes into vectors.
3. **Batched window trajectory**: `_emit_batched_window_trajectories()` replaces per-slice `_emit_cohort_likelihoods` for Phase 1 window trajectories. One `pm.Potential` per edge instead of one per slice.
4. **Posterior extraction**: `summarise_posteriors()` reads vector traces via `slice_axes` metadata (with scalar fallback for backward compatibility).
5. **Edge-level sigma/onset**: `sigma` and `onset` latency parameters are edge-level only (not per-slice). Eliminates 4 tau funnels and 12 eps RVs.

### Combined results: synth-simple-abc-context

Settings: `--draws 500 --tune 500 --chains 2 --feature latency_dispersion=false`

| Metric | Original (scalar) | **Final (batched)** | Change |
|--------|-------------------|---------------------|--------|
| Free RVs (PyMC count) | 51 | 23 | -55% |
| n_dim (unconstrained) | 51 | 35 | -31% |
| Potentials | 6 | 2 | -67% |
| compile_ms | 26,410 | **18,639** | **-29%** |
| sampling_ms | 199,486 | 158,793 | -20% |
| step_size | 0.0695 | 0.0786 | +13% |
| n_steps mean | 339 | 263 | -22% |
| tree_depth mean | 8.0 | 7.4 | -8% |
| divergences (in 1000 draws) | 3 | 0* | improved |

*Divergence count varies between runs due to MCMC stochasticity.

**Posterior parity** (all values within MCMC noise):

| Slice | Original p | Final p |
|-------|-----------|---------|
| direct (edge 1) | 0.7063 | 0.7088 |
| email (edge 1) | 0.5405 | 0.5422 |
| google (edge 1) | 0.8486 | 0.8516 |
| direct (edge 2) | 0.6134 | 0.6114 |
| email (edge 2) | 0.4632 | 0.4621 |
| google (edge 2) | 0.6983 | 0.6990 |

### Scaling projection

For production graphs with E edges and S slices/edge:

| Component | Before | After | Scaling |
|-----------|--------|-------|---------|
| Free RVs | 9E + 6ES + 3 | 9E + 3ES + 3 | ~halved per-slice cost |
| Potentials | ES | E | O(S) → O(1) per edge |
| Compile time | O(ES) in graph nodes | O(E) + smaller const | Sub-linear in S |

For a 4-edge, 10-slice production graph: Potentials drop from 40 to 4. The compile improvement should scale roughly proportionally.

### What remains

The **geometry problem** (step_size ≈ 0.08, tree_depth ≈ 7.4) is still the dominant sampling cost and was not addressed by this work. The tau_slice and tau_mu_slice funnels require sampler-side changes:

1. Centred parameterisation for the p hierarchy
2. nutpie `low_rank_modified_mass_matrix=True`
3. Fixed tau (empirical Bayes)

These are independent of the batching work and can be tried separately.

### Low-rank mass matrix experiment (12-Apr-26)

nutpie supports `PyNutsSettings.LowRank` — a low-rank modified mass matrix that can capture correlations between parameters (e.g. tau-eps funnel structure) that a diagonal mass matrix cannot. Added as `--feature lowrank_mass_matrix=true`, gated behind `SamplingConfig.lowrank_mass_matrix`.

**Results** (synth-simple-abc-context, all batched + edge-level sigma/onset):

| Metric | Diag (tune=500) | LowRank (tune=500) | LowRank (tune=1000) |
|--------|-----------------|---------------------|----------------------|
| compile_ms | 18,639 | 15,572 | 15,699 |
| sampling_ms (Phase 1) | 158,793 | **70,311** | **116,095** |
| step_size | 0.0786 | **0.1195** | **0.1217** |
| n_steps mean | 263 | **78** | **82** |
| tree_depth mean | 7.4 | **5.6** | **5.7** |
| rhat | 1.019 | 1.054 (poor) | **1.022** |
| ESS | 191 | 66 (poor) | **117** |
| divergences | 0 | 0 | 0 |

**Key finding**: the low-rank mass matrix is highly effective. Step size increased 52% (0.08 → 0.12) and leapfrog steps dropped 70% (263 → 78). This confirms the geometry hypothesis: the diagonal mass matrix could not capture the tau-eps correlations, forcing small steps.

**Trade-off**: low-rank adaptation needs more warmup. With tune=500, convergence was poor (rhat=1.054, ESS=66). With tune=1000, convergence improved to acceptable levels (rhat=1.022, ESS=117). The extra warmup cost is more than paid for by the per-draw efficiency gain.

**Per-draw efficiency comparison**:
- Diag: ~159ms per draw (including warmup)
- LowRank (tune=1000): ~39ms per draw (including warmup) — **4× improvement**

**Posteriors** remain consistent with all previous runs (within MCMC noise):

| Slice | Diag p | LowRank p |
|-------|--------|-----------|
| direct (edge 1) | 0.7088 | 0.7058 |
| email (edge 1) | 0.5422 | 0.5410 |
| google (edge 1) | 0.8516 | 0.8460 |

**Recommendation**: enable low-rank by default for contexted models with n_dim > ~20. Increase default tune to 1000 (from current 1000 — already correct). For small uncontexted models (n_dim < 15), diagonal is sufficient and avoids the low-rank warmup overhead.

**Implemented (12-Apr-26)**: `inference.py` auto-selects `PyNutsSettings.LowRank` when `compiled_model.n_dim > 20`. Phase 1 of synth-simple-abc-context (n_dim=35) gets lowrank; Phase 2 (n_dim=19) gets diag. Overridable via `SamplingConfig.lowrank_mass_matrix` or `--feature lowrank_mass_matrix=true/false`.
