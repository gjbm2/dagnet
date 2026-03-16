/**
 * Path highlighting — pure graph traversal algorithms extracted from GraphCanvas.
 *
 * These functions compute which edges to highlight when nodes are selected,
 * including depth-based fading for single-node selection.
 */

// ---------------------------------------------------------------------------
// Graph traversal helpers
// ---------------------------------------------------------------------------

/** Find nodes with no incoming edges. */
export function findStartNodes(allNodes: any[], allEdges: any[]): any[] {
  const nodesWithIncoming = new Set(allEdges.map(edge => edge.target));
  return allNodes.filter(node => !nodesWithIncoming.has(node.id));
}

/** DFS to find all paths between two nodes (with depth limit). */
export function findAllPaths(
  sourceId: string,
  targetId: string,
  allEdges: any[],
  maxDepth: number = 10,
): string[][] {
  const paths: string[][] = [];
  const visited = new Set<string>();

  const dfs = (currentNodeId: string, currentPath: string[], depth: number) => {
    if (depth > maxDepth) return;
    if (currentNodeId === targetId) {
      paths.push([...currentPath]);
      return;
    }
    if (visited.has(currentNodeId)) return;
    visited.add(currentNodeId);

    const outgoingEdges = allEdges.filter(edge => edge.source === currentNodeId);
    for (const edge of outgoingEdges) {
      if (!currentPath.includes(edge.id)) {
        currentPath.push(edge.id);
        dfs(edge.target, currentPath, depth + 1);
        currentPath.pop();
      }
    }
    visited.delete(currentNodeId);
  };

  dfs(sourceId, [], 0);
  return paths;
}

/** Topologically sort a subset of node IDs using all graph edges. */
export function topologicalSort(nodeIds: string[], allEdges: any[]): string[] {
  const adjList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  nodeIds.forEach(id => {
    adjList.set(id, []);
    inDegree.set(id, 0);
  });

  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = 0; j < nodeIds.length; j++) {
      if (i !== j) {
        const hasPath = findAllPaths(nodeIds[i], nodeIds[j], allEdges).length > 0;
        if (hasPath) {
          if (!adjList.get(nodeIds[i])!.includes(nodeIds[j])) {
            adjList.get(nodeIds[i])!.push(nodeIds[j]);
            inDegree.set(nodeIds[j], inDegree.get(nodeIds[j])! + 1);
          }
        }
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  const sorted: string[] = [];

  inDegree.forEach((degree, nodeId) => {
    if (degree === 0) queue.push(nodeId);
  });

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    adjList.get(current)!.forEach(neighbor => {
      const newDegree = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    });
  }

  return sorted.length === nodeIds.length ? sorted : nodeIds;
}

