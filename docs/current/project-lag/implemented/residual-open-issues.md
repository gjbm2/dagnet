# Residual Open Issues & Resolutions

**Status:** Active
**Date:** 7-Dec-25
**Synthesised from:** `implementation-open-issues.md`, `issues.md`, `open-issues.md`
**Verified against:** `design.md`, `implementation.md`

---

## 1. OPEN — Require Decision or Work

### 1.1 Amplitude Rate Limits (Per-Cohort Queries)
- **Source:** `issues.md Issue 2`, `open-issues.md`
- **Issue:** Fetching 90 days of per-cohort data might hit Amplitude API limits.
- **Status:** **OPEN — MONITOR**
- **Mitigation identified:** Batching, retention endpoint, aggressive caching of mature cohorts.
- **Plan:** Verify during implementation. Add batching if limits hit.

### 1.2 Mock Amplitude Data Generator
- **Source:** `implementation-open-issues.md §5.1`
- **Issue:** Testing latency inference requires realistic mock `dayFunnels` and `dayMedianTransTimes` data that simulates cohort maturation curves.
- **Status:** **OPEN — IMPLEMENTATION TASK**
- **Plan:** Create mock generator as part of Testing Phase.

---

## 2. RESOLVED — Design & Implementation Coverage Confirmed

### 2.1 Schema & Types

| Issue | Source | Resolution |
|-------|--------|------------|
| Anchor Node Resolution | `impl-open §1.1`, `open GAP-18` | MSMDC computes `anchor_node_id` during query construction. Design §4.7.1, Impl §1.5. |
| Labour Cost Rename | `impl-open §1.2` | Pre-requisite P0 phase. Global search/replace. |
| Unused Param Fields | `impl-open §1.3` | Kept in schema as "stored but not consumed". Rationale: avoid re-fetch. |
| Latency Config / Maturity Days | `open GAP-1`, `impl-open §1.4` | `LatencyConfig` on `ProbabilityParam`. Default 30d. Design §3.1. |
| UpdateManager Mappings | `open GAP-14` | Explicit table in Impl §1.4. Pattern established. |
| Integrity Checks | `open GAP-13` | Standard validation. Sibling warnings in Impl §4.8. |

### 2.2 Query Architecture

| Issue | Source | Resolution |
|-------|--------|------------|
| Cohort vs Window Mode UI | `issues Issue 1`, `open GAP-4` | Toggle in WindowSelector. Design §7.5. |
| DSL Syntax | `open GAP-10/11` | `cohort(start:end)`, `cohort(anchor,start:end)`. Schema 1.1.0. Design §9.2. |
| Dual Slice Retrieval | `open GAP-16` | Logic in Design §4.6, §5.9. |
| Batch Fetch Sorting | `impl-open §1.5` | Topological sort in Impl §3.8. |
| Window/Cohort Handling | `impl-open §2.1` | `buildDslFromEdge.ts` determines mode from edge config. |
| Amplitude Adapter Complexity | `impl-open §2.2` | Refactored to `amplitudeHelpers.ts`. |
| Missing Window Data | `issues Issue 3` | Incremental fetch auto-fetches missing window() data. If cohort-only DSL, implicit baseline window (`W_base` clamped [30d,60d]) constructed. Design §5.2.1, Impl §3.6. |

### 2.3 Data & Inference

| Issue | Source | Resolution |
|-------|--------|------------|
| CDF Fitting | `open "Remaining #1"` | Log-normal fit from median/mean. Design §5.4.1-5.4.2. |
| Formula A Algebra | `open "Remaining #2"` | Full Bayes derivation in Design §5.3. Validated in `open-issues.md`. |
| X-anchored Cohorts | `open "Remaining #3"` | Use `window_data` slice. Design §4.6. |
| Formula A Location | `impl-open §3.2` | `statisticalEnhancementService.ts`. Impl §3.3. |
| Storage Architecture | `impl-open §3.3` | `t95` persisted on `p.latency`; others transient. Design §5.8. |
| Window Aggregation | `open GAP-17` | Service updates in Impl §3.2. |
| In-memory Caching | `impl-open §3.1` | Histograms are ~12 integers/cohort. Negligible. |

### 2.4 UI & Rendering

| Issue | Source | Resolution |
|-------|--------|------------|
| View Toggle / Scenario Visibility | `open GAP-2` | 4-state cycle on Scenario Chip. Design §7.3. |
| Edge Bead | `open GAP-3` | Latency bead with positioning logic. Design §7.4. |
| Tooltips | `open GAP-5` | Append data provenance lines. Design §7.6. |
| Properties Panel | `open GAP-9` | Added to ParameterSection. Design §7.7. |
| Stripe Pattern | `open GAP-8` | 45°, opposite direction. Design §7.1. |
| Scenario Overrides | `open GAP-7` | `GraphParamExtractor` extracts latency fields. Impl §1.1. |
| ReactFlow Perf | `impl-open §4.1` | User confirmed not a concern. |

---

## 3. DEFERRED — Explicitly Out of Scope

| Feature | Design Location | Rationale |
|---------|-----------------|-----------|
| Recency Weighting | Appendix C.1 | Fast-follow. Requires `recency_half_life_days`. |
| Convolution Fallback | Appendix C.2 | Model-heavy. Phase 1+. |
| Weibull Distribution | Appendix C.2 | Alternative parametric family. Low priority. |
| Short-Horizon Histograms | Appendix C.3 | Discrete CDF for fast lags. |
| Bayesian Hierarchical Model | Appendix C.4 | Pool information across edges. |
| Time-Indexed Runner | Appendix C.4 | Multi-edge path timing. Phase 1+. |
| Drift Detection | `open "Remaining #5"` | Future work. |
| Scenario semantics for derived latency | `open "Remaining #4"` | Only needed if derived fields become user-writable. |

---

## 4. Summary

| Category | Count |
|----------|-------|
| **OPEN (needs decision/work)** | 2 |
| **RESOLVED** | 27 |
| **DEFERRED** | 8 |

**Action required before implementation:**
1. **§1.1 Rate Limits** — Monitor during implementation.
2. **§1.2 Mock Data** — Build generator during testing phase.
