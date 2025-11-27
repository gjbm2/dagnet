# Analytics Implementation Status & Roadmap

**Last Updated:** 2025-11-27

## Overview

DagNet now has a foundational analytics capability that integrates with the Python compute backend to provide multi-scenario analysis of conversion graphs. The system is production-ready for Phase 1 and beyond.

---

## ✅ Completed (Phase 1 - Core Foundation)

### 1. **Core Infrastructure**
- ✅ `AnalyticsPanel` component with Monaco-based DSL editor
- ✅ Multi-scenario support (compares visible scenarios side-by-side)
- ✅ What-If compositing integration (Current layer respects What-If DSL)
- ✅ Auto-generation of query DSL from node selection
- ✅ Manual override capability for DSL queries
- ✅ Analysis type selector with rich metadata (icons, descriptions, hints)
- ✅ Loading states, error handling, request deduplication
- ✅ Collapsible sections for better UX in narrow panels

### 2. **Backend Integration**
- ✅ `graphComputeClient` with caching and mock mode
- ✅ `/compute/available-analyses` endpoint integration
- ✅ `/compute/analyze-selection` endpoint integration
- ✅ `/compute/analyze-multiple-scenarios` endpoint integration
- ✅ Semantic result schema with dimensions, metrics, hints

### 3. **Analysis Types** (Backend Decides Availability)
Frontend defines 13 analysis types with UI metadata:
- ✅ Graph Overview (no selection)
- ✅ Outcomes from Node (single from())
- ✅ Reach Probability (single to())
- ✅ Path Through Node (single visited())
- ✅ Path Between Nodes (from() + to())
- ✅ Outcome Comparison (2+ absorbing nodes)
- ✅ Branch Comparison (2+ sibling nodes)
- ✅ Multi-Waypoint Path (2+ waypoints)
- ✅ Conversion Funnel (from() + to() + visited())
- ✅ Constrained Path (forced waypoints)
- ✅ Branches from Start (from() + visitedAny())
- ✅ Multi-Outcome Comparison (3+ outcomes)
- ✅ Multi-Branch Comparison (3+ branches)

### 4. **UI Rendering System** (Card-Based)
- ✅ Scenario-primary layout (one card per scenario with metrics)
- ✅ Stage-primary layout (funnels - one card per stage with scenario comparisons)
- ✅ Generic fallback layout (items with primary metric)
- ✅ Scenario color coding (dot indicators, borders)
- ✅ Hierarchical metric display (primary vs secondary)
- ✅ Stage numbering for funnel steps
- ✅ Value formatting (%, currency, numbers)
- ✅ Collapsible Results JSON for debugging

### 5. **Data Flow**
```
Selection Change → Auto-DSL → Get Available Analyses → Select Analysis → 
Build Scenario Graphs → Send to Backend → Parse Semantics → Render Cards
```

---

## 🚧 In Progress / Next Steps

### **Phase 2: Tabular Datasets (CURRENT FOCUS)**

**Goal:** Add table views for 1-2 key analyses to complement the card-based visualization.

#### Priority 1: Conversion Funnel Table
**Use Case:** Show detailed stage-by-stage breakdown with all metrics visible at once.

**Proposed Structure:**
```
Stage | Stage Name      | Scenario A | Scenario B | Scenario C | Δ A→B  | Δ B→C
------|----------------|------------|------------|------------|--------|-------
  1   | Entry          | 10,000     | 10,000     | 10,000     |   0%   |   0%
  2   | Registration   |  7,500 75% |  8,000 80% |  8,200 82% | +6.7%  | +2.5%
  3   | Activation     |  5,250 70% |  6,000 75% |  6,150 75% | +14.3% | +2.5%
  4   | Conversion     |  2,100 40% |  2,700 45% |  2,800 46% | +28.6% | +3.7%
```

**Features:**
- Sortable columns
- Delta columns (percentage change between scenarios)
- Conditional formatting (green/red for +/-)
- Export to CSV
- Hover tooltips for stage definitions

#### Priority 2: Branch Comparison Table
**Use Case:** Compare sibling paths side-by-side with detailed metrics.

