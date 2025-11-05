/**
 * Deterministic graph runner with conditional probability support.
 * 
 * Uses state-space expansion to track path-dependent probabilities.
 * State = (nodeId, visitedSet) where visitedSet only contains nodes
 * that are referenced in conditional probability conditions.
 */

import type { Graph, GraphEdge, GraphNode } from './types';

export interface RunnerResult {
  nodeProbabilities: Map<string, number>;
  /** Expected costs to reach each node (probability-weighted) */
  nodeCosts: Map<string, { monetary: number; time: number }>;
  /** For debugging: shows all states that were computed */
  states: Map<string, number>;
  /** Nodes that were tracked for conditional probabilities */
  trackedNodes: Set<string>;
}

export interface RunnerOptions {
  /** What-if analysis: case node overrides */
  caseOverrides?: Map<string, string>; // caseNodeId → variantName
  /** What-if analysis: conditional probability overrides */
  conditionalOverrides?: Map<string, Set<string>>; // edgeId → Set<nodeIds>
}

/**
 * Find all nodes that are referenced in any conditional probability condition.
 * These are the only nodes we need to track in the visited set.
 */
function findTrackedNodes(graph: Graph): Set<string> {
  const tracked = new Set<string>();
  
  for (const edge of graph.edges) {
    if (edge.conditional_p) {
      for (const conditionalProb of edge.conditional_p) {
        for (const nodeId of conditionalProb.condition.visited) {
          tracked.add(nodeId);
        }
      }
    }
  }
  
  return tracked;
}

/**
 * Get the effective probability for an edge given the current visited set.
 * Respects what-if overrides if provided.
 */
function getEffectiveEdgeProbability(
  edge: GraphEdge,
  visitedSet: Set<string>,
  graph: Graph,
  options?: RunnerOptions
): number {
  // Handle case edges first
  if (edge.case_id && edge.case_variant) {
    // Check for what-if override
    const overrideVariant = options?.caseOverrides?.get(edge.case_id);
    
    if (overrideVariant) {
      // What-if: variant at 100% or 0%
      const variantWeight = edge.case_variant === overrideVariant ? 1.0 : 0.0;
      const subRouteProb = edge.p?.mean ?? 1.0;
      return variantWeight * subRouteProb;
    } else {
      // Normal: use variant weight from case node
      const caseNode = graph.nodes.find((n: any) => 
        n.type === 'case' && n.case?.id === edge.case_id
      );
      const variant = caseNode?.case?.variants?.find((v: any) => 
        v.name === edge.case_variant
      );
      const variantWeight = variant?.weight ?? 0;
      const subRouteProb = edge.p?.mean ?? 1.0;
      return variantWeight * subRouteProb;
    }
  }
  
  // Check for conditional probability what-if override
  if (options?.conditionalOverrides?.has(edge.uuid)) {
    const overrideVisitedSet = options.conditionalOverrides.get(edge.uuid)!;
    
    // Find matching conditional probability for this override
    if (edge.conditional_p) {
      for (const conditionalProb of edge.conditional_p) {
        const requiredNodes = new Set(conditionalProb.condition.visited);
        
        if (setsEqual(requiredNodes, overrideVisitedSet)) {
          return conditionalProb.p.mean ?? 0.5;
        }
      }
    }
    
    // If override doesn't match any condition, use base
    return edge.p?.mean ?? 0.5;
  }
  
  // Check for matching conditional probability based on actual visited set
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    for (const conditionalProb of edge.conditional_p) {
      const requiredNodes = new Set(conditionalProb.condition.visited);
      
      // Exact match: visited set must contain exactly these nodes (and no others)
      if (setsEqual(requiredNodes, visitedSet)) {
        return conditionalProb.p.mean ?? 0.5;
      }
    }
  }
  
  // No conditional matched, use base probability
  return edge.p?.mean ?? 0.5;
}

/**
 * Check if two sets are equal.
 */
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

/**
 * Serialize a visited set to a string key for the state map.
 * Only includes nodes that are in the tracked set.
 */
