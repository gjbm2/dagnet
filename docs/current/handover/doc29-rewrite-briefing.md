# Briefing: Doc 29 Rewrite — Generalised Forecast Engine Design

**Date**: 13-Apr-26
**Context**: The user and a previous agent had a thorough design
discussion about generalising the cohort maturity v2 forecasting logic.
The design is agreed. The task is to update the existing doc 29 with the
new design. The previous agent repeatedly stalled/failed on the file
write.

## What needs to happen

Replace **lines 1–159** of
`docs/current/project-bayes/29-generalised-forecast-engine-design.md`
with the new header section described below. **Lines 160 onwards** (from
`---` then `## Generalised Cohort Maturity (x→y Traversal)`) must be
preserved exactly — that's the Phase A/B material which is already
implemented and accurate.

The file has unicode em dashes (U+2014) and en dashes (U+2013) — a
previous Edit tool call failed because of this. Use Write to replace the
entire file, concatenating the new header with the preserved tail.

A copy of lines 160+ was saved to `/tmp/doc29-tail.md` (658 lines). If
that file still exists, use it. Otherwise re-extract from the original:
`tail -n +160 <original> > /tmp/doc29-tail.md`.

## The new header content (to replace lines 1–159)

The new header must contain these sections in order. Write in the same
prose style as the rest of the doc (technical, specific, no waffle).

### 1. Title and status block

```
# 29 — Generalised Forecast Engine Design

**Date**: 7-Apr-26
**Revised**: 12-Apr-26 — substantial rewrite of the engine design based
on deeper understanding of the pipeline injection point, two-tier FE/BE
delivery, and the structural difference between window and cohort modes.
Phase A material (below) unchanged.
**Status**: Phase A infrastructure substantially implemented (see doc
29c). Generalised forecast engine is design only.
```

### 2. Motivation (keep existing text, one paragraph)

### 3. Consumers section

Three consumers today, each computing forecast/completeness
independently:

1. **Edge display** — reads `edge.p.latency.completeness` from FE/BE
   topo pass. Aggregate CDF: `Σ(n_i × F(age_i)) / Σ(n_i)`.
   Path-anchored override in cohort mode.

2. **Surprise gauge** — FE: ~250 lines in
   `localAnalysisComputeService.ts`. BE: ~400 lines in
   `_compute_surprise_gauge`. Each independently resolves params,
   computes completeness, derives expected rate.

3. **Cohort maturity chart** — v1 (1570 lines) and v2 (1154 lines).
   Full trajectory with MC fan bands, D/C split, IS conditioning,
   upstream carrier hierarchy.

All three need: given a pre-resolved subject (edge + cohort group +
model params), produce completeness, rate, and dispersions — both
unconditioned and conditioned on evidence.

**Key boundary**: the FE resolves contexts, epochs, and slice_keys into
subjects before any of this runs. The forecast engine receives
pre-resolved subjects. It does not know about contexts, DSL, or epoch
planning.

### 4. Two structurally different modes

**Window mode** is simple: x is fixed. Completeness = `CDF_edge(tau)`.
Upstream doesn't matter. Point estimate is
`(mu, sigma, onset, p, tau) → {completeness, rate, dispersions}`.

**Cohort mode** is fundamentally different: x grows over time.
Completeness depends on upstream path maturity �� x_provider, reach,
upstream carrier hierarchy (Tier 1 parametric, Tier 2 empirical, Tier 3
weak prior), IS conditioning on upstream evidence. Can't compute
completeness without modelling upstream arrivals.

The engine has two paths, not one. The abstraction must not hide this.

### 5. ForecastState contract

Per-edge per-subject intermediate representation:

- Identity: edge_id, source, fitted_at, tier ('fe_instant' |
  'be_forecast')
- Model (unconditioned): completeness (0–1 at tau_observed),
  rate_unconditioned, dispersions (p_sd, mu_sd, sigma_sd, onset_sd)
- Evidence-conditioned: rate_conditioned, tau_observed
- Mode metadata: mode ('window' | 'cohort'), path_aware (bool)
- Trajectory (optional, only when consumer requests tau range):
  list of {tau, completeness, rate_unconditioned, rate_conditioned}

