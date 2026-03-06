import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, startTransition, createContext, useContext } from 'react';
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
  Panel,
  ConnectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';
import '../custom-reactflow.css';
import { useTheme } from '../contexts/ThemeContext';
import { useElementTool } from '../contexts/ElementToolContext';
import dagre from 'dagre';
import { sankey, sankeyLinkHorizontal, sankeyCenter, sankeyJustify } from 'd3-sankey';

import ConversionNode from './nodes/ConversionNode';
import PostItNode from './nodes/PostItNode';
import ContainerNode from './nodes/ContainerNode';
import CanvasAnalysisNode from './nodes/CanvasAnalysisNode';
import { canvasAnalysisTransientCache } from '../hooks/useCanvasAnalysisCompute';

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
}

const DecorationVisibilityContext = createContext<DecorationVisibilityContextType>({ 
  beadsVisible: true,
  isPanning: false,
  isDraggingNode: false
});

export const useDecorationVisibility = () => useContext(DecorationVisibilityContext);
import ProbabilityInput from './ProbabilityInput';
import VariantWeightInput from './VariantWeightInput';
import { NodeContextMenu } from './NodeContextMenu';
import { PostItContextMenu } from './PostItContextMenu';
import { ContainerContextMenu } from './ContainerContextMenu';
import { CanvasAnalysisContextMenu } from './CanvasAnalysisContextMenu';
import { captureTabScenariosToRecipe } from '../services/captureTabScenariosService';
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
import { graphIssuesService } from '../services/graphIssuesService';
import { toFlow, fromFlow } from '@/lib/transform';
import { generateIdFromLabel, generateUniqueId } from '@/lib/idUtils';
import { computeEffectiveEdgeProbability } from '@/lib/whatIf';
import { getOptimalFace, assignFacesForNode } from '@/lib/faceSelection';
import { buildScenarioRenderEdges } from './canvas/buildScenarioRenderEdges';
import { getCaseEdgeVariantInfo } from './edges/edgeLabelHelpers';
import { MAX_EDGE_WIDTH, MIN_EDGE_WIDTH, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT, IMAGE_VIEW_NODE_WIDTH, IMAGE_VIEW_NODE_HEIGHT } from '@/lib/nodeEdgeConstants';
import { getSeverityIcon } from './issues/issueIcons';

const nodeTypes: NodeTypes = {
  conversion: ConversionNode,
  postit: PostItNode,
  container: ContainerNode,
  canvasAnalysis: CanvasAnalysisNode,
};

const edgeTypes: EdgeTypes = {
  conversion: ConversionEdge,
};

