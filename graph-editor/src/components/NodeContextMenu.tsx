/**
 * Node Context Menu Component
 * 
 * Context menu for graph nodes with data operations (Get/Put)
 */

import React, { useState } from 'react';
import { dataOperationsService } from '../services/dataOperationsService';
import { fileOperationsService } from '../services/fileOperationsService';
import { extractSubgraph, createGraphFromSubgraph, generateSubgraphName } from '../lib/subgraphExtractor';
import { Folders, TrendingUpDown, ChevronRight, Share2, Database, DatabaseZap } from 'lucide-react';
import { fileRegistry } from '../contexts/TabContext';
import toast from 'react-hot-toast';

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
  
  // Get selected nodes
  const selectedNodes = nodes.filter(n => n.selected || n.id === nodeId || n.data?.id === nodeId);
  // Use data.id (human-readable ID) for hide operations, as that's what the graph schema uses
  const selectedNodeIds = selectedNodes.map(n => n.data?.id).filter(Boolean) as string[];
  const allHidden = selectedNodeIds.length > 0 && selectedNodeIds.every(id => activeTabId && tabOperations.isNodeHidden(activeTabId, id));
  const isMultiSelect = selectedNodeIds.length > 1;
  
  // Check if node has connected node file (file must actually exist for "Get from file")
  const hasNodeFile = nodeData?.id ? !!fileRegistry.getFile(`node-${nodeData.id}`) : false;
  
  // Check if node can put to file (file exists OR node.id exists - can create file)
  const canPutNodeToFile = !!nodeData?.id;
  
  // Check if it's a case node (node.case object exists)
  const isCaseNode = !!nodeData?.case;
  const hasCaseFile = !!nodeData?.case?.id; // case.id is the reference to the case file
  
  // Check if case file has connection (for "Get from Source")
  const getCaseConnectionName = (): string | undefined => {
    if (nodeData?.case?.connection) return nodeData.case.connection;
    if (nodeData?.case?.id) {
      const file = fileRegistry.getFile(`case-${nodeData.case.id}`);
      return file?.data?.connection;
    }
    return undefined;
  };
  const caseConnectionName = getCaseConnectionName();
  const hasCaseConnection = hasCaseFile && (() => {
    const file = fileRegistry.getFile(`case-${nodeData?.case?.id}`);
    return !!file?.data?.connection;
  })();
  const hasCaseDirectConnection = !!nodeData?.case?.connection && !hasCaseFile;
  
  const hasAnyFile = hasNodeFile || hasCaseFile || canPutNodeToFile;

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
    if (!nodeData?.case?.connection && !hasCaseConnection) {
      toast.error('No connection configured for case');
      return;
    }
    
    // For cases, getFromSourceDirect is not yet fully implemented
    // Show a message for now
    toast('Case "Get from Source (direct)" coming soon!', { icon: 'ℹ️', duration: 3000 });
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
      window: undefined
    });
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

  return (
    <div
      style={{
        position: 'fixed',
        left: x,
        top: y,
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

      {/* Data operations (if any files connected) */}
      {hasAnyFile && (
        <>
          <div style={{ height: '1px', background: '#eee', margin: '8px 0' }} />
          
          {/* Node file submenu */}
          {canPutNodeToFile && (
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => setOpenSubmenu('node')}
              onMouseLeave={() => setOpenSubmenu(null)}
            >
              <div
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  borderRadius: '2px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: openSubmenu === 'node' ? '#f8f9fa' : 'white'
                }}
              >
                <span>Node file</span>
                <ChevronRight size={14} style={{ color: '#666' }} />
              </div>
              
              {openSubmenu === 'node' && (
                <div
                  style={{
                    position: 'absolute',
                    left: '100%',
                    top: 0,
                    background: 'white',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    minWidth: '200px',
                    padding: '4px',
                    zIndex: 10001,
                    marginLeft: '4px',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {hasNodeFile && (
                    <div
                      onClick={handleGetNodeFromFile}
                      style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        borderRadius: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                    >
                      <span>Get data from file</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                        <Folders size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                        <TrendingUpDown size={12} />
                      </div>
                    </div>
                  )}
                  <div
                    onClick={handlePutNodeToFile}
                    style={{
                      padding: '6px 12px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      borderRadius: '2px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '16px'
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                  >
                    <span>Put data to file</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                      <TrendingUpDown size={12} />
                      <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                      <Folders size={12} />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Case file submenu */}
          {isCaseNode && hasCaseFile && (
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => setOpenSubmenu('case')}
              onMouseLeave={() => setOpenSubmenu(null)}
            >
              <div
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  borderRadius: '2px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: openSubmenu === 'case' ? '#f8f9fa' : 'white'
                }}
              >
                <span>Case file</span>
                <ChevronRight size={14} style={{ color: '#666' }} />
              </div>
              
              {openSubmenu === 'case' && (
                <div
                  style={{
                    position: 'absolute',
                    left: '100%',
                    top: 0,
                    background: 'white',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    minWidth: '200px',
                    padding: '4px',
                    zIndex: 10001,
                    marginLeft: '4px',
                    whiteSpace: 'nowrap'
                  }}
                  >
                  {/* Show "Get from Source (direct)" if there's ANY connection (direct OR file) */}
                  {(hasCaseConnection || hasCaseDirectConnection) && (
                    <div
                      onClick={handleGetCaseFromSourceDirect}
                      style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        borderRadius: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                    >
                      <span>Get from Source (direct){caseConnectionName ? ` (${caseConnectionName})` : ''}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                        <Database size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                        <TrendingUpDown size={12} />
                      </div>
                    </div>
                  )}
                  {/* Show "Get from Source" (versioned) if there's a case file with connection */}
                  {hasCaseConnection && (
                    <div
                      onClick={handleGetCaseFromSourceVersioned}
                      style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        borderRadius: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                    >
                      <span>Get from Source{caseConnectionName ? ` (${caseConnectionName})` : ''}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                        <DatabaseZap size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                        <Folders size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>+</span>
                        <TrendingUpDown size={12} />
                      </div>
                    </div>
                  )}
                  {/* Show file operations if there's a case file */}
                  {hasCaseFile && (
                    <>
                      <div
                        onClick={handleGetCaseFromFile}
                        style={{
                          padding: '6px 12px',
                          cursor: 'pointer',
                          fontSize: '13px',
                          borderRadius: '2px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '16px'
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                      >
                        <span>Get data from file</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                          <Folders size={12} />
                          <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                          <TrendingUpDown size={12} />
                        </div>
                      </div>
                      <div
                        onClick={handlePutCaseToFile}
                        style={{
                          padding: '6px 12px',
                          cursor: 'pointer',
                          fontSize: '13px',
                          borderRadius: '2px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '16px'
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                      >
                        <span>Put data to file</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                          <TrendingUpDown size={12} />
                          <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                          <Folders size={12} />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Show in new graph (multi-select only) */}
      {isMultiSelect && (
        <>
          <div style={{ height: '1px', background: '#eee', margin: '4px 0' }} />
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
