# Probability Blending Architecture

**Sources**: `docs/current/project-lag/blending-logic-fix.md`, `docs/current/deterministic.md`
**Last reviewed**: 17-Mar-26

---

## 1. The Blending Model

For cohort-mode latency edges, DagNet computes a blended probability (`p.mean`) from three inputs:

| Input | Source | Meaning |
|-------|--------|---------|
| `p.evidence.mean` | Raw observed k/n from cohort query | What we actually measured |
| `p.forecast.mean` | Window-mode baselines with recency weighting | Stable baseline estimate |
| `p.latency.completeness` | Latency model (maturity signal) | How much of the eventual conversions we've seen |

### Regime Behaviour (no discontinuities)

- **Mature** (completeness → 1): `p.mean` converges rapidly to evidence
- **Immature** (low completeness): `p.mean` leans towards forecast, avoids naive k/n÷completeness blow-up
- **No evidence** (n ≈ 0): `p.mean` ≈ forecast

The transition between regimes must be smooth.

### Key Design Constraint

Forecast influence must **decay smoothly to near-zero** as completeness → 1. Forecast is only intended to compensate for:
- Right-censoring from immaturity
- Statistical uncertainty from limited sample size

### Evidence Semantics

`p.evidence.mean` remains raw k/n for interpretability. Any completeness-driven correction is used only for blending and exposed separately for debugging.

---

## 2. Known Defect (Historical)

The previous blend weight was "evidence sample size vs forecast baseline sample size" scaled by completeness. The forecast baseline behaved like an extremely strong prior that didn't decay sufficiently as completeness → 1, causing `p.mean` to stay dominated by forecast even in mature cohorts.

---

## 3. Deterministic Horizons (`t95` / `path_t95`)

### The Determinism Problem

`t95` and `path_t95` must be repeatable given identical inputs. Non-determinism arises from:

- Stage-2 using `new Date()` as reference (wall-clock coupling)
- `p.mean` feeding back into join weighting → `path_t95` → completeness → blend → `p.mean`
- Sequence dependence between boot paths (normal vs live share)

### Determinism Contract

For a given graph topology + authored overrides, effective query DSL, effective slice set, and forecasting settings — `t95`, `path_t95`, completeness, and blended `p.mean` must be identical regardless of execution sequence.

### Policy Decisions (Adopted)

1. **Stage-2 as-of date**: pinned to resolved DSL end date (day resolution), NOT wall-clock `new Date()`
2. **Stage-2 as pure function**: explicit input snapshot contract; no previously computed transient outputs used as inputs
3. **Join weighting basis**: use `p.evidence.mean` (stable, not overwritten by Stage-2), NOT `p.mean` (which Stage-2 overwrites)
4. **Horizon rounding**: keep current 2 d.p. policy (`LATENCY_HORIZON_DECIMAL_PLACES = 2`)
5. **Gated persistence**: only persist horizons when as-of day or slice inputs change

### Downstream Impact

`path_t95` feeds:
- `windowFetchPlannerService.checkStaleness()` — determines which slices need refetching
- `cohortRetrievalHorizon.computeCohortRetrievalHorizon()` — classifies cohorts as missing/stale/stable

Changes to join weighting will change which cohorts are considered mature and therefore change fetch plans.

---

## 4. Key Invariants (Locked by Tests)

- **Join-aware path horizons** use topological arriving mass (product from start), NOT local edge probability — `pathT95JoinWeightedConstraint.test.ts`
- **Completeness must not be polluted by default-injected horizons** — `pathT95CompletenessConstraint.test.ts`
- **Graph/file authority for cohort bounding** — `pathT95GraphIsAuthoritative.cohortBounding.test.ts`

---

## 5. Key Source Locations

- `src/services/fetchDataService.ts` — Stage-2 orchestration (`runStage2EnhancementsAndInboundN`)
- `src/services/statisticalEnhancementService.ts` — `enhanceGraphLatencies()`, join weighting, path horizons
- `src/services/UpdateManager.ts` — `applyBatchLAGValues()`, horizon rounding, graph↔file mappings
- `src/constants/latency.ts` — `LATENCY_HORIZON_DECIMAL_PLACES`
- `src/services/windowFetchPlannerService.ts` — `checkStaleness()`, `getPathT95ForEdge()`
- `src/services/cohortRetrievalHorizon.ts` — cohort bounding
