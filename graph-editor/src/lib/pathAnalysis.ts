/**
 * Path Analysis Library
 * 
 * Core algorithms for calculating probabilities and costs through graph paths.
 * Used by:
 * - Quick Runner (user Cmd+Clicks nodes for path analysis)
 * - What-If Analysis (applies what-if overrides to path calculations)
 * - Runner (simulation engine)
 * 
 * Key Principles:
 * 1. What-If overrides applied FIRST (base scenario)
 * 2. Path selection applied SECOND (additional constraints)
 * 3. One code path for all pruning/renormalization
 */

import { computeEffectiveEdgeProbability, WhatIfOverrides } from './whatIf';
import { computeGraphPruning, PruningResult } from './graphPruning';

/**
 * Result of path probability calculation
 */
export interface PathResult {
  probability: number;
  expectedCosts: {
    monetary: number;
    time: number;
    units: string;
  };
}

/**
 * Node reference (can be full node object or just ID)
 */
export interface NodeRef {
  id: string;
  [key: string]: any;
}

/**
 * Edge reference from ReactFlow
 */
export interface EdgeRef {
  id: string;
  source: string;
  target: string;
  data?: any;
  [key: string]: any;
}

/**
 * Find all start nodes in the graph
 * Start nodes have entry.is_start = true or entry.entry_weight > 0
 */
export function findStartNodes(nodes: NodeRef[]): NodeRef[] {
  return nodes.filter(node => 
    node.data?.entry?.is_start === true || 
    (node.data?.entry?.entry_weight || 0) > 0
  );
}

/**
 * Find all end/absorbing nodes in the graph
 * End nodes have absorbing = true OR no outgoing edges
 */
export function findEndNodes(nodes: NodeRef[], edges: EdgeRef[]): NodeRef[] {
  return nodes.filter(node => {
    const hasOutgoingEdges = edges.some(edge => edge.source === node.id);
    return node.data?.absorbing === true || !hasOutgoingEdges;
  });
}

/**
 * Check if a node is an end node
 */
export function isEndNode(node: NodeRef, edges: EdgeRef[]): boolean {
  const hasOutgoingEdges = edges.some(edge => edge.source === node.id);
  return node.data?.absorbing === true || !hasOutgoingEdges;
}

/**
 * Topological sort using Kahn's algorithm
 * Returns nodes in topological order (dependencies before dependents)
 */
export function topologicalSort(nodeIds: string[], edges: EdgeRef[]): string[] {
  // Filter edges to only those between selected nodes
  const relevantEdges = edges.filter(e => 
    nodeIds.includes(e.source) && nodeIds.includes(e.target)
  );
  
  // Build adjacency list and in-degree map
  const adjList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  
  // Initialize
  nodeIds.forEach(id => {
    adjList.set(id, []);
    inDegree.set(id, 0);
  });
  
  // Build graph
  relevantEdges.forEach(edge => {
    adjList.get(edge.source)!.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
  });
  
  // Kahn's algorithm
  const queue: string[] = [];
  const sorted: string[] = [];
  
  // Start with nodes that have no incoming edges
  nodeIds.forEach(id => {
    if (inDegree.get(id) === 0) {
      queue.push(id);
    }
  });
  
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    
    const neighbors = adjList.get(current) || [];
    neighbors.forEach(neighbor => {
      const newInDegree = (inDegree.get(neighbor) || 0) - 1;
      inDegree.set(neighbor, newInDegree);
      
      if (newInDegree === 0) {
        queue.push(neighbor);
      }
    });
  }
  
  // If sorted length doesn't match input, there's a cycle
  // Return best-effort sort
  if (sorted.length < nodeIds.length) {
    // Add remaining nodes in original order
    nodeIds.forEach(id => {
      if (!sorted.includes(id)) {
        sorted.push(id);
      }
    });
  }
  
  return sorted;
}

/**
 * Check if nodes are topologically sequential
 * Sequential means each node has a direct edge to the next in topological order
 */
export function areNodesTopologicallySequential(
  sortedNodeIds: string[], 
  edges: EdgeRef[]
): boolean {
  if (sortedNodeIds.length < 2) return true;
  
  for (let i = 0; i < sortedNodeIds.length - 1; i++) {
    const current = sortedNodeIds[i];
    const next = sortedNodeIds[i + 1];
    
    // Check if there's a direct edge from current to next
    const hasDirectEdge = edges.some(edge => 
      edge.source === current && edge.target === next
    );
    
    if (!hasDirectEdge) {
      return false;
    }
  }
  
  return true;
}

