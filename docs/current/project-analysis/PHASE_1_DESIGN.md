# Phase 1: Detailed Design

## Overview

Phase 1 delivers a Python-based analytics runner with declarative selection → analysis mapping.

---

## Design Requirements

### DR1: Multi-Scenario Support

**Requirement:** Some analytics modes compare results across visible scenarios.

**Design:**
- Pass param packs to Python **per scenario**
- Include separate what-if overrides
- Python runner can compute for multiple scenarios in one call

**API shape:**
```python
class AnalysisRequest:
    graph: dict
    query: str                              # DSL string (e.g., "from(x).to(z).visited(y)")
    scenarios: list[ScenarioParams]         # Param packs per visible scenario
    what_if_overrides: dict | None          # Additional what-if on top of scenario
```

```python
class ScenarioParams:
    scenario_id: str
    name: str
    param_overrides: dict                   # Case overrides, etc.
```

**Response includes per-scenario results:**
```python
class AnalysisResponse:
    analysis_type: str
    results: list[ScenarioResult]           # One per scenario
    
class ScenarioResult:
    scenario_id: str
    probability: float
    expected_costs: CostResult
    # ... other fields per analysis type
```

---

### DR2: DSL-Based Query Interface

**Requirement:** Query is passed as DSL string, not raw node IDs.

**Rationale:**
- User may want to manually edit the query
- Flow: Selection → auto-generate DSL → user can edit → send to Python
- Python parses DSL, does graph pruning, etc.

**Design:**

1. **TS constructs DSL from selection:**
   - Analyze which nodes are starts, ends, intermediates
   - Generate DSL like `from(x).to(z).visited(y)`

2. **User can optionally edit DSL:**
   - Query selector UI shows generated DSL
   - User can overtype manually
   - Edited DSL is what gets sent to Python

3. **Python parses and executes:**
   - Parse DSL using existing `query_dsl.py`
   - Extract from/to/visited/exclude
   - Perform analysis accordingly

**Query construction logic (TS side):**
```typescript
function constructQueryDSL(
  selectedNodeIds: string[],
  graph: Graph
): string {
  // Compute predicates
  const predicates = computeSelectionPredicates(selectedNodeIds, graph);
  
  // If has unique start and end
  if (predicates.has_unique_start && predicates.has_unique_end) {
    const start = predicates.start_node;
    const end = predicates.end_node;
    const intermediates = predicates.intermediate_nodes;
    
    let dsl = `from(${start}).to(${end})`;
    if (intermediates.length > 0) {
      dsl += `.visited(${intermediates.join(',')})`;
    }
    return dsl;
  }
  
  // Fallback: just list nodes
  return `nodes(${selectedNodeIds.join(',')})`;
}
```

---

### DR3: Declarative Analysis Type Matching

**Requirement:** Selection predicates determine which analysis type runs.

**Design:**

**Predicate vocabulary:**
| Predicate | Type | Description |
|-----------|------|-------------|
| `node_count` | int | Number of selected nodes |
| `all_absorbing` | bool | All selected nodes are end/absorbing |
| `has_unique_start` | bool | Exactly one node has no selected predecessors |
| `has_unique_end` | bool | Exactly one node has no selected successors |
| `is_sequential` | bool | Direct edges exist between consecutive topo-sorted nodes |
| `start_is_graph_start` | bool | Unique start is a graph entry node |
| `end_is_graph_end` | bool | Unique end is an absorbing node |

