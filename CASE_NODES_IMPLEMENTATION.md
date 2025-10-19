# Case Nodes Implementation Plan

## Overview
Add support for Case nodes to model traffic experiments and A/B tests. Case nodes represent decision points where traffic is split between different variants (e.g., control vs treatment) with fixed probabilities.

## Terminology
- **Case Node**: A node that splits traffic between variants
- **Case Edge**: An edge originating from a Case node, representing a specific variant
- **Variant**: A specific experimental condition (e.g., "control", "treatment")
- **Weight**: The proportion of traffic allocated to each variant

---

## 1. Schema Changes

### 1.1 Node Schema
Add a new node type `case` with case-specific properties:

```json
{
  "id": "case_checkout_001",
  "type": "case",
  "label": "Checkout Flow Case",
  "slug": "case-checkout-001",
  "absorbing": false,
  "case": {
    "id": "case_001",
    "status": "active",
    "variants": [
      {
        "name": "control",
        "weight": 0.5,
        "description": "Original checkout flow"
      },
      {
        "name": "treatment",
        "weight": 0.5,
        "description": "New streamlined checkout"
      }
    ]
  },
  "layout": { "x": 100, "y": 100, "rank": 1 }
}
```

**New Fields:**
- `type`: `"case"` (new node type)
- `case`: Object containing case metadata
  - `id`: Unique case identifier
  - `status`: `"active"` | `"paused"` | `"completed"`
  - `variants`: Array of variant objects
    - `name`: Variant name (string)
    - `weight`: Traffic allocation (0-1, must sum to 1.0)
    - `description`: Optional description

### 1.2 Edge Schema
Add case-specific properties to edges:

```json
{
  "id": "edge_001",
  "from": "case_checkout_001",
  "to": "checkout_success",
  "p": {
    "mean": 0.5,
    "stdev": 0.05
  },
  "case_variant": "control",
  "case_id": "case_001",
  "costs": {
    "monetary": { "value": 2.50, "stdev": 0.5 },
    "time": { "value": 3.2, "stdev": 0.8, "units": "minutes" }
  }
}
```

**New Fields:**
- `case_variant`: Name of the variant this edge represents
- `case_id`: Reference to parent case node

### 1.3 Graph-Level Schema
Optional top-level cases registry:

```json
{
  "nodes": [...],
  "edges": [...],
  "cases": {
    "case_001": {
      "name": "Checkout Flow Test",
      "status": "active",
      "created_at": "2025-01-15T10:00:00Z",
      "variants": ["control", "treatment"]
    }
  },
  "policies": {...},
  "metadata": {...}
}
```

---

## 2. Visual Design

### 2.1 Case Nodes
- **Size**: 80% of normal node size (96px × 96px instead of 120px × 120px)
- **Background**: `#8B5CF6` (purple-500)
- **Border**: `#7C3AED` (purple-600), 2px solid
- **Text Color**: `#FFFFFF` (white)
- **Shape**: Rectangle with 8px border radius (same as normal nodes)
- **Font Size**: 11px (slightly smaller than normal)

**Status Indicator:**
- Small dot in top-right corner
- Active: `#10B981` (green-500)
- Paused: `#F59E0B` (yellow-500)
- Completed: `#6B7280` (gray-500)

### 2.2 Case Edges
- **Stroke Color**: `#C4B5FD` (purple-300) - light purple
- **Width**: Same as normal edges (use existing Sankey logic)
- **Offsets**: Same as normal edges (use existing offset calculations)
- **Scaling**: Follows same Global Log Mass scaling
- **Arrows**: Same as normal edges

**Key Point:** Case edges use ALL existing visual rendering logic except color.

---

## 3. UI Changes

### 3.1 Properties Panel - Node Type Selector

Add a selector at the top of the Properties Panel:

```
┌─────────────────────────────┐
│ Node Type: [●Normal][○Case] │
└─────────────────────────────┘
```

When "Case" is selected, transform the node into a case node.

### 3.2 Properties Panel - Case Node Fields

When a Case node is selected, show:

```
┌─ Case Node Properties ─────────────┐
│                                     │
│ Label: [Checkout Flow Case______]  │
│                                     │
│ Slug: [case-checkout-001_________]  │
│                                     │
│ Case ID: [case_001______________]  │
│                                     │
│ Status: [▼Active    ]              │
│         • Active                    │
│         • Paused                    │
│         • Completed                 │
│                                     │
│ ┌─ Variants ─────────────────────┐ │
│ │                                 │ │
│ │ Variant 1:                      │ │
│ │ Name: [control_______________]  │ │
│ │ Weight: [0.5] [═══════○══════]  │ │
│ │ Description: [Original flow___] │ │
│ │                      [✕ Remove] │ │
│ │                                 │ │
│ │ Variant 2:                      │ │
│ │ Name: [treatment_____________]  │ │
│ │ Weight: [0.5] [═══════○══════]  │ │
│ │ Description: [New streamlined_] │ │
│ │                      [✕ Remove] │ │
│ │                                 │ │
│ │ [+ Add Variant]                 │ │
│ │                                 │ │
│ │ Total Weight: 1.0 ✓             │ │
│ └─────────────────────────────────┘ │
│                                     │
│ [Save Changes]                      │
└─────────────────────────────────────┘
```

