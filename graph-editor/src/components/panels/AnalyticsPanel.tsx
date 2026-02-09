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
import { graphComputeClient, AnalysisResponse, AvailableAnalysis } from '../../lib/graphComputeClient';
import { constructQueryDSL } from '../../lib/dslConstruction';
import { buildGraphForAnalysisLayer } from '../../services/CompositionService';
import { AnalysisChartContainer } from '../charts/AnalysisChartContainer';
import { AutomatableField } from '../AutomatableField';
import { QueryExpressionEditor } from '../QueryExpressionEditor';
import { BarChart3, AlertCircle, CheckCircle2, Loader2, ChevronRight, Eye, EyeOff, Info, Lightbulb, List, Code, RefreshCw } from 'lucide-react';
import { ANALYSIS_TYPES, getAnalysisTypeMeta } from './analysisTypes';
import { querySelectionUuids } from '../../hooks/useQuerySelectionUuids';
import { mapFetchPlanToSnapshotSubjects, composeSnapshotDsl, extractDateRangeFromDSL } from '../../services/snapshotDependencyPlanService';
import { computeInheritedDSL, computeEffectiveFetchDSL } from '../../services/scenarioRegenerationService';
import { buildFetchPlanProduction } from '../../services/fetchPlanBuilderService';
import { fileRegistry } from '../../contexts/TabContext';
import CollapsibleSection from '../CollapsibleSection';
import { AnalysisResultCards } from '../analytics/AnalysisResultCards';
import './AnalyticsPanel.css';

