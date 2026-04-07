/**
 * AnalyticsPanel
 * 
 * Analytics panel with multi-scenario support.
 * 
 * Features:
 * - Shows DSL query string using QueryExpressionEditor (Monaco chip editor)
 * - AutomatableField wrapper for override state (ZapOff icon)
 * - Lists available analysis types
 * - Multi-scenario analysis: sends all visible scenario graphs to backend
 * - Backend decides result structure (may integrate comparisons or return separate data)
 * - Persists override state to TabContext
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useGraphStore } from '../../contexts/GraphStoreContext';
import { useTabContext } from '../../contexts/TabContext';
import { useScenariosContextOptional } from '../../contexts/ScenariosContext';
import { useAnalysisBootContext } from '../../contexts/AnalysisBootContext';
import { graphComputeClient, AnalysisResponse, AvailableAnalysis } from '../../lib/graphComputeClient';
import { constructDSLFromSelection } from '../../lib/dslConstruction';
import { AnalysisChartContainer, normaliseChartKind } from '../charts/AnalysisChartContainer';
import { ChartFloatingIcon } from '../charts/ChartInlineSettingsFloating';
import { ExpressionToolbarTray } from '../charts/ExpressionToolbarTray';
import { AutomatableField } from '../AutomatableField';
import { QueryExpressionEditor } from '../QueryExpressionEditor';
import { BarChart3, AlertCircle, CheckCircle2, Loader2, Eye, EyeOff, Info, Lightbulb, List, RefreshCw, ExternalLink, GripVertical, PinIcon, ChevronsDown } from 'lucide-react';
import { chartOperationsService } from '../../services/chartOperationsService';
import {
  resolveDisplaySetting,
} from '../../lib/analysisDisplaySettingsRegistry';
import { ANALYSIS_TYPES, getAnalysisTypeMeta } from './analysisTypes';
import { AnalysisTypeCardList } from './AnalysisTypeCardList';
import { AnalysisTypeSection } from './AnalysisTypeSection';
import { resolveAnalysisType } from '../../services/analysisTypeResolutionService';
import { hydrateSnapshotPlannerInputs } from '../../services/snapshotSubjectResolutionService';
import { fileRegistry } from '../../contexts/TabContext';
import CollapsibleSection from '../CollapsibleSection';
import { AnalysisResultCards } from '../analytics/AnalysisResultCards';
import { AnalysisResultTable } from '../analytics/AnalysisResultTable';
import { checkBridgeStatus, createAmplitudeDraft } from '../../services/amplitudeBridgeService';
import { buildAmplitudeFunnelDefinition } from '../../services/amplitudeFunnelBuilderService';
import { parseDSL } from '../../lib/queryDSL';
import { AmplitudeBridgeInstallModal } from '../modals/AmplitudeBridgeInstallModal';
import { sessionLogService } from '../../services/sessionLogService';
import { IndexedDBConnectionProvider } from '../../lib/das/IndexedDBConnectionProvider';
import { prepareAnalysisComputeInputs, runPreparedAnalysis } from '../../services/analysisComputePreparationService';
import { logChartReadinessTrace } from '../../lib/snapshotBootTrace';
import toast from 'react-hot-toast';
import { copyToClipboard } from '../../utils/copyToClipboard';
import type { ViewMode } from '../../types/chartRecipe';
import './AnalyticsPanel.css';

/**
 * Draggable expression section — wraps a single expression (chart/cards/table)
 * with a grip handle, pin-to-canvas button, and collapsible body.
 */
function ExpressionSection(props: {
  viewMode: ViewMode;
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  dragPayload: any;
  onPin: () => void;
  onOpenAsTab?: () => void;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { label, collapsed, onToggle, dragPayload, onPin, onOpenAsTab, toolbar, children } = props;
  const contentRef = useRef<HTMLDivElement>(null);

  const titleContent = (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
      <GripVertical size={12} style={{ color: 'var(--text-muted, #9ca3af)', flexShrink: 0 }} />
      <span>{label}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
        {onOpenAsTab && (
          <button
            title="Open as tab"
            className="expression-section-pin"
            onClick={(e) => { e.stopPropagation(); onOpenAsTab(); }}
          >
            <ExternalLink size={12} />
          </button>
        )}
        <button
          title={`Pin ${label.toLowerCase()} to canvas`}
          className="expression-section-pin"
          onClick={(e) => { e.stopPropagation(); onPin(); }}
        >
          <PinIcon size={12} />
        </button>
      </span>
    </span>
  );

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/json', JSON.stringify(dragPayload));
        e.dataTransfer.effectAllowed = 'copy';
        const target = e.currentTarget as HTMLElement;
        if (target) e.dataTransfer.setDragImage(target, target.offsetWidth / 2, 20);
      }}
    >
      <CollapsibleSection
        title={titleContent}
        isOpen={!collapsed}
        onToggle={onToggle}
      >
        <div ref={contentRef} style={{ position: 'relative' }}>
          {toolbar && (
            <ChartFloatingIcon
              containerRef={contentRef}
              tray={toolbar}
              defaultAnchor="top-right"
            />
          )}
          {children}
        </div>
      </CollapsibleSection>
    </div>
  );
}

interface AnalyticsPanelProps {
  tabId?: string;
  hideHeader?: boolean;
}

