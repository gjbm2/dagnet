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
    const scenarios: any[] = await db.scenarios.where('fileId').equals(parentFileId).toArray();
    const byId = new Map(scenarios.map(s => [s.id, s]));

    const liveScenarioItems: SharePayloadV1['scenarios']['items'] = [];
    for (const scenarioId of visibleScenarioIds) {
      if (scenarioId === 'base' || scenarioId === 'current') continue;
      const s = byId.get(scenarioId);
      const dsl: string | undefined = s?.meta?.queryDSL;
      const isLive: boolean = Boolean(s?.meta?.isLive);
      if (!isLive || !dsl || !dsl.trim()) {
        return { success: false, error: 'Live chart share is only supported for DSL-backed live scenarios' };
      }
      const subtitle = chartData?.payload?.scenario_dsl_subtitle_by_id?.[scenarioId];
      liveScenarioItems.push({
        dsl,
        name: s?.name,
        colour: s?.colour,
        visibility_mode: visibilityMode?.[scenarioId] || 'f+e',
        subtitle: typeof subtitle === 'string' ? subtitle : undefined,
      });
    }

    const hideCurrent = !visibleScenarioIds.includes('current');
    const selectedScenarioId: string | undefined = scenarioState.selectedScenarioId;
    const selectedScenarioDsl =
      selectedScenarioId && selectedScenarioId !== 'base' && selectedScenarioId !== 'current'
        ? (byId.get(selectedScenarioId)?.meta?.queryDSL as string | undefined) || null
        : null;

    const queryDsl: string | undefined = chartData?.source?.query_dsl;
    if (!queryDsl || !queryDsl.trim()) {
      return { success: false, error: 'Chart is missing analysis query DSL' };
    }

    const analysisType: string | null | undefined = chartData?.source?.analysis_type ?? null;
    const whatIfDsl: string | null | undefined = parentTab?.editorState?.whatIfDSL ?? null;

    const payload: SharePayloadV1 = {
      version: '1.0.0',
      target: 'chart',
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
 * Service singleton for dependency injection in tests.
 */
class ShareLinkService {
  buildStaticShareUrl = buildStaticShareUrl;
  buildStaticSingleTabShareUrl = buildStaticSingleTabShareUrl;
  buildLiveShareUrl = buildLiveShareUrl;
  buildLiveChartShareUrlFromChartFile = buildLiveChartShareUrlFromChartFile;
  extractIdentityFromFileSource = extractIdentityFromFileSource;
  resolveShareSecretForLinkGeneration = resolveShareSecretForLinkGeneration;
}

export const shareLinkService = new ShareLinkService();
