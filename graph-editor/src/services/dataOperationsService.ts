/**
 * Data Operations Service
 * 
 * Centralized service for all data sync operations (Get/Put).
 * Used by: Lightning Menu, Context Menus, Data Menu
 * 
 * This is a proper service layer that:
 * - Validates input
 * - Calls UpdateManager to transform data
 * - Applies changes to graph
 * - Shows toast notifications
 * - Handles errors gracefully
 * 
 * Architecture:
 *   UI Components → DataOperationsService → UpdateManager → Graph Update
 * 
 * Context Requirements:
 * - Requires graph + setGraph from caller (useGraphStore)
 * - Allows service to work with any tab/graph instance
 * - Supports future async operations
 * 
 * Benefits:
 * - Single source of truth for all data operations
 * - Consistent behavior across all UI entry points
 * - Easy to add logging, analytics, auth checks
 * - Testable (pure business logic)
 * - Ready for Phase 4 (async/API operations)
 */

import toast from 'react-hot-toast';
import { fileRegistry } from '../contexts/TabContext';
import { UpdateManager } from './UpdateManager';
import type { Graph } from '../types';

// Shared UpdateManager instance
const updateManager = new UpdateManager();

/**
 * Helper function to apply field changes to a target object
 * Handles nested field paths (e.g., "p.mean")
 * Handles array append syntax (e.g., "values[]")
 */
function applyChanges(target: any, changes: Array<{ field: string; newValue: any }>): void {
  for (const change of changes) {
    console.log('[applyChanges] Applying change:', {
      field: change.field,
      newValue: change.newValue,
      'target.p BEFORE': JSON.stringify(target.p)
    });
    
    const parts = change.field.split('.');
    let obj: any = target;
    
    // Navigate to the nested object
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      
      // Handle array append syntax: "field[]"
      if (part.endsWith('[]')) {
        const arrayName = part.slice(0, -2); // Remove "[]"
        if (!obj[arrayName]) {
          console.log(`[applyChanges] Creating new array at ${arrayName}`);
          obj[arrayName] = [];
        }
        // Don't navigate into the array; we'll append to it at the end
        obj = obj[arrayName];
      } else {
        if (!obj[part]) {
          console.log(`[applyChanges] Creating new object at ${part}`);
          obj[part] = {};
        }
        obj = obj[part];
      }
    }
    
    // Set the final value
    const finalPart = parts[parts.length - 1];
    if (finalPart.endsWith('[]')) {
      // Array append: push the new value
      const arrayName = finalPart.slice(0, -2);
      if (!obj[arrayName]) {
        console.log(`[applyChanges] Creating new array at ${arrayName}`);
        obj[arrayName] = [];
      }
      console.log(`[applyChanges] Appending to array ${arrayName}`);
      obj[arrayName].push(change.newValue);
    } else {
      // Regular field set
      obj[finalPart] = change.newValue;
    }
    
    console.log('[applyChanges] After change:', {
      'target.p AFTER': JSON.stringify(target.p)
    });
  }
}

