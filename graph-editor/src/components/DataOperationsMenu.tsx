/**
 * Data Operations Menu Component
 * 
 * Shared component for data operations menu used in:
 * - LightningMenu (dropdown from ⚡ button)
 * - Context menus (submenu on hover)
 * 
 * PRECISELY mirrors LightningMenu operations with same conditions and visual language.
 */

import React, { useEffect, useState } from 'react';
import { 
  Camera,
  DatabaseZap, 
  TrendingUpDown, 
  Folders,
  FileText
} from 'lucide-react';
import { dataOperationsService } from '../services/dataOperationsService';
import { fileRegistry, useTabContext } from '../contexts/TabContext';
import { useFetchData, createFetchItem } from '../hooks/useFetchData';
import { useOpenFile } from '../hooks/useOpenFile';
import { useSnapshotsMenu } from '../hooks/useSnapshotsMenu';
import { signatureLinksTabService } from '../services/signatureLinksTabService';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { computeCurrentSignatureForEdge } from '../services/snapshotRetrievalsService';
import './LightningMenu.css';
import type { BatchOperationType, SingleOperationTarget } from './modals/BatchOperationsModal';

interface DataOperationsMenuProps {
  // Object identification
  objectType: 'parameter' | 'case' | 'node' | 'event';
  objectId: string;
  hasFile: boolean;
  targetId?: string; // edgeId or nodeId
  paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
  conditionalIndex?: number;
  
  // Context
  graph: any;
  /** File-level graph ID, e.g. "graph-my-graph" — authoritative, unlike graph.metadata.name */
  graphFileId?: string | null;
  setGraph: (graph: any) => void;
  /**
   * AUTHORITATIVE DSL from graphStore - the SINGLE source of truth.
   * This MUST be passed from the parent that has access to graphStore.
   */
  currentDSL: string;
  
  // Display mode
  mode: 'dropdown' | 'submenu';
  
