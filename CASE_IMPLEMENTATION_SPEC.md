fiep# Case Node Implementation - Comprehensive Specification

## Overview
Complete specification for implementing Case nodes in Dagnet to model A/B tests and traffic experiments. Case nodes represent decision points where traffic is split between different variants with fixed probabilities.

**Repository Architecture:**
- **dagnet repo**: Schemas, editor UI, Apps Script code, validation logic
- **<private-repo> repo**: Actual case parameters, registry, historical data

---

# Part 1: Core Implementation

## 1. Graph Schema Changes

### 1.1 Node Schema
Location: `dagnet/graph-editor/src/lib/schemas/graph-schema.json`

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
    "parameter_id": "case-checkout-flow-001",
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
  - `id`: Unique case identifier (graph-local)
  - `parameter_id`: Reference to parameter in registry (optional, for registry integration)
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
    "stdev": 0.05,
    "parameter_id": "case-checkout-flow-001"
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
- `p.parameter_id`: Optional reference to parameter registry

### 1.3 Graph-Level Schema (Optional)
Optional top-level cases registry for convenience:

```json
{
  "nodes": [...],
  "edges": [...],
  "cases": {
    "case_001": {
      "name": "Checkout Flow Test",
      "status": "active",
      "parameter_id": "case-checkout-flow-001"
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

### 3.2 Properties Panel - Case Node Fields (Manual Mode)

When a Case node is selected and not using parameter registry:

```
┌─ Case Node Properties ─────────────┐
│                                     │
│ Mode: [●Manual] [○Registry]        │
│                                     │
│ Label: [Checkout Flow Case______]  │
│ Slug: [case-checkout-001_________]  │
│                                     │
│ Case ID: [case_001______________]  │
│ Status: [▼Active    ]              │
│                                     │
│ ┌─ Variants ─────────────────────┐ │
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
│ │ Total Weight: 1.0 ✓             │ │
│ └─────────────────────────────────┘ │
│                                     │
│ [Save Changes]                      │
└─────────────────────────────────────┘
```

### 3.3 Properties Panel - Registry Mode

When using parameter registry:

```
┌─ Case Node Properties ─────────────┐
│                                     │
│ Mode: [○Manual] [●Registry]        │
│                                     │
│ Parameter ID:                       │
│ [case-checkout-flow-001_______▼]   │
│                                     │
│ ┌─ Registry Info ──────────────┐   │
│ │ Name: Checkout Flow Test      │   │
│ │ Status: ● Active              │   │
│ │ Platform: Statsig             │   │
│ │ Last Updated: 2025-01-20      │   │
│ │                               │   │
│ │ Variants (from registry):     │   │
│ │ • Control: 50%                │   │
│ │ • Treatment: 50%              │   │
│ │                               │   │
│ │ [↻ Refresh from Registry]     │   │
│ │ [📝 Edit in Registry]         │   │
│ └───────────────────────────────┘   │
│                                     │
│ [Override Locally] (switch to Manual)│
└─────────────────────────────────────┘
```

**Validation Rules:**
- Variant weights must sum to 1.0
- At least 2 variants required
- Variant names must be unique within a case
- Weights must be between 0 and 1

### 3.4 Node Context Menu
Add "Convert to Case Node" option in node context menu.

### 3.5 Edge Creation from Case Nodes
When creating edges from a Case node:
1. Prompt user to select which variant the edge represents
2. Automatically populate `case_variant` and `case_id` fields
3. Set initial probability to variant weight

---

## 4. Component Changes

### 4.1 ConversionNode.tsx
Location: `dagnet/graph-editor/src/components/nodes/ConversionNode.tsx`

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
    parameter_id?: string;
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
Location: `dagnet/graph-editor/src/components/edges/ConversionEdge.tsx`

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
Location: `dagnet/graph-editor/src/components/GraphCanvas.tsx`

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
Location: `dagnet/graph-editor/src/components/PropertiesPanel.tsx`

**Major Changes:**
- Add Node Type selector (Normal/Case toggle)
- Add Mode selector (Manual/Registry toggle)
- Show case-specific fields when case node selected
- Variant management UI (add/remove/edit)
- Weight slider with validation
- Status dropdown
- Parameter registry browser
- Save logic to update node in graph

**New State:**
```typescript
const [nodeType, setNodeType] = useState<'normal' | 'case'>('normal');
const [caseMode, setCaseMode] = useState<'manual' | 'registry'>('manual');
const [caseData, setCaseData] = useState({
  id: '',
  parameter_id: '',
  status: 'active',
  variants: []
});
```

---

# Part 2: Parameter Registry Integration

## 5. Parameter Registry Structure

### 5.1 Repository: <private-repo>
Location: `https://github.com/gjbm2/<private-repo>`

