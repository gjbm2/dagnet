/**
 * Share Link Service
 * 
 * Centralised service for building share URLs (static and live).
 * All share URL generation should go through this service, not directly via shareUrl.ts.
 * 
 * This keeps menus as access points only - no business logic in UI files.
 */

import { compressToEncodedURIComponent } from 'lz-string';
import { sessionLogService } from './sessionLogService';
import { db } from '../db/appDatabase';
import { fileRegistry } from '../contexts/TabContext';
import { encodeSharePayloadToParam, stableShortHash, type SharePayloadV1 } from '../lib/sharePayload';
import { prepareScenariosForBatch } from './scenarioRegenerationService';

/**
 * Share URL length policy (soft warning only).
 *
 * Notion documents a 2,000 character limit for "Any URL" and `text.link.url` in its API request limits.
 * While the embed UI path is not explicitly documented separately, treating ~2,000 chars as a practical
 * ceiling is the safest assumption for Notion embeds.
 *
 * Source: https://developers.notion.com/reference/request-limits
 */
export const NOTION_DOCUMENTED_URL_LIMIT_CHARS = 2000;
export const SHARE_URL_SOFT_WARN_CHARS = 1800;

export function getShareUrlSoftWarning(url: string): string | null {
  const len = url.length;
  if (len < SHARE_URL_SOFT_WARN_CHARS) return null;
  return `Warning: share link is ${len} characters. Notion appears to cap URLs at ~${NOTION_DOCUMENTED_URL_LIMIT_CHARS} characters; this embed may fail. Consider live share, fewer tabs, or fewer scenarios.`;
}

export interface ShareLinkIdentity {
  repo: string;
  branch: string;
  graph: string;
}

export interface StaticShareLinkOptions {
  /** Graph data to embed in the link */
  graphData: any;
  /** Identity metadata for upgrade-to-live (optional but recommended) */
  identity?: ShareLinkIdentity;
  /** Whether to open in dashboard mode (defaults to true for share links) */
  dashboardMode?: boolean;
  /** Base URL (defaults to current origin) */
  baseUrl?: string;
}

export interface StaticSingleTabShareLinkOptions {
  /** Tab kind being shared */
  tabType: 'graph' | 'chart';
  /** Title for the tab (used in bundle payloads) */
  title: string;
  /** Data for the tab (graph JSON or chart file data) */
  data: any;
  /** Identity metadata for upgrade-to-live (optional) */
  identity?: ShareLinkIdentity;
  /** Whether to open in dashboard mode (defaults to true for share links) */
  dashboardMode?: boolean;
  /** Base URL (defaults to current origin) */
  baseUrl?: string;
}

export interface LiveShareLinkOptions {
  /** Repository name (must match credential entry name) */
  repo: string;
  /** Branch name */
  branch: string;
  /** Graph identifier (filename without extension) */
  graph: string;
  /** Secret for credential unlock */
  secret: string;
  /** Whether to open in dashboard mode (defaults to true for share links) */
  dashboardMode?: boolean;
  /** Base URL (defaults to current origin) */
  baseUrl?: string;
}

/**
 * Resolve a share secret for generating live share links.
 *
 * Precedence:
 * 1) Current URL `?secret=...` (explicit override)
 * 2) Injected env `SHARE_SECRET` (preferred for dev / embed hosts)
 * 3) Injected env `VITE_CREDENTIALS_SECRET` (fallback)
 */
export function resolveShareSecretForLinkGeneration(): string | null {
  try {
    // 1) URL param first
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlSecret = params.get('secret');
      if (urlSecret) return urlSecret;
    }

    // 2) Vite-injected envs
    const shareSecret = (import.meta.env.SHARE_SECRET as string | undefined) || undefined;
    if (shareSecret) return shareSecret;

    const fallback = (import.meta.env.VITE_CREDENTIALS_SECRET as string | undefined) || undefined;
    if (fallback) return fallback;
  } catch {
    // ignore
  }
  return null;
}

/**
 * Build a static share URL.
 * 
 * Static links embed the graph data directly and are self-contained.
 * They include mode=static and identity metadata (if provided) for upgrade-to-live.
 */
