/**
 * Subgraph Extractor
 * 
 * Utility for extracting a subgraph from selected nodes
 */

import { GraphNode, GraphEdge, Graph, PostIt } from '../types';

export interface ExtractSubgraphOptions {
  selectedNodeIds: string[]; // UUIDs of selected nodes
  selectedPostitIds?: string[]; // IDs of selected post-its (without the 'postit-' prefix)
  graph: Graph;
  includeConnectedEdges?: boolean; // Include edges between selected nodes (default: true)
}

export interface ExtractedSubgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  postits: PostIt[];
}

/**
 * Find all nodes that are wholly subsumed by the selected nodes
 * A node is subsumed if ALL of its incoming edges come from nodes in the included set
 */
function findSubsumedNodes(
  selectedNodeIds: Set<string>,
  allNodes: GraphNode[],
  allEdges: GraphEdge[]
): Set<string> {
  const subsumedNodes = new Set<string>(selectedNodeIds);
  let changed = true;

  // Keep iterating until no new nodes are added
  while (changed) {
    changed = false;
    
    for (const node of allNodes) {
      if (subsumedNodes.has(node.uuid)) {
        continue; // Already included
      }

      // Find all incoming edges to this node
      const incomingEdges = allEdges.filter(edge => edge.to === node.uuid);
      
      if (incomingEdges.length === 0) {
        continue; // No incoming edges, this is a start node - don't include unless explicitly selected
      }

      // Check if ALL incoming edges come from nodes we're including
      const allIncomingFromIncluded = incomingEdges.every(edge => 
        subsumedNodes.has(edge.from)
      );

      if (allIncomingFromIncluded) {
        subsumedNodes.add(node.uuid);
        changed = true;
      }
    }
  }

  return subsumedNodes;
}

/**
 * Extract a subgraph containing selected nodes, edges between them, and all subsumed nodes
 * 
 * This creates a complete subgraph where:
 * - Selected nodes are included
 * - All nodes wholly subsumed by selected nodes are included (nodes whose ALL incoming edges come from included nodes)
 * - All edges where BOTH source AND target are in the included nodes
 * - All node and edge properties are preserved
 */
export function extractSubgraph(options: ExtractSubgraphOptions): ExtractedSubgraph {
  const { selectedNodeIds, selectedPostitIds, graph, includeConnectedEdges = true } = options;

  if (!graph || !graph.nodes || !graph.edges) {
    return { nodes: [], edges: [], postits: [] };
  }

  const selectedNodeSet = new Set(selectedNodeIds);

  // Find all nodes that are wholly subsumed by the selected nodes
  const allIncludedNodes = findSubsumedNodes(selectedNodeSet, graph.nodes, graph.edges);

  // Extract nodes that are in the included set
  const extractedNodes = graph.nodes.filter(node => 
    allIncludedNodes.has(node.uuid)
  );

  // Extract edges where both source AND target are in the included nodes
  const extractedEdges = includeConnectedEdges
    ? graph.edges.filter(edge => 
        allIncludedNodes.has(edge.from) && allIncludedNodes.has(edge.to)
      )
    : [];

  // Extract selected post-its
  const extractedPostits: PostIt[] = [];
  if (selectedPostitIds && selectedPostitIds.length > 0 && graph.postits) {
    const postitIdSet = new Set(selectedPostitIds);
    for (const p of graph.postits) {
      if (postitIdSet.has(p.id)) extractedPostits.push(p);
    }
  }

  // Deep clone to avoid reference issues
  const clonedNodes = structuredClone(extractedNodes);
  const clonedEdges = structuredClone(extractedEdges);
  const clonedPostits = structuredClone(extractedPostits);

  return {
    nodes: clonedNodes,
    edges: clonedEdges,
    postits: clonedPostits,
  };
}

/**
 * Create a complete graph object from extracted subgraph
 */
export function createGraphFromSubgraph(
  subgraph: ExtractedSubgraph,
  metadata: {
    name: string;
    description?: string;
  }
): Graph {
  return {
    nodes: subgraph.nodes,
    edges: subgraph.edges,
    ...(subgraph.postits.length > 0 ? { postits: subgraph.postits } : {}),
    policies: {
      default_outcome: 'outcome',
      overflow_policy: 'normalize',
      free_edge_policy: 'complement'
    },
    metadata: {
      version: '1.0.0',
      created_at: new Date().toISOString(),
      author: 'user',
      description: metadata.description || `Extracted subgraph: ${metadata.name}`,
      tags: ['extracted-subgraph']
    }
  };
}

/**
 * Generate a unique name for a new subgraph
 */
export function generateSubgraphName(selectedNodeCount: number): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `subgraph-${selectedNodeCount}nodes-${timestamp}`;
}

