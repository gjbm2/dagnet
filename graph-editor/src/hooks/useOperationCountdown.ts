import { useEffect, useRef } from 'react';
import { countdownService } from '../services/countdownService';
import { bannerManagerService, type BannerSpec } from '../services/bannerManagerService';
import { operationRegistryService } from '../services/operationRegistryService';
import { useOperation } from './useOperations';

export interface UseOperationCountdownOptions {
  /** Operation ID (must already be registered in the registry). */
  operationId: string;
  /** Countdown duration in seconds. */
  durationSeconds: number;
  /**
   * Optional banner spec (excluding id — the operation ID is used).
   * When provided, a CountdownBanner is shown via BannerHost for the
   * duration of the countdown (e.g. app-reload, retrieve-all commencement).
   * When omitted, the countdown appears only in the OperationsToast — the
   * standard behaviour for routine operations like auto-pull or auto-commit.
   */
  banner?: Omit<BannerSpec, 'id'>;
  /** Called when the countdown reaches zero. Caller should transition the op to 'running'. */
  onExpire: () => void;
  /** If false / undefined the countdown is not started. Allows conditional activation. */
  enabled?: boolean;
}

/**
 * Wires countdownService + operationRegistryService together for an operation
 * that starts with a "this will happen unless you cancel" countdown.
 *
 * The countdown always appears in the OperationsToast (bottom-centre progress
 * indicator) with pause/resume and cancel support. When a `banner` spec is
 * provided, a top-of-app CountdownBanner is also shown — reserve this for
 * high-visibility events like app reloads or retrieve-all commencement.
 *
 * Supports pause/resume: when the registry's `countdownPaused` flag is set
 * (e.g. by the toast UI), this hook cancels the underlying timer and freezes
 * the seconds. On resume, it restarts the timer with the frozen duration.
 *
 * Usage:
 *   1. Register the operation in the registry (status: 'countdown' or 'pending').
 *   2. Call this hook with the operation ID and config.
 *   3. On expiry, the hook calls your onExpire callback — you transition the op to 'running'.
 *   4. On unmount or when enabled becomes false, everything is cleaned up.
 */
export function useOperationCountdown(options: UseOperationCountdownOptions): void {
  const { operationId, durationSeconds, banner, onExpire, enabled = true } = options;

  // Stable refs so we don't restart the countdown when callbacks change identity.
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const bannerRef = useRef(banner);
  bannerRef.current = banner;

  const hasBanner = !!banner;

  // Watch the operation for pause/resume changes.
  const op = useOperation(operationId);
  const isPaused = op?.countdownPaused ?? false;

  // Track whether the timer is currently running so we can pause/resume.
  const timerActiveRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const countdownKey = `op:${operationId}`;

    // Set the banner (only when requested).
    if (bannerRef.current) {
      bannerManagerService.setBanner({
        ...bannerRef.current,
        id: operationId,
      });
    }

    // Sync countdown ticks into the registry.
    const unsubscribe = countdownService.subscribe(() => {
      const state = countdownService.getState(countdownKey);
      if (state?.isActive) {
        operationRegistryService.setCountdown(operationId, state.secondsRemaining);
      }
    });

    // Start the countdown timer.
    countdownService.startCountdown({
      key: countdownKey,
      durationSeconds,
      onExpire: () => {
        timerActiveRef.current = false;
        if (hasBanner) bannerManagerService.clearBanner(operationId);
        onExpireRef.current();
      },
      audit: {
        operationType: 'session',
        startCode: 'OP_COUNTDOWN_START',
        cancelCode: 'OP_COUNTDOWN_CANCEL',
        expireCode: 'OP_COUNTDOWN_EXPIRE',
        message: `Operation countdown: ${operationId}`,
        metadata: { operationId },
      },
    });
    timerActiveRef.current = true;

    return () => {
      unsubscribe();
      countdownService.cancelCountdown(countdownKey);
      timerActiveRef.current = false;
      if (hasBanner) bannerManagerService.clearBanner(operationId);
    };
  }, [operationId, durationSeconds, enabled, hasBanner]);

  // Handle pause/resume by stopping/restarting the countdownService timer.
  useEffect(() => {
    if (!enabled) return;

    const countdownKey = `op:${operationId}`;

    if (isPaused && timerActiveRef.current) {
      // Pause: cancel the timer. The registry already has the frozen secondsRemaining.
      countdownService.cancelCountdown(countdownKey);
      timerActiveRef.current = false;
    } else if (!isPaused && !timerActiveRef.current && op?.status === 'countdown') {
      // Resume: restart with the frozen seconds.
      const remaining = op.countdownSecondsRemaining;
      if (remaining != null && remaining > 0) {
        countdownService.startCountdown({
          key: countdownKey,
          durationSeconds: remaining,
          onExpire: () => {
            timerActiveRef.current = false;
            if (hasBanner) bannerManagerService.clearBanner(operationId);
            onExpireRef.current();
          },
          audit: {
            operationType: 'session',
            startCode: 'OP_COUNTDOWN_RESUME_TIMER',
            cancelCode: 'OP_COUNTDOWN_CANCEL',
            expireCode: 'OP_COUNTDOWN_EXPIRE',
            message: `Operation countdown resumed: ${operationId}`,
            metadata: { operationId },
          },
        });
        timerActiveRef.current = true;
      }
    }
  }, [isPaused, enabled, operationId, op?.status, op?.countdownSecondsRemaining, hasBanner]);
}