  // Options
  showConnectionSettings?: boolean; // Default true for LightningMenu, false for context menus
  
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
  graphFileId,
  setGraph,
  currentDSL,
  mode,
  showConnectionSettings = true,
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
        } else if (paramSlot === 'labour_cost') {
          param = edge.labour_cost;
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
  
  // Centralized fetch hook - all fetch operations go through this
  // CRITICAL: Uses AUTHORITATIVE DSL passed from parent (graphStore.currentDSL)
  const { fetchItem } = useFetchData({
    graph,
    setGraph,
    currentDSL,  // AUTHORITATIVE DSL from graphStore (via prop)
  });
  
  // Open file hook
  const { openFile } = useOpenFile();
  const { state: navState } = useNavigatorContext();
  const { tabs, activeTabId } = useTabContext();
  
  // Snapshot menu hook (only for parameters, env-aware via live signature)
  const paramIds = objectType === 'parameter' && objectId ? [objectId] : [];
  const [currentSignatures, setCurrentSignatures] = useState<Record<string, string>>({});
  useEffect(() => {
    if (objectType !== 'parameter' || !objectId || !targetId || !graph) return;
    const workspace = navState.selectedRepo
      ? { repository: navState.selectedRepo, branch: navState.selectedBranch || 'main' }
      : undefined;
    let cancelled = false;
    computeCurrentSignatureForEdge({
      graph, edgeId: targetId, effectiveDSL: currentDSL || '', workspace,
    }).then(result => {
      if (!cancelled && result) setCurrentSignatures({ [objectId]: result.signature });
    }).catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [objectType, objectId, targetId, graph, currentDSL, navState.selectedRepo, navState.selectedBranch]);
  const { inventories, snapshotCounts } = useSnapshotsMenu(
    paramIds,
    { currentSignatures },
  );
  const snapshotCount = objectType === 'parameter' ? snapshotCounts[objectId] : undefined;
  const hasSnapshots = (inventories[objectId]?.row_count ?? 0) > 0;
  
  // Handlers (same as LightningMenu, now using centralized hook)
  const handleGetFromFile = () => {
    if (onClose) onClose();
    if (objectType === 'event') return;
    const op: BatchOperationType = 'get-from-files';
    const singleTarget: SingleOperationTarget = {
      type: objectType as 'parameter' | 'case' | 'node',
      objectId,
      targetId: targetId || '',
      paramSlot,
      conditionalIndex,
    };
    globalThis.window.dispatchEvent(new CustomEvent('dagnet:openBatchOperationsModal', { detail: { operationType: op, singleTarget } }));
  };
  
  const handlePutToFile = () => {
    if (onClose) onClose();
    if (objectType === 'event') return;
    const op: BatchOperationType = 'put-to-files';
    const singleTarget: SingleOperationTarget = {
      type: objectType as 'parameter' | 'case' | 'node',
      objectId,
      targetId: targetId || '',
      paramSlot,
      conditionalIndex,
    };
    globalThis.window.dispatchEvent(new CustomEvent('dagnet:openBatchOperationsModal', { detail: { operationType: op, singleTarget } }));
  };
  
  const handleGetFromSource = () => {
    if (onClose) onClose();
    if (objectType === 'event') return;
    const item = createFetchItem(
      objectType as 'parameter' | 'case' | 'node',
      objectId,
      targetId || '',
      { paramSlot, conditionalIndex }
    );
    fetchItem(item, { mode: 'versioned' });
  };
  
  const handleClearCache = () => {
    if (onClose) onClose();
    dataOperationsService.clearCache(objectType as 'parameter' | 'case' | 'node', objectId);
  };
  
  const handleGetFromSourceDirect = () => {
    if (onClose) onClose();
    if (objectType === 'event') return;
    const item = createFetchItem(
      objectType as 'parameter' | 'case' | 'node',
      objectId,
      targetId || '',
      { paramSlot, conditionalIndex }
    );
    fetchItem(item, { mode: 'direct' });
  };
  
  const handleConnectionSettings = () => {
    if (onClose) onClose();
    if (objectType === 'parameter' || objectType === 'case') {
      dataOperationsService.openConnectionSettings(objectType, objectId);
    }
  };
  
  const handleOpenFile = () => {
    if (onClose) onClose();
    openFile(objectType, objectId);
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
      {/* Open file - only show if file exists */}
      {actualFileExists && (
        <button
          className={itemClassName}
          onClick={handleOpenFile}
          title="Open file in editor"
        >
          <span>Open file</span>
          <div className={pathwayClassName}>
            <FileText size={12} />
          </div>
        </button>
      )}
      
      {/* Divider after Open file (only if file exists) */}
      {actualFileExists && mode === 'dropdown' && <div className="lightning-menu-divider" />}
      
      {/* Get from File → Graph - only show if file ACTUALLY exists (computed locally, not from prop) */}
      {actualFileExists && (
      <button
        className={itemClassName}
        onClick={handleGetFromFile}
          title="Get from file"
      >
        <span>Get from file</span>
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
        title={objectId && objectId.trim() !== '' ? "Put to file" : "No ID specified (cannot create file)"}
      >
        <span>Put to file</span>
        <div className={pathwayClassName}>
          <TrendingUpDown size={12} />
          <span className="lightning-menu-pathway">→</span>
          <Folders size={12} />
        </div>
      </button>
      
      {/* Divider (only in dropdown mode) */}
      {mode === 'dropdown' && <div className="lightning-menu-divider" />}
      
      {/* Unsign Cache - only show for parameters (only they have time-series cache) */}
      {objectType === 'parameter' && actualFileExists && (
        <button
          className={itemClassName}
          onClick={handleClearCache}
          title="Remove query signatures from cached data (forces re-fetch without deleting data)"
        >
          <span>Unsign file cache</span>
        </button>
      )}
      
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
      
      {/* Snapshot Manager shortcut (for parameters) */}
      {objectType === 'parameter' && (
        <button
          className={itemClassName}
          onClick={() => {
            const repo = navState.selectedRepo;
            const branch = navState.selectedBranch || 'main';
            const activeTabFileId = activeTabId
              ? tabs.find(t => t.id === activeTabId)?.fileId ?? null
              : null;
            const effectiveGraphFileId =
              graphFileId
              ?? (activeTabFileId?.startsWith('graph-') ? activeTabFileId : null);
            const bareGraphId =
              effectiveGraphFileId?.replace(/^graph-/, '')
              || graph?.metadata?.id
              || graph?.metadata?.name
              || '';
            const edge: any = targetId
              ? graph?.edges?.find((e: any) => e?.uuid === targetId || e?.id === targetId)
              : null;
            const edgeConn = edge?.p?.connection || edge?.cost_gbp?.connection || edge?.labour_cost?.connection || undefined;
            void signatureLinksTabService.openSignatureLinksTab({
              graphId: bareGraphId,
              graphName: bareGraphId,
              paramId: objectId,
              dbParamId: `${repo}-${branch}-${objectId}`,
              paramSlot: paramSlot || 'p',
              edgeId: targetId,
              connectionName: edgeConn,
            });
            if (onClose) onClose();
          }}
          title="Open Snapshot Manager for this parameter"
        >
          <span>Manage{hasSnapshots ? ` (${snapshotCount})` : ''} matching snapshots…</span>
          <div className={pathwayClassName}>
            <Camera size={12} />
          </div>
        </button>
      )}
      
    </div>
  );
}

