import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useGraphStore } from '@/lib/useGraphStore';
import { generateSlugFromLabel, generateUniqueSlug } from '@/lib/slugUtils';

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
  
  // Track if user has manually edited the slug to prevent auto-generation
  const [slugManuallyEdited, setSlugManuallyEdited] = useState<boolean>(false);
  
  // Track if this node has ever had its label committed (to prevent slug regeneration)
  const hasLabelBeenCommittedRef = useRef<{ [nodeId: string]: boolean }>({});
  
  // JSON edit modal state
  const [showJsonEdit, setShowJsonEdit] = useState(false);
  const [jsonEditContent, setJsonEditContent] = useState('');
  const [jsonEditError, setJsonEditError] = useState<string | null>(null);

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

  // Track the last loaded node to prevent reloading on every graph change
  const lastLoadedNodeRef = useRef<string | null>(null);
  
  // Load local data when selection changes (but not on every graph update)
  useEffect(() => {
    if (selectedNodeId && graph) {
      // Only reload if we're switching to a different node
      if (lastLoadedNodeRef.current !== selectedNodeId) {
        const node = graph.nodes.find((n: any) => n.id === selectedNodeId);
        if (node) {
          setLocalNodeData({
            label: node.label || '',
            slug: node.slug || '',
            description: node.description || '',
            absorbing: node.absorbing || false,
            outcome_type: node.outcome_type,
            tags: node.tags || [],
            entry: node.entry || {},
          });
          // Reset manual edit flag when switching to a different node
          setSlugManuallyEdited(false);
          lastLoadedNodeRef.current = selectedNodeId;
        }
      }
    } else if (!selectedNodeId) {
      // Clear the ref when no node is selected
      lastLoadedNodeRef.current = null;
    }
  }, [selectedNodeId, graph]);

  // Auto-generate slug from label when label changes (only on FIRST commit)
  // This updates the LOCAL state only, not the graph state
  useEffect(() => {
    if (selectedNodeId && graph && localNodeData.label && !slugManuallyEdited) {
      // Check if this node has already had its label committed
      if (hasLabelBeenCommittedRef.current[selectedNodeId]) {
        // Slug is now immutable, don't regenerate
        return;
      }
      
      // Check if the node actually exists in the graph to prevent race conditions
      const nodeExists = graph.nodes.some((n: any) => n.id === selectedNodeId);
      if (!nodeExists) {
        return;
      }
      
      const baseSlug = generateSlugFromLabel(localNodeData.label);
      if (baseSlug && baseSlug !== localNodeData.slug) {
        // Get all existing slugs (excluding current node)
        const existingSlugs = graph.nodes
          .filter((n: any) => n.id !== selectedNodeId)
          .map((n: any) => n.slug)
          .filter(Boolean);
        
        const uniqueSlug = generateUniqueSlug(baseSlug, existingSlugs);
        
        // Only update LOCAL state if the slug is actually different
        if (uniqueSlug !== localNodeData.slug) {
          setLocalNodeData(prev => ({
            ...prev,
            slug: uniqueSlug
          }));
        }
      }
    }
  }, [localNodeData.label, selectedNodeId, graph, slugManuallyEdited]);

  // Track the last loaded edge to prevent reloading on every graph change
  const lastLoadedEdgeRef = useRef<string | null>(null);
  
  useEffect(() => {
    if (selectedEdgeId && graph) {
      // Only reload if we're switching to a different edge
      if (lastLoadedEdgeRef.current !== selectedEdgeId) {
        const edge = graph.edges.find((e: any) => 
          e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
        );
        if (edge) {
          setLocalEdgeData({
            slug: edge.slug || '',
            probability: edge.p?.mean || 0,
            stdev: edge.p?.stdev || 0,
            locked: edge.p?.locked || false,
            description: edge.description || '',
            costs: edge.costs || {},
            weight_default: edge.weight_default || 0,
          });
          lastLoadedEdgeRef.current = selectedEdgeId;
        }
      }
    } else if (!selectedEdgeId) {
      // Clear the ref when no edge is selected
      lastLoadedEdgeRef.current = null;
    }
  }, [selectedEdgeId, graph]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts when user is typing in form fields
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      
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
      } else if (field === 'stdev') {
        next.edges[edgeIndex].p = { ...next.edges[edgeIndex].p, stdev: value };
      } else if (field === 'locked') {
        next.edges[edgeIndex].p = { ...next.edges[edgeIndex].p, locked: value };
      } else if (field.startsWith('costs.')) {
        const costField = field.split('.')[1];
        if (!next.edges[edgeIndex].costs) next.edges[edgeIndex].costs = {};
        next.edges[edgeIndex].costs[costField] = value;
      } else {
        next.edges[edgeIndex][field] = value;
      }
      if (next.metadata) {
        next.metadata.updated_at = new Date().toISOString();
      }
      setGraph(next);
    }
  }, [selectedEdgeId, graph, setGraph]);

  // JSON edit functions
  const openJsonEdit = useCallback(() => {
    setJsonEditContent(JSON.stringify(graph, null, 2));
    setJsonEditError(null);
    setShowJsonEdit(true);
  }, [graph]);

  const closeJsonEdit = useCallback(() => {
    setShowJsonEdit(false);
    setJsonEditContent('');
    setJsonEditError(null);
  }, []);

  const applyJsonEdit = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonEditContent);
      
      // Basic validation - check required fields
      if (!parsed.nodes || !Array.isArray(parsed.nodes)) {
        throw new Error('Missing or invalid "nodes" array');
      }
      if (!parsed.edges || !Array.isArray(parsed.edges)) {
        throw new Error('Missing or invalid "edges" array');
      }
      if (!parsed.policies || typeof parsed.policies !== 'object') {
        throw new Error('Missing or invalid "policies" object');
      }
      if (!parsed.metadata || typeof parsed.metadata !== 'object') {
        throw new Error('Missing or invalid "metadata" object');
      }
      
      // Validate nodes have required fields
      for (let i = 0; i < parsed.nodes.length; i++) {
        const node = parsed.nodes[i];
        if (!node.id || !node.slug) {
          throw new Error(`Node ${i} missing required "id" or "slug" field`);
        }
      }
      
      // Validate edges have required fields
      for (let i = 0; i < parsed.edges.length; i++) {
        const edge = parsed.edges[i];
        if (!edge.id || !edge.from || !edge.to) {
          throw new Error(`Edge ${i} missing required "id", "from", or "to" field`);
        }
      }
      
      setGraph(parsed);
      closeJsonEdit();
    } catch (error) {
      setJsonEditError(error instanceof Error ? error.message : 'Invalid JSON');
    }
  }, [jsonEditContent, setGraph, closeJsonEdit]);

  if (!graph) return null;

  // Add null checks to prevent crashes when nodes/edges are deleted
  const selectedNode = selectedNodeId && graph.nodes ? graph.nodes.find((n: any) => n.id === selectedNodeId) : null;
  const selectedEdge = selectedEdgeId && graph.edges ? graph.edges.find((e: any) => 
    e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
  ) : null;

  return (
    <div style={{ 
      height: '100%', 
      display: 'flex', 
      flexDirection: 'column',
      background: '#fff',
      borderLeft: '1px solid #e9ecef',
      width: '350px',
      minWidth: '350px',
      maxWidth: '350px',
      boxSizing: 'border-box'
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
      <div style={{ 
        flex: 1, 
        padding: '12px', 
        overflow: 'auto',
        boxSizing: 'border-box',
        width: '100%'
      }}>
        {activeTab === 'graph' && (
          <div>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>
                Description
              </label>
              <textarea
                value={graph.metadata?.description || ''}
                onChange={(e) => updateGraph(['metadata', 'description'], e.target.value)}
                placeholder="Enter graph description..."
                style={{ 
                  width: '100%', 
                  padding: '8px', 
                  border: '1px solid #ddd', 
                  borderRadius: '4px',
                  boxSizing: 'border-box',
                  minHeight: '60px',
                  resize: 'vertical'
                }}
              />
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>
                Version
              </label>
              <input
                value={graph.metadata?.version || ''}
                onChange={(e) => updateGraph(['metadata', 'version'], e.target.value)}
                placeholder="1.0.0"
                style={{ 
                  width: '100%', 
                  padding: '8px', 
                  border: '1px solid #ddd', 
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>
                Author
              </label>
              <input
                value={graph.metadata?.author || ''}
                onChange={(e) => updateGraph(['metadata', 'author'], e.target.value)}
                placeholder="Your name"
                style={{ 
                  width: '100%', 
                  padding: '8px', 
                  border: '1px solid #ddd', 
                  borderRadius: '4px',
                  boxSizing: 'border-box'
                }}
              />
            </div>
          </div>
        )}

        {activeTab === 'node' && (
          <div>
            {selectedNode ? (
              <div>
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Label</label>
                  <input
                    data-field="label"
                    value={localNodeData.label || ''}
                    onChange={(e) => setLocalNodeData({...localNodeData, label: e.target.value})}
                    onBlur={() => {
                      // Update both label and slug in a single graph update to avoid race conditions
                      if (!graph || !selectedNodeId) return;
                      const next = structuredClone(graph);
                      const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                      if (nodeIndex >= 0) {
                        next.nodes[nodeIndex].label = localNodeData.label;
                        // Also update slug if it was auto-generated (ONLY on first commit)
                        if (!slugManuallyEdited && localNodeData.slug && !hasLabelBeenCommittedRef.current[selectedNodeId]) {
                          next.nodes[nodeIndex].slug = localNodeData.slug;
                        }
                        // Mark this node's label as committed (slug is now immutable)
                        hasLabelBeenCommittedRef.current[selectedNodeId] = true;
                        if (next.metadata) {
                          next.metadata.updated_at = new Date().toISOString();
                        }
                        setGraph(next);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        // Update both label and slug in a single graph update to avoid race conditions
                        if (!graph || !selectedNodeId) return;
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                        if (nodeIndex >= 0) {
                          next.nodes[nodeIndex].label = localNodeData.label;
                          // Also update slug if it was auto-generated (ONLY on first commit)
                          if (!slugManuallyEdited && localNodeData.slug && !hasLabelBeenCommittedRef.current[selectedNodeId]) {
                            next.nodes[nodeIndex].slug = localNodeData.slug;
                          }
                          // Mark this node's label as committed (slug is now immutable)
                          hasLabelBeenCommittedRef.current[selectedNodeId] = true;
                          if (next.metadata) {
                            next.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(next);
                        }
                      }
                    }}
                    style={{ 
                      width: '100%', 
                      padding: '8px', 
                      border: '1px solid #ddd', 
                      borderRadius: '4px',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Slug</label>
                  <input
                    data-field="slug"
                    value={localNodeData.slug || ''}
                    onChange={(e) => {
                      setLocalNodeData({...localNodeData, slug: e.target.value});
                      setSlugManuallyEdited(true); // Mark as manually edited
                    }}
                    onBlur={() => updateNode('slug', localNodeData.slug)}
                    onKeyDown={(e) => e.key === 'Enter' && updateNode('slug', localNodeData.slug)}
                    style={{ 
                      width: '100%', 
                      padding: '8px', 
                      border: '1px solid #ddd', 
                      borderRadius: '4px',
                      boxSizing: 'border-box'
                    }}
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
                    style={{ 
                      width: '100%', 
                      padding: '8px', 
                      border: '1px solid #ddd', 
                      borderRadius: '4px',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Outcome Type</label>
                  <select
                    value={localNodeData.outcome_type || ''}
                    onChange={(e) => {
                      const newValue = e.target.value === '' ? undefined : e.target.value;
                      setLocalNodeData({...localNodeData, outcome_type: newValue});
                      updateNode('outcome_type', newValue);
                    }}
                    style={{ 
                      width: '100%', 
                      padding: '8px', 
                      border: '1px solid #ddd', 
                      borderRadius: '4px',
                      boxSizing: 'border-box'
                    }}
                  >
                    <option value="">None</option>
                    <option value="success">Success</option>
                    <option value="failure">Failure</option>
                    <option value="error">Error</option>
                    <option value="neutral">Neutral</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Tags</label>
                  <input
                    value={localNodeData.tags?.join(', ') || ''}
                    onChange={(e) => setLocalNodeData({
                      ...localNodeData, 
                      tags: e.target.value.split(',').map(t => t.trim()).filter(t => t)
                    })}
                    onBlur={() => updateNode('tags', localNodeData.tags)}
                    placeholder="tag1, tag2, tag3"
                    style={{ 
                      width: '100%', 
                      padding: '8px', 
                      border: '1px solid #ddd', 
                      borderRadius: '4px',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Description</label>
                  <textarea
                    data-field="description"
                    value={localNodeData.description || ''}
                    onChange={(e) => setLocalNodeData({...localNodeData, description: e.target.value})}
                    onBlur={() => updateNode('description', localNodeData.description)}
                    style={{ 
                      width: '100%', 
                      padding: '8px', 
                      border: '1px solid #ddd', 
                      borderRadius: '4px', 
                      minHeight: '60px',
                      boxSizing: 'border-box'
                    }}
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
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Slug</label>
                  <input
                    data-field="slug"
                    value={localEdgeData.slug || ''}
                    onChange={(e) => setLocalEdgeData({...localEdgeData, slug: e.target.value})}
                    onBlur={() => updateEdge('slug', localEdgeData.slug)}
                    onKeyDown={(e) => e.key === 'Enter' && updateEdge('slug', localEdgeData.slug)}
                    placeholder="edge-slug"
                    style={{ 
                      width: '100%', 
                      padding: '8px', 
                      border: '1px solid #ddd', 
                      borderRadius: '4px',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Probability</label>
                  <input
                    data-field="probability"
                    type="text"
                    value={localEdgeData.probability || 0}
                    onChange={(e) => {
                      const value = e.target.value;
                      setLocalEdgeData({...localEdgeData, probability: value});
                    }}
                    onBlur={() => {
                      const numValue = parseFloat(localEdgeData.probability) || 0;
                      setLocalEdgeData({...localEdgeData, probability: numValue});
                      updateEdge('probability', numValue);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const numValue = parseFloat(localEdgeData.probability) || 0;
                        setLocalEdgeData({...localEdgeData, probability: numValue});
                        updateEdge('probability', numValue);
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder="0.0"
                    style={{ 
                      width: '100%', 
                      padding: '8px', 
                      border: '1px solid #ddd', 
                      borderRadius: '4px',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Standard Deviation</label>
                  <input
                    data-field="stdev"
                    type="text"
                    value={localEdgeData.stdev || 0}
                    onChange={(e) => {
                      const value = e.target.value;
                      setLocalEdgeData({...localEdgeData, stdev: value});
                    }}
                    onBlur={() => {
                      const numValue = parseFloat(localEdgeData.stdev) || 0;
                      setLocalEdgeData({...localEdgeData, stdev: numValue});
                      updateEdge('stdev', numValue);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const numValue = parseFloat(localEdgeData.stdev) || 0;
                        setLocalEdgeData({...localEdgeData, stdev: numValue});
                        updateEdge('stdev', numValue);
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder="Optional"
                    style={{ 
                      width: '100%', 
                      padding: '8px', 
                      border: '1px solid #ddd', 
                      borderRadius: '4px',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={localEdgeData.locked || false}
                      onChange={(e) => {
                        const newValue = e.target.checked;
                        setLocalEdgeData({...localEdgeData, locked: newValue});
                        updateEdge('locked', newValue);
                      }}
                    />
                    <span>Locked Probability</span>
                  </label>
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Weight Default</label>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={localEdgeData.weight_default || 0}
                    onChange={(e) => setLocalEdgeData({...localEdgeData, weight_default: parseFloat(e.target.value) || 0})}
                    onBlur={() => updateEdge('weight_default', localEdgeData.weight_default)}
                    onKeyDown={(e) => e.key === 'Enter' && updateEdge('weight_default', localEdgeData.weight_default)}
                    placeholder="For residual distribution"
                    style={{ 
                      width: '100%', 
                      padding: '8px', 
                      border: '1px solid #ddd', 
                      borderRadius: '4px',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Costs</label>
                  
                  <div style={{ 
                    background: '#f8f9fa', 
                    padding: '12px', 
                    borderRadius: '4px', 
                    border: '1px solid #e9ecef',
                    marginBottom: '12px'
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px', color: '#666', fontWeight: '500' }}>Monetary Cost</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={localEdgeData.costs?.monetary || ''}
                          onChange={(e) => setLocalEdgeData({
                            ...localEdgeData, 
                            costs: {...localEdgeData.costs, monetary: parseFloat(e.target.value) || undefined}
                          })}
                          onBlur={() => updateEdge('costs.monetary', localEdgeData.costs?.monetary)}
                          placeholder="0.00"
                          style={{ 
                            width: '100%', 
                            padding: '6px 8px', 
                            border: '1px solid #ddd', 
                            borderRadius: '3px', 
                            fontSize: '12px',
                            boxSizing: 'border-box'
                          }}
                        />
                      </div>
                      
                      <div>
                        <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px', color: '#666', fontWeight: '500' }}>Time Cost</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={localEdgeData.costs?.time || ''}
                          onChange={(e) => setLocalEdgeData({
                            ...localEdgeData, 
                            costs: {...localEdgeData.costs, time: parseFloat(e.target.value) || undefined}
                          })}
                          onBlur={() => updateEdge('costs.time', localEdgeData.costs?.time)}
                          placeholder="0.00"
                          style={{ 
                            width: '100%', 
                            padding: '6px 8px', 
                            border: '1px solid #ddd', 
                            borderRadius: '3px', 
                            fontSize: '12px',
                            boxSizing: 'border-box'
                          }}
                        />
                      </div>
                      
                      <div>
                        <label style={{ display: 'block', fontSize: '11px', marginBottom: '4px', color: '#666', fontWeight: '500' }}>Units</label>
                        <input
                          type="text"
                          maxLength={32}
                          value={localEdgeData.costs?.units || ''}
                          onChange={(e) => setLocalEdgeData({
                            ...localEdgeData, 
                            costs: {...localEdgeData.costs, units: e.target.value}
                          })}
                          onBlur={() => updateEdge('costs.units', localEdgeData.costs?.units)}
                          placeholder="GBP, hours, etc."
                          style={{ 
                            width: '100%', 
                            padding: '6px 8px', 
                            border: '1px solid #ddd', 
                            borderRadius: '3px', 
                            fontSize: '12px',
                            boxSizing: 'border-box'
                          }}
                        />
                      </div>
                    </div>
                    
                    {/* Clear costs button */}
                    {(localEdgeData.costs?.monetary || localEdgeData.costs?.time || localEdgeData.costs?.units) && (
                      <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #e9ecef' }}>
                        <button
                          onClick={() => {
                            const clearedCosts = {};
                            setLocalEdgeData({
                              ...localEdgeData,
                              costs: clearedCosts
                            });
                            // Update the graph with cleared costs
                            if (!graph || !selectedEdgeId) return;
                            const next = structuredClone(graph);
                            const edgeIndex = next.edges.findIndex((e: any) => 
                              e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                            );
                            if (edgeIndex >= 0) {
                              next.edges[edgeIndex].costs = clearedCosts;
                              if (next.metadata) {
                                next.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(next);
                            }
                          }}
                          style={{
                            background: '#dc3545',
                            color: 'white',
                            border: 'none',
                            borderRadius: '3px',
                            padding: '4px 8px',
                            fontSize: '11px',
                            cursor: 'pointer'
                          }}
                        >
                          Clear All Costs
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Description</label>
                  <textarea
                    data-field="description"
                    value={localEdgeData.description || ''}
                    onChange={(e) => setLocalEdgeData({...localEdgeData, description: e.target.value})}
                    onBlur={() => updateEdge('description', localEdgeData.description)}
                    style={{ 
                      width: '100%', 
                      padding: '8px', 
                      border: '1px solid #ddd', 
                      borderRadius: '4px', 
                      minHeight: '60px',
                      boxSizing: 'border-box'
                    }}
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
            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              alignItems: 'center',
              marginBottom: '12px' 
            }}>
              <div style={{ fontSize: '12px', color: '#666' }}>
                Current graph JSON:
              </div>
              <button
                onClick={openJsonEdit}
                style={{
                  background: '#007bff',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  cursor: 'pointer'
                }}
              >
                Edit JSON
              </button>
            </div>
            <pre style={{ 
              background: '#f8f9fa', 
              padding: '12px', 
              borderRadius: '4px', 
              fontSize: '11px',
              overflow: 'auto',
              maxHeight: 'calc(100vh - 300px)',
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

      {/* JSON Edit Modal */}
      {showJsonEdit && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            background: 'white',
            borderRadius: '8px',
            padding: '20px',
            width: '80%',
            maxWidth: '800px',
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '16px'
            }}>
              <h3 style={{ margin: 0, fontSize: '18px' }}>Edit Graph JSON</h3>
              <button
                onClick={closeJsonEdit}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '20px',
                  cursor: 'pointer',
                  color: '#666'
                }}
              >
                ×
              </button>
            </div>
            
            {jsonEditError && (
              <div style={{
                background: '#f8d7da',
                color: '#721c24',
                padding: '8px 12px',
                borderRadius: '4px',
                marginBottom: '12px',
                fontSize: '12px'
              }}>
                Error: {jsonEditError}
              </div>
            )}
            
            <textarea
              value={jsonEditContent}
              onChange={(e) => setJsonEditContent(e.target.value)}
              style={{
                flex: 1,
                fontFamily: 'monospace',
                fontSize: '12px',
                padding: '12px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                resize: 'none',
                minHeight: '400px'
              }}
              placeholder="Paste your JSON here..."
            />
            
            <div style={{
              display: 'flex',
              gap: '8px',
              marginTop: '16px',
              justifyContent: 'flex-end'
            }}>
              <button
                onClick={closeJsonEdit}
                style={{
                  background: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '8px 16px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={applyJsonEdit}
                style={{
                  background: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '8px 16px',
                  cursor: 'pointer'
                }}
              >
                Apply Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