**Analysis definitions:**
```yaml
# analysis_types.yaml

analyses:
  - id: single_node_path
    name: "Path to Node"
    description: "Probability and cost to reach single selected node from graph start"
    when:
      node_count: 1
    runner: single_node_runner

  - id: two_node_path
    name: "Path Between Nodes"
    description: "Probability and cost between two selected nodes"
    when:
      node_count: 2
      all_absorbing: false
    runner: path_runner

  - id: end_node_comparison
    name: "Outcome Comparison"
    description: "Compare probabilities of reaching different end nodes"
    when:
      all_absorbing: true
      node_count: { gte: 2 }
    runner: end_comparison_runner

  - id: sequential_path
    name: "Sequential Path"
    description: "Path through selected intermediate nodes"
    when:
      node_count: { gte: 3 }
      has_unique_start: true
      has_unique_end: true
      is_sequential: true
    runner: path_runner
    
  - id: constrained_path
    name: "Constrained Path"
    description: "Path through selected nodes (with pruning)"
    when:
      node_count: { gte: 3 }
      has_unique_start: true
      has_unique_end: true
    runner: path_runner

  - id: general_selection
    name: "Selection Statistics"
    description: "Aggregate statistics for arbitrary selection"
    when: {}  # Fallback - matches anything
    runner: general_stats_runner
```

**Matching algorithm:**
```python
def match_analysis_type(predicates: dict, definitions: list) -> AnalysisDefinition:
    """Find first matching analysis definition."""
    for defn in definitions:
        if matches(predicates, defn.when):
            return defn
    
    # Should never reach here if definitions include a fallback
    raise ValueError("No matching analysis type")

def matches(predicates: dict, conditions: dict) -> bool:
    """Check if predicates satisfy all conditions."""
    for key, expected in conditions.items():
        actual = predicates.get(key)
        
        if isinstance(expected, dict):
            # Range check: { gte: 3 }
            if 'gte' in expected and actual < expected['gte']:
                return False
            if 'lte' in expected and actual > expected['lte']:
                return False
        else:
            # Exact match
            if actual != expected:
                return False
    
    return True
```

---

## System Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         TypeScript (Browser)                     │
├─────────────────────────────────────────────────────────────────┤
│  GraphCanvas.tsx                                                 │
│  ├── User selects nodes                                         │
│  ├── Calls constructQueryDSL(selectedNodeIds, graph)            │
│  ├── Shows DSL in query editor (user can edit)                  │
│  └── Calls graphComputeClient.analyzeSelection(...)             │
│                                                                  │
│  graphComputeClient.ts                                          │
│  └── POST /api/runner/analyze { graph, query, scenarios, ... }  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Python (Server)                          │
├─────────────────────────────────────────────────────────────────┤
│  api/runner/analyze.py                                          │
│  └── Endpoint handler                                           │
│                                                                  │
│  lib/runner/                                                    │
│  ├── analyzer.py          # Main entry point                    │
│  │   ├── Parse query DSL                                        │
│  │   ├── Build NetworkX graph                                   │
│  │   ├── Compute selection predicates                           │
│  │   ├── Match analysis type                                    │
│  │   └── Execute runner                                         │
│  │                                                               │
│  ├── predicates.py        # Compute selection predicates        │
│  ├── adaptor.py           # Match predicates → analysis type    │
│  ├── path_analysis.py     # Path probability runner             │
│  ├── graph_pruning.py     # Pruning and renormalization         │
│  └── types.py             # Pydantic models                     │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
1. User selects nodes [A, B, C] in graph
   │
2. TS computes predicates: { has_unique_start: true, has_unique_end: true, ... }
   │
3. TS constructs DSL: "from(A).to(C).visited(B)"
   │
4. (Optional) User edits DSL in query editor
   │
5. TS calls Python: POST /api/runner/analyze
   │   {
   │     graph: {...},
   │     query: "from(A).to(C).visited(B)",
   │     scenarios: [{ scenario_id: "base", param_overrides: {...} }],
   │     what_if_overrides: {...}
   │   }
   │
6. Python parses DSL, extracts from/to/visited
   │
7. Python computes predicates (or trusts TS predicates)
   │
8. Python matches analysis type: "sequential_path"
   │
9. Python runs path_runner with pruning
   │
10. Python returns results per scenario
    │
