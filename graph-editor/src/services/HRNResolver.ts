/**
 * HRNResolver (Human-Readable Name Resolver)
 * 
 * Resolves human-readable names for edges and nodes to their UUIDs.
 * Handles various selector formats and falls back to UUID when ambiguous.
 */

import { Graph, GraphNode, GraphEdge } from '../types';

/**
 * Resolve an edge HRN to its UUID
 * 
 * Precedence:
 * 1. e.<edgeId> - Direct edge ID reference
 * 2. e.from(<fromId>).to(<toId>) - Endpoints selector
 * 3. e.uuid(<uuid>) - Direct UUID reference
 * 
 * @param hrn - Human-readable name (e.g., "e.checkout-to-purchase", "e.from(checkout).to(purchase)")
 * @param graph - Graph to resolve against
 * @returns Edge UUID or null if unresolved
 */
export function resolveEdgeHRN(hrn: string, graph: Graph): string | null {
  if (!hrn || !graph) {
    return null;
  }
  
  // Remove 'e.' prefix if present
  const normalized = hrn.startsWith('e.') ? hrn.substring(2) : hrn;
  
  // Try UUID pattern: e.uuid(<uuid>)
  const uuidMatch = normalized.match(/^uuid\(([^)]+)\)$/);
  if (uuidMatch) {
    const uuid = uuidMatch[1];
    const edge = graph.edges?.find(e => e.uuid === uuid);
    return edge?.uuid || null;
  }
  
  // Try endpoints pattern: e.from(<fromId>).to(<toId>) or from(<fromId>).to(<toId>)
  const endpointsMatch = normalized.match(/^from\(([^)]+)\)\.to\(([^)]+)\)$/);
  if (endpointsMatch) {
    const [, fromId, toId] = endpointsMatch;
    const fromNode = findNodeByIdOrName(fromId, graph);
    const toNode = findNodeByIdOrName(toId, graph);
    
    if (fromNode && toNode) {
      // Find edge(s) connecting these nodes
      const matchingEdges = graph.edges?.filter(
        e => e.from === fromNode.uuid && e.to === toNode.uuid
      ) || [];
      
      if (matchingEdges.length === 1) {
        return matchingEdges[0].uuid;
      } else if (matchingEdges.length > 1) {
        // Ambiguous: multiple parallel edges
        console.warn(`HRN "${hrn}" is ambiguous (${matchingEdges.length} matching edges). Use e.uuid() selector.`);
        return null;
      }
    }
    return null;
  }
  
  // Try direct edge ID reference: e.<edgeId>
  const edge = graph.edges?.find(e => e.id === normalized);
  if (edge) {
    return edge.uuid;
  }
  
  // Try as direct UUID (without uuid() wrapper)
  const directUuidEdge = graph.edges?.find(e => e.uuid === normalized);
  if (directUuidEdge) {
    return directUuidEdge.uuid;
  }
  
  return null;
}

/**
 * Resolve a node HRN to its UUID
 * 
 * Precedence:
 * 1. n.<nodeId> - Direct node ID reference
 * 2. n.uuid(<uuid>) - Direct UUID reference
 * 
 * @param hrn - Human-readable name (e.g., "n.checkout", "n.uuid(123-456)")
 * @param graph - Graph to resolve against
 * @returns Node UUID or null if unresolved
 */
export function resolveNodeHRN(hrn: string, graph: Graph): string | null {
  if (!hrn || !graph) {
    return null;
  }
  
  // Remove 'n.' prefix if present
  const normalized = hrn.startsWith('n.') ? hrn.substring(2) : hrn;
  
  // Try UUID pattern: n.uuid(<uuid>)
  const uuidMatch = normalized.match(/^uuid\(([^)]+)\)$/);
  if (uuidMatch) {
    const uuid = uuidMatch[1];
    const node = graph.nodes?.find(n => n.uuid === uuid);
    return node?.uuid || null;
  }
  
  // Try direct node ID reference
  const node = findNodeByIdOrName(normalized, graph);
  if (node) {
    return node.uuid;
  }
  
  // Try as direct UUID
  const directUuidNode = graph.nodes?.find(n => n.uuid === normalized);
  if (directUuidNode) {
    return directUuidNode.uuid;
  }
  
  return null;
}

/**
 * Resolve a conditional HRN (e.g., "visited(promo)") to node UUID
 * 
 * @param condition - Condition string (e.g., "visited(promo)", "!visited(promo)")
 * @param graph - Graph to resolve against
 * @returns Resolved condition string with UUID, or null if unresolved
 */
export function resolveConditionalHRN(condition: string, graph: Graph): string | null {
  if (!condition || !graph) {
    return null;
  }
  
  // Match visited(nodeId) or !visited(nodeId)
  const match = condition.match(/^(!)?visited\(([^)]+)\)$/);
  if (!match) {
    return condition; // Return as-is if not a visited() condition
  }
  
  const [, negation, nodeId] = match;
  const node = findNodeByIdOrName(nodeId, graph);
  
  if (!node) {
    return null;
  }
  
  return `${negation || ''}visited(${node.uuid})`;
}

/**
 * Find a node by ID or name (case-insensitive)
 */
function findNodeByIdOrName(idOrName: string, graph: Graph): GraphNode | undefined {
  if (!graph.nodes) {
    return undefined;
  }
  
  // Try exact ID match first
  let node = graph.nodes.find(n => n.id === idOrName);
  if (node) {
    return node;
  }
  
  // Try case-insensitive ID match
  const lowerIdOrName = idOrName.toLowerCase();
  node = graph.nodes.find(n => n.id?.toLowerCase() === lowerIdOrName);
  if (node) {
    return node;
  }
  
  // Try name match (case-insensitive)
  node = graph.nodes.find(n => n.name?.toLowerCase() === lowerIdOrName);
  if (node) {
    return node;
  }
  
  return undefined;
}

/**
 * Resolve all HRNs in a scenario params object to UUIDs
 * 
 * @param params - Scenario params with potentially HRN keys
 * @param graph - Graph to resolve against
 * @returns New params object with UUIDs, and list of unresolved HRNs
 */
export function resolveAllHRNs(
  params: any,
  graph: Graph
): { resolved: any; unresolved: string[] } {
  const resolved: any = {};
  const unresolved: string[] = [];
  
  // Resolve edge HRNs
  if (params.edges) {
    resolved.edges = {};
    for (const [key, value] of Object.entries(params.edges)) {
      const uuid = resolveEdgeHRN(key, graph);
      if (uuid) {
        resolved.edges[uuid] = value;
      } else {
        unresolved.push(`edges.${key}`);
        // Keep the original key even if unresolved (warning, not error)
        resolved.edges[key] = value;
      }
    }
  }
  
  // Resolve node HRNs
  if (params.nodes) {
    resolved.nodes = {};
    for (const [key, value] of Object.entries(params.nodes)) {
      const uuid = resolveNodeHRN(key, graph);
      if (uuid) {
        resolved.nodes[uuid] = value;
      } else {
        unresolved.push(`nodes.${key}`);
        // Keep the original key even if unresolved (warning, not error)
        resolved.nodes[key] = value;
      }
    }
  }
  
  return { resolved, unresolved };
}

