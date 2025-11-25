# Phase 1: Implementation Plan

## Overview

This plan breaks Phase 1 into discrete implementation steps with clear deliverables.

**Total estimate:** 9-14 days
**Prerequisite:** Review PHASE_1_DESIGN.md for architecture and API specs

**Key deliverables:**
- Python analytics runner
- Declarative analysis type adaptor
- Basic Analytics sidebar panel
- Deprecation of old path analysis popup

---

## Step 1: Schema Audit (0.5-1 day)

### Goal
Document current graph schema to ensure Python implementation is correct.

### Tasks

- [ ] **1.1** Examine a real graph YAML file from the test suite
- [ ] **1.2** Document node structure:
  - All fields (id, uuid, type, entry, absorbing, case, etc.)
  - Which are required vs optional
  - Data types
- [ ] **1.3** Document edge structure:
  - All fields (id, uuid, from, to, p, conditional_p, cost_gbp, cost_time, case_id, case_variant, etc.)
  - Probability format (p.mean? flat p?)
  - Cost format
- [ ] **1.4** Document case node structure:
  - How case.id relates to edges
  - How variants are stored
- [ ] **1.5** Document conditional_p structure:
  - Array format
  - Condition DSL format
  - How probability overrides work
- [ ] **1.6** Create `SCHEMA_REFERENCE.md` with findings

### Deliverable
`docs/current/project-analysis/SCHEMA_REFERENCE.md`

---

## Step 2: Python Types (0.5 day)

### Goal
Create Pydantic models for request/response.

### Tasks

- [ ] **2.1** Create `lib/runner/__init__.py`
- [ ] **2.2** Create `lib/runner/types.py` with models:
  - `CostResult`
  - `ScenarioParams`
  - `AnalysisRequest`
  - `ScenarioResult`
  - `AnalysisResponse`
- [ ] **2.3** Add validation rules

### Deliverable
Working Pydantic models that match API spec in design doc.

---

## Step 3: Selection Predicates (0.5 day)

### Goal
Implement predicate computation from graph + selection.

### Tasks

- [ ] **3.1** Create `lib/runner/predicates.py`
- [ ] **3.2** Implement `compute_selection_predicates()`:
  - `node_count`
  - `all_absorbing`
  - `has_unique_start`, `start_node`
  - `has_unique_end`, `end_node`
  - `is_sequential`
  - `sorted_nodes`, `intermediate_nodes`
- [ ] **3.3** Write tests `tests/runner/test_predicates.py`:
  - Empty selection
  - Single node
  - Two nodes
  - All end nodes
  - Sequential nodes
  - Non-sequential nodes

### Deliverable
`predicates.py` with full test coverage.

---

## Step 4: Declarative Adaptor (0.5 day)

### Goal
Implement analysis type matching from predicates.

### Tasks

- [ ] **4.1** Create `lib/runner/analysis_types.yaml` with definitions:
  - single_node_path
  - two_node_path
  - end_node_comparison
  - sequential_path
  - constrained_path
  - general_selection
- [ ] **4.2** Create `lib/runner/adaptor.py`:
  - `AnalysisAdaptor` class
  - `match()` method
  - Condition matching logic (exact, gte, lte)
- [ ] **4.3** Write tests `tests/runner/test_adaptor.py`:
  - Each analysis type matches correctly
  - Fallback works
  - Priority order works

### Deliverable
Working adaptor with YAML config and tests.

---

## Step 5: Graph Builder (0.5 day)

### Goal
Convert DagNet graph format to NetworkX.

### Tasks

- [ ] **5.1** Create graph building logic in `analyzer.py`:
  - Handle uuid vs id
  - Handle from/to vs source/target
  - Copy all node/edge attributes
- [ ] **5.2** Handle edge probability extraction:
  - Base probability (p.mean or p)
  - Case variant probabilities
  - Conditional probabilities
- [ ] **5.3** Write tests with real graph fixtures

### Deliverable
Reliable graph conversion that handles schema variations.

---

## Step 6: Path Analysis Runner (2-3 days)

### Goal
Implement core path probability calculation.

### Tasks

- [ ] **6.1** Create `lib/runner/path_analysis.py`
- [ ] **6.2** Implement `PathRunner` class:
  - DFS probability calculation with memoization
  - Cost aggregation
  - Handling of what-if overrides
- [ ] **6.3** Create `lib/runner/graph_pruning.py`:
  - Sibling group identification
  - Edge pruning for intermediate nodes
  - Renormalization factor calculation
- [ ] **6.4** Implement different entry points:
  - Single node (from graph start)
  - Two nodes (direct path)
  - Multi-node with pruning
- [ ] **6.5** Write comprehensive tests:
  - Simple linear graph
  - Branching graph
  - Graph with cycles
  - Graph with case nodes
  - Graph with conditional probabilities
  - Pruning scenarios
  - Cost calculations

### Deliverable
Working path runner with pruning, tested against expected results.

---

## Step 7: Other Runners (1 day)

### Goal
Implement remaining analysis type runners.

### Tasks

- [ ] **7.1** Implement `EndComparisonRunner`:
  - Calculate path to each end node from start
  - Return sorted by probability
- [ ] **7.2** Implement `GeneralStatsRunner`:
  - Count internal/incoming/outgoing edges
  - Sum probabilities
  - Aggregate costs
- [ ] **7.3** Write tests for each runner

### Deliverable
All 6 analysis types working.

---

## Step 8: Main Analyzer (0.5 day)

### Goal
Wire everything together in main entry point.

### Tasks

- [ ] **8.1** Create `lib/runner/analyzer.py`:
  - `GraphAnalyzer` class
  - `analyze()` method
  - DSL parsing integration
  - Predicate computation
  - Adaptor matching
  - Runner dispatch
  - Multi-scenario handling
