/**
 * Query Regeneration Service
 * 
 * Handles automatic regeneration of MSMDC queries on graph topology changes.
 * 
 * Architecture:
 * - Triggered by graph LOGIC changes (topology, not data values)
 * - Calls Python MSMDC to regenerate queries
 * - Applies updates to graph (in-memory)
 * - Cascades to parameter/case files (if they exist and aren't overridden)
 * - Uses synthetic IDs for parameters without files yet
 * 
 * Synthetic ID Format: "synthetic:{uuid}:{field}"
 * - uuid: edge.uuid or node.uuid
 * - field: "p", "conditional_p[0]", "cost_gbp", "labour_cost", "case"
 */

import toast from 'react-hot-toast';
import { graphComputeClient, type ParameterQuery } from '../lib/graphComputeClient';
import { fileRegistry } from '../contexts/TabContext';
import type { Graph, GraphEdge, GraphNode } from '../types';

/**
 * Parse synthetic ID into components
 * Returns null if not a synthetic ID
 */
function parseSyntheticId(paramId: string): { uuid: string; field: string } | null {
  if (!paramId.startsWith('synthetic:')) return null;
  
  const parts = paramId.split(':');
  if (parts.length !== 3) return null;
  
  return {
    uuid: parts[1],
    field: parts[2]
  };
}

/**
 * Resolve node UUID to human-readable ID
 */
function resolveNodeId(graph: Graph, uuidOrId: string): string {
  const node = graph.nodes.find(n => n.uuid === uuidOrId || n.id === uuidOrId);
  return node?.id || uuidOrId;  // Fall back to UUID if not found
}

/**
 * Format edge location with human-readable node IDs
 */
function formatEdgeLocation(graph: Graph, edge: { from: string; to: string }, suffix?: string): string {
  const fromId = resolveNodeId(graph, edge.from);
  const toId = resolveNodeId(graph, edge.to);
  return suffix ? `edge ${fromId}->${toId} ${suffix}` : `edge ${fromId}->${toId}`;
}

/**
 * Apply regenerated query to graph (handles both real and synthetic IDs)
 */
function applyQueryToGraph(
  graph: Graph,
  paramId: string,
  newQuery: string
): { applied: boolean; location: string } {
  const synthetic = parseSyntheticId(paramId);
  
  if (synthetic) {
    // Synthetic ID: resolve to graph location and update query field
    const { uuid, field } = synthetic;
    
    // Find edge or node by UUID
    const edge = graph.edges.find(e => e.uuid === uuid);
    const node = graph.nodes.find(n => n.uuid === uuid);
    
    if (field === 'p' && edge) {
      // Base probability query (stored on edge, not edge.p)
      edge.query = newQuery;
      return { applied: true, location: formatEdgeLocation(graph, edge) };
    }
    
    if (field.startsWith('conditional_p[') && edge) {
      // Conditional probability query
      const match = field.match(/conditional_p\[(\d+)\]/);
      if (match) {
        const idx = parseInt(match[1]);
        if (edge.conditional_p && edge.conditional_p[idx]) {
          edge.conditional_p[idx].query = newQuery;
          return { applied: true, location: formatEdgeLocation(graph, edge, `conditional[${idx}]`) };
        }
      }
    }
    
    if (field === 'cost_gbp' && edge) {
      if (edge.cost_gbp) {
        (edge.cost_gbp as any).query = newQuery;
        return { applied: true, location: formatEdgeLocation(graph, edge, 'cost_gbp') };
      }
    }
    
    if (field === 'labour_cost' && edge) {
      if (edge.labour_cost) {
        (edge.labour_cost as any).query = newQuery;
        return { applied: true, location: formatEdgeLocation(graph, edge, 'labour_cost') };
      }
    }
    
    if (field === 'case' && node) {
      // Case query (stored on case node - where?)
      // TODO: Determine where case queries are stored in schema
      return { applied: false, location: `node ${node.id} case (schema location TBD)` };
    }
    
    return { applied: false, location: 'unknown' };
  } else {
    // Real param_id: find by matching id field in parameters
    // Search all edges for matching parameter file ID
    for (const edge of graph.edges) {
      // Check base p
      if (edge.p?.id === paramId) {
        edge.query = newQuery;
        return { applied: true, location: formatEdgeLocation(graph, edge) };
      }
      
      // Check conditional_p
      if (edge.conditional_p) {
        for (let i = 0; i < edge.conditional_p.length; i++) {
          if (edge.conditional_p[i].p?.id === paramId) {
            edge.conditional_p[i].query = newQuery;
            return { applied: true, location: formatEdgeLocation(graph, edge, `conditional[${i}]`) };
          }
        }
      }
      
      // Check cost_gbp
      if (edge.cost_gbp?.id === paramId) {
        if (edge.cost_gbp) {
          (edge.cost_gbp as any).query = newQuery;
        }
        return { applied: true, location: formatEdgeLocation(graph, edge, 'cost_gbp') };
      }
      
      // Check labour_cost
      if (edge.labour_cost?.id === paramId) {
        if (edge.labour_cost) {
          (edge.labour_cost as any).query = newQuery;
        }
        return { applied: true, location: formatEdgeLocation(graph, edge, 'labour_cost') };
      }
    }
    
    // Check case nodes
    for (const node of graph.nodes) {
      if (node.case?.id === paramId) {
        // Case query update (where is this stored?)
        // TODO: Determine where case queries are stored in schema
        return { applied: false, location: `node ${node.id} case (schema location TBD)` };
      }
    }
    
    return { applied: false, location: 'parameter not found in graph' };
  }
}

