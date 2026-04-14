# Handover: Latency Reparameterisation & Centred Slices

**Date**: 14-Apr-26
**Branch**: `feature/snapshot-db-phase0`
**Primary doc**: `docs/current/project-bayes/34-latency-dispersion-background.md` (sections 11.8–11.11)

---

## Objective

Improve the Bayesian compiler's latency parameterisation to eliminate the onset-mu-sigma identifiability ridge that causes poor MCMC sampling. The shifted lognormal `(onset, mu, sigma)` parameters create a three-way surface where parameters trade off while keeping the CDF shape approximately constant. The (m, a, r) quantile reparameterisation decorrelates the sampling coordinates via a bijective transform.

Secondary goal: investigate and fix stochastic Phase 2 (cohort MCMC) pathologies where one chain stalls for 10x+ normal time.

Scope boundaries: this is geometry/parameterisation work only. No changes to the statistical model's semantics, data pipeline, or frontend.

---

## Current State

- **Stage 1 (m, a, r) for uncontexted edges**: DONE. Validated on 4 synth graphs. Feature-flagged as `latency_reparam=true`.
- **Stage 3 per-slice latency variation**: DONE. Per-slice m and r offsets with shared a. Feature-flagged as `latency_reparam_slices=1` (m only) or `=2` (m+r). Centred/non-centred controlled by `centred_latency_slices=true`.
- **Phase 2 gate removed**: DONE. The `and not is_phase2` guard on `use_reparam` was removed (model.py ~line 376). (m, a, r) now runs in both Phase 1 and Phase 2 when `latency_reparam=true`. Phase 2 cohort latency code at ~line 1101 uses the same transform.
- **Centred p slices**: DONE. New `centred_p_slices=true` feature flag added. Samples `logit_p_slice` directly from `Normal(logit_p_base, tau_slice)` instead of `logit_p_base + eps * tau`. Code at model.py ~line 1514.
- **Harness summary line**: DONE. Replaced bare `PASS`/`FAIL` with `COMPLETE total=Xs p1=Xs p2=Xs rhat=X ess=X conv=X% worst_ratio=Xx(edge)`. Code at test_harness.py ~line 1371.
- **Bottom-5 ESS diagnostic**: DONE. Added to inference.py ~line 127. Reports the 5 worst-ESS variable names per phase after sampling.
- **Hunt script**: DONE but timing extraction was fixed mid-session. `scripts/hunt-phase2-pathology.sh` now extracts `sampling_phase2_ms` from structured output. Currently configured for 2000/2000 tune/draws, 300s threshold, 10 attempts. Accepts graph name as `$1`.
- **Incremental regression summary**: DONE. `run_regression.py` writes per-graph results to `/tmp/bayes_regression-{run_id}.summary` as each graph completes.
- **Full regression across all graphs**: NOT STARTED. Was attempted but aborted due to feature flag parsing bug (now fixed) and log loss issues (now mitigated by incremental summary).
- **Systematic comparison across contexted graphs**: IN PROGRESS / BLOCKED. A batch run of 7 contexted graphs was started but only diamond completed before being killed. Diamond's first run hit a Phase 1 stall (one chain crawling at ~1 sample/2s at 54% through, after ~5 min of normal progress). A re-run reached Phase 2 successfully but was accidentally killed by a blanket `pkill` when cleaning up the batch stragglers.

---

## Key Decisions & Rationale

1. **(m, a, r) coordinates**: m=log(t50), a=logit(onset/t50), r=inverse_softplus(Z_95*sigma). Bijective transform. Key identity: mu = m - softplus(a). Chosen over alternatives (quantile triplet, Cox-Reid orthogonalisation, ex-Gaussian) after extensive research documented in doc 34 sections 11.1–11.8. The alternatives were either not bijective, not tractable, or changed the distributional family.

2. **Shared a across slices**: Per-slice a offsets were tried and failed (doc 34 §11.9.1.2). The logit onset fraction is poorly identified per-slice when onset is small relative to t50. Revised to per-slice m and r only, with edge-level a shared across all slices (§11.9.1.3).

3. **Centred > non-centred for strong per-slice data**: Centred parameterisation (sample directly from group distribution) is dramatically better than non-centred (eps × tau) when each context slice has thousands of observations. Centred latency slices gave 20x Phase 1 speedup. Centred p slices eliminated the tau_slice funnel (ESS 203 → 627). This is the standard Bayesian result: non-centred is better for weak data, centred for strong data.

4. **Phase 2 gate removal**: The `and not is_phase2` guard was defensive — added because Phase 2 reparam hadn't been tested. Removed because the transform is bijective and there's no mathematical reason it shouldn't work everywhere. First Phase 2 result was clean (ess=1937, 0 divergences on skip-context).

5. **User corrections**:
   - User explicitly rejected `shared_p_slices` for the pathology hunt — wanted to test without it.
   - User pointed out that "PASS" in the harness summary is meaningless — it only checks "did it finish", not quality or recovery. This led to the summary line rework.
   - User correctly identified that the ESS problem was in Phase 1 (p-slice hierarchy), not Phase 2, and directed the centred p slices experiment.
   - User wanted the hunt script to accept a graph name argument rather than being hardcoded.
   - **User was frustrated by careless process management** — a batch run of all 7 graphs was left running in the background while a second diamond run was launched. When cleaning up, a blanket `pkill -f test_harness` killed the valuable diamond re-run along with the batch stragglers. This is a serious error. **Do not use blanket pkill. Always kill by specific PID.**

---

## Discoveries & Gotchas

- **Phase 1 stall on diamond with reparam is stochastic**: First diamond run with full reparam + centred flags stalled at 54% Phase 1 (one chain crawling). Second run on identical config reached Phase 2 successfully. This is the same stochastic pathology pattern seen earlier with Phase 2 — sometimes one chain hits a bad region.

