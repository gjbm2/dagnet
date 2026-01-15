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
import { graphGitService } from './graphGitService';
import { credentialsManager } from '../lib/credentials';
import { sessionLogService } from './sessionLogService';
import { collectGraphDependencies, getMinimalParameterIds } from '../lib/dependencyClosure';
import { getShareBootConfig, ShareBootConfig } from '../lib/shareBootResolver';
import { decodeSharePayloadFromUrl } from '../lib/sharePayload';
import { parseConstraints } from '../lib/queryDSL';
import YAML from 'yaml';

type ParameterIndexEntry = { id: string; file_path?: string };

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

  // Fetched context files (on success)
  contexts?: Map<string, { data: any; sha?: string; path: string }>;

  // Fetched shared settings file (on success)
  settings?: { data: any; sha?: string; path: string };
  
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

    // Step 2.5: Fetch remote HEAD SHA (commit) for staleness tracking
    let remoteHeadSha: string | null = null;
    try {
      remoteHeadSha = await gitService.getRemoteHeadSha(branch);
    } catch {
      // Best-effort only; do not fail boot/refresh on HEAD lookup.
      remoteHeadSha = null;
    }
    
    // Step 3: Fetch graph
    sessionLogService.addChild(logOpId, 'info', 'GRAPH_FETCH', `Fetching graph: ${graph}`);
    
    const graphResult = await graphGitService.getGraph(graph, branch);
    if (!graphResult.success || !graphResult.data) {
      sessionLogService.endOperation(logOpId, 'error', `Graph fetch failed: ${graphResult.error}`);
      return { success: false, error: `Failed to fetch graph: ${graphResult.error}` };
    }
    
    const graphData = graphResult.data.content;
    const graphSha = graphResult.data.sha;
    const graphPath = graphResult.data.path;
    
    sessionLogService.addChild(logOpId, 'success', 'GRAPH_FETCH_SUCCESS', 
      `Fetched graph: ${graphData?.nodes?.length || 0} nodes, SHA: ${graphSha?.substring(0, 8)}`);
    
    // Step 4: Compute dependency closure
    const deps = collectGraphDependencies(graphData);
    const parameterIds = Array.from(deps.parameterIds);
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
      `Dependency closure: ${parameterIds.length} parameters, ${contextKeys.length} contexts`);

    // Step 4.5: Fetch parameters-index.yaml for path resolution (v1 correctness)
    let parametersIndex: any | null = null;
    try {
      sessionLogService.addChild(logOpId, 'info', 'INDEX_FETCH', 'Fetching parameters-index.yaml...');
      const indexRes = await gitService.getFileContent('parameters-index.yaml', branch);
      if (indexRes.success && indexRes.data?.content) {
        parametersIndex = YAML.parse(indexRes.data.content);
        sessionLogService.addChild(logOpId, 'success', 'INDEX_FETCH_SUCCESS', 'Fetched parameters-index.yaml');
      } else {
        sessionLogService.addChild(logOpId, 'warning', 'INDEX_FETCH_MISSING', 'No parameters-index.yaml (falling back to conventional paths)');
      }
    } catch (e) {
      sessionLogService.addChild(logOpId, 'warning', 'INDEX_FETCH_ERROR', 'Failed to fetch parameters-index.yaml (falling back to conventional paths)');
    }
    
    // Step 5: Fetch parameters (minimal set for v1)
    const parameters = new Map<string, { data: any; sha?: string; path: string }>();
    
    if (parameterIds.length > 0) {
      sessionLogService.addChild(logOpId, 'info', 'PARAMETER_FETCH', 
        `Fetching ${parameterIds.length} parameters...`);
      
      // Fetch parameters in parallel with concurrency limit
      const CONCURRENCY = 5;
      const fetchParam = async (paramId: string) => {
        const fallbackPath = `parameters/${paramId}.yaml`;
        const paramPath = resolveParamPathFromIndex(paramId, parametersIndex, fallbackPath);
        try {
          const result = await gitService.getFileContent(paramPath, branch);
          if (result.success && result.data?.content) {
            const data = YAML.parse(result.data.content);
            parameters.set(paramId, {
              data,
              sha: result.data.sha,
              path: paramPath,
            });
          } else if (paramPath !== fallbackPath) {
            // Try conventional path as fallback when index path fails
            const fallbackRes = await gitService.getFileContent(fallbackPath, branch);
            if (fallbackRes.success && fallbackRes.data?.content) {
              const data = YAML.parse(fallbackRes.data.content);
              parameters.set(paramId, {
                data,
                sha: fallbackRes.data.sha,
                path: fallbackPath,
              });
            }
          }
        } catch (e) {
          console.warn(`[LiveShareBoot] Failed to fetch parameter ${paramId}:`, e);
        }
      };
      
      // Process in batches
      for (let i = 0; i < parameterIds.length; i += CONCURRENCY) {
        const batch = parameterIds.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(fetchParam));
      }
      
      sessionLogService.addChild(logOpId, 'success', 'PARAMETER_FETCH_SUCCESS', 
        `Fetched ${parameters.size}/${parameterIds.length} parameters`);
    }

    // Step 6: Fetch contexts (needed for MECE policies / context value sets in share mode)
    const contexts = new Map<string, { data: any; sha?: string; path: string }>();
    if (contextKeys.length > 0) {
      let contextsIndex: any | null = null;
      try {
        sessionLogService.addChild(logOpId, 'info', 'CONTEXT_INDEX_FETCH', 'Fetching contexts-index.yaml...');
        const indexRes = await gitService.getFileContent('contexts-index.yaml', branch);
        if (indexRes.success && indexRes.data?.content) {
          contextsIndex = YAML.parse(indexRes.data.content);
          sessionLogService.addChild(logOpId, 'success', 'CONTEXT_INDEX_FETCH_SUCCESS', 'Fetched contexts-index.yaml');
        } else {
          sessionLogService.addChild(logOpId, 'warning', 'CONTEXT_INDEX_FETCH_MISSING', 'No contexts-index.yaml (falling back to conventional paths)');
        }
      } catch (e) {
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
      const CONCURRENCY_CTX = 5;
      const fetchCtx = async (contextId: string) => {
        const fallbackPath = `contexts/${contextId}.yaml`;
        const ctxPath = resolveContextPathFromIndex(contextId, contextsIndex, fallbackPath);
        try {
          const result = await gitService.getFileContent(ctxPath, branch);
          if (result.success && result.data?.content) {
            const data = YAML.parse(result.data.content);
            contexts.set(contextId, { data, sha: result.data.sha, path: ctxPath });
          } else if (ctxPath !== fallbackPath) {
            const fallbackRes = await gitService.getFileContent(fallbackPath, branch);
            if (fallbackRes.success && fallbackRes.data?.content) {
              const data = YAML.parse(fallbackRes.data.content);
              contexts.set(contextId, { data, sha: fallbackRes.data.sha, path: fallbackPath });
            }
          }
        } catch (e) {
          console.warn(`[LiveShareBoot] Failed to fetch context ${contextId}:`, e);
        }
      };

      for (let i = 0; i < contextKeys.length; i += CONCURRENCY_CTX) {
        const batch = contextKeys.slice(i, i + CONCURRENCY_CTX);
        await Promise.all(batch.map(fetchCtx));
      }

      sessionLogService.addChild(logOpId, 'success', 'CONTEXT_FETCH_SUCCESS', `Fetched ${contexts.size}/${contextKeys.length} contexts`);
    }

    // Step 7: Fetch shared forecasting settings (repo-committed: settings/settings.yaml)
    // This is required so live share analytics match authoring (e.g. RECENCY_HALF_LIFE_DAYS).
    let settings: { data: any; sha?: string; path: string } | undefined;
    try {
      const settingsPath = 'settings/settings.yaml';
      sessionLogService.addChild(logOpId, 'info', 'SETTINGS_FETCH', 'Fetching settings/settings.yaml...');
      const res = await gitService.getFileContent(settingsPath, branch);
      if (res.success && res.data?.content) {
        const data = YAML.parse(res.data.content);
        settings = { data, sha: res.data.sha, path: settingsPath };
        sessionLogService.addChild(logOpId, 'success', 'SETTINGS_FETCH_SUCCESS', 'Fetched settings/settings.yaml');
      } else {
        sessionLogService.addChild(logOpId, 'warning', 'SETTINGS_FETCH_MISSING', 'No settings/settings.yaml found (falling back to defaults)');
      }
    } catch {
      sessionLogService.addChild(logOpId, 'warning', 'SETTINGS_FETCH_ERROR', 'Failed to fetch settings/settings.yaml (falling back to defaults)');
    }
    
    sessionLogService.endOperation(logOpId, 'success', 
      `Live boot complete: graph + ${parameters.size} parameters + ${contexts.size} contexts`);
    
    return {
      success: true,
      graphData,
      graphSha,
      graphPath,
      remoteHeadSha,
      parameters,
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
