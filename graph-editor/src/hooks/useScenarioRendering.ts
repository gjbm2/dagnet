/**
 * useScenarioRendering Hook
 * 
 * Provides scenario rendering data for the current tab.
 * This hook integrates with ScenariosContext and TabContext to compute
 * which scenarios should be rendered and with what colors.
 */

import { useMemo } from 'react';
import { useScenariosContext, useScenariosContextOptional } from '../contexts/ScenariosContext';
import { useTabContext } from '../contexts/TabContext';
import { Graph } from '../types';
import { ScenarioRenderData, renderScenarios } from '../services/ScenarioRenderer';

interface UseScenarioRenderingResult {
  /** Whether any scenarios are visible for this tab */
  hasVisibleScenarios: boolean;
  
  /** Render data for all visible scenarios */
  scenarioRenderData: ScenarioRenderData[];
  
  /** Whether scenarios feature is enabled */
  isEnabled: boolean;
}

/**
 * Hook to get scenario rendering data for a tab
 * 
 * @param tabId - The tab ID
 * @param graph - The current graph
 * @returns Scenario rendering configuration
 */
export function useScenarioRendering(
  tabId: string | undefined,
  graph: Graph | null
): UseScenarioRenderingResult {
  const scenariosContext = useScenariosContextOptional();
  const { operations } = useTabContext();
  
  const renderData = useMemo(() => {
    // If scenarios context is not available or no tabId, return empty
    if (!scenariosContext || !tabId || !graph) {
      return {
        hasVisibleScenarios: false,
        scenarioRenderData: [],
        isEnabled: false
      };
    }
    
    // Get tab's scenario state
    const scenarioState = operations.getScenarioState(tabId);
    if (!scenarioState) {
      return {
        hasVisibleScenarios: false,
        scenarioRenderData: [],
        isEnabled: true
      };
    }
    
    const { visibleScenarioIds, visibleColorOrderIds } = scenarioState;
    
    // If no visible scenarios, return empty
    if (visibleScenarioIds.length === 0) {
      return {
        hasVisibleScenarios: false,
        scenarioRenderData: [],
        isEnabled: true
      };
    }
    
    // Compute render data for visible scenarios
    const scenarios = scenariosContext.scenarios;
    const baseParams = scenariosContext.baseParams;
    
    const renderDataList = renderScenarios(
      graph,
      baseParams,
      scenarios,
      visibleScenarioIds,
      visibleColorOrderIds
    );
    
    return {
      hasVisibleScenarios: true,
      scenarioRenderData: renderDataList,
      isEnabled: true
    };
  }, [
    scenariosContext,
    tabId,
    graph,
    operations,
    scenariosContext?.scenarios,
    scenariosContext?.baseParams
  ]);
  
  return renderData;
}