11. TS displays in analysis popup (Phase 1) or Analytics Panel (Phase 2)
```

---

## API Specification

### POST /api/runner/analyze

**Request:**
```json
{
  "graph": {
    "nodes": [...],
    "edges": [...]
  },
  "query": "from(node-a).to(node-c).visited(node-b)",
  "scenarios": [
    {
      "scenario_id": "base",
      "name": "Base Case",
      "param_overrides": {}
    },
    {
      "scenario_id": "scenario-1",
      "name": "High Growth",
      "param_overrides": {
        "case_overrides": { "growth-case": "high" }
      }
    }
  ],
  "what_if_overrides": {
    "case_overrides": { "promo-case": "with-promo" }
  }
}
```

**Response:**
```json
{
  "analysis_type": "sequential_path",
  "analysis_name": "Sequential Path",
  "query_parsed": {
    "from": "node-a",
    "to": "node-c",
    "visited": ["node-b"]
  },
  "results": [
    {
      "scenario_id": "base",
      "scenario_name": "Base Case",
      "probability": 0.72,
      "expected_costs": {
        "monetary": 145.50,
        "time": 3.5,
        "units": "days"
      },
      "pruned_edges": ["edge-x", "edge-y"],
      "path_nodes": ["node-a", "node-b", "node-c"]
    },
    {
      "scenario_id": "scenario-1",
      "scenario_name": "High Growth",
      "probability": 0.85,
      "expected_costs": {
        "monetary": 162.00,
        "time": 2.8,
        "units": "days"
      },
      "pruned_edges": ["edge-x", "edge-y"],
      "path_nodes": ["node-a", "node-b", "node-c"]
    }
  ],
  "metadata": {
    "compute_time_ms": 15,
    "graph_nodes": 45,
    "graph_edges": 67
  }
}
```

---

## Python Module Design

### lib/runner/types.py

```python
from pydantic import BaseModel
from typing import Optional
from enum import Enum

class CostResult(BaseModel):
    monetary: float = 0.0
    time: float = 0.0
    units: str = "days"

class ScenarioParams(BaseModel):
    scenario_id: str
    name: str
    param_overrides: dict = {}

class AnalysisRequest(BaseModel):
    graph: dict
    query: str
    scenarios: list[ScenarioParams] = []
    what_if_overrides: dict = {}

class ScenarioResult(BaseModel):
    scenario_id: str
    scenario_name: str
    probability: float
    expected_costs: CostResult
    pruned_edges: list[str] = []
    path_nodes: list[str] = []

class AnalysisResponse(BaseModel):
    analysis_type: str
    analysis_name: str
    query_parsed: dict
    results: list[ScenarioResult]
    metadata: dict = {}
```

### lib/runner/predicates.py

```python
import networkx as nx

def compute_selection_predicates(
    G: nx.DiGraph,
    selected_node_ids: list[str]
) -> dict:
    """Compute predicates about the selection."""
    
    n = len(selected_node_ids)
    selected_set = set(selected_node_ids)
    
    # Basic count
    predicates = {
        'node_count': n,
    }
    
    if n == 0:
        return predicates
    
    # Check if all absorbing
    predicates['all_absorbing'] = all(
        G.nodes[nid].get('absorbing', False) or G.out_degree(nid) == 0
        for nid in selected_node_ids
    )
    
    # Find unique start (no selected predecessors)
    starts = [
        nid for nid in selected_node_ids
        if not any(pred in selected_set for pred in G.predecessors(nid))
    ]
    predicates['has_unique_start'] = len(starts) == 1
    predicates['start_node'] = starts[0] if len(starts) == 1 else None
    
    # Find unique end (no selected successors)
    ends = [
        nid for nid in selected_node_ids
        if not any(succ in selected_set for succ in G.successors(nid))
    ]
    predicates['has_unique_end'] = len(ends) == 1
    predicates['end_node'] = ends[0] if len(ends) == 1 else None
    
    # Check if sequential (topo sort, direct edges)
    if predicates['has_unique_start'] and predicates['has_unique_end']:
        try:
            subgraph = G.subgraph(selected_node_ids)
            sorted_ids = list(nx.topological_sort(subgraph))
            predicates['sorted_nodes'] = sorted_ids
            predicates['intermediate_nodes'] = sorted_ids[1:-1] if len(sorted_ids) > 2 else []
            
            # Check direct edges
            predicates['is_sequential'] = all(
                G.has_edge(sorted_ids[i], sorted_ids[i+1])
                for i in range(len(sorted_ids) - 1)
            )
        except nx.NetworkXError:
            predicates['is_sequential'] = False
            predicates['sorted_nodes'] = selected_node_ids
    else:
        predicates['is_sequential'] = False
        predicates['sorted_nodes'] = selected_node_ids
    
    return predicates
