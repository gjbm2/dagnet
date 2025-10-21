/**
 * Utility functions for creating stable, unambiguous references to conditional probabilities.
 * 
 * Reference Format:
 * - Base probability: e.<edge-slug>.p.mean
 * - Conditional probability: e.<edge-slug>.visited(<node-slug-1>,<node-slug-2>).p.mean
 * 
 * Examples:
 * - e.gives-bd-to-stops-switch.p.mean
 * - e.gives-bd-to-stops-switch.visited(coffee_promotion).p.mean
 * - e.gives-bd-to-stops-switch.visited(coffee_promotion,email_promo).p.stdev
 */

import type { GraphEdge, ConditionalProbability, Graph } from './types';

/**
 * Generate a stable reference for a conditional probability parameter.
 * 
 * @param edgeSlug - The edge slug (e.g., "gives-bd-to-stops-switch")
 * @param nodeSlugs - Array of node slugs that form the condition (will be sorted)
 * @param param - The parameter name (e.g., "mean", "stdev")
 * @returns A stable reference string
 */
export function generateConditionalReference(
  edgeSlug: string,
  nodeSlugs: string[],
  param: 'mean' | 'stdev'
): string {
  if (nodeSlugs.length === 0) {
    // Base case - no condition
    return `e.${edgeSlug}.p.${param}`;
  }
  
  // Sort node slugs alphabetically for determinism
  const sortedSlugs = [...nodeSlugs].sort();
  const conditionPart = `visited(${sortedSlugs.join(',')})`;
  
  return `e.${edgeSlug}.${conditionPart}.p.${param}`;
}

/**
 * Parse a conditional probability reference back into its components.
 * 
 * @param reference - The reference string to parse
 * @returns Parsed components or null if invalid
 */
export function parseConditionalReference(reference: string): {
  edgeSlug: string;
  nodeSlugs: string[];
  param: 'mean' | 'stdev';
  isConditional: boolean;
} | null {
  // Match pattern: e.<edge-slug>.p.<param> OR e.<edge-slug>.visited(<slugs>).p.<param>
  const basePattern = /^e\.([^.]+)\.p\.(mean|stdev)$/;
  const conditionalPattern = /^e\.([^.]+)\.visited\(([^)]+)\)\.p\.(mean|stdev)$/;
  
  // Try conditional pattern first
  const conditionalMatch = reference.match(conditionalPattern);
  if (conditionalMatch) {
    const [, edgeSlug, nodeSlugsStr, param] = conditionalMatch;
    const nodeSlugs = nodeSlugsStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
    
    return {
      edgeSlug,
      nodeSlugs: nodeSlugs.sort(), // Ensure sorted
      param: param as 'mean' | 'stdev',
      isConditional: true
    };
  }
  
  // Try base pattern
  const baseMatch = reference.match(basePattern);
  if (baseMatch) {
    const [, edgeSlug, param] = baseMatch;
    
    return {
      edgeSlug,
      nodeSlugs: [],
      param: param as 'mean' | 'stdev',
      isConditional: false
    };
  }
  
  return null;
}

/**
 * Get all conditional probability references for an edge.
 * 
 * @param edge - The edge to generate references for
 * @param graph - The graph (needed to resolve node IDs to slugs)
 * @returns Array of reference objects with their values
 */
export function getEdgeConditionalReferences(
  edge: GraphEdge,
  graph: Graph
): Array<{
  reference: string;
  value: number;
  param: 'mean' | 'stdev';
  nodeSlugs: string[];
  isBase: boolean;
}> {
  const references: Array<{
    reference: string;
    value: number;
    param: 'mean' | 'stdev';
    nodeSlugs: string[];
    isBase: boolean;
  }> = [];
  
  if (!edge.slug) {
    console.warn(`Edge ${edge.id} has no slug, cannot generate references`);
    return references;
  }
  
  // Base probability references
  if (edge.p) {
    if (edge.p.mean !== undefined) {
      references.push({
        reference: generateConditionalReference(edge.slug, [], 'mean'),
        value: edge.p.mean,
        param: 'mean',
        nodeSlugs: [],
        isBase: true
      });
    }
    if (edge.p.stdev !== undefined) {
      references.push({
        reference: generateConditionalReference(edge.slug, [], 'stdev'),
        value: edge.p.stdev,
        param: 'stdev',
        nodeSlugs: [],
        isBase: true
      });
    }
  }
  
  // Conditional probability references
  if (edge.conditional_p) {
    for (const conditionalProb of edge.conditional_p) {
      // Resolve node IDs to slugs
      const nodeSlugs = conditionalProb.condition.visited
        .map(nodeId => {
          const node = graph.nodes.find(n => n.id === nodeId);
          if (!node?.slug) {
            console.warn(`Node ${nodeId} not found or has no slug`);
            return null;
          }
          return node.slug;
        })
        .filter((slug): slug is string => slug !== null);
      
      // Skip if we couldn't resolve all node slugs
      if (nodeSlugs.length !== conditionalProb.condition.visited.length) {
        continue;
      }
      
      // Generate references for mean and stdev
      if (conditionalProb.p.mean !== undefined) {
        references.push({
          reference: generateConditionalReference(edge.slug, nodeSlugs, 'mean'),
          value: conditionalProb.p.mean,
          param: 'mean',
          nodeSlugs,
          isBase: false
        });
      }
      if (conditionalProb.p.stdev !== undefined) {
        references.push({
          reference: generateConditionalReference(edge.slug, nodeSlugs, 'stdev'),
          value: conditionalProb.p.stdev,
          param: 'stdev',
          nodeSlugs,
          isBase: false
        });
      }
    }
  }
  
  return references;
}

