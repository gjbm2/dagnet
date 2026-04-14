# 40 — Centred Parameterisation: Sparsity Robustness Investigation

**Status**: Open — needs bottoming out before shipping centred as default
**Created**: 14-Apr-26
**Context**: Phase C slice pooling (doc 14), latency reparam (doc 34), regression baseline (doc 34a)

---

## 1. Problem Statement

The centred parameterisation breakthrough (14-Apr-26 handover) delivered dramatic gains on synthetic contexted graphs:

| Metric | Non-centred | Centred | Improvement |
|--------|-------------|---------|-------------|
| Phase 1 time (synth-skip-context) | 274s | 52s | 5.3x |
| ESS | 93 | 671 | 7.2x |
| Divergences | 14 | 0 | Eliminated |
| Convergence | 39% | 100% | — |

These results were obtained on synthetic data where **every slice has hundreds of observations**, context weights are reasonably balanced (0.10–0.60), and fetch coverage is near-complete. The standard literature (Betancourt 2017, Stan manual) predicts that centred parameterisation excels precisely in this regime — strong per-group data, weakly informed group mean — and struggles in the opposite regime.

**The concern**: production graphs will contain thin slices, unbalanced MECE partitions, structural zeros, and sparse fetch coverage. If centred parameterisation degrades on sparse data, shipping it as the unconditional default risks divergences and poor recovery on exactly the edges that matter most (low-traffic contexts where borrowing strength is the whole point of the hierarchy).

**Early warning signs already visible on synth data**:
- Per-slice onset recovery is systematically poor (z=3.4–7.2, biased high) even with generous data
- One chain stochastically stalls on diamond-context (crawling at ~1 sample/2s in Phase 1)
- These may worsen under sparsity

---

## 2. Sparsity Model

Real snapshot DBs don't have uniform coverage. Data availability patterns include:

- **Missing frames**: random gaps where a retrieval date simply has no row for a given edge/slice (fetch failures, API outages, partial ingestion)
- **Start/stop signals**: an edge or slice begins or ceases emitting observations at some point in the observation window (new tracking deployed, tracking removed, context dimension added/retired)
- **Initial absence**: some edge×slice combinations don't exist at all at the start of the observation window and only appear partway through

These are fundamentally different from low traffic. A slice can have high traffic when present but still be sparse in the snapshot DB because it only covers 20 of 100 days.

### 2.1 Truth YAML Sparsity Parameters

Three new flat keys in the `simulation` block of truth YAML files (same level as `failure_rate`, `mean_daily_traffic`, etc.):

```yaml
simulation:
  # ... existing params ...
  frame_drop_rate: 0.15        # 1 in ~7 frames randomly missing per edge×slice×date
  toggle_rate: 0.02            # 2% chance per date that any given edge×slice starts or stops emitting
  initial_absent_pct: 0.30     # 30% of edge×slice combinations don't emit initially
```

**`frame_drop_rate`** (0.0–1.0): probability that any individual observation row (one edge×slice×retrieved_at combination) is dropped from the snapshot DB. Applied independently per row during emission. Simulates random fetch failures, ingestion gaps, and API timeouts. Existing `failure_rate` drops entire fetch nights across all edges; `frame_drop_rate` is finer-grained — per edge×slice.

**`toggle_rate`** (0.0–1.0): probability per date that any given edge×slice combination flips between emitting and not-emitting. Once toggled off, it stays off until toggled on again (and vice versa). Creates realistic contiguous gaps and late-start patterns. Applied per edge×slice independently, so different slices go dark on different dates.

**`initial_absent_pct`** (0.0–1.0): fraction of edge×slice combinations that start in the not-emitting state. Combined with `toggle_rate`, this means some slices only appear partway through the observation window, and some may never appear at all if they're never toggled on.

**Interaction**: all three mechanisms compose independently. A slice that is currently "emitting" (per toggle state) still has each individual frame subject to `frame_drop_rate`. A slice that starts absent and is never toggled on produces zero rows regardless of `frame_drop_rate`.

### 2.2 Injection Point: synth_gen.py Emission (not Evidence Binding)

**Decision**: sparsity is applied during observation emission in `synth_gen.py`, not downstream in evidence binding.

**Rationale**: the alternative — generate a full DB once and thin it at binding time — would make the sweep cheaper (no regeneration per draw). But:

- It introduces a thinning layer that only exists in the test path. The model's evidence binding sees a transformation that production never applies, so a passing test doesn't fully prove the production path works.
- Contiguous gaps from start/stop signals interact with completeness corrections, which are computed from the raw snapshot rows during emission. Thinning after emission would produce gap patterns with completeness values that don't reflect the gaps — the numbers wouldn't be self-consistent.
- The cost argument is weak: synth generation takes seconds per graph; MCMC fitting takes minutes. Regenerating 50 sparse DBs adds ~2–3 minutes to a sweep dominated by ~100 MCMC runs (hours). Not worth the complexity.

Keeping it in synth means one artefact, one truth: the snapshot DB on disk is exactly what the model sees, same as production.

