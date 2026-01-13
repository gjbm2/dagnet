/**
 * Share Boot Resolver
 * 
 * Detects share mode from URL parameters and computes the appropriate
 * IndexedDB database name. This runs BEFORE the app initialises to ensure
 * share sessions use isolated storage.
 * 
 * Share modes:
 * - 'none': Normal workspace mode (use default DB)
 * - 'static': Static share link (?data= or ?mode=static)
 * - 'live': Live share link (?mode=live)
 */

export type ShareMode = 'none' | 'static' | 'live';

export interface ShareBootConfig {
  mode: ShareMode;
  dbName: string;
  
  // Identity params (for live mode and static-to-live upgrade)
  repo?: string;
  branch?: string;
  graph?: string;
  secret?: string;
  
  // Static data (for static mode)
  hasDataParam: boolean;
}

/** Default workspace DB name */
const WORKSPACE_DB_NAME = 'DagNetGraphEditor';

/** Prefix for live share DBs */
const LIVE_SHARE_DB_PREFIX = 'DagNetGraphEditorShare:';

/**
 * Compute a stable, short hash for the scope key.
 * Uses a simple djb2 hash - good enough for DB name differentiation.
 */
function hashScopeKey(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  // Convert to unsigned 32-bit and then to base36 for compactness
  return (hash >>> 0).toString(36);
}

/**
 * Compute the scoped DB name for a live share session.
 * Uses repo/branch/graph to ensure different live shares don't collide.
 */
function computeLiveShareDbName(repo: string, branch: string, graph: string): string {
  const normalised = `${repo}/${branch}/${graph}`.toLowerCase();
  const hash = hashScopeKey(normalised);
  // Include a readable prefix for debugging
  const prefix = repo.substring(0, 8).replace(/[^a-zA-Z0-9]/g, '');
  return `${LIVE_SHARE_DB_PREFIX}${prefix}-${hash}`;
}

/**
 * Resolve share boot configuration from current URL.
 * 
 * This function is synchronous and reads window.location.search directly.
 * It must be called BEFORE IndexedDB is initialised.
 */
export function resolveShareBootConfig(): ShareBootConfig {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    // Fallback for environments without window (SSR, tests)
    return {
      mode: 'none',
      dbName: WORKSPACE_DB_NAME,
      hasDataParam: false,
    };
  }
  
  const modeParam = params.get('mode');
  const dataParam = params.get('data');
  const repo = params.get('repo') || undefined;
  const branch = params.get('branch') || undefined;
  const graph = params.get('graph') || undefined;
  const secret = params.get('secret') || undefined;
  
  // Explicit live mode
  if (modeParam === 'live') {
    // Live mode requires identity params for scoped DB
    if (repo && branch && graph) {
      return {
        mode: 'live',
        dbName: computeLiveShareDbName(repo, branch, graph),
        repo,
        branch,
        graph,
        secret,
        hasDataParam: !!dataParam,
      };
    }
    // Live mode without identity - fall back to static if data present, else workspace
    console.warn('[ShareBootResolver] mode=live but missing repo/branch/graph params');
    if (dataParam) {
      return {
        mode: 'static',
        dbName: WORKSPACE_DB_NAME, // Static shares don't need isolated DB - they're ephemeral
        repo,
        branch,
        graph,
        secret,
        hasDataParam: true,
      };
    }
    return {
      mode: 'none',
      dbName: WORKSPACE_DB_NAME,
      hasDataParam: false,
    };
  }
  
  // Explicit static mode or legacy ?data= link
  if (modeParam === 'static' || dataParam) {
    return {
      mode: 'static',
      dbName: WORKSPACE_DB_NAME, // Static shares are ephemeral, use workspace DB but don't persist
      repo,
      branch,
      graph,
      secret,
      hasDataParam: !!dataParam,
    };
  }
  
  // No share params - normal workspace mode
  return {
    mode: 'none',
    dbName: WORKSPACE_DB_NAME,
    hasDataParam: false,
  };
}

/**
 * Global boot config - resolved once at startup.
 * Exported for use by other modules that need to know the share mode.
 */
let _bootConfig: ShareBootConfig | null = null;

export function getShareBootConfig(): ShareBootConfig {
  if (!_bootConfig) {
    _bootConfig = resolveShareBootConfig();
    console.log('[ShareBootResolver] Resolved boot config:', _bootConfig);
  }
  return _bootConfig;
}

/**
 * Check if we're in any share mode (static or live).
 */
export function isShareMode(): boolean {
  return getShareBootConfig().mode !== 'none';
}

/**
 * Check if we're in static share mode.
 */
export function isStaticShareMode(): boolean {
  return getShareBootConfig().mode === 'static';
}

/**
 * Check if we're in live share mode.
 */
export function isLiveShareMode(): boolean {
  return getShareBootConfig().mode === 'live';
}

/**
 * Get the resolved DB name for this session.
 */
export function getShareDbName(): string {
  return getShareBootConfig().dbName;
}
