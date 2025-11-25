# Phase 1: Implementation Plan

## Summary

| Item | Value |
|------|-------|
| **Total effort** | 9-14 days |
| **Prerequisites** | PHASE_1_DESIGN.md reviewed |
| **Files created** | ~15 Python + 3 TS |
| **Files removed** | ~800 lines from GraphCanvas.tsx |

**Key deliverables:**
1. Python analytics runner with path/cost calculation
2. Declarative analysis type adaptor
3. Basic Analytics sidebar panel
4. Deprecation of old path analysis popup

---

## Implementation Steps

### Step 1: Schema Audit (Day 1, 0.5 day)

**Goal:** Document current graph schema before coding.

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 1.1 | Examine real graph YAML from test suite | - |
| 1.2 | Document node fields (id, uuid, type, entry, absorbing, case) | Schema doc |
| 1.3 | Document edge fields (p, conditional_p, cost_gbp, cost_time, case_id) | Schema doc |
| 1.4 | Document case node & variant structure | Schema doc |
| 1.5 | Document conditional_p array format | Schema doc |

**Deliverable:** `docs/current/project-analysis/SCHEMA_REFERENCE.md`

---

### Step 2: DSL Parser Verification (Day 1, 0.5 day)

**Goal:** Ensure Python DSL parser handles required functions.

**Required DSL functions:**
- `from(X)`, `to(X)`, `visited(X,Y,...)` 
- `nodes(X,Y,...)`, `compare(X,Y,...)`, `exclude(X,Y,...)`

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 2.1 | Review existing `lib/query_dsl.py` | Gap analysis |
| 2.2 | Add missing functions if needed | Updated parser |
| 2.3 | Write parser tests for analytics DSL patterns | Tests |

**Deliverable:** DSL parser that handles all patterns in `DSL_CONSTRUCTION_CASES.md`

---

### Step 3: Python Types (Day 1, 0.5 day)

**Goal:** Create Pydantic models for API.

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 3.1 | Create `lib/runner/__init__.py` | Package |
| 3.2 | Create `lib/runner/types.py` | Models |
| 3.3 | Implement: `CostResult`, `ScenarioParams`, `AnalysisRequest`, `ScenarioResult`, `AnalysisResponse` | - |
| 3.4 | Add validation rules | - |

**Deliverable:** Working Pydantic models per PHASE_1_DESIGN.md API spec

---

### Step 4: Selection Predicates (Day 2, 0.5 day)

**Goal:** Compute predicates from graph + selection.

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 4.1 | Create `lib/runner/predicates.py` | Module |
| 4.2 | Implement `compute_selection_predicates()` | Function |
| 4.3 | Handle: node_count, all_absorbing, has_unique_start/end, is_sequential | - |
| 4.4 | Add scenario predicates (from request) | - |
| 4.5 | Write tests: empty, single, two, all_ends, sequential, non-sequential | Tests |

**Deliverable:** `predicates.py` with full test coverage

---

### Step 5: Declarative Adaptor (Day 2, 0.5 day)

**Goal:** Match predicates to analysis type.

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 5.1 | Create `lib/runner/analysis_types.yaml` | Config |
| 5.2 | Define 6 analysis types: single_node, two_node, end_comparison, sequential_path, constrained_path, general_selection | - |
| 5.3 | Create `lib/runner/adaptor.py` | Module |
| 5.4 | Implement `AnalysisAdaptor.match()` with condition operators | - |
| 5.5 | Write tests: each type matches, fallback works, priority order | Tests |

**Deliverable:** Working adaptor with YAML config

---

### Step 6: Graph Builder (Day 3, 0.5 day)

**Goal:** Convert DagNet graph to NetworkX.

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 6.1 | Add `_build_graph()` method to analyzer | Function |
| 6.2 | Handle id/uuid variations | - |
| 6.3 | Handle from/to edge format | - |
| 6.4 | Extract probability (p.mean vs p) | - |
| 6.5 | Extract costs | - |
| 6.6 | Write tests with real graph fixtures | Tests |

**Deliverable:** Reliable graph conversion

---

