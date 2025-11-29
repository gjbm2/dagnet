/**
 * Node Context Menu Component
 * 
 * Context menu for graph nodes with data operations (Get/Put)
 */

import React, { useState, useRef, useEffect } from 'react';
import { dataOperationsService } from '../services/dataOperationsService';
import { fileOperationsService } from '../services/fileOperationsService';
import { extractSubgraph, createGraphFromSubgraph, generateSubgraphName } from '../lib/subgraphExtractor';
import { Folders, TrendingUpDown, ChevronRight, Share2, Database, DatabaseZap, Copy } from 'lucide-react';
import { RemoveOverridesMenuItem } from './RemoveOverridesMenuItem';
import { fileRegistry } from '../contexts/TabContext';
import VariantWeightInput from './VariantWeightInput';
import { AutomatableField } from './AutomatableField';
import { isProbabilityMassUnbalanced } from '../utils/rebalanceUtils';
import toast from 'react-hot-toast';
import { getAllDataSections, type DataOperationSection } from './DataOperationsSections';
import { DataSectionSubmenu } from './DataSectionSubmenu';
import { copyVarsToClipboard } from '../services/copyVarsService';
import { useClearDataFile } from '../hooks/useClearDataFile';

interface NodeContextMenuProps {
  x: number;
  y: number;
  nodeId: string;
  nodeData: any;
  nodes: any[];
  activeTabId: string | null;
  tabOperations: any;
  graph: any; // Tab-specific graph
  setGraph: (graph: any) => void; // Tab-specific graph setter
  onClose: () => void;
  onSelectNode: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
}

