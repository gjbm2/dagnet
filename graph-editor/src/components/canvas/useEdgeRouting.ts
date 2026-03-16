/**
 * useEdgeRouting — custom hook encapsulating edge rerouting logic.
 *
 * Owns: skipNextRerouteRef, lastNodePositionsRef, prevAutoRerouteRef,
 *       shouldReroute/forceReroute state, performImmediateReroute,
 *       performAutoReroute, and their associated effects.
 *
 * Extracted from GraphCanvas Phase B (structural refactor, no behavioural change).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Edge, Node } from 'reactflow';
import { assignFacesForNode } from '@/lib/faceSelection';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseEdgeRoutingParams {
  graph: any;
  nodes: Node[];
  edges: Edge[];
  setGraph: (graph: any, oldGraph?: any, source?: string) => void;
  autoReroute: boolean;
  useSankeyView: boolean;
  calculateOptimalHandles: (sourceNode: any, targetNode: any) => { sourceHandle: string; targetHandle: string };
  isDraggingNodeRef: React.MutableRefObject<boolean>;
  sankeyLayoutInProgressRef: React.MutableRefObject<boolean>;
  isEffectsCooldownActive: () => boolean;
}

export interface UseEdgeRoutingReturn {
  /** Trigger an increment to schedule a reroute (call from onNodesChange). */
  triggerReroute: () => void;
  /** Force a full reroute of all edges (call from layout handlers). */
  setForceReroute: React.Dispatch<React.SetStateAction<boolean>>;
  /** Ref to skip the next auto-reroute (set after manual reconnection). */
  skipNextRerouteRef: React.MutableRefObject<boolean>;
  /** Immediate full reroute (used when autoReroute is toggled on). */
  performImmediateReroute: () => void;
}