```
<private-repo>/
├── graphs/
│   └── conversion-base.json          # References case nodes
└── params/
    ├── registry.yaml                  # Master registry
    └── cases/
        ├── checkout-flow-test.yaml
        ├── pricing-test.yaml
        └── onboarding-test.yaml
```

### 5.2 Case Parameter File Structure
Location: `<private-repo>/params/cases/checkout-flow-test.yaml`

```yaml
parameter_id: case-checkout-flow-001
parameter_type: case
name: Checkout Flow A/B Test
description: Testing new streamlined checkout vs original flow

# Case metadata
case:
  id: case_001
  slug: checkout-flow-test
  status: active
  created_at: 2025-01-15T10:00:00Z
  updated_at: 2025-01-20T14:30:00Z
  
  # Experiment platform integration (future)
  platform:
    type: statsig
    experiment_id: exp_checkout_streamline
    project_id: <private-repo>
    api_key_ref: STATSIG_API_KEY
  
  # Current variant configuration
  variants:
    - name: control
      weight: 0.5
      description: Original checkout flow
      statsig_variant_id: control
      
    - name: treatment
      weight: 0.5
      description: New streamlined checkout
      statsig_variant_id: treatment
  
  # Time-based configurations (optional)
  schedules:
    - start_date: 2025-01-15T00:00:00Z
      end_date: 2025-02-15T23:59:59Z
      variants:
        control: 0.5
        treatment: 0.5
      
    - start_date: 2025-02-16T00:00:00Z
      end_date: 2025-03-15T23:59:59Z
      variants:
        control: 0.2
        treatment: 0.8
      note: Increased treatment after positive results

# Historical snapshots
history:
  - date: 2025-01-15
    status: active
    variants:
      control: 0.5
      treatment: 0.5
  
  - date: 2025-02-16
    status: active
    variants:
      control: 0.2
      treatment: 0.8

# Which graphs use this case parameter
applies_to:
  - graph: conversion-base
    node_id: case_checkout_001
    node_slug: case-checkout
  
  - graph: conversion-mobile
    node_id: case_checkout_mobile_001
    node_slug: case-checkout-mobile

# Metadata
tags:
  - checkout
  - conversion
  - ui-test
  - high-priority

owner: product-team
contacts:
  - email: product@example.com
    role: owner
  - email: data@example.com
    role: analyst
```

### 5.3 Registry Index
Location: `<private-repo>/params/registry.yaml`

```yaml
parameters:
  # Existing parameters
  probability: [...]
  cost: [...]
  time: [...]
  
  # Case parameters
  cases:
    - id: case-checkout-flow-001
      name: Checkout Flow A/B Test
      file: cases/checkout-flow-test.yaml
      status: active
      platform: statsig
      
    - id: case-pricing-test-001
      name: Pricing Strategy Test
      file: cases/pricing-test.yaml
      status: completed
      platform: manual
```

### 5.4 Parameter Schema Definition
Location: `dagnet/param-registry/schemas/case-parameter-schema.yaml`