**Validation Rules:**
- Variant weights must sum to 1.0
- At least 2 variants required
- Variant names must be unique within a case
- Weights must be between 0 and 1

### 3.3 Node Context Menu
Add "Convert to Case Node" option in node context menu.

### 3.4 Edge Creation from Case Nodes
When creating edges from a Case node:
1. Prompt user to select which variant the edge represents
2. Automatically populate `case_variant` and `case_id` fields
3. Set initial probability to variant weight

---

## 4. Component Changes

### 4.1 ConversionNode.tsx
**Changes:**
- Add `type` prop detection
- Conditional styling based on `type === "case"`
- Purple background for case nodes
- Status indicator dot
- Smaller size (80% scale)

**New Props:**
```typescript
interface ConversionNodeData {
  // ... existing props
  type?: 'normal' | 'case';
  case?: {
    id: string;
    status: 'active' | 'paused' | 'completed';
    variants: Array<{
      name: string;
      weight: number;
      description?: string;
    }>;
  };
}
```

### 4.2 ConversionEdge.tsx
**Changes:**
- Detect case edges via `case_variant` or `case_id` properties
- Conditional stroke color: purple for case edges, gray for normal
- Keep all existing width/offset/scaling logic

**New Props:**
```typescript
interface ConversionEdgeData {
  // ... existing props
  case_variant?: string;
  case_id?: string;
}
```

### 4.3 GraphCanvas.tsx
**Changes:**
- Handle case node rendering
- Apply purple color to case edges
- Update edge width calculations to handle case edges
- Update offset calculations to handle case edges (same logic)

**Edge Color Logic:**
```typescript
const edgeColor = edge.data?.case_variant || edge.data?.case_id 
  ? '#C4B5FD' // purple-300 for case edges
  : '#999';   // gray for normal edges
```

### 4.4 PropertiesPanel.tsx
**Major Changes:**
- Add Node Type selector (Normal/Case toggle)
- Show case-specific fields when case node selected
- Variant management UI (add/remove/edit)
- Weight slider with validation
- Status dropdown
- Save logic to update node in graph

**New State:**
```typescript
const [nodeType, setNodeType] = useState<'normal' | 'case'>('normal');
const [caseData, setCaseData] = useState({
  id: '',
  status: 'active',
  variants: []
});
```

---

## 5. Apps Script Changes

### 5.1 New Function: dagGetCases
Return all case nodes from the graph:

```javascript
/**
 * Get all case nodes from the graph
 * @param {string} input - Cell reference or JSON string containing graph
 * @returns {Array} Array of case objects with id, label, status, variants
 * @customfunction
 */
function dagGetCases(input) {
  const graph = parseGraphInput(input);
  return graph.nodes
    .filter(node => node.type === 'case')
    .map(node => ({
      id: node.id,
      label: node.label,
      case_id: node.case?.id,
      status: node.case?.status,
      variants: node.case?.variants || []
    }));
}
```

### 5.2 Update: dagGetNodes
Add node type filtering:

```javascript
/**
 * Get all nodes from the graph
 * @param {string} input - Cell reference or JSON string containing graph
 * @param {string} [nodeType] - Filter: 'normal', 'case', or 'all' (default)
 * @returns {Array} Array of node objects
 * @customfunction
 */
function dagGetNodes(input, nodeType = 'all') {
  const graph = parseGraphInput(input);
  let nodes = graph.nodes;
  
  if (nodeType === 'normal') {
    nodes = nodes.filter(node => !node.type || node.type !== 'case');
  } else if (nodeType === 'case') {
    nodes = nodes.filter(node => node.type === 'case');
  }
  
  return nodes.map(node => ({
    id: node.id,
    label: node.label,
    type: node.type || 'normal',
    case_id: node.case?.id,
    variants: node.case?.variants
  }));
}
```

### 5.3 Update: dagGetEdges
Add edge type filtering:

