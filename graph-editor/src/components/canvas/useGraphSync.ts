/**
 * useGraphSync — extracted sync engine from GraphCanvas.
 *
 * Contains:
 *   - Guard refs + createSyncGuards
 *   - Sync-internal refs (lastSyncedGraphRef, etc.)
 *   - handleResizeStart / handleResizeEnd
 *   - dagnet:whatif-start and dagnet:forceRedraw event listeners
 *   - ALL Graph↔ReactFlow sync effects (Effects 1–9)
 *
 * Created as part of B1 sync engine extraction (Sub-phase 2).
 * This is a MECHANICAL extraction — no behaviour changes.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { Edge, Node } from 'reactflow';

import { createSyncGuards, bindSyncGuards } from './syncGuards';
import type { SyncGuards } from './syncGuards';
import { toFlow, fromFlow } from '@/lib/transform';
import {
  logSnapshotBoot,
  recordSnapshotBootLedgerStage,
  registerSnapshotBootExpectations,
  summariseSnapshotCharts,
} from '@/lib/snapshotBootTrace';
import { computeEffectiveEdgeProbability } from '@/lib/whatIf';
import { computeFaceDirectionsFromEdges } from '@/lib/faceDirections';
import { getCaseEdgeVariantInfo } from '../edges/edgeLabelHelpers';
import { getComposedParamsForLayer } from '../../services/CompositionService';
import {
  MAX_EDGE_WIDTH,
  MIN_EDGE_WIDTH,
  DEFAULT_NODE_WIDTH,
  DEFAULT_NODE_HEIGHT,
  MIN_NODE_HEIGHT,
  MAX_NODE_HEIGHT,
  IMAGE_VIEW_NODE_WIDTH,
  IMAGE_VIEW_NODE_HEIGHT,
} from '@/lib/nodeEdgeConstants';

import { getAnalysisTypeMeta } from '../panels/analysisTypes';
import { getActiveContentItem } from '@/utils/canvasAnalysisAccessors';

// ---------------------------------------------------------------------------
// Minimised annotation dimensions (canvas pixels)
// ---------------------------------------------------------------------------
export const POSTIT_MINIMISED_WIDTH = 32;
export const POSTIT_MINIMISED_HEIGHT = 32;
/** Default minimised dimensions — overridden per analysis type when a custom renderer declares a size. */
export const ANALYSIS_MINIMISED_WIDTH = 32;
export const ANALYSIS_MINIMISED_HEIGHT = 32;

/** Look up the minimised dimensions for an analysis object, using the
 *  analysis type's declared minimisedSize if available, else defaults. */
export function getAnalysisMinimisedDims(analysis: any): { width: number; height: number } {
  const ci = getActiveContentItem(analysis);
  const meta = ci?.analysis_type ? getAnalysisTypeMeta(ci.analysis_type) : undefined;
  if (meta?.renderMinimised && meta.minimisedSize) {
    return meta.minimisedSize;
  }
  return { width: ANALYSIS_MINIMISED_WIDTH, height: ANALYSIS_MINIMISED_HEIGHT };
}

// ---------------------------------------------------------------------------
// Params interface
// ---------------------------------------------------------------------------

