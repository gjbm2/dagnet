/**
 * useShareLink Hook
 * 
 * Centralised hook for share link operations on graphs and charts.
 * Provides both static and live share link generation.
 * 
 * Static share: Embeds graph data in URL - self-contained snapshot
 * Live share: Points to repo/branch/graph - fetches latest on load
 */

import { useCallback, useMemo } from 'react';
import { fileRegistry } from '../contexts/TabContext';
import { shareLinkService, extractIdentityFromFileSource, resolveShareSecretForLinkGeneration } from '../services/shareLinkService';
import { useIsReadOnlyShare } from '../contexts/ShareModeContext';
import { sessionLogService } from '../services/sessionLogService';
import toast from 'react-hot-toast';

export interface UseShareLinkResult {
  /** Whether share links can be generated for this file */
  canShare: boolean;
  
  /** Whether static share is available */
  canShareStatic: boolean;
  
  /** Whether live share is available (requires identity + secret) */
  canShareLive: boolean;
  
  /** Copy static share link to clipboard */
  copyStaticShareLink: () => Promise<void>;
  
  /** Copy live share link to clipboard */
  copyLiveShareLink: () => Promise<void>;
  
  /** Reason why live share is unavailable (if canShareLive is false) */
  liveShareUnavailableReason?: string;
}

/**
 * Hook for generating share links for a file.
 * 
 * @param fileId - The file ID to generate share links for
 */
export function useShareLink(fileId: string | undefined): UseShareLinkResult {
  const isReadOnlyShare = useIsReadOnlyShare();
  
  // Determine if this is a shareable file type
  const isShareableType = useMemo(() => {
    if (!fileId) return false;
    return fileId.startsWith('graph-') || fileId.startsWith('chart-');
  }, [fileId]);
  
  // Get file and extract identity
  const fileInfo = useMemo(() => {
    if (!fileId) return null;
    const file = fileRegistry.getFile(fileId);
    if (!file?.data) return null;
    
    const identity = extractIdentityFromFileSource(file.source);
    return { file, identity };
  }, [fileId]);
  
  const urlSecrets = useMemo(() => {
    if (typeof window === 'undefined') return { secret: null as string | null, creds: null as string | null };
    const params = new URLSearchParams(window.location.search);

    const envSecret = resolveShareSecretForLinkGeneration();

    return {
      secret: params.get('secret') || envSecret,
      creds: params.get('creds'),
    };
  }, []);

  // Check if live share is possible
  const liveShareCheck = useMemo(() => {
    if (!fileInfo?.identity) {
      return { canLive: false, reason: 'No repository identity - file may be local-only' };
    }
    
    const { repo, branch, graph } = fileInfo.identity;
    if (!repo || !branch || !graph) {
      return { canLive: false, reason: 'Missing repo/branch/graph identity' };
    }
    
    // Live share links currently require:
    // - ?secret=... (system secret gate)
    //
    // We deliberately do NOT try to derive a secret from IndexedDB credentials.
    if (urlSecrets.secret) {
      return { canLive: true, reason: undefined };
    }

    return { canLive: false, reason: 'No share secret available (set SHARE_SECRET or open with ?secret=…)' };
  }, [fileInfo, urlSecrets]);
  
  const canShare = isShareableType && !isReadOnlyShare && !!fileInfo;
  const canShareStatic = canShare;
  const canShareLive = canShare && liveShareCheck.canLive;
  
  // Copy static share link
  const copyStaticShareLink = useCallback(async () => {
    if (!fileInfo) {
      toast.error('No file data available');
      return;
    }
    
    try {
      const url = shareLinkService.buildStaticShareUrl({
        graphData: fileInfo.file.data,
        identity: fileInfo.identity,
      });
      
      await navigator.clipboard.writeText(url);
      toast.success('Static share link copied!');
      
      sessionLogService.success('session', 'SHARE_STATIC_LINK_COPIED',
        `Static share link copied for: ${fileId}`);
    } catch (error) {
      console.error('Failed to create static share link:', error);
      toast.error('Failed to copy share link');
    }
  }, [fileInfo, fileId]);
  
  // Copy live share link
  const copyLiveShareLink = useCallback(async () => {
    if (!fileInfo?.identity) {
      toast.error('No repository identity available');
      return;
    }
    
    const { repo, branch, graph } = fileInfo.identity;
    if (!repo || !branch || !graph) {
      toast.error('Missing repository identity');
      return;
    }
    
    try {
      const secret = urlSecrets.secret;
      if (!secret) {
        toast.error('No URL secret available for live share');
        return;
      }

      const url = shareLinkService.buildLiveShareUrl({
        repo,
        branch,
        graph,
        secret,
      });
      
      await navigator.clipboard.writeText(url);
      toast.success('Live share link copied!');
      
      sessionLogService.success('session', 'SHARE_LIVE_LINK_COPIED',
        `Live share link copied for: ${repo}/${branch}/${graph}`);
    } catch (error) {
      console.error('Failed to create live share link:', error);
      toast.error('Failed to copy live share link');
    }
  }, [fileInfo, urlSecrets]);
  
  return {
    canShare,
    canShareStatic,
    canShareLive,
    copyStaticShareLink,
    copyLiveShareLink,
    liveShareUnavailableReason: liveShareCheck.reason,
  };
}