**Proposed Structure:**
```
Branch         | Probability | Cost (£) | Cost (time) | Conversion | Count | Scenario
---------------|-------------|----------|-------------|------------|-------|----------
Dashboard View |    65.3%    |  £12.50  |    5 days   |   42.1%    | 6,530 | Current
Coffee Screen  |    24.7%    |  £15.20  |    7 days   |   38.5%    | 2,470 | Current
Manual Mode    |    10.0%    |  £18.75  |   12 days   |   28.2%    | 1,000 | Current
```

**Features:**
- Multi-scenario support (toggle between scenarios)
- Sortable by any metric
- Sparkline charts for probability distribution
- Export to CSV

#### Implementation Plan

**Step 1: Extend Backend Response**
- Backend already returns tabular `data` array
- Add `table` display hint to semantics: `result.semantics.display = 'table'`
- Frontend checks hint and renders table instead of cards

**Step 2: Create `AnalyticsTable` Component**
```typescript
interface AnalyticsTableProps {
  dimensions: Dimension[];
  metrics: Metric[];
  data: any[];
  dimensionValues: Record<string, Record<string, DimensionValue>>;
  scenarioCount: number;
}
```

**Step 3: Add Table Rendering Logic to AnalyticsPanel**
- Check `results.result.semantics.display === 'table'`
- Render `<AnalyticsTable>` instead of cards
- Support CSV export via new button in results header

**Step 4: Add Delta Calculations**
- Frontend computes deltas between scenarios (backend provides raw values)
- Display as `+X%` / `-X%` with color coding

**Estimated Effort:** 12-16 hours (table component + export + testing)

---

### **Phase 3: Charts & Visualizations**

Once tables are working, add chart libraries for:
1. **Sankey Diagrams** (flow visualization for funnels)
2. **Bar Charts** (branch/outcome comparisons)
3. **Line Charts** (multi-scenario trends over time with window aggregation)
4. **Probability Heatmaps** (matrix view for complex branching)

**Recommended Library:** Recharts (React-native, good TypeScript support)

**Estimated Effort:** 20-24 hours (library integration + 2-3 chart types)

---

## 📋 Backlog (Future Enhancements)

### Analytics Features
- [ ] **Time-Series Analysis** - Integrate window aggregation for trend analysis
- [ ] **Cost Analysis** - Show cost_gbp and cost_time breakdowns
- [ ] **Attribution Modeling** - Multi-touch attribution across paths
- [ ] **Cohort Analysis** - Compare cohorts defined by context filters
- [ ] **Statistical Confidence** - Show confidence intervals where Bayesian inference applies
- [ ] **Path Enumeration** - List all paths between nodes with probabilities
- [ ] **Bottleneck Detection** - Automatically identify low-conversion steps
- [ ] **Sensitivity Analysis** - How results change with parameter adjustments

### UX Improvements
- [ ] **Analysis Templates** - Pre-built queries for common analyses
- [ ] **Saved Views** - Persist analysis configurations to graph metadata
- [ ] **Reports** - Generate shareable HTML/PDF reports
- [ ] **Annotations** - Add notes and insights to specific analysis results
- [ ] **Diff Mode** - Visual diff between two analysis runs
- [ ] **Export Formats** - CSV, JSON, Excel, Google Sheets integration

### Performance
- [ ] **Streaming Results** - Show partial results as they compute
- [ ] **Result Pagination** - Handle large result sets (1000+ rows)
- [ ] **Client-Side Aggregation** - Group/pivot results without re-querying backend

---

## Architecture Notes

### Semantic Result Schema
Backend returns results in a semantic structure:
```typescript
{
  analysis_name: string;
  semantics: {
    dimensions: Dimension[];  // What we're grouping by (scenario, stage, node, outcome, branch)
    metrics: Metric[];        // What we're measuring (probability, count, cost, conversion_rate)
    chart?: ChartHint;        // Visualization hints (type, sort, layout)
    display?: 'cards' | 'table' | 'chart';  // Display mode hint
  };
  data: any[];               // Row-based data (one row per combination of dimension values)
  dimension_values: {        // Metadata for dimension values (labels, colors, order)
    [dimId]: { [valueId]: { name, colour, order } }
  };
}
```