- [ ] **8.2** Integration tests:
  - End-to-end request/response
  - Multiple scenarios
  - Error handling

### Deliverable
Complete analyzer that handles full request/response cycle.

---

## Step 9: API Endpoint (0.5 day)

### Goal
Create HTTP endpoint for analyzer.

### Tasks

- [ ] **9.1** Create `api/runner/analyze.py`:
  - Vercel serverless handler format
  - Request parsing
  - Error handling
  - Response formatting
- [ ] **9.2** Update `dev-server.py`:
  - Add `/api/runner/analyze` route
  - Test locally
- [ ] **9.3** Test via curl/Postman

### Deliverable
Working endpoint at `/api/runner/analyze`.

---

## Step 10: TypeScript Client (0.5 day)

### Goal
Extend TS client to call new endpoint.

### Tasks

- [ ] **10.1** Add types to `graphComputeClient.ts`:
  - `ScenarioParams`
  - `AnalysisRequest`
  - `ScenarioResult`
  - `AnalysisResponse`
- [ ] **10.2** Add `analyzeSelection()` method
- [ ] **10.3** Add error handling

### Deliverable
TS client can call Python runner.

---

## Step 11: DSL Construction (0.5 day)

### Goal
Implement DSL construction from node selection.

### Tasks

- [ ] **11.1** Create helper function `constructQueryDSL()`:
  - Compute predicates locally
  - Generate appropriate DSL string
  - Handle all selection patterns
- [ ] **11.2** Add to appropriate location (GraphCanvas or utility file)
- [ ] **11.3** Test with various selections

### Deliverable
Selection → DSL conversion working.

---

## Step 12: Analytics Panel (1 day)

### Goal
Create basic Analytics sidebar panel for testing and user interaction.

### Tasks

- [ ] **12.1** Create `components/panels/AnalyticsPanel.tsx`:
  - DSL query input (editable textarea)
  - Analysis type dropdown (available types for selection)
  - "Run Analysis" button
  - Results display (pretty-printed JSON)
- [ ] **12.2** Create `components/panels/AnalyticsPanel.css`:
  - Match existing panel styling
- [ ] **12.3** Wire selection → auto-generate DSL:
  - Hook into selected nodes
  - Call `constructQueryDSL()`
  - Populate textarea (user can edit)
- [ ] **12.4** Wire "Run Analysis" to Python:
  - Call `graphComputeClient.analyzeSelection()`
  - Display results
  - Handle loading/error states
- [ ] **12.5** Add to sidebar layout:
  - Add to `GRAPH_PANELS` in `graphSidebarLayout.ts`
  - Test panel appears and functions

### Deliverable
Working Analytics panel in sidebar.

---

## Step 13: Validation (1-2 days)

### Goal
Ensure Python results are correct.

### Tasks

- [ ] **13.1** Create validation test suite:
  - Known graphs with expected results
  - Compare Python vs manual calculation
- [ ] **13.2** Compare with TS implementation:
  - Log both results
  - Identify discrepancies
  - Determine which is correct
- [ ] **13.3** Document any intentional differences
- [ ] **13.4** Fix bugs discovered

### Deliverable
Validated, correct implementation.

---

## Step 14: Cleanup & Deprecation (1 day)

### Goal
Remove old inline code and deprecated path analysis popup.

### Tasks

- [ ] **14.1** Remove from `GraphCanvas.tsx`:
  - `calculateSelectionAnalysis()` function (~585 lines)
  - `findPathThroughIntermediates()` helper
  - `computeGlobalPruning()` helper
  - `analysis` state variable
  - `<Panel position="bottom-left">` rendering block (~200 lines)
  - All path analysis related imports
- [ ] **14.2** Remove from `GraphEditor.tsx`:
  - Any path analysis related code
- [ ] **14.3** Update any components that referenced old path analysis:
  - Check for any event handlers
  - Check for any state dependencies
- [ ] **14.4** Verify no regressions:
  - Test all graph editing still works
  - Test Analytics panel is the only analysis UI
- [ ] **14.5** Update documentation:
  - Remove references to old path analysis popup
  - Update keyboard shortcuts if any

### Deliverable
- Clean codebase with Python as single source of truth
- Analytics panel is the only analysis UI
- ~800+ lines removed from GraphCanvas.tsx

---

## Implementation Order

```
Week 1:
├── Step 1: Schema Audit (Day 1)
├── Step 2: Python Types (Day 1)
├── Step 3: Selection Predicates (Day 2)
├── Step 4: Declarative Adaptor (Day 2)
├── Step 5: Graph Builder (Day 3)
└── Step 6: Path Analysis Runner (Days 3-5)

Week 2:
├── Step 7: Other Runners (Day 6)
├── Step 8: Main Analyzer (Day 6)
├── Step 9: API Endpoint (Day 7)
├── Step 10: TypeScript Client (Day 7)
├── Step 11: DSL Construction (Day 8)
├── Step 12: Analytics Panel (Day 8-9)
├── Step 13: Validation (Days 9-10)
└── Step 14: Cleanup & Deprecation (Day 10-11)
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Schema drift discovered | Extra time budgeted in Step 6 |
| Complex edge cases | Comprehensive test suite |
| TS/Python discrepancy | Validation step with manual verification |
| Performance issues | Benchmark early, optimize if needed |

---

## Definition of Done

Phase 1 is complete when:

- [ ] All 14 steps completed
- [ ] All tests passing (Python + TS)
- [ ] GraphCanvas uses Python runner for all analysis
- [ ] Inline analysis code removed from GraphCanvas
- [ ] Multi-scenario analysis working
- [ ] Documentation updated

---

*Phase 1 Implementation Plan*
*Created: 2025-11-25*

