import { useCallback } from 'react';
import toast from 'react-hot-toast';

import { fileRegistry } from '../contexts/TabContext';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { shareLinkService, extractIdentityFromFileSource, resolveShareSecretForLinkGeneration } from '../services/shareLinkService';

export interface UseScenarioShareLinkResult {
  canShareScenario: (scenarioId: string) => boolean;
  copyStaticScenarioShareLink: (scenarioId: string) => Promise<void>;
  copyLiveScenarioShareLink: (scenarioId: string) => Promise<void>;
  liveUnavailableReason?: string;
}

export function useScenarioShareLink(fileId: string, tabId: string | undefined): UseScenarioShareLinkResult {
  const scenariosContext = useScenariosContextOptional();
  void tabId;

  const canShareScenario = useCallback(
    (scenarioId: string) => {
      const s = scenariosContext?.scenarios?.find(x => x.id === scenarioId);
      const dsl = s?.meta?.queryDSL;
      return Boolean(dsl && dsl.trim());
    },
    [scenariosContext]
  );

  const buildScenarioUrl = useCallback(
    async (scenarioId: string, mode: 'static' | 'live') => {
      const scenario = scenariosContext?.scenarios?.find(s => s.id === scenarioId);
      const dsl = scenario?.meta?.queryDSL;
      if (!dsl || !dsl.trim()) {
        throw new Error('Scenario is not a DSL-backed live scenario');
      }

      const graphFile = fileRegistry.getFile(fileId);
      const graphData = graphFile?.data;
      if (!graphData) {
        throw new Error('Graph data not available');
      }

      const identity = extractIdentityFromFileSource(graphFile?.source);

      if (mode === 'static') {
        const url = new URL(
          shareLinkService.buildStaticShareUrl({
            graphData,
            identity,
            dashboardMode: true,
          })
        );
        url.searchParams.set('scenarios', dsl);
        url.searchParams.set('hidecurrent', '');
        url.searchParams.set('selectedscenario', dsl);
        return url.toString();
      }

      // Live mode
      if (!identity?.repo || !identity.branch || !identity.graph) {
        throw new Error('Live mode requires repo/branch/graph identity');
      }

      const secret = resolveShareSecretForLinkGeneration();
      if (!secret) {
        throw new Error('No share secret available (set SHARE_SECRET or open with ?secret=…)');
      }

      const url = new URL(
        shareLinkService.buildLiveShareUrl({
          repo: identity.repo,
          branch: identity.branch,
          graph: identity.graph,
          secret,
          dashboardMode: true,
        })
      );
      url.searchParams.set('scenarios', dsl);
      url.searchParams.set('hidecurrent', '');
      url.searchParams.set('selectedscenario', dsl);
      return url.toString();
    },
    [scenariosContext, fileId]
  );

  const copyStaticScenarioShareLink = useCallback(
    async (scenarioId: string) => {
      try {
        const url = await buildScenarioUrl(scenarioId, 'static');
        await navigator.clipboard.writeText(url);
        toast.success('Scenario share link copied!');
      } catch (e: any) {
        toast.error(e?.message || 'Failed to copy scenario share link');
      }
    },
    [buildScenarioUrl]
  );

  const copyLiveScenarioShareLink = useCallback(
    async (scenarioId: string) => {
      try {
        const url = await buildScenarioUrl(scenarioId, 'live');
        await navigator.clipboard.writeText(url);
        toast.success('Live scenario share link copied!');
      } catch (e: any) {
        toast.error(e?.message || 'Failed to copy live scenario share link');
      }
    },
    [buildScenarioUrl]
  );

  return {
    canShareScenario,
    copyStaticScenarioShareLink,
    copyLiveScenarioShareLink,
    liveUnavailableReason: undefined,
  };
}

