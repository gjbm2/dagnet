import React, { useCallback, useEffect, useMemo, useRef, useState, startTransition, createContext, useContext } from 'react';
import { flushSync } from 'react-dom';
import { useSnapToSlider } from '@/hooks/useSnapToSlider';
import { roundTo4DP } from '@/utils/rounding';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
  ReactFlowProvider,
  NodeTypes,
  EdgeTypes,
  useReactFlow,
  ConnectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';
import '../custom-reactflow.css';
import { useTheme } from '../contexts/ThemeContext';
import { useElementTool } from '../contexts/ElementToolContext';

import ConversionNode from './nodes/ConversionNode';
import PostItNode from './nodes/PostItNode';
import ContainerNode from './nodes/ContainerNode';
import CanvasAnalysisNode from './nodes/CanvasAnalysisNode';
import ConversionEdge from './edges/ConversionEdge';
import ScenarioOverlayRenderer from './ScenarioOverlayRenderer';

// ATOMIC RESTORATION: Context for passing decoration visibility to edges without mutating edge.data
interface DecorationVisibilityContextType {
  beadsVisible: boolean;
  isPanning: boolean;
  isDraggingNode: boolean;
  /** The analysis ID (without 'analysis-' prefix) currently being dragged, or null. */
  draggedAnalysisId: string | null;
}

const DecorationVisibilityContext = createContext<DecorationVisibilityContextType>({
  beadsVisible: true,
  isPanning: false,
  isDraggingNode: false,
  draggedAnalysisId: null,
});

export const useDecorationVisibility = () => useContext(DecorationVisibilityContext);
import ProbabilityInput from './ProbabilityInput';
import VariantWeightInput from './VariantWeightInput';
import { SelectionConnectors } from './SelectionConnectors';
import { captureTabScenariosToRecipe } from '../services/captureTabScenariosService';
import { resolveAnalysisType } from '../services/analysisTypeResolutionService';
import { mutateCanvasAnalysisGraph, deleteCanvasAnalysisFromGraph } from '../services/canvasAnalysisMutationService';
import { useDashboardMode } from '../hooks/useDashboardMode';
import { useCopyPaste } from '../hooks/useCopyPaste';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useTabContext } from '../contexts/TabContext';
import { useViewPreferencesContext } from '../contexts/ViewPreferencesContext';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { GraphIssuesIndicatorOverlay } from './canvas/GraphIssuesIndicatorOverlay';
import { getOptimalFace } from '@/lib/faceSelection';
import { useEdgeRouting } from './canvas/useEdgeRouting';
import { useEdgeConnection } from './canvas/useEdgeConnection';
import { useGraphSync } from './canvas/useGraphSync';
import type { SyncGuards } from './canvas/syncGuards';
import { CanvasContextMenus } from './canvas/CanvasContextMenus';
import { buildScenarioRenderEdges } from './canvas/buildScenarioRenderEdges';
import { calculateEdgeOffsets as calculateEdgeOffsetsCore } from './canvas/edgeGeometry';
import { computeDagreLayout as computeDagreLayoutCore, computeSankeyLayout as computeSankeyLayoutCore } from './canvas/layoutAlgorithms';
import { useCanvasCreation } from './canvas/useCanvasCreation';
import { useLassoSelection } from './canvas/useLassoSelection';
import { useNodeDrag } from './canvas/useNodeDrag';
import { computeHighlightMetadata } from './canvas/pathHighlighting';
import { DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT } from '@/lib/nodeEdgeConstants';
import { useAlignSelection } from '../hooks/useAlignSelection';
import { useSnapToGuides } from '../hooks/useSnapToGuides';


const nodeTypes: NodeTypes = {
  conversion: ConversionNode,
  postit: PostItNode,
  container: ContainerNode,
  canvasAnalysis: CanvasAnalysisNode,
};

const edgeTypes: EdgeTypes = {
  conversion: ConversionEdge,
};

/** Resolve conversion node IDs spatially contained within a container. */
function getContainedConversionNodeIds(
  container: { x: number; y: number; width: number; height: number },
  rfNodes: any[],
  tolerance = 10,
): string[] {
  return rfNodes.filter(n => {
    if (n.id?.startsWith('postit-') || n.id?.startsWith('container-') || n.id?.startsWith('analysis-')) return false;
    const nw = (n as any).measured?.width ?? n.width ?? DEFAULT_NODE_WIDTH;
    const nh = (n as any).measured?.height ?? n.height ?? DEFAULT_NODE_HEIGHT;
    const nx = n.position?.x ?? 0;
    const ny = n.position?.y ?? 0;
    return nx >= (container.x - tolerance) && ny >= (container.y - tolerance) &&
      (nx + nw) <= (container.x + container.width + tolerance) &&
      (ny + nh) <= (container.y + container.height + tolerance);
  }).map(n => n.id);
}

interface GraphCanvasProps {
  onSelectedNodeChange: (id: string | null) => void;
  onSelectedEdgeChange: (id: string | null) => void;
  onSelectedAnnotationChange?: (id: string | null, type: 'postit' | 'container' | 'canvasAnalysis' | null) => void;
  onDoubleClickNode?: (id: string, field: string) => void;
  onDoubleClickEdge?: (id: string, field: string) => void;
  onSelectEdge?: (id: string) => void;
  onAddNodeRef?: React.MutableRefObject<(() => void) | null>;
  onAddPostitRef?: React.MutableRefObject<(() => void) | null>;
  onAddContainerRef?: React.MutableRefObject<(() => void) | null>;
  activeElementTool?: 'select' | 'pan' | 'new-node' | 'new-postit' | 'new-container' | 'new-analysis' | null;
  onClearElementTool?: () => void;
  onDeleteSelectedRef?: React.MutableRefObject<(() => void) | null>;
  onAutoLayoutRef?: React.MutableRefObject<((direction: 'LR' | 'RL' | 'TB' | 'BT') => void) | null>;
  onSankeyLayoutRef?: React.MutableRefObject<(() => void) | null>;
  onForceRerouteRef?: React.MutableRefObject<(() => void) | null>;
  onHideUnselectedRef?: React.MutableRefObject<(() => void) | null>;
  whatIfDSL?: string | null;
  tabId?: string;
  activeTabId?: string | null;
  externalSelectedNodeId?: string | null;
  externalSelectedEdgeId?: string | null;
}

export default function GraphCanvas({ onSelectedNodeChange, onSelectedEdgeChange, onSelectedAnnotationChange, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, onAddNodeRef, onAddPostitRef, onAddContainerRef, activeElementTool, onClearElementTool, onDeleteSelectedRef, onAutoLayoutRef, onSankeyLayoutRef, onForceRerouteRef, onHideUnselectedRef, whatIfDSL, tabId, activeTabId, externalSelectedNodeId, externalSelectedEdgeId }: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner 
        tabId={tabId}
        activeTabId={activeTabId}
        onSelectedNodeChange={onSelectedNodeChange}
        onSelectedEdgeChange={onSelectedEdgeChange}
        onSelectedAnnotationChange={onSelectedAnnotationChange}
        onDoubleClickNode={onDoubleClickNode}
        onDoubleClickEdge={onDoubleClickEdge}
        externalSelectedNodeId={externalSelectedNodeId}
        externalSelectedEdgeId={externalSelectedEdgeId}
        onSelectEdge={onSelectEdge}
        onAddNodeRef={onAddNodeRef}
        onAddPostitRef={onAddPostitRef}
        onAddContainerRef={onAddContainerRef}
        activeElementTool={activeElementTool}
        onClearElementTool={onClearElementTool}
        onDeleteSelectedRef={onDeleteSelectedRef}
        onAutoLayoutRef={onAutoLayoutRef}
        onSankeyLayoutRef={onSankeyLayoutRef}
        onForceRerouteRef={onForceRerouteRef}
        onHideUnselectedRef={onHideUnselectedRef}
        whatIfDSL={whatIfDSL}
      />
    </ReactFlowProvider>
  );
}

