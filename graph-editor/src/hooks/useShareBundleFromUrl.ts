import { useCallback, useEffect, useMemo, useRef } from 'react';
import toast from 'react-hot-toast';

import { decodeSharePayloadFromUrl, stableShortHash, type SharePayloadV1 } from '../lib/sharePayload';
import { useShareModeOptional } from '../contexts/ShareModeContext';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { useTabContext } from '../contexts/TabContext';
import { chartOperationsService } from '../services/chartOperationsService';
import { graphComputeClient } from '../lib/graphComputeClient';
import { buildGraphForAnalysisLayer } from '../services/CompositionService';

/**
 * Share-live: multi-tab bundle boot.
 *
 * Responsibilities:
 * - Ensure live scenarios exist (rehydrated from DSL + colours)
 * - Regenerate scenarios before analysis
 * - Open graph/chart tabs described by the bundle
 *
 * IMPORTANT:
 * - This runs in share-live mode where the graph + deps were already seeded into FileRegistry/IDB
 *   by TabContext live boot.
 */
export function useShareBundleFromUrl(args: { graphFileId: string }): void {
  const { graphFileId } = args;
  const shareMode = useShareModeOptional();
  const scenariosContext = useScenariosContextOptional();
  const { operations } = useTabContext();

  const payload = useMemo(() => decodeSharePayloadFromUrl(), []);
  const processedRef = useRef(false);

  const isEligible =
    Boolean(payload && (payload as any).target === 'bundle') &&
    Boolean(shareMode?.isLiveMode) &&
    Boolean(shareMode?.identity.repo && shareMode?.identity.branch && shareMode?.identity.graph);

  const ensureScenarios = useCallback(async () => {
    if (!scenariosContext || !payload || (payload as any).target !== 'bundle') return [];

    const defs = (payload as any).scenarios?.items || [];
    const existingByDsl = new Map<string, any>();
    for (const s of scenariosContext.scenarios || []) {
      const dsl = s?.meta?.queryDSL;
      if (dsl) existingByDsl.set(dsl, s);
    }

    const created: Array<{ id: string; dsl: string; scenario?: any }> = [];
    for (const def of defs) {
      const dsl = def.dsl;
      if (!dsl || !dsl.trim()) continue;
      const existing = existingByDsl.get(dsl);
      if (existing) {
        created.push({ id: existing.id, dsl, scenario: existing });
        continue;
      }
      const scenario = await scenariosContext.createLiveScenario(dsl, def.name, undefined, def.colour);
      created.push({ id: scenario.id, dsl, scenario });
    }

    // Regenerate deterministically (avoid stale closure issues).
    const liveIds = created.map(c => c.id);
    const allScenariosOverride = created.map(c => c.scenario).filter(Boolean);
    for (const c of created) {
      await scenariosContext.regenerateScenario(c.id, c.scenario, undefined, allScenariosOverride, liveIds);
    }

    return created;
  }, [payload, scenariosContext]);

  const openBundle = useCallback(
    async (created: Array<{ id: string; dsl: string }>) => {
      if (!payload || (payload as any).target !== 'bundle') return;
      if (!scenariosContext?.graph) return;

      const scenarioIdsByDsl = created;

      const tabs = (payload as any).tabs || [];
      const presentation = (payload as any).presentation || {};
      const dashboardMode = Boolean(presentation.dashboardMode);
      void dashboardMode; // presentation is mostly handled by URL param; we still respect activeTabIndex.
      const activeTabIndex = typeof presentation.activeTabIndex === 'number' ? presentation.activeTabIndex : 0;

      // Helper: map ordered DSLs to scenario IDs.
      const orderedScenarioIds = ((payload as any).scenarios?.items || [])
        .map((i: any) => scenarioIdsByDsl.find(s => s.dsl === i.dsl)?.id)
        .filter((id: any) => Boolean(id));

      const hideCurrent = Boolean((payload as any).scenarios?.hide_current);
      const visibleScenarioIds = hideCurrent ? [...orderedScenarioIds] : ['current', ...orderedScenarioIds];

      let activeTabId: string | null = null;

      for (let i = 0; i < tabs.length; i++) {
        const t = tabs[i];
        if (t.type === 'graph') {
          // Create a visible graph tab for the seeded graph file.
          const tabId = `tab-${graphFileId}-interactive-${Date.now()}-${i}`;
          window.dispatchEvent(
            new CustomEvent('dagnet:openTemporaryTab', {
              detail: {
                tab: {
                  id: tabId,
                  fileId: graphFileId,
                  title: t.title || shareMode?.identity.graph || 'Graph',
                  viewMode: 'interactive',
                  group: 'main-content',
                  closable: true,
                  icon: '📊',
                  editorState: {
                    scenarioState: {
                      scenarioOrder: ['current', ...orderedScenarioIds],
                      visibleScenarioIds,
                      visibleColourOrderIds: visibleScenarioIds,
                      selectedScenarioId: undefined,
                    },
                  },
                },
              },
            })
          );

          // Apply per-scenario visibility modes (best-effort).
          try {
            await operations.setVisibleScenarios(tabId, visibleScenarioIds);
            for (const item of (payload as any).scenarios?.items || []) {
              const id = scenarioIdsByDsl.find(s => s.dsl === item.dsl)?.id;
              if (!id) continue;
              await operations.setScenarioVisibilityMode(tabId, id, item.visibility_mode || 'f+e');
            }
          } catch {
            // best-effort
          }

          if (i === activeTabIndex) activeTabId = tabId;
        } else if (t.type === 'chart') {
          // Compute + materialise a chart artefact, then open a chart tab.
          const chartRecipeHash = stableShortHash(JSON.stringify(t));
          const chartFileId = `chart-share-${chartRecipeHash}`;

          const items = (payload as any).scenarios?.items || [];
          const orderedScenarioIds2 = items
            .map((it: any) => scenarioIdsByDsl.find(s => s.dsl === it.dsl)?.id)
            .filter((id: any) => Boolean(id));
          const visibleScenarioIds2 = hideCurrent ? [...orderedScenarioIds2] : ['current', ...orderedScenarioIds2];

          const scenarioDslSubtitleById: Record<string, string> = {};
          for (const it of items) {
            const id = scenarioIdsByDsl.find(s => s.dsl === it.dsl)?.id;
            if (!id) continue;
            scenarioDslSubtitleById[id] = (it.subtitle || it.dsl || '').trim();
          }

          const scenarioGraphs = visibleScenarioIds2.map((scenarioId: string) => {
            const visibilityMode = (() => {
              if (scenarioId === 'current' || scenarioId === 'base') return 'f+e' as const;
              const match = items.find((it: any) => scenarioIdsByDsl.find(s => s.id === scenarioId)?.dsl === it.dsl);
              return (match?.visibility_mode as any) || 'f+e';
            })();

            const scenarioGraph = buildGraphForAnalysisLayer(
              scenarioId,
              scenariosContext.graph as any,
              scenariosContext.baseParams,
              scenariosContext.currentParams,
              scenariosContext.scenarios,
              scenarioId === 'current' ? (t.analysis?.what_if_dsl || undefined) : undefined,
              visibilityMode
            );

            const name =
              scenarioId === 'current'
                ? 'Current'
                : scenariosContext.scenarios.find(s => s.id === scenarioId)?.name || scenarioId;
            const colour =
              scenarioId === 'current'
                ? scenariosContext.currentColour
                : scenariosContext.scenarios.find(s => s.id === scenarioId)?.colour;

            return {
              scenario_id: scenarioId,
              name,
              graph: scenarioGraph as any,
              colour,
              visibility_mode: visibilityMode,
            };
          });

          const response = await graphComputeClient.analyzeMultipleScenarios(
            scenarioGraphs as any,
            t.analysis?.query_dsl || undefined,
            t.analysis?.analysis_type || undefined
          );
          if (!response?.success || !response.result) throw new Error(response?.error?.message || 'Analysis failed');

          const analysisResult = response.result;

          const opened = await chartOperationsService.openAnalysisChartTabFromAnalysis({
            chartKind: t.chart.kind,
            analysisResult,
            scenarioIds: visibleScenarioIds2,
            title: t.title || analysisResult.analysis_name || 'Chart',
            source: {
              parent_file_id: graphFileId,
              query_dsl: t.analysis?.query_dsl,
              analysis_type: t.analysis?.analysis_type || undefined,
            },
            scenarioDslSubtitleById,
            fileId: chartFileId,
          });

          if (opened && i === activeTabIndex) activeTabId = opened.tabId;
        }
      }

      if (activeTabId) {
        window.dispatchEvent(new CustomEvent('dagnet:switchToTab', { detail: { tabId: activeTabId } }));
      }
    },
    [payload, scenariosContext, graphFileId, operations, shareMode?.identity.graph]
  );

  const run = useCallback(async () => {
    if (!isEligible || !payload || (payload as any).target !== 'bundle') return;
    if (!scenariosContext?.scenariosReady) return;
    if (!scenariosContext?.graph) return;
    if (processedRef.current) return;

    processedRef.current = true;
    try {
      const created = await ensureScenarios();
      await openBundle(created);
    } catch (e: any) {
      processedRef.current = false;
      toast.error(e?.message || 'Failed to load share bundle');
    }
  }, [isEligible, payload, scenariosContext?.scenariosReady, scenariosContext?.graph, ensureScenarios, openBundle]);

  useEffect(() => {
    void run();
  }, [run]);
}

