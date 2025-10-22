import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useGraphStore } from '@/lib/useGraphStore';
import { generateSlugFromLabel, generateUniqueSlug } from '@/lib/slugUtils';
import ConditionalProbabilitiesSection from './ConditionalProbabilitiesSection';
import { getNextAvailableColor } from '@/lib/conditionalColors';

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
  const { graph, setGraph, whatIfAnalysis, setWhatIfAnalysis } = useGraphStore();
  const [activeTab, setActiveTab] = useState<'graph' | 'node' | 'edge' | 'json'>('graph');
  
  // Local state for form inputs to prevent eager updates
  const [localNodeData, setLocalNodeData] = useState<any>({});
  const [localEdgeData, setLocalEdgeData] = useState<any>({});
  
  // Case node state
  const [nodeType, setNodeType] = useState<'normal' | 'case'>('normal');
  const [caseMode, setCaseMode] = useState<'manual' | 'registry'>('manual');
  const [caseData, setCaseData] = useState({
    id: '',
    parameter_id: '',
    status: 'active' as 'active' | 'paused' | 'completed',
    variants: [] as Array<{ name: string; weight: number; description?: string }>
  });
  
  // Track if user has manually edited the slug to prevent auto-generation
  const [slugManuallyEdited, setSlugManuallyEdited] = useState<boolean>(false);
  
  // Track if this node has ever had its label committed (to prevent slug regeneration)
  const hasLabelBeenCommittedRef = useRef<{ [nodeId: string]: boolean }>({});
  
  // Local state for conditional probabilities (like variants)
  const [localConditionalP, setLocalConditionalP] = useState<any[]>([]);
  const lastLoadedEdgeRef = useRef<string | null>(null);
  
  // JSON edit modal state
  const [showJsonEdit, setShowJsonEdit] = useState(false);
  const [jsonEditContent, setJsonEditContent] = useState('');
  const [jsonEditError, setJsonEditError] = useState<string | null>(null);

  // Track previous selection to detect actual selection changes
  const prevSelectionRef = useRef({ nodeId: selectedNodeId, edgeId: selectedEdgeId });
  
  // Auto-switch tabs based on selection ONLY when selection actually changes
  useEffect(() => {
    const selectionChanged = 
      prevSelectionRef.current.nodeId !== selectedNodeId ||
      prevSelectionRef.current.edgeId !== selectedEdgeId;
    
    if (selectionChanged) {
      if (selectedNodeId) {
        setActiveTab('node');
      } else if (selectedEdgeId) {
        setActiveTab('edge');
      } else {
        setActiveTab('graph');
      }
      
      prevSelectionRef.current = { nodeId: selectedNodeId, edgeId: selectedEdgeId };
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
          
          // Handle case node data
          console.log('Loading node data:', node.type, node.case);
          if (node.type === 'case' && node.case) {
            console.log('Loading case node:', node.case);
            setNodeType('case');
            setCaseData({
              id: node.case.id || '',
              parameter_id: node.case.parameter_id || '',
              status: node.case.status || 'active',
              variants: node.case.variants || []
            });
            setCaseMode(node.case.parameter_id ? 'registry' : 'manual');
          } else {
            console.log('Loading normal node');
            setNodeType('normal');
            setCaseData({
              id: '',
              parameter_id: '',
              status: 'active',
              variants: []
            });
            setCaseMode('manual');
          }
          
          // Reset manual edit flag when switching to a different node
          setSlugManuallyEdited(false);
          
          // Mark node as having committed label if it already has a label
          // This prevents slug from auto-updating on subsequent label edits
          if (node.label && node.label.trim() !== '') {
            hasLabelBeenCommittedRef.current[selectedNodeId] = true;
          }
          
          lastLoadedNodeRef.current = selectedNodeId;
        }
      }
    } else if (!selectedNodeId) {
      // Clear the ref when no node is selected
      lastLoadedNodeRef.current = null;
    }
  }, [selectedNodeId, graph]);

  // Load edge data when selection changes (but not on every graph update)
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
            stdev: edge.p?.stdev || undefined,
            description: edge.description || '',
            costs: edge.costs || {},
            weight_default: edge.weight_default || 0
          });
          setLocalConditionalP(edge.conditional_p || []);
          lastLoadedEdgeRef.current = selectedEdgeId;
        }
      }
    } else if (!selectedEdgeId) {
      // Clear the ref when no edge is selected
      lastLoadedEdgeRef.current = null;
    }
  }, [selectedEdgeId, graph]);

  // Auto-generate slug from label when label changes (only on FIRST commit)
  // This updates the LOCAL state only, not the graph state
  useEffect(() => {
    if (selectedNodeId && graph && localNodeData.label && !slugManuallyEdited) {
      // Check if the node actually exists in the graph to prevent race conditions
      const nodeExists = graph.nodes.some((n: any) => n.id === selectedNodeId);
      if (!nodeExists) {
        return;
      }
      
      // For new nodes (no committed label yet), always regenerate slug
      // For existing nodes, only regenerate if label hasn't been committed yet
      const shouldRegenerateSlug = !hasLabelBeenCommittedRef.current[selectedNodeId];
      
      if (shouldRegenerateSlug) {
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
    }
  }, [localNodeData.label, selectedNodeId, graph, slugManuallyEdited]);
  
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
            if (next) {
              next.edges = next.edges.filter((e: any) => 
                e.id !== selectedEdgeId && `${e.from}->${e.to}` !== selectedEdgeId
              );
              setGraph(next);
              onSelectedEdgeChange(null);
            }
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
        if (value === undefined) {
          // Remove stdev property if undefined
          const { stdev, ...pWithoutStdev } = next.edges[edgeIndex].p || {};
          next.edges[edgeIndex].p = pWithoutStdev;
        } else {
          next.edges[edgeIndex].p = { ...next.edges[edgeIndex].p, stdev: value };
        }
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

                {/* Node Type Selector */}
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Node Type</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      onClick={() => {
                        setNodeType('normal');
                        // Clear case data when switching to normal
                        setCaseData({
                          id: '',
                          parameter_id: '',
                          status: 'active',
                          variants: []
                        });
                        setCaseMode('manual');
                        // Update graph
                        if (graph && selectedNodeId) {
                          const next = structuredClone(graph);
                          const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                          if (nodeIndex >= 0) {
                            delete next.nodes[nodeIndex].type;
                            delete next.nodes[nodeIndex].case;
                            if (next.metadata) {
                              next.metadata.updated_at = new Date().toISOString();
                            }
                            setGraph(next);
                          }
                        }
                      }}
                      style={{
                        padding: '8px 16px',
                        border: '1px solid #ddd',
                        borderRadius: '4px',
                        background: nodeType === 'normal' ? '#007bff' : '#fff',
                        color: nodeType === 'normal' ? '#fff' : '#333',
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: '600'
                      }}
                    >
                      Normal
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNodeType('case');
                        // Initialize case data if empty
                        const newCaseData = caseData.variants.length === 0 ? {
                          id: `case_${Date.now()}`,
                          parameter_id: '',
                          status: 'active' as 'active' | 'paused' | 'completed',
                          variants: [
                            { name: 'control', weight: 0.5, description: 'Control variant' },
                            { name: 'treatment', weight: 0.5, description: 'Treatment variant' }
                          ]
                        } : caseData;
                        
                        setCaseData(newCaseData);
                        
                        // Update graph
                        if (graph && selectedNodeId) {
                          const next = structuredClone(graph);
                          const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                          if (nodeIndex >= 0) {
                            console.log('Converting node to case:', selectedNodeId, newCaseData);
                            next.nodes[nodeIndex].type = 'case';
                            next.nodes[nodeIndex].case = {
                              id: newCaseData.id,
                              parameter_id: newCaseData.parameter_id,
                              status: newCaseData.status,
                              variants: newCaseData.variants
                            };
                            // Auto-assign a fresh color from the palette
                            if (!next.nodes[nodeIndex].layout) {
                              next.nodes[nodeIndex].layout = {};
                            }
                            if (!next.nodes[nodeIndex].layout!.color) {
                              next.nodes[nodeIndex].layout!.color = getNextAvailableColor(graph);
                            }
                            if (next.metadata) {
                              next.metadata.updated_at = new Date().toISOString();
                            }
                            console.log('Updated node:', next.nodes[nodeIndex]);
                            setGraph(next);
                          }
                        }
                      }}
                      style={{
                        padding: '8px 16px',
                        border: '1px solid #ddd',
                        borderRadius: '4px',
                        background: nodeType === 'case' ? '#8B5CF6' : '#fff',
                        color: nodeType === 'case' ? '#fff' : '#333',
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: '600'
                      }}
                    >
                      Case
                    </button>
                  </div>
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

                {/* Case Node Fields */}
                {nodeType === 'case' && (
                  <>
                    {/* Case Mode Selector */}
                    <div style={{ marginBottom: '20px' }}>
                      <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Mode</label>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          type="button"
                          onClick={() => setCaseMode('manual')}
                          style={{
                            padding: '8px 16px',
                            border: '1px solid #ddd',
                            borderRadius: '4px',
                            background: caseMode === 'manual' ? '#007bff' : '#fff',
                            color: caseMode === 'manual' ? '#fff' : '#333',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontWeight: '600'
                          }}
                        >
                          Manual
                        </button>
                        <button
                          type="button"
                          onClick={() => setCaseMode('registry')}
                          style={{
                            padding: '8px 16px',
                            border: '1px solid #ddd',
                            borderRadius: '4px',
                            background: caseMode === 'registry' ? '#007bff' : '#fff',
                            color: caseMode === 'registry' ? '#fff' : '#333',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontWeight: '600'
                          }}
                        >
                          Registry
                        </button>
                      </div>
                    </div>

                    {/* Quick Variant Selector - What-If Analysis */}
                    {caseData.variants.length > 0 && (() => {
                      const currentNodeColor = graph?.nodes.find((n: any) => n.id === selectedNodeId)?.layout?.color || '#e5e7eb';
                      return (
                        <div style={{ marginBottom: '20px', padding: '12px', background: '#f0f7ff', borderRadius: '4px', border: `2px solid ${currentNodeColor}` }}>
                          <label style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: '8px',
                            marginBottom: '8px', 
                            fontWeight: '600', 
                            fontSize: '12px', 
                            color: '#0066cc' 
                          }}>
                            <div style={{
                              width: '16px',
                              height: '16px',
                              borderRadius: '2px',
                              background: currentNodeColor,
                              border: '1px solid rgba(0,0,0,0.2)',
                              flexShrink: 0
                            }} />
                            Quick View Variants (What-If Analysis)
                          </label>
                        <select
                          value={whatIfAnalysis?.caseNodeId === selectedNodeId ? whatIfAnalysis.selectedVariant : ""}
                          onChange={(e) => {
                            const variantName = e.target.value;
                            if (variantName && selectedNodeId) {
                              setWhatIfAnalysis({
                                caseNodeId: selectedNodeId,
                                selectedVariant: variantName
                              });
                            } else {
                              setWhatIfAnalysis(null);
                            }
                          }}
                          style={{ 
                            width: '100%', 
                            padding: '8px', 
                            border: whatIfAnalysis?.caseNodeId === selectedNodeId ? '2px solid #0066cc' : '1px solid #c4e0ff', 
                            borderRadius: '4px',
                            boxSizing: 'border-box',
                            fontSize: '12px',
                            background: whatIfAnalysis?.caseNodeId === selectedNodeId ? '#fff9e6' : 'white',
                            fontWeight: whatIfAnalysis?.caseNodeId === selectedNodeId ? 'bold' : 'normal'
                          }}
                        >
                          <option value="">All variants (actual weights)</option>
                          {caseData.variants.map((v, i) => (
                            <option key={i} value={v.name}>
                              {v.name} - What if 100%?
                            </option>
                          ))}
                        </select>
                        {whatIfAnalysis?.caseNodeId === selectedNodeId && (
                          <div style={{
                            marginTop: '8px',
                            padding: '6px 8px',
                            background: '#fff9e6',
                            border: '1px solid #ffd700',
                            borderRadius: '3px',
                            fontSize: '11px',
                            color: '#997400',
                            fontWeight: 'bold'
                          }}>
                            🔬 WHAT-IF MODE: {whatIfAnalysis.selectedVariant} @ 100%
                          </div>
                        )}
                      </div>
                      );
                    })()}

                    {/* Case ID or Parameter ID */}
                    <div style={{ marginBottom: '20px' }}>
                      <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>
                        {caseMode === 'registry' ? 'Parameter ID' : 'Case ID'}
                      </label>
                      {caseMode === 'registry' ? (
                        <div>
                          <select
                            value={caseData.parameter_id}
                            onChange={(e) => {
                              const newParameterId = e.target.value;
                              setCaseData({...caseData, parameter_id: newParameterId});
                              // TODO: Load parameter from registry
                              if (newParameterId) {
                                // Simulate loading parameter data
                                setCaseData({
                                  ...caseData,
                                  parameter_id: newParameterId,
                                  id: 'case_001',
                                  status: 'active',
                                  variants: [
                                    { name: 'control', weight: 0.5, description: 'Control variant' },
                                    { name: 'treatment', weight: 0.5, description: 'Treatment variant' }
                                  ]
                                });
                              }
                            }}
                            style={{ 
                              width: '100%', 
                              padding: '8px', 
                              border: '1px solid #ddd', 
                              borderRadius: '4px',
                              boxSizing: 'border-box'
                            }}
                          >
                            <option value="">Select parameter...</option>
                            <option value="case-checkout-flow-001">Checkout Flow Test</option>
                            <option value="case-pricing-test-001">Pricing Strategy Test</option>
                            <option value="case-onboarding-test-001">Onboarding Flow Test</option>
                          </select>
                          
                          {/* Registry Info Display */}
                          {caseData.parameter_id && (
                            <div style={{ 
                              marginTop: '8px', 
                              padding: '8px', 
                              background: '#f8f9fa', 
                              borderRadius: '4px',
                              fontSize: '12px'
                            }}>
                              <div style={{ fontWeight: '600', marginBottom: '4px' }}>Registry Info</div>
                              <div>Name: Checkout Flow A/B Test</div>
                              <div>Status: ● Active</div>
                              <div>Platform: Statsig</div>
                              <div>Last Updated: 2025-01-20</div>
                              <div style={{ marginTop: '8px' }}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    // TODO: Refresh from registry
                                    console.log('Refresh from registry');
                                  }}
                                  style={{
                                    background: '#007bff',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '3px',
                                    padding: '4px 8px',
                                    cursor: 'pointer',
                                    fontSize: '10px',
                                    marginRight: '8px'
                                  }}
                                >
                                  ↻ Refresh
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    // TODO: Edit in registry
                                    console.log('Edit in registry');
                                  }}
                                  style={{
                                    background: '#28a745',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '3px',
                                    padding: '4px 8px',
                                    cursor: 'pointer',
                                    fontSize: '10px'
                                  }}
                                >
                                  📝 Edit
                                </button>
                              </div>
                              <div style={{ marginTop: '8px' }}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCaseMode('manual');
                                    // Clear parameter_id when switching to manual
                                    setCaseData({...caseData, parameter_id: ''});
                                  }}
                                  style={{
                                    background: '#6c757d',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '3px',
                                    padding: '4px 8px',
                                    cursor: 'pointer',
                                    fontSize: '10px'
                                  }}
                                >
                                  Override Locally
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <input
                          value={caseData.id}
                          onChange={(e) => setCaseData({...caseData, id: e.target.value})}
                          onBlur={() => {
                            if (graph && selectedNodeId) {
                              const next = structuredClone(graph);
                              const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                              if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                next.nodes[nodeIndex].case.id = caseData.id;
                                if (next.metadata) {
                                  next.metadata.updated_at = new Date().toISOString();
                                }
                                setGraph(next);
                              }
                            }
                          }}
                          placeholder="case_001"
                          style={{ 
                            width: '100%', 
                            padding: '8px', 
                            border: '1px solid #ddd', 
                            borderRadius: '4px',
                            boxSizing: 'border-box'
                          }}
                        />
                      )}
                    </div>

                    {/* Case Status */}
                    <div style={{ marginBottom: '20px' }}>
                      <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Status</label>
                      <select
                        value={caseData.status}
                        onChange={(e) => {
                          const newStatus = e.target.value as 'active' | 'paused' | 'completed';
                          setCaseData({...caseData, status: newStatus});
                          if (graph && selectedNodeId) {
                            const next = structuredClone(graph);
                            const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                            if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                              next.nodes[nodeIndex].case.status = newStatus;
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
                      >
                        <option value="active">Active</option>
                        <option value="paused">Paused</option>
                        <option value="completed">Completed</option>
                      </select>
                    </div>

                    {/* Case Node Color */}
                    <div style={{ marginBottom: '20px' }}>
                      <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Node Color</label>
                      <div style={{ fontSize: '11px', color: '#666', marginBottom: '8px' }}>
                        Colors are auto-assigned from the palette. Customize:
                      </div>
                      <input
                        type="color"
                        value={(() => {
                          const node = graph?.nodes.find((n: any) => n.id === selectedNodeId);
                          return node?.layout?.color || '#4ade80'; // Default to first palette color if none assigned
                        })()}
                        onChange={(e) => {
                          e.stopPropagation();
                          if (graph && selectedNodeId) {
                            const next = structuredClone(graph);
                            const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                            if (nodeIndex >= 0) {
                              if (!next.nodes[nodeIndex].layout) {
                                next.nodes[nodeIndex].layout = {};
                              }
                              next.nodes[nodeIndex].layout.color = e.target.value;
                              if (next.metadata) {
                                next.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(next);
                            }
                          }
                        }}
                        onInput={(e: React.FormEvent<HTMLInputElement>) => {
                          e.stopPropagation();
                          const target = e.target as HTMLInputElement;
                          if (graph && selectedNodeId) {
                            const next = structuredClone(graph);
                            const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                            if (nodeIndex >= 0) {
                              if (!next.nodes[nodeIndex].layout) {
                                next.nodes[nodeIndex].layout = {};
                              }
                              next.nodes[nodeIndex].layout.color = target.value;
                              if (next.metadata) {
                                next.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(next);
                            }
                          }
                        }}
                        style={{
                          width: '60px',
                          height: '32px',
                          border: '1px solid #ddd',
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      />
                      {(() => {
                        const node = graph?.nodes.find((n: any) => n.id === selectedNodeId);
                        return node?.layout?.color && (
                          <button
                            onClick={() => {
                              if (graph && selectedNodeId) {
                                const next = structuredClone(graph);
                                const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                                if (nodeIndex >= 0 && next.nodes[nodeIndex].layout) {
                                  // Remove color to trigger auto-assignment
                                  delete next.nodes[nodeIndex].layout.color;
                                  if (next.metadata) {
                                    next.metadata.updated_at = new Date().toISOString();
                                  }
                                  setGraph(next);
                                }
                              }
                            }}
                            style={{
                              marginLeft: '8px',
                              padding: '6px 12px',
                              fontSize: '11px',
                              background: '#f1f1f1',
                              border: '1px solid #ddd',
                              borderRadius: '4px',
                              cursor: 'pointer'
                            }}
                          >
                            Reset to Auto
                          </button>
                        );
                      })()}
                    </div>

                    {/* Variants Section */}
                    <div style={{ marginBottom: '20px' }}>
                      <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Variants</label>
                      {caseData.variants.map((variant, index) => (
                        <div key={index} style={{ 
                          marginBottom: '12px', 
                          padding: '12px', 
                          border: '1px solid #ddd', 
                          borderRadius: '4px',
                          background: '#f9f9f9'
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                            <span style={{ fontWeight: '600', fontSize: '12px' }}>Variant {index + 1}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const newVariants = caseData.variants.filter((_, i) => i !== index);
                                setCaseData({...caseData, variants: newVariants});
                                if (graph && selectedNodeId) {
                                  const next = structuredClone(graph);
                                  const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                                  if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                    next.nodes[nodeIndex].case.variants = newVariants;
                                    if (next.metadata) {
                                      next.metadata.updated_at = new Date().toISOString();
                                    }
                                    setGraph(next);
                                  }
                                }
                              }}
                              style={{
                                background: '#dc3545',
                                color: 'white',
                                border: 'none',
                                borderRadius: '3px',
                                padding: '4px 8px',
                                cursor: 'pointer',
                                fontSize: '10px'
                              }}
                            >
                              ✕ Remove
                            </button>
                          </div>
                          
                          <div style={{ marginBottom: '8px' }}>
                            <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: '600' }}>Name</label>
                            <input
                              value={variant.name}
                              onChange={(e) => {
                                const newVariants = [...caseData.variants];
                                newVariants[index].name = e.target.value;
                                setCaseData({...caseData, variants: newVariants});
                              }}
                              onBlur={() => {
                                if (graph && selectedNodeId) {
                                  const next = structuredClone(graph);
                                  const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                                  if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                    next.nodes[nodeIndex].case.variants = caseData.variants;
                                    if (next.metadata) {
                                      next.metadata.updated_at = new Date().toISOString();
                                    }
                                    setGraph(next);
                                  }
                                }
                              }}
                              placeholder="control"
                              style={{ 
                                width: '100%', 
                                padding: '6px', 
                                border: '1px solid #ddd', 
                                borderRadius: '3px',
                                boxSizing: 'border-box',
                                fontSize: '12px'
                              }}
                            />
                          </div>
                          
                          <div style={{ marginBottom: '8px' }}>
                            <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: '600' }}>Weight (0-1)</label>
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                              <input
                                type="number"
                                min="0"
                                max="1"
                                step="0.01"
                                value={variant.weight}
                                onChange={(e) => {
                                  const newVariants = [...caseData.variants];
                                  newVariants[index].weight = parseFloat(e.target.value) || 0;
                                  setCaseData({...caseData, variants: newVariants});
                                }}
                                onBlur={() => {
                                  if (graph && selectedNodeId) {
                                    const next = structuredClone(graph);
                                    const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                                    if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                      next.nodes[nodeIndex].case.variants = caseData.variants;
                                      if (next.metadata) {
                                        next.metadata.updated_at = new Date().toISOString();
                                      }
                                      setGraph(next);
                                    }
                                  }
                                }}
                                placeholder="0.5"
                                style={{ 
                                  width: '60px', 
                                  padding: '4px', 
                                  border: '1px solid #ddd', 
                                  borderRadius: '3px',
                                  boxSizing: 'border-box',
                                  fontSize: '11px'
                                }}
                              />
                              <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                value={variant.weight}
                                onChange={(e) => {
                                  const value = parseFloat(e.target.value);
                                  const newVariants = [...caseData.variants];
                                  newVariants[index].weight = value;
                                  setCaseData({...caseData, variants: newVariants});
                                  // Debounce the expensive graph update
                                  clearTimeout((window as any).variantWeightSliderTimeout);
                                  (window as any).variantWeightSliderTimeout = setTimeout(() => {
                                    if (graph && selectedNodeId) {
                                      const next = structuredClone(graph);
                                      const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                                      if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                        next.nodes[nodeIndex].case.variants = newVariants;
                                        if (next.metadata) {
                                          next.metadata.updated_at = new Date().toISOString();
                                        }
                                        setGraph(next);
                                      }
                                    }
                                  }, 250);
                                }}
                                style={{
                                  flex: 1,
                                  height: '4px',
                                  background: '#ddd',
                                  outline: 'none',
                                  borderRadius: '2px'
                                }}
                              />
                              <span style={{ fontSize: '10px', color: '#666', minWidth: '25px' }}>
                                {(variant.weight * 100).toFixed(0)}%
                              </span>
                              <button
                                onClick={() => {
                                  if (!graph || !selectedNodeId) return;
                                  const currentNode = graph.nodes.find((n: any) => n.id === selectedNodeId);
                                  if (!currentNode?.case?.variants) return;
                                  
                                  const nextGraph = structuredClone(graph);
                                  const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.id === selectedNodeId);
                                  if (nodeIndex >= 0) {
                                    const currentWeight = variant.weight;
                                    const remainingWeight = 1 - currentWeight;
                                    const otherVariants = currentNode.case.variants.filter((_, i) => i !== index);
                                    
                                    if (otherVariants.length > 0) {
                                      // Calculate total current weight of other variants
                                      const othersTotal = otherVariants.reduce((sum, v) => sum + v.weight, 0);
                                      
                                      if (othersTotal > 0) {
                                        // Rebalance other variants proportionally
                                        otherVariants.forEach((otherVariant, otherIndex) => {
                                          const originalIndex = currentNode.case.variants.findIndex(v => v.name === otherVariant.name);
                                          if (originalIndex >= 0) {
                                            const newWeight = (otherVariant.weight / othersTotal) * remainingWeight;
                                            nextGraph.nodes[nodeIndex].case.variants[originalIndex].weight = newWeight;
                                          }
                                        });
                                      } else {
                                        // If other variants have no weight, distribute equally
                                        const equalShare = remainingWeight / otherVariants.length;
                                        otherVariants.forEach((otherVariant, otherIndex) => {
                                          const originalIndex = currentNode.case.variants.findIndex(v => v.name === otherVariant.name);
                                          if (originalIndex >= 0) {
                                            nextGraph.nodes[nodeIndex].case.variants[originalIndex].weight = equalShare;
                                          }
                                        });
                                      }
                                      
                                      if (nextGraph.metadata) {
                                        nextGraph.metadata.updated_at = new Date().toISOString();
                                      }
                                      setGraph(nextGraph);
                                    }
                                  }
                                }}
                                style={{
                                  padding: '2px 4px',
                                  fontSize: '9px',
                                  backgroundColor: (() => {
                                    if (!graph || !selectedNodeId) return '#f8f9fa';
                                    const currentNode = graph.nodes.find((n: any) => n.id === selectedNodeId);
                                    if (!currentNode?.case?.variants) return '#f8f9fa';
                                    
                                    const totalWeight = currentNode.case.variants.reduce((sum, v) => sum + v.weight, 0);
                                    // Light up if total weight is not close to 1.0
                                    return Math.abs(totalWeight - 1.0) > 0.01 ? '#fff3cd' : '#f8f9fa';
                                  })(),
                                  border: (() => {
                                    if (!graph || !selectedNodeId) return '1px solid #ddd';
                                    const currentNode = graph.nodes.find((n: any) => n.id === selectedNodeId);
                                    if (!currentNode?.case?.variants) return '1px solid #ddd';
                                    
                                    const totalWeight = currentNode.case.variants.reduce((sum, v) => sum + v.weight, 0);
                                    // Light up if total weight is not close to 1.0
                                    return Math.abs(totalWeight - 1.0) > 0.01 ? '1px solid #ffc107' : '1px solid #ddd';
                                  })(),
                                  borderRadius: '2px',
                                  cursor: 'pointer',
                                  color: (() => {
                                    if (!graph || !selectedNodeId) return '#666';
                                    const currentNode = graph.nodes.find((n: any) => n.id === selectedNodeId);
                                    if (!currentNode?.case?.variants) return '#666';
                                    
                                    const totalWeight = currentNode.case.variants.reduce((sum, v) => sum + v.weight, 0);
                                    // Light up if total weight is not close to 1.0
                                    return Math.abs(totalWeight - 1.0) > 0.01 ? '#856404' : '#666';
                                  })()
                                }}
                                title="Rebalance variant weights proportionally"
                              >
                                ⚖️
                              </button>
                            </div>
                          </div>
                          
                          <div>
                            <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: '600' }}>Description</label>
                            <input
                              value={variant.description || ''}
                              onChange={(e) => {
                                const newVariants = [...caseData.variants];
                                newVariants[index].description = e.target.value;
                                setCaseData({...caseData, variants: newVariants});
                              }}
                              onBlur={() => {
                                if (graph && selectedNodeId) {
                                  const next = structuredClone(graph);
                                  const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                                  if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                    next.nodes[nodeIndex].case.variants = caseData.variants;
                                    if (next.metadata) {
                                      next.metadata.updated_at = new Date().toISOString();
                                    }
                                    setGraph(next);
                                  }
                                }
                              }}
                              placeholder="Original flow"
                              style={{ 
                                width: '100%', 
                                padding: '6px', 
                                border: '1px solid #ddd', 
                                borderRadius: '3px',
                                boxSizing: 'border-box',
                                fontSize: '12px'
                              }}
                            />
                          </div>
                        </div>
                      ))}
                      
                      <button
                        type="button"
                        onClick={() => {
                          const newVariants = [...caseData.variants, { name: `variant_${caseData.variants.length + 1}`, weight: 0.1, description: '' }];
                          setCaseData({...caseData, variants: newVariants});
                          if (graph && selectedNodeId) {
                            const next = structuredClone(graph);
                            const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                            if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                              next.nodes[nodeIndex].case.variants = newVariants;
                              if (next.metadata) {
                                next.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(next);
                            }
                          }
                        }}
                        style={{
                          background: '#28a745',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          padding: '8px 16px',
                          cursor: 'pointer',
                          fontSize: '12px',
                          fontWeight: '600',
                          width: '100%'
                        }}
                      >
                        + Add Variant
                      </button>
                      
                      {/* Total Weight Display */}
                      <div style={{ 
                        marginTop: '8px', 
                        padding: '8px', 
                        background: '#f8f9fa', 
                        borderRadius: '4px',
                        fontSize: '12px',
                        textAlign: 'center'
                      }}>
                        Total Weight: {caseData.variants.reduce((sum, v) => sum + v.weight, 0).toFixed(1)} 
                        {Math.abs(caseData.variants.reduce((sum, v) => sum + v.weight, 0) - 1.0) < 0.001 ? ' ✓' : ' ⚠️'}
                      </div>
                    </div>
                  </>
                )}

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

                {/* Probability field - shown for all edges, but with different meaning for case edges */}
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>
                    {selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant) 
                      ? 'Sub-Route Probability (within variant)' 
                      : 'Probability'}
                  </label>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <input
                      data-field="probability"
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                      value={localEdgeData.probability || 0}
                      onChange={(e) => {
                        const value = parseFloat(e.target.value) || 0;
                        setLocalEdgeData({...localEdgeData, probability: value});
                        updateEdge('probability', value);
                      }}
                      placeholder={selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant) ? "1.0" : "0.0"}
                      style={{ 
                        width: '80px', 
                        padding: '8px', 
                        border: '1px solid #ddd', 
                        borderRadius: '4px',
                        boxSizing: 'border-box'
                      }}
                    />
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={localEdgeData.probability || 0}
                      onChange={(e) => {
                        const value = parseFloat(e.target.value);
                        // Update local state immediately for smooth slider movement
                        setLocalEdgeData({...localEdgeData, probability: value});
                        // Debounce only the expensive graph update
                        clearTimeout((window as any).probabilitySliderTimeout);
                        (window as any).probabilitySliderTimeout = setTimeout(() => {
                          updateEdge('probability', value);
                        }, 250);
                      }}
                      style={{ 
                        flex: 1,
                        height: '6px',
                        background: '#ddd',
                        outline: 'none',
                        borderRadius: '3px'
                      }}
                    />
                    <span style={{ fontSize: '12px', color: '#666', minWidth: '30px' }}>
                      {((localEdgeData.probability || 0) * 100).toFixed(0)}%
                    </span>
                    <button
                      onClick={() => {
                        if (!graph || !selectedEdgeId) return;
                        const currentEdge = graph.edges.find((e: any) => e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId);
                        if (!currentEdge) return;
                        
                        const siblings = graph.edges.filter((e: any) => {
                          // For case edges, only balance within the same variant
                          if (currentEdge.case_id && currentEdge.case_variant) {
                            return e.id !== currentEdge.id && 
                                   e.from === currentEdge.from && 
                                   e.case_id === currentEdge.case_id && 
                                   e.case_variant === currentEdge.case_variant;
                          }
                          // For regular edges, balance all edges from same source
                          return e.id !== currentEdge.id && e.from === currentEdge.from;
                        });
                        
                        if (siblings.length > 0) {
                          const nextGraph = structuredClone(graph);
                          const currentValue = currentEdge.p?.mean || 0;
                          const remainingProbability = 1 - currentValue;
                          
                          // Calculate total current probability of siblings
                          const siblingsTotal = siblings.reduce((sum, sibling) => sum + (sibling.p?.mean || 0), 0);
                          
                          if (siblingsTotal > 0) {
                            // Rebalance siblings proportionally
                            siblings.forEach(sibling => {
                              const siblingIndex = nextGraph.edges.findIndex((e: any) => e.id === sibling.id);
                              if (siblingIndex >= 0) {
                                const siblingCurrentValue = sibling.p?.mean || 0;
                                const newValue = (siblingCurrentValue / siblingsTotal) * remainingProbability;
                                nextGraph.edges[siblingIndex].p = { ...nextGraph.edges[siblingIndex].p, mean: newValue };
                              }
                            });
                          } else {
                            // If siblings have no probability, distribute equally
                            const equalShare = remainingProbability / siblings.length;
                            siblings.forEach(sibling => {
                              const siblingIndex = nextGraph.edges.findIndex((e: any) => e.id === sibling.id);
                              if (siblingIndex >= 0) {
                                nextGraph.edges[siblingIndex].p = { ...nextGraph.edges[siblingIndex].p, mean: equalShare };
                              }
                            });
                          }
                          
                          if (nextGraph.metadata) {
                            nextGraph.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(nextGraph);
                        }
                      }}
                      style={{
                        padding: '4px 8px',
                        fontSize: '11px',
                        backgroundColor: (() => {
                          if (!graph || !selectedEdgeId) return '#f8f9fa';
                          const currentEdge = graph.edges.find((e: any) => e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId);
                          if (!currentEdge) return '#f8f9fa';
                          
                          const siblings = graph.edges.filter((e: any) => {
                            // For case edges, only balance within the same variant
                            if (currentEdge.case_id && currentEdge.case_variant) {
                              return e.id !== currentEdge.id && 
                                     e.from === currentEdge.from && 
                                     e.case_id === currentEdge.case_id && 
                                     e.case_variant === currentEdge.case_variant;
                            }
                            // For regular edges, balance all edges from same source
                            return e.id !== currentEdge.id && e.from === currentEdge.from;
                          });
                          
                          if (siblings.length === 0) return '#f8f9fa';
                          
                          // Calculate total probability mass
                          const currentValue = currentEdge.p?.mean || 0;
                          const siblingsTotal = siblings.reduce((sum, sibling) => sum + (sibling.p?.mean || 0), 0);
                          const totalMass = currentValue + siblingsTotal;
                          
                          // Light up if total mass is not close to 1.0
                          return Math.abs(totalMass - 1.0) > 0.01 ? '#fff3cd' : '#f8f9fa';
                        })(),
                        border: (() => {
                          if (!graph || !selectedEdgeId) return '1px solid #ddd';
                          const currentEdge = graph.edges.find((e: any) => e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId);
                          if (!currentEdge) return '1px solid #ddd';
                          
                          const siblings = graph.edges.filter((e: any) => {
                            // For case edges, only balance within the same variant
                            if (currentEdge.case_id && currentEdge.case_variant) {
                              return e.id !== currentEdge.id && 
                                     e.from === currentEdge.from && 
                                     e.case_id === currentEdge.case_id && 
                                     e.case_variant === currentEdge.case_variant;
                            }
                            // For regular edges, balance all edges from same source
                            return e.id !== currentEdge.id && e.from === currentEdge.from;
                          });
                          
                          if (siblings.length === 0) return '1px solid #ddd';
                          
                          // Calculate total probability mass
                          const currentValue = currentEdge.p?.mean || 0;
                          const siblingsTotal = siblings.reduce((sum, sibling) => sum + (sibling.p?.mean || 0), 0);
                          const totalMass = currentValue + siblingsTotal;
                          
                          // Light up if total mass is not close to 1.0
                          return Math.abs(totalMass - 1.0) > 0.01 ? '1px solid #ffc107' : '1px solid #ddd';
                        })(),
                        borderRadius: '3px',
                        cursor: 'pointer',
                        color: (() => {
                          if (!graph || !selectedEdgeId) return '#666';
                          const currentEdge = graph.edges.find((e: any) => e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId);
                          if (!currentEdge) return '#666';
                          
                          const siblings = graph.edges.filter((e: any) => {
                            // For case edges, only balance within the same variant
                            if (currentEdge.case_id && currentEdge.case_variant) {
                              return e.id !== currentEdge.id && 
                                     e.from === currentEdge.from && 
                                     e.case_id === currentEdge.case_id && 
                                     e.case_variant === currentEdge.case_variant;
                            }
                            // For regular edges, balance all edges from same source
                            return e.id !== currentEdge.id && e.from === currentEdge.from;
                          });
                          
                          if (siblings.length === 0) return '#666';
                          
                          // Calculate total probability mass
                          const currentValue = currentEdge.p?.mean || 0;
                          const siblingsTotal = siblings.reduce((sum, sibling) => sum + (sibling.p?.mean || 0), 0);
                          const totalMass = currentValue + siblingsTotal;
                          
                          // Light up if total mass is not close to 1.0
                          return Math.abs(totalMass - 1.0) > 0.01 ? '#856404' : '#666';
                        })()
                      }}
                      title="Rebalance sibling edges proportionally"
                    >
                      ⚖️
                    </button>
                  </div>
                  {selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant) && (
                    <div style={{ fontSize: '11px', color: '#666', marginTop: '4px' }}>
                      For single-path variants, leave at 1.0. For multi-path variants, probabilities must sum to 1.0.
                    </div>
                  )}
                </div>

                {/* Only show standard deviation for non-case edges */}
                {!(selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant)) && (
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Standard Deviation</label>
                    <input
                      data-field="stdev"
                      type="text"
                      value={localEdgeData.stdev !== undefined ? localEdgeData.stdev : ''}
                      onChange={(e) => {
                        const value = e.target.value;
                        setLocalEdgeData({...localEdgeData, stdev: value});
                      }}
                      onBlur={() => {
                        const numValue = parseFloat(localEdgeData.stdev);
                        if (isNaN(numValue)) {
                          setLocalEdgeData({...localEdgeData, stdev: undefined});
                          updateEdge('stdev', undefined);
                        } else {
                          setLocalEdgeData({...localEdgeData, stdev: numValue});
                          updateEdge('stdev', numValue);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const numValue = parseFloat(localEdgeData.stdev);
                          if (isNaN(numValue)) {
                            setLocalEdgeData({...localEdgeData, stdev: undefined});
                            updateEdge('stdev', undefined);
                          } else {
                            setLocalEdgeData({...localEdgeData, stdev: numValue});
                            updateEdge('stdev', numValue);
                          }
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
                )}

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

                {/* Conditional Probabilities */}
                {selectedEdge && graph && (
                  <ConditionalProbabilitiesSection
                    edge={selectedEdge}
                    graph={graph}
                    setGraph={setGraph}
                    localConditionalP={localConditionalP}
                    setLocalConditionalP={setLocalConditionalP}
                    onLocalUpdate={(conditionalP) => {
                      // Update local state immediately (like variants)
                      setLocalConditionalP(conditionalP);
                      // Also update graph
                      if (graph && selectedEdgeId) {
                        const nextGraph = structuredClone(graph);
                        const edgeIndex = nextGraph.edges.findIndex((e: any) => 
                          e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                        );
                        if (edgeIndex >= 0) {
                          nextGraph.edges[edgeIndex].conditional_p = conditionalP.length > 0 ? conditionalP : undefined;
                          
                          if (!nextGraph.metadata) nextGraph.metadata = {} as any;
                          nextGraph.metadata.updated_at = new Date().toISOString();
                          setGraph(nextGraph);
                        }
                      }
                    }}
                    onUpdateColor={(color) => {
                      const nextGraph = structuredClone(graph);
                      const edgeIndex = nextGraph.edges.findIndex((e: any) => 
                        e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                      );
                      if (edgeIndex >= 0) {
                        if (!nextGraph.edges[edgeIndex].display) {
                          nextGraph.edges[edgeIndex].display = {};
                        }
                        nextGraph.edges[edgeIndex].display!.conditional_color = color;
                        if (!nextGraph.metadata) nextGraph.metadata = {} as any;
                        nextGraph.metadata.updated_at = new Date().toISOString();
                        setGraph(nextGraph);
                      }
                    }}
                  />
                )}

                {/* Only show weight default for non-case edges */}
                {!(selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant)) && (
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
                    <div style={{ fontSize: '11px', color: '#666', marginTop: '4px' }}>
                      Used to distribute residual probability among unspecified edges from the same source
                    </div>
                  </div>
                )}

                {/* Case Edge Properties */}
                {selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant) && (() => {
                  // Find the case node and get the variant weight
                  const caseNode = graph.nodes.find((n: any) => n.case && n.case.id === selectedEdge.case_id);
                  const variant = caseNode?.case?.variants?.find((v: any) => v.name === selectedEdge.case_variant);
                  const variantWeight = variant?.weight || 0;
                  const subRouteProbability = selectedEdge.p?.mean || 1.0;
                  const effectiveProbability = variantWeight * subRouteProbability;
                  
                  return (
                    <div style={{ marginBottom: '20px', padding: '12px', background: '#f8f9fa', borderRadius: '4px', border: '1px solid #e9ecef' }}>
                      <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600', color: '#8B5CF6' }}>Case Edge Summary</label>
                      
                      <div style={{ marginBottom: '12px' }}>
                        <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', color: '#666' }}>Case ID</label>
                        <input
                          type="text"
                          value={selectedEdge.case_id || ''}
                          readOnly
                          style={{ 
                            width: '100%', 
                            padding: '6px 8px', 
                            border: '1px solid #ddd', 
                            borderRadius: '3px',
                            background: '#f8f9fa',
                            fontSize: '12px',
                            color: '#666'
                          }}
                        />
                      </div>
                      
                      <div style={{ marginBottom: '12px' }}>
                        <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', color: '#666' }}>Variant</label>
                        <input
                          type="text"
                          value={selectedEdge.case_variant || ''}
                          readOnly
                          style={{ 
                            width: '100%', 
                            padding: '6px 8px', 
                            border: '1px solid #ddd', 
                            borderRadius: '3px',
                            background: '#f8f9fa',
                            fontSize: '12px',
                            color: '#666'
                          }}
                        />
                      </div>
                      
                      <div style={{ marginBottom: '12px' }}>
                        <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', color: '#8B5CF6' }}>Variant Weight (Traffic Split)</label>
                        <input
                          type="text"
                          value={`${(variantWeight * 100).toFixed(1)}% (${variantWeight.toFixed(3)})`}
                          readOnly
                          style={{ 
                            width: '100%', 
                            padding: '6px 8px', 
                            border: '1px solid #C4B5FD', 
                            borderRadius: '3px',
                            background: '#F3F0FF',
                            fontSize: '12px',
                            color: '#8B5CF6',
                            fontWeight: '600'
                          }}
                        />
                      </div>
                      
                      <div style={{ marginBottom: '12px' }}>
                        <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', color: '#666' }}>Sub-Route Probability</label>
                        <input
                          type="text"
                          value={`${(subRouteProbability * 100).toFixed(1)}% (${subRouteProbability.toFixed(3)})`}
                          readOnly
                          style={{ 
                            width: '100%', 
                            padding: '6px 8px', 
                            border: '1px solid #ddd', 
                            borderRadius: '3px',
                            background: '#f8f9fa',
                            fontSize: '12px',
                            color: '#666',
                            fontWeight: '600'
                          }}
                        />
                      </div>
                      
                      <div style={{ marginBottom: '12px', padding: '8px', background: '#FFF9E6', borderRadius: '3px', border: '1px solid #FFE066' }}>
                        <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', color: '#997400', fontWeight: '600' }}>
                          Effective Probability (Variant × Sub-Route)
                        </label>
                        <div style={{ fontSize: '14px', color: '#997400', fontWeight: '700' }}>
                          {(effectiveProbability * 100).toFixed(1)}% ({effectiveProbability.toFixed(3)})
                        </div>
                      </div>
                      
                      <div style={{ fontSize: '11px', color: '#666' }}>
                        <strong>Formula:</strong> Effective Probability = Variant Weight × Sub-Route Probability
                        <br/>
                        <strong>Example:</strong> If variant is 50% and sub-route is 50%, then 25% of total traffic flows through this edge.
                      </div>
                    </div>
                  );
                })()}

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Costs</label>
                  
                  <div style={{ 
                    background: '#f8f9fa', 
                    padding: '12px', 
                    borderRadius: '4px', 
                    border: '1px solid #e9ecef',
                    marginBottom: '12px'
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      {/* Monetary Cost Section */}
                      <div style={{ 
                        background: '#fff', 
                        padding: '8px', 
                        borderRadius: '3px', 
                        border: '1px solid #e9ecef'
                      }}>
                        <label style={{ display: 'block', fontSize: '12px', marginBottom: '6px', color: '#495057', fontWeight: '600' }}>
                          Monetary Cost (GBP)
                        </label>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={localEdgeData.costs?.monetary?.value || ''}
                            onChange={(e) => setLocalEdgeData({
                              ...localEdgeData, 
                              costs: {
                                ...localEdgeData.costs, 
                                monetary: {
                                  ...localEdgeData.costs?.monetary,
                                  value: parseFloat(e.target.value) || undefined,
                                  currency: localEdgeData.costs?.monetary?.currency || 'GBP'
                                }
                              }
                            })}
                            onBlur={() => updateEdge('costs.monetary', localEdgeData.costs?.monetary)}
                            placeholder="0.00"
                            style={{ 
                              flex: 1,
                              padding: '6px 8px', 
                              border: '1px solid #ddd', 
                              borderRadius: '3px', 
                              fontSize: '12px',
                              boxSizing: 'border-box'
                            }}
                          />
                          <select
                            value={localEdgeData.costs?.monetary?.currency || 'GBP'}
                            onChange={(e) => setLocalEdgeData({
                              ...localEdgeData, 
                              costs: {
                                ...localEdgeData.costs, 
                                monetary: {
                                  ...localEdgeData.costs?.monetary,
                                  currency: e.target.value
                                }
                              }
                            })}
                            onBlur={() => updateEdge('costs.monetary', localEdgeData.costs?.monetary)}
                            style={{ 
                              padding: '6px 8px', 
                              border: '1px solid #ddd', 
                              borderRadius: '3px', 
                              fontSize: '12px',
                              background: 'white'
                            }}
                          >
                            <option value="GBP">GBP</option>
                            <option value="USD">USD</option>
                            <option value="EUR">EUR</option>
                          </select>
                        </div>
                        <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={localEdgeData.costs?.monetary?.stdev || ''}
                            onChange={(e) => setLocalEdgeData({
                              ...localEdgeData, 
                              costs: {
                                ...localEdgeData.costs, 
                                monetary: {
                                  ...localEdgeData.costs?.monetary,
                                  stdev: parseFloat(e.target.value) || undefined
                                }
                              }
                            })}
                            onBlur={() => updateEdge('costs.monetary', localEdgeData.costs?.monetary)}
                            placeholder="Stdev (optional)"
                            style={{ 
                              flex: 1,
                              padding: '4px 6px', 
                              border: '1px solid #ddd', 
                              borderRadius: '3px', 
                              fontSize: '11px',
                              boxSizing: 'border-box'
                            }}
                          />
                          <select
                            value={localEdgeData.costs?.monetary?.distribution || 'normal'}
                            onChange={(e) => setLocalEdgeData({
                              ...localEdgeData, 
                              costs: {
                                ...localEdgeData.costs, 
                                monetary: {
                                  ...localEdgeData.costs?.monetary,
                                  distribution: e.target.value
                                }
                              }
                            })}
                            onBlur={() => updateEdge('costs.monetary', localEdgeData.costs?.monetary)}
                            style={{ 
                              padding: '4px 6px', 
                              border: '1px solid #ddd', 
                              borderRadius: '3px', 
                              fontSize: '11px',
                              background: 'white'
                            }}
                          >
                            <option value="normal">Normal</option>
                            <option value="lognormal">Log-normal</option>
                            <option value="gamma">Gamma</option>
                            <option value="uniform">Uniform</option>
                          </select>
                        </div>
                      </div>
                      
                      {/* Time Cost Section */}
                      <div style={{ 
                        background: '#fff', 
                        padding: '8px', 
                        borderRadius: '3px', 
                        border: '1px solid #e9ecef'
                      }}>
                        <label style={{ display: 'block', fontSize: '12px', marginBottom: '6px', color: '#495057', fontWeight: '600' }}>
                          Time Cost (Days)
                        </label>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={localEdgeData.costs?.time?.value || ''}
                            onChange={(e) => setLocalEdgeData({
                              ...localEdgeData, 
                              costs: {
                                ...localEdgeData.costs, 
                                time: {
                                  ...localEdgeData.costs?.time,
                                  value: parseFloat(e.target.value) || undefined,
                                  units: localEdgeData.costs?.time?.units || 'days'
                                }
                              }
                            })}
                            onBlur={() => updateEdge('costs.time', localEdgeData.costs?.time)}
                            placeholder="0.0"
                            style={{ 
                              flex: 1,
                              padding: '6px 8px', 
                              border: '1px solid #ddd', 
                              borderRadius: '3px', 
                              fontSize: '12px',
                              boxSizing: 'border-box'
                            }}
                          />
                          <select
                            value={localEdgeData.costs?.time?.units || 'days'}
                            onChange={(e) => setLocalEdgeData({
                              ...localEdgeData, 
                              costs: {
                                ...localEdgeData.costs, 
                                time: {
                                  ...localEdgeData.costs?.time,
                                  units: e.target.value
                                }
                              }
                            })}
                            onBlur={() => updateEdge('costs.time', localEdgeData.costs?.time)}
                            style={{ 
                              padding: '6px 8px', 
                              border: '1px solid #ddd', 
                              borderRadius: '3px', 
                              fontSize: '12px',
                              background: 'white'
                            }}
                          >
                            <option value="days">Days</option>
                            <option value="hours">Hours</option>
                            <option value="weeks">Weeks</option>
                          </select>
                        </div>
                        <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={localEdgeData.costs?.time?.stdev || ''}
                            onChange={(e) => setLocalEdgeData({
                              ...localEdgeData, 
                              costs: {
                                ...localEdgeData.costs, 
                                time: {
                                  ...localEdgeData.costs?.time,
                                  stdev: parseFloat(e.target.value) || undefined
                                }
                              }
                            })}
                            onBlur={() => updateEdge('costs.time', localEdgeData.costs?.time)}
                            placeholder="Stdev (optional)"
                            style={{ 
                              flex: 1,
                              padding: '4px 6px', 
                              border: '1px solid #ddd', 
                              borderRadius: '3px', 
                              fontSize: '11px',
                              boxSizing: 'border-box'
                            }}
                          />
                          <select
                            value={localEdgeData.costs?.time?.distribution || 'lognormal'}
                            onChange={(e) => setLocalEdgeData({
                              ...localEdgeData, 
                              costs: {
                                ...localEdgeData.costs, 
                                time: {
                                  ...localEdgeData.costs?.time,
                                  distribution: e.target.value
                                }
                              }
                            })}
                            onBlur={() => updateEdge('costs.time', localEdgeData.costs?.time)}
                            style={{ 
                              padding: '4px 6px', 
                              border: '1px solid #ddd', 
                              borderRadius: '3px', 
                              fontSize: '11px',
                              background: 'white'
                            }}
                          >
                            <option value="normal">Normal</option>
                            <option value="lognormal">Log-normal</option>
                            <option value="gamma">Gamma</option>
                            <option value="uniform">Uniform</option>
                          </select>
                        </div>
                      </div>
                    </div>
                    
                    {/* Clear costs button */}
                    {(localEdgeData.costs?.monetary?.value || localEdgeData.costs?.time?.value) && (
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
