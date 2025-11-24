# Detailed Code Fixes - Node Deletion Bug

## Overview
This document contains the exact code changes needed to fix the node deletion bug where deleting one node would delete all nodes with empty IDs.

---

## File 1: UpdateManager.ts

**Path**: `graph-editor/src/services/UpdateManager.ts`

**Location**: After the `updateEdgeProperty()` method (around line 2432)

**Add these two new methods:**

```typescript
  /**
   * Delete a node from the graph and clean up associated edges.
   * 
   * @param graph - Current graph
   * @param nodeUuid - UUID of the node to delete
   * @returns Updated graph with node and associated edges removed
   */
  deleteNode(graph: any, nodeUuid: string): any {
    const nextGraph = structuredClone(graph);
    
    // Find the node to verify it exists
    const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.uuid === nodeUuid);
    if (nodeIndex < 0) {
      console.warn('[UpdateManager] deleteNode: Node not found:', nodeUuid);
      return graph;
    }
    
    const node = nextGraph.nodes[nodeIndex];
    const humanId = node.id;
    
    console.log('[UpdateManager] Deleting node:', {
      uuid: nodeUuid,
      humanId: humanId,
      label: node.label
    });
    
    // Remove the node
    nextGraph.nodes = nextGraph.nodes.filter((n: any) => n.uuid !== nodeUuid);
    
    // Remove all edges connected to this node
    // Edge.from and Edge.to can be EITHER uuid OR human-readable ID
    const edgesBefore = nextGraph.edges.length;
    nextGraph.edges = nextGraph.edges.filter((e: any) => 
      e.from !== nodeUuid && e.to !== nodeUuid &&
      e.from !== humanId && e.to !== humanId
    );
    const edgesAfter = nextGraph.edges.length;
    const edgesRemoved = edgesBefore - edgesAfter;
    
    console.log('[UpdateManager] Deleted node:', {
      uuid: nodeUuid,
      edgesRemoved: edgesRemoved
    });
    
    // Update metadata
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Log audit trail
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'deleteNode',
      details: {
        nodeUuid: nodeUuid,
        humanId: humanId,
        edgesRemoved: edgesRemoved
      }
    });
    
    return nextGraph;
  }

  /**
   * Delete an edge from the graph.
   * 
   * @param graph - Current graph
   * @param edgeUuid - UUID of the edge to delete
   * @returns Updated graph with edge removed
   */
  deleteEdge(graph: any, edgeUuid: string): any {
    const nextGraph = structuredClone(graph);
    
    // Find the edge to verify it exists
    const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeUuid);
    if (edgeIndex < 0) {
      console.warn('[UpdateManager] deleteEdge: Edge not found:', edgeUuid);
      return graph;
    }
    
    const edge = nextGraph.edges[edgeIndex];
    console.log('[UpdateManager] Deleting edge:', {
      uuid: edgeUuid,
      from: edge.from,
      to: edge.to
    });
    
    // Remove the edge
    nextGraph.edges = nextGraph.edges.filter((e: any) => e.uuid !== edgeUuid);
    
    // Update metadata
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Log audit trail
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      operation: 'deleteEdge',
      details: {
        edgeUuid: edgeUuid,
        from: edge.from,
        to: edge.to
      }
    });
    
    return nextGraph;
  }
```

---

## File 2: GraphCanvas.tsx

**Path**: `graph-editor/src/components/GraphCanvas.tsx`

### Change 1: handleDeleteNode (around line 1108)

