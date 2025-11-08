/**
 * Graph Mutation Service
 * 
 * Wraps graph updates to detect topology changes and trigger cascades (MSMDC, etc.)
 * 
 * Usage:
 *   Instead of: setGraph(newGraph)
 *   Use: graphMutationService.updateGraph(oldGraph, newGraph, setGraph, options)
 * 
 * This service will:
 * 1. Detect if topology changed (nodes/edges added/removed/reconnected)
 * 2. Trigger async query regeneration if needed
 * 3. Call setGraph with updated graph (including regenerated queries)
 * 4. Cascade to parameter files (if not overridden)
 */

import toast from 'react-hot-toast';
import { queryRegenerationService } from './queryRegenerationService';
import type { Graph } from '../types';

/**
 * Detect if a graph change is topology-related (vs data-only)
 */
function detectTopologyChange(oldGraph: Graph | null, newGraph: Graph | null): {
  hasChange: boolean;
  changeType?: string;
  affectedNode?: string;
} {
  if (!oldGraph || !newGraph) {
    return { hasChange: false };
  }
  
  // Check node count
  if (oldGraph.nodes.length !== newGraph.nodes.length) {
    return {
      hasChange: true,
      changeType: oldGraph.nodes.length < newGraph.nodes.length ? 'node-added' : 'node-removed'
    };
  }
  
  // Check edge count
  if (oldGraph.edges.length !== newGraph.edges.length) {
    return {
      hasChange: true,
      changeType: oldGraph.edges.length < newGraph.edges.length ? 'edge-added' : 'edge-removed'
    };
  }
  
  // Check node UUIDs (detect node replacement)
  const oldNodeUUIDs = new Set(oldGraph.nodes.map(n => n.uuid));
  const newNodeUUIDs = new Set(newGraph.nodes.map(n => n.uuid));
  for (const uuid of newNodeUUIDs) {
    if (!oldNodeUUIDs.has(uuid)) {
      return { hasChange: true, changeType: 'node-added' };
    }
  }
  for (const uuid of oldNodeUUIDs) {
    if (!newNodeUUIDs.has(uuid)) {
      return { hasChange: true, changeType: 'node-removed', affectedNode: uuid };
    }
  }
  
  // Check edge UUIDs (detect edge replacement)
  const oldEdgeUUIDs = new Set(oldGraph.edges.map(e => e.uuid));
  const newEdgeUUIDs = new Set(newGraph.edges.map(e => e.uuid));
  for (const uuid of newEdgeUUIDs) {
    if (!oldEdgeUUIDs.has(uuid)) {
      return { hasChange: true, changeType: 'edge-added' };
    }
  }
  for (const uuid of oldEdgeUUIDs) {
    if (!newEdgeUUIDs.has(uuid)) {
      return { hasChange: true, changeType: 'edge-removed' };
    }
  }
  
  // Check edge connectivity (from/to changes)
  const oldEdgeMap = new Map(oldGraph.edges.map(e => [e.uuid, `${e.from}->${e.to}`]));
  const newEdgeMap = new Map(newGraph.edges.map(e => [e.uuid, `${e.from}->${e.to}`]));
  for (const [uuid, connectivity] of newEdgeMap) {
    if (oldEdgeMap.has(uuid) && oldEdgeMap.get(uuid) !== connectivity) {
      return { hasChange: true, changeType: 'edge-connectivity-changed' };
    }
  }
  
  // Check conditional_p conditions (semantic changes)
  for (let i = 0; i < newGraph.edges.length; i++) {
    const oldEdge = oldGraph.edges.find(e => e.uuid === newGraph.edges[i].uuid);
    if (!oldEdge) continue;
    
    const oldConditions = oldEdge.conditional_p?.map(c => c.condition).join(',') || '';
    const newConditions = newGraph.edges[i].conditional_p?.map(c => c.condition).join(',') || '';
    
    if (oldConditions !== newConditions) {
      return { hasChange: true, changeType: 'conditional-condition-changed' };
    }
  }
  
  return { hasChange: false };
}

class GraphMutationService {
  private regenerationInProgress = false;
  private pendingRegeneration: {
    graph: Graph;
    setGraph: ((graph: Graph | null) => void) | ((graph: Graph) => void);
  } | null = null;
  
