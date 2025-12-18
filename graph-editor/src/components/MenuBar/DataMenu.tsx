import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { getGraphStore } from '../../contexts/GraphStoreContext';
import { dataOperationsService } from '../../services/dataOperationsService';
import { BatchOperationsModal, type SingleOperationTarget } from '../modals/BatchOperationsModal';
import { AllSlicesModal } from '../modals/AllSlicesModal';
import toast from 'react-hot-toast';
import type { GraphData } from '../../types';
import type { BatchOperationType } from '../modals/BatchOperationsModal';
import { getAllDataSections, type DataOperationSection } from '../DataOperationsSections';
import { Database, DatabaseZap, Folders, TrendingUpDown, Trash2, FileText } from 'lucide-react';
import { useOpenFile } from '../../hooks/useOpenFile';
import { RemoveOverridesMenubarItem } from '../RemoveOverridesMenuItem';
import { useClearDataFile } from '../../hooks/useClearDataFile';
import { useFetchData, createFetchItem, type FetchMode } from '../../hooks/useFetchData';
import { useRetrieveAllSlices } from '../../hooks/useRetrieveAllSlices';
import { useRetrieveAllSlicesRequestListener } from '../../hooks/useRetrieveAllSlicesRequestListener';
import { PinnedQueryModal } from '../modals/PinnedQueryModal';
import { db } from '../../db/appDatabase';

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
  
  // Get graph store for currentDSL and setGraph
  const graphStore = activeTab && isGraphTab ? getGraphStore(activeTab.fileId) : null;
  
  // Subscribe to graph store changes so we get updates when dataInterestsDSL changes
  const [graphFromStore, setGraphFromStore] = useState<GraphData | null>(
    graphStore?.getState().graph || null
  );
  
  useEffect(() => {
    if (!graphStore) {
      setGraphFromStore(null);
      return;
    }
    
    // Get initial value
    setGraphFromStore(graphStore.getState().graph);
    
    // Subscribe to changes
    const unsubscribe = graphStore.subscribe((state) => {
      setGraphFromStore(state.graph);
    });
    
    return unsubscribe;
  }, [graphStore]);
  
  // Prefer graph from store (more up-to-date), fallback to fileRegistry
  const graph = graphFromStore || graphFromFile;
  
  // Helper to update graph
  const handleSetGraph = useCallback((newGraph: GraphData | null) => {
    if (!graphStore || !newGraph) return;
    graphStore.getState().setGraph(newGraph);
    // Also update fileRegistry
    if (activeTab) {
      fileRegistry.updateFile(activeTab.fileId, newGraph);
    }
  }, [graphStore, activeTab]);
  
  // Centralized fetch hook - all fetch operations go through this
  // CRITICAL: Uses graphStore.currentDSL as AUTHORITATIVE source, NOT graph.currentQueryDSL!
  const { fetchItem } = useFetchData({
    graph: graph as any,
    setGraph: handleSetGraph as any,
    currentDSL: () => graphStore?.getState().currentDSL || '',  // AUTHORITATIVE DSL from graphStore
  });
  
  // Track selection state (will be wired up later)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  
  // Multi-selection support: track all selected node/edge UUIDs
  const [selectedNodeUuids, setSelectedNodeUuids] = useState<string[]>([]);
  const [selectedEdgeUuids, setSelectedEdgeUuids] = useState<string[]>([]);
  
  // Exclude test accounts setting (temporary hack - will be replaced with proper contexts)
  const [excludeTestAccounts, setExcludeTestAccounts] = useState<boolean>(true);  // Default to true
  
  // Load excludeTestAccounts setting on mount
  useEffect(() => {
    const loadSetting = async () => {
      const settings = await db.getSettings();
      // Default to true if not set
      setExcludeTestAccounts(settings?.data?.excludeTestAccounts ?? true);
    };
    loadSetting();
  }, []);
  
  // Handler to toggle exclude test accounts
  const handleToggleExcludeTestAccounts = async () => {
    const newValue = !excludeTestAccounts;
    setExcludeTestAccounts(newValue);
    
    // Persist to settings
    const settings = await db.getSettings();
    await db.saveSettings({
      ...settings,
      data: {
        ...settings?.data,
        excludeTestAccounts: newValue,
      },
    });
    
    toast.success(newValue ? 'Test accounts will be excluded' : 'Test accounts will be included');
  };
  
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
  const [batchSingleTarget, setBatchSingleTarget] = useState<SingleOperationTarget | null>(null);

  // Allow any UI entry point to open the batch modal in single-item mode.
  useEffect(() => {
    const handler = (e: CustomEvent) => {
      const detail = (e as any).detail as { operationType?: BatchOperationType; singleTarget?: SingleOperationTarget } | undefined;
      const op = detail?.operationType;
      const singleTarget = detail?.singleTarget;

      if (!op) return;
      if (!graphStore) return;
      if (!graph) {
        toast.error('No graph loaded');
        return;
      }

      setBatchOperationType(op);
      setBatchSingleTarget(singleTarget ?? null);
      setBatchModalOpen(true);
    };

    window.addEventListener('dagnet:openBatchOperationsModal', handler as EventListener);
    return () => window.removeEventListener('dagnet:openBatchOperationsModal', handler as EventListener);
  }, [graphStore, graph]);
  
  // All slices flow - uses hook to handle pinned query requirement
  const {
    showAllSlicesModal,
    initiateRetrieveAllSlices,
    closeAllSlicesModal,
    pinnedQueryModalProps,
  } = useRetrieveAllSlices({
    graph: graph as GraphData | null,
    setGraph: handleSetGraph,
  });

  // Allow non-menu callers (e.g. safety nudges) to open the existing flow without duplicating UI logic.
  useRetrieveAllSlicesRequestListener(initiateRetrieveAllSlices);
  
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
    if (section.objectType === 'parameter' || section.objectType === 'case' || section.objectType === 'node') {
      globalThis.window.dispatchEvent(new CustomEvent('dagnet:openBatchOperationsModal', {
        detail: {
          operationType: 'get-from-files',
          singleTarget: {
            type: section.objectType,
            objectId: section.objectId,
            targetId: section.targetId,
            paramSlot: section.paramSlot,
            conditionalIndex: section.conditionalIndex,
          },
        },
      }));
    }
  };

  const handleSectionPutToFile = (section: DataOperationSection) => {
    if (!graph) return;
    if (section.objectType === 'parameter' || section.objectType === 'case' || section.objectType === 'node') {
      globalThis.window.dispatchEvent(new CustomEvent('dagnet:openBatchOperationsModal', {
        detail: {
          operationType: 'put-to-files',
          singleTarget: {
            type: section.objectType,
            objectId: section.objectId,
            targetId: section.targetId,
            paramSlot: section.paramSlot,
            conditionalIndex: section.conditionalIndex,
          },
        },
      }));
    }
  };

  const handleSectionGetFromSourceDirect = (section: DataOperationSection) => {
    if (!graph) return;
    if (section.objectType === 'parameter' || section.objectType === 'case') {
      const item = createFetchItem(
        section.objectType,
        section.objectId,
        section.targetId,
        { paramSlot: section.paramSlot, conditionalIndex: section.conditionalIndex }
      );
      fetchItem(item, { mode: 'direct' });
    }
    // Note: 'node' type doesn't support direct fetch from source
  };

  const handleSectionGetFromSource = (section: DataOperationSection) => {
    if (!graph) return;
    if (section.objectType === 'parameter' || section.objectType === 'case') {
      const item = createFetchItem(
        section.objectType,
        section.objectId,
        section.targetId,
        { paramSlot: section.paramSlot, conditionalIndex: section.conditionalIndex }
      );
      // IMPORTANT: By default, respect incremental/bounded cache policy.
      // "Get from Source" follows the versioned path (source → file → graph),
      // and will only refetch where the cache / maturity policy says it should.
      // If the user wants to force a refetch, they should use "Unsign file cache"
      // or a dedicated bust-cache flow, not this handler.
      fetchItem(item, { mode: 'versioned' });
    }
    // Note: 'node' type doesn't support versioned fetch from source
  };
  
  const handleSectionClearCache = (section: DataOperationSection) => {
    if (section.objectType === 'event') {
      // Events don't have cache clearing support
      return;
    }
    dataOperationsService.clearCache(section.objectType as 'parameter' | 'case' | 'node', section.objectId);
  };
  
  // Clear data file hook
  const { clearDataFile, clearDataFiles, canClearData } = useClearDataFile();
  
  // Open file hook
  const { openFile } = useOpenFile();
  
  const handleSectionClearDataFile = async (section: DataOperationSection) => {
    if (section.objectType !== 'parameter' && section.objectType !== 'case') {
      // Only parameters and cases have data to clear
      return;
    }
    const fileId = section.objectType === 'parameter' 
      ? `parameter-${section.objectId}` 
      : `case-${section.objectId}`;
    await clearDataFile(fileId);
  };
  
  const handleSectionOpenFile = (section: DataOperationSection) => {
    // Open the file associated with this data section
    const type = section.objectType as 'parameter' | 'case' | 'node' | 'context' | 'event';
    openFile(type, section.objectId);
  };
  
  // Get all data operation sections using single source of truth
  // For multi-selection: gather sections from all selected nodes and edges between them
  const dataOperationSections = React.useMemo(() => {
    const sections: DataOperationSection[] = [];
    const seenIds = new Set<string>();
    
    // If we have multi-selection, gather from all selected nodes
    if (selectedNodeUuids.length > 0 && graph) {
      const selectedNodeSet = new Set(selectedNodeUuids);
      
      // Get sections from all selected nodes
      for (const nodeUuid of selectedNodeUuids) {
        const nodeSections = getAllDataSections(nodeUuid, null, graph);
        for (const section of nodeSections) {
          const sectionKey = `${section.objectType}-${section.objectId}-${section.id}`;
          if (!seenIds.has(sectionKey)) {
            seenIds.add(sectionKey);
            sections.push(section);
          }
        }
      }
      
      // Find edges where BOTH source and target are in selected nodes
      for (const edge of (graph.edges || [])) {
        const fromNode = graph.nodes?.find((n: any) => n.uuid === edge.from || n.id === edge.from);
        const toNode = graph.nodes?.find((n: any) => n.uuid === edge.to || n.id === edge.to);
        
        const fromUuid = fromNode?.uuid || edge.from;
        const toUuid = toNode?.uuid || edge.to;
        
        if (selectedNodeSet.has(fromUuid) && selectedNodeSet.has(toUuid)) {
          const edgeId = edge.uuid || edge.id;
          if (edgeId) {
            const edgeSections = getAllDataSections(null, edgeId, graph);
            for (const section of edgeSections) {
              const sectionKey = `${section.objectType}-${section.objectId}-${section.id}`;
              if (!seenIds.has(sectionKey)) {
                seenIds.add(sectionKey);
                sections.push(section);
              }
            }
          }
        }
      }
      
      return sections;
    }
    
    // Also include explicitly selected edges
    if (selectedEdgeUuids.length > 0 && graph) {
      for (const edgeUuid of selectedEdgeUuids) {
        const edgeSections = getAllDataSections(null, edgeUuid, graph);
        for (const section of edgeSections) {
          const sectionKey = `${section.objectType}-${section.objectId}-${section.id}`;
          if (!seenIds.has(sectionKey)) {
            seenIds.add(sectionKey);
            sections.push(section);
          }
        }
      }
      
      if (sections.length > 0) return sections;
    }
    
    // Fall back to single selection (backwards compatibility)
    return getAllDataSections(selectedNodeId, selectedEdgeId, graph);
  }, [selectedNodeUuids, selectedEdgeUuids, selectedNodeId, selectedEdgeId, graph]);
  
  // For batch operations: gather sections from ALL edges in the graph (not just selected)
  // This enables "Clear all data files" to work on the entire graph
  const allGraphSections = React.useMemo(() => {
    if (!graph) return [];
    const sections: DataOperationSection[] = [];
    const seenIds = new Set<string>(); // Dedupe by file ID
    
    // Get sections from all edges
    for (const edge of (graph.edges || [])) {
      const edgeId = edge.uuid || edge.id;
      if (!edgeId) continue;
      const edgeSections = getAllDataSections(null, edgeId, graph);
      for (const section of edgeSections) {
        const fileId = section.objectType === 'parameter' 
          ? `parameter-${section.objectId}` 
          : section.objectType === 'case' 
            ? `case-${section.objectId}`
            : null;
        if (fileId && !seenIds.has(fileId)) {
          seenIds.add(fileId);
          sections.push(section);
        }
      }
    }
    
    // Get sections from all nodes (for case data)
    for (const node of (graph.nodes || [])) {
      const nodeId = node.uuid || node.id;
      if (!nodeId) continue;
      const nodeSections = getAllDataSections(nodeId, null, graph);
      for (const section of nodeSections) {
        const fileId = section.objectType === 'parameter' 
          ? `parameter-${section.objectId}` 
          : section.objectType === 'case' 
            ? `case-${section.objectId}`
            : null;
        if (fileId && !seenIds.has(fileId)) {
          seenIds.add(fileId);
          sections.push(section);
        }
      }
    }
    
    return sections;
  }, [graph]);
  
  // Check if ANY section in the entire graph has data that can be cleared (for batch operation)
  const sectionsWithClearableData = allGraphSections.filter(section => {
    if (section.objectType !== 'parameter' && section.objectType !== 'case') return false;
    const fileId = section.objectType === 'parameter' 
      ? `parameter-${section.objectId}` 
      : `case-${section.objectId}`;
    return section.operations.clearDataFile && canClearData(fileId);
  });
  const canClearAnyData = sectionsWithClearableData.length > 0;
  
  // Handler for batch clear all data files
  const handleClearAllDataFiles = async () => {
    const fileIds = sectionsWithClearableData.map(section => 
      section.objectType === 'parameter' 
        ? `parameter-${section.objectId}` 
        : `case-${section.objectId}`
    );
    await clearDataFiles(fileIds);
  };
  
  // Determine if context-dependent items should be enabled
  const hasSelection = selectedEdgeId !== null || selectedNodeId !== null;
  const hasEdgeSelection = selectedEdgeId !== null;
  const hasNodeSelection = selectedNodeId !== null;
  
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
            
            // Query full multi-selection via event
            const queryDetail: { selectedNodeUuids?: string[]; selectedEdgeUuids?: string[] } = {};
            window.dispatchEvent(new CustomEvent('dagnet:querySelection', { detail: queryDetail }));
            setSelectedNodeUuids(queryDetail.selectedNodeUuids || []);
            setSelectedEdgeUuids(queryDetail.selectedEdgeUuids || []);
          }
        }}>
          Data
        </Menubar.Trigger>
        <Menubar.Portal>
          <Menubar.Content className="menubar-content" align="start">
          {/* Retrieve All Slices - at top */}
          <Menubar.Item 
            className="menubar-item" 
            onSelect={initiateRetrieveAllSlices}
            disabled={!isGraphTab}
          >
            Retrieve All Slices...
          </Menubar.Item>
          
          <Menubar.Separator className="menubar-separator" />
          
          {/* Batch operations for current slice */}
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleGetAllFromFiles}
          >
            Get all for current slice from Files...
          </Menubar.Item>
          
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleGetAllFromSources}
          >
            Get all for current slice from Sources...
          </Menubar.Item>
          
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleGetAllFromSourcesDirect}
          >
            Get all for current slice from Sources (direct)...
          </Menubar.Item>
          
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handlePutAllToFiles}
          >
            Put all for current slice to Files...
          </Menubar.Item>
          
          <Menubar.Separator className="menubar-separator" />
          
          {/* Clear all data files - batch operation */}
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleClearAllDataFiles}
            disabled={!canClearAnyData}
          >
            Clear all data files...
          </Menubar.Item>
          
          <Menubar.Separator className="menubar-separator" />
          
          {/* Context-dependent operations (section-based submenus) */}
          {dataOperationSections.length > 0 ? (
            dataOperationSections.map(section => (
              <Menubar.Sub key={section.id}>
                <Menubar.SubTrigger className="menubar-item">
                  {section.label}
                  <div className="menubar-right-slot">›</div>
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
                  {/* Open file - only show if file exists */}
                  {section.hasFile && (
                    <Menubar.Item 
                      className="menubar-item"
                      onSelect={() => handleSectionOpenFile(section)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                    >
                      <span>Open file</span>
                      <FileText size={12} style={{ color: '#666' }} />
                    </Menubar.Item>
                  )}
                  {section.hasFile && (
                    <Menubar.Separator className="menubar-separator" style={{ margin: '4px 0' }} />
                  )}
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
                  {section.operations.clearCache && (
                    <>
                      <Menubar.Separator className="menubar-separator" style={{ margin: '4px 0' }} />
                      <Menubar.Item 
                        className="menubar-item" 
                        onSelect={() => handleSectionClearCache(section)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '16px'
                        }}
                      >
                        <span>Unsign file cache</span>
                      </Menubar.Item>
                    </>
                  )}
                  {section.operations.clearDataFile && (
                    <Menubar.Item 
                      className="menubar-item" 
                      onSelect={() => handleSectionClearDataFile(section)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                    >
                      <span>Clear data file</span>
                      <Trash2 size={12} style={{ color: '#666' }} />
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
          
          <RemoveOverridesMenubarItem 
            graph={graph} 
            onUpdateGraph={(g, historyLabel) => handleSetGraph(g)} 
            nodeId={selectedNodeId} 
            edgeId={selectedEdgeId} 
          />
          
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
          
          <Menubar.Separator className="menubar-separator" />
          
          {/* Exclude test accounts toggle (temporary hack) */}
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleToggleExcludeTestAccounts}
          >
            {excludeTestAccounts ? '✓ ' : ''}Exclude test accounts
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
          setBatchSingleTarget(null);
        }}
        operationType={batchOperationType}
        singleTarget={batchSingleTarget}
        graph={graph || null}
        setGraph={handleSetGraph}
        currentDSL={graphStore?.getState().currentDSL || ''}
      />
    )}
    
    {/* All Slices Modal - only render when open */}
    {showAllSlicesModal && (
      <AllSlicesModal
        isOpen={showAllSlicesModal}
        onClose={closeAllSlicesModal}
        graph={graph || null}
        setGraph={handleSetGraph}
      />
    )}
    
    {/* Pinned Query Modal - shown if user tries to retrieve all slices without a pinned query */}
    <PinnedQueryModal {...pinnedQueryModalProps} />
  </>
  );
}

