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
import { canvasAnalysisTransientCache, canvasAnalysisResultCache } from '../hooks/useCanvasAnalysisCompute';
import { chartOperationsService } from '../services/chartOperationsService';

/**
 * Pending payload for the draw-to-create analysis tool.
 * Set by the pin button, consumed on mouse-up after draw.
 */
let pendingAnalysisPayload: any = null;
export function setPendingAnalysisPayload(payload: any) { pendingAnalysisPayload = payload; }
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
import { NodeContextMenu } from './NodeContextMenu';
import { PostItContextMenu } from './PostItContextMenu';
import { ContainerContextMenu } from './ContainerContextMenu';
import { CanvasAnalysisContextMenu } from './CanvasAnalysisContextMenu';
import { SelectionConnectors } from './SelectionConnectors';
import { captureTabScenariosToRecipe } from '../services/captureTabScenariosService';
import { resolveAnalysisType } from '../services/analysisTypeResolutionService';
import { mutateCanvasAnalysisGraph, deleteCanvasAnalysisFromGraph } from '../services/canvasAnalysisMutationService';
import { ScenarioQueryEditModal } from './modals/ScenarioQueryEditModal';
import { EdgeContextMenu } from './EdgeContextMenu';
import { extractSubgraph } from '../lib/subgraphExtractor';
import { useDashboardMode } from '../hooks/useDashboardMode';
import { useCopyPaste } from '../hooks/useCopyPaste';
import { dataOperationsService } from '../services/dataOperationsService';
import { fileRegistry } from '../contexts/TabContext';
import toast from 'react-hot-toast';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useTabContext } from '../contexts/TabContext';
import { useViewPreferencesContext } from '../contexts/ViewPreferencesContext';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { getComposedParamsForLayer } from '../services/CompositionService';
import { GraphIssuesIndicatorOverlay } from './canvas/GraphIssuesIndicatorOverlay';
import { toFlow, fromFlow } from '@/lib/transform';
import {
  logSnapshotBoot,
  recordSnapshotBootLedgerStage,
  registerSnapshotBootExpectations,
  summariseSnapshotCharts,
} from '@/lib/snapshotBootTrace';
import { computeEffectiveEdgeProbability } from '@/lib/whatIf';
import { getOptimalFace } from '@/lib/faceSelection';
import { useEdgeRouting } from './canvas/useEdgeRouting';
import { useEdgeConnection } from './canvas/useEdgeConnection';
import { computeFaceDirectionsFromEdges } from '@/lib/faceDirections';
import { buildScenarioRenderEdges } from './canvas/buildScenarioRenderEdges';
import { calculateEdgeOffsets as calculateEdgeOffsetsCore } from './canvas/edgeGeometry';
import { computeDagreLayout as computeDagreLayoutCore, computeSankeyLayout as computeSankeyLayoutCore } from './canvas/layoutAlgorithms';
import { createNodeInGraph, createNodeFromFileInGraph, createPostitInGraph, createContainerInGraph, createCanvasAnalysisInGraph, buildAddChartPayload } from './canvas/creationTools';
import { computeHighlightMetadata } from './canvas/pathHighlighting';
import { getCaseEdgeVariantInfo } from './edges/edgeLabelHelpers';
import { MAX_EDGE_WIDTH, MIN_EDGE_WIDTH, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT, IMAGE_VIEW_NODE_WIDTH, IMAGE_VIEW_NODE_HEIGHT } from '@/lib/nodeEdgeConstants';
import { Monitor, MonitorOff, X, Plus, StickyNote, Square, BarChart3, Clipboard, CheckSquare } from 'lucide-react';
import { useAlignSelection } from '../hooks/useAlignSelection';
import { useSnapToGuides } from '../hooks/useSnapToGuides';
import { toNodeRect } from '../services/alignmentService';
import { MultiSelectContextMenu } from './MultiSelectContextMenu';

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
  const whatIfStartRef = useRef<number | null>(null);
  
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
  useEffect(() => {
    const handler = (e: any) => {
      if (e?.detail?.tabId && tabId && e.detail.tabId !== tabId) return;
      whatIfStartRef.current = e.detail?.t0 ?? performance.now();
      console.log(`[${ts()}] [GraphCanvas] what-if start received`, { t0: whatIfStartRef.current, tabId });
    };
    window.addEventListener('dagnet:whatif-start', handler as any);
    return () => window.removeEventListener('dagnet:whatif-start', handler as any);
  }, []);

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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null);
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
    const snapped = applySnapToChanges(filtered, nodesForSnapRef.current, snapToGuides, altKeyPressedRef.current);
    onNodesChangeBase(snapped);

    if (autoReroute && !isSyncingRef.current) {
      if (sankeyLayoutInProgressRef.current || isEffectsCooldownActive()) {
        console.log(`[${ts()}] [GraphCanvas] Reroute suppressed (layout/cooldown active)`);
        return;
      }
      const positionChanges = changes.filter(change => change.type === 'position');
      if (positionChanges.length > 0) {
        console.log(`[${new Date().toISOString()}] [GraphCanvas] Position changes detected, triggering reroute`);
        // Trigger re-routing by incrementing the flag
        // This will run during drag (for visual feedback) and won't save history
        triggerReroute();
      }
    }
  }, [autoReroute, snapToGuides, onNodesChangeBase, activeElementTool, applySnapToChanges]);

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

  // Edge width/offset calculation constants
  // Use shared constants from nodeEdgeConstants.ts
  const MAX_WIDTH = MAX_EDGE_WIDTH;
  const MIN_WIDTH = MIN_EDGE_WIDTH;

  // NOTE: Edge width calculation moved to buildScenarioRenderEdges.ts (unified scenario pipeline)
  // GraphCanvas only provides calculateEdgeOffsets for bundling/spacing logic
  // Core computation extracted to canvas/edgeGeometry.ts

  const calculateEdgeOffsets = useCallback((edgesWithWidth: any[], allNodes: any[], maxWidth: number) => {
    return calculateEdgeOffsetsCore(edgesWithWidth, allNodes, maxWidth, useUniformScaling);
  }, [useUniformScaling, graphStoreHook]);

  // Track the last synced graph to detect real changes
  const lastSyncedGraphRef = useRef<string>('');
  const lastSyncedReactFlowRef = useRef<string>('');
  const snapshotBootCycleKeyRef = useRef<string>('');
  const snapshotBootCycleIdRef = useRef<string>('');
  const isSyncingRef = useRef(false); // Prevents ReactFlow->Graph sync loops, but NOT Graph->ReactFlow sync
  const isDraggingNodeRef = useRef(false); // Prevents Graph->ReactFlow sync during node dragging
  const isResizingNodeRef = useRef(false); // Prevents Graph->ReactFlow style sync during node resizing
  const dragTimeoutRef = useRef<number | null>(null); // Failsafe to clear drag flag if it gets stuck
  const prevSankeyViewRef = useRef(useSankeyView); // Track Sankey mode changes to force slow path rebuild
  const prevShowNodeImagesRef = useRef(showNodeImages); // Track image view changes to force slow path rebuild
  const reactFlowWrapperRef = useRef<HTMLDivElement>(null); // For lasso coordinate calculations
  const hasInitialFitViewRef = useRef(false);
  const currentGraphIdRef = useRef<string>('');
  const sankeyLayoutInProgressRef = useRef(false); // Gate reroutes/slow-path during Sankey layout
  const effectsCooldownUntilRef = useRef<number>(0); // Suppress effects until this timestamp (ms)
  const isEffectsCooldownActive = () => performance.now() < effectsCooldownUntilRef.current;

  // Track last committed RENDER edges (not base edges) for geometry field merge during slow-path rebuilds
  const lastRenderEdgesRef = useRef<Edge[]>([]);
  const isInSlowPathRebuildRef = useRef(false);
  
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
    isDraggingNodeRef,
    sankeyLayoutInProgressRef,
    isEffectsCooldownActive,
  });

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
    
    // Clear the sync flag to allow graph->ReactFlow sync
    isSyncingRef.current = false;
    
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
    
    // Clear the sync flag to allow graph->ReactFlow sync
    isSyncingRef.current = false;
    
    // Update the graph (this will trigger the graph->ReactFlow sync which will update lastSyncedGraphRef)
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

  const autoEditPostitIdRef = useRef<string | null>(null);
  const autoSelectAnalysisIdRef = useRef<string | null>(null);

  // Resize guard callbacks — passed to canvas object nodes to prevent graph→RF style overwrites mid-resize
  const handleResizeStart = useCallback(() => { isResizingNodeRef.current = true; }, []);
  const handleResizeEnd = useCallback(() => { isResizingNodeRef.current = false; }, []);

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

  // Listen for force redraw events (e.g., after undo/redo)
  useEffect(() => {
    const handleForceRedraw = () => {
      console.log('🔄 Force redraw requested - clearing sync cache');
      lastSyncedGraphRef.current = '';
      // The Graph→ReactFlow sync useEffect will fire on next render
    };
    
    window.addEventListener('dagnet:forceRedraw', handleForceRedraw);
    return () => window.removeEventListener('dagnet:forceRedraw', handleForceRedraw);
  }, []);

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

  // Sync FROM graph TO ReactFlow when graph changes externally
  useEffect(() => {
    if (!graph) return;
    
    // Allow Graph→ReactFlow sync during drag - the fast path will only update edge data, not positions
    
    // Don't block external graph changes (like undo) even if we're syncing ReactFlow->Graph
    // The isSyncingRef flag should only prevent ReactFlow->Graph sync, not Graph->ReactFlow sync
    
    const graphJson = JSON.stringify(graph);
    const snapshotBootCycleKey = `${tabId || 'no-tab'}|${graphJson}`;
    if (snapshotBootCycleKeyRef.current !== snapshotBootCycleKey) {
      snapshotBootCycleKeyRef.current = snapshotBootCycleKey;
      snapshotBootCycleIdRef.current = `snapshot-boot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    const snapshotBootCycleId = snapshotBootCycleIdRef.current;
    const sankeyModeChanged = prevSankeyViewRef.current !== useSankeyView;
    const imageViewChanged = prevShowNodeImagesRef.current !== showNodeImages;
    const viewModeChanged = sankeyModeChanged || imageViewChanged;
    const snapshotCharts = summariseSnapshotCharts(graph);
    const graphAnalysisNodeIds = (graph.canvasAnalyses || []).map((a: any) => `analysis-${a.id}`);
    const graphAnalysesById = new Map((graph.canvasAnalyses || []).map((a: any) => [a.id, a]));
    const reactFlowAnalysisNodeIds = nodes.filter((n: any) => n.id?.startsWith('analysis-')).map((n: any) => n.id);
    const graphAnalysisSet = new Set(graphAnalysisNodeIds);
    const reactFlowAnalysisSet = new Set(reactFlowAnalysisNodeIds);
    const missingAnalysisNodeIds = graphAnalysisNodeIds.filter((id: string) => !reactFlowAnalysisSet.has(id));
    const extraAnalysisNodeIds = reactFlowAnalysisNodeIds.filter((id: string) => !graphAnalysisSet.has(id));
    const expectedNodeCount = (graph.nodes?.length || 0)
      + (graph.postits?.length || 0)
      + (graph.containers?.length || 0)
      + (graph.canvasAnalyses?.length || 0);
    const nodeCountChanged = nodes.length !== expectedNodeCount;
    const analysisNodesOutOfSync = missingAnalysisNodeIds.length > 0 || extraAnalysisNodeIds.length > 0;
    const analysisNodePayloadChanged = nodes.some((node: any) => {
      if (!node.id?.startsWith('analysis-')) return false;
      const analysisId = node.id.replace('analysis-', '');
      const graphAnalysis = graphAnalysesById.get(analysisId);
      if (!graphAnalysis) return false;
      const rfWidth = typeof node.style?.width === 'number' ? node.style.width : node.width;
      const rfHeight = typeof node.style?.height === 'number' ? node.style.height : node.height;
      return node.type !== 'canvasAnalysis'
        || node.position?.x !== (graphAnalysis.x ?? 0)
        || node.position?.y !== (graphAnalysis.y ?? 0)
        || rfWidth !== graphAnalysis.width
        || rfHeight !== graphAnalysis.height
        || node.data?.tabId !== tabId
        || JSON.stringify(node.data?.analysis ?? null) !== JSON.stringify(graphAnalysis);
    });
    const snapshotGraphAnalysisNodeIds = snapshotCharts.map((chart) => `analysis-${chart.id}`);
    const snapshotGraphAnalysisSet = new Set(snapshotGraphAnalysisNodeIds);
    const snapshotReactFlowAnalysisNodeIds = reactFlowAnalysisNodeIds.filter((id: string) => snapshotGraphAnalysisSet.has(id));
    const snapshotReactFlowSet = new Set(snapshotReactFlowAnalysisNodeIds);
    const missingSnapshotAnalysisNodeIds = snapshotGraphAnalysisNodeIds.filter((id: string) => !snapshotReactFlowSet.has(id));
    const extraSnapshotAnalysisNodeIds = reactFlowAnalysisNodeIds.filter((id: string) => !snapshotGraphAnalysisSet.has(id));

    if (snapshotCharts.length > 0) {
      registerSnapshotBootExpectations(snapshotCharts, {
        cycleId: snapshotBootCycleId,
        tabId,
        source: 'GraphCanvas:sync-start',
      });
      snapshotCharts.forEach((chart) => {
        const nodeId = `analysis-${chart.id}`;
        if (snapshotReactFlowSet.has(nodeId)) {
          recordSnapshotBootLedgerStage('reactflow-node-present', {
            analysisId: chart.id,
            analysisType: chart.analysisType,
            chartKind: chart.chartKind,
            mode: chart.mode,
            cycleId: snapshotBootCycleId,
            tabId,
            source: 'GraphCanvas:sync-start',
            nodeId,
          });
        }
      });
      logSnapshotBoot('GraphCanvas:sync-start', {
        snapshotCharts,
        snapshotGraphAnalysisNodeIds,
        snapshotReactFlowAnalysisNodeIds,
        missingSnapshotAnalysisNodeIds,
        extraSnapshotAnalysisNodeIds,
        nodeCount: nodes.length,
        expectedNodeCount,
        edgeCount: edges.length,
      });
    }
    
    // Skip if graph unchanged AND no view mode changed
    // (View mode changes require full rebuild even if graph is the same)
    if (graphJson === lastSyncedGraphRef.current && !viewModeChanged && !nodeCountChanged && !analysisNodesOutOfSync && !analysisNodePayloadChanged) {
      if (snapshotCharts.length > 0) {
        logSnapshotBoot('GraphCanvas:sync-skip-unchanged', {
          snapshotCharts,
        });
      }
      return;
    }
    if (snapshotCharts.length > 0 && graphJson === lastSyncedGraphRef.current && !viewModeChanged && (nodeCountChanged || analysisNodesOutOfSync || analysisNodePayloadChanged)) {
      logSnapshotBoot('GraphCanvas:sync-forced-reconcile', {
        snapshotCharts,
        nodeCountChanged,
        missingAnalysisNodeIds,
        extraAnalysisNodeIds,
        analysisNodePayloadChanged,
      });
    }
    lastSyncedGraphRef.current = graphJson;
    
    console.log('🔄 Graph→ReactFlow sync triggered', sankeyModeChanged ? '(Sankey mode changed)' : imageViewChanged ? '(Image view changed)' : '');
    console.log('  Graph edges (UUIDs):', graph.edges?.map((e: any) => e.uuid));
    console.log('  ReactFlow edges (UUIDs):', edges.map(e => e.id));
    
    // Set syncing flag to prevent re-routing during graph->ReactFlow sync
    isSyncingRef.current = true;
    
    // Check if only edge probabilities changed (not topology or node positions)
    const edgeCountChanged = edges.length !== (graph.edges?.length || 0);
    console.log('  Edge count changed:', edgeCountChanged, `(${edges.length} -> ${graph.edges?.length || 0})`);
    console.log('  Node count changed:', nodeCountChanged);
    console.log('[GraphCanvas][AnalysisNodes] graph vs reactflow', {
      graphCount: graphAnalysisNodeIds.length,
      reactFlowCount: reactFlowAnalysisNodeIds.length,
      missingAnalysisNodeIds,
      extraAnalysisNodeIds,
      analysisNodePayloadChanged,
    });
    
    // Check if any node positions changed
    const nodePositionsChanged = nodes.some(node => {
      const graphNode = graph.nodes.find((n: any) => n.uuid === node.id || n.id === node.id);
      return graphNode && (
        Math.abs((graphNode.layout?.x || 0) - node.position.x) > 0.1 ||
        Math.abs((graphNode.layout?.y || 0) - node.position.y) > 0.1
      );
    });
    
    // Check if any edge IDs changed (happens when reconnecting to different nodes)
    // NOTE: In ReactFlow, edge.id IS the UUID. In graph, we need e.uuid.
    const graphEdgeIds = new Set(graph.edges.map((e: any) => e.uuid));
    const reactFlowEdgeIds = new Set(edges.map(e => e.id));  // ReactFlow edge.id is the UUID
    const edgeIdsChanged = edges.some(e => !graphEdgeIds.has(e.id)) || 
                           graph.edges.some((e: any) => !reactFlowEdgeIds.has(e.uuid));
    
    console.log('  Edge IDs changed:', edgeIdsChanged);
    if (edgeIdsChanged) {
      console.log('    Old ReactFlow edge IDs:', Array.from(reactFlowEdgeIds));
      console.log('    New Graph edge IDs:', Array.from(graphEdgeIds));
    }
    
    // Check if any edge handles changed
    const edgeHandlesChanged = edges.some(edge => {
      // Find edge by UUID or human-readable ID (Phase 0.0 migration)
      let graphEdge = graph.edges.find((e: any) => e.uuid === edge.id || e.id === edge.id);
      if (!graphEdge) {
        graphEdge = graph.edges.find((e: any) => `${e.from}->${e.to}` === edge.id);
      }
      if (!graphEdge) {
        graphEdge = graph.edges.find((e: any) => e.from === edge.source && e.to === edge.target);
      }
      if (!graphEdge) return false;
      
      return graphEdge.fromHandle !== edge.sourceHandle || graphEdge.toHandle !== edge.targetHandle;
    });
    
    // Check if only node properties changed (not structure or positions)
    const nodePropertiesChanged = nodes.some(node => {
      // Find node by UUID or human-readable ID (Phase 0.0 migration)
      const graphNode = graph.nodes.find((n: any) => n.uuid === node.id || n.id === node.id);
      if (!graphNode) return false;
      
      // Check if any non-position properties changed
      const tagsChanged = JSON.stringify(node.data?.tags || []) !== JSON.stringify(graphNode.tags || []);
      const labelChanged = node.data?.label !== graphNode.label;
      const idChanged = node.data?.id !== graphNode.id;
      const descriptionChanged = node.data?.description !== graphNode.description;
      const absorbingChanged = node.data?.absorbing !== graphNode.absorbing;
      const outcomeTypeChanged = node.data?.outcome_type !== graphNode.outcome_type;
      const entryStartChanged = node.data?.entry?.is_start !== graphNode.entry?.is_start;
      const entryWeightChanged = node.data?.entry?.entry_weight !== graphNode.entry?.entry_weight;
      const caseColourChanged = node.data?.layout?.colour !== graphNode.layout?.colour;
      const caseTypeChanged = node.data?.type !== graphNode.type;
      const caseDataChanged = JSON.stringify(node.data?.case || {}) !== JSON.stringify(graphNode.case || {});
      const urlChanged = node.data?.url !== graphNode.url;
      const imagesChanged = JSON.stringify(node.data?.images || []) !== JSON.stringify(graphNode.images || []);
      
      const hasChanges = labelChanged || idChanged || descriptionChanged || absorbingChanged || 
                        outcomeTypeChanged || tagsChanged || entryStartChanged || entryWeightChanged ||
                        caseColourChanged || caseTypeChanged || caseDataChanged || urlChanged || imagesChanged;
      
      if (hasChanges) {
        console.log('Node property changes detected:', {
          nodeId: node.id,
          labelChanged,
          idChanged,
          descriptionChanged,
          absorbingChanged,
          outcomeTypeChanged,
          tagsChanged,
          entryStartChanged,
          entryWeightChanged,
          caseColourChanged,
          caseTypeChanged,
          caseDataChanged,
          nodeTags: node.data?.tags,
          graphTags: graphNode.tags,
          nodeLayout: node.data?.layout,
          graphLayout: graphNode.layout
        });
      }
      
      return hasChanges;
    });
    
    // Update view mode refs (calculated at top of useEffect)
    if (sankeyModeChanged) {
      console.log('  🎨 Sankey mode changed:', prevSankeyViewRef.current, '->', useSankeyView);
      prevSankeyViewRef.current = useSankeyView;
    }
    if (imageViewChanged) {
      console.log('  🖼️ Image view changed:', prevShowNodeImagesRef.current, '->', showNodeImages);
      prevShowNodeImagesRef.current = showNodeImages;
    }
    
    // Detect if any node's image count crossed the 0↔1 boundary (requires slow path for size change)
    const imageBoundaryChanged = showNodeImages && nodes.some(node => {
      const graphNode = graph.nodes.find((n: any) => n.uuid === node.id || n.id === node.id);
      if (!graphNode) return false;
      const hadImages = (node.data?.images?.length || 0) > 0;
      const hasImages = (graphNode.images?.length || 0) > 0;
      return hadImages !== hasImages;
    });

    // Fast path: If only edge data changed (no topology, position, or handle changes), update in place
    // CRITICAL: During drag or resize, ALWAYS take fast path to prevent node position/size overwrites.
    // The fast path already updates edge handles (sourceHandle/targetHandle) and recalculates offsets,
    // and it has guards that preserve RF positions (isDraggingNodeRef) and styles (isResizingNodeRef)
    // for container/postit/analysis nodes. The slow path rebuilds ALL nodes from graph data, which
    // has stale positions during drag (store not updated until onNodeDragStop) and stale dimensions
    // during resize (store updated by setGraphDirect but slow path would overwrite RF visual state).
    // View mode changes (Sankey, image view) require slow path because node sizes change
    // Image boundary changes (0↔1 images) also require slow path for node resizing
    const isInteracting = isDraggingNodeRef.current || isResizingNodeRef.current;
    const shouldTakeFastPath = !edgeCountChanged && !nodeCountChanged && !edgeIdsChanged &&
                               (isInteracting || !edgeHandlesChanged) &&
                               (isInteracting || !analysisNodePayloadChanged) &&
                               !viewModeChanged && !imageBoundaryChanged && edges.length > 0 &&
                               (isInteracting || !nodePositionsChanged);

    if (snapshotCharts.length > 0) {
      logSnapshotBoot('GraphCanvas:sync-path-decision', {
        path: shouldTakeFastPath ? 'fast' : 'slow',
        edgeCountChanged,
        nodeCountChanged,
        edgeIdsChanged,
        edgeHandlesChanged,
        nodePositionsChanged,
        analysisNodePayloadChanged,
        viewModeChanged,
        imageBoundaryChanged,
        missingSnapshotAnalysisNodeIds,
        extraSnapshotAnalysisNodeIds,
      });
    }
    
    if (shouldTakeFastPath) {
      const pathReason = isDraggingNodeRef.current ? '(DRAG - ignoring position diff)' : '(positions unchanged)';
      console.log(`  ⚡ Fast path: Topology and handles unchanged, updating edge data in place ${pathReason}`);
      if (missingAnalysisNodeIds.length > 0 || extraAnalysisNodeIds.length > 0) {
        console.warn('[GraphCanvas][AnalysisNodes] Fast path with analysis-node mismatch', {
          missingAnalysisNodeIds,
          extraAnalysisNodeIds,
        });
        if (snapshotCharts.length > 0) {
          logSnapshotBoot('GraphCanvas:fast-path-analysis-mismatch', {
            snapshotCharts,
            missingSnapshotAnalysisNodeIds,
            extraSnapshotAnalysisNodeIds,
          });
        }
      }
      
      // Clear drag flag after determining fast path (if it was set)
      // This ensures we don't block future syncs unnecessarily
      if (isDraggingNodeRef.current) {
        // Use setTimeout to clear after this sync completes
        setTimeout(() => {
          isDraggingNodeRef.current = false;
        }, 0);
      }
      
      // Topology unchanged and handles unchanged - update edge data in place to preserve component identity
      setEdges(prevEdges => {
        // First pass: update edge data without calculateWidth functions
        const result = prevEdges.map(prevEdge => {
          // Try multiple ways to match edges (Phase 0.0 migration: check uuid and id)
          let graphEdge = graph.edges.find((e: any) => e.uuid === prevEdge.id || e.id === prevEdge.id);
          if (!graphEdge) {
            graphEdge = graph.edges.find((e: any) => `${e.from}->${e.to}` === prevEdge.id);
          }
          if (!graphEdge) {
            // Try matching by source and target
            graphEdge = graph.edges.find((e: any) => e.from === prevEdge.source && e.to === prevEdge.target);
          }
          if (!graphEdge) return prevEdge;
          
          // Update edge data while preserving component identity
          // IMPORTANT: Create new calculateWidth function to use updated probability
          const newProbability = graphEdge.p?.mean ?? 0.5;
          const newCalculateWidth = () => {
            // Simple width calculation based on probability
            // (mirrors logic from buildScenarioRenderEdges but without scenario complexity)
            const minWidth = MIN_WIDTH;
            const maxWidth = MAX_WIDTH;
            return minWidth + newProbability * (maxWidth - minWidth);
          };
          
          return {
            ...prevEdge,
            sourceHandle: graphEdge.fromHandle || prevEdge.sourceHandle,
            targetHandle: graphEdge.toHandle || prevEdge.targetHandle,
            data: {
              ...prevEdge.data,
              id: graphEdge.id,
              probability: newProbability,
              stdev: graphEdge.p?.stdev,
              p: graphEdge.p, // Full p object with override flags
              description: graphEdge.description,
              description_overridden: graphEdge.description_overridden,
              query_overridden: graphEdge.query_overridden,
              conditional_p: graphEdge.conditional_p, // Include conditional_p with override flags
              cost_gbp: (graphEdge as any).cost_gbp, // New flat cost structure
              labour_cost: (graphEdge as any).labour_cost, // New flat cost structure
              costs: graphEdge.costs, // Legacy field (for backward compat)
              weight_default: graphEdge.weight_default,
              case_variant: graphEdge.case_variant,
              case_id: graphEdge.case_id,
              useSankeyView: useSankeyView,
              // Update calculateWidth to use new probability
              calculateWidth: newCalculateWidth
            }
          };
        });
        
        // Edges are updated without calculateWidth (added by buildScenarioRenderEdges)
        const edgesWithOffsets = calculateEdgeOffsets(result, nodes, MAX_WIDTH);
        
        // Attach offsets to edge data
        return edgesWithOffsets.map(edge => ({
          ...edge,
          data: {
            ...edge.data,
            sourceOffsetX: edge.sourceOffsetX,
            sourceOffsetY: edge.sourceOffsetY,
            targetOffsetX: edge.targetOffsetX,
            targetOffsetY: edge.targetOffsetY,
            scaledWidth: edge.scaledWidth,
            // Bundle metadata
            sourceBundleWidth: edge.sourceBundleWidth,
            targetBundleWidth: edge.targetBundleWidth,
            sourceBundleSize: edge.sourceBundleSize,
            // Recalculate renderFallbackTargetArrow based on new bundle width
            renderFallbackTargetArrow: false,
            targetBundleSize: edge.targetBundleSize,
            isFirstInSourceBundle: edge.isFirstInSourceBundle,
            isLastInSourceBundle: edge.isLastInSourceBundle,
            isFirstInTargetBundle: edge.isFirstInTargetBundle,
            isLastInTargetBundle: edge.isLastInTargetBundle,
            sourceFace: edge.sourceFace,
            targetFace: edge.targetFace,
            // Pass what-if DSL to edges
            whatIfDSL: effectiveWhatIfDSL
          }
        }));
      });
      
      // Also update node properties if they changed, OR recalculate Sankey heights if in Sankey mode
      // Always update postit data (text, colour, size) from graph.postits
      // Also handles post-it add/remove (e.g. undo/redo)
      {
        const graphPostitIds = new Set((graph.postits || []).map((p: any) => p.id));
        const graphContainerIds = new Set((graph.containers || []).map((c: any) => c.id));
        const graphAnalysisIds = new Set((graph.canvasAnalyses || []).map((a: any) => a.id));
        setNodes(prevNodes => {
          const autoEditNodeId = autoEditPostitIdRef.current ? `postit-${autoEditPostitIdRef.current}` : null;

          // Remove canvas object nodes that no longer exist in the graph (e.g. after undo)
          let updatedNodes = prevNodes
            .filter(prevNode => {
              if (prevNode.id?.startsWith('postit-')) return graphPostitIds.has(prevNode.id.replace('postit-', ''));
              if (prevNode.id?.startsWith('container-')) return graphContainerIds.has(prevNode.id.replace('container-', ''));
              if (prevNode.id?.startsWith('analysis-')) return graphAnalysisIds.has(prevNode.id.replace('analysis-', ''));
              return true;
            });
          updatedNodes = updatedNodes.map(prevNode => {
            if (prevNode.id.startsWith('postit-')) {
              const postitId = prevNode.id.replace('postit-', '');
              const gpArray = graph.postits || [];
              const gpIndex = gpArray.findIndex((p: any) => p.id === postitId);
              const graphPostit = gpIndex >= 0 ? gpArray[gpIndex] : null;
              if (!graphPostit) return prevNode;
              if (import.meta.env.DEV) {
                const prevStyle = prevNode.style as any;
                if (!isResizingNodeRef.current && (prevStyle?.width !== graphPostit.width || prevStyle?.height !== graphPostit.height)) {
                  console.log('[reconcile] postit style WILL CHANGE', {
                    id: prevNode.id,
                    isResizing: isResizingNodeRef.current,
                    isInteracting,
                    prevW: prevStyle?.width, prevH: prevStyle?.height,
                    graphW: graphPostit.width, graphH: graphPostit.height,
                    prevPos: prevNode.position,
                    graphPos: { x: graphPostit.x, y: graphPostit.y },
                  });
                }
              }
              return {
                ...prevNode,
                zIndex: 5000 + gpIndex,
                // During drag/resize, preserve ReactFlow's current position/size — graph model may not have synced yet
                // Resize from left/top edge changes position too, so guard position with BOTH refs
                ...(isInteracting ? {} : { position: { x: graphPostit.x ?? 0, y: graphPostit.y ?? 0 } }),
                ...(isResizingNodeRef.current ? {} : { style: { ...prevNode.style, width: graphPostit.width, height: graphPostit.height } }),
                selected: autoEditNodeId ? prevNode.id === autoEditNodeId : prevNode.selected,
                data: {
                  ...prevNode.data,
                  postit: graphPostit,
                  onUpdate: handleUpdatePostit,
                  onDelete: handleDeletePostit,
                  onSelect: onSelectedAnnotationChange ? (id: string) => onSelectedAnnotationChange(id, 'postit') : undefined,
                  onResizeStart: handleResizeStart,
                  onResizeEnd: handleResizeEnd,
                },
              };
            }
            if (prevNode.id?.startsWith('container-')) {
              const containerId = prevNode.id.replace('container-', '');
              const gcArray = graph.containers || [];
              const gcIndex = gcArray.findIndex((c: any) => c.id === containerId);
              const graphContainer = gcIndex >= 0 ? gcArray[gcIndex] : null;
              if (!graphContainer) return prevNode;
              return {
                ...prevNode,
                zIndex: 1000 + gcIndex,
                // During drag/resize, preserve ReactFlow's current position/size — graph model may not have synced yet
                // Resize from left/top edge changes position too, so guard position with BOTH refs
                ...(isInteracting ? {} : { position: { x: graphContainer.x ?? 0, y: graphContainer.y ?? 0 } }),
                ...(() => {
                  if (isResizingNodeRef.current) {
                    console.log(`[SyncGuard] container ${containerId.slice(0,8)}: RESIZE guard active, keeping RF style ${prevNode.style?.width}x${prevNode.style?.height}`);
                    return {};
                  }
                  const gw = graphContainer.width, gh = graphContainer.height;
                  const rw = prevNode.style?.width, rh = prevNode.style?.height;
                  if (gw !== rw || gh !== rh) {
                    console.log(`[SyncGuard] container ${containerId.slice(0,8)}: applying graph ${gw}x${gh} (was RF ${rw}x${rh})`);
                  }
                  return { style: { ...prevNode.style, width: gw, height: gh } };
                })(),
                data: {
                  ...prevNode.data,
                  container: graphContainer,
                  onUpdate: handleUpdateContainer,
                  onDelete: handleDeleteContainer,
                  onResizeStart: handleResizeStart,
                  onResizeEnd: handleResizeEnd,
                },
              };
            }
            if (prevNode.id?.startsWith('analysis-')) {
              const analysisId = prevNode.id.replace('analysis-', '');
              const graphAnalysis = graphAnalysesById.get(analysisId);
              if (!graphAnalysis) return prevNode;
              const gaIndex = (graph.canvasAnalyses || []).findIndex((a: any) => a.id === analysisId);
              // Stabilise data.analysis reference: only replace when content actually changed.
              // This prevents cascading re-renders in CanvasAnalysisNode (table/chart flicker)
              // when unrelated graph mutations (e.g. dragging a conversion node) trigger the slow path.
              const prevAnalysis = prevNode.data?.analysis;
              const analysisChanged = !prevAnalysis || JSON.stringify(prevAnalysis) !== JSON.stringify(graphAnalysis);
              const stableAnalysis = analysisChanged ? graphAnalysis : prevAnalysis;
              const prevData = prevNode.data;
              const dataChanged = analysisChanged || prevData?.tabId !== tabId
                || prevData?.onUpdate !== handleUpdateAnalysis || prevData?.onDelete !== handleDeleteAnalysis;
              return {
                ...prevNode,
                type: 'canvasAnalysis',
                zIndex: 5000 + (graph.postits || []).length + (gaIndex >= 0 ? gaIndex : 0),
                // During drag/resize, preserve ReactFlow's current position/size — graph model may not have synced yet
                // Resize from left/top edge changes position too, so guard position with BOTH refs
                ...(isInteracting ? {} : { position: { x: graphAnalysis.x ?? 0, y: graphAnalysis.y ?? 0 } }),
                ...(isResizingNodeRef.current ? {} : { style: { ...prevNode.style, width: graphAnalysis.width, height: graphAnalysis.height } }),
                data: dataChanged ? {
                  ...prevData,
                  analysis: stableAnalysis,
                  tabId,
                  onUpdate: handleUpdateAnalysis,
                  onDelete: handleDeleteAnalysis,
                  onResizeStart: handleResizeStart,
                  onResizeEnd: handleResizeEnd,
                } : prevData,
              };
            }
            const graphNode = graph.nodes.find((n: any) => n.uuid === prevNode.id || n.id === prevNode.id);
            if (!graphNode) return prevNode;
            
            const hasImages = showNodeImages && (graphNode.images?.length || 0) > 0;
            return {
              ...prevNode,
              data: {
                ...prevNode.data,
                // Preserve containerColours from slow path — the fast path only runs when
                // topology is unchanged, so container membership can't have changed.
                // Re-computing it here risks overwriting with undefined when container
                // RF nodes haven't been measured yet.
                ...(prevNode.data?.containerColours ? { containerColours: prevNode.data.containerColours } : {}),
                label: graphNode.label,
                id: graphNode.id,
                description: graphNode.description,
                absorbing: graphNode.absorbing,
                outcome_type: graphNode.outcome_type,
                tags: graphNode.tags,
                entry: graphNode.entry,
                type: graphNode.type,
                case: graphNode.case,
                layout: graphNode.layout,
                url: graphNode.url,
                images: graphNode.images,
                showNodeImages: hasImages
              }
            };
          });
          
          // In Sankey mode, recalculate node heights based on flow mass
          if (useSankeyView) {
            console.log('[Sankey Fast Path] Recalculating node heights based on edge changes');
            
            // Calculate flow mass through each node across all visible layers
            const scenarioState = tabId ? tabs.find(t => t.id === tabId)?.editorState?.scenarioState : undefined;
            const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
            const layersToCalculate = visibleScenarioIds.includes('current')
              ? visibleScenarioIds
              : [...visibleScenarioIds, 'current'];
            
            const maxFlowMassPerNode = new Map<string, number>();
            let currentLayerMaxMass = 0;
            
            // Calculate flow mass for each layer
            for (const layerId of layersToCalculate) {
              const flowMass = new Map<string, number>();
              let layerWhatIfDSL = effectiveWhatIfDSL;
              let composedParams: any = null;
              
              if (layerId !== 'current' && scenariosContext) {
                // Scenario layer - use centralized composition
                composedParams = getComposedParamsForLayer(
                  layerId,
                  scenariosContext.baseParams,
                  scenariosContext.currentParams,
                  scenariosContext.scenarios
                );
                if (layerId !== 'base') {
                  layerWhatIfDSL = null; // Scenarios don't use What-If
                }
              }
              
              // Initialize start nodes
              graph.nodes?.forEach((node: any) => {
                if (node.entry?.is_start) {
                  flowMass.set(node.uuid, node.entry.entry_weight || 1.0);
                } else {
                  flowMass.set(node.uuid, 0);
                }
              });
              
              // Helper to resolve node reference (UUID, truncated UUID, or human-readable ID) to full UUID
              const resolveToUuid = (ref: string): string => {
                // Try exact match on UUID or human-readable ID first
                let node = graph.nodes?.find((n: any) => n.uuid === ref || n.id === ref);
                if (node) return node.uuid;
                
                // Fallback: check if ref is a truncated UUID prefix (e.g., first 8 chars)
                node = graph.nodes?.find((n: any) => n.uuid?.startsWith(ref));
                return node?.uuid || ref; // Return UUID if found, otherwise return original
              };
              
              // Build incoming edges map - keyed by UUID (resolving any human-readable IDs)
              const incomingEdges = new Map<string, Array<any>>();
              graph.edges?.forEach((edge: any) => {
                const toUuid = resolveToUuid(edge.to);
                if (!incomingEdges.has(toUuid)) {
                  incomingEdges.set(toUuid, []);
                }
                incomingEdges.get(toUuid)!.push(edge);
              });
              
              // Topological sort to calculate mass
              const processed = new Set<string>();
              let iterations = 0;
              const maxIterations = graph.nodes?.length * 3 || 100;
              
              // Initialize: Add ALL start nodes to processed BEFORE the loop
              // This fixes ordering issues when start nodes appear after other nodes in the array
              graph.nodes?.forEach((node: any) => {
                if (node.entry?.is_start) {
                  const nodeId = node.uuid || node.id;
                  processed.add(nodeId);
                  flowMass.set(nodeId, 1);
                }
              });
              
              while (processed.size < (graph.nodes?.length || 0) && iterations < maxIterations) {
                iterations++;
                let madeProgress = false;
                
                graph.nodes?.forEach((node: any) => {
                  const nodeId = node.uuid || node.id;
                  
                  // Skip already processed nodes (including start nodes initialized above)
                  if (processed.has(nodeId)) {
                    return;
                  }
                  
                  const incoming = incomingEdges.get(nodeId) || [];
                  // Resolve edge.from to UUID for checking processed status
                  const allIncomingProcessed = incoming.every((edge: any) => processed.has(resolveToUuid(edge.from)));
                  
                  if (allIncomingProcessed && incoming.length > 0) {
                    let totalMass = 0;
                    incoming.forEach((edge: any) => {
                      // Resolve edge.from to UUID for flowMass lookup
                      const fromUuid = resolveToUuid(edge.from);
                      const sourceMass = flowMass.get(fromUuid) || 0;
                      const edgeId = edge.uuid || edge.id || `${edge.from}->${edge.to}`;
                      let effectiveProb = 0;
                      
                      if (layerId === 'current') {
                        effectiveProb = computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL: layerWhatIfDSL }, undefined);
                      } else if (composedParams) {
                        const edgeKey = edge.id || edge.uuid || `${edge.from}->${edge.to}`;
                        effectiveProb = composedParams.edges?.[edgeKey]?.p?.mean ?? edge.p?.mean ?? 0;
                        const caseInfo = getCaseEdgeVariantInfo(edge, graph, composedParams);
                        if (caseInfo) {
                          effectiveProb = effectiveProb * caseInfo.variantWeight;
                        }
                      } else {
                        effectiveProb = edge.p?.mean ?? 0;
                      }
                      
                      totalMass += sourceMass * effectiveProb;
                    });
                    
                    flowMass.set(nodeId, totalMass);
                    processed.add(nodeId);
                    madeProgress = true;
                  }
                });
                
                if (!madeProgress) break;
              }
              
              // Update maximum mass for each node
              flowMass.forEach((mass, nodeId) => {
                const currentMax = maxFlowMassPerNode.get(nodeId) || 0;
                maxFlowMassPerNode.set(nodeId, Math.max(currentMax, mass));
              });
              
              if (layerId === 'current') {
                currentLayerMaxMass = Math.max(...Array.from(flowMass.values()), 0.001);
              }
            }
            
            // Apply heights to nodes
            updatedNodes = updatedNodes.map(node => {
              const mass = maxFlowMassPerNode.get(node.id) || 0;
              const normalizedMass = mass / currentLayerMaxMass;
              const height = Math.max(MIN_NODE_HEIGHT, Math.min(MAX_NODE_HEIGHT, normalizedMass * MAX_NODE_HEIGHT));
              
              return {
                ...node,
                style: {
                  ...node.style,
                  width: DEFAULT_NODE_WIDTH,
                  height: height
                },
                data: {
                  ...node.data,
                  sankeyHeight: height,
                  sankeyWidth: DEFAULT_NODE_WIDTH,
                  useSankeyView: true
                }
              };
            });
          }
          
          // Add post-it nodes that exist in graph but not yet in ReactFlow (e.g. redo)
          // Add canvas object nodes that exist in graph but not yet in ReactFlow (e.g. redo)
          const existingContainerIds = new Set(updatedNodes.filter(n => n.id?.startsWith('container-')).map(n => n.id.replace('container-', '')));
          const graphContainers = graph.containers || [];
          for (let ci = 0; ci < graphContainers.length; ci++) {
            const c = graphContainers[ci];
            if (!existingContainerIds.has(c.id)) {
              updatedNodes.push({
                id: `container-${c.id}`,
                type: 'container',
                position: { x: c.x ?? 0, y: c.y ?? 0 },
                zIndex: 1000 + ci,
                style: { width: c.width, height: c.height },
                data: { container: c, onUpdate: handleUpdateContainer, onDelete: handleDeleteContainer, onResizeStart: handleResizeStart, onResizeEnd: handleResizeEnd },
              });
            }
          }

          const existingPostitIds = new Set(updatedNodes.filter(n => n.id?.startsWith('postit-')).map(n => n.id.replace('postit-', '')));
          const graphPostits = graph.postits || [];
          for (let pi = 0; pi < graphPostits.length; pi++) {
            const p = graphPostits[pi];
            if (!existingPostitIds.has(p.id)) {
              const shouldAutoEdit = autoEditNodeId === `postit-${p.id}`;
              if (shouldAutoEdit) autoEditPostitIdRef.current = null;
              updatedNodes.push({
                id: `postit-${p.id}`,
                type: 'postit',
                position: { x: p.x ?? 0, y: p.y ?? 0 },
                zIndex: 5000 + pi,
                selected: shouldAutoEdit,
                style: { width: p.width, height: p.height },
                data: {
                  postit: p,
                  onUpdate: handleUpdatePostit,
                  onDelete: handleDeletePostit,
                  onSelect: onSelectedAnnotationChange ? (id: string) => onSelectedAnnotationChange(id, 'postit') : undefined,
                  onResizeStart: handleResizeStart,
                  onResizeEnd: handleResizeEnd,
                  ...(shouldAutoEdit ? { autoEdit: true } : {}),
                },
              });
            }
          }

          const existingAnalysisIds = new Set(updatedNodes.filter(n => n.id?.startsWith('analysis-')).map(n => n.id.replace('analysis-', '')));
          const graphAnalyses = graph.canvasAnalyses || [];
          for (let ai = 0; ai < graphAnalyses.length; ai++) {
            const analysis = graphAnalyses[ai];
            if (!existingAnalysisIds.has(analysis.id)) {
              updatedNodes.push({
                id: `analysis-${analysis.id}`,
                type: 'canvasAnalysis',
                position: { x: analysis.x ?? 0, y: analysis.y ?? 0 },
                zIndex: 5000 + graphPostits.length + ai,
                style: { width: analysis.width, height: analysis.height },
                data: {
                  analysis,
                  tabId,
                  onUpdate: handleUpdateAnalysis,
                  onDelete: handleDeleteAnalysis,
                  onResizeStart: handleResizeStart,
                  onResizeEnd: handleResizeEnd,
                },
              });
            }
          }

          if (autoEditNodeId) {
            updatedNodes = updatedNodes.map(n => ({ ...n, selected: n.id === autoEditNodeId }));
          }

          if (snapshotCharts.length > 0) {
            const snapshotNodeIdsAfterUpdate = updatedNodes
              .filter((node) => node.id?.startsWith('analysis-'))
              .map((node) => node.id)
              .filter((id) => snapshotGraphAnalysisSet.has(id));
            const snapshotNodeSetAfterUpdate = new Set(snapshotNodeIdsAfterUpdate);
            const missingAfterFastPathUpdate = snapshotGraphAnalysisNodeIds.filter((id) => !snapshotNodeSetAfterUpdate.has(id));
            logSnapshotBoot('GraphCanvas:fast-path-nodes-updated', {
              snapshotCharts,
              snapshotNodeIdsAfterUpdate,
              missingAfterFastPathUpdate,
            });
          }

          return updatedNodes;
        });
      }
      
      return; // Skip full toFlow rebuild
    }
    
    const slowPathReason = sankeyModeChanged ? 'Sankey mode changed' :
                           imageViewChanged ? 'Image view changed' :
                           edgeCountChanged ? 'Edge count changed' :
                           nodeCountChanged ? 'Node count changed' :
                           edgeIdsChanged ? 'Edge IDs changed' :
                           edgeHandlesChanged ? 'Edge handles changed' :
                           nodePositionsChanged ? 'Node positions changed' : 'Unknown';
    console.log(`  🔨 Slow path: ${slowPathReason}, doing full rebuild`);
    if (snapshotCharts.length > 0) {
      logSnapshotBoot('GraphCanvas:slow-path-start', {
        snapshotCharts,
        slowPathReason,
      });
    }
    
    // Topology changed - do full rebuild
    // Preserve current selection state
    const selectedNodeIds = new Set(nodes.filter(n => n.selected).map(n => n.id));
    const selectedEdgeIds = new Set(edges.filter(e => e.selected).map(e => e.id));
    
    // In Sankey mode, force all edges to use left/right handles only
    let graphForBuild = graph;
    if (useSankeyView && graph.edges) {
      graphForBuild = {
        ...graph,
        edges: graph.edges.map(edge => {
          // Calculate optimal handles respecting Sankey constraints
          const sourceNode = graph.nodes?.find(n => n.uuid === edge.from || n.id === edge.from);
          const targetNode = graph.nodes?.find(n => n.uuid === edge.to || n.id === edge.to);
          
          if (!sourceNode || !targetNode) return edge;
          
          const dx = (targetNode.layout?.x ?? 0) - (sourceNode.layout?.x ?? 0);
          const dy = (targetNode.layout?.y ?? 0) - (sourceNode.layout?.y ?? 0);
          
          // Simple horizontal face selection for Sankey
          const sourceFace = dx >= 0 ? 'right' : 'left';
          const targetFace = dx >= 0 ? 'left' : 'right';
          
          return {
            ...edge,
            fromHandle: sourceFace + '-out',
            toHandle: targetFace
          };
        })
      };
    }
    
    const { nodes: newNodes, edges: newEdges } = toFlow(graphForBuild, {
      onUpdateNode: handleUpdateNode,
      onDeleteNode: handleDeleteNode,
      onUpdateEdge: handleUpdateEdge,
      onDeleteEdge: handleDeleteEdge,
      onDoubleClickNode: onDoubleClickNode,
      onDoubleClickEdge: onDoubleClickEdge,
      onSelectEdge: onSelectEdge,
      onReconnect: handleReconnect,
      onUpdatePostit: handleUpdatePostit,
      onDeletePostit: handleDeletePostit,
      onSelectPostit: onSelectedAnnotationChange ? (id: string) => onSelectedAnnotationChange(id, 'postit') : undefined,
      onUpdateContainer: handleUpdateContainer,
      onDeleteContainer: handleDeleteContainer,
      onUpdateAnalysis: handleUpdateAnalysis,
      onDeleteAnalysis: handleDeleteAnalysis,
      tabId,
    }, useSankeyView);

    if (snapshotCharts.length > 0) {
      const rebuiltSnapshotNodeIds = newNodes
        .filter((node) => node.id?.startsWith('analysis-'))
        .map((node) => node.id)
        .filter((id) => snapshotGraphAnalysisSet.has(id));
      const rebuiltSnapshotSet = new Set(rebuiltSnapshotNodeIds);
      const missingAfterSlowPathBuild = snapshotGraphAnalysisNodeIds.filter((id) => !rebuiltSnapshotSet.has(id));
      logSnapshotBoot('GraphCanvas:slow-path-built', {
        snapshotCharts,
        rebuiltSnapshotNodeIds,
        missingAfterSlowPathBuild,
      });
    }
    
    // Inject containerColours for conversion nodes inside containers (using positions from the rebuild)
    const containerArray = graph.containers || [];
    const containerRfNodes = newNodes.filter(n => n.id?.startsWith('container-'));
    const CONTAIN_TOL_SLOW = 10;
    const injectContainerColour = (node: any) => {
      if (node.type !== 'conversion') return node;
      const nw = DEFAULT_NODE_WIDTH;
      const nh = DEFAULT_NODE_HEIGHT;
      const nx = node.position?.x ?? 0;
      const ny = node.position?.y ?? 0;
      // Collect ALL containers that enclose this node (there may be overlapping ones)
      const enclosingColours: string[] = [];
      for (let ci = 0; ci < containerArray.length; ci++) {
        const cont = containerRfNodes.find(cn => cn.id === `container-${containerArray[ci].id}`);
        if (!cont) continue;
        const cx = cont.position?.x ?? 0;
        const cy = cont.position?.y ?? 0;
        const cw = typeof cont.style?.width === 'number' ? cont.style.width : 400;
        const ch = typeof cont.style?.height === 'number' ? cont.style.height : 300;
        if (nx >= (cx - CONTAIN_TOL_SLOW) && ny >= (cy - CONTAIN_TOL_SLOW) && (nx + nw) <= (cx + cw + CONTAIN_TOL_SLOW) && (ny + nh) <= (cy + ch + CONTAIN_TOL_SLOW)) {
          if (containerArray[ci].colour) enclosingColours.push(containerArray[ci].colour);
        }
      }
      if (enclosingColours.length > 0) {
        return { ...node, data: { ...node.data, containerColours: enclosingColours } };
      }
      if (node.data?.containerColours) {
        const { containerColours: _, ...rest } = node.data;
        return { ...node, data: rest };
      }
      return node;
    };

    // Restore selection state + inject autoEdit flag for newly created post-its
    const autoEditNodeId = autoEditPostitIdRef.current ? `postit-${autoEditPostitIdRef.current}` : null;
    const autoSelectAnalysisNodeId = autoSelectAnalysisIdRef.current ? `analysis-${autoSelectAnalysisIdRef.current}` : null;
    const autoSelectId = autoEditNodeId || autoSelectAnalysisNodeId;
    let nodesWithSelection = newNodes.map(node => {
      const withColour = injectContainerColour(node);
      const base = { ...withColour, selected: autoSelectId ? withColour.id === autoSelectId : selectedNodeIds.has(withColour.id) };
      if (autoEditNodeId && withColour.id === autoEditNodeId) {
        console.log(`[GraphCanvas] Injecting autoEdit for ${withColour.id}, selected=true`);
        autoEditPostitIdRef.current = null;
        return { ...base, data: { ...base.data, autoEdit: true } };
      }
      if (autoSelectAnalysisNodeId && withColour.id === autoSelectAnalysisNodeId) {
        autoSelectAnalysisIdRef.current = null;
      }
      return base;
    });
    
    // Apply Sankey view sizing if enabled
    if (useSankeyView) {
      const NODE_WIDTH = DEFAULT_NODE_WIDTH; // Fixed width for Sankey view
      
      // Calculate flow mass through each node across all visible layers
      // For Sankey diagrams:
      // - Each node is sized by the MAX mass it receives across all layers
      // - Normalization is based ONLY on the current layer's max mass
      console.log('[Sankey] Graph nodes:', graph.nodes?.map((n: any) => ({ uuid: n.uuid, id: n.id, label: n.label, isStart: n.entry?.is_start })));
      console.log('[Sankey] Graph edges:', graph.edges?.map((e: any) => ({ from: e.from, to: e.to, prob: e.p?.mean })));
      
      // Determine which layers to calculate mass for (all visible layers)
      const scenarioState = tabId ? tabs.find(t => t.id === tabId)?.editorState?.scenarioState : undefined;
      const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
      const layersToCalculate = visibleScenarioIds.includes('current')
        ? visibleScenarioIds
        : [...visibleScenarioIds, 'current']; // Always include current even if hidden
      
      console.log('[Sankey] Calculating mass for layers:', layersToCalculate);
      
      // Track maximum mass for each node across all layers
      const maxFlowMassPerNode = new Map<string, number>();
      // Track current layer mass separately for normalization
      let currentLayerMaxMass = 0;
      
      // Calculate flow mass for each layer
      for (const layerId of layersToCalculate) {
        console.log(`[Sankey] Processing layer: ${layerId}`);
        const flowMass = new Map<string, number>();
        
        // Determine the effective whatIfDSL for this layer
        let layerWhatIfDSL = effectiveWhatIfDSL;
        let composedParams: any = null;
        
        if (layerId !== 'current' && scenariosContext) {
          // Scenario layer - use centralized composition
          composedParams = getComposedParamsForLayer(
            layerId,
            scenariosContext.baseParams,
            scenariosContext.currentParams,
            scenariosContext.scenarios
          );
          if (layerId !== 'base') {
            layerWhatIfDSL = null; // Scenarios don't use What-If
          }
        }
        
        // Initialize start nodes with their entry weights
        graph.nodes?.forEach((node: any) => {
          if (node.entry?.is_start) {
            const entryWeight = node.entry.entry_weight || 1.0;
            flowMass.set(node.uuid, entryWeight);
          } else {
            flowMass.set(node.uuid, 0);
          }
        });
        
        // Helper to resolve node reference (UUID, truncated UUID, or human-readable ID) to full UUID
        const resolveToUuid = (ref: string): string => {
          // Try exact match on UUID or human-readable ID first
          let node = graph.nodes?.find((n: any) => n.uuid === ref || n.id === ref);
          if (node) return node.uuid;
          
          // Fallback: check if ref is a truncated UUID prefix (e.g., first 8 chars)
          node = graph.nodes?.find((n: any) => n.uuid?.startsWith(ref));
          return node?.uuid || ref; // Return UUID if found, otherwise return original
        };
        
        // Build incoming edges map - keyed by UUID (resolving any human-readable IDs)
        const incomingEdges = new Map<string, Array<any>>();
        graph.edges?.forEach((edge: any) => {
          const toUuid = resolveToUuid(edge.to);
          if (!incomingEdges.has(toUuid)) {
            incomingEdges.set(toUuid, []);
          }
          incomingEdges.get(toUuid)!.push(edge);
        });
        
        // Topological sort: process nodes in dependency order
        const processed = new Set<string>();
        let iterations = 0;
        const maxIterations = graph.nodes?.length * 3 || 100;
        
        // Initialize: Add ALL start nodes to processed BEFORE the loop
        // This fixes ordering issues when start nodes appear after other nodes in the array
        graph.nodes?.forEach((node: any) => {
          if (node.entry?.is_start) {
            const nodeId = node.uuid || node.id;
            processed.add(nodeId);
            flowMass.set(nodeId, 1);
          }
        });
        
        while (processed.size < (graph.nodes?.length || 0) && iterations < maxIterations) {
          iterations++;
          let madeProgress = false;
          
          graph.nodes?.forEach((node: any) => {
            const nodeId = node.uuid || node.id;
            
            // Skip already processed nodes (including start nodes initialized above)
            if (processed.has(nodeId)) {
              return;
            }
            
            const incoming = incomingEdges.get(nodeId) || [];
            // Resolve edge.from to UUID for checking processed status
            const allIncomingProcessed = incoming.every((edge: any) => processed.has(resolveToUuid(edge.from)));
            
            if (allIncomingProcessed && incoming.length > 0) {
              let totalMass = 0;
              incoming.forEach((edge: any) => {
                // Resolve edge.from to UUID for flowMass lookup
                const fromUuid = resolveToUuid(edge.from);
                const sourceMass = flowMass.get(fromUuid) || 0;
                
                const edgeId = edge.uuid || edge.id || `${edge.from}->${edge.to}`;
                let effectiveProb = 0;
                
                if (layerId === 'current') {
                  // Use what-if DSL for current layer
                  effectiveProb = computeEffectiveEdgeProbability(
                    graph,
                    edgeId,
                    { whatIfDSL: layerWhatIfDSL },
                    undefined
                  );
                } else if (composedParams) {
                  // Use composed params for scenario layer
                  const edgeKey = edge.id || edge.uuid || `${edge.from}->${edge.to}`;
                  effectiveProb = composedParams.edges?.[edgeKey]?.p?.mean 
                    ?? edge.p?.mean ?? 0;
                  
                  // Apply case variant weight if applicable
                  const caseInfo = getCaseEdgeVariantInfo(edge, graph, composedParams);
                  if (caseInfo) {
                    effectiveProb = effectiveProb * caseInfo.variantWeight;
                  }
                } else {
                  // Fallback
                  effectiveProb = edge.p?.mean ?? 0;
                }
                
                totalMass += sourceMass * effectiveProb;
              });
              
              flowMass.set(nodeId, totalMass);
              processed.add(nodeId);
              madeProgress = true;
            }
          });
          
          if (!madeProgress) {
            break;
          }
        }
        
        // Update maximum mass for each node across all layers
        flowMass.forEach((mass, nodeId) => {
          const currentMax = maxFlowMassPerNode.get(nodeId) || 0;
          maxFlowMassPerNode.set(nodeId, Math.max(currentMax, mass));
        });
        
        // If this is the current layer, capture its max mass for normalization
        if (layerId === 'current') {
          currentLayerMaxMass = Math.max(...Array.from(flowMass.values()), 0.001);
        }
      }
      
      // Apply heights to nodes using MAX mass across layers, normalized by current layer max
      nodesWithSelection = nodesWithSelection.map(node => {
        const mass = maxFlowMassPerNode.get(node.id) || 0;
        const normalizedMass = mass / currentLayerMaxMass;
        const height = Math.max(MIN_NODE_HEIGHT, Math.min(MAX_NODE_HEIGHT, normalizedMass * MAX_NODE_HEIGHT));
        
        return {
          ...node,
          style: {
            ...node.style,
            width: NODE_WIDTH,
            height: height
          },
          data: {
            ...node.data,
            sankeyHeight: height, // Pass height to node component
            sankeyWidth: NODE_WIDTH,
            useSankeyView: true // Flag for node to know it's in Sankey mode
          }
        };
      });
    }
    
    // Apply image view: only enlarge nodes that actually have images
    if (showNodeImages) {
      nodesWithSelection = nodesWithSelection.map(node => {
        const hasImages = node.data?.images && node.data.images.length > 0;
        if (hasImages && !useSankeyView) {
          return {
            ...node,
            style: {
              ...node.style,
              width: IMAGE_VIEW_NODE_WIDTH,
              height: IMAGE_VIEW_NODE_HEIGHT
            },
            data: {
              ...node.data,
              sankeyWidth: IMAGE_VIEW_NODE_WIDTH,
              sankeyHeight: IMAGE_VIEW_NODE_HEIGHT,
              showNodeImages: true
            }
          };
        } else if (hasImages) {
          // Sankey on — just pass the flag, Sankey controls dimensions
          return { ...node, data: { ...node.data, showNodeImages: true } };
        }
        // No images — leave node completely unchanged (normal size, normal layout)
        return node;
      });
    }
    
    // Add edge width calculation to each edge
    const edgesWithWidth = newEdges.map(edge => {
      const isSelected = autoEditNodeId ? false : selectedEdgeIds.has(edge.id);
      return {
      ...edge,
        selected: isSelected,
        reconnectable: true, // Always true; CSS hides handles for unselected, callback rejects unselected
      data: {
        ...edge.data
        // Don't add calculateWidth here - will be added after offsets are calculated
      }
      };
    });
    
    // Add calculateWidth functions with updated edge data
    const edgesWithWidthFunctions = edgesWithWidth.map(edge => ({
      ...edge,
      data: {
        ...edge.data
      }
    }));
    
  // Calculate edge offsets for Sankey-style visualization
  // In Sankey view, use a much larger max width (edges can be as wide as tall nodes)
  const effectiveMaxWidth = useSankeyView 
    ? 384 // Allow edges to be up to 384px wide (MAX_NODE_HEIGHT 400 - 16px margin)
    : MAX_WIDTH;
  const edgesWithOffsets = calculateEdgeOffsets(edgesWithWidthFunctions, nodesWithSelection, effectiveMaxWidth);
  
  // Attach offsets to edge data for the ConversionEdge component
  const edgesWithOffsetData = edgesWithOffsets.map(edge => ({
    ...edge,
    data: {
      ...edge.data,
      sourceOffsetX: edge.sourceOffsetX,
      sourceOffsetY: edge.sourceOffsetY,
      targetOffsetX: edge.targetOffsetX,
      targetOffsetY: edge.targetOffsetY,
      scaledWidth: edge.scaledWidth,
      // Bundle metadata
      sourceBundleWidth: edge.sourceBundleWidth,
      targetBundleWidth: edge.targetBundleWidth,
      sourceBundleSize: edge.sourceBundleSize,
      targetBundleSize: edge.targetBundleSize,
      isFirstInSourceBundle: edge.isFirstInSourceBundle,
      isLastInSourceBundle: edge.isLastInSourceBundle,
      isFirstInTargetBundle: edge.isFirstInTargetBundle,
      isLastInTargetBundle: edge.isLastInTargetBundle,
      sourceFace: edge.sourceFace,
      targetFace: edge.targetFace,
      // Pass what-if DSL to edges
      whatIfDSL: effectiveWhatIfDSL,
      // Pass Sankey view flag to edges
      useSankeyView: useSankeyView
      // ATOMIC RESTORATION: Do NOT pass decoration visibility through edge.data
      // Beads will read beadsVisible from React Context instead
    }
  }));
  
  // Compute edge anchors (start edges under the node boundary for cleaner appearance)
  const edgesWithAnchors = edgesWithOffsetData.map(edge => {
    const computeAnchor = (
      nodeId: string,
      face: string | undefined,
      offsetX: number | undefined,
      offsetY: number | undefined
    ) => {
      const n: any = nodesWithSelection.find((nn: any) => nn.id === nodeId);
      const w = n?.width ?? DEFAULT_NODE_WIDTH;
      const h = n?.height ?? DEFAULT_NODE_HEIGHT;
      const x = n?.position?.x ?? 0;
      const y = n?.position?.y ?? 0;

      // No inset - anchors at the actual edge (ReactFlow handles are there)
      if (face === 'right') {
        return { x: x + w, y: y + h / 2 + (offsetY ?? 0) };
      }
      if (face === 'left') {
        return { x: x, y: y + h / 2 + (offsetY ?? 0) };
      }
      if (face === 'bottom') {
        return { x: x + w / 2 + (offsetX ?? 0), y: y + h };
      }
      // top/default
      return { x: x + w / 2 + (offsetX ?? 0), y: y };
    };
    const srcAnchor = computeAnchor(edge.source, edge.data.sourceFace, edge.sourceOffsetX, edge.sourceOffsetY);
    const tgtAnchor = computeAnchor(edge.target, edge.data.targetFace, edge.targetOffsetX, edge.targetOffsetY);
    
    return {
      ...edge,
      data: {
        ...edge.data,
        sourceAnchorX: srcAnchor.x,
        sourceAnchorY: srcAnchor.y,
        targetAnchorX: tgtAnchor.x,
        targetAnchorY: tgtAnchor.y,
      }
    };
  });
    
    // Compute face directions eagerly so the first paint has correct curved outlines.
    // edgesWithOffsets already carry .sourceFace/.targetFace from calculateEdgeOffsets.
    if (!useSankeyView && edgesWithOffsets.length > 0) {
      const faceMap = computeFaceDirectionsFromEdges(edgesWithOffsets);
      nodesWithSelection = nodesWithSelection.map((node: any) => {
        const fd = faceMap.get(node.id);
        if (!fd) return node;
        return { ...node, data: { ...node.data, faceDirections: fd } };
      });
    }

    setNodes(nodesWithSelection);
    // Sort edges so selected edges render last (on top)
    const sortedEdges = [...edgesWithAnchors].sort((a, b) => {
      if (a.selected && !b.selected) return 1;  // selected edge goes after unselected
      if (!a.selected && b.selected) return -1; // unselected edge goes before selected
      return 0; // preserve order otherwise
    });
    
    // Add scenario overlay edges (only if scenarios visible)
    // Filter out any existing overlay edges first to avoid duplicates
    const baseEdges = sortedEdges.filter(e => !e.id.startsWith('scenario-overlay-'));
    
    const scenarioState = tabId ? tabs.find(t => t.id === tabId)?.editorState?.scenarioState : undefined;
    const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
    const visibleColourOrderIds = scenarioState?.visibleColourOrderIds || [];
    
    let edgesWithScenarios = baseEdges;
    
    
    // GEOMETRY MERGE: Preserve key geometry fields (scaledWidth, offsets) from previous RENDER edges
    // when topology hasn't changed, to avoid visual flicker during slow-path rebuilds
    // Use lastRenderEdgesRef which tracks the final output of buildScenarioRenderEdges (with correct widths)
    const prevById = new Map<string, any>();
    lastRenderEdgesRef.current.forEach(prevEdge => {
      prevById.set(prevEdge.id, prevEdge);
    });
    
    const mergedEdges = edgesWithScenarios.map(newEdge => {
      const prevEdge = prevById.get(newEdge.id);
      if (!prevEdge) return newEdge; // New edge - use as-is
      
      // Check if topology changed (source, target, or handles differ)
      const topologyChanged =
        newEdge.source !== prevEdge.source ||
        newEdge.target !== prevEdge.target ||
        newEdge.sourceHandle !== prevEdge.sourceHandle ||
        newEdge.targetHandle !== prevEdge.targetHandle;
      
      if (topologyChanged) {
        return newEdge; // Topology changed - use new geometry
      }
      
      // Topology unchanged - merge key geometry fields from previous RENDER edge
      const prevData = prevEdge.data || {};
      const newData = newEdge.data || {};
      
      return {
        ...newEdge,
        data: {
          ...newData,
          // Preserve geometry from previous render to avoid flicker
          scaledWidth: prevData.scaledWidth ?? newData.scaledWidth,
          sourceOffsetX: prevData.sourceOffsetX ?? newData.sourceOffsetX,
          sourceOffsetY: prevData.sourceOffsetY ?? newData.sourceOffsetY,
          targetOffsetX: prevData.targetOffsetX ?? newData.targetOffsetX,
          targetOffsetY: prevData.targetOffsetY ?? newData.targetOffsetY,
        },
      };
    });
    
    setEdges(mergedEdges);
    
    // CRITICAL: Update lastSyncedReactFlowRef to prevent ReactFlow→Graph sync from
    // re-triggering when Graph→ReactFlow sync completes. This prevents the sync loop:
    // Graph change → Graph→ReactFlow sync → nodes/edges state change → ReactFlow→Graph sync → Graph change
    // The fromFlow() call here matches what ReactFlow→Graph sync would produce, so we can skip it.
    const graphFromFlow = fromFlow(newNodes, mergedEdges, graph);
    if (graphFromFlow) {
      lastSyncedReactFlowRef.current = JSON.stringify(graphFromFlow);
    }
    
    // Clear rebuild flag after a brief delay to allow scenario pipeline to settle
    setTimeout(() => {
      isInSlowPathRebuildRef.current = false;
    }, 50);
    
    // Reset syncing flag after graph->ReactFlow sync is complete
    // Use a longer timeout to ensure all cascading updates complete
    setTimeout(() => {
      isSyncingRef.current = false;
      console.log('Reset isSyncingRef to false');
    }, 100);
  }, [graph, setNodes, setEdges, handleUpdateNode, handleDeleteNode, handleUpdateEdge, handleDeleteEdge, handleReconnect, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, effectiveActiveTabId, tabs, useSankeyView, showNodeImages, effectiveWhatIfDSL]);

  // Strip per-node draggable/selectable overrides so global ReactFlow props control behaviour
  useEffect(() => {
    setNodes(nds => nds.map(n => {
      if (n.draggable !== undefined || n.selectable !== undefined) {
        return { ...n, draggable: undefined, selectable: undefined };
      }
      return n;
    }));
  }, [activeElementTool, setNodes]);

  // Face directions are computed eagerly in the slow path (before setNodes) using
  // computeFaceDirectionsFromEdges. The fast path preserves them via ...prevNode.data spread.
  // All topology/handle changes route through the slow path, so no safety-net effect is needed.

  // Force re-route when Sankey view is actually toggled (to re-assign faces for L/R only constraint)
  // Only react when the value actually changes, not on initial load
  useEffect(() => {
    const prev = prevSankeyViewRef.current;
    prevSankeyViewRef.current = useSankeyView;
    
    // Skip if this is the first render (prev is undefined) or value hasn't changed
    if (prev === undefined || prev === useSankeyView) {
      return;
    }
    
    if (edges.length > 0) {
      console.log(`[Sankey] View toggled from ${prev} to ${useSankeyView}, forcing re-route`);
      setForceReroute(true);
    }
  }, [useSankeyView, edges.length]);

  // Separate effect to handle hidden state changes and trigger redraw
  useEffect(() => {
    if (!effectiveActiveTabId || !nodes.length || !edges.length) return;
    
    const tab = tabs.find(t => t.id === effectiveActiveTabId);
    const hiddenNodes = tab?.editorState?.hiddenNodes || new Set<string>();
    
    // Update node classes
    // hiddenNodes contains human-readable IDs (node.data.id), not UUIDs (node.id)
    setNodes(prevNodes => 
      prevNodes.map(node => ({
        ...node,
        className: hiddenNodes.has(node.data?.id) ? 'hidden' : ''
      }))
    );
    
    // Update edge classes
    // Check if source or target node (by data.id) is hidden
    // Use nodesMapRef to avoid dependency on nodes array reference
    setEdges(prevEdges => 
      prevEdges.map(edge => {
        const sourceNode = nodesMapRef.current.get(edge.source);
        const targetNode = nodesMapRef.current.get(edge.target);
        const isHidden = (sourceNode && hiddenNodes.has(sourceNode.data?.id)) || 
                        (targetNode && hiddenNodes.has(targetNode.data?.id));
        return {
        ...edge,
          className: isHidden ? 'hidden' : ''
        };
      })
    );
  }, [effectiveActiveTabId, tabs, nodes.length, edges.length, setNodes, setEdges]);

  // Separate effect to handle initial fitView AFTER nodes are populated
  useEffect(() => {
    // Trigger fitView when we first have nodes and haven't done it yet
    if (!hasInitialFitViewRef.current && nodes.length > 0) {
      hasInitialFitViewRef.current = true;
      setTimeout(() => {
        console.log('Initial fitView after nodes populated:', nodes.length, 'nodes');
        fitView();
      }, 250);
    }
  }, [fitView]); // Removed nodes.length dependency

  // External request: fit the current graph to view (used by dashboard mode, but safe elsewhere).
  useEffect(() => {
    const handler = (e: any) => {
      const requestedTabId = e?.detail?.tabId as string | undefined;
      if (requestedTabId && tabId && requestedTabId !== tabId) return;
      try {
        fitView({ padding: 0.08, duration: 350 });
      } catch {}
    };
    window.addEventListener('dagnet:fitView', handler as any);
    return () => window.removeEventListener('dagnet:fitView', handler as any);
  }, [fitView, tabId]);
  
  // Reset fitView flag when graph changes (new file loaded)
  useEffect(() => {
    if (graph) {
      // Use a combination of metadata to detect graph changes
      const graphSignature = `${graph.metadata?.version || ''}_${graph.nodes?.length || 0}_${graph.edges?.length || 0}`;
      
      if (currentGraphIdRef.current !== graphSignature && graphSignature !== '_0_0') {
        console.log('New graph loaded, resetting fitView flag');
        hasInitialFitViewRef.current = false;
        currentGraphIdRef.current = graphSignature;
      }
    }
  }, [graph]);

  
  // Track last scaling values to detect actual changes
  const lastScalingRef = useRef({ uniform: useUniformScaling, generosity: massGenerosity });

  // Update edge widths when scaling mode changes
  useEffect(() => {
    // Check if scaling actually changed
    const scalingChanged = 
      lastScalingRef.current.uniform !== useUniformScaling ||
      lastScalingRef.current.generosity !== massGenerosity;
    
    if (!scalingChanged || edges.length === 0) return;
    
    // Update ref
    lastScalingRef.current = { uniform: useUniformScaling, generosity: massGenerosity };
    
    console.log('Edge scaling changed - uniform:', useUniformScaling, 'generosity:', massGenerosity);
    
    // Ensure sync flag is reset after edge scaling updates
    setTimeout(() => {
      isSyncingRef.current = false;
      console.log('Reset isSyncingRef after edge scaling');
    }, 50);
    
      // First pass: update edge data without calculateWidth functions
    const edgesWithWidth = edges.map(edge => ({
        ...edge,
        data: {
          ...edge.data
        }
      }));
      
      // Second pass: add calculateWidth functions with updated edge data
      // Edges are updated without calculateWidth (added by buildScenarioRenderEdges)
      // Recalculate offsets for mass-based scaling modes
      const edgesWithOffsets = calculateEdgeOffsets(edgesWithWidth, nodes, MAX_WIDTH);
      
    // Attach offsets to edge data for the ConversionEdge component
    const result = edgesWithOffsets.map(edge => {
      // Compute edge anchor positions (exact edge endpoints at node face)
      const computeAnchor = (nodeId: string, face: string | undefined, offsetX: number | undefined, offsetY: number | undefined) => {
        const n: any = nodes.find((nn: any) => nn.id === nodeId);
        const w = n?.width ?? DEFAULT_NODE_WIDTH;
        const h = n?.height ?? DEFAULT_NODE_HEIGHT;
        const x = n?.position?.x ?? 0;
        const y = n?.position?.y ?? 0;
        if (face === 'right') return { x: x + w, y: y + h / 2 + (offsetY ?? 0) };
        if (face === 'left') return { x: x, y: y + h / 2 + (offsetY ?? 0) };
        if (face === 'bottom') return { x: x + w / 2 + (offsetX ?? 0), y: y + h };
        // top/default
        return { x: x + w / 2 + (offsetX ?? 0), y: y };
      };
      const srcAnchor = computeAnchor(edge.source, edge.data?.sourceFace, edge.sourceOffsetX, edge.sourceOffsetY);
      const tgtAnchor = computeAnchor(edge.target, edge.data?.targetFace, edge.targetOffsetX, edge.targetOffsetY);
      
      return {
        ...edge,
        data: {
          ...edge.data,
          sourceOffsetX: edge.sourceOffsetX,
          sourceOffsetY: edge.sourceOffsetY,
          targetOffsetX: edge.targetOffsetX,
          targetOffsetY: edge.targetOffsetY,
          scaledWidth: edge.scaledWidth,
          // Anchor positions for edge endpoints
          sourceAnchorX: srcAnchor.x,
          sourceAnchorY: srcAnchor.y,
          targetAnchorX: tgtAnchor.x,
          targetAnchorY: tgtAnchor.y,
          // Bundle metadata
          sourceBundleWidth: edge.sourceBundleWidth,
          targetBundleWidth: edge.targetBundleWidth,
          sourceBundleSize: edge.sourceBundleSize,
          targetBundleSize: edge.targetBundleSize,
          isFirstInSourceBundle: edge.isFirstInSourceBundle,
          isLastInSourceBundle: edge.isLastInSourceBundle,
          isFirstInTargetBundle: edge.isFirstInTargetBundle,
          isLastInTargetBundle: edge.isLastInTargetBundle,
          sourceFace: edge.sourceFace,
          targetFace: edge.targetFace,
          // Pass what-if DSL to edges
          whatIfDSL: effectiveWhatIfDSL
        }
    };
    });
    
    // Update edges
    setEdges(result);
  }, [useUniformScaling, massGenerosity, edges, nodes, calculateEdgeOffsets, effectiveWhatIfDSL, setEdges]);
  
  // Recalculate edge widths when what-if changes (throttled to one per frame)
  const recomputeInProgressRef = useRef(false);
  const visualWhatIfUpdateRef = useRef(false);
  useEffect(() => {
    if (sankeyLayoutInProgressRef.current || isEffectsCooldownActive()) {
      return;
    }
    if (edges.length === 0) return;
    if (recomputeInProgressRef.current) {
      return;
    }
    recomputeInProgressRef.current = true;
    const t0 = performance.now();
    requestAnimationFrame(() => {
      try {
        visualWhatIfUpdateRef.current = true; // mark as visual-only update
        setEdges(prevEdges => {
          const t1 = performance.now();
          // First pass: update edge data without calculateWidth functions
          const edgesWithWidth = prevEdges.map(edge => ({
            ...edge,
            data: {
              ...edge.data
            }
          }));
          // Second pass: add calculateWidth functions with updated edge data
          // Edges are updated without calculateWidth (added by buildScenarioRenderEdges)
          const t2 = performance.now();
          // Recalculate offsets for mass-based scaling modes
          // Use effectiveMaxWidth (384 in Sankey mode, 104 otherwise)
          const effectiveMaxWidth = useSankeyView ? 384 : MAX_WIDTH;
          const edgesWithOffsets = calculateEdgeOffsets(edgesWithWidth, nodes, effectiveMaxWidth);
          const t3 = performance.now();
          // Attach offsets to edge data for the ConversionEdge component
          return edgesWithOffsets.map(edge => ({
            ...edge,
            data: {
              ...edge.data,
              sourceOffsetX: edge.sourceOffsetX,
              sourceOffsetY: edge.sourceOffsetY,
              targetOffsetX: edge.targetOffsetX,
              targetOffsetY: edge.targetOffsetY,
              scaledWidth: edge.scaledWidth,
              // Bundle metadata
              sourceBundleWidth: edge.sourceBundleWidth,
              targetBundleWidth: edge.targetBundleWidth,
              sourceBundleSize: edge.sourceBundleSize,
              targetBundleSize: edge.targetBundleSize,
              isFirstInSourceBundle: edge.isFirstInSourceBundle,
              isLastInSourceBundle: edge.isLastInSourceBundle,
              isFirstInTargetBundle: edge.isFirstInTargetBundle,
              isLastInTargetBundle: edge.isLastInTargetBundle,
              sourceFace: edge.sourceFace,
              targetFace: edge.targetFace,
              // Pass what-if DSL to edges
              whatIfDSL: effectiveWhatIfDSL
            }
          }));
        });
      } finally {
        const tEnd = performance.now();
        // Only log if recompute took significant time (>10ms) to avoid noise
        const totalMs = Math.round(tEnd - t0);
        if (totalMs > 10) {
          console.log(`[${ts()}] [GraphCanvas] what-if recompute done`, { totalMs });
        }
        recomputeInProgressRef.current = false;
        // Clear the visual-only flag after queue flush
        setTimeout(() => { visualWhatIfUpdateRef.current = false; }, 0);
      }
    });
  }, [overridesVersion, setEdges, nodes, edges.length, graph?.metadata?.updated_at]);

  useEffect(() => {
    // Log when overridesVersion propagates into canvas and compute latency
    if (whatIfStartRef.current != null) {
      const dt = performance.now() - whatIfStartRef.current;
      console.log(`[${ts()}] [GraphCanvas] what-if applied`, { dtMs: Math.round(dt) });
      whatIfStartRef.current = null;
    } else {
      console.log(`[${ts()}] [GraphCanvas] overrides changed (no start marker)`);
    }
  }, [overridesVersion]);
  
  // Update node sizes in Sankey mode when what-if analysis changes
  // Use a ref to track the last what-if version we processed to avoid infinite loops
  const lastWhatIfVersionRef = useRef<string>('');
  const sankeyUpdatingRef = useRef(false);
  const skipSankeyNodeSizingRef = useRef(false); // Set by Sankey layout to skip sizing after layout
  useEffect(() => {
    if (!useSankeyView || sankeyUpdatingRef.current || skipSankeyNodeSizingRef.current) {
      if (skipSankeyNodeSizingRef.current) {
        console.log('[Sankey] Skipping node sizing (just did layout)');
        skipSankeyNodeSizingRef.current = false;
      }
      return;
    }
    
    // Get current graph state without depending on it
    const currentGraph = graphStoreHook.getState().graph;
    if (!currentGraph) return;
    
    // Create a version string from what-if state to detect actual changes
    const whatIfVersion = overridesVersion;
    if (lastWhatIfVersionRef.current === whatIfVersion) {
      return; // Skip if we already processed this what-if state
    }
    lastWhatIfVersionRef.current = whatIfVersion;
    sankeyUpdatingRef.current = true;
    
    console.log('[Sankey] What-if changed, recalculating node sizes');
    
    // Recalculate flow mass with current what-if state
    const MIN_NODE_HEIGHT = 60;
    const MAX_NODE_HEIGHT = 400;
    const flowMass = new Map<string, number>();
    
    // Initialize start nodes
    currentGraph.nodes?.forEach((node: any) => {
      if (node.entry?.is_start) {
        flowMass.set(node.uuid, node.entry.entry_weight || 1.0);
      } else {
        flowMass.set(node.uuid, 0);
      }
    });
    
    // Build incoming edges map
    const incomingEdges = new Map<string, Array<any>>();
    currentGraph.edges?.forEach((edge: any) => {
      if (!incomingEdges.has(edge.to)) {
        incomingEdges.set(edge.to, []);
      }
      incomingEdges.get(edge.to)!.push(edge);
    });
    
    // Topological sort
    const processed = new Set<string>();
    let iterations = 0;
    const maxIterations = currentGraph.nodes?.length * 3 || 100;
    
    while (processed.size < (currentGraph.nodes?.length || 0) && iterations < maxIterations) {
      iterations++;
      let madeProgress = false;
      
      currentGraph.nodes?.forEach((node: any) => {
        const nodeId = node.uuid || node.id;
        if (processed.has(nodeId) || node.entry?.is_start) {
          if (node.entry?.is_start) processed.add(nodeId);
          return;
        }
        
        const incoming = incomingEdges.get(nodeId) || [];
        const allIncomingProcessed = incoming.every((edge: any) => processed.has(edge.from));
        
        if (allIncomingProcessed && incoming.length > 0) {
          let totalMass = 0;
          incoming.forEach((edge: any) => {
            const from = edge.from;
            const sourceMass = flowMass.get(from) || 0;
            const edgeId = edge.uuid || edge.id || `${edge.from}->${edge.to}`;
            const effectiveProb = computeEffectiveEdgeProbability(
              currentGraph,
              edgeId,
              { whatIfDSL: effectiveWhatIfDSL },
              undefined
            );
            totalMass += sourceMass * effectiveProb;
          });
          
          flowMass.set(nodeId, totalMass);
          processed.add(nodeId);
          madeProgress = true;
        }
      });
      
      if (!madeProgress) break;
    }
    
    // Find max mass and update node sizes
    const maxMass = Math.max(...Array.from(flowMass.values()), 0.001);
    
    setNodes(prevNodes => prevNodes.map(node => {
      const mass = flowMass.get(node.id) || 0;
      const normalizedMass = mass / maxMass;
      const height = Math.max(MIN_NODE_HEIGHT, Math.min(MAX_NODE_HEIGHT, normalizedMass * MAX_NODE_HEIGHT));
      
      console.log(`[Sankey WhatIf] Node ${node.data?.label}: mass=${mass.toFixed(3)}, height=${height.toFixed(0)}`);
      
      return {
        ...node,
        style: {
          ...node.style,
          height: height
        },
        data: {
          ...node.data,
          sankeyHeight: height
        }
      };
    }));
    
    // Reset flag after update
    setTimeout(() => {
      sankeyUpdatingRef.current = false;
    }, 0);
  }, [useSankeyView, overridesVersion, setNodes, whatIfDSL]);
  
  // Sync FROM ReactFlow TO graph when user makes changes in the canvas
  // NOTE: This should NOT depend on 'graph' to avoid syncing when graph changes externally
  useEffect(() => {
    if (sankeyLayoutInProgressRef.current || isEffectsCooldownActive()) {
      return;
    }
    if (!graph) return;
    if (visualWhatIfUpdateRef.current) {
      // Skip syncing visual-only what-if changes back to graph store
      // Prevents global rerenders and race conditions
      return;
    }
    if (isSyncingRef.current) {
      return;
    }
    
    // BLOCK ReactFlow→Graph sync during node dragging or resizing to prevent multiple graph updates
    if (isDraggingNodeRef.current || isResizingNodeRef.current) {
      return;
    }
    
    if (nodes.length === 0 && graph.nodes.length > 0) {
      return;
    }
    // IMPORTANT: Prevent a transient ReactFlow edge reset (e.g. during dashboard enter/exit,
    // rc-dock visibility flicker, or ReactFlow remount) from wiping edges in the graph store.
    // If ReactFlow edges are empty but the graph still has edges, treat this as not-yet-hydrated.
    if (edges.length === 0 && (graph.edges?.length || 0) > 0) {
      return;
    }
    
    const updatedGraph = fromFlow(nodes, edges, graph);
    if (updatedGraph) {
      const updatedJson = JSON.stringify(updatedGraph);
      if (updatedJson === lastSyncedReactFlowRef.current) {
        return;
      }
      
      isSyncingRef.current = true;
      lastSyncedReactFlowRef.current = updatedJson;
      
      setGraph(updatedGraph);
      
      // Note: History is NOT saved here during drag - it's saved once at drag start
      
      // Reset sync flag
      setTimeout(() => {
        isSyncingRef.current = false;
      }, 0);
    }
  }, [nodes, edges]); // Removed 'graph' and 'setGraph' from dependencies

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
    isSyncingRef,
    skipNextRerouteRef,
    getAllExistingIds,
  });

  // Handle Shift+Drag lasso selection
  const [isLassoSelecting, setIsLassoSelecting] = useState(false);
  const [lassoStart, setLassoStart] = useState<{ x: number; y: number } | null>(null);
  const [lassoEnd, setLassoEnd] = useState<{ x: number; y: number } | null>(null);
  const [isShiftHeld, setIsShiftHeld] = useState(false);
  const lassoCompletedRef = useRef(false); // Prevent double completion

  // Track Shift key state and handle mouse events globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftHeld(true);
      }
      
      // Escape: revert to pointer mode when a non-pointer tool is active
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement;
        const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.closest('.monaco-editor');
        if (!inInput && activeElementTool && activeElementTool !== 'select') {
          e.preventDefault();
          onClearElementTool?.();
          return;
        }
      }

      // Handle Delete key for selected elements
      if (e.key === 'Delete' || e.key === 'Backspace') {
        console.log(`[GraphCanvas ${tabId}] Delete key detected`);
        
        // FIRST: Check if user is typing in a form field or Monaco editor
        // (Exception: inputs with data-allow-global-shortcuts="true" should pass through for CTRL+Z/CTRL+Y only)
        const target = e.target as HTMLElement;
        const allowGlobalShortcuts = target.getAttribute?.('data-allow-global-shortcuts') === 'true';
        
        if (!allowGlobalShortcuts && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.closest('.monaco-editor'))) {
          console.log(`[GraphCanvas ${tabId}] Delete ignored - focus in input field without global shortcuts flag`);
          return; // Let the input field handle the Delete/Backspace
        }
        
        // SECOND: If not in an input, check for selected elements
        const selectedNodes = nodes.filter(n => n.selected);
        const selectedEdges = edges.filter(e => e.selected);
        
        console.log(`[GraphCanvas ${tabId}] Delete key pressed, selected nodes:`, selectedNodes.length, 'selected edges:', selectedEdges.length);
        
        // If there are selected nodes or edges, delete them
        if (selectedNodes.length > 0 || selectedEdges.length > 0) {
          e.preventDefault();
          console.log(`[GraphCanvas ${tabId}] Calling deleteSelected`);
          deleteSelected();
          return;
        }
        
        console.log(`[GraphCanvas ${tabId}] No selected elements to delete`);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftHeld(false);
        setIsLassoSelecting(false);
        setLassoStart(null);
        setLassoEnd(null);
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (isShiftHeld && e.target && (e.target as Element).closest('.react-flow')) {
        e.preventDefault();
        e.stopPropagation();
        
        // Store viewport coordinates (for screenToFlowPosition conversion)
        setIsLassoSelecting(true);
        setLassoStart({ x: e.clientX, y: e.clientY });
        setLassoEnd({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (isLassoSelecting && lassoStart) {
        e.preventDefault();
        e.stopPropagation();
        
        // Store viewport coordinates (for screenToFlowPosition conversion)
        setLassoEnd({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (isLassoSelecting && lassoStart && lassoEnd && !lassoCompletedRef.current) {
        lassoCompletedRef.current = true; // Prevent double execution
        e.preventDefault();
        e.stopPropagation();
        
        // Use ReactFlow's built-in coordinate conversion
        const flowStart = screenToFlowPosition({ x: lassoStart.x, y: lassoStart.y });
        const flowEnd = screenToFlowPosition({ x: lassoEnd.x, y: lassoEnd.y });
        
        const flowStartX = flowStart.x;
        const flowStartY = flowStart.y;
        const flowEndX = flowEnd.x;
        const flowEndY = flowEnd.y;
        
        const lassoRect = {
          left: Math.min(flowStartX, flowEndX),
          top: Math.min(flowStartY, flowEndY),
          right: Math.max(flowStartX, flowEndX),
          bottom: Math.max(flowStartY, flowEndY)
        };

        const selectedNodes = nodes.filter(node => {
          const rect = toNodeRect(node, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT);
          const nodeRect = {
            left: rect.x,
            top: rect.y,
            right: rect.x + rect.width,
            bottom: rect.y + rect.height,
          };

          return !(nodeRect.right < lassoRect.left ||
                   nodeRect.left > lassoRect.right ||
                   nodeRect.bottom < lassoRect.top ||
                   nodeRect.top > lassoRect.bottom);
        });


        const selectedNodeIds = new Set(selectedNodes.map(n => n.id));
        const addToExisting = e.ctrlKey || e.metaKey;
        
        setNodes(prevNodes => 
          prevNodes.map(n => ({ 
            ...n, 
            selected: selectedNodeIds.has(n.id) || (addToExisting && !!n.selected)
          }))
        );
        
        // Reset lasso state after a delay to allow selection to settle
        setTimeout(() => {
          setIsLassoSelecting(false);
          setLassoStart(null);
          setLassoEnd(null);
          lassoCompletedRef.current = false; // Reset for next lasso
        }, 100);
      } else {
        setIsLassoSelecting(false);
        setLassoStart(null);
        setLassoEnd(null);
        lassoCompletedRef.current = false;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('mousemove', handleMouseMove, true);
    window.addEventListener('mouseup', handleMouseUp, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('mousemove', handleMouseMove, true);
      window.removeEventListener('mouseup', handleMouseUp, true);
    };
  }, [isShiftHeld, isLassoSelecting, lassoStart, lassoEnd, nodes, setNodes, edges, deleteSelected, tabId, activeElementTool, onClearElementTool]);


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

  // Track whether the current drag actually moved the node (vs. a simple click)
  const hasNodeMovedRef = useRef(false);

  // Group drag state for containers
  const containerDragContainedRef = useRef<Set<string> | null>(null);
  const containerDragLastPosRef = useRef<{ x: number; y: number } | null>(null);

  // Handle node drag start - set flag and start failsafe timeout
  const onNodeDragStart = useCallback((_event: any, _node: any) => {
    hasNodeMovedRef.current = false;
    resetHelperLines();

    // Block Graph→ReactFlow sync during drag to prevent interruption
    isDraggingNodeRef.current = true;
    setIsDraggingNode(true);

    // Track the specific analysis being dragged so SelectionConnectors
    // can show connectors/shapes/halos for it (same codepath as selection)
    if (_node.id?.startsWith('analysis-')) {
      setDraggedAnalysisId(_node.id.replace('analysis-', ''));
    } else {
      setDraggedAnalysisId(null);
    }

    // Container group drag: snapshot contained objects
    if (_node.id?.startsWith('container-')) {
      const containerPos = _node.position || { x: 0, y: 0 };
      const containerW = (_node as any).measured?.width ?? _node.width ?? (typeof _node.style?.width === 'number' ? _node.style.width : 400);
      const containerH = (_node as any).measured?.height ?? _node.height ?? (typeof _node.style?.height === 'number' ? _node.style.height : 300);

      console.log(`[GroupDrag] Container ${_node.id}: pos=(${containerPos.x},${containerPos.y}) size=(${containerW}x${containerH}) measured=${JSON.stringify((_node as any).measured)} style.w=${_node.style?.width} style.h=${_node.style?.height} width=${_node.width} height=${_node.height}`);

      const CONTAIN_TOLERANCE = 10;
      const isFullyInside = (n: any, px: number, py: number, pw: number, ph: number) => {
        const nw = (n as any).measured?.width ?? n.width ?? (typeof n.style?.width === 'number' ? n.style.width : (n.id?.startsWith('container-') ? 400 : n.id?.startsWith('postit-') ? 200 : DEFAULT_NODE_WIDTH));
        const nh = (n as any).measured?.height ?? n.height ?? (typeof n.style?.height === 'number' ? n.style.height : (n.id?.startsWith('container-') ? 300 : n.id?.startsWith('postit-') ? 150 : DEFAULT_NODE_HEIGHT));
        const nx = n.position?.x ?? 0;
        const ny = n.position?.y ?? 0;
        const inside = nx >= (px - CONTAIN_TOLERANCE) && ny >= (py - CONTAIN_TOLERANCE) &&
               (nx + nw) <= (px + pw + CONTAIN_TOLERANCE) && (ny + nh) <= (py + ph + CONTAIN_TOLERANCE);
        if (!n.id?.startsWith('container-') && !n.id?.startsWith('postit-') && !n.id?.startsWith('analysis-')) {
          console.log(`[GroupDrag]   Node ${n.id}: pos=(${nx},${ny}) size=(${nw}x${nh}) endAt=(${nx+nw},${ny+nh}) inside=${inside} measured=${JSON.stringify((n as any).measured)} width=${n.width}`);
        }
        return inside;
      };

      // Recursively collect all contained objects (nodes, postits, nested containers)
      const contained = new Set<string>();
      const selectedIds = new Set(nodes.filter(n => n.selected).map(n => n.id));

      const collectContained = (parentId: string, px: number, py: number, pw: number, ph: number) => {
        for (const n of nodes) {
          if (n.id === parentId || contained.has(n.id) || selectedIds.has(n.id)) continue;
          if (isFullyInside(n, px, py, pw, ph)) {
            contained.add(n.id);
            // Recurse into nested containers
            if (n.id?.startsWith('container-')) {
              const nw = (n as any).measured?.width ?? n.style?.width ?? 400;
              const nh = (n as any).measured?.height ?? n.style?.height ?? 300;
              collectContained(n.id, n.position?.x ?? 0, n.position?.y ?? 0, nw, nh);
            }
          }
        }
      };

      collectContained(_node.id, containerPos.x, containerPos.y, containerW, containerH);
      containerDragContainedRef.current = contained.size > 0 ? contained : null;
      containerDragLastPosRef.current = { x: containerPos.x, y: containerPos.y };
    } else {
      containerDragContainedRef.current = null;
      containerDragLastPosRef.current = null;
    }

    // Failsafe: clear drag flag if it somehow gets stuck
    if (dragTimeoutRef.current) {
      clearTimeout(dragTimeoutRef.current);
    }
    dragTimeoutRef.current = window.setTimeout(() => {
      if (isDraggingNodeRef.current) {
        console.log('[GraphCanvas] Drag timeout elapsed, clearing drag flag (failsafe)');
        isDraggingNodeRef.current = false;
        setIsDraggingNode(false);
        setDraggedAnalysisId(null);
      }
      dragTimeoutRef.current = null;
    }, 5000);
  }, [nodes, resetHelperLines]);

  // Mark drag as "moved" and apply group drag delta for containers
  const onNodeDrag = useCallback((_event: any, draggedNode: any) => {
    if (!hasNodeMovedRef.current) {
      hasNodeMovedRef.current = true;
    }

    // Container group drag: move contained objects by delta
    if (containerDragContainedRef.current && containerDragLastPosRef.current) {
      const dx = (draggedNode.position?.x ?? 0) - containerDragLastPosRef.current.x;
      const dy = (draggedNode.position?.y ?? 0) - containerDragLastPosRef.current.y;
      containerDragLastPosRef.current = { x: draggedNode.position?.x ?? 0, y: draggedNode.position?.y ?? 0 };

      if (dx !== 0 || dy !== 0) {
        const containedIds = containerDragContainedRef.current;
        setNodes(nds => nds.map(n => {
          if (containedIds.has(n.id)) {
            return { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } };
          }
          return n;
        }));
      }
    }
  }, [setNodes]);

  // Handle node drag stop - save final position to history
  const onNodeDragStop = useCallback(() => {
    // Clear snap-to-guide state and rebuild index with final positions
    resetHelperLines();
    rebuildSnapIndex(nodes);

    // Clear container group drag state
    containerDragContainedRef.current = null;
    containerDragLastPosRef.current = null;
    // Keep drag flag set - it will be cleared by the sync effect when it takes the fast path
    // Use double requestAnimationFrame to ensure ReactFlow has finished updating node positions
    // and React has re-rendered before we sync to graph store and trigger edge recalculation
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setDraggedAnalysisId(null);

        // Only sync positions & save history if the node actually moved.
        if (hasNodeMovedRef.current && graph && nodes.length > 0) {
          const updatedGraph = fromFlow(nodes, edges, graph);
          if (updatedGraph) {
            const updatedJson = JSON.stringify(updatedGraph);
            // Only update if positions actually changed
            if (updatedJson !== lastSyncedReactFlowRef.current) {
              console.log(`🎯 Syncing node positions to graph store after drag`);
              isSyncingRef.current = true;
              lastSyncedReactFlowRef.current = updatedJson;
              // Keep isDraggingNodeRef.current = true - sync effect will clear it after taking fast path
              setGraph(updatedGraph);
              // Clear syncing flag and drag state AFTER the sync render settles,
              // so edge components still see isDraggingNode=true and suppress hover previews
              setTimeout(() => {
                isSyncingRef.current = false;
                setIsDraggingNode(false);
              }, 0);
            } else {
              // No position change, clear flags immediately
              isDraggingNodeRef.current = false;
              setIsDraggingNode(false);
            }
          } else {
            // No graph update, clear flags immediately
            isDraggingNodeRef.current = false;
            setIsDraggingNode(false);
          }

          // Save the FINAL position to history after the ReactFlow→Store sync completes
          // Use setTimeout to ensure sync completes first
          setTimeout(() => {
            saveHistoryState('Move node');
          }, 0);
        } else {
          // Click-only (no movement) - just clear drag flag, no graph update or history entry
          isDraggingNodeRef.current = false;
          setIsDraggingNode(false);
        }
      });
    });
  }, [saveHistoryState, graph, nodes, edges, setGraph, resetHelperLines, rebuildSnapIndex]);

  // Cleanup drag timeout on unmount
  useEffect(() => {
    return () => {
      if (dragTimeoutRef.current) {
        clearTimeout(dragTimeoutRef.current);
        dragTimeoutRef.current = null;
      }
    };
  }, []);

  // Add new node (core mutation in canvas/creationTools.ts)
  const addNode = useCallback(() => {
    if (!graph) return;
    const viewportCenter = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const { graph: nextGraph, newUuid } = createNodeInGraph(graph, viewportCenter);
    setGraph(nextGraph);
    if (typeof saveHistoryState === 'function') {
      saveHistoryState('Add node', newUuid);
    }
    setTimeout(() => {
      setNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === newUuid })));
      onSelectedNodeChange(newUuid);
    }, 50);
  }, [graph, setGraph, onSelectedNodeChange, screenToFlowPosition, saveHistoryState, setNodes]);

  // Expose addNode function to parent component via ref
  useEffect(() => {
    if (onAddNodeRef) {
      onAddNodeRef.current = addNode;
    }
  }, [addNode, onAddNodeRef]);


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
    sankeyLayoutInProgressRef.current = true;
    effectsCooldownUntilRef.current = performance.now() + 800;

    const { positions } = computeSankeyLayoutCore(nodes, edges);
    if (positions.size === 0) return;

    // Flag: layout in progress to suppress cascading side-effects
    sankeyLayoutInProgressRef.current = true;

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
    skipSankeyNodeSizingRef.current = true;

    setGraph(nextGraph);
    saveHistoryState('Sankey auto-layout', undefined, undefined);

    // End layout without forcing reroute; clear flag after a short delay + cooldown
    setTimeout(() => {
      sankeyLayoutInProgressRef.current = false;
      effectsCooldownUntilRef.current = performance.now() + 500;
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
  const onPaneContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    
    // Get the flow position (position in the canvas coordinate system)
    const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      flowX: flowPosition.x,
      flowY: flowPosition.y
    });
  }, [screenToFlowPosition]);

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

  // Close context menus on any click
  useEffect(() => {
    if (contextMenu || nodeContextMenu || postitContextMenu || containerContextMenu || analysisContextMenu || multiSelectContextMenu || edgeContextMenu) {
      const handleClick = () => {
        setContextMenu(null);
        setNodeContextMenu(null);
        setPostitContextMenu(null);
        setContainerContextMenu(null);
        setAnalysisContextMenu(null);
        setMultiSelectContextMenu(null);
        setEdgeContextMenu(null);
        setContextMenuLocalData(null);
      };
      // Delay adding the listener to avoid catching the same click that opened the menu
      const timeoutId = setTimeout(() => {
        document.addEventListener('click', handleClick);
      }, 0);

      return () => {
        clearTimeout(timeoutId);
        document.removeEventListener('click', handleClick);
      };
    }
  }, [contextMenu, nodeContextMenu, multiSelectContextMenu, edgeContextMenu]);

  // Add node at specific position (core mutation in canvas/creationTools.ts)
  const addNodeAtPosition = useCallback((x: number, y: number) => {
    if (!graph) return;
    const { graph: nextGraph, newUuid } = createNodeInGraph(graph, { x, y });
    setGraph(nextGraph);
    if (typeof saveHistoryState === 'function') {
      saveHistoryState('Add node', newUuid);
    }
    setContextMenu(null);
    setTimeout(() => {
      setNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === newUuid })));
      onSelectedNodeChange(newUuid);
    }, 50);
  }, [graph, setGraph, saveHistoryState, setNodes, onSelectedNodeChange]);

  // Add post-it (core mutation in canvas/creationTools.ts)
  const addPostitAtPosition = useCallback((x: number, y: number, w?: number, h?: number) => {
    if (!graph) return;
    const { graph: nextGraph, newId } = createPostitInGraph(graph, { x, y }, { width: w, height: h });
    setGraphDirect(nextGraph);
    saveHistoryState('Add post-it');
    setContextMenu(null);
    autoEditPostitIdRef.current = newId;
    onSelectedNodeChange(null);
    onSelectedEdgeChange(null);
    onSelectedAnnotationChange?.(newId, 'postit');
  }, [graph, setGraphDirect, saveHistoryState, onSelectedNodeChange, onSelectedEdgeChange, onSelectedAnnotationChange]);

  const addPostit = useCallback(() => {
    const centre = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    addPostitAtPosition(centre.x, centre.y);
  }, [screenToFlowPosition, addPostitAtPosition]);

  // Add container (core mutation in canvas/creationTools.ts)
  const addContainerAtPosition = useCallback((x: number, y: number, w?: number, h?: number) => {
    if (!graph) return;
    const { graph: nextGraph, newId } = createContainerInGraph(graph, { x, y }, { width: w, height: h });
    setGraphDirect(nextGraph);
    saveHistoryState('Add container');
    setContextMenu(null);
    onSelectedNodeChange(null);
    onSelectedEdgeChange(null);
    onSelectedAnnotationChange?.(newId, 'container');
  }, [graph, setGraphDirect, saveHistoryState, onSelectedNodeChange, onSelectedEdgeChange, onSelectedAnnotationChange]);

  useEffect(() => {
    if (onAddPostitRef) {
      onAddPostitRef.current = addPostit;
    }
  }, [addPostit, onAddPostitRef]);

  const addContainer = useCallback(() => {
    const centre = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    addContainerAtPosition(centre.x, centre.y);
  }, [screenToFlowPosition, addContainerAtPosition]);

  useEffect(() => {
    if (onAddContainerRef) {
      onAddContainerRef.current = addContainer;
    }
  }, [addContainer, onAddContainerRef]);

  // Add canvas analysis (core mutation in canvas/creationTools.ts)
  const addCanvasAnalysisAtPosition = useCallback((x: number, y: number, dragData: any) => {
    if (!graph) return;
    const { graph: nextGraph, analysisId, analysis } = createCanvasAnalysisInGraph(graph, { x, y }, dragData);
    if (dragData.analysisResult) {
      canvasAnalysisTransientCache.set(analysisId, dragData.analysisResult);
    }
    autoSelectAnalysisIdRef.current = analysisId;
    setGraphDirect(nextGraph as any);
    saveHistoryState('Pin analysis to canvas');
    setContextMenu(null);
    onSelectedNodeChange(null);
    onSelectedEdgeChange(null);
    onSelectedAnnotationChange?.(analysisId, 'canvasAnalysis');
  }, [graph, setGraphDirect, saveHistoryState, onSelectedNodeChange, onSelectedEdgeChange, onSelectedAnnotationChange]);

  const startPinnedCanvasAnalysis = useCallback((payload?: any) => {
    pendingAnalysisPayload = payload || {};
    setActiveElementTool('new-analysis');
  }, [setActiveElementTool]);

  // Start "Add chart" flow (DSL construction in canvas/creationTools.ts)
  const startAddChart = useCallback((detail?: { contextNodeIds?: string[]; contextEdgeIds?: string[] }) => {
    const ctxNodeIds: string[] = detail?.contextNodeIds || [];
    const ctxEdgeIds: string[] = detail?.contextEdgeIds || [];
    pendingAnalysisPayload = buildAddChartPayload(
      graph, nodes, edges, ctxNodeIds, ctxEdgeIds, isCanvasObjectNode, getContainedConversionNodeIds,
    );
    setActiveElementTool('new-analysis');
  }, [nodes, edges, isCanvasObjectNode, graph, setActiveElementTool]);

  // Listen for 'dagnet:pinAnalysisToCanvas' event — enters draw mode with a pre-filled recipe
  useEffect(() => {
    const handler = (e: CustomEvent) => {
      if (tabId !== effectiveActiveTabId) return;
      startPinnedCanvasAnalysis(e.detail);
    };
    window.addEventListener('dagnet:pinAnalysisToCanvas', handler as any);
    return () => window.removeEventListener('dagnet:pinAnalysisToCanvas', handler as any);
  }, [startPinnedCanvasAnalysis, tabId, effectiveActiveTabId]);

  // Listen for 'dagnet:pinAnalysisAtScreenPosition' — instantly pins at a given screen position
  // Used by HoverAnalysisPreview to persist the preview card as a canvas object in-place.
  useEffect(() => {
    const handler = (e: CustomEvent) => {
      if (tabId !== effectiveActiveTabId) return;
      const { screenX, screenY, dragData } = e.detail;
      const flowPos = screenToFlowPosition({ x: screenX, y: screenY });
      addCanvasAnalysisAtPosition(flowPos.x, flowPos.y, dragData);
    };
    window.addEventListener('dagnet:pinAnalysisAtScreenPosition', handler as any);
    return () => window.removeEventListener('dagnet:pinAnalysisAtScreenPosition', handler as any);
  }, [addCanvasAnalysisAtPosition, screenToFlowPosition, tabId, effectiveActiveTabId]);

  // Listen for 'dagnet:addAnalysis' event — captures selection DSL, then enters draw mode.
  // Analysis type is always left empty so the canvas node shows the icon picker.
  // The user explicitly chooses the analysis type after placing the chart on canvas.
  //
  // Context menus pass detail.contextNodeIds (human-readable) / detail.contextEdgeIds (UUIDs)
  // so right-clicking a node/edge and choosing "Add chart" works even without a prior selection.
  useEffect(() => {
    const handler = (e: Event) => {
      if (tabId !== effectiveActiveTabId) return;
      startAddChart((e as CustomEvent).detail || {});
    };
    window.addEventListener('dagnet:addAnalysis', handler as any);
    return () => window.removeEventListener('dagnet:addAnalysis', handler as any);
  }, [startAddChart, tabId, effectiveActiveTabId]);

  // Drag-to-draw state for creation modes (new-postit, new-container)
  const drawStartRef = useRef<{ screenX: number; screenY: number; flowX: number; flowY: number; tool: string } | null>(null);
  const [drawRect, setDrawRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const DRAW_TOOLS = new Set(['new-postit', 'new-container', 'new-analysis']);

  const onPaneMouseDown = useCallback((event: React.PointerEvent) => {
    if (!activeElementTool || !DRAW_TOOLS.has(activeElementTool)) return;
    const target = event.target as HTMLElement;
    if (target.closest('.react-flow__node') || target.closest('.react-flow__edge')) return;
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    drawStartRef.current = { screenX: event.clientX, screenY: event.clientY, flowX: flowPos.x, flowY: flowPos.y, tool: activeElementTool };
    setDrawRect(null);
  }, [activeElementTool, screenToFlowPosition]);

  const onPaneMouseMove = useCallback((event: React.PointerEvent) => {
    if (!drawStartRef.current) return;
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const sx = drawStartRef.current.flowX;
    const sy = drawStartRef.current.flowY;
    setDrawRect({
      x: Math.min(sx, flowPos.x),
      y: Math.min(sy, flowPos.y),
      w: Math.abs(flowPos.x - sx),
      h: Math.abs(flowPos.y - sy),
    });
  }, [screenToFlowPosition]);

  const onPaneMouseUp = useCallback((event: React.PointerEvent) => {
    if (!drawStartRef.current) return;
    const tool = drawStartRef.current.tool;
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const sx = drawStartRef.current.flowX;
    const sy = drawStartRef.current.flowY;
    const w = Math.abs(flowPos.x - sx);
    const h = Math.abs(flowPos.y - sy);
    const x = Math.min(sx, flowPos.x);
    const y = Math.min(sy, flowPos.y);
    drawStartRef.current = null;
    setDrawRect(null);
    if (tool === 'new-postit') {
      addPostitAtPosition(x, y, w, h);
    } else if (tool === 'new-container') {
      addContainerAtPosition(x, y, w, h);
    } else if (tool === 'new-analysis') {
      const payload = pendingAnalysisPayload;
      pendingAnalysisPayload = null;
      addCanvasAnalysisAtPosition(x, y, { ...(payload || {}), drawWidth: w, drawHeight: h });
    }
    onClearElementTool?.();
  }, [screenToFlowPosition, addPostitAtPosition, addContainerAtPosition, addCanvasAnalysisAtPosition, onClearElementTool]);

  const onPaneClick = useCallback((event: React.MouseEvent) => {
    if (activeElementTool === 'new-node') {
      const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addNodeAtPosition(flowPosition.x, flowPosition.y);
      onClearElementTool?.();
    } else if (activeElementTool === 'new-container') {
      const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addContainerAtPosition(flowPosition.x, flowPosition.y);
      onClearElementTool?.();
    }
  }, [activeElementTool, screenToFlowPosition, addNodeAtPosition, addContainerAtPosition, onClearElementTool]);

  // Paste node at specific position (core mutation in canvas/creationTools.ts)
  const pasteNodeAtPosition = useCallback(async (x: number, y: number) => {
    if (!graph) return;
    if (!copiedNode) { toast.error('No node copied'); return; }
    const nodeId = copiedNode.objectId;
    const file = fileRegistry.getFile(`node-${nodeId}`);
    if (!file) { toast.error(`Node file not found: ${nodeId}`); return; }
    const { graph: nextGraph, newUuid } = createNodeFromFileInGraph(graph, nodeId, file.data?.label || nodeId, { x, y });
    setGraph(nextGraph);
    if (typeof saveHistoryState === 'function') { saveHistoryState('Paste node', newUuid); }
    setContextMenu(null);
    setTimeout(async () => {
      try {
        await dataOperationsService.getNodeFromFile({ nodeId, graph: nextGraph, setGraph: setGraph as any, targetNodeUuid: newUuid });
        toast.success(`Pasted node: ${nodeId}`);
      } catch (error) {
        console.error('[GraphCanvas] Failed to get node from file:', error);
        toast.error('Failed to load node data from file');
      }
      setNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === newUuid })));
      onSelectedNodeChange(newUuid);
    }, 100);
  }, [graph, setGraph, copiedNode, saveHistoryState, setNodes, onSelectedNodeChange]);

  // Paste subgraph at specific position (from copy-paste clipboard)
  const pasteSubgraphAtPosition = useCallback(async (x: number, y: number) => {
    if (!graph) return;
    
    if (!copiedSubgraph) {
      toast.error('No subgraph copied');
      return;
    }
    
    // Calculate offset from first item's position to target position
    const firstNode = copiedSubgraph.nodes[0];
    const firstPostit = copiedSubgraph.postits?.[0];
    const firstContainer = copiedSubgraph.containers?.[0];
    const refX = firstNode?.layout?.x ?? firstPostit?.x ?? firstContainer?.x ?? 0;
    const refY = firstNode?.layout?.y ?? firstPostit?.y ?? firstContainer?.y ?? 0;
    const offsetX = x - refX;
    const offsetY = y - refY;
    
    // Import updateManager dynamically to avoid circular dependencies
    const { updateManager } = await import('../services/UpdateManager');
    
    const result = updateManager.pasteSubgraph(
      graph,
      copiedSubgraph.nodes,
      copiedSubgraph.edges,
      { x: offsetX, y: offsetY },
      copiedSubgraph.postits,
      { containers: copiedSubgraph.containers, canvasAnalyses: copiedSubgraph.canvasAnalyses }
    );
    
    setGraph(result.graph);
    
    if (typeof saveHistoryState === 'function') {
      saveHistoryState('Paste subgraph');
    }
    setContextMenu(null);
    
    const parts: string[] = [];
    if (result.pastedNodeUuids.length > 0) {
      parts.push(`${result.pastedNodeUuids.length} node${result.pastedNodeUuids.length !== 1 ? 's' : ''}`);
    }
    if (result.pastedEdgeUuids.length > 0) {
      parts.push(`${result.pastedEdgeUuids.length} edge${result.pastedEdgeUuids.length !== 1 ? 's' : ''}`);
    }
    const totalCanvasObjects = Object.values(result.pastedCanvasObjectIds).reduce((s, a) => s + a.length, 0);
    if (totalCanvasObjects > 0) {
      parts.push(`${totalCanvasObjects} canvas object${totalCanvasObjects !== 1 ? 's' : ''}`);
    }
    toast.success(`Pasted ${parts.join(' and ')}`);
    
    // Select the pasted items (nodes, postits, containers)
    setTimeout(() => {
      const pastedUuidSet = new Set(result.pastedNodeUuids);
      const pastedCanvasRfIds = new Set([
        ...result.pastedPostitIds.map(id => `postit-${id}`),
        ...(result.pastedCanvasObjectIds['containers'] || []).map(id => `container-${id}`),
      ]);
      setNodes((nodes) => 
        nodes.map((node) => ({
          ...node,
          selected: pastedUuidSet.has(node.id) || pastedCanvasRfIds.has(node.id)
        }))
      );
      if (result.pastedNodeUuids.length > 0) {
        onSelectedNodeChange(result.pastedNodeUuids[0]);
      } else if (result.pastedPostitIds.length > 0) {
        onSelectedAnnotationChange?.(result.pastedPostitIds[0], 'postit');
      }
    }, 100);
  }, [graph, setGraph, copiedSubgraph, saveHistoryState, setNodes, onSelectedNodeChange, onSelectedAnnotationChange]);

  // Drop node at specific position (core mutation in canvas/creationTools.ts)
  const dropNodeAtPosition = useCallback(async (nodeId: string, x: number, y: number) => {
    if (!graph) return;
    const file = fileRegistry.getFile(`node-${nodeId}`);
    if (!file) { toast.error(`Node file not found: ${nodeId}`); return; }
    const { graph: nextGraph, newUuid } = createNodeFromFileInGraph(graph, nodeId, file.data?.label || nodeId, { x, y });
    setGraph(nextGraph);
    if (typeof saveHistoryState === 'function') { saveHistoryState('Drop node', newUuid); }
    setTimeout(async () => {
      try {
        await dataOperationsService.getNodeFromFile({ nodeId, graph: nextGraph, setGraph: setGraph as any, targetNodeUuid: newUuid });
        toast.success(`Added node: ${nodeId}`);
      } catch (error) {
        console.error('[GraphCanvas] Failed to get node from file:', error);
        toast.error('Failed to load node data from file');
      }
      setNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === newUuid })));
      onSelectedNodeChange(newUuid);
    }, 100);
  }, [graph, setGraph, saveHistoryState, setNodes, onSelectedNodeChange]);

  // Handle drag over for drop zone
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  // Handle drop from Navigator
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    
    try {
      const jsonData = e.dataTransfer.getData('application/json');
      if (!jsonData) return;
      
      const dragData = JSON.parse(jsonData);
      if (dragData.type !== 'dagnet-drag') return;
      
      // Get drop position in flow coordinates
      const position = screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });
      
      if (dragData.objectType === 'node') {
        dropNodeAtPosition(dragData.objectId, position.x, position.y);
      } else if (dragData.objectType === 'new-node') {
        addNodeAtPosition(position.x, position.y);
      } else if (dragData.objectType === 'new-postit') {
        addPostitAtPosition(position.x, position.y);
      } else if (dragData.objectType === 'new-container') {
        addContainerAtPosition(position.x, position.y);
      } else if (dragData.objectType === 'canvas-analysis') {
        addCanvasAnalysisAtPosition(position.x, position.y, dragData);
      } else if (dragData.objectType === 'new-analysis') {
        addCanvasAnalysisAtPosition(position.x, position.y, {});
      } else if (dragData.objectType === 'parameter') {
        toast('Drop parameters onto an edge to attach them');
      }
    } catch (error) {
      console.error('[GraphCanvas] Drop error:', error);
    }
  }, [screenToFlowPosition, dropNodeAtPosition, addNodeAtPosition, addPostitAtPosition, addContainerAtPosition, addCanvasAnalysisAtPosition]);

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: any) => {
    event.preventDefault();
    event.stopPropagation();

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
  }, [nodes, isCanvasObjectNode]);

  // Shared: open edge context menu by edge ID (used by real right-click and E2E hooks)
  const openEdgeContextMenuById = useCallback((edgeId: string, clientX: number, clientY: number) => {
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
  }, [graph, onSelectedEdgeChange]);

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
        isInSlowPathRebuild: isInSlowPathRebuildRef.current,
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
      
      {/* Context Menu */}
      {contextMenu && (
        <div
          className="dagnet-popup"
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); addNodeAtPosition(contextMenu.flowX, contextMenu.flowY); setContextMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Plus size={14} />
            Add node
          </div>
          <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); setActiveElementTool('new-postit'); setContextMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StickyNote size={14} />
            Add post-it
          </div>
          <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); setActiveElementTool('new-container'); setContextMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Square size={14} />
            Add container
          </div>
          <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); startAddChart(); setContextMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <BarChart3 size={14} />
            Add chart
          </div>
          <div className="dagnet-popup-divider" />
          {copiedNode && (
            <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); pasteNodeAtPosition(contextMenu.flowX, contextMenu.flowY); setContextMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Clipboard size={14} />
              Paste node: {copiedNode.objectId}
            </div>
          )}
          {copiedSubgraph && (
            <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); pasteSubgraphAtPosition(contextMenu.flowX, contextMenu.flowY); setContextMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Clipboard size={14} />
              Paste ({[
                copiedSubgraph.nodes.length > 0 && `${copiedSubgraph.nodes.length} node${copiedSubgraph.nodes.length !== 1 ? 's' : ''}`,
                copiedSubgraph.edges.length > 0 && `${copiedSubgraph.edges.length} edge${copiedSubgraph.edges.length !== 1 ? 's' : ''}`,
                (copiedSubgraph.postits?.length ?? 0) > 0 && `${copiedSubgraph.postits!.length} post-it${copiedSubgraph.postits!.length !== 1 ? 's' : ''}`,
              ].filter(Boolean).join(', ')})
            </div>
          )}
          {nodes.length > 0 && (
            <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('dagnet:selectAllNodes')); setContextMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckSquare size={14} />
              Select All
            </div>
          )}
          {(copiedNode || copiedSubgraph || nodes.length > 0) && <div className="dagnet-popup-divider" />}
          <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); setContextMenu(null); toggleDashboardMode({ updateUrl: true }); }} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {isDashboardMode ? <MonitorOff size={14} /> : <Monitor size={14} />}
            {isDashboardMode ? 'Exit dashboard mode' : 'Enter dashboard mode'}
          </div>
          {tabId && (
            <div className="dagnet-popup-item" onClick={async (e) => { e.stopPropagation(); setContextMenu(null); await tabOperations.closeTab(tabId); }} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <X size={14} />
              Close tab
            </div>
          )}
        </div>
      )}
      
      {/* Post-It Context Menu */}
      {postitContextMenu && graph && (() => {
        const postit = graph.postits?.find((p: any) => p.id === postitContextMenu.postitId);
        if (!postit) return null;
        const postitCount = (graph.postits?.length ?? 0) + (graph.canvasAnalyses?.length ?? 0);
        return (
          <PostItContextMenu
            x={postitContextMenu.x}
            y={postitContextMenu.y}
            postitId={postitContextMenu.postitId}
            currentColour={postit.colour}
            currentFontSize={postit.fontSize || 'M'}
            postitCount={postitCount}
            onUpdateColour={(id, colour) => {
              const nextGraph = structuredClone(graph);
              const p = nextGraph.postits?.find((p: any) => p.id === id);
              if (p) {
                p.colour = colour;
                if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                setGraph(nextGraph);
                saveHistoryState('Update post-it colour');
              }
            }}
            onUpdateFontSize={(id, fs) => {
              const nextGraph = structuredClone(graph);
              const p = nextGraph.postits?.find((p: any) => p.id === id);
              if (p) {
                p.fontSize = fs as 'S' | 'M' | 'L' | 'XL';
                if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                setGraph(nextGraph);
                saveHistoryState('Update post-it font size');
              }
            }}
            onBringToFront={(id) => {
              const nextGraph = structuredClone(graph);
              if (nextGraph.postits) {
                const idx = nextGraph.postits.findIndex((p: any) => p.id === id);
                if (idx >= 0) {
                  const [item] = nextGraph.postits.splice(idx, 1);
                  nextGraph.postits.push(item);
                  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                  setGraph(nextGraph);
                  saveHistoryState('Bring post-it to front');
                  reorderCanvasNodes('postit-', nextGraph.postits);
                }
              }
            }}
            onBringForward={(id) => {
              const nextGraph = structuredClone(graph);
              if (nextGraph.postits) {
                const idx = nextGraph.postits.findIndex((p: any) => p.id === id);
                if (idx >= 0 && idx < nextGraph.postits.length - 1) {
                  [nextGraph.postits[idx], nextGraph.postits[idx + 1]] = [nextGraph.postits[idx + 1], nextGraph.postits[idx]];
                  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                  setGraph(nextGraph);
                  saveHistoryState('Bring post-it forward');
                  reorderCanvasNodes('postit-', nextGraph.postits);
                }
              }
            }}
            onSendBackward={(id) => {
              const nextGraph = structuredClone(graph);
              if (nextGraph.postits) {
                const idx = nextGraph.postits.findIndex((p: any) => p.id === id);
                if (idx > 0) {
                  [nextGraph.postits[idx], nextGraph.postits[idx - 1]] = [nextGraph.postits[idx - 1], nextGraph.postits[idx]];
                  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                  setGraph(nextGraph);
                  saveHistoryState('Send post-it backward');
                  reorderCanvasNodes('postit-', nextGraph.postits);
                }
              }
            }}
            onSendToBack={(id) => {
              const nextGraph = structuredClone(graph);
              if (nextGraph.postits) {
                const idx = nextGraph.postits.findIndex((p: any) => p.id === id);
                if (idx >= 0) {
                  const [item] = nextGraph.postits.splice(idx, 1);
                  nextGraph.postits.unshift(item);
                  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                  setGraph(nextGraph);
                  saveHistoryState('Send post-it to back');
                  reorderCanvasNodes('postit-', nextGraph.postits);
                }
              }
            }}
            onCopy={(id) => {
              const p = graph.postits?.find((pi: any) => pi.id === id);
              if (p) {
                copySubgraph([], [], undefined, [p]);
              }
              setPostitContextMenu(null);
            }}
            onCut={(id) => {
              const p = graph.postits?.find((pi: any) => pi.id === id);
              if (p) {
                copySubgraph([], [], undefined, [p]);
                const nextGraph = structuredClone(graph);
                if (nextGraph.postits) {
                  nextGraph.postits = nextGraph.postits.filter((pi: any) => pi.id !== id);
                  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                  setGraph(nextGraph);
                  saveHistoryState('Cut post-it');
                  onSelectedAnnotationChange?.(null, null);
                }
              }
              setPostitContextMenu(null);
            }}
            onDelete={(id) => {
              const nextGraph = structuredClone(graph);
              if (nextGraph.postits) {
                nextGraph.postits = nextGraph.postits.filter((p: any) => p.id !== id);
                if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                setGraph(nextGraph);
                saveHistoryState('Delete post-it');
                onSelectedAnnotationChange?.(null, null);
              }
            }}
            onClose={() => setPostitContextMenu(null)}
          />
        );
      })()}

      {/* Container Context Menu */}
      {containerContextMenu && graph && (() => {
        const container = graph.containers?.find((c: any) => c.id === containerContextMenu.containerId);
        if (!container) return null;
        const containerCount = graph.containers?.length ?? 0;
        return (
          <ContainerContextMenu
            x={containerContextMenu.x}
            y={containerContextMenu.y}
            containerId={containerContextMenu.containerId}
            currentColour={container.colour}
            containerCount={containerCount}
            onUpdateColour={(id, colour) => {
              const nextGraph = structuredClone(graph);
              const c = nextGraph.containers?.find((c: any) => c.id === id);
              if (c) {
                c.colour = colour;
                if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                setGraph(nextGraph);
                saveHistoryState('Update container colour');
              }
              setContainerContextMenu(null);
            }}
            onBringToFront={(id) => {
              const nextGraph = structuredClone(graph);
              if (nextGraph.containers) {
                const idx = nextGraph.containers.findIndex((c: any) => c.id === id);
                if (idx >= 0 && idx < nextGraph.containers.length - 1) {
                  const [removed] = nextGraph.containers.splice(idx, 1);
                  nextGraph.containers.push(removed);
                  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                  setGraph(nextGraph);
                  saveHistoryState('Bring container to front');
                  reorderCanvasNodes('container-', nextGraph.containers);
                }
              }
              setContainerContextMenu(null);
            }}
            onBringForward={(id) => {
              const nextGraph = structuredClone(graph);
              if (nextGraph.containers) {
                const idx = nextGraph.containers.findIndex((c: any) => c.id === id);
                if (idx >= 0 && idx < nextGraph.containers.length - 1) {
                  [nextGraph.containers[idx], nextGraph.containers[idx + 1]] = [nextGraph.containers[idx + 1], nextGraph.containers[idx]];
                  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                  setGraph(nextGraph);
                  saveHistoryState('Bring container forward');
                  reorderCanvasNodes('container-', nextGraph.containers);
                }
              }
              setContainerContextMenu(null);
            }}
            onSendBackward={(id) => {
              const nextGraph = structuredClone(graph);
              if (nextGraph.containers) {
                const idx = nextGraph.containers.findIndex((c: any) => c.id === id);
                if (idx > 0) {
                  [nextGraph.containers[idx], nextGraph.containers[idx - 1]] = [nextGraph.containers[idx - 1], nextGraph.containers[idx]];
                  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                  setGraph(nextGraph);
                  saveHistoryState('Send container backward');
                  reorderCanvasNodes('container-', nextGraph.containers);
                }
              }
              setContainerContextMenu(null);
            }}
            onSendToBack={(id) => {
              const nextGraph = structuredClone(graph);
              if (nextGraph.containers) {
                const idx = nextGraph.containers.findIndex((c: any) => c.id === id);
                if (idx > 0) {
                  const [removed] = nextGraph.containers.splice(idx, 1);
                  nextGraph.containers.unshift(removed);
                  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                  setGraph(nextGraph);
                  saveHistoryState('Send container to back');
                  reorderCanvasNodes('container-', nextGraph.containers);
                }
              }
              setContainerContextMenu(null);
            }}
            onAddChart={(id) => {
              const c = graph.containers?.find((ci: any) => ci.id === id);
              if (c) {
                const containedIds = getContainedConversionNodeIds(c, nodes);
                const humanIds = containedIds.map(rfId => {
                  const n = nodes.find(nd => nd.id === rfId);
                  return n?.data?.id || rfId;
                });
                startAddChart({ contextNodeIds: humanIds });
              }
              setContainerContextMenu(null);
            }}
            onCopy={(id) => {
              const c = graph.containers?.find((ci: any) => ci.id === id);
              if (c && graph) {
                const contained = extractSubgraph({
                  selectedNodeIds: getContainedConversionNodeIds(c, nodes),
                  selectedCanvasObjectIds: {
                    containers: [id],
                    postits: (graph.postits || []).filter((p: any) =>
                      p.x >= c.x - 10 && p.y >= c.y - 10 && (p.x + p.width) <= (c.x + c.width + 10) && (p.y + p.height) <= (c.y + c.height + 10)
                    ).map((p: any) => p.id),
                  },
                  graph,
                  includeConnectedEdges: true,
                });
                copySubgraph(contained.nodes, contained.edges, undefined, contained.postits, { containers: contained.containers });
              }
              setContainerContextMenu(null);
            }}
            onCut={(id) => {
              const c = graph.containers?.find((ci: any) => ci.id === id);
              if (c && graph) {
                const containedNodeIds = getContainedConversionNodeIds(c, nodes);
                const containedPostitIds = (graph.postits || []).filter((p: any) =>
                  p.x >= c.x - 10 && p.y >= c.y - 10 && (p.x + p.width) <= (c.x + c.width + 10) && (p.y + p.height) <= (c.y + c.height + 10)
                ).map((p: any) => p.id);

                const contained = extractSubgraph({
                  selectedNodeIds: containedNodeIds,
                  selectedCanvasObjectIds: { containers: [id], postits: containedPostitIds },
                  graph,
                  includeConnectedEdges: true,
                });
                copySubgraph(contained.nodes, contained.edges, undefined, contained.postits, { containers: contained.containers });

                // Delete container + contained objects
                let nextGraph = structuredClone(graph);
                if (nextGraph.containers) nextGraph.containers = nextGraph.containers.filter((ci: any) => ci.id !== id);
                if (containedNodeIds.length > 0) {
                  const nodeSet = new Set(containedNodeIds);
                  nextGraph.nodes = nextGraph.nodes.filter((n: any) => !nodeSet.has(n.uuid));
                  nextGraph.edges = nextGraph.edges.filter((e: any) => !nodeSet.has(e.from) && !nodeSet.has(e.to));
                }
                if (containedPostitIds.length > 0) {
                  const pSet = new Set(containedPostitIds);
                  nextGraph.postits = (nextGraph.postits || []).filter((p: any) => !pSet.has(p.id));
                }
                if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                setGraph(nextGraph);
                saveHistoryState('Cut container');
                onSelectedAnnotationChange?.(null, null);
              }
              setContainerContextMenu(null);
            }}
            onDelete={(id) => {
              handleDeleteContainer(id);
            }}
            onClose={() => setContainerContextMenu(null)}
          />
        );
      })()}

      {/* Canvas Analysis Context Menu */}
      {analysisContextMenu && graph && (() => {
        const analysis = graph.canvasAnalyses?.find((a: any) => a.id === analysisContextMenu.analysisId);
        if (!analysis) return null;
        const analysisCount = (graph.canvasAnalyses?.length ?? 0) + (graph.postits?.length ?? 0);
        const cachedResult = canvasAnalysisResultCache.get(analysisContextMenu.analysisId);
        const effectiveChartKind = analysis.chart_kind || cachedResult?.semantics?.chart?.recommended || cachedResult?.analysis_type || undefined;
        const hiddenScenarios = new Set<string>((((analysis.display as any)?.hidden_scenarios) || []) as string[]);
        const visibleScenarioIds = analysis.mode === 'live'
          ? (tabId ? tabOperations.getScenarioState(tabId)?.visibleScenarioIds : null) || ['current']
          : (analysis.recipe?.scenarios || []).filter((s: any) => !hiddenScenarios.has(s.scenario_id)).map((s: any) => s.scenario_id);
        const currentTab = tabId ? tabs.find(t => t.id === tabId) : undefined;
        return (
          <CanvasAnalysisContextMenu
            x={analysisContextMenu.x}
            y={analysisContextMenu.y}
            analysisId={analysisContextMenu.analysisId}
            analysis={analysis}
            analysisCount={analysisCount}
            onUpdate={(id, updates) => {
              handleUpdateAnalysis(id, updates);
              setAnalysisContextMenu(null);
            }}
            effectiveChartKind={effectiveChartKind}
            display={analysis.display as Record<string, unknown> | undefined}
            onDisplayChange={(key, value) => {
              handleUpdateAnalysis(analysisContextMenu.analysisId, {
                display: { ...(analysis.display as Record<string, unknown> || {}), [key]: value },
              });
              setAnalysisContextMenu(null);
            }}
            hasCachedResult={!!cachedResult}
            availableAnalyses={analysisCtxAvailableTypes}
            onAnalysisTypeChange={(typeId) => {
              handleUpdateAnalysis(analysisContextMenu.analysisId, {
                recipe: { ...analysis.recipe, analysis: { ...analysis.recipe.analysis, analysis_type: typeId } },
                analysis_type_overridden: true,
              } as any);
              setAnalysisContextMenu(null);
            }}
            overlayActive={!!analysis.display?.show_subject_overlay}
            overlayColour={analysis.display?.subject_overlay_colour as string | undefined}
            onOverlayToggle={(active) => {
              const colour = analysis.display?.subject_overlay_colour || '#3b82f6';
              handleUpdateAnalysis(analysisContextMenu.analysisId, {
                display: { ...(analysis.display as Record<string, unknown> || {}), show_subject_overlay: active, ...(active ? { subject_overlay_colour: colour } : {}) },
              });
              setAnalysisContextMenu(null);
            }}
            onOverlayColourChange={(colour) => {
              if (colour) {
                handleUpdateAnalysis(analysisContextMenu.analysisId, {
                  display: { ...(analysis.display as Record<string, unknown> || {}), show_subject_overlay: true, subject_overlay_colour: colour },
                });
              } else {
                handleUpdateAnalysis(analysisContextMenu.analysisId, {
                  display: { ...(analysis.display as Record<string, unknown> || {}), show_subject_overlay: false, subject_overlay_colour: undefined },
                });
              }
              setAnalysisContextMenu(null);
            }}
            onOpenAsTab={cachedResult ? () => {
              chartOperationsService.openAnalysisChartTabFromAnalysis({
                chartKind: effectiveChartKind as any,
                analysisResult: cachedResult,
                scenarioIds: visibleScenarioIds,
                title: analysis.title || undefined,
                source: {
                  parent_tab_id: tabId,
                  parent_file_id: currentTab?.fileId,
                  query_dsl: analysis.recipe?.analysis?.analytics_dsl || undefined,
                  analysis_type: analysis.recipe?.analysis?.analysis_type || undefined,
                },
                render: {
                  chart_kind: analysis.chart_kind || undefined,
                  view_mode: analysis.view_mode || 'chart',
                  display: (analysis.display || {}) as Record<string, unknown>,
                },
              });
              setAnalysisContextMenu(null);
            } : undefined}
            onRefresh={() => {
              window.dispatchEvent(new CustomEvent('dagnet:canvasAnalysisRefresh', { detail: { analysisId: analysisContextMenu.analysisId } }));
              setAnalysisContextMenu(null);
            }}
            onCaptureFromTab={tabId && scenariosContext ? () => {
              const currentTab = tabs.find(t => t.id === tabId);
              const whatIfDSL = currentTab?.editorState?.whatIfDSL || null;
              return captureTabScenariosToRecipe({
                tabId,
                currentDSL: store.currentDSL || '',
                operations: tabOperations,
                scenariosContext: scenariosContext as any,
                whatIfDSL,
              });
            } : undefined}
            onUseAsCurrent={(dsl) => {
              store.setCurrentDSL(dsl);
              setAnalysisContextMenu(null);
            }}
            onEditScenarioDsl={(scenarioId) => {
              setCtxDslEditState({ analysisId: analysisContextMenu.analysisId, scenarioId });
              setAnalysisContextMenu(null);
            }}
            onBringToFront={(id) => {
              const nextGraph = structuredClone(graph);
              if (nextGraph.canvasAnalyses) {
                const idx = nextGraph.canvasAnalyses.findIndex((a: any) => a.id === id);
                if (idx >= 0 && idx < nextGraph.canvasAnalyses.length - 1) {
                  const [item] = nextGraph.canvasAnalyses.splice(idx, 1);
                  nextGraph.canvasAnalyses.push(item);
                  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                  setGraph(nextGraph);
                  saveHistoryState('Bring analysis to front');
                  reorderCanvasNodes('analysis-', nextGraph.canvasAnalyses);
                }
              }
              setAnalysisContextMenu(null);
            }}
            onBringForward={(id) => {
              const nextGraph = structuredClone(graph);
              if (nextGraph.canvasAnalyses) {
                const idx = nextGraph.canvasAnalyses.findIndex((a: any) => a.id === id);
                if (idx >= 0 && idx < nextGraph.canvasAnalyses.length - 1) {
                  [nextGraph.canvasAnalyses[idx], nextGraph.canvasAnalyses[idx + 1]] = [nextGraph.canvasAnalyses[idx + 1], nextGraph.canvasAnalyses[idx]];
                  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                  setGraph(nextGraph);
                  saveHistoryState('Bring analysis forward');
                  reorderCanvasNodes('analysis-', nextGraph.canvasAnalyses);
                }
              }
              setAnalysisContextMenu(null);
            }}
            onSendBackward={(id) => {
              const nextGraph = structuredClone(graph);
              if (nextGraph.canvasAnalyses) {
                const idx = nextGraph.canvasAnalyses.findIndex((a: any) => a.id === id);
                if (idx > 0) {
                  [nextGraph.canvasAnalyses[idx], nextGraph.canvasAnalyses[idx - 1]] = [nextGraph.canvasAnalyses[idx - 1], nextGraph.canvasAnalyses[idx]];
                  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                  setGraph(nextGraph);
                  saveHistoryState('Send analysis backward');
                  reorderCanvasNodes('analysis-', nextGraph.canvasAnalyses);
                }
              }
              setAnalysisContextMenu(null);
            }}
            onSendToBack={(id) => {
              const nextGraph = structuredClone(graph);
              if (nextGraph.canvasAnalyses) {
                const idx = nextGraph.canvasAnalyses.findIndex((a: any) => a.id === id);
                if (idx > 0) {
                  const [item] = nextGraph.canvasAnalyses.splice(idx, 1);
                  nextGraph.canvasAnalyses.unshift(item);
                  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
                  setGraph(nextGraph);
                  saveHistoryState('Send analysis to back');
                  reorderCanvasNodes('analysis-', nextGraph.canvasAnalyses);
                }
              }
              setAnalysisContextMenu(null);
            }}
            onCopy={(id) => {
              const a = graph.canvasAnalyses?.find((ai: any) => ai.id === id);
              if (a) {
                copySubgraph([], [], undefined, undefined, { canvasAnalyses: [a] });
              }
              setAnalysisContextMenu(null);
            }}
            onCut={(id) => {
              const a = graph.canvasAnalyses?.find((ai: any) => ai.id === id);
              if (a) {
                copySubgraph([], [], undefined, undefined, { canvasAnalyses: [a] });
                handleDeleteAnalysis(id);
              }
              setAnalysisContextMenu(null);
            }}
            onDelete={(id) => {
              handleDeleteAnalysis(id);
            }}
            onClose={() => setAnalysisContextMenu(null)}
          />
        );
      })()}

      {/* Scenario DSL Edit Modal (opened from canvas analysis context menu) */}
      {ctxDslEditState && (() => {
        const a = graph?.canvasAnalyses?.find((ai: any) => ai.id === ctxDslEditState.analysisId);
        const s = a?.recipe?.scenarios?.find((sc: any) => sc.scenario_id === ctxDslEditState.scenarioId);
        if (!a || !s) return null;
        return (
          <ScenarioQueryEditModal
            isOpen={true}
            scenarioName={s.name || s.scenario_id || ''}
            currentDSL={s.effective_dsl || ''}
            inheritedDSL={store.currentDSL || ''}
            onSave={(newDSL) => {
              if (!graph) return;
              const nextGraph = structuredClone(graph);
              const target = nextGraph?.canvasAnalyses?.find((ai: any) => ai.id === ctxDslEditState.analysisId);
              const scenario = target?.recipe?.scenarios?.find((sc: any) => sc.scenario_id === ctxDslEditState.scenarioId);
              if (scenario) scenario.effective_dsl = newDSL;
              if (nextGraph?.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
              setGraphDirect(nextGraph as any);
              saveHistoryState('Edit chart scenario DSL');
              setCtxDslEditState(null);
            }}
            onClose={() => setCtxDslEditState(null)}
          />
        );
      })()}

      {/* Multi-Select Context Menu (mixed-type or canvas-object selections) */}
      {multiSelectContextMenu && (
        <MultiSelectContextMenu
          x={multiSelectContextMenu.x}
          y={multiSelectContextMenu.y}
          selectedCount={nodes.filter(n => n.selected).length}
          onAlign={align}
          onDistribute={distribute}
          onEqualSize={equalSize}
          onDeleteSelected={() => {
            window.dispatchEvent(new CustomEvent('dagnet:deleteSelected'));
            setMultiSelectContextMenu(null);
          }}
          onClose={() => setMultiSelectContextMenu(null)}
        />
      )}

      {/* Node Context Menu */}
      {nodeContextMenu && (
        <NodeContextMenu
          x={nodeContextMenu.x}
          y={nodeContextMenu.y}
          nodeId={nodeContextMenu.nodeId}
          nodeData={nodes.find(n => n.id === nodeContextMenu.nodeId)?.data}
          nodes={nodes}
          activeTabId={effectiveActiveTabId}
          tabOperations={tabOperations}
          graph={graph}
          setGraph={setGraph}
          onClose={() => setNodeContextMenu(null)}
          onAddChart={startAddChart}
          onAlign={align}
          onDistribute={distribute}
          onEqualSize={equalSize}
          canAlign={canAlign}
          canDistribute={canDistribute}
          onSelectNode={onSelectedNodeChange}
          onDeleteNode={deleteNode}
        />
      )}
      
      {/* Edge Context Menu */}
      {edgeContextMenu && (
        <EdgeContextMenu
          x={edgeContextMenu.x}
          y={edgeContextMenu.y}
          edgeId={edgeContextMenu.edgeId}
          edgeData={contextMenuLocalData}
          edges={edges}
          graph={graph}
          graphFileId={graphFileId}
          onAddChart={startAddChart}
              onClose={() => {
                setEdgeContextMenu(null);
                setContextMenuLocalData(null);
              }}
          onUpdateGraph={(nextGraph, historyLabel, nodeId) => {
                              setGraph(nextGraph);
            if (historyLabel) {
              saveHistoryState(historyLabel, nodeId, edgeContextMenu.edgeId);
            }
          }}
          onDeleteEdge={deleteEdge}
        />
      )}
      
      {/* Variant Selection Modal */}
      {showVariantModal && (
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
            padding: '24px',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            maxWidth: '400px',
            width: '90%'
          }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', fontWeight: '600' }}>
              Select Variant for Case Edge
            </h3>
            <p style={{ margin: '0 0 16px 0', color: '#666', fontSize: '14px' }}>
              Choose which variant this edge represents:
            </p>
            
            <div style={{ marginBottom: '16px' }}>
              {caseNodeVariants.map((variant, index) => {
                // Check if this variant already has an edge to the target
                const sourceNode = graph?.nodes.find(n => n.uuid === pendingConnection?.source || n.id === pendingConnection?.source);
                const hasExistingEdge = graph?.edges.some(edge => 
                  edge.from === pendingConnection?.source && 
                  edge.to === pendingConnection?.target &&
                  edge.case_id === sourceNode?.case?.id &&
                  edge.case_variant === variant.name
                );
                
                return (
                  <button
                    key={index}
                    onClick={() => handleVariantSelection(variant)}
                    disabled={hasExistingEdge}
                    style={{
                      width: '100%',
                      padding: '12px 16px',
                      marginBottom: '8px',
                      border: hasExistingEdge ? '1px solid #ccc' : '1px solid #ddd',
                      borderRadius: '4px',
                      background: hasExistingEdge ? '#e9ecef' : '#f8f9fa',
                      cursor: hasExistingEdge ? 'not-allowed' : 'pointer',
                      textAlign: 'left',
                      fontSize: '14px',
                      transition: 'all 0.2s ease',
                      opacity: hasExistingEdge ? 0.6 : 1
                    }}
                    onMouseEnter={(e) => {
                      if (!hasExistingEdge) {
                        e.currentTarget.style.background = '#e9ecef';
                        e.currentTarget.style.borderColor = '#8B5CF6';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!hasExistingEdge) {
                        e.currentTarget.style.background = '#f8f9fa';
                        e.currentTarget.style.borderColor = '#ddd';
                      }
                    }}
                  >
                    <div style={{ fontWeight: '600', marginBottom: '4px' }}>
                      {variant.name}
                      {hasExistingEdge && <span style={{ color: '#666', fontWeight: 'normal', marginLeft: '8px' }}>✓ Already connected</span>}
                    </div>
                    <div style={{ color: '#666', fontSize: '12px' }}>
                      Weight: {(variant.weight * 100).toFixed(0)}%
                      {variant.description && ` • ${variant.description}`}
                    </div>
                  </button>
                );
              })}
            </div>
            
            <button
              onClick={dismissVariantModal}
              style={{
                padding: '8px 16px',
                background: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '14px'
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      </div>
    </DecorationVisibilityContext.Provider>
  );
}