**REPLACE:**
```typescript
  const handleDeleteNode = useCallback((id: string) => {
    console.log('=== DELETING NODE ===', id);
    
    if (!graph) {
      console.log('No graph, aborting delete');
      return;
    }
    
    console.log('BEFORE DELETE:', {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      hasPolicies: !!graph.policies,
      hasMetadata: !!graph.metadata
    });
    
    const oldGraph = graph;
    const nextGraph = structuredClone(graph);
    nextGraph.nodes = nextGraph.nodes.filter(n => n.id !== id);
    nextGraph.edges = nextGraph.edges.filter(e => e.from !== id && e.to !== id);
    
    // Ensure metadata exists and update it
    if (!nextGraph.metadata) {
      nextGraph.metadata = {
        version: "1.0.0",
        created_at: new Date().toISOString()
      };
    }
    nextGraph.metadata.updated_at = new Date().toISOString();
    
    console.log('AFTER DELETE:', {
      nodes: nextGraph.nodes.length,
      edges: nextGraph.edges.length,
      hasPolicies: !!nextGraph.policies,
      hasMetadata: !!nextGraph.metadata
    });
    
    // Clear the sync flag to allow graph->ReactFlow sync
    isSyncingRef.current = false;
    
    setGraph(nextGraph);
    
    // Save history state for node deletion
    saveHistoryState('Delete node', id);
    
    // Clear selection when node is deleted
    onSelectedNodeChange(null);
  }, [graph, setGraph, onSelectedNodeChange, saveHistoryState]);
```

**WITH:**
```typescript
  const handleDeleteNode = useCallback(async (nodeUuid: string) => {
    console.log('=== DELETING NODE ===', nodeUuid);
    
    if (!graph) {
      console.log('No graph, aborting delete');
      return;
    }
    
    console.log('BEFORE DELETE:', {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      hasPolicies: !!graph.policies,
      hasMetadata: !!graph.metadata
    });
    
    // Use UpdateManager to delete node and clean up edges
    const { updateManager } = await import('../services/UpdateManager');
    const nextGraph = updateManager.deleteNode(graph, nodeUuid);
    
    console.log('AFTER DELETE:', {
      nodes: nextGraph.nodes.length,
      edges: nextGraph.edges.length,
      hasPolicies: !!nextGraph.policies,
      hasMetadata: !!nextGraph.metadata
    });
    
    // Clear the sync flag to allow graph->ReactFlow sync
    isSyncingRef.current = false;
    
    setGraph(nextGraph);
    
    // Save history state for node deletion
    saveHistoryState('Delete node', nodeUuid);
    
    // Clear selection when node is deleted
    onSelectedNodeChange(null);
  }, [graph, setGraph, onSelectedNodeChange, saveHistoryState]);
```

**Key changes:**
- Changed parameter name from `id` to `nodeUuid` for clarity
- Made function `async`
- Import `updateManager` and use `updateManager.deleteNode()`
- Removed manual filtering and metadata handling (now in UpdateManager)

---

### Change 2: handleDeleteEdge (around line 1181)

**REPLACE:**
```typescript
  const handleDeleteEdge = useCallback((id: string) => {
    console.log('=== DELETING EDGE ===', id);
    
    if (!graph) {
      console.log('No graph, aborting delete');
      return;
    }
    
    const nextGraph = structuredClone(graph);
    nextGraph.edges = nextGraph.edges.filter(e => e.id !== id);
    
    // Ensure metadata exists and update it
    if (!nextGraph.metadata) {
      nextGraph.metadata = {
        version: "1.0.0",
        created_at: new Date().toISOString()
      };
    }
    nextGraph.metadata.updated_at = new Date().toISOString();
    
    // Clear the sync flag to allow graph->ReactFlow sync
    isSyncingRef.current = false;
    
    // Update the graph (this will trigger the graph->ReactFlow sync which will update lastSyncedGraphRef)
    setGraph(nextGraph);
    
    // Note: History saving is handled by the calling component (PropertiesPanel or deleteSelected)
    
    // Clear selection when edge is deleted
    onSelectedEdgeChange(null);
  }, [graph, setGraph, onSelectedEdgeChange]);
```

**WITH:**
```typescript
  const handleDeleteEdge = useCallback(async (edgeUuid: string) => {
    console.log('=== DELETING EDGE ===', edgeUuid);
    
    if (!graph) {
      console.log('No graph, aborting delete');
      return;
    }
    
    // Use UpdateManager to delete edge
    const { updateManager } = await import('../services/UpdateManager');
    const nextGraph = updateManager.deleteEdge(graph, edgeUuid);
    
    // Clear the sync flag to allow graph->ReactFlow sync
    isSyncingRef.current = false;
    
    // Update the graph (this will trigger the graph->ReactFlow sync which will update lastSyncedGraphRef)
    setGraph(nextGraph);
    
    // Note: History saving is handled by the calling component (PropertiesPanel or deleteSelected)
    
    // Clear selection when edge is deleted
    onSelectedEdgeChange(null);
  }, [graph, setGraph, onSelectedEdgeChange]);
```

