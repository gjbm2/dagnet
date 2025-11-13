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

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { 
  Scenario, 
  ScenarioParams, 
  CreateSnapshotOptions,
  ApplyContentOptions,
  ScenarioValidationResult,
  ScenarioMeta
} from '../types/scenarios';
import { Graph } from '../types';
import { composeParams } from '../services/CompositionService';
import { getDefaultScenarioColor } from '../services/ColorAssigner';
import { computeDiff } from '../services/DiffService';
import { fromYAML, fromJSON } from '../services/ScenarioFormatConverter';
import { validateScenarioParams } from '../services/ScenarioValidator';
import { extractParamsFromGraph } from '../services/GraphParamExtractor';
import { computeEffectiveEdgeProbability } from '../lib/whatIf';
import { useGraphStore } from './GraphStoreContext';
import { db } from '../db/appDatabase';

interface ScenariosContextValue {
  // State
  scenarios: Scenario[];
  baseParams: ScenarioParams;
  currentParams: ScenarioParams;
  editorOpenScenarioId: string | null;
  
  // CRUD operations
  createSnapshot: (
    options: CreateSnapshotOptions, 
    tabId: string,
    whatIfDSL?: string | null,
    whatIfSummary?: string,
    window?: { start: string; end: string } | null,
    context?: Record<string, string>,
    visibleScenarioIds?: string[]
  ) => Promise<Scenario>;
  createBlank: (name: string, tabId: string) => Promise<Scenario>;
  getScenario: (id: string) => Scenario | undefined;
  listScenarios: () => Scenario[];
  renameScenario: (id: string, name: string) => Promise<void>;
  deleteScenario: (id: string) => Promise<void>;
  
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
  const graph = graphStore?.getState().graph || null;
  
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [baseParams, setBaseParams] = useState<ScenarioParams>({ edges: {}, nodes: {} });
  const [currentParams, setCurrentParams] = useState<ScenarioParams>({ edges: {}, nodes: {} });
  const [editorOpenScenarioId, setEditorOpenScenarioId] = useState<string | null>(null);
  const persistTimerRef = useRef<number | null>(null);

  // Extract parameters from graph on mount and when graph changes
  useEffect(() => {
    if (graph) {
      const params = extractParamsFromGraph(graph);
      setBaseParams(params);
      setCurrentParams(params);
    }
  }, [graph]);

