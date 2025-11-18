import React, { useState, useEffect } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { getGraphStore } from '../../contexts/GraphStoreContext';
import { dataOperationsService } from '../../services/dataOperationsService';
import { BatchOperationsModal } from '../modals/BatchOperationsModal';
import toast from 'react-hot-toast';
import type { GraphData } from '../../types';
import type { BatchOperationType } from '../modals/BatchOperationsModal';

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
  const handleGetFromFile = async () => {
    if (!isGraphTab || !graph) {
      toast.error('No graph loaded');
      return;
    }
    
    // Determine what's selected
    if (selectedEdgeId) {
      const edge = graph.edges?.find((e: any) => e.uuid === selectedEdgeId || e.id === selectedEdgeId);
      if (!edge) {
        toast.error('Selected edge not found');
        return;
      }
      
      // Check which parameter slot has a file connection
      const paramId = edge.p?.id || edge.cost_gbp?.id || edge.cost_time?.id;
      if (!paramId) {
        toast.error('No parameter file connected to selected edge');
        return;
      }
      
      const paramSlot = edge.p?.id ? 'p' : edge.cost_gbp?.id ? 'cost_gbp' : 'cost_time';
      
      try {
        await dataOperationsService.getParameterFromFile({
          paramId,
          edgeId: selectedEdgeId,
          graph,
          setGraph: handleSetGraph,
          window: windowState || undefined,
        });
        toast.success('Data loaded from file');
      } catch (error) {
        toast.error(`Failed to get data from file: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (selectedNodeId) {
      const node = graph.nodes?.find((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
      if (!node) {
        toast.error('Selected node not found');
        return;
      }
      
      // Check for case file first, then node file
      const caseId = node.case?.id;
      const nodeFileId = node.id; // Use node.id, not node.node_id
      
      if (caseId) {
        // Get case data from file
        try {
          await dataOperationsService.getCaseFromFile({
            caseId,
            nodeId: selectedNodeId,
            graph,
            setGraph: handleSetGraph,
          });
          toast.success('Case data loaded from file');
        } catch (error) {
          toast.error(`Failed to get case from file: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (nodeFileId) {
        // Get node data from file
        try {
          await dataOperationsService.getNodeFromFile({
            nodeId: nodeFileId,
            graph,
            setGraph: handleSetGraph,
            targetNodeUuid: selectedNodeId,
          });
          toast.success('Node data loaded from file');
        } catch (error) {
          toast.error(`Failed to get node from file: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        toast.error('No case or node file connected to selected node');
      }
    } else {
      toast.error('No edge or node selected');
    }
  };
  
  const handleGetFromSource = async () => {
    if (!isGraphTab || !graph) {
      toast.error('No graph loaded');
      return;
    }
    
    if (selectedEdgeId) {
      const edge = graph.edges?.find((e: any) => e.uuid === selectedEdgeId || e.id === selectedEdgeId);
      if (!edge) {
        toast.error('Selected edge not found');
        return;
      }
      
      const paramId = edge.p?.id || edge.cost_gbp?.id || edge.cost_time?.id;
      if (!paramId) {
        toast.error('No parameter file connected to selected edge');
        return;
      }
      
      const paramSlot = edge.p?.id ? 'p' : edge.cost_gbp?.id ? 'cost_gbp' : 'cost_time';
      
      try {
        await dataOperationsService.getFromSource({
          objectType: 'parameter',
          objectId: paramId,
          targetId: selectedEdgeId,
          graph,
          setGraph: handleSetGraph,
          paramSlot,
          window: windowState || undefined,
        });
      } catch (error) {
        toast.error(`Failed to get data from source: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (selectedNodeId) {
      const node = graph.nodes?.find((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
      if (!node) {
        toast.error('Selected node not found');
        return;
      }
      
      const caseId = node.case?.id;
      if (!caseId) {
        toast.error('No case file connected to selected node');
        return;
      }
      
      try {
        await dataOperationsService.getFromSource({
          objectType: 'case',
          objectId: caseId,
          targetId: selectedNodeId,
          graph,
          setGraph: handleSetGraph,
        });
      } catch (error) {
        toast.error(`Failed to get case from source: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      toast.error('No edge or node selected');
    }
  };
  
  const handleGetFromSourceDirect = async () => {
    if (!isGraphTab || !graph) {
      toast.error('No graph loaded');
      return;
    }
    
    if (selectedEdgeId) {
      // Handle edge (parameter) direct connection
      const edge = graph.edges?.find((e: any) => e.uuid === selectedEdgeId || e.id === selectedEdgeId);
      if (!edge) {
        toast.error('Selected edge not found');
        return;
      }
      
      const paramSlot = edge.p?.connection ? 'p' : edge.cost_gbp?.connection ? 'cost_gbp' : edge.cost_time?.connection ? 'cost_time' : undefined;
      if (!paramSlot) {
        toast.error('No direct connection on selected edge');
        return;
      }
      
      try {
        await dataOperationsService.getFromSourceDirect({
          objectType: 'parameter',
          objectId: '', // Direct connection, no file
          targetId: selectedEdgeId,
          graph,
          setGraph: handleSetGraph,
          paramSlot,
          window: windowState || undefined,
          dailyMode: false, // Direct to graph, not daily mode
        });
      } catch (error) {
        toast.error(`Failed to get data from source (direct): ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (selectedNodeId) {
      // Handle node (case) direct connection
      const node = graph.nodes?.find((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
      if (!node) {
        toast.error('Selected node not found');
        return;
      }
      
      if (!node.case?.connection) {
        toast.error('No direct connection on selected node');
        return;
      }
      
      try {
        await dataOperationsService.getFromSourceDirect({
          objectType: 'case',
          objectId: '', // Direct connection, no file
          targetId: selectedNodeId,
          graph,
          setGraph: handleSetGraph,
          window: windowState || undefined,
          dailyMode: false,
        });
      } catch (error) {
        toast.error(`Failed to get case from source (direct): ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      toast.error('No edge or node selected');
    }
  };
  
  const handlePutToFile = async () => {
    if (!isGraphTab || !graph) {
      toast.error('No graph loaded');
      return;
    }
    
    if (selectedEdgeId) {
      const edge = graph.edges?.find((e: any) => e.uuid === selectedEdgeId || e.id === selectedEdgeId);
      if (!edge) {
        toast.error('Selected edge not found');
        return;
      }
      
      const paramId = edge.p?.id || edge.cost_gbp?.id || edge.cost_time?.id;
      if (!paramId) {
        toast.error('No parameter file connected to selected edge');
        return;
      }
      
      const paramSlot = edge.p?.id ? 'p' : edge.cost_gbp?.id ? 'cost_gbp' : 'cost_time';
      
      try {
        await dataOperationsService.putParameterToFile({
          paramId,
          edgeId: selectedEdgeId,
          graph,
          setGraph: handleSetGraph,
        });
        toast.success('Data saved to file');
      } catch (error) {
        toast.error(`Failed to put data to file: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (selectedNodeId) {
      const node = graph.nodes?.find((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
      if (!node) {
        toast.error('Selected node not found');
        return;
      }
      
      // Check for case file first, then node file
      const caseId = node.case?.id;
      const nodeFileId = node.id; // Use node.id, not node.node_id
      
      if (caseId) {
        // Put case data to file
        try {
          await dataOperationsService.putCaseToFile({
            caseId,
            nodeId: selectedNodeId,
            graph,
            setGraph: handleSetGraph,
          });
          toast.success('Case data saved to file');
        } catch (error) {
          toast.error(`Failed to put case to file: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (nodeFileId) {
        // Put node data to file
        try {
          await dataOperationsService.putNodeToFile({
            nodeId: nodeFileId,
            graph,
            setGraph: handleSetGraph,
          });
          toast.success('Node data saved to file');
        } catch (error) {
          toast.error(`Failed to put node to file: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        toast.error('No case or node file connected');
      }
    } else {
      toast.error('No edge or node selected');
    }
  };
  
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
  
  // Check if selected edge/node has file connections
  let hasFileConnection = false; // File exists AND has connection - for "Get from Source" (versioned)
  let hasAnyFile = false; // File exists (for "Get from File")
  let canPutToFile = false; // Can put to file (file exists OR has ID - for "Put to File")
  let hasDirectConnection = false; // Direct connection on edge/node (for "Get from Source (direct)")
  let hasAnyConnection = false; // ANY connection (direct OR file) - for "Get from Source (direct)"
  
  if (hasEdgeSelection && graph) {
    const edge = graph.edges?.find((e: any) => e.uuid === selectedEdgeId || e.id === selectedEdgeId);
    if (edge) {
      // Check each parameter slot (p, cost_gbp, cost_time)
      const paramSlots: Array<'p' | 'cost_gbp' | 'cost_time'> = ['p', 'cost_gbp', 'cost_time'];
      
      for (const slot of paramSlots) {
        const param = slot === 'p' ? edge.p : edge[slot];
        const paramId = param?.id;
        
        // Check for direct connection on edge
        if (param?.connection) {
          hasDirectConnection = true;
          hasAnyConnection = true;
        }
        
        // Check for connection in file
        if (paramId) {
          const file = fileRegistry.getFile(`parameter-${paramId}`);
          if (file) {
            hasAnyFile = true; // File exists
            canPutToFile = true; // Can put to file (file exists)
            if (file.data?.connection) {
              hasFileConnection = true; // File exists AND has connection
              hasAnyConnection = true; // Any connection (file or direct)
            }
          } else {
            // File doesn't exist but paramId exists - can create file
            canPutToFile = true;
          }
        }
      }
    }
  }
  
  if (hasNodeSelection && graph) {
    console.log('[DataMenu] Checking node selection:', {
      hasNodeSelection,
      selectedNodeId,
      graphExists: !!graph,
      nodeCount: graph?.nodes?.length,
    });
    
    const node = graph.nodes?.find((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
    if (node) {
      console.log('[DataMenu] Node found:', {
        selectedNodeId,
        nodeId: node.id,
        nodeUuid: node.uuid,
        hasCase: !!node.case,
        caseId: node.case?.id,
        caseConnection: node.case?.connection,
      });
      
      // Check for case file connection
      const caseId = node.case?.id;
      if (caseId) {
        const file = fileRegistry.getFile(`case-${caseId}`);
        console.log('[DataMenu] Case file check:', {
          caseId,
          fileExists: !!file,
          fileConnection: file?.data?.connection,
        });
        if (file) {
          hasAnyFile = true; // File exists
          canPutToFile = true; // Can put to file (file exists)
          if (file.data?.connection) {
            hasFileConnection = true; // File exists AND has connection
            hasAnyConnection = true; // Any connection
          }
        } else {
          // Case file doesn't exist but caseId exists - can create file
          canPutToFile = true;
        }
      }
      
      // Check for direct case connection (regardless of file existence - matches parameter pattern)
      if (node.case?.connection) {
        console.log('[DataMenu] Direct case connection found');
        hasDirectConnection = true;
        hasAnyConnection = true;
      }
      
      // Check for node file connection
      // Note: Nodes use node.id as the file reference (like NodeContextMenu does)
      // If node has an id, it can have a node file (even if file doesn't exist yet)
      const nodeFileId = node.id;
      console.log('[DataMenu] Node file check:', {
        nodeFileId,
        nodeId: node.id,
        willCheckFile: !!nodeFileId,
      });
      if (nodeFileId) {
        const file = fileRegistry.getFile(`node-${nodeFileId}`);
        console.log('[DataMenu] Node file lookup result:', {
          nodeFileId,
          fileId: `node-${nodeFileId}`,
          fileExists: !!file,
          willSetCanPutToFile: true, // Always true if nodeFileId exists
        });
        if (file) {
          hasAnyFile = true; // File exists
          canPutToFile = true; // Can put to file (file exists)
          console.log('[DataMenu] Node file EXISTS - setting hasAnyFile and canPutToFile');
        } else {
          // Node file doesn't exist but nodeFileId exists - can create file
          canPutToFile = true;
          console.log('[DataMenu] Node file DOES NOT EXIST but nodeFileId exists - setting canPutToFile=true');
        }
        console.log('[DataMenu] After node file check:', { hasAnyFile, canPutToFile });
      } else {
        console.log('[DataMenu] No nodeFileId - skipping node file check');
      }
    } else {
      console.warn('[DataMenu] Node not found:', {
        selectedNodeId,
        nodeCount: graph?.nodes?.length,
        nodeIds: graph?.nodes?.map((n: any) => ({ id: n.id, uuid: n.uuid })),
      });
    }
  }
  
  // Debug logging
  if (hasSelection) {
    console.log('[DataMenu] Connection check:', {
      hasSelection,
      hasEdgeSelection,
      hasNodeSelection,
      selectedEdgeId,
      selectedNodeId,
      hasAnyFile,
      canPutToFile,
      hasFileConnection,
      hasDirectConnection,
      hasAnyConnection,
      isGraphTab,
      // Calculate disabled states for menu items
      getFromFileDisabled: !isGraphTab || !hasSelection || !hasAnyFile,
      getFromSourceDisabled: !isGraphTab || !hasSelection || !hasFileConnection,
      getFromSourceDirectDisabled: !isGraphTab || !hasEdgeSelection || !hasAnyConnection,
      putToFileDisabled: !isGraphTab || !hasSelection || !canPutToFile,
    });
  }
  
  // Force re-render of menu content when selection changes
  const menuContentKey = `${selectedEdgeId || 'no-edge'}-${selectedNodeId || 'no-node'}-${canPutToFile ? 'can-put' : 'cannot-put'}`;
  
  // Debug: Log the actual disabled value that will be used
  const putToFileDisabled = !isGraphTab || !hasSelection || !canPutToFile;
  console.log('[DataMenu] Put to File disabled (final):', {
    isGraphTab,
    hasSelection,
    canPutToFile,
    putToFileDisabled,
    selectedEdgeId,
    selectedNodeId,
    menuContentKey,
  });
  
  return (
    <>
      <Menubar.Menu key={menuContentKey}>
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
          
          {/* Context-dependent operations */}
          <Menubar.Item 
            key={`get-from-file-${hasSelection}-${hasAnyFile}`}
            className="menubar-item" 
            onSelect={handleGetFromFile}
            disabled={!isGraphTab || !hasSelection || !hasAnyFile}
          >
            Get data from file...
            {!hasSelection && <div className="menubar-right-slot">(select edge/node)</div>}
          </Menubar.Item>
          
          <Menubar.Item 
            key={`get-from-source-${hasSelection}-${hasFileConnection}`}
            className="menubar-item" 
            onSelect={handleGetFromSource}
            disabled={!isGraphTab || !hasSelection || !hasFileConnection}
          >
            Get data from source...
            {!hasSelection && <div className="menubar-right-slot">(select edge/node)</div>}
          </Menubar.Item>
          
          <Menubar.Item 
            key={`get-from-source-direct-${hasSelection}-${hasAnyConnection}`}
            className="menubar-item" 
            onSelect={handleGetFromSourceDirect}
            disabled={!isGraphTab || !hasSelection || !hasAnyConnection}
          >
            Get data from source (direct)...
            {!hasSelection && <div className="menubar-right-slot">(select edge/node)</div>}
          </Menubar.Item>
          
          <Menubar.Item 
            key={`put-to-file-${hasSelection}-${canPutToFile}-${selectedNodeId}-${selectedEdgeId}`}
            className="menubar-item" 
            onSelect={handlePutToFile}
            disabled={!isGraphTab || !hasSelection || !canPutToFile}
          >
            Put data to file...
            {!hasSelection && <div className="menubar-right-slot">(select edge/node)</div>}
            {(hasSelection && !canPutToFile) && <div className="menubar-right-slot">(no file ID)</div>}
          </Menubar.Item>
          
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