```yaml
$schema: http://json-schema.org/draft-07/schema#
title: Case Parameter Schema
description: Schema for case/experiment parameters

type: object
required:
  - parameter_id
  - parameter_type
  - name
  - case

properties:
  parameter_id:
    type: string
    pattern: ^case-[a-z0-9-]+$
    
  parameter_type:
    type: string
    const: case
    
  name:
    type: string
    minLength: 1
    
  description:
    type: string
    
  case:
    type: object
    required:
      - id
      - status
      - variants
    properties:
      id:
        type: string
        
      slug:
        type: string
        
      status:
        type: string
        enum: [active, paused, completed]
        
      platform:
        type: object
        properties:
          type:
            type: string
            enum: [manual, statsig, optimizely, launchdarkly]
          experiment_id:
            type: string
          project_id:
            type: string
          api_key_ref:
            type: string
            
      variants:
        type: array
        minItems: 2
        items:
          type: object
          required:
            - name
            - weight
          properties:
            name:
              type: string
            weight:
              type: number
              minimum: 0
              maximum: 1
            description:
              type: string
            statsig_variant_id:
              type: string
```

---

## 6. Apps Script Integration

Location: `dagnet/dagnet-apps-script-simple.js`

### 6.1 New Function: dagGetCases

```javascript
/**
 * Get all case nodes from the graph
 * @param {string} input - Cell reference or JSON string containing graph
 * @returns {Array} Array of case objects
 * @customfunction
 */
function dagGetCases(input) {
  try {
    const graph = parseGraphInput(input);
    if (!graph || !graph.nodes) return [];
    
    return graph.nodes
      .filter(node => node.type === 'case')
      .map(node => ({
        id: node.id,
        label: node.label,
        case_id: node.case?.id,
        parameter_id: node.case?.parameter_id,
        status: node.case?.status,
        variants: node.case?.variants || []
      }));
  } catch (e) {
    return `Error: ${e.message}`;
  }
}
```

### 6.2 Update: dagGetNodes

```javascript
/**
 * Get all nodes from the graph
 * @param {string} input - Cell reference or JSON string containing graph
 * @param {string} [nodeType] - Filter: 'normal', 'case', or 'all' (default)
 * @returns {Array} Array of node objects
 * @customfunction
 */
function dagGetNodes(input, nodeType = 'all') {
  try {
    const graph = parseGraphInput(input);
    if (!graph || !graph.nodes) return [];
    
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
      parameter_id: node.case?.parameter_id,
      variants: node.case?.variants
    }));
  } catch (e) {
    return `Error: ${e.message}`;
  }
}
```

### 6.3 Update: dagGetEdges

```javascript
/**
 * Get all edges from the graph
 * @param {string} input - Cell reference or JSON string containing graph
 * @param {string} [edgeType] - Filter: 'normal', 'case', or 'all' (default)
 * @returns {Array} Array of edge objects
 * @customfunction
 */
function dagGetEdges(input, edgeType = 'all') {
  try {
    const graph = parseGraphInput(input);
    if (!graph || !graph.edges) return [];
    
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
      case_id: edge.case_id,
      parameter_id: edge.p?.parameter_id
    }));
  } catch (e) {
    return `Error: ${e.message}`;
  }
}
```

### 6.4 Update: dagCalc with Case Support

