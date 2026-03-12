/**
 * useBulkScenarioCreation
 * 
 * Centralized hook for creating multiple live scenarios at once.
 * 
 * DESIGN PRINCIPLE: 
 * To avoid stale closure issues with React state (specifically TabContext visibility),
 * we perform operations in logical phases:
 * 1. Creation Phase: Create all scenarios in the database/state (sequential/parallel)
 * 2. Visibility Phase: Calculate final visibility set ONCE and apply it atomically
 * 3. Data Phase: Regenerate data for all new scenarios
 * 
 * This avoids the race condition where toggling visibility in a loop continually 
 * reverts to the previous state because the closure hasn't updated yet.
 */

import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useScenariosContextOptional, SCENARIO_PALETTE } from '../contexts/ScenariosContext';
import { operationRegistryService } from '../services/operationRegistryService';
import { Scenario } from '../types/scenarios';
import { useTabContext } from '../contexts/TabContext';
import { contextRegistry } from '../services/contextRegistry';
import { deriveBaseDSLForRebase, inferDateModeFromDSL, normaliseScenarioDateRangeDSL } from '../services/scenarioRegenerationService';
import { useGraphStoreOptional } from '../contexts/GraphStoreContext';

interface ContextValue {
  id: string;
  label: string;
}

interface BulkCreateModalState {
  contextKey: string;
  values: ContextValue[];
}

interface UseBulkScenarioCreationReturn {
  bulkCreateModal: BulkCreateModalState | null;
  closeBulkCreateModal: () => void;
  openBulkCreateForContext: (contextKey: string) => Promise<void>;
  createScenariosForContext: (contextKey: string, valueIds: string[]) => Promise<number>;
  createWindowScenario: (windowDSL: string) => Promise<boolean>;
  createMultipleWindowScenarios: (windowDSLs: string[]) => Promise<number>;
  getWindowDSLForPreset: (preset: 7 | 30 | 90, offset?: number) => string;
}

/**
 * NOTE: This hook is used from multiple UI surfaces. Some of those surfaces may be visible
 * while a different dock tab is "active" (e.g. Session Log tab focused).
 *
 * To avoid writing scenario visibility state into the wrong tab, callers that know the
 * correct graph tab should pass `tabIdOverride`.
 */