```

### lib/runner/adaptor.py

```python
import yaml
from pathlib import Path

class AnalysisAdaptor:
    def __init__(self, config_path: str = None):
        if config_path is None:
            config_path = Path(__file__).parent / 'analysis_types.yaml'
        
        with open(config_path) as f:
            config = yaml.safe_load(f)
        
        self.definitions = config['analyses']
    
    def match(self, predicates: dict) -> dict:
        """Find matching analysis definition."""
        for defn in self.definitions:
            if self._matches(predicates, defn.get('when', {})):
                return defn
        
        raise ValueError("No matching analysis type found")
    
    def _matches(self, predicates: dict, conditions: dict) -> bool:
        """Check if predicates satisfy conditions."""
        for key, expected in conditions.items():
            actual = predicates.get(key)
            
            if isinstance(expected, dict):
                if 'gte' in expected and (actual is None or actual < expected['gte']):
                    return False
                if 'lte' in expected and (actual is None or actual > expected['lte']):
                    return False
            else:
                if actual != expected:
                    return False
        
        return True
```

### lib/runner/analyzer.py

```python
import networkx as nx
from .types import AnalysisRequest, AnalysisResponse, ScenarioResult, CostResult
from .predicates import compute_selection_predicates
from .adaptor import AnalysisAdaptor
from .path_analysis import PathRunner
from ..query_dsl import parse_query

class GraphAnalyzer:
    def __init__(self):
        self.adaptor = AnalysisAdaptor()
        self.runners = {
            'path_runner': PathRunner(),
            'single_node_runner': PathRunner(),  # Same runner, different entry
            'end_comparison_runner': EndComparisonRunner(),
            'general_stats_runner': GeneralStatsRunner(),
        }
    
    def analyze(self, request: AnalysisRequest) -> AnalysisResponse:
        # Build NetworkX graph
        G = self._build_graph(request.graph)
        
        # Parse query DSL
        parsed = parse_query(request.query)
        
        # Extract selected nodes from query
        selected_node_ids = self._extract_nodes(parsed)
        
        # Compute predicates
        predicates = compute_selection_predicates(G, selected_node_ids)
        
        # Match analysis type
        analysis_def = self.adaptor.match(predicates)
        
        # Get runner
        runner = self.runners[analysis_def['runner']]
        
        # Run for each scenario
        results = []
        for scenario in request.scenarios or [{'scenario_id': 'default', 'name': 'Default', 'param_overrides': {}}]:
            # Merge scenario params with what-if
            effective_overrides = {
                **scenario.get('param_overrides', {}),
                **request.what_if_overrides
            }
            
            # Execute
            result = runner.run(G, parsed, predicates, effective_overrides)
            result.scenario_id = scenario['scenario_id']
            result.scenario_name = scenario.get('name', scenario['scenario_id'])
            results.append(result)
        
        return AnalysisResponse(
            analysis_type=analysis_def['id'],
            analysis_name=analysis_def['name'],
            query_parsed=parsed,
            results=results
        )
    
    def _build_graph(self, graph_data: dict) -> nx.DiGraph:
        G = nx.DiGraph()
        
        for node in graph_data.get('nodes', []):
            node_id = node.get('uuid') or node.get('id')
            G.add_node(node_id, **node)
        
        for edge in graph_data.get('edges', []):
            source = edge.get('from') or edge.get('source')
            target = edge.get('to') or edge.get('target')
            G.add_edge(source, target, **edge)
        
        return G
    
    def _extract_nodes(self, parsed: dict) -> list[str]:
        nodes = []
        if parsed.get('from'):
            nodes.append(parsed['from'])
        if parsed.get('to'):
            nodes.append(parsed['to'])
        nodes.extend(parsed.get('visited', []))
        return nodes
