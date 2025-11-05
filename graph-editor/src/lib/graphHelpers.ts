import { Node, Edge } from 'reactflow';

/**
 * SYSTEMATIC UUID/ID HELPERS
 * 
 * Context awareness:
 * 1. Graph JSON nodes/edges: Have BOTH uuid (system) and id (human-readable)
 * 2. ReactFlow nodes/edges: node.id = uuid, node.data.id = human-readable
 * 3. Tab operations (hiding, etc): Use human-readable IDs ONLY
 */

// ============================================================================
// GRAPH JSON LOOKUPS (nodes/edges with both uuid and id fields)
// ============================================================================

/**
 * Find a node in graph JSON by UUID or human-readable ID
 * @param graph Graph JSON data
 * @param nodeId Can be either UUID or human-readable ID
 */
export function findGraphNodeById(graph: any, nodeId: string): any | undefined {
  if (!graph?.nodes) return undefined;
  return graph.nodes.find((n: any) => n.uuid === nodeId || n.id === nodeId);
}

/**
 * Find node index in graph JSON by UUID or human-readable ID
 */
export function findGraphNodeIndexById(graph: any, nodeId: string): number {
  if (!graph?.nodes) return -1;
  return graph.nodes.findIndex((n: any) => n.uuid === nodeId || n.id === nodeId);
}

/**
 * Find an edge in graph JSON by UUID or human-readable ID
 * @param graph Graph JSON data
 * @param edgeId Can be UUID, human-readable ID, or from->to format
 */
export function findGraphEdgeById(graph: any, edgeId: string): any | undefined {
  if (!graph?.edges) return undefined;
  return graph.edges.find((e: any) => 
    e.uuid === edgeId ||
    e.id === edgeId ||
    `${e.from}->${e.to}` === edgeId
  );
}

/**
 * Find edge index in graph JSON by UUID or human-readable ID
 */
export function findGraphEdgeIndexById(graph: any, edgeId: string): number {
  if (!graph?.edges) return -1;
  return graph.edges.findIndex((e: any) => 
    e.uuid === edgeId || 
    e.id === edgeId || 
    `${e.from}->${e.to}` === edgeId
  );
}

// ============================================================================
// REACTFLOW NODE/EDGE LOOKUPS
// ============================================================================

/**
 * Find a ReactFlow node by UUID or human-readable ID
 * ReactFlow context: node.id = uuid, node.data.id = human-readable
 * @param nodes Array of ReactFlow nodes
 * @param nodeId Can be UUID (node.id) or human-readable (node.data.id)
 */
export function findReactFlowNode(nodes: Node[], nodeId: string): Node | undefined {
  return nodes.find((n: Node) => n.id === nodeId || n.data?.id === nodeId);
}

/**
 * Find a ReactFlow node by graph node reference (from/to on edges)
 * Since edge.from/to can be either UUID or human-readable, check both
 * @param nodes Array of ReactFlow nodes
 * @param nodeRef Reference from edge.from or edge.to (could be uuid or id)
 */
export function findReactFlowNodeByRef(nodes: Node[], nodeRef: string): Node | undefined {
  return nodes.find((n: Node) => n.id === nodeRef || n.data?.id === nodeRef);
}

// ============================================================================
// ID EXTRACTION (for tab operations that need human-readable IDs)
// ============================================================================

/**
 * Get human-readable ID from a ReactFlow node
 * Tab operations use human-readable IDs, not UUIDs
 */
export function getHumanReadableId(node: Node): string {
  return node.data?.id || node.id;
}

/**
 * Get human-readable ID from a graph JSON node
 */
export function getHumanReadableIdFromGraphNode(node: any): string {
  return node.id || node.uuid;
}

/**
 * Get UUIDs from ReactFlow nodes (for ReactFlow operations)
 */
export function getReactFlowIds(nodes: Node[]): string[] {
  return nodes.map(n => n.id);
}

/**
 * Get human-readable IDs from ReactFlow nodes (for tab operations)
 */
export function getHumanReadableIds(nodes: Node[]): string[] {
  return nodes.map(n => n.data?.id || n.id);
}

// ============================================================================
// LEGACY ALIASES (for backward compatibility during migration)
// ============================================================================

/** @deprecated Use findGraphNodeById instead */
export function findNodeById(graph: any, nodeId: string): any | undefined {
  return findGraphNodeById(graph, nodeId);
}

/** @deprecated Use findGraphNodeIndexById instead */
export function findNodeIndexById(graph: any, nodeId: string): number {
  return findGraphNodeIndexById(graph, nodeId);
}

/** @deprecated Use findGraphEdgeById instead */
export function findEdgeById(graph: any, edgeId: string): any | undefined {
  return findGraphEdgeById(graph, edgeId);
}

/** @deprecated Use findGraphEdgeIndexById instead */
export function findEdgeIndexById(graph: any, edgeId: string): number {
  return findGraphEdgeIndexById(graph, edgeId);
}