/**
 * Update parameter file with new query (only for real param_ids, not synthetic)
 */
async function updateParameterFile(paramId: string, newQuery: string): Promise<boolean> {
  // Skip synthetic IDs (no file exists)
  if (paramId.startsWith('synthetic:')) {
    return false;
  }
  
  // Check if file exists
  const fileId = `parameter-${paramId}`;
  const paramFile = fileRegistry.getFile(fileId);
  
  if (!paramFile) {
    return false;  // File doesn't exist yet
  }
  
  // Update query field in parameter file
  const updatedData = structuredClone(paramFile.data);
  updatedData.query = newQuery;
  
  await fileRegistry.updateFile(fileId, updatedData);
  return true;
}

/**
 * Update case file with new query (only for real case_ids, not synthetic)
 */
async function updateCaseFile(caseId: string, newQuery: string): Promise<boolean> {
  // Skip synthetic IDs (no file exists)
  if (caseId.startsWith('synthetic:')) {
    return false;
  }
  
  // Check if file exists
  const fileId = `case-${caseId}`;
  const caseFile = fileRegistry.getFile(fileId);
  
  if (!caseFile) {
    return false;  // File doesn't exist yet
  }
  
  // Update query field in case file (where is this stored?)
  // TODO: Determine where case queries are stored in case file schema
  const updatedData = structuredClone(caseFile.data);
  // updatedData.query = newQuery;  // TBD based on schema
  
  await fileRegistry.updateFile(fileId, updatedData);
  return true;
}

export class QueryRegenerationService {
  /**
   * Transform graph to backend schema: convert data_source.type to data_source.source_type
   * Backend expects source_type, but frontend uses type
   * 
   * Public method - can be used by any component that needs to send graph to Python API
   */
  transformGraphForBackend(graph: Graph): Graph {
    const transformed = structuredClone(graph);
    
    // Ensure valid node ids for backend / DSL (fallback to uuid)
    if (transformed.nodes) {
      for (const node of transformed.nodes) {
        if (!node.id || (typeof node.id === 'string' && node.id.trim() === '')) {
          node.id = node.uuid as any;
        }
      }
    }
    
    // Fix data_source.query type mismatch: Python expects Dict, but sometimes frontend stores string
    // If query is a string, move it to full_query and clear query
    if (transformed.edges) {
      for (const edge of transformed.edges) {
        // Check edge.p.data_source
        if (edge.p?.data_source && typeof (edge.p.data_source as any).query === 'string') {
          const ds = edge.p.data_source as any;
          if (!ds.full_query) {
            ds.full_query = ds.query;
          }
          ds.query = undefined;
        }
        // Check conditional_p entries
        if (edge.conditional_p) {
          for (const cp of edge.conditional_p) {
            if (cp.p?.data_source && typeof (cp.p.data_source as any).query === 'string') {
              const ds = cp.p.data_source as any;
              if (!ds.full_query) {
                ds.full_query = ds.query;
              }
              ds.query = undefined;
            }
          }
        }
      }
    }

    // Ensure required top-level fields for backend validation
    // -----------------------------------------------
    // 1. policies: Python schema requires a policies object; default to sensible baseline
    if (!('policies' in transformed) || transformed.policies == null) {
      transformed.policies = {
        default_outcome: 'success',  // Backend requires a string; "success" is our conventional default
      } as any;
    }

    // 2. metadata: ensure version, created_at, updated_at exist
    const nowIso = new Date().toISOString();
    if (!transformed.metadata) {
      transformed.metadata = {
        version: '1.0.0',
        created_at: nowIso,
        updated_at: nowIso,
      } as any;
    } else {
      if (!transformed.metadata.version) {
        transformed.metadata.version = '1.0.0';
      }
      if (!transformed.metadata.created_at) {
        // If we have an updated_at, use that as a fallback; otherwise use now
        transformed.metadata.created_at = transformed.metadata.updated_at || nowIso;
      }
      if (!transformed.metadata.updated_at) {
        transformed.metadata.updated_at = nowIso;
      }
    }

    return transformed;
  }

