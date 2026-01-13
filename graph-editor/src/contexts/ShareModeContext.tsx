/**
 * ShareModeContext
 * 
 * Provides a centralised share mode signal to the component tree.
 * Used by editors and panels to enforce read-only behaviour in static share mode.
 * 
 * Share modes:
 * - 'none': Normal workspace mode (full editing)
 * - 'static': Static share link (read-only, view inspection only)
 * - 'live': Live share link (full editing after credentials unlock)
 */

import React, { createContext, useContext, useMemo } from 'react';
import { getShareBootConfig, ShareMode, ShareBootConfig } from '../lib/shareBootResolver';

interface ShareModeContextValue {
  /** Current share mode */
  mode: ShareMode;
  
  /** Full boot config (includes identity params) */
  bootConfig: ShareBootConfig;
  
  /** True if in any share mode (static or live) */
  isShareMode: boolean;
  
  /** True if in static share mode (read-only) */
  isStaticMode: boolean;
  
  /** True if in live share mode */
  isLiveMode: boolean;
  
  /** True if editing should be disabled (static mode only) */
  isReadOnly: boolean;
  
  /** Identity params for upgrade-to-live (may be undefined) */
  identity: {
    repo?: string;
    branch?: string;
    graph?: string;
  };
  
  /** Secret param if present (for credential unlock) */
  secret?: string;
}

const ShareModeContext = createContext<ShareModeContextValue | null>(null);

/**
 * ShareModeProvider
 * 
 * Wraps the app and provides share mode state derived from boot config.
 */
export function ShareModeProvider({ children }: { children: React.ReactNode }) {
  const value = useMemo<ShareModeContextValue>(() => {
    const bootConfig = getShareBootConfig();
    const mode = bootConfig.mode;
    
    return {
      mode,
      bootConfig,
      isShareMode: mode !== 'none',
      isStaticMode: mode === 'static',
      isLiveMode: mode === 'live',
      isReadOnly: mode === 'static', // Only static mode is read-only; live mode allows editing
      identity: {
        repo: bootConfig.repo,
        branch: bootConfig.branch,
        graph: bootConfig.graph,
      },
      secret: bootConfig.secret,
    };
  }, []); // Boot config is resolved once at startup, never changes
  
  return (
    <ShareModeContext.Provider value={value}>
      {children}
    </ShareModeContext.Provider>
  );
}

/**
 * Hook to access share mode context.
 * Throws if used outside ShareModeProvider.
 */
export function useShareMode(): ShareModeContextValue {
  const context = useContext(ShareModeContext);
  if (!context) {
    throw new Error('useShareMode must be used within a ShareModeProvider');
  }
  return context;
}

/**
 * Hook to access share mode context, returning null if not in provider.
 * Useful for components that may render outside the provider (e.g. tests).
 */
export function useShareModeOptional(): ShareModeContextValue | null {
  return useContext(ShareModeContext);
}

/**
 * Convenience hook: returns true if current session is read-only (static share mode).
 */
export function useIsReadOnlyShare(): boolean {
  const context = useShareModeOptional();
  return context?.isReadOnly ?? false;
}
