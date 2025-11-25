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
 * - field: "p", "conditional_p[0]", "cost_gbp", "cost_time", "case"
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
      return { applied: true, location: `edge ${edge.from}->${edge.to}` };
    }
    
    if (field.startsWith('conditional_p[') && edge) {
      // Conditional probability query
      const match = field.match(/conditional_p\[(\d+)\]/);
      if (match) {
        const idx = parseInt(match[1]);
        if (edge.conditional_p && edge.conditional_p[idx]) {
          edge.conditional_p[idx].query = newQuery;
          return { applied: true, location: `edge ${edge.from}->${edge.to} conditional[${idx}]` };
        }
      }
    }
    
    if (field === 'cost_gbp' && edge) {
      if (edge.cost_gbp) {
        (edge.cost_gbp as any).query = newQuery;
        return { applied: true, location: `edge ${edge.from}->${edge.to} cost_gbp` };
      }
    }
    
    if (field === 'cost_time' && edge) {
      if (edge.cost_time) {
        (edge.cost_time as any).query = newQuery;
        return { applied: true, location: `edge ${edge.from}->${edge.to} cost_time` };
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
        return { applied: true, location: `edge ${edge.from}->${edge.to}` };
      }
      
      // Check conditional_p
      if (edge.conditional_p) {
        for (let i = 0; i < edge.conditional_p.length; i++) {
          if (edge.conditional_p[i].p?.id === paramId) {
            edge.conditional_p[i].query = newQuery;
            return { applied: true, location: `edge ${edge.from}->${edge.to} conditional[${i}]` };
          }
        }
      }
      
      // Check cost_gbp
      if (edge.cost_gbp?.id === paramId) {
        if (edge.cost_gbp) {
          (edge.cost_gbp as any).query = newQuery;
        }
        return { applied: true, location: `edge ${edge.from}->${edge.to} cost_gbp` };
      }
      
      // Check cost_time
      if (edge.cost_time?.id === paramId) {
        if (edge.cost_time) {
          (edge.cost_time as any).query = newQuery;
        }
        return { applied: true, location: `edge ${edge.from}->${edge.to} cost_time` };
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
    
    // Transform all edges
    if (transformed.edges) {
      for (const edge of transformed.edges) {
        // Transform p.data_source
        const pData = edge.p as any;
        if (pData?.data_source && 'type' in pData.data_source && !('source_type' in pData.data_source)) {
          pData.data_source = {
            ...pData.data_source,
            source_type: pData.data_source.type,
          };
          delete pData.data_source.type;
        }
        
        // Transform cost_gbp.data_source
        const costGbpData = edge.cost_gbp as any;
        if (costGbpData?.data_source && 'type' in costGbpData.data_source && !('source_type' in costGbpData.data_source)) {
          costGbpData.data_source = {
            ...costGbpData.data_source,
            source_type: costGbpData.data_source.type,
          };
          delete costGbpData.data_source.type;
        }
        
        // Transform cost_time.data_source
        const costTimeData = edge.cost_time as any;
        if (costTimeData?.data_source && 'type' in costTimeData.data_source && !('source_type' in costTimeData.data_source)) {
          costTimeData.data_source = {
            ...costTimeData.data_source,
            source_type: costTimeData.data_source.type,
          };
          delete costTimeData.data_source.type;
        }
      }
    }
    
    // Transform all nodes (for case.data_source and ensure valid ids)
    if (transformed.nodes) {
      for (const node of transformed.nodes) {
        // Ensure node.id is non-empty for backend / DSL (fallback to uuid)
        if (!node.id || (typeof node.id === 'string' && node.id.trim() === '')) {
          node.id = node.uuid as any;
        }

        const caseData = node.case as any;
        if (caseData?.data_source && 'type' in caseData.data_source && !('source_type' in caseData.data_source)) {
          caseData.data_source = {
            ...caseData.data_source,
            source_type: caseData.data_source.type,
          };
          delete caseData.data_source.type;
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
        downstreamOf: options?.downstreamOf
      });
      
      // Note: Session logging is handled by the caller (graphMutationService) using hierarchical logging
      
      return {
        parameters: response.parameters,
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
   * Apply regenerated queries to graph and cascade to files
   */
  async applyRegeneratedQueries(
    graph: Graph,
    parameters: ParameterQuery[]
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
    
    for (const param of parameters) {
      // Get current query from graph
      const currentQuery = this.getCurrentQuery(graph, param.paramId);
      
      // Skip if query hasn't changed
      if (currentQuery === param.query) {
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
      if (field === 'cost_time' && edge) return (edge.cost_time as any)?.query || null;
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
        if (edge.cost_time?.id === paramId) return (edge.cost_time as any).query || null;
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
      if (field === 'cost_time' && edge) return (edge.cost_time as any)?.query_overridden || false;
      
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
        if (edge.cost_time?.id === paramId) return (edge.cost_time as any)?.query_overridden || false;
      }
      
      return false;
    }
  }
}

// Singleton instance
export const queryRegenerationService = new QueryRegenerationService();

