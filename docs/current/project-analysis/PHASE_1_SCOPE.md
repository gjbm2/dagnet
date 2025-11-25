# Phase 1: Scope Assessment

## Nature of Work

**This is NOT a straight port.** The graph schema has evolved and the TS runner may not be fully in step. 

**Work involves:**
1. **Understand** current graph schema (source of truth)
2. **Specify** what correct runner behavior should be
3. **Implement** correct runner in Python
4. **Use TS as reference** but not as canonical truth
5. **Validate** against expected behavior, not just TS parity

---

## Code to Reference (not necessarily copy)

### Library Files (TS)

| File | Lines | Notes |
|------|-------|-------|
| `pathAnalysis.ts` | 888 | Reference for algorithms, may have schema drift |
| `graphPruning.ts` | 261 | Reference for pruning logic |
| `whatIf.ts` | 462 | Reference, but see simpler approach below |
| **Total** | **1,611** | |

### Inline Code to Remove (GraphCanvas.tsx)

| Function | Lines | Notes |
|----------|-------|-------|
| `calculateSelectionAnalysis` | ~585 | Will be replaced by Python call |
| `findPathThroughIntermediates` | ~137 | DFS logic |
| `computeGlobalPruning` | ~91 | Duplicates graphPruning.ts |
| **Total** | **~600** | Lines 3605-4190 |

---

## Two-System Architecture

### The Split

| System | Purpose | Accuracy | What-If |
|--------|---------|----------|---------|
| **TS (Graph Visualizer)** | Edge widths, visual feedback | Approximate (good enough) | Applied in TS for instant UI |
| **Python (Analytics)** | Quantitative analysis, reports | Accurate | Applied as part of computation |

### Why This Split Makes Sense

**Graph visualizer (TS):**
- Needs instant response as user edits
- Edge widths are visual approximation
- "Good enough" accuracy is fine
- What-if overrides applied locally for responsive feel

**Analytics calculations (Python):**
- Will include lag convolutions (future)
- More complex probability products
- Proper statistical computation
- Source of truth for numbers
- Acceptable latency (user requests analysis explicitly)

### Approach

Pass everything to Python runner:

```
Python Runner receives:
├── graph (current schema)
├── scenarios[] (param packs per visible scenario)
├── what_if_overrides (additional overrides on top of scenario)
└── query (DSL string, e.g., "from(x).to(z).visited(y)")

Python Runner returns:
└── analysis results per scenario
```

**Key design decisions (see PHASE_1_DESIGN.md for details):**
- Multi-scenario: Pass param packs per scenario, compare results across scenarios
- DSL query: TS constructs DSL from selection, user can manually edit, then send to Python
- Python parses DSL and executes, enabling user control over query

**Benefits:**
- Clear separation: TS for visuals, Python for analytics
- Python runner is self-contained and authoritative
- No need to keep two implementations in sync
- Foundation for future complexity (lags, convolutions)

---

## Work Breakdown

### 1. Schema Audit

**Before coding:** Document current graph schema
- Node structure (entry, absorbing, case, etc.)
- Edge structure (p, conditional_p, cost_gbp, cost_time, case_id, etc.)
- What-if override structure

**Effort:** 0.5-1 day

### 2. Declarative Adaptor (Selection → Analysis Type)

**Define predicate vocabulary:**
- `node_count` (1, 2, 3+)
- `all_absorbing` (all selected are end nodes)
- `has_unique_start`, `has_unique_end`
- `is_sequential` (direct edges between consecutive)

**Analysis definitions:**
```yaml
analyses:
  - name: single_node
    when: { node_count: 1 }
  - name: path_analysis
    when: { has_unique_start: true, has_unique_end: true }
  - name: end_comparison
    when: { all_absorbing: true, node_count: { gte: 2 } }
  - name: general_stats
    when: {}  # fallback
```

**Flow:** Selection → compute predicates → match analysis → execute

**Effort:** 1 day

### 3. Python Runner Implementation

**Create:**
```
lib/runner/
├── __init__.py
├── types.py           # Pydantic models for request/response
├── analyzer.py        # Main entry point
├── path_analysis.py   # Path probability, DFS, costs
└── graph_pruning.py   # Sibling groups, renormalization
```

**Input model:**
```python
class AnalysisRequest:
    graph: dict                    # Full graph
    selected_node_ids: list[str]   # Query: what to analyze
    param_overrides: dict          # What-if: case overrides, etc.
```

**Effort:** 3-5 days (depends on schema drift discovered)

### 4. API Endpoint

**Create:** `api/runner/analyze.py`

**Effort:** 0.5 day

### 5. TypeScript Client + Wiring

**Extend:** `graphComputeClient.ts`
**Modify:** `GraphCanvas.tsx` to call client

**Effort:** 1-2 days

### 6. Validation

**Test against expected behavior**, not just TS parity.
- May uncover bugs in TS implementation
- Document any intentional divergence

**Effort:** 1-2 days

### 7. Cleanup

**Remove from GraphCanvas.tsx:** ~600 lines of inline analysis code

**Effort:** 0.5 day

---

## Total Effort Estimate

| Task | Effort |
|------|--------|
| Schema audit | 0.5-1 day |
| Declarative adaptor | 1 day |
| Python runner implementation | 3-5 days |
| API endpoint | 0.5 day |
| TS client + wiring | 1-2 days |
| Validation | 1-2 days |
| Cleanup | 0.5 day |
| **Total** | **8-13 days** |

**Note:** Range depends on how much schema drift is discovered.

---

## Questions to Answer During Schema Audit

### Graph Schema
- [ ] Current node structure (all fields)
- [ ] Current edge structure (all fields)
- [ ] How are probabilities stored? (`p.mean`? `p`? other?)
- [ ] How are costs stored? (`cost_gbp.mean`? other?)
- [ ] How do case nodes work? (case_id, case_variant)
- [ ] How do conditional probabilities work? (conditional_p array)

### Selection Modes
- [ ] Are the 6 modes still correct?
- [ ] Any new patterns to support?
- [ ] Any modes that are never used?

### What-If
- [ ] What overrides are possible? (case variants, conditional activation?)
- [ ] How are they currently represented?
- [ ] Simplest way to pass to Python?

---

## Out of Scope (Phase 1)

- Lag convolution
- New analysis types beyond current modes
- Rich analytics visualizations (Phase 2 polish)
- Evidence models
- Forecasting

These remain deferred per the modular design.

---

*Scope Document - Phase 1*
*Created: 2025-11-25*
*Updated: 2025-11-25 - Clarified this is not a straight port*
