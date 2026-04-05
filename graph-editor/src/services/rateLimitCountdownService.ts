/**
 * Rate Limit Countdown Service
 *
 * Non-React bridge that connects countdownService (timer) with
 * operationRegistryService (UI state) for rate-limit cooldown periods.
 *
 * Used by both:
 * - fetchDataService (manual fetches) — countdown + auto-resume
 * - retrieveAllSlicesService (automated fetches) — countdown + auto-resume
 *
 * Supports pause/resume via the registry's countdownPaused flag.
 */

import { countdownService } from './countdownService';
import { operationRegistryService } from './operationRegistryService';
import { sessionLogService } from './sessionLogService';

export interface RateLimitCountdownOptions {
  /** Cooldown duration in minutes. */
  cooldownMinutes: number;
  /** Polled every ~1s; return true to abort the countdown early. */
  shouldStop?: () => boolean;
  /** Session log parent operation ID for child entries. */
  logOpId?: string;
  /**
   * Existing operation ID to transition to 'countdown'.
   * If omitted, a new operation is registered.
   */
  operationId?: string;
  /** Label for the countdown operation (used when registering a new op). */
  label?: string;
}

export type RateLimitCountdownResult = 'expired' | 'aborted';

/**
 * Start a rate-limit cooldown countdown that is visible in the OperationsToast.
 *
 * - Registers (or transitions) an operation to 'countdown' status.
 * - Syncs countdownService ticks into operationRegistryService.
 * - Supports pause/resume via the registry's countdownPaused flag.
 * - Resolves 'expired' when the countdown reaches zero, 'aborted' if shouldStop() returns true.
 */
export function startRateLimitCountdown(
  options: RateLimitCountdownOptions,
): Promise<RateLimitCountdownResult> {
  const {
    cooldownMinutes,
    shouldStop,
    logOpId,
    operationId,
    label = `Rate limit cooldown (${cooldownMinutes}m)`,
  } = options;

  const totalSeconds = cooldownMinutes * 60;
  const countdownKey = `ratelimit:cooldown:${Date.now()}`;

  // Determine the registry operation ID — reuse existing or create new.
  const ownOp = !operationId;
  const opId = operationId ?? `rate-limit-cooldown:${Date.now()}`;

  // Register a new operation if no existing one was provided.
  if (ownOp) {
    operationRegistryService.register({
      id: opId,
      kind: 'rate-limit-cooldown',
      label,
      status: 'countdown',
      cancellable: true,
    });
  }

  // Session log
  if (logOpId) {
    sessionLogService.addChild(
      logOpId,
      'warning',
      'RATE_LIMIT_COOLDOWN_START',
      `Rate limit hit — waiting ${cooldownMinutes} minutes before resuming`,
      undefined,
      { cooldownMinutes, totalSeconds },
    );
  }

  return new Promise<RateLimitCountdownResult>((resolve) => {
    let resolved = false;
    let abortCheckInterval: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      if (abortCheckInterval !== undefined) {
        clearInterval(abortCheckInterval);
        abortCheckInterval = undefined;
      }
      unsubCountdown();
      unsubRegistry();
    };

    const finish = (result: RateLimitCountdownResult) => {
      if (resolved) return;
      resolved = true;
      cleanup();

      if (result === 'aborted') {
        countdownService.cancelCountdown(countdownKey);
      }

      // If we own the operation, complete it. Otherwise leave it for the caller.
      if (ownOp) {
        operationRegistryService.complete(
          opId,
          result === 'expired' ? 'complete' : 'cancelled',
          result === 'aborted' ? 'Rate limit cooldown aborted' : undefined,
        );
      }

      if (logOpId) {
        const code = result === 'expired'
          ? 'RATE_LIMIT_COOLDOWN_EXPIRED'
          : 'RATE_LIMIT_COOLDOWN_ABORTED';
        const msg = result === 'expired'
          ? 'Rate limit cooldown complete — resuming'
          : 'Rate limit cooldown aborted by user';
        sessionLogService.addChild(logOpId, 'info', code, msg);
      }

      resolve(result);
    };

    // Wire cancel button on owned operations.
    if (ownOp) {
      operationRegistryService.setCancellable(opId, () => finish('aborted'));
    }

    // --- Sync countdown ticks → registry ---
    const unsubCountdown = countdownService.subscribe(() => {
      if (resolved) return;
      const state = countdownService.getState(countdownKey);
      if (state?.isActive) {
        operationRegistryService.setCountdown(opId, state.secondsRemaining);
      }
    });

    // --- Watch registry for pause/resume ---
    let wasPaused = false;

    const unsubRegistry = operationRegistryService.subscribe(() => {
      if (resolved) return;
      const op = operationRegistryService.get(opId);
      if (!op) {
        // Operation was removed externally — treat as abort.
        finish('aborted');
        return;
      }

      const isPaused = op.countdownPaused ?? false;

      if (isPaused && !wasPaused) {
        // Pause: stop the timer. Registry already has frozen seconds.
        countdownService.cancelCountdown(countdownKey);
        wasPaused = true;
      } else if (!isPaused && wasPaused) {
        // Resume: restart timer with remaining seconds.
        const remaining = op.countdownSecondsRemaining;
        if (remaining != null && remaining > 0) {
          countdownService.startCountdown({
            key: countdownKey,
            durationSeconds: remaining,
            onExpire: () => finish('expired'),
            audit: {
              operationType: 'data-fetch',
              startCode: 'RATE_LIMIT_COOLDOWN_RESUME',
              cancelCode: 'RATE_LIMIT_COOLDOWN_CANCEL',
              expireCode: 'RATE_LIMIT_COOLDOWN_EXPIRE',
              message: `Rate limit cooldown resumed (${remaining}s remaining)`,
              metadata: { cooldownMinutes },
            },
          });
        } else {
          // Remaining was 0 or missing — expire immediately.
          finish('expired');
        }
        wasPaused = false;
      }
    });

    // --- Abort polling ---
    if (shouldStop) {
      abortCheckInterval = setInterval(() => {
        if (resolved) return;
        if (shouldStop()) {
          finish('aborted');
        }
      }, 1000);
    }

    // --- Start the countdown ---
    countdownService.startCountdown({
      key: countdownKey,
      durationSeconds: totalSeconds,
      onExpire: () => finish('expired'),
      audit: {
        operationType: 'data-fetch',
        startCode: 'RATE_LIMIT_COOLDOWN_START',
        cancelCode: 'RATE_LIMIT_COOLDOWN_CANCEL',
        expireCode: 'RATE_LIMIT_COOLDOWN_EXPIRE',
        message: `Rate limit cooldown (${cooldownMinutes} minutes)`,
        metadata: { cooldownMinutes },
      },
    });
  });
}
