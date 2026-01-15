import { useCallback, useEffect, useMemo, useRef } from 'react';
import toast from 'react-hot-toast';

import { decodeSharePayloadFromUrl, stableShortHash, type SharePayloadV1 } from '../lib/sharePayload';
import { useShareModeOptional } from '../contexts/ShareModeContext';
import { useScenariosContextOptional } from '../contexts/ScenariosContext';
import { useTabContext } from '../contexts/TabContext';
import { chartOperationsService } from '../services/chartOperationsService';
import { graphComputeClient } from '../lib/graphComputeClient';
import { buildGraphForAnalysisLayer } from '../services/CompositionService';
import { db } from '../db/appDatabase';

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
    const existing = Array.isArray(scenariosContext.scenarios) ? scenariosContext.scenarios : [];
    const usedScenarioIds = new Set<string>();

    const created: Array<{ idx: number; id: string; dsl: string; scenario?: any }> = [];
    for (let idx = 0; idx < defs.length; idx++) {
      const def = defs[idx];
      const dsl = def?.dsl;
      if (!dsl || !dsl.trim()) continue;

      // IMPORTANT: scenarios are NOT guaranteed unique by DSL (users can duplicate).
      // Match existing by (dsl, name, colour) when possible, and never re-use the same scenario id twice.
      const wantName = typeof def?.name === 'string' ? def.name : undefined;
      const wantColour = typeof def?.colour === 'string' ? def.colour : undefined;
      const match = existing.find(s => {
        if (!s?.id || usedScenarioIds.has(s.id)) return false;
        if ((s as any)?.meta?.queryDSL !== dsl) return false;
        if (wantName && s?.name !== wantName) return false;
        if (wantColour && s?.colour !== wantColour) return false;
        return true;
      });

      if (match) {
        usedScenarioIds.add(match.id);
        created.push({ idx, id: match.id, dsl, scenario: match });
        continue;
      }

      const scenario = await scenariosContext.createLiveScenario(dsl, wantName, undefined, wantColour);
      usedScenarioIds.add(scenario.id);
      created.push({ idx, id: scenario.id, dsl, scenario });
    }

    // Regenerate deterministically (avoid stale closure issues).
    const liveIds = created.map(c => c.id);
    const allScenariosOverride = created.map(c => c.scenario).filter(Boolean);
    for (const c of created) {
      await scenariosContext.regenerateScenario(c.id, c.scenario, undefined, allScenariosOverride, liveIds);
    }

    // CRITICAL: Persist scenarios synchronously before opening tabs.
    // GraphEditor mounts its own ScenariosProvider per tab; it loads once from IndexedDB and does NOT
    // subscribe to external changes. If we rely on ScenariosContext's async save effect, GraphEditor can
    // mount first and "miss" the scenarios forever (leading to empty layers in exports / missing colours).
    try {
      const toPersist = created
        .map(c => c.scenario)
        .filter(Boolean)
        .map((s: any) => ({ ...s, fileId: graphFileId }));
      if (toPersist.length > 0) {
        await db.scenarios.bulkPut(toPersist as any);
      }
    } catch (e) {
      console.warn('useShareBundleFromUrl: failed to persist scenarios before tab open', e);
      // best-effort: boot can still proceed, but GraphEditor may miss scenario state.
    }

    return created;
  }, [payload, scenariosContext, graphFileId]);

  const openBundle = useCallback(
    async (created: Array<{ idx: number; id: string; dsl: string; scenario?: any }>) => {
      if (!payload || (payload as any).target !== 'bundle') return;
      if (!scenariosContext?.graph) return;

      const items = (payload as any).scenarios?.items || [];

      // IMPORTANT:
      // When scenarios are just created, React state may not yet reflect them in scenariosContext.scenarios.
      // Use the passed-in created scenarios as the authoritative source for display metadata.
      const scenarioOverrideById = new Map<string, any>();
      for (const s of created as any[]) {
        if (s?.id && s?.scenario) scenarioOverrideById.set(s.id, s.scenario);
      }
      const createdByIdx = new Map<number, { id: string; scenario?: any }>(created.map(c => [c.idx, { id: c.id, scenario: c.scenario }]));
      const itemIdxByScenarioId = new Map<string, number>();
      for (const [idx, v] of createdByIdx.entries()) itemIdxByScenarioId.set(v.id, idx);

      const tabs = (payload as any).tabs || [];
      const presentation = (payload as any).presentation || {};
      const dashboardMode = Boolean(presentation.dashboardMode);
      void dashboardMode; // presentation is mostly handled by URL param; we still respect activeTabIndex.
      const activeTabIndex = typeof presentation.activeTabIndex === 'number' ? presentation.activeTabIndex : 0;

      // Helper: map scenario items by index (supports duplicate DSLs).
      const orderedScenarioIds = items
        .map((_i: any, idx: number) => createdByIdx.get(idx)?.id)
        .filter((id: any) => Boolean(id));

      const hideCurrent = Boolean((payload as any).scenarios?.hide_current);
      // IMPORTANT: analysis + scenario view state require at least one scenario.
      // If hide_current is true but we have no scenario items (or mapping failed), fall back to Current.
      const visibleScenarioIds = (() => {
        const base = hideCurrent ? [...orderedScenarioIds] : ['current', ...orderedScenarioIds];
        return base.length > 0 ? base : ['current'];
      })();

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
            for (let idx = 0; idx < items.length; idx++) {
              const item = items[idx];
              const id = createdByIdx.get(idx)?.id;
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

          const orderedScenarioIds2 = items
            .map((_it: any, idx: number) => createdByIdx.get(idx)?.id)
            .filter((id: any) => Boolean(id));
          const visibleScenarioIds2 = (() => {
            const base = hideCurrent ? [...orderedScenarioIds2] : ['current', ...orderedScenarioIds2];
            return base.length > 0 ? base : ['current'];
          })();

          const scenarioDslSubtitleById: Record<string, string> = {};
          for (let idx = 0; idx < items.length; idx++) {
            const it = items[idx];
            const id = createdByIdx.get(idx)?.id;
            if (!id) continue;
            scenarioDslSubtitleById[id] = (it.subtitle || it.dsl || '').trim();
          }

          const scenarioGraphs = visibleScenarioIds2.map((scenarioId: string) => {
            const visibilityMode = (() => {
              if (scenarioId === 'current' || scenarioId === 'base') return 'f+e' as const;
              const idx = itemIdxByScenarioId.get(scenarioId);
              const def = typeof idx === 'number' ? items[idx] : null;
              return (def?.visibility_mode as any) || 'f+e';
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

            const name = (() => {
              if (scenarioId === 'current') return 'Current';
              const idx = itemIdxByScenarioId.get(scenarioId);
              const def = typeof idx === 'number' ? items[idx] : null;
              const override = scenarioOverrideById.get(scenarioId);
              const fromState = scenariosContext.scenarios.find(s => s.id === scenarioId);
              return def?.name || override?.name || fromState?.name || scenarioId;
            })();

            const colour = (() => {
              if (scenarioId === 'current') return scenariosContext.currentColour;
              const idx = itemIdxByScenarioId.get(scenarioId);
              const def = typeof idx === 'number' ? items[idx] : null;
              const override = scenarioOverrideById.get(scenarioId);
              const fromState = scenariosContext.scenarios.find(s => s.id === scenarioId);
              return def?.colour || override?.colour || fromState?.colour;
            })();

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
      toast.error(e?.message || 'Failed to load share bundle');
    }
  }, [isEligible, payload, scenariosContext?.scenariosReady, scenariosContext?.graph, ensureScenarios, openBundle]);

  useEffect(() => {
    void run();
  }, [run]);
}