  // Load scenarios from IndexedDB (per file) on mount
  useEffect(() => {
    const load = async () => {
      if (!fileId) return;
      const file = await db.files.get(fileId);
      if (file?.scenarios && Array.isArray(file.scenarios)) {
        setScenarios(file.scenarios as Scenario[]);
      }
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  // Persist scenarios to IndexedDB (debounced)
  useEffect(() => {
    if (!fileId) return;
    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(async () => {
      try {
        await db.files.update(fileId, { scenarios });
      } catch (e) {
        console.warn('Failed to persist scenarios:', e);
      } finally {
        persistTimerRef.current = null;
      }
    }, 300);
    return () => {
      if (persistTimerRef.current) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [fileId, scenarios]);

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
    context?: Record<string, string>,
    visibleScenarioIds?: string[]
  ): Promise<Scenario> => {
    const { name, type, source = 'visible', diffThreshold = 1e-6, note } = options;
    
    // Determine what to diff against
    let baseForDiff: ScenarioParams;
    if (source === 'base') {
      // Diff against Base only
      baseForDiff = baseParams;
    } else {
      // Diff against composed visible layers (excluding Current)
      // Filter to only visible scenarios for this tab
      const visibleScenarios = visibleScenarioIds
        ? scenarios.filter(s => visibleScenarioIds.includes(s.id))
        : scenarios;
      const overlays = visibleScenarios.map(s => s.params);
      baseForDiff = composeParams(baseParams, overlays);
    }
    
    // Apply What-If to current params to get the perceived state
    let effectiveCurrentParams = currentParams;
    if (whatIfDSL && graphStore) {
      const graph = graphStore.getState().graph;
      if (graph?.edges) {
        // Create a copy of currentParams with What-If applied to edge probabilities
        const effectiveEdges: Record<string, any> = {};
        
        // Process all edges from the graph
        graph.edges.forEach((edge: any) => {
          const edgeId = edge.uuid || edge.id;
          if (!edgeId) return;
          
          // Compute effective probability with What-If DSL applied
          const effectiveProb = computeEffectiveEdgeProbability(
            graph,
            edgeId,
            { whatIfDSL }
          );
          
          // Check if probability differs from base (stored in edge.p?.mean)
          const baseProb = edge.p?.mean ?? 0;
          if (Math.abs(effectiveProb - baseProb) > diffThreshold) {
            effectiveEdges[edgeId] = {
              ...currentParams.edges?.[edgeId],
              p: { mean: effectiveProb }
            };
          }
        });
        
        effectiveCurrentParams = {
          ...currentParams,
          edges: { ...currentParams.edges, ...effectiveEdges }
        };
      }
    }
    
    // Compute diff using effective params (with What-If applied)
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
    const scenario: Scenario = {
      id: generateId(),
      name,
      color: getDefaultScenarioColor(),
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
    
    console.log(`[ScenariosContext] 🆕 Creating new scenario "${name}" (id: ${scenario.id})`);
    console.log(`[ScenariosContext] 📋 Scenarios BEFORE creation:`, scenarios.map(s => ({ id: s.id, name: s.name })));
    console.log(`[ScenariosContext] 👁️ Visible scenarios for tab ${tabId}:`, visibleScenarioIds);
    
    // Insert new scenario at position 2 (just beneath Current)
    // This means PREPENDING to the array: newer scenarios closer to Base in composition
    // Array order: [newest, ..., oldest]
    // Composition: Base + scenarios[0] + scenarios[1] + ... + Current
    setScenarios(prev => {
      const newList = [scenario, ...prev];
      console.log(`[ScenariosContext] 📋 Scenarios AFTER creation:`, newList.map(s => ({ id: s.id, name: s.name })));
      console.log(`[ScenariosContext] Total scenarios: ${newList.length}`);
      return newList;
    });
    
    // Make the new scenario visible by default in the tab where it was created
    if (typeof globalThis !== 'undefined' && globalThis.window) {
      console.log(`[ScenariosContext] 📢 Dispatching event to make scenario ${scenario.id} visible in tab ${tabId}`);
      const event = new CustomEvent('dagnet:addVisibleScenario', { 
        detail: { tabId, scenarioId: scenario.id } 
      });
      globalThis.window.dispatchEvent(event);
    }
    
    return scenario;
  }, [generateId, baseParams, currentParams, scenarios]);

  /**
   * Create a blank scenario
   */
  const createBlank = useCallback(async (
    name: string,
    tabId: string
  ): Promise<Scenario> => {
    const now = new Date().toISOString();
    const scenario: Scenario = {
      id: generateId(),
      name,
      color: getDefaultScenarioColor(),
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
   * Delete a scenario
   */
  const deleteScenario = useCallback(async (id: string): Promise<void> => {
    console.log(`[ScenariosContext] 🗑️ Deleting scenario ${id}`);
    
    // Clear any pending debounced persistence to prevent overwrite
    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    
    // Compute new scenarios from current state
    const newScenarios = scenarios.filter(s => s.id !== id);
    
    // Update React state
    setScenarios(newScenarios);
    
    // IMMEDIATELY persist to IndexedDB (don't wait for debounce)
    if (fileId) {
      try {
        await db.files.update(fileId, { scenarios: newScenarios });
        console.log(`[ScenariosContext] ✅ Persisted deletion of ${id} to IndexedDB`);
      } catch (e) {
        console.error(`[ScenariosContext] ❌ Failed to persist deletion:`, e);
      }
    }
    
    // Close editor if this scenario was open
    if (editorOpenScenarioId === id) {
      setEditorOpenScenarioId(null);
    }
    
    // Broadcast deletion event so all tabs can clean up orphaned visibility references
    if (typeof globalThis !== 'undefined' && globalThis.window) {
      console.log(`[ScenariosContext] 📢 Broadcasting scenario deletion event for ${id}`);
      const event = new CustomEvent('dagnet:scenarioDeleted', { 
        detail: { scenarioId: id } 
      });
      globalThis.window.dispatchEvent(event);
    }
  }, [editorOpenScenarioId, scenarios, fileId]);

  /**
   * Apply edited content to a scenario
   */
  const applyContent = useCallback(async (
    id: string,
    content: string,
    options: ApplyContentOptions
  ): Promise<void> => {
    const { format, structure = 'nested', validate = true } = options;
    
    // Parse content
    let parsedParams: ScenarioParams;
    try {
      if (format === 'yaml') {
        parsedParams = fromYAML(content, structure);
      } else {
        parsedParams = fromJSON(content, structure);
      }
    } catch (error: any) {
      throw new Error(`Failed to parse ${format.toUpperCase()}: ${error.message}`);
    }
    
    // Validate if requested (but don't block Apply)
    // Validation warnings are shown in the modal UI, but we persist anyway
    if (validate && graph) {
      const validation = await validateContent(content, options, graph);
      // Log validation results but don't throw - allow saving partial/invalid data
      if (!validation.valid || validation.warnings.length > 0) {
        console.warn('Scenario validation issues:', validation);
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
    
    // Parse content
    let parsedParams: ScenarioParams;
    try {
      if (format === 'yaml') {
        parsedParams = fromYAML(content, structure);
      } else {
        parsedParams = fromJSON(content, structure);
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

  const value: ScenariosContextValue = {
    scenarios,
    baseParams,
    currentParams,
    editorOpenScenarioId,
    createSnapshot,
    createBlank,
    getScenario,
    listScenarios,
    renameScenario,
    deleteScenario,
    applyContent,
    validateContent,
    openInEditor,
    closeEditor,
    composeVisibleParams,
    flatten,
    setBaseParams,
    setCurrentParams,
  };

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