### Step 7: Path Analysis Runner (Days 3-5, 2-3 days)

**Goal:** Core path probability and cost calculation.

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 7.1 | Create `lib/runner/path_analysis.py` | Module |
| 7.2 | Implement `PathRunner` class | Class |
| 7.3 | DFS probability calculation with memoization | - |
| 7.4 | Cost aggregation (monetary, time) | - |
| 7.5 | What-if override application | - |
| 7.6 | Create `lib/runner/graph_pruning.py` | Module |
| 7.7 | Sibling group identification | - |
| 7.8 | Edge pruning for intermediate nodes | - |
| 7.9 | Renormalization factor calculation | - |
| 7.10 | Write comprehensive tests | Tests |

**Test cases:**
- Simple linear graph
- Branching graph
- Graph with case nodes
- Graph with conditional probabilities
- Pruning scenarios (visited intermediate)
- Cost calculations

**Deliverable:** Working path runner with pruning

---

### Step 8: Other Runners (Day 6, 1 day)

**Goal:** Implement remaining analysis types.

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 8.1 | Implement `EndComparisonRunner` | Class |
| 8.2 | - Path to each end from start | - |
| 8.3 | - Return sorted by probability | - |
| 8.4 | Implement `GeneralStatsRunner` | Class |
| 8.5 | - Count edges (internal/in/out) | - |
| 8.6 | - Sum probabilities, aggregate costs | - |
| 8.7 | Write tests for each runner | Tests |

**Deliverable:** All 6 analysis types working

---

### Step 9: Main Analyzer (Day 6, 0.5 day)

**Goal:** Wire components together.

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 9.1 | Create `lib/runner/analyzer.py` | Module |
| 9.2 | Implement `GraphAnalyzer` class | Class |
| 9.3 | Wire: DSL parsing → predicates → adaptor → runner | - |
| 9.4 | Multi-scenario handling | - |
| 9.5 | Error handling with structured responses | - |
| 9.6 | Integration tests (end-to-end request/response) | Tests |

**Deliverable:** Complete analyzer handling full cycle

---

### Step 10: API Endpoint (Day 7, 0.5 day)

**Goal:** HTTP endpoint for analyzer.

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 10.1 | Create `api/runner/analyze.py` | Endpoint |
| 10.2 | Vercel serverless handler format | - |
| 10.3 | Request parsing, validation | - |
| 10.4 | Error handling (400/422/500) | - |
| 10.5 | Update `dev-server.py` with route | - |
| 10.6 | Test via curl | - |

**Deliverable:** Working endpoint at `/api/runner/analyze`

---

### Step 11: TypeScript Client (Day 7, 0.5 day)

**Goal:** TS client for Python runner.

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 11.1 | Add types to `graphComputeClient.ts` | Types |
| 11.2 | - ScenarioParams, AnalysisRequest | - |
| 11.3 | - ScenarioResult, AnalysisResponse | - |
| 11.4 | Add `analyzeSelection()` method | Method |
| 11.5 | Error handling | - |

**Deliverable:** TS client can call Python runner

---

### Step 12: DSL Construction (Day 8, 0.5 day)

**Goal:** Selection → DSL string conversion.

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 12.1 | Create `lib/analytics/constructQueryDSL.ts` | Module |
| 12.2 | Implement selection predicate computation (TS side) | - |
| 12.3 | Generate DSL per patterns in `DSL_CONSTRUCTION_CASES.md` | - |
| 12.4 | Unit tests for all selection patterns | Tests |

**Deliverable:** Selection → DSL working for all patterns

---

### Step 13: Analytics Panel (Days 8-9, 1 day)

**Goal:** Basic sidebar panel for analytics.

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 13.1 | Create `components/panels/AnalyticsPanel.tsx` | Component |
| 13.2 | Editable DSL query textarea | - |
| 13.3 | Analysis type dropdown | - |
| 13.4 | "Run Analysis" button | - |
| 13.5 | Results display (pretty JSON) | - |
| 13.6 | Create `AnalyticsPanel.css` | Styles |
| 13.7 | Wire selection → auto-generate DSL | - |
| 13.8 | Wire button → Python call | - |
| 13.9 | Add to sidebar layout | - |

