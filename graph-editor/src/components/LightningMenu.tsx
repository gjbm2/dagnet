/**
 * Lightning Menu Component
 * 
 * Dropdown menu triggered by ⚡ button in EnhancedSelector.
 * Shows data operations (Get/Put) with pathway visualizations.
 * 
 * Visual Language:
 * - Zap (filled): Connected to file
 * - Zap (stroke): Not connected to file
 * - Pathway icons: DatabaseZap → TrendingUpDown (source → graph)
 */

import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { 
  Zap, 
  DatabaseZap, 
  TrendingUpDown, 
  Folders,
  Settings,
  Activity
} from 'lucide-react';
import { dataOperationsService } from '../services/dataOperationsService';
import { fileRegistry } from '../contexts/TabContext';
import './LightningMenu.css';

interface LightningMenuProps {
  objectType: 'parameter' | 'case' | 'node' | 'event';
  objectId: string;
  hasFile: boolean;
  targetId?: string; // graph element ID (edge, node)
  graph: any; // Tab-specific graph
  setGraph: (graph: any) => void; // Tab-specific graph setter
  // For direct parameter references (no param file)
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time'; // Which parameter on edge
  conditionalIndex?: number; // Which conditional_p in array
  window?: { start: string; end: string } | null; // Window selector state
}