**Key changes:**
- Changed parameter name from `id` to `edgeUuid` for clarity
- Made function `async`
- Import `updateManager` and use `updateManager.deleteEdge()`
- Removed manual filtering and metadata handling (now in UpdateManager)

---

### Change 3: deleteSelected (around line 1214)

**REPLACE:**
```typescript
  // Delete selected elements
  const deleteSelected = useCallback(() => {
    if (!graph) return;
    
    const selectedNodes = nodes.filter(n => n.selected);
    const selectedEdges = edges.filter(e => e.selected);
    
    console.log('deleteSelected called with:', selectedNodes.length, 'nodes and', selectedEdges.length, 'edges');
    
    if (selectedNodes.length === 0 && selectedEdges.length === 0) return;
    
    // Save history state BEFORE deletion
    if (selectedNodes.length > 1 || selectedEdges.length > 1 || (selectedNodes.length > 0 && selectedEdges.length > 0)) {
      saveHistoryState('Delete selected', undefined, undefined);
    } else if (selectedEdges.length === 1) {
      saveHistoryState('Delete edge', undefined, selectedEdges[0].id);
    } else if (selectedNodes.length === 1) {
      saveHistoryState('Delete node', selectedNodes[0].id);
    }
    
    // Do all deletions in a single graph update
    const nextGraph = structuredClone(graph);
    
    // Delete selected nodes and their connected edges
    // Build set of both UUIDs and human-readable IDs for checking edge.from/to
    const selectedNodeUUIDs = new Set(selectedNodes.map(n => n.id)); // ReactFlow IDs are UUIDs
    const selectedNodeHumanIds = new Set(selectedNodes.map(n => n.data?.id).filter(Boolean));
    const allSelectedIds = new Set([...selectedNodeUUIDs, ...selectedNodeHumanIds]);
    
    nextGraph.nodes = nextGraph.nodes.filter(n => !selectedNodeUUIDs.has(n.uuid));
    nextGraph.edges = nextGraph.edges.filter(e => 
      // edge.from/to can be EITHER uuid OR human-readable ID
      !allSelectedIds.has(e.from) && !allSelectedIds.has(e.to)
    );
    
    // Delete selected edges (that weren't already deleted with nodes)
    const selectedEdgeIds = new Set(selectedEdges.map(e => e.id));
    nextGraph.edges = nextGraph.edges.filter(e => !selectedEdgeIds.has(e.uuid));
    
    // Update metadata
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Single graph update for all deletions
    setGraph(nextGraph);
    
    // Clear selection
    if (selectedNodes.length > 0) {
      onSelectedNodeChange(null);
    }
    if (selectedEdges.length > 0) {
      onSelectedEdgeChange(null);
    }
  }, [nodes, edges, graph, setGraph, saveHistoryState, onSelectedNodeChange, onSelectedEdgeChange]);
```

