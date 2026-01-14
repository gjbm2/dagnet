import { useCallback, useEffect, useMemo, useState } from 'react';
import { APP_VERSION } from '../version';
import { stalenessNudgeService } from '../services/stalenessNudgeService';

export interface AppUpdateAvailableState {
  isUpdateAvailable: boolean;
  localVersion: string;
  remoteVersion?: string;
  refreshNow: () => Promise<void>;
  reloadNow: () => void;
}

/**
 * Exposes a simple "is a newer deployed client available?" signal for UI chrome.
 *
 * Source of truth:
 * - local: APP_VERSION (package.json at build time)
 * - remote: public/version.json (fetched with no-store, rate-limited in stalenessNudgeService)
 */
export function useAppUpdateAvailable(): AppUpdateAvailableState {
  const [remoteVersion, setRemoteVersion] = useState<string | undefined>(() => {
    return stalenessNudgeService.getCachedRemoteAppVersion(window.localStorage);
  });

  const refreshNow = useCallback(async () => {
    const now = Date.now();
    const storage = window.localStorage;
    await stalenessNudgeService.refreshRemoteAppVersionIfDue(now, storage);
    setRemoteVersion(stalenessNudgeService.getCachedRemoteAppVersion(storage));
  }, []);

  // Keep it responsive: check on mount + focus. The service itself rate-limits the network call.
  useEffect(() => {
    void refreshNow();
    const onFocus = () => void refreshNow();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshNow]);

  // Also respond if another tab updates the cached remote version.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'dagnet:staleness:lastSeenRemoteAppVersion') {
        setRemoteVersion(e.newValue || undefined);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const isUpdateAvailable = useMemo(() => {
    return stalenessNudgeService.isRemoteAppVersionNewerThanLocal(APP_VERSION, window.localStorage);
  }, [remoteVersion]);

  const reloadNow = useCallback(() => {
    // Keep action centralised in a hook so menu components stay access-only.
    if (typeof window !== 'undefined' && window.location?.reload) {
      window.location.reload();
    }
  }, []);

  return {
    isUpdateAvailable,
    localVersion: APP_VERSION,
    remoteVersion,
    refreshNow,
    reloadNow,
  };
}