**Implementation** — all three mechanisms apply during observation emission (`_generate_observations_nightly`, lines ~1461–1637), after population simulation is complete. The underlying population and traversal are unaffected — sparsity is purely about what the snapshot DB *observes*, not what actually happened.

1. **Initialisation** (before the fetch-night loop): for each edge×slice combination, draw initial state from `Bernoulli(1 - initial_absent_pct)`. Store as `emitting: dict[(edge_id, slice_key), bool]`.

2. **Per-date toggle** (at the start of each fetch night): for each edge×slice, draw `Bernoulli(toggle_rate)`. If drawn, flip `emitting[(edge_id, slice_key)]`.

3. **Row emission gate** (where individual rows are written, lines ~1504–1531 for cohort, ~1588–1619 for window): skip the row if `emitting[(edge_id, slice_key)]` is False, or if `random() < frame_drop_rate`.

No changes needed to population simulation, traversal, or context assignment. The truth file still records the full ground truth parameters — sparsity only affects what evidence the model sees.

### 2.3 Sparsity Regression Design

The goal is not to test a handful of hand-crafted sparse scenarios but to **sweep across a distribution of sparsity levels** and map the performance surface for centred vs non-centred.

**Builds on existing toolchain** (see `BAYES_REGRESSION_TOOLING.md`): the sweep uses the established `run_regression.py` → `param_recovery.py` → `test_harness.py` pipeline. This gives us the nine-layer audit (DSL, binding, convergence, recovery z-scores, LOO-ELPD), stall detection and retry, job labelling, timeout handling, and per-edge binding detail for free. We are not reinventing the scoring — we are generating varied inputs and comparing two configurations through the existing audit.

**Sweep dimensions** (draw from distributions, not fixed values):

| Parameter | Distribution | Rationale |
|-----------|-------------|-----------|
| `frame_drop_rate` | Uniform(0.0, 0.40) | From perfect coverage to heavily gapped |
| `toggle_rate` | Uniform(0.0, 0.08) | From stable to frequently toggling |
| `initial_absent_pct` | Uniform(0.0, 0.50) | From all-present to half-absent at start |
| Context weight skew | Dirichlet(0.3, 0.3, 0.3) | Draws range from balanced to heavily skewed |

**Wrapper script** (`scripts/sparsity-sweep.py`):

The wrapper's job is narrow: generate truth YAML variants and invoke the existing regression pipeline twice per variant (centred vs non-centred). It does not duplicate any fitting, scoring, or audit logic.

1. **Generate truth variants**: for each draw i in 1..N (say 20–50):
   - Sample sparsity parameters from the distributions above
   - Write a truth YAML variant (e.g. `synth-skip-context-sparse-{i}.truth.yaml`) with the sampled `sparsity` block, inheriting all other parameters from the base truth file
   - Record the sampled parameters as metadata for later analysis

2. **Bootstrap**: for each variant, run `synth_gen.py --write-files` to generate the snapshot DB with the sparsity layer applied. Record effective per-slice observation counts (total rows, unique dates, fraction of possible frames present) as metadata. Use `--rebuild` since each variant has different sparsity parameters and the DB must be regenerated.

3. **Run regression — centred**: invoke `param_recovery.py` per graph with default flags (centred is default since 14-Apr-26). Use `--max-parallel 1` (JAX fans across cores). Use `--timeout 0` for initial exploratory runs on sparse variants where sampling time is unpredictable. Capture the full multi-layered audit output per graph.

4. **Run regression — non-centred**: same graphs, same DB, but with `--feature centred_p_slices=false --feature centred_latency_slices=false`. Same `--max-parallel 1`, same timeouts.

5. **Collate**: parse the audit output from both runs (layers 6–7: convergence and recovery) and join with the per-variant sparsity metadata. The key columns per graph×variant×config are:
   - Wall time, ESS (min across parameters), divergence count, convergence %
   - Per-slice recovery z-scores for p, mu, onset
   - Per-slice effective n (from step 2 metadata)
   - Layer 3 binding detail (how many edges fell back to param files due to sparse data)

6. **Analyse**: produce scatter plots of recovery quality vs effective per-slice n, coloured by parameterisation. The key output is the **crossover curve**: at what effective n does centred start outperforming non-centred (or vice versa)?

**Practical notes**:
- Run graphs sequentially (`--max-parallel 1`) — JAX saturates all cores per graph.
- Use `python3 -u` for unbuffered output on background runs.
- Each variant generates unique job labels via the existing `{graph}-r{timestamp}` scheme — no collision risk.
- Harness logs land at `/tmp/bayes_harness-{job_label}.log` per usual; the wrapper doesn't need to manage log files.
- The wrapper should NOT call `test_harness.py` directly — always go through `param_recovery.py` so truth comparison happens (rule 1 in regression tooling doc).

**What this answers**:
- Is there a clean crossover point, or is centred uniformly better/worse?
- If there's a crossover, where is it? (informs the threshold for adaptive parameterisation)
- Does the degradation on thin slices manifest as wider posteriors (graceful) or divergences/stalling (catastrophic)?
- Do stop/start patterns (contiguous gaps) cause different problems than random frame drops?
- Does binding (layer 3) degrade on sparse variants? If the data is too sparse, evidence binding may fall back to param files — which would mask the parameterisation comparison entirely.