/**
 * Calculate path probability and costs from start to end
 * 
 * Uses DFS with memoization to handle:
 * - Multiple paths
 * - Cycles
 * - Conditional probabilities
 * - What-if overrides
 * - Pruning/renormalization
 * 
 * @param graph - Raw graph data
 * @param edges - ReactFlow edges (for ReactFlow-specific data)
 * @param startId - Start node ID
 * @param endId - End node ID
 * @param whatIfOverrides - What-if overrides (applied to probabilities)
 * @param givenVisitedNodeIds - Nodes guaranteed to be visited (for conditional activation)
 * @param pruningResult - Pre-computed pruning (optional)
 * @returns Path probability and expected costs
 */
export function calculatePathProbability(
  graph: any,
  edges: EdgeRef[],
  startId: string,
  endId: string,
  whatIfOverrides: WhatIfOverrides,
  givenVisitedNodeIds?: string[],
  pruningResult?: PruningResult
): PathResult {
  // Use pre-computed pruning if provided, otherwise no pruning
  const excludedEdges = pruningResult?.excludedEdges || new Set<string>();
  const renormFactors = pruningResult?.renormFactors || new Map<string, number>();
  
  // Build set of nodes guaranteed to be visited in this path context
  const givenNodesSet = givenVisitedNodeIds ? new Set(givenVisitedNodeIds) : new Set<string>();
  
  // DFS for cost calculation
  const visited = new Set<string>();
  const costs: { [nodeId: string]: { monetary: number, time: number, units: string } } = {};
  
  const calculateCost = (nodeId: string, currentPathContext: Set<string>): { monetary: number, time: number, units: string } => {
    // Check if already visited (cycle detection)
    if (visited.has(nodeId)) {
      return costs[nodeId] || { monetary: 0, time: 0, units: '' };
    }
    
    // Check if it's the end node
    if (nodeId === endId) {
      costs[nodeId] = { monetary: 0, time: 0, units: '' };
      return costs[nodeId];
    }
    
    visited.add(nodeId);
    let totalCost = { monetary: 0, time: 0, units: '' };
    
    // Find all outgoing edges from current node (excluding pruned edges)
    const outgoingEdges = edges.filter(edge => edge.source === nodeId && !excludedEdges.has(edge.id));
    
    for (const edge of outgoingEdges) {
      // Build path context for THIS edge: includes given nodes + all nodes visited so far
      const edgePathContext = new Set([...givenNodesSet, ...currentPathContext]);
      
      // Get effective probability (with what-if overrides)
      let edgeProbability = computeEffectiveEdgeProbability(
        graph, 
        edge.id, 
        whatIfOverrides, 
        edgePathContext
      );
      
      // Apply renormalization if siblings were pruned
      const renormFactor = renormFactors.get(edge.id);
      if (renormFactor) {
        edgeProbability *= renormFactor;
      }
      
      // Update path context to include the target node we're about to visit
      const nextPathContext = new Set([...edgePathContext, edge.target]);
      
      // Get cost from target node (recursive) with updated path context
      const targetCost = calculateCost(edge.target, nextPathContext);
      
      // Calculate probability-weighted cost (using new flat schema)
      const edgeCost = {
        monetary: edge.data?.cost_gbp?.mean || 0,
        time: edge.data?.cost_time?.mean || 0,
        units: 'days' // Units now implicit: GBP and days
      };
      
      totalCost.monetary += edgeProbability * (edgeCost.monetary + targetCost.monetary);
      totalCost.time += edgeProbability * (edgeCost.time + targetCost.time);
      totalCost.units = totalCost.units || edgeCost.units;
    }
    
    costs[nodeId] = totalCost;
    return totalCost;
  };
  
  // Start DFS with initial path context (given nodes + start node)
  const initialContext = new Set([...givenNodesSet, startId]);
  const expectedCosts = calculateCost(startId, initialContext);
  
  // Calculate total probability using memoized DFS to avoid infinite recursion
  const probabilityCache = new Map<string, number>();
  const probVisited = new Set<string>();
  
  const calculateProbability = (nodeId: string, currentPathContext: Set<string>): number => {
    if (nodeId === endId) return 1;
    
    // Cache key includes path context to handle different contexts correctly
    const cacheKey = `${nodeId}|${Array.from(currentPathContext).sort().join(',')}`;
    if (probabilityCache.has(cacheKey)) {
      return probabilityCache.get(cacheKey)!;
    }
    
    // Detect cycles
    if (probVisited.has(nodeId)) {
      return 0;
    }
    
    probVisited.add(nodeId);
    
    let totalProbability = 0;
    // Use pruned edge set (excluding unselected siblings)
    const outgoingEdges = edges.filter(edge => edge.source === nodeId && !excludedEdges.has(edge.id));
    
    for (const edge of outgoingEdges) {
      // Build path context for this edge
      const edgePathContext = new Set([...givenNodesSet, ...currentPathContext]);
      
      // Get effective probability (with what-if overrides)
      let edgeProbability = computeEffectiveEdgeProbability(
        graph, 
        edge.id, 
        whatIfOverrides, 
        edgePathContext
      );
      
      // Apply renormalization if siblings were pruned
      const renormFactor = renormFactors.get(edge.id);
      if (renormFactor) {
        edgeProbability *= renormFactor;
      }
      
      // Update path context to include target node
      const nextPathContext = new Set([...currentPathContext, edge.target]);
      const targetProbability = calculateProbability(edge.target, nextPathContext);
      totalProbability += edgeProbability * targetProbability;
    }
    
    probVisited.delete(nodeId);
    probabilityCache.set(cacheKey, totalProbability);
    return totalProbability;
  };
  
  const pathProbability = calculateProbability(startId, initialContext);
  
  return {
    probability: pathProbability,
    expectedCosts
  };
}