export const LightningMenu: React.FC<LightningMenuProps> = ({
  objectType,
  objectId,
  hasFile,
  targetId,
  graph,
  setGraph,
  paramSlot,
  conditionalIndex,
  window
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  
  // Update dropdown position when opened
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 4,
        left: rect.right
      });
    }
  }, [isOpen]);
  
  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node) &&
          buttonRef.current && !buttonRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);
  
  const handleGetFromFile = () => {
    setIsOpen(false);
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
    } else if (objectType === 'event') {
      // Events don't have graph sync operations - they're metadata only
      // But we could open the file if needed
      console.log('[LightningMenu] Event file operations not yet implemented');
    }
  };
  
  const handlePutToFile = () => {
    setIsOpen(false);
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
    } else if (objectType === 'event') {
      // Events don't have graph sync operations - they're metadata only
      console.log('[LightningMenu] Event file operations not yet implemented');
    }
  };
  
  const handleGetFromSource = () => {
    setIsOpen(false);
    dataOperationsService.getFromSource({ objectType, objectId, targetId });
  };
  
  const handleGetFromSourceDirect = () => {
    setIsOpen(false);
    // dailyMode should only be true when fetching to a parameter file (objectId exists)
    // When fetching directly to graph (no file), use aggregate mode
    const hasParameterFile = !!objectId && objectId.trim() !== '';
    dataOperationsService.getFromSourceDirect({ 
      objectType, 
      objectId, 
      targetId, 
      graph, 
      setGraph,
      paramSlot,
      conditionalIndex,
      window: window || undefined, // Pass window if set
      dailyMode: hasParameterFile // Only enable daily mode when fetching to file
    });
  };
  
  const handleConnectionSettings = () => {
    setIsOpen(false);
    if (objectType === 'parameter' || objectType === 'case') {
      dataOperationsService.openConnectionSettings(objectType, objectId);
    }
  };
  
  const handleSyncStatus = () => {
    setIsOpen(false);
    dataOperationsService.openSyncStatus(objectType, objectId);
  };
  
  // Check for connections (matching EdgeContextMenu/NodeContextMenu logic)
  // For "Get from Source (direct)": check if there's ANY connection (direct OR file)
  // For "Get from Source" (versioned): check if there's a file WITH a connection
  let hasConnection = false; // Any connection (direct OR file) - for "Get from Source (direct)"
  let hasFileConnection = false; // File exists AND has connection - for "Get from Source" (versioned)
  let connectionName: string | undefined; // Connection name for display
  
  console.log('[LightningMenu] Starting connection check:', {
    objectType,
    objectId,
    hasFile,
    targetId,
    hasGraph: !!graph,
    paramSlot
  });
  
  if (objectType === 'parameter' && objectId) {
    // Check for connection in file first (don't require targetId/graph for file check)
    const file = objectId ? fileRegistry.getFile(`parameter-${objectId}`) : null;
    const fileExists = !!file;
    const hasFileConn = !!file?.data?.connection;
    const fileConnectionName = file?.data?.connection;
    
    console.log('[LightningMenu] Parameter file check:', {
      objectId,
      fileId: `parameter-${objectId}`,
      fileExists,
      fileData: file?.data ? Object.keys(file.data) : 'no file',
      connection: file?.data?.connection,
      hasFileConn
    });
    
    // If we have targetId and graph, also check for direct connection on edge
    let hasDirectConnection = false;
    let directConnectionName: string | undefined;
    if (targetId && graph) {
      const edge = graph?.edges?.find((e: any) => e.uuid === targetId || e.id === targetId);
      
      if (edge) {
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
        
        console.log('[LightningMenu] Edge direct connection check:', {
          edgeId: targetId,
          paramSlot,
          hasParam: !!param,
          paramConnection: param?.connection,
          hasDirectConnection
        });
      } else {
        console.warn('[LightningMenu] Edge not found:', { targetId, edgeCount: graph?.edges?.length });
      }
    }
    
    // "Get from Source (direct)" shows if ANY connection exists
    hasConnection = hasDirectConnection || hasFileConn;
    
    // "Get from Source" (versioned) only shows if file exists AND file has connection
    hasFileConnection = fileExists && hasFileConn;
    
    // Get connection name (prefer direct, fallback to file)
    connectionName = directConnectionName || fileConnectionName;
    
    console.log('[LightningMenu] Parameter connection summary:', {
      objectId,
      paramSlot,
      hasFile, // prop
      fileExists, // direct check
      hasDirectConnection,
      hasFileConn,
      hasConnection,
      hasFileConnection
    });
  } else if (objectType === 'case') {
    // Check case file for connection
    // Check file regardless of hasFile prop - hasFile might be incorrectly computed
    const file = objectId ? fileRegistry.getFile(`case-${objectId}`) : null;
    const hasFileConn = !!file?.data?.connection;
    const fileConnectionName = file?.data?.connection;
    
    // Check for direct connection on node (if targetId and graph provided)
    let hasDirectConnection = false;
    let directConnectionName: string | undefined;
    if (targetId && graph) {
      const node = graph?.nodes?.find((n: any) => n.uuid === targetId || n.id === targetId);
      // Direct connection exists if node has case.connection AND no case file (case.id doesn't exist)
      hasDirectConnection = !!node?.case?.connection && !node?.case?.id;
      directConnectionName = node?.case?.connection;
    }
    
    // "Get from Source (direct)" shows if ANY connection exists (direct OR file)
    hasConnection = hasDirectConnection || hasFileConn;
    
    // "Get from Source" (versioned) only shows if file exists AND has connection
    // Check file existence directly, don't rely solely on hasFile prop
    const fileExists = !!file;
    hasFileConnection = fileExists && hasFileConn;
    
    // Get connection name (prefer direct, fallback to file)
    connectionName = directConnectionName || fileConnectionName;
  }
  // Note: 'node' and 'event' types don't have external connections, so hasConnection/hasFileConnection stay false
  // Events will only show file operations (Get/Put), not external source operations
  
  console.log('[LightningMenu] Final connection flags:', {
    objectType,
    objectId,
    hasConnection,
    hasFileConnection,
    willShowVersioned: hasFileConnection,
    willShowDirect: hasConnection
  });
  
  const dropdownContent = isOpen && (
    <div 
      ref={menuRef}
      className="lightning-menu-dropdown"
      style={{
        position: 'fixed',
        top: `${dropdownPosition.top}px`,
        left: `${dropdownPosition.left}px`,
        transform: 'translateX(-100%)'
      }}
    >
              {/* Get from File → Graph */}
              <button
                className="lightning-menu-item"
                onClick={handleGetFromFile}
                disabled={!hasFile}
                title={hasFile ? "Get data from file" : "No file connected"}
              >
                <span>Get data from file</span>
            <div className="lightning-menu-item-pathway">
              <Folders size={12} />
              <span className="lightning-menu-pathway">→</span>
              <TrendingUpDown size={12} />
            </div>
          </button>
          
          {/* Get from Source → File + Graph (versioned) - only show if file has connection */}
          {hasFileConnection && (
            <button
              className="lightning-menu-item"
              onClick={handleGetFromSource}
              title="Get data from source (versioned)"
            >
              <span>Get data from source{connectionName ? ` (${connectionName})` : ''}</span>
              <div className="lightning-menu-item-pathway">
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
              className="lightning-menu-item"
              onClick={handleGetFromSourceDirect}
              title="Get data from source (direct, not versioned)"
            >
              <span>Get data from source (direct){connectionName ? ` (${connectionName})` : ''}</span>
              <div className="lightning-menu-item-pathway">
                <DatabaseZap size={12} />
                <span className="lightning-menu-pathway">→</span>
                <TrendingUpDown size={12} />
              </div>
            </button>
          )}
          
          {/* Put Graph → File */}
          <button
            className="lightning-menu-item"
            onClick={handlePutToFile}
            disabled={!hasFile}
            title={hasFile ? "Put data to file" : "No file connected"}
          >
            <span>Put data to file</span>
            <div className="lightning-menu-item-pathway">
              <TrendingUpDown size={12} />
              <span className="lightning-menu-pathway">→</span>
              <Folders size={12} />
            </div>
          </button>
          
          <div className="lightning-menu-divider" />
          
          {/* Connection Settings (only for param and case) */}
          {(objectType === 'parameter' || objectType === 'case') && (
            <button
              className="lightning-menu-item"
              onClick={handleConnectionSettings}
              disabled={!hasFile}
              title={hasFile ? "Edit connection settings" : "No file connected"}
            >
              <span>Connection settings...</span>
            </button>
          )}
          
          {/* Sync Status */}
          <button
            className="lightning-menu-item"
            onClick={handleSyncStatus}
            title="View sync status"
          >
            <span>Sync status...</span>
          </button>
    </div>
  );
  
  return (
    <>
      <button
        ref={buttonRef}
        className="lightning-menu-button"
        onClick={() => setIsOpen(!isOpen)}
        title="Data operations"
      >
        {hasFile ? (
          <Zap size={14} fill="currentColor" />
        ) : (
          <Zap size={14} strokeWidth={2} />
        )}
      </button>
      
      {isOpen && createPortal(dropdownContent, document.body)}
    </>
  );
};

