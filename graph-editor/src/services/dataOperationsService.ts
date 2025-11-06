/**
 * Data Operations Service
 * 
 * Centralized service for all data sync operations (Get/Put).
 * Used by: Lightning Menu, Context Menus, Data Menu
 * 
 * This is a thin orchestration layer that:
 * - Validates input
 * - Shows toast notifications for user feedback
 * - Calls UpdateManager for actual work (Phase 2)
 * - Handles UI updates (dirty state, etc.)
 * 
 * Architecture:
 *   UI Components → DataOperationsService → UpdateManager
 * 
 * Benefits:
 * - Single source of truth for data operations
 * - Consistent behavior across all UI entry points
 * - Easy to add logging, analytics, auth checks
 * - Easy to test
 */

import toast from 'react-hot-toast';
import { fileRegistry } from '../contexts/TabContext';

class DataOperationsService {
  /**
   * Get data from parameter file → graph edge
   * 
   * Phase 1: Shows toast (stubbed)
   * Phase 2: Actually calls UpdateManager to sync data
   */
  async getParameterFromFile(options: {
    paramId: string;
    edgeId?: string;
  }): Promise<void> {
    const { paramId, edgeId } = options;
    
    try {
      // Check if file exists
      const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
      if (!paramFile) {
        toast.error(`File not found: ${paramId}`);
        return;
      }
      
      // Phase 1: Stub - show toast
      toast.success(`✓ Would update from ${paramId}.yaml`, { duration: 2000 });
      
      // TODO Phase 2: Call UpdateManager
      // await this.updateManager.handleFileToGraph({
      //   sourceFile: paramFile,
      //   targetEdgeId: edgeId,
      //   interactive: true
      // });
    } catch (error) {
      console.error('[DataOperationsService] Failed to get from file:', error);
      toast.error('Failed to get from file');
    }
  }
  
  /**
   * Put data from graph edge → parameter file
   * 
   * Phase 1: Shows toast (stubbed)
   * Phase 2: Actually calls UpdateManager to append data
   */
  async putParameterToFile(options: {
    paramId: string;
    edgeId?: string;
  }): Promise<void> {
    const { paramId, edgeId } = options;
    
    try {
      // Check if file exists
      const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
      if (!paramFile) {
        toast.error(`File not found: ${paramId}`);
        return;
      }
      
      // Phase 1: Stub - show toast
      toast.success(`✓ Would update ${paramId}.yaml`, { duration: 2000 });
      
      // TODO Phase 2: Call UpdateManager
      // await this.updateManager.handleGraphToFile({
      //   sourceEdgeId: edgeId,
      //   targetFileId: `parameter-${paramId}`,
      //   operation: 'APPEND',
      //   interactive: true
      // });
      // 
      // Mark file as dirty
      // fileRegistry.markDirty(`parameter-${paramId}`);
    } catch (error) {
      console.error('[DataOperationsService] Failed to put to file:', error);
      toast.error('Failed to put to file');
    }
  }
  
  /**
   * Get data from case file → graph case node
   */
  async getCaseFromFile(options: {
    caseId: string;
    nodeId?: string;
  }): Promise<void> {
    const { caseId } = options;
    
    try {
      const caseFile = fileRegistry.getFile(`case-${caseId}`);
      if (!caseFile) {
        toast.error(`File not found: ${caseId}`);
        return;
      }
      
      toast.success(`✓ Would update from ${caseId}.yaml`, { duration: 2000 });
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
  }): Promise<void> {
    const { caseId } = options;
    
    try {
      const caseFile = fileRegistry.getFile(`case-${caseId}`);
      if (!caseFile) {
        toast.error(`File not found: ${caseId}`);
        return;
      }
      
      toast.success(`✓ Would update ${caseId}.yaml`, { duration: 2000 });
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
  }): Promise<void> {
    const { nodeId } = options;
    
    try {
      const nodeFile = fileRegistry.getFile(`node-${nodeId}`);
      if (!nodeFile) {
        toast.error(`File not found: ${nodeId}`);
        return;
      }
      
      toast.success(`✓ Would update from ${nodeId}.yaml`, { duration: 2000 });
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
  }): Promise<void> {
    const { nodeId } = options;
    
    try {
      const nodeFile = fileRegistry.getFile(`node-${nodeId}`);
      if (!nodeFile) {
        toast.error(`File not found: ${nodeId}`);
        return;
      }
      
      toast.success(`✓ Would update ${nodeId}.yaml`, { duration: 2000 });
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

