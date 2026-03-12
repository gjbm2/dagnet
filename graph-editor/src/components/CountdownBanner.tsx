import React, { useCallback } from 'react';
import { useOperation } from '../hooks/useOperations';
import { operationRegistryService } from '../services/operationRegistryService';
import './CountdownBanner.css';

export function CountdownBanner(props: {
  label: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  actionTitle?: string;
  /** Optional top offset (px) when multiple banners may stack. */
  topPx?: number;
  /** Optional z-index override (defaults to 2000). */
  zIndex?: number;
  /** Link to an operation in the registry for countdown bar + pause/resume. */
  operationId?: string;
}): React.ReactElement {
  const {
    label,
    detail,
    actionLabel,
    onAction,
    actionDisabled,
    actionTitle,
    topPx = 0,
    zIndex = 2000,
    operationId,
  } = props;

  const op = useOperation(operationId);

  const isCountdown = op?.status === 'countdown';
  const isPaused = op?.countdownPaused ?? false;
  const secondsRemaining = op?.countdownSecondsRemaining;
  const totalSeconds = op?.countdownTotalSeconds;

  const countdownPct =
    isCountdown && totalSeconds != null && totalSeconds > 0 && secondsRemaining != null
      ? Math.round((secondsRemaining / totalSeconds) * 100)
      : undefined;

  const handlePauseResume = useCallback(() => {
    if (!operationId) return;
    if (isPaused) {
      operationRegistryService.resumeCountdown(operationId);
    } else {
      operationRegistryService.pauseCountdown(operationId);
    }
  }, [operationId, isPaused]);

  return (
    <div
      className="countdown-banner"
      style={{ top: topPx, zIndex }}
      role="status"
      aria-live="polite"
    >
      <div className="countdown-banner-content">
        <div className="countdown-banner-label">
          {label}
          {isCountdown && isPaused && (
            <span className="countdown-banner-paused-badge">paused</span>
          )}
        </div>
        {detail && <div className="countdown-banner-detail">{detail}</div>}
      </div>

      {isCountdown && secondsRemaining !== undefined && (
        <span className="countdown-banner-seconds">{secondsRemaining}s</span>
      )}

      <div className="countdown-banner-actions">
        {isCountdown && operationId && (
          <>
            <button
              type="button"
              className="countdown-banner-btn"
              onClick={handlePauseResume}
            >
              {isPaused ? 'Resume' : 'Pause'}
            </button>
            <span className="countdown-banner-sep">·</span>
          </>
        )}
        {actionLabel && onAction && (
          <button
            type="button"
            className={`countdown-banner-btn${!isCountdown ? ' primary' : ''}`}
            onClick={onAction}
            disabled={actionDisabled}
            title={actionTitle}
          >
            {actionLabel}
          </button>
        )}
      </div>

      {/* Countdown progress bar (amber, narrowing) */}
      {isCountdown && countdownPct !== undefined && (
        <div className="countdown-banner-bar-container">
          <div
            className={`countdown-banner-bar${isPaused ? ' paused' : ''}`}
            style={{ width: `${countdownPct}%` }}
          />
        </div>
      )}
    </div>
  );
}