/**
 * Analyze selection and determine which analysis mode to use
 * 
 * @param selectedNodes - Nodes selected by user
 * @param allNodes - All nodes in graph
 * @param edges - All edges in graph
 * @returns Selection mode and relevant metadata
 */
export function detectSelectionMode(
  selectedNodes: NodeRef[],
  allNodes: NodeRef[],
  edges: EdgeRef[]
): {
  mode: 'none' | 'single' | 'two_node' | 'multi_end' | 'sequential' | 'parallel' | 'general';
  startNode?: NodeRef;
  endNode?: NodeRef;
  intermediateNodes?: NodeRef[];
  sortedNodeIds?: string[];
  isSequential?: boolean;
} {
  const nodeIds = selectedNodes.map(n => n.id);
  
  // Mode: No selection
  if (nodeIds.length === 0) {
    return { mode: 'none' };
  }
  
  // Mode 1: Single node
  if (nodeIds.length === 1) {
    return {
      mode: 'single',
      endNode: selectedNodes[0]
    };
  }
  
  // Check if ALL selected nodes are end nodes
  const allAreEndNodes = selectedNodes.every(node => isEndNode(node, edges));
  
  // Mode 3: Multi-end comparison
  if (allAreEndNodes) {
    return {
      mode: 'multi_end'
    };
  }
  
  // Mode 2: Two nodes (not both end nodes)
  if (nodeIds.length === 2) {
    const sortedIds = topologicalSort(nodeIds, edges);
    return {
      mode: 'two_node',
      startNode: selectedNodes.find(n => n.id === sortedIds[0]),
      endNode: selectedNodes.find(n => n.id === sortedIds[1]),
      sortedNodeIds: sortedIds
    };
  }
  
  // Mode 4/5: Three or more nodes
  if (nodeIds.length >= 3) {
    const sortedIds = topologicalSort(nodeIds, edges);
    const isSequential = areNodesTopologicallySequential(sortedIds, edges);
    
    const firstNode = selectedNodes.find(n => n.id === sortedIds[0]);
    const lastNode = selectedNodes.find(n => n.id === sortedIds[sortedIds.length - 1]);
    const intermediates = selectedNodes.filter(n => 
      n.id !== sortedIds[0] && n.id !== sortedIds[sortedIds.length - 1]
    );
    
    // Check if last node is an end node (absorbing OR no outgoing edges)
    const lastNodeHasOutgoing = edges.some(e => e.source === lastNode?.id);
    const lastNodeIsEnd = lastNode?.data?.absorbing === true || !lastNodeHasOutgoing;
    
    // Check if first node is in the selection (ensures we have a defined start point)
    const firstNodeIsSelected = nodeIds.includes(sortedIds[0]);
    
    // If we have 3+ nodes with first and last defined, treat as path analysis
    // This handles both sequential (A→B→C) and parallel (A→{B,C}→D) patterns
    // User is saying: "Show me path from first to last, forcing through intermediates"
    const hasUniqueStartEnd = firstNodeIsSelected && (lastNodeIsEnd || nodeIds.length >= 3);
    
    // Mode 4: Sequential path OR has unique start/end
    if (isSequential || hasUniqueStartEnd) {
      return {
        mode: 'sequential',
        startNode: firstNode,
        endNode: lastNode,
        intermediateNodes: intermediates,
        sortedNodeIds: sortedIds,
        isSequential
      };
    }
    
    // Mode 5: Parallel path (has start/end but not sequential)
    // This is actually still handled as 'sequential' mode with pruning
    // The difference is in interpretation (AND vs OR of intermediates)
    return {
      mode: 'parallel',
      startNode: firstNode,
      endNode: lastNode,
      intermediateNodes: intermediates,
      sortedNodeIds: sortedIds,
      isSequential: false
    };
  }
  
  // Mode 6: General multi-selection
  return { mode: 'general' };
}

