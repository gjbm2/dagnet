import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useTabContext, fileRegistry } from '../contexts/TabContext';
import { dataOperationsService } from '../services/dataOperationsService';
import { generateIdFromLabel, generateUniqueId } from '@/lib/idUtils';
import { roundTo4DP } from '@/utils/rounding';
import ProbabilityInput from './ProbabilityInput';
import { ParameterEditor } from './ParameterEditor';
import VariantWeightInput from './VariantWeightInput';
import CollapsibleSection from './CollapsibleSection';
import { getNextAvailableColor } from '@/lib/conditionalColors';
import { useSnapToSlider } from '@/hooks/useSnapToSlider';
import { ParameterSelector } from './ParameterSelector';
import { EnhancedSelector } from './EnhancedSelector';
import { ColorSelector } from './ColorSelector';
import { ConditionalProbabilityEditor } from './ConditionalProbabilityEditor';
import { QueryExpressionEditor } from './QueryExpressionEditor';
import { AutomatableField } from './AutomatableField';
import { ParameterSection } from './ParameterSection';
import { ConnectionControl } from './ConnectionControl';
import { getObjectTypeTheme } from '../theme/objectTypeTheme';
import { Box, Settings, Layers, Edit3, ChevronDown, ChevronRight, X, Sliders, Info, TrendingUp, Coins, Clock, FileJson, ZapOff } from 'lucide-react';
import { normalizeConstraintString } from '@/lib/queryDSL';
import { isProbabilityMassUnbalanced, getConditionalProbabilityUnbalancedMap } from '../utils/rebalanceUtils';
import './PropertiesPanel.css';
import type { Evidence } from '../types';

/**
 * Format evidence data for tooltip display
 */
