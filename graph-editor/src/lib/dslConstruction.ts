/**
 * DSL Query Construction
 * 
 * Constructs DSL query strings from user node selections.
 * Infers user intent based on selection patterns (path, comparison, constraint).
 * 
 * Design Reference: /docs/current/project-analysis/DSL_CONSTRUCTION_CASES.md
 */

import type { Node, Edge } from 'reactflow';

// Graph edges use from/to (UUIDs), ReactFlow edges use source/target (UUIDs)
// This helper normalizes both formats AND converts UUIDs to human-readable IDs
interface NormalizedEdge {
  source: string;  // Human-readable ID
  target: string;  // Human-readable ID
}

function normalizeEdges(edges: any[], nodes: any[]): NormalizedEdge[] {
  // Build UUID -> human-readable ID map
  const uuidToId = new Map<string, string>();
  for (const node of nodes) {
    if (node.uuid && node.id) {
      uuidToId.set(node.uuid, node.id);
    }
    // Also map id to itself for cases where ids are already human-readable
    if (node.id) {
      uuidToId.set(node.id, node.id);
    }
  }
  
  return edges.map(e => {
    const rawSource = e.source || e.from;
    const rawTarget = e.target || e.to;
    return {
      // Convert to human-readable ID, fallback to raw value if not found
      source: uuidToId.get(rawSource) || rawSource,
      target: uuidToId.get(rawTarget) || rawTarget
    };
  });
}

// ============================================================
// Types
// ============================================================

interface NodeType {
  id: string;
  type: 'entry' | 'absorbing' | 'middle' | 'unknown';
}

interface SelectionPredicates {
  nodeTypes: Record<string, NodeType['type']>;
  starts: string[];
  ends: string[];
  startNode: string | null;
  endNode: string | null;
  siblingGroups: string[][];
  allAbsorbing: boolean;
  allAreSiblings: boolean;
  hasUniqueStart: boolean;
  hasUniqueEnd: boolean;
}

// ============================================================
// Main Function
// ============================================================

/**
 * Construct a DSL query string from a selection of nodes.
 * 
 * @param selectedNodeIds - IDs of selected nodes
 * @param nodes - All nodes in the graph
 * @param edges - All edges in the graph
 * @returns DSL query string (e.g., "from(a).to(b).visited(c)")
 */
export function constructQueryDSL(
  selectedNodeIds: string[],
  nodes: Node[],
  edges: Edge[] | any[]
): string {
  const k = selectedNodeIds.length;
  
  // Case 0: Empty selection
  if (k === 0) return '';
  
  // Normalize edges to handle both graph format (from/to UUIDs) and ReactFlow format (source/target)
  // Also converts UUIDs to human-readable IDs
  const normalizedEdges = normalizeEdges(edges, nodes);
  
  // Compute all predicates
  const predicates = computePredicates(selectedNodeIds, nodes, normalizedEdges);
  
  // Case 1: Single node
  if (k === 1) {
    const node = selectedNodeIds[0];
    const nodeType = predicates.nodeTypes[node];
    if (nodeType === 'entry') return `from(${node})`;
    if (nodeType === 'absorbing') return `to(${node})`;
    return `visited(${node})`;
  }
  
  // Case 2: Two nodes - check if one can reach the other in full graph
  if (k === 2) {
    const [nodeA, nodeB] = selectedNodeIds;
    const aReachesB = canReach(nodeA, nodeB, normalizedEdges);
    const bReachesA = canReach(nodeB, nodeA, normalizedEdges);
    
    if (aReachesB && !bReachesA) {
      // A is upstream of B - use from/to
      return `from(${nodeA}).to(${nodeB})`;
    } else if (bReachesA && !aReachesB) {
      // B is upstream of A - use from/to
      return `from(${nodeB}).to(${nodeA})`;
    }
    // If neither can reach the other, or both can (cycle?), fall through to sibling logic
  }
  
  // Case 3: All absorbing (outcome comparison)
  if (predicates.allAbsorbing) {
    return `visitedAny(${selectedNodeIds.join(',')})`;
  }
  
  // Case 4: All siblings, no unique start/end (branch comparison)
  if (predicates.allAreSiblings && !predicates.hasUniqueStart && !predicates.hasUniqueEnd) {
    return `visitedAny(${selectedNodeIds.join(',')})`;
  }
  
  // Build DSL parts
  const parts: string[] = [];
  
  // Add from() if unique start
  if (predicates.hasUniqueStart && predicates.startNode) {
    parts.push(`from(${predicates.startNode})`);
  }
  
  // Add to() if unique end
  if (predicates.hasUniqueEnd && predicates.endNode) {
    parts.push(`to(${predicates.endNode})`);
  }
  
  // Compute intermediates (nodes that are neither start nor end)
  const intermediates = selectedNodeIds.filter(id => 
    id !== predicates.startNode && id !== predicates.endNode
  );
  
  // Case 4/5/6: Has start and/or end, process intermediates
  if (intermediates.length > 0) {
    const constraintChain = buildConstraintChain(intermediates, normalizedEdges, predicates.siblingGroups);
    parts.push(constraintChain);
  }
  
  // Case 7: No start, no end, just constraints
  if (parts.length === 0) {
    if (predicates.allAreSiblings) {
      return `visitedAny(${selectedNodeIds.join(',')})`;
    } else {
      return selectedNodeIds.map(id => `visited(${id})`).join('.');
    }
  }
  
  return parts.join('.');
}