export const NodeContextMenu: React.FC<NodeContextMenuProps> = ({
  x,
  y,
  nodeId,
  nodeData,
  nodes,
  activeTabId,
  tabOperations,
  graph,
  setGraph,
  onClose,
  onSelectNode,
  onDeleteNode,
}) => {
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const submenuTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Calculate constrained position on mount
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const menuWidth = rect.width;
      const menuHeight = rect.height;
      
      let left = x;
      let top = y;
      
      // Constrain horizontally
      const viewportWidth = window.innerWidth;
      if (left + menuWidth > viewportWidth - 20) {
        left = Math.max(20, viewportWidth - menuWidth - 20);
      }
      if (left < 20) {
        left = 20;
      }
      
      // Constrain vertically
      const viewportHeight = window.innerHeight;
      if (top + menuHeight > viewportHeight - 20) {
        // Try to show above the cursor position
        const aboveY = y - menuHeight - 4;
        if (aboveY > 20) {
          top = aboveY;
        } else {
          top = Math.max(20, viewportHeight - menuHeight - 20);
        }
      }
      if (top < 20) {
        top = 20;
      }
      
      setPosition({ left, top });
    }
  }, [x, y]);
  
  // Helper to handle submenu open/close with delay to prevent closing when hovering over disabled items
  const handleSubmenuEnter = (submenuName: string) => {
    if (submenuTimeoutRef.current) {
      clearTimeout(submenuTimeoutRef.current);
      submenuTimeoutRef.current = null;
    }
    setOpenSubmenu(submenuName);
  };
  
  const handleSubmenuLeave = () => {
    // Add a small delay before closing to allow movement to submenu
    submenuTimeoutRef.current = setTimeout(() => {
      setOpenSubmenu(null);
      submenuTimeoutRef.current = null;
    }, 150);
  };
  
  const handleSubmenuContentEnter = () => {
    // Cancel close timeout when entering submenu content
    if (submenuTimeoutRef.current) {
      clearTimeout(submenuTimeoutRef.current);
      submenuTimeoutRef.current = null;
    }
  };
  
  const handleSubmenuContentLeave = () => {
    // Close immediately when leaving submenu content
    setOpenSubmenu(null);
    if (submenuTimeoutRef.current) {
      clearTimeout(submenuTimeoutRef.current);
      submenuTimeoutRef.current = null;
    }
  };
  
  // Get selected nodes
  const selectedNodes = nodes.filter(n => n.selected || n.id === nodeId || n.data?.id === nodeId);
  // Use data.id (human-readable ID) for hide operations, as that's what the graph schema uses
  const selectedNodeIds = selectedNodes.map(n => n.data?.id).filter(Boolean) as string[];
  const allHidden = selectedNodeIds.length > 0 && selectedNodeIds.every(id => activeTabId && tabOperations.isNodeHidden(activeTabId, id));
  const isMultiSelect = selectedNodeIds.length > 1;
  
  // Get all data operation sections for this node using single source of truth
  const dataOperationSections = getAllDataSections(nodeId, null, graph);
  const hasAnyFile = dataOperationSections.length > 0;

  const handleGetNodeFromFile = () => {
    if (nodeData?.id) {
      dataOperationsService.getNodeFromFile({ 
        nodeId: nodeData.id,
        graph,
        setGraph
      });
    }
    onClose();
  };

  const handlePutNodeToFile = () => {
    if (nodeData?.id) {
      dataOperationsService.putNodeToFile({ 
        nodeId: nodeData.id,
        graph,
        setGraph
      });
    }
    onClose();
  };

  const handleGetCaseFromFile = () => {
    if (nodeData?.case?.id) {
      dataOperationsService.getCaseFromFile({ 
        caseId: nodeData.case.id, 
        nodeId,
        graph,
        setGraph
      });
    }
    onClose();
  };

  const handlePutCaseToFile = () => {
    if (nodeData?.case?.id) {
      dataOperationsService.putCaseToFile({ 
        caseId: nodeData.case.id, 
        nodeId,
        graph,
        setGraph
      });
    }
    onClose();
  };

  const handleGetCaseFromSourceDirect = () => {
    // Check for connection (file connection OR direct connection)
    const file = nodeData?.case?.id ? fileRegistry.getFile(`case-${nodeData.case.id}`) : null;
    const hasFileConn = !!file?.data?.connection;
    const hasDirectConnection = !!nodeData?.case?.connection;
    const hasAnyConnection = hasDirectConnection || hasFileConn;
    
    if (!hasAnyConnection) {
      toast.error('No connection configured for case');
      return;
    }
    
    if (!nodeData?.case?.id) {
      toast.error('No case ID found');
      return;
    }
    
    // Call getFromSourceDirect - fetches and writes directly to graph (no file versioning)
    dataOperationsService.getFromSourceDirect({
      objectType: 'case',
      objectId: nodeData.case.id,
      targetId: nodeId,
      graph,
      setGraph,
      dailyMode: false,
      currentDSL: graph?.currentQueryDSL || '' // Pass context from WindowSelector
    });
    onClose();
  };

  const handleGetCaseFromSourceVersioned = () => {
    if (!nodeData?.case?.id) {
      toast.error('No case file connected');
      return;
    }
    
    // Call getFromSource (versioned) - fetches to file then updates graph
    dataOperationsService.getFromSource({
      objectType: 'case',
      objectId: nodeData.case.id,
      targetId: nodeId,
      graph,
      setGraph,
      currentDSL: graph?.currentQueryDSL || '' // Pass context from WindowSelector
    });
    onClose();
  };

  // Generic section-based handlers (for refactored rendering)
  const handleSectionGetFromFile = (section: DataOperationSection) => {
    if (section.objectType === 'case') {
      handleGetCaseFromFile();
    } else if (section.objectType === 'node') {
      handleGetNodeFromFile();
    }
  };

  const handleSectionPutToFile = (section: DataOperationSection) => {
    if (section.objectType === 'case') {
      handlePutCaseToFile();
    } else if (section.objectType === 'node') {
      handlePutNodeToFile();
    }
  };

  const handleSectionGetFromSourceDirect = (section: DataOperationSection) => {
    if (section.objectType === 'case') {
      handleGetCaseFromSourceDirect();
    }
  };

  const handleSectionGetFromSource = (section: DataOperationSection) => {
    if (section.objectType === 'case') {
      handleGetCaseFromSourceVersioned();
    }
  };
  
  const handleSectionClearCache = (section: DataOperationSection) => {
    if (section.objectType === 'event') {
      // Events don't have cache clearing support
      return;
    }
    import('../services/dataOperationsService').then(({ dataOperationsService }) => {
      dataOperationsService.clearCache(section.objectType as 'parameter' | 'case' | 'node', section.objectId);
    });
    onClose();
  };
  
  // Clear data file hook
  const { clearDataFile } = useClearDataFile();
  
  const handleSectionClearDataFile = async (section: DataOperationSection) => {
    if (section.objectType !== 'parameter' && section.objectType !== 'case') {
      // Only parameters and cases have data to clear
      return;
    }
    const fileId = section.objectType === 'parameter' 
      ? `parameter-${section.objectId}` 
      : `case-${section.objectId}`;
    await clearDataFile(fileId);
    onClose();
  };
  
  const handleShowInNewGraph = async () => {
    try {
      // Get selected node UUIDs (ReactFlow uses 'id' field which contains the UUID)
      const selectedNodeUuids = selectedNodes.map(n => n.id);
      
      if (selectedNodeUuids.length === 0) {
        toast.error('No nodes selected');
        onClose();
        return;
      }

      // Extract subgraph
      const subgraph = extractSubgraph({
        selectedNodeIds: selectedNodeUuids,
        graph,
        includeConnectedEdges: true
      });

      if (subgraph.nodes.length === 0) {
        toast.error('No nodes to extract');
        onClose();
        return;
      }

      // Generate name and create graph
      const graphName = generateSubgraphName(subgraph.nodes.length);
      const newGraph = createGraphFromSubgraph(subgraph, {
        name: graphName,
        description: `Extracted ${subgraph.nodes.length} nodes and ${subgraph.edges.length} edges`
      });

      // Create the graph file (don't open yet, we need to update the data first)
      const { fileId, item } = await fileOperationsService.createFile(graphName, 'graph', {
        openInTab: false,
        viewMode: 'interactive',
        metadata: {
          description: `Extracted ${subgraph.nodes.length} nodes and ${subgraph.edges.length} edges`,
          tags: ['extracted-subgraph']
        }
      });

      // Update the file with our custom graph data
      const { fileRegistry } = await import('../contexts/TabContext');
      await fileRegistry.updateFile(fileId, newGraph);

      // Now open the file in a tab
      await fileOperationsService.openFile(item, {
        viewMode: 'interactive',
        switchIfExists: false
      });

      toast.success(`Created new graph with ${subgraph.nodes.length} nodes and ${subgraph.edges.length} edges`);
      onClose();
    } catch (error) {
      console.error('Failed to create subgraph:', error);
      toast.error('Failed to create new graph');
      onClose();
    }
  };

  const handleCopyVars = async () => {
    const selectedNodeUuids = selectedNodes.map(n => n.id);
    const result = await copyVarsToClipboard(graph, selectedNodeUuids, []);
    
    if (result.success) {
      toast.success(
        `Copied ${result.count} variable${result.count !== 1 ? 's' : ''} ` +
        `from ${result.nodeCount} node${result.nodeCount !== 1 ? 's' : ''} to clipboard`
      );
    } else {
      toast.error(result.error || 'Failed to copy variables');
    }
    
    onClose();
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: position.left,
        top: position.top,
        background: 'white',
        border: '1px solid #ddd',
        borderRadius: '4px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        minWidth: '160px',
        padding: '4px',
        zIndex: 10000
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Properties */}
      <div
        onClick={(e) => {
          e.stopPropagation();
          onSelectNode(nodeId);
          window.dispatchEvent(new CustomEvent('dagnet:openPropertiesPanel'));
          onClose();
        }}
        style={{
          padding: '8px 12px',
          cursor: 'pointer',
          fontSize: '13px',
          borderRadius: '2px'
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
      >
        Properties
      </div>

      {/* Case Variant Weights (if case node) */}
      {!!nodeData?.case && nodeData?.case?.variants && nodeData.case.variants.length > 0 && (
        <>
          <div style={{ height: '1px', background: '#eee', margin: '8px 0' }} />
          <div style={{ padding: '8px 12px', fontSize: '12px', fontWeight: '600', color: '#333' }}>
            Variant Weights
          </div>
          {nodeData.case.variants.map((variant: any, index: number) => {
            const allVariants = nodeData.case.variants || [];
            
            return (
              <div key={index} style={{ marginBottom: '8px', padding: '6px 12px' }}>
                <AutomatableField
                  label={`${variant.name || `Variant ${index + 1}`}`}
                  value={variant.weight || 0}
                  overridden={variant.weight_overridden || false}
                  onClearOverride={() => {
                    if (graph && nodeData?.id) {
                      const nextGraph = structuredClone(graph);
                      const nodeIndex = nextGraph.nodes.findIndex((n: any) => 
                        n.uuid === nodeId || n.id === nodeId || n.id === nodeData.id
                      );
                      if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                        delete nextGraph.nodes[nodeIndex].case.variants[index].weight_overridden;
                        if (nextGraph.metadata) {
                          nextGraph.metadata.updated_at = new Date().toISOString();
                        }
                        setGraph(nextGraph);
                      }
                    }
                  }}
                >
                  <VariantWeightInput
                    value={variant.weight || 0}
                    onChange={(value) => {
                      // Update local state immediately for real-time feedback
                    }}
                    onCommit={async (value) => {
                      if (graph && nodeData?.id) {
                        const { graphMutationService } = await import('../services/graphMutationService');
                        const nextGraph = structuredClone(graph);
                        const nodeIndex = nextGraph.nodes.findIndex((n: any) => 
                          n.uuid === nodeId || n.id === nodeId || n.id === nodeData.id
                        );
                        if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                          if (!nextGraph.nodes[nodeIndex].case.variants[index]) {
                            return;
                          }
                          nextGraph.nodes[nodeIndex].case.variants[index].weight = value;
                          nextGraph.nodes[nodeIndex].case.variants[index].weight_overridden = true;
                          if (nextGraph.metadata) {
                            nextGraph.metadata.updated_at = new Date().toISOString();
                          }
                          await graphMutationService.updateGraph(graph, nextGraph, setGraph);
                        }
                      }
                    }}
                    onRebalance={async (newValue, currentIdx, allVars) => {
                      if (!graph || !nodeData?.id) return;
                      
                      // Use UpdateManager for rebalancing with forceRebalance=true (override _overridden flags)
                      // IMPORTANT: Preserves origin variant's current value - only updates other variants
                      const { updateManager } = await import('../services/UpdateManager');
                      const { graphMutationService } = await import('../services/graphMutationService');
                      
                      const nodeInGraph = graph.nodes.find((n: any) => 
                        n.uuid === nodeId || n.id === nodeId || n.id === nodeData.id
                      );
                      if (!nodeInGraph) return;
                      
                      const oldGraph = graph;
                      const result = updateManager.rebalanceVariantWeights(
                        graph,
                        nodeInGraph.uuid || nodeInGraph.id,
                        currentIdx,
                        true // forceRebalance: true - override _overridden flags when user clicks rebalance
                      );
                      
                      await graphMutationService.updateGraph(oldGraph, result.graph, setGraph);
                    }}
                    currentIndex={index}
                    allVariants={allVariants}
                    autoFocus={false}
                    autoSelect={false}
                    showSlider={true}
                    showBalanceButton={true}
                  />
                </AutomatableField>
              </div>
            );
          })}
        </>
      )}

      {/* Data operations (using single source of truth) */}
      {dataOperationSections.length > 0 && (
        <>
          <div style={{ height: '1px', background: '#eee', margin: '8px 0' }} />
          
          {/* Render all data operation sections */}
          {dataOperationSections.map(section => (
            <DataSectionSubmenu
              key={section.id}
              section={section}
              isOpen={openSubmenu === section.id}
              onMouseEnter={() => handleSubmenuEnter(section.id)}
              onMouseLeave={handleSubmenuLeave}
              onSubmenuContentEnter={handleSubmenuContentEnter}
              onSubmenuContentLeave={handleSubmenuContentLeave}
              onGetFromFile={handleSectionGetFromFile}
              onPutToFile={handleSectionPutToFile}
              onGetFromSource={handleSectionGetFromSource}
              onGetFromSourceDirect={handleSectionGetFromSourceDirect}
              onClearCache={handleSectionClearCache}
              onClearDataFile={handleSectionClearDataFile}
            />
          ))}
        </>
      )}

      {/* Copy vars */}
      <div style={{ height: '1px', background: '#eee', margin: '4px 0' }} />
      <div
        onClick={(e) => {
          e.stopPropagation();
          handleCopyVars();
        }}
        style={{
          padding: '8px 12px',
          cursor: 'pointer',
          fontSize: '13px',
          borderRadius: '2px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
      >
        <Copy size={14} />
        <span>Copy vars{isMultiSelect ? ` (${selectedNodes.length} nodes)` : ''}</span>
      </div>

      <RemoveOverridesMenuItem 
        graph={graph} 
        onUpdateGraph={(g, historyLabel) => setGraph(g)} 
        nodeId={nodeId} 
        onClose={onClose} 
      />

      {/* Show in new graph (multi-select only) */}
      {isMultiSelect && (
        <>
          <div
            onClick={(e) => {
              e.stopPropagation();
              handleShowInNewGraph();
            }}
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              color: '#007bff',
              borderRadius: '2px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
          >
            <Share2 size={14} />
            <span>Show in new graph ({selectedNodes.length} nodes)</span>
          </div>
        </>
      )}

      <div style={{ height: '1px', background: '#eee', margin: '4px 0' }} />

      {/* Hide/Unhide */}
      {allHidden ? (
        <div
          onClick={(e) => {
            e.stopPropagation();
            if (activeTabId) {
              selectedNodeIds.forEach(id => tabOperations.unhideNode(activeTabId, id));
            }
            onClose();
          }}
          style={{
            padding: '8px 12px',
            cursor: 'pointer',
            fontSize: '13px',
            color: '#28a745',
            borderRadius: '2px'
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
        >
          Show {isMultiSelect ? `${selectedNodeIds.length} nodes` : 'node'}
        </div>
      ) : (
        <div
          onClick={(e) => {
            e.stopPropagation();
            if (activeTabId) {
              selectedNodeIds.forEach(id => tabOperations.hideNode(activeTabId, id));
            }
            onClose();
          }}
          style={{
            padding: '8px 12px',
            cursor: 'pointer',
            fontSize: '13px',
            color: '#6c757d',
            borderRadius: '2px'
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
        >
          Hide {isMultiSelect ? `${selectedNodeIds.length} nodes` : 'node'}
        </div>
      )}

      {/* Delete */}
      <div
        onClick={(e) => {
          e.stopPropagation();
          onDeleteNode(nodeId);
          onClose();
        }}
        style={{
          padding: '8px 12px',
          cursor: 'pointer',
          fontSize: '13px',
          color: '#dc3545',
          borderRadius: '2px'
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
      >
        Delete node
      </div>
    </div>
  );
};