```javascript
/**
 * Calculate graph metrics with case parameter support
 * @param {string} input - Cell reference or JSON string
 * @param {string} [operation] - DG_PROBABILITY, DG_COST, DG_TIME
 * @param {string} [startNode] - Start node slug/ID
 * @param {string} [endNode] - End node or DG_ANY_SUCCESS/DG_ANY_FAILURE
 * @param {string} [customParams] - JSON with case/edge overrides
 * @returns {number} Calculated result
 * @customfunction
 */
function dagCalc(input, operation, startNode, endNode, customParams) {
  try {
    const graph = parseGraphInput(input);
    
    if (!graph || !graph.nodes || !graph.edges) {
      return "Error: Invalid graph format";
    }
    
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
    
    // Set defaults
    if (!operation) operation = PROBABILITY;
    if (!startNode || startNode === '') {
      startNode = graph.nodes[0] ? (graph.nodes[0].id || graph.nodes[0].slug) : 'start';
    }
    if (!endNode) endNode = ANY_SUCCESS;
    
    // Rest of existing dagCalc logic...
    const startNodeObj = findNode(graph, startNode);
    const endNodes = findEndNodes(graph, endNode);
    
    if (operation === PROBABILITY) {
      return calculateProbability(graph, startNodeObj, endNodes);
    } else if (operation === COST) {
      const totalExpectedCost = calculateCost(graph, startNodeObj, endNodes);
      const successProbability = calculateProbability(graph, startNodeObj, endNodes);
      return successProbability > 0 ? totalExpectedCost / successProbability : 0;
    } else if (operation === TIME) {
      const totalExpectedTime = calculateTime(graph, startNodeObj, endNodes);
      const successProbability = calculateProbability(graph, startNodeObj, endNodes);
      return successProbability > 0 ? totalExpectedTime / successProbability : 0;
    }
    
    return "Error: Unknown operation";
  } catch (e) {
    return "Error: " + e.message;
  }
}
```

### 6.5 New Helper: applyCaseOverrides

```javascript
/**
 * Apply case parameter overrides to graph
 * @param {Object} graph - Graph object
 * @param {Object} caseOverrides - Case parameter overrides
 */
function applyCaseOverrides(graph, caseOverrides) {
  // Update case edge probabilities based on variant weights
  graph.edges.forEach(edge => {
    if (edge.case_id && caseOverrides[edge.case_id]) {
      const caseOverride = caseOverrides[edge.case_id];
      if (caseOverride[edge.case_variant] !== undefined) {
        edge.p.mean = caseOverride[edge.case_variant];
      }
    }
  });
}
```

### 6.6 New Helper: applyEdgeOverrides

```javascript
/**
 * Apply edge parameter overrides to graph
 * @param {Object} graph - Graph object
 * @param {Object} edgeOverrides - Edge parameter overrides
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
}
```

---

## 7. Usage Examples

### 7.1 Google Sheets Usage

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

**Compare variants:**
```
// Control only
=dagCalc(A1, "probability", "start", "success",
  '{"cases": {"case_001": {"control": 1.0, "treatment": 0.0}}}')

// Treatment only
=dagCalc(A1, "probability", "start", "success",
  '{"cases": {"case_001": {"control": 0.0, "treatment": 1.0}}}')
```

### 7.2 Graph Editor Usage

**Create case node:**
1. Add new node
2. Select "Case" in Node Type selector
3. Choose Manual or Registry mode
4. Add variants with weights
5. Save

**Create case edges:**
1. Connect case node to target
2. Select variant for edge
3. Set probability

**Use parameter registry:**
1. Select "Registry" mode
2. Choose parameter from dropdown
3. Variants auto-populate
4. Click refresh to update

---

## 8. Files to Modify

### 8.1 In dagnet Repository

**Schema Files:**
- `graph-editor/src/lib/schemas/graph-schema.json` - Add case node/edge types
- `param-registry/schemas/case-parameter-schema.yaml` - Case parameter validation

**Component Files:**
- `graph-editor/src/components/nodes/ConversionNode.tsx` - Case node rendering
- `graph-editor/src/components/edges/ConversionEdge.tsx` - Case edge coloring
- `graph-editor/src/components/GraphCanvas.tsx` - Case node/edge handling
- `graph-editor/src/components/PropertiesPanel.tsx` - Case node UI

**Service Files:**
- `graph-editor/src/services/graphGitService.ts` - Case parameter fetching
- `graph-editor/src/lib/useGraphStore.ts` - Case state management

**Apps Script Files:**
- `dagnet-apps-script-simple.js` - Add case functions

### 8.2 In <private-repo> Repository

**Parameter Files:**
- `params/registry.yaml` - Add cases section
- `params/cases/*.yaml` - Individual case parameter files

**Graph Files:**
- `graphs/*.json` - Add case nodes to graphs

---

## 9. Implementation Phases