function GraphIssuesIndicatorOverlay({ tabId }: { tabId?: string }) {
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const { tabs } = useTabContext();
  const { graph } = useGraphStore();

  const debuggingEnabled = !!(graph as any)?.debugging;

  const graphFileId = useMemo(() => {
    if (!tabId) return null;
    return tabs.find(t => t.id === tabId)?.fileId ?? null;
  }, [tabId, tabs]);

  const graphName = useMemo(() => {
    if (!graphFileId) return null;
    return graphIssuesService.getGraphNameFromFileId(graphFileId);
  }, [graphFileId]);

  const [counts, setCounts] = useState(() => {
    if (!graphName) return { errors: 0, warnings: 0, info: 0, total: 0 };
    return graphIssuesService.getSeverityCountsForGraph({ graphName, includeReferencedFiles: true });
  });

  useEffect(() => {
    if (!debuggingEnabled || !graphName) return;

    const updateCounts = () => {
      setCounts(graphIssuesService.getSeverityCountsForGraph({ graphName, includeReferencedFiles: true }));
    };

    const unsubscribe = graphIssuesService.subscribe(() => {
      updateCounts();
    });

    // Kick off a check promptly when a debugging graph is opened.
    graphIssuesService.scheduleCheck();
    updateCounts();

    return unsubscribe;
  }, [debuggingEnabled, graphName]);

  if (!debuggingEnabled || !graphName) return null;

  const openIssues = () => {
    void graphIssuesService.openIssuesTabForGraph(graphName);
  };

  // Suppress individual severities with zero count, and suppress the whole indicator when empty.
  if (counts.total === 0) return null;

  return (
    <Panel position="top-right" style={{ margin: '10px' }}>
      <div
        style={{
          display: 'flex',
          gap: '6px',
          alignItems: 'center',
          background: dark ? 'rgba(45,45,45,0.95)' : 'rgba(255,255,255,0.92)',
          border: `1px solid ${dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
          borderRadius: '10px',
          padding: '6px 8px',
          boxShadow: dark ? '0 2px 10px rgba(0,0,0,0.3)' : '0 2px 10px rgba(0,0,0,0.06)',
          color: dark ? '#e0e0e0' : 'inherit',
          userSelect: 'none',
        }}
        aria-label={`Graph issues for ${graphName}: ${counts.errors} errors, ${counts.warnings} warnings, ${counts.info} info`}
      >
        {counts.errors > 0 && (
          <button
            type="button"
            onClick={openIssues}
            title={graphIssuesService.getSeverityTooltipText({ graphName, severity: 'error', includeReferencedFiles: true })}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: '2px 4px',
              borderRadius: '6px',
              color: '#b91c1c',
              fontSize: '12px',
              fontWeight: 600,
            }}
            aria-label={`Open Graph Issues (${counts.errors} errors)`}
          >
            {getSeverityIcon('error')} {counts.errors}
          </button>
        )}
        {counts.warnings > 0 && (
          <button
            type="button"
            onClick={openIssues}
            title={graphIssuesService.getSeverityTooltipText({ graphName, severity: 'warning', includeReferencedFiles: true })}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: '2px 4px',
              borderRadius: '6px',
              color: '#b45309',
              fontSize: '12px',
              fontWeight: 600,
            }}
            aria-label={`Open Graph Issues (${counts.warnings} warnings)`}
          >
            {getSeverityIcon('warning')} {counts.warnings}
          </button>
        )}
        {counts.info > 0 && (
          <button
            type="button"
            onClick={openIssues}
            title={graphIssuesService.getSeverityTooltipText({ graphName, severity: 'info', includeReferencedFiles: true })}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: '2px 4px',
              borderRadius: '6px',
              color: '#1d4ed8',
              fontSize: '12px',
              fontWeight: 600,
            }}
            aria-label={`Open Graph Issues (${counts.info} info)`}
          >
            {getSeverityIcon('info')} {counts.info}
          </button>
        )}
      </div>
    </Panel>
  );
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

  const fitView = useCallback((options?: any) => {
    if (isDashboardMode) {
      rfFitView({ ...options });
    } else {
      const conversionOnly = nodes.filter(n => !isCanvasObjectNode(n.id));
      rfFitView({ ...options, nodes: conversionOnly });
    }
  }, [rfFitView, nodes, isCanvasObjectNode, isDashboardMode]);

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
  
  // Trigger flag for re-routing
  const [shouldReroute, setShouldReroute] = useState(0);
  const [forceReroute, setForceReroute] = useState(false); // Force re-route once (for layout)
  const skipNextRerouteRef = useRef(false); // Skip next auto-reroute after manual reconnection
  const prevAutoRerouteRef = useRef<boolean | undefined>(undefined); // Track previous autoReroute state to detect actual changes
  
  // Auto-layout state
  const [layoutDirection, setLayoutDirection] = useState<'LR' | 'RL' | 'TB' | 'BT'>('LR');
  
  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null);
  const [nodeContextMenu, setNodeContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [postitContextMenu, setPostitContextMenu] = useState<{ x: number; y: number; postitId: string } | null>(null);
  const [containerContextMenu, setContainerContextMenu] = useState<{ x: number; y: number; containerId: string } | null>(null);
  const [analysisContextMenu, setAnalysisContextMenu] = useState<{ x: number; y: number; analysisId: string } | null>(null);
  const [edgeContextMenu, setEdgeContextMenu] = useState<{ x: number; y: number; edgeId: string } | null>(null);
  const [contextMenuLocalData, setContextMenuLocalData] = useState<{
    probability: number;
    conditionalProbabilities: { [key: string]: number };
    variantWeight: number;
  } | null>(null);
  
  // Custom onNodesChange handler to detect position changes for auto re-routing
  const onNodesChange = useCallback((changes: any[]) => {
    const filtered = activeElementTool === 'pan'
      ? changes.filter((c: any) => c.type !== 'select')
      : changes;
    onNodesChangeBase(filtered);
    
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
        setShouldReroute((v) => v + 1);
      }
    }
  }, [autoReroute, onNodesChangeBase, activeElementTool]);

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

  // Calculate edge sort keys for curved edge stacking
  // For Bézier curves, sort by the angle/direction at which edges leave/enter the face
  const getEdgeSortKey = useCallback((sourceNode: any, targetNode: any, face: string, isSourceFace: boolean = true, edgeId?: string) => {
    if (!sourceNode || !targetNode) return [0, 0];

    const sourceX = sourceNode.position?.x || 0;
    const sourceY = sourceNode.position?.y || 0;
    const targetX = targetNode.position?.x || 0;
    const targetY = targetNode.position?.y || 0;

    // Calculate vector from source to target
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;

    // Angle-based sorting (preferred). Use abs(dy) to mirror top/bottom behavior
    // so tiny vertical shifts don't flip ordering on left/right faces.
    let directionAngle: number;
    if (isSourceFace) {
      // Edge leaves the source
      if (face === 'right') {
        directionAngle = Math.atan2(Math.abs(dx), -dy); // rotate top/bottom by 90°: swap x↔y
      } else if (face === 'left') {
        directionAngle = -Math.atan2(Math.abs(dx), dy); // rotate top/bottom by 90°: swap x↔y
      } else if (face === 'bottom') {
        directionAngle = Math.atan2(Math.abs(dy), -dx);
      } else { // top
        directionAngle = -Math.atan2(Math.abs(dy), dx);
      }
    } else {
      // Edge enters the target
      if (face === 'left') {
        directionAngle = Math.atan2(-Math.abs(dx), -dy); // rotate top/bottom by 90°: swap x↔y
      } else if (face === 'right') {
        directionAngle = -Math.atan2(Math.abs(dx), -dy); // rotate top/bottom by 90°: swap x↔y
      } else if (face === 'top') {
        directionAngle = Math.atan2(-Math.abs(dy), -dx);
      } else { // bottom
        directionAngle = -Math.atan2(Math.abs(dy), -dx);
      }
    }

    // Secondary sort by span for stability when angles are very close
    const span = Math.sqrt(dx * dx + dy * dy);

    // Final tie-breaker to keep order stable under tiny movements
    const edgeIdHash = edgeId ? edgeId.split('').reduce((a, b) => a + b.charCodeAt(0), 0) : 0;

    return [directionAngle, -span, edgeIdHash];
  }, []);

  // Calculate edge offsets for Sankey-style visualization
  const calculateEdgeOffsets = useCallback((edgesWithWidth: any[], allNodes: any[], maxWidth: number) => {
    
    // Group edges by source node (for source offsets)
    const edgesBySource: { [sourceId: string]: any[] } = {};
    edgesWithWidth.forEach(edge => {
      if (!edgesBySource[edge.source]) {
        edgesBySource[edge.source] = [];
      }
      edgesBySource[edge.source].push(edge);
    });

    // Group edges by target node (for target offsets)
    const edgesByTarget: { [targetId: string]: any[] } = {};
    edgesWithWidth.forEach(edge => {
      if (!edgesByTarget[edge.target]) {
        edgesByTarget[edge.target] = [];
      }
      edgesByTarget[edge.target].push(edge);
    });

    // Pre-calculate scale factors per face to ensure consistency
    // Scale factors always apply to keep bundles within MAX_WIDTH, regardless of scaling mode
    const faceScaleFactors: { [faceKey: string]: number } = {};
    
    // Calculate scale factors for each source face
    Object.keys(edgesBySource).forEach(sourceId => {
        const sourceEdges = edgesBySource[sourceId];
        // allNodes are ReactFlow nodes: n.id = uuid, n.data.id = human-readable id
        const sourceNode = allNodes.find(n => n.id === sourceId || n.data?.id === sourceId);
        if (!sourceNode) return;
        
        // Group by face
        const edgesByFace: { [face: string]: any[] } = {};
        sourceEdges.forEach(edge => {
          const sourceHandle = edge.sourceHandle || 'right-out';
          const sourceFace = sourceHandle.split('-')[0];
          if (!edgesByFace[sourceFace]) {
            edgesByFace[sourceFace] = [];
          }
          edgesByFace[sourceFace].push(edge);
        });
        
        // Calculate scale factor for each face
        Object.keys(edgesByFace).forEach(face => {
          const faceEdges = edgesByFace[face];
          const totalWidth = faceEdges.reduce((sum, e) => {
            return sum + (e.data?.calculateWidth ? e.data.calculateWidth() : 2);
          }, 0);
          
          const faceKey = `source-${sourceId}-${face}`;
          faceScaleFactors[faceKey] = totalWidth > maxWidth ? maxWidth / totalWidth : 1.0;
        });
      });
      
    // Calculate scale factors for each target face
    Object.keys(edgesByTarget).forEach(targetId => {
        const targetEdges = edgesByTarget[targetId];
        // allNodes are ReactFlow nodes: n.id = uuid, n.data.id = human-readable id
        const targetNode = allNodes.find(n => n.id === targetId || n.data?.id === targetId);
        if (!targetNode) return;
        
        // Group by face
        const edgesByFace: { [face: string]: any[] } = {};
        targetEdges.forEach(edge => {
          const targetHandle = edge.targetHandle || 'left';
          const targetFace = targetHandle.split('-')[0];
          if (!edgesByFace[targetFace]) {
            edgesByFace[targetFace] = [];
          }
          edgesByFace[targetFace].push(edge);
        });
        
        // Calculate scale factor for each face
        Object.keys(edgesByFace).forEach(face => {
          const faceEdges = edgesByFace[face];
          const totalWidth = faceEdges.reduce((sum, e) => {
            return sum + (e.data?.calculateWidth ? e.data.calculateWidth() : 2);
          }, 0);
          
          const faceKey = `target-${targetId}-${face}`;
          faceScaleFactors[faceKey] = totalWidth > maxWidth ? maxWidth / totalWidth : 1.0;
        });
      });
      
    // Calculate scale factors for incident faces (faces with edges from multiple sources)
    // This handles cases where multiple source nodes connect to the same target face
    const incidentFaces: { [faceKey: string]: any[] } = {};
      
      // Group all edges by target node and face
      edgesWithWidth.forEach(edge => {
        const targetHandle = edge.targetHandle || 'left';
        const targetFace = targetHandle.split('-')[0];
        const faceKey = `incident-${edge.target}-${targetFace}`;
        
        if (!incidentFaces[faceKey]) {
          incidentFaces[faceKey] = [];
        }
        incidentFaces[faceKey].push(edge);
      });
      
      // Calculate scale factors for incident faces
      Object.keys(incidentFaces).forEach(faceKey => {
        const faceEdges = incidentFaces[faceKey];
        const totalWidth = faceEdges.reduce((sum, e) => {
          return sum + (e.data?.calculateWidth ? e.data.calculateWidth() : 2);
        }, 0);
        
        faceScaleFactors[faceKey] = totalWidth > maxWidth ? maxWidth / totalWidth : 1.0;
      });

    // Calculate offsets for each edge (both source and target)
    const edgesWithOffsets = edgesWithWidth.map(edge => {
      // Apply offsets for all modes including uniform (for Sankey-style visualization)
      // (Skip offsets only for modes that explicitly don't need them - currently none)

      const sourceEdges = edgesBySource[edge.source] || [];
      const targetEdges = edgesByTarget[edge.target] || [];

      // Find the source and target nodes to determine edge direction
      // allNodes are ReactFlow nodes: n.id = uuid, n.data.id = human-readable id
      const sourceNode = allNodes.find(n => n.id === edge.source || n.data?.id === edge.source);
      const targetNode = allNodes.find(n => n.id === edge.target || n.data?.id === edge.target);
      
      if (!sourceNode || !targetNode) {
        return { 
          ...edge, 
          sourceOffsetX: 0, 
          sourceOffsetY: 0,
          targetOffsetX: 0,
          targetOffsetY: 0
        };
      }

      // Get the actual connection handles from the edge data
      // These tell us which face of each node the edge connects to
      const sourceHandle = edge.sourceHandle || 'right-out';
      const targetHandle = edge.targetHandle || 'left';
      
      // Extract face from handle (e.g., 'right-out' → 'right', 'left' → 'left')
      const sourceFace = sourceHandle.split('-')[0]; // 'right', 'left', 'top', 'bottom'
      const targetFace = targetHandle.split('-')[0]; // 'right', 'left', 'top', 'bottom'

      // ===== Calculate SOURCE offsets =====
      // Filter to only edges exiting from the SAME FACE of this source node
      const sameFaceSourceEdges = sourceEdges.filter(e => {
        const eSourceHandle = e.sourceHandle || 'right-out';
        const eSourceFace = eSourceHandle.split('-')[0];
        return eSourceFace === sourceFace;
      });

      // Sort by departure angle from this face (accounts for curve trajectory)
      const sortedSourceEdges = [...sameFaceSourceEdges].sort((a, b) => {
        // allNodes are ReactFlow nodes: n.id = uuid, n.data.id = human-readable id
        const aTarget = allNodes.find(n => n.id === a.target || n.data?.id === a.target);
        const bTarget = allNodes.find(n => n.id === b.target || n.data?.id === b.target);
        if (!aTarget || !bTarget) return 0;
        
        const aKey = getEdgeSortKey(sourceNode, aTarget, sourceFace, true, a.id);
        const bKey = getEdgeSortKey(sourceNode, bTarget, sourceFace, true, b.id);
        
        // Compare [angle, span, edgeIdHash]
        if (aKey[0] !== bKey[0]) return aKey[0] - bKey[0];
        if (aKey[1] !== bKey[1]) return aKey[1] - bKey[1];
        return aKey[2] - bKey[2];
      });

      // Get the scale factor for this source face
      const sourceFaceKey = `source-${edge.source}-${sourceFace}`;
      const sourceScaleFactor = faceScaleFactors[sourceFaceKey] || 1.0;

      // Calculate source offsets using the pre-calculated scale factor
      let sourceOffsetX = 0;
      let sourceOffsetY = 0;

      if (sortedSourceEdges.length > 0) {
        const sourceEdgeIndex = sortedSourceEdges.findIndex(e => e.id === edge.id); // ReactFlow edge IDs match
        if (sourceEdgeIndex !== -1) {
          // Calculate cumulative width using per-edge scale = min(source-face, incident target-face)
          const sourceCumulativeWidth = sortedSourceEdges.slice(0, sourceEdgeIndex).reduce((sum, e) => {
            const width = e.data?.calculateWidth ? e.data.calculateWidth() : 2;
            const eSourceHandle = e.sourceHandle || 'right-out';
            const eSourceFace = eSourceHandle.split('-')[0];
            const eTargetHandle = e.targetHandle || 'left';
            const eTargetFace = eTargetHandle.split('-')[0];
            const eSourceKey = `source-${e.source}-${eSourceFace}`;
            const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
            const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
            const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
            // Always apply scale factors to enforce MAX_WIDTH constraint
            const eScale = Math.min(eSourceScale, eIncidentScale);
            return sum + (width * eScale);
          }, 0);

          const edgeWidth = edge.data?.calculateWidth ? edge.data.calculateWidth() : 2;
          const incidentFaceKeyForThis = `incident-${edge.target}-${targetFace}`;
          const incidentScaleForThis = faceScaleFactors[incidentFaceKeyForThis] || 1.0;
          // Always apply scale factors to enforce MAX_WIDTH constraint
          const thisEdgeScale = Math.min(sourceScaleFactor, incidentScaleForThis);
          const scaledEdgeWidth = edgeWidth * thisEdgeScale;
          
          const sourceCenterInStack = sourceCumulativeWidth + (scaledEdgeWidth / 2);
          
          // Calculate total scaled width for centering using per-edge scales
          const totalScaledWidth = sortedSourceEdges.reduce((sum, e) => {
            const width = e.data?.calculateWidth ? e.data.calculateWidth() : 2;
            const eSourceHandle = e.sourceHandle || 'right-out';
            const eSourceFace = eSourceHandle.split('-')[0];
            const eTargetHandle = e.targetHandle || 'left';
            const eTargetFace = eTargetHandle.split('-')[0];
            const eSourceKey = `source-${e.source}-${eSourceFace}`;
            const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
            const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
            const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
            // Always apply scale factors to enforce MAX_WIDTH constraint
            const eScale = Math.min(eSourceScale, eIncidentScale);
            return sum + (width * eScale);
          }, 0);
          
          const sourceStackCenter = totalScaledWidth / 2;
          const sourceOffsetFromCenter = sourceCenterInStack - sourceStackCenter;

          // Apply offset to the correct axis based on face
          if (sourceFace === 'left' || sourceFace === 'right') {
            // Left/right faces: offset vertically (Y)
            sourceOffsetY = sourceOffsetFromCenter;
          } else {
            // Top/bottom faces: offset horizontally (X)
            sourceOffsetX = sourceOffsetFromCenter;
          }
        }
      }

      // ===== Calculate TARGET offsets =====
      // Filter to only edges entering from the SAME FACE of this target node
      const sameFaceTargetEdges = targetEdges.filter(e => {
        const eTargetHandle = e.targetHandle || 'left';
        const eTargetFace = eTargetHandle.split('-')[0];
        return eTargetFace === targetFace;
      });

      // Sort by arrival angle at this face (accounts for curve trajectory)
      const sortedTargetEdges = [...sameFaceTargetEdges].sort((a, b) => {
        // allNodes are ReactFlow nodes: n.id = uuid, n.data.id = human-readable id
        const aSource = allNodes.find(n => n.id === a.source || n.data?.id === a.source);
        const bSource = allNodes.find(n => n.id === b.source || n.data?.id === b.source);
        if (!aSource || !bSource) return 0;
        
        const aKey = getEdgeSortKey(aSource, targetNode, targetFace, false, a.id);
        const bKey = getEdgeSortKey(bSource, targetNode, targetFace, false, b.id);
        
        // Compare [angle, span, edgeIdHash]
        if (aKey[0] !== bKey[0]) return aKey[0] - bKey[0];
        if (aKey[1] !== bKey[1]) return aKey[1] - bKey[1];
        return aKey[2] - bKey[2];
      });

      // Get the scale factor for this target incident face (ALL incoming edges)
      const incidentFaceKey = `incident-${edge.target}-${targetFace}`;
      const targetScaleFactor = faceScaleFactors[incidentFaceKey] || 1.0;

      let targetOffsetX = 0;
      let targetOffsetY = 0;

      if (sortedTargetEdges.length > 0) {
        const targetEdgeIndex = sortedTargetEdges.findIndex(e => e.id === edge.id); // ReactFlow edge IDs match
        if (targetEdgeIndex !== -1) {
          // Calculate cumulative width using per-edge scale = min(source-face, incident target-face)
          const targetCumulativeWidth = sortedTargetEdges.slice(0, targetEdgeIndex).reduce((sum, e) => {
            const width = e.data?.calculateWidth ? e.data.calculateWidth() : 2;
            const eSourceHandle = e.sourceHandle || 'right-out';
            const eSourceFace = eSourceHandle.split('-')[0];
            const eTargetHandle = e.targetHandle || 'left';
            const eTargetFace = eTargetHandle.split('-')[0];
            const eSourceKey = `source-${e.source}-${eSourceFace}`;
            const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
            const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
            const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
            // Always apply scale factors to enforce MAX_WIDTH constraint
            const eScale = Math.min(eSourceScale, eIncidentScale);
            return sum + (width * eScale);
          }, 0);

          const edgeWidth = edge.data?.calculateWidth ? edge.data.calculateWidth() : 2;
          const thisEdgeScaleAtTarget = !useUniformScaling ? Math.min(sourceScaleFactor, targetScaleFactor) : 1.0;
          const scaledEdgeWidth = edgeWidth * thisEdgeScaleAtTarget;
          
          const targetCenterInStack = targetCumulativeWidth + (scaledEdgeWidth / 2);
          
          // Calculate total scaled width for centering using per-edge scales
          const totalScaledWidth = sortedTargetEdges.reduce((sum, e) => {
            const width = e.data?.calculateWidth ? e.data.calculateWidth() : 2;
            const eSourceHandle = e.sourceHandle || 'right-out';
            const eSourceFace = eSourceHandle.split('-')[0];
            const eTargetHandle = e.targetHandle || 'left';
            const eTargetFace = eTargetHandle.split('-')[0];
            const eSourceKey = `source-${e.source}-${eSourceFace}`;
            const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
            const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
            const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
            // Always apply scale factors to enforce MAX_WIDTH constraint
            const eScale = Math.min(eSourceScale, eIncidentScale);
            return sum + (width * eScale);
          }, 0);
          
          const targetStackCenter = totalScaledWidth / 2;
          const targetOffsetFromCenter = targetCenterInStack - targetStackCenter;

          // Apply offset to the correct axis based on face
          if (targetFace === 'left' || targetFace === 'right') {
            // Left/right faces: offset vertically (Y)
            targetOffsetY = targetOffsetFromCenter;
          } else {
            // Top/bottom faces: offset horizontally (X)
            targetOffsetX = targetOffsetFromCenter;
          }
        }
      }

      // Get the final edge width using the per-edge scale factor = min(source-face, incident target-face)
      // Always apply scale factors to enforce MAX_WIDTH constraint
      let scaledWidth = edge.data?.calculateWidth ? edge.data.calculateWidth() : 2;
      const thisIncidentScale = faceScaleFactors[`incident-${edge.target}-${targetFace}`] || 1.0;
      const thisEdgeScale = Math.min(sourceScaleFactor, thisIncidentScale);
      scaledWidth = scaledWidth * thisEdgeScale;

      // Calculate bundle metadata
      const sourceEdgeIndex = sortedSourceEdges.findIndex(e => e.id === edge.id);
      const targetEdgeIndex = sortedTargetEdges.findIndex(e => e.id === edge.id);
      
      // Calculate total bundle widths (already calculated above, but extract for clarity)
      const sourceBundleWidth = sortedSourceEdges.reduce((sum, e) => {
        const width = e.data?.calculateWidth ? e.data.calculateWidth() : 2;
        const eSourceHandle = e.sourceHandle || 'right-out';
        const eSourceFace = eSourceHandle.split('-')[0];
        const eTargetHandle = e.targetHandle || 'left';
        const eTargetFace = eTargetHandle.split('-')[0];
        const eSourceKey = `source-${e.source}-${eSourceFace}`;
        const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
        const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
        const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
        const eScale = !useUniformScaling ? Math.min(eSourceScale, eIncidentScale) : 1.0;
        return sum + (width * eScale);
      }, 0);
      
      const targetBundleWidth = sortedTargetEdges.reduce((sum, e) => {
        const width = e.data?.calculateWidth ? e.data.calculateWidth() : 2;
        const eSourceHandle = e.sourceHandle || 'right-out';
        const eSourceFace = eSourceHandle.split('-')[0];
        const eTargetHandle = e.targetHandle || 'left';
        const eTargetFace = eTargetHandle.split('-')[0];
        const eSourceKey = `source-${e.source}-${eSourceFace}`;
        const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
        const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
        const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
        const eScale = !useUniformScaling ? Math.min(eSourceScale, eIncidentScale) : 1.0;
        return sum + (width * eScale);
      }, 0);

      return { 
        ...edge, 
        sourceOffsetX: sourceOffsetX,
        sourceOffsetY: sourceOffsetY,
        targetOffsetX: targetOffsetX,
        targetOffsetY: targetOffsetY,
        scaledWidth: scaledWidth,
        // Bundle metadata
        sourceBundleWidth: sourceBundleWidth,
        targetBundleWidth: targetBundleWidth,
        sourceBundleSize: sortedSourceEdges.length,
        targetBundleSize: sortedTargetEdges.length,
        isFirstInSourceBundle: sourceEdgeIndex === 0,
        isLastInSourceBundle: sourceEdgeIndex === sortedSourceEdges.length - 1,
        isFirstInTargetBundle: targetEdgeIndex === 0,
        isLastInTargetBundle: targetEdgeIndex === sortedTargetEdges.length - 1,
        sourceFace: sourceFace,
        targetFace: targetFace,
      };
    });

    return edgesWithOffsets;
  }, [useUniformScaling, getEdgeSortKey, graphStoreHook]);

  // Track the last synced graph to detect real changes
  const lastSyncedGraphRef = useRef<string>('');
  const lastSyncedReactFlowRef = useRef<string>('');
  const isSyncingRef = useRef(false); // Prevents ReactFlow->Graph sync loops, but NOT Graph->ReactFlow sync
  const isDraggingNodeRef = useRef(false); // Prevents Graph->ReactFlow sync during node dragging
  const dragTimeoutRef = useRef<number | null>(null); // Failsafe to clear drag flag if it gets stuck
  const prevSankeyViewRef = useRef(useSankeyView); // Track Sankey mode changes to force slow path rebuild
  const prevShowNodeImagesRef = useRef(showNodeImages); // Track image view changes to force slow path rebuild
  const reactFlowWrapperRef = useRef<HTMLDivElement>(null); // For lasso coordinate calculations
  const hasInitialFitViewRef = useRef(false);
  const currentGraphIdRef = useRef<string>('');
  
  // Track last committed RENDER edges (not base edges) for geometry field merge during slow-path rebuilds
  const lastRenderEdgesRef = useRef<Edge[]>([]);
  const isInSlowPathRebuildRef = useRef(false);
  
  // Re-route feature state
  const lastNodePositionsRef = useRef<{ [nodeId: string]: { x: number; y: number } }>({});

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
  
  // Perform immediate re-route of ALL edges (used when toggling on)
  const performImmediateReroute = useCallback(() => {
    if (!graph) {
      console.log('No graph, skipping immediate re-route');
      return;
    }
    
    console.log('Performing immediate re-route of ALL edges');
    
    const nextGraph = structuredClone(graph);
    let updatedCount = 0;
    
    // Re-route ALL edges
    nextGraph.edges.forEach((graphEdge: any) => {
      // For ReactFlow nodes, n.id IS the uuid, but graphEdge.from/to could be either uuid or human-readable id
      const sourceNode = nodes.find(n => n.id === graphEdge.from || n.data?.id === graphEdge.from);
      const targetNode = nodes.find(n => n.id === graphEdge.to || n.data?.id === graphEdge.to);
      
      if (sourceNode && targetNode) {
        const { sourceHandle, targetHandle } = calculateOptimalHandles(sourceNode, targetNode);
        
        // Only count as updated if handles actually changed
        const handleChanged = graphEdge.fromHandle !== sourceHandle || graphEdge.toHandle !== targetHandle;
        
        if (handleChanged) {
          console.log(`Re-routing edge ${graphEdge.id}:`, {
            from: graphEdge.from,
            to: graphEdge.to,
            oldFromHandle: graphEdge.fromHandle,
            newFromHandle: sourceHandle,
            oldToHandle: graphEdge.toHandle,
            newToHandle: targetHandle
          });
          
          graphEdge.fromHandle = sourceHandle;
          graphEdge.toHandle = targetHandle;
          updatedCount++;
        }
      }
    });
    
    console.log(`Updated ${updatedCount} edges`);
    
    if (updatedCount > 0) {
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      
      console.log('Updating graph with immediate re-route changes');
      setGraph(nextGraph);
    }
  }, [graph, nodes, calculateOptimalHandles, setGraph]);
  
  // Auto re-route edges when nodes move
  const performAutoReroute = useCallback(() => {
    // Skip if we just did a manual reconnection
    if (skipNextRerouteRef.current) {
      console.log('Auto re-route skipped: manual reconnection just occurred');
      skipNextRerouteRef.current = false;
      return;
    }
    
    // Allow execution if autoReroute is enabled OR if forceReroute is true
    if ((!autoReroute && !forceReroute) || !graph) {
      console.log('Auto re-route skipped:', { autoReroute, forceReroute, hasGraph: !!graph });
      return;
    }
    
    const isDragging = isDraggingNodeRef.current;
    console.log('performAutoReroute executing:', { autoReroute, forceReroute, isDragging });
    
    const currentPositions: { [nodeId: string]: { x: number; y: number } } = {};
    let movedNodes: string[] = [];
    
    // If forceReroute, re-route ALL edges
    if (forceReroute) {
      console.log('Force re-route: processing all nodes');
      movedNodes = nodes.map(n => n.id);
      nodes.forEach(node => {
        currentPositions[node.id] = { x: node.position.x, y: node.position.y };
      });
    } else {
      // Check which nodes have moved
      nodes.forEach(node => {
        const currentPos = { x: node.position.x, y: node.position.y };
        const lastPos = lastNodePositionsRef.current[node.id];
        
        currentPositions[node.id] = currentPos;
        
        if (lastPos && (Math.abs(currentPos.x - lastPos.x) > 5 || Math.abs(currentPos.y - lastPos.y) > 5)) {
          movedNodes.push(node.id);
          console.log(`Node ${node.id} moved:`, { 
            from: lastPos, 
            to: currentPos, 
            deltaX: currentPos.x - lastPos.x, 
            deltaY: currentPos.y - lastPos.y 
          });
        }
      });
      
      if (movedNodes.length === 0) {
        console.log('No nodes moved, skipping re-route');
        return;
      }
    }
    
    console.log('Moved nodes:', movedNodes);
    
    // Update last positions
    lastNodePositionsRef.current = currentPositions;
    
    // Find edges that need re-routing
    const edgesToReroute = edges.filter(edge => 
      movedNodes.includes(edge.source) || movedNodes.includes(edge.target)
    );
    
    console.log('Edges to re-route:', edgesToReroute.map(e => e.id));
    
    if (edgesToReroute.length === 0) return;
    
    // Update graph with new handle positions
    const nextGraph = structuredClone(graph);
    
    // Build quick position map
    const pos: Record<string, { x: number; y: number }> = {};
    nodes.forEach(n => { pos[n.id] = { x: n.position.x, y: n.position.y }; });

    // Track which edges changed to identify nodes that need re-evaluation
    const changedEdges = new Set<string>();
    const processedNodes = new Set<string>();
    const nodesToProcess = [...movedNodes];
    
    // Process nodes in waves, using original edge state for decisions
    while (nodesToProcess.length > 0) {
      const nodeId = nodesToProcess.shift()!;
      if (processedNodes.has(nodeId)) continue;
      
      processedNodes.add(nodeId);
      
      // Use original edges for face assignment decisions
      const assignments = assignFacesForNode(nodeId, pos, edges as any);
      
      // Apply assignments and track changes
      Object.entries(assignments).forEach(([edgeId, face]) => {
        const originalEdge = edges.find(e => e.id === edgeId); // ReactFlow edge IDs match
        const graphEdge = nextGraph.edges.find(e => e.uuid === edgeId || e.id === edgeId);
        if (!originalEdge || !graphEdge) return;
        
        const newFromHandle = graphEdge.from === nodeId ? face + '-out' : graphEdge.fromHandle;
        const newToHandle = graphEdge.to === nodeId ? face : graphEdge.toHandle;
        
        
        // Check if this edge's face actually changed
        const fromChanged = graphEdge.from === nodeId && originalEdge.sourceHandle !== newFromHandle;
        const toChanged = graphEdge.to === nodeId && originalEdge.targetHandle !== newToHandle;
        
        if (fromChanged || toChanged) {
          changedEdges.add(edgeId);
          
          // Add connected nodes for next wave (avoid duplicates)
          if (!processedNodes.has(originalEdge.source) && !nodesToProcess.includes(originalEdge.source)) {
            nodesToProcess.push(originalEdge.source);
          }
          if (!processedNodes.has(originalEdge.target) && !nodesToProcess.includes(originalEdge.target)) {
            nodesToProcess.push(originalEdge.target);
          }
        }
        
        // Apply the changes
        if (graphEdge.from === nodeId) {
          graphEdge.fromHandle = face + '-out';
        }
        if (graphEdge.to === nodeId) {
          graphEdge.toHandle = face;
        }
      });
    }
    
    // Only update if edges actually changed
    if (changedEdges.size === 0) {
      console.log('No edges changed, skipping graph update');
      return;
    }
    
    // Preserve current ReactFlow node positions in the graph
    // This prevents nodes from jumping back to old positions when graph is synced
    nextGraph.nodes.forEach((node: any) => {
      const reactFlowNode = nodes.find(n => n.id === node.uuid || n.id === node.id);
      if (reactFlowNode && node.layout) {
        node.layout.x = reactFlowNode.position.x;
        node.layout.y = reactFlowNode.position.y;
      }
    });
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    console.log(`Updating graph with ${changedEdges.size} changed edge handle positions`);
    setGraph(nextGraph);
    // Graph→ReactFlow sync will pick up the edge handle changes via the fast path
  }, [autoReroute, forceReroute, graph, nodes, edges, calculateOptimalHandles, setGraph]);
  
  // Reset position tracking and perform immediate re-route when autoReroute is actually toggled ON
  // Only react when the value actually changes, not on initial load
  useEffect(() => {
    const prev = prevAutoRerouteRef.current;
    prevAutoRerouteRef.current = autoReroute;
    
    console.log(`[${new Date().toISOString()}] [GraphCanvas] useEffect#GC4: Auto re-route:`, autoReroute, `(prev: ${prev})`);
    
    if (autoReroute) {
      // Initialize position tracking when enabling
      const initialPositions: { [nodeId: string]: { x: number; y: number } } = {};
      nodes.forEach(node => {
        initialPositions[node.id] = { x: node.position.x, y: node.position.y };
      });
      lastNodePositionsRef.current = initialPositions;
      
      // Only perform immediate re-route if this is an actual toggle (not initial load)
      if (prev !== undefined && prev !== autoReroute && graph && nodes.length > 0 && edges.length > 0) {
        console.log('Triggering immediate re-route on toggle');
        setTimeout(() => {
          performImmediateReroute();
        }, 50);
      }
    } else {
      // Clear position tracking when disabling
      lastNodePositionsRef.current = {};
    }
  }, [autoReroute]); // ONLY depend on autoReroute, not nodes/edges/graph!
  
  // Perform re-routing when shouldReroute flag changes (with small delay after node movement)
  useEffect(() => {
    if (sankeyLayoutInProgressRef.current || isEffectsCooldownActive()) {
      console.log(`[${ts()}] [GraphCanvas] Re-route skipped (layout/cooldown active)`);
      return;
    }
    if ((shouldReroute > 0 && autoReroute) || forceReroute) {
      console.log('Re-route triggered:', { shouldReroute, autoReroute, forceReroute });
      // Add a small delay to ensure node positions are fully updated
      const timeoutId = setTimeout(() => {
        console.log('Executing delayed re-route after node movement');
        performAutoReroute();
        if (forceReroute) {
          setForceReroute(false); // Reset force flag after execution
        }
        // Reset the shouldReroute flag to prevent infinite loops
        setShouldReroute(0);
      }, 100); // 100ms delay after user finishes dragging
      
      return () => clearTimeout(timeoutId);
    }
  }, [shouldReroute, autoReroute, forceReroute, performAutoReroute]);
  
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
  const postitHistoryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const handleUpdatePostit = useCallback((id: string, updates: any) => {
    if (!graph) return;
    const nextGraph = structuredClone(graph);
    if (!nextGraph.postits) return;
    const p = nextGraph.postits.find((p: any) => p.id === id);
    if (!p) return;
    Object.assign(p, updates);
    if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
    setGraph(nextGraph);
    // Debounce history: coalesce rapid changes (typing, resizing) into one undo step
    if (postitHistoryTimerRef.current) clearTimeout(postitHistoryTimerRef.current);
    postitHistoryTimerRef.current = setTimeout(() => {
      saveHistoryState('Update post-it');
      postitHistoryTimerRef.current = null;
    }, 800);
  }, [graph, setGraph, saveHistoryState]);

  const handleDeletePostit = useCallback((id: string) => {
    if (!graph) return;
    const nextGraph = structuredClone(graph);
    if (!nextGraph.postits) return;
    nextGraph.postits = nextGraph.postits.filter((p: any) => p.id !== id);
    if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
    setGraph(nextGraph);
    saveHistoryState('Delete post-it');
    onSelectedAnnotationChange?.(null, null);
  }, [graph, setGraph, saveHistoryState, onSelectedAnnotationChange]);

  const containerHistoryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const handleUpdateContainer = useCallback((id: string, updates: any) => {
    if (!graph) return;
    const nextGraph = structuredClone(graph);
    if (!nextGraph.containers) return;
    const c = nextGraph.containers.find((c: any) => c.id === id);
    if (!c) return;
    Object.assign(c, updates);
    if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
    setGraph(nextGraph);
    if (containerHistoryTimerRef.current) clearTimeout(containerHistoryTimerRef.current);
    containerHistoryTimerRef.current = setTimeout(() => {
      saveHistoryState('Update container');
      containerHistoryTimerRef.current = null;
    }, 800);
  }, [graph, setGraph, saveHistoryState]);

  const handleDeleteContainer = useCallback((id: string) => {
    if (!graph) return;
    const nextGraph = structuredClone(graph);
    if (!nextGraph.containers) return;
    nextGraph.containers = nextGraph.containers.filter((c: any) => c.id !== id);
    if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
    setGraph(nextGraph);
    saveHistoryState('Delete container');
    onSelectedAnnotationChange?.(null, null);
  }, [graph, setGraph, saveHistoryState, onSelectedAnnotationChange]);

  const analysisHistoryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const handleUpdateAnalysis = useCallback((id: string, updates: any) => {
    if (!graph) return;
    const nextGraph = structuredClone(graph);
    if (!nextGraph.canvasAnalyses) return;
    const a = nextGraph.canvasAnalyses.find((a: any) => a.id === id);
    if (!a) return;
    Object.assign(a, updates);
    if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
    setGraph(nextGraph);
    if (analysisHistoryTimerRef.current) clearTimeout(analysisHistoryTimerRef.current);
    analysisHistoryTimerRef.current = setTimeout(() => {
      saveHistoryState('Update canvas analysis');
      analysisHistoryTimerRef.current = null;
    }, 800);
  }, [graph, setGraph, saveHistoryState]);

  const handleDeleteAnalysis = useCallback((id: string) => {
    if (!graph) return;
    const nextGraph = structuredClone(graph);
    if (!nextGraph.canvasAnalyses) return;
    nextGraph.canvasAnalyses = nextGraph.canvasAnalyses.filter((a: any) => a.id !== id);
    if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
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
      
      e.detail.selectedNodeUuids = selectedNodes.filter(n => !isCanvasObjectNode(n.id)).map(n => n.id);
      e.detail.selectedEdgeUuids = selectedEdges.map(e => e.id);
      e.detail.selectedPostitIds = selectedNodes.filter(n => n.id?.startsWith('postit-')).map(n => n.id.replace('postit-', ''));
      e.detail.selectedContainerIds = selectedNodes.filter(n => n.id?.startsWith('container-')).map(n => n.id.replace('container-', ''));
      e.detail.selectedAnalysisIds = selectedNodes.filter(n => n.id?.startsWith('analysis-')).map(n => n.id.replace('analysis-', ''));
    };
    window.addEventListener('dagnet:querySelection', handler as any);
    return () => window.removeEventListener('dagnet:querySelection', handler as any);
  }, [nodes, edges, isCanvasObjectNode]);

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
    const sankeyModeChanged = prevSankeyViewRef.current !== useSankeyView;
    const imageViewChanged = prevShowNodeImagesRef.current !== showNodeImages;
    const viewModeChanged = sankeyModeChanged || imageViewChanged;
    
    // Skip if graph unchanged AND no view mode changed
    // (View mode changes require full rebuild even if graph is the same)
    if (graphJson === lastSyncedGraphRef.current && !viewModeChanged) {
      return;
    }
    lastSyncedGraphRef.current = graphJson;
    
    console.log('🔄 Graph→ReactFlow sync triggered', sankeyModeChanged ? '(Sankey mode changed)' : imageViewChanged ? '(Image view changed)' : '');
    console.log('  Graph edges (UUIDs):', graph.edges?.map((e: any) => e.uuid));
    console.log('  ReactFlow edges (UUIDs):', edges.map(e => e.id));
    
    // Set syncing flag to prevent re-routing during graph->ReactFlow sync
    isSyncingRef.current = true;
    
    // Check if only edge probabilities changed (not topology or node positions)
    const edgeCountChanged = edges.length !== (graph.edges?.length || 0);
    const expectedNodeCount = (graph.nodes?.length || 0) + (graph.postits?.length || 0) + (graph.containers?.length || 0) + (graph.canvasAnalyses?.length || 0);
    const nodeCountChanged = nodes.length !== expectedNodeCount;
    
    console.log('  Edge count changed:', edgeCountChanged, `(${edges.length} -> ${graph.edges?.length || 0})`);
    console.log('  Node count changed:', nodeCountChanged);
    
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
    // CRITICAL: During drag or immediately after drag, ALWAYS take fast path to prevent node position overwrites
    // We ignore nodePositionsChanged during/after drag because ReactFlow has the current drag positions
    // Handle changes require full recalculation because they affect edge bundling, offsets, and widths
    // After drag, we keep isDraggingNodeRef.current true until sync completes to force fast path
    // View mode changes (Sankey, image view) require slow path because node sizes change
    // Image boundary changes (0↔1 images) also require slow path for node resizing
    const shouldTakeFastPath = !edgeCountChanged && !nodeCountChanged && !edgeIdsChanged && !edgeHandlesChanged && 
                               !viewModeChanged && !imageBoundaryChanged && edges.length > 0 && (isDraggingNodeRef.current || !nodePositionsChanged);
    
    if (shouldTakeFastPath) {
      const pathReason = isDraggingNodeRef.current ? '(DRAG - ignoring position diff)' : '(positions unchanged)';
      console.log(`  ⚡ Fast path: Topology and handles unchanged, updating edge data in place ${pathReason}`);
      
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
        setNodes(prevNodes => {
          const autoEditNodeId = autoEditPostitIdRef.current ? `postit-${autoEditPostitIdRef.current}` : null;

          // Remove canvas object nodes that no longer exist in the graph (e.g. after undo)
          let updatedNodes = prevNodes
            .filter(prevNode => {
              if (prevNode.id?.startsWith('postit-')) return graphPostitIds.has(prevNode.id.replace('postit-', ''));
              if (prevNode.id?.startsWith('container-')) return graphContainerIds.has(prevNode.id.replace('container-', ''));
              return true;
            });
          updatedNodes = updatedNodes.map(prevNode => {
            if (prevNode.id.startsWith('postit-')) {
              const postitId = prevNode.id.replace('postit-', '');
              const gpArray = graph.postits || [];
              const gpIndex = gpArray.findIndex((p: any) => p.id === postitId);
              const graphPostit = gpIndex >= 0 ? gpArray[gpIndex] : null;
              if (!graphPostit) return prevNode;
              return {
                ...prevNode,
                zIndex: 5000 + gpIndex,
                position: { x: graphPostit.x ?? 0, y: graphPostit.y ?? 0 },
                style: { ...prevNode.style, width: graphPostit.width, height: graphPostit.height },
                selected: autoEditNodeId ? prevNode.id === autoEditNodeId : prevNode.selected,
                data: {
                  ...prevNode.data,
                  postit: graphPostit,
                  onUpdate: handleUpdatePostit,
                  onDelete: handleDeletePostit,
                  onSelect: onSelectedAnnotationChange ? (id: string) => onSelectedAnnotationChange(id, 'postit') : undefined,
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
                position: { x: graphContainer.x ?? 0, y: graphContainer.y ?? 0 },
                style: { ...prevNode.style, width: graphContainer.width, height: graphContainer.height },
                data: {
                  ...prevNode.data,
                  container: graphContainer,
                  onUpdate: handleUpdateContainer,
                  onDelete: handleDeleteContainer,
                },
              };
            }
            const graphNode = graph.nodes.find((n: any) => n.uuid === prevNode.id || n.id === prevNode.id);
            if (!graphNode) return prevNode;
            
            // Compute containerColour using actual ReactFlow positions of containers in this batch
            const CONTAIN_TOL = 10;
            const nw = (prevNode as any).measured?.width ?? prevNode.width ?? DEFAULT_NODE_WIDTH;
            const nh = (prevNode as any).measured?.height ?? prevNode.height ?? DEFAULT_NODE_HEIGHT;
            const nx = prevNode.position?.x ?? 0;
            const ny = prevNode.position?.y ?? 0;
            let containerColour: string | undefined;
            const containerArray = graph.containers || [];
            for (let ci = containerArray.length - 1; ci >= 0; ci--) {
              const cont = updatedNodes.find(cn => cn.id === `container-${containerArray[ci].id}`);
              if (!cont) continue;
              const cx = cont.position?.x ?? 0;
              const cy = cont.position?.y ?? 0;
              const cw = (cont as any).measured?.width ?? cont.width ?? (typeof cont.style?.width === 'number' ? cont.style.width : 400);
              const ch = (cont as any).measured?.height ?? cont.height ?? (typeof cont.style?.height === 'number' ? cont.style.height : 300);
              if (nx >= (cx - CONTAIN_TOL) && ny >= (cy - CONTAIN_TOL) && (nx + nw) <= (cx + cw + CONTAIN_TOL) && (ny + nh) <= (cy + ch + CONTAIN_TOL)) {
                containerColour = containerArray[ci].colour;
                break;
              }
            }

            const hasImages = showNodeImages && (graphNode.images?.length || 0) > 0;
            return {
              ...prevNode,
              data: {
                ...prevNode.data,
                ...(containerColour !== prevNode.data?.containerColour ? { containerColour } : {}),
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
                data: { container: c, onUpdate: handleUpdateContainer, onDelete: handleDeleteContainer },
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
                  ...(shouldAutoEdit ? { autoEdit: true } : {}),
                },
              });
            }
          }

          if (autoEditNodeId) {
            updatedNodes = updatedNodes.map(n => ({ ...n, selected: n.id === autoEditNodeId }));
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
    
    // Inject containerColour for conversion nodes inside containers (using positions from the rebuild)
    const containerArray = graph.containers || [];
    const containerRfNodes = newNodes.filter(n => n.id?.startsWith('container-'));
    const CONTAIN_TOL_SLOW = 10;
    const injectContainerColour = (node: any) => {
      if (node.type !== 'conversion') return node;
      const nw = DEFAULT_NODE_WIDTH;
      const nh = DEFAULT_NODE_HEIGHT;
      const nx = node.position?.x ?? 0;
      const ny = node.position?.y ?? 0;
      for (let ci = containerArray.length - 1; ci >= 0; ci--) {
        const cont = containerRfNodes.find(cn => cn.id === `container-${containerArray[ci].id}`);
        if (!cont) continue;
        const cx = cont.position?.x ?? 0;
        const cy = cont.position?.y ?? 0;
        const cw = typeof cont.style?.width === 'number' ? cont.style.width : 400;
        const ch = typeof cont.style?.height === 'number' ? cont.style.height : 300;
        if (nx >= (cx - CONTAIN_TOL_SLOW) && ny >= (cy - CONTAIN_TOL_SLOW) && (nx + nw) <= (cx + cw + CONTAIN_TOL_SLOW) && (ny + nh) <= (cy + ch + CONTAIN_TOL_SLOW)) {
          return { ...node, data: { ...node.data, containerColour: containerArray[ci].colour } };
        }
      }
      if (node.data?.containerColour) {
        const { containerColour: _, ...rest } = node.data;
        return { ...node, data: rest };
      }
      return node;
    };

    // Restore selection state + inject autoEdit flag for newly created post-its
    const autoEditNodeId = autoEditPostitIdRef.current ? `postit-${autoEditPostitIdRef.current}` : null;
    let nodesWithSelection = newNodes.map(node => {
      const withColour = injectContainerColour(node);
      const base = { ...withColour, selected: autoEditNodeId ? withColour.id === autoEditNodeId : selectedNodeIds.has(withColour.id) };
      if (autoEditNodeId && withColour.id === autoEditNodeId) {
        console.log(`[GraphCanvas] Injecting autoEdit for ${withColour.id}, selected=true`);
        autoEditPostitIdRef.current = null;
        return { ...base, data: { ...base.data, autoEdit: true } };
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

  // Compute face directions based on edge connections (for curved node outlines)
  // Runs after edges have been auto-routed and have sourceFace/targetFace assigned
  // Use useLayoutEffect + double-RAF for synchronous update after layout settles
  const faceDirectionRaf1Ref = useRef<number | null>(null);
  const faceDirectionRaf2Ref = useRef<number | null>(null);
  
  useLayoutEffect(() => {
    if (useSankeyView) return; // Skip in Sankey view - nodes stay flat
    if (edges.length === 0) return;
    
    // Cancel pending RAFs to coalesce updates
    if (faceDirectionRaf1Ref.current) cancelAnimationFrame(faceDirectionRaf1Ref.current);
    if (faceDirectionRaf2Ref.current) cancelAnimationFrame(faceDirectionRaf2Ref.current);
    
    faceDirectionRaf1Ref.current = requestAnimationFrame(() => {
      faceDirectionRaf2Ref.current = requestAnimationFrame(() => {
        // Count inbound/outbound edges per face for each node
        const faceStatsPerNode = new Map<string, Record<string, { in: number; out: number }>>();
    
    edges.forEach(edge => {
      const srcId = edge.source;
      const tgtId = edge.target;
      const srcFace = edge.data?.sourceFace;
      const tgtFace = edge.data?.targetFace;
      
      // Initialize stats for source node
      if (srcId && srcFace) {
        if (!faceStatsPerNode.has(srcId)) {
          faceStatsPerNode.set(srcId, {
            left: { in: 0, out: 0 },
            right: { in: 0, out: 0 },
            top: { in: 0, out: 0 },
            bottom: { in: 0, out: 0 },
          });
        }
        faceStatsPerNode.get(srcId)![srcFace].out += 1;
      }
      
      // Initialize stats for target node
      if (tgtId && tgtFace) {
        if (!faceStatsPerNode.has(tgtId)) {
          faceStatsPerNode.set(tgtId, {
            left: { in: 0, out: 0 },
            right: { in: 0, out: 0 },
            top: { in: 0, out: 0 },
            bottom: { in: 0, out: 0 },
          });
        }
        faceStatsPerNode.get(tgtId)![tgtFace].in += 1;
      }
    });
    
    // Classify each face direction and attach to nodes
    // Guard: only update if faceDirections actually changed
    setNodes(prevNodes => {
      let hasChanges = false;
      const newNodes = prevNodes.map(node => {
        const stats = faceStatsPerNode.get(node.id);
        
        const classifyFace = (face: 'left' | 'right' | 'top' | 'bottom'): 'flat' | 'convex' | 'concave' => {
          if (!stats) return 'flat';
          const s = stats[face];
          if (!s || (s.in === 0 && s.out === 0)) return 'flat';
          if (s.in > 0 && s.out === 0) return 'concave';
          if (s.out > 0 && s.in === 0) return 'convex';
          if (s.out > s.in) return 'convex';
          if (s.in > s.out) return 'concave';
          return 'flat'; // Tied
        };
        
        const newFaceDirections = {
          left: classifyFace('left'),
          right: classifyFace('right'),
          top: classifyFace('top'),
          bottom: classifyFace('bottom'),
        };
        
        // Check if this node's faceDirections actually changed
        const oldFaceDirections = node.data?.faceDirections;
        if (oldFaceDirections &&
            oldFaceDirections.left === newFaceDirections.left &&
            oldFaceDirections.right === newFaceDirections.right &&
            oldFaceDirections.top === newFaceDirections.top &&
            oldFaceDirections.bottom === newFaceDirections.bottom) {
          // No change
          return node;
        }
        
        hasChanges = true;
        return {
          ...node,
          data: {
            ...node.data,
            faceDirections: newFaceDirections
          }
        };
      });
      
      // Only return new array if there were actual changes
      return hasChanges ? newNodes : prevNodes;
    });
      });
    });
    
    return () => {
      if (faceDirectionRaf1Ref.current) cancelAnimationFrame(faceDirectionRaf1Ref.current);
      if (faceDirectionRaf2Ref.current) cancelAnimationFrame(faceDirectionRaf2Ref.current);
      faceDirectionRaf1Ref.current = null;
      faceDirectionRaf2Ref.current = null;
    };
  }, [edges, useSankeyView, setNodes]);

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
  const sankeyLayoutInProgressRef = useRef(false); // Gate reroutes/slow-path during Sankey layout
  const effectsCooldownUntilRef = useRef<number>(0); // Suppress effects until this timestamp (ms)
  const isEffectsCooldownActive = () => performance.now() < effectsCooldownUntilRef.current;
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
    
    // BLOCK ReactFlow→Graph sync during node dragging to prevent multiple graph updates
    if (isDraggingNodeRef.current) {
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

  // Function to check if adding an edge would create a cycle
  const wouldCreateCycle = useCallback((source: string, target: string, currentEdges: any[]) => {
    // Create a directed graph representation
    const graph: { [key: string]: string[] } = {};
    
    // Initialize all nodes
    nodes.forEach(node => {
      graph[node.id] = [];
    });
    
    // Add existing edges
    currentEdges.forEach(edge => {
      if (graph[edge.source]) {
        graph[edge.source].push(edge.target);
      }
    });
    
    // Add the proposed new edge
    if (graph[source]) {
      graph[source].push(target);
    }
    
    // DFS to detect cycles
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    
    const hasCycleDFS = (node: string): boolean => {
      if (recursionStack.has(node)) {
        return true; // Cycle detected
      }
      
      if (visited.has(node)) {
        return false; // Already processed
      }
      
      visited.add(node);
      recursionStack.add(node);
      
      const neighbors = graph[node] || [];
      for (const neighbor of neighbors) {
        if (hasCycleDFS(neighbor)) {
          return true;
        }
      }
      
      recursionStack.delete(node);
      return false;
    };
    
    // Check all nodes for cycles
    for (const nodeId of Object.keys(graph)) {
      if (!visited.has(nodeId)) {
        if (hasCycleDFS(nodeId)) {
          return true;
        }
      }
    }
    
    return false;
  }, [nodes]);

  // Track pending reconnections to prevent race conditions
  const pendingReconnectionRef = useRef<string | null>(null);
  const reconnectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Handle edge reconnection (dragging edge to new source/target)
  // ReactFlow v11 uses onReconnect with signature: (oldEdge, newConnection)
  const onEdgeUpdate = useCallback((oldEdge: Edge, newConnection: Connection) => {
    
    // Clear any existing timeout for this edge
    if (reconnectionTimeoutRef.current) {
      clearTimeout(reconnectionTimeoutRef.current);
      reconnectionTimeoutRef.current = null;
    }
    
    // If this is an invalid connection, ignore it
    if (!newConnection.source || !newConnection.target) {
      console.log('❌ REJECTED: Invalid connection (missing source/target)');
      return;
    }
    
    // CRITICAL: Only allow reconnection if edge is selected
    if (!oldEdge.selected) {
      console.log('❌ REJECTED: Edge not selected');
      return;
    }
    
    if (!graph) {
      console.log('❌ REJECTED: No graph available');
      return;
    }
    
    // Check for valid connection
    if (!newConnection.source || !newConnection.target) {
      console.log('❌ REJECTED: Missing source or target');
      console.log('╚════════════════════════════════════════════════════╝');
      return;
    }
    
    // Additional check: if this is an invalid connection (no target), ignore it
    // This prevents ReactFlow from calling us with invalid connections when mouseup happens outside nodes
    if (newConnection.target === null || newConnection.target === undefined) {
      console.log('❌ REJECTED: Invalid target (null/undefined)');
      return;
    }
    
    // Prevent self-referencing edges (but allow changing the handle on same nodes)
    if (newConnection.source === newConnection.target && 
        oldEdge.source === oldEdge.target) {
      console.log('❌ REJECTED: Cannot connect node to itself');
      return;
    }
    
    // Check for circular dependencies ONLY if source or target changed
    const nodesChanged = oldEdge.source !== newConnection.source || oldEdge.target !== newConnection.target;
    if (nodesChanged) {
      const reactFlowEdges = graph.edges
        .filter(e => e.uuid !== oldEdge.id) // oldEdge.id from ReactFlow is the edge UUID
        .map(e => ({ source: e.from, target: e.to }));
      if (wouldCreateCycle(newConnection.source, newConnection.target, reactFlowEdges)) {
        console.log('❌ REJECTED: Would create cycle');
        alert('Cannot create this connection as it would create a circular dependency.');
        return;
      }
    }
    
    console.log('✅ VALIDATION PASSED - Debouncing reconnection...');
    
    // Debounce the reconnection to handle multiple rapid calls
    reconnectionTimeoutRef.current = setTimeout(() => {
      console.log('🔄 Processing debounced reconnection...');
      
      // Update the edge in graph state
      const nextGraph = structuredClone(graph);
      
      // Try multiple ways to find the edge
      let edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === oldEdge.id || e.id === oldEdge.id);
      
      if (edgeIndex === -1) {
        // Try finding by source->target format
        const sourceTargetId = `${oldEdge.source}->${oldEdge.target}`;
        edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === sourceTargetId || e.id === sourceTargetId);
      }
      
      if (edgeIndex === -1) {
        // Try finding by from->to format (from/to could be uuid or id)
        edgeIndex = nextGraph.edges.findIndex((e: any) => 
          (e.from === oldEdge.source || e.from === oldEdge.source) && 
          (e.to === oldEdge.target || e.to === oldEdge.target)
        );
      }
      
      if (edgeIndex === -1) {
        console.log('❌ ERROR: Edge not found in graph:', oldEdge.id);
        console.log('Available edges:', nextGraph.edges.map((e: any) => e.id));
        return;
      }
      
      const originalEdge = { ...nextGraph.edges[edgeIndex] };
      
      console.log('');
      console.log('📊 PROBABILITY CHECK:');
      console.log('  Original edge probability:', originalEdge.p);
      
      // Update edge source/target and handles (source and target are guaranteed non-null by earlier check)
      nextGraph.edges[edgeIndex].from = newConnection.source!;
      nextGraph.edges[edgeIndex].to = newConnection.target!;
      
      // Map handle IDs to match our node component
      // Source handles: "top" -> "top-out", "left" -> "left-out", etc.
      // Target handles: keep as-is ("top", "left", "right", "bottom")
      const sourceHandle = newConnection.sourceHandle ? 
        (newConnection.sourceHandle.endsWith('-out') ? newConnection.sourceHandle : `${newConnection.sourceHandle}-out`) : 
        undefined;
      const targetHandle = newConnection.targetHandle || undefined;
      
      nextGraph.edges[edgeIndex].fromHandle = sourceHandle;
      nextGraph.edges[edgeIndex].toHandle = targetHandle;
      
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      
      console.log('Updated edge:');
      console.log('  from:', originalEdge.from, '→', nextGraph.edges[edgeIndex].from);
      console.log('  to:', originalEdge.to, '→', nextGraph.edges[edgeIndex].to);
      console.log('  fromHandle:', originalEdge.fromHandle, '→', nextGraph.edges[edgeIndex].fromHandle);
      console.log('  toHandle:', originalEdge.toHandle, '→', nextGraph.edges[edgeIndex].toHandle);
      console.log('  probability (p):', originalEdge.p, '→', nextGraph.edges[edgeIndex].p);
      console.log('✅ SUCCESS - Edge reconnected!');
      console.log('📊 Final edge object:', JSON.stringify(nextGraph.edges[edgeIndex], null, 2));
      
      // Prevent ReactFlow->Graph sync from overwriting this manual reconnection
      isSyncingRef.current = true;
      setGraph(nextGraph);
      
      // Prevent auto-reroute from overwriting manual handle selection
      skipNextRerouteRef.current = true;
      
      // Save history state for edge reconnection
      saveHistoryState('Reconnect edge', undefined, nextGraph.edges[edgeIndex].uuid || undefined);
      
      // Reset isSyncingRef after a short delay to allow Graph->ReactFlow sync to complete
      setTimeout(() => {
        isSyncingRef.current = false;
      }, 100);
    }, 50); // 50ms debounce
  }, [graph, setGraph, wouldCreateCycle, saveHistoryState]);

  // Generate a unique id for an edge based on node ids
  const generateEdgeId = useCallback((sourceId: string, targetId: string) => {
    if (!graph?.nodes) return `${sourceId}-to-${targetId}`;
    
    // Find source and target nodes to get their ids
    const sourceNode = graph.nodes.find((n: any) => n.uuid === sourceId || n.id === sourceId);
    const targetNode = graph.nodes.find((n: any) => n.uuid === targetId || n.id === targetId);
    
    const sourceId_ = sourceNode?.id || sourceNode?.uuid || sourceId;
    const targetId_ = targetNode?.id || targetNode?.uuid || targetId;
    
    let baseId = `${sourceId_}-to-${targetId_}`;
    let edgeId = baseId;
    let counter = 1;
    
    // Ensure uniqueness by appending a number if needed
    const existingIds = getAllExistingIds();
    const uniqueId = generateUniqueId(baseId, existingIds);
    
    return uniqueId;
  }, [graph, getAllExistingIds]);

  // Handle new connections
  const onConnect = useCallback(async (connection: Connection) => {
    if (!graph) return;
    
    // Capture the current graph at the start of this callback
    const currentGraph = graph;
    
    // Check for valid connection
    if (!connection.source || !connection.target) {
      return;
    }
    
    // Prevent self-referencing edges
    if (connection.source === connection.target) {
      alert('Cannot create an edge from a node to itself.');
      return;
    }

    // Check if source is a case node (do this check early)
    // connection.source is ReactFlow ID (uuid)
    const sourceNode = currentGraph.nodes.find(n => n.uuid === connection.source || n.id === connection.source);
    const isCaseNode = sourceNode && sourceNode.type === 'case' && sourceNode.case;
    
    // Prevent duplicate edges (but allow multiple edges from case nodes with different variants)
    if (!isCaseNode) {
      // For normal nodes, prevent any duplicate edges
      const existingEdge = currentGraph.edges.find(edge => 
        edge.from === connection.source && edge.to === connection.target
      );
      if (existingEdge) {
        alert('An edge already exists between these nodes.');
        return;
      }
    }
    // For case nodes, duplication check will happen after variant selection

    // Check for circular dependencies (convert graph edges to ReactFlow format for check)
    const reactFlowEdges = currentGraph.edges.map(e => ({ source: e.from, target: e.to }));
    if (wouldCreateCycle(connection.source, connection.target, reactFlowEdges)) {
      alert('Cannot create this connection as it would create a circular dependency.');
      return;
    }

    // If source is a case node with multiple variants, show variant selection modal
    if (isCaseNode && sourceNode.case && sourceNode.case.variants.length > 1) {
      setPendingConnection(connection);
      setCaseNodeVariants(sourceNode.case.variants);
      setShowVariantModal(true);
      return; // Don't create the edge yet, wait for variant selection
    }
    
    // Use UpdateManager to create edge with proper ID generation and probability calculation
    const { updateManager } = await import('../services/UpdateManager');
    const options: any = {};
    
    // If source is a case node with single variant, automatically assign variant properties
    if (isCaseNode && sourceNode.case && sourceNode.case.variants.length === 1) {
      const variant = sourceNode.case.variants[0];
      options.case_id = sourceNode.case.id;
      options.case_variant = variant.name;
    }
    
    const { graph: nextGraph, edgeId } = updateManager.createEdge(
      currentGraph,
      {
        source: connection.source!,
        target: connection.target!,
        sourceHandle: connection.sourceHandle || null,
        targetHandle: connection.targetHandle || null
      },
      options
    );
    
    // Single path: route through GraphCanvas setGraph wrapper (avoids nested updateGraph calls)
    await setGraph(nextGraph, currentGraph, 'add-edge');
    saveHistoryState('Add edge', undefined, edgeId);
    
    // Select the new edge after a brief delay to allow sync to complete
    setTimeout(() => {
      onSelectedEdgeChange(edgeId);
    }, 50);
  }, [graph, setGraph, wouldCreateCycle, onSelectedEdgeChange, saveHistoryState]);

  // Variant selection modal state
  const [showVariantModal, setShowVariantModal] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null);
  const [caseNodeVariants, setCaseNodeVariants] = useState<any[]>([]);

  // Handle variant selection for case edges
  const handleVariantSelection = useCallback(async (variant: any) => {
    if (!pendingConnection || !graph) return;
    
    // Capture the current graph at the start of this callback
    const currentGraph = graph;
    
    // pendingConnection.source is ReactFlow ID (uuid)
    const sourceNode = currentGraph.nodes.find(n => n.uuid === pendingConnection.source || n.id === pendingConnection.source);
    if (!sourceNode || !sourceNode.case) return;
    
    // Check if an edge with this variant already exists between these nodes
    const existingVariantEdge = currentGraph.edges.find(edge => 
      edge.from === pendingConnection.source && 
      edge.to === pendingConnection.target &&
      edge.case_id === sourceNode.case?.id &&
      edge.case_variant === variant.name
    );
    
    if (existingVariantEdge) {
      alert(`An edge for variant "${variant.name}" already exists between these nodes.`);
      setShowVariantModal(false);
      setPendingConnection(null);
      setCaseNodeVariants([]);
      return;
    }
    
    // Use UpdateManager to create edge with variant properties
    const { updateManager } = await import('../services/UpdateManager');
    const { graph: nextGraph, edgeId } = updateManager.createEdge(
      currentGraph,
      {
        source: pendingConnection.source!,
        target: pendingConnection.target!,
        sourceHandle: pendingConnection.sourceHandle || null,
        targetHandle: pendingConnection.targetHandle || null
      },
      {
        case_variant: variant.name
        // case_id will be automatically inferred from source node by UpdateManager
      }
    );
    
    // Single path: route through GraphCanvas setGraph wrapper (avoids nested updateGraph calls)
    await setGraph(nextGraph, currentGraph, 'add-edge-variant');
    saveHistoryState('Add edge', undefined, edgeId);
    
    // Close modal and clear state
    setShowVariantModal(false);
    setPendingConnection(null);
    setCaseNodeVariants([]);
  }, [pendingConnection, graph, setGraph, saveHistoryState]);
  
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
          const nodeRect = {
            left: node.position.x,
            top: node.position.y,
            right: node.position.x + DEFAULT_NODE_WIDTH, // Approximate node width
            bottom: node.position.y + 60  // Approximate node height
          };

          const intersects = !(nodeRect.right < lassoRect.left || 
                             nodeRect.left > lassoRect.right || 
                             nodeRect.bottom < lassoRect.top || 
                             nodeRect.top > lassoRect.bottom);
          

          return intersects;
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
  }, [isShiftHeld, isLassoSelecting, lassoStart, lassoEnd, nodes, setNodes, edges, deleteSelected, tabId]);


  // Track selected nodes for probability calculation
  const [selectedNodesForAnalysis, setSelectedNodesForAnalysis] = useState<any[]>([]);

  // Helper function to find start nodes (nodes with no incoming edges)
  const findStartNodes = useCallback((allNodes: any[], allEdges: any[]): any[] => {
    const nodesWithIncoming = new Set(allEdges.map(edge => edge.target));
    return allNodes.filter(node => !nodesWithIncoming.has(node.id));
  }, []);

  // DFS function to find all paths between two nodes (with depth limit to prevent infinite loops)
  const findAllPaths = useCallback((sourceId: string, targetId: string, allEdges: any[], maxDepth: number = 10) => {
    const paths: string[][] = [];
    const visited = new Set<string>();
    
    const dfs = (currentNodeId: string, currentPath: string[], depth: number) => {
      // Limit depth to prevent infinite loops in complex graphs
      if (depth > maxDepth) return;
      
      if (currentNodeId === targetId) {
        paths.push([...currentPath]);
        return;
      }
      
      if (visited.has(currentNodeId)) return;
      visited.add(currentNodeId);
      
      // Find all outgoing edges from current node
      const outgoingEdges = allEdges.filter(edge => edge.source === currentNodeId);
      
      for (const edge of outgoingEdges) {
        if (!currentPath.includes(edge.id)) { // Avoid cycles
          currentPath.push(edge.id);
          dfs(edge.target, currentPath, depth + 1);
          currentPath.pop(); // Backtrack
        }
      }
      
      visited.delete(currentNodeId); // Allow revisiting for other paths
    };
    
    dfs(sourceId, [], 0);
    return paths;
  }, []);

  // Helper function to topologically sort nodes
  const topologicalSort = useCallback((nodeIds: string[], allEdges: any[]): string[] => {
    // Build adjacency list and in-degree map for selected nodes
    // But consider ALL edges in the graph to determine reachability
    const adjList = new Map<string, string[]>();
    const inDegree = new Map<string, number>();
    
    // Initialize
    nodeIds.forEach(id => {
      adjList.set(id, []);
      inDegree.set(id, 0);
    });
    
    // For each pair of selected nodes, check if one can reach the other
    // and build the dependency graph accordingly
    const selectedNodeSet = new Set(nodeIds);
    
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = 0; j < nodeIds.length; j++) {
        if (i !== j) {
          const sourceId = nodeIds[i];
          const targetId = nodeIds[j];
          
          // Check if there's ANY path from sourceId to targetId using ALL graph edges
          const hasPath = findAllPaths(sourceId, targetId, allEdges).length > 0;
          
          if (hasPath) {
            // Add edge in our dependency graph
            if (!adjList.get(sourceId)!.includes(targetId)) {
              adjList.get(sourceId)!.push(targetId);
              inDegree.set(targetId, inDegree.get(targetId)! + 1);
            }
          }
        }
      }
    }
    
    // Kahn's algorithm
    const queue: string[] = [];
    const sorted: string[] = [];
    
    // Add nodes with no incoming edges to queue
    inDegree.forEach((degree, nodeId) => {
      if (degree === 0) queue.push(nodeId);
    });
    
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);
      
      // Reduce in-degree for neighbors
      adjList.get(current)!.forEach(neighbor => {
        const newDegree = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      });
    }
    
    // If not all nodes were sorted, there's a cycle - return original order
    return sorted.length === nodeIds.length ? sorted : nodeIds;
  }, [findAllPaths]);

  // Helper function to check if nodes are topologically sequential
  const areNodesTopologicallySequential = useCallback((sortedNodeIds: string[], allEdges: any[]): boolean => {
    // Check if there's a path connecting consecutive nodes in the sorted order
    for (let i = 0; i < sortedNodeIds.length - 1; i++) {
      const paths = findAllPaths(sortedNodeIds[i], sortedNodeIds[i + 1], allEdges);
      if (paths.length === 0) {
        return false; // No path between consecutive nodes
      }
    }
    return true;
  }, [findAllPaths]);

  // Function to find all edges that are part of paths between selected nodes
  const findPathEdges = useCallback((selectedNodes: any[], allEdges: any[]): Set<string> => {
    if (selectedNodes.length === 0) return new Set<string>();
    
    // Special case: 1 node - highlight upstream and downstream edges with depth-based fading
    if (selectedNodes.length === 1) {
      const selectedId = selectedNodes[0].id;
      const pathEdges = new Set<string>();
      
      // Helper to recursively find upstream edges with depth
      const findUpstreamEdges = (nodeId: string, depth: number, visited = new Set<string>()) => {
        if (visited.has(nodeId) || depth > 5) return;
        visited.add(nodeId);
        
        allEdges.forEach(edge => {
          if (edge.target === nodeId) {
            pathEdges.add(edge.id);
            findUpstreamEdges(edge.source, depth + 1, visited);
          }
        });
      };
      
      // Helper to recursively find downstream edges with depth
      const findDownstreamEdges = (nodeId: string, depth: number, visited = new Set<string>()) => {
        if (visited.has(nodeId) || depth > 5) return;
        visited.add(nodeId);
        
        allEdges.forEach(edge => {
          if (edge.source === nodeId) {
            pathEdges.add(edge.id);
            findDownstreamEdges(edge.target, depth + 1, visited);
          }
        });
      };
      
      // Find both upstream and downstream edges
      findUpstreamEdges(selectedId, 0);
      findDownstreamEdges(selectedId, 0);
      
      return pathEdges;
    }
    
    if (selectedNodes.length < 2) return new Set<string>();
    
    const selectedNodeIds = selectedNodes.map(node => node.id);
    const pathEdges = new Set<string>();
    
    // Special case: 3+ nodes - check if topologically sequential
    if (selectedNodes.length >= 3) {
      const sortedNodeIds = topologicalSort(selectedNodeIds, allEdges);
      const isSequential = areNodesTopologicallySequential(sortedNodeIds, allEdges);
      
      if (isSequential) {
        // Find path from first to last node, given intermediate nodes
        const firstNodeId = sortedNodeIds[0];
        const lastNodeId = sortedNodeIds[sortedNodeIds.length - 1];
        const intermediateIds = sortedNodeIds.slice(1, -1);
        
        // Find all paths from first to last that go through all intermediates
        const findPathsThroughNodes = (
          currentId: string,
          remainingNodes: string[],
          currentPath: string[]
        ): string[][] => {
          if (remainingNodes.length === 0) {
            // Reached the end, return the path
            return [currentPath];
          }
          
          const nextNode = remainingNodes[0];
          const restNodes = remainingNodes.slice(1);
          const allPaths: string[][] = [];
          
          // Find all paths from current to next node
          const paths = findAllPaths(currentId, nextNode, allEdges);
          paths.forEach(path => {
            allPaths.push(...findPathsThroughNodes(nextNode, restNodes, [...currentPath, ...path]));
          });
          
          return allPaths;
        };
        
        const paths = findPathsThroughNodes(firstNodeId, [...intermediateIds, lastNodeId], []);
        paths.forEach(path => {
          path.forEach(edgeId => pathEdges.add(edgeId));
        });
        
        return pathEdges;
      }
    }
    
    // Default case: For each pair of selected nodes, find all paths between them
    for (let i = 0; i < selectedNodeIds.length; i++) {
      for (let j = i + 1; j < selectedNodeIds.length; j++) {
        const sourceId = selectedNodeIds[i];
        const targetId = selectedNodeIds[j];
        
        // Find all paths from source to target
        const paths = findAllPaths(sourceId, targetId, allEdges);
        
        // Add all edges from all paths to the set
        paths.forEach(path => {
          path.forEach(edgeId => pathEdges.add(edgeId));
        });
        
        // Also find paths in reverse direction (target to source)
        const reversePaths = findAllPaths(targetId, sourceId, allEdges);
        reversePaths.forEach(path => {
          path.forEach(edgeId => pathEdges.add(edgeId));
        });
      }
    }
    
    return pathEdges;
  }, [nodes, findStartNodes, topologicalSort, areNodesTopologicallySequential, findAllPaths]);

  // STEP 4: Compute highlight metadata (don't mutate edges state)
  // This will be passed into buildScenarioRenderEdges to apply to 'current' layer only
  // OPTIMIZATION: Use stable edge IDs array to avoid unnecessary recalculations
  const edgeIdsRef = React.useRef<string>('');
  const currentEdgeIds = edges.map(e => e.id).sort().join(',');
  const edgesChanged = edgeIdsRef.current !== currentEdgeIds;
  if (edgesChanged) {
    edgeIdsRef.current = currentEdgeIds;
  }
  
  // Only recalculate highlight metadata when node selection changes OR edges topology changes
  // This prevents recalculation when only edges are selected
  const nodeSelectionKey = selectedNodesForAnalysis.map(n => n.id).sort().join(',');
  const highlightMetadata = React.useMemo(() => {
    if (selectedNodesForAnalysis.length === 0) {
      return {
        highlightedEdgeIds: new Set<string>(),
        edgeDepthMap: new Map<string, number>(),
        isSingleNodeSelection: false
      };
    }
    
    // Calculate highlight depths for single node selection
    const edgeDepthMap = new Map<string, number>();
    
    if (selectedNodesForAnalysis.length === 1) {
      const selectedId = selectedNodesForAnalysis[0].id;
      
      // Calculate upstream depths
      const calculateUpstreamDepths = (nodeId: string, depth: number, visited = new Set<string>()) => {
        if (visited.has(nodeId) || depth > 5) return;
        visited.add(nodeId);
        
        edges.forEach(edge => {
          if (edge.target === nodeId) {
            const existingDepth = edgeDepthMap.get(edge.id);
            if (existingDepth === undefined || depth < existingDepth) {
              edgeDepthMap.set(edge.id, depth);
            }
            calculateUpstreamDepths(edge.source, depth + 1, visited);
          }
        });
      };
      
      // Calculate downstream depths
      const calculateDownstreamDepths = (nodeId: string, depth: number, visited = new Set<string>()) => {
        if (visited.has(nodeId) || depth > 5) return;
        visited.add(nodeId);
        
        edges.forEach(edge => {
          if (edge.source === nodeId) {
            const existingDepth = edgeDepthMap.get(edge.id);
            if (existingDepth === undefined || depth < existingDepth) {
              edgeDepthMap.set(edge.id, depth);
            }
            calculateDownstreamDepths(edge.target, depth + 1, visited);
          }
        });
      };
      
      calculateUpstreamDepths(selectedId, 0);
      calculateDownstreamDepths(selectedId, 0);
    }
    
    const pathEdges = findPathEdges(selectedNodesForAnalysis, edges);
    const isSingleNodeSelection = selectedNodesForAnalysis.length === 1;
    
    return {
      highlightedEdgeIds: pathEdges,
      edgeDepthMap,
      isSingleNodeSelection
    };
  }, [selectedNodesForAnalysis, nodeSelectionKey, edges, findPathEdges, edgesChanged]); 

  // Handle selection changes
  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: any) => {
    
    // In pan mode, suppress all selection
    if (activeElementTool === 'pan') {
      return;
    }
    
    // Update selected nodes for analysis
    setSelectedNodesForAnalysis(selectedNodes);
    
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
  }, [onSelectedNodeChange, onSelectedEdgeChange, onSelectedAnnotationChange, isLassoSelecting, setSelectedNodesForAnalysis, activeElementTool]);

  // Track whether the current drag actually moved the node (vs. a simple click)
  const hasNodeMovedRef = useRef(false);

  // Group drag state for containers
  const containerDragContainedRef = useRef<Set<string> | null>(null);
  const containerDragLastPosRef = useRef<{ x: number; y: number } | null>(null);

  // Handle node drag start - set flag and start failsafe timeout
  const onNodeDragStart = useCallback((_event: any, _node: any) => {
    hasNodeMovedRef.current = false;

    // Block Graph→ReactFlow sync during drag to prevent interruption
    isDraggingNodeRef.current = true;
    setIsDraggingNode(true);

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
      }
      dragTimeoutRef.current = null;
    }, 5000);
  }, [nodes]);

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
    // Clear container group drag state
    containerDragContainedRef.current = null;
    containerDragLastPosRef.current = null;
    // Keep drag flag set - it will be cleared by the sync effect when it takes the fast path
    // Use double requestAnimationFrame to ensure ReactFlow has finished updating node positions
    // and React has re-rendered before we sync to graph store and trigger edge recalculation
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setIsDraggingNode(false);
        
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
              // Clear syncing flag after a brief delay
              setTimeout(() => {
                isSyncingRef.current = false;
              }, 0);
            } else {
              // No position change, clear flag immediately
              isDraggingNodeRef.current = false;
            }
          } else {
            // No graph update, clear flag immediately
            isDraggingNodeRef.current = false;
          }
          
          // Save the FINAL position to history after the ReactFlow→Store sync completes
          // Use setTimeout to ensure sync completes first
          setTimeout(() => {
            saveHistoryState('Move node');
          }, 0);
        } else {
          // Click-only (no movement) - just clear drag flag, no graph update or history entry
          isDraggingNodeRef.current = false;
        }
      });
    });
  }, [saveHistoryState, graph, nodes, edges, setGraph]);

  // Cleanup drag timeout on unmount
  useEffect(() => {
    return () => {
      if (dragTimeoutRef.current) {
        clearTimeout(dragTimeoutRef.current);
        dragTimeoutRef.current = null;
      }
    };
  }, []);

  // Add new node
  const addNode = useCallback(() => {
    console.log('addNode function called');
    if (!graph) return;
    
    const newId = crypto.randomUUID();
    
    // Generate initial label (but no id - user should pick from registry)
    const label = `Node ${graph.nodes.length + 1}`;
    
    // Place node at center of current viewport
    const viewportCenter = screenToFlowPosition({ 
      x: window.innerWidth / 2, 
      y: window.innerHeight / 2 
    });
    
    // Add node directly to graph state (not ReactFlow state)
    const nextGraph = structuredClone(graph);
    nextGraph.nodes.push({
      uuid: newId,
      id: '', // Empty ID - user should assign a node_id from registry
      label: label,
      absorbing: false,
      layout: {
        x: viewportCenter.x,
        y: viewportCenter.y
      }
    });
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    setGraph(nextGraph);
    
    console.log('saveHistoryState function:', typeof saveHistoryState);
    if (typeof saveHistoryState === 'function') {
      saveHistoryState('Add node', newId);
    } else {
      console.error('saveHistoryState is not a function:', saveHistoryState);
    }
    
    // Select the new node after a brief delay to allow sync to complete
    setTimeout(() => {
      // Select in ReactFlow (visual selection)
      setNodes((nodes) => 
        nodes.map((node) => ({
          ...node,
          selected: node.id === newId
        }))
      );
      // Notify parent (PropertiesPanel)
      onSelectedNodeChange(newId);
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

  // Auto-layout function using dagre
  const performAutoLayout = useCallback((direction?: 'LR' | 'RL' | 'TB' | 'BT') => {
    if (!graph) return;
    
    // Use provided direction or fall back to state
    const effectiveDirection = direction || layoutDirection;
    
    // Determine which nodes to layout
    const selectedNodes = nodes.filter(n => n.selected);
    const nodesToLayout = selectedNodes.length > 0 ? selectedNodes : nodes;
    const nodeIdsToLayout = new Set(nodesToLayout.map(n => n.id));
    
    if (nodesToLayout.length === 0) return;
    
    // Create a new dagre graph
    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setDefaultEdgeLabel(() => ({}));
    
    // Configure layout direction and spacing
    // In Sankey mode, reduce vertical spacing for tighter packing
    // nodesep is the minimum gap between node EDGES (not centers) in the same rank
    const nodeSpacing = useSankeyView ? 20 : 60;  // Vertical spacing between nodes in same rank (tight in Sankey)
    const rankSpacing = useSankeyView ? 250 : 150; // Horizontal spacing between ranks
    
    dagreGraph.setGraph({ 
      rankdir: effectiveDirection, // User-selected direction
      nodesep: nodeSpacing,   // Spacing between nodes in same rank (vertical in LR mode)
      ranksep: rankSpacing,   // Spacing between ranks (horizontal in LR mode)
      edgesep: 20,   // Minimum separation between edges (encourages straighter edges)
      marginx: 40,   // Midpoint margins
      marginy: 40,
      // ranker: 'tight-tree' // Try tight-tree ranker for better Sankey layouts
    });
    
    // Add nodes to dagre graph
    nodesToLayout.forEach((node) => {
      // Node dimensions - in Sankey mode, height is set via style.height or data.sankeyHeight
      let width = node.width || (node.data?.type === 'case' ? 96 : DEFAULT_NODE_WIDTH);
      let height = node.height || (node.data?.type === 'case' ? 96 : DEFAULT_NODE_HEIGHT);
      
      // In Sankey mode, use the calculated Sankey height
      if (useSankeyView && node.data?.sankeyHeight) {
        height = node.data.sankeyHeight;
        width = node.data.sankeyWidth || DEFAULT_NODE_WIDTH;
        console.log(`[Dagre] Sankey node ${node.data?.label}: using sankeyHeight=${height}, sankeyWidth=${width}, node.width=${node.width}, node.height=${node.height}, style.height=${(node as any).style?.height}`);
      } else {
        console.log(`[Dagre] Normal node ${node.data?.label}: using width=${width}, height=${height}`);
      }
      
      dagreGraph.setNode(node.id, { width, height });
    });
    
    // Add edges to dagre graph (only edges between nodes being laid out)
    edges.forEach((edge) => {
      if (nodeIdsToLayout.has(edge.source) && nodeIdsToLayout.has(edge.target)) {
        dagreGraph.setEdge(edge.source, edge.target);
      }
    });
    
    // Verify node dimensions before layout
    if (useSankeyView) {
      console.log('[Dagre] Node dimensions BEFORE layout:');
      dagreGraph.nodes().forEach((nodeId) => {
        const node = dagreGraph.node(nodeId);
        console.log(`  ${nodeId}: width=${node.width}, height=${node.height}`);
      });
    }
    
    // Run the layout algorithm
    dagre.layout(dagreGraph);
    
    // Verify positions after layout
    if (useSankeyView) {
      console.log('[Dagre] Node positions AFTER layout:');
      dagreGraph.nodes().forEach((nodeId) => {
        const node = dagreGraph.node(nodeId);
        console.log(`  ${nodeId}: x=${node.x}, y=${node.y}, width=${node.width}, height=${node.height}`);
      });
    }
    
    // Apply the layout to the graph
    const nextGraph = structuredClone(graph);
    dagreGraph.nodes().forEach((nodeId) => {
      const dagreNode = dagreGraph.node(nodeId);
      const graphNode = nextGraph.nodes.find((n: any) => n.uuid === nodeId || n.id === nodeId);
      
      if (graphNode) {
        if (!graphNode.layout) graphNode.layout = { x: 0, y: 0 };
        // Dagre gives us center coordinates, so no need to adjust
        graphNode.layout.x = dagreNode.x;
        graphNode.layout.y = dagreNode.y;
      }
    });
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Update graph - this will trigger sync
    setGraph(nextGraph);
    
    // Save history state for auto-layout
    saveHistoryState('Auto-layout', undefined, undefined);
    
    // ALWAYS trigger re-route after layout (regardless of autoReroute setting)
    setTimeout(() => {
      console.log('Triggering FORCED re-route after auto-layout');
      setForceReroute(true); // Force re-route even if autoReroute is off
      
      // Fit view after re-route completes
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

  // Sankey auto-layout using d3-sankey
  const performSankeyLayout = useCallback(() => {
    if (!graph) return;
    
    // Begin layout transaction: block effects and start cooldown window
    sankeyLayoutInProgressRef.current = true;
    effectsCooldownUntilRef.current = performance.now() + 800; // 0.8s settle window
    
    // Determine which nodes to layout
    const selectedNodes = nodes.filter(n => n.selected);
    const nodesToLayout = selectedNodes.length > 0 ? selectedNodes : nodes;
    const nodeIdsToLayout = new Set(nodesToLayout.map(n => n.id));
    
    if (nodesToLayout.length === 0) return;
    
    // Build d3-sankey compatible data structure
    const sankeyNodes: any[] = [];
    const sankeyLinks: any[] = [];
    
    // Add nodes with their current heights
    nodesToLayout.forEach((node) => {
      const height = node.data?.sankeyHeight || (node.data?.type === 'case' ? 96 : DEFAULT_NODE_HEIGHT);
      sankeyNodes.push({
        id: node.id,
        name: node.data?.label || node.id,
        fixedValue: height, // Force node height: d3-sankey will respect fixedValue
        height: height,     // Keep for our internal extent and spacing calculations
      });
    });
    
    // Add edges (only between nodes being laid out)
    // d3-sankey with .nodeId() set expects source/target to be the node IDs (strings)
    edges.forEach((edge) => {
      if (nodeIdsToLayout.has(edge.source) && nodeIdsToLayout.has(edge.target)) {
        // Use edge visual width for link value; ensure non-trivial magnitude
        const raw = edge.data?.scaledWidth ?? 1;
        const linkValue = Math.max(1, raw); // clamp min 1 to avoid degenerate links
        sankeyLinks.push({
          source: edge.source,  // Use node ID directly, not index
          target: edge.target,  // Use node ID directly, not index
          value: linkValue,
        });
      }
    });
    
    console.log('[Sankey Layout] Nodes:', sankeyNodes.length, 'Links:', sankeyLinks.length);
    
    // ===== ADAPTIVE SANKEY LAYOUT POLICY =====
    // Constants
    const nodeWidth = DEFAULT_NODE_WIDTH;
    const margin = 40;
    const viewportWidth = 1800; // Approximate available canvas width
    
    // Calculate number of columns (depth) by doing a simple rank assignment
    const nodeDepths = new Map<string, number>();
    const visited = new Set<string>();
    const calculateDepth = (nodeId: string, depth: number = 0) => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      nodeDepths.set(nodeId, Math.max(nodeDepths.get(nodeId) || 0, depth));
      
      // Find all outgoing edges
      sankeyLinks.forEach(link => {
        if (link.source === nodeId) {
          calculateDepth(link.target, depth + 1);
        }
      });
    };
    
    // Start from nodes with no incoming edges
    const nodesWithIncoming = new Set(sankeyLinks.map(l => l.target));
    sankeyNodes.forEach(node => {
      if (!nodesWithIncoming.has(node.id)) {
        calculateDepth(node.id, 0);
      }
    });
    
    const maxDepth = Math.max(...Array.from(nodeDepths.values()), 0);
    const D = maxDepth + 1; // Number of columns
    
    // Calculate nodes per column and heights per column
    const countsPerColumn = new Array(D).fill(0);
    const heightsPerColumn = new Array(D).fill(0);
    sankeyNodes.forEach(node => {
      const depth = nodeDepths.get(node.id) || 0;
      countsPerColumn[depth]++;
      heightsPerColumn[depth] += node.height;
    });
    const countsMax = Math.max(...countsPerColumn);
    const HcolMax = Math.max(...heightsPerColumn);
    
    // Calculate node height stats
    const Havg = sankeyNodes.reduce((sum, n) => sum + n.height, 0) / sankeyNodes.length;
    const Hmax = Math.max(...sankeyNodes.map(n => n.height));
    
    // Calculate max link value
    const Lmax = sankeyLinks.length > 0 ? Math.max(...sankeyLinks.map(l => l.value)) : 1;
    const E = sankeyLinks.length;
    
    // === Horizontal spacing G (column gap) ===
    // Use simpler, more generous spacing to give d3-sankey freedom
    let G: number;
    if (D <= 3) G = 250;
    else if (D <= 6) G = 200;
    else G = 150;
    
    // === Vertical node padding P ===
    // Adaptive padding: balance density vs. graph depth
    // Deep graphs need more padding even when dense
    let P: number;
    if (countsMax >= 6) {
      // Dense columns: scale padding with depth to avoid cramming in deep graphs
      P = D >= 8 ? 25 : D >= 6 ? 20 : 15;
    } else if (countsMax >= 4) {
      P = 25;
    } else {
      P = 35; // Sparse columns get more breathing room
    }
    
    // === Calculate extent ===
    let W = margin * 2 + D * nodeWidth + (D - 1) * G;
    // Force extra vertical space to ensure padding is respected
    // Add 50% more to the calculated padding space to prevent compression
    let H = margin * 2 + Math.max(...heightsPerColumn.map((h, i) => 
      h + (countsPerColumn[i] - 1) * P * 1.5
    ));
    // Ensure minimum height to prevent vertical cramming
    H = Math.max(H, 600);
    
    // Viewport fit pass (scale G only)
    if (W > 1.25 * viewportWidth) {
      const scale = Math.max(0.7, Math.min(1.0, (1.25 * viewportWidth) / W));
      G = G * scale;
      W = margin * 2 + D * nodeWidth + (D - 1) * G;
    } else if (W < 0.8 * viewportWidth) {
      const scale = Math.max(1.0, Math.min(1.2, (0.8 * viewportWidth) / W));
      G = G * scale;
      W = margin * 2 + D * nodeWidth + (D - 1) * G;
    }
    
    // === Alignment ===
    const alignment = countsMax >= 4 ? sankeyJustify : sankeyCenter;
    
    // === Iterations ===
    let iterations: number;
    if (E <= 150) iterations = 32;
    else if (E <= 300) iterations = 48;
    else iterations = 64;
    
    console.log(`[Sankey Layout] Adaptive settings: D=${D}, countsMax=${countsMax}, G=${G.toFixed(0)}, P=${P}, W=${W.toFixed(0)}, H=${H.toFixed(0)}, iterations=${iterations}`);
    
    // Create and configure the sankey layout
    const sankeyGenerator = sankey()
      .nodeId((d: any) => d.id)
      .nodeWidth(nodeWidth)
      .nodePadding(P)
      .extent([[margin, margin], [W - margin, H - margin]])
      .nodeAlign(alignment)
      .iterations(iterations);
    
    // Run the layout
    const sankeyGraph = sankeyGenerator({
      nodes: sankeyNodes,
      links: sankeyLinks,
    });
    
    console.log('[Sankey Layout] Layout computed, applying positions');
    console.log('[Sankey Layout] Sample sankeyNode:', sankeyGraph.nodes[0]);

    // Flag: layout in progress to suppress cascading side-effects
    sankeyLayoutInProgressRef.current = true;

    // Note: we will not touch ReactFlow node state here; we only update graph layout
    
    // Apply the layout to the graph
    const nextGraph = structuredClone(graph);
    sankeyGraph.nodes.forEach((sankeyNode: any) => {
      const graphNode = nextGraph.nodes.find((n: any) => n.uuid === sankeyNode.id || n.id === sankeyNode.id);
      
      if (graphNode) {
        if (!graphNode.layout) graphNode.layout = { x: 0, y: 0 };
        
        // Check if d3-sankey actually computed positions
        if (sankeyNode.x0 === undefined || sankeyNode.y0 === undefined) {
          console.error(`[Sankey Layout] Node ${graphNode.label} has no x0/y0! Node:`, sankeyNode);
          return;
        }
        
        // d3-sankey gives us x0,y0 (top-left) coordinates
        // Store these as TOP-LEFT in graph.layout for Sankey mode
        // toFlow will convert them to ReactFlow positions appropriately
        const topLeftX = sankeyNode.x0;
        const topLeftY = sankeyNode.y0;
        
        // Store the height as a temporary property for toFlow conversion
        const sankeyHeight = sankeyNode.y1 - sankeyNode.y0;
        // Use a temporary property on the layout object (not .data which doesn't exist on graph schema)
        (graphNode.layout as any).sankeyHeight = sankeyHeight;
        
        console.log(`[Sankey Layout] Node ${graphNode.label}: OLD x=${graphNode.layout.x}, y=${graphNode.layout.y} → NEW x=${topLeftX.toFixed(0)}, y=${topLeftY.toFixed(0)} (top-left), height=${sankeyHeight.toFixed(0)}`);
        
        graphNode.layout.x = topLeftX;
        graphNode.layout.y = topLeftY;
      }
    });
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Skip node sizing effect after layout (heights are already set upstream)
    skipSankeyNodeSizingRef.current = true;
    
    // Update graph - this will trigger sync
    setGraph(nextGraph);
    
    // Save history state for auto-layout
    saveHistoryState('Sankey auto-layout', undefined, undefined);
    
    // End layout without forcing reroute; clear flag after a short delay + cooldown
    setTimeout(() => {
      sankeyLayoutInProgressRef.current = false;
      effectsCooldownUntilRef.current = performance.now() + 500; // post-layout cooldown
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

  // Close context menus on any click
  useEffect(() => {
    if (contextMenu || nodeContextMenu || postitContextMenu || containerContextMenu || analysisContextMenu || edgeContextMenu) {
      const handleClick = () => {
        setContextMenu(null);
        setNodeContextMenu(null);
        setPostitContextMenu(null);
        setContainerContextMenu(null);
        setAnalysisContextMenu(null);
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
  }, [contextMenu, nodeContextMenu, edgeContextMenu]);

  // Add node at specific position
  const addNodeAtPosition = useCallback((x: number, y: number) => {
    if (!graph) return;
    
    const newId = crypto.randomUUID();
    const label = `Node ${graph.nodes.length + 1}`;
    
    const newNode = {
      uuid: newId,
      id: '', // Empty ID - user should assign a node_id from registry
      label: label,
      absorbing: false,
      layout: {
        x: x,
        y: y
      }
    };
    
    const nextGraph = structuredClone(graph);
    nextGraph.nodes.push(newNode);
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    setGraph(nextGraph);
    
    console.log('saveHistoryState in addNodeAtPosition:', typeof saveHistoryState, saveHistoryState);
    if (typeof saveHistoryState === 'function') {
      saveHistoryState('Add node', newId);
    } else {
      console.error('saveHistoryState is not a function in addNodeAtPosition:', saveHistoryState);
    }
    setContextMenu(null);
    
    // Select the new node after a brief delay to allow sync to complete
    setTimeout(() => {
      // Select in ReactFlow (visual selection)
      setNodes((nodes) => 
        nodes.map((node) => ({
          ...node,
          selected: node.id === newId
        }))
      );
      // Notify parent (PropertiesPanel)
      onSelectedNodeChange(newId);
    }, 50);
  }, [graph, setGraph, saveHistoryState, setNodes, onSelectedNodeChange]);

  const addPostitAtPosition = useCallback((x: number, y: number, w?: number, h?: number) => {
    if (!graph) return;
    
    const newId = crypto.randomUUID();
    const nextGraph = structuredClone(graph);
    if (!nextGraph.postits) nextGraph.postits = [];
    nextGraph.postits.push({
      id: newId,
      text: '',
      colour: '#FFF475',
      width: w && w >= 50 ? Math.round(w) : 200,
      height: h && h >= 50 ? Math.round(h) : 150,
      x: Math.round(x),
      y: Math.round(y),
    });
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    setGraph(nextGraph);
    saveHistoryState('Add post-it');
    setContextMenu(null);
    
    autoEditPostitIdRef.current = newId;
    onSelectedNodeChange(null);
    onSelectedEdgeChange(null);
    onSelectedAnnotationChange?.(newId, 'postit');
  }, [graph, setGraph, saveHistoryState, onSelectedNodeChange, onSelectedEdgeChange, onSelectedAnnotationChange]);

  const addPostit = useCallback(() => {
    const centre = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    addPostitAtPosition(centre.x, centre.y);
  }, [screenToFlowPosition, addPostitAtPosition]);

  const addContainerAtPosition = useCallback((x: number, y: number, w?: number, h?: number) => {
    if (!graph) return;
    const newId = crypto.randomUUID();
    const nextGraph = structuredClone(graph);
    if (!nextGraph.containers) nextGraph.containers = [];
    nextGraph.containers.push({
      id: newId,
      label: 'Group',
      colour: '#94A3B8',
      width: w && w >= 100 ? Math.round(w) : 400,
      height: h && h >= 80 ? Math.round(h) : 300,
      x: Math.round(x),
      y: Math.round(y),
    });
    if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
    setGraph(nextGraph);
    saveHistoryState('Add container');
    setContextMenu(null);
    onSelectedNodeChange(null);
    onSelectedEdgeChange(null);
    onSelectedAnnotationChange?.(newId, 'container');
  }, [graph, setGraph, saveHistoryState, onSelectedNodeChange, onSelectedEdgeChange, onSelectedAnnotationChange]);

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

  const addCanvasAnalysisAtPosition = useCallback((x: number, y: number, dragData: any) => {
    if (!graph) return;
    const newId = crypto.randomUUID();
    const nextGraph = structuredClone(graph);
    if (!nextGraph.canvasAnalyses) nextGraph.canvasAnalyses = [];

    const drawnW = dragData.drawWidth && dragData.drawWidth >= 100 ? Math.round(dragData.drawWidth) : 400;
    const drawnH = dragData.drawHeight && dragData.drawHeight >= 80 ? Math.round(dragData.drawHeight) : 300;

    const analysis: any = {
      id: newId,
      x: Math.round(x),
      y: Math.round(y),
      width: drawnW,
      height: drawnH,
      view_mode: dragData.viewMode || 'chart',
      chart_kind: dragData.chartKind,
      live: true,
      recipe: dragData.recipe || { analysis: { analysis_type: 'unknown' } },
    };

    nextGraph.canvasAnalyses.push(analysis);
    if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();

    if (dragData.analysisResult) {
      canvasAnalysisTransientCache.set(newId, dragData.analysisResult);
    }

    setGraph(nextGraph);
    saveHistoryState('Pin analysis to canvas');
    setContextMenu(null);
    onSelectedNodeChange(null);
    onSelectedEdgeChange(null);
    onSelectedAnnotationChange?.(newId, 'canvasAnalysis');
  }, [graph, setGraph, saveHistoryState, onSelectedNodeChange, onSelectedEdgeChange, onSelectedAnnotationChange]);

  // Listen for 'dagnet:pinAnalysisToCanvas' event — enters draw mode with a pre-filled recipe
  useEffect(() => {
    const handler = (e: CustomEvent) => {
      pendingAnalysisPayload = e.detail || {};
      setActiveElementTool('new-analysis');
    };
    window.addEventListener('dagnet:pinAnalysisToCanvas', handler as any);
    return () => window.removeEventListener('dagnet:pinAnalysisToCanvas', handler as any);
  }, [setActiveElementTool]);

  // Listen for 'dagnet:addAnalysis' event — enters draw mode, pre-populates DSL from selection
  useEffect(() => {
    const handler = () => {
      const selectedConversionNodes = nodes
        .filter(n => n.selected && !isCanvasObjectNode(n.id))
        .map(n => n.data?.id || n.id);

      let analyticsDsl = '';
      if (selectedConversionNodes.length === 2) {
        analyticsDsl = `from(${selectedConversionNodes[0]}).to(${selectedConversionNodes[1]})`;
      } else if (selectedConversionNodes.length === 1) {
        analyticsDsl = `from(${selectedConversionNodes[0]})`;
      }

      pendingAnalysisPayload = analyticsDsl
        ? { recipe: { analysis: { analytics_dsl: analyticsDsl } } }
        : {};
      setActiveElementTool('new-analysis');
    };
    window.addEventListener('dagnet:addAnalysis', handler as any);
    return () => window.removeEventListener('dagnet:addAnalysis', handler as any);
  }, [setActiveElementTool, nodes, isCanvasObjectNode]);

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

  // Paste node at specific position (from copy-paste clipboard)
  const pasteNodeAtPosition = useCallback(async (x: number, y: number) => {
    if (!graph) return;
    
    if (!copiedNode) {
      toast.error('No node copied');
      return;
    }
    
    const nodeId = copiedNode.objectId;
    const fileId = `node-${nodeId}`;
    
    // Check if the node file exists
    const file = fileRegistry.getFile(fileId);
    if (!file) {
      toast.error(`Node file not found: ${nodeId}`);
      return;
    }
    
    const newUuid = crypto.randomUUID();
    
    // Create new node with the copied node ID attached
    const newNode = {
      uuid: newUuid,
      id: nodeId, // Attach the copied node file
      label: file.data?.label || nodeId, // Use label from file if available
      absorbing: false,
      layout: {
        x: x,
        y: y
      }
    };
    
    const nextGraph = structuredClone(graph);
    nextGraph.nodes.push(newNode);
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    setGraph(nextGraph);
    
    if (typeof saveHistoryState === 'function') {
      saveHistoryState('Paste node', newUuid);
    }
    setContextMenu(null);
    
    // Trigger "Get from file" to populate full node data
    // Wait for graph update to complete first
    setTimeout(async () => {
      try {
        await dataOperationsService.getNodeFromFile({
          nodeId: nodeId,
          graph: nextGraph,
          setGraph: setGraph as any,
          targetNodeUuid: newUuid,
        });
        toast.success(`Pasted node: ${nodeId}`);
      } catch (error) {
        console.error('[GraphCanvas] Failed to get node from file:', error);
        toast.error('Failed to load node data from file');
      }
      
      // Select the new node
      setNodes((nodes) => 
        nodes.map((node) => ({
          ...node,
          selected: node.id === newUuid
        }))
      );
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

  // Drop node at specific position (from drag & drop)
  const dropNodeAtPosition = useCallback(async (nodeId: string, x: number, y: number) => {
    if (!graph) return;
    
    const fileId = `node-${nodeId}`;
    
    // Check if the node file exists
    const file = fileRegistry.getFile(fileId);
    if (!file) {
      toast.error(`Node file not found: ${nodeId}`);
      return;
    }
    
    const newUuid = crypto.randomUUID();
    
    // Create new node with the dropped node ID attached
    const newNode = {
      uuid: newUuid,
      id: nodeId,
      label: file.data?.label || nodeId,
      absorbing: false,
      layout: {
        x: x,
        y: y
      }
    };
    
    const nextGraph = structuredClone(graph);
    nextGraph.nodes.push(newNode);
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    setGraph(nextGraph);
    
    if (typeof saveHistoryState === 'function') {
      saveHistoryState('Drop node', newUuid);
    }
    
    // Trigger "Get from file" to populate full node data
    setTimeout(async () => {
      try {
        await dataOperationsService.getNodeFromFile({
          nodeId: nodeId,
          graph: nextGraph,
          setGraph: setGraph as any,
          targetNodeUuid: newUuid,
        });
        toast.success(`Added node: ${nodeId}`);
      } catch (error) {
        console.error('[GraphCanvas] Failed to get node from file:', error);
        toast.error('Failed to load node data from file');
      }
      
      // Select the new node
      setNodes((nodes) => 
        nodes.map((node) => ({
          ...node,
          selected: node.id === newUuid
        }))
      );
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
  }, []);

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
    () => ({ beadsVisible, isPanning: isPanningOrZooming, isDraggingNode }),
    [beadsVisible, isPanningOrZooming, isDraggingNode]
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
          background: dark ? '#1e1e1e' : '#f8fafc',
          cursor: undefined,
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color={dark ? '#2a2a2a' : '#ddd'} />
        <Controls />
        <MiniMap
          maskColor={dark ? 'rgba(30,30,30,0.8)' : undefined}
          nodeColor={(node) => isCanvasObjectNode(node.id) ? 'transparent' : '#e2e2e2'}
          nodeStrokeColor={(node) => isCanvasObjectNode(node.id) ? 'transparent' : '#b1b1b7'}
        />
        <GraphIssuesIndicatorOverlay tabId={tabId} />
        
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
          <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); setContextMenu(null); toggleDashboardMode({ updateUrl: true }); }}>
            🖥️ {isDashboardMode ? 'Exit dashboard mode' : 'Enter dashboard mode'}
          </div>
          {tabId && (
            <div className="dagnet-popup-item" onClick={async (e) => { e.stopPropagation(); setContextMenu(null); await tabOperations.closeTab(tabId); }}>
              ✖ Close tab
            </div>
          )}
          <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); addNodeAtPosition(contextMenu.flowX, contextMenu.flowY); }}>
            ➕ Add node
          </div>
          <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); addPostitAtPosition(contextMenu.flowX, contextMenu.flowY); }}>
            📝 Add post-it
          </div>
          <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); addContainerAtPosition(contextMenu.flowX, contextMenu.flowY); }}>
            ▢ Add container
          </div>
          {copiedNode && (
            <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); pasteNodeAtPosition(contextMenu.flowX, contextMenu.flowY); }}>
              📋 Paste node: {copiedNode.objectId}
            </div>
          )}
          {copiedSubgraph && (
            <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); pasteSubgraphAtPosition(contextMenu.flowX, contextMenu.flowY); }}>
              📋 Paste ({[
                copiedSubgraph.nodes.length > 0 && `${copiedSubgraph.nodes.length} node${copiedSubgraph.nodes.length !== 1 ? 's' : ''}`,
                copiedSubgraph.edges.length > 0 && `${copiedSubgraph.edges.length} edge${copiedSubgraph.edges.length !== 1 ? 's' : ''}`,
                (copiedSubgraph.postits?.length ?? 0) > 0 && `${copiedSubgraph.postits!.length} post-it${copiedSubgraph.postits!.length !== 1 ? 's' : ''}`,
              ].filter(Boolean).join(', ')})
            </div>
          )}
          {nodes.length > 0 && (
            <div className="dagnet-popup-item" onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('dagnet:selectAllNodes')); setContextMenu(null); }}>
              ⬜ Select All
            </div>
          )}
        </div>
      )}
      
      {/* Post-It Context Menu */}
      {postitContextMenu && graph && (() => {
        const postit = graph.postits?.find((p: any) => p.id === postitContextMenu.postitId);
        if (!postit) return null;
        const postitCount = graph.postits?.length ?? 0;
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
            onCopy={(id) => {
              const c = graph.containers?.find((ci: any) => ci.id === id);
              if (c && graph) {
                const contained = extractSubgraph({
                  selectedNodeIds: nodes.filter(n => {
                    if (isCanvasObjectNode(n.id)) return false;
                    const nw = (n as any).measured?.width ?? n.width ?? DEFAULT_NODE_WIDTH;
                    const nh = (n as any).measured?.height ?? n.height ?? DEFAULT_NODE_HEIGHT;
                    const nx = n.position?.x ?? 0;
                    const ny = n.position?.y ?? 0;
                    return nx >= c.x - 10 && ny >= c.y - 10 && (nx + nw) <= (c.x + c.width + 10) && (ny + nh) <= (c.y + c.height + 10);
                  }).map(n => n.id),
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
                const containedNodeIds = nodes.filter(n => {
                  if (isCanvasObjectNode(n.id)) return false;
                  const nw = (n as any).measured?.width ?? n.width ?? DEFAULT_NODE_WIDTH;
                  const nh = (n as any).measured?.height ?? n.height ?? DEFAULT_NODE_HEIGHT;
                  const nx = n.position?.x ?? 0;
                  const ny = n.position?.y ?? 0;
                  return nx >= c.x - 10 && ny >= c.y - 10 && (nx + nw) <= (c.x + c.width + 10) && (ny + nh) <= (c.y + c.height + 10);
                }).map(n => n.id);
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
        const analysisCount = graph.canvasAnalyses?.length ?? 0;
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
              onClick={() => {
                setShowVariantModal(false);
                setPendingConnection(null);
                setCaseNodeVariants([]);
              }}
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