export function useEdgeRouting({
  graph,
  nodes,
  edges,
  setGraph,
  autoReroute,
  useSankeyView,
  calculateOptimalHandles,
  isDraggingNodeRef,
  sankeyLayoutInProgressRef,
  isEffectsCooldownActive,
}: UseEdgeRoutingParams): UseEdgeRoutingReturn {
  // -------------------------------------------------------------------------
  // Internal state and refs
  // -------------------------------------------------------------------------
  const [shouldReroute, setShouldReroute] = useState(0);
  const [forceReroute, setForceReroute] = useState(false);
  const skipNextRerouteRef = useRef(false);
  const prevAutoRerouteRef = useRef<boolean | undefined>(undefined);
  const lastNodePositionsRef = useRef<{ [nodeId: string]: { x: number; y: number } }>({});

  // -------------------------------------------------------------------------
  // performImmediateReroute
  // -------------------------------------------------------------------------
  const performImmediateReroute = useCallback(() => {
    if (!graph) {
      console.log('No graph, skipping immediate re-route');
      return;
    }

    console.log('Performing immediate re-route of ALL edges');

    const nextGraph = structuredClone(graph);
    let updatedCount = 0;

    nextGraph.edges.forEach((graphEdge: any) => {
      const sourceNode = nodes.find(n => n.id === graphEdge.from || n.data?.id === graphEdge.from);
      const targetNode = nodes.find(n => n.id === graphEdge.to || n.data?.id === graphEdge.to);

      if (sourceNode && targetNode) {
        const { sourceHandle, targetHandle } = calculateOptimalHandles(sourceNode, targetNode);

        const handleChanged = graphEdge.fromHandle !== sourceHandle || graphEdge.toHandle !== targetHandle;

        if (handleChanged) {
          console.log(`Re-routing edge ${graphEdge.id}:`, {
            from: graphEdge.from,
            to: graphEdge.to,
            oldFromHandle: graphEdge.fromHandle,
            newFromHandle: sourceHandle,
            oldToHandle: graphEdge.toHandle,
            newToHandle: targetHandle,
          });

          graphEdge.fromHandle = sourceHandle;
          graphEdge.toHandle = targetHandle;
          updatedCount++;
        }
      }
    });

    console.log(`Updated ${updatedCount} edges`);

    if (updatedCount > 0) {
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }

      console.log('Updating graph with immediate re-route changes');
      setGraph(nextGraph);
    }
  }, [graph, nodes, calculateOptimalHandles, setGraph]);

  // -------------------------------------------------------------------------
  // performAutoReroute
  // -------------------------------------------------------------------------
  const performAutoReroute = useCallback(() => {
    // Skip if we just did a manual reconnection
    if (skipNextRerouteRef.current) {
      console.log('Auto re-route skipped: manual reconnection just occurred');
      skipNextRerouteRef.current = false;
      return;
    }

    // Allow execution if autoReroute is enabled OR if forceReroute is true
    if ((!autoReroute && !forceReroute) || !graph) {
      console.log('Auto re-route skipped:', { autoReroute, forceReroute, hasGraph: !!graph });
      return;
    }

    const isDragging = isDraggingNodeRef.current;
    console.log('performAutoReroute executing:', { autoReroute, forceReroute, isDragging });

    const currentPositions: { [nodeId: string]: { x: number; y: number } } = {};
    let movedNodes: string[] = [];

    // If forceReroute, re-route ALL edges
    if (forceReroute) {
      console.log('Force re-route: processing all nodes');
      movedNodes = nodes.map(n => n.id);
      nodes.forEach(node => {
        currentPositions[node.id] = { x: node.position.x, y: node.position.y };
      });
    } else {
      // Check which nodes have moved
      nodes.forEach(node => {
        const currentPos = { x: node.position.x, y: node.position.y };
        const lastPos = lastNodePositionsRef.current[node.id];

        currentPositions[node.id] = currentPos;

        if (lastPos && (Math.abs(currentPos.x - lastPos.x) > 5 || Math.abs(currentPos.y - lastPos.y) > 5)) {
          movedNodes.push(node.id);
          console.log(`Node ${node.id} moved:`, {
            from: lastPos,
            to: currentPos,
            deltaX: currentPos.x - lastPos.x,
            deltaY: currentPos.y - lastPos.y,
          });
        }
      });

      if (movedNodes.length === 0) {
        console.log('No nodes moved, skipping re-route');
        return;
      }
    }

    console.log('Moved nodes:', movedNodes);

    // Update last positions
    lastNodePositionsRef.current = currentPositions;

    // Find edges that need re-routing
    const edgesToReroute = edges.filter(edge =>
      movedNodes.includes(edge.source) || movedNodes.includes(edge.target),
    );

    console.log('Edges to re-route:', edgesToReroute.map(e => e.id));

    if (edgesToReroute.length === 0) return;

    // Update graph with new handle positions
    const nextGraph = structuredClone(graph);

    // Build quick position map
    const pos: Record<string, { x: number; y: number }> = {};
    nodes.forEach(n => { pos[n.id] = { x: n.position.x, y: n.position.y }; });

    // Track which edges changed to identify nodes that need re-evaluation
    const changedEdges = new Set<string>();
    const processedNodes = new Set<string>();
    const nodesToProcess = [...movedNodes];

    // Process nodes in waves, using original edge state for decisions
    while (nodesToProcess.length > 0) {
      const nodeId = nodesToProcess.shift()!;
      if (processedNodes.has(nodeId)) continue;

      processedNodes.add(nodeId);

      // Use original edges for face assignment decisions
      const assignments = assignFacesForNode(nodeId, pos, edges as any);

      // Apply assignments and track changes
      Object.entries(assignments).forEach(([edgeId, face]) => {
        const originalEdge = edges.find(e => e.id === edgeId);
        const graphEdge = nextGraph.edges.find((e: any) => e.uuid === edgeId || e.id === edgeId);
        if (!originalEdge || !graphEdge) return;

        const newFromHandle = graphEdge.from === nodeId ? face + '-out' : graphEdge.fromHandle;
        const newToHandle = graphEdge.to === nodeId ? face : graphEdge.toHandle;

        // Check if this edge's face actually changed
        const fromChanged = graphEdge.from === nodeId && originalEdge.sourceHandle !== newFromHandle;
        const toChanged = graphEdge.to === nodeId && originalEdge.targetHandle !== newToHandle;

        if (fromChanged || toChanged) {
          changedEdges.add(edgeId);

          // Add connected nodes for next wave (avoid duplicates)
          if (!processedNodes.has(originalEdge.source) && !nodesToProcess.includes(originalEdge.source)) {
            nodesToProcess.push(originalEdge.source);
          }
          if (!processedNodes.has(originalEdge.target) && !nodesToProcess.includes(originalEdge.target)) {
            nodesToProcess.push(originalEdge.target);
          }
        }

        // Apply the changes
        if (graphEdge.from === nodeId) {
          graphEdge.fromHandle = face + '-out';
        }
        if (graphEdge.to === nodeId) {
          graphEdge.toHandle = face;
        }
      });
    }

    // Only update if edges actually changed
    if (changedEdges.size === 0) {
      console.log('No edges changed, skipping graph update');
      return;
    }

    // Preserve current ReactFlow node positions in the graph
    nextGraph.nodes.forEach((node: any) => {
      const reactFlowNode = nodes.find(n => n.id === node.uuid || n.id === node.id);
      if (reactFlowNode && node.layout) {
        node.layout.x = reactFlowNode.position.x;
        node.layout.y = reactFlowNode.position.y;
      }
    });
    if (nextGraph.containers) {
      nextGraph.containers.forEach((container: any) => {
        const rfNode = nodes.find(n => n.id === `container-${container.id}`);
        if (rfNode) {
          container.x = rfNode.position.x;
          container.y = rfNode.position.y;
        }
      });
    }
    if (nextGraph.postits) {
      nextGraph.postits.forEach((postit: any) => {
        const rfNode = nodes.find(n => n.id === `postit-${postit.id}`);
        if (rfNode) {
          postit.x = rfNode.position.x;
          postit.y = rfNode.position.y;
        }
      });
    }
    if (nextGraph.canvasAnalyses) {
      nextGraph.canvasAnalyses.forEach((analysis: any) => {
        const rfNode = nodes.find(n => n.id === `analysis-${analysis.id}`);
        if (rfNode) {
          analysis.x = rfNode.position.x;
          analysis.y = rfNode.position.y;
        }
      });
    }

    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }

    console.log(`Updating graph with ${changedEdges.size} changed edge handle positions`);
    setGraph(nextGraph);
    // Graph→ReactFlow sync will pick up the edge handle changes via the fast path
  }, [autoReroute, forceReroute, graph, nodes, edges, calculateOptimalHandles, setGraph]);

  // -------------------------------------------------------------------------
  // Effect: reset position tracking + immediate reroute when autoReroute toggled ON
  // -------------------------------------------------------------------------
  useEffect(() => {
    const prev = prevAutoRerouteRef.current;
    prevAutoRerouteRef.current = autoReroute;

    console.log(`[${new Date().toISOString()}] [GraphCanvas] useEffect#GC4: Auto re-route:`, autoReroute, `(prev: ${prev})`);

    if (autoReroute) {
      // Initialize position tracking when enabling
      const initialPositions: { [nodeId: string]: { x: number; y: number } } = {};
      nodes.forEach(node => {
        initialPositions[node.id] = { x: node.position.x, y: node.position.y };
      });
      lastNodePositionsRef.current = initialPositions;

      // Only perform immediate re-route if this is an actual toggle (not initial load)
      if (prev !== undefined && prev !== autoReroute && graph && nodes.length > 0 && edges.length > 0) {
        console.log('Triggering immediate re-route on toggle');
        setTimeout(() => {
          performImmediateReroute();
        }, 50);
      }
    } else {
      // Clear position tracking when disabling
      lastNodePositionsRef.current = {};
    }
  }, [autoReroute]); // eslint-disable-line react-hooks/exhaustive-deps — ONLY depend on autoReroute, not nodes/edges/graph

  // -------------------------------------------------------------------------
  // Effect: perform reroute when shouldReroute flag changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (sankeyLayoutInProgressRef.current || isEffectsCooldownActive()) {
      const ts = () => new Date().toISOString();
      console.log(`[${ts()}] [GraphCanvas] Re-route skipped (layout/cooldown active)`);
      return;
    }
    if ((shouldReroute > 0 && autoReroute) || forceReroute) {
      console.log('Re-route triggered:', { shouldReroute, autoReroute, forceReroute });
      // Add a small delay to ensure node positions are fully updated
      const timeoutId = setTimeout(() => {
        console.log('Executing delayed re-route after node movement');
        performAutoReroute();
        if (forceReroute) {
          setForceReroute(false);
        }
        // Reset the shouldReroute flag to prevent infinite loops
        setShouldReroute(0);
      }, 100);

      return () => clearTimeout(timeoutId);
    }
  }, [shouldReroute, autoReroute, forceReroute, performAutoReroute]); // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------
  const triggerReroute = useCallback(() => {
    setShouldReroute(v => v + 1);
  }, []);

  return {
    triggerReroute,
    setForceReroute,
    skipNextRerouteRef,
    performImmediateReroute,
  };
}