  /**
   * Regenerate queries for entire graph (or downstream of a node)
   * Also computes anchor_node_id for each edge (furthest upstream START node)
   */
  async regenerateQueries(
    graph: Graph,
    options?: {
      downstreamOf?: string;
      literalWeights?: { visited: number; exclude: number };
      preserveCondition?: boolean;
    }
  ): Promise<{
    parameters: ParameterQuery[];
    anchors: Record<string, string | null>;
    graphUpdates: number;
    fileUpdates: number;
  }> {
    const startTime = performance.now();
    
    try {
      // Transform graph to backend schema before sending
      const transformedGraph = this.transformGraphForBackend(graph);
      
      // Call Python MSMDC endpoint
      const response = await graphComputeClient.generateAllParameters(
        transformedGraph,
        options?.downstreamOf,
        options?.literalWeights || { visited: 10, exclude: 1 },
        options?.preserveCondition ?? true
      );
      
      const elapsed = performance.now() - startTime;
      console.log(`[QueryRegeneration] Python completed in ${elapsed.toFixed(0)}ms`, {
        parametersCount: response.parameters.length,
        anchorsCount: Object.keys(response.anchors || {}).length,
        downstreamOf: options?.downstreamOf
      });
      
      // Note: Session logging is handled by the caller (graphMutationService) using hierarchical logging
      
      return {
        parameters: response.parameters,
        anchors: response.anchors || {},
        graphUpdates: 0,
        fileUpdates: 0
      };
    } catch (error) {
      console.error('[QueryRegeneration] Failed to regenerate queries:', error);
      // Note: Session logging is handled by the caller (graphMutationService) using hierarchical logging
      throw error;
    }
  }
  
  /**
   * Apply regenerated queries and anchors to graph and cascade to files
   */
  async applyRegeneratedQueries(
    graph: Graph,
    parameters: ParameterQuery[],
    anchors?: Record<string, string | null>
  ): Promise<{
    graphUpdates: number;
    fileUpdates: number;
    skipped: number;
    changedParameters: Array<{
      paramId: string;
      oldQuery: string;
      newQuery: string;
      location: string;
    }>;
  }> {
    let graphUpdates = 0;
    let fileUpdates = 0;
    let skipped = 0;
    
    // Track which queries actually changed
    const changedQueries: Array<{
      paramId: string;
      oldQuery: string;
      newQuery: string;
      location: string;
    }> = [];
    
    // Apply anchor_node_id to each edge (if not manually overridden)
    if (anchors) {
      for (const edge of graph.edges) {
        const anchorNodeId = anchors[edge.uuid];
        if (anchorNodeId !== undefined) {
          // Skip if user manually set anchor_node_id
          if (edge.p?.latency?.anchor_node_id_overridden) {
            console.log(`[QueryRegeneration] Skipping overridden anchor: ${edge.uuid}`);
            continue;
          }
          
          // Apply anchor to edge.p.latency
          if (!edge.p) {
            edge.p = {};
          }
          if (!edge.p.latency) {
            edge.p.latency = {};
          }
          
          const oldAnchor = edge.p.latency.anchor_node_id;
          if (oldAnchor !== anchorNodeId) {
            edge.p.latency.anchor_node_id = anchorNodeId || undefined;
            graphUpdates++;
            console.log(`[QueryRegeneration] Applied anchor: ${edge.uuid} → ${anchorNodeId}`);
          }
        }
      }
    }
    
    for (const param of parameters) {
      // Get current query from graph
      const currentQuery = this.getCurrentQuery(graph, param.paramId);
      
      // Skip if query hasn't changed
      if (currentQuery === param.query) {
        skipped++;
        continue;
      }
      
      // Skip if query is manually overridden (user edits should be preserved)
      const isOverridden = this.isQueryOverridden(graph, param.paramId);
      if (isOverridden) {
        console.log(`[QueryRegeneration] Skipping overridden query: ${param.paramId}`);
        skipped++;
        continue;
      }
      
      // Apply to graph
      const result = applyQueryToGraph(graph, param.paramId, param.query);
      if (result.applied) {
        graphUpdates++;
        changedQueries.push({
          paramId: param.paramId,
          oldQuery: currentQuery || '',
          newQuery: param.query,
          location: result.location
        });
      } else {
        console.warn('[QueryRegeneration] Failed to apply to graph:', param.paramId, result.location);
        skipped++;
        continue;
      }
      
      // Cascade to file (only for real IDs, and only if not overridden)
      if (!param.paramId.startsWith('synthetic:')) {
        const isOverridden = this.isQueryOverridden(graph, param.paramId);
        if (!isOverridden) {
          // Try parameter file
          const updated = await updateParameterFile(param.paramId, param.query);
          if (updated) {
            fileUpdates++;
          } else {
            // Try case file
            const caseUpdated = await updateCaseFile(param.paramId, param.query);
            if (caseUpdated) {
              fileUpdates++;
            }
          }
        }
      }
    }
    
    // Log changes for debugging
    if (changedQueries.length > 0) {
      console.log('[QueryRegeneration] Queries changed:', changedQueries);
    }
    
    return { graphUpdates, fileUpdates, skipped, changedParameters: changedQueries };
  }
  
