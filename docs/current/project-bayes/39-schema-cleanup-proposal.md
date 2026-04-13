# 39 — Edge Schema Cleanup Proposal

**Date**: 13-Apr-26
**Status**: Proposal — for review before implementation
**Blocks**: forecast engine work (doc 29) depends on clean schema

---

## Motivation

The edge probability schema (`ProbabilityParam` + `LatencyConfig`)
has grown organically across ~5 months of LAG, Bayes, and forecast
work. Before v2.0 sets the schema in stone, we should clean up:

1. Inconsistent naming (`mu`/`sigma` are promoted but lack
   `promoted_` prefix; `completeness` is a bare number but needs
   `{ value, stdev }`)
2. Flat field sprawl on `LatencyConfig` (30+ fields at one level)
3. The `promoted_*` fields duplicate what's in `model_vars[]` —
   the promotion step copies winning values to flat fields for
   consumption. This is architecturally correct (doc 19) but the
   field naming is inconsistent.

---

## Current Schema Audit

### `ProbabilityParam` (edge.p)

| Field | Category | Notes |
|-------|----------|-------|
| `mean`, `stdev` | **Value** | The blended F+E probability and its uncertainty. Written by topo pass blend. |
| `mean_overridden`, `stdev_overridden` | **Config** | User override flags. |
| `distribution`, `distribution_overridden` | **Config** | Prior distribution shape. |
| `id` | **Config** | FK to parameter file. |
| `connection`, `connection_overridden`, `connection_string` | **Config** | Data source connection. |
| `data_source` | **Provenance** | Retrieval metadata. |
| `evidence` | **Evidence** | Observed data: n, k, mean, stdev, scope, retrieval info. |
| `forecast` | **Forecast** | Model prediction: mean, stdev, k. |
| `latency` | **Latency** | Entire latency model sub-block (see below). |
| `posterior` | **Posterior** | Bayesian probability posterior (alpha, beta, HDI, quality). |
| `model_vars` | **Model provenance** | Per-source candidate models. |
| `model_source_preference`, `_overridden` | **Config** | Which source to promote. |
| `n` | **Derived** | Forecast population (inbound-n). Query-time. |

**Issues**: none major at this level. The categories are clear.
`mean`/`stdev` at the top level being the blended F+E result is
reasonable — it's the "default" display value.

### `LatencyConfig` (edge.p.latency)

| Field | Category | Issue |
|-------|----------|-------|
| `latency_parameter`, `_overridden` | Config | Fine. |
| `anchor_node_id`, `_overridden` | Config | Fine. |
| `t95`, `_overridden` | Config (input constraint) | Fine — user-configured upper bound. |
| `path_t95`, `_overridden` | Config (input constraint) | Fine — user-configured upper bound. |
| `promoted_t95` | Promoted | Fine — output from winning model, separate from input constraint. |
| `promoted_path_t95` | Promoted | Fine. |
| `promoted_onset_delta_days` | Promoted | Fine. |
| `onset_delta_days`, `_overridden` | Config (input) | Fine — user-configured or aggregated from slices. |
| `promoted_mu_sd` | Promoted | **Naming**: why `promoted_mu_sd` not `promoted_mu.sd`? Because `mu` itself isn't an object. Flat naming is the only option given `mu` is a bare number. Acceptable. |
| `promoted_sigma_sd` | Promoted | Same. |
| `promoted_onset_sd` | Promoted | Same. |
| `promoted_onset_mu_corr` | Promoted | Same. |
| `promoted_path_mu_sd` | Promoted | Same. |
| `promoted_path_sigma_sd` | Promoted | Same. |
| `promoted_path_onset_sd` | Promoted | Same. |
| `median_lag_days` | Computed (display) | Fine. |
| `mean_lag_days` | Computed (display) | Fine. |
| `completeness` | Computed (display) | **Needs stdev.** Currently bare number. Should be `{ value, stdev? }`. |
| `mu` | Computed/Promoted | **Naming inconsistency.** Written by `applyPromotion` but lacks `promoted_` prefix. No user-input `mu` exists, so no circularity — but it's confusing that `t95` has `promoted_t95` while `mu` is just `mu`. |
| `sigma` | Computed/Promoted | Same issue as `mu`. |
| `path_mu` | Computed/Promoted | Same. |
| `path_sigma` | Computed/Promoted | Same. |
| `path_onset_delta_days` | Computed/Promoted | Same. |
| `posterior` | Posterior | Projected latency posterior (from file cascade). |

