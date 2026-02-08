/**
 * ScenariosContext
 * 
 * Manages scenarios (parameter overlays) for the current graph session.
 * Scenarios are shared across all tabs viewing the same graph.
 * 
 * Responsibilities:
 * - CRUD operations for scenarios
 * - Snapshot creation (all/differences)
 * - Content editing and validation
 * - Flatten operation (merge all overlays into Base)
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { 
  Scenario, 
  ScenarioParams, 
  CreateSnapshotOptions,
  ApplyContentOptions,
  ScenarioValidationResult,
  ScenarioMeta
} from '../types/scenarios';
import { Graph } from '../types';
import { applyComposedParamsToGraph, composeParams } from '../services/CompositionService';
import { computeDiff } from '../services/DiffService';
import { fromYAML, fromJSON } from '../services/ParamPackDSLService';
import { validateScenarioParams } from '../services/ScenarioValidator';
import { extractParamsFromGraph, extractDiffParams } from '../services/GraphParamExtractor';
import { parseWhatIfDSL } from '../lib/whatIf';
import { useGraphStore } from './GraphStoreContext';
import { db } from '../db/appDatabase';
import {
  splitDSLParts,
  buildFetchDSL,
  buildWhatIfDSL,
  computeEffectiveParams,
  computeInheritedDSL,
  computeEffectiveFetchDSL,
  deriveScenarioCreateDeltaDSL,
  isLiveScenario,
  deriveBaseDSLForRebase,
  LIVE_EMPTY_DIFF_DSL,
  generateSmartLabel
} from '../services/scenarioRegenerationService';
import { 
  fetchDataService,
  type FetchItem 
} from '../services/fetchDataService';
import { fetchOrchestratorService } from '../services/fetchOrchestratorService';
import { sessionLogService } from '../services/sessionLogService';
import { recomputeOpenChartsForGraph } from '../services/chartRecomputeService';
import { autoUpdatePolicyService } from '../services/autoUpdatePolicyService';
import { graphTopologySignature } from '../services/graphTopologySignatureService';
import { ukDayBoundarySchedulerService } from '../services/ukDayBoundarySchedulerService';
import { computeScenarioDepsStampV1 } from '../services/scenarioProvenanceService';

// Scenario colour palette (user scenarios cycle through these)
// Using more saturated, vibrant colours for better visibility
// Exported for use in bulk creation hooks
export const SCENARIO_PALETTE = [
  '#EC4899', // Hot Pink
  '#F59E0B', // Amber
  '#10B981', // Emerald
  '#8B5CF6', // Violet
  '#EF4444', // Red
  '#06B6D4', // Cyan
  '#F97316', // Orange
  '#A855F7', // Purple
  '#14B8A6', // Teal
  '#F43F5E', // Rose
  '#84CC16', // Lime
  '#6366F1', // Indigo
  '#D946EF', // Fuchsia
  '#0EA5E9', // Sky Blue
  '#FB923C', // Orange (lighter)
  '#22C55E', // Green
];

// Maximum number of user scenarios allowed (plus Current and Base = 17 total layers max)
const MAX_SCENARIOS = 15;

export interface ScenariosContextValue {
  // State
  scenarios: Scenario[];
  baseParams: ScenarioParams;
  currentParams: ScenarioParams;
  editorOpenScenarioId: string | null;
  
  // Ready flag - true when scenarios have been loaded from IndexedDB
  // Consumers should wait for this before creating scenarios to avoid race conditions
  scenariosReady: boolean;
  
  // Graph reference (for checking if graph is loaded)
  graph: Graph | null;
  
  // Colours (graph-level, user-mutable)
  currentColour: string;
  baseColour: string;
  
  // Live scenarios state
  baseDSL: string;
  
  // CRUD operations
  createSnapshot: (
    options: CreateSnapshotOptions, 
    tabId: string,
    whatIfDSL?: string | null,
    whatIfSummary?: string,
    window?: { start: string; end: string } | null,
    context?: Record<string, string>
  ) => Promise<Scenario>;
  createBlank: (name: string, tabId: string) => Promise<Scenario>;
  getScenario: (id: string) => Scenario | undefined;
  listScenarios: () => Scenario[];
  renameScenario: (id: string, name: string) => Promise<void>;
  updateScenarioColour: (id: string, colour: string) => Promise<void>;
  deleteScenario: (id: string) => Promise<void>;
  
  // Live scenario operations
  createLiveScenario: (
    queryDSL: string,
    name?: string,
    tabId?: string,
    colour?: string,
    idOverride?: string
  ) => Promise<Scenario>;
  /**
   * Create a live scenario from the CURRENT DSL as a MECE delta vs the currently VISIBLE stack.
   *
   * This is the semantic used by the "+" / New Scenario action.
   */
  createLiveScenarioFromCurrentDelta: (tabId: string, visibleOrder: string[]) => Promise<Scenario>;
  regenerateScenario: (
    id: string,
    scenarioOverride?: Scenario,
    baseDSLOverride?: string,
    allScenariosOverride?: Scenario[],
    visibleOrder?: string[],
    options?: { skipStage2?: boolean; allowFetchFromSource?: boolean }
  ) => Promise<void>;
  regenerateAllLive: (baseDSLOverride?: string, visibleOrder?: string[]) => Promise<void>;
  updateScenarioQueryDSL: (id: string, queryDSL: string) => Promise<void>;
  
  // Base DSL operations
  setBaseDSL: (dsl: string) => void;
  putToBase: (visibleOrder?: string[]) => Promise<void>;
  
  // Content operations
  applyContent: (id: string, content: string, options: ApplyContentOptions) => Promise<void>;
  validateContent: (content: string, options: ApplyContentOptions, graph?: Graph) => Promise<ScenarioValidationResult>;
  
  // Editor operations
  openInEditor: (id: string) => void;
  closeEditor: () => void;
  
  // Composition
  composeVisibleParams: (visibleScenarioIds: string[]) => ScenarioParams;
  
  // Flatten operation
  flatten: () => Promise<void>;
  
  // Base/Current operations
  setBaseParams: (params: ScenarioParams) => void;
  setCurrentParams: (params: ScenarioParams) => void;
  setCurrentColour: (colour: string) => void;
  setBaseColour: (colour: string) => void;
}

const ScenariosContext = createContext<ScenariosContextValue | null>(null);

interface ScenariosProviderProps {
  children: React.ReactNode;
  fileId?: string;
  tabId?: string;
}

/**
 * Scenarios Provider
 * 
 * Must be used within a GraphStoreProvider (inside GraphEditor)
 */