class DataOperationsService {
  /**
   * Get data from parameter file → graph edge
   * 
   * Reads parameter file, uses UpdateManager to transform data,
   * applies changes to graph edge, respects override flags.
   */
  async getParameterFromFile(options: {
    paramId: string;
    edgeId?: string;
    graph: Graph | null;
    setGraph: (graph: Graph | null) => void;
    setAutoUpdating?: (updating: boolean) => void;
  }): Promise<void> {
    const { paramId, edgeId, graph, setGraph, setAutoUpdating } = options;
    
    // Set auto-updating flag to enable animations
    if (setAutoUpdating) {
      setAutoUpdating(true);
      // Clear flag after 500ms
      setTimeout(() => setAutoUpdating(false), 500);
    }
    
    try {
      // Validate inputs
      if (!graph) {
        toast.error('No graph loaded');
        return;
      }
      
      if (!edgeId) {
        toast.error('No edge selected');
        return;
      }
      
      // Check if file exists
      const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
      if (!paramFile) {
        toast.error(`Parameter file not found: ${paramId}`);
        return;
      }
      
      // Find the target edge
      const targetEdge = graph.edges?.find((e: any) => e.uuid === edgeId || e.id === edgeId);
      if (!targetEdge) {
        toast.error(`Edge not found in graph`);
        return;
      }
      
      console.log('[DataOperationsService] TARGET EDGE AT START:', {
        'edge.uuid': targetEdge.uuid,
        'edge.p': JSON.stringify(targetEdge.p)
      });
      
      // Call UpdateManager to transform data
      const result = await updateManager.handleFileToGraph(
        paramFile.data,    // source (parameter file data)
        targetEdge,        // target (graph edge)
        'UPDATE',          // operation
        'parameter',       // sub-destination
        { interactive: true }  // show modals for conflicts
      );
      
      if (!result.success) {
        if (result.conflicts && result.conflicts.length > 0) {
          toast.error(`Conflicts found: ${result.conflicts.length} field(s) overridden`);
          // TODO: Show conflict resolution modal
        } else {
          toast.error('Update failed');
        }
        return;
      }
      
      // Apply changes to graph
      const nextGraph = structuredClone(graph);
      const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeId || e.id === edgeId);
      
      console.log('[DataOperationsService] BEFORE applyChanges:', {
        edgeId,
        edgeIndex,
        'edge.p': JSON.stringify(nextGraph.edges[edgeIndex]?.p),
        changes: JSON.stringify(result.changes)
      });
      
      if (edgeIndex >= 0 && result.changes) {
        // Apply changes to the edge
        applyChanges(nextGraph.edges[edgeIndex], result.changes);
        
        console.log('[DataOperationsService] AFTER applyChanges:', {
          'edge.p': JSON.stringify(nextGraph.edges[edgeIndex]?.p)
        });
        
        // Ensure we do NOT lose the correct parameter connection id after file update.
        // Detect which slot to use from parameter file type OR from changes
        if (paramId) {
          let slot: 'p' | 'cost_gbp' | 'cost_time' | null = null;
          
          // First, try to determine slot from parameter file type
          const paramType = paramFile.data?.type || paramFile.data?.parameter_type;
          if (paramType === 'probability') {
            slot = 'p';
          } else if (paramType === 'cost_gbp') {
            slot = 'cost_gbp';
          } else if (paramType === 'cost_time') {
            slot = 'cost_time';
          } else {
            // Fallback: try to infer from changes
            const fields = (result.changes || []).map((c: any) => c.field || '');
            if (fields.some(f => f.startsWith('cost_gbp'))) slot = 'cost_gbp';
            else if (fields.some(f => f.startsWith('cost_time'))) slot = 'cost_time';
            else if (fields.some(f => f === 'p' || f.startsWith('p.'))) slot = 'p';
          }
          
          if (slot) {
            if (!nextGraph.edges[edgeIndex][slot]) {
              // initialize object for the slot
              (nextGraph.edges[edgeIndex] as any)[slot] = {};
            }
            // Always set the ID to ensure it's preserved
            (nextGraph.edges[edgeIndex] as any)[slot].id = paramId;
            console.log('[DataOperationsService] PRESERVE param id after update:', {
              slot,
              paramId,
              paramType,
              'edge.slot.id': (nextGraph.edges[edgeIndex] as any)[slot].id
            });
          } else {
            console.warn('[DataOperationsService] Could not determine parameter slot. paramType:', paramType);
          }
        }
        
        // Update metadata
        if (nextGraph.metadata) {
          nextGraph.metadata.updated_at = new Date().toISOString();
        }
        
        // Save to graph store
        setGraph(nextGraph);
        
        toast.success(`✓ Updated from ${paramId}.yaml`, { duration: 2000 });
      }
      
    } catch (error) {
      console.error('[DataOperationsService] Failed to get parameter from file:', error);
      toast.error('Failed to get data from file');
    }
  }
  
  /**
   * Put data from graph edge → parameter file
   * 
   * Reads edge data, uses UpdateManager to transform to file format,
   * appends new value to parameter file values[], marks file dirty.
   */
  async putParameterToFile(options: {
    paramId: string;
    edgeId?: string;
    graph: Graph | null;
    setGraph: (graph: Graph | null) => void;
  }): Promise<void> {
    const { paramId, edgeId, graph } = options;
    
    console.log('[DataOperationsService] putParameterToFile CALLED:', {
      paramId,
      edgeId,
      timestamp: new Date().toISOString()
    });
    
    try {
      // Validate inputs
      if (!graph) {
        toast.error('No graph loaded');
        return;
      }
      
      if (!edgeId) {
        toast.error('No edge selected');
        return;
      }
      
      // Check if file exists
      const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
      if (!paramFile) {
        toast.error(`Parameter file not found: ${paramId}`);
        return;
      }
      
      // Find the source edge
      const sourceEdge = graph.edges?.find((e: any) => e.uuid === edgeId || e.id === edgeId);
      if (!sourceEdge) {
        toast.error(`Edge not found in graph`);
        return;
      }
      
      // Determine which parameter slot this file corresponds to
      // (an edge can have p, cost_gbp, AND cost_time - we only want to write ONE)
      let filteredEdge: any = { ...sourceEdge };
      if (sourceEdge.p?.id === paramId) {
        // Writing probability parameter - keep only p field
        filteredEdge = { p: sourceEdge.p };
      } else if (sourceEdge.cost_gbp?.id === paramId) {
        // Writing cost_gbp parameter - keep only cost_gbp field
        filteredEdge = { cost_gbp: sourceEdge.cost_gbp };
      } else if (sourceEdge.cost_time?.id === paramId) {
        // Writing cost_time parameter - keep only cost_time field
        filteredEdge = { cost_time: sourceEdge.cost_time };
      } else {
        toast.error(`Edge is not connected to parameter ${paramId}`);
        return;
      }
      
      // Call UpdateManager to transform data (validateOnly mode - don't apply yet)
      const result = await updateManager.handleGraphToFile(
        filteredEdge,      // source (filtered to only relevant parameter)
        paramFile.data,    // target (parameter file)
        'APPEND',          // operation (append to values[])
        'parameter',       // sub-destination
        { interactive: true, validateOnly: true }  // Don't apply in UpdateManager, we'll use applyChanges
      );
      
      if (!result.success || !result.changes) {
        toast.error('Failed to update file');
        return;
      }
      
      // Apply changes to file data
      const updatedFileData = structuredClone(paramFile.data);
      console.log('[DataOperationsService] putParameterToFile - changes to apply:', {
        paramId,
        changes: JSON.stringify(result.changes, null, 2)
      });
      applyChanges(updatedFileData, result.changes);
      console.log('[DataOperationsService] putParameterToFile - after applyChanges:', {
        'updatedFileData.values': JSON.stringify(updatedFileData.values, null, 2)
      });
      
      console.log('[DataOperationsService] Before updateFile:', {
        fileId: `parameter-${paramId}`,
        wasDirty: paramFile.isDirty,
        isInitializing: paramFile.isInitializing
      });
      
      // Update file in registry and mark dirty
      await fileRegistry.updateFile(`parameter-${paramId}`, updatedFileData);
      
      // Check if it worked
      const updatedFile = fileRegistry.getFile(`parameter-${paramId}`);
      console.log('[DataOperationsService] After updateFile:', {
        fileId: `parameter-${paramId}`,
        isDirty: updatedFile?.isDirty,
        isInitializing: updatedFile?.isInitializing
      });
      
      toast.success(`✓ Updated ${paramId}.yaml`, { duration: 2000 });
      
    } catch (error) {
      console.error('[DataOperationsService] Failed to put parameter to file:', error);
      toast.error('Failed to put data to file');
    }
  }
  
  /**
   * Get data from case file → graph case node
   */
  async getCaseFromFile(options: {
    caseId: string;
    nodeId?: string;
    graph: Graph | null;
    setGraph: (graph: Graph | null) => void;
    setAutoUpdating?: (updating: boolean) => void;
  }): Promise<void> {
    const { caseId, nodeId, graph, setGraph, setAutoUpdating } = options;
    
    // Set auto-updating flag to enable animations
    if (setAutoUpdating) {
      setAutoUpdating(true);
      setTimeout(() => setAutoUpdating(false), 500);
    }
    
    try {
      if (!graph || !nodeId) {
        toast.error('No graph or node selected');
        return;
      }
      
      const caseFile = fileRegistry.getFile(`case-${caseId}`);
      if (!caseFile) {
        toast.error(`Case file not found: ${caseId}`);
        return;
      }
      
      const targetNode = graph.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId);
      if (!targetNode) {
        toast.error(`Node not found in graph`);
        return;
      }
      
      const result = await updateManager.handleFileToGraph(
        caseFile.data,
        targetNode,
        'UPDATE',
        'case',
        { interactive: true }
      );
      
      if (!result.success) {
        console.error('[DataOperationsService] getCaseFromFile failed:', result);
        const errorMsg = result.errors?.length ? result.errors.map(e => typeof e === 'string' ? e : e.message || JSON.stringify(e)).join(', ') : 'Unknown error';
        toast.error(`Failed to update from case file: ${errorMsg}`);
        return;
      }
      
      const nextGraph = structuredClone(graph);
      const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.uuid === nodeId || n.id === nodeId);
      
      if (nodeIndex >= 0) {
        // Ensure case structure exists BEFORE applying changes
        if (caseId && !nextGraph.nodes[nodeIndex].case) {
          nextGraph.nodes[nodeIndex].case = { id: caseId, status: 'active', variants: [] };
        }
        
        // Apply changes if any (might be empty if already up to date)
        // This will populate/merge variants from the case file
        if (result.changes) {
          applyChanges(nextGraph.nodes[nodeIndex], result.changes);
        }
        
        // Ensure we do NOT lose the human-readable node id after file update
        if (nodeId && !nextGraph.nodes[nodeIndex].id) {
          nextGraph.nodes[nodeIndex].id = nodeId;
          console.log('[DataOperationsService] PRESERVE node.id after update:', {
            nodeId,
            'node.id': nextGraph.nodes[nodeIndex].id
          });
        }
        
        // Ensure case.id is set (in case applyChanges didn't set it)
        if (caseId && nextGraph.nodes[nodeIndex].case && !nextGraph.nodes[nodeIndex].case.id) {
          nextGraph.nodes[nodeIndex].case.id = caseId;
        }
        
        console.log('[DataOperationsService] After getCaseFromFile:', {
          caseId,
          'node.case.id': nextGraph.nodes[nodeIndex].case?.id,
          'variants.length': nextGraph.nodes[nodeIndex].case?.variants?.length,
          'variants': nextGraph.nodes[nodeIndex].case?.variants
        });
        if (nextGraph.metadata) {
          nextGraph.metadata.updated_at = new Date().toISOString();
        }
        setGraph(nextGraph);
        toast.success(`✓ Updated from ${caseId}.yaml`, { duration: 2000 });
      }
    } catch (error) {
      console.error('[DataOperationsService] Failed to get case from file:', error);
      toast.error('Failed to get case from file');
    }
  }
  
  /**
   * Put data from graph case node → case file
   */
  async putCaseToFile(options: {
    caseId: string;
    nodeId?: string;
    graph: Graph | null;
    setGraph: (graph: Graph | null) => void;
  }): Promise<void> {
    const { caseId, nodeId, graph } = options;
    
    try {
      if (!graph || !nodeId) {
        toast.error('No graph or node selected');
        return;
      }
      
      const caseFile = fileRegistry.getFile(`case-${caseId}`);
      if (!caseFile) {
        toast.error(`Case file not found: ${caseId}`);
        return;
      }
      
      const sourceNode = graph.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId);
      if (!sourceNode) {
        toast.error(`Node not found in graph`);
        return;
      }
      
      // Filter node to only include the relevant case data
      const filteredNode: any = { case: sourceNode.case };
      
      const result = await updateManager.handleGraphToFile(
        filteredNode,
        caseFile.data,
        'APPEND', // Use APPEND for case schedules
        'case',
        { interactive: true, validateOnly: true } // Don't apply in UpdateManager, we'll use applyChanges
      );
      
      if (!result.success || !result.changes) {
        toast.error('Failed to update case file');
        return;
      }
      
      const updatedFileData = structuredClone(caseFile.data);
      applyChanges(updatedFileData, result.changes);
      
      await fileRegistry.updateFile(`case-${caseId}`, updatedFileData);
      toast.success(`✓ Updated ${caseId}.yaml`, { duration: 2000 });
    } catch (error) {
      console.error('[DataOperationsService] Failed to put case to file:', error);
      toast.error('Failed to put case to file');
    }
  }
  
  /**
   * Get data from node file → graph node
   */
  async getNodeFromFile(options: {
    nodeId: string;
    graph: Graph | null;
    setGraph: (graph: Graph | null) => void;
    targetNodeUuid?: string; // Optional: if provided, find node by UUID instead of nodeId
    setAutoUpdating?: (updating: boolean) => void;
  }): Promise<void> {
    const { nodeId, graph, setGraph, targetNodeUuid, setAutoUpdating } = options;
    
    // Set auto-updating flag to enable animations
    if (setAutoUpdating) {
      setAutoUpdating(true);
      setTimeout(() => setAutoUpdating(false), 500);
    }
    
    try {
      if (!graph) {
        toast.error('No graph loaded');
        return;
      }
      
      const nodeFile = fileRegistry.getFile(`node-${nodeId}`);
      if (!nodeFile) {
        toast.error(`Node file not found: ${nodeId}`);
        return;
      }
      
      // Find node: if targetNodeUuid provided, use that; otherwise use nodeId
      const targetNode = targetNodeUuid
        ? graph.nodes?.find((n: any) => n.uuid === targetNodeUuid)
        : graph.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId || n.data?.id === nodeId);
      
      if (!targetNode) {
        toast.error(`Node not found in graph`);
        return;
      }
      
      const result = await updateManager.handleFileToGraph(
        nodeFile.data,
        targetNode,
        'UPDATE',
        'node',
        { interactive: true }
      );
      
      if (!result.success || !result.changes) {
        toast.error('Failed to update from node file');
        return;
      }
      
      const nextGraph = structuredClone(graph);
      const nodeIndex = targetNodeUuid
        ? nextGraph.nodes.findIndex((n: any) => n.uuid === targetNodeUuid)
        : nextGraph.nodes.findIndex((n: any) => n.uuid === nodeId || n.id === nodeId || n.data?.id === nodeId);
      
      if (nodeIndex >= 0) {
        applyChanges(nextGraph.nodes[nodeIndex], result.changes);
        // Ensure we do NOT lose the human-readable node id after file update
        if (nodeId && !nextGraph.nodes[nodeIndex].id) {
          nextGraph.nodes[nodeIndex].id = nodeId;
          console.log('[DataOperationsService] PRESERVE node.id after update:', {
            nodeId,
            'node.id': nextGraph.nodes[nodeIndex].id
          });
        }
        if (nextGraph.metadata) {
          nextGraph.metadata.updated_at = new Date().toISOString();
        }
        setGraph(nextGraph);
        toast.success(`✓ Updated from ${nodeId}.yaml`, { duration: 2000 });
      }
    } catch (error) {
      console.error('[DataOperationsService] Failed to get node from file:', error);
      toast.error('Failed to get node from file');
    }
  }
  
  /**
   * Put data from graph node → node file
   */
  async putNodeToFile(options: {
    nodeId: string;
    graph: Graph | null;
    setGraph: (graph: Graph | null) => void;
  }): Promise<void> {
    const { nodeId, graph } = options;
    
    try {
      if (!graph) {
        toast.error('No graph loaded');
        return;
      }
      
      const nodeFile = fileRegistry.getFile(`node-${nodeId}`);
      if (!nodeFile) {
        toast.error(`Node file not found: ${nodeId}`);
        return;
      }
      
      const sourceNode = graph.nodes?.find((n: any) => n.uuid === nodeId || n.id === nodeId || n.data?.id === nodeId);
      if (!sourceNode) {
        toast.error(`Node not found in graph`);
        return;
      }
      
      const result = await updateManager.handleGraphToFile(
        sourceNode,
        nodeFile.data,
        'UPDATE',
        'node',
        { interactive: true }
      );
      
      if (!result.success || !result.changes) {
        toast.error('Failed to update node file');
        return;
      }
      
      const updatedFileData = structuredClone(nodeFile.data);
      applyChanges(updatedFileData, result.changes);
      
      await fileRegistry.updateFile(`node-${nodeId}`, updatedFileData);
      
      toast.success(`✓ Updated ${nodeId}.yaml`, { duration: 2000 });
    } catch (error) {
      console.error('[DataOperationsService] Failed to put node to file:', error);
      toast.error('Failed to put node to file');
    }
  }
  
  /**
   * Get data from external source → file → graph (versioned)
   * STUB for Phase 1
   */
  async getFromSource(options: {
    objectType: 'parameter' | 'case' | 'node';
    objectId: string;
    targetId?: string;
  }): Promise<void> {
    toast('Get from Source coming in Phase 2!', { icon: 'ℹ️', duration: 3000 });
    // TODO Phase 2: Implement external source retrieval
    // 1. Call external connector (Amplitude, Sheets, etc.)
    // 2. Append new data to file values[]
    // 3. Update graph from file
    // 4. Mark file as dirty
  }
  
  /**
   * Get data from external source → graph (direct, not versioned)
   */
  async getFromSourceDirect(options: {
    objectType: 'parameter' | 'case' | 'node';
    objectId: string;
    targetId?: string;
    graph?: Graph | null;
    setGraph?: (graph: Graph | null) => void;
    // For direct parameter references (no param file)
    paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
    conditionalIndex?: number;
  }): Promise<void> {
    const { objectType, objectId, targetId, graph, setGraph, paramSlot, conditionalIndex } = options;
    
    try {
      let connectionName: string | undefined;
      let connectionString: any = {};
      
      // Try to get connection info from parameter/case/node file (if objectId provided)
      if (objectId) {
      const fileId = `${objectType}-${objectId}`;
      const file = fileRegistry.getFile(fileId);
      
        if (file) {
      const data = file.data;
          connectionName = data.connection;
          
          // Parse connection_string (it's a JSON string in the schema)
      if (data.connection_string) {
        try {
          connectionString = typeof data.connection_string === 'string' 
            ? JSON.parse(data.connection_string)
            : data.connection_string;
            } catch (e) {
              toast.error('Invalid connection_string JSON in parameter file');
              return;
            }
          }
        }
      }
      
      // If no connection from file, try to get it from the edge/node directly
      if (!connectionName && targetId && graph) {
        const target: any = objectType === 'parameter' 
          ? graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId)
          : graph.nodes?.find((n: any) => n.uuid === targetId || n.id === targetId);
        
        if (target) {
          // For parameters, resolve the specific parameter location
          if (objectType === 'parameter') {
            let param: any = null;
            
            // If paramSlot specified, use that (e.g., 'p', 'cost_gbp', 'cost_time')
            if (paramSlot) {
              param = target[paramSlot];
              
              // If conditionalIndex specified, get from conditional_ps array
              if (conditionalIndex !== undefined && param?.conditional_ps) {
                param = param.conditional_ps[conditionalIndex];
              }
            }
            // Otherwise, default to p (backward compatibility)
            else {
              param = target.p;
            }
            
            if (param) {
              connectionName = param.connection;
              if (param.connection_string) {
                try {
                  connectionString = typeof param.connection_string === 'string'
                    ? JSON.parse(param.connection_string)
                    : param.connection_string;
                } catch (e) {
                  toast.error('Invalid connection_string JSON on edge');
                  return;
                }
              }
            }
          }
          // For other types, check top-level connection
          else if (target.connection) {
            connectionName = target.connection;
            if (target.connection_string) {
              try {
                connectionString = typeof target.connection_string === 'string'
                  ? JSON.parse(target.connection_string)
                  : target.connection_string;
        } catch (e) {
          toast.error('Invalid connection_string JSON');
          return;
        }
            }
          }
        }
      }
      
      // 2. Check if we have a connection configured
      if (!connectionName) {
        toast.error(`No connection configured. Please set the 'connection' field.`);
        return;
      }
      
      // 3. Build DSL from edge query (if available in graph)
      let dsl: any = {};
      let connectionProvider: string | undefined;
      
      if (targetId && graph) {
        // Find the target edge
        const targetEdge = graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId);
        
        if (targetEdge && targetEdge.query) {
          // Parse query string (format: "from(nodeA).to(nodeB)")
          // For now, pass the edge with query string to buildDslFromEdge
          // which will parse node references and resolve event names
          
          // Load buildDslFromEdge and event loader
          const { buildDslFromEdge } = await import('../lib/das/buildDslFromEdge');
          const { paramRegistryService } = await import('./paramRegistryService');
          
          // Get connection to extract provider
          const { createDASRunner } = await import('../lib/das');
          const tempRunner = createDASRunner();
          try {
            const connection = await (tempRunner as any).connectionProvider.getConnection(connectionName);
            connectionProvider = connection.provider;
          } catch (e) {
            console.warn('Could not load connection for provider mapping:', e);
          }
          
          try {
            // Event loader that reads from IDB
            const eventLoader = async (eventId: string) => {
              const fileId = `event-${eventId}`;
              const file = fileRegistry.getFile(fileId);
              
              if (file && file.data) {
                console.log(`Loaded event "${eventId}" from IDB:`, file.data);
                return file.data;
              }
              
              // Fallback: return minimal event without mapping
              console.warn(`Event "${eventId}" not found in IDB, using fallback`);
              return {
                id: eventId,
                name: eventId,
                provider_event_names: {}
              };
            };
            
            // Build DSL with event mapping
            dsl = await buildDslFromEdge(
              targetEdge,
              graph,
              connectionProvider,
              eventLoader
            );
            console.log('Built DSL from edge with event mapping:', dsl);
          } catch (error) {
            console.error('Error building DSL from edge:', error);
            toast.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
            return;
          }
        }
      }
      
      // 5. Execute DAS Runner
      const { createDASRunner } = await import('../lib/das');
      const runner = createDASRunner();
      
      // Default window: last 7 calendar days
      const now = new Date();
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(now.getDate() - 7);
      const defaultWindow = {
        start: sevenDaysAgo.toISOString(),
        end: now.toISOString()
      };
      
      toast.loading('Fetching data from source...', { id: 'das-fetch' });
      
      const result = await runner.execute(connectionName, dsl, {
        connection_string: connectionString,
        window: defaultWindow,
        edgeId: targetId || 'unknown'
      });
      
      if (!result.success) {
        toast.error(`Failed to fetch data: ${result.error}`, { id: 'das-fetch' });
        return;
      }
      
      toast.success(`Fetched data from source`, { id: 'das-fetch' });
      console.log('DAS Updates:', result.updates);
      
      // 6. Parse the updates to extract values
      // Map DAS field names to UpdateManager's external data field names
      const updateData: any = {};
      for (const update of result.updates) {
        console.log('Processing update:', update);
        // Parse JSON Pointer: /edges/{edgeId}/p/mean → extract field and value
        const parts = update.target.split('/').filter(Boolean);
        console.log('Parts:', parts);
        
        // Example: ["edges", "test-edge-123", "p", "mean"] → field = "mean"
        // Or: ["edges", "test-edge-123", "p", "evidence", "n"] → need to extract "n"
        const field = parts[parts.length - 1]; // Last part is the field name
        console.log('Field:', field, 'Value:', update.value);
        
        // Map to UpdateManager's expected field names for external data
        // UpdateManager expects: probability, sample_size, successes
        // DAS provides: mean, n, k
        if (field === 'mean') {
          updateData.probability = update.value;
        } else if (field === 'n') {
          updateData.sample_size = update.value;
        } else if (field === 'k') {
          updateData.successes = update.value;
        } else {
          updateData[field] = update.value;
        }
      }
      
      console.log('Extracted data from DAS (mapped to external format):', updateData);
      
      // 7. Apply directly to graph (no file update)
      if (!targetId || !graph || !setGraph) {
        toast.error('Cannot apply to graph: missing context');
        return;
      }
      
      // Find the target edge
      const targetEdge = graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId);
      if (!targetEdge) {
        toast.error('Target edge not found in graph');
        return;
      }
      
      // Call UpdateManager to transform and apply external data directly to graph
      // DAS data is "external" data (not from file), so use handleExternalToGraph
      console.log('[DataOperationsService] Calling UpdateManager with:', {
        updateData,
        targetEdge: {
          uuid: targetEdge.uuid,
          'p.mean': targetEdge.p?.mean,
          'p.mean_overridden': targetEdge.p?.mean_overridden
        }
      });
      
      const updateResult = await updateManager.handleExternalToGraph(
        updateData,  // External data with {mean, n, k, etc}
        targetEdge,
        'UPDATE',
        'parameter',
        { interactive: false }
      );
      
      console.log('[DataOperationsService] UpdateManager result:', {
        success: updateResult.success,
        changesLength: updateResult.changes?.length,
        changes: updateResult.changes
      });
      
      if (!updateResult.success) {
        toast.error('Failed to apply updates to graph');
        return;
      }
      
      // Apply the changes to the graph
      if (updateResult.changes && updateResult.changes.length > 0) {
        const nextGraph = structuredClone(graph);
        const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === targetId || e.id === targetId);
        
        if (edgeIndex >= 0) {
          applyChanges(nextGraph.edges[edgeIndex], updateResult.changes);
          
          if (nextGraph.metadata) {
            nextGraph.metadata.updated_at = new Date().toISOString();
          }
          
          setGraph(nextGraph);
          toast.success(`Applied to graph: ${updateResult.changes.length} fields updated`);
        }
      } else {
        toast('No changes to apply', { icon: 'ℹ️' });
      }
      
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Error: ${message}`);
      console.error('getFromSourceDirect error:', error);
    }
  }
  
  /**
   * Open connection settings modal
   * STUB for Phase 1
   */
  async openConnectionSettings(objectType: 'parameter' | 'case', objectId: string): Promise<void> {
    toast('Connection Settings modal coming in Phase 2!', { icon: '⚙️', duration: 3000 });
    // TODO Phase 2: Build connection settings modal
    // - Edit source_type (amplitude, sheets, api, etc.)
    // - Edit connection_settings JSON blob
    // - Save to file, mark dirty
  }
  
  /**
   * Open sync status modal
   * STUB for Phase 1
   */
  async openSyncStatus(objectType: 'parameter' | 'case' | 'node', objectId: string): Promise<void> {
    toast('Sync Status modal coming in Phase 2!', { icon: '📊', duration: 3000 });
    // TODO Phase 2: Build sync status modal
    // Show comparison:
    // - Current value in graph
    // - Current value in file
    // - Last retrieved from source
    // - Sync/conflict indicators
  }
}

// Singleton instance
export const dataOperationsService = new DataOperationsService();

