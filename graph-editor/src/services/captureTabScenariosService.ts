/**
 * captureTabScenariosService
 *
 * Centralised helper for serialising tab scenario state into a ChartRecipeCore-compatible
 * `scenarios` array (with `effective_dsl`, `is_live`, `name`, `colour`, `visibility_mode`,
 * and composed `params` for graph parameter overrides).
 *
 * Used by:
 *  - PropertiesPanel Data Source toggle (Live -> Custom)
 *  - CanvasAnalysisContextMenu "Switch to Custom scenarios"
 *
 * The resulting array is suitable for persisting in `CanvasAnalysis.recipe.scenarios`.
 */

import type { ChartRecipeScenario } from '../types/chartRecipe';
import { getComposedParamsForLayer } from './CompositionService';
import type { ScenarioParams } from '../types/scenarios';

interface TabOperationsSubset {
  getScenarioState: (tabId: string) => any;
  getScenarioVisibilityMode: (tabId: string, scenarioId: string) => 'f+e' | 'f' | 'e';
}

interface ScenariosContextSubset {
  scenarios: Array<{
    id: string;
    name?: string;
    colour?: string;
    params: Record<string, any>;
    meta?: {
      isLive?: boolean;
      queryDSL?: string;
      lastEffectiveDSL?: string;
    };
  }>;
  currentColour?: string;
  baseColour?: string;
  baseDSL?: string;
  baseParams?: ScenarioParams;
  currentParams?: ScenarioParams;
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

/**
 * Derive the ordered list of visible scenario IDs from tab state, using
 * scenarioOrder (reversed = composition order, bottom-to-top) so the captured
 * recipe preserves the same ordering as the chart and panel displays.
 */
function deriveOrderedVisibleIds(scenarioState: any): string[] {
  const visibleSet = new Set<string>(scenarioState?.visibleScenarioIds || ['current']);
  const order: string[] = scenarioState?.scenarioOrder || [];
  const orderSet = new Set(order);
  const userItems = [...order]
    .reverse()
    .filter(id => id !== 'current' && id !== 'base' && visibleSet.has(id));
  // Include visible user scenarios not tracked in scenarioOrder (defensive).
  const extraVisible = [...visibleSet]
    .filter(id => id !== 'current' && id !== 'base' && !orderSet.has(id));
  const result: string[] = [];
  if (visibleSet.has('base')) result.push('base');
  result.push(...userItems, ...extraVisible);
  if (visibleSet.has('current')) result.push('current');
  return result.length > 0 ? result : ['current'];
}

export function captureTabScenariosToRecipe(args: CaptureTabScenariosArgs): CaptureResult {
  const { tabId, currentDSL, operations, scenariosContext, whatIfDSL } = args;
  const scenarioState = operations.getScenarioState(tabId);
  const visibleIds = deriveOrderedVisibleIds(scenarioState);

  const scenarios: ChartRecipeScenario[] = visibleIds.map((sid) => {
    const visibilityMode = operations.getScenarioVisibilityMode(tabId, sid);

    if (sid === 'current') {
      // Current layer: composed params = currentParams (already includes base + what-if)
      const params = scenariosContext.currentParams;
      return {
        scenario_id: 'current',
        name: 'Current',
        colour: scenariosContext.currentColour || '#3b82f6',
        visibility_mode: visibilityMode,
        effective_dsl: currentDSL || undefined,
        is_live: true,
        ...(params && Object.keys(params).length > 0 ? { params } : {}),
      };
    }

    if (sid === 'base') {
      const baseDsl = scenariosContext.baseDSL;
      const params = scenariosContext.baseParams;
      return {
        scenario_id: 'base',
        name: 'Base',
        colour: scenariosContext.baseColour || '#6b7280',
        visibility_mode: visibilityMode,
        effective_dsl: baseDsl || undefined,
        is_live: true,
        ...(params && Object.keys(params).length > 0 ? { params } : {}),
      };
    }

    const sc = scenariosContext.scenarios.find((s) => s.id === sid);
    const isLive = Boolean(sc?.meta?.isLive);
    const effectiveDsl = sc?.meta?.lastEffectiveDSL || sc?.meta?.queryDSL || undefined;

    // Compose graph parameter overrides for this layer so Custom mode
    // can reproduce the same graph as Live mode.
    // Pass [] to force independent (non-cumulative) composition, matching
    // buildGraphForAnalysisLayer's behaviour in Live mode.
    let composedParams: ScenarioParams | undefined;
    if (scenariosContext.baseParams) {
      composedParams = getComposedParamsForLayer(
        sid,
        scenariosContext.baseParams,
        scenariosContext.currentParams || {},
        scenariosContext.scenarios as any,
        [],
      );
    }

    return {
      scenario_id: sid,
      name: sc?.name || sid,
      colour: sc?.colour || '#808080',
      visibility_mode: visibilityMode,
      effective_dsl: typeof effectiveDsl === 'string' && effectiveDsl.trim() ? effectiveDsl.trim() : undefined,
      is_live: isLive,
      ...(composedParams && (composedParams.edges || composedParams.nodes) ? { params: composedParams } : {}),
    };
  });

  return {
    scenarios,
    what_if_dsl: typeof whatIfDSL === 'string' && whatIfDSL.trim() ? whatIfDSL.trim() : undefined,
  };
}
