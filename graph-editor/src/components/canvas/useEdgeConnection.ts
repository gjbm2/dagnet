/**
 * useEdgeConnection — custom hook encapsulating edge connection/reconnection logic.
 *
 * Owns: onEdgeUpdate, onConnect, generateEdgeId, handleVariantSelection,
 *       wouldCreateCycle, variant modal state, reconnection refs.
 *
 * Extracted from GraphCanvas Phase B3 (structural refactor, no behavioural change).
 */

import { useCallback, useRef, useState } from 'react';
import type { Connection, Edge, Node } from 'reactflow';
import { wouldCreateCycle as wouldCreateCycleCore } from './pathHighlighting';
import { generateUniqueId } from '@/lib/idUtils';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseEdgeConnectionParams {
  graph: any;
  nodes: Node[];
  edges: Edge[];
  setGraph: (graph: any, oldGraph?: any, source?: string) => void;
  saveHistoryState: (action: string, nodeId?: string | undefined, edgeId?: string | undefined) => void;
  onSelectedEdgeChange: (edgeId: string | null) => void;
  isSyncingRef: React.MutableRefObject<boolean>;
  skipNextRerouteRef: React.MutableRefObject<boolean>;
  getAllExistingIds: (excludeId?: string) => string[];
}

export interface UseEdgeConnectionReturn {
  /** Handle edge reconnection (dragging edge to new source/target). */
  onEdgeUpdate: (oldEdge: Edge, newConnection: Connection) => void;
  /** Handle new connections. */
  onConnect: (connection: Connection) => void;
  /** Generate a unique id for an edge based on node ids. */
  generateEdgeId: (sourceId: string, targetId: string) => string;
  /** Handle variant selection for case edges. */
  handleVariantSelection: (variant: any) => void;
  /** Check if connecting source→target would create a cycle. */
  wouldCreateCycle: (source: string, target: string, currentEdges: any[]) => boolean;
  /** Whether the variant selection modal is visible. */
  showVariantModal: boolean;
  /** The pending connection awaiting variant selection. */
  pendingConnection: Connection | null;
  /** Available variants for the case node. */
  caseNodeVariants: any[];
  /** Close the variant modal and clear state. */
  dismissVariantModal: () => void;
}