export interface UseGraphSyncParams {
  graph: any;
  nodes: Node[];
  edges: Edge[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  setGraph: (newGraph: any, oldGraph?: any, source?: string) => Promise<void>;
  fitView: (options?: any) => void;
  tabId?: string;
  tabs: any[];
  useSankeyView: boolean;
  showNodeImages: boolean;
  effectiveWhatIfDSL: string | null;
  overridesVersion: string;
  effectiveActiveTabId: string | null | undefined;
  calculateEdgeOffsets: (edgesWithWidth: any[], allNodes: any[], maxWidth: number) => any[];
  nodesMapRef: MutableRefObject<Map<string, any>>;
  graphStoreHook: any;
  scenariosContext: any;
  useUniformScaling: boolean;
  massGenerosity: number;
  setForceRerouteRef: MutableRefObject<((v: boolean) => void) | null>;
  activeElementTool: string | null | undefined;
  handleUpdateNode: (id: string, data: any) => void;
  handleDeleteNode: (nodeUuid: string) => Promise<void>;
  handleUpdateEdge: (id: string, data: any) => void;
  handleDeleteEdge: (edgeUuid: string) => Promise<void>;
  handleReconnect: (edgeId: string, newSource?: string, newTarget?: string, newTargetHandle?: string, newSourceHandle?: string) => void;
  handleUpdatePostit: (id: string, updates: any) => void;
  handleDeletePostit: (id: string) => void;
  handleUpdateContainer: (id: string, updates: any) => void;
  handleDeleteContainer: (id: string) => void;
  handleUpdateAnalysis: (id: string, updates: any) => void;
  handleDeleteAnalysis: (id: string) => void;
  onSelectedAnnotationChange?: (id: string | null, type: 'postit' | 'container' | 'canvasAnalysis' | null) => void;
  onDoubleClickNode?: (id: string, field: string) => void;
  onDoubleClickEdge?: (id: string, field: string) => void;
  onSelectEdge?: (id: string) => void;
  whatIfDSL?: string | null;
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface UseGraphSyncReturn {
  guards: SyncGuards;
  autoEditPostitIdRef: MutableRefObject<string | null>;
  autoSelectAnalysisIdRef: MutableRefObject<string | null>;
  lastRenderEdgesRef: MutableRefObject<Edge[]>;
  lastSyncedReactFlowRef: MutableRefObject<string | null>;
  isEffectsCooldownActive: () => boolean;
  handleResizeStart: () => void;
  handleResizeEnd: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGraphSync(params: UseGraphSyncParams): UseGraphSyncReturn {
  const {
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
  } = params;

  // Local ts() helper
  const ts = () => new Date().toISOString();

  // -------------------------------------------------------------------------
  // Guard refs + createSyncGuards
  // -------------------------------------------------------------------------

  const isSyncingRef = useRef(false);
  const isDraggingNodeRef = useRef(false);
  const isResizingNodeRef = useRef(false);
  const sankeyLayoutInProgressRef = useRef(false);
  const effectsCooldownUntilRef = useRef<number>(0);
  const recomputeInProgressRef = useRef(false);
  const visualWhatIfUpdateRef = useRef(false);
  const sankeyUpdatingRef = useRef(false);
  const skipSankeyNodeSizingRef = useRef(false);

  const guards = createSyncGuards({
    isSyncingRef,
    isDraggingNodeRef,
    isResizingNodeRef,
    sankeyLayoutInProgressRef,
    effectsCooldownUntilRef,
    skipSankeyNodeSizingRef,
    recomputeInProgressRef,
    visualWhatIfUpdateRef,
    sankeyUpdatingRef,
  });

  // Bind module-level singleton so node components can call beginResizeGuard/endResizeGuard
  // directly without needing callbacks threaded through ReactFlow node data.
  bindSyncGuards(guards);

  const isEffectsCooldownActive = guards.isEffectsCooldownActive;

  // -------------------------------------------------------------------------
  // Sync-internal refs
  // -------------------------------------------------------------------------

  const lastSyncedGraphRef = useRef<string>('');
  const lastSyncedReactFlowRef = useRef<string | null>('');
  const snapshotBootCycleKeyRef = useRef<string>('');
  const snapshotBootCycleIdRef = useRef<string>('');
  const prevSankeyViewRef = useRef(useSankeyView);
  const prevShowNodeImagesRef = useRef(showNodeImages);
  const hasInitialFitViewRef = useRef(false);
  const currentGraphIdRef = useRef<string>('');
  const lastRenderEdgesRef = useRef<Edge[]>([]);
  const autoEditPostitIdRef = useRef<string | null>(null);
  const autoSelectAnalysisIdRef = useRef<string | null>(null);
  const whatIfStartRef = useRef<number | null>(null);
  const lastScalingRef = useRef({ uniform: useUniformScaling, generosity: massGenerosity });
  const lastWhatIfVersionRef = useRef<string>('');

  // -------------------------------------------------------------------------
  // handleResizeStart / handleResizeEnd
  // -------------------------------------------------------------------------

  const handleResizeStart = useCallback(() => {
    if (import.meta.env.DEV) console.log('[useGraphSync] handleResizeStart → beginInteraction(resize)');
    guards.beginInteraction('resize');
  }, []);
  const handleResizeEnd = useCallback(() => {
    if (import.meta.env.DEV) console.log('[useGraphSync] handleResizeEnd → endInteraction(resize)');
    guards.endInteraction('resize');
  }, []);

  // -------------------------------------------------------------------------
  // Event listeners
  // -------------------------------------------------------------------------

  // dagnet:whatif-start
  useEffect(() => {
    const handler = (e: any) => {
      if (e?.detail?.tabId && tabId && e.detail.tabId !== tabId) return;
      whatIfStartRef.current = e.detail?.t0 ?? performance.now();
      console.log(`[${ts()}] [GraphCanvas] what-if start received`, { t0: whatIfStartRef.current, tabId });
    };
    window.addEventListener('dagnet:whatif-start', handler as any);
    return () => window.removeEventListener('dagnet:whatif-start', handler as any);
  }, []);

  // dagnet:forceRedraw
  useEffect(() => {
    const handleForceRedraw = () => {
      console.log('🔄 Force redraw requested - clearing sync cache');
      lastSyncedGraphRef.current = '';
    };

    window.addEventListener('dagnet:forceRedraw', handleForceRedraw);
    return () => window.removeEventListener('dagnet:forceRedraw', handleForceRedraw);
  }, []);

  // -------------------------------------------------------------------------
  // Effect 1: Main Graph→RF sync (fast/slow path)
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!graph) return;

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
    const graphAnalysesById = new Map<string, any>((graph.canvasAnalyses || []).map((a: any) => [a.id, a]));
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
      const minDims = getAnalysisMinimisedDims(graphAnalysis);
      const expectedW = graphAnalysis.minimised ? minDims.width : graphAnalysis.width;
      const expectedH = graphAnalysis.minimised ? minDims.height : graphAnalysis.height;
      return node.type !== 'canvasAnalysis'
        || node.position?.x !== (graphAnalysis.x ?? 0)
        || node.position?.y !== (graphAnalysis.y ?? 0)
        || rfWidth !== expectedW
        || rfHeight !== expectedH
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

    guards.beginSync();

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

    const nodePositionsChanged = nodes.some(node => {
      const graphNode = graph.nodes.find((n: any) => n.uuid === node.id || n.id === node.id);
      return graphNode && (
        Math.abs((graphNode.layout?.x || 0) - node.position.x) > 0.1 ||
        Math.abs((graphNode.layout?.y || 0) - node.position.y) > 0.1
      );
    });

    const graphEdgeIds = new Set(graph.edges.map((e: any) => e.uuid));
    const reactFlowEdgeIds = new Set(edges.map(e => e.id));
    const edgeIdsChanged = edges.some(e => !graphEdgeIds.has(e.id)) ||
                           graph.edges.some((e: any) => !reactFlowEdgeIds.has(e.uuid));

    console.log('  Edge IDs changed:', edgeIdsChanged);
    if (edgeIdsChanged) {
      console.log('    Old ReactFlow edge IDs:', Array.from(reactFlowEdgeIds));
      console.log('    New Graph edge IDs:', Array.from(graphEdgeIds));
    }

    const edgeHandlesChanged = edges.some(edge => {
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

    const nodePropertiesChanged = nodes.some(node => {
      const graphNode = graph.nodes.find((n: any) => n.uuid === node.id || n.id === node.id);
      if (!graphNode) return false;

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

    if (sankeyModeChanged) {
      console.log('  🎨 Sankey mode changed:', prevSankeyViewRef.current, '->', useSankeyView);
      prevSankeyViewRef.current = useSankeyView;
    }
    if (imageViewChanged) {
      console.log('  🖼️ Image view changed:', prevShowNodeImagesRef.current, '->', showNodeImages);
      prevShowNodeImagesRef.current = showNodeImages;
    }

    const imageBoundaryChanged = showNodeImages && nodes.some(node => {
      const graphNode = graph.nodes.find((n: any) => n.uuid === node.id || n.id === node.id);
      if (!graphNode) return false;
      const hadImages = (node.data?.images?.length || 0) > 0;
      const hasImages = (graphNode.images?.length || 0) > 0;
      return hadImages !== hasImages;
    });

    const isInteracting = guards.isInteracting();
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
      const pathReason = guards.isDragging() ? '(DRAG - ignoring position diff)' : '(positions unchanged)';
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

      setEdges(prevEdges => {
        const result = prevEdges.map(prevEdge => {
          let graphEdge = graph.edges.find((e: any) => e.uuid === prevEdge.id || e.id === prevEdge.id);
          if (!graphEdge) {
            graphEdge = graph.edges.find((e: any) => `${e.from}->${e.to}` === prevEdge.id);
          }
          if (!graphEdge) {
            graphEdge = graph.edges.find((e: any) => e.from === prevEdge.source && e.to === prevEdge.target);
          }
          if (!graphEdge) return prevEdge;

          const newProbability = graphEdge.p?.mean ?? 0.5;
          const newCalculateWidth = () => {
            const minWidth = MIN_EDGE_WIDTH;
            const maxWidth = MAX_EDGE_WIDTH;
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
              p: graphEdge.p,
              description: graphEdge.description,
              description_overridden: graphEdge.description_overridden,
              query_overridden: graphEdge.query_overridden,
              conditional_p: graphEdge.conditional_p,
              cost_gbp: (graphEdge as any).cost_gbp,
              labour_cost: (graphEdge as any).labour_cost,
              costs: graphEdge.costs,
              weight_default: graphEdge.weight_default,
              case_variant: graphEdge.case_variant,
              case_id: graphEdge.case_id,
              useSankeyView: useSankeyView,
              calculateWidth: newCalculateWidth
            }
          };
        });

        const edgesWithOffsets = calculateEdgeOffsets(result, nodes, MAX_EDGE_WIDTH);

        return edgesWithOffsets.map(edge => ({
          ...edge,
          data: {
            ...edge.data,
            sourceOffsetX: edge.sourceOffsetX,
            sourceOffsetY: edge.sourceOffsetY,
            targetOffsetX: edge.targetOffsetX,
            targetOffsetY: edge.targetOffsetY,
            scaledWidth: edge.scaledWidth,
            sourceBundleWidth: edge.sourceBundleWidth,
            targetBundleWidth: edge.targetBundleWidth,
            sourceBundleSize: edge.sourceBundleSize,
            renderFallbackTargetArrow: false,
            targetBundleSize: edge.targetBundleSize,
            isFirstInSourceBundle: edge.isFirstInSourceBundle,
            isLastInSourceBundle: edge.isLastInSourceBundle,
            isFirstInTargetBundle: edge.isFirstInTargetBundle,
            isLastInTargetBundle: edge.isLastInTargetBundle,
            sourceFace: edge.sourceFace,
            targetFace: edge.targetFace,
            whatIfDSL: effectiveWhatIfDSL
          }
        }));
      });

      {
        const graphPostitIds = new Set((graph.postits || []).map((p: any) => p.id));
        const graphContainerIds = new Set((graph.containers || []).map((c: any) => c.id));
        const graphAnalysisIds = new Set((graph.canvasAnalyses || []).map((a: any) => a.id));
        setNodes(prevNodes => {
          const autoEditNodeId = autoEditPostitIdRef.current ? `postit-${autoEditPostitIdRef.current}` : null;

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
                if (!guards.isResizing() && (prevStyle?.width !== graphPostit.width || prevStyle?.height !== graphPostit.height)) {
                  console.log('[reconcile] postit style WILL CHANGE', {
                    id: prevNode.id,
                    isResizing: guards.isResizing(),
                    isInteracting,
                    prevW: prevStyle?.width, prevH: prevStyle?.height,
                    graphW: graphPostit.width, graphH: graphPostit.height,
                    prevPos: prevNode.position,
                    graphPos: { x: graphPostit.x, y: graphPostit.y },
                  });
                }
              }
              // When minimised, omit width/height from style — let the inner content
              // (explicit fixed-size div) drive the RF wrapper size naturally via
              // ResizeObserver. Setting explicit dimensions on the wrapper fights RF.
              const postitMinimised = !!graphPostit.minimised;
              return {
                ...prevNode,
                zIndex: 5000 + gpIndex,
                ...(isInteracting ? {} : { position: { x: graphPostit.x ?? 0, y: graphPostit.y ?? 0 } }),
                ...(guards.isResizing() ? {} : {
                  style: postitMinimised
                    ? { width: POSTIT_MINIMISED_WIDTH, height: POSTIT_MINIMISED_HEIGHT }
                    : { width: graphPostit.width, height: graphPostit.height },
                }),
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
                ...(isInteracting ? {} : { position: { x: graphContainer.x ?? 0, y: graphContainer.y ?? 0 } }),
                ...(() => {
                  if (guards.isResizing()) {
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
              const prevAnalysis = prevNode.data?.analysis;
              const analysisChanged = !prevAnalysis || JSON.stringify(prevAnalysis) !== JSON.stringify(graphAnalysis);
              const stableAnalysis = analysisChanged ? graphAnalysis : prevAnalysis;
              const prevData = prevNode.data;
              const dataChanged = analysisChanged || prevData?.tabId !== tabId
                || prevData?.onUpdate !== handleUpdateAnalysis || prevData?.onDelete !== handleDeleteAnalysis;
              const analysisMinimised = !!graphAnalysis.minimised;
              const minDimsUpdate = getAnalysisMinimisedDims(graphAnalysis);
              const nextStyle = analysisMinimised
                ? { width: minDimsUpdate.width, height: minDimsUpdate.height }
                : { width: graphAnalysis.width, height: graphAnalysis.height };
              return {
                ...prevNode,
                type: 'canvasAnalysis',
                zIndex: 5000 + (graph.postits || []).length + (gaIndex >= 0 ? gaIndex : 0),
                ...(isInteracting ? {} : { position: { x: graphAnalysis.x ?? 0, y: graphAnalysis.y ?? 0 } }),
                ...(guards.isResizing() ? {} : { style: nextStyle }),
                data: dataChanged ? {
                  ...prevData,
                  analysis: stableAnalysis,
                  tabId,
                  onUpdate: handleUpdateAnalysis,
                  onDelete: handleDeleteAnalysis,
                  onResizeStart: handleResizeStart,
                  onResizeEnd: handleResizeEnd,
                } : {
                  ...prevData,
                  // Always ensure resize callbacks are present — they can be lost when
                  // type:'reset' changes (from SelectionConnectors halo setNodes) round-trip
                  // through nodeInternals → getNodes() → applyNodeChanges, because functions
                  // don't survive JSON-like operations in the controlled mode pipeline.
                  onResizeStart: handleResizeStart,
                  onResizeEnd: handleResizeEnd,
                },
              };
            }
            const graphNode = graph.nodes.find((n: any) => n.uuid === prevNode.id || n.id === prevNode.id);
            if (!graphNode) return prevNode;

            const hasImages = showNodeImages && (graphNode.images?.length || 0) > 0;
            return {
              ...prevNode,
              data: {
                ...prevNode.data,
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

          if (useSankeyView) {
            console.log('[Sankey Fast Path] Recalculating node heights based on edge changes');

            const scenarioState = tabId ? tabs.find(t => t.id === tabId)?.editorState?.scenarioState : undefined;
            const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
            const layersToCalculate = visibleScenarioIds.includes('current')
              ? visibleScenarioIds
              : [...visibleScenarioIds, 'current'];

            const maxFlowMassPerNode = new Map<string, number>();
            let currentLayerMaxMass = 0;

            for (const layerId of layersToCalculate) {
              const flowMass = new Map<string, number>();
              let layerWhatIfDSL = effectiveWhatIfDSL;
              let composedParams: any = null;

              if (layerId !== 'current' && scenariosContext) {
                composedParams = getComposedParamsForLayer(
                  layerId,
                  scenariosContext.baseParams,
                  scenariosContext.currentParams,
                  scenariosContext.scenarios
                );
                if (layerId !== 'base') {
                  layerWhatIfDSL = null;
                }
              }

              graph.nodes?.forEach((node: any) => {
                if (node.entry?.is_start) {
                  flowMass.set(node.uuid, node.entry.entry_weight || 1.0);
                } else {
                  flowMass.set(node.uuid, 0);
                }
              });

              const resolveToUuid = (ref: string): string => {
                let node = graph.nodes?.find((n: any) => n.uuid === ref || n.id === ref);
                if (node) return node.uuid;
                node = graph.nodes?.find((n: any) => n.uuid?.startsWith(ref));
                return node?.uuid || ref;
              };

              const incomingEdges = new Map<string, Array<any>>();
              graph.edges?.forEach((edge: any) => {
                const toUuid = resolveToUuid(edge.to);
                if (!incomingEdges.has(toUuid)) {
                  incomingEdges.set(toUuid, []);
                }
                incomingEdges.get(toUuid)!.push(edge);
              });

              const processed = new Set<string>();
              let iterations = 0;
              const maxIterations = graph.nodes?.length * 3 || 100;

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

                  if (processed.has(nodeId)) {
                    return;
                  }

                  const incoming = incomingEdges.get(nodeId) || [];
                  const allIncomingProcessed = incoming.every((edge: any) => processed.has(resolveToUuid(edge.from)));

                  if (allIncomingProcessed && incoming.length > 0) {
                    let totalMass = 0;
                    incoming.forEach((edge: any) => {
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

              flowMass.forEach((mass, nodeId) => {
                const currentMax = maxFlowMassPerNode.get(nodeId) || 0;
                maxFlowMassPerNode.set(nodeId, Math.max(currentMax, mass));
              });

              if (layerId === 'current') {
                currentLayerMaxMass = Math.max(...Array.from(flowMass.values()), 0.001);
              }
            }

            updatedNodes = updatedNodes.map(node => {
              // Non-flow nodes keep their own dimensions — they're not part of the flow network.
              if (node.type === 'canvasAnalysis' || node.type === 'postit' || node.type === 'container') return node;

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
              const newPostitMinimised = !!p.minimised;
              updatedNodes.push({
                id: `postit-${p.id}`,
                type: 'postit',
                position: { x: p.x ?? 0, y: p.y ?? 0 },
                zIndex: 5000 + pi,
                selected: shouldAutoEdit,
                style: newPostitMinimised
                  ? { width: POSTIT_MINIMISED_WIDTH, height: POSTIT_MINIMISED_HEIGHT }
                  : { width: p.width, height: p.height },
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
              const newAnalysisMinimised = !!analysis.minimised;
              updatedNodes.push({
                id: `analysis-${analysis.id}`,
                type: 'canvasAnalysis',
                position: { x: analysis.x ?? 0, y: analysis.y ?? 0 },
                zIndex: 5000 + graphPostits.length + ai,
                style: newAnalysisMinimised
                  ? getAnalysisMinimisedDims(analysis)
                  : { width: analysis.width, height: analysis.height },
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

    const selectedNodeIds = new Set(nodes.filter(n => n.selected).map(n => n.id));
    const selectedEdgeIds = new Set(edges.filter(e => e.selected).map(e => e.id));

    let graphForBuild = graph;
    if (useSankeyView && graph.edges) {
      graphForBuild = {
        ...graph,
        edges: graph.edges.map((edge: any) => {
          const sourceNode = graph.nodes?.find((n: any) => n.uuid === edge.from || n.id === edge.from);
          const targetNode = graph.nodes?.find((n: any) => n.uuid === edge.to || n.id === edge.to);

          if (!sourceNode || !targetNode) return edge;

          const dx = (targetNode.layout?.x ?? 0) - (sourceNode.layout?.x ?? 0);
          const dy = (targetNode.layout?.y ?? 0) - (sourceNode.layout?.y ?? 0);

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

    const containerArray = graph.containers || [];
    const containerRfNodes = newNodes.filter(n => n.id?.startsWith('container-'));
    const CONTAIN_TOL_SLOW = 10;
    const injectContainerColour = (node: any) => {
      if (node.type !== 'conversion') return node;
      const nw = DEFAULT_NODE_WIDTH;
      const nh = DEFAULT_NODE_HEIGHT;
      const nx = node.position?.x ?? 0;
      const ny = node.position?.y ?? 0;
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

    if (useSankeyView) {
      const NODE_WIDTH = DEFAULT_NODE_WIDTH;

      console.log('[Sankey] Graph nodes:', graph.nodes?.map((n: any) => ({ uuid: n.uuid, id: n.id, label: n.label, isStart: n.entry?.is_start })));
      console.log('[Sankey] Graph edges:', graph.edges?.map((e: any) => ({ from: e.from, to: e.to, prob: e.p?.mean })));

      const scenarioState = tabId ? tabs.find(t => t.id === tabId)?.editorState?.scenarioState : undefined;
      const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
      const layersToCalculate = visibleScenarioIds.includes('current')
        ? visibleScenarioIds
        : [...visibleScenarioIds, 'current'];

      console.log('[Sankey] Calculating mass for layers:', layersToCalculate);

      const maxFlowMassPerNode = new Map<string, number>();
      let currentLayerMaxMass = 0;

      for (const layerId of layersToCalculate) {
        console.log(`[Sankey] Processing layer: ${layerId}`);
        const flowMass = new Map<string, number>();

        let layerWhatIfDSL = effectiveWhatIfDSL;
        let composedParams: any = null;

        if (layerId !== 'current' && scenariosContext) {
          composedParams = getComposedParamsForLayer(
            layerId,
            scenariosContext.baseParams,
            scenariosContext.currentParams,
            scenariosContext.scenarios
          );
          if (layerId !== 'base') {
            layerWhatIfDSL = null;
          }
        }

        graph.nodes?.forEach((node: any) => {
          if (node.entry?.is_start) {
            const entryWeight = node.entry.entry_weight || 1.0;
            flowMass.set(node.uuid, entryWeight);
          } else {
            flowMass.set(node.uuid, 0);
          }
        });

        const resolveToUuid = (ref: string): string => {
          let node = graph.nodes?.find((n: any) => n.uuid === ref || n.id === ref);
          if (node) return node.uuid;
          node = graph.nodes?.find((n: any) => n.uuid?.startsWith(ref));
          return node?.uuid || ref;
        };

        const incomingEdges = new Map<string, Array<any>>();
        graph.edges?.forEach((edge: any) => {
          const toUuid = resolveToUuid(edge.to);
          if (!incomingEdges.has(toUuid)) {
            incomingEdges.set(toUuid, []);
          }
          incomingEdges.get(toUuid)!.push(edge);
        });

        const processed = new Set<string>();
        let iterations = 0;
        const maxIterations = graph.nodes?.length * 3 || 100;

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

            if (processed.has(nodeId)) {
              return;
            }

            const incoming = incomingEdges.get(nodeId) || [];
            const allIncomingProcessed = incoming.every((edge: any) => processed.has(resolveToUuid(edge.from)));

            if (allIncomingProcessed && incoming.length > 0) {
              let totalMass = 0;
              incoming.forEach((edge: any) => {
                const fromUuid = resolveToUuid(edge.from);
                const sourceMass = flowMass.get(fromUuid) || 0;

                const edgeId = edge.uuid || edge.id || `${edge.from}->${edge.to}`;
                let effectiveProb = 0;

                if (layerId === 'current') {
                  effectiveProb = computeEffectiveEdgeProbability(
                    graph,
                    edgeId,
                    { whatIfDSL: layerWhatIfDSL },
                    undefined
                  );
                } else if (composedParams) {
                  const edgeKey = edge.id || edge.uuid || `${edge.from}->${edge.to}`;
                  effectiveProb = composedParams.edges?.[edgeKey]?.p?.mean
                    ?? edge.p?.mean ?? 0;

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

          if (!madeProgress) {
            break;
          }
        }

        flowMass.forEach((mass, nodeId) => {
          const currentMax = maxFlowMassPerNode.get(nodeId) || 0;
          maxFlowMassPerNode.set(nodeId, Math.max(currentMax, mass));
        });

        if (layerId === 'current') {
          currentLayerMaxMass = Math.max(...Array.from(flowMass.values()), 0.001);
        }
      }

      nodesWithSelection = nodesWithSelection.map(node => {
        // Non-flow nodes keep their own dimensions.
        if (node.type === 'canvasAnalysis' || node.type === 'postit' || node.type === 'container') return node;

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
            sankeyHeight: height,
            sankeyWidth: NODE_WIDTH,
            useSankeyView: true
          }
        };
      });
    }

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
          return { ...node, data: { ...node.data, showNodeImages: true } };
        }
        return node;
      });
    }

    const edgesWithWidth = newEdges.map(edge => {
      const isSelected = autoEditNodeId ? false : selectedEdgeIds.has(edge.id);
      return {
      ...edge,
        selected: isSelected,
        reconnectable: true,
      data: {
        ...edge.data
      }
      };
    });

    const edgesWithWidthFunctions = edgesWithWidth.map(edge => ({
      ...edge,
      data: {
        ...edge.data
      }
    }));

  const effectiveMaxWidth = useSankeyView
    ? 384
    : MAX_EDGE_WIDTH;
  const edgesWithOffsets = calculateEdgeOffsets(edgesWithWidthFunctions, nodesWithSelection, effectiveMaxWidth);

  const edgesWithOffsetData = edgesWithOffsets.map(edge => ({
    ...edge,
    data: {
      ...edge.data,
      sourceOffsetX: edge.sourceOffsetX,
      sourceOffsetY: edge.sourceOffsetY,
      targetOffsetX: edge.targetOffsetX,
      targetOffsetY: edge.targetOffsetY,
      scaledWidth: edge.scaledWidth,
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
      whatIfDSL: effectiveWhatIfDSL,
      useSankeyView: useSankeyView
    }
  }));

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

    if (!useSankeyView && edgesWithOffsets.length > 0) {
      const faceMap = computeFaceDirectionsFromEdges(edgesWithOffsets);
      nodesWithSelection = nodesWithSelection.map((node: any) => {
        const fd = faceMap.get(node.id);
        if (!fd) return node;
        return { ...node, data: { ...node.data, faceDirections: fd } };
      });
    }

    setNodes(nodesWithSelection);
    const sortedEdges = [...edgesWithAnchors].sort((a, b) => {
      if (a.selected && !b.selected) return 1;
      if (!a.selected && b.selected) return -1;
      return 0;
    });

    const baseEdges = sortedEdges.filter(e => !e.id.startsWith('scenario-overlay-'));

    const scenarioState = tabId ? tabs.find(t => t.id === tabId)?.editorState?.scenarioState : undefined;
    const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
    const visibleColourOrderIds = scenarioState?.visibleColourOrderIds || [];

    let edgesWithScenarios = baseEdges;


    const prevById = new Map<string, any>();
    lastRenderEdgesRef.current.forEach(prevEdge => {
      prevById.set(prevEdge.id, prevEdge);
    });

    const mergedEdges = edgesWithScenarios.map(newEdge => {
      const prevEdge = prevById.get(newEdge.id);
      if (!prevEdge) return newEdge;

      const topologyChanged =
        newEdge.source !== prevEdge.source ||
        newEdge.target !== prevEdge.target ||
        newEdge.sourceHandle !== prevEdge.sourceHandle ||
        newEdge.targetHandle !== prevEdge.targetHandle;

      if (topologyChanged) {
        return newEdge;
      }

      const prevData = prevEdge.data || {};
      const newData = newEdge.data || {};

      return {
        ...newEdge,
        data: {
          ...newData,
          scaledWidth: prevData.scaledWidth ?? newData.scaledWidth,
          sourceOffsetX: prevData.sourceOffsetX ?? newData.sourceOffsetX,
          sourceOffsetY: prevData.sourceOffsetY ?? newData.sourceOffsetY,
          targetOffsetX: prevData.targetOffsetX ?? newData.targetOffsetX,
          targetOffsetY: prevData.targetOffsetY ?? newData.targetOffsetY,
        },
      };
    });

    setEdges(mergedEdges);

    const graphFromFlow = fromFlow(newNodes, mergedEdges, graph);
    if (graphFromFlow) {
      lastSyncedReactFlowRef.current = JSON.stringify(graphFromFlow);
    }

    guards.endSync(100);
    if (import.meta.env.DEV) console.log('Reset isSyncingRef to false');
  }, [graph, setNodes, setEdges, handleUpdateNode, handleDeleteNode, handleUpdateEdge, handleDeleteEdge, handleReconnect, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, effectiveActiveTabId, tabs, useSankeyView, showNodeImages, effectiveWhatIfDSL]);

  // -------------------------------------------------------------------------
  // Effect 2: Strip draggable overrides
  // -------------------------------------------------------------------------

  useEffect(() => {
    setNodes(nds => nds.map(n => {
      if (n.draggable !== undefined || n.selectable !== undefined) {
        return { ...n, draggable: undefined, selectable: undefined };
      }
      return n;
    }));
  }, [activeElementTool, setNodes]);

  // -------------------------------------------------------------------------
  // Effect 3: Force reroute on Sankey toggle
  // -------------------------------------------------------------------------

  useEffect(() => {
    const prev = prevSankeyViewRef.current;
    prevSankeyViewRef.current = useSankeyView;

    if (prev === undefined || prev === useSankeyView) {
      return;
    }

    if (edges.length > 0) {
      console.log(`[Sankey] View toggled from ${prev} to ${useSankeyView}, forcing re-route`);
      setForceRerouteRef.current?.(true);
    }
  }, [useSankeyView, edges.length]);

  // -------------------------------------------------------------------------
  // Effect 4: Hidden state
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!effectiveActiveTabId || !nodes.length || !edges.length) return;

    const tab = tabs.find(t => t.id === effectiveActiveTabId);
    const hiddenNodes = tab?.editorState?.hiddenNodes || new Set<string>();

    setNodes(prevNodes =>
      prevNodes.map(node => ({
        ...node,
        className: hiddenNodes.has(node.data?.id) ? 'hidden' : ''
      }))
    );

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

  // -------------------------------------------------------------------------
  // Effect 5a: Initial fitView
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!hasInitialFitViewRef.current && nodes.length > 0) {
      hasInitialFitViewRef.current = true;
      setTimeout(() => {
        console.log('Initial fitView after nodes populated:', nodes.length, 'nodes');
        fitView();
      }, 250);
    }
  }, [fitView]);

  // -------------------------------------------------------------------------
  // Effect 5b: External fitView request dagnet:fitView
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Effect 5c: Reset fitView on graph change
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (graph) {
      const graphSignature = `${graph.metadata?.version || ''}_${graph.nodes?.length || 0}_${graph.edges?.length || 0}`;

      if (currentGraphIdRef.current !== graphSignature && graphSignature !== '_0_0') {
        console.log('New graph loaded, resetting fitView flag');
        hasInitialFitViewRef.current = false;
        currentGraphIdRef.current = graphSignature;
      }
    }
  }, [graph]);

  // -------------------------------------------------------------------------
  // Effect 6: Edge scaling
  // -------------------------------------------------------------------------

  useEffect(() => {
    const scalingChanged =
      lastScalingRef.current.uniform !== useUniformScaling ||
      lastScalingRef.current.generosity !== massGenerosity;

    if (!scalingChanged || edges.length === 0) return;

    lastScalingRef.current = { uniform: useUniformScaling, generosity: massGenerosity };

    console.log('Edge scaling changed - uniform:', useUniformScaling, 'generosity:', massGenerosity);

      const edgesWithWidth = edges.map(edge => ({
        ...edge,
        data: {
          ...edge.data
        }
      }));

      const edgesWithOffsets = calculateEdgeOffsets(edgesWithWidth, nodes, MAX_EDGE_WIDTH);

    const result = edgesWithOffsets.map(edge => {
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
          sourceAnchorX: srcAnchor.x,
          sourceAnchorY: srcAnchor.y,
          targetAnchorX: tgtAnchor.x,
          targetAnchorY: tgtAnchor.y,
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
          whatIfDSL: effectiveWhatIfDSL
        }
    };
    });

    setEdges(result);
  }, [useUniformScaling, massGenerosity, edges, nodes, calculateEdgeOffsets, effectiveWhatIfDSL, setEdges]);

  // -------------------------------------------------------------------------
  // Effect 7: What-if edge recompute
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (guards.isBlocked() || guards.isInteracting()) {
      return;
    }
    if (edges.length === 0) return;
    if (guards.isRecomputeInProgress()) {
      return;
    }
    guards.beginWhatIfRecompute();
    const t0 = performance.now();
    requestAnimationFrame(() => {
      try {
        guards.markVisualOnly();
        setEdges(prevEdges => {
          const t1 = performance.now();
          const edgesWithWidth = prevEdges.map(edge => ({
            ...edge,
            data: {
              ...edge.data
            }
          }));
          const t2 = performance.now();
          const effectiveMaxWidth = useSankeyView ? 384 : MAX_EDGE_WIDTH;
          const edgesWithOffsets = calculateEdgeOffsets(edgesWithWidth, nodes, effectiveMaxWidth);
          const t3 = performance.now();
          return edgesWithOffsets.map(edge => ({
            ...edge,
            data: {
              ...edge.data,
              sourceOffsetX: edge.sourceOffsetX,
              sourceOffsetY: edge.sourceOffsetY,
              targetOffsetX: edge.targetOffsetX,
              targetOffsetY: edge.targetOffsetY,
              scaledWidth: edge.scaledWidth,
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
              whatIfDSL: effectiveWhatIfDSL
            }
          }));
        });
      } finally {
        const tEnd = performance.now();
        const totalMs = Math.round(tEnd - t0);
        if (totalMs > 10) {
          console.log(`[${ts()}] [GraphCanvas] what-if recompute done`, { totalMs });
        }
        guards.endWhatIfRecompute();
        guards.clearVisualOnly(0);
      }
    });
  }, [overridesVersion, setEdges, nodes, edges.length, graph?.metadata?.updated_at]);

  // -------------------------------------------------------------------------
  // Effect 7b: What-if latency logging
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (whatIfStartRef.current != null) {
      const dt = performance.now() - whatIfStartRef.current;
      console.log(`[${ts()}] [GraphCanvas] what-if applied`, { dtMs: Math.round(dt) });
      whatIfStartRef.current = null;
    } else {
      console.log(`[${ts()}] [GraphCanvas] overrides changed (no start marker)`);
    }
  }, [overridesVersion]);

  // -------------------------------------------------------------------------
  // Effect 8: Sankey what-if sizing
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!useSankeyView || guards.isSankeyUpdating() || guards.consumeSkipSankeyNodeSizing()) {
      if (import.meta.env.DEV) console.log('[Sankey] Skipping node sizing (guard active or layout just ran)');
      return;
    }

    const currentGraph = graphStoreHook.getState().graph;
    if (!currentGraph) return;

    const whatIfVersion = overridesVersion;
    if (lastWhatIfVersionRef.current === whatIfVersion) {
      return;
    }
    lastWhatIfVersionRef.current = whatIfVersion;
    guards.beginSankeyUpdate();

    console.log('[Sankey] What-if changed, recalculating node sizes');

    const MIN_NODE_HEIGHT_LOCAL = 60;
    const MAX_NODE_HEIGHT_LOCAL = 400;
    const flowMass = new Map<string, number>();

    currentGraph.nodes?.forEach((node: any) => {
      if (node.entry?.is_start) {
        flowMass.set(node.uuid, node.entry.entry_weight || 1.0);
      } else {
        flowMass.set(node.uuid, 0);
      }
    });

    const incomingEdges = new Map<string, Array<any>>();
    currentGraph.edges?.forEach((edge: any) => {
      if (!incomingEdges.has(edge.to)) {
        incomingEdges.set(edge.to, []);
      }
      incomingEdges.get(edge.to)!.push(edge);
    });

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

    const maxMass = Math.max(...Array.from(flowMass.values()), 0.001);

    setNodes(prevNodes => prevNodes.map(node => {
      const mass = flowMass.get(node.id) || 0;
      const normalizedMass = mass / maxMass;
      const height = Math.max(MIN_NODE_HEIGHT_LOCAL, Math.min(MAX_NODE_HEIGHT_LOCAL, normalizedMass * MAX_NODE_HEIGHT_LOCAL));

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

    guards.endSankeyUpdate(0);
  }, [useSankeyView, overridesVersion, setNodes, whatIfDSL]);

  // -------------------------------------------------------------------------
  // Effect 9: ReactFlow→Graph sync
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (guards.isBlocked()) {
      return;
    }
    if (!graph) return;
    if (guards.isVisualOnly()) {
      return;
    }
    if (guards.isSyncing()) {
      return;
    }

    if (guards.isInteracting()) {
      return;
    }

    if (nodes.length === 0 && graph.nodes.length > 0) {
      return;
    }
    if (edges.length === 0 && (graph.edges?.length || 0) > 0) {
      return;
    }

    const updatedGraph = fromFlow(nodes, edges, graph);
    if (updatedGraph) {
      const updatedJson = JSON.stringify(updatedGraph);
      if (updatedJson === lastSyncedReactFlowRef.current) {
        return;
      }

      guards.beginSync();
      lastSyncedReactFlowRef.current = updatedJson;

      setGraph(updatedGraph);

      guards.endSync(0);
    }
  }, [nodes, edges]);

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------

  return {
    guards,
    autoEditPostitIdRef,
    autoSelectAnalysisIdRef,
    lastRenderEdgesRef,
    lastSyncedReactFlowRef,
    isEffectsCooldownActive,
    handleResizeStart,
    handleResizeEnd,
  };
}