Design rules: descriptive not prescriptive (no fan bands, no zones);
unconditioned vs conditioned is first-class; trajectory is optional
(only cohort maturity needs it — surprise gauge and edge cards read
scalars at tau_observed).

Consumer mapping:
- Edge display → reads `completeness`
- Surprise gauge → reads `rate_unconditioned` vs observed → surprise
- Edge cards → reads `completeness`, `rate_conditioned`
- Cohort maturity → reads `trajectory`

### 6. Promoted model resolver (prerequisite)

Both modes need a single resolver. Currently scattered across:
`resolveActiveModelVars` (TS), `_resolve_promoted_source` +
`_read_edge_model_params` (Python), `read_edge_cohort_params`
(cohort-specific), `posteriorSliceResolution.ts`.

Target: one Python-side resolver that accepts edge + model_vars[] +
preference, returns best-available params with provenance (p, latency,
path-level equivalents, quality, which source won). Accepts scope
(edge|path) + temporal_mode (window|cohort) for the resolution
distinction.

### 7. Pipeline injection point

The engine runs inside Stage-2 of the existing fetch pipeline:

```
fetch → persist → sync to graph →
  Stage-2:
    1. LAG fit (unchanged)
    2. Model vars upsert (unchanged)
    3. Promotion (unchanged)
    4. ★ Forecast engine (NEW)
    5. Graph write + render
```

**Two-tier FE/BE delivery** (same pattern as existing topo pass):

1. FE runs immediately — existing aggregate-CDF completeness. Instant.
   ForecastState.tier = 'fe_instant'.
2. BE commissioned in parallel. If returns within ~500ms, replaces FE
   estimate. ForecastState.tier = 'be_forecast'.
3. Late BE results overwrite FE estimate when they arrive. Quality tier
   indicator shows which source is active.

Contract: FE estimate must never be worse than today. BE adds
upstream-aware completeness, promoted model, dispersions,
unconditioned/conditioned split.

**Cohort-mode upstream in Stage-2**: today the upstream carrier only
runs inside `compute_cohort_maturity_rows_v2` (chart-specific). For the
engine to produce proper cohort-mode completeness on every edge after
every fetch, that computation moves into the BE topo pass. Heavier than
today's topo pass but eliminates the divergence between edge-display
completeness and chart completeness.

### 8. Known approximations (unchanged from INDEX.md)

1. Graph-wide x(s,τ) propagation not implemented
2. Y_C heuristic (missing arrival-time convolution)
3. Mixed probability bases in denominator
4. Frontier semantics are consumer-specific

### 9. Sequencing

| Phase | What |
|-------|------|
| 1 | Promoted model resolver |
| 2 | Window-mode ForecastState (inject into BE topo pass) |
| 3 | Cohort-mode ForecastState (upstream carrier in BE topo pass) |
| 4 | Wire surprise gauge (replace ~400 lines with ForecastState read) |
| 5 | Wire edge cards (replace ~500 lines scattered annotation) |
| 6 | Cohort maturity as consumer (shared model resolution, MC stays chart-specific) |
| 7 | Parity and contract tests |

### 10. Test plan

1. FE vs BE ForecastState parity (window mode)
2. Mature-limit convergence (tau→∞, completeness→1, rate→posterior mean)
3. Consumer parity (surprise gauge expected-p = cohort maturity
   unconditioned rate at tau_observed)
4. Cohort-mode edge-display completeness matches chart completeness
5. FE vs BE surprise gauge parity (before retiring FE)

### 11. Superseded material

The original Steps 1–6 (7-Apr-26) are superseded by the above. Wrap
them in a `<details>` block with the full original text preserved.

---

## Then append the preserved tail

Everything from `## Generalised Cohort Maturity (x→y Traversal)`
onwards (line 162 of the original file) must be appended unchanged. This
includes Phase A design, Phase B references, the span kernel algebra,
row builder restructuring, implementation sequence, acceptance criteria,
recommended sequencing, and the cross-cutting doc 36 section.

## Key files to read before starting

- `docs/current/project-bayes/29-generalised-forecast-engine-design.md`
  (the file to modify)
- `/tmp/doc29-tail.md` (preserved tail, if still exists)
- This briefing note

Do not read the entire codebase. The design is agreed. Just write the
file.