function serializeVisitedSet(visitedSet: Set<string>, trackedNodes: Set<string>): string {
  const relevant = Array.from(visitedSet).filter(id => trackedNodes.has(id));
  return relevant.sort().join(',');
}

/**
 * Parse a serialized visited set back to a Set.
 */
function parseVisitedSet(serialized: string): Set<string> {
  if (!serialized) return new Set();
  return new Set(serialized.split(','));
}

/**
 * Get outgoing edges from a node.
 * Handles both UUID and human-readable ID references.
 */
function getOutgoingEdges(nodeId: string, graph: Graph): GraphEdge[] {
  // Find the actual node to get both uuid and id
  const node = graph.nodes.find(n => n.uuid === nodeId || n.id === nodeId);
  if (!node) return [];
  
  // Match edges where from matches EITHER uuid or id
  return graph.edges.filter(e => e.from === node.uuid || e.from === node.id);
}

/**
 * Build a reachability map: for each node, which nodes are reachable downstream
 */
function buildReachableFrom(graph: Graph): Map<string, Set<string>> {
  const adj = new Map<string, string[]>();
  const memo = new Map<string, Set<string>>();

  // Initialize with human-readable IDs as canonical keys
  for (const node of graph.nodes) {
    adj.set(node.id, []);
  }
  
  // Resolve edge.from/to to human-readable IDs
  for (const edge of graph.edges) {
    const fromNode = graph.nodes.find(n => n.uuid === edge.from || n.id === edge.from);
    const toNode = graph.nodes.find(n => n.uuid === edge.to || n.id === edge.to);
    if (fromNode && toNode) {
      adj.get(fromNode.id)!.push(toNode.id);
    }
  }

  const dfs = (nodeId: string): Set<string> => {
    if (memo.has(nodeId)) return memo.get(nodeId)!;
    const reach = new Set<string>();
    for (const nbr of adj.get(nodeId) || []) {
      reach.add(nbr);
      const sub = dfs(nbr);
      for (const x of sub) reach.add(x);
    }
    memo.set(nodeId, reach);
    return reach;
  };

  for (const node of graph.nodes) {
    dfs(node.id);
  }
  return memo;
}

/**
 * Topological sort for DAG.
 * Returns nodes in order such that all dependencies come before dependents.
 */
function topologicalSort(graph: Graph): string[] {
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();
  
  // Initialize with human-readable IDs as canonical keys
  for (const node of graph.nodes) {
    inDegree.set(node.id, 0);
    adjList.set(node.id, []);
  }
  
  // Build adjacency list and in-degrees, resolving edge.from/to
  for (const edge of graph.edges) {
    const fromNode = graph.nodes.find(n => n.uuid === edge.from || n.id === edge.from);
    const toNode = graph.nodes.find(n => n.uuid === edge.to || n.id === edge.to);
    if (fromNode && toNode) {
      adjList.get(fromNode.id)!.push(toNode.id);
      inDegree.set(toNode.id, (inDegree.get(toNode.id) || 0) + 1);
    }
  }
  
  // Queue of nodes with no incoming edges
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(nodeId);
    }
  }
  
  const sorted: string[] = [];
  
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    sorted.push(nodeId);
    
    for (const neighbor of adjList.get(nodeId) || []) {
      inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
      if (inDegree.get(neighbor) === 0) {
        queue.push(neighbor);
      }
    }
  }
  
  if (sorted.length !== graph.nodes.length) {
    console.warn('Graph contains a cycle! Topological sort incomplete.');
  }
  
  return sorted;
}

/**
 * Calculate node probabilities using state-space expansion.
 * 
 * State = (nodeId, visitedSet) where visitedSet only contains nodes
 * referenced in conditional probabilities.
 * 
 * For DAGs, we can process in topological order for efficiency.
 */