  /**
   * Update graph with automatic query regeneration on topology changes
   * 
   * @param oldGraph - Current graph state (for change detection)
   * @param newGraph - New graph state to apply
   * @param setGraph - Function to update graph store
   * @param options - Optional configuration
   */
  async updateGraph(
    oldGraph: Graph | null,
    newGraph: Graph | null,
    setGraph: ((graph: Graph | null) => void) | ((graph: Graph) => void),
    options?: {
      skipQueryRegeneration?: boolean;
      downstreamOf?: string;
      literalWeights?: { visited: number; exclude: number };
      setAutoUpdating?: (updating: boolean) => void;
    }
  ): Promise<void> {
    console.log('🔄 [GraphMutation] updateGraph called', {
      hasOldGraph: !!oldGraph,
      hasNewGraph: !!newGraph,
      oldNodeCount: oldGraph?.nodes?.length,
      newNodeCount: newGraph?.nodes?.length,
      oldEdgeCount: oldGraph?.edges?.length,
      newEdgeCount: newGraph?.edges?.length,
      skipRegen: options?.skipQueryRegeneration
    });
    
    if (!newGraph) {
      (setGraph as (graph: Graph | null) => void)(null);
      return;
    }
    
    // Apply graph update immediately (don't block UI)
    setGraph(newGraph);
    
    // Skip if regeneration disabled
    if (options?.skipQueryRegeneration) {
      console.log('⏭️  [GraphMutation] Skipping regeneration (disabled)');
      return;
    }
    
    // Detect topology change
    const change = detectTopologyChange(oldGraph, newGraph);
    
    if (!change.hasChange) {
      console.log('✅ [GraphMutation] No topology change detected - skipping regeneration');
      return;  // Data-only change, no query regeneration needed
    }
    
    console.log('🚨 [GraphMutation] TOPOLOGY CHANGE DETECTED:', change);
    
    // If regeneration already in progress, queue this one
    if (this.regenerationInProgress) {
      console.log('[GraphMutation] Regeneration in progress, queuing...');
      this.pendingRegeneration = { graph: newGraph, setGraph };
      return;
    }
    
    // Start async regeneration (non-blocking)
    this.regenerateQueriesAsync(newGraph, setGraph, {
      downstreamOf: options?.downstreamOf || change.affectedNode,
      literalWeights: options?.literalWeights,
      setAutoUpdating: options?.setAutoUpdating
    }).catch(err => {
      console.error('[GraphMutation] Query regeneration failed:', err);
      toast.error('Failed to regenerate queries - see console');
    });
  }
  
  /**
   * Async query regeneration (runs in background)
   */
  private async regenerateQueriesAsync(
    graph: Graph,
    setGraph: ((graph: Graph | null) => void) | ((graph: Graph) => void),
    options?: {
      downstreamOf?: string;
      literalWeights?: { visited: number; exclude: number };
      setAutoUpdating?: (updating: boolean) => void;
    }
  ): Promise<void> {
    this.regenerationInProgress = true;
    const startTime = performance.now();
    
    // Set auto-updating flag for animation
    console.log('🎬 [GraphMutation] Setting isAutoUpdating = true');
    options?.setAutoUpdating?.(true);
    
    try {
      // Step 1: Call Python MSMDC
      console.log('[GraphMutation] Calling MSMDC...', {
        downstreamOf: options?.downstreamOf,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length
      });
      
      const result = await queryRegenerationService.regenerateQueries(graph, {
        downstreamOf: options?.downstreamOf,
        literalWeights: options?.literalWeights || { visited: 10, exclude: 1 },
        preserveCondition: true
      });
      
      const elapsed = performance.now() - startTime;
      console.log('[GraphMutation] MSMDC completed in', elapsed.toFixed(0), 'ms', {
        parametersGenerated: result.parameters.length
      });
      
      // Step 2: Apply regenerated queries to graph
      const updatedGraph = structuredClone(graph);
      const applyResult = await queryRegenerationService.applyRegeneratedQueries(
        updatedGraph,
        result.parameters
      );
      
      console.log('[GraphMutation] Applied queries:', {
        graphUpdates: applyResult.graphUpdates,
        fileUpdates: applyResult.fileUpdates,
        skipped: applyResult.skipped
      });
      
      // Step 3: Update graph store with regenerated queries
      if (applyResult.graphUpdates > 0) {
        updatedGraph.metadata = updatedGraph.metadata || {
          version: '1.0.0',
          created_at: new Date().toISOString()
        };
        updatedGraph.metadata.updated_at = new Date().toISOString();
        
        setGraph(updatedGraph);
        
        // Notify user
        if (applyResult.graphUpdates > 0) {
          toast.success(`✓ Regenerated ${applyResult.graphUpdates} queries`, { duration: 3000 });
        }
      } else {
        console.log('[GraphMutation] No query changes needed');
      }
      
    } catch (error) {
      console.error('[GraphMutation] Regeneration error:', error);
      // Don't throw - graph is already updated, this is just cascade failure
      toast.error('Query regeneration failed - queries may be stale');
    } finally {
      this.regenerationInProgress = false;
      
      // Clear auto-updating flag after a delay to ensure animations trigger
      // Components need to see isAutoUpdating=true when their values change
      setTimeout(() => {
        console.log('🎬 [GraphMutation] Setting isAutoUpdating = false');
        options?.setAutoUpdating?.(false);
      }, 100);
      
      // Process queued regeneration if any
      if (this.pendingRegeneration) {
        const { graph: pendingGraph, setGraph: pendingSetGraph } = this.pendingRegeneration;
        this.pendingRegeneration = null;
        
        console.log('[GraphMutation] Processing queued regeneration');
        await this.regenerateQueriesAsync(pendingGraph, pendingSetGraph);
      }
    }
  }
  
  /**
   * Manual trigger for query regeneration (for user-initiated regeneration)
   */
  async regenerateAllQueries(
    graph: Graph,
    setGraph: ((graph: Graph | null) => void) | ((graph: Graph) => void),
    options?: {
      literalWeights?: { visited: number; exclude: number };
    }
  ): Promise<void> {
    toast.loading('Regenerating all queries...', { id: 'query-regen' });
    
    try {
      await this.regenerateQueriesAsync(graph, setGraph, {
        downstreamOf: undefined,  // Regenerate ALL
        literalWeights: options?.literalWeights
      });
      
      toast.success('All queries regenerated', { id: 'query-regen' });
    } catch (error) {
      toast.error('Failed to regenerate queries', { id: 'query-regen' });
      throw error;
    }
  }
}

// Singleton instance
export const graphMutationService = new GraphMutationService();

