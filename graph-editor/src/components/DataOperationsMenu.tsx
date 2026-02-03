/**
 * Data Operations Menu Component
 * 
 * Shared component for data operations menu used in:
 * - LightningMenu (dropdown from ⚡ button)
 * - Context menus (submenu on hover)
 * 
 * PRECISELY mirrors LightningMenu operations with same conditions and visual language.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { 
  Camera,
  DatabaseZap, 
  Download,
  Database,
  TrendingUpDown, 
  Folders,
  FileText
} from 'lucide-react';
import { dataOperationsService } from '../services/dataOperationsService';
import { fileRegistry } from '../contexts/TabContext';
import { useFetchData, createFetchItem } from '../hooks/useFetchData';
import { useOpenFile } from '../hooks/useOpenFile';
import { useSnapshotsMenu } from '../hooks/useSnapshotsMenu';
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
  setGraph,
  currentDSL,
  mode,
  showConnectionSettings = true,
  onClose
}: DataOperationsMenuProps) {
  const [isSnapshotsSubmenuOpen, setIsSnapshotsSubmenuOpen] = useState(false);
  const closeTimeoutRef = useRef<number | null>(null);
  const snapshotsTriggerRef = useRef<HTMLButtonElement>(null);
  const snapshotsMenuRef = useRef<HTMLDivElement>(null);
  const [snapshotsMenuPos, setSnapshotsMenuPos] = useState<{ left: number; top: number } | null>(null);
  const pointerMoveListenerInstalledRef = useRef(false);
  
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
  
  // Snapshot menu hook (only for parameters)
  const paramIds = objectType === 'parameter' && objectId ? [objectId] : [];
  const { inventories, snapshotCounts, deleteSnapshots, downloadSnapshotData } = useSnapshotsMenu(paramIds);
  const snapshotCount = objectType === 'parameter' ? snapshotCounts[objectId] : undefined;
  const snapshotRowCount = objectType === 'parameter' ? inventories[objectId]?.row_count : undefined;
  const hasSnapshots = (snapshotRowCount ?? 0) > 0;

  const computeFixedSubmenuPos = useMemo(() => {
    return () => {
      const trigger = snapshotsTriggerRef.current;
      const menu = snapshotsMenuRef.current;
      if (!trigger || !menu) return;

      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();

      const viewportWidth = globalThis.innerWidth;
      const viewportHeight = globalThis.innerHeight;

      let left = triggerRect.right + 6;
      let top = triggerRect.top;

      // Flip left if needed
      if (left + menuRect.width > viewportWidth - 20) {
        left = Math.max(20, triggerRect.left - menuRect.width - 6);
      }

      // Clamp vertically
      if (top + menuRect.height > viewportHeight - 20) {
        top = Math.max(20, viewportHeight - menuRect.height - 20);
      }
      if (top < 20) top = 20;

      setSnapshotsMenuPos({ left, top });
    };
  }, []);

  useEffect(() => {
    if (!isSnapshotsSubmenuOpen) return;
    requestAnimationFrame(() => {
      computeFixedSubmenuPos();
    });
  }, [isSnapshotsSubmenuOpen, computeFixedSubmenuPos]);

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) {
        globalThis.clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
    };
  }, []);

  const openSnapshotsSubmenu = () => {
    if (closeTimeoutRef.current) {
      globalThis.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    setIsSnapshotsSubmenuOpen(true);
  };

  const scheduleCloseSnapshotsSubmenu = () => {
    if (closeTimeoutRef.current) {
      globalThis.clearTimeout(closeTimeoutRef.current);
    }
    closeTimeoutRef.current = globalThis.setTimeout(() => {
      setIsSnapshotsSubmenuOpen(false);
      closeTimeoutRef.current = null;
    }, 300) as unknown as number;
  };

  const cancelScheduledClose = () => {
    if (closeTimeoutRef.current) {
      globalThis.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const isPointerInsideTriggerOrMenu = (clientX: number, clientY: number): boolean => {
    const trigger = snapshotsTriggerRef.current;
    const menu = snapshotsMenuRef.current;
    const pad = 6;

    const inRect = (r: DOMRect) =>
      clientX >= (r.left - pad) &&
      clientX <= (r.right + pad) &&
      clientY >= (r.top - pad) &&
      clientY <= (r.bottom + pad);

    const triggerRect = trigger ? trigger.getBoundingClientRect() : null;
    const menuRect = menu ? menu.getBoundingClientRect() : null;

    if (triggerRect && inRect(triggerRect)) return true;
    if (menuRect && inRect(menuRect)) return true;

    // Bridge/corridor between trigger and menu to avoid premature closes when the menu is
    // fixed-positioned and slightly offset/clamped.
    if (triggerRect && menuRect) {
      const isMenuOnRight = menuRect.left >= triggerRect.right;
      const isMenuOnLeft = triggerRect.left >= menuRect.right;

      if (isMenuOnRight) {
        const bridge = new DOMRect(
          triggerRect.right,
          Math.min(triggerRect.top, menuRect.top),
          Math.max(0, menuRect.left - triggerRect.right),
          Math.max(triggerRect.bottom, menuRect.bottom) - Math.min(triggerRect.top, menuRect.top)
        );
        if (inRect(bridge)) return true;
      } else if (isMenuOnLeft) {
        const bridge = new DOMRect(
          menuRect.right,
          Math.min(triggerRect.top, menuRect.top),
          Math.max(0, triggerRect.left - menuRect.right),
          Math.max(triggerRect.bottom, menuRect.bottom) - Math.min(triggerRect.top, menuRect.top)
        );
        if (inRect(bridge)) return true;
      }
    }

    return false;
  };

  useEffect(() => {
    if (!isSnapshotsSubmenuOpen) return;

    const onPointerMove = (e: PointerEvent) => {
      if (isPointerInsideTriggerOrMenu(e.clientX, e.clientY)) {
        cancelScheduledClose();
      } else {
        scheduleCloseSnapshotsSubmenu();
      }
    };

    if (!pointerMoveListenerInstalledRef.current) {
      pointerMoveListenerInstalledRef.current = true;
      document.addEventListener('pointermove', onPointerMove);
    }

    return () => {
      if (pointerMoveListenerInstalledRef.current) {
        pointerMoveListenerInstalledRef.current = false;
        document.removeEventListener('pointermove', onPointerMove);
      }
    };
  }, [isSnapshotsSubmenuOpen]);
  
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
      
      {/* Snapshots submenu (for parameters) */}
      {objectType === 'parameter' && (
        <div
          style={{ position: 'relative' }}
          onMouseEnter={openSnapshotsSubmenu}
        >
          <button
            ref={snapshotsTriggerRef}
            data-testid="snapshots-trigger"
            className={itemClassName}
            // IMPORTANT: do NOT disable submenu triggers.
            // Disabled buttons do not reliably emit mouse events, which makes hover submenus
            // appear "broken" while inventory is still loading / when empty.
            aria-disabled={!hasSnapshots}
            title={hasSnapshots ? 'Snapshots' : 'No snapshots available'}
            style={{ opacity: hasSnapshots ? 1 : 0.4 }}
          >
            <span>Snapshots</span>
            <div className={pathwayClassName}>
              <Camera size={12} />
              <span className="lightning-menu-pathway">›</span>
            </div>
          </button>

          {isSnapshotsSubmenuOpen && (
            <div
              ref={snapshotsMenuRef}
              data-testid="snapshots-flyout"
              className="lightning-menu-submenu"
              style={{
                position: 'fixed',
                left: `${snapshotsMenuPos?.left ?? 0}px`,
                top: `${snapshotsMenuPos?.top ?? 0}px`,
                zIndex: 99999,
                padding: '4px',
                minWidth: '220px',
                maxWidth: 'min(420px, calc(100vw - 40px))',
                background: 'white',
                border: '1px solid #ddd',
                borderRadius: '4px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              }}
            >
              <button
                className={itemClassName}
                disabled={!hasSnapshots}
                onClick={() => {
                  void downloadSnapshotData(objectId);
                  if (onClose) onClose();
                }}
                title={hasSnapshots ? 'Download snapshot data (CSV)' : 'No snapshots available'}
              >
                <span>Download snapshot data</span>
                <div className={pathwayClassName}>
                  <Download size={12} />
                </div>
              </button>

              <button
                className={itemClassName}
                disabled={!hasSnapshots}
                onClick={() => {
                  void deleteSnapshots(objectId);
                  if (onClose) onClose();
                }}
                title={hasSnapshots ? 'Delete snapshot data' : 'No snapshots to delete'}
                style={{ color: hasSnapshots ? '#dc2626' : '#999' }}
              >
                <span>Delete {snapshotCount ?? 0} snapshot{(snapshotCount ?? 0) !== 1 ? 's' : ''}</span>
                <div className={pathwayClassName}>
                  <Database size={12} style={{ color: hasSnapshots ? '#dc2626' : '#999' }} />
                </div>
              </button>
            </div>
          )}
        </div>
      )}
      
    </div>
  );
}