function CanvasInner({ onSelectedNodeChange, onSelectedEdgeChange, onSelectedAnnotationChange, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, onAddNodeRef, onAddPostitRef, onAddContainerRef, activeElementTool: _propTool, onClearElementTool: _propClear, onDeleteSelectedRef, onAutoLayoutRef, onSankeyLayoutRef, onForceRerouteRef, onHideUnselectedRef, whatIfDSL, tabId, activeTabId, externalSelectedNodeId, externalSelectedEdgeId }: GraphCanvasProps) {
  const { activeElementTool, setActiveElementTool, clearElementTool: onClearElementTool } = useElementTool();
  console.log(`[CanvasInner] activeElementTool=${activeElementTool}, tabId=${tabId}`);
  const { theme } = useTheme();
  const dark = theme === 'dark';
  // Track if user is panning/zooming to disable beads during interaction
  const [isPanningOrZooming, setIsPanningOrZooming] = React.useState(false);
  const panTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const isPanningOrZoomingRef = React.useRef(false);
  const hasMovedRef = React.useRef(false); // Track if actual movement occurred
  const moveStartViewportRef = React.useRef<{ x: number; y: number; zoom: number } | null>(null);
  const lastSavedViewportRef = React.useRef<{ x: number; y: number; zoom: number } | null>(null);
  
  // Track if user is dragging a node to disable beads during drag
  const [isDraggingNode, setIsDraggingNode] = React.useState(false);
  // Track which specific analysis is being dragged (for SelectionConnectors)
  const [draggedAnalysisId, setDraggedAnalysisId] = React.useState<string | null>(null);
  
  // ATOMIC RESTORATION: Decoration overlay state (independent of ReactFlow graph state)
  // This flag controls ONLY our overlay components (EdgeBeadsRenderer)
  // It does NOT mutate ReactFlow's nodes/edges, so toggling it doesn't trigger ReactFlow re-renders
  const [beadsVisible, setBeadsVisible] = React.useState(true);
  const decorationRestoreTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  
  // Combined suppression flag for convenience
  const shouldSuppressDecorations = isPanningOrZooming || !beadsVisible;
  
  // Track when isPanningOrZooming changes (for debugging - can remove later)
  React.useEffect(() => {
    isPanningOrZoomingRef.current = isPanningOrZooming;
  }, [isPanningOrZooming]);
  
  // Cleanup: cancel decoration restoration timeout on unmount
  React.useEffect(() => {
    return () => {
      if (decorationRestoreTimeoutRef.current) {
        clearTimeout(decorationRestoreTimeoutRef.current);
        decorationRestoreTimeoutRef.current = null;
      }
    };
  }, []);
  
  const store = useGraphStore();
  const { graph, setGraph: setGraphDirect, setAutoUpdating } = store;
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const { operations: tabOperations, activeTabId: activeTabIdContext, tabs } = useTabContext();
  const { isDashboardMode, toggleDashboardMode } = useDashboardMode();

  // Authoritative graph fileId for this canvas/tab (e.g. "graph-my-graph")
  // NOTE: Do not rely on graph.metadata.* here — it can be stale after duplication/rename.
  const graphFileId = useMemo(() => {
    if (!tabId) return null;
    return tabs.find(t => t.id === tabId)?.fileId ?? null;
  }, [tabId, tabs]);
  
  // Initialize lastSavedViewportRef from tab state to avoid unnecessary saves
  React.useEffect(() => {
    if (tabId) {
      const myTab = tabs.find(t => t.id === tabId);
      const vp = myTab?.editorState?.rfViewport as any;
      if (vp && typeof vp.x === 'number' && typeof vp.y === 'number' && typeof vp.zoom === 'number') {
        lastSavedViewportRef.current = {
          x: vp.x,
          y: vp.y,
          zoom: vp.zoom
        };
      }
    }
  }, [tabId, tabs]);
  const viewPrefs = useViewPreferencesContext();
  const scenariosContext = useScenariosContextOptional();
  
  // Copy-paste hook for paste node functionality
  const { copiedItem, canPaste, copySubgraph } = useCopyPaste();
  const copiedNode = copiedItem?.type === 'dagnet-copy' && copiedItem.objectType === 'node' ? copiedItem : null;
  const copiedSubgraph = copiedItem?.type === 'dagnet-subgraph' ? copiedItem : null;
  
  // Wrapped setGraph that automatically triggers query regeneration on topology changes
  const setGraph = useCallback(async (newGraph: any, oldGraph?: any, source?: string) => {
    // If oldGraph not provided, use current graph from closure
    const prevGraph = oldGraph !== undefined ? oldGraph : graph;
    try {
      const { graphMutationService } = await import('../services/graphMutationService');
      await graphMutationService.updateGraph(prevGraph, newGraph, setGraphDirect, {
        setAutoUpdating,
        source,
      });
    } catch (error) {
      console.error('[GraphCanvas] setGraph wrapper error:', error);
      setGraphDirect(newGraph);
    }
  }, [graph, setGraphDirect, setAutoUpdating]);
  
  // Fallback to defaults if context not available (shouldn't happen in normal use)
  const useUniformScaling = viewPrefs?.useUniformScaling ?? false;
  const massGenerosity = viewPrefs?.massGenerosity ?? 0.5;
  const autoReroute = viewPrefs?.autoReroute ?? true;
  const snapToGuides = viewPrefs?.snapToGuides ?? true;
  const useSankeyView = viewPrefs?.useSankeyView ?? false;
  const showNodeImages = viewPrefs?.showNodeImages ?? false;
  const ts = () => new Date().toISOString();

  // Track graph store reference changes to detect loops
  const prevGraphRef = useRef(graph);
  const graphChangeCountRef = useRef(0);
  useEffect(() => {
    if (prevGraphRef.current !== graph) {
      graphChangeCountRef.current++;
      console.log(`[${new Date().toISOString()}] [GraphCanvas] GRAPH STORE NEW REFERENCE (count: ${graphChangeCountRef.current}, nodes: ${graph?.nodes?.length || 0}, edges: ${graph?.edges?.length || 0})`);
      prevGraphRef.current = graph;
    }
  }, [graph]);

  // What-If DSL: prefer latest tab state, fall back to prop if needed.
  // TabContext is the single source of truth; the prop is just a convenience.
  const tabForThisCanvas = tabId ? tabs.find(t => t.id === tabId) : undefined;
  const tabWhatIfDSL = tabForThisCanvas?.editorState?.whatIfDSL;
  const effectiveWhatIfDSL = tabWhatIfDSL ?? whatIfDSL ?? null;

  // Use prop if provided, otherwise fall back to context for active tab id
  const effectiveActiveTabId = activeTabId ?? activeTabIdContext;
  const saveHistoryState = store.saveHistoryState;
  const { snapValue, shouldAutoRebalance, scheduleRebalance, handleMouseDown } = useSnapToSlider();
  
  // Get the store hook for direct .getState() access
  const graphStoreHook = useGraphStore();
  
  // Recompute edge widths when what-if DSL changes
  // Create a "version" to track changes in what-if state (for reactivity)
  const overridesVersion = effectiveWhatIfDSL || '';
  const { deleteElements, fitView: rfFitView, screenToFlowPosition, flowToScreenPosition, setCenter } = useReactFlow();
  
  const isCanvasObjectNode = useCallback((id: string) =>
    id?.startsWith('postit-') || id?.startsWith('container-') || id?.startsWith('analysis-'), []);
  
  // ReactFlow maintains local state for smooth interactions
  const [nodes, setNodes, onNodesChangeBase] = useNodesState([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState([]);

  // Alignment & distribution commands for selected objects
  const { align, distribute, equalSize, canAlign, canDistribute } = useAlignSelection(nodes, setNodes, graphRef, setGraphDirect, saveHistoryState);

  // Snap-to-guide lines during drag
  const { rebuildIndex: rebuildSnapIndex, applySnapToChanges, resetHelperLines, HelperLines } = useSnapToGuides();
  const altKeyPressedRef = useRef(false);

  // Alt key tracking for snap-to-guide override.
  // Reset on blur/focus to prevent stuck-Alt when Alt+Tab switches windows
  // (keyup fires in the other window, never reaching our handler).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Alt') altKeyPressedRef.current = true; };
    const handleKeyUp = (e: KeyboardEvent) => { if (e.key === 'Alt') altKeyPressedRef.current = false; };
    const handleBlur = () => { altKeyPressedRef.current = false; };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  const fitView = useCallback((options?: any) => {
    rfFitView({ ...options });
  }, [rfFitView]);

  // Track array reference changes to detect loops
  const prevNodesRef = useRef(nodes);
  const prevEdgesRef = useRef(edges);
  const nodesChangeCountRef = useRef(0);
  const edgesChangeCountRef = useRef(0);
  // Keep a stable reference to nodes map for use in effects that shouldn't depend on nodes array reference
  const nodesMapRef = useRef(new Map<string, any>());
  useEffect(() => {
    if (prevNodesRef.current !== nodes) {
      nodesChangeCountRef.current++;
      prevNodesRef.current = nodes;
      // Update nodes map ref
      nodesMapRef.current = new Map(nodes.map(n => [n.id, n]));
    }
    if (prevEdgesRef.current !== edges) {
      edgesChangeCountRef.current++;
      prevEdgesRef.current = edges;
    }
  }, [nodes, edges]);
  
  // Custom onEdgesChange handler to prevent automatic deletion
  const onEdgesChange = useCallback((changes: any[]) => {
    let filteredChanges = changes.filter((change: any) => change.type !== 'remove');
    if (activeElementTool === 'pan') {
      filteredChanges = filteredChanges.filter((c: any) => c.type !== 'select');
    }
    onEdgesChangeBase(filteredChanges);
  }, [onEdgesChangeBase, activeElementTool]);
  
  // Auto-layout state
  const [layoutDirection, setLayoutDirection] = useState<'LR' | 'RL' | 'TB' | 'BT'>('LR');
  
  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flowX: number; flowY: number; flowW?: number; flowH?: number } | null>(null);
  const [nodeContextMenu, setNodeContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [postitContextMenu, setPostitContextMenu] = useState<{ x: number; y: number; postitId: string } | null>(null);
  const [containerContextMenu, setContainerContextMenu] = useState<{ x: number; y: number; containerId: string } | null>(null);
  const [analysisContextMenu, setAnalysisContextMenu] = useState<{ x: number; y: number; analysisId: string } | null>(null);
  const [analysisCtxAvailableTypes, setAnalysisCtxAvailableTypes] = useState<import('../lib/graphComputeClient').AvailableAnalysis[]>([]);
  const [ctxDslEditState, setCtxDslEditState] = useState<{ analysisId: string; scenarioId: string } | null>(null);
  const [multiSelectContextMenu, setMultiSelectContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [edgeContextMenu, setEdgeContextMenu] = useState<{ x: number; y: number; edgeId: string } | null>(null);
  const [contextMenuLocalData, setContextMenuLocalData] = useState<{
    probability: number;
    conditionalProbabilities: { [key: string]: number };
    variantWeight: number;
  } | null>(null);
  
  // Ref to access latest nodes inside onNodesChange without adding `nodes` to deps
  // (adding `nodes` would recreate the callback on every position change → render loop)
  const nodesForSnapRef = useRef(nodes);
  nodesForSnapRef.current = nodes;

  // Ref for guards — populated by useGraphSync below, used in onNodesChange to avoid
  // a temporal dependency on the guards const (which is declared after this callback).
  const guardsRef = useRef<SyncGuards | null>(null);

  // Custom onNodesChange handler — snap-to-guide interception + auto re-routing
  const onNodesChange = useCallback((changes: any[]) => {
    const filtered = activeElementTool === 'pan'
      ? changes.filter((c: any) => c.type !== 'select')
      : changes;

    // Apply snap-to-guide lines before committing position changes
    if (import.meta.env.DEV) {
      const posDrag = filtered.filter((c: any) => c.type === 'position' && c.dragging === true);
      if (posDrag.length > 0) {
        console.log('[GraphCanvas] onNodesChange DRAG:', {
          snapToGuides,
          altKey: altKeyPressedRef.current,
          dragCount: posDrag.length,
          nodeId: posDrag[0].id,
          hasPosition: !!posDrag[0].position,
        });
      }
    }
    const snapped = applySnapToChanges(filtered, nodesForSnapRef.current, snapToGuides, altKeyPressedRef.current, useSankeyView);
    onNodesChangeBase(snapped);

    if (autoReroute) {
      if (guardsRef.current?.isBlocked()) {
        console.log(`[${ts()}] [GraphCanvas] Reroute suppressed (layout/cooldown active)`);
        return;
      }
      // Only trigger reroute for user-initiated drags (dragging === true).
      // Sync-generated position changes (from Graph→ReactFlow sync) don't
      // set dragging, so this prevents the reroute→sync→reroute loop that
      // isSyncingRef was guarding against, without blocking real user drags.
      const dragPositionChanges = changes.filter(
        (change: any) => change.type === 'position' && change.dragging === true,
      );
      if (dragPositionChanges.length > 0) {
        triggerRerouteRef.current?.();
      }
    }
  }, [autoReroute, snapToGuides, useSankeyView, onNodesChangeBase, activeElementTool, applySnapToChanges]);

  // Handle external selection (for deep linking from issues viewer, etc.)
  // Track the last external selection to avoid re-processing
  const lastExternalSelectionRef = useRef<{ nodeId: string | null | undefined; edgeId: string | null | undefined }>({ nodeId: undefined, edgeId: undefined });
  
  useEffect(() => {
    // Only process if there's a new external selection request
    const nodeChanged = externalSelectedNodeId !== lastExternalSelectionRef.current.nodeId;
    const edgeChanged = externalSelectedEdgeId !== lastExternalSelectionRef.current.edgeId;
    
    if (!nodeChanged && !edgeChanged) return;
    
    // Update the ref to track this selection
    lastExternalSelectionRef.current = { nodeId: externalSelectedNodeId, edgeId: externalSelectedEdgeId };
    
    // If we have a node to select
    if (externalSelectedNodeId) {
      console.log('[GraphCanvas] External node selection:', externalSelectedNodeId);
      setNodes(prevNodes => prevNodes.map(n => ({
        ...n,
        selected: n.id === externalSelectedNodeId
      })));
      setEdges(prevEdges => prevEdges.map(e => ({ ...e, selected: false })));
      onSelectedNodeChange(externalSelectedNodeId);
      onSelectedEdgeChange(null);
    }
    // If we have an edge to select
    else if (externalSelectedEdgeId) {
      console.log('[GraphCanvas] External edge selection:', externalSelectedEdgeId);
      setNodes(prevNodes => prevNodes.map(n => ({ ...n, selected: false })));
      setEdges(prevEdges => prevEdges.map(e => ({
        ...e,
        selected: e.id === externalSelectedEdgeId
      })));
      onSelectedNodeChange(null);
      onSelectedEdgeChange(externalSelectedEdgeId);
    }
  }, [externalSelectedNodeId, externalSelectedEdgeId, setNodes, setEdges, onSelectedNodeChange, onSelectedEdgeChange]);

  // NOTE: Edge width calculation moved to buildScenarioRenderEdges.ts (unified scenario pipeline)
  // GraphCanvas only provides calculateEdgeOffsets for bundling/spacing logic
  // Core computation extracted to canvas/edgeGeometry.ts

  const calculateEdgeOffsets = useCallback((edgesWithWidth: any[], allNodes: any[], maxWidth: number) => {
    return calculateEdgeOffsetsCore(edgesWithWidth, allNodes, maxWidth, useUniformScaling);
  }, [useUniformScaling, graphStoreHook]);

  const reactFlowWrapperRef = useRef<HTMLDivElement>(null); // For lasso coordinate calculations
  // Ref to autofocus edge probability input in context menu
  const edgeProbabilityInputRef = useRef<HTMLInputElement | null>(null);
  
  // Separate state for input display to allow intermediate states like "."
  const [edgeProbabilityDisplay, setEdgeProbabilityDisplay] = useState<string>('');

  // Focus probability input when edge context menu opens
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphCanvas] useEffect#GC3: Focus edge probability input`);
    if (edgeContextMenu && edgeProbabilityInputRef.current) {
      // Initialize display state with current probability value
      setEdgeProbabilityDisplay(String(contextMenuLocalData?.probability || 0));
      requestAnimationFrame(() => {
        edgeProbabilityInputRef.current?.focus();
        edgeProbabilityInputRef.current?.select();
      });
    }
  }, [edgeContextMenu, contextMenuLocalData?.probability]);
  
  // Calculate optimal handles between two nodes
  const calculateOptimalHandles = useCallback((sourceNode: any, targetNode: any) => {
    // Calculate direction from source to target
    const deltaX = targetNode.position.x - sourceNode.position.x;
    const deltaY = targetNode.position.y - sourceNode.position.y;
    
    // For source node: this is an output connection, direction TO target
    const sourceFace = getOptimalFace(sourceNode.id, true, deltaX, deltaY, edges, useSankeyView);
    
    // For target node: this is an input connection, direction FROM source (inverse)
    const targetFace = getOptimalFace(targetNode.id, false, -deltaX, -deltaY, edges, useSankeyView);
    
    // Convert face to handle format
    const sourceHandle = sourceFace + '-out';
    const targetHandle = targetFace;
    
    return { sourceHandle, targetHandle };
  }, [edges, useSankeyView]);

  // triggerReroute ref — populated below after useEdgeRouting is called.
  // Used in onNodesChange to avoid temporal dependency on the triggerReroute const.
  const triggerRerouteRef = useRef<(() => void) | null>(null);

  // Get all existing ids (nodes and edges) for uniqueness checking
  const getAllExistingIds = useCallback((excludeId?: string) => {
    if (!graph) return [];
    
    const nodeIds = graph.nodes
      .filter((node: any) => node.uuid !== excludeId)
      .map((node: any) => node.id)
      .filter(Boolean);
    
    const edgeIds = graph.edges
      .filter((edge: any) => edge.uuid !== excludeId)
      .map((edge: any) => edge.id)
      .filter(Boolean);
    
    return [...nodeIds, ...edgeIds];
  }, [graph]);
  
  // Callback functions for node/edge updates
  const handleUpdateNode = useCallback((id: string, data: any) => {
    console.log('handleUpdateNode called:', { id, data });
    if (!graph) return;
    
    const prevGraph = graph;
      
    // Check for id uniqueness if id is being updated
    if (data.id) {
      const existingIds = getAllExistingIds(id);
      if (existingIds.includes(data.id)) {
        alert(`ID "${data.id}" is already in use. Please choose a different ID.`);
        return;
      }
    }
    
    const nextGraph = structuredClone(prevGraph);
    const nodeIndex = nextGraph.nodes.findIndex(n => n.uuid === id);
    if (nodeIndex >= 0) {
      nextGraph.nodes[nodeIndex] = { ...nextGraph.nodes[nodeIndex], ...data };
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      console.log('Updated node in graph:', nextGraph.nodes[nodeIndex]);
    }
    setGraph(nextGraph);
  }, [graph, setGraph, getAllExistingIds]);

  const handleDeleteNode = useCallback(async (nodeUuid: string) => {
    console.log('=== DELETING NODE ===', nodeUuid);
    
    if (!graph) {
      console.log('No graph, aborting delete');
      return;
    }
    
    console.log('BEFORE DELETE:', {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      hasPolicies: !!graph.policies,
      hasMetadata: !!graph.metadata
    });
    
    // Use UpdateManager to delete node and clean up edges (now async for image GC)
    const { updateManager } = await import('../services/UpdateManager');
    const nextGraph = await updateManager.deleteNode(graph, nodeUuid);
    
    console.log('AFTER DELETE:', {
      nodes: nextGraph.nodes.length,
      edges: nextGraph.edges.length,
      hasPolicies: !!nextGraph.policies,
      hasMetadata: !!nextGraph.metadata
    });
    
    setGraph(nextGraph);

    // Save history state for node deletion
    saveHistoryState('Delete node', nodeUuid);
    
    // Clear selection when node is deleted
    onSelectedNodeChange(null);
  }, [graph, setGraph, onSelectedNodeChange, saveHistoryState]);

  const handleUpdateEdge = useCallback((id: string, data: any) => {
    if (!graph) return;
    
    const prevGraph = graph;
    
    // Check for id uniqueness if id is being updated
    if (data.id) {
      const existingIds = getAllExistingIds(id);
      if (existingIds.includes(data.id)) {
        alert(`ID "${data.id}" is already in use. Please choose a different ID.`);
        return;
      }
    }
    
    const nextGraph = structuredClone(prevGraph);
    const edgeIndex = nextGraph.edges.findIndex(e => e.uuid === id);
    if (edgeIndex >= 0) {
      nextGraph.edges[edgeIndex] = { ...nextGraph.edges[edgeIndex], ...data };
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
    }
    setGraph(nextGraph);
  }, [graph, setGraph, getAllExistingIds]);

  /**
   * Handle edge reconnection from ConversionEdge's custom drag handlers
   * This is called when the user drags an edge endpoint to a different node or face
   * 
   * @param edgeId - The UUID of the edge being reconnected
   * @param newSource - New source node UUID (if reconnecting source), or undefined
   * @param newTarget - New target node UUID (if reconnecting target), or undefined  
   * @param newTargetHandle - New target handle/face (e.g., 'left', 'right', 'top', 'bottom')
   * @param newSourceHandle - New source handle/face (e.g., 'left', 'right', 'top', 'bottom')
   */
  const handleReconnect = useCallback((
    edgeId: string, 
    newSource?: string, 
    newTarget?: string, 
    newTargetHandle?: string, 
    newSourceHandle?: string
  ) => {
    if (!graph) return;
    
    console.log('🔄 handleReconnect called:', { edgeId, newSource, newTarget, newTargetHandle, newSourceHandle });
    
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeId || e.id === edgeId);
    
    if (edgeIndex === -1) {
      console.warn('handleReconnect: Edge not found:', edgeId);
      return;
    }
    
    const edge = nextGraph.edges[edgeIndex];
    const originalFrom = edge.from;
    const originalTo = edge.to;
    
    // Update source if provided
    if (newSource !== undefined) {
      edge.from = newSource;
      // Add '-out' suffix for source handles if not already present
      if (newSourceHandle) {
        edge.fromHandle = newSourceHandle.endsWith('-out') ? newSourceHandle : `${newSourceHandle}-out`;
      }
    }
    
    // Update target if provided
    if (newTarget !== undefined) {
      edge.to = newTarget;
      // Target handles don't need '-out' suffix
      if (newTargetHandle) {
        edge.toHandle = newTargetHandle;
      }
    }
    
    // Update edge ID if source/target changed (not just handles)
    // Use "-" instead of "->" to avoid invalid characters in IDs
    if (edge.from !== originalFrom || edge.to !== originalTo) {
      const newEdgeId = `${edge.from}-${edge.to}`;
      edge.id = newEdgeId;
    }
    
    // Update metadata
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    console.log('✅ handleReconnect: Edge updated:', {
      from: `${originalFrom} → ${edge.from}`,
      to: `${originalTo} → ${edge.to}`,
      fromHandle: edge.fromHandle,
      toHandle: edge.toHandle
    });
    
    setGraph(nextGraph);
    saveHistoryState('Reconnect edge', undefined, edgeId);
  }, [graph, setGraph, saveHistoryState]);

  const handleDeleteEdge = useCallback(async (edgeUuid: string) => {
    console.log('=== DELETING EDGE ===', edgeUuid);
    
    if (!graph) {
      console.log('No graph, aborting delete');
      return;
    }
    
    // Use UpdateManager to delete edge
    const { updateManager } = await import('../services/UpdateManager');
    const nextGraph = updateManager.deleteEdge(graph, edgeUuid);
    
    setGraph(nextGraph);
    
    // Note: History saving is handled by the calling component (PropertiesPanel or deleteSelected)
    
    // Clear selection when edge is deleted
    onSelectedEdgeChange(null);
  }, [graph, setGraph, onSelectedEdgeChange]);

  // Reorder ReactFlow canvas object nodes to match graph array order (DOM order = paint order = z-order).
  // Containers go at START (behind everything); postits/analyses go at END (on top).
  const reorderCanvasNodes = useCallback((prefix: string, graphArray: any[]) => {
    const orderMap = new Map(graphArray.map((p: any, i: number) => [p.id, i]));
    const isBackground = prefix === 'container-';
    setNodes(nds => {
      const others = nds.filter(n => !n.id?.startsWith(prefix));
      const typed = nds.filter(n => n.id?.startsWith(prefix));
      typed.sort((a, b) => {
        const ai = orderMap.get(a.id.replace(prefix, '')) ?? 0;
        const bi = orderMap.get(b.id.replace(prefix, '')) ?? 0;
        return ai - bi;
      });
      return isBackground ? [...typed, ...others] : [...others, ...typed];
    });
  }, [setNodes]);

  const postitHistoryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const handleUpdatePostit = useCallback((id: string, updates: any) => {
    const current = graphRef.current;
    if (!current) return;
    const nextGraph = structuredClone(current);
    if (!nextGraph.postits) return;
    const p = nextGraph.postits.find((p: any) => p.id === id);
    if (!p) return;
    Object.assign(p, updates);
    if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
    // Use setGraphDirect (synchronous) — postit updates are never topology changes
    // and the async setGraph wrapper causes stale graphRef during rapid resize/typing
    setGraphDirect(nextGraph);
    graphRef.current = nextGraph; // Keep ref in sync for rapid successive calls (e.g. resize)
    // Debounce history: coalesce rapid changes (typing, resizing) into one undo step
    if (postitHistoryTimerRef.current) clearTimeout(postitHistoryTimerRef.current);
    postitHistoryTimerRef.current = setTimeout(() => {
      saveHistoryState('Update post-it');
      postitHistoryTimerRef.current = null;
    }, 800);
  }, [setGraphDirect, saveHistoryState]);

  const handleDeletePostit = useCallback((id: string) => {
    if (!graph) return;
    const nextGraph = structuredClone(graph);
    if (!nextGraph.postits) return;
    nextGraph.postits = nextGraph.postits.filter((p: any) => p.id !== id);
    if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
    // Use setGraphDirect — deleting a postit doesn't change graph topology.
    setGraphDirect(nextGraph);
    saveHistoryState('Delete post-it');
    onSelectedAnnotationChange?.(null, null);
  }, [graph, setGraphDirect, saveHistoryState, onSelectedAnnotationChange]);

  const containerHistoryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const handleUpdateContainer = useCallback((id: string, updates: any) => {
    const current = graphRef.current;
    if (!current) { console.warn(`[handleUpdateContainer] graphRef.current is null!`); return; }
    const nextGraph = structuredClone(current);
    if (!nextGraph.containers) { console.warn(`[handleUpdateContainer] no containers array!`); return; }
    const c = nextGraph.containers.find((c: any) => c.id === id);
    if (!c) { console.warn(`[handleUpdateContainer] container ${id.slice(0,8)} not found!`); return; }
    const prevW = c.width, prevH = c.height;
    Object.assign(c, updates);
    console.log(`[handleUpdateContainer] ${id.slice(0,8)}: ${prevW}x${prevH} → ${c.width}x${c.height}`);
    if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
    setGraphDirect(nextGraph);
    graphRef.current = nextGraph; // Keep ref in sync for rapid successive calls (e.g. resize)
    if (containerHistoryTimerRef.current) clearTimeout(containerHistoryTimerRef.current);
    containerHistoryTimerRef.current = setTimeout(() => {
      saveHistoryState('Update container');
      containerHistoryTimerRef.current = null;
    }, 800);
  }, [setGraphDirect, saveHistoryState]);

  const handleDeleteContainer = useCallback((id: string) => {
    if (!graph) return;
    const nextGraph = structuredClone(graph);
    if (!nextGraph.containers) return;
    nextGraph.containers = nextGraph.containers.filter((c: any) => c.id !== id);
    if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
    // Use setGraphDirect — deleting a container doesn't change graph topology.
    setGraphDirect(nextGraph);
    saveHistoryState('Delete container');
    onSelectedAnnotationChange?.(null, null);
  }, [graph, setGraphDirect, saveHistoryState, onSelectedAnnotationChange]);

  const analysisHistoryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const handleUpdateAnalysis = useCallback((id: string, updates: any) => {
    const nextGraph = mutateCanvasAnalysisGraph(graphRef.current, id, (a) => {
      Object.assign(a, updates);
    });
    if (!nextGraph) return;
    setGraphDirect(nextGraph);
    graphRef.current = nextGraph; // Keep ref in sync for rapid successive calls (e.g. resize)
    if (analysisHistoryTimerRef.current) clearTimeout(analysisHistoryTimerRef.current);
    analysisHistoryTimerRef.current = setTimeout(() => {
      saveHistoryState('Update canvas analysis');
      analysisHistoryTimerRef.current = null;
    }, 800);
  }, [setGraphDirect, saveHistoryState]);

  const handleDeleteAnalysis = useCallback((id: string) => {
    const nextGraph = deleteCanvasAnalysisFromGraph(graph, id);
    if (!nextGraph) return;
    setGraph(nextGraph);
    saveHistoryState('Delete canvas analysis');
    onSelectedAnnotationChange?.(null, null);
  }, [graph, setGraph, saveHistoryState, onSelectedAnnotationChange]);

  // Delete selected elements
  const deleteSelected = useCallback(async () => {
    if (!graph) return;
    
    const selectedNodes = nodes.filter(n => n.selected);
    const selectedEdges = edges.filter(e => e.selected);
    
    console.log('deleteSelected called with:', selectedNodes.length, 'nodes and', selectedEdges.length, 'edges');
    
    if (selectedNodes.length === 0 && selectedEdges.length === 0) return;
    
    // Save history state BEFORE deletion
    if (selectedNodes.length > 1 || selectedEdges.length > 1 || (selectedNodes.length > 0 && selectedEdges.length > 0)) {
      saveHistoryState('Delete selected', undefined, undefined);
    } else if (selectedEdges.length === 1) {
      saveHistoryState('Delete edge', undefined, selectedEdges[0].id);
    } else if (selectedNodes.length === 1) {
      saveHistoryState('Delete node', selectedNodes[0].id);
    }
    
    // Use UpdateManager for deletions
    const { updateManager } = await import('../services/UpdateManager');
    let nextGraph = graph;
    
    const selectedConversionNodes = selectedNodes.filter(n => !isCanvasObjectNode(n.id));

    // Delete selected conversion nodes (also deletes their connected edges via UpdateManager)
    for (const nodeUuid of selectedConversionNodes.map(n => n.id)) {
      nextGraph = await updateManager.deleteNode(nextGraph, nodeUuid);
    }
    
    // Delete selected edges (that weren't already deleted with nodes)
    const selectedEdgeUUIDs = selectedEdges.map(e => e.id);
    for (const edgeUuid of selectedEdgeUUIDs) {
      const edgeExists = nextGraph.edges.some((e: any) => e.uuid === edgeUuid);
      if (edgeExists) {
        nextGraph = updateManager.deleteEdge(nextGraph, edgeUuid);
      }
    }

    // Delete selected canvas objects (postits, containers, analyses) — table-driven
    const CANVAS_OBJECT_TYPES = [
      { prefix: 'postit-', graphKey: 'postits' },
      { prefix: 'container-', graphKey: 'containers' },
      { prefix: 'analysis-', graphKey: 'canvasAnalyses' },
    ] as const;

    let hasCanvasDeletes = false;
    for (const { prefix, graphKey } of CANVAS_OBJECT_TYPES) {
      const selectedIds = selectedNodes
        .filter(n => n.id?.startsWith(prefix))
        .map(n => n.id.replace(prefix, ''));
      if (selectedIds.length > 0 && nextGraph[graphKey]) {
        if (!hasCanvasDeletes) { nextGraph = structuredClone(nextGraph); hasCanvasDeletes = true; }
        const idSet = new Set(selectedIds);
        (nextGraph as any)[graphKey] = (nextGraph[graphKey] as any[]).filter((obj: any) => !idSet.has(obj.id));
      }
    }

    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    setGraph(nextGraph);
    
    if (selectedConversionNodes.length > 0) {
      onSelectedNodeChange(null);
    }
    if (selectedEdges.length > 0) {
      onSelectedEdgeChange(null);
    }
    if (hasCanvasDeletes) {
      onSelectedAnnotationChange?.(null, null);
    }
  }, [nodes, edges, graph, setGraph, saveHistoryState, onSelectedNodeChange, onSelectedEdgeChange, onSelectedAnnotationChange, isCanvasObjectNode]);

  // Sync engine (extracted to useGraphSync)
  const setForceRerouteRef = useRef<((v: boolean) => void) | null>(null);
  const { guards, autoEditPostitIdRef, autoSelectAnalysisIdRef, lastRenderEdgesRef, lastSyncedReactFlowRef, isEffectsCooldownActive, handleResizeStart, handleResizeEnd } = useGraphSync({
    graph,
    nodes,
    edges,
    setNodes,
    setEdges,
    setGraph,
    fitView,
    tabId,
    tabs,
    useSankeyView,
    showNodeImages,
    effectiveWhatIfDSL,
    overridesVersion,
    effectiveActiveTabId,
    calculateEdgeOffsets,
    nodesMapRef,
    graphStoreHook,
    scenariosContext,
    useUniformScaling,
    massGenerosity,
    setForceRerouteRef,
    activeElementTool,
    handleUpdateNode,
    handleDeleteNode,
    handleUpdateEdge,
    handleDeleteEdge,
    handleReconnect,
    handleUpdatePostit,
    handleDeletePostit,
    handleUpdateContainer,
    handleDeleteContainer,
    handleUpdateAnalysis,
    handleDeleteAnalysis,
    onSelectedAnnotationChange,
    onDoubleClickNode,
    onDoubleClickEdge,
    onSelectEdge,
    whatIfDSL,
  });
  guardsRef.current = guards;

  // Edge routing hook (extracted from GraphCanvas Phase B2)
  const {
    triggerReroute,
    setForceReroute,
    skipNextRerouteRef,
    performImmediateReroute,
  } = useEdgeRouting({
    graph,
    nodes,
    edges,
    setGraph,
    autoReroute,
    useSankeyView,
    calculateOptimalHandles,
    guards,
  });
  setForceRerouteRef.current = setForceReroute;
  triggerRerouteRef.current = triggerReroute;

  // Listen for selection queries (for Copy/Cut/Paste from Edit menu)
  useEffect(() => {
    const handler = (e: any) => {
      if (!e?.detail) return;
      
      const selectedNodes = nodes.filter(n => n.selected);
      const selectedEdges = edges.filter(e => e.selected);
      
      let conversionNodeUuids = selectedNodes.filter(n => !isCanvasObjectNode(n.id)).map(n => n.id);
      e.detail.selectedEdgeUuids = selectedEdges.map(e => e.id);
      e.detail.selectedPostitIds = selectedNodes.filter(n => n.id?.startsWith('postit-')).map(n => n.id.replace('postit-', ''));
      const containerIds = selectedNodes.filter(n => n.id?.startsWith('container-')).map(n => n.id.replace('container-', ''));
      e.detail.selectedContainerIds = containerIds;
      e.detail.selectedAnalysisIds = selectedNodes.filter(n => n.id?.startsWith('analysis-')).map(n => n.id.replace('analysis-', ''));

      // When a container is selected and no conversion nodes are, expand to contained nodes
      if (conversionNodeUuids.length === 0 && containerIds.length > 0 && graph?.containers) {
        for (const cid of containerIds) {
          const c = graph.containers.find((ci: any) => ci.id === cid);
          if (c) {
            conversionNodeUuids.push(...getContainedConversionNodeIds(c, nodes));
          }
        }
      }
      e.detail.selectedNodeUuids = conversionNodeUuids;
    };
    window.addEventListener('dagnet:querySelection', handler as any);
    return () => window.removeEventListener('dagnet:querySelection', handler as any);
  }, [nodes, edges, graph, isCanvasObjectNode]);

  // Listen for select all nodes request (from Edit menu)
  useEffect(() => {
    const handler = () => {
      // Select all nodes (not edges - user can select those via shift-click if needed)
      setNodes(prevNodes => prevNodes.map(n => ({ ...n, selected: true })));
      // Deselect all edges when selecting all nodes
      setEdges(prevEdges => prevEdges.map(e => ({ ...e, selected: false })));
      // Clear primary selection (multi-selection mode)
      onSelectedNodeChange(null);
      onSelectedEdgeChange(null);
    };
    window.addEventListener('dagnet:selectAllNodes', handler);
    return () => window.removeEventListener('dagnet:selectAllNodes', handler);
  }, [setNodes, setEdges, onSelectedNodeChange, onSelectedEdgeChange]);


  // Edge connection hook (extracted from GraphCanvas Phase B3)
  const {
    onEdgeUpdate,
    onConnect,
    generateEdgeId,
    handleVariantSelection,
    wouldCreateCycle,
    showVariantModal,
    pendingConnection,
    caseNodeVariants,
    dismissVariantModal,
  } = useEdgeConnection({
    graph,
    nodes,
    edges,
    setGraph,
    saveHistoryState,
    onSelectedEdgeChange,
    guards,
    skipNextRerouteRef,
    getAllExistingIds,
  });

  // Canvas creation hook (extracted from GraphCanvas Phase B4a)
  const {
    addNodeAtPosition,
    addPostitAtPosition,
    addContainerAtPosition,
    addChartAtPosition,
    pasteNodeAtPosition,
    pasteSubgraphAtPosition,
    startAddChart,
    handleDragOver,
    handleDrop,
    onPaneMouseDown,
    onPaneMouseMove,
    onPaneMouseUp,
    onPaneClick,
    drawRect,
    drawStartRef,
    rightDragRect,
    consumeRightDragRect,
    clearRightDrag,
  } = useCanvasCreation({
    graph,
    nodes,
    edges,
    setGraph,
    setGraphDirect,
    saveHistoryState,
    setNodes,
    screenToFlowPosition,
    onSelectedNodeChange,
    onSelectedEdgeChange,
    onSelectedAnnotationChange,
    setContextMenu,
    activeElementTool,
    setActiveElementTool,
    onClearElementTool,
    copiedNode,
    copiedSubgraph,
    isCanvasObjectNode,
    getContainedConversionNodeIds,
    autoEditPostitIdRef,
    autoSelectAnalysisIdRef,
    tabId,
    effectiveActiveTabId,
    onAddNodeRef,
    onAddPostitRef,
    onAddContainerRef,
  });

  // Lasso selection + keyboard delete hook (extracted from GraphCanvas Phase B4b)
  const { isLassoSelecting, lassoStart, lassoEnd } = useLassoSelection({
    nodes,
    edges,
    setNodes,
    deleteSelected,
    screenToFlowPosition,
    activeElementTool,
    onClearElementTool,
    tabId,
  });


  // Track selected nodes for probability calculation
  const [selectedNodesForAnalysis, setSelectedNodesForAnalysis] = useState<any[]>([]);

  // STEP 4: Compute highlight metadata (pure algorithms in canvas/pathHighlighting.ts)
  const edgeIdsRef = React.useRef<string>('');
  const currentEdgeIds = edges.map(e => e.id).sort().join(',');
  const edgesChanged = edgeIdsRef.current !== currentEdgeIds;
  if (edgesChanged) {
    edgeIdsRef.current = currentEdgeIds;
  }

  const nodeSelectionKey = selectedNodesForAnalysis.map(n => n.id).sort().join(',');
  const highlightMetadata = React.useMemo(() => {
    return computeHighlightMetadata(selectedNodesForAnalysis, edges);
  }, [selectedNodesForAnalysis, nodeSelectionKey, edges, edgesChanged]);

  // Handle selection changes
  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: any) => {
    
    // In pan mode, suppress all selection
    if (activeElementTool === 'pan') {
      return;
    }
    
    // Update selected nodes for analysis — only conversion nodes affect highlighting
    const conversionNodes = selectedNodes.filter((n: any) => !isCanvasObjectNode(n.id));
    if (selectedNodes.length > 0) {
      console.log('[GraphCanvas] onSelectionChange', {
        allSelectedNodeIds: selectedNodes.map((n: any) => n.id),
        conversionNodeIds: conversionNodes.map((n: any) => n.id),
        canvasObjectNodeIds: selectedNodes.filter((n: any) => isCanvasObjectNode(n.id)).map((n: any) => n.id),
      });
    }
    setSelectedNodesForAnalysis(conversionNodes);
    
    // Don't clear selection if we're currently lasso selecting
    if (isLassoSelecting) {
      return;
    }
    
    // CRITICAL: Filter out snapshot overlay edges from selection
    // Only 'current' layer edges should be selectable
    const selectableEdges = selectedEdges.filter((e: any) => !e.data?.scenarioOverlay);
    
    if (selectableEdges.length !== selectedEdges.length) {
      console.warn(`[GraphCanvas] Filtered out ${selectedEdges.length - selectableEdges.length} non-selectable overlay edges`);
    }
    
    // REMOVED: Re-sorting edges causes massive re-render cascade
    // ReactFlow handles z-index for selected edges via CSS, so we don't need to re-sort
    // This was causing flicker on every selection change
    
    // For multi-selection, we'll show the first selected item in the properties panel
    // but keep track of all selected items for operations like delete
    if (selectedNodes.length > 0) {
      const firstNode = selectedNodes[0];
      if (firstNode.id?.startsWith('postit-')) {
        onSelectedAnnotationChange?.(firstNode.id.replace('postit-', ''), 'postit');
        onSelectedNodeChange(null);
        onSelectedEdgeChange(null);
      } else if (firstNode.id?.startsWith('container-')) {
        onSelectedAnnotationChange?.(firstNode.id.replace('container-', ''), 'container');
        onSelectedNodeChange(null);
        onSelectedEdgeChange(null);
      } else if (firstNode.id?.startsWith('analysis-')) {
        onSelectedAnnotationChange?.(firstNode.id.replace('analysis-', ''), 'canvasAnalysis');
        onSelectedNodeChange(null);
        onSelectedEdgeChange(null);
      } else {
        onSelectedNodeChange(firstNode.id);
        onSelectedEdgeChange(null);
        onSelectedAnnotationChange?.(null, null);
      }
    } else if (selectableEdges.length > 0) {
      const selectedEdgeId = selectableEdges[0].id;
      onSelectedEdgeChange(selectedEdgeId);
      onSelectedNodeChange(null);
      onSelectedAnnotationChange?.(null, null);
    } else {
      onSelectedNodeChange(null);
      onSelectedEdgeChange(null);
      onSelectedAnnotationChange?.(null, null);
    }
  }, [onSelectedNodeChange, onSelectedEdgeChange, onSelectedAnnotationChange, isLassoSelecting, setSelectedNodesForAnalysis, activeElementTool, isCanvasObjectNode]);

  // Node drag hook (extracted from GraphCanvas Phase B4c)
  const { onNodeDragStart, onNodeDrag, onNodeDragStop } = useNodeDrag({
    graph,
    nodes,
    edges,
    setGraph,
    setNodes,
    saveHistoryState,
    resetHelperLines,
    rebuildSnapIndex,
    guards,
    setIsDraggingNode,
    setDraggedAnalysisId,
    lastSyncedReactFlowRef,
  });

  // Expose deleteSelected function to parent component via ref
  useEffect(() => {
    if (onDeleteSelectedRef) {
      onDeleteSelectedRef.current = deleteSelected;
    }
  }, [deleteSelected, onDeleteSelectedRef]);

  // Auto-layout function using dagre (core computation in canvas/layoutAlgorithms.ts)
  const performAutoLayout = useCallback((direction?: 'LR' | 'RL' | 'TB' | 'BT') => {
    if (!graph) return;

    const effectiveDirection = direction || layoutDirection;
    const { positions } = computeDagreLayoutCore(nodes, edges, effectiveDirection, useSankeyView);
    if (positions.size === 0) return;

    // Apply positions to graph
    const nextGraph = structuredClone(graph);
    positions.forEach(({ x, y }, nodeId) => {
      const graphNode = nextGraph.nodes.find((n: any) => n.uuid === nodeId || n.id === nodeId);
      if (graphNode) {
        if (!graphNode.layout) graphNode.layout = { x: 0, y: 0 };
        graphNode.layout.x = x;
        graphNode.layout.y = y;
      }
    });

    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }

    setGraph(nextGraph);
    saveHistoryState('Auto-layout', undefined, undefined);

    // ALWAYS trigger re-route after layout (regardless of autoReroute setting)
    setTimeout(() => {
      console.log('Triggering FORCED re-route after auto-layout');
      setForceReroute(true);
      setTimeout(() => {
        fitView({ padding: 0.1, duration: 400 });
      }, 200);
    }, 150);
  }, [graph, setGraph, nodes, edges, layoutDirection, fitView, saveHistoryState]);

  // Auto-layout function that can be called from parent
  const triggerAutoLayout = useCallback((direction: 'LR' | 'RL' | 'TB' | 'BT') => {
    setLayoutDirection(direction);
    // Pass direction directly to performAutoLayout (don't wait for state to update)
    performAutoLayout(direction);
  }, [performAutoLayout]);

  // Sankey auto-layout using d3-sankey (core computation in canvas/layoutAlgorithms.ts)
  const performSankeyLayout = useCallback(() => {
    if (!graph) return;

    // Begin layout transaction: block effects and start cooldown window
    guards.beginLayoutTransaction(800);

    const { positions } = computeSankeyLayoutCore(nodes, edges);
    if (positions.size === 0) return;

    // Apply positions to graph
    const nextGraph = structuredClone(graph);
    positions.forEach(({ x, y, sankeyHeight }, nodeId) => {
      const graphNode = nextGraph.nodes.find((n: any) => n.uuid === nodeId || n.id === nodeId);
      if (graphNode) {
        if (!graphNode.layout) graphNode.layout = { x: 0, y: 0 };
        (graphNode.layout as any).sankeyHeight = sankeyHeight;
        graphNode.layout.x = x;
        graphNode.layout.y = y;
      }
    });

    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }

    // Skip node sizing effect after layout (heights are already set upstream)
    guards.skipNextSankeyNodeSizing();

    setGraph(nextGraph);
    saveHistoryState('Sankey auto-layout', undefined, undefined);

    // End layout without forcing reroute; clear flag after a short delay + cooldown
    setTimeout(() => {
      guards.endLayoutTransaction(500);
      console.log('[Sankey Layout] Completed');
    }, 150);
  }, [graph, nodes, edges, setGraph, saveHistoryState, setForceReroute, fitView]);

  // Expose auto-layout function to parent component via ref
  useEffect(() => {
    if (onAutoLayoutRef) {
      onAutoLayoutRef.current = triggerAutoLayout;
    }
  }, [triggerAutoLayout, onAutoLayoutRef]);

  // Expose Sankey layout function to parent component via ref
  useEffect(() => {
    if (onSankeyLayoutRef) {
      onSankeyLayoutRef.current = performSankeyLayout;
    }
  }, [performSankeyLayout, onSankeyLayoutRef]);

  // Expose force re-route function to parent component via ref
  useEffect(() => {
    if (onForceRerouteRef) {
      onForceRerouteRef.current = () => {
        console.log('Force re-route triggered via ref');
        setForceReroute(true);
      };
    }
  }, [onForceRerouteRef]);

  // Hide unselected nodes function
  const hideUnselected = useCallback(async () => {
    if (!effectiveActiveTabId) return;
    
    const selectedNodes = nodes.filter(n => n.selected);
    // Tab operations use human-readable IDs, not UUIDs
    const selectedNodeIds = selectedNodes.map(n => n.data?.id || n.id);
    
    await tabOperations.hideUnselectedNodes(effectiveActiveTabId, selectedNodeIds);
  }, [effectiveActiveTabId, nodes, tabOperations]);

  // Expose hide unselected function to parent component via ref
  useEffect(() => {
    if (onHideUnselectedRef) {
      onHideUnselectedRef.current = hideUnselected;
    }
  }, [hideUnselected, onHideUnselectedRef]);


  // Handle canvas right-click for context menu
  // Close all context menus — called before opening any new one
  const closeAllContextMenus = useCallback((opts?: { keepRightDrag?: boolean }) => {
    setContextMenu(null);
    setNodeContextMenu(null);
    setPostitContextMenu(null);
    setContainerContextMenu(null);
    setAnalysisContextMenu(null);
    setMultiSelectContextMenu(null);
    setEdgeContextMenu(null);
    setContextMenuLocalData(null);
    if (!opts?.keepRightDrag) clearRightDrag();
  }, [clearRightDrag]);

  const onPaneContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();

    // Consume any right-drag rect before clearing other menus
    const rdRect = consumeRightDragRect();
    console.log('[DIAG] onPaneContextMenu: rdRect=', rdRect, 'keepRightDrag=', !!rdRect);
    closeAllContextMenus({ keepRightDrag: !!rdRect });

    if (rdRect) {
      // Right-drag lasso: open pane menu with drawn rect bounds
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        flowX: rdRect.x,
        flowY: rdRect.y,
        flowW: rdRect.w,
        flowH: rdRect.h,
      });
    } else {
      // Normal right-click: open pane menu at click position
      const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        flowX: flowPosition.x,
        flowY: flowPosition.y,
      });
    }
  }, [screenToFlowPosition, closeAllContextMenus, consumeRightDragRect]);

  // Resolve available analysis types when the canvas analysis context menu opens
  useEffect(() => {
    if (!analysisContextMenu || !graph) {
      setAnalysisCtxAvailableTypes([]);
      return;
    }
    const analysis = graph.canvasAnalyses?.find((a: any) => a.id === analysisContextMenu.analysisId) as any;
    if (!analysis) return;
    let cancelled = false;
    const dsl = analysis.recipe?.analysis?.analytics_dsl;
    const scenarioCount = analysis.mode === 'live'
      ? (tabId ? tabOperations.getScenarioState(tabId)?.visibleScenarioIds?.length : null) || 1
      : (analysis.recipe?.scenarios?.length || 1);
    resolveAnalysisType(graph, dsl || undefined, scenarioCount).then(({ availableAnalyses }) => {
      if (!cancelled) setAnalysisCtxAvailableTypes(availableAnalyses);
    });
    return () => { cancelled = true; };
  }, [analysisContextMenu, graph, tabId, tabOperations]);

  // Clear right-drag lasso visual when pane context menu closes (item clicked or dismissed)
  useEffect(() => {
    if (!contextMenu) clearRightDrag();
  }, [contextMenu, clearRightDrag]);

  // Close context menus on any click
  useEffect(() => {
    if (contextMenu || nodeContextMenu || postitContextMenu || containerContextMenu || analysisContextMenu || multiSelectContextMenu || edgeContextMenu) {
      const handleClick = () => closeAllContextMenus();
      // Delay adding the listener to avoid catching the same click that opened the menu
      const timeoutId = setTimeout(() => {
        document.addEventListener('click', handleClick);
      }, 0);

      return () => {
        clearTimeout(timeoutId);
        document.removeEventListener('click', handleClick);
      };
    }
  }, [contextMenu, nodeContextMenu, postitContextMenu, containerContextMenu, analysisContextMenu, multiSelectContextMenu, edgeContextMenu, closeAllContextMenus]);

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: any) => {
    event.preventDefault();
    event.stopPropagation();
    closeAllContextMenus();

    // Check if this is a multi-select with canvas objects (mixed-type or canvas-only)
    const selectedNodes = nodes.filter(n => n.selected);
    const hasCanvasObjects = selectedNodes.some(n => isCanvasObjectNode(n.id));

    if (selectedNodes.length >= 2 && hasCanvasObjects) {
      // Mixed-type or canvas-object multi-select → multi-select context menu
      setMultiSelectContextMenu({ x: event.clientX, y: event.clientY });
      return;
    }

    // Single-object or nodes-only multi-select → per-type context menu
    if (node.id?.startsWith('postit-')) {
      setPostitContextMenu({
        x: event.clientX,
        y: event.clientY,
        postitId: node.id.replace('postit-', ''),
      });
    } else if (node.id?.startsWith('container-')) {
      setContainerContextMenu({
        x: event.clientX,
        y: event.clientY,
        containerId: node.id.replace('container-', ''),
      });
    } else if (node.id?.startsWith('analysis-')) {
      setAnalysisContextMenu({
        x: event.clientX,
        y: event.clientY,
        analysisId: node.id.replace('analysis-', ''),
      });
    } else {
      setNodeContextMenu({
        x: event.clientX,
        y: event.clientY,
        nodeId: node.id,
      });
    }
  }, [nodes, isCanvasObjectNode, closeAllContextMenus]);

  // Shared: open edge context menu by edge ID (used by real right-click and E2E hooks)
  const openEdgeContextMenuById = useCallback((edgeId: string, clientX: number, clientY: number) => {
    closeAllContextMenus();
    // edge.id is ReactFlow ID (uuid), check both uuid and human-readable id
    const edgeData = graph?.edges?.find((e: any) => e.uuid === edgeId || e.id === edgeId);

    // Select the edge so properties panel shows the correct data
    onSelectedEdgeChange(edgeId);

    setEdgeContextMenu({
      x: clientX,
      y: clientY,
      edgeId: edgeId
    });
    setContextMenuLocalData({
      probability: edgeData?.p?.mean || 0,
      conditionalProbabilities: {},
      variantWeight: 0
    });
  }, [graph, onSelectedEdgeChange, closeAllContextMenus]);

  // Handle edge right-click
  const onEdgeContextMenu = useCallback((event: React.MouseEvent, edge: any) => {
    event.preventDefault();
    event.stopPropagation();
    openEdgeContextMenuById(edge.id, event.clientX, event.clientY);
  }, [openEdgeContextMenuById]);

  // Dev-only E2E hook: open edge context menu deterministically (no SVG hit-testing quirks).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('e2e')) return;
    } catch {
      return;
    }

    const handler = (e: any) => {
      const edgeUuid: string | undefined = e?.detail?.edgeUuid;
      const x: number = typeof e?.detail?.x === 'number' ? e.detail.x : 200;
      const y: number = typeof e?.detail?.y === 'number' ? e.detail.y : 200;
      if (!edgeUuid) return;
      openEdgeContextMenuById(edgeUuid, x, y);
    };

    window.addEventListener('dagnet:e2e:openEdgeContextMenu' as any, handler);
    return () => window.removeEventListener('dagnet:e2e:openEdgeContextMenu' as any, handler);
  }, [openEdgeContextMenuById]);

  // Delete specific node (called from context menu)
  // Note: This receives a React Flow node ID (which is the UUID)
  const deleteNode = useCallback(async (nodeUuid: string) => {
    if (!graph) return;
    
    // Use UpdateManager to delete node and clean up edges
    const { updateManager } = await import('../services/UpdateManager');
    const nextGraph = updateManager.deleteNode(graph, nodeUuid);
    
    setGraph(nextGraph);
    setNodeContextMenu(null);
    
    // Save history state for context menu deletion
    saveHistoryState('Delete node', nodeUuid);
    
    // Clear selection when node is deleted
    onSelectedNodeChange(null);
  }, [graph, setGraph, saveHistoryState, onSelectedNodeChange]);

  // Delete specific edge (called from context menu)
  const deleteEdge = useCallback(async (edgeUuid: string) => {
    if (!graph) return;
    
    // Use UpdateManager to delete edge
    const { updateManager } = await import('../services/UpdateManager');
    const nextGraph = updateManager.deleteEdge(graph, edgeUuid);
    
    setGraph(nextGraph);
    // Note: History saving is handled by PropertiesPanel for keyboard/button deletes
    setEdgeContextMenu(null);
  }, [graph, setGraph]);

  // Scenario visibility state (for colouring/suppression decisions)
  const scenarioState = tabId ? tabs.find(t => t.id === tabId)?.editorState?.scenarioState : undefined;

  const urlParams = new URLSearchParams(window.location.search);
  const MINIMAL_MODE = urlParams.has('minimal');

  const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
  const visibleColourOrderIds = scenarioState?.visibleColourOrderIds || [];
  
  // Log scenario state for debugging
  React.useEffect(() => {
    if (scenariosContext) {
      console.log(`[GraphCanvas] 📊 Scenario State:`, {
        totalScenarios: scenariosContext.scenarios.length,
        scenarios: scenariosContext.scenarios.map(s => ({ id: s.id, name: s.name })),
        visibleScenarioIds,
        visibleColourOrderIds
      });
    }
  }, [scenariosContext?.scenarios, visibleScenarioIds, visibleColourOrderIds, scenariosContext]);

  // NEW UNIFIED PIPELINE: Build all render edges through scenario logic
  // Replaces the old base/overlay split with a single scenario-based approach
  const renderEdges = React.useMemo(() => {
    try {
      if (!graph) {
        return edges;
      }
      if (!scenariosContext) {
        // Fallback: no scenarios, return base edges
        return edges;
      }

      // Determine if current query is cohort-based (affects latency bead policy)
      const isCohortQuery = effectiveWhatIfDSL?.includes('cohort(') ?? false;

      const result = buildScenarioRenderEdges({
        baseEdges: edges,
        nodes,
        graph,
        scenariosContext,
        visibleScenarioIds,
        visibleColourOrderIds,
        whatIfDSL: effectiveWhatIfDSL,
        useUniformScaling,
        massGenerosity,
        useSankeyView,
        calculateEdgeOffsets,
        tabId,
        highlightMetadata,  // STEP 4: Pass highlight flags for 'current' layer
        isInSlowPathRebuild: false,
        // ATOMIC RESTORATION: Do NOT pass isPanningOrZooming through buildScenarioRenderEdges
        // This keeps edge.data stable during decoration toggle
        // LAG rendering: pass visibility mode getter and cohort query flag
        getScenarioVisibilityMode: tabId 
          ? (scenarioId: string) => tabOperations.getScenarioVisibilityMode(tabId, scenarioId)
          : undefined,
        isCohortQuery
      });
      
      // Track render edges (not base edges) for merge on next slow-path rebuild
      lastRenderEdgesRef.current = result;
      
      return result;
    } catch (e) {
      console.warn('Failed to build scenario render edges:', e);
      return edges; // Fallback to base edges on error
    }
  }, [
    edges,
    nodes,
    graph,
    scenariosContext,
    visibleScenarioIds,
    visibleColourOrderIds,
    effectiveWhatIfDSL,
    useUniformScaling,
    massGenerosity,
    useSankeyView,
    calculateEdgeOffsets,
    tabId,
    highlightMetadata,  // Re-render when highlight changes
    shouldSuppressDecorations,  // PERF: Re-render when suppression state changes
    tabOperations  // LAG: needed for getScenarioVisibilityMode
  ]);

  // STEP 3: renderEdges is now the ONLY edge source; old base/overlay split removed
  // All edges (including 'current') are rendered through the scenario pipeline

  // Persist and restore viewport per tab
  const rf = useReactFlow();
  useEffect(() => {
    if (!tabId) return;
    const myTab = tabs.find(t => t.id === tabId);
    const vp = myTab?.editorState?.rfViewport as any;
    if (vp && typeof vp.x === 'number' && typeof vp.y === 'number' && typeof vp.zoom === 'number') {
      try {
        rf.setViewport(vp, { duration: 0 });
      } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // ATOMIC RESTORATION: Memoize decoration visibility context value for stability
  const decorationVisibilityValue = React.useMemo(
    () => ({ beadsVisible, isPanning: isPanningOrZooming, isDraggingNode, draggedAnalysisId }),
    [beadsVisible, isPanningOrZooming, isDraggingNode, draggedAnalysisId]
  );

  return (
    <DecorationVisibilityContext.Provider value={decorationVisibilityValue}>
      <div 
        ref={reactFlowWrapperRef} 
        style={{ height: '100%', position: 'relative' }}
        onPointerDown={(e) => {
          if (tabId && activeTabIdContext !== tabId) {
            void tabOperations.switchTab(tabId);
          }
          onPaneMouseDown(e);
        }}
        onPointerMove={onPaneMouseMove}
        onPointerUp={onPaneMouseUp}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {!graph && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: '14px', zIndex: 5, pointerEvents: 'none' }}>
            Loading...
          </div>
        )}
        {drawRect && drawRect.w > 5 && drawRect.h > 5 && (() => {
          const tl = flowToScreenPosition({ x: drawRect.x, y: drawRect.y });
          const br = flowToScreenPosition({ x: drawRect.x + drawRect.w, y: drawRect.y + drawRect.h });
          const wrapperBounds = reactFlowWrapperRef.current?.getBoundingClientRect();
          if (!wrapperBounds) return null;
          return (
            <div style={{
              position: 'absolute',
              left: tl.x - wrapperBounds.left,
              top: tl.y - wrapperBounds.top,
              width: br.x - tl.x,
              height: br.y - tl.y,
              backgroundColor: drawStartRef.current?.tool === 'new-container' ? 'rgba(148, 163, 184, 0.15)' : drawStartRef.current?.tool === 'new-analysis' ? 'rgba(59, 130, 246, 0.08)' : 'rgba(255, 244, 117, 0.3)',
              border: drawStartRef.current?.tool === 'new-container' ? '2px dashed rgba(148, 163, 184, 0.6)' : drawStartRef.current?.tool === 'new-analysis' ? '2px dashed rgba(59, 130, 246, 0.5)' : '2px dashed rgba(180, 160, 60, 0.6)',
              borderRadius: '2px',
              pointerEvents: 'none',
              zIndex: 9999,
            }} />
          );
        })()}
        {rightDragRect && rightDragRect.w > 5 && rightDragRect.h > 5 && (() => {
          const tl = flowToScreenPosition({ x: rightDragRect.x, y: rightDragRect.y });
          const br = flowToScreenPosition({ x: rightDragRect.x + rightDragRect.w, y: rightDragRect.y + rightDragRect.h });
          const wrapperBounds = reactFlowWrapperRef.current?.getBoundingClientRect();
          if (!wrapperBounds) return null;
          return (
            <div style={{
              position: 'absolute',
              left: tl.x - wrapperBounds.left,
              top: tl.y - wrapperBounds.top,
              width: br.x - tl.x,
              height: br.y - tl.y,
              backgroundColor: 'rgba(99, 102, 241, 0.08)',
              border: '2px dashed rgba(99, 102, 241, 0.5)',
              borderRadius: '2px',
              pointerEvents: 'none',
              zIndex: 9999,
            }} />
          );
        })()}
        <ReactFlow
          className={activeElementTool === 'pan' ? 'rf-pan-mode' : (activeElementTool === 'new-node' || activeElementTool === 'new-postit' || activeElementTool === 'new-container' || activeElementTool === 'new-analysis') ? 'rf-create-mode' : undefined}
          nodes={nodes}
          edges={renderEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onReconnect={onEdgeUpdate}
        onSelectionChange={onSelectionChange}
        onMoveStart={(_, viewport) => {
          // Cancel any pending decoration restoration
          if (decorationRestoreTimeoutRef.current) {
            clearTimeout(decorationRestoreTimeoutRef.current);
            decorationRestoreTimeoutRef.current = null;
          }
          
          // ATOMIC RESTORATION: Suppress decorations immediately (overlay flags only, no graph mutation)
          setBeadsVisible(false);
          
          // Store initial viewport to detect actual movement
          moveStartViewportRef.current = {
            x: viewport.x,
            y: viewport.y,
            zoom: viewport.zoom
          };
          hasMovedRef.current = false;
          
          // FALLBACK: If onMoveEnd doesn't fire (e.g., for quick clicks), restore beads after a short delay
          // This ensures beads reappear even if onMoveEnd is missed
          decorationRestoreTimeoutRef.current = setTimeout(() => {
            // Only restore if we haven't moved (no pan/zoom occurred)
            if (!hasMovedRef.current && moveStartViewportRef.current) {
              setBeadsVisible(true);
              moveStartViewportRef.current = null;
              decorationRestoreTimeoutRef.current = null;
            }
          }, 100); // 100ms fallback - should be longer than a click but shorter than user would notice
        }}
        onMove={(_, viewport) => {
          // Only set panning state if viewport actually changed
          // This prevents clicks from hiding beads
          if (moveStartViewportRef.current) {
            const dx = Math.abs(viewport.x - moveStartViewportRef.current.x);
            const dy = Math.abs(viewport.y - moveStartViewportRef.current.y);
            const dz = Math.abs(viewport.zoom - moveStartViewportRef.current.zoom);
            
            // Only consider it movement if viewport changed significantly (more than 1px or 0.01 zoom)
            if ((dx > 1 || dy > 1 || dz > 0.01) && !hasMovedRef.current) {
              hasMovedRef.current = true;
              // Clear any pending timeout
              if (panTimeoutRef.current) {
                clearTimeout(panTimeoutRef.current);
                panTimeoutRef.current = null;
              }
              setIsPanningOrZooming(true);
            }
          }
        }}
        onMoveEnd={(_, viewport) => {
          // Only update state if we were actually panning/zooming
          if (hasMovedRef.current) {
            // Store viewport for later save (don't save immediately - it competes with restoration)
            const viewportToSave = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
            
            // Clear any existing timeout to prevent stacking
            if (panTimeoutRef.current) {
              clearTimeout(panTimeoutRef.current);
              panTimeoutRef.current = null;
            }
            
            // Reset panning flag immediately (allows ReactFlow to settle)
            setIsPanningOrZooming(false);
            
            // PERF: Debounced decoration restoration
            // Wait for ReactFlow, layout, and other systems to settle before re-enabling decorations
            // This prevents a blown frame immediately after pan ends
            const DECORATION_RESTORE_DELAY = 80; // milliseconds (tunable: 50-150ms)
            
            decorationRestoreTimeoutRef.current = setTimeout(() => {
              const restoreT0 = performance.now();
              console.log(`[PERF] [${new Date().toISOString()}] Starting ATOMIC decoration restoration`, {
                edgeCount: edges.length,
                nodeCount: nodes.length
              });
              
              // ATOMIC RESTORATION WINDOW: Set global flag to prevent interference
              if (typeof window !== 'undefined') {
                (window as any).__DAGNET_ATOMIC_RESTORE_ACTIVE = true;
              }
              
              // CRITICAL: Use flushSync to force synchronous, atomic commit
              // This restores beads in ONE React commit with NO interruption
              // ReactFlow's nodes/edges are NOT mutated, so ReactFlow doesn't re-render
              flushSync(() => {
                setBeadsVisible(true);
              });
              
              // Clear atomic window flag immediately after flushSync completes
              if (typeof window !== 'undefined') {
                (window as any).__DAGNET_ATOMIC_RESTORE_ACTIVE = false;
              }
              
              const restoreT1 = performance.now();
              console.log(`[PERF] ATOMIC decoration restoration completed in ${(restoreT1 - restoreT0).toFixed(2)}ms`);
              
              decorationRestoreTimeoutRef.current = null;
              
              // AFTER atomic restoration, schedule viewport persistence (deferred, low priority)
              // This runs OUTSIDE the atomic window so it can't interfere
              if (!MINIMAL_MODE) {
                requestAnimationFrame(() => {
                  const shouldSaveViewport = !lastSavedViewportRef.current || 
                    Math.abs(viewportToSave.x - lastSavedViewportRef.current.x) > 1 ||
                    Math.abs(viewportToSave.y - lastSavedViewportRef.current.y) > 1 ||
                    Math.abs(viewportToSave.zoom - lastSavedViewportRef.current.zoom) > 0.01;
                  
                  if (shouldSaveViewport && tabId) {
                    startTransition(() => {
                      try {
                        console.log('[PERF] Saving viewport after atomic restoration (deferred)');
                        tabOperations.updateTabState(tabId, { rfViewport: viewportToSave as any });
                        lastSavedViewportRef.current = viewportToSave;
                      } catch {}
                    });
                  }
                });
              }
            }, DECORATION_RESTORE_DELAY);
            
            // Reset movement tracking
            hasMovedRef.current = false;
            moveStartViewportRef.current = null;
          } else {
            // No actual movement (just a click) - restore decorations immediately
            // Cancel the fallback timeout since onMoveEnd fired correctly
            if (decorationRestoreTimeoutRef.current) {
              clearTimeout(decorationRestoreTimeoutRef.current);
              decorationRestoreTimeoutRef.current = null;
            }
            setIsPanningOrZooming(false);
            setBeadsVisible(true);
            moveStartViewportRef.current = null;
            hasMovedRef.current = false;
          }
        }}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={(event, node) => {
          event.preventDefault();
          // Select the node first, then open Properties panel
          onSelectedNodeChange(node.id);
          window.dispatchEvent(new CustomEvent('dagnet:openPropertiesPanel'));
        }}
        onEdgeDoubleClick={(event, edge) => {
          event.preventDefault();
          // Select the edge first, then open Properties panel
          onSelectedEdgeChange(edge.id);
          window.dispatchEvent(new CustomEvent('dagnet:openPropertiesPanel'));
        }}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        minZoom={0.1}
        fitView
        selectionOnDrag={false}
        selectNodesOnDrag={false}
        selectionKeyCode={['Meta', 'Ctrl']}
        panActivationKeyCode={null}
        nodesDraggable={activeElementTool !== 'pan'}
        nodesConnectable={activeElementTool !== 'pan'}
        nodesFocusable={activeElementTool !== 'pan'}
        edgesFocusable={activeElementTool !== 'pan'}
        elementsSelectable={activeElementTool !== 'pan'}
        reconnectRadius={40}
        edgeUpdaterRadius={40}
        onlyRenderVisibleElements={false}
        panOnDrag={activeElementTool === 'pan' || (!isLassoSelecting && activeElementTool !== 'new-postit' && activeElementTool !== 'new-container' && activeElementTool !== 'new-analysis')}
        connectionRadius={50}
        snapToGrid={false}
        snapGrid={[1, 1]}
        style={{
          background: dark ? '#282828' : '#f8fafc',
          cursor: undefined,
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color={dark ? '#363636' : '#ddd'} />
        <HelperLines />
        <Controls />
        <MiniMap
          maskColor={dark ? 'rgba(30,30,30,0.8)' : undefined}
          nodeColor={(node) => isCanvasObjectNode(node.id) ? 'transparent' : '#e2e2e2'}
          nodeStrokeColor={(node) => isCanvasObjectNode(node.id) ? 'transparent' : '#b1b1b7'}
        />
        <GraphIssuesIndicatorOverlay tabId={tabId} />
        <SelectionConnectors graph={graph} />

        {/* Lasso selection rectangle */}
        {isLassoSelecting && lassoStart && lassoEnd && (() => {
          // Convert viewport coordinates to container-relative coordinates
          const rect = reactFlowWrapperRef.current?.getBoundingClientRect();
          const offsetX = rect?.left || 0;
          const offsetY = rect?.top || 0;
          
          const startX = lassoStart.x - offsetX;
          const startY = lassoStart.y - offsetY;
          const endX = lassoEnd.x - offsetX;
          const endY = lassoEnd.y - offsetY;
          
          return (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 1000,
                pointerEvents: 'auto',
              }}
              onMouseUp={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Don't call handleMouseUp here - let the global handler do it once
              }}
              onMouseDown={(e) => {
                // ensure pane doesn't treat this as a click
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: Math.min(startX, endX),
                  top: Math.min(startY, endY),
                  width: Math.abs(endX - startX),
                  height: Math.abs(endY - startY),
                  border: '2px dashed #007bff',
                  background: 'rgba(0, 123, 255, 0.1)',
                  pointerEvents: 'none',
                }}
              />
            </div>
          );
        })()}
        
      </ReactFlow>
      
      <CanvasContextMenus
        graph={graph}
        setGraph={setGraph}
        setGraphDirect={setGraphDirect}
        saveHistoryState={saveHistoryState}
        nodes={nodes}
        edges={edges}
        graphFileId={graphFileId}
        contextMenu={contextMenu}
        setContextMenu={setContextMenu}
        nodeContextMenu={nodeContextMenu}
        setNodeContextMenu={setNodeContextMenu}
        postitContextMenu={postitContextMenu}
        setPostitContextMenu={setPostitContextMenu}
        containerContextMenu={containerContextMenu}
        setContainerContextMenu={setContainerContextMenu}
        analysisContextMenu={analysisContextMenu}
        setAnalysisContextMenu={setAnalysisContextMenu}
        multiSelectContextMenu={multiSelectContextMenu}
        setMultiSelectContextMenu={setMultiSelectContextMenu}
        edgeContextMenu={edgeContextMenu}
        setEdgeContextMenu={setEdgeContextMenu}
        contextMenuLocalData={contextMenuLocalData}
        setContextMenuLocalData={setContextMenuLocalData}
        ctxDslEditState={ctxDslEditState}
        setCtxDslEditState={setCtxDslEditState}
        analysisCtxAvailableTypes={analysisCtxAvailableTypes}
        addNodeAtPosition={addNodeAtPosition}
        addPostitAtPosition={addPostitAtPosition}
        addContainerAtPosition={addContainerAtPosition}
        addChartAtPosition={addChartAtPosition}
        pasteNodeAtPosition={pasteNodeAtPosition}
        pasteSubgraphAtPosition={pasteSubgraphAtPosition}
        setActiveElementTool={setActiveElementTool}
        startAddChart={startAddChart}
        copiedNode={copiedNode}
        copiedSubgraph={copiedSubgraph}
        copySubgraph={copySubgraph}
        isDashboardMode={isDashboardMode}
        toggleDashboardMode={toggleDashboardMode}
        tabId={tabId}
        tabs={tabs}
        tabOperations={tabOperations}
        effectiveActiveTabId={effectiveActiveTabId}
        handleUpdateAnalysis={handleUpdateAnalysis}
        handleDeleteAnalysis={handleDeleteAnalysis}
        handleDeleteContainer={handleDeleteContainer}
        deleteNode={deleteNode}
        deleteEdge={deleteEdge}
        reorderCanvasNodes={reorderCanvasNodes}
        onSelectedNodeChange={onSelectedNodeChange}
        onSelectedEdgeChange={onSelectedEdgeChange}
        onSelectedAnnotationChange={onSelectedAnnotationChange}
        getContainedConversionNodeIds={getContainedConversionNodeIds}
        align={align}
        distribute={distribute}
        equalSize={equalSize}
        canAlign={canAlign}
        canDistribute={canDistribute}
        store={store}
        scenariosContext={scenariosContext}
        captureTabScenariosToRecipe={captureTabScenariosToRecipe}
        showVariantModal={showVariantModal}
        pendingConnection={pendingConnection}
        caseNodeVariants={caseNodeVariants}
        handleVariantSelection={handleVariantSelection}
        dismissVariantModal={dismissVariantModal}
      />
      </div>
    </DecorationVisibilityContext.Provider>
  );
}