---

## 3. Mitigation Strategies (if Sparsity Degrades Centred)

### 3.1 Adaptive Per-Slice Parameterisation

Choose centred vs non-centred per slice based on a data-sufficiency threshold. Conceptually:

- For each slice, compute effective sample size (sum of denominators across anchor days, adjusted for completeness)
- If n_eff > threshold (e.g. 100), use centred: `p_slice ~ Normal(logit(p_base), tau)`
- If n_eff <= threshold, use non-centred: `p_slice = logistic(logit(p_base) + eps * tau)`, `eps ~ Normal(0, 1)`

This is mechanically straightforward in PyMC (conditional within `pm.math.switch` or separate plate blocks per group). The threshold value needs calibration against the sparse scenarios above.

**Trade-off**: adds branching complexity to the model builder and makes the compiled model depend on the data shape, not just the graph topology. But it's the most targeted fix.

### 3.2 Interweaving (Papaspiliopoulos-Roberts-Skold)

Run both parameterisations in alternating Gibbs blocks within a single chain. Theoretically optimal — each block mixes well in the regime where the other struggles. But:

- PyMC doesn't natively support interweaving; would need custom step methods or a switch to a lower-level PPL (NumPyro/Stan)
- Implementation cost is high relative to adaptive per-slice
- Park this unless adaptive per-slice proves insufficient

### 3.3 Data-Sufficiency Gate with Fallback

A simpler operational approach: before compilation, check per-slice effective sample sizes. If any slice falls below the threshold:

- Option A: fall back to non-centred for the entire model (conservative, simple)
- Option B: merge the thin slice into the aggregate (lose slice-level inference but avoid numerical problems)
- Option C: use adaptive per-slice (3.1 above)

This gate could live in the compiler's `build_model()` phase, where slice metadata is already available.

### 3.4 Stronger Priors on Thin Slices

Instead of changing parameterisation, tighten the hierarchical prior for thin slices so the model borrows more aggressively from the base rate. E.g. use an informative `tau_slice` prior that shrinks toward zero when data is sparse. This works within the centred parameterisation but requires careful calibration to avoid over-shrinkage.

---

## 4. Existing Evidence and Gaps

**What we know**:
- Centred is clearly superior for well-observed slices (hundreds of obs per edge per slice)
- Non-centred exhibits funnel geometry problems precisely when slices are data-rich
- Per-slice onset recovery is already weak even on generous data — sparsity will likely make this worse
- The Phase C test infrastructure gaps (listed in CLAUDE.md) overlap with what's needed here: contexted/sliced evidence builders, per-slice extraction, MECE aggregation tests

**What we don't know**:
- The crossover point: at what effective sample size does centred start degrading?
- Whether the degradation is graceful (slightly wider posteriors) or catastrophic (divergences, chain stalling)
- Whether production data is actually sparse enough to matter — real traffic patterns may cluster above or below the crossover
- How adaptive per-slice parameterisation interacts with the NUTS sampler's global adaptation (mass matrix is shared across all parameters)

---

## 5. Recommended Sequence

1. **Implement sparsity layer** in `synth_gen.py` (section 2.2). Three parameters (`frame_drop_rate`, `toggle_rate`, `initial_absent_pct`), one injection point in the emission loop. Small, self-contained change.
2. **Build the sweep wrapper** (`scripts/sparsity-sweep.py`, section 2.3). Its job is narrow: generate truth YAML variants with sampled sparsity parameters, bootstrap each via `synth_gen.py --write-files`, then invoke `param_recovery.py` twice per variant (centred vs non-centred). All fitting, audit, and scoring uses the existing `run_regression.py` → `param_recovery.py` → `test_harness.py` toolchain — the wrapper only generates inputs and collates the nine-layer audit output.
3. **Run the sweep** (20–50 draws, `--max-parallel 1`, `python3 -u`). This answers the core question: does centred degrade on sparse data, where is the crossover, and is the degradation graceful or catastrophic? Monitor via incremental summary and per-graph harness logs at `/tmp/bayes_harness-{job_label}.log`.
4. **If a crossover exists**: implement adaptive per-slice parameterisation (section 3.1), calibrate the threshold from the sweep results, and re-run to confirm.
5. **If centred is uniformly robust**: ship as default with a monitoring gate that warns when per-slice effective n is unusually low.

Steps 1–3 are the minimum viable investigation. Steps 4–5 are conditional on the findings.

---

## 6. Links

- Phase C slice pooling design: doc 14
- Latency dispersion and centred parameterisation: doc 34 (sections 11.8–11.11)
- Regression baseline: doc 34a
- Handover (14-Apr-26): `docs/current/handover/14-Apr-26-latency-reparam-centred-slices.md`
- Synthetic data generator: `bayes/synth_gen.py`
- Synthetic test builders: `bayes/tests/synthetic.py`
