/**
 * captureTabScenariosService
 *
 * Centralised helper for serialising tab scenario state into a ChartRecipeCore-compatible
 * `scenarios` array (with `effective_dsl`, `is_live`, `name`, `colour`, `visibility_mode`).
 *
 * Used by:
 *  - PropertiesPanel Data Source toggle (Live -> Custom)
 *  - CanvasAnalysisContextMenu "Switch to Custom scenarios"
 *
 * The resulting array is suitable for persisting in `CanvasAnalysis.recipe.scenarios`.
 */

import type { ChartRecipeScenario } from '../types/chartRecipe';

interface TabOperationsSubset {
  getScenarioState: (tabId: string) => any;
  getScenarioVisibilityMode: (tabId: string, scenarioId: string) => 'f+e' | 'f' | 'e';
}

interface ScenariosContextSubset {
  scenarios: Array<{
    id: string;
    name?: string;
    colour?: string;
    meta?: {
      isLive?: boolean;
      queryDSL?: string;
      lastEffectiveDSL?: string;
    };
  }>;
  currentColour?: string;
  baseColour?: string;
  baseDSL?: string;
}

interface CaptureTabScenariosArgs {
  tabId: string;
  currentDSL: string;
  operations: TabOperationsSubset;
  scenariosContext: ScenariosContextSubset;
  whatIfDSL?: string | null;
}

interface CaptureResult {
  scenarios: ChartRecipeScenario[];
  what_if_dsl?: string;
}

export function captureTabScenariosToRecipe(args: CaptureTabScenariosArgs): CaptureResult {
  const { tabId, currentDSL, operations, scenariosContext, whatIfDSL } = args;
  const scenarioState = operations.getScenarioState(tabId);
  const visibleIds: string[] = scenarioState?.visibleScenarioIds || ['current'];

  const scenarios: ChartRecipeScenario[] = visibleIds.map((sid) => {
    const visibilityMode = operations.getScenarioVisibilityMode(tabId, sid);

    if (sid === 'current') {
      return {
        scenario_id: 'current',
        name: 'Current',
        colour: scenariosContext.currentColour || '#3b82f6',
        visibility_mode: visibilityMode,
        effective_dsl: currentDSL || undefined,
        is_live: true,
      };
    }

    if (sid === 'base') {
      const baseDsl = scenariosContext.baseDSL;
      return {
        scenario_id: 'base',
        name: 'Base',
        colour: scenariosContext.baseColour || '#6b7280',
        visibility_mode: visibilityMode,
        effective_dsl: baseDsl || undefined,
        is_live: true,
      };
    }

    const sc = scenariosContext.scenarios.find((s) => s.id === sid);
    const isLive = Boolean(sc?.meta?.isLive);
    const effectiveDsl = sc?.meta?.lastEffectiveDSL || sc?.meta?.queryDSL || undefined;

    return {
      scenario_id: sid,
      name: sc?.name || sid,
      colour: sc?.colour || '#808080',
      visibility_mode: visibilityMode,
      effective_dsl: typeof effectiveDsl === 'string' && effectiveDsl.trim() ? effectiveDsl.trim() : undefined,
      is_live: isLive,
    };
  });

  return {
    scenarios,
    what_if_dsl: typeof whatIfDSL === 'string' && whatIfDSL.trim() ? whatIfDSL.trim() : undefined,
  };
}