/**
 * Calculate path from start to end with what-if and pruning
 * 
 * This is the MAIN ENTRY POINT for path calculations.
 * 
 * @param graph - Raw graph data
 * @param edges - ReactFlow edges
 * @param startId - Start node ID
 * @param endId - End node ID
 * @param whatIfOverrides - What-if overrides (always applied)
 * @param pathSelectedNodes - Quick selection nodes (for pruning)
 * @param pathStart - Path start for pruning calculation
 * @param pathEnd - Path end for pruning calculation
 * @returns Probability and costs
 */
export function calculatePath(
  graph: any,
  edges: EdgeRef[],
  startId: string,
  endId: string,
  whatIfOverrides: WhatIfOverrides = {},
  pathSelectedNodes?: Set<string>,
  pathStart?: string,
  pathEnd?: string
): PathResult {
  // Compute pruning if we have path selection
  let pruningResult: PruningResult | undefined;
  
  if (pathSelectedNodes && pathSelectedNodes.size > 0 && pathStart && pathEnd) {
    pruningResult = computeGraphPruning(
      graph,
      edges,
      whatIfOverrides,
      pathSelectedNodes,
      pathStart,
      pathEnd
    );
  }
  
  // Build list of given visited nodes (from path selection)
  const givenVisitedNodeIds = pathSelectedNodes ? Array.from(pathSelectedNodes) : undefined;
  
  // Calculate path probability and costs
  return calculatePathProbability(
    graph,
    edges,
    startId,
    endId,
    whatIfOverrides,
    givenVisitedNodeIds,
    pruningResult
  );
}

/**
 * Calculate direct edge probability between two nodes
 * Simpler than full path calculation, used for two-node analysis
 */
export function calculateDirectEdgeProbability(
  graph: any,
  edgeId: string,
  whatIfOverrides: WhatIfOverrides,
  pathContext: Set<string>
): number {
  return computeEffectiveEdgeProbability(
    graph,
    edgeId,
    whatIfOverrides,
    pathContext
  );
}

/**
 * Calculate multi-end comparison
 * Returns probability of reaching each end node from start
 * 
 * @param graph - Raw graph data
 * @param edges - ReactFlow edges
 * @param startNode - Start node
 * @param endNodes - Array of end nodes to compare
 * @param whatIfOverrides - What-if overrides
 * @returns Array of {node, probability, costs} sorted by probability
 */
export function calculateMultiEndComparison(
  graph: any,
  edges: EdgeRef[],
  startNode: NodeRef,
  endNodes: NodeRef[],
  whatIfOverrides: WhatIfOverrides = {}
): Array<{ node: NodeRef; probability: number; expectedCosts: any }> {
  const results = endNodes.map(endNode => {
    const pathResult = calculatePath(
      graph,
      edges,
      startNode.id,
      endNode.id,
      whatIfOverrides,
      undefined, // No path selection for multi-end
      undefined,
      undefined
    );
    
    return {
      node: endNode,
      probability: pathResult.probability,
      expectedCosts: pathResult.expectedCosts
    };
  });
  
  // Sort by probability descending
  results.sort((a, b) => b.probability - a.probability);
  
  return results;
}

/**
 * Calculate general multi-selection statistics
 * For selections that don't match specific path patterns
 * 
 * @param selectedNodeIds - IDs of selected nodes
 * @param edges - All edges in graph
 * @returns Aggregate statistics
 */
