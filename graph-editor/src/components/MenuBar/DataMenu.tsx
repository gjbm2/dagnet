import React, { useState, useEffect } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { getGraphStore } from '../../contexts/GraphStoreContext';
import { dataOperationsService } from '../../services/dataOperationsService';
import { BatchOperationsModal } from '../modals/BatchOperationsModal';
import toast from 'react-hot-toast';
import type { GraphData } from '../../types';
import type { BatchOperationType } from '../modals/BatchOperationsModal';
import { getAllDataSections, type DataOperationSection } from '../DataOperationsSections';
import { Database, DatabaseZap, Folders, TrendingUpDown } from 'lucide-react';

/**
 * Data Menu
 * 
 * Batch and context-dependent data operations:
 * - Batch operations (Get All from Files/Sources, Put All to Files)
 * - Context-dependent operations (Get/Put for selected edge/node)
 * - Connections configuration
 * 
 * Always available, but context-dependent items are enabled/disabled based on selection
 */
export function DataMenu() {
  const { activeTabId, tabs, operations } = useTabContext();
  const activeTab = tabs.find(t => t.id === activeTabId);
  const isGraphTab = activeTab?.fileId.startsWith('graph-') && activeTab?.viewMode === 'interactive';
  
  // Get graph data from fileRegistry or graph store
  const graphFile = activeTab && isGraphTab ? fileRegistry.getFile(activeTab.fileId) : null;
  const graphFromFile = graphFile?.data as GraphData | undefined;
  
  // Get graph store for window state and setGraph
  const graphStore = activeTab && isGraphTab ? getGraphStore(activeTab.fileId) : null;
  const graphFromStore = graphStore?.getState().graph || null;
  const windowState = graphStore?.getState().window || null;
  
  // Prefer graph from store (more up-to-date), fallback to fileRegistry
  const graph = graphFromStore || graphFromFile;
  
  // Helper to update graph
  const handleSetGraph = (newGraph: GraphData | null) => {
    if (!graphStore || !newGraph) return;
    graphStore.getState().setGraph(newGraph);
    // Also update fileRegistry
    if (activeTab) {
      fileRegistry.updateFile(activeTab.fileId, newGraph);
    }
  };
  
  // Track selection state (will be wired up later)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  
  // Use refs to track current values for comparison without causing re-renders
  const selectedNodeIdRef = React.useRef<string | null>(null);
  const selectedEdgeIdRef = React.useRef<string | null>(null);
  
  // Update refs when state changes
  React.useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
    selectedEdgeIdRef.current = selectedEdgeId;
  }, [selectedNodeId, selectedEdgeId]);
  
  // Sync selection state from tab's editorState when tab changes OR editorState updates
  useEffect(() => {
    if (activeTab && isGraphTab) {
      const editorState = activeTab.editorState;
      if (editorState) {
        // Sync from editorState (fallback for initial load or missed events)
        const nodeId = editorState.selectedNodeId || null;
        const edgeId = editorState.selectedEdgeId || null;
        
        // Only update if different to avoid unnecessary re-renders
        if (nodeId !== selectedNodeIdRef.current) {
          console.log('[DataMenu] Syncing nodeId from editorState:', nodeId, 'current:', selectedNodeIdRef.current);
          setSelectedNodeId(nodeId);
        }
        if (edgeId !== selectedEdgeIdRef.current) {
          console.log('[DataMenu] Syncing edgeId from editorState:', edgeId, 'current:', selectedEdgeIdRef.current);
          setSelectedEdgeId(edgeId);
        }
      } else {
        // No editorState - clear selection
        if (selectedNodeIdRef.current !== null) {
          console.log('[DataMenu] Clearing nodeId (no editorState)');
          setSelectedNodeId(null);
        }
        if (selectedEdgeIdRef.current !== null) {
          console.log('[DataMenu] Clearing edgeId (no editorState)');
          setSelectedEdgeId(null);
        }
      }
    } else {
      // Not a graph tab - clear selection
      if (selectedNodeIdRef.current !== null) {
        console.log('[DataMenu] Clearing nodeId (not graph tab)');
        setSelectedNodeId(null);
      }
      if (selectedEdgeIdRef.current !== null) {
        console.log('[DataMenu] Clearing edgeId (not graph tab)');
        setSelectedEdgeId(null);
      }
    }
  }, [activeTabId, activeTab?.editorState?.selectedNodeId, activeTab?.editorState?.selectedEdgeId, isGraphTab]);
  
  // Listen for selection changes via custom events
  useEffect(() => {
    const handleEdgeSelection = (e: CustomEvent) => {
      const edgeId = e.detail?.edgeId || null;
      console.log('[DataMenu] Edge selected event received:', {
        detail: e.detail,
        edgeId,
        currentState: selectedEdgeIdRef.current,
        willUpdate: edgeId !== selectedEdgeIdRef.current,
      });
      if (edgeId !== selectedEdgeIdRef.current) {
        setSelectedEdgeId(edgeId);
      }
    };
    
    const handleNodeSelection = (e: CustomEvent) => {
      const nodeId = e.detail?.nodeId || null;
      console.log('[DataMenu] Node selected event received:', {
        detail: e.detail,
        nodeId,
        currentState: selectedNodeIdRef.current,
        willUpdate: nodeId !== selectedNodeIdRef.current,
        timestamp: Date.now(),
      });
      if (nodeId !== selectedNodeIdRef.current) {
        console.log('[DataMenu] SETTING selectedNodeId to:', nodeId);
        setSelectedNodeId(nodeId);
      } else {
        console.log('[DataMenu] NOT updating selectedNodeId (already set)');
      }
    };
    
    const handleSelectionClear = () => {
      console.log('[DataMenu] Selection cleared event received');
      // Don't clear both - selectionCleared is fired when ONE selection is cleared
      // The individual events (nodeSelected/edgeSelected with null) will handle clearing
      // This event is just a notification, not a command to clear everything
    };
    
    console.log('[DataMenu] Setting up event listeners');
    globalThis.window.addEventListener('dagnet:edgeSelected', handleEdgeSelection as EventListener);
    globalThis.window.addEventListener('dagnet:nodeSelected', handleNodeSelection as EventListener);
    globalThis.window.addEventListener('dagnet:selectionCleared', handleSelectionClear);
    
    return () => {
      console.log('[DataMenu] Cleaning up event listeners');
      globalThis.window.removeEventListener('dagnet:edgeSelected', handleEdgeSelection as EventListener);
      globalThis.window.removeEventListener('dagnet:nodeSelected', handleNodeSelection as EventListener);
      globalThis.window.removeEventListener('dagnet:selectionCleared', handleSelectionClear);
    };
  }, []);
  
  // Batch operations state
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchOperationType, setBatchOperationType] = useState<BatchOperationType | null>(null);
  
  // Batch operations handlers
  const handleGetAllFromFiles = () => {
    setBatchOperationType('get-from-files');
    setBatchModalOpen(true);
  };
  
  const handleGetAllFromSources = () => {
    setBatchOperationType('get-from-sources');
    setBatchModalOpen(true);
  };
  
  const handleGetAllFromSourcesDirect = () => {
    setBatchOperationType('get-from-sources-direct');
    setBatchModalOpen(true);
  };
  
  const handlePutAllToFiles = () => {
    setBatchOperationType('put-to-files');
    setBatchModalOpen(true);
  };
  
  // Context-dependent operations
  
  const handleConnections = async () => {
    // Open connections configuration file
    const connectionsItem = {
      id: 'connections',
      type: 'connections' as const,
      name: 'Connections',
      path: 'connections/connections.yaml'
    };
    
    await operations.openTab(connectionsItem, 'interactive');
  };
  
  const handleCredentials = async () => {
    // Open existing credentials file
    const credentialsItem = {
      id: 'credentials',
      type: 'credentials' as const,
      name: 'Credentials',
      path: 'credentials.yaml'
    };
    
    await operations.openTab(credentialsItem, 'interactive');
  };

  // Section-based handlers for data operations
  const handleSectionGetFromFile = (section: DataOperationSection) => {
    if (!graph) return;
    if (section.objectType === 'parameter') {
      dataOperationsService.getParameterFromFile({
        paramId: section.objectId,
        edgeId: section.targetId,
        graph,
        setGraph: handleSetGraph,
      });
    } else if (section.objectType === 'case') {
      dataOperationsService.getCaseFromFile({
        caseId: section.objectId,
        nodeId: section.targetId,
        graph,
        setGraph: handleSetGraph,
      });
    } else if (section.objectType === 'node') {
      dataOperationsService.getNodeFromFile({
        nodeId: section.objectId,
        graph,
        setGraph: handleSetGraph,
        targetNodeUuid: section.targetId,
      });
    }
  };

  const handleSectionPutToFile = (section: DataOperationSection) => {
    if (!graph) return;
    if (section.objectType === 'parameter') {
      dataOperationsService.putParameterToFile({
        paramId: section.objectId,
        edgeId: section.targetId,
        graph,
        setGraph: handleSetGraph,
      });
    } else if (section.objectType === 'case') {
      dataOperationsService.putCaseToFile({
        caseId: section.objectId,
        nodeId: section.targetId,
        graph,
        setGraph: handleSetGraph,
      });
    } else if (section.objectType === 'node') {
      dataOperationsService.putNodeToFile({
        nodeId: section.objectId,
        graph,
        setGraph: handleSetGraph,
      });
    }
  };

  const handleSectionGetFromSourceDirect = (section: DataOperationSection) => {
    if (!graph) return;
    dataOperationsService.getFromSourceDirect({
      objectType: section.objectType as 'parameter' | 'case' | 'node',
      objectId: section.objectId,
      targetId: section.targetId,
      graph,
      setGraph: handleSetGraph,
      paramSlot: section.paramSlot,
      conditionalIndex: section.conditionalIndex,
      window: windowState || undefined,
      dailyMode: false,
    });
  };

  const handleSectionGetFromSource = (section: DataOperationSection) => {
    if (!graph) return;
    dataOperationsService.getFromSource({
      objectType: section.objectType as 'parameter' | 'case' | 'node',
      objectId: section.objectId,
      targetId: section.targetId,
      graph,
      setGraph: handleSetGraph,
      paramSlot: section.paramSlot,
      conditionalIndex: section.conditionalIndex,
      window: windowState || undefined,
    });
  };
  
  // Get all data operation sections using single source of truth
  const dataOperationSections = getAllDataSections(selectedNodeId, selectedEdgeId, graph);
  
  // Determine if context-dependent items should be enabled
  const hasSelection = selectedEdgeId !== null || selectedNodeId !== null;
  const hasEdgeSelection = selectedEdgeId !== null;
  const hasNodeSelection = selectedNodeId !== null;
  
  // DEBUG: Log state at render time
  console.log('[DataMenu] RENDER STATE:', {
    selectedEdgeId,
    selectedNodeId,
    hasEdgeSelection,
    hasNodeSelection,
    hasSelection,
    isGraphTab,
    graphExists: !!graph,
    graphNodeCount: graph?.nodes?.length,
    graphEdgeCount: graph?.edges?.length,
  });
  
  // Debug logging
  
  return (
    <>
      <Menubar.Menu>
        <Menubar.Trigger className="menubar-trigger" onPointerDown={() => {
          if (isGraphTab) {
            const editorState = activeTab?.editorState;
            if (editorState) {
              const nodeId = editorState.selectedNodeId || null;
              const edgeId = editorState.selectedEdgeId || null;
              if (nodeId !== selectedNodeIdRef.current) setSelectedNodeId(nodeId);
              if (edgeId !== selectedEdgeIdRef.current) setSelectedEdgeId(edgeId);
            }
          }
        }}>
          Data
        </Menubar.Trigger>
        <Menubar.Portal>
          <Menubar.Content className="menubar-content" align="start">
          {/* Batch operations */}
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleGetAllFromFiles}
          >
            Get All from Files...
          </Menubar.Item>
          
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleGetAllFromSources}
          >
            Get All from Sources...
          </Menubar.Item>
          
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleGetAllFromSourcesDirect}
          >
            Get All from Sources (direct)...
          </Menubar.Item>
          
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handlePutAllToFiles}
          >
            Put All to Files...
          </Menubar.Item>
          
          <Menubar.Separator className="menubar-separator" />
          
          {/* Context-dependent operations (section-based submenus) */}
          {dataOperationSections.length > 0 ? (
            dataOperationSections.map(section => (
              <Menubar.Sub key={section.id}>
                <Menubar.SubTrigger className="menubar-item">
                  {section.label}
                </Menubar.SubTrigger>
                <Menubar.SubContent 
                  className="menubar-submenu-content"
                  style={{
                    background: 'white',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    minWidth: '180px',
                    padding: '4px',
                    zIndex: 99999
                  }}
                >
                  {section.operations.getFromSourceDirect && (
                    <Menubar.Item 
                      className="menubar-item"
                      onSelect={() => handleSectionGetFromSourceDirect(section)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                    >
                      <span>Get from Source (direct)</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                        <Database size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                        <TrendingUpDown size={12} />
                      </div>
                    </Menubar.Item>
                  )}
                  {section.operations.getFromSource && (
                    <Menubar.Item 
                      className="menubar-item"
                      onSelect={() => handleSectionGetFromSource(section)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                    >
                      <span>Get from Source</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                        <DatabaseZap size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                        <Folders size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>+</span>
                        <TrendingUpDown size={12} />
                      </div>
                    </Menubar.Item>
                  )}
                  {section.operations.getFromFile && (
                    <Menubar.Item 
                      className="menubar-item"
                      onSelect={() => handleSectionGetFromFile(section)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                    >
                      <span>Get from File</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                        <Folders size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                        <TrendingUpDown size={12} />
                      </div>
                    </Menubar.Item>
                  )}
                  {section.operations.putToFile && (
                    <Menubar.Item 
                      className="menubar-item"
                      onSelect={() => handleSectionPutToFile(section)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                    >
                      <span>Put to File</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                        <TrendingUpDown size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                        <Folders size={12} />
                      </div>
                    </Menubar.Item>
                  )}
                </Menubar.SubContent>
              </Menubar.Sub>
            ))
          ) : (
            <Menubar.Item 
              className="menubar-item" 
              disabled
            >
              Select edge or node...
            </Menubar.Item>
          )}
          
          <Menubar.Separator className="menubar-separator" />
          
          {/* Credentials */}
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleCredentials}
          >
            Credentials...
          </Menubar.Item>
          
          {/* Connections */}
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleConnections}
          >
            Connections...
          </Menubar.Item>
        </Menubar.Content>
      </Menubar.Portal>
    </Menubar.Menu>
    
    {/* Batch Operations Modal */}
    {batchOperationType && (
      <BatchOperationsModal
        isOpen={batchModalOpen}
        onClose={() => {
          setBatchModalOpen(false);
          setBatchOperationType(null);
        }}
        operationType={batchOperationType}
        graph={graph || null}
        setGraph={handleSetGraph}
        window={windowState}
      />
    )}
  </>
  );
}