// ============================================================
// Predicate Computation
// ============================================================

function computePredicates(
  selectedNodeIds: string[],
  nodes: Node[],
  edges: NormalizedEdge[]
): SelectionPredicates {
  // Compute node types
  const nodeTypes: Record<string, NodeType['type']> = {};
  // Map by both id (human-readable) and uuid for flexible lookup
  const nodeMap = new Map<string, Node>();
  for (const n of nodes) {
    const node = n as any;
    if (node.id) nodeMap.set(node.id, n);
    if (node.uuid) nodeMap.set(node.uuid, n);
  }
  
  for (const nodeId of selectedNodeIds) {
    const node = nodeMap.get(nodeId);
    if (!node) {
      nodeTypes[nodeId] = 'unknown';
      continue;
    }
    
    const isEntry = node.data?.entry?.is_start === true;
    const isAbsorbing = node.data?.absorbing === true || 
      !edges.some(e => e.source === nodeId);
    
    if (isEntry) {
      nodeTypes[nodeId] = 'entry';
    } else if (isAbsorbing) {
      nodeTypes[nodeId] = 'absorbing';
    } else {
      nodeTypes[nodeId] = 'middle';
    }
  }
  
  // Compute starts and ends within selection
  const { starts, ends } = computeStartsEnds(selectedNodeIds, edges);
  
  // Compute sibling groups
  const siblingGroups = computeSiblingGroups(selectedNodeIds, edges);
  
  // Compute predicates
  const allAbsorbing = selectedNodeIds.every(id => nodeTypes[id] === 'absorbing');
  const allAreSiblings = siblingGroups.length === 1 && 
    siblingGroups[0].length === selectedNodeIds.length;
  const hasUniqueStart = starts.length === 1;
  const hasUniqueEnd = ends.length === 1;
  
  return {
    nodeTypes,
    starts,
    ends,
    startNode: hasUniqueStart ? starts[0] : null,
    endNode: hasUniqueEnd ? ends[0] : null,
    siblingGroups,
    allAbsorbing,
    allAreSiblings,
    hasUniqueStart,
    hasUniqueEnd,
  };
}

/**
 * Compute start and end nodes within a selection using FULL GRAPH reachability.
 * 
 * Start: Node that no other selected node can reach (topologically first)
 * End: Node that cannot reach any other selected node (topologically last)
 */
function computeStartsEnds(
  selectedNodeIds: string[],
  edges: NormalizedEdge[]
): { starts: string[]; ends: string[] } {
  if (selectedNodeIds.length === 0) {
    return { starts: [], ends: [] };
  }
  
  if (selectedNodeIds.length === 1) {
    return { starts: [selectedNodeIds[0]], ends: [selectedNodeIds[0]] };
  }
  
  // For each selected node, check if any OTHER selected node can reach it (predecessor)
  // and if it can reach any OTHER selected node (successor)
  const hasSelectedPredecessor = new Map<string, boolean>();
  const hasSelectedSuccessor = new Map<string, boolean>();
  
  for (const nodeId of selectedNodeIds) {
    hasSelectedPredecessor.set(nodeId, false);
    hasSelectedSuccessor.set(nodeId, false);
  }
  
  // Check reachability between all pairs using full graph
  for (const nodeA of selectedNodeIds) {
    for (const nodeB of selectedNodeIds) {
      if (nodeA === nodeB) continue;
      
      if (canReach(nodeA, nodeB, edges)) {
        // A can reach B, so:
        // - B has a selected predecessor (A)
        // - A has a selected successor (B)
        hasSelectedPredecessor.set(nodeB, true);
        hasSelectedSuccessor.set(nodeA, true);
      }
    }
  }
  
  // Starts: nodes with no selected predecessor (nothing in selection can reach them)
  const starts = selectedNodeIds.filter(id => !hasSelectedPredecessor.get(id));
  
  // Ends: nodes with no selected successor (they can't reach anything in selection)
  const ends = selectedNodeIds.filter(id => !hasSelectedSuccessor.get(id));
  
  return { starts, ends };
}

/**
 * Group selected nodes by common parent OR common child (siblings/co-siblings).
 * 
 * Siblings: nodes that share a common parent (fan-out from same node)
 * Co-siblings: nodes that share a common child (fan-in to same node)
 */
