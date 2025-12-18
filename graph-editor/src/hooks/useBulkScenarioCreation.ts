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
import { Scenario } from '../types/scenarios';
import { useTabContext } from '../contexts/TabContext';
import { contextRegistry } from '../services/contextRegistry';
import { deriveBaseDSLForRebase, generateSmartLabel } from '../services/scenarioRegenerationService';
import { useGraphStore } from '../contexts/GraphStoreContext';

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

export function useBulkScenarioCreation(): UseBulkScenarioCreationReturn {
  const scenariosContext = useScenariosContextOptional();
  const { activeTabId, operations } = useTabContext();
  const graphStore = useGraphStore();
  const [bulkCreateModal, setBulkCreateModal] = useState<BulkCreateModalState | null>(null);
  
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
    if (!scenariosContext || !activeTabId) {
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
    
    const toastId = toast.loading(`Creating scenarios (0/${valueIds.length})...`);
    const createdScenarios: Scenario[] = [];
    const colours = getAssignedColours(valueIds.length);

    try {
      // PHASE 1: Create all scenarios
      for (let i = 0; i < valueIds.length; i++) {
        toast.loading(`Creating scenarios (${i + 1}/${valueIds.length})...`, { id: toastId });
        
        const queryDSL = `context(${contextKey}:${valueIds[i]})`;
        // We await creation to ensure ID generation doesn't collide if using time-based IDs
        // and to maintain order in the list
        const scenario = await scenariosContext.createLiveScenario(
          queryDSL, 
          undefined, 
          activeTabId, 
          colours[i]
        );
        createdScenarios.push(scenario);
      }

      // PHASE 2: Update Visibility ATOMICALLY
      // Use addVisibleScenarios which uses functional state updates
      // to avoid stale closure issues when called rapidly
      const newScenarioIds = createdScenarios.map(s => s.id);
      await operations.addVisibleScenarios(activeTabId, newScenarioIds);

      // PHASE 3: Regenerate Data
      // We must pass the FULL list of scenarios (existing + created) to ensure proper inheritance
      // because the context state won't have updated yet.
      const existingScenarios = scenariosContext.scenarios || [];
      const allScenarios = [...[...createdScenarios].reverse(), ...existingScenarios]; // Newest first
      
      // Get the visible order from tab state
      const scenarioState = operations.getScenarioState(activeTabId);
      const existingVisibleIds = scenarioState?.visibleScenarioIds || [];
      // New scenarios are added at the front (top of stack)
      const visibleOrder = [...newScenarioIds, ...existingVisibleIds];

      for (let i = 0; i < createdScenarios.length; i++) {
        const scenario = createdScenarios[i]; // Note: iterating original creation order (oldest -> newest in this batch)
        toast.loading(`Fetching data (${i + 1}/${createdScenarios.length})...`, { id: toastId });
        
        await scenariosContext.regenerateScenario(
          scenario.id, 
          scenario, 
          newBaseDSL || undefined,
          allScenarios,
          visibleOrder
        );
      }

      toast.success(`Created ${createdScenarios.length} scenarios`);
      setBulkCreateModal(null);
      return createdScenarios.length;

    } catch (err) {
      console.error('Bulk creation failed:', err);
      toast.error('Failed to complete bulk creation');
      return createdScenarios.length; // Return partial success count
    } finally {
      toast.dismiss(toastId);
    }
  }, [scenariosContext, activeTabId, operations, getAssignedColours]);
  
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
    if (!scenariosContext || !activeTabId) {
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
    
    const toastId = toast.loading(`Creating scenarios (0/${windowDSLs.length})...`);
    const createdScenarios: Scenario[] = [];
    const colours = getAssignedColours(windowDSLs.length);
    
    try {
      // PHASE 1: Create
      for (let i = 0; i < windowDSLs.length; i++) {
        toast.loading(`Creating scenarios (${i + 1}/${windowDSLs.length})...`, { id: toastId });
        
        const scenario = await scenariosContext.createLiveScenario(
          windowDSLs[i], 
          undefined, 
          activeTabId, 
          colours[i]
        );
        createdScenarios.push(scenario);
      }
      
      // PHASE 2: Visibility
      // Use addVisibleScenarios which uses functional state updates
      // to avoid stale closure issues when called rapidly
      const newScenarioIds = createdScenarios.map(s => s.id);
      await operations.addVisibleScenarios(activeTabId, newScenarioIds);
      
      // PHASE 3: Regenerate
      const existingScenarios = scenariosContext.scenarios || [];
      const allScenarios = [...[...createdScenarios].reverse(), ...existingScenarios];
      
      // Get the visible order from tab state
      const scenarioState = operations.getScenarioState(activeTabId);
      const existingVisibleIds = scenarioState?.visibleScenarioIds || [];
      // New scenarios are added at the front (top of stack)
      const visibleOrder = [...newScenarioIds, ...existingVisibleIds];

      for (let i = 0; i < createdScenarios.length; i++) {
        const scenario = createdScenarios[i];
        toast.loading(`Fetching data (${i + 1}/${createdScenarios.length})...`, { id: toastId });
        
        await scenariosContext.regenerateScenario(
          scenario.id, 
          scenario, 
          newBaseDSL || undefined,
          allScenarios,
          visibleOrder
        );
      }
      
      toast.success(`Created ${createdScenarios.length} scenarios`);
      return createdScenarios.length;
      
    } catch (err) {
      console.error('Bulk creation failed:', err);
      toast.error('Failed to create scenarios');
      return createdScenarios.length;
    } finally {
      toast.dismiss(toastId);
    }
  }, [scenariosContext, activeTabId, operations, getAssignedColours]);
  
  const getWindowDSLForPreset = useCallback((preset: 7 | 30 | 90, offset: number = 0): string => {
    const endDays = 1 + (offset * preset);
    const startDays = endDays + preset - 1;
    return `window(-${startDays}d:-${endDays}d)`;
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
