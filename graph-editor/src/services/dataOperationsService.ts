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
 */
function applyChanges(target: any, changes: Array<{ field: string; newValue: any }>): void {
  for (const change of changes) {
    const parts = change.field.split('.');
    let obj: any = target;
    
    // Navigate to the nested object
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]]) {
        obj[parts[i]] = {};
      }
      obj = obj[parts[i]];
    }
    
    // Set the final value
    obj[parts[parts.length - 1]] = change.newValue;
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
  }): Promise<void> {
    const { paramId, edgeId, graph, setGraph } = options;
    
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
      
      // Call UpdateManager to transform data
      const result = await updateManager.handleGraphToFile(
        sourceEdge,        // source (graph edge)
        paramFile.data,    // target (parameter file)
        'APPEND',          // operation (append to values[])
        'parameter',       // sub-destination
        { interactive: true }
      );
      
      if (!result.success || !result.changes) {
        toast.error('Failed to update file');
        return;
      }
      
      // Apply changes to file data
      const updatedFileData = structuredClone(paramFile.data);
      applyChanges(updatedFileData, result.changes);
      
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
  }): Promise<void> {
    const { caseId, nodeId, graph, setGraph } = options;
    
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
      
      if (!result.success || !result.changes) {
        toast.error('Failed to update from case file');
        return;
      }
      
      const nextGraph = structuredClone(graph);
      const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.uuid === nodeId || n.id === nodeId);
      
      if (nodeIndex >= 0) {
        applyChanges(nextGraph.nodes[nodeIndex], result.changes);
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
      
      const result = await updateManager.handleGraphToFile(
        sourceNode,
        caseFile.data,
        'UPDATE',
        'case',
        { interactive: true }
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
  }): Promise<void> {
    const { nodeId, graph, setGraph, targetNodeUuid } = options;
    
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
   * STUB for Phase 1
   */
  async getFromSourceDirect(options: {
    objectType: 'parameter' | 'case' | 'node';
    objectId: string;
    targetId?: string;
  }): Promise<void> {
    toast('Get from Source (direct) coming in Phase 2!', { icon: 'ℹ️', duration: 3000 });
    // TODO Phase 2: Implement external source retrieval
    // 1. Call external connector
    // 2. Update graph directly (bypass file)
    // 3. No file changes (nothing marked dirty)
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

