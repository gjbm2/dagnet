/**
 * Creation tools — pure graph mutation functions extracted from GraphCanvas.
 *
 * Each function takes a graph and creation parameters, returns a new graph
 * plus the ID of the created element. The caller (GraphCanvas useCallback
 * wrappers) handles React state, selection, and history.
 */

import { buildCanvasAnalysisObject } from '../../services/canvasAnalysisCreationService';
import { constructDSLFromSelection } from '../../lib/dslConstruction';

// ---------------------------------------------------------------------------
// Node creation
// ---------------------------------------------------------------------------

export interface NodeCreationResult {
  graph: any;
  newUuid: string;
}

/**
 * Add a new empty conversion node to the graph at a given position.
 */
export function createNodeInGraph(
  graph: any,
  position: { x: number; y: number },
): NodeCreationResult {
  const newUuid = crypto.randomUUID();
  const label = `Node ${graph.nodes.length + 1}`;

  const nextGraph = structuredClone(graph);
  nextGraph.nodes.push({
    uuid: newUuid,
    id: '',
    label,
    absorbing: false,
    layout: { x: position.x, y: position.y },
  });
  if (nextGraph.metadata) {
    nextGraph.metadata.updated_at = new Date().toISOString();
  }

  return { graph: nextGraph, newUuid };
}

/**
 * Add a node with a known nodeId (from file registry) at a given position.
 * Used by paste-node and drop-node flows.
 */
export function createNodeFromFileInGraph(
  graph: any,
  nodeId: string,
  label: string,
  position: { x: number; y: number },
): NodeCreationResult {
  const newUuid = crypto.randomUUID();

  const nextGraph = structuredClone(graph);
  nextGraph.nodes.push({
    uuid: newUuid,
    id: nodeId,
    label,
    absorbing: false,
    layout: { x: position.x, y: position.y },
  });
  if (nextGraph.metadata) {
    nextGraph.metadata.updated_at = new Date().toISOString();
  }

  return { graph: nextGraph, newUuid };
}

// ---------------------------------------------------------------------------
// Post-it creation
// ---------------------------------------------------------------------------

export interface PostitCreationResult {
  graph: any;
  newId: string;
}

/**
 * Add a new post-it to the graph.
 */
export function createPostitInGraph(
  graph: any,
  position: { x: number; y: number },
  size?: { width?: number; height?: number },
): PostitCreationResult {
  const newId = crypto.randomUUID();
  const nextGraph = structuredClone(graph);
  if (!nextGraph.postits) nextGraph.postits = [];
  nextGraph.postits.push({
    id: newId,
    text: '',
    colour: '#FFF475',
    width: size?.width && size.width >= 50 ? Math.round(size.width) : 200,
    height: size?.height && size.height >= 50 ? Math.round(size.height) : 150,
    x: Math.round(position.x),
    y: Math.round(position.y),
  });
  if (nextGraph.metadata) {
    nextGraph.metadata.updated_at = new Date().toISOString();
  }

  return { graph: nextGraph, newId };
}

// ---------------------------------------------------------------------------
// Container creation
// ---------------------------------------------------------------------------

export interface ContainerCreationResult {
  graph: any;
  newId: string;
}

/**
 * Add a new container to the graph.
 */
export function createContainerInGraph(
  graph: any,
  position: { x: number; y: number },
  size?: { width?: number; height?: number },
): ContainerCreationResult {
  const newId = crypto.randomUUID();
  const nextGraph = structuredClone(graph);
  if (!nextGraph.containers) nextGraph.containers = [];
  nextGraph.containers.push({
    id: newId,
    label: 'Group',
    colour: '#94A3B8',
    width: size?.width && size.width >= 100 ? Math.round(size.width) : 400,
    height: size?.height && size.height >= 80 ? Math.round(size.height) : 300,
    x: Math.round(position.x),
    y: Math.round(position.y),
  });
  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();

  return { graph: nextGraph, newId };
}

// ---------------------------------------------------------------------------
// Canvas analysis creation
// ---------------------------------------------------------------------------

export interface CanvasAnalysisCreationResult {
  graph: any;
  analysisId: string;
  analysis: any;
}

/**
 * Add a new canvas analysis to the graph.
 */
