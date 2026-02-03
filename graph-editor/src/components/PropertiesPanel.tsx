import * as React from 'react';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import toast from 'react-hot-toast';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useTabContext, fileRegistry } from '../contexts/TabContext';
import { dataOperationsService } from '../services/dataOperationsService';
import { useFetchData, createFetchItem } from '../hooks/useFetchData';
import { generateIdFromLabel, generateUniqueId } from '@/lib/idUtils';
import { roundTo4DP } from '@/utils/rounding';
import ProbabilityInput from './ProbabilityInput';
import { ParameterEditor } from './ParameterEditor';
import VariantWeightInput from './VariantWeightInput';
import CollapsibleSection from './CollapsibleSection';
import { getNextAvailableColour } from '@/lib/conditionalColours';
import { useSnapToSlider } from '@/hooks/useSnapToSlider';
import { ParameterSelector } from './ParameterSelector';
import { EnhancedSelector } from './EnhancedSelector';
import { ColourSelector } from './ColourSelector';
import { ConditionalProbabilityEditor } from './ConditionalProbabilityEditor';
import { QueryExpressionEditor } from './QueryExpressionEditor';
import { AutomatableField } from './AutomatableField';
import { ParameterSection } from './ParameterSection';
import { ConnectionControl } from './ConnectionControl';
import { ImageThumbnail } from './ImageThumbnail';
import { ImageUploadModal } from './ImageUploadModal';
import { ImageLoupeView } from './ImageLoupeView';
import { imageOperationsService } from '../services/imageOperationsService';
import { getObjectTypeTheme } from '../theme/objectTypeTheme';
import { Box, Settings, Layers, Edit3, ChevronDown, ChevronRight, X, Sliders, Info, TrendingUp, Coins, Clock, FileJson, ZapOff, RefreshCcw, ExternalLink, Zap } from 'lucide-react';
import { normalizeConstraintString } from '@/lib/queryDSL';
import { isProbabilityMassUnbalanced, getConditionalProbabilityUnbalancedMap } from '../utils/rebalanceUtils';
import { workspaceService } from '../services/workspaceService';
import { generateIdFromLabel as generateIdFromLabelUtil } from '@/lib/idUtils';
import './PropertiesPanel.css';
import type { Evidence } from '../types';
import { useDialog } from '../contexts/DialogContext';
import { graphMutationService } from '../services/graphMutationService';

// ID validation pattern (matches schema: letters, numbers, hyphens, underscores)
const VALID_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate an ID against schema rules
 * Returns error message if invalid, undefined if valid
 */
function validateId(id: string | undefined): string | undefined {
  if (!id) return undefined; // Empty is allowed during editing
  if (id.length > 128) return 'ID too long (max 128 characters)';
  if (!VALID_ID_PATTERN.test(id)) {
    if (/ /.test(id)) return 'Spaces not allowed in ID';
    if (/>/.test(id)) return '">" not allowed in ID';
    return 'Only letters, numbers, hyphens, underscores allowed';
  }
  return undefined;
}

/**
 * Check if a node ID is unique within the graph
 * Returns error message if duplicate, undefined if unique
 */
function checkNodeIdUnique(id: string | undefined, graph: any, currentNodeUuid: string): string | undefined {
  if (!id || !graph?.nodes) return undefined;
  const duplicate = graph.nodes.find((n: any) => n.id === id && n.uuid !== currentNodeUuid);
  if (duplicate) return `ID "${id}" already used by another node`;
  return undefined;
}

/**
 * Check if an edge ID is unique within the graph
 * Returns error message if duplicate, undefined if unique
 */
