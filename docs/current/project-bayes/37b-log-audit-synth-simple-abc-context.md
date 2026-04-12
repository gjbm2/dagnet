# Doc 37b: Line-by-Line Audit of synth-simple-abc-context Harness Log

**Date**: 12-Apr-26
**Graph**: synth-simple-abc-context (2 edges, 3 context slices)
**Run**: 2 chains, 500 draws, 250 tune, latency_dispersion=true

---

## RESULT LOG section (line 285+)

### Environment and setup

| Line | Content | Verdict | Notes |
|------|---------|---------|-------|
| 289 | `DSL: (window(12-Dec-25:21-Mar-26);cohort(12-Dec-25:21-Mar-26))(context(synth-channel))` | ACCURATE | Contexted DSL with both temporal modes |
| 290 | `subjects: 14 snapshot subjects, 6 candidate regimes` | ACCURATE | 14 subjects = 2 edges x (3 ctx window + 3 ctx cohort + 1 bare window) = 14. 6 regimes = 2 edges x 3 (ctx window + ctx cohort + bare fallback). Supplementary hash discovery contributed the extras |
| 291 | `topology: 4 edges, 2 branch groups, anchor=5c6c9fc4…` | **MISLEADING** | Says 4 edges but only 2 have param_ids and data. The other 2 are dropout/join edges. Should distinguish data-bearing vs structural edges |
| 292 | `topo: INFO: join at node 74217413…, 2 inbound paths → 2 alternatives` | ACCURATE | B→C is downstream of a join node (A→B and dropout both lead to B) |

### Snapshot DB query

| Line | Content | Verdict | Notes |
|------|---------|---------|-------|
| 293 | `snapshot: batch query for 6 unique hashes` | ACCURATE | 6 candidate regime hashes queried |
| 294 | `snapshot: baaa2bf7… → 29250 rows` | ACCURATE | Edge a→b, 29250 raw rows from DB |
| 295 | `snapshot: 16876c46… → 29250 rows` | ACCURATE | Edge b→c, 29250 raw rows from DB |
| 296 | `snapshot DB: 14 subjects queried, 58500 rows fetched (2562ms)` | ACCURATE | 14 subjects, 58500 total rows, 2.5s query time |

### Regime selection

| Line | Content | Verdict | Notes |
|------|---------|---------|-------|
| 297 | `regime selection baaa2bf7…: 29250 → 14625 rows` | ACCURATE | Half the rows removed by regime selection — the bare-hash rows are filtered out because context slices are MECE and exhaustive. Only context-qualified rows survive |
| 298 | `regime selection 16876c46…: 29250 → 14625 rows` | ACCURATE | Same for edge b→c |

### Evidence binding

| Line | Content | Verdict | Notes |
|------|---------|---------|-------|
| 299 | `evidence: engorged graph detected (doc 14 §9A)` | ACCURATE | Graph has _bayes_priors on edges from engorge step |
| 300 | `commissioned slices: 6 across 2 edges` | ACCURATE | 3 slices × 2 edges = 6 |
| 301 | `MECE dimensions: ['channel', 'synth-channel']` | **MISLEADING** | Lists 2 dimensions but they're the same dimension — `channel` from graph contexts, `synth-channel` from synth data. Should deduplicate or clarify |
| 302 | `evidence: 2 edges with data, 0 skipped` | ACCURATE | |
| 303 | `evidence: INFO edge baaa2bf7…: regime routing removed 4875 MECE-regime rows from aggregate (§5.7)` | ACCURATE | Aggregate rows removed because slices are exhaustive |
| 304 | `evidence: INFO edge baaa2bf7…: aggregated 14625 context-prefixed rows into bare window()/cohort()` | **MISLEADING** | Says "aggregated into bare" but the aggregate is then suppressed (line 335). The aggregation still happens but only the per-slice data is used. This log line implies the aggregate IS used |
| 305 | `evidence: INFO edge baaa2bf7…: 14625 snapshot rows → window(286 trajs, 14 daily), cohort(0 trajs, 0 daily)` | **MISLEADING** | Reports aggregate trajectory counts. But these get suppressed when slices are exhaustive. The per-slice trajectory counts are not reported at this level |
| 306 | `evidence: INFO edge baaa2bf7…: supplemented 400 daily obs from param file` | ACCURATE | Param file daily observations added for dates not in snapshot |
| 307 | `evidence: slices: baaa2bf7… dim=synth-channel, 3 slices, mece=True, exhaustive=True` | ACCURATE | 3 MECE exhaustive slices |
| 308-312 | (same pattern for edge 16876c46) | Same verdicts as 303-307 | |
| 313 | `evidence: SKIP edge 79f8e354…: no param_id` | ACCURATE | Dropout edge, no parameter |
| 314 | `evidence: SKIP edge 6222d749…: no param_id` | ACCURATE | Join structural edge, no parameter |

