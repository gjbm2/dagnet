# Onset Delay: Surfacing and Usage (`onset_delta_days`)

Date: 2-Feb-26

**Scope:** This document covers UI surfacing and statistical usage of `onset_delta_days`. Extraction, aggregation, and storage are part of the core implementation plan (`implementation-plan.md` §0.3).

**Key constraints (see implementation-plan.md for details):**
- Onset is only derived from **window() slices** (cohort() histogram data is unreliable)
- Edge-level onset is **aggregated in the LAG topo pass** via `min()` across window slices
- Precedence: uncontexted window slice > min(contexted window slices)
- No `anchor_onset_delta_days` — window slices have no anchor component

---

## 1. Problem Statement

We currently model edge latency using a standard lognormal distribution. This implicitly assumes conversions can begin immediately at \(t=0\).

In practice, many edges exhibit a **dead-time** where conversions are effectively zero for the first \(d\) days. This causes:

1. **Overstated early completeness**: Lognormal CDF is non-zero at \(t=0\)
2. **Premature evidence weighting**: Blending gives too much weight to structurally right-censored evidence
3. **Downstream propagation**: Small completeness errors compound on deep paths

## 2. Solution: Shifted Lognormal Model

We introduce an **onset delay** \(\delta\) (`onset_delta_days`) representing minimum time before conversions can occur.

### 2.1 Shifted Distribution

Total time-to-conversion: \(T = \delta + X\)

Where:
- \(\delta \ge 0\) is the onset delay (days)
- \(X \sim \text{LogNormal}(\mu, \sigma)\) is post-onset conversion time

### 2.2 Shifted Completeness Formula

```
F(t) = 0                           if t ≤ δ
F(t) = LogNormalCDF(t - δ; μ, σ)   if t > δ
```

Completeness remains exactly 0 during the dead-time, then follows the shifted CDF.

---

## 3. UI Surfacing

### 3.1 Properties Panel (Edge Latency Section)

Display `onset_delta_days` alongside existing latency summary fields:

| Field | Value | Overridden |
|-------|-------|------------|
| Median Lag | 4.2 days | ☐ |
| Mean Lag | 6.8 days | ☐ |
| t95 | 18.5 days | ☑ |
| **Onset Delay** | **2.0 days** | ☐ |

The `_overridden` companion field follows the standard pattern:
- Unchecked: Value derived from Amplitude data, may refresh on pull
- Checked: Manually set by user, persists through data refreshes

### 3.2 Conditional Props (Per-Slice View)

When viewing per-context-slice latency summaries (window slices only — cohort slices don't have reliable onset):

| Slice | Median | Mean | t95 | Onset |
|-------|--------|------|-----|-------|
| window:channel:organic | 3.8 | 5.2 | 15.0 | 1 |
| window:channel:paid | 5.1 | 8.4 | 22.0 | 3 |
| cohort:1-Jan-26 | 4.1 | 6.2 | 17.0 | — |

### 3.3 Edit Behaviour

Standard blur-to-save override pattern:
1. Field displays current value (derived or overridden)
2. User edits value in Properties Panel
3. On blur/confirm: `onset_delta_days_overridden` set to `true`
4. Clear override: checkbox clears, next pull refreshes from Amplitude

---

## 4. Completeness Integration

### 4.1 statisticalEnhancementService.ts Changes

The LAG topo pass (`enhanceGraphLatencies`) already aggregates onset from window slices. Use this aggregated value in completeness calculation:

```typescript
// edgeOnsetDeltaDays is already aggregated earlier in this topo pass
// (min across window slices, precedence: uncontexted > min(contexted))
const delta = edgeOnsetDeltaDays ?? 0;

// Shifted age
const shiftedAge = Math.max(0, effectiveAge - delta);

// Completeness is 0 during dead-time, then shifted CDF
const completeness = shiftedAge > 0 
  ? logNormalCDF(shiftedAge, mu, sigma)
  : 0;
```

### 4.2 Horizon Reconciliation with t95

When `onset_delta_days` is present, horizons apply to total time \(T\), not post-onset time \(X\):

1. Convert `t95` to X-percentile: `x95 = max(ε, t95 - delta)`
2. Apply one-way sigma increase to ensure model-implied percentile meets `x95`
3. Report total horizon as `t95` (including \(\delta\)) for graph-visible values

This preserves "one-way pull only" semantics (never shrink tails).

### 4.3 Blending Impact

Shifted completeness feeds into the blend formula:

```
c_w = completeness^η
n_eff = c_w × p.n
```

With accurate completeness:
- During dead-time: `completeness ≈ 0`, so `n_eff ≈ 0`, blend relies on forecast
- After dead-time: Completeness grows per shifted CDF, evidence gradually dominates

This reduces "sag" in evidence-dominated downstream means caused by miscalibrated maturity.

---

## 5. Files to Modify (Surfacing & Usage Only)

| File | Change |
|------|--------|
| `graph-editor/src/components/PropertiesPanel.tsx` | Display/edit in latency section |
| `graph-editor/src/services/statisticalEnhancementService.ts` | Use aggregated onset in shifted completeness calculation |
| `graph-editor/public/docs/lag-statistics-reference.md` | Document shifted formula |

**Note:** UpdateManager sync and LAG topo pass aggregation are covered in `implementation-plan.md` §0.3.

---

## 6. Test Coverage

| Test | Description |
|------|-------------|
| `onset_delta_overridden.test.ts` | Manual override flow in UI |
| `shifted_completeness.test.ts` | Completeness = 0 during dead-time |
| `shifted_completeness_blend.test.ts` | Evidence weight = 0 when completeness = 0 |
| `horizon_reconciliation.test.ts` | t95 with onset shift |

---

## 7. Related Documents

- `docs/current/project-db/implementation-plan.md` — Extraction and storage (§0.3)
- `docs/current/project-db/snapshot-db-design.md` — Database column definition (§3.2, §3.3)
- `docs/current/project-lag/histogram-fitting.md` — Original shifted lognormal analysis
- `graph-editor/public/docs/lag-statistics-reference.md` — Canonical completeness/blending formulas

---

## 8. Open Questions

1. **Path accumulation**: Should onset delays accumulate along paths, or remain edge-local?
2. **Minimum sample size**: Should V1 derivation require minimum converters before setting non-zero onset?

**Resolved:**
- ~~**Anchor latency**: Should `onset_delta_days` apply to `anchor_latency` as well?~~
  **Answer: No.** Window slices (the only source of reliable onset data) have no anchor component. `anchor_latency` only exists for cohort() queries, which have unreliable histogram data (~10 day limit).
