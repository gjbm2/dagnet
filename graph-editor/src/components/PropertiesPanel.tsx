import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useTabContext, fileRegistry } from '../contexts/TabContext';
import { generateIdFromLabel, generateUniqueId } from '@/lib/idUtils';
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
import { QueryExpressionEditor } from './QueryExpressionEditor';
import { getObjectTypeTheme } from '../theme/objectTypeTheme';
import { Box, Settings, Layers, Edit3, ChevronDown, ChevronRight, X, Sliders, Info, TrendingUp, Coins, Clock, FileJson } from 'lucide-react';
import './PropertiesPanel.css';

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
  const [caseData, setCaseData] = useState({
    id: '',
    parameter_id: '',
    status: 'active' as 'active' | 'paused' | 'completed',
    variants: [] as Array<{ name: string; weight: number }>
  });
  
  // Track which variants are collapsed (by index)
  const [collapsedVariants, setCollapsedVariants] = useState<Set<number>>(new Set());
  
  // Track which variant is being edited (name)
  const [editingVariantIndex, setEditingVariantIndex] = useState<number | null>(null);
  
  // Track if user has manually edited the id to prevent auto-generation
  const [idManuallyEdited, setIdManuallyEdited] = useState<boolean>(false);
  
  // Track if this node has ever had its label committed (to prevent id regeneration)
  const hasLabelBeenCommittedRef = useRef<{ [nodeId: string]: boolean }>({});
  
  // Local state for conditional probabilities (like variants)
  const [localConditionalP, setLocalConditionalP] = useState<any[]>([]);
  const lastLoadedEdgeRef = useRef<string | null>(null);
  
  // Track which conditional probabilities are collapsed (by index) - true = collapsed, false/undefined = expanded
  const [collapsedConditionals, setCollapsedConditionals] = useState<{ [key: number]: boolean }>({});

  // Helper to open a file by type and ID
  const openFileById = useCallback((type: 'case' | 'node' | 'parameter' | 'context', id: string) => {
    const fileId = `${type}-${id}`;
    
    // Check if file is already open in a tab
    const existingTab = tabs.find(tab => tab.fileId === fileId);
    
    if (existingTab) {
      // Navigate to existing tab
      tabOps.switchTab(existingTab.id);
    } else {
      // Open new tab
      const item = {
        id,
        type,
        name: id,
        path: `${type}/${id}`,
      };
      tabOps.openTab(item, 'interactive', false);
    }
  }, [tabs, tabOps]);
  

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
        // Find node by UUID or human-readable ID (Phase 0.0 migration)
        const node = graph.nodes.find((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
        if (node) {
          console.log('PropertiesPanel: Reloading node data from graph, id:', node.id);
          setLocalNodeData({
            label: node.label || '',
            id: node.id || '',
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
          } else {
            console.log('Loading normal node');
            setNodeType('normal');
            setCaseData({
              id: '',
              parameter_id: '',
              status: 'active',
              variants: []
            });
          }
          
          // Reset manual edit flag when switching to a different node
          setIdManuallyEdited(false);
          
          // Mark node as having committed label if it already has a label
          // This prevents id from auto-updating on subsequent label edits
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

  // Reload node data when graph changes (for undo/redo support)
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [PropertiesPanel] useEffect#PP1b: Graph changed, reloading selected node`);
    if (selectedNodeId && graph && lastLoadedNodeRef.current === selectedNodeId) {
      const node = graph.nodes.find((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
      if (node) {
        console.log('PropertiesPanel: Reloading node data after graph change, id:', node.id);
        setLocalNodeData({
          label: node.label || '',
          id: node.id || '',
          description: node.description || '',
          absorbing: node.absorbing || false,
          outcome_type: node.outcome_type,
          tags: node.tags || [],
          entry: node.entry || {},
        });
        
        // Handle case node data
        if (node.type === 'case' && node.case) {
          console.log('Reloading case node after graph change:', node.case);
          setNodeType('case');
          setCaseData({
            id: node.case.id || '',
            parameter_id: node.case.parameter_id || '',
            status: node.case.status || 'active',
            variants: node.case.variants || []
          });
        } else {
          setNodeType('normal');
          setCaseData({
            id: '',
            parameter_id: '',
            status: 'active',
            variants: []
          });
        }
      }
    }
  }, [graph, selectedNodeId]);

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
            id: edge.id || '',
            parameter_id: (edge as any).parameter_id || '',
            cost_gbp_parameter_id: (edge as any).cost_gbp_parameter_id || '',
            cost_time_parameter_id: (edge as any).cost_time_parameter_id || '',
            probability: edge.p?.mean || 0,
            stdev: edge.p?.stdev || undefined,
            description: edge.description || '',
            cost_gbp: edgeCostGbp,
            cost_time: edgeCostTime,
            weight_default: edge.weight_default || 0,
            display: edge.display || {},
            locked: edge.p?.locked || false,
            query: (edge as any).query || ''
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

  // Auto-generate id from label when label changes (only on FIRST commit)
  // This updates the LOCAL state only, not the graph state
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [PropertiesPanel] useEffect#PP3: Auto-generate id`);
    if (selectedNodeId && graph && localNodeData.label && !idManuallyEdited) {
      // Check if the node actually exists in the graph to prevent race conditions
      const nodeExists = graph.nodes.some((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
      if (!nodeExists) {
        return;
      }
      
      // For new nodes (no committed label yet), always regenerate id
      // For existing nodes, only regenerate if label hasn't been committed yet
      const shouldRegenerateId = !hasLabelBeenCommittedRef.current[selectedNodeId];
      
      if (shouldRegenerateId) {
        const baseId = generateIdFromLabel(localNodeData.label);
        if (baseId && baseId !== localNodeData.id) {
          // Get all existing ids (excluding current node)
          const existingIds = graph.nodes
            .filter((n: any) => n.id !== selectedNodeId)
            .map((n: any) => n.id)
            .filter(Boolean);
          
          const uniqueId = generateUniqueId(baseId, existingIds);
          
          // Only update LOCAL state if the id is actually different
          if (uniqueId !== localNodeData.id) {
            setLocalNodeData(prev => ({
              ...prev,
              id: uniqueId
            }));
          }
        }
      }
    }
  }, [localNodeData.label, selectedNodeId, graph, idManuallyEdited]);
  
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
            id: edge.id || '',
            parameter_id: (edge as any).parameter_id || '',
            cost_gbp_parameter_id: (edge as any).cost_gbp_parameter_id || '',
            cost_time_parameter_id: (edge as any).cost_time_parameter_id || '',
            probability: edge.p?.mean || 0,
            stdev: edge.p?.stdev,
            locked: edge.p?.locked || false,
            description: edge.description || '',
            cost_gbp: (edge as any).cost_gbp,
            cost_time: (edge as any).cost_time,
            costs: edge.costs || {},
            weight_default: edge.weight_default || 0,
            display: edge.display || {}
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
            id: edge.id || '',
            parameter_id: (edge as any).parameter_id || '',
            cost_gbp_parameter_id: (edge as any).cost_gbp_parameter_id || '',
            cost_time_parameter_id: (edge as any).cost_time_parameter_id || '',
            probability: edge.p?.mean || 0,
            stdev: edge.p?.stdev,
            locked: edge.p?.locked || false,
            description: edge.description || '',
            cost_gbp: (edge as any).cost_gbp,
            cost_time: (edge as any).cost_time,
            costs: edge.costs || {},
            weight_default: edge.weight_default || 0,
            display: edge.display || {}
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
      const target = e.target as HTMLElement;
      
      // Esc key: blur active field if in input/textarea
      if (e.key === 'Escape') {
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
          target.blur();
          console.log('PropertiesPanel: Blurred field on Esc');
          e.preventDefault();
          return;
        }
      }
      
      // Don't handle other shortcuts when user is typing in form fields
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      
      // Note: Delete key handling is done by GraphCanvas, not here
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedEdgeId, graph, setGraph, onSelectedEdgeChange]);

  // Listen for field focus requests
  useEffect(() => {
    const handleFocusField = (e: CustomEvent) => {
      const { field } = e.detail;
      console.log('PropertiesPanel: Focus field request:', field);
      
      // Wait for next tick to ensure DOM is ready
      setTimeout(() => {
        const element = document.querySelector(`[data-field="${field}"]`) as HTMLInputElement | HTMLTextAreaElement;
        if (element) {
          element.focus();
          element.select(); // Select all text for easy editing
          console.log('PropertiesPanel: Focused and selected field:', field);
        }
      }, 100);
    };

    window.addEventListener('dagnet:focusField' as any, handleFocusField as EventListener);
    return () => window.removeEventListener('dagnet:focusField' as any, handleFocusField as EventListener);
  }, []);

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
    // Find node by UUID or human-readable ID (Phase 0.0 migration)
    const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
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
  const selectedNode = selectedNodeId && graph.nodes ? graph.nodes.find((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId) : null;
  const selectedEdge = selectedEdgeId && graph.edges ? graph.edges.find((e: any) => 
    e.uuid === selectedEdgeId || e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
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
    <div className="properties-panel">
      {/* Content */}
      <div className="properties-panel-content">
        {!selectedNodeId && !selectedEdgeId && (
          <>
            <CollapsibleSection title="Graph Metadata" defaultOpen={true} icon={FileJson}>
              <div className="property-section">
                <label className="property-label">Description</label>
                <textarea
                  className="property-input"
                  value={graph.metadata?.description || ''}
                  onChange={(e) => updateGraph(['metadata', 'description'], e.target.value)}
                  placeholder="Enter graph description..."
                />
              </div>

              <div className="property-section">
                <label className="property-label">Version</label>
                <input
                  className="property-input"
                  value={graph.metadata?.version || ''}
                  onChange={(e) => updateGraph(['metadata', 'version'], e.target.value)}
                  placeholder="1.0.0"
                />
              </div>

              <div className="property-section">
                <label className="property-label">Author</label>
                <input
                  className="property-input"
                  value={graph.metadata?.author || ''}
                  onChange={(e) => updateGraph(['metadata', 'author'], e.target.value)}
                  placeholder="Your name"
                />
              </div>
            </CollapsibleSection>
          </>
        )}

        {selectedNodeId && (
          <div>
            {selectedNode ? (
              <div>
                {/* Basic Properties Section */}
                <CollapsibleSection title="Basic Properties" defaultOpen={true} icon={Box}>
                  {/* ID (Connection Field) - FIRST per spec */}
                  <EnhancedSelector
                  type="node"
                  value={localNodeData.id || ''}
                  autoFocus={!localNodeData.id}
                  onChange={(newId) => {
                    console.log('PropertiesPanel: EnhancedSelector onChange:', { newId: newId, currentId: localNodeData.id });
                    
                    // Update local state immediately
                    setLocalNodeData({...localNodeData, id: newId});
                    setIdManuallyEdited(true);
                    
                    // Update the graph with new id
                    updateNode('id', newId);
                  }}
                  onClear={() => {
                    // No need to save history - onChange already does it via updateNode
                  }}
                  onPullFromRegistry={async () => {
                    if (!localNodeData.id || !graph || !selectedNodeId) return;
                    
                    try {
                      const { paramRegistryService } = await import('../services/paramRegistryService');
                      const nodeData = await paramRegistryService.loadNode(localNodeData.id);
                      
                      if (nodeData) {
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                        
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
                  onOpenConnected={() => {
                    if (localNodeData.id) {
                      openFileById('node', localNodeData.id);
                    }
                  }}
                  onOpenItem={(itemId) => {
                    openFileById('node', itemId);
                  }}
                  label="Node ID"
                  placeholder="Select or enter node ID..."
                />

                  {/* Label */}
                  <div className="property-section">
                    <label className="property-label">Label</label>
                    <input
                      className="property-input"
                      data-field="label"
                      value={localNodeData.label || ''}
                      onChange={(e) => setLocalNodeData({...localNodeData, label: e.target.value})}
                      onBlur={() => {
                        if (!graph || !selectedNodeId) return;
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                        if (nodeIndex >= 0) {
                          next.nodes[nodeIndex].label = localNodeData.label;
                          if (!idManuallyEdited && localNodeData.id && !hasLabelBeenCommittedRef.current[selectedNodeId]) {
                            next.nodes[nodeIndex].id = localNodeData.id;
                          }
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
                          if (!graph || !selectedNodeId) return;
                          const next = structuredClone(graph);
                          const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                          if (nodeIndex >= 0) {
                            next.nodes[nodeIndex].label = localNodeData.label;
                            if (!idManuallyEdited && localNodeData.id && !hasLabelBeenCommittedRef.current[selectedNodeId]) {
                              next.nodes[nodeIndex].id = localNodeData.id;
                            }
                            hasLabelBeenCommittedRef.current[selectedNodeId] = true;
                            if (next.metadata) {
                              next.metadata.updated_at = new Date().toISOString();
                            }
                            setGraph(next);
                            saveHistoryState('Update node label', selectedNodeId);
                          }
                        }
                      }}
                      placeholder="Enter node label..."
                    />
                  </div>

                  {/* Description */}
                  <div className="property-section">
                    <label className="property-label">Description</label>
                    <textarea
                      className="property-input"
                      value={localNodeData.description || ''}
                      onChange={(e) => setLocalNodeData({...localNodeData, description: e.target.value})}
                      onBlur={() => updateNode('description', localNodeData.description)}
                      placeholder="Enter description..."
                    />
                  </div>

                  {/* Tags */}
                  <div className="property-section">
                    <label className="property-label">Tags</label>
                    <input
                      className="property-input"
                      value={localNodeData.tags?.join(', ') || ''}
                      onChange={(e) => {
                        const tags = e.target.value.split(',').map(t => t.trim()).filter(t => t);
                        setLocalNodeData({...localNodeData, tags});
                      }}
                      onBlur={() => updateNode('tags', localNodeData.tags)}
                      placeholder="tag1, tag2, tag3"
                    />
                    <div className="property-helper-text">Comma-separated tags</div>
                  </div>
                </CollapsibleSection>

                {/* Node Behavior Section */}
                <CollapsibleSection title="Node Behavior" defaultOpen={true} icon={Settings}>
                  <label className="property-checkbox-label">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.entry?.is_start)}
                      onChange={(e) => {
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
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

                  <label className="property-checkbox-label">
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

                  <div className="property-section">
                    <label className="property-label">Outcome Type</label>
                    <select
                      className="property-input"
                      value={localNodeData.outcome_type || ''}
                      onChange={(e) => {
                        const newValue = e.target.value === '' ? undefined : e.target.value;
                        setLocalNodeData({...localNodeData, outcome_type: newValue});
                        updateNode('outcome_type', newValue);
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

                  <div className="property-section">
                    <label className="property-label">Entry Weight</label>
                    <input
                      className="property-input"
                      type="number"
                      min="0"
                      step="0.1"
                      value={selectedNode.entry?.entry_weight ?? ''}
                      onChange={(e) => {
                        const val = e.target.value === '' ? undefined : parseFloat(e.target.value);
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
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
                    />
                  </div>
                </CollapsibleSection>

                {/* Case Configuration - Checkbox-enabled collapsible */}
                <CollapsibleSection 
                  title="Case Configuration" 
                  defaultOpen={false}
                  icon={Layers}
                  withCheckbox={true}
                  checkboxChecked={nodeType === 'case'}
                  onCheckboxChange={(checked) => {
                    if (checked) {
                      setNodeType('case');
                      const newCaseData = caseData.variants.length === 0 ? {
                        id: `case_${Date.now()}`,
                        parameter_id: '',
                        status: 'active' as 'active' | 'paused' | 'completed',
                        variants: [
                          { name: 'control', weight: 0.5 },
                          { name: 'treatment', weight: 0.5 }
                        ]
                      } : caseData;
                      setCaseData(newCaseData);
                      
                      if (graph && selectedNodeId) {
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                        if (nodeIndex >= 0) {
                          next.nodes[nodeIndex].type = 'case';
                          next.nodes[nodeIndex].case = {
                            id: newCaseData.id,
                            parameter_id: newCaseData.parameter_id,
                            status: newCaseData.status,
                            variants: newCaseData.variants
                          };
                          if (!next.nodes[nodeIndex].layout) {
                            next.nodes[nodeIndex].layout = { x: 0, y: 0 };
                          }
                          if (!next.nodes[nodeIndex].layout!.color) {
                            next.nodes[nodeIndex].layout!.color = getNextAvailableColor(graph as any);
                          }
                          if (next.metadata) {
                            next.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(next);
                        }
                      }
                    } else {
                      setNodeType('normal');
                      setCaseData({
                        id: '',
                        parameter_id: '',
                        status: 'active',
                        variants: []
                      });
                      if (graph && selectedNodeId) {
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                        if (nodeIndex >= 0) {
                          delete next.nodes[nodeIndex].type;
                          delete next.nodes[nodeIndex].case;
                          if (next.metadata) {
                            next.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(next);
                        }
                      }
                    }
                  }}
                >
                  {nodeType === 'case' && (
                  <>
                    {/* Case ID Selector */}
                    <EnhancedSelector
                      type="case"
                      value={caseData.id}
                      onChange={(newCaseId) => {
                        setCaseData({...caseData, id: newCaseId});
                        if (graph && selectedNodeId) {
                          const next = structuredClone(graph);
                          const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                          if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                            next.nodes[nodeIndex].case.id = newCaseId;
                            if (next.metadata) {
                              next.metadata.updated_at = new Date().toISOString();
                            }
                            setGraph(next);
                            saveHistoryState(newCaseId ? 'Update case ID' : 'Clear case ID', selectedNodeId || undefined);
                          }
                        }
                      }}
                      onClear={() => {
                        // onClear is redundant since onChange handles it, but keep for consistency
                      }}
                      onOpenConnected={() => {
                        if (caseData.id) {
                          openFileById('case', caseData.id);
                        }
                      }}
                      onOpenItem={(itemId) => {
                        openFileById('case', itemId);
                        }}
                        onPullFromRegistry={async () => {
                        if (!caseData.id || !graph || !selectedNodeId) return;
                          
                          try {
                          let caseRegistryData: any = null;
                          const localFile = fileRegistry.getFile(`case-${caseData.id}`);
                            if (localFile) {
                            caseRegistryData = localFile.data;
                            } else {
                              const { paramRegistryService } = await import('../services/paramRegistryService');
                            caseRegistryData = await paramRegistryService.loadCase(caseData.id);
                          }
                          
                          if (caseRegistryData) {
                            // Pull case configuration from registry
                            const newCaseData = {
                              id: caseData.id,
                              parameter_id: caseData.parameter_id,
                              status: caseRegistryData.status || caseData.status,
                              variants: caseRegistryData.variants || caseData.variants
                            };
                            setCaseData(newCaseData);
                            
                            if (graph && selectedNodeId) {
                              const next = structuredClone(graph);
                              const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                              if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                next.nodes[nodeIndex].case = newCaseData;
                                if (next.metadata) {
                                  next.metadata.updated_at = new Date().toISOString();
                                }
                                setGraph(next);
                              }
                            }
                            console.log('Pulled case configuration from registry:', caseRegistryData);
                          }
                        } catch (error) {
                          console.error('Failed to pull case from registry:', error);
                        }
                      }}
                      onPushToRegistry={async () => {
                        // TODO: Implement push to registry
                        console.log('Push case to registry not yet implemented');
                      }}
                      label="Case ID"
                      placeholder="Select or enter case ID..."
                    />

                    {/* Case Status */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px' }}>
                      <label style={{ fontSize: '12px', color: '#6B7280', minWidth: 'auto', whiteSpace: 'nowrap' }}>Status</label>
                      <select
                        value={caseData.status}
                        onChange={(e) => {
                          const newStatus = e.target.value as 'active' | 'paused' | 'completed';
                          setCaseData({...caseData, status: newStatus});
                          if (graph && selectedNodeId) {
                            const next = structuredClone(graph);
                            const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
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
                          width: '150px', 
                          padding: '6px 8px', 
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
                    <ColorSelector
                      label="Node Color"
                        value={(() => {
                          const node = graph?.nodes.find((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                        return node?.layout?.color || '#10B981'; // Default to green (first preset) if none assigned
                        })()}
                      onChange={(color) => {
                          if (graph && selectedNodeId) {
                            const next = structuredClone(graph);
                            const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                            if (nodeIndex >= 0) {
                              if (!next.nodes[nodeIndex].layout) {
                                next.nodes[nodeIndex].layout = { x: 0, y: 0 };
                              }
                            next.nodes[nodeIndex].layout.color = color;
                              if (next.metadata) {
                                next.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(next);
                            saveHistoryState('Change node color', selectedNodeId || undefined);
                          }
                        }
                      }}
                    />

                    {/* Variants Section */}
                    <div style={{ marginBottom: '20px' }}>
                      <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Variants</label>
                      {caseData.variants.map((variant, index) => {
                        const isCollapsed = collapsedVariants.has(index);
                        const isEditing = editingVariantIndex === index;
                        
                        return (
                          <div key={index} className="variant-card">
                            {/* Collapsible Header with Name */}
                            <div 
                              className="variant-card-header"
                              style={{ cursor: 'pointer', userSelect: 'none' }}
                              onClick={(e) => {
                                // Only toggle if not clicking on edit button or remove button
                                if (!(e.target as HTMLElement).closest('button')) {
                                  const newCollapsed = new Set(collapsedVariants);
                                  if (isCollapsed) {
                                    newCollapsed.delete(index);
                                  } else {
                                    newCollapsed.add(index);
                                  }
                                  setCollapsedVariants(newCollapsed);
                                }
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                                {/* Collapse/Expand Icon */}
                                {isCollapsed ? (
                                  <ChevronRight size={16} style={{ color: '#6B7280', flexShrink: 0 }} />
                                ) : (
                                  <ChevronDown size={16} style={{ color: '#6B7280', flexShrink: 0 }} />
                                )}
                                
                                {/* Editable Name */}
                                {isEditing ? (
                                  <input
                                    type="text"
                                    value={variant.name}
                                    onChange={(e) => {
                          e.stopPropagation();
                                      const newVariants = [...caseData.variants];
                                      newVariants[index].name = e.target.value;
                                      setCaseData({...caseData, variants: newVariants});
                                    }}
                                    onBlur={() => {
                                      setEditingVariantIndex(null);
                          if (graph && selectedNodeId) {
                            const next = structuredClone(graph);
                            const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                                        if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                          next.nodes[nodeIndex].case.variants = caseData.variants;
                              if (next.metadata) {
                                next.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(next);
                                          saveHistoryState('Rename variant', selectedNodeId || undefined);
                                        }
                                      }
                                    }}
                                    onKeyDown={(e) => {
                                      e.stopPropagation();
                                      if (e.key === 'Enter') {
                                        (e.target as HTMLInputElement).blur();
                                      }
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    autoFocus
                        style={{
                                      flex: 1,
                                      border: '1px solid #8B5CF6',
                                      borderRadius: '3px',
                                      padding: '2px 6px',
                                      fontSize: '13px',
                                      fontWeight: 600,
                                      color: '#374151',
                                      minWidth: 0
                                    }}
                                  />
                                ) : (
                                  <>
                                    <span className="variant-card-title" style={{ flex: 1, minWidth: 0 }}>
                                      {variant.name}
                                    </span>
                                    {/* Edit Button */}
                          <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setEditingVariantIndex(index);
                            }}
                            style={{
                                        background: 'transparent',
                                        border: 'none',
                                        cursor: 'pointer',
                                        padding: '4px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        color: '#9CA3AF',
                                        transition: 'color 0.15s'
                                      }}
                                      onMouseEnter={(e) => e.currentTarget.style.color = '#6B7280'}
                                      onMouseLeave={(e) => e.currentTarget.style.color = '#9CA3AF'}
                                      title="Edit name"
                                    >
                                      <Edit3 size={14} />
                          </button>
                                  </>
                                )}
                    </div>

                              {/* Remove Button - hide when editing to avoid confusion */}
                              {!isEditing && (
                            <button
                              type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                const newVariants = caseData.variants.filter((_, i) => i !== index);
                                setCaseData({...caseData, variants: newVariants});
                                    // Remove from collapsed set
                                    const newCollapsed = new Set(collapsedVariants);
                                    newCollapsed.delete(index);
                                    setCollapsedVariants(newCollapsed);
                                    
                                if (graph && selectedNodeId) {
                                  const next = structuredClone(graph);
                                  const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
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
                                  className="variant-remove-btn"
                                >
                                  ✕
                            </button>
                              )}
                          </div>
                          
                            {/* Collapsible Content */}
                            {!isCollapsed && (
                              <div style={{ paddingTop: '8px' }}>
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
                                  const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                                  if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                    next.nodes[nodeIndex].case.variants = caseData.variants;
                                    if (next.metadata) {
                                      next.metadata.updated_at = new Date().toISOString();
                                    }
                                    setGraph(next);
                                        saveHistoryState('Update variant weight', selectedNodeId || undefined);
                                  }
                                }
                              }}
                              onRebalance={(value, currentIndex, variants) => {
                                if (graph && selectedNodeId) {
                                  const rebalanceGraph = structuredClone(graph);
                                  const nodeIndex = rebalanceGraph.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
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
                                              // Round to 3 decimal places
                                              rebalanceGraph.nodes[nodeIndex].case!.variants![otherIdx].weight = Math.round(newWeight * 1000) / 1000;
                                        }
                                      });
                                    } else {
                                      const equalShare = remainingWeight / otherVariants.length;
                                      otherVariants.forEach(v => {
                                        const otherIdx = rebalanceGraph.nodes[nodeIndex].case!.variants!.findIndex((variant: any) => variant.name === v.name);
                                        if (otherIdx !== undefined && otherIdx >= 0) {
                                              // Round to 3 decimal places
                                              rebalanceGraph.nodes[nodeIndex].case!.variants![otherIdx].weight = Math.round(equalShare * 1000) / 1000;
                                        }
                                      });
                                    }
                                    
                                    if (rebalanceGraph.metadata) {
                                      rebalanceGraph.metadata.updated_at = new Date().toISOString();
                                    }
                                    setGraph(rebalanceGraph);
                                        setCaseData({...caseData, variants: rebalanceGraph.nodes[nodeIndex].case!.variants!});
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
                            )}
                          </div>
                        );
                      })}
                      
                      <button
                        type="button"
                        onClick={() => {
                          const newVariants = [...caseData.variants, { name: `variant_${caseData.variants.length + 1}`, weight: 0.1 }];
                          setCaseData({...caseData, variants: newVariants});
                          if (graph && selectedNodeId) {
                            const next = structuredClone(graph);
                            const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
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
                        className="property-add-btn"
                        style={{ width: '100%' }}
                      >
                        + Add Variant
                      </button>
                    </div>
                  </>
                  )}
                </CollapsibleSection>
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
                {/* SECTION 1: Basic Properties */}
                <CollapsibleSection title="Basic Properties" icon={Settings} defaultOpen={true}>
                  {/* ID */}
                  <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>ID</label>
                  <input
                    data-field="id"
                    value={localEdgeData.id || ''}
                    onChange={(e) => setLocalEdgeData({...localEdgeData, id: e.target.value})}
                    onBlur={() => updateEdge('id', localEdgeData.id)}
                    onKeyDown={(e) => e.key === 'Enter' && updateEdge('id', localEdgeData.id)}
                    placeholder="edge-id"
                    style={{ 
                      width: '100%', 
                      padding: '8px', 
                      border: '1px solid #ddd', 
                      borderRadius: '4px',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                  {/* Description */}
                  <div style={{ marginBottom: '16px' }}>
                    <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Description</label>
                    <textarea
                      data-field="description"
                      value={localEdgeData.description || ''}
                      onChange={(e) => setLocalEdgeData({...localEdgeData, description: e.target.value})}
                      onBlur={() => updateEdge('description', localEdgeData.description)}
                      placeholder="Edge description..."
                      style={{ 
                        width: '100%', 
                        padding: '8px', 
                        border: '1px solid #ddd', 
                        borderRadius: '4px',
                        boxSizing: 'border-box',
                        minHeight: '60px',
                        resize: 'vertical',
                        fontFamily: 'inherit'
                      }}
                    />
                  </div>

                  {/* Weight Default - now shown for ALL edges */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: '#6B7280', minWidth: 'auto', whiteSpace: 'nowrap' }}>
                      Weight Default
                      <span title="Used to distribute residual probability among unspecified edges from the same source">
                        <Info 
                          size={14} 
                          style={{ color: '#9CA3AF', cursor: 'help' }}
                        />
                      </span>
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={localEdgeData.weight_default || 0}
                      onChange={(e) => setLocalEdgeData({...localEdgeData, weight_default: parseFloat(e.target.value) || 0})}
                      onBlur={() => updateEdge('weight_default', localEdgeData.weight_default)}
                      onKeyDown={(e) => e.key === 'Enter' && updateEdge('weight_default', localEdgeData.weight_default)}
                      placeholder="0.0"
                      style={{ 
                        width: '120px',
                        padding: '6px 8px', 
                        border: '1px solid #ddd', 
                        borderRadius: '4px',
                        boxSizing: 'border-box'
                      }}
                    />
                  </div>
                </CollapsibleSection>

                {/* SECTION 2: Parameters */}
                <CollapsibleSection title="Parameters" icon={Layers} defaultOpen={true}>
                  {/* SUB-SECTION 2.1: Probability */}
                  <CollapsibleSection title="Probability" icon={TrendingUp} defaultOpen={true}>
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
                      onClear={() => {
                        // No need to save history - onChange already does it via updateEdge
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
                  onOpenConnected={() => {
                    const paramId = (selectedEdge as any)?.parameter_id;
                    if (paramId) {
                      openFileById('parameter', paramId);
                    }
                  }}
                  onOpenItem={(itemId) => {
                    openFileById('parameter', itemId);
                  }}
                  label=""
                  placeholder="Select or enter parameter ID..."
                />

                {/* Query Expression Editor - for data retrieval constraints */}
                {(selectedEdge as any)?.parameter_id && (
                  <div style={{ marginTop: '16px', marginBottom: '16px' }}>
                    <label style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: '4px', 
                      marginBottom: '8px', 
                      fontSize: '12px', 
                      color: '#6B7280',
                      fontWeight: '500'
                    }}>
                      Data Retrieval Query
                      <span title="Define constraints for retrieving data from external sources (e.g., Amplitude). Uses node IDs to specify path constraints.">
                        <Info 
                          size={14} 
                          style={{ color: '#9CA3AF', cursor: 'help' }}
                        />
                      </span>
                    </label>
                    <QueryExpressionEditor
                      value={localEdgeData.query || ''}
                      onChange={(newQuery) => {
                        setLocalEdgeData({...localEdgeData, query: newQuery});
                      }}
                      onBlur={() => {
                        if (localEdgeData.query !== (selectedEdge as any)?.query) {
                          updateEdge('query', localEdgeData.query);
                        }
                      }}
                      graph={graph}
                      edgeId={selectedEdgeId || undefined}
                      placeholder="from(node).to(node).exclude(...)"
                      height="60px"
                    />
                    <div style={{ 
                      fontSize: '11px', 
                      color: '#6B7280', 
                      marginTop: '4px',
                      fontStyle: 'italic'
                    }}>
                      Example: from(checkout).to(purchase).exclude(abandoned-cart)
                    </div>
                  </div>
                )}

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
                    isUnbalanced={(() => {
                      if (!graph || !selectedEdge) return false;
                      const currentEdge = selectedEdge;
                      const siblings = graph.edges.filter((e: any) => {
                        if (currentEdge.case_id && currentEdge.case_variant) {
                          return e.from === currentEdge.from && 
                                 e.case_id === currentEdge.case_id && 
                                 e.case_variant === currentEdge.case_variant;
                        }
                        return e.from === currentEdge.from;
                      });
                      const total = siblings.reduce((sum, e: any) => sum + (e.p?.mean || 0), 0);
                      return Math.abs(total - 1.0) > 0.001; // Allow small floating point errors
                    })()}
                    onRebalance={(value) => {
                      if (graph && selectedEdgeId) {
                        const currentEdge = graph.edges.find((e: any) => e.uuid === selectedEdgeId || e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId);
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
                          
                          const currentEdgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === selectedEdgeId || e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId);
                          if (currentEdgeIndex >= 0) {
                            nextGraph.edges[currentEdgeIndex].p = { ...nextGraph.edges[currentEdgeIndex].p, mean: currentValue };
                          }
                          
                          const siblingsTotal = siblings.reduce((sum, sibling) => sum + (sibling.p?.mean || 0), 0);
                          
                          if (siblingsTotal > 0) {
                            siblings.forEach(sibling => {
                              const siblingIndex = nextGraph.edges.findIndex((e: any) => (e.uuid === sibling.uuid && e.uuid) || (e.id === sibling.id && e.id));
                              if (siblingIndex >= 0) {
                                const siblingCurrentValue = sibling.p?.mean || 0;
                                const newValue = (siblingCurrentValue / siblingsTotal) * remainingProbability;
                                nextGraph.edges[siblingIndex].p = { ...nextGraph.edges[siblingIndex].p, mean: newValue };
                              }
                            });
                          } else {
                            const equalShare = remainingProbability / siblings.length;
                            siblings.forEach(sibling => {
                              const siblingIndex = nextGraph.edges.findIndex((e: any) => (e.uuid === sibling.uuid && e.uuid) || (e.id === sibling.id && e.id));
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

                    {/* Std Dev - now shown for ALL edges */}
                    {/* Std Dev and Distribution - inline layout */}
                    <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', marginTop: '16px' }}>
                      {/* Std Dev */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <label style={{ fontSize: '12px', color: '#6B7280', whiteSpace: 'nowrap' }}>Std Dev</label>
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
                            width: '70px', 
                            padding: '6px 8px', 
                            border: '1px solid #ddd', 
                            borderRadius: '4px',
                            boxSizing: 'border-box'
                          }}
                        />
                      </div>

                      {/* Distribution */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <label style={{ fontSize: '12px', color: '#6B7280', whiteSpace: 'nowrap' }}>Dist</label>
                        <select
                          value={selectedEdge?.p?.distribution || 'beta'}
                          onChange={(e) => {
                            updateEdge('distribution', e.target.value);
                          }}
                          style={{ 
                            width: '90px', 
                            padding: '6px 8px', 
                            border: '1px solid #ddd', 
                            borderRadius: '4px',
                            boxSizing: 'border-box'
                          }}
                        >
                          <option value="beta">Beta</option>
                          <option value="normal">Normal</option>
                          <option value="uniform">Uniform</option>
                        </select>
                      </div>
                    </div>

                    {/* Locked Probability - moved here from below */}
                    <div style={{ marginBottom: '16px' }}>
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
                      </div>
                  </CollapsibleSection>

                  {/* SUB-SECTION 2.2: Cost (£) */}
                  <CollapsibleSection title="Cost (£)" icon={Coins} defaultOpen={!!(localEdgeData.cost_gbp?.mean || localEdgeData.cost_gbp_parameter_id)}>
                  <EnhancedSelector
                    type="parameter"
                    parameterType="cost_gbp"
                    value={(selectedEdge as any)?.cost_gbp_parameter_id || ''}
                    onChange={(newParamId) => {
                      updateEdge('cost_gbp_parameter_id', newParamId || undefined);
                    }}
                      onClear={() => {
                        // No need to save history - onChange already does it via updateEdge
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
                      console.log('Push to registry not yet implemented');
                    }}
                      onOpenConnected={() => {
                        const paramId = (selectedEdge as any)?.cost_gbp_parameter_id;
                        if (paramId) {
                          openFileById('parameter', paramId);
                        }
                      }}
                      onOpenItem={(itemId) => {
                        openFileById('parameter', itemId);
                      }}
                    label=""
                      placeholder="Select or enter parameter ID..."
                    />

                    <div style={{ marginBottom: '16px', marginTop: '16px' }}>
                      <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Mean £</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={localEdgeData.cost_gbp?.mean || ''}
                        onChange={(e) => {
                          const newValue = e.target.value === '' ? undefined : parseFloat(e.target.value);
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
                              (next.edges[edgeIndex] as any).cost_gbp = localEdgeData.cost_gbp;
                              if (next.metadata) {
                                next.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(next);
                              saveHistoryState('Update cost GBP', undefined, selectedEdgeId);
                            }
                          }
                        }}
                        placeholder="0.00"
                            style={{ 
                          width: '100%',
                          padding: '8px', 
                              border: '1px solid #ddd', 
                          borderRadius: '4px',
                          boxSizing: 'border-box'
                        }}
                      />
                    </div>

                    {/* Std Dev and Distribution - inline layout */}
                    <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
                      {/* Std Dev */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <label style={{ fontSize: '12px', color: '#6B7280', whiteSpace: 'nowrap' }}>Std Dev</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={localEdgeData.cost_gbp?.stdev || ''}
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
                                (next.edges[edgeIndex] as any).cost_gbp = localEdgeData.cost_gbp;
                                if (next.metadata) {
                                  next.metadata.updated_at = new Date().toISOString();
                                }
                                setGraph(next);
                                saveHistoryState('Update cost GBP std dev', undefined, selectedEdgeId);
                              }
                            }
                          }}
                          placeholder="Optional"
                          style={{ 
                            width: '70px',
                            padding: '6px 8px', 
                            border: '1px solid #ddd', 
                            borderRadius: '4px',
                            boxSizing: 'border-box'
                          }}
                        />
                      </div>

                      {/* Distribution */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <label style={{ fontSize: '12px', color: '#6B7280', whiteSpace: 'nowrap' }}>Dist</label>
                        <select
                          value={localEdgeData.cost_gbp?.distribution || 'normal'}
                          onChange={(e) => {
                            setLocalEdgeData((prev: any) => ({
                              ...prev,
                              cost_gbp: { ...prev.cost_gbp, distribution: e.target.value }
                            }));
                            if (graph && selectedEdgeId) {
                              const next = structuredClone(graph);
                              const edgeIndex = next.edges.findIndex((edge: any) => 
                                edge.id === selectedEdgeId || `${edge.from}->${edge.to}` === selectedEdgeId
                              );
                              if (edgeIndex >= 0) {
                                if (!(next.edges[edgeIndex] as any).cost_gbp) {
                                  (next.edges[edgeIndex] as any).cost_gbp = {};
                                }
                                (next.edges[edgeIndex] as any).cost_gbp.distribution = e.target.value;
                                if (next.metadata) {
                                  next.metadata.updated_at = new Date().toISOString();
                                }
                                setGraph(next);
                                saveHistoryState('Update cost GBP distribution', undefined, selectedEdgeId);
                              }
                            }
                          }}
                          style={{ 
                            width: '100px', 
                            padding: '6px 8px', 
                            border: '1px solid #ddd', 
                            borderRadius: '4px',
                            boxSizing: 'border-box'
                          }}
                        >
                          <option value="normal">Normal</option>
                          <option value="lognormal">Lognormal</option>
                          <option value="gamma">Gamma</option>
                          <option value="uniform">Uniform</option>
                          <option value="beta">Beta</option>
                        </select>
                      </div>
                    </div>
                  </CollapsibleSection>
                  
                  {/* SUB-SECTION 2.3: Cost (Time) */}
                  <CollapsibleSection title="Cost (Time)" icon={Clock} defaultOpen={!!(localEdgeData.cost_time?.mean || localEdgeData.cost_time_parameter_id)}>
                  <EnhancedSelector
                    type="parameter"
                    parameterType="cost_time"
                    value={(selectedEdge as any)?.cost_time_parameter_id || ''}
                    onChange={(newParamId) => {
                      updateEdge('cost_time_parameter_id', newParamId || undefined);
                    }}
                      onClear={() => {
                        // No need to save history - onChange already does it via updateEdge
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
                      console.log('Push to registry not yet implemented');
                    }}
                      onOpenConnected={() => {
                        const paramId = (selectedEdge as any)?.cost_time_parameter_id;
                        if (paramId) {
                          openFileById('parameter', paramId);
                        }
                      }}
                      onOpenItem={(itemId) => {
                        openFileById('parameter', itemId);
                    }}
                    label=""
                      placeholder="Select or enter parameter ID..."
                    />

                    <div style={{ marginBottom: '16px', marginTop: '16px' }}>
                      <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Mean days</label>
                          <input
                            type="number"
                        min="0"
                        step="0.01"
                        value={localEdgeData.cost_time?.mean || ''}
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
                              (next.edges[edgeIndex] as any).cost_time = localEdgeData.cost_time;
                              if (next.metadata) {
                                next.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(next);
                              saveHistoryState('Update cost time', undefined, selectedEdgeId);
                            }
                          }
                        }}
                        placeholder="0.00"
                            style={{ 
                          width: '100%',
                          padding: '8px', 
                              border: '1px solid #ddd', 
                          borderRadius: '4px',
                          boxSizing: 'border-box'
                        }}
                      />
                        </div>

                    {/* Std Dev and Distribution - inline layout */}
                    <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
                      {/* Std Dev */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <label style={{ fontSize: '12px', color: '#6B7280', whiteSpace: 'nowrap' }}>Std Dev</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={localEdgeData.cost_time?.stdev || ''}
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
                                (next.edges[edgeIndex] as any).cost_time = localEdgeData.cost_time;
                                if (next.metadata) {
                                  next.metadata.updated_at = new Date().toISOString();
                                }
                                setGraph(next);
                                saveHistoryState('Update cost time std dev', undefined, selectedEdgeId);
                              }
                            }
                          }}
                          placeholder="Optional"
                          style={{
                            width: '70px',
                            padding: '6px 8px', 
                            border: '1px solid #ddd',
                            borderRadius: '4px',
                            boxSizing: 'border-box'
                          }}
                        />
                      </div>

                      {/* Distribution */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <label style={{ fontSize: '12px', color: '#6B7280', whiteSpace: 'nowrap' }}>Dist</label>
                        <select
                          value={localEdgeData.cost_time?.distribution || 'lognormal'}
                          onChange={(e) => {
                            setLocalEdgeData((prev: any) => ({
                              ...prev,
                              cost_time: { ...prev.cost_time, distribution: e.target.value }
                            }));
                            if (graph && selectedEdgeId) {
                              const next = structuredClone(graph);
                              const edgeIndex = next.edges.findIndex((edge: any) => 
                                edge.id === selectedEdgeId || `${edge.from}->${edge.to}` === selectedEdgeId
                              );
                              if (edgeIndex >= 0) {
                                if (!(next.edges[edgeIndex] as any).cost_time) {
                                  (next.edges[edgeIndex] as any).cost_time = {};
                                }
                                (next.edges[edgeIndex] as any).cost_time.distribution = e.target.value;
                                if (next.metadata) {
                                  next.metadata.updated_at = new Date().toISOString();
                                }
                                setGraph(next);
                                saveHistoryState('Update cost time distribution', undefined, selectedEdgeId);
                              }
                            }
                          }}
                          style={{ 
                            width: '100px', 
                            padding: '6px 8px', 
                            border: '1px solid #ddd', 
                            borderRadius: '4px',
                            boxSizing: 'border-box'
                          }}
                        >
                          <option value="normal">Normal</option>
                          <option value="lognormal">Lognormal</option>
                          <option value="gamma">Gamma</option>
                          <option value="uniform">Uniform</option>
                          <option value="beta">Beta</option>
                        </select>
                      </div>
                    </div>
                  </CollapsibleSection>
                </CollapsibleSection>

                {/* Conditional Probabilities */}
                <CollapsibleSection title="Conditional Probabilities" icon={TrendingUp} defaultOpen={localConditionalP.length > 0}>

                  {localConditionalP.length === 0 && (
                    <div style={{ 
                      fontSize: '12px',
                      color: '#9CA3AF',
                      marginBottom: '12px',
                      fontStyle: 'italic'
                    }}>
                      No conditional probabilities defined.
                    </div>
                  )}

                  {localConditionalP.map((cond, index) => {
                    // Generate name from condition
                    const conditionName = cond.condition?.visited?.length > 0
                      ? `When: ${cond.condition.visited.join(' AND ')}`
                      : 'New condition';
                    
                    const probValue = cond.p?.mean !== undefined 
                      ? `${(cond.p.mean * 100).toFixed(1)}%`
                      : '—';
                    
                    const isExpanded = collapsedConditionals[index] === false;
                    
                    // Get current edge's conditional color
                    const currentColor = localEdgeData.display?.conditional_color;
                    
                    return (
                      <div key={index} className="variant-card" style={{ marginBottom: '8px' }}>
                        <div 
                          className="variant-card-header"
                          style={{ cursor: 'pointer' }}
                          onClick={(e) => {
                            // Don't toggle if clicking on color selector
                            if ((e.target as HTMLElement).closest('.color-selector')) {
                              return;
                            }
                            setCollapsedConditionals(prev => ({
                              ...prev,
                              [index]: !prev[index]
                            }));
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                            
                            {/* Color Picker */}
                            <div onClick={(e) => e.stopPropagation()}>
                              <ColorSelector
                                compact={true}
                                value={currentColor || '#3B82F6'}
                                onChange={(newColor) => {
                                  // Generate a group name from the condition
                                  const groupName = cond.condition?.visited?.length > 0
                                    ? cond.condition.visited.sort().join('_')
                                    : `condition_${index}`;
                                  
                                  // Update this edge's display color and group
                                  const newEdgeData = {
                                    ...localEdgeData,
                                    display: {
                                      ...localEdgeData.display,
                                      conditional_color: newColor,
                                      conditional_group: groupName
                                    }
                                  };
                                  setLocalEdgeData(newEdgeData);
                                  
                                  if (selectedEdgeId && graph) {
                                    const nextGraph = structuredClone(graph);
                                    const edgeIndex = nextGraph.edges.findIndex((edge: any) => 
                                      edge.id === selectedEdgeId || `${edge.from}->${edge.to}` === selectedEdgeId
                                    );
                                    if (edgeIndex >= 0) {
                                      nextGraph.edges[edgeIndex].display = newEdgeData.display;
                                      
                                      // Also update all other edges with the same condition group
                                      nextGraph.edges.forEach((edge: any, idx: number) => {
                                        if (idx !== edgeIndex && edge.display?.conditional_group === groupName) {
                                          if (!edge.display) edge.display = {};
                                          edge.display.conditional_color = newColor;
                                        }
                                      });
                                      
                                      if (nextGraph.metadata) {
                                        nextGraph.metadata.updated_at = new Date().toISOString();
                                      }
                                      setGraph(nextGraph);
                                      saveHistoryState('Update conditional probability color', undefined, selectedEdgeId);
                                    }
                                  }
                                }}
                              />
                            </div>
                            
                            <span style={{ fontSize: '13px', fontWeight: '500' }}>{conditionName}</span>
                            <span style={{ fontSize: '12px', color: '#666', marginLeft: 'auto' }}>{probValue}</span>
                          </div>
                          <button
                            type="button"
                            className="variant-remove-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              const newConditions = localConditionalP.filter((_, i) => i !== index);
                              setLocalConditionalP(newConditions);
                              
                              if (selectedEdgeId && graph) {
                                const nextGraph = structuredClone(graph);
                                const edgeIndex = nextGraph.edges.findIndex((edge: any) => 
                                  edge.id === selectedEdgeId || `${edge.from}->${edge.to}` === selectedEdgeId
                                );
                                if (edgeIndex >= 0) {
                                  nextGraph.edges[edgeIndex].conditional_p = newConditions.length > 0 ? newConditions as any : undefined;
                                  if (nextGraph.metadata) {
                                    nextGraph.metadata.updated_at = new Date().toISOString();
                                  }
                                  setGraph(nextGraph);
                                  saveHistoryState('Remove conditional probability', undefined, selectedEdgeId);
                                }
                              }
                            }}
                            title="Remove conditional probability"
                          >
                            <X size={14} />
                          </button>
                        </div>

                        {isExpanded && (
                          <div style={{ padding: '12px', borderTop: '1px solid #e9ecef' }}>
                            {/* Node Condition */}
                            <div style={{ marginBottom: '16px' }}>
                              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>
                                If visited (AND logic):
                              </label>
                              
                              {/* Chips for selected nodes */}
                              <div style={{ 
                                display: 'flex', 
                                flexWrap: 'wrap', 
                                gap: '6px', 
                                marginBottom: '8px' 
                              }}>
                                {cond.condition?.visited?.map(nodeId => (
                                  <div key={nodeId} style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                    padding: '4px 8px',
                                    background: '#DBEAFE',
                                    borderRadius: '12px',
                                    fontSize: '12px',
                                    color: '#1E40AF',
                                    border: '1px solid #93C5FD',
                                    animation: 'chipAppear 0.3s ease-out'
                                  }}>
                                    <span>visited({nodeId})</span>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const newConditions = [...localConditionalP];
                                        newConditions[index] = {
                                          ...newConditions[index],
                                          condition: {
                                            visited: (newConditions[index].condition?.visited || []).filter(id => id !== nodeId)
                                          }
                                        };
                                        setLocalConditionalP(newConditions);
                                        
                                        if (selectedEdgeId && graph) {
                                          const nextGraph = structuredClone(graph);
                                          const currentEdgeIndex = nextGraph.edges.findIndex((edge: any) => 
                                            edge.id === selectedEdgeId || `${edge.from}->${edge.to}` === selectedEdgeId
                                          );
                                          
                                          if (currentEdgeIndex >= 0) {
                                            const currentEdge = nextGraph.edges[currentEdgeIndex];
                                            const sourceNode = currentEdge.from;
                                            
                                            // Update current edge
                                            nextGraph.edges[currentEdgeIndex].conditional_p = newConditions as any;
                                            
                                            // Also update siblings to keep group in sync
                                            const newGroupName = newConditions[index].condition.visited.sort().join('_');
                                            nextGraph.edges.forEach((edge: any, idx: number) => {
                                              if (idx !== currentEdgeIndex && edge.from === sourceNode && edge.conditional_p && edge.conditional_p[index]) {
                                                edge.conditional_p[index].condition.visited = [...newConditions[index].condition.visited];
                                                // Update group name
                                                if (edge.display) {
                                                  edge.display.conditional_group = newGroupName;
                                                }
                                              }
                                            });
                                            
                                            if (nextGraph.metadata) {
                                              nextGraph.metadata.updated_at = new Date().toISOString();
                                            }
                                            setGraph(nextGraph);
                                            saveHistoryState('Update conditional probability node', undefined, selectedEdgeId);
                                          }
                                        }
                                      }}
                    style={{ 
                                        border: 'none',
                                        background: 'transparent',
                                        cursor: 'pointer',
                                        padding: '0',
                                        display: 'flex',
                                        alignItems: 'center',
                                        color: '#666'
                                      }}
                                    >
                                      <X size={12} />
                                    </button>
                                  </div>
                                ))}
                              </div>

                              {/* Node Selector */}
                              <EnhancedSelector
                                type="node"
                                value=""
                                onChange={(nodeId) => {
                                  if (nodeId) {
                                    const newConditions = [...localConditionalP];
                                    const existingVisited = newConditions[index].condition?.visited || [];
                                    
                                    // Track if this is the first node being added (group creation trigger)
                                    const wasEmpty = existingVisited.length === 0;
                                    
                                    if (!existingVisited.includes(nodeId)) {
                                      newConditions[index] = {
                                        ...newConditions[index],
                                        condition: {
                                          visited: [...existingVisited, nodeId]
                                        }
                                      };
                                      setLocalConditionalP(newConditions);
                                      
                                      if (selectedEdgeId && graph) {
                                        const nextGraph = structuredClone(graph);
                                        const currentEdgeIndex = nextGraph.edges.findIndex((edge: any) => 
                                          edge.id === selectedEdgeId || `${edge.from}->${edge.to}` === selectedEdgeId
                                        );
                                        
                                        if (currentEdgeIndex >= 0) {
                                          const currentEdge = nextGraph.edges[currentEdgeIndex];
                                          const sourceNode = currentEdge.from;
                                          
                                          // **GROUP CREATION**: If this is the FIRST node added (was empty, now has content)
                                          // create matching conditions on all sibling edges
                                          if (wasEmpty) {
                                            console.log(`[ConditionalP] First node selected - creating group for condition ${index}`);
                                            
                                            // Assign a color for this group
                                            const color = getNextAvailableColor(nextGraph as any);
                                            const groupName = newConditions[index].condition.visited.sort().join('_');
                                            
                                            // Update current edge
                                            nextGraph.edges[currentEdgeIndex].conditional_p = newConditions as any;
                                            if (!nextGraph.edges[currentEdgeIndex].display) {
                                              nextGraph.edges[currentEdgeIndex].display = {};
                                            }
                                            nextGraph.edges[currentEdgeIndex].display.conditional_color = color;
                                            nextGraph.edges[currentEdgeIndex].display.conditional_group = groupName;
                                            
                                            // Create matching condition on all sibling edges
                                            nextGraph.edges.forEach((edge: any, idx: number) => {
                                              if (idx !== currentEdgeIndex && edge.from === sourceNode) {
                                                // Ensure conditional_p array exists
                                                if (!edge.conditional_p) {
                                                  edge.conditional_p = [];
                                                }
                                                
                                                // Update existing condition at this index OR create new one
                                                if (edge.conditional_p[index]) {
                                                  // Update existing empty condition with the visited nodes
                                                  edge.conditional_p[index].condition.visited = [...newConditions[index].condition.visited];
                                                } else {
                                                  // Create new condition for sibling (in case sibling doesn't have this condition yet)
                                                  edge.conditional_p.push({
                                                    condition: { visited: [...newConditions[index].condition.visited] },
                                                    p: {}
                                                  });
                                                }
                                                
                                                // Set the same color and group
                                                if (!edge.display) {
                                                  edge.display = {};
                                                }
                                                edge.display.conditional_color = color;
                                                edge.display.conditional_group = groupName;
                                              }
                                            });
                                            
                                            console.log(`[ConditionalP] Group created with color ${color}, group name: ${groupName}`);
                                          } else {
                                            // Group already exists - just update the visited nodes across all siblings
                                            nextGraph.edges[currentEdgeIndex].conditional_p = newConditions as any;
                                            
                                            // Update siblings too
                                            const groupName = newConditions[index].condition.visited.sort().join('_');
                                            nextGraph.edges.forEach((edge: any, idx: number) => {
                                              if (idx !== currentEdgeIndex && edge.from === sourceNode && edge.conditional_p && edge.conditional_p[index]) {
                                                edge.conditional_p[index].condition.visited = [...newConditions[index].condition.visited];
                                                // Update group name
                                                if (edge.display) {
                                                  edge.display.conditional_group = groupName;
                                                }
                                              }
                                            });
                                          }
                                          
                                          if (nextGraph.metadata) {
                                            nextGraph.metadata.updated_at = new Date().toISOString();
                                          }
                                          setGraph(nextGraph);
                                          saveHistoryState(
                                            wasEmpty ? 'Create conditional probability group' : 'Add node to conditional probability',
                                            undefined,
                                            selectedEdgeId
                                          );
                                        }
                                      }
                                    }
                                  }
                                }}
                                placeholder="Select node to add..."
                                showCurrentGraphGroup={true}
                              />
                            </div>

                            {/* Parameter Connection */}
                            <div style={{ marginBottom: '16px' }}>
                              <EnhancedSelector
                                type="parameter"
                                parameterType="probability"
                                value={cond.p?.parameter_id || ''}
                                onChange={(paramId) => {
                                  const newConditions = [...localConditionalP];
                                  newConditions[index] = {
                                    ...newConditions[index],
                                    p: { ...newConditions[index].p, parameter_id: paramId || undefined }
                                  };
                                  setLocalConditionalP(newConditions);
                                  
                                  if (selectedEdgeId && graph) {
                                    const nextGraph = structuredClone(graph);
                                    const edgeIndex = nextGraph.edges.findIndex((edge: any) => 
                                      edge.id === selectedEdgeId || `${edge.from}->${edge.to}` === selectedEdgeId
                                    );
                                    if (edgeIndex >= 0) {
                                      nextGraph.edges[edgeIndex].conditional_p = newConditions as any;
                                      if (nextGraph.metadata) {
                                        nextGraph.metadata.updated_at = new Date().toISOString();
                                      }
                                      setGraph(nextGraph);
                                      saveHistoryState('Update conditional probability parameter', undefined, selectedEdgeId);
                                    }
                                  }
                                }}
                                onClear={() => {
                                  // No need to save history - onChange already does it
                                }}
                                onPullFromRegistry={async () => {
                                  const currentParamId = cond.p?.parameter_id;
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
                                      const sortedValues = [...paramData.values].sort((a, b) => {
                                        if (!a.window_from) return -1;
                                        if (!b.window_from) return 1;
                                        return new Date(b.window_from).getTime() - new Date(a.window_from).getTime();
                                      });
                                      const latestValue = sortedValues[0];
                                      
                                      const newConditions = [...localConditionalP];
                                      newConditions[index] = {
                                        ...newConditions[index],
                                        p: {
                                          ...newConditions[index].p,
                                          mean: latestValue.mean,
                                          stdev: latestValue.stdev,
                                          distribution: latestValue.distribution
                                        }
                                      };
                                      setLocalConditionalP(newConditions);
                                      
                                      const nextGraph = structuredClone(graph);
                                      const edgeIndex = nextGraph.edges.findIndex((e: any) => 
                                        e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                                      );
                                      if (edgeIndex >= 0) {
                                        nextGraph.edges[edgeIndex].conditional_p = newConditions as any;
                                        if (nextGraph.metadata) {
                                          nextGraph.metadata.updated_at = new Date().toISOString();
                                        }
                                        setGraph(nextGraph);
                                        saveHistoryState('Pull conditional probability from registry', undefined, selectedEdgeId);
                                      }
                                    }
                                  } catch (error) {
                                    console.error('Failed to pull conditional probability from registry:', error);
                                  }
                                }}
                                onPushToRegistry={async () => {
                                  console.log('Push to registry not yet implemented');
                                }}
                                onOpenConnected={() => {
                                  const paramId = cond.p?.parameter_id;
                                  if (paramId) {
                                    openFileById('parameter', paramId);
                                  }
                                }}
                                onOpenItem={(itemId) => {
                                  openFileById('parameter', itemId);
                                }}
                                label=""
                                placeholder="Select or enter parameter ID..."
                              />
                            </div>

                            {/* Probability Value with Slider */}
                            <div style={{ marginBottom: '16px' }}>
                              <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Probability</label>
                              <ProbabilityInput
                                value={cond.p?.mean || 0}
                                onChange={(newValue) => {
                                  const newConditions = [...localConditionalP];
                                  newConditions[index] = {
                                    ...newConditions[index],
                                    p: { ...newConditions[index].p, mean: newValue }
                                  };
                                  setLocalConditionalP(newConditions);
                                }}
                                onCommit={(newValue) => {
                                  if (selectedEdgeId && graph) {
                                    const nextGraph = structuredClone(graph);
                                    const edgeIndex = nextGraph.edges.findIndex((edge: any) => 
                                      edge.id === selectedEdgeId || `${edge.from}->${edge.to}` === selectedEdgeId
                                    );
                                    if (edgeIndex >= 0) {
                                      nextGraph.edges[edgeIndex].conditional_p = localConditionalP as any;
                                      if (nextGraph.metadata) {
                                        nextGraph.metadata.updated_at = new Date().toISOString();
                                      }
                                      setGraph(nextGraph);
                                      saveHistoryState('Update conditional probability value', undefined, selectedEdgeId);
                                    }
                                  }
                                }}
                                onRebalance={(newValue) => {
                                  // Rebalance across sibling edges with the same condition
                                  if (selectedEdgeId && graph) {
                                    const nextGraph = structuredClone(graph);
                                    const currentEdgeIndex = nextGraph.edges.findIndex((edge: any) => 
                                      edge.id === selectedEdgeId || `${edge.from}->${edge.to}` === selectedEdgeId
                                    );
                                    
                                    if (currentEdgeIndex >= 0) {
                                      const currentEdge = nextGraph.edges[currentEdgeIndex];
                                      const sourceNode = currentEdge.from;
                                      
                                      // Ensure conditional_p array and condition exist
                                      if (!currentEdge.conditional_p || !currentEdge.conditional_p[index]) {
                                        return; // Can't rebalance if condition doesn't exist
                                      }
                                      
                                      // Update current edge's probability
                                      if (!nextGraph.edges[currentEdgeIndex].conditional_p![index].p) {
                                        nextGraph.edges[currentEdgeIndex].conditional_p![index].p = {};
                                      }
                                      nextGraph.edges[currentEdgeIndex].conditional_p![index].p!.mean = newValue;
                                      
                                      // Find all sibling edges with the same condition at the same index
                                      const siblings = nextGraph.edges.filter((edge: any, idx: number) => 
                                        idx !== currentEdgeIndex && 
                                        edge.from === sourceNode &&
                                        edge.conditional_p &&
                                        edge.conditional_p[index] &&
                                        edge.conditional_p[index].condition &&
                                        currentEdge.conditional_p &&
                                        currentEdge.conditional_p[index] &&
                                        currentEdge.conditional_p[index].condition &&
                                        JSON.stringify(edge.conditional_p[index].condition.visited.sort()) === 
                                        JSON.stringify(currentEdge.conditional_p[index].condition.visited.sort())
                                      );
                                      
                                      if (siblings.length > 0) {
                                        // Calculate remaining probability
                                        const remainingProbability = roundTo4DP(1 - newValue);
                                        
                                        // Calculate current total of siblings
                                        const siblingsTotal = siblings.reduce((sum, sibling) => {
                                          return sum + (sibling.conditional_p![index]?.p?.mean || 0);
                                        }, 0);
                                        
                                        // Rebalance siblings proportionally
                                        siblings.forEach((sibling) => {
                                          const siblingIndex = nextGraph.edges.findIndex((e: any) => (e.uuid === sibling.uuid && e.uuid) || (e.id === sibling.id && e.id));
                                          if (siblingIndex >= 0 && nextGraph.edges[siblingIndex].conditional_p && nextGraph.edges[siblingIndex].conditional_p![index]) {
                                            const siblingCurrentValue = sibling.conditional_p![index]?.p?.mean || 0;
                                            const newSiblingValue = siblingsTotal > 0
                                              ? roundTo4DP((siblingCurrentValue / siblingsTotal) * remainingProbability)
                                              : roundTo4DP(remainingProbability / siblings.length);
                                            
                                            if (!nextGraph.edges[siblingIndex].conditional_p![index].p) {
                                              nextGraph.edges[siblingIndex].conditional_p![index].p = {};
                                            }
                                            nextGraph.edges[siblingIndex].conditional_p![index].p!.mean = newSiblingValue;
                                          }
                                        });
                                      }
                                      
                                      if (nextGraph.metadata) {
                                        nextGraph.metadata.updated_at = new Date().toISOString();
                                      }
                                      setGraph(nextGraph);
                                      saveHistoryState('Rebalance conditional probabilities', undefined, selectedEdgeId);
                                      
                                      // Update local state to reflect the changes
                                      const newConditions = [...localConditionalP];
                                      newConditions[index] = {
                                        ...newConditions[index],
                                        p: { ...newConditions[index].p, mean: newValue }
                                      };
                                      setLocalConditionalP(newConditions);
                                    }
                                  }
                                }}
                              />
                            </div>

                            {/* Std Dev and Distribution - stacked layout for space */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
                              {/* Std Dev */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <label style={{ fontSize: '12px', color: '#6B7280', whiteSpace: 'nowrap' }}>Std Dev</label>
                                <input
                                  type="number"
                                  min="0"
                                  max="1"
                                  step="0.01"
                                  value={cond.p?.stdev || ''}
                                  onChange={(e) => {
                                    const newValue = e.target.value === '' ? undefined : parseFloat(e.target.value);
                                    const newConditions = [...localConditionalP];
                                    newConditions[index] = {
                                      ...newConditions[index],
                                      p: { ...newConditions[index].p, stdev: newValue }
                                    };
                                    setLocalConditionalP(newConditions);
                                  }}
                                  onBlur={() => {
                                    if (selectedEdgeId && graph) {
                                      const nextGraph = structuredClone(graph);
                                      const edgeIndex = nextGraph.edges.findIndex((edge: any) => 
                                        edge.id === selectedEdgeId || `${edge.from}->${edge.to}` === selectedEdgeId
                                      );
                                      if (edgeIndex >= 0) {
                                        nextGraph.edges[edgeIndex].conditional_p = localConditionalP as any;
                                        if (nextGraph.metadata) {
                                          nextGraph.metadata.updated_at = new Date().toISOString();
                                        }
                                        setGraph(nextGraph);
                                        saveHistoryState('Update conditional probability std dev', undefined, selectedEdgeId);
                                      }
                                    }
                                  }}
                                  placeholder="Optional"
                                  style={{ 
                                    width: '70px', 
                                    padding: '6px 8px', 
                                    border: '1px solid #ddd', 
                                    borderRadius: '4px', 
                                    boxSizing: 'border-box'
                                  }}
                                />
                              </div>

                              {/* Distribution */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <label style={{ fontSize: '12px', color: '#6B7280', whiteSpace: 'nowrap' }}>Dist</label>
                                <select
                                  value={cond.p?.distribution || 'beta'}
                                  onChange={(e) => {
                                    const newConditions = [...localConditionalP];
                                    newConditions[index] = {
                                      ...newConditions[index],
                                      p: { ...newConditions[index].p, distribution: e.target.value as any }
                                    };
                                    setLocalConditionalP(newConditions);
                                    
                                    if (selectedEdgeId && graph) {
                                      const nextGraph = structuredClone(graph);
                                      const edgeIndex = nextGraph.edges.findIndex((edge: any) => 
                                        edge.id === selectedEdgeId || `${edge.from}->${edge.to}` === selectedEdgeId
                                      );
                                      if (edgeIndex >= 0) {
                                        nextGraph.edges[edgeIndex].conditional_p = newConditions as any;
                                        if (nextGraph.metadata) {
                                          nextGraph.metadata.updated_at = new Date().toISOString();
                                        }
                                        setGraph(nextGraph);
                                        saveHistoryState('Update conditional probability distribution', undefined, selectedEdgeId);
                                      }
                                    }
                                  }}
                                  style={{ 
                                    width: '90px', 
                                    padding: '6px 8px', 
                                    border: '1px solid #ddd', 
                                    borderRadius: '4px',
                                    boxSizing: 'border-box'
                                  }}
                                >
                                  <option value="normal">Normal</option>
                                  <option value="beta">Beta</option>
                                  <option value="uniform">Uniform</option>
                                </select>
                              </div>
                            </div>
                </div>
                )}
                      </div>
                    );
                  })}

                  {/* Add Conditional Probability Button */}
                <button
                    type="button"
                    className="property-add-btn"
                    style={{ width: '100%' }}
                  onClick={() => {
                      const newCondition = {
                        condition: { visited: [] },
                        p: {}
                      };
                      const newConditions = [...localConditionalP, newCondition];
                      setLocalConditionalP(newConditions);
                      
                      // Expand the new condition
                      setCollapsedConditionals(prev => ({
                        ...prev,
                        [newConditions.length - 1]: false
                      }));
                      
                      // Add ONLY to current edge (not siblings yet - group will be created when first node is selected)
                      if (selectedEdgeId && graph) {
                        const nextGraph = structuredClone(graph);
                        const currentEdgeIndex = nextGraph.edges.findIndex((edge: any) => 
                          edge.id === selectedEdgeId || `${edge.from}->${edge.to}` === selectedEdgeId
                        );
                        
                        if (currentEdgeIndex >= 0) {
                          // Apply the new conditional probability to this edge only
                          nextGraph.edges[currentEdgeIndex].conditional_p = newConditions as any;
                          
                          if (nextGraph.metadata) {
                            nextGraph.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(nextGraph);
                          saveHistoryState('Add conditional probability', undefined, selectedEdgeId);
                        }
                      }
                    }}
                    title="Add a new conditional probability"
                  >
                    + Conditional Probability
                  </button>

                </CollapsibleSection>

                {/* Case Edge Info */}
                {selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant) && (() => {
                  // Find the case node and get the variant
                  const caseNode = graph.nodes.find((n: any) => n.case && n.case.id === selectedEdge.case_id);
                  const variantIndex = caseNode?.case?.variants?.findIndex((v: any) => v.name === selectedEdge.case_variant) ?? -1;
                  const variant = caseNode?.case?.variants?.[variantIndex];
                  const variantWeight = variant?.weight || 0;
                  const subRouteProbability = selectedEdge.p?.mean || 1.0;
                  const effectiveProbability = variantWeight * subRouteProbability;
                  
                  // Get all variant weights for rebalancing
                  const allVariants = caseNode?.case?.variants || [];
                  
                  return (
                    <CollapsibleSection title="Case Edge Info" icon={Box} defaultOpen={false}>
                      <div style={{ marginBottom: '16px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Case ID</label>
                        <div
                          onClick={() => {
                            if (caseNode) {
                              // Clear edge selection and select the case node
                    onSelectedEdgeChange(null);
                              onSelectedNodeChange(caseNode.id);
                            }
                  }}
                  style={{
                    width: '100%',
                            padding: '8px', 
                            border: '1px solid #3B82F6', 
                    borderRadius: '4px',
                            background: '#EFF6FF',
                            boxSizing: 'border-box',
                            color: '#3B82F6',
                    cursor: 'pointer',
                    fontWeight: '500',
                            transition: 'all 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = '#DBEAFE';
                            e.currentTarget.style.borderColor = '#2563EB';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = '#EFF6FF';
                            e.currentTarget.style.borderColor = '#3B82F6';
                          }}
                          title="Click to view case node properties"
                        >
                          {selectedEdge.case_id || ''}
                        </div>
                      </div>
                      
                      <div style={{ marginBottom: '16px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Variant Name</label>
                        <input
                          type="text"
                          value={selectedEdge.case_variant || ''}
                          readOnly
                          style={{ 
                            width: '100%', 
                            padding: '8px', 
                            border: '1px solid #ddd', 
                            borderRadius: '4px',
                            background: '#f8f9fa',
                            boxSizing: 'border-box'
                          }}
                        />
                      </div>
                      
                      {caseNode && variantIndex >= 0 && (
                        <div style={{ marginBottom: '16px' }}>
                          <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Variant Weight</label>
                          <VariantWeightInput
                            value={variantWeight}
                            allVariants={allVariants.map((v: any) => v.weight || 0)}
                            currentIndex={variantIndex}
                            onChange={(newWeight) => {
                              if (!caseNode || !graph) return;
                              
                              // Update the case node's variant weight
                              const nextGraph = structuredClone(graph);
                              const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.uuid === caseNode.uuid || n.id === caseNode.id);
                              if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case) {
                                nextGraph.nodes[nodeIndex].case.variants[variantIndex].weight = newWeight;
                                if (nextGraph.metadata) {
                                  nextGraph.metadata.updated_at = new Date().toISOString();
                                }
                                setGraph(nextGraph);
                              }
                            }}
                            onCommit={() => {
                              if (caseNode) {
                                saveHistoryState('Update case variant weight', caseNode.id);
                              }
                            }}
                            onRebalance={(newValue, currentIdx, allVars) => {
                              if (!caseNode || !graph) return;
                              
                              // Calculate rebalanced weights
                              const totalOthers = allVars.reduce((sum: number, v: any, idx: number) => 
                                idx === currentIdx ? sum : sum + (v || 0), 0
                              );
                              const remaining = 1.0 - newValue;
                              
                              // Update all variant weights proportionally
                              const nextGraph = structuredClone(graph);
                              const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.uuid === caseNode.uuid || n.id === caseNode.id);
                              if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case) {
                                nextGraph.nodes[nodeIndex].case.variants.forEach((variant: any, idx: number) => {
                                  if (idx === currentIdx) {
                                    variant.weight = Math.round(newValue * 1000) / 1000;
                                  } else if (totalOthers > 0) {
                                    const proportion = (allVars[idx] || 0) / totalOthers;
                                    variant.weight = Math.round(remaining * proportion * 1000) / 1000;
                                  } else {
                                    // If all others are 0, distribute evenly
                                    const numOthers = allVars.length - 1;
                                    variant.weight = numOthers > 0 ? Math.round((remaining / numOthers) * 1000) / 1000 : 0;
                                  }
                                });
                                if (nextGraph.metadata) {
                                  nextGraph.metadata.updated_at = new Date().toISOString();
                                }
                                setGraph(nextGraph);
                                saveHistoryState('Rebalance case variants', caseNode.id);
                              }
                            }}
                          />
                        </div>
                      )}
                      
                      <div style={{ marginBottom: '16px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Sub-Route Probability</label>
                        <input
                          type="text"
                          value={`${(subRouteProbability * 100).toFixed(1)}%`}
                          readOnly
                          style={{ 
                            width: '100%', 
                            padding: '8px', 
                            border: '1px solid #ddd', 
                            borderRadius: '4px',
                            background: '#f8f9fa',
                            boxSizing: 'border-box'
                          }}
                        />
                      </div>
                      
                      <div style={{ 
                        padding: '12px', 
                        background: '#FFF9E6', 
                        borderRadius: '4px', 
                        border: '1px solid #FFE066',
                        marginBottom: '8px'
                      }}>
                        <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', color: '#997400', fontWeight: '600' }}>
                          Effective Probability
                        </label>
                        <div style={{ fontSize: '14px', color: '#997400', fontWeight: '700' }}>
                          {(effectiveProbability * 100).toFixed(1)}%
                        </div>
                        <div style={{ fontSize: '11px', color: '#997400', marginTop: '4px' }}>
                          Variant Weight ({(variantWeight * 100).toFixed(1)}%) × Sub-Route ({(subRouteProbability * 100).toFixed(1)}%)
                        </div>
                      </div>
                    </CollapsibleSection>
                  );
                })()}

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
