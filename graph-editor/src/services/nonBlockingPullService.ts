/**
 * Non-Blocking Pull Service
 *
 * Handles the "remote is ahead → countdown → auto-pull → outcome" flow
 * entirely through the operation registry and countdown service.
 *
 * The OperationsToast automatically picks up the operation and shows
 * countdown bar, pause/resume, cancel, and outcome.
 */

import { operationRegistryService } from './operationRegistryService';
import { countdownService } from './countdownService';
import { repositoryOperationsService } from './repositoryOperationsService';
import { sessionLogService } from './sessionLogService';
import { dispatchGitAuthExpired } from './gitService';

const AUTO_PULL_COUNTDOWN_SECONDS = 15;

export interface NonBlockingPullOptions {
  repository: string;
  branch: string;
  /** Countdown duration in seconds (default: 15). */
  countdownSeconds?: number;
  /** Remote SHA that triggered this pull (for audit). */
  remoteSha?: string;
  /** Called after pull completes successfully (e.g. to cascade to retrieve-all). */
  onComplete?: () => void;
  /** Called when user cancels the countdown (e.g. to dismiss the remote SHA). */
  onDismiss?: () => void;
  /** Called when pull completes with merge conflicts, passing the conflict data for modal display. */
  onConflicts?: (conflicts: any[]) => void;
}

/** Active pull state — prevents duplicate triggers. */
let activePullOpId: string | null = null;
let activeUnsubs: (() => void)[] = [];

function cleanup(): void {
  for (const unsub of activeUnsubs) unsub();
  activeUnsubs = [];
  activePullOpId = null;
}

/**
 * Start a non-blocking pull operation with a countdown veto window.
 *
 * - Registers a 'countdown' operation in the registry.
 * - Countdown ticks appear in the OperationsToast automatically.
 * - Supports pause/resume via the toast UI.
 * - On expiry: pulls using `pullLatest` (3-way merge; surfaces conflicts as warnings).
 * - On cancel: marks operation cancelled, calls onDismiss.
 *
 * Returns the operation ID, or undefined if a pull is already active.
 */
export function startNonBlockingPull(opts: NonBlockingPullOptions): string | undefined {
  // Prevent duplicate triggers.
  if (activePullOpId) {
    const existing = operationRegistryService.get(activePullOpId);
    if (existing && existing.status !== 'complete' && existing.status !== 'error' && existing.status !== 'cancelled') {
      return undefined;
    }
    cleanup();
  }

  const opId = `auto-pull:${opts.repository}:${opts.branch}`;
  const countdownKey = `op:${opId}`;
  const seconds = opts.countdownSeconds ?? AUTO_PULL_COUNTDOWN_SECONDS;
  let timerActive = false;

  activePullOpId = opId;

  // ---- Register operation ------------------------------------------------

  operationRegistryService.register({
    id: opId,
    kind: 'auto-pull',
    label: 'Pulling latest changes',
    status: 'countdown',
    cancellable: true,
    onCancel: () => {
      countdownService.cancelCountdown(countdownKey);
      operationRegistryService.complete(opId, 'cancelled');
      cleanup();
      opts.onDismiss?.();
    },
  });

  operationRegistryService.setCountdown(opId, seconds);

  // ---- Sync countdown ticks into the registry ----------------------------

  const tickUnsub = countdownService.subscribe(() => {
    const state = countdownService.getState(countdownKey);
    if (state?.isActive) {
      operationRegistryService.setCountdown(opId, state.secondsRemaining);
    }
  });
  activeUnsubs.push(tickUnsub);

  // ---- Handle pause / resume via registry subscription -------------------

  const pauseUnsub = operationRegistryService.subscribe(() => {
    const op = operationRegistryService.get(opId);
    if (!op || op.status !== 'countdown') return;

    if (op.countdownPaused && timerActive) {
      countdownService.cancelCountdown(countdownKey);
      timerActive = false;
    } else if (!op.countdownPaused && !timerActive) {
      const remaining = op.countdownSecondsRemaining;
      if (remaining != null && remaining > 0) {
        // Set flag BEFORE startCountdown — it emits synchronously, which
        // re-enters this handler. Without the flag we'd loop infinitely.
        timerActive = true;
        countdownService.startCountdown({
          key: countdownKey,
          durationSeconds: remaining,
          onExpire: () => executePull(opId, opts),
          audit: {
            operationType: 'session',
            startCode: 'AUTO_PULL_COUNTDOWN_RESUME',
            cancelCode: 'AUTO_PULL_COUNTDOWN_CANCEL',
            expireCode: 'AUTO_PULL_COUNTDOWN_EXPIRE',
            message: `Auto-pull countdown resumed: ${opts.repository}/${opts.branch}`,
            metadata: { repository: opts.repository, branch: opts.branch },
          },
        });
      }
    }
  });
  activeUnsubs.push(pauseUnsub);

  // ---- Start the countdown timer -----------------------------------------

  // Set flag BEFORE startCountdown — it emits synchronously, which
  // re-enters the pause/resume handler via the registry subscription.
  timerActive = true;
  countdownService.startCountdown({
    key: countdownKey,
    durationSeconds: seconds,
    onExpire: () => executePull(opId, opts),
    audit: {
      operationType: 'session',
      startCode: 'AUTO_PULL_COUNTDOWN_START',
      cancelCode: 'AUTO_PULL_COUNTDOWN_CANCEL',
      expireCode: 'AUTO_PULL_COUNTDOWN_EXPIRE',
      message: `Auto-pull countdown: ${opts.repository}/${opts.branch}`,
      metadata: { repository: opts.repository, branch: opts.branch, remoteSha: opts.remoteSha },
    },
  });

  return opId;
}