**WITH:**
```typescript
  // Delete selected elements
  const deleteSelected = useCallback(async () => {
    if (!graph) return;
    
    const selectedNodes = nodes.filter(n => n.selected);
    const selectedEdges = edges.filter(e => e.selected);
    
    console.log('deleteSelected called with:', selectedNodes.length, 'nodes and', selectedEdges.length, 'edges');
    
    if (selectedNodes.length === 0 && selectedEdges.length === 0) return;
    
    // Save history state BEFORE deletion
    if (selectedNodes.length > 1 || selectedEdges.length > 1 || (selectedNodes.length > 0 && selectedEdges.length > 0)) {
      saveHistoryState('Delete selected', undefined, undefined);
    } else if (selectedEdges.length === 1) {
      saveHistoryState('Delete edge', undefined, selectedEdges[0].id);
    } else if (selectedNodes.length === 1) {
      saveHistoryState('Delete node', selectedNodes[0].id);
    }
    
    // Use UpdateManager for deletions
    const { updateManager } = await import('../services/UpdateManager');
    let nextGraph = graph;
    
    // Delete selected nodes (this will also delete their connected edges via UpdateManager)
    const selectedNodeUUIDs = selectedNodes.map(n => n.id); // ReactFlow IDs are UUIDs
    for (const nodeUuid of selectedNodeUUIDs) {
      nextGraph = updateManager.deleteNode(nextGraph, nodeUuid);
    }
    
    // Delete selected edges (that weren't already deleted with nodes)
    const selectedEdgeUUIDs = selectedEdges.map(e => e.id); // ReactFlow IDs are UUIDs
    for (const edgeUuid of selectedEdgeUUIDs) {
      // Check if edge still exists (might have been deleted with a node)
      const edgeExists = nextGraph.edges.some((e: any) => e.uuid === edgeUuid);
      if (edgeExists) {
        nextGraph = updateManager.deleteEdge(nextGraph, edgeUuid);
      }
    }
    
    // Single graph update for all deletions
    setGraph(nextGraph);
    
    // Clear selection
    if (selectedNodes.length > 0) {
      onSelectedNodeChange(null);
    }
    if (selectedEdges.length > 0) {
      onSelectedEdgeChange(null);
    }
  }, [nodes, edges, graph, setGraph, saveHistoryState, onSelectedNodeChange, onSelectedEdgeChange]);
```

**Key changes:**
- Made function `async`
- Import `updateManager`
- Loop through selected nodes/edges and use UpdateManager methods
- Check if edges still exist before deleting (they may have been deleted with a node)
- Removed manual filtering and metadata handling

---

### Change 4: deleteNode (context menu, around line 4642)

**REPLACE:**
```typescript
  // Delete specific node
  // Delete specific node (called from context menu)
  // Note: This receives a React Flow node ID (UUID), but needs to look up by human-readable ID
  const deleteNode = useCallback((reactFlowNodeId: string) => {
    if (!graph) return;
    
    // Find the node by React Flow ID (UUID) to get its human-readable ID
    const node = nodes.find(n => n.id === reactFlowNodeId);
    if (!node?.data?.id) {
      console.error('Could not find node to delete:', reactFlowNodeId);
      return;
    }
    
    const humanReadableId = node.data.id;
    
    const nextGraph = structuredClone(graph);
    nextGraph.nodes = nextGraph.nodes.filter(n => n.id !== humanReadableId);
    nextGraph.edges = nextGraph.edges.filter(e => e.from !== humanReadableId && e.to !== humanReadableId);
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    setGraph(nextGraph);
    setNodeContextMenu(null);
    
    // Save history state for context menu deletion
    saveHistoryState('Delete node', humanReadableId);
    
    // Clear selection when node is deleted
    onSelectedNodeChange(null);
  }, [graph, nodes, setGraph, saveHistoryState, onSelectedNodeChange]);
```

**WITH:**
```typescript
  // Delete specific node (called from context menu)
  // Note: This receives a React Flow node ID (which is the UUID)
  const deleteNode = useCallback(async (nodeUuid: string) => {
    if (!graph) return;
    
    // Use UpdateManager to delete node and clean up edges
    const { updateManager } = await import('../services/UpdateManager');
    const nextGraph = updateManager.deleteNode(graph, nodeUuid);
    
    setGraph(nextGraph);
    setNodeContextMenu(null);
    
    // Save history state for context menu deletion
    saveHistoryState('Delete node', nodeUuid);
    
    // Clear selection when node is deleted
    onSelectedNodeChange(null);
  }, [graph, setGraph, saveHistoryState, onSelectedNodeChange]);
```

**Key changes:**
- Changed parameter name from `reactFlowNodeId` to `nodeUuid`
- Made function `async`
- Removed incorrect UUID→humanId lookup
- Import `updateManager` and use `updateManager.deleteNode()`
- Removed manual filtering and metadata handling
- Removed `nodes` dependency

---

### Change 5: deleteEdge (context menu, around line 4661)

**REPLACE:**
```typescript
  // Delete specific edge
  const deleteEdge = useCallback((edgeId: string) => {
    if (!graph) return;
    
    const nextGraph = structuredClone(graph);
    nextGraph.edges = nextGraph.edges.filter(e => e.id !== edgeId);
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    setGraph(nextGraph);
    // Note: History saving is handled by PropertiesPanel for keyboard/button deletes
    setEdgeContextMenu(null);
  }, [graph, setGraph]);
```