export function useBulkScenarioCreation(tabIdOverride?: string): UseBulkScenarioCreationReturn {
  const scenariosContext = useScenariosContextOptional();
  const { activeTabId, operations } = useTabContext();
  const graphStore = useGraphStoreOptional();
  const [bulkCreateModal, setBulkCreateModal] = useState<BulkCreateModalState | null>(null);
  const effectiveTabId = tabIdOverride || activeTabId;
  
  const closeBulkCreateModal = useCallback(() => {
    setBulkCreateModal(null);
  }, []);
  
  const openBulkCreateForContext = useCallback(async (contextKey: string): Promise<void> => {
    try {
      const values = await contextRegistry.getValuesForContext(contextKey);
      setBulkCreateModal({
        contextKey,
        values: values.map(v => ({ id: v.id, label: v.label || v.id }))
      });
    } catch (err) {
      toast.error('Failed to load context values');
      console.error('Failed to load context values:', err);
    }
  }, []);
  
  /**
   * Internal helper to assign colours sequentially starting from a free slot
   */
  const getAssignedColours = useCallback((count: number): string[] => {
    if (!scenariosContext) return Array(count).fill(SCENARIO_PALETTE[0]);

    const usedColours = new Set(scenariosContext.scenarios.map(s => s.colour));
    const availableColours: string[] = [];
    
    // Find all unused colours first
    for (const colour of SCENARIO_PALETTE) {
      if (!usedColours.has(colour)) {
        availableColours.push(colour);
      }
    }
    
    // Fill the rest by cycling through palette
    const result: string[] = [];
    let availIdx = 0;
    let paletteIdx = 0;
    
    for (let i = 0; i < count; i++) {
      if (availIdx < availableColours.length) {
        result.push(availableColours[availIdx++]);
      } else {
        result.push(SCENARIO_PALETTE[paletteIdx % SCENARIO_PALETTE.length]);
        paletteIdx++;
      }
    }
    
    return result;
  }, [scenariosContext]);

  /**
   * Create scenarios for context values
   */
  const createScenariosForContext = useCallback(async (
    contextKey: string,
    valueIds: string[]
  ): Promise<number> => {
    if (!scenariosContext || !effectiveTabId) {
      toast.error('Scenarios not available');
      return 0;
    }

    // DEFAULT for bulk context scenario creation:
    // "Differences & re-base" — put Current's window/cohort to Base FIRST, then create scenarios
    // with *only* the context(value) clause (no date ranges), preserving "build from base".
    const currentDSL = graphStore?.getState().currentDSL || '';
    const newBaseDSL = deriveBaseDSLForRebase(currentDSL);
    if (newBaseDSL) {
      scenariosContext.setBaseDSL(newBaseDSL);
    }
    
    const opId = `bulk-scenario:context:${Date.now()}`;
    const total = valueIds.length;
    operationRegistryService.register({
      id: opId, kind: 'bulk-scenario', label: `Creating scenarios (0/${total})…`,
      status: 'running', progress: { current: 0, total: total * 2 },
    });
    const createdScenarios: Scenario[] = [];
    const colours = getAssignedColours(valueIds.length);

    try {
      // PHASE 1: Create all scenarios
      for (let i = 0; i < valueIds.length; i++) {
        operationRegistryService.setLabel(opId, `Creating scenarios (${i + 1}/${total})…`);
        operationRegistryService.setProgress(opId, { current: i + 1, total: total * 2 });

        const queryDSL = `context(${contextKey}:${valueIds[i]})`;
        const scenario = await scenariosContext.createLiveScenario(
          queryDSL,
          undefined,
          effectiveTabId,
          colours[i]
        );
        createdScenarios.push(scenario);
      }

      // PHASE 2: Update Visibility ATOMICALLY
      const newScenarioIds = createdScenarios.map(s => s.id);
      await operations.addVisibleScenarios(effectiveTabId, newScenarioIds);

      // PHASE 3: Regenerate Data
      const existingScenarios = scenariosContext.scenarios || [];
      const allScenarios = [...[...createdScenarios].reverse(), ...existingScenarios];

      const scenarioState = operations.getScenarioState(effectiveTabId);
      const existingVisibleIds = scenarioState?.visibleScenarioIds || [];
      const visibleOrder = [...newScenarioIds, ...existingVisibleIds];

      for (let i = 0; i < createdScenarios.length; i++) {
        const scenario = createdScenarios[i];
        operationRegistryService.setLabel(opId, `Fetching data (${i + 1}/${createdScenarios.length})…`);
        operationRegistryService.setProgress(opId, { current: total + i + 1, total: total * 2 });

        await scenariosContext.regenerateScenario(
          scenario.id,
          scenario,
          newBaseDSL || undefined,
          allScenarios,
          visibleOrder
        );
      }

      operationRegistryService.setLabel(opId, `Created ${createdScenarios.length} scenarios`);
      operationRegistryService.complete(opId, 'complete');
      setBulkCreateModal(null);
      return createdScenarios.length;

    } catch (err) {
      console.error('Bulk creation failed:', err);
      operationRegistryService.complete(opId, 'error', 'Failed to complete bulk creation');
      return createdScenarios.length;
    }
  }, [scenariosContext, effectiveTabId, operations, getAssignedColours]);
  
  /**
   * Create a single window scenario
   */
  const createWindowScenario = useCallback(async (windowDSL: string): Promise<boolean> => {
    // Reuse the bulk logic for consistency (array of 1)
    const count = await createMultipleWindowScenarios([windowDSL]);
    return count > 0;
  }, []); // eslint-disable-next-line react-hooks/exhaustive-deps
  
  /**
   * Create multiple window scenarios
   */
  const createMultipleWindowScenarios = useCallback(async (windowDSLs: string[]): Promise<number> => {
    if (!scenariosContext || !effectiveTabId) {
      toast.error('Scenarios not available');
      return 0;
    }

    // DEFAULT for bulk window scenario creation:
    // "Differences & re-base" — set Base to the current window/cohort first so the scenario set
    // reads as "changes from Base" and doesn't surprise users with unrelated inherited ranges.
    const currentDSL = graphStore?.getState().currentDSL || '';
    const newBaseDSL = deriveBaseDSLForRebase(currentDSL);
    if (newBaseDSL) {
      scenariosContext.setBaseDSL(newBaseDSL);
    }

    const dateMode = inferDateModeFromDSL(currentDSL);
    
    const opId = `bulk-scenario:window:${Date.now()}`;
    const total = windowDSLs.length;
    operationRegistryService.register({
      id: opId, kind: 'bulk-scenario', label: `Creating scenarios (0/${total})…`,
      status: 'running', progress: { current: 0, total: total * 2 },
    });
    const createdScenarios: Scenario[] = [];
    const colours = getAssignedColours(windowDSLs.length);

    try {
      // PHASE 1: Create
      for (let i = 0; i < windowDSLs.length; i++) {
        operationRegistryService.setLabel(opId, `Creating scenarios (${i + 1}/${total})…`);
        operationRegistryService.setProgress(opId, { current: i + 1, total: total * 2 });

        // CRITICAL: Do not create mixed-mode DSLs (cohort + window) – normalise to current mode.
        const queryDSL = normaliseScenarioDateRangeDSL(windowDSLs[i], dateMode);

        const scenario = await scenariosContext.createLiveScenario(
          queryDSL,
          undefined,
          effectiveTabId,
          colours[i]
        );
        createdScenarios.push(scenario);
      }

      // PHASE 2: Visibility
      const newScenarioIds = createdScenarios.map(s => s.id);
      await operations.addVisibleScenarios(effectiveTabId, newScenarioIds);

      // PHASE 3: Regenerate
      const existingScenarios = scenariosContext.scenarios || [];
      const allScenarios = [...[...createdScenarios].reverse(), ...existingScenarios];

      const scenarioState = operations.getScenarioState(effectiveTabId);
      const existingVisibleIds = scenarioState?.visibleScenarioIds || [];
      const visibleOrder = [...newScenarioIds, ...existingVisibleIds];

      for (let i = 0; i < createdScenarios.length; i++) {
        const scenario = createdScenarios[i];
        operationRegistryService.setLabel(opId, `Fetching data (${i + 1}/${createdScenarios.length})…`);
        operationRegistryService.setProgress(opId, { current: total + i + 1, total: total * 2 });

        await scenariosContext.regenerateScenario(
          scenario.id,
          scenario,
          newBaseDSL || undefined,
          allScenarios,
          visibleOrder
        );
      }

      operationRegistryService.setLabel(opId, `Created ${createdScenarios.length} scenarios`);
      operationRegistryService.complete(opId, 'complete');
      return createdScenarios.length;

    } catch (err) {
      console.error('Bulk creation failed:', err);
      operationRegistryService.complete(opId, 'error', 'Failed to create scenarios');
      return createdScenarios.length;
    }
  }, [scenariosContext, effectiveTabId, operations, getAssignedColours]);
  
  const getWindowDSLForPreset = useCallback((preset: 7 | 30 | 90, offset: number = 0): string => {
    const endDays = 1 + (offset * preset);
    const startDays = endDays + preset - 1;
    const currentDSL = graphStore?.getState().currentDSL || '';
    const mode = inferDateModeFromDSL(currentDSL);
    return `${mode}(-${startDays}d:-${endDays}d)`;
  }, []);
  
  return {
    bulkCreateModal,
    closeBulkCreateModal,
    openBulkCreateForContext,
    createScenariosForContext,
    createWindowScenario,
    createMultipleWindowScenarios,
    getWindowDSLForPreset
  };
}
