import { useCallback } from 'react';

import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { useTabContext } from '../contexts/TabContext';
import { formatScenarioParamPacksForClipboard } from '../services/scenarioParamPacksClipboardExport';
import { getComposedParamsForLayer } from '../services/CompositionService';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { LIVE_EMPTY_DIFF_DSL } from '../services/scenarioRegenerationService';

export function useCopyAllScenarioParamPacks(tabId?: string) {
  const scenariosContext = useScenariosContextOptional();
  const { operations, tabs } = useTabContext();
  const graphStore = useGraphStore();

  const copyAllScenarioParamPacks = useCallback(async (): Promise<
    | { ok: true; scenarioCount: number; totalScenarioCount: number; byteLength: number }
    | { ok: false; reason: 'no-tab' | 'no-context' | 'clipboard-failed' }
  > => {
    if (!tabId) return { ok: false, reason: 'no-tab' };
    if (!scenariosContext) return { ok: false, reason: 'no-context' };

    const tab = tabs.find((t) => t.id === tabId);
    const fileId = tab?.fileId;
    const scenarioState = operations.getScenarioState(tabId);
    const visibleLayerIds = scenarioState?.visibleScenarioIds ?? [];
    const currentDSL = graphStore?.getState?.()?.currentDSL || tab?.fileData?.currentQueryDSL || '';

    // Export ALL visible layers (including 'base'/'current' if visible), in the tab's visible order.
    const layers = visibleLayerIds
      .map((layerId) => {
        if (layerId === 'base') {
          return {
            id: 'base',
            name: 'Base',
            colour: scenariosContext.baseColour,
            kind: 'base' as const,
            queryDSL: scenariosContext.baseDSL || '',
            effectiveDSL: scenariosContext.baseDSL || '',
            params: scenariosContext.baseParams,
          };
        }
        if (layerId === 'current') {
          return {
            id: 'current',
            name: 'Current',
            colour: scenariosContext.currentColour,
            kind: 'current' as const,
            queryDSL: currentDSL || '',
            effectiveDSL: currentDSL || '',
            params: scenariosContext.currentParams,
          };
        }

        const scenario = scenariosContext.scenarios.find((s) => s.id === layerId);
        if (!scenario) return null;
        const meta: any = scenario.meta;
        const requestedDSL =
          meta?.queryDSL === LIVE_EMPTY_DIFF_DSL ? '' : (typeof meta?.queryDSL === 'string' ? meta.queryDSL : '');
        const effectiveDSL =
          meta?.lastEffectiveDSL === LIVE_EMPTY_DIFF_DSL ? '' : (typeof meta?.lastEffectiveDSL === 'string' ? meta.lastEffectiveDSL : '');

        // Export a fully materialised param pack for this scenario layer, using the same composition logic.
        const composedParams = getComposedParamsForLayer(
          scenario.id,
          scenariosContext.baseParams,
          scenariosContext.currentParams,
          scenariosContext.scenarios,
          visibleLayerIds
        );

        return {
          id: scenario.id,
          name: scenario.name,
          colour: scenario.colour,
          kind: 'scenario' as const,
          queryDSL: requestedDSL || undefined,
          effectiveDSL: effectiveDSL || requestedDSL || undefined,
          params: composedParams,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const { text, byteLength, scenarioCount } = formatScenarioParamPacksForClipboard({
      layers,
      baseDSL: scenariosContext.baseDSL,
      currentDSL,
      fileId,
      tabId,
    });

    try {
      await navigator.clipboard.writeText(text);
      // totalScenarioCount excludes special layers; this is just for "orphan smell".
      return { ok: true, scenarioCount, totalScenarioCount: scenariosContext.scenarios.length, byteLength };
    } catch (e) {
      console.error('Failed to write scenario export to clipboard:', e);
      return { ok: false, reason: 'clipboard-failed' };
    }
  }, [tabId, scenariosContext, operations, tabs, graphStore]);

  return { copyAllScenarioParamPacks };
}