- **The ESS bottleneck with reparam was NOT latency**: When reparam was enabled, the headline ESS dropped from 660 to 67-203. The bottom-5 ESS diagnostic revealed the bottleneck was `tau_slice` (probability hierarchy scale), not any latency variable. Latency ESS values were healthy (363-1257). Adding centred p slices fixed it.

- **PyTensor `BUG IN FGRAPH.REPLACE` warnings are harmless**: Every run on contexted graphs emits many `Cannot convert Type Vector(bool, shape=(...))` errors from pytensor graph rewriting. These are optimiser warnings, not crashes. They appear on baseline runs too.

- **Hunt script timing extraction was broken**: The original script grepped for `Phase 2.*elapsed` but the actual log format uses `sampling_phase2_ms: Nms` in structured output and progress lines like "Sampling — 40 seconds remaining". Fixed to parse `sampling_phase2_ms`.

- **Phase 2 pathology not reproducible at low sample counts**: 40+ attempts across 3 graphs (skip-context, diamond-context, mirror-4step-context) at 1000 tune / 500 draws / 2 chains found no Phase 2 stall. The pathology may only manifest at 2000+ tune/draws, or may depend on specific Phase 1 posterior realisations.

- **Feature flag parser only accepted booleans**: `latency_reparam_slices=2` was rejected by the harness. Fixed in test_harness.py ~line 475 to accept int/float via try/except.

---

## Relevant Files

**Core model code**:
- `bayes/compiler/model.py` — all parameterisation changes. Key sections: feature flags (~366), onset deferral (~430), (m,a,r) Phase 1 (~826), Phase 2 cohort latency (~1101), per-slice hierarchy (~1383), centred p slices (~1514)
- `bayes/compiler/inference.py` — bottom-5 ESS diagnostic (~127), corr(m,a,r) extraction (~1250), per-slice sigma/onset extraction (~1055)

**Harness and diagnostics**:
- `bayes/test_harness.py` — summary line rework (~1371), feature flag parser (~475), stdout tee (~930)
- `bayes/run_regression.py` — incremental summary (~618)
- `bayes/param_recovery.py` — reparam diagnostics parsing (~410)
- `scripts/hunt-phase2-pathology.sh` — Phase 2 pathology hunt script
- `scripts/run-reparam-regression.sh` — 3-config regression wrapper

**Documentation**:
- `docs/current/project-bayes/34-latency-dispersion-background.md` — primary design doc. Sections 11.8-11.11 are the active work area.
- `docs/current/project-bayes/34a-reparam-regression-baseline.md` — baseline regression results (Config A)

**Test infrastructure**:
- `bayes/tests/synthetic.py` — synthetic builders. **Known gap**: no builders for contexted/sliced evidence. This is flagged in CLAUDE.md but has not been addressed.

---

## Next Steps

1. **Re-run synth-diamond-context with reparam + centred lat + centred p** (1000/1000/2ch). The previous run reached Phase 2 successfully but was killed. Need to confirm it completes and capture the full diagnostics. Run as a single foreground process, not in a batch.

2. **Run each remaining contexted graph individually** — synth-lattice-context, synth-3way-join-context, synth-mirror-4step-context, synth-join-branch-context, synth-fanout-context, synth-simple-abc-context. Same config: `--feature latency_reparam=true --feature centred_latency_slices=true --feature centred_p_slices=true`. Run one at a time. Record the summary line and bottom-5 ESS for each.

3. **Build a comparison table** in doc 34 — baseline (no reparam, centred lat + centred p) vs reparam (all three flags) across all contexted graphs. Key metrics: p1 time, p2 time, rhat, ess, conv%, worst recovery ratio. The synth-skip-context row already exists (§11.11.12).

4. **Investigate the stochastic Phase 1 stall on diamond** — if it recurs, capture the trace and identify which RV/chain is stuck. The bottom-5 ESS diagnostic will help. May need to dump the partial trace or add per-chain progress reporting.

5. **Full regression** — once individual graph results are clean, run `scripts/run-reparam-regression.sh` with 3 configs (A=baseline, B=reparam slices=2, C=reparam slices=1) at 2000/2000/4ch. Use `--max-parallel 1` (JAX cannot run multiple graphs concurrently). The incremental summary in run_regression.py now captures results per-graph.

6. **Test infrastructure gap** — synthetic builders in `bayes/tests/synthetic.py` do not cover contexted/sliced evidence. This means the centred p/latency slice code paths have no fast test. Building a contexted synthetic builder is overdue.

---

## Open Questions

- **Why does Phase 1 stochastically stall on diamond with reparam?** One chain hits a bad region and crawls. It happened on first run but not second. Is this the (m, a, r) geometry interacting badly with the branch group (Dirichlet)? Or just the larger model (6 edges × 3 slices × 3 latency RVs)? **Blocking** for deciding whether reparam is viable as default for heavy graphs.

- **Should centred p slices be the default?** It clearly helps when per-slice data is strong (synth graphs). But real graphs may have slices with fewer observations where non-centred is better. **Non-blocking** — can be decided after regression results.

- **Phase 2 pathology**: still not reproduced despite 40+ attempts. May need 2000+ tune/draws or a specific graph topology. The hunt script is ready but hasn't caught anything yet. **Non-blocking** — separate from the reparam work.

- **Is the `worst_ratio` metric in the summary sufficient for recovery assessment?** It only compares aggregate window() p against analytic. Doesn't capture latency recovery or per-slice recovery. May want worst truth z-score instead (the code for it exists in the summary block but is only populated for synth graphs with truth files). **Non-blocking**.