```javascript
/**
 * Get all edges from the graph
 * @param {string} input - Cell reference or JSON string containing graph
 * @param {string} [edgeType] - Filter: 'normal', 'case', or 'all' (default)
 * @returns {Array} Array of edge objects
 * @customfunction
 */
function dagGetEdges(input, edgeType = 'all') {
  const graph = parseGraphInput(input);
  let edges = graph.edges;
  
  if (edgeType === 'normal') {
    edges = edges.filter(edge => !edge.case_variant && !edge.case_id);
  } else if (edgeType === 'case') {
    edges = edges.filter(edge => edge.case_variant || edge.case_id);
  }
  
  return edges.map(edge => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    probability: edge.p?.mean,
    case_variant: edge.case_variant,
    case_id: edge.case_id
  }));
}
```

### 5.4 Update: dagCalc
Add case parameter override support:

```javascript
/**
 * Calculate graph metrics with case overrides
 * @param {string} input - Cell reference or JSON string
 * @param {string} [operation] - DG_PROBABILITY, DG_COST, DG_TIME
 * @param {string} [startNode] - Start node slug/ID
 * @param {string} [endNode] - End node or DG_ANY_SUCCESS/DG_ANY_FAILURE
 * @param {string} [customParams] - JSON with case/edge overrides
 * @returns {number} Calculated result
 * @customfunction
 */
function dagCalc(input, operation, startNode, endNode, customParams) {
  const graph = parseGraphInput(input);
  
  // Parse custom parameters
  if (customParams) {
    const params = JSON.parse(customParams);
    
    // Apply case overrides
    if (params.cases) {
      applyCaseOverrides(graph, params.cases);
    }
    
    // Apply edge overrides
    if (params.edges) {
      applyEdgeOverrides(graph, params.edges);
    }
  }
  
  // Existing calculation logic
  return calculateResult(graph, operation, startNode, endNode);
}
```

### 5.5 New Helper: applyCaseOverrides
```javascript
/**
 * Apply case parameter overrides to graph
 */
function applyCaseOverrides(graph, caseOverrides) {
  graph.edges.forEach(edge => {
    if (edge.case_id && caseOverrides[edge.case_id]) {
      const override = caseOverrides[edge.case_id];
      if (override[edge.case_variant] !== undefined) {
        edge.p.mean = override[edge.case_variant];
      }
    }
  });
  return graph;
}
```

### 5.6 New Helper: applyEdgeOverrides
```javascript
/**
 * Apply edge parameter overrides to graph
 */
function applyEdgeOverrides(graph, edgeOverrides) {
  graph.edges.forEach(edge => {
    if (edgeOverrides[edge.id]) {
      const override = edgeOverrides[edge.id];
      if (override.probability !== undefined) {
        edge.p.mean = override.probability;
      }
      if (override.costs) {
        edge.costs = { ...edge.costs, ...override.costs };
      }
    }
  });
  return graph;
}
```

---

## 6. Usage Examples

### 6.1 Google Sheets Usage

**Get all case nodes:**
```
=dagGetCases(A1)
```

**Get only case nodes:**
```
=dagGetNodes(A1, "case")
```

**Get case edges:**
```
=dagGetEdges(A1, "case")
```

**Calculate with case overrides:**
```
=dagCalc(A1, "probability", "start", "success", 
  '{"cases": {"case_001": {"control": 0.3, "treatment": 0.7}}}')
```

**Calculate cost with case and edge overrides:**
```
=dagCalc(A1, "cost", "start", "success",
  '{"cases": {"case_001": {"control": 0.5, "treatment": 0.5}}, 
   "edges": {"edge_1": {"probability": 0.8, "costs": {"monetary": {"value": 5.0}}}}}')
```

### 6.2 Graph Editor Usage

1. **Create case node:**
   - Add new node
   - Select "Case" in Node Type selector
   - Add variants with weights
   - Save

2. **Create case edges:**
   - Connect case node to target
   - Select variant for edge
   - Set probability

3. **View case visualization:**
   - Purple nodes show case split points
   - Purple edges show variant paths
   - Sankey visualization shows traffic flow

---

## 7. Files to Modify

### 7.1 Schema Files
- `graph-editor/src/lib/schema.ts` - Add case types
- `graph-editor/src/lib/validation.ts` - Add case validation

### 7.2 Component Files
- `graph-editor/src/components/nodes/ConversionNode.tsx` - Case node rendering
- `graph-editor/src/components/edges/ConversionEdge.tsx` - Case edge coloring
- `graph-editor/src/components/GraphCanvas.tsx` - Case node/edge handling
- `graph-editor/src/components/PropertiesPanel.tsx` - Case node UI

### 7.3 Service Files
- `graph-editor/src/services/graphGitService.ts` - Case data handling
- `graph-editor/src/lib/useGraphStore.ts` - Case state management