export function calculateProbabilities(
  graph: Graph,
  options?: RunnerOptions
): RunnerResult {
  // 1. Find which nodes need to be tracked
  const trackedNodes = findTrackedNodes(graph);
  
  console.log('🧮 Runner: Starting calculation');
  console.log('  ↳ Tracked nodes:', Array.from(trackedNodes).map(uuid => {
    const node = graph.nodes.find(n => n.uuid === uuid);
    return node?.id || node?.label || uuid;
  }));
  
  // Log what-if overrides
  if (options?.caseOverrides) {
    console.log('  ↳ Case overrides:', Array.from(options.caseOverrides.entries()).map(([caseId, variant]) => {
      return `case_id=${caseId} → ${variant}`;
    }));
  }
  if (options?.conditionalOverrides) {
    console.log('  ↳ Conditional overrides:', options.conditionalOverrides.size);
  }
  
  // 2. Initialize state space: Map from "nodeId|visitedSet" → probability
  const states = new Map<string, number>();
  // Track cumulative edge costs for each state (just sum of edge costs along path)
  const stateCosts = new Map<string, { monetary: number; time: number }>();
  // Track edge traverse probabilities per attempt (unconditional flows)
  const edgeTraverseProb = new Map<string, number>();
  
  // 3. Find start nodes and initialize with probability 1.0 and cost 0
  for (const node of graph.nodes) {
    if (node.entry?.is_start) {
      const stateKey = `${node.id}|`; // Empty visited set
      states.set(stateKey, 1.0);
      stateCosts.set(stateKey, { monetary: 0, time: 0 });
      console.log(`  ↳ Start node: ${node.id || node.label} (${stateKey})`);
    }
  }
  
  if (states.size === 0) {
    console.warn('⚠️  No start nodes found!');
    return {
      nodeProbabilities: new Map(),
      nodeCosts: new Map(),
      states,
      trackedNodes
    };
  }
  
  // 4. Process nodes in topological order
  const sortedNodes = topologicalSort(graph);
  
  console.log(`  ↳ Processing ${sortedNodes.length} nodes in topological order`);
  
  for (const nodeId of sortedNodes) {
    // Find all states for this node
    const nodeStates = Array.from(states.entries()).filter(([key]) => 
      key.startsWith(`${nodeId}|`)
    );
    
    // For each state (nodeId, visitedSet) with probability P
    for (const [stateKey, prob] of nodeStates) {
      if (prob === 0) continue; // Skip zero-probability states
      
      const visitedStr = stateKey.split('|')[1];
      const visitedSet = parseVisitedSet(visitedStr);
      
      // Get cumulative cost along the path to this state
      const currentCumulativeCost = stateCosts.get(stateKey) || { monetary: 0, time: 0 };
      
      // Get outgoing edges
      const outgoingEdges = getOutgoingEdges(nodeId, graph);
      
      for (const edge of outgoingEdges) {
        // Get effective probability for this edge given current visited set
        const edgeProb = getEffectiveEdgeProbability(edge, visitedSet, graph, options);
        
        if (edgeProb === 0) continue; // Skip zero-probability edges
        
        // Get edge cost from new flat schema (cost_gbp, cost_time)
        const edgeCost = {
          monetary: (edge as any).cost_gbp?.mean || 0,
          time: (edge as any).cost_time?.mean || 0
        };
        
        // Calculate next visited set
        const nextVisitedSet = new Set(visitedSet);
        if (trackedNodes.has(nodeId)) {
          nextVisitedSet.add(nodeId);
        }
        
        // Resolve edge.to to human-readable ID for state key
        const toNode = graph.nodes.find(n => n.uuid === edge.to || n.id === edge.to);
        if (!toNode) continue;
        
        // Create next state key using human-readable ID
        const nextVisitedStr = serializeVisitedSet(nextVisitedSet, trackedNodes);
        const nextStateKey = `${toNode.id}|${nextVisitedStr}`;
        
        // Accumulate probability
        const w = prob * edgeProb;
        const prevProb = states.get(nextStateKey) || 0;
        const newStateProb = prevProb + w;
        states.set(nextStateKey, newStateProb);

        // Accumulate edge traverse probability
        edgeTraverseProb.set(edge.uuid, (edgeTraverseProb.get(edge.uuid) || 0) + w);
        
        // Cumulative cost to next state = current cumulative + edge cost
        const nextCumulativeCost = {
          monetary: currentCumulativeCost.monetary + edgeCost.monetary,
          time: currentCumulativeCost.time + edgeCost.time
        };
        
        // For convergent paths, take weighted average of cumulative costs
        const prevCost = stateCosts.get(nextStateKey);
        if (prevCost && prevProb > 0) {
          // Weighted average by relative probabilities
          const prevWeight = prevProb / newStateProb;
          const newWeight = (prob * edgeProb) / newStateProb;
          stateCosts.set(nextStateKey, {
            monetary: (prevCost.monetary * prevWeight) + (nextCumulativeCost.monetary * newWeight),
            time: (prevCost.time * prevWeight) + (nextCumulativeCost.time * newWeight)
          });
        } else {
          stateCosts.set(nextStateKey, nextCumulativeCost);
        }
      }
    }
  }
  
  console.log(`  ↳ Generated ${states.size} states`);
  
  // 5. Aggregate probabilities
  const nodeProbabilities = new Map<string, number>();
  for (const [stateKey, prob] of states) {
    const nodeId = stateKey.split('|')[0];
    nodeProbabilities.set(nodeId, (nodeProbabilities.get(nodeId) || 0) + prob);
  }

  // 6. Compute cost per arrival: expected cost per attempt upstream of node, divided by p(node)
  const reachableFrom = buildReachableFrom(graph);
  const nodeCosts = new Map<string, { monetary: number; time: number }>();

  // Precompute edge costs (using new flat schema)
  const edgeCostMap = new Map<string, { monetary: number; time: number }>();
  for (const e of graph.edges) {
    const edgeCost = {
      monetary: (e as any).cost_gbp?.mean || 0,
      time: (e as any).cost_time?.mean || 0
    };
    edgeCostMap.set(e.uuid, edgeCost);
  }

  for (const node of graph.nodes) {
    const prob = nodeProbabilities.get(node.id) || 0;
    if (prob === 0) {
      nodeCosts.set(node.id, { monetary: 0, time: 0 });
      continue;
    }

    // Sum expected cost per attempt for edges upstream of this node
    let expectedAttemptCostMonetary = 0;
    let expectedAttemptCostTime = 0;

    for (const e of graph.edges) {
      // Resolve edge.to to human-readable ID
      const toNode = graph.nodes.find(n => n.uuid === e.to || n.id === e.to);
      if (!toNode) continue;
      
      const edgeReach = reachableFrom.get(toNode.id) || new Set<string>();
      if (toNode.id === node.id || edgeReach.has(node.id)) {
        const traverseP = edgeTraverseProb.get(e.uuid) || 0;
        const cost = edgeCostMap.get(e.uuid)!;
        expectedAttemptCostMonetary += traverseP * cost.monetary;
        expectedAttemptCostTime += traverseP * cost.time;
      }
    }

    nodeCosts.set(node.id, {
      monetary: expectedAttemptCostMonetary / prob,
      time: expectedAttemptCostTime / prob
    });
  }
  
  console.log(`  ↳ Calculated probabilities and costs for ${nodeProbabilities.size} nodes`);
  
  // Log top 5 probabilities for debugging
  const topNodes = Array.from(nodeProbabilities.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  
  console.log('  ↳ Top 5 node probabilities with costs:');
  for (const [nodeId, prob] of topNodes) {
    const node = graph.nodes.find(n => n.id === nodeId);
    const cost = nodeCosts.get(nodeId);
    if (cost && cost.monetary > 0) {
      console.log(`    • ${node?.label || node?.id || nodeId}: ${(prob * 100).toFixed(1)}% (£${cost.monetary.toFixed(2)} per arrival)`);
    } else {
      console.log(`    • ${node?.label || node?.id || nodeId}: ${(prob * 100).toFixed(1)}%`);
    }
  }
  
  return {
    nodeProbabilities,
    nodeCosts,
    states,
    trackedNodes
  };
}

/**
 * Calculate probabilities and return as a simple object for easier consumption.
 */
export function runGraph(graph: Graph, options?: RunnerOptions): Record<string, number> {
  const result = calculateProbabilities(graph, options);
  const obj: Record<string, number> = {};
  
  for (const [nodeId, prob] of result.nodeProbabilities) {
    obj[nodeId] = prob;
  }
  
  return obj;
}

