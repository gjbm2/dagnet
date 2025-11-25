# Project Analysis: Runner & Analytics Pipeline

## Vision

Evolve the current "path analysis" feature into a robust, extensible analytics system.

**End State** (see `HIGH_LEVEL_THINKING.md`): A fully declarative analytics engine with:
- Schema-driven analysis definitions
- Evidence models (actual/posterior/forecast)
- Uncertainty propagation
- Modular data requirements

**Approach**: Incremental phases that build toward this vision without attempting it all at once.

---

## Current State

### Already Implemented ✅

| Capability | Status |
|------------|--------|
| DSL (`from`, `to`, `visited`, `context`, `case`, `window`, etc.) | ✅ Complete |
| Contexts (context parameters, contextAny) | ✅ Complete |
| Windowing (`window(start:end)`) | ✅ Complete |
| Live data retrieval | ✅ Complete |
| Python compute endpoint | ✅ Exists (suitable for light analytics) |
| Path analysis (TS) | ✅ Works, but logic scattered |
| Selection mode detection | ✅ Exists - simple code-based adaptor |

### Selection Modes (Existing)

The TS codebase already implements multiple analysis types based on selection:

| Selection Pattern | Analysis |
|-------------------|----------|
| Single node | Path from start to node |
| Two nodes (sequence) | Path between nodes |
| All end nodes | End-node comparison |
| Sequential nodes | Path with pruning |
| Parallel nodes | OR-path analysis |
| General selection | Aggregate stats |

This is essentially a **simple, code-based adaptor** - a precursor to the full declarative system. Phase 1 can keep this dispatch logic and have it call Python runners.

### Not Yet Implemented

| Capability | Notes |
|------------|-------|
| Lag convolution | Can be added to runner later |
| Evidence model (actual/posterior/none) | Future enhancement |
| Forecasting / uncertainty bands | Future enhancement |

---

## Architecture: Two Computation Systems

| System | Purpose | Accuracy | What-If |
|--------|---------|----------|---------|
| **TS (Graph Visualizer)** | Edge widths, visual feedback | Approximate (good enough) | Applied in TS for instant UI |
| **Python (Analytics)** | Quantitative analysis | Accurate | Applied as part of computation |

**Why this split:**
- Graph visualizer needs instant response → TS, approximate is fine
- Analytics will include lag convolutions, complex probability products → Python, accuracy matters
- What-if for visuals stays in TS (responsive)
- What-if for analytics passed to Python as param overrides

**Divergence is acceptable:** Edge widths are visual approximation. Analytics panel shows authoritative numbers. Users understand one is "live preview", other is "calculated result".

---

## Phases

### Phase 1: Python Runner + Adaptor + Basic UI ⬅️ **Priority**

**Goal**: Single authoritative runner in Python for analytics, with declarative selection → analysis mapping, and basic Analytics panel.

**Rationale**: 
- Python endpoint already exists and is suitable
- Unifies compute in one place
- Enables NetworkX, better math libraries
- Foundation for all subsequent analytics work
- Adaptor is simple (~1 day) and enables clean architecture from start
- Basic panel enables testing and deprecates old path analysis popup

**Scope**:
- Schema audit (understand current graph structure)
- Declarative adaptor (selection predicates → analysis type matching)
- Python runner (path probability, pruning, costs)
- API endpoint + TS client wiring
- Basic Analytics sidebar panel (DSL input, type dropdown, JSON results)
- Deprecate old path analysis popup from GraphCanvas

**Not in scope** (deferred):
- Lag convolution (add later - modular design enables this)
- New analysis types beyond current modes
- Rich visualizations (Phase 2 polish)

---

### Phase 2: Analytics Panel Polish

**Goal**: Rich UI for analysis results.

**Starting point**: Basic panel from Phase 1 (DSL input, dropdown, JSON output).

**Enhancements**:
- Formatted result displays per analysis type
- Metric cards (probability, cost, time)
- Collapsible detail sections
- Path visualization
- Scenario comparison tables

---

### Phase 3: Analytics Graphing

**Goal**: Visual charts for analysis results.

---

## Sequencing

```
Phase 1: Python Runner + Adaptor ────────────► [PRIORITY - commercial]
         Phase 2: Analytics Panel ──────────────►
                  Phase 3: Charts ─────────────────►
```

---

## Future Capabilities (Post Phase 3)

The modular/declarative design enables these to be added without rearchitecting:

- **Lag convolution**: Add to runner, update analysis types
- **Evidence model**: Extend data requirements, add actual/posterior tracking
- **Forecasting**: Add forecast runner, confidence band output
- **Sensitivity analysis**: New analysis type for parameter selections
- **Scenario comparison**: New analysis type for case node selections

---

## Related Docs

- `HIGH_LEVEL_THINKING.md` - End-state vision for declarative analytics
- [Python Compute Architecture](../archive/PROJECT_CONNECT/CURRENT/PYTHON_GRAPH_COMPUTE_ARCHITECTURE.md)
- [Quick Runner Modes](../../graph-editor/public/docs/QUICK-RUNNER.md)
- [Sidebar Architecture](../../graph-editor/public/docs/SIDEBAR_AND_PANELS_ARCHITECTURE.md)

---

*Created: 2025-11-25*
