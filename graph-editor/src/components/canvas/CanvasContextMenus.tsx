/**
 * CanvasContextMenus — presentational sub-component rendering all context menus.
 *
 * Extracted from GraphCanvas Phase C1 (structural refactor, no behavioural change).
 * Receives all state and callbacks as props from GraphCanvas.
 */

import React from 'react';
import type { Edge, Node, Connection } from 'reactflow';
import { Plus, StickyNote, Square, BarChart3, Clipboard, CheckSquare, Monitor, MonitorOff, X } from 'lucide-react';
import { ContextMenu, type ContextMenuItem } from '../ContextMenu';
import { NodeContextMenu } from '../NodeContextMenu';
import { PostItContextMenu } from '../PostItContextMenu';
import { ContainerContextMenu } from '../ContainerContextMenu';
import { CanvasAnalysisContextMenu } from '../CanvasAnalysisContextMenu';
import { EdgeContextMenu } from '../EdgeContextMenu';
import { MultiSelectContextMenu } from '../MultiSelectContextMenu';
import { ScenarioQueryEditModal } from '../modals/ScenarioQueryEditModal';
import { canvasAnalysisResultCache } from '../../hooks/useCanvasAnalysisCompute';
import { chartOperationsService } from '../../services/chartOperationsService';
import { extractSubgraph } from '../../lib/subgraphExtractor';
import type { AvailableAnalysis } from '../../lib/graphComputeClient';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CanvasContextMenusProps {
  // Graph state
  graph: any;
  setGraph: (graph: any, oldGraph?: any, source?: string) => void;
  setGraphDirect: (graph: any) => void;
  saveHistoryState: (action: string, nodeId?: string | undefined, edgeId?: string | undefined) => void;
  nodes: Node[];
  edges: Edge[];
  graphFileId?: string | null;

  // Context menu state
  contextMenu: { x: number; y: number; flowX: number; flowY: number } | null;
  setContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; flowX: number; flowY: number } | null>>;
  nodeContextMenu: { x: number; y: number; nodeId: string } | null;
  setNodeContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; nodeId: string } | null>>;
  postitContextMenu: { x: number; y: number; postitId: string } | null;
  setPostitContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; postitId: string } | null>>;
  containerContextMenu: { x: number; y: number; containerId: string } | null;
  setContainerContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; containerId: string } | null>>;
  analysisContextMenu: { x: number; y: number; analysisId: string } | null;
  setAnalysisContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; analysisId: string } | null>>;
  multiSelectContextMenu: { x: number; y: number } | null;
  setMultiSelectContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  edgeContextMenu: { x: number; y: number; edgeId: string } | null;
  setEdgeContextMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; edgeId: string } | null>>;
  contextMenuLocalData: { probability: number; conditionalProbabilities: { [key: string]: number }; variantWeight: number } | null;
  setContextMenuLocalData: React.Dispatch<React.SetStateAction<{ probability: number; conditionalProbabilities: { [key: string]: number }; variantWeight: number } | null>>;
  ctxDslEditState: { analysisId: string; scenarioId: string } | null;
  setCtxDslEditState: React.Dispatch<React.SetStateAction<{ analysisId: string; scenarioId: string } | null>>;
  analysisCtxAvailableTypes: AvailableAnalysis[];

  // Pane context menu actions
  addNodeAtPosition: (x: number, y: number) => void;
  pasteNodeAtPosition: (x: number, y: number) => void;
  pasteSubgraphAtPosition: (x: number, y: number) => void;
  setActiveElementTool: (tool: any) => void;
  startAddChart: (detail?: { contextNodeIds?: string[]; contextEdgeIds?: string[] }) => void;
  copiedNode: any;
  copiedSubgraph: any;
  copySubgraph: (...args: any[]) => void;
  isDashboardMode: boolean;
  toggleDashboardMode: (opts: { updateUrl: boolean }) => void;
  tabId: string | undefined;
  tabs: any[];
  tabOperations: any;
  effectiveActiveTabId: string | null | undefined;

  // Node/edge/canvas object handlers
  handleUpdateAnalysis: (id: string, updates: any) => void;
  handleDeleteAnalysis: (id: string) => void;
  handleDeleteContainer: (id: string) => void;
  deleteNode: (id: string) => void;
  deleteEdge: (id: string) => void;
  reorderCanvasNodes: (prefix: string, graphArray: any[]) => void;
  onSelectedNodeChange: (id: string | null) => void;
  onSelectedEdgeChange: (id: string | null) => void;
  onSelectedAnnotationChange?: (id: string | null, type: 'container' | 'postit' | 'canvasAnalysis' | null) => void;
  getContainedConversionNodeIds: (container: any, nodes: Node[]) => string[];

  // Alignment
  align: any;
  distribute: any;
  equalSize: any;
  canAlign: any;
  canDistribute: any;

  // Store / scenarios
  store: { currentDSL: string | null; setCurrentDSL: (dsl: string) => void };
  scenariosContext: any;
  captureTabScenariosToRecipe: any;

  // Variant modal (from useEdgeConnection)
  showVariantModal: boolean;
  pendingConnection: Connection | null;
  caseNodeVariants: any[];
  handleVariantSelection: (variant: any) => void;
  dismissVariantModal: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CanvasContextMenus: React.FC<CanvasContextMenusProps> = React.memo(({
  graph,
  setGraph,
  setGraphDirect,
  saveHistoryState,
  nodes,
  edges,
  graphFileId,
  contextMenu,
  setContextMenu,
  nodeContextMenu,
  setNodeContextMenu,
  postitContextMenu,
  setPostitContextMenu,
  containerContextMenu,
  setContainerContextMenu,
  analysisContextMenu,
  setAnalysisContextMenu,
  multiSelectContextMenu,
  setMultiSelectContextMenu,
  edgeContextMenu,
  setEdgeContextMenu,
  contextMenuLocalData,
  setContextMenuLocalData,
  ctxDslEditState,
  setCtxDslEditState,
  analysisCtxAvailableTypes,
  addNodeAtPosition,
  pasteNodeAtPosition,
  pasteSubgraphAtPosition,
  setActiveElementTool,
  startAddChart,
  copiedNode,
  copiedSubgraph,
  copySubgraph,
  isDashboardMode,
  toggleDashboardMode,
  tabId,
  tabs,
  tabOperations,
  effectiveActiveTabId,
  handleUpdateAnalysis,
  handleDeleteAnalysis,
  handleDeleteContainer,
  deleteNode,
  deleteEdge,
  reorderCanvasNodes,
  onSelectedNodeChange,
  onSelectedEdgeChange,
  onSelectedAnnotationChange,
  getContainedConversionNodeIds,
  align,
  distribute,
  equalSize,
  canAlign,
  canDistribute,
  store,
  scenariosContext,
  captureTabScenariosToRecipe,
  showVariantModal,
  pendingConnection,
  caseNodeVariants,
  handleVariantSelection,
  dismissVariantModal,
}) => {
  return (
    <>
      {/* Pane Context Menu */}
      {contextMenu && (() => {
        const paneItems: ContextMenuItem[] = [
          { label: 'Add node', icon: <Plus size={14} />, onClick: () => addNodeAtPosition(contextMenu.flowX, contextMenu.flowY) },
          { label: 'Add post-it', icon: <StickyNote size={14} />, onClick: () => setActiveElementTool('new-postit') },
          { label: 'Add container', icon: <Square size={14} />, onClick: () => setActiveElementTool('new-container') },
          { label: 'Add chart', icon: <BarChart3 size={14} />, onClick: () => startAddChart() },
          { label: '', onClick: () => {}, divider: true },
        ];
        if (copiedNode) {
          paneItems.push({
            label: `Paste node: ${copiedNode.objectId}`,
            icon: <Clipboard size={14} />,
            onClick: () => pasteNodeAtPosition(contextMenu.flowX, contextMenu.flowY),
          });
        }
        if (copiedSubgraph) {
          const desc = [
            copiedSubgraph.nodes.length > 0 && `${copiedSubgraph.nodes.length} node${copiedSubgraph.nodes.length !== 1 ? 's' : ''}`,
            copiedSubgraph.edges.length > 0 && `${copiedSubgraph.edges.length} edge${copiedSubgraph.edges.length !== 1 ? 's' : ''}`,
            (copiedSubgraph.postits?.length ?? 0) > 0 && `${copiedSubgraph.postits!.length} post-it${copiedSubgraph.postits!.length !== 1 ? 's' : ''}`,
          ].filter(Boolean).join(', ');
          paneItems.push({
            label: `Paste (${desc})`,
            icon: <Clipboard size={14} />,
            onClick: () => pasteSubgraphAtPosition(contextMenu.flowX, contextMenu.flowY),
          });
        }
        if (nodes.length > 0) {
          paneItems.push({
            label: 'Select All',
            icon: <CheckSquare size={14} />,
            onClick: () => window.dispatchEvent(new CustomEvent('dagnet:selectAllNodes')),
          });
        }
        if (copiedNode || copiedSubgraph || nodes.length > 0) {
          paneItems.push({ label: '', onClick: () => {}, divider: true });
        }
        paneItems.push({
          label: isDashboardMode ? 'Exit dashboard mode' : 'Enter dashboard mode',
          icon: isDashboardMode ? <MonitorOff size={14} /> : <Monitor size={14} />,
          onClick: () => toggleDashboardMode({ updateUrl: true }),
        });
        if (tabId) {
          paneItems.push({
            label: 'Close tab',
            icon: <X size={14} />,
            onClick: () => { tabOperations.closeTab(tabId); },
          });
        }
        return (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={paneItems}
            onClose={() => setContextMenu(null)}
          />
        );
      })()}

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
        const currentTab = tabId ? tabs.find((t: any) => t.id === tabId) : undefined;
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
              const currentTab = tabs.find((t: any) => t.id === tabId);
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
          activeTabId={effectiveActiveTabId ?? null}
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
                const sourceNode = graph?.nodes.find((n: any) => n.uuid === pendingConnection?.source || n.id === pendingConnection?.source);
                const hasExistingEdge = graph?.edges.some((edge: any) =>
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
    </>
  );
});

CanvasContextMenus.displayName = 'CanvasContextMenus';