export function calculateGeneralStats(
  selectedNodeIds: string[],
  edges: EdgeRef[]
): {
  internalEdges: number;
  incomingEdges: number;
  outgoingEdges: number;
  totalIncomingProbability: number;
  totalOutgoingProbability: number;
  totalCosts: { monetary: number; time: number; units: string };
  probabilityConservation: boolean;
} {
  const internalEdges = edges.filter(edge => 
    selectedNodeIds.includes(edge.source) && selectedNodeIds.includes(edge.target)
  );
  
  const incomingEdges = edges.filter(edge => 
    !selectedNodeIds.includes(edge.source) && selectedNodeIds.includes(edge.target)
  );
  
  const outgoingEdges = edges.filter(edge => 
    selectedNodeIds.includes(edge.source) && !selectedNodeIds.includes(edge.target)
  );
  
  const totalIncomingProbability = incomingEdges.reduce((sum, edge) => {
    const prob = edge.data?.probability || 0;
    return sum + prob;
  }, 0);
  
  const totalOutgoingProbability = outgoingEdges.reduce((sum, edge) => {
    const prob = edge.data?.probability || 0;
    return sum + prob;
  }, 0);
  
  const totalCosts = {
    monetary: 0,
    time: 0,
    units: ''
  };
  
  [...internalEdges, ...outgoingEdges].forEach(edge => {
    // New flat schema: cost_gbp, cost_time
    if (edge.data?.cost_gbp) {
      totalCosts.monetary += edge.data.cost_gbp.mean || 0;
    }
    if (edge.data?.cost_time) {
      totalCosts.time += edge.data.cost_time.mean || 0;
      if (!totalCosts.units) {
        totalCosts.units = 'days';
      }
    }
  });
  
  const probabilityConservation = Math.abs(totalIncomingProbability - totalOutgoingProbability) < 0.001;
  
  return {
    internalEdges: internalEdges.length,
    incomingEdges: incomingEdges.length,
    outgoingEdges: outgoingEdges.length,
    totalIncomingProbability,
    totalOutgoingProbability,
    totalCosts,
    probabilityConservation
  };
}

/**
 * Main entry point: Analyze node selection and compute results
 * 
 * Detects selection mode and routes to appropriate calculation
 * 
 * @param selectedNodes - Nodes selected by user
 * @param allNodes - All nodes in graph
 * @param edges - All edges in graph
 * @param graph - Raw graph data
 * @param whatIfOverrides - What-if overrides (tab-specific)
 * @returns Analysis result with mode-specific data
 */
