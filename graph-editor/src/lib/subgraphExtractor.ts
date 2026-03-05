/**
 * Subgraph Extractor
 * 
 * Utility for extracting a subgraph from selected nodes
 */

import { GraphNode, GraphEdge, Graph, PostIt } from '../types';

/** Maps ReactFlow ID prefix → graph array key for all canvas object types. */
export const CANVAS_OBJECT_TYPES = [
  { prefix: 'postit-', graphKey: 'postits' },
  { prefix: 'container-', graphKey: 'containers' },
  { prefix: 'analysis-', graphKey: 'canvasAnalyses' },
] as const;

export type CanvasObjectGraphKey = typeof CANVAS_OBJECT_TYPES[number]['graphKey'];

export interface ExtractSubgraphOptions {
  selectedNodeIds: string[];
  /** Per-type selected canvas object IDs (without prefix). Keys match CANVAS_OBJECT_TYPES[].graphKey. */
  selectedCanvasObjectIds?: Partial<Record<CanvasObjectGraphKey, string[]>>;
  /** @deprecated Use selectedCanvasObjectIds.postits instead */
  selectedPostitIds?: string[];
  graph: Graph;
  includeConnectedEdges?: boolean;
}

export interface ExtractedSubgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  postits: PostIt[];
  containers: any[];
  canvasAnalyses: any[];
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

  while (changed) {
    changed = false;
    
    for (const node of allNodes) {
      if (subsumedNodes.has(node.uuid)) {
        continue;
      }

      const incomingEdges = allEdges.filter(edge => edge.to === node.uuid);
      
      if (incomingEdges.length === 0) {
        continue;
      }

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
 * Extract canvas objects from a graph by selected IDs.
 * Works for any canvas object type (postits, containers, canvasAnalyses).
 */
function extractCanvasObjects(
  graph: any,
  graphKey: string,
  selectedIds: string[] | undefined
): any[] {
  if (!selectedIds || selectedIds.length === 0 || !graph[graphKey]) return [];
  const idSet = new Set(selectedIds);
  return graph[graphKey].filter((obj: any) => idSet.has(obj.id));
}

export function extractSubgraph(options: ExtractSubgraphOptions): ExtractedSubgraph {
  const { selectedNodeIds, selectedCanvasObjectIds, selectedPostitIds, graph, includeConnectedEdges = true } = options;

  if (!graph || !graph.nodes || !graph.edges) {
    return { nodes: [], edges: [], postits: [], containers: [], canvasAnalyses: [] };
  }

  const selectedNodeSet = new Set(selectedNodeIds);
  const allIncludedNodes = findSubsumedNodes(selectedNodeSet, graph.nodes, graph.edges);

  const extractedNodes = graph.nodes.filter(node => 
    allIncludedNodes.has(node.uuid)
  );

  const extractedEdges = includeConnectedEdges
    ? graph.edges.filter(edge => 
        allIncludedNodes.has(edge.from) && allIncludedNodes.has(edge.to)
      )
    : [];

  // Merge legacy selectedPostitIds into the generalised map
  const canvasIds: Partial<Record<CanvasObjectGraphKey, string[]>> = { ...selectedCanvasObjectIds };
  if (selectedPostitIds && selectedPostitIds.length > 0) {
    canvasIds.postits = [...(canvasIds.postits || []), ...selectedPostitIds];
  }

  const clonedNodes = structuredClone(extractedNodes);
  const clonedEdges = structuredClone(extractedEdges);

  return {
    nodes: clonedNodes,
    edges: clonedEdges,
    postits: structuredClone(extractCanvasObjects(graph, 'postits', canvasIds.postits)),
    containers: structuredClone(extractCanvasObjects(graph, 'containers', canvasIds.containers)),
    canvasAnalyses: structuredClone(extractCanvasObjects(graph, 'canvasAnalyses', canvasIds.canvasAnalyses)),
  };
}

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
    ...(subgraph.containers.length > 0 ? { containers: subgraph.containers } : {}),
    ...(subgraph.canvasAnalyses.length > 0 ? { canvasAnalyses: subgraph.canvasAnalyses } : {}),
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

export function generateSubgraphName(selectedNodeCount: number): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `subgraph-${selectedNodeCount}nodes-${timestamp}`;
}
