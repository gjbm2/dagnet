import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useTabContext, fileRegistry } from '../contexts/TabContext';
import { generateSlugFromLabel, generateUniqueSlug } from '@/lib/slugUtils';
import { roundTo4DP } from '@/utils/rounding';
import ProbabilityInput from './ProbabilityInput';
import VariantWeightInput from './VariantWeightInput';
import ConditionalProbabilitiesSection from './ConditionalProbabilitiesSection';
import CollapsibleSection from './CollapsibleSection';
import { getNextAvailableColor } from '@/lib/conditionalColors';
import { useSnapToSlider } from '@/hooks/useSnapToSlider';
import { ParameterSelector } from './ParameterSelector';
import { EnhancedSelector } from './EnhancedSelector';
import { ColorSelector } from './ColorSelector';
import { ConditionalProbabilityEditor } from './ConditionalProbabilityEditor';

interface PropertiesPanelProps {
  selectedNodeId: string | null;
  onSelectedNodeChange: (id: string | null) => void;
  selectedEdgeId: string | null;
  onSelectedEdgeChange: (id: string | null) => void;
  tabId?: string;
}

export default function PropertiesPanel({ 
  selectedNodeId, 
  onSelectedNodeChange, 
  selectedEdgeId, 
  onSelectedEdgeChange,
  tabId
}: PropertiesPanelProps) {
  const { graph, setGraph, saveHistoryState } = useGraphStore();
  const { tabs, operations: tabOps } = useTabContext();
  const { snapValue, shouldAutoRebalance, scheduleRebalance, handleMouseDown } = useSnapToSlider();
  
  // Get tab-specific what-if analysis state
  const myTab = tabs.find(t => t.id === tabId);
  const whatIfAnalysis = myTab?.editorState?.whatIfAnalysis;
  
  // Helper to update tab's what-if state
  const setWhatIfAnalysis = (analysis: any) => {
    if (tabId) {
      tabOps.updateTabState(tabId, { whatIfAnalysis: analysis });
    }
  };
  
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
  

  // Track the last loaded node to prevent reloading on every graph change
  const lastLoadedNodeRef = useRef<string | null>(null);
  // Track the previous selectedNodeId to detect deselect/reselect cycles
  const prevSelectedNodeIdRef = useRef<string | null>(null);
  
  // Load local data when selection changes (but not on every graph update)
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [PropertiesPanel] useEffect#PP1: Node selection changed`);
    if (selectedNodeId && graph) {
      // Detect if we just deselected and reselected the same node (e.g., on blur)
      const isReselectingSameNode = prevSelectedNodeIdRef.current === selectedNodeId && 
                                      lastLoadedNodeRef.current === selectedNodeId;
      
      console.log('PropertiesPanel node selection effect:', {
        selectedNodeId,
        lastLoaded: lastLoadedNodeRef.current,
        prevSelected: prevSelectedNodeIdRef.current,
        isReselectingSameNode,
        willReload: lastLoadedNodeRef.current !== selectedNodeId && !isReselectingSameNode
      });
      
      // Only reload if we're switching to a different node (not reselecting the same one)
      if (lastLoadedNodeRef.current !== selectedNodeId && !isReselectingSameNode) {
        const node = graph.nodes.find((n: any) => n.id === selectedNodeId);
        if (node) {
          console.log('PropertiesPanel: Reloading node data from graph, slug:', node.slug);
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
    }
    
    // Always track the previous selectedNodeId for next render
    prevSelectedNodeIdRef.current = selectedNodeId;
    
    if (!selectedNodeId) {
      // Clear the loaded ref when no node is selected, but keep prevSelectedNodeIdRef
      // to detect if we're reselecting the same node
      lastLoadedNodeRef.current = null;
    }
  }, [selectedNodeId]);

  // Load edge data when selection changes (but not on every graph update)
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [PropertiesPanel] useEffect#PP2: Edge selection changed`);
    if (selectedEdgeId && graph) {
      // Only reload if we're switching to a different edge
      if (lastLoadedEdgeRef.current !== selectedEdgeId) {
        const edge = graph.edges.find((e: any) => 
          e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
        );
        if (edge) {
          console.log('PropertiesPanel: Loading edge data:', {
            edgeId: selectedEdgeId,
            cost_gbp: (edge as any).cost_gbp,
            cost_time: (edge as any).cost_time,
            cost_gbp_parameter_id: (edge as any).cost_gbp_parameter_id,
            cost_time_parameter_id: (edge as any).cost_time_parameter_id
          });
          
          const edgeCostGbp = (edge as any).cost_gbp;
          const edgeCostTime = (edge as any).cost_time;
          
          console.log('About to setLocalEdgeData with costs:', {
            cost_gbp: edgeCostGbp,
            cost_time: edgeCostTime
          });
          
          setLocalEdgeData({
            slug: edge.slug || '',
            parameter_id: (edge as any).parameter_id || '',
            cost_gbp_parameter_id: (edge as any).cost_gbp_parameter_id || '',
            cost_time_parameter_id: (edge as any).cost_time_parameter_id || '',
            probability: edge.p?.mean || 0,
            stdev: edge.p?.stdev || undefined,
            description: edge.description || '',
            cost_gbp: edgeCostGbp,
            cost_time: edgeCostTime,
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
    console.log(`[${new Date().toISOString()}] [PropertiesPanel] useEffect#PP3: Auto-generate slug`);
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
    console.log(`[${new Date().toISOString()}] [PropertiesPanel] useEffect#PP4: Reload edge on graph change`);
    if (selectedEdgeId && graph) {
      // Reload if we're switching to a different edge OR if the graph has changed
      if (lastLoadedEdgeRef.current !== selectedEdgeId) {
        const edge = graph.edges.find((e: any) => 
          e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
        );
        if (edge) {
          console.log('PropertiesPanel: Loading case edge data:', {
            edgeId: selectedEdgeId,
            cost_gbp: (edge as any).cost_gbp,
            cost_time: (edge as any).cost_time
          });
          
          setLocalEdgeData({
            slug: edge.slug || '',
            parameter_id: (edge as any).parameter_id || '',
            cost_gbp_parameter_id: (edge as any).cost_gbp_parameter_id || '',
            cost_time_parameter_id: (edge as any).cost_time_parameter_id || '',
            probability: edge.p?.mean || 0,
            stdev: edge.p?.stdev || 0,
            locked: edge.p?.locked || false,
            description: edge.description || '',
            cost_gbp: (edge as any).cost_gbp,
            cost_time: (edge as any).cost_time,
            costs: edge.costs || {},
            weight_default: edge.weight_default || 0,
          });
          lastLoadedEdgeRef.current = selectedEdgeId;
        }
      } else {
        // Same edge selected but graph changed - reload the data
        const edge = graph.edges.find((e: any) => 
          e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
        );
        if (edge) {
          console.log('PropertiesPanel: Reloading edge data (graph changed):', {
            edgeId: selectedEdgeId,
            cost_gbp: (edge as any).cost_gbp,
            cost_time: (edge as any).cost_time
          });
          
          setLocalEdgeData({
            slug: edge.slug || '',
            parameter_id: (edge as any).parameter_id || '',
            cost_gbp_parameter_id: (edge as any).cost_gbp_parameter_id || '',
            cost_time_parameter_id: (edge as any).cost_time_parameter_id || '',
            probability: edge.p?.mean || 0,
            stdev: edge.p?.stdev || 0,
            locked: edge.p?.locked || false,
            description: edge.description || '',
            cost_gbp: (edge as any).cost_gbp,
            cost_time: (edge as any).cost_time,
            costs: edge.costs || {},
            weight_default: edge.weight_default || 0,
          });
          // Also update conditional probabilities when graph changes (e.g., from auto-rebalance)
          setLocalConditionalP(edge.conditional_p || []);
        }
      }
    } else if (!selectedEdgeId) {
      // Clear the ref when no edge is selected
      lastLoadedEdgeRef.current = null;
    }
  }, [selectedEdgeId, graph]);

  // Handle keyboard shortcuts
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [PropertiesPanel] useEffect#PP5: Setup keyboard shortcuts`);
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts when user is typing in form fields
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      
      // Note: Delete key handling is done by GraphCanvas, not here
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedEdgeId, graph, setGraph, onSelectedEdgeChange]);

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
      saveHistoryState(`Update node ${field}`, selectedNodeId || undefined);
    }
  }, [selectedNodeId, graph, setGraph, saveHistoryState]);

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
      saveHistoryState(`Update edge ${field}`, undefined, selectedEdgeId || undefined);
    }
  }, [selectedEdgeId, graph, setGraph, saveHistoryState]);

  if (!graph) return null;

  // Add null checks to prevent crashes when nodes/edges are deleted
  const selectedNode = selectedNodeId && graph.nodes ? graph.nodes.find((n: any) => n.id === selectedNodeId) : null;
  const selectedEdge = selectedEdgeId && graph.edges ? graph.edges.find((e: any) => 
    e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
  ) : null;

  // Determine header text based on selection
  const getHeaderText = () => {
    if (selectedNodeId) {
      const selectedNodes = graph.nodes?.filter((n: any) => n.selected) || [];
      if (selectedNodes.length > 1) {
        return `${selectedNodes.length} nodes selected`;
      }
      return 'Node Properties';
    }
    if (selectedEdgeId) return 'Edge Properties';
    return 'Graph Properties';
  };

  return (
    <div style={{ 
      height: '100%', 
      display: 'flex', 
      flexDirection: 'column',
      background: '#fff',
      overflow: 'auto',
      boxSizing: 'border-box'
    }}>
      {/* Content */}
      <div style={{ 
        padding: '12px', 
        boxSizing: 'border-box',
        width: '100%'
      }}>
        {!selectedNodeId && !selectedEdgeId && (
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

        {selectedNodeId && (
          <div>
            {selectedNode ? (
              <div>
                {/* Basic Info Section */}
                <CollapsibleSection title="Basic Info" defaultOpen={true}>
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
                        saveHistoryState('Update node label', selectedNodeId);
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
                          saveHistoryState('Update node label', selectedNodeId);
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
                              next.nodes[nodeIndex].layout = { x: 0, y: 0 };
                            }
                            if (!next.nodes[nodeIndex].layout!.color) {
                              next.nodes[nodeIndex].layout!.color = getNextAvailableColor(graph as any);
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

                <EnhancedSelector
                  type="node"
                  value={localNodeData.slug || ''}
                  autoFocus={!localNodeData.slug}
                  onChange={(newSlug) => {
                    console.log('PropertiesPanel: EnhancedSelector onChange:', { newSlug, currentSlug: localNodeData.slug });
                    
                    // Update local state immediately
                    setLocalNodeData({...localNodeData, slug: newSlug});
                    setSlugManuallyEdited(true);
                    
                    // Update the graph with new slug
                    updateNode('slug', newSlug);
                  }}
                  onPullFromRegistry={async () => {
                    if (!localNodeData.slug || !graph || !selectedNodeId) return;
                    
                    try {
                      const { paramRegistryService } = await import('../services/paramRegistryService');
                      const nodeData = await paramRegistryService.loadNode(localNodeData.slug);
                      
                      if (nodeData) {
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.id === selectedNodeId);
                        
                        if (nodeIndex >= 0) {
                          const node = next.nodes[nodeIndex];
                          
                          // Pull all fields from registry
                          if (nodeData.name) {
                            node.label = nodeData.name;
                            setLocalNodeData((prev: any) => ({...prev, label: nodeData.name}));
                          }
                          if (nodeData.description) {
                            node.description = nodeData.description;
                            setLocalNodeData((prev: any) => ({...prev, description: nodeData.description}));
                          }
                          if (nodeData.tags) {
                            node.tags = nodeData.tags;
                            setLocalNodeData((prev: any) => ({...prev, tags: nodeData.tags}));
                          }
                          
                          if (next.metadata) {
                            next.metadata.updated_at = new Date().toISOString();
                          }
                          
                          setGraph(next);
                          saveHistoryState(`Pull node data from registry`, selectedNodeId);
                        }
                      }
                    } catch (error) {
                      console.error('Failed to pull from registry:', error);
                    }
                  }}
                  onPushToRegistry={async () => {
                    // TODO: Implement push to registry
                    console.log('Push to registry not yet implemented');
                  }}
                  label="Node ID (Slug)"
                  placeholder="Select or enter node ID..."
                />

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
                </CollapsibleSection>

                <CollapsibleSection title="Node Details" defaultOpen={false}>
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

                </CollapsibleSection>

                {/* Case Node Fields */}
                {nodeType === 'case' && (
                  <CollapsibleSection title="Case Configuration" defaultOpen={true}>
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
                      {caseMode === 'registry' ? (
                      <EnhancedSelector
                        type="parameter"
                        value={caseData.parameter_id}
                        onChange={(newParameterId) => {
                          setCaseData({...caseData, parameter_id: newParameterId});
                        }}
                        onPullFromRegistry={async () => {
                          if (!caseData.parameter_id || !graph || !selectedNodeId) return;
                          
                          try {
                            let paramData: any = null;
                            const localFile = fileRegistry.getFile(`parameter-${caseData.parameter_id}.yaml`);
                            if (localFile) {
                              paramData = localFile.data;
                            } else {
                              const { paramRegistryService } = await import('../services/paramRegistryService');
                              paramData = await paramRegistryService.loadParameter(caseData.parameter_id);
                            }
                            
                            if (paramData && paramData.values) {
                              // TODO: Load case data from parameter
                              console.log('Loaded case parameter data:', paramData);
                            }
                          } catch (error) {
                            console.error('Failed to pull case parameter from registry:', error);
                          }
                        }}
                        onPushToRegistry={async () => {
                          // TODO: Implement push to registry
                          console.log('Push to registry not yet implemented');
                        }}
                        label="Case Parameter"
                        placeholder="Select or enter parameter ID..."
                      />
                    ) : (
                      <div style={{ marginBottom: '20px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>
                          Case ID
                        </label>
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
                    </div>
                    )}

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
                                next.nodes[nodeIndex].layout = { x: 0, y: 0 };
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
                                next.nodes[nodeIndex].layout = { x: 0, y: 0 };
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
                                    saveHistoryState('Remove case variant', selectedNodeId || undefined);
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
                            <VariantWeightInput
                              value={variant.weight}
                              onChange={(value) => {
                                const newVariants = [...caseData.variants];
                                newVariants[index].weight = value;
                                setCaseData({...caseData, variants: newVariants});
                              }}
                              onCommit={(value) => {
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
                              onRebalance={(value, currentIndex, variants) => {
                                if (graph && selectedNodeId) {
                                  const rebalanceGraph = structuredClone(graph);
                                  const nodeIndex = rebalanceGraph.nodes.findIndex((n: any) => n.id === selectedNodeId);
                                  if (nodeIndex >= 0 && rebalanceGraph.nodes[nodeIndex].case?.variants) {
                                    rebalanceGraph.nodes[nodeIndex].case.variants[currentIndex].weight = value;
                                    const remainingWeight = 1 - value;
                                    const otherVariants = variants.filter((v: any, i: number) => i !== currentIndex);
                                    const otherVariantsTotal = otherVariants.reduce((sum, v) => sum + (v.weight || 0), 0);
                                    
                                    if (otherVariantsTotal > 0) {
                                      otherVariants.forEach(v => {
                                        const otherIdx = rebalanceGraph.nodes[nodeIndex].case!.variants!.findIndex((variant: any) => variant.name === v.name);
                                        if (otherIdx !== undefined && otherIdx >= 0) {
                                          const currentWeight = v.weight || 0;
                                          const newWeight = (currentWeight / otherVariantsTotal) * remainingWeight;
                                          rebalanceGraph.nodes[nodeIndex].case!.variants![otherIdx].weight = newWeight;
                                        }
                                      });
                                    } else {
                                      const equalShare = remainingWeight / otherVariants.length;
                                      otherVariants.forEach(v => {
                                        const otherIdx = rebalanceGraph.nodes[nodeIndex].case!.variants!.findIndex((variant: any) => variant.name === v.name);
                                        if (otherIdx !== undefined && otherIdx >= 0) {
                                          rebalanceGraph.nodes[nodeIndex].case!.variants![otherIdx].weight = equalShare;
                                        }
                                      });
                                    }
                                    
                                    if (rebalanceGraph.metadata) {
                                      rebalanceGraph.metadata.updated_at = new Date().toISOString();
                                    }
                                    setGraph(rebalanceGraph);
                                    saveHistoryState('Auto-rebalance case variant weights', selectedNodeId);
                                  }
                                }
                              }}
                              currentIndex={index}
                              allVariants={caseData.variants}
                              autoFocus={false}
                              autoSelect={false}
                              showSlider={true}
                              showBalanceButton={true}
                            />
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
                              saveHistoryState('Add case variant', selectedNodeId || undefined);
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
                  </CollapsibleSection>
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

        {selectedEdgeId && (
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

                {/* Parameter ID for probability - connect to parameter registry */}
                <EnhancedSelector
                  type="parameter"
                  parameterType="probability"
                  value={(selectedEdge as any)?.parameter_id || ''}
                  autoFocus={!(selectedEdge as any)?.parameter_id && !selectedEdge?.p?.mean}
                  onChange={(newParamId) => {
                    console.log('PropertiesPanel: EnhancedSelector onChange:', { newParamId });
                    updateEdge('parameter_id', newParamId || undefined);
                  }}
                  onPullFromRegistry={async () => {
                    const currentParamId = (selectedEdge as any)?.parameter_id;
                    if (!currentParamId || !graph || !selectedEdgeId) return;
                    
                    try {
                      let paramData: any = null;
                      const localFile = fileRegistry.getFile(`parameter-${currentParamId}.yaml`);
                      if (localFile) {
                        paramData = localFile.data;
                      } else {
                        const { paramRegistryService } = await import('../services/paramRegistryService');
                        paramData = await paramRegistryService.loadParameter(currentParamId);
                      }
                      
                      if (paramData && paramData.values && paramData.values.length > 0) {
                        const next = structuredClone(graph);
                        const edgeIndex = next.edges.findIndex((e: any) => 
                          e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                        );
                        
                        if (edgeIndex >= 0) {
                          const edge = next.edges[edgeIndex] as any;
                          const primaryValue = paramData.values[paramData.values.length - 1];
                          
                          if (primaryValue.mean !== undefined && primaryValue.mean !== null) {
                            edge.p = { ...edge.p, mean: primaryValue.mean };
                            setLocalEdgeData((prev: any) => ({...prev, probability: primaryValue.mean}));
                          }
                          if (primaryValue.stdev !== undefined && primaryValue.stdev !== null) {
                            edge.p = { ...edge.p, stdev: primaryValue.stdev };
                            setLocalEdgeData((prev: any) => ({...prev, stdev: primaryValue.stdev}));
                          }
                          
                          if (next.metadata) {
                            next.metadata.updated_at = new Date().toISOString();
                          }
                          
                          setGraph(next);
                          saveHistoryState(`Pull probability from registry`, undefined, selectedEdgeId);
                        }
                      }
                    } catch (error) {
                      console.error('Failed to pull from registry:', error);
                    }
                  }}
                  onPushToRegistry={async () => {
                    // TODO: Implement push to registry
                    console.log('Push to registry not yet implemented');
                  }}
                  label="Probability Parameter"
                  placeholder="Select or enter parameter ID..."
                />

                {/* Probability field - shown for all edges, but with different meaning for case edges */}
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>
                    {selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant) 
                      ? 'Sub-Route Probability (within variant)' 
                      : 'Probability'}
                  </label>
                  <ProbabilityInput
                    value={localEdgeData.probability || 0}
                    onChange={(value) => {
                      setLocalEdgeData({...localEdgeData, probability: value});
                    }}
                    onCommit={(value) => {
                          updateEdge('probability', value);
                    }}
                    onRebalance={(value) => {
                      if (graph && selectedEdgeId) {
                        const currentEdge = graph.edges.find((e: any) => e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId);
                        if (!currentEdge) return;
                        
                        const siblings = graph.edges.filter((e: any) => {
                          if (currentEdge.case_id && currentEdge.case_variant) {
                            return e.id !== currentEdge.id && 
                                   e.from === currentEdge.from && 
                                   e.case_id === currentEdge.case_id && 
                                   e.case_variant === currentEdge.case_variant;
                          }
                          return e.id !== currentEdge.id && e.from === currentEdge.from;
                        });
                        
                        if (siblings.length > 0) {
                          const nextGraph = structuredClone(graph);
                          const currentValue = value;
                          const remainingProbability = roundTo4DP(1 - currentValue);
                          
                          const currentEdgeIndex = nextGraph.edges.findIndex((e: any) => e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId);
                          if (currentEdgeIndex >= 0) {
                            nextGraph.edges[currentEdgeIndex].p = { ...nextGraph.edges[currentEdgeIndex].p, mean: currentValue };
                          }
                          
                          const siblingsTotal = siblings.reduce((sum, sibling) => sum + (sibling.p?.mean || 0), 0);
                          
                          if (siblingsTotal > 0) {
                            siblings.forEach(sibling => {
                              const siblingIndex = nextGraph.edges.findIndex((e: any) => e.id === sibling.id);
                              if (siblingIndex >= 0) {
                                const siblingCurrentValue = sibling.p?.mean || 0;
                                const newValue = (siblingCurrentValue / siblingsTotal) * remainingProbability;
                                nextGraph.edges[siblingIndex].p = { ...nextGraph.edges[siblingIndex].p, mean: newValue };
                              }
                            });
                          } else {
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
                          saveHistoryState('Auto-rebalance edge probabilities', undefined, selectedEdgeId);
                        }
                      }
                    }}
                    autoFocus={false}
                    autoSelect={false}
                    showSlider={true}
                    showBalanceButton={true}
                  />
                  {selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant) && (
                    <div style={{ fontSize: '11px', color: '#666', marginTop: '4px' }}>
                      For single-path variants, leave at 1.0. For multi-path variants, probabilities must sum to 1.0.
                    </div>
                  )}
                </div>

                {/* Probability Standard Deviation - for non-case edges */}
                {!(selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant)) && (
                  <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Probability Std Dev</label>
                    <input
                      data-field="stdev"
                      type="number"
                      min="0"
                      step="0.01"
                      value={localEdgeData.stdev !== undefined ? localEdgeData.stdev : ''}
                      onChange={(e) => {
                        const value = e.target.value === '' ? undefined : parseFloat(e.target.value);
                        setLocalEdgeData({...localEdgeData, stdev: value});
                      }}
                      onBlur={() => {
                        updateEdge('stdev', localEdgeData.stdev);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          updateEdge('stdev', localEdgeData.stdev);
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
                  <ConditionalProbabilityEditor
                    conditions={localConditionalP}
                    onChange={(newConditions) => {
                      setLocalConditionalP(newConditions);
                      
                      // Update graph immediately
                      if (selectedEdgeId) {
                        const nextGraph = structuredClone(graph);
                        const edgeIndex = nextGraph.edges.findIndex((e: any) => 
                          e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                        );
                        if (edgeIndex >= 0) {
                          nextGraph.edges[edgeIndex].conditional_p = newConditions.length > 0 ? newConditions as any : undefined;
                          
                          if (!nextGraph.metadata) {
                            nextGraph.metadata = {
                              version: '1.0.0',
                              created_at: new Date().toISOString(),
                              updated_at: new Date().toISOString()
                            };
                          } else {
                            nextGraph.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(nextGraph);
                          saveHistoryState('Update conditional probabilities', undefined, selectedEdgeId || undefined);
                        }
                      }
                    }}
                    graph={graph}
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

                {/* Cost Sections */}
                {selectedEdge && (
                <>
                {/* Monetary Cost Section */}
                <div style={{ marginTop: '12px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: '#333' }}>
                    Monetary Cost (GBP)
                  </div>
                  
                  {/* Parameter Selector */}
                  <EnhancedSelector
                    type="parameter"
                    parameterType="cost_gbp"
                    value={(selectedEdge as any)?.cost_gbp_parameter_id || ''}
                    onChange={(newParamId) => {
                      updateEdge('cost_gbp_parameter_id', newParamId || undefined);
                    }}
                    onPullFromRegistry={async () => {
                      const currentParamId = (selectedEdge as any)?.cost_gbp_parameter_id;
                      if (!currentParamId || !graph || !selectedEdgeId) return;
                      
                      try {
                        let paramData: any = null;
                        const localFile = fileRegistry.getFile(`parameter-${currentParamId}.yaml`);
                        if (localFile) {
                          paramData = localFile.data;
                        } else {
                          const { paramRegistryService } = await import('../services/paramRegistryService');
                          paramData = await paramRegistryService.loadParameter(currentParamId);
                        }
                        
                        if (paramData && paramData.values && paramData.values.length > 0) {
                          const next = structuredClone(graph);
                          const edgeIndex = next.edges.findIndex((e: any) => 
                            e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                          );
                          
                          if (edgeIndex >= 0) {
                            const edge = next.edges[edgeIndex] as any;
                            const sortedValues = [...paramData.values].sort((a, b) => {
                              if (!a.window_from) return -1;
                              if (!b.window_from) return 1;
                              return new Date(b.window_from).getTime() - new Date(a.window_from).getTime();
                            });
                            const latestValue = sortedValues[0];
                            
                            edge.cost_gbp = {
                              mean: latestValue.mean,
                              stdev: latestValue.stdev,
                              distribution: latestValue.distribution
                            };
                            
                            setLocalEdgeData((prev: any) => ({
                              ...prev,
                              cost_gbp: edge.cost_gbp
                            }));
                            
                            if (next.metadata) {
                              next.metadata.updated_at = new Date().toISOString();
                            }
                            
                            setGraph(next);
                            saveHistoryState(`Pull cost GBP from registry`, undefined, selectedEdgeId);
                          }
                        }
                      } catch (error) {
                        console.error('Failed to pull cost_gbp from registry:', error);
                      }
                    }}
                    onPushToRegistry={async () => {
                      // TODO: Implement push to registry
                      console.log('Push to registry not yet implemented');
                    }}
                    label="Cost (£) Parameter"
                    placeholder="Select cost_gbp parameter..."
                  />
                  
                  {/* Manual Input Fields */}
                  <div style={{ marginTop: '8px', fontSize: '11px', color: '#666', marginBottom: '4px' }}>
                    Or enter values manually:
                  </div>
                  {(() => {
                    console.log('Rendering GBP cost inputs. localEdgeData.cost_gbp:', localEdgeData.cost_gbp, 'mean:', localEdgeData.cost_gbp?.mean);
                    return null;
                  })()}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <div>
                      <label style={{ fontSize: '11px', color: '#666' }}>Mean (£)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={localEdgeData.cost_gbp?.mean ?? ''}
                        onChange={(e) => {
                          const newValue = e.target.value === '' ? undefined : parseFloat(e.target.value);
                          console.log('GBP mean onChange:', { newValue, current_cost_gbp: localEdgeData.cost_gbp });
                          setLocalEdgeData((prev: any) => ({
                            ...prev,
                            cost_gbp: { ...(prev.cost_gbp || {}), mean: newValue }
                          }));
                        }}
                        onBlur={() => {
                          if (graph && selectedEdgeId) {
                            const next = structuredClone(graph);
                            const edgeIndex = next.edges.findIndex((e: any) => 
                              e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                            );
                            if (edgeIndex >= 0) {
                              const edge = next.edges[edgeIndex] as any;
                              edge.cost_gbp = { ...edge.cost_gbp, mean: localEdgeData.cost_gbp?.mean };
                              setGraph(next);
                              saveHistoryState(`Update cost GBP mean`, undefined, selectedEdgeId || undefined);
                            }
                          }
                        }}
                            style={{ 
                          width: '100%',
                              padding: '4px 6px', 
                          fontSize: '12px',
                              border: '1px solid #ddd', 
                          borderRadius: '3px'
                        }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '11px', color: '#666' }}>Std Dev</label>
                      <input
                        type="number"
                        step="0.01"
                        value={localEdgeData.cost_gbp?.stdev ?? ''}
                        onChange={(e) => {
                          const newValue = e.target.value === '' ? undefined : parseFloat(e.target.value);
                          setLocalEdgeData((prev: any) => ({
                            ...prev,
                            cost_gbp: { ...prev.cost_gbp, stdev: newValue }
                          }));
                        }}
                        onBlur={() => {
                          if (graph && selectedEdgeId) {
                            const next = structuredClone(graph);
                            const edgeIndex = next.edges.findIndex((e: any) => 
                              e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                            );
                            if (edgeIndex >= 0) {
                              const edge = next.edges[edgeIndex] as any;
                              edge.cost_gbp = { ...edge.cost_gbp, stdev: localEdgeData.cost_gbp?.stdev };
                              setGraph(next);
                              saveHistoryState(`Update cost GBP stdev`, undefined, selectedEdgeId || undefined);
                            }
                          }
                        }}
                            style={{ 
                          width: '100%',
                              padding: '4px 6px', 
                          fontSize: '12px',
                              border: '1px solid #ddd', 
                          borderRadius: '3px'
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* Time Cost Section */}
                <div style={{ marginTop: '12px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: '#333' }}>
                          Time Cost (Days)
                  </div>
                  
                  {/* Parameter Selector */}
                  <EnhancedSelector
                    type="parameter"
                    parameterType="cost_time"
                    value={(selectedEdge as any)?.cost_time_parameter_id || ''}
                    onChange={(newParamId) => {
                      updateEdge('cost_time_parameter_id', newParamId || undefined);
                    }}
                    onPullFromRegistry={async () => {
                      const currentParamId = (selectedEdge as any)?.cost_time_parameter_id;
                      if (!currentParamId || !graph || !selectedEdgeId) return;
                      
                      try {
                        let paramData: any = null;
                        const localFile = fileRegistry.getFile(`parameter-${currentParamId}.yaml`);
                        if (localFile) {
                          paramData = localFile.data;
                        } else {
                          const { paramRegistryService } = await import('../services/paramRegistryService');
                          paramData = await paramRegistryService.loadParameter(currentParamId);
                        }
                        
                        if (paramData && paramData.values && paramData.values.length > 0) {
                          const next = structuredClone(graph);
                          const edgeIndex = next.edges.findIndex((e: any) => 
                            e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                          );
                          
                          if (edgeIndex >= 0) {
                            const edge = next.edges[edgeIndex] as any;
                            const sortedValues = [...paramData.values].sort((a, b) => {
                              if (!a.window_from) return -1;
                              if (!b.window_from) return 1;
                              return new Date(b.window_from).getTime() - new Date(a.window_from).getTime();
                            });
                            const latestValue = sortedValues[0];
                            
                            edge.cost_time = {
                              mean: latestValue.mean,
                              stdev: latestValue.stdev,
                              distribution: latestValue.distribution
                            };
                            
                            setLocalEdgeData((prev: any) => ({
                              ...prev,
                              cost_time: edge.cost_time
                            }));
                            
                            if (next.metadata) {
                              next.metadata.updated_at = new Date().toISOString();
                            }
                            
                            setGraph(next);
                            saveHistoryState(`Pull cost time from registry`, undefined, selectedEdgeId);
                          }
                        }
                      } catch (error) {
                        console.error('Failed to pull cost_time from registry:', error);
                      }
                    }}
                    onPushToRegistry={async () => {
                      // TODO: Implement push to registry
                      console.log('Push to registry not yet implemented');
                    }}
                    label="Cost (Time) Parameter"
                    placeholder="Select cost_time parameter..."
                  />
                  
                  {/* Manual Input Fields */}
                  <div style={{ marginTop: '8px', fontSize: '11px', color: '#666', marginBottom: '4px' }}>
                    Or enter values manually:
                        </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <div>
                      <label style={{ fontSize: '11px', color: '#666' }}>Mean (days)</label>
                          <input
                            type="number"
                        step="0.01"
                        value={localEdgeData.cost_time?.mean ?? ''}
                        onChange={(e) => {
                          const newValue = e.target.value === '' ? undefined : parseFloat(e.target.value);
                          setLocalEdgeData((prev: any) => ({
                            ...prev,
                            cost_time: { ...prev.cost_time, mean: newValue }
                          }));
                        }}
                        onBlur={() => {
                          if (graph && selectedEdgeId) {
                            const next = structuredClone(graph);
                            const edgeIndex = next.edges.findIndex((e: any) => 
                              e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                            );
                            if (edgeIndex >= 0) {
                              const edge = next.edges[edgeIndex] as any;
                              edge.cost_time = { ...edge.cost_time, mean: localEdgeData.cost_time?.mean };
                              setGraph(next);
                              saveHistoryState(`Update cost time mean`, undefined, selectedEdgeId || undefined);
                            }
                          }
                        }}
                            style={{ 
                          width: '100%',
                              padding: '4px 6px', 
                          fontSize: '12px',
                              border: '1px solid #ddd', 
                          borderRadius: '3px'
                        }}
                      />
                        </div>
                    <div>
                      <label style={{ fontSize: '11px', color: '#666' }}>Std Dev</label>
                      <input
                        type="number"
                        step="0.01"
                        value={localEdgeData.cost_time?.stdev ?? ''}
                        onChange={(e) => {
                          const newValue = e.target.value === '' ? undefined : parseFloat(e.target.value);
                          setLocalEdgeData((prev: any) => ({
                            ...prev,
                            cost_time: { ...prev.cost_time, stdev: newValue }
                          }));
                        }}
                        onBlur={() => {
                          if (graph && selectedEdgeId) {
                            const next = structuredClone(graph);
                            const edgeIndex = next.edges.findIndex((e: any) => 
                              e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                            );
                            if (edgeIndex >= 0) {
                              const edge = next.edges[edgeIndex] as any;
                              edge.cost_time = { ...edge.cost_time, stdev: localEdgeData.cost_time?.stdev };
                              setGraph(next);
                              saveHistoryState(`Update cost time stdev`, undefined, selectedEdgeId || undefined);
                            }
                            }
                          }}
                          style={{
                          width: '100%',
                          padding: '4px 6px',
                          fontSize: '12px',
                          border: '1px solid #ddd',
                          borderRadius: '3px'
                        }}
                      />
                      </div>
                  </div>
                </div>
                </>
                )}

                {selectedEdge && (
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
                )}

                {selectedEdge && (
                <button
                  onClick={() => {
                    const next = structuredClone(graph);
                    next.edges = next.edges.filter((e: any) => 
                      e.id !== selectedEdgeId && `${e.from}->${e.to}` !== selectedEdgeId
                    );
                    setGraph(next);
                    saveHistoryState('Delete edge', undefined, selectedEdgeId || undefined);
                    onSelectedEdgeChange(null);
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
                )}
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: '#666', padding: '20px' }}>
                No edge selected
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
