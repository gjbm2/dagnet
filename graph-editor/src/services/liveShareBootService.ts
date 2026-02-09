/**
 * Live Share Boot Service
 * 
 * Orchestrates the live share boot process:
 * 1. Validate required URL parameters
 * 2. Unlock credentials via secret
 * 3. Fetch graph from GitHub (single file, no workspace clone)
 * 4. Compute dependency closure
 * 5. Fetch required supporting files (parameters, etc.)
 * 6. Seed files into share-scoped cache
 * 7. Return data for tab opening
 * 
 * This service is stateless - it performs the boot sequence and returns results.
 * The caller (TabContext) is responsible for tab creation and state management.
 */

import { gitService } from './gitService';
import { credentialsManager } from '../lib/credentials';
import { sessionLogService } from './sessionLogService';
import { collectGraphDependencies, getMinimalParameterIds, extractContextKeysFromDSL } from '../lib/dependencyClosure';
import { getShareBootConfig, ShareBootConfig } from '../lib/shareBootResolver';
import { decodeSharePayloadFromUrl } from '../lib/sharePayload';
import { parseConstraints } from '../lib/queryDSL';
import YAML from 'yaml';

type ParameterIndexEntry = { id: string; file_path?: string };
type EventIndexEntry = { id: string; file_path?: string };

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.floor(concurrency || 1));

  const results: R[] = new Array(items.length);
  let nextIdx = 0;

  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (true) {
      const idx = nextIdx;
      nextIdx += 1;
      if (idx >= items.length) return;
      results[idx] = await mapper(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

function resolveParamPathFromIndex(
  paramId: string,
  index: any | null | undefined,
  fallback: string
): string {
  const entries: ParameterIndexEntry[] = (index && Array.isArray(index.parameters)) ? index.parameters : [];
  const match = entries.find((e) => e?.id === paramId);
  const p = match?.file_path;
  if (typeof p === 'string' && p.trim()) return p.trim();
  return fallback;
}

export interface LiveBootResult {
  success: boolean;
  error?: string;
  
  // Graph data (on success)
  graphData?: any;
  graphSha?: string;
  graphPath?: string;
  /** Remote HEAD SHA for the branch (commit SHA), used for share-live staleness tracking. */
  remoteHeadSha?: string | null;
  
  // Fetched parameter files (on success)
  parameters?: Map<string, { data: any; sha?: string; path: string }>;

  // Fetched event definition files (on success)
  events?: Map<string, { data: any; sha?: string; path: string }>;

  // Fetched context files (on success)
  contexts?: Map<string, { data: any; sha?: string; path: string }>;

  // Fetched shared settings file (on success)
  settings?: { data: any; sha?: string; path: string };

  // Fetched repo connections file (on success; optional)
  connections?: { data: any; sha?: string; path: string };
  
  // Identity info for tab creation
  identity?: {
    repo: string;
    branch: string;
    graph: string;
  };
}

/**
 * Perform live share boot sequence.
 * 
 * This function is the main entry point for live share boot.
 * It handles credential unlock, graph fetch, dependency resolution, and cache seeding.
 */
export async function performLiveShareBoot(): Promise<LiveBootResult> {
  const config = getShareBootConfig();
  
  if (config.mode !== 'live') {
    return { success: false, error: 'Not in live share mode' };
  }
  
  const { repo, branch, graph, secret } = config;
  
  if (!repo || !branch || !graph) {
    return { success: false, error: 'Missing required identity params (repo, branch, graph)' };
  }
  
  const logOpId = sessionLogService.startOperation(
    'info', 'git', 'LIVE_SHARE_BOOT',
    `Live share boot: ${repo}/${branch}/${graph}`
  );
  
  return await fetchLiveShareBundle(
    { repo, branch, graph },
    { logOpId, operationLabel: 'LIVE_SHARE_BOOT' }
  );
}

export async function fetchLiveShareBundle(
  args: { repo: string; branch: string; graph: string },
  opts: { logOpId?: string; operationLabel: 'LIVE_SHARE_BOOT' | 'LIVE_SHARE_REFRESH' }
): Promise<LiveBootResult> {
  const { repo, branch, graph } = args;
  const logOpId =
    opts.logOpId ||
    sessionLogService.startOperation(
      'info',
      'git',
      opts.operationLabel,
      `${opts.operationLabel}: ${repo}/${branch}/${graph}`,
      { repo, branch, graph }
    );

  try {
    // Step 1: Unlock credentials
    sessionLogService.addChild(logOpId, 'info', 'CREDENTIAL_UNLOCK', 'Unlocking credentials...');
    
    const credResult = await credentialsManager.loadCredentials();
    if (!credResult.success || !credResult.credentials) {
      sessionLogService.endOperation(logOpId, 'error', `Credential unlock failed: ${credResult.error}`);
      return { success: false, error: `Credential unlock failed: ${credResult.error}` };
    }
    
    // Find the git credential for this repo
    const gitCreds = credResult.credentials.git?.find(g => g.name === repo);
    if (!gitCreds) {
      sessionLogService.endOperation(logOpId, 'error', `No credentials for repo: ${repo}`);
      return { success: false, error: `No credentials found for repository: ${repo}` };
    }
    
    sessionLogService.addChild(logOpId, 'success', 'CREDENTIAL_UNLOCK_SUCCESS', `Credentials unlocked for ${repo}`);
    
    // Step 2: Configure gitService
    gitService.setCredentials({
      git: [gitCreds],
      defaultGitRepo: repo,
    });

    // Helper: apply basePath (if present) to repo-relative paths.
    // IMPORTANT: treat all paths as repo-root relative (same as WorkspaceService tree filtering).
    const basePath = (gitCreds as any)?.basePath ? String((gitCreds as any).basePath) : '';
    const toRepoPath = (p: string): string => {
      const raw = (p || '').replace(/^\/+/, '');
      if (!basePath) return raw;
      const prefix = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
      return raw.startsWith(prefix + '/') ? raw : `${prefix}/${raw}`;
    };

    // Step 2.8: Fetch repo tree once (Git Data API) so we can fetch required files by blob SHA.
    // Rationale: GitHub Contents API (`/contents/*`) has become flaky for authenticated CORS preflights.
    sessionLogService.addChild(logOpId, 'info', 'TREE_FETCH', 'Fetching repo tree (recursive)…');
    const treeResult = await gitService.getRepositoryTree(branch, true);
    if (!treeResult.success || !treeResult.data?.tree) {
      sessionLogService.endOperation(logOpId, 'error', `Tree fetch failed: ${treeResult.error || 'unknown error'}`);
      return { success: false, error: `Failed to fetch repo tree: ${treeResult.error || 'unknown error'}` };
    }
    const tree: any[] = treeResult.data.tree;
    const pathToBlob = new Map<string, { sha: string; size?: number }>();
    for (const item of tree) {
      if (item?.type !== 'blob') continue;
      const p = typeof item?.path === 'string' ? item.path : '';
      const sha = typeof item?.sha === 'string' ? item.sha : '';
      if (!p || !sha) continue;
      const size = typeof item?.size === 'number' ? item.size : undefined;
      pathToBlob.set(p, { sha, size });
    }
    sessionLogService.addChild(logOpId, 'success', 'TREE_FETCH_SUCCESS', `Fetched repo tree (${pathToBlob.size} blobs)`);

    // In-call memoisation by blob SHA to avoid duplicate network fetches/decodes
    // if the same blob is referenced via multiple paths (rare but cheap to handle).
    const blobTextBySha = new Map<string, Promise<{ content: string; sha: string }>>();

    const readTextFileFromTree = async (repoPath: string): Promise<{ content: string; sha: string; path: string; size?: number }> => {
      const p = toRepoPath(repoPath);
      const hit = pathToBlob.get(p);
      if (!hit?.sha) throw new Error(`File not found in repo tree: ${p}`);
      const sha = hit.sha;
      const pBlobPromise =
        blobTextBySha.get(sha) ||
        (async () => {
          const blobRes = await gitService.getBlobContent(sha, false);
          if (!blobRes.success || !blobRes.data?.content) {
            throw new Error(blobRes.error || `Failed to fetch blob for ${sha}`);
          }
          return { content: String(blobRes.data.content), sha: String(blobRes.data.sha || sha) };
        })();
      blobTextBySha.set(sha, pBlobPromise);
      const blob = await pBlobPromise;
      return { content: blob.content, sha: blob.sha, path: p, size: hit.size };
    };

    // Step 2.5: Fetch remote HEAD SHA (commit) for staleness tracking
    const remoteHeadShaPromise = (async () => {
      try {
        return await gitService.getRemoteHeadSha(branch);
      } catch {
        // Best-effort only; do not fail boot/refresh on HEAD lookup.
        return null;
      }
    })();
    
    // Step 3: Fetch graph (via Git Data API: tree+blob, not Contents API)
    sessionLogService.addChild(logOpId, 'info', 'GRAPH_FETCH', `Fetching graph: ${graph}`);

    const graphsDir = (gitCreds as any)?.graphsPath ? String((gitCreds as any).graphsPath) : 'graphs';
    const graphFileName = graph.endsWith('.json') ? graph : `${graph}.json`;
    const graphRepoPath = `${graphsDir}/${graphFileName}`;

    let graphText: { content: string; sha: string; path: string };
    try {
      graphText = await readTextFileFromTree(graphRepoPath);
    } catch (e: any) {
      sessionLogService.endOperation(logOpId, 'error', `Graph fetch failed: ${e?.message || String(e)}`);
      return { success: false, error: `Failed to fetch graph: ${e?.message || String(e)}` };
    }

    let graphData: any;
    try {
      graphData = JSON.parse(graphText.content);
    } catch (e: any) {
      sessionLogService.endOperation(logOpId, 'error', `Graph parse failed: ${e?.message || String(e)}`);
      return { success: false, error: `Failed to parse graph JSON: ${e?.message || String(e)}` };
    }

    const graphSha = graphText.sha;
    const graphPath = graphText.path;
    
    sessionLogService.addChild(logOpId, 'success', 'GRAPH_FETCH_SUCCESS', 
      `Fetched graph: ${graphData?.nodes?.length || 0} nodes, SHA: ${graphSha?.substring(0, 8)}`);
    
    // Step 4: Compute dependency closure
    const deps = collectGraphDependencies(graphData);
    const parameterIds = Array.from(deps.parameterIds);
    const eventIds = Array.from(deps.eventIds);
    const contextKeysFromGraph = Array.from(deps.contextKeys);

    // Share payload can introduce additional context() requirements that are not detectable
    // from the base graph alone (e.g. scenario DSLs like context(channel:paid-search)).
    // If we don't pre-seed these context definitions, query compilation/signature validation
    // and slice selection can silently diverge between authoring and share boot.
    const contextKeysFromShare = (() => {
      try {
        const payload: any = decodeSharePayloadFromUrl();
        const items: any[] = payload?.scenarios?.items || payload?.scenarios?.items || [];
        const keys = new Set<string>();
        for (const it of items) {
          const dsl = (it?.dsl || '').toString();
          if (!dsl.trim()) continue;
          const parsed = parseConstraints(dsl);
          for (const c of parsed.context || []) keys.add(c.key);
          for (const any of parsed.contextAny || []) {
            for (const p of any.pairs || []) keys.add(p.key);
          }
        }
        return Array.from(keys);
      } catch {
        return [];
      }
    })();

    const contextKeys = Array.from(new Set([...contextKeysFromGraph, ...contextKeysFromShare]));
    sessionLogService.addChild(logOpId, 'info', 'DEPENDENCY_CLOSURE', 
      `Dependency closure: ${parameterIds.length} parameters, ${eventIds.length} events, ${contextKeys.length} contexts`);

    // Step 4.5+: Fetch supporting files. These are independent and safe to parallelise.
    // NOTE: This doesn't reduce blob *count*, but it materially reduces wall-clock time.

    const CONCURRENCY_FILES = 10;

    const fetchParameters = async () => {
      // Fetch parameters-index.yaml for path resolution (v1 correctness)
      let parametersIndex: any | null = null;
      try {
        const indexPath = toRepoPath('parameters-index.yaml');
        if (pathToBlob.has(indexPath)) {
          sessionLogService.addChild(logOpId, 'info', 'INDEX_FETCH', 'Fetching parameters-index.yaml...');
          const indexRes = await readTextFileFromTree('parameters-index.yaml');
          parametersIndex = YAML.parse(indexRes.content);
          sessionLogService.addChild(logOpId, 'success', 'INDEX_FETCH_SUCCESS', 'Fetched parameters-index.yaml');
        } else {
          sessionLogService.addChild(logOpId, 'warning', 'INDEX_FETCH_MISSING', 'No parameters-index.yaml (falling back to conventional paths)');
        }
      } catch {
        sessionLogService.addChild(logOpId, 'warning', 'INDEX_FETCH_ERROR', 'Failed to fetch parameters-index.yaml (falling back to conventional paths)');
      }

      const parameters = new Map<string, { data: any; sha?: string; path: string }>();
      if (parameterIds.length === 0) return parameters;

      sessionLogService.addChild(logOpId, 'info', 'PARAMETER_FETCH', `Fetching ${parameterIds.length} parameters...`);
      await mapWithConcurrency(parameterIds, CONCURRENCY_FILES, async (paramId) => {
        const paramsDir = (gitCreds as any)?.paramsPath ? String((gitCreds as any).paramsPath) : 'parameters';
        const fallbackPath = `${paramsDir}/${paramId}.yaml`;
        const rawParamPath = resolveParamPathFromIndex(paramId, parametersIndex, fallbackPath);
        const repoParamPath = toRepoPath(rawParamPath);
        try {
          const result = await readTextFileFromTree(repoParamPath);
          const data = YAML.parse(result.content);
          parameters.set(paramId, { data, sha: result.sha, path: result.path });
        } catch (e) {
          console.warn(`[LiveShareBoot] Failed to fetch parameter ${paramId}:`, e);
        }
      });

      sessionLogService.addChild(logOpId, 'success', 'PARAMETER_FETCH_SUCCESS', `Fetched ${parameters.size}/${parameterIds.length} parameters`);
      return parameters;
    };

    const fetchEvents = async () => {
      const events = new Map<string, { data: any; sha?: string; path: string }>();
      if (eventIds.length === 0) return events;

      // Fetch events-index.yaml for path resolution (mirrors workspace cloning logic).
      let eventsIndex: any | null = null;
      try {
        const indexPath = toRepoPath('events-index.yaml');
        if (pathToBlob.has(indexPath)) {
          sessionLogService.addChild(logOpId, 'info', 'EVENT_INDEX_FETCH', 'Fetching events-index.yaml...');
          const indexRes = await readTextFileFromTree('events-index.yaml');
          eventsIndex = YAML.parse(indexRes.content);
          sessionLogService.addChild(logOpId, 'success', 'EVENT_INDEX_FETCH_SUCCESS', 'Fetched events-index.yaml');
        } else {
          sessionLogService.addChild(logOpId, 'warning', 'EVENT_INDEX_FETCH_MISSING', 'No events-index.yaml (falling back to conventional paths)');
        }
      } catch {
        sessionLogService.addChild(logOpId, 'warning', 'EVENT_INDEX_FETCH_ERROR', 'Failed to fetch events-index.yaml (falling back to conventional paths)');
      }

      const resolveEventPathFromIndex = (eventId: string, index: any | null | undefined, fallback: string): string => {
        const entries: EventIndexEntry[] = (index && Array.isArray((index as any).events)) ? (index as any).events : [];
        const match = entries.find((e) => e?.id === eventId);
        const p = match?.file_path;
        if (typeof p === 'string' && p.trim()) return p.trim();
        return fallback;
      };

      sessionLogService.addChild(logOpId, 'info', 'EVENT_FETCH', `Fetching ${eventIds.length} event definitions...`);
      await mapWithConcurrency(eventIds, CONCURRENCY_FILES, async (eventId) => {
        const eventsDir = (gitCreds as any)?.eventsPath ? String((gitCreds as any).eventsPath) : 'events';
        const fallbackPath = `${eventsDir}/${eventId}.yaml`;
        const rawEventPath = resolveEventPathFromIndex(eventId, eventsIndex, fallbackPath);
        const repoEventPath = toRepoPath(rawEventPath);
        try {
          const result = await readTextFileFromTree(repoEventPath);
          const data = YAML.parse(result.content);
          events.set(eventId, { data, sha: result.sha, path: result.path });
        } catch (e) {
          console.warn(`[LiveShareBoot] Failed to fetch event ${eventId}:`, e);
        }
      });

      sessionLogService.addChild(logOpId, 'success', 'EVENT_FETCH_SUCCESS', `Fetched ${events.size}/${eventIds.length} events`);
      return events;
    };

    const fetchContexts = async () => {
      const contexts = new Map<string, { data: any; sha?: string; path: string }>();
      if (contextKeys.length === 0) return contexts;

      let contextsIndex: any | null = null;
      try {
        const indexPath = toRepoPath('contexts-index.yaml');
        if (pathToBlob.has(indexPath)) {
          sessionLogService.addChild(logOpId, 'info', 'CONTEXT_INDEX_FETCH', 'Fetching contexts-index.yaml...');
          const indexRes = await readTextFileFromTree('contexts-index.yaml');
          contextsIndex = YAML.parse(indexRes.content);
          sessionLogService.addChild(logOpId, 'success', 'CONTEXT_INDEX_FETCH_SUCCESS', 'Fetched contexts-index.yaml');
        } else {
          sessionLogService.addChild(logOpId, 'warning', 'CONTEXT_INDEX_FETCH_MISSING', 'No contexts-index.yaml (falling back to conventional paths)');
        }
      } catch {
        sessionLogService.addChild(logOpId, 'warning', 'CONTEXT_INDEX_FETCH_ERROR', 'Failed to fetch contexts-index.yaml (falling back to conventional paths)');
      }

      const resolveContextPathFromIndex = (contextId: string, index: any | null | undefined, fallback: string): string => {
        const entries = (index && Array.isArray((index as any).contexts)) ? (index as any).contexts : [];
        const match = entries.find((e: any) => e?.id === contextId);
        const p = match?.file_path;
        if (typeof p === 'string' && p.trim()) return p.trim();
        return fallback;
      };

      sessionLogService.addChild(logOpId, 'info', 'CONTEXT_FETCH', `Fetching ${contextKeys.length} contexts...`);
      await mapWithConcurrency(contextKeys, CONCURRENCY_FILES, async (contextId) => {
        const contextsDir = (gitCreds as any)?.contextsPath ? String((gitCreds as any).contextsPath) : 'contexts';
        const fallbackPath = `${contextsDir}/${contextId}.yaml`;
        const rawCtxPath = resolveContextPathFromIndex(contextId, contextsIndex, fallbackPath);
        const repoCtxPath = toRepoPath(rawCtxPath);
        try {
          const result = await readTextFileFromTree(repoCtxPath);
          const data = YAML.parse(result.content);
          contexts.set(contextId, { data, sha: result.sha, path: result.path });
        } catch (e) {
          console.warn(`[LiveShareBoot] Failed to fetch context ${contextId}:`, e);
        }
      });

      sessionLogService.addChild(logOpId, 'success', 'CONTEXT_FETCH_SUCCESS', `Fetched ${contexts.size}/${contextKeys.length} contexts`);
      return contexts;
    };

    const fetchConnections = async () => {
      // Repo connections file is critical for deterministic provider resolution (signature computation).
      // In non-share flows this is seeded from defaults; in live share we prefer repo truth when present.
      try {
        const repoPath = toRepoPath('connections.yaml');
        if (!pathToBlob.has(repoPath)) return undefined;
        sessionLogService.addChild(logOpId, 'info', 'CONNECTIONS_FETCH', 'Fetching connections.yaml...');
        const res = await readTextFileFromTree('connections.yaml');
        const data = YAML.parse(res.content);
        sessionLogService.addChild(logOpId, 'success', 'CONNECTIONS_FETCH_SUCCESS', 'Fetched connections.yaml');
        return { data, sha: res.sha, path: res.path };
      } catch {
        sessionLogService.addChild(logOpId, 'warning', 'CONNECTIONS_FETCH_ERROR', 'Failed to fetch connections.yaml (falling back to defaults)');
        return undefined;
      }
    };

    const fetchSettings = async () => {
      // Fetch shared forecasting settings (repo-committed: settings/settings.yaml)
      // This is required so live share analytics match authoring (e.g. RECENCY_HALF_LIFE_DAYS).
      let settings: { data: any; sha?: string; path: string } | undefined;
      try {
        const settingsRepoPath = toRepoPath('settings/settings.yaml');
        if (pathToBlob.has(settingsRepoPath)) {
          sessionLogService.addChild(logOpId, 'info', 'SETTINGS_FETCH', 'Fetching settings/settings.yaml...');
          const res = await readTextFileFromTree('settings/settings.yaml');
          const data = YAML.parse(res.content);
          settings = { data, sha: res.sha, path: res.path };
          sessionLogService.addChild(logOpId, 'success', 'SETTINGS_FETCH_SUCCESS', 'Fetched settings/settings.yaml');
        } else {
          sessionLogService.addChild(logOpId, 'warning', 'SETTINGS_FETCH_MISSING', 'No settings/settings.yaml found (falling back to defaults)');
        }
      } catch {
        sessionLogService.addChild(logOpId, 'warning', 'SETTINGS_FETCH_ERROR', 'Failed to fetch settings/settings.yaml (falling back to defaults)');
      }
      return settings;
    };

    // Fetch parameters FIRST so we can extract additional context keys from their sliceDSLs.
    // This is necessary because parameter data can reference contexts that aren't visible
    // in the graph DSL or share payload scenario DSLs.
    const [parameters, events, connections, settings, remoteHeadSha] = await Promise.all([
      fetchParameters(),
      fetchEvents(),
      fetchConnections(),
      fetchSettings(),
      remoteHeadShaPromise,
    ]);

    // Extract additional context keys from parameter sliceDSLs
    const contextKeysFromParams = new Set<string>();
    for (const [, paramData] of parameters) {
      const values = paramData?.data?.values;
      if (Array.isArray(values)) {
        for (const v of values) {
          const sliceDSL = v?.sliceDSL;
          if (typeof sliceDSL === 'string') {
            for (const k of extractContextKeysFromDSL(sliceDSL)) {
              contextKeysFromParams.add(k);
            }
          }
        }
      }
    }

    // Merge all context keys and fetch contexts
    const allContextKeys = Array.from(new Set([...contextKeys, ...contextKeysFromParams]));
    if (contextKeysFromParams.size > 0) {
      sessionLogService.addChild(logOpId, 'info', 'CONTEXT_KEYS_FROM_PARAMS', 
        `Found ${contextKeysFromParams.size} additional context keys from parameter sliceDSLs: ${[...contextKeysFromParams].join(', ')}`);
    }

    // Now fetch contexts with the complete key list
    const fetchContextsWithKeys = async (keys: string[]) => {
      const contexts = new Map<string, { data: any; sha?: string; path: string }>();
      if (keys.length === 0) return contexts;

      let contextsIndex: any | null = null;
      try {
        const indexPath = toRepoPath('contexts-index.yaml');
        if (pathToBlob.has(indexPath)) {
          sessionLogService.addChild(logOpId, 'info', 'CONTEXT_INDEX_FETCH', 'Fetching contexts-index.yaml...');
          const indexRes = await readTextFileFromTree('contexts-index.yaml');
          contextsIndex = YAML.parse(indexRes.content);
          sessionLogService.addChild(logOpId, 'success', 'CONTEXT_INDEX_FETCH_SUCCESS', 'Fetched contexts-index.yaml');
        } else {
          sessionLogService.addChild(logOpId, 'warning', 'CONTEXT_INDEX_FETCH_MISSING', 'No contexts-index.yaml (falling back to conventional paths)');
        }
      } catch {
        sessionLogService.addChild(logOpId, 'warning', 'CONTEXT_INDEX_FETCH_ERROR', 'Failed to fetch contexts-index.yaml (falling back to conventional paths)');
      }

      const resolveContextPathFromIndex = (contextId: string, index: any | null | undefined, fallback: string): string => {
        const entries = (index && Array.isArray((index as any).contexts)) ? (index as any).contexts : [];
        const match = entries.find((e: any) => e?.id === contextId);
        const p = match?.file_path;
        if (typeof p === 'string' && p.trim()) return p.trim();
        return fallback;
      };

      sessionLogService.addChild(logOpId, 'info', 'CONTEXT_FETCH', `Fetching ${keys.length} contexts...`);
      await mapWithConcurrency(keys, CONCURRENCY_FILES, async (contextId) => {
        const contextsDir = (gitCreds as any)?.contextsPath ? String((gitCreds as any).contextsPath) : 'contexts';
        const fallbackPath = `${contextsDir}/${contextId}.yaml`;
        const rawCtxPath = resolveContextPathFromIndex(contextId, contextsIndex, fallbackPath);
        const repoCtxPath = toRepoPath(rawCtxPath);
        try {
          const result = await readTextFileFromTree(repoCtxPath);
          const data = YAML.parse(result.content);
          contexts.set(contextId, { data, sha: result.sha, path: result.path });
        } catch (e) {
          console.warn(`[LiveShareBoot] Failed to fetch context ${contextId}:`, e);
        }
      });

      sessionLogService.addChild(logOpId, 'success', 'CONTEXT_FETCH_SUCCESS', `Fetched ${contexts.size}/${keys.length} contexts`);
      return contexts;
    };

    const contexts = await fetchContextsWithKeys(allContextKeys);
    
    sessionLogService.endOperation(logOpId, 'success', 
      `Live boot complete: graph + ${parameters.size} parameters + ${events.size} events + ${contexts.size} contexts`);
    
    return {
      success: true,
      graphData,
      graphSha,
      graphPath,
      remoteHeadSha,
      parameters,
      events,
      connections,
      contexts,
      settings,
      identity: { repo, branch, graph },
    };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    sessionLogService.endOperation(logOpId, 'error', `Live boot failed: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

/**
 * Check if live share boot is needed (i.e. we're in live mode).
 */
export function needsLiveShareBoot(): boolean {
  const config = getShareBootConfig();
  return config.mode === 'live';
}

/**
 * Service singleton for dependency injection in tests.
 */
class LiveShareBootService {
  performBoot = performLiveShareBoot;
  needsBoot = needsLiveShareBoot;
}

export const liveShareBootService = new LiveShareBootService();
