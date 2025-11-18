/**
 * Data Operations Menu Component
 * 
 * Shared component for data operations menu used in:
 * - LightningMenu (dropdown from ⚡ button)
 * - Context menus (submenu on hover)
 * 
 * PRECISELY mirrors LightningMenu operations with same conditions and visual language.
 */

import React from 'react';
import { 
  DatabaseZap, 
  TrendingUpDown, 
  Folders
} from 'lucide-react';
import { dataOperationsService } from '../services/dataOperationsService';
import { fileRegistry } from '../contexts/TabContext';
import './LightningMenu.css';

interface DataOperationsMenuProps {
  // Object identification
  objectType: 'parameter' | 'case' | 'node' | 'event';
  objectId: string;
  hasFile: boolean;
  targetId?: string; // edgeId or nodeId
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
  conditionalIndex?: number;
  
  // Context
  graph: any;
  setGraph: (graph: any) => void;
  window?: { start: string; end: string } | null;
  
  // Display mode
  mode: 'dropdown' | 'submenu';
  
  // Options
  showConnectionSettings?: boolean; // Default true for LightningMenu, false for context menus
  showSyncStatus?: boolean; // Default true
  
  // Close handler (for submenu mode)
  onClose?: () => void;
}

/**
 * DataOperationsMenu - Shared menu component for all data operations
 * 
 * Extracted from LightningMenu to be reused in context menus.
 * PRECISELY mirrors LightningMenu operations with same conditions.
 */