  /**
   * Get current query string from graph by param_id
   */
  private getCurrentQuery(graph: Graph, paramId: string): string | null {
    const synthetic = parseSyntheticId(paramId);
    
    if (synthetic) {
      const { uuid, field } = synthetic;
      const edge = graph.edges.find(e => e.uuid === uuid);
      const node = graph.nodes.find(n => n.uuid === uuid);
      
      if (field === 'p' && edge) return edge.query || null;
      if (field.startsWith('conditional_p[') && edge) {
        const idx = parseInt(field.match(/\[(\d+)\]/)![1]);
        return edge.conditional_p?.[idx]?.query || null;
      }
      if (field === 'cost_gbp' && edge) return (edge.cost_gbp as any)?.query || null;
      if (field === 'labour_cost' && edge) return (edge.labour_cost as any)?.query || null;
      if (field === 'case' && node) return null;  // TBD
      
      return null;
    } else {
      // Real param_id: search by id field
      for (const edge of graph.edges) {
        if (edge.p?.id === paramId) return edge.query || null;
        if (edge.conditional_p) {
          for (const cond of edge.conditional_p) {
            if (cond.p?.id === paramId) return cond.query || null;
          }
        }
        if (edge.cost_gbp?.id === paramId) return (edge.cost_gbp as any).query || null;
        if (edge.labour_cost?.id === paramId) return (edge.labour_cost as any).query || null;
      }
      
      for (const node of graph.nodes) {
        if (node.case?.id === paramId) return null;  // TBD
      }
      
      return null;
    }
  }
  
  /**
   * Check if query is manually overridden (should not auto-update)
   */
  private isQueryOverridden(graph: Graph, paramId: string): boolean {
    const synthetic = parseSyntheticId(paramId);
    
    if (synthetic) {
      const { uuid, field } = synthetic;
      const edge = graph.edges.find(e => e.uuid === uuid);
      
      if (field === 'p' && edge) return edge.query_overridden || false;
      if (field.startsWith('conditional_p[') && edge) {
        const idx = parseInt(field.match(/\[(\d+)\]/)![1]);
        return edge.conditional_p?.[idx]?.query_overridden || false;
      }
      if (field === 'cost_gbp' && edge) return (edge.cost_gbp as any)?.query_overridden || false;
      if (field === 'labour_cost' && edge) return (edge.labour_cost as any)?.query_overridden || false;
      
      return false;
    } else {
      // Real param_id: search by id field
      for (const edge of graph.edges) {
        if (edge.p?.id === paramId) return edge.query_overridden || false;
        if (edge.conditional_p) {
          for (const cond of edge.conditional_p) {
            if (cond.p?.id === paramId) return cond.query_overridden || false;
          }
        }
        if (edge.cost_gbp?.id === paramId) return (edge.cost_gbp as any)?.query_overridden || false;
        if (edge.labour_cost?.id === paramId) return (edge.labour_cost as any)?.query_overridden || false;
      }
      
      return false;
    }
  }
}

// Singleton instance
export const queryRegenerationService = new QueryRegenerationService();

