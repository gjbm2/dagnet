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

import React, { createContext, useContext, useState, useCallback } from 'react';
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

interface ScenariosContextValue {
  // State
  scenarios: Scenario[];
  baseParams: ScenarioParams;
  currentParams: ScenarioParams;
  editorOpenScenarioId: string | null;
  
  // CRUD operations
  createSnapshot: (options: CreateSnapshotOptions, tabId: string) => Promise<Scenario>;
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
  graph?: Graph;
}

/**
 * Scenarios Provider
 */
export function ScenariosProvider({ children, graph }: ScenariosProviderProps) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [baseParams, setBaseParams] = useState<ScenarioParams>({ edges: {}, nodes: {} });
  const [currentParams, setCurrentParams] = useState<ScenarioParams>({ edges: {}, nodes: {} });
  const [editorOpenScenarioId, setEditorOpenScenarioId] = useState<string | null>(null);

  /**
   * Generate a unique ID for a new scenario
   */
  const generateId = useCallback((): string => {
    return `scenario-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }, []);

  /**
   * Create a snapshot scenario
   */
  const createSnapshot = useCallback(async (
    options: CreateSnapshotOptions,
    tabId: string
  ): Promise<Scenario> => {
    const { name, type, source = 'visible', diffThreshold = 1e-6, note } = options;
    
    // Determine what to diff against
    let baseForDiff: ScenarioParams;
    if (source === 'base') {
      // Diff against Base only
      baseForDiff = baseParams;
    } else {
      // Diff against composed visible layers (excluding Current)
      // TODO: Get visible scenario IDs from tab state
      // For now, compose all scenarios
      const overlays = scenarios.map(s => s.params);
      baseForDiff = composeParams(baseParams, overlays);
    }
    
    // Compute diff
    const diff = computeDiff(currentParams, baseForDiff, type, diffThreshold);
    
    // Generate auto note if not provided
    const autoNote = note || `${type === 'all' ? 'Full' : 'Diff'} snapshot from ${source === 'base' ? 'Base' : 'visible layers'} on ${new Date().toLocaleString()}`;
    
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
        // TODO: Capture window, context, whatIfDSL from tab state
      }
    };
    
    setScenarios(prev => [...prev, scenario]);
    
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
    
    setScenarios(prev => [...prev, scenario]);
    
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
   */
  const flatten = useCallback(async (): Promise<void> => {
    // TODO: Implement full flatten logic in Phase 6
    // For now, just clear scenarios
    
    // Compose all visible params into current
    // Set base := current
    // Clear all scenarios
    
    setScenarios([]);
  }, []);

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