export function DataOperationsMenu({
  objectType,
  objectId,
  hasFile,
  targetId,
  paramSlot,
  conditionalIndex,
  graph,
  setGraph,
  window,
  mode,
  showConnectionSettings = true,
  showSyncStatus = true,
  onClose
}: DataOperationsMenuProps) {
  
  // Compute connection flags (same logic as LightningMenu)
  let hasConnection = false; // Any connection (direct OR file) - for "Get from Source (direct)"
  let hasFileConnection = false; // File exists AND has connection - for "Get from Source" (versioned)
  let connectionName: string | undefined;
  let actualFileExists = false; // ACTUALLY check if file exists (don't trust prop)
  
  if (objectType === 'parameter') {
    // Debug: log connection detection
    if (process.env.NODE_ENV === 'development') {
      console.log(`[DataOperationsMenu] Checking connections for parameter:`, {
        objectId,
        targetId,
        paramSlot,
        conditionalIndex,
        hasFile: !!objectId
      });
    }
    // Check for connection in file first (if objectId exists)
    const file = objectId ? fileRegistry.getFile(`parameter-${objectId}`) : null;
    const fileExists = !!file;
    actualFileExists = fileExists; // Set top-level variable
    const hasFileConn = !!file?.data?.connection;
    const fileConnectionName = file?.data?.connection;
    
    // If we have targetId and graph, also check for direct connection on edge
    let hasDirectConnection = false;
    let directConnectionName: string | undefined;
    if (targetId && graph) {
      const edge = graph?.edges?.find((e: any) => e.uuid === targetId || e.id === targetId);
      
      if (edge) {
        // Check for conditional probability connection if conditionalIndex is provided
        if (conditionalIndex !== undefined && conditionalIndex >= 0 && edge.conditional_p?.[conditionalIndex]) {
          const conditionalParam = edge.conditional_p[conditionalIndex].p;
          hasDirectConnection = !!conditionalParam?.connection;
          directConnectionName = conditionalParam?.connection;
        } else {
        // Determine which parameter slot we're checking
        let param: any = null;
        
        if (paramSlot === 'p' || !paramSlot) {
          param = edge.p;
        } else if (paramSlot === 'cost_gbp') {
          param = edge.cost_gbp;
        } else if (paramSlot === 'cost_time') {
          param = edge.cost_time;
        }
        
        hasDirectConnection = !!param?.connection;
        directConnectionName = param?.connection;
        }
      }
    }
    
    // "Get from Source (direct)" shows if ANY connection exists
    hasConnection = hasDirectConnection || hasFileConn;
    
    // "Get from Source" (versioned) only shows if file exists AND file has connection
    hasFileConnection = fileExists && hasFileConn;
    
    // Get connection name (prefer direct, fallback to file)
    connectionName = directConnectionName || fileConnectionName;
    
    // Debug: log connection detection results
    if (process.env.NODE_ENV === 'development') {
      console.log(`[DataOperationsMenu] Connection detection results:`, {
        hasDirectConnection,
        hasFileConn,
        fileExists,
        hasConnection,
        hasFileConnection,
        connectionName
      });
    }
  } else if (objectType === 'case') {
    // Check case file for connection (file exists AND has connection field)
    const file = objectId ? fileRegistry.getFile(`case-${objectId}`) : null;
    const fileExists = !!file;
    actualFileExists = fileExists; // Set top-level variable
    const hasFileConn = !!file?.data?.connection;
    const fileConnectionName = file?.data?.connection;
    
    // Check for direct connection on node (if targetId and graph provided)
    let hasDirectConnection = false;
    let directConnectionName: string | undefined;
    if (targetId && graph) {
      const node = graph?.nodes?.find((n: any) => n.uuid === targetId || n.id === targetId);
      // Direct connection exists if node has case.connection (regardless of file)
      hasDirectConnection = !!node?.case?.connection;
      directConnectionName = node?.case?.connection;
    }
    
    // "Get from Source (direct)" shows if ANY connection exists (direct OR file)
    hasConnection = hasDirectConnection || hasFileConn;
    
    // "Get from Source" (versioned) only shows if file exists AND has connection
    hasFileConnection = fileExists && hasFileConn;
    
    // Get connection name (prefer direct, fallback to file)
    connectionName = directConnectionName || fileConnectionName;
  } else if (objectType === 'node' || objectType === 'event') {
    // For nodes and events, just check if file exists
    const file = objectId ? fileRegistry.getFile(`${objectType}-${objectId}`) : null;
    actualFileExists = !!file;
  }
  
  // Handlers (same as LightningMenu)
  const handleGetFromFile = () => {
    if (onClose) onClose();
    if (objectType === 'parameter') {
      dataOperationsService.getParameterFromFile({ 
        paramId: objectId, 
        edgeId: targetId,
        graph,
        setGraph
      });
    } else if (objectType === 'case') {
      dataOperationsService.getCaseFromFile({ 
        caseId: objectId, 
        nodeId: targetId,
        graph,
        setGraph
      });
    } else if (objectType === 'node') {
      dataOperationsService.getNodeFromFile({ 
        nodeId: objectId,
        graph,
        setGraph
      });
    }
  };
  
  const handlePutToFile = () => {
    if (onClose) onClose();
    if (objectType === 'parameter') {
      dataOperationsService.putParameterToFile({ 
        paramId: objectId, 
        edgeId: targetId,
        graph,
        setGraph
      });
    } else if (objectType === 'case') {
      dataOperationsService.putCaseToFile({ 
        caseId: objectId, 
        nodeId: targetId,
        graph,
        setGraph
      });
    } else if (objectType === 'node') {
      dataOperationsService.putNodeToFile({ 
        nodeId: objectId,
        graph,
        setGraph
      });
    }
  };
  
  const handleGetFromSource = () => {
    if (onClose) onClose();
    if (objectType === 'event') {
      // Events don't support external data connections
      return;
    }
    dataOperationsService.getFromSource({ 
      objectType: objectType as 'parameter' | 'case' | 'node', 
      objectId, 
      targetId,
      graph,
      setGraph,
      paramSlot,
      window: window ?? undefined
    });
  };
  
  const handleGetFromSourceDirect = () => {
    if (onClose) onClose();
    if (objectType === 'event') {
      // Events don't support external data connections
      return;
    }
    // dailyMode should only be true when fetching to a parameter file (objectId exists)
    // When fetching directly to graph (no file), use aggregate mode
    const hasParameterFile = !!objectId && objectId.trim() !== '';
    dataOperationsService.getFromSourceDirect({ 
      objectType: objectType as 'parameter' | 'case' | 'node', 
      objectId, 
      targetId, 
      graph, 
      setGraph,
      paramSlot,
      conditionalIndex,
      window: window ?? undefined,
      dailyMode: hasParameterFile // Only enable daily mode when fetching to file
    });
  };
  
  const handleConnectionSettings = () => {
    if (onClose) onClose();
    if (objectType === 'parameter' || objectType === 'case') {
      dataOperationsService.openConnectionSettings(objectType, objectId);
    }
  };
  
  const handleSyncStatus = () => {
    if (onClose) onClose();
    if (objectType === 'event') {
      // Events don't support sync status
      return;
    }
    dataOperationsService.openSyncStatus(objectType as 'parameter' | 'case' | 'node', objectId);
  };
  
  // Determine CSS class based on mode
  const menuClassName = mode === 'dropdown' 
    ? 'lightning-menu-dropdown' 
    : 'lightning-menu-submenu';
  
  const itemClassName = mode === 'dropdown'
    ? 'lightning-menu-item'
    : 'context-menu-item';
  
  const pathwayClassName = mode === 'dropdown'
    ? 'lightning-menu-item-pathway'
    : 'context-menu-item-pathway';
  
  return (
    <div className={menuClassName}>
      {/* Get from File → Graph - only show if file ACTUALLY exists (computed locally, not from prop) */}
      {actualFileExists && (
        <button
          className={itemClassName}
          onClick={handleGetFromFile}
          title="Get data from file"
        >
          <span>Get data from file</span>
          <div className={pathwayClassName}>
            <Folders size={12} />
            <span className="lightning-menu-pathway">→</span>
            <TrendingUpDown size={12} />
          </div>
        </button>
      )}
      
      {/* Get from Source → File + Graph (versioned) - only show if file has connection */}
      {hasFileConnection && (
        <button
          className={itemClassName}
          onClick={handleGetFromSource}
          title="Get data from source (versioned)"
        >
          <span>Get data from source{connectionName ? ` (${connectionName})` : ''}</span>
          <div className={pathwayClassName}>
            <DatabaseZap size={12} />
            <span className="lightning-menu-pathway">→</span>
            <Folders size={12} />
            <span className="lightning-menu-pathway">+</span>
            <TrendingUpDown size={12} />
          </div>
        </button>
      )}
      
      {/* Get from Source → Graph (Direct) - only show if ANY connection exists */}
      {hasConnection && (
        <button
          className={itemClassName}
          onClick={handleGetFromSourceDirect}
          title="Get data from source (direct, not versioned)"
        >
          <span>Get data from source (direct){connectionName ? ` (${connectionName})` : ''}</span>
          <div className={pathwayClassName}>
            <DatabaseZap size={12} />
            <span className="lightning-menu-pathway">→</span>
            <TrendingUpDown size={12} />
          </div>
        </button>
      )}
      
      {/* Put Graph → File */}
      <button
        className={itemClassName}
        onClick={handlePutToFile}
        disabled={!objectId || objectId.trim() === ''}
        title={objectId && objectId.trim() !== '' ? "Put data to file" : "No ID specified (cannot create file)"}
      >
        <span>Put data to file</span>
        <div className={pathwayClassName}>
          <TrendingUpDown size={12} />
          <span className="lightning-menu-pathway">→</span>
          <Folders size={12} />
        </div>
      </button>
      
      {/* Divider (only in dropdown mode) */}
      {mode === 'dropdown' && <div className="lightning-menu-divider" />}
      
      {/* Connection Settings (only for param and case, and only if showConnectionSettings is true) */}
      {showConnectionSettings && (objectType === 'parameter' || objectType === 'case') && (
        <button
          className={itemClassName}
          onClick={handleConnectionSettings}
          disabled={!actualFileExists}
          title={actualFileExists ? "Edit connection settings" : "No file connected"}
        >
          <span>Connection settings...</span>
        </button>
      )}
      
      {/* Sync Status */}
      {showSyncStatus && (
        <button
          className={itemClassName}
          onClick={handleSyncStatus}
          title="View sync status"
        >
          <span>Sync status...</span>
        </button>
      )}
    </div>
  );
}