/**
 * Get all conditional probability references for the entire graph.
 * 
 * @param graph - The graph to generate references for
 * @returns Array of all reference objects
 */
export function getAllConditionalReferences(graph: Graph): Array<{
  reference: string;
  value: number;
  param: 'mean' | 'stdev';
  edgeSlug: string;
  nodeSlugs: string[];
  isBase: boolean;
}> {
  const allReferences: Array<{
    reference: string;
    value: number;
    param: 'mean' | 'stdev';
    edgeSlug: string;
    nodeSlugs: string[];
    isBase: boolean;
  }> = [];
  
  for (const edge of graph.edges) {
    const edgeRefs = getEdgeConditionalReferences(edge, graph);
    allReferences.push(...edgeRefs.map(ref => ({
      ...ref,
      edgeSlug: edge.slug || edge.id
    })));
  }
  
  return allReferences;
}

/**
 * Find a specific conditional probability value by reference.
 * 
 * @param reference - The reference string to look up
 * @param graph - The graph to search
 * @returns The value or undefined if not found
 */
export function findConditionalProbabilityByReference(
  reference: string,
  graph: Graph
): number | undefined {
  const parsed = parseConditionalReference(reference);
  if (!parsed) {
    return undefined;
  }
  
  // Find the edge
  const edge = graph.edges.find(e => e.slug === parsed.edgeSlug);
  if (!edge) {
    return undefined;
  }
  
  // Base case
  if (!parsed.isConditional) {
    return parsed.param === 'mean' ? edge.p?.mean : edge.p?.stdev;
  }
  
  // Conditional case - need to find matching condition
  if (!edge.conditional_p) {
    return undefined;
  }
  
  // Convert node slugs to IDs
  const nodeIds = parsed.nodeSlugs
    .map(slug => graph.nodes.find(n => n.slug === slug)?.id)
    .filter((id): id is string => id !== undefined);
  
  if (nodeIds.length !== parsed.nodeSlugs.length) {
    return undefined; // Couldn't resolve all slugs
  }
  
  // Find matching condition
  const nodeIdSet = new Set(nodeIds);
  for (const conditionalProb of edge.conditional_p) {
    const conditionIds = new Set(conditionalProb.condition.visited);
    
    // Check if sets are equal
    if (nodeIdSet.size === conditionIds.size && 
        [...nodeIdSet].every(id => conditionIds.has(id))) {
      return parsed.param === 'mean' ? conditionalProb.p.mean : conditionalProb.p.stdev;
    }
  }
  
  return undefined;
}

/**
 * Validate that all node and edge slugs in the graph are unique.
 * This is required for the reference system to work correctly.
 * 
 * @param graph - The graph to validate
 * @returns Object with validation results
 */
export function validateSlugUniqueness(graph: Graph): {
  isValid: boolean;
  duplicateNodeSlugs: string[];
  duplicateEdgeSlugs: string[];
  nodesWithoutSlugs: string[];
  edgesWithoutSlugs: string[];
} {
  const nodeSlugs = new Map<string, number>();
  const edgeSlugs = new Map<string, number>();
  const nodesWithoutSlugs: string[] = [];
  const edgesWithoutSlugs: string[] = [];
  
  // Check node slugs
  for (const node of graph.nodes) {
    if (!node.slug) {
      nodesWithoutSlugs.push(node.id);
    } else {
      nodeSlugs.set(node.slug, (nodeSlugs.get(node.slug) || 0) + 1);
    }
  }
  
  // Check edge slugs
  for (const edge of graph.edges) {
    if (!edge.slug) {
      edgesWithoutSlugs.push(edge.id);
    } else {
      edgeSlugs.set(edge.slug, (edgeSlugs.get(edge.slug) || 0) + 1);
    }
  }
  
  const duplicateNodeSlugs = Array.from(nodeSlugs.entries())
    .filter(([, count]) => count > 1)
    .map(([slug]) => slug);
  
  const duplicateEdgeSlugs = Array.from(edgeSlugs.entries())
    .filter(([, count]) => count > 1)
    .map(([slug]) => slug);
  
  return {
    isValid: duplicateNodeSlugs.length === 0 && 
             duplicateEdgeSlugs.length === 0 && 
             nodesWithoutSlugs.length === 0 && 
             edgesWithoutSlugs.length === 0,
    duplicateNodeSlugs,
    duplicateEdgeSlugs,
    nodesWithoutSlugs,
    edgesWithoutSlugs
  };
}

