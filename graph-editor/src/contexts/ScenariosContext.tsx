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
    context?: Record<string, string>
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
  const lastFileIdRef = useRef<string | null>(null);
  const [scenariosLoaded, setScenariosLoaded] = useState(false);

  // Load scenarios from IndexedDB on mount or file change
  useEffect(() => {
    const loadScenarios = async () => {
      if (!fileId) return;
      
      try {
        const savedScenarios = await db.scenarios
          .where('fileId')
          .equals(fileId)
          .toArray();
        
        console.log(`ScenariosContext: Loaded ${savedScenarios.length} scenarios for file ${fileId}`);
        
        // Remove fileId from scenario objects (it's just for DB indexing)
        const scenarios = savedScenarios.map(({ fileId: _fileId, ...scenario }) => scenario as Scenario);
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
        // Delete all scenarios for this file
        await db.scenarios.where('fileId').equals(fileId).delete();
        
        // Add all current scenarios
        if (scenarios.length > 0) {
          const scenariosWithFileId = scenarios.map(scenario => ({
            ...scenario,
            fileId
          }));
          await db.scenarios.bulkAdd(scenariosWithFileId);
          console.log(`ScenariosContext: Saved ${scenarios.length} scenarios for file ${fileId}`);
        }
      } catch (error) {
        console.error('Failed to save scenarios to DB:', error);
      }
    };
    
    saveScenarios();
  }, [scenarios, fileId, scenariosLoaded]);

  // Extract parameters from graph
  // - On FILE CHANGE: Set both baseParams and currentParams (new baseline)
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
    
    // Compute diff
    const diff = computeDiff(currentParams, baseForDiff, type, diffThreshold);
    
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
    
    // Insert new scenario at position 2 (just beneath Current)
    // This means PREPENDING to the array: newer scenarios closer to Base in composition
    // Array order: [newest, ..., oldest]
    // Composition: Base + scenarios[0] + scenarios[1] + ... + Current
    setScenarios(prev => [scenario, ...prev]);
    
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