export function buildStaticShareUrl(options: StaticShareLinkOptions): string {
  const { graphData, identity, baseUrl, dashboardMode } = options;
  
  const base = baseUrl || `${window.location.origin}${window.location.pathname}`;
  const url = new URL(base);
  
  // Compress and embed graph data
  const data = compressToEncodedURIComponent(JSON.stringify(graphData));
  url.searchParams.set('data', data);
  
  // Explicit mode marker for v1 links
  url.searchParams.set('mode', 'static');
  
  // Suppress staleness/safety nudges
  url.searchParams.set('nonudge', '1');

  // Share links default to dashboard mode (Notion embeds, view-first presentation).
  if (dashboardMode !== false) {
    url.searchParams.set('dashboard', '1');
  }
  
  // Include identity metadata for upgrade-to-live (if available)
  if (identity) {
    url.searchParams.set('repo', identity.repo);
    url.searchParams.set('branch', identity.branch);
    url.searchParams.set('graph', identity.graph);
  }
  
  const result = url.toString();
  
  // Session logging
  sessionLogService.info('session', 'SHARE_STATIC_LINK_CREATED', 
    `Created static share link${identity ? ` for ${identity.graph}` : ''}`,
    undefined,
    { hasIdentity: !!identity, dataLength: data.length, dashboard: dashboardMode !== false }
  );
  
  return result;
}

/**
 * Build a static share URL for a single tab.
 *
 * IMPORTANT:
 * - Graph tabs use the legacy v1 `data=<graph>` payload for compactness.
 * - Chart tabs MUST be wrapped in a bundle payload so boot can materialise a chart file/tab.
 */
export function buildStaticSingleTabShareUrl(options: StaticSingleTabShareLinkOptions): string {
  const { tabType, title, data, identity, dashboardMode, baseUrl } = options;

  if (tabType === 'graph') {
    return buildStaticShareUrl({ graphData: data, identity, dashboardMode, baseUrl });
  }

  const bundle = {
    type: 'bundle',
    version: '1.0.0',
    items: [
      {
        type: 'chart',
        title,
        data,
        identity,
      },
    ],
    options: {
      dashboardMode: dashboardMode !== false,
      includeScenarios: true,
    },
  };

  return buildStaticShareUrl({ graphData: bundle, identity, dashboardMode, baseUrl });
}

/**
 * Build a live share URL.
 * 
 * Live links fetch the latest graph from GitHub at load time.
 * They require repo/branch/graph/secret parameters.
 */
export function buildLiveShareUrl(options: LiveShareLinkOptions): string {
  const { repo, branch, graph, secret, baseUrl, dashboardMode } = options;
  
  const base = baseUrl || `${window.location.origin}${window.location.pathname}`;
  const url = new URL(base);
  
  // Live mode marker
  url.searchParams.set('mode', 'live');
  
  // Identity params (required for live mode)
  url.searchParams.set('repo', repo);
  url.searchParams.set('branch', branch);
  url.searchParams.set('graph', graph);
  
  // Secret for credential unlock
  url.searchParams.set('secret', secret);
  // IMPORTANT:
  // Live share links must NOT include `nonudge`.
  // Live embeds rely on staleness/remote-ahead detection + refresh policy for correctness.

  // Share links default to dashboard mode.
  if (dashboardMode !== false) {
    url.searchParams.set('dashboard', '1');
  }
  
  const result = url.toString();
  
  // Session logging
  sessionLogService.info('session', 'SHARE_LIVE_LINK_CREATED', 
    `Created live share link for ${repo}/${branch}/${graph}`,
    undefined,
    { repo, branch, graph, dashboard: dashboardMode !== false }
  );
  
  return result;
}

/**
 * Extract identity metadata from the current file/tab context.
 * Returns undefined if identity cannot be determined (e.g. local-only file).
 */
export function extractIdentityFromFileSource(source?: { 
  repository?: string; 
  branch?: string; 
  path?: string;
}): ShareLinkIdentity | undefined {
  if (!source?.repository || !source?.branch || !source?.path) {
    return undefined;
  }
  
  // Extract graph name from path (e.g. 'graphs/my-graph.json' -> 'my-graph')
  const pathParts = source.path.split('/');
  const filename = pathParts[pathParts.length - 1];
  const graph = filename.replace(/\.(json|yaml|yml)$/, '');
  
  return {
    repo: source.repository,
    branch: source.branch,
    graph,
  };
}