**WITH:**
```typescript
  // Delete specific edge (called from context menu)
  const deleteEdge = useCallback(async (edgeUuid: string) => {
    if (!graph) return;
    
    // Use UpdateManager to delete edge
    const { updateManager } = await import('../services/UpdateManager');
    const nextGraph = updateManager.deleteEdge(graph, edgeUuid);
    
    setGraph(nextGraph);
    // Note: History saving is handled by PropertiesPanel for keyboard/button deletes
    setEdgeContextMenu(null);
  }, [graph, setGraph]);
```

**Key changes:**
- Changed parameter name from `edgeId` to `edgeUuid`
- Made function `async`
- Import `updateManager` and use `updateManager.deleteEdge()`
- Removed manual filtering and metadata handling

---

### Change 6: Edge filtering in cycle detection (around line 2631)

**REPLACE:**
```typescript
    // Check for circular dependencies ONLY if source or target changed
    const nodesChanged = oldEdge.source !== newConnection.source || oldEdge.target !== newConnection.target;
    if (nodesChanged) {
      const reactFlowEdges = graph.edges
        .filter(e => e.id !== oldEdge.id)
        .map(e => ({ source: e.from, target: e.to }));
      if (wouldCreateCycle(newConnection.source, newConnection.target, reactFlowEdges)) {
        console.log('❌ REJECTED: Would create cycle');
        console.log('╚════════════════════════════════════════════════════╝');
        alert('Cannot create this connection as it would create a circular dependency.');
        return;
      }
    }
```

**WITH:**
```typescript
    // Check for circular dependencies ONLY if source or target changed
    const nodesChanged = oldEdge.source !== newConnection.source || oldEdge.target !== newConnection.target;
    if (nodesChanged) {
      const reactFlowEdges = graph.edges
        .filter(e => e.uuid !== oldEdge.id) // oldEdge.id from ReactFlow is the edge UUID
        .map(e => ({ source: e.from, target: e.to }));
      if (wouldCreateCycle(newConnection.source, newConnection.target, reactFlowEdges)) {
        console.log('❌ REJECTED: Would create cycle');
        console.log('╚════════════════════════════════════════════════════╝');
        alert('Cannot create this connection as it would create a circular dependency.');
        return;
      }
    }
```

**Key changes:**
- Changed `e.id !== oldEdge.id` to `e.uuid !== oldEdge.id`
- Added comment explaining that `oldEdge.id` from ReactFlow is the edge UUID

---

## Summary of Changes

### Files Modified: 2
1. `graph-editor/src/services/UpdateManager.ts` - Added 2 new methods
2. `graph-editor/src/components/GraphCanvas.tsx` - Modified 6 functions

### Total Changes: 7
1. ✅ Added `deleteNode()` to UpdateManager
2. ✅ Added `deleteEdge()` to UpdateManager
3. ✅ Updated `handleDeleteNode` to use UpdateManager
4. ✅ Updated `handleDeleteEdge` to use UpdateManager
5. ✅ Updated `deleteSelected` to use UpdateManager
6. ✅ Updated `deleteNode` (context menu) to use UpdateManager
7. ✅ Fixed edge filtering in cycle detection to use UUID

### Core Bug Fix
The root cause was using `n.id` (human-readable ID, can be empty `""`) instead of `n.uuid` (system-generated, always unique) for filtering during deletion. When nodes had empty IDs, the filter would match ALL nodes with empty IDs, causing all such nodes to be deleted instead of just the intended one.

### Architecture Improvement
All deletions now route through UpdateManager, providing:
- Consistent behavior
- Automatic edge cleanup
- Audit trail logging
- Metadata updates
- Centralized validation

### Testing
After implementing these changes:
1. Create a new graph
2. Add two nodes (without setting human-readable IDs - they'll have `id = ""`)
3. Add an edge between them
4. Delete one node - should delete ONLY that node (not both)
5. Verify the edge is removed automatically
6. Delete the remaining node
7. Verify no errors about edges referencing non-existent nodes


