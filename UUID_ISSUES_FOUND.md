# UUID/ID ISSUES FOUND - COMPREHENSIVE LIST

## CRITICAL ISSUES (Breaking Functionality) - ✅ FIXED

### 1. ✅ GraphCanvas.tsx Line 3470: hideUnselectedNodes
```javascript
// BEFORE:
const selectedNodeIds = selectedNodes.map(n => n.id);  // UUIDs!
await tabOperations.hideUnselectedNodes(activeTabId, selectedNodeIds);

// AFTER:
const selectedNodeIds = selectedNodes.map(n => n.data?.id || n.id);  // Human-readable IDs
await tabOperations.hideUnselectedNodes(activeTabId, selectedNodeIds);
```
**Problem**: Passing UUIDs to `hideUnselectedNodes` which expects human-readable IDs
**Status**: ✅ FIXED

### 2. ✅ GraphCanvas.tsx Lines 1182-1191: Delete nodes mixed IDs
```javascript
// BEFORE:
const selectedNodeIds = new Set(selectedNodes.map(n => n.id));  // UUIDs only
nextGraph.nodes = nextGraph.nodes.filter(n => !selectedNodeIds.has(n.uuid));
nextGraph.edges = nextGraph.edges.filter(e => 
  !selectedNodeIds.has(e.from) && !selectedNodeIds.has(e.to)  // ✗ FAILS with human-readable IDs
);

// AFTER:
const selectedNodeUUIDs = new Set(selectedNodes.map(n => n.id));
const selectedNodeHumanIds = new Set(selectedNodes.map(n => n.data?.id).filter(Boolean));
const allSelectedIds = new Set([...selectedNodeUUIDs, ...selectedNodeHumanIds]);

nextGraph.nodes = nextGraph.nodes.filter(n => !selectedNodeUUIDs.has(n.uuid));
nextGraph.edges = nextGraph.edges.filter(e => 
  !allSelectedIds.has(e.from) && !allSelectedIds.has(e.to)  // ✓ Works with both formats
);
```
**Problem**: Checking UUIDs against `e.from`/`e.to` which can be human-readable IDs
**Status**: ✅ FIXED

### 3. ✅ QueryExpressionEditor.tsx Line 176: Missing uuid check
```javascript
// BEFORE:
graph.edges.find((e: any) => e.id === edgeId || `${e.from}->${e.to}` === edgeId)

// AFTER:
graph.edges.find((e: any) => e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId)
```
**Problem**: Not checking `e.uuid`
**Status**: ✅ FIXED

## POTENTIAL ISSUES (May cause bugs with mixed ID graphs)

### 4. GraphCanvas.tsx Lines 2298-2304: Case detection uses UUIDs
```javascript
const selectedNodeIds = selectedNodes.map(n => n.id);  // UUIDs
// Later used to match against graph nodes
```
**Context**: Used for case detection - need to verify this works with both ID formats

### 5. GraphCanvas.tsx Lines 2503-2554: What-if path analysis
```javascript
const selectedNodeIds = selectedNodes.map(node => node.id);  // UUIDs
const sortedNodeIds = topologicalSort(selectedNodeIds, allEdges);
```
**Context**: Uses UUIDs for topological sort and path finding - edges may reference human-readable IDs

### 6. GraphCanvas.tsx Line 2645+: What-if display uses UUIDs
```javascript
const selectedNodeIds = selectedNodesForAnalysis.map(n => n.id);
```
**Context**: Display logic that matches against edges

## FILES NEEDING SYSTEMATIC REVIEW

- [x] GraphCanvas.tsx - Lines 3470, 1182-1186 **HIGH PRIORITY**
- [ ] QueryExpressionEditor.tsx - Line 176 **HIGH PRIORITY**
- [ ] GraphCanvas.tsx - All topological sort and path analysis **MEDIUM PRIORITY**
- [ ] ConditionalProbabilitiesSection.tsx - Check if uses node/edge lookups
- [ ] All .map(n => n.id) operations that feed into graph operations

## ROOT CAUSE

The fundamental issue is that `ReactFlow node.id` is the **UUID**, but `edge.from` and `edge.to` in the graph data can be **EITHER** UUID or human-readable ID (user can write either in the JSON).

## SOLUTION STRATEGY

1. **For tab operations**: Always use human-readable IDs (`n.data?.id`)
2. **For graph edge lookups**: Always check both `n.uuid` AND `n.id`
3. **For edge.from/to matching**: Need helper that checks if ANY node matches (by uuid or id)

