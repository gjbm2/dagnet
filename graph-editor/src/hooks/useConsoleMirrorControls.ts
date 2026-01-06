import { useCallback, useEffect, useMemo, useState } from 'react';
import { consoleMirrorService } from '../services/consoleMirrorService';
import { sessionLogService } from '../services/sessionLogService';
import { sessionLogMirrorService } from '../services/sessionLogMirrorService';

type ConsoleMirrorControls = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  sendMark: (label: string) => void;
};

/**
 * UI hook for console mirroring controls (dev-only).
 *
 * Keeps Menu/UI components as access points only; all behaviour is delegated to services.
 */
export function useConsoleMirrorControls(): ConsoleMirrorControls {
  const [enabled, setEnabledState] = useState<boolean>(() => consoleMirrorService.isEnabled());

  // Keep UI in sync if something else toggles it (e.g. DevTools commands).
  useEffect(() => {
    const sync = () => setEnabledState(consoleMirrorService.isEnabled());
    const id = window.setInterval(sync, 500);
    return () => window.clearInterval(id);
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    if (next) {
      consoleMirrorService.enable();
      sessionLogMirrorService.enable();
      // Mark start in BOTH streams
      void consoleMirrorService.markNow('log sync start');
      sessionLogService.info('session', 'DEV_LOG_SYNC_START', 'log sync start');
    } else {
      // Mark stop in BOTH streams while mirroring is still enabled
      void consoleMirrorService.markNow('log sync stop');
      sessionLogService.info('session', 'DEV_LOG_SYNC_STOP', 'log sync stop');
      consoleMirrorService.disable();
      sessionLogMirrorService.disable();
    }
    setEnabledState(consoleMirrorService.isEnabled());
  }, []);

  const sendMark = useCallback((label: string) => {
    consoleMirrorService.mark(label);
    // Mirror mark into session log as well, so it appears in both streams.
    sessionLogService.info('session', 'DEV_MARK', label);
  }, []);

  return useMemo(
    () => ({
      enabled,
      setEnabled,
      sendMark,
    }),
    [enabled, setEnabled, sendMark]
  );
}