export interface LiveChartShareUrlResult {
  success: boolean;
  url?: string;
  error?: string;
}

type ShareChartPayload = Extract<SharePayloadV1, { target: 'chart' }>;

export interface LiveBundleShareUrlResult {
  success: boolean;
  url?: string;
  error?: string;
}

/**
 * Build a live chart share URL from an existing chart file.
 *
 * IMPORTANT:
 * - This is Phase 3 behaviour: the share URL carries a compressed recipe payload (`share=`),
 *   not baked results.
 * - Eligibility: all non-Base/non-Current visible scenarios must be DSL-backed live scenarios.
 */
export async function buildLiveChartShareUrlFromChartFile(args: {
  chartFileId: string;
  dashboardMode?: boolean;
  baseUrl?: string;
  secretOverride?: string;
}): Promise<LiveChartShareUrlResult> {
  const { chartFileId, dashboardMode, baseUrl, secretOverride } = args;

  try {
    const chartFile: any = fileRegistry.getFile(chartFileId) || (await db.files.get(chartFileId));
    const chartData: any = chartFile?.data;
    if (!chartData || chartData.version !== '1.0.0' || !chartData.chart_kind) {
      return { success: false, error: 'Chart data not found or invalid' };
    }

    const parentFileId: string | undefined = chartData?.source?.parent_file_id;
    const parentTabId: string | undefined = chartData?.source?.parent_tab_id;
    if (!parentFileId || !parentTabId) {
      return { success: false, error: 'Chart is missing parent graph context' };
    }

    const parentGraphFile: any = fileRegistry.getFile(parentFileId) || (await db.files.get(parentFileId));
    const identity = extractIdentityFromFileSource(parentGraphFile?.source);
    if (!identity?.repo || !identity.branch || !identity.graph) {
      return { success: false, error: 'Live chart share requires repo/branch/graph identity' };
    }

    const secret = secretOverride || resolveShareSecretForLinkGeneration();
    if (!secret) {
      return { success: false, error: 'No share secret available (set SHARE_SECRET or open with ?secret=…)' };
    }

    const parentTab: any = await db.tabs.get(parentTabId);
    const scenarioState = parentTab?.editorState?.scenarioState || {};
    const visibleScenarioIds: string[] = Array.isArray(scenarioState.visibleScenarioIds) ? scenarioState.visibleScenarioIds : [];
    const visibilityMode: Record<string, 'f+e' | 'f' | 'e'> = scenarioState.visibilityMode || {};

    // Load scenarios from IndexedDB (source of truth in share/workspace flows).
    //
    // IMPORTANT: IndexedDB may store scenarios keyed by either:
    // - canonical fileId: `graph-...`
    // - workspace-prefixed fileId: `${repo}-${branch}-graph-...`
    //
    // Prefer canonical, but fall back to prefixed when missing to avoid false negatives
    // (especially in share/boot flows where FileRegistry uses canonical IDs).
    const canonicalScenarios: any[] = await db.scenarios.where('fileId').equals(parentFileId).toArray();
    const prefixedScenarios: any[] =
      identity?.repo && identity?.branch
        ? await db.scenarios.where('fileId').equals(`${identity.repo}-${identity.branch}-${parentFileId}`).toArray()
        : [];

    // Merge (prefer canonical when both exist).
    const scenarios: any[] = (() => {
      const byId = new Map<string, any>();
      for (const s of prefixedScenarios) if (s?.id) byId.set(String(s.id), s);
      for (const s of canonicalScenarios) if (s?.id) byId.set(String(s.id), s);
      return Array.from(byId.values());
    })();
    const byId = new Map(scenarios.map(s => [s.id, s]));

    // For bridge charts, scenario_ids are intentionally empty (the result embeds scenario context).
    // Therefore, the canonical "what the user saw" for scenario names/colours/modes is the analysis result metadata.
    const analysisMeta: any = chartData?.payload?.analysis_result?.metadata || {};
    const metaA = analysisMeta?.scenario_a || null;
    const metaB = analysisMeta?.scenario_b || null;

    const orderedScenarioIdsFromAnalysis: string[] =
      metaA?.scenario_id && metaB?.scenario_id ? [metaA.scenario_id, metaB.scenario_id] : [];

    const orderedScenarioIds: string[] =
      orderedScenarioIdsFromAnalysis.length > 0
        ? orderedScenarioIdsFromAnalysis
        : visibleScenarioIds.filter((id: string) => id !== 'base' && id !== 'current');

    // Build COMPOSED effective fetch DSLs for visible scenarios.
    // The raw scenario meta.queryDSL is often a diff (e.g. context-only) and is not meaningful
    // without baseDSL + inheritance from lower visible live scenarios.
    const graph_state = (() => {
      const g: any = parentGraphFile?.data;
      const base_dsl = typeof g?.baseDSL === 'string' && g.baseDSL.trim() ? g.baseDSL : undefined;
      const current_query_dsl =
        typeof g?.currentQueryDSL === 'string' && g.currentQueryDSL.trim() ? g.currentQueryDSL : undefined;
      if (!base_dsl && !current_query_dsl) return undefined;
      return { base_dsl, current_query_dsl };
    })();

    const effectiveDslById: Map<string, string> = (() => {
      try {
        const baseDSLForCompose = (graph_state?.base_dsl || '') as string;
        const prepared = prepareScenariosForBatch(
          (scenarios || []).map((s: any) => ({ id: s.id, meta: s.meta })),
          visibleScenarioIds,
          baseDSLForCompose
        );
        return new Map(prepared.map(p => [p.id, p.effectiveFetchDSL]));
      } catch {
        return new Map<string, string>();
      }
    })();

    const liveScenarioItems: ShareChartPayload['scenarios']['items'] = [];
    let droppedMissingDslCount = 0;
    for (const scenarioId of orderedScenarioIds) {
      if (scenarioId === 'base' || scenarioId === 'current') continue;
      const s = byId.get(scenarioId);
      const subtitle = chartData?.payload?.scenario_dsl_subtitle_by_id?.[scenarioId];
      const dsl: string | undefined =
        effectiveDslById.get(scenarioId) ||
        (s?.meta?.lastEffectiveDSL as string | undefined) ||
        (s?.meta?.queryDSL as string | undefined) ||
        (typeof subtitle === 'string' && subtitle.trim() ? subtitle : undefined);

      const isLive: boolean = Boolean(s?.meta?.isLive);
      // If the scenario exists in IDB and is not live, we cannot rebuild it from DSL deterministically.
      if (s && !isLive) {
        return { success: false, error: 'Live chart share is only supported for DSL-backed live scenarios' };
      }
      if (!dsl || !dsl.trim()) {
        // Do not hard-fail: allow sharing Current-only (Current is live by definition).
        // This also tolerates cases where scenario metadata isn't persisted yet / fileId prefixes mismatch.
        droppedMissingDslCount++;
        continue;
      }

      const meta = metaA?.scenario_id === scenarioId ? metaA : metaB?.scenario_id === scenarioId ? metaB : null;
      liveScenarioItems.push({
        id: scenarioId,
        dsl,
        name: (typeof meta?.name === 'string' && meta.name.trim()) ? meta.name : s?.name,
        colour: (typeof meta?.colour === 'string' && meta.colour.trim()) ? meta.colour : s?.colour,
        visibility_mode: (meta?.visibility_mode as any) || visibilityMode?.[scenarioId] || 'f+e',
        subtitle: typeof subtitle === 'string' ? subtitle : undefined,
      });
    }

    // Mirror what the user had visible when the chart was created.
    //
    // IMPORTANT:
    // - "Current" is live by definition.
    // - Never emit a share payload with `hide_current=true` and zero scenario items, because that
    //   produces a chart share that has no valid scenarios to run (and looks "blank" on boot).
    const hideCurrent = liveScenarioItems.length === 0 ? false : !visibleScenarioIds.includes('current');
    const selectedScenarioId: string | undefined = scenarioState.selectedScenarioId;
    const selectedScenarioDsl =
      selectedScenarioId && selectedScenarioId !== 'base' && selectedScenarioId !== 'current'
        ? (effectiveDslById.get(selectedScenarioId) ||
            (byId.get(selectedScenarioId)?.meta?.lastEffectiveDSL as string | undefined) ||
            (byId.get(selectedScenarioId)?.meta?.queryDSL as string | undefined) ||
            null)
        : null;

    const queryDsl: string | undefined = chartData?.source?.query_dsl;
    if (!queryDsl || !queryDsl.trim()) {
      return { success: false, error: 'Chart is missing analysis query DSL' };
    }

    const analysisType: string | null | undefined = chartData?.source?.analysis_type ?? null;
    const whatIfDsl: string | null | undefined = parentTab?.editorState?.whatIfDSL ?? null;

    const currentMetaFromAnalysis = (() => {
      try {
        const mA = metaA;
        const mB = metaB;
        const cur = mA?.scenario_id === 'current' ? mA : mB?.scenario_id === 'current' ? mB : null;
        const dsl =
          (typeof cur?.dsl === 'string' && cur.dsl.trim())
            ? cur.dsl.trim()
            : (typeof (graph_state as any)?.current_query_dsl === 'string' && (graph_state as any).current_query_dsl.trim())
              ? String((graph_state as any).current_query_dsl).trim()
              : undefined;
        const colour = (typeof cur?.colour === 'string' && cur.colour.trim()) ? cur.colour : undefined;
        const visibility_mode = (cur?.visibility_mode as any) || undefined;
        const name = (typeof cur?.name === 'string' && cur.name.trim()) ? cur.name : 'Current';
        if (!dsl && !colour && !visibility_mode) return undefined;
        return { dsl, colour, visibility_mode, name };
      } catch {
        return undefined;
      }
    })();

    const payload: SharePayloadV1 = {
      version: '1.0.0',
      target: 'chart',
      graph_state,
      chart: {
        kind: chartData.chart_kind,
        title: chartData.title,
      },
      analysis: {
        query_dsl: queryDsl,
        analysis_type: analysisType,
        what_if_dsl: whatIfDsl,
      },
      scenarios: {
        items: liveScenarioItems,
        current: currentMetaFromAnalysis,
        hide_current: hideCurrent,
        selected_scenario_dsl: selectedScenarioDsl,
      },
    };

    const encoded = encodeSharePayloadToParam(payload);
    const url = new URL(
      buildLiveShareUrl({
        repo: identity.repo,
        branch: identity.branch,
        graph: identity.graph,
        secret,
        dashboardMode,
        baseUrl,
      })
    );
    url.searchParams.set('share', encoded);

    // Stable debug marker (not relied on by boot; helpful for logs / QA).
    const recipeHash = stableShortHash(JSON.stringify(payload));
    url.searchParams.set('shareid', recipeHash);

    sessionLogService.info(
      'session',
      'SHARE_LIVE_CHART_LINK_CREATED',
      `Created live chart share link for ${identity.repo}/${identity.branch}/${identity.graph}`,
      undefined,
      { repo: identity.repo, branch: identity.branch, graph: identity.graph, chartKind: chartData.chart_kind }
    );

    return { success: true, url: url.toString() };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

/**
 * Build a live multi-tab bundle share URL.
 *
 * v1 constraints:
 * - All selected tabs must refer to the same live graph identity (repo/branch/graph)
 * - If includeScenarios is on, all included (non-base/current) scenarios must be DSL-backed live scenarios
 */
export async function buildLiveBundleShareUrlFromTabs(args: {
  tabIds: string[];
  dashboardMode?: boolean;
  includeScenarios?: boolean;
  activeTabId?: string;
  baseUrl?: string;
  secretOverride?: string;
}): Promise<LiveBundleShareUrlResult> {
  const { tabIds, dashboardMode, includeScenarios = true, activeTabId, baseUrl, secretOverride } = args;

  try {
    if (!Array.isArray(tabIds) || tabIds.length < 1) {
      return { success: false, error: 'Live bundle share requires at least 1 tab' };
    }

    const tabs = (await Promise.all(tabIds.map(id => db.tabs.get(id)))).filter(Boolean) as any[];
    if (tabs.length !== tabIds.length) {
      return { success: false, error: 'Some selected tabs no longer exist' };
    }

    const resolveIdentityForTab = async (t: any) => {
      const f: any = fileRegistry.getFile(t.fileId) || (await db.files.get(t.fileId));
      if (!f) return undefined;
      const isChart = (f as any)?.type === 'chart' || String(t.fileId).startsWith('chart-');
      if (!isChart) return extractIdentityFromFileSource(f.source);
      const parentFileId: string | undefined = (f as any)?.data?.source?.parent_file_id;
      if (!parentFileId) return undefined;
      const parent: any = fileRegistry.getFile(parentFileId) || (await db.files.get(parentFileId));
      return extractIdentityFromFileSource(parent?.source);
    };

    const identities = await Promise.all(tabs.map(resolveIdentityForTab));
    const identity = identities[0];
    if (!identity?.repo || !identity.branch || !identity.graph) {
      return { success: false, error: 'Live bundle share requires repo/branch/graph identity' };
    }
    for (const id of identities) {
      if (!id?.repo || !id.branch || !id.graph) {
        return { success: false, error: 'All selected tabs must have live identity' };
      }
      if (id.repo !== identity.repo || id.branch !== identity.branch || id.graph !== identity.graph) {
        return { success: false, error: 'Live bundle share only supports tabs from the same graph (repo/branch/graph)' };
      }
    }

    const secret = secretOverride || resolveShareSecretForLinkGeneration();
    if (!secret) {
      return { success: false, error: 'No share secret available (set SHARE_SECRET or open with ?secret=…)' };
    }

    const preferredTabId = activeTabId && tabIds.includes(activeTabId) ? activeTabId : tabIds[0];
    const preferredTab: any = await db.tabs.get(preferredTabId);
    const preferredFileId: string | undefined = preferredTab?.fileId;

    const scenarioState = preferredTab?.editorState?.scenarioState || {};
    const visibleScenarioIds: string[] = Array.isArray(scenarioState.visibleScenarioIds) ? scenarioState.visibleScenarioIds : [];
    const visibilityMode: Record<string, 'f+e' | 'f' | 'e'> = scenarioState.visibilityMode || {};

    const scenarios: any[] = preferredFileId ? await db.scenarios.where('fileId').equals(preferredFileId).toArray() : [];
    const byId = new Map(scenarios.map(s => [s.id, s]));

    // Use the preferred tab's graph file (or chart parent graph) to capture authoring DSL state.
    const graph_state = (() => {
      const preferredTabId = activeTabId && tabIds.includes(activeTabId) ? activeTabId : tabIds[0];
      const preferredTab = tabs.find(x => x?.id === preferredTabId) || tabs[0];
      const preferredFileId = preferredTab?.fileId;
      const preferredFile: any = preferredFileId ? (fileRegistry.getFile(preferredFileId) || null) : null;
      const graphFile: any =
        preferredFile?.type === 'graph'
          ? preferredFile
          : preferredFile?.type === 'chart'
            ? (() => {
                const parentFileId = preferredFile?.data?.source?.parent_file_id;
                return typeof parentFileId === 'string' ? fileRegistry.getFile(parentFileId) : null;
              })()
            : null;
      const g: any = graphFile?.data;
      const base_dsl = typeof g?.baseDSL === 'string' && g.baseDSL.trim() ? g.baseDSL : undefined;
      const current_query_dsl =
        typeof g?.currentQueryDSL === 'string' && g.currentQueryDSL.trim() ? g.currentQueryDSL : undefined;
      if (!base_dsl && !current_query_dsl) return undefined;
      return { base_dsl, current_query_dsl };
    })();

    const effectiveDslById: Map<string, string> = (() => {
      try {
        const baseDSLForCompose = (graph_state?.base_dsl || '') as string;
        const prepared = prepareScenariosForBatch(
          (scenarios || []).map((s: any) => ({ id: s.id, meta: s.meta })),
          visibleScenarioIds,
          baseDSLForCompose
        );
        return new Map(prepared.map(p => [p.id, p.effectiveFetchDSL]));
      } catch {
        return new Map<string, string>();
      }
    })();

    const liveScenarioItems: Array<{
      dsl: string;
      name?: string;
      colour?: string;
      visibility_mode?: 'f+e' | 'f' | 'e';
      subtitle?: string;
    }> = [];
    if (includeScenarios) {
      for (const scenarioId of visibleScenarioIds) {
        if (scenarioId === 'base' || scenarioId === 'current') continue;
        const s = byId.get(scenarioId);
        const dsl: string | undefined =
          effectiveDslById.get(scenarioId) ||
          (s?.meta?.lastEffectiveDSL as string | undefined) ||
          (s?.meta?.queryDSL as string | undefined);
        const isLive: boolean = Boolean(s?.meta?.isLive);
        if (!isLive || !dsl || !dsl.trim()) {
          return {
            success: false,
            error:
              'Live bundle share only supports DSL-backed live scenarios (disable "include scenarios" or remove non-live scenarios)',
          };
        }
        liveScenarioItems.push({
          id: scenarioId,
          dsl,
          name: s?.name,
          colour: s?.colour,
          visibility_mode: visibilityMode?.[scenarioId] || 'f+e',
          subtitle: undefined,
        });
      }
    }

    const hideCurrent = includeScenarios ? !visibleScenarioIds.includes('current') : false;
    const selectedScenarioId: string | undefined = scenarioState.selectedScenarioId;
    const selectedScenarioDsl =
      includeScenarios && selectedScenarioId && selectedScenarioId !== 'base' && selectedScenarioId !== 'current'
        ? (effectiveDslById.get(selectedScenarioId) ||
            (byId.get(selectedScenarioId)?.meta?.lastEffectiveDSL as string | undefined) ||
            (byId.get(selectedScenarioId)?.meta?.queryDSL as string | undefined) ||
            null)
        : null;

    const bundleTabs: any[] = [];
    for (const t of tabs) {
      const f: any = fileRegistry.getFile(t.fileId) || (await db.files.get(t.fileId));
      if (!f) continue;
      const isChart = (f as any)?.type === 'chart' || String(t.fileId).startsWith('chart-');
      if (!isChart) {
        bundleTabs.push({ type: 'graph', title: t.title });
        continue;
      }

      const chartData: any = f.data;
      const chartKind = chartData?.chart_kind;
      const queryDsl: string | undefined = chartData?.source?.query_dsl;
      if (!chartKind || !queryDsl || !queryDsl.trim()) {
        return { success: false, error: 'One of the selected charts is missing recipe metadata (chart_kind/query_dsl)' };
      }

      const parentTabId: string | undefined = chartData?.source?.parent_tab_id;
      const parentTab: any = parentTabId ? await db.tabs.get(parentTabId) : null;
      const whatIfDsl: string | null | undefined = parentTab?.editorState?.whatIfDSL ?? null;

      bundleTabs.push({
        type: 'chart',
        title: t.title,
        chart: { kind: chartKind },
        analysis: {
          query_dsl: queryDsl,
          analysis_type: chartData?.source?.analysis_type ?? null,
          what_if_dsl: whatIfDsl,
        },
      });
    }

    const payload: SharePayloadV1 = {
      version: '1.0.0',
      target: 'bundle',
      graph_state,
      presentation: {
        dashboardMode: dashboardMode !== false,
        activeTabIndex: (() => {
          const idx = activeTabId ? tabIds.indexOf(activeTabId) : -1;
          return idx >= 0 ? idx : 0;
        })(),
      },
      tabs: bundleTabs,
      scenarios: includeScenarios
        ? {
            items: liveScenarioItems,
            hide_current: hideCurrent,
            selected_scenario_dsl: selectedScenarioDsl,
          }
        : { items: [], hide_current: false, selected_scenario_dsl: null },
    } as any;

    const encoded = encodeSharePayloadToParam(payload);
    const url = new URL(
      buildLiveShareUrl({
        repo: identity.repo,
        branch: identity.branch,
        graph: identity.graph,
        secret,
        dashboardMode,
        baseUrl,
      })
    );
    url.searchParams.set('share', encoded);
    url.searchParams.set('shareid', stableShortHash(JSON.stringify(payload)));

    sessionLogService.info(
      'session',
      'SHARE_LIVE_BUNDLE_LINK_CREATED',
      `Created live bundle share link for ${identity.repo}/${identity.branch}/${identity.graph}`,
      undefined,
      { repo: identity.repo, branch: identity.branch, graph: identity.graph, tabs: bundleTabs.map(t => t.type) }
    );

    return { success: true, url: url.toString() };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

export interface StaticBundleShareUrlResult {
  success: boolean;
  url?: string;
  error?: string;
}

/**
 * Build a static multi-tab bundle URL (data= bundle payload).
 *
 * This is still a static share: all data needed to render is embedded in the URL payload.
 * We implement lightweight deduplication for graph JSON to avoid duplicating the same graph
 * across multiple tabs in the same link.
 */
export async function buildStaticBundleShareUrlFromTabs(args: {
  tabIds: string[];
  dashboardMode?: boolean;
  includeScenarios?: boolean;
  activeTabId?: string;
  baseUrl?: string;
}): Promise<StaticBundleShareUrlResult> {
  const { tabIds, dashboardMode, includeScenarios = true, activeTabId, baseUrl } = args;
  try {
    if (!Array.isArray(tabIds) || tabIds.length < 2) {
      return { success: false, error: 'Static bundle share requires at least 2 tabs' };
    }

    const tabs = (await Promise.all(tabIds.map(id => db.tabs.get(id)))).filter(Boolean) as any[];
    if (tabs.length !== tabIds.length) return { success: false, error: 'Some selected tabs no longer exist' };

    const sharedGraphs: Record<string, any> = {};
    const scenariosByGraphRef: Record<string, any[]> = {};
    const items: any[] = [];

    let identityForUpgrade: ShareLinkIdentity | undefined = undefined;

    for (const t of tabs) {
      const f: any = fileRegistry.getFile(t.fileId) || (await db.files.get(t.fileId));
      if (!f?.data) continue;

      const isChart = (f as any)?.type === 'chart' || String(t.fileId).startsWith('chart-');
      if (isChart) {
        const id = extractIdentityFromFileSource(f.source);
        if (!identityForUpgrade && id) identityForUpgrade = id;
        items.push({
          type: 'chart',
          title: t.title,
          data: f.data,
          identity: id,
        });
        continue;
      }

      // Graph tab
      const graphData = f.data;
      const graphRef = stableShortHash(JSON.stringify(graphData));
      if (!sharedGraphs[graphRef]) sharedGraphs[graphRef] = graphData;

      const id = extractIdentityFromFileSource(f.source);
      if (!identityForUpgrade && id) identityForUpgrade = id;

      const item: any = {
        type: 'graph',
        title: t.title,
        graphRef,
        identity: id,
      };

      if (includeScenarios) {
        const scenarios: any[] = await db.scenarios.where('fileId').equals(t.fileId).toArray();
        scenariosByGraphRef[graphRef] = scenarios;
        item.scenariosRef = graphRef;
      }

      items.push(item);
    }

    if (items.length === 0) return { success: false, error: 'No data available for selected tabs' };

    const activeTabIndex = (() => {
      const idx = activeTabId ? tabIds.indexOf(activeTabId) : -1;
      return idx >= 0 ? idx : 0;
    })();

    const bundle = {
      type: 'bundle',
      version: '1.0.0',
      shared: {
        graphs: sharedGraphs,
        ...(includeScenarios ? { scenariosByGraphRef } : null),
      },
      items,
      options: {
        dashboardMode,
        includeScenarios,
        activeTabIndex,
      },
    };

    const url = buildStaticShareUrl({
      graphData: bundle,
      identity: identityForUpgrade,
      dashboardMode,
      baseUrl,
    });

    sessionLogService.info('session', 'SHARE_STATIC_BUNDLE_LINK_CREATED', `Created static bundle share link`, undefined, {
      tabs: items.map((it: any) => it.type),
      includeScenarios,
    });

    return { success: true, url };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

/**
 * Service singleton for dependency injection in tests.
 */
class ShareLinkService {
  buildStaticShareUrl = buildStaticShareUrl;
  buildStaticSingleTabShareUrl = buildStaticSingleTabShareUrl;
  buildLiveShareUrl = buildLiveShareUrl;
  buildLiveChartShareUrlFromChartFile = buildLiveChartShareUrlFromChartFile;
  buildLiveBundleShareUrlFromTabs = buildLiveBundleShareUrlFromTabs;
  buildStaticBundleShareUrlFromTabs = buildStaticBundleShareUrlFromTabs;
  getShareUrlSoftWarning = getShareUrlSoftWarning;
  extractIdentityFromFileSource = extractIdentityFromFileSource;
  resolveShareSecretForLinkGeneration = resolveShareSecretForLinkGeneration;
}

export const shareLinkService = new ShareLinkService();