### Phase 1: Basic Case Nodes (Manual Mode)
**Scope:** Core case node functionality without registry
**Timeline:** Week 1-2

1. Update graph schema with case node type
2. Add case properties to node/edge interfaces
3. Update ConversionNode to render case nodes (purple, smaller)
4. Update ConversionEdge to color case edges purple
5. Add Node Type selector to Properties Panel
6. Build manual variant management UI
7. Add weight validation
8. Test Sankey visualization with case edges

**Deliverables:**
- ✅ Purple case nodes render correctly
- ✅ Purple case edges use Sankey logic
- ✅ Can create/edit case nodes manually
- ✅ Variant weights validate to 1.0

### Phase 2: Apps Script Integration
**Scope:** Apps Script functions for case nodes
**Timeline:** Week 3

1. Add `dagGetCases` function
2. Update `dagGetNodes` with type filtering
3. Update `dagGetEdges` with type filtering
4. Enhance `dagCalc` with case overrides
5. Add helper functions for case/edge overrides
6. Test in Google Sheets

**Deliverables:**
- ✅ Apps Script functions work with case nodes
- ✅ Can override case variants in dagCalc
- ✅ Google Sheets formulas documented

### Phase 3: Parameter Registry (Basic)
**Scope:** Connect to parameter registry (manual sync)
**Timeline:** Week 4-5

1. Create case parameter schema in dagnet
2. Add example case parameter files
3. Add Registry mode to Properties Panel
4. Implement parameter browser UI
5. Wire up Git API to fetch parameters
6. Test loading parameters from <private-repo> repo

**Deliverables:**
- ✅ Can select parameter from registry
- ✅ Variants auto-populate from registry
- ✅ Can refresh from registry
- ✅ Parameter schema validates correctly

### Phase 4: Future Enhancements
**Scope:** Advanced features
**Timeline:** Future

- Time-based parameter resolution
- Historical analysis functions
- Statsig API integration
- Webhook support
- Automated sync

---

## 10. Validation Rules

### 10.1 Case Node Validation
- Must have `type: "case"`
- Must have at least 2 variants
- Variant weights must sum to 1.0 (±0.001 tolerance)
- Variant names must be unique within case
- Status must be: active, paused, or completed
- If `parameter_id` set, must reference existing parameter

### 10.2 Case Edge Validation
- Must have `case_id` if `case_variant` is set
- `case_id` must reference existing case node in graph
- `case_variant` must exist in referenced case node
- Probability should match variant weight (warning if different)

### 10.3 Graph-Level Validation
- All case edges must have matching case nodes
- No orphaned case references
- Warn if case node has no outgoing edges
- Warn if case node outgoing edges don't cover all variants

---

## 11. Example Complete Graph

```json
{
  "nodes": [
    {
      "id": "n1",
      "type": "normal",
      "label": "Landing Page",
      "slug": "landing",
      "entry": { "is_start": true, "entry_weight": 1.0 },
      "layout": { "x": 100, "y": 100 }
    },
    {
      "id": "c1",
      "type": "case",
      "label": "Checkout Test",
      "slug": "case-checkout",
      "case": {
        "id": "case_001",
        "parameter_id": "case-checkout-flow-001",
        "status": "active",
        "variants": [
          { "name": "control", "weight": 0.5, "description": "Original" },
          { "name": "treatment", "weight": 0.5, "description": "New UI" }
        ]
      },
      "layout": { "x": 300, "y": 100 }
    },
    {
      "id": "n2",
      "type": "normal",
      "label": "Purchase Success",
      "slug": "success",
      "absorbing": true,
      "outcome_type": "success",
      "layout": { "x": 500, "y": 100 }
    },
    {
      "id": "n3",
      "type": "normal",
      "label": "Abandoned",
      "slug": "abandoned",
      "absorbing": true,
      "outcome_type": "failure",
      "layout": { "x": 500, "y": 200 }
    }
  ],
  "edges": [
    {
      "id": "e1",
      "from": "n1",
      "to": "c1",
      "p": { "mean": 0.8, "stdev": 0.05 }
    },
    {
      "id": "e2",
      "from": "c1",
      "to": "n2",
      "p": { "mean": 0.5, "stdev": 0.05 },
      "case_variant": "control",
      "case_id": "case_001",
      "costs": {
        "monetary": { "value": 2.50, "stdev": 0.5 }
      }
    },
    {
      "id": "e3",
      "from": "c1",
      "to": "n2",
      "p": { "mean": 0.5, "stdev": 0.05 },
      "case_variant": "treatment",
      "case_id": "case_001",
      "costs": {
        "monetary": { "value": 2.00, "stdev": 0.4 }
      }
    },
    {
      "id": "e4",
      "from": "c1",
      "to": "n3",
      "p": { "mean": 0.5, "stdev": 0.05 },
      "case_variant": "control",
      "case_id": "case_001"
    },
    {
      "id": "e5",
      "from": "c1",
      "to": "n3",
      "p": { "mean": 0.5, "stdev": 0.05 },
      "case_variant": "treatment",
      "case_id": "case_001"
    }
  ],
  "policies": {
    "default_outcome": "abandon",
    "overflow_policy": "error",
    "free_edge_policy": "complement"
  },
  "metadata": {
    "version": "1.0.0",
    "created_at": "2025-01-15T10:00:00Z"
  }
}
```

