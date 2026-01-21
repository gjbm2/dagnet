import React from 'react';
import { useAutomationRunState } from '../hooks/useAutomationRunState';
import { automationRunService } from '../services/automationRunService';
import { bannerManagerService } from '../services/bannerManagerService';

export function AutomationBanner(): React.ReactElement | null {
  const state = useAutomationRunState();

  React.useEffect(() => {
    if (state.phase === 'idle') {
      bannerManagerService.clearBanner('automation');
      return;
    }

    const label =
      state.phase === 'waiting'
        ? 'Automation running (waiting for app to initialise)'
        : state.phase === 'countdown'
          ? `Automation starting in ${state.countdownSecondsRemaining ?? 0}s…`
          : state.phase === 'stopping'
            ? 'Automation stopping…'
            : 'Automation running';

    const detail = state.graphName ? `Graph: ${state.graphName}` : state.graphFileId ? `Graph: ${state.graphFileId}` : '';

    bannerManagerService.setBanner({
      id: 'automation',
      priority: 100,
      label,
      detail,
      actionLabel: 'Stop',
      onAction: () => automationRunService.requestStop(),
      actionDisabled: state.phase === 'stopping',
      actionTitle: 'Stop automation (will abort between steps and between retrieve items)',
    });

    return () => {
      // Best-effort cleanup on unmount.
      bannerManagerService.clearBanner('automation');
    };
  }, [
    state.phase,
    state.countdownSecondsRemaining,
    state.graphName,
    state.graphFileId,
  ]);

  // Render nothing; BannerHost owns banner rendering.
  return null;
}