### 7.4 Apps Script Files
- `dagnet-apps-script-simple.js` - Add dagGetCases, update existing functions
- `dagnet-apps-script.js` - Update all functions for case support

---

## 8. Implementation Order

### Phase 1: Schema & Data Model
1. Update graph schema to include case node type
2. Add case properties to node interface
3. Add case properties to edge interface
4. Update validation rules

### Phase 2: Visual Rendering
1. Update ConversionNode to render case nodes (purple, smaller)
2. Update ConversionEdge to color case edges purple
3. Test Sankey visualization with case edges

### Phase 3: Properties Panel UI
1. Add Node Type selector
2. Build case variant management UI
3. Add weight validation
4. Wire up save logic

### Phase 4: Apps Script Integration
1. Add dagGetCases function
2. Update dagGetNodes with filtering
3. Update dagGetEdges with filtering
4. Enhance dagCalc with case overrides
5. Add helper functions

### Phase 5: Testing & Documentation
1. Test case node creation/editing
2. Test case edge visualization
3. Test Apps Script functions
4. Update user documentation

---

## 9. Validation Rules

### 9.1 Case Node Validation
- Must have `type: "case"`
- Must have at least 2 variants
- Variant weights must sum to 1.0 (±0.001 tolerance)
- Variant names must be unique
- Status must be: active, paused, or completed

### 9.2 Case Edge Validation
- Must have `case_id` if `case_variant` is set
- `case_id` must reference existing case node
- `case_variant` must exist in referenced case node
- Probability should match variant weight (warning if different)

### 9.3 Graph-Level Validation
- All case edges must have matching case nodes
- No orphaned case references
- Warn if case node has no outgoing edges

---

## 10. Migration Strategy

**No backward compatibility required** - this is a new feature.

### For Existing Graphs:
- All existing nodes are `type: "normal"` (implicit)
- All existing edges are normal edges (no case properties)
- Existing graphs continue to work without changes

### For New Graphs:
- Can mix normal and case nodes freely
- Case edges use same calculation logic as normal edges
- Apps Script functions handle both types

---

## 11. Example Graph with Cases

```json
{
  "nodes": [
    {
      "id": "n1",
      "type": "normal",
      "label": "Landing Page",
      "slug": "landing",
      "entry": { "is_start": true, "entry_weight": 1.0 }
    },
    {
      "id": "c1",
      "type": "case",
      "label": "Checkout Test",
      "slug": "case-checkout",
      "case": {
        "id": "case_001",
        "status": "active",
        "variants": [
          { "name": "control", "weight": 0.5, "description": "Original" },
          { "name": "treatment", "weight": 0.5, "description": "New UI" }
        ]
      }
    },
    {
      "id": "n2",
      "type": "normal",
      "label": "Purchase Success",
      "slug": "success",
      "absorbing": true,
      "outcome_type": "success"
    }
  ],
  "edges": [
    {
      "id": "e1",
      "from": "n1",
      "to": "c1",
      "p": { "mean": 0.8 }
    },
    {
      "id": "e2",
      "from": "c1",
      "to": "n2",
      "p": { "mean": 0.5 },
      "case_variant": "control",
      "case_id": "case_001"
    },
    {
      "id": "e3",
      "from": "c1",
      "to": "n2",
      "p": { "mean": 0.5 },
      "case_variant": "treatment",
      "case_id": "case_001"
    }
  ]
}
```

---

## 12. Open Questions

1. **Edge probability vs variant weight:** Should we enforce that edge probability matches variant weight, or allow them to differ?
   - **Recommendation:** Allow them to differ. Weight determines traffic split, probability determines conversion rate.

2. **Multiple outgoing paths per variant:** Should each variant be allowed to have multiple outgoing edges?
   - **Recommendation:** Yes. Sum of probabilities for edges with same variant should equal 1.0.

3. **Case node as terminal node:** Should case nodes be allowed to be absorbing?
   - **Recommendation:** No. Case nodes should always have outgoing edges.

4. **Nested cases:** Should we allow case edges to point to other case nodes?
   - **Recommendation:** Yes. This allows multi-stage experiments.

---

## Success Criteria

✅ Case nodes render as purple, smaller than normal nodes
✅ Case edges render in light purple with same Sankey logic
✅ Properties Panel allows creating/editing case nodes
✅ Variant weights validate to sum to 1.0
✅ Apps Script dagGetCases returns all case nodes
✅ Apps Script dagGetNodes/dagGetEdges filter by type
✅ Apps Script dagCalc accepts case overrides
✅ Path analysis works with case nodes
✅ Sankey visualization works with case edges
✅ Graph can be saved/loaded with case nodes

---

## End of Specification