**30 fields** on one flat interface. Categories are mixed.

### `ModelVarsLatency` (inside model_vars[].latency)

| Field | Notes |
|-------|-------|
| `mu`, `sigma`, `t95`, `onset_delta_days` | Edge-level. Per-source. |
| `path_mu`, `path_sigma`, `path_t95`, `path_onset_delta_days` | Path-level. Per-source. |
| `mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr` | Edge-level dispersions. Per-source. |
| `path_mu_sd`, `path_sigma_sd`, `path_onset_sd` | Path-level dispersions. Per-source. |

This is the canonical per-source storage. `applyPromotion` copies
the winning entry's values to `LatencyConfig` flat fields.

---

## Issues to Fix

### 1. `completeness` needs `{ value, stdev }`

Currently: `completeness?: number`

Proposed: `completeness?: { value: number; stdev?: number }`

This follows the `{ mean, stdev }` pattern already used by
`Evidence`, `ProbabilityParam`, `forecast`, and
`ModelVarsProbability`. The field name is `value` not `mean`
because completeness is a maturity fraction, not a probability mean.

**Impact**: 29 TS files read `latency.completeness` as a number.
All need updating to read `.value` (or via a helper).

### 2. `mu` / `sigma` naming inconsistency

`mu` and `sigma` on `LatencyConfig` are written by `applyPromotion`
(the winning model's values) but don't carry the `promoted_` prefix.
Meanwhile `t95` has both `t95` (user input) and `promoted_t95`
(model output).

The difference: `t95` has a user-editable input variant (the
constraint), so the promoted output needs a separate field to avoid
circularity. `mu` and `sigma` have no user-editable input — they're
purely model-derived. So the `promoted_` prefix isn't needed for
circularity avoidance.

However, it's confusing to have `promoted_mu_sd` sitting next to
`mu` when both are written by the same promotion step.

**Options**:

A. **Leave as-is.** `mu`/`sigma` don't need `promoted_` because
   there's no user input to conflict with. Accept the naming
   asymmetry. Document it.

B. **Add `promoted_mu` / `promoted_sigma`.** Write promoted values
   to `promoted_mu` / `promoted_sigma`. Leave `mu` / `sigma` as
   whatever the topo pass computes (may differ from promoted if a
   different source wins). This is the `t95` pattern.

C. **Remove the bare `mu` / `sigma` entirely.** Consumers read from
   `model_vars` via the resolver, or from the `promoted_*` fields.
   The bare fields are a legacy convenience.

**Recommendation**: **Option A.** The asymmetry is defensible (doc
19) and changing it touches many files for low benefit. Document the
rationale in the type comments.

### 3. Flat field sprawl

30 fields on `LatencyConfig` is a lot but they fall into clear
categories. Sub-grouping into nested objects would reduce the count
at the top level but would break every consumer.

**Options**:

A. **Leave flat.** 30 fields is manageable. They're well-categorised
   by comments. The cost of restructuring (touching every consumer)
   outweighs the clarity gain.

B. **Group promoted fields.** Move all `promoted_*` fields into
   `latency.promoted: { t95, path_t95, onset_delta_days, mu_sd, ... }`.
   Reduces top-level count by ~10. Breaking change but contained.

C. **Group computed fields.** Move `mu`, `sigma`, `path_mu` etc.
   into `latency.fit: { mu, sigma, path_mu, path_sigma, ... }`.
   Separates model output from user config.

**Recommendation**: **Option B** — group the `promoted_*` fields.
They're all written by one function (`applyPromotion`) and read by
a small set of consumers. The grouping makes the provenance explicit:
"these are the winning model's values." The migration is mechanical.

This gives:

```
latency: {
  // Config (user-editable)
  latency_parameter, latency_parameter_overridden
  anchor_node_id, anchor_node_id_overridden
  t95, t95_overridden
  path_t95, path_t95_overridden
  onset_delta_days, onset_delta_days_overridden

  // Promoted (from winning model_vars entry)
  promoted: {
    t95, path_t95, onset_delta_days
    mu_sd, sigma_sd, onset_sd, onset_mu_corr
    path_mu_sd, path_sigma_sd, path_onset_sd
  }

  // Computed (by topo pass)
  median_lag_days, mean_lag_days
  completeness: { value, stdev? }
  mu, sigma
  path_mu, path_sigma, path_onset_delta_days

  // Posterior (projected from file)
  posterior: LatencyPosterior
}
```

That's 14 top-level fields + 1 `promoted` sub-object + 1
`completeness` sub-object + 1 `posterior` sub-object. Down from 30
flat fields.

### 4. No new objects for dispersions

The promoted dispersions (`mu_sd`, `sigma_sd`, etc.) live inside
`latency.promoted` — not in a separate "dispersions" object. They
are properties of the promoted model, stored alongside the
promoted model's other outputs. This is correct.

My earlier `ForecastState.dispersions` object was wrong. Those
values already have a home.

---

## Migration Impact

### `completeness` → `{ value, stdev? }`

**29 files** read `latency.completeness`. Pattern for each:

| Current pattern | New pattern |
|----------------|-------------|
| `latency.completeness` | `latency.completeness?.value ?? latency.completeness` (transition) or `latency.completeness.value` (clean) |
| `latency.completeness ?? 1` | `(latency.completeness?.value ?? latency.completeness ?? 1)` (transition) |
| `latency.completeness * 100` | `(latency.completeness?.value ?? 0) * 100` (clean) |

A migration helper can smooth the transition:
```typescript
function getCompleteness(lat?: LatencyConfig): number {
  if (lat?.completeness == null) return 0;
  if (typeof lat.completeness === 'number') return lat.completeness;  // legacy
  return lat.completeness.value;
}
function getCompletenessSd(lat?: LatencyConfig): number | undefined {
  if (lat?.completeness == null || typeof lat.completeness === 'number') return undefined;
  return lat.completeness.stdev;
}
```

During transition, the type is `number | { value: number; stdev?: number }`.
After all consumers are migrated, the `number` variant is removed.

### `promoted_*` → `promoted.{ ... }`

**Writers** (2 locations):
- `modelVarsResolution.ts` `applyPromotion()` (lines 183–189)
- `cli/commands/analyse.ts` (lines 256–262)

**Readers** (3 locations):
- `localAnalysisComputeService.ts` (lines 567–582) — surprise gauge
- `api_handlers.py` `_read_edge_model_params` (lines ~1536–1548) — BE
- `model_resolver.py` `resolve_model_params` (new) — reads promoted SDs

Plus the Python schema (`graph_types.py` lines 72–81).

Contained set of files. Mechanical rename.

---

## Proposed Sequencing

1. **Add `completeness: { value, stdev? }` union type** and migration
   helpers. Update all 29 consumers. Topo pass writes the new shape.
2. **Group `promoted_*` into `promoted` sub-object.** Update writers
   and readers. Update Python schema.
3. **Add `completeness.stdev` computation** to BE topo pass.
4. **Improve `p.stdev` and `p.forecast.stdev`** computation in topo
   pass to incorporate `completeness.stdev`.

Steps 1–2 are schema cleanup (pre-requisite). Steps 3–4 are the
forecast engine improvement (doc 29).

---

## Cross-references

- Doc 19 — promoted fields rationale (circular dependency avoidance)
- Doc 29 — generalised forecast engine (consumes these fields)
- `SCHEMA_AND_TYPE_PARITY.md` — schema parity checklist
- `graph_types.py` — Python mirror of the schema