export default function AnalyticsPanel({ tabId, hideHeader = false }: AnalyticsPanelProps) {
  // Get store state directly using the hook (same pattern as PropertiesPanel)
  const { graph, currentDSL } = useGraphStore();
  
  // Get scenario context for multi-scenario analysis
  const scenariosContext = useScenariosContextOptional();
  const { tabs, operations } = useTabContext();
  
  const bootContext = useAnalysisBootContext();
  
  // Extract nodes and edges from graph (for DSL construction)
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  
  // Get visible scenarios for this tab
  const scenarioState = useMemo(() => {
    if (!tabId) return null;
    return operations.getScenarioState(tabId);
  }, [tabId, operations, tabs]); // Include tabs to trigger re-render on state changes
  
  const visibleScenarioIds = scenarioState?.visibleScenarioIds || ['current'];
  const scenarioOrder = scenarioState?.scenarioOrder || ['current'];
  
  // Get What-If DSL from tab state (for 'current' layer analysis)
  const currentTab = tabId ? tabs.find(t => t.id === tabId) : undefined;
  const whatIfDSL = currentTab?.editorState?.whatIfDSL || null;
  
  // Order visible scenarios to match legend display order:
  // base (if visible) -> user scenarios (REVERSED scenarioOrder) -> current
  // Legend displays chips left-to-right as: base, oldest scenario, ..., newest scenario, current
  const orderedVisibleScenarios = useMemo(() => {
    const ordered: string[] = [];
    
    // 1. Base first (if visible)
    if (visibleScenarioIds.includes('base')) {
      ordered.push('base');
    }
    
    // 2. User scenarios in REVERSED scenarioOrder (to match legend chip order)
    const userScenarioOrder = scenarioOrder
      .filter(id => id !== 'base' && id !== 'current')
      .reverse(); // Legend reverses the order
    for (const id of userScenarioOrder) {
      if (visibleScenarioIds.includes(id)) {
        ordered.push(id);
      }
    }
    
    // 3. Current last (if visible)
    if (visibleScenarioIds.includes('current')) {
      ordered.push('current');
    }
    
    return ordered;
  }, [visibleScenarioIds, scenarioOrder]);

  // Chart rendering: pick a single scenario for v1 funnel charts (multi-scenario can come later).
  const chartScenarioId = useMemo(() => {
    if (!tabId) return orderedVisibleScenarios[0] || 'current';
    const selected = operations.getScenarioState(tabId)?.selectedScenarioId;
    if (selected && orderedVisibleScenarios.includes(selected)) return selected;
    return orderedVisibleScenarios[0] || 'current';
  }, [tabId, operations, orderedVisibleScenarios]);

  // Serialize visible scenarios + per-scenario visibility modes.
  //
  // IMPORTANT: These must be declared BEFORE runAnalysis/useEffect logic that depends on them.
  // Otherwise we can hit the temporal dead zone (Cannot access before initialization).
  const visibleScenariosKey = orderedVisibleScenarios.join(',');

  // Triggers re-analysis when scenario DATA changes (not just visible IDs).
  // Scenario regeneration updates params + increments scenario.version, but keeps IDs stable.
  const visibleScenarioDataKey = useMemo(() => {
    const versionById = new Map((scenariosContext?.scenarios || []).map(s => [s.id, s.version]));
    return orderedVisibleScenarios
      .map(id => {
        if (id === 'base' || id === 'current') return id;
        return `${id}@${versionById.get(id) ?? 0}`;
      })
      .join(',');
  }, [orderedVisibleScenarios, scenariosContext?.scenarios]);

  // Triggers re-analysis when any scenario's F/E/F+E mode changes.
  const visibilityModesKey = useMemo(() => {
    const key = orderedVisibleScenarios
      .map(id => `${id}:${tabId ? operations.getScenarioVisibilityMode(tabId, id) : 'f+e'}`)
      .join(',');
    console.log('[AnalyticsPanel] visibilityModesKey computed:', key);
    return key;
  }, [orderedVisibleScenarios, tabId, operations, scenarioState]); // scenarioState changes when modes change
  
  // Get scenario colour from stored values (not computed)
  const getScenarioColour = useCallback((scenarioId: string): string => {
    if (!scenariosContext) return '#808080';
    
    if (scenarioId === 'current') {
      return scenariosContext.currentColour || '#808080';
    } else if (scenarioId === 'base') {
      return scenariosContext.baseColour || '#808080';
    } else {
      const scenario = scenariosContext.scenarios.find(s => s.id === scenarioId);
      return scenario?.colour || '#808080';
    }
  }, [scenariosContext]);
  
  // Get scenario name helper
  const getScenarioName = useCallback((scenarioId: string): string => {
    if (scenarioId === 'current') return 'Current';
    if (scenarioId === 'base') return 'Base';
    const scenario = scenariosContext?.scenarios.find(s => s.id === scenarioId);
    return scenario?.name || scenarioId;
  }, [scenariosContext?.scenarios]);
  
  // State - DSL is NOT persisted, always derived from selection
  // (Override state is session-only, not saved across reloads)
  const [queryDSL, setQueryDSL] = useState<string>('');
  const [isQueryOverridden, setIsQueryOverridden] = useState(false);
  const [availableAnalyses, setAvailableAnalyses] = useState<AvailableAnalysis[]>([]);
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<string | null>(null);
  const [results, setResults] = useState<AnalysisResponse | null>(null);
  // For snapshot-based analyses, charts need the *composed* snapshot DSL (from/to + window/cohort)
  // so they can apply the correct axis semantics. `results.query_dsl` is currently the panel's
  // analytics DSL (from/to only), so we track the composed DSL separately.
  const [snapshotChartDsl, setSnapshotChartDsl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showAllAnalyses, setShowAllAnalyses] = useState(false);
  const [showSpinner, setShowSpinner] = useState(false); // Delayed spinner
  const [error, setError] = useState<string | null>(null);
  const [plannerFileIds, setPlannerFileIds] = useState<string[]>([]);
  const [plannerRegistryVersion, setPlannerRegistryVersion] = useState(0);
  
  // ---- Local display settings for panel expressions (not persisted to chart file) ----
  const [tableDisplay, setTableDisplay] = useState<Record<string, any>>({});
  const [cardsDisplay, setCardsDisplay] = useState<Record<string, any>>({});

  const updateTableDisplay = useCallback((key: string, value: any) => {
    setTableDisplay(prev => ({ ...prev, [key]: value }));
  }, []);
  const updateCardsDisplay = useCallback((key: string, value: any) => {
    setCardsDisplay(prev => ({ ...prev, [key]: value }));
  }, []);

  // Refs for debouncing and request tracking
  const analysisRequestRef = useRef<number>(0);
  const spinnerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Use a ref for graph to avoid recreating callbacks on every graph change
  const graphRef = useRef(graph);
  graphRef.current = graph;
  
  // Track selected nodes and edges from React Flow (via custom event)
  // Node IDs are human-readable; edge UUIDs are raw ReactFlow UUIDs.
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeUuids, setSelectedEdgeUuids] = useState<string[]>([]);
  
  // Query React Flow's selection state and convert UUIDs to human-readable IDs
  // Uses graphRef to avoid dependency on graph changing
  const querySelection = useCallback((): { nodeIds: string[]; edgeUuids: string[] } | null => {
    const detail = {
      selectedNodeUuids: [] as string[],
      selectedEdgeUuids: [] as string[]
    };
    // Dispatch synchronous event - GraphCanvas listener will populate detail with UUIDs
    window.dispatchEvent(new CustomEvent('dagnet:querySelection', { detail }));
    
    // Access graph from ref to get current value without dependency
    const currentNodes = graphRef.current?.nodes;
    if (!currentNodes || currentNodes.length === 0) {
      // Graph not loaded yet - return null to signal "not ready"
      return null;
    }
    
    // Convert node UUIDs to human-readable IDs
    const humanReadableIds: string[] = [];
    for (const uuid of detail.selectedNodeUuids) {
      const node = currentNodes.find((n: any) => n.uuid === uuid || n.id === uuid);
      if (node) {
        humanReadableIds.push(node.id);
      }
    }
    
    return { nodeIds: humanReadableIds, edgeUuids: detail.selectedEdgeUuids };
  }, []); // No dependencies - uses refs
  
  // Poll for selection changes (since there's no direct callback from React Flow)
  useEffect(() => {
    let mounted = true;
    
    // Helper to check and update selection
    const handleSelectionChange = () => {
      if (!mounted) return;
      
      const sel = querySelection();
      // Skip if graph not ready (null return)
      if (sel === null) return;
      
      setSelectedNodeIds(prev => {
        const prevStr = prev.slice().sort().join(',');
        const newStr = sel.nodeIds.slice().sort().join(',');
        return prevStr !== newStr ? sel.nodeIds : prev;
      });
      setSelectedEdgeUuids(prev => {
        const prevStr = prev.slice().sort().join(',');
        const newStr = sel.edgeUuids.slice().sort().join(',');
        return prevStr !== newStr ? sel.edgeUuids : prev;
      });
    };
    
    // Initial query
    handleSelectionChange();
    
    // Poll periodically (500ms - don't need to be super fast)
    const pollInterval = setInterval(handleSelectionChange, 500);
    
    // Also listen for any clicks that might change selection
    window.addEventListener('mouseup', handleSelectionChange);
    window.addEventListener('keyup', handleSelectionChange);
    
    return () => {
      mounted = false;
      clearInterval(pollInterval);
      window.removeEventListener('mouseup', handleSelectionChange);
      window.removeEventListener('keyup', handleSelectionChange);
    };
  }, [querySelection]);
  
  // Compute auto-generated DSL (shared codepath with element palette chart creation)
  const autoGeneratedDSL = useMemo(() => {
    const dsl = constructDSLFromSelection(selectedNodeIds, selectedEdgeUuids, nodes as any[], edges as any[]);
    if (selectedNodeIds.length > 0 || selectedEdgeUuids.length > 0) {
      console.log('[AnalyticsPanel] autoGeneratedDSL', { selectedNodeIds, selectedEdgeUuids, dsl, nodeCount: nodes.length, edgeCount: edges.length });
    }
    return dsl;
  }, [selectedNodeIds, selectedEdgeUuids, nodes, edges]);
  
  // Auto-construct DSL when selection changes (only if not overridden)
  useEffect(() => {
    if (!isQueryOverridden) {
      setQueryDSL(autoGeneratedDSL);
    }
  }, [autoGeneratedDSL, isQueryOverridden]);
  
  // No persistence - DSL is session-only, derived from selection
  
  // Handle DSL change from QueryExpressionEditor
  const handleDSLChange = useCallback((newValue: string) => {
    setQueryDSL(newValue);
  }, []);
  
  // Handle blur - commit the override if value differs from auto-generated
  const handleDSLBlur = useCallback((currentValue: string) => {
    if (currentValue !== autoGeneratedDSL) {
      setIsQueryOverridden(true);
    }
  }, [autoGeneratedDSL]);
  
  // Clear override - reset to auto-generated
  const clearOverride = useCallback(() => {
    setQueryDSL(autoGeneratedDSL);
    setIsQueryOverridden(false);
  }, [autoGeneratedDSL]);

  const handleAnalysisTypeCardDragStart = useCallback((
    event: React.DragEvent<HTMLButtonElement>,
    typeMeta: { id: string }
  ) => {
    const payload = {
      type: 'dagnet-drag',
      objectType: 'canvas-analysis',
      recipe: {
        analysis: {
          analysis_type: typeMeta.id,
          analytics_dsl: queryDSL || undefined,
        },
      },
      analysisTypeOverridden: true,
    };
    event.dataTransfer.setData('application/json', JSON.stringify(payload));
    event.dataTransfer.effectAllowed = 'copy';
  }, [queryDSL]);
  
  // Fetch available analyses when DSL changes (DSL is source of truth for analysis matching)
  const lastFetchKeyRef = useRef<string>('');
  
  useEffect(() => {
    if (!graph) {
      setAvailableAnalyses([]);
      setSelectedAnalysisId(null);
      return;
    }
    
    const fetchKey = `${graph.nodes?.length || 0}-${queryDSL || ''}-${visibleScenarioIds.length}`;
    if (fetchKey === lastFetchKeyRef.current) return;
    
    const fetchAvailable = async () => {
      try {
        lastFetchKeyRef.current = fetchKey;
        console.log('[AnalyticsPanel] resolveAnalysisType', { fetchKey, queryDSL, graphNodeCount: graph.nodes?.length, scenarioCount: visibleScenarioIds.length });
        const { availableAnalyses: resolved, primaryAnalysisType } = await resolveAnalysisType(
          graph, queryDSL || undefined, visibleScenarioIds.length
        );
        console.log('[AnalyticsPanel] resolved', { availableAnalyses: resolved.map(a => a.id), primaryAnalysisType });
        setAvailableAnalyses(resolved);
        setSelectedAnalysisId(primaryAnalysisType);
      } catch (err) {
        console.warn('[AnalyticsPanel] Failed to fetch available analyses:', err);
        setAvailableAnalyses([]);
      }
    };
    
    fetchAvailable();
  }, [graph, queryDSL, visibleScenarioIds.length]);
  
  // Run analysis - called automatically on state changes
  // Supports multi-scenario analysis when multiple scenarios are visible
  const runAnalysis = useCallback(async () => {
    if (!graph) {
      setResults(null);
      setError(null);
      return;
    }
    
    // Need either selection or DSL (or an analysis type that doesn't require them)
    const hasInput = selectedNodeIds.length > 0 || queryDSL.trim();
    if (!hasInput && !selectedAnalysisId) {
      setResults(null);
      setError(null);
      return;
    }
    
    // Track this request to avoid race conditions
    const requestId = ++analysisRequestRef.current;
    
    setIsLoading(true);
    setError(null);
    
    // Show spinner after 500ms delay
    if (spinnerTimeoutRef.current) {
      clearTimeout(spinnerTimeoutRef.current);
    }
    spinnerTimeoutRef.current = setTimeout(() => {
      if (analysisRequestRef.current === requestId) {
        setShowSpinner(true);
      }
    }, 500);
    
    try {
      // === Frontend-only: lag_fit bypass ===
      // Compute entirely from in-browser parameter data — no backend call needed.
      let response: AnalysisResponse;

      const snapshotMeta = selectedAnalysisId
        ? ANALYSIS_TYPES.find(t => t.id === selectedAnalysisId)
        : undefined;
      const needsSnapshots = !!snapshotMeta?.snapshotContract;
      const graphFile = currentTab?.fileId ? fileRegistry.getFile(currentTab.fileId) : undefined;
      const repository = graphFile?.source?.repository;
      const branch = graphFile?.source?.branch;
      const workspace = (repository && branch) ? { repository, branch } : undefined;

      logChartReadinessTrace('AnalyticsPanel:prepare-triggered', {
        tabId,
        analysisType: selectedAnalysisId,
        needsSnapshots,
        workspace,
        orderedVisibleScenarios,
        queryDSL,
        currentDSL,
      });

      const prepared = await prepareAnalysisComputeInputs({
        mode: 'panel',
        graph,
        analysisType: selectedAnalysisId,
        analyticsDsl: queryDSL,
        currentDSL,
        chartCurrentLayerDsl: '',
        needsSnapshots,
        workspace,
        rawScenarioStateLoaded: Boolean(scenarioState),
        visibleScenarioIds: orderedVisibleScenarios,
        scenariosContext: scenariosContext as any,
        whatIfDSL,
        getScenarioVisibilityMode: (scenarioId) => (
          tabId ? operations.getScenarioVisibilityMode(tabId, scenarioId) : 'f+e'
        ),
        getScenarioName,
        getScenarioColour,
      });

      if (prepared.status !== 'ready') {
        logChartReadinessTrace('AnalyticsPanel:blocked', {
          tabId,
          analysisType: selectedAnalysisId,
          reason: prepared.reason,
          requiredFileIds: prepared.requiredFileIds || [],
          hydratableFileIds: prepared.hydratableFileIds || [],
          unavailableFileIds: prepared.unavailableFileIds || [],
        });
        setPlannerFileIds(prepared.requiredFileIds || []);
        if (!bootContext && prepared.reason === 'planner_inputs_pending_hydration' && (prepared.hydratableFileIds || []).length > 0) {
          logChartReadinessTrace('AnalyticsPanel:hydrate-planner-inputs', {
            tabId,
            analysisType: selectedAnalysisId,
            hydratableFileIds: prepared.hydratableFileIds || [],
            workspace,
          });
          void hydrateSnapshotPlannerInputs({
            fileIds: prepared.hydratableFileIds || [],
            workspace,
          });
        }
        setIsLoading(false);
        setShowSpinner(false);
        setError(null);
        return;
      }

      setPlannerFileIds([]);
      logChartReadinessTrace('AnalyticsPanel:prepared-ready', {
        tabId,
        analysisType: selectedAnalysisId,
        signature: prepared.signature,
        scenarioCount: prepared.scenarios.length,
      });
      response = await runPreparedAnalysis(prepared);
      const chartScenario = prepared.scenarios.find((scenario) => scenario.scenario_id === chartScenarioId);
      setSnapshotChartDsl(needsSnapshots ? (chartScenario?.snapshot_query_dsl || null) : null);
      
      // Only update if this is still the latest request
      if (analysisRequestRef.current === requestId) {
        setResults(response);
        
        if (!response.success) {
          const errMsg = typeof response.error === 'string'
            ? response.error
            : response.error?.message || 'Analysis returned success=false';
          setError(errMsg);
        }
      }
    } catch (err) {
      if (analysisRequestRef.current === requestId) {
        setError(err instanceof Error ? err.message : 'Analysis failed');
        setResults(null);
      }
    } finally {
      if (analysisRequestRef.current === requestId) {
        setIsLoading(false);
        setShowSpinner(false);
        if (spinnerTimeoutRef.current) {
          clearTimeout(spinnerTimeoutRef.current);
          spinnerTimeoutRef.current = null;
        }
      }
    }
  }, [
    graph,
    selectedNodeIds,
    queryDSL,
    selectedAnalysisId,
    orderedVisibleScenarios,
    scenariosContext,
    getScenarioName,
    getScenarioColour,
    whatIfDSL,
    // Ensure visibility-mode changes (F/E/F+E) update the closure used by runAnalysis,
    // otherwise we'd keep reading stale modes and see no differences.
    visibilityModesKey,
    tabId,
    operations,
    // currentDSL is used by getQueryDslForScenario for snapshot analysis date range.
    // Must be in deps to avoid stale closure when WindowSelector updates the DSL.
    currentDSL,
    chartScenarioId,
    plannerRegistryVersion,
  ]);
  
  // Store runAnalysis in a ref to avoid effect re-triggers
  const runAnalysisRef = useRef(runAnalysis);
  runAnalysisRef.current = runAnalysis;
  
  // Track previous values for detecting what changed
  const prevAnalysisIdRef = useRef<string | null>(null);
  const prevGraphRef = useRef(graph);
  const prevQueryDSLRef = useRef(queryDSL);
  const prevSelectedNodesRef = useRef(selectedNodeIds);
  const prevScenariosKeyRef = useRef(visibleScenariosKey);
  const prevScenarioDataKeyRef = useRef(visibleScenarioDataKey);
  const prevWhatIfDSLRef = useRef(whatIfDSL);
  const prevVisibilityModesRef = useRef(visibilityModesKey);
  
  // Single unified effect that handles all triggers
  useEffect(() => {
    if (bootContext && !bootContext.bootReady) return;

    // Analysis changed: either switched from one to another, OR newly selected (prev was null)
    const analysisChanged = selectedAnalysisId !== null && 
                           prevAnalysisIdRef.current !== selectedAnalysisId;
    
    const graphChanged = prevGraphRef.current !== graph;
    const queryChanged = prevQueryDSLRef.current !== queryDSL;
    const selectionChanged = prevSelectedNodesRef.current !== selectedNodeIds;
    const scenariosChanged = prevScenariosKeyRef.current !== visibleScenariosKey;
    const scenarioDataChanged = prevScenarioDataKeyRef.current !== visibleScenarioDataKey;
    const whatIfChanged = prevWhatIfDSLRef.current !== whatIfDSL;
    const visibilityModesChanged = prevVisibilityModesRef.current !== visibilityModesKey;
    
    if (visibilityModesChanged) {
      console.log('[AnalyticsPanel] Effect: visibilityModesChanged!', {
        prev: prevVisibilityModesRef.current,
        curr: visibilityModesKey,
      });
    }
    
    // Update refs
    prevAnalysisIdRef.current = selectedAnalysisId;
    prevGraphRef.current = graph;
    prevQueryDSLRef.current = queryDSL;
    prevSelectedNodesRef.current = selectedNodeIds;
    prevScenariosKeyRef.current = visibleScenariosKey;
    prevScenarioDataKeyRef.current = visibleScenarioDataKey;
    prevWhatIfDSLRef.current = whatIfDSL;
    prevVisibilityModesRef.current = visibilityModesKey;
    
    // If analysis type changed (including first selection), run immediately
    if (analysisChanged) {
      runAnalysisRef.current();
      return;
    }
    
    // For other changes, debounce
    // What-If changes should also trigger re-analysis since they affect probabilities
    // Visibility mode changes (F/E/F+E) change the probability basis used
    if (graphChanged || queryChanged || selectionChanged || scenariosChanged || scenarioDataChanged || whatIfChanged || visibilityModesChanged) {
      const timeoutId = setTimeout(() => {
        runAnalysisRef.current();
      }, 300);
      return () => clearTimeout(timeoutId);
    }
  }, [graph, selectedNodeIds, queryDSL, selectedAnalysisId, visibleScenariosKey, visibleScenarioDataKey, whatIfDSL, visibilityModesKey, bootContext?.bootReady]);
  
  // Cleanup spinner timeout on unmount
  useEffect(() => {
    return () => {
      if (spinnerTimeoutRef.current) {
        clearTimeout(spinnerTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (bootContext) return undefined;
    if (plannerFileIds.length === 0) return undefined;
    logChartReadinessTrace('AnalyticsPanel:subscribe-planner-files', {
      tabId,
      analysisType: selectedAnalysisId,
      fileIds: plannerFileIds,
    });
    const unsubscribers = plannerFileIds.map((fileId) => fileRegistry.subscribe(fileId, () => {
      logChartReadinessTrace('AnalyticsPanel:planner-file-updated', {
        tabId,
        analysisType: selectedAnalysisId,
        fileId,
      });
      setPlannerRegistryVersion((value) => value + 1);
    }));
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [bootContext, plannerFileIds]);


  // For live scenarios, show the effective (composited) query DSL that produced the scenario.
  // This is display-only metadata (computed/stored by the scenarios system).
  const scenarioDslSubtitleById = useMemo(() => {
    const map = new Map<string, string>();
    // Special layers
    // AUTHORITATIVE: GraphStore.currentDSL (WindowSelector-owned). graph.currentQueryDSL is historic record only.
    const currentDsl =
      (typeof currentDSL === 'string' && currentDSL.trim())
        ? currentDSL
        : graph?.currentQueryDSL;
    if (typeof currentDsl === 'string' && currentDsl.trim()) map.set('current', currentDsl);

    const baseDsl = scenariosContext?.baseDSL || graph?.baseDSL;
    if (typeof baseDsl === 'string' && baseDsl.trim()) {
      map.set('base', baseDsl);
    }

    if (!scenariosContext?.scenarios) return map;

    for (const s of scenariosContext.scenarios) {
      const meta: any = s?.meta;
      if (!meta?.isLive) continue;
      const dsl = meta.lastEffectiveDSL || meta.queryDSL;
      if (typeof dsl === 'string' && dsl.trim()) {
        map.set(s.id, dsl);
      }
    }

    return map;
  }, [currentDSL, graph?.currentQueryDSL, graph?.baseDSL, scenariosContext?.baseDSL, scenariosContext?.scenarios]);

  // Add a context suffix to the analysis name when the backend provides metadata,
  // e.g. "Reach Probability — Switch success".
  const scenarioDslSubtitleByIdObject = useMemo(() => {
    const obj: Record<string, string> = {};
    for (const [k, v] of scenarioDslSubtitleById.entries()) obj[k] = v;
    return obj;
  }, [scenarioDslSubtitleById]);
  
  // Refresh: clear cache and re-run analysis (bypasses cache for the next compute)
  const handleRefresh = useCallback(() => {
    graphComputeClient.clearCache();
    // Set one-shot bypass so the immediate recompute doesn't re-populate from a stale module singleton.
    try { (window as any).__dagnetComputeNoCacheOnce = true; } catch { /* ignore */ }
    runAnalysis();
  }, [runAnalysis]);

  // ── Amplitude Bridge ──────────────────────────────────────────────────
  const [showBridgeInstall, setShowBridgeInstall] = useState(false);

  const [amplitudeLoading, setAmplitudeLoading] = useState(false);

  const handleOpenInAmplitude = useCallback(async () => {
    setAmplitudeLoading(true);
    const logOpId = sessionLogService.startOperation(
      'info', 'amplitude', 'AMP_FUNNEL_EXPORT',
      `Opening funnel in Amplitude`,
    );
    try {
      const status = await checkBridgeStatus();
      if (!status.installed) {
        sessionLogService.endOperation(logOpId, 'warning', 'Bridge extension not installed');
        setShowBridgeInstall(true);
        return;
      }
      sessionLogService.addChild(logOpId, 'debug', 'AMP_BRIDGE_OK', `Bridge v${status.version || '?'} detected`);

      if (!graph) {
        sessionLogService.endOperation(logOpId, 'warning', 'No graph');
        alert('No graph is open.');
        return;
      }

      // Determine funnel steps: from explicit node selection, or from the analytics DSL
      // (which is auto-generated from edge selection: clicking an edge produces from(A).to(B))
      let funnelNodeIds = [...selectedNodeIds];
      if (funnelNodeIds.length === 0 && queryDSL.trim()) {
        // Parse from/to/visited from the analytics DSL to get funnel steps
        const parsed = parseDSL(queryDSL);
        const dslNodes: string[] = [];
        if (parsed.from) dslNodes.push(parsed.from);
        if (parsed.visited?.length) dslNodes.push(...parsed.visited);
        if (parsed.to) dslNodes.push(parsed.to);
        funnelNodeIds = dslNodes;
      }

      if (funnelNodeIds.length === 0) {
        sessionLogService.endOperation(logOpId, 'warning', 'No nodes or edge selected');
        alert('Select nodes or an edge on the graph.');
        return;
      }

      // Resolve Amplitude connection from edges touching the funnel nodes.
      // Each edge may specify a connection (edge.p.connection); fall back to graph.defaultConnection.
      const connProvider = new IndexedDBConnectionProvider();
      const graphDefaultConn = (graph as any).defaultConnection || '';
      const selectedNodeSet = new Set(funnelNodeIds);

      // Collect connection names from edges that touch selected nodes
      const edgeConnections: string[] = [];
      const nonAmplitudeNodes: string[] = [];
      for (const edge of (graph.edges || [])) {
        // Resolve from/to UUIDs to node IDs
        const fromNode = (graph.nodes || []).find((n: any) => n.uuid === edge.from || n.id === edge.from);
        const toNode = (graph.nodes || []).find((n: any) => n.uuid === edge.to || n.id === edge.to);
        const fromId = fromNode?.id;
        const toId = toNode?.id;
        if (!fromId || !toId) continue;
        if (!selectedNodeSet.has(fromId) && !selectedNodeSet.has(toId)) continue;

        const edgeConn = edge.p?.connection || graphDefaultConn;
        if (!edgeConn) {
          // Node's edge has no connection at all
          if (selectedNodeSet.has(fromId)) nonAmplitudeNodes.push(fromId);
          if (selectedNodeSet.has(toId)) nonAmplitudeNodes.push(toId);
        } else if (!edgeConn.startsWith('amplitude')) {
          // Non-amplitude connection
          if (selectedNodeSet.has(fromId)) nonAmplitudeNodes.push(fromId);
          if (selectedNodeSet.has(toId)) nonAmplitudeNodes.push(toId);
        } else {
          edgeConnections.push(edgeConn);
        }
      }

      // Warn if any selected nodes lack Amplitude data
      const uniqueNonAmp = [...new Set(nonAmplitudeNodes)];
      if (uniqueNonAmp.length > 0) {
        const msg = `${uniqueNonAmp.length} node(s) have no Amplitude data source: ${uniqueNonAmp.join(', ')}`;
        sessionLogService.addChild(logOpId, 'warning', 'AMP_NON_AMP_NODES', msg);
        toast(msg, { duration: 6000, icon: '⚠️' });
      }

      // Determine the winning connection
      const uniqueConns = [...new Set(edgeConnections)];
      if (uniqueConns.length === 0) {
        // No amplitude connections found on any edge — fall back to graph default
        if (graphDefaultConn && graphDefaultConn.startsWith('amplitude')) {
          uniqueConns.push(graphDefaultConn);
        }
      }

      if (uniqueConns.length === 0) {
        sessionLogService.endOperation(logOpId, 'error', 'No Amplitude connection found on graph or selected edges.');
        alert('No Amplitude connection found.\n\nThe selected nodes have no edges with an Amplitude connection, and the graph has no defaultConnection set.');
        return;
      }

      // Warn if mixed connections (e.g. some edges prod, some staging)
      if (uniqueConns.length > 1) {
        const msg = `Mixed Amplitude connections detected: ${uniqueConns.join(', ')}. Using "${uniqueConns[0]}".`;
        sessionLogService.addChild(logOpId, 'warning', 'AMP_MIXED_CONNECTIONS', msg);
        toast(msg, { duration: 6000, icon: '⚠️' });
      }

      const connectionName = uniqueConns[0];
      let appId = '';
      let orgId = '';
      let orgSlug = '';
      let excludedCohorts: string[] = [];
      try {
        const conn = await connProvider.getConnection(connectionName);
        const defaults = (conn.defaults || {}) as Record<string, any>;
        appId = defaults.app_id || '';
        orgId = defaults.org_id || '';
        orgSlug = defaults.org_slug || '';
        excludedCohorts = Array.isArray(defaults.excluded_cohorts) ? defaults.excluded_cohorts : [];
      } catch (e) {
        sessionLogService.addChild(logOpId, 'warning', 'AMP_CONN_LOAD_ERR',
          `Could not load connection "${connectionName}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      if (!appId || !orgId || !orgSlug) {
        sessionLogService.endOperation(logOpId, 'error',
          `Amplitude project not configured on connection "${connectionName}". Set app_id, org_id, and org_slug in connections.yaml.`,
        );
        alert(`Amplitude project not configured.\n\nThe connection "${connectionName}" is missing app_id, org_id, or org_slug in its defaults.\n\nEdit connections.yaml and add these fields under the "${connectionName}" connection.`);
        return;
      }

      sessionLogService.addChild(logOpId, 'debug', 'AMP_CONN_RESOLVED',
        `Connection: ${connectionName} (from ${uniqueConns.length > 1 ? 'first of ' + uniqueConns.length + ' mixed' : 'edges'}) → app=${appId}, org=${orgId}`,
      );

      // Compose the effective DSL from both sources:
      // - queryDSL: analytics panel's query (from/to/visited + any user-edited constraints)
      // - currentDSL: graph-level DSL (window/context/case from window selector)
      // Both may carry context(), case(), window(), exclude() clauses.
      const dslParts = [queryDSL, currentDSL].filter(d => d && d.trim()).join('.');
      const effectiveDsl = dslParts || null;

      sessionLogService.addChild(logOpId, 'debug', 'AMP_DSL_COMPOSED',
        `Effective DSL: ${effectiveDsl || '(none)'}`,
        `queryDSL: ${queryDSL || '(empty)'}\ncurrentDSL: ${currentDSL || '(empty)'}\ncomposed: ${effectiveDsl || '(none)'}`,
      );

      // Build the full funnel definition with all constraints
      const buildResult = await buildAmplitudeFunnelDefinition({
        selectedNodeIds: funnelNodeIds,
        graphNodes: graph.nodes || [],
        graphEdges: graph.edges || [],
        effectiveDsl,
        appId,
        connectionDefaults: { excluded_cohorts: excludedCohorts },
      });

      // Log the constructed funnel definition
      const eventNames = buildResult.definition.params.events.map((e: any) => e.event_type);
      const segCondCount = buildResult.definition.params.segments?.[0]?.conditions?.length || 0;
      const cs = (buildResult.definition.params as any).conversionSeconds;
      sessionLogService.addChild(logOpId, 'info', 'AMP_FUNNEL_BUILT',
        `${eventNames.length} steps, ${segCondCount} segment conditions, cs=${cs ? (cs / 86400) + 'd' : 'default'}`,
        `Steps: ${buildResult.stepsIncluded.join(' → ')}\nEvents: ${eventNames.join(' → ')}\nConversion window: ${cs ? cs + 's (' + (cs / 86400) + 'd)' : 'default'}`,
      );

      if (buildResult.warnings.length > 0) {
        for (const w of buildResult.warnings) {
          sessionLogService.addChild(logOpId, 'warning', 'AMP_FUNNEL_WARN', w);
          toast(w, { duration: 6000, icon: '⚠️' });
        }
      }

      if (buildResult.definition.params.events.length === 0) {
        sessionLogService.endOperation(logOpId, 'error', 'No Amplitude events found for selected nodes');
        alert('No Amplitude events found for the selected nodes. Ensure nodes have event_id bindings with Amplitude event names.');
        return;
      }

      sessionLogService.addChild(logOpId, 'info', 'AMP_DRAFT_CREATING', 'Creating Amplitude draft via bridge...');
      const result = await createAmplitudeDraft(buildResult.definition, orgId, orgSlug);
      if (result.success) {
        sessionLogService.endOperation(logOpId, 'success',
          `Funnel draft created: ${eventNames.join(' → ')}`,
          { draftUrl: result.draftUrl },
        );
        window.open(result.draftUrl, '_blank', 'noopener,noreferrer');
      } else if (result.reason === 'not_authenticated') {
        sessionLogService.endOperation(logOpId, 'warning', 'Not authenticated — user redirected to Amplitude login');
        alert('Not logged into Amplitude. Opening Amplitude login — please sign in, then try again.');
        window.open('https://app.amplitude.com/login', '_blank', 'noopener,noreferrer');
      } else {
        sessionLogService.endOperation(logOpId, 'error', `Draft creation failed: ${result.message}`);
        alert(`Failed to create Amplitude funnel: ${result.message}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sessionLogService.endOperation(logOpId, 'error', `Amplitude bridge error: ${msg}`);
      alert(`Amplitude bridge error: ${msg}`);
    } finally {
      setAmplitudeLoading(false);
    }
  }, [graph, selectedNodeIds, queryDSL, currentDSL]);

  const handleBridgeInstalled = useCallback(async () => {
    setShowBridgeInstall(false);
    // Extension just detected — proceed with the original action
    await handleOpenInAmplitude();
  }, [handleOpenInAmplitude]);

  const showAmplitudeButton = selectedNodeIds.length > 0 || queryDSL.trim().length > 0;

  // ── Expression section collapsed state ──
  // Driven by renderability: open what can render, close what can't.
  const canRenderChart = !!normaliseChartKind(results?.result?.semantics?.chart?.recommended);
  const canRenderCards = !!results?.result?.semantics?.dimensions?.some((d: any) => d.role === 'primary');
  const canRenderTable = (results?.result?.data?.length ?? 0) > 0;

  // Track which sections the user has manually toggled (null = follow auto logic)
  const [userToggles, setUserToggles] = useState<Record<string, boolean | null>>({ chart: null, cards: null, table: null });
  // Reset user toggles when results change (new analysis type / DSL)
  const resultKey = `${selectedAnalysisId}::${queryDSL}`;
  const prevResultKeyRef = useRef(resultKey);
  if (resultKey !== prevResultKeyRef.current) {
    prevResultKeyRef.current = resultKey;
    setUserToggles({ chart: null, cards: null, table: null });
  }

  const chartCollapsed = userToggles.chart ?? !canRenderChart;
  const cardsCollapsed = userToggles.cards ?? (canRenderChart ? true : !canRenderCards);
  const tableCollapsed = userToggles.table ?? (canRenderChart || canRenderCards ? true : !canRenderTable);

  const handleOpenAsTab = useCallback((viewMode: ViewMode) => {
    const result = results?.result;
    if (!result) return;
    chartOperationsService.openAnalysisChartTabFromAnalysis({
      chartKind: result.semantics?.chart?.recommended as any,
      analysisResult: result,
      scenarioIds: orderedVisibleScenarios,
      source: {
        parent_tab_id: tabId,
        parent_file_id: currentTab?.fileId,
        query_dsl: snapshotChartDsl || results.query_dsl,
        analysis_type: result.analysis_type,
      },
      render: { view_mode: viewMode, display: {} },
    });
  }, [results, orderedVisibleScenarios, tabId, currentTab?.fileId, snapshotChartDsl]);

  const handleDumpDebug = useCallback(async (viewMode: ViewMode) => {
    const result = results?.result;
    if (!result) return;
    const payload = { analysisType: selectedAnalysisId, queryDSL, result, viewMode };
    const ok = await copyToClipboard(JSON.stringify(payload, null, 2));
    if (ok) {
      toast.success('Debug JSON copied to clipboard');
    } else {
      toast.error('Clipboard write failed — check browser permissions or use HTTPS');
    }
  }, [results, selectedAnalysisId, queryDSL]);

  return (
    <div className="analytics-panel">
      {/* Header */}
      {!hideHeader && (
        <div className="analytics-header">
          <BarChart3 size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
          <h3 className="analytics-title">Analytics</h3>
          {showAmplitudeButton && (
            <button
              onClick={handleOpenInAmplitude}
              disabled={amplitudeLoading}
              title="Open funnel in Amplitude"
              style={{ marginLeft: 'auto', background: 'none', border: '1px solid #6366f1', cursor: amplitudeLoading ? 'wait' : 'pointer', padding: '2px 8px', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#4338ca', whiteSpace: 'nowrap', opacity: amplitudeLoading ? 0.5 : 1 }}
            >
              {amplitudeLoading ? 'Opening...' : 'Amplitude'} <ExternalLink size={11} strokeWidth={2} />
            </button>
          )}
          <button
            className="analytics-refresh-btn"
            onClick={handleRefresh}
            disabled={isLoading}
            title="Clear cache and re-run analysis"
            style={{ marginLeft: showAmplitudeButton ? undefined : 'auto', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 4, display: 'flex', alignItems: 'center', opacity: isLoading ? 0.4 : 0.6 }}
            onMouseEnter={e => { if (!isLoading) (e.currentTarget.style.opacity = '1'); }}
            onMouseLeave={e => { (e.currentTarget.style.opacity = isLoading ? '0.4' : '0.6'); }}
          >
            <RefreshCw size={13} strokeWidth={2} className={isLoading ? 'analytics-spin' : ''} />
          </button>
        </div>
      )}
      
      {/* Main content area - responsive layout */}
      <div className="analytics-content">
        {/* Controls column */}
        <div className="analytics-controls">
          {/* Collapsible Selection & Query section */}
          <CollapsibleSection 
            title={
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                <span>Selection & Query</span>
                {selectedNodeIds.length > 0 && (
                  <span className="analytics-muted" style={{ marginLeft: 'auto', fontWeight: 400 }}>
                    {selectedNodeIds.length} node{selectedNodeIds.length !== 1 ? 's' : ''}
                  </span>
                )}
              </span>
            }
            defaultOpen={false}
            icon={List}
          >
            {/* Selection info */}
            <div className="analytics-selection-info">
              {selectedNodeIds.length === 0 ? (
                <span className="analytics-muted">No nodes selected</span>
              ) : (
                <>
                  <span>{selectedNodeIds.length} node{selectedNodeIds.length !== 1 ? 's' : ''}: </span>
                  <span className="analytics-node-ids" title={selectedNodeIds.join(', ')}>
                    {selectedNodeIds.slice(0, 3).join(', ')}
                    {selectedNodeIds.length > 3 && `, +${selectedNodeIds.length - 3} more`}
                  </span>
                </>
              )}
            </div>
            
            {/* DSL Query - using AutomatableField + QueryExpressionEditor */}
            <div style={{ marginTop: 8 }}>
              <AutomatableField
                label="Query DSL"
                layout="label-above"
                value={queryDSL}
                overridden={isQueryOverridden}
                onClearOverride={clearOverride}
                tooltip="DSL query derived from selection. Edit to override auto-generation."
              >
                <QueryExpressionEditor
                  value={queryDSL}
                  onChange={handleDSLChange}
                  onBlur={handleDSLBlur}
                  graph={graph}
                  placeholder="from(node).to(node)"
                  height="40px"
                />
              </AutomatableField>
            </div>
          </CollapsibleSection>
          
          {/* Analysis Type Selector */}
          <AnalysisTypeSection
            availableAnalyses={availableAnalyses}
            selectedAnalysisId={selectedAnalysisId}
            onSelect={(analysisId) => setSelectedAnalysisId(analysisId)}
            defaultOpen={true}
            draggableAvailableCards={true}
            onCardDragStart={handleAnalysisTypeCardDragStart}
          />
        </div>
        
        {/* Results divider */}
        <div className="analytics-results-divider">
          <ChevronsDown size={16} strokeWidth={2.5} />
        </div>

        {/* Results column */}
        <div className="analytics-output">
          {/* Loading Spinner (delayed) */}
          {showSpinner && (
            <div className="analytics-loading">
              <Loader2 size={16} className="analytics-spinner" />
              <span>Analyzing...</span>
            </div>
          )}
          
          {/* Error */}
          {error && (
            <div className="analytics-error">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}
          
          {/* Results — each expression is independently draggable to canvas */}
          {results && results.success && results.result?.data && (<>

            {/* Chart expression */}
            <ExpressionSection
                viewMode="chart"
                label="Chart"
                collapsed={chartCollapsed}
                onToggle={() => setUserToggles(t => ({ ...t, chart: !chartCollapsed }))}
                dragPayload={{
                  type: 'dagnet-drag',
                  objectType: 'canvas-analysis',
                  chartKind: results.result?.semantics?.chart?.recommended,
                  recipe: { analysis: { analysis_type: selectedAnalysisId, analytics_dsl: queryDSL || undefined } },
                  analysisResult: results.result,
                  analysisTypeOverridden: true,
                  viewMode: 'chart',
                }}
                onPin={() => {
                  window.dispatchEvent(new CustomEvent('dagnet:pinAnalysisToCanvas', {
                    detail: {
                      objectType: 'canvas-analysis',
                      chartKind: results.result?.semantics?.chart?.recommended,
                      recipe: { analysis: { analysis_type: selectedAnalysisId, analytics_dsl: queryDSL || undefined } },
                      analysisResult: results.result,
                      analysisTypeOverridden: true,
                      viewMode: 'chart',
                    },
                  }));
                }}
                onOpenAsTab={() => handleOpenAsTab('chart')}
              >
                <AnalysisChartContainer
                  result={results.result}
                  visibleScenarioIds={orderedVisibleScenarios}
                  scenarioVisibilityModes={(() => {
                    const m: Record<string, 'f+e' | 'f' | 'e'> = {};
                    for (const id of orderedVisibleScenarios) {
                      m[id] = tabId ? operations.getScenarioVisibilityMode(tabId, id) : 'f+e';
                    }
                    return m;
                  })()}
                  height={results.result?.semantics?.chart?.recommended === 'bridge' ? 280 : 420}
                  chartContext="tab"
                  scenarioDslSubtitleById={scenarioDslSubtitleByIdObject}
                  source={{
                    parent_tab_id: tabId,
                    parent_file_id: currentTab?.fileId,
                    query_dsl: snapshotChartDsl || results.query_dsl,
                    analysis_type: results.result.analysis_type,
                  }}
                  onOpenAsTab={() => handleOpenAsTab('chart')}
                  onDumpDebug={() => handleDumpDebug('chart')}
                />
            </ExpressionSection>

            {/* Cards expression */}
            <ExpressionSection
                viewMode="cards"
                label="Cards"
                collapsed={cardsCollapsed}
                onToggle={() => setUserToggles(t => ({ ...t, cards: !cardsCollapsed }))}
                dragPayload={{
                  type: 'dagnet-drag',
                  objectType: 'canvas-analysis',
                  chartKind: results.result?.semantics?.chart?.recommended,
                  recipe: { analysis: { analysis_type: selectedAnalysisId, analytics_dsl: queryDSL || undefined } },
                  analysisResult: results.result,
                  analysisTypeOverridden: true,
                  viewMode: 'cards',
                }}
                onPin={() => {
                  window.dispatchEvent(new CustomEvent('dagnet:pinAnalysisToCanvas', {
                    detail: {
                      objectType: 'canvas-analysis',
                      chartKind: results.result?.semantics?.chart?.recommended,
                      recipe: { analysis: { analysis_type: selectedAnalysisId, analytics_dsl: queryDSL || undefined } },
                      analysisResult: results.result,
                      analysisTypeOverridden: true,
                      viewMode: 'cards',
                    },
                  }));
                }}
                onOpenAsTab={() => handleOpenAsTab('cards')}
                toolbar={
                  <ExpressionToolbarTray
                    viewMode="cards"
                    result={results.result}
                    display={cardsDisplay}
                    onDisplayChange={(k, v) => { if (typeof k === 'string') updateCardsDisplay(k, v); }}
                    onDumpDebug={() => handleDumpDebug('cards')}
                  />
                }
              >
                <AnalysisResultCards
                  result={results.result}
                  scenarioDslSubtitleById={scenarioDslSubtitleByIdObject}
                  fontSize={resolveDisplaySetting(cardsDisplay, { key: 'font_size', defaultValue: 10 } as any)}
                  collapsedCards={resolveDisplaySetting(cardsDisplay, { key: 'cards_collapsed', defaultValue: [] } as any) as string[]}
                  onCollapsedCardsChange={(collapsed) => updateCardsDisplay('cards_collapsed', collapsed)}
                />
            </ExpressionSection>

            {/* Table expression */}
            <ExpressionSection
                viewMode="table"
                label="Table"

                collapsed={tableCollapsed}
                onToggle={() => setUserToggles(t => ({ ...t, table: !tableCollapsed }))}
                dragPayload={{
                  type: 'dagnet-drag',
                  objectType: 'canvas-analysis',
                  chartKind: results.result?.semantics?.chart?.recommended,
                  recipe: { analysis: { analysis_type: selectedAnalysisId, analytics_dsl: queryDSL || undefined } },
                  analysisResult: results.result,
                  analysisTypeOverridden: true,
                  viewMode: 'table',
                }}
                onPin={() => {
                  window.dispatchEvent(new CustomEvent('dagnet:pinAnalysisToCanvas', {
                    detail: {
                      objectType: 'canvas-analysis',
                      chartKind: results.result?.semantics?.chart?.recommended,
                      recipe: { analysis: { analysis_type: selectedAnalysisId, analytics_dsl: queryDSL || undefined } },
                      analysisResult: results.result,
                      analysisTypeOverridden: true,
                      viewMode: 'table',
                    },
                  }));
                }}
                onOpenAsTab={() => handleOpenAsTab('table')}
                toolbar={
                  <ExpressionToolbarTray
                    viewMode="table"
                    result={results.result}
                    display={tableDisplay}
                    onDisplayChange={(k, v) => { if (typeof k === 'string') updateTableDisplay(k, v); }}
                    onDumpDebug={() => handleDumpDebug('table')}
                  />
                }
              >
                <div style={{ height: 320 }}>
                  <AnalysisResultTable
                    result={results.result}
                    fontSize={resolveDisplaySetting(tableDisplay, { key: 'font_size', defaultValue: 10 } as any)}
                    striped={resolveDisplaySetting(tableDisplay, { key: 'table_striped', defaultValue: true } as any) as boolean}
                    sortColumn={resolveDisplaySetting(tableDisplay, { key: 'table_sort_column', defaultValue: '' } as any) as string || undefined}
                    sortDirection={resolveDisplaySetting(tableDisplay, { key: 'table_sort_direction', defaultValue: 'asc' } as any) as 'asc' | 'desc'}
                    onSortChange={(col, dir) => { updateTableDisplay('table_sort_column', col); updateTableDisplay('table_sort_direction', dir); }}
                    hiddenColumns={resolveDisplaySetting(tableDisplay, { key: 'table_hidden_columns', defaultValue: [] } as any) as string[]}
                    onHiddenColumnsChange={(h) => updateTableDisplay('table_hidden_columns', h)}
                    columnOrder={resolveDisplaySetting(tableDisplay, { key: 'table_column_order', defaultValue: [] } as any) as string[]}
                    onColumnOrderChange={(o) => updateTableDisplay('table_column_order', o)}
                    columnWidths={resolveDisplaySetting(tableDisplay, { key: 'table_column_widths', defaultValue: '' } as any) as string || undefined}
                    onColumnWidthsChange={(w) => updateTableDisplay('table_column_widths', w)}
                  />
                </div>
            </ExpressionSection>

          </>)}
        </div>
        
        {/* Debug JSON — use "Dump debug JSON" from context menu for full diagnostics */}
      </div>

      {/* Amplitude Bridge install modal */}
      <AmplitudeBridgeInstallModal
        isOpen={showBridgeInstall}
        onClose={() => setShowBridgeInstall(false)}
        onInstalled={handleBridgeInstalled}
      />
    </div>
  );
}