### Binding receipt

| Line | Content | Verdict | Notes |
|------|---------|---------|-------|
| 315 | `binding receipt: 2 bound, 0 fallback, 0 skipped, 2 no-subjects, 2 warned, 0 failed` | **MISLEADING** | Says "2 warned" but doesn't explain what the warnings are. The warnings are on lines 316-319 but the summary doesn't indicate severity |
| 316 | `binding baaa2bf7…: verdict=warn, source=snapshot, rows=29250→14625→201040` | **MISLEADING** | `rows=29250→14625→201040` — the third number (201040) is the param file total_n, not a row count. Mixing DB row counts with param file observation counts in one number is confusing |
| 317 | `1 of 3 expected hashes empty` | ACCURATE | One of the 3 candidate hashes (bare fallback) returned 0 rows. The other 2 (contexted) returned data. This is expected when data is all contexted |
| 318 | `binding 16876c46…: verdict=warn, source=snapshot, rows=29250→14625→154580` | Same as 316 | |
| 319 | `1 of 3 expected hashes empty` | Same as 317 | |

### Per-slice row counts (FIXED in this session)

| Line | Content | Verdict | Notes |
|------|---------|---------|-------|
| 320 | `slice baaa2bf7… context(synth-channel:direct): total_n=65310 window=15050 cohort=50260` | ACCURATE | Now correctly counts window trajectories from CohortObservation objects |
| 321 | `slice baaa2bf7… context(synth-channel:email): total_n=55439 window=5179 cohort=50260` | ACCURATE | Email has fewer window observations (lower p → fewer conversions) |
| 322 | `slice baaa2bf7… context(synth-channel:google): total_n=80291 window=30031 cohort=50260` | ACCURATE | Google has more window observations (higher p) |
| 323-325 | (same pattern for edge 16876c46) | ACCURATE | |

### Model summary (Phase 1)

| Line | Content | Verdict | Notes |
|------|---------|---------|-------|
| 327 | `model: 57 free vars, 11 observed` | ACCURATE | 57 free RVs for 2 edges × 3 slices with full latency hierarchy |
| 328 | `model: phase: Phase 1 (window)` | ACCURATE | |
| 329 | `features: latent_latency=True, cohort_latency=True, overdispersion=True, latent_onset=True, window_only=False, latency_dispersion=True` | ACCURATE | All features active |
| 330 | `onset: baaa2bf7… histogram=1.0d (±1.0) → latent (independent) + 95 Amplitude obs` | ACCURATE | Onset from histogram + amplitude observations |
| 331 | `onset: 16876c46… histogram=2.0d (±1.0) → latent (independent) + 95 Amplitude obs` | ACCURATE | |
| 332-334 | Latency and cohort_latency priors | ACCURATE | |
| 335 | `slices: baaa2bf7… exhaustive, aggregate suppressed` | ACCURATE | Aggregate emission skipped because slices cover all data |
| 336-344 | Per-slice latency_dispersion + Potential + endpoint_bb for baaa2bf7 | ACCURATE | 3 slices × (1 Potential + 1 endpoint_bb) = 6 entries. Potential trajectory counts (97, 92, 97) are reasonable |
| 345-354 | Same for 16876c46 | ACCURATE | |
| 355 | `bg bg_5c6c9…: 1 dims, per-slice Multinomials emitted` | ACCURATE | Branch group a→b has per-slice Dirichlet-Multinomial |
| 356 | `bg bg_99f86…: 1 dims, per-slice Multinomials emitted` | ACCURATE | Branch group b→c |

### Model structure

