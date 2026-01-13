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
  
  // Suppress staleness/safety nudges
  url.searchParams.set('nonudge', '1');

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

/**
 * Service singleton for dependency injection in tests.
 */
class ShareLinkService {
  buildStaticShareUrl = buildStaticShareUrl;
  buildLiveShareUrl = buildLiveShareUrl;
  extractIdentityFromFileSource = extractIdentityFromFileSource;
  resolveShareSecretForLinkGeneration = resolveShareSecretForLinkGeneration;
}

export const shareLinkService = new ShareLinkService();