---

## 12. Open Questions & Decisions

### Q1: Edge probability vs variant weight?
**Decision:** Allow them to differ
- Weight determines traffic split from case node
- Probability determines conversion rate along that path
- Example: 50% of traffic goes down control path, but only 60% of those convert

### Q2: Multiple outgoing paths per variant?
**Decision:** Yes, allow multiple edges per variant
- Each variant can have multiple outcomes
- Sum of probabilities for edges with same variant should equal 1.0
- Example: Control variant can lead to both success and abandon paths

### Q3: Case node as terminal node?
**Decision:** No, case nodes cannot be absorbing
- Case nodes must have outgoing edges
- They represent decision/split points, not endpoints

### Q4: Nested cases?
**Decision:** Yes, allow case edges to point to other case nodes
- Supports multi-stage experiments
- Example: First case splits checkout flow, second case within treatment splits payment methods

### Q5: Parameter registry in same repo or separate?
**Decision:** Separate repos (<private-repo>)
- Schemas in dagnet (reusable)
- Parameters in <private-repo> (project-specific)
- Allows multiple projects to use same editor/schemas

---

## 13. Success Criteria

Phase 1 (Basic):
- ✅ Case nodes render as purple, smaller than normal
- ✅ Case edges render in light purple with Sankey logic
- ✅ Properties Panel allows creating/editing case nodes
- ✅ Variant weights validate to sum to 1.0
- ✅ Graph can be saved/loaded with case nodes

Phase 2 (Apps Script):
- ✅ dagGetCases returns all case nodes
- ✅ dagGetNodes/dagGetEdges filter by type
- ✅ dagCalc accepts case overrides
- ✅ Can compare control vs treatment in Sheets

Phase 3 (Registry):
- ✅ Can select parameter from registry
- ✅ Variants load from parameter files
- ✅ Registry mode syncs with <private-repo> repo
- ✅ Parameter schema validates YAML files

---

## 14. Migration & Compatibility

**For Existing Graphs:**
- All existing nodes are implicitly `type: "normal"`
- All existing edges are normal edges (no case properties)
- No changes required to existing graphs
- Can add case nodes to existing graphs

**For New Graphs:**
- Can mix normal and case nodes freely
- Case edges use same calculation logic
- All Apps Script functions handle both types
- Path analysis works with case nodes

---

## End of Specification

This comprehensive specification covers:
- ✅ Basic case node implementation
- ✅ Visual design and rendering
- ✅ UI for manual and registry modes
- ✅ Apps Script integration
- ✅ Parameter registry structure
- ✅ Repository architecture
- ✅ Implementation phases
- ✅ Examples and usage patterns

Ready for implementation when you give the go-ahead!