/** Cancel an active non-blocking pull (if any). */
export function cancelNonBlockingPull(): void {
  if (!activePullOpId) return;
  const countdownKey = `op:${activePullOpId}`;
  countdownService.cancelCountdown(countdownKey);
  const op = operationRegistryService.get(activePullOpId);
  if (op && op.status !== 'complete' && op.status !== 'error' && op.status !== 'cancelled') {
    operationRegistryService.complete(activePullOpId, 'cancelled');
  }
  cleanup();
}

/** Whether a non-blocking pull is currently active (countdown or running). */
export function isNonBlockingPullActive(): boolean {
  if (!activePullOpId) return false;
  const op = operationRegistryService.get(activePullOpId);
  return !!op && op.status !== 'complete' && op.status !== 'error' && op.status !== 'cancelled';
}

// ---------------------------------------------------------------------------
// Internal: execute the actual pull
// ---------------------------------------------------------------------------

async function executePull(opId: string, opts: NonBlockingPullOptions): Promise<void> {
  cleanup();

  operationRegistryService.setStatus(opId, 'running');
  operationRegistryService.setLabel(opId, 'Pulling latest changes…');

  try {
    // IMPORTANT: Use pullLatest (3-way merge) instead of pullLatestRemoteWins.
    // In an interactive session, the user may have dirty local files. Auto-resolving
    // as "remote wins" silently destroys their work. Instead, merge and surface
    // conflicts as a warning so the user can resolve at their convenience.
    const result = await repositoryOperationsService.pullLatest(
      opts.repository,
      opts.branch
    );

    const conflicts = result.conflicts || [];
    if (conflicts.length > 0) {
      const fileNames = conflicts.map((c: any) => c.fileName || c.fileId).join(', ');
      operationRegistryService.setLabel(opId, `Pull complete — ${conflicts.length} conflict${conflicts.length !== 1 ? 's' : ''} need resolution`);

      // Build action button for the toast — opens the conflict resolution modal.
      const action = opts.onConflicts
        ? { label: 'Resolve conflicts', onClick: () => opts.onConflicts!(conflicts) }
        : undefined;

      operationRegistryService.complete(
        opId,
        'error',
        `Merge conflicts in: ${fileNames}`,
        action,
      );

      // Also call the callback immediately so the modal opens without waiting for user click.
      opts.onConflicts?.(conflicts);

      sessionLogService.warning(
        'session',
        'AUTO_PULL_CONFLICTS_DETECTED',
        `Auto-pull completed with ${conflicts.length} unresolved conflict(s) — user action required`,
        fileNames,
        { repository: opts.repository, branch: opts.branch, conflictCount: conflicts.length, files: fileNames }
      );
    } else {
      operationRegistryService.setLabel(opId, 'Pull complete');
      operationRegistryService.complete(opId, 'complete');
    }

    // Only cascade (e.g. retrieve-all) when there are no unresolved conflicts.
    if (conflicts.length === 0) {
      opts.onComplete?.();
    }
  } catch (error) {
    if ((error as any)?.name === 'GitAuthError') {
      operationRegistryService.complete(
        opId,
        'error',
        'Authentication expired',
        { label: 'Sign in', onClick: () => dispatchGitAuthExpired() },
      );
      dispatchGitAuthExpired();

      sessionLogService.error(
        'session',
        'AUTO_PULL_AUTH_EXPIRED',
        'Auto-pull failed: authentication expired',
        undefined,
        { repository: opts.repository, branch: opts.branch }
      );
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    operationRegistryService.complete(opId, 'error', `Pull failed: ${message}`);

    sessionLogService.error(
      'session',
      'AUTO_PULL_FAILED',
      `Auto-pull failed: ${message}`,
      undefined,
      { repository: opts.repository, branch: opts.branch, error: message }
    );
  }
}