| Line | Content | Verdict | Notes |
|------|---------|---------|-------|
| 361 | `Free RVs: 57` | ACCURATE | |
| 362 | `Deterministics: 49` | ACCURATE | |
| 363 | `Potentials: 6` | ACCURATE | 2 edges × 3 slices = 6 window trajectory Potentials |
| 364 | `Observed RVs: 11` | **INVESTIGATE** | 6 endpoint BBs + 3 daily BBs + 2 onset obs = 11. But where are the per-slice window Binomials (`obs_w_`)? They're absent. The model has NO per-slice window Binomial observed RVs. This means `_emit_window_likelihoods` produced nothing for any slice. The p anchor from simple (n,k) counts is missing — p is constrained only by trajectory Potentials and endpoint BBs |

### Observed RVs detail (from full log)

| Name pattern | Count | Verdict | Notes |
|--------------|-------|---------|-------|
| `endpoint_bb_*` | 6 | ACCURATE | Per-slice endpoint BetaBinomials for mature cohorts |
| `obs_daily_*` | 3 | **INVESTIGATE** | Only 3 daily BBs out of 6 possible (2 edges × 3 slices). The missing 3 slices had insufficient daily observations (< 3 days). But why only 3? Some slices have very few daily observations |
| `onset_obs_*` | 2 | ACCURATE | One per edge |
| `obs_w_*` | 0 | **DEFECT** | Zero per-slice window Binomials. `_emit_window_likelihoods` iterates `ev.window_obs` which is empty for snapshot-sourced per-slice data. The snapshot binding path never creates `WindowObservation` objects — all data goes into `CohortObservation` trajectories. The Binomial p-anchor that the param-file path provides is absent for snapshot-sourced per-slice evidence |

### Sampling

| Line | Content | Verdict | Notes |
|------|---------|---------|-------|
| 529 | `sampling: 364565ms, rhat=1.026, ess=204, divergences=11` | ACCURATE | 6 min sampling. rhat slightly above 1.01 threshold. ESS=204 is low but usable for 2 chains × 500 draws. 11 divergences is concerning — may indicate geometry problems from the onset-mu ridge |

### LOO-ELPD

| Line | Content | Verdict | Notes |
|------|---------|---------|-------|
| 530 | `LOO: 2 edges scored, total ΔELPD=9145.7, worst pareto_k=4.36` | **INVESTIGATE** | pareto_k=4.36 is catastrophically bad (threshold is 0.7). LOO estimates are unreliable. The email slice (line 532) has the worst pareto_k. This suggests the model is a poor fit for the email slice data |
| 531 | `LOO: slice context(synth_channel:direct): ΔELPD=834.6, worst_pareto_k=0.78` | ACCURATE | pareto_k=0.78 is marginal (above 0.7 threshold) but usable |
| 532 | `LOO: slice context(synth_channel:email): ΔELPD=3514.5, worst_pareto_k=4.36` | **DEFECT** | pareto_k=4.36 means LOO-ELPD for this slice is meaningless. The model cannot represent the email slice data well. Likely cause: email has lowest p (truth=0.49 for a→b), fewest observations, most uncertainty |
| 533 | `LOO: slice context(synth_channel:google): ΔELPD=4796.6, worst_pareto_k=0.91` | ACCURATE | Marginal pareto_k but usable |

### Phase 2

| Line | Content | Verdict | Notes |
|------|---------|---------|-------|
| 540 | `Phase 2 model: 7 free vars, 1 observed, 0 potentials` | **DEFECT** | Phase 2 is aggregate-only — no per-slice modelling. 7 free vars = 2 Dirichlets + 2 kappas + cohort latency triple. Only 1 observed RV (aggregate daily BB for first edge). Per-slice cohort data is not used. This is the Phase 2 per-slice collapse documented in journal update 4 |
| 613 | `Phase 2 sampling: 5363ms, rhat=1.006, ess=1223, divergences=0` | ACCURATE | Phase 2 converges well (small model) |

### Inference (posterior extraction)