This allows **backend flexibility** (can return different structures for different analyses) while **frontend adaptability** (renders based on semantics, not hardcoded logic).

### Multi-Scenario Flow
1. User toggles scenario visibility in legend
2. AnalyticsPanel detects `orderedVisibleScenarios.length > 1`
3. Calls `buildGraphForLayer` for each scenario (applying params + What-If)
4. Sends array of scenario graphs to `/compute/analyze-multiple-scenarios`
5. Backend returns unified result with `scenario` as a dimension
6. Frontend renders with scenario color-coding

---

## Testing Status

### Frontend Tests
- ✅ AnalyticsPanel component rendering
- ✅ DSL auto-generation from selection
- ✅ Override/clear override behavior
- ⏳ Table rendering logic
- ⏳ CSV export functionality

### Integration Tests
- ✅ Mock backend responses
- ✅ Multi-scenario analysis flow
- ⏳ Full end-to-end with Python backend

### Backend Tests (Python)
- ✅ Analysis type matching logic
- ✅ Funnel computation
- ✅ Branch comparison
- ⏳ Graph overview with multiple entry points
- ⏳ Edge case handling (disconnected nodes, cycles)

---

## Known Issues

1. **Stage-First Funnel Layout** - Currently uses scenario-secondary. Consider flipping to stage-primary for better readability (one card per stage).
   - *Mitigation:* Already implemented in card rendering logic (see L549-579 in AnalyticsPanel.tsx)

2. **Large Result Sets** - No pagination yet. May be slow for graphs with 50+ outcomes.
   - *Mitigation:* Backend should limit results or provide pagination API

3. **Complex Queries** - No validation for invalid DSL strings. Backend returns generic error.
   - *Mitigation:* Add frontend DSL validator (future enhancement)

4. **Analysis Caching** - Cache keys don't include scenario params, may return stale results if params change but selection doesn't.
   - *Mitigation:* Include scenario param hash in cache key (future enhancement)

---

## Performance Benchmarks

**Frontend Rendering:**
- Selection change → Auto-DSL: ~10ms
- Get available analyses: ~50-100ms (with cache)
- Build scenario graphs (3 scenarios): ~20-30ms
- Render cards (5 cards): ~5-10ms

**Backend Compute:**
- Simple path (2 nodes): ~100-200ms
- Conversion funnel (5 stages, 3 scenarios): ~300-500ms
- Graph overview (20 nodes, 3 scenarios): ~500-800ms

**Target:** Keep total analysis time < 1s for interactive use.

---

## Next Actions (Prioritized)

1. **[HIGH]** Implement `AnalyticsTable` component for Conversion Funnel analysis
2. **[HIGH]** Add CSV export functionality
3. **[MEDIUM]** Add table view for Branch Comparison analysis
4. **[MEDIUM]** Add backend `display: 'table'` hint to funnel/branch analyses
5. **[LOW]** Investigate Recharts integration for Phase 3
6. **[LOW]** Write integration tests for table rendering

---

## Success Metrics

**Phase 1 (Completed):**
- ✅ All 13 analysis types defined and working
- ✅ Multi-scenario comparison functional
- ✅ Card-based UI rendering data correctly
- ✅ No user-reported bugs in analytics panel

**Phase 2 (Target):**
- 🎯 2 analysis types with table views
- 🎯 CSV export working for tables
- 🎯 Users can compare 3+ scenarios in tabular format
- 🎯 Table sorting and filtering functional

**Phase 3 (Future):**
- 📊 At least 2 chart types implemented
- 📊 Users prefer charts over cards for specific analyses
- 📊 Export to multiple formats (CSV, PNG, PDF)

---

## Documentation References

- **User Guide:** `graph-editor/public/docs/user-guide.md` (needs analytics section)
- **API Reference:** `graph-editor/public/docs/api-reference.md` (needs backend compute API docs)
- **Testing Guide:** `graph-editor/docs/INTEGRATION_TESTING_GUIDE.md`
- **State Management:** `docs/current/STATE_MANAGEMENT_REFERENCE.md`

---

**Contact:** Engineering team
**Last Review:** 2025-11-27


