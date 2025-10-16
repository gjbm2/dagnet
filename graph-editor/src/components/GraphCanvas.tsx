import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
  ReactFlowProvider,
  NodeTypes,
  EdgeTypes,
  useReactFlow,
  Panel,
} from 'reactflow';
import 'reactflow/dist/style.css';

import ConversionNode from './nodes/ConversionNode';
import ConversionEdge from './edges/ConversionEdge';
import { useGraphStore } from '@/lib/useGraphStore';
import { toFlow, fromFlow } from '@/lib/transform';
import { generateSlugFromLabel, generateUniqueSlug } from '@/lib/slugUtils';

const nodeTypes: NodeTypes = {
  conversion: ConversionNode,
};

const edgeTypes: EdgeTypes = {
  conversion: ConversionEdge,
};

interface GraphCanvasProps {
  onSelectedNodeChange: (id: string | null) => void;
  onSelectedEdgeChange: (id: string | null) => void;
  onDoubleClickNode?: (id: string, field: string) => void;
  onDoubleClickEdge?: (id: string, field: string) => void;
  onSelectEdge?: (id: string) => void;
  edgeScalingMode: 'uniform' | 'local-mass' | 'global-mass';
  autoReroute: boolean;
}

export default function GraphCanvas({ onSelectedNodeChange, onSelectedEdgeChange, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, edgeScalingMode, autoReroute }: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner 
        onSelectedNodeChange={onSelectedNodeChange}
        onSelectedEdgeChange={onSelectedEdgeChange}
        onDoubleClickNode={onDoubleClickNode}
        onDoubleClickEdge={onDoubleClickEdge}
        onSelectEdge={onSelectEdge}
        edgeScalingMode={edgeScalingMode}
        autoReroute={autoReroute}
      />
    </ReactFlowProvider>
  );
}

