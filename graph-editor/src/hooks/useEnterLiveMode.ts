/**
 * useEnterLiveMode Hook
 * 
 * Provides functionality to transition from a static share view to live mode.
 * This is used when a user is viewing a ?data= static share and wants to
 * fetch the latest graph from GitHub.
 * 
 * Requirements:
 * - Must be in static share mode
 * - Identity metadata (repo/branch/graph) must be available
 * - Secret must be available (either in URL or from credentials)
 */

import { useCallback, useMemo } from 'react';
import { useShareMode } from '../contexts/ShareModeContext';
import { buildLiveShareUrl, resolveShareSecretForLinkGeneration } from '../services/shareLinkService';
import { sessionLogService } from '../services/sessionLogService';

export interface EnterLiveModeResult {
  /** Whether entering live mode is possible */
  canEnterLiveMode: boolean;
  /** Reason why live mode cannot be entered (if canEnterLiveMode is false) */
  reason?: string;
  /** Function to trigger the transition */
  enterLiveMode: () => void;
  /** Identity metadata available for transition */
  identity?: {
    repo?: string;
    branch?: string;
    graph?: string;
  };
}

/**
 * Hook to manage the static-to-live mode transition.
 */
export function useEnterLiveMode(): EnterLiveModeResult {
  const shareMode = useShareMode();
  
  const canEnterLiveMode = useMemo(() => {
    // Must be in static share mode
    if (!shareMode.isStaticMode) return false;
    
    // Must have identity metadata
    const { repo, branch, graph } = shareMode.identity;
    if (!repo || !branch || !graph) return false;
    
    // Must have a secret (URL or env)
    const secret = shareMode.secret || resolveShareSecretForLinkGeneration();
    if (!secret) return false;
    
    return true;
  }, [shareMode.isStaticMode, shareMode.identity, shareMode.secret]);
  
  const reason = useMemo(() => {
    if (!shareMode.isStaticMode) {
      return 'Not in static share mode';
    }
    
    const { repo, branch, graph } = shareMode.identity;
    if (!repo || !branch || !graph) {
      return 'Missing identity metadata (repo/branch/graph) - this static link cannot be upgraded to live mode';
    }
    
    if (!(shareMode.secret || resolveShareSecretForLinkGeneration())) {
      return 'No secret available - live mode requires a secret for authentication';
    }
    
    return undefined;
  }, [shareMode.isStaticMode, shareMode.identity, shareMode.secret]);
  
  const enterLiveMode = useCallback(() => {
    if (!canEnterLiveMode) {
      console.warn('[useEnterLiveMode] Cannot enter live mode:', reason);
      return;
    }
    
    const { repo, branch, graph } = shareMode.identity;
    const secret = shareMode.secret || resolveShareSecretForLinkGeneration() || undefined;
    
    if (!repo || !branch || !graph || !secret) {
      console.error('[useEnterLiveMode] Missing required params');
      return;
    }
    
    sessionLogService.info('session', 'ENTER_LIVE_MODE', 
      `Transitioning to live mode: ${repo}/${branch}/${graph}`);
    
    // Build live share URL
    const liveUrl = buildLiveShareUrl({
      repo,
      branch,
      graph,
      secret,
    });
    
    // Navigate to live URL (full page reload to reinitialise with live mode boot)
    window.location.href = liveUrl;
  }, [canEnterLiveMode, reason, shareMode.identity, shareMode.secret]);
  
  return {
    canEnterLiveMode,
    reason,
    enterLiveMode,
    identity: shareMode.identity,
  };
}