export function analyzeSelection(
  selectedNodes: NodeRef[],
  allNodes: NodeRef[],
  edges: EdgeRef[],
  graph: any,
  whatIfOverrides: WhatIfOverrides = {}
): any {
  // Detect selection mode
  const detection = detectSelectionMode(selectedNodes, allNodes, edges);
  
  switch (detection.mode) {
    case 'none':
      return null;
    
    case 'single': {
      // Find start node
      const startNodes = findStartNodes(allNodes);
      if (startNodes.length === 0) {
        return {
          type: 'single',
          node: detection.endNode,
          error: 'No start node found in graph'
        };
      }
      
      const startNode = startNodes[0];
      const selectedNode = detection.endNode!;
      
      // Check if selected node IS the start node
      if (startNode.id === selectedNode.id) {
        return {
          type: 'single',
          node: selectedNode,
          isStartNode: true,
          pathProbability: 1.0,
          pathCosts: { monetary: 0, time: 0, units: '' }
        };
      }
      
      // Calculate path from start to selected
      const pathResult = calculatePath(
        graph,
        edges,
        startNode.id,
        selectedNode.id,
        whatIfOverrides,
        new Set([startNode.id, selectedNode.id]), // Given nodes
        undefined, // No additional path selection
        undefined
      );
      
      // Calculate expected cost GIVEN that the path occurs
      const expectedCostsGivenPath = {
        monetary: pathResult.probability > 0 ? pathResult.expectedCosts.monetary / pathResult.probability : 0,
        time: pathResult.probability > 0 ? pathResult.expectedCosts.time / pathResult.probability : 0,
        units: pathResult.expectedCosts.units
      };
      
      return {
        type: 'single',
        node: selectedNode,
        startNode: startNode,
        pathProbability: pathResult.probability,
        pathCosts: expectedCostsGivenPath,
        isStartNode: false
      };
    }
    
    case 'two_node': {
      const nodeA = detection.startNode!;
      const nodeB = detection.endNode!;
      
      // Find direct edge A→B
      const directEdge = edges.find(edge => 
        edge.source === nodeA.id && edge.target === nodeB.id
      );
      
      // Find reverse edge B→A
      const reverseEdge = edges.find(edge => 
        edge.source === nodeB.id && edge.target === nodeA.id
      );
      
      // Calculate direct path probability (if direct edge exists)
      const pathContext = new Set([nodeA.id, nodeB.id]);
      let directPathProbability = 0;
      let directPathCosts = { monetary: 0, time: 0, units: '' };
      
      if (directEdge) {
        directPathProbability = calculateDirectEdgeProbability(
          graph,
          directEdge.id,
          whatIfOverrides,
          pathContext
        );
        directPathCosts = {
          monetary: directEdge.data?.cost_gbp?.mean || 0,
          time: directEdge.data?.cost_time?.mean || 0,
          units: 'days'
        };
      }
      
      // Calculate indirect path (through intermediates)
      const indirectPath = calculatePath(
        graph,
        edges,
        nodeA.id,
        nodeB.id,
        whatIfOverrides,
        new Set([nodeA.id, nodeB.id]), // Given nodes
        undefined, // No pruning for two-node
        undefined
      );
      
      // Use path with higher probability
      const useDirectPath = directEdge && directPathProbability >= indirectPath.probability;
      const finalPath = useDirectPath ? {
        probability: directPathProbability,
        costs: directPathCosts,
        isDirect: true
      } : {
        probability: indirectPath.probability,
        costs: indirectPath.expectedCosts,
        isDirect: false
      };
      
      // Calculate expected cost GIVEN path occurs
      const expectedCostsGivenPath = {
        monetary: finalPath.probability > 0 ? finalPath.costs.monetary / finalPath.probability : 0,
        time: finalPath.probability > 0 ? finalPath.costs.time / finalPath.probability : 0,
        units: finalPath.costs.units
      };
      
      return {
        type: 'path',
        nodeA,
        nodeB,
        directEdge,
        reverseEdge,
        pathProbability: finalPath.probability,
        pathCosts: expectedCostsGivenPath,
        hasDirectPath: !!directEdge,
        hasReversePath: !!reverseEdge,
        isDirectPath: finalPath.isDirect,
        intermediateNodes: []
      };
    }
    
    case 'multi_end': {
      const startNodes = findStartNodes(allNodes);
      if (startNodes.length === 0) {
        return {
          type: 'multi_end',
          error: 'No start node found'
        };
      }
      
      const startNode = startNodes[0];
      const endNodeResults = calculateMultiEndComparison(
        graph,
        edges,
        startNode,
        selectedNodes,
        whatIfOverrides
      );
      
      const totalProbability = endNodeResults.reduce((sum, r) => sum + r.probability, 0);
      
      return {
        type: 'multi_end',
        endNodeProbabilities: endNodeResults,
        totalProbability,
        startNode
      };
    }
    
    case 'sequential':
    case 'parallel': {
      const { startNode, endNode, sortedNodeIds, isSequential } = detection;
      
      if (!startNode || !endNode || !sortedNodeIds) {
        return { type: 'error', message: 'Invalid sequential/parallel detection' };
      }
      
      // Compute pruning with intermediate nodes
      const pathSelectedSet = new Set(sortedNodeIds);
      const pruningResult = computeGraphPruning(
        graph,
        edges,
        whatIfOverrides,
        pathSelectedSet,
        startNode.id,
        endNode.id
      );
      
      // Calculate path with pruning
      const pathResult = calculatePath(
        graph,
        edges,
        startNode.id,
        endNode.id,
        whatIfOverrides,
        pathSelectedSet,
        startNode.id,
        endNode.id
      );
      
      // Calculate expected cost GIVEN path occurs
      const expectedCostsGivenPath = {
        monetary: pathResult.probability > 0 ? pathResult.expectedCosts.monetary / pathResult.probability : 0,
        time: pathResult.probability > 0 ? pathResult.expectedCosts.time / pathResult.probability : 0,
        units: pathResult.expectedCosts.units
      };
      
      return {
        type: detection.mode === 'sequential' ? 'path_sequential' : 'path_parallel',
        nodeA: startNode,
        nodeB: endNode,
        intermediateNodes: detection.intermediateNodes,
        pathProbability: pathResult.probability,
        pathCosts: expectedCostsGivenPath,
        sortedNodeIds,
        isSequential,
        pruningApplied: pruningResult ? {
          excludedEdges: pruningResult.excludedEdges.size,
          renormFactors: pruningResult.renormFactors.size
        } : undefined
      };
    }
    
    case 'general': {
      const nodeIds = selectedNodes.map(n => n.id);
      const stats = calculateGeneralStats(nodeIds, edges);
      
      return {
        type: 'multi',
        selectedNodes: selectedNodes.length,
        ...stats
      };
    }
    
    default:
      return null;
  }
}

