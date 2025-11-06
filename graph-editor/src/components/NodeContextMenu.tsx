/**
 * Node Context Menu Component
 * 
 * Context menu for graph nodes with data operations (Get/Put)
 */

import React, { useState } from 'react';
import { dataOperationsService } from '../services/dataOperationsService';
import { Folders, TrendingUpDown, ChevronRight } from 'lucide-react';

interface NodeContextMenuProps {
  x: number;
  y: number;
  nodeId: string;
  nodeData: any;
  nodes: any[];
  activeTabId: string | null;
  tabOperations: any;
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
  
  // Check if node has connected node file
  const hasNodeFile = !!nodeData?.id; // Has node_id connection
  
  // Check if it's a case node (node.case object exists)
  const isCaseNode = !!nodeData?.case;
  const hasCaseFile = !!nodeData?.case?.id; // case.id is the reference to the case file
  
  const hasAnyFile = hasNodeFile || hasCaseFile;

  const handleGetNodeFromFile = () => {
    if (nodeData?.id) {
      dataOperationsService.getNodeFromFile({ nodeId: nodeData.id });
    }
    onClose();
  };

  const handlePutNodeToFile = () => {
    if (nodeData?.id) {
      dataOperationsService.putNodeToFile({ nodeId: nodeData.id });
    }
    onClose();
  };

  const handleGetCaseFromFile = () => {
    if (nodeData?.case?.id) {
      dataOperationsService.getCaseFromFile({ caseId: nodeData.case.id, nodeId });
    }
    onClose();
  };

  const handlePutCaseToFile = () => {
    if (nodeData?.case?.id) {
      dataOperationsService.putCaseToFile({ caseId: nodeData.case.id, nodeId });
    }
    onClose();
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
          {hasNodeFile && (
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
                </div>
              )}
            </div>
          )}
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