| Line | Content | Verdict | Notes |
|------|---------|---------|-------|
| 669 | `empirical_kappa baaa2bf7…: insufficient data (0 cohorts after filtering)` | ACCURATE | No mature cohort trajectories available for empirical kappa estimation. Cohort data goes through Phase 2 (aggregate only) |
| 670 | `predictive_p baaa2bf7…: mu_p=0.7651, kappa_mcmc=88.7` | ACCURATE | Predictive p from Phase 1 posterior |
| 671 | `p_slice baaa2bf7… context(synth-channel:direct): 0.7106±0.0836 HDI=[0.5654, 0.8408] kappa=30.6` | ACCURATE | Per-slice posterior. Truth p for direct a→b = 0.700 × 1.0 (no p_mult for direct) = 0.700. Posterior 0.711 is close |
| 672 | `p_slice baaa2bf7… context(synth-channel:email): 0.5461±0.0684 HDI=[0.4418, 0.6634]` | ACCURATE | Truth = 0.700 × 0.70 = 0.490. Posterior 0.546 is within 1 z-score |
| 673 | `p_slice baaa2bf7… context(synth-channel:google): 0.8564±0.1074 HDI=[0.7054, 0.9987]` | ACCURATE | Truth = 0.700 × 1.20 = 0.840. Posterior 0.856 is close. But HDI upper bound 0.9987 is very high — wide uncertainty |
| 674 | `tau_slice baaa2bf7…: 0.675±0.203` | ACCURATE | Cross-slice shrinkage parameter. Not a defect but should not appear in the posterior SUMMARY (fixed — now excluded) |
| 675 | `latency baaa2bf7…: mu=2.295±0.184 (prior=2.300), sigma=0.557±0.050 (prior=0.500)` | ACCURATE | Base latency recovered well. mu truth=2.300, posterior=2.295. sigma truth=0.500, posterior=0.557 |
| 676 | `onset baaa2bf7…: 1.00±0.01 (prior=1.00), corr(onset,mu)=-0.047` | ACCURATE | Onset recovered precisely. Low onset-mu correlation is good (no ridge degeneracy for this edge) |
| 679 | `p_slice 16876c46… context(synth-channel:direct): 0.6139±0.0698` | ACCURATE | Truth = 0.600 × 1.0 = 0.600. Posterior 0.614 is close |
| 680 | `p_slice 16876c46… context(synth-channel:email): 0.5022±0.0502` | ACCURATE | Truth = 0.600 × 0.65 = 0.390. Posterior 0.502 is 2.2 z-scores away — borderline. Email slice has least data |
| 681 | `p_slice 16876c46… context(synth-channel:google): 0.6976±0.0821` | ACCURATE | Truth = 0.600 × 1.15 = 0.690. Posterior 0.698 is very close |
| 683 | `latency 16876c46…: mu=2.594±0.246 (prior=2.500), sigma=0.659±0.073 (prior=0.600)` | ACCURATE | Base latency recovered. mu truth=2.500, posterior=2.594 |
| 684 | `onset 16876c46…: 2.01±0.03 (prior=2.00), corr(onset,mu)=0.022` | ACCURATE | Onset recovered precisely |
| 685 | `cohort_latency 16876c46…: onset=3.1±0.9, mu=3.245±0.286, sigma=0.478±0.109` | ACCURATE | Phase 2 cohort latency (path-composed). Wide uncertainty on onset |

### Posterior summary

| Line | Content | Verdict | Notes |
|------|---------|---------|-------|
| 707-718 | `synth-simple-abc-context-simple-a-to-b` block | ACCURATE | Per-slice posteriors shown. `_tau_slice` no longer appears (fixed). `[pooled-fallback]` provenance on window() is correct — aggregate is a pooled fallback when slices are exhaustive |
| 720-735 | `synth-simple-abc-context-simple-b-to-c` block | **MISLEADING** | Per-slice `.cohort()` entries have identical p to `.window()` entries (e.g., `direct.window(): p=0.6554` and `direct.cohort(): p=0.6554`). This is because Phase 2 is aggregate-only — there are no per-slice cohort posteriors. The cohort entries are copies of the window entries. They should either not appear or be clearly marked as "Phase 2 not per-slice" |

### Analytic comparison

| Line | Content | Verdict | Notes |
|------|---------|---------|-------|
| 736 | `synth-simple-abc-context-simple-a-to-b: analytic=0.768902 (k/n=38645/50260) → bayes=0.8564 (ratio=1.11x)` | **MISLEADING** | Compares aggregate analytic p against the google slice posterior (which is the first non-pooled slice). Should compare against the aggregate/pooled posterior, or compare per-slice analytic vs per-slice bayes |
| 737 | `synth-simple-abc-context-simple-b-to-c: analytic=0.646112 → bayes=0.6525 (ratio=1.01x)` | Same issue | |

