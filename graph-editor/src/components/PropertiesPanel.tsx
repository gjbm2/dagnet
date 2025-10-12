import React, { useState, useCallback, useEffect } from 'react';
import { useGraphStore } from '@/lib/useGraphStore';

interface PropertiesPanelProps {
  selectedNodeId: string | null;
  onSelectedNodeChange: (id: string | null) => void;
  selectedEdgeId: string | null;
  onSelectedEdgeChange: (id: string | null) => void;
}

export default function PropertiesPanel({ 
  selectedNodeId, 
  onSelectedNodeChange, 
  selectedEdgeId, 
  onSelectedEdgeChange 
}: PropertiesPanelProps) {
  const { graph, setGraph } = useGraphStore();
  const [activeTab, setActiveTab] = useState<'graph' | 'node' | 'edge' | 'json'>('graph');
  
  // Local state for form inputs to prevent eager updates
  const [localNodeData, setLocalNodeData] = useState<any>({});
  const [localEdgeData, setLocalEdgeData] = useState<any>({});

  // Auto-switch tabs based on selection
  useEffect(() => {
    if (selectedNodeId) {
      setActiveTab('node');
    } else if (selectedEdgeId) {
      setActiveTab('edge');
    } else {
      setActiveTab('graph');
    }
  }, [selectedNodeId, selectedEdgeId]);

  // Load local data when selection changes
  useEffect(() => {
    if (selectedNodeId && graph) {
      const node = graph.nodes.find((n: any) => n.id === selectedNodeId);
      if (node) {
        setLocalNodeData({
          label: node.label || '',
          slug: node.slug || '',
          description: node.description || '',
          absorbing: node.absorbing || false,
          entry: node.entry || {},
        });
      }
    }
  }, [selectedNodeId, graph]);

  useEffect(() => {
    if (selectedEdgeId && graph) {
      const edge = graph.edges.find((e: any) => 
        e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
      );
      if (edge) {
        setLocalEdgeData({
          probability: edge.p?.mean || 0,
          description: edge.description || '',
        });
      }
    }
  }, [selectedEdgeId, graph]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedEdgeId && activeTab === 'edge') {
          e.preventDefault();
          if (confirm('Delete this edge?')) {
            const next = structuredClone(graph);
            next.edges = next.edges.filter((e: any) => 
              e.id !== selectedEdgeId && `${e.from}->${e.to}` !== selectedEdgeId
            );
            setGraph(next);
            onSelectedEdgeChange(null);
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedEdgeId, activeTab, graph, setGraph, onSelectedEdgeChange]);

  const updateGraph = useCallback((path: string[], value: any) => {
    if (!graph) return;
    const next = structuredClone(graph);
    let cur: any = next;
    for (let i = 0; i < path.length - 1; i++) {
      cur = cur[path[i]];
    }
    cur[path[path.length - 1]] = value;
    if (next.metadata) {
      next.metadata.updated_at = new Date().toISOString();
    }
    setGraph(next);
  }, [graph, setGraph]);

  const updateNode = useCallback((field: string, value: any) => {
    if (!graph || !selectedNodeId) return;
    const next = structuredClone(graph);
    const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
    if (nodeIndex >= 0) {
      next.nodes[nodeIndex][field] = value;
      if (next.metadata) {
        next.metadata.updated_at = new Date().toISOString();
      }
      setGraph(next);
    }
  }, [selectedNodeId, graph, setGraph]);

  const updateEdge = useCallback((field: string, value: any) => {
    if (!graph || !selectedEdgeId) return;
    const next = structuredClone(graph);
    const edgeIndex = next.edges.findIndex((e: any) => 
      e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
    );
    if (edgeIndex >= 0) {
      if (field === 'probability') {
        next.edges[edgeIndex].p = { ...next.edges[edgeIndex].p, mean: value };
      } else {
        next.edges[edgeIndex][field] = value;
      }
      if (next.metadata) {
        next.metadata.updated_at = new Date().toISOString();
      }
      setGraph(next);
    }
  }, [selectedEdgeId, graph, setGraph]);

  if (!graph) return null;

  const selectedNode = graph.nodes.find((n: any) => n.id === selectedNodeId);
  const selectedEdge = graph.edges.find((e: any) => 
    e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
  );

  return (
    <div style={{ 
      height: '100%', 
      display: 'flex', 
      flexDirection: 'column',
      background: '#fff',
      borderLeft: '1px solid #e9ecef'
    }}>
      {/* Header */}
      <div style={{ padding: '16px', borderBottom: '1px solid #e9ecef', background: '#f8f9fa' }}>
        <h3 style={{ margin: 0, fontSize: '18px' }}>Properties</h3>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e9ecef', background: '#f8f9fa' }}>
        {['graph', 'node', 'edge', 'json'].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab as any)}
            style={{
              flex: 1,
              padding: '12px',
              border: 'none',
              background: activeTab === tab ? '#fff' : 'transparent',
              borderBottom: activeTab === tab ? '2px solid #007bff' : '2px solid transparent',
              cursor: 'pointer',
              textTransform: 'capitalize',
              fontSize: '12px',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: '16px', overflow: 'auto' }}>
        {activeTab === 'graph' && (
          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>
              Version
            </label>
            <input
              value={graph.metadata?.version || ''}
              onChange={(e) => updateGraph(['metadata', 'version'], e.target.value)}
              style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
            />
          </div>
        )}

        {activeTab === 'node' && (
          <div>
            {selectedNode ? (
              <div>
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Label</label>
                  <input
                    value={localNodeData.label || ''}
                    onChange={(e) => setLocalNodeData({...localNodeData, label: e.target.value})}
                    onBlur={() => updateNode('label', localNodeData.label)}
                    onKeyDown={(e) => e.key === 'Enter' && updateNode('label', localNodeData.label)}
                    style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
                  />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Slug</label>
                  <input
                    value={localNodeData.slug || ''}
                    onChange={(e) => setLocalNodeData({...localNodeData, slug: e.target.value})}
                    onBlur={() => updateNode('slug', localNodeData.slug)}
                    onKeyDown={(e) => e.key === 'Enter' && updateNode('slug', localNodeData.slug)}
                    style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
                  />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={localNodeData.absorbing || false}
                      onChange={(e) => {
                        const newValue = e.target.checked;
                        setLocalNodeData({...localNodeData, absorbing: newValue});
                        updateNode('absorbing', newValue);
                      }}
                    />
                    <span>Terminal Node</span>
                  </label>
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.entry?.is_start)}
                      onChange={(e) => {
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                        if (nodeIndex >= 0) {
                          next.nodes[nodeIndex].entry = {
                            ...(next.nodes[nodeIndex].entry || {}),
                            is_start: e.target.checked,
                          };
                          if (next.metadata) {
                            next.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(next);
                        }
                      }}
                    />
                    <span>Start Node</span>
                  </label>
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Entry Weight</label>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={selectedNode.entry?.entry_weight ?? ''}
                    onChange={(e) => {
                      const val = e.target.value === '' ? undefined : parseFloat(e.target.value);
                      const next = structuredClone(graph);
                      const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                      if (nodeIndex >= 0) {
                        next.nodes[nodeIndex].entry = {
                          ...(next.nodes[nodeIndex].entry || {}),
                          entry_weight: val,
                        };
                        if (next.metadata) {
                          next.metadata.updated_at = new Date().toISOString();
                        }
                        setGraph(next);
                      }
                    }}
                    placeholder="e.g. 1.0"
                    style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
                  />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Description</label>
                  <textarea
                    value={localNodeData.description || ''}
                    onChange={(e) => setLocalNodeData({...localNodeData, description: e.target.value})}
                    onBlur={() => updateNode('description', localNodeData.description)}
                    style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px', minHeight: '60px' }}
                  />
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: '#666', padding: '20px' }}>
                No node selected
              </div>
            )}
          </div>
        )}

        {activeTab === 'edge' && (
          <div>
            {selectedEdge ? (
              <div>
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Probability</label>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={localEdgeData.probability || 0}
                    onChange={(e) => setLocalEdgeData({...localEdgeData, probability: parseFloat(e.target.value) || 0})}
                    onBlur={() => updateEdge('probability', localEdgeData.probability)}
                    onKeyDown={(e) => e.key === 'Enter' && updateEdge('probability', localEdgeData.probability)}
                    style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
                  />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Description</label>
                  <textarea
                    value={localEdgeData.description || ''}
                    onChange={(e) => setLocalEdgeData({...localEdgeData, description: e.target.value})}
                    onBlur={() => updateEdge('description', localEdgeData.description)}
                    style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px', minHeight: '60px' }}
                  />
                </div>

                <button
                  onClick={() => {
                    if (confirm('Delete this edge?')) {
                      const next = structuredClone(graph);
                      next.edges = next.edges.filter((e: any) => 
                        e.id !== selectedEdgeId && `${e.from}->${e.to}` !== selectedEdgeId
                      );
                      setGraph(next);
                      onSelectedEdgeChange(null);
                    }
                  }}
                  style={{
                    width: '100%',
                    padding: '8px 16px',
                    background: '#dc3545',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    fontWeight: '500',
                  }}
                >
                  Delete Edge
                </button>
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: '#666', padding: '20px' }}>
                No edge selected
              </div>
            )}
          </div>
        )}

        {activeTab === 'json' && (
          <div>
            <div style={{ marginBottom: '12px', fontSize: '12px', color: '#666' }}>
              Current graph JSON (read-only):
            </div>
            <pre style={{ 
              background: '#f8f9fa', 
              padding: '12px', 
              borderRadius: '4px', 
              fontSize: '11px',
              overflow: 'auto',
              maxHeight: 'calc(100vh - 250px)',
              border: '1px solid #e9ecef',
              fontFamily: 'monospace',
              lineHeight: '1.5',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all'
            }}>
              {JSON.stringify(graph, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