**Deliverable:** Working Analytics panel in sidebar

---

### Step 14: Validation (Days 9-10, 1-2 days)

**Goal:** Verify Python results are correct.

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 14.1 | Create validation test suite | Tests |
| 14.2 | Known graphs with hand-calculated results | - |
| 14.3 | Compare Python vs TS (where TS exists) | Report |
| 14.4 | Identify and resolve discrepancies | - |
| 14.5 | Document intentional differences | Doc |

**Deliverable:** Validated, correct implementation

---

### Step 15: Cleanup & Deprecation (Days 10-11, 1 day)

**Goal:** Remove old code, clean up.

**Tasks:**
| # | Task | Output |
|---|------|--------|
| 15.1 | Remove from GraphCanvas.tsx: | - |
| - | `calculateSelectionAnalysis()` (~585 lines) | - |
| - | `findPathThroughIntermediates()` | - |
| - | `computeGlobalPruning()` | - |
| - | `analysis` state variable | - |
| - | Bottom-left Panel (~200 lines) | - |
| 15.2 | Remove from GraphEditor.tsx if any | - |
| 15.3 | Verify no regressions | - |
| 15.4 | Update documentation | - |

**Deliverable:** ~800+ lines removed, Analytics panel is sole analysis UI

---

## Files Created

**Python:**
```
lib/runner/
├── __init__.py
├── types.py
├── predicates.py
├── adaptor.py
├── analyzer.py
├── path_analysis.py
├── graph_pruning.py
└── analysis_types.yaml

api/runner/
└── analyze.py

tests/runner/
├── test_predicates.py
├── test_adaptor.py
├── test_path_analysis.py
└── test_analyzer.py
```

**TypeScript:**
```
src/lib/analytics/
└── constructQueryDSL.ts

src/components/panels/
├── AnalyticsPanel.tsx
└── AnalyticsPanel.css
```

**Docs:**
```
docs/current/project-analysis/
└── SCHEMA_REFERENCE.md
```

---

## Schedule

```
Week 1:
├── Day 1: Schema Audit + DSL Parser + Types (Steps 1-3)
├── Day 2: Predicates + Adaptor (Steps 4-5)
├── Day 3: Graph Builder + Path Runner start (Steps 6-7)
├── Day 4: Path Runner continued (Step 7)
└── Day 5: Path Runner complete (Step 7)

Week 2:
├── Day 6: Other Runners + Main Analyzer (Steps 8-9)
├── Day 7: API Endpoint + TS Client (Steps 10-11)
├── Day 8: DSL Construction + Analytics Panel (Steps 12-13)
├── Day 9: Analytics Panel + Validation start (Steps 13-14)
├── Day 10: Validation + Cleanup start (Steps 14-15)
└── Day 11: Cleanup complete (Step 15) [buffer]
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Schema drift from TS | Extra time in Step 7, manual verification |
| DSL parser incomplete | Step 2 explicitly checks/extends |
| Complex pruning logic | Comprehensive test suite |
| TS/Python discrepancy | Validation step with manual calculation |
| Performance issues | Benchmark early, optimize if needed |

---

## Definition of Done

Phase 1 is complete when:

- [ ] All 15 steps completed
- [ ] All tests passing (Python + TS)
- [ ] Analytics panel works for all selection patterns
- [ ] Multi-scenario analysis working
- [ ] Old path analysis code removed from GraphCanvas
- [ ] Documentation updated

---

## Quick Reference: Test Commands

```bash
# Python tests
cd graph-editor
source venv/bin/activate
pytest tests/runner/ -v

# Run specific test file
pytest tests/runner/test_path_analysis.py -v

# TS tests
npm test

# Manual API test
curl -X POST http://localhost:3001/api/runner/analyze \
  -H "Content-Type: application/json" \
  -d '{"graph": {...}, "query": "from(a).to(b)", "scenarios": []}'
```

---

*Phase 1 Implementation Plan*
*Created: 2025-11-25*
*Updated: 2025-11-25 - Added DSL parser step, clarified schedule*