```

---

## TS Client Changes

### graphComputeClient.ts additions

```typescript
export interface ScenarioParams {
  scenario_id: string;
  name: string;
  param_overrides: Record<string, any>;
}

export interface AnalysisRequest {
  graph: Graph;
  query: string;
  scenarios?: ScenarioParams[];
  what_if_overrides?: Record<string, any>;
}

export interface ScenarioResult {
  scenario_id: string;
  scenario_name: string;
  probability: number;
  expected_costs: {
    monetary: number;
    time: number;
    units: string;
  };
  pruned_edges: string[];
  path_nodes: string[];
}

export interface AnalysisResponse {
  analysis_type: string;
  analysis_name: string;
  query_parsed: Record<string, any>;
  results: ScenarioResult[];
  metadata: Record<string, any>;
}

class GraphComputeClient {
  async analyzeSelection(request: AnalysisRequest): Promise<AnalysisResponse> {
    const response = await fetch(`${this.baseUrl}/runner/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Analysis failed: ${error.detail || error.error}`);
    }
    
    return response.json();
  }
}
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `lib/runner/__init__.py` | Package init |
| `lib/runner/types.py` | Pydantic models |
| `lib/runner/predicates.py` | Selection predicate computation |
| `lib/runner/adaptor.py` | Analysis type matching |
| `lib/runner/analyzer.py` | Main entry point |
| `lib/runner/path_analysis.py` | Path probability runner |
| `lib/runner/graph_pruning.py` | Pruning logic |
| `lib/runner/analysis_types.yaml` | Analysis definitions |
| `api/runner/analyze.py` | API endpoint |
| `tests/runner/test_predicates.py` | Predicate tests |
| `tests/runner/test_adaptor.py` | Adaptor tests |
| `tests/runner/test_path_analysis.py` | Runner tests |

---

## Analytics Panel (Basic UI)

### Goal

Provide a minimal UI for:
1. Testing during development
2. User interaction with analytics
3. Deprecating the old "path analysis" bottom-left popup

### Panel Structure

Built identically to existing sidebar panels (Scenarios, Props, Tools):

```
┌─────────────────────────────────────────┐
│ 📊 Analytics                        [×] │
├─────────────────────────────────────────┤
│                                         │
│ Query:                                  │
│ ┌─────────────────────────────────────┐ │
│ │ from(A).to(C).visited(B)          │ │ ← Editable DSL input
│ └─────────────────────────────────────┘ │
│                                         │
│ Analysis Type:                          │
│ ┌─────────────────────────────────────┐ │
│ │ Sequential Path               ▼    │ │ ← Dropdown (available types)
│ └─────────────────────────────────────┘ │
│                                         │
│ [Run Analysis]                          │ ← Button to execute
│                                         │
│ Results:                                │
│ ┌─────────────────────────────────────┐ │
│ │ {                                   │ │
│ │   "probability": 0.72,              │ │ ← Pretty-printed JSON
│ │   "expected_costs": {               │ │    (or simple table)
│ │     "monetary": 145.50,             │ │
│ │     "time": 3.5                     │ │
│ │   }                                 │ │
│ │ }                                   │ │
│ └─────────────────────────────────────┘ │
│                                         │
└─────────────────────────────────────────┘
```

### Components

```
components/panels/
├── AnalyticsPanel.tsx      # Main panel component
├── AnalyticsPanel.css      # Styling
```

### AnalyticsPanel.tsx (Minimal Implementation)