export function createCanvasAnalysisInGraph(
  graph: any,
  position: { x: number; y: number },
  dragData: any,
): CanvasAnalysisCreationResult {
  const nextGraph = structuredClone(graph);
  if (!nextGraph.canvasAnalyses) nextGraph.canvasAnalyses = [];

  const w = dragData.drawWidth && dragData.drawWidth >= 100 ? Math.round(dragData.drawWidth) : 400;
  const h = dragData.drawHeight && dragData.drawHeight >= 80 ? Math.round(dragData.drawHeight) : 300;

  const analysis = buildCanvasAnalysisObject(
    {
      recipe: dragData.recipe || { analysis: { analysis_type: dragData.analysisType || '' } },
      viewMode: dragData.viewMode || 'chart',
      chartKind: dragData.chartKind,
      analysisResult: dragData.analysisResult,
      analysisTypeOverridden: dragData.analysisTypeOverridden ?? false,
      display: dragData.display,
      contentItems: dragData.contentItems,
    },
    { x: position.x, y: position.y },
    { width: w, height: h },
  );

  nextGraph.canvasAnalyses.push(analysis);
  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();

  return { graph: nextGraph, analysisId: analysis.id, analysis };
}

// ---------------------------------------------------------------------------
// DSL construction for "Add chart" flow
// ---------------------------------------------------------------------------

export interface AddChartPayload {
  recipe: { analysis: { analysis_type: string; analytics_dsl?: string } };
  analysisTypeOverridden: boolean;
}

/**
 * Build the pending analysis payload for the "Add chart" flow.
 * Constructs DSL from the current selection + optional context IDs.
 */
export function buildAddChartPayload(
  graph: any,
  rfNodes: any[],
  rfEdges: any[],
  contextNodeIds: string[],
  contextEdgeIds: string[],
  isCanvasObjectNode: (id: string) => boolean,
  getContainedConversionNodeIds: (container: any, nodes: any[]) => string[],
): AddChartPayload {
  let selectedConversionNodes = rfNodes
    .filter(n => n.selected && !isCanvasObjectNode(n.id))
    .map(n => n.data?.id || n.id);

  // Expand selected containers to their contained nodes when no conversion nodes are selected
  if (selectedConversionNodes.length === 0 && graph?.containers) {
    const selectedContainers = rfNodes.filter(n => n.selected && n.id?.startsWith('container-'));
    for (const cn of selectedContainers) {
      const cid = cn.id.replace('container-', '');
      const c = graph.containers.find((ci: any) => ci.id === cid);
      if (c) {
        const contained = getContainedConversionNodeIds(c, rfNodes);
        selectedConversionNodes.push(...contained.map(rfId => {
          const n = rfNodes.find(nd => nd.id === rfId);
          return n?.data?.id || rfId;
        }));
      }
    }
  }

  const selectedEdgeUuids = rfEdges
    .filter(e => e.selected)
    .map(e => e.id);

  const mergedNodeIds = [...new Set([...selectedConversionNodes, ...contextNodeIds])];
  const mergedEdgeIds = [...new Set([...selectedEdgeUuids, ...contextEdgeIds])];

  let analyticsDsl = constructDSLFromSelection(
    mergedNodeIds, mergedEdgeIds, rfNodes as any[], (graph?.edges || []) as any[],
  );

  console.log('[startAddChart]', {
    contextNodeIds,
    contextEdgeIds,
    selectedConversionNodes,
    mergedNodeIds,
    mergedEdgeIds,
    analyticsDsl,
    rfNodeCount: rfNodes.length,
    graphEdgeCount: graph?.edges?.length || 0,
  });

  if (!analyticsDsl && contextEdgeIds.length > 0 && graph?.edges) {
    const ge = graph.edges.find((ed: any) => ed.uuid === contextEdgeIds[0] || ed.id === contextEdgeIds[0]);
    if (ge) {
      const fromRaw: string = ge.from || (ge as any).source || '';
      const toRaw: string = ge.to || (ge as any).target || '';
      const fromNode = graph.nodes?.find((n: any) => n.uuid === fromRaw || n.id === fromRaw);
      const toNode = graph.nodes?.find((n: any) => n.uuid === toRaw || n.id === toRaw);
      const fromId = fromNode?.id || fromRaw;
      const toId = toNode?.id || toRaw;
      if (fromId && toId) {
        analyticsDsl = `from(${fromId}).to(${toId})`;
      }
    }
  }

  return {
    recipe: { analysis: { analysis_type: '', analytics_dsl: analyticsDsl || undefined } },
    analysisTypeOverridden: false,
  };
}