/** Check if nodes are topologically sequential (path between each consecutive pair). */
export function areNodesTopologicallySequential(sortedNodeIds: string[], allEdges: any[]): boolean {
  for (let i = 0; i < sortedNodeIds.length - 1; i++) {
    if (findAllPaths(sortedNodeIds[i], sortedNodeIds[i + 1], allEdges).length === 0) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main highlighting computation
// ---------------------------------------------------------------------------

/** Find all edges that are part of paths between selected nodes. */
export function findPathEdges(selectedNodes: any[], allEdges: any[]): Set<string> {
  if (selectedNodes.length === 0) return new Set<string>();

  // Special case: 1 node — highlight upstream and downstream edges
  if (selectedNodes.length === 1) {
    const selectedId = selectedNodes[0].id;
    const pathEdges = new Set<string>();

    const findUpstreamEdges = (nodeId: string, depth: number, visited = new Set<string>()) => {
      if (visited.has(nodeId) || depth > 5) return;
      visited.add(nodeId);
      allEdges.forEach(edge => {
        if (edge.target === nodeId) {
          pathEdges.add(edge.id);
          findUpstreamEdges(edge.source, depth + 1, visited);
        }
      });
    };

    const findDownstreamEdges = (nodeId: string, depth: number, visited = new Set<string>()) => {
      if (visited.has(nodeId) || depth > 5) return;
      visited.add(nodeId);
      allEdges.forEach(edge => {
        if (edge.source === nodeId) {
          pathEdges.add(edge.id);
          findDownstreamEdges(edge.target, depth + 1, visited);
        }
      });
    };

    findUpstreamEdges(selectedId, 0);
    findDownstreamEdges(selectedId, 0);
    return pathEdges;
  }

  if (selectedNodes.length < 2) return new Set<string>();

  const selectedNodeIds = selectedNodes.map(node => node.id);
  const pathEdges = new Set<string>();

  // Special case: 3+ nodes — check if topologically sequential
  if (selectedNodes.length >= 3) {
    const sortedNodeIds = topologicalSort(selectedNodeIds, allEdges);
    const isSequential = areNodesTopologicallySequential(sortedNodeIds, allEdges);

    if (isSequential) {
      const firstNodeId = sortedNodeIds[0];
      const lastNodeId = sortedNodeIds[sortedNodeIds.length - 1];
      const intermediateIds = sortedNodeIds.slice(1, -1);

      const findPathsThroughNodes = (
        currentId: string,
        remainingNodes: string[],
        currentPath: string[],
      ): string[][] => {
        if (remainingNodes.length === 0) return [currentPath];
        const nextNode = remainingNodes[0];
        const restNodes = remainingNodes.slice(1);
        const allPaths: string[][] = [];
        const paths = findAllPaths(currentId, nextNode, allEdges);
        paths.forEach(path => {
          allPaths.push(...findPathsThroughNodes(nextNode, restNodes, [...currentPath, ...path]));
        });
        return allPaths;
      };

      const paths = findPathsThroughNodes(firstNodeId, [...intermediateIds, lastNodeId], []);
      paths.forEach(path => path.forEach(edgeId => pathEdges.add(edgeId)));
      return pathEdges;
    }
  }

  // Default: for each pair, find all paths in both directions
  for (let i = 0; i < selectedNodeIds.length; i++) {
    for (let j = i + 1; j < selectedNodeIds.length; j++) {
      findAllPaths(selectedNodeIds[i], selectedNodeIds[j], allEdges)
        .forEach(path => path.forEach(edgeId => pathEdges.add(edgeId)));
      findAllPaths(selectedNodeIds[j], selectedNodeIds[i], allEdges)
        .forEach(path => path.forEach(edgeId => pathEdges.add(edgeId)));
    }
  }

  return pathEdges;
}

// ---------------------------------------------------------------------------
// Highlight metadata (depth map + edge set)
// ---------------------------------------------------------------------------

export interface HighlightMetadata {
  highlightedEdgeIds: Set<string>;
  edgeDepthMap: Map<string, number>;
  isSingleNodeSelection: boolean;
}

/**
 * Compute highlight metadata for the given selection.
 * Pure function — call from a useMemo in the component.
 */
export function computeHighlightMetadata(
  selectedNodes: any[],
  edges: any[],
): HighlightMetadata {
  if (selectedNodes.length === 0) {
    return {
      highlightedEdgeIds: new Set<string>(),
      edgeDepthMap: new Map<string, number>(),
      isSingleNodeSelection: false,
    };
  }

  const edgeDepthMap = new Map<string, number>();

  if (selectedNodes.length === 1) {
    const selectedId = selectedNodes[0].id;

    const calculateUpstreamDepths = (nodeId: string, depth: number, visited = new Set<string>()) => {
      if (visited.has(nodeId) || depth > 5) return;
      visited.add(nodeId);
      edges.forEach(edge => {
        if (edge.target === nodeId) {
          const existingDepth = edgeDepthMap.get(edge.id);
          if (existingDepth === undefined || depth < existingDepth) {
            edgeDepthMap.set(edge.id, depth);
          }
          calculateUpstreamDepths(edge.source, depth + 1, visited);
        }
      });
    };

    const calculateDownstreamDepths = (nodeId: string, depth: number, visited = new Set<string>()) => {
      if (visited.has(nodeId) || depth > 5) return;
      visited.add(nodeId);
      edges.forEach(edge => {
        if (edge.source === nodeId) {
          const existingDepth = edgeDepthMap.get(edge.id);
          if (existingDepth === undefined || depth < existingDepth) {
            edgeDepthMap.set(edge.id, depth);
          }
          calculateDownstreamDepths(edge.target, depth + 1, visited);
        }
      });
    };

    calculateUpstreamDepths(selectedId, 0);
    calculateDownstreamDepths(selectedId, 0);
  }

  const highlightedEdgeIds = findPathEdges(selectedNodes, edges);

  return {
    highlightedEdgeIds,
    edgeDepthMap,
    isSingleNodeSelection: selectedNodes.length === 1,
  };
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

/**
 * Check if adding an edge (source → target) would create a cycle.
 * nodeIds: all node IDs in the graph.
 */
export function wouldCreateCycle(
  source: string,
  target: string,
  currentEdges: { source: string; target: string }[],
  nodeIds: string[],
): boolean {
  const graph: Record<string, string[]> = {};
  nodeIds.forEach(id => { graph[id] = []; });
  currentEdges.forEach(edge => {
    if (graph[edge.source]) graph[edge.source].push(edge.target);
  });
  if (graph[source]) graph[source].push(target);

  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  const hasCycleDFS = (node: string): boolean => {
    if (recursionStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    recursionStack.add(node);
    for (const neighbor of (graph[node] || [])) {
      if (hasCycleDFS(neighbor)) return true;
    }
    recursionStack.delete(node);
    return false;
  };

  for (const nodeId of Object.keys(graph)) {
    if (!visited.has(nodeId)) {
      if (hasCycleDFS(nodeId)) return true;
    }
  }

  return false;
}