function computeSiblingGroups(
  selectedNodeIds: string[],
  edges: NormalizedEdge[]
): string[][] {
  // Map each node to its parents and children
  const parentMap = new Map<string, string[]>();
  const childMap = new Map<string, string[]>();
  
  for (const nodeId of selectedNodeIds) {
    const parents = edges
      .filter(e => e.target === nodeId)
      .map(e => e.source);
    parentMap.set(nodeId, parents);
    
    const children = edges
      .filter(e => e.source === nodeId)
      .map(e => e.target);
    childMap.set(nodeId, children);
  }
  
  // Group nodes by shared parent OR shared child
  const groups: string[][] = [];
  const assigned = new Set<string>();
  
  for (const nodeId of selectedNodeIds) {
    if (assigned.has(nodeId)) continue;
    
    const nodeParents = new Set(parentMap.get(nodeId) || []);
    const nodeChildren = new Set(childMap.get(nodeId) || []);
    const group = [nodeId];
    assigned.add(nodeId);
    
    // Find other nodes with overlapping parents OR children
    for (const otherId of selectedNodeIds) {
      if (assigned.has(otherId)) continue;
      
      const otherParents = parentMap.get(otherId) || [];
      const otherChildren = childMap.get(otherId) || [];
      
      const sharesParent = otherParents.some(p => nodeParents.has(p));
      const sharesChild = otherChildren.some(c => nodeChildren.has(c));
      
      if (sharesParent || sharesChild) {
        group.push(otherId);
        assigned.add(otherId);
        // Also add this node's parents/children to the sets for transitive grouping
        otherParents.forEach(p => nodeParents.add(p));
        otherChildren.forEach(c => nodeChildren.add(c));
      }
    }
    
    groups.push(group);
  }
  
  return groups;
}

/**
 * Build constraint chain from intermediate nodes.
 * Groups consecutive siblings into visitedAny().
 */
function buildConstraintChain(
  intermediates: string[],
  edges: NormalizedEdge[],
  siblingGroups: string[][]
): string {
  if (intermediates.length === 0) return '';
  
  // Sort intermediates topologically
  const sorted = topologicalSort(intermediates, edges);
  
  // Group consecutive siblings
  const groups: string[][] = [];
  let currentGroup = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    if (areInSameSiblingGroup(sorted[i], currentGroup[0], siblingGroups)) {
      currentGroup.push(sorted[i]);
    } else {
      groups.push(currentGroup);
      currentGroup = [sorted[i]];
    }
  }
  groups.push(currentGroup);
  
  // Build constraint string
  return groups.map(group => {
    if (group.length === 1) {
      return `visited(${group[0]})`;
    } else {
      return `visitedAny(${group.join(',')})`;
    }
  }).join('.');
}

/**
 * Check if two nodes are in the same sibling group.
 */
function areInSameSiblingGroup(
  nodeA: string,
  nodeB: string,
  siblingGroups: string[][]
): boolean {
  return siblingGroups.some(group => 
    group.includes(nodeA) && group.includes(nodeB)
  );
}

/**
 * Check if node A can reach node B in the graph (BFS).
 */
function canReach(from: string, to: string, edges: NormalizedEdge[]): boolean {
  if (from === to) return true;
  
  // Build adjacency list
  const adjList = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adjList.has(edge.source)) {
      adjList.set(edge.source, []);
    }
    adjList.get(edge.source)!.push(edge.target);
  }
  
  // BFS
  const visited = new Set<string>();
  const queue = [from];
  visited.add(from);
  
  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adjList.get(current) || [];
    
    for (const neighbor of neighbors) {
      if (neighbor === to) return true;
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  
  return false;
}

/**
 * Topologically sort a subset of nodes.
 */
function topologicalSort(nodeIds: string[], edges: NormalizedEdge[]): string[] {
  // Filter edges to only those between the specified nodes
  const nodeSet = new Set(nodeIds);
  const relevantEdges = edges.filter(e => 
    nodeSet.has(e.source) && nodeSet.has(e.target)
  );
  
  // Build adjacency list and in-degree
  const adjList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  
  for (const id of nodeIds) {
    adjList.set(id, []);
    inDegree.set(id, 0);
  }
  
  for (const edge of relevantEdges) {
    adjList.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
  }
  
  // Kahn's algorithm
  const queue: string[] = [];
  const sorted: string[] = [];
  
  for (const id of nodeIds) {
    if (inDegree.get(id) === 0) {
      queue.push(id);
    }
  }
  
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    
    for (const neighbor of (adjList.get(current) || [])) {
      const newDegree = (inDegree.get(neighbor) || 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }
  
  // If not all sorted, add remaining in original order
  if (sorted.length < nodeIds.length) {
    for (const id of nodeIds) {
      if (!sorted.includes(id)) {
        sorted.push(id);
      }
    }
  }
  
  return sorted;
}

