# SYSTEMATIC UUID/ID FIX GUIDE

## THE PROBLEM

We have THREE different contexts where nodes/edges are represented with different ID formats:

### 1. Graph JSON (stored data)
```javascript
node.uuid      // System-generated UUID: "550e8400-e29b-41d4-a716-446655440001"
node.id        // Human-readable ID: "a", "start-node", etc.
edge.from      // Can be EITHER uuid OR id (mixed in files!)
edge.to        // Can be EITHER uuid OR id (mixed in files!)
```

### 2. ReactFlow (UI rendering)
```javascript
node.id        // IS the UUID (from graph.uuid)
node.data.id   // Human-readable ID (from graph.id)
edge.source    // Can be uuid or id (whatever was in graph.from)
edge.target    // Can be uuid or id (whatever was in graph.to)
```

### 3. Tab Operations (hiding, etc.)
```javascript
hiddenNodes.has(nodeId)  // Uses human-readable IDs ONLY
```

## THE SOLUTION

Use the helper functions in `/graph-editor/src/lib/graphHelpers.ts`:

### For Graph JSON Lookups
```javascript
import { findGraphNodeById, findGraphEdgeById } from '@/lib/graphHelpers';

// Instead of:
const node = graph.nodes.find(n => n.id === nodeId);

// Use:
const node = findGraphNodeById(graph, nodeId);
```

### For ReactFlow Node Lookups
```javascript
import { findReactFlowNode, findReactFlowNodeByRef } from '@/lib/graphHelpers';

// When matching against edge.source/target:
const sourceNode = findReactFlowNodeByRef(nodes, edge.source);

// When matching a selected node ID:
const node = findReactFlowNode(nodes, selectedNodeId);
```

### For Tab Operations (Hiding)
```javascript
import { getHumanReadableIds } from '@/lib/graphHelpers';

// When passing to hideNode/unhideNode:
const idsToHide = getHumanReadableIds(selectedNodes);
idsToHide.forEach(id => tabOperations.hideNode(tabId, id));
```

## SEARCH PATTERNS TO FIX

Run these searches and replace with helper functions:

### Pattern 1: Graph node lookups
```
SEARCH: graph.nodes.find\((n|node): any\) => (n|node)\.id === 
REPLACE WITH: findGraphNodeById(graph, ...)
```

### Pattern 2: Graph edge lookups
```
SEARCH: graph.edges.find\((e|edge): any\) => (e|edge)\.id === 
REPLACE WITH: findGraphEdgeById(graph, ...)
```

### Pattern 3: ReactFlow node by edge reference
```
SEARCH: (all)?Nodes.find\(n => n\.id === edge\.(source|target)\)
REPLACE WITH: findReactFlowNodeByRef(allNodes, edge.source)
```

### Pattern 4: Mapping to IDs for tab operations
```
SEARCH: selectedNodes.map\(n => n\.id\)
CONTEXT: If used with tabOperations.hideNode
REPLACE WITH: getHumanReadableIds(selectedNodes)
```

## FILES THAT NEED SYSTEMATIC REVIEW

1. `/graph-editor/src/components/GraphCanvas.tsx` (4682 lines)
2. `/graph-editor/src/components/PropertiesPanel.tsx` (2923 lines)
3. `/graph-editor/src/components/nodes/ConversionNode.tsx`
4. `/graph-editor/src/components/edges/ConversionEdge.tsx`
5. `/graph-editor/src/components/WhatIfAnalysisControl.tsx`
6. `/graph-editor/src/components/ConditionalProbabilitiesSection.tsx`

## PRIORITY FIXES

### HIGH PRIORITY (breaks functionality)
- [ ] Tab operations (hideNode, unhideNode) - FIXED
- [ ] Node context menu hide/show - FIXED
- [ ] Edge context menu probability loading - FIXED
- [ ] Node probability mass calculation - FIXED
- [ ] Edge source/target lookups in calculateEdgeOffsets - FIXED

### MEDIUM PRIORITY (may cause subtle bugs)
- [ ] All remaining graph.nodes.find() calls
- [ ] All remaining graph.edges.find() calls
- [ ] What-if analysis node lookups
- [ ] Conditional probability node references

### LOW PRIORITY (already working with fallbacks)
- [ ] Logging/debugging that displays IDs
- [ ] Error messages with node/edge IDs

## TESTING CHECKLIST

After fixes, test with graphs that have:
- [ ] Mixed UUID and human-readable IDs in edge.from/to
- [ ] Human-readable IDs only (like "a", "b", "c")
- [ ] UUID-only references
- [ ] Hide/unhide nodes
- [ ] Edge context menu probabilities
- [ ] Node probability sum warnings