function CanvasInner({ onSelectedNodeChange, onSelectedEdgeChange, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, edgeScalingMode, autoReroute }: GraphCanvasProps) {
  const { graph, setGraph } = useGraphStore();
  const { deleteElements, fitView, screenToFlowPosition, setCenter } = useReactFlow();
  
  // ReactFlow maintains local state for smooth interactions
  const [nodes, setNodes, onNodesChangeBase] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  
  // Trigger flag for re-routing
  const [shouldReroute, setShouldReroute] = useState(0);
  
  // Custom onNodesChange handler to detect position changes for auto re-routing
  const onNodesChange = useCallback((changes: any[]) => {
    console.log('onNodesChange called:', { 
      changeCount: changes.length, 
      autoReroute, 
      changeTypes: changes.map(c => ({ type: c.type, dragging: c.dragging }))
    });
    
    // Call the base handler first
    onNodesChangeBase(changes);
    
    // Check if any position changes occurred (when user finishes dragging)
    if (autoReroute) {
      const positionChanges = changes.filter(change => change.type === 'position' && change.dragging === false);
      console.log('Filtered position changes:', positionChanges.length);
      if (positionChanges.length > 0) {
        console.log('Position changes detected (dragging finished):', positionChanges);
        console.log('Setting shouldReroute flag');
        // Trigger re-routing by incrementing the flag
        setShouldReroute(prev => {
          console.log('shouldReroute incrementing from', prev, 'to', prev + 1);
          return prev + 1;
        });
      }
    }
  }, [onNodesChangeBase, autoReroute]);

  // Edge width calculation based on scaling mode
  const calculateEdgeWidth = useCallback((edge: any, allEdges: any[], allNodes: any[]) => {
    // MAX_WIDTH = node height - 2x corner radius = 60 - 16 = 44px
    const MAX_WIDTH = 44; // Node height (60px) minus 2x corner radius (8px each = 16px)
    const MIN_WIDTH = 2;
    
    console.log(`calculateEdgeWidth called for edge ${edge.id}, mode=${edgeScalingMode}`);
    
    if (edgeScalingMode === 'uniform') {
      return edge.selected ? 3 : 2;
    }
    
    if (edgeScalingMode === 'local-mass') {
      // Find all edges from the same source node
      const sourceEdges = allEdges.filter(e => e.source === edge.source);
      const totalProbability = sourceEdges.reduce((sum, e) => sum + (e.data?.probability || 0), 0);
      
      if (totalProbability === 0) return MIN_WIDTH;
      
      const edgeProbability = edge.data?.probability || 0;
      const proportion = edgeProbability / totalProbability;
      // Use a more dramatic scaling for better visibility
      const scaledWidth = MIN_WIDTH + (proportion * (MAX_WIDTH - MIN_WIDTH));
      const finalWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, scaledWidth));
      
      console.log(`Local mass edge ${edge.id}: prob=${edgeProbability}, total=${totalProbability}, proportion=${proportion.toFixed(2)}, width=${finalWidth.toFixed(1)} (MAX_WIDTH=${MAX_WIDTH})`);
      return finalWidth;
    }
    
    if (edgeScalingMode === 'global-mass') {
      // Global mass: scale based on residual probability as graph is traversed from start
      // Find the start node (node with entry.is_start = true or entry.entry_weight > 0)
      const startNode = allNodes.find(n => 
        n.data?.entry?.is_start === true || (n.data?.entry?.entry_weight || 0) > 0
      );
      
      console.log(`Global mass mode: startNode=`, startNode);
      
      if (!startNode) {
        console.log(`No start node found, falling back to local mass for edge ${edge.id}`);
        // Fallback to local mass if no clear start node
        const sourceEdges = allEdges.filter(e => e.source === edge.source);
        const totalProbability = sourceEdges.reduce((sum, e) => sum + (e.data?.probability || 0), 0);
        if (totalProbability === 0) return MIN_WIDTH;
        const edgeProbability = edge.data?.probability || 0;
        const proportion = edgeProbability / totalProbability;
        const scaledWidth = MIN_WIDTH + (proportion * (MAX_WIDTH - MIN_WIDTH));
        return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, scaledWidth));
      }
      
      // Calculate residual probability at the source node
      const residualAtSource = calculateResidualProbability(edge.source, allEdges, startNode.id);
      
      if (residualAtSource === 0) return MIN_WIDTH;
      
      // Sankey-style: actual mass flowing through this edge = p(source) × edge_probability
      const edgeProbability = edge.data?.probability || 0;
      const actualMassFlowing = residualAtSource * edgeProbability;
      
      // Width scales directly with actual mass flowing through
      const scaledWidth = MIN_WIDTH + (actualMassFlowing * (MAX_WIDTH - MIN_WIDTH));
      const finalWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, scaledWidth));
      
      console.log(`Global mass edge ${edge.id}: p(source)=${residualAtSource.toFixed(2)}, edgeProb=${edgeProbability.toFixed(2)}, actualMass=${actualMassFlowing.toFixed(2)}, width=${finalWidth.toFixed(1)} (MAX_WIDTH=${MAX_WIDTH})`);
      return finalWidth;
    }
    
    // Helper function to calculate residual probability
    function calculateResidualProbability(targetNode: string, allEdges: any[], startNode: string): number {
      // Build adjacency list and reverse adjacency list
      const outgoing: { [key: string]: any[] } = {};
      const incoming: { [key: string]: any[] } = {};
      allEdges.forEach(e => {
        if (!outgoing[e.source]) outgoing[e.source] = [];
        if (!incoming[e.target]) incoming[e.target] = [];
        outgoing[e.source].push(e);
        incoming[e.target].push(e);
      });
      
      // Use topological sort to calculate residual probability at each node
      const residualAtNode: { [key: string]: number } = {};
      const visited = new Set<string>();
      
      function dfs(node: string): number {
        if (visited.has(node)) {
          return residualAtNode[node] || 0;
        }
        visited.add(node);
        
        // If this is the start node, residual is 1.0
        if (node === startNode) {
          residualAtNode[node] = 1.0;
          return 1.0;
        }
        
        // Sum up probability mass from all incoming edges
        let totalIncoming = 0;
        const incomingEdges = incoming[node] || [];
        incomingEdges.forEach(edge => {
          const sourceResidual = dfs(edge.source);
          const edgeProbability = edge.data?.probability || 0;
          totalIncoming += sourceResidual * edgeProbability;
        });
        
        residualAtNode[node] = totalIncoming;
        return totalIncoming;
      }
      
      // Calculate residual for target node
      return dfs(targetNode);
    }
    
    return edge.selected ? 3 : 2;
  }, [edgeScalingMode]);
  
  // Track the last synced graph to detect real changes
  const lastSyncedGraphRef = useRef<string>('');
  const isSyncingRef = useRef(false);
  
  // Re-route feature state
  const lastNodePositionsRef = useRef<{ [nodeId: string]: { x: number; y: number } }>({});
  
  // Calculate optimal handles between two nodes
  const calculateOptimalHandles = useCallback((sourceNode: any, targetNode: any) => {
    const sourceX = sourceNode.position.x;
    const sourceY = sourceNode.position.y;
    const targetX = targetNode.position.x;
    const targetY = targetNode.position.y;
    
    // Node dimensions (from layout.ts: width: 160, height: 60)
    const nodeWidth = 160;
    const nodeHeight = 60;
    
    // Calculate relative positions
    const deltaX = targetX - sourceX;
    const deltaY = targetY - sourceY;
    
    // Determine optimal source handle based on direction
    let sourceHandle: string;
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      // Horizontal movement dominates
      sourceHandle = deltaX > 0 ? 'right-out' : 'left-out';
    } else {
      // Vertical movement dominates
      sourceHandle = deltaY > 0 ? 'bottom-out' : 'top-out';
    }
    
    // Determine optimal target handle based on direction
    let targetHandle: string;
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      // Horizontal movement dominates
      targetHandle = deltaX > 0 ? 'left' : 'right';
    } else {
      // Vertical movement dominates
      targetHandle = deltaY > 0 ? 'top' : 'bottom';
    }
    
    return { sourceHandle, targetHandle };
  }, []);
  
  // Perform immediate re-route of ALL edges (used when toggling on)
  const performImmediateReroute = useCallback(() => {
    if (!graph) {
      console.log('No graph, skipping immediate re-route');
      return;
    }
    
    console.log('Performing immediate re-route of ALL edges');
    
    const nextGraph = structuredClone(graph);
    let updatedCount = 0;
    
    // Re-route ALL edges
    nextGraph.edges.forEach((graphEdge: any) => {
      const sourceNode = nodes.find(n => n.id === graphEdge.from);
      const targetNode = nodes.find(n => n.id === graphEdge.to);
      
      if (sourceNode && targetNode) {
        const { sourceHandle, targetHandle } = calculateOptimalHandles(sourceNode, targetNode);
        
        console.log(`Re-routing edge ${graphEdge.id}:`, {
          from: graphEdge.from,
          to: graphEdge.to,
          oldFromHandle: graphEdge.fromHandle,
          newFromHandle: sourceHandle,
          oldToHandle: graphEdge.toHandle,
          newToHandle: targetHandle
        });
        
        graphEdge.fromHandle = sourceHandle;
        graphEdge.toHandle = targetHandle;
        updatedCount++;
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
  
  // Auto re-route edges when nodes move
  const performAutoReroute = useCallback(() => {
    if (!autoReroute || !graph) {
      console.log('Auto re-route skipped:', { autoReroute, hasGraph: !!graph });
      return;
    }
    
    const currentPositions: { [nodeId: string]: { x: number; y: number } } = {};
    const movedNodes: string[] = [];
    
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
          deltaY: currentPos.y - lastPos.y 
        });
      }
    });
    
    if (movedNodes.length === 0) {
      console.log('No nodes moved, skipping re-route');
      return;
    }
    
    console.log('Moved nodes:', movedNodes);
    
    // Update last positions
    lastNodePositionsRef.current = currentPositions;
    
    // Find edges that need re-routing
    const edgesToReroute = edges.filter(edge => 
      movedNodes.includes(edge.source) || movedNodes.includes(edge.target)
    );
    
    console.log('Edges to re-route:', edgesToReroute.map(e => e.id));
    
    if (edgesToReroute.length === 0) return;
    
    // Update graph with new handle positions
    const nextGraph = structuredClone(graph);
    
    edgesToReroute.forEach(edge => {
      const sourceNode = nodes.find(n => n.id === edge.source);
      const targetNode = nodes.find(n => n.id === edge.target);
      
      if (sourceNode && targetNode) {
        const { sourceHandle, targetHandle } = calculateOptimalHandles(sourceNode, targetNode);
        
        console.log(`Re-routing edge ${edge.id}:`, { 
          oldFromHandle: edge.sourceHandle, 
          newFromHandle: sourceHandle,
          oldToHandle: edge.targetHandle,
          newToHandle: targetHandle
        });
        
        // Find the edge in the graph and update its handles
        const graphEdge = nextGraph.edges.find(e => e.id === edge.id);
        if (graphEdge) {
          graphEdge.fromHandle = sourceHandle;
          graphEdge.toHandle = targetHandle;
        }
      }
    });
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    console.log('Updating graph with new handle positions');
    setGraph(nextGraph);
  }, [autoReroute, graph, nodes, edges, calculateOptimalHandles, setGraph]);
  
  // Reset position tracking and perform immediate re-route when autoReroute is toggled ON
  useEffect(() => {
    console.log('Auto re-route toggled:', autoReroute);
    if (autoReroute) {
      // Initialize position tracking when enabling
      console.log('Initializing position tracking and performing immediate re-route');
      const initialPositions: { [nodeId: string]: { x: number; y: number } } = {};
      nodes.forEach(node => {
        initialPositions[node.id] = { x: node.position.x, y: node.position.y };
      });
      lastNodePositionsRef.current = initialPositions;
      
      // Perform immediate re-route when toggling on (with a small delay to ensure state is ready)
      console.log('Triggering immediate re-route on toggle');
      if (graph && nodes.length > 0 && edges.length > 0) {
        // Use setTimeout to break out of the render cycle
        setTimeout(() => {
          performImmediateReroute();
        }, 50);
      }
    } else {
      // Clear position tracking when disabling
      lastNodePositionsRef.current = {};
    }
  }, [autoReroute]); // ONLY depend on autoReroute, not nodes/edges/graph!
  
  // Perform re-routing when shouldReroute flag changes (with small delay after node movement)
  useEffect(() => {
    if (shouldReroute > 0 && autoReroute) {
      console.log('Re-route triggered by flag change:', shouldReroute);
      // Add a small delay to ensure node positions are fully updated
      const timeoutId = setTimeout(() => {
        console.log('Executing delayed re-route after node movement');
        performAutoReroute();
      }, 100); // 100ms delay after user finishes dragging
      
      return () => clearTimeout(timeoutId);
    }
  }, [shouldReroute, autoReroute, performAutoReroute]);
  
  // Get all existing slugs (nodes and edges) for uniqueness checking
  const getAllExistingSlugs = useCallback((excludeId?: string) => {
    if (!graph) return [];
    
    const nodeSlugs = graph.nodes
      .filter((node: any) => node.id !== excludeId)
      .map((node: any) => node.slug)
      .filter(Boolean);
    
    const edgeSlugs = graph.edges
      .filter((edge: any) => edge.id !== excludeId)
      .map((edge: any) => edge.slug)
      .filter(Boolean);
    
    return [...nodeSlugs, ...edgeSlugs];
  }, [graph]);
  
  // Callback functions for node/edge updates
  const handleUpdateNode = useCallback((id: string, data: any) => {
    console.log('handleUpdateNode called:', { id, data });
    setGraph((prevGraph) => {
      if (!prevGraph) return prevGraph;
      
      // Check for slug uniqueness if slug is being updated
      if (data.slug) {
        const existingSlugs = getAllExistingSlugs(id);
        if (existingSlugs.includes(data.slug)) {
          alert(`Slug "${data.slug}" is already in use. Please choose a different slug.`);
          return prevGraph;
        }
      }
      
      const nextGraph = structuredClone(prevGraph);
      const nodeIndex = nextGraph.nodes.findIndex(n => n.id === id);
      if (nodeIndex >= 0) {
        nextGraph.nodes[nodeIndex] = { ...nextGraph.nodes[nodeIndex], ...data };
        nextGraph.metadata.updated_at = new Date().toISOString();
        console.log('Updated node in graph:', nextGraph.nodes[nodeIndex]);
      }
      return nextGraph;
    });
  }, [setGraph, getAllExistingSlugs]);

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
    
    const nextGraph = structuredClone(graph);
    nextGraph.nodes = nextGraph.nodes.filter(n => n.id !== id);
    nextGraph.edges = nextGraph.edges.filter(e => e.from !== id && e.to !== id);
    
    // Ensure metadata exists and update it
    if (!nextGraph.metadata) {
      nextGraph.metadata = {};
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
    
    // Update the graph (this will trigger the graph->ReactFlow sync which will update lastSyncedGraphRef)
    setGraph(nextGraph);
    
    // Clear selection when node is deleted
    onSelectedNodeChange(null);
  }, [graph, setGraph, onSelectedNodeChange]);

  const handleUpdateEdge = useCallback((id: string, data: any) => {
    setGraph((prevGraph) => {
      if (!prevGraph) return prevGraph;
      
      // Check for slug uniqueness if slug is being updated
      if (data.slug) {
        const existingSlugs = getAllExistingSlugs(id);
        if (existingSlugs.includes(data.slug)) {
          alert(`Slug "${data.slug}" is already in use. Please choose a different slug.`);
          return prevGraph;
        }
      }
      
      const nextGraph = structuredClone(prevGraph);
      const edgeIndex = nextGraph.edges.findIndex(e => e.id === id);
      if (edgeIndex >= 0) {
        nextGraph.edges[edgeIndex] = { ...nextGraph.edges[edgeIndex], ...data };
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      return nextGraph;
    });
  }, [setGraph, getAllExistingSlugs]);

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
      nextGraph.metadata = {};
    }
    nextGraph.metadata.updated_at = new Date().toISOString();
    
    // Clear the sync flag to allow graph->ReactFlow sync
    isSyncingRef.current = false;
    
    // Update the graph (this will trigger the graph->ReactFlow sync which will update lastSyncedGraphRef)
    setGraph(nextGraph);
    
    // Clear selection when edge is deleted
    onSelectedEdgeChange(null);
  }, [graph, setGraph, onSelectedEdgeChange]);

  // Delete selected elements
  const deleteSelected = useCallback(() => {
    const selectedNodes = nodes.filter(n => n.selected);
    const selectedEdges = edges.filter(e => e.selected);
    
    console.log('deleteSelected called with:', selectedNodes.length, 'nodes and', selectedEdges.length, 'edges');
    
    // Delete selected nodes (which will cascade delete their edges)
    selectedNodes.forEach(node => {
      console.log('Deleting node:', node.id);
      handleDeleteNode(node.id);
    });
    
    // Delete any remaining selected edges
    selectedEdges.forEach(edge => {
      console.log('Deleting edge:', edge.id);
      handleDeleteEdge(edge.id);
    });
  }, [nodes, edges, handleDeleteNode, handleDeleteEdge]);

  // Sync FROM graph TO ReactFlow when graph changes externally
  useEffect(() => {
    if (!graph) return;
    if (isSyncingRef.current) {
      console.log('Skipping graph->ReactFlow sync (isSyncingRef=true)');
      return;
    }
    
    const graphJson = JSON.stringify(graph);
    if (graphJson === lastSyncedGraphRef.current) {
      console.log('Skipping graph->ReactFlow sync (no changes)');
      return;
    }
    
    console.log('=== Syncing graph -> ReactFlow ===');
    lastSyncedGraphRef.current = graphJson;
    const { nodes: newNodes, edges: newEdges } = toFlow(graph, {
      onUpdateNode: handleUpdateNode,
      onDeleteNode: handleDeleteNode,
      onUpdateEdge: handleUpdateEdge,
      onDeleteEdge: handleDeleteEdge,
      onDoubleClickNode: onDoubleClickNode,
      onDoubleClickEdge: onDoubleClickEdge,
      onSelectEdge: onSelectEdge,
    });
    
    // Add edge width calculation to each edge
    const edgesWithWidth = newEdges.map(edge => ({
      ...edge,
      data: {
        ...edge.data,
        calculateWidth: () => calculateEdgeWidth(edge, newEdges, newNodes)
      }
    }));
    
    setNodes(newNodes);
    setEdges(edgesWithWidth);
  }, [graph, setNodes, setEdges, handleUpdateNode, handleDeleteNode, handleUpdateEdge, handleDeleteEdge, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, calculateEdgeWidth]);

  // Update edge widths when scaling mode changes
  useEffect(() => {
    if (edges.length === 0) return;
    
    // Force re-render of edges by updating their data
    setEdges(prevEdges => 
      prevEdges.map(edge => ({
        ...edge,
        data: {
          ...edge.data,
          calculateWidth: () => calculateEdgeWidth(edge, prevEdges, nodes)
        }
      }))
    );
  }, [edgeScalingMode, calculateEdgeWidth, nodes]);
  
  // Sync FROM ReactFlow TO graph when user makes changes in the canvas
  // NOTE: This should NOT depend on 'graph' to avoid syncing when graph changes externally
  useEffect(() => {
    if (!graph) return;
    if (isSyncingRef.current) {
      console.log('Skipping ReactFlow->graph sync (isSyncingRef=true)');
      return;
    }
    if (nodes.length === 0 && graph.nodes.length > 0) {
      console.log('Skipping ReactFlow->graph sync (still initializing)');
      return;
    }
    
    const updatedGraph = fromFlow(nodes, edges, graph);
    if (updatedGraph) {
      const updatedJson = JSON.stringify(updatedGraph);
      if (updatedJson === lastSyncedGraphRef.current) {
        console.log('Skipping ReactFlow->graph sync (no changes)');
        return;
      }
      
      console.log('=== Syncing ReactFlow -> graph ===');
      isSyncingRef.current = true;
      lastSyncedGraphRef.current = updatedJson;
      setGraph(updatedGraph);
      
      // Reset sync flag
      setTimeout(() => {
        isSyncingRef.current = false;
      }, 0);
    }
  }, [nodes, edges]); // Removed 'graph' and 'setGraph' from dependencies

  // Function to check if adding an edge would create a cycle
  const wouldCreateCycle = useCallback((source: string, target: string, currentEdges: any[]) => {
    // Create a directed graph representation
    const graph: { [key: string]: string[] } = {};
    
    // Initialize all nodes
    nodes.forEach(node => {
      graph[node.id] = [];
    });
    
    // Add existing edges
    currentEdges.forEach(edge => {
      if (graph[edge.source]) {
        graph[edge.source].push(edge.target);
      }
    });
    
    // Add the proposed new edge
    if (graph[source]) {
      graph[source].push(target);
    }
    
    // DFS to detect cycles
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    
    const hasCycleDFS = (node: string): boolean => {
      if (recursionStack.has(node)) {
        return true; // Cycle detected
      }
      
      if (visited.has(node)) {
        return false; // Already processed
      }
      
      visited.add(node);
      recursionStack.add(node);
      
      const neighbors = graph[node] || [];
      for (const neighbor of neighbors) {
        if (hasCycleDFS(neighbor)) {
          return true;
        }
      }
      
      recursionStack.delete(node);
      return false;
    };
    
    // Check all nodes for cycles
    for (const nodeId of Object.keys(graph)) {
      if (!visited.has(nodeId)) {
        if (hasCycleDFS(nodeId)) {
          return true;
        }
      }
    }
    
    return false;
  }, [nodes]);

  // Generate a unique slug for an edge based on node slugs
  const generateEdgeSlug = useCallback((sourceId: string, targetId: string) => {
    if (!graph?.nodes) return `${sourceId}-to-${targetId}`;
    
    // Find source and target nodes to get their slugs
    const sourceNode = graph.nodes.find((n: any) => n.id === sourceId);
    const targetNode = graph.nodes.find((n: any) => n.id === targetId);
    
    const sourceSlug = sourceNode?.slug || sourceNode?.id || sourceId;
    const targetSlug = targetNode?.slug || targetNode?.id || targetId;
    
    let baseSlug = `${sourceSlug}-to-${targetSlug}`;
    let slug = baseSlug;
    let counter = 1;
    
    // Ensure uniqueness by appending a number if needed
    const existingSlugs = getAllExistingSlugs();
    const uniqueSlug = generateUniqueSlug(baseSlug, existingSlugs);
    
    return uniqueSlug;
  }, [graph, getAllExistingSlugs]);

  // Handle new connections
  const onConnect = useCallback((connection: Connection) => {
    if (!graph) return;
    
    // Check for valid connection
    if (!connection.source || !connection.target) {
      return;
    }
    
    // Prevent self-referencing edges
    if (connection.source === connection.target) {
      alert('Cannot create an edge from a node to itself.');
      return;
    }

    // Prevent duplicate edges
    const existingEdge = graph.edges.find(edge => 
      edge.from === connection.source && edge.to === connection.target
    );
    if (existingEdge) {
      alert('An edge already exists between these nodes.');
      return;
    }

    // Check for circular dependencies (convert graph edges to ReactFlow format for check)
    const reactFlowEdges = graph.edges.map(e => ({ source: e.from, target: e.to }));
    if (wouldCreateCycle(connection.source, connection.target, reactFlowEdges)) {
      alert('Cannot create this connection as it would create a circular dependency.');
      return;
    }

    // Generate a sensible slug for the edge
    const edgeSlug = generateEdgeSlug(connection.source, connection.target);
    const edgeId = `${connection.source}->${connection.target}`;

    // Add edge directly to graph state (not ReactFlow state)
    const nextGraph = structuredClone(graph);
    nextGraph.edges.push({
      id: edgeId,
      slug: edgeSlug,
      from: connection.source,
      to: connection.target,
      fromHandle: connection.sourceHandle,
      toHandle: connection.targetHandle,
      p: {
        mean: 0.5
      }
    });
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Update graph state - this will trigger graph->ReactFlow sync
    setGraph(nextGraph);
    
    // Select the new edge after a brief delay to allow sync to complete
    setTimeout(() => {
      onSelectedEdgeChange(edgeId);
    }, 50);
  }, [graph, setGraph, generateEdgeSlug, wouldCreateCycle, onSelectedEdgeChange]);


  // Handle Shift+Drag lasso selection
  const [isLassoSelecting, setIsLassoSelecting] = useState(false);
  const [lassoStart, setLassoStart] = useState<{ x: number; y: number } | null>(null);
  const [lassoEnd, setLassoEnd] = useState<{ x: number; y: number } | null>(null);
  const [isShiftHeld, setIsShiftHeld] = useState(false);

  // Track Shift key state and handle mouse events globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftHeld(true);
      }
      
      // Handle Delete key for selected elements (only when not editing)
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Don't handle if user is typing in form fields
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
          return;
        }
        
        const selectedNodes = nodes.filter(n => n.selected);
        const selectedEdges = edges.filter(e => e.selected);
        
        console.log('Delete key pressed, selected nodes:', selectedNodes.length, 'selected edges:', selectedEdges.length);
        
        if (selectedNodes.length > 0 || selectedEdges.length > 0) {
          e.preventDefault();
          if (confirm(`Delete ${selectedNodes.length} node(s) and ${selectedEdges.length} edge(s)?`)) {
            console.log('Calling deleteSelected');
            deleteSelected();
          }
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftHeld(false);
        setIsLassoSelecting(false);
        setLassoStart(null);
        setLassoEnd(null);
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (isShiftHeld && e.target && (e.target as Element).closest('.react-flow')) {
        e.preventDefault();
        e.stopPropagation();
        setIsLassoSelecting(true);
        setLassoStart({ x: e.clientX, y: e.clientY });
        setLassoEnd({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (isLassoSelecting && lassoStart) {
        e.preventDefault();
        e.stopPropagation();
        setLassoEnd({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (isLassoSelecting && lassoStart && lassoEnd) {
        e.preventDefault();
        e.stopPropagation();
        
        // Use ReactFlow's built-in coordinate conversion
        const flowStart = screenToFlowPosition({ x: lassoStart.x, y: lassoStart.y });
        const flowEnd = screenToFlowPosition({ x: lassoEnd.x, y: lassoEnd.y });
        
        const flowStartX = flowStart.x;
        const flowStartY = flowStart.y;
        const flowEndX = flowEnd.x;
        const flowEndY = flowEnd.y;
        
        const lassoRect = {
          left: Math.min(flowStartX, flowEndX),
          top: Math.min(flowStartY, flowEndY),
          right: Math.max(flowStartX, flowEndX),
          bottom: Math.max(flowStartY, flowEndY)
        };

        const selectedNodes = nodes.filter(node => {
          const nodeRect = {
            left: node.position.x,
            top: node.position.y,
            right: node.position.x + 120, // Approximate node width
            bottom: node.position.y + 60  // Approximate node height
          };

          const intersects = !(nodeRect.right < lassoRect.left || 
                             nodeRect.left > lassoRect.right || 
                             nodeRect.bottom < lassoRect.top || 
                             nodeRect.top > lassoRect.bottom);
          
          console.log(`Node ${node.id}:`, {
            nodeRect: {
              left: nodeRect.left,
              top: nodeRect.top,
              right: nodeRect.right,
              bottom: nodeRect.bottom
            },
            lassoRect: {
              left: lassoRect.left,
              top: lassoRect.top,
              right: lassoRect.right,
              bottom: lassoRect.bottom
            },
            intersects
          });

          return intersects;
        });

        console.log('Lasso selection:', {
          lassoRect,
          selectedNodes: selectedNodes.map(n => n.id),
          allNodes: nodes.map(n => ({ id: n.id, position: n.position })),
          screenCoords: {
            start: { x: lassoStart.x, y: lassoStart.y },
            end: { x: lassoEnd.x, y: lassoEnd.y }
          },
          flowCoords: {
            start: { x: flowStartX, y: flowStartY },
            end: { x: flowEndX, y: flowEndY }
          }
        });

        // Store the selected node IDs for persistence
        const selectedNodeIds = selectedNodes.map(n => n.id);
        
        // Update nodes with selection state
        setNodes(prevNodes => 
          prevNodes.map(n => ({ 
            ...n, 
            selected: selectedNodeIds.includes(n.id)
          }))
        );
        
        // Force the selection to persist by re-applying it after a short delay
        setTimeout(() => {
          setNodes(prevNodes => 
            prevNodes.map(n => ({ 
              ...n, 
              selected: selectedNodeIds.includes(n.id)
            }))
          );
        }, 50);
        
        // Delay resetting lasso state
        setTimeout(() => {
          setIsLassoSelecting(false);
          setLassoStart(null);
          setLassoEnd(null);
        }, 200);
      } else {
        setIsLassoSelecting(false);
        setLassoStart(null);
        setLassoEnd(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('mousemove', handleMouseMove, true);
    window.addEventListener('mouseup', handleMouseUp, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('mousemove', handleMouseMove, true);
      window.removeEventListener('mouseup', handleMouseUp, true);
    };
  }, [isShiftHeld, isLassoSelecting, lassoStart, lassoEnd, nodes, setNodes, edges, deleteSelected]);


  // Track selected nodes for probability calculation
  const [selectedNodesForAnalysis, setSelectedNodesForAnalysis] = useState<any[]>([]);

  // Calculate probability and cost for selected nodes
  const calculateSelectionAnalysis = useCallback(() => {
    if (selectedNodesForAnalysis.length === 0) return null;

    const selectedNodeIds = selectedNodesForAnalysis.map(n => n.id);
    
    // Find all edges between selected nodes
    const internalEdges = edges.filter(edge => 
      selectedNodeIds.includes(edge.source) && selectedNodeIds.includes(edge.target)
    );
    
    // Find edges entering the selection
    const incomingEdges = edges.filter(edge => 
      !selectedNodeIds.includes(edge.source) && selectedNodeIds.includes(edge.target)
    );
    
    // Find edges leaving the selection (source is in selection, target is not)
    const outgoingEdges = edges.filter(edge => 
      selectedNodeIds.includes(edge.source) && !selectedNodeIds.includes(edge.target)
    );
    
    console.log('Edge classification debug:', {
      selectedNodeIds,
      allEdges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, sourceInSelection: selectedNodeIds.includes(e.source), targetInSelection: selectedNodeIds.includes(e.target) })),
      incomingEdges: incomingEdges.map(e => e.id),
      outgoingEdges: outgoingEdges.map(e => e.id)
    });

    // Calculate total probability mass
    const totalIncomingProbability = incomingEdges.reduce((sum, edge) => {
      const prob = edge.data?.probability || 0;
      console.log(`Incoming edge ${edge.id}: probability = ${prob}`);
      return sum + prob;
    }, 0);
    
    const totalOutgoingProbability = outgoingEdges.reduce((sum, edge) => {
      const prob = edge.data?.probability || 0;
      console.log(`Outgoing edge ${edge.id}: probability = ${prob}`);
      return sum + prob;
    }, 0);

    console.log('Probability calculation:', {
      totalIncomingProbability,
      totalOutgoingProbability,
      incomingEdges: incomingEdges.map(e => ({ id: e.id, prob: e.data?.probability })),
      outgoingEdges: outgoingEdges.map(e => ({ id: e.id, prob: e.data?.probability }))
    });

    // Calculate total costs
    const totalCosts = {
      monetary: 0,
      time: 0,
      units: ''
    };

    [...internalEdges, ...outgoingEdges].forEach(edge => {
      if (edge.data?.costs) {
        totalCosts.monetary += edge.data.costs.monetary || 0;
        totalCosts.time += edge.data.costs.time || 0;
        if (edge.data.costs.units && !totalCosts.units) {
          totalCosts.units = edge.data.costs.units;
        }
      }
    });

    return {
      selectedNodes: selectedNodesForAnalysis.length,
      internalEdges: internalEdges.length,
      incomingEdges: incomingEdges.length,
      outgoingEdges: outgoingEdges.length,
      totalIncomingProbability,
      totalOutgoingProbability,
      totalCosts,
      probabilityConservation: Math.abs(totalIncomingProbability - totalOutgoingProbability) < 0.001
    };
  }, [selectedNodesForAnalysis, edges]);

  const analysis = calculateSelectionAnalysis();

  // Handle selection changes
  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: any) => {
    console.log('Selection changed:', { 
      nodes: selectedNodes.map(n => n.id), 
      edges: selectedEdges.map(e => e.id) 
    });
    
    // Update selected nodes for analysis
    setSelectedNodesForAnalysis(selectedNodes);
    
    // Don't clear selection if we just finished a lasso selection
    if (isLassoSelecting) {
      console.log('Ignoring selection change during lasso selection');
      return;
    }
    
    // For multi-selection, we'll show the first selected item in the properties panel
    // but keep track of all selected items for operations like delete
    if (selectedNodes.length > 0) {
      onSelectedNodeChange(selectedNodes[0].id);
      onSelectedEdgeChange(null);
    } else if (selectedEdges.length > 0) {
      onSelectedEdgeChange(selectedEdges[0].id);
      onSelectedNodeChange(null);
    } else {
      onSelectedNodeChange(null);
      onSelectedEdgeChange(null);
    }
  }, [onSelectedNodeChange, onSelectedEdgeChange, isLassoSelecting]);

  // Add new node
  const addNode = useCallback(() => {
    if (!graph) return;
    
    const newId = crypto.randomUUID();
    
    // Generate initial label and slug
    const label = `Node ${graph.nodes.length + 1}`;
    const baseSlug = generateSlugFromLabel(label);
    
    // Get all existing slugs to ensure uniqueness from the graph state
    const existingSlugs = getAllExistingSlugs();
    const slug = generateUniqueSlug(baseSlug, existingSlugs);
    
    // Add node directly to graph state (not ReactFlow state)
    const nextGraph = structuredClone(graph);
    nextGraph.nodes.push({
      id: newId,
      slug: slug,
      label: label,
      absorbing: false,
      layout: {
        x: Math.random() * 400 + 100,
        y: Math.random() * 300 + 100
      }
    });
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Update graph state - this will trigger graph->ReactFlow sync
    setGraph(nextGraph);
    
    // Select the new node after a brief delay to allow sync to complete
    setTimeout(() => {
      onSelectedNodeChange(newId);
    }, 50);
  }, [graph, setGraph, generateSlugFromLabel, generateUniqueSlug, getAllExistingSlugs, onSelectedNodeChange]);


  if (!graph) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      Loading...
    </div>;
  }

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        selectionOnDrag={false}
        selectNodesOnDrag={false}
        selectionKeyCode={['Meta', 'Ctrl']}
        nodesDraggable
        nodesConnectable
        elementsSelectable
        panOnDrag={!isLassoSelecting}
        style={{ background: '#f8f9fa' }}
        onInit={() => setTimeout(() => fitView(), 100)}
      >
        <Background />
        <Controls />
        <MiniMap />
        
        {/* Lasso selection rectangle */}
        {isLassoSelecting && lassoStart && lassoEnd && (
          <div
            style={{
              position: 'absolute',
              left: Math.min(lassoStart.x, lassoEnd.x),
              top: Math.min(lassoStart.y, lassoEnd.y),
              width: Math.abs(lassoEnd.x - lassoStart.x),
              height: Math.abs(lassoEnd.y - lassoStart.y),
              border: '2px dashed #007bff',
              background: 'rgba(0, 123, 255, 0.1)',
              pointerEvents: 'none',
              zIndex: 1000,
            }}
          />
        )}
        
        <Panel position="top-left">
          <button
            onClick={addNode}
            style={{
              padding: '8px 16px',
              background: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              marginRight: '8px',
            }}
          >
            + Add Node
          </button>
          <button
            onClick={deleteSelected}
            style={{
              padding: '8px 16px',
              background: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Delete Selected
          </button>
        </Panel>

        {/* Selection Analysis Popup */}
        {analysis && (
          <Panel position="bottom-left">
            <div style={{
              background: 'white',
              border: '2px solid #007bff',
              borderRadius: '8px',
              padding: '16px',
              minWidth: '300px',
              maxWidth: '400px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              fontSize: '14px',
              lineHeight: '1.4'
            }}>
              <h3 style={{ margin: '0 0 12px 0', color: '#007bff', fontSize: '16px' }}>
                Selection Analysis
              </h3>
              
              <div style={{ marginBottom: '8px' }}>
                <strong>Nodes:</strong> {analysis.selectedNodes} selected
              </div>
              
              <div style={{ marginBottom: '8px' }}>
                <strong>Edges:</strong> {analysis.internalEdges} internal, {analysis.incomingEdges} incoming, {analysis.outgoingEdges} outgoing
              </div>
              
              <div style={{ marginBottom: '8px' }}>
                <strong>Probability Flow:</strong>
                <div style={{ marginLeft: '12px', fontSize: '12px' }}>
                  In: {Math.round(analysis.totalIncomingProbability * 100)}% → Out: {Math.round(analysis.totalOutgoingProbability * 100)}%
                </div>
                {analysis.totalOutgoingProbability === 0 && analysis.totalIncomingProbability > 0 ? (
                  <div style={{ color: '#16a34a', fontSize: '12px', marginTop: '4px' }}>
                    ✅ Complete path selected - probability contained within selection
                  </div>
                ) : !analysis.probabilityConservation ? (
                  <div style={{ color: '#ff6b6b', fontSize: '12px', marginTop: '4px' }}>
                    ⚠️ Probability not conserved
                  </div>
                ) : (
                  <div style={{ color: '#16a34a', fontSize: '12px', marginTop: '4px' }}>
                    ✅ Probability conserved
                  </div>
                )}
              </div>
              
              {(analysis.totalCosts.monetary > 0 || analysis.totalCosts.time > 0) && (
                <div style={{ marginBottom: '8px' }}>
                  <strong>Total Costs:</strong>
                  <div style={{ marginLeft: '12px', fontSize: '12px' }}>
                    {analysis.totalCosts.monetary > 0 && (
                      <div>£{analysis.totalCosts.monetary}{analysis.totalCosts.units && ` ${analysis.totalCosts.units}`}</div>
                    )}
                    {analysis.totalCosts.time > 0 && (
                      <div>{analysis.totalCosts.time}h{analysis.totalCosts.units && ` ${analysis.totalCosts.units}`}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}
