/**
 * Boot Progress Hook
 *
 * Registers an indeterminate "loading" operation during app boot so the
 * OperationsToast shows that initialisation is in progress. Completes
 * when BOTH TabContext init AND NavigatorContext file loading are done.
 */

import { useEffect, useRef } from 'react';
import { operationRegistryService } from '../services/operationRegistryService';

const BOOT_OP_ID = 'app:boot';

export function useBootProgress(): void {
  const registered = useRef(false);

  useEffect(() => {
    // Don't register if TabContext already finished (e.g. hot reload).
    try {
      if ((window as any).__dagnetTabContextInitDone) return;
    } catch {
      return;
    }

    if (registered.current) return;
    registered.current = true;

    operationRegistryService.register({
      id: BOOT_OP_ID,
      kind: 'boot',
      label: 'Loading workspace…',
      status: 'running',
    });

    let tabContextDone = false;
    let navigatorDone = false;

    const tryComplete = () => {
      if (tabContextDone && navigatorDone) {
        operationRegistryService.setLabel(BOOT_OP_ID, 'Workspace ready');
        operationRegistryService.complete(BOOT_OP_ID, 'complete');
      }
    };

    const onTabContextDone = () => {
      tabContextDone = true;
      operationRegistryService.setLabel(BOOT_OP_ID, 'Loading files…');
      tryComplete();
    };

    const onNavigatorProgress = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      switch (detail.stage) {
        case 'workspace-check':
          operationRegistryService.setLabel(BOOT_OP_ID, 'Checking workspace…');
          break;
        case 'sync-done':
          operationRegistryService.setLabel(BOOT_OP_ID, 'Loading files…');
          break;
        case 'files-loaded':
          if (detail.fileCount != null) {
            operationRegistryService.setLabel(BOOT_OP_ID, `Loading ${detail.fileCount} files…`);
          }
          break;
      }
    };

    const onNavigatorDone = () => {
      navigatorDone = true;
      tryComplete();
    };

    window.addEventListener('dagnet:tabContextInitDone', onTabContextDone);
    window.addEventListener('dagnet:navigatorLoadProgress', onNavigatorProgress);
    window.addEventListener('dagnet:navigatorLoadComplete', onNavigatorDone as EventListener);

    return () => {
      window.removeEventListener('dagnet:tabContextInitDone', onTabContextDone);
      window.removeEventListener('dagnet:navigatorLoadProgress', onNavigatorProgress);
      window.removeEventListener('dagnet:navigatorLoadComplete', onNavigatorDone as EventListener);
      // If unmounting before init done, clean up.
      const op = operationRegistryService.get(BOOT_OP_ID);
      if (op && op.status === 'running') {
        operationRegistryService.remove(BOOT_OP_ID);
      }
    };
  }, []);
}