// composeSnapshotDsl and extractDateRangeFromDSL are imported from snapshotDependencyPlanService

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
  const [isLoading, setIsLoading] = useState(false);
  const [showAllAnalyses, setShowAllAnalyses] = useState(false);
  const [showSpinner, setShowSpinner] = useState(false); // Delayed spinner
  const [error, setError] = useState<string | null>(null);
  
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
  
  // Compute auto-generated DSL
  const autoGeneratedDSL = useMemo(() => {
    // Node selection takes priority
    if (selectedNodeIds.length > 0) {
      return constructQueryDSL(selectedNodeIds, nodes as any[], edges as any[]);
    }

    // Single edge selected (no nodes): derive from(A).to(B)
    if (selectedEdgeUuids.length === 1) {
      const edgeUuid = selectedEdgeUuids[0];
      const graphEdge = edges.find((e: any) => e.uuid === edgeUuid || e.id === edgeUuid);
      if (graphEdge) {
        const fromUuid = (graphEdge as any).from || (graphEdge as any).source;
        const toUuid = (graphEdge as any).to || (graphEdge as any).target;
        const fromNode = nodes.find((n: any) => n.uuid === fromUuid || n.id === fromUuid);
        const toNode = nodes.find((n: any) => n.uuid === toUuid || n.id === toUuid);
        if (fromNode && toNode) {
          return `from(${(fromNode as any).id}).to(${(toNode as any).id})`;
        }
      }
    }

    return '';
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
  
  // Fetch available analyses when DSL changes (DSL is source of truth for analysis matching)
  // Track last fetch key to avoid duplicate requests for same parameters
  const lastFetchKeyRef = useRef<string>('');
  
  useEffect(() => {
    if (!graph) {
      setAvailableAnalyses([]);
      setSelectedAnalysisId(null);
      return;
    }
    
    // Create a key for this fetch request to avoid duplicates
    const fetchKey = `${graph.nodes?.length || 0}-${queryDSL || ''}-${visibleScenarioIds.length}`;
    if (fetchKey === lastFetchKeyRef.current) {
      return; // Skip - same parameters as last fetch
    }
    
    const fetchAvailable = async () => {
      try {
        console.log('[AnalyticsPanel] Fetching analyses for DSL:', JSON.stringify(queryDSL));
        lastFetchKeyRef.current = fetchKey;
        
        const response = await graphComputeClient.getAvailableAnalyses(
          graph,
          queryDSL || undefined,
          visibleScenarioIds.length // Pass scenario count for analysis type matching
        );
        // Normalize IDs (handle aliases like graph_overview_empty -> graph_overview)
        const normalizeId = (id: string) => id === 'graph_overview_empty' ? 'graph_overview' : id;
        const normalizedAnalyses = response.analyses.map(a => ({
          ...a,
          id: normalizeId(a.id)
        }));
        
        console.log('[AnalyticsPanel] Got analyses:', normalizedAnalyses.map(a => a.id));
        setAvailableAnalyses(normalizedAnalyses);
        
        // Preserve current selection if it's still available; otherwise fall back to primary
        setSelectedAnalysisId(prev => {
          if (prev && normalizedAnalyses.some(a => a.id === prev)) {
            return prev; // current selection is still valid — keep it
          }
          const primary = normalizedAnalyses.find(a => a.is_primary);
          return primary ? primary.id : null;
        });
      } catch (err) {
        console.warn('Failed to fetch available analyses:', err);
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
      let response: AnalysisResponse;
      
      // === Per-scenario snapshot dependency resolution ===
      // If the selected analysis type has a snapshotContract, we resolve DB coordinates
      // *per scenario* so each scenario carries its own snapshot subjects (derived from
      // that scenario's effective DSL, not a single global DSL).
      const snapshotMeta = selectedAnalysisId
        ? ANALYSIS_TYPES.find(t => t.id === selectedAnalysisId)
        : undefined;
      const needsSnapshots = !!snapshotMeta?.snapshotContract;
      
      // Workspace identity (shared across all scenarios)
      const graphFile = currentTab?.fileId ? fileRegistry.getFile(currentTab.fileId) : undefined;
      const repository = graphFile?.source?.repository;
      const branch = graphFile?.source?.branch;
      const workspace = (repository && branch) ? { repository, branch } : undefined;
      
      // DEV diagnostic: trace snapshot analysis resolution
      console.error('[AnalyticsPanel] SNAPSHOT DIAG:', {
        selectedAnalysisId,
        needsSnapshots,
        hasSnapshotMeta: !!snapshotMeta,
        hasSnapshotContract: !!snapshotMeta?.snapshotContract,
        hasWorkspace: !!workspace,
        workspace: workspace ? `${repository}/${branch}` : null,
        currentDSL,
        queryDSL,
        tabId,
        hasCurrentTab: !!currentTab,
        fileId: currentTab?.fileId,
        hasGraphFile: !!graphFile,
        hasSource: !!graphFile?.source,
      });
      
      // Get the FULL composited query DSL for a scenario.
      // Live scenarios MUST go through the composition machinery — a raw
      // scenario DSL (e.g. just "context(channel:paid-search)") is
      // meaningless without the inherited base/window context.
      const getQueryDslForScenario = (scenarioId: string): string => {
        if (scenarioId === 'current') return currentDSL || '';
        if (scenarioId === 'base') {
          const baseDsl = scenariosContext?.baseDSL || graph?.baseDSL;
          return typeof baseDsl === 'string' ? baseDsl : currentDSL || '';
        }
        const scenario = scenariosContext?.scenarios?.find(s => s.id === scenarioId);
        const meta: any = scenario?.meta;
        if (meta?.isLive) {
          // Prefer the pre-computed composited DSL from the regeneration pass
          if (typeof meta.lastEffectiveDSL === 'string' && meta.lastEffectiveDSL.trim()) {
            return meta.lastEffectiveDSL;
          }
          // Fallback: compute on-the-fly using the compositor machinery.
          // This covers scenarios that were just created and haven't been
          // regenerated yet.
          const visibleScenarios = orderedVisibleScenarios
            .map(id => scenariosContext?.scenarios?.find(s => s.id === id))
            .filter(Boolean) as Array<{ id: string; meta?: any }>;
          const scenarioIndex = visibleScenarios.findIndex(s => s.id === scenarioId);
          if (scenarioIndex >= 0) {
            const baseDsl = currentDSL || scenariosContext?.baseDSL || graph?.baseDSL || '';
            const inheritedDSL = computeInheritedDSL(scenarioIndex, visibleScenarios as any, baseDsl);
            return computeEffectiveFetchDSL(inheritedDSL, meta.queryDSL || '');
          }
        }
        return currentDSL || '';
      };
      
      // Helper: resolve snapshot subjects for a given scenario.
      //
      // Composes a FULL snapshot DSL by merging:
      //   - from/to from the analytics panel DSL (what path to analyse)
      //   - window/cohort/asat/context from the query DSL (data scope)
      // If the analytics DSL already has temporal or context clauses, those
      // take priority (user override).
      //
      // IMPORTANT: This THROWS on failure rather than silently returning undefined.
      // Snapshot analysis types MUST NOT silently fall back to standard analysis.
      const resolveSnapshotSubjectsForScenario = async (
        scenarioGraph: any,
        analyticsDsl: string,
        scenarioId: string,
      ): Promise<import('../../services/snapshotDependencyPlanService').SnapshotSubjectRequest[]> => {
        if (!workspace) {
          throw new Error('Snapshot analysis requires a git-backed graph (no workspace found). Ensure the graph file is associated with a repository.');
        }
        if (!selectedAnalysisId) {
          throw new Error('No analysis type selected.');
        }
        
        // Compose: analytics DSL (from/to) + query DSL (window/cohort/asat/context)
        // getQueryDslForScenario returns the COMPOSITED effective DSL (not raw)
        const scenarioQueryDsl = getQueryDslForScenario(scenarioId);
        const snapshotDsl = composeSnapshotDsl(analyticsDsl, scenarioQueryDsl);
        
        console.log('[AnalyticsPanel] Snapshot DSL composed:', snapshotDsl, 'from analyticsDsl:', analyticsDsl, 'queryDsl:', scenarioQueryDsl);
        
        const dslWindow = extractDateRangeFromDSL(snapshotDsl);
        if (!dslWindow) {
          throw new Error(`No date range for snapshot analysis. The query DSL must include a window() or cohort() clause.\n\nAnalytics DSL: ${analyticsDsl}\nQuery DSL: ${scenarioQueryDsl}\nComposed: ${snapshotDsl}`);
        }
        
        console.log('[AnalyticsPanel] Snapshot DSL window:', dslWindow);
        
        const { plan } = await buildFetchPlanProduction(scenarioGraph, snapshotDsl, dslWindow);
        console.log('[AnalyticsPanel] Fetch plan built:', plan.items.length, 'items, types:', plan.items.map(i => `${i.type}:${i.itemKey}:sig=${!!i.querySignature}`).join(', '));
        
        const edgeUuids = querySelectionUuids();
        const resolverResult = await mapFetchPlanToSnapshotSubjects({
          plan,
          analysisType: selectedAnalysisId,
          graph: scenarioGraph,
          selectedEdgeUuids: edgeUuids.selectedEdgeUuids,
          workspace,
          queryDsl: snapshotDsl,
        });
        
        if (!resolverResult) {
          throw new Error(`Snapshot subject resolution returned nothing. The analysis type "${selectedAnalysisId}" may not have a valid snapshotContract.`);
        }
        
        if (resolverResult.skipped.length > 0) {
          console.warn('[AnalyticsPanel] Snapshot subjects skipped:', resolverResult.skipped);
        }
        
        if (resolverResult.subjects.length === 0) {
          const skipReasons = resolverResult.skipped.map(s => `${s.subjectId}: ${s.reason}`).join('\n');
          throw new Error(`No snapshot subjects resolved for analysis.\n\nSkipped:\n${skipReasons || '(none)'}\n\nPlan items: ${plan.items.length}\nComposed DSL: ${snapshotDsl}`);
        }
        
        console.log('[AnalyticsPanel] Resolved snapshot subjects:', resolverResult.subjects.length);
        // DEV: log full subject payloads so we can trace core_hash / param_id / sweep range
        for (const subj of resolverResult.subjects) {
          console.log('[AnalyticsPanel] Snapshot subject:', {
            subject_id: subj.subject_id,
            param_id: subj.param_id,
            core_hash: subj.core_hash,
            read_mode: subj.read_mode,
            anchor_from: subj.anchor_from,
            anchor_to: subj.anchor_to,
            sweep_from: subj.sweep_from,
            sweep_to: subj.sweep_to,
            slice_keys: subj.slice_keys,
            sig_preview: subj.canonical_signature?.substring(0, 80) + '...',
          });
        }
        return resolverResult.subjects;
      };
      
      // Determine the effective analytics DSL for a scenario layer.
      // For non-snapshot analyses this is the composited DSL; for snapshot
      // analyses we override this with the panel's queryDSL (see below).
      const getEffectiveDslForScenario = (scenarioId: string): string => {
        // For live scenarios, delegate to the compositor-aware function
        // which returns the full composited DSL (not the raw scenario DSL).
        return getQueryDslForScenario(scenarioId);
      };
      
      // Check if we have multiple visible scenarios for multi-scenario analysis
      const hasMultipleScenarios = orderedVisibleScenarios.length > 1 && scenariosContext;
      
      if (hasMultipleScenarios) {
        // Build scenario-modified graphs for each visible scenario (in legend order)
        // with per-scenario snapshot subjects
        const scenarioGraphs = await Promise.all(orderedVisibleScenarios.map(async (scenarioId) => {
          // Get visibility mode (F/E/F+E) for this scenario from tab state
          const visibilityMode = tabId 
            ? operations.getScenarioVisibilityMode(tabId, scenarioId)
            : 'f+e';

          // Pass whatIfDSL only for 'current' layer - scenario layers have their
          // What-If already baked into their params at snapshot time
          const scenarioGraph = buildGraphForAnalysisLayer(
            scenarioId,
            graph,
            scenariosContext.baseParams,
            scenariosContext.currentParams,
            scenariosContext.scenarios,
            scenarioId === 'current' ? whatIfDSL : undefined,
            visibilityMode
          );
          
          const colour = getScenarioColour(scenarioId);
          
          // Resolve snapshot subjects if this analysis type requires them
          // For snapshot analyses, analyticsDsl MUST be the panel's queryDSL
          // (the user's edge selection — from/to), not the scenario's own DSL
          // which may only contain window/cohort dates. The scenario's date
          // range is picked up separately via getQueryDslForScenario inside
          // resolveSnapshotSubjectsForScenario.
          const analyticsDsl = needsSnapshots ? queryDSL : getEffectiveDslForScenario(scenarioId);
          let snapshotSubjects: import('../../services/snapshotDependencyPlanService').SnapshotSubjectRequest[] | undefined;
          if (needsSnapshots) {
            snapshotSubjects = await resolveSnapshotSubjectsForScenario(scenarioGraph, analyticsDsl, scenarioId);
          }
          
          return {
            scenario_id: scenarioId,
            name: getScenarioName(scenarioId),
            graph: scenarioGraph,
            colour,
            visibility_mode: visibilityMode,
            ...(snapshotSubjects?.length ? { snapshot_subjects: snapshotSubjects } : {}),
          };
        }));
        
        response = await graphComputeClient.analyzeMultipleScenarios(
          scenarioGraphs,
          queryDSL || undefined,
          selectedAnalysisId || undefined,
        );
      } else {
        // Single scenario analysis
        const scenarioId = orderedVisibleScenarios[0] || 'current';
        const scenarioName = getScenarioName(scenarioId);
        const scenarioColour = getScenarioColour(scenarioId);
        
        // Get visibility mode (F/E/F+E) for this scenario from tab state
        const visibilityMode = tabId 
          ? operations.getScenarioVisibilityMode(tabId, scenarioId)
          : 'f+e';
        
        console.log('[AnalyticsPanel] runAnalysis: visibilityMode =', visibilityMode, 'for scenario', scenarioId);
        
        // Build the graph with What-If applied (if current layer)
        let analysisGraph = graph;
        if (scenariosContext) {
          analysisGraph = buildGraphForAnalysisLayer(
            scenarioId,
            graph,
            scenariosContext.baseParams,
            scenariosContext.currentParams,
            scenariosContext.scenarios,
            scenarioId === 'current' ? whatIfDSL : undefined,
            visibilityMode
          );
        } else if (scenarioId === 'current' && whatIfDSL) {
          // No scenario context but we have whatIfDSL - apply it directly
          const { applyWhatIfToGraph } = await import('../../services/CompositionService');
          analysisGraph = applyWhatIfToGraph(graph, whatIfDSL);
        }
        
        // Resolve snapshot subjects if this analysis type requires them
        // See multi-scenario path comment: for snapshots, always use panel's
        // queryDSL to preserve the from/to edge selection.
        const analyticsDsl = needsSnapshots ? queryDSL : getEffectiveDslForScenario(scenarioId);
        let snapshotSubjects: import('../../services/snapshotDependencyPlanService').SnapshotSubjectRequest[] | undefined;
        if (needsSnapshots) {
          snapshotSubjects = await resolveSnapshotSubjectsForScenario(analysisGraph, analyticsDsl, scenarioId);
        }
        
        response = await graphComputeClient.analyzeSelection(
          analysisGraph,
          queryDSL || undefined,
          scenarioId,
          scenarioName,
          scenarioColour,
          selectedAnalysisId || undefined,
          visibilityMode,
          snapshotSubjects
        );
      }
      
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
  }, [graph, selectedNodeIds, queryDSL, selectedAnalysisId, visibleScenariosKey, visibleScenarioDataKey, whatIfDSL, visibilityModesKey]);
  
  // Cleanup spinner timeout on unmount
  useEffect(() => {
    return () => {
      if (spinnerTimeoutRef.current) {
        clearTimeout(spinnerTimeoutRef.current);
      }
    };
  }, []);
  
  // Format full result as JSON for debug display
  const formattedResult = useMemo(() => {
    if (!results?.result) return null;
    return JSON.stringify(results.result, null, 2);
  }, [results]);

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
  const analysisTitleSuffix = useMemo((): string => {
    const meta: any = results?.result?.metadata;
    const nodeLabel = meta?.node_label;
    if (typeof nodeLabel === 'string' && nodeLabel.trim()) {
      return ` — ${nodeLabel}`;
    }
    return '';
  }, [results]);

  const scenarioDslSubtitleByIdObject = useMemo(() => {
    const obj: Record<string, string> = {};
    for (const [k, v] of scenarioDslSubtitleById.entries()) obj[k] = v;
    return obj;
  }, [scenarioDslSubtitleById]);
  
  // Refresh: clear cache and re-run analysis
  const handleRefresh = useCallback(() => {
    graphComputeClient.clearCache();
    runAnalysis();
  }, [runAnalysis]);
  
  return (
    <div className="analytics-panel">
      {/* Header */}
      {!hideHeader && (
        <div className="analytics-header">
          <BarChart3 size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
          <h3 className="analytics-title">Analytics</h3>
          <button
            className="analytics-refresh-btn"
            onClick={handleRefresh}
            disabled={isLoading}
            title="Clear cache and re-run analysis"
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 4, display: 'flex', alignItems: 'center', opacity: isLoading ? 0.4 : 0.6 }}
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
          
          {/* Analysis Type Selector - Mini Cards */}
          <CollapsibleSection
            title={
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                <span>Analysis Type</span>
                <button
                  className="analytics-show-all-toggle"
                  onClick={(e) => { e.stopPropagation(); setShowAllAnalyses(!showAllAnalyses); }}
                  title={showAllAnalyses ? 'Show only available' : 'Show all analysis types'}
                >
                  {showAllAnalyses ? <EyeOff size={12} /> : <Eye size={12} />}
                  <span>{showAllAnalyses ? 'Available only' : 'Show all'}</span>
                </button>
              </span>
            }
            defaultOpen={true}
            icon={BarChart3}
          >
            <div className="analytics-type-cards">
              {ANALYSIS_TYPES
                .filter(typeMeta => {
                  // Always show available analyses
                  const isAvailable = availableAnalyses.some(a => a.id === typeMeta.id);
                  return showAllAnalyses || isAvailable;
                })
                .map(typeMeta => {
                  const isAvailable = availableAnalyses.some(a => a.id === typeMeta.id);
                  const isSelected = selectedAnalysisId === typeMeta.id;
                  const availableInfo = availableAnalyses.find(a => a.id === typeMeta.id);
                  const Icon = typeMeta.icon;
                  
                  return (
                    <button
                      key={typeMeta.id}
                      className={`analytics-type-card ${isSelected ? 'selected' : ''} ${!isAvailable ? 'unavailable' : ''}`}
                      onClick={() => setSelectedAnalysisId(typeMeta.id)}
                      title={typeMeta.selectionHint}
                    >
                      <div className="analytics-type-card-icon">
                        <Icon size={14} strokeWidth={2} />
                      </div>
                      <div className="analytics-type-card-content">
                        <div className="analytics-type-card-name">
                          {typeMeta.name}
                          {availableInfo?.is_primary && <ChevronRight size={10} className="analytics-primary-indicator" />}
                        </div>
                        <div className="analytics-type-card-desc">
                          {typeMeta.shortDescription}
                        </div>
                      </div>
                    </button>
                  );
                })}
            </div>
          </CollapsibleSection>
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
          
          {/* Requirements message for unavailable analysis */}
          {selectedAnalysisId && !availableAnalyses.some(a => a.id === selectedAnalysisId) && (
            <div className="analytics-requirements">
              <div className="analytics-requirements-title">
                <Lightbulb size={16} />
                <span>{getAnalysisTypeMeta(selectedAnalysisId)?.name || 'Analysis'}</span>
              </div>
              <div className="analytics-requirements-hint">
                {getAnalysisTypeMeta(selectedAnalysisId)?.selectionHint || 'Select appropriate nodes to enable this analysis.'}
              </div>
            </div>
          )}
          
          {/* Results */}
          {results && results.success && results.result?.data && (
            <div className="analytics-section analytics-results">
              <div className="analytics-section-header">
                <span className="analytics-section-label">Results</span>
                {results.result?.analysis_name && (
                  <span className="analytics-section-subtitle">{results.result.analysis_name}{analysisTitleSuffix}</span>
                )}
              </div>
              <div style={{ padding: '8px 8px 0 8px' }}>
                <AnalysisChartContainer
                  result={results.result}
                  visibleScenarioIds={orderedVisibleScenarios}
                  // Panel view is height constrained; keep charts compact to avoid dead space.
                  height={results.result?.semantics?.chart?.recommended === 'bridge' ? 280 : 420}
                  compactControls={true}
                  scenarioDslSubtitleById={scenarioDslSubtitleByIdObject}
                  source={{
                    parent_tab_id: tabId,
                    parent_file_id: currentTab?.fileId,
                    query_dsl: results.query_dsl,
                    analysis_type: results.result.analysis_type,
                  }}
                />
              </div>
              <AnalysisResultCards result={results.result} scenarioDslSubtitleById={scenarioDslSubtitleByIdObject} />
            </div>
          )}
          
          {/* Fallback: show raw data if we have results but couldn't render cards */}
          {results && results.success && results.result?.data && !results.result?.semantics?.dimensions && (
            <div className="analytics-section analytics-results">
              <div className="analytics-section-label">Results (Raw)</div>
              <div className="analytics-cards-container">
                <div className="analytics-card">
                  <div className="analytics-card-header">
                    <span className="analytics-card-title">
                      {(results.result.analysis_name || 'Analysis Results')}{analysisTitleSuffix}
                    </span>
                  </div>
                  <div className="analytics-card-content">
                    <pre style={{ fontSize: '10px', margin: 0, whiteSpace: 'pre-wrap' }}>
                      {JSON.stringify(results.result.data, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        
        {/* Results JSON - grid positions this */}
        {results && results.success && formattedResult && (
          <div className="analytics-debug-section">
            <CollapsibleSection 
              title="Results JSON"
              defaultOpen={false}
              icon={Code}
            >
              <pre className="analytics-json analytics-debug-json">
                {formattedResult}
              </pre>
            </CollapsibleSection>
          </div>
        )}
      </div>
    </div>
  );
}