export function useEdgeConnection({
  graph,
  nodes,
  edges,
  setGraph,
  saveHistoryState,
  onSelectedEdgeChange,
  isSyncingRef,
  skipNextRerouteRef,
  getAllExistingIds,
}: UseEdgeConnectionParams): UseEdgeConnectionReturn {
  // -------------------------------------------------------------------------
  // Internal state and refs
  // -------------------------------------------------------------------------
  const pendingReconnectionRef = useRef<string | null>(null);
  const reconnectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [showVariantModal, setShowVariantModal] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null);
  const [caseNodeVariants, setCaseNodeVariants] = useState<any[]>([]);

  // -------------------------------------------------------------------------
  // wouldCreateCycle
  // -------------------------------------------------------------------------
  const wouldCreateCycle = useCallback((source: string, target: string, currentEdges: any[]) => {
    return wouldCreateCycleCore(source, target, currentEdges, nodes.map(n => n.id));
  }, [nodes]);

  // -------------------------------------------------------------------------
  // generateEdgeId
  // -------------------------------------------------------------------------
  const generateEdgeId = useCallback((sourceId: string, targetId: string) => {
    if (!graph?.nodes) return `${sourceId}-to-${targetId}`;

    // Find source and target nodes to get their ids
    const sourceNode = graph.nodes.find((n: any) => n.uuid === sourceId || n.id === sourceId);
    const targetNode = graph.nodes.find((n: any) => n.uuid === targetId || n.id === targetId);

    const sourceId_ = sourceNode?.id || sourceNode?.uuid || sourceId;
    const targetId_ = targetNode?.id || targetNode?.uuid || targetId;

    const baseId = `${sourceId_}-to-${targetId_}`;

    // Ensure uniqueness by appending a number if needed
    const existingIds = getAllExistingIds();
    const uniqueId = generateUniqueId(baseId, existingIds);

    return uniqueId;
  }, [graph, getAllExistingIds]);

  // -------------------------------------------------------------------------
  // onEdgeUpdate (reconnection)
  // -------------------------------------------------------------------------
  const onEdgeUpdate = useCallback((oldEdge: Edge, newConnection: Connection) => {

    // Clear any existing timeout for this edge
    if (reconnectionTimeoutRef.current) {
      clearTimeout(reconnectionTimeoutRef.current);
      reconnectionTimeoutRef.current = null;
    }

    // If this is an invalid connection, ignore it
    if (!newConnection.source || !newConnection.target) {
      console.log('❌ REJECTED: Invalid connection (missing source/target)');
      return;
    }

    // CRITICAL: Only allow reconnection if edge is selected
    if (!oldEdge.selected) {
      console.log('❌ REJECTED: Edge not selected');
      return;
    }

    if (!graph) {
      console.log('❌ REJECTED: No graph available');
      return;
    }

    // Check for valid connection
    if (!newConnection.source || !newConnection.target) {
      console.log('❌ REJECTED: Missing source or target');
      console.log('╚════════════════════════════════════════════════════╝');
      return;
    }

    // Additional check: if this is an invalid connection (no target), ignore it
    // This prevents ReactFlow from calling us with invalid connections when mouseup happens outside nodes
    if (newConnection.target === null || newConnection.target === undefined) {
      console.log('❌ REJECTED: Invalid target (null/undefined)');
      return;
    }

    // Prevent self-referencing edges (but allow changing the handle on same nodes)
    if (newConnection.source === newConnection.target &&
        oldEdge.source === oldEdge.target) {
      console.log('❌ REJECTED: Cannot connect node to itself');
      return;
    }

    // Check for circular dependencies ONLY if source or target changed
    const nodesChanged = oldEdge.source !== newConnection.source || oldEdge.target !== newConnection.target;
    if (nodesChanged) {
      const reactFlowEdges = graph.edges
        .filter((e: any) => e.uuid !== oldEdge.id) // oldEdge.id from ReactFlow is the edge UUID
        .map((e: any) => ({ source: e.from, target: e.to }));
      if (wouldCreateCycle(newConnection.source, newConnection.target, reactFlowEdges)) {
        console.log('❌ REJECTED: Would create cycle');
        alert('Cannot create this connection as it would create a circular dependency.');
        return;
      }
    }

    console.log('✅ VALIDATION PASSED - Debouncing reconnection...');

    // Debounce the reconnection to handle multiple rapid calls
    reconnectionTimeoutRef.current = setTimeout(() => {
      console.log('🔄 Processing debounced reconnection...');

      // Update the edge in graph state
      const nextGraph = structuredClone(graph);

      // Try multiple ways to find the edge
      let edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === oldEdge.id || e.id === oldEdge.id);

      if (edgeIndex === -1) {
        // Try finding by source->target format
        const sourceTargetId = `${oldEdge.source}->${oldEdge.target}`;
        edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === sourceTargetId || e.id === sourceTargetId);
      }

      if (edgeIndex === -1) {
        // Try finding by from->to format (from/to could be uuid or id)
        edgeIndex = nextGraph.edges.findIndex((e: any) =>
          (e.from === oldEdge.source || e.from === oldEdge.source) &&
          (e.to === oldEdge.target || e.to === oldEdge.target)
        );
      }

      if (edgeIndex === -1) {
        console.log('❌ ERROR: Edge not found in graph:', oldEdge.id);
        console.log('Available edges:', nextGraph.edges.map((e: any) => e.id));
        return;
      }

      const originalEdge = { ...nextGraph.edges[edgeIndex] };

      console.log('');
      console.log('📊 PROBABILITY CHECK:');
      console.log('  Original edge probability:', originalEdge.p);

      // Update edge source/target and handles (source and target are guaranteed non-null by earlier check)
      nextGraph.edges[edgeIndex].from = newConnection.source!;
      nextGraph.edges[edgeIndex].to = newConnection.target!;

      // Map handle IDs to match our node component
      // Source handles: "top" -> "top-out", "left" -> "left-out", etc.
      // Target handles: keep as-is ("top", "left", "right", "bottom")
      const sourceHandle = newConnection.sourceHandle ?
        (newConnection.sourceHandle.endsWith('-out') ? newConnection.sourceHandle : `${newConnection.sourceHandle}-out`) :
        undefined;
      const targetHandle = newConnection.targetHandle || undefined;

      nextGraph.edges[edgeIndex].fromHandle = sourceHandle;
      nextGraph.edges[edgeIndex].toHandle = targetHandle;

      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }

      console.log('Updated edge:');
      console.log('  from:', originalEdge.from, '→', nextGraph.edges[edgeIndex].from);
      console.log('  to:', originalEdge.to, '→', nextGraph.edges[edgeIndex].to);
      console.log('  fromHandle:', originalEdge.fromHandle, '→', nextGraph.edges[edgeIndex].fromHandle);
      console.log('  toHandle:', originalEdge.toHandle, '→', nextGraph.edges[edgeIndex].toHandle);
      console.log('  probability (p):', originalEdge.p, '→', nextGraph.edges[edgeIndex].p);
      console.log('✅ SUCCESS - Edge reconnected!');
      console.log('📊 Final edge object:', JSON.stringify(nextGraph.edges[edgeIndex], null, 2));

      // Prevent ReactFlow->Graph sync from overwriting this manual reconnection
      isSyncingRef.current = true;
      setGraph(nextGraph);

      // Prevent auto-reroute from overwriting manual handle selection
      skipNextRerouteRef.current = true;

      // Save history state for edge reconnection
      saveHistoryState('Reconnect edge', undefined, nextGraph.edges[edgeIndex].uuid || undefined);

      // Reset isSyncingRef after a short delay to allow Graph->ReactFlow sync to complete
      setTimeout(() => {
        isSyncingRef.current = false;
      }, 100);
    }, 50); // 50ms debounce
  }, [graph, setGraph, wouldCreateCycle, saveHistoryState]);

  // -------------------------------------------------------------------------
  // onConnect
  // -------------------------------------------------------------------------
  const onConnect = useCallback(async (connection: Connection) => {
    if (!graph) return;

    // Capture the current graph at the start of this callback
    const currentGraph = graph;

    // Check for valid connection
    if (!connection.source || !connection.target) {
      return;
    }

    // Prevent self-referencing edges
    if (connection.source === connection.target) {
      alert('Cannot create an edge from a node to itself.');
      return;
    }

    // Check if source is a case node (do this check early)
    // connection.source is ReactFlow ID (uuid)
    const sourceNode = currentGraph.nodes.find((n: any) => n.uuid === connection.source || n.id === connection.source);
    const isCaseNode = sourceNode && sourceNode.type === 'case' && sourceNode.case;

    // Prevent duplicate edges (but allow multiple edges from case nodes with different variants)
    if (!isCaseNode) {
      // For normal nodes, prevent any duplicate edges
      const existingEdge = currentGraph.edges.find((edge: any) =>
        edge.from === connection.source && edge.to === connection.target
      );
      if (existingEdge) {
        alert('An edge already exists between these nodes.');
        return;
      }
    }
    // For case nodes, duplication check will happen after variant selection

    // Check for circular dependencies (convert graph edges to ReactFlow format for check)
    const reactFlowEdges = currentGraph.edges.map((e: any) => ({ source: e.from, target: e.to }));
    if (wouldCreateCycle(connection.source, connection.target, reactFlowEdges)) {
      alert('Cannot create this connection as it would create a circular dependency.');
      return;
    }

    // If source is a case node with multiple variants, show variant selection modal
    if (isCaseNode && sourceNode.case && sourceNode.case.variants.length > 1) {
      setPendingConnection(connection);
      setCaseNodeVariants(sourceNode.case.variants);
      setShowVariantModal(true);
      return; // Don't create the edge yet, wait for variant selection
    }

    // Use UpdateManager to create edge with proper ID generation and probability calculation
    const { updateManager } = await import('../../services/UpdateManager');
    const options: any = {};

    // If source is a case node with single variant, automatically assign variant properties
    if (isCaseNode && sourceNode.case && sourceNode.case.variants.length === 1) {
      const variant = sourceNode.case.variants[0];
      options.case_id = sourceNode.case.id;
      options.case_variant = variant.name;
    }

    const { graph: nextGraph, edgeId } = updateManager.createEdge(
      currentGraph,
      {
        source: connection.source!,
        target: connection.target!,
        sourceHandle: connection.sourceHandle || null,
        targetHandle: connection.targetHandle || null
      },
      options
    );

    // Single path: route through GraphCanvas setGraph wrapper (avoids nested updateGraph calls)
    await setGraph(nextGraph, currentGraph, 'add-edge');
    saveHistoryState('Add edge', undefined, edgeId);

    // Select the new edge after a brief delay to allow sync to complete
    setTimeout(() => {
      onSelectedEdgeChange(edgeId);
    }, 50);
  }, [graph, setGraph, wouldCreateCycle, onSelectedEdgeChange, saveHistoryState]);

  // -------------------------------------------------------------------------
  // handleVariantSelection
  // -------------------------------------------------------------------------
  const handleVariantSelection = useCallback(async (variant: any) => {
    if (!pendingConnection || !graph) return;

    // Capture the current graph at the start of this callback
    const currentGraph = graph;

    // pendingConnection.source is ReactFlow ID (uuid)
    const sourceNode = currentGraph.nodes.find((n: any) => n.uuid === pendingConnection.source || n.id === pendingConnection.source);
    if (!sourceNode || !sourceNode.case) return;

    // Check if an edge with this variant already exists between these nodes
    const existingVariantEdge = currentGraph.edges.find((edge: any) =>
      edge.from === pendingConnection.source &&
      edge.to === pendingConnection.target &&
      edge.case_id === sourceNode.case?.id &&
      edge.case_variant === variant.name
    );

    if (existingVariantEdge) {
      alert(`An edge for variant "${variant.name}" already exists between these nodes.`);
      setShowVariantModal(false);
      setPendingConnection(null);
      setCaseNodeVariants([]);
      return;
    }

    // Use UpdateManager to create edge with variant properties
    const { updateManager } = await import('../../services/UpdateManager');
    const { graph: nextGraph, edgeId } = updateManager.createEdge(
      currentGraph,
      {
        source: pendingConnection.source!,
        target: pendingConnection.target!,
        sourceHandle: pendingConnection.sourceHandle || null,
        targetHandle: pendingConnection.targetHandle || null
      },
      {
        case_variant: variant.name
        // case_id will be automatically inferred from source node by UpdateManager
      }
    );

    // Single path: route through GraphCanvas setGraph wrapper (avoids nested updateGraph calls)
    await setGraph(nextGraph, currentGraph, 'add-edge-variant');
    saveHistoryState('Add edge', undefined, edgeId);

    // Close modal and clear state
    setShowVariantModal(false);
    setPendingConnection(null);
    setCaseNodeVariants([]);
  }, [pendingConnection, graph, setGraph, saveHistoryState]);

  // -------------------------------------------------------------------------
  // dismissVariantModal
  // -------------------------------------------------------------------------
  const dismissVariantModal = useCallback(() => {
    setShowVariantModal(false);
    setPendingConnection(null);
    setCaseNodeVariants([]);
  }, []);

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------
  return {
    onEdgeUpdate,
    onConnect,
    generateEdgeId,
    handleVariantSelection,
    wouldCreateCycle,
    showVariantModal,
    pendingConnection,
    caseNodeVariants,
    dismissVariantModal,
  };
}
