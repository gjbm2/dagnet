import React from 'react';
import { useBayesTrigger } from '../../hooks/useBayesTrigger';
import type { BayesTriggerStatus } from '../../hooks/useBayesTrigger';
import './MenuBar.css';

/**
 * Dev-only button for triggering a Bayes roundtrip.
 *
 * Positioned in MenuBar's dagnet-right-controls, next to DevConsoleMirrorControls.
 * Behaviour lives in useBayesTrigger; this component is a thin access point.
 */
export function DevBayesTrigger() {
  const { status, jobId, error, trigger } = useBayesTrigger();

  if (!import.meta.env.DEV) return null;

  const statusLabel: Record<BayesTriggerStatus, string> = {
    idle: 'Bayes',
    submitting: 'Submitting…',
    running: 'Running…',
    complete: 'Done',
    failed: 'Failed',
  };

  const isActive = status === 'submitting' || status === 'running';

  return (
    <button
      className={`dagnet-dev-bayes-btn dagnet-dev-bayes-btn--${status}`}
      onClick={trigger}
      disabled={isActive}
      type="button"
      title={
        error
          ? `Last error: ${error}`
          : jobId
            ? `Last job: ${jobId}`
            : 'Submit a Bayes fit for the active graph'
      }
    >
      {statusLabel[status]}
    </button>
  );
}