export function ScenariosProvider({ children, fileId, tabId }: ScenariosProviderProps) {
  // Get graph from GraphStore (available inside GraphEditor)
  const graphStore = useGraphStore();
  // IMPORTANT: subscribe to graph so ScenariosProvider reacts to GraphStore updates even when
  // GraphEditor isn't mounted (e.g. chart-only live share bootstrap).
  const graph = useGraphStore(state => state.graph) || null;
  
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [baseParams, setBaseParams] = useState<ScenarioParams>({ edges: {}, nodes: {} });
  const [currentParams, setCurrentParams] = useState<ScenarioParams>({ edges: {}, nodes: {} });
  const [currentColour, setCurrentColour] = useState<string>('#3B82F6'); // Blue (vibrant)
  const [baseColour, setBaseColour] = useState<string>('#A3A3A3'); // Neutral grey
  const [editorOpenScenarioId, setEditorOpenScenarioId] = useState<string | null>(null);
  const [baseDSL, setBaseDSLState] = useState<string>('');
  const lastFileIdRef = useRef<string | null>(null);
  const [scenariosLoaded, setScenariosLoaded] = useState(false);

  // Auto-update charts policy (defaults ON; forced ON in live share / dashboard).
  const [autoUpdateChartsEnabled, setAutoUpdateChartsEnabled] = useState<boolean>(true);
  const autoUpdateChartsEnabledRef = useRef<boolean>(true);

  useEffect(() => {
    autoUpdatePolicyService
      .getAutoUpdateChartsPolicy()
      .then(p => {
        setAutoUpdateChartsEnabled(p.enabled);
        autoUpdateChartsEnabledRef.current = p.enabled;
      })
      .catch(() => {
        // Best-effort only; default is ON.
        setAutoUpdateChartsEnabled(true);
        autoUpdateChartsEnabledRef.current = true;
      });
  }, []);

  useEffect(() => {
    autoUpdateChartsEnabledRef.current = autoUpdateChartsEnabled;
  }, [autoUpdateChartsEnabled]);

  const reconcileTimerRef = useRef<number | null>(null);
  const reconcileInFlightRef = useRef<Promise<any> | null>(null);
  const topologySigRef = useRef<string | null>(null);
  const topologyRegenTimerRef = useRef<number | null>(null);

  // Ensure we don't leak timers across unmounts (important for tests and share embeds).
  useEffect(() => {
    return () => {
      try {
        if (reconcileTimerRef.current) window.clearTimeout(reconcileTimerRef.current);
        if (topologyRegenTimerRef.current) window.clearTimeout(topologyRegenTimerRef.current);
      } catch {
        // best-effort only
      } finally {
        reconcileTimerRef.current = null;
        topologyRegenTimerRef.current = null;
        reconcileInFlightRef.current = null;
      }
    };
  }, []);

  const scheduleChartReconcile = useCallback(
    (reason: string, opts?: { bypassPolicy?: boolean }) => {
      if (!fileId) return;
      if (!graph) return;

      // Debounce/coalesce bursts (scenario regen loops, topology edits).
      if (reconcileTimerRef.current) window.clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = window.setTimeout(async () => {
        // Re-check policy at execution time to avoid races (e.g. workspace toggle just changed).
        // IMPORTANT: Manual refresh must bypass policy gating (Refresh should always work).
        if (!opts?.bypassPolicy) {
          try {
            const p = await autoUpdatePolicyService.getAutoUpdateChartsPolicy();
            if (!p.enabled) return;
          } catch {
            // Default is ON; continue.
          }
        }
        if (reconcileInFlightRef.current) return;

        const logOpId = sessionLogService.startOperation(
          'info',
          'graph',
          'CHART_RECONCILE',
          `Reconciling chart(s) for ${fileId}`,
          { reason, graphFileId: fileId }
        );

        const p = recomputeOpenChartsForGraph({
          graphFileId: fileId,
          graph,
          baseParams,
          currentParams,
          scenarios: scenarios as any,
          currentColour,
          baseColour,
          authoritativeCurrentDsl: graphStore?.getState().currentDSL || undefined,
        });
        reconcileInFlightRef.current = p;
        try {
          const res = await p;
          for (const d of res.updatedDetails || []) {
            const prev = (d.prevDepsSignature || '').slice(0, 12);
            const next = (d.nextDepsSignature || '').slice(0, 12);
            sessionLogService.addChild(logOpId, 'info', 'CHART_STALE', `Chart ${d.chartFileId} stale (${prev}→${next})`, undefined, { chartFileId: d.chartFileId });
          }
          sessionLogService.endOperation(logOpId, 'success', `Reconciled charts (updated=${res.updatedChartFileIds.length}, skipped=${res.skippedChartFileIds.length})`);
        } catch (e: any) {
          sessionLogService.endOperation(logOpId, 'error', e?.message || String(e));
        } finally {
          reconcileInFlightRef.current = null;
        }
      }, 250);
    },
    [fileId, graph, baseParams, currentParams, scenarios, currentColour, baseColour, graphStore]
  );

  // Manual chart refresh requests (from chart tabs/menus): reconcile the current graph if it matches.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail: any = (e as any).detail || {};
      if (!detail?.graphFileId) return;
      if (detail.graphFileId !== fileId) return;
      scheduleChartReconcile(`chart-manual-refresh:${String(detail.chartFileId || '')}`, { bypassPolicy: true });
    };
    window.addEventListener('dagnet:chartRefreshRequested', handler as EventListener);
    return () => window.removeEventListener('dagnet:chartRefreshRequested', handler as EventListener);
  }, [fileId, scheduleChartReconcile]);

  // UK day boundary invalidation (dynamic DSLs): schedule a reconcile pass on day change.
  // This remains best-effort; charts without dynamic DSL will remain "not stale" and be skipped cheaply.
  useEffect(() => {
    const unsubscribe = ukDayBoundarySchedulerService.subscribe(() => {
      scheduleChartReconcile('uk-day-boundary');
    });
    return () => {
      unsubscribe();
    };
  }, [scheduleChartReconcile]);

  // Load scenarios from IndexedDB on mount or file change
  useEffect(() => {
    if (!fileId) return;

    // IMPORTANT:
    // scenariosLoaded / scenariosReady must be treated as *per-file*, otherwise callers may create scenarios
    // while an async DB load for the new fileId is still in-flight, and then that late load overwrites
    // the newly created in-memory scenarios (observed in live share boot).
    setScenariosLoaded(false);

    const loadScenarios = async () => {
      try {
        const savedScenarios = await db.scenarios
          .where('fileId')
          .equals(fileId)
          .toArray();
        
        console.log(`ScenariosContext: Loaded ${savedScenarios.length} scenarios for file ${fileId}`);
        
        // Remove fileId from scenario objects (it's just for DB indexing)
        // Also migrate old 'color' property to 'colour' if present
        const scenarios = savedScenarios.map(({ fileId: _fileId, ...scenario }) => {
          const scenarioAny = scenario as any;
          // Migrate old 'color' property to 'colour' if needed
          if (scenarioAny.color && !scenarioAny.colour) {
            scenarioAny.colour = scenarioAny.color;
            delete scenarioAny.color;
          }
          return scenario as Scenario;
        });
        setScenarios(scenarios);
        setScenariosLoaded(true);
      } catch (error) {
        console.error('Failed to load scenarios from DB:', error);
        setScenarios([]);
        setScenariosLoaded(true);
      }
    };
    
    loadScenarios();
  }, [fileId]);

  // Save scenarios to IndexedDB whenever they change
  useEffect(() => {
    if (!scenariosLoaded || !fileId) return;
    
    const saveScenarios = async () => {
      try {
        // Get current scenario IDs in memory
        const currentIds = new Set(scenarios.map(s => s.id));
        
        // Get all scenarios for this file from DB
        const dbScenarios = await db.scenarios.where('fileId').equals(fileId).toArray();
        const dbIds = new Set(dbScenarios.map(s => s.id));
        
        // Delete scenarios that are in DB but not in memory
        const toDelete = dbScenarios.filter(s => !currentIds.has(s.id)).map(s => s.id);
        if (toDelete.length > 0) {
          await db.scenarios.bulkDelete(toDelete);
        }
        
        // Upsert all current scenarios (bulkPut = insert or update)
        if (scenarios.length > 0) {
          const scenariosWithFileId = scenarios.map(scenario => ({
            ...scenario,
            fileId
          }));
          await db.scenarios.bulkPut(scenariosWithFileId);
        }
        
        console.log(`ScenariosContext: Saved ${scenarios.length} scenarios for file ${fileId}`);
      } catch (error) {
        console.error('Failed to save scenarios to DB:', error);
      }
    };
    
    saveScenarios();
  }, [scenarios, fileId, scenariosLoaded]);

  // Extract parameters from graph
  // - On FILE CHANGE: Set both baseParams and currentParams (new baseline), load baseDSL
  // - On GRAPH UPDATES: Only update currentParams (base is explicitly managed)
  useEffect(() => {
    if (graph) {
      const params = extractParamsFromGraph(graph);
      
      // Check if file changed (new file opened)
      const fileChanged = lastFileIdRef.current !== fileId;
      
      if (fileChanged) {
        // File changed: set both base and current (new baseline)
        setBaseParams(params);
        setCurrentParams(params);
        // Load baseDSL from graph (persisted in YAML)
        setBaseDSLState(graph.baseDSL || '');
        lastFileIdRef.current = fileId || null;
      } else {
        // Same file, graph updated: only update current, preserve base
        setCurrentParams(params);
      }
    }
  }, [graph, fileId]);

  /**
   * Generate a unique ID for a new scenario
   */
  const generateId = useCallback((): string => {
    return `scenario-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }, []);

  /**
   * Create a snapshot scenario
   * 
   * Captures current parameter state along with metadata about:
   * - What-If settings (if active)
   * - Time window
   * - Context values
   * - Source (what was diffed against)
   */
  const createSnapshot = useCallback(async (
    options: CreateSnapshotOptions,
    tabId: string,
    whatIfDSL?: string | null,
    whatIfSummary?: string,
    window?: { start: string; end: string } | null,
    context?: Record<string, string>
  ): Promise<Scenario> => {
    // Check scenario limit
    if (scenarios.length >= MAX_SCENARIOS) {
      throw new Error(`Maximum of ${MAX_SCENARIOS} scenarios reached`);
    }
    
    const { name, type, source = 'visible', diffThreshold = 1e-6, note } = options;
    
    // Determine what to diff against
    let baseForDiff: ScenarioParams;
    if (source === 'base') {
      // Diff against Base only
      baseForDiff = baseParams;
    } else {
      // Diff against composed visible layers (excluding Current)
      // For now, compose all scenarios
      // TODO: In future, filter to only visible scenarios for this tab
      const overlays = scenarios.map(s => s.params);
      baseForDiff = composeParams(baseParams, overlays);
    }
    
    // If a What-If DSL is active, we need to compute the EFFECTIVE visual state
    // by running all edges through the What-If engine (case overrides, conditionals, etc.)
    // This ensures snapshots capture the complete displayed state, not just raw graph values.
    let effectiveCurrentParams: ScenarioParams = currentParams;
    if (whatIfDSL && whatIfDSL.trim() && graph) {
      const { computeEffectiveEdgeProbability } = await import('../lib/whatIf');
      
      // Recompute all edge probabilities with the What-If overlay
      const newEdges: ScenarioParams['edges'] = {};
      const newNodes: ScenarioParams['nodes'] = { ...(currentParams.nodes || {}) };
      
      // For each edge in the graph, compute its effective probability under the What-If
      graph.edges?.forEach((edge: any) => {
        const edgeKey = edge.id || edge.uuid;
        if (!edgeKey) return;
        
        // For case variant edges, store just p (not p*v)
        // The variant weight is stored separately in the node params
        let probToStore: number;
        
        if (edge.case_variant) {
          // For variant edges, store the base probability (p), not p*v
          // The variant weight change is captured in the node params below
          probToStore = edge.p?.mean ?? 0;
        } else {
          // For normal edges, use the effective probability (may be affected by what-if)
          probToStore = computeEffectiveEdgeProbability(
            graph,
            edgeKey,
            { whatIfDSL },
            undefined
          );
        }
        
        // Store the probability
        // Preserve other edge params from currentParams if they exist
        const existingEdgeParams = (currentParams.edges || {})[edgeKey] || {};
        newEdges[edgeKey] = {
          ...existingEdgeParams,
          p: {
            ...(existingEdgeParams.p || {}),
            mean: probToStore
          }
        };
      });
      
      // For case nodes, also bake in the variant weights from the What-If overlay
      const parsed = await import('../lib/whatIf').then(m => m.parseWhatIfDSL(whatIfDSL, graph));
      const caseOverrides = parsed.caseOverrides || {};
      
      Object.entries(caseOverrides).forEach(([caseNodeRef, selectedVariant]) => {
        const caseNode = graph.nodes?.find((n: any) =>
          n.type === 'case' && (
            n.id === caseNodeRef ||
            n.uuid === caseNodeRef ||
            n.case?.id === caseNodeRef
          )
        );
        if (!caseNode?.case?.variants) return;
        
        const caseNodeId = caseNode.id || caseNode.uuid;
        if (!caseNodeId) return;
        
        const existingNodeParams = newNodes[caseNodeId] || {};
        const sourceVariants =
          (existingNodeParams as any).case?.variants || caseNode.case.variants;
        
        const newVariants = sourceVariants.map((v: any) => ({
          ...v,
          weight: v.name === selectedVariant ? 1.0 : 0.0
        }));
        
        newNodes[caseNodeId] = {
          ...(existingNodeParams as any),
          case: {
            ...(existingNodeParams as any).case,
            variants: newVariants
          }
        };
      });
      
      effectiveCurrentParams = {
        edges: newEdges,
        nodes: newNodes
      };
    }
    
    // Compute diff
    const diff = computeDiff(effectiveCurrentParams, baseForDiff, type, diffThreshold);
    
    // Generate auto note if not provided
    let autoNote = note;
    if (!autoNote) {
      const parts: string[] = [];
      parts.push(`${type === 'all' ? 'Full' : 'Diff'} snapshot`);
      
      if (window) {
        const start = new Date(window.start).toLocaleDateString();
        const end = new Date(window.end).toLocaleDateString();
        parts.push(`for ${start} → ${end}`);
      }
      
      if (whatIfSummary) {
        parts.push(`with What-If: ${whatIfSummary}`);
      }
      
      if (context && Object.keys(context).length > 0) {
        const contextStr = Object.entries(context)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        parts.push(`(${contextStr})`);
      }
      
      autoNote = parts.join(' ');
    }
    
    const now = new Date().toISOString();
    // Assign colour from palette, preferring a colour not currently in use
    const usedColours = new Set(scenarios.map(s => s.colour));
    const firstUnusedIndex = SCENARIO_PALETTE.findIndex(c => !usedColours.has(c));
    const colour = firstUnusedIndex >= 0
      ? SCENARIO_PALETTE[firstUnusedIndex]
      : SCENARIO_PALETTE[scenarios.length % SCENARIO_PALETTE.length];
    
    const scenario: Scenario = {
      id: generateId(),
      name,
      colour,
      createdAt: now,
      version: 1,
      params: diff,
      meta: {
        source: type,
        sourceDetail: source,
        createdInTabId: tabId,
        note: autoNote,
        whatIfDSL: whatIfDSL || undefined,
        whatIfSummary: whatIfSummary || undefined,
        window: window || undefined,
        context: context || undefined,
      }
    };
    
    // Insert new scenario at position 2 (just beneath Current)
    // This means PREPENDING to the array: newer scenarios closer to Base in composition
    // Array order: [newest, ..., oldest]
    // Composition: Base + scenarios[0] + scenarios[1] + ... + Current
    setScenarios(prev => [scenario, ...prev]);
    
    return scenario;
  }, [generateId, baseParams, currentParams, scenarios, graph]);

  /**
   * Create a blank scenario
   */
  const createBlank = useCallback(async (
    name: string,
    tabId: string
  ): Promise<Scenario> => {
    // Check scenario limit
    if (scenarios.length >= MAX_SCENARIOS) {
      throw new Error(`Maximum of ${MAX_SCENARIOS} scenarios reached`);
    }
    
    const now = new Date().toISOString();
    // Assign colour from palette, preferring a colour not currently in use
    const usedColours = new Set(scenarios.map(s => s.colour));
    const firstUnusedIndex = SCENARIO_PALETTE.findIndex(c => !usedColours.has(c));
    const colour = firstUnusedIndex >= 0
      ? SCENARIO_PALETTE[firstUnusedIndex]
      : SCENARIO_PALETTE[scenarios.length % SCENARIO_PALETTE.length];
    
    const scenario: Scenario = {
      id: generateId(),
      name,
      colour,
      createdAt: now,
      version: 1,
      params: { edges: {}, nodes: {} },
      meta: {
        createdInTabId: tabId,
        note: `Blank scenario created on ${new Date(now).toLocaleString()}`,
      }
    };
    
    // Insert new scenario at position 2 (just beneath Current), same as snapshots
    setScenarios(prev => [scenario, ...prev]);
    
    // Auto-open in editor
    setEditorOpenScenarioId(scenario.id);
    
    return scenario;
  }, [generateId]);

  /**
   * Create a live scenario from a query DSL.
   * 
   * Live scenarios can be regenerated from source data at any time.
   * The queryDSL specifies what data slice this scenario represents.
   * 
   * @param queryDSL - Query DSL fragment (e.g., "context(channel:google)")
   * @param name - Optional display name (defaults to queryDSL)
   * @param tabId - Tab ID where this scenario was created
   * @param colour - Optional colour override (for bulk creation to avoid stale closure)
   */
  const createLiveScenario = useCallback(async (
    queryDSL: string,
    name?: string,
    tabId?: string,
    colour?: string,
    idOverride?: string
  ): Promise<Scenario> => {
    // Check scenario limit
    if (scenarios.length >= MAX_SCENARIOS) {
      throw new Error(`Maximum of ${MAX_SCENARIOS} scenarios reached`);
    }
    
    // CRITICAL: If baseDSL is not set, capture the graph's current DSL as the base
    // This ensures live scenarios inherit window/context from the current graph state
    if (!baseDSL && graphStore) {
      const currentGraphDSL = graphStore.getState().currentDSL || '';
      if (currentGraphDSL) {
        const derivedBase = deriveBaseDSLForRebase(currentGraphDSL);
        console.log(`createLiveScenario: Setting baseDSL to "${derivedBase}" (was empty)`);
        setBaseDSL(derivedBase);
      }
    }
    
    const now = new Date().toISOString();
    // Use provided colour or assign from palette
    let assignedColour = colour;
    if (!assignedColour) {
      const usedColours = new Set(scenarios.map(s => s.colour));
      const firstUnusedIndex = SCENARIO_PALETTE.findIndex(c => !usedColours.has(c));
      assignedColour = firstUnusedIndex >= 0
        ? SCENARIO_PALETTE[firstUnusedIndex]
        : SCENARIO_PALETTE[scenarios.length % SCENARIO_PALETTE.length];
    }
    
    const forcedId = typeof idOverride === 'string' && idOverride.trim() ? idOverride.trim() : undefined;
    if (forcedId && scenarios.some(s => s.id === forcedId)) {
      throw new Error(`Scenario id already exists: ${forcedId}`);
    }

    const scenario: Scenario = {
      id: forcedId || generateId(),
      name: name || generateSmartLabel(queryDSL) || 'Live scenario', // Default name is smart label from DSL
      colour: assignedColour,
      createdAt: now,
      version: 1,
      // Live scenarios start as a copy of Current (as diffs from Base), so they remain stable
      // even if Current's DSL changes later.
      //
      // IMPORTANT: These are diffs against Base params, not against Current.
      // This keeps scenario layering deterministic: Base + scenario.params = initial Current.
      params: computeDiff(currentParams, baseParams, 'differences', 1e-6),
      meta: {
        queryDSL: (queryDSL && queryDSL.trim().length > 0) ? queryDSL : LIVE_EMPTY_DIFF_DSL,
        isLive: true,
        createdInTabId: tabId,
        note: `Live scenario created on ${new Date(now).toLocaleString()}`,
      }
    };
    
    // Insert new scenario at position 0 (just beneath Current in composition)
    setScenarios(prev => [scenario, ...prev]);
    
    // NOTE: We don't auto-regenerate on creation because:
    // 1. React state updates are async, so regenerateScenario's closure has stale scenarios
    // 2. Bulk creation would spam the API if we auto-regenerated each scenario
    
    return scenario;
  }, [generateId, scenarios, baseParams, currentParams]);

  /**
   * Create a live scenario from Current as a MECE delta vs the VISIBLE stack (excluding Current).
   *
   * This matches the intended "+" semantics:
   * - Scenario queryDSL is the minimal delta such that (Base + visible scenarios + new scenario) yields Current DSL.
   * - Axis classes are MECE: window/cohort, context/contextAny, asat.
   */
  const createLiveScenarioFromCurrentDelta = useCallback(async (tabId: string, visibleOrder: string[]): Promise<Scenario> => {
    const currentDSL = graphStore?.getState().currentDSL || '';
    if (!currentDSL || !currentDSL.trim()) {
      throw new Error('No query DSL set. Select a window or context first.');
    }

    const effectiveBaseDSL = baseDSL || graph?.baseDSL || '';

    // Compute S: effective fetch DSL of the currently-visible stack (excluding Current).
    // visibleOrder is in visual order (top → bottom). Apply bottom → top for stacking.
    let stackEffective = effectiveBaseDSL;
    const ids = Array.isArray(visibleOrder) ? visibleOrder : [];
    const scenarioIds = ids.filter((id) => id && id !== 'base' && id !== 'current');
    for (const id of [...scenarioIds].reverse()) {
      const s = scenarios.find(x => x.id === id);
      if (!s?.meta?.isLive) continue;
      stackEffective = computeEffectiveFetchDSL(stackEffective, s.meta.queryDSL);
    }

    // Δ(S → C)
    const deltaDSL = deriveScenarioCreateDeltaDSL(stackEffective, currentDSL);
    const scenarioQueryDSL = (deltaDSL && deltaDSL.trim()) ? deltaDSL : LIVE_EMPTY_DIFF_DSL;

    return await createLiveScenario(scenarioQueryDSL, undefined, tabId);
  }, [graphStore, baseDSL, graph, scenarios, createLiveScenario]);

  /**
   * Regenerate a live scenario from its queryDSL.
   * 
   * This fetches fresh data and recomputes effective params with any what-if baked in.
   * 
   * @param id - Scenario ID to regenerate
   * @param scenarioOverride - Optional: pass scenario directly to avoid stale state lookup
   * @param baseDSLOverride - Optional: pass baseDSL directly to avoid stale state
   * @param allScenariosOverride - Optional: pass full scenarios list to ensure correct inheritance during bulk creation
   * @param visibleOrder - Optional: pass VISIBLE scenario IDs in visual order for correct inheritance
   */
  const regenerateScenario = useCallback(async (
    id: string,
    scenarioOverride?: Scenario,
    baseDSLOverride?: string,
    allScenariosOverride?: Scenario[],
    visibleOrder?: string[],
    options?: { skipStage2?: boolean; allowFetchFromSource?: boolean }
  ): Promise<void> => {
    // Use provided scenario or look up from state
    const scenario = scenarioOverride || scenarios.find(s => s.id === id);
    if (!scenario?.meta?.isLive) {
      console.warn(`Scenario ${id} is not a live scenario (meta.isLive=false)`);
      return;
    }
    
    if (!graph) {
      console.warn('Cannot regenerate scenario: no graph loaded');
      return;
    }
    
    // Use provided baseDSL or fall back to state/graph
    // Use || not ?? because empty string should fall through
    // Base DSL must be stable. Falling back to currentDSL causes scenarios to "move"
    // when Current changes, which breaks isolation.
    const effectiveBaseDSL = baseDSLOverride || baseDSL || graph?.baseDSL || '';
    
    // Use provided scenarios list or state
    const effectiveScenarios = allScenariosOverride || scenarios;
    
    // Build scenarios in VISIBLE order for inheritance calculation
    // ONLY VISIBLE scenarios contribute to DSL inheritance
    // Scenarios inherit from those BELOW them in the visible stack
    let orderedVisibleScenarios: typeof effectiveScenarios;
    if (visibleOrder && visibleOrder.length > 0) {
      // Filter to only visible scenarios, in visual order
      orderedVisibleScenarios = visibleOrder
        .filter(orderId => orderId !== 'base' && orderId !== 'current') // Exclude special IDs
        .map(orderId => effectiveScenarios.find(s => s.id === orderId))
        .filter((s): s is NonNullable<typeof s> => s !== undefined);
    } else {
      // Fallback: use all scenarios (legacy behaviour)
      orderedVisibleScenarios = effectiveScenarios;
    }
    
    // Find scenario index in VISIBLE order - for inheritance calculation
    // Scenarios inherit from those BELOW them (higher indices in visible stack)
    let scenarioIndex = orderedVisibleScenarios.findIndex(s => s.id === id);
    if (scenarioIndex < 0) {
      // Scenario not in visible list - it inherits from ALL visible scenarios + base
      scenarioIndex = 0;
      // Prepend the target scenario so it's at index 0 and inherits from everything
      orderedVisibleScenarios = [scenario, ...orderedVisibleScenarios];
    }
    
    // Compute inherited DSL from base + VISIBLE scenarios BELOW this one
    const inheritedDSL = computeInheritedDSL(scenarioIndex, orderedVisibleScenarios, effectiveBaseDSL);
    
    const scenarioQueryDSL = scenario.meta.queryDSL || '';
    // Split scenario's DSL into fetch and what-if parts
    const { fetchParts, whatIfParts } = splitDSLParts(scenarioQueryDSL);
    
    // Build the effective fetch DSL (inherited + this scenario's fetch parts)
    const scenarioFetchDSL = buildFetchDSL(fetchParts);
    const effectiveFetchDSL = computeEffectiveFetchDSL(inheritedDSL, scenarioQueryDSL);
    
    // Build the what-if DSL for this scenario
    const scenarioWhatIfDSL = buildWhatIfDSL(whatIfParts);
    
    console.log(`Regenerating scenario ${id}:`, {
      queryDSL: scenarioQueryDSL,
      inheritedDSL,
      effectiveFetchDSL,
      whatIfDSL: scenarioWhatIfDSL
    });
    
    try {
      // Build the baseline graph for this scenario (Base + all visible scenario overlays BELOW it).
      // We must NOT start from the current live graph, otherwise the scenario will accidentally
      // inherit Current’s latest fetched values (regression seen with live cohort scenarios).
      const overlaysBelow = orderedVisibleScenarios
        .slice(scenarioIndex + 1)
        .map(s => s.params);
      const baselineParams = composeParams(baseParams, overlaysBelow);
      const baselineGraph = applyComposedParamsToGraph(graph, baselineParams);

      // Check if we need to fetch data using fetchDataService.
      //
      // IMPORTANT: In share/live-link contexts we explicitly disallow fetching from source
      // (allowFetchFromSource=false). In that case we must NOT "fail fast" based on the
      // fetch-planner cache check, because it is a conservative heuristic based on slice
      // headers and may be stricter than what `getParameterFromFile` can legitimately load.
      //
      // Instead, we always follow the from-file path and let missing files/values surface
      // as explicit "Failed to load X/Y items from file cache" errors.
      const allowFetchFromSource = options?.allowFetchFromSource ?? true;
      
      // CRITICAL: Create a DEEP COPY of the graph for scenario-specific fetching.
      // This ensures that fetching data for a scenario doesn't modify the main graph.
      // Each scenario gets its own isolated graph copy to fetch into.
      // IMPORTANT: Copy from the scenario baseline graph, not the current graph.
      let scenarioGraph: Graph = JSON.parse(JSON.stringify(baselineGraph));
      const setScenarioGraph = (g: Graph | null) => {
        if (g) scenarioGraph = g;
        // Note: We intentionally don't update the main graph here.
        // Scenarios store their params as overlays, not by modifying the base graph.
      };
      
      // Unified pipeline:
      // 1) Build a plan (for observability and for "single plan contract").
      // 2) If allowed, execute the plan exactly (plan interpreter).
      // 3) Refresh from files to hydrate the scenarioGraph for the effective DSL (cache-only read).
      //
      // NOTE: In allowFetchFromSource=false contexts (share/live), step (2) is skipped by design.
      const regenLogId = sessionLogService.startOperation(
        'info',
        'data-fetch',
        'SCENARIO_REGEN_PIPELINE',
        `Scenario regen pipeline: ${id}`,
        { scenarioId: id, effectiveFetchDSL, allowFetchFromSource, skipStage2: options?.skipStage2 ?? false }
      );
      try {
        const { plan } = await fetchOrchestratorService.buildPlan({
          graph: scenarioGraph as any,
          dsl: effectiveFetchDSL,
          bustCache: false,
          parentLogId: regenLogId,
        });

        if (allowFetchFromSource) {
          await fetchOrchestratorService.executePlan({
            plan,
            graph: scenarioGraph as any,
            setGraph: setScenarioGraph as any,
            bustCache: false,
            simulate: false,
            parentLogId: regenLogId,
          });
        } else {
          sessionLogService.addChild(
            regenLogId,
            'info',
            'SCENARIO_REGEN_SOURCE_FETCH_DISABLED',
            'Source fetch disabled; running from-file refresh only',
            undefined,
            { allowFetchFromSource: false }
          );
        }

        const refreshRes = await fetchOrchestratorService.refreshFromFilesWithRetries({
          graphGetter: () => scenarioGraph as any,
          setGraph: setScenarioGraph as any,
          dsl: effectiveFetchDSL,
          skipStage2: options?.skipStage2 ?? false,
          parentLogId: regenLogId,
          attempts: 6,
          delayMs: 75,
        });
        if (refreshRes.failures > 0) {
          // Mirror existing semantics: surface as explicit "failed to load from file cache".
          const allItems = fetchDataService.getItemsForFromFileLoad(scenarioGraph);
          throw new Error(`Failed to load ${refreshRes.failures}/${allItems.length} items from file cache`);
        }

        sessionLogService.endOperation(regenLogId, 'success', 'Scenario regen pipeline complete');
      } catch (e: any) {
        sessionLogService.endOperation(regenLogId, 'error', e?.message || String(e));
        throw e;
      }
      
      // Extract the fetched params from the scenario's isolated graph copy
      // This captures the edge params (mean, n, k, etc.) that were loaded
      // We compare against the scenario baseline graph to get only the differences from Base layer.
      const fetchedParams = extractDiffParams(scenarioGraph, baselineGraph);
      
      // Compute what-if params (case overrides, visited conditionals)
      const whatIfParams = await computeEffectiveParams(scenarioGraph, scenarioWhatIfDSL);
      
      // Merge: fetched data params + what-if overrides
      // whatIfParams takes precedence for any overlapping keys
      const effectiveParams: ScenarioParams = {
        edges: { ...fetchedParams.edges, ...whatIfParams.edges },
        nodes: { ...fetchedParams.nodes, ...whatIfParams.nodes }
      };
      
      // Update the scenario with new params
      const now = new Date().toISOString();
      const deps = await (async () => {
        // Best-effort: scenario deps provenance (dynamic-update.md Tier 1).
        // If we cannot compute it for any reason, we still persist the regenerated params and DSL.
        try {
          if (!fileId) return null;
          return await computeScenarioDepsStampV1({
            graphFileId: fileId,
            graph: baselineGraph as any,
            baseDsl: effectiveBaseDSL,
            effectiveDsl: effectiveFetchDSL,
          });
        } catch {
          return null;
        }
      })();

      // IMPORTANT:
      // If caller provided an explicit scenarioOverride (common in share/live boot to avoid stale closures),
      // update it in-place so downstream code can immediately use the regenerated params without racing
      // React state propagation. We still call setScenarios below to update the canonical state.
      try {
        const target = scenarioOverride || null;
        if (target && typeof target === 'object') {
          (target as any).params = effectiveParams;
          (target as any).updatedAt = now;
          (target as any).version = (typeof (target as any).version === 'number' ? (target as any).version : 1) + 1;
          (target as any).meta = {
            ...(target as any).meta,
            lastRegeneratedAt: now,
            lastEffectiveDSL: effectiveFetchDSL,
            deps_v1: deps?.stamp,
            deps_signature_v1: deps?.signature,
          };
        }
      } catch {
        // Best-effort only
      }

      setScenarios(prev => prev.map(s => 
        s.id === id
          ? {
              ...s,
              params: effectiveParams,
              updatedAt: now,
              version: s.version + 1,
              meta: {
                ...s.meta,
                lastRegeneratedAt: now,
                lastEffectiveDSL: effectiveFetchDSL,
                deps_v1: deps?.stamp || (s.meta as any)?.deps_v1,
                deps_signature_v1: deps?.signature || (s.meta as any)?.deps_signature_v1,
              }
            }
          : s
      ));
      
      console.log(`Scenario ${id} regenerated successfully`);
      scheduleChartReconcile('scenario-regenerated');
    } catch (error) {
      console.error(`Failed to regenerate scenario ${id}:`, error);
      throw error;
    }
  }, [scenarios, graph, baseDSL, graphStore, scheduleChartReconcile]);

  // Dev-only: allow an in-session "refetch from files" cycle (no reload) so users can keep
  // the Session Log panel open while reproducing cache / ordering issues.
  //
  // IMPORTANT: this must be declared AFTER regenerateScenario is initialised, otherwise
  // the dependency array would reference a TDZ variable and crash the app at render time.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!fileId) return;

    const handler = async (ev: any) => {
      const detail = ev?.detail || {};
      const targetGraphFileId = detail.graphFileId;
      if (typeof targetGraphFileId === 'string' && targetGraphFileId && targetGraphFileId !== fileId) return;

      const opId = sessionLogService.startOperation(
        'info',
        'session',
        'DEV_REFETCH_FROM_FILES',
        'Dev: refetch from files (scenario regeneration + chart recompute)',
        {
          fileId,
          tabId,
          reason: detail.reason,
          requestedBy: detail.requestedBy,
        }
      );

      try {
        // Pull VISIBLE scenario IDs from the graph tab state.
        // This is the set of scenarios actually composing the on-screen graph, and is what we want to debug.
        let visibleOrder: string[] | null = null;
        try {
          const effectiveTabId =
            (typeof detail.activeTabId === 'string' && detail.activeTabId.trim())
              ? detail.activeTabId.trim()
              : tabId;
          const t = effectiveTabId ? await db.tabs.get(effectiveTabId) : null;
          const vs = (t as any)?.editorState?.scenarioState?.visibleScenarioIds;
          if (Array.isArray(vs) && vs.length > 0) visibleOrder = vs;
        } catch {
          // handled below
        }

        if (!visibleOrder || visibleOrder.length === 0) {
          // Do NOT silently fall back to "all live scenarios" here — that produces unrelated fetches
          // and makes it impossible to debug the scenario set that is actually composing the graph.
          sessionLogService.addChild(
            opId,
            'error',
            'DEV_REFETCH_MISSING_VISIBLE_SCENARIOS',
            'Cannot refetch-from-files: no visibleScenarioIds found for the target graph tab. Focus the graph tab (not Session Log) and retry.',
            undefined,
            { fileId, tabId, activeTabId: detail.activeTabId }
          );
          sessionLogService.endOperation(opId, 'error', 'Dev refetch-from-files aborted (no visible scenarios)');
          return;
        }

        const effectiveBase =
          baseDSL ||
          (graphStore?.getState().graph as any)?.baseDSL ||
          (graph as any)?.baseDSL ||
          graphStore?.getState().currentDSL ||
          '';

        // 0) Refresh Current from file cache so comparisons match live-share behaviour.
        // This is the piece missing in tmp.log: it regenerated the scenario, but did not
        // ensure Current (graphStore/current layer) was rebuilt for the active Current DSL.
        try {
          const currentDsl = graphStore?.getState().currentDSL || '';
          const g = graphStore?.getState().graph as any;
          if (currentDsl && g) {
            sessionLogService.addChild(opId, 'info', 'DEV_REFETCH_CURRENT', 'Refreshing Current from file cache…', undefined, {
              currentDsl,
            } as any);
            const itemsForCurrent = fetchDataService.getItemsForFromFileLoad(g as any);
            if (itemsForCurrent.length > 0) {
              const results = await fetchDataService.fetchItems(
                itemsForCurrent,
                { mode: 'from-file', skipStage2: false, allowFetchFromSource: false } as any,
                g as any,
                (next: any) => {
                  try {
                    graphStore?.getState().setGraph(next);
                  } catch {
                    // best effort
                  }
                },
                currentDsl,
                () => (graphStore?.getState().graph as any) || null
              );
              const ok = results.every((r: any) => r?.success);
              if (!ok) {
                sessionLogService.addChild(opId, 'warning', 'DEV_REFETCH_CURRENT_PARTIAL', 'Current refresh had failures (see console)', undefined);
              } else {
                sessionLogService.addChild(opId, 'success', 'DEV_REFETCH_CURRENT_OK', 'Current refreshed from file cache');
              }
            }
          }
        } catch (e: any) {
          sessionLogService.addChild(opId, 'warning', 'DEV_REFETCH_CURRENT_ERROR', e?.message || String(e));
        }

        // Only regenerate VISIBLE live scenarios (static snapshots do not fetch).
        const idsToRegen = visibleOrder
          .filter((id) => id !== 'base' && id !== 'current')
          .filter((id) => scenarios.some((s) => s.id === id && s.meta?.isLive === true));

        sessionLogService.addChild(
          opId,
          'info',
          'DEV_REFETCH_PLAN',
          `Regenerating ${idsToRegen.length} visible live scenario(s) from file cache…`,
          undefined,
          { visibleScenarioCount: visibleOrder.length, visibleLiveScenarioCount: idsToRegen.length }
        );

        for (const id of idsToRegen) {
          const s = scenarios.find((x) => x.id === id);
          if (!s || s.meta?.isLive !== true) continue;
          sessionLogService.addChild(opId, 'info', 'DEV_REFETCH_SCENARIO', `Regenerating ${id}…`, undefined, {
            scenarioId: id,
            queryDSL: s.meta?.queryDSL,
            lastEffectiveDSL: s.meta?.lastEffectiveDSL,
          });
          await regenerateScenario(id, s, effectiveBase, scenarios, visibleOrder, {
            // Force the full from-file path and log-rich stage2 enhancements, but forbid source fetches.
            skipStage2: false,
            allowFetchFromSource: false,
          });
        }

        // 2) Recompute any open chart artefacts that depend on this graph (mirror live share).
        // We keep this best-effort: scenario regeneration is the primary debugging intent.
        try {
          sessionLogService.addChild(opId, 'info', 'DEV_RECOMPUTE_CHARTS', 'Recomputing open chart(s)…');
          const effectiveGraph = (graphStore?.getState().graph as any) || (graph as any);
          if (effectiveGraph) {
            const res = await recomputeOpenChartsForGraph({
              graphFileId: fileId,
              graph: effectiveGraph,
              baseParams,
              currentParams,
              scenarios: scenarios as any,
              currentColour,
              baseColour,
              authoritativeCurrentDsl: graphStore?.getState().currentDSL || undefined,
            });
            sessionLogService.addChild(opId, 'success', 'DEV_RECOMPUTE_CHARTS_OK', `Recomputed ${res.updatedChartFileIds.length} chart(s)`);
          } else {
            sessionLogService.addChild(opId, 'warning', 'DEV_RECOMPUTE_CHARTS_SKIP', 'No graph available to recompute charts');
          }
        } catch (e: any) {
          sessionLogService.addChild(opId, 'warning', 'DEV_RECOMPUTE_CHARTS_ERROR', e?.message || String(e));
        }

        sessionLogService.endOperation(opId, 'success', 'Dev refetch-from-files complete');
      } catch (e: any) {
        sessionLogService.addChild(opId, 'error', 'DEV_REFETCH_ERROR', e?.message || String(e));
        sessionLogService.endOperation(opId, 'error', 'Dev refetch-from-files failed');
      }
    };

    window.addEventListener('dagnet:debugRefetchFromFiles', handler as any);
    return () => window.removeEventListener('dagnet:debugRefetchFromFiles', handler as any);
  }, [fileId, tabId, baseDSL, graphStore, scenarios, regenerateScenario]);

  /**
   * Regenerate all live scenarios.
   * 
   * Runs regeneration SEQUENTIALLY (bottom-up in visible order) to ensure correct DSL inheritance.
   * Only VISIBLE scenarios contribute to inheritance - hidden scenarios are skipped.
   * 
   * @param baseDSLOverride - Optional: pass new baseDSL to avoid stale closure issues
   * @param visibleOrder - Optional: pass VISIBLE scenario IDs in visual order
   */
  const regenerateAllLive = useCallback(async (baseDSLOverride?: string, visibleOrder?: string[]): Promise<void> => {
    const effectiveBase =
      baseDSLOverride ||
      baseDSL ||
      (graphStore?.getState().graph as any)?.baseDSL ||
      (graph as any)?.baseDSL ||
      graphStore?.getState().currentDSL ||
      '';
    
    // Filter to only visible scenarios if visibleOrder provided
    let scenariosToProcess: Scenario[];
    if (visibleOrder && visibleOrder.length > 0) {
      // Only regenerate VISIBLE live scenarios, in visual order (bottom to top)
      // Reverse the order so we process from bottom (closest to Base) to top
      const reversedOrder = [...visibleOrder].reverse();
      scenariosToProcess = reversedOrder
        .filter(id => id !== 'base' && id !== 'current')
        .map(id => scenarios.find(s => s.id === id))
        .filter((s): s is Scenario => s !== undefined && s.meta?.isLive === true);

      // SAFETY: If a non-empty visibleOrder yields zero live scenarios, fall back to regenerating
      // all live scenarios rather than silently doing nothing. This can happen if the caller's
      // visibleOrder is stale (e.g. closure captured before scenario visibility state loaded).
      if (scenariosToProcess.length === 0) {
        console.warn('[ScenariosContext] regenerateAllLive: visibleOrder provided but no live scenarios matched; falling back to all live scenarios', {
          visibleOrder,
          totalScenarios: scenarios.length,
        });
        scenariosToProcess = scenarios.filter(s => s.meta?.isLive);
      }
    } else {
      // Fallback: all live scenarios in array order
      scenariosToProcess = scenarios.filter(s => s.meta?.isLive);
    }
    
    if (scenariosToProcess.length === 0) {
      console.log('No visible live scenarios to regenerate');
      return;
    }
    
    console.log(`Regenerating ${scenariosToProcess.length} visible live scenarios sequentially with baseDSL="${effectiveBase}"...`);
    
    // Create a working copy of scenarios to track DSL updates as we go
    const workingScenarios = JSON.parse(JSON.stringify(scenarios));
    
    let successCount = 0;
    
    // Process in order (bottom to top in visible stack)
    for (const scenario of scenariosToProcess) {
      if (!scenario.meta?.isLive) continue;
      
      try {
        // Find this scenario in working copy
        const workingScenario = workingScenarios.find((s: Scenario) => s.id === scenario.id);
        if (!workingScenario) continue;
        
        // 1. Pre-calculate the new effective DSL for this scenario
        // Use visibleOrder for inheritance calculation
        const visibleWorkingScenarios = visibleOrder 
          ? visibleOrder
              .filter(id => id !== 'base' && id !== 'current')
              .map(id => workingScenarios.find((s: Scenario) => s.id === id))
              .filter((s: Scenario | undefined): s is Scenario => s !== undefined)
          : workingScenarios;
        
        const scenarioIndex = visibleWorkingScenarios.findIndex((s: Scenario) => s.id === scenario.id);
        const inherited = computeInheritedDSL(scenarioIndex >= 0 ? scenarioIndex : 0, visibleWorkingScenarios, effectiveBase);
        const effective = computeEffectiveFetchDSL(inherited, scenario.meta.queryDSL);
        
        // 2. Update the working copy immediately
        if (!workingScenario.meta) workingScenario.meta = {};
        workingScenario.meta.lastEffectiveDSL = effective;
        
        // 3. Trigger actual regeneration with visibleOrder
        await regenerateScenario(scenario.id, undefined, effectiveBase, workingScenarios, visibleOrder);
        successCount++;
        
      } catch (err) {
        console.error(`Failed to regenerate scenario ${scenario.id} in batch:`, err);
      }
    }
    
    console.log(`Regenerated ${successCount}/${scenariosToProcess.length} scenarios`);
  }, [scenarios, baseDSL, graphStore, regenerateScenario]);

  // Workspace git pull / file revision changes: in auto-update contexts, reconcile visible live scenarios and charts.
  //
  // IMPORTANT: this must be declared AFTER regenerateAllLive is initialised, otherwise
  // the dependency array would reference a TDZ variable and crash the app at render time.
  useEffect(() => {
    if (!fileId) return;

    const handler = async (ev: any) => {
      try {
        const detail = ev?.detail || {};
        const repo = typeof detail.repository === 'string' ? detail.repository : '';
        const branch = typeof detail.branch === 'string' ? detail.branch : '';
        if (!repo || !branch) return;

        // Only handle changes for this graph's workspace identity.
        const graphFile: any = await db.files.get(fileId);
        const src = graphFile?.source || null;
        if (!src || src.repository !== repo || src.branch !== branch) return;

        // Policy gate at execution time.
        try {
          const p = await autoUpdatePolicyService.getAutoUpdateChartsPolicy();
          if (!p.enabled) return;
        } catch {
          // Default is ON; continue.
        }

        // Pull visible scenario order from the active graph tab when available (tab-scoped).
        let visibleOrder: string[] | undefined = undefined;
        try {
          const t = tabId ? await db.tabs.get(tabId) : null;
          const vs = (t as any)?.editorState?.scenarioState?.visibleScenarioIds;
          if (Array.isArray(vs) && vs.length > 0) visibleOrder = vs;
        } catch {
          // ignore best-effort
        }

        // Best-effort: regenerate visible live scenarios, then reconcile charts.
        await regenerateAllLive(undefined, visibleOrder);
        scheduleChartReconcile('workspace-files-changed');
      } catch {
        // best-effort only
      }
    };

    window.addEventListener('dagnet:workspaceFilesChanged', handler as any);
    return () => window.removeEventListener('dagnet:workspaceFilesChanged', handler as any);
  }, [fileId, tabId, regenerateAllLive, scheduleChartReconcile]);

  // Topology edits should trigger refresh: if topology changes, regenerate live scenarios and reconcile charts.
  // Debounced to avoid thrashing during drag/reconnect interactions.
  useEffect(() => {
    if (!fileId) return;
    if (!graph) return;

    const sig = graphTopologySignature(graph);
    if (!sig) return;

    if (topologySigRef.current === null) {
      topologySigRef.current = sig;
      return;
    }

    if (topologySigRef.current === sig) return;
    topologySigRef.current = sig;

    if (topologyRegenTimerRef.current) window.clearTimeout(topologyRegenTimerRef.current);
    topologyRegenTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          try {
            const p = await autoUpdatePolicyService.getAutoUpdateChartsPolicy();
            if (!p.enabled) return;
          } catch {
            // Default is ON; continue.
          }
          // Pull visible scenario order from the active graph tab when available (tab-scoped).
          let visibleOrder: string[] | undefined = undefined;
          try {
            const t = tabId ? await db.tabs.get(tabId) : null;
            const vs = (t as any)?.editorState?.scenarioState?.visibleScenarioIds;
            if (Array.isArray(vs) && vs.length > 0) visibleOrder = vs;
          } catch {
            // ignore best-effort
          }

          await regenerateAllLive(undefined, visibleOrder);
          scheduleChartReconcile('graph-topology-changed');
        } catch {
          // best-effort only; failures should not break authoring
        }
      })();
    }, 300);
  }, [fileId, tabId, graph, regenerateAllLive, scheduleChartReconcile]);

  /**
   * Update a scenario's queryDSL and trigger regeneration.
   * 
   * @param id - Scenario ID
   * @param queryDSL - New query DSL
   */
  const updateScenarioQueryDSL = useCallback(async (id: string, queryDSL: string): Promise<void> => {
    // Find the existing scenario to build the updated version
    const existingScenario = scenarios.find(s => s.id === id);
    if (!existingScenario) {
      console.warn(`updateScenarioQueryDSL: Scenario ${id} not found`);
      return;
    }
    
    // Build the updated scenario
    const updatedScenario: Scenario = {
      ...existingScenario,
      meta: {
        ...existingScenario.meta,
        queryDSL: queryDSL ?? '',
        isLive: Boolean(queryDSL && queryDSL.trim()),
      },
      updatedAt: new Date().toISOString(),
      version: existingScenario.version + 1,
    };
    
    // Update state
    setScenarios(prev => prev.map(s => s.id === id ? updatedScenario : s));
    
    // Trigger regeneration if DSL is set - pass the updated scenario directly
    // to avoid stale closure issues (state might not have updated yet)
    if (queryDSL && queryDSL.trim()) {
      await regenerateScenario(id, updatedScenario);
    }
  }, [scenarios, regenerateScenario]);

  /**
   * Set the base DSL and persist to graph.
   */
  const setBaseDSL = useCallback((dsl: string): void => {
    setBaseDSLState(dsl);
    
    // Also update the graph object so it persists to YAML
    if (graphStore) {
      const currentGraph = graphStore.getState().graph;
      if (currentGraph) {
        graphStore.getState().setGraph({
          ...currentGraph,
          baseDSL: dsl
        });
      }
    }
  }, [graphStore]);

  /**
   * "To Base" operation: Set baseDSL from current graph DSL and regenerate all live scenarios.
   * 
   * @param visibleOrder - Optional: pass VISIBLE scenario IDs in visual order for correct inheritance
   */
  const putToBase = useCallback(async (visibleOrder?: string[]): Promise<void> => {
    // Get current DSL from graphStore
    const currentDSL = graphStore?.getState().currentDSL || '';
    const derivedBaseDSL = deriveBaseDSLForRebase(currentDSL);
    
    console.log(`putToBase: Setting baseDSL to "${derivedBaseDSL}" (derived from currentDSL)`);
    
    // Update baseDSL state
    setBaseDSL(derivedBaseDSL);
    
    // Regenerate all live scenarios with the new base DSL
    // IMPORTANT: Pass currentDSL directly to avoid stale closure - setBaseDSL is async
    // Pass visibleOrder so only visible scenarios contribute to inheritance
    await regenerateAllLive(derivedBaseDSL, visibleOrder);
  }, [graphStore, setBaseDSL, regenerateAllLive]);

  /**
   * Get a scenario by ID
   */
  const getScenario = useCallback((id: string): Scenario | undefined => {
    return scenarios.find(s => s.id === id);
  }, [scenarios]);

  /**
   * List all scenarios
   */
  const listScenarios = useCallback((): Scenario[] => {
    return scenarios;
  }, [scenarios]);

  /**
   * Rename a scenario
   */
  const renameScenario = useCallback(async (id: string, name: string): Promise<void> => {
    setScenarios(prev => prev.map(s => 
      s.id === id 
        ? { ...s, name, updatedAt: new Date().toISOString(), version: s.version + 1 }
        : s
    ));
  }, []);

  /**
   * Update scenario colour
   */
  const updateScenarioColour = useCallback(async (id: string, colour: string): Promise<void> => {
    setScenarios(prev => prev.map(s => 
      s.id === id 
        ? { ...s, colour, updatedAt: new Date().toISOString(), version: s.version + 1 }
        : s
    ));
  }, []);

  /**
   * Delete a scenario
   */
  const deleteScenario = useCallback(async (id: string): Promise<void> => {
    setScenarios(prev => prev.filter(s => s.id !== id));
    
    // Close editor if this scenario was open
    if (editorOpenScenarioId === id) {
      setEditorOpenScenarioId(null);
    }
  }, [editorOpenScenarioId]);

  /**
   * Apply edited content to a scenario
   */
  const applyContent = useCallback(async (
    id: string,
    content: string,
    options: ApplyContentOptions
  ): Promise<void> => {
    const { format, structure = 'nested', validate = true } = options;
    
    // Parse content via canonical DSL engine (includes HRN resolution when graph is present)
    let parsedParams: ScenarioParams;
    try {
      if (format === 'yaml') {
        parsedParams = fromYAML(content, structure, graph);
      } else {
        parsedParams = fromJSON(content, structure, graph);
      }
    } catch (error: any) {
      throw new Error(`Failed to parse ${format.toUpperCase()}: ${error.message}`);
    }
    
    // Validate if requested
    if (validate && graph) {
      const validation = await validateContent(content, options, graph);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.map(e => e.message).join(', ')}`);
      }
    }
    
    // Update scenario
    setScenarios(prev => prev.map(s => 
      s.id === id 
        ? { 
            ...s, 
            params: parsedParams,
            updatedAt: new Date().toISOString(), 
            version: s.version + 1 
          }
        : s
    ));
  }, [graph]);

  /**
   * Validate scenario content without applying
   */
  const validateContent = useCallback(async (
    content: string,
    options: ApplyContentOptions,
    graph?: Graph
  ): Promise<ScenarioValidationResult> => {
    const { format, structure = 'nested' } = options;
    
    // Parse content via canonical DSL engine (includes HRN resolution when graph is present)
    let parsedParams: ScenarioParams;
    try {
      if (format === 'yaml') {
        parsedParams = fromYAML(content, structure, graph);
      } else {
        parsedParams = fromJSON(content, structure, graph);
      }
    } catch (error: any) {
      return {
        valid: false,
        errors: [{
          path: 'root',
          message: `Failed to parse ${format.toUpperCase()}: ${error.message}`
        }],
        warnings: [],
        unresolvedHRNs: []
      };
    }
    
    // Validate against graph if provided
    if (!graph) {
      // No graph provided, can only do basic structural validation
      return {
        valid: true,
        errors: [],
        warnings: [{
          path: 'root',
          message: 'No graph provided for full validation'
        }],
        unresolvedHRNs: []
      };
    }
    
    return validateScenarioParams(parsedParams, graph);
  }, []);

  /**
   * Open scenario in editor
   */
  const openInEditor = useCallback((id: string): void => {
    setEditorOpenScenarioId(id);
  }, []);
  
  /**
   * Close editor
   */
  const closeEditor = useCallback((): void => {
    setEditorOpenScenarioId(null);
  }, []);

  /**
   * Compose parameters from visible scenarios
   */
  const composeVisibleParams = useCallback((visibleScenarioIds: string[]): ScenarioParams => {
    // Get scenarios in render order
    const visibleScenarios = visibleScenarioIds
      .map(id => scenarios.find(s => s.id === id))
      .filter((s): s is Scenario => s !== undefined);
    
    // Compose from base through all visible overlays
    const overlays = visibleScenarios.map(s => s.params);
    return composeParams(baseParams, overlays);
  }, [scenarios, baseParams]);

  /**
   * Flatten: merge all visible scenarios into Base and clear overlays
   * 
   * This operation:
   * 1. Composes all current parameters (Base + all scenarios + Current)
   * 2. Sets Base := composed parameters
   * 3. Clears all scenario overlays
   * 4. Current remains visible (now matching Base)
   * 
   * This is a session-local operation; persisting to repo requires a separate commit.
   */
  const flatten = useCallback(async (): Promise<void> => {
    // Compose all scenarios into final params
    const overlays = scenarios.map(s => s.params);
    const composedBase = composeParams(baseParams, overlays);
    
    // Merge current params on top
    const finalParams = composeParams(composedBase, [currentParams]);
    
    // Set Base to the fully composed state
    setBaseParams(finalParams);
    
    // Clear all scenario overlays
    setScenarios([]);
    
    // Current params remain (now effectively matching Base)
    // No need to change currentParams - it continues to apply on top of the new Base
  }, [scenarios, baseParams, currentParams]);

  // PERF: Memoize context value to prevent cascade re-renders
  // Creating new object on every render causes ALL consumers to re-render
  const value: ScenariosContextValue = useMemo(() => ({
    scenarios,
    baseParams,
    currentParams,
    currentColour,
    baseColour,
    editorOpenScenarioId,
    scenariosReady: scenariosLoaded,
    graph,
    baseDSL,
    createSnapshot,
    createBlank,
    getScenario,
    listScenarios,
    renameScenario,
    updateScenarioColour,
    deleteScenario,
    // Live scenario operations
    createLiveScenario,
    createLiveScenarioFromCurrentDelta,
    regenerateScenario,
    regenerateAllLive,
    updateScenarioQueryDSL,
    setBaseDSL,
    putToBase,
    // Content operations
    applyContent,
    validateContent,
    openInEditor,
    closeEditor,
    composeVisibleParams,
    flatten,
    setBaseParams,
    setCurrentParams,
    setCurrentColour,
    setBaseColour,
  }), [
    scenarios,
    baseParams,
    currentParams,
    currentColour,
    baseColour,
    editorOpenScenarioId,
    scenariosLoaded,
    graph,
    baseDSL,
    createSnapshot,
    createBlank,
    getScenario,
    listScenarios,
    renameScenario,
    updateScenarioColour,
    deleteScenario,
    createLiveScenario,
    createLiveScenarioFromCurrentDelta,
    regenerateScenario,
    regenerateAllLive,
    updateScenarioQueryDSL,
    setBaseDSL,
    putToBase,
    applyContent,
    validateContent,
    openInEditor,
    closeEditor,
    composeVisibleParams,
    flatten,
    setBaseParams,
    setCurrentParams,
    setCurrentColour,
    setBaseColour,
  ]);

  return (
    <ScenariosContext.Provider value={value}>
      {children}
    </ScenariosContext.Provider>
  );
}

/**
 * Hook to access scenarios context
 */
export function useScenariosContext(): ScenariosContextValue {
  const context = useContext(ScenariosContext);
  if (!context) {
    throw new Error('useScenariosContext must be used within a ScenariosProvider');
  }
  return context;
}

/**
 * Hook to access scenarios context (nullable version for optional use)
 */
export function useScenariosContextOptional(): ScenariosContextValue | null {
  return useContext(ScenariosContext);
}