```tsx
import React, { useState, useEffect } from 'react';
import { graphComputeClient } from '../../lib/graphComputeClient';
import './AnalyticsPanel.css';

interface AnalyticsPanelProps {
  tabId: string;
}

export const AnalyticsPanel: React.FC<AnalyticsPanelProps> = ({ tabId }) => {
  // Selection from graph store
  const selectedNodeIds = useSelectedNodeIds();  // Hook to get current selection
  const graph = useGraph();
  const scenarios = useVisibleScenarios();
  
  // Local state
  const [queryDSL, setQueryDSL] = useState('');
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [selectedType, setSelectedType] = useState('');
  const [results, setResults] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Auto-generate DSL when selection changes
  useEffect(() => {
    if (selectedNodeIds.length > 0) {
      const dsl = constructQueryDSL(selectedNodeIds, graph);
      setQueryDSL(dsl);
    } else {
      setQueryDSL('');
    }
  }, [selectedNodeIds, graph]);
  
  // Fetch available analysis types when DSL changes
  useEffect(() => {
    if (queryDSL) {
      // Could call Python to get available types, or compute locally
      const types = getAvailableAnalysisTypes(queryDSL, graph);
      setAvailableTypes(types);
      if (types.length > 0 && !types.includes(selectedType)) {
        setSelectedType(types[0]);
      }
    }
  }, [queryDSL]);
  
  const runAnalysis = async () => {
    if (!queryDSL) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const response = await graphComputeClient.analyzeSelection({
        graph,
        query: queryDSL,
        scenarios: scenarios.map(s => ({
          scenario_id: s.id,
          name: s.name,
          param_overrides: s.param_overrides
        }))
      });
      setResults(response);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="analytics-panel">
      <div className="analytics-section">
        <label>Query:</label>
        <textarea
          className="query-input"
          value={queryDSL}
          onChange={(e) => setQueryDSL(e.target.value)}
          placeholder="Select nodes or enter DSL..."
          rows={2}
        />
      </div>
      
      <div className="analytics-section">
        <label>Analysis Type:</label>
        <select
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
          disabled={availableTypes.length === 0}
        >
          {availableTypes.map(type => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </div>
      
      <button
        className="run-button"
        onClick={runAnalysis}
        disabled={!queryDSL || loading}
      >
        {loading ? 'Running...' : 'Run Analysis'}
      </button>
      
      {error && (
        <div className="error-message">{error}</div>
      )}
      
      {results && (
        <div className="analytics-section">
          <label>Results:</label>
          <pre className="results-json">
            {JSON.stringify(results, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};
```

### Integration

Add to sidebar layout:

```typescript
// graphSidebarLayout.ts

const GRAPH_PANELS: PanelDefinition[] = [
  { id: 'what-if', title: '🎭 What-If', component: WhatIfPanel },
  { id: 'properties', title: '📝 Props', component: PropertiesPanelWrapper },
  { id: 'tools', title: '🛠️ Tools', component: ToolsPanel },
  { id: 'scenarios', title: '📋 Scenarios', component: ScenariosPanel },
  { id: 'analytics', title: '📊 Analytics', component: AnalyticsPanel },  // NEW
];
```

### Deprecation: Remove Path Analysis Popup

Once Analytics Panel is working:

1. Remove from `GraphCanvas.tsx`:
   - The `analysis` state variable
   - The `calculateSelectionAnalysis()` function
   - The `<Panel position="bottom-left">` rendering block (~200 lines)
   
2. Remove from `GraphEditor.tsx`:
   - Any path analysis related code

---

## Open Design Questions

### Q1: Trust TS predicates or recompute in Python?

**Options:**
- A) TS computes predicates, passes to Python
- B) Python recomputes predicates from selection
- C) Both compute, Python validates

**Recommendation:** B - Python recomputes. Simpler API, single source of truth.

### Q2: DSL construction - TS or Python?

**Decision:** TS constructs DSL (per user requirement for manual editing). Python just parses and executes.

### Q3: How to handle invalid/unsupported queries?

**Recommendation:** Return error response with helpful message, don't crash.

---

*Phase 1 Detailed Design*
*Created: 2025-11-25*

