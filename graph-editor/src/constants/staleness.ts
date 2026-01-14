/**
 * Staleness / safety nudge thresholds (time-based).
 *
 * Centralised here so all nudges and related UX use consistent timings.
 */
export const STALENESS_NUDGE_RELOAD_AFTER_MS = 12 * 60 * 60 * 1000; // 12h
export const STALENESS_NUDGE_RETRIEVE_ALL_SLICES_AFTER_MS = 24 * 60 * 60 * 1000; // 24h (cron handles daily retrieves)

/**
 * UI-only: "last done" recency thresholds used by the staleness update modal.
 * These are intentionally conservative and should not change behaviour (only colouring / display).
 */
export const STALENESS_NUDGE_GIT_PULL_LAST_DONE_RED_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * How often to check if remote is ahead of local (for git-pull nudge).
 * The actual nudge is triggered by SHA mismatch, not by time elapsed.
 * This just gates how frequently we make the network call to check remote HEAD.
 */
export const STALENESS_NUDGE_REMOTE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30m

/** User snooze duration for nudges. */
export const STALENESS_NUDGE_SNOOZE_MS = 60 * 60 * 1000; // 1h

/**
 * Visible-tab polling interval for unattended terminals.
 * We still gate on "due" checks so this does not cause repeated pulls.
 */
export const STALENESS_NUDGE_VISIBLE_POLL_MS = 5 * 60 * 1000; // 5m

/**
 * Guardrail: even if conditions persist, don't re-prompt immediately after a user action.
 * This is separate from snooze, and helps avoid spam if checks run on focus + visibility.
 */
export const STALENESS_NUDGE_MIN_REPEAT_MS = 10 * 60 * 1000; // 10m

/**
 * After a user chooses "Reload" plus other actions, we persist a pending plan to run
 * immediately after reload. This is a safety cap to avoid executing stale pending plans.
 */
export const STALENESS_PENDING_PLAN_MAX_AGE_MS = 30 * 60 * 1000; // 30m

/**
 * Default state for the "Automatic mode" toggle in the staleness update modal.
 * When enabled, DagNet will run the due update actions without prompting (except pull conflicts).
 */
export const STALENESS_AUTOMATIC_MODE_DEFAULT = false;

/**
 * Countdown timer before auto-executing git pull when remote is ahead.
 * User can dismiss/snooze to cancel, otherwise pull happens automatically.
 * This supports unattended clients (e.g. dashboard mode) picking up daily cron updates.
 */
export const STALENESS_NUDGE_COUNTDOWN_SECONDS = 30;


