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
  /** Banner spec (excluding id — the operation ID is used). */
  banner: Omit<BannerSpec, 'id'>;
  /** Called when the countdown reaches zero. Caller should transition the op to 'running'. */
  onExpire: () => void;
  /** If false / undefined the countdown is not started. Allows conditional activation. */
  enabled?: boolean;
}

/**
 * Wires countdownService + bannerManagerService + operationRegistryService together
 * for an operation that starts with a "this will happen unless you cancel" countdown.
 *
 * Supports pause/resume: when the registry's `countdownPaused` flag is set (e.g. by the
 * toast UI), this hook cancels the underlying timer and freezes the seconds. On resume,
 * it restarts the timer with the frozen duration.
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

  // Watch the operation for pause/resume changes.
  const op = useOperation(operationId);
  const isPaused = op?.countdownPaused ?? false;

  // Track whether the timer is currently running so we can pause/resume.
  const timerActiveRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const countdownKey = `op:${operationId}`;

    // Set the banner.
    bannerManagerService.setBanner({
      ...bannerRef.current,
      id: operationId,
    });

    // Start the countdown timer.
    countdownService.startCountdown({
      key: countdownKey,
      durationSeconds,
      onExpire: () => {
        timerActiveRef.current = false;
        bannerManagerService.clearBanner(operationId);
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

    // Sync countdown ticks into the registry.
    const unsubscribe = countdownService.subscribe(() => {
      const state = countdownService.getState(countdownKey);
      if (state?.isActive) {
        operationRegistryService.setCountdown(operationId, state.secondsRemaining);
      }
    });

    return () => {
      unsubscribe();
      countdownService.cancelCountdown(countdownKey);
      timerActiveRef.current = false;
      bannerManagerService.clearBanner(operationId);
    };
  }, [operationId, durationSeconds, enabled]);

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
            bannerManagerService.clearBanner(operationId);
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
  }, [isPaused, enabled, operationId, op?.status, op?.countdownSecondsRemaining]);
}