function checkEdgeIdUnique(id: string | undefined, graph: any, currentEdgeUuid: string): string | undefined {
  if (!id || !graph?.edges) return undefined;
  const duplicate = graph.edges.find((e: any) => e.id === id && e.uuid !== currentEdgeUuid);
  if (duplicate) return `ID "${id}" already used by another edge`;
  return undefined;
}

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
  const { graph, setGraph, saveHistoryState, currentDSL } = useGraphStore();
  const { tabs, operations: tabOps } = useTabContext();
  const { snapValue, shouldAutoRebalance, scheduleRebalance, handleMouseDown } = useSnapToSlider();
  
  // Centralized fetch hook for file operations
  // CRITICAL: Uses graphStore.currentDSL as AUTHORITATIVE source, NOT graph.currentQueryDSL!
  const { fetchItem } = useFetchData({
    graph,
    setGraph: setGraph as (graph: any) => void,
    currentDSL,  // AUTHORITATIVE DSL from graphStore
  });
  
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
  
  // Image upload state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showImageLoupe, setShowImageLoupe] = useState(false);
  const [loupeStartImageId, setLoupeStartImageId] = useState<string | null>(null);
  const lastLoadedEdgeRef = useRef<string | null>(null);
  
  // Debug: Track showUploadModal state changes
  useEffect(() => {
    console.log('[PropertiesPanel] showUploadModal state changed to:', showUploadModal);
  }, [showUploadModal]);
  
  // Track which conditional probabilities are collapsed (by index) - true = collapsed, false/undefined = expanded
  const [collapsedConditionals, setCollapsedConditionals] = useState<{ [key: number]: boolean }>({});

  // Local state for edge query (to prevent eager updates during editing)
  const [localEdgeQuery, setLocalEdgeQuery] = useState<string>('');
  // Local state for edge n_query (optional explicit n denominator query)
  const [localEdgeNQuery, setLocalEdgeNQuery] = useState<string>('');

  // Helper to open a file by type and ID (reuse existing tab if open)
  const openFileById = useCallback((type: 'case' | 'node' | 'parameter' | 'context' | 'event', id: string) => {
    const fileId = `${type}-${id}`;
    
    console.log(`[PropertiesPanel] openFileById: type=${type}, id=${id}, fileId=${fileId}`);
    console.log(`[PropertiesPanel] Current tabs:`, tabs.map(t => ({ id: t.id, fileId: t.fileId, viewMode: t.viewMode })));
    console.log(`[PropertiesPanel] tabId:`, tabId);
    
    // Check if file is already open in a tab
    const existingTab = tabs.find(tab => tab.fileId === fileId);
    
    if (existingTab) {
      // Navigate to existing tab
      console.log(`[PropertiesPanel] Found existing tab ${existingTab.id}, calling switchTab`);
      tabOps.switchTab(existingTab.id);
    } else {
      // Open new tab
      console.log(`[PropertiesPanel] No existing tab found, opening new tab`);
      const item = {
        id,
        type,
        name: id,
        path: `${type}/${id}`,
      };
      tabOps.openTab(item, 'interactive', false);
    }
  }, [tabs, tabOps, tabId]);
  

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
            url: node.url || '',
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
        console.log('PropertiesPanel: Reloading node data after graph change, id:', node.id, 'event_id:', node.event_id);
        setLocalNodeData({
          label: node.label || '',
          id: node.id || '',
          description: node.description || '',
          absorbing: node.absorbing || false,
          outcome_type: node.outcome_type,
          tags: node.tags || [],
          entry: node.entry || {},
          url: node.url || '',
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
            connection: undefined,
            connection_string: undefined,
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
            labour_cost: edge.labour_cost,
            query: (edge as any).query,
            query_overridden: (edge as any).query_overridden
          });
          
          const edgeCostGbp = (edge as any).cost_gbp;
          const edgeCostTime = (edge as any).labour_cost;
          
          console.log('About to setLocalEdgeData with costs:', {
            cost_gbp: edgeCostGbp,
            labour_cost: edgeCostTime
          });
          
          setLocalEdgeData({
            id: edge.id || '',
            probability: edge.p?.mean || 0,
            stdev: edge.p?.stdev || undefined,
            description: edge.description || '',
            cost_gbp: edgeCostGbp,
            labour_cost: edgeCostTime,
            weight_default: edge.weight_default || 0,
            display: edge.display || {},
            query: (edge as any).query || ''
          });
          const edgeQuery = (edge as any).query || '';
          const edgeNQuery = (edge as any).n_query || '';
          console.log('PropertiesPanel: Setting localEdgeQuery to:', edgeQuery, 'n_query:', edgeNQuery);
          setLocalEdgeQuery(edgeQuery);
          setLocalEdgeNQuery(edgeNQuery);
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
          if (edge.labour_cost) updates.labour_cost = edge.labour_cost;
          
          // Update query string (may be regenerated by MSMDC)
          if (edge.query !== undefined) {
            updates.query = edge.query;
          }
          
          return updates;
        });
        
        // Also update the separate localEdgeQuery and localEdgeNQuery states for the query editors
        if (edge.query !== undefined) {
          setLocalEdgeQuery(edge.query);
        }
        if ((edge as any).n_query !== undefined) {
          setLocalEdgeNQuery((edge as any).n_query);
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

  const { showConfirm } = useDialog();

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
  
  // Image operation handlers - using shared service
  const handleImageUpload = useCallback(async (imageData: Uint8Array, extension: string, source: string, caption?: string) => {
    if (!graph || !selectedNodeId) return;
    
    await imageOperationsService.uploadImage(graph, imageData, extension, source, {
      onGraphUpdate: setGraph,
      onHistorySave: saveHistoryState,
      getNodeId: () => selectedNodeId,
      getGraphFileId: () => myTab?.fileId
    }, caption);
  }, [graph, selectedNodeId, setGraph, saveHistoryState, myTab?.fileId]);
  
  const handleDeleteImage = useCallback(async (imageId: string) => {
    if (!graph || !selectedNodeId) return;
    
    await imageOperationsService.deleteImage(graph, imageId, {
      onGraphUpdate: setGraph,
      onHistorySave: saveHistoryState,
      getNodeId: () => selectedNodeId,
      getGraphFileId: () => myTab?.fileId
    });
  }, [graph, selectedNodeId, setGraph, saveHistoryState, myTab?.fileId]);
  
  const handleEditCaption = useCallback(async (imageId: string, newCaption: string) => {
    if (!graph || !selectedNodeId) return;
    
    await imageOperationsService.editCaption(graph, imageId, newCaption, {
      onGraphUpdate: setGraph,
      onHistorySave: saveHistoryState,
      getNodeId: () => selectedNodeId,
      getGraphFileId: () => myTab?.fileId
    });
  }, [graph, selectedNodeId, setGraph, saveHistoryState, myTab?.fileId]);

  const updateEdge = useCallback(async (field: string, value: any) => {
    console.log('[PropertiesPanel] updateEdge called:', { field, value, selectedEdgeId });
    if (!graph || !selectedEdgeId) return;
    const oldGraph = graph;
    const next = structuredClone(graph);
    const edgeIndex = next.edges.findIndex((e: any) => 
      e.uuid === selectedEdgeId || e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
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
  const updateEdgeParam = useCallback(async (paramSlot: 'p' | 'cost_gbp' | 'labour_cost', changes: Record<string, any>) => {
    if (!graph || !selectedEdgeId) return;
    const oldGraph = graph;
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
      
      // For drag interactions (sliders) we avoid graphMutationService and just update the graph in place.
      // For committed updates, route through graphMutationService so topology-sensitive changes (e.g. enabling latency)
      // can trigger MSMDC regeneration (anchors).
      if (_noHistory) {
        setGraph(next);
      } else {
        // Ergonomic behaviour: when the user commits a manual edge p.mean edit, automatically
        // rebalance sibling edges from the same source node (unless overridden/locked).
        //
        // This mirrors the service-layer "fetch" auto-rebalance behaviour, but in normal mode:
        // - preserve the origin edge value
        // - respect sibling override flags
        // - respect parameter locks (param id / connection)
        let nextForMutation = next;
        try {
          if (
            paramSlot === 'p' &&
            Object.prototype.hasOwnProperty.call(actualChanges, 'mean') &&
            typeof (actualChanges as any).mean === 'number' &&
            Number.isFinite((actualChanges as any).mean)
          ) {
            const { updateManager } = await import('../services/UpdateManager');
            nextForMutation = updateManager.rebalanceEdgeProbabilities(nextForMutation, selectedEdgeId, false);
          }
        } catch (e) {
          console.warn('[PropertiesPanel] Auto-rebalance after p.mean commit failed (continuing without rebalance):', e);
          nextForMutation = next;
        }

        await graphMutationService.updateGraph(oldGraph, nextForMutation, setGraph, {
          source: `PropertiesPanel.updateEdgeParam(${paramSlot})`,
        });
      }
      
      // Only save history if _noHistory is not set (for slider dragging, we skip history)
      if (!_noHistory) {
        const changedKeys = Object.keys(actualChanges).join(', ');
        saveHistoryState(`Update ${paramSlot}: ${changedKeys}`, undefined, selectedEdgeId || undefined);
      }
    }
  }, [selectedEdgeId, graph, setGraph, saveHistoryState]);

  // Helper: Connect edge parameter
  const connectEdgeParam = useCallback((paramSlot: 'p' | 'cost_gbp' | 'labour_cost', paramId: string) => {
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
  const disconnectEdgeParam = useCallback((paramSlot: 'p' | 'cost_gbp' | 'labour_cost') => {
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

  // Add null checks to prevent crashes when nodes/edges are deleted
  const selectedNode = selectedNodeId && graph?.nodes ? graph.nodes.find((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId) : null;
  const selectedEdge = selectedEdgeId && graph?.edges ? graph.edges.find((e: any) => 
    e.uuid === selectedEdgeId
  ) : null;

  // Calculate if edge probability is unbalanced (siblings don't sum to 1)
  const isEdgeProbabilityUnbalanced = React.useMemo(() => {
    if (!graph || !selectedEdge || !graph?.edges || selectedEdge.p?.mean === undefined) return false;
    
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
    if (!graph) return new Map<number, boolean>();
    return getConditionalProbabilityUnbalancedMap(graph, selectedEdge, localConditionalP);
  }, [selectedEdge, graph, localConditionalP]); // Depend on entire graph to detect rebalance changes

  // Helper: GET edge parameter from file
  const getEdgeParam = useCallback(async (paramSlot: 'p' | 'cost_gbp' | 'labour_cost') => {
    const edge = selectedEdge;
    const paramId = edge?.[paramSlot]?.id;
    if (!paramId || !selectedEdgeId) return;

    globalThis.window.dispatchEvent(new CustomEvent('dagnet:openBatchOperationsModal', {
      detail: {
        operationType: 'get-from-files',
        singleTarget: {
          type: 'parameter',
          objectId: paramId,
          targetId: selectedEdgeId,
          paramSlot,
        },
      },
    }));
  }, [selectedEdge, selectedEdgeId, fetchItem]);

  // Helper: PUSH edge parameter to file  
  const pushEdgeParam = useCallback(async (paramSlot: 'p' | 'cost_gbp' | 'labour_cost') => {
    const edge = selectedEdge;
    const paramId = edge?.[paramSlot]?.id;
    if (!paramId || !selectedEdgeId) return;

    globalThis.window.dispatchEvent(new CustomEvent('dagnet:openBatchOperationsModal', {
      detail: {
        operationType: 'put-to-files',
        singleTarget: {
          type: 'parameter',
          objectId: paramId,
          targetId: selectedEdgeId,
          paramSlot,
        },
      },
    }));
  }, [selectedEdge, selectedEdgeId, graph, setGraph]);

  // Helper: OPEN edge parameter file
  const openEdgeParamFile = useCallback((paramSlot: 'p' | 'cost_gbp' | 'labour_cost') => {
    const edge = selectedEdge;
    const paramId = edge?.[paramSlot]?.id;
    if (paramId) {
      openFileById('parameter', paramId);
    }
  }, [selectedEdge, openFileById]);

  // Helper: Update conditional probability parameter
  const updateConditionalPParam = useCallback((condIndex: number, changes: Record<string, any>) => {
    if (!selectedEdgeId || !graph) return;
    
    const oldGraph = graph;
    const next = structuredClone(graph);
    const edgeIndex = next.edges.findIndex((e: any) => 
      e.uuid === selectedEdgeId || e.id === selectedEdgeId
    );
    
    if (edgeIndex >= 0 && next.edges[edgeIndex].conditional_p && next.edges[edgeIndex].conditional_p![condIndex]) {
      if (!next.edges[edgeIndex].conditional_p![condIndex].p) {
        next.edges[edgeIndex].conditional_p![condIndex].p = {};
      }
      
      // Extract _noHistory flag before applying changes (matches updateEdgeP pattern)
      const { _noHistory, ...actualChanges } = changes;
      
      Object.assign(next.edges[edgeIndex].conditional_p![condIndex].p!, actualChanges);
      
      // Update local state to reflect the change
      const updatedConditionalP = [...(next.edges[edgeIndex].conditional_p || [])];
      setLocalConditionalP(updatedConditionalP);
      
      if (next.metadata) {
        next.metadata.updated_at = new Date().toISOString();
      }

      // For drag interactions (sliders) we avoid graphMutationService and just update the graph in place.
      // For committed updates, route through graphMutationService so topology-sensitive changes
      // (e.g. enabling latency on conditional probabilities) can trigger MSMDC regeneration (anchors).
      if (_noHistory) {
        setGraph(next);
      } else {
        (async () => {
          const { graphMutationService } = await import('../services/graphMutationService');
          await graphMutationService.updateGraph(oldGraph, next, setGraph, {
            source: `PropertiesPanel.updateConditionalPParam(${condIndex})`,
          });
          saveHistoryState(`Update conditional probability parameter`, undefined, selectedEdgeId || undefined);
        })().catch((e) => {
          console.error('[PropertiesPanel] updateConditionalPParam failed:', e);
        });
      }
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

  // Helper: Regenerate query for this specific edge using MSMDC
  const regenerateEdgeQuery = useCallback(async () => {
    if (!selectedEdgeId || !graph) return;
    
    const loadingToast = toast.loading('Regenerating query for this edge...');
    
    try {
      const { graphComputeClient } = await import('../lib/graphComputeClient');
      const { queryRegenerationService } = await import('../services/queryRegenerationService');
      
      // Transform graph to backend schema before sending
      const transformedGraph = queryRegenerationService.transformGraphForBackend(graph);
      
      // Call MSMDC to generate query for just this edge (pass edge_id to filter)
      const response = await graphComputeClient.generateAllParameters(
        transformedGraph,
        undefined,  // downstreamOf
        undefined,  // literalWeights
        undefined,  // preserveCondition
        selectedEdgeId  // edgeId - tells backend to only generate for this edge
      );
      
      // Should only have params for this edge now
      const edgeQuery = response.parameters.find((param: any) => 
        param.paramType === 'edge_base_p'
      );
      
      if (edgeQuery) {
        // Update the edge with the new query
        const next = structuredClone(graph);
        const edgeIndex = next.edges.findIndex((e: any) => 
          e.uuid === selectedEdgeId || e.id === selectedEdgeId
        );
        
        if (edgeIndex >= 0) {
          next.edges[edgeIndex].query = edgeQuery.query;
          next.edges[edgeIndex].query_overridden = false; // Mark as auto-generated
          if (next.metadata) {
            next.metadata.updated_at = new Date().toISOString();
          }
          
          setGraph(next);
          setLocalEdgeQuery(edgeQuery.query);
          saveHistoryState('Regenerate edge query', undefined, selectedEdgeId);
          
          toast.success('Query regenerated', { id: loadingToast });
        } else {
          toast.error('Edge not found', { id: loadingToast });
        }
      } else {
        toast.error('No query generated for this edge', { id: loadingToast });
      }
    } catch (error) {
      console.error('Failed to regenerate query:', error);
      toast.error(`Failed to regenerate query: ${error instanceof Error ? error.message : 'Unknown error'}`, { id: loadingToast });
    }
  }, [selectedEdgeId, graph, setGraph, saveHistoryState]);

  // Helper: Regenerate n_query for this specific edge using MSMDC
  const regenerateEdgeNQuery = useCallback(async () => {
    if (!selectedEdgeId || !graph) return;
    
    const loadingToast = toast.loading('Regenerating n_query for this edge...');
    
    try {
      const { graphComputeClient } = await import('../lib/graphComputeClient');
      const { queryRegenerationService } = await import('../services/queryRegenerationService');
      
      // Transform graph to backend schema before sending
      const transformedGraph = queryRegenerationService.transformGraphForBackend(graph);
      
      // Call MSMDC to generate query for just this edge (pass edge_id to filter)
      const response = await graphComputeClient.generateAllParameters(
        transformedGraph,
        undefined,  // downstreamOf
        undefined,  // literalWeights
        undefined,  // preserveCondition
        selectedEdgeId  // edgeId - tells backend to only generate for this edge
      );
      
      const edgeBase = response.parameters.find((param: any) => 
        param.paramType === 'edge_base_p'
      );
      
      // Note: backend returns `nQuery` (camelCase). We accept a snake_case fallback defensively.
      const nextNQuery: string | undefined =
        (edgeBase?.nQuery ?? (edgeBase as any)?.n_query) || undefined;
      
      const next = structuredClone(graph);
      const edgeIndex = next.edges.findIndex((e: any) => 
        e.uuid === selectedEdgeId || e.id === selectedEdgeId
      );
      
      if (edgeIndex < 0) {
        toast.error('Edge not found', { id: loadingToast });
        return;
      }
      
      const trimmed = typeof nextNQuery === 'string' ? nextNQuery.trim() : '';
      if (trimmed) {
        (next.edges[edgeIndex] as any).n_query = trimmed;
        (next.edges[edgeIndex] as any).n_query_overridden = false; // Mark as auto-generated
        setLocalEdgeNQuery(trimmed);
      } else {
        delete (next.edges[edgeIndex] as any).n_query;
        delete (next.edges[edgeIndex] as any).n_query_overridden;
        setLocalEdgeNQuery('');
      }
      
      if (next.metadata) {
        next.metadata.updated_at = new Date().toISOString();
      }
      
      setGraph(next);
      saveHistoryState('Regenerate edge n_query', undefined, selectedEdgeId);
      toast.success('n_query regenerated', { id: loadingToast });
    } catch (error) {
      console.error('Failed to regenerate n_query:', error);
      toast.error(`Failed to regenerate n_query: ${error instanceof Error ? error.message : 'Unknown error'}`, { id: loadingToast });
    }
  }, [selectedEdgeId, graph, setGraph, saveHistoryState]);

  // IMPORTANT: Never early-return before all hooks. Graph can transiently be undefined
  // during shell transitions (e.g., exiting dashboard mode). At this point in the file,
  // all hooks have been declared, so it is safe to render a placeholder.
  if (!graph) {
    return (
      <div className="properties-panel">
        <div className="properties-panel-content" />
      </div>
    );
  }
  
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

  // Debug: Log render
  console.log('[PropertiesPanel] Component render - showUploadModal:', showUploadModal);

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
                  value={graph?.metadata?.description || ''}
                  onChange={(e) => updateGraph(['metadata', 'description'], e.target.value)}
                  placeholder="Enter graph description..."
                />
              </div>

              <div className="property-section">
                <label className="property-label">Version</label>
                <input
                  className="property-input"
                  value={graph?.metadata?.version || ''}
                  onChange={(e) => updateGraph(['metadata', 'version'], e.target.value)}
                  placeholder="1.0.0"
                />
              </div>

              <div className="property-section">
                <label className="property-label">Author</label>
                <input
                  className="property-input"
                  value={graph?.metadata?.author || ''}
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
                  commitOnBlurOnly={true}
                  onChange={async (newId) => {
                    console.log('PropertiesPanel: EnhancedSelector onChange:', { newId: newId, currentId: localNodeData.id });
                    
                    // Update local state immediately
                    setLocalNodeData({...localNodeData, id: newId});
                    setIdManuallyEdited(true);
                    
                    // Use UpdateManager to rename node id and update references
                    if (!graph || !selectedNodeId) return;

                    const trimmedId = (newId || '').trim();

                    // Check for empty or duplicate id
                    const isEmpty = trimmedId === '';
                    const isDuplicate = graph.nodes.some((n: any) =>
                      (n.uuid !== selectedNodeId && n.id === trimmedId)
                    );

                    if (isEmpty || isDuplicate) {
                      const reason = isEmpty
                        ? 'Node ID is empty.'
                        : `Node ID "${trimmedId}" is already used by another node.`;

                      const confirmed = await showConfirm({
                        title: 'Unusual node ID',
                        message:
                          `${reason}\n\n` +
                          'This can make queries and scenarios harder to read and reason about.\n\n' +
                          'Are you sure you want to commit this ID?',
                        confirmLabel: 'OK',
                        cancelLabel: 'Cancel',
                      });

                      if (!confirmed) {
                        // Revert local input and do not apply changes
                        setLocalNodeData(prev => ({ ...prev, id: localNodeData.id || '' }));
                        return;
                      }
                    }

                    try {
                      const { updateManager } = await import('../services/UpdateManager');
                      const result = updateManager.renameNodeId(graph, selectedNodeId, trimmedId);
                      setGraph(result.graph);
                      saveHistoryState('Update node id', selectedNodeId);

                      const totalEdgesTouched =
                        result.edgesFromToUpdated +
                        result.edgeIdsUpdatedFromId +
                        result.edgeIdsUpdatedFromUuid;

                      toast.success(
                        `Updated node id to "${trimmedId}"` +
                          (totalEdgesTouched || result.queriesUpdated || result.conditionsUpdated
                            ? ` · edges: ${totalEdgesTouched}, queries: ${result.queriesUpdated}, conditions: ${result.conditionsUpdated}`
                            : '')
                      );
                    } catch (error) {
                      console.error('PropertiesPanel: Failed to rename node id via UpdateManager:', error);
                      toast.error('Failed to update node id. See console for details.');
                    }
                  }}
                  onClear={() => {
                    // No need to save history - onChange already does it via updateNode
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

                  {/* URL */}
                  <div className="property-section">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <label className="property-label">URL</label>
                      {selectedNode?.url && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const url = selectedNode.url?.startsWith('http://') || selectedNode.url?.startsWith('https://') 
                              ? selectedNode.url 
                              : `https://${selectedNode.url}`;
                            window.open(url, '_blank', 'noopener,noreferrer');
                          }}
                          style={{
                            padding: '4px',
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0
                          }}
                          title={selectedNode.url}
                        >
                          <ExternalLink size={14} strokeWidth={2} style={{ color: '#64748b' }} />
                        </button>
                      )}
                    </div>
                    <AutomatableField
                      label="URL"
                      value={localNodeData.url || ''}
                      overridden={selectedNode?.url_overridden || false}
                      onClearOverride={() => {
                        // Clear the override flag only
                        updateNode('url_overridden', false);
                      }}
                    >
                    <input
                      className="property-input"
                      data-field="url"
                      value={localNodeData.url || ''}
                        onChange={(e) => {
                          const newUrl = e.target.value;
                          setLocalNodeData({...localNodeData, url: newUrl});
                        }}
                      onBlur={() => {
                        if (!graph || !selectedNodeId) return;
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                        if (nodeIndex >= 0) {
                          const trimmed = (localNodeData.url || '').trim();
                          if (trimmed.length === 0) {
                            delete next.nodes[nodeIndex].url;
                          } else {
                            next.nodes[nodeIndex].url = trimmed;
                          }
                          // Mark as overridden when user commits edit
                          next.nodes[nodeIndex].url_overridden = true;
                          if (next.metadata) {
                            next.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(next);
                          saveHistoryState('Update node URL', selectedNodeId);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          if (!graph || !selectedNodeId) return;
                          const next = structuredClone(graph);
                          const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                          if (nodeIndex >= 0) {
                            const trimmed = (localNodeData.url || '').trim();
                            if (trimmed.length === 0) {
                              delete next.nodes[nodeIndex].url;
                            } else {
                              next.nodes[nodeIndex].url = trimmed;
                            }
                            // Mark as overridden when user commits edit
                            next.nodes[nodeIndex].url_overridden = true;
                            if (next.metadata) {
                              next.metadata.updated_at = new Date().toISOString();
                            }
                            setGraph(next);
                            saveHistoryState('Update node URL', selectedNodeId);
                          }
                        }
                      }}
                    />
                    </AutomatableField>
                  </div>

                  {/* Images Section */}
                  <div className="property-section" style={{ marginTop: '16px' }}>
                    <AutomatableField
                      label="Images"
                      value={selectedNode?.images || []}
                      overridden={selectedNode?.images_overridden || false}
                      onClearOverride={() => {
                        if (!graph || !selectedNodeId) return;
                        const next = structuredClone(graph);
                        const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                        if (nodeIndex >= 0) {
                          next.nodes[nodeIndex].images_overridden = false;
                          if (next.metadata) {
                            next.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(next);
                          saveHistoryState('Clear images override', selectedNodeId);
                        }
                      }}
                    >
                      <div style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '8px',
                        marginBottom: '8px'
                      }}>
                        {selectedNode?.images?.map((img: any, index: number) => (
                          <ImageThumbnail
                            key={img.image_id}
                            image={img}
                            onDelete={() => handleDeleteImage(img.image_id)}
                            onCaptionEdit={(newCaption) => handleEditCaption(img.image_id, newCaption)}
                            isOverridden={!!selectedNode.images_overridden}
                            onClick={() => {
                              setLoupeStartImageId(img.image_id);
                              setShowImageLoupe(true);
                            }}
                          />
                        ))}
                        
                        {/* Add New Image Button */}
                        <button
                          type="button"
                          className="add-image-button"
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            console.log('[PropertiesPanel] Add image button clicked, current showUploadModal:', showUploadModal);
                            console.log('[PropertiesPanel] Calling setShowUploadModal(true)');
                            setShowUploadModal(true);
                            // Force immediate check
                            setTimeout(() => {
                              console.log('[PropertiesPanel] After setState, showUploadModal should be true');
                            }, 0);
                          }}
                          style={{
                            width: '80px',
                            height: '80px',
                            border: '2px dashed #cbd5e1',
                            borderRadius: '8px',
                            background: '#f8fafc',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '32px',
                            color: '#94a3b8',
                            transition: 'all 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = '#f1f5f9';
                            e.currentTarget.style.borderColor = '#94a3b8';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = '#f8fafc';
                            e.currentTarget.style.borderColor = '#cbd5e1';
                          }}
                          title="Upload new image"
                        >
                          +
                        </button>
                      </div>
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
                        connection: undefined,
                        connection_string: undefined,
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
                          if (!next.nodes[nodeIndex].layout!.colour) {
                            next.nodes[nodeIndex].layout!.colour = getNextAvailableColour(graph as any);
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
                        connection: undefined,
                        connection_string: undefined,
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

                    {/* Case Node Colour */}
                    <ColourSelector
                      label="Node Colour"
                        value={(() => {
                          const node = graph?.nodes.find((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                        return node?.layout?.colour || '#10B981'; // Default to green (first preset) if none assigned
                        })()}
                      onChange={(colour) => {
                          if (graph && selectedNodeId) {
                            const next = structuredClone(graph);
                            const nodeIndex = next.nodes.findIndex((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId);
                            if (nodeIndex >= 0) {
                              if (!next.nodes[nodeIndex].layout) {
                                next.nodes[nodeIndex].layout = { x: 0, y: 0 };
                              }
                            next.nodes[nodeIndex].layout.colour = colour;
                              if (next.metadata) {
                                next.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(next);
                            saveHistoryState('Change node colour', selectedNodeId || undefined);
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
                                  const result = updateManager.rebalanceVariantWeights(
                                    graph,
                                    selectedNodeId,
                                    currentIndex,
                                    true // forceRebalance: true - override _overridden flags when user clicks rebalance
                                  );
                                  
                                  // Update local state
                                  const updatedVariants = result.graph.nodes.find((n: any) => 
                                    n.uuid === selectedNodeId || n.id === selectedNodeId
                                  )?.case?.variants || [];
                                  setCaseData({...caseData, variants: updatedVariants});
                                  
                                  await graphMutationService.updateGraph(oldGraph, result.graph, setGraph);
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
                  {(() => {
                    const formatError = validateId(localEdgeData.id);
                    const uniqueError = checkEdgeIdUnique(localEdgeData.id, graph, selectedEdge?.uuid || '');
                    const idError = formatError || uniqueError;
                    return (
                      <>
                        <input
                          data-field="id"
                          value={localEdgeData.id || ''}
                          onChange={(e) => setLocalEdgeData({...localEdgeData, id: e.target.value})}
                          onBlur={() => {
                            if (!formatError && !uniqueError) {
                              updateEdge('id', localEdgeData.id);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !formatError && !uniqueError) {
                              updateEdge('id', localEdgeData.id);
                            }
                          }}
                          placeholder="edge-id"
                          style={{ 
                            width: '100%', 
                            padding: '8px', 
                            border: idError ? '1px solid #e53e3e' : '1px solid #ddd', 
                            borderRadius: '4px',
                            boxSizing: 'border-box',
                            backgroundColor: idError ? '#fff5f5' : undefined
                          }}
                        />
                        {idError && (
                          <div style={{ color: '#e53e3e', fontSize: '12px', marginTop: '4px' }}>
                            ⚠️ {idError}
                          </div>
                        )}
                      </>
                    );
                  })()}
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
                        e.uuid === selectedEdgeId || e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
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
                      onChange={(e) => setLocalEdgeData((prev: any) => ({ ...prev, description: e.target.value }))}
                      onBlur={(e) => {
                        if (!graph || !selectedEdgeId) return;
                        const committedDescription = e.currentTarget.value;
                        setLocalEdgeData((prev: any) => ({ ...prev, description: committedDescription }));
                        const next = structuredClone(graph);
                        const edgeIndex = next.edges.findIndex((e: any) =>
                          e.uuid === selectedEdgeId || e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                        );
                        if (edgeIndex >= 0) {
                          next.edges[edgeIndex].description = committedDescription;
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
                              const result = updateManager.rebalanceVariantWeights(
                                graph,
                                caseNode.uuid || caseNode.id,
                                variantIndex,
                                true
                              );
                              await graphMutationService.updateGraph(oldGraph, result.graph, setGraph);
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
                  <CollapsibleSection title="Cost (Time)" icon={Clock} defaultOpen={!!(selectedEdge?.labour_cost?.mean || selectedEdge?.labour_cost?.id)}>
                    <ParameterSection
                      graph={graph}
                      objectType="edge"
                      objectId={selectedEdgeId || ''}
                      paramSlot="labour_cost"
                      param={selectedEdge?.labour_cost}
                      onUpdate={(changes) => updateEdgeParam('labour_cost', changes)}
                      label="Cost (Time)"
                      showQueryEditor={false}
                    />
                </CollapsibleSection>

                  {/* Edge-Level Query (applies to all parameters above) */}
                  <div style={{ marginTop: '24px', paddingTop: '20px', borderTop: '1px solid #E5E7EB' }}>
                    <AutomatableField
                      label="Data Retrieval Query"
                      labelExtra={
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span title="Query expression used when retrieving data for any parameter on this edge. Usually auto-generated by MSMDC algorithm from graph topology.">
                            <Info size={14} style={{ color: '#9CA3AF', cursor: 'help' }} />
                          </span>
                          <button
                            type="button"
                            onClick={regenerateEdgeQuery}
                            title="Regenerate query for this edge using MSMDC"
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: '2px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              color: '#6B7280',
                              transition: 'color 0.2s'
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.color = '#3B82F6'}
                            onMouseLeave={(e) => e.currentTarget.style.color = '#6B7280'}
                          >
                            <RefreshCcw size={14} />
                          </button>
                        </div>
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
                  e.uuid === selectedEdgeId || e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
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
                    
                    {/* Optional N Query (for denominator when it differs from k query) */}
                    <div style={{ marginTop: '16px' }}>
                    <AutomatableField
                      label="N Query (optional)"
                      labelExtra={
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span title="Explicit query for n (denominator) when it differs from the main query. Use when the 'from' node shares an event with other nodes and n can't be derived by stripping conditions.">
                          <Info size={14} style={{ color: '#9CA3AF', cursor: 'help' }} />
                        </span>
                          <button
                            type="button"
                            onClick={regenerateEdgeNQuery}
                            title="Regenerate n_query for this edge using MSMDC"
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: '2px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              color: '#6B7280',
                              transition: 'color 0.2s'
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.color = '#3B82F6'}
                            onMouseLeave={(e) => e.currentTarget.style.color = '#6B7280'}
                          >
                            <RefreshCcw size={14} />
                          </button>
                        </div>
                      }
                      layout="label-above"
                      value={localEdgeNQuery}
                      overridden={(selectedEdge as any)?.n_query_overridden || false}
                      onClearOverride={() => {
                        setLocalEdgeNQuery('');
                        if (!graph || !selectedEdgeId) return;
                        const next = structuredClone(graph);
                        const edgeIndex = next.edges.findIndex((e: any) => 
                          e.uuid === selectedEdgeId || e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                        );
                        if (edgeIndex >= 0) {
                          delete (next.edges[edgeIndex] as any).n_query;
                          delete (next.edges[edgeIndex] as any).n_query_overridden;
                          if (next.metadata) {
                            next.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(next);
                          saveHistoryState(`Clear edge n_query`, undefined, selectedEdgeId || undefined);
                        }
                      }}
                    >
                      <QueryExpressionEditor
                        value={localEdgeNQuery}
                        onChange={(newNQuery) => {
                          setLocalEdgeNQuery(newNQuery);
                        }}
                        onBlur={(currentValue) => {
                          const currentEdgeNQuery = (selectedEdge as any)?.n_query || '';
                          if (currentValue !== currentEdgeNQuery) {
                            if (!graph || !selectedEdgeId) return;
                            const next = structuredClone(graph);
                            const edgeIndex = next.edges.findIndex((e: any) => 
                              e.uuid === selectedEdgeId || e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
                            );
                            if (edgeIndex >= 0) {
                              // Set n_query or remove if empty
                              if (currentValue.trim()) {
                                (next.edges[edgeIndex] as any).n_query = currentValue;
                                (next.edges[edgeIndex] as any).n_query_overridden = true; // Mark as manually edited
                              } else {
                                delete (next.edges[edgeIndex] as any).n_query;
                                delete (next.edges[edgeIndex] as any).n_query_overridden;
                              }
                              if (next.metadata) {
                                next.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(next);
                              saveHistoryState(`Update edge n_query`, undefined, selectedEdgeId || undefined);
                            }
                          }
                        }}
                        graph={graph}
                        edgeId={selectedEdgeId || undefined}
                        placeholder="from(A).to(B) — leave empty to auto-derive"
                        height="60px"
                      />
                    </AutomatableField>
                    </div>
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
                    onUpdateConditionColour={async (index: number, colour: string | undefined) => {
                      if (!selectedEdgeId || !graph) return;
                      const oldGraph = graph;
                      
                      // Use UpdateManager to propagate condition colour to matching conditions on siblings
                      const { updateManager } = await import('../services/UpdateManager');
                      const nextGraph = updateManager.propagateConditionalColour(
                        graph,
                        selectedEdgeId,
                        index,
                        colour
                      );
                      
                      // Update local state
                      const updatedConditions = nextGraph.edges.find((e: any) => 
                        e.uuid === selectedEdgeId || e.id === selectedEdgeId
                      )?.conditional_p || [];
                      setLocalConditionalP(updatedConditions);
                      
                      // Use graphMutationService to trigger query regeneration
                      const { graphMutationService } = await import('../services/graphMutationService');
                      await graphMutationService.updateGraph(oldGraph, nextGraph, setGraph);
                      saveHistoryState('Update conditional probability colour', undefined, selectedEdgeId);
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
      
      {/* Image Upload Modal */}
      {showUploadModal && (
        <ImageUploadModal
          onClose={() => {
            console.log('[PropertiesPanel] Closing ImageUploadModal');
            setShowUploadModal(false);
          }}
          onUpload={handleImageUpload}
        />
      )}
      
      {/* Image Loupe View */}
      {showImageLoupe && selectedNode?.images && selectedNode.images.length > 0 && (
        <ImageLoupeView
          images={selectedNode.images}
          initialImageId={loupeStartImageId || undefined}
          onClose={() => setShowImageLoupe(false)}
          onDelete={(imageId) => handleDeleteImage(imageId)}
          onCaptionEdit={(imageId, newCaption) => handleEditCaption(imageId, newCaption)}
          onAddImage={() => {
            setShowImageLoupe(false);
            setShowUploadModal(true);
          }}
        />
      )}
    </div>
  );
}
