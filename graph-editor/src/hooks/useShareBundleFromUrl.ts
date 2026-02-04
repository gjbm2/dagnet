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
import { waitForLiveShareGraphDeps } from '../services/liveShareHydrationService';
import { useGraphStoreOptional } from '../contexts/GraphStoreContext';
import { fetchDataService } from '../services/fetchDataService';
import { fetchOrchestratorService } from '../services/fetchOrchestratorService';
import { sessionLogService } from '../services/sessionLogService';

async function waitForTabContextInitDone(timeoutMs: number = 10_000): Promise<void> {
  try {
    if ((window as any).__dagnetTabContextInitDone) return;
  } catch {
    // ignore
  }

  await new Promise<void>((resolve, reject) => {
    let done = false;
    const onDone = () => {
      if (done) return;
      done = true;
      window.removeEventListener('dagnet:tabContextInitDone', onDone as any);
      resolve();
    };
    const t = window.setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener('dagnet:tabContextInitDone', onDone as any);
      reject(new Error('Timed out waiting for TabContext init'));
    }, timeoutMs);

    window.addEventListener('dagnet:tabContextInitDone', onDone as any);

    // If init completes between the initial check and addEventListener, resolve immediately.
    try {
      if ((window as any).__dagnetTabContextInitDone) {
        window.clearTimeout(t);
        onDone();
      }
    } catch {
      // ignore
    }
  });
}

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
  const graphStore = useGraphStoreOptional();

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

      const idOverride = typeof (def as any)?.id === 'string' ? String((def as any).id) : undefined;
      const scenario = await scenariosContext.createLiveScenario(dsl, wantName, undefined, wantColour, idOverride);
      usedScenarioIds.add(scenario.id);
      created.push({ idx, id: scenario.id, dsl, scenario });
    }

    // Regenerate deterministically (avoid stale closure issues).
    const liveIds = created.map(c => c.id);
    const allScenariosOverride = created.map(c => c.scenario).filter(Boolean);
    for (const c of created) {
      await scenariosContext.regenerateScenario(c.id, c.scenario, undefined, allScenariosOverride, liveIds, {
        skipStage2: false,
        allowFetchFromSource: false,
      });
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

      // IMPORTANT: bundle boot uses a window event to open tabs. TabContext installs the listener in a mount effect,
      // so we must wait for that signal; otherwise the event can be dropped and the share page boots with zero tabs.
      await waitForTabContextInitDone();

      const items = (payload as any).scenarios?.items || [];

      // IMPORTANT:
      // When scenarios are just created, React state may not yet reflect them in scenariosContext.scenarios.
      // Use the passed-in created scenarios as the authoritative source for display metadata.
      const scenarioOverrideById = new Map<string, any>();
      for (const s of created as any[]) {
        if (s?.id && s?.scenario) scenarioOverrideById.set(s.id, s.scenario);
      }
      const scenariosForLayer = (() => {
        const base = Array.isArray(scenariosContext.scenarios) ? scenariosContext.scenarios : [];
        const mapped = base.map(s => scenarioOverrideById.get(s.id) ?? s);
        for (const [id, s] of scenarioOverrideById.entries()) {
          if (!mapped.some((x: any) => x?.id === id)) mapped.push(s);
        }
        return mapped;
      })();
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

      // Bundle linkage: if the shared bundle includes a graph tab, charts must be linked to the
      // corresponding graph tab context (tab-scoped scenario state).
      //
      // IMPORTANT:
      // - Tabs are created in share-mode IndexedDB with fresh ids. Authoring tab ids are not valid here.
      // - We must therefore create graph tab(s) first, then materialise charts with source.parent_tab_id
      //   pointing at the newly created graph tab id.
      const graphTabIdsByIndex = new Map<number, string>();

      let activeTabId: string | null = null;

      // Pass 1: open graph tabs first so chart tabs can link to them deterministically.
      for (let i = 0; i < tabs.length; i++) {
        const t = tabs[i];
        if (t.type !== 'graph') continue;
          // Create a visible graph tab for the seeded graph file.
          const tabId = `tab-share-${stableShortHash(JSON.stringify(payload))}-${graphFileId}-graph-${i}`;
          graphTabIdsByIndex.set(i, tabId);
          await operations.openTemporaryTab({
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
          } as any);

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
      }

      const primaryGraphTabId = (() => {
        for (let i = 0; i < tabs.length; i++) {
          if (tabs[i]?.type !== 'graph') continue;
          const id = graphTabIdsByIndex.get(i);
          if (id) return id;
        }
        return null;
      })();

      // Pass 2: open charts (linked when graph tab exists).
      for (let i = 0; i < tabs.length; i++) {
        const t = tabs[i];
        if (t.type !== 'chart') continue;
          // Compute + materialise a chart artefact, then open a chart tab.
          const chartRecipeHash = stableShortHash(JSON.stringify(t));
          const chartFileId = `chart-share-${chartRecipeHash}`;

          const orderedScenarioIds2 = items
            .map((_it: any, idx: number) => createdByIdx.get(idx)?.id)
            .filter((id: any) => Boolean(id));
          const visibleScenarioIds2 = (() => {
            // Ordering rule:
            // - Only "bridge_view" analysis uses the special "Current last" ordering.
            // - This ordering is part of the chart semantics, not the graph tab scenario list ordering.
            //
            // IMPORTANT:
            // Do NOT infer bridge semantics from chart kind alone (bundle tabs can request graph_overview
            // with an analysis_bridge renderer).
            const isBridge = t.analysis?.analysis_type === 'bridge_view';
            if (isBridge) {
              const base = hideCurrent ? [...orderedScenarioIds2] : [...orderedScenarioIds2, 'current'];
              return base.length > 0 ? base : ['current'];
            }
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
          const currentDslFromPayload = (payload as any)?.graph_state?.current_query_dsl;
          if (typeof currentDslFromPayload === 'string' && currentDslFromPayload.trim()) {
            scenarioDslSubtitleById['current'] = currentDslFromPayload.trim();
          }

          // Ensure Current is hydrated for the requested Current DSL before computing chart tabs.
          try {
            const currentDsl =
              (typeof currentDslFromPayload === 'string' && currentDslFromPayload.trim())
                ? currentDslFromPayload.trim()
                : (typeof (scenariosContext.graph as any)?.currentQueryDSL === 'string' ? String((scenariosContext.graph as any).currentQueryDSL) : '');
            if (graphStore && currentDsl && currentDsl.trim()) {
              // Unified cache-only pipeline: build plan (for observability) + from-file refresh (Stage‑2 enabled).
              const opId = sessionLogService.startOperation(
                'info',
                'data-fetch',
                'LIVE_SHARE_CURRENT_HYDRATE',
                'Live share: hydrate Current from file cache',
                { currentDsl }
              );
              try {
                const g0 = graphStore.getState().graph as any;
                if (g0) {
                  // Skip signature computation as contexts may not be seeded yet during share boot.
                  await fetchOrchestratorService.buildPlan({ graph: g0, dsl: currentDsl, parentLogId: opId, skipSignatureComputation: true });
                  await fetchOrchestratorService.refreshFromFilesWithRetries({
                    graphGetter: () => (graphStore.getState().graph as any) || null,
                    setGraph: (g) => graphStore.getState().setGraph(g as any),
                    dsl: currentDsl,
                    skipStage2: false,
                    parentLogId: opId,
                    attempts: 6,
                    delayMs: 75,
                  });
                }
                sessionLogService.endOperation(opId, 'success', 'Current hydrated from file cache');
              } catch (e: any) {
                sessionLogService.endOperation(opId, 'warning', e?.message || String(e));
              }
            }
          } catch {
            // best-effort
          }

          const scenarioGraphs = visibleScenarioIds2.map((scenarioId: string) => {
            const visibilityMode = (() => {
              if (scenarioId === 'base') return 'f+e' as const;
              if (scenarioId === 'current') {
                const cur = (payload as any)?.scenarios?.current;
                return (cur?.visibility_mode as any) || 'f+e';
              }
              const idx = itemIdxByScenarioId.get(scenarioId);
              const def = typeof idx === 'number' ? items[idx] : null;
              return (def?.visibility_mode as any) || 'f+e';
            })();

            const scenarioGraph = buildGraphForAnalysisLayer(
              scenarioId,
              (() => {
                const base0 = ((graphStore?.getState().graph as any) || scenariosContext.graph) as any;
                try {
                  const cloned = JSON.parse(JSON.stringify(base0 || null));
                  const gs: any = (payload as any)?.graph_state || null;
                  if (cloned && gs) {
                    if (typeof gs.base_dsl === 'string' && gs.base_dsl.trim()) cloned.baseDSL = gs.base_dsl.trim();
                    if (typeof gs.current_query_dsl === 'string' && gs.current_query_dsl.trim()) cloned.currentQueryDSL = gs.current_query_dsl.trim();
                  }
                  return cloned || base0;
                } catch {
                  return base0;
                }
              })(),
              scenariosContext.baseParams,
              scenariosContext.currentParams,
            scenariosForLayer as any,
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
              if (scenarioId === 'current') {
                const cur = (payload as any)?.scenarios?.current;
                return cur?.colour || scenariosContext.currentColour;
              }
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
              parent_tab_id: primaryGraphTabId || undefined,
              query_dsl: t.analysis?.query_dsl,
              analysis_type: t.analysis?.analysis_type || undefined,
            },
            scenarioDslSubtitleById,
            hideCurrent,
            whatIfDsl: t.analysis?.what_if_dsl || undefined,
            fileId: chartFileId,
          });

          if (opened && i === activeTabIndex) activeTabId = opened.tabId;
      }

      if (activeTabId) operations.switchTab(activeTabId);
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
      // Deterministic barrier: ensure all dependent files are present in IndexedDB and hydrated
      // into FileRegistry BEFORE scenario regeneration / analysis / tab materialisation.
      const identity = shareMode?.identity;
      if (identity?.repo && identity?.branch) {
        const depRes = await waitForLiveShareGraphDeps({
          graph: scenariosContext.graph as any,
          identity: { repo: identity.repo, branch: identity.branch },
        });
        if (!depRes.success) {
          throw new Error(`Live share cache not ready (missing ${depRes.missing.length} file(s))`);
        }
      }

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