function formatEvidenceTooltip(evidence?: Evidence): string | undefined {
  if (!evidence) return undefined;
  
  const parts: string[] = [];
  
  if (evidence.n !== undefined) {
    parts.push(`n=${evidence.n}`);
  }
  if (evidence.k !== undefined) {
    parts.push(`k=${evidence.k}`);
  }
  if (evidence.window_from && evidence.window_to) {
    const from = new Date(evidence.window_from).toLocaleDateString();
    const to = new Date(evidence.window_to).toLocaleDateString();
    parts.push(`Window: ${from} - ${to}`);
  }
  if (evidence.source) {
    parts.push(`Source: ${evidence.source}`);
  }
  
  return parts.length > 0 ? `Evidence: ${parts.join(', ')}` : undefined;
}

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
    status: 'active' as 'active' | 'paused' | 'completed',
    connection: undefined as string | undefined,
    connection_string: undefined as string | undefined,
    variants: [] as Array<{ 
      name: string; 
      name_overridden?: boolean;
      weight: number;
      weight_overridden?: boolean;
      description?: string;
      description_overridden?: boolean;
    }>
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

  // Local state for edge query (to prevent eager updates during editing)
  const [localEdgeQuery, setLocalEdgeQuery] = useState<string>('');

  // Helper to open a file by type and ID
  const openFileById = useCallback((type: 'case' | 'node' | 'parameter' | 'context' | 'event', id: string) => {
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
              status: node.case.status || 'active',
              connection: node.case.connection,
              connection_string: node.case.connection_string,
              variants: node.case.variants || []
            });
          } else {
            console.log('Loading normal node');
            setNodeType('normal');
            setCaseData({
              id: '',
              status: 'active',
              connection: undefined,
              connection_string: undefined,
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
            status: node.case.status || 'active',
            connection: node.case.connection,
            connection_string: node.case.connection_string,
            variants: node.case.variants || []
          });
        } else {
          setNodeType('normal');
          setCaseData({
            id: '',
            status: 'active',
            variants: []
          });
        }
      }
    }
  }, [graph, selectedNodeId]);

  // Load edge data when selection changes (but not on every graph update)
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [PropertiesPanel] useEffect#PP2: Edge selection changed`, {
      selectedEdgeId,
      lastLoaded: lastLoadedEdgeRef.current,
      willReload: lastLoadedEdgeRef.current !== selectedEdgeId
    });
    if (selectedEdgeId && graph) {
      // Only reload if we're switching to a different edge
      if (lastLoadedEdgeRef.current !== selectedEdgeId) {
        const edge = graph.edges.find((e: any) => 
          e.uuid === selectedEdgeId || e.id === selectedEdgeId
        );
        if (edge) {
          console.log('PropertiesPanel: Loading edge data:', {
            edgeId: selectedEdgeId,
            cost_gbp: edge.cost_gbp,
            cost_time: edge.cost_time,
            query: (edge as any).query,
            query_overridden: (edge as any).query_overridden
          });
          
          const edgeCostGbp = (edge as any).cost_gbp;
          const edgeCostTime = (edge as any).cost_time;
          
          console.log('About to setLocalEdgeData with costs:', {
            cost_gbp: edgeCostGbp,
            cost_time: edgeCostTime
          });
          
          setLocalEdgeData({
            id: edge.id || '',
            probability: edge.p?.mean || 0,
            stdev: edge.p?.stdev || undefined,
            description: edge.description || '',
            cost_gbp: edgeCostGbp,
            cost_time: edgeCostTime,
            weight_default: edge.weight_default || 0,
            display: edge.display || {},
            query: (edge as any).query || ''
          });
          const edgeQuery = (edge as any).query || '';
          console.log('PropertiesPanel: Setting localEdgeQuery to:', edgeQuery);
          setLocalEdgeQuery(edgeQuery);
          setLocalConditionalP(edge.conditional_p || []);
          lastLoadedEdgeRef.current = selectedEdgeId;
        }
      }
    } else if (!selectedEdgeId) {
      // Clear the ref when no edge is selected
      lastLoadedEdgeRef.current = null;
    }
  }, [selectedEdgeId, graph]);
  
  // ALSO reload edge data when graph changes for the SAME selected edge
  // (e.g., after UpdateManager pulls data from a connected parameter file, or MSMDC query regeneration)
  useEffect(() => {
    if (selectedEdgeId && graph && lastLoadedEdgeRef.current === selectedEdgeId) {
      const edge = graph.edges.find((e: any) => e.uuid === selectedEdgeId);
      if (edge) {
        // Update fields that might change from external updates (parameter auto-get)
        setLocalEdgeData((prev: any) => {
          const updates: any = { ...prev };
          
          // Only update probability fields if there's a connected parameter AND value actually changed
          // Skip if value is the same (prevents interrupting user's slider drag)
          if (edge.p?.id && edge.p?.mean !== undefined && edge.p.mean !== prev.probability) {
            updates.probability = edge.p.mean;
            updates.stdev = edge.p.stdev;
          }
          
          // Always update cost objects (these are always from files)
          if (edge.cost_gbp) updates.cost_gbp = edge.cost_gbp;
          if (edge.cost_time) updates.cost_time = edge.cost_time;
          
          // Update query string (may be regenerated by MSMDC)
          if (edge.query !== undefined) {
            updates.query = edge.query;
          }
          
          return updates;
        });
        
        // Also update the separate localEdgeQuery state for the query editor
        if (edge.query !== undefined) {
          setLocalEdgeQuery(edge.query);
        }
        
        // Sync conditional probabilities when graph changes
        if (edge.conditional_p) {
          setLocalConditionalP(edge.conditional_p);
        }
      }
    }
  }, [graph, selectedEdgeId]);

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
  }, []); // Phase 4: Removed unused dependencies - handler doesn't use selectedEdgeId, graph, setGraph, or onSelectedEdgeChange

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

  const updateEdge = useCallback(async (field: string, value: any) => {
    console.log('[PropertiesPanel] updateEdge called:', { field, value, selectedEdgeId });
    if (!graph || !selectedEdgeId) return;
    const oldGraph = graph;
    const next = structuredClone(graph);
    const edgeIndex = next.edges.findIndex((e: any) => 
      e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
    );
    console.log('[PropertiesPanel] updateEdge found edge at index:', edgeIndex);
    if (edgeIndex >= 0) {
      const oldValue = next.edges[edgeIndex][field];
      console.log('[PropertiesPanel] updateEdge old value:', oldValue);
      
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
      } else if (field.startsWith('costs.')) {
        const costField = field.split('.')[1];
        if (!next.edges[edgeIndex].costs) next.edges[edgeIndex].costs = {};
        next.edges[edgeIndex].costs[costField] = value;
      } else {
        next.edges[edgeIndex][field] = value;
      }
      
      const newValue = next.edges[edgeIndex][field];
      console.log('[PropertiesPanel] updateEdge new value:', newValue);
      console.log('[PropertiesPanel] updateEdge calling graphMutationService');
      
      if (next.metadata) {
        next.metadata.updated_at = new Date().toISOString();
      }
      
      // Use graphMutationService for auto query regeneration
      const { graphMutationService } = await import('../services/graphMutationService');
      await graphMutationService.updateGraph(oldGraph, next, setGraph);
      
      saveHistoryState(`Update edge ${field}`, undefined, selectedEdgeId || undefined);
    }
  }, [selectedEdgeId, graph, setGraph, saveHistoryState]);

  // Helper: Update edge parameter fields
  const updateEdgeParam = useCallback((paramSlot: 'p' | 'cost_gbp' | 'cost_time', changes: Record<string, any>) => {
    if (!graph || !selectedEdgeId) return;
    const next = structuredClone(graph);
    const edgeIndex = next.edges.findIndex((e: any) => 
      e.uuid === selectedEdgeId || e.id === selectedEdgeId
    );
    if (edgeIndex >= 0) {
      if (!next.edges[edgeIndex][paramSlot]) {
        next.edges[edgeIndex][paramSlot] = {};
      }
      
      // Extract _noHistory flag before applying changes
      const { _noHistory, ...actualChanges } = changes;
      
      Object.assign(next.edges[edgeIndex][paramSlot], actualChanges);
      if (next.metadata) {
        next.metadata.updated_at = new Date().toISOString();
      }
      setGraph(next);
      
      // Only save history if _noHistory is not set (for slider dragging, we skip history)
      if (!_noHistory) {
        const changedKeys = Object.keys(actualChanges).join(', ');
        saveHistoryState(`Update ${paramSlot}: ${changedKeys}`, undefined, selectedEdgeId || undefined);
      }
    }
  }, [selectedEdgeId, graph, setGraph, saveHistoryState]);

  // Helper: Connect edge parameter
  const connectEdgeParam = useCallback((paramSlot: 'p' | 'cost_gbp' | 'cost_time', paramId: string) => {
    if (!graph || !selectedEdgeId) return;
    const next = structuredClone(graph);
    const edgeIndex = next.edges.findIndex((e: any) => 
      e.uuid === selectedEdgeId || e.id === selectedEdgeId
    );
    if (edgeIndex >= 0) {
      if (!next.edges[edgeIndex][paramSlot]) {
        next.edges[edgeIndex][paramSlot] = {};
      }
      next.edges[edgeIndex][paramSlot].id = paramId;
      if (next.metadata) {
        next.metadata.updated_at = new Date().toISOString();
      }
      setGraph(next);
      saveHistoryState(`Connect ${paramSlot} parameter`, undefined, selectedEdgeId || undefined);
    }
  }, [selectedEdgeId, graph, setGraph, saveHistoryState]);

  // Helper: Disconnect edge parameter
  const disconnectEdgeParam = useCallback((paramSlot: 'p' | 'cost_gbp' | 'cost_time') => {
    if (!graph || !selectedEdgeId) return;
    const next = structuredClone(graph);
    const edgeIndex = next.edges.findIndex((e: any) => 
      e.uuid === selectedEdgeId || e.id === selectedEdgeId
    );
    if (edgeIndex >= 0) {
      if (next.edges[edgeIndex][paramSlot]) {
        delete next.edges[edgeIndex][paramSlot].id;
      }
      if (next.metadata) {
        next.metadata.updated_at = new Date().toISOString();
      }
      setGraph(next);
      saveHistoryState(`Disconnect ${paramSlot} parameter`, undefined, selectedEdgeId || undefined);
    }
  }, [selectedEdgeId, graph, setGraph, saveHistoryState]);

  if (!graph) return null;

  // Add null checks to prevent crashes when nodes/edges are deleted
  const selectedNode = selectedNodeId && graph.nodes ? graph.nodes.find((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId) : null;
  const selectedEdge = selectedEdgeId && graph.edges ? graph.edges.find((e: any) => 
    e.uuid === selectedEdgeId
  ) : null;

  // Calculate if edge probability is unbalanced (siblings don't sum to 1)
  const isEdgeProbabilityUnbalanced = React.useMemo(() => {
    if (!selectedEdge || !graph?.edges || selectedEdge.p?.mean === undefined) return false;
    
    const sourceNode = selectedEdge.from;
    
    // For case edges, only consider edges with the same case_variant and case_id
    if (selectedEdge.case_id && selectedEdge.case_variant) {
      const siblings = graph.edges.filter((e: any) => 
        e.from === sourceNode && 
        e.case_id === selectedEdge.case_id &&
        e.case_variant === selectedEdge.case_variant &&
        e.p?.mean !== undefined
      );
      return isProbabilityMassUnbalanced(siblings, (e: any) => e.p?.mean);
    }
    
    // For regular edges, consider all edges from the same source (excluding conditional_p edges)
    const siblings = graph.edges.filter((e: any) => 
      e.from === sourceNode && 
      !e.conditional_p &&  // Only regular edges
      !e.case_variant &&   // Exclude case edges
      e.p?.mean !== undefined
    );
    
    // Use generalized function
    return isProbabilityMassUnbalanced(siblings, (e: any) => e.p?.mean);
  }, [selectedEdge, graph]); // Depend on entire graph to detect rebalance changes

  // Calculate if conditional probabilities are unbalanced (for each condition group)
  // Uses generalized helper function
  const isConditionalProbabilityUnbalanced = React.useMemo(() => {
    return getConditionalProbabilityUnbalancedMap(graph, selectedEdge, localConditionalP);
  }, [selectedEdge, graph, localConditionalP]); // Depend on entire graph to detect rebalance changes

  // Helper: GET edge parameter from file
  const getEdgeParam = useCallback(async (paramSlot: 'p' | 'cost_gbp' | 'cost_time') => {
    const edge = selectedEdge;
    const paramId = edge?.[paramSlot]?.id;
    if (!paramId || !selectedEdgeId) return;
    
    await dataOperationsService.getParameterFromFile({
      paramId,
      edgeId: selectedEdgeId,
      graph,
      setGraph: setGraph as (graph: any) => void
    });
  }, [selectedEdge, selectedEdgeId, graph, setGraph]);

  // Helper: PUSH edge parameter to file  
  const pushEdgeParam = useCallback(async (paramSlot: 'p' | 'cost_gbp' | 'cost_time') => {
    const edge = selectedEdge;
    const paramId = edge?.[paramSlot]?.id;
    if (!paramId || !selectedEdgeId) return;
    
    await dataOperationsService.putParameterToFile({
      paramId,
      edgeId: selectedEdgeId,
      graph,
      setGraph: setGraph as (graph: any) => void
    });
  }, [selectedEdge, selectedEdgeId, graph, setGraph]);

  // Helper: OPEN edge parameter file
  const openEdgeParamFile = useCallback((paramSlot: 'p' | 'cost_gbp' | 'cost_time') => {
    const edge = selectedEdge;
    const paramId = edge?.[paramSlot]?.id;
    if (paramId) {
      openFileById('parameter', paramId);
    }
  }, [selectedEdge, openFileById]);

  // Helper: Update conditional probability parameter
  const updateConditionalPParam = useCallback((condIndex: number, changes: Record<string, any>) => {
    if (!selectedEdgeId || !graph) return;
    
    const next = structuredClone(graph);
    const edgeIndex = next.edges.findIndex((e: any) => 
      e.uuid === selectedEdgeId || e.id === selectedEdgeId
    );
    
    if (edgeIndex >= 0 && next.edges[edgeIndex].conditional_p && next.edges[edgeIndex].conditional_p![condIndex]) {
      if (!next.edges[edgeIndex].conditional_p![condIndex].p) {
        next.edges[edgeIndex].conditional_p![condIndex].p = {};
      }
      Object.assign(next.edges[edgeIndex].conditional_p![condIndex].p!, changes);
      
      // Update local state to reflect the change
      const updatedConditionalP = [...(next.edges[edgeIndex].conditional_p || [])];
      setLocalConditionalP(updatedConditionalP);
      
      if (next.metadata) {
        next.metadata.updated_at = new Date().toISOString();
      }
      setGraph(next);
      saveHistoryState(`Update conditional probability parameter`, undefined, selectedEdgeId || undefined);
    }
  }, [selectedEdgeId, graph, setGraph, saveHistoryState]);

  // Helper: Rebalance regular edge probability across sibling edges
  // When called from rebalance button, forceRebalance=true to override _overridden flags
  // IMPORTANT: Preserves the origin edge's current value - only updates siblings
  const handleRebalanceEdgeProbability = useCallback(async (forceRebalance: boolean = true) => {
    if (!selectedEdgeId || !graph) return;
    
    const { updateManager } = await import('../services/UpdateManager');
    const { graphMutationService } = await import('../services/graphMutationService');
    
    const oldGraph = graph;
    const nextGraph = updateManager.rebalanceEdgeProbabilities(
      graph,
      selectedEdgeId,
      forceRebalance
    );
    
    await graphMutationService.updateGraph(oldGraph, nextGraph, setGraph);
    saveHistoryState('Rebalance edge probabilities', undefined, selectedEdgeId);
  }, [selectedEdgeId, graph, setGraph, saveHistoryState]);

  // Helper: Rebalance conditional probability across sibling edges
  // When called from rebalance button or CTRL+click, forceRebalance=true to override _overridden flags
  // IMPORTANT: Preserves the origin condition's current value - only updates siblings
  const rebalanceConditionalP = useCallback(async (condIndex: number, forceRebalance: boolean = true) => {
    if (!selectedEdgeId || !graph) return;
    
    const { updateManager } = await import('../services/UpdateManager');
    const { graphMutationService } = await import('../services/graphMutationService');
    
    const oldGraph = graph;
    const nextGraph = updateManager.rebalanceConditionalProbabilities(
      graph,
      selectedEdgeId,
      condIndex,
      forceRebalance
    );
    
    // Update local state
    const updatedConditionalP = [...(nextGraph.edges.find((e: any) => 
      e.uuid === selectedEdgeId || e.id === selectedEdgeId
    )?.conditional_p || [])];
    setLocalConditionalP(updatedConditionalP);
    
    await graphMutationService.updateGraph(oldGraph, nextGraph, setGraph);
    saveHistoryState('Rebalance conditional probabilities', undefined, selectedEdgeId);
  }, [selectedEdgeId, graph, setGraph, saveHistoryState]);
  
  // DIAGNOSTIC: Log selectedEdge lookup result
  if (selectedEdgeId && !selectedEdge) {
    console.error('[PropertiesPanel] FAILED to find edge:', {
      selectedEdgeId,
      graphEdgeUUIDs: graph.edges?.map((e: any) => e.uuid)
    });
  }
  
  // DIAGNOSTIC: Log what p.id we're about to render
  if (selectedEdge) {
    console.log('[PropertiesPanel] RENDER with selectedEdge.p.id:', selectedEdge.p?.id, {
      'selectedEdge.uuid': selectedEdge.uuid,
      'full edge.p': JSON.stringify(selectedEdge.p)
    });
  }

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
                  targetInstanceUuid={selectedNodeId}
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
                    <AutomatableField
                      label="Label"
                      value={localNodeData.label || ''}
                      overridden={selectedNode?.label_overridden || false}
                      onClearOverride={() => {
                        // Clear the override flag only
                        updateNode('label_overridden', false);
                      }}
                    >
                    <input
                      className="property-input"
                      data-field="label"
                      value={localNodeData.label || ''}
                        onChange={(e) => {
                          const newLabel = e.target.value;
                          setLocalNodeData({...localNodeData, label: newLabel});
                        }}
                      onBlur={() => {
                        if (!graph || !selectedNodeId) return;
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                        if (nodeIndex >= 0) {
                          next.nodes[nodeIndex].label = localNodeData.label;
                            // Mark as overridden when user commits edit
                            next.nodes[nodeIndex].label_overridden = true;
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
                              // Mark as overridden when user commits edit
                              next.nodes[nodeIndex].label_overridden = true;
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
                    </AutomatableField>
                  </div>

                  {/* Description */}
                  <div className="property-section">
                  <AutomatableField
                    label="Description"
                    value={localNodeData.description || ''}
                    overridden={selectedNode?.description_overridden || false}
                    onClearOverride={() => {
                      updateNode('description_overridden', false);
                    }}
                  >
                    <textarea
                      className="property-input"
                      value={localNodeData.description || ''}
                      onChange={(e) => {
                        const newDesc = e.target.value;
                        setLocalNodeData({...localNodeData, description: newDesc});
                      }}
                      onBlur={() => {
                        if (!graph || !selectedNodeId) return;
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                        if (nodeIndex >= 0) {
                          next.nodes[nodeIndex].description = localNodeData.description;
                          next.nodes[nodeIndex].description_overridden = true;
                          if (next.metadata) {
                            next.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(next);
                          saveHistoryState('Update node description', selectedNodeId);
                        }
                      }}
                      placeholder="Enter description..."
                    />
                  </AutomatableField>
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

              {/* Event Connection Section */}
              <CollapsibleSection title="Event Connection" defaultOpen={!!selectedNode?.event_id} icon={FileJson}>
                <AutomatableField
                  label="Event"
                  value={selectedNode?.event_id || ''}
                  overridden={selectedNode?.event_id_overridden || false}
                  onClearOverride={() => {
                    if (!graph || !selectedNodeId) return;
                    const next = structuredClone(graph);
                    const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                    if (nodeIndex >= 0) {
                      next.nodes[nodeIndex].event_id_overridden = false;
                      if (next.metadata) {
                        next.metadata.updated_at = new Date().toISOString();
                      }
                      setGraph(next);
                      saveHistoryState('Clear event_id override', selectedNodeId);
                    }
                  }}
                >
                  <EnhancedSelector
                    type="event"
                    value={selectedNode?.event_id || ''}
                    targetInstanceUuid={selectedNodeId}
                    onChange={(newEventId) => {
                      if (!graph || !selectedNodeId) return;
                      const next = structuredClone(graph);
                      const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                      if (nodeIndex >= 0) {
                        if (!newEventId) {
                          delete next.nodes[nodeIndex].event_id;
                          delete next.nodes[nodeIndex].event_id_overridden;
                        } else {
                          next.nodes[nodeIndex].event_id = newEventId;
                          next.nodes[nodeIndex].event_id_overridden = true;
                        }
                        if (next.metadata) {
                          next.metadata.updated_at = new Date().toISOString();
                        }
                        setGraph(next);
                        saveHistoryState('Update node event', selectedNodeId);
                      }
                    }}
                    onOpenConnected={() => {
                      const eventId = selectedNode?.event_id;
                      if (eventId) {
                        openFileById('event', eventId);
                      }
                    }}
                    onOpenItem={(itemId) => {
                      openFileById('event', itemId);
                    }}
                    label=""
                    placeholder="Select or enter event ID..."
                  />
                </AutomatableField>
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
                  <AutomatableField
                    label="Outcome Type"
                    value={localNodeData.outcome_type || ''}
                    overridden={selectedNode?.outcome_type_overridden || false}
                    onClearOverride={() => {
                      updateNode('outcome_type_overridden', false);
                    }}
                  >
                    <select
                      className="property-input"
                      value={localNodeData.outcome_type || ''}
                      onChange={(e) => {
                        const newValue = e.target.value === '' ? undefined : e.target.value;
                        setLocalNodeData({...localNodeData, outcome_type: newValue});
                      }}
                      onBlur={() => {
                        if (!graph || !selectedNodeId) return;
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                        if (nodeIndex >= 0) {
                          next.nodes[nodeIndex].outcome_type = localNodeData.outcome_type;
                          next.nodes[nodeIndex].outcome_type_overridden = true;
                          if (next.metadata) {
                            next.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(next);
                          saveHistoryState('Update outcome type', selectedNodeId);
                        }
                      }}
                    >
                      <option value="">None</option>
                      <option value="success">Success</option>
                      <option value="failure">Failure</option>
                      <option value="error">Error</option>
                      <option value="neutral">Neutral</option>
                      <option value="other">Other</option>
                    </select>
                  </AutomatableField>
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
                      id: '',  // Don't auto-generate - let user fill in
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
                      targetInstanceUuid={selectedNodeId}
                      onChange={(newCaseId) => {
                        setCaseData({...caseData, id: newCaseId});
                        if (graph && selectedNodeId) {
                          const next = structuredClone(graph);
                          const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                      if (nodeIndex >= 0) {
                        // Always preserve case structure when type='case'
                        // Just update the id field (can be empty string)
                        if (!next.nodes[nodeIndex].case) {
                          next.nodes[nodeIndex].case = {
                            id: newCaseId,
                            status: caseData.status || 'active',
                            variants: caseData.variants || []
                          };
                        } else {
                            next.nodes[nodeIndex].case.id = newCaseId;
                        }
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

                    {/* Data Connection Section */}
                    <div style={{ marginTop: '16px', marginBottom: '16px' }}>
                      <ConnectionControl
                        connection={caseData.connection}
                        connectionString={caseData.connection_string}
                        hideOverride={true}
                        onConnectionChange={(connectionName) => {
                          setCaseData({...caseData, connection: connectionName});
                          if (graph && selectedNodeId) {
                            const next = structuredClone(graph);
                            const nodeIndex = next.nodes.findIndex((n: any) => 
                              n.uuid === selectedNodeId || n.id === selectedNodeId
                            );
                            if (nodeIndex >= 0) {
                              if (!next.nodes[nodeIndex].case) {
                                next.nodes[nodeIndex].case = { 
                                  id: caseData.id,
                                  status: caseData.status,
                                  variants: caseData.variants 
                                };
                              }
                              next.nodes[nodeIndex].case.connection = connectionName;
                              if (next.metadata) {
                                next.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(next);
                              saveHistoryState('Update case connection', selectedNodeId || undefined);
                            }
                          }
                        }}
                        onConnectionStringChange={(connectionString, newConnectionName) => {
                          setCaseData({
                            ...caseData,
                            connection: newConnectionName || caseData.connection,
                            connection_string: connectionString
                          });
                          if (graph && selectedNodeId) {
                            const next = structuredClone(graph);
                            const nodeIndex = next.nodes.findIndex((n: any) => 
                              n.uuid === selectedNodeId || n.id === selectedNodeId
                            );
                            if (nodeIndex >= 0) {
                              if (!next.nodes[nodeIndex].case) {
                                next.nodes[nodeIndex].case = { 
                                  id: caseData.id,
                                  status: caseData.status,
                                  variants: caseData.variants 
                                };
                              }
                              next.nodes[nodeIndex].case.connection = newConnectionName || caseData.connection;
                              next.nodes[nodeIndex].case.connection_string = connectionString;
                              if (next.metadata) {
                                next.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(next);
                              saveHistoryState('Update case connection settings', selectedNodeId || undefined);
                            }
                          }
                        }}
                        label="Data Connection"
                      />
                    </div>

                    {/* Case Status */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px' }}>
                    <AutomatableField
                      label=""
                      value={caseData.status}
                      overridden={selectedNode?.case?.status_overridden || false}
                      onClearOverride={() => {
                        if (!graph || !selectedNodeId) return;
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                        if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                          next.nodes[nodeIndex].case.status_overridden = false;
                          setGraph(next);
                          saveHistoryState('Clear case.status override', selectedNodeId);
                        }
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
                                next.nodes[nodeIndex].case.status_overridden = true;
                              if (next.metadata) {
                                next.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(next);
                                saveHistoryState('Update case status', selectedNodeId);
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
                    </AutomatableField>
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
                                <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '4px', color: '#333' }}>
                                  Weight
                                </label>
                                <AutomatableField
                                  label="Weight"
                                  value={variant.weight}
                                  overridden={variant.weight_overridden || false}
                                  onClearOverride={() => {
                                    if (graph && selectedNodeId) {
                                      const next = structuredClone(graph);
                                      const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                                      if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                        delete next.nodes[nodeIndex].case.variants[index].weight_overridden;
                                        if (next.metadata) {
                                          next.metadata.updated_at = new Date().toISOString();
                                        }
                                        setGraph(next);
                                        saveHistoryState('Clear variant weight override', selectedNodeId);
                                      }
                                    }
                                  }}
                                >
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
                                          next.nodes[nodeIndex].case.variants[index].weight = value;
                                          next.nodes[nodeIndex].case.variants[index].weight_overridden = true;
                                    if (next.metadata) {
                                      next.metadata.updated_at = new Date().toISOString();
                                    }
                                    setGraph(next);
                                        saveHistoryState('Update variant weight', selectedNodeId || undefined);
                                  }
                                }
                              }}
                              onRebalance={async (value, currentIndex, variants) => {
                                if (graph && selectedNodeId) {
                                  // Use UpdateManager for rebalancing with forceRebalance=true (override _overridden flags)
                                  // IMPORTANT: Preserves origin variant's current value - only updates other variants
                                  const { updateManager } = await import('../services/UpdateManager');
                                  const { graphMutationService } = await import('../services/graphMutationService');
                                  
                                  const oldGraph = graph;
                                  const nextGraph = updateManager.rebalanceVariantWeights(
                                    graph,
                                    selectedNodeId,
                                    currentIndex,
                                    true // forceRebalance: true - override _overridden flags when user clicks rebalance
                                  );
                                  
                                  // Update local state
                                  const updatedVariants = nextGraph.nodes.find((n: any) => 
                                    n.uuid === selectedNodeId || n.id === selectedNodeId
                                  )?.case?.variants || [];
                                  setCaseData({...caseData, variants: updatedVariants});
                                  
                                  await graphMutationService.updateGraph(oldGraph, nextGraph, setGraph);
                                  saveHistoryState('Auto-rebalance case variant weights', selectedNodeId);
                                }
                              }}
                              currentIndex={index}
                              allVariants={caseData.variants}
                              autoFocus={false}
                              autoSelect={false}
                              showSlider={true}
                              showBalanceButton={true}
                            />
                                </AutomatableField>
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
                  <AutomatableField
                    label="Description"
                    value={localEdgeData.description || ''}
                    overridden={selectedEdge?.description_overridden || false}
                    onClearOverride={() => {
                      if (!graph || !selectedEdgeId) return;
                      const next = structuredClone(graph);
                      const edgeIndex = next.edges.findIndex((e: any) =>
                        e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                      );
                      if (edgeIndex >= 0) {
                        next.edges[edgeIndex].description_overridden = false;
                        setGraph(next);
                        saveHistoryState('Clear description override', undefined, selectedEdgeId || undefined);
                      }
                    }}
                  >
                    <textarea
                      data-field="description"
                      value={localEdgeData.description || ''}
                      onChange={(e) => setLocalEdgeData({...localEdgeData, description: e.target.value})}
                      onBlur={() => {
                        if (!graph || !selectedEdgeId) return;
                        const next = structuredClone(graph);
                        const edgeIndex = next.edges.findIndex((e: any) =>
                          e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                        );
                        if (edgeIndex >= 0) {
                          next.edges[edgeIndex].description = localEdgeData.description;
                          next.edges[edgeIndex].description_overridden = true;
                          if (next.metadata) {
                            next.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(next);
                          saveHistoryState('Update edge description', undefined, selectedEdgeId || undefined);
                        }
                      }}
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
                  </AutomatableField>
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

                {/* Case Card - for edges immediately downstream of case nodes */}
                {selectedEdge && graph && (() => {
                  // Check if source node is a case node
                  const sourceNode = graph.nodes.find((n: any) => 
                    (n.uuid === selectedEdge.from || n.id === selectedEdge.from) && n.type === 'case'
                  );
                  
                  if (!sourceNode || !sourceNode.case) {
                    return null; // Not downstream of a case node
                  }
                  
                  const caseNode = sourceNode;
                  const allVariants = caseNode.case?.variants || [];
                  const currentVariant = selectedEdge.case_variant || '';
                  const variantIndex = allVariants.findIndex((v: any) => v.name === currentVariant);
                  const variant = variantIndex >= 0 ? allVariants[variantIndex] : null;
                  const variantWeight = variant?.weight || 0;
                  
                  // Calculate if variant weights are unbalanced
                  const totalVariantWeight = allVariants.reduce((sum: number, v: any) => sum + (v.weight || 0), 0);
                  const isVariantWeightUnbalanced = Math.abs(totalVariantWeight - 1.0) > 0.001;
                  
                  return (
                    <CollapsibleSection title="Case" icon={Box} defaultOpen={!!currentVariant}>
                      {/* Variant Selector */}
                      <div style={{ marginBottom: '16px' }}>
                        <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Variant</label>
                        <select
                          value={currentVariant}
                          onChange={async (e) => {
                            const newVariant = e.target.value || null;
                            if (!graph || !selectedEdgeId) return;
                            
                            const { updateManager } = await import('../services/UpdateManager');
                            const { graphMutationService } = await import('../services/graphMutationService');
                            
                            const oldGraph = graph;
                            const nextGraph = updateManager.updateEdgeProperty(
                              graph,
                              selectedEdgeId,
                              {
                                case_variant: newVariant
                                // case_id will be automatically inferred from source node by UpdateManager
                              }
                            );
                            
                            await graphMutationService.updateGraph(oldGraph, nextGraph, setGraph);
                            saveHistoryState(
                              newVariant ? `Assign variant "${newVariant}" to edge` : 'Remove variant from edge',
                              undefined,
                              selectedEdgeId
                            );
                          }}
                          style={{
                            width: '100%',
                            padding: '8px',
                            border: '1px solid #ddd',
                            borderRadius: '4px',
                            background: 'white',
                            boxSizing: 'border-box',
                            fontSize: '14px'
                          }}
                        >
                          <option value="">-- No variant --</option>
                          {allVariants.map((v: any) => (
                            <option key={v.name} value={v.name}>
                              {v.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      
                      {/* Variant Weight - only show if variant is selected */}
                      {currentVariant && variant && (
                        <div style={{ marginBottom: '16px' }}>
                          <ParameterEditor
                            paramType="variant_weight"
                            value={variantWeight}
                            overridden={variant.weight_overridden || false}
                            isUnbalanced={isVariantWeightUnbalanced}
                            graph={graph}
                            objectId={caseNode.uuid || caseNode.id || ''}
                            variantIndex={variantIndex}
                            allVariants={allVariants}
                            label="Variant Weight"
                            onChange={(newWeight) => {
                              // Update graph immediately while dragging (no history)
                              if (!caseNode || !graph) return;
                              const nextGraph = structuredClone(graph);
                              const nodeIndex = nextGraph.nodes.findIndex((n: any) => 
                                n.uuid === caseNode.uuid || n.id === caseNode.id
                              );
                              if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                                const vIdx = nextGraph.nodes[nodeIndex].case.variants.findIndex((v: any) => 
                                  v.name === variant.name
                                );
                                if (vIdx >= 0) {
                                  nextGraph.nodes[nodeIndex].case.variants[vIdx].weight = newWeight;
                                  nextGraph.nodes[nodeIndex].case.variants[vIdx].weight_overridden = true;
                                  if (nextGraph.metadata) {
                                    nextGraph.metadata.updated_at = new Date().toISOString();
                                  }
                                  setGraph(nextGraph);
                                }
                              }
                            }}
                            onCommit={async (newWeight) => {
                              if (!caseNode || !graph) return;
                              const { updateManager } = await import('../services/UpdateManager');
                              const { graphMutationService } = await import('../services/graphMutationService');
                              
                              const oldGraph = graph;
                              const nextGraph = structuredClone(graph);
                              const nodeIndex = nextGraph.nodes.findIndex((n: any) => 
                                n.uuid === caseNode.uuid || n.id === caseNode.id
                              );
                              if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                                const vIdx = nextGraph.nodes[nodeIndex].case.variants.findIndex((v: any) => 
                                  v.name === variant.name
                                );
                                if (vIdx >= 0) {
                                  nextGraph.nodes[nodeIndex].case.variants[vIdx].weight = newWeight;
                                  nextGraph.nodes[nodeIndex].case.variants[vIdx].weight_overridden = true;
                                  if (nextGraph.metadata) {
                                    nextGraph.metadata.updated_at = new Date().toISOString();
                                  }
                                  await graphMutationService.updateGraph(oldGraph, nextGraph, setGraph);
                                  saveHistoryState('Update variant weight', caseNode.id);
                                }
                              }
                            }}
                            onRebalance={async () => {
                              if (!caseNode || !graph) return;
                              const { updateManager } = await import('../services/UpdateManager');
                              const { graphMutationService } = await import('../services/graphMutationService');
                              
                              const oldGraph = graph;
                              const nextGraph = updateManager.rebalanceVariantWeights(
                                graph,
                                caseNode.uuid || caseNode.id,
                                variantIndex,
                                true
                              );
                              await graphMutationService.updateGraph(oldGraph, nextGraph, setGraph);
                              saveHistoryState('Auto-rebalance case variant weights', caseNode.id);
                            }}
                            onClearOverride={() => {
                              if (caseNode && graph) {
                                const nextGraph = structuredClone(graph);
                                const nodeIndex = nextGraph.nodes.findIndex((n: any) => 
                                  n.uuid === caseNode.uuid || n.id === caseNode.id
                                );
                                if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                                  const vIdx = nextGraph.nodes[nodeIndex].case.variants.findIndex((v: any) => 
                                    v.name === variant.name
                                  );
                                  if (vIdx >= 0) {
                                    delete nextGraph.nodes[nodeIndex].case.variants[vIdx].weight_overridden;
                                    if (nextGraph.metadata) {
                                      nextGraph.metadata.updated_at = new Date().toISOString();
                                    }
                                    setGraph(nextGraph);
                                    saveHistoryState('Clear variant weight override', caseNode.id);
                                  }
                                }
                              }
                            }}
                          />
                        </div>
                      )}
                    </CollapsibleSection>
                  );
                })()}

                {/* SECTION 2: Parameters */}
                <CollapsibleSection title="Parameters" icon={Layers} defaultOpen={true}>
                  {/* SUB-SECTION 2.1: Probability */}
                  <CollapsibleSection title="Probability" icon={TrendingUp} defaultOpen={true}>
                    <ParameterSection
                      graph={graph}
                      objectType="edge"
                      objectId={selectedEdgeId || ''}
                      paramSlot="p"
                      param={selectedEdge?.p}
                      onUpdate={(changes) => updateEdgeParam('p', changes)}
                      onRebalance={handleRebalanceEdgeProbability}
                      label={selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant) 
                      ? 'Sub-Route Probability (within variant)' 
                      : 'Probability'}
                      showBalanceButton={true}
                      isUnbalanced={isEdgeProbabilityUnbalanced}
                      showQueryEditor={false}
                    />
                  </CollapsibleSection>

                  {/* SUB-SECTION 2.2: Cost (£) */}
                  <CollapsibleSection title="Cost (£)" icon={Coins} defaultOpen={!!(selectedEdge?.cost_gbp?.mean || selectedEdge?.cost_gbp?.id)}>
                    <ParameterSection
                      graph={graph}
                      objectType="edge"
                      objectId={selectedEdgeId || ''}
                      paramSlot="cost_gbp"
                      param={selectedEdge?.cost_gbp}
                      onUpdate={(changes) => updateEdgeParam('cost_gbp', changes)}
                      label="Cost (£)"
                      showQueryEditor={false}
                    />
                  </CollapsibleSection>
                  
                  {/* SUB-SECTION 2.3: Cost (Time) */}
                  <CollapsibleSection title="Cost (Time)" icon={Clock} defaultOpen={!!(selectedEdge?.cost_time?.mean || selectedEdge?.cost_time?.id)}>
                    <ParameterSection
                      graph={graph}
                      objectType="edge"
                      objectId={selectedEdgeId || ''}
                      paramSlot="cost_time"
                      param={selectedEdge?.cost_time}
                      onUpdate={(changes) => updateEdgeParam('cost_time', changes)}
                      label="Cost (Time)"
                      showQueryEditor={false}
                    />
                </CollapsibleSection>

                  {/* Edge-Level Query (applies to all parameters above) */}
                  <div style={{ marginTop: '24px', paddingTop: '20px', borderTop: '1px solid #E5E7EB' }}>
                    <AutomatableField
                      label="Data Retrieval Query (for all parameters)"
                      labelExtra={
                        <span title="Query expression used when retrieving data for any parameter on this edge. Usually auto-generated by MSMDC algorithm from graph topology.">
                          <Info size={14} style={{ color: '#9CA3AF', cursor: 'help' }} />
                        </span>
                      }
                      layout="label-above"
                      value={localEdgeQuery}
                      overridden={selectedEdge?.query_overridden || false}
                      onClearOverride={() => {
                        setLocalEdgeQuery('');
                        updateEdge('query', '');
                        updateEdge('query_overridden', false);
                      }}
                    >
                      <QueryExpressionEditor
                        value={localEdgeQuery}
                        onChange={(newQuery) => {
                          console.log('[PropertiesPanel] Edge query onChange:', { newQuery, currentLocal: localEdgeQuery });
                          setLocalEdgeQuery(newQuery);
                        }}
            onBlur={(currentValue) => {
              // Update the edge query when user finishes editing
              const currentEdgeQuery = selectedEdge?.query || '';
              console.log('[PropertiesPanel] Edge query onBlur:', { 
                currentValue,
                currentEdgeQuery,
                selectedEdgeId,
                willUpdate: currentValue !== currentEdgeQuery
              });
              if (currentValue !== currentEdgeQuery) {
                // Update both fields in a single call to avoid race condition
                if (!graph || !selectedEdgeId) return;
                const next = structuredClone(graph);
                const edgeIndex = next.edges.findIndex((e: any) => 
                  e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                                    );
                                    if (edgeIndex >= 0) {
                  next.edges[edgeIndex].query = currentValue;
                  next.edges[edgeIndex].query_overridden = true;
                  if (next.metadata) {
                    next.metadata.updated_at = new Date().toISOString();
                  }
                  setGraph(next);
                  saveHistoryState(`Update edge query`, undefined, selectedEdgeId || undefined);
                }
              }
            }}
                        graph={graph}
                        edgeId={selectedEdgeId || undefined}
                        placeholder="from(node).to(node)"
                        height="60px"
                      />
                    </AutomatableField>
                            </div>
                </CollapsibleSection>

                {/* Conditional Probabilities */}
                <CollapsibleSection title="Conditional Probabilities" icon={TrendingUp} defaultOpen={localConditionalP.length > 0}>
                  
                  <ConditionalProbabilityEditor
                    conditions={localConditionalP}
                    onChange={async (newConditions) => {
                      setLocalConditionalP(newConditions);
                      if (selectedEdgeId && graph) {
                        const oldGraph = graph;
                        
                        // Use UpdateManager to handle graph-to-graph updates (sibling propagation)
                        const { updateManager } = await import('../services/UpdateManager');
                        const nextGraph = updateManager.updateConditionalProbabilities(
                          graph,
                          selectedEdgeId,
                          newConditions
                        );
                        
                        // Use graphMutationService to trigger query regeneration
                        const { graphMutationService } = await import('../services/graphMutationService');
                        await graphMutationService.updateGraph(oldGraph, nextGraph, setGraph);
                        saveHistoryState('Update conditional probabilities', undefined, selectedEdgeId);
                      }
                    }}
                    graph={graph}
                    edgeId={selectedEdgeId || undefined}
                    edge={selectedEdge}
                    onUpdateParam={updateConditionalPParam}
                    onRebalanceParam={rebalanceConditionalP}
                    isConditionalUnbalanced={isConditionalProbabilityUnbalanced}
                    onUpdateConditionColor={async (index: number, color: string | undefined) => {
                      if (!selectedEdgeId || !graph) return;
                      const oldGraph = graph;
                      
                      // Use UpdateManager to propagate condition color to matching conditions on siblings
                      const { updateManager } = await import('../services/UpdateManager');
                      const nextGraph = updateManager.propagateConditionalColor(
                        graph,
                        selectedEdgeId,
                        index,
                        color
                      );
                      
                      // Update local state
                      const updatedConditions = nextGraph.edges.find((e: any) => 
                        e.uuid === selectedEdgeId || e.id === selectedEdgeId
                      )?.conditional_p || [];
                      setLocalConditionalP(updatedConditions);
                      
                      // Use graphMutationService to trigger query regeneration
                      const { graphMutationService } = await import('../services/graphMutationService');
                      await graphMutationService.updateGraph(oldGraph, nextGraph, setGraph);
                      saveHistoryState('Update conditional probability color', undefined, selectedEdgeId);
                    }}
                    onRemoveCondition={async (index: number) => {
                      if (!selectedEdgeId || !graph) return;
                      const oldGraph = graph;
                      
                      // Use UpdateManager to handle deletion with sibling propagation
                      const { updateManager } = await import('../services/UpdateManager');
                      const nextGraph = updateManager.removeConditionalProbability(
                        graph,
                        selectedEdgeId,
                        index
                      );
                      
                      // Update local state
                      const updatedConditions = nextGraph.edges.find((e: any) => 
                        e.uuid === selectedEdgeId || e.id === selectedEdgeId
                      )?.conditional_p || [];
                      setLocalConditionalP(updatedConditions);
                      
                      // Use graphMutationService to trigger query regeneration
                      const { graphMutationService } = await import('../services/graphMutationService');
                      await graphMutationService.updateGraph(oldGraph, nextGraph, setGraph);
                      saveHistoryState('Remove conditional probability', undefined, selectedEdgeId);
                    }}
                  />

                </CollapsibleSection>

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