---

## Summary of issues found

### DEFECTS (broken behaviour)

1. ~~**No per-slice window Binomials (`obs_w_`)**~~: **Not a defect.** The snapshot binding path uses trajectory Potentials + endpoint BetaBinomials + daily BetaBinomials to constrain p. The `obs_w_` simple Binomials are a param-file-path feature only. The uncontexted snapshot path also has no `obs_w_` and works correctly. An attempt to synthesize `WindowObservation` objects from trajectories (`_synthesize_window_obs`) was reverted because it injected aggregate n/k into per-slice data.

2. **Phase 2 per-slice collapse**: Phase 2 builds an aggregate-only model (7 free vars, 1 observed). Per-slice cohort data is not used. Per-slice cohort posteriors in the summary are copies of window posteriors. (Documented in journal update 4.)

3. **LOO pareto_k=4.36 on email slice**: Model is a catastrophically poor fit for the email context. LOO estimates unreliable. Likely cause: too few observations in the smallest-p slice combined with per-slice latency freedom.

### MISLEADING DIAGNOSTICS — FIXED

4. **Line 291** `4 edges`: Now shows `4 edges (2 with data)` — `worker.py` counts edges with `param_id`.

5. **Line 301** `MECE dimensions: ['channel', 'synth-channel']`: FE-side issue — `computeMeceDimensions` produces duplicate entries for the same dimension. Not fixed in worker (would mask the upstream problem).

6. **Line 304** `aggregated into bare window()/cohort()`: Now appends `(aggregate may be suppressed if slices are exhaustive)`.

7. **Line 305** `14625 snapshot rows → window(286 trajs, 14 daily)`: Now appends `(aggregate + per-context combined)` to clarify these are total counts across all CohortObservation objects, not just the aggregate.

8. **Line 316** `rows=29250→14625→201040`: Now `db_rows=29250→14625 (post-regime), total_n=201040 (observations)` — separates DB row counts from observation counts.

9. **Lines 720-735** Per-slice `.cohort()` entries: Now labelled `[window-copy]` provenance instead of `[bayesian]`. Phase 2 per-slice collapse (#2) is the root cause — these entries are copies of window posteriors because Phase 2 is aggregate-only.

10. **Lines 736-737** Analytic comparison: Now shows provenance `[pooled-fallback]` alongside the Bayes p. Still compares aggregate analytic against base-hierarchy p. The topo pass should produce per-slice priors so each slice gets its own analytic baseline — related to #2 (Phase 2 per-slice collapse extends to the topo pass not being slice-aware).

### RESOLVED

13. **Per-slice window≠cohort counts**: Root cause was TWO bugs: (a) regime selection treated window and cohort contexted hashes as competing candidates, picking window and discarding all cohort rows (journal update 5). (b) `_supplement_from_param_file` injected context-qualified param file entries with aggregate n/k into per-slice evidence. Both fixed. Verified: `window=15050 cohort=15050` for direct on edge a→b.

### FIXED IN THIS SESSION

11. **Per-slice `window=0` diagnostic**: Now correctly counts window trajectories from CohortObservation objects by checking `obs_type` (`worker.py` line 1396).

12. **`_tau_slice` in posterior summary**: Now excluded from rendering (`test_harness.py` line 1191).

14. **Regime selection killed all cohort data**: Window and cohort contexted hashes were separate candidate regimes. Regime selection picked window, discarded cohort. Fixed by grouping window+cohort hashes into one candidate per context key-set (`candidateRegimeService.ts`).

15. **Engorged supplement injected aggregate n into slices**: `_supplement_from_param_file` processed context-qualified param file entries with aggregate n/k values. Fixed by skipping `context(` entries (`evidence.py`).

16. **`_synthesize_window_obs` injected aggregate n into slices**: Attempted fix for obs_w_ absence created synthetic WindowObservations with aggregate denominators. Reverted — the snapshot path correctly uses trajectory Potentials for p constraint without obs_w_ Binomials.
